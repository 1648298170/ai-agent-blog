// tools/idempotency.redis.ts —— 工具执行幂等层的 Redis 版：SET NX PX 抢锁 + 两阶段回写。
// 与 idempotency.ts（内存版）实现同一套幂等语义，存储口径换成 Redis——多实例 /
// 重启后共享同一个幂等窗口，正是内存版头注释预留的扩展位（「跨实例部署要共享
// 幂等窗口时，换 Redis SETNX + TTL 实现，接口不变」）。env 开关见 idempotency.factory.ts。
//
// ── Redis 侧的数据形状 ────────────────────────────────────────────────────
//   key    agent:idem:{scope}:{toolName}:{sha256(参数指纹)}
//          前缀与 agent:sess:{id} 同款命名口径；参数指纹沿用内存版的
//          stableStringify（算法唯一实现，键序无关），再过 sha256 定长化——
//          大参数（如转人工带整段 transcript）不撑爆 key，redis-cli 里仍能
//          按 scope 前缀排查（SCAN agent:idem:{scope}:*）
//   value  两阶段 JSON：
//          ① 抢锁那一瞬写入的占位      {"state":"running"}
//          ② 执行成功后覆写为最终结果  {"state":"done","result":<工具返回值>}
//   TTL    PX ttlMs（默认与内存版同款 10 分钟）。占位与结果共用同一窗口，
//          窗口从「首次调用」起算——成功回写用剩余时长而不是重置整个 TTL，
//          与内存版 expiresAt = 插入时刻 + ttl 是同一语义。
//
// ── 三条语义纪律的 Redis 落法（与内存版逐条对齐）─────────────────────────
//   1. 成功才缓存：execute 抛错 → 释放占位（重试 = 新尝试）；成功才覆写为
//      结果。释放与覆写都走 Lua「持有人一致才动手」——执行超过 TTL、锁已
//      易主的极端时序下，迟到的 DEL/SET 不碰他人的条目（与 session.redis.ts
//      的锁纪律同款：GET-then-DEL 两步之间锁易主会误删他人的锁）。
//   2. 在途共享：同进程同键并发 → 共享同一个 Promise（与内存版同款）；
//      跨进程在途（他人占位 state=running）→ 本实例不重复执行，返回结构化
//      降级值 IdempotencyDegraded（模型可见）。「至多执行一次」是底线，
//      拿不到首次结果是可接受的降级——降级好过干等，也好过重试造成重复写。
//   3. scope 隔离：key 里带 scope，不同会话的相同操作是两笔业务。
//
// ── 与内存版的语义差异（诚实清单）─────────────────────────────────────────
//   - 工具返回值必须可 JSON 化（内存版存对象引用，什么都能装）——本项目
//     工具返回的都是普通对象，无实际影响；
//   - 跨进程在途拿不到首次结果（降级值）——内存版在途共享拿得到；
//   - 执行时长超过 TTL 的操作会失去窗口保护（占位先过期、他人可再抢）：
//     TTL 必须 > 工具执行时长，写操作耗时接近窗口时调大 ttlMs；
//   - 占位持有者崩溃（没走到释放/回写）→ 窗口内后续调用一律降级，直到 TTL
//     到期自愈。「宁可降级、不可重复执行」：SETNX+TTL 用短暂不可用换写安全，
//     这是它作为分布式幂等原语的固有取舍。
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { loadEnv } from "../config.js";
import { getEngineLogger } from "../logger.js";
import { stableStringify } from "./idempotency.js";
import type { AgentToolSet } from "../types.js";

/** 幂等 key 前缀（与 agent:sess 同款命名口径）：agent:idem:{scope}:{tool}:{指纹} */
export const IDEMPOTENCY_KEY_PREFIX = "agent:idem";

/** 默认连接串：本仓 docker-compose.yml 的 redis（宿主机 6379 直通，与 session.redis.ts 同值） */
const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** 默认幂等窗口：与内存版同款 10 分钟（窗口内重放命中 / 在途互斥） */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 空闲多久后主动断开连接（毫秒）——与 session.redis.ts 同款取舍：
 *  ioredis 的开放连接会吊着事件循环不放（进程退不出去），空闲 3 秒断开、
 *  下条命令按需重连（本地重连 ~1ms 无感）；定时器 unref，不挡进程退出。 */
