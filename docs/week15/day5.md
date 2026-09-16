# 第 15 周 · Day 5：RAG 评估——Precision/Recall/F1/nDCG，把「感觉更准了」换成四个数字

> 对应手册任务：学习「RAG 评估：Precision/Recall/F1/nDCG」，动手「用 10 个测试问题计算检索指标，对比优化前后」，当日产出「评估报告」。本篇只解决一个问题：本周优化做了一堆，Hybrid、Rerank、Adaptive 全上了线，怎么证明真的变好了——「感觉更准了」不算证据，今天用 10 道标注好金标准的测试题换四个可复现的数字，让每一项优化都被数字证明，而不是被感觉说服。生成层和 Agent 层的评估是第 16 周的主菜，本篇给整套评估体系打地基。

## 今日目标

1. 说得清为什么凭感觉不行：不可复现、不可回归、不可对比，评估集就是 RAG 的单元测试
2. 掌握四个指标的手算：Precision（检回的多少相关）、Recall（相关的检回多少）、F1（调和平均）、nDCG（排序质量），每个都亲手算一遍小例
3. 独立完成评估脚本和 AB 实验：10 题跑分，纯向量 vs Hybrid vs Hybrid+Rerank 三配置四指标一张表，本周 Day 1/2 的优化此刻被数字证明，当日产出评估报告

## 概念讲解：为什么凭感觉不行

这一周下来，你在检索上动的刀不少：Hybrid 双路合击、Cross-Encoder 重排序、Adaptive 动态路由（完整日程见[第 15 周目录](/week15/)）。现在有人问一句：优化了这么多，效果到底提升多少？

你脱口而出的答案多半是「感觉更准了」。这三个字在企业场景里等于没说，三个问题它一个都答不了。

第一，不可复现。感觉今天好明天差：同一句话跑十遍，运气好十遍都命中，运气差第一屏全是无关块。到底是系统变好了，还是这道题撞上了，说不清。

第二，不可回归。明天你改了切块大小，或者换了个 rerank 模型，效果是升了还是降了？没有基线数字，你只能再「感觉」一次。感觉没法 diff，而工程迭代全靠 diff。

第三，不可对比。老板问「比商用搜索差多少」，同事说「我觉得还不如上周」，各说各话。没有统一口径，争论就没有裁判。

这三条是不是很眼熟？单元测试天生就干这三件事：用例固定（可复现）、每次提交跑一遍（可回归）、通过率可以横向比（可对比）。评估集就是 RAG 的单元测试——把 10 个问题连同标准答案写死在文件里，每次改检索链路就跑一遍，数字掉了就不许合并。人工标注要花半小时一小时，但标一次永久复用，这笔账怎么算都划算。

再划清今天的边界：只评估检索层。检索是 RAG 的地基，检索不进来，后面的生成全是空谈；而且它评估起来最便宜——不用跑 LLM 判分，拿检索结果和金标准做个集合比对就完事，结果完全确定。至于「答案质量高不高」「Agent 任务完没完成」，那是生成层和 Agent 层的评估，第 16 周的主菜，今天先把地基打牢。

## 核心知识

### 1. 评估集：10 题 + 金标准，人工标注一次，永久复用

评估集的每条记录只有两个字段：问题（query），和这个问题的相关 chunk id 集合（金标准，ground truth）。Day 1 的对比实验用的是「命中片段」判分——目标切块里独有的一小段文字，检回的块包含它就算命中。那是 Hit@K 的粗判分，能回答「命中没有」，回答不了「检回的 5 块里几块相关」「正确的块排第几」。今天升级成 chunk id 级的金标准：

```python
EVAL = [
    # query 自己定，relevant 是人工标注的相关 chunk id 集合（换成你库里的真实 id）
    {"query": "住宿标准一晚多少钱",     "relevant": {12}},
    {"query": "买完不想要了怎么办",     "relevant": {23}},
    {"query": "出差回来钱怎么报",       "relevant": {12, 34}},  # 相关块可以有多块，都标上
    {"query": "ORDER-2024 是什么错误", "relevant": {57}},
    {"query": "客服几点上班",           "relevant": {41}},
    # ... 共 10 题：语义类 5 题、关键词类 5 题，题目直接沿用 Day 1 的那批
]
```

