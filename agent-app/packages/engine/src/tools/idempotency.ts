// tools/idempotency.ts —— 工具执行幂等层：同 scope + 同工具 + 同参数 的重复调用
// 在 TTL 窗口内只真正执行一次，重放直接返回首次结果。
//
// 为什么要有它：LLM 的工具调用不受客户端事务控制——模型重试、用户重复提问、
// 上游超时后的补偿重发，都会让「创建工单」这类写操作被执行多次。业界标准做法
// 是客户端显式幂等键（Stripe 的 Idempotency-Key 头）；Agent 场景里模型不会可靠地
// 生成键，所以本实现退一档用「参数指纹」：scope + toolName + 规范化参数哈希。
// 同会话里同参数的重放 → 命中缓存；换个参数（内容真变了）→ 新键正常执行。
//
// 语义纪律（三条，缺一不可）：
// - 成功才缓存：execute 抛错的调用不进缓存——失败后的重试是合理的新尝试，
//   把失败也缓存住会把这个尝试堵死；
// - 在途共享：同键并发调用共享同一个 Promise（第二个调用者等第一个的执行结果，
//   而不是各执行各的）；
// - scope 隔离：键里带 scope（通常是 sessionId）——不同会话提交相同内容的工单
//   是两笔业务，不能互相去重。
//
// 存储口径：进程内存 Map（与审批登记簿同一取舍——重启即清，等价于「缓存窗口
// 过期」）。跨实例部署要共享幂等窗口时，换 Redis SETNX + TTL 实现，接口不变。
import type { AgentToolSet } from "../types.js";

/** 缓存条目：统一存 Promise（已完成的结果包成 resolved Promise），取用方一律 await */
interface Entry {
  readonly promise: Promise<unknown>;
  readonly expiresAt: number;
}

export interface IdempotencyRegistryOptions {
  /** 缓存窗口（毫秒），默认 10 分钟——窗口内重放命中，窗口后同参重放会真执行 */
  ttlMs?: number;
  /** 单例全局条目上限，超限按插入序淘汰最早条目（防长跑进程内存泄漏） */
  maxEntries?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

/** 规范化序列化：对象键排序后 JSON 化——{a:1,b:2} 与 {b:2,a:1} 必须同指纹 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined) // undefined 字段不参与指纹（zod optional 缺省的两种形态等价）
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export class IdempotencyRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: IdempotencyRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * 幂等执行：命中未过期的同键条目 → 直接返回其 Promise（重放不执行）；
   * 未命中 → 真执行并写入缓存；执行抛错 → 移除缓存条目后原样上抛（失败不缓存）。
   */
  run<T>(scope: string, toolName: string, args: unknown, execute: () => Promise<T>): Promise<T> {
    const key = `${scope}::${toolName}::${stableStringify(args)}`;
    const now = Date.now();

    const hit = this.entries.get(key);
    if (hit !== undefined) {
      if (hit.expiresAt > now) return hit.promise as Promise<T>;
      this.entries.delete(key); // 过期条目惰性清理
    }

    // 在途共享的关键：缓存里存的是「包装后的 Promise」——失败时自删，
    // 但删除动作挂在 promise 链上而不是 catch 吞错，reject 照常传给所有等待者
    const promise = execute().then(
      (result) => result,
      (err: unknown) => {
        const current = this.entries.get(key);
        // 只删自己这条（避免极端时序下误删同键的新条目）
        if (current !== undefined && current.promise === promise) this.entries.delete(key);
        throw err;
      },
    );
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs });

    if (this.entries.size > this.maxEntries) {
      // Map 迭代序 = 插入序：淘汰最早的（可能包含已过期但未被读到的条目，顺带回收）
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return promise;
  }

  /** 清空某个 scope 的全部条目（会话销毁 / 「新会话」时调用，防陈旧跨会话命中） */
  clearScope(scope: string): void {
    const prefix = `${scope}::`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  /** 当前条目数（测试与运维观测用） */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * 工具表幂等壳：给整套工具的 execute 套上 registry.run。参数指纹键 =
 * scope + 工具名 + 规范化入参，模型与业务代码零感知（返回值与原工具一致）。
 *
 * 用法（API 层请求时包壳，scope 用 sessionId）：
 *   const tools = wrapToolsWithIdempotency(baseTools, registry, { scope: sessionId });
 *
 * 零变化默认：不调用本函数 = 无幂等层，工具行为与原来逐字节一致。
 * 与审批壳的叠加顺序：先套幂等、再套审批（审批通过后才进入幂等判定）——
 * 「被用户拒绝的调用」不该污染幂等缓存。
 */
export function wrapToolsWithIdempotency(
  tools: AgentToolSet,
  registry: IdempotencyRegistry,
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
