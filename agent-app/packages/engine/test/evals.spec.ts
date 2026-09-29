// evals.spec.ts —— 评测框架自身的行为测试（离线、确定性，无基础设施门控）
// 覆盖四个面：轨迹打分器（精确 / 部分 / 空序列正反例）、路由打分器（过/不过）、
// 报告 JSON 形状（落盘可读回）、运行器端到端（全部用例离线跑全绿）。
// 与 test/infra.*.spec.ts 的区别：评测框架的承诺就是零依赖离线，
// 所以这里不设 RUN_INFRA_TESTS 门控，普通 pnpm test 必跑。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolLoopStepEvent } from "../src/agent-loop.js";
import type { RouteDecision } from "../src/service/supervisor.js";
import {
  EVAL_CASES,
  EVAL_DATASET_VERSION,
  runEvals,
  scoreRouting,
  scoreTrajectory,
  writeReportFile,
} from "../src/evals/index.js";
import type { EvalReport } from "../src/evals/index.js";
// ── P2（检索套件）追加的导入与用例：只增不改，上方 P1 用例保持原样 ──────────
import {
  EVAL_CORPUS,
  EVAL_QUERIES,
  EVAL_RELEVANCE_K,
  computeRetrievalMetrics,
  scoreRetrieval,
} from "../src/evals/index.js";
import type { EvalResult, RetrievalEvalDeps } from "../src/evals/index.js";
import type { RetrievedChunk } from "../src/rag/types.js";
// ── P3（评审套件 + 回归基线）追加的导入与用例：只增不改，上方 P1/P2 用例保持原样 ──
import { writeFileSync } from "node:fs";
import {
  BASELINE_TOLERANCE,
  EVAL_JUDGE_CASES,
  buildBaseline,
  buildJudgePrompt,
  compareBaseline,
  loadBaseline,
  saveBaseline,
  scoreJudge,
} from "../src/evals/index.js";
import type { EvalBaseline, JudgeFn } from "../src/evals/index.js";

/** 造一个最小 ToolLoopStepEvent（打分器只看 toolCall.toolName，其余字段填占位值） */
function step(toolName: string): ToolLoopStepEvent {
  return { step: 1, toolCall: { toolName, input: {} }, output: {} };
}

/** 造一个最小 RouteDecision（打分器只看 target 与 reason 展示） */
function decision(target: RouteDecision["target"], reason: string): RouteDecision {
  return { target, reason };
}

describe("轨迹打分器 scoreTrajectory", () => {
  it("精确匹配：序列一致 → passed 且满分", () => {
    const output = scoreTrajectory(["search_orders", "query_logistics"], [step("search_orders"), step("query_logistics")]);
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
    expect(output.detail).toContain("search_orders → query_logistics");
  });

  it("部分匹配：第二个工具选错 → 不通过，score = 命中 1/期望 2", () => {
    const output = scoreTrajectory(["search_orders", "query_logistics"], [step("search_orders"), step("create_ticket")]);
    expect(output.passed).toBe(false);
    expect(output.score).toBe(0.5);
    expect(output.detail).toContain("期望工具序列");
    expect(output.detail).toContain("实际执行了");
  });

  it("顺序错也是错：同集合不同顺序 → 不通过（顺序敏感是 Tier 1 的严格性）", () => {
    const output = scoreTrajectory(["a", "b"], [step("b"), step("a")]);
    expect(output.passed).toBe(false);
    expect(output.score).toBe(0);
  });

  it("空期望 vs 空实际（闲聊负例的正解）→ passed 且满分", () => {
    const output = scoreTrajectory([], []);
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
  });

  it("空期望 vs 实际调了工具（闲聊不许调工具却调了）→ 不通过且 0 分", () => {
    const output = scoreTrajectory([], [step("query_logistics")]);
    expect(output.passed).toBe(false);
    expect(output.score).toBe(0);
    expect(output.detail).toContain("（不调工具）");
  });
});

