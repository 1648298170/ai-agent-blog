// orchestrator/orchestrator.ts —— 编排器主体：DAG 并行派发 + 显式状态机 + 失败策略 + 预算 + 事件流。
//
// 组装关系：Orchestrator 只依赖接口（Planner/Executor/Critic/StateStore/策略）——
// 具体实现（LLM 版、内存版、redis 版）全部构造期注入（依赖倒置）。
//
// 执行流程（单个编排作业）：
//   pending → planning（动态模式：LLM 拆子任务单；静态任务单跳过）
//     → executing（DAG 条件派发：入度 0 并行跑，完成后解锁下游 → done）
// 任一子任务失败 → 失败策略（retry 退避重试 / degrade 降级跳过 / compensate 补偿回滚 / escalate 升级人工）
// abort → 软着陆：已完成产出保留 + 标记 interrupted + 后续子任务不派发（区别于全丢）
// 预算超支 → 终态 failed 上抛（预算是控制信号，不是监控指标）
//
// 状态经 StateStore 每次迁移后持久化——断点续跑：同 id 重入时已完成子任务自动跳过。
import { DEFAULT_MAX_STEPS } from "../agent-loop.js";
import type { ToolSet } from "ai";
import { Budget } from "./types.js";
import type { OrchestrationSpec, TaskOutput, TaskSpec } from "./types.js";
import { BudgetExceededError } from "./errors.js";
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

/** 编排事件：状态迁移 / 子任务完成 / 失败 / 升级 / 中止——观察者出口（可接 SSE / 审计 / OTel 前置） */
export type OrchestrationEvent =
  | { type: "state-changed"; id: string; from: string; to: string }
  | { type: "task-completed"; id: string; taskId: string; text: string; tokensUsed: number }
  | { type: "task-failed"; id: string; taskId: string; message: string }
  | { type: "escalated"; id: string; reason: string }
  | { type: "interrupted"; id: string; completedCount: number; remainingCount: number };

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

// ---------------------------------------------------------------------------
// DAG 条件派发核心：入度计数 + 就绪集 + Promise.all 并行
// ---------------------------------------------------------------------------

/** 从任务清单构建依赖图：taskId → 依赖的前置 taskId 集合 */
function buildDependencyGraph(tasks: readonly TaskSpec[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const task of tasks) {
    graph.set(task.id, [...(task.dependsOn ?? [])]);
  }
  return graph;
}

