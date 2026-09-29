// service/handoff.ts —— 转人工流程：建工单 + HandoffPack 上下文包（教程 products/service.md）
// 自 apps/service/handoff.ts 上移进引擎包：CLI 与 HTTP API 共用。
// 上下文包是体验的分水岭：最毁体验的一幕是转过去后人工客服第一句「请问有什么可以帮您」。
// 包里四样：工单号、判定原因、用户摘要、最近对话——接手人不用用户复述即可上手。
// 摘要提示词必须带「禁止添加未出现的信息」：摘要幻觉出的「用户已确认收货」会把接手人带进沟里。
// 离线优先：摘要模型挂了降级为最近用户消息拼接，工单是 mock 实现，无网也能完成转人工。
import { generateText } from "ai";
import type { ServiceHandoffPack } from "@agent-app/shared";
import { getModel } from "../llm.js";
import type { ChatTurn } from "../memory/types.js";
import { createTicket } from "../tools/demo-tools.js";

// ServiceHandoffPack（转人工上下文包契约）定义在 @agent-app/shared，这里再出口保持既有引用路径
export type { ServiceHandoffPack };

/** 会话窗口 → 逐行文稿（用户/客服 对话记录，只保留最近 limit 轮） */
export function formatTranscript(turns: ChatTurn[], limit = 10): string {
  return turns
    .slice(-limit)
    .map((turn) => `${turn.role === "user" ? "用户" : "客服"}：${turn.content}`)
    .join("\n");
}

/** 离线兜底摘要：直接拼接最近几条用户消息——不猜、不编，只交出「可信的已知」 */
function fallbackSummary(turns: ChatTurn[]): string {
  const userLines = turns
    .filter((t) => t.role === "user")
    .slice(-3)
    .map((t) => t.content);
  if (userLines.length === 0) return "（会话内暂无用户提问）";
  return `用户最近的问题：${userLines.join("；")}`;
}

const PACK_PROMPT =
  "你是客服会话摘要员。只根据给出的对话内容写两三句中文摘要：用户遇到了什么问题、AI 已经尝试了什么。" +
  "禁止添加对话中没有出现的信息——摘要里一条编造就足以毁掉接手人的全部信任。";

/**
 * 调 createTicket 的 execute 建工单（mock 实现，离线可用），返回工单号。
 * ToolExecuteFunction 的返回类型带流式（AsyncIterable）分支，这里一次性收取。
 */
async function createHandoffTicket(subject: string, description: string): Promise<string> {
  const execute = createTicket.execute;
  if (execute === undefined) {
    throw new Error("内部错误：createTicket 工具未挂 execute，无法创建工单");
  }
  const outcome = await execute(
    { subject, description },
    { toolCallId: "handoff-create-ticket", messages: [] },
  );
  if (Symbol.asyncIterator in outcome) {
    let last: { ticketId: string } | undefined; // 流式分支：逐项收取最后一个结果
    for await (const item of outcome) {
      last = item;
    }
    if (last === undefined) throw new Error("createTicket 未产出工单");
    return last.ticketId;
  }
  return outcome.ticketId;
}

/**
 * 组装转人工上下文包并建工单。
 * 顺序：拼文稿 → LLM 摘要（失败降级原文拼接）→ createTicket 建工单 → 打包。
 */
export async function buildHandoffPack(input: {
  reason: string;
  turns: ChatTurn[];
}): Promise<ServiceHandoffPack> {
  const transcript = formatTranscript(input.turns);

  let userSummary: string;
  try {
    const { text } = await generateText({
      model: getModel(),
      system: PACK_PROMPT,
      prompt: transcript || "（空会话）",
    });
    userSummary = text.trim() || fallbackSummary(input.turns);
  } catch {
    userSummary = fallbackSummary(input.turns); // 摘要模型挂了也要转得出去：降级为原文拼接
  }

  // 建工单（mock 实现，离线可用）：判定原因进 subject，接手人扫一眼就知道为什么转过来
  const ticketId = await createHandoffTicket(`转人工：${input.reason}`, userSummary);

  return {
    ticketId,
    reason: input.reason,
    userSummary,
    recentTranscript: transcript,
    createdAt: new Date().toISOString(),
  };
}

/** HandoffPack → 控制台打印块（内部记录 / 演示用；接真实工单系统时这份就是 payload） */
export function formatHandoffPack(pack: ServiceHandoffPack): string {
  return [
    "── 转人工工单 ──────────────────",
    `工单号：${pack.ticketId}`,
    `原因：${pack.reason}`,
    `用户摘要：${pack.userSummary}`,
    `创建时间：${pack.createdAt}`,
    "最近对话：",
    ...pack.recentTranscript.split("\n").map((line) => `  ${line}`),
    "──────────────────────────────",
  ].join("\n");
}

/** 给用户的转人工告知：用户要知道被转了、工单号是多少、无需重复描述（service.md 完成线） */
export function handoffReply(pack: ServiceHandoffPack): string {
  return (
    `已为您转接人工客服，工单号 ${pack.ticketId}。` +
    "您的问题和已尝试的方案已同步给客服，无需重复描述。"
  );
}
