// infra.idempotency-redis.spec.ts —— 幂等层 Redis 实现（SET NX PX 抢锁）的集成测试
// 门控：环境变量 RUN_INFRA_TESTS=1 才尝试连接（pnpm test:infra 自动设置）；
// 服务不可达 → describe.skip 并打印原因，绝不炸普通 pnpm test / CI。
// 覆盖：首调抢锁执行 + 两阶段回写的 Redis 形状、重放命中、失败不缓存（占位已释放）、
// 同进程在途共享、跨实例重放命中 / 跨实例在途降级、TTL（PX）窗口与剩余窗口口径、
// scope 隔离 + clearScope 定向清理、close 后懒重连、wrap 壳。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { tool } from "ai";
import { z } from "zod";
import type { AgentToolSet } from "../src/types.js";
import {
  IDEMPOTENCY_KEY_PREFIX,
  RedisIdempotencyRegistry,
  isIdempotencyDegraded,
  redisIdempotencyKey,
  wrapToolsWithRedisIdempotency,
} from "../src/tools/idempotency.redis.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// —— 门控与可达性探测（top-level await：跑测试前先弄清 Redis 在不在）——
const gated = process.env.RUN_INFRA_TESTS === "1";
let reachable = false;
let probeError = "";
if (gated) {
  try {
    const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
    await probe.connect();
    await probe.ping();
    probe.disconnect();
    reachable = true;
  } catch (err) {
    reachable = false;
    probeError = err instanceof Error ? err.message : String(err);
  }
}

const describeRedis = gated && reachable ? describe : describe.skip;
if (gated && !reachable) {
  console.warn(
    `[infra.idempotency-redis] Redis 不可达（${REDIS_URL}）：${probeError}\n` +
      "  跳过幂等层 Redis 集成测试。请先在 agent-app 目录运行 pnpm infra:up 等 redis healthy，再跑 pnpm test:infra。",
  );
}
if (!gated) {
  console.warn(
    "[infra.idempotency-redis] 未设置 RUN_INFRA_TESTS=1，跳过（普通 pnpm test 不碰真实基础设施）。",
  );
}

// 本轮测试专用 scope 前缀：afterAll 一把清掉，不残留 agent:idem:spec-idem-* 键
const RUN = Date.now().toString(36);
const scopeOf = (name: string) => `spec-idem-${RUN}-${name}`;
const admin = reachable ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1 }) : null;

/** 计数工具（与离线版 spec 同思路）：每次真执行 +1，断言只看执行次数 */
function countingExecute() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: async (args: unknown) => {
      calls += 1;
      return { calls, echo: args };
    },
  };
}

