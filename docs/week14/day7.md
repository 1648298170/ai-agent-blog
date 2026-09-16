# 第 14 周 · Day 7：周复盘——把六个零件装成一台会答话的机器

> 手册任务：周复盘 + 整理。端到端跑通「上传 PDF → 提问 → 返回答案」，写 300 字周记。当日产出：最小 RAG（main.py）+ 周记。
> 本篇解决的问题只有一个：前六天每个零件都单独转过了，但零件合格不等于机器能转。今天把它们焊在一起，再用三组问题试试这台机器的成色。

## 今日目标

1. 用一个 `main.py` 把 Day 2-6 串成完整管线：解析 → 切块 → 向量化 → 入库 → 检索 → 拼 Prompt → LLM 回答，`ingest` 和 `ask` 两个命令都跑通
2. 拿三组问题实测系统边界：一组命中、一组模糊、一组超纲，输出原样存档，第三组留给第 15 周开刀
3. 按四段模板写 300 字周记，过一遍 10 题自检清单，答不上来的回读对应 Day 的教程

## 概念讲解：串联是最好的复盘

先摆一个事实。本周六个产出——解析脚本、切块模块、Embedding 脚本、pgvector 表、检索函数、Day 1 的流程图——每一个你都亲手跑通过。这相当于六个零件各自的出厂检验全绿。但出厂检验合格和整机能转是两回事：零件之间的接口对不对、数据从上一环流到下一环时格式变没变、离线在线两条线在向量库那个交汇点上接不接得上，这些问题只有装一遍才暴露得出来。

这就是今天的复盘方式：**装机测试**。第 1 周 Day 7 讲过识别和提取的区别，方法框架见[第 1 周](/week01/)，今天的变体是：看得懂每个零件和能把零件装成机器是两回事。看懂零件靠读，装成机器靠写。RAG 是条流水线，任何一环的接口错了，整机输出就是垃圾，而且错得悄无声息。

装机之外还有第二个动作：**边界实测**。机器转起来了，还得知道它在哪里翻车。方法是拿三组问题当探针：命中组确认 happy path；模糊组换口语问法，测语义检索的底气；超纲组问一个库里根本没有答案的问题，亲眼看它怎么瞎答。只测第一组是自欺，上线后用户的问题里永远有第三组。

| 动作 | 逼出什么 | 对应今天的产出 |
| --- | --- | --- |
| 装机串联 | 零件之间的接口是否真的清楚 | main.py 管线 |
| 边界实测 | 系统能力边界在哪、怎么翻车 | 三组问题的输出记录 |
| 写作 | 认知变化是否落地 | 300 字周记 |
| 自测 | 细节是否记牢 | 10 题自检清单 |

::: tip 第三组的输出记录是下周的教材
超纲那组问题今天看起来是出丑，留好。第 15 周评估第一课就是拿它开刀：量化检索质量、给幻觉打分，你今天记下的 score 和回答就是第一份实验数据。
:::

## 核心知识

### 1. 端到端串联：一个 main.py，两条命令

设计只有一条：离线侧一个命令 `ingest`，在线侧一个命令 `ask`，数据从 PDF 到回答只在一条代码路径里流。每个零件都是本周写过的，注释里标了出处，完整代码如下：

