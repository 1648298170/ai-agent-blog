// team/cli.ts —— pnpm team "目标"：多 Agent 编排的 CLI 入口（BACKLOG ② 的 pnpm team 子项）。
//
// 把 orchestrator 从「建好待接的基建件」变成可用能力。两种模式：
//   动态：pnpm team "查订单 A-1024，未发货就建催发工单"
//         → LlmPlanner 把目标拆成子任务单 → DAG 派发 → 逐任务验收
//   静态：pnpm team --plan samples/team-plan.json
//         → 跳过规划，按任务单执行（拆单结果可预期，适合演示与回归）
//
// 编排器装配（demo 工具 + 幂等壳 + 默认三角色）上移在 engine 的
// orchestrator/team-assembly.ts——cli 与 api 的 /api/team/stream 共用同一份，
// 本文件只做「入口的事」：参数解析、plan 文件校验、轨迹输出、结果打印。
//
// 两种模式都需要 LLM key：执行器的工具循环本身要模型「点名」（demo 数据免的是
// 工具侧网络，不是模型侧）。无 key → 中文配置提示后退出（同 chat 的模式）。
import { readFileSync } from "node:fs";
import { assembleTeamOrchestrator, mapEventToTrace } from "@agent-app/engine/orchestrator";
import { loadEnv } from "@agent-app/engine/config";
import { enableTrace, trace } from "@agent-app/engine/trace";
import type { OrchestrationEvent, OrchestrationResult, TaskSpec } from "@agent-app/engine/orchestrator";

// ── 参数解析 ────────────────────────────────────────────────────────────────

export interface TeamCliOptions {
  /** 动态模式的总目标（位置参数） */
  goal?: string;
  /** 静态模式：任务单 JSON 文件路径 */
  planFile?: string;
  /** 编排 id（断点续跑：同 id 重入时已完成子任务自动跳过） */
  orchestrationId: string;
  /** 全局 token 预算（缺省用编排器内置 50k） */
  maxTokens?: number;
  trace: boolean;
}

/** 解析 CLI 参数：位置参数 = 目标，--plan = 静态任务单；两者互斥、缺一即用法提示 */
export function parseArgs(args: string[]): TeamCliOptions | undefined {
  const rest = [...args];
  const options: TeamCliOptions = {
    orchestrationId: `team-${Date.now().toString(36)}`,
    trace: false,
  };
  let goal: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--plan") {
      options.planFile = rest[++i];
    } else if (arg === "--trace") {
      options.trace = true;
      enableTrace();
    } else if (arg === "--id") {
      options.orchestrationId = rest[++i] ?? options.orchestrationId;
    } else if (arg === "--max-tokens") {
      const n = Number.parseInt(rest[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) options.maxTokens = n;
    } else if (!arg.startsWith("--")) {
      goal = arg;
    }
  }
  if (options.planFile !== undefined) return options; // 静态模式：goal 可省
  if (goal === undefined || goal.trim() === "") return undefined; // 动态模式必须有目标
  options.goal = goal.trim();
  return options;
}

// ── 静态任务单校验（手写守卫：cli 零新依赖，坏数据在进编排器前拦截）──────────

