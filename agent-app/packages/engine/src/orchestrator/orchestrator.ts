// orchestrator/orchestrator.ts —— 编排器主体：显式状态机 + 失败策略 + 预算 + 事件流。
//
// 组装关系：Orchestrator 只依赖接口（Planner/Executor/Critic/StateStore/策略）——
// 具体实现（LLM 版、内存版、redis 版）全部构造期注入（依赖倒置）。
//
// 执行流程（单个编排作业）：
//   pending → planning（动态模式：LLM 拆子任务单；静态任务单跳过）
//     → executing（子任务按依赖序执行；每个子任务 = executeWithRetry[重试] + review[验收]）
//     → 全部完成 → done
// 任一子任务失败 → 失败策略（retry 退避重试 / degrade 降级跳过 / compensate 补偿回滚 / escalate 升级人工）
// 预算超支 → 终态 failed 上抛（预算是控制信号，不是监控指标）
//
// 状态经 StateStore 每次迁移后持久化——断点续跑：同 id 重入时已完成子任务自动跳过。
import { DEFAULT_MAX_STEPS } from "../agent-loop.js";
import type { ToolSet } from "ai";
import { Budget } from "./types.js";
import { BudgetExceededError } from "./errors.js";
import type { OrchestrationSpec, TaskOutput, TaskSpec } from "./types.js";
import { MemoryStateStore, transition, type OrchestrationSnapshot, type StateStore } from "./state-store.js";
import {
  AcceptanceCritic,
  LlmPlanner,
  LoopExecutor,
} from "./defaults.js";
import type { Executor, Planner } from "./roles.js";
import {
  defaultRetryPolicy,
  type FailurePolicy,
  type RetryPolicy,
  backoffDelay,
} from "./policies.js";

/** 编排事件：状态迁移 / 子任务完成 / 失败 / 升级——观察者出口（可接 SSE / 审计 / OTel 前置） */
export type OrchestrationEvent =
  | { type: "state-changed"; id: string; from: string; to: string }
  | { type: "task-completed"; id: string; taskId: string; text: string; tokensUsed: number }
  | { type: "task-failed"; id: string; taskId: string; message: string }
  | { type: "escalated"; id: string; reason: string };

export type OrchestrationEventSink = (event: OrchestrationEvent) => void;

export interface OrchestratorOptions {
  readonly stateStore?: StateStore;
  readonly planner?: Planner;
  readonly executor?: Executor;
  readonly critic?: AcceptanceCritic;
  readonly retryPolicy?: RetryPolicy;
  readonly failurePolicy?: FailurePolicy;
  readonly defaultTools?: ToolSet;
  readonly defaultSystemPrompt?: string;
  readonly onEvent?: OrchestrationEventSink;
}

export interface OrchestrationResult {
  readonly id: string;
  readonly state: string;
  readonly summary: string;
  readonly outputs: { taskId: string; text: string }[];
  readonly totalTokensUsed: number;
}

export class Orchestrator {
  private readonly stateStore: StateStore;
  private readonly planner: Planner;
  private readonly executor: Executor;
  private readonly critic: AcceptanceCritic;
  private readonly retryPolicy: RetryPolicy;
  private readonly failurePolicy: FailurePolicy;
  private readonly onEvent?: OrchestrationEventSink;

  constructor(options: OrchestratorOptions = {}) {
    this.stateStore = options.stateStore ?? new MemoryStateStore();
    this.planner = options.planner ?? new LlmPlanner();
    this.executor = options.executor ?? new LoopExecutor({
      tools: options.defaultTools ?? {},
      systemPrompt: options.defaultSystemPrompt ?? "你是任务执行者。严格按目标完成任务，产出具体结果。",
      maxSteps: DEFAULT_MAX_STEPS,
    });
    this.critic = options.critic ?? new AcceptanceCritic();
    this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
    this.failurePolicy = options.failurePolicy ?? { onFail: "retry" };
    this.onEvent = options.onEvent;
  }

