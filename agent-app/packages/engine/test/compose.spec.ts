// compose.spec.ts —— 工具壳组合器的顺序语义单测：洋葱模型（shells[0] 最外层、
// 最先拦截调用）是 composeToolShells 的核心承诺——审批外/幂等内的安全语义全靠它。
// 用「拦截顺序记录」断言：外层壳先看到调用，内层壳后看到，最终到达原工具。
import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type { AgentToolSet } from "../src/types.js";
import { composeToolShells } from "../src/tools/compose.js";

function echoTools(): AgentToolSet {
  return {
    echo: tool({
      description: "回显入参（测试桩）",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ reached: "original", text }),
    }),
  };
}

describe("composeToolShells：洋葱模型顺序语义", () => {
  it("shells[0] 最外层：拦截顺序 = 书写顺序（[外, 内] → 外先看到调用）", async () => {
    const interception: string[] = [];
    const outer = (tools: AgentToolSet): AgentToolSet => ({
      ...tools,
      echo: {
        ...tools.echo,
        execute: async (args, opts) => {
          interception.push("outer");
          return (tools.echo.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, opts);
        },
      },
    });
    const inner = (tools: AgentToolSet): AgentToolSet => ({
      ...tools,
      echo: {
        ...tools.echo,
        execute: async (args, opts) => {
          interception.push("inner");
          return (tools.echo.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, opts);
        },
      },
    });

    const composed = composeToolShells(echoTools(), [outer, inner]);
    const execute = composed.echo?.execute;
    if (execute === undefined) throw new Error("unreachable");
    const result = (await execute({ text: "hi" }, { toolCallId: "c", messages: [] })) as {
      reached: string;
    };

    expect(interception).toEqual(["outer", "inner"]); // 外层先拦、内层后拦
    expect(result.reached).toBe("original"); // 最终到达原工具
  });

  it("审批外/幂等内的实战顺序：拒绝发生在幂等判定之前（拒绝不污染缓存）", async () => {
    const events: string[] = [];
    let originalCalls = 0;

    // 模拟审批壳：拒绝一切调用（不调用内层）
    const denyingApproval = (tools: AgentToolSet): AgentToolSet => ({
      ...tools,
      echo: {
        ...tools.echo,
        execute: async () => {
          events.push("approval:denied");
          return { denied: true, reason: "用户拒绝" };
        },
      },
    });
    // 模拟幂等壳：通过后记一笔并执行原工具
    const idempotencyish = (tools: AgentToolSet): AgentToolSet => ({
      ...tools,
      echo: {
        ...tools.echo,
        execute: async (args, opts) => {
          events.push("idempotency:pass-through");
          originalCalls += 1;
          return (tools.echo.execute as (a: unknown, o: unknown) => Promise<unknown>)(args, opts);
        },
      },
    });

    const composed = composeToolShells(echoTools(), [denyingApproval, idempotencyish]);
    const execute = composed.echo?.execute;
    if (execute === undefined) throw new Error("unreachable");
    await execute({ text: "建工单" }, { toolCallId: "c", messages: [] });

    expect(events).toEqual(["approval:denied"]); // 幂等层从未被触达
    expect(originalCalls).toBe(0); // 原工具也没执行
  });

  it("空清单 → 原表原样返回（零变化默认）", () => {
    const base = echoTools();
    expect(composeToolShells(base, [])).toBe(base); // 引用相等：无壳 = 无变化
  });
});
