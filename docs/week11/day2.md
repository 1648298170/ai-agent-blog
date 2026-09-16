# 第 11 周 · Day 2：流式响应与 Function Calling 底层协议——亲手拆开 Agent 的发动机

> 对应手册任务：学习「流式响应与 Function Calling 底层协议：chunk/delta/finish_reason、tools/tool_calls 完整调用链」，动手「手写流式输出 + 手动实现一次完整的 function calling 循环（不依赖任何框架封装）」，当日产出 `raw-fc-loop.py`。本篇只解决一个问题：把 Agent 赖以运转的两块底层协议亲手扒开看一遍——token 怎么一个个吐出来，工具怎么被声明、被调用、被回填。看完这两层，所有 Agent 框架在你眼里都不再是魔法。

## 今日目标

1. 说得清 `stream=True` 之后 chunk、delta、finish_reason 各是什么，能徒手拼出流式下的 tool_calls
2. 不靠任何框架，手动跑通一次完整的 function calling 闭环：定义 schema → 模型要工具 → 本地执行 → `role:tool` 回传 → 最终答案
3. 说得清为什么「Agent 框架管理的本质上就是这个循环的状态」，给第 12 周的 LangGraph 埋好伏笔

## 概念讲解：为什么要扒开协议

昨天（[Day 1](/week11/day1)）的多轮对话有个共同点：请求发出去，干等几秒，一整块答案砸回来。这个模式能跑，但有两个致命伤。

第一个伤在体验。模型生成 800 字要十几秒，非流式意味着用户全程盯着空白屏幕。真实产品清一色打字机效果，答案一个词一个词往外蹦——这不是前端动画模拟的，是 API 协议层原生支持的能力。

第二个伤在能力。纯对话的模型被锁在聊天框里，你说「查下北京天气」，它只能编一个。想让模型真正干活，得给它一条调用外部工具的通道，这就是 function calling。

这两件事，市面上的框架全都帮你封装好了：LangChain 的 Agent、各家 Chat 应用的插件系统，底层翻开就是今天这两个协议的组合循环。封装用起来爽，出了问题两眼一抹黑：流式工具调用分片没拼对、`role:tool` 消息漏了 id，你得到的只会是一句冷冰冰的 400。所以今天不碰任何框架，用最裸的 SDK 把协议亲自走一遍。走完这一遍，框架对你只剩祛魅两个字。

## 核心知识

本节代码基于 openai Python SDK（1.x 版本），DeepSeek、Qwen 等 OpenAI 兼容端点通用，可直接照抄。最终完整文件以下面的动手任务为准。

### 1. 流式协议：chunk、delta、finish_reason

非流式调用返回一个完整对象，正文在 `response.choices[0].message.content`，一次性到位。请求里加一个 `stream=True`，性质就变了：返回的不是对象，是迭代器。模型每生成一小段（几个字符到一个词），服务端就推一个 chunk 下来，直到结束。

扒开每个 chunk，它是这样的 JSON（SDK 已帮你解析成对象）：

```json
{"choices": [{"index": 0, "delta": {"content": "北"}, "finish_reason": null}]}
{"choices": [{"index": 0, "delta": {"content": "京"}, "finish_reason": null}]}
{"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
```

关键在 `delta`（增量）：`message.content` 是完整正文，`delta.content` 是本次新吐出来的那几个字。想做打字机效果，就把每个 `delta.content` 立刻 print 出去，别的什么都不用做。

`finish_reason` 全程是 null，只在最后一个 chunk 给值，三个最常见的取值：

- `stop`：正常说完，圆满收场
- `length`：撞上 max_tokens 被硬砍，正文残缺，不能当完整答案用
- `tool_calls`：模型不打算说话，它要调工具——正文为空，真正的货在 `delta.tool_calls` 里，而且是分片来的（下一节）

底层再补一句：这条流是 HTTP 长连接上的 SSE（Server-Sent Events），每条消息形如 `data: {...}`，一行一个事件。SDK 解析好了你才拿到 chunk 对象；想看裸协议，`curl -N` 一下就能看到原始字节流。

### 2. 最难啃的坑：流式下的 tool_calls 分片拼接

`delta.content` 是纯文本，`+=` 拼就完事。`delta.tool_calls` 完全是另一头怪兽。

