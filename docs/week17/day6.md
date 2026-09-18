# 第 17 周 · Day 6：记忆整合到 LangGraph——总装日，图首尾各加一个节点

> 对应手册任务：学习「记忆整合到 LangGraph」，动手「在 Agent 启动和每轮结束时自动读写记忆」，当日产出「带记忆的 Agent」。本篇只解决一个问题：五天攒下的零件（压缩模块、偏好库、情景检索、Prompt 模板）目前还是散装函数，每次对话都得你手动调用才生效，今天把它们织进 LangGraph 的图首和图尾各一个节点，中间的 ReAct 一行不动，Agent 从此自己记得用户。

## 今日目标

1. 说得清最小侵入设计：记忆为什么只该以 load_memory 和 save_memory 两个节点的形式出现，ReAct 循环凭什么一行不用动
2. 掌握三个实现细节：load 节点改写 state 的 system 字段、save 节点把慢活丢给后台不阻塞回复、摘要更新按「每 10 轮或会话结束」触发
3. 独立完成 `memory_agent.py`：跑两个不同 thread_id 的会话，亲眼看 Agent 在一个全新会话里认得你

## 概念讲解：零件齐了，为什么还不动手改 ReAct

先盘点家底。Day 2 的 `compact` 管住了窗口，Day 3 的 `preference_loader.py` 让偏好能进 PG 也能读出来，Day 4 把历史对话存进了向量库，Day 5 的模板把「角色 + 工具说明 + 记忆摘要 + 用户偏好」排好了版（日程见[本周](/week17/)）。听起来大功告成，实际跑一次对话就露馅：启动时忘了调 `load_profile`，Agent 六亲不认；聊完了忘了跑抽取，这一轮的记忆随风而去。记忆现在是你的家务活，不是 Agent 的能力。

直觉的修法是把记忆代码塞进 ReAct 循环：agent 节点里，调模型前先查偏好、查情景，拿到回复后顺手抽取入库。能跑，但这是笔坏交易。第 13 周打磨过的 ReAct 是你最值钱的资产，工具选择、循环边界、错误恢复都验过；每往里塞一段记忆代码，就多一次改坏它的机会。而且推理逻辑和记忆管线搅在一起，以后想换存储、想关掉记忆做对比测试，都得动推理代码。

退一步看，记忆和推理在时间上只有两个接触点：模型思考之前（它该知道什么），回复产出之后（什么值得记）。LangGraph 的图恰好在这两个位置留了天然挂钩——入口节点和出口节点。于是设计定案：图首加 load_memory，读画像、检索情景、渲染 system prompt；图尾加 save_memory，抽取偏好、归档情景、按需更新摘要；中间的 ReAct 原样接上，一行不动。记忆是推理的外壳，不是推理的器官，外壳就该套在外面。

一句话记住：对既有图的最小侵入，不是少写代码，是把变更限制在图的两端，让中间保持零改动。

## 核心知识

### 1. 总装架构：两个外壳节点

一次 invoke 依次穿过四个节点：

- **START → load_memory（图首）**：读 PG 画像 + 历史摘要，以最新 user 消息检索情景，渲染 system prompt
- **→ agent**：第 13 周的 ReAct 原样接上，一行不动
- **→ save_memory（图尾）**：抽取偏好、归档情景，每 10 轮或会话结束更新摘要，慢活全部后台执行
- **→ END**

state 要在 ReAct 用的字段之外多出四个：`user_id`（记忆的 key）、`system`（图首注入的成品 prompt）、`turn_count`（轮数，计到 10 触发摘要）、`session_end`（会话结束标记）。四个都是外壳的字段，ReAct 一个都不用认识。

Day 2 的 `compact` 想挂进图的话，挂点也在 load_memory 里：恢复历史、压缩、拼 system，一口气做完，中间照样不用动。

### 2. load_memory：记忆渲染成 system，而不是塞进历史

