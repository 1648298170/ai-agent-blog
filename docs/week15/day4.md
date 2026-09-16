# 第 15 周 · Day 4：引用溯源——让每个结论都能回溯到原文

> 对应手册任务：学习「引用溯源：返回来源文档片段」，动手在回答中标注 `[来源1]`，前端展示可点击的引用卡片，当日产出「引用溯源 UI」。本篇只解决一个问题：检索质量上去之后，答案凭什么可信——每个结论都要能回溯到知识库原文，企业场景里没有 citation 的 RAG 等于没交付。

## 今日目标

1. 说得清引用溯源为什么是企业落地的硬需求：幻觉检测、审计合规、用户信任，一条都绕不开
2. 掌握完整数据链路：Day 2 埋下的 metadata（source/page/section）今天兑现，检索片段带编号进 Prompt，响应分离成 answer + citations
3. 独立完成引用溯源 UI：FastAPI 返回结构化 citations，Next.js 把正文 [1] 渲染成可点击上标和来源卡片，外加防漏标校验与诚实降级

## 概念讲解：为什么必须做引用溯源

到昨天为止，检索这一侧该做的基本做完了：Hybrid 混合检索、Cross-Encoder 重排序、Adaptive 动态策略（完整日程见[第 15 周目录](/week15/)）。用户问"试用期内年假有几天"，你能从员工手册里检出准确的那一段，模型也能答出"3 天"。

现在换到用户视角。他看到答案的第一反应不是鼓掌，而是"哪来的？"模型说的话不算证据。如果答不出出处，他会打开员工手册自己 Ctrl+F 一遍，那你这套 RAG 对他来说就是个更慢的搜索框。

企业客户把这件事看得更重，三个理由：

第一，幻觉检测要有抓手。引用把"信不信"的判断权交回用户：答案说 3 天，来源卡片写着"员工手册 第 12 页"，点开原文一对照，模型有没有编一眼可见。没有引用，幻觉只能靠人工抽查撞大运。

第二，审计合规。金融、医疗、法务这些行业，"模型说的"不构成证据，"模型依据某文档第几页说的"才是。事后要回溯"当时 AI 为什么给这个建议"，没有 citation 记录，这单生意根本谈不下来。所以业内有句狠话：企业 RAG 没 citation 等于没交付。

第三，用户信任是复利。带出处的答案用户敢直接转发、敢照着办事；不带出处的答案用户每条都得人工复核一遍，复核成本会吃掉 RAG 的全部收益。

那引用怎么做？先排掉一条歪路：让前端拿正则从回答正文里抠 [1][2] 再拼卡片。正文格式稍微一变就崩，模型漏标一个编号，卡片和正文立刻对不上，而且卡片需要的原文摘录、相似度分数根本不在正文里。正道是结构化分离：answer 是给人读的正文，citations 是给前端渲染的数据，两者在响应里各占一个字段，互不纠缠。

## 核心知识

### 1. 数据链路：Day 2 埋的 metadata，今天兑现

入库切分时每个 chunk 都存了 metadata（source 文件名 / page 页码 / section 章节）。前几天它们只是跟着检索结果默默流转，今天正式上岗。链路分三步。

第一步，检索结果带编号进 Prompt。重排序后的 top_k 结果按顺序编 [1][2][3][4]，连同出处拼进上下文：

```python
chunks = retriever.search(question, top_k=4)  # 沿用本周检索链路，每个 chunk 自带 metadata

lines = []
for i, c in enumerate(chunks, start=1):
    lines.append(f"[{i}]（{c['source']} 第{c['page']}页 {c['section']}）\n{c['text']}")
context = "\n\n".join(lines)
```

关键在编号 `[i]` 和出处写进了同一段文本：模型看到的每条资料都有唯一编号，引用它就有了明确语法。手册里写的标注格式是 `[来源1]`，实现时用 `[1]` 就好，数字省 token，全称交给前端卡片展示。

第二步，Prompt 强约束。光给编号不够，得明确要求模型标出来：

```python
prompt = f"""你是企业知识库助手。仅根据下面的资料回答问题，禁止使用资料之外的知识。

资料：
{context}

要求：
1. 每个结论的句末标注所依据的资料编号，格式如 [1] 或 [1][3]
2. 资料不足以回答时，直接说"知识库未覆盖该问题"，不要编造
3. 数字、日期、政策条款必须原样来自资料，禁止推测

问题：{question}"""
```

第三步，响应结构化分离。模型只输出带 [n] 标记的正文，citations 数组由后端构造。

### 2. 响应结构：citations 由后端构造，模型没机会编造

