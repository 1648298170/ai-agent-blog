# skills/ —— Agent 的「知识扩展」：SKILL.md 技能加载与注入

> 与隔壁 `mcp/` 一句话分工：**MCP 给能力**（能调什么工具——锤子），**Skill 给知识**
> （这些工具在什么场景、按什么顺序、说什么话——锤子使用工艺手册）。两者互补，
> Skill 正文里直接写工具名即可引用，无需注册关系。

## 一、Skill 是什么

一份 `SKILL.md` 文件（Anthropic [agentskills.io](https://agentskills.io) 规范格式）：

```markdown
---
name: refund-flow
description: 客服退款处理流程：判断何时可退、先查订单再建工单
---

# 退款处理流程

1. 先调用 getOrderStatus 查订单……
2. 可退时调用 createTicket 建工单……
```

- **frontmatter 的 `description`** 是常驻上下文的元数据——Agent 靠它判断「这个技能适不适用当前问题」
- **正文** 是领域流程——命中场景时按步骤执行

**关键性质：SKILL.md 是磁盘上的文本，直接进 system prompt 就是提示注入面。**
所以加载侧有安全四件套（见 loader.ts 头注释）：路径遍历防护 / 大小上限
（单技能 16KB、总数 32、总量 64KB）/ 捆绑脚本永不执行 / 重名先到先得。

## 二、怎么用（CLI）

```powershell
# 默认目录 .agent-skills（相对进程 cwd），存在即自动加载
pnpm chat

# 显式指定目录（仓库里自带的示例：.agent-skills/refund-flow/SKILL.md）
pnpm chat --skills .agent-skills

# 或写进 .env（SKILLS_DIR 在 engine config 白名单内）
# SKILLS_DIR=D:\work\my-skills
```

启动时控制台会打印 `已加载技能（N 个：xxx、yyy）`；加载告警（跳过原因/冲突）以
`[skills]` 前缀逐条浮出，**单个技能坏不拖死全部**。开 `--trace` 可见 🔍 技能加载事件。

无技能时 system prompt 与引入前**逐字节一致**（零变化铁律，与 --mcp 同款约束）。

## 三、怎么写一个技能

1. 建子目录：`.agent-skills/<技能名>/SKILL.md`
2. frontmatter 只认 `name`（小写字母/数字/连字符，2~64 位）和 `description`（≤200 字符）
3. 正文写三块：**适用场景**（Agent 判断何时套用）/ **处理步骤**（可直接引用工具名）/
   **边界**（什么情况跳过流程转人工）

写完直接重跑 `pnpm chat` 即生效——技能是启动时读取的纯文本，无编译无注册。

## 四、文件地图

| 文件          | 职责                                                                |
| ------------- | ------------------------------------------------------------------- |
| `types.ts`    | `SkillDefinition` / `SkillsLoadResult` 契约                         |
| `loader.ts`   | frontmatter 解析 + 目录扫描 + 安全四件套（⚠️ 本目录最值得读的文件） |
| `registry.ts` | `renderSkillsPrompt`：全量注入拼装（空技能返回空串）                |
| `index.ts`    | 桶导出                                                              |

## 五、扩展路线

| 批次   | 内容                                                                                                                                                | 状态         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 第一批 | 目录加载 + 全量注入（本批）                                                                                                                         | ✅           |
| 第二批 | **渐进披露**：system prompt 只放「name: description」清单 + 内置工具 `load_skill(name)`（Agent 判断需要时自己读全文）——几十个技能时的上下文成本正解 | BACKLOG 挂账 |
| 后置   | 技能来源中心化（git 仓库/远端分发）：loader 接口已留缝（传目录即可换来源）                                                                          | 视需求       |
