# 第 15 周 · Day 1：Hybrid 检索——BM25 + 向量双路合击，专治「字面词搜不到」

> 对应手册任务：学习「Hybrid RAG：稠密 + 稀疏检索」，动手「用 BM25 + 向量检索做混合检索，对比单一检索效果」，当日产出 `hybrid_retrieval.py`。本篇只解决一个问题：上周的最小 RAG 用向量检索打底，换说法的问题搜得很稳，可错误码、型号、条款编号这类「必须字面命中」的词，语义向量反而抓不准——今天再拉一路 BM25 关键词检索，两路各查各的，用 RRF 把两份结果揉成一份，语义题和关键词题通吃。

## 今日目标

1. 说得清向量检索的盲区在哪：为什么「ORDER-2024 是什么错误」这种问题，语义向量会把目标切块漏掉
2. 掌握三件事：BM25 的打分直觉（词频 × 逆文档频率，不推导公式）、中文用 rank_bm25 前必须 jieba 分词、RRF 倒数排名融合的手写实现和它免调参的原因
3. 独立跑一次 10 题对比实验：向量、纯 BM25、Hybrid 三列命中率摆进一张表，亲眼看到两路互补的收益

## 概念讲解：为什么单靠向量检索不够

上周的 RAG 跑起来之后，先看一个真实的翻车现场。用户问：「ORDER-2024 是什么错误？」向量检索返回的前 5 块是：订单取消政策、订单状态说明、修改收货地址的流程……唯独没有那块写着「错误码 ORDER-2024：库存锁定超时，请检查仓库锁定服务」的排查文档。

奇怪吗？一点不奇怪。Embedding 的本质是压缩语义：一段话变成 1536 个数，编码的是「这段话在说什么」。可「ORDER-2024」是个字符串编号，它在向量空间里的位置，取决于模型怎么切 token、训练语料里见过多少类似写法，跟「库存锁定超时」这半句话在语义上八竿子打不着。于是问题向量和答案切块的方向离得很远，反倒是一堆讲「订单」的切块语义上更近，把 Top-K 的位置全占了。

一句话：向量擅长的是「意思近」，不是「字面同」。而真实用户的问题里，字面精确匹配的需求一抓一大把——错误码、产品型号、工单号、条款编号、人名。这类查询交给纯向量检索，就是盲区。反过来的短板你也早就见过：问「住宿标准一晚多少钱」，搜不到写着「差旅住宿报销额度」的文档，一个共同的词都没有，关键词检索当场瞎掉，这正是上周选向量检索的理由。

所以两路的强项正好错开：

| | 稠密检索（向量） | 稀疏检索（BM25） |
| --- | --- | --- |
| 文档长什么样 | 1536 个浮点数 | 一组词和它们的权重 |
| 怎么算相关 | 语义方向接近 | 字面词重合 |
| 强项 | 换个说法照样搜到 | 专有名词、型号、错误码 |
| 弱区 | 字面精确匹配 | 换个说法就抓瞎 |

既然错开，就别二选一。两路都跑，各拿一份候选，再融合成一份结果，这就是 Hybrid 检索（混合检索）。稠密 + 稀疏双路合击，语义的路和字面的路都不放走。

## 核心知识

### 1. BM25 是什么：词频 × 逆文档频率的直觉

BM25 是稀疏检索的经典算法，搜索引擎里服役了十几年的主力。它回答一个问题：给定一个查询，库里每篇文档跟它有多相关。公式不推导，记住两个信号的直觉就够了。

第一个信号，词频（TF）：查询里的某个词在这篇文档出现得越多，这篇文档越可能相关。但增益有饱和——出现 3 次比出现 1 次相关得多，出现 30 次不会比 3 次相关十倍，堆砌关键词刷分没用。

第二个信号，逆文档频率（IDF）：一个词在全体文档里越稀有，区分度越高。「的」「我们」这种词每篇都有，区分度为零；「ORDER-2024」全库只在两块文档里出现，谁包含它谁就是目标。稀有词的重合，才是有效重合。

外加一条长度归一化：长文档不因为字多就占便宜，分数会按文档长度折算。

三件事合起来一句话：BM25 打分 = 查询和文档之间「稀有词的重合度」。查「ORDER-2024」，ORDER 和 2024 都是全库稀有词，哪块文档包含它们，哪块直接爆分，第一名没有悬念。这就是它治向量盲区的原理。

### 2. rank_bm25 实操：中文必须先过 jieba

Python 里用 BM25 最省事的是 `rank_bm25` 包，核心类叫 `BM25Okapi`。它吃的是「已经切成词的语料」，每个文档是一个 token 列表：

