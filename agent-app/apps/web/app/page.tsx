// app/page.tsx —— 智能对话页（首页）：SSE 事件驱动渲染 + 会话记录（跨刷新恢复 / 历史切换）。
// 事件流（@agent-app/shared 的 ChatStreamEvent，与 api 实际线格式逐字段一致）：
//   session → 记录 sessionId 并写入 localStorage（刷新后据此恢复）
//   step    → 累积进该条回答的「思考过程」面板（Thought/Action/Observation）
//   approval→ 高危工具待执行：渲染审批卡片（week18 Day 6），允许/拒绝经
//             POST /api/chat/approve 裁决；流式期间连接保持打开、页面可交互
//   token   → 逐段追加正文（注意：api 实际事件名是 token，不是 delta）
//   done    → 收尾；error → 红色错误 + hint（如 LLM 未配置的中文提示）
// 会话记录：挂载时读 localStorage 里保存的 sessionId → GET /api/chat/sessions/:id
// 恢复历史气泡（压缩摘要轮渲染为居中弱化条）；顶部「历史会话」面板可列出并切换。
"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatStreamEvent, SessionTurn } from "@agent-app/shared";
import MessageBubble from "../components/MessageBubble";
import type { ApprovalRecord, ChatMessage } from "../components/MessageBubble";
import SessionHistoryPanel from "../components/SessionHistoryPanel";
import { approveChat, fetchSessionHistory, streamChat } from "../lib/api";

/** localStorage key：聊天会话跨刷新保持（与 service 页同一模式） */
const SESSION_STORAGE_KEY = "agent:chat:sessionId";

/** localStorage key：ops 运营后台访问令牌（用户自己的钥匙，只存在本浏览器） */
const OPS_TOKEN_STORAGE_KEY = "ops-token";

/** 自增 id：会话内消息的唯一 key（「新会话」不回卷，避免 React key 复用） */
let nextMessageId = 1;

