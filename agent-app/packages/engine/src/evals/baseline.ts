// baseline.ts —— 回归基线（教程 week16 Day 6）：把报告压成套件级数字快照，
// 存 .data/eval-baseline.json，下一轮跑完跟它比对——「感觉变好了」不算数，
// 数字比上一版跌了才算坏。
//
// ── 为什么按套件聚合而不是存整份报告 ──────────────────────────────────────
// 比对的判据只有三个数字：avg score、passed/total、（提示用的）datasetVersion。
// 存整份逐用例报告会让基线对单例噪声过敏（一条用例网络抖动慢了 300ms 也
// 会出现在 diff 里）；压成套件级均值后，基线对单例波动免疫、对人眼可读，
// 且文件小到可以直接 code review。逐用例的真相在 eval-report.json 里，
// 两份文件各管各的时段。
//
// ── 容差为什么是 3% ──────────────────────────────────────────────────────
// Tier 2/3 依赖真实模型，本来就有轻微软毛（embedding 微调、模型网关换版），
// 容差 0 起等于任何抖动都报警，报警疲劳之后没人看门禁。3% 以内视为噪声，
// 超过 3% 才认定真回归——数值与教程 Day 6 的建议口径一致（可按团队风险
// 偏好调整，改 BASELINE_TOLERANCE 一处即可）。
//
// ── 只比对「两边都有」的套件 ─────────────────────────────────────────────
// 基线里有、本轮没跑的套件（如无 key 机器上 retrieval/judge 被跳过）不比对：
// 环境缺失不是代码回归，按缺席放行；本轮新增的套件同理（没有历史可比）。
// CI 里没有 key、也没有基线文件——Tier 2/3 天然缺席，门禁只落在 Tier 1，
// 这正是 CI 侧的预期形态（README「CI 门禁只覆盖 Tier 1」）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalReport } from "./types.js";

/** 回归判定的容差：套件 avg score 相对基线跌幅超过该值才算回归（3%） */
export const BASELINE_TOLERANCE = 0.03;

/** 单套件基线数字：与 report.ts 汇总表同一口径（passed/total/avgScore） */
export interface BaselineSuiteStats {
  passed: number;
  total: number;
  avgScore: number;
}

/** 一份回归基线：datasetVersion 记录它压自哪一版数据集 */
export interface EvalBaseline {
  datasetVersion: string;
  /** 基线生成时间（ISO 8601，给人看） */
  savedAt: string;
  suites: Record<string, BaselineSuiteStats>;
}

/** 一条违规（或提示）：stale=true 表示「基线已过期」提示而非回归，不拦退出码 */
export interface BaselineViolation {
  suite: string;
  message: string;
  /** true = 仅提示（数据集版本不一致），不参与门禁判定 */
  stale?: boolean;
}

/** 默认落盘位置：agent-app/.data/eval-baseline.json（与 eval-report.json 同款解析，.data 不进 git） */
const DEFAULT_BASELINE_PATH = join(process.cwd(), ".data", "eval-baseline.json");

/** 把报告按套件聚合（skipped 的用例不计入任何套件——它本来就不在 results 里） */
function aggregateBySuite(report: EvalReport): Record<string, BaselineSuiteStats> {
  const buckets = new Map<string, { scores: number[]; passed: number }>();
  for (const result of report.results) {
    const bucket = buckets.get(result.suite) ?? { scores: [], passed: 0 };
    bucket.scores.push(result.score);
    if (result.passed) bucket.passed += 1;
    buckets.set(result.suite, bucket);
  }
  const suites: Record<string, BaselineSuiteStats> = {};
  for (const [suite, bucket] of buckets) {
    suites[suite] = {
      passed: bucket.passed,
      total: bucket.scores.length,
      avgScore: bucket.scores.reduce((sum, score) => sum + score, 0) / bucket.scores.length,
    };
  }
  return suites;
}

/** 从一轮报告构建基线（CLI 的 --update-baseline 调它，savedAt 取当下） */
export function buildBaseline(report: EvalReport): EvalBaseline {
  return {
    datasetVersion: report.datasetVersion,
    savedAt: new Date().toISOString(),
    suites: aggregateBySuite(report),
  };
}

/**
 * 基线落盘 JSON（pretty，可直接 code review）。目录不存在自动建。
 * @returns 实际写入的绝对路径（CLI 回显给用户）
 */
export function saveBaseline(baseline: EvalBaseline, filePath: string = DEFAULT_BASELINE_PATH): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf8");
  return filePath;
}