节点的活分三步：查 `user_profiles` 拿画像，查 `user_summaries` 拿摘要，拿 `messages` 里最后一条 user 消息当 query 去向量库捞最相关的几条情景；三样东西填进 Day 5 的模板，产出写进 `state["system"]`。agent 节点调模型时把它拼成 messages[0]。

为什么写 system 字段，而不直接把记忆 append 进 messages？因为 messages 是 checkpoint 回放的主体，是「这个会话说过的话」；记忆是「会话之外知道的事」，每轮由 load 现算现注入。混进 messages 的记忆会随历史一起被存、被回放、被压缩，第二天换了会话它就不在了——这恰恰丢了记忆的本职。分家之后，记忆永远新鲜注入，历史永远干净回放。

情景检索的 query 用最后一条 user 消息就够，别把整段历史拿去 embedding：又贵又糊，用户的当前问题才是「现在该想起什么」的锚点。

### 3. save_memory：三件慢活，一件都别挡回复

图尾每轮要做三件事：偏好抽取（一次 LLM 调用）、情景写入（embedding 加入库）、摘要更新（更慢的一次 LLM 调用）。save 在图的出口，同步跑完它 invoke 才返回——用户就得为「记住我」每轮多等一两秒。

第 15 周上传异步的思想原样搬来：请求路径只做快活，慢活出请求路径。节点同步做的只有读 state、数轮数、起后台任务，抽取和入库全部丢进后台。demo 用 `threading` 起后台线程，生产接 FastAPI 时换成 `BackgroundTasks`（示意）：

```python
from fastapi import FastAPI, BackgroundTasks

app = FastAPI()

@app.post("/chat")
def chat_api(req: ChatRequest, bg: BackgroundTasks):
    answer = run_graph(req.user_id, req.thread_id, req.message)  # 图内 save 只收集不执行
    bg.add_task(save_memory_background, req.user_id, req.message, answer)
    return {"answer": answer}  # 毫秒级返回，慢活在响应发出后跑
```

摘要更新的触发条件是 `turn_count % 10 == 0 or session_end`。不是每轮：Day 2 坑 2 算过这笔账，每轮重摘一次，压缩省下的钱全交回去。也不能永远不更：摘要停在上周，回忆就会失真。

### 4. 与 checkpoint 的协作：一次 invoke 的完整数据流

checkpoint（第 12 周）管 thread 内的回放，三层记忆管跨会话的认知，今天总装之后两者在一次 invoke 里同台：

| 维度 | checkpoint | 三层记忆 |
|---|---|---|
| key | thread_id | user_id |
| 存什么 | 本 thread 的消息和运行状态 | 画像、情景、摘要 |
| 何时写 | 每个超级步之后，框架自动 | save_memory 节点，我们显式 |
| 换 thread_id | 清零，从第一轮重来 | 照常加载，Agent 认得你 |

一次 invoke 的完整数据流：

- invoke(user_id, thread_id, 新消息) → checkpointer 判断：thread 有存档就恢复历史再继续，没有就空历史开始
- → **load_memory**：现查 PG 画像/摘要 + 向量检索情景
- → **agent**：ReAct 推理
- → **save_memory**：后台写三层记忆
- → checkpointer 落盘本 thread 状态 → 返回回复

验证分工最省事的办法就是今天的 demo：换一个全新 thread_id 再聊，Agent 依然叫得出你的名字，那是记忆的功劳；同一个 thread_id 隔天接着聊，历史无缝续上，那是 checkpoint 的功劳。

### 5. 成本账：每轮多两次检索、一次抽取

记忆不是免费的。load 侧每轮多一次 PG 查询加一次向量检索，毫秒级，基本无感；save 侧每轮多一次偏好抽取的 LLM 调用，好在喂进去的只有本轮一问一答，几百 token，而且已挪到后台，不占用户等待；摘要每 10 轮才摊一次。三个省钱的阀门：抽取只喂增量、摘要低频触发、情景只存一问一答的概括不存工具噪声。

