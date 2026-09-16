# 第 10 周 · Day 3：FastAPI 分层架构——router、service、repository 各管一层

> 对应手册任务：学习「FastAPI 分层架构：router → service → repository」，动手把用户操作拆到 `services/user_service.py`，router 只做参数转发，当日产出「分层清晰」。本篇只解决一个问题：前两天所有代码都挤在 `main.py` 的路由函数里，参数解析、业务规则、数据存取搅成一团，接口一多就没法改。今天把这三件事拆成三层，每层只回答一个问题，并和第 3 周 NestJS 的分层一一对照，你会发现这套思想早就学过，缺的只是 Python 的写法。

## 今日目标

1. 说得清为什么要分三层，以及「一段代码该放哪层」的一句话判断标准
2. 掌握三个工程点：`APIRouter` 用 prefix 和 tags 组织路由、`include_router` 挂载、没有 DI 容器时 service 的两种写法怎么选
3. 独立把 Day 2 的用户接口拆成 router → service → repository 三层，router 文件明显瘦身，并写一个不起 HTTP 就能跑的业务测试

## 概念讲解：为什么要分层

先看 Day 2 结束时的 `main.py`（节选）：

```python
users_db: list[dict] = []
next_id = 1

@app.post("/users", status_code=201)
def create_user(payload: UserCreate):
    global next_id
    for u in users_db:
        if u["email"] == payload.email:
            raise HTTPException(status_code=400, detail="email already registered")
    user = {"id": next_id, "name": payload.name, "email": payload.email}
    next_id += 1
    users_db.append(user)
    return user
```

十几行，能跑，今天就是它最后的安稳日子。三个隐患埋在里面。

第一，存储和路由焊死了。数据放在 `users_db` 这个模块级列表里，读写直接写在路由函数体内。Day 4 要换 SQLAlchemy，意味着每个路由函数都得开膛破肚，而「换存储」本来只该动「存数据」的那几行。

第二，业务规则没法单独测。「email 不能重复注册」是一条业务规则，想验证它，你得把整个应用跑起来，用 curl 或 TestClient 发一次 POST。测一条 if 语句的成本是起一个 HTTP 服务，接口多了以后这笔账越来越亏。

第三，改动的理由混在一起。加一个查询参数，动的是 HTTP 语义；改重复注册的判定，动的是业务；换数据库，动的是存储。三种变更挤在同一个函数里，任何一次改动都要通读全部代码才敢下手。

分层的答案很朴素：让每种变更有自己的归宿。router 层只回答「HTTP 进出的语义」：路径、方法、状态码、参数长什么样、错误翻译成几。service 层只回答「业务规则是什么」：email 重复算什么错，注册要走哪几步。repository 层只回答「数据从哪来到哪去」：今天存内存数组，以后存数据库，外界无感。

这套思想你在第 3 周用 NestJS 写过一遍，名词对得上，机制有差异：

| 一句话职责 | NestJS（第 3 周） | FastAPI（今天） |
| --- | --- | --- |
| HTTP 语义：路径、参数、状态码 | `@Controller('users')` | `APIRouter(prefix="/users")` |
| 业务规则：校验、组合、异常 | `@Injectable()` 的 Service | `services/user_service.py` |
| 数据访问：存取、查询 | Repository 或 Service 里的 SQL | `repositories/user_repository.py` |
| 数据形状：请求与响应 | DTO + class-validator | Pydantic schema（Day 2 已学） |

最大的差异在「怎么把层连起来」。NestJS 有 IoC 容器，Controller 的构造函数里声明依赖，容器负责实例化和注入；FastAPI 没有容器，今天用最朴素的办法：Python 的模块本身就是一层，`import` 就是依赖声明。Day 4 再补上 `Depends`，装配这块就齐了。

## 核心知识

本节先看懂，动手任务才是完整文件。三个小节分别对应今天要新建的三层。

### 1. APIRouter：路由的「Controller」

Day 1 的路由直接挂在 `app` 上，`@app.get("/users")`。接口一多，`main.py` 会变成所有路径的堆场。FastAPI 的解法和 NestJS 的 `@Controller` 神似：把一组相关路由收进一个 `APIRouter`。

```python
# app/api/routers/users.py
from fastapi import APIRouter

router = APIRouter(prefix="/users", tags=["users"])

@router.get("")            # 实际路径 GET /users
def list_users():
    ...

@router.get("/{user_id}")  # 实际路径 GET /users/123
def get_user(user_id: int):
    ...
```

关键在 `prefix="/users"`：路径前缀只在 APIRouter 声明一次，下面每个装饰器写相对路径。两边都写 `/users` 会拼出 `/users/users`，不报错，只是路径对不上，打开 `/docs` 一眼就能看出来。`tags=["users"]` 只影响文档，Swagger 页面里按 tag 分组展示。

