// orchestrator.spec.ts —— 编排器（Effect 版）离线单测：
// 状态机守护 / 失败四分支 / 预算超支 / 事件断言 / 断点续跑 / DAG 顺序 / 虚拟时钟。
// 全程零网络——Planner/Executor/Critic 用纯函数桩替换（接口相同的确定性实现），
// MemoryStateStore 用真品（纯内存无副作用）。
//
// 两类出口分别覆盖：
// - runAsync()（Promise 桥接）：既有调用方语义不变（rejects.toThrow 照常工作）
// - run()（Effect 原生）：Effect.runPromise + TestClock 虚拟时钟（退避零等待）
import { describe, expect, it } from "vitest";
import { Effect, Duration, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { Acceptance, TaskOutput, TaskSpec } from "../src/orchestrator/types.js";
import { Budget } from "../src/orchestrator/types.js";
import { BudgetExceededError, IllegalTransitionError, AcceptanceFailedError } from "../src/orchestrator/errors.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MemoryStateStore, transition } from "../src/orchestrator/state-store.js";
import type { Executor, Planner } from "../src/orchestrator/roles.js";

/** 确定性桩：产出固定文本 */
const stubOutput = (taskId: string, text: string, tokensUsed = 100): TaskOutput => ({
  taskId, text, tokensUsed, durationMs: 1, steps: 1,
});

const stubSpec: TaskSpec = { id: "t1", title: "子任务 1", goal: "做一件事" };
const stubSpec2: TaskSpec = { id: "t2", title: "子任务 2", goal: "做另一件事" };

// —— 三角色确定性桩 ——
const stubPlanner: Planner = {
  plan: async (goal) => [stubSpec, stubSpec2],
};
const stubExecutor: Executor = {
  execute: async (task) => stubOutput(task.id, `${task.title} 完成`),
};
const stubCritic = { review: async () => {} }; // 默认通过

function makeOrchestrator(overrides: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  return new Orchestrator(overrides);
}

describe("Orchestrator（Effect 版）：状态机与流程", () => {
  it("happy path：静态任务单 → executing → done，产出汇总正确，快照持久化", async () => {
    const store = new MemoryStateStore();
    const orch = makeOrchestrator({
      stateStore: store,
      planner: stubPlanner,
      executor: stubExecutor,
      critic: stubCritic,
    });

    const result = await orch.runAsync({
      id: "orch-1",
      goal: "做一件事",
      tasks: [stubSpec],
      acceptance: { type: "contains", anyOf: ["完成"] },
    });

    expect(result.state).toBe("done");
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]?.taskId).toBe("t1");
    expect(result.summary).toContain("完成");

    const snap = await store.load("orch-1");
    expect(snap?.state).toBe("done");
    expect(snap?.outputs).toHaveLength(1);
  });

  it("动态规划：无任务单 → planner 生成子任务清单", async () => {
    const orch = makeOrchestrator({ planner: stubPlanner, executor: stubExecutor });
    const result = await orch.runAsync({ id: "orch-2", goal: "做一件事", tasks: [] });
    expect(result.state).toBe("done");
    expect(result.outputs).toHaveLength(2); // planner 拆了两个子任务
  });

  it("Effect 原生出口：run() 经 Effect.runPromise 消费，结果与 Promise 出口一致", async () => {
    const orch = makeOrchestrator({ planner: stubPlanner, executor: stubExecutor });
    const result = await Effect.runPromise(
      orch.run({ id: "orch-effect", goal: "做一件事", tasks: [stubSpec] }),
    );
    expect(result.state).toBe("done");
    expect(result.outputs).toHaveLength(1);
  });

  it("DAG 顺序：b 依赖 a → a 先完成 b 才派发", async () => {
    const order: string[] = [];
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: {
        execute: async (task) => {
          order.push(task.id);
          return stubOutput(task.id, `${task.title} 完成`);
        },
      },
    });
    await orch.runAsync({
      id: "orch-dag",
      goal: "",
      tasks: [stubSpec, { ...stubSpec2, dependsOn: ["t1"] }],
    });
    expect(order).toEqual(["t1", "t2"]); // 依赖未解锁前不派发
  });

  it("状态机非法迁移：pending → done 不经过 executing → 抛 IllegalTransitionError", () => {
    const snap = {
      id: "x", goal: "", state: "pending" as const,
      outputs: [], createdAt: 0, updatedAt: 0,
    };
    expect(() => transition(snap, "done")).toThrow(IllegalTransitionError);
    // 合法迁移不受影响：pending → executing 是表内路径
    expect(() => transition(snap, "executing")).not.toThrow();
  });
});

