// index.ts —— 外部数据源子域的桶出口（@agent-app/engine/datasource 子路径的公共面）。
// 与 rag / memory / tools / evals 同款发布方式：根出口（index.ts）不 re-export
// 这里，避免普通业务消费方误依赖第三方插件；API 层显式从子路径 import。
export * from "./types.js";
export * from "./registry.js";
export { opsProvider } from "./providers/ops.js";
export { OPS_MISSING_TOKEN_MESSAGE } from "./providers/ops-http.js";
