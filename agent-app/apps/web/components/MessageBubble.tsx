// components/MessageBubble.tsx —— 对话气泡：用户右 / 助手左；
// 助手气泡内嵌思考面板（steps）→ 正文（token 拼接，[1][2] 引用标记原样保留）→ 错误态。
"use client";

import type { ReactNode } from "react";
import StepPanel from "./StepPanel";

/** 思考过程面板的一步：step 事件原样落地（output 是 unknown，展示层负责摘要） */
export interface StepRecord {
  step: number;
  toolName: string;
  input: unknown;
  output: unknown;
}

/** 一条气泡消息：助手消息额外携带思考步骤、流式状态与错误信息；
 *  system 轮只出现在恢复的历史里（压缩产生的 [会话摘要] 行），渲染为居中弱化条。 */
export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  steps: StepRecord[];
  status: "streaming" | "done" | "error";
  errorMessage?: string;
  errorHint?: string;
}

export default function MessageBubble({ message }: { message: ChatMessage }) {
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
