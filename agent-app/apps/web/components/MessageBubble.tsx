// components/MessageBubble.tsx —— 对话气泡：用户右 / 助手左；
// 助手气泡内嵌思考面板（steps）→ 工具审批卡片（approvals，week18 Day 6）→ 正文
// （token 拼接，[1][2] 引用标记原样保留）→ 错误态。
"use client";

import type { ReactNode } from "react";
import ApprovalCard from "./ApprovalCard";
import StepPanel from "./StepPanel";

/** 思考过程面板的一步：step 事件原样落地（output 是 unknown，展示层负责摘要）。
 *  text = 模型本步伴随工具调用的推理文本（常为 undefined——有就展示，没有就明说） */
export interface StepRecord {
  step: number;
  toolName: string;
  input: unknown;
  output: unknown;
  text?: string;
}

/** 工具审批记录（week18 Day 6）：approval SSE 事件落地 + 用户裁决后的终态。
 *  pending 由 ApprovalCard 渲染成「允许/拒绝」按钮；裁决回传后转终态。 */
export interface ApprovalRecord {
  approvalId: string;
  toolName: string;
  input: unknown;
  status: "pending" | "approved" | "denied" | "expired";
  /** status=expired 时的原因（如 API 404 的「审批请求不存在或已过期」） */
  note?: string;
}

/** 一条气泡消息：助手消息额外携带思考步骤、审批记录、流式状态与错误信息；
 *  system 轮只出现在恢复的历史里（压缩产生的 [会话摘要] 行），渲染为居中弱化条。 */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  steps: StepRecord[];
  status: "streaming" | "done" | "error";
  /** 该条回答过程中出现的高危工具审批卡片（无审批的历史消息可缺省） */
  approvals?: ApprovalRecord[];
  errorMessage?: string;
  errorHint?: string;
}

export default function MessageBubble({
  message,
  onApprove,
}: {
  message: ChatMessage;
  /** 审批裁决回调（approvalId + 用户决定）；由页面注入，卡片点击时触发 */
  onApprove?: (approvalId: string, approved: boolean) => void;
}) {
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="max-w-[90%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs leading-relaxed whitespace-pre-wrap text-amber-700">
          🧠 {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[92%] rounded-2xl rounded-bl-sm border border-gray-200 bg-white px-4 py-3 text-sm shadow-sm">
        <StepPanel steps={message.steps} streaming={message.status === "streaming"} />
        {(message.approvals ?? []).map((record) => (
          <ApprovalCard key={record.approvalId} record={record} onDecide={onApprove} />
        ))}
        <BubbleBody message={message} />
      </div>
    </div>
  );
}

/** 助手气泡正文：流式占位（思考中…）/ 正文 / 红色错误 + hint */
function BubbleBody({ message }: { message: ChatMessage }): ReactNode {
  if (message.status === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        <p className="font-medium">⚠ {message.errorMessage}</p>
        {message.errorHint !== undefined && (
          <p className="mt-1 text-xs text-red-600">{message.errorHint}</p>
        )}
      </div>
    );
  }
  if (message.content === "" && message.steps.length === 0) {
    return <p className="animate-pulse text-gray-400">思考中…</p>;
  }
  return <p className="whitespace-pre-wrap leading-relaxed text-gray-800">{message.content}</p>;
}
