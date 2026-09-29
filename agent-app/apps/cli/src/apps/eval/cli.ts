// apps/eval/cli.ts —— pnpm eval 入口：跑评测套件 → 打印报告 → 基线比对 → 定退出码
// 链路：runEvals()（Tier 1 离线全跑 + Tier 2/3 按 key 门控）→
// printReportToConsole()（逐用例标记 + 分套件汇总表 + 失败详情）→
// writeReportFile()（.data/eval-report.json 留档）→ 基线回归门禁（P3）→
// 全过且无回归退出 0，否则退出 1（CI 拿退出码当门禁：pnpm eval && ... 的那道闸）。
// 基线门禁三态：--update-baseline 写基线；已有基线则比对回退；没有则提示首次生成。
// 与 chat/cli.ts 同款约定：main(args) 导出供 index.ts 路由，直接运行时自启。
import { pathToFileURL } from "node:url";
import {
  buildBaseline,
  compareBaseline,
  loadBaseline,
  runEvals,
  saveBaseline,
} from "@agent-app/engine/evals";
import { printReportToConsole, writeReportFile } from "@agent-app/engine/evals";
import { enableTrace } from "@agent-app/engine/trace";

/**
 * 评测入口。args 支持 --trace（引擎执行轨迹）与 --update-baseline
 * （把本轮结果存为回归基线，见基线门禁三态）。
 */
export async function main(args: string[] = []): Promise<void> {
  if (args.includes("--trace")) enableTrace();

  let report;
  try {
    report = await runEvals();
  } catch (err) {
    // 错误礼仪同 chat/cli.ts：告诉用户怎么修，而不是甩一串堆栈
    console.error("评测运行失败：" + (err instanceof Error ? err.message : String(err)));
    console.error("请检查：1) 是否在 agent-app 根目录运行（报告落在 .data/ 下）；");
    console.error("          2) packages/engine 是否已构建（pnpm --filter @agent-app/engine build）；");
    console.error("          3) 上述错误信息中的修复指引。");
    process.exitCode = 1;
    return;
  }

  printReportToConsole(report);

  try {
    const written = writeReportFile(report);
    console.log(`报告已写入：${written}`);
  } catch (err) {
    console.error(`报告落盘失败：${err instanceof Error ? err.message : String(err)}`);
    console.error("请检查对 .data/ 目录的写权限（或当前工作目录是否为 agent-app 根目录）。");
    process.exitCode = 1;
    return;
  }

  // ── 基线回归门禁（P3，教程 week16 Day 6）───────────────────────────────
  // 退出码 = 两道闸的与：用例全过 && 无（非 stale）回归。
  // 基线是 .data/ 下的本地文件（不进 git）：换机器/CI 首次跑没有基线 →
  // 只提示不拦截；数据集版本不一致 → stale 提示，不拦截。
  let hasRegression = false;
  if (args.includes("--update-baseline")) {
    try {
      const saved = saveBaseline(buildBaseline(report));
      console.log(`已更新基线（${saved}）`);
    } catch (err) {
      console.error(`基线落盘失败：${err instanceof Error ? err.message : String(err)}`);
      console.error("请检查对 .data/ 目录的写权限（或当前工作目录是否为 agent-app 根目录）。");
      process.exitCode = 1;
      return;
    }
  } else {
    let baseline = null;
    let baselineBroken = false;
    try {
      baseline = loadBaseline();
    } catch (err) {
      // 基线损坏：报错并按无基线继续（本轮报告自身的失败仍然拦门禁），
      // 不让一个坏 JSON 把整轮评测打成基础设施错误
      baselineBroken = true;
      console.error(err instanceof Error ? err.message : String(err));
    }
    if (baseline !== null) {
      for (const violation of compareBaseline(report, baseline)) {
        if (violation.stale === true) {
          console.log(`[提示] ${violation.message}`);
        } else {
          console.log(`[REGRESSION] ${violation.suite}: ${violation.message}`);
          hasRegression = true;
        }
      }
    } else if (!baselineBroken) {
      console.log("首次运行可执行 pnpm eval --update-baseline 生成回归基线");
    }
  }

  // 全过且无回归 = 0，否则 = 1：CI 把 pnpm eval 当门禁，退出码就是判决
  process.exitCode = report.totals.passed === report.totals.total && !hasRegression ? 0 : 1;
}

// 直接运行（pnpm eval）时自动执行；被 index.ts 路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
