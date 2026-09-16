# 第 14 周 · Day 6：相似度检索——余弦距离 + Top-K，让问题找到最相关的 5 个切块

> 对应手册任务：学习「相似度检索：余弦距离 + Top-K」，动手实现「给定问题，检索最相似的 5 个切块」，当日产出检索函数。本篇只解决一个问题：前五天攒下的向量还躺在库里没人用，今天把「提问」这头接上线，问题变向量、按余弦距离排序、取最像的 K 个，一条从问题通向知识的路今天打通。

## 今日目标

1. 说得清检索流水线的三步：问题 Embedding、余弦距离排序、Top-K 截断，以及为什么问题和文档必须用同一个 Embedding 模型
2. 掌握三个写法：`<=>` 操作符与 `ORDER BY ... LIMIT k` 的检索 SQL、`search(query, k=5)` 函数封装、`metadata->>'source'` 过滤检索
3. 亲手跑一次失败检索：亲眼看一个超纲问题照样返回 5 条「矮子里拔将军」的结果，理解 RAG 为什么会一本正经地答错

## 概念讲解：检索是 RAG 的腰

过去五天你一直在备菜：解析文档、切块、Embedding、入库。库里的向量安静地躺着，没人动过。今天第一次点菜：用户提一个问题，系统从几千个切块里挑出最相关的几个，交给明天的 LLM 去组织答案。

这一步为什么值得单开一天？因为 RAG 答案质量的上限，在检索那一刻就定死了。LLM 再会写，喂进来的上下文不对，它只能就着错料编出一篇流畅的错话。老话 garbage in, garbage out，放进 RAG 里就是：检索烂，生成必烂。反过来，检索准了，一个便宜的小模型也能答得有板有眼。

那「找相关」在向量世界里是什么？一个句子的 Embedding 是高维空间里的一个点，方向编码语义：意思近的句子，方向也近。于是「找相关文档」变成一道几何题：把问题也变成这个空间里的点，找离它方向最接近的那几个。

衡量「方向接近」，文本检索默认用余弦相似度：只看两个向量的夹角，不看长度。夹角为零相似度是 1，方向相反是 -1，日常文本大多落在 0 到 1 之间。pgvector 把它包装成操作符 `<=>`，算的是余弦距离，等于 1 减相似度：距离越小越像。完整检索就一句 SQL：按距离升序排，取前 K 条。Top-K 不是什么算法，就是 ORDER BY 加 LIMIT。

还有一件事必须现在说死：问题必须用和文档入库时同一个 Embedding 模型。向量只有在同一个坐标系里才能比距离。text-embedding-3-small 是 1536 维，你换一个 1024 维的开源模型去嵌问题，数据库直接报维度不匹配；更阴险的是两个不同模型维度恰好一样的情况，距离算出来全是噪声，检索表面正常，结果悄悄全错。换模型等于换坐标系，旧向量全部作废，整库重嵌，没有例外。

## 核心知识

本节的代码块都是独立示例，先看懂，最终完整文件以下面的动手任务为准。前提是 Day 5 已完成：PostgreSQL 启用了 pgvector，`documents` 表有 `chunk`（文本）、`embedding vector(1536)`、`metadata jsonb` 三列且导入了数据。列名不一样的，把 SQL 对应位置改成你的就行。

### 1. 一条 SQL 就是检索引擎

```sql
-- $1 是问题的向量，文本形式，如 '[0.012, -0.37, ...]'，共 1536 个数
SELECT chunk,
       1 - (embedding <=> $1) AS score,
       metadata
FROM documents
ORDER BY embedding <=> $1
LIMIT 5;
```

pgvector 提供三种距离操作符，认全它们，以后看别人的代码不懵：

| 操作符 | 距离类型 | 什么时候用 |
| --- | --- | --- |
| `<=>` | 余弦距离 | 文本检索默认，看方向不看长度 |
| `<->` | 欧氏距离（L2） | 几何意义上的直线距离 |
| `<#>` | 负内积 | 向量未归一化时的选择 |

关键有两处。第一，`ORDER BY embedding <=> $1`：`<=>` 返回距离，越小越像，ORDER BY 默认升序，正好把最相关的排最前。第二，`score` 那一列算的是 `1 - 距离`，把距离换算回余弦相似度，分数越大越相关，给人看的时候直觉得多。两条并存：排序用距离，展示用相似度。