router 写好后回 `main.py` 挂载：

```python
# app/main.py
from fastapi import FastAPI

from app.api.routers import users

app = FastAPI(title="Agent API")
app.include_router(users.router)
```

关键一行是 `include_router`：`main.py` 从此只回答「有哪些 router」，不再认识任何具体接口。以后加聊天接口，就新建 `chats.py`，再 include 一次，`main.py` 只增两行。

### 2. 没有容器，模块就是分层

NestJS 里 service 是标了 `@Injectable()` 的类，由容器实例化再注入。FastAPI 没有容器，Python 给两种朴素写法。

风格 A，service 类加模块级实例：

```python
# app/services/user_service.py
class UserService:
    def register(self, payload: UserCreate) -> User:
        ...

user_service = UserService()  # 模块级实例，谁 import 谁用
```

```python
# router 里
from app.services.user_service import user_service

user_service.register(payload)
```

风格 B，模块级函数，连类都不要：

```python
# app/services/user_service.py
def register(payload: UserCreate) -> User:
    ...

def get(user_id: int) -> User:
    ...
```

```python
# router 里
from app.services import user_service

user_service.register(payload)
```

两种都是正经分层。怎么选看现状：现在的 service 没有状态、没有构造期依赖，风格 B 少一层仪式感，import 进来直接调，测试也直接调，简单可测优先，今天选 B。等 service 需要带状态（比如 Day 4 要持有数据库 session）时，风格 A 或者 `Depends` 注入再上场，两种写法 Day 4 都兼容。别急着抄模板搞 `BaseService` 抽象基类，需求没到，先让代码少绕弯。

### 3. repository：先跟内存数组过日子

repository 只说「数据」的语言：save、find_by_id、find_by_email。它不知道「注册」是什么，更不知道 HTTP 状态码长什么样。

```python
# app/repositories/user_repository.py
from typing import Optional

from app.schemas.user import User, UserCreate

_users: list[User] = []
_next_id: int = 1


def save(payload: UserCreate) -> User:
    """新增一条用户，id 由存储分配，对齐 Day 4 数据库的自增主键。"""
    global _next_id
    user = User(id=_next_id, name=payload.name, email=payload.email)
    _next_id += 1
    _users.append(user)
    return user


def find_all() -> list[User]:
    return list(_users)  # 拷贝列表，别把内部数组直接交出去


def find_by_id(user_id: int) -> Optional[User]:
    return next((u for u in _users if u.id == user_id), None)


def find_by_email(email: str) -> Optional[User]:
    return next((u for u in _users if u.email == email), None)


def clear() -> None:
    """测试专用：每个用例前清空，回到初始状态。"""
    global _next_id
    _users.clear()
    _next_id = 1
```

关键在返回类型 `Optional[User]`：找不到就是 None，「找不到算不算错」repository 不表态。算不算错是业务判断，归 service。这条边界划清了，Day 4 把这五个函数换成 SQLAlchemy 实现时，service 和 router 一行都不用动，分层的红利在那天兑现。

内存数组的局限也要先说透：数据在进程里，重启就没，多 worker 部署时各进程各一份。这是教学取舍，先让分层跑通，Day 4 就会被真数据库替换。

## 动手任务：三层拆分一步一步

手册任务：把用户操作拆到 `services/user_service.py`，router 只做参数转发。拆成 7 步，全程约 30 分钟。默认你已完成 Day 2，`UserCreate`、`User` 两个 schema 和 `/users` 的 POST 都是现成的。

**第 1 步：建目录。** 在项目根目录把骨架搭出来，每个空目录放一个 `__init__.py`：

```
app/
├── __init__.py
├── main.py                  # 只剩挂载
├── api/
│   ├── __init__.py
│   └── routers/
│       ├── __init__.py
│       └── users.py         # router 层
├── services/
│   ├── __init__.py
│   └── user_service.py      # service 层
├── repositories/
│   ├── __init__.py
│   └── user_repository.py   # repository 层
└── schemas/
    ├── __init__.py
    └── user.py              # 数据形状
```

Day 2 的单文件 `main.py` 先留着，第 6 步迁完再删，中途随时能跑旧的对照。

**第 2 步：schema 搬家。** 把 Day 2 写在 `main.py` 里的 Pydantic 模型原样移进 `schemas/user.py`：

```python
# app/schemas/user.py
from pydantic import BaseModel


class UserCreate(BaseModel):
    name: str
    email: str  # 字段校验是 Day 2 练过的活，这里保持最简


class User(UserCreate):
    id: int
```

关键在 `User` 继承 `UserCreate`：响应体是请求体加一个 id，继承着写，公共字段不用抄第二遍。

