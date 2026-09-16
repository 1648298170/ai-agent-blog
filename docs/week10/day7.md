# 第 10 周 · Day 7：周复盘——两端压测 SSE，给双栈做一次对照

> 手册任务：周复盘 + 整理。用 curl 和浏览器分别测 SSE，写周记，当日产出：测试记录 + 周记。
> 本篇解决两个问题：一是流式接口怎么测才算测过（普通接口 curl 一次看 200 就完事，流式不行）；二是 NestJS 和 FastAPI 两套都摸过了，差异到底在哪，值得腾一天说清楚。

## 今日目标

1. 用 curl -N 看到 SSE 的原始 `data:` 帧，中途 Ctrl+C 验证服务端断开检测，留下测试记录
2. 脱稿填出 NestJS vs FastAPI 全维度对照表，填不出的格子回去重读
3. 按四段模板写 300 字周记，过 10 题自检

## 概念讲解：为什么流式接口必须两头测

复盘的方法论第 1 周讲透了，这里只复习一句：看懂不等于学会，检验标准是不看资料能不能重做（细节见[第 1 周 Day 7](/week01/)）。今天换一批输出形式，测试记录、对照表、周记，逼的东西一样。

新问题是：流式接口的验收为什么比普通接口麻烦。

普通 JSON 接口，正确性只有一个维度：内容对不对。status 200，字段齐，就算过。流式接口多了一个时间维度：字是不是一个一个到的？用户断开之后，服务端还在不在白干活？这两个问题，一次普通的 curl 答不上来。curl 默认缓冲输出，等响应完了才一次性倒给你，你看到"全部字都在"，却不知道它们是逐帧到的，还是最后一毫秒一起到的。

所以本周的测试方法论就一句话：**curl 看协议素颜，浏览器看用户视角，两头对上了才算通**。curl -N 不做任何解析，看到的是线路上流的原始帧，这是协议真相；浏览器面板看到的是解析好的消息，这是用户真相。两个视角之间隔着代理缓冲、CORS、前端解析三层，哪头不对，问题就锁在哪一侧。

| 观察点 | curl -N 视角 | 浏览器视角 |
| --- | --- | --- |
| 帧格式 | 原始 `data:` 行和空行，肉眼可见 | EventStream 面板里解析好的消息表 |
| 流式节奏 | 终端逐行蹦字 | Network 的 Time、Size 持续跳动，页面逐字渲染 |
| 断开行为 | 中途 Ctrl+C，看服务端日志停不停 | 点停止按钮，看请求变 canceled |

## 核心知识

### 1. curl -N：看 SSE 的素颜

测试对象就是 Day 5 的 `/chat/stream`，Day 6 已经确认它是 POST + JSON body + Authorization 头。命令：

```bash
curl -N -i -X POST http://localhost:8000/chat/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-token" \
  -d '{"message": "介绍一下 SSE"}'
```

两个参数是今天的重点：

- **-N（--no-buffer）**：关掉 curl 自己的输出缓冲。不加它，curl 攒一批再打印，你大概率看到所有字在最后一秒齐刷刷出现，流式与否根本无从判断。这是 SSE 测试的第一坑。
- **-i**：把响应头一并打出来。流式端点有三个头值得亲眼确认：`content-type: text/event-stream`（SSE 的身份证）、`cache-control: no-cache`（不许任何一层缓存）、`x-accel-buffering: no`（Day 5 设的，让 Nginx 类代理别缓冲，自检第 8 题会考为什么）。

正常的话，终端先吐响应头，然后一行一行地蹦：

```text
data: 你

data: 好

data: ，
```

注意每帧后面的空行。它不是排版，是 SSE 协议的消息边界（`\n\n`），Day 6 前端 `split("\n\n")` 分帧分的就是它。肉眼确认两件事：帧逐个出现，中间有明显间隔；每帧 `data:` 打头。

**断开检测验证**，这一步最容易被跳过，但它直接对应下周接真实 LLM 的钱包：用户点了停止，服务端要立刻停，不然 token 白烧。做法：

1. 确认 Day 5 端点的生成循环里有 per-token 的 print 或日志，没有就先补一行
2. 重跑 curl，等字吐到三分之一时按 Ctrl+C
3. 盯 uvicorn 控制台：日志应该在极短延迟后停住

原理说清楚，免得误判。客户端断开，服务端不是立刻知道的，而是**往管道里写下一次数据时才发现管道断了**，StreamingResponse 背后的生成器在这个瞬间被关闭。所以日志多吐一两个字再停，正常；但如果日志一路跑到结尾，说明生成逻辑没响应取消，这个端点接真实 LLM 就会烧冤枉钱，今天就得修。

结果记进当天的测试记录，格式给你：