/** 宽松校验任务单 JSON：结构与 OrchestrationSpec 对齐，校验失败给中文修复指引 */
export function validatePlanFile(raw: unknown): { goal: string; tasks: TaskSpec[] } {
  // 为什么 fail 返回 Error 由调用方 throw、而不是 never-returning 函数：
  // 仓库主线是 typescript@7（tsgo），对「never 返回函数调用后的控制流收窄」
  // 支持不完整——显式 throw 的控制流任何编译器都认，不为编译器预览版赌行为
  const fail = (msg: string): Error => new Error(`任务单格式不合法：${msg}（参考 samples/team-plan.json）`);
  if (typeof raw !== "object" || raw === null) throw fail("根必须是 JSON 对象");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.goal !== "string" || obj.goal.trim() === "") throw fail("缺少 goal（总目标描述）");
  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) throw fail("缺少非空 tasks 数组");

  const tasks = obj.tasks.map((item: unknown, i: number): TaskSpec => {
    if (typeof item !== "object" || item === null) throw fail(`tasks[${i}] 不是对象`);
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || t.id === "") throw fail(`tasks[${i}].id 必须是非空字符串`);
    if (typeof t.goal !== "string") throw fail(`tasks[${i}].goal 必须是字符串`);
    if (t.dependsOn !== undefined && !Array.isArray(t.dependsOn)) {
      throw fail(`tasks[${i}].dependsOn 必须是字符串数组`);
    }
    // 验收标准：type 枚举白名单（contains 需 anyOf 非空）
    if (t.acceptance !== undefined && typeof t.acceptance === "object" && t.acceptance !== null) {
      const acc = t.acceptance as Record<string, unknown>;
      const valid = ["llm-judge", "contains", "manual", "none"];
      if (!valid.includes(acc.type as string)) {
        throw fail(`tasks[${i}].acceptance.type 必须是 ${valid.join(" | ")}，收到「${String(acc.type)}」`);
      }
      if (acc.type === "contains" && (!Array.isArray(acc.anyOf) || acc.anyOf.length === 0)) {
        throw fail(`tasks[${i}].acceptance.type=contains 需要 anyOf 关键词数组`);
      }
    }
    return t as unknown as TaskSpec;
  });
  return { goal: obj.goal, tasks };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const USAGE = [
  '用法：pnpm team "<目标描述>"          动态模式：LLM 把目标拆成子任务单',
  "      pnpm team --plan <plan.json>    静态模式：按任务单执行（跳过规划）",
  "      可选：--trace   --id <编排id（断点续跑）>   --max-tokens <N>",
].join("\n");

/** 打印编排结果（汇总 + 各子任务产出） */
function printResult(result: OrchestrationResult): void {
  console.log(
    `\n◆ 编排完成（${result.id}）：${result.outputs.length} 个子任务，共消耗 ${result.totalTokensUsed} tokens\n`,
  );
  for (const output of result.outputs) {
    console.log(`—— ${output.taskId} ——`);
    console.log(output.text.trim() || "（无产出）");
    console.log();
  }
}

export async function main(args: string[] = []): Promise<void> {
  const options = parseArgs(args);
  if (options === undefined) {
    console.log(USAGE);
    return;
  }

  // 无 key 检查：动态模式的 planner、静态模式的 executor/critic 都要模型——
  // demo 数据免的是「工具侧」网络，免不了「模型侧」的点名
  const { apiKey } = loadEnv();
  if (apiKey === "") {
    console.error("尚未配置 LLM 网关：编排的规划/执行/验收都需要调用模型。");
    console.error("请复制 .env.example 为 .env 并填写 OPENAI_API_KEY（默认智谱 GLM）。");
    process.exitCode = 1;
    return;
  }

  // 静态模式：读文件 + 校验（坏数据在进编排器前拦截）
  let staticSpec: { goal: string; tasks: TaskSpec[] } | undefined;
  if (options.planFile !== undefined) {
    try {
      const raw: unknown = JSON.parse(readFileSync(options.planFile, "utf8"));
      staticSpec = validatePlanFile(raw);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  const sink = options.trace
    ? (event: OrchestrationEvent) => {
        const mapped = mapEventToTrace(event);
        if (mapped !== null) trace(mapped[0], mapped[1]);
      }
    : undefined;

  const { orchestrator } = assembleTeamOrchestrator({ traceSink: sink });

  const goal = staticSpec?.goal ?? options.goal ?? "";
  console.log(`🧩 编排目标：${goal}`);
  if (staticSpec !== undefined) {
    console.log(`   任务单：${staticSpec.tasks.length} 个子任务（静态模式，跳过规划）`);
  } else {
    console.log("   模式：动态规划（LLM 拆解子任务单）");
  }
  console.log(`   编排 id：${options.orchestrationId}（同 id 重入 = 断点续跑）\n`);

  try {
    const result = await orchestrator.runAsync(
      {
        id: options.orchestrationId,
        goal,
        tasks: staticSpec?.tasks ?? [],
        maxTokens: options.maxTokens,
      },
      undefined,
    );
    printResult(result);
  } catch (err) {
    console.error(`\n编排失败：${err instanceof Error ? err.message : String(err)}`);
    console.error("（失败终态已持久化——同 id 重入可从已完成子任务处断点续跑）");
    process.exitCode = 1;
  }
}
