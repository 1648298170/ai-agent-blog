// memory/types.ts —— 三层记忆契约（短期会话 / 长期偏好 / 情景记忆，勿改签名）
//
// ── 为什么 Agent 需要记忆 ────────────────────────────────────────────────
// LLM 本身是无状态的：每次 generateText 调用都是"失忆"的，它以为的"记得上文"，
// 其实是你把历史消息重新塞进了 messages。所以 Agent 的"记忆"= 谁来存历史、
// 何时塞多少进 prompt。三层记忆就是在回答这两个问题的三种策略：
//
//   人类记忆对照          本项目实现          存什么            生命周期
//   ─────────────        ─────────────       ────────          ─────────
//   工作记忆       ⇄     SessionStore        逐字对话窗口       本会话内
//   长期语义记忆   ⇄     PreferenceStore     提炼后的事实       跨会话、按用户
//   情景记忆       ⇄     EpisodicStore       历史对话的摘要     跨会话、按相似度召回
//
// 读写时机（三个实现共同的节奏）：
//   组装 prompt 前 → 读（getWindow / all / recall）
//   每轮回答结束   → 写（append / set / remember）
//
// 为什么是接口：现在的实现全是内存 Map（进程重启即失忆），
// 教程主线对应 Redis（短期，TTL 天然匹配会话生命周期）、PG（长期，行级 upsert）、
// pgvector（情景，向量检索）——换实现时业务代码零改动（同 rag/ 的接缝思想）。

/** 一轮对话：role 三选一，toolName 记录该轮触发的工具（可选）。
 *
 * - content 是明文文本（组 prompt 时直接拼进 messages，无需再转换）
 * - toolName 可选：标记这轮 assistant 的话是"工具调用后的回答"，
 *   调试/审计时能区分"直接回答"和"查完工具再回答"
 */
export interface ChatTurn {
  role: "user" | "assistant" | "system";
  content: string;
  toolName?: string;
}

/** 短期记忆：按 sessionId 归档的会话窗口。
 *
 * 方法语义：
 * - append    每轮追加一条（用户问完写 user、助手答完写 assistant）
 * - getWindow 取最近 limit 条（默认 20）——这是"塞进 prompt 的部分"，
 *   实现内部可能还压了更早的摘要（见 session.memory.ts），窗口 = 摘要 + 近期原文
 * - clear     用户 /new 开新会话时清空重来
 *
 * 粒度是 sessionId 不是 userId：同一个用户开三个会话，三个窗口互不串台。
 */
export interface SessionStore {
  append(sessionId: string, turn: ChatTurn): Promise<void>;
  getWindow(sessionId: string, limit?: number): Promise<ChatTurn[]>;
  clear(sessionId: string): Promise<void>;
  /** 历史会话清单（按最近活跃降序）：会话记录功能的列表数据源 */
  listSessions(): Promise<SessionSummary[]>;
  /** 取某会话的全量轮次（压缩后含摘要轮，如实返回）；未知会话返回 [] */
  getHistory(sessionId: string): Promise<ChatTurn[]>;
}

/** 会话摘要：历史会话列表的一行（listSessions 的返回项）。
 *
 * - turns     压缩后的当前轮数（含合成摘要轮），不是历史累计值
 * - updatedAt 最后一次 append 的时间（ISO 8601）——列表按它降序
 */
export interface SessionSummary {
  sessionId: string;
  turns: number;
  updatedAt: string;
}

/** 长期记忆：用户偏好键值表（跨会话存"这个用户是谁"）。
 *
 * 典型键值对：
 *   ("u_001", "回复风格") → "简洁，别废话"
 *   ("u_001", "所属团队") → "后端组"
 *
 * 生命周期比会话长得多：会话开始时 all() 读出全部偏好注入 system prompt
 * （"已知该用户的偏好：…"），模型立刻"认识"这个老用户——哪怕这是他本周第一次来。
 * 「用户改口」= 同 (userId, key) 再 set 一次，覆盖即更新（PG 版就是 upsert 一行）。
 */
export interface PreferenceStore {
  get(userId: string, key: string): Promise<string | null>;
  set(userId: string, key: string, value: string): Promise<void>;
  all(userId: string): Promise<Record<string, string>>;
}

/** 情景记忆的一条归档：会话摘要 + 其 Embedding。
 *
 * - summary   整段会话压成的一句话（"用户咨询了订单 A-1024 的物流并得到解答"）
 * - embedding 摘要的语义向量——跨会话检索靠它比相似度（与 rag/ 共用余弦算法）
 * - createdAt 归档时间，召回并列时的稳定排序依据
 */
export interface EpisodicRecord {
  sessionId: string;
  summary: string;
  embedding: number[];
  createdAt: string;
}

/** 情景记忆：向量检索 top-k 相似历史情景。
 *
 * 解决 SessionStore 管不了的事：新会话开场，用户说"还是上次那个问题"——
 * 上次的问题在另一个 sessionId 里，逐字窗口够不着；
 * recall() 拿当前问题的向量去所有历史会话摘要里找最像的 3 条，
 * 注入 prompt，模型就"想起来"上次聊过什么。
 */
export interface EpisodicStore {
  remember(record: EpisodicRecord): Promise<void>;
  recall(embedding: number[], k?: number): Promise<{ sessionId: string; summary: string; score: number }[]>;
}
