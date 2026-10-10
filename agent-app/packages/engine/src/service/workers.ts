// service/workers.ts —— 三个业务工人：order / refund / knowledge（service.md Supervisor 星型）
// 自 apps/service/workers.ts 上移进引擎包：CLI 与 HTTP API 共用。
// 每个工人 = 一份职责提示词 + 一张最小工具表 + runToolLoop（手写工具循环，引擎第 1 阶段已备好）。
// 工具表按职责裁剪：order 只发查订单的锤子，refund 只发建工单的锤子，
// knowledge 只发知识库检索——职责之外的锤子不发给它，误伤面从工具表上就掐掉。
import type { ModelMessage } from "ai";
import { DEFAULT_MAX_STEPS, runToolLoop } from "../agent-loop.js";
import type { ToolLoopStepEvent } from "../agent-loop.js";
import type { AgentToolSet } from "../types.js";
import { createModel } from "../llm.js";
import type { ChatTurn } from "../memory/types.js";
import { createTicket, getOrderStatus } from "../tools/demo-tools.js";
import { searchKnowledgeBase } from "../tools/kb-search.js";

export type WorkerName = "order" | "refund" | "knowledge";

/** 工人入参：最近会话窗口 + 本轮用户消息（窗口最后一条就是本轮，拼消息时会去掉重组） */
export interface WorkerInput {
  history: ChatTurn[];
  message: string;
}

/** 职责提示词：边界 + 拒答出口（接不住就说转人工/建工单，别硬编） */
const WORKER_PROMPTS: Record<WorkerName, string> = {
  order:
    "你是订单客服，只处理订单状态、物流、发货查询。用中文简洁回答。" +
    "查订单先用一句话说明想查什么，再调 getOrderStatus 工具；" +
    "查不到时如实告知并建议核对订单号，禁止编造订单信息。",
  refund:
    "你是售后客服，只处理退款、退货、售后问题。用中文简洁回答。" +
    "需要人工跟进的处理（如退款审核）先用一句话说明，再调 createTicket 建工单并告知工单号；" +
    "涉及退款争议无法判定时，建议用户转人工，不要自行承诺。",
  knowledge:
    "你是知识客服，回答公司制度、政策、常见问题。用中文回答。" +
    "回答前先用 searchKnowledgeBase 检索知识库，只依据检索结果作答，" +
    "引用哪块就在句末标注对应编号，如 [1][2]；检索不到相关内容就老实说不知道，禁止编造。",
};

/** 各工人的最小工具表 */
const WORKER_TOOLS: Record<WorkerName, AgentToolSet> = {
  order: { getOrderStatus },
  refund: { createTicket },
  knowledge: { searchKnowledgeBase },
};

/** 拼工人消息：历史窗口去掉最后一条（本轮输入，单独拼在末尾），并截最近 20 轮防上下文爆炸 */
function buildMessages(input: WorkerInput): ModelMessage[] {
  const previous = input.history.slice(0, -1).slice(-20);
  const messages: ModelMessage[] = previous.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
  messages.push({ role: "user", content: input.message });
  return messages;
}

/** 跑一个工人：职责提示词 + 最小工具表 → 工具循环 → 回复文本 */
export async function runWorker(name: WorkerName, input: WorkerInput): Promise<string> {
  const result = await runToolLoop({
    model: createModel(),
    system: WORKER_PROMPTS[name],
    messages: buildMessages(input),
    tools: WORKER_TOOLS[name],
    maxSteps: DEFAULT_MAX_STEPS,
  });
  return result.text;
}

/** 流式路径的可选钩子：onStep 逐工具步外发、signal 客户端断开即中止（语义同 runToolLoop） */
export interface WorkerStreamingOptions {
  /** 每次工具执行并回灌后同步调用（API 的 SSE 端点转成 step 事件） */
  onStep?: (event: ToolLoopStepEvent) => void;
  /** 中止信号：透传给循环每一步的模型调用，断开后不再烧 token */
  signal?: AbortSignal;
}

/** 流式路径的产物：工具循环收尾后的完整消息历史（含全部工具往来，不含最终回复文本） */
export interface WorkerStreamingResult {
  messages: ModelMessage[];
}

/**
 * 流式友好的工人路径（SSE 增量导出，既有 runWorker 一行未动、POST /message 字节不变）：
 * 与 runWorker 同一套提示词 / 最小工具表 / maxSteps，只多两件事——
 * ① onStep 把工具循环每一步（工具调用 + 输出）实时交给调用方（API 转成 step SSE 事件）；
 * ② 返回循环后的完整消息历史，最终答案文本弃用（非流式产物）——调用方拿工人系统提示词
 *    （workerSystemPrompt）+ 这些消息再 streamText 一次，换逐 token 可视的收尾流
 *    （chat 线 week20 BFF 的同一形态：多一次生成调用，换 SSE 的逐段输出）。
 */
export async function runWorkerStreaming(
  name: WorkerName,
  input: WorkerInput,
  options?: WorkerStreamingOptions,
): Promise<WorkerStreamingResult> {
  const result = await runToolLoop({
    model: createModel(),
    system: WORKER_PROMPTS[name],
    messages: buildMessages(input),
    tools: WORKER_TOOLS[name],
    maxSteps: DEFAULT_MAX_STEPS,
    onStep: options?.onStep,
    signal: options?.signal,
  });
  return { messages: result.messages };
}

/** 工人职责提示词的只读出口：流式收尾的 streamText 需要与循环内同一份人格口径 */
export function workerSystemPrompt(name: WorkerName): string {
  return WORKER_PROMPTS[name];
}
