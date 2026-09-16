# 第 17 周 · Day 4：向量记忆：情景检索——让 Agent 记得你们聊过什么

> 对应手册任务：学习「向量记忆：情景检索」，动手「将历史对话 Embedding 存入向量库，新对话时检索相似情景」，当日产出「情景检索」。本篇只解决一个问题：用户在新会话里问"上次说的那个方案叫什么"，checkpoint 只会回放本线程，昨天的偏好档案只存结论不存经历，今天把历史对话压成记事条目存进向量库，新问题来了按语义捞回最相关的几条注入上下文，Day 1 架构图第三层的情景这一半落地。

## 今日目标

1. 说得清"上次那个"为什么 checkpoint 和偏好档案都接不住，情景记忆和 RAG 为什么是同一台发动机配两个油箱
2. 掌握三个写法：`conversation_chunks` 表与 `user_id` 过滤检索、对话压缩成记事后入库、语义分乘时间衰减的加权排序 SQL
3. 独立完成 `episodic.py`：会话 A 聊定一个方案并归档，会话 B 全新开问"上次那个"，检索命中、注入后模型正确说出方案名字

## 概念讲解：为什么"上次那个"没人接得住

场景很日常。周一，用户和 Agent 聊了半小时，把博客评论系统从 Disqus 迁到 giscus 的方案定了。周三，新开会话，第一句话："上次说的那个评论方案叫什么来着？"

把前两天攒的组件挨个拉出来审一遍。

Day 2 的对话压缩管不住。compaction 压的是本线程上下文，"最近 N 轮 + 摘要"在会话结束那一刻就随短期层过期了，新会话是空线程，摘要一个字都带不过来。第 12 周的 checkpoint 同理，它绑定线程，天生只回放本 thread，跨会话、跨 thread 一律失忆。

Day 3 的偏好档案也接不住。PG 里存的是"用户偏好轻量方案、写技术博客"这样的结论。偏好回答"你是什么样的人"，回答不了"我们上周聊过什么"。把对话事件也塞进档案更不行，Day 1 的坑 2 早说过：档案只存结论，原文和事件另有去处。

去处就是今天要建的情景记忆。Day 1 四分类里它的定位是"我经历过的事"：带时间、带当事人、可检索。有意思的是它的实现你在第 14 周已经写过一遍——Embedding、pgvector、`<=>`、`ORDER BY ... LIMIT`，一个零件不用新造。区别只在装什么数据：知识库存文档切块，回答"世界上有什么知识"；情景库存对话记事，回答"我们之间发生过什么"。同一台发动机，两个油箱。

顺着这个类比，今天的活就四件：建一张装对话记事的表；定一套"对话怎么变成记事、什么时候入库"的规则；检索结果注入新会话的上下文；外加一个 RAG 没有的新问题——回忆有时间属性，上周的对话该比去年的排得靠前。

## 核心知识

### 1. 数据模型：conversation_chunks 表

```sql
CREATE TABLE conversation_chunks (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content    TEXT NOT NULL,
  embedding  VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chunks_user_time ON conversation_chunks (user_id, created_at DESC);
```

对比第 14 周的 `documents` 表：`content` 加 `embedding` 加 `<=>` 检索这套原封不动，变化有三处。`user_id` 是安全边界，情景检索永远带着 `WHERE user_id = ...`——多用户系统里漏了它，B 用户的问题会检索出 A 用户的私聊，这不是 bug，是数据事故。`session_id` 记记事出自哪次会话，排查和按会话清理时用。`created_at` 为时间衰减而生，第 4 小节靠它排序。

为什么不学第 14 周把这三个字段塞进 `metadata` JSONB？过滤思路确实复用了那套，但这三个字段每次查询都要用、要精确匹配、要参与排序，值得独立成列建索引。JSONB 适合"随文档类型自由生长"的元数据，`user_id` 这种结构性字段，放列里才是正座。

### 2. 写入：先把对话压成记事，再向量化

写入时机两种：会话结束时整段归档，或每攒够 N 轮（比如 5 对问答）归档一批。前者省事，后者防会话异常中断丢记忆，先跑通会话结束触发这条。

写入内容是今天的第一个关键决定：存压缩后的记事，不存对话原文。一轮"用户问 + Agent 答"共 300 字，压成记事只要一句：

> 用户为博客评论系统选型，嫌 Disqus 广告多，暂定 giscus 方案。

两个理由。检索才准：原文里"你好""谢谢""我再想想"这类寒暄占了一半篇幅，embedding 被稀释，方向反而模糊；记事句句是干货，向量指向集中。存储才省：20 轮对话 3000 字压成几条 60 字的记事，Embedding 按 token 计费省一大截，将来命中了拼进上下文，也是 60 字而不是 3000 字。这笔账和 Day 2 的压缩同一个逻辑：进上下文的东西，都要先过一道提炼。