怎么确认这笔钱花得值？两头引用。效果侧，用第 16 周的评估集做「记忆开/关」对比，当成一次变更跑回归，通过率没涨甚至反降，这功能就该回炉。开销侧，第 21 周成本篇会教你把记忆的增量 token 单独列账，按月盯住它。评估守住效果，成本守住开销，中间才是你安心睡觉的地方。

## 动手任务：`memory_agent.py` 一步一步

手册任务：在 Agent 启动和每轮结束时自动读写记忆。拆成 6 步，全程约 35 分钟。数据库沿用 Day 3 起的 Docker Postgres，两张旧表照用，今天只新增一张摘要表。

**第 1 步：建表装包。** 在 Day 3 的 agent 库里加一张表：

```sql
CREATE TABLE IF NOT EXISTS user_summaries (
  user_id    TEXT PRIMARY KEY,
  summary    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

然后 `pip install langgraph langchain-core psycopg2-binary openai`。

**第 2 步：搭骨架，把零件摆上桌。** 新建 `memory_agent.py`，骨架加三个 Day 的零件。为方便照抄，Day 3 的偏好读写和 Day 5 的模板以最小面目直接写进文件；Day 4 的情景检索 demo 用内存版实现，签名和你的 pgvector 版一致，替换回去就是生产形态：

```python
import os
import json
import math
import threading
import psycopg2
from openai import OpenAI
from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver

conn = psycopg2.connect(
    host="localhost", port=5432, dbname="agent",
    user="postgres", password="dev123",
)
client = OpenAI(
    api_key=os.environ["LLM_API_KEY"],
    base_url=os.environ.get("LLM_BASE_URL", "https://api.deepseek.com"),
)
MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")

# ---- Day 3 零件：偏好读写 ----

