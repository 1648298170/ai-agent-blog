// retrieve.ts —— 语义检索 + 引用拼装：RAG 零件的总装出口
// 引用编号由后端分配、模型只负责标号（第 15 周 Day 4 溯源思想）：
// 来源标题在模型手里是可以被编造的素材，在检索结果里才是事实。
//
// ── 本文件在整条链路里的位置（组装者视角）────────────────────────────────
//
//   入库方向：apps/kb/ingest ──→ setRagStore(.createJsonRagStore())  ← 换库就这一行
//                              ──→ getRagStore().upsert(切块+向量后的 Chunk[])
//
//   问答方向：apps/kb/cli ──→ searchKnowledge("问题", 5)
//                              │ 内部两步：embed([问题]) → store.search(查询向量, 5)
//                              ↓
//                             命中的 RetrievedChunk[]（带 score，降序）
//                              ↓ formatCitations()
//                            "[1] 标题" 引用块，编号与命中顺序严格对号
//
// 也就是说：切块（chunker）和向量化（embedder）是纯零件，本文件把它们和存储
// （store/persistence）串成两个对外的动作——「入库」和「检索」。
//
// score 是余弦相似度 = 1 - pgvector 余弦距离：教程 ask() 里「distance > 0.85 拒答」
// 的闸在本库等价于 score < 0.15，由下游应用把关。不做同文档去重：教程 search 就是
// 纯 top-k，去重会改变 Hit@k 的语义，参数怎么动让评估集说话。
import { embed } from "./embedder.js";
import { createInMemoryRagStore } from "./store.memory.js";
import { trace } from "../trace.js";
import type { RagFilter, RagStore, RetrievedChunk } from "./types.js";

/** 默认挂内存库；第 2 阶段 kb 应用可调 setRagStore 换成 pgvector 实现，检索代码一行不改。
 * 模块级单例：同进程里所有调用方（入库 CLI、问答 CLI、客服 knowledge 工人）
 * 共享同一个库实例，setRagStore 换一次库全局生效。
 */
let store: RagStore = createInMemoryRagStore();

/** 替换底层存储（换库的接缝就在这一行） */
export function setRagStore(next: RagStore): void {
  store = next;
}

/** 拿当前存储（入库方用：chunk 切好、embed 完，调 store.upsert 入库） */
export function getRagStore(): RagStore {
  return store;
}

/**
 * 语义检索：query 向量化后按余弦相似度取 top-k。
 * 注意：查询与入库必须用同一个 embedding 模型，混用则坐标空间不同，检索直接失真。
 *
 * 为什么查询也要过一遍 embed：检索的本质是"向量 vs 向量"比夹角——
 * 库里存的是"块文本的向量"，用户的问题是一句新文本，必须用同一个 embedding 模型
 * 把它映射到同一个坐标空间，才有"相似度"可言。这就是换 embedding 模型必须全库重嵌的原因。
 */
export async function searchKnowledge(
  query: string,
  k = 5,
  filter?: RagFilter,
): Promise<RetrievedChunk[]> {
  const [queryEmbedding] = await embed([query]);
  const hits = await store.search(queryEmbedding, k, filter);
  trace(
    "🔎",
    hits.length > 0
      ? `检索 → 「${query}」命中 ${hits.length} 块，top1：《${hits[0].title}》相似度 ${hits[0].score.toFixed(3)}`
      : `检索 → 「${query}」无命中（知识库为空或没有相关内容）`,
  );
  return hits;
}

/**
 * 把命中的块拼成 "[1] 标题" 引用块（每行一条，编号与检索结果顺序对号入座）。
 * 纯函数，不碰网络。
 */
export function formatCitations(chunks: RetrievedChunk[]): string {
  return chunks.map((chunk, i) => `[${i + 1}] ${chunk.title}`).join("\n");
}
