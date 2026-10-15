// skills/index.ts —— @agent-app/engine/skills 子路径的公共面（桶导出）。
// 与 mcp/、guardrails/ 同构：消费方只从这里 import，内部文件布局不外泄。
export { loadSkillsFromDir, parseSkillMd } from "./loader.js";
export { renderSkillsPrompt } from "./registry.js";
export type { SkillDefinition, SkillsLoadResult } from "./types.js";
