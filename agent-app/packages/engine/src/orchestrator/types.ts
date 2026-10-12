// orchestrator/types.ts —— 编排器的类型图纸：任务规格、状态机、事件、预算。
//
// 生产级语义的三个分水岭（区别于玩具流水线）：
// ① 验收标准显式化——TaskSpec.acceptance 是结构化的「完成的定义」，
//    critic 对照它判定，不靠感觉（acceptance.type="manual" 表示必须人工验收）；
// ② 状态机显式——TaskState 的每次迁移都有合法性守护（非法迁移直接抛错），
//    状态可持久化（StateStore 接缝），断点续跑建立在「状态是真的」之上；
// ③ 预算显式——maxTokens / maxDurationMs 是硬约束，超支触发 fail 或 escalate
//    （预算不是监控指标，是控制信号）。

import type { ToolSet } from "ai";

/** 任务状态机（显式枚举：非法迁移在状态机守护层抛错） */
export type TaskState =
  | "pending" // 待启动（已登记未开始）
  | "planning" // 规划中（动态拆分：LLM 生成子任务单）
  | "executing" // 执行中（子任务按序/并行执行）
  | "reviewing" // 验收中（critic 对照 acceptance 判定）
  | "done" // 终态：验收通过
  | "failed" // 终态：不可恢复失败（重试耗尽 / 预算超支且无降级）
  | "escalated" // 终态：升级人工（Agent 信心不足或策略要求人拍板）
  | "compensated"; // 终态：已回滚（写操作的补偿执行完毕）

/** 合法迁移表：状态机守护的唯一依据（迁移不在表内 = 编程错误，直接抛）
 *  done → executing 允许「追加新子任务后继续」（同 id 重入的断点续跑场景） */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending: ["planning", "executing", "failed", "escalated"],
  planning: ["executing", "failed", "escalated"],
  executing: ["reviewing", "failed", "escalated", "compensated"],
  reviewing: ["done", "executing", "failed", "escalated"],
  done: ["executing"], // 断点续跑：追加新子任务后继续
  failed: ["executing"], // 重试整次编排
  escalated: [], // 终态：人工裁决后由外部重开新编排
  compensated: [],
};

/** 验收标准：critic 判定「完成」的显式依据（生产级分水岭：完成必须有定义） */
export type Acceptance =
  | { type: "llm-judge"; rubric: string } // LLM 对照 rubric 二元判定
  | { type: "contains"; anyOf: string[] } // 产出包含任一关键词（快速校验）
  | { type: "manual" } // 必须人工验收 → 走 escalate
  | { type: "none" }; // 无验收（纯执行，产出即结果）

/** 子任务规格：编排器调度的最小单元 */
export interface TaskSpec {
  /** 稳定 id（结果引用 / 重试定位 / 幂等键的组成部分） */
  readonly id: string;
  /** 人读标题（事件与日志用） */
  readonly title: string;
  /** 目标描述：拼进 worker 的 prompt */
  readonly goal: string;
  /** 依赖的子任务 id（第一批串行执行按序消费；DAG 并行为后续预留） */
  readonly dependsOn?: readonly string[];
  /** 验收标准（缺省 = none） */
  readonly acceptance?: Acceptance;
  /** 本子任务的工具表覆盖（缺省用编排器默认表——最小权限：只发该给的工具） */
  readonly tools?: ToolSet;
  /** 子任务预算覆盖（缺省用编排器默认预算） */
  readonly maxTokens?: number;
  readonly maxDurationMs?: number;
}

/** 一次完整的编排作业规格：目标 + 任务单 + 全局预算 + 验收 */
export interface OrchestrationSpec {
  /** 编排作业 id（状态持久化的键） */
  readonly id: string;
  /** 总目标（动态规划时给 planner；静态任务单时为说明性文字） */
  readonly goal: string;
  /** 任务单：静态模式由调用方预定义；动态模式由 Planner 生成 */
  readonly tasks: readonly TaskSpec[];
  /** 整体验收（子任务全 done 后，对汇总产出做终审；缺省 none） */
  readonly acceptance?: Acceptance;
  /** 全局预算：maxTokens（全部子任务共享池）/ maxDurationMs（端到端墙钟） */
  readonly maxTokens?: number;
  readonly maxDurationMs?: number;
}

/** 子任务执行产出 */
export interface TaskOutput {
  readonly taskId: string;
  readonly text: string;
  /** 执行期消耗（预算记账） */
  readonly tokensUsed: number;
  readonly durationMs: number;
  /** 工具调用轨迹摘要（观测用） */
  readonly steps: number;
}

/** 预算池：跨子任务共享扣减（全局预算的记账本） */
export class Budget {
  private remainingTokens: number;
  private readonly deadline: number;

  constructor(
    private readonly maxTokens: number,
    private readonly maxDurationMs: number,
  ) {
    this.remainingTokens = maxTokens;
    this.deadline = Date.now() + maxDurationMs;
  }

  get tokensLeft(): number {
    return this.remainingTokens;
  }

  /** 预算是否超支（token 超池 or 墙钟超时） */
  get exhausted(): boolean {
    return this.remainingTokens <= 0 || Date.now() > this.deadline;
  }

  get timeoutExceeded(): boolean {
    return Date.now() > this.deadline;
  }

  /** 记账：扣减子任务实际消耗（允许少量超支——最后一步超出也要完成再判） */
  spend(tokens: number): void {
    this.remainingTokens -= tokens;
  }
}
