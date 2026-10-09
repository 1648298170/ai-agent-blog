// idempotency.spec.ts —— 工具执行幂等层的离线单测：首调执行 / 重放命中 / 失败不缓存 /
// 在途共享 / TTL 过期 / scope 隔离 / 参数指纹规范化 / 容量淘汰。全程零网络零延迟——
// execute 用计数器闭包，行为断言只看「真执行了几次」。
import { describe, expect, it, vi } from "vitest";
import {
  IdempotencyRegistry,
  stableStringify,
  wrapToolsWithIdempotency,
} from "../src/tools/idempotency.js";
import { tool } from "ai";
import { z } from "zod";
import type { AgentToolSet } from "../src/types.js";

/** 计数工具：每次真执行 +1，返回执行次数——重放命中时数字不变 */
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

describe("stableStringify：参数指纹规范化", () => {
  it("键序不同、undefined 字段差异 → 同指纹；值不同 → 异指纹", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
    // 嵌套与数组也走同一规范化
    expect(stableStringify({ list: [1, { x: "s" }] })).toBe(stableStringify({ list: [1, { x: "s" }] }));
  });
});

describe("IdempotencyRegistry：六条语义", () => {
  it("首调真执行；同 scope+工具+参数重放 → 命中缓存不再执行", async () => {
    const counter = countingExecute();
    const registry = new IdempotencyRegistry();
    const args = { subject: "退款", description: "7 天未发货" };

    const first = await registry.run("s_1", "createTicket", args, () => counter.run(args));
    const replay = await registry.run("s_1", "createTicket", args, () => counter.run(args));

    expect(first).toEqual({ calls: 1, echo: args });
    expect(replay).toEqual(first); // 重放拿到首次结果
    expect(counter.calls).toBe(1); // 真执行只有一次
  });

  it("参数不同 → 新键真执行（内容真变了就是新业务）", async () => {
    const counter = countingExecute();
    const registry = new IdempotencyRegistry();

    await registry.run("s_1", "createTicket", { subject: "A" }, () => counter.run("A"));
    await registry.run("s_1", "createTicket", { subject: "B" }, () => counter.run("B"));

    expect(counter.calls).toBe(2);
  });

  it("失败不缓存：抛错后移除条目，同参重试是真重试；成功后重放才命中", async () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    const flaky = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error("上游超时");
      return `ok-${calls}`;
    };

    await expect(registry.run("s_1", "t", { k: 1 }, flaky)).rejects.toThrow("上游超时");
    expect(registry.size).toBe(0); // 失败条目已移除

    const retry = await registry.run("s_1", "t", { k: 1 }, flaky); // 同参重试 = 真重试
    expect(retry).toBe("ok-2");
    expect(calls).toBe(2);

    const replay = await registry.run("s_1", "t", { k: 1 }, flaky); // 成功后重放命中
    expect(replay).toBe("ok-2");
    expect(calls).toBe(2);
  });

  it("在途共享：同键并发调用共享同一 Promise（第二个等待者不触发第二次执行）", async () => {
    const registry = new IdempotencyRegistry();
    let calls = 0;
    const slow = async (): Promise<string> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return `done-${calls}`;
    };

    const [a, b] = await Promise.all([
      registry.run("s_1", "t", { k: 1 }, slow),
      registry.run("s_1", "t", { k: 1 }, slow), // 与上一个并发（第一个还在途）
    ]);

    expect(a).toBe("done-1");
    expect(b).toBe("done-1"); // 共享同一执行
    expect(calls).toBe(1);
  });

  it("TTL 过期：窗口内命中，窗口后同参重放真执行", async () => {
    vi.useFakeTimers();
    try {
      const counter = countingExecute();
      const registry = new IdempotencyRegistry({ ttlMs: 50 });
      const args = { k: 1 };

      await registry.run("s_1", "t", args, () => counter.run(args));
      vi.advanceTimersByTime(60); // 越过 TTL
      await registry.run("s_1", "t", args, () => counter.run(args));

      expect(counter.calls).toBe(2); // 窗口后重放 = 真执行
    } finally {
      vi.useRealTimers();
    }
  });

  it("scope 隔离：不同会话同参互不去重；clearScope 定向清理", async () => {
    const counter = countingExecute();
    const registry = new IdempotencyRegistry();
    const args = { subject: "同内容" };

    await registry.run("s_1", "createTicket", args, () => counter.run(args));
    await registry.run("s_2", "createTicket", args, () => counter.run(args)); // 另一会话：真执行
    expect(counter.calls).toBe(2);

    registry.clearScope("s_1");
    expect(registry.size).toBe(1); // 只剩 s_2 的条目
    await registry.run("s_2", "createTicket", args, () => counter.run(args)); // s_2 未清：命中
    expect(counter.calls).toBe(2);
  });

  it("容量淘汰：超 maxEntries 时按插入序淘汰最早条目", async () => {
    const counter = countingExecute();
    const registry = new IdempotencyRegistry({ maxEntries: 2 });

    await registry.run("s", "t", { k: 1 }, () => counter.run(1));
    await registry.run("s", "t", { k: 2 }, () => counter.run(2));
    await registry.run("s", "t", { k: 3 }, () => counter.run(3)); // 淘汰 k=1
    expect(registry.size).toBe(2);

    await registry.run("s", "t", { k: 1 }, () => counter.run(1)); // k=1 已被淘汰：真执行
    expect(counter.calls).toBe(4);
  });
});

describe("wrapToolsWithIdempotency：工具表壳", () => {
  function demoTools(execute: (input: { subject: string }) => Promise<unknown>): AgentToolSet {
    return {
      createTicket: tool({
        description: "创建工单（测试桩）",
        inputSchema: z.object({ subject: z.string() }),
        execute,
      }),
    };
  }

  it("包壳后重放命中：同会话同参的两次工具调用只执行一次", async () => {
    let calls = 0;
    const registry = new IdempotencyRegistry();
    const wrapped = wrapToolsWithIdempotency(
      demoTools(async (input) => {
        calls += 1;
        return { ticketId: `T-${calls}`, subject: input.subject };
      }),
      registry,
      { scope: "s_wrap" },
    );

    const t = wrapped.createTicket;
    if (t?.execute === undefined) throw new Error("unreachable");
    const first = await t.execute({ subject: "查不到订单" }, { toolCallId: "c1", messages: [] });
    const replay = await t.execute({ subject: "查不到订单" }, { toolCallId: "c2", messages: [] });

    expect(first).toEqual(replay); // 同一工单，不重复建
    expect(calls).toBe(1);
  });

  it("无 execute 的工具原样透传（调度方自执行的不归幂等层管）", () => {
    const registry = new IdempotencyRegistry();
    const bare = { schemaOnly: tool({ description: "无 execute", inputSchema: z.object({}) }) };
    const wrapped = wrapToolsWithIdempotency(bare, registry, { scope: "s" });
    expect(wrapped.schemaOnly).toBe(bare.schemaOnly); // 引用相等：未包壳
  });
});
