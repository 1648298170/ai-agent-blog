# 第 11 周 · Day 3：结构化输出——把模型的自由发挥锁进 Schema

> 对应手册任务：学习「结构化输出：JSON Schema 约束（response_format 严格模式）、Pydantic 解析与失败重试」，动手实现「用户评论 → 结构化情感分析」接口，验证 Schema 符合率 100%，当日产出「结构化输出模块」。本篇只解决一个问题：模型天生吐自然语言，而下游代码要的是稳定字段，把「提示词里求它输出 JSON」的碰运气，换成「吐出来的每个字段都错不了」的硬保证。

## 今日目标

1. 说得清「提示词求 JSON」为什么不可靠，`json_object` 与 `json_schema` 严格模式各保证什么、不保证什么
2. 掌握三件事：用 Pydantic 的 `model_json_schema()` 生成 Schema 喂给 API、用 `model_validate_json` 解析响应（第 9 周知识复用）、校验失败时带错误信息重问模型的自愈重试
3. 独立完成「用户评论 → 结构化情感分析」模块，包成 FastAPI `/analyze` 端点，批量跑评论验证 Schema 符合率 100%

## 概念讲解：为什么提示词求 JSON 不可靠

到今天为止，你已经会原生调用，也玩过 Function Calling。但 Agent 工程里更日常的需求其实更朴素：让模型直接输出一个结构化结果，给程序消费。比如「评论 → 情感分析」，下游要的是 `{"sentiment": "positive", "score": 0.9}`，于是你在提示词里认真写上「请以 JSON 格式返回结果，包含 sentiment 字段」。

然后你会撞上模型的三种背叛。第一种，加围栏：输出被包进 ` ```json ` 代码块，前面还带一句「好的，以下是分析结果」。第二种，自由发挥字段：`sentiment` 给你写「好评」，`score` 给你写成字符串 `"0.9"`，或者热情洋溢地加一个你没要的 `reason` 字段。第三种，JSON 里夹注释、带尾逗号，`json.loads` 当场爆炸。

你写个容错函数：正则剥围栏、截取第一个花括号、try/except 包住解析。语法层的错多半能救，字段层的错救不了——`{"sentiment": "好评"}` 是完全合法的 JSON，可程序拿它进不了 `if result.sentiment == "positive"` 这个分支。

更要命的是这一切是概率性的。手测十条全过，你觉得稳了；上线后每天五千次调用，哪怕 2% 的失败率也是每天一百次崩溃告警。demo 里 90% 可用叫能用，生产里 99% 可用都叫事故。结构化输出要的不是「模型通常听话」，是「不听话的输出根本生成不出来」。

## 核心知识

本节的代码片段都可以单独跑，模型名按你实际可用的填，最终完整实现以下面的动手任务为准。

### 1. 三条路线，三档保证

**路线一：提示词 + 解析容错。** 提示词写清字段要求，拿到输出后剥围栏、容错解析、失败重试全自己写。围栏能剥，字段错没法猜，只能靠校验器兜底。适合当天就要演示的 demo。

**路线二：`json_object` 模式。** 请求里加一个参数：

```python
resp = client.chat.completions.create(
    model=MODEL,
    messages=messages,
    response_format={"type": "json_object"},  # 只保证「合法 JSON」
)
```

API 在解码阶段保证输出能被 `json.loads`，围栏和开场白从此绝迹。但字段名、类型、枚举值全靠模型自觉：你要求 `positive/neutral/negative`，它照样可能回「好评」。另外 OpenAI 规定这个模式下 messages 里必须出现「JSON」字样，否则请求直接 400。

**路线三：`json_schema` 严格模式。**

```python
resp = client.chat.completions.create(
    model=MODEL,
    messages=messages,
    response_format={
        "type": "json_schema",
        "json_schema": {
            "name": "sentiment_result",
            "schema": schema,   # 你定义的 JSON Schema
            "strict": True,     # 约束解码级保证
        },
    },
)
```

关键在 `strict: True`：它做的是约束解码（constrained decoding），生成每个 token 时，凡是会导致输出偏离 Schema 的候选直接被屏蔽。字段缺失、类型不对、枚举越界，不是「事后被纠正」，是从根上生成不出来。这是 OpenAI gpt-4o 及之后模型的能力。注意 DeepSeek、GLM 这类 OpenAI 兼容端点对它支持度不一：有的只认 `json_object`，有的对 Schema 里某些写法报错，文档还可能滞后。所以生产代码别赌端点能力，先按 strict 发，端点报不支持就降级到路线二，再靠校验和重试兜底。这套兜底今天动手部分会完整写出来。

三档保证排个序：路线三保证「符合你给的 Schema」，路线二保证「是合法 JSON」，路线一什么都不保证，只保证你多写了五十行容错代码。

### 2. Pydantic 生成 Schema：一个类管两头

手写 JSON Schema 字符串，再手写一份解析代码，就是两份独立事实，改字段时总有一边忘了改。用 Pydantic，从头到尾只有一个类：

```python
from typing import Literal
from pydantic import BaseModel

