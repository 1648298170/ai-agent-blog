# 第 15 周 · Day 2：重排序——两阶段检索的第二道关卡

> 对应手册任务：学习「重排序（Re-ranking）」，动手用 Cross-Encoder 或 Cohere Rerank 对检索结果重排，当日产出 `rerank.py` 重排序模块。本篇只解决一个问题：昨天的 Hybrid 检索已经能把大致相关的 50 条捞出来，但真正能回答问题的那几条可能排在第 6、第 8 位，直接取 top5 就把它们扔了——用一个更强的模型给这 50 条重新打分排序，让最相关的浮到最上面。

## 今日目标

1. 说得清 Bi-Encoder 和 Cross-Encoder 各自的快与慢、粗与准，以及为什么标准架构是「召回 50 → 精排 5」
2. 跑通两条路线：本地 sentence-transformers 加载 bge-reranker-base，以及 API 路线 Cohere Rerank
3. 独立完成 `rerank.py`，接在 Hybrid 检索之后，用同一组 10 道题对比重排前后的 top3 命中率

## 概念讲解：为什么召回之后还要再排一次

拿 10 道测试题跑昨天（[第 15 周](/week15/) Day 1）的 Hybrid 检索，你会看到一个反复出现的模式：答案所在的 chunk 大多在 top10 之内，但未必在 top3。它安安静静躺在第 6 名、第 8 名，而你取 top5 喂给大模型，正好把它拦在门外。

问题不在召回，在排序。BM25 和向量检索都是「宽进」的设计，从几万条里毫秒级捞出几十条沾边的，这活它们干得漂亮；但「哪条最该进 Prompt」这个精细判断，它们干不了。

根本原因在向量检索的编码方式。Bi-Encoder（双塔模型）把 query 和文档分别、独立地压缩成一个向量，两边全程互相看不见。文档向量入库时预计算好，查询时只编码一次 query，然后算余弦相似度——快就快在这。代价也在这：几百字的 chunk 被压成一个几百维的向量，压缩必然有损，「Python」和「Java」是两种语言、「支持退款」和「不支持退款」意思相反，这类细节在各自压成摘要的那一刻就糊掉了。余弦相似度算的是两份摘要像不像，不是逐字逐句的比对。

Cross-Encoder（交叉编码器）反着来：query 和文档拼成一段文本，一起送进模型。Transformer 的 attention 让 query 里的每个词都能盯着文档里的每个词看，token 级的比对发生在每一层，最后直接输出一个相关性分数。准的原因就这么朴素：不压缩、不摘要，原文全量参与判断。拿「Java 读文件的 N 种方式」去配「Python 怎么读文件」的 query，双塔给分不低，因为语义摘要都是「编程·读取·文件」；交叉模型里 Python 和 Java 两个词面对面站着，一眼就知道语言对不上。

但 Cross-Encoder 快不了。每来一个新 query，都要和每条候选拼成一对、各跑一次完整的前向传播，而且永远无法预计算——文档的分数依赖 query 在场，离线算不出来。10 万条语料就是 10 万次前向传播，用户等不起。

两个模型各有一头硬伤，于是业界把它们拼成流水线：Bi-Encoder 当门卫，从 10 万条里毫秒级捞出 50 条大概相关的，这叫召回；Cross-Encoder 当终审，只审这 50 对，几百毫秒打出精细分数，取前 5 进生成，这叫精排。先粗筛，再精选。像招聘：先用关键词筛掉 1000 份简历，再让用人经理细读留下的 50 份。没有公司让经理读 1000 份，也没人只凭关键词筛完直接发 offer。

## 核心知识

本节的代码都是独立小示例，可以单独跑。最终完整文件以下面的动手任务为准。

### 1. 双塔 vs 交叉：一张表看懂

| 维度 | Bi-Encoder（双塔） | Cross-Encoder（交叉） |
|---|---|---|
| 输入方式 | query、doc 分别编码 | query + doc 拼接后一起进模型 |
| 文本交互 | 无，只在最后算余弦 | 每层 attention 全量交互 |
| 能否预计算 | doc 向量可离线入库 | 不能，每对必须现算 |
| 单查询代价 | 编码 1 次 query + ANN 查询 | 每条候选一次前向传播 |
| 典型延迟 | 毫秒级（10 万级语料） | 50 对数百毫秒 |
| 排序质量 | 粗，长尾 query 常错序 | 精细，token 级比对 |
| 流水线职责 | 召回：10 万 → 50 | 精排：50 → 5 |

