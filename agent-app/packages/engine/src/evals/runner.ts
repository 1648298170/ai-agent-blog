// runner.ts —— 评测运行器：把黄金数据集跑过真实引擎管线，产出 EvalReport
//
// ── 「夹具换环境，被测系统必须是真的」────────────────────────────────────
// 轨迹套件走 REAL 的 runToolLoop（generateText → 入账 → 调度 → 回灌全真代码），
// 只把最外端的模型换成 MockLanguageModelV2 脚本；路由套件走 REAL 的
// checkHardRules 纯函数；检索套件（P2）走 REAL 的 chunkText + embed +
// 内存余弦检索；评审套件（P3）走 REAL 的 generateText + getModel（与生产
// chat 同一模型工厂），judge 的判定经 scoreJudge 与期望比对。
// 只把「环境里有没有 key」换成可注入的门控。评的是引擎的调度、判定、
// 检索与评审，不是工具业务本身。
//
// ── 单例失败不炸整轮 ─────────────────────────────────────────────────────
// 一条用例抛错（如脚本编排漏了 text 收尾）记成该用例 FAIL + 中文修复指引，
// 后续用例照跑——评测报告的价值在「全貌」，一个坏用例把整轮掐了，
// 你只知道有错，不知道错多少。检索套件加一条更粗的防线：整条链路
// （批量向量化）抛错时整套进 skipped + 原因，Tier 1 结论不受影响。
// 评审套件按单例兜错：一次 judge 调用挂了只 FAIL 该用例（网络抖动不应
// 连坐其余 7 个已可判定的用例），与轨迹套件的口径一致。
//
// ── 离线铁律与 key 门控（P2 检索 / P3 评审共用同一探测）──────────────────
// Tier 1（轨迹/路由）零网络零 key，任何机器确定性跑通。检索与评审套件
// 依赖真实模型接口，按三态门控参与（见 EvalRunOptions.embeddingAvailable /
// judgeAvailable 注释）：单测显式传 false（走跳过路径）或注入假 deps/judge
// （走真实路径），均不碰网络；pnpm eval 不传参数 → 自动探测配置里的 key
// （loadEnv 会从磁盘读 .env，所以不能只看 process.env）。
// 检索全程使用自建的内存库实例，绝不触碰 retrieve.ts 的全局单例
// （setRagStore/getRagStore）——评测不能改变生产代码的全局状态。
import type { ToolLoopStepEvent } from "../agent-loop.js";
import { runToolLoop } from "../agent-loop.js";
import { getConfig } from "../config.js";
import { checkHardRules } from "../service/supervisor.js";
import { chunkText } from "../rag/chunker.js";
import { embed } from "../rag/embedder.js";
import { createInMemoryRagStore } from "../rag/store.memory.js";
import type { Chunk, RagStore, RetrievedChunk } from "../rag/types.js";
import { EVAL_CORPUS, EVAL_QUERIES } from "./corpus.js";
import { EVAL_CASES, EVAL_DATASET_VERSION, EVAL_JUDGE_CASES } from "./dataset.js";
import { createEvalTools, createScriptedModel } from "./fixtures.js";
import { createLlmJudge, scoreJudge } from "./scorers/judge.js";
import type { JudgeFn } from "./scorers/judge.js";
import { computeRetrievalMetrics, scoreRetrieval } from "./scorers/retrieval.js";
import { scoreRouting } from "./scorers/routing.js";
import { scoreTrajectory } from "./scorers/trajectory.js";
import type {
  EvalReport,
  EvalResult,
  JudgeEvalCase,
  RetrievalEvalCase,
  RoutingEvalCase,
  TrajectoryEvalCase,
} from "./types.js";

/** 轨迹套件共用的系统提示词：与 chat REPL 同题材，让脚本编排在语境里成立 */
const EVAL_SYSTEM_PROMPT =
  "你是电商客服助手，可以搜索订单、查询物流、创建工单。用中文简洁回答；不需要工具的场景直接回答，不要为了用工具而用工具。";

/** 跑一条轨迹用例：真实工具循环 + onStep 捕获实际执行序列 → 打分 */
async function runTrajectoryCase(testCase: TrajectoryEvalCase): Promise<EvalResult> {
  const startedAt = Date.now();
  const steps: ToolLoopStepEvent[] = [];
  try {
    await runToolLoop({
      model: createScriptedModel(testCase.script),
      messages: [{ role: "user", content: testCase.userMessage }],
      tools: createEvalTools(),
      system: EVAL_SYSTEM_PROMPT,
      maxSteps: 5,
      // 可选观察钩子：循环每执行并回灌一笔工具后广播——评测的「实际值」全靠它
      onStep: (event) => {
        steps.push(event);
      },
    });
    const { passed, score, detail } = scoreTrajectory(testCase.expectedToolCalls, steps);
    return { caseId: testCase.caseId, suite: testCase.suite, passed, score, detail, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      caseId: testCase.caseId,
      suite: testCase.suite,
      passed: false,
      score: 0,
      detail:
        `评测执行出错：${err instanceof Error ? err.message : String(err)}。` +
        "请检查该用例的 script 编排（最后一轮必须是 text）与工具表是否匹配。",
      durationMs: Date.now() - startedAt,
    };
  }
}

