// lib/chat-state.ts —— 智能对话页的状态机：ChatState + reducer + SSE 事件处理器映射表。
//
// 纯函数模块（无 "use client"、无 React 依赖）：「session → step → token → done 的
// 事件序列如何演变出界面状态」全部收敛在这里，事件顺序测试可以脱离组件直接断言
// （reducer(状态, 事件) → 新状态）。
// 副作用纪律：reducer 纯函数——localStorage 写入等副作用全部留在组件层（useEffect / 回调）。
import type { ChatStreamEvent, SessionTurn } from "@agent-app/shared";
import type { ApprovalRecord, ChatMessage } from "../components/MessageBubble";

/** 对话页的核心状态：气泡列表 + 当前会话 id（UI 面板开合等瞬态仍用 useState） */
export interface ChatState {
  messages: ChatMessage[];
  sessionId: string | null;
}

export const initialChatState: ChatState = { messages: [], sessionId: null };

/** 就地更新最后一条（正在流式生成的那条助手消息）的纯函数版 */
function patchLast(messages: ChatMessage[], fn: (msg: ChatMessage) => ChatMessage): ChatMessage[] {
  if (messages.length === 0) return messages;
  const next = [...messages];
  next[next.length - 1] = fn(next[next.length - 1]);
  return next;
}

/** SSE 六种事件的处理器映射表：键 = 事件类型，值 = 该事件如何演变状态（全部纯函数） */
const sseHandlers: {
  [K in ChatStreamEvent["type"]]: (
    state: ChatState,
    event: Extract<ChatStreamEvent, { type: K }>,
  ) => ChatState;
} = {
  session: (state, event) => ({ ...state, sessionId: event.sessionId }),
  step: (state, event) => ({
    ...state,
    messages: patchLast(state.messages, (msg) => ({
      ...msg,
      steps: [
        ...msg.steps,
        {
          step: event.step,
          toolName: event.toolCall.toolName,
          input: event.toolCall.input,
          output: event.output,
          text: event.text, // 模型步间推理文本（常为 undefined——StepPanel 诚实展示）
        },
      ],
    })),
  }),
  approval: (state, event) => ({
    ...state,
    messages: patchLast(state.messages, (msg) => ({
      ...msg,
      approvals: [
        ...(msg.approvals ?? []),
        {
          approvalId: event.approvalId,
          toolName: event.toolName,
          input: event.input,
          status: "pending",
        } satisfies ApprovalRecord,
      ],
    })),
  }),
  token: (state, event) => ({
    ...state,
    messages: patchLast(state.messages, (msg) => ({ ...msg, content: msg.content + event.text })),
  }),
  done: (state) => ({
    ...state,
    messages: patchLast(state.messages, (msg) => ({ ...msg, status: "done" })),
  }),
  error: (state, event) => ({
    ...state,
    messages: patchLast(state.messages, (msg) => ({
      ...msg,
      status: "error",
      errorMessage: event.message,
      errorHint: event.hint,
    })),
  }),
};

/** SSE 事件分发：查映射表（分发逻辑不随事件种类增加而变化） */
function applySseEvent(state: ChatState, event: ChatStreamEvent): ChatState {
  const handler = sseHandlers[event.type] as (s: ChatState, e: ChatStreamEvent) => ChatState;
  return handler(state, event);
}

export type ChatAction =
  | { type: "sse"; event: ChatStreamEvent }
  /** 用户发送：ids 由调用方生成（模块级自增），reducer 保持纯函数 */
  | { type: "user-send"; text: string; userId: number; assistantId: number }
  /** 流式连接正常结束但没等到 done（如中途断流）：补收尾态，不悬挂「思考中…」 */
  | { type: "stream-finalize" }
  /** streamChat 抛错（网络层失败等）：最后一条转错误态 */
  | { type: "stream-error"; message: string }
  /** 历史会话恢复 / 切换：整体替换 */
  | { type: "restore"; sessionId: string; messages: ChatMessage[] }
  /** 历史切换失败：以错误气泡提示，界面不清空 */
  | { type: "switch-fail"; id: number; message: string }
  /** 审批裁决回填：成功置终态；404（超时已自动拒绝等）置过期态 */
  | { type: "approval-resolved"; approvalId: string; approved: boolean; note?: string }
  /** 新会话：清空全部对话状态 */
  | { type: "reset" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "sse":
      return applySseEvent(state, action.event);
    case "user-send":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.userId, role: "user", content: action.text, steps: [], status: "done" },
          { id: action.assistantId, role: "assistant", content: "", steps: [], status: "streaming" },
        ],
      };
    case "stream-finalize":
      return {
        ...state,
        messages: patchLast(state.messages, (msg) =>
          msg.status === "streaming" ? { ...msg, status: "done" } : msg,
        ),
      };
    case "stream-error":
      return {
        ...state,
        messages: patchLast(state.messages, (msg) => ({
          ...msg,
          status: "error",
          errorMessage: action.message,
        })),
      };
    case "restore":
      return { sessionId: action.sessionId, messages: action.messages };
    case "switch-fail":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: "assistant",
            content: "",
            steps: [],
            status: "error",
            errorMessage: action.message,
          },
        ],
      };
    case "approval-resolved":
      return {
        ...state,
        messages: state.messages.map((msg) => {
          const approvals = msg.approvals ?? [];
          if (!approvals.some((record) => record.approvalId === action.approvalId)) return msg;
          return {
            ...msg,
            approvals: approvals.map((record) =>
              record.approvalId === action.approvalId
                ? action.note !== undefined
                  ? { ...record, status: "expired" as const, note: action.note }
                  : { ...record, status: action.approved ? ("approved" as const) : ("denied" as const) }
                : record,
            ),
          };
        }),
      };
    case "reset":
      return initialChatState;
  }
}

/** 恢复的历史轮 → 气泡消息（system 为压缩摘要轮，MessageBubble 渲染为弱化条）。
 *  id 由调用方生成并传入（保持本模块纯函数——自增计数器留在组件层）。 */
export function turnToMessage(turn: SessionTurn, id: number): ChatMessage {
  return { id, role: turn.role, content: turn.content, steps: [], status: "done" };
}