def load_profile(user_id: str) -> dict:
    with conn.cursor() as cur:
        cur.execute("SELECT kv FROM user_profiles WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row[0] if row else {}

def save_preferences(user_id: str, prefs: dict) -> None:
    if not prefs:
        return
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO user_profiles (user_id, kv, updated_at)
            VALUES (%s, %s::jsonb, now())
            ON CONFLICT (user_id) DO UPDATE
            SET kv = user_profiles.kv || EXCLUDED.kv, updated_at = now()
            """,
            (user_id, json.dumps(prefs)),
        )
    conn.commit()

def load_summary(user_id: str) -> str:
    with conn.cursor() as cur:
        cur.execute("SELECT summary FROM user_summaries WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row[0] if row else ""

# ---- Day 4 零件：情景检索（demo 内存版，pgvector 版同名替换） ----

_EPISODES: list[dict] = []  # [{"user_id", "text", "vec"}]

def _embed(text: str) -> list[float]:
    """demo 用字符频率向量顶替 embedding，只为跑通链路，生产换成真模型"""
    vec = [0.0] * 256
    for ch in text:
        vec[ord(ch) % 256] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]

def add_episode(user_id: str, text: str) -> None:
    _EPISODES.append({"user_id": user_id, "text": text, "vec": _embed(text)})

def search_episodes(user_id: str, query: str, k: int = 3) -> list[str]:
    qv = _embed(query)
    scored = [
        (sum(a * b for a, b in zip(e["vec"], qv)), e["text"])
        for e in _EPISODES if e["user_id"] == user_id
    ]
    scored.sort(key=lambda t: t[0], reverse=True)
    return [text for _, text in scored[:k]]

# ---- Day 5 零件：System Prompt 模板 ----

def render_system_prompt(profile: dict, summary: str, episodes: list[str]) -> str:
    parts = ["你是编程助手。"]
    if profile:
        lines = "\n".join(f"- {k}：{v}" for k, v in profile.items())
        parts.append("## 用户偏好（必须遵守）\n" + lines)
    if summary:
        parts.append("## 历史对话摘要\n" + summary)
    if episodes:
        parts.append("## 相关的过往情景\n" + "\n".join(f"- {e}" for e in episodes))
    return "\n\n".join(parts)
```

**第 3 步：state 和图首 load_memory。**

```python
from typing import Annotated, TypedDict

class AgentState(TypedDict, total=False):
    user_id: str
    system: str                                  # 图首注入，每轮现算
    messages: Annotated[list, add_messages]      # 本 thread 历史，checkpoint 管
    turn_count: int
    session_end: bool

def load_memory_node(state: AgentState) -> dict:
    profile = load_profile(state["user_id"])
    summary = load_summary(state["user_id"])
    query = next((m.content for m in reversed(state["messages"]) if m.type == "human"), "")
    episodes = search_episodes(state["user_id"], query, k=3)
    return {"system": render_system_prompt(profile, summary, episodes)}
```

关键在 `return {"system": ...}`：只更新 system 一个字段，messages 碰都不碰，记忆和历史分家。

**第 4 步：中间 ReAct（占位）和图尾 save_memory。**

```python
def agent_node(state: AgentState) -> dict:
    """第 13 周的 ReAct 原样塞进来，这里用最简占位：一次调用，无工具"""
    messages = [{"role": "system", "content": state["system"]}] + [
        {"role": "user" if m.type == "human" else "assistant", "content": m.content}
        for m in state["messages"]
    ]
    resp = client.chat.completions.create(model=MODEL, messages=messages, temperature=0.3)
    return {"messages": [{"role": "assistant", "content": resp.choices[0].message.content}]}

# Day 3 的 EXTRACT_PROMPT 压缩版，规则原样：只摘明确说过的，禁止推测，禁存敏感信息
EXTRACT_PROMPT = """你是用户偏好抽取器，从对话中抽取用户【明确亲口说过】的偏好和事实。
只摘录明确说出的信息，禁止推测；输出 JSON，key 用简短中文短语；
没有偏好输出 {}；健康状况、财务、证件号、精确住址即使提到也禁止输出。
对话记录：
{transcript}"""

def extract_preferences(transcript: str) -> dict:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": EXTRACT_PROMPT.format(transcript=transcript)}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    return json.loads(resp.choices[0].message.content)

def update_summary(user_id: str, transcript: str) -> None:
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content":
            "把对话压缩成不超过 150 字的摘要，保留用户目标、关键事实（含具体值）、"
            "未解决的问题和明确偏好，直接输出正文：\n" + transcript}],
        temperature=0,
    )
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO user_summaries (user_id, summary, updated_at)
               VALUES (%s, %s, now())
               ON CONFLICT (user_id) DO UPDATE
               SET summary = EXCLUDED.summary, updated_at = now()""",
            (user_id, resp.choices[0].message.content),
        )
    conn.commit()

SUMMARY_EVERY = 10

def _save_in_background(user_id, this_turn, turn, session_end, recent) -> None:
    try:
        save_preferences(user_id, extract_preferences(this_turn))
        add_episode(user_id, this_turn[:120])
        if session_end or turn % SUMMARY_EVERY == 0:
            # demo 拿最近几条现摘；生产按 Day 2 增量法：上一版摘要 + 新消息合并
            update_summary(user_id, recent)
    except Exception as exc:
        print(f"[save_memory] 后台写入失败：{exc}")  # 只记日志，绝不影响主流程

def save_memory_node(state: AgentState) -> dict:
    msgs = state["messages"]
    last_user = next((m.content for m in reversed(msgs) if m.type == "human"), "")
    reply = msgs[-1].content
    turn = state.get("turn_count", 0) + 1
    this_turn = f"user: {last_user}\nassistant: {reply}"
    recent = "\n".join(
        f"{'user' if m.type == 'human' else 'assistant'}: {m.content}" for m in msgs[-6:]
    )
    threading.Thread(
        target=_save_in_background,
        args=(state["user_id"], this_turn, turn, state.get("session_end", False), recent),
        daemon=True,
    ).start()
    return {"turn_count": turn}  # 同步部分毫秒级返回，回复不被慢活拖住