```python
"""main.py —— 最小 RAG 管线（串联 Day 2-6）
用法：
  python main.py ingest 你的文档.pdf    # 离线侧：解析 → 切块 → 向量化 → 入库
  python main.py ask "你的问题"         # 在线侧：检索 → 拼 Prompt → LLM 回答
"""
import re
import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Json
from openai import OpenAI
from pypdf import PdfReader

client = OpenAI()  # 读环境变量 OPENAI_API_KEY
CONN = "postgresql://postgres:你的密码@localhost:5432/rag_lab"
EMBED_MODEL = "text-embedding-3-small"  # 入库和提问必须是同一个，一个字符都不能差
CHAT_MODEL = "gpt-4o-mini"
CHUNK_SIZE, OVERLAP = 400, 80

# ── Day 2：解析 + 清洗（完整版见当天的 parse_doc.py）──
NOISE = [re.compile(p) for p in (
    r"^第\s*\d+\s*页.*$", r"^\d+\s*/\s*\d+$", r"^Page \d+( of \d+)?$", r"^\d{1,3}$",
)]

def parse_pdf(path: Path) -> list[dict]:
    pages = []
    for i, page in enumerate(PdfReader(path).pages, start=1):
        kept = [ln.strip() for ln in (page.extract_text() or "").splitlines()
                if not any(p.match(ln.strip()) for p in NOISE)]
        text = re.sub(r"(\w)-\n(\w)", r"\1\2", "\n".join(kept))
        if text.strip():
            pages.append({"text": text.strip(), "page": i})
    return pages

# ── Day 3：递归切块 ──
SEPS = ["\n\n", "\n", "。", "，", " ", ""]  # 从粗到细：段落 → 行 → 句 → 词 → 字符

def recursive_split(text: str, seps: list[str] = SEPS, size: int = CHUNK_SIZE) -> list[str]:
    sep, finer = seps[0], seps[1:]
    pieces = text.split(sep) if sep else list(text)  # 空串是保底：按字符切
    chunks, buf = [], ""
    for piece in pieces:
        if sep:
            piece = piece.strip()
            if not piece:
                continue
        if len(piece) > size:                          # 单段仍超长：换更细的分隔符递归
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.extend(recursive_split(piece, finer, size))
        elif len(buf) + len(piece) + len(sep) > size:  # 装不下：结算当前块
            chunks.append(buf)
            buf = piece
        else:
            buf = f"{buf}{sep}{piece}" if buf else piece
    if buf:
        chunks.append(buf)
    return chunks

def with_overlap(chunks: list[str]) -> list[str]:
    """下一块开头带上上一块结尾，防止关键句被切在块边界上。"""
    return [(chunks[i - 1][-OVERLAP:] + chunks[i]).strip() if i else chunks[i]
            for i in range(len(chunks))]

# ── Day 4：Embedding，分批防超限 ──
def embed(texts: list[str]) -> list[list[float]]:
    vectors = []
    for i in range(0, len(texts), 100):
        resp = client.embeddings.create(model=EMBED_MODEL, input=texts[i:i + 100])
        vectors += [d.embedding for d in resp.data]
    return vectors

# ── Day 5：入库（表结构：chunk 文本 / embedding vector(1536) / metadata jsonb）──
def ingest(path: str) -> None:
    p = Path(path)
    texts, metas = [], []
    for page in parse_pdf(p):
        for c in with_overlap(recursive_split(page["text"])):
            texts.append(c)
            metas.append({"source": p.name, "page": page["page"], "model": EMBED_MODEL})
    vectors = embed(texts)
    rows = [(t, "[" + ",".join(map(str, v)) + "]", Json(m))
            for t, v, m in zip(texts, vectors, metas)]
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute("TRUNCATE documents")  # 演示用整库重建；多文档库改成按 source 先删后插
        cur.executemany(
            "INSERT INTO documents (chunk, embedding, metadata) VALUES (%s, %s::vector, %s)",
            rows)
    print(f"入库完成：{p.name} 共 {len(rows)} 块")

# ── Day 6：检索 ──
def search(query: str, k: int = 5) -> list[dict]:
    vec = "[" + ",".join(map(str, embed([query])[0])) + "]"
    sql = """SELECT chunk, 1 - (embedding <=> %(vec)s::vector) AS score, metadata
             FROM documents ORDER BY embedding <=> %(vec)s::vector LIMIT %(k)s"""
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(sql, {"vec": vec, "k": k})
        return [{"chunk": r[0], "score": round(r[1], 4), "meta": r[2]} for r in cur.fetchall()]

# ── Day 7（今天新写）：拼 Prompt + 生成 ──
PROMPT = """你是公司制度助手。仅根据下面的资料回答问题，资料里没有的就回答"资料里没有涉及"。

【资料】
{context}

【问题】
{question}"""

def ask(query: str, k: int = 5) -> None:
    hits = search(query, k)
    print(f"── 检索到 {len(hits)} 块 ──")
    context = ""
    for i, h in enumerate(hits, 1):
        m = h["meta"]
        print(f"  score={h['score']:.4f}  {m.get('source')} p{m.get('page')}  {h['chunk'][:36]}…")
        context += f"[{i}] 来源：{m.get('source')} 第{m.get('page')}页\n{h['chunk']}\n\n"
    resp = client.chat.completions.create(
        model=CHAT_MODEL,
        messages=[{"role": "user",
                   "content": PROMPT.format(context=context, question=query)}],
        temperature=0)
    print(f"── 回答 ──\n{resp.choices[0].message.content}")

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "ingest":
        ingest(sys.argv[2])
    elif len(sys.argv) >= 3 and sys.argv[1] == "ask":
        ask(sys.argv[2])
    else:
        print(__doc__)
```

