// tools/index.ts —— 工具层 barrel：注册表 + 演示工具 + 知识库检索工具 + 幂等层。
// 子路径 @agent-app/engine/tools 的出口即本文件。
export * from "./registry.js";
export * from "./demo-tools.js";
export * from "./kb-search.js";
export * from "./idempotency.js";
export * from "./compose.js";