```python
from pydantic import BaseModel, Field

class Citation(BaseModel):
    no: int = Field(description="引用编号，对应正文中的 [n]")
    source: str = Field(description="来源文件名")
    page: int = Field(description="页码")
    snippet: str = Field(description="原文摘录，截 120 字左右")
    score: float = Field(description="检索相似度得分")

class RagResponse(BaseModel):
    answer: str
    citations: list[Citation] = Field(default_factory=list)
```

这里有个关键决策：为什么不让模型在结构化输出里把 citations 一并生成？因为 source、page 这些字段一旦让模型填，它就会幻觉——编一个看起来合理的页码，你根本没法核对。正确分工是：模型只决定"正文里用了哪几条"（通过 [n] 标记），后端把编号映射回检索结果的真实 metadata。数据只有一份，从数据库到卡片没有被模型转述过一次。

另外注意 `citations` 默认是空数组而不是可空：空数组是一个明确语义——"这个问题知识库没覆盖"。前端拿到空列表直接走降级展示，不用判 None。

### 3. 防漏标：Prompt 约束在前，校验器兜底在后

模型不会每次都听话。两种翻车：正文标了 [5] 但只给了 4 条资料（幽灵引用），或者 citations 里混进正文根本没引用的编号。前者是幻觉，后者是冗余，都得后检兜底：

```python
import re

CITE_RE = re.compile(r"\[(\d+)\]")

def extract_cited_numbers(answer: str) -> set[int]:
    """从正文中提取全部引用编号"""
    return {int(n) for n in CITE_RE.findall(answer)}

def sanitize_citations(answer: str, chunks: list[dict]) -> tuple[str, list[Citation]]:
    used = extract_cited_numbers(answer)
    valid = set(range(1, len(chunks) + 1))

    for ghost in used - valid:  # 幽灵引用：擦掉标记，保留句子
        answer = answer.replace(f"[{ghost}]", "")

    used &= valid
    citations = [
        Citation(
            no=i,
            source=c["source"],
            page=c["page"],
            snippet=c["text"][:120],
            score=c["score"],
        )
        for i, c in enumerate(chunks, start=1)
        if i in used  # 正文没引用的编号，不进 citations
    ]
    return answer.strip(), citations
```

关键在数据流向单一：citations 永远从"正文实际引用的编号 ∩ 真实检索结果"生成，两边对不上的部分一律丢弃。校验器还应该把擦掉幽灵引用的次数记进日志，出现频率高说明 Prompt 约束力不够，要回头改 Prompt，而不是默默兜底装没事。

### 4. 诚实降级：检索都不相关时，承认不知道

所有 score 都很低，说明知识库里根本没有能回答这个问题的内容。这时候让模型硬答，就是把 Prompt 里"资料不足别编造"那条要求当空气，产出一段一本正经的胡话。降级判断放在接口最前面：

```python
RELEVANT_THRESHOLD = 0.35  # 按你的 embedding 分数分布调，Day 5 用评估集校准

if not chunks or chunks[0]["score"] < RELEVANT_THRESHOLD:
    return RagResponse(
        answer="知识库未覆盖该问题，请换个问法，或把相关文档上传后再试。",
        citations=[],
    )
```

空 citations 加一句固定话术，比硬编一段答案强得多。用户至少知道该去补文档，而不是拿着编造的结论去开会。

## 动手任务：引用溯源 UI 一步一步

手册任务：在回答中标注 [来源1]，前端展示可点击的引用卡片。拆成 5 步，后端加前端全程约 40 分钟。`retriever` 和 `llm` 换成你本周 Day 1–3 已经跑通的检索器与模型调用封装。

**第 1 步：后端接口。** 把核心知识里的模型和校验器抄进 `main.py`，组装完整接口：

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class QuestionIn(BaseModel):
    question: str

@app.post("/api/ask", response_model=RagResponse)
def ask(payload: QuestionIn):
    chunks = retriever.search(payload.question, top_k=4)

    # 诚实降级：最高分都不过线，说明知识库没覆盖
    if not chunks or chunks[0]["score"] < RELEVANT_THRESHOLD:
        return RagResponse(
            answer="知识库未覆盖该问题，请换个问法，或把相关文档上传后再试。",
            citations=[],
        )

    # 编号上下文 + 强约束 Prompt（见核心知识 1、2 小节）
    context = "\n\n".join(
        f"[{i}]（{c['source']} 第{c['page']}页 {c['section']}）\n{c['text']}"
        for i, c in enumerate(chunks, start=1)
    )
    prompt = build_prompt(context, payload.question)

    answer = llm.chat(prompt)  # 正文里带 [1][2] 标记

    answer, citations = sanitize_citations(answer, chunks)
    return RagResponse(answer=answer, citations=citations)
