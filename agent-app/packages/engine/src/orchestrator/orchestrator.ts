// orchestrator/orchestrator.ts —— 编排器主体（Effect 版）：
// Effect.gen 结构化流水线 + DAG 并行派发 + 显式状态机 + 验收闭环 + 失败策略 + 预算 + 事件流。
//
// 三个根本差异（对比手写 Promise 版）：
//   ① Effect.gen 把「拆 → 派 → 跑」写成一条可组合的声明式流水线——
//      yield* 顺序组合，Effect.all 声明并行，fiber scope 自动管理子任务生命周期；
//   ② Effect.sleep 驱动退避——虚拟时钟友好（TestClock 零等待测重试）；
//   ③ 错误经 TaggedError 进类型化通道——BudgetExceededError / EscalatedError 等精确分支不漏接。
//
// 组装关系：Orchestrator 只依赖接口（Planner/Executor/Critic/StateStore/策略）——
// 具体实现（LLM 版、内存版、redis 版）全部构造期注入（依赖倒置）。
//
// 执行流程（单个编排作业）：
//   pending → planning（动态模式：LLM 拆子任务单；静态任务单跳过）
//     → executing（DAG 条件派发：入度 0 并行跑，完成后解锁下游）
//     → reviewing（编排级终审 spec.acceptance；无终审时瞬间过站）→ done
// 任一子任务失败 → 失败策略（retry 退避重试 / degrade 降级跳过 / compensate 补偿回滚 / escalate 升级人工）
// 验收接线：子任务产出先过 critic（manual 直接升级人工；contains/llm-judge 不达标按失败走策略）
// 失败终态落盘：escalate → escalated，其余失败 → failed——迁移表内合法，落盘后同 id 重入不再炸
// abort → 软着陆：已完成产出保留 + interrupted 事件 + 后续子任务不派发（区别于全丢）
// 预算超支 → 落 failed 终态后失败（预算是控制信号，不是监控指标）
//
// 状态经 StateStore 每次迁移后持久化——断点续跑：同 id 重入时已完成子任务自动跳过，
// 动态规划生成的任务单也存进快照（重入跳过重新规划，taskId 稳定）。
//
// 双出口：run() 返回 Effect（Effect 生态消费）；runAsync() 返回 Promise
//（Effect.runPromise 桥接——现有 Promise 调用方零改动迁移）。
import { Effect, Duration } from "effect";
import type { ToolSet } from "ai";
import { Budget } from "./types.js";
import type { OrchestrationSpec, TaskOutput, TaskSpec, TaskState } from "./types.js";
import { BudgetExceededError, EscalatedError, RetriableError } from "./errors.js";
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

  /** 状态迁移 + 事件（编排器改状态的唯一入口——迁移合法性/时间戳/事件流三合一）。
   *  非法迁移由 transition 抛 IllegalTransitionError（编程错误直接暴露）。 */
  private moveTo(snapshot: OrchestrationSnapshot, to: TaskState): OrchestrationSnapshot {
    const from = snapshot.state;
    const next = transition(snapshot, to);
    this.onEvent?.({ type: "state-changed", id: next.id, from, to });
    return next;
  }

  /** 落失败终态并持久化（escalated / failed 均为 executing/reviewing 的表内迁移——
   *  落盘后同 id 重入合法：failed → executing 在迁移表内，断点续跑可用） */
  private persistTerminal(
    snapshot: OrchestrationSnapshot,
    terminal: Extract<TaskState, "escalated" | "failed">,
  ): Effect.Effect<OrchestrationSnapshot, unknown> {
    const self = this;
    return Effect.gen(function* () {
      // 已是终态（重复落盘防御）；executing/reviewing 是两个可落终态的中间态
      if (snapshot.state !== "executing" && snapshot.state !== "reviewing") return snapshot;
      const next = self.moveTo(snapshot, terminal);
      yield* Effect.tryPromise({ try: () => self.stateStore.save(next), catch: (c) => c });
      return next;
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Effect 主流程：goal →（规划）→ DAG 条件派发 → 终审 → 汇总（状态全程持久化）
  // 错误通道 unknown：executor 的原始错误原样穿透（Promise 调用方语义不变），
  // 编排器自身的类型化错误（预算/升级/状态机）走 TaggedError 精确分支。
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

      // 规划：静态任务单优先；无单时分两种——快照里存过任务单（动态规划断点续跑）
      // 直接复用（taskId 稳定，已完成产出对得上）；快照也没有才进 planning 由 planner 动态拆
      let tasks: readonly TaskSpec[] = spec.tasks;
      if (tasks.length === 0 && (snapshot.tasks?.length ?? 0) > 0) {
        tasks = snapshot.tasks!; // 断点续跑：复用上次规划的任务单
      } else if (tasks.length === 0) {
        snapshot = self.moveTo(snapshot, "planning");
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

      // 任务单进快照（剥掉 tools：ToolSet 含函数，structuredClone 不支持）——
      // 动态规划场景下这是断点续跑的唯一依据，静态任务单场景下留档无害
      snapshot = { ...snapshot, tasks: tasks.map(({ tools: _tools, ...rest }) => rest) };

      // 进入 executing
      snapshot = self.moveTo(snapshot, "executing");
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

      // 派发循环抽成内部 Effect——失败统一在外层落终态（escalated / failed）
      const dispatch = Effect.gen(function* () {
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

          // 预算检查：波次之间判——超支是控制信号，直接失败（外层统一落 failed 终态）
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
            results.set(task.id, output);
            upstream.set(task.id, output.text);
            self.onEvent?.({
              type: "task-completed",
              id: spec.id,
              taskId: task.id,
              text: output.text,
              tokensUsed: output.tokensUsed,
            });

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
      });

      // 派发失败 → 落终态（EscalatedError → escalated，其余 → failed）后原样上抛
      const dispatched = yield* Effect.result(dispatch);
      if (dispatched._tag === "Failure") {
        const terminal = dispatched.failure instanceof EscalatedError ? "escalated" : "failed";
        snapshot = yield* self.persistTerminal(snapshot, terminal);
        return yield* Effect.fail(dispatched.failure);
      }

      // 把派发产出回写到 snapshot.outputs
      const syncedOutputs = [...snapshot.outputs];
      for (const [taskId, text] of upstream) {
        if (!syncedOutputs.some((o) => o.taskId === taskId)) {
          syncedOutputs.push({ taskId, text });
        }
      }
      snapshot = { ...snapshot, outputs: syncedOutputs };

      // 汇总
      const totalTokens = [...results.values()].reduce((sum, r) => sum + r.tokensUsed, 0);
      const summary = snapshot.outputs.map((o) => o.text).join("\n\n");
      snapshot = { ...snapshot, summary };

      // ── 编排级终审：子任务全 done 后对汇总产出过一遍 critic（reviewing 站）──
      const overallAcceptance = spec.acceptance ?? { type: "none" as const };
      if (overallAcceptance.type !== "none") {
        snapshot = self.moveTo(snapshot, "reviewing");
        yield* Effect.tryPromise({ try: () => self.stateStore.save(snapshot), catch: (c) => c });
        const verdict = yield* Effect.result(Effect.tryPromise({
          try: () => self.critic.review(
            { id: spec.id, title: "编排终审", goal: spec.goal },
            overallAcceptance,
            { taskId: spec.id, text: summary, tokensUsed: totalTokens, durationMs: 0, steps: 0 },
          ),
          catch: (cause) => cause,
        }));
        if (verdict._tag === "Failure") {
          // 终审不达标：manual → escalated（等人拍板），其余 → failed（可修后重入）
          if (overallAcceptance.type === "manual") {
            self.onEvent?.({ type: "escalated", id: spec.id, reason: "编排终审需人工验收" });
          }
          const terminal = overallAcceptance.type === "manual" ? "escalated" : "failed";
          snapshot = yield* self.persistTerminal(snapshot, terminal);
          return yield* Effect.fail(verdict.failure);
        }
      } else {
        // 无终审：reviewing 过站（迁移表要求 done 必经 reviewing）
        snapshot = self.moveTo(snapshot, "reviewing");
      }

      // 终态 done
      snapshot = self.moveTo(snapshot, "done");
      yield* Effect.tryPromise({ try: () => self.stateStore.save(snapshot), catch: (c) => c });

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
  // 完整管线：executor 调用（per-task timeout 硬约束）
  //   → 产出校验（per-task token 预算，事后判——LLM 无法事前精确控制消耗）
  //   → 验收（critic 对照 acceptance：manual 直接升级人工；不达标打回重做或按策略降级）
  //   → 失败按策略分支（retry 按 isRetriable 判定——确定性失败不浪费重试）
  // ─────────────────────────────────────────────────────────────────────
  private executeWithStrategy(
    task: TaskSpec,
    budget: Budget,
    upstream: Map<string, string>,
    orchestrationId: string,
  ): Effect.Effect<TaskOutput, unknown> {
    const self = this;
    return Effect.gen(function* () {
      let attempts = 0;
      for (;;) {
        // executor 调用：per-task maxDurationMs → Effect.timeout（虚拟时钟友好）
        // Effect 4：timeout 超时抛 TimeoutError（_tag 判别）；错误通道是 unknown，
        // 用 Effect.catch 显式判 tag（catchTag 需要可窄化的 tagged 错误通道）
        const baseAttempt = Effect.tryPromise({
          try: () => self.executor.execute(task, { budget, upstream, signal: undefined }),
          catch: (cause) => cause,
        });
        const guarded = task.maxDurationMs !== undefined
          ? baseAttempt.pipe(
              Effect.timeout(Duration.millis(task.maxDurationMs)),
              Effect.catch((err: unknown) =>
                (err as { _tag?: string } | null)?._tag === "TimeoutError"
                  ? Effect.fail(new Error(
                      `子任务「${task.title}」执行超时（maxDurationMs=${task.maxDurationMs}）`,
                    ))
                  : Effect.fail(err),
              ),
            )
          : baseAttempt;

        const outcome = yield* Effect.result(guarded);

        // 归一：executor 错误 / per-task token 超限 → 统一进失败分支
        let failure: unknown = null;
        let output: TaskOutput | null = null;
        if (outcome._tag === "Success") {
          const cand = outcome.success;
          if (task.maxTokens !== undefined && cand.tokensUsed > task.maxTokens) {
            failure = new Error(
              `子任务「${task.title}」消耗 ${cand.tokensUsed} tokens，超出本任务预算 ${task.maxTokens}`,
            );
          } else {
            output = cand;
          }
        } else {
          failure = outcome.failure;
        }

        // 验收接线：产出先过 critic（manual 直接升级人工；不达标打回重做或按策略降级）
        if (output !== null && task.acceptance && task.acceptance.type !== "none") {
          const accepted = output; // 提取 const：闭包内 TS 窄化不跨变量赋值
          const acceptance = task.acceptance;
          const review = yield* Effect.result(Effect.tryPromise({
            try: () => self.critic.review(task, acceptance, accepted),
            catch: (cause) => cause,
          }));
          if (review._tag === "Failure") {
            if (acceptance.type === "manual") {
              // 需人工拍板 → 升级（不重试不降级：产出本身没问题，是流程要求人）
              self.onEvent?.({ type: "escalated", id: orchestrationId, reason: `「${task.title}」需人工验收` });
              return yield* Effect.fail(new EscalatedError({
                message: `「${task.title}」需人工验收（acceptance.type=manual）`,
              }));
            }
            failure = review.failure; // contains / llm-judge 不达标 → 打回重做或按策略降级
            output = null;
          }
        }

        if (output !== null) return output;

        // ── 失败分支（executor 错误 / per-task 预算超限 / 验收不达标）──
        attempts += 1;
        const err = failure!;
        const message = err instanceof Error ? err.message : String(err);
        self.onEvent?.({ type: "task-failed", id: orchestrationId, taskId: task.id, message });

        if (err instanceof BudgetExceededError) return yield* Effect.fail(err);

        if (self.failurePolicy.onFail === "escalate") {
          self.onEvent?.({ type: "escalated", id: orchestrationId, reason: message });
          return yield* Effect.fail(new EscalatedError({ message: `「${task.title}」升级人工：${message}` }));
        }

        if (self.failurePolicy.onFail === "compensate" && self.failurePolicy.compensate !== undefined) {
          yield* Effect.tryPromise({ try: () => self.failurePolicy.compensate!([]), catch: (c) => c });
          return yield* Effect.fail(err);
        }

        if (self.failurePolicy.onFail === "retry" && attempts < self.retryPolicy.maxAttempts) {
          // 可重试判定（与 policies.ts 口径一致）：RetriableError 恒重试（instanceof 判
          // TaggedError——err.name 是 "Error"，旧版的 name 检查是恒 false 的死代码）；
          // 其余交给策略判定——确定性失败（4xx/校验）不浪费重试
          const retriable = err instanceof RetriableError || self.retryPolicy.isRetriable(err);
          if (retriable) {
            // Effect.sleep：退避走运行时时钟——TestClock 下零等待，测试不真睡
            yield* Effect.sleep(Duration.millis(backoffDelay(self.retryPolicy, attempts)));
            continue;
          }
          // 不可重试 → 直接降级（不再空转）
        }

        // degrade（或 retry 耗尽/不可重试后的降级）：占位产出，调用方据此判断哪些子任务被降级
        upstream.set(task.id, `（子任务「${task.title}」执行失败已降级跳过）`);
        return { taskId: task.id, text: `（降级跳过）`, tokensUsed: 0, durationMs: 0, steps: 0 };
      }
    });
  }
}
