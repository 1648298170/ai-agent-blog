# 第 10 周 · Day 5：SSE 流式响应——让回复一个字一个字出来

> 对应手册任务：学习「SSE 流式响应：StreamingResponse」，动手写一个 `/chat/stream` 端点，逐字返回一段文本，当日产出「流式端点」。本篇只解决一个问题：LLM 生成得慢，普通 JSON 接口非要等全部生成完才返回，用户干等 10 秒；改成流式后 300 毫秒出第一个字，总耗时一模一样，体验却是两种产品。

## 今日目标

1. 说得清为什么 Agent 对话接口必须流式，以及轮询、SSE、WebSocket 三种方案各适合什么场景
2. 掌握三个技术点：SSE 报文格式（`data:` 行加空行收尾）、`StreamingResponse` 配异步生成器、用 `request.is_disconnected` 检测客户端断开
3. 独立完成 `/chat/stream` 端点，用 `curl -N` 亲眼看到文本一个字一个字到达

## 概念讲解：为什么必须流式

先接受一个物理事实：LLM 是一个 token 一个 token 生成的，主流模型的速度也就是每秒几十个 token。用户问一句「帮我总结这段代码」，模型输出 500 个 token，就是 10 秒上下。这 10 秒你优化不掉，模型就这个速度。

能优化的是「用户从什么时候开始看到内容」。本周前四天写的都是普通接口：等 service 层算完，一次性返回 JSON。套到对话场景就是：用户提问，页面转圈 10 秒，然后一大段文字砸出来。用户的心理活动通常是「它是不是挂了」。

流式的做法是：模型每生成一个 token，服务器立刻发给前端。300 毫秒后第一个字出现在屏幕上，后面像有人打字一样持续往外蹦。算一笔账：总耗时还是 10 秒，但「干等 10 秒」和「0.3 秒开始读，边出边读」是两种完全不同的体感。你看在线视频从来不会先把整部电影下载完再播放，一个道理。

这件事也没有任何黑科技：还是一次普通的 HTTP 请求，只是服务器不攒着，来一点发一点，连接一直开着。「服务器单向持续推送」这个约定，就是 SSE（Server-Sent Events）。第 11 周接真 LLM API 的时候你会发现，模型 SDK 本身就提供流式接口，今天搭好的管道到那天一个字都不用改。

## 核心知识

本节的代码块都是独立可跑的片段，最终完整文件以下面的动手任务为准。

### 1. SSE 报文长什么样

SSE 不换协议，就是一条普通的 HTTP 响应，只有两个约定。第一，响应头 `Content-Type: text/event-stream`；第二，正文按「事件」组织，每个事件由一行或多行 `data: 内容` 组成，最后用一个空行（字节上是 `\n\n`）收尾。

端点逐字返回「你好」时，线上真正跑的字节长这样：

```text
data: 你

data: 好

```

就这么多。`data: 你` 只是半条消息，后面的空行才表示「这个事件完了，可以交给前端」。浏览器端的 `EventSource` 原生支持这套格式：收到一个完整事件触发一次 `onmessage`，连接断了还会自动重连，一行都不用你写。消费代码长这样，明天 Day 6 展开：

```js
const es = new EventSource("/chat/stream");
es.onmessage = (e) => console.log(e.data); // e.data 就是 data: 后面的内容
```

### 2. 三种方案对比：为什么聊天选 SSE

「服务器把数据推给浏览器」不止一种做法，先把选择题做对：

| 方案 | 方向 | 连接方式 | 聊天场景结论 |
| --- | --- | --- | --- |
| 轮询 | 客户端反复拉 | 每隔几秒发一次新请求 | 延迟等于轮询间隔，九成请求白打，不行 |
| SSE | 服务端单向推 | 一条普通 HTTP 长连接 | 够用：问一句、听一段 |
| WebSocket | 双向 | HTTP 升级出的独立协议 | 语音、协同编辑才需要 |

