# 第 11 周 · Day 1：LLM API 原生调用——用 TypeScript 直连大模型

> 对应手册任务：学习「LLM API 原生调用：messages 结构、system prompt、temperature/top_p/max_tokens」，动手写一个不用任何框架的多轮对话 CLI，手动维护 messages 历史，当日产出 `raw-chat.ts`。本篇只解决一个问题：在套任何框架之前，先亲眼确认「模型不记得你说过什么」，多轮对话的记性，是你自己一行行拼出来的。

## 今日目标

1. 说得清 messages 里 system、user、assistant 三种角色各自的语义，以及为什么每一轮都要把全部历史传回去
2. 掌握采样参数三件：temperature、top_p、max_tokens，什么任务调什么值，调过头会发生什么
3. 不用任何框架，用 openai 官方 npm SDK 写出多轮对话 CLI `raw-chat.ts`：历史自己追加，token 成本自己记账

## 概念讲解：为什么必须先碰原生 API

本周正式碰 LLM。你的第一反应可能是直接装个 LangChain（它有 JS 版），一行 invoke 就有回复，何必先学原生调用。先忍住。框架能帮你少写代码，前提是你知道它替你写了什么；不知道，它就只是把故障也一起封装了。

原生 API 长什么样？一句话：一个无状态的 HTTP 接口，你发一批消息，它回一条消息，然后把你忘干净。你在前面的周里写过 SSE 推送，已经见过一次「无状态」：浏览器一刷新，连接断了，服务端不记得你是谁。LLM API 比这更彻底，连连接都不保持。这次调用它说了什么，下次调用它一无所知。

那 ChatGPT 网页版的连续对话是怎么来的？服务端替你保管了整个对话历史，每轮都把历史连同新问题一起发过去，模型现读现答。所谓「它记得上文」，全部秘密就是客户端拼的那个 messages 数组。

为什么要亲手写一遍？W12 的 LangGraph 会用 state 里的 messages 列表帮你自动做这件事。现在不手动维护一次，以后框架报「上下文超长」、回答前后矛盾、账单暴涨，你连排查方向都没有。本篇就是后面所有框架的对照基线：框架帮你封装了什么，答案全在今天这两次 push 里。

## 核心知识

本节的代码片段都可以单独存成 .ts 文件，`npx tsx 文件名.ts` 直接跑。模型名按你实际可用的填，最终完整实现以下面的动手任务为准。

### 1. messages：三种角色，一个数组

先看最小的一次调用：

```typescript
import OpenAI from "openai";

const client = new OpenAI(); // 自动读环境变量 OPENAI_API_KEY

const resp = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: "你是一个简洁的中文技术助手。" },
    { role: "user", content: "什么是无状态？" },
  ],
});
console.log(resp.choices[0].message.content);
```

装好 SDK 就能跑，类型全部由它自带，不用你写一行 interface。messages 是对话的完整快照，每个元素两个键：role 和 content。三种角色，语义各不相同：

- system：定规矩的。人设、语气、输出格式、禁令，放在数组最前面。它不算对话内容，是给模型的长效指令，整场对话每轮都生效。
- user：用户这一方说的话。
- assistant：模型此前说过的话。第一轮请求里没有它；从第二轮起，它是你自己亲手加回去的。

多轮对话时 messages 长这样：

```typescript
const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: "system", content: "你是一个简洁的中文技术助手。" },
  { role: "user", content: "我叫 Jerry，我最喜欢的数字是 7。" },
  { role: "assistant", content: "你好 Jerry，记住了。" }, // 上一轮的回复，自己加回来
  { role: "user", content: "我叫什么？最喜欢的数字呢？" },
];
```

那个类型标注是 SDK 导出的：role 是一组字面量联合，手滑写成 "usr" 编译期就报错。这是用 TS 对接 API 的日常红利，字段拼错不用等请求打过去才炸。

