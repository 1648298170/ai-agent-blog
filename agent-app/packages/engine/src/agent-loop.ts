// agent-loop.ts —— 手写多步工具循环：《week11 主线补篇 · Agent 循环 TS 深入》的逐行对应
//
// SDK 替你转的三件事这里亲笔写（对应教程的 ①②③）：
//   ① 入账：result.response.messages 是这轮 assistant 侧全部消息（含调用意图），
//      原样 push 进历史，模型下一轮才记得自己要过什么
//   ② 调度：按 toolName 从工具表里找到实现，执行它的 execute
//   ③ 回灌：结果拼成 role: "tool" 消息塞回历史，回到循环头再问一次模型
//
// 版本适配说明（ai 5.0.266 实测，见 selftest 的工具循环用例）：
// - 直接把带 execute 的工具喂给 generateText，SDK 会替你执行并把 tool-result
//   合进 response.messages，与手写调度重复入账。所以给模型的是 schema-only 视图，
//   执行权握在自己手里——这正是教程手写版「工具只写 schema 不写 execute」的等价实现。
// - tool-result 消息的 output 字段收结构化形状（LanguageModelV2ToolResultOutput），
//   教程示例里的裸对象在这版类型收紧了：正常结果用 { type: "json" }，失败用 { type: "error-json" }。
import { generateText, tool as defineTool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import { preview, trace } from "./trace.js";

/** 手写循环的入参：model / messages / tools / maxSteps，maxSteps 对应 SDK 版的 stopWhen: isStepCount(n) */
export interface RunToolLoopOptions {
  model: LanguageModel;
  messages: ModelMessage[];
  tools: ToolSet;
  /** 可选 system 提示词：走 generateText 的 system 选项，不塞进 messages（SDK 推荐做法，防注入提示更稳） */
  system?: string;
  /** 步数上限（保险丝），默认 5 */
  maxSteps?: number;
  /**
   * 可选单步回调：每次工具执行并回灌后同步调用。
   * 纯观察性钩子——不传时行为与旧版完全一致（既有调用方零改动）。
   */
  onStep?: (event: ToolLoopStepEvent) => void;
  /**
   * 可选中止信号（生产缺陷修复：SSE 客户端断开后停止烧 token）。
   * API 层把客户端断开（response close）接到 AbortController 上、signal 传进来：
   * - 透传给每一步 generateText 的 abortSignal（SDK 在模型调用层响应中止，
   *   正在进行的请求会以 AbortError 拒绝）；
   * - 每步工具执行回灌之后、发起下一次模型调用之前检查 aborted——客户端已经
   *   不在了，继续调模型纯粹是烧 token，直接抛「已中止」退出循环。
   * 不传（默认 undefined）时行为与旧版完全一致：abortSignal: undefined 是
   * generateText 的默认值，前置检查也被短路（?.）——既有调用方（CLI / 评测）
   * 零改动、零感知。
   */
  signal?: AbortSignal;
}

/** 中止时抛出的错误消息（导出常量：调用方/测试按它识别「循环因 abort 而退出」） */
export const TOOL_LOOP_ABORTED = "工具循环已中止：调用方在完成前 abort 了 signal";

/** 循环结果：最终回复文本 + 维护到底的完整消息历史 + 实际步数 */
export interface ToolLoopResult {
  text: string;
  messages: ModelMessage[];
  steps: number;
}

/**
 * 单步事件（可选回调 onStep 的载荷）：第几步、模型要调什么工具、本地执行拿到的输出。
 * HTTP API 的 SSE 流式端点把它原样转成 {type:"step"} 事件；审计日志同理。
 */
export interface ToolLoopStepEvent {
  step: number;
  toolCall: { toolName: string; input: unknown };
  output: unknown;
  /**
   * 模型本步伴随工具调用的文本（有些模型会在调工具前先"说"一句推理或说明）。
   * function-calling 模型（如 glm-4-flash）此字段常为 undefined——工具选择本身就是它的
   * "思考"。诚实 UI 原则：有就展示、没有就明说，绝不用模板话冒充模型推理。
   */
  text?: string;
}

/**
 * 给模型看的 schema-only 视图：只留 description 和 inputSchema，剥掉 execute。
 * 等价于教程手写循环里「工具不带 execute」的写法，但工具实现仍然集中放在 tools 表里。
 */
function toSchemaTools(tools: ToolSet): ToolSet {
  const schemaTools: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    schemaTools[name] = defineTool({
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return schemaTools;
}

/** 工具输出统一 JSON 序列化（LanguageModelV2ToolResultOutput 只收结构化形状） */
function jsonOutput(value: unknown) {
  return { type: "json", value: JSON.parse(JSON.stringify(value)) } as const;
}

/** 执行失败的输出走 error-json，模型能看出这是失败而不是业务数据 */
function errorOutput(value: unknown) {
  return { type: "error-json", value: JSON.parse(JSON.stringify(value)) } as const;
}

/**
 * 手写多步工具循环。不借助任何 Agent 框架：想给每步打日志、加审批、缓存中间结果，
 * 直接在本函数的对应行插入即可——这正是手写版存在的意义。
 */
export async function runToolLoop(options: RunToolLoopOptions): Promise<ToolLoopResult> {
  const { model, tools, system, maxSteps = 5, onStep, signal } = options;
  const schemaTools = toSchemaTools(tools);
  const messages: ModelMessage[] = [...options.messages]; // 复制一份，不动调用方的数组

  for (let step = 1; step <= maxSteps; step++) {
    // 调度下一次模型调用之前先看信号：客户端已断开就不再发起（烧 token 没有意义）。
    // 抛错而不是返回半截结果——与「请求进行中被 abort」时 generateText 的拒绝
    // 语义保持一致，调用方用同一条 catch 路径处理两种中止时机。
    if (signal?.aborted) {
      throw new Error(TOOL_LOOP_ABORTED);
    }
    trace("▶", `思考 step ${step} → 调用模型（上下文 ${messages.length} 条消息，可用工具 ${Object.keys(tools).length} 个）`);
    const result = await generateText({ model, messages, tools: schemaTools, system, abortSignal: signal });

    if (result.toolCalls.length === 0) {
      trace("◆", `完成 → 模型给出最终回答（${result.text.length} 字，共 ${step} 步）`);
      return { text: result.text, messages, steps: step }; // 模型开口了，出口
    }

    messages.push(...result.response.messages); // ① 入账：模型的调用意图
    // 步间文本快照：模型伴随工具调用"说"的那句话（有则随 onStep 广播，无则 undefined）
    const stepText = result.text.trim();
    trace("⚙", `行动 step ${step} → 要调 ${result.toolCalls.length} 个工具：` +
      result.toolCalls.map((c) => `${c.toolName}(${preview(c.input, 120)})`).join("、"));

    for (const call of result.toolCalls) {
      const tool = tools[call.toolName];
      // 显式联合类型 + 兜底初值：新增入参校验分支后，嵌套 try/catch + failed 旗标的
      // 控制流让 TS 的定赋值分析推不出「全路径已赋值」（TS2454）——兜底分支理论不可达
      //（下面每个路径都会覆盖 output），但它让类型系统满意且防御未来的漏网路径。
      let output: ReturnType<typeof jsonOutput> | ReturnType<typeof errorOutput> = errorOutput({
        error: `工具 ${call.toolName} 内部错误：输出未生成（理论不可达的兜底分支）`,
      });
      let failed = false;
      if (tool === undefined || tool.execute === undefined) {
        failed = true;
        output = errorOutput({ error: `未知工具或工具无实现：${call.toolName}` });
      } else {
        // ⓪ 入参校验：SDK 在自己执行工具时会按 schema 解析校验入参，手写循环同样要做——
        // 否则 zod 的 refine（如月份时间窗口）在这条路径上不会运行。
        // 校验失败的错误作为 tool-result 回灌给模型，模型可按提示修正参数重试。
        // 实测案例（2026-09）：用户说「9月份」未说年份，模型幻觉 dateTime=2022-09——
        // 月份窗口 refine 把它挡下，模型按提示改用当前年份重试。
        // 校验只对 zod schema 生效；jsonSchema 包装（MCP 外部工具）的入参校验交给上游。
        const schema = tool.inputSchema;
        if (schema instanceof z.ZodType) {
          const parsed = schema.safeParse(call.input);
          if (!parsed.success) {
            failed = true;
            const issues = parsed.error.issues.map((issue) => issue.message).join("；");
            output = errorOutput({
              error: `工具 ${call.toolName} 的入参未通过校验：${issues}。请修正参数后重新调用。`,
            });
          }
        }
        if (!failed) {
          try {
            // ② 调度：execute 就是普通函数；call.input 已由 SDK 按 schema 解析好
            output = jsonOutput(await tool.execute(call.input, {
              toolCallId: call.toolCallId,
              messages,
            }));
          } catch (err) {
            failed = true;
            output = errorOutput({
              error: `工具 ${call.toolName} 执行失败：${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }

      messages.push({
        // ③ 回灌：结果作为 tool 消息
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output,
          },
        ],
      });

      trace(failed ? "✗" : "✓", `观察 step ${step} → ${call.toolName} ${failed ? "失败" : "返回"}：${preview(output.value)}`);

      // 可选观察钩子：回灌落账后再广播，订阅方看到的一定是已提交的状态
      onStep?.({
        step,
        toolCall: { toolName: call.toolName, input: call.input },
        output: output.value,
        text: stepText || undefined, // 空串归一为 undefined：订阅方 "in text" 判断更省心
      });
    }
  }
  throw new Error(`步数用完（${maxSteps}），模型仍在要工具`);
}

/**
 * ToolLoopAgent 风格的类封装——教程里 SDK 版（stopWhen: isStepCount(5)）的对照物。
 * ai 5.0.266 尚未导出 ToolLoopAgent，这里用自己的 runToolLoop 实现同款接口，
 * 展示「循环就是全部逻辑」时如何收编成一个对象：消息历史由类内部维护，调用方只给 prompt 拿 text。
 */
export class ToolLoopAgent {
  constructor(
    private readonly options: { model: LanguageModel; tools: ToolSet; maxSteps?: number },
  ) {}

  /** 一轮生成：prompt 可以是单条字符串，也可以是现成的消息数组；system 单独走选项 */
  async generate(input: { prompt: string | ModelMessage[]; system?: string }): Promise<ToolLoopResult> {
    const base: ModelMessage[] =
      typeof input.prompt === "string" ? [{ role: "user", content: input.prompt }] : [...input.prompt];
    return runToolLoop({ ...this.options, messages: base, system: input.system });
  }
}
