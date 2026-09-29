// scorers/routing.ts —— 路由打分器：期望出口 vs 硬规则实际判定
//
// ── 为什么两端都可能有 null ─────────────────────────────────────────────
// Tier 1 只测确定性硬规则层（checkHardRules），它的返回是 RouteDecision | null：
//   - 命中 → RouteDecision（target 一律 "human"，reason 进工单）；
//   - null → 放行，交给 classifyWithLlm 三分类（order/refund/knowledge）。
// 期望侧同样用 null 表示「应放行」。于是 null 对 null = 过（没误伤），
// human 对 human = 过（该转的转了），任何错位 = 不过。这种「两边同构」的
// 比对让 Tier 3 加模型软路由时只需把 actual 换成 supervise() 的产物
// （它永远不返回 null，期望侧的 null 再映射成「不得是 human」即可），
// 打分器本身一行不用改。
//
// ── 分数语义 ─────────────────────────────────────────────────────────────
// 路由是单选判定，没有部分对：1 = 过，0 = 不过。不存在 0.6 个「转对了」。
import type { RouteDecision, RouteTarget } from "../../service/supervisor.js";
import type { ScorerOutput } from "../types.js";

/** 出口的人话渲染：null 显示成「放行」，别让报告读者猜空值是什么意思 */
function formatTarget(target: RouteTarget | null): string {
  return target ?? "放行（硬规则不命中 → 交模型分类）";
}

/**
 * 断言路由决策。
 * @param expected 期望出口（null = 硬规则应放行）
 * @param actual checkHardRules 的实际判定（null = 实际放行）
 */
export function scoreRouting(expected: RouteTarget | null, actual: RouteDecision | null): ScorerOutput {
  const actualTarget: RouteTarget | null = actual === null ? null : actual.target;
  const passed = actualTarget === expected;

  const detail = passed
    ? `路由一致：${formatTarget(expected)}${actual === null ? "" : `（${actual.reason}）`}`
    : `期望 [${formatTarget(expected)}]，实际 [${formatTarget(actualTarget)}]` +
      `${actual === null ? "" : `（${actual.reason}）`}`;

  return { passed, score: passed ? 1 : 0, detail };
}
