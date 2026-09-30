// infra.redis.spec.ts —— Redis SessionStore 集成测试（真实 Redis，week17 实战）
// 门控：环境变量 RUN_INFRA_TESTS=1 才尝试连接（pnpm test:infra 自动设置）；
// 服务不可达 → describe.skip 并打印原因，绝不炸普通 pnpm test / CI。
// 覆盖：append/getWindow 尾窗、TTL 续期（'EX' 那道内存版给不了的阀门）、
// clear、以及共享压缩算法的两条路径（注入假 Summarizer：成功压缩 / 离线降级）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import {
  createRedisSessionStore,
  SESSION_KEY_PREFIX,
  SESSION_TTL_SECONDS,
} from "../src/memory/session.redis.js";
import { SUMMARY_PREFIX } from "../src/memory/compression.js";

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
    `[infra.redis] Redis 不可达（${REDIS_URL}）：${probeError}\n` +
      "  跳过 Redis 集成测试。请先在 agent-app 目录运行 pnpm infra:up 等 redis healthy，再跑 pnpm test:infra。",
  );
}
if (!gated) {
  console.warn("[infra.redis] 未设置 RUN_INFRA_TESTS=1，跳过（普通 pnpm test 不碰真实基础设施）。");
}

// 本轮测试专用会话前缀：afterAll 一把清掉，不残留 agent:sess:spec-* 键
const RUN = Date.now().toString(36);
const sid = (name: string) => `spec-${RUN}-${name}`;
const admin = reachable ? new Redis(REDIS_URL, { maxRetriesPerRequest: 1 }) : null;

describeRedis("Redis SessionStore（真实 Redis）", () => {
  beforeAll(async () => {
    // 兜底清掉历史残留的同前缀键
    if (admin !== null) {
      const stale = await admin.keys(`${SESSION_KEY_PREFIX}:spec-*`);
      if (stale.length > 0) await admin.del(...stale);
    }
  });

  afterAll(async () => {
    if (admin !== null) {
      const stale = await admin.keys(`${SESSION_KEY_PREFIX}:spec-*`);
      if (stale.length > 0) await admin.del(...stale);
      admin.disconnect();
    }
  });

  it("append/getWindow：追加有序、getWindow 取尾部窗口、会话之间不串门", async () => {
    const store = createRedisSessionStore({ url: REDIS_URL });
    const s = sid("basic");
    for (let i = 1; i <= 25; i++) {
      await store.append(s, { role: i % 2 === 0 ? "assistant" : "user", content: `t${i}` });
    }
    const window = await store.getWindow(s, 20);
    expect(window.length).toBe(20); // 截断阀门：只回最近 20 轮
    expect(window[0].content).toBe("t6");
    expect(window[19].content).toBe("t25");
    expect((await store.getWindow(s)).length).toBe(20); // 默认 limit=20
    expect((await store.getWindow(s, 100)).length).toBe(25); // limit 大于长度时全量

    await store.append(sid("other"), { role: "user", content: "另一个会话" });
    expect((await store.getWindow(sid("other"), 20)).length).toBe(1);
  });

  it("TTL：append 后 key 存在且 ttl > 0（'EX' 续期，24h 量级）", async () => {
    if (admin === null) throw new Error("admin 客户端不可用");
    const store = createRedisSessionStore({ url: REDIS_URL });
    const s = sid("ttl");
    await store.append(s, { role: "user", content: "hello" });

    const key = `${SESSION_KEY_PREFIX}:${s}`;
    expect(await admin.exists(key)).toBe(1); // key 命名遵守 agent:sess:{sessionId} 教程口径
    const ttl = await admin.ttl(key);
    expect(ttl).toBeGreaterThan(0); // TTL 必须存在——这正是内存版给不了的阀门
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_SECONDS); // 上限 24 小时
  });

  it("clear：DEL 整条会话，别的会话不受影响", async () => {
    if (admin === null) throw new Error("admin 客户端不可用");
    const store = createRedisSessionStore({ url: REDIS_URL });
    const s = sid("clear");
    const keep = sid("keep");
    await store.append(s, { role: "user", content: "将被清掉" });
    await store.append(keep, { role: "user", content: "将被保留" });

    await store.clear(s);
    expect((await store.getWindow(s, 20)).length).toBe(0);
    expect(await admin.exists(`${SESSION_KEY_PREFIX}:${s}`)).toBe(0);
    expect((await store.getWindow(keep, 20)).length).toBe(1); // clear 只清目标会话
  });

  it("压缩：超过 40 条触发共享压缩算法（注入假 Summarizer，零网络）", async () => {
    const store = createRedisSessionStore({
      url: REDIS_URL,
      summarize: async () => "用户关注订单物流，偏好简短回复。",
    });
    const s = sid("compress");
    for (let i = 1; i <= 41; i++) {
      await store.append(s, { role: i % 2 === 0 ? "assistant" : "user", content: `t${i}` });
    }
    const win = await store.getWindow(s, 100);
    expect(win.length).toBe(21); // 1 条合成摘要轮 + 20 条最近轮
    expect(win[0].role).toBe("system");
    expect(win[0].content).toBe(SUMMARY_PREFIX + "用户关注订单物流，偏好简短回复。");
    expect(win[1].content).toBe("t22");
    expect(win[20].content).toBe("t41");
  });

  it("压缩降级：摘要器抛错 → 只保最近 20 条、不出摘要轮（离线优先）", async () => {
    const store = createRedisSessionStore({
      url: REDIS_URL,
      summarize: async () => {
        throw new Error("模拟离线：未配置 OPENAI_API_KEY");
      },
    });
    const s = sid("degrade");
    for (let i = 1; i <= 41; i++) {
      await store.append(s, { role: "user", content: `t${i}` });
    }
    const win = await store.getWindow(s, 100);
    expect(win.length).toBe(20); // 降级只保最近 20 条
    expect(win[0].content).toBe("t22");
    expect(win.every((t) => t.role !== "system")).toBe(true); // 降级不产出摘要轮
  });

  it("并发 append：50 个并发写入与顺序写入结果完全一致（延迟假 summarize 拉宽竞态窗口，不丢轮次）", async () => {
    // 生产缺陷的 Redis 侧回归：旧实现「RPUSH →（超阈值）LRANGE → 压缩（秒级）
    // → MULTI 重写」并发交错时后写者覆盖先写者。进程内串行链修复后，单进程的
    // 50 并发必须与顺序语义完全一致（跨进程互斥由压缩锁保证，锁原语的
    // 离线单测在 session-concurrency.spec.ts）
    const makeStore = () =>
      createRedisSessionStore({
        url: REDIS_URL,
        summarize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5)); // 微缩版的秒级 LLM 调用
          return "并发测试用固定摘要";
        },
      });

    const N = 50;
    const sequential = makeStore();
    for (let i = 1; i <= N; i++) {
      await sequential.append(sid("conc-seq"), { role: "user", content: `t${i}` });
    }

    const concurrent = makeStore();
    const target = sid("conc-race");
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        concurrent.append(target, { role: "user", content: `t${i + 1}` }),
      ),
    );

    // 并发 == 顺序：既不丢轮次，也没有走出分叉的压缩时序
    expect(await concurrent.getHistory(target)).toEqual(await sequential.getHistory(sid("conc-seq")));
  });
});
