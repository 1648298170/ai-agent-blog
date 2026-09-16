# 第 15 周 · Day 3：Adaptive RAG——先给问题画像，再决定检索下多重

> 对应手册任务：学习「Adaptive RAG：查询分类 + 动态权重」，动手「判断查询类型（事实型/分析型），动态调整检索策略」，当日产出 `adaptive_rag.py` Adaptive 检索模块。本篇只解决一个问题：现在的管线对什么问题都是「Hybrid 召回 50 → 重排 → 取 5」一套打天下，用户问一句「你好」也要付全套检索的钱和延迟——今天在管线最前面加一个分类器，先判断问题是什么类型，再按类型选检索策略：闲聊秒答、事实轻查、分析重查。

## 今日目标

1. 说得清固定管线在真实流量下的两笔亏：闲聊问题白付检索加重排的成本，事实型问题被大候选池的噪声稀释
2. 掌握三件事：问题画像的两个维度（类型、复杂度）、用 `RouterSchema` 让 LLM 做结构化分类、LangGraph 条件边按类型路由
3. 独立完成 `adaptive_rag.py`：三类问题各跑一遍，用一张延迟和 token 对照表亲眼看到「策略跟着问题变」

## 概念讲解：为什么一套管线不能包打天下

先看昨天（[第 15 周](/week15/) Day 2）收工时的管线：`hybrid_search` 召回 50 条，`rerank` 精选 5 条，拼 Prompt 进 LLM。对着这套管线，看三个真实会撞进客服系统的问题：

- 「你好，你能做什么？」
- 「退货要在几天内发起？」
- 「对比一下差旅报销和招待报销的流程差异」

第一个，知识库里根本没有它的答案。检索引擎从 50 条候选里挑出的东西和这个问题毫无关系，embed 白算、重排白跑，最后这些不相干的文本还挤进 Prompt，占上下文、占费用、占延迟。

第二个，答案安安静静躺在某一块文档里。向量检索的 top3 十有八九第一名就命中，跑 BM25、RRF 融合、Cross-Encoder 给 50 对打分，全是杀鸡用牛刀。更糟的是候选池一大，「同主题但不相关」的块混进来，重排之后照样有漏网之鱼挤进 top5，反而稀释注意力。

第三个才配得上重炮。答案散在好几块文档里，差旅一块、招待一块、审批流程各一块，top3 根本盖不住，必须宽召回、重重排、多喂几块。

三道题，三种命运，管线却只有一条。固定管线的账就这么记：每一问都按最重的跑，闲聊用户等四秒换来一句「你好」，账单上每一问都是双路检索加 50 对重排加几千 token 生成。反过来一刀切省成本，全走 top3，第三道题立刻塌方。问题不在管线太强或太弱，在「不分青红皂白」。

所以今天的思路一句话：先看问题，再下菜。在检索前面加一个查询分类器（Router），给每个问题做画像，按画像走不同强度的检索分支。这就是 Adaptive RAG。盘点一下零件：结构化输出是第 11 周学的，按结果分发任务是第 13 周 Supervisor 的老招，Hybrid 检索和重排是本周前两天的产出。没有一样新技术，新的是组合——让「选策略」这件事本身，变成管线里的一个环节。

## 核心知识

本节的代码都是独立小示例，可以单独跑。最终完整文件以下面的动手任务为准。

### 1. 问题画像：类型 × 复杂度，两个维度

第一维度，类型，直接决定检索走哪条路：

| 类型 | 判定标准 | 例子 | 检索策略 |
|---|---|---|---|
| factual 事实型 | 单点查证，一块文档能答 | 退货要在几天内发起 | 向量 top3，快而准 |
| analytical 分析型 | 综合、对比、归纳多份资料 | 对比两类报销流程差异 | Hybrid 50 → rerank → 8 |
| chitchat 闲聊型 | 不依赖知识库 | 你好 / 你是谁 | 跳过检索，直接答 |

chitchat 这一行值得单独说：它的答案就在模型参数里，「你好」不需要查任何文档。对它做检索，除了花钱和拖慢首响，没有任何收益——省成本提速度，是分类器最立竿见影的兑现。

第二维度，复杂度：同一类型内部还有深浅。「退货几天」和「跨境电商退货遇到清关卡住怎么办」都是 factual，后者可能要翻好几块文档才说得清。今天先把复杂度记进画像（simple / deep），策略矩阵暂时只按类型分。字段先行、规则渐进，是画像设计的常规做法：维度留好，路由规则后面随时往上加，调用方一行不用改。

