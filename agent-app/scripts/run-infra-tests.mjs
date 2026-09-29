// scripts/run-infra-tests.mjs —— Windows 可靠的 test:infra 包装：
// 设置 RUN_INFRA_TESTS=1 后在 @agent-app/engine 里跑 vitest（pgvector/Redis 集成测试）。
// 为什么不用 cross-env：项目零新增依赖原则；PowerShell 的 $env: 赋值不跨进程，
// 用 node 的 process.env 注入 + spawn 是最简单可靠的全平台方案。
// 前置：pnpm infra:up（两个服务 healthy）；服务不可达时套件自动 skip 并打印原因。
import { spawnSync } from "node:child_process";

const bin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  bin,
  ["--filter", "@agent-app/engine", "exec", "vitest", "run"],
  {
    stdio: "inherit",
    env: { ...process.env, RUN_INFRA_TESTS: "1" },
    shell: true,
  },
);
if (result.error !== undefined) {
  console.error(`[test:infra] 无法启动 ${bin}：${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
