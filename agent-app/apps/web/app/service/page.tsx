// app/service/page.tsx —— 智能客服页：对话式（POST /api/service/message，非流式）。
// 助手气泡带路由徽标（order/refund/knowledge/human 四色）+ reason；
// route=human 时追加 HandoffCard 工单卡片；sessionId 经 localStorage 跨请求/刷新保持。
// 会话记录（与聊天页同一模式）：挂载时读 localStorage 保存的 sessionId →
// GET /api/service/sessions/:id 恢复历史气泡（压缩摘要轮渲染为居中弱化条）；
// 顶部「历史会话」面板列出 cs_ 会话并支持点击切换。
"use client";

import { useEffect, useRef, useState } from "react";
import type { RouteTarget, ServiceHandoffPack, SessionTurn } from "@agent-app/shared";
import HandoffCard from "../../components/HandoffCard";
import SessionHistoryPanel from "../../components/SessionHistoryPanel";
import { fetchServiceSessionHistory, sendServiceMessage } from "../../lib/api";

/** localStorage key：客服会话跨刷新保持（连续未解决计数按会话在 BFF 侧维护） */
const SESSION_KEY = "agent-app:service-session-id";

/** 路由徽标四色：订单蓝 / 退款紫 / 知识库绿 / 转人工琥珀 */
const ROUTE_META: Record<RouteTarget, { label: string; className: string }> = {
  order: { label: "订单", className: "border-blue-200 bg-blue-50 text-blue-700" },
  refund: { label: "退款", className: "border-violet-200 bg-violet-50 text-violet-700" },
  knowledge: { label: "知识库", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  human: { label: "转人工", className: "border-amber-300 bg-amber-100 text-amber-800" },
};

/** 一条对话记录：助手侧携带路由判定 + 可选工单包；
 *  system 轮只出现在恢复的历史里（压缩产生的 [会话摘要] 行），渲染为居中弱化条。 */
interface ServiceTurn {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  route?: RouteTarget;
  reason?: string;
  handoff?: ServiceHandoffPack;
  status: "pending" | "done" | "error";
  errorMessage?: string;
}

let nextTurnId = 1;

/** 恢复的历史轮 → 客服气泡（路由徽标/工单包不在历史里，只恢复原文） */
function turnToServiceTurn(turn: SessionTurn): ServiceTurn {
  return { id: nextTurnId++, role: turn.role, text: turn.content, status: "done" };
}

export default function ServicePage() {
  const [turns, setTurns] = useState<ServiceTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 挂载时恢复上次会话：读 localStorage → 拉全量历史 → 渲染气泡
  // （localStorage 只在客户端存在，放 effect 避免 hydration 不一致；失败静默，留给新对话）
  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_KEY);
    if (saved === null || saved === "") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchServiceSessionHistory(saved);
        if (cancelled) return;
        setSessionId(res.sessionId);
        setTurns(res.turns.map(turnToServiceTurn));
      } catch {
        // API 未起 / 会话已过期：保持全新界面，下一条消息由 BFF 新开会话
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns]);

  function patchLast(fn: (turn: ServiceTurn) => ServiceTurn): void {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });
  }

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (text === "" || sending) return;
    setInput("");
    setSending(true);
    setTurns((prev) => [
      ...prev,
      { id: nextTurnId++, role: "user", text, status: "done" },
      { id: nextTurnId++, role: "assistant", text: "", status: "pending" },
    ]);
    try {
      const res = await sendServiceMessage(text, sessionId ?? undefined);
      setSessionId(res.sessionId);
      window.localStorage.setItem(SESSION_KEY, res.sessionId);
      patchLast((turn) => ({
        ...turn,
        status: "done",
        text: res.reply,
        route: res.route,
        reason: res.reason,
        handoff: res.handoff,
      }));
    } catch (err) {
      patchLast((turn) => ({
        ...turn,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSending(false);
    }
  }

  /** 新会话：清空对话 + 丢弃本地 sessionId（BFF 侧会话由服务端生命周期管理） */
  function handleNewSession(): void {
    if (sending) return;
    setTurns([]);
    setSessionId(null);
    setInput("");
    setHistoryOpen(false);
    window.localStorage.removeItem(SESSION_KEY);
  }

  /** 切换到某个历史会话：拉全量历史渲染 + 记住该会话 + 收起面板 */
  async function handleSelectSession(id: string): Promise<void> {
    setHistoryOpen(false);
    if (sending || id === sessionId) return;
    try {
      const res = await fetchServiceSessionHistory(id);
      setSessionId(res.sessionId);
      window.localStorage.setItem(SESSION_KEY, res.sessionId);
      setTurns(res.turns.map(turnToServiceTurn));
    } catch (err) {
      // 切换失败（API 抖动等）：以错误气泡提示，界面不清空
      const message = err instanceof Error ? err.message : String(err);
      setTurns((prev) => [
        ...prev,
        {
          id: nextTurnId++,
          role: "assistant",
          text: "",
          status: "error",
          errorMessage: `切换会话失败：${message}`,
        },
      ]);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 会话栏：当前 sessionId + 历史会话 + 新会话（relative 供面板绝对定位锚定） */}
      <div className="relative">
        <div className="flex items-center justify-between gap-2 py-3">
          <span className="truncate font-mono text-xs text-gray-400" title={sessionId ?? undefined}>
            {sessionId === null ? "未开始会话" : `会话：${sessionId}`}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setHistoryOpen((open) => !open)}
              disabled={sending}
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
              disabled={sending}
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
            variant="service"
          />
        )}
      </div>

      {/* 对话区（内部滚动） */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2">
        {turns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-white/60 px-6 py-10 text-center text-sm text-gray-400">
            <p className="mb-2 text-base font-medium text-gray-600">智能客服在线</p>
            <p>
              试试：<span className="text-gray-500">订单 A-1024 到哪了</span> ·{" "}
              <span className="text-gray-500">退款怎么申请</span> ·{" "}
              <span className="text-gray-500">转人工</span>
            </p>
          </div>
        ) : (
          turns.map((turn) => <TurnBubble key={turn.id} turn={turn} />)
        )}
      </div>

      {/* 输入区 */}
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
            placeholder={sending ? "客服处理中…" : "输入消息，Enter 发送（Shift+Enter 换行）"}
            disabled={sending}
            className="min-h-11 flex-1 resize-none rounded-xl border border-gray-300 bg-white px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-100"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || input.trim() === ""}
            className="min-h-11 min-w-14 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? "…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 单条气泡：用户右；助手左（路由徽标 + reason + 回复 + 可选工单卡片 / 错误态）；
 *  system 为压缩摘要轮，渲染为居中弱化条（与聊天页 MessageBubble 同款样式）。 */
function TurnBubble({ turn }: { turn: ServiceTurn }) {
  if (turn.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[90%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs leading-relaxed whitespace-pre-wrap text-amber-700">
          🧠 {turn.text}
        </div>
      </div>
    );
  }

  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%] rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm">
        {turn.status === "pending" && <p className="animate-pulse text-gray-400">处理中…</p>}
        {turn.status === "error" && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            ⚠ {turn.errorMessage}
          </div>
        )}
        {turn.status === "done" && (
          <>
            {turn.route !== undefined && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${ROUTE_META[turn.route].className}`}
                >
                  {ROUTE_META[turn.route].label}
                </span>
                {turn.reason !== undefined && (
                  <span className="text-xs text-gray-400">{turn.reason}</span>
                )}
              </div>
            )}
            <p className="whitespace-pre-wrap leading-relaxed text-gray-800">{turn.text}</p>
            {turn.handoff !== undefined && <HandoffCard pack={turn.handoff} />}
          </>
        )}
      </div>
    </div>
  );
}
