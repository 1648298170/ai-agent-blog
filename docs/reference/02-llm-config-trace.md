# 02 · 内核三辅助：模型工厂 / 配置柜 / 行车记录仪

> 一句话：`agent-loop` 是引擎的心脏，本篇的四个小文件是它的**后勤部队**——
> llm.ts 造模型（供电）、config.ts 管钥匙（供电前的钥匙柜）、trace.ts 记录每一步（行车记录仪）、
> json-utils.ts 给"模型吐 JSON 不守约"兜底（一条踩坑教训的产物）。单文件都不足 120 行，
> 但每一行都回答一个工程问题。

---

## 它解决什么问题

上一篇的循环骨架里，有很多"凭空出现"的东西：

```text
runToolLoop({ model, messages, tools, ... })
              ↑           ↑          ↑
        这个 model 谁造的？           工具结果模型怎么"看到"的？
              ↑
   API key / baseURL / 模型名从哪来？换厂商要改几处代码？
```

拆成四个具体问题，对应四个文件：

| 问题 | 文件 | 一句话答案 |
|---|---|---|
| 模型实例从哪来？换厂商疼不疼？ | `src/llm.ts` | 工厂函数包一层，三家网关都是 OpenAI 兼容协议，**换厂商 = 只改 env** |
| key / 网关地址 / 存储开关谁管？ | `src/config.ts` | 手动解析 .env + 类型化出口，业务代码**永不直接碰 `process.env`** |
| Agent 黑盒怎么调？ | `src/trace.ts` | 一个 `trace(icon, msg)` 函数，图标约定打到 stderr |
| 模型不守 JSON 约定怎么办？ | `src/json-utils.ts` | 宽松抽取 + 失败抛带原文的中文错误（glm-4-flash 踩坑的解法） |

---

## 核心概念（5 分钟版）

### ① 模型工厂：OpenAI 协议是"通用插座"

`@ai-sdk/openai` 的 `createOpenAI({ apiKey, baseURL })` 可以挂**任何 OpenAI 兼容网关**。
本项目默认接智谱 GLM（`https://open.bigmodel.cn/api/paas/v4`），但 DeepSeek、通义千问
的兼容模式端点也是同一个协议形状——所以"换厂商"只是换三个环境变量：

| 厂商 | baseURL | 聊天模型示例 | embedding 模型 |
| --- | --- | --- | --- |
| 智谱 GLM（默认） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `embedding-3` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | ❌ 无 embeddings 接口 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `text-embedding-v3` |

> 选型核心：**"都兼容 OpenAI 协议"是零代码换厂商的前提**。业务代码只认
> `LanguageModelV2` 这个接口，根本不知道背后是哪家网关。

**懒创建**是另一个关键设计：`createModel()` 缺 apiKey 时**不抛错**——provider 的校验
发生在真正发起请求那一刻。于是 chat REPL 可以在没配 key 的机器上正常启动，
等你发第一句消息才给清晰的中文提示（而不是一启动就崩）。

### ② 配置柜：白名单 + 环境变量优先 + 类型化出口

config.ts 只有 ~110 行，却立了三条规矩：

1. **ENV_KEYS 白名单**（`src/config.ts:24`）：只有清单里的 11 个键会被读——
   进程环境里其他键一概不碰，注入面收到最小
2. **进程环境变量优先于 .env 文件**（`src/config.ts:96`）：测试/CI 想覆盖某个键，
   设个临时环境变量就行，不用改 .env
3. **getConfig() 返回类型化的 AppConfig**：业务代码拿到的永远是
   `{ apiKey, baseURL, model, embeddingModel }` 四件套，拼写错误在编译期就炸

### ③ 行车记录仪：一个函数 + 一套图标

`trace(icon, message)` 未开启时一行布尔判断直接返回（热路径零负担）；开启后写到
**stderr 而不是 stdout**——stdout 留给数据流（管道、重定向不被轨迹污染），
控制台上两者都可见。

### ④ json-utils：一条踩坑教训的产物

见下文代码走读的"踩坑故事"。

---

## 代码走读（四个文件，按被依赖顺序）

### 1. `src/config.ts`（112 行）—— 一切的地基

| 位置 | 内容 | 要点 |
|---|---|---|
| `AppConfig`（L11） | 类型化配置接口 | apiKey / baseURL / model / embeddingModel 四件套 |
| `ENV_KEYS`（L24） | 环境变量白名单 | LLM 网关四件套 + 持久化基座开关（`*_STORE` / 连接串 / 维度）|
| `parseEnvFile`（L45） | 手动解析 .env | 只认 `KEY=VALUE`，`#` 注释，成对引号剥掉；文件不存在返回空表**不抛错** |
| `findEnvDir`（L71） | 逐级向上找 .env | 从 cwd 和模块目录两路起找——换个目录启动也能定位到项目根 |
| `loadEnv`（L85） | 合并文件与进程 env | 先找到的 .env 生效；**进程环境变量覆盖 .env**（只读白名单键） |
| `getConfig`（L104） | 类型化出口 | 默认值兜底：GLM 网关 + `glm-4-flash` + `embedding-3` |

