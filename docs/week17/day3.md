# 第 17 周 · Day 3：长期记忆——让 Agent 记得用户是谁

> 对应手册任务：学习「长期记忆：用户偏好存储」，动手用 PostgreSQL 存用户偏好、让 Agent 启动时加载，当日产出「偏好加载」。本篇只解决一个问题：昨天 [Day 2](/week17/) 的压缩保住了单次对话不爆 token，但会话一关记忆就清零——把「用户是谁」落进数据库，第二次对话时加载回来，注进 System Prompt。

## 今日目标

1. 说得清显式偏好和隐式偏好的区别，以及为什么先做显式
2. 掌握两张表的分工：`user_profiles` 存当前生效的画像，`user_memories` 存一条条记忆流水，以及写入、读取两条路径怎么走
3. 独立完成「偏好加载」：模拟一段含偏好的对话，抽取入库，再从库里读出来拼进 System Prompt，亲眼看 Agent 第二次启动时「认识你」

## 概念讲解：会话结束，记忆清零

昨天你把对话历史压成了「最近 N 轮 + 摘要」，token 曲线压平了。但压缩只是省空间，不产生持久。关掉终端，Redis 里的会话过期，摘要也没了。今天用户回来说「接着昨天的来」，Agent 一脸茫然：请问怎么称呼您？

换个角度感受这件事。楼下便利店的店员记得你：老样子，一瓶冰可乐不要吸管。这个「记得」让他不用每次都问，也让你愿意再来。Agent 的长期记忆就是这件事：记得用户是谁，下一次对话直接按已知的来。

长期记忆存什么？先把范围圈住，今天只存两类。

第一类，显式偏好：用户亲口说过的。「叫我 Jerry」「我是做后端开发的」「回复短一点，别啰嗦」。证据就在原文里，一个抽取器就能摘出来。

第二类，隐式偏好：用户没说，但从行为看得出来的。他每次都追问「底层原理是什么」→ 偏好深度内容；他总把你的代码整段抄走 → 偏好可运行的完整例子。

为什么先做显式？显式偏好有原文背书，抽对了就是对，抽错了也容易排查。隐式偏好要靠累积行为去猜：「追问细节」到底是稳定偏好，还是那天任务本身就需要细节？猜错一步，Agent 从此把人认错。所以隐式放到后面，今天先把「说过的存下来、下次带上来」这条链路跑通。

还有一个前置问题：存哪。昨天短期记忆在 Redis，今天长期记忆进 PostgreSQL。原因很实际：偏好是永不过期、可查可改可审计的数据，这是关系库的主场。

## 核心知识

本节代码用 Python + psycopg2 + OpenAI 兼容协议（第 11 周 Day 6 的多供应商写法，换个 base_url 就能切 Qwen/DeepSeek/GLM）。最终完整文件以下面的动手任务为准。

### 1. 表设计：画像与流水，两张表各管一摊

先给结论：一张表存「现在是什么样」，一张表存「发生过什么」。

```sql
-- 当前生效的用户画像：一用户一行
CREATE TABLE user_profiles (
  user_id    TEXT PRIMARY KEY,
  kv         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"称呼": "Jerry", "职业": "后端开发"}
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 记忆流水：一条条追加，保留来龙去脉
CREATE TABLE user_memories (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  content    TEXT NOT NULL,            -- 原意概括："称呼：Jerry"
  type       TEXT NOT NULL,            -- preference | fact
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_memories_user ON user_memories (user_id);
```

为什么非要两张？因为读取和回溯的诉求不同。Agent 启动时要的是「这个用户现在是什么样」，一次查一行，走 `user_profiles`；你想回溯「这条偏好是哪次对话来的、出现过几次」，要看历史，走 `user_memories`。类比：画像像 GitHub 的个人主页，流水像 commit history。主页只显示最新状态，但每个状态怎么来的，history 里都有。