标注怎么做：把全量切块打印出来人工翻，或者用关键词在库里搜，看到目标块就记下它的 id。id 不需要是数据库主键，加载顺序的下标就行——只要评估集和检索结果引用同一份 chunks 列表，两边就对得上。

出题的原则沿用 Day 1：语义类换着说法问，问题和目标块尽量零关键词重合；关键词类直接带错误码、型号、编号。另外建议补一两道「知识库里根本没有答案」的边界题，它的正确表现是检不回任何相关块——这恰好也是 Day 4 诚实降级的回归用例。

### 2. Precision / Recall / F1：三个数字各答一个问题

设一个具体场景手算。金标准 relevant = {12, 34}，检索器返回 top5 = [12, 88, 91, 34, 7]。

Precision@5 检回的里面多少相关：命中 12 和 34 两块，5 块里中 2 块，P = 2/5 = 0.40。它衡量纯度，P 低说明上下文里塞满无关块，既浪费 token 又带偏 LLM。

Recall@5 相关的里面检回多少：2 块相关全检回来了，R = 2/2 = 1.00。它衡量查全，R 低才是真正的「漏」，答案压根没送进上下文，LLM 再聪明也编不回来。

F1 是两者的调和平均：F1 = 2 × P × R / (P + R) = 2 × 0.40 × 1.00 / 1.40 ≈ 0.57。为什么用调和而不是算术平均？算术平均 (0.40 + 1.00) / 2 = 0.70，P 等于零它也能拿 0.50 的分。调和平均会被短板死死拖住：P = 0 时 F1 = 0，想拿高分必须两头都行。

三个函数，每个都不超过 5 行：

```python
def precision_at_k(retrieved: list[int], relevant: set[int], k: int) -> float:
    """检回的前 k 个里，相关块占比"""
    hits = sum(1 for cid in retrieved[:k] if cid in relevant)
    return hits / k

def recall_at_k(retrieved: list[int], relevant: set[int], k: int) -> float:
    """所有相关块里，被检进前 k 的占比"""
    hits = sum(1 for cid in retrieved[:k] if cid in relevant)
    return hits / len(relevant)

def f1(p: float, r: float) -> float:
    """调和平均，短板决定上限"""
    return 2 * p * r / (p + r) if p + r else 0.0
```

### 3. nDCG：正确答案排第 1 和排第 5，得分必须不同

P、R、F1 有一个共同的盲区：只看「进了前 5 没有」，不看排在第几位。做个思想实验，还是 relevant = {12, 34}，三个检索器同样检回这两块：

```text
A: [12, 34, 88, 91, 7]   两块排在第 1、2 位
B: [12, 88, 91, 34, 7]   排在第 1、4 位
C: [7, 88, 91, 12, 34]   排在第 4、5 位
```

三者的 P@5、R@5、F1 一模一样。但对 RAG 来说天差地别：top_k = 4 送进 Prompt 时，C 的 34 根本没进上下文；就算进了，LLM 对长上下文中段的注意力也明显偏弱（lost in the middle 现象）。对只看前几条的 LLM，位置就是效果。

nDCG 给前排加权，专治位置盲。二值相关度下，DCG@k = Σ 1/log2(rank+1)，rank 从 1 数起：第 1 位得分 1/log2(2) = 1，第 2 位 1/log2(3) ≈ 0.63，第 4 位 ≈ 0.43，越靠后折扣越狠。再除以理想排序的 DCG（IDCG）归一到 0 和 1 之间，就是 nDCG。手算一遍：

- A 的 DCG = 1 + 0.63 = 1.63，理想排序也是把两块放第 1、2 位，IDCG = 1.63，nDCG = 1.00
- B 的 DCG = 1 + 0.43 = 1.43，nDCG = 1.43 / 1.63 ≈ 0.88
- C 的 DCG = 0.43 + 0.39 = 0.82，nDCG ≈ 0.50

同样的召回，nDCG 拉开 1.0 到 0.5 的差距，全在位置上。实现：

```python
import math

def ndcg_at_k(retrieved: list[int], relevant: set[int], k: int) -> float:
    """排序质量：相关块排得越靠前分越高，理想排序为 1.0"""
    dcg = sum(
        1 / math.log2(rank + 1)
        for rank, cid in enumerate(retrieved[:k], start=1)
        if cid in relevant
    )
    ideal = sum(
        1 / math.log2(rank + 1)
        for rank in range(1, min(len(relevant), k) + 1)
    )
    return dcg / ideal if ideal else 0.0
```

