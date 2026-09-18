# 主线补篇 · RAG TS 全链路：纯 TypeScript 实现知识库问答

> 主线补篇：第 14、15 周用 Python 把 RAG 从概念跑到了评估，本篇把整条链路搬到 TypeScript。只用 openai 官方 SDK、postgres.js 驱动和 pgvector，不用 LangChain，不写一行 Python，产出一条完整链路：PDF 进、切块、向量化入库、余弦检索、带 [1][2] 引用的流式回答。概念部分（为什么切块、为什么要重排）站内 [第 14 周](/week14/)、[第 15 周](/week15/) 教过，本篇不重复，只解决一个问题：同样的东西，换成 TS 怎么落地。

## 本篇目标

1. 用纯 TS 写出「段落 + 长度」递归切块，含 overlap，约 30 行，与第 14 周的递归切块概念一一对上
2. 跑通 openai SDK 的 embeddings 批量调用、pgvector 建表入库、`<=>` 余弦检索，封装出可复用的 `search(query, k)`
3. 把检索结果拼进 prompt，流式输出答案并标注 [1][2] 引用，再把第 15 周的混合检索、Rerank、评估集三件质量抓手接到 TS 链路上

## 为什么用 TS 再写一遍

第 14、15 周把 RAG 从 pipeline 走到评估，工具链全是 Python：pypdf、SQLAlchemy、OpenAI SDK。主线栈是 Node + TypeScript 的话，那套代码看完还是落不了地，总不能为知识库专门养一条 Python 支线。

好消息是这条链路在 TS 侧没有缺件。openai 官方 SDK 的 embeddings 和流式 chat 都是一等公民；postgres.js 驱动直连 PG，标签模板天然参数化，配 pgvector 扩展就是一台向量数据库；文档提取有 pdf-parse。坏消息是生态里没有 LangChain 这种一行 `invoke` 的封装，每个环节都得自己写。这不是损失，第 11 周 Day 1 的道理原样成立：框架帮你封装的前提，是你知道它封装了什么。切块、向量化、检索、拼 prompt，四件事亲手写过一遍，Hybrid 和 Rerank 才有落点。

所以本篇的定位是第 14、15 周的 TS 对照实现：概念去那边看，代码在这边抄。

## 依赖与准备（全部 TS 生态）

先建项目、装依赖。三个运行时依赖，各管一段：

```powershell
mkdir rag-ts; cd rag-ts
npm init -y
npm pkg set type=module
npm i openai postgres pdf-parse
npm i -D typescript tsx @types/node
```

- **openai**：embedding 和 chat 都用它，v4 SDK 原生支持流式与批量 embedding
- **postgres**：postgres.js 驱动，直连 PG，参数化查询写在模板字符串里
- **pdf-parse**：从 PDF 提取纯文本，对应第 14 周 Day 2 的 pypdf