class SentimentResult(BaseModel):
    sentiment: Literal["positive", "neutral", "negative"]
    score: float          # 0 到 1，该情感的置信度
    keywords: list[str]   # 触发判断的原文关键词，最多 5 个
    summary: str          # 一句话概括评论

print(SentimentResult.model_json_schema())
```

`model_json_schema()` 是第 9 周学 Pydantic 时埋下的另一半：当时只用 Pydantic 校验数据，现在把它的图纸喂给 API。上游约束、下游校验，同一个类定义，模型和代码看同一张图，想漂移都没机会。

strict 模式对 Schema 有两条硬性要求：所有字段列进 `required`，对象加 `additionalProperties: false`。Pydantic 对全必填模型会自己生成 required，但字段一旦带默认值它就不进了，所以统一补一刀：

```python
def to_strict_schema(model: type[BaseModel]) -> dict:
    schema = model.model_json_schema()
    schema["additionalProperties"] = False
    schema["required"] = list(schema["properties"].keys())
    return schema
```

关键在后两行：不管 Pydantic 导出成什么样，补完一定是 strict 要的形状。今天的模型是单层的，以后嵌套子对象时，内层对象也得同样处理，先记住这回事。

### 3. 解析：`model_validate_json`，第 9 周的老朋友

```python
result = SentimentResult.model_validate_json(resp.choices[0].message.content)
```

第 9 周说过，它底层走 Rust 直接解析 JSON 字符串，比 `json.loads` 再 `model_validate` 快。这周它多了一重身份：校验闸门。类型不对、枚举越界、字段缺失，抛 `ValidationError`；过了闸，你手里就是强类型实例，后面的代码全程 IDE 补全。注意即使请求走的是 strict 模式，这一步也不能省——降级路径的输出、兼容端点的意外，都得靠它在门口拦住。

### 4. 失败重试：带着报错回去质问

校验失败后把同样的请求从零重发一遍是浪费：模型不知道自己错在哪，大概率原样再错。正确姿势叫 self-correction，把上次的输出和具体报错都塞回对话，让它改：

```python
from pydantic import ValidationError

def analyze_with_retry(comment: str, max_attempts: int = 3) -> SentimentResult:
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": comment},
    ]
    for _ in range(max_attempts):
        content = call_llm(messages)
        try:
            return SentimentResult.model_validate_json(content)
        except ValidationError as e:
            messages += [
                {"role": "assistant", "content": content},  # 案发现场留在上下文里
                {"role": "user", "content": (
                    f"上面的 JSON 校验失败：{e.errors()}。"
                    "请严格按 Schema 重新输出，只输出 JSON 本身。"
                )},
            ]
    raise RuntimeError(f"重试 {max_attempts} 次仍未通过校验")
```

关键在 except 里那两条消息：assistant 消息把上次的原始输出留在上下文里，user 消息给出具体死因，模型才知道往哪改。另外 `max_attempts` 必须封顶，否则修复循环自己变成烧钱的无底洞；重试耗尽就抛异常给上层，记日志、发告警，别吞。

### 5. 包成 FastAPI 端点

请求进、结构化结果出，Pydantic 一鱼两吃：

```python
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI()

class AnalyzeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)

@app.post("/analyze", response_model=SentimentResult)
def analyze(req: AnalyzeRequest) -> SentimentResult:
    return analyze_with_retry(req.text)
```

关键在 `response_model=SentimentResult`：出去的响应形状被同一个类锁死，FastAPI 的自动文档也跟着 Schema 生成。流式场景记住一条：流出来的是 JSON 碎片，要攒齐、整体校验通过，再交给消费者，别把半个 JSON 推给前端。

## 动手任务：「评论 → 结构化情感分析」一步一步

手册任务：实现「用户评论 → 结构化情感分析」接口，验证 Schema 符合率 100%。拆成 5 步，全程约 30 分钟。

**第 1 步：建文件、定义模型。** 新建 `structured_output.py`，它就是当日产出的结构化输出模块：

```python
import os
from typing import Literal

from openai import OpenAI, BadRequestError
from pydantic import BaseModel, Field, ValidationError

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])  # 兼容端点再加 base_url=...
MODEL = "gpt-4o-mini"  # 按你实际可用的填

class SentimentResult(BaseModel):
    sentiment: Literal["positive", "neutral", "negative"]
    score: float = Field(ge=0, le=1)
    keywords: list[str] = Field(max_length=5)
    summary: str

