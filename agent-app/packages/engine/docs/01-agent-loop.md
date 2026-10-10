# 01 · agent-loop：手写多步工具循环（核心中的核心）

> 一句话：LLM 只会「说」不会「做」。这个 200 行的循环让它 **说 → 做 → 看结果 → 再说**，直到把事办成。
> 市面上 LangChain / CrewAI 剥到最里层，也是这个循环。理解它 = 理解所有 Agent 框架的内核。

---

## 它解决什么问题

裸的 LLM 是「一问一答」：你问一句，它答一句，结束。

但真实任务往往需要多步：

```text
用户：「订单 A-1024 到哪了？」
模型心里：我需要先查订单状态 → 拿到结果 → 再组织语言回答
              ↑ 这一步模型自己做不到，它没有"查"的能力
```

**解法**：给模型一份「工具清单」（工具名 + 用途 + 参数说明），模型在回答前可以说
「我要调 getOrderStatus，参数是 A-1024」——然后由**我们的代码**替它执行，把结果塞回对话，
让模型看着结果继续。这个「说→做→看→再说」的循环，就是 agent-loop。

**为什么手写而不用框架**：教学项目要看清每一层。框架的价值是省事，代价是黑盒——
出了问题（比如模型死循环调工具）你不知道该修哪里。手写 200 行，每一步都可插桩。

---

## 核心概念（5 分钟版)

### ReAct 循环

ReAct = **Rea**son + **Act**（思考 + 行动）的缩写，Agent 领域最经典的模式：

```text
┌─────────────── 循环体（agent-loop.ts 的 while 循环，最多 maxSteps 步）───────────────┐
│                                                                                     │
│  ▶ 思考   generateText({ messages, tools })——把对话历史 + 工具清单发给模型            │
│  │        模型返回两种可能：                                                          │
│  │        a) toolCalls 非空 → 它想干活，进入行动                                      │
│  │        b) 没有工具调用，只有文本 → 它认为办完了，循环结束，这就是最终回答            │
│  ▼                                                                                   │
│  ⚙ 行动   逐个执行模型要的工具：从 tools 表里按名字找到 → 校验入参 → 真正执行           │
│  │        结果统一序列化成 { type: "json", value } 形状                                │
│  ▼                                                                                   │
│  ✓ 观察   把结果包成 role: "tool" 消息 push 进 messages——这一步叫「回灌」             │
│  │        ★ 最关键的一步：模型是无状态的，不回灌它就"失忆"，不知道刚才查到了什么        │
│  ▼                                                                                   │
│  回到 ▶（step 计数 +1；超过 maxSteps 抛「步数用完」错误——防死循环的保险丝）            │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 三个必懂的细节

**① 回灌的消息形状**。工具结果不是随便塞文本，而是结构化的 `tool-result` 消息：

```ts
messages.push({
  role: "tool",
  content: [{
    type: "tool-result",
    toolCallId: call.toolCallId,  // 对应模型发出的调用 id（一对一回执）
    toolName: call.toolName,
    output,                       // { type: "json" | "error-json", value }
  }],
});
```

**② 成功与失败长得不一样**。工具抛错不是让循环崩掉，而是包成
`{ type: "error-json", value: { error: "..." } }` 回灌——`error-json` 这个类型标记让
**模型能分辨「这是失败」**，从而向用户解释或换个参数重试（见下文校验闸的实测）。

**③ 入参校验闸**。模型生成的参数不可信（会幻觉年份、漏字段），执行前用工具自带的
zod schema 跑一遍 `safeParse`，失败就把错误说明回灌给模型引导它修正。
实测案例：用户问「9 月份订单」，glm-4-flash 幻觉出 `2022-09`——校验闸以「当前时间
±窗口」拒绝越界值，模型收到拒绝原因后自动改用当前年份重试。这就是**结构化修复**
优于「prompt 里求模型自觉」的实证。

---

## 代码走读（`src/agent-loop.ts`，共 ~210 行）

| 位置 | 内容 | 要点 |
|---|---|---|
| `RunToolLoopOptions`（L20） | 循环的入参契约 | `model` / `messages` / `system` / `tools` / `maxSteps` / `signal`（断连中止）/ `onStep`（每步观察钩子） |
| `ToolLoopResult`（L51） | 循环的返回 | `text`（最终回答）/ `messages`（含全部工具往来的完整消息数组——API 的流式收尾直接复用它）/ `steps` |
| `ToolLoopStepEvent`（L61） | 每步的事件 | `step` / `toolCall{toolName,input}` / `output` / `text`（模型步间推理文本，常为 undefined） |
| `toSchemaTools`（L77） | 工具表预处理 | 把 zod schema 转成 SDK 需要的形状 |
| `jsonOutput` / `errorOutput`（L89/94） | 输出序列化 | `JSON.parse(JSON.stringify(v))` 防不可序列化对象炸协议 |
| `runToolLoop`（L102） | ★ 循环本体 | 下面逐段讲 |

### 循环本体的骨架（简化到只剩脉络）

```ts
export async function runToolLoop(options: RunToolLoopOptions): Promise<ToolLoopResult> {
  const { model, messages, tools, maxSteps, signal, onStep } = options;

  for (let step = 1; step <= maxSteps; step++) {
    trace("▶", `思考 step ${step} → 调用模型（上下文 ${messages.length} 条消息）`);

    const result = await generateText({ model, messages, tools });  // ① 思考
    if (result.toolCalls.length === 0) {
      trace("◆", `完成 → 模型给出最终回答`);
      return { text: result.text, messages, steps: step };          // ② 出口：办完了
    }

    for (const call of result.toolCalls) {                          // ③ 可能一次要多个工具
      const tool = tools[call.toolName];
      let output;                                    // 执行结果（成功 json / 失败 error-json）
      try {
        // 校验闸 + 执行（失败也不炸循环，转成 error-json 继续走）
        output = jsonOutput(await tool.execute(call.input, { toolCallId: call.toolCallId, messages }));
      } catch (err) {
        output = errorOutput({ error: err instanceof Error ? err.message : String(err) });
      }

      messages.push({ role: "tool", content: [{ type: "tool-result", ..., output }] }); // ④ 回灌
      onStep?.({ step, toolCall: call, output: output.value });                          // ⑤ 观察钩子
    }
  }
  throw new Error(`步数用完（${maxSteps}），模型仍在要工具`);  // 保险丝：防死循环
}
```

> 完整实现里有更多工程细节（zod 校验闸、abort 中止、trace 打点、text 透传），
> 但**脉络就是上面这 15 行**。读懂这个骨架，剩下的都是装饰。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
pnpm chat --trace
```

