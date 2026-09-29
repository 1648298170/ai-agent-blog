// service/supervisor.ts —— Supervisor 路由：硬规则优先于模型（教程 products/service.md）
// 自 apps/service/supervisor.ts 上移进引擎包：CLI（service REPL）与 HTTP API（/api/service）
// 共用这一套路由逻辑，禁止 app 之间互相 import。
// 「连续两轮没解决」是计数、「明确要求」是关键词：代码数得比模型准、零成本零延迟、
// 行为完全可测，必须排在任何 LLM 调用前面——这类必须转的场景，容不得模型偶尔判漏一次。
// 模型只兜剩下的模糊地带：三分类 JSON（generateText + 严格格式指令 + 宽松解析，网关无关）。
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { RouteDecision, RouteTarget, WorkerRoute } from "@agent-app/shared";
import { extractJson } from "../json-utils.js";
import { getModel } from "../llm.js";
import type { ChatTurn } from "../memory/types.js";
import { trace } from "../trace.js";

// 路由类型契约（WorkerRoute / RouteTarget / RouteDecision）已上移 @agent-app/shared
// （CLI 与 HTTP API 的响应契约同源）；本模块按契约再出口，包内外既有引用路径不变。
export type { RouteDecision, RouteTarget, WorkerRoute };

/** 硬规则判定要看的会话状态（纯数据，可离线单测） */
export interface SupervisorState {
  /** 用户最新一条消息原文 */
  lastUserMessage: string;
  /** 连续未解决轮数：用户连续追问「不是这个 / 到底怎么办」的计数，由 CLI 每轮维护 */
  unresolvedRounds: number;
}

/** 硬规则 1：用户明确要求转人工（service.md：这三个字出现之前，用户通常已经忍了一阵） */
export const HUMAN_REQUEST_KEYWORDS = ["转人工", "找真人", "换人工", "人工客服", "换个人"];

/** 硬规则 2：高危业务白名单（退款争议、投诉、法律、媒体：答错一个字的代价远高于转一百单人工） */
export const HIGH_RISK_KEYWORDS = ["退款争议", "投诉", "起诉", "律师", "法院", "媒体"];

/** 追问未解决信号：命中说明 AI 在原地打转（service.md 规则 3 的计数原料，纯函数判定） */
export const UNRESOLVED_SIGNALS = [
  "不是这个",
  "答非所问",
  "没解决",
  "没帮我",
  "到底",
  "还是不行",
  "你没听懂",
  "我问的",
];

/** 纯函数：消息里命中任一关键词则返回该关键词，未命中返回 null */
export function matchAnyKeyword(message: string, keywords: string[]): string | null {
  return keywords.find((kw) => message.includes(kw)) ?? null;
}

/** 纯函数：这条消息算不算一次「追问未解决」（CLI 每轮调它维护 unresolvedRounds 计数） */
export function isUnresolvedSignal(message: string): boolean {
  return matchAnyKeyword(message, UNRESOLVED_SIGNALS) !== null;
}

/**
 * 硬规则判定：纯函数、零 LLM 调用、可离线单测。
 * 命中任一条直接转人工并给出 reason；返回 null 表示全不命中，才轮到模型分类。
 * 优先级：未解决计数 > 明确要求 > 高危白名单（最需要兜底的排最前）。
 */
export function checkHardRules(state: SupervisorState): RouteDecision | null {
  if (state.unresolvedRounds >= 2) {
    return {
      target: "human",
      reason: `连续 ${state.unresolvedRounds} 轮未解决，AI 已在原地打转`,
    };
  }
  const request = matchAnyKeyword(state.lastUserMessage, HUMAN_REQUEST_KEYWORDS);
  if (request !== null) {
    return { target: "human", reason: `用户明确要求转人工（关键词「${request}」）` };
  }
  const risk = matchAnyKeyword(state.lastUserMessage, HIGH_RISK_KEYWORDS);
  if (risk !== null) {
    return { target: "human", reason: `命中高危业务白名单（关键词「${risk}」），必须人工处理` };
  }
  return null;
}

/** 模型分类的输出 schema：三选一的选择题，不是问答题（能枚举就硬，枚举不了再软） */
const routeSchema = z.object({
  route: z.enum(["order", "refund", "knowledge"]).describe(
    "order=订单/物流/发货查询；refund=退款退货售后；knowledge=制度政策等知识库问答",
  ),
  reason: z.string().describe("判定依据，一句话"),
});

const ROUTER_PROMPT = [
  "你是客服路由员。根据最近对话判断用户当前问题该交给哪个工人：",
  "- order：订单状态、物流、发货查询",
  "- refund：退款、退货、售后处理",
  "- knowledge：公司制度、政策、常见问题（知识库问答）",
  "只依据对话内容分类，不猜测对话没提到的业务。用中文写 reason。",
  "", // 以下为输出格式硬约定：轻薄模型不吃 response_format，格式必须写进提示词
  '只输出一个 JSON 对象，禁止输出解释、markdown 围栏或任何其他文字。格式：',
  '{"route":"order","reason":"判定依据一句话"}',
  'route 只能取 "order" / "refund" / "knowledge" 之一。',
].join("\n");

/** ChatTurn 窗口 → ModelMessage（分类要看上下文，否则追问会分错类） */
function toModelMessages(window: ChatTurn[]): ModelMessage[] {
  return window.map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * 模型兜底分类：generateText + 严格 JSON 指令 + 宽松解析 + zod 校验（网关无关，
 * 不依赖 response_format——glm-4-flash 等会静默无视它）。解析不合规自动重试一次，
 * 两次仍失败才抛错（上层降级转人工）。只应在 checkHardRules 返回 null 之后调用——
 * 让模型做模型擅长的事，别让它替你数数。
 */
export async function classifyWithLlm(history: ChatTurn[]): Promise<RouteDecision> {
  const baseMessages = toModelMessages(history.slice(-10)); // 最近 10 轮够分类用，省 token
  const system = ROUTER_PROMPT;
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    const effectiveSystem =
      attempt === 1
        ? system
        : `${system}\n\n重要：你上一次的回复不是合法 JSON。现在只输出 JSON 对象本身，不要任何其他文字。`;
    const { text } = await generateText({ model: getModel(), system: effectiveSystem, messages: baseMessages });
    try {
      const parsed = routeSchema.parse(extractJson(text));
      if (attempt > 1) trace("🧭", "路由 → 重试后输出合规");
      return { target: parsed.route, reason: parsed.reason };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      trace("🧭", `路由 → 第 ${attempt} 次分类输出不合规：${lastError.slice(0, 80)}`);
    }
  }
  throw new Error(`模型三分类连续两次未按 JSON 约定输出：${lastError}`);
}

/** Supervisor 总入口：硬规则优先，全不命中才问模型（对外的唯一约定） */
export async function supervise(state: SupervisorState, history: ChatTurn[]): Promise<RouteDecision> {
  const hard = checkHardRules(state);
  if (hard !== null) {
    trace("🧭", `路由 → 硬规则命中（不问模型）：${hard.reason} ⇒ ${hard.target}`);
    return hard;
  }
  trace("🧭", "路由 → 硬规则全不命中，交给模型三分类…");
  const decision = await classifyWithLlm(history);
  trace("🧭", `路由 → 模型分类：${decision.target}（${decision.reason}）`);
  return decision;
}