六个零件里，今天真正新写的只有最后三十行：`PROMPT` 模板、`ask()` 里的 context 拼装、一次 `chat.completions` 调用。拼 Prompt 照的是 Day 1 讲的那三段：行为指令（仅根据资料）、资料、问题。「仅根据资料回答，没有就说不知道」这句是防幻觉的第一道闸，第 1 天就埋下了，今天正式上岗。`temperature=0` 让回答尽量稳定，但第三组实测会看到，它挡不住瞎答。

两个接口细节值得停一下。其一，metadata 里塞了 `model` 字段，这是 Day 6 埋的防呆：检索分数全线异常时先查它，确认库里是不是被别的模型嵌过。其二，`source` 和 `page` 从 Day 2 的解析结果一路带到 prompt 的【资料】段，回答自带出处。第 15 周做引用溯源，地基就是这两个字段今天走的这条路。

### 2. 三组实测：亲手摸到系统的边界

示例文档用 4 页的自拟《差旅报销制度》`travel-policy.pdf`：3.2 节写住宿标准（一线城市每晚 500 元、其他城市 400 元），3.3 节写超标审批。你手边任何一份 PDF 都行，关键是三组问题要挑出三个档次。

**第一组：命中，问法贴近文档措辞。**

```text
$ python main.py ask "出差住宿标准一晚多少钱？"
── 检索到 5 块 ──
  score=0.5612  travel-policy.pdf p2  3.2 住宿标准：一线城市每晚 500 元…
  score=0.4780  travel-policy.pdf p2  3.3 超标审批：需直属负责人和分管副总…
  score=0.3946  travel-policy.pdf p3  4.1 机票预订：经济舱为标准舱位…
  score=0.3511  travel-policy.pdf p1  1.1 总则：本制度适用于全体正式员工…
  score=0.3120  travel-policy.pdf p4  6.1 报销时限：费用发生后 30 日内…
── 回答 ──
根据资料，住宿标准为一线城市每晚 500 元、其他城市每晚 400 元（依据：资料[1]，travel-policy.pdf 第 2 页）。
```

Top 1 分数拉开第二名一截，答案直接引用了资料编号和页码。这是 happy path：检索准、生成稳、出处自带。

**第二组：模糊，换成口语问法。**

```text
$ python main.py ask "住宿费花超了要找谁签字？"
── 检索到 5 块 ──
  score=0.4401  travel-policy.pdf p2  3.3 超标审批：需直属负责人和分管副总…
  score=0.4187  travel-policy.pdf p2  3.2 住宿标准：一线城市每晚 500 元…
  score=0.3675  travel-policy.pdf p3  4.1 机票预订：改签产生的差价计入超标…
  score=0.3094  travel-policy.pdf p4  6.1 报销时限：费用发生后 30 日内…
  score=0.2888  travel-policy.pdf p1  1.1 总则：本制度适用于全体正式员工…
── 回答 ──
根据资料，住宿超标需要直属负责人和分管副总两级审批（依据：资料[1]）。
```