然后输入「订单A-1024到哪了」，观察终端：

```text
▶ 思考 step 1 → 调用模型（上下文 1 条消息，可用工具 3 个）
⚙ 行动 step 1 → 要调 1 个工具：getOrderStatus({"orderId":"A-1024"})
✓ 观察 step 1 → getOrderStatus 返回：{...}
▶ 思考 step 2 → ...
◆ 完成 → 模型给出最终回答（25 字，共 2 步）
```

四个图标正好对应循环的四个阶段。再试试「帮我建个工单，主题是查不到订单」——
看它两步走完（建单 → 回答工单号）。

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么 maxSteps 只给 5？ | 保险丝。正常任务 1-3 步完成；不设上限的话模型陷入循环时烧钱又卡死。调大=允许更复杂任务，代价是失控风险。库级默认值导出为 DEFAULT_MAX_STEPS 常量（调用方统一引用，magic number 不散落） |
| 为什么工具抛错不中断循环？ | 错误也是信息。包成 error-json 回灌，模型有机会向用户解释、换参数重试——「错误回灌引导自我修正」比「一炸全断」鲁棒得多 |
| 为什么不用 generateObject 让模型输出结构化决策？ | 实测 glm-4-flash 会无视 response_format 指令（见 `json-utils.ts` 头注与 week19 踩坑）。工具调用（function calling）是模型原生训练过的能力，比 JSON 指令可靠 |
| onStep 钩子是干嘛的？ | 解耦：循环本身不知道「日志、SSE 推送、审批」的存在，订阅方各取所需（api 的 step 事件就是它发的） |
| signal 有什么用？ | 用户关掉浏览器页面后停止烧 token（abortSignal 三层贯穿：HTTP 请求 → streamText → 工具执行） |

---

## 自测题（先凭记忆答，再看文末答案）

1. 循环的**出口条件**是什么？如果模型一直要工具会怎样？
2. 为什么工具结果必须「回灌」？不回灌会发生什么？
3. 模型生成的入参为什么不能直接执行？本项目用什么机制兜底？

<details><summary>答案</summary>

1. 模型某步**不再发起工具调用**（只返回文本）→ 该文本即最终回答。若一直要工具，
   循环到 `maxSteps` 抛「步数用完」错误——保险丝防死循环。
2. 模型是无状态的：每次调用只看到 messages 数组里的内容。不回灌，下一轮模型
   看不到工具结果，等于查了白查。
3. 模型会幻觉参数（错误年份、缺字段）。执行前用工具的 zod schema 跑 `safeParse`，
   失败则把校验错误包成 error-json 回灌，引导模型修正后重试。

</details>

---

## 延伸阅读

- [ARCHITECTURE.md](../../../ARCHITECTURE.md) ——「一条消息的完整旅程」章节与踩坑实录
- `docs/week11/agent-loop-ts.md`——教程主线的循环深入篇（`npm run docs:dev` 起博客看）
- [02-llm-config-trace.md](./02-llm-config-trace.md) ——循环里那个 `model` 是怎么造出来的
- [03-tools.md](./03-tools.md) ——工具表怎么注册、审批壳与幂等壳怎么叠加
