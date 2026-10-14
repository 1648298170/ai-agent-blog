// team-assembly.ts —— team 场景的编排器标准装配：demo 工具 + 知识库检索过幂等壳，
// 角色用 engine 默认三件套（可注入覆盖）。
//
// 为什么在 engine 而不是各端：cli 的 `pnpm team` 与 api 的 `/api/team/stream`
// 消费同一个编排场景——装配逻辑（工具表怎么包壳、角色怎么默认）放两份迟早漂移
//（先例：supervisor/handoff 产品核心上移引擎包，CLI 与 HTTP API 共用同一套）。
// 各端只做「入口的事」：cli 管参数与 REPL 输出，api 管 SSE 帧与断连。
//
// 可注入设计（依赖倒置）：测试注入桩三件套即可离线测编排协议（team.spec 实测），
// 生产走 LLM 默认实现（LlmPlanner / LoopExecutor / AcceptanceCritic）。
import { AcceptanceCritic, LlmPlanner, LoopExecutor } from "./defaults.js";
import { Orchestrator } from "./orchestrator.js";
import { MemoryStateStore } from "./state-store.js";
import { createDemoTools, searchKnowledgeBase } from "../tools/index.js";
import { createIdempotencyRegistryFromEnv, wrapToolsWithIdempotencyAuto } from "../tools/index.js";
import type { AgentToolSet } from "../types.js";
import type { OrchestratorOptions, OrchestrationEvent, OrchestrationResult } from "./index.js";

/** 编排事件 → [图标, 文本]（cli/api 共用的展示映射；返回 null = 不展示） */
export function mapEventToTrace(event: OrchestrationEvent): [string, string] | null {
  switch (event.type) {
    case "state-changed":
      return ["🧭", `编排 ${event.id} 状态：${event.from} → ${event.to}`];
    case "task-completed":
      // 降级占位（「（降级跳过）」）不是真完成——用 ⚠ 而非 ✓，避免观察者误读
      if (event.text.includes("（降级跳过）")) {
        return ["⚠", `子任务 ${event.taskId} 降级跳过（重试耗尽或验收未过，占位产出续链）`];
      }
      return [
        "✓",
        `子任务 ${event.taskId} 完成（产出 ${event.text.length} 字，消耗 ${event.tokensUsed} tokens）`,
      ];
    case "task-failed":
      return ["✗", `子任务 ${event.taskId} 失败：${event.message}`];
    case "escalated":
      return ["⚠", `升级人工：${event.reason}`];
    case "interrupted":
      return ["⏸", `编排中止（软着陆）：已完成 ${event.completedCount}，剩余 ${event.remainingCount}`];
    default:
      return null;
  }
}

/** Orchestrator 构造参数里可被测试覆盖的角色位 */
export interface TeamOverrides {
  planner?: OrchestratorOptions["planner"];
  executor?: OrchestratorOptions["executor"];
  critic?: OrchestratorOptions["critic"];
  stateStore?: OrchestratorOptions["stateStore"];
}

export interface TeamAssembly {
  orchestrator: Orchestrator;
}

/** 幂等 scope 固定 "team" 的语义取舍：幂等键 = scope + 工具 + 参数指纹——固定 scope 让
 *  「10 分钟窗口内跨编排的同参调用」直接命中缓存（如两次编排都查 A-1024、同 subject
 *  建单），防重复写正是幂等的本意；要按编排隔离时把 scope 换成编排 id。 */
export const TEAM_IDEMPOTENCY_SCOPE = "team";

/** 装配编排器：角色用 engine 默认三件套（可注入覆盖），工具表过幂等壳 */
export function assembleTeamOrchestrator(options: {
  traceSink?: (event: OrchestrationEvent) => void;
  overrides?: TeamOverrides;
  /** 工具表覆盖（测试可注空表；默认 demo 三件套 + 知识库检索） */
  tools?: AgentToolSet;
}): TeamAssembly {
  const overrides = options.overrides ?? {};
  const tools: AgentToolSet = { ...createDemoTools(), searchKnowledgeBase, ...(options.tools ?? {}) };
  const idempotency = createIdempotencyRegistryFromEnv();
  const wrapped = wrapToolsWithIdempotencyAuto(tools, idempotency, { scope: TEAM_IDEMPOTENCY_SCOPE });

  const orchestrator = new Orchestrator({
    planner: overrides.planner ?? new LlmPlanner(),
    executor:
      overrides.executor ??
      new LoopExecutor({
        tools: wrapped,
        systemPrompt:
          "你是任务执行者。按子任务目标调用可用工具完成它，产出具体结果；" +
          "目标里引用了前置产出时直接基于它推进，不要重复执行前置任务。",
        maxSteps: 5,
      }),
    critic: overrides.critic ?? new AcceptanceCritic(),
    stateStore: overrides.stateStore ?? new MemoryStateStore(),
    onEvent: options.traceSink,
  });
  return { orchestrator };
}

/** 编排结果 → 汇总文本（CLI 打印与 API done 事件共用） */
export function summarizeTeamResult(result: OrchestrationResult): string {
  return (
    result.outputs.map((o) => `—— ${o.taskId} ——\n${o.text.trim() || "（无产出）"}`).join("\n\n") ||
    "（无子任务产出）"
  );
}
