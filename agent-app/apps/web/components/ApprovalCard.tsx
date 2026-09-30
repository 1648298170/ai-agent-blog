// components/ApprovalCard.tsx —— 工具审批卡片（week18 Day 6 人工审批 UI）：
// approval SSE 事件落地成消息流里的琥珀色卡片：工具名 + 入参预览 + 「允许 / 拒绝」按钮。
// 点击 → 页面 POST /api/chat/approve → 卡片进入终态（已允许 / 已拒绝）；
// 超时已自动拒绝等 404 场景 → 过期态（按钮消失，展示 API 的中文原因）。
// 流式期间 SSE 连接保持打开，本卡片只做局部状态更新，不阻塞渲染。
"use client";

import type { ApprovalRecord } from "./MessageBubble";
import { summarize } from "./StepPanel";

export default function ApprovalCard({
  record,
  onDecide,
}: {
  record: ApprovalRecord;
  onDecide?: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs">
      <p className="font-medium text-amber-800">⚠ 高危工具待审批</p>
      <p className="mt-1 break-all leading-relaxed text-amber-900">
        即将执行{" "}
        <code className="rounded bg-white px-1 py-0.5 font-mono text-amber-900">
          {record.toolName}
        </code>
        （{summarize(record.input)}），是否允许？
      </p>
      {record.status === "pending" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide?.(record.approvalId, true)}
            className="min-h-10 rounded-lg border border-emerald-300 bg-emerald-50 px-4 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            允许
          </button>
          <button
            type="button"
            onClick={() => onDecide?.(record.approvalId, false)}
            className="min-h-10 rounded-lg border border-red-300 bg-red-50 px-4 text-sm font-medium text-red-700 transition-colors hover:bg-red-100"
          >
            拒绝
          </button>
        </div>
      ) : (
        <p className="mt-2 leading-relaxed text-amber-800">
          {record.status === "approved" && "✅ 已允许，工具继续执行"}
          {record.status === "denied" && "⛔ 已拒绝，工具收到结构化拒绝值"}
          {record.status === "expired" && `⌛ ${record.note ?? "审批已过期（超时自动拒绝）"}`}
        </p>
      )}
    </div>
  );
}
