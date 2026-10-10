# 第 10 周 · Day 1：FastAPI 起步——路由、路径参数、查询参数，注解即文档

> 对应手册任务：学习「FastAPI 基础：路由、路径参数、查询参数」，动手创建 `/health` 和 `/users/{id}` 两个端点，当日产出「可运行的 FastAPI」。本篇只解决一个问题：你在 NestJS 里要靠装饰器、管道、swagger 模块拼出来的三件事——路由、参数校验、接口文档——FastAPI 用函数签名上的类型注解一次搞定。今天从零把服务跑起来，顺便把两套框架的账算清楚。

## 今日目标

1. 说得清 FastAPI 在技术栈里的位置：Starlette 管 HTTP、Pydantic 管数据、类型注解串起一切，以及它和 NestJS 在装配上的本质差别
2. 掌握三个语法点：装饰器路由、路径参数的类型校验（错类型自动 422）、查询参数的默认值写法
3. 独立跑起 `uvicorn --reload` 服务，写好 `/health` 和 `/users/{user_id}`，并亲眼见到一次 422 和一次 404

## 概念讲解：为什么是 FastAPI

第 9 周写的是裸 Python：脚本进去，stdout 出来。要让 Agent 被别的程序调用，得给它一个 HTTP 门面，这就是本周的 agent-service。选框架前先看手里有什么。

你在 NestJS 里已经见过一套完整答案：Express 在底下跑 HTTP，装饰器声明路由，DTO 加 class-validator 校验请求，@nestjs/swagger 生成文档，DI 容器把这一切装配起来。代价是概念多：Module、Provider、Pipe 各司其职，少一个环节都不转。

FastAPI 的思路是换一条起跑线。它自己不造 HTTP，跑在 Starlette 上，位置对照 Express；数据校验交给 Pydantic，位置对照 class-validator；而路由、校验、文档三件事的粘合剂，是 Python 的类型注解。

关键差别就在这条粘合剂上。TypeScript 的类型编译后就被擦掉，所以 NestJS 校验参数得显式加管道：`@Param('id', ParseIntPipe) id: number`，类型归类型，校验归校验。Python 的注解在运行时还挂在函数签名上，FastAPI 启动时读一遍签名，参数怎么解析、类型对不对、文档长什么样就全有了。你写下的 `user_id: int`，既是给 IDE 看的类型，也是运行时的校验规则，还是 OpenAPI 文档里的一行。一份注解干三份活。

装配上的对照更干脆：

| 职责 | NestJS | FastAPI |
| --- | --- | --- |
| HTTP 底座 | Express | Starlette |
| 路由声明 | `@Controller` + `@Get` | `@app.get("/users")` |
| 参数校验 | Pipe + class-validator | 函数签名的类型注解 |
| 接口文档 | @nestjs/swagger 手工装饰 | 内置 `/docs` 自动生成 |
| 装配方式 | Module + DI 容器 | 没有，app 实例就是全部 |
| 开发热重载 | `nest start --watch` | `uvicorn --reload` |

一眼能看出来：装饰器路由是两边的共同思想，但 FastAPI 没有 Module、没有 providers 数组、没有 IoC 容器。一个 `FastAPI()` 实例加一串装饰器，服务就是它。这不是偷工减料，轻量装配的代价和补救本周后段会遇到，今天先享受它的快。

## 核心知识

本节的代码块都是独立示例，可以先看不抄，最终完整文件以下面的动手任务为准。

### 1. 最小应用与 uvicorn

```python
from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {"status": "ok"}
```

五行，逐行都有讲究。`FastAPI()` 创建应用实例，它就是 NestJS 里 `NestFactory.create(AppModule)` 加上整个 Module 体系的替代品。`@app.get("/health")` 把函数挂到「GET /health」上，和 `@Controller` 里的 `@Get('health')` 是同一个思想：HTTP 语义写在装饰器里，函数体只留业务。返回值是 dict，FastAPI 自动序列化成 JSON 并设好 `Content-Type`，不用碰 Response 对象。

代码本身不监听端口，跑起来要服务器，这就是 uvicorn 的位置，对照 Express 之于 Nest：

```bash
uvicorn app.main:app --reload
```

`app.main:app` 是一个导入路径：app 包里 main 模块的 app 变量。`--reload` 监听文件变化自动重启，对照 `nest start --watch`。带上它，接下来改代码就不用手动 Ctrl+C 了。

### 2. 路径参数：一个注解三份活

```python
@app.get("/users/{user_id}")
def get_user(user_id: int):
    return {"user_id": user_id, "type": type(user_id).__name__}
```

关键在 `user_id: int` 这五个字符。FastAPI 读到路径模板里的 `{user_id}`，再读函数签名，发现它被注解成 int，于是在每次请求进来时做三件事：从 URL 取出这一段、转成 int、转不成就直接回 422。用 `/users/abc` 试一下，返回的 JSON 会明确告诉你哪个参数、错在哪：