/** 跑一条路由用例：硬规则纯函数判定 → 打分（零 LLM、零网络） */
function runRoutingCase(testCase: RoutingEvalCase): EvalResult {
  const startedAt = Date.now();
  const decision = checkHardRules(testCase.state);
  const { passed, score, detail } = scoreRouting(testCase.expectedTarget, decision);
  return { caseId: testCase.caseId, suite: testCase.suite, passed, score, detail, durationMs: Date.now() - startedAt };
}

// ── P2：检索套件（Tier 2，key 门控 + 依赖注入）───────────────────────────

/**
 * 检索套件的可注入依赖：把「向量化」与「检索」两个副作用收窄成两个函数，
 * 单测注入假实现即可走完整 runner 链路而零网络；默认实现用引擎真零件。
 * embedTexts 的契约同 rag/embedder.ts 的 embed：texts[i] 的向量是返回值第 i 项。
 */
export interface RetrievalEvalDeps {
  embedTexts(texts: string[]): Promise<number[][]>;
  search(store: RagStore, queryEmbedding: number[], k: number): Promise<RetrievedChunk[]>;
}

/** runEvals 的运行选项（全部可选，P1 的裸调用 runEvals() 行为不变） */
export interface EvalRunOptions {
  /**
   * embedding 是否可用（检索套件的三态门控）：
   * - true / false：显式指定。false 时检索套件 50 条全部进 skipped 并记录原因
   *   （单测的离线跳过路径）；true 时必须配合 retrievalDeps（单测注入假实现）。
   * - 不传：自动探测。vitest 进程里检索套件「缺席」（不跑也不记 skipped——
   *   离线回归测试里裸调 runEvals() 必须得到与 P1 完全同形的报告）；
   *   正常进程里看配置（getConfig().apiKey，含磁盘 .env）：有 key 真跑，
   *   无 key 全部进 skipped + 中文修复指引（跳过 ≠ 失败）。
   */
  embeddingAvailable?: boolean;
  /** 检索依赖注入（单测用假实现）；不传时用引擎真实的 embed + 内存库检索 */
  retrievalDeps?: RetrievalEvalDeps;
  /**
   * 评审模型是否可用（judge 套件的三态门控，语义同 embeddingAvailable）：
   * - true / false：显式指定。false 时评审套件 8 条全部进 skipped 并记录原因；
   *   true 时建议配合 judgeDeps（单测注入假评审员），否则会打真实网络。
   * - 不传：自动探测（vitest 里缺席，正常进程里按 hasLlmKey()）。
   */
  judgeAvailable?: boolean;
  /** 评审员注入（单测用假实现）；不传时用 createLlmJudge() 的真实实现 */
  judgeDeps?: JudgeFn;
}

/** 检索套件每次查询取 top-5：recall@5 的观测窗口（通过线是 top-3，见 EVAL_RELEVANCE_K） */
const RETRIEVAL_TOP_K = 5;

/** 默认依赖：引擎的真 embedder（32/批分批）+ 内存库的余弦检索 */
function createRealRetrievalDeps(): RetrievalEvalDeps {
  return {
    embedTexts: (texts) => embed(texts),
    search: (store, queryEmbedding, k) => store.search(queryEmbedding, k),
  };
}

/** 无 key 时的跳过原因：告诉用户怎么修，而不是静默少跑一个套件 */
function missingKeySkipReason(): string {
  return (
    "未检测到 API 密钥（OPENAI_API_KEY 为空，已检查 .env 与进程环境变量）。" +
    "检索套件需要真实 embedding 接口（默认智谱 GLM 网关，模型 embedding-3）。" +
    "在 agent-app 目录的 .env 里配置 OPENAI_API_KEY 后重跑即可启用检索套件；" +
    "Tier 1 离线套件（轨迹/路由）不受影响。"
  );
}

/**
 * 是否配置了 LLM 密钥：getConfig 内部已合并磁盘 .env 与进程环境变量
 * （非空者优先），检索（embedding）与评审（chat）两个 key 门控套件共用
 * 同一探测——两个套件读的就是同一个 OPENAI_API_KEY。
 */
function hasLlmKey(): boolean {
  return getConfig().apiKey !== "";
}