关键在分母 ideal：相关块全部挤到前排时的 DCG 得分。没有这一步归一，题目相关块数量不同就没法跨题平均。

## 动手任务：`eval_retrieval.py` 一步一步

手册任务：用 10 个测试问题计算检索指标，对比优化前后。拆成 5 步，含标注全程约 30 分钟。前提是本周的 `hybrid_retrieval.py` 还能跑：第 14 周的 pgvector 库在，Day 1 的 BM25 链路在。

**第 1 步：建文件、加载切块、标注金标准。** 新建 `eval_retrieval.py`，先把底座搭好：

```python
import math
import jieba
import psycopg
from rank_bm25 import BM25Okapi
from openai import OpenAI

client = OpenAI()  # 读环境变量 OPENAI_API_KEY
CONN = "postgresql://postgres:你的密码@localhost:5432/rag_lab"

def tokenize(text: str) -> list[str]:
    return [t.lower() for t in jieba.cut(text) if t.strip()]

with psycopg.connect(CONN) as conn, conn.cursor() as cur:
    cur.execute("SELECT chunk FROM documents")
    chunks = [r[0] for r in cur.fetchall()]

text_to_id = {c: i for i, c in enumerate(chunks)}  # 库里有重复文本时先去重，或改用表主键
bm25 = BM25Okapi([tokenize(c) for c in chunks])
print(f"共 {len(chunks)} 块，id 就是下标")
```

标注别靠肉眼硬翻，写个辅助函数按关键词定位：

```python
def find_ids(keyword: str) -> list[int]:
    """按关键词在库里找 chunk，打印 id 和前 40 字，标注时用"""
    hits = [i for i, c in enumerate(chunks) if keyword in c]
    for i in hits:
        print(i, chunks[i][:40])
    return hits

find_ids("ORDER-2024")  # 看到目标块的 id，抄进 EVAL 的 relevant
```

然后把核心知识第 1 节的 `EVAL` 填成真实标注：10 题，语义类 5 题关键词类 5 题，题目沿用 Day 1 的那批，每题的 relevant 换成你刚标出来的 id。这半小时是全周性价比最高的投入。

**第 2 步：抄指标函数。** 把核心知识第 2、3 节的四个函数原样抄进文件：`precision_at_k`、`recall_at_k`、`f1`、`ndcg_at_k`。可以用一个小例自测：`ndcg_at_k([12, 34, 88, 91, 7], {12, 34}, 5)` 应该得 1.0，`[7, 88, 91, 12, 34]` 应该在 0.5 附近。对得上，说明抄对了。

**第 3 步：三路检索统一返回 chunk id。** 照抄 Day 1 的函数，唯一的改动是返回值从切块文本换成 id（下标）：

```python
def embed_query(query: str) -> list[float]:
    resp = client.embeddings.create(model="text-embedding-3-small", input=query)
    return resp.data[0].embedding  # 与入库时同一个模型，铁律不变

def vector_ids(query: str, k: int = 5) -> list[int]:
    vec = "[" + ",".join(str(x) for x in embed_query(query)) + "]"
    sql = "SELECT chunk FROM documents ORDER BY embedding <=> %(vec)s::vector LIMIT %(k)s;"
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(sql, {"vec": vec, "k": k})
        return [text_to_id[r[0]] for r in cur.fetchall()]  # 文本映射回 id

def bm25_ids(query: str, k: int = 5) -> list[int]:
    scores = bm25.get_scores(tokenize(query))
    ranked = sorted(range(len(chunks)), key=lambda i: scores[i], reverse=True)
    return ranked[:k]

def rrf_ids(rankings: list[list[int]], k: int = 60) -> list[int]:
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, cid in enumerate(ranking, start=1):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (k + rank)
    return [cid for cid, _ in sorted(scores.items(), key=lambda kv: kv[1], reverse=True)]

def hybrid_ids(query: str, k: int = 5) -> list[int]:
    return rrf_ids([vector_ids(query, k=10), bm25_ids(query, k=10)])[:k]
```

三路签名刻意做成一致：进 query，出「按相关度降序的 id 列表」。这个统一接口是第 4 步 AB 实验能一行切换配置的前提。