`kv` 用 jsonb 而不是固定列，因为偏好的 key 提前定不全：今天是「称呼」「职业」，明天用户说「我讨厌 Python」，你不能天天 ALTER TABLE。jsonb 随加随用。

### 2. 写入路径：抽取器 prompt 与 upsert

写入分两步：先让 LLM 从对话里抽出偏好（第 11 周 Day 3 学的结构化输出，直接复用），再 upsert 进库。

抽取器的 prompt 是这条路径的灵魂：

```python
EXTRACT_PROMPT = """你是用户偏好抽取器，任务是从对话记录中抽取用户【明确亲口说过】的偏好和事实。

规则：
1. 只摘录用户明确说出的信息，禁止推测和总结，禁止从提问方式推断性格
2. 常见类别：称呼、职业、技术栈、语言偏好、回复风格、背景事实
3. 输出一个 JSON 对象，key 用简短中文短语，value 是原意概括
4. 对话里没有任何明确偏好时，输出 {}
5. 以下信息即使被提到也禁止输出：健康状况、财务状况、证件号、精确住址、政治与宗教观点

对话记录：
{transcript}"""
```

对照一个例子。「我叫 Jerry，做后端开发的，回答尽量简短点」应该抽出：

```json
{"称呼": "Jerry", "职业": "后端开发", "回复风格": "简短"}
```

规则 1 是抽取出错率的分水岭。不加这句，模型会自作聪明：「用户问了很多技术问题」→ `{"性格": "好奇心强"}`。这种记忆存进去就是污染。

拿到 JSON 后落库，画像用 jsonb 的 `||` 合并做 upsert：

```python
import json

def save_preferences(conn, user_id: str, prefs: dict) -> None:
    if not prefs:
        return
    with conn.cursor() as cur:
        # 画像：新 key 覆盖旧 key，其余保留
        cur.execute(
            """
            INSERT INTO user_profiles (user_id, kv, updated_at)
            VALUES (%s, %s::jsonb, now())
            ON CONFLICT (user_id) DO UPDATE
            SET kv = user_profiles.kv || EXCLUDED.kv,
                updated_at = now()
            """,
            (user_id, json.dumps(prefs)),
        )
        # 流水：每条偏好单独追加
        for key, value in prefs.items():
            cur.execute(
                """INSERT INTO user_memories (user_id, content, type, confidence)
                   VALUES (%s, %s, 'preference', 0.5)""",
                (user_id, f"{key}：{value}"),
            )
    conn.commit()
```

关键一行是 `kv = user_profiles.kv || EXCLUDED.kv`：`||` 是 jsonb 的合并运算符，同 key 时右边（新值）赢。用户从「叫我 Jerry」改口「叫我老王」，这条 SQL 跑完，画像里的称呼就换了，其他 key 一动不动。

### 3. 读取路径：入口节点把画像注进 System Prompt

读取只碰 `user_profiles`，一次一行：

```python
def load_profile(conn, user_id: str) -> dict:
    with conn.cursor() as cur:
        cur.execute("SELECT kv FROM user_profiles WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row[0] if row else {}

def build_system_prompt(profile: dict) -> str:
    if not profile:
        return "你是一个乐于助人的编程助手。"
    lines = "\n".join(f"- {k}：{v}" for k, v in profile.items())
    return (
        "你是一个乐于助人的编程助手。\n"
        "以下是已知的用户偏好，回答时必须遵守：\n" + lines
    )
```

这两个函数就是 Agent 图入口节点要做的事：

```python
def load_profile_node(state: dict) -> dict:
    """图的入口节点：启动时查库，把 System Prompt 准备好。"""
    profile = load_profile(conn, state["user_id"])
    return {"system_prompt": build_system_prompt(profile)}
```

LangGraph 的节点只返回要更新的字段，图的接线（把这个节点挂在 Agent 图最前面、和主循环串起来）是 [Day 6](/week17/) 的活，今天先把节点函数本身跑对。你注入的这段「已知用户偏好」，就是明天 Day 5 要系统设计的 System Prompt 模板里的「用户偏好」区——今天先埋桩，明天砌墙。