先明确非流式时的样子：模型要调工具，响应里给一个完整的 `tool_calls` 数组，每项含 `id`、`function.name`、`function.arguments`。坑在 `arguments`——它的类型是 JSON **字符串**，不是对象。模型生成它和生成正文一样，一个 token 一个 token 吐。流式下，这一条 tool_call 会被切成 N 个分片陆续到达：第一个分片带 id 和 name，后面的分片只有 arguments 的一小截。

也就是说，`{"city": "北京"}` 这么点东西，可能分三片到：`{"ci`、`ty": "`、`北京"}`。在流结束前对它做 `json.loads`，必炸。

拼接代码，全篇最硬的一段，值得逐行读懂：

```python
tool_calls = []  # 最终拼成 [{"id": ..., "name": ..., "arguments": ...}]

for chunk in stream:
    if not chunk.choices:  # 部分端点最后一个 usage 块的 choices 是空的
        continue
    delta = chunk.choices[0].delta
    if delta.tool_calls:
        for tc in delta.tool_calls:
            # 按 index 给每个调用占坑位
            while len(tool_calls) <= tc.index:
                tool_calls.append({"id": "", "name": "", "arguments": ""})
            piece = tool_calls[tc.index]
            if tc.id:                       # id 一般只在第一个分片出现
                piece["id"] += tc.id
            if tc.function:
                if tc.function.name:        # name 同理
                    piece["name"] += tc.function.name
                if tc.function.arguments:   # 重头戏，一截截累积
                    piece["arguments"] += tc.function.arguments
```

三个关键：一，`index` 是分片的归位依据，模型一口气要两个工具时，两个调用的分片会交错到达，全靠 index 区分归属；二，id 和 name 通常只在该调用的第一个分片出现，但用 `+=` 而不是 `=`，兼容那些把 name 也拆开传的端点；三，`arguments` 必须等流结束、拿到完整字符串后再 `json.loads`。

### 3. Function Calling 完整闭环

工具调用不是一次请求，是一个环。画出闭环，五步：

```
① 你 ─── messages + tools(schema) ─────────▶ 模型
② 你 ◀── finish_reason="tool_calls" ──────── 模型   （不说话，只要工具）
          tool_calls=[{id, name, arguments}]
③ 你本地执行：json.loads(arguments)
              get_weather("北京")
④ 你 ─── messages += [assistant(含 tool_calls),
                      role:tool(tool_call_id, 执行结果)] ──▶ 模型
⑤ 你 ◀── 自然语言答案，finish_reason="stop" ── 模型
```

逐步拆。

**第①步，声明工具。** 用 JSON Schema 描述你有什么函数、参数长什么样：

```python
tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市的实时天气",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "城市名，如：北京"}
                },
                "required": ["city"],
            },
        },
    }
]
```

模型只看得见这份描述，看不见你的函数体。description 写得越准，模型选工具、填参数就越靠谱——它是模型判断「该不该调、怎么调」的唯一依据。

**第②③步，模型给意图，你来执行。** 注意一个颠覆认知的事实：模型从不执行任何工具。它做的只是生成一段结构化输出——「我想调 get_weather，参数是 {"city": "北京"}」。真正执行 `get_weather` 的是你，在你的机器上。所谓 function calling，模型只负责点菜，厨房在你家。这也是安全边界：模型碰不到你的文件和网络，除非你替它碰。

**第④步，结果回传。** 两条消息，缺一不可：先把模型那条带 tool_calls 的 assistant 消息原样追加进 messages（它是对话历史的一部分），再把执行结果包成 `{"role": "tool", "tool_call_id": id, "content": "..."}` 追加。tool_call_id 对不上，服务端直接 400。

**第⑤步，模型组织答案。** 它看到历史里多了工具的真实结果，用人话总结给你，finish_reason 是 stop。

再往深看一层：如果第⑤步模型读完工具结果，又发起新的 tool_calls 呢？回到第③步继续转。这个 while 循环可以套很多层——查完天气查穿衣建议、再查交通——这就是 Agent 的心脏。第 12 周要学的 LangGraph，管理的本质上就是这个循环的状态：当前第几轮、messages 长什么样、下一步走哪个分支。协议层亲手转过一遍之后，框架在你眼里就只剩下一层薄薄的皮。

国产兼容端点补一句：DeepSeek、Qwen、GLM 等的 OpenAI 兼容端点大多支持 FC，但支持程度参差——并行调用、strict 模式、流式加 FC 的组合各家表现不一，接入前拿今天写的 `raw-fc-loop.py` 跑一遍，就是最好的兼容性试金石。