「花超了」「签字」在文档里一个字都不出现，检索照样把 3.3 节顶到第一位，这就是 Day 1 说的语义检索和字面搜索的分水岭。代价也看得见：分数整体比第一组低一截，第三名混进了一条机票改签的擦边块。这次答案没被带偏，但噪声已经进门，问法再偏一点就不好说了。

**第三组：超纲，库里根本没有答案。**

```text
$ python main.py ask "黑洞蒸发辐射的物理机制是什么？"
── 检索到 5 块 ──
  score=0.2714  travel-policy.pdf p1  1.1 总则：本制度适用于全体正式员工…
  score=0.2498  travel-policy.pdf p4  6.1 报销时限：费用发生后 30 日内…
  score=0.2435  travel-policy.pdf p3  4.1 机票预订：经济舱为标准舱位…
  score=0.2201  travel-policy.pdf p2  3.2 住宿标准：一线城市每晚 500 元…
  score=0.2017  travel-policy.pdf p2  3.3 超标审批：需直属负责人和分管副总…
── 回答 ──
资料中没有直接涉及黑洞蒸发辐射的内容。不过根据资料[2]，公司要求费用发生后 30 日内完成报销……
```

亲眼见到了 Day 6 预告的那一幕：Top-K 是矮子里拔将军，超纲问题照样返回 5 条，分数掉到 0.2 一档；模型也没干脆闭嘴，硬扯了一段报销时限来凑。多跑几次你会发现，它有时老实说「资料里没有涉及」，有时开始自由发挥，temperature=0 也保证不了它每次守规矩。这种不可预测才是真正的危险：每一段回答都文通字顺、自带出处格式，真假只能靠内容本身分辨，而用户恰恰没有这个分辨能力。

（三组的具体分数取决于你的文档、切块和问法，绝对值没有意义，盯的是三组之间的相对落差和排序变化。三段输出原样存进 `week14-notes.md`，别修剪，下周要的是原始记录。）

第三组就是下周的起点。第 15 周评估要做的事：给检索质量定指标、给幻觉分级打分、用阈值和重排把今天这个瞎答摁住。今天只负责把它看清、记下。

### 3. 300 字周记模板（第 14 周示例）

四段模板沿用第 1 周：最大收获、卡得最久、还含糊、下周前补。第 14 周示例，照这个密度写：

```text
① 本周最大收获：RAG 的本质是开卷考试。知识不进模型权重，切块向量化
放进库里，提问先检索再作答。六天串下来最确认的一件事：答案的上限在
检索那一刻就定死了，LLM 只是照着摊开的资料答题，检索烂生成必烂。
② 卡得最久：main.py 联调时检索分数全线 0.3 以下，怎么换问法都不命中。
对照 Day 6 排查才发现入库脚本里模型名写成了 text-embedding-3-large，
坐标系不同，分数全是噪声。把模型名写进 metadata 后再没犯过。
③ 还含糊：score 阈值怎么标定只看了结论没动手做；overlap 从 80 调到
200 对召回的影响，只知道理论方向，没实测过。
④ 下周前补：把今天三组问题的 score 抄成表，人工标"相关/不相关"，
第 15 周评估直接拿它当第一份素材。
```

### 4. 第 14 周知识自检清单

规则不变：每题先口头回答，说完整了再点开对照。答不上的记题号，回读对应 Day 的教程。

**问题 1：长上下文、微调、RAG 三条路各适合什么场景？（Day 1）**

::: details 答案
文档只有几页且很少改，直接塞长上下文最省事；要改的是模型的说话方式、输出格式、领域语感，用微调，微调不擅长记事实，知识还会过期；知识量大、频繁更新、需要溯源，用 RAG。三者不互斥，生产系统常见 RAG 打底、微调点缀。
:::