```

关键在最后一行组装：answer 来自模型，citations 来自检索 metadata，两个来源在响应对象里汇合，但谁也不污染谁。

**第 2 步：先测后端。** 启动服务后用 curl 打一发：

```bash
curl -X POST http://localhost:8000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "试用期内年假有几天？"}'
```

预期返回：answer 正文里带 [1]，citations 数组里有 source（文件名）、page、snippet。再问一个知识库外的问题（比如"明天天气怎么样"），确认走降级：answer 是固定话术，citations 是空数组 `[]`。后端不对，别急着写前端。

**第 3 步：前端渲染可点击上标。** 新建 `components/CitedAnswer.tsx`：

```tsx
"use client";
import { useState } from "react";

export interface Citation {
  no: number;
  source: string;
  page: number;
  snippet: string;
  score: number;
}

const CITE_SPLIT = /(\[\d+\])/; // 带捕获组，把 [n] 单独切出来

export function CitedAnswer({ answer, citations }: { answer: string; citations: Citation[] }) {
  const [active, setActive] = useState<number | null>(null);
  const byNo = new Map(citations.map(c => [c.no, c]));

  return (
    <div>
      <p className="leading-8 text-gray-800">
        {answer.split(CITE_SPLIT).map((part, i) => {
          const m = part.match(/^\[(\d+)\]$/);
          if (!m || !byNo.has(Number(m[1]))) return <span key={i}>{part}</span>;
          const no = Number(m[1]);
          return (
            <sup
              key={i}
              role="button"
              onClick={() => setActive(active === no ? null : no)}
              className="mx-0.5 cursor-pointer rounded bg-blue-50 px-1 text-xs text-blue-600"
            >
              {/* 上标只显示数字；想显示 [n] 就改成 `[${no}]` */}
              {no}
            </sup>
          );
        })}
      </p>
      {active !== null && byNo.get(active) && <CitationCard cite={byNo.get(active)!} />}
    </div>
  );
}