压缩这活交给 LLM，一个函数的事，见动手任务第 2 步。

### 3. 检索注入：user_id 过滤 + Top-3

```sql
SELECT content,
       1 - (embedding <=> $1::vector) AS score,
       created_at
FROM conversation_chunks
WHERE user_id = $2
ORDER BY embedding <=> $1::vector
LIMIT 3;
```

结构就是第 14 周 Day 6 的检索 SQL 加一个 WHERE。K 取 3 不取 5：情景条目每条是完整记事，信息密度高，3 条足够模型对上"上次那个"；条数多了反而把八竿子打不着的旧事塞进上下文。

命中后注入的格式没有玄机，一段前缀加带日期的列表：

```text
过往相关经历（与当前问题相关才使用）：
- [2026-09-14] 用户为博客评论系统选型，暂定 giscus 方案。
```

"与当前问题相关才使用"这半句是护栏：检索只保证相似，不保证相关，把裁量权留给模型，免得它硬套旧记忆。

### 4. 时间衰减：上周的比去年的相关

纯语义排序有个盲区。用户一年前聊过"前端用 Vue 2"，上个月聊过"迁到 Vue 3"，今天问"上次那个前端方案"。两条记事语义都命中，纯比距离说不准谁前谁后，但答案显然是上个月那条——人的"上次"默认指近期。

解法是给语义分乘一个随时间衰减的因子：

```sql
SELECT content,
       (1 - (embedding <=> $1::vector))
         * power(0.5, EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0 / 30.0) AS final_score
FROM conversation_chunks
WHERE user_id = $2
ORDER BY final_score DESC
LIMIT 3;
```

拆开读。`1 - (embedding <=> ...)` 还是余弦相似度，越大越像。`power(0.5, 天数 / 30)` 是半衰期函数：每过 30 天权重砍半，一周前的记事剩 0.98，一年前（约 12 个半衰期）的只剩 0.0002。两式相乘，语义分是主项，时间是折扣：两条都在近期，基本纯比语义；一条一年前一条上周，除非旧那条语义分明显高得多，否则新的赢。这就是"上周的对话比去年的更相关"的量化表达。30 天别照抄，按产品对话频率定：用户天天来，一周前的旧事就老了；低频工具，半年也新鲜。

还要注意排序方向变了。前几天的检索都是 `ORDER BY 距离`（升序，越小越像），这里算的是加权分，得写 `ORDER BY final_score DESC`，越大越前。方向搞反不会报错，检索器只会静默返回最不相关的三条，这种错靠第 5 步的实验才能抓住。

## 动手任务：`episodic.py` 一步一步

手册任务：将历史对话 Embedding 存入向量库，新对话时检索相似情景。拆成 5 步，全程约 30 分钟。前提：第 14 周那台 `pgvector/pgvector:pg16` 容器还活着，扩展已激活。

**第 1 步：建表。** 进 psql，执行第 1 小节的两条 SQL，再跑一句验收：

```sql
SELECT '[1,0]'::vector <=> '[1,1]::vector;  -- 0.29289，扩展活着
```

**第 2 步：压缩与入库。** 练习目录执行 `pip install "psycopg[binary]" openai`，新建 `episodic.py`：

```python
import psycopg
from openai import OpenAI

client = OpenAI()  # 环境变量 OPENAI_API_KEY
CONN = "postgresql://postgres:devpass@localhost:5432/postgres"
EMBED_MODEL = "text-embedding-3-small"  # 和第 14 周同一个模型，铁律不变

def embed(texts: list[str]) -> list[list[float]]:
    resp = client.embeddings.create(model=EMBED_MODEL, input=texts)
    return [item.embedding for item in resp.data]

def summarize_turn(user_msg: str, agent_msg: str) -> str:
    """一轮问答 → 一句第三人称记事"""
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": (
                "把下面这轮对话压缩成一句第三人称记事，像写日记：主语是用户，"
                "写下他做了什么决定、定了什么方案、结论是什么。不评论，不超过 60 字。"
            )},
            {"role": "user", "content": f"用户：{user_msg}\nAgent：{agent_msg}"},
        ],
    )
    return resp.choices[0].message.content.strip()

def remember(user_id: str, session_id: str, note: str) -> None:
    vec = "[" + ",".join(str(x) for x in embed([note])[0]) + "]"
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO conversation_chunks (user_id, session_id, content, embedding)
               VALUES (%s, %s, %s, %s::vector)""",
            (user_id, session_id, note, vec),
        )
```

`remember()` 就是第 14 周 Day 5 的入库节奏减掉分批，一次一条用不着批。压缩提示词里"第三人称"是刻意的：记事主语统一成"用户"，多条记事的行文风格才一致，和用户问句的相似度对比才稳。

