# 第 11 周 · Day 6：多供应商切换——OpenAI 兼容协议与成本对比

> 对应手册任务：学习「多供应商切换：OpenAI 兼容协议、Qwen/DeepSeek/GLM API、模型选型与成本特性」，动手把 Day 1 的 CLI 改造成支持 3 家模型热切换（只改 baseURL），做一张同题成本对比表，当日产出「多模型 CLI + 成本表」。本篇只解决一个问题：让只会跟一家模型说话的 `raw-chat.ts`，变成一个 `--provider` 参数就能在三家之间切换的多模型 CLI，再用同一道题把三家的账算清楚。

## 今日目标

1. 说得清 OpenAI 兼容协议「兼容」的到底是什么，换供应商时真正要改的只有哪三样东西
2. 掌握 CLI 改造三板斧：`--provider` 参数、配置表驱动、`--env-file` 管三家的 key
3. 独立完成同题对比实验：同一 prompt 跑三家，从 usage 算出真实成本，沉淀出自己的选型基准方法

## 概念讲解：为什么今天必须打通多供应商

Day 1 的 `raw-chat.ts` 只会跟一家模型说话。单供应商就是单点故障：它涨价，你多花钱；它限流，你的服务降级；它停服维护，你的 Agent 直接哑掉。更要紧的是就业现实：国内的业务场景，主力模型基本是 Qwen、DeepSeek、GLM 这些国产系，合规、网络、成本三头都占。面试官问「你们为什么选这家模型、成本怎么控」，你得拿得出亲手跑出来的数据，而不是转述别人的测评。

好消息是这件事的工程成本低得离谱。Day 1 结尾其实剧透过：`new OpenAI({ baseURL: "https://api.deepseek.com/v1" })`，换个地址就能打 DeepSeek。在 TS 主线里这层窗户纸还更薄：openai 本来就是个 npm 包，你 Day 1 写下的那个 `new OpenAI()` 构造函数，baseURL 参数从第一天起就排在参数表里，今天只是头一回真的给它传值。至于各家为什么愿意兼容，不是心善，是竞争使然：OpenAI 的 chat completions 协议成了行业事实标准，好比 USB 接口。后发的厂商想让开发者零成本迁入，最划算的做法就是兼容存量生态，于是 Qwen、DeepSeek、GLM、Kimi、豆包全线提供 OpenAI 兼容端点。你学过的 openai SDK、messages 结构、temperature、usage，一家不落全部通用。

把这层窗户纸捅破，供应商之间的差异就被压缩成三个字符串：baseURL、apiKey、model。地址决定打给谁，key 证明你是谁，模型名指定谁出来干活。除此之外，请求路径、消息结构、响应字段，一模一样。所以今天的改造思路顺理成章：把这三个字符串从代码里抽出来放进配置表，代码只保留那份不变的调用逻辑。新增一家供应商，配置表加一行，别处一个字不改。

最后一件必须当面说清的事：网络。国产 API 国内直连，OpenAI 官方需要代理，这是环境差异，不是玄学。Node 里这事还有个反直觉的细节——你设的代理环境变量，原生 fetch 默认根本不理睬——坑 3 细说。

## 核心知识

本节的代码片段都可以单独存成 .ts 跑。环境一次定好：`npm init -y` 后在 package.json 里加一行 `"type": "module"`（顶层 await 才合法），再 `npm i openai`、`npm i -D tsx`。三家的 key 先去各自控制台注册领取，模型名以控制台「模型列表」页为准，本篇写的是常用起步名，不保证永远有效，这个习惯从今天养成。

### 1. OpenAI 兼容协议：三个字符串换一家模型

先看换供应商的最小动作到底有多小：

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", // 换这行
  apiKey: process.env.QWEN_API_KEY, // 换这行
});

