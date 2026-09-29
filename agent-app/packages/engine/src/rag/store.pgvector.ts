// store.pgvector.ts —— pgvector 版 RAG 存储：PostgreSQL + 向量余弦检索（教程 week14 主线落地）
// 与 store.memory.ts 实现同一个 RagStore 契约（types.ts 一行未改）， retrieve.ts 一行 setRagStore 就能换上。
//
// ── 与内存版的对照（数学相同，引擎不同）────────────────────────────────
//   内存版：cosineSimilarity() 手算 + 全库暴力扫 + sort 取前 k
//   本文件：embedding <=> $1（pgvector 余弦距离，值越小越近）交给 PG 的
//           HNSW 近似最近邻索引，score = 1 - distance（与内存版同口径的相似度）
//   SELECT ... 1 - (embedding <=> $1::vector) AS score
//   ORDER BY embedding <=> $1::vector LIMIT k      ← 教程 week14 Day 6 同款 SQL
//
// ── 维度铁律 ──────────────────────────────────────────────────────────
// 向量列维度在建表时固定（EMBEDDING_DIM，默认 2048 = GLM embedding-3 的维度）。
// 换 embedding 模型（维度变化）必须先 DROP TABLE kb_chunks 再重建全库重嵌：
// 不同维度的向量没法比夹角，这与「查询与入库必须同一模型」是同一条铁律。
//
// ── 连接与建表 ────────────────────────────────────────────────────────
// postgres.js（v3）单一懒连接客户端；ensureSchema() 幂等建表建索引
// （CREATE IF NOT EXISTS），首次调用时跑一次，之后所有方法复用同一个 ready Promise。
// 连不上时抛带修复指引的中文错误（错误礼仪同 embedder.ts：告诉用户怎么修，不甩英文堆栈）。
import postgres from "postgres";
import { loadEnv } from "../config.js";
import type { Chunk, DocumentSummary, RagFilter, RagStore, RetrievedChunk } from "./types.js";

/** 默认连接串：本仓 docker-compose.yml 的 postgres（宿主机 5433 → 容器 5432，见 compose 注释） */
export const DEFAULT_PG_CONNECTION_STRING = "postgres://agent:agent@localhost:5433/agent";

/** 构造参数：连接串与向量维度均可注入（默认读环境变量），测试与定制各取所需 */
export interface PgVectorRagStoreOptions {
  /** PostgreSQL 连接串（默认环境变量 PG_CONNECTION_STRING，再缺省用本地 compose 默认值） */
  connectionString?: string;
  /** 向量维度（默认环境变量 EMBEDDING_DIM，再缺省 2048 = GLM embedding-3） */
  dim?: number;
}

/** 查询行形状：pgvector 的 embedding 以 '[1,2,3]' 文本回来，score 已由 SQL 算好 */
type KbRow = {
  id: string;
  docId: string;
  title: string;
  idx: number;
  text: string;
  embedding: string;
  score: number;
};

/** 从环境变量读向量维度：必须是 1~16000 的整数（pgvector vector 类型上限），否则中文报错 */
export function embeddingDimFromEnv(env: Record<string, string> = loadEnv()): number {
  const raw = env.EMBEDDING_DIM ?? "2048";
  const dim = Number.parseInt(raw, 10);
  if (!Number.isInteger(dim) || dim <= 0 || dim > 16000) {
  throw new Error(
    `EMBEDDING_DIM 配置非法：「${raw}」必须是 1~16000 的整数（pgvector 向量维度上限）。` +
      "注意：维度在建表时固定，换 embedding 模型需要 DROP TABLE kb_chunks 后全库重嵌；" +
      "另 pgvector 的 ANN 索引（HNSW/IVFFlat）只支持 ≤2000 维，超过时检索走精确顺序扫描。",
  );
  }
  return dim;
}