/** 恢复的历史轮 → 气泡消息（system 为压缩摘要轮，MessageBubble 渲染为弱化条） */
function turnToMessage(turn: SessionTurn): ChatMessage {
  return { id: nextMessageId++, role: turn.role, content: turn.content, steps: [], status: "done" };
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // ops 令牌输入面板（外部数据源）：开合 + 输入框草稿 + 已配置状态
  const [tokenOpen, setTokenOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [hasOpsToken, setHasOpsToken] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 挂载时恢复上次会话：读 localStorage → 拉全量历史 → 渲染气泡
  // （localStorage 只在客户端存在，放 effect 避免 hydration 不一致；失败静默，留给新对话）
  useEffect(() => {
    const saved = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (saved !== null && saved !== "") {
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetchSessionHistory(saved);
          if (cancelled) return;
          setSessionId(res.sessionId);
          setMessages(res.turns.map(turnToMessage));
        } catch {
          // API 未起 / 会话已过期：保持全新界面，下一条消息由 BFF 新开会话
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    // ops 令牌状态恢复：已保存的令牌回填输入框（可编辑），状态点亮「已配置」
    const savedToken = window.localStorage.getItem(OPS_TOKEN_STORAGE_KEY);
    if (savedToken !== null && savedToken !== "") {
      setTokenInput(savedToken);
      setHasOpsToken(true);
    }
  }, []);
  // 新消息 / 流式追加时保持滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /** 就地更新最后一条（正在流式生成的那条助手消息） */
  function patchLast(fn: (msg: ChatMessage) => ChatMessage): void {
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = fn(next[next.length - 1]);
      return next;
    });
  }

  /** 就地更新某条审批记录（按 approvalId 定位；审批挂在流式中的最后一条消息上） */
  function patchApproval(approvalId: string, fn: (record: ApprovalRecord) => ApprovalRecord): void {
    setMessages((prev) =>
      prev.map((msg) => {
        const approvals = msg.approvals ?? [];
        if (!approvals.some((record) => record.approvalId === approvalId)) return msg;
        return {
          ...msg,
          approvals: approvals.map((record) =>
            record.approvalId === approvalId ? fn(record) : record,
          ),
        };
      }),
    );
  }

  /** SSE 事件 → 状态机：session / step / approval / token / done / error 六分支 */
  function handleEvent(event: ChatStreamEvent): void {
    switch (event.type) {
      case "session":
        setSessionId(event.sessionId);
        // 会话记录第一环：BFF 分配/确认 sessionId 时落 localStorage，刷新可恢复
        window.localStorage.setItem(SESSION_STORAGE_KEY, event.sessionId);
        break;
      case "step":
        patchLast((msg) => ({
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
        }));
        break;
      case "approval":
        // 高危工具待执行：卡片挂到正在流式生成的这条回答上（此刻流仍开着，按钮可点）
        patchLast((msg) => ({
          ...msg,
          approvals: [
            ...(msg.approvals ?? []),
            {
              approvalId: event.approvalId,
              toolName: event.toolName,
              input: event.input,
              status: "pending",
            },
          ],
        }));
        break;
      case "token":
        patchLast((msg) => ({ ...msg, content: msg.content + event.text }));
        break;
      case "done":
        patchLast((msg) => ({ ...msg, status: "done" }));
        break;
      case "error":
        patchLast((msg) => ({
          ...msg,
          status: "error",
          errorMessage: event.message,
          errorHint: event.hint,
        }));
        break;
    }
  }

  /** 用户裁决：POST /api/chat/approve → 卡片转终态；404（超时已自动拒绝等）→ 过期态 */
  async function handleApprove(approvalId: string, approved: boolean): Promise<void> {
    if (sessionId === null) return; // 理论上不会发生：approval 事件必然在 session 事件之后
    try {
      await approveChat({ sessionId, approvalId, approved });
      patchApproval(approvalId, (record) => ({
        ...record,
        status: approved ? "approved" : "denied",
      }));
    } catch (err) {
      // 典型场景：60s 超时 BFF 已自动拒绝，审批条目过期 → 404 中文错误
      const message = err instanceof Error ? err.message : String(err);
      patchApproval(approvalId, (record) => ({ ...record, status: "expired", note: message }));
    }
  }

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (text === "" || streaming) return;
    setInput("");
    setStreaming(true);
    setMessages((prev) => [
      ...prev,
      { id: nextMessageId++, role: "user", content: text, steps: [], status: "done" },
      { id: nextMessageId++, role: "assistant", content: "", steps: [], status: "streaming" },
    ]);
    try {
      // 外部数据源令牌：每次发送从 localStorage 现读（面板里改完不用刷新页面状态机），
      // 没存过/已清空则不带 X-Ops-Token 头——BFF 侧不给外部工具，零行为变化
      const token = window.localStorage.getItem(OPS_TOKEN_STORAGE_KEY);
      const headers = token !== null && token.trim() !== "" ? { "X-Ops-Token": token } : undefined;
      await streamChat({ message: text, sessionId: sessionId ?? undefined }, handleEvent, { headers });
      // 连接正常结束但没等到 done 事件（如中途断流）：补一个收尾态，不悬挂「思考中…」
      patchLast((msg) => (msg.status === "streaming" ? { ...msg, status: "done" } : msg));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchLast((msg) => ({ ...msg, status: "error", errorMessage: message }));
    } finally {
      setStreaming(false);
    }
  }

  /** 新会话：清空界面 + 丢弃 sessionId 与本地存档（下一条消息由 BFF 分配新会话） */
  function handleNewSession(): void {
    if (streaming) return;
    setMessages([]);
    setSessionId(null);
    setInput("");
    setHistoryOpen(false);
    setTokenOpen(false);
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  /** 保存 ops 令牌：写 localStorage + 点亮「已配置」+ 收起面板（空输入视同清除） */
  function handleSaveToken(): void {
    const trimmed = tokenInput.trim();
    if (trimmed === "") {
      handleClearToken();
      return;
    }
    window.localStorage.setItem(OPS_TOKEN_STORAGE_KEY, trimmed);
    setHasOpsToken(true);
    setTokenOpen(false);
  }

  /** 清除 ops 令牌：删 localStorage + 回到「未配置」（下次发送不再带头） */
  function handleClearToken(): void {
    window.localStorage.removeItem(OPS_TOKEN_STORAGE_KEY);
    setTokenInput("");
    setHasOpsToken(false);
  }

  /** 切换到某个历史会话：拉全量历史渲染 + 记住该会话 + 收起面板 */
  async function handleSelectSession(id: string): Promise<void> {
    setHistoryOpen(false);
    if (streaming || id === sessionId) return;
    try {
      const res = await fetchSessionHistory(id);
      setSessionId(res.sessionId);
      window.localStorage.setItem(SESSION_STORAGE_KEY, res.sessionId);
      setMessages(res.turns.map(turnToMessage));
    } catch (err) {
      // 切换失败（API 抖动等）：以错误气泡提示，界面不清空
      const message = err instanceof Error ? err.message : String(err);
      setMessages((prev) => [
        ...prev,
        {
          id: nextMessageId++,
          role: "assistant",
          content: "",
          steps: [],
          status: "error",
          errorMessage: `切换会话失败：${message}`,
        },
      ]);
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
            {/* 🔑 ops 令牌入口：状态点（绿=已配置 / 灰=未配置）+ 弹出面板填令牌 */}
            <button
              type="button"
              onClick={() => {
                setTokenOpen((open) => !open);
                setHistoryOpen(false); // 两个弹出面板互斥，避免叠在一处
              }}
              disabled={streaming}
              title={hasOpsToken ? "ops 数据源令牌：已配置（点开可修改）" : "ops 数据源令牌：未配置（点开填入）"}
              className={
                tokenOpen
                  ? "flex min-h-10 items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                  : "flex min-h-10 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
              }
            >
              🔑 ops
              <span
                aria-hidden
                className={
                  hasOpsToken
                    ? "inline-block h-2 w-2 rounded-full bg-emerald-500"
                    : "inline-block h-2 w-2 rounded-full bg-gray-300"
                }
              />
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryOpen((open) => !open);
                setTokenOpen(false); // 两个弹出面板互斥，避免叠在一处
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
        {tokenOpen && (
          <div className="absolute inset-x-0 top-full z-20 mt-1 w-full rounded-xl border border-gray-200 bg-white p-4 shadow-lg sm:left-auto sm:right-0 sm:w-96">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">填入 ops 访问令牌</span>
              <span
                className={
                  hasOpsToken
                    ? "rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                    : "rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-500"
                }
              >
                {hasOpsToken ? "已配置" : "未配置"}
              </span>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveToken();
                }}
                placeholder="粘贴运营后台的访问令牌"
                autoComplete="off"
                className="min-h-10 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
              <button
                type="button"
                onClick={handleSaveToken}
                className="min-h-10 shrink-0 rounded-lg bg-blue-600 px-3.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                保存
              </button>
              {hasOpsToken && (
                <button
                  type="button"
                  onClick={handleClearToken}
                  className="min-h-10 shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-500 transition-colors hover:bg-gray-100"
                >
                  清除
                </button>
              )}
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-400">
              令牌只保存在本浏览器（localStorage），每次发送对话时经 X-Ops-Token 头转交后端；
              未填写时问商家数据，助手会提示先来这里填令牌。
            </p>
          </div>
        )}
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