### 2. RouterSchema：让 LLM 当分类器

为什么用 LLM 当分类器，而不是写关键词规则或训练一个小模型？规则枚举不完，用户问法无穷无尽；小模型要先攒标注数据。LLM 加少样本示例加强制结构化输出，半小时就能上线，还能顺手给出置信度。

照第 11 周的老办法，用 pydantic 定义输出契约：

```python
from typing import Literal
from pydantic import BaseModel, Field

class RouterSchema(BaseModel):
    query_type: Literal["factual", "analytical", "chitchat"] = Field(
        description="问题类型：factual=单点事实查证；analytical=需综合多份资料；chitchat=寒暄闲聊，不需要查知识库")
    complexity: Literal["simple", "deep"] = Field(
        description="复杂度：simple=一两句话能答清；deep=需要展开深挖")
    confidence: float = Field(ge=0, le=1, description="分类把握，0 到 1")
    reason: str = Field(description="一句话判断依据")
```

关键在 `Literal[...]`：取值被锁死在三选一，配合结构化输出模式，模型吐出来的必须是字段合法的 JSON——不是「大概像」，是解析不了当场报错。这比「让 LLM 写一段自由文本，再用正则去抠」可靠得多，正则解析是脆弱的字符串猜谜，结构化输出是硬契约。

调用本体：

```python
from openai import OpenAI

client = OpenAI()

resp = client.beta.chat.completions.parse(
    model="gpt-4o-mini",
    messages=[
        {"role": "system", "content": CLASSIFY_PROMPT},
        {"role": "user", "content": "退货要在几天内发起？"},
    ],
    response_format=RouterSchema,
)
route = resp.choices[0].message.parsed   # 直接是 RouterSchema 实例
print(route.query_type, route.confidence) # factual 0.9 上下
```

分类准不准，七成看 `CLASSIFY_PROMPT` 里的示例。除了每类给正例，必须给边界例子，尤其是「寒暄加正题」的混合句——「你好，顺便问下退货多久到账」这种，必须判 factual。示例在动手任务第 2 步给全。

### 3. 策略矩阵：一张表定全家

分类结果落到检索参数，全部规则就一张表：

| 路由结果 | 检索分支 | 召回宽度 | 进 Prompt | 延迟量级 | token 量级（入+出） |
|---|---|---|---|---|---|
| chitchat | 跳过检索，直接生成 | 0 | 0 | 1 秒上下 | 400 上下 |
| factual | 向量 top3 | 3 | 3 | 2 秒上下 | 1200 上下 |
| analytical | Hybrid → rerank | 50 | 8 | 4 秒上下 | 2600 上下 |
| 回退 | 按 analytical 走 | 50 | 8 | 4 秒上下 | 2600 上下 |

（数字为量级示意，以你自己实测为准，动手任务第 5 步就是测它。）

表里每个数字都有讲究。factual 只取 3：单点查证的目标切块在向量排序里通常就排第 1、2 位，K 越大越容易混进同主题的噪声块，既稀释注意力又多花生成 token。analytical 召回 50 精选 8：答案散在多块文档，漏一篇就缺一角，召回必须宽；宽了排序就糙，所以 rerank 必须上；多文档综合需要足够的上下文面，8 是起点。

最后一行是回退规则：confidence 低于 0.7，或分类调用干脆失败，一律按 analytical 走完整管线。方向要保守——分类器拿不准时，宁可多花几百毫秒和一点 token，不能让该检索的问题裸奔。省小钱答错题，是大亏。

### 4. LangGraph：管线从一条线变成一张图

前两天的管线是直线，函数串下来就行。今天有了分支，「按类型走不同路」，正好用 LangGraph 把管线显式画成图：分类是一个节点，路由是条件边，三条检索分支各是一个节点。

