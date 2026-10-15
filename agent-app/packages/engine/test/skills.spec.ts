// skills.spec.ts —— Skills 模块离线单测：SKILL.md 解析 / 目录加载（安全四件套）/
// 全量注入拼装。全部用临时目录造 fixture，零网络零不确定性。
// 铁律：无技能时 renderSkillsPrompt 返回空串——system prompt 与引入前逐字节一致（零变化）。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir, parseSkillMd } from "../src/skills/loader.js";
import { renderSkillsPrompt } from "../src/skills/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个技能子目录（name 缺省用目录名） */
function makeSkill(dirName: string, name: string, description = "测试技能", body = "正文内容"): string {
  const sub = join(dir, dirName);
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    "utf8",
  );
  return sub;
}

describe("parseSkillMd：frontmatter 解析与校验", () => {
  it("正常解析：name/description/body 各就各位", () => {
    const skill = parseSkillMd(
      "---\nname: refund-flow\ndescription: 退款流程\n---\n\n# 步骤\n先查订单",
      "x/SKILL.md",
    );
    expect(skill.name).toBe("refund-flow");
    expect(skill.description).toBe("退款流程");
    expect(skill.body).toBe("# 步骤\n先查订单");
    expect(skill.sourcePath).toBe("x/SKILL.md");
  });

  it("缺 frontmatter 围栏 / 围栏未闭合 → 报错", () => {
    expect(() => parseSkillMd("# 没有围栏", "a.md")).toThrow(/缺少 frontmatter 围栏/);
    expect(() => parseSkillMd("---\nname: x\n", "a.md")).toThrow(/围栏未闭合/);
  });

  it("name 缺失或非法格式 → 报错（含来源路径）", () => {
    expect(() => parseSkillMd("---\ndescription: d\n---\n\nbody", "a.md")).toThrow(/name 缺失或非法/);
    expect(() => parseSkillMd("---\nname: Bad_Name\ndescription: d\n---\n\nb", "a.md")).toThrow(
      /name 缺失或非法/,
    );
  });

  it("description 缺失 → 报错（它是常驻上下文元数据，必填）", () => {
    expect(() => parseSkillMd("---\nname: ok-name\n---\n\nbody", "a.md")).toThrow(/description 缺失/);
  });

  it("正文超 16KB 上限 → 报错（上下文成本保护）", () => {
    const huge = "---\nname: ok-name\ndescription: d\n---\n\n" + "x".repeat(17_000);
    expect(() => parseSkillMd(huge, "a.md")).toThrow(/16000/);
  });
});

describe("loadSkillsFromDir：目录加载与安全四件套", () => {
  it("目录不存在 → 空结果无告警（用户没配置 = 正常场景，不算告警）", () => {
    const result = loadSkillsFromDir(join(dir, "not-exist"));
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("正常加载多个技能，按 name 字典序稳定排序", () => {
    makeSkill("b-dir", "zeta");
    makeSkill("a-dir", "alpha");
    const result = loadSkillsFromDir(dir);
    expect(result.skills.map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect(result.warnings).toEqual([]);
  });

  it("安全①：路径遍历防护——含 .. 的目录名跳过 + 告警", () => {
    // mkdirSync 建不出带 / 的名字，用 .. 前缀模拟遍历意图
    const sub = join(dir, "..evil");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "SKILL.md"), "---\nname: evil\ndescription: d\n---\n\nbody", "utf8");
    const result = loadSkillsFromDir(dir);
    expect(result.skills).toEqual([]);
    expect(result.warnings.some((w) => w.includes("路径遍历"))).toBe(true);
  });

  it("子目录无 SKILL.md → 跳过 + 告警，不影响其他技能", () => {
    makeSkill("good", "good-skill");
    mkdirSync(join(dir, "empty"), { recursive: true });
    const result = loadSkillsFromDir(dir);
    expect(result.skills.map((s) => s.name)).toEqual(["good-skill"]);
    expect(result.warnings.some((w) => w.includes("empty"))).toBe(true);
  });

  it("安全④：同名技能先到先得 + 告警（字典序裁决跨平台稳定）", () => {
    makeSkill("a-dir", "dup");
    makeSkill("b-dir", "dup");
    const result = loadSkillsFromDir(dir);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.sourcePath).toContain("a-dir");
    expect(result.warnings.some((w) => w.includes("重名"))).toBe(true);
  });

  it("单个技能坏（非法 name）→ 跳过 + 告警，好的照常加载", () => {
    makeSkill("bad", "Bad_Name");
    makeSkill("good", "good-skill");
    const result = loadSkillsFromDir(dir);
    expect(result.skills.map((s) => s.name)).toEqual(["good-skill"]);
    expect(result.warnings.some((w) => w.includes("Bad_Name"))).toBe(true);
  });
});

describe("renderSkillsPrompt：全量注入拼装", () => {
  it("空数组 → 空串（零变化铁律：无技能时 system prompt 逐字节不变）", () => {
    expect(renderSkillsPrompt([])).toBe("");
  });

  it("非空：包含标题段、技能名、描述、正文，且按「命中场景才套用」给使用指引", () => {
    makeSkill("flow", "refund-flow", "退款流程", "先查订单");
    const result = loadSkillsFromDir(dir);
    const prompt = renderSkillsPrompt(result.skills);
    expect(prompt).toContain("# 可用技能（Skills）");
    expect(prompt).toContain("## 技能：refund-flow");
    expect(prompt).toContain("退款流程");
    expect(prompt).toContain("先查订单");
    expect(prompt).toContain("不要强行套用");
  });
});
