// @agent-app/shared —— 跨端共享契约（纯类型包，无任何运行时逻辑）
// 定义 HTTP API、CLI 与（未来的）web 前端共同消费的事件与数据形状：
// 引擎（@agent-app/engine）与各端都从这里拿类型，一份契约多处消费。
// 本包被消费的方式见 shared/README.md（tsc 消费走 dist/*.d.ts，因此带 build 脚本）。

/** SSE 流式对话事件：session → step*（工具步）→ token*（答案分片）→ done；任一环节出错转 error。
 * 事件名与负载和 apps/api 的 GET /api/chat/stream 线上格式逐字段一致（week20 BFF 契约）；
 * 未来 web 前端（apps/web）的事件面板 / useChat 适配层直接消费本类型。
 */
export type ChatStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "step"; step: number; toolCall: { toolName: string; input: unknown }; output: unknown }
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
