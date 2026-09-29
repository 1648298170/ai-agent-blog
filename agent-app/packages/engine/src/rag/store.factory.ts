// store.factory.ts —— RAG 存储的 env 驱动工厂：一行换库的「总开关」（week14 pgvector 实战）
// 消费方（cli chat/kb/service 启动、api kb.service、engine ingest）统一改成
//   setRagStore(createRagStoreFromEnv())
// 之后底层实现由环境变量决定，业务代码零改动：
//
//   RAG_STORE=memory    → 内存 Map（selftest / 无盘场景）
//   RAG_STORE=json      → JSON 快照 .data/kb-store.json（默认，离线跨进程共享，与改造前完全一致）
//   RAG_STORE=pgvector  → PostgreSQL + pgvector（pnpm infra:up 起的库，HNSW 余弦检索）
//
// 铁律：不配置（或值不认识）一律回 json 默认——离线优先原则，
// 没起 Docker 的机器上行为与改造前逐字节一致，绝不因新功能破坏老默认。
import { loadEnv } from "../config.js";
import { createInMemoryRagStore } from "./store.memory.js";
import { createJsonRagStore } from "./persistence.js";
import { createPgVectorRagStore } from "./store.pgvector.js";
import type { RagStore } from "./types.js";

/** RAG_STORE 合法取值（默认 json） */
export type RagStoreKind = "memory" | "json" | "pgvector";

/** 默认值常量：文档与工厂共用同一口径 */
export const DEFAULT_RAG_STORE: RagStoreKind = "json";

/** 规范化 RAG_STORE 取值：trim + 小写；不认识时打告警并回默认（不炸启动） */
function normalizeKind(raw: string | undefined): RagStoreKind {
  const value = (raw ?? DEFAULT_RAG_STORE).trim().toLowerCase();
  if (value === "memory" || value === "json" || value === "pgvector") return value;
  console.warn(`[rag-store] 未认识的 RAG_STORE=「${raw}」（可选 memory | json | pgvector），按默认 ${DEFAULT_RAG_STORE} 处理`);
  return DEFAULT_RAG_STORE;
}

/**
 * 按环境变量装配 RAG 存储（默认 json 快照 = 改造前的行为）。
 * env 参数缺省读 loadEnv()（.env 文件 + 进程环境变量合并），测试可注入。
 */
export function createRagStoreFromEnv(env: Record<string, string> = loadEnv()): RagStore {
  switch (normalizeKind(env.RAG_STORE)) {
    case "memory":
      return createInMemoryRagStore();
    case "pgvector":
      return createPgVectorRagStore();
    case "json":
    default:
      return createJsonRagStore();
  }
}