判断标准就一条：客户端需不需要「持续主动说话」。文字聊天的形状是「用户发一句（普通请求就够），然后听模型说一大段」，接收侧是单向的，SSE 正好匹配。等做语音对话时，客户端要实时上传音频流，服务端同时下发音频流，那才轮到 WebSocket。

SSE 还有个工程上的隐藏优势：它就是 HTTP。Nginx、网关、负载均衡都天然认识它，认证、限流这些 HTTP 中间件照用。WebSocket 的升级握手在这些环节里要多操不少心。

### 3. StreamingResponse + 异步生成器

FastAPI 里做流式只有两个角色：异步生成器负责产出数据，`StreamingResponse` 负责来一段发一段。

```python
import asyncio

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

async def fake_reply(text: str):
    for ch in text:
        yield f"data: {ch}\n\n"  # 一个字一条事件，\n\n 别丢
        await asyncio.sleep(0.05)  # 模拟模型生成一个 token 的耗时

@app.get("/chat/stream")
async def chat_stream():
    return StreamingResponse(
        fake_reply("你好，我是一个正在学流式输出的 Agent。"),
        media_type="text/event-stream",
    )
```

关键在 `fake_reply` 里的 `yield`：函数体内出现 `yield`，它就不是普通函数而是生成器；`async def` 加 `yield`，就是异步生成器。调用 `fake_reply(...)` 不会执行任何代码，只是拿到一个迭代器，`StreamingResponse` 每次找它要下一段，它就从上次的暂停点跑到下一个 `yield`，产出的内容立刻写给客户端，一点不攒。

`await asyncio.sleep(0.05)` 在这里演的是「模型生成一个 token 要 50 毫秒」。它和 `time.sleep` 的区别见常见踩坑第 2 条，先记结论：异步代码里只能 `await asyncio.sleep`。第 11 周把这行换成「从模型流里取下一个 token」，这个端点就接上了真模型。

中文也不用担心乱码：Starlette 对 `text/*` 类型的 `media_type` 会自动补上 `charset=utf-8`。

### 4. 客户端断开检测：停生成就是省钱

流式连接动辄开十几秒，中途用户关页面、点「停止生成」太正常了。麻烦在于：客户端断了，服务器默认不知道，生成器还在傻乎乎地跑。普通接口无所谓，LLM 场景这是按 token 计费的真金白银，用户已经关了页面你还在生成剩下的 400 个 token，钱全白烧。

FastAPI 的解法是注入 `Request`，在循环里主动问一句「客户端还在吗」：

```python
from fastapi import Request

@app.get("/chat/stream")
async def chat_stream(request: Request):
    async def event_stream():
        for ch in "你好，我是一个正在学流式输出的 Agent。":
            if await request.is_disconnected():
                break  # 客户端没了，立刻停，一个字都别多生成
            yield f"data: {ch}\n\n"
            await asyncio.sleep(0.05)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
```

关键一行是 `if await request.is_disconnected(): break`：检查放在循环里，每发一个字问一次。它只是读一下连接状态，开销可以忽略。真实场景里这个 `break` 保护的是整条生成链路：还没发起的模型调用直接不发起，正在跑的尽快退出。

### 5. 两个必须设置的响应头

流式响应有两个头不设，就等着出诡异问题：

```python
headers = {
    "Cache-Control": "no-cache",   # 谁都别缓存这份动态流
    "X-Accel-Buffering": "no",     # 专门说给 Nginx 听：别攒，来一段转一段
}
```

`Cache-Control: no-cache` 好理解：每次对话内容都不一样，浏览器或代理缓存它没有意义，只有脏数据风险。

`X-Accel-Buffering: no` 是重点坑。第 8 周上线时你的 Nginx 用的是默认配置，其中 `proxy_buffering` 默认开启：Nginx 认为上游响应应该攒够一大块再发给客户端。对普通 JSON 接口这是优化，对 SSE 是灾难，它会把逐字输出攒成一坨一坨。典型症状：本地 `curl -N` 一个字一个字地出，部署到线上变成每隔几秒刷出一大段。代码翻烂了也没问题，是 Nginx 在中间攒流。这个响应头是 Nginx 认识的开关，按端点关闭缓冲，比在配置里全局写 `proxy_buffering off` 更精准。