**第 3 步：检索函数。** 往文件里加：

```python
def recall(user_id: str, query: str, k: int = 3) -> list[dict]:
    vec = "[" + ",".join(str(x) for x in embed([query])[0]) + "]"
    sql = """
        SELECT content,
               1 - (embedding <=> %(vec)s::vector) AS score,
               created_at
        FROM conversation_chunks
        WHERE user_id = %(uid)s
        ORDER BY embedding <=> %(vec)s::vector
        LIMIT %(k)s;
    """
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(sql, {"vec": vec, "uid": user_id, "k": k})
        rows = cur.fetchall()
    return [
        {"content": r[0], "score": round(r[1], 4), "created_at": r[2]}
        for r in rows
    ]
```

和第 14 周 Day 6 的 `search()` 逐行对比着看，只多一个 WHERE。参数化查询的老规矩不变，`user_id` 再像内网数据也不手拼 SQL。

**第 4 步：加时间衰减。** 再加衰减版，和 `recall` 并存，第 5 步两个都跑，直观对比排序差异：

```python
DECAY_SQL = """
    SELECT content,
           (1 - (embedding <=> %(vec)s::vector))
             * power(0.5, EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0 / 30.0)
           AS final_score,
           created_at
    FROM conversation_chunks
    WHERE user_id = %(uid)s
    ORDER BY final_score DESC
    LIMIT %(k)s;
"""

def recall_recent(user_id: str, query: str, k: int = 3) -> list[dict]:
    vec = "[" + ",".join(str(x) for x in embed([query])[0]) + "]"
    with psycopg.connect(CONN) as conn, conn.cursor() as cur:
        cur.execute(DECAY_SQL, {"vec": vec, "uid": user_id, "k": k})
        rows = cur.fetchall()
    return [
        {"content": r[0], "score": round(r[1], 4), "created_at": r[2]}
        for r in rows
    ]
```

想亲眼看衰减的威力，往 psql 里手工插一条 `created_at` 定在去年的记事（INSERT 里显式给 `created_at` 赋值即可），再跑同样的查询，看它被压到多后面。

**第 5 步：两会话实验。** 今天的验收现场：会话 A 聊定方案并归档，会话 B 全新线程只问"上次那个"：

```python
if __name__ == "__main__":
    # ===== 会话 A：聊定方案，会话结束归档 =====
    note = summarize_turn(
        "我的博客评论一直用 Disqus，广告太多想换掉，有什么轻量方案？",
        "推荐 giscus：基于 GitHub Discussions，无广告，支持 Markdown，几行脚本嵌入静态博客。",
    )
    remember("u1", "session-a", note)
    print("已归档：", note)

    # ===== 会话 B：全新线程，只问"上次那个" =====
    query = "上次说的那个评论方案叫什么来着？"
    hits = recall("u1", query)
    for h in hits:
        print(h["score"], h["created_at"].date(), h["content"])

    context = "过往相关经历（与当前问题相关才使用）：\n" + "\n".join(
        f"- [{h['created_at'].date()}] {h['content']}" for h in hits
    )
    print(context)  # 把 context 和 query 一起发给 LLM，"那个"就能对上 giscus
```

实验成功的标准：`recall` 的第一条命中 giscus 那句记事，分数明显高于其余条目；打印出的 `context` 拼上 query 丢给任意聊天模型，它都能答出"上次你定的是 giscus"。注意会话 B 从头到尾没碰会话 A 的任何原文，靠的就是那条 60 字的记事——"上次那个"这种指代，模型本来无从对起，情景注入之后才有了着落。

::: tip 老数据别忘清
`episodic.py` 每跑一次 `remember` 就多一条，重复实验会把同一条记事塞满库。脚本开头加一句 `DELETE FROM conversation_chunks WHERE user_id = 'u1';` 保持幂等，第 14 周坑 5 的老教训。
:::

## 常见踩坑

**坑 1：检索忘了 user_id 过滤。** `WHERE user_id = ...` 一删，`recall` 照样跑得欢，实验还全对——因为实验室里只有一个用户。上线后 B 的提问检索出 A 的私聊，就是安全事故。定条铁律：情景检索的 SQL 模板里 `user_id` 写死在 WHERE，不做成可选参数。自查也简单：插两条不同 user_id 的记事，用其中一人查，另一人的必须绝不出现。

**坑 2：偷懒存对话原文。** "压缩多一道 LLM 调用，好贵"，于是把 20 轮原文直接 embed 入库。三笔账一起输：Embedding 按 token 计费，原文贵几十倍；寒暄稀释向量，排序悄悄变差；命中后 3000 字原文拼进上下文，Day 1 苦心经营的"会话内不爆炸"换个地方复发，情景库变成第二个 checkpoint 垃圾场。

