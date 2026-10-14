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
// ── halfvec 半精度（2026-10，销 BACKLOG #4）────────────────────────────
// 列类型用 halfvec(dim)（pgvector ≥0.7 的半精度向量，每维 2 字节）而不是 vector(dim)：
// - vector 类型的 HNSW/IVFFlat 索引硬上限 2000 维，而本项目默认 EMBEDDING_DIM=2048
//   （GLM embedding-3）——超限时 ANN 索引建不出来，检索退化为全表顺序扫描（BACKLOG #4）；
// - halfvec 的 HNSW 上限 4000 维，2048 维默认即走 HNSW；
// - 代价：存储与距离计算是 float16 半精度——score 有第 3 位小数级的漂移（ANN 本身
//   就是近似，可接受），返回给调用方的 embedding 数组同为半精度数值；
// - 旧库迁移：ensureSchema 检测列类型是 vector 时自动 ALTER TYPE ... USING ::halfvec
//   （数据原地转换，不需要全库重嵌；旧 HNSW 索引随 ALTER 自动删除后按新算子重建）。
//
// ── 连接与建表 ────────────────────────────────────────────────────────
// postgres.js（v3）单一懒连接客户端；ensureSchema() 幂等建表建索引
// （CREATE IF NOT EXISTS + 旧列类型自动迁移），首次调用时跑一次，之后所有方法复用同一个 ready Promise。
// 连不上时抛带修复指引的中文错误（错误礼仪同 embedder.ts：告诉用户怎么修，不甩英文堆栈）。
import postgres from "postgres";
import { loadEnv } from "../config.js";
import type {
  Chunk,
  DocumentContent,
  DocumentSummary,
  RagFilter,
  RagStore,
  RetrievedChunk,
} from "./types.js";

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