至于 Top-K，`LIMIT 5` 就是它本身，K=5。向量检索的「检索」就是一次带距离排序的数据库查询，没有黑魔法。

### 2. score 怎么读，K 怎么定

两个最常被问的问题，都没有标准答案，但都有靠谱的定法。

先说 score。余弦相似度理论范围是 -1 到 1，实际文本 Embedding 的结果几乎都在 0 到 1 之间。「多高算相关」没有一条普世的线：同一个模型，换一批文档、换一种问法，分数分布整体会漂。网传的「0.7 以上才相关」当故事听就行。正确做法是标定：从你的库里抽 20 到 50 个真实问题，人工标注每条检索结果相关还是不相关，看两组分数各落在哪一段，在两段之间切一刀。这刀只对你的「模型 + 文档 + 问法」组合负责，换任何一样，重标。

再说 K。K 是漏召回和引噪声之间的平衡：K 太小，答案恰好被切在两个切块的边界上时就漏了；K 太大，不相关的切块挤进上下文，既稀释模型注意力，又实打实多花生成的 token 钱。K 还和切块大小联动：切块平均 500 字，K=5 就是约 2500 字进提示词，K=10 直接翻倍。经验起步值就是 3 到 5，然后拿真实问题各跑一遍，对比答案质量再定终值。

### 3. metadata 过滤：先圈范围，再比向量

库里迟早不止一份文档：产品手册、退货政策、FAQ 全在一张表里。用户问退货，你不想让 FAQ 的切块来凑热闹。Day 3 埋的 metadata 这时兑现：

```sql
SELECT chunk, 1 - (embedding <=> $1) AS score, metadata
FROM documents
WHERE metadata->>'source' = 'refund-policy.pdf'
ORDER BY embedding <=> $1
LIMIT 5;
```

`->>` 是 PostgreSQL 的 jsonb 操作符，按 key 取值并转成 text，这样才能和普通字符串比较。WHERE 先把候选集圈到一份文档里，再在圈内做余弦排序。多文档库的标配，封装函数时把它做成一个可选参数。

## 动手任务：`search()` 与 `retrieve` 一步一步

手册任务：实现「给定问题，检索最相似的 5 个切块」并封装成检索函数。拆成 5 步，全程约 30 分钟。今天的产出是 `retriever.py`，明天 Day 7 直接拿它拼最小 RAG。

**第 1 步：建文件、装依赖。** 本周练习目录新建 `retriever.py`。沿用 Day 4 的 `openai` 和 Day 5 的 PostgreSQL，今天要用的数据库驱动是 psycopg 3：

```bash
pip install "psycopg[binary]" openai langchain-core
```

**第 2 步：写 `embed_query` 和最小版 `search`。** 先不管过滤，把主链路跑通：

```python
import psycopg
from openai import OpenAI

client = OpenAI()  # 读环境变量 OPENAI_API_KEY
CONN = "postgresql://postgres:你的密码@localhost:5432/rag_lab"

def embed_query(query: str) -> list[float]:
    """问题 → 向量。必须与 Day 4 入库时同一个模型，换了模型整库重嵌。"""
    resp = client.embeddings.create(
        model="text-embedding-3-small",  # 与入库一致，一个字符都不能差
        input=query,
    )
    return resp.data[0].embedding

def search(query: str, k: int = 5) -> list[dict]:
    vec = "[" + ",".join(str(x) for x in embed_query(query)) + "]"
    sql = """
        SELECT chunk,
               1 - (embedding <=> %(vec)s::vector) AS score,
               metadata
        FROM documents
        ORDER BY embedding <=> %(vec)s::vector
        LIMIT %(k)s;
    """
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(sql, {"vec": vec, "k": k})  # 参数化查询，绝不手拼 SQL
        rows = cur.fetchall()
    return [
        {"chunk": r[0], "score": round(r[1], 4), "metadata": r[2]}
        for r in rows
    ]

if __name__ == "__main__":
    for h in search("退货流程是什么？", k=5):
        print(h["score"], h["metadata"].get("source"), h["chunk"][:40])
```