关键差别在第一行「输入方式」：它决定了交互发生在编码之后（算个相似度就完）还是编码之中（attention 全程参与），也决定了能否预计算，进而决定了各自的速度、精度和职责。表里最后两行连起来读，就是两阶段架构本身。

### 2. 本地路线：bge-reranker-base

用 sentence-transformers 的 `CrossEncoder` 类，装包、加载、打分三步走。

```python
# pip install sentence-transformers
# 注意：依赖链会连带装上 PyTorch，体积以 GB 计，磁盘和内存都留点余量
from sentence_transformers import CrossEncoder

model = CrossEncoder("BAAI/bge-reranker-base")

query = "如何配置数据库连接池的超时时间"
docs = [
    "连接池的 max_lifetime 默认 30 分钟，超过后连接会被回收重建。",
    "HTTP 客户端的 timeout 参数控制单次请求的最长等待时间。",
    "连接池打满后，新请求进入队列排队，直到有空闲连接释放。",
]

pairs = [[query, doc] for doc in docs]   # 每对是 [query, doc]
scores = model.predict(pairs)             # 逐对打分，返回分数数组
print(scores)                             # 形如 [ 6.7 -2.1  4.4]，越大越相关
```

关键在 `pairs` 的形状：必须是 `[[query, doc], ...]` 的列表，query 在前 doc 在后，顺序反了分数就全歪。`predict` 返回的分数是原始 logits，可正可负，只看相对大小，别拿绝对值当阈值。分数到手，排序一行：

```python
ranked = sorted(zip(docs, scores), key=lambda p: p[1], reverse=True)
for doc, score in ranked:
    print(f"{score:6.2f} | {doc}")
```

bge-reranker-base 基于多语言底座，中文效果好，权重约 1GB，CPU 也能跑，只是 50 对从几百毫秒变成一秒上下。国内网络环境建议先设 `HF_ENDPOINT=https://hf-mirror.com` 再下载模型，会顺很多。

### 3. API 路线：Cohere Rerank

不想装 torch 就走 API：注册 Cohere 拿个 key，`pip install cohere` 完事，无 GPU 无重依赖。

```python
import cohere

client = cohere.ClientV2("你的_API_KEY")

results = client.rerank(
    model="rerank-v3.5",
    query="如何配置数据库连接池的超时时间",
    documents=docs,   # 同上面那三条例子
    top_n=3,          # 只返回前 3 条
)

for hit in results.results:
    print(hit.index, f"{hit.relevance_score:.4f}", docs[hit.index])
```

关键在返回结构：`results.results` 里每一项带 `index`（原列表下标）和 `relevance_score`（归一化到 0~1 的分数），结果已按分数降序排好，`top_n` 直接控制留几条。代价是按调用量计费，以及数据要出境。国产替代一句话：Jina 的 Rerank API 参数形态和 Cohere 几乎一致，换 host 就能接；硅基流动、阿里百炼这类国内平台也托管了 bge-reranker、gte-rerank 系列，调用同理。

### 4. 融合位置：挂在召回之后、生成之前

整条链路长这样：

```text
用户提问
   │
   ▼
Hybrid 检索（BM25 + 向量双路，RRF 融合）       ← 10~50 ms
   │  50 条候选 chunk（粗排，顺序不可靠）
   ▼
Cross-Encoder 重排（query × 50 逐对打分）      ← 100~600 ms
   │  取 top 5（精排，顺序可信）
   ▼
拼接 Prompt → LLM 生成                         ← 1~3 s
```

两个数字都有讲究。召回宽度 50：池子越小，召回阶段排在 10 名开外的相关 chunk 越可能直接出局，重排再强也变不出不在场的东西；池子越大，延迟线性上涨。最终 top 5：进 Prompt 的 chunk 不是越多越好，上下文一长，中间的内容容易被模型忽略，还抬高生成延迟和费用。两个数字都从 50 和 5 起步，用下面的对比实验校准。

### 5. 延迟账：几百毫秒花在哪

| 阶段 | 典型耗时 | 说明 |
|---|---|---|
| Hybrid 召回 | 10~50 ms | 向量 ANN + BM25 倒排，全吃预计算红利 |
| 本地重排（GPU） | 50~150 ms | 50 对批处理打分 |
| 本地重排（CPU） | 300~1000 ms | 能跑，预算紧时掂量 |
| API 重排 | 200~600 ms | 含网络往返 |
| LLM 生成 | 1000~3000 ms | 真正的大头 |

