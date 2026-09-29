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
};

export default nextConfig;

