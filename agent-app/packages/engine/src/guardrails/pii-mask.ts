// guardrails/pii-mask.ts —— 输出闸：中文语境 PII 脱敏（手机号 / 身份证 / 银行卡）
//
// ── 为什么要有这一层（先说为什么，再说怎么做）──────────────────────────────
// 外部工具（MCP 服务器）的输出要回灌给模型、也可能转述给用户——一旦里面夹带
// 真实的手机号/身份证/银行卡号，泄露面就从「服务器日志」扩大到「模型上下文 +
// 会话存储 + 对话记录」。脱敏走「保留头尾、遮中间」：可读性足以让人工辨认
// （客服能看出是哪个客户的单），但完整号码不再离开工具边界。
//
// ── 边界纪律：嵌在更长数字串里的候选一律不算命中 ─────────────────────────
// 三个正则全部用前后断言（lookaround）锁死边界：`(?<!\d)…(?!\d)`——候选的前面
// 或后面紧邻数字就放弃匹配。没有这条纪律会出两种事故：
//   ① 20 位数字串会被当成「19 位银行卡」的前 19 位截出来打码（错拆）；
//   ② 身份证（18 位）内部的 11 位窗口会被当成手机号二次打码（错拆 + 二次泄露形态）。
// 注意身份证的尾部断言是 `(?![\dXx])`：18 位候选后面紧跟 X/x（更像被截断的
// 19 位串）时同样不算完整身份证。Node 22 的 V8 原生支持 lookbehind。
//
// ── 三类模式的执行顺序与歧义处理 ──────────────────────────────────────────
// 顺序：身份证 → 手机号 → 银行卡。原因：
//   - 身份证（18 位）必须先于银行卡（13~19 位）：同为 18 位纯数字时两者都命中，
//     本实现按「身份证」口径处理（中文客服语境里 18 位数字更可能是身份证；
//     两类都会被打码，只是保留位不同，不存在漏脱敏）；末位 X 的身份证若先走
//     银行卡正则，前 17 位会被错拆成银行卡、尾巴 X 悬空。
//   - 手机号（11 位）与另两类天然不重叠（11 < 13 且边界锁死），先后无影响。
// 顺序执行还有个好处：已打码的文本带 `*`，数字串被切断，后续正则不可能对
// 同一位置二次命中——countMasked 的「命中数」因此与实际打码次数严格一致。
//
// ── 导出常量不带 g 标志 ───────────────────────────────────────────────────
// 带全局标志的正则对象是有状态的（lastIndex 会随 test/exec 前进），作为模块级
// 常量导出给测试直接 .test() 会踩「第二次调用返回 false」的坑。所以常量只
// 承载「模式 + 边界」这一单一事实源，函数内部按需克隆出带 g 的副本去 replace。
/** 手机号：1 开头 + 第二位 3-9 + 共 11 位，前后不能紧邻数字（嵌在身份证等长串里不算） */
export const PHONE_REGEX = /(?<!\d)1[3-9]\d{9}(?!\d)/;
/** 身份证：前 17 位数字 + 末位数字或 X/x，前后不能紧邻数字/X/x（嵌在更长串里不算） */
export const ID_CARD_REGEX = /(?<!\d)\d{17}[\dXx](?![\dXx])/;
/** 银行卡：13~19 位连续数字，前后不能紧邻数字（20 位长串里没有合法银行卡） */
export const BANK_CARD_REGEX = /(?<!\d)\d{13,19}(?!\d)/;

/** 按单一事实源常量克隆出带全局标志的执行副本（replace 需要 g；常量本体保持无状态） */
function globalOf(regex: RegExp): RegExp {
  return new RegExp(regex.source, regex.flags + "g");
}

/** 手机号打码：保留前 3 + 后 4（138****5678）——保留头尾让人工可辨认，中间 4 位遮蔽 */
function maskPhone(match: string): string {
  return `${match.slice(0, 3)}****${match.slice(7)}`;
}

/** 身份证打码：保留前 4 + 后 2，中间 12 位遮蔽（末位 X/x 原样保留在尾巴里） */
function maskIdCard(match: string): string {
  return `${match.slice(0, 4)}${"*".repeat(match.length - 6)}${match.slice(-2)}`;
}

/** 银行卡打码：保留前 4 + 后 4，中间按实际位数遮蔽（13~19 位长度不一） */
function maskBankCard(match: string): string {
  return `${match.slice(0, 4)}${"*".repeat(match.length - 8)}${match.slice(-4)}`;
}

/**
 * PII 识别器（可插拔扩展点）：一个识别器 = 一类 PII 的「模式 + 打码方式」。
 * 内置三类（身份证/手机号/银行卡）；扩展新 PII 类型（邮箱/护照/工号…）=
 * 追加一个识别器对象，不改扫描与打码的执行引擎。
 */
export interface PiiDetector {
  /** 识别器标识（审计与轨迹定位用） */
  readonly name: string;
  /** 候选模式：不带 g 标志（有状态 lastIndex 的坑见头注释），执行时按需克隆 */
  readonly pattern: RegExp;
  /** 打码函数：保留头尾让人工可辨认，中间遮蔽 */
  readonly mask: (match: string) => string;
}

/** 内置识别器（顺序即执行序：身份证 → 手机号 → 银行卡，理由见头注释的歧义裁决） */
export const DEFAULT_PII_DETECTORS: PiiDetector[] = [
  { name: "id-card", pattern: ID_CARD_REGEX, mask: maskIdCard },
  { name: "phone", pattern: PHONE_REGEX, mask: maskPhone },
  { name: "bank-card", pattern: BANK_CARD_REGEX, mask: maskBankCard },
];

/**
 * 一次脱敏扫描的完整结果：打码后的文本 + 实际命中数。
 * 打码与计数永远同一套判定口径（识别器清单决定「什么算 PII」，两个出口自动同步）。
 */
function applyDetectors(text: string, detectors: readonly PiiDetector[]): { masked: string; hits: number } {
  let hits = 0;
  let out = text;
  for (const detector of detectors) {
    // 顺序执行：已打码的文本带 `*`，数字串被切断，后续识别器不会二次命中同一位置
    out = out.replace(globalOf(detector.pattern), (match) => {
      hits += 1;
      return detector.mask(match);
    });
  }
  return { masked: out, hits };
}

/**
 * 按识别器清单创建一套脱敏器（可插拔扩展点）：
 * 扩展新 PII 类型 = 追加识别器对象（如邮箱/护照/工号），不改扫描与打码引擎；
 * 传 [] 显式关闭脱敏。数组序 = 执行序（先到的先打码）。
 */
export function createPiiMasker(detectors: readonly PiiDetector[]): {
  mask: (text: string) => string;
  count: (text: string) => number;
} {
  return {
    mask: (text) => applyDetectors(text, detectors).masked,
    count: (text) => applyDetectors(text, detectors).hits,
  };
}

/**
 * 把文本里的中文语境 PII 打码后返回：手机号留前 3 后 4、身份证留前 4 后 2、
 * 银行卡留前 4 后 4。不含 PII 的文本原样返回（逐字符相等）。
 */
export function maskPii(text: string): string {
  return applyDetectors(text, DEFAULT_PII_DETECTORS).masked;
}

/**
 * 统计文本里会被打码的 PII 命中数（与 maskPii 同一套顺序化判定口径，
 * 用于轨迹输出与测试断言）。嵌在更长数字串里的候选不算命中。
 */
export function countMasked(text: string): number {
  return applyDetectors(text, DEFAULT_PII_DETECTORS).hits;
}
