# 第 17 周 · Day 2：短期记忆——管好进入模型的每一个 token

> 对应手册任务：学习「短期记忆：对话历史压缩 + Deep Agents 上下文模式（compaction、子 Agent 上下文隔离、超长工具结果卸载）」，动手实现「最近 N 轮 + 摘要」的对话压缩，再实现把超长工具结果卸载到「虚拟文件」后只留摘要的 compaction demo，当日产出「上下文压缩模块」。本篇只解决一个问题：窗口越做越大，历史越堆越长，Agent 却越来越贵、越来越笨。上下文不是塞得越多越好，你得有一个主动决定「什么进、什么压、什么卸走」的压缩层。

## 今日目标

1. 说得清上下文腐烂（context rot）：为什么 200k 窗口也不能放开聊，塞满不等于用好
2. 掌握两条主线策略：滑动窗口 + 摘要管对话流；Deep Agents 三件套（结果卸载、子 Agent 隔离、外置任务清单）管工具结果和重活
3. 独立写出 `buildContext` 和 `offloadToolResults`，组装成 `context-compaction.ts`，亲眼看一条 6600 字符的工具结果被压成两行占位符

## 概念讲解：为什么窗口大不等于记性好

昨天你画完了三层记忆架构图：Redis 短期、PG 长期、向量库语义（[本周](/week17/)日程）。今天啃第一层里最硬的骨头：短期记忆，也就是上下文窗口本身。

先给这件事正名。2025 年行业把 prompt engineering 这个词升级成了 context engineering（上下文工程）。Anthropic 的定义很直白：上下文工程就是管理进入模型的每一个 token。以前你优化的是「一句指令怎么措辞」，现在你要管理的是模型每次生成时眼前摆着的全部东西：system prompt、几十轮对话历史、十几个工具定义、工具返回的原始数据、检索进来的文档。窗口就是 Agent 的工作内存，而你就是内存管理器。

直觉说：窗口都 200k 了，随便聊。这笔账算不过来，问题有两个。

第一个是钱。聊天 API 是无状态的，每一轮都把全部历史重发一遍。对话越长，历史线性膨胀，每一轮的成本和延迟跟着线性膨胀。聊到第 100 轮，你为一句话付的钱是第 1 轮的几十倍，其中九成付给了模型根本不需要重看的旧消息。

第二个更致命：上下文腐烂（context rot）。窗口越长，模型的注意力越稀释。埋在中段的信息召回变差，跨段落的推理开始出错，指令遵循水平下滑。同一条「回答前先复述订单号」，放在 2k 上下文里模型照做，埋进 150k 历史里它就开始丢三落四。token 是注意力预算，每多塞一个无用 token，有用 token 分到的注意力就少一分。不是塞满就好，是塞对才好。

所以正确的心智模型是：上下文窗口是 RAM，不是硬盘。RAM 里只放此刻生成要用的东西，仓库（长期记忆、向量库）里的东西要用时再调入。你不会把整张数据库表加载进内存再跑一个 SELECT。今天的压缩模块干的就是换页管理器的活：对话流用窗口 + 摘要管，工具结果用卸载管，重活用子 Agent 隔离管。

## 核心知识

### 1. 策略一：滑动窗口 + 摘要，管住对话流

最朴素的压缩是滑动窗口：只发最近 N 条消息，`slice(-N)` 一行搞定。致命伤是硬切断层。用户 20 分钟前给的订单号、第 3 轮确认过的退货原因，窗口一滑全没了。Agent 活成一条只有 8 条消息记忆的金鱼，用户莫名其妙，你排查半天发现是「失忆」而不是「能力差」。

补救办法：掉出窗口的不是扔掉，是压成摘要。真正发给模型的上下文长这样：

```text
[system]    你是电商客服 Agent。
[system]    [早期对话摘要] 用户在排查订单 A-1003 未发货的问题，已确认
            收货地址无误，等待调取物流流水……（约 150 字）
[user]      最近 8 条消息，原文保留
[assistant]
[tool]
...
```

三个工程要点：

