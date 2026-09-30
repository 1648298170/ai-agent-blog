// episodic.pgvector.ts —— 情景记忆（历史会话摘要）的 PostgreSQL+pgvector 实现
// 与 episodic.memory.ts 实现同一个 EpisodicStore 契约（types.ts 一行未改），
// 是 memory/README.md 扩展路线表的最后一行落地——至此三层记忆六个实现全部就位：
// session(memory|redis) / preference(memory|pg) / episodic(memory|pgvector)。
//
// ── 数据形状：episodic_memories 长表 ─────────────────────────────────────
//   episodic_memories(seq bigserial PK, session_id text, summary text,
//                     embedding vector(dim), created_at timestamptz)
//   remember = INSERT（追加式归档，同内存版 push）
//   recall   = ORDER BY embedding <=> $1（余弦距离）取 top-k，score = 1 - distance
//
// ── 与内存版的对照（数学相同，引擎不同）────────────────────────────────
//   内存版：cosineSimilarity() 手算 + 全库扫 + sort（同分按入库顺序稳定）
//   本文件：embedding <=> $1::vector 交给 pgvector（HNSW 近似最近邻，≤2000 维时），
//           外层再按 score DESC, seq 排——保住「同分按入库先后」的稳定语义
//
// ── 为什么 remember 不做 upsert ────────────────────────────────────────
//   契约（EpisodicRecord）没有 id：内存版是 push 追加，同一 sessionId 可以
//   多次归档（会话中途存档一次、结束再存档一次都是合法情景）。本文件如实
//   镜像：纯 INSERT 追加，永不覆盖；createdAt 非法时兜底当前时间（同内存版）。
//
// 维度铁律 / 懒连接单例 / HNSW ≤2000 维限制：与 rag/store.pgvector.ts 同一套
// 模式的两处实例化（连接参数、错误礼仪逐字对齐，详见那边的完整注释）。
import postgres from "postgres";
import { loadEnv } from "../config.js";
import { DEFAULT_PG_CONNECTION_STRING, embeddingDimFromEnv } from "../rag/store.pgvector.js";
import type { EpisodicRecord, EpisodicStore } from "./types.js";

/** 构造参数：连接串与向量维度均可注入（默认读环境变量），测试与定制各取所需 */
export interface PgVectorEpisodicStoreOptions {
  /** PostgreSQL 连接串（默认环境变量 PG_CONNECTION_STRING，再缺省用本地 compose 默认值） */
  connectionString?: string;
  /** 向量维度（默认环境变量 EMBEDDING_DIM，再缺省 2048 = GLM embedding-3） */
  dim?: number;
}

/** 连接失败的统一提示：错误礼仪同 preference.pg.ts（告诉用户怎么修，不甩英文堆栈） */
function connectionError(connectionString: string, detail: string): Error {
  return new Error(
    `无法连接 PostgreSQL（情景记忆）：${detail}。` +
      "请先在 agent-app 目录运行 pnpm infra:up（等 postgres 服务 healthy），" +
      `或检查 PG_CONNECTION_STRING（当前值：${connectionString}）。` +
      "不想用 pgvector 时移除 EPISODIC_STORE=pgvector 即可回退内存版（离线默认）。",
  );
}

