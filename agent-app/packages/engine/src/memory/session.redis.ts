// session.redis.ts —— 短期记忆（会话窗口）的 Redis 实现（教程 week11《记忆 TS 版》+ week17 实战）
// 与 session.memory.ts 实现同一个 SessionStore 契约（types.ts 一行未改）。
//
// ── Redis 侧的数据形状（教程同款 key 设计）─────────────────────────────
//   key    agent:sess:{sessionId}   ← 教程《记忆 TS 版》同款前缀
//   value  Redis list，每个元素是一条 ChatTurn 的 JSON 串（RPUSH 追加，天然有序）
//   TTL    24 小时（SESSION_TTL 秒），每次 append 都 EXPIRE 续期——
//          「活跃会话永不过期、一天不活跃自动清场」，这正是内存版给不了的阀门，
//          也是教程里 'EX' 续期那道 TTL 的落地。
//
// ── 压缩算法零复制 ─────────────────────────────────────────────────────
// 超过 40 条压滚动摘要的算法在 memory/compression.ts（唯一实现），与内存版共用：
// append 后若超阈值，LRANGE 读全量 → compressIfNeeded → MULTI 原子重写整条 list。
//
// ── 多实例共享 ─────────────────────────────────────────────────────────
// 内存版「重启就没、多实例不共享」在这里消失：CLI 与 HTTP API 两个进程
// 连同一个 Redis，会话窗口跨进程可见——这是 SESSION_STORE=redis 的核心收益。
import { Redis } from "ioredis";
import { loadEnv } from "../config.js";
import { COMPRESS_AFTER, compressIfNeeded, defaultSummarizer } from "./compression.js";
import type { SessionStoreOptions, Summarizer } from "./compression.js";
import type { ChatTurn, SessionStore, SessionSummary } from "./types.js";

/** 会话 key 前缀（教程《记忆 TS 版》同款）：agent:sess:{sessionId} */
export const SESSION_KEY_PREFIX = "agent:sess";

/** 会话索引 key：ZSET，member=sessionId，score=最后活跃的 Date.now()。
 *  会话本体有 24h TTL，索引没有——过期会话变成「死成员」，
 *  listSessions 遇到时顺手 ZREM 清场（懒清理，不给每次 append 加成本）。 */
export const SESSION_INDEX_KEY = "agent:sess:index";

/** 会话 TTL：24 小时（秒）。每次 append 续期——活跃会话不落，一天不动自动清场 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** 空闲多久后主动断开连接（毫秒）。
 * ioredis 的开放连接会让事件循环吊着不放（CLI REPL 结束后进程退不出去，也没有 unref 可用），
 * 所以空闲 3 秒后 disconnect、下次命令时按需重连——本地重连 ~1ms，REPL 与服务器都无感。
 * 定时器 unref：它自己绝不成为进程退出的拦路虎。 */
const IDLE_QUIT_MS = 3_000;

/** 默认连接串：本仓 docker-compose.yml 的 redis（宿主机 6379 直通） */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** 构造参数：连接串可注入（默认读 REDIS_URL），summarize 可注入假实现供离线自检 */
export interface RedisSessionStoreOptions extends SessionStoreOptions {
  /** Redis 连接串（默认环境变量 REDIS_URL，再缺省用本地 compose 默认值） */
  url?: string;
}

/** 连接失败的统一提示：告诉用户怎么修，而不是甩一串英文堆栈（同 embedder.ts 的 configError） */
function connectionError(url: string, detail: string): Error {
  return new Error(
    `无法连接 Redis：${detail}。` +
      "请先在 agent-app 目录运行 pnpm infra:up（等 redis 服务 healthy），" +
      `或检查 REDIS_URL（当前值：${url}）。` +
      "不想用 Redis 时移除 SESSION_STORE=redis 即可回退内存版（离线默认）。",
  );
}

/**
 * 创建 Redis 版会话存储。
 * ioredis 客户端懒创建单例：不配 redis 就绝不起连接（离线默认内存库零感知）。
 */
