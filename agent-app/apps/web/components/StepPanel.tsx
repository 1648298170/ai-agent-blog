// components/StepPanel.tsx —— 「思考过程」可折叠面板：step 事件累积成
// Thought / Action / Observation 三段式（week20 的 ReAct 可视形态），默认展开、可折叠。
"use client";

import { useState } from "react";
import type { StepRecord } from "./MessageBubble";

/** 未知输出 → 单行摘要（JSON 压平，超长截断；面板要的是「发生了什么」，不是全文） */
function summarize(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export default function StepPanel({
  steps,
  streaming,
}: {
  steps: StepRecord[];
  streaming: boolean;
}) {
  const [open, setOpen] = useState(true);
  if (steps.length === 0) return null;

  return (
    <div className="mb-2 rounded-lg border border-gray-200 bg-gray-50 text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex min-h-10 w-full items-center justify-between px-3 text-left font-medium text-gray-600"
        aria-expanded={open}
      >
        <span>
          🧠 思考过程（{steps.length} 步）{streaming ? " · 进行中…" : ""}
        </span>
        <span aria-hidden>{open ? "收起 ▲" : "展开 ▼"}</span>
      </button>
      {open && (
        <ol className="space-y-3 border-t border-gray-200 px-3 py-3">
          {steps.map((step) => (
            <li key={step.step} className="space-y-1 leading-relaxed">
              <p>
                <span className="font-semibold text-purple-600">Thought</span>{" "}
                第 {step.step} 步：需要外部信息，决定调用工具
              </p>
              <p className="break-all">
                <span className="font-semibold text-blue-600">Action</span>{" "}
                <code className="rounded bg-white px-1 py-0.5 font-mono">
                  {step.toolName}
                </code>
                ({summarize(step.input)})
              </p>
              <p className="break-all">
                <span className="font-semibold text-emerald-600">Observation</span>{" "}
                {summarize(step.output)}
              </p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
