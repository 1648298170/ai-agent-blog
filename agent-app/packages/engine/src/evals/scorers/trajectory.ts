// scorers/trajectory.ts —— 轨迹打分器：期望工具序列 vs 实际 ToolLoopStepEvent[]
//
// ── Tier 1 的严格性口径 ──────────────────────────────────────────────────
// passed = 工具名序列逐项相等（顺序也必须在场：先搜单再查物流 ≠ 先查物流再搜单，
// 顺序错了结果就错了——客服场景里「没单号就去查物流」是必挂的空查询）。
// score = 位置对齐命中数 / 期望长度：部分分让「调对了工具但顺序/多寡不对」的
// 退化一眼可见（0.5 = 一半对），Tier 2 接真模型时可换成更软的加权（如集合
// 命中 + 顺序折扣），接口签名不用动。
//
// ── 期望为空的特判 ───────────────────────────────────────────────────────
// 「一步工具都不调」是合法期望（闲聊负例）。此时 matched/expected.length 是
// 0/0：数学上无定义，业务上含义明确——不许调工具却调了 = 0 分，忍住了 = 满分。
import type { ToolLoopStepEvent } from "../../agent-loop.js";
import type { ScorerOutput } from "../types.js";

/** 序列差异描述：空序列渲染成「（不调工具）」而不是空字符串，人眼不歧义 */
function formatSequence(names: string[]): string {
  return names.length > 0 ? names.join(" → ") : "（不调工具）";
}

/**
 * 比对期望工具序列与实际执行轨迹。
 * @param expected 期望的工具名序列（空数组 = 不许调工具）
 * @param actualSteps 真实 runToolLoop 通过 onStep 广播的步骤事件
 */
export function scoreTrajectory(expected: string[], actualSteps: ToolLoopStepEvent[]): ScorerOutput {
  const actual = actualSteps.map((step) => step.toolCall.toolName);

  // 位置对齐命中数：expected[i] 与 actual[i] 相同才算（顺序敏感）
  const matched = expected.reduce((count, name, i) => count + (actual[i] === name ? 1 : 0), 0);

  const passed =
    expected.length === actual.length && expected.every((name, i) => actual[i] === name);

  const score =
    expected.length === 0 ? (actual.length === 0 ? 1 : 0) : matched / expected.length;

  const detail = passed
    ? `工具序列一致：${formatSequence(expected)}（共 ${expected.length} 步）`
    : `期望工具序列 [${formatSequence(expected)}]，实际执行了 [${formatSequence(actual)}]` +
      `（位置对齐命中 ${matched}/${expected.length === 0 ? "0（期望为空，调了就是错）" : expected.length}）`;

  return { passed, score, detail };
}