describe("Orchestrator（Effect 版）：失败策略四分支", () => {
  const failingExecutor: Executor = {
    execute: async () => { throw new Error("子任务执行失败"); },
  };

  it("retry 分支：重试耗尽 → 降级跳过（占位产出，后续子任务继续）", async () => {
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: failingExecutor,
      failurePolicy: { onFail: "retry" },
    });

    const result = await orch.runAsync({
      id: "orch-retry",
      goal: "测试重试",
      tasks: [stubSpec, stubSpec2], // t2 应该不受 t1 失败影响
    });

    expect(result.state).toBe("done"); // 降级不终止编排
    expect(result.outputs).toHaveLength(2);
    for (const output of result.outputs) {
      expect(output.text).toContain("降级跳过"); // 每个降级子任务都带可读占位文本
    }
  });

  it("degrade 分支：失败降级跳过（不重试）", async () => {
    let calls = 0;
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: { execute: async () => { calls += 1; throw new Error("挂了"); } },
      failurePolicy: { onFail: "degrade" },
    });

    await orch.runAsync({ id: "orch-degrade", goal: "测试降级", tasks: [stubSpec] });
    expect(calls).toBe(1); // 只调一次（degrade 不重试）
  });

  it("escalate 分支：失败升级人工 → 上抛 + escalated 事件", async () => {
    const escalated: string[] = [];
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: failingExecutor,
      failurePolicy: { onFail: "escalate" },
      onEvent: (event) => { if (event.type === "escalated") escalated.push(event.reason); },
    });

    await expect(
      orch.runAsync({ id: "orch-esc", goal: "测试升级", tasks: [stubSpec] }),
    ).rejects.toThrow("子任务执行失败");
    expect(escalated.length).toBe(1); // 事件已发出
  });

  it("compensate 分支：补偿钩子被调用后上抛", async () => {
    let compensated = false;
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: failingExecutor,
      failurePolicy: {
        onFail: "compensate",
        compensate: async () => { compensated = true; },
      },
    });

    await expect(
      orch.runAsync({ id: "orch-comp", goal: "测试补偿", tasks: [stubSpec] }),
    ).rejects.toThrow();
    expect(compensated).toBe(true);
  });
});

describe("Orchestrator（Effect 版）：预算控制", () => {
  it("executor 抛 BudgetExceededError → 原样穿透上抛（预算是控制信号）", async () => {
    const tightBudget = new Budget(10, 60_000); // token 上限 10
    const orch = makeOrchestrator({
      stateStore: { save: async () => {}, load: async () => undefined },
      executor: { execute: async (task) => {
        if (tightBudget.tokensLeft <= 0) throw new BudgetExceededError({ message: "超支" });
        tightBudget.spend(200); // 每次超支
        return stubOutput(task.id, "产出");
      }},
    });

    await expect(orch.runAsync({
      id: "orch-budget",
      goal: "测试预算",
      tasks: [stubSpec, stubSpec2],
      maxTokens: 10,
    })).rejects.toThrow(BudgetExceededError);
  });

  it("波次间预算检查：墙钟耗尽 → 编排器主动失败（不依赖 executor 自觉）", async () => {
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: stubExecutor,
    });
    // maxDurationMs = -1 → Budget 构造即已超时 → 第一波之前就被预算闸拦下
    //（-1 而非 0：消除「同一毫秒内 Date.now() > deadline 不成立」的竞态）
    await expect(
      orch.runAsync({ id: "orch-wall", goal: "", tasks: [stubSpec], maxDurationMs: -1 }),
    ).rejects.toThrow(BudgetExceededError);
  });
});