合并逻辑的骨架（`src/config.ts:85`）：

```ts
export function loadEnv(): Record<string, string> {
  const candidates = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  let fileVars: Record<string, string> = {};
  for (const start of candidates) {
    const dir = findEnvDir(start);
    if (dir) { fileVars = parseEnvFile(dir); break; }   // 先找到的 .env 生效
  }
  const merged = { ...fileVars };
  for (const key of ENV_KEYS) {                          // 白名单：清单外的键不读
    const v = process.env[key];
    if (v !== undefined && v !== "") merged[key] = v;    // 进程环境变量优先
  }
  return merged;
}
```

> **为什么不引 dotenv**：少一个依赖，实现全透明可读（~60 行），而且两路向上查找
> 是 dotenv 给不了的 monorepo 实战需求——`node apps/api/dist/main.js` 换个目录
> 启动也能找到项目根的 .env（否则空 key 打网关直接 401，这是真实踩过的坑）。

### 2. `src/llm.ts`（40 行）—— 模型工厂

| 位置 | 内容 | 要点 |
|---|---|---|
| `createModel(modelId?)`（L14） | 造一个 chat 模型 | `createOpenAI({ apiKey, baseURL })` → `openai.chat(modelId ?? model)`；可传 modelId 做大小模型分工 |
| `getModel()`（L24） | 默认 chat 模型单例 | `cachedModel ??= createModel()`，环境变量一次读定 |
| `createEmbeddingModel`（L30） | 造 embedding 模型（内部函数） | 入库与检索必须同一个模型，混用则向量坐标系不同 |
| `getEmbeddingModel()`（L37） | embedding 模型单例 | 默认 `embedding-3`（2048 维），RAG 零件全靠它 |

```ts
export function createModel(modelId?: string): LanguageModelV2 {
  const { apiKey, baseURL, model } = getConfig();
  const openai = createOpenAI({ apiKey, baseURL });      // OpenAI 兼容插座
  return openai.chat(modelId ?? model);                  // 缺 key 不在此抛错（懒创建）
}

export function getModel(): LanguageModelV2 {
  cachedModel ??= createModel();                         // 进程内单例
  return cachedModel;
}
```

### 3. `src/trace.ts`（51 行）—— 行车记录仪

| 位置 | 内容 | 要点 |
|---|---|---|
| `isTraceEnabled()`（L13） | 开关判定 | `AGENT_TRACE` 为 `"1"` 或 `"true"` 才开 |
| `enableTrace()`（L19） | 强制开启 | CLI 的 `--trace` 参数走这里（改 env 再判定） |
| `preview(value, max=200)`（L28） | 长值截断预览 | 轨迹是给人扫读的：字符串原样、对象 JSON 化、超长截断并标注总长 |
| `trace(icon, message)`（L48） | 打一条轨迹 | 未开启直接 return；开启写 **stderr** |

```ts
export function trace(icon: string, message: string): void {
  if (!isTraceEnabled()) return;                         // 热路径：一行布尔判断
  process.stderr.write(`${icon} ${message}\n`);          // stdout 保持干净
}
```

全项目共用的图标约定（`src/trace.ts:45` 注释 + 各消费方）：

| 图标 | 含义 | 谁在打 |
|---|---|---|
| ▶ | 思考（调用模型） | agent-loop |
| ⚙ | 行动（要调工具） | agent-loop |
| ✓ / ✗ | 观察（工具返回 / 失败） | agent-loop |
| ◆ | 完成（最终回答） | agent-loop |
| 🧭 | 路由判定 | service/supervisor |
| 🔎 | 检索命中 | rag |
| 🧠 | 记忆压缩事件 | memory/compression |

### 4. `src/json-utils.ts`（22 行）—— 踩坑故事的产品

**踩坑背景**：客服路由的三分类最初走 `generateObject`（依赖网关的
`response_format` 结构化输出）。实测 **glm-4-flash 会静默无视这个指令**——模型照常
闲聊回复，SDK 的 JSON 解析直接炸，而且炸得毫无线索（"静默失败"比报错更可怕）。

**解法**（换任何 OpenAI 兼容网关行为一致）：