export function createRedisSessionStore(options: RedisSessionStoreOptions = {}): SessionStore {
  const env = loadEnv();
  const url = options.url ?? env.REDIS_URL ?? DEFAULT_REDIS_URL;
  const summarize: Summarizer = options.summarize ?? defaultSummarizer;

  let client: Redis | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  function getClient(): Redis {
    // 空闲断开（status "end"）后按需重建；quick fail 交给 catch 包装
    if (client === undefined || client.status === "end") {
      client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
    }
    return client;
  }

  /** 每次命令后重置空闲定时器：到点 disconnect，让 CLI 进程能自然退出 */
  function scheduleIdleQuit(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      client?.disconnect();
    }, IDLE_QUIT_MS);
    idleTimer.unref(); // 定时器本身不阻塞进程退出
  }

  function key(sessionId: string): string {
    return `${SESSION_KEY_PREFIX}:${sessionId}`;
  }

  /** list 元素 → ChatTurn：单条脏数据（解析失败）跳过而不是炸整窗，检索不被脏数据炸掉 */
  function parseTurns(raw: string[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    for (const item of raw) {
      try {
        turns.push(JSON.parse(item) as ChatTurn);
      } catch {
        // 与内存版「脏数据防线」同一思想：坏一行跳一行（warn 留痕，方便发现数据损坏）
        console.warn(`[memory] 会话数据脏行已跳过：${item.slice(0, 80)}`);
      }
    }
    return turns;
  }

  return {
    /** 追加一轮：RPUSH + 索引 ZADD + EXPIRE 续期；超过 40 条时读全量 → 共享压缩算法 → MULTI 原子重写 */
    async append(sessionId: string, turn: ChatTurn): Promise<void> {
      const redis = getClient();
      const k = key(sessionId);
      try {
        await redis.rpush(k, JSON.stringify(turn));
        // 会话索引记账：score=最后活跃时间（listSessions 按它降序，两段路径都要走到）
        await redis.zadd(SESSION_INDEX_KEY, Date.now(), sessionId);

        // 压缩阀门：先看长度，未超阈值只续期 TTL（一次 O(1) 的 LLEN，别每次都拉全量）
        const length = await redis.llen(k);
        if (length > COMPRESS_AFTER) {
          // 超了：LRANGE 全量 → compressIfNeeded（阈值/滚动/降级全在共享模块）→ 原子重写
          const turns = parseTurns(await redis.lrange(k, 0, -1));
          const compressed = await compressIfNeeded(sessionId, turns, summarize);
          if (compressed !== turns) {
            const multi = redis.multi();
            multi.del(k);
            if (compressed.length > 0) multi.rpush(k, ...compressed.map((t) => JSON.stringify(t)));
            multi.expire(k, SESSION_TTL_SECONDS);
            await multi.exec();
            scheduleIdleQuit();
            return;
          }
        }
        // 未压缩路径：'EX' 续期（教程 Day 1 的 TTL 写法：每次保存都续）
        await redis.expire(k, SESSION_TTL_SECONDS);
        scheduleIdleQuit();
      } catch (err) {
        throw connectionError(url, err instanceof Error ? err.message : String(err));
      }
    },

    /** 取最近 limit 轮（默认 20）：LRANGE 负下标从尾部圈窗口（截断阀门同内存版） */
    async getWindow(sessionId: string, limit = 20): Promise<ChatTurn[]> {
      const safeLimit = Math.max(0, limit);
      if (safeLimit === 0) return [];
      const redis = getClient();
      try {
        // -limit 下标从后往前数；list 不够长时负下标自动钳到 0，语义同 slice(-limit)
        const raw = await redis.lrange(key(sessionId), -safeLimit, -1);
        scheduleIdleQuit();
        return parseTurns(raw);
      } catch (err) {
        throw connectionError(url, err instanceof Error ? err.message : String(err));
      }
    },

    /** 清空会话：DEL 整条 list + 索引 ZREM（/new 开新会话时旧窗口连索引一起消失） */
    async clear(sessionId: string): Promise<void> {
      const redis = getClient();
      try {
        await redis.del(key(sessionId));
        await redis.zrem(SESSION_INDEX_KEY, sessionId);
        scheduleIdleQuit();
      } catch (err) {
        throw connectionError(url, err instanceof Error ? err.message : String(err));
      }
    },

    /** 历史会话清单：ZREVRANGE 索引（按最后活跃降序）→ 逐个核对本体；
     *  本体已过期的「死成员」顺手 ZREM 清场并跳过（懒清理）。 */
    async listSessions(): Promise<SessionSummary[]> {
      const redis = getClient();
      try {
        // WITHSCORES 返回 [member, score, member, score, ...]；score = 最后活跃的 epoch ms
        const raw = await redis.zrevrange(SESSION_INDEX_KEY, 0, -1, "WITHSCORES");
        const entries: Array<{ sessionId: string; score: number }> = [];
        for (let i = 0; i + 1 < raw.length; i += 2) {
          entries.push({ sessionId: String(raw[i]), score: Number(raw[i + 1]) });
        }

        // 逐成员核对：EXISTS 本体 + LLEN 轮数（Promise.all 保序，输出仍按活跃降序）
        const checked = await Promise.all(
          entries.map(async (entry) => {
            const exists = await redis.exists(key(entry.sessionId));
            if (exists === 0) return { ...entry, dead: true, turns: 0 };
            return { ...entry, dead: false, turns: await redis.llen(key(entry.sessionId)) };
          }),
        );

        const dead = checked.filter((item) => item.dead).map((item) => item.sessionId);
        if (dead.length > 0) await redis.zrem(SESSION_INDEX_KEY, ...dead);

        scheduleIdleQuit();
        return checked
          .filter((item) => !item.dead)
          .map((item) => ({
            sessionId: item.sessionId,
            turns: item.turns,
            updatedAt: new Date(item.score).toISOString(),
          }));
      } catch (err) {
        throw connectionError(url, err instanceof Error ? err.message : String(err));
      }
    },

    /** 全量轮次（压缩后含摘要轮，如实返回）：LRANGE 0 -1，脏行跳过（warn 留痕） */
    async getHistory(sessionId: string): Promise<ChatTurn[]> {
      const redis = getClient();
      try {
        const raw = await redis.lrange(key(sessionId), 0, -1);
        scheduleIdleQuit();
        return parseTurns(raw);
      } catch (err) {
        throw connectionError(url, err instanceof Error ? err.message : String(err));
      }
    },
  };
}