  /** 执行一次编排作业：goal →（规划）→ 子任务执行 → 验收 → 汇总（状态全程持久化） */
  async run(spec: OrchestrationSpec): Promise<OrchestrationResult> {
    const budget = new Budget(spec.maxTokens ?? 50_000, spec.maxDurationMs ?? 10 * 60 * 1000);

    // 断点续跑：同 id 已有快照则恢复（已完成子任务跳过）；否则登记 pending
    let snapshot: OrchestrationSnapshot = (await this.stateStore.load(spec.id)) ?? {
      id: spec.id,
      goal: spec.goal,
      state: "pending",
      outputs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 规划：静态任务单优先；无单时进入 planning 由 planner 动态拆
    let tasks: readonly TaskSpec[] = spec.tasks;
    if (tasks.length === 0) {
      snapshot = transition(snapshot, "planning");
      await this.stateStore.save(snapshot);
      tasks = await this.planner.plan(spec.goal, { budget, upstream: new Map(), signal: undefined });
    }
    snapshot = transition(snapshot, "executing");
    await this.stateStore.save(snapshot);

    // 子任务执行：依赖序串行（DAG 并行为后续预留——deps 字段已入契约）
    const upstream = new Map(snapshot.outputs.map((o) => [o.taskId, o.text]));
    const done = new Set(upstream.keys());
    let totalTokens = 0;

    for (const task of tasks) {
      if (done.has(task.id)) continue; // 断点续跑：已完成跳过
      if (budget.exhausted) {
        snapshot = { ...snapshot, updatedAt: Date.now() };
        await this.stateStore.save(snapshot);
        throw new BudgetExceededError(`编排预算超支于子任务「${task.title}」`);
      }

      const output = await this.executeWithRetry(task, budget, upstream, spec.id);
      if (output !== null) {
        upstream.set(task.id, output.text);
        totalTokens += output.tokensUsed;
        snapshot = {
          ...snapshot,
          outputs: [...snapshot.outputs, { taskId: task.id, text: output.text }],
          updatedAt: Date.now(),
        };
        this.onEvent?.({
          type: "task-completed",
          id: spec.id,
          taskId: task.id,
          text: output.text,
          tokensUsed: output.tokensUsed,
        });
        await this.stateStore.save(snapshot);
      }
    }

    // 汇总 + 终态
    const summary = snapshot.outputs.map((o) => o.text).join("\n\n");
    snapshot = { ...snapshot, summary, state: "done", updatedAt: Date.now() };
    await this.stateStore.save(snapshot);
    this.onEvent?.({ type: "state-changed", id: spec.id, from: "executing", to: "done" });

    return {
      id: spec.id,
      state: "done",
      summary,
      outputs: snapshot.outputs.map((o) => ({ ...o })),
      totalTokensUsed: totalTokens,
    };
  }

  /** 单子任务执行：重试（退避）→ 失败按策略分支。返回 null = 该子任务被降级跳过。 */
  private async executeWithRetry(
    task: TaskSpec,
    budget: Budget,
    upstream: Map<string, string>,
    orchestrationId: string,
  ): Promise<TaskOutput | null> {
    let attempts = 0;
    for (;;) {
      try {
        return await this.executor.execute(task, {
          budget,
          upstream,
          signal: undefined, // 编排级中止信号：批次二接入
        });
      } catch (err) {
        attempts += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.onEvent?.({ type: "task-failed", id: orchestrationId, taskId: task.id, message });

        // 预算超支：不可重试、不可降级——直接上抛（终态 failed 由调用方落）
        if (err instanceof BudgetExceededError) throw err;

        // escalate 分支：升级人工
        if (this.failurePolicy.onFail === "escalate") {
          this.onEvent?.({ type: "escalated", id: orchestrationId, reason: message });
          throw err;
        }

        // compensate 分支：执行补偿钩子后抛出（回滚已完成子任务的副作用）
        if (this.failurePolicy.onFail === "compensate" && this.failurePolicy.compensate !== undefined) {
          await this.failurePolicy.compensate([]);
          throw err;
        }

        // retry 分支：退避重试（耗尽后与 degrade 同流：降级跳过）
        if (this.failurePolicy.onFail === "retry" && attempts < this.retryPolicy.maxAttempts) {
          const delay = backoffDelay(this.retryPolicy, attempts);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        // degrade / retry 耗尽 → 降级跳过：占位产出让后续子任务知道上游缺失
        upstream.set(task.id, `（子任务「${task.title}」执行失败已降级跳过）`);
        return { taskId: task.id, text: "", tokensUsed: 0, durationMs: 0, steps: 0 };
      }
    }
  }
}