```text
## SSE 测试记录 week10-day7
环境：uvicorn main:app --reload，端口 8000

[curl 基线]
响应头：text/event-stream ✓  no-cache ✓  x-accel-buffering: no ✓
帧格式：data: 开头 + 空行分隔 ✓
流式节奏：帧逐个出现，间隔约 ___ms

[断开检测]
操作：吐到第 __ 帧时 Ctrl+C
服务端表现：日志在 __ 帧内停止，结论：断开检测 ✓ / ✗（✗ 写明现象）

[浏览器]
EventStream：共 __ 条消息，与页面渲染一致 ✓
停止按钮：请求变 canceled，服务端日志同步停止 ✓
```

空格自己填，填的过程就是观察的过程。

### 2. 浏览器 EventStream 面板：看用户拿到的

不用写新代码，直接用 Day 6 的 Chat 页面。打开 DevTools → Network，发一句话，列表里会出现 `/chat/stream` 这条请求。点开它，标签栏里除了 Headers、Preview，还有一个 **EventStream**：Chrome 和 Edge 都有，Firefox 没有同名面板，今天建议用这哥俩。

面板显示的是浏览器替你解析好的 SSE 消息表，列为 Id、Type、Data、Time，一条消息一行。三个用法：

1. **数帧**。页面蹦了 50 个字，EventStream 里就该有 50 条消息。对不上，说明前端解析丢了帧，第一怀疑对象是 Day 6 讲过的"把 chunk 当消息"坑。
2. **看 Network 行的动态信号**。流式期间这条请求的 Time 持续计时、Size 持续增长，这是"真的在流"的直观证据。如果 Time 从 0.1s 猛跳到 8s、Size 一次性暴涨，说明中间某层在缓冲。
3. **验证停止**。流式中点页面的停止按钮（Day 6 的 AbortController），这条请求立刻变红色 canceled，同时回看 uvicorn 控制台，日志同步停住。它和 curl 的 Ctrl+C 是同一个断开检测的两种触发方式，两处都记。

压根找不到 EventStream 标签的话，先看响应的 content-type 是不是 `text/event-stream`，返回 `application/json` 时浏览器不给 SSE 面板。

### 3. NestJS vs FastAPI 全维度对照表（本周核心交付）

你现在的处境：第 3 到 5 周用 NestJS 写过完整后端，本周用 FastAPI 又写了一遍，两边的手感都是真的。这种时候最值钱的复盘就是对照。不是比谁好，是把"同一件事两家各怎么做"钉死，以后接哪个项目都不怵。

| 维度 | NestJS（第 3-5 周） | FastAPI（本周） |
| --- | --- | --- |
| 路由 | `@Controller('users')` + `@Get(':id')`，参数靠 `@Param` `@Query` `@Body` 装饰器逐个标 | APIRouter + `@router.get("/users/{user_id}")`，路径、查询参数直接写进函数签名，类型注解即声明 |
| 校验 | DTO class + class-validator 装饰器，还得挂全局 ValidationPipe；失败默认 400 | Pydantic 模型写进签名 `user: UserCreate` 即自动校验；失败统一 422，detail 自带 loc/msg/type |
| 依赖注入 | 容器式：@Module 的 providers 注册，构造函数注入，框架解析整棵依赖树 | 显式式：参数上写 `db=Depends(get_db)`，依赖链摊在签名里，没有全局容器 |
| 分层 | Module → Controller → Service → PrismaService，框架强制 | router → service → repository，目录约定，靠自觉 |
| 数据库 | Prisma：schema.prisma 声明模型，migrate 生成类型安全的 Client | SQLAlchemy 2.0：DeclarativeBase 声明模型，Engine/Session 管连接，Depends 注入、用完即还 |
| 文档 | 第 3 周没配；要配得加 @nestjs/swagger，DTO 再标一套 @ApiProperty | 内置 /docs 和 /redoc，Pydantic 模型 + response_model 自动生成，零配置 |
| 流式 | `@Sse()` 装饰器返回 Observable，或手写 res.write 并自己设头 | StreamingResponse 包 async 生成器，yield 一帧吐一帧，media_type 指定 text/event-stream |

::: warning 别对着表抄
先把右边两列遮住，凭记忆填空表，卡住了再翻本周教程和第 3-5 周的笔记确认，然后合上继续。照抄的表格没有复盘效果，识别和提取的区别，第 1 周说过了。
:::

填完之后，三处差异值得单独说，它们是"手感不同"的真正来源：

**第一，声明哲学不同。** NestJS 把元数据撒在装饰器上，一个参数一个装饰器；FastAPI 把一切压进函数签名，类型注解一鱼三吃：路由参数声明、请求校验、API 文档。写惯 Nest 的人初见 FastAPI 觉得"少了点什么"，少的那些仪式感，大部分确实可以少。

