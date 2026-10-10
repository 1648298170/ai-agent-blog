# 第 21 周 · Day 6：语义缓存——相似的问题不重复烧 LLM

> 对应手册任务：学习「性能优化：语义缓存」，动手「用 pgvector 做语义缓存，相同意图的查询直接返回缓存结果」，当日产出「缓存命中」。本篇只解决一个问题：同一个意思有无数种问法，精确缓存接不住，每次提问都老老实实走完 Embedding、检索、LLM 生成的全链路，时间和 token 双花。语义缓存按「意思」判定命中，把重复的问题在 LLM 门口拦下来。

## 今日目标

1. 说得清语义缓存和精确缓存的判定差别，以及为什么知识库问答场景特别吃这一套
2. 掌握完整链路：建缓存表、查询先算相似度、命中直接返回、未命中走原链路后回写
3. 独立跑出一次缓存命中，并知道阈值怎么调、缓存何时失效、哪些答案永远不进缓存

## 概念讲解：为什么精确缓存接不住

知识库问答上线后你想省钱，第一个念头多半是加缓存：拿问题原文当 key，答案当 value，查得到就直接返回，查不到再走链路。逻辑没错，但打开真实提问日志看一眼，这层缓存基本是摆设。

「退货政策是啥」和「退货规则是什么」，一个口语一个书面，人一眼就知道在问同一件事，KV 缓存却当成两个 key：字符串字节不相等，miss。于是两次完整的 RAG 链路、两次 LLM 调用、两次账单。这还不是个例。用户加个「请问」、换个同义词、口语化一点，key 就变了，提问方式千差万别，精确缓存在这种场景的命中率低到不值得维护。

语义缓存换了个判定标准：不比字面，比意思。问题进来先转成向量，去缓存里找最像的旧问题，相似度超过阈值就认定是同一个意图，直接返回旧答案。上面那两句的向量距离非常近，语义缓存命中，一次 LLM 调用省下来。

值不值得做，看命中率。FAQ 密集的知识库问答（退货、发票、密码重置这类高频问题反复出现），语义缓存命中率常见 30% 到 60%。按 40% 算：一百次提问里四十次不碰 LLM，生成成本砍四成，这四十次的延迟从「等 LLM 写完」变成「一次向量查询」，通常从两三秒压到几百毫秒。

还有一层值得说：今天搭的所有组件没有一个是新的。向量存储用第 14 周的 pgvector，阈值怎么定用第 15 周调检索阈值的评估思维，验证靠第 16 周攒的评估集。语义缓存本身就是把学过的东西换个地方组装。

## 核心知识

