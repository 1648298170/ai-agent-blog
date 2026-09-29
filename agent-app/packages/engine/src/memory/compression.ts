// compression.ts —— 会话压缩算法的唯一实现：截断阀门 + 超限滚动摘要 + 离线降级
// 从 session.memory.ts 抽出的共享模块（week17 实战：Redis 版会话存储要用同一套压缩，
// 算法只留这一份，InMemory 与 Redis 两个实现都来这里借——不复制算法，改阈值只改这里）。
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
//
// 纯函数式接口：compressIfNeeded 吃完整 turns 数组，吐压缩后的新数组，
// 不碰任何存储——内存版拿去 set 回 Map，Redis 版拿去重写 list，各自管各自的落盘。
import { generateText } from "ai";
import { getConfig } from "../config.js";
import { getModel } from "../llm.js";
import { trace } from "../trace.js";
import type { ChatTurn } from "./types.js";

/** 压缩阈值：消息条数超过 40（约 20 轮问答）才动手（教程 COMPRESS_AFTER） */
export const COMPRESS_AFTER = 40;
/** 压缩后保住的最近消息条数（教程 slice(-20)；合成摘要轮不计入，挂在窗口头） */
export const KEEP_RECENT = 20;

/** 合成摘要轮的固定前缀：识别「这一条不是真实对话，是压出来的摘要」 */
export const SUMMARY_PREFIX = "[会话摘要] ";

/** 摘要器：吃完整提示词，吐一段短摘要。独立成可注入的参数，自检才能离线覆盖压缩与降级两条路径 */
export type Summarizer = (prompt: string) => Promise<string>;

/** 默认摘要器：真实调用 getModel()；缺 key 时当场抛错（不发起任何网络请求），交给上层降级 */
export const defaultSummarizer: Summarizer = async (prompt) => {
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

/**
 * 压缩阀门：未超阈值原样返回同一数组引用（零开销）；超了就把溢出旧轮压成滚动摘要。
 *
 * 返回值约定：
 * - 未超阈值 → 原数组（调用方可以直接忽略返回值）
 * - 压缩成功 → [合成摘要轮, ...最近 KEEP_RECENT 条] 的新数组
 * - 摘要不可用 → 只含最近 KEEP_RECENT 条的新数组（降级为窗口截断，不出摘要轮）
 *
 * 竞态说明同教程坑 4：摘要是异步的，压缩期间若有新 append 落到同一会话，
 * 压缩基于「当下的最新内容」重算，最坏多压一轮，不丢消息。
 */
export async function compressIfNeeded(
  sessionId: string,
  turns: ChatTurn[],
  summarize: Summarizer,
): Promise<ChatTurn[]> {
  if (turns.length <= COMPRESS_AFTER) return turns;

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
      await summarize(
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
    return recent;
  }

  // 滚动摘要：旧摘要 + 新摘要拼在一起，作为合成 system 轮挂在窗口头
  const rolling = prevSummary ? `${prevSummary} ${summary}`.trim() : summary;
  const summaryTurn: ChatTurn = { role: "system", content: SUMMARY_PREFIX + rolling };
  trace("🧠", `会话 ${sessionId} 超过 ${COMPRESS_AFTER} 条：压缩 ${older.length} 条旧消息为滚动摘要（${rolling.length} 字），保最近 ${recent.length} 条`);
  return [summaryTurn, ...recent];
}