```

关键在 `daemon=True` 那颗线程：同步路径只剩数轮数和起线程，三件慢活全部出请求路径。

**第 5 步：建图，挂 checkpointer，跑双会话 demo。**

```python
def build_graph():
    g = StateGraph(AgentState)
    g.add_node("load_memory", load_memory_node)
    g.add_node("agent", agent_node)
    g.add_node("save_memory", save_memory_node)
    g.add_edge(START, "load_memory")
    g.add_edge("load_memory", "agent")
    g.add_edge("agent", "save_memory")
    g.add_edge("save_memory", END)
    return g.compile(checkpointer=MemorySaver())  # thread 内回放交给 checkpoint

graph = build_graph()

def chat(user_id: str, thread_id: str, text: str, session_end: bool = False) -> str:
    result = graph.invoke(
        {"user_id": user_id, "session_end": session_end,
         "messages": [HumanMessage(content=text)]},
        {"configurable": {"thread_id": thread_id}},
    )
    return result["messages"][-1].content

if __name__ == "__main__":
    import time

    # 会话 1：全新 thread，用户自报家门
    print("会话1：", chat("u_001", "t_a", "我叫 Jerry，做后端开发的，回答尽量简短。"))
    time.sleep(8)  # demo 等后台写完；生产用任务表跟踪，不靠 sleep

    # 会话 2：换全新 thread，checkpoint 清零，只靠三层记忆认人
    print("会话2：", chat("u_001", "t_b", "给我一个 TypeScript 入门建议"))
    print("会话2收尾：", chat("u_001", "t_b", "今天先到这。", session_end=True))
    time.sleep(8)
    print("画像：", load_profile("u_001"))
    print("摘要：", load_summary("u_001")[:50], "...")