**第 4 步：三配置 AB 跑分。** 固定 embedding 不动，把 Day 2 的重排序接进来（没留 Day 2 模块的，用下面这个 Cross-Encoder 现写一份）：

```python
# pip install sentence-transformers
from sentence_transformers import CrossEncoder

ce = CrossEncoder("BAAI/bge-reranker-base")  # Day 2 同款思路，已有封装就换成你的函数

def rerank_ids(query: str, cand: list[int], k: int = 5) -> list[int]:
    scores = ce.predict([(query, chunks[i]) for i in cand])
    ranked = sorted(zip(cand, scores), key=lambda x: x[1], reverse=True)
    return [cid for cid, _ in ranked[:k]]

CONFIGS = {
    "纯向量":        lambda q: vector_ids(q, k=5),
    "Hybrid":        lambda q: hybrid_ids(q, k=5),
    "Hybrid+Rerank": lambda q: rerank_ids(q, hybrid_ids(q, k=20), k=5),
}

def avg(xs: list[float]) -> float:
    return sum(xs) / len(xs)

print(f"{'配置':<16}{'P@5':>8}{'R@5':>8}{'F1':>8}{'nDCG@5':>10}")
for name, fn in CONFIGS.items():
    ps, rs, fs, ns = [], [], [], []
    for case in EVAL:
        got = fn(case["query"])
        p = precision_at_k(got, case["relevant"], 5)
        r = recall_at_k(got, case["relevant"], 5)
        ps.append(p); rs.append(r); fs.append(f1(p, r))
        ns.append(ndcg_at_k(got, case["relevant"], 5))
    print(f"{name:<16}{avg(ps):>8.2f}{avg(rs):>8.2f}{avg(fs):>8.2f}{avg(ns):>10.2f}")
```

一次典型跑分长这样（数字随语料浮动，格局基本一致）：

| 配置 | P@5 | R@5 | F1 | nDCG@5 |
| --- | --- | --- | --- | --- |
| 纯向量 | 0.36 | 0.62 | 0.44 | 0.51 |
| Hybrid | 0.64 | 0.86 | 0.72 | 0.74 |
| Hybrid+Rerank | 0.70 | 0.88 | 0.77 | 0.93 |

对着表读三行结论。Hybrid 相对纯向量：R@5 从 0.62 到 0.86，关键词类那 5 题从大片漏检变成基本全中，Day 1 的双路合击被 Recall 证明了。Rerank 相对 Hybrid：R@5 几乎不动，nDCG@5 从 0.74 跳到 0.93，重排不产生新候选，只是把候选池（top20）里的相关块顶到前排，所以收益全在排序质量上。这就是四个指标都要看的原因：只盯 Recall，你会误以为 Rerank 没用；只盯 nDCG，你又看不见 Hybrid 在救召回。

**第 5 步：写评估报告。** 当日产出，直接套这个模板：

```markdown
# RAG 检索层评估报告 v1（2026-09-16）

## 评估配置
- 评估集：10 题（语义 5 / 关键词 5），金标准共 13 个相关 chunk，含 1 道无答案边界题
- 指标口径：P@5 / R@5 / F1 / nDCG@5，二值相关度
- 环境锁死：embedding text-embedding-3-small，切块 512/64，pgvector 余弦距离

## 指标结果
（贴第 4 步的表）

## 结论
1. Hybrid 相对纯向量：R@5 +0.24，关键词类召回大幅修复
2. Rerank 相对 Hybrid：nDCG@5 +0.19，收益在排序，召回持平

## 下一步
- 用同一张表验证 Day 3 的 Adaptive 路由是否值得开
- 评估集扩到 30 题，补边界题，金标准随语料更新维护
```

报告存进 `eval_report.md`，连同 `EVAL` 一起进版本库。

::: tip 评估集要版本化
`EVAL` 写死在一个文件里、跟着代码提交，就是给检索层建了一套回归测试。以后任何人改检索（换模型、调切块、加权重），跑一遍脚本、diff 两张表，升降一目了然。评估集本身也该像代码一样 review：题目偏了，所有数字都是假的。
:::

## 常见踩坑

**坑 1：拿评估集调参，把考题当练习题刷。** 看到某题 nDCG 低，就针对性改检索器直到这题满分——10 题的评估集很快全绿，但这是过拟合到考题，第 11 题立刻现原形。规矩一条：评估集只用来打分，调参和试错用另一批查询，两边永不混用。