SYSTEM_PROMPT = (
    "你是电商评论情感分析引擎。对用户评论输出 JSON："
    "sentiment 取 positive/neutral/negative 之一；"
    "score 是 0 到 1 的置信度；"
    "keywords 是触发判断的原文关键词，最多 5 个；"
    "summary 一句话概括评论。只输出 JSON。"
)

def to_strict_schema(model: type[BaseModel]) -> dict:
    schema = model.model_json_schema()
    schema["additionalProperties"] = False
    schema["required"] = list(schema["properties"].keys())
    return schema
```

`Field` 的约束不是白写的：`ge`、`le`、`max_length` 会被 `model_json_schema()` 映射成 Schema 里的 `minimum`、`maximum`、`maxItems`，一并交给 API 约束。SYSTEM_PROMPT 里每个字段的取值都写了，还出现了「JSON」字样，这是 `json_object` 模式的前置条件，降级时用得上。

**第 2 步：调用函数，strict 优先、自动降级。**

```python
def call_llm(messages: list[dict]) -> str:
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0,  # 抽取任务要稳定，采样参数见第 11 周 Day 1
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "sentiment_result",
                    "strict": True,
                    "schema": to_strict_schema(SentimentResult),
                },
            },
        )
    except BadRequestError:
        # 端点不支持 json_schema（或不认 Schema 的某些写法），降级到 json_object
        resp = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            temperature=0,
            response_format={"type": "json_object"},
        )
    return resp.choices[0].message.content
```

降级后的输出只有「合法 JSON」这层保证，字段对不对交给第 3 步的校验和重试去兜。两条路径，同一个校验闸门，这才是能在不同端点之间移植的写法。

**第 3 步：套上校验重试。** 把核心知识第 4 节的 `analyze_with_retry` 抄进文件，跑一条试试：

```python
if __name__ == "__main__":
    print(analyze_with_retry("物流快得离谱，包装扎实，就是客服回复慢了点"))
```

预期输出类似 `sentiment='positive' score=0.8 keywords=['物流快', '包装扎实'] summary='物流和包装满意，客服响应偏慢'`。

**第 4 步：批量验证 Schema 符合率。** 手册要求 100%，不是抽查一条算过。往文件里加一批评论，凑满 20 条，自己编就行，长短、语气、带错别字的都来点：

```python
COMMENTS = [
    "物流快得离谱，包装扎实，就是客服回复慢了点",
    "用了三天就坏了，申请售后没人理，避雷",
    "普通吧，说不上好也说不上坏",
    # ...凑满 20 条
]

def verify_schema_compliance() -> None:
    passed = 0
    for text in COMMENTS:
        result = analyze_with_retry(text)  # 走完不抛异常，即符合 Schema
        assert 0 <= result.score <= 1
        passed += 1
    print(f"Schema 符合率：{passed}/{len(COMMENTS)} = {passed / len(COMMENTS):.0%}")
```

把 `__main__` 里的单条调用换成 `verify_schema_compliance()` 再跑。100% 的底气来自三道闸：strict 约束解码、`model_validate_json` 校验、带报错的重试。任何一条评论三次重试后仍失败，函数会抛异常——真抛了就去日志里看模型的原始输出，那是宝贵的失败样本，攒下来就是你项目的测试集。

**第 5 步：FastAPI 端点。** 把核心知识第 5 节的 `app`、`AnalyzeRequest`、`/analyze` 加到文件末尾，然后启动：

```bash
uvicorn structured_output:app --reload
```

另开一个终端验证：

```bash
curl -X POST http://127.0.0.1:8000/analyze \
  -H "Content-Type: application/json" \
  -d '{"text": "物流很快，就是客服爱答不理"}'