const resp = await client.chat.completions.create({
  model: "qwen-plus", // 换这行
  messages: [{ role: "user", content: "用一句话介绍你自己" }],
});
console.log(resp.choices[0].message.content);
console.log(resp.usage?.total_tokens);
```

关键在构造函数的两个参数：`new OpenAI({ baseURL, apiKey })`。不传 baseURL，SDK 默认打 OpenAI 官方；传了，HTTP 请求就发往你指定的地址。路径怎么拼、请求体什么结构、响应里 choices 和 usage 长什么样，全按 OpenAI 协议来，所以 `chat.completions.create` 这一段一个字不用改。TS 侧还多一层踏实：响应的每个字段都有类型，`resp.usage?.total_tokens` 输错一个字母，编辑器当场标红，供应商换来换去，形状不会认错。三家接入三要素汇成一张表，照抄就能通：

| 供应商 | baseURL | 起步模型名 | key 在哪拿 |
| --- | --- | --- | --- |
| Qwen（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 阿里云百炼控制台 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | DeepSeek 开放平台 |
| GLM（智谱） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 智谱开放平台控制台 |

两个提醒。第一，baseURL 到表里那个结尾为止，别再往下拼路径：SDK 会自动在后面接自己的接口路径，你多补一段就是 404。第二，模型名会迭代，这张表只是今天的快照，接每家前花一分钟去控制台核一眼，别背。

### 2. CLI 改造：配置表驱动 + `--provider` 参数

三要素既然只有三个字符串，就别写三份 if-else，用一张数组配置表管起来。key 的读法沿用 Day 1 的规矩：密钥进环境变量，不进代码，更不进 git。具体工具是 Node 20.6+ 原生的 `--env-file`：启动时 `npx tsx --env-file=.env xxx.ts`，.env 里的每一行自动灌进 `process.env`，连 dotenv 包都省得装。tsx 本来就是 node 的替身，node 的命令行参数它全认。

```ts
import OpenAI from "openai";

export interface ProviderConfig {
  name: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

export const PROVIDERS: ProviderConfig[] = [
  {
    name: "qwen",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiKey: process.env.QWEN_API_KEY ?? "",
  },
  {
    name: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  },
  {
    name: "glm",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    apiKey: process.env.GLM_API_KEY ?? "",
  },
];

export function buildClient(name: string): { client: OpenAI; model: string } {
  const cfg = PROVIDERS.find((p) => p.name === name);
  if (!cfg) {
    throw new Error(`未知供应商：${name}（可选：${PROVIDERS.map((p) => p.name).join("、")}）`);
  }
  if (!cfg.apiKey) {
    throw new Error(`${name} 的 key 是空的，检查 .env 里对应那一行`);
  }
  return { client: new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey }), model: cfg.model };
}
```

.env 里对应三行 `QWEN_API_KEY=...`、`DEEPSEEK_API_KEY=...`、`GLM_API_KEY=...`，键名和代码里 `process.env.` 后面那串一一对应，别串门。

关键在 `buildClient`：调用逻辑从此和「具体是哪家」彻底解耦，明天要接 Kimi、豆包，数组加一项就行。这就是配置表驱动的本意，变化的部分进表，不变的部分进代码。顺带留意两个 TS 细节：`find` 的返回类型带 undefined，紧跟一个 throw 才把口收窄，后面的 cfg 才不报警；表里 `?? ""` 把 undefined 抹平成 string，缺没缺 key 这件事，留给 buildClient 统一报。

命令行入口用 Node 自带的 parseArgs，一个依赖都不用装：

```ts
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { provider: { type: "string" } },
});
const providerName = values.provider ?? "deepseek";
```

parseArgs 的 strict 模式管「参数名认不认识」：`--provder` 拼错当场抛错。但「值合不合法」它不管，这个校验 buildClient 里那句 throw 已经顺手做了——`--provider foo` 会收到一份带全部可选项的报错，体验不差。

### 3. 同题对比：usage 是账本，成本自己算

Day 1 让你养成「拿到回复看一眼 usage」的反射，今天它升级成账本。计价公式一句话：

成本 = prompt_tokens ÷ 1,000,000 × 输入单价 + completion_tokens ÷ 1,000,000 × 输出单价

单价单位是「元 / 每百万 token」，各家控制台的价格页可查。量级感受先给一个，数字别背：国产标准档普遍输入每百万几毛到几块人民币，输出侧再乘个几倍；旗舰推理档整体再贵一档；多数家有免费或低价的入门档，跑实验够用。价格常调整，你的表格里永远填当天查到的数，并注明日期。

兼容协议在这里也帮了忙：usage 的字段各家返回完全一致，`resp.usage.prompt_tokens`、`resp.usage.completion_tokens` 照常读。字段名是照着 API 的 JSON 原样映射的，蛇形命名就蛇形命名，写成 promptTokens 编辑器直接标红，想手滑都难。

对比实验的铁律是固定变量：同一道题、temperature=0、同样的 max_tokens，只换供应商，否则结论没法复现。题目别随便找，选一道贴近你业务的基准题，比如一段代码 review、一次 JSON 抽取、一道多步应用题，固定下来。以后「听说 XX 又升级了」，跑一遍基准，几分钟出结论，这比任何测评博主都可信。

选型心智也一样，别背结论，搭框架。按任务分桶：复杂推理、长上下文、便宜跑量、中文创作，每桶一道基准题，让分数说话。维度除了质量和成本，还有延迟、上下文长度、工具调用稳定性。今天的对比表顺手把「耗时」也记上，一列的事。

## 动手任务：`multi-chat.ts` 一步一步

手册任务：把 Day 1 的 CLI 改造成支持 3 家模型热切换（只改 baseURL），做一张同题成本对比表。拆成 5 步，全程约 30 分钟（不含注册账号）。

**第 1 步：拿三把 key，定好环境。** 三家控制台各注册一个账号，开通模型服务，领新人额度或小额充值，各拿一把 key。接着把核心知识开头那套环境跑一遍：npm init、加 `"type": "module"`、装 openai 和 tsx——Day 1 的目录还在的话，openai 早装好了，补个 tsx 就行。建 .env 写三行，再确认 .gitignore 里有 .env。key 的长相各家不同，照控制台给的抄，前后别带空格。

**第 2 步：建 providers.ts，把配置落下来。** 新建 providers.ts，把核心知识第 2 节的 ProviderConfig、PROVIDERS、buildClient 整段抄进去。配置单独成文件是有意为之：接下去的 multi-chat.ts 和 bench.ts 都要 import 它，往后每加一个实验脚本，也直接复用这张表。

**第 3 步：移植 Day 1 的对话循环。** 新建 multi-chat.ts，Day 1 那两次 push 一行不改地搬过来，变的只有三处：client 和 model 从 buildClient 来、读输入换成 readline、多加一条 `/model` 命令：

```ts
import * as readline from "node:readline/promises";
import { parseArgs } from "node:util";
import type { ChatCompletionMessageParam } from "openai";
import { PROVIDERS, buildClient } from "./providers";