/** 从环境变量读向量维度：必须是 1~4000 的整数（halfvec 半精度向量类型上限），否则中文报错 */
export function embeddingDimFromEnv(env: Record<string, string> = loadEnv()): number {
  const raw = env.EMBEDDING_DIM ?? "2048";
  const dim = Number.parseInt(raw, 10);
  if (!Number.isInteger(dim) || dim <= 0 || dim > 4000) {
    throw new Error(
      `EMBEDDING_DIM 配置非法：「${raw}」必须是 1~4000 的整数（halfvec 半精度向量类型上限）。` +
        "注意：维度在建表时固定，换 embedding 模型需要 DROP TABLE kb_chunks 后全库重嵌。" +
        "超过 4000 维的模型（如 1536 维以上大维度模型）请换用支持全精度大维度的专用向量库。",
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
 *             text text, embedding halfvec(dim))
 *   + 普通索引 kb_chunks_doc_id_idx（deleteDoc / docId 过滤走它）
 *   + HNSW 索引 kb_chunks_embedding_hnsw（embedding halfvec_cosine_ops，余弦检索走它；
 *     halfvec 上限 4000 维，2048 维默认即走 HNSW）
 */
export function createPgVectorRagStore(options: PgVectorRagStoreOptions = {}): RagStore {
  const env = loadEnv();
  const connectionString =
    options.connectionString ?? env.PG_CONNECTION_STRING ?? DEFAULT_PG_CONNECTION_STRING;
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

  /** 幂等建表建索引 + 旧表列类型迁移：所有方法首次调用前跑一次（ready ??= 懒加载门道） */
  function ensureSchema(): Promise<void> {
    const sql = getClient();
    const run = (async () => {
      try {
        await sql`CREATE EXTENSION IF NOT EXISTS vector`;
        // 建表用 unsafe + 字面量拼接：halfvec(维度) 是 DDL 类型修饰，不能参数化；
        // dim 已在 embeddingDimFromEnv 校验为 1~4000 的纯整数，无注入面
        await sql.unsafe(`CREATE TABLE IF NOT EXISTS kb_chunks (
            id        text PRIMARY KEY,
            doc_id    text NOT NULL,
            title     text NOT NULL,
            idx       integer NOT NULL,
            text      text NOT NULL,
            embedding halfvec(${dim})
          )`);
        // 旧表迁移（vector → halfvec，销 BACKLOG #4 的根源）：历史版本的列是
        // vector 类型（HNSW 上限 2000 维，2048 默认建不出索引）。ALTER TYPE ...
        // USING 原地转换，数据保留不需要重嵌；依赖该列的旧 HNSW 索引会被 PG
        // 随 ALTER 自动删除，下一步按 halfvec 算子重建。
        const col = await sql<{ udtName: string }[]>`
          SELECT udt_name AS "udtName"
          FROM information_schema.columns
          WHERE table_name = 'kb_chunks' AND column_name = 'embedding'`;
        if (col[0]?.udtName === "vector") {
          await sql.unsafe(
            `ALTER TABLE kb_chunks ALTER COLUMN embedding TYPE halfvec(${dim}) USING embedding::halfvec(${dim})`,
          );
        }
        await sql`CREATE INDEX IF NOT EXISTS kb_chunks_doc_id_idx ON kb_chunks (doc_id)`;
        // HNSW 近似最近邻（教程 week14 Day 5/6）：不精确但近似最快，十万块以上仍毫秒级；
        // 空表建索引也合法，随数据增长增量维护。
        // halfvec 的 HNSW 上限 4000 维——dim 已在校验层保证 ≤4000，2048 默认全绿，
        // 不再有「超限跳过索引退化为顺序扫描」的分支（BACKLOG #4 已销）。
        await sql`
          CREATE INDEX IF NOT EXISTS kb_chunks_embedding_hnsw
          ON kb_chunks USING hnsw (embedding halfvec_cosine_ops)`;
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
            // embedding 为 null（未向量化的块）存 NULL 列；否则 '[1,2,…]' 文本参数显式转 halfvec
            const embeddingValue =
              chunk.embedding === null
                ? tx`${null}::halfvec`
                : tx`${JSON.stringify(chunk.embedding)}::halfvec`;
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
     * 读整篇文档：doc_id 圈定 + ORDER BY idx 还原阅读顺序，应用层空行拼接。
     * 空结果 = 文档不存在，抛与内存版同文案的中文错误（两个实现一张脸，换库不换错误礼仪）。
     */
    async readDoc(docId: string): Promise<DocumentContent> {
      await ensureReady();
      const sql = getClient();
      try {
        const rows = await sql<{ title: string; idx: number; text: string }[]>`
          SELECT title, idx, text
          FROM kb_chunks
          WHERE doc_id = ${docId}
          ORDER BY idx`;
        if (rows.length === 0) {
          throw new Error(
            `文档不存在：${docId}。请先入库对应文档（pnpm kb:ingest <文件>），` +
              "或用 listDocs 查看当前知识库里实际有哪些文档。",
          );
        }
        return {
          docId,
          title: rows[0].title, // 块的 title 同文档恒定（listDocs 同款假设），取首行即可
          chunks: rows.length,
          text: rows.map((row) => row.text).join("\n\n"),
        };
      } catch (err) {
        // 上面主动抛的「文档不存在」不是连接问题，原样上抛（包成 connectionError 反而误导排障）
        if (err instanceof Error && err.message.startsWith("文档不存在")) throw err;
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /**
     * 余弦检索 top-k：ORDER BY embedding <=> $1（余弦距离，越小越近），score = 1 - distance。
     * NULL embedding 行（未向量化的块）不参与检索（WHERE embedding IS NOT NULL，
     * 与内存版跳过 embedding === null 的块同一语义）；docId 过滤先圈候选集再排序。
     */
    async search(queryEmbedding: number[], k: number, filter?: RagFilter): Promise<RetrievedChunk[]> {
      await ensureReady();
      const sql = getClient();
      const vec = JSON.stringify(queryEmbedding);
      const limit = Math.max(0, k); // k 夹到 ≥0，与内存版一致（负数当 0 处理）
      if (limit === 0) return [];
      try {
        const rows = await sql<KbRow[]>`
          SELECT id, doc_id AS "docId", title, idx, text, embedding,
                 1 - (embedding <=> ${vec}::halfvec) AS score
          FROM kb_chunks
          WHERE embedding IS NOT NULL
            ${filter?.docId !== undefined ? sql`AND doc_id = ${filter.docId}` : sql``}
          ORDER BY embedding <=> ${vec}::halfvec
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
