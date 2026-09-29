// scorers/retrieval.ts —— 检索打分器（Tier 2）：期望文档 vs 真实检索结果
//
// ── 打分口径：倒数排名（Reciprocal Rank）─────────────────────────────────
// 检索的「部分对」有天然刻度——期望文档排在第几名：
//   rank 1 → 1.0，rank 2 → 0.5，rank 3 → 0.333…，未命中 → 0。
// 排名越靠前越接近满分，第 4、5 名虽然不算通过（见 EVAL_RELEVANCE_K），
// 但 0.25/0.2 的分数让「差一点就进 top-3」的退化在 avg 里可见。
//
// ── passed 为什么是 top-3 ────────────────────────────────────────────────
// EVAL_RELEVANCE_K = 3：客服场景检索完要拼进 prompt 喂模型，top-3 之外
// 的块基本进不了答案（也浪费上下文），「进了 top-3」才是业务意义上的命中。
//
// ── 套件级指标与表格 avg score 的关系 ────────────────────────────────────
// 单例 score = 1/rank，于是检索套件的 avg score（report.ts 汇总表那一列）
// 数学上恰好等于 MRR（平均倒数排名）——不是巧合，是同一口径的两种读法。
// Recall@k 是另一个维度：不看排名先后，只看「进没进前 k」（0/1 计数占比），
// 教程 week15「检索质量指标」的 Recall@k / MRR 在这里落地。
import type { RetrievedChunk } from "../../rag/types.js";
import type { EvalResult, ScorerOutput } from "../types.js";

/** 判定「算命中」的排名窗口：期望文档排进前 3 名才算通过（recall@3 口径） */
export const EVAL_RELEVANCE_K = 3;

/** 套件级检索指标（0..1）：recall@k = 期望文档进前 k 的用例占比；mrr = 平均倒数排名 */
export interface RetrievalMetrics {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
}

/**
 * 比对期望文档与真实检索结果：第一个 docId 匹配的结果的排名决定一切。
 * @param expectedDocId 期望命中的文档 docId（corpus.ts 里定义）
 * @param results RagStore.search 返回的 top-k 结果（按相似度降序）
 */
export function scoreRetrieval(expectedDocId: string, results: RetrievedChunk[]): ScorerOutput {
  // findIndex 未命中返回 -1，+1 后 rank=0 表示「不在结果里」，免去 null 分支
  const rank = results.findIndex((chunk) => chunk.docId === expectedDocId) + 1;
  const score = rank > 0 ? 1 / rank : 0;
  const passed = rank >= 1 && rank <= EVAL_RELEVANCE_K;

  // 给人看的差异说明：期望谁 / 排第几 / 实际 top-k 命中了哪些文档
  const topDocIds = results.map((chunk) => chunk.docId).join("、");
  const detail =
    rank > 0
      ? `期望文档 ${expectedDocId} 命中排名第 ${rank} 名（top-${results.length} 实际命中 docId：${topDocIds}）`
      : `期望文档 ${expectedDocId} 未出现在 top-${results.length} 检索结果中（实际命中 docId：${topDocIds}）`;

  return { passed, score, detail };
}

/**
 * 套件级指标：对检索用例的结果聚合 Recall@1/3/5 与 MRR。
 *
 * 实现利用「单例 score = 1/rank」的既有口径反推排名窗口，不做第二次检索：
 *   score >= 1/k  ⟺  rank <= k（1/rank 与 1/k 是同一种 double 运算，比较精确）；
 *   mrr = score 的算术平均（倒数排名的平均 = 平均倒数排名，定义即如此）。
 * 非检索套件的结果行会被过滤掉——把 TrajectoryEvalResult 混进来不影响算术。
 * 空集返回全 0（而不是 NaN）：套件被整体跳过时调用方根本不会调它，
 * 但纯函数不该在边界上产出 NaN 污染报告。
 */
export function computeRetrievalMetrics(results: EvalResult[]): RetrievalMetrics {
  const rows = results.filter((r) => r.suite === "retrieval");
  if (rows.length === 0) {
    return { recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 };
  }
  const hitAt = (k: number): number => rows.filter((r) => r.score >= 1 / k).length;
  return {
    recallAt1: hitAt(1) / rows.length,
    recallAt3: hitAt(3) / rows.length,
    recallAt5: hitAt(5) / rows.length,
    mrr: rows.reduce((sum, r) => sum + r.score, 0) / rows.length,
  };
}