```python
# pip install rank_bm25 jieba
import jieba
from rank_bm25 import BM25Okapi

def tokenize(text: str) -> list[str]:
    """统一分词：jieba 切词、转小写、丢掉空白 token。语料和查询都必须用它。"""
    return [t.lower() for t in jieba.cut(text) if t.strip()]

corpus = [
    "差旅住宿报销额度为每晚 400 元",
    "错误码 ORDER-2024 表示库存锁定超时",
    "退货需在签收后 7 日内发起",
]
bm25 = BM25Okapi([tokenize(doc) for doc in corpus])

query = tokenize("ORDER-2024 是什么错误")
print(bm25.get_scores(query))  # 每篇文档一个分数，第二篇会遥遥领先
```

关键在 `tokenize` 这一步，对中文它是生死线。英文有空格，天然分好词；中文「差旅住宿报销额度」是一整串，不分词的话整句就是一个 token，查询「住宿标准多少钱」也是一整个 token，两边永远不相等，词频统计无从谈起，BM25 直接失效。所以必须 jieba 先切：文档被切成「差旅 / 住宿 / 报销 / 额度」这样的词，查询同样切，重合才有意义。

两个细节。第一，中英混排时 jieba 会把英文和数字切成独立 token，连字符当标点处理，「ORDER-2024」进索引就变成 ORDER 和 2024 两个词——没关系，这两个都是稀有词，照样把目标文档顶到第一。第二，`lower()` 统一大小写，防止查询写 order、文档写 ORDER 这种阴沟里翻船。这两个细节都写在 `tokenize` 里，语料和查询共用同一个函数，这是铁律。

### 3. RRF：倒数排名融合，手写不到 20 行

两路检索各给一份排好序的候选，怎么融合？最直觉的写法是加权：`score = α × 余弦分 + (1-α) × BM25 分`。写出来五分钟，调到能用要命：余弦分挤在 0 到 1，BM25 分上不封顶，量纲根本不可比，得先归一化；归一化方式有好几种，每种都影响结果；好不容易归一完，α 取多少？语义题想要 α 大，关键词题想要 α 小，没有先验答案。三连问下来，这就是调参地狱。

RRF（Reciprocal Rank Fusion，倒数排名融合）把这个问题釜底抽薪：分数不可比，排名总可比。每个文档的融合分，是它在各路列表里「排名的倒数」之和：

```text
score(d) = Σ 1 / (k + rank_i(d))     k 常取 60
```

排名第 1 贡献 1/61，第 2 贡献 1/62，依次递减。一个文档两路都排前面，两个倒数一加就冒头；只有单路靠前的，靠那一路的排名也能保住位置。手写实现：

```python
def rrf(rankings: list[list[str]], k: int = 60) -> list[tuple[str, float]]:
    """rankings：多路检索结果，每路是按相关度排好序的文档（这里用切块文本当 id）。
    返回融合分数降序的 (切块, 分数) 列表。"""
    scores: dict[str, float] = {}
    for ranking in rankings:                  # 逐路累加倒数分
        for rank, doc in enumerate(ranking, start=1):
            scores[doc] = scores.get(doc, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
```

不到 20 行，没有归一化，没有权重。k=60 是原论文给出的稳健默认值，作用是压一压第 1 名和第 2 名的分数差，防止某一路独占前排。对比加权融合那套「归一化方式 + 权重 α」的双重不确定性，RRF 只有一个 k，而且 60 这个默认值在实践中基本不用动——这就是「无需调权重」的妙处。Elasticsearch 的混合检索干脆把 RRF 做成了内置能力，思路同源。

## 动手任务：`hybrid_retrieval.py` 一步一步

手册任务：用 BM25 + 向量检索做混合检索，对比单一检索效果。拆成 5 步，全程约 20 分钟。前提是第 14 周的库还在：PostgreSQL + pgvector，`documents` 表里有切块和向量，`retriever.py` 能跑。

**第 1 步：建文件、装依赖。** 本周练习目录执行：

```bash
pip install rank_bm25 jieba
```

沿用上周的 `psycopg` 和 `openai`，新建 `hybrid_retrieval.py`。下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：捞全量切块，建 BM25 索引。** BM25 是内存索引，词频和 IDF 都从语料现算，全量切块拉进来即可：

```python
import jieba
import psycopg
from rank_bm25 import BM25Okapi
from openai import OpenAI

client = OpenAI()  # 读环境变量 OPENAI_API_KEY
CONN = "postgresql://postgres:你的密码@localhost:5432/rag_lab"

def tokenize(text: str) -> list[str]:
    return [t.lower() for t in jieba.cut(text) if t.strip()]

def load_chunks() -> list[str]:
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute("SELECT chunk FROM documents")
        return [r[0] for r in cur.fetchall()]

chunks = load_chunks()
bm25 = BM25Okapi([tokenize(c) for c in chunks])
print(f"BM25 索引建好，共 {len(chunks)} 块")
```