/** 连接失败的统一提示：告诉用户怎么修，而不是甩一串英文堆栈（同 embedder.ts 的 configError） */
function connectionError(connectionString: string, detail: string): Error {
  return new Error(
    `无法连接 PostgreSQL（pgvector）：${detail}。` +
      "请先在 agent-app 目录运行 pnpm infra:up（等 postgres 服务 healthy），" +
      `或检查 PG_CONNECTION_STRING（当前值：${connectionString}）。` +
      "本仓默认连接串对应 docker-compose.yml 的映射：宿主机 5433 → 容器 5432。",
  );
}

/** '[0.1,0.2]' 文本 → number[]（pgvector 的输出格式是合法 JSON 数组字面量） */
function parseVector(raw: string): number[] {
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.map(Number) : [];
}

/**
 * 创建 pgvector 版 RAG 存储。
 * 表结构（ensureSchema 幂等创建）：
 *   kb_chunks(id text PRIMARY KEY, doc_id text, title text, idx integer,
 *             text text, embedding vector(dim))
 *   + 普通索引 kb_chunks_doc_id_idx（deleteDoc / docId 过滤走它）
 *   + HNSW 索引 kb_chunks_embedding_hnsw（embedding vector_cosine_ops，余弦检索走它；
 *     仅当 dim ≤ 2000 创建——pgvector 的 ANN 索引硬上限，2048 维默认走精确顺序扫描）
 */