describe("Orchestrator（Effect 版）：断点续跑", () => {
  it("同 id 重入：已完成子任务跳过，未完成的继续执行", async () => {
    const store = new MemoryStateStore();
    let executeCalls = 0;

    const executor: Executor = {
      execute: async (task) => {
        executeCalls += 1;
        return stubOutput(task.id, `${task.title} 完成`);
      },
    };

    // 第一轮：执行 t1
    const orch1 = makeOrchestrator({ stateStore: store, executor });
    await orch1.runAsync({ id: "orch-resume", goal: "测试续跑", tasks: [stubSpec] });
    expect(executeCalls).toBe(1);

    // 第二轮：t1 已完成跳过，t2 新任务真执行
    const orch2 = makeOrchestrator({ stateStore: store, executor });
    await orch2.runAsync({
      id: "orch-resume",
      goal: "继续",
      tasks: [stubSpec, stubSpec2],
    });
    expect(executeCalls).toBe(2);
  });
});

describe("Orchestrator（Effect 版）：虚拟时钟（TestClock）", () => {
  it("重试退避走 Effect.sleep：TestClock 下零真实等待，重试逻辑完整执行", async () => {
    let calls = 0;
    const flaky: Executor = {
      execute: async (task) => {
        calls += 1;
        if (calls < 3) throw new Error("暂时性失败");
        return stubOutput(task.id, "第三次成功");
      },
    };
    // 退避基数 60 秒——真时钟会睡 90 秒；TestClock 虚拟推进零等待
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: flaky,
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 60_000, isRetriable: () => true },
      failurePolicy: { onFail: "retry" },
    });

    const program = Effect.gen(function* () {
      // forkChild 后台跑编排（重试会在 Effect.sleep 上挂起等时钟）
      const fiber = yield* Effect.forkChild(
        orch.run({ id: "orch-clock", goal: "", tasks: [stubSpec] }),
      );
      // 虚拟时钟推进 150 秒：覆盖第 1、2 次退避（60s + 60s 全抖动上限）
      yield* TestClock.adjust(Duration.millis(150_000));
      return yield* Fiber.join(fiber);
    });

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(TestClock.layer())));
    expect(exit._tag).toBe("Success");
    if (exit._tag === "Success") {
      expect(exit.value.state).toBe("done");
      expect(exit.value.outputs[0]?.text).toContain("第三次成功");
    }
    expect(calls).toBe(3); // 前两次失败 + 第三次成功，重试链路完整
  });
});

// ─────────────────────────────────────────────────────────────────────
// 以下为「验收闭环 + 失败终态 + 事件流 + per-task 预算」补强测试（复查修复配套）
// 桩 critic 模拟 AcceptanceCritic 的判定行为（不调 LLM）：
//   manual → 抛（需人工）；contains → 关键词不命中抛（不达标）；其余放行
// ─────────────────────────────────────────────────────────────────────
const judgingCritic = {
  review: async (task: TaskSpec, acceptance: Acceptance, output: TaskOutput): Promise<void> => {
    if (acceptance.type === "manual") {
      throw new AcceptanceFailedError({ message: `「${task.title}」需人工验收`, detail: "acceptance.type=manual" });
    }
    if (acceptance.type === "contains" && !acceptance.anyOf.some((k: string) => output.text.includes(k))) {
      throw new AcceptanceFailedError({
        message: `「${task.title}」产出未包含任何预期关键词（${acceptance.anyOf.join(" / ")}）`,
        detail: output.text.slice(0, 200),
      });
    }
  },
};