## 动手任务：`/chat/stream` 一步一步

手册任务：写一个 `/chat/stream` 端点，逐字返回一段文本。拆成 5 步，全程约 20 分钟。接着本周的 FastAPI 项目写，前四天的环境直接能用。

**第 1 步：建文件，先确认服务活着。** 在本周练习目录新建 `main.py`：

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
async def health():
    return {"status": "ok"}
```

老一套启动：`uvicorn main:app --reload`，浏览器开 `http://127.0.0.1:8000/health` 确认活着。--reload 开着，后面每步改完直接测，不用重启。

**第 2 步：写伪模型生成器。** 今天没有真模型，用一个异步生成器演它：逐字产出，每个字假装思考 50 毫秒。

```python
import asyncio

from fastapi import Request

REPLY = "你好，我是一个 Agent。流式让我看起来思考得很快，其实我只是不攒着说话。"

async def fake_reply(text: str, request: Request):
    for ch in text:
        if await request.is_disconnected():
            break  # 客户端断开，立刻停
        yield f"data: {ch}\n\n"  # 一个字一条事件
        await asyncio.sleep(0.05)  # 假装生成一个 token 要 50ms
```

关键在 yield 出去的字符串：`f"data: {ch}\n\n"`，SSE 格式和断开检测都已经写在这几行里了。将来换真模型，改的只是「下一个字从哪来」。

**第 3 步：挂端点。** 加上路由和两个响应头：

```python
from fastapi.responses import StreamingResponse

@app.get("/chat/stream")
async def chat_stream(request: Request):
    return StreamingResponse(
        fake_reply(REPLY, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
```

**第 4 步：拼完整文件自查。** 三步加起来应该一字不差是这个样子：

```python
import asyncio

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

app = FastAPI()

REPLY = "你好，我是一个 Agent。流式让我看起来思考得很快，其实我只是不攒着说话。"


async def fake_reply(text: str, request: Request):
    for ch in text:
        if await request.is_disconnected():
            break  # 客户端断开，立刻停
        yield f"data: {ch}\n\n"  # 一个字一条事件
        await asyncio.sleep(0.05)  # 假装生成一个 token 要 50ms


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/chat/stream")
async def chat_stream(request: Request):
    return StreamingResponse(
        fake_reply(REPLY, request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",   # 谁都别缓存这份动态流
            "X-Accel-Buffering": "no",     # 告诉 Nginx 别攒流
        },
    )
```

逐行核对，尤其是 `\n\n` 那两处和响应头那两行。

**第 5 步：curl -N 验证。**

```bash
curl -N http://127.0.0.1:8000/chat/stream
```

`-N` 即 `--no-buffer`，让 curl 自己也别攒，来一段显示一段。你应该看到文字一个字一个字往外蹦，大概每 50 毫秒一个，而不是刷地一下全出来。想亲眼看断开检测生效，在 `break` 上面临时加一行 `print("客户端断开，停止生成")`，把 curl 起起来后立刻 Ctrl+C 掐掉，服务端终端里就会打出这行。

::: tip 验证清单
两样都过才算完成：`curl -N` 看到逐字到达；`curl -i -N http://127.0.0.1:8000/chat/stream` 里能看到 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`X-Accel-Buffering: no` 三个响应头。
:::

## 常见踩坑

**坑 1：忘了 `\n\n`，EventSource 一条都收不到。** `data: 你` 只是半条消息，空行才是事件边界。漏了空行的报文，curl 里看得见内容（curl 不解析 SSE），浏览器里 `onmessage` 一次都不触发（EventSource 只认边界）。「curl 能看到、前端收不到」，基本就是这个病，对照第 1 节的报文格式查。