export function createPgVectorRagStore(options: PgVectorRagStoreOptions = {}): RagStore {
  const env = loadEnv();
  const connectionString = options.connectionString ?? env.PG_CONNECTION_STRING ?? DEFAULT_PG_CONNECTION_STRING;
  const dim = options.dim ?? embeddingDimFromEnv(env);

  let client: ReturnType<typeof postgres> | undefined;
  let ready: Promise<void> | undefined;

  function getClient(): ReturnType<typeof postgres> {
    // 懒创建单例：不配 pgvector 就绝不起连接（离线默认 json 库零感知）。
    // onnotice 吞掉 NOTICE（幂等建表每次都发 "already exists, skipping"，是噪音不是错误）
    client ??= postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 5, // 秒：快速失败，别让 REPL 卡在等一个不存在的库
      onnotice: () => {},
    });
    return client;
  }

  /** 幂等建表建索引：所有方法首次调用前跑一次（ready ??= 同 persistence.ts 的懒加载门道） */
  function ensureSchema(): Promise<void> {
    const sql = getClient();
    const run = (async () => {
      try {
        await sql`CREATE EXTENSION IF NOT EXISTS vector`;
        // 建表用 unsafe + 字面量拼接：vector(维度) 是 DDL 类型修饰，不能参数化；
        // dim 已在 embeddingDimFromEnv 校验为 1~16000 的纯整数，无注入面
        await sql.unsafe(`CREATE TABLE IF NOT EXISTS kb_chunks (
            id        text PRIMARY KEY,
            doc_id    text NOT NULL,
            title     text NOT NULL,
            idx       integer NOT NULL,
            text      text NOT NULL,
            embedding vector(${dim})
          )`);
        await sql`CREATE INDEX IF NOT EXISTS kb_chunks_doc_id_idx ON kb_chunks (doc_id)`;
        // HNSW 近似最近邻（教程 week14 Day 5/6）：不精确但近似最快，十万块以上仍毫秒级；
        // 空表建索引也合法，随数据增长增量维护。
        // pgvector 硬限制：HNSW / IVFFlat 索引都只支持 ≤2000 维，而本项目默认
        // EMBEDDING_DIM=2048（GLM embedding-3）——超限时跳过 ANN 索引，检索退化为
        // 精确顺序扫描（ORDER BY embedding <=> $1 语法不变）。教程规模（几百~几千块）
        // 顺序扫描本身毫秒级，与内存暴力扫同量级，无功能损失；未来把维度降到 ≤2000
        // （如换 1536/1024 维模型）后重跑 ensureSchema 即自动补上索引。
        if (dim <= 2000) {
          await sql`
            CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw
            ON kb_chunks USING hnsw (embedding vector_cosine_ops)`;
        }
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    })();
    return run;
  }

  function ensureReady(): Promise<void> {
    ready ??= ensureSchema();
    return ready;
  }

  return {
    /** 批量 upsert：整批一个事务，逐条 ON CONFLICT (id) DO UPDATE（同 id 再入库 = 更新，不翻倍） */
    async upsert(list: Chunk[]): Promise<void> {
      await ensureReady();
      const sql = getClient();
      try {
        await sql.begin(async (tx) => {
          for (const chunk of list) {
            // embedding 为 null（未向量化的块）存 NULL 列；否则 '[1,2,…]' 文本参数显式转 vector
            const embeddingValue =
              chunk.embedding === null ? tx`${null}::vector` : tx`${JSON.stringify(chunk.embedding)}::vector`;
            await tx`
              INSERT INTO kb_chunks (id, doc_id, title, idx, text, embedding)
              VALUES (${chunk.id}, ${chunk.docId}, ${chunk.title}, ${chunk.index}, ${chunk.text},
                      ${embeddingValue})
              ON CONFLICT (id) DO UPDATE SET
                doc_id = EXCLUDED.doc_id,
                title  = EXCLUDED.title,
                idx    = EXCLUDED.idx,
                text   = EXCLUDED.text,
                embedding = EXCLUDED.embedding`;
          }
        });
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /** 下架整篇文档：同一 docId 的所有切块一并清掉，最怕新旧两版同时在库 */
    async deleteDoc(docId: string): Promise<void> {
      await ensureReady();
      const sql = getClient();
      try {
        await sql`DELETE FROM kb_chunks WHERE doc_id = ${docId}`;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /** 文档级清单：GROUP BY 聚合（管理页列表数据源），按 docId 稳定排序 */
    async listDocs(): Promise<DocumentSummary[]> {
      await ensureReady();
      const sql = getClient();
      try {
        const rows = await sql<{ docId: string; title: string; chunks: number }[]>`
          SELECT doc_id AS "docId", title, count(*)::int AS chunks
          FROM kb_chunks
          GROUP BY doc_id, title
          ORDER BY doc_id`;
        return rows;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /**
     * 余弦检索 top-k：ORDER BY embedding <=> $1（余弦距离，越小越近），score = 1 - distance。
     * NULL embedding 行（未向量化的块）不参与检索（WHERE embedding IS NOT NULL，
     * 与内存版跳过 embedding === null 的块同一语义）；docId 过滤先圈候选集再排序。
     */
    async search(
      queryEmbedding: number[],
      k: number,
      filter?: RagFilter,
    ): Promise<RetrievedChunk[]> {
      await ensureReady();
      const sql = getClient();
      const vec = JSON.stringify(queryEmbedding);
      const limit = Math.max(0, k); // k 夹到 ≥0，与内存版一致（负数当 0 处理）
      if (limit === 0) return [];
      try {
        const rows = await sql<KbRow[]>`
          SELECT id, doc_id AS "docId", title, idx, text, embedding,
                 1 - (embedding <=> ${vec}::vector) AS score
          FROM kb_chunks
          WHERE embedding IS NOT NULL
            ${filter?.docId !== undefined ? sql`AND doc_id = ${filter.docId}` : sql``}
          ORDER BY embedding <=> ${vec}::vector
          LIMIT ${limit}`;
        return rows.map((row) => ({
          id: row.id,
          docId: row.docId,
          title: row.title,
          text: row.text,
          index: row.idx,
          embedding: parseVector(row.embedding),
          score: row.score,
        }));
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /** 库里现在有多少块（含未向量的块，与内存版 count 语义一致） */
    async count(): Promise<number> {
      await ensureReady();
      const sql = getClient();
      try {
        const rows = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM kb_chunks`;
        return rows[0]?.total ?? 0;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
