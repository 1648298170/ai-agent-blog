// components/StepPanel.tsx —— 「思考过程」可折叠面板（DeepSeek 风格）：
// 平滑展开/收起（grid-rows 0fr→1fr 过渡，高度变化不跳变）+ 新步骤渐入动画
// + 内容限高内滚（长过程不再撑爆气泡）+ 流式时自动滚动到最新一步。
// Thought / Action / Observation 三段式（week20 的 ReAct 可视形态）。
"use client";

import { useEffect, useRef, useState } from "react";
import type { StepRecord } from "./MessageBubble";

/** 未知输出 → 单行摘要（JSON 压平，超长截断；面板要的是「发生了什么」，不是全文）。
 *  审批卡片（ApprovalCard）复用同一摘要规则：工具入参预览与 Observation 观感一致。 */
export function summarize(value: unknown): string {
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
  const listRef = useRef<HTMLOListElement>(null);

  // 流式期间新步骤到达 → 平滑滚到最新一条（DeepSeek 同款体感：过程在眼前长出来）。
  // 折叠时不滚（看不见滚了也没意义）；展开瞬间也归位到底部。
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [steps.length, open]);

  // 无步骤且已收尾 → 面板整个不渲染（纯文本回答不需要空壳子）
  if (steps.length === 0 && !streaming) return null;

  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-gray-200 bg-gray-50/80 text-[13px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-10 w-full items-center justify-between px-3 text-left font-medium text-gray-600 transition-colors hover:bg-gray-100"
        aria-expanded={open}
      >
        <span>
          🧠 思考过程（{steps.length} 步）{streaming ? " · 进行中…" : ""}
        </span>
        <span
          aria-hidden
          className={`inline-block transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {/* grid-rows 0fr→1fr 过渡：高度平滑收放，无需测量 scrollHeight（现代浏览器通用）；
          内层 min-h-0 + overflow-hidden 是该技巧不溢出的必要配套 */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <ol
            ref={listRef}
            className="max-h-60 space-y-3 overflow-y-auto border-t border-gray-100 px-3 py-3 leading-relaxed"
          >
            {steps.map((step) => (
              <li key={step.step} className="step-item-in space-y-1 text-gray-600">
                <p className="break-words">
                  <span className="font-semibold text-purple-600">Thought</span>{" "}
                  {/* 诚实原则：模型本步有推理文本就原样展示，没有就明说——绝不拿模板话冒充模型思考 */}
                  {step.text?.trim() || "（本步无文本推理——工具选择即模型的决策）"}
                </p>
                <p className="break-words">
                  <span className="font-semibold text-blue-600">Action</span>{" "}
                  <code className="rounded bg-white px-1 py-0.5 font-mono text-[12px] text-gray-800">
                    {step.toolName}
                  </code>
                  ({summarize(step.input)})
                </p>
                <p className="break-words">
                  <span className="font-semibold text-emerald-600">Observation</span>{" "}
                  {summarize(step.output)}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