## 动手任务：`raw-fc-loop.py` 一步一步

手册任务：手写流式输出 + 手动实现一次完整 function calling 循环。拆成 5 步，全程约 25 分钟。

**第 1 步：建文件、接端点。** 先 `pip install openai`（1.x 版本），在练习目录新建 `raw-fc-loop.py`，写入：

```python
import json
from openai import OpenAI

client = OpenAI(
    api_key="sk-你的key",
    base_url="https://api.deepseek.com",
    # Qwen 兼容端点换："https://dashscope.aliyuncs.com/compatible-mode/v1"
)
MODEL = "deepseek-chat"  # Qwen 换 "qwen-plus"
```

**第 2 步：本地函数 + schema。** 工具本体用假数据，重点在链路不在天气：

```python
def get_weather(city: str) -> str:
    """假工具：真实项目里这里会是 HTTP 请求或数据库查询"""
    fake_db = {"北京": "5°C，晴", "上海": "12°C，多云"}
    return fake_db.get(city, "22°C，晴")

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "查询指定城市的实时天气",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {"type": "string", "description": "城市名，如：北京"}
                },
                "required": ["city"],
            },
        },
    }
]
```

**第 3 步：写流式函数，内置分片拼接。** 一个函数同时处理两种情况——模型说话（content 增量）和模型要工具（tool_calls 分片）：

```python
def stream_round(messages):
    """流式调一轮：边到边打印正文，返回 (正文, 拼好的tool_calls, finish_reason)"""
    text, tool_calls, finish_reason = "", [], None
    stream = client.chat.completions.create(
        model=MODEL, messages=messages, tools=tools, stream=True,
    )
    for chunk in stream:
        if not chunk.choices:  # 部分端点最后的 usage 块 choices 为空
            continue
        choice = chunk.choices[0]
        if choice.delta.content:
            print(choice.delta.content, end="", flush=True)
            text += choice.delta.content
        if choice.delta.tool_calls:
            for tc in choice.delta.tool_calls:
                while len(tool_calls) <= tc.index:
                    tool_calls.append({"id": "", "name": "", "arguments": ""})
                if tc.id:
                    tool_calls[tc.index]["id"] += tc.id
                if tc.function:
                    if tc.function.name:
                        tool_calls[tc.index]["name"] += tc.function.name
                    if tc.function.arguments:
                        tool_calls[tc.index]["arguments"] += tc.function.arguments
        if choice.finish_reason:
            finish_reason = choice.finish_reason
    print()
    return text, tool_calls, finish_reason
```

写完先单独验证 content 路径，在文件末尾临时加两行：

```python
t, c, f = stream_round([{"role": "user", "content": "用一句话解释什么是流式输出"}])
print(f"[finish_reason] {f}")
```

跑一次，亲眼看打字机效果和最后打出来的 stop，然后删掉这两行，进第 4 步。

**第 4 步：主循环。** finish_reason 是唯一的方向盘：

```python
messages = [{"role": "user", "content": "北京今天几度？适合穿什么？"}]

while True:
    text, tool_calls, finish_reason = stream_round(messages)

    if finish_reason == "stop":
        break  # 模型说完了，闭环结束

    if finish_reason == "tool_calls":
        # 先把模型的“调用意图”原样写回历史，必须有这一步
        messages.append({
            "role": "assistant",
            "content": text or None,
            "tool_calls": [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["name"], "arguments": tc["arguments"]}}
                for tc in tool_calls
            ],
        })
        # 逐个执行，结果以 role:tool 回传
        for tc in tool_calls:
            args = json.loads(tc["arguments"])  # 到这里才是完整 JSON
            result = get_weather(**args) if tc["name"] == "get_weather" else "未知工具"
            print(f"[本地执行] {tc['name']}({args}) -> {result}")
            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": str(result),  # content 必须是字符串
            })
        continue  # 带着工具结果进入下一轮

    if finish_reason == "length":
        print("[!] 被 max_tokens 截断，答案不完整")
        break
```

**第 5 步：跑起来，读两轮日志。** 预期输出长这样（正文以你的模型为准）：

```
[本地执行] get_weather({'city': '北京'}) -> 5°C，晴
北京今天 5 度，晴，昼夜温差大，建议穿厚外套或薄羽绒。
```

注意屏幕上先出现一个空行再出日志：第一轮模型一言不发（content 为空），直接要工具，那个空行就是 `stream_round` 结尾的 `print()`。然后本地执行、回传，第二轮才流式吐出答案。

