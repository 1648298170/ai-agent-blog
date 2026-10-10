# 第 14 周 · Day 4：Embedding 基础——把语义变成向量，让相似度可以计算

> 对应手册任务：学习「Embedding：OpenAI / 开源模型」，动手用 OpenAI Embedding API 将切块转为向量，当日产出 Embedding 脚本。本篇只解决一个问题：昨天切好的块还是一串串字符串，计算机没法比较"哪两块语义更像"，今天把每个 chunk 变成高维空间里的一个点，语义远近从此变成一个可以计算的数字。

## 今日目标

1. 说得清 Embedding 是什么、"语义近的点距离也近"是什么意思，以及它和 ChatGPT 这类生成模型的本质区别（理解 vs 生成）
2. 掌握余弦相似度公式并亲手算一个小例子；会用 `text-embedding-3-small` 批量把切块转成向量，撞上限流会退避
3. 独立完成 Embedding 脚本，跑通"三句话两两算余弦"的小实验，亲眼看到语义相近的一对得分显著更高

## 概念讲解：为什么需要 Embedding

RAG 走到今天这步：文档解析完、切块完，几百个 chunk 躺在硬盘里。用户问"怎么把货款退回来"，你要从里面捞出讲退款的那几块。怎么办？

按字符串匹配？"退款流程"和"怎么把货款退回来"连一个共同关键词都没有，精确匹配直接歇菜。多写几条关键词规则？规则永远追不上问法的变化。卡在一个根本问题上：字符串只是字符序列，不携带语义，计算机没法从字符层面判断"这两句话说的是一回事"。

Embedding 就是来解决这个的。它是一个模型，吃进一段文本，吐出一个定长向量，比如 1536 个浮点数。你可以把这串数看成 1536 维空间里的一个点。模型的训练目标只有一条：语义相近的文本，映射之后落点也要相近。于是"这两段话像不像"变成了"这两个点近不近"，而距离是数学问题，随你怎么算。

它和 ChatGPT 这类生成模型是两个物种。生成模型文本进、文本出，会"说话"；Embedding 模型文本进、向量出，只"打分"。一个负责理解和表示语义，一个负责生成新内容。Day 1 画的 RAG 流程图里两者各管一段：Embedding 负责从资料堆里找到相关内容，生成模型负责把找到的内容组织成人话。今天只造前半截。

"语义变成几何"不是玄学，有经典实验为证。词向量时代最出名的一组算术：king - man + woman ≈ queen。国王的向量减去男人的向量，加上女人的向量，落点就在女王附近。也就是说，"性别"这个语义关系在空间里是一条稳定的方向，"王室"是另一条。文本 Embedding 继承的正是这个性质，只是粒度从单词变成了整段文字。方向和距离承载语义，这是整套向量检索的地基。

## 核心知识

本节的代码块都是可运行的独立片段，设好 `OPENAI_API_KEY` 环境变量就能跑。最终完整脚本以下面的动手任务为准。

### 1. 余弦相似度：怎么算"近"

两个点靠得近不近，为什么不用中学学的直线距离（欧氏距离）？因为文本向量里方向才是语义，模长主要是文本长度等因素的干扰。业界标准是余弦相似度：算两个向量夹角的余弦值，只看方向，不管长短。公式：

```text
cos(θ) = (A·B) / (|A| × |B|) = (Σ aᵢbᵢ) / (√(Σ aᵢ²) × √(Σ bᵢ²))
```

分子是点积，对应位置相乘再求和；分母是两个向量各自的模长。值域 [-1, 1]，越接近 1 方向越一致、语义越像。

手算一遍。真实向量是 1536 维，但算法用 2 维就能算明白。假设三个词的向量是：猫 [0.9, 0.1]，狗 [0.8, 0.2]，汽车 [0.1, 0.9]。

