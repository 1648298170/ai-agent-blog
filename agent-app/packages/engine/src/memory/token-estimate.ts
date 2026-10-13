// token-estimate.ts —— token 估算层：给「这段文本大约烧多少 token」一个统一口径的答案。
//
// 为什么需要：上下文窗口按 token 计（不是按字符也不是按消息条数），一切预算类决策
// （水位线压缩、提示词拼装限额、成本预估）都得先把文本换算成 token 才有得谈。
// 目前压缩阀门（compression.ts）按条数（40 条）触发——条数与 token 没有稳定换算，
// 长消息与短消息一视同仁。按 token 水位线压缩是另一笔挂账；本模块先把「估算能力」
// 立起来作为独立导出，消费方后接，不动现有任何行为。
//
// 两种估算器（AGENT_TOKEN_ESTIMATOR，读法走 config.loadEnv 白名单）：
//   tiktoken（默认）—— js-tiktoken 的 cl100k_base BPE 分词精确计数。重：主入口
//     打包了全部编码词表（~5.6MB），但引擎里目前没有任何生产代码 import 本模块，
//     默认路径零成本；真正用上时也只在首次估算才构建编码器单例。
//   chars —— 零依赖系数兜底：中文 ≈1 token/字、非中文 ≈0.25 token/字符，分别计数
//     加权和后向上取整。量级够用（离线/低配环境友好），给不想引入 BPE 的消费方留退路。
//
// 三个刻意的取舍：
//   1. 懒构建在「单例」而不是「import」上——estimateTokens 是同步接口，ESM 的静态
//      import 无法推迟到首次调用（除非改 async），因此 lazy 落在编码器实例的构建
//      时机：不走 tiktoken 模式就一次都不构建。
//   2. env 每次调用现读——进程内切 AGENT_TOKEN_ESTIMATOR 立即生效（测试依赖这一点）。
//      loadEnv 有 .env 查找开销，但估算频率（每消息/每次压缩检查一次）远非热路径。
//   3. 非法值静默回退 tiktoken（= 默认行为）——逐条调用若逐条告警会刷屏，回退本身
//      无信息丢失，不值得为「告警一次」引入模块级状态。
import { getEncoding } from "js-tiktoken";
import type { Tiktoken } from "js-tiktoken";
import { loadEnv } from "../config.js";

/** AGENT_TOKEN_ESTIMATOR 合法取值 */
export type TokenEstimatorKind = "tiktoken" | "chars";

/** 默认估算器：精确优先（离线/低配兜底见 chars） */
export const DEFAULT_TOKEN_ESTIMATOR: TokenEstimatorKind = "tiktoken";

/** 编码器单例：首次 tiktoken 估算才构建（BPE 词表解析是一次性重活），之后全进程复用 */
let encoder: Tiktoken | null = null;

/** 「算作中文」的字符集：CJK 基本区 + 扩展 A 区 + 兼容区（系数 1 token/字 的适用范围） */
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 估算一段文本的 token 数（口径由 AGENT_TOKEN_ESTIMATOR 决定，默认/非法值均走 tiktoken） */
export function estimateTokens(text: string): number {
  const kind = (loadEnv().AGENT_TOKEN_ESTIMATOR ?? "").trim().toLowerCase();
  if (kind === "chars") return estimateByChars(text);
  return estimateByTiktoken(text); // 未设置 / "tiktoken" / 非法值 → 精确编码
}

/** tiktoken 精确口径：cl100k_base 分词后数 token。空串走捷径，不触发编码器构建 */
function estimateByTiktoken(text: string): number {
  if (text === "") return 0;
  if (encoder === null) encoder = getEncoding("cl100k_base");
  return encoder.encode(text).length;
}

/**
 * 字符系数口径：中文字符 ×1 + 其余字符 ×0.25，向上取整（token 是整数，宁可高估预算）。
 * 用 for...of 按码点迭代：emoji 等代理对按 1 个字符计，不会被 UTF-16 长度虚增。
 */
function estimateByChars(text: string): number {
  let total = 0;
  let cjk = 0;
  for (const ch of text) {
    total++;
    if (CJK_CHAR.test(ch)) cjk++;
  }
  return Math.ceil(cjk * 1 + (total - cjk) * 0.25);
}
