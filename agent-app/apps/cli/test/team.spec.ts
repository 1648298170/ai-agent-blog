// team.spec.ts —— team CLI 的离线单测：事件映射 / 参数解析 / plan 校验 / 桩角色装配全链路。
// 铁律同全项目：零网络——planner/executor/critic 注入确定性桩，编排器本体用真品
//（真编排器 + 假角色 = 测的是「编排协议」而非角色质量，与 orchestrator.spec 的分工互补：
// 那边测编排语义，这边测 CLI 装配层把角色和编排器接对了）。
import { describe, expect, it } from "vitest";
import { assembleTeamOrchestrator } from "@agent-app/engine/orchestrator";
import { parseArgs, validatePlanFile } from "../src/apps/team/cli.js";
import { mapEventToTrace } from "@agent-app/engine/orchestrator";
import type { OrchestrationEvent, TaskOutput, TaskSpec } from "@agent-app/engine/orchestrator";

// ── parseArgs ──

describe("parseArgs", () => {
  it("动态模式：位置参数即目标", () => {
    const o = parseArgs(["查订单状态"]);
    expect(o?.goal).toBe("查订单状态");
    expect(o?.planFile).toBeUndefined();
    expect(o?.trace).toBe(false);
  });

  it("静态模式：--plan 指定任务单（goal 可省）", () => {
    const o = parseArgs(["--plan", "plan.json", "--trace"]);
    expect(o?.planFile).toBe("plan.json");
    expect(o?.trace).toBe(true);
  });

  it("--id / --max-tokens 覆盖", () => {
    const o = parseArgs(["目标", "--id", "my-orch", "--max-tokens", "2000"]);
    expect(o?.orchestrationId).toBe("my-orch");
    expect(o?.maxTokens).toBe(2000);
  });

  it("无目标且无 --plan → undefined（用法提示）", () => {
    expect(parseArgs([])).toBeUndefined();
    expect(parseArgs(["--trace"])).toBeUndefined();
  });
});

// ── validatePlanFile ──

describe("validatePlanFile", () => {
  const validPlan = {
    goal: "查订单并建工单",
    tasks: [
      { id: "t1", title: "查", goal: "查询" },
      { id: "t2", title: "建", goal: "建单", dependsOn: ["t1"] },
    ],
  };

  it("合法任务单通过并保留验收标准", () => {
    const plan = validatePlanFile({
      goal: "x",
      tasks: [{ id: "t1", goal: "g", acceptance: { type: "contains", anyOf: ["已发货"] } }],
    });
    expect(plan.tasks[0]?.acceptance).toEqual({ type: "contains", anyOf: ["已发货"] });
  });

  it("缺 goal / 空 tasks → 中文报错", () => {
    expect(() => validatePlanFile({ tasks: validPlan.tasks })).toThrow(/goal/);
    expect(() => validatePlanFile({ goal: "x", tasks: [] })).toThrow(/tasks/);
  });

  it("acceptance.type 白名单外 → 中文报错（坏数据进编排器前拦截）", () => {
    expect(() =>
      validatePlanFile({
        goal: "x",
        tasks: [{ id: "t1", goal: "g", acceptance: { type: "bogus" } }],
      }),
    ).toThrow(/acceptance\.type/);
  });

  it("全量合法任务单往返", () => {
    const plan = validatePlanFile(validPlan);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]?.dependsOn).toEqual(["t1"]);
  });
});

// ── mapEventToTrace ──

describe("mapEventToTrace", () => {
  const base = { id: "orch-1" } as const;

  it("五类事件各映射到编排图标（⚠⏸ 为编排新增）", () => {
    expect(mapEventToTrace({ type: "state-changed", ...base, from: "pending", to: "executing" })).toEqual([
      "🧭",
      "编排 orch-1 状态：pending → executing",
    ]);
    expect(
      mapEventToTrace({ type: "task-completed", ...base, taskId: "t1", text: "产出", tokensUsed: 7 }),
    ).toEqual(["✓", "子任务 t1 完成（产出 2 字，消耗 7 tokens）"]);
    expect(mapEventToTrace({ type: "task-failed", ...base, taskId: "t1", message: "挂了" })).toEqual([
      "✗",
      "子任务 t1 失败：挂了",
    ]);
    expect(mapEventToTrace({ type: "escalated", ...base, reason: "需人工" })).toEqual([
      "⚠",
      "升级人工：需人工",
    ]);
    expect(mapEventToTrace({ type: "interrupted", ...base, completedCount: 2, remainingCount: 1 })).toEqual([
      "⏸",
      "编排中止（软着陆）：已完成 2，剩余 1",
    ]);
  });

  it("降级占位的 task-completed → ⚠ 展示（不误读为真完成）", () => {
    expect(
      mapEventToTrace({
        type: "task-completed",
        ...base,
        taskId: "t2",
        text: "（降级跳过）",
        tokensUsed: 0,
      }),
    ).toEqual(["⚠", "子任务 t2 降级跳过（重试耗尽或验收未过，占位产出续链）"]);
  });
});

// ── 桩角色全链路：CLI 装配层把「角色 + 编排器」接对 ──

describe("assembleTeamOrchestrator：桩角色离线全链路", () => {
  const stubSpec: TaskSpec = { id: "t1", title: "子任务", goal: "做一件事" };
  const stubOutput = (taskId: string, text: string): TaskOutput => ({
    taskId,
    text,
    tokensUsed: 10,
    durationMs: 1,
    steps: 1,
  });

  it("注入桩三件套 → runAsync 真编排器完整跑通（拆派跑协议 + 事件 + 快照）", async () => {
    const events: string[] = [];
    const { MemoryStateStore } = await import("@agent-app/engine/orchestrator");
    const store = new MemoryStateStore();

    const { orchestrator } = assembleTeamOrchestrator({
      traceSink: (e: OrchestrationEvent) => events.push(e.type),
      overrides: {
        planner: { plan: async () => [stubSpec] },
        executor: { execute: async (task) => stubOutput(task.id, `${task.title} 完成`) },
        critic: { review: async () => {} },
        stateStore: store,
      },
    });

    const result = await orchestrator.runAsync({ id: "team-spec", goal: "", tasks: [stubSpec] });

    expect(result.state).toBe("done");
    expect(result.outputs[0]?.text).toContain("完成");
    // 事件流完整：executing 迁移 → 子任务完成 → reviewing 迁移 → done 迁移
    //（顺序与编排器真实发射序一致：任务在 executing 态里完成，后才进 reviewing/done）
    expect(events).toEqual(["state-changed", "task-completed", "state-changed", "state-changed"]);
    // 快照持久化（断点续跑的地基在装配后仍然工作）
    expect((await store.load("team-spec"))?.state).toBe("done");
  });
});