```text
猫 vs 狗：
点积 = 0.9×0.8 + 0.1×0.2 = 0.72 + 0.02 = 0.74
|猫|  = √(0.9² + 0.1²) = √0.82 ≈ 0.906
|狗|  = √(0.8² + 0.2²) = √0.68 ≈ 0.825
cos  = 0.74 ÷ (0.906 × 0.825) ≈ 0.99

猫 vs 汽车：
点积 = 0.9×0.1 + 0.1×0.9 = 0.09 + 0.09 = 0.18
|汽车| = √(0.1² + 0.9²) = √0.82 ≈ 0.906
cos  = 0.18 ÷ (0.906 × 0.906) ≈ 0.22
```

同为动物的猫狗拿到 0.99，跨类别的猫和汽车只有 0.22，语义远近被数字如实记下。1536 维的计算和这两段手算完全同构，只是加的项从 2 个变成 1536 个，交给代码。

### 2. API 实操：单次调用、批量与退避

```ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const res = await client.embeddings.create({
  model: "text-embedding-3-small",
  input: ["如何申请退款", "今天天气不错"], // input 是数组，天然支持批量
});

console.log(res.data[0].embedding.length); // 1536
console.log(res.data[0].embedding.slice(0, 3)); // 前三维，比如 [0.012, -0.034, 0.008]
```

关键在 `input` 传数组：一次请求就能把一批 chunk 全部转掉，不用一条条调用。`res.data` 与输入数组按 `index` 字段一一对应（坑 1 细说）。`text-embedding-3-small` 默认输出 1536 维，价格每百万 token 0.02 美元，把整本《红楼梦》向量化一遍也就几美分，真正意义上的白菜价。还有个更强的 `text-embedding-3-large`，3072 维、贵几倍，入门阶段 small 完全够用。两个硬限制记住就行：单条输入最长 8191 token，一次请求最多 2048 条。

几百上千个 chunk 一股脑塞一个请求，迟早撞限流收到 HTTP 429。第 13 周调 LLM 时写过的指数退避，思想原样搬过来：撞上 429 等 1 秒重试，再撞等 2 秒、4 秒，指数拉长，同时设重试上限。

```ts
async function withBackoff<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const retryable = err?.status === 429 || (err?.status ?? 0) >= 500;
      if (!retryable || attempt >= maxRetries) throw err;
      const waitMs = Math.min(1000 * 2 ** attempt, 30_000);
      console.warn(`限流或服务端错误，${waitMs}ms 后做第 ${attempt + 1} 次重试`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
```

关键在 `1000 * 2 ** attempt`：第 1 次等 1 秒、第 2 次 2 秒、第 3 次 4 秒，封顶 30 秒。只有 429 和 5xx 值得重试，401（密钥错）、400（参数错）重试一百次也没用，直接抛出去。

批量主循环把两者串起来：

```ts
const BATCH_SIZE = 64; // 远低于 2048 上限，给限流留余量

async function embedChunks(chunks: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const res = await withBackoff(() =>
      client.embeddings.create({ model: "text-embedding-3-small", input: batch })
    );
    const ordered = res.data.slice().sort((a, b) => a.index - b.index); // 按 index 对位输入
    vectors.push(...ordered.map((d) => d.embedding));
    console.log(`向量化进度：${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }
  return vectors;
}
```

关键在 `sort((a, b) => a.index - b.index)`：返回的每个对象都带 `index` 字段标明对应输入第几条，按它排一次序，向量与 chunk 的对应关系就是铁的。

### 3. 国产兼容端点、降维与开源自托管

不想用 OpenAI，国产模型基本都提供 OpenAI 兼容端点。第 11 周 Day 6 那套"换 `baseURL` 就接"的思路原样适用，比如通义 `text-embedding-v3`：

```ts
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", // 通义的 OpenAI 兼容模式
});

