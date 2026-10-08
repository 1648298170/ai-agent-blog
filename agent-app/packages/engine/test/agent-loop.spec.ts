// agent-loop.spec.ts —— runToolLoop 的中止信号（signal）行为测试（离线、确定性）
// 背景（生产缺陷）：SSE 客户端断开后模型调用继续跑完——纯烧 token。修复 =
// RunToolLoopOptions 新增可选 signal：透传给每一步 generateText 的 abortSignal，
// 且在每次调度下一次模型调用之前检查 aborted 提前退出。
// 剧本模型用 ai/test 的 MockLanguageModelV2（与 evals/fixtures.ts 同款接缝）：
// 类型与真实模型完全同构，且 doGenerate 的入参（callOptions）里能直接拿到
// SDK 传下来的 abortSignal——断言「引擎给的 signal 原样到达模型层」。
// 默认（不传 signal）的行为回归也在本文件锚定：undefined 必须零感知。
import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod";
import { runToolLoop, TOOL_LOOP_ABORTED } from "../src/agent-loop.js";
import type { ToolLoopStepEvent } from "../src/agent-loop.js";

/** 假模型的用量上报：全 0（形状要合规，数值没人消费；同 evals/fixtures.ts） */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** doGenerate 的返回形状（从协议类型反推，避免手写长类型漂移；同 fixtures.ts） */
type ScriptedResponse = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>;

/** 一轮 text 回复（循环的正常出口） */
function textResponse(text: string): ScriptedResponse {
  return {
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: ZERO_USAGE,
    warnings: [],
  };
}

