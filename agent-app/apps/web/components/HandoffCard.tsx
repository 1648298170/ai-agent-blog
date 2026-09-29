// components/HandoffCard.tsx —— 转人工工单卡片：route=human 时醒目渲染，
// 传达「已转人工」：工单号 / 原因 / 用户摘要 / 最近对话 / 创建时间（接手人的第一眼信息）。
"use client";

import type { ServiceHandoffPack } from "@agent-app/shared";

export default function HandoffCard({ pack }: { pack: ServiceHandoffPack }) {
  const createdAt = new Date(pack.createdAt);
  return (
    <div className="mt-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-left">
      <p className="mb-3 text-sm font-bold text-amber-800">
        🙋 已转人工 · 工单已创建
      </p>
      <dl className="space-y-1.5 text-xs leading-relaxed text-amber-900">
        <div className="flex gap-2">
          <dt className="shrink-0 font-semibold">工单号：</dt>
          <dd className="font-mono">{pack.ticketId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-semibold">转接原因：</dt>
          <dd>{pack.reason}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-semibold">用户摘要：</dt>
          <dd>{pack.userSummary}</dd>
        </div>
        <div>
          <dt className="font-semibold">最近对话：</dt>
          <dd className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-amber-200 bg-white/70 px-3 py-2">
            {pack.recentTranscript}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-semibold">创建时间：</dt>
          <dd>{Number.isNaN(createdAt.getTime()) ? pack.createdAt : createdAt.toLocaleString("zh-CN")}</dd>
        </div>
      </dl>
    </div>
  );
}
