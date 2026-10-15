// skills/loader.ts —— SKILL.md 解析与目录加载（安全四件套在此）。
//
// 设计要点：
// 1. 零依赖：frontmatter 用「--- 围栏 + 行式 key: value」手写解析——agentskills.io
//    规范的 frontmatter 只有 name/description 等简单键值，不值得为它引 js-yaml。
// 2. 单技能坏不拖死全部：解析失败/缺字段 → 跳过该技能 + 收集 warning，绝不抛出中断整个目录。
// 3. 安全四件套（企业级纪律，缺一不可）：
//    ① 路径遍历防护：子目录名含 .. 或路径分隔符 → 跳过（防 ..\..\etc 逃逸）
//    ② 大小上限：单技能正文 ≤ 16KB、技能总数 ≤ 32、全量注入总字符 ≤ 64KB
//       （SKILL.md 进 system prompt = 上下文成本/提示注入面，不设限就是敞口）
//    ③ 永不执行：本模块只读 Markdown 文本；SKILL.md 捆绑的 scripts/ 一律不碰
//    ④ 冲突先到先得：同名技能按目录名字典序稳定裁决 + warning（与 MCP 重名合并同构）
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { trace } from "../trace.js";
import type { SkillDefinition, SkillsLoadResult } from "./types.js";

/** 单技能正文上限（字符）：SKILL.md 正文超过此值跳过——防上下文撑爆与成本攻击 */
const MAX_BODY_CHARS = 16_000;
/** description 上限：渐进披露模式下它是常驻上下文的元数据，必须短 */
const MAX_DESCRIPTION_CHARS = 200;
/** 技能总数上限：全量注入模式下技能数量本身也是上下文成本 */
const MAX_SKILL_COUNT = 32;
/** 全量注入总字符上限（所有技能 body 之和）：超过即停止加载并告警 */
const MAX_TOTAL_BODY_CHARS = 64_000;
/** name 合法格式：小写字母/数字/连字符，2~64 位（agentskills.io 惯例口径） */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * 解析单个 SKILL.md 文本：--- 围栏 frontmatter（name/description 行式键值）+ Markdown 正文。
 * 任何不合规直接抛错（带来源路径）——由 loadSkillsFromDir 捕获降级为 warning，不外泄中断。
 */
export function parseSkillMd(raw: string, sourcePath: string): SkillDefinition {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("---")) {
    throw new Error(`${sourcePath}: 缺少 frontmatter 围栏（文件需以 --- 开头）`);
  }
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error(`${sourcePath}: frontmatter 围栏未闭合（缺少第二个 ---）`);
  }
  const frontmatter = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trim();

  // 行式键值解析：只认 name/description 两个键（规范最小集），其余忽略不报错
  let name = "";
  let description = "";
  for (const line of frontmatter.split("\n")) {
    const match = /^(name|description):\s*(.+)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === "name") name = match[2].trim();
    else description = match[2].trim();
  }

  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${sourcePath}: name 缺失或非法（要求：小写字母/数字/连字符，2~64 位，当前「${name}」）`);
  }
  if (description === "" || description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(
      `${sourcePath}: description 缺失或超过 ${MAX_DESCRIPTION_CHARS} 字符（它是常驻上下文的元数据，必须短而准）`,
    );
  }
  if (body === "" || body.length > MAX_BODY_CHARS) {
    throw new Error(`${sourcePath}: 正文为空或超过 ${MAX_BODY_CHARS} 字符上限`);
  }

  return { name, description, body, sourcePath };
}

/**
 * 从目录加载全部技能。约定每个技能一个子目录，入口文件为 <子目录>/SKILL.md
 * （与 agentskills.io 布局一致：企业已有的 Claude/Codex 技能目录可直接指进来复用）。
 *
 * 目录不存在 → 返回空结果（这是「用户没配置」的正常场景，不算告警——
 * 调用方用「显式指定却不存在」的语义自行告警）。EPISODIC_STORE 教训的反面：
 * 「没配置=静默正常」与「配置了但坏=必须告警」要分开对待。
 */
export function loadSkillsFromDir(dir: string): SkillsLoadResult {
  const warnings: string[] = [];
  const skills: SkillDefinition[] = [];

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { skills, warnings };
  }

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(); // 字典序：保证重名冲突的「先到先得」裁决跨平台稳定（readdir 顺序不保证）

  let totalChars = 0;
  for (const dirName of entries) {
    if (skills.length >= MAX_SKILL_COUNT) {
      warnings.push(`技能总数已达上限 ${MAX_SKILL_COUNT}，跳过「${dirName}」及之后（上下文成本保护）`);
      break;
    }
    // 安全①：路径遍历防护——目录名只允许安全字符，含 .. 或路径分隔符的直接跳过
    if (dirName.includes("..") || /[/\\]/.test(dirName)) {
      warnings.push(`跳过可疑目录名「${dirName}」（含路径遍历字符，安全防护）`);
      continue;
    }
    const skillPath = join(dir, dirName, "SKILL.md");
    if (!existsSync(skillPath)) {
      warnings.push(`跳过「${dirName}」：目录下没有 SKILL.md`);
      continue;
    }

    try {
      const skill = parseSkillMd(readFileSync(skillPath, "utf8"), skillPath);
      // 安全④：重名先到先得 + 告警（同名字典序靠前的目录胜出）
      if (skills.some((existing) => existing.name === skill.name)) {
        warnings.push(`跳过「${dirName}」：技能名「${skill.name}」与先加载的技能重名（先到先得）`);
        continue;
      }
      // 安全②：总字符预算——全量注入会把所有 body 拼进 system prompt，必须设总闸
      totalChars += skill.body.length;
      if (totalChars > MAX_TOTAL_BODY_CHARS) {
        warnings.push(
          `跳过「${dirName}」：技能正文总量超过 ${MAX_TOTAL_BODY_CHARS} 字符预算（全量注入的上下文保护）`,
        );
        break;
      }
      skills.push(skill);
    } catch (err) {
      // 单技能坏不拖死全部：收集告警继续加载下一个
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  // 稳定排序：注入 prompt 的技能顺序确定，跨平台一致（测试与 diff 友好）
  skills.sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length > 0) {
    trace("🔍", `技能 ${skills.length} 个已加载（${skills.map((s) => s.name).join("、")}）`);
  }
  return { skills, warnings };
}
