// report.ts —— 评测报告：控制台表格（人扫读）+ JSON 落盘（机器消费 / 留档）
//
// ── 为什么要两种输出 ─────────────────────────────────────────────────────
// 控制台表格给「刚跑完 pnpm eval 想看结果的人」：分套件汇总 + 失败详情，
// 十秒定位问题；.data/eval-report.json 给「想对比多轮回归的人」：
// 结构化、可 diff、带 datasetVersion 与 startedAt。同一份 EvalReport，
// 两种投影，消费场景不同。
//
// ── 落盘路径为什么跟着 cwd 走 ────────────────────────────────────────────
// 与 rag/persistence.ts 的 kb-store.json 同款解析（join(process.cwd(), ".data")）：
// 根脚本约定 cwd = agent-app（README「脚本统一从根目录跑」），.data/ 已在
// .gitignore。filePath 做成可注入参数——单测写临时目录，不污染真实 .data。
//
// ── 控制台标记为什么是纯文本 [PASS]/[FAIL] ───────────────────────────────
// 不用 ✓/✗ 或颜色码：Windows 老终端、CI 日志、grep 管道都要能稳定识别，
// 纯 ASCII 标记在哪都是原样输出（grep "[FAIL]" 直接捞出失败行）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalReport, EvalSuiteName } from "./types.js";

/** 默认落盘位置：agent-app/.data/eval-report.json（与 kb-store.json 同款解析） */
const DEFAULT_REPORT_PATH = join(process.cwd(), ".data", "eval-report.json");

/** 套件展示顺序固定（trajectory 在前：它与 chat REPL 同链路，最常看；
 * retrieval / judge 在后：Tier 2/3 门控套件，无 key 时它们整行 0/0，
 * Tier 编号即展示顺序） */
const SUITE_ORDER: EvalSuiteName[] = ["trajectory", "routing", "retrieval", "judge"];

/** 单套件聚合行：表格与 JSON 消费方都按这个口径算 */
interface SuiteSummary {
  suite: EvalSuiteName;
  total: number;
  passed: number;
  avgScore: number;
  durationMs: number;
}

/** 把报告按套件聚合（skipped 的用例不计入任何套件的 avg） */
function summarizeBySuite(report: EvalReport): SuiteSummary[] {
  return SUITE_ORDER.map((suite) => {
    const rows = report.results.filter((r) => r.suite === suite);
    const avgScore = rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.score, 0) / rows.length;
    return {
      suite,
      total: rows.length,
      passed: rows.filter((r) => r.passed).length,
      avgScore,
      durationMs: rows.reduce((sum, r) => sum + r.durationMs, 0),
    };
  });
}

/** 左对齐补空格（表格列对齐用；不用第三方库，宽度手调够用） */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * 打印报告到控制台：逐用例标记行 → 分套件汇总表 → 失败用例详情。
 * 只读 report + console.log，不做任何 IO 副作用（落盘是 writeReportFile 的事）。
 */
export function printReportToConsole(report: EvalReport): void {
  const { totals } = report;
  console.log("=".repeat(64));
  // 展示层的「共」= 执行 + 跳过（totals.total 自 P2 起只数实际执行的用例，
  // 退出码判据 passed === total 不受跳过影响——跳过 ≠ 失败）
  console.log(
    `评测报告 · 数据集 v${report.datasetVersion} · 共 ${totals.total + totals.skipped} 例` +
      `（通过 ${totals.passed} / 失败 ${totals.failed} / 跳过 ${totals.skipped}）· 总耗时 ${report.durationMs}ms`,
  );
  console.log("=".repeat(64));

  // 逐用例标记行：绿跑也能看到 [PASS] 证据，失败行一眼可 grep
  for (const result of report.results) {
    console.log(`[${result.passed ? "PASS" : "FAIL"}] ${result.caseId} · ${result.suite} · score ${result.score.toFixed(3)}`);
  }

  // 分套件汇总表：suite | passed/total | avg score | duration
  // 注意口径：retrieval 行的 avg score = MRR——单例 score 是命中排名的倒数
  // （见 scorers/retrieval.ts），均值即平均倒数排名，与 metrics 里的 mrr 同源
  console.log("-".repeat(64));
  console.log(`${pad("suite", 14)}${pad("passed/total", 14)}${pad("avg score", 12)}duration`);
  for (const row of summarizeBySuite(report)) {
    console.log(
      `${pad(row.suite, 14)}${pad(`${row.passed}/${row.total}`, 14)}${pad(row.avgScore.toFixed(3), 12)}${row.durationMs}ms`,
    );
  }
  console.log("-".repeat(64));

  // 套件级指标（P2 检索套件跑完才有）：Recall@k / MRR 一行速读
  if (report.metrics !== undefined) {
    console.log(
      `retrieval 指标: recall@1=${report.metrics["recall@1"]?.toFixed(3) ?? "-"}` +
        ` recall@3=${report.metrics["recall@3"]?.toFixed(3) ?? "-"}` +
        ` recall@5=${report.metrics["recall@5"]?.toFixed(3) ?? "-"}` +
        ` mrr=${report.metrics["mrr"]?.toFixed(3) ?? "-"}`,
    );
    console.log("-".repeat(64));
  }

  // 失败用例详情：期望 vs 实际（全绿时整段跳过，输出零噪音）
  const failures = report.results.filter((r) => !r.passed);
  if (failures.length > 0) {
    console.log(`失败用例详情（${failures.length} 例）：`);
    for (const failure of failures) {
      console.log(`  [FAIL] ${failure.caseId} · ${failure.suite}`);
      console.log(`    ${failure.detail}`);
    }
    console.log("-".repeat(64));
  }

  // 跳过说明（P2 起）：为什么少了 50 条 + 怎么修——静默少跑一个套件最坑排查
  const skipEntries = Object.entries(report.skipReasons ?? {});
  if (skipEntries.length > 0) {
    console.log(`跳过说明（${report.skipped.length} 例，跳过 ≠ 失败）：`);
    for (const [suite, reason] of skipEntries) {
      console.log(`  · ${suite}: ${reason}`);
    }
    console.log("-".repeat(64));
  }

  console.log(totals.failed === 0 ? "全部通过" : `存在 ${totals.failed} 例失败，详见上方详情`);
}

/**
 * 报告落盘 JSON（pretty）。目录不存在自动建（mkdir -p 语义）。
 * @returns 实际写入的绝对路径（CLI 把它回显给用户）
 */
export function writeReportFile(report: EvalReport, filePath: string = DEFAULT_REPORT_PATH): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}