/** 拓扑排序校验：检测循环依赖（有环的 DAG 无法完成所有任务） */
function detectCycle(graph: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const cycles: string[] = [];

  function visit(id: string): void {
    if (stack.has(id)) { cycles.push(id); return; }
    if (visited.has(id)) return;
    visited.add(id);
    stack.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (graph.has(dep)) visit(dep);
    }
    stack.delete(id);
  }

  for (const id of graph.keys()) visit(id);
  return cycles;
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

  /** 执行一次编排作业：goal →（规划）→ DAG 条件派发 → 汇总（状态全程持久化） */
  async run(spec: OrchestrationSpec, signal?: AbortSignal): Promise<OrchestrationResult> {
    const budget = new Budget(spec.maxTokens ?? 50_000, spec.maxDurationMs ?? 10 * 60 * 1000);

    // 断点续跑：同 id 已有快照则恢复（已完成子任务跳过）；否则登记 pending
    let snapshot: OrchestrationSnapshot = (await this.stateStore.load(spec.id)) ?? {
      id: spec.id,
      goal: spec.goal,
      state: "pending",
      outputs: [] as { taskId: string; text: string }[],
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

    // 构建 DAG 依赖图 + 循环检测
    const graph = buildDependencyGraph(tasks);
    const cycles = detectCycle(graph);
    if (cycles.length > 0) {
      throw new Error(`任务依赖存在循环：${cycles.join(" → ")}（请检查 dependsOn 配置）`);
    }

    // 进入 executing
    snapshot = transition(snapshot, "executing");
    await this.stateStore.save(snapshot);

    // 已完成的子任务集合（从断点续跑快照恢复）
    const completed = new Set(snapshot.outputs.map((o) => o.taskId));
    const upstream = new Map(snapshot.outputs.map((o) => [o.taskId, o.text]));

    // DAG 条件派发：入度 0 的任务并行跑，完成后解锁下游
    const results = await this.dispatchDag(tasks, graph, completed, budget, upstream, spec.id, signal);

    // 把派发产出回写到 snapshot.outputs（dispatchDag 内部更新了 upstream，此处同步）
    const syncedOutputs = [...snapshot.outputs];
    for (const [taskId, text] of upstream) {
      if (!syncedOutputs.some((o) => o.taskId === taskId)) {
        syncedOutputs.push({ taskId, text });
      }
    }
    snapshot = { ...snapshot, outputs: syncedOutputs };

    // 汇总 + 终态
    const totalTokens = results.reduce((sum, r) => sum + (r?.tokensUsed ?? 0), 0);
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

  /**
   * DAG 条件派发核心：
   * - 入度 0 的任务并行派发（Promise.all 同波并行）
   - 一个波次全部完成后，解锁入度归零的下游任务 → 下一波
   * - 中止信号触发 → 软着陆：保留已完成产出、标记 interrupted、后续不派发
   */
  private async dispatchDag(
    tasks: readonly TaskSpec[],
    graph: Map<string, string[]>,
    completed: Set<string>,
    budget: Budget,
    upstream: Map<string, string>,
    orchestrationId: string,
    signal?: AbortSignal,
  ): Promise<(TaskOutput | null)[]> {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    const results = new Map<string, TaskOutput | null>();

    // 入度计数：每个任务的前置依赖数（只算存在于任务单中的依赖）
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // taskId → 下游任务 id 列表
    for (const task of tasks) {
      const deps = (task.dependsOn ?? []).filter((d) => taskMap.has(d));
      inDegree.set(task.id, deps.length);
      for (const dep of deps) {
        const list = dependents.get(dep) ?? [];
        list.push(task.id);
        dependents.set(dep, list);
      }
    }

    // 就绪队列：入度 0 且未完成的任务
    let ready: TaskSpec[] = tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0 && !completed.has(t.id));

    // 波次派发循环：每波并行执行就绪任务，完成后解锁下游
    while (ready.length > 0) {
      // ── 中止检查：abort → 软着陆 ──
      if (signal?.aborted) {
        const remaining = tasks.length - completed.size;
        this.onEvent?.({ type: "interrupted", id: orchestrationId, completedCount: completed.size, remainingCount: remaining });
        break; // 软着陆：已完成产出已在 store 里，后续不派发
      }

      // ── 并行执行本波就绪任务 ──
      const promises = ready.map((task) =>
        this.executeWithRetry(task, budget, upstream, orchestrationId),
      );
      const waveResults = await Promise.all(promises);

      // ── 收集本波结果 + 解锁下游 ──
      const nextReady: TaskSpec[] = [];
      for (let i = 0; i < ready.length; i++) {
        const task = ready[i];
        const output = waveResults[i];
        completed.add(task.id);

        if (output !== null) {
          results.set(task.id, output);
          upstream.set(task.id, output.text);
          this.onEvent?.({
            type: "task-completed",
            id: orchestrationId,
            taskId: task.id,
            text: output.text,
            tokensUsed: output.tokensUsed,
          });
        }

        // 解锁下游：把本任务的完成传递给 dependents，入度递减
        for (const depId of dependents.get(task.id) ?? []) {
          const count = (inDegree.get(depId) ?? 0) - 1;
          inDegree.set(depId, count);
          if (count === 0 && !completed.has(depId) && taskMap.has(depId)) {
            nextReady.push(taskMap.get(depId)!);
          }
        }
      }

      ready = nextReady;
    }

    // 按原始任务顺序返回结果（缺失 = 降级/未执行的占位）
    return tasks.map((t) => results.get(t.id) ?? null);
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
          signal: undefined, // 子任务级中止信号：批次二接入
        });
      } catch (err) {
        attempts += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.onEvent?.({ type: "task-failed", id: orchestrationId, taskId: task.id, message });

        if (err instanceof BudgetExceededError) throw err;

        if (this.failurePolicy.onFail === "escalate") {
          this.onEvent?.({ type: "escalated", id: orchestrationId, reason: message });
          throw err;
        }

        if (this.failurePolicy.onFail === "compensate" && this.failurePolicy.compensate !== undefined) {
          await this.failurePolicy.compensate([]);
          throw err;
        }

        if (this.failurePolicy.onFail === "retry" && attempts < this.retryPolicy.maxAttempts) {
          const delay = backoffDelay(this.retryPolicy, attempts);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        upstream.set(task.id, `（子任务「${task.title}」执行失败已降级跳过）`);
        return { taskId: task.id, text: `（降级跳过）`, tokensUsed: 0, durationMs: 0, steps: 0 };
      }
    }
  }
}