### 4. 更新与置信度：改口要覆盖，说过多次才算数

覆盖在 upsert 里已经解决，剩下的是置信度。为什么需要它：用户随口一句「叫我 Jerry」和三次对话里反复强调「叫我 Jerry」，分量不一样。单次说的可能是口误、可能是试探，落库存低置信（0.5）；同一条偏好再次出现，说明用户是认真的，升级。流水表里，重复的偏好不重复插入，而是给已有的那条加置信度。把第 2 节 `save_preferences` 里的 INSERT 循环换成调用下面这个函数：

```python
def record_memory(conn, user_id: str, content: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE user_memories
            SET confidence = LEAST(confidence + 0.2, 1.0)
            WHERE user_id = %s AND content = %s
            RETURNING id
            """,
            (user_id, content),
        )
        if cur.fetchone() is None:  # 没有旧记录，才插入新行
            cur.execute(
                """INSERT INTO user_memories (user_id, content, type, confidence)
                   VALUES (%s, %s, 'preference', 0.5)""",
                (user_id, content),
            )
    conn.commit()
```

`RETURNING id` 配合一次判断，把「有则升级、无则插入」合成一次往返。注意一个细节：读取路径永远只看 `user_profiles`，不看流水。用户改口后，流水里「称呼：Jerry」和「称呼：老王」两条都在——这正确，历史就该保留；但生效的只有画像里那条新的。置信度今天只进不出，先跑起来；等做隐式偏好时，低置信记忆要不要参与读取，就靠这个字段过滤。

### 5. 隐私红线：有些话听过就得忘

偏好抽取器是个自动记录员，用户聊什么它记什么，这恰恰是最危险的地方。第 19 周会系统讲安全与合规，今天先立规矩。

不存的清单（至少）：健康状况（病史、用药、诊断）、财务状况（收入、负债、银行卡号）、证件号、精确住址、政治与宗教观点，以及用户提到的第三方个人信息（「我同事小王月薪三万」同样是敏感数据）。

两层防御。第一层在抽取 prompt 里写明禁止清单（上面 EXTRACT_PROMPT 的规则 5），让 LLM 第一手就不往外吐。第二层在写库前跑一遍代码级兜底，LLM 的禁令不是百分百可靠：

```python
import re

SENSITIVE_PATTERNS = [
    re.compile(r"\d{17}[\dXx]"),   # 身份证号
    re.compile(r"\b\d{16,19}\b"),  # 银行卡号
]
SENSITIVE_KEYWORDS = ["病历", "诊断", "薪资", "存款", "负债", "身份证号"]

def contains_sensitive(text: str) -> bool:
    if any(p.search(text) for p in SENSITIVE_PATTERNS):
        return True
    return any(kw in text for kw in SENSITIVE_KEYWORDS)

# save_preferences 开头加一行，写库前整体过滤：
# prefs = {k: v for k, v in prefs.items() if not contains_sensitive(f"{k}{v}")}
```

为什么这么较真：《个人信息保护法》和 GDPR 对敏感个人信息的采集、存储都有明确约束，数据一旦落库就是「处理行为」，出事后删一行也抹不掉日志和备份。红线信息的正确姿势是压根不进库。

## 动手任务：偏好加载，一步一步

手册任务：用 PostgreSQL 存用户偏好，Agent 启动时加载。拆成 6 步，全程约 40 分钟，产出 `preference_loader.py`。

**第 1 步：起库建表。** 没有现成 PostgreSQL 就用 Docker 起一个：

```bash
docker run -d --name agent-pg -e POSTGRES_PASSWORD=dev123 -e POSTGRES_DB=agent -p 5432:5432 postgres:16
```

把核心知识第 1 节的 DDL 存成 `schema.sql`，执行 `cat schema.sql | docker exec -i agent-pg psql -U postgres -d agent`，再进 psql 用 `\dt` 确认两张表都在。