```python
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

class RAGState(TypedDict):
    query: str
    route: RouterSchema | None
    docs: list[str]
    answer: str

def route_by_type(state: RAGState) -> str:
    r = state["route"]
    if r is None or r.confidence < 0.7:
        return "analytical"            # 回退：保守走完整管线
    return r.query_type

builder = StateGraph(RAGState)
builder.add_node("classify", classify_node)
builder.add_node("chitchat", chitchat_node)
builder.add_node("factual", factual_node)
builder.add_node("analytical", analytical_node)
builder.add_node("generate", generate_node)

builder.add_edge(START, "classify")
builder.add_conditional_edges(
    "classify", route_by_type,
    {"chitchat": "chitchat", "factual": "factual", "analytical": "analytical"},
)
builder.add_edge("chitchat", END)         # 闲聊不进生成，直接收工
builder.add_edge("factual", "generate")   # 两条检索支路汇进同一个生成节点
builder.add_edge("analytical", "generate")
builder.add_edge("generate", END)

graph = builder.compile()
```

对着图读一遍流程：问题进 `classify`，条件边看画像——chitchat 直奔 END，factual 和 analytical 各自检索后汇进 `generate`。`route_by_type` 就是那个 if-else，只不过它活在图里。图化换来三样东西：状态在节点间自动流转（分类结果存进 `state["route"]`，算一次全图可用）；结构显式（策略矩阵和图一一对应，编译出的图对象能直接打印成结构图）；可扩展（后面加检索质量自评、失败重试，只是往图上加节点和环，主干不动）。这就是 Agentic RAG 的雏形：管线从一条固定直线，变成一张会看情况走路的图。

## 动手任务：`adaptive_rag.py` 一步一步

手册任务：判断查询类型（事实型/分析型），动态调整检索策略。拆成 5 步，全程约 30 分钟。前提是前两天的产出还在同目录：`hybrid_retrieval.py` 和 `rerank.py` 能跑。

**第 1 步：建文件、装依赖。** 本周练习目录执行：

```bash
pip install langgraph pydantic
```

沿用本周的 `openai`、`hybrid_retrieval` 和 `rerank`，新建 `adaptive_rag.py`。下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：RouterSchema 和分类器，带兜底。** 把核心知识第 2 节的 schema 抄进来，再加上 prompt 和带异常保护的分类函数：

```python
CLASSIFY_PROMPT = """你是客服系统的查询分类器，判断用户问题的类型：
- chitchat：寒暄、打招呼、问你是谁。注意：只要问题里含任何需要查资料的实质问题，就不是 chitchat。
- factual：单点事实查证，一份文档即可回答。如：退货要在几天内发起？
- analytical：需要综合、对比、归纳多份资料。如：对比差旅报销和招待报销的流程差异。

示例：
问：你好 → chitchat
问：你能干什么 → chitchat
问：你好，顺便问下电子发票多久能开好 → factual（含实质问题，按实质部分判）
问：把差旅报销和招待报销的流程差异整理成一张表 → analytical
只输出分类结果。"""

def classify_query(query: str) -> RouterSchema | None:
    try:
        resp = client.beta.chat.completions.parse(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": CLASSIFY_PROMPT},
                {"role": "user", "content": query},
            ],
            response_format=RouterSchema,
        )
        return resp.choices[0].message.parsed
    except Exception as e:
        print(f"分类失败，走完整管线：{e}")
        return None
```

关键在返回类型 `RouterSchema | None`：解析失败、超时、返回不合法，统统接住返回 None。分类器不能是单点故障，它崩了管线跟着崩，这是回退机制的第一半。

**第 3 步：三条策略分支。** 复用前两天的模块，每条分支只干自己的活：

```python
from hybrid_retrieval import vector_search, hybrid_search  # Day 1 产出
from rerank import rerank                                  # Day 2 产出

def llm_generate(prompt: str) -> str:
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
    )
    return resp.choices[0].message.content or ""

def chitchat_node(state: RAGState) -> dict:
    reply = llm_generate(
        f"用户对客服系统说：{state['query']}\n"
        "请友好简短地回应。不要编造任何知识库信息。"
    )
    return {"answer": reply, "docs": []}

def factual_node(state: RAGState) -> dict:
    return {"docs": vector_search(state["query"], k=3)}       # 小 K 精准

def analytical_node(state: RAGState) -> dict:
    candidates = [d for d, _ in hybrid_search(state["query"], k=50)]
    top = rerank(state["query"], candidates, top_n=8)          # 大池重排
    return {"docs": [d for d, _ in top]}

def classify_node(state: RAGState) -> dict:
    return {"route": classify_query(state["query"])}

def generate_node(state: RAGState) -> dict:
    context = "\n\n".join(state["docs"])
    return {"answer": llm_generate(
        f"请根据以下资料回答问题。\n\n{context}\n\n问题：{state['query']}")}
```