**坑 2：金标准漏标。** 一个问题实际有 3 块相关，你只标了 1 块，检索器检回另外 2 块反而被判「不相关」，Precision 被冤枉压低，越好的检索器罚分越重。标注时用 `find_ids` 把同主题的块都翻一遍，宁可多标，别让正确的检索吃罚分。

**坑 3：指标口径漂移。** 今天 P@5、明天 P@3，上周报告写 nDCG@10，跨版本对比全是错位比较。K 值、指标定义、金标准版本，三样都要写进报告。diff 指标之前，先 diff 口径。

**坑 4：换了 embedding 还拿新数字比旧基线。** embedding 一换，整个向量空间重建，旧报告瞬间变成另一个世界的成绩单；切块粒度、评估集本身变了，同理。结论：环境里任何一项变更，旧基线全部作废，所有配置必须同场重跑再比，AB 实验的「固定 embedding」锁的是全套变量。

**坑 5：评估集全是送分题。** 10 题都是检索器最容易答的类型，指标漂亮，用户不买账。题目要覆盖语义类、关键词类，再留边界题：知识库根本不覆盖的问题，它的「正确」是检不回相关块。全对不代表系统好，可能只是考卷太软。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 「感觉更准了」缺了哪三样？评估集分别怎么补上？

::: details 参考答案
可复现：题目和金标准固定在文件里，跑多少遍结果一致。可回归：每次改检索链路重跑一遍，数字和基线 diff，掉了就拦。可对比：统一指标口径，不同配置同场竞技。本质是把单元测试的机制搬进 RAG。
:::

2. 金标准 relevant = {A, B, C}，top5 = [B, X, A, Y, Z]，算 P@5、R@5、F1。

::: details 参考答案
命中 2 块。P@5 = 2/5 = 0.40；R@5 = 2/3 ≈ 0.67；F1 = 2 × 0.40 × 0.67 / (0.40 + 0.67) ≈ 0.50。注意 F1 用调和平均，被 P 和 R 里较小的那个拖住，两头都得行分数才上得去。
:::

3. 两个配置都检回了全部相关块，F1 相同，nDCG 一个 1.0 一个 0.5，差在哪？为什么这对 RAG 尤其要紧？

::: details 参考答案
差在位置：一个把相关块全排在前排，一个沉到第 4、5 位。P/R/F1 位置盲，nDCG 按名次给折扣（第 1 位 1 分、第 2 位 0.63，递减）。RAG 里 LLM 只看前几条，top_k 截断可能直接切掉后排，加上 lost in the middle，位置差异就是效果差异。
:::

4. Recall@5 = 1.0 但 Precision@5 = 0.2，说明什么？该怎么修？

::: details 参考答案
相关的全捞回来了，但混在一堆无关块里：候选面宽、排序弱。两条路：加重排把相关块顶到前排（提 nDCG）；或减小送进 Prompt 的 K，等于用更小的窗口提 Precision。反过来，P 高 R 低才是召回不足，该扩候选或上 Hybrid。
:::

5. AB 对比三配置时，除了固定 embedding，还有哪些变量必须锁死？

::: details 参考答案
同一份切块库（切块粒度一变历史数字作废）、同一评估集与金标准版本、同一个 K、同一套指标实现、相同的 rerank 候选面大小。任何一项变了，新旧数字不可比，全部配置必须同场重跑。
:::

## 延伸阅读

- [ragas](https://github.com/explodinggradients/ragas)，RAG 评估框架，检索指标之外还有忠实度、答案相关性等生成层指标，第 16 周还会遇到它
- [Discounted cumulative gain（Wikipedia）](https://en.wikipedia.org/wiki/Discounted_cumulative_gain)，DCG/nDCG 的完整定义，包括分级相关度的扩展形式，想深究公式的从这里进
- [BEIR](https://github.com/beir-cellar/beir)，信息检索零样本评估基准，覆盖 18 个数据集，想看检索模型的真实排位去这里

今天的产出 `eval_retrieval.py` 和评估报告留好：这 10 题是接下来所有检索改动的回归防线，第 16 周把评估从检索层扩到生成层和 Agent 层，这套「先建金标准、再算指标、同场对比」的打法原样复用。