### 1. 缓存表：还是第 14 周那套 pgvector

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- 缓存主体：问题和答案成对存
CREATE TABLE semantic_cache (
  id                 BIGSERIAL PRIMARY KEY,
  question_text      TEXT NOT NULL,           -- 原始问题，命中时告诉用户「匹配到了谁」
  question_embedding VECTOR(1536) NOT NULL,   -- 问题向量，维度跟你的 Embedding 模型一致
  answer             TEXT NOT NULL,           -- 完整链路生成的好答案
  tenant_id          TEXT NOT NULL,           -- 租户隔离：A 公司的问题不能命中 B 公司的缓存
  kb_version         INT NOT NULL DEFAULT 1,  -- 知识库版本号，失效机制的核心
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON semantic_cache USING hnsw (question_embedding vector_cosine_ops);
CREATE INDEX ON semantic_cache (tenant_id, kb_version);

-- 每个租户当前的知识库版本
CREATE TABLE cache_versions (
  tenant_id TEXT PRIMARY KEY,
  version   INT NOT NULL DEFAULT 1
);
```

关键有两列。`tenant_id` 出现在每一条查询条件里，它保证隔离性：多租户系统里少了这个条件，A 公司的「退货政策」会命中 B 公司的缓存，这是数据事故。`kb_version` 是失效机制的伏笔，第 4 步用它。1536 是 text-embedding-3-small 的维度，用别的模型就改成对应数字，要求和第 14 周建知识库表时一样。

### 2. 查询流程：先查缓存，再走链路

```ts
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SIMILARITY_THRESHOLD = 0.95; // 先占位，第 3 节教你调成自己的数字

interface AskResult {
  answer: string;
  fromCache: boolean;       // 标注「来自缓存」，统计和前端展示都靠它
  matchedQuestion?: string; // 命中时：缓存里那个原始问题
  similarity?: number;      // 命中时：相似度得分
}

export async function ask(question: string, tenantId: string): Promise<AskResult> {
  const version = await getKbVersion(tenantId);

  // 1. 新问题先转成向量（embed 返回 number[]，第 14 周封装的调用）
  const embedding = await embed(question);

  // 2. 去缓存里找最像的问题；<=> 是余弦距离，1 - 距离 = 相似度
  const res = await pool.query(
    `SELECT question_text, answer,
            1 - (question_embedding <=> $1::vector) AS similarity
     FROM semantic_cache
     WHERE tenant_id = $2 AND kb_version = $3
     ORDER BY question_embedding <=> $1::vector
     LIMIT 1`,
    [`[${embedding.join(",")}]`, tenantId, version]
  );

  // 3. 相似度过阈值：命中，直接返回，不碰检索和 LLM
  const row = res.rows[0];
  if (row && Number(row.similarity) >= SIMILARITY_THRESHOLD) {
    return {
      answer: row.answer,
      fromCache: true,
      matchedQuestion: row.question_text,
      similarity: Number(row.similarity),
    };
  }

  // 4. 未命中：走完整 RAG 链路（第 14 周的检索 + 生成，原样复用）
  const answer = await runRagPipeline(question, tenantId);

  // 5. 回写缓存，下一个同意图的问题就能命中
  await pool.query(
    `INSERT INTO semantic_cache
       (question_text, question_embedding, answer, tenant_id, kb_version)
     VALUES ($1, $2::vector, $3, $4, $5)`,
    [question, `[${embedding.join(",")}]`, answer, tenantId, version]
  );

  return { answer, fromCache: false };
}

async function getKbVersion(tenantId: string): Promise<number> {
  const res = await pool.query(
    `SELECT version FROM cache_versions WHERE tenant_id = $1`,
    [tenantId]
  );
  return res.rows[0]?.version ?? 1;
}
```

整条链路的关键在顺序：向量先算，缓存先查，LLM 最后才轮到。跟第 14 周的向量检索相比，只是把「查知识库」换成「查缓存表」，SQL 一行都没多学。`fromCache` 这个字段别省，它是后面所有效果统计的依据，也方便给命中的答案加个「来自缓存」的标注。

### 3. 阈值：调出来的，不是抄来的

阈值直接决定这套缓存是省钱工具还是事故源头。0.95 意味着两句话的余弦相似度要到 95%。太严：换个问法就 miss，命中率和没开差不多；太松（比如 0.85）：「客服电话是多少」和「客服邮箱是多少」这种字面相近、答案不同的对会被误命中，用户拿到答非所问的回复，这比慢三秒伤得多。

定阈值别拍脑袋，用第 16 周的评估集，方法跟第 15 周调检索阈值一模一样：

1. 从评估集挑两类样本：意图相同的不同问法（正样本对），字面相近但答案不同的陷阱对（负样本对）
2. 从 0.85 到 0.98 每隔 0.01 扫一遍，统计每档的命中率（正样本命中比例）和误命中率（负样本命中比例）
3. 选误命中归零的档位里命中率最高的那个

示例数据（只示范趋势，你的数字要自己跑）：

| 阈值 | 正样本命中率 | 陷阱对误命中 | 判断 |
|------|------------|-------------|------|
| 0.85 | 58% | 11% | 答非所问，不能用 |
| 0.90 | 46% | 3% | 有风险 |
| 0.95 | 34% | 0% | 拐点，选它 |
| 0.98 | 15% | 0% | 太严，白搭 |

34% 的命中率意味着三分之一的提问完全不碰 LLM，对应三分之一的生成成本和将近三分之一的等待时间。上线后每隔一阵拿新攒的真实问题复扫一遍，问题分布变了，最优阈值会漂。

### 4. 缓存边界：什么永远不进缓存

语义缓存的前提是「同一个意图，答案对所有人都一样」。拿这个标准过一遍，有两类内容必须拉黑。

个性化答案。「帮我总结上周的会议纪要」「我的订单到哪了」，答案依赖用户记忆和上下文，问题向量相同答案却因人而异，缓存它们等于把 A 的内容发给 B。凡是链路里注入了用户记忆的分支，直接跳过回写。

时效性答案。「今天的股价」「最新的优惠活动」，字面不变，内容随时间变，缓存会让答案悄悄过期。这类问题要么不缓存，要么设很短的过期时间，`created_at` 这时派上用场。

回写前的自检清单，四问：

- 答案因人而异吗？是，不缓存
- 答案随时间变吗？是，不缓存或设短过期
- 答案依赖知识库的当前内容吗？是，靠 `kb_version` 失效兜底（已自动覆盖）
- 这条答案本身合格吗？检索没找到资料的兜底话术，不缓存

## 动手任务：跑出一次缓存命中

手册任务：用 pgvector 做语义缓存，相同意图的查询直接返回缓存结果。拆成 5 步，全程约 30 分钟。

**第 1 步：建表。** 在第 14 周用的那个数据库里执行核心知识第 1 节的 SQL，`semantic_cache` 和 `cache_versions` 两张表一起建。

**第 2 步：落地查询函数。** 新建 `semantic-cache.ts`，把第 2 节的代码整段贴进去。`embed` 和 `runRagPipeline` 从第 14 周的项目里 import，不要重写。`SIMILARITY_THRESHOLD` 先保持 0.95。

**第 3 步：亲眼看一次命中。**

```ts
// 第一次问，未命中，走完整链路
const r1 = await ask("退货政策是啥", "tenant-a");
console.log(r1.fromCache); // false，这条答案进了缓存

// 第二次换个说法，字面完全不同
const r2 = await ask("退货规则是什么", "tenant-a");
console.log(r2.fromCache);       // true，命中了
console.log(r2.matchedQuestion); // "退货政策是啥"
console.log(r2.similarity);      // 0.96 上下，看模型
```

想再确信一点，把 `SIMILARITY_THRESHOLD` 临时调到 0.9999 问第三遍，`fromCache` 变回 false。这证明命中真的走相似度判定，不是缓存把所有请求都吞了。测完改回 0.95。

**第 4 步：模拟知识库更新，验证失效。** 版本号标记法的关键一行：

```ts
// 知识库更新的钩子里调用：版本号 +1，旧缓存全部失配
export async function invalidateCache(tenantId: string): Promise<void> {
  await pool.query(
    `INSERT INTO cache_versions (tenant_id, version) VALUES ($1, 1)
     ON CONFLICT (tenant_id)
     DO UPDATE SET version = cache_versions.version + 1`,
    [tenantId]
  );
}

await invalidateCache("tenant-a");
const r3 = await ask("退货政策是啥", "tenant-a");
console.log(r3.fromCache); // false：版本变了，旧缓存失配，重新走链路
```

版本号的好处是失效只有一行 UPDATE，瞬间完成。换成「更新时全表 DELETE 该租户的缓存」，行数一多删得慢，删的期间还有时间窗。旧版本的行不用急着清，查询条件已经永远碰不到它们，交给定时任务慢慢删。

**第 5 步：量效果，三指标。** 拿第 16 周评估集当流量源跑两轮：一轮把缓存查询注释掉模拟关缓存，一轮正常开。每轮记三个数：

```ts
const stats = { total: 0, hits: 0, latencySum: 0, llmCalls: 0 };

// 在评估集的循环里：
const t0 = Date.now();
const r = await ask(q, tenantId);
stats.latencySum += Date.now() - t0;
stats.total++;
if (r.fromCache) stats.hits++; else stats.llmCalls++;

// 跑完汇总：
// 命中率 = hits / total
// 平均延迟 = latencySum / total
// LLM 调用次数 = llmCalls，成本按 token 单价换算
```

示例（评估集 200 题，数字只示范格式）：

| 指标 | 关缓存 | 开缓存 | 变化 |
|------|--------|--------|------|
| 命中率 | 0% | 34% | 新增 |
| 平均延迟 | 2.9s | 2.0s | -31% |
| LLM 调用次数 | 200 | 132 | -34% |

平均延迟只降三成，没有命中率那么多，因为命中省掉的是 LLM 生成，Embedding 调用和向量查询照旧发生。这张表存好，明天 Day 7 压测时它是基线，也是解释「为什么开了缓存 P99 还是高」的底气。

::: tip 顺手垫一层精确缓存
语义缓存之前可以先加一层普通 KV 缓存：问题原文完全相同就直接返回，连 Embedding 调用都省掉。一字不差的重复提问在真实流量里占比不小，这层收益几乎白捡。
:::

## 常见踩坑

**坑 1：查询条件里漏了 tenant_id，跨租户串答案。** 复制第 14 周的检索 SQL 时最容易把 WHERE 带丢。串台的后果不是性能问题，是 A 公司的用户看到 B 公司的退货政策。上线前拿两个租户各问一次同一个问题，确认答案不同源。

**坑 2：阈值照抄别人的 0.95。** 最优阈值跟 Embedding 模型、问题分布、答案粒度强相关，换一个模型它就漂。正确姿势是核心知识第 3 节的扫描法，上线后定期用新攒的真实问题重扫。照抄的阈值要么命中不了几个，要么悄悄答非所问，后者更危险，因为它不报错。

**坑 3：失败答案也回写。** 链路没检索到资料时，答案可能是一句「抱歉，知识库中没有相关内容」。这句话一旦进缓存，之后所有同意图的问题都命中它，用户永远得不到正常服务，日志里命中率还挺好看。回写前加一道判断：检索结果为空、带兜底话术、置信度低的，一律不缓存。

**坑 4：只看命中率，不看延迟。** 语义缓存省的是 LLM 生成，Embedding 一次没少。缓存表再忘了建 HNSW 索引，几千行数据顺序扫描，命中的那次查询也要几百毫秒。三个指标一起看：命中率、平均延迟、LLM 调用次数，哪项不达预期就查对应环节，别让单一数字骗了自己。

**坑 5：缓存只进不出。** 每次未命中都 INSERT，没有任何清理，表越滚越大，向量索引越来越慢。版本切换留下的旧行、超过 TTL 的行（比如 30 天），交给定时任务清。缓存的价值密度会衰减：越老的问题越少被再问，留着只占索引。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 「退货政策是啥」和「退货规则是什么」，KV 缓存和语义缓存各怎么判定？

::: details 参考答案
KV 缓存拿问题原文当 key，两个字符串字节不同，判定为不同问题，miss。语义缓存把两句话都转成向量，余弦相似度超过阈值（比如 0.96 大于 0.95），判定为同一意图，hit，直接返回缓存答案并标注「来自缓存」。
:::

2. 缓存查询的 WHERE 里，tenant_id 和 kb_version 各挡住什么？

::: details 参考答案
tenant_id 挡跨租户命中，保证 A 租户的问题只命中 A 租户的缓存，这是数据隔离。kb_version 挡过期命中，知识库更新后版本号变了，旧版本的缓存行不再参与匹配，这是内容时效。
:::

3. 版本号标记法比「更新知识库时全表 DELETE 缓存」好在哪？

::: details 参考答案
三点：一行 UPDATE 瞬间生效，DELETE 行数多时慢还占锁；没有「删到一半」的时间窗，请求要么用旧版本缓存要么用新版本，不会查到半空的缓存；旧版本行可以异步慢慢清，主链路无感。
:::

4. 阈值从 0.95 调到 0.85，命中率上升，代价是什么？怎么找平衡点？

::: details 参考答案
代价是误命中率上升：「客服电话」和「客服邮箱」这种字面相近、答案不同的问题对会被错误命中，用户拿到答非所问的回复。平衡点用评估集找：正样本对和陷阱对一起扫阈值，选误命中归零（或可接受）的档位里命中率最高的那个。
:::

5. 哪两类答案不该进语义缓存？各自的原因是什么？

::: details 参考答案
个性化答案：依赖用户记忆和上下文（「我的订单到哪了」），问题向量相同答案却因人而异，缓存会跨用户串内容，是隐私事故。时效性答案：字面不变但内容随时间变（「今天股价多少」），缓存会让答案过期，要么不缓存要么设很短的 TTL。
:::

## 延伸阅读

- [pgvector](https://github.com/pgvector/pgvector)，第 14 周就在用的向量扩展，`<=>` 距离算子、HNSW 索引的细节都在 README 里
- [GPTCache](https://github.com/zilliztech/GPTCache)，开源的 LLM 语义缓存方案，今天手写的每一步它都产品化了，读懂它的设计再决定要不要直接用
- [OpenAI Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)，向量维度和余弦相似度的官方解释，调阈值前值得再看一遍

今天的命中率、平均延迟、LLM 调用次数三件套记下来，明天 Day 7 压测要拿它们当对照。