/** 评审套件无 key 时的跳过原因（同款修复指引口径） */
function missingJudgeKeySkipReason(): string {
  return (
    "未检测到 API 密钥（OPENAI_API_KEY 为空，已检查 .env 与进程环境变量）。" +
    "评审套件（LLM-as-judge）需要真实模型调用（默认智谱 GLM 网关）。" +
    "在 agent-app 目录的 .env 里配置 OPENAI_API_KEY 后重跑即可启用评审套件；" +
    "Tier 1 离线套件（轨迹/路由）不受影响。"
  );
}

/**
 * 跑一条评审用例：调用评审员拿二元判定 → scoreJudge 比对期望。
 * 单例兜错：一次 judge 调用抛错（网络/配额/解析炸在门外）只 FAIL 该用例，
 * 其余用例照跑——与轨迹套件同一口径，报告保留全貌。
 */
async function runJudgeCase(testCase: JudgeEvalCase, judgeFn: JudgeFn): Promise<EvalResult> {
  const startedAt = Date.now();
  try {
    const verdict = await judgeFn({
      userMessage: testCase.userMessage,
      answer: testCase.answer,
      rubric: testCase.rubric,
    });
    const { passed, score, detail } = scoreJudge(testCase.expectedPass, verdict);
    return { caseId: testCase.caseId, suite: "judge", passed, score, detail, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      caseId: testCase.caseId,
      suite: "judge",
      passed: false,
      score: 0,
      detail:
        `评审调用出错：${err instanceof Error ? err.message : String(err)}。` +
        "请检查网络与 API 密钥配置后重跑本套件（该错误只影响此用例，不连坐其他评审用例）。",
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * 跑检索套件：固定语料切块 → 全量批量向量化 → upsert → 批量向量化全部查询
 * → 逐条 top-5 检索 → 倒数排名打分。
 * 任何一步抛错（网络、配额、维度不对齐）向上抛，由 runEvals 整套转 skipped。
 * 全程使用本地新建的内存库实例：与全局单例（retrieve.ts）完全隔离。
 * 调用次数经济学：语料 ~10 块 + 50 条查询各一次批量 embed（32/批），
 * 整轮约 3 次 embedding API 调用，而不是 60 次单条往返。
 */
export async function runRetrievalCases(
  cases: RetrievalEvalCase[],
  deps: RetrievalEvalDeps,
): Promise<EvalResult[]> {
  // ① 语料切块：chunk id 确定性（`${docId}-${idx}`），重跑 upsert 干净覆盖
  const store = createInMemoryRagStore();
  const chunks: Chunk[] = EVAL_CORPUS.flatMap((doc) =>
    chunkText(doc.text).map((piece, idx) => ({
      id: `${doc.docId}-${idx}`,
      docId: doc.docId,
      title: doc.title,
      text: piece,
      index: idx,
      embedding: null,
    })),
  );

  // ② 全部块一次批量向量化（引擎真实 embedder 内部按 32 条分批）→ 一次 upsert
  const chunkVectors = await deps.embedTexts(chunks.map((chunk) => chunk.text));
  if (chunkVectors.length !== chunks.length) {
    // 与 embedder 内部同款防线：乱序/缺条会让「块 A 配上块 B 的语义」，宁可炸跳过
    throw new Error(`语料向量化返回 ${chunkVectors.length} 条，与切块数 ${chunks.length} 不对齐`);
  }
  chunks.forEach((chunk, i) => {
    chunk.embedding = chunkVectors[i];
  });
  await store.upsert(chunks);

  // ③ 批量向量化全部查询（50 条 = 32+18 两次 API）→ 逐条检索打分
  const queryVectors = await deps.embedTexts(cases.map((testCase) => testCase.query));
  if (queryVectors.length !== cases.length) {
    throw new Error(`查询向量化返回 ${queryVectors.length} 条，与查询数 ${cases.length} 不对齐`);
  }

  const results: EvalResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const caseStart = Date.now();
    const hits = await deps.search(store, queryVectors[i], RETRIEVAL_TOP_K);
    const { passed, score, detail } = scoreRetrieval(testCase.expectedDocId, hits);
    results.push({
      caseId: testCase.caseId,
      suite: "retrieval",
      passed,
      score,
      detail,
      durationMs: Date.now() - caseStart,
    });
  }
  return results;
}

/** 是否运行在 vitest 进程里：vitest 会给测试 worker 注入这些环境变量 */
function isVitestProcess(): boolean {
  return process.env.VITEST !== undefined || process.env.VITEST_WORKER_ID !== undefined;
}

/**
 * 跑全部评测用例。Tier 1（轨迹/路由）永远全量执行、零跳过；
 * Tier 2（检索）与 Tier 3（评审）按三态门控参与
 * （见 EvalRunOptions.embeddingAvailable / judgeAvailable）。
 * CLI（pnpm eval）裸调用：无 vitest 环境变量 → 按 .env/key 自动探测。
 */
export async function runEvals(options?: EvalRunOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results: EvalResult[] = [];
  const skipped: string[] = [];
  const skipReasons: Record<string, string> = {};
  let metrics: Record<string, number> | undefined;

  // ── Tier 1：离线套件（dataset.ts 的 18 条）─────────────────────────────
  for (const testCase of EVAL_CASES) {
    if (testCase.suite === "trajectory") {
      results.push(await runTrajectoryCase(testCase));
    } else if (testCase.suite === "routing") {
      results.push(runRoutingCase(testCase));
    } else {
      // 编译期窄化到检索/评审用例 + 运行期双护栏：门控套件统一由
      // corpus.ts 的 EVAL_QUERIES 与 dataset.ts 的 EVAL_JUDGE_CASES 提供，
      // 混进 EVAL_CASES 会被静默漏跑——宁可当场报错，不可悄悄缺席。
      throw new Error(
        `EVAL_CASES 中出现 Tier 1 之外的用例（${testCase.caseId}，suite=${testCase.suite}）：` +
          "检索用例统一由 corpus.ts 的 EVAL_QUERIES 提供、评审用例由 dataset.ts 的 EVAL_JUDGE_CASES 提供" +
          "（两者都需 key 门控），请从 EVAL_CASES 移除该用例。",
      );
    }
  }

  // ── Tier 2：检索套件（corpus.ts 的 50 条，三态门控）────────────────────
  // vitest 裸调用（不传 options）时检索套件整体缺席：既不跑也不记 skipped，
  // 报告与 P1 完全同形——离线回归测试依赖这一点；显式传参时如实记录。
  const retrievalParticipates = options?.embeddingAvailable !== undefined || !isVitestProcess();
  if (retrievalParticipates) {
    const embeddingAvailable = options?.embeddingAvailable ?? hasLlmKey();
    if (!embeddingAvailable) {
      skipped.push(...EVAL_QUERIES.map((testCase) => testCase.caseId));
      skipReasons.retrieval = missingKeySkipReason();
    } else {
      try {
        const retrievalResults = await runRetrievalCases(
          EVAL_QUERIES,
          options?.retrievalDeps ?? createRealRetrievalDeps(),
        );
        results.push(...retrievalResults);
        // 套件级指标（Recall@k / MRR）：avg score 那一列的数学含义就是 MRR
        const retrievalMetrics = computeRetrievalMetrics(retrievalResults);
        metrics = {
          "recall@1": retrievalMetrics.recallAt1,
          "recall@3": retrievalMetrics.recallAt3,
          "recall@5": retrievalMetrics.recallAt5,
          mrr: retrievalMetrics.mrr,
        };
      } catch (err) {
        // 整套转 skipped（跳过 ≠ 失败）：批量向量化挂了不该连坐 Tier 1 的结论
        skipped.push(...EVAL_QUERIES.map((testCase) => testCase.caseId));
        skipReasons.retrieval =
          `检索套件执行中断，已整体跳过：${err instanceof Error ? err.message : String(err)}。` +
          "请检查网络与 API 密钥配置后重跑。";
      }
    }
  }

  // ── Tier 3：评审套件（dataset.ts 的 8 条，三态门控 + JudgeFn 注入）─────
  // 门控语义与检索套件逐字对齐（vitest 缺席 / 显式传参如实记录 / 裸调用
  // 探测 key）。执行顺序在检索之后：Tier 编号即执行顺序，报告表格同序。
  const judgeParticipates = options?.judgeAvailable !== undefined || !isVitestProcess();
  if (judgeParticipates) {
    const judgeAvailable = options?.judgeAvailable ?? hasLlmKey();
    if (!judgeAvailable) {
      skipped.push(...EVAL_JUDGE_CASES.map((testCase) => testCase.caseId));
      skipReasons.judge = missingJudgeKeySkipReason();
    } else {
      const judgeFn = options?.judgeDeps ?? createLlmJudge();
      for (const testCase of EVAL_JUDGE_CASES) {
        results.push(await runJudgeCase(testCase, judgeFn));
      }
    }
  }

  // total 只数实际执行的用例（passed + failed）：跳过不是失败，
  // 无 key 环境跑 pnpm eval 退出码仍应为 0（skipped ≠ failed）
  const totals = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    skipped: skipped.length,
  };

  const report: EvalReport = {
    datasetVersion: EVAL_DATASET_VERSION,
    startedAt,
    durationMs: Date.now() - t0,
    totals,
    results,
    skipped,
  };
  // 可选字段只在真的发生时出现：纯 P1 场景的报告形状与 v1 逐字段一致
  if (Object.keys(skipReasons).length > 0) report.skipReasons = skipReasons;
  if (metrics !== undefined) report.metrics = metrics;
  return report;
}
