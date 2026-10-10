# EXTENDING · 扩展指南：往 engine 里加自己的东西

> 教学文档（01-09）回答「这是什么、为什么这么设计」；本篇回答「我要加自己的东西，从哪下手」。
> 每节都给最小步骤 + 参考实现（仓库内现成的样板）。

---

## 1. 自定义一个工具（最常见）

三件套：`description`（给模型看的说明书）+ `inputSchema`（zod 参数图纸）+ `execute`（真实现）。

```ts
import { tool } from "ai";
import { z } from "zod";

const queryStock = tool({
  description: "查询股票当前价格。用户提到股票代码或名称并询问价格时调用。",
  inputSchema: z.object({ symbol: z.string().describe("股票代码，如 AAPL") }),
  execute: async ({ symbol }) => fetchFromYourApi(symbol), // 真实现在这
});
```

然后把它放进工具表（`{ stock: queryStock }`）传给 `runToolLoop`——模型自动获得这个能力，循环零改动。

**三条纪律**（详见 [03-tools.md](../reference/03-tools.md)）：
- description 写清「适合什么 / 不适合什么」——模型靠它选工具；
- zod schema 的 message 写成「给模型的修正指令」（校验失败会回灌给模型）；
- 写操作（建单/下单）建议套幂等壳（`wrapToolsWithIdempotency`）。

**完整可跑示例**：`packages/engine/examples/custom-tool.ts`。

## 2. 加一种 Memory 实现（如 SQLite）

`SessionStore` 接口五个方法：`append / getWindow / clear / listSessions / getHistory`。

1. 新建 `src/memory/session.sqlite.ts` 实现 `SessionStore`；
2. `factory.ts` 的 env 分支里加一个值（如 `SESSION_STORE=sqlite`）——**注意**：不认识的值会警告并回退内存（离线优先铁律），你加的值要进分支白名单；
3. 契约测试挂上：`test/memory.contract.spec.ts` 里 `runSessionStoreContract("sqlite 实现", makeStore)`——行为一致性由契约背书，不用复制断言。

参照实现：`session.memory.ts`（最简）/ `session.redis.ts`（带 TTL、分布式锁的完整版）。

## 3. 加一种 RAG 存储

`RagStore` 接口六个方法：`upsert / deleteDoc / listDocs / readDoc / search / count`。

同上三步：实现接口 → `store.factory.ts` 加 env 值 → `test/rag.contract.spec.ts` 挂契约（用 docIdPrefix 圈定测试数据）。
参照：`store.memory.ts`（余弦手算版）。

## 4. 接一个新 LLM 网关

只要它兼容 OpenAI 协议（绝大多数主流网关都兼容），改 `.env` 三行即可，零代码：

```env
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
# 注意：DeepSeek 无 embeddings 接口，RAG 功能需换 Qwen/GLM（EMBEDDING_MODEL 跟着改）
```

要接非 OpenAI 协议的厂商：在 `llm.ts` 加一个分支返回对应 SDK 的 `LanguageModelV2` 适配（ai SDK 有各厂商的 provider 包）。

## 5. 自定义库日志

engine 内部的警告（配置降级、脏数据跳过）走可注入的 Logger，默认 console：

```ts
import { setEngineLogger } from "@agent-app/engine/logger";
// 换成你的日志系统（应用启动早期、任何工厂调用之前）
setEngineLogger({ info: myLog.info, warn: myLog.warn });
// 测试静音：setEngineLogger({ info: () => {}, warn: () => {} })
```

**边界**：轨迹（`trace.ts`，stderr + AGENT_TRACE 开关）与评测报告输出是独立通道，不归 Logger 管——见 `src/logger.ts` 头注。

## 6. 调运行参数

步数保险丝的库级默认值集中在 `agent-loop.ts`：

```ts
import { DEFAULT_MAX_STEPS } from "@agent-app/engine/agent-loop";
// runToolLoop({ ..., maxSteps: 8 })  ← 调大换更复杂任务，代价是失控风险（见 01 文档保险丝节）
```

审批超时 / 幂等 TTL / 存储开关都是环境变量（见根 `.env.example` 的分区注释）。

## 7. 验证你的扩展

```powershell
pnpm verify   # typecheck → engine/api 测试 → selftest → examples 类型检查 → 架构红线
```

加了自己的实现后，把契约测试挂上（第 2/3 节）再跑 verify——契约全绿 = 你的实现遵守了接口承诺。