**坑 2：异步生成器里用 `time.sleep`。** `time.sleep(0.05)` 会把整个事件循环卡住 50 毫秒，这期间进程里所有请求都停摆，逐字输出变成逐字卡顿，并发一上来直接雪崩。异步代码里休眠只有一种正确写法：`await asyncio.sleep(...)`，它把控制权还给事件循环，别人该干嘛干嘛。同一个道理，将来往生成器里调同步阻塞的库，也得换异步版本或者丢进线程池。

**坑 3：`media_type` 写错或漏掉。** 写成 `text/plain`，浏览器 `EventSource` 因为类型不对直接报错；不写就走默认的 JSON 行为，前端同样接不上。正确的值就是 `text/event-stream`，charset 会由 Starlette 自动补上。

**坑 4：本地逐字，线上一坨一坨。** 代码没错，是第 8 周那套 Nginx 在攒流。默认 `proxy_buffering` 开着，上游的流式响应被攒成大块再转发。解法就是第 5 节的 `X-Accel-Buffering: no`，今天就把这行写进端点，上线那天少排查一个下午。

**坑 5：断开了还在生成。** `is_disconnected` 的检查写在循环外等于没写，它查的是「此刻」，而断开发生在中途。必须放在循环里，每次发数据前问一次。也别嫌它频繁：一次连接状态读取，比生成一个 token 便宜几个数量级。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. SSE 一个完整事件的格式是什么？只写 `data: 你好` 不写空行，会发生什么？

::: details 参考答案
一个事件等于「一行或多行 `data:` 开头的内容」加一个空行收尾（字节上是 `\n\n`）。不写空行，服务端视角数据发出去了，客户端视角这条事件永远没结束，`EventSource` 的 `onmessage` 一次都不触发；curl 不解析 SSE，照样能看到内容，这个反差是定位该问题的最快线索。
:::

2. 文字聊天为什么 SSE 就够？什么场景才必须上 WebSocket？

::: details 参考答案
判断标准是客户端需不需要持续主动发送。文字聊天是「用户发一句（普通 HTTP 请求就够）+ 听模型说一大段（服务端单向推）」，接收侧单向，SSE 匹配且更省事：普通 HTTP 连接，网关、认证、限流全部照用，EventSource 自带重连。客户端也要实时上传流的场景（语音对讲、协同编辑）才用 WebSocket。
:::

3. 异步生成器里写 `time.sleep(0.05)` 会发生什么？正确写法是什么？

::: details 参考答案
`time.sleep` 是同步阻塞，会挂起整个事件循环，这 50 毫秒里进程内所有并发请求全部停摆。正确写法是 `await asyncio.sleep(0.05)`，它让出控制权，事件循环继续处理别的请求。
:::

4. `X-Accel-Buffering: no` 是给谁看的？解决什么症状？

::: details 参考答案
给 Nginx 看。Nginx 默认开启 `proxy_buffering`，会把上游响应攒成大块再发给客户端，对普通 JSON 是优化，对 SSE 会把逐字输出攒成一坨一坨。这个响应头按端点关闭 Nginx 的缓冲。典型症状是「本地 curl 逐字到达、线上每隔几秒刷一大段」，第 8 周部署的默认配置就会踩。
:::

5. 怎么在生成过程中发现客户端已断开？发现后为什么必须立刻停？

::: details 参考答案
在生成循环里每轮 `await request.is_disconnected()`，返回 True 就 break。必须立刻停，是因为 LLM 按 token 计费，用户关掉页面后继续生成全是白烧钱，早点结束也释放连接资源。检查要放在循环里，因为断开发生在请求中途，开始时查一次是查不出来的。
:::

## 延伸阅读

- [FastAPI 官方文档：Custom Response 之 StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse)，本篇主角的一手说明，还给了文件流、迭代器的更多例子
- [MDN：Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)，SSE 报文格式与 EventSource 用法的权威说明
- [MDN：EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)，明天 Day 6 前端消费的主角，今天先混个脸熟

今天的 `/chat/stream` 留好。明天（[本周日程](/week10/) Day 6）在 Next.js 里用 `EventSource` 把它渲染成打字机效果；第 11 周把 `fake_reply` 换成真模型的流式接口，管道一字不改。