**第 2 步：搭骨架。** `pip install psycopg2-binary openai`，新建 `preference_loader.py`，把数据库连接和多供应商客户端写进去：

```python
import os
import json
import psycopg2
from openai import OpenAI

conn = psycopg2.connect(
    host="localhost", port=5432, dbname="agent",
    user="postgres", password="dev123",
)
client = OpenAI(
    api_key=os.environ["LLM_API_KEY"],
    base_url=os.environ.get("LLM_BASE_URL", "https://api.deepseek.com"),
)
```

**第 3 步：写抽取函数。** 把 EXTRACT_PROMPT 和结构化输出调用包成函数：

```python
def extract_preferences(transcript: str) -> dict:
    resp = client.chat.completions.create(
        model=os.environ.get("LLM_MODEL", "deepseek-chat"),
        messages=[
            {"role": "system", "content": EXTRACT_PROMPT.format(transcript=transcript)},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    return json.loads(resp.choices[0].message.content)
```

`temperature=0` 是刻意的：抽取要的是稳定，不是创意。

**第 4 步：跑写入路径。** 用一段含偏好的假对话当输入：

```python
transcript = """user: 你好
assistant: 你好！有什么可以帮你？
user: 我叫 Jerry，做后端开发的。回答尽量简短点，别贴大段解释。"""

prefs = extract_preferences(transcript)
print(prefs)  # 期望类似 {"称呼": "Jerry", "职业": "后端开发", "回复风格": "简短"}
save_preferences(conn, "u_001", prefs)
```

到 psql 里执行 `SELECT kv FROM user_profiles WHERE user_id = 'u_001';`，看见 JSON 就是写进去了。

**第 5 步：跑读取路径。** 关键验证来了，模拟「第二次对话」：Agent 冷启动，只靠查库恢复记忆。

```python
profile = load_profile(conn, "u_001")
print(build_system_prompt(profile))
# 你是一个乐于助人的编程助手。
# 以下是已知的用户偏好，回答时必须遵守：
# - 称呼：Jerry
# - 职业：后端开发
# - 回复风格：简短
```

这段 prompt 没有写死任何用户信息，全部来自数据库。换个 user_id 查，就是另一副面孔。「记得用户是谁」到此闭环。

**第 6 步：验证改口与升级。** 再跑一段对话，用户说「别叫 Jerry 了，叫我老王」，重复第 4、5 步。确认三点：画像里称呼变成老王、职业和风格没丢；`user_memories` 里新旧两条称呼记录都在；连跑两次同样内容后，同一条流水的 confidence 从 0.5 升到了 0.7。

::: tip 跑不动怎么办
LLM 返回不是合法 JSON 时，先 `print(resp.choices[0].message.content)` 看原文：多数是把规则当耳旁风输出了讲解文字，回到 EXTRACT_PROMPT 把「只输出 JSON」重申一遍。数据库连不上就回去检查 Docker 端口和密码，别在代码里瞎猜。
:::

## 常见踩坑

**坑 1：一张 jsonb 走天下。** 有人觉得流水表多余，把记忆全塞 kv。一个月后 kv 变成几十个 key 的杂物间：早就改口的旧称呼、误抽的敏感信息、临时试探性偏好全在里面，每次启动全量注入 System Prompt，token 白烧还互相打架。画像只存「当前生效、下次用得上」的，来龙去脉交给流水表。

**坑 2：抽取器太聪明。** 模型天生爱归纳，你不把「禁止推测」钉死在规则 1，它就给你抽「用户是急性子」「用户经济宽裕」。这种伪偏好注入 prompt 后，Agent 开始对着幻觉出来的性格演戏，用户一脸懵。判断标准：每条抽取结果都能在对话原文里找到出处，找不到的就是脑补。

**坑 3：置信度只升不降，或者压根不做。** 不做置信度，用户一句试探性的「以后都用法语回答吧」就被永久记账。只升不降同样有坑：用户明说「别再叫我 Jerry 了」，旧记忆的置信度还挂在 0.9。今天的版本先做到「重复出现才升级」，降级和过期留给隐式偏好阶段一起处理，但字段必须现在就留好，回头补列要扫全表。