关键在第三条：那条 assistant 不是 API 返回的什么神秘引用，就是上一轮 `resp.choices[0].message.content`，你拿到后塞回数组的。模型读这个数组时并不区分「谁转述的」，它只是照着剧本往下演。由此得到一条重要结论：历史里有的它就知道，历史里没有的它就不知道，它的记忆边界和数组边界完全重合。数组越滚越长，每次请求的 token 就越来越多，钱也越花越多。这句话先记住，怎么裁剪历史是后面记忆周的核心问题。

### 2. 参数三件：temperature、top_p、max_tokens

先弄清模型怎么产出文字：不是查表，是逐个 token 掷骰子。每一步它给词表里所有候选 token 算一个概率，再按概率抽一个。三个参数，动的都是这个骰子。

temperature，范围 0 到 2，默认 1。值越低，高概率的 token 越接近必中，输出越稳、越保守、越重复；值越高，概率被摊平，冷门候选也有机会，输出越发散。给你一个直接可感的对照：temperature=0 时同一个问题问五遍，答案几乎一字不差；调到 1.8，五遍五个样，偶尔胡说。选值经验：分类、信息抽取、写代码用 0 到 0.3；日常对话 0.7 上下；创意头脑风暴可以到 1.0 以上，但幻觉跟着涨，自己权衡。

top_p，核采样，范围 0 到 1。只从「累计概率达到 p」的那一小撮候选里抽，其余长尾直接出局。top_p=0.1 就是只留最稳的一撮，效果和低温类似。官方文档明确建议：它和 temperature 二选一调，别同时动。

max_tokens，本次回复的生成上限。达到上限就硬截断，finish_reason 变成 "length"，你会拿到一句断在半截的话。

```typescript
const resp = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "给一家咖啡店起 5 个名字" }],
  temperature: 0,
  max_tokens: 100,
});
console.log(resp.choices[0].finish_reason); // stop：正常说完；length：被截断
```

关键在 finish_reason：它是判断回复完整性的唯一依据。写代码判断它是不是 "length"，是后面所有 Agent 重试逻辑的第一课。

### 3. system prompt 与 usage：人设从这起步，成本从这算

system prompt 是你手里最稳定的控制面。用户输入千变万化，system 是每次请求都原样带上的那条指令，人设、规则、领域知识都放这。后面写 Agent 时的「System Prompt 工程」，编辑的就是这一条 message。两条实用经验：指令要具体可验证，「回答不超过三句话」就比「请简洁」硬得多；规矩控制在个位数，塞几十条模型会挑着忘。

usage 是每次响应附带的账单数据：

```typescript
const u = resp.usage;
console.log(u.prompt_tokens);     // 输入侧：你传的整个 messages 折算的 token
console.log(u.completion_tokens); // 输出侧：模型生成的 token
console.log(u.total_tokens);
```

计费规则一句话：prompt_tokens 乘输入单价，加 completion_tokens 乘输出单价，输出通常贵好几倍。从今天起养成一个反射：拿到回复顺手看一眼 usage。第 21 周讲成本控制时你要为整个 Agent 群记账，账本第一笔从今天记。

## 动手任务：`raw-chat.ts` 一步一步

手册任务：不用任何框架，用官方 npm SDK 写多轮对话 CLI，手动维护 messages 历史。拆成 5 步，全程约 25 分钟。

**第 1 步：装 SDK，配 key。** 在练习目录执行 `pnpm add openai`（还没有 package.json 就先 `pnpm init`），顺手把直跑器也装上：`pnpm add -D tsx`。tsx 一句话讲完：让你免编译直接运行 .ts 文件，`npx tsx 文件.ts` 即刻出结果，后面所有课程默认这么跑。key 走环境变量 `OPENAI_API_KEY`，`new OpenAI()` 构造时自动从 process.env 读。这正是前面周反复强调的原则：密钥进环境，不进代码，更不进 git。推荐用 Node 22 原生的 --env-file：练习目录建一个 .env，写一行 `OPENAI_API_KEY=sk-...`，运行命令带上 `--env-file=.env`，Node 自动把文件内容加载进 process.env，不用再装任何 dotenv 类库；.env 记得加进 .gitignore。不想建文件也行，Windows PowerShell 里 `$env:OPENAI_API_KEY="sk-..."`，macOS/Linux 用 export。用不了 OpenAI 也无妨，DeepSeek 等国内厂商提供 OpenAI 兼容接口，构造时多传一个参数 `new OpenAI({ baseURL: "https://api.deepseek.com" })`，key 换成 DeepSeek 的，模型名换 `deepseek-chat`，本篇代码原样能跑。

