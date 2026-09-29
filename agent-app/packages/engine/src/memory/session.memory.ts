// session.memory.ts —— 短期记忆（会话窗口）的内存实现：截断阀门 + 超限滚动摘要
// 教程《记忆 TS 版》的 Redis 版换成 Map：读写一行不改，代价是重启就没、多实例不共享
// （TTL 那道阀门属于 Redis 侧 'EX' 续期，内存版无从谈起，换回 Redis 时按教程补上）。
// 读写时机：组装 prompt 前读 getWindow，每轮回答后 append 写入；写入即压缩
// （对应教程 writeBack 里 append 之后紧跟 compressSession 的时机）。
//
// ── 为什么需要"压缩"：上下文窗口是有限资源 ─────────────────────────────
// LLM 的上下文窗口有限（且按 token 计费），对话越长：①越贵 ②可能溢出 ③"迷失在
// 中间"（重要信息塞在中段反而被模型忽略）。所以历史不能无限堆，但直接砍掉旧消息
// 会丢关键事实（用户第 3 轮说过的偏好，第 30 轮还要用）。压缩 = 旧消息 → 150 字摘要，
// 事实保留、token 归零，是"全留"与"全砍"之间的折中。
//
// ── 压缩前后长什么样（COMPRESS_AFTER=40, KEEP_RECENT=20）────────────────
//   压缩前（43 条）：[u1,a1,u2,a2,…,u21,a21 | u22,a22,…,u43]   41 条旧的        20+1=21
//   压缩后（21 条）：[sys:"[会话摘要] 用户问了A…偏好B…" | u24,a24,…,u43]
//                    ↑ 合成 system 轮挂窗口头                    ↑ 最近 20 条原样保留
//   下一轮再超 40 时：旧摘要并入新摘要一起压（滚动），事实不因多轮压缩断档。
//
// ── 离线优先：压缩依赖 LLM，但绝不能因 LLM 不可用而炸主流程 ──────────────
// 没配 key / 网关不通 → 摘要调用失败 → 降级为纯窗口截断（只保最近 20 条），
// 行为退回"没有压缩功能的普通窗口"，主对话零感知。
import { generateText } from "ai";
import { getConfig } from "../config.js";
import { getModel } from "../llm.js";
import { trace } from "../trace.js";
import type { ChatTurn, SessionStore } from "./types.js";

/** 压缩阈值：消息条数超过 40（约 20 轮问答）才动手（教程 COMPRESS_AFTER） */
const COMPRESS_AFTER = 40;
/** 压缩后保住的最近消息条数（教程 slice(-20)；合成摘要轮不计入，挂在窗口头） */
const KEEP_RECENT = 20;

/** 合成摘要轮的固定前缀：识别「这一条不是真实对话，是压出来的摘要」 */
export const SUMMARY_PREFIX = "[会话摘要] ";

/** 摘要器：吃完整提示词，吐一段短摘要。独立成可注入的参数，自检才能离线覆盖压缩与降级两条路径 */
export type Summarizer = (prompt: string) => Promise<string>;

/** 默认摘要器：真实调用 getModel()；缺 key 时当场抛错（不发起任何网络请求），交给上层降级 */
const defaultSummarizer: Summarizer = async (prompt) => {
  const { apiKey } = getConfig();
  if (!apiKey) {
    throw new Error("未配置 OPENAI_API_KEY，无法生成会话摘要");
  }
  const { text } = await generateText({ model: getModel(), prompt });
  return text.trim();
};

/** 构造参数：summarize 缺省走真实模型；测试注入假实现即可离线测压缩与降级 */
export interface SessionStoreOptions {
  summarize?: Summarizer;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ChatTurn[]>();
  private readonly summarize: Summarizer;

  constructor(options: SessionStoreOptions = {}) {
    this.summarize = options.summarize ?? defaultSummarizer;
  }

  async append(sessionId: string, turn: ChatTurn): Promise<void> {
    const turns = this.sessions.get(sessionId) ?? [];
    turns.push({ ...turn });
    this.sessions.set(sessionId, turns);
    await this.compressIfNeeded(sessionId, turns); // 写入即压缩（超过阈值才真正动手）
  }

  /**
   * 压缩阀门：未超阈值原样不动；超了就把溢出旧轮压成滚动摘要。
   * 竞态说明同教程坑 4：摘要是异步的，压缩期间若有新 append 落到同一数组，
   * 压缩基于「当下的最新内容」重算，最坏多压一轮，不丢消息。
   */
  private async compressIfNeeded(sessionId: string, turns: ChatTurn[]): Promise<void> {
    if (turns.length <= COMPRESS_AFTER) return;

    // 教程同款切法：older 压摘要，recent 原样保留
    const older = turns.slice(0, -KEEP_RECENT);
    const recent = turns.slice(-KEEP_RECENT);

    // 已有滚动摘要长在窗口头（合成 system 轮）；头一条没带前缀说明是首轮压缩
    const prevSummaryTurn =
      older.length > 0 && older[0].role === "system" && older[0].content.startsWith(SUMMARY_PREFIX)
        ? older[0]
        : undefined;
    const olderTurns = prevSummaryTurn ? older.slice(1) : older;
    const transcript = olderTurns.map((t) => `${t.role}: ${t.content}`).join("\n");
    const prevSummary = prevSummaryTurn ? prevSummaryTurn.content.slice(SUMMARY_PREFIX.length) : "";

    let summary: string | null = null;
    try {
      const text = (
        await this.summarize(
          "把下面的多轮对话压成不超过 150 字的摘要，保留用户提到的关键事实与偏好。" +
            `已有摘要：${prevSummary || "（无）"}\n\n${transcript}`,
        )
      ).trim();
      summary = text === "" ? null : text; // 空摘要视同失败，走降级
    } catch {
      summary = null; // 无 key / 网关不通 / 超时 → 降级：保最近、弃摘要，不抛错
    }

    if (summary === null) {
      // 降级路径：退回纯窗口截断（保最近 KEEP_RECENT 条），不出摘要轮
      trace("🧠", `会话 ${sessionId} 超过 ${COMPRESS_AFTER} 条：摘要不可用（无 key / 网关不通），降级为窗口截断（保最近 ${KEEP_RECENT} 条）`);
      this.sessions.set(sessionId, recent);
      return;
    }

    // 滚动摘要：旧摘要 + 新摘要拼在一起，作为合成 system 轮挂在窗口头
    const rolling = prevSummary ? `${prevSummary} ${summary}`.trim() : summary;
    const summaryTurn: ChatTurn = { role: "system", content: SUMMARY_PREFIX + rolling };
    this.sessions.set(sessionId, [summaryTurn, ...recent]);
    trace("🧠", `会话 ${sessionId} 超过 ${COMPRESS_AFTER} 条：压缩 ${older.length} 条旧消息为滚动摘要（${rolling.length} 字），保最近 ${recent.length} 条`);
  }

  /** 取最近 limit 轮（默认 20）：截断阀门，防单会话内上下文爆炸 */
  async getWindow(sessionId: string, limit = 20): Promise<ChatTurn[]> {
    const turns = this.sessions.get(sessionId) ?? [];
    return turns.slice(-Math.max(0, limit));
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