```json
{
  "detail": [
    {
      "type": "int_parsing",
      "loc": ["path", "user_id"],
      "msg": "Input should be a valid integer, unable to parse string as an integer"
    }
  ]
}
```

对照 NestJS：同样的事要写 `@Param('id', ParseIntPipe) id: number`，而且 Nest 的管道默认报 400，FastAPI 的校验报 422（Unprocessable Entity，请求格式解析失败）。写联调代码时别把这个差别当成 bug。

参数找得到但资源不存在，是另一种错，归 404 管：

```python
from fastapi import HTTPException

raise HTTPException(status_code=404, detail="user not found")
```

注意是 `raise` 不是 `return`。HTTPException 抛出去由框架接住，翻译成 404 响应，函数后面的代码不再执行。

### 3. 查询参数：默认值即可选

不在路径模板里的参数，只要出现在函数签名上，FastAPI 就按查询参数处理：

```python
@app.get("/users")
def list_users(skip: int = 0, limit: int = 10):
    return USERS[skip : skip + limit]
```

请求 `/users?skip=10&limit=5` 时，skip 是 10、limit 是 5；请求 `/users` 时两者取默认值。判定规则一句话：有默认值就是可选参数，没默认值就是必填参数，缺了直接 422。NestJS 里这活是 `@Query('skip') skip?: number` 再补默认值，FastAPI 把取值、类型转换、默认值三步折叠进一行签名。

### 4. 免费的文档：/docs 与 /redoc

服务跑起来后开浏览器访问 `http://127.0.0.1:8000/docs`，Swagger UI 就在那里，每个端点的参数、类型、默认值都列好了，还能直接填参数发请求。`/redoc` 是同一份数据的另一种排版，适合阅读，不适合调试。

这不是插件，是内置行为。FastAPI 启动时把所有路由的签名信息汇总成 OpenAPI 规范（一份 JSON，在 `/openapi.json`），两个文档页面只是这份数据的两种渲染。NestJS 想要同样的东西要装 @nestjs/swagger 并给每个 DTO 补装饰器；FastAPI 里你写的每个类型注解都自动流进文档，签名就是文档的源头。

## 动手任务：两个端点一步一步

手册任务：创建 `/health` 和 `/users/{id}`。拆成 5 步，全程约 20 分钟，做完得到的服务是本周所有代码的地基。

**第 1 步：建项目加依赖。** 在 agent-service 项目根目录执行：

```bash
poetry add fastapi "uvicorn[standard]"
```

命令会把下面两行写进 `pyproject.toml`（版本以安装时最新为准）：

```toml
fastapi = "^0.115"
uvicorn = { extras = ["standard"], version = "^0.32" }
```

`standard` 附带的是一批增强组件，比如 watchfiles 驱动的热重载和更快的 HTTP 解析。对照记忆：这一步等于给 NestJS 项目装 `@nestjs/common` 加服务器的那一小撮依赖，只是清单短得多。

**第 2 步：建目录和最小应用。** 项目根目录新建 `app` 包，里面放 `main.py`，先只写核心知识第 1 节那五行。然后启动：

```bash
poetry run uvicorn app.main:app --reload
```

看到 `Uvicorn running on http://127.0.0.1:8000` 后，另开一个终端 curl 一下 `/health`，应当返回 `{"status": "ok"}`。第一个端点完成。注意命令在项目根目录执行，`app` 是个包，换目录跑会报 `ModuleNotFoundError`。

**第 3 步：内存数据加用户列表。** 数据先用模块级列表顶着，第 4 天换数据库。在 `main.py` 顶部补：

```python
users_db: list[dict] = [
    {"id": 1, "name": "Jerry", "email": "jerry@example.com"},
    {"id": 2, "name": "Tom", "email": "tom@example.com"},
    {"id": 3, "name": "Ann", "email": "ann@example.com"},
]

@app.get("/users")
def list_users(skip: int = 0, limit: int = 10):
    return users_db[skip : skip + limit]
```

保存后 `--reload` 会自动重启。用 `curl "http://127.0.0.1:8000/users?skip=1&limit=1"` 验证，应只返回 Tom。引号别丢，Windows 终端里裸写的 `&` 会被当成特殊符号。

**第 4 步：写 /users/{user_id}，处理 404。** 文件顶部的 import 改成 `from fastapi import FastAPI, HTTPException`，然后加：

```python
@app.get("/users/{user_id}")
def get_user(user_id: int):
    for user in users_db:
        if user["id"] == user_id:
            return user
    raise HTTPException(status_code=404, detail="user not found")
```

找到就返回，找不到就抛 404。循环正常走完说明「查过了但没有」，正好落在 raise 上，两条路径都覆盖到了。

**第 5 步：把三种响应各看一眼。** 依次请求：

```bash
curl -i http://127.0.0.1:8000/users/1        # 200，Jerry
curl -i http://127.0.0.1:8000/users/99       # 404，user not found
curl -i http://127.0.0.1:8000/users/abc      # 422，int_parsing
```