tsconfig 只留必要的几项，跑脚本用 tsx，省掉编译环节：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  }
}
```

pdf-parse 两个坑提前排掉：没带类型声明；ESM 下从包入口引入会误触发自检代码（去读测试文件），要从 lib 子路径引。补一个声明文件解决：

```ts
// pdf-parse.d.ts
declare module "pdf-parse/lib/pdf-parse.js" {
  export default function pdf(
    data: Buffer,
  ): Promise<{ text: string; numpages: number }>;
}
```

数据库侧，pgvector 的安装和启用与 [第 14 周 Day 5](/week14/day5) 完全相同，建库后执行一次：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

key 走环境变量，和第 11 周 Day 1 同一规矩：`$env:OPENAI_API_KEY="sk-..."`。连接串后面代码里有默认值，可用 `DATABASE_URL` 覆盖。

::: tip 运行提示
chat 侧想换国内厂商，照第 11 周 Day 1 的办法传 `baseURL` 即可。embedding 侧用的 text-embedding-3 系列，走兼容网关时模型名以网关文档为准，本篇按官方 API 写。
:::

## 第一步：切块

为什么先切块：检索的最小单位不是文档，是块。整篇 PDF 压成一个向量，语义被平均掉，检索精度当场崩掉；块太大，一个向量里混多个主题，命中也稀释；块太小，上下文碎，答案拼不起来。[第 14 周 Day 3](/week14/day3) 给过策略对照，结论是递归切块最稳：先按自然边界切，切不动的再往下一层。中文文档最自然的边界是空行分段，其次句号分句，代码把这两层写完就够了。

```ts
// chunk.ts —— 递归切块：先按段落，超长段落再按句子，块间留 overlap
const MAX_LEN = 500; // 每块字符上限，第 14 周 Day 3 给的起点值
const OVERLAP = 80;  // 相邻块重叠字符，约 15%，防止答案断在切口上

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function splitLongParagraph(para: string): string[] {
  const sentences = para.split(/(?<=[。！？.!?])\s*/); // 按句末标点分句
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && (buf + s).length > MAX_LEN) {
      out.push(buf);
      buf = buf.slice(-OVERLAP) + s; // 上一块尾巴接到下一块开头
    } else {
      buf += s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (const para of splitParagraphs(text)) {
    if (para.length <= MAX_LEN) chunks.push(para);
    else chunks.push(...splitLongParagraph(para));
  }
  return chunks;
}
```

三个设计点。overlap 的意义：一个完整句子横跨切口时，前块尾部和后块开头各保留一份，两边都能被检索到。单句超上限时不拦腰切断，宁可这一块长一点，保住句子完整。`MAX_LEN` 和 `OVERLAP` 不要拍脑袋定死，[第 15 周 Day 5](/week15/day5) 的评估方法就是干这个的：改一次参数，跑一轮 Hit@3，让数字替你吵。

## 第二步：Embedding

切块之后是向量化：把每块文本压成一个语义坐标，坐标相近的块意思相近。调用本身一行，真正要写对的是批量。

```ts
// embed.ts —— 批量向量化，维数 1536
import OpenAI from "openai";

const client = new OpenAI(); // 自动读 OPENAI_API_KEY
export const EMBED_MODEL = "text-embedding-3-small"; // 原生 1536 维

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const resp = await client.embeddings.create({
      model: EMBED_MODEL,
      input: texts.slice(i, i + BATCH),
    });
    // API 按 index 标注顺序，排一下再收，保证与输入对齐
    vectors.push(
      ...resp.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
    );
  }
  return vectors;
}
```

两件事别做反。一是一块一个请求：几百块就是几百次 HTTP 往返，embeddings 接口天生支持批量，一次几十条是正确姿势。二是排序那行别省：批量响应里每条带 index，理论上与输入同序，但显式按 index 排一次再收，向量与切块的对应关系才敢拿来当数组下标用。

维度要对齐：text-embedding-3-small 原生输出 1536 维，和下一步建表的 `vector(1536)` 严丝合缝。想换 3-large 就得动两处：表列改 `vector(3072)`，或者在 create 时传 `dimensions: 1536` 让它降维输出。单方面改任何一边，插入直接报错。

## 第三步：pgvector 入库

建表用 SQL 写在代码外，跑一次就行：

```sql
CREATE TABLE IF NOT EXISTS documents (
  id        bigserial PRIMARY KEY,
  content   text        NOT NULL,  -- 切块文本
  source    text        NOT NULL,  -- 来源文件名，第五步引用标注要用
  embedding vector(1536)
);
```

Python 侧当年配了 SQLAlchemy。TS 侧的取舍是干脆不用 ORM：postgres.js 的标签模板把参数化做成了语法本身，`` sql`INSERT ... VALUES (${x}, ${y})` `` 里的每个插值自动变占位参数，注入这条路从写法上就堵死；一张表的增删查，再垫实体映射纯属多余，直接 SQL 更顺手。

```ts
// ingest.ts —— 切块、向量化、入库一条龙
import postgres from "postgres";
import { chunkText } from "./chunk.js";
import { embedBatch } from "./embed.js";

export const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/ragts",
);