再把问题换成「北京和上海今天哪个更暖和？」跑一次。多数模型会一口气发起两个 tool_calls（并行调用），你会看到两条 `[本地执行]` 日志——两个调用的分片靠 index 各自归位，这就是拼接代码里那个 while 占位的意义。

::: tip 换端点只改两处
`base_url` 和 `MODEL`。DeepSeek、Qwen（dashscope 兼容模式）、GLM（bigmodel）都能跑通本文全部代码；个别端点在并行调用或流式 FC 上行为有差异，跑一遍第 5 步的并行实验一测便知。
:::

## 常见踩坑

**坑 1：在流里 json.loads(arguments)。** 分片没到齐就解析，JSONDecodeError 是必然的。流循环里只做拼接，所有解析动作等流结束再做。

**坑 2：忘记回填 assistant 消息。** 有人把 role:tool 直接跟在 user 后面，服务端找不到对应的 tool_call_id，直接 400。顺序必须是：user → assistant(带 tool_calls) → tool。对话历史是一条链，模型说过什么，历史里就得有什么。

**坑 3：把 length 当 stop 处理。** 截断恰好发生在 arguments 中间时，拼出来的是残缺 JSON，下一步 json.loads 必炸。线上代码要对 length 显式处理：加大 max_tokens 重试，或提示用户。今天的实验问题短，撞不上，但要知道雷埋在哪。

**坑 4：role:tool 的 content 不是字符串。** 工具结果常常是 dict，直接塞会报错。统一 `json.dumps(result, ensure_ascii=False)` 或 `str(result)`。模型只认字符串，结构它自己会从 JSON 文本里读。

**坑 5：换端点后行为飘。** 同一份代码，有的端点并行调用总拆成两轮、有的 stream 加 tools 组合直接不支持、有的对 schema 校验更苛刻。别迷信文档，拿 `raw-fc-loop.py` 当探针，五分钟测出真实行为。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `delta.content` 和 `message.content` 的区别是什么？finish_reason 在流式过程中是什么值？

::: details 参考答案
message.content 是非流式返回的完整正文；delta.content 是流式里单个 chunk 新增的文本片段。finish_reason 在流式过程中一直是 null，只在最后一个 chunk 给出，stop / length / tool_calls 分别表示正常结束、被截断、需要调工具。
:::

2. 为什么流式下的 tool_calls 必须自己拼接？index 在其中起什么作用？

::: details 参考答案
因为 arguments 是模型逐 token 生成的 JSON 字符串，流式下一条 tool_call 被切成 N 个分片到达，SDK 不帮你拼。index 标记每个分片属于第几个调用，并行调用时分片交错到达，全靠它归位。
:::

3. 一次完整的 function calling（单个工具），你一共发起几次 API 请求？messages 最终多出哪几条？

::: details 参考答案
两次。第一次带 tools 拿到 tool_calls；执行后带着追加的消息再请求一次，拿最终答案。多出两条：assistant（含 tool_calls，原样回填）和 tool（含 tool_call_id 与执行结果）。
:::

4. 模型真的「执行」了 get_weather 吗？

::: details 参考答案
没有。模型只生成了结构化的调用意图（函数名加参数 JSON 字符串），执行永远发生在你本地。function calling 里模型只负责点菜，厨房在你家——这也是安全边界：模型碰不到你的文件和网络，除非你替它碰。
:::

5. 这个循环和第 12 周要学的 Agent 框架是什么关系？

::: details 参考答案
Agent 框架管理的本质上就是这个循环的状态：第几轮了、messages 里有什么、工具结果要不要进记忆、什么时候终止。LangGraph 的节点和边，是把这个 while 循环显式化成了状态机。循环本身你已经会手写了，框架只是替你管状态和工程细节。
:::

## 延伸阅读

- [OpenAI Function Calling 指南](https://platform.openai.com/docs/guides/function-calling)，tools schema 与调用链的官方原始出处，值得通读一遍
- [OpenAI Streaming API 参考](https://platform.openai.com/docs/api-reference/streaming)，chunk 结构与 SSE 细节
- [DeepSeek Function Calling 文档](https://api-docs.deepseek.com/guides/function_calling)，本文代码的默认端点，可对照国产实现的差异

今天的产出 `raw-fc-loop.py` 留好。第 12 周把它拆成 LangGraph 的节点和边时，你会亲眼看到框架到底替你多管了什么。