describe("Orchestrator（Effect 版）：验收闭环（critic 接线）", () => {
  it("contains 验收通过 → 正常 done", async () => {
    const orch = makeOrchestrator({ planner: stubPlanner, executor: stubExecutor, critic: judgingCritic });
    const result = await orch.runAsync({
      id: "orch-acc-pass", goal: "", tasks: [stubSpec],
      acceptance: { type: "contains", anyOf: ["完成"] }, // stubExecutor 产出含「完成」
    });
    expect(result.state).toBe("done");
  });

  it("contains 验收不通过 → 打回重做 → 耗尽降级（验收失败走失败策略）", async () => {
    let calls = 0;
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: { execute: async (task) => { calls += 1; return stubOutput(task.id, "普通产出"); } },
      critic: judgingCritic,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, isRetriable: () => true },
      failurePolicy: { onFail: "retry" },
    });
    const result = await orch.runAsync({
      id: "orch-acc-fail", goal: "",
      tasks: [{ ...stubSpec, acceptance: { type: "contains", anyOf: ["罕见词XYZ"] } }], // task 级验收
    });
    expect(calls).toBe(2); // 首次 + 打回重做 1 次（maxAttempts=2）
    expect(result.outputs[0]?.text).toContain("降级跳过");
  });

  it("manual 验收 → 升级人工：EscalatedError 上抛 + 快照落 escalated + 事件", async () => {
    const store = new MemoryStateStore();
    const escalated: string[] = [];
    const orch = makeOrchestrator({
      stateStore: store,
      planner: stubPlanner,
      executor: stubExecutor,
      critic: judgingCritic,
      onEvent: (e) => { if (e.type === "escalated") escalated.push(e.reason); },
    });
    await expect(orch.runAsync({
      id: "orch-manual", goal: "", tasks: [{ ...stubSpec, acceptance: { type: "manual" } }],
    })).rejects.toThrow("需人工验收");

    const snap = await store.load("orch-manual");
    expect(snap?.state).toBe("escalated"); // 终态可见：外部能看到「卡在等人」
    expect(escalated).toHaveLength(1);
  });

  it("编排级终审（spec.acceptance）不通过 → failed 终态 + 上抛", async () => {
    const store = new MemoryStateStore();
    const orch = makeOrchestrator({
      stateStore: store,
      planner: stubPlanner,
      executor: stubExecutor,
      critic: judgingCritic,
    });
    await expect(orch.runAsync({
      id: "orch-overall", goal: "", tasks: [stubSpec],
      acceptance: { type: "contains", anyOf: ["罕见词XYZ"] },
    })).rejects.toThrow("未包含任何预期关键词");
    const snap = await store.load("orch-overall");
    expect(snap?.state).toBe("failed"); // 终审不过落 failed（修后重入合法）
  });
});

describe("Orchestrator（Effect 版）：失败终态落盘与重入", () => {
  it("budget 超支 → 快照落 failed → 同 id 重入合法（不再炸 IllegalTransitionError）", async () => {
    const store = new MemoryStateStore();
    const tightBudget = new Budget(10, 60_000);
    const executor: Executor = { execute: async (task) => {
      if (tightBudget.tokensLeft <= 0) throw new BudgetExceededError({ message: "超支" });
      tightBudget.spend(200); // 每次消耗 200——两个任务并行，第二个必超支
      return stubOutput(task.id, "产出");
    }};
    const orch = makeOrchestrator({ stateStore: store, executor });

    await expect(orch.runAsync({
      id: "orch-terminal", goal: "", tasks: [stubSpec, stubSpec2], maxTokens: 10,
    })).rejects.toThrow(BudgetExceededError);
    expect((await store.load("orch-terminal"))?.state).toBe("failed");

    // 重入：failed → executing 是表内迁移，不再抛 IllegalTransitionError
    const orch2 = makeOrchestrator({
      stateStore: store,
      executor: { execute: async (task) => stubOutput(task.id, "重来一次成功") },
    });
    const result = await orch2.runAsync({ id: "orch-terminal", goal: "", tasks: [stubSpec] });
    expect(result.state).toBe("done");
  });

  it("escalate 失败 → 快照落 escalated（状态可见，不再停留在虚假的 executing）", async () => {
    const store = new MemoryStateStore();
    const orch = makeOrchestrator({
      stateStore: store,
      planner: stubPlanner,
      executor: { execute: async () => { throw new Error("挂"); } },
      failurePolicy: { onFail: "escalate" },
    });
    await expect(
      orch.runAsync({ id: "orch-esc-snap", goal: "", tasks: [stubSpec] }),
    ).rejects.toThrow();
    expect((await store.load("orch-esc-snap"))?.state).toBe("escalated");
  });
});