看一眼策略矩阵是怎么落进代码的：factual 一行向量调用收工，analytical 才是「召回 50 → 重排 8」的重炮，chitchat 压根不碰检索。三条分支互不知道对方存在，换任何一条的策略，另外两条一行不改。

**第 4 步：组装图，跑通三类问题。** 把核心知识第 4 节的 `RAGState`、`route_by_type` 和建图代码抄进来，文件末尾加：

```python
if __name__ == "__main__":
    for q in [
        "你好，你能做什么？",
        "退货要在几天内发起？",
        "对比一下差旅报销和招待报销的流程差异",
    ]:
        result = graph.invoke({"query": q})
        label = result["route"].query_type if result["route"] else "fallback"
        print(f"[{label}] {q}")
        print(f"  检索 {len(result['docs'])} 块 | {result['answer'][:50]}...")
```

一次正常跑通长这样（回答内容取决于你的语料）：

```text
[chitchat] 你好，你能做什么？
  检索 0 块 | 你好！我是客服助手，可以帮你查售后政策、报销流程……
[factual] 退货要在几天内发起？
  检索 3 块 | 签收后 7 日内可以发起退货，请在订单页……
[analytical] 对比一下差旅报销和招待报销的流程差异
  检索 8 块 | 两者的差异主要在审批环节：差旅是部门负责人……
```

三行输出的第一列就是路由结果。要是 factual 被判成了 chitchat，答案又像编的，回第 2 步检查 prompt 示例——边界混合句的示例是分类质量的生命线。

**第 5 步：成本对比实验。** 分类和生成两次 LLM 调用都要记账，先给 `llm_generate` 和 `classify_query` 各加两行：调用前 `usage_log.append({"in": resp.usage.prompt_tokens, "out": resp.usage.completion_tokens})`，再把 main 块换成带计时的版本：

```python
import time

def run_once(query: str) -> None:
    usage_log.clear()
    start = time.perf_counter()
    result = graph.invoke({"query": query})
    elapsed = time.perf_counter() - start
    tin = sum(u["in"] for u in usage_log)
    tout = sum(u["out"] for u in usage_log)
    label = result["route"].query_type if result["route"] else "fallback"
    print(f"{label:11s} | 检索 {len(result['docs'])} 块 "
          f"| {elapsed:4.1f}s | token {tin}/{tout}")
```

三类各跑一次（多跑几遍取平均更稳），一次典型的结果长这样（量级示意，你的数字取决于语料、模型和机器）：

| 问题 | 路由 | 检索块数 | 延迟 | token（入/出） |
|---|---|---|---|---|
| 你好，你能做什么？ | chitchat | 0 | 1.3 s | 298/52 |
| 退货要在几天内发起？ | factual | 3 | 2.2 s | 940/117 |
| 对比两类报销流程差异 | analytical | 8 | 4.4 s | 2080/305 |

对着表读结论：闲聊的延迟和 token 只有完整管线的四分之一上下，这笔节省在生产环境按闲聊占比成倍放大；factual 砍掉了双路检索和 50 对重排，延迟掉了一半；analytical 一分没省，维持重炮。Adaptive 的原则从来不是「能省则省」，是「该省的省，不该省的别硬省」。

::: tip 分类器自身的账
路由不是白来的：分类调用多花约 300 token、几百毫秒。这笔钱值不值，取决于流量结构——闲聊和简单事实题占比越高越值；如果流量几乎全是深度研究型，分类器只带来一笔固定开销。上线前拿真实日志抽 100 条看看分布，再决定阈值和策略，别拍脑袋。
:::

## 常见踩坑

**坑 1：分类失败没有回退路径。** parse 抛异常、模型返回不合法、接口超时，三种都能让分类器崩。有人 try 都不 try，分类器一崩整条管线陪葬。正确姿势参考动手任务第 2 步：捕获一切异常返回 None，路由函数把 None 当 analytical 走。回退方向想清楚：要落在「最全」的策略上，宁可多花钱，不能不检索。

**坑 2：prompt 不给边界例子。** 「你好，问下退货几天到账」这种寒暄加正题的混合句，没示例时模型摇摆，一半概率判成 chitchat，然后模型开始编退货政策——编得有鼻子有眼，这是整套方案里最危险的失败模式，因为它静默。few-shot 里必须放混合例，并写明「只要含实质问题就不是 chitchat」。