**第 2 步：先跑通单轮。** 把核心知识第 1 节的最小示例存成 one-shot.ts，`npx tsx --env-file=.env one-shot.ts` 跑一遍。能打印出回答，说明 key、网络、SDK 全通了，再往下走。

**第 3 步：加循环，手动维护历史。** 新建 raw-chat.ts。命令行交互用 Node 内置的 readline/promises：question() 返回 Promise，await 它就拿到一行输入，套上 while 循环就是最朴素的问答骨架。写下主体：

```typescript
import readline from "node:readline/promises";
import OpenAI from "openai";

const client = new OpenAI();
const MODEL = "gpt-4o-mini";

const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
  { role: "system", content: "你是一个简洁的中文技术助手，回答不超过三句话。" },
];
let totalPrompt = 0;
let totalCompletion = 0;

console.log("raw-chat 已启动（exit 退出，reset 清空历史）");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

while (true) {
  const userInput = (await rl.question("\n你> ")).trim();
  if (!userInput) continue;
  if (userInput === "exit" || userInput === "quit") break;
  if (userInput === "reset") {
    messages.splice(1); // 只留 system，其余全丢
    console.log("（历史已清空）");
    continue;
  }

  messages.push({ role: "user", content: userInput }); // 第一次 push

  const resp = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 500,
  });
  const reply = resp.choices[0].message.content ?? "";
  messages.push({ role: "assistant", content: reply }); // 第二次 push

  console.log(`\n助手> ${reply}`);
}

rl.close();
```

两处 TS 细节值得多看一眼。一是 messages 的类型标注，SDK 自带，role 写错、字段拼错，代码还没跑就给你红线。二是 `resp.choices[0].message.content` 的类型是 string | null，`?? ""` 把 null 兜成空串，类型检查才不嘀咕。

关键就是注释标出的两次 push：发出前把用户这句挂到队尾，拿到回复后把模型那句挂上去。所谓多轮对话的全部机制到这里已经写完，就这两行。reset 用 `messages.splice(1)` 砍掉 system 之后的所有条目，等于亲手验证「记忆边界就是数组边界」。

**第 4 步：记账。** 在打印回复之后加上用量统计：

```typescript
  const u = resp.usage;
  totalPrompt += u.prompt_tokens;
  totalCompletion += u.completion_tokens;
  console.log(`[本轮 ${u.prompt_tokens}+${u.completion_tokens} | 累计 ${totalPrompt}+${totalCompletion} tokens]`);
```

多聊几轮你会发现：哪怕你每轮只打几个字，prompt_tokens 也在稳定上涨，因为整个历史每轮都重传了。这就是无状态的代价，眼见为实。

**第 5 步：做实验，验证无状态。** 跑 `npx tsx --env-file=.env raw-chat.ts`。第一句说「我叫 Jerry，最喜欢的数字是 7」；第二句问「我叫什么？」，它答得上来，历史在数组里。然后输入 reset，再问「我叫什么？」，它不知道了。第 3 步那两次 push 就是记忆的全部来源，别处没有魔法。

::: tip 运行提示
Windows 控制台中文乱码，先执行 `chcp 65001`。模型名按你实际可用的填。想体会参数手感，把 temperature 改成 0 再跑一遍第 5 步，对比两轮实验的稳定程度。
:::

## 常见踩坑

**坑 1：每轮只传新消息。** 第一次写多轮最容易犯：循环里 messages 每次只放当前这句，模型每轮失忆，还礼貌地请你补充背景。修正就一句话：全量传，每轮都传完整数组。这是 API 的约定，不是可选优化。

**坑 2：temperature 和 top_p 一起猛调。** 两个都动，效果像过山车，出了问题说不清该回滚哪个。官方建议二选一，另一个保持默认。调参的老原则：一次只动一个变量。