/** createdAt 规范化：非法或空的日期串兜底成当前时间的 ISO 串（同内存版 toIsoDate，防调用方传脏数据） */
function toIsoDate(raw: string): string {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * 创建 pgvector 版情景记忆存储。
 * 表结构（ensureSchema 幂等创建）：
 *   episodic_memories(seq bigserial PRIMARY KEY, session_id text, summary text,
 *                     embedding vector(dim), created_at timestamptz)
 *   + HNSW 索引 episodic_memories_embedding_hnsw（embedding vector_cosine_ops，
 *     余弦检索走它；仅当 dim ≤ 2000 创建——pgvector 的 ANN 索引硬上限）
 * seq（bigserial）即入库顺序：recall 并列分数时按它稳定排序，
 * 对齐内存版「同分按入库先后」的可复现语义。
 */
export function createPgVectorEpisodicStore(
  options: PgVectorEpisodicStoreOptions = {},
): EpisodicStore {
  const env = loadEnv();
  const connectionString = options.connectionString ?? env.PG_CONNECTION_STRING ?? DEFAULT_PG_CONNECTION_STRING;
  const dim = options.dim ?? embeddingDimFromEnv(env);

  let client: ReturnType<typeof postgres> | undefined;
  let ready: Promise<void> | undefined;

  function getClient(): ReturnType<typeof postgres> {
    // 懒创建单例：不配 pgvector 就绝不起连接（离线默认内存库零感知）。
    // onnotice 吞掉 NOTICE（幂等建表每次都发 "already exists, skipping"，是噪音不是错误）
    client ??= postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 5, // 秒：快速失败，别让 REPL 卡在等一个不存在的库
      onnotice: () => {},
    });
    return client;
  }

  /** 幂等建表建索引：所有方法首次调用前跑一次（ready ??= 同 rag/store.pgvector.ts 的懒加载门道） */
  function ensureSchema(): Promise<void> {
    const sql = getClient();
    const run = (async () => {
      try {
        await sql`CREATE EXTENSION IF NOT EXISTS vector`;
        // 建表用 unsafe + 字面量拼接：vector(维度) 是 DDL 类型修饰，不能参数化；
        // dim 已在 embeddingDimFromEnv 校验为 1~16000 的纯整数，无注入面
        await sql.unsafe(`CREATE TABLE IF NOT EXISTS episodic_memories (
            seq        bigserial PRIMARY KEY,
            session_id text NOT NULL,
            summary    text NOT NULL,
            embedding  vector(${dim}) NOT NULL,
            created_at timestamptz NOT NULL
          )`);
        // HNSW 近似最近邻（教程 week14 Day 5/6）：不精确但近似最快，万级历史摘要仍毫秒级；
        // 空表建索引也合法，随数据增长增量维护。
        // pgvector 硬限制：HNSW / IVFFlat 索引都只支持 ≤2000 维，而本项目默认
        // EMBEDDING_DIM=2048（GLM embedding-3）——超限时跳过 ANN 索引，检索退化为
        // 精确顺序扫描（ORDER BY embedding <=> $1 语法不变）。教程规模（几百~几千条）
        // 顺序扫描本身毫秒级，与内存暴力扫同量级，无功能损失；未来把维度降到 ≤2000
        // （如换 1536/1024 维模型）后重跑 ensureSchema 即自动补上索引。
        if (dim <= 2000) {
          await sql`
            CREATE INDEX IF NOT EXISTS episodic_memories_embedding_hnsw
            ON episodic_memories USING hnsw (embedding vector_cosine_ops)`;
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
    /** 归档一条情景：追加式 INSERT（契约无 id，同 sessionId 可多次归档，与内存版 push 同语义） */
    async remember(record: EpisodicRecord): Promise<void> {
      await ensureReady();
      const sql = getClient();
      const createdAt = toIsoDate(record.createdAt);
      try {
        // '[1,2,…]' 文本参数显式转 vector（同 rag/store.pgvector.ts 的 upsert 写法）
        await sql`
          INSERT INTO episodic_memories (session_id, summary, embedding, created_at)
          VALUES (${record.sessionId}, ${record.summary}, ${JSON.stringify(record.embedding)}::vector,
                  ${createdAt}::timestamptz)`;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /**
     * 余弦检索 top-k（默认 k=3，同内存版教程 top3）。内层 ORDER BY embedding <=> $1
     * 是 pgvector 检索的标准姿势（HNSW 索引只认它）；外层再按 score DESC + seq 排——
     * 保住内存版「同分按入库先后稳定排序」的语义，且不破坏内层的 ANN 加速
     * （外层只重排 LIMIT 出来的 k 行）。
     */
    async recall(
      embedding: number[],
      k = 3,
    ): Promise<{ sessionId: string; summary: string; score: number }[]> {
      await ensureReady();
      const limit = Math.max(0, k); // k 夹到 ≥0，同内存版（负数当 0 处理）
      if (limit === 0) return [];
      const sql = getClient();
      const vec = JSON.stringify(embedding);
      try {
        const rows = await sql<{ sessionId: string; summary: string; score: number }[]>`
          SELECT "sessionId", summary, score FROM (
            SELECT session_id AS "sessionId", summary, seq,
                   1 - (embedding <=> ${vec}::vector) AS score
            FROM episodic_memories
            ORDER BY embedding <=> ${vec}::vector
            LIMIT ${limit}
          ) top
          ORDER BY score DESC, seq ASC`;
        return rows.map(({ sessionId, summary, score }) => ({ sessionId, summary, score }));
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