function CitationCard({ cite }: { cite: Citation }) {
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">[{cite.no}] {cite.source} · 第 {cite.page} 页</span>
        <span className="text-xs text-gray-400">相关度 {cite.score.toFixed(2)}</span>
      </div>
      <p className="mt-2 border-l-2 border-yellow-300 bg-yellow-50 p-2 leading-6 text-gray-600">
        {cite.snippet}
      </p>
    </div>
  );
}
```

关键在 `answer.split(CITE_SPLIT)` 这一行：带捕获组的正则切分，结果数组里普通文字和 [n] 标记交替出现，map 时逐段判断，是标记就渲染成 `sup`，不是就原样输出。`byNo.has` 那层过滤是双保险，就算后端漏了幽灵引用，前端也不会渲染出点了没反应的死标记。

**第 4 步：提问页串起来。** 新建 `app/ask/page.tsx`：

```tsx
"use client";
import { useState } from "react";
import { CitedAnswer, type Citation } from "../components/CitedAnswer";

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ answer: string; citations: Citation[] } | null>(null);

  async function onAsk() {
    setLoading(true);
    const res = await fetch("http://localhost:8000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    setData(await res.json());
    setLoading(false);
  }

  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="flex gap-2">
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="例如：试用期内年假有几天？"
          className="flex-1 rounded border px-3 py-2"
        />
        <button onClick={onAsk} disabled={loading || !question}
                className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
          {loading ? "检索中…" : "提问"}
        </button>
      </div>

      {data && (
        data.citations.length === 0 ? (
          <p className="mt-6 rounded border border-amber-300 bg-amber-50 p-4 text-amber-700">
            {data.answer}
          </p>
        ) : (
          <div className="mt-6">
            <CitedAnswer answer={data.answer} citations={data.citations} />
            <h3 className="mt-6 mb-2 font-medium">参考来源</h3>
            {data.citations.map(c => (
              <div key={c.no} className="mb-2 text-sm text-gray-500">
                [{c.no}] {c.source} 第 {c.page} 页
              </div>
            ))}
          </div>
        )
      )}
    </main>
  );
}
```

关键在 `citations.length === 0` 这个分支：空数组走琥珀色提示条（降级话术），非空走引用渲染。降级是正常业务路径，不是异常，给它一等公民的 UI 待遇。

**第 5 步：端到端自检。** 过三遍清单：问知识库内问题，上标可点、卡片显示文件名+页码+黄色高亮摘录；问知识库外问题，出降级提示且无卡片；最后把 Prompt 里第 1 条要求删掉重跑，看看校验器日志抓到多少漏标和幽灵引用，体会兜底层的价值。

::: tip 联调命令
后端 `uvicorn main:app --reload --port 8000`，前端 `npm run dev` 起在 3000 端口。跨端口请求必须在 FastAPI 侧加 CORS 中间件（第 1 步代码里已带），否则浏览器会直接拦掉响应。
:::

## 常见踩坑

**坑 1：让模型生成 citations 内容。** 结构化输出用顺手了，很容易顺手让模型把 source、page 一起填了。它填的页码是概率采样出来的，看起来合理，核对必翻车。分工记住一句话：模型管"用了哪条"，后端管"这条是什么"。

**坑 2：前端正则解析正文凑引用。** 省一个字段看似划算，实际两头崩：卡片要的 snippet 和 score 前端根本拿不到，模型输出格式一变正则就失配。结构化分离一次到位，前后端各自拿各自的数据。

**坑 3：幽灵引用不处理。** 模型标 [5] 而资料只有 4 条。如果前端没做 `byNo.has` 过滤，用户点 [5] 毫无反应，这就是线上 bug。后端要擦除、记日志，前端再留一道过滤，两层各管各的。

**坑 4：降级阈值拍脑袋上线。** 0.35 只是示例。不同 embedding 模型的分数分布差别巨大，有的分数 0.9 起步，有的 0.4 已经高度相关。收集 20 个"该降级"和"不该降级"的真实问题，看分数分布再划线，Day 5 的评估集正好派上用场。

**坑 5：拿 Markdown 渲染器直接渲染 answer。** `[1]` 会被部分渲染器吃掉或解析成坏链接，`dangerouslySetInnerHTML` 还带注入风险。今天的 split 方案自己掌控每个片段的渲染方式，安全和样式都可控。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么 citations 数组由后端构造，而不是让模型在结构化输出里一并生成？

::: details 参考答案
source、page 这些字段让模型填，它就会幻觉出看似合理的页码，无法核对。正确分工是模型只通过 [n] 标记表达"用了哪几条"，后端把编号映射回检索结果的真实 metadata。数据从数据库到卡片只存在一份，没有被模型转述过。
:::

2. 幽灵引用是什么？`sanitize_citations` 对它做了什么？为什么还要记日志？

::: details 参考答案
正文标了 [n] 但检索结果里没有第 n 条，属于模型幻觉。校验器把标记从正文中擦掉、句子保留，同时不让它进 citations。记日志是因为擦除只是兜底，幽灵引用频繁出现说明 Prompt 约束力不够，根子上要回头改 Prompt。
:::

3. 诚实降级的触发条件是什么？返回空 citations 在语义上表达了什么？

::: details 参考答案
触发条件是检索结果为空，或最高相似度分数低于阈值，说明知识库没有能回答该问题的内容。空 citations 是一个明确语义："知识库未覆盖"。前端据此展示降级提示，引导用户换问法或补文档，比让模型硬编一段答案可取得多。
:::

4. 前端为什么用 split 切分渲染，而不是 Markdown 渲染器加 `dangerouslySetInnerHTML`？

::: details 参考答案
两个原因：`[1]` 标记会被部分 Markdown 渲染器吃掉或当成坏链，正文直接坏掉；`dangerouslySetInnerHTML` 把模型输出当 HTML 塞进页面，有注入风险。split 方案把正文切成普通文字和标记两类片段，每段自己控渲染，还顺便把 [n] 变成可点击上标。
:::

5. 从入库到前端卡片，source 和 page 这两个字段各被谁读写了一次？

::: details 参考答案
入库时随 chunk 写进向量库（Day 2 起跟着检索结果流转）；今天构造 Prompt 时拼进编号上下文给模型看；响应组装时由后端填进 Citation 模型；前端卡片读出来展示文件名和页码。模型全程只能"看见"它们，没有一次写入机会。
:::

## 延伸阅读

- [FastAPI 教程：Response Model](https://fastapi.tiangolo.com/tutorial/response-model/)，`response_model` 怎么约束响应形状、过滤多余字段，官方讲得最准
- [Anthropic Citations 文档](https://docs.claude.com/en/docs/build-with-claude/citations)，模型原生引用标注的官方实现，对照着理解"模型级引用"和今天"后端构造引用"各自的取舍
- [Pydantic：Fields](https://docs.pydantic.dev/2/concepts/fields/)，`Field(description=...)` 和默认值的完整用法，今天两个响应模型的底层

今天的产出「引用溯源 UI」留好。citations 这套结构后面还要接着用：Day 5 做检索评估时，引用命中数直接从它统计；Day 6 的知识库管理界面，来源卡片这个组件原样复用。