- **system prompt 永不参与压缩**，永远置顶。它是宪法，不是历史。
- **摘要由 LLM 生成，但不每轮生成**。每轮都把窗口外历史重新摘要一遍，成本又线性回去了。正确做法是增量维护：新掉出窗口的消息和上一版摘要合并，让 LLM 输出新版摘要，一次调用完事。
- **N 按「轮」数，不按「条」数**。一轮等于 user + assistant，中间可能夹着 tool 消息。从轮边界切，切在中间会把工具结果切成孤儿，轻则模型困惑，重则 API 直接报错。

### 2. 策略二：Deep Agents 三件套，管住工具结果和重活

窗口 + 摘要管得住聊天，但真正撑爆上下文的往往不是聊天，是工具。一次数据库导出返回 20k token，一次网页抓取拖回整页 HTML，三五个工具来回，再大的窗口也见底。Claude Code、Manus 这类跑长任务的 Deep Agent 靠三件套解决：

**① 超长工具结果卸载。** 工具结果超过阈值（比如 5000 字符），原文就写进一个「虚拟文件」，上下文里只留一个占位符：文件名、总行数、开头几行摘要、取回句柄。模型平时只看占位符，真需要细节时再调 `read_file` 把相关段落读回来。20k token 变 50 token，信息没丢，只是换了个便宜的地方待命。这是 compaction 的核心动作：把「模型可能要看的」和「模型现在就要看的」分开。

**② 子 Agent 上下文隔离。** 碰上「搜 30 个网页找答案」这种重活，主 Agent 派一个子 Agent，给它一份全新的独立上下文。子 Agent 在自己的窗口里翻箱倒柜，几百次搜索、几十万 token 的中间过程全部死在它自己的上下文里，最后只把一段结论回传主 Agent。爆炸的中间过程从根上就不进主上下文，这比事后压缩干净得多。

**③ 外置任务清单。** 长任务的规划状态（做完了什么、接下来干什么）如果靠对话历史承载，模型每轮都要把计划复述一遍，历史越滚越长。Claude Code 的做法是 `write_todos` 工具：任务清单是一份外部文件，模型每轮只读写清单本身，计划一个字都不占对话历史。

三件套和策略一组合，就是主上下文的三层防御：

```text
主上下文（贵、稀缺、会腐烂）
├─ 第一层 窗口 + 摘要 → 管对话流：掉出窗口的压成 150 字摘要
├─ 第二层 结果卸载   → 管工具返回：超长原文进虚拟文件，只留句柄
└─ 第三层 子 Agent   → 管重活：中间过程死在子 Agent，只回传结论
```

顺手补一句：万一整个上下文还是逼近上限（三层都拦不住），还有最后一招叫 compaction，Claude Code 的 `/compact` 就是它：把全部历史压成一段摘要，带着摘要从头开始。今天要写的 demo，方向就是这个方向。

## 动手任务：`context-compaction.ts` 一步一步

手册任务：实现「最近 N 轮 + 摘要」压缩，再实现超长工具结果的卸载。拆成 5 步，全程约 25 分钟。类型写法用[第 1 周](/week01/)练过的联合类型，零外部依赖，跑通后再把摘要器换成真 LLM。

**第 1 步：建文件。** 在本周练习目录新建 `context-compaction.ts`。下面每一步的代码都往里加，写完就是当日产出。

**第 2 步：定义消息类型、常量和虚拟文件库。**

```ts
/** 消息类型：和主流 Chat API 的消息形状对齐 */
type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string; toolCallId: string };

/** 摘要器：输入掉出窗口的消息，输出一段摘要文字 */
type Summarizer = (messages: Message[]) => string;

const TOOL_RESULT_LIMIT = 5000; // 工具结果超过 5000 字符就卸载
const KEEP_LAST = 8;            // 窗口内保留最近 8 条消息（demo 按条算，生产按轮算，见坑 1）

/** 虚拟文件库：卸载的原文都存在这里，key 是文件名 */
const fileStore = new Map<string, string>();
```

关键在 `Summarizer` 这个类型：摘要能力通过参数注入，demo 里传规则版，生产里传 LLM 版，压缩逻辑一行不用改。

**第 3 步：第一道闸，卸载超长工具结果。**

