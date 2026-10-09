// app/page.tsx —— 智能对话页（首页）：SSE 事件驱动渲染 + 会话记录（跨刷新恢复 / 历史切换）。
//
// 状态机形态：对话流是显式 reducer（lib/chat-state.ts 的 chatReducer），SSE 事件即
// action——本组件只做「取状态 → dispatch → 副作用（localStorage / 滚动 / 请求）」，
// 对话逻辑（事件如何演变状态）全部在纯函数里，可脱离组件测试。
"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import MessageBubble from "../components/MessageBubble";
import SessionHistoryPanel from "../components/SessionHistoryPanel";
import { approveChat, fetchSessionHistory, streamChat } from "../lib/api";
import { chatReducer, initialChatState, turnToMessage } from "../lib/chat-state";

/** localStorage key：聊天会话跨刷新保持（与 service 页同一模式） */
const SESSION_STORAGE_KEY = "agent:chat:sessionId";

/** 自增 id：会话内消息的唯一 key（「新会话」不回卷，避免 React key 复用） */
let nextMessageId = 1;

export default function ChatPage() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const { messages, sessionId } = state;
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 挂载时恢复上次会话：读 localStorage → 拉全量历史 → 渲染气泡
  // （localStorage 只在客户端存在，放 effect 避免 hydration 不一致；失败静默，留给新对话）
  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (saved === null || saved === "") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchSessionHistory(saved);
        if (cancelled) return;
        dispatch({
          type: "restore",
          sessionId: res.sessionId,
          messages: res.turns.map((turn) => turnToMessage(turn, nextMessageId++)),
        });
      } catch {
        // API 未起 / 会话已过期：保持全新界面，下一条消息由 BFF 新开会话
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // 新消息 / 流式追加时保持滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages]);
  // sessionId 变化即落 localStorage（reducer 纯函数，副作用统一放组件层）
  useEffect(() => {
    if (sessionId !== null) window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }, [sessionId]);

  /** 用户裁决：POST /api/chat/approve → 卡片转终态；404（超时已自动拒绝等）→ 过期态 */
  async function handleApprove(approvalId: string, approved: boolean): Promise<void> {
    if (sessionId === null) return; // 理论上不会发生：approval 事件必然在 session 事件之后
    try {
      await approveChat({ sessionId, approvalId, approved });
      dispatch({ type: "approval-resolved", approvalId, approved });
    } catch (err) {
      // 典型场景：60s 超时 BFF 已自动拒绝，审批条目过期 → 404 中文错误
      dispatch({
        type: "approval-resolved",
        approvalId,
        approved: false,
        note: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (text === "" || streaming) return;
    setInput("");
    setStreaming(true);
    dispatch({ type: "user-send", text, userId: nextMessageId++, assistantId: nextMessageId++ });
    try {
      await streamChat(
        { message: text, sessionId: sessionId ?? undefined },
        (event) => dispatch({ type: "sse", event }),
      );
      // 连接正常结束但没等到 done 事件（如中途断流）：补一个收尾态，不悬挂「思考中…」
      dispatch({ type: "stream-finalize" });
    } catch (err) {
      dispatch({ type: "stream-error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setStreaming(false);
    }
  }

  /** 新会话：清空界面 + 丢弃 sessionId 与本地存档（下一条消息由 BFF 分配新会话） */
  function handleNewSession(): void {
    if (streaming) return;
    dispatch({ type: "reset" });
    setInput("");
    setHistoryOpen(false);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  /** 切换到某个历史会话：拉全量历史渲染 + 记住该会话 + 收起面板 */
  async function handleSelectSession(id: string): Promise<void> {
    setHistoryOpen(false);
    if (streaming || id === sessionId) return;
    try {
      const res = await fetchSessionHistory(id);
      dispatch({
        type: "restore",
        sessionId: res.sessionId,
        messages: res.turns.map((turn) => turnToMessage(turn, nextMessageId++)),
      });
      window.localStorage.setItem(SESSION_STORAGE_KEY, res.sessionId);
    } catch (err) {
      // 切换失败（API 抖动等）：以错误气泡提示，界面不清空
      dispatch({
        type: "switch-fail",
        id: nextMessageId++,
        message: `切换会话失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-20 md:pb-0">
      {/* 会话栏：当前 sessionId + 历史会话 + 新会话（relative 供面板绝对定位锚定） */}
      <div className="relative">
        <div className="flex items-center justify-between gap-2 py-3">
          <span className="truncate font-mono text-xs text-gray-400" title={sessionId ?? undefined}>
            {sessionId === null ? "未开始会话" : `会话：${sessionId}`}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setHistoryOpen((open) => !open);
              }}
              disabled={streaming}
              className={
                historyOpen
                  ? "min-h-10 rounded-lg border border-blue-300 bg-blue-50 px-3 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                  : "min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
              }
            >
              🕘 历史会话
            </button>
            <button
              type="button"
              onClick={handleNewSession}
              disabled={streaming}
              className="min-h-10 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              ＋ 新会话
            </button>
          </div>
        </div>
        {historyOpen && (
          <SessionHistoryPanel
            currentSessionId={sessionId}
            onSelect={(id) => void handleSelectSession(id)}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      {/* 消息区（内部滚动） */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2">
        {messages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 px-6 py-10 text-center text-sm text-gray-400">
            <p className="mb-2 text-base font-medium text-gray-600">开始对话吧</p>
            <p>
              试试：<span className="text-gray-500">订单A-1024到哪了</span> ·{" "}
              <span className="text-gray-500">帮我建个工单</span> · 每条回答下方可展开「思考过程」
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onApprove={(approvalId, approved) => void handleApprove(approvalId, approved)}
            />
          ))
        )}
      </div>

      {/* 输入区：流式中禁用发送 */}
      <div className="shrink-0 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder={streaming ? "回答生成中…" : "输入消息，Enter 发送（Shift+Enter 换行）"}
            disabled={streaming}
            className="min-h-11 flex-1 resize-none rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-100"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={streaming || input.trim() === ""}
            className="min-h-11 min-w-14 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {streaming ? "…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