describe("路由打分器 scoreRouting", () => {
  it("期望 human 且实际命中硬规则 → 通过满分，detail 带 reason", () => {
    const output = scoreRouting("human", decision("human", "用户明确要求转人工（关键词「转人工」）"));
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
    expect(output.detail).toContain("转人工");
  });

  it("期望放行(null)且实际放行(null) → 通过（硬规则不误伤正常业务）", () => {
    const output = scoreRouting(null, null);
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
  });

  it("期望放行却被转人工 → 不通过 0 分，detail 列出期望与实际", () => {
    const output = scoreRouting(null, decision("human", "命中高危业务白名单（关键词「投诉」）"));
    expect(output.passed).toBe(false);
    expect(output.score).toBe(0);
    expect(output.detail).toContain("期望 [放行");
    expect(output.detail).toContain("实际 [human]");
  });
});

describe("报告落盘 writeReportFile", () => {
  it("写入的 JSON 可读回且形状完整（版本 / 时间 / 计数 / 结果 / 跳过）", () => {
    const report: EvalReport = {
      datasetVersion: EVAL_DATASET_VERSION,
      startedAt: "2026-09-29T00:00:00.000Z",
      durationMs: 42,
      totals: { total: 2, passed: 1, failed: 1, skipped: 0 },
      results: [
        { caseId: "traj-01", suite: "trajectory", passed: true, score: 1, detail: "工具序列一致", durationMs: 30 },
        { caseId: "route-01", suite: "routing", passed: false, score: 0, detail: "期望 [放行…]，实际 [human]", durationMs: 2 },
      ],
      skipped: [],
    };

    const dir = mkdtempSync(join(tmpdir(), "eval-report-"));
    const filePath = join(dir, "eval-report.json");
    try {
      const written = writeReportFile(report, filePath);
      expect(written).toBe(filePath);

      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as EvalReport;
      expect(parsed.datasetVersion).toBe(EVAL_DATASET_VERSION);
      expect(parsed.startedAt).toBe("2026-09-29T00:00:00.000Z");
      expect(parsed.durationMs).toBe(42);
      expect(parsed.totals).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[1]).toMatchObject({ caseId: "route-01", suite: "routing", passed: false, score: 0 });
      expect(parsed.skipped).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("运行器端到端 runEvals（离线全绿）", () => {
  it("跑完整个黄金数据集：数量对得上、全部通过、零跳过、分数落在 0..1", async () => {
    const report = await runEvals();

    expect(report.datasetVersion).toBe(EVAL_DATASET_VERSION);
    expect(report.totals.total).toBe(EVAL_CASES.length);
    expect(report.totals.passed).toBe(EVAL_CASES.length);
    expect(report.totals.failed).toBe(0);
    expect(report.totals.skipped).toBe(0);
    expect(report.skipped).toEqual([]);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.results).toHaveLength(EVAL_CASES.length);
    for (const result of report.results) {
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it("数据集形状：轨迹 ≥10 条（含 2 条以上空序列负例）、路由 ≥8 条（含放行用例）", () => {
    const trajectory = EVAL_CASES.filter((c) => c.suite === "trajectory");
    const routing = EVAL_CASES.filter((c) => c.suite === "routing");
    expect(trajectory.length).toBeGreaterThanOrEqual(10);
    expect(routing.length).toBeGreaterThanOrEqual(8);
    // 负例护栏：闲聊不许调工具的期望必须存在，防止数据集退化成全正例
    expect(trajectory.filter((c) => c.expectedToolCalls.length === 0).length).toBeGreaterThanOrEqual(2);
    // 放行护栏：必须有不命中硬规则的正常业务用例
    expect(routing.filter((c) => c.expectedTarget === null).length).toBeGreaterThanOrEqual(2);
  });
});

// ══ P2：检索套件（Tier 2）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 检索套件自身的行为测试同样零网络：打分器/指标是纯函数，数据集是纯数据，
// 运行器两条路径分别用「显式 false（跳过）」与「注入假依赖（检索）」覆盖——
// 真实 embedding 链路由 pnpm eval（有 key 的机器）行使，不进 vitest。

/** 造一条最小 RetrievedChunk（打分器只看 docId，其余字段填占位值） */
function retrieved(docId: string, rank: number): RetrievedChunk {
  return {
    id: `${docId}-${rank - 1}`,
    docId,
    title: docId,
    text: `《${docId}》第 ${rank} 块`,
    index: rank - 1,
    embedding: null,
    score: 1 - rank * 0.1,
  };
}

/** 按入参顺序造检索结果（第 i 个 docId 排第 i+1 名） */
function hitsOf(...docIds: string[]): RetrievedChunk[] {
  return docIds.map((docId, i) => retrieved(docId, i + 1));
}

describe("检索打分器 scoreRetrieval", () => {
  it("第 1 名命中：满分通过，detail 写明期望文档与命中排名", () => {
    const output = scoreRetrieval("doc-a", hitsOf("doc-a", "doc-b", "doc-c"));
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
    expect(output.detail).toContain("期望文档 doc-a");
    expect(output.detail).toContain("排名第 1");
    expect(output.detail).toContain("doc-a、doc-b、doc-c");
  });

  it("第 3 名命中：score = 1/3 仍算通过（EVAL_RELEVANCE_K = 3 的通过边界）", () => {
    expect(EVAL_RELEVANCE_K).toBe(3);
    const output = scoreRetrieval("doc-c", hitsOf("doc-a", "doc-b", "doc-c"));
    expect(output.passed).toBe(true);
    expect(output.score).toBeCloseTo(1 / 3, 12);
  });

  it("第 5 名命中：score = 0.2 但不算通过（进了 top-5、没进 top-3）", () => {
    const output = scoreRetrieval("doc-e", hitsOf("doc-a", "doc-b", "doc-c", "doc-d", "doc-e"));
    expect(output.passed).toBe(false);
    expect(output.score).toBeCloseTo(0.2, 12);
  });

  it("未命中：0 分不通过，detail 说明未出现并列出实际命中的 docId", () => {
    const output = scoreRetrieval("doc-x", hitsOf("doc-a", "doc-b"));
    expect(output.passed).toBe(false);
    expect(output.score).toBe(0);
    expect(output.detail).toContain("未出现");
    expect(output.detail).toContain("doc-a、doc-b");
  });
});

describe("检索指标 computeRetrievalMetrics", () => {
  /** 造一条检索用例结果（分数即倒数排名，其余字段不参与指标计算） */
  const retrievalRow = (score: number): EvalResult => ({
    caseId: "rtv-x",
    suite: "retrieval",
    passed: score >= 1 / 3,
    score,
    detail: "",
    durationMs: 0,
  });

  it("六条合成的倒数排名：recall@1/3/5 与 mrr 的算术逐项对上", () => {
    // 排名序列：1、2、3、4、5、未命中 → recall@1=1/6、recall@3=3/6、recall@5=5/6
    const metrics = computeRetrievalMetrics([
      retrievalRow(1),
      retrievalRow(0.5),
      retrievalRow(1 / 3),
      retrievalRow(0.25),
      retrievalRow(0.2),
      retrievalRow(0),
    ]);
    expect(metrics.recallAt1).toBeCloseTo(1 / 6, 12);
    expect(metrics.recallAt3).toBeCloseTo(0.5, 12);
    expect(metrics.recallAt5).toBeCloseTo(5 / 6, 12);
    expect(metrics.mrr).toBeCloseTo((1 + 0.5 + 1 / 3 + 0.25 + 0.2 + 0) / 6, 12);
  });

  it("非检索套件的结果行不参与计算（混入轨迹行不改变指标）", () => {
    const stray: EvalResult = { caseId: "traj-01", suite: "trajectory", passed: true, score: 1, detail: "", durationMs: 0 };
    const metrics = computeRetrievalMetrics([stray, retrievalRow(1), retrievalRow(1 / 3)]);
    expect(metrics.recallAt1).toBeCloseTo(0.5, 12);
    expect(metrics.recallAt3).toBe(1);
    expect(metrics.mrr).toBeCloseTo((1 + 1 / 3) / 2, 12);
  });

  it("空集返回全 0（不产出 NaN 污染报告）", () => {
    expect(computeRetrievalMetrics([])).toEqual({ recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 });
  });
});

describe("检索数据集完整性（corpus.ts）", () => {
  it("语料库恰好 10 篇文档且 docId 唯一", () => {
    expect(EVAL_CORPUS).toHaveLength(10);
    expect(new Set(EVAL_CORPUS.map((doc) => doc.docId)).size).toBe(10);
  });

  it("查询集恰好 50 条且 caseId 唯一（rtv-01..rtv-50）", () => {
    expect(EVAL_QUERIES).toHaveLength(50);
    const caseIds = EVAL_QUERIES.map((query) => query.caseId);
    expect(new Set(caseIds).size).toBe(50);
    for (const caseId of caseIds) expect(caseId).toMatch(/^rtv-\d{2}$/);
  });

  it("每条查询的 expectedDocId 都存在于语料库中（引用悬空当场标红）", () => {
    const known = new Set(EVAL_CORPUS.map((doc) => doc.docId));
    for (const query of EVAL_QUERIES) {
      expect(known.has(query.expectedDocId), `查询 ${query.caseId} 引用了未知 docId：${query.expectedDocId}`).toBe(true);
    }
  });

  it("每篇文档至少被 4 条查询覆盖（防止数据集退化成只考两三个主题）", () => {
    const coverage = new Map<string, number>(EVAL_CORPUS.map((doc) => [doc.docId, 0]));
    for (const query of EVAL_QUERIES) {
      coverage.set(query.expectedDocId, (coverage.get(query.expectedDocId) ?? 0) + 1);
    }
    for (const [docId, count] of coverage) {
      expect(count, `文档 ${docId} 只覆盖了 ${count} 条查询`).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("运行器 · 检索套件跳过路径 runEvals({ embeddingAvailable: false })", () => {
  it("50 条检索用例全部进 skipped 且带原因，P1 套件照常全绿（跳过 ≠ 失败）", async () => {
    const report = await runEvals({ embeddingAvailable: false });

    // 检索套件：整套装进 skipped，一条都不执行
    expect(report.totals.skipped).toBe(50);
    expect(report.skipped).toHaveLength(50);
    for (const query of EVAL_QUERIES) {
      expect(report.skipped).toContain(query.caseId);
    }

    // P1 离线套件不受门控影响：18 条照常执行、全部通过
    const tier1 = report.results.filter((r) => r.suite !== "retrieval");
    expect(tier1).toHaveLength(EVAL_CASES.length);
    expect(tier1.every((r) => r.passed)).toBe(true);
    expect(report.totals.passed).toBe(EVAL_CASES.length);
    expect(report.totals.failed).toBe(0);
    expect(report.totals.total).toBe(EVAL_CASES.length);

    // 跳过要留原因与修复指引；没跑就不产出指标
    expect(report.skipReasons?.retrieval).toContain("OPENAI_API_KEY");
    expect(report.metrics).toBeUndefined();
  });
});

describe("运行器 · 检索套件注入路径（假依赖，零网络）", () => {
  /**
   * 假依赖：embedTexts 把第 i 条文本映射成 [i, 0]（确定性）；
   * 假 search 忽略 store，按查询向量反查所属用例，把期望文档放在指定排名——
   * 评测的是 runner 的编排与打分链路，不评假检索本身。
   * 偶数例放第 1 名、奇数例放第 2 名 → recall@1 = 0.5、recall@3 = 1、mrr = 0.75。
   */
  function createFakeDeps(): RetrievalEvalDeps {
    return {
      embedTexts: async (texts) => texts.map((_, i) => [i, 0]),
      search: async (_store, queryEmbedding, k) => {
        const testCase = EVAL_QUERIES[queryEmbedding[0]];
        if (testCase === undefined) {
          throw new Error(`假检索收到未知查询向量：[${queryEmbedding.join(",")}]`);
        }
        const targetRank = queryEmbedding[0] % 2 === 0 ? 1 : 2;
        const otherDocIds = EVAL_CORPUS.map((doc) => doc.docId).filter((id) => id !== testCase.expectedDocId);
        const ranked: string[] = [];
        for (let rank = 1; rank <= k; rank++) {
          ranked.push(rank === targetRank ? testCase.expectedDocId : otherDocIds[rank % otherDocIds.length]);
        }
        return ranked.map((docId, i) => retrieved(docId, i + 1));
      },
    };
  }

  it("注入假依赖：68 条全过，metrics 按假排名精确产出（recall@1=0.5、mrr=0.75）", async () => {
    const report = await runEvals({ embeddingAvailable: true, retrievalDeps: createFakeDeps() });

    expect(report.totals.skipped).toBe(0);
    expect(report.totals.total).toBe(EVAL_CASES.length + EVAL_QUERIES.length);
    expect(report.totals.passed).toBe(EVAL_CASES.length + EVAL_QUERIES.length);
    expect(report.totals.failed).toBe(0);

    const metrics = report.metrics;
    if (metrics === undefined) {
      throw new Error("注入假依赖的检索运行必须产出 metrics");
    }
    expect(metrics["recall@1"]).toBeCloseTo(0.5, 12);
    expect(metrics["recall@3"]).toBe(1);
    expect(metrics["recall@5"]).toBe(1);
    expect(metrics["mrr"]).toBeCloseTo(0.75, 12);
  });
});

// ══ P3：评审套件（Tier 3）+ 回归基线 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 与 P2 同款离线铁律：scoreJudge/buildJudgePrompt/基线全是纯函数，
// 运行器两条路径用「显式 false（跳过）」与「注入假评审员（JudgeFn）」覆盖——
// 真实 LLM 评审链路由 pnpm eval（有 key 的机器）行使，不进 vitest。

describe("评审打分器 scoreJudge", () => {
  it("期望通过且 judge 判通过 → 通过满分，detail 同时写出期望/模型判定与理由", () => {
    const output = scoreJudge(true, { pass: true, reason: "三条 rubric 全部满足" });
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
    expect(output.detail).toContain("期望判定=通过");
    expect(output.detail).toContain("模型判定=通过");
    expect(output.detail).toContain("judge 理由：三条 rubric 全部满足");
  });

  it("期望不通过且 judge 判不通过（负例判对了）→ 同样是通过：评的是判得准不准", () => {
    const output = scoreJudge(false, { pass: false, reason: "条目 2 未满足" });
    expect(output.passed).toBe(true);
    expect(output.score).toBe(1);
    expect(output.detail).toContain("期望判定=不通过");
    expect(output.detail).toContain("模型判定=不通过");
  });

  it("期望不通过但 judge 判通过（好好先生被抓现行）→ 不通过 0 分", () => {
    const output = scoreJudge(false, { pass: true, reason: "语气很客气" });
    expect(output.passed).toBe(false);
    expect(output.score).toBe(0);
    expect(output.detail).toContain("判定不一致");
    expect(output.detail).toContain("期望判定=不通过");
    expect(output.detail).toContain("模型判定=通过");
  });
});

describe("评审提示词 buildJudgePrompt（纯函数，零网络）", () => {
  const input = {
    userMessage: "查一下订单 A-1024 的物流到哪了",
    answer: "订单 A-1024 已发货，运单号 SF1234567890，预计明天送达。",
    rubric: ["回答必须包含订单号 A-1024", "回答必须给出预计送达时间", "不得包含推销内容"],
  };

  it("user 内容装着问题 / 回答 / 编号 rubric 条目（位置偏差防护：条目不埋进散文）", () => {
    const { user } = buildJudgePrompt(input);
    expect(user).toContain(input.userMessage);
    expect(user).toContain(input.answer);
    expect(user).toContain("1. 回答必须包含订单号 A-1024");
    expect(user).toContain("2. 回答必须给出预计送达时间");
    expect(user).toContain("3. 不得包含推销内容");
  });

  it("system 写死评审协议：只看 rubric、宁可误杀、严格单行 JSON、禁止围栏", () => {
    const { system } = buildJudgePrompt(input);
    expect(system).toContain("只依据 rubric");
    expect(system).toContain("宁可误杀");
    expect(system).toContain('{"pass": boolean, "reason": string}');
    expect(system).toContain("禁止使用 markdown 代码围栏");
  });
});

describe("评审数据集完整性（dataset.ts EVAL_JUDGE_CASES）", () => {
  it("恰好 8 条且 caseId 唯一（judge-01..judge-08）", () => {
    expect(EVAL_JUDGE_CASES).toHaveLength(8);
    const caseIds = EVAL_JUDGE_CASES.map((c) => c.caseId);
    expect(new Set(caseIds).size).toBe(8);
    for (const caseId of caseIds) expect(caseId).toMatch(/^judge-\d{2}$/);
  });

  it("6 条正例 + 2 条负例，每条 rubric 至少 3 条（负例是 judge 校准的底线，防退化成全正例）", () => {
    expect(EVAL_JUDGE_CASES.filter((c) => c.expectedPass).length).toBe(6);
    expect(EVAL_JUDGE_CASES.filter((c) => !c.expectedPass).length).toBe(2);
    for (const testCase of EVAL_JUDGE_CASES) {
      expect(testCase.rubric.length).toBeGreaterThanOrEqual(3);
      for (const item of testCase.rubric) expect(item.trim().length).toBeGreaterThan(0);
      expect(testCase.answer.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("回归基线 buildBaseline + compareBaseline", () => {
  /** 造一条合成结果行（基线比对只看 suite/score/passed） */
  const baselineRow = (suite: EvalResult["suite"], score: number, passed: boolean): EvalResult => ({
    caseId: `${suite}-x`,
    suite,
    passed,
    score,
    detail: "",
    durationMs: 0,
  });

  /** 用合成结果行拼一份最小报告（compareBaseline 只消费 datasetVersion 与 results） */
  const reportOf = (version: string, rows: EvalResult[]): EvalReport => {
    return {
      datasetVersion: version,
      startedAt: "2026-09-29T00:00:00.000Z",
      durationMs: 1,
      totals: {
        total: rows.length,
        passed: rows.filter((r) => r.passed).length,
        failed: rows.filter((r) => !r.passed).length,
        skipped: 0,
      },
      results: rows,
      skipped: [],
    };
  };

  it("同一份报告自比：零违规（口径与基线逐字一致）", () => {
    const report = reportOf(EVAL_DATASET_VERSION, [
      baselineRow("trajectory", 1, true),
      baselineRow("trajectory", 0.5, false),
      baselineRow("judge", 1, true),
    ]);
    const baseline = buildBaseline(report);
    expect(baseline.datasetVersion).toBe(report.datasetVersion);
    expect(baseline.suites.trajectory).toEqual({ passed: 1, total: 2, avgScore: 0.75 });
    expect(baseline.suites.judge).toEqual({ passed: 1, total: 1, avgScore: 1 });
    expect(compareBaseline(report, baseline)).toEqual([]);
  });

  it("avg score 跌幅超过容差（1.0 → 0.95 > 0.03）→ 违规且非 stale", () => {
    expect(BASELINE_TOLERANCE).toBe(0.03);
    const baseline = buildBaseline(reportOf(EVAL_DATASET_VERSION, [baselineRow("judge", 1, true), baselineRow("judge", 1, true)]));
    const current = reportOf(EVAL_DATASET_VERSION, [baselineRow("judge", 0.95, true), baselineRow("judge", 0.95, true)]);

    const violations = compareBaseline(current, baseline);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.suite).toBe("judge");
    expect(violations[0]?.stale).toBeUndefined();
    expect(violations[0]?.message).toContain("1.000");
    expect(violations[0]?.message).toContain("0.950");
    expect(violations[0]?.message).toContain("跌幅超过 3%");
  });

  it("avg score 小幅下跌（1.0 → 0.98 ≤ 0.03 容差）→ 不算回归（真实模型的正常软毛）", () => {
    const baseline = buildBaseline(reportOf(EVAL_DATASET_VERSION, [baselineRow("judge", 1, true)]));
    const current = reportOf(EVAL_DATASET_VERSION, [baselineRow("judge", 0.98, true)]);
    expect(compareBaseline(current, baseline)).toEqual([]);
  });

  it("通过率回退（2/2 → 1/2，avg score 不变）→ 单独构成违规", () => {
    const baseline = buildBaseline(reportOf(EVAL_DATASET_VERSION, [baselineRow("routing", 1, true), baselineRow("routing", 1, true)]));
    const current = reportOf(EVAL_DATASET_VERSION, [baselineRow("routing", 1, true), baselineRow("routing", 1, false)]);

    const violations = compareBaseline(current, baseline);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.suite).toBe("routing");
    expect(violations[0]?.message).toContain("通过率回归");
    expect(violations[0]?.message).toContain("2/2");
    expect(violations[0]?.message).toContain("1/2");
  });

  it("数据集版本不一致 → 仅一条 stale 提示，不构成回归（CLI 不因它拦退出码）", () => {
    const rows = [baselineRow("trajectory", 1, true)];
    const baseline = buildBaseline(reportOf("2", rows));
    const current = reportOf("3", rows);

    const violations = compareBaseline(current, baseline);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.stale).toBe(true);
    expect(violations[0]?.message).toContain("v2");
    expect(violations[0]?.message).toContain("v3");
    expect(violations[0]?.message).toContain("基线已过期");
  });

  it("基线里有、本轮缺席的套件不比对（无 key 跳过的套件 ≠ 回归）", () => {
    const baseline = buildBaseline(
      reportOf(EVAL_DATASET_VERSION, [baselineRow("trajectory", 1, true), baselineRow("retrieval", 1, true)]),
    );
    const current = reportOf(EVAL_DATASET_VERSION, [baselineRow("trajectory", 1, true)]);
    expect(compareBaseline(current, baseline)).toEqual([]);
  });
});

describe("回归基线 saveBaseline / loadBaseline（临时目录往返）", () => {
  it("落盘 → 读回逐字段一致；不存在的路径读回 null", () => {
    const baseline: EvalBaseline = {
      datasetVersion: "3",
      savedAt: "2026-09-29T00:00:00.000Z",
      suites: {
        trajectory: { passed: 10, total: 10, avgScore: 1 },
        judge: { passed: 8, total: 8, avgScore: 1 },
      },
    };

    const dir = mkdtempSync(join(tmpdir(), "eval-baseline-"));
    const filePath = join(dir, "eval-baseline.json");
    try {
      const saved = saveBaseline(baseline, filePath);
      expect(saved).toBe(filePath);
      expect(loadBaseline(filePath)).toEqual(baseline);
      expect(loadBaseline(join(dir, "not-exist.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("损坏的基线文件 → 抛带修复指引的中文错误（静默当没有基线会悄悄关掉门禁）", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-baseline-broken-"));
    const filePath = join(dir, "eval-baseline.json");
    try {
      writeFileSync(filePath, "{ 不是 JSON", "utf8");
      expect(() => loadBaseline(filePath)).toThrow(/--update-baseline/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("运行器 · 评审套件跳过路径 runEvals({ embeddingAvailable: false, judgeAvailable: false })", () => {
  it("8 条评审用例全部进 skipped 且带原因，P1 套件照常全绿（跳过 ≠ 失败）", async () => {
    const report = await runEvals({ embeddingAvailable: false, judgeAvailable: false });

    // 检索 + 评审两个门控套件：整套装进 skipped（50 + 8 = 58）
    expect(report.totals.skipped).toBe(58);
    for (const testCase of EVAL_JUDGE_CASES) {
      expect(report.skipped).toContain(testCase.caseId);
    }

    // P1 离线套件不受门控影响：18 条照常执行、全部通过
    expect(report.totals.total).toBe(EVAL_CASES.length);
    expect(report.totals.passed).toBe(EVAL_CASES.length);
    expect(report.totals.failed).toBe(0);

    // 两个套件都要留原因与修复指引
    expect(report.skipReasons?.judge).toContain("OPENAI_API_KEY");
    expect(report.skipReasons?.retrieval).toContain("OPENAI_API_KEY");
  });
});

describe("运行器 · 评审套件注入路径（假评审员，零网络）", () => {
  /** 与期望对齐的假评审员：按 userMessage 反查用例，判定期望值 */
  const alignedJudge: JudgeFn = async (input) => {
    const testCase = EVAL_JUDGE_CASES.find((c) => c.userMessage === input.userMessage);
    if (testCase === undefined) {
      throw new Error(`假评审收到未知用例：${input.userMessage.slice(0, 30)}`);
    }
    return { pass: testCase.expectedPass, reason: `合成判定（期望 ${testCase.expectedPass ? "通过" : "不通过"}）` };
  };

  it("假评审员判得全对：18 P1 + 8 judge 全绿，检索仍按 embeddingAvailable=false 跳过", async () => {
    const report = await runEvals({ embeddingAvailable: false, judgeAvailable: true, judgeDeps: alignedJudge });

    expect(report.totals.skipped).toBe(50); // 只有检索套件跳过
    expect(report.totals.total).toBe(EVAL_CASES.length + EVAL_JUDGE_CASES.length);
    expect(report.totals.passed).toBe(EVAL_CASES.length + EVAL_JUDGE_CASES.length);
    expect(report.totals.failed).toBe(0);

    const judgeRows = report.results.filter((r) => r.suite === "judge");
    expect(judgeRows).toHaveLength(8);
    expect(judgeRows.every((r) => r.passed)).toBe(true);
  });

  it("好好先生评审员（永远判通过）：两个负例用例 FAIL，负例抓好好先生的设计生效", async () => {
    const yesManJudge: JudgeFn = async () => ({ pass: true, reason: "看起来挺好的" });
    const report = await runEvals({ embeddingAvailable: false, judgeAvailable: true, judgeDeps: yesManJudge });

    const negativeCaseIds = EVAL_JUDGE_CASES.filter((c) => !c.expectedPass).map((c) => c.caseId);
    const failedRows = report.results.filter((r) => !r.passed);
    expect(failedRows).toHaveLength(negativeCaseIds.length);
    for (const caseId of negativeCaseIds) {
      const row = failedRows.find((r) => r.caseId === caseId);
      if (row === undefined) throw new Error(`负例 ${caseId} 应当失败但结果缺席`);
      expect(row.score).toBe(0);
      expect(row.detail).toContain("期望判定=不通过");
      expect(row.detail).toContain("模型判定=通过");
    }
  });

  it("评审员单例抛错：只 FAIL 该用例（detail 带修复指引），其余评审用例照跑", async () => {
    let callCount = 0;
    const flakyJudge: JudgeFn = async (input) => {
      callCount += 1;
      if (callCount === 1) throw new Error("模拟网络中断");
      return alignedJudge(input);
    };
    const report = await runEvals({ embeddingAvailable: false, judgeAvailable: true, judgeDeps: flakyJudge });

    expect(report.totals.total).toBe(EVAL_CASES.length + EVAL_JUDGE_CASES.length);
    expect(report.totals.failed).toBe(1);
    const failedRow = report.results.find((r) => !r.passed);
    if (failedRow === undefined) throw new Error("应当恰好一条失败");
    expect(failedRow.suite).toBe("judge");
    expect(failedRow.detail).toContain("评审调用出错");
    expect(failedRow.detail).toContain("模拟网络中断");
  });
});