**坑 3：max_tokens 设太小，回答断在半句。** finish_reason 变成 "length"，内容被硬截。更阴险的场景是要求输出 JSON：截出来的半截 JSON 解析直接报错，这个坑到结构化输出的周还会再见一次。另外，新的推理模型系列不认 max_tokens，要用 max_completion_tokens，SDK 报错时会提示你换名字。

**坑 4：key 写进 .ts。** 哪怕「只是本地玩玩」也别开这个头，git 里躺着一个可用 key 只差一次 push。`new OpenAI()` 默认读 process.env 里的 OPENAI_API_KEY，配 Node 22 的 --env-file=.env 管理：key 放 .env，.env 进 .gitignore。运行时报 `The OPENAI_API_KEY environment variable is missing` 或 401，先看是不是忘了带 --env-file=.env，再查 key 本身对不对。

**坑 5：把 system prompt 当万能封印。** 「必须」「绝对不允许」堆几十条，模型反而挑着执行；写得又长又自相矛盾，还会被后面轮次的对话稀释。经验：规矩控制在个位数，每条具体、可验证。system 的功夫在精不在多，后面整个 Agent 的可信度都压在这一条 message 上。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么第二轮请求必须把第一轮的问答全部传回去？这暴露了模型的什么特性？

::: details 参考答案
模型无状态，每次请求都是独立推理，API 不保存任何会话数据。它能「记得」上文，唯一原因是客户端把历史 messages 全量重传，模型现读现答。副作用是历史越滚越大，token 和费用随之上涨，怎么裁剪历史，是后面记忆周的核心问题。
:::

2. temperature 从 0 调到 1.5，输出会发生什么变化？什么任务该用低温？

::: details 参考答案
低温让高概率 token 接近必中，输出稳定、保守、可复现；高温摊平概率，冷门候选也有机会，输出多样、发散，幻觉风险同步上升。分类、信息抽取、代码生成用 0 到 0.3；闲聊、文案 0.7 到 1.0；1.5 以上是故意要「野」的场合，慎用。
:::

3. top_p=0.1 是什么效果？它和 temperature 为什么建议只调一个？

::: details 参考答案
核采样只保留累计概率达到 0.1 的最小候选集，长尾出局，输出趋于保守，效果接近低温。两者作用于同一步概率采样，同时调会让效果无法归因，出了问题说不清该回滚哪个，所以官方建议二选一。
:::

4. 回复被 max_tokens 截断时，响应里哪个字段会变？写代码该怎么处理？

::: details 参考答案
finish_reason 从 "stop" 变成 "length"，内容在上限处硬截断，可能断在半句；completion_tokens 会贴近设定值。判断 finish_reason 是否为 "length"，再决定重试、加额度还是提醒用户，这是后面 Agent 重试逻辑的基本功。
:::

5. system、user、assistant 三种角色里，哪一种不算「说出来的话」？它在后面写 Agent 时承担什么？

::: details 参考答案
system。它不参与对话内容，是给模型的长效指令：人设、规则、输出格式、禁令，每次请求原样生效。后面所有 Agent 框架的 System Prompt 工程，编辑的就是这一条 message，它是开发者手里最稳定的控制面。
:::

## 延伸阅读

- [OpenAI 文本生成指南](https://platform.openai.com/docs/guides/text-generation)，messages 结构与三个参数的官方说法，本篇参数取值范围的原始出处
- [OpenAI API 参考：Chat](https://platform.openai.com/docs/api-reference/chat)，请求体每个字段的完整定义，写对接代码时当字典查
- [openai-node 仓库](https://github.com/openai/openai-node)，官方 npm SDK 的源码与示例，APIError、RateLimitError 这些错误类型的定义也在这
- [Node.js readline 文档](https://nodejs.org/api/readline.html)，今天 CLI 骨架用的模块，promises 接口的全部细节在这查

今天的 `raw-chat.ts` 和那两次 push 留好。W12 里 LangGraph 的 state.messages 帮你自动做的事就是这两行，第 21 周算成本时用的那本账，第一笔今天已经记上了。
