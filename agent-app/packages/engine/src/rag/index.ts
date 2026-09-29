// rag/index.ts —— RAG 零件 barrel：类型契约 / 递归切块 / 批量向量化 / 内存余弦库 /
// 检索与引用 / JSON 快照持久化 / 入库核心（ingest）。
// 子路径 @agent-app/engine/rag 的出口即本文件；模块间相对导入不变。
export * from "./types.js";
export * from "./chunker.js";
export * from "./embedder.js";
export * from "./store.memory.js";
export * from "./retrieve.js";
export * from "./persistence.js";
export * from "./ingest.js";