**坑 3：路由规则写死在检索函数里。** 有人把 `if query_type == ...` 塞进 `hybrid_search`，检索模块从此背着路由逻辑，改一条策略要翻检索代码。分层要清楚：分类归分类节点，路由归条件边，检索节点只管检索。策略全部长在图上，检索函数保持纯粹，明天想换策略矩阵，改一行 `route_by_type` 的事。

**坑 4：每个节点都调一次分类。** 分类结果已经存进 `state["route"]`，全图可用。有人在检索节点里又 classify 一次「保险」，图每走一步多一次 LLM 调用，token 直接翻倍。StateGraph 的 state 存在的意义就是「算一次、处处可用」，别跟它对着干。

**坑 5：跑通三个例子就宣布成功。** 路由是概率行为，不是确定性代码，单例说明不了什么。上线前用评估集说话：每类至少 10 道、专门混入边界句，跑完看三个指标——分类准确率、每类延迟、每类 token。分类错一步，后面策略再对也是白搭，所以准确率永远排第一。这套评估资产留好，以后每次调 prompt 或换分类模型都要复跑。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 三类问题的判定标准分别是什么？chitchat 为什么可以跳过检索？

::: details 参考答案
factual 是单点查证、一块文档能答；analytical 需要综合对比多份资料；chitchat 是寒暄，答案不依赖知识库，「你好」的答案在模型参数里就有。对 chitchat 做检索没有收益：捞回来的文本和问题无关，反而挤占上下文、拖慢首响、抬高费用，所以直接生成是唯一正解。
:::

2. `RouterSchema` 用 `Literal` 加结构化输出，比让 LLM 输出自由文本再正则解析，好在哪？

::: details 参考答案
`Literal` 把取值锁死在三选一，结构化输出保证返回的是能解析的合法 JSON，字段不合法当场报错而不是静默产出垃圾。自由文本加正则是脆弱的猜谜：模型多说一句话、换个措辞、加个引号，解析就崩。另外 schema 是显式契约，后续加字段（比如 complexity）调用方零改动。
:::

3. factual 为什么向量 top3 就够，analytical 为什么要 50 → rerank → 8？

::: details 参考答案
factual 的目标切块在向量排序里通常就在第 1、2 位，加大 K 只会混进同主题的噪声块，稀释模型注意力还多花生成 token。analytical 的答案散在多块文档，召回面必须宽，漏一篇就缺一角；宽召回排序必然糙，所以 Cross-Encoder 重排必须上；多文档综合需要 8 块上下的上下文面，太少撑不起对比和归纳。
:::

4. 分类器低置信度时，回退为什么落在 analytical 而不是 factual 或 chitchat？

::: details 参考答案
回退的原则是「最坏情况不答错」。拿不准时宁可多检索、多花钱、慢几百毫秒，也不能让需要资料的问题绕过检索去裸答。factual 和 chitchat 都是「少检索」方向，赌错就是幻觉；analytical 赌错的代价只是多付一次完整管线的成本。错误代价不对称时，回退永远落向安全侧。
:::

5. if-else 也能实现路由，把管线搬到 LangGraph 图上，图到底多给了什么？

::: details 参考答案
三样：状态自动流转，分类结果存进 state，算一次全图可用，不会出现每个分支重新算的浪费；结构显式，策略矩阵和图一一对应，编译出的图对象能直接打印成结构图，排查路由问题看图就行；可扩展，后面加检索质量自评、失败重试，只是往图上加节点和环，主干不动。管线从直线变图，正是 Agentic RAG 的起点。
:::

## 延伸阅读

- [Adaptive-RAG: Learning to Adapt Retrieval-Augmented Large Language Models through Question Complexity](https://arxiv.org/abs/2403.14444)，按问题复杂度自适应选择「不检索 / 单步 / 多步」的原型论文，今天这个简化版的思想出处
- [LangGraph 官方文档](https://langchain-ai.github.io/langgraph/)，StateGraph、条件边、state 流转的权威说明，值得把 Quickstart 通读一遍
- [OpenAI Structured Outputs 指南](https://platform.openai.com/docs/guides/structured-outputs)，`response_format` 配 pydantic 的用法、支持的字段类型和限制都在这

今天的产出 `adaptive_rag.py` 留好，分类节点加条件边这张图骨架，是后面给 RAG 加检索质量自评、失败重试的地基——管线一旦图化，往后的每种新策略，都只是往图上添一个节点。
