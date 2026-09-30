// lib/api.ts —— BFF API 客户端：类型化 fetch 封装 + SSE 消费
// week20 架构边界：前端只见契约（@agent-app/shared 的纯类型），不依赖 @agent-app/engine；
// 前端零密钥——所有 LLM / embedding 调用都发生在 BFF（apps/api）侧。
import type {
  ApiErrorBody,
  ApproveChatRequest,
  ApproveChatResponse,
  ChatStreamEvent,
  KbDeleteResponse,
  KbDocumentSummary,
  KbIngestResult,
  KbQueryAnswer,
  ServiceMessageResponse,
  ServiceStreamEvent,
  SessionHistoryResponse,
  SessionSummary,
} from "@agent-app/shared";

/** BFF 地址：默认本机 3000，可用 NEXT_PUBLIC_API_BASE 覆盖（Next 构建期内联） */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3000";

/** 读取错误信息：优先取全局过滤器的统一错误体（中文 message），非 JSON 时走状态行兜底 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    if (typeof body.message === "string" && body.message !== "") return body.message;
  } catch {
    // 错误体不是 JSON（如网关 502 页面），落到状态行兜底
  }
  return `请求失败（HTTP ${res.status}）`;
}

/** 类型化 JSON fetch：非 2xx 时抛 API 返回的中文错误 message */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** GET /api/health → {"status":"ok"} */
export function checkHealth(): Promise<{ status: string }> {
  return fetchJson("/api/health");
}

/** GET /api/kb/documents → 文档清单（知识库管理页列表） */
export function listDocuments(): Promise<KbDocumentSummary[]> {
  return fetchJson("/api/kb/documents");
}

/** POST /api/kb/ingest —— multipart 字段名 file，支持 .txt / .md / .pdf */
export async function ingestDocument(file: File): Promise<KbIngestResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/kb/ingest`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as KbIngestResult;
}

/** DELETE /api/kb/documents/:docId → { deleted } */
export function deleteDocument(docId: string): Promise<KbDeleteResponse> {
  return fetchJson(`/api/kb/documents/${encodeURIComponent(docId)}`, { method: "DELETE" });
}

/** POST /api/kb/query → 带引用问答（degraded=true 时 answer 是检索原文拼接） */
export function queryKb(question: string, topK?: number): Promise<KbQueryAnswer> {
  return postJson("/api/kb/query", topK === undefined ? { question } : { question, topK });
}

/** POST /api/service/message → 智能客服（route=human 时附带 handoff 上下文包） */
export function sendServiceMessage(
  message: string,
  sessionId?: string,
): Promise<ServiceMessageResponse> {
  return postJson("/api/service/message", sessionId ? { message, sessionId } : { message });
}

/** GET /api/chat/sessions → 历史会话列表（按最近活跃降序） */
export function fetchSessions(): Promise<SessionSummary[]> {
  return fetchJson("/api/chat/sessions");
}

/**
 * POST /api/chat/approve —— 工具审批裁决（week18 Day 6）：approval SSE 事件带回的
 * sessionId + approvalId 连同用户裁决一起回传。审批已超时自动拒绝 / 未知 id / 会话
 * 不匹配时 API 返回 404 中文错误（readErrorMessage 抛出，调用方据此渲染「已过期」态）。
 */
export function approveChat(body: ApproveChatRequest): Promise<ApproveChatResponse> {
  return postJson("/api/chat/approve", body);
}

/** GET /api/chat/sessions/:sessionId → 该会话全量轮次（不存在/过期时 turns 为空数组） */
export function fetchSessionHistory(sessionId: string): Promise<SessionHistoryResponse> {
  return fetchJson(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
}

/** GET /api/service/sessions → 客服历史会话列表（仅 cs_ 会话，按最近活跃降序） */
export function fetchServiceSessions(): Promise<SessionSummary[]> {
  return fetchJson("/api/service/sessions");
}

/** GET /api/service/sessions/:sessionId → 该客服会话全量轮次（不存在/过期时 turns 为空数组） */
export function fetchServiceSessionHistory(sessionId: string): Promise<SessionHistoryResponse> {
  return fetchJson(`/api/service/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * 消费 GET /api/chat/stream 的 SSE —— fetch + ReadableStream 手解析，不用 EventSource：
 * EventSource 不便携带 sessionId 查询参数，也拿不到非 200 响应的错误体；
 * 手解析按空行（\n\n）切帧、取 data: 行 JSON，与 apps/api 控制器的
 * write(`data: ${json}\n\n`) 逐帧对应；事件类型即 @agent-app/shared 的 ChatStreamEvent。
 */
export async function streamChat(
  input: { message: string; sessionId?: string },
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const params = new URLSearchParams({ message: input.message });
  if (input.sessionId) params.set("sessionId", input.sessionId);

  const res = await fetch(`${API_BASE}/api/chat/stream?${params.toString()}`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  if (res.body === null) throw new Error("响应没有可读流（当前环境不支持流式读取）");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      emitFrame(buffer.slice(0, sep), onEvent);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode(); // flush 尾字节
  emitFrame(buffer, onEvent); // 流结束时可能还剩最后一帧没等到空行
}

/** 单帧 → 逐行取 data: 前缀 → JSON.parse → 事件回调（SSE 注释行与空行自动忽略） */
function emitFrame(frame: string, onEvent: (event: ChatStreamEvent) => void): void {
  for (const line of frame.split("\n")) {
    const normalized = line.replace(/\r$/, "");
    if (!normalized.startsWith("data:")) continue;
    const payload = normalized.slice("data:".length).trim();
    if (payload === "") continue;
    onEvent(JSON.parse(payload) as ChatStreamEvent);
  }
}

/**
 * 消费 GET /api/service/stream 的 SSE —— 与 streamChat 同一套 fetch + ReadableStream
 * 手解析（按空行切帧、取 data: 行 JSON），事件类型换成 ServiceStreamEvent：
 * session → route（路由判定先行）→ step*（工人工具步）→ token* → done；
 * 转人工路径多一个 handoff 工单包事件，降级路径 route 事件连发两次（以最后一次为准）。
 * signal 透传给 fetch：页面卸载/组件销毁时中止连接，服务端会随之停止生成。
 */
export async function streamServiceMessage(
  input: { message: string; sessionId?: string; signal?: AbortSignal },
  onEvent: (event: ServiceStreamEvent) => void,
): Promise<void> {
  const params = new URLSearchParams({ message: input.message });
  if (input.sessionId) params.set("sessionId", input.sessionId);

  const res = await fetch(`${API_BASE}/api/service/stream?${params.toString()}`, {
    headers: { Accept: "text/event-stream" },
    signal: input.signal,
  });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  if (res.body === null) throw new Error("响应没有可读流（当前环境不支持流式读取）");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      emitServiceFrame(buffer.slice(0, sep), onEvent);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf("\n\n");
    }
  }
  buffer += decoder.decode(); // flush 尾字节
  emitServiceFrame(buffer, onEvent); // 流结束时可能还剩最后一帧没等到空行
}

/** service 线的单帧解析（与 emitFrame 同规则；独立函数避免动既有 chat 解析的类型签名） */
function emitServiceFrame(frame: string, onEvent: (event: ServiceStreamEvent) => void): void {
  for (const line of frame.split("\n")) {
    const normalized = line.replace(/\r$/, "");
    if (!normalized.startsWith("data:")) continue;
    const payload = normalized.slice("data:".length).trim();
    if (payload === "") continue;
    onEvent(JSON.parse(payload) as ServiceStreamEvent);
  }
}