**第二，Pydantic 一个模型干三件事。** 校验、序列化、文档生成，class-validator、class-transformer、@nestjs/swagger 三个库的活，一个 BaseModel 全包。同一个 DTO 在 NestJS 里要装饰两三遍，在 FastAPI 里写一遍。这是本周开发体验明显更快的最大原因。

**第三，400 和 422。** 同样是请求校验失败，NestJS 的 ValidationPipe 默认打 400，FastAPI 固定打 422。双栈联调或写前端错误处理时别想当然，凭记忆写会错。

一句话总结给未来的自己：NestJS 用结构和容器换大项目的可预测性，FastAPI 用"签名即契约"换中小服务的速度。选型看团队和既有栈，本周之后你两条腿都有了。

### 4. 300 字周记模板 + 第 10 周示例

四段模板不变，第 1 周讲过理由，300 字是刻意的限制，逼你取舍：最大收获、卡得最久、还含糊、下周前补。第 10 周示例，照这个密度写：

```text
① 本周最大收获：Pydantic 把校验、序列化、文档压进一个模型，函数签名就是
接口契约，端点写完 /docs 里文档自己长出来。想起第 3 周配 class-validator
加 ValidationPipe 的工序，这边签名一写就完事。
② 卡得最久：页面一次性蹦出全文，后端 curl -N 明明逐帧。二分定位到前端把
chunk 当整条消息解析，补上 buffer 累积 + split("\n\n") + pop 留尾巴三件
套才好。
③ 还含糊：Depends+yield 的清理时机只知道"响应之后"，带后台任务时的顺序
没验证过；SQLAlchemy 的 Session 和连接池的关系只有模糊印象。
④ 下周前补：把 Day 5 端点改成吐 JSON 帧，前端只改解析那一行，为接裸
LLM API 做好格式准备。
```

### 5. 第 10 周知识自检清单

规则照旧：每题先口头回答，说完整了再点开对照。说不出来的记题号，回读对应 Day。

**问题 1：FastAPI 自动文档的默认地址是哪两个？数据从哪来？（Day 1）**

::: details 答案
`/docs`（Swagger UI，可交互调试）和 `/redoc`（ReDoc，阅读友好）。两个页面渲染的都是 `/openapi.json` 生成的 OpenAPI schema，源头是路由函数的签名、Pydantic 模型和 response_model。
:::

**问题 2：422 什么时候触发？业务报错也用它吗？（Day 2）**

::: details 答案
请求校验失败时框架自动返回 422：请求体不满足 Pydantic 模型、查询或路径参数类型转换失败都会触发，detail 是数组，每项带 loc（错在哪）、msg（为什么）、type（什么类别）。业务错误（比如邮箱已注册）不用 422，自己抛 HTTPException，状态码按语义选 400 或 409。
:::

**问题 3：response_model 有哪两个作用？（Day 2）**

::: details 答案
一是过滤输出：只有模型里声明的字段会被序列化返回，函数返回多余字段甚至直接返回 ORM 对象，都会被裁掉，密码这类字段天然漏不出去。二是声明响应结构：OpenAPI 文档里的响应 schema 由它生成，返回值也按它做校验和转换。
:::

**问题 4：入出参分离的三模型是哪三个？为什么不共用一个大模型？（Day 2）**

::: details 答案
UserCreate（创建入参，含密码）、UserUpdate（更新入参，字段全可选）、UserOut（出参，绝不含密码），公共字段抽 UserBase 用继承。不共用是因为入出参字段不对称：密码该进不该出，创建必填而更新可选。一个大模型要么漏密码要么挡字段，分开后各自只服务一个方向。
:::

**问题 5：Depends + yield 的依赖，三段代码分别在什么时候执行？（Day 4）**

::: details 答案
yield 之前：请求进来、路由需要这个依赖时，建资源（开 session）。yield 出去的值：注入路由函数用。yield 之后：响应发送完成后执行，释放资源（关 session），配 try/finally 保证异常时也释放。所以数据库 session 是一请求一生命周期，请求结束必然还回连接池。
:::

**问题 6：DeclarativeBase 是干什么的？（Day 4）**

::: details 答案
SQLAlchemy 2.0 的声明式基类。写法 `class Base(DeclarativeBase): pass`，所有 ORM 模型继承 Base，用 `__tablename__` 和 Mapped/mapped_column 声明字段，类和表的映射自动完成，Base 同时维护所有模型的注册表。它取代了 1.x 时代 `declarative_base()` 工厂函数的写法。
:::

**问题 7：SSE 的一帧长什么样？消息边界靠什么定？（Day 5）**

