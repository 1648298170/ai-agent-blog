// store.memory.ts —— 内存版 RAG 存储：Map 实现 + 余弦相似度检索
// 对应教程《RAG TS 全链路》里 pgvector 的 `<=>` 余弦距离：这里算的是相似度（1 - 距离），
// 值越大方向越近。第 2 阶段 kb 应用按 rag/types.ts 的 RagStore 契约换成 pgvector 版。
import type { Chunk, DocumentContent, DocumentSummary, RagFilter, RagStore, RetrievedChunk } from "./types.js";

/**
 * 余弦相似度：只看向量方向、不看模长。
 * 直觉：把每块文本想象成高维空间里的一个"箭头"，两个箭头夹角越小越相似。
 * - 模长（箭头长度）反映"文本里词有多少"，不代表"主题有多强"——
 *   一段 500 字的详述和一句 20 字的问答只要主题相同，方向就该接近，
 *   所以用 dot / (|a|·|b|) 把模长除掉，纯比角度。
 * - =1 同方向（说的是一回事）；=0 垂直（无关）；<0 反向（罕见，文本检索里基本遇不到）。
 *
 * 脏数据防线：维度不一致、零向量、NaN/Infinity 坐标、平方溢出，一律返回 0 而不是抛错——
 * 检索不该被单条脏数据炸掉，得分也绝不允许漏出 NaN 污染排序（NaN 参与比较恒为 false，
 * sort 结果会变得玄学）。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0; // NaN/Infinity 坐标当场出局
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0; // 零向量：没有方向可言
  const score = dot / denom; // 坐标过大时 dot/norm 会溢出成 Infinity → 0/0 = NaN，最后再兜一道
  return Number.isFinite(score) ? score : 0;
}

/** 创建内存版 RAG 存储：chunk 按唯一 id 存 Map，upsert 同 id 覆盖 */
export function createInMemoryRagStore(): RagStore {
  const chunks = new Map<string, Chunk>();

  return {
    async upsert(list: Chunk[]): Promise<void> {
      for (const chunk of list) {
        chunks.set(chunk.id, { ...chunk }); // 浅拷贝隔离，入库后外部改动不影响库内数据
      }
    },

    async deleteDoc(docId: string): Promise<void> {
      // 删除链路要清干净：同一文档的所有切块一并移除，最怕新旧两版同时在库里
      for (const [id, chunk] of chunks) {
        if (chunk.docId === docId) chunks.delete(id);
      }
    },

    /** 文档级清单：遍历一次按 docId 聚合（块的 title 同文档恒定，取首见即可） */
    async listDocs(): Promise<DocumentSummary[]> {
      const docs = new Map<string, DocumentSummary>();
      for (const chunk of chunks.values()) {
        const existing = docs.get(chunk.docId);
        if (existing) {
          existing.chunks += 1;
        } else {
          docs.set(chunk.docId, { docId: chunk.docId, title: chunk.title, chunks: 1 });
        }
      }
      return [...docs.values()];
    },

    /** 读整篇文档：同 docId 的块按 index 升序、空行分隔拼回全文（embedding 不随文返回） */
    async readDoc(docId: string): Promise<DocumentContent> {
      // 先圈出同文档的块并按阅读顺序排序：块是按 index 依次切的，
      // 拼回全文必须还原入库时的顺序，乱序的"全文"比没有更糟
      const own = [...chunks.values()]
        .filter((chunk) => chunk.docId === docId)
        .sort((x, y) => x.index - y.index);
      if (own.length === 0) {
        // 错误礼仪同 embedder.ts：中文报错 + 告诉用户怎么修，不甩英文堆栈
        throw new Error(
          `文档不存在：${docId}。请先入库对应文档（pnpm kb:ingest <文件>），` +
            "或用 listDocs 查看当前知识库里实际有哪些文档。",
        );
      }
      const { title } = own[0]; // 块的 title 同文档恒定（listDocs 同款假设），取首块即可
      return { docId, title, chunks: own.length, text: own.map((chunk) => chunk.text).join("\n\n") };
    },

    async search(queryEmbedding: number[], k: number, filter?: RagFilter): Promise<RetrievedChunk[]> {
      // 暴力全扫：每块都算一次余弦、排序、取前 k。
      // 本库的定位是学习版 + 几百块规模——每块打分 ~微秒级，全扫就是毫秒级，够用。
      // 真到十万块以上才需要 pgvector 的 ANN 索引（HNSW：不精确但近似最快，教程 week14 的主题）。
      // 三步：①圈候选（跳过未向量的块 + 硬过滤）②逐块打分 ③降序取前 k。
      const scored: RetrievedChunk[] = [];
      for (const chunk of chunks.values()) {
        if (chunk.embedding === null) continue; // 未向量的块不参与检索
        if (filter?.docId !== undefined && chunk.docId !== filter.docId) continue; // 硬过滤先圈候选集
        scored.push({ ...chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) });
      }
      scored.sort((x, y) => y.score - x.score); // 相似度降序，前 k 条就是最相似的 k 块
      // k 夹到 ≥0：调用方传 0 或负数时返回空而不是 slice(-n) 反向截取的坑
      return scored.slice(0, Math.max(0, k));
    },

    async count(): Promise<number> {
      return chunks.size;
    },
  };
}
