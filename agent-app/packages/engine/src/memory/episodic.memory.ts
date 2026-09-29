// episodic.memory.ts —— 情景记忆（历史对话事件）的内存实现
// 对应教程《记忆 TS 版》pgvector 的 conversation_events 表：摘要转向量入库，检索取 top-k
// （教程默认 top3）。余弦走 store.memory 的脏数据安全版：退化向量得分 0，不产生 NaN。
//
// ── 它解决 SessionStore 管不了的事 ──────────────────────────────────────
// 短期记忆（会话窗口）按 sessionId 隔离，生命周期到 /new 为止。但用户会说：
//   "还是上次那个问题" / "接着昨天聊"
// 上次的对话在另一个 sessionId 的窗口里，短期记忆够不着，模型只能装傻。
// 情景记忆的打法：每段会话结束 → 摘要 → 向量化 → 归档；
// 新会话开场 → 拿当前问题向量 recall() → 找回最像的 3 段历史 → 注入 prompt。
// 「摘要 + 向量」而不是「逐字 + 向量」：摘要短（省向量成本），且天然脱敏降噪。
//
// ── 和 rag/ 的关系：同一套数学，不同的数据 ─────────────────────────────
// remember ≈ RagStore.upsert（入库），recall ≈ RagStore.search（余弦 top-k）。
// 区别只在检索对象：rag 搜"文档切块"，这里搜"历史会话摘要"。
// 余弦函数直接复用 rag/store.memory 的脏数据安全版——一份实现两处受益。
import { cosineSimilarity } from "../rag/store.memory.js";
import type { EpisodicRecord, EpisodicStore } from "./types.js";

/** createdAt 规范化：非法或空的日期串兜底成当前时间的 ISO 串（防御调用方传脏数据） */
function toIsoDate(raw: string): string {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export class InMemoryEpisodicStore implements EpisodicStore {
  private readonly records: EpisodicRecord[] = [];

  /** 归档一条情景：回答结束后调用，summary 由入库方拼好（用户问 + 助手答的摘要） */
  async remember(record: EpisodicRecord): Promise<void> {
    // 浅拷贝隔离 + createdAt 统一成 ISO 串，入库后的外部改动不污染库内数据
    this.records.push({ ...record, createdAt: toIsoDate(record.createdAt) });
  }

  /**
   * 检索最相似的 k 条历史情景（默认 3，教程 top3），按余弦相似度降序。
   * 同分按入库先后稳定排序：相同向量的一批记录检索结果可复现，不随引擎排序实现漂移。
   */
  async recall(
    embedding: number[],
    k = 3,
  ): Promise<{ sessionId: string; summary: string; score: number }[]> {
    const scored = this.records.map((record, order) => ({
      sessionId: record.sessionId,
      summary: record.summary,
      score: cosineSimilarity(embedding, record.embedding),
      order,
    }));
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    return scored
      .slice(0, Math.max(0, k))
      .map(({ sessionId, summary, score }) => ({ sessionId, summary, score }));
  }
}
