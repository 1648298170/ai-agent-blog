// session-concurrency.spec.ts —— 会话存储并发安全的行为测试（离线、确定性）
// 背景（生产缺陷）：append 是「读 → 压缩（LLM 调用，秒级）→ 写回」的三步复合操作，
// 并发 append 同一会话时后写者覆盖先写者——消息丢失。修复 = 每会话串行链
// （session.memory.ts / session.redis.ts 同款语义）+ Redis 侧压缩锁。
// 这里覆盖三件事：
//   1. 内存版：50 个并发 append 与顺序 append 结果完全一致（注入延迟假
//      summarize 拉宽竞态窗口——旧实现在这条用例下必然丢消息）；
//   2. 内存版：阈值之下的纯并发追加一条不丢（压缩不掺和，断言最直白）；
//   3. Redis 版的锁原语（acquireSessionLock）：用假 SessionLockClient 离线验证
//      占锁/互斥/持有人校验释放的语义（真实 Redis 的并发用例在 infra.redis.spec.ts）。
import { describe, expect, it } from "vitest";
import { InMemorySessionStore } from "../src/memory/session.memory.js";
import { COMPRESS_AFTER, KEEP_RECENT, SUMMARY_PREFIX } from "../src/memory/compression.js";
import {
  acquireSessionLock,
  SESSION_LOCK_PREFIX,
  SESSION_LOCK_TTL_MS,
} from "../src/memory/session.redis.js";
import type { SessionLockClient } from "../src/memory/session.redis.js";
import type { ChatTurn } from "../src/memory/types.js";

/** 假 summarize：延迟几毫秒再返回——把「读-压-写」竞态窗口从微秒级拉宽到可观测 */
function delayedSummarizer(delayMs: number) {
  return async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return "并发测试用固定摘要";
  };
}

/** 造第 i 条（1 起）用户消息 */
function turn(i: number): ChatTurn {
  return { role: "user", content: `消息 ${i}` };
}

describe("InMemorySessionStore 并发 append（串行链修复）", () => {
  it("50 个并发 append：与顺序 append 的最终状态完全一致（不丢消息）", async () => {
    const N = 50;
    // 顺序对照组：同一注入配置下逐条写入，产出「正确答案」
    const sequential = new InMemorySessionStore({ summarize: delayedSummarizer(2) });
    for (let i = 1; i <= N; i++) {
      await sequential.append("ctrl", turn(i));
    }
    // 并发组：50 个 append 同时挂起（旧实现里它们的「读」都发生在彼此「写」之前）
    const concurrent = new InMemorySessionStore({ summarize: delayedSummarizer(2) });
    await Promise.all(
      Array.from({ length: N }, (_, i) => concurrent.append("race", turn(i + 1))),
    );

    const expected = await sequential.getHistory("ctrl");
    const actual = await concurrent.getHistory("race");
    // 相等即「并发 == 顺序」：既没有丢消息，也没有因为压缩时序不同走出分叉结果
    expect(actual).toEqual(expected);
  });

  it("50 个并发 append：压缩语义如实生效（41 条触发 → 摘要 + 最近 20 条，末条是第 50 条）", async () => {
    const N = 50;
    const store = new InMemorySessionStore({ summarize: delayedSummarizer(2) });
    await Promise.all(Array.from({ length: N }, (_, i) => store.append("race", turn(i + 1))));

    const history = await store.getHistory("race");
    // 第 41 次 append 时长度 41 > 40 触发压缩 → [摘要, ...最近 20 条] = 21；
    // 之后第 42..50 次（9 条）不再触发 → 最终 30 条。
    // 「不丢消息」的准确口径：并发结果与顺序语义一致（上一条用例已断言逐字段相等），
    // 这里再锚定具体形状，防止「两边错得一样」的假阳性。
    expect(history.length).toBe(1 + KEEP_RECENT + (N - 1 - COMPRESS_AFTER));
    expect(history[0]?.role).toBe("system");
    expect(history[0]?.content.startsWith(SUMMARY_PREFIX)).toBe(true);
    // 41 条触发压缩：older = 1..21 进摘要，recent = 22..41 原样保留 → 首条原文是第 22 条
    expect(history[1]?.content).toBe(`消息 ${42 - KEEP_RECENT}`);
    expect(history[history.length - 1]?.content).toBe(`消息 ${N}`);
    // 会话计数与历史一致（listSessions 读的是同一份已提交状态）
    const sessions = await store.listSessions();
    expect(sessions[0]?.turns).toBe(history.length);
  });

  it("阈值之下的纯并发追加：一条不丢、顺序保持（Promise.all 按提交顺序入链）", async () => {
    // 30 < COMPRESS_AFTER：压缩不参与，getHistory 的长度就是「收到的消息数」，
    // 断言最直白——50 并发版本见上（压缩参与时长度语义见该用例注释）
    const N = 30;
    const store = new InMemorySessionStore({ summarize: delayedSummarizer(2) });
    await Promise.all(Array.from({ length: N }, (_, i) => store.append("pure", turn(i + 1))));

    const history = await store.getHistory("pure");
    expect(history.length).toBe(N);
    expect(history.map((t) => t.content)).toEqual(
      Array.from({ length: N }, (_, i) => `消息 ${i + 1}`),
    );
  });

  it("失败不毒化链：某次 append 中途抛错后，同会话的后续 append 照常成功", async () => {
    const store = new InMemorySessionStore({ summarize: delayedSummarizer(1) });
    await store.append("poison", { role: "user", content: "第一条" });

    // 注入点：doAppend 里 `turns.push({ ...turn })` 的展开会读取 getter——
    // 抛错的 getter 等价于「写入中途失败」（调用方拿到 rejection，消息不落账）
    const boom: ChatTurn = {
      role: "user",
      get content(): string {
        throw new Error("模拟写入中途失败");
      },
    };
    await expect(store.append("poison", boom)).rejects.toThrow("模拟写入中途失败");

    // 关键断言：失败的 run 不能毒化会话链——下一条消息依然排队成功
    await expect(
      store.append("poison", { role: "user", content: "第三条" }),
    ).resolves.toBeUndefined();
    expect((await store.getHistory("poison")).map((t) => t.content)).toEqual(["第一条", "第三条"]);
  });
});