describeRedis("幂等层 Redis 实现（真实 Redis，SET NX PX）", () => {
  beforeAll(async () => {
    // 兜底清掉历史残留的同前缀键
    if (admin !== null) {
      const stale = await admin.keys(`${IDEMPOTENCY_KEY_PREFIX}:spec-idem-*`);
      if (stale.length > 0) await admin.del(...stale);
    }
  });

  afterAll(async () => {
    if (admin !== null) {
      const stale = await admin.keys(`${IDEMPOTENCY_KEY_PREFIX}:spec-idem-*`);
      if (stale.length > 0) await admin.del(...stale);
      admin.disconnect();
    }
  });

  it("首调抢锁真执行并回写结果；同参重放命中返回首次结果（两阶段 JSON 形状）", async () => {
    const counter = countingExecute();
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const scope = scopeOf("replay");
    const args = { subject: "退款", description: "7 天未发货" };

    const first = await registry.run(scope, "createTicket", args, () => counter.run(args));
    const replay = await registry.run(scope, "createTicket", args, () => counter.run(args));

    expect(counter.calls).toBe(1); // 真执行只有一次
    expect(replay).toEqual(first); // 重放拿到首次结果

    // Redis 侧形状：key 带前缀（可按 scope SCAN 排查），value 已进入第二阶段 done
    if (admin === null) throw new Error("admin 客户端不可用");
    const key = redisIdempotencyKey(scope, "createTicket", args);
    expect(await admin.exists(key)).toBe(1);
    expect(JSON.parse((await admin.get(key)) as string)).toMatchObject({ state: "done" });
    registry.close();
  });

  it("跨实例重放命中：两个 registry（模拟两个进程）只有首执行，B 拿 A 的结果", async () => {
    const a = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const b = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const scope = scopeOf("two-instances");
    let calls = 0;
    const exec = async () => {
      calls += 1;
      return { ticketId: "TK-20261013-0001" };
    };

    const fromA = await a.run(scope, "createTicket", { subject: "X" }, exec);
    const fromB = await b.run(scope, "createTicket", { subject: "X" }, exec);
    expect(fromB).toEqual(fromA); // B 拿到的是 A 的首次结果
    expect(calls).toBe(1); // 跨实例也只执行一次——这正是内存版给不了的窗口
    a.close();
    b.close();
  });

  it("跨实例在途：A 执行中（占位未回写）时 B 同参调用 → B 拿降级值、不重复执行", async () => {
    const a = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const b = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const scope = scopeOf("cross-inflight");
    let aCalls = 0;

    const aRun = a.run(scope, "t", { k: 1 }, async () => {
      aCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150)); // 拉宽在途窗口
      return "A 的结果";
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // 等 A 抢到锁、正在执行

    let bCalls = 0;
    const fromB = await b.run(scope, "t", { k: 1 }, async () => {
      bCalls += 1;
      return "B 的结果";
    });
    expect(isIdempotencyDegraded(fromB)).toBe(true); // 结构化降级值，模型可见
    if (isIdempotencyDegraded(fromB)) expect(fromB.message).toContain("处理中");
    expect(bCalls).toBe(0); // B 没有重复执行——「至多一次」底线

    expect(await aRun).toBe("A 的结果");
    expect(aCalls).toBe(1);
    a.close();
    b.close();
  });

  it("失败不缓存：抛错上抛 + 占位已释放（同参重试是真重试）", async () => {
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const scope = scopeOf("fail");
    let calls = 0;
    const flaky = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error("上游超时");
      return `ok-${calls}`;
    };

    await expect(registry.run(scope, "t", { k: 1 }, flaky)).rejects.toThrow("上游超时");
    if (admin === null) throw new Error("admin 客户端不可用");
    expect(await admin.exists(redisIdempotencyKey(scope, "t", { k: 1 }))).toBe(0); // 占位已释放

    const retry = await registry.run(scope, "t", { k: 1 }, flaky); // 重试 = 新尝试
    expect(retry).toBe("ok-2");
    expect(calls).toBe(2);
    registry.close();
  });

  it("同进程在途共享：同键并发共享同一执行（与内存版同款语义，不走降级）", async () => {
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const scope = scopeOf("inflight");
    let calls = 0;
    const slow = async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return `done-${calls}`;
    };

    const [first, second] = await Promise.all([
      registry.run(scope, "t", { k: 1 }, slow),
      registry.run(scope, "t", { k: 1 }, slow), // 与上一个并发（第一个还在途）
    ]);
    expect(first).toBe("done-1");
    expect(second).toBe("done-1"); // 共享同一执行——不是降级值
    expect(calls).toBe(1);
    registry.close();
  });

  it("TTL（PX）：窗口从首次调用起算（成功回写用剩余时长）；窗口后同参重放真执行", async () => {
    const counter = countingExecute();
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL, ttlMs: 300 });
    const scope = scopeOf("ttl");
    const args = { k: 1 };
    const slowExec = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100)); // 执行本身耗 100ms
      return counter.run(args);
    };

    await registry.run(scope, "t", args, slowExec);
    if (admin === null) throw new Error("admin 客户端不可用");
    const key = redisIdempotencyKey(scope, "t", args);
    const pttl = await admin.pttl(key);
    expect(pttl).toBeGreaterThan(0); // PX 真的带了过期——内存版给不了的阀门
    expect(pttl).toBeLessThanOrEqual(220); // 剩余窗口 ≈ ttl − 执行耗时（非重置 300ms，留 20ms 取整余量）

    await registry.run(scope, "t", args, () => counter.run(args)); // 窗口内：命中
    expect(counter.calls).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 350)); // 越过剩余窗口
    await registry.run(scope, "t", args, () => counter.run(args)); // 窗口后：真执行
    expect(counter.calls).toBe(2);
    registry.close();
  });

  it("scope 隔离：不同会话互不去重；clearScope 定向清理（SCAN，不误伤别的 scope）", async () => {
    const counter = countingExecute();
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const s1 = scopeOf("iso-1");
    const s2 = scopeOf("iso-2");
    const args = { subject: "同内容" };

    await registry.run(s1, "createTicket", args, () => counter.run(args));
    await registry.run(s2, "createTicket", args, () => counter.run(args)); // 另一会话：真执行
    expect(counter.calls).toBe(2);

    await registry.clearScope(s1); // 只清 s1
    await registry.run(s1, "createTicket", args, () => counter.run(args)); // s1 已清：真执行
    expect(counter.calls).toBe(3);
    await registry.run(s2, "createTicket", args, () => counter.run(args)); // s2 未清：命中
    expect(counter.calls).toBe(3);
    registry.close();
  });

  it("close 主动断开后再次 run 按需重连（懒连接生命周期；窗口仍在 Redis 里）", async () => {
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const scope = scopeOf("reconnect");

    await registry.run(scope, "t", { k: 1 }, async () => "first");
    registry.close();
    const second = await registry.run(scope, "t", { k: 1 }, async () => "second");
    expect(second).toBe("first"); // close 不清 Redis 状态：重放仍命中（没走 execute）
    registry.close();
  });

  it("wrapToolsWithRedisIdempotency：包壳后同会话同参的两次工具调用只执行一次", async () => {
    let calls = 0;
    const registry = new RedisIdempotencyRegistry({ url: REDIS_URL });
    const base: AgentToolSet = {
      createTicket: tool({
        description: "创建工单（测试桩）",
        inputSchema: z.object({ subject: z.string() }),
        execute: async (input: { subject: string }) => {
          calls += 1;
          return { ticketId: `T-${calls}`, subject: input.subject };
        },
      }),
    };
    const wrapped = wrapToolsWithRedisIdempotency(base, registry, { scope: scopeOf("wrap") });

    const t = wrapped.createTicket;
    if (t?.execute === undefined) throw new Error("unreachable");
    const first = await t.execute({ subject: "查不到订单" }, { toolCallId: "c1", messages: [] });
    const replay = await t.execute({ subject: "查不到订单" }, { toolCallId: "c2", messages: [] });
    expect(first).toEqual(replay); // 同一工单，不重复建
    expect(calls).toBe(1);
    registry.close();
  });
});