```

**第 6 步：核对三处证据。** 跑 `python memory_agent.py`，看三样东西：会话 2 的回复称呼你 Jerry 且明显克制篇幅，画像生效；`SELECT kv FROM user_profiles WHERE user_id='u_001'` 查得到偏好，抽取入库；`user_summaries` 里有一行摘要，触发条件生效。三样都在，「带记忆的 Agent」落地。

::: tip 跑不动怎么办
会话 2 不认识你，先看后台日志有没有 `[save_memory] 后台写入失败`，八成是第 1 步的表没建或 Docker 没起；抽取返回不是 JSON，回到 Day 3 的排查法，把模型原文打出来看。另外 MemorySaver 是内存版，重启进程 thread 状态即清空，但 PG 里的记忆还在——这正是两层分工的活教材。
:::

## 常见踩坑

**坑 1：把记忆逻辑写进 ReAct 循环内部。** 调模型前查一把、拿到回复存一把，写的时候顺手，改的时候要命：每加一种记忆就得动一次推理代码，工具循环被碰坏的概率逐次累积。判断标准：把两个记忆节点从图里摘掉，ReAct 必须还能原样跑通；跑不通，说明有记忆代码渗进了中间。以后做「记忆开/关」对比测试，做的也是同一个动作：拆外壳跑基线，接外壳跑对比。

**坑 2：save 节点同步跑 LLM，或者起了后台却不管异常。** 两个极端都坑。同步跑：回复延迟每轮多一两秒，用户为你的架构买单。起了线程不接异常：它悄悄死掉，记忆丢一轮你都不知道，两周后用户抱怨 Agent「间歇性失忆」你还没处查。规矩两条：慢活必出请求路径，异常必落日志；生产再配任务表跟踪成败，第 15 周的 documents 状态表就是现成模板。

**坑 3：情景检索拿全量历史当 query。** embedding 的输入越长语义越糊，检索出来全是泛泛的「用户聊过技术」，回忆区形同虚设。锚点是用户的当前问题：最后一条 user 消息，k 控制在 3 到 5。情景在 prompt 里是「想起来」，不是「背出来」。

**坑 4：摘要每轮更新，或者从不更新。** 每轮更新，Day 2 算过，压缩省下的成本原样交回去；从不更新，摘要停在三天前，Agent 的长期印象和现实脱节。触发条件定死：每 10 轮或会话结束。还有个小坑：更新时别从零重摘全量，用上一版摘要加新消息合并成一次调用，这是 Day 2 定下的增量法，demo 里偷懒喂了最近六条，生产记得换。

**坑 5：说不清 checkpoint 和记忆谁管什么，就动手删其一。** 有记忆后有人觉得 checkpoint 多余：删掉，同一个 thread 断点续聊和工具调用的中间态全丢。反过来只留 checkpoint：第二天换 thread 立刻六亲不认，回到 Day 1 的思想实验。判断标准一句话：thread 内回放归 checkpoint，跨会话认知归记忆，两层叠加。demo 里换 thread_id 那一步，验的就是这条边界。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 记忆节点为什么放图首尾，而不是塞进 ReAct 循环？

::: details 参考答案
记忆和推理在时间上只有两个接触点：模型思考前（该知道什么）和回复产出后（该记什么），恰好对应图的入口和出口节点。塞进 ReAct，每次改记忆都要动已验证的推理代码，侵入大、难测试、难关闭。最小侵入设计：变更限制在图的两端，中间零改动。
:::

2. load 节点为什么把记忆写进 system 字段，而不是 append 进 messages？

::: details 参考答案
messages 是 checkpoint 回放的会话历史，记忆是会话之外的知识。混进 messages 会随历史一起被存、回放、压缩，换了会话它就不在了，记忆的本职丢失。单列 system 字段，每轮由 load 节点现算现注入：历史干净回放，记忆新鲜注入。
:::

3. save 节点怎么做到不阻塞回复？借用了第 15 周的什么思想？

::: details 参考答案
请求路径只做快活：读 state、数轮数、起后台任务；偏好抽取、情景写入、摘要更新三件慢活全部出请求路径，demo 用后台线程，生产换 FastAPI 的 BackgroundTasks。思想同第 15 周上传异步：接口秒回，慢活后台跑，状态可跟踪。
:::

4. 摘要更新的触发条件是什么？为什么不是每轮？

::: details 参考答案
turn_count % 10 == 0 或 session_end。每轮重摘，成本随轮数线性回涨，压缩省下的钱全交回去（Day 2 坑 2 的账）；从不更新又会失真。10 轮是成本和新鲜度的折中，具体数值拿第 16 周的评估集来调。
:::

5. 换一个全新 thread_id 后，checkpoint 和三层记忆各自发生什么？

::: details 参考答案
checkpoint 以 thread_id 为 key，新 thread 无存档，历史从零开始；三层记忆以 user_id 为 key，照常加载画像、摘要、情景，Agent 依然认得用户。前者管 thread 内回放，后者管跨会话认知，demo 的会话 2 验的就是这条边界。
:::

## 延伸阅读

- [LangGraph：Memory](https://langchain-ai.github.io/langgraph/concepts/memory/)，官方对短期/长期记忆的切分，本篇两个节点就是 long-term memory 注入模式的落地，和 Day 1 的四分类对照读
- [LangGraph：Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)，checkpoint 机制的原始出处，和第 4 节那张协作图逐条对照
- [FastAPI：Background Tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)，生产版 save 异步的官方写法，第 15 周上传链路的同款

今天的产出 `memory_agent.py` 留好，明天 Day 7 周复盘：拿它测「用户第二次对话时 Agent 记得偏好」，把结果写进周记。回看[本周](/week17/)Day 1 画的那张架构图，三个存储框如今都接上了真的读写箭头；从[第 1 周](/week01/)的 `createResponse<T>` 走到今天，你手里第一次有了一个越用越懂你的 Agent。