```

返回长这样，每个字段都过得了 `SentimentResult` 的校验：

```json
{
  "sentiment": "neutral",
  "score": 0.6,
  "keywords": ["物流很快", "客服爱答不理"],
  "summary": "物流满意但客服态度差，整体中性"
}
```

::: tip 运行前提
`pip install "pydantic>=2" openai fastapi uvicorn`。Key 从环境变量 `OPENAI_API_KEY` 读，别硬编码进文件。用 DeepSeek、GLM 等兼容端点时，把 `base_url` 和 `MODEL` 换成对应值，第 2 步的降级逻辑会自动接住不支持 strict 的端点。
:::

## 常见踩坑

**坑 1：`json_object` 模式直接 400。** OpenAI 规定该模式下 messages 里必须出现「JSON」这个单词，否则请求被拒。报错信息里其实写了原因，别当成玄学。本篇的 SYSTEM_PROMPT 第一句就有「输出 JSON」，天然满足。

**坑 2：strict 模式没有「可选字段」。** 常规 JSON Schema 的惯例是「不写进 required 就是可选」，strict 模式不认这套：所有字段必须列进 required。想表达「可以为空」，把 null 加进类型（Pydantic 写 `str | None`，Schema 里是 anyOf）；想表达「可以没有」，让模型填 `"unknown"` 这类哨兵值。Pydantic 字段一旦带默认值就不进 required，这正是 `to_strict_schema` 里那行 `required = ...` 兜底存在的原因。

**坑 3：信了 response_format 就不校验。** 「API 承诺会符合 Schema」和「这条输出符合 Schema」是两回事：降级路径的存在、兼容端点的实现差异、上游某次行为变更，都可能放漏网之鱼进来。`model_validate_json` 是最后一道闸，永远写在代码里，不依赖任何文档承诺。符合率是不是 100%，从来是校验器说了算。

**坑 4：重试不带错误信息。** 把同样的 messages 原样再发一遍，模型大概率把同样的错再犯一遍——它看不见自己错在哪。必须带上 assistant 的原始输出和 ValidationError 的具体内容，self-correction 才成立。同时次数封顶、耗尽即抛：修复机制自己不能变成新的故障源。

**坑 5：抽取任务还开着温度。** [第 11 周 Day 1](/week11/day1) 讲采样参数时说过，temperature 越低输出越确定。情感分析这类「同一输入要同一输出」的任务，temperature 给 0。开着 0.7 跑，同一条评论两次分析给出不同 sentiment，下游报表对不上数，排查半天最后发现是采样随机性，最冤的一种坑。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 「提示词求 JSON」的失败有哪几种典型形态？哪些能靠解析容错救回来，哪些救不回来？

::: details 参考答案
三种：围栏和开场白（` ```json `、客套话）；JSON 语法错误（注释、尾逗号）；字段层面的错（名字不对、类型不对、枚举自由发挥、缺字段）。前两种部分能靠剥壳和容错解析救回；第三种救不回来，因为「合法 JSON」和「错误字段」可以同时成立，程序没法猜。根治靠 response_format 约束加校验，不靠更恳切的提示词。
:::

2. `json_object` 和 `json_schema` strict 各保证什么、不保证什么？面向 DeepSeek 这类兼容端点的生产代码该怎么写？

::: details 参考答案
`json_object` 保证输出是合法 JSON，能被 `json.loads`，但不保证任何字段的名字、类型、取值；`json_schema` strict 是约束解码，从生成层面保证输出符合你给的 Schema。兼容端点支持度不一，生产代码应当先按 strict 发请求，端点抛 BadRequestError 就降级到 `json_object`，再统一用 `model_validate_json` 校验、失败带报错重试——两条路径共用同一道校验闸门。
:::

3. Schema 为什么用 `model_json_schema()` 生成，而不是手写 JSON Schema 字符串？

::: details 参考答案
Pydantic 类同时是两样东西的唯一出处：喂给 API 的 Schema（`model_json_schema` 导出）和解析响应的校验器（`model_validate_json`）。改一处，两边同时变。手写 Schema 会多出一份独立事实，和解析代码靠人肉保持同步，迟早漂移。
:::

4. 校验失败后的重试要带哪两样信息？缺了为什么基本无效？

::: details 参考答案
带上次的原始输出（assistant 消息）和具体的校验报错（ValidationError 的内容）。缺前者，模型对「案发现场」一无所知；缺后者，它只知道错了不知道错在哪。self-correction 的前提是错误可定位。
:::

5. strict 模式对 required 的要求，和 JSON Schema 的通用惯例有什么冲突？Pydantic 的哪种写法会踩进这个坑？

::: details 参考答案
通用惯例是「不进 required 即可选」，strict 要求所有字段全部进 required，「可选」语义改由类型带 null 表达。Pydantic 字段带默认值（包括 `str | None = None`）时不会出现在 required 里，导出的 Schema 过不了 strict 校验，所以要在后处理里强制补全 required。
:::

## 延伸阅读

- [OpenAI：Structured Outputs 指南](https://platform.openai.com/docs/guides/structured-outputs)，strict 模式的官方说明，支持的字段类型和所有限制条件以这里为准
- [Pydantic：JSON Schema](https://docs.pydantic.dev/latest/concepts/json_schema/)，`model_json_schema` 的导出规则，`Field` 约束如何映射成 Schema 关键字
- [JSON Schema 官网](https://json-schema.org/)，Schema 语言本身，`additionalProperties`、`required` 这些关键字在通用规范里的语义

今天的产出 `structured_output.py` 留好。后面把工具调用、记忆、规划拼成完整 Agent 时，模型每一步的决策都要靠这个模块从自由文本变成能进 if/else 的数据——结构化输出是 Agent 工程的地基，不是可选优化。