关键一行是 `vec = "[" + ",".join(...)`：pgvector 接受文本形式的向量字面量，所以把 1536 个浮点数拼成方括号字符串，再靠 `::vector` 转型。模型名必须与 Day 4 入库那个完全一致，这是今天的第一铁律。

**第 3 步：三类问题实测，认识 score 的脾气。** 往 `__main__` 里换着跑，盯住 score：

```python
print(search("退货流程是什么？", k=5))              # 库内知识，问法和文档措辞接近
print(search("买完不想要了怎么办？", k=5))           # 库内知识，换口语问法
print(search("黑洞蒸发辐射的物理机制是什么？", k=5))  # 超纲问题，库里根本没有
```

前两个是正常检索。第二个的 score 会比第一个低一截，因为口语问法和文档措辞的方向差得更远，但仍能召回对的内容，这正是余弦检索值钱的地方。第三个是今天的重头戏：超纲问题照样返回 5 条。Top-K 是矮子里拔将军，库里的每一块都会被比出个远近，哪怕最近的也压根不相关。具体分数取决于你的文档，拿它跟前两个问题的分数一对比就有数了。把这个现象记下来：到了生成那一步，LLM 拿着这几块不相关的上下文，很可能一本正经地编出一段「看起来有出处」的回答。这是 Naive RAG 的固有缺陷，第 15 周的评估会专门拿今天这个失败案例开刀，现在的任务是亲眼见到它。

**第 4 步：加 `source` 参数。** 把核心知识第 3 节的过滤合进函数，默认不过滤，传了就只搜一份文档：

```python
def search(query: str, k: int = 5, source: str | None = None) -> list[dict]:
    vec = "[" + ",".join(str(x) for x in embed_query(query)) + "]"
    sql = """
        SELECT chunk,
               1 - (embedding <=> %(vec)s::vector) AS score,
               metadata
        FROM documents
        WHERE (%(source)s::text IS NULL OR metadata->>'source' = %(source)s)
        ORDER BY embedding <=> %(vec)s::vector
        LIMIT %(k)s;
    """
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(sql, {"vec": vec, "source": source, "k": k})
        rows = cur.fetchall()
    return [
        {"chunk": r[0], "score": round(r[1], 4), "metadata": r[2]}
        for r in rows
    ]

# search("退款多久到账？")                              # 全库搜
# search("退款多久到账？", source="refund-policy.pdf")  # 只搜退货政策这一份
```

关键在 WHERE 那行：`%(source)s::text IS NULL OR ...` 是「没传就不过滤」的惯用写法，一个函数覆盖两种场景，不用维护两条 SQL。

**第 5 步：包成 LangGraph 工具。** 本周 Day 1 说过 RAG 和 Agent 的两种集成姿势：一种把检索写死在流程里，问题来了先检索再生成，明天 Day 7 走这条路；另一种把检索包成工具交给 Agent，让它自己判断要不要查、查什么。第二种今天就能落地：

```python
from langchain_core.tools import tool

@tool
def retrieve(query: str) -> str:
    """在知识库中检索与问题最相关的文档切块。
    当用户问题涉及产品手册、退货政策等库内文档内容时调用。"""
    results = search(query, k=5)
    if not results:
        return "知识库中没有找到相关内容。"
    return "\n\n".join(
        f"[{i}] score={r['score']:.2f} source={r['metadata'].get('source', '?')}\n{r['chunk']}"
        for i, r in enumerate(results, 1)
    )

print(retrieve.invoke("退货要多久到账？"))
```

docstring 不是注释，是给模型看的工具说明书，写清「什么时候该调我」。`retrieve.invoke(...)` 用来单独测试；接进 LangGraph 图就是第 11 周的老动作：`model.bind_tools([retrieve])`，路由、节点、条件边你全都会。到这一步，RAG 和 Agent 正式合体。

::: tip 环境与索引
`CONN` 里的密码别硬编码，改用环境变量。今天几千条数据全表扫也够快，数据量上来后记得给 embedding 列建索引：`CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);`，否则检索延迟会随数据量线性变差。
:::

## 常见踩坑