```ts
/** 取开头几行当摘要，让模型够判断要不要取回原文 */
function firstLines(content: string, lines: number): string {
  return content.split("\n").slice(0, lines).join(" | ").slice(0, 120);
}

/** 卸载：原文入文件库，返回占位符 */
function offload(name: string, content: string): string {
  fileStore.set(name, content);
  return (
    `[结果已存 file:${name} 共 ${content.split("\n").length} 行，` +
    `摘要: ${firstLines(content, 3)}，` +
    `需要原文时调用 read_file("${name}")]`
  );
}

/** 逐条检查，是超长的 tool 消息就卸载，其余原样放行 */
function offloadToolResults(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;                          // 不是工具结果，放行
    if (msg.content.length <= TOOL_RESULT_LIMIT) return msg;      // 不超长，放行
    const name = `tool_${msg.toolCallId}.txt`;                    // 走到这的必然是超长结果
    return { ...msg, content: offload(name, msg.content) };
  });
}
```

关键在占位符里的 `read_file("...")`：它不是装饰，是给模型的取回句柄。没有这句，模型会「忘记」自己看过完整数据，转头重新调一遍工具，反而更贵。

**第 4 步：第二道闸，窗口 + 摘要。**

```ts
function buildContext(messages: Message[], summarize: Summarizer): Message[] {
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");

  if (rest.length <= KEEP_LAST) return [...system, ...rest]; // 没超窗口，不压

  const dropped = rest.slice(0, rest.length - KEEP_LAST); // 掉出窗口的
  const kept = rest.slice(-KEEP_LAST);                    // 保留原文的

  const summary: Message = {
    role: "system",
    content: `[早期对话摘要] ${summarize(dropped)}`,
  };
  return [...system, summary, ...kept];
}

/** 压缩入口：先卸载工具结果，再做窗口 + 摘要 */
function compact(messages: Message[], summarize: Summarizer): Message[] {
  return buildContext(offloadToolResults(messages), summarize);
}
```

关键在 `compact` 的管线顺序：先卸载再截断。卸载在前，占位符很短，之后掉出窗口也不可惜；截断在前，超长结果可能整条留在窗口里白占地方。两道闸各管各的，顺序不能反。

生产环境把规则摘要器换成 LLM 调用，提示词往这个方向写：

```text
把下面这段较早的对话历史压缩成不超过 150 字的摘要，必须保留：
1. 用户的目标和身份
2. 已确认的关键事实（订单号、金额、日期，保留具体值）
3. 尚未解决的问题
4. 用户明确表达过的偏好
直接输出摘要正文，不要任何前缀和客套。
```

**第 5 步：造数据，跑通，看数字。**

```ts
/** demo 用规则摘要器，接口和 LLM 版完全一致 */
function ruleSummarize(messages: Message[]): string {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  const asked = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.slice(0, 15));
  return `此前 ${messages.length} 条消息、约 ${chars} 字符；用户问过：${asked.slice(0, 3).join("；")} 等`;
}

// ---- demo ----
const history: Message[] = [{ role: "system", content: "你是电商客服 Agent。" }];

for (let i = 1; i <= 10; i++) {
  history.push({ role: "user", content: `查一下订单 ${1000 + i} 的状态` });
  history.push({ role: "assistant", content: `订单 ${1000 + i} 已发货，预计 3 天送达。` });
}

history.push({ role: "user", content: "把后台所有订单导出来给我看看" });
history.push({
  role: "tool",
  toolCallId: "call_export_1",
  content:
    "ORDER_ID,STATUS,AMOUNT\n" +
    Array.from({ length: 400 }, (_, i) => `A${1000 + i},shipped,${(i + 1) * 29}`).join("\n"),
});

const compacted = compact(history, ruleSummarize);
const size = (msgs: Message[]) => JSON.stringify(msgs).length;

console.log(`压缩前 ${size(history)} 字符 → 压缩后 ${size(compacted)} 字符`);
console.log(`虚拟文件库：${[...fileStore.keys()].join(", ")}`);
for (const m of compacted) console.log(`[${m.role}] ${m.content.slice(0, 70)}`);
```

23 条消息、一条 6600 多字符的导出结果，压完剩 9 条：1 条 system、1 条摘要、7 条窗口内消息，那条巨型 tool 消息变成两行占位符。我跑出来的数字大约压掉九成（你造的数据不同，比例会变，量级不变）。原文好端端躺在 `fileStore` 里，模型要细节随时 `read_file` 取回。

::: tip 运行命令
`npx tsx context-compaction.ts` 直接跑；只查类型就 `npx tsc --strict --noEmit context-compaction.ts`。都没装就先 `npm install -g typescript tsx`，编译后用 node 跑产物也行。
:::

