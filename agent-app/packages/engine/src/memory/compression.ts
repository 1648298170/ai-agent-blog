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
//
// ── 水位线模式（MODEL_CONTEXT_TOKENS 配置，或 OPENAI_MODEL 命中查表时启用）─
// 条数阈值（40 条）不是 token 的合格代理变量：40 条"你好"与 40 条 10KB 日志
// 天差地别。满足任一条件即改为按 token 水位触发：
//   配置 MODEL_CONTEXT_TOKENS，或 OPENAI_MODEL 命中下方查表（如 glm-4-flash=128K）
//   触发 = 全窗口估算 token > 窗口 × (1 − buffer)    （buffer 默认 25%，留给回答）
//   压缩目标 = 从尾部贪心保留，直到 ≤ 窗口 × buffer（约 50% 窗口水位）
// 注意：默认模型 glm-4-flash 命中查表——开箱即用水位线已启用（触发阈值远高于
// 旧 40 条，短会话行为不变，长会话不再过早压缩）。显式关闭：MODEL_CONTEXT_TOKENS=off。
// 两者都未命中（或显式关闭）→ 条数阈值路径，与引入前行为一致。
// 估算走 token-estimate 的 estimateTokens（tiktoken 精确 / chars 兜底，env 可切）；
// WatermarkPolicy.estimate 可注入——测试注假函数精确控制水位。
import { generateText } from "ai";
import { getConfig } from "../config.js";
import { getModel, llmCallPolicy } from "../llm.js";
import { trace } from "../trace.js";
import { estimateTokens } from "./token-estimate.js";
import type { ChatTurn } from "./types.js";

/** 压缩阈值：消息条数超过 40（约 20 轮问答）才动手（教程 COMPRESS_AFTER） */
export const COMPRESS_AFTER = 40;
/** 压缩后保住的最近消息条数（教程 slice(-20)；合成摘要轮不计入，挂在窗口头） */
export const KEEP_RECENT = 20;

/** 合成摘要轮的固定前缀：识别「这一条不是真实对话，是压出来的摘要」 */
export const SUMMARY_PREFIX = "[会话摘要] ";

/** 摘要器：吃完整提示词，吐一段短摘要。独立成可注入的参数，自检才能离线覆盖压缩与降级两条路径 */
export type Summarizer = (prompt: string) => Promise<string>;

/** 压缩水位线策略：配置后压缩从「条数阈值」切换为「token 水位」触发 */
export interface WatermarkPolicy {
  /** 模型上下文窗口（token 数）——通常来自 MODEL_CONTEXT_TOKENS 或按模型名查表 */
  readonly contextTokens: number;
  /** 预留比例：触发水位 = 窗口 × (1 − buffer)，默认 0.25（留给回答与压缩调用本身） */
  readonly bufferRatio?: number;
  /** 估算函数（默认 estimateTokens）；测试注假函数精确控制水位 */
  readonly estimate?: (text: string) => number;
}

/** 常见模型上下文窗口查表（token 数）——MODEL_CONTEXT_TOKENS 未配置时按模型名兜底 */
const MODEL_CONTEXT_TABLE: Record<string, number> = {
  "glm-4-flash": 128_000,
  "glm-4-air": 128_000,
  "glm-4-plus": 128_000,
  "deepseek-chat": 64_000,
  "qwen-plus": 131_072,
};

/**
 * 模型上下文窗口解析（优先级：显式关闭 off/0 > env 直配 > 模型名查表 > 未启用）。
 * 返回 undefined = 水位线未启用（或显式关闭），压缩走条数阈值（现状行为）。
 * 放在 compression.ts 而非 config.ts：查表是「压缩策略」的领域知识，
 * config 只管网关四件套的装配。
 */
export function modelContextTokensFromEnv(env: Record<string, string>, modelId: string): number | undefined {
  const raw = (env.MODEL_CONTEXT_TOKENS ?? "").trim().toLowerCase();
  // 显式关闭值（off / 0 / false）：不给 glm-4-flash 这类命中查表的默认模型留
  // 「配 0 却落回查表再次启用」的死角（审查发现：查表命中使默认部署静默启用水位线）
  if (raw === "off" || raw === "0" || raw === "false") return undefined;
  const direct = Number.parseInt(raw, 10);
  if (Number.isInteger(direct) && direct > 0) return direct;
  return MODEL_CONTEXT_TABLE[modelId?.trim().toLowerCase() ?? ""];
}

