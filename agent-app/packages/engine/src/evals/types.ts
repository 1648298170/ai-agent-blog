// evals/types.ts —— 评测契约：用例（轨迹 / 路由 / 检索 / 评审四种判别联合）与报告的数据形状
//
// ── 为什么分四种用例（判别联合）──────────────────────────────────────────
// Agent 的「对」有几种完全不同的判定方式，硬塞进一个平面结构会逼出大量
// 可选字段互相打架（expectedTools / expectedTarget / expectedDocId /
// expectedPass 永远只有一个有意义）：
//   1. 轨迹用例（trajectory）：判定「模型选了哪些工具、按什么顺序调」——
//      评的是行动路径，走真实的 runToolLoop 循环；
//   2. 路由用例（routing）：判定「客服 Supervisor 把这条消息送去哪」——
//      评的是分诊决策，走纯函数 checkHardRules；
//   3. 检索用例（retrieval，P2）：判定「期望文档有没有进检索 top-k」——
//      评的是 embedding + 余弦检索的召回质量，走真实的 embed + 内存库检索，
//      依赖 API key，由 runner 按 key 门控（无 key → 整套进 skipped）。
//   4. 评审用例（judge，P3）：判定「LLM judge 对预写回答的 rubric 二元
//      判定是否与期望一致」——评的是评审员本身的判定质量，走真实 chat
//      模型，同样按 key 门控。
// 判别联合（suite 字段做标签）让 runner 能 switch 精确分支，TS 窄化保证
// 轨迹用例取不到 expectedTarget、路由用例取不到 script、检索用例取不到
// expectedToolCalls、评审用例取不到 expectedDocId。
//
// ── 分层（Tier）设计 ─────────────────────────────────────────────────────
// Tier 1（零网络零 key，CI 可跑的确定性层）：脚本化假模型 + 精确序列比对 +
//   硬规则纯函数断言，结果可复现。
// Tier 2（P2 已落地 = 检索套件）：真实 embedding 接口 + 固定版本化语料库，
//   Recall@k / MRR 量化检索质量——依赖网络与 key，必须由 runner 按 suite
//   显式门控进 skipped 列表，绝不在离线套件里偷偷跑。
// Tier 3（P3 已落地 = 评审套件）：LLM-as-judge 对预写好的回答做 rubric 二元
//   判定（教程 week16 Day 2：二元判定优先于数字打分——打分器自己会漂移，
//   判对/判错不会），同样按 key 门控；软路由评测仍属扩展路线。
import type { RouteTarget, SupervisorState } from "../service/supervisor.js";

/** 套件名：与 EvalCase.suite 一一对应（报告按它分组汇总） */
export type EvalSuiteName = "trajectory" | "routing" | "retrieval" | "judge";

/**
 * 脚本化模型的一轮响应：要么直接给最终文本（循环出口），
 * 要么发起若干工具调用（模拟真实模型「决定调哪个工具」的那一步）。
 * 为什么用 kind 而不是 type：type 是 SDK content part 的保留词，
 * 这里是「评测自己的编排层」，换一个词避免与 ai 的形状混淆。
 */
export type ScriptedModelTurn =
  | { kind: "text"; text: string }
  | { kind: "tool-calls"; calls: ScriptedToolCall[] };

/** 脚本化的一笔工具调用：工具名 + 已按 schema 组织好的入参 */
export interface ScriptedToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * 轨迹用例：给定用户消息与「模型每轮会做什么」的脚本，
 * 断言真实工具循环实际执行的工具名序列与期望一致。
 * - script 是评测的输入（喂给 MockLanguageModelV2），expectedToolCalls 是标准答案；
 * - expectedToolCalls 为空数组是合法且有价值的负例：闲聊/直答场景一步工具都不许调。
 */
export interface TrajectoryEvalCase {
  caseId: string;
  suite: "trajectory";
  /** 一句话描述场景（报告展示给 humans 扫读） */
  description: string;
  /** 用户输入（中文客服场景，进入循环的首条 user 消息） */
  userMessage: string;
  /** 模型脚本：逐轮编排模型的行为，最后一轮必须是 text（循环才有出口） */
  script: ScriptedModelTurn[];
  /** 期望的工具调用序列（toolName 按发生顺序） */
  expectedToolCalls: string[];
}

/**
 * 路由用例：给定客服 Supervisor 判定所需的会话状态，断言路由出口。
 * Tier 1 只测确定性硬规则层（checkHardRules）：
 * - expectedTarget = "human"：硬规则必须命中并转人工；
 * - expectedTarget = null：硬规则必须放行（null 表示交给模型分类——
 *   本层只断言「不拦截」，模型怎么分是 Tier 3 的事）。
 */
export interface RoutingEvalCase {
  caseId: string;
  suite: "routing";
  description: string;
  /** 硬规则判定要看的会话状态：最新消息 + 连续未解决轮数 */
  state: SupervisorState;
  /** 期望出口：human / order / refund / knowledge，null = 硬规则放行 */
  expectedTarget: RouteTarget | null;
}