/**
 * 读取基线；文件不存在返回 null（首次运行还没有基线）。
 * 文件存在但损坏/形状不对：抛带修复指引的中文错误——静默把坏文件当
 * 「没有基线」会悄悄关掉整道门禁，宁可当场报错让用户删掉重建。
 */
export function loadBaseline(filePath: string = DEFAULT_BASELINE_PATH): EvalBaseline | null {
  if (!existsSync(filePath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`基线文件不是合法 JSON（${filePath}）：请删除该文件后执行 pnpm eval --update-baseline 重新生成。`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`基线文件内容形状不对（${filePath}）：请删除该文件后执行 pnpm eval --update-baseline 重新生成。`);
  }

  // 逐字段校验后重建类型化的基线对象（不做类型断言，坏字段当场报错）
  const datasetVersion: unknown = Reflect.get(parsed, "datasetVersion");
  const savedAt: unknown = Reflect.get(parsed, "savedAt");
  const suites: unknown = Reflect.get(parsed, "suites");
  if (typeof datasetVersion !== "string" || typeof savedAt !== "string" || typeof suites !== "object" || suites === null) {
    throw new Error(`基线文件内容形状不对（${filePath}）：请删除该文件后执行 pnpm eval --update-baseline 重新生成。`);
  }

  const suiteStats: Record<string, BaselineSuiteStats> = {};
  for (const [suite, value] of Object.entries(suites)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`基线文件中套件 ${suite} 的数字缺失（${filePath}）：请删除该文件后执行 pnpm eval --update-baseline 重新生成。`);
    }
    const passed: unknown = Reflect.get(value, "passed");
    const total: unknown = Reflect.get(value, "total");
    const avgScore: unknown = Reflect.get(value, "avgScore");
    if (typeof passed !== "number" || typeof total !== "number" || typeof avgScore !== "number") {
      throw new Error(`基线文件中套件 ${suite} 的数字缺失（${filePath}）：请删除该文件后执行 pnpm eval --update-baseline 重新生成。`);
    }
    suiteStats[suite] = { passed, total, avgScore };
  }

  return { datasetVersion, savedAt, suites: suiteStats };
}

/**
 * 比对当前报告与基线，返回违规列表（空数组 = 无回归）。
 * 判据（只对两边都出现的套件）：
 * 1. avg score 跌幅 > BASELINE_TOLERANCE（绝对差）→ 回归；
 * 2. passed/total 通过率下降 → 回归（少过一条用例就是实打实的回退，
 *    不设容差——avg score 容差保护的是「分数轻微抖动」，不是「用例掉了」）。
 * 数据集版本不一致 → 追加一条 stale=true 的提示（不拦退出码）：
 * 数据集变了，基线的口径已经对不上当前用例集，比对结论仅供参考。
 */
export function compareBaseline(report: EvalReport, baseline: EvalBaseline): BaselineViolation[] {
  const violations: BaselineViolation[] = [];
  const current = aggregateBySuite(report);

  for (const [suite, base] of Object.entries(baseline.suites)) {
    const now = current[suite];
    if (now === undefined) continue; // 基线有、本轮缺席（如无 key 被跳过）：环境缺失 ≠ 回归

    if (base.avgScore - now.avgScore > BASELINE_TOLERANCE) {
      violations.push({
        suite,
        message: `avg score 回归：基线 ${base.avgScore.toFixed(3)} → 当前 ${now.avgScore.toFixed(3)}，跌幅超过 3%。请检查最近对引擎/提示词/数据集的改动，确认后可执行 pnpm eval --update-baseline 重置基线。`,
      });
    }

    const baseRatio = base.total > 0 ? base.passed / base.total : 0;
    const nowRatio = now.total > 0 ? now.passed / now.total : 0;
    if (nowRatio < baseRatio) {
      violations.push({
        suite,
        message: `通过率回归：基线 ${base.passed}/${base.total}（${baseRatio.toFixed(3)}）→ 当前 ${now.passed}/${now.total}（${nowRatio.toFixed(3)}）。有用例从过变不过，请对照失败详情定位。`,
      });
    }
  }

  if (baseline.datasetVersion !== report.datasetVersion) {
    violations.push({
      suite: "dataset",
      stale: true,
      message: `基线数据集版本为 v${baseline.datasetVersion}，当前数据集已是 v${report.datasetVersion}，基线已过期：比对结论仅供参考，建议执行 pnpm eval --update-baseline 重新生成。`,
    });
  }

  return violations;
}