**坑 3：情景库和知识库混一张表。** "反正都是向量，塞进 documents 加个 metadata 标记呗。"Day 1 坑 4 说过 metadata 过滤是最低防线，但今天有更彻底的做法：直接分表。两张表结构天然不同（conversation_chunks 没有 metadata，多出 user_id 和 created_at），分表之后忘了过滤最多结果为空，而不是用户问"上次那个"检索出一堆科普文档。能用表结构挡住的错误，就别靠自觉防。

**坑 4：衰减排序方向搞反，半衰期乱拍。** 之前的检索都是 `ORDER BY 距离`升序，衰减版算的是加权分，得 `ORDER BY final_score DESC`。写反了不报错，返回的是最不相关的三条，模型拿着南辕北辙的"回忆"一本正经地编。半衰期也别照抄：30 天只是示例，天天活跃的产品用 7 天，低频工具用 90 天，说得出你产品对话频率的依据，这个数才立得住。

**坑 5：检索回什么就注入什么。** 用户问"今天天气怎样"，库里只有三条八个月前的旧记事，纯语义检索照样吐出 top3——总有三条排最前。不相关回忆硬注入，模型要么无视（白花 token），要么硬套（答非所问）。给 `recall` 加道相似度闸门：最高分低于阈值就返回空列表，没有相关回忆就不注入，阈值用第 14 周 Day 6 的标定方法在自己的数据上切。会回忆是能力，知道没有相关回忆，也是。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. "上次说的那个方案"这个问题，checkpoint、偏好档案、情景记忆分别能不能接住？为什么？

::: details 参考答案
checkpoint 接不住：绑定会话线程，只回放本 thread，新会话是空线程。偏好档案接不住：存的是结论性事实（"用户偏好轻量方案"），回答"你是什么样的人"，不存"我们经历过什么"。情景记忆接得住：历史对话压成记事进了向量库，新问题语义检索命中那条记事，注入后模型把"那个"对上具体方案。
:::

2. `conversation_chunks` 和第 14 周的 `documents` 表差在哪三处？各自为什么？

::: details 参考答案
多出 `user_id`、`session_id`、`created_at` 三列。`user_id` 是多用户隔离的安全边界，每次检索必带，值得独立成列建索引；`session_id` 记记事来源会话，供排查和按会话清理；`created_at` 支撑时间衰减排序。检索机制（content + embedding + `<=>` + ORDER BY LIMIT）与 documents 完全一致，这正是"同机制不同数据"。
:::

3. 为什么情景库存压缩记事而不存对话原文？

::: details 参考答案
两个理由。检索才准：原文里寒暄客套稀释语义，embedding 方向发散，记事句句干货，向量指向集中。存储才省：20 轮 3000 字压成 60 字，Embedding 按 token 计费便宜几十倍，将来命中拼进上下文也只占 60 字，上下文爆炸不会在记忆层复发。
:::

4. 时间衰减加权式里 `power(0.5, 天数/30)` 是什么意思？语义分和时间各自扮演什么角色？

::: details 参考答案
半衰期 30 天的衰减因子：每过 30 天权重砍半。语义相似度是主项，决定"这条记事和问题像不像"；时间是折扣项，表达"上周的对话比去年的更相关"。相乘之后，同为近期记事基本纯比语义，新旧悬殊时新记事有明显优势。半衰期按产品对话频率定，不照抄。
:::

5. 检索结果不相关时该不该注入？怎么判断"不相关"？

::: details 参考答案
不该。硬注入轻则浪费 token，重则模型硬套旧记忆答非所问。判断靠相似度闸门：最高分低于阈值就返回空、不注入。阈值不拍脑袋，抽真实问题人工标注相关与否，看两组分数分布在哪，中间切一刀；换模型或换数据重标。
:::

## 延伸阅读

- [MemGPT 论文](https://arxiv.org/abs/2310.08560)，把 LLM 当操作系统、记忆分页管理的经典工作，今天"什么进上下文、什么留库外"的取舍，它给了一套完整框架
- [Zep 论文](https://arxiv.org/abs/2501.13956)，时间感知的 Agent 记忆架构，情景检索加时间因素的系统化版本，坑 4 的加权式是它的极简版
- [PostgreSQL 日期时间函数文档](https://www.postgresql.org/docs/current/functions-datetime.html)，`EXTRACT(EPOCH FROM ...)` 和日期运算的官方说明，衰减 SQL 的原始出处

今天的产出 `episodic.py` 留好。到这里，Day 1 架构图的第三层补完：情景和语义在向量库里各归各位，过滤、检索、衰减都能跑。明天（见[本周日程](/week17/)）把三层记忆拧进 System Prompt，"角色 + 工具 + 偏好 + 经历"拼成一个完整模板。从[第 1 周](/week01/)的 `createResponse<T>` 走到今天，Agent 终于记得住你们聊过什么了。
