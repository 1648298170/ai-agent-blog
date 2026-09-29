// vitest.config.ts —— engine 测试运行器配置（与 apps/api 同选型：ESM/TS 开箱即用）
// 目录约定：test/*.spec.ts 是需要真实基础设施（PG/Redis）的集成测试，
// 由环境变量 RUN_INFRA_TESTS=1 门控（root 脚本 pnpm test:infra 负责设置；
// 服务不可达时套件自动 describe.skip，不炸普通 pnpm test）。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // 每个文件独立模块注册表：与 apps/api 同款隔离，防止引擎模块级单例（如 rag store）互相串
    isolate: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
