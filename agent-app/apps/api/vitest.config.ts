// vitest.config.ts —— 测试运行器选型：官方惯例是 jest + ts-jest，但本项目是
// ESM（"type":"module"）+ NodeNext 模块解析，ts-jest 的 ESM 支持需要大量
// 配置且极易踩坑；vitest 开箱支持 ESM/TS（esbuild 转换，无需编译产物），
// 并原生兼容 vite 系对「TS 源码里 .js 后缀导入」的解析（NodeNext 风格）。
// 这是对 NestJS 官方脚手架（jest）的一次有意偏离，理由如上。
// 运行：pnpm --filter @agent-app/api test（vitest run）/ test:watch（vitest 监听）。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 纯后端：node 环境足够，不需要 jsdom
    environment: "node",
    // 单测放 src 同目录（*.spec.ts），e2e 放 test/（*.e2e-spec.ts），与 Nest 官方布局一致
    include: ["src/**/*.spec.ts", "test/**/*.e2e-spec.ts"],
    // 测试隔离：每个文件独立进程级模块注册表，保证 vi.mock 不串场
    isolate: true,
    // 红队加固轮 H10：审批/输入闸的单测会触发审计落盘——默认指向系统临时文件，
    // 不污染真实 .data/audit.log（断言审计内容的用例在 spec 里自行覆盖本值）
    env: {
      AGENT_AUDIT_LOG: join(tmpdir(), "agent-app-api-tests-audit.log"),
    },
  },
});
