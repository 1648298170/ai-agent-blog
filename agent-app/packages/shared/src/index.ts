// @agent-app/shared —— 跨端共享契约（纯类型包，无任何运行时逻辑）
// 定义 HTTP API、CLI 与（未来的）web 前端共同消费的事件与数据形状：
// 引擎（@agent-app/engine）与各端都从这里拿类型，一份契约多处消费。
// 本包被消费的方式见 shared/README.md（tsc 消费走 dist/*.d.ts，因此带 build 脚本）。

/** SSE 流式对话事件：session → step*（工具步）→ token*（答案分片）→ done；任一环节出错转 error。
 * 事件名与负载和 apps/api 的 GET /api/chat/stream 线上格式逐字段一致（week20 BFF 契约）；
 * 未来 web 前端（apps/web）的事件面板 / useChat 适配层直接消费本类型。
 * week18 Day 6 审批增量：高危工具（AGENT_CONFIRM_TOOLS 名单）执行前，会在它的 step
 * 事件之前插入 approval 事件（sessionId + approvalId + 工具名 + 入参）——前端渲染审批卡，
 * 用户经 POST /api/chat/approve 裁决；超时未裁决由 BFF 自动拒绝（不发额外事件）。
 */
export type ChatStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "step"; step: number; toolCall: { toolName: string; input: unknown }; output: unknown; text?: string }
  | { type: "approval"; approvalId: string; sessionId: string; toolName: string; input: unknown }
  | { type: "token"; text: string }
  | { type: "done" }
  | { type: "error"; message: string; hint?: string };

/** 全局异常过滤器的统一错误响应体（apps/api 的 AllExceptionsFilter 产出） */
export interface ApiErrorBody {
  statusCode: number;
  message: string;
  hint?: string;
}

/** 业务工人路由：三个工人（Supervisor 星型图的分支） */
export type WorkerRoute = "order" | "refund" | "knowledge";

/** 路由出口：工人 + 转人工。human 是业务流程的正常一步（一个特殊 Worker），不是异常 */
export type RouteTarget = WorkerRoute | "human";

/** 路由判定：target + reason。reason 转人工时写进工单，是接手人的第一眼信息 */
export interface RouteDecision {
  target: RouteTarget;
  reason: string;
}

/** 转人工上下文包：工单号 + 原因 + 用户摘要 + 最近对话 + 时间（接手人的第一眼信息） */
export interface ServiceHandoffPack {
  ticketId: string;
  reason: string;
  userSummary: string;
  recentTranscript: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// week20 web 前端（apps/web）消费的 HTTP 响应契约（纯类型增量，不改任何已有类型）
// 形状与 apps/api 各控制器的实际返回逐字段一致（chat.controller / kb.service / service.dto）。
// week20 架构边界：前端只见契约不见引擎，因此这些类型放 shared，
// 而不是让 web 依赖 @agent-app/engine 去拿 IngestResult / DocumentSummary。
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/chat 响应（非流式；web 主要消费 GET /api/chat/stream 的 SSE） */
export interface ChatResponse {
  sessionId: string;
  reply: string;
}

/** POST /api/kb/ingest 响应：入库结果（与 engine/rag 的 IngestResult 同形） */
export interface KbIngestResult {
  /** 入库文件名（含扩展名） */
  fileName: string;
  /** 引用块里显示的标题（文件名去扩展名） */
  title: string;
  /** 文档 id：文件名 + 内容哈希前 8 位（同内容重传命中同 id，upsert 覆盖） */
  docId: string;
  /** 本次切块数 */
  chunks: number;
  /** 入库后知识库总块数 */
  total: number;
}

/** GET /api/kb/documents 列表项：一个 docId 一行的文档级摘要 */
export interface KbDocumentSummary {
  docId: string;
  title: string;
  /** 该文档被切成了多少块 */
  chunks: number;
}

/** 知识库问答的引用来源：编号 + 标题 + 余弦相似度（编号由后端分配，模型编不了出处） */
export interface KbCitation {
  no: number;
  title: string;
  score: number;
}

/** POST /api/kb/query 响应：degraded=true 表示 LLM 不可用，answer 为检索原文拼接 */
export interface KbQueryAnswer {
  answer: string;
  citations: KbCitation[];
  degraded: boolean;
  /** degraded 时的配置指引 */
  hint?: string;
}

/** DELETE /api/kb/documents/:docId 响应：返回被删除的 docId */
export interface KbDeleteResponse {
  deleted: string;
}

/** POST /api/service/message 响应：route=human 时附带转人工上下文包（与 api 的 ServiceReply 同形） */
export interface ServiceMessageResponse {
  sessionId: string;
  /** order / refund / knowledge / human（human 是业务流程的正常一步，不是异常） */
  route: RouteTarget;
  /** 路由判定依据（转人工时进工单，是接手人的第一眼信息） */
  reason: string;
  reply: string;
  handoff?: ServiceHandoffPack;
}

// ─────────────────────────────────────────────────────────────────────────────
// 会话记录（conversation-history）契约：GET /api/chat/sessions 两个端点的响应形状。
// 与 @agent-app/engine 的 SessionSummary / ChatTurn 逐字段同形——前端只见契约
// 不见引擎，因此这里独立声明一份（web 不依赖 engine，架构边界不变）。
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/chat/sessions 列表项：一个会话一行的摘要 */
export interface SessionSummary {
  sessionId: string;
  /** 压缩后的当前轮数（含合成摘要轮） */
  turns: number;
  /** 最后活跃时间（ISO 8601），列表按它降序 */
  updatedAt: string;
}

/** 会话历史里的单轮对话（与 engine 的 ChatTurn 同形；system 为压缩产生的摘要轮） */
export interface SessionTurn {
  role: "user" | "assistant" | "system";
  content: string;
  /** 该轮 assistant 回答触发的工具名（可选） */
  toolName?: string;
}

/** GET /api/chat/sessions/:sessionId 响应：全量轮次（压缩后含摘要轮）。
 *  会话不存在或已过期时 turns 为空数组（200，不报 404）。 */
export interface SessionHistoryResponse {
  sessionId: string;
  turns: SessionTurn[];
}

// ─────────────────────────────────────────────────────────────────────────────
// week18 Day 6 工具审批（human-in-the-loop）契约：POST /api/chat/approve 的请求/响应形状。
// 高危工具（BFF 侧 AGENT_CONFIRM_TOOLS 名单）执行前，流里先来 approval 事件；
// 前端把事件带回的 sessionId + approvalId 连同用户裁决 POST 回来，BFF 唤醒挂起的工具调用。
// 校验用的 DTO 类（class-validator）定义在 apps/api/src/chat/dto.ts——这里只放线上的纯类型。
// ─────────────────────────────────────────────────────────────────────────────

/** POST /api/chat/approve 请求体：approval 事件带回的会话/审批 id + 用户裁决 */
export interface ApproveChatRequest {
  /** 发起审批的会话 id（approval 事件的 sessionId 字段） */
  sessionId: string;
  /** 待审批的工具调用 id（approval 事件的 approvalId 字段，UUID） */
  approvalId: string;
  /** true=允许执行该工具调用；false=拒绝（工具收到结构化拒绝值，模型可见可礼貌收尾） */
  approved: boolean;
}

/** POST /api/chat/approve 响应：回显裁决（approvalId + approved） */
export interface ApproveChatResponse {
  approvalId: string;
  approved: boolean;
}