const res = await client.embeddings.create({
  model: "text-embedding-v3",
  input: ["如何申请退款", "今天天气不错"],
});
```

智谱 GLM 的 `embedding-3` 同理，换对应的兼容端点和模型名就行，SDK 一行不改，这就是兼容端点的价值。但切记：不同模型的向量空间互不兼容，换模型等于全量重算、全量重存。

维度是可以调的。`text-embedding-3` 系列支持 `dimensions` 参数，指定 `dimensions: 512`，返回的向量就从默认 1536 维降到 512 维，存储和计算量同比缩小，精度掉一点。这套模型用套娃式的训练方式（官方叫 Matryoshka representation learning）保证了前若干维就承载主要语义，砍掉尾部维度不至于崩坏。数据量小（几万条以内）就别降，省不了几个钱；上千万条向量时再算这笔账。

最后一句留给开源自托管：数据不能出域的场景，用 BAAI 的 `bge-m3` 配 `sentence-transformers` 自己起一个，中文效果不差，代价是 GPU 和运维都得自己扛。

## 动手任务：`embed_chunks.ts` 一步一步

手册任务：用 OpenAI Embedding API 将切块转为向量。拆成 5 步，全程约 25 分钟。

**第 1 步：建文件。** 在本周的练习目录执行 `npm install openai`（没初始化过就先 `npm init -y`），新建 `embed_chunks.ts`，环境变量 `OPENAI_API_KEY` 设好。下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：先跑小实验，三句话两两算余弦。** 大批量之前，先用三句话亲眼验证"语义近分数高"是真的。加余弦函数和实验代码：

```ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const sentences = [
  "如何申请退款？",
  "退款一般多久到账？",
  "今天天气适合爬山吗？",
];

const res = await client.embeddings.create({
  model: "text-embedding-3-small",
  input: sentences,
});
const [s1, s2, s3] = res.data.map((d) => d.embedding);

console.log("退款 vs 到账：", cosineSimilarity(s1, s2)); // 预期显著更高
console.log("退款 vs 天气：", cosineSimilarity(s1, s3));
console.log("到账 vs 天气：", cosineSimilarity(s2, s3));
```

`cosineSimilarity` 就是第 1 节手算公式的直译：分子点积，分母模长相乘。具体分数我不替你预报，同一模型对同一输入的输出是稳定的，你跑出来什么就是什么。判定标准只有一条：前一对（都在聊退款）应显著高于后两对（一方在聊天气）。要是前一对反而垫底，先检查代码，再怀疑人生。

**第 3 步：读入切块。** Day 3 的切块模块如果已把结果存成 `chunks.json`（字符串数组），直接读：

```ts
import { readFileSync, writeFileSync } from "node:fs";

const chunks: string[] = JSON
  .parse(readFileSync("chunks.json", "utf-8"))
  .filter((c: string) => c.trim().length > 0); // 顺手滤掉空块，空串会被 API 拒