关键一行是 `bm25 = BM25Okapi([tokenize(c) for c in chunks])`：语料侧全部切块、全部过 `tokenize`。这一步和查询侧用不用同一个分词函数，直接决定 BM25 路是活是死。

**第 3 步：两路检索函数。** 向量路照抄上周 Day 6 的写法，只返回切块文本；BM25 路用 `get_scores` 打分再排序：

```python
def embed_query(query: str) -> list[float]:
    resp = client.embeddings.create(
        model="text-embedding-3-small",  # 与入库时同一个模型，铁律不变
        input=query,
    )
    return resp.data[0].embedding

def vector_search(query: str, k: int = 5) -> list[str]:
    vec = "[" + ",".join(str(x) for x in embed_query(query)) + "]"
    sql = """
        SELECT chunk FROM documents
        ORDER BY embedding <=> %(vec)s::vector
        LIMIT %(k)s;
    """
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(sql, {"vec": vec, "k": k})
        return [r[0] for r in cur.fetchall()]

def bm25_search(query: str, k: int = 5) -> list[str]:
    scores = bm25.get_scores(tokenize(query))
    ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)
    return [chunks[i] for i in ranked[:k]]
```

注意两路的返回结构刻意做成一样：都是「按相关度降序的切块文本列表」。排名信息就藏在顺序里，这正是 RRF 需要的全部输入。

**第 4 步：RRF 融合成 Hybrid 检索。** 把核心知识第 3 节的 `rrf` 函数抄进文件，再包一层：

```python
def hybrid_search(query: str, k: int = 5, k_rrf: int = 60) -> list[tuple[str, float]]:
    rankings = [
        vector_search(query, k=10),   # 每路先取宽一点的候选面
        bm25_search(query, k=10),
    ]
    return rrf(rankings, k=k_rrf)[:k]  # 融合后再截到 K

if __name__ == "__main__":
    for doc, score in hybrid_search("ORDER-2024 是什么错误", k=3):
        print(round(score, 4), doc[:50])
```

两个细节。第一，每路先取 10 再融合、最后截 5：两路的候选面要比最终 K 大，融合才有得挑，只喂 5 个进去 RRF 无米下锅。第二，目标切块此刻应该排第一——对比一下上周纯向量检索在同一问题上的返回，差距就是今天的收益。

**第 5 步：10 题对比实验，三列命中率。** 造 10 个问题，两类各 5 题：语义类换着说法问，问题和目标切块尽量零关键词重合；关键词类直接带错误码、型号、编号这类字面量。每题标注一个「命中片段」——目标切块里独有的一小段文字，用来判分：

```python
# (类型, 问题, 命中片段)——片段换成你语料里真实存在的独有文字
TESTS = [
    ("语义", "住宿标准一晚多少钱", "每晚 400"),        # 示例，照你的库改
    ("语义", "买完不想要了怎么办", "7 日内"),
    ("语义", "出差回来钱怎么报", "报销额度"),
    ("语义", "东西还没到不想要了", "拦截"),
    ("语义", "发票什么时候能给", "电子发票"),
    ("关键词", "ORDER-2024 是什么错误", "ORDER-2024"),
    ("关键词", "ERR-502 怎么处理", "ERR-502"),
    ("关键词", "型号 X100 支持退货吗", "X100"),
    ("关键词", "条款 3.2 说了什么", "3.2"),
    ("关键词", "客服几点上班", "工作日 9:00"),
]

def hit_at_3(results: list[str], gold: str) -> bool:
    return any(gold in r for r in results[:3])

for qtype in ("语义", "关键词"):
    for _, query, gold in [t for t in TESTS if t[0] == qtype]:
        h = [doc for doc, _ in hybrid_search(query, k=3)]
        print(qtype, hit_at_3(vector_search(query), gold),
              hit_at_3(bm25_search(query), gold), hit_at_3(h, gold))
```

判分标准用 Hit@3：目标切块进了某路结果的前三就算命中。一次典型跑分长这样（你的数字随语料浮动，但格局基本一致）：

| 题目类型 | 向量 | 纯 BM25 | Hybrid |
| --- | --- | --- | --- |
| 语义类（5 题） | 5/5 | 1/5 | 5/5 |
| 关键词类（5 题） | 1/5 | 5/5 | 5/5 |
| 合计（10 题） | 6/10 | 6/10 | 10/10 |

对着表读三行结论。向量在关键词类那侥幸的 1 题，多半是错误码旁边恰好跟了一段语义相关的说明；BM25 在语义类那 1 题，是问法和文档碰巧共享了一个实词。各掉的 4 题恰好是对方的满分项，RRF 融合后互相补位，10 题全中。这就是 Hybrid 的全部卖点：两路通吃。

