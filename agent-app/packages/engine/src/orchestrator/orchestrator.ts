// orchestrator/orchestrator.ts —— 编排器主体（Effect 版）：
// Effect.gen 结构化流水线 + DAG 并行派发 + 显式状态机 + 失败策略 + 预算 + 事件流。
//
// 三个根本差异（对比手写 Promise 版）：
//   ① Effect.gen 把「拆 → 派 → 跑」写成一条可组合的声明式流水线——
//      yield* 顺序组合，Effect.all 声明并行，fiber scope 自动管理子任务生命周期；
//   ② Effect.sleep 驱动退避——虚拟时钟友好（TestClock 零等待测重试）；
//   ③ 错误经 TaggedError 进类型化通道——BudgetExceededError 等精确分支不漏接。
//
// 组装关系：Orchestrator 只依赖接口（Planner/Executor/Critic/StateStore/策略）——
// 具体实现（LLM 版、内存版、redis 版）全部构造期注入（依赖倒置）。
//
// 执行流程（单个编排作业）：
//   pending → planning（动态模式：LLM 拆子任务单；静态任务单跳过）
//     → executing（DAG 条件派发：入度 0 并行跑，完成后解锁下游 → done）
// 任一子任务失败 → 失败策略（retry 退避重试 / degrade 降级跳过 / compensate 补偿回滚 / escalate 升级人工）
// abort → 软着陆：已完成产出保留 + interrupted 事件 + 后续子任务不派发（区别于全丢）
// 预算超支 → 失败上抛（预算是控制信号，不是监控指标）
//
// 状态经 StateStore 每次迁移后持久化——断点续跑：同 id 重入时已完成子任务自动跳过。
//
// 双出口：run() 返回 Effect（Effect 生态消费）；runAsync() 返回 Promise
//（Effect.runPromise 桥接——现有 Promise 调用方零改动迁移）。
import { Effect, Duration } from "effect";
import type { ToolSet } from "ai";
import { Budget } from "./types.js";
import type { OrchestrationSpec, TaskOutput, TaskSpec } from "./types.js";
import { BudgetExceededError } from "./errors.js";
import { MemoryStateStore, transition } from "./state-store.js";
import type { OrchestrationSnapshot, StateStore } from "./state-store.js";
import { AcceptanceCritic, LlmPlanner, LoopExecutor } from "./defaults.js";
import type { Executor, Planner } from "./roles.js";
import {
  defaultRetryPolicy,
  type FailurePolicy,
  type RetryPolicy,
  backoffDelay,
} from "./policies.js";
import { DEFAULT_MAX_STEPS } from "../agent-loop.js";

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
// DAG 工具：依赖图构建 + 循环检测（纯函数，Promise/Effect 世界通用）
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

  // ─────────────────────────────────────────────────────────────────────
  // Effect 主流程：goal →（规划）→ DAG 条件派发 → 汇总（状态全程持久化）
  // 错误通道 unknown：executor 的原始错误原样穿透（Promise 调用方语义不变），
  // 编排器自身的类型化错误（预算/状态机）走 TaggedError 精确分支。
  // ─────────────────────────────────────────────────────────────────────
  run(spec: OrchestrationSpec, signal?: AbortSignal): Effect.Effect<OrchestrationResult, unknown> {
    const self = this;
    return Effect.gen(function* () {
      const budget = new Budget(spec.maxTokens ?? 50_000, spec.maxDurationMs ?? 10 * 60 * 1000);

      // 断点续跑：同 id 已有快照则恢复（已完成子任务跳过）；否则登记 pending
      const loaded = yield* Effect.tryPromise({
        try: () => self.stateStore.load(spec.id),
        catch: (cause) => cause,
      });
      let snapshot: OrchestrationSnapshot = loaded ?? {
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
        yield* Effect.tryPromise({ try: () => self.stateStore.save(snapshot), catch: (c) => c });
        tasks = yield* Effect.tryPromise({
          try: () => self.planner.plan(spec.goal, { budget, upstream: new Map(), signal: undefined }),
          catch: (cause) => cause,
        });
      }

      // 构建 DAG 依赖图 + 循环检测（有环 = 编程错误 → defect 直接暴露）
      const graph = buildDependencyGraph(tasks);
      const cycles = detectCycle(graph);
      if (cycles.length > 0) {
        throw new Error(`任务依赖存在循环：${cycles.join(" → ")}（请检查 dependsOn 配置）`);
      }

      // 进入 executing
      snapshot = transition(snapshot, "executing");
      yield* Effect.tryPromise({ try: () => self.stateStore.save(snapshot), catch: (c) => c });

      // 已完成的子任务集合（从断点续跑快照恢复）
      const completed = new Set(snapshot.outputs.map((o) => o.taskId));
      const upstream = new Map(snapshot.outputs.map((o) => [o.taskId, o.text]));

      // ── DAG 条件派发：入度计数 + 就绪波次 + Effect.all 并行 ──
      const taskMap = new Map(tasks.map((t) => [t.id, t]));
      const results = new Map<string, TaskOutput>();
      const inDegree = new Map<string, number>();
      const dependents = new Map<string, string[]>();
      for (const task of tasks) {
        const deps = (task.dependsOn ?? []).filter((d) => taskMap.has(d));
        inDegree.set(task.id, deps.length);
        for (const dep of deps) {
          dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
        }
      }

      let ready: TaskSpec[] = tasks.filter(
        (t) => (inDegree.get(t.id) ?? 0) === 0 && !completed.has(t.id),
      );

      while (ready.length > 0) {
        // 中止检查：abort → 软着陆（已完成产出已在 store，后续不派发）
        if (signal?.aborted) {
          const remaining = tasks.length - completed.size;
          self.onEvent?.({ type: "interrupted", id: spec.id, completedCount: completed.size, remainingCount: remaining });
          break;
        }

        // 预算检查：波次之间判——超支是控制信号，立即失败（不在错误路径里悄悄漏掉）
        if (budget.exhausted) {
          return yield* Effect.fail(new BudgetExceededError({
            message: "编排预算超支：任务未在 token/时间预算内完成",
          }));
        }

        // 并行执行本波就绪任务（Effect.all = 同波并行，fiber scope 托管）
        const waveResults = yield* Effect.all(
          ready.map((task) => self.executeWithStrategy(task, budget, upstream, spec.id)),
          { concurrency: "unbounded" },
        );

        // 收集本波结果 + 解锁下游
        const nextReady: TaskSpec[] = [];
        for (let i = 0; i < ready.length; i++) {
          const task = ready[i]!;
          const output = waveResults[i]!;
          completed.add(task.id);

          if (output !== null) {
            results.set(task.id, output);
            upstream.set(task.id, output.text);
            self.onEvent?.({
              type: "task-completed",
              id: spec.id,
              taskId: task.id,
              text: output.text,
              tokensUsed: output.tokensUsed,
            });
          }

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

      // 把派发产出回写到 snapshot.outputs
      const syncedOutputs = [...snapshot.outputs];
      for (const [taskId, text] of upstream) {
        if (!syncedOutputs.some((o) => o.taskId === taskId)) {
          syncedOutputs.push({ taskId, text });
        }
      }
      snapshot = { ...snapshot, outputs: syncedOutputs };

      // 汇总 + 终态
      const totalTokens = [...results.values()].reduce((sum, r) => sum + r.tokensUsed, 0);
      const summary = snapshot.outputs.map((o) => o.text).join("\n\n");
      snapshot = { ...snapshot, summary, state: "done", updatedAt: Date.now() };
      yield* Effect.tryPromise({ try: () => self.stateStore.save(snapshot), catch: (c) => c });
      self.onEvent?.({ type: "state-changed", id: spec.id, from: "executing", to: "done" });

      return {
        id: spec.id,
        state: "done",
        summary,
        outputs: snapshot.outputs.map((o) => ({ ...o })),
        totalTokensUsed: totalTokens,
      };
    });
  }

  /** Promise 桥接出口：Effect.runPromise——现有 Promise 调用方零改动。 */
  runAsync(spec: OrchestrationSpec, signal?: AbortSignal): Promise<OrchestrationResult> {
    return Effect.runPromise(this.run(spec, signal));
  }

  // ─────────────────────────────────────────────────────────────────────
  // 单子任务执行：Effect.gen 重试循环 + Effect.sleep 退避（虚拟时钟友好）
  // → 失败按策略分支。返回 null = 该子任务被降级跳过。
  // 与手写版行为逐行对齐：任何错误先重试至 maxAttempts（retry 分支），
  // BudgetExceededError 恒定穿透，escalate/compensate 分支上抛，degrade 占位。
  // ─────────────────────────────────────────────────────────────────────
  private executeWithStrategy(
    task: TaskSpec,
    budget: Budget,
    upstream: Map<string, string>,
    orchestrationId: string,
  ): Effect.Effect<TaskOutput | null, unknown> {
    const self = this;
    return Effect.gen(function* () {
      let attempts = 0;
      for (;;) {
        const outcome = yield* Effect.result(
          Effect.tryPromise({
            try: () => self.executor.execute(task, { budget, upstream, signal: undefined }),
            catch: (cause) => cause,
          }),
        );
        if (outcome._tag === "Success") return outcome.success;

        const err: unknown = outcome.failure;
        attempts += 1;
        const message = err instanceof Error ? err.message : String(err);
        self.onEvent?.({ type: "task-failed", id: orchestrationId, taskId: task.id, message });

        if (err instanceof BudgetExceededError) return yield* Effect.fail(err);

        if (self.failurePolicy.onFail === "escalate") {
          self.onEvent?.({ type: "escalated", id: orchestrationId, reason: message });
          return yield* Effect.fail(err);
        }

        if (self.failurePolicy.onFail === "compensate" && self.failurePolicy.compensate !== undefined) {
          yield* Effect.tryPromise({ try: () => self.failurePolicy.compensate!([]), catch: (c) => c });
          return yield* Effect.fail(err);
        }

        if (self.failurePolicy.onFail === "retry" && attempts < self.retryPolicy.maxAttempts) {
          // Effect.sleep：退避走运行时时钟——TestClock 下零等待，测试不真睡
          yield* Effect.sleep(Duration.millis(backoffDelay(self.retryPolicy, attempts)));
          continue;
        }

        // degrade（或 retry 耗尽后的降级）：占位产出，调用方据此判断哪些子任务被降级
        upstream.set(task.id, `（子任务「${task.title}」执行失败已降级跳过）`);
        return { taskId: task.id, text: `（降级跳过）`, tokensUsed: 0, durationMs: 0, steps: 0 };
      }
    });
  }
}
