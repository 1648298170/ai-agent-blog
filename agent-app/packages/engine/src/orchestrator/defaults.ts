// orchestrator/defaults.ts —— 三角色的默认实现：LLM 规划 / runToolLoop 执行 / LLM 验收。
//
// 为什么默认实现是「LLM 版」而非「纯函数版」：编排的核心场景就是「目标无法拆成
// 确定代码步骤」的开放任务——planner 与 critic 必须有智能；executor 本质是
// runToolLoop（带工具表的循环），天然复用引擎既有能力。
// 测试场景注入纯函数实现（确定性断言），生产场景注入 LLM 实现（智能决策）——
// 接口相同，按环境装配（依赖注入）。
//
// LLM 调用纪律（与 supervisor 三分类同款）：generateText + 严格 JSON 指令 +
// extractJson 宽松抽取 + zod 校验 + 失败重试一次——glm-4-flash 实测守约。
//
// Effect 化说明：本文件保持 Promise 实现（LLM SDK 是 Promise 世界）——
// 编排器负责把它们抬进 Effect。唯一改动：错误构造从位置参数改为
// TaggedError 的对象参数（message 进 props，分类字段显式化）。

import { generateText } from "ai";
import type { ToolSet } from "ai";
import { runToolLoop } from "../agent-loop.js";
import { extractJson } from "../json-utils.js";
import { getModel } from "../llm.js";
import type { Acceptance } from "./types.js";
import { AcceptanceFailedError } from "./errors.js";
import type { RoleContext } from "./roles.js";
import type { TaskOutput, TaskSpec } from "./types.js";

const PLANNER_PROMPT =
  "你是任务规划器。把用户目标拆解为有序的子任务清单。每个子任务：id 短标识、" +
  "title 一句话、goal 交给执行者的完整指令（含所需上下文）、dependsOn 依赖的前置子任务 id 列表。" +
  "只拆解、不执行；子任务不超过 5 个；输出 JSON 数组。";

/** 动态规划器：LLM 把 goal 拆成子任务单（JSON 不守约重试一次，仍失败上抛 → 编排器降级/升级） */
export class LlmPlanner {
  async plan(goal: string, ctx: RoleContext): Promise<TaskSpec[]> {
    const attempt = async (): Promise<TaskSpec[]> => {
      const { text } = await generateText({
        model: getModel(),
        system: PLANNER_PROMPT,
        messages: [{ role: "user", content: goal }],
        abortSignal: ctx.signal,
      });
      const raw = extractJson(text) as { id?: string; title?: string; goal?: string; dependsOn?: string[] }[];
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("规划器未返回任务清单");
      return raw.slice(0, 5).map((item, i) => ({
        id: item.id ?? `task-${i + 1}`,
        title: item.title ?? item.goal ?? `子任务 ${i + 1}`,
        goal: item.goal ?? "",
        dependsOn: item.dependsOn ?? [],
        acceptance: { type: "llm-judge", rubric: item.goal ?? "" } as const,
      }));
    };
    try {
      return await attempt();
    } catch {
      return await attempt();
    }
  }
}

/** 默认执行器的构造参数：工具表 + 职责提示词（构造期绑定，execute 匹配 Executor 接口） */
export interface LoopExecutorOptions {
  readonly tools: ToolSet;
  readonly systemPrompt: string;
  readonly maxSteps?: number;
}

/** 默认执行器：runToolLoop 封装——循环本体零重复，工具表与提示词由构造注入 */
export class LoopExecutor {
  private readonly tools: ToolSet;
  private readonly systemPrompt: string;
  private readonly maxSteps: number;

  constructor(options: LoopExecutorOptions) {
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 5;
  }

  async execute(task: TaskSpec, ctx: RoleContext): Promise<TaskOutput> {
    const started = Date.now();
    const upstream = [...ctx.upstream.entries()].map(([id, text]) => `【${id}】${text}`).join("\n");
    const prompt =
      `${task.goal}` + (upstream ? `\n\n前置子任务的产出（供参考，不要重复执行）：\n${upstream}` : "");

    const result = await runToolLoop({
      model: getModel(),
      messages: [{ role: "user", content: prompt }],
      system: this.systemPrompt,
      tools: this.tools,
      maxSteps: this.maxSteps,
      signal: ctx.signal,
    });

    const tokensUsed = result.usage?.totalTokens ?? 0;
    ctx.budget.spend(tokensUsed);
    return {
      taskId: task.id,
      text: result.text,
      tokensUsed,
      durationMs: Date.now() - started,
      steps: result.steps,
    };
  }
}

/** 验收器：对照 acceptance 判定产出（llm-judge / contains / manual / none）。
 *  manual 抛 AcceptanceFailedError → 编排器转 escalated（人在环路）。 */
export class AcceptanceCritic {
  async review(task: TaskSpec, acceptance: Acceptance, output: TaskOutput): Promise<void> {
    if (acceptance.type === "none") return;
    if (acceptance.type === "manual") {
      throw new AcceptanceFailedError({
        message: `「${task.title}」需人工验收`,
        detail: "acceptance.type=manual",
      });
    }
    if (acceptance.type === "contains") {
      const hit = acceptance.anyOf.some((keyword: string) => output.text.includes(keyword));
      if (!hit) {
        throw new AcceptanceFailedError({
          message: `「${task.title}」产出未包含任何预期关键词（${acceptance.anyOf.join(" / ")}）`,
          detail: output.text.slice(0, 200),
        });
      }
      return;
    }
    // llm-judge：rubric 二元判定（宁严格勿宽松——不达标打回的代价低于带病放行）
    const attempt = async (): Promise<void> => {
      const { text } = await generateText({
        model: getModel(),
        system:
          "你是验收员。对照验收标准判断产出是否达标，只输出 JSON：" +
          '{"pass": true/false, "reason": "一句话依据"}。宁可误判不达标，不可放行残次品。',
        messages: [
          {
            role: "user",
            content: `验收标准：${(acceptance as { rubric: string }).rubric}\n\n产出：\n${output.text}`,
          },
        ],
      });
      const verdict = extractJson(text) as { pass: boolean; reason?: string };
      if (verdict.pass !== true) {
        throw new AcceptanceFailedError({
          message: `「${task.title}」未通过验收：${verdict.reason ?? "无依据"}`,
          detail: output.text.slice(0, 200),
        });
      }
    };
    try {
      await attempt();
    } catch (err) {
      if (err instanceof AcceptanceFailedError) throw err; // 明确不达标：不重试
      await attempt(); // JSON 不守约是暂时性失败：重试一次
    }
  }
}