const { values } = parseArgs({
  options: { provider: { type: "string" } },
});
const providerName = values.provider ?? "deepseek";

let current = buildClient(providerName); // 原来的 client 和 MODEL 两行，换成这一行
console.log(`当前供应商：${providerName}（${current.model}）`);

const SYSTEM_PROMPT: ChatCompletionMessageParam = {
  role: "system",
  content: "你是一个简洁的中文技术助手，回答不超过三句话。",
};
let messages: ChatCompletionMessageParam[] = [SYSTEM_PROMPT];
let totalPrompt = 0;
let totalCompletion = 0;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => process.exit(0)); // Ctrl+C：readline 会吞信号，不监听就挂起
rl.on("close", () => process.exit(0)); // Ctrl+D / 输入流结束

console.log("multi-chat 已启动（exit 退出，reset 清空历史，/model <名字> 热切换）");

while (true) {
  const userInput = (await rl.question("\n你> ")).trim();
  if (!userInput) continue;
  if (userInput === "exit" || userInput === "quit") break;
  if (userInput === "reset") {
    messages = [SYSTEM_PROMPT]; // 只留 system，其余全丢
    console.log("（历史已清空）");
    continue;
  }
  if (userInput.startsWith("/model")) {
    const target = userInput.slice("/model".length).trim();
    if (!PROVIDERS.some((p) => p.name === target)) {
      console.log(`可用供应商：${PROVIDERS.map((p) => p.name).join("、")}`);
      continue;
    }
    current = buildClient(target); // 构造只是存配置，不发请求，随便换
    console.log(`已切换到 ${target}（${current.model}），历史保留，接着聊`);
    continue;
  }

  messages.push({ role: "user", content: userInput }); // 第一次 push

  const resp = await current.client.chat.completions.create({
    model: current.model,
    messages,
    temperature: 0.7,
    max_tokens: 500,
  });
  const reply = resp.choices[0].message.content ?? ""; // 类型是 string | null，收口
  messages.push({ role: "assistant", content: reply }); // 第二次 push

  const u = resp.usage;
  totalPrompt += u?.prompt_tokens ?? 0;
  totalCompletion += u?.completion_tokens ?? 0;
  console.log(`\n助手> ${reply}`);
  console.log(`[本轮 ${u?.prompt_tokens}+${u?.completion_tokens} | 累计 ${totalPrompt}+${totalCompletion} tokens]`);
}
```

几个 TS 特有的细节值得停一停。其一，Ctrl+C 在 readline 里默认杀不掉进程：readline 接管了终端信号，不注册 SIGINT 监听，按键就没反应，进程装死不退，开头两个 `rl.on` 就是补这个的。其二，`message.content` 的类型是 `string | null`，`?? ""` 把口收住，不然 null 混进历史，下一轮请求的类型检查当场翻脸。其三，`/model` 热切换只是重新调一次 buildClient——构造函数只存配置不发请求，切换零成本，而且 messages 原样保留：qwen 聊三轮，`/model deepseek`，新模型接得上上文。同一份历史喂给另一家照样能读，这才是兼容协议真正的含金量。

**第 4 步：三家各跑一遍。** 依次执行 `npx tsx --env-file=.env multi-chat.ts --provider qwen`，deepseek、glm 同理，各问同一个问题。再在同一场对话里输 `/model glm` 体会热切换。三家都能回话，今天的目标就通了。顺手体会一下：你改的只有命令行上那一个词。

**第 5 步：同题基准，填成本表。** 新建 bench.ts，固定一道题跑三家：

```ts
import { PROVIDERS, buildClient } from "./providers";

