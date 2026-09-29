// preference.pg.ts —— 长期记忆（用户偏好）的 PostgreSQL 实现（教程 week11《记忆 TS 版》PG 长表落地）
// 与 preference.memory.ts 实现同一个 PreferenceStore 契约（types.ts 一行未改）。
//
// ── 数据形状：user_preferences 长表（教程同款 DDL）──────────────────────
//   user_preferences(user_id text, key text, value text, PRIMARY KEY (user_id, key))
//   「用户改口」= 同 (user_id, key) 再 set 一次 → INSERT ... ON CONFLICT DO UPDATE（行级 upsert）
//
// ── 与内存版的差别只有一件事：数据活在 PG 里 ────────────────────────────
// 进程重启不丢、多实例共享、可审计可备份；护栏（trim / 限长 / 空值丢弃）
// 与内存版逐条对齐——换存储不换业务规则。
//
// （EpisodicStore 的 pgvector 版不在本次范围：见 memory/README.md 扩展路线表，列为后续。）
import postgres from "postgres";
import { loadEnv } from "../config.js";
import { DEFAULT_PG_CONNECTION_STRING } from "../rag/store.pgvector.js";
import type { PreferenceStore } from "./types.js";

/** 偏好条目的长度上限：与内存版逐字对齐（正常抽取结果远短于此，超长多半是脏数据） */
const MAX_KEY_LEN = 50;
const MAX_VALUE_LEN = 500;

/** 构造参数：连接串可注入（默认读 PG_CONNECTION_STRING，测试与定制各取所需） */
export interface PgPreferenceStoreOptions {
  /** PostgreSQL 连接串（默认环境变量 PG_CONNECTION_STRING，再缺省用本地 compose 默认值） */
  connectionString?: string;
}

/** 连接失败的统一提示：错误礼仪同 embedder.ts */
function connectionError(connectionString: string, detail: string): Error {
  return new Error(
    `无法连接 PostgreSQL（偏好长表）：${detail}。` +
      "请先在 agent-app 目录运行 pnpm infra:up（等 postgres 服务 healthy），" +
      `或检查 PG_CONNECTION_STRING（当前值：${connectionString}）。` +
      "不想用 PG 时移除 PREFERENCE_STORE=pg 即可回退内存版（离线默认）。",
  );
}

/** 创建 PostgreSQL 版偏好存储：ensureSchema 幂等建表，懒连接单例 */
export function createPgPreferenceStore(options: PgPreferenceStoreOptions = {}): PreferenceStore {
  const env = loadEnv();
  const connectionString = options.connectionString ?? env.PG_CONNECTION_STRING ?? DEFAULT_PG_CONNECTION_STRING;

  let client: ReturnType<typeof postgres> | undefined;
  let ready: Promise<void> | undefined;

  function getClient(): ReturnType<typeof postgres> {
    // 懒创建单例：不配 pg 就绝不起连接（离线默认内存库零感知）；onnotice 吞掉幂等建表的 NOTICE 噪音
    client ??= postgres(connectionString, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 5,
      onnotice: () => {},
    });
    return client;
  }

  function ensureSchema(): Promise<void> {
    const sql = getClient();
    const run = (async () => {
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS user_preferences (
            user_id text NOT NULL,
            key     text NOT NULL,
            value   text NOT NULL,
            PRIMARY KEY (user_id, key)
          )`;
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
    async get(userId: string, key: string): Promise<string | null> {
      await ensureReady();
      const sql = getClient();
      try {
        const rows = await sql<{ value: string }[]>`
          SELECT value FROM user_preferences WHERE user_id = ${userId} AND key = ${key}`;
        return rows[0]?.value ?? null;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    /** 护栏三连（同内存版）：trim → 截断 → 空值丢弃；然后行级 upsert（改口即覆盖） */
    async set(userId: string, key: string, value: string): Promise<void> {
      const safeKey = key.trim().slice(0, MAX_KEY_LEN);
      const safeValue = value.trim().slice(0, MAX_VALUE_LEN);
      if (!safeKey || !safeValue) return; // 空 key / 空白值不入库，写入即垃圾
      await ensureReady();
      const sql = getClient();
      try {
        await sql`
          INSERT INTO user_preferences (user_id, key, value)
          VALUES (${userId}, ${safeKey}, ${safeValue})
          ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },

    async all(userId: string): Promise<Record<string, string>> {
      await ensureReady();
      const sql = getClient();
      try {
        const rows = await sql<{ key: string; value: string }[]>`
          SELECT key, value FROM user_preferences WHERE user_id = ${userId}`;
        const result: Record<string, string> = {};
        for (const row of rows) result[row.key] = row.value;
        return result;
      } catch (err) {
        throw connectionError(connectionString, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