**坑 1：换了 Embedding 模型，新旧向量混着用。** 最经典也最致命。维度不同的直接报维度不匹配的错，一眼能查；维度恰好相同但模型不同的不报错，检索表面正常，分数全是噪声，你会误判成「模型效果不行」。记住换模型等于换坐标系：模型一换，全库重嵌，别无他法。防呆手段是把模型名写进 metadata 或单独一列，检索时校验。

**坑 2：距离和相似度搞混，排序反了。** `<=>` 是距离，越小越像；score 是 `1 - 距离`，越大越像。有人把距离直接当 score 返回，页面上的「0.85 分」其实是全场最不相关的。自查方法：拿一句明知在库里的原文去搜，它必须排第一，且分数接近 1。

**坑 3：照抄别人的阈值。** 「0.7 以上才算相关」这类数字，离开别人的模型和语料就是废纸。阈值只能自己标：抽样、人工标注、看分布、切一刀，四步缺一不可。抽检不狠，阈值不准。

**坑 4：手拼 SQL 塞向量。** 1536 个浮点数拼进 SQL 字符串，引号、精度、转义全是坑，还带注入风险。永远用参数化查询让驱动传值，今天的 `%(vec)s::vector` 写法照抄就行。

**坑 5：K 一把梭到 20 求稳。** K 大不等于稳，不相关切块挤进上下文反而把模型带偏，token 账单还翻几倍。从 3 到 5 起步，配合切块大小估算上下文体积，用真实问题做对比再定。K 是超参数，不是安全感。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么问题必须用和文档入库相同的 Embedding 模型？换模型会发生什么？

::: details 参考答案
向量只有处在同一坐标系里才能比距离，同一个模型产出的向量才共享坐标系。换成维度不同的模型，数据库直接报维度不匹配；换成维度恰好相同的其他模型，距离算出来全是噪声，检索表面正常实际全错。换模型的正确姿势是整库重新 Embedding。
:::

2. `<=>` 返回的是相似度还是距离？检索 SQL 里的 score 是怎么算出来的？

::: details 参考答案
`<=>` 返回余弦距离，等于 1 减余弦相似度，值越小越相关，所以 ORDER BY 默认升序排出来就是最相关的在前。score 用 `1 - (embedding <=> $1)` 把距离换算回相似度，越大越相关，便于人读。
:::

3. K 取 3 还是 10，背后是哪两股力量在拉扯？

::: details 参考答案
一边是漏召回：K 太小，答案跨在切块边界上时就漏掉关键内容。另一边是噪声和成本：K 太大，不相关切块稀释模型注意力，还按切块长度推高生成的 token 开销。定法是 3 到 5 起步，结合切块平均大小估算上下文体积，用真实问题对比答案质量后落定。
:::

4. `metadata->>'source' = 'xx.pdf'` 在检索里起什么作用？`->>` 是什么？

::: details 参考答案
先按元数据把候选集圈定到某份文档，再在圈内做向量排序，避免多文档库里不相干文档的切块来凑数。`->>` 是 PostgreSQL 的 jsonb 操作符，按 key 取值并返回 text，这样才能和普通字符串做相等比较。
:::

5. 超纲问题为什么也能检索出 5 条结果？这暴露了 RAG 的什么风险？

::: details 参考答案
Top-K 检索永远返回「库里相对最近」的 K 条，哪怕最近的也不相关，它没有「全都无关就返回空」的概念。风险在生成端：LLM 拿着不相关的上下文照样能编出流畅、有模有样的回答，用户无从分辨。这是 Naive RAG 的固有缺陷，第 15 周的评估会量化它。
:::

## 延伸阅读

- [pgvector GitHub](https://github.com/pgvector/pgvector)，三种距离操作符、索引类型（HNSW / IVFFlat）与查询语法的权威出处
- [OpenAI Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)，模型选择、维度与用量的官方说明，坑 1 的原始依据
- [LangChain：Retrievers 概念](https://python.langchain.com/docs/concepts/retrievers/)，检索器抽象的定位与接口，看懂 `@tool` 版 retrieve 在整个生态里的位置

今天的 `retriever.py` 留好。明天 Day 7 把 `search()` 的输出拼进提示词、接上 LLM，端到端跑通「上传 PDF → 提问 → 返回答案」，日程见[本周计划](/week14/)；第 15 周评估登场时，今天那个超纲问题的检索结果还会回来当主角。