```text
generateText + prompt 里写严格 JSON 指令
   → 拿到文本后 extractJson 宽松抽取（容忍 ```json 围栏与前后废话）
   → zod schema 校验（不合规自动重试一次）
```

抽取逻辑本体（`src/json-utils.ts:12`）：

```ts
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");                    // 首个 {
  const end = trimmed.lastIndexOf("}");                  // 最后一个 }
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`模型未按 JSON 约定回复，无法解析。原文摘录：${trimmed.slice(0, 120)}`);
  }
}
```

现役消费方：`src/service/supervisor.ts:122`（三分类 `routeSchema.parse(extractJson(text))`）
与 `src/evals/scorers/judge.ts:105`（裁判模型打分的宽松解析）。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
pnpm chat            # ① 故意不配 .env：照样能启动（懒创建）
```

随便发一句话，看到的不是崩溃而是清晰指引（apps/cli/src/apps/chat/cli.ts 的
`explainModelCallFailure`）：

```text
助手> 调用模型失败。请检查 .env 是否已按 .env.example 配置：
       OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（无 .env 时默认走智谱 GLM 网关）
```

配好 key 再来：

```powershell
pnpm chat --trace    # ② CLI 传参开轨迹
```

输入「订单A-1024到哪了」，stderr 上就会流出 ▶⚙✓◆ 四段轨迹（见上一篇）。
方式二是环境变量（HTTP API 服务端日志同样生效）：

```powershell
$env:AGENT_TRACE = "1"; pnpm service    # ③ env 方式开启
Remove-Item Env:AGENT_TRACE             # 用完关掉
```

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么手动解析 .env 而不引 dotenv？ | 少一个依赖、~60 行全透明；两路向上查找是 monorepo 刚需（换目录启动不丢 .env）。教学项目里"看得见"本身就是价值 |
| 为什么要 ENV_KEYS 白名单？ | 缩小注入面：进程环境里可能有几十个无关变量（CI 注入的 secret、路径……），只读清单内的 11 个键，其余一概不碰 |
| 为什么模型单例缓存（`??=`）？ | 环境变量进程内不变，每次调用重新 createOpenAI 没有意义；单例还保证"一次读定"——不会出现同一进程里两个行为不一致的模型实例 |
| 为什么轨迹打 stderr？ | stdout 是数据流：管道/重定向给下游程序用时不被轨迹污染；终端上两者都可见，人眼零损失 |
| 为什么不用 generateObject 一劳永逸？ | 实测 glm-4-flash 静默无视 response_format。`generateText + 宽松抽取 + zod 校验`在任何 OpenAI 兼容网关上行为一致——把不可靠的协议依赖换成自己可控的解析纪律 |
| extractJson 为什么取"首个 { 到最后一个 }"？ | 模型爱加围栏（```json）和前后客套话。首尾截取是最宽容的启发式；代价是嵌套多对象时会截到废话——所以截完必须 zod 校验兜底 |

---

## 自测题（先凭记忆答，再看文末答案）

1. 不配 API key 直接 `pnpm chat` 会怎样？这个行为是靠哪个设计决策实现的？
2. `OPENAI_BASE_URL` 写在 .env 里和设成进程环境变量，谁的优先级高？这个机制还顺带收获了什么好处？
3. `trace()` 为什么写 stderr 而不是 console.log（stdout）？

<details><summary>答案</summary>

1. 正常启动、进入 REPL；发第一句消息时才打印中文配置指引。靠的是**懒创建**：
   `createModel()` 不校验 apiKey（`src/llm.ts:14` 注释），provider 校验推迟到真正发请求那一刻。
2. 进程环境变量优先（`src/config.ts:96` 的合并循环）。好处：测试/CI 想覆盖某个键，
   设临时环境变量即可，不必改 .env 文件——且只有 ENV_KEYS 白名单里的键会被读。
3. stdout 保持为干净的数据流（管道、重定向、SSE 输出不被轨迹污染）；stderr 在终端
   上同样可见，观察无损失。轨迹是"给人看的"，数据是"给程序用的"，两条通道分流。

</details>

---

## 延伸阅读

- [01-agent-loop.md](./01-agent-loop.md) —— 循环本体；本篇四个文件都是它的后勤
- [03-tools.md](./03-tools.md) —— 工具表怎么注册、幂等壳怎么叠加在 execute 外面
- [04-memory.md](./04-memory.md) —— 会话存储的 env 工厂正是 config 白名单键的消费方
- [ARCHITECTURE.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/ARCHITECTURE.md) ——「一条消息的完整旅程」+ 六条踩坑实录（含 generateObject 静默失败那条）
- `docs/archive/weeks/week11/agent-loop-ts.md` —— 教程主线的循环深入篇（`npm run docs:dev` 起博客看）