`-i` 会打印状态行，三连对比下来 200、404、422 的边界就长在直觉里了。最后开 `http://127.0.0.1:8000/docs`，两个端点都列在那里，参数表、默认值、可试发请求一应俱全。你今天写的每个注解都在替你值班。

::: tip 端口与重启
8000 被占用时加 `--port 8001`。`--reload` 只监听文件变化，装新依赖或改环境变量后要手动重启一次。
:::

## 常见踩坑

**坑 1：装了 fastapi 没装 uvicorn。** `poetry add fastapi` 只装框架本体，不带服务器，直接跑会看到「uvicorn 不是内部或外部命令」。网上教程里的 `fastapi dev` 也来自 `fastapi[standard]` 这个附加安装项，裸装的 fastapi 同样没有。老实用 `poetry run uvicorn app.main:app` 这条完整命令最稳。

**坑 2：路径参数忘写注解。** `def get_user(user_id):` 少了 `: int`，FastAPI 不会报错，user_id 会以 str 进来。于是 `user["id"] == user_id` 拿 int 比 str，永远 False，所有请求都 404。这种错不抛异常，只在行为上「全员查无此人」，光看代码很难发现。路径参数和查询参数都要注解，让校验器替你把关。

**坑 3：HTTPException 写成 return。** `return HTTPException(status_code=404, ...)` 不报错也不生效：FastAPI 把返回值当成响应数据去序列化，客户端收到 200 加一堆奇怪的字段。中断请求必须 raise，让框架接住它走错误处理链路。

**坑 4：固定路径写在动态路径后面。** 哪天加 `/users/me`（当前登录用户），把它写在 `@app.get("/users/{user_id}")` 之后，请求 `/users/me` 会先命中 `{user_id}` 模板，然后死在 422 上，me 转不成 int。FastAPI 按定义顺序匹配路由，固定路径永远放前面。

**坑 5：把 422 当成服务坏了。** 联调时前端报「全是 422」，先去 `/docs` 核对参数的类型和必填标记。422 的意思是「你的请求格式我不认识」，不是服务挂了。另外从 NestJS 带过来的记忆是 400，两边默认码不同，别用旧经验排查新服务。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Starlette、Pydantic、FastAPI 各负责什么？对照 NestJS 的技术栈说一遍。

::: details 参考答案
Starlette 是 ASGI Web 框架，管 HTTP 层，位置对照 Express；Pydantic 管数据校验与序列化，对照 class-validator；FastAPI 在两者之上提供装饰器路由、类型驱动的参数处理和自动文档，对照 NestJS 框架本体。
:::

2. `def get_user(user_id: int)` 里的 `: int` 让 FastAPI 做了哪几件事？

::: details 参考答案
三件：从 URL 对应段取出原始字符串；尝试转成 int；失败时短路请求返回 422，响应体里写明参数位置和原因。同时这个类型会流进 OpenAPI，/docs 里 user_id 显示为 integer。
:::

3. 路径参数和查询参数在代码上怎么区分？为什么不需要 @Param、@Query 这样的装饰器？

::: details 参考答案
看参数名是否出现在路径模板里：出现在 `{}` 中的是路径参数，其余带注解的签名参数是查询参数。NestJS 需要装饰器是因为元数据得显式挂；FastAPI 直接读函数签名，路径模板和签名合起来已经包含全部信息，装饰器就省了。
:::

4. 什么情况 404，什么情况 422？和 NestJS 的默认行为差在哪？

::: details 参考答案
422 是参数层失败：类型转不过、必填缺失，请求根本没进业务逻辑；404 是业务层结论：参数合法但资源不存在，要自己 raise HTTPException。NestJS 的 ParseIntPipe 默认抛 400，FastAPI 统一用 422，写客户端错误处理时要分别覆盖。
:::

5. 为什么必须有 uvicorn，fastapi 库自己不能启动服务吗？

::: details 参考答案
FastAPI 只是一个 ASGI 应用，本质是等着被调用的对象；监听端口、收发 TCP、把 HTTP 请求翻译成 ASGI 事件是服务器的工作，uvicorn 就是这个服务器。对照 NestJS：NestFactory 造出 app 后，也是 Express 或 Fastify 在底层监听，只是 `nest start` 把这一步包掉了。
:::

## 延伸阅读

- [FastAPI 官方教程：First Steps](https://fastapi.tiangolo.com/tutorial/first-steps/)，今天最小应用和 uvicorn 命令的原始出处，十分钟通读
- [FastAPI 官方教程：Path Parameters](https://fastapi.tiangolo.com/tutorial/path-params/)，路径参数与类型校验的完整细节，包括枚举和 float 的情况
- [FastAPI 官方教程：Query Parameters](https://fastapi.tiangolo.com/tutorial/query-params/)，查询参数的必填、可选与别名，明天写请求体之前值得扫一遍

今天的 `main.py` 留好。Day 2 在同一份 `users_db` 上加 `POST /users`，用 Pydantic 把请求体校验也纳入「注解即文档」的体系，你会看到这个思想从 URL 一路铺到 JSON body。