::: tip 判分小贴士
命中片段要在你写题目时顺手标好，10 行人工标注的事，别省。片段选目标切块里独有的一小段（错误码本身、某句特有措辞），别选「订单」这种满库都是的词，不然命中判定会虚高。
:::

## 常见踩坑

**坑 1：中文不分词直接喂 rank_bm25。** `BM25Okapi` 收的是 token 列表，你把整句字符串塞进去，它就当这是一个词。查询和文档永远「不重合」，分数全是零，关键词路形同虚设。记住：语料和查询必须过同一个 `tokenize`，连 `lower()` 这种预处理都要一致，一边有一边没有，大小写不同的同一个词就对不上。

**坑 2：文档更新只重嵌了向量，忘了重建 BM25 索引。** 上周说「换 Embedding 模型要整库重嵌」，BM25 同理换了个说法：它的 IDF 统计和索引都基于建库那一刻的全量语料，新文档进了 `documents` 表却没进 `bm25` 对象，关键词路就开始悄悄漏召回。量在几千块以内，全量重建是毫秒级的事，别过早优化增量索引，把「入库」这一个动作同时驱动两路更新写清楚就行。

**坑 3：手痒给 RRF 加权重。** 写成 `Σ w_i / (k + rank_i)` 想让向量路多占点比重？恭喜，一夜回到加权融合的调参地狱。RRF 值钱就值钱在无参：只看排名不看分数，天然免归一化。真要动，只有 k 一个旋钮，60 是原论文验证过的稳健值，动它之前先拿今天的 10 题实验跑个对比，拿数据说话。

**坑 4：指望 Hybrid 救烂切块。** 错误码表被切块拦腰截断，码在前一块、处理办法在后一块，两路检索都只能捞回半截，RRF 融合的是两份残缺候选。检索算法再高级，索引单元本身残缺就都是白搭。切块质量是检索质量的地基，先修地基再换房顶，顺序不能倒。

**坑 5：无脑把 Hybrid 设成默认。** 一句话权衡：Hybrid 每次查询跑两路，计算和延迟接近翻倍，如果你的场景里用户问法很规范、几乎没有字面查询，BM25 路常年空转，白付成本。正确姿势是先跑今天这张三列表，确认 BM25 路真的在救场，再把它固化进主链路。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 「ORDER-2024 是什么错误」这种查询，向量检索为什么会漏掉目标切块？

::: details 参考答案
Embedding 压缩的是语义，错误码这类编号在训练语料里稀少，它映射出的向量位置与「库存锁定超时」等真实语义没有稳定关联，问题向量与答案切块的方向离得远，Top-K 被「订单」相关的语义近邻占满。向量擅长「意思近」，不擅长「字面同」。
:::

2. BM25 的两个核心信号是什么，各自的直觉含义？

::: details 参考答案
词频 TF：查询词在该文档出现越多越相关，增益有饱和，堆词刷分无效。逆文档频率 IDF：词在全体语料越稀有区分度越高，「的」毫无区分度、「ORDER-2024」一锤定音。合起来是「稀有词重合度」，外加长度归一化防长文档占便宜。
:::

3. 中文用 rank_bm25，哪一步是生死线？要满足什么条件？

::: details 参考答案
分词。中文没有空格，整句不分词就是单个 token，词频统计无从谈起。条件是语料和查询过同一个分词函数（jieba + 相同预处理如 lower），任何一边不一致，重合就断了。
:::

4. 写出 RRF 公式，说明它为什么不需要调权重。

::: details 参考答案
score(d) = Σ 1/(k + rank_i(d))，k 常取 60。它只使用排名不用原始分数，天然规避两路分数量纲不可比的问题；唯一参数 k 有原论文验证的稳健默认值 60，不需要像加权融合那样逐场景调 α 和归一化方式。
:::

5. 既然 Hybrid 两类通吃，为什么不无脑默认全开？

::: details 参考答案
每次查询要跑两路，计算成本和延迟接近翻倍；若场景里几乎全是规范问法的语义查询，BM25 路常年空转。先用评估集（如今天的 10 题）确认关键词路真的在救场，再固化成默认。
:::

## 延伸阅读

- [rank_bm25](https://github.com/dorianbrown/rank_bm25)，今天用的 BM25 实现，README 里对 BM25 变体的说明值得扫一眼
- [jieba](https://github.com/fxsjy/jieba)，中文分词事实标准，`cut` 的精确模式与全模式区别建议了解
- [Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods](https://dl.acm.org/doi/10.1145/1571941.1572114)，RRF 原论文（SIGIR 2009），k=60 的出处

今天的产出 `hybrid_retrieval.py` 留好，两路检索加 RRF 这套骨架，是本周后续每一项升级的地基。