export async function ingest(text: string, source: string): Promise<number> {
  const chunks = chunkText(text);
  const vectors = await embedBatch(chunks);
  for (let i = 0; i < chunks.length; i++) {
    const vec = `[${vectors[i].join(",")}]`;
    await sql`
      INSERT INTO documents (content, source, embedding)
      VALUES (${chunks[i]}, ${source}, ${vec}::vector)
    `;
  }
  return chunks.length;
}
```

值得看的是 `::vector` 这一行：vector 的字面量就是 `[0.1,0.2,...]` 文本形式，数组 join 成字符串、当参数传入再显式转型，是 postgres.js 侧最省事的走法。几百块逐条插秒级完事，十万级再考虑多行 VALUES。

::: tip 什么时候要索引
几百条规模，顺序扫毫秒级返回，别折腾。块数上万、检索变慢了，再补一句 `CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);`，HNSW 索引会让检索从精确变近似，换来数量级的提速，这笔账第 14 周 Day 6 算过。
:::

## 第四步：相似检索

检索就一个算子：`<=>`，pgvector 的余弦距离。值越小方向越近，所以 `ORDER BY` 升序取前 k 条就是最相似的 k 块。封装成函数，后面问答和评估都调它：

```ts
// search.ts —— 语义检索：query 向量化后按余弦距离取 top-k
import OpenAI from "openai";
import { sql } from "./ingest.js";

const client = new OpenAI();
export type Doc = { id: number; content: string; source: string; distance: number };

export async function search(query: string, k = 5): Promise<Doc[]> {
  const { data } = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: query, // 注意：查询和入库用同一个 embedding 模型，混用则坐标空间不同，检索直接失真
  });
  const qvec = `[${data[0].embedding.join(",")}]`;

  return sql<Doc[]>`
    SELECT id::int AS id, content, source,
           embedding <=> ${qvec}::vector AS distance
    FROM documents
    ORDER BY embedding <=> ${qvec}::vector
    LIMIT ${k}
  `;
}
```

返回值里带上 distance 有讲究：它是排查检索质量的第一手数据。距离 0.1 出头说明命中得很实；都在 0.8 以外，基本是知识库里没有相关内容，这时候该走「说不知道」的分支，而不是把垃圾块喂给模型。

## 第五步：问答

零件齐了，最后拼成产品。流程：问题进来，检索 top 5，编号后拼进 prompt，流式输出，答案里的 [1][2] 由检索结果对号入座。引用编号由后端分配、模型只负责标号，这个设计来自 [第 15 周 Day 4](/week15/day4) 的溯源思想：文件名和来源在模型手里就是编造素材，在你手里才是事实。

```ts
// ask.ts —— 检索拼 prompt，流式回答，引用对号入座
import OpenAI from "openai";
import { search } from "./search.js";

const client = new OpenAI();
const MODEL = "gpt-4o-mini";