账面结论：重排加的是几百毫秒，换的是进 Prompt 内容的质量跃升，而整条链路的大头本来就是生成的 1~3 秒，这笔钱花得值。反过来，召回的几十毫秒已是链路里最便宜的环节，别在那儿过度打磨——优化优先级应该是生成 > 重排 > 召回。

## 动手任务：`rerank.py` 一步一步

手册任务：写一个重排序模块，对 Hybrid 检索的 50 条候选重排取 5。拆成 5 步，全程约 30 分钟。

**第 1 步：建文件。** 在本周练习目录新建 `rerank.py`。下面每步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：先定接口，不写实现。**

```python
from typing import List, Tuple

def rerank(query: str, docs: List[str], top_n: int = 5) -> List[Tuple[str, float]]:
    """按与 query 的相关性对 docs 重排，返回前 top_n 条 (doc, score)。"""
    raise NotImplementedError
```

关键在这一步的顺序：接口先于实现定死。输入 query 加候选列表，输出排好序的 (doc, score)，后面本地模型和 API 随便换，调用方一行不改——重排策略就此被隔离成一个可替换的模块。

**第 3 步：本地实现（懒加载单例）。**

```python
from sentence_transformers import CrossEncoder

_model = None

def _get_model():
    global _model
    if _model is None:
        _model = CrossEncoder("BAAI/bge-reranker-base")  # 首次调用才加载，约 1GB
    return _model

def rerank(query: str, docs: List[str], top_n: int = 5) -> List[Tuple[str, float]]:
    model = _get_model()
    pairs = [[query, doc] for doc in docs]
    scores = model.predict(pairs)
    ranked = sorted(zip(docs, scores), key=lambda p: p[1], reverse=True)
    return [(doc, float(score)) for doc, score in ranked[:top_n]]
```

关键在 `_get_model` 的写法：模块导入时不碰模型，第一次调用才加载，之后常驻内存。要是把 `CrossEncoder(...)` 直接写进 `rerank` 里，每次查询都重读一遍 1GB 权重，延迟从几百毫秒涨到十几秒。

**第 4 步：API 版实现。**

```python
import cohere

_client = cohere.ClientV2("你的_API_KEY")

def rerank_api(query: str, docs: List[str], top_n: int = 5) -> List[Tuple[str, float]]:
    results = _client.rerank(
        model="rerank-v3.5",
        query=query,
        documents=docs,
        top_n=top_n,
    )
    return [(docs[hit.index], hit.relevance_score) for hit in results.results]
```

签名和第 2 步完全一致，两个实现随时互换。跑通其中一个即可，机器吃紧选 API 版。

**第 5 步：接进 Hybrid 流水线，跑对比实验。**

```python
def answer(query: str) -> str:
    candidates = hybrid_search(query, top_k=50)    # 昨天的模块：召回 50 条
    top_docs = rerank(query, candidates, top_n=5)  # 今天的新模块：精选 5 条
    context = "\n\n".join(doc for doc, _ in top_docs)
    return llm_generate(f"请根据以下资料回答问题。\n\n{context}\n\n问题：{query}")
```

实验这么跑：准备 10 道测试题，每道在语料里标注唯一一份支撑 chunk，对每题分别记录「只用 Hybrid 召回的 top3」和「rerank 后的 top3」里支撑 chunk 的名次。下表摘 4 行示意格式（名次与合计均为示意，你的数字取决于自己的语料）：

| 题号 | 重排前支撑 chunk 名次 | 重排后名次 | top3 命中变化 |
|---|---|---|---|
| Q1 | 2 | 1 | 命中，升到第 1 |
| Q2 | 7 | 2 | 未命中 → 命中 |
| Q3 | 1 | 1 | 命中，稳住 |
| Q4 | 未进前 50 | 未进前 50 | 双双未命中，问题在召回宽度 |
| …… | …… | …… | …… |
| 合计 | top3 命中 6/10 | top3 命中 9/10 | +30 个百分点 |

典型规律很稳：原本卡在 4~10 名的「漏网之鱼」被捞进 top3，原本第 1 的保持不动，top3 命中率普遍涨一到三成。特别注意 Q4 这种情况：chunk 根本没进 50 条候选池，重排模型见都见不到，自然无能为力——这类题告诉你该加大 top_k 或改召回，而不是换更强的重排模型。这张表就是告诉你「该调召回还是该调重排」的听诊器。

::: tip 资源清单
本地路线两笔开销：`pip install sentence-transformers` 连带 PyTorch，体积以 GB 计；模型权重约 1GB，首次运行自动下载，国内建议先设 `HF_ENDPOINT=https://hf-mirror.com`。CPU 能跑通全部代码，只是重排一步从几百毫秒变一秒上下。机器或网络吃紧，直接走第 4 步的 API 版。
:::