describe("Orchestrator（Effect 版）：事件流与边界", () => {
  it("state-changed 完整链：pending→executing→reviewing→done（静态任务单不过 planning）", async () => {
    const events: string[] = [];
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: stubExecutor,
      onEvent: (e) => { if (e.type === "state-changed") events.push(`${e.from}→${e.to}`); },
    });
    await orch.runAsync({ id: "orch-events", goal: "", tasks: [stubSpec] });
    expect(events).toEqual(["pending→executing", "executing→reviewing", "reviewing→done"]);
  });

  it("task-completed 事件：每个子任务完成都发（含产出与消耗）", async () => {
    const completed: { taskId: string; tokensUsed: number }[] = [];
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: stubExecutor,
      onEvent: (e) => { if (e.type === "task-completed") completed.push({ taskId: e.taskId, tokensUsed: e.tokensUsed }); },
    });
    await orch.runAsync({ id: "orch-tc", goal: "", tasks: [stubSpec] });
    expect(completed).toEqual([{ taskId: "t1", tokensUsed: 100 }]);
  });

  it("循环依赖：dispatch 前拒绝（有环的 DAG 无法完成）", async () => {
    const orch = makeOrchestrator({ planner: stubPlanner, executor: stubExecutor });
    await expect(orch.runAsync({
      id: "orch-cycle", goal: "",
      tasks: [
        { id: "a", title: "a", goal: "", dependsOn: ["b"] },
        { id: "b", title: "b", goal: "", dependsOn: ["a"] },
      ],
    })).rejects.toThrow("任务依赖存在循环");
  });

  it("abort 软着陆：预先中止 → 零派发 + 空产出 + 正常返回（不报错）", async () => {
    const controller = new AbortController();
    const executed: string[] = [];
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: { execute: async (task) => { executed.push(task.id); return stubOutput(task.id, `${task.title} 完成`); } },
    });
    controller.abort(); // 预先中止：第一波派发前就触发软着陆
    const result = await orch.runAsync(
      { id: "orch-abort", goal: "", tasks: [stubSpec, stubSpec2] },
      controller.signal,
    );
    expect(executed).toHaveLength(0); // 已中止 → 不派发任何子任务
    expect(result.outputs).toHaveLength(0);
    expect(result.state).toBe("done"); // 软着陆：不报错，产出为空
  });
});

describe("Orchestrator（Effect 版）：per-task 预算接线", () => {
  it("task.maxDurationMs：executor 超时 → 按失败走策略 → 降级占位", async () => {
    const slow: Executor = { execute: async (task) => {
      await new Promise((r) => setTimeout(r, 80)); // 比 per-task 超时长
      return stubOutput(task.id, "太慢了");
    }};
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: slow,
      failurePolicy: { onFail: "degrade" },
    });
    const result = await orch.runAsync({
      id: "orch-task-timeout", goal: "",
      tasks: [{ ...stubSpec, maxDurationMs: 10 }],
    });
    expect(result.outputs[0]?.text).toContain("降级跳过");
  });

  it("task.maxTokens：产出消耗超本任务预算 → 按失败走策略 → 降级", async () => {
    const greedy: Executor = { execute: async (task) => stubOutput(task.id, "产出", 5_000) };
    const orch = makeOrchestrator({
      planner: stubPlanner,
      executor: greedy,
      failurePolicy: { onFail: "degrade" },
    });
    const result = await orch.runAsync({
      id: "orch-task-tokens", goal: "",
      tasks: [{ ...stubSpec, maxTokens: 100 }],
    });
    expect(result.outputs[0]?.text).toContain("降级跳过");
  });
});

describe("Orchestrator（Effect 版）：动态规划断点续跑", () => {
  it("重入复用快照任务单：planner 只调一次，重入不再规划、产出不重复执行", async () => {
    const store = new MemoryStateStore();
    let plannerCalls = 0;
    const planner: Planner = { plan: async () => {
      plannerCalls += 1;
      return [stubSpec, { ...stubSpec2, dependsOn: ["t1"] }];
    }};
    const executed: string[] = [];
    const executor: Executor = { execute: async (task) => {
      executed.push(task.id);
      return stubOutput(task.id, `${task.title} 完成`);
    }};

    // 第一轮：动态规划（空任务单）→ planner 拆单并存入快照 → 全部执行
    const orch1 = makeOrchestrator({ stateStore: store, planner, executor });
    await orch1.runAsync({ id: "orch-dyn", goal: "", tasks: [] });
    expect(plannerCalls).toBe(1);
    expect(executed).toEqual(["t1", "t2"]);

    // 第二轮：同 id 重入、仍传空任务单 → 复用快照任务单（taskId 稳定），planner 不再被调
    const orch2 = makeOrchestrator({ stateStore: store, planner, executor });
    const resumed = await orch2.runAsync({ id: "orch-dyn", goal: "", tasks: [] });
    expect(plannerCalls).toBe(1); // 断点续跑：不再规划
    expect(resumed.state).toBe("done");
    expect(executed).toEqual(["t1", "t2"]); // 重入全部跳过（已在快照 outputs 里）
  });
});