export async function ask(question: string) {
  const docs = await search(question, 5);
  if (docs.length === 0 || docs[0].distance > 0.85) {
    console.log("知识库里没找到相关内容，这题我不答。"); // 第 14 周 Day 1 那道闸
    return;
  }

  const context = docs
    .map((d, i) => `[${i + 1}]（${d.source}）\n${d.content}`)
    .join("\n\n");

  const stream = await client.chat.completions.create({
    model: MODEL,
    stream: true,
    temperature: 0, // 知识库问答要稳不要野
    messages: [
      {
        role: "system",
        content:
          "你是知识库问答助手，只依据用户给出的资料回答，" +
          "引用哪段就在句末标注编号，如 [1][2]。" +
          "资料里没有答案就直说不知道，禁止编造。",
      },
      { role: "user", content: `资料：\n${context}\n\n问题：${question}` },
    ],
  });

  process.stdout.write("答> ");
  for await (const part of stream) {
    process.stdout.write(part.choices[0]?.delta?.content ?? "");
  }

  console.log("\n\n引用来源：");
  docs.forEach((d, i) =>
    console.log(`[${i + 1}] ${d.source}（距离 ${d.distance.toFixed(3)}）`),
  );
}
```

再配一个 CLI 入口，ingest 走 pdf-parse，ask 走上面的函数：

```ts
// main.ts
import { readFile } from "node:fs/promises";
import pdf from "pdf-parse/lib/pdf-parse.js";
import { ingest } from "./ingest.js";
import { ask } from "./ask.js";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "ingest" && rest[0]) {
  const { text } = await pdf(await readFile(rest[0]));
  console.log(`入库完成：${await ingest(text, rest[0])} 块`);
} else if (cmd === "ask" && rest.length) {
  await ask(rest.join(" "));
} else {
  console.log("用法：npx tsx src/main.ts ingest <pdf路径>");
  console.log("      npx tsx src/main.ts ask <问题>");
}
process.exit(0); // 连接池还挂着，显式退出
```

跑起来：

```powershell
npx tsx src/main.ts ingest .\员工手册.pdf
npx tsx src/main.ts ask 年假有几天，怎么申请？
```

答案逐字流出，末尾跟着 [1][2] 对应的来源和距离。到这里，第 14 周 Day 7 的「端到端最小 RAG」在 TS 侧复刻完毕。

## 质量抓手（对照第 15 周）

第 15 周给 RAG 上过三件质量抓手：混合检索、Rerank、评估集。TS 侧一件不缺，逐个接上。

**混合检索。**[第 15 周 Day 1](/week15/day1) 的结论：带编号、型号、专有名词的查询，字面匹配一锤定音，纯语义反而模糊。BM25 在 PG 里不用外挂引擎，tsvector 全文检索就够。先给表加一列并建 GIN 索引：

```sql
ALTER TABLE documents ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;
CREATE INDEX IF NOT EXISTS documents_tsv_idx ON documents USING GIN (tsv);
```

诚实提醒：PG 内置分词不认中文，`simple` 配置把连续中文整段当一个词。英文语料直接可用；中文要么装 zhparser 扩展，要么入库前用 nodejieba 分好词、以空格分隔写入。两路召回拿齐后，用 RRF 融合，排名倒数相加，不碰两套不可比的原始分：

```ts
// hybrid.ts —— 向量 + 全文各取 top20，RRF 融合取 top5
import { sql } from "./ingest.js";

