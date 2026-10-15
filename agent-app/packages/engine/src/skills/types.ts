// skills/types.ts —— Skills 模块的类型契约。
//
// Skill 是什么：一份 SKILL.md 文件（Anthropic agentskills.io 规范格式）——
// YAML frontmatter（name + description）+ Markdown 正文（领域流程/话术/边界）。
// 与 mcp/ 的分工一句话：MCP 给 Agent「能力」（能调什么工具），Skill 给 Agent「知识」
// （这些工具在什么场景、按什么顺序、说什么话）。两者互补，可互相引用（Skill 正文
// 里直接写工具名即可，无需注册关系）。
//
// 安全定位（企业级纪律，见 loader.ts 的安全四件套）：
// - SKILL.md 是磁盘上的文本 → 进 system prompt 就是提示注入面，加载侧必须设防
// - 捆绑脚本（scripts/）永不执行：本模块只读 Markdown 文本，脚本仅作为内容展示

/** 单个技能的完整定义（解析 SKILL.md 后的产物） */
export interface SkillDefinition {
  /** 技能标识：frontmatter 的 name（小写字母/数字/连字符，2~64 位）——注入 prompt 与 trace 时的稳定 id */
  readonly name: string;
  /** 一句话描述：frontmatter 的 description——Agent 据此判断「这个技能是否适用当前问题」 */
  readonly description: string;
  /** 技能正文：frontmatter 之后的 Markdown（流程/话术/边界），全量注入模式拼进 system prompt */
  readonly body: string;
  /** 来源文件路径：trace 与报错定位用（哪个目录哪个文件） */
  readonly sourcePath: string;
}

/** 加载结果：技能 + 告警分离——单个技能坏不拖死全部，问题以 warning 浮出（不静默） */
export interface SkillsLoadResult {
  /** 成功加载的技能（已按 name 字典序稳定排序；重名冲突先到先得） */
  readonly skills: SkillDefinition[];
  /** 加载告警（跳过原因/冲突/超限）——调用方负责打日志或 trace，不静默吞掉 */
  readonly warnings: string[];
}
