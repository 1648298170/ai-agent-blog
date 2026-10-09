# Engine 教学文档 · 总览

> 这套文档教你读懂 `packages/engine`——本项目的「纯 AI 逻辑核心」。
> 适合刚接手、觉得结构混乱的你：先建立地图，再逐站深入。

---

## 一句话定位

**engine = 不含任何 HTTP / 界面的纯逻辑核心。**
cli / api / web 三端只是给它换不同的「脸」（终端 REPL / HTTP 接口 / 浏览器页面），所有智能行为都发生在这个包里。

## 三层地图（先记住分层，混乱消除 80%）

```text
┌─ 第 3 层 · 产品线（零件组装出的成品）─────────────────┐
│  service/        客服机器人：把下面两层组装成能用的产品        │
├─ 第 2 层 · 能力件（一块块可插拔的零件）─────────────────┤
│  tools/          工具箱：Agent 能"动手"做什么                  │
│  rag/            知识库零件：让 Agent 查你自己的文档            │
│  memory/         记忆：让它记得说过什么、你是谁                │
│  guardrails/     安全员：脱敏、防注入、审批、审计账            │
│  mcp/            标准插口：把别人家的工具接进来                │
│  evals/          考试系统：这套东西行不行，跑分说话            │
├─ 第 1 层 · 内核（引擎的心脏，其他一切围着它转）─────────┤
│  agent-loop.ts   ★ 核心中的核心：手写的多步工具循环            │
│  llm.ts          模型工厂：造"会说话的部分"（OpenAI 协议→GLM） │
│  config.ts       钥匙柜：读 .env，类型化配置                  │
│  types.ts        全包通用的类型图纸                           │
│  trace.ts        行车记录仪：每一步打了什么日志                │
│  json-utils.ts   教训产物：模型吐 JSON 不靠谱的手工解法        │
└────────────────────────────────────────────────┘
```

**记忆口诀**：内核给动力，能力件是零件，产品线是整车。

## 主线故事：一条消息的旅程

用户问：「订单 A-1024 到哪了？」

```text
用户输入
   │
   ▼
① config.ts ── 查钥匙柜：GLM key、模型名、存储开关读好了吗？
   ▼
② memory/ ── 翻记忆：取这个会话最近 20 轮拼进上下文
   ▼
③ agent-loop.ts ── 进入循环（最多 5 步）：
   │   ▶ 思考：messages + tools 发给 GLM
   │     模型回："我要调 getOrderStatus 工具"
   │   ⚙ 行动：从 tools/ 找到工具并执行
   │   ✓ 观察：结果作为 tool 消息回灌
   │   → 回到 ▶，模型看着结果继续……
   │   直到某步不再要工具，直接给出回答
   ▼
④ trace.ts ── 每步打日志（▶⚙✓✗），这就是"可观测"
   ▼
⑤ 回答用户；这轮问答写回 memory/
```

## 学习路线（按被依赖关系，从内核往外走）

| 站点 | 文档 | 先跑什么 | 核心文件 |
|---|---|---|---|
| 1 | [01-agent-loop.md](./01-agent-loop.md) ★ | `pnpm chat --trace` | `src/agent-loop.ts` |
| 2 | [02-llm-config-trace.md](./02-llm-config-trace.md) | `pnpm chat` | `src/llm.ts` `src/config.ts` `src/trace.ts` `src/json-utils.ts` |
| 3 | [03-tools.md](./03-tools.md) | 同第 1 站，观察模型自主选工具 | `src/tools/` |
| 4 | [04-memory.md](./04-memory.md) | `pnpm chat` 连聊几句后 `/exit` 重进 | `src/memory/` |
| 5 | [05-rag.md](./05-rag.md) | `pnpm kb:ingest .\samples\company-faq.md` → `pnpm kb` | `src/rag/` |
| 6 | [06-guardrails.md](./06-guardrails.md) | 对话里说「转人工」看审批/硬规则 | `src/guardrails/` |
| 7 | [07-mcp.md](./07-mcp.md) | `pnpm chat --mcp "cmd /c pnpm mcp:server"` | `src/mcp/` |
| 8 | [08-evals.md](./08-evals.md) | `pnpm selftest` | `src/evals/` |
| 9 | [09-service.md](./09-service.md) | `pnpm service` | `src/service/` |

## 怎么用这套文档

1. **每篇的结构固定**：解决什么问题 → 核心概念 → 代码走读（真实路径+函数名）→ 跑起来验证 → 设计取舍 → 自测题 → 延伸阅读
2. **先跑再读**：每篇的「跑起来验证」放在代码走读之前体验——先有体感再读实现，效率翻倍
3. **读完做自测题**：凭记忆回答（retrieval 练习），比重读十遍更有用
4. 卡住了就问 AI 老师（本项目的开发助手），或者翻仓库里的深度材料：
   - [ARCHITECTURE.md](../../../ARCHITECTURE.md)——架构图 + 六条踩坑实录
   - `docs/weekNN/` 教程（VitePress 博客，`npm run docs:dev` 起来看）
   - 各模块自己的 `README.md`（memory/rag/tools/guardrails/mcp/evals 都有）