::: details 答案
数据行以 `data:` 打头，一条消息以空行（`\n\n`）结束，`data: 你\n\n` 就是最小的一帧，多行 data: 会被拼成一条消息。另有三种可选行：event:（自定义事件类型）、id:（消息编号，断线重连时浏览器带 Last-Event-ID 请求续传）、retry:（重连间隔毫秒数）。
:::

**问题 8：流式端点为什么设 X-Accel-Buffering: no？（Day 5）**

::: details 答案
这是 Nginx 约定的响应头，设 no 是告诉它及兼容代理：这个响应别缓冲，来一字节转发一字节。Nginx 默认开 proxy_buffering，会把上游的帧攒进缓冲区凑大了再发，用户端的"逐字"就变成"等半天一次性全出"。开发环境没 Nginx 时设它无害，上了反代它救命。
:::

**问题 9：EventSource 的两大局限是什么？（Day 6）**

::: details 答案
只能 GET：构造函数只收 URL，没法设 method，请求体没地方放，对话历史塞不进去。不能带自定义请求头：Authorization: Bearer 塞不进去，token 鉴权直接废。另有一个隐患：默认自动重连，但 POST 的上下文带不过去，服务端无从续发，对话场景宁可断了就断。
:::

**问题 10：AbortController 用在哪些场景？（Day 6）**

::: details 答案
流式对话的停止按钮：发起前 new 一个，signal 塞进 fetch 配置，abort() 后挂着的 reader.read() 立刻以 AbortError 拒绝，catch 里静默收尾。下周接真实 LLM 后按输出 token 计费，早停一秒省一秒的钱。另外请求挂进 useEffect 时，cleanup 里也要 abort，防 StrictMode 双跑和组件卸载后还在 set state。
:::

## 动手任务：完成本周复盘

按顺序六步，预计 75 到 100 分钟。

**第一步：curl 基线（15 分钟）。** 起后端，跑上面的 `curl -N -i`，确认三个响应头、帧逐个出现、每帧 `data:` 打头，开始记测试记录。

**第二步：断开检测（15 分钟）。** 端点循环补上 per-token 日志（Day 5 没写就补），吐到三分之一按 Ctrl+C，盯服务端控制台，按核心知识第 1 节的标准下结论并记录。

**第三步：浏览器 EventStream（15 分钟）。** Day 6 页面发消息，数帧、看 Time/Size 动态、点停止按钮看 canceled，两处结果都记下。

**第四步：脱稿填对照表（20 分钟）。** 把第 3 节表格右边两列遮住自己填。填不出的维度就是补课点，回读本周对应 Day 和第 3-5 周笔记。

**第五步：写周记（15 分钟）。** 四段模板，对照示例密度，第三段"还含糊"别糊弄。

**第六步：git 收口（10 分钟）。** 未提交内容按"一个提交一件事"分开提交，打 tag：

```bash
git add agent-service
git commit -m "feat(agent-service): SSE 端点与断开检测日志"
git tag week10-done
```

## 常见踩坑

**Windows 下 curl 直接跑不了。** PowerShell 里 curl 是 Invoke-WebRequest 的别名，先写全 curl.exe；JSON 体的引号还得转义：`-d "{\"message\": \"hi\"}"`。症状认准：报"无法将 -N 识别为 cmdlet"或 JSON 解析 422，多半是它。

**不加 -N，误判后端没流式。** curl 缓冲把帧攒一起输出，你看到的是假象。任何结论先加 -N 再下，这是本篇说烂的一句话，也是今天最容易犯的错。

**Ctrl+C 后日志没立刻停，就断言断开检测坏了。** 服务端是写下一帧时才发现断开的，多吐一两个字正常，多等两拍再判断。真的一路跑到结尾才是没响应取消，去查生成循环是不是把取消异常吞了。

**找不到 EventStream 标签。** 两种可能：浏览器没有这个面板（Firefox），或响应 content-type 不是 text/event-stream（比如错调了返回 JSON 的路由）。先看响应头，再换浏览器。

## 延伸阅读

- [curl 手册页](https://curl.se/docs/manpage.html)：-N/--no-buffer 的官方定义，顺带看看 -i、-v 还能帮你观察什么
- [FastAPI：Dependencies with yield](https://fastapi.tiangolo.com/tutorial/dependencies/dependencies-with-yield/)：yield 依赖的完整生命周期和数据库 session 的推荐写法
- [MDN：使用服务器发送事件](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events)：event:/id:/retry: 字段和断线重连的协议细节，第 7 题的扩展材料

测试记录和对照表存好。下周接裸 LLM API 时，端点只换上游、格式照旧，今天的记录就是回归测试的基准。第 10 周到此收口。