/** 一轮工具调用（驱动循环进入下一步） */
function toolCallResponse(toolName: string, input: Record<string, unknown>): ScriptedResponse {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `abort-spec-call-${Math.random().toString(36).slice(2, 8)}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: "tool-calls",
    usage: ZERO_USAGE,
    warnings: [],
  };
}

/** 测试用工具表：一个最平凡的 echo 工具（无网络、无状态） */
function echoTools() {
  return {
    echo: tool({
      description: "原样返回输入",
      inputSchema: z.object({ message: z.string() }),
      execute: async ({ message }) => ({ message }),
    }),
  };
}

describe("runToolLoop 的 signal（断开中止）", () => {
  it("透传：doGenerate 收到的 callOptions.abortSignal 就是传给 runToolLoop 的 signal", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV2({
      doGenerate: async () => textResponse("好的"),
    });

    await runToolLoop({
      model,
      messages: [{ role: "user", content: "你好" }],
      tools: {},
      signal: controller.signal,
    });

    // MockLanguageModelV2 自带调用录音：doGenerateCalls[0] 就是第一次 callOptions
    expect(model.doGenerateCalls.length).toBe(1);
    expect(model.doGenerateCalls[0]?.abortSignal).toBe(controller.signal);
  });

  it("预中止：signal 已 aborted → 首次模型调用前就退出，doGenerate 零调用", async () => {
    const controller = new AbortController();
    controller.abort(); // 客户端在循环开始前就已断开
    const model = new MockLanguageModelV2({
      doGenerate: async () => textResponse("不该被生成"),
    });

    // 引擎自己的前置检查在 generateText 之前拦截——不依赖 SDK 对已中止信号
    // 的处理时机，行为完全确定
    await expect(
      runToolLoop({
        model,
        messages: [{ role: "user", content: "你好" }],
        tools: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(TOOL_LOOP_ABORTED);
    expect(model.doGenerateCalls.length).toBe(0); // 一个 token 都没烧
  });

  it("步间中止：工具步回灌后 abort → 不再发起第二次模型调用", async () => {
    const controller = new AbortController();
    let doGenerateCount = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        doGenerateCount += 1;
        return doGenerateCount === 1
          ? toolCallResponse("echo", { message: "第一步" }) // 第一步：要工具
          : textResponse("第二步的答案不该被生成");
      },
    });

    await expect(
      runToolLoop({
        model,
        messages: [{ role: "user", content: "查一下" }],
        tools: echoTools(),
        maxSteps: 5,
        signal: controller.signal,
        onStep: () => controller.abort(), // 第一步工具执行完、下一轮模型调用前断开
      }),
    ).rejects.toThrow(TOOL_LOOP_ABORTED);

    expect(doGenerateCount).toBe(1); // 第二次模型调用没有发生
  });

  it("默认回归：不传 signal → 多步循环行为与旧版完全一致", async () => {
    let doGenerateCount = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        doGenerateCount += 1;
        return doGenerateCount === 1
          ? toolCallResponse("echo", { message: "第一步" })
          : textResponse("两步完成");
      },
    });

    const result = await runToolLoop({
      model,
      messages: [{ role: "user", content: "查一下" }],
      tools: echoTools(),
      maxSteps: 5,
      // 刻意不传 signal：undefined 是既有调用方（CLI / 评测）的路径
    });

    expect(result.text).toBe("两步完成");
    expect(result.steps).toBe(2);
    expect(doGenerateCount).toBe(2);
    expect(model.doGenerateCalls[0]?.abortSignal).toBeUndefined(); // SDK 默认值原样
  });

  it("错误消息口径：导出的 TOOL_LOOP_ABORTED 常量与抛出的错误一致", async () => {
    expect(TOOL_LOOP_ABORTED).toContain("中止");
    const controller = new AbortController();
    controller.abort();
    const model = new MockLanguageModelV2({
      doGenerate: async () => textResponse("x"),
    });
    await expect(
      runToolLoop({ model, messages: [{ role: "user", content: "hi" }], tools: {}, signal: controller.signal }),
    ).rejects.toThrow(TOOL_LOOP_ABORTED);
  });
});

describe("runToolLoop 的步间文本（Thought 管道）", () => {
  /** 一轮「文本 + 工具调用」混合响应：模型先说一句再调工具（部分模型的行为） */
  function mixedResponse(text: string, toolName: string, input: Record<string, unknown>): ScriptedResponse {
    return {
      content: [
        { type: "text" as const, text },
        {
          type: "tool-call" as const,
          toolCallId: `text-spec-call-${Math.random().toString(36).slice(2, 8)}`,
          toolName,
          input: JSON.stringify(input),
        },
      ],
      finishReason: "tool-calls",
      usage: ZERO_USAGE,
      warnings: [],
    };
  }

  it("模型伴随工具调用的文本 → onStep 事件原样携带（text 字段）", async () => {
    let call = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        call += 1;
        // 第一轮：文本 + 工具调用混合（模型先说一句再动手）；第二轮：正常收尾
        return call === 1
          ? mixedResponse("我先查一下订单状态。", "echo", { message: "A-1024" })
          : textResponse("最终回答：订单已发货。");
      },
    });
    const events: ToolLoopStepEvent[] = [];

    const result = await runToolLoop({
      model,
      messages: [{ role: "user", content: "查订单" }],
      tools: echoTools(),
      maxSteps: 2,
      onStep: (event) => events.push(event),
    });

    expect(events.length).toBe(1);
    expect(events[0]?.text).toBe("我先查一下订单状态。"); // Thought 管道有真数据
    expect(events[0]?.toolCall.toolName).toBe("echo"); // 其余字段不受影响
    expect(result.text).toContain("最终回答"); // 循环正常出口不受影响
  });

  it("无伴随文本的工具步 → text 为 undefined（诚实空，不造模板话）", async () => {
    let call = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        call += 1;
        // 第一轮：纯工具调用、无伴随文本（function-calling 模型常态）；第二轮：收尾
        return call === 1 ? toolCallResponse("echo", { message: "第一步" }) : textResponse("最终回答。");
      },
    });
    const events: ToolLoopStepEvent[] = [];

    await runToolLoop({
      model,
      messages: [{ role: "user", content: "你好" }],
      tools: echoTools(),
      maxSteps: 2,
      onStep: (event) => events.push(event),
    });

    expect(events.length).toBe(1);
    expect(events[0]?.text).toBeUndefined(); // function-calling 模型的常态：无伴随文本
  });
});

describe("runToolLoop 的入参校验（zod refine 在手写循环内生效）", () => {
  /** 带时间窗口 refine 的月份工具（镜像 ops 的 dateTimeField 设计：对象入参 + 字段级校验） */
  function monthTools() {
    return {
      order_statistics: tool({
        description: "查询某月订单统计",
        inputSchema: z.object({
          dateTime: z
            .string()
            .regex(/^\d{4}-\d{2}$/, "月份格式必须是 yyyy-MM")
            .refine(inMonthWindow, {
              message: "月份超出合理范围——用户只说月份未说年份时，按当前年份重试",
            })
            .describe("统计月份 yyyy-MM"),
        }),
        execute: async ({ dateTime }) => ({ month: dateTime, orderNum: 7 }),
      }),
    };
  }

  const inMonthWindow = (dateTime: string): boolean => {
    const m = /^(\d{4})-(\d{2})$/.exec(dateTime);
    if (m === null) return false;
    const t = new Date(Number(m[1]), Number(m[2]) - 1, 1);
    const now = new Date();
    return (
      t >= new Date(now.getFullYear(), now.getMonth() - 24, 1) &&
      t <= new Date(now.getFullYear(), now.getMonth() + 2, 1)
    );
  };

  /** 工具调用轮：指定月份的 order_statistics 调用 */
  function statCall(dateTime: string): ScriptedResponse {
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `val-spec-${Math.random().toString(36).slice(2, 8)}`,
          toolName: "order_statistics",
          input: JSON.stringify({ dateTime }),
        },
      ],
      finishReason: "tool-calls",
      usage: ZERO_USAGE,
      warnings: [],
    };
  }

  it("越界年份（2022-09）→ 校验失败 errorOutput 回灌，不执行工具", async () => {
    let call = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        call += 1;
        return call === 1 ? statCall("2022-09") : textResponse("最终回答。");
      },
    });
    const steps: ToolLoopStepEvent[] = [];

    await runToolLoop({
      model,
      messages: [{ role: "user", content: "查去年9月的订单" }],
      tools: monthTools(),
      maxSteps: 3,
      onStep: (event) => steps.push(event),
    });

    expect(steps.length).toBe(1);
    expect(steps[0]?.output).toMatchObject({ error: expect.stringContaining("入参未通过校验") });
  });

  it("模型自我修正：越界被拒后按提示改用窗口内年份 → 工具真实执行", async () => {
    let call = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        call += 1;
        // 第一轮幻觉 2022-09（被 refine 拒）→ 第二轮「按当前年份重试」改用 2026-09 → 第三轮收尾
        return call === 1 ? statCall("2022-09") : call === 2 ? statCall("2026-09") : textResponse("已查到。");
      },
    });
    const steps: ToolLoopStepEvent[] = [];

    const result = await runToolLoop({
      model,
      messages: [{ role: "user", content: "查今年9月的订单" }],
      tools: monthTools(),
      maxSteps: 4,
      onStep: (event) => steps.push(event),
    });

    expect(steps.length).toBe(2);
    expect(steps[0]?.output).toMatchObject({ error: expect.stringContaining("入参未通过校验") }); // 越界被拒
    expect(steps[1]?.output).toMatchObject({ month: "2026-09", orderNum: 7 }); // 修正后真实执行
    expect(result.text).toContain("已查到");
  });
});