## 常见踩坑

**坑 1：按条数截断，把工具结果切成孤儿。** assistant 发起工具调用和 tool 返回结果是配对的，截断落在这对中间，主流 Chat API 会直接报错：tool 结果找不到对应的调用。demo 里消息少没踩到，生产里务必按「轮」截，或截完后扫一遍，把配不上的 tool 消息一起送出窗口。

**坑 2：每轮都重新摘要，成本爆炸。** 压缩是为了省钱，结果每轮多一次 LLM 摘要调用，等于拆东墙补西墙。记住增量维护：新掉出窗口的消息加上一版摘要，合并成一次调用；再配个触发阈值（比如历史超过 KEEP_LAST + 4 才压），大部分轮次零额外开销。

**坑 3：摘要丢关键信息。** 「用户之前说过订单号」这种摘要没用，模型要的是订单号本身。摘要提示词里必须点名保留具体值：订单号、金额、日期、名字。高价值实体还可以走规则白名单，摘要生成后把实体清单拼在后面，双保险。

**坑 4：卸载后不给取回句柄。** 占位符只写「结果太长已省略」，模型只有两个反应：重新调一遍工具（更贵），或者对着空洞的占位符瞎编（更糟）。占位符三要素缺一不可：存在哪（文件名）、大概是什么（开头摘要）、怎么取回（read_file 调用示例）。

**坑 5：system prompt 参与压缩。** 有人贪省事把摘要直接拼进 system prompt，或者把 system 消息也 slice 进窗口。前者每轮都在改宪法，缓存全失效；后者更惨，Agent 人格直接丢失。system 永远原样置顶，摘要作为独立的一条 system 消息插在它后面。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 窗口都有 200k 了，为什么还要压缩？说出两笔账。

::: details 参考答案
经济账：无状态 API 每轮重发全部历史，成本和延迟随轮次线性膨胀。质量账：上下文腐烂，窗口越长注意力越稀释，中段信息召回和指令遵循都下滑。token 是注意力预算，塞满不等于用好。
:::

2. `buildContext` 里掉出窗口的消息去哪了？摘要是每轮都重新生成吗？

::: details 参考答案
压成一条独立的 system 摘要消息，插在 system prompt 之后、窗口原文之前。不是每轮生成：增量维护，新掉出的消息和上一版摘要合并成一次 LLM 调用，再配触发阈值，多数轮次零开销。
:::

3. 工具结果被卸载到虚拟文件后，模型后面需要原文怎么办？

::: details 参考答案
占位符里带取回句柄：文件名、行数、开头摘要、read_file 调用示例。模型判断需要细节时调 read_file 把相关段落读回上下文。信息没丢，只是从「常驻上下文」变成「按需调入」。
:::

4. 子 Agent 隔离和窗口截断都是在控制上下文，本质区别是什么？

::: details 参考答案
截断和摘要是事后压缩：信息已经产生，再决定留多少。子 Agent 隔离是事前预防：爆炸的中间过程从头就在子 Agent 的独立上下文里产生，主上下文只见结论。能隔离就隔离，隔离不了再压缩。
:::

5. 三层防御各自管什么？各举一个对应的具体手段。

::: details 参考答案
窗口 + 摘要管对话流（buildContext 保留最近 8 条，其余压成摘要）；结果卸载管工具返回（ToolMessage 超 5000 字符进 fileStore，留占位符）；子 Agent 管重活（派独立上下文的子 Agent 干活，只回传结论）。
:::

## 延伸阅读

- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，上下文工程定义的出处，compaction、子 Agent 隔离、任务清单外置的原始论述，本篇三件套的出处
- [Manus：Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)，「文件系统即上下文」的实战复盘，把超长中间产物卸载到文件的思路来自这里
- [LangGraph：Memory 概念文档](https://langchain-ai.github.io/langgraph/concepts/memory/)，短期记忆的窗口与摘要模式，Day 6 把记忆整合进 LangGraph 前值得通读

今天的产出 `context-compaction.ts` 留好。Day 6 把记忆整合进 LangGraph 时，`compact` 会直接挂到图的节点上，每轮生成前自动过一遍。明天 Day 3 先把长期记忆落到 PostgreSQL：用户偏好存进去，Agent 启动时读出来。
