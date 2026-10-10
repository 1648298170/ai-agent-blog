// memory.contract.spec.ts —— SessionStore 契约测试：同一套行为断言跑所有实现。
//
// 为什么存在：SessionStore 有多份实现（memory / redis / 未来的任何存储），「同接口
// 多实现」的承诺需要质检背书——没有契约测试，第四份实现的行为漂移只能靠用户踩坑发现。
// 契约 = 接口语义的最小集合（顺序、窗口、隔离、全量、清单、清理），不含实现细节
//（如压缩阈值、TTL 秒数——那是各实现的内建行为，有各自的专项测试）。
//
// 运行矩阵：
// - memory 实现：always 跑（零依赖）；
// - redis 实现：RUN_INFRA_TESTS=1 且 Redis 可达时跑（沿用 infra spec 的门控与探测）。
// 新增 SessionStore 实现时：再调一次 runSessionStoreContract 即可，断言零复制。
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatTurn, SessionStore } from "../src/memory/types.js";
import { InMemorySessionStore } from "../src/memory/session.memory.js";

/** 契约套件：对任意 SessionStore 实现断言接口语义（suite 仅用于用例命名） */
export function runSessionStoreContract(suite: string, makeStore: () => SessionStore): void {
  const t = (role: ChatTurn["role"], text: string): ChatTurn => ({ role, content: text });

  describe(`SessionStore 契约 · ${suite}`, () => {
    let store: SessionStore;
    const sid = `contract-${Math.random().toString(36).slice(2, 8)}`;

    beforeEach(() => {
      store = makeStore();
    });

    it("append → getWindow：按写入顺序原样返回", async () => {
      await store.append(sid, t("user", "第一条"));
      await store.append(sid, t("assistant", "第二条"));
      const window = await store.getWindow(sid);
      expect(window.map((turn) => turn.content)).toEqual(["第一条", "第二条"]);
      expect(window[0]?.role).toBe("user");
      expect(window[1]?.role).toBe("assistant");
    });

    it("getWindow(limit)：只取最近 N 条（窗口语义，非全量）", async () => {
      for (let i = 1; i <= 5; i++) await store.append(sid, t("user", `消息${i}`));
      const window = await store.getWindow(sid, 2);
      expect(window.map((turn) => turn.content)).toEqual(["消息4", "消息5"]);
    });

    it("会话隔离：不同 sessionId 互不可见", async () => {
      await store.append("iso-a", t("user", "A 的消息"));
      await store.append("iso-b", t("user", "B 的消息"));
      const a = await store.getWindow("iso-a");
      expect(a.map((turn) => turn.content)).toEqual(["A 的消息"]);
    });

    it("getHistory：返回全量轮次（供历史面板/审计），与窗口截断无关", async () => {
      for (let i = 1; i <= 5; i++) await store.append(sid, t("user", `全量${i}`));
      const history = await store.getHistory(sid);
      expect(history.length).toBeGreaterThanOrEqual(5);
    });

    it("listSessions：新写入的会话出现在清单中", async () => {
      const marker = `${sid}-listed`;
      await store.append(marker, t("user", "清单可见性探针"));
      const sessions = await store.listSessions();
      expect(sessions.some((summary) => summary.sessionId === marker)).toBe(true);
    });

    it("clear：清空指定会话（窗口与历史都为空）", async () => {
      await store.append(sid, t("user", "将被清空"));
      await store.clear(sid);
      expect(await store.getWindow(sid)).toEqual([]);
    });
  });
}

// —— memory 实现：always 跑（零依赖，契约的基准执行者）——
runSessionStoreContract("memory 实现", () => new InMemorySessionStore());

// —— redis 实现：沿用 infra spec 的门控（RUN_INFRA_TESTS=1 且可达才跑）——
const gated = process.env.RUN_INFRA_TESTS === "1";
if (gated) {
  // 动态 import：非 infra 轮次连 ioredis 连接代码都不加载（离线零感知）
  const { Redis } = await import("ioredis");
  const { createRedisSessionStore } = await import("../src/memory/session.redis.js");
  const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

  let reachable = false;
  try {
    const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
    await probe.connect();
    await probe.ping();
    probe.disconnect();
    reachable = true;
  } catch {
    reachable = false;
  }

  if (reachable) {
    const store = createRedisSessionStore();
    runSessionStoreContract("redis 实现", () => store);
    // 清理契约用例的残留（key 前缀 contract-*；有 24h TTL 兜底，但测试应自扫门前）
    const redis = new Redis(REDIS_URL);
    afterAll(async () => {
      const keys = await redis.keys("contract-*");
      if (keys.length > 0) await redis.del(...keys);
      redis.disconnect();
    });
  }
}
