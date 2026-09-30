// next.config.mjs —— 最小配置：无额外插件。
// 刻意不用 next/font/google（构建必须离线可行），字体走系统栈（见 globals.css 的 --font-sans）。
// outputFileTracingRoot：上层博客仓库另有 pnpm-lock.yaml，不显式指定的话 Next 会把
// workspace root 误推断到上层仓库（多 lockfile 警告 + 追踪范围失真），这里钉死到 agent-app。
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: workspaceRoot,
  // standalone：next build 额外产出自带精简 node_modules 的自包含产物（server.js），
  // 供 Dockerfile.web 运行阶段使用（turborepo 官方 Docker 形态）。加法改动：
  // dev / next start 行为不变，只是多一份产物。实测（Next 15.5）产物在
  // apps/web/.next/standalone/web/server.js —— 应用落在 standalone/web/ 子目录，
  // Dockerfile.web 的拷贝路径与此对齐。
  output: "standalone",
};

export default nextConfig;