/**
 * 检索用例（Tier 2）：给定一句中文查询与唯一期望命中的文档 docId，
 * 断言真实 embedding + 余弦检索能否把期望文档送进 top-k。
 * - expectedDocId 必须是 corpus.ts EVAL_CORPUS 里定义的 docId（数据集完整性
 *   由测试兜底：引用不存在的 docId 在 vitest 里直接标红）；
 * - 依赖真实 embedding 接口（默认智谱 GLM 网关 embedding-3），由 runner
 *   按 key 门控：无 key 时整个套件进 skipped，绝不在离线套件里偷偷跑。
 */
export interface RetrievalEvalCase {
  caseId: string;
  suite: "retrieval";
  description: string;
  /** 检索查询：真实用户口吻，直问 / 间接转述 / 邻接对抗三种难度混排 */
  query: string;
  /** 期望命中的文档 docId（语料库 corpus.ts 里定义） */
  expectedDocId: string;
}

/**
 * 评审用例（Tier 3，P3）：给定用户问题、一份预写好的候选回答与 rubric 条目，
 * 断言 LLM judge 的二元判定与期望一致（expectedPass）。
 * - 回答是数据集里预写的（不现场生成）：评的是「评审员」的判定质量，
 *   不是生成器的发挥——8 例 = 6 个应判通过的好回答 + 2 个应判不通过的
 *   坏回答，负例守住「judge 不是好好先生」这条底线（教程 Day 2 校准思想）；
 * - rubric 条目是短的可核对中文陈述（回答必须包含… / 不得…），
 *   只依据条目逐条核对，不引入条目之外的标准；
 * - 依赖真实 chat 模型（默认智谱 GLM 网关 glm-4-flash），由 runner 按 key
 *   门控：无 key 时整个套件进 skipped，跳过 ≠ 失败。
 */
export interface JudgeEvalCase {
  caseId: string;
  suite: "judge";
  description: string;
  /** 用户原始问题（进 judge prompt，供评审员理解回答的场景） */
  userMessage: string;
  /** 预写好的候选回答：judge 只评审、不生成，判定结论可复现归因 */
  answer: string;
  /** rubric 条目：短的可核对陈述，全部满足才应判通过 */
  rubric: string[];
  /** 期望的 judge 判定：true = 这份回答应满足全部条目 */
  expectedPass: boolean;
}

/** 一条评测用例：判别联合，suite 是标签 */
export type EvalCase =
  | TrajectoryEvalCase
  | RoutingEvalCase
  | RetrievalEvalCase
  | JudgeEvalCase;

/** 单用例结果：过了没有、得分多少（0..1）、给人看的差异说明 */
export interface EvalResult {
  caseId: string;
  suite: EvalSuiteName;
  passed: boolean;
  /** 0..1：Tier 1 语义——轨迹 = 位置对齐命中数/期望长度（精确匹配才算过），路由 = 1/0；
   *  Tier 2 检索语义——命中排名的倒数（rank 1 → 1.0，rank 2 → 0.5，未命中 → 0），
   *  因此检索套件的 avg score 恰好等于 MRR（平均倒数排名） */
  score: number;
  /** 期望 vs 实际的差异描述（失败时报告逐条展示） */
  detail: string;
  /** 单用例耗时（报告的分套件耗时列用它累加） */
  durationMs: number;
}

/** 汇总计数。
 * total 只数「实际执行」的用例（= passed + failed）：跳过 ≠ 失败——
 * 无 key 时检索套件整体进 skipped，CLI 按「passed === total」判退出码，
 * 不能让环境缺失把整轮评测打成失败（退出码语义见 report.ts / eval CLI） */
export interface EvalTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * 整轮评测报告：CLI 打印 + 落盘 .data/eval-report.json 的同一份数据。
 * - skipped 存 caseId 列表：门控套件的跳过记录（Tier 1 恒为空；P2 检索套件
 *   无 key 时 50 条进这里，跳过 ≠ 失败，不影响退出码）；
 * - datasetVersion 让落盘报告可追溯到具体一版黄金数据集；
 * - metrics / skipReasons 是 P2 起的可选字段：只有检索套件实际参与时才出现，
 *   纯 P1 场景的报告形状与 v1 完全一致（不破坏既有消费方）。
 */
export interface EvalReport {
  datasetVersion: string;
  /** 开始时间（ISO 8601） */
  startedAt: string;
  /** 整轮耗时（毫秒） */
  durationMs: number;
  totals: EvalTotals;
  results: EvalResult[];
  skipped: string[];
  /** 套件级指标（可选）：键为指标名，如 "recall@1"/"recall@3"/"recall@5"/"mrr"。
   *  检索套件跑完时由 runner 填入——单例分数（倒数排名）之外的套件级口径 */
  metrics?: Record<string, number>;
  /** 跳过原因（可选）：键为套件名，说明为什么整个套件被跳过 + 怎么修复（中文） */
  skipReasons?: Record<string, string>;
}

/**
 * 打分器的统一输出：轨迹与路由两个打分器都长这样，
 * runner 拿到后无需知道套件细节就能拼 EvalResult。
 */
export interface ScorerOutput {
  passed: boolean;
  score: number;
  detail: string;
}