**坑 4：把流水表也注入 prompt。** 读取路径顺手把 memories 也查了塞进去，理由是「信息更全」。全是不假，但流水里有旧值、有重复，Agent 同时拿到「叫我 Jerry」和「叫我老王」，行为就随机了。生效状态只有一份，在画像里。

**坑 5：updated_at 用应用时间。** 用 `datetime.now()` 写时间，多实例部署时时钟不一致，按时间排序就乱。统一用数据库的 `now()`，让存储层当唯一的时间权威。今天单机看不出差别，Day 6 上 LangGraph、将来多 worker 并发时这就是雷。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `user_profiles` 和 `user_memories` 各存什么？Agent 启动时读哪张，为什么？

::: details 参考答案
profiles 存当前生效的画像：一用户一行，kv 是 jsonb，新值覆盖旧值；memories 存一条条记忆流水：content、type、confidence，只追加不覆盖。启动时只读 profiles，因为要的是「现在是什么样」这一个快照，一次查一行；memories 用来回溯偏好来源和做置信度升级，不进 prompt。
:::

2. 显式偏好和隐式偏好分别是什么？为什么先做显式？

::: details 参考答案
显式是用户亲口说过的（称呼、职业、回复风格），对话原文就是证据；隐式是从行为推断的（总追问细节→偏好深度内容）。先做显式因为它抽取错误率低、错了好排查；隐式要猜，行为信号可能是一次性任务需要而非稳定偏好，猜错会让 Agent 永久认错人。先把显式链路跑通，隐式后面再加。
:::

3. `kv = user_profiles.kv || EXCLUDED.kv` 这行做了什么？用户改口时会发生什么？

::: details 参考答案
`||` 是 jsonb 的合并运算符，同 key 时右边（本次新值）赢，不同 key 全部保留。用户从「叫我 Jerry」改口「叫我老王」时，画像里称呼被覆盖为老王，职业等其他 key 原样保留，updated_at 刷新；流水表里新旧两条都还在，因为历史不删。
:::

4. 置信度为什么单次存 0.5、重复出现才升级？

::: details 参考答案
单次陈述可能是口误或试探，不能和反复强调的偏好同权重。同一条偏好再次出现时执行 LEAST(confidence + 0.2, 1.0) 升一档。这样将来做隐式偏好或记忆筛选时，可以只让高置信记忆参与读取，低置信的先晾着。
:::

5. 至少说出三类不能入库的信息，以及两层防御分别是什么？

::: details 参考答案
健康状况、财务状况、证件号、精确住址、政治与宗教观点、第三方个人信息，任答三类。第一层在抽取 prompt 写禁止清单，让 LLM 第一手不输出；第二层在写库前用正则和关键词做代码级兜底过滤。LLM 的禁令不是百分百可靠，敏感信息一旦落库就成了合规事实，正确姿势是压根不进库（第 19 周展开）。
:::

## 延伸阅读

- [PostgreSQL 文档：JSON Functions and Operators](https://www.postgresql.org/docs/current/functions-json.html)，`||` 合并等本篇用到的 jsonb 运算符的原始出处
- [PostgreSQL 文档：JSON Types](https://www.postgresql.org/docs/current/datatype-json.html)，json 与 jsonb 的区别，为什么长期记忆该用 jsonb
- [LangGraph 文档：Memory](https://langchain-ai.github.io/langgraph/concepts/memory/)，官方对短期/长期记忆的分层视角，和[本周日程](/week17/)对照着看

今天的产出 `preference_loader.py` 留好：`load_profile` 和 `build_system_prompt` 明天 Day 5 设计 System Prompt 模板时直接复用，Day 6 把它们挂进 LangGraph 的入口节点和每轮收尾，Agent 就完整地记得你是谁了。
