// scorers/judge.ts —— LLM-as-judge 打分器（Tier 3，教程 week16 Day 2）
//
// ── 为什么是二元判定而不是数字打分 ────────────────────────────────────────
// 「给这个回答打 1~10 分」的 judge 会漂移：同一份回答今天 8 分明天 6 分，
// 分数之间没有可复现的锚点。教程 Day 2 的结论是先用二元判定（过 / 不过）：
// - 判定锚点是 rubric 条目——「条目全满足」是可核对的事实，不是主观标尺；
// - scoreJudge 评的不是回答本身，而是「judge 的判定与期望是否一致」：
//   期望通过 + 判通过 = 过；期望不通过 + 判不通过 = 过（负例判对了也是过）；
//   任何错位 = 不过。这让「judge 是不是好好先生」变成可测试的断言
//   （数据集里两个坏回答负例就是干这个的）。
//
// ── 「宁可误杀，不可放过」的校准取向 ──────────────────────────────────────
// prompt 协议明确要求：任何条目不满足、部分满足或无法确认是否满足，一律判
// pass=false。评审员犯「误放」（放过坏回答）的代价是线上事故，犯「误杀」
// （错杀好回答）的代价是评测报告里一眼可见的 FAIL——两害相权取其轻，
// 校准方向偏向严格侧，与客服场景「高危宁可转人工」的取向同构。
//
// ── 网络依赖与注入缝 ─────────────────────────────────────────────────────
// createLlmJudge 走真实 generateText + getModel()（与生产 chat 同一个模型
// 工厂，不另建客户端），temperature 0 换确定性；runner 通过 JudgeFn 注入缝
// 在单测里换假实现，零网络跑通整条编排链路。
import { generateText } from "ai";
import { extractJson } from "../../json-utils.js";
import { getModel } from "../../llm.js";
import type { ScorerOutput } from "../types.js";

/** judge 的二元判定结论：过/不过 + 一句中文依据 */
export interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

/** 评审员函数：输入问题/回答/rubric，输出二元判定（真实实现见 createLlmJudge） */
export type JudgeFn = (input: { userMessage: string; answer: string; rubric: string[] }) => Promise<JudgeVerdict>;

/** 判定值的人话渲染：报告里不出现裸 true/false，人眼不歧义 */
function formatVerdict(pass: boolean): string {
  return pass ? "通过" : "不通过";
}

/**
 * 比对期望判定与 judge 实际判定（纯函数，不做任何 IO）。
 * passed = 两者相等：负例（expectedPass=false）判出不通过同样是过——
 * 评的是「判得准不准」，不是「回答好不好」。
 */
export function scoreJudge(expectedPass: boolean, verdict: JudgeVerdict): ScorerOutput {
  const passed = verdict.pass === expectedPass;
  const detail =
    `${passed ? "判定一致" : "判定不一致"}：期望判定=${formatVerdict(expectedPass)}` +
    `，模型判定=${formatVerdict(verdict.pass)}（judge 理由：${verdict.reason}）`;
  return { passed, score: passed ? 1 : 0, detail };
}

/**
 * 构造 judge 的提示词（导出的纯函数：单测断言 prompt 内容，不碰网络）。
 * 设计要点：
 * - rubric 条目渲染成编号列表而不是埋进散文——位置偏差防护（LLM 对
 *   显式编号的逐条核对远比一段 prose 里「顺便提一句」可靠）；
 * - system 写死评审协议（只看 rubric / 宁可误杀 / 严格 JSON），user 只装
 *   本次的三个输入，协议与数据分离；
 * - 输出格式约定为单行 JSON 且禁止 markdown 围栏——但解析侧仍然宽容
 *   （见 parseJudgeVerdict），指令与解析双保险。
 */
export function buildJudgePrompt(input: { userMessage: string; answer: string; rubric: string[] }): {
  system: string;
  user: string;
} {
  const system = [
    "你是客服质量评审员（LLM-as-judge）。你的唯一任务：核对「候选回答」是否满足全部评审条目（rubric），输出二元判定。",
    "",
    "评审协议（必须严格遵守）：",
    "1. 只依据 rubric 条目逐条核对候选回答，不得引入 rubric 之外的标准——文笔、语气、篇幅一律不看；",
    "2. 全部条目都满足才能判 pass=true；任何一条不满足、只满足一半、或你无法确认是否满足，一律判 pass=false——宁可误杀，不可放过；",
    "3. 按条目编号逐条核对，前面的条目满足了不代表后面的也满足，不得放水；",
    "4. 输出严格的单行 JSON：{\"pass\": boolean, \"reason\": string}，禁止使用 markdown 代码围栏，禁止输出 JSON 以外的任何文字；",
    "5. reason 用一句中文说明判定依据；判 pass=false 时指出不满足的条目编号。",
  ].join("\n");

  const rubricLines = input.rubric.map((item, i) => `${i + 1}. ${item}`).join("\n");
  const user = [
    "【用户问题】",
    input.userMessage,
    "",
    "【候选回答】",
    input.answer,
    "",
    "【rubric 评审条目】",
    rubricLines,
    "",
    "请逐条核对以上条目，输出严格 JSON。",
  ].join("\n");

  return { system, user };
}

/**
 * 宽松解析 judge 输出：引擎的 extractJson 容忍围栏与前后废话（取第一个
 * { 到最后一个 }），此处再做形状防御——pass 不是 boolean 或整体不可解析时，
 * 判 pass=false 并在 reason 里说明（解析失败视为不通过：评审员没按协议
 * 回话本身就是不合格的判定，宁可误杀）。不用类型断言，Reflect.get 取字段。
 */
function parseJudgeVerdict(text: string): JudgeVerdict {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (err) {
    return { pass: false, reason: `judge 输出不可解析：${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { pass: false, reason: `judge 输出不可解析（不是 JSON 对象），原文摘录：${text.trim().slice(0, 120)}` };
  }
  const passValue: unknown = Reflect.get(parsed, "pass");
  const reasonValue: unknown = Reflect.get(parsed, "reason");
  if (typeof passValue !== "boolean") {
    return { pass: false, reason: `judge 输出不可解析（pass 字段缺失或不是 boolean），原文摘录：${text.trim().slice(0, 120)}` };
  }
  return {
    pass: passValue,
    reason: typeof reasonValue === "string" && reasonValue.trim() !== "" ? reasonValue : "（judge 未说明理由）",
  };
}

/**
 * 真实 LLM 评审员：复用引擎的模型工厂（getModel，与生产 chat 同一配置），
 * temperature 0 换判定确定性。每次调用一次 generateText——由 runner 按用例
 * 逐条调用（答案在数据集里预写好，judge 只评审不生成）。
 */
export function createLlmJudge(): JudgeFn {
  return async (input) => {
    const { system, user } = buildJudgePrompt(input);
    const { text } = await generateText({
      model: getModel(),
      system,
      prompt: user,
      temperature: 0,
    });
    return parseJudgeVerdict(text);
  };
}