// ── Redis 锁原语（离线假客户端）──────────────────────────────────────────

/** 假 SessionLockClient：一个 Map 模拟 Redis 的 SET NX PX / 比较删除语义 */
function createFakeLockClient() {
  const store = new Map<string, string>();
  const client: SessionLockClient = {
    setNxPx: async (key, value) => {
      if (store.has(key)) return null; // NX：已被占
      store.set(key, value);
      return "OK";
    },
    compareDel: async (key, value) => {
      if (store.get(key) === value) {
        store.delete(key);
        return 1;
      }
      return 0; // 持有人不匹配：不删（防误删他人的锁）
    },
  };
  return { client, store };
}

describe("acquireSessionLock（压缩重写的跨进程锁，假客户端离线验证）", () => {
  it("空闲 key：占锁成功，key 写入 agent:sess:lock:{sessionId} 前缀", async () => {
    const { client, store } = createFakeLockClient();
    const lock = await acquireSessionLock(client, "s_1");
    expect(lock.acquired).toBe(true);
    expect([...store.keys()]).toEqual([`${SESSION_LOCK_PREFIX}:s_1`]);
    await lock.release();
  });

  it("已被占：第二个获取者拿不到锁（acquired=false，不等待不重试）", async () => {
    const { client } = createFakeLockClient();
    const first = await acquireSessionLock(client, "s_1");
    const second = await acquireSessionLock(client, "s_1");
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false); // 竞争者本轮跳过压缩
    await first.release();
  });

  it("释放后可重新占锁（模拟 TTL 到期前的正常交接）", async () => {
    const { client, store } = createFakeLockClient();
    const first = await acquireSessionLock(client, "s_1");
    await first.release();
    expect(store.size).toBe(0); // 持有人匹配 → 已删
    const second = await acquireSessionLock(client, "s_1");
    expect(second.acquired).toBe(true);
    await second.release();
  });

  it("迟到的释放不误删他人的锁：A 过期后 B 拿到新锁，A 的 release 必须是 no-op", async () => {
    // 这是「GET-then-DEL 两步」会翻车的经典场景，也是必须用 Lua 比对持有人的原因
    const { client, store } = createFakeLockClient();
    const a = await acquireSessionLock(client, "s_1");
    // 模拟 A 的锁过期（TTL 到期被 Redis 删除）、B 随后拿到新锁
    store.clear();
    const b = await acquireSessionLock(client, "s_1");
    expect(b.acquired).toBe(true);
    // A 这时才姗姗来迟地释放：持有人不匹配 → 不能删掉 B 的锁
    await a.release();
    expect(store.size).toBe(1); // B 的锁还在
    await b.release();
  });

  it("未拿到锁时 release 是 no-op（调用方可以无条件 finally release）", async () => {
    const { client } = createFakeLockClient();
    const first = await acquireSessionLock(client, "s_1");
    const loser = await acquireSessionLock(client, "s_1");
    await expect(loser.release()).resolves.toBeUndefined();
    expect(first.acquired).toBe(true); // 赢家的锁不受输家的 release 影响
    await first.release();
  });

  it("锁常量口径：TTL 30 秒（覆盖一次 LLM 压缩调用，持有者崩溃后的解锁上限）", async () => {
    expect(SESSION_LOCK_TTL_MS).toBe(30_000);
  });
});