const QUESTION =
  "一家咖啡店原价 30 元一杯，成本 12 元。现在降价 20% 促销，" +
  "销量需要提升百分之多少才能保住原来的总利润？给出计算过程。";

for (const p of PROVIDERS) {
  const { client, model } = buildClient(p.name);
  const start = performance.now();
  const resp = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: QUESTION }],
    temperature: 0,
    max_tokens: 800,
  });
  const seconds = ((performance.now() - start) / 1000).toFixed(1);
  const u = resp.usage;
  console.log(`\n=== ${p.name} / ${model} === 耗时 ${seconds}s`);
  console.log(`输入 ${u?.prompt_tokens} tokens，输出 ${u?.completion_tokens} tokens`);
  console.log(resp.choices[0].message.content);
}
```

跑完把数据填进这张表，单价当天去各家价格页查：

| 供应商 | 模型 | 输入 tokens | 输出 tokens | 输入单价（元/百万） | 输出单价（元/百万） | 本次成本（元） | 耗时（秒） | 回答质量一句话 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

单次成本通常小到厘级，保留四位小数，别用科学计数法，看着直观。质量那列用自己的话写，算错了就是算错了。这道题本身就是选型基准题的雏形：有唯一正确答案，能分出推理高下。

::: tip 运行提示
Windows 控制台中文乱码先 `chcp 65001`，老话。`--env-file` 要 Node 20.6+，tsx 只是 node 的替身，参数最终归 node 认。跑基准前想清楚代理状态（见坑 3）。三家账号都值得注册一遍，新人额度跑完今天的实验绰绰有余。课后题：把各家单价也加进 ProviderConfig，bench.ts 跑完顺手把成本一列算出来——价格天天变，这题的意义就是体会「价格属于配置，不属于代码」。
:::

## 常见踩坑

**坑 1：baseURL 拼错，还怪 SDK。** SDK 会在 baseURL 后面自动拼接口路径，所以你只给到表里那个结尾为止。手贱多补一段路径，或者把末尾的 `/v1` 丢了，都会得到 404，报错信息还不太指向真相。排查顺序：先照抄表格原样跑通，再谈修改。

**坑 2：模型名过期或拼错。** 模型名不属于协议，是各家自己的目录，`qwen-plus` 写成 `qwenplus`，报错文案每家还不太一样。SDK 里 model 参数就是个 string，类型系统在这里帮不上忙，拼错要运行时才炸。养成习惯：接一家，先开控制台的模型列表页，复制粘贴，不手打。

**坑 3：代理环境变量设了，fetch 根本不认。** openai npm SDK 底层是 Node 18+ 的原生 fetch（undici），它默认不读 HTTP_PROXY、HTTPS_PROXY 这些环境变量。这事儿一正一反：好消息，今天打三家国产 API 压根不用代理，国内直连，终端里残留的代理变量也不会来捣乱；坏消息，哪天要打 OpenAI 官方，光设一个代理环境变量没用，请求照样直连然后超时。解法按版本分：Node 24 起设 `NODE_USE_ENV_PROXY=1`，fetch 就认代理变量了；更老的版本，去 openai 的 npm 包 README 搜 proxy，照官方给的法子配代理客户端。反过来咬人的场景也记一笔：公司内网强制走代理出网，SDK 不认环境变量，全部超时，第一反应查这里。

**坑 4：对比实验不固定变量。** 温度不同、题目不同、拿字符数当 token 数、只看输入单价不看输出单价，任何一条都能让结论作废。尤其记住输出单价通常是输入的好几倍：同样 token 数，生成多的那家不一定便宜。

**坑 5：背选型结论。** 「推理最强是 X、性价比之王是 Y」这类句子保质期以周计，模型迭代比教程更新快得多。该留下的是方法：固定的基准题、固定的公式、可复现的表。面试里「我怎么持续评估和切换模型」这套动作，比任何一句现成结论都值钱。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 换一家供应商，代码里最少要改几处？分别是什么？

::: details 参考答案
三处：baseURL、apiKey、model。各家兼容 OpenAI 协议，请求路径、消息结构、响应字段都不变，SDK 调用代码零修改。工程上把这三样放进配置表，新增供应商等于数组加一项。
:::

2. OpenAI 兼容协议，「兼容」的具体是哪些东西？

::: details 参考答案
HTTP 端点的路径规则、请求体结构（messages、temperature、max_tokens 等字段）、响应结构（choices、usage 等字段）。SDK 只认这套形状，不关心背后是谁家的模型，所以同一个 OpenAI 类能打所有提供兼容端点的厂商。
:::

3. 一次调用的成本怎么从 usage 算出来？

::: details 参考答案
prompt_tokens ÷ 1,000,000 × 输入单价，加 completion_tokens ÷ 1,000,000 × 输出单价。单价以各家控制台价格页当日为准，输出单价通常数倍于输入，两边必须分开算。
:::

4. 终端里明明设了 HTTP_PROXY，openai SDK 的请求却没走代理，为什么？

::: details 参考答案
SDK 底层是 Node 的原生 fetch（undici），默认不读 HTTP_PROXY、HTTPS_PROXY 环境变量。Node 24 起设 NODE_USE_ENV_PROXY=1 可以让它认；更老的版本按 openai npm 包 README 的 proxy 一节配代理客户端。反过来，打国产 API 不用代理，国内直连即可。
:::

5. 「复杂推理选谁、便宜跑量选谁」这种结论为什么不建议直接背？该怎么形成自己的版本？

::: details 参考答案
模型迭代快、价格常调整，任何结论都有保质期，还依赖具体任务。正确姿势：按任务分桶，每桶固定一道基准题，用今天的流程（同题、temperature=0、记 usage 和耗时、按公式算钱）定期复测，把结论当快照，不当真理。
:::

## 延伸阅读

- [阿里云百炼文档](https://help.aliyun.com/zh/model-studio/)，Qwen 系列的模型清单、OpenAI 兼容模式说明与价格页入口
- [DeepSeek 开放平台文档](https://api-docs.deepseek.com/)，接口说明与定价，中文直读
- [智谱开放平台](https://open.bigmodel.cn/)，GLM 系列的模型列表、价格与控制台入口
- [openai-node 仓库](https://github.com/openai/openai-node)，npm SDK 的源码与 README，baseURL、代理配置这些构造项的官方说法在这

今天的 `multi-chat.ts`、`providers.ts` 和那张成本表留好。后面不管学工具调用还是结构化输出，凡是想验证「换个模型行不行」，都拿它当横向测试台跑一遍；第 21 周给整个 Agent 群记成本账时，今天这张表就是方法论的第一页。
