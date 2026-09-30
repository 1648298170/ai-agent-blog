// guardrails/validate.ts —— 输入闸：提示注入扫描 + 工具白名单解析
//
// ── 为什么「先规范化再匹配」（对付 ign0re prev1ous 类绕过）──────────────────
// 注入话术的对抗面是「写法」而不是「意思」：攻击者会用全角字母（ＩＧＮＯＲＥ）、
// 零宽字符夹带（ig\u200Bnore）、leet 数字替换（ign0re）来绕过字面黑名单。
// 规范化把「全角/零宽/大小写」这三类纯写法差异先抹平，再进黑名单匹配——
// 黑名单只维护「一种写法」，对抗面就小了一整圈。leet 替换（o↔0、i↔1、e↔3、
// a↔4、s↔5）无法靠无损规范化抹平（会把正常数字文本改坏），由黑名单正则里的
// 字符类（如 [i1]gn[o0]r[e3]）各自容忍——匹配用正则，原文不改动。
//
// ── 黑名单的定位（纵深防御的一层，不是银弹）───────────────────────────────
// 这套模式只拦「明示型」注入（直白地让模型无视之前的指令/泄露系统提示）。
// 语义级改写（编故事绕弯子）超出字符串匹配的能力范围，靠提示词分层与最小权限
// 工具表兜底。宁可漏报也不误伤正常业务输入——每条模式都收紧到「动词 + 对象」
// 的组合，而不是单词命中。
/**
 * 扫描前先做的规范化（有损、仅供匹配用，不回写原文）：
 * ① 去零宽字符 U+200B/U+200C/U+200D/U+FEFF（夹在单词里肉眼不可见但能拆开字面量）
 * ② 全角转半角：U+FF01..U+FF5E 平移 -0xFEE0 回 ASCII（Ａ→a 的前提）、U+3000 → 空格
 * ③ 小写化（英文模式只需维护一种大小写）
 */
export function normalizeForInjectionScan(text: string): string {
  // ① 零宽字符直接剔除（前后文拼接还原成攻击者「想让你看到」的样子）
  const noZeroWidth = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");

  // ② 全角→半角：逐码点变换（for-of 按码点迭代，代理对原样透传不受影响）
  let halfwidth = "";
  for (const ch of noZeroWidth) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) {
      halfwidth += " "; // 全角空格（CJK 版块里最常见）→ 普通空格
    } else if (code !== undefined && code >= 0xff01 && code <= 0xff5e) {
      halfwidth += String.fromCodePoint(code - 0xfee0); // ！→!、Ａ→A、０→0 …
    } else {
      halfwidth += ch;
    }
  }

  // ③ 小写化放最后：全角字母先归位到 ASCII 再小写，一次 toLowerCase 全覆盖
  return halfwidth.toLowerCase();
}

/**
 * 注入黑名单（对「规范化后」的文本匹配）。顺序即优先级：中文直说 → 英文直说
 * （含 leet 字符类容忍）→ disregard 变体 → 系统提示词套取（中/英）。
 * 每条都是非全局正则（.test() 无状态，模块级常量可安全复用）。
 */
export const INJECTION_PATTERNS: RegExp[] = [
  // 中文：忽略/无视 之前/以上/上述/上面 的（所有/全部）指令/提示/设定/规则
  /(?:忽略|无视)(?:之前|以上|上述|上面)的?(?:所有|全部)?(?:指令|提示|设定|规则)/,
  // 英文：ignore（至多 3 个 filler 词）previous/above/prior/earlier/foregoing（至多 2 个
  // filler 词）instructions/prompts/rules。字符类容忍 leet 替换：i↔1、o↔0、e↔3、l↔1
  /[i1]gn[o0]r[e3]\s+(?:\w+\s+){0,3}?(?:pr[e3]v[i1][o0]us|ab[o0]v[e3]|pr[i1][o0]r|ear[i1][e3]r|f[o0]r[e3]g[o0][i1]ng)\s+(?:\w+\s+){0,2}?(?:[i1]nstruct[i1][o0]ns?|pr[o0]mpts?|ru[l1][e3]s?)/,
  // 英文：disregard … instructions（同句内 60 字符的窗口，防跨句误报）
  /d[i1]sr[e3]g[a4]rd[^.!?。！？]{0,60}?(?:[i1]nstruct[i1][o0]ns?|ru[l1][e3]s?|pr[o0]mpts?)/,
  // 中文：套取系统提示词——动词（打印/输出/泄露…）+ 至多 12 个非句读字符 + 系统提示/系统指令
  /(?:打印|输出|显示|展示|泄露|透露|复述|公开)[^。！？.!?]{0,12}(?:你的)?(?:系统提示|系统指令)/,
  // 英文：print/show/reveal… (your/the) system prompt
  /(?:print|show|reveal|leak|dump|repeat|display|output)\s+(?:your\s+|the\s+)?system\s+prompt/,
  // 伪装系统指令标记：文本里出现「[系统指令]」「【系统提示】」式成对括号标签（红队加固轮
  // 新增，E3 知识库投毒载荷的明示特征——正常业务文本不会把「系统指令」当小节标题）。
  // 只认成对括号包住的标签本体：讨论提示词概念的普通句子（「什么是系统提示词工程？」）不误伤。
  /(?:\[|【)\s*(?:系统指令|系统提示)\s*(?:\]|】)/,
];

/** 输入闸判定结果：ok=false 时 matchedPattern 给出命中的模式源码（定位是哪一条拦的） */
export interface TextInputInspection {
  ok: boolean;
  matchedPattern?: string;
}

/**
 * 对一段文本做注入扫描：先规范化（见文件头——全角/零宽/大小写的写法绕过在此
 * 失效），再按序过黑名单，第一条命中即返回。命中文本本身不回传（避免把注入
 * 话术原样写进工具结果造成二次注入面），只回传模式源码。
 */
export function inspectTextInput(text: string): TextInputInspection {
  const normalized = normalizeForInjectionScan(text);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return { ok: false, matchedPattern: pattern.source };
    }
  }
  return { ok: true };
}

/**
 * 解析白名单环境变量（逗号分隔的工具名）：`"t1, t2"` → ["t1","t2"]。
 * 未配置 / 空串 / 全是空条目 → null（语义为「不做白名单限制」，放行所有工具）。
 * 空条目（连续逗号、纯空格）直接丢弃，不产生 "" 这种永远匹配不上的幽灵项。
 */
export function resolveToolAllowlist(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const names = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? names : null;
}

/**
 * 白名单判定：allowlist 为 null → 一律放行（未配置 = 不限制）；
 * 名单存在 → 必须逐字在名单内。空数组名单会拒绝一切（调用方给名单前先过
 * resolveToolAllowlist，空值已经折算成 null，不会走到这个分支）。
 */
export function isToolAllowed(name: string, allowlist: string[] | null): boolean {
  if (allowlist === null) return true;
  return allowlist.includes(name);
}
