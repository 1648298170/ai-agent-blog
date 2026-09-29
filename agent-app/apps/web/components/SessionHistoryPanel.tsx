// components/SessionHistoryPanel.tsx —— 历史会话列表面板（会话记录功能，chat/service 两线共用）。
// 打开时拉取会话列表（按最后活跃降序），每项显示
// `MM-DD HH:mm · N 条` + 首条用户消息预览（前 20 字）；点击切换会话（父组件负责
// 拉历史并渲染）；当前会话高亮标记；空列表显示「暂无历史会话」。
// 预览来自逐会话拉取历史详情（SessionSummary 不含消息内容，
// 前端最多给前 20 个会话补预览，更早的退化为 sessionId 尾段展示）。
// variant 决定数据源：chat → /api/chat/sessions（s_ 会话），service → /api/service/sessions（cs_ 会话）。
"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { SessionSummary } from "@agent-app/shared";
import {
  fetchServiceSessionHistory,
  fetchServiceSessions,
  fetchSessionHistory,
  fetchSessions,
} from "../lib/api";

/** 补预览的会话数上限（避免长列表时 N+1 请求失控） */
const PREVIEW_LIMIT = 20;

/** updatedAt（ISO）→ MM-DD HH:mm（本地时区） */
function formatSessionTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "时间未知";
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 首条用户消息预览：截前 20 字，超长补省略号；找不到用户消息时回退 sessionId 尾段 */
function previewOf(summary: SessionSummary, firstUserMessage: string | undefined): string {
  if (firstUserMessage !== undefined && firstUserMessage !== "") {
    return firstUserMessage.slice(0, 20) + (firstUserMessage.length > 20 ? "…" : "");
  }
  return `（${summary.sessionId.slice(-8)}）`;
}

export default function SessionHistoryPanel({
  currentSessionId,
  onSelect,
  onClose,
  variant = "chat",
}: {
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onClose: () => void;
  /** 数据源产品线：chat → /api/chat/sessions（默认，s_ 会话）；service → /api/service/sessions（cs_ 会话） */
  variant?: "chat" | "service";
}): ReactNode {
  const [summaries, setSummaries] = useState<SessionSummary[] | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // 打开即拉取列表；随后为前 N 个会话补「首条用户消息」预览（失败不影响列表）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await (variant === "service" ? fetchServiceSessions() : fetchSessions());
        if (cancelled) return;
        setSummaries(list);
        const target = list.slice(0, PREVIEW_LIMIT);
        const results = await Promise.allSettled(
          target.map((s) =>
            variant === "service"
              ? fetchServiceSessionHistory(s.sessionId)
              : fetchSessionHistory(s.sessionId),
          ),
        );
        if (cancelled) return;
        const next: Record<string, string> = {};
        results.forEach((result, i) => {
          if (result.status !== "fulfilled") return;
          const firstUser = result.value.turns.find((turn) => turn.role === "user");
          if (firstUser !== undefined) next[target[i].sessionId] = firstUser.content;
        });
        setPreviews(next);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="absolute inset-x-0 top-full z-20 mt-1 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg sm:left-auto sm:right-0 sm:w-96">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
        <span className="text-sm font-medium text-gray-700">历史会话</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="收起历史会话"
          className="min-h-8 rounded-md px-2 text-sm text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          ✕
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto p-2">
        {error !== null && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            ⚠ {error}
          </div>
        )}
        {error === null && summaries === null && (
          <p className="animate-pulse px-2 py-3 text-center text-sm text-gray-400">加载中…</p>
        )}
        {error === null && summaries !== null && summaries.length === 0 && (
          <p className="px-2 py-3 text-center text-sm text-gray-400">暂无历史会话</p>
        )}
        {error === null && summaries !== null && summaries.length > 0 && (
          <ul className="space-y-1">
            {summaries.map((summary) => {
              const isCurrent = summary.sessionId === currentSessionId;
              return (
                <li key={summary.sessionId}>
                  <button
                    type="button"
                    onClick={() => onSelect(summary.sessionId)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      isCurrent
                        ? "border-blue-300 bg-blue-50"
                        : "border-transparent hover:border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono text-gray-500">
                        {formatSessionTime(summary.updatedAt)} · {summary.turns} 条
                      </span>
                      {isCurrent && (
                        <span className="shrink-0 rounded-full border border-blue-200 bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                          当前会话
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-gray-800" title={previews[summary.sessionId] ?? summary.sessionId}>
                      {previewOf(summary, previews[summary.sessionId])}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
