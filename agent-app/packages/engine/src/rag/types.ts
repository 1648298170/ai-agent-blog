// rag/types.ts —— RAG 存储契约（第 2 阶段 kb 应用按此接口实现 pgvector 版，勿改签名）
//
// 这个文件是整个 rag/ 目录的"宪法"：其他 5 个文件全部围绕这里的类型工作。
// 看懂这 4 个类型，就看懂了 RAG 的数据形状：
//
//   一篇文档（docintel.pdf）                    一条检索结果
//   ┌────────────────────────┐   切块+向量化   ┌──────────────────────────────┐
//   │ "重排序是两阶段检索的…" │ ────────────→ │ Chunk { id, docId, title,    │
//   │ （一篇长文档）           │   chunkText    │         text, index,        │
//   └────────────────────────┘   + embed      │         embedding }          │
//                                             └──────────┬───────────────────┘
//                                                        │ 查询命中时加一分
//                                                        ▼
//                                             RetrievedChunk { ..., score }

/** 一个切块：检索的最小单位不是文档，是块。
 *
 * 字段逐个说：
 * - id        块的唯一键，格式约定 `"<docId>#<序号>"`（如 "faq.md-a1b2c3d4#3"）。
 *             Map 的 key、upsert 覆盖旧块的依据——同 id 再入库 = 更新，不会翻倍。
 * - docId     所属文档的 id（`"<文件名>-<内容hash8>"`）。deleteDoc 靠它整篇删除；
 *             RagFilter.docId 检索硬过滤也靠它（只在某一篇文档的块里找）。
 * - title     文档标题（来自文件名去扩展名）。给引用溯源用：答案里的 [1] 指向的就是它。
 * - text      块正文本身。最终拼进 prompt 喂给模型的就是这段文字。
 * - index     本块在原文档中的序号（第 0、1、2…块）。入库/调试时用，
 *             也让同文档的块保持阅读顺序。
 * - embedding 块正文的语义向量（embedding 模型算出的一串浮点数）。
 *             允许为 null：切块和向量化是两步，先切后嵌；null = "还没向量化的块"，
 *             检索时会跳过它（见 store.memory.ts 的 search）。
 */
export interface Chunk {
  id: string;
  docId: string;
  title: string;
  text: string;
  index: number;
  embedding: number[] | null;
}

/** 命中的块，附带相似度得分（余弦相似度，越大越近）。
 * score 的取值范围理论上是 [-1, 1]，文本检索实际落在 0~1：
 * - 0.8+  基本在说同一件事
 * - 0.5~  主题相关，细节未必对得上
 * - <0.15 视为不相关（对应教程里 pgvector "distance > 0.85 拒答" 的闸）
 */
export interface RetrievedChunk extends Chunk {
  score: number;
}

/** 检索硬过滤：相似度只该在圈内的候选间排序。
 * docId 限定"只在某一篇文档的块里找"——比如重传了一份新制度文档，
 * 问答时只想引用新版，就把旧版的候选全部排除在打分之外。
 */
export interface RagFilter {
  docId?: string;
}

/** 文档级摘要：知识库管理 UI 的列表行（一个 docId 一行） */
export interface DocumentSummary {
  docId: string;
  title: string;
  /** 该文档被切成了多少块 */
  chunks: number;
}

/** RAG 存储接口：内存版见 store.memory.ts，第 2 阶段可换 pgvector 版。
 *
 * 五个方法正好覆盖一个知识库的一生：
 *   upsert    入库/更新（切块 + 向量化之后调用）
 *   deleteDoc 下架整篇文档（重传新版前先删旧版，最怕新旧两版同时在库）
 *   listDocs  文档级清单（管理页列表：传过什么、各占多少块）
 *   search    检索：给查询向量，还我最像的 k 块
 *   count     库里现在有多少块（给入库完成的统计输出用）
 *
 * 为什么是接口而不是直接写死内存 Map：让"存储"成为可替换零件。
 * 教程主线是 pgvector（PostgreSQL + 向量索引），但那需要装数据库；
 * 内存版让第 1 阶段零依赖跑通全链路，检索代码（retrieve.ts）一行不改。
 */
export interface RagStore {
  upsert(chunks: Chunk[]): Promise<void>;
  deleteDoc(docId: string): Promise<void>;
  /** 文档级清单：按 docId 聚合（管理页的列表数据源，非检索路径） */
  listDocs(): Promise<DocumentSummary[]>;
  search(queryEmbedding: number[], k: number, filter?: RagFilter): Promise<RetrievedChunk[]>;
  count(): Promise<number>;
}