export async function hybridSearch(query: string, qvec: number[], k = 5) {
  const vec = `[${qvec.join(",")}]`;
  const [byVec, byFts] = await Promise.all([
    sql<{ id: number }[]>`
      SELECT id::int AS id FROM documents
      ORDER BY embedding <=> ${vec}::vector LIMIT 20`,
    sql<{ id: number }[]>`
      SELECT id::int AS id FROM documents
      WHERE tsv @@ plainto_tsquery('simple', ${query})
      ORDER BY ts_rank(tsv, plainto_tsquery('simple', ${query})) DESC
      LIMIT 20`,
  ]);

  const K = 60; // RRF 常数，压低头部排名差距
  const scores = new Map<number, number>();
  byVec.forEach(({ id }, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (K + i + 1)));
  byFts.forEach(({ id }, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (K + i + 1)));

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id);

  return sql`
    SELECT id::int AS id, content, source FROM documents
    WHERE id IN ${sql.inArray(topIds)}
  `;
}
```

**Rerank。**召回宽进、重排严出，账在 [第 15 周 Day 2](/week15/day2)：召回模型便宜但排序糙，交叉编码器准但贵，所以前 50 交给便宜的、前 5 交给准的。Cohere 的 Rerank 就一个 HTTP 调用，fetch 原生搞定，不必装 SDK：

```ts
// rerank.ts —— Cohere Rerank：对候选块重排，取前 topN
export async function rerank(
  query: string,
  docs: { id: number; content: string }[],
  topN = 5,
) {
  const resp = await fetch("https://api.cohere.com/v1/rerank", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "rerank-v3.5",
      query,
      documents: docs.map((d) => d.content),
      top_n: topN,
    }),
  });
  if (!resp.ok) throw new Error(`rerank 失败：${resp.status}`);
  const { results } = (await resp.json()) as {
    results: { index: number; relevance_score: number }[];
  };
  return results.map((r) => ({ ...docs[r.index], score: r.relevance_score }));
}
```

返回只带 index 和 relevance_score，index 对回你的 docs 数组。Jina 的 `/v1/rerank` 结构几乎一样，换域名 `api.jina.ai`、模型名 `reranker-v2-lite-multilingual` 即可。接进主链路一步：召回从 `search(query, 5)` 改成 `search(query, 20)` 喂给 rerank，取前 5 进 prompt。

**评估集。**工具换了，方法论原封不动，[第 15 周 Day 5](/week15/day5) 是详细版：10 到 20 题的 golden set，每题标注应命中的块 id，跑 `search` 收 Hit@3 和 nDCG。TS 侧被测函数就是第四步那个 `search`，读入评估集循环调用、对答案、算指标，一个脚本的事。改切块参数、上 Hybrid、加 Rerank，每个决定都跑一轮再合入。

## 自测 5 题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 切块时的 overlap 是干什么的？块切得太大或太小，检索侧各会出什么问题？

::: details 参考答案
overlap 让横跨切口的句子在相邻两块各留一份，两边都能被检索到。块太大，一个向量承载多个主题，语义被平均，命中稀释；块太小，单块上下文不完整，拼进 prompt 的材料支离破碎。起点值 300 到 500 字、重叠 10% 到 20%，最终参数让评估集的 Hit@3 说话。
:::

2. `vector(1536)` 和 text-embedding-3-small 是什么关系？换成 3-large，代码要动哪几处？

::: details 参考答案
表列维度必须与 embedding 输出维度严格相等，3-small 原生 1536 维，所以列是 `vector(1536)`。换 3-large 要么把列改成 `vector(3072)`，要么在 embeddings.create 里传 `dimensions: 1536` 让它降维输出，两处必须同步改，单改一边插入直接报错。查询侧与入库侧必须同模型，混用则坐标空间不同，检索失真。
:::

3. `<=>` 算的是什么距离？为什么 `ORDER BY` 升序取前 5 就是「最相似」？

::: details 参考答案
pgvector 的余弦距离，即 1 减余弦相似度，只看向量方向、不看模长。值越小方向越接近，语义越相近，所以升序排列的前 k 条就是最相似的 k 块。distance 同时是排查工具：普遍大于 0.85 说明知识库里大概率没有相关内容，该走拒答分支。
:::

4. 引用编号 [1][2] 为什么由后端分配、模型只负责标号？

::: details 参考答案
来源文件名、页码这些 metadata 在模型手里是可以被编造的素材，在检索结果里才是事实。后端给候选块编号、把编号随资料拼进 prompt，模型只被允许回标 [n]，编号与来源的映射始终握在你手里，答案的每个引用都能对号入座，这是第 15 周 Day 4 溯源设计的关键。
:::

5. RRF 融合两路检索时，为什么用排名倒数相加，而不是把两路的原始分数直接相加？

::: details 参考答案
余弦距离和 ts_rank 是两套量纲，数值范围和分布都不可比，直接相加等于让尺度大的那一路吞掉另一路。RRF 只取排名，1/(K+rank) 把两路都压到同一尺度再融合，K=60 抑制头部排名的差距。代价是丢掉了分数信息，换来的是无需调权重的稳定融合。
:::

## 延伸阅读

- [openai-node 仓库](https://github.com/openai/openai-node)，官方 TS SDK 源码与示例，embeddings 与流式 chat 的类型定义都在这
- [postgres.js 文档](https://postgresjs.com/)，标签模板、sql.inArray、连接池配置的完整说明
- [pgvector 仓库](https://github.com/pgvector/pgvector)，安装方法、距离算子、HNSW/IVFFlat 索引的官方口径
- [Cohere Rerank API](https://docs.cohere.com/reference/rerank)，rerank-v3.5 的请求体字段与返回结构

留好这五个文件。后面知识库要接进 Agent，检索函数 `search` 和引用拼装就是现成零件；评估脚本跑出的那组数字，是你以后每次改参数的对照基线。