**问题 2：离线侧和在线侧各包含哪几步？分别跑多少次？（Day 1）**

::: details 答案
离线侧：文档 → 切块 → Embedding → 入库，建库跑一次，文档更新时重跑。在线侧：问题 Embedding → 相似检索 → 拼 Prompt → LLM 生成，每来一个问题跑一遍。两条线唯一的交汇点是向量库：离线侧往里写，在线侧从里读。
:::

**问题 3：双栏 PDF 用 `extract_text()` 直读为什么会乱序？（Day 2）**

::: details 答案
PDF 是排版不是语义，内部只有字符和坐标指令流，没有段落和阅读顺序的概念。`extract_text()` 按内容流近似逐行拼，双栏版式下左右两栏同一水平线上的行被拼进同一行，两句话互相插花。还原阅读顺序要靠版面分析，那是 `unstructured` 和云服务的活。
:::

**问题 4：chunk 之间的 overlap 起什么作用？（Day 3）**

::: details 答案
相邻块保留一段重叠（经验值 10% 到 20%），防止关键句恰好被切在块边界上：没有重叠时前一块截了头、后一块断了尾，哪块都不完整，检索到也读不懂。有重叠，至少有一块保住完整语境。代价是存储和 token 的少量冗余。
:::

**问题 5：递归切块的分隔符为什么要按从粗到细的顺序排？（Day 3）**

::: details 答案
顺序是段落（`\n\n`）→ 行（`\n`）→ 句（`。`）→ 词（`，`/空格）→ 字符（空串）。优先在最粗的天然语义边界切，块内主题集中，Embedding 的向量才纯；只有某段用上层分隔符切完仍超过块上限，才降级用更细的分隔符递归，最后的空串保证再长的文本也能切到不超限。顺序反了，优先按字符碎切，切出来全是碎渣。
:::

**问题 6：Embedding 模型和生成模型是一回事吗？各干什么？（Day 4）**

::: details 答案
不是。Embedding 模型把文本映射成一个定长向量（比如 1536 个浮点数），输出的是数字不是文字，用途是算相似度、做检索；生成模型（LLM）自回归地逐 token 生成文本，用途是写作和回答。RAG 里两者分工明确：Embedding 负责从库里找资料，LLM 负责照资料组织答案。前者不能拿来对话，后者也顶不了检索的活。
:::

**问题 7：`<=>` 是什么距离？和 score 是什么关系？（Day 5/6）**

::: details 答案
`<=>` 是 pgvector 的余弦距离操作符，值等于 1 减余弦相似度，只看向量夹角不看长度，越小越相关。检索 SQL 里 ORDER BY 用它升序排，最相关的排最前；给人看的 score 通常写成 `1 - (embedding <=> $1)`，换算回相似度，越大越相关。排序用距离，展示用相似度，两个方向别搞反。
:::

**问题 8：为什么问题必须用和文档入库时同一个 Embedding 模型？（Day 6）**

::: details 答案
向量只有在同一个坐标系里才能比距离，而坐标系是模型定义的。换成维度不同的模型，数据库直接报维度不匹配；换成维度恰好相同的其他模型更阴险，不报错，但距离全是噪声，检索表面正常、结果悄悄全错。铁律：换模型等于换坐标系，必须整库重新 Embedding，没有例外。
:::

**问题 9：Top-K 里的 K 取大取小，各牺牲什么？（Day 6）**

::: details 答案
K 太小漏召回：答案恰好跨在两个切块的边界上时就漏掉关键内容。K 太大引噪声：不相关切块挤进上下文，稀释模型注意力，还按块长度实打实推高生成的 token 开销；K 和切块大小联动，K 乘以平均块长才是进 prompt 的真实体积。经验起步值 3 到 5，拿真实问题对比答案质量后落定。
:::

**问题 10：超纲问题对 RAG 系统危险在哪？（Day 6/7）**

