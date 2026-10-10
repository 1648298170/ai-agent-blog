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
//
// ── append 的并发安全（生产缺陷修复：两层防线）─────────────────────────
// 旧实现「RPUSH →（超阈值时）LRANGE → compressIfNeeded（LLM 调用，秒级）
// → MULTI 重写」在两个并发 append 下会交错：后写者的 DEL+RPUSH 把先写者刚
// 重写的内容连同压缩期间新 RPUSH 进来的消息一起抹掉（与内存版同一个竞态，
// 时间线详见 session.memory.ts 头注释）。两层修法：
//   第一层（进程内）：每会话一条 Promise 链，append 整体排队串行——单进程
//     内不再交错；
//   第二层（跨进程）：压缩重写段再套一把 best-effort 分布式锁（SET NX PX +
//     Lua 持有人校验释放），两个 API 实例连同一个 Redis 时互斥。锁外命令
//     （RPUSH / ZADD / EXPIRE）都是单命令原子，消息永远先落袋为安。
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { loadEnv } from "../config.js";
import { getEngineLogger } from "../logger.js";
import { trace } from "../trace.js";
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

// ── 压缩重写的跨进程锁（第二层防线）────────────────────────────────────
// 为什么只锁「压缩重写」：RPUSH / ZADD / EXPIRE 是单命令原子，锁不锁都安全；
// 危险的只有「LRANGE 读全量 → LLM 压缩（秒级窗口）→ MULTI 整条重写」这段
// 读-改-写，两个进程同时做必然互相覆盖丢轮次。
//
// 锁纪律（为什么是这三个决定）：
// 1. SET key holder PX 30000 NX 拿锁：拿不到（他人持有）→ 本轮直接跳过压缩。
//    raw RPUSH 已在锁外发生且原子——消息不丢，压缩顺延到未来某次 append 补做
//    （at-least-once 安全 > exactly-once 复杂度：两个进程争用下可能都跳过一轮
//    压缩，list 暂时变长，绝不丢数据）。
// 2. PX 30000 兜底：持有者崩溃/卡死也最多 30 秒后自动过期，绝不死锁。
// 3. 释放必须「GET 比对持有人一致才 DEL」，且用 Lua 脚本原子化——否则
//    「GET-then-DEL」两步之间锁恰好过期、别人拿到新锁，迟到的 DEL 会误删
//    他人的锁（经典误删事故）。ioredis 惯用法是 EVAL 一段小脚本。
/** 压缩锁 key 前缀：agent:sess:lock:{sessionId}（与会话本体 key 区分开） */
export const SESSION_LOCK_PREFIX = "agent:sess:lock";

/** 锁 TTL（毫秒）：覆盖一次 LLM 压缩调用的正常时长，持有者崩溃后的自动解锁上限 */
export const SESSION_LOCK_TTL_MS = 30_000;

/** 释放锁的 Lua：GET 比对持有人一致才 DEL（原子，杜绝误删他人的锁） */
const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * 锁原语所需的最小 Redis 命令面：抽成结构接口，单测可注入假客户端
 * （不引新依赖、不连真实 Redis 就能验证锁语义）。
 */
export interface SessionLockClient {
  /** SET key value PX ttl NX：占锁成功回 "OK"，已被占回 null */
  setNxPx(key: string, value: string, ttlMs: number): Promise<string | null>;
  /** 原子比较删除（Lua）：持有人匹配返回 1（已删），不匹配返回 0（没动） */
  compareDel(key: string, value: string): Promise<number>;
}

/** 拿到锁后的句柄：release 只释放自己拿到的锁；未拿到锁时 release 是 no-op */
export interface SessionLock {
  acquired: boolean;
  release(): Promise<void>;
}

/**
 * 获取会话压缩锁（best-effort）：拿不到不等待、不重试，立刻返回 acquired=false
 * 让调用方本轮跳过压缩——锁的意义是「互斥」而不是「排队」。
 */
export async function acquireSessionLock(
  client: SessionLockClient,
  sessionId: string,
): Promise<SessionLock> {
  const holder = randomUUID(); // 持有人令牌：释放时的比对依据
  const key = `${SESSION_LOCK_PREFIX}:${sessionId}`;
  const acquired = (await client.setNxPx(key, holder, SESSION_LOCK_TTL_MS)) === "OK";
  return {
    acquired,
    release: async () => {
      if (!acquired) return; // 没拿到锁没什么可释放的
      await client.compareDel(key, holder);
    },
  };
}