```

还没有现成的切块产物，就先把 `sentences` 那三句当 `chunks` 用，跑通流程要紧，明天再回来接真数据。

**第 4 步：批量向量化。** 把第 2 节的 `withBackoff` 和 `embedChunks` 原样搬进文件，末尾调用：

```ts
const vectors = await embedChunks(chunks);
console.log(`完成，共 ${vectors.length} 条向量，每条 ${vectors[0].length} 维`);
```

**第 5 步：落盘。** 向量算完必须存下来，模型名和维度跟着一起写进去：

```ts
writeFileSync(
  "vectors.json",
  JSON.stringify({ model: "text-embedding-3-small", dim: 1536, chunks, vectors }, null, 2)
);
```

模型名和维度是 Day 5 存进 pgvector 时要校验的信息，现在记下，将来省一次"对不上"的排查。

::: tip 运行命令
执行 `npx tsx embed_chunks.ts`，没装 tsx 就先 `npm install -D tsx`。想只跑三句话小实验，把第 3 步注释掉、`chunks` 换成 `sentences` 即可。打印向量只打 `slice(0, 3)`，全打会刷屏。
:::

## 常见踩坑

**坑 1：不按 index 对位，向量张冠李戴。** `res.data` 里每个对象都带 `index` 字段，标明它对应输入数组第几条。通常按顺序返回，但依赖"通常"就是埋雷：一旦某批错位，向量算的是 A 句、存的是 B 句的位置，检索结果莫名错乱，查一晚上都未必想到这里。`sort((a, b) => a.index - b.index)` 一行代码的保险，别省。

**坑 2：混用不同模型的向量。** 同一句"退款"，在 `text-embedding-3-small` 的空间里和在 `text-embedding-v3` 的空间里是两个不相干的点，跨空间算余弦相似度，得到的数字没有意义。库里存的是哪个模型产的向量，查询就必须用同一个模型。换模型等于全量重算。

**坑 3：单条超 8191 token。** 每条输入超过这个数直接报错，不会自动截断。Day 3 把切块长度控制在几百 token，正是在给今天铺路。手头真有超长块，入库前按长度再切一刀，别指望 API 兜底。

**坑 4：把 429 当事故。** 限流是调 API 的日常，不是你写错了什么。退避要写，上限也要有：连续 5 次失败就抛出来让人处理。无限重试的脚本跑夜间批处理，能把配额烧干还不停手。

**坑 5：降维降得太早。** `dimensions: 512` 看着省，几百条数据省下的是几厘钱，换来的是精度略降加一样新心智负担（库里维度不统一就完蛋）。数据量没到上千万条，统一维度比省那点存储重要得多。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Embedding 模型和 ChatGPT 这类生成模型，输入输出各是什么？在 RAG 里各负责什么？

::: details 参考答案
生成模型文本进、文本出，负责生成内容；Embedding 模型文本进、向量出，负责理解和表示语义。RAG 里 Embedding 负责"找"（把问题和相关切块向量化、算相似度），生成模型负责"答"（把找到的内容组织成回答）。一个理解，一个生成，互补而不替代。
:::

2. 余弦相似度公式是什么？值域多少？为什么不直接用欧氏距离？

::: details 参考答案
两个向量的点积除以两者模长的乘积，值域 [-1, 1]，越接近 1 方向越一致。文本向量的语义编码在方向上，模长受文本长度等因素干扰，余弦只比方向不管长度，所以它是标准做法。
:::

3. 一次请求传入 100 条 chunk，返回结果怎么和输入一一对上？

::: details 参考答案
`res.data` 的每个对象带 `index` 字段，指示它对应输入数组的下标。稳妥做法是按 `index` 升序排序后再依次取 `embedding`，这样第 i 个向量一定对应第 i 条输入。
:::

4. `dimensions` 参数什么时候值得用？代价是什么？

::: details 参考答案
数据量大到存储和计算成本值得关注时（比如上千万条向量）用它降维，存储与计算随维度同比下降，精度略降。降维后的向量和原维度向量不可比较，全库必须统一维度；数据量小时省的钱忽略不计，不值得引入这层复杂度。
:::

5. 什么情况下应该放弃 API，改用 `bge-m3` 之类的自托管方案？

::: details 参考答案
首先是数据合规：文本不允许出域（内网、隐私、保密要求）时必须自托管。其次是调用量大到 API 计费反超 GPU 自维护成本。两种情况之外，API 更省心，效果也够用。
:::

## 延伸阅读

- [OpenAI：Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)，模型能力、定价、限制的官方出处，用例和常见问题都在里面
- [阿里云百炼模型文档](https://help.aliyun.com/zh/model-studio/)，通义 `text-embedding-v3` 的接入说明，站内搜"文本向量"即可找到
- [BAAI/bge-m3（Hugging Face）](https://huggingface.co/BAAI/bge-m3)，开源自托管的头号候选，模型卡里有 sentence-transformers 的调用示例

今天的产出 `embed_chunks.ts` 和 `vectors.json` 留好，Day 5 打开 PostgreSQL 的 pgvector 扩展，把向量存进 `documents` 表，Day 6 的检索函数就靠今天这个余弦相似度从里面捞 Top-K。