::: details 答案
Top-K 检索永远返回 K 条「库里相对最近」的结果，哪怕最近的也全不相关，它没有「全都无关就返回空」的概念。生成端拿到无关上下文，可能一本正经地编出一段格式规整、看似有出处的回答，比不答更糟，用户无从分辨。prompt 里写「没有就说不知道」只是第一道闸，不是保险箱，这正是第 15 周评估要量化的问题。
:::

::: tip 全对也别跳过装机
自检答得再顺，只证明零件认得全。main.py 跑不通、三组输出没存档，本周就不算收口。今天的检验标准从头到尾一条：机器能不能答话、会不会瞎答。
:::

## 动手任务：完成本周复盘

按顺序五步，预计 60 到 90 分钟。本周日程回顾见[本周计划](/week14/)。

**第一步：备环境（5 分钟）。** `pip install pypdf "psycopg[binary]" openai`，确认 Day 5 的 `documents` 表还在、PostgreSQL 在跑。密码走环境变量，别硬编码在 CONN 里。

**第二步：写 main.py，跑 ingest（20 分钟）。** 抄入上面的完整代码，换成你的连接串，执行 `python main.py ingest travel-policy.pdf`。验收别只看打印那行数字：进 psql 抽两条 `SELECT left(chunk, 50), metadata FROM documents;`，块是成句的中文、页码对得上文件，才算入库合格。

**第三步：三组实测并存档（25 分钟）。** 照第 2 小节的三个档次各挑一问，输出原样贴进 `week14-notes.md`。第三组至少跑三次，亲眼看它的回答稳不稳、老实不老实。

**第四步：周记加自检（25 分钟）。** 四段模板写周记，对照示例的密度，「卡得最久」那段别敷衍。10 题逐个口头回答，答不上的回读对应 Day。

**第五步：git 收口（10 分钟）。** 未提交的分开提交，然后打 tag。

```bash
git add main.py
git commit -m "feat(rag): 端到端串联 Day 2-6，最小 RAG 跑通"
git add docs/  # 或你的笔记目录
git commit -m "docs: 第 14 周周记与三组实测记录"
git tag week14-done
```

## 常见踩坑

**串联变成联播。** 六个脚本按顺序手动跑，中间靠复制粘贴传数据，顶着管线的名头，干着拼凑的实质。判断标准一条：一个入口文件，数据从 PDF 到回答只走一条代码路径。人工搬运一次，接口问题就漏检一次。

**只测命中问题。** 全挑库里有答案的问，一绿到底，感觉良好。上线第一天用户问了句超纲的，机器人一本正经地胡说，你才第一次见到幻觉。三组问题今天必须跑齐，尤其第三组，它比第一组值钱。

**多文档场景照抄 TRUNCATE。** 演示里整库重建没问题，库里一旦有第二份文档，每次 ingest 都会把它清掉。改成按 `source` 先删后插，或给 `(source, page, chunk)` 加唯一约束去重。这个坑平时不响，丢数据的时候最响。

**周记写成周报。** 「完成了 PDF 解析、切块、Embedding、入库、检索」，这是给老板看的进度条。周记记的是认知变化，四段里「卡得最久」那段最值钱，下周撞上同类坑时，它是你唯一的手记。

## 延伸阅读

- [pgvector GitHub](https://github.com/pgvector/pgvector)：`<=>` 等三个距离操作符和索引类型的权威出处，串联时用到的全部 SQL 细节都在这
- [OpenAI：Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)：模型选择与用量的官方说明，问题 8 那条铁律的原始依据
- 复盘方法论的源头在[第 1 周](/week01/)的 Day 7：识别与提取、输出倒逼输入。本周只是换了被复盘的对象，方法一寸没动

下周第 15 周，评估登场：今天第三组问题的输出记录、score 表、还有那句硬扯出来的报销时限，全是开课的教具。带上它们来。第 14 周到此收口。
