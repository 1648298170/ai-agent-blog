// vitest.config.ts —— cli 的测试运行器（模式对齐 apps/api：node 环境 + 独立进程隔离）。
// cli 是 tsx 直跑包（无构建产物），vitest 开箱支持「TS 源码里 .js 后缀导入」的 NodeNext 解析。
// 运行：pnpm --filter @agent-app/cli test（vitest run）
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 纯后端：node 环境足够，不需要 jsdom
    environment: "node",
    // 测试收 test/ 目录（*.spec.ts）——src 保持纯运行时代码
    include: ["test/**/*.spec.ts"],
    // 每文件独立进程级模块注册表，保证 vi.mock 不串场
    isolate: true,
  },
});