**第 3 步：写 repository。** 核心知识第 3 节的代码原样存成 `app/repositories/user_repository.py`，这里不重复。

**第 4 步：写 service，业务异常在这里定义。**

```python
# app/services/user_service.py
from app.repositories import user_repository
from app.schemas.user import User, UserCreate


class UserEmailExistsError(Exception):
    """email 已被注册。业务异常，与 HTTP 无关。"""

    def __init__(self, email: str):
        self.email = email
        super().__init__(f"email already registered: {email}")


class UserNotFoundError(Exception):
    """按 id 查不到用户。"""

    def __init__(self, user_id: int):
        self.user_id = user_id
        super().__init__(f"user not found: {user_id}")


def register(payload: UserCreate) -> User:
    if user_repository.find_by_email(payload.email) is not None:
        raise UserEmailExistsError(payload.email)
    return user_repository.save(payload)


def get(user_id: int) -> User:
    user = user_repository.find_by_id(user_id)
    if user is None:
        raise UserNotFoundError(user_id)
    return user


def list_all() -> list[User]:
    return user_repository.find_all()
```

关键在两处。一是整个文件没有一行 `from fastapi import ...`，service 不知道自己会被 HTTP 调用，明天被命令行脚本调用也照样工作。二是业务错误用自定义异常表达：`UserEmailExistsError` 说的是「email 已被注册」这个领域事实，至于它该翻译成 400 还是 409，是 router 的决定。service 抛什么、router 译成什么，这条契约就是两层之间的接口。

**第 5 步：router 瘦身。**

```python
# app/api/routers/users.py
from fastapi import APIRouter, HTTPException, status

from app.schemas.user import User, UserCreate
from app.services import user_service
from app.services.user_service import UserEmailExistsError, UserNotFoundError

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[User])
def list_users():
    return user_service.list_all()


@router.get("/{user_id}", response_model=User)
def get_user(user_id: int):
    try:
        return user_service.get(user_id)
    except UserNotFoundError:
        raise HTTPException(status_code=404, detail="user not found")


@router.post("", response_model=User, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate):
    try:
        return user_service.register(payload)
    except UserEmailExistsError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

对比拆分前，router 函数体只剩四类事：取参数、调 service、翻译异常、定状态码。查重循环没了，id 自增没了，字典拼装没了，它们都回到了自己的层。文件总行数没少多少，少的是这一层要操心的事：以后改业务找 service，换存储找 repository，router 文件从此基本冻结。

**第 6 步：挂载并验证。** `main.py` 换成核心知识第 1 节的挂载写法（`/health` 留着），在项目根目录启动：

```bash
uvicorn app.main:app --reload
```

三个请求验一遍，行为应与 Day 2 完全一致：

```bash
curl http://127.0.0.1:8000/users
curl -X POST http://127.0.0.1:8000/users -H "Content-Type: application/json" -d "{\"name\": \"Jerry\", \"email\": \"jerry@example.com\"}"
curl -X POST http://127.0.0.1:8000/users -H "Content-Type: application/json" -d "{\"name\": \"Tom\", \"email\": \"jerry@example.com\"}"
# 第三条期望 400：email already registered
```

**第 7 步：不起 HTTP，直接测 service。**

```python
# tests/test_user_service.py
import pytest

from app.repositories import user_repository
from app.schemas.user import UserCreate
from app.services import user_service
from app.services.user_service import UserEmailExistsError


def setup_function():
    user_repository.clear()  # 每个用例前回到初始状态


def test_register_assigns_id():
    user = user_service.register(UserCreate(name="Jerry", email="jerry@example.com"))
    assert user.id == 1
    assert user.name == "Jerry"


def test_register_rejects_duplicate_email():
    user_service.register(UserCreate(name="Jerry", email="jerry@example.com"))
    with pytest.raises(UserEmailExistsError):
        user_service.register(UserCreate(name="Tom", email="jerry@example.com"))
