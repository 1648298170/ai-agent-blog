// compose.ts —— 工具壳组合器：把「叠加哪些壳、什么顺序」从调用点的手工嵌套
// 升格为一份声明式清单。
//
// 为什么存在：幂等壳、审批壳（以及未来的限流壳 / 审计壳 / 缓存壳）都要包在工具表
// 外面，此前每个调用点自己写嵌套——叠加顺序的知识散落在代码里，两端（api/cli）
// 的壳策略还可能悄悄不一致。组合器让「用哪些壳」变成一行配置：
//
//   const tools = composeToolShells(baseTools, [approvalShell, idempotencyShell]);
//
// 语义（洋葱模型）：数组顺序 = 书写顺序 = 拦截顺序。shells[0] 最靠外、最先看到
// 调用；最后一个最贴近原工具。上例中审批先拦截（拒绝则到不了幂等层，不污染缓存），
// 通过后才进入幂等判定——「幂等在内、审批在外」由清单顺序天然表达。
import type { AgentToolSet } from "../types.js";

/** 一个壳 = 工具表 → 工具表 的纯变换（包壳后返回新表，不改原表） */
export type ToolShell = (tools: AgentToolSet) => AgentToolSet;

/**
 * 按声明顺序组合工具壳。shells[0] 最外层（最先拦截调用），最后一个最内层。
 * 空数组 → 原表原样返回（零变化默认）。
 */
export function composeToolShells(base: AgentToolSet, shells: readonly ToolShell[]): AgentToolSet {
  return shells.reduceRight((acc, shell) => shell(acc), base);
}