## 常见踩坑

**坑 1：分数跨模型比大小。** bge-reranker 吐的是原始 logits，可正可负、范围不固定；Cohere 给的是归一化到 0~1 的分数。两套分数混在一张排序表里，等于拿公斤和市尺比长短。想加「分数低于 X 就丢弃」的过滤，先把自己的分数分布打出来看再定，不同模型的及格线完全不是一回事。

**坑 2：传错重排粒度。** Cross-Encoder 要吃 `[[query, chunk原文], ...]` 这样的逐对输入。有人把候选列表 join 成一大段传进去，有人传了文档标题或 metadata JSON——模型看到的和召回回来的不是同一个东西，分数自然歪。标题里没有答案细节，重排完等于白排。

**坑 3：每次查询都加载模型。** 模型加载写进查询函数里，每次调用都从磁盘读权重再初始化，单次延迟翻几十倍。模型要全局加载一次、常驻内存，参考动手任务第 3 步的懒加载写法。

**坑 4：候选池大小拍脑袋。** 池给 10 条，相关 chunk 在召回阶段排 15 名，根本进不了池，重排再神也救不回来；池给 500 条，延迟按倍数涨，命中率提升却边际递减。从 50 起步，用第 5 步的对比实验找自己语料的平衡点。

**坑 5：想用重排替代召回。** 跑通之后容易冒出「全库直接 rerank 多准」的念头。算笔账：10 万 chunk，每对一次前向传播，哪怕批处理优化，也是分钟级的单次查询延迟。两阶段架构存在的意义，就是让 Cross-Encoder 永远只碰召回塞给它的那一小撮。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Bi-Encoder 快在哪、Cross-Encoder 准在哪？根源是不是同一个差别？

::: details 参考答案
是，都源自「输入方式」。双塔把 query 和 doc 分别独立编码，doc 向量可离线预计算，查询时只编码一次 query 再做 ANN，所以快；但两条文本互不可见，交互只剩最后的余弦相似度，细节全丢，所以粗。交叉模型把两段拼在一起进模型，attention 让 token 级交互发生，所以准；但每对都要一次前向传播且无法预计算，注定只能小范围用。
:::

2. 为什么是「召回 50 → 精排 5」，而不是向量直接取 top5，或者全库精排？

::: details 参考答案
直接 top5 依赖召回模型的排序质量，相关文档常卡在 4~10 名被截掉；全库精排意味着每个 query 对全库每条做一次前向传播，分钟级延迟不可用。两阶段让便宜模型干重活（10 万 → 50）、贵模型干细活（50 → 5），延迟可控，排序质量接近全库精排。
:::

3. bge-reranker 的分数和 Cohere 的 relevance_score 能放进同一张排序表、共用一个阈值吗？

::: details 参考答案
不能。前者是未归一化的 logits（可正可负），后者归一到 0~1。跨模型比较无意义；任何「大于 X 才送进 Prompt」的阈值都要针对单一模型的分数分布实测校准。
:::

4. 重排模块插在流水线哪个位置？top_n 为什么常取 5 上下？

::: details 参考答案
Hybrid 召回之后、拼 Prompt 进 LLM 之前。top_n 是上下文预算：chunk 太多会稀释注意力（排在中间的内容容易被模型忽略）、拖慢生成；太少容易漏掉支撑文档。5 是常见起点，语料越杂可适当加大，用对比实验定。
:::

5. 整条 RAG 链路给你 3 秒预算，各阶段怎么分？优化先优化哪段？

::: details 参考答案
召回几十毫秒，重排几百毫秒，剩下的秒级全给 LLM 生成。优化优先级是生成 > 重排 > 召回：把召回从 10ms 磨到 5ms，用户毫无感知，属于过度优化；把生成模型的输出从 3 秒压到 2 秒，用户立刻有感。
:::

## 延伸阅读

- [sentence-transformers 官方文档：Cross Encoder](https://sbert.net/docs/package_reference/cross_encoder.html)，本地路线的 API 出处，`predict` 的参数和返回都在这
- [BAAI/bge-reranker-base 模型页](https://huggingface.co/BAAI/bge-reranker-base)，中文重排的主力模型，base 之上还有 large 版本可升级
- [Cohere Rerank 官方指南](https://docs.cohere.com/docs/rerank)，API 路线的参数、模型版本与速率限制说明

今天的产出 `rerank.py` 留好，`rerank(query, docs, top_n)` 这个接口形状后面做检索评估、换重排模型时还会反复用到。