```

```bash
pip install pytest
pytest tests/ -q
```

关键在测试的对象：直接调 `user_service.register`，没有 TestClient，没有 uvicorn，没有端口。Day 2 想验证这条业务规则要发一次真 HTTP，现在一个函数调用就完事，毫秒级。HTTP 那层的翻译（异常变状态码）不用重复测，留一两个 TestClient 端到端用例兜底即可。接口越多，这笔账越划算。

::: tip 运行位置
uvicorn 和 pytest 都要在项目根目录执行，`app` 是一个包，从别的目录跑会报 `ModuleNotFoundError: No module named 'app'`。
:::

## 常见踩坑

**坑 1：service 里 import 了 HTTPException。** 手一滑就把 `raise HTTPException(400, ...)` 写进业务层。后果是 service 从此绑死在 HTTP 上：明天想给定时任务或命令行脚本复用注册逻辑，还得先给它们造一个 HTTP 语境。判据很简单：service 文件里出现 `from fastapi import` 就是越界，删掉，换成自定义异常。

**坑 2：router 里忍不住写业务。** 拆完总觉得「这点逻辑放 router 里顺手」。判断方法：把 router 函数体里除「取参数、调 service、翻译异常、定状态码」之外的代码拎出来，去掉 FastAPI 还成立的那部分，全该下沉。今天的查重逻辑就是样板：写在 router 里没法单独测，写在 service 里是一个直接可调用的函数。

**坑 3：分层方向反了。** 依赖只允许从上往下：router → service → repository → schema。哪天 repository 开始 import service，或者两个 service 互相 import，启动时就会见到 `ImportError: cannot import name ... (most likely due to a circular import)`。这不是 Python 的毛病，是职责切错了的信号：共用逻辑该下沉到被依赖的那一层，或者单独成模块。

**坑 4：把内存数组当生产存储。** `--workers 4` 起四个进程，就是四份互不相通的用户表；进程一重启，数据归零。今天它是过渡方案，价值在于把分层跑通，让 Day 4 的替换只动一个文件。另外 `find_all` 返回 `list(_users)` 拷贝的习惯值得保持：内部状态直接交出去，别人一个 `append` 就能绕过你定的所有规矩。

**坑 5：为分层而分层。** 三个接口的项目拆出七八个文件、每层一个 Base 抽象类、service 方法全是一行转发，这是仪式感过量。一层存在的标准是它有自己的变更理由：存储会从内存换数据库，repository 值得单独存在；业务会独立演化，service 值得；而「给未来可能的多数据库预留 BaseRepository」，需求没到，不写。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 一段代码该放 router 还是 service，你的判断标准是什么？

::: details 参考答案
把 FastAPI 从这段代码里拿掉，逻辑还成立的放 service（比如 email 查重）；离开 HTTP 就没有意义的留在 router（路径、状态码、把业务异常翻译成 HTTPException）。更快的检查：service 文件里出现 `from fastapi import` 就是越界。
:::

2. 今天的 router、service、repository 分别对应第 3 周 NestJS 的哪些角色？机制上最大的差异是什么？

::: details 参考答案
`APIRouter(prefix=...)` 对应 `@Controller`，service 模块对应 `@Injectable()` 的 Service，repository 模块对应 Repository 或数据访问代码，Pydantic schema 对应 DTO。机制差异在装配：NestJS 靠 IoC 容器注入依赖，FastAPI 今天靠模块 import 直接调用，Day 4 用 `Depends` 补上依赖注入。
:::

3. 为什么 service 抛 `UserEmailExistsError`，而不是直接抛 `HTTPException(400)`？

::: details 参考答案
业务异常描述领域事实，`HTTPException` 描述传输层结果。service 直接抛 `HTTPException` 会把业务层绑死在 HTTP 上，命令行、定时任务、消息队列的消费者都没法复用。分成「service 抛业务异常、router 翻译成状态码」之后，同一个异常还能按端点语义译成 400 或 409，互不牵连。
:::

4. 请求总是 404，到 `/docs` 一看路径拼成了 `/users/users`，问题出在哪？

::: details 参考答案
prefix 和装饰器里的路径重复声明了 `/users`。前缀只写在 `APIRouter(prefix="/users")`，装饰器写相对路径：列表用 `""`，详情用 `"/{user_id}"`。这种错不抛异常，只能靠 `/docs` 里的实际路径核对。
:::

5. 不启动 uvicorn，怎么验证「重复 email 注册会被拒绝」？

::: details 参考答案
pytest 里先 `user_repository.clear()`，再直接调 `user_service.register` 两次，第二次断言 `pytest.raises(UserEmailExistsError)`。全程没有 HTTP，毫秒级跑完；HTTP 翻译那条链路留给少量 TestClient 端到端用例兜底。
:::

## 延伸阅读

- [FastAPI 官方教程：Bigger Applications](https://fastapi.tiangolo.com/tutorial/bigger-applications/)，APIRouter、项目结构、多文件组织的原始出处，今天的目录划分就出自这里
- [FastAPI 官方教程：Testing](https://fastapi.tiangolo.com/tutorial/testing/)，TestClient 的用法，读完就更清楚今天为什么把它留给端到端用例
- [第 1 周教程](/week01/)，`ApiResponse<T>` 的响应包装思路，本周后段给 Agent 接口统一响应格式时会再用一次

今天的分层骨架留好。Day 4 把 repository 的五个函数换成 SQLAlchemy，用 `Depends` 注入 session，router 和 service 几乎不动，你会亲眼看到分层兑现的那一刻。
