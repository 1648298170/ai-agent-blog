// vitest.config.ts —— engine 测试运行器配置（与 apps/api 同选型：ESM/TS 开箱即用）
// 目录约定：test/*.spec.ts 是需要真实基础设施（PG/Redis）的集成测试，
// 由环境变量 RUN_INFRA_TESTS=1 门控（root 脚本 pnpm test:infra 负责设置；
// 服务不可达时套件自动 describe.skip，不炸普通 pnpm test）。
// 红队加固轮：护栏/入库闸的单测会触发审计落盘（gate.denied / ingest.rejected 等），
// 这里把 AGENT_AUDIT_LOG 指到系统临时文件——测试照常产生审计行为，但不污染真实
// .data/（与 evals 报告单测用可注入路径是同一纪律；断言审计内容的用例自行覆盖本值）。
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // 每个文件独立模块注册表：与 apps/api 同款隔离，防止引擎模块级单例（如 rag store）互相串
    isolate: true,
    // infra 集成测试共用同一个真实 PG/Redis：并行文件会在共享表上互相插数据，
    // 让「相对计数」类断言偶发失败（before 与 count 之间被别的 spec 插入 N 块）。
    // 串行化文件执行——全套件 <2s，串行损失可忽略，换确定性。
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      AGENT_AUDIT_LOG: join(tmpdir(), "agent-app-engine-tests-audit.log"),
    },
  },
});
