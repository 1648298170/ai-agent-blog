// session.memory.ts —— 短期记忆（会话窗口）的内存实现：Map 存储 + 共享压缩算法
// 教程《记忆 TS 版》的 Redis 版换成 Map：读写一行不改，代价是重启就没、多实例不共享
// （TTL 那道阀门属于 Redis 侧 'EX' 续期，内存版无从谈起——week17 实战已补上 Redis 版：
//  session.redis.ts，压缩算法与本文件共用 memory/compression.ts 这一份实现）。
// 读写时机：组装 prompt 前读 getWindow，每轮回答后 append 写入；写入即压缩
// （对应教程 writeBack 里 append 之后紧跟 compressSession 的时机）。
//
// 压缩的原理、阈值与降级策略全部在 compression.ts（唯一实现），本文件只管
// "turns 存在哪个 Map 里"这一件事——换存储不换算法，改阈值只改一处。
import {
  compressIfNeeded,
  defaultSummarizer,
} from "./compression.js";
import type { SessionStoreOptions, Summarizer } from "./compression.js";
import type { ChatTurn, SessionStore, SessionSummary } from "./types.js";

// 压缩阈值 / 前缀 / 摘要器类型自 compression.ts 再出口：
// selftest 等旧调用方 `import { SUMMARY_PREFIX } from "@agent-app/engine/memory"` 不受抽取影响。
export { COMPRESS_AFTER, KEEP_RECENT, SUMMARY_PREFIX } from "./compression.js";
export type { SessionStoreOptions, Summarizer } from "./compression.js";

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatTurn[]>();
  /** 各会话最后活跃时间（epoch ms）：与会话 Map 平行维护，listSessions 的排序依据 */
  private readonly updatedAt = new Map<string, number>();
  private readonly summarize: Summarizer;

  constructor(options: SessionStoreOptions = {}) {
    this.summarize = options.summarize ?? defaultSummarizer;
  }

  async append(sessionId: string, turn: ChatTurn): Promise<void> {
    const turns = this.sessions.get(sessionId) ?? [];
    turns.push({ ...turn });
    // 写入即压缩（超过阈值才真正动手）；压缩算法在 compression.ts，两行接上
    this.sessions.set(sessionId, await compressIfNeeded(sessionId, turns, this.summarize));
    this.updatedAt.set(sessionId, Date.now());
  }

  /** 取最近 limit 轮（默认 20）：截断阀门，防单会话内上下文爆炸 */
  async getWindow(sessionId: string, limit = 20): Promise<ChatTurn[]> {
    const turns = this.sessions.get(sessionId) ?? [];
    return turns.slice(-Math.max(0, limit));
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.updatedAt.delete(sessionId);
  }

  /** 历史会话清单：按最后活跃降序（会话记录功能的列表数据源） */
  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.entries()]
      .map(([sessionId, turns]) => ({
        sessionId,
        turns: turns.length,
        updatedAt: new Date(this.updatedAt.get(sessionId) ?? 0).toISOString(),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 全量轮次（压缩后含摘要轮，如实返回）；未知会话返回 [] */
  async getHistory(sessionId: string): Promise<ChatTurn[]> {
    const turns = this.sessions.get(sessionId) ?? [];
    return turns.map((turn) => ({ ...turn }));
  }
}