const IDLE_QUIT_MS = 3_000;

/** 成功回写（Lua 原子）：占位仍是自己的才覆写为结果。
 *  为什么要 Lua：执行超过 TTL 时占位已过期、可能已被他人重新占住——
 *  无条件 SET 会把别人的占位/结果盖掉（与「误删他人的锁」同族事故） */
const CACHE_IF_OWNER_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("set", KEYS[1], ARGV[2], "PX", ARGV[3])
else
  return false
end`;

/** 失败释放（Lua 原子）：占位仍是自己的才 DEL——与 session.redis.ts 的
 *  RELEASE_LOCK_LUA 同款纪律（GET-then-DEL 两步之间锁易主会误删他人的锁） */
const RELEASE_IF_OWNER_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/** Redis value 的两阶段形状：running=在途占位 / done=已完成（带首次结果） */
interface RedisIdemEntry {
  readonly state: "running" | "done";
  readonly result?: unknown;
}

/** 跨进程在途降级值：另一实例正在执行同键操作，本实例未重复执行。
 *  作为工具返回值原样回给模型（结构化、可读），模型据此告知用户
 *  「正在处理中」——与审批壳「拒绝回结构化拒绝值，模型可见」同一设计观 */
export interface IdempotencyDegraded {
  readonly idempotentDegraded: true;
  readonly message: string;
}

/** 类型守卫：run 的返回值是否为在途降级值（消费方据此分流日志 / 响应话术） */
export function isIdempotencyDegraded(value: unknown): value is IdempotencyDegraded {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { idempotentDegraded?: unknown }).idempotentDegraded === true
  );
}

const IN_FLIGHT_MESSAGE = "同参数的操作正在另一实例处理中，本次未重复执行；请稍后确认首次调用的结果";

export interface RedisIdempotencyRegistryOptions {
  /** 幂等窗口（毫秒），默认 10 分钟（与内存版同款）。必须大于工具执行时长——
   *  执行超过窗口的操作会失去幂等保护（占位先过期，他人可再抢） */
  ttlMs?: number;
  /** Redis 连接串（默认环境变量 REDIS_URL，再缺省用本地 compose 默认值） */
  url?: string;
}

/** 幂等 key：agent:idem:{scope}:{toolName}:{sha256(参数指纹)}。
 *  导出供测试与运维排查——key 格式是跨进程兼容契约的一部分。 */
export function redisIdempotencyKey(scope: string, toolName: string, args: unknown): string {
  const fingerprint = createHash("sha256").update(stableStringify(args)).digest("hex");
  return `${IDEMPOTENCY_KEY_PREFIX}:${scope}:${toolName}:${fingerprint}`;
}

/** 连接失败的统一提示：告诉用户怎么修，而不是甩一串英文堆栈（同 session.redis.ts） */
function connectionError(url: string, detail: string): Error {
  return new Error(
    `无法连接 Redis：${detail}。` +
      "请先在 agent-app 目录运行 pnpm infra:up（等 redis 服务 healthy），" +
      `或检查 REDIS_URL（当前值：${url}）。` +
      "不想用 Redis 时移除 IDEMPOTENCY_STORE=redis 即可回退内存版（离线默认）。",
  );
}

/** 错误转一句话（日志用，不丢信息也不刷屏） */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RedisIdempotencyRegistry {
  private readonly ttlMs: number;
  private readonly url: string;
  private client: Redis | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  /** 同进程在途表：key → 正在执行的 Promise（语义 2 的进程内落法，见 run） */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: RedisIdempotencyRegistryOptions = {}) {
    // 连接串解析与 session.redis.ts 同款优先级：注入 → REDIS_URL → 本地 compose 默认
    const env = loadEnv();
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.url = options.url ?? env.REDIS_URL ?? DEFAULT_REDIS_URL;
  }

  /**
   * 幂等执行（SET NX PX 抢锁语义）：
   * - 抢到锁 → 真执行；成功把占位覆写为结果（后续重放命中返回首次结果），
   *   失败释放占位后原样上抛（失败不缓存，重试 = 新尝试）；
   * - 没抢到（key 已存在）→ 已完成：直接返回首次结果（重放命中）；
   *   在途（他人执行中）：返回 IdempotencyDegraded 降级值，绝不重复执行。
   *
   * 返回类型比内存版多一个降级分支（T | IdempotencyDegraded），消费方用
   * isIdempotencyDegraded() 收窄——这是跨进程在途的诚实代价：进程内共享
   * Promise 拿得到结果，进程外只能「不重复 + 说明情况」。
   */
  run<T>(
    scope: string,
    toolName: string,
    args: unknown,
    execute: () => Promise<T>,
  ): Promise<T | IdempotencyDegraded> {
    const key = redisIdempotencyKey(scope, toolName, args);

    // 语义 2（在途共享）的进程内落法：同键并发第二人共享第一人的 Promise
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending as Promise<T | IdempotencyDegraded>;

    // attempt 已在跑（同步段一直走到第一个 await：SET NX）；此刻挂进在途表，
    // 同一事件循环里紧随其后的并发调用也能共享到这一次执行
    const attempt = this.acquireAndExecute(key, execute);
    this.inFlight.set(key, attempt);
    // 结算后离场，只删自己这条（防极端时序误删同键的新条目）——与内存版同款纪律
    void attempt.then(
      () => this.dropInFlight(key, attempt),
      () => this.dropInFlight(key, attempt),
    );
    return attempt;
  }

  /** 清空某个 scope 的全部幂等条目（会话销毁 / 「新会话」时调用，防陈旧跨会话命中）。
   *  SCAN+DEL 而非 KEYS：key 空间大时 KEYS 会卡住整个 Redis（session.redis 同款纪律）。
   *  注：异步签名是诚实的——跨进程清理本来就要一次网络往返，装不成同步。 */
  async clearScope(scope: string): Promise<void> {
    const pattern = `${IDEMPOTENCY_KEY_PREFIX}:${scope}:*`;
    let cursor = "0";
    do {
      const [next, keys] = await this.cmd((redis) => redis.scan(cursor, "MATCH", pattern, "COUNT", 100));
      cursor = next;
      if (keys.length > 0) await this.cmd((redis) => redis.del(...keys));
    } while (cursor !== "0");
  }

  /** 主动断开连接（测试结束 / 进程收尾时调用；未连接时是 no-op）。
   *  close 不清 Redis 里的幂等窗口——之后再次 run / clearScope 按需重连。
   *  除了 disconnect 还要弃引用：ioredis 的 status 翻到 "end" 是异步的
   *  （close 事件之后），只看 status 会在短暂窗口内复用僵尸连接。 */
  close(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.client?.disconnect();
    this.client = undefined;
  }

  /** 在途表自清理：只删自己注册的那条 */
  private dropInFlight(key: string, own: Promise<unknown>): void {
    if (this.inFlight.get(key) === own) this.inFlight.delete(key);
  }

  /** 抢锁 → 执行 → 回写/释放 的完整链（在途表注册由 run 负责） */
  private async acquireAndExecute<T>(
    key: string,
    execute: () => Promise<T>,
  ): Promise<T | IdempotencyDegraded> {
    // 占位串确定（单键 JSON，字面量稳定）——Lua 里「持有人比对」比的就是这个原串
    const placeholder = JSON.stringify({ state: "running" } satisfies RedisIdemEntry);
    const startedAt = Date.now();

    // 最多两轮：SETNX 落空但 GET 也读不到 = key 恰在两条命令之间过期——此刻
    // 已无人占用，重试抢锁而不是误降级（连两轮都碰上这种竞态属极端路径，降级兜底）
    for (let round = 0; round < 2; round++) {
      const acquired =
        (await this.cmd((redis) => redis.set(key, placeholder, "PX", this.ttlMs, "NX"))) === "OK";

      if (acquired) {
        let result: T;
        try {
          result = await execute();
        } catch (err) {
          // 语义 1（失败不缓存）：释放占位后原样上抛，重试是新尝试。
          // 释放失败只告警、不掩盖工具的原始错误——残留占位由 PX 兜底过期
          try {
            await this.cmd((redis) => redis.eval(RELEASE_IF_OWNER_LUA, 1, key, placeholder));
          } catch (releaseErr) {
            getEngineLogger().warn(
              `[idempotency] 失败后释放占位未成功（将由 TTL 兜底过期）：${errText(releaseErr)}`,
            );
          }
          throw err;
        }
        // 成功回写：占位仍是自己的才覆写（Lua），窗口沿用首次调用起算的剩余时长。
        // 回写失败不影响「已执行完」的事实——照常返回结果；重放方因占位仍在
        // 而降级（不重复执行），窗口过后自愈。执行超过 TTL（剩余 ≤ 0）则不回写：
        // 锁可能已易主，写了也守不住
        const remainingMs = this.ttlMs - (Date.now() - startedAt);
        if (remainingMs > 0) {
          const done = JSON.stringify({ state: "done", result } satisfies RedisIdemEntry);
          try {
            await this.cmd((redis) => redis.eval(CACHE_IF_OWNER_LUA, 1, key, placeholder, done, remainingMs));
          } catch (cacheErr) {
            getEngineLogger().warn(
              `[idempotency] 成功结果回写未成功（重放将降级，窗口后自愈）：${errText(cacheErr)}`,
            );
          }
        }
        return result;
      }

      // 没抢到：key 已存在——看它是「已完成（重放命中）」还是「在途（降级）」
      const raw = await this.cmd((redis) => redis.get(key));
      if (raw === null) continue; // 恰在 SETNX 与 GET 之间过期 → 重试抢锁

      let entry: RedisIdemEntry;
      try {
        entry = JSON.parse(raw) as RedisIdemEntry;
      } catch {
        // 脏数据不敢执行（可能是他人已完成但损坏的结果）——保守降级，宁可降级不重复
        getEngineLogger().warn(`[idempotency] 幂等条目值无法解析（保守降级不执行）：${raw.slice(0, 80)}`);
        return { idempotentDegraded: true, message: "幂等记录已存在但无法解析，为避免重复执行本次未执行" };
      }
      if (entry.state === "done") return entry.result as T; // 重放命中：首次结果
      return { idempotentDegraded: true, message: IN_FLIGHT_MESSAGE }; // 在途：降级
    }
    return { idempotentDegraded: true, message: IN_FLIGHT_MESSAGE };
  }

  /**
   * Redis 命令统一入口，做三件事：
   *   ① 每次现取连接——execute 耗时超过空闲断开窗口时，旧实例已 status "end"，
   *      必须重建（懒连接：不调 run/clearScope 就绝不起连接）；
   *   ② 连接类失败包成带修复指引的中文错误（同 session.redis.ts 的 connectionError）；
   *   ③ 每条命令后重置空闲断开定时器。
   */
  private async cmd<T>(op: (redis: Redis) => Promise<T>): Promise<T> {
    try {
      if (this.client === undefined || this.client.status === "end") {
        this.client = new Redis(this.url, { maxRetriesPerRequest: 1, connectTimeout: 5000 });
      }
      const result = await op(this.client);
      this.scheduleIdleQuit();
      return result;
    } catch (err) {
      throw connectionError(this.url, errText(err));
    }
  }

  /** 到点 disconnect，让进程能自然退出（与 session.redis.ts 同款，定时器 unref）。
   *  与 close() 同理：断开后立刻弃引用，防 status 异步翻转窗口内复用僵尸连接。 */
  private scheduleIdleQuit(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.client?.disconnect();
      this.client = undefined;
    }, IDLE_QUIT_MS);
    this.idleTimer.unref();
  }
}

/**
 * 工具表幂等壳（Redis 版）：给整套工具的 execute 套上 RedisIdempotencyRegistry.run，
 * 洋葱形状与内存版 wrapToolsWithIdempotency 完全一致（无 execute 的工具原样透传、
 * 与审批壳「幂等在内、审批在外」的叠加顺序同理）。独立成函数而不是放宽老签名——
 * 内存版公共接口是兼容红线，一行不动；两个 run 的返回类型本就不同，分开包壳最诚实。
 */
export function wrapToolsWithRedisIdempotency(
  tools: AgentToolSet,
  registry: RedisIdempotencyRegistry,
  options: { scope: string },
): AgentToolSet {
  const wrapped: AgentToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const original = tool.execute;
    if (original === undefined) {
      wrapped[name] = tool; // 无 execute 的调度方自执行工具：幂等层不适用，原样透传
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: (args: unknown, execOpts: unknown) =>
        registry.run(options.scope, name, args, () =>
          (original as (a: unknown, o: unknown) => Promise<unknown>)(args, execOpts),
        ),
    } as (typeof tools)[string];
  }
  return wrapped;
}
