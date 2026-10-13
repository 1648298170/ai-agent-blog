// orchestrator/roles.ts —— 三角色契约：planner / executor / critic。
//
// 设计要点：三个角色都是**接口**（依赖倒置）——编排器只依赖契约，不依赖具体实现。
// 默认实现给了「够用」的版本（LLM 规划 / runToolLoop 执行 / LLM 验收），
// 替换 = 传另一个实现对象（如用纯函数 critic 做确定性验收、用静态任务单跳过规划）。
//
// 与 05 站「壳」的一致性：工人/角色的执行全部复用 runToolLoop——
// 编排器是循环之上的「循环的循环」，不重写执行引擎。
//
// Effect 化说明：角色接口保持 Promise（LLM SDK / 工具生态是 Promise 的）——
// 编排器内部经 Effect.tryPromise 把它们抬进 Effect 世界获得
// 结构化并发 / 虚拟时钟 / 类型化错误；角色实现层零迁移成本。

import type { ToolSet } from "ai";
import type { Acceptance, TaskOutput, TaskSpec } from "./types.js";
import type { Budget } from "./types.js";

/** 角色的运行上下文：编排器在调用时注入（产出记账 / 上游产出引用） */
export interface RoleContext {
  /** 全局预算池引用（executor 消耗后向编排器记账） */
  readonly budget: Budget;
  /** 上游已产出（id → 产出文本）：依赖子任务的产出可拼进本任务 prompt */
  readonly upstream: ReadonlyMap<string, string>;
  /** 取消信号（编排器被中止时向下传播） */
  readonly signal?: AbortSignal;
}

/** 规划器：goal → 子任务单。static 模式由调用方预定义（跳过 LLM 规划）。 */
export interface Planner {
  plan(goal: string, ctx: RoleContext): Promise<TaskSpec[]>;
}

/** 执行器：跑一个子任务，产出文本与消耗记账。
 *  默认实现 = runToolLoop（工人 = 工具表 + system prompt 的封装）。 */
export interface Executor {
  execute(task: TaskSpec, ctx: RoleContext): Promise<TaskOutput>;
}

/** 验收器：对照 acceptance 判定产出是否达标。
 *  判定不通过 → 抛 AcceptanceFailedError（detail 给出缺口说明）。 */
export interface Critic {
  review(task: TaskSpec, acceptance: Acceptance, output: TaskOutput): Promise<void>;
}
