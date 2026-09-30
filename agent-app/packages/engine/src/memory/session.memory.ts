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

  // ── 为什么 append 必须按会话串行（生产缺陷：并发 append 丢消息）──────────
  // 旧实现是「读 Map → await compressIfNeeded（内部是 LLM 调用，秒级）→ 写回 Map」，
  // 同一会话的两个并发 append 会交错执行：
  //   t1  append A：读到 turns = [40 条]           ← B 的消息还没进来
  //   t2  append B：读到 turns = [40 条]           ← A 尚未写回，B 看不见 A
  //   t3  A 进入 compressIfNeeded：LLM 摘要要跑几秒（竞态窗口被拉到秒级）
  //   t4  B 也进入 compressIfNeeded：与 A 并行
  //   t5  A 写回 [41 条]（含 A 的消息）
  //   t6  B 写回 [41 条]（含 B 的消息、不含 A 的） ← 整体覆盖 A 的写回
  // 后写者全权覆盖 → 先写入的那条消息就丢了。压缩的秒级 LLM 调用把竞态从
  // 「理论存在」拉宽成「高并发下必然发生」。
  //
  // 修法：每个会话一条 Promise 链（串行队列）。append 把「读-压-写」三步整体
  // 挂到该会话链的尾部执行，同会话内不再交错；跨会话操作的是不同 Map 条目，
  // 无需也不该用全局锁（不放大无关会话的等待）。
  //
  // ── 读路径为什么刻意不加锁 ─────────────────────────────────────────────
  // getWindow / getHistory / listSessions 读的是「最后一次已提交的状态」
  // （last-committed-wins）：Map 的读写本身同步原子，读操作只会拿到某个已落
  // 定的完整数组引用，绝不会读到撕裂的半截状态；代价至多是读到稍旧的窗口——
  // 这对「组装 prompt」这个用途是可接受的弱一致。给读加锁反而会让耗时数秒的
  // 压缩阻塞所有读，得不偿失。
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(options: SessionStoreOptions = {}) {
    this.summarize = options.summarize ?? defaultSummarizer;
  }

  async append(sessionId: string, turn: ChatTurn): Promise<void> {
    const prev = this.appendChains.get(sessionId) ?? Promise.resolve();
    // 排队执行真正的 append；返回给调用方的 next 保留原始错误语义（该失败还是失败）
    const next = prev.then(() => this.doAppend(sessionId, turn));
    // 链上存的是「咽下错误」的版本：某次 append 失败落定后不能毒化整条链——
    // 后续 append 仍要能正常排队（上一个失败与下一条消息无关）
    const tail = next.catch(() => {});
    this.appendChains.set(sessionId, tail);
    // 链尾自清理：已落定且没有后来者接链时删除条目，防长生命周期进程里 Map 无界
    // 增长。比对「条目还是自己」兜底了清理回调与新 append 赛跑的窗口：新 append
    // 已把条目换成新链尾，旧清理回调就不会误删。稳态下每个会话最多留一个已落
    // 定的 Promise 条目（几十字节量级），清理性价比足够。
    void tail.then(() => {
      if (this.appendChains.get(sessionId) === tail) {
        this.appendChains.delete(sessionId);
      }
    });
    return next;
  }

  /** 串行化后的真正 append：原「读-压-写」三步整体（只在会话链上依次执行） */
  private async doAppend(sessionId: string, turn: ChatTurn): Promise<void> {
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