/** 默认摘要器：真实调用 getModel()；缺 key 时当场抛错（不发起任何网络请求），交给上层降级 */
export const defaultSummarizer: Summarizer = async (prompt) => {
  const { apiKey } = getConfig();
  if (!apiKey) {
    throw new Error("未配置 OPENAI_API_KEY，无法生成会话摘要");
  }
  const { text } = await generateText({ model: getModel(), prompt, ...llmCallPolicy() });
  return text.trim();
};

/** 构造参数：summarize 缺省走真实模型；watermark 配置后压缩按 token 水位触发（销 BACKLOG ①）；
 *  测试注入假实现即可离线测压缩与降级 */
export interface SessionStoreOptions {
  summarize?: Summarizer;
  watermark?: WatermarkPolicy;
}

/**
 * 压缩阀门：未超阈值原样返回同一数组引用（零开销）；超了就把溢出旧轮压成滚动摘要。
 *
 * 触发判定（二选一，由 watermark 决定）：
 * - 传了 watermark → token 水位：全窗口估算 > 窗口 × (1 − buffer) 触发；
 *   保留量 = 从尾部贪心保留至 ≤ 窗口 × buffer（约 50% 水位），不再固定 20 条
 * - 未传 → 条数阈值（turns.length > COMPRESS_AFTER，现状行为逐字节不变）
 *
 * 返回值约定：
 * - 未超阈值 → 原数组（调用方可以直接忽略返回值）
 * - 压缩成功 → [合成摘要轮, ...保留的最近消息] 的新数组
 * - 摘要不可用 → 只含保留消息的新数组（降级为窗口截断，不出摘要轮）
 *
 * 竞态说明同教程坑 4：摘要是异步的，压缩期间若有新 append 落到同一会话，
 * 压缩基于「当下的最新内容」重算，最坏多压一轮，不丢消息。
 */
export async function compressIfNeeded(
  sessionId: string,
  turns: ChatTurn[],
  summarize: Summarizer,
  watermark?: WatermarkPolicy,
): Promise<ChatTurn[]> {
  // ── 触发判定 + older/recent 切分（两种模式在此分叉，后续摘要逻辑共用）──
  let older: ChatTurn[];
  let recent: ChatTurn[];
  if (watermark !== undefined && turns.length > 1) {
    const { contextTokens, bufferRatio = 0.25, estimate = estimateTokens } = watermark;
    const totalTokens = turns.reduce((sum, t) => sum + estimate(t.content), 0);
    const trigger = contextTokens * (1 - bufferRatio);
    if (totalTokens <= trigger) return turns; // 水位未到：不压缩（水位模式下条数不触发）

    // 压缩目标：从尾部贪心保留至 ≤ 窗口 × buffer（约 50% 水位）。
    // 至少保 1 条——单条超预算的消息也保留（摘要它毫无意义，让上层护栏处理）
    const budget = contextTokens * bufferRatio;
    let keptTokens = 0;
    let keepCount = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = estimate(turns[i]!.content);
      if (keptTokens + t > budget && keepCount > 0) break;
      keptTokens += t;
      keepCount++;
    }
    const keep = Math.max(keepCount, 1);
    older = turns.slice(0, -keep);
    recent = turns.slice(-keep);
  } else {
    if (turns.length <= COMPRESS_AFTER) return turns;
    older = turns.slice(0, -KEEP_RECENT);
    recent = turns.slice(-KEEP_RECENT);
  }
  if (older.length === 0) return turns; // 全部都在保留区：无事可做

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
    // 降级路径：退回纯窗口截断（保保留区），不出摘要轮
    trace(
      "🧠",
      `会话 ${sessionId} 压缩触发：摘要不可用（无 key / 网关不通），降级为窗口截断（保最近 ${recent.length} 条）`,
    );
    return recent;
  }

  // 滚动摘要：旧摘要 + 新摘要拼在一起，作为合成 system 轮挂在窗口头
  const rolling = prevSummary ? `${prevSummary} ${summary}`.trim() : summary;
  const summaryTurn: ChatTurn = { role: "system", content: SUMMARY_PREFIX + rolling };
  trace(
    "🧠",
    `会话 ${sessionId} 压缩 ${older.length} 条旧消息为滚动摘要（${rolling.length} 字），保最近 ${recent.length} 条`,
  );
  return [summaryTurn, ...recent];
}