/** 把 ioredis 客户端适配成锁原语的最小命令面（SET NX PX + EVAL Lua） */
function lockClientOf(redis: Redis): SessionLockClient {
  return {
    setNxPx: (key, value, ttlMs) => redis.set(key, value, "PX", ttlMs, "NX"),
    compareDel: async (key, value) => Number(await redis.eval(RELEASE_LOCK_LUA, 1, key, value)),
  };
}

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

  // 第一层防线（进程内）：每会话一条 Promise 链，append 整体排队串行。
  // 语义与 session.memory.ts 完全同款（含「失败不毒化链」与「链尾自清理」），
  // 详细论证见彼处注释——这里只补 Redis 侧特有的一句：串行化后同一进程内的
  // 压缩重写不再互相交错，跨进程交给第二层锁。
  const appendChains = new Map<string, Promise<void>>();

  /** 串行化后的真正 append：RPUSH/ZADD/EXPIRE 锁外直行，压缩重写段套跨进程锁 */
  async function doAppend(sessionId: string, turn: ChatTurn): Promise<void> {
    const redis = getClient();
    const k = key(sessionId);
    try {
      // 锁外：单命令原子，消息先落袋为安（客户端断开/锁争用都不影响这三步）
      await redis.rpush(k, JSON.stringify(turn));
      // 会话索引记账：score=最后活跃时间（listSessions 按它降序，两段路径都要走到）
      await redis.zadd(SESSION_INDEX_KEY, Date.now(), sessionId);

      // 压缩阀门：先看长度，未超阈值只续期 TTL（一次 O(1) 的 LLEN，别每次都拉全量）
      const length = await redis.llen(k);
      if (length > COMPRESS_AFTER) {
        // 第二层防线（跨进程）：压缩重写是「读-改-写」，必须互斥。
        const lock = await acquireSessionLock(lockClientOf(redis), sessionId);
        if (!lock.acquired) {
          // 拿不到锁 = 另一个进程正在压这条会话：本轮跳过压缩（RPUSH 已经落了，
          // 消息安全），只做 TTL 续期，压缩顺延到未来某次 append。刻意不等待
          // 不重试——等锁会把 append 延迟到秒级，跳过只让 list 暂时变长。
          trace("🧠", `会话 ${sessionId} 超过 ${COMPRESS_AFTER} 条：压缩锁被其他进程持有，本轮跳过压缩（消息已落盘，压缩顺延）`);
        } else {
          try {
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
          } finally {
            // 释放锁：Lua「持有人一致才 DEL」。即使上面抛错也照常释放（finally），
            // 残留的锁最多活 TTL 30s，不会死锁后续 append。
            await lock.release();
          }
        }
      }
      // 未压缩路径（含锁争用跳过）：'EX' 续期（教程 Day 1 的 TTL 写法：每次保存都续）
      await redis.expire(k, SESSION_TTL_SECONDS);
      scheduleIdleQuit();
    } catch (err) {
      throw connectionError(url, err instanceof Error ? err.message : String(err));
    }
  }

  /** list 元素 → ChatTurn：单条脏数据（解析失败）跳过而不是炸整窗，检索不被脏数据炸掉 */
  function parseTurns(raw: string[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    for (const item of raw) {
      try {
        turns.push(JSON.parse(item) as ChatTurn);
      } catch {
        // 与内存版「脏数据防线」同一思想：坏一行跳一行（warn 留痕，方便发现数据损坏）
        getEngineLogger().warn(`[memory] 会话数据脏行已跳过：${item.slice(0, 80)}`);
      }
    }
    return turns;
  }

  return {
    /** 追加一轮：先挂到该会话的串行链上（并发安全见 doAppend 上方两层防线注释），
     *  链语义与内存版同款：失败不毒化链（tail 咽错误）、链尾自清理防 Map 无界增长 */
    async append(sessionId: string, turn: ChatTurn): Promise<void> {
      const prev = appendChains.get(sessionId) ?? Promise.resolve();
      const next = prev.then(() => doAppend(sessionId, turn));
      const tail = next.catch(() => {});
      appendChains.set(sessionId, tail);
      void tail.then(() => {
        if (appendChains.get(sessionId) === tail) {
          appendChains.delete(sessionId);
        }
      });
      return next;
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
