# 第 10 周 · Day 4：SQLAlchemy 2.0 与 Depends——把用户从内存数组搬进 Postgres

> 对应手册任务：学习「SQLAlchemy 2.0 基础（Engine/Session/ORM 模型）+ 依赖注入 `Depends`」，动手「定义 `User` ORM 模型，用 `Depends` 注入 session 实现数据库查询」，当日产出「DI 可用」。本篇只解决一个问题：分层在 Day 3 已经拆好，可 repository 还是个内存数组，进程一重启用户全体蒸发。今天把它接到第 4 周就躺在 Docker 卷里的那个 Postgres 容器上，service 层一行不改——顺便学会 FastAPI 的依赖注入，亲眼验证「换实现不动上层」不是口号。

## 今日目标

1. 说得清 SQLAlchemy 和 Prisma 的路线差异（命令式 ORM 对声明式 schema-first），以及为什么在 Python 世界它是绕不开的必修课
2. 掌握三个核心件：Engine（进程一个的连接池）、Session（每请求一个的工作单元）、`DeclarativeBase` 加 `Mapped` 的 2.0 模型写法，并能一眼认出网上的 1.x 老教程
3. 独立完成 `User` ORM 模型和 `get_db` 依赖，repository 换成 SQLAlchemy 实现、service 零改动，用 curl 读写真库，重启进程后数据还在

## 概念讲解：为什么是 SQLAlchemy

先看现状。Day 3 把链路拆成了 router → service → repository，职责清爽，但 repository 的底气是一个模块顶部的 `_USERS: list`。内存数组什么都好，就是有个致命属性：进程一停，全体蒸发。

这一幕你不陌生。第 4 周 Day 1，NestJS 的 Users 模块住在内存里，当时的解法是 Prisma 加一个 Postgres 容器。今天在 Python 侧做同一件事，容器还是那个容器——`pgdata` 卷里的数据一页没丢，`docker compose up -d` 就回来——换的只是 ORM。

那能不能继续用 Prisma？Python 有 prisma-client-py，但那是社区边缘项目。事实标准是 SQLAlchemy：二十多年历史，FastAPI 官方文档用的就是它。更现实的原因是企业 Python 存量巨大——老系统、数据平台、公司内网服务，十有八九是 SQLAlchemy 或 Django ORM。你以后写 Agent 要接的数据库，大概率不是你新建的，而是这些存量系统。所以它是必修课，不是选修课。

两者的路线差异值得先想清楚。Prisma 是声明式：`schema.prisma` 是一门独立 DSL，`prisma generate` 生成客户端，你调用的是生成物，schema、client、迁移三件套一体化。SQLAlchemy 是命令式：模型就是普通 Python 类，查询就是 Python 表达式（`select(User).where(...)`），没有代码生成步骤，SQL 的每个零件都摸得到。第 4 周写 `prisma.user.findUnique(...)` 时你面对的是一层封装好的接口；今天写 `session.scalars(select(User).where(User.id == 1))` 时你面对的是可以一直拆到 SQL 的零件盒。代价是概念多，今天要一口气学三个：Engine、Session、模型。

最后一个开场警告：SQLAlchemy 在 2023 年发布了 2.0，是一次换代级改版。网上流传的教程一大半是 1.x 的——`session.query(User).filter(...)`、`Column(String)`、`declarative_base()` 函数。这些写法在 2.0 里大多还能跑（有兼容层），所以老代码不报错，新学的人会在不知情中学成两套混血。今天全程 2.0 风格，识别对照表放在核心知识第 2 节，撞见老教程时自己翻译。

## 核心知识

本节的代码块都是独立示例，可以直接贴进[本周](/week10/)的 agent-service 项目对照着看。最终完整文件以下面的动手任务为准。

### 1. Engine、Session、sessionmaker：池子一个，会话无数

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine(
    "postgresql+psycopg://jerry:dev123456@localhost:5432/agent_db",
    echo=True,  # 把执行的 SQL 打到控制台，学习期开着，眼见为实
)

SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)
```

关键一行是 `create_engine(...)`：Engine 在整个进程里只建一次，内部是连接池——和数据库保持一小撮现成连接，随取随还，谁也不真断开。注意这一步并不连接数据库，第一条真正的连接发生在第一次用到时。URL 的格式是 `方言+驱动://用户名:密码@主机:端口/库名`，比第 4 周 Prisma 那条连接串多了一段 `+psycopg`，因为 SQLAlchemy 要求你点名驱动，Prisma 当年帮你藏掉了。

Session 是工作单元（unit of work）：一次请求里的所有读写共用一个事务，`commit` 一起成功，`rollback` 一起回滚。它从池里借一条连接，用完还回去。数量级记死一句话：**Engine 进程一个，Session 请求一个**。sessionmaker 是工厂，把「Session 怎么造」的配置（绑定哪个 Engine、什么参数）固定下来，之后每次 `SessionLocal()` 出厂的都是同款。

想立刻体检，两行就够：

```python
from sqlalchemy import text

with SessionLocal() as session:
    print(session.execute(text("SELECT 1")).scalar_one())  # 连得上、查得动，输出 1
```

### 2. DeclarativeBase 与 Mapped：2.0 风格的模型

```python
from datetime import datetime

from sqlalchemy import String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50))
    email: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

关键一行是 `id: Mapped[int] = mapped_column(primary_key=True)`：类型写在 `Mapped[...]` 注解里，SQLAlchemy 读注解推导列类型（`Mapped[int]` 映射 INTEGER 并自增主键，`Mapped[str]` 配 `String(50)` 定长度），mypy 和 IDE 从此认识这个字段。这是 2.0 和 1.x 的分水岭——老写法 `id = Column(Integer, primary_key=True)` 里，类型只是「传给库的参数」，Python 侧并不知道 id 是 int。想让列可空，注解写成 `Mapped[str | None]`，可空性也由类型说了算。

`server_default=func.now()` 表示 `created_at` 由数据库在 INSERT 时填默认值，而不是 Python 侧掐表。将来多个服务器同时写库时，时间以库为准才不打架。

撞见老教程时用这张表翻译：

| 你在网上看到的（1.x） | 2.0 的写法 |
| --- | --- |
| `declarative_base()` 函数 | `class Base(DeclarativeBase)` |
| `name = Column(String(50))` | `name: Mapped[str] = mapped_column(String(50))` |
| `session.query(User).get(1)` | `session.get(User, 1)` |
| `session.query(User).filter(...)` | `session.scalars(select(User).where(...))` |

### 3. Depends 与 get_db：yield 前后就是 setup 与 teardown

Web 框架都要回答一个问题：每个请求需要一个 Session，谁来发、谁来收？FastAPI 的答案是依赖注入：

```python
from collections.abc import Generator

from sqlalchemy.orm import Session

from database import SessionLocal


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()   # yield 之前：请求进来前执行（setup）
    try:
        yield db          # 把 db 交给路由函数，请求体在这里跑
    finally:
        db.close()        # yield 之后：请求结束后执行（teardown），出错也会走到
```

关键一行是 `yield db`：函数在这里暂停，把 db 递给路由函数；路由跑完（正常返回或抛异常），函数从 yield 处恢复，走 finally 关掉 Session、把连接还进池子。一个普通函数，把「每请求一个 Session、用完必还」两件事一次管完。路由函数那头只写一个带默认值的参数：

```python
from fastapi import Depends

def get_user(user_id: int, db: Session = Depends(get_db)):
    ...
```

和你在 NestJS 里写的那套对照，哲学差异一眼见底。NestJS 是容器魔法：`@Injectable()` 注册，构造函数声明依赖，框架扫描模块图、反射解析、替你 new 出一整棵对象树，你几乎看不到实例在哪创建。FastAPI 是显式函数参数：依赖就是个普通函数，谁要用，谁在参数里写 `Depends(get_db)`，依赖链摊在函数签名上，从 router 一眼看到底。代价各有：容器注入在大项目里整齐省事，出错时要钻进框架里排查；显式注入可追踪、随手可用（认证、分页、限流都能是一个依赖），依赖链长时层层 `Depends` 写起来啰嗦。没有对错，是两种口味，你两种都得会。

还有一个马上要用的特性：依赖可以依赖依赖。比如「UserService 依赖 UserRepository 依赖 Session」，FastAPI 会自动解析整条链，第 4 步见。

## 动手任务：User 模型 + get_db 一步一步

手册任务：定义 `User` ORM 模型，用 `Depends` 注入 session 实现数据库查询。拆成 5 步，全程约 30 分钟。基线是 Day 3 的分层：router 调 service，service 调 repository。你的文件名和方法名跟这里有出入没关系，重点看今天动了哪些文件、哪些一行没动。

**第 1 步：装包，给老容器开间新库。**

```bash
pip install sqlalchemy "psycopg[binary]"
```

回到第 4 周 Day 1 的 docker-compose 目录执行 `docker compose up -d`，容器 ai-agent-pg 回来，`pgdata` 卷里旧数据都在。第 4 周的 `app_db` 是 NestJS 和 Prisma 的地盘，别去踩，给 Python 服务开个新库：

```bash
docker exec -it ai-agent-pg psql -U jerry -d postgres -c "CREATE DATABASE agent_db;"
```

**第 2 步：.env 换真连接串。**

第 9 周 Day 5 的 .env 里，`APP_DATABASE__URL` 一直是个占位符，今天换成真值：

```bash
APP_DATABASE__URL=postgresql+psycopg://jerry:dev123456@localhost:5432/agent_db
```

config.py 一个字不用改：`DatabaseSettings` 的 `url`、`echo` 字段早就等着了。上周说「配置一次到位」，今天就是兑现的样子。

**第 3 步：database.py 三件套 + models.py。**

```python
# database.py
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from config import get_settings

settings = get_settings()

engine = create_engine(settings.database.url, echo=settings.database.echo)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass
```

关键一行是 `expire_on_commit=False`：默认配置下 commit 之后对象的属性会「过期」，下次访问要回库重查一次；Web 场景里响应阶段还要读这些属性，关掉省一轮 SELECT，这也是 FastAPI 官方文档的写法。

```python
# models.py
from datetime import datetime

from sqlalchemy import String, func
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50))
    email: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

提醒一句：这个 `User` 和 Day 2 的 Pydantic 请求模型是两家人——一个描述数据库里的表（ORM 模型），一个描述 API 的形状（schema）。名字撞了就给 schema 加 `Create`、`Read` 后缀分开，别混用一个类干两件事。

**第 4 步：deps.py、repository 换实现、router 只改接线。**

先写依赖：

```python
# deps.py
from collections.abc import Generator

from sqlalchemy.orm import Session

from database import SessionLocal


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

然后换 repository。Day 3 的内存版大致长这样（细节以你的代码为准）：

```python
# repositories/user_repository.py（Day 3 内存版）
_USERS: list[dict] = []


class UserRepository:
    def get(self, user_id: int) -> dict | None:
        return next((u for u in _USERS if u["id"] == user_id), None)

    def create(self, name: str, email: str) -> dict:
        user = {"id": len(_USERS) + 1, "name": name, "email": email}
        _USERS.append(user)
        return user
```

换成 SQLAlchemy 实现：

```python
# repositories/user_repository.py（今天换成 SQLAlchemy）
from sqlalchemy import select
from sqlalchemy.orm import Session

from models import User


class UserRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(self) -> list[User]:
        return list(self.db.scalars(select(User).order_by(User.id)))

    def get(self, user_id: int) -> User | None:
        return self.db.get(User, user_id)

    def create(self, name: str, email: str) -> User:
        user = User(name=name, email=email)
        self.db.add(user)    # 只是记账：把对象登记进 Session
        self.db.commit()     # 过账：事务提交，这时才真正写库
        self.db.refresh(user)  # 回读数据库生成的 id 和 created_at
        return user
```

注意发生了什么：构造函数从无参变成收一个 Session，但 `get`、`create` 的参数和返回含义没变。service 调的还是 `repo.create(name, email)`，它不知道也不需要知道底下是数组还是 Postgres。UserService 的代码今天不贴，因为它一行都没改——这就是重点。

唯一要动接线的是 router：

```python
# routers/users.py（只看接线，业务调用和 Day 3 一模一样）
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from deps import get_db
from repositories.user_repository import UserRepository
from services.user_service import UserService

router = APIRouter(prefix="/users", tags=["users"])


def get_user_service(db: Session = Depends(get_db)) -> UserService:
    return UserService(UserRepository(db))


@router.get("/{user_id}")
def get_user(user_id: int, service: UserService = Depends(get_user_service)):
    return service.get_user(user_id)
```

对比 Day 3：service 的来源从「模块顶部 new 一个全局单例」变成「每个请求经 `get_user_service` 现造一个」。这条依赖链是 `get_user_service → get_db → SessionLocal`，FastAPI 自动逐层解析：请求进来先跑 get_db 拿 Session，再用 Session 造 repository、造 service，请求结束整条链一起回收。端点直接返回 ORM 对象是能跑的（FastAPI 的序列化会跳过 `_` 开头的内部字段）；生产里更稳的做法是套 Day 2 的响应模型并开 `from_attributes=True`，今天聚焦数据库，先允许这点偷懒。

**第 5 步：建表、启动、验证。**

```python
# main.py
from fastapi import FastAPI

import models  # noqa: F401 —— 必须导入，模型才会注册进 Base.metadata
from database import Base, engine
from routers.users import router as users_router

Base.metadata.create_all(bind=engine)  # 表不存在才建，存在就跳过

app = FastAPI(title="agent-service")
app.include_router(users_router)
```

关键一行是 `import models`：`create_all` 扫的是 `Base.metadata`，模型类没被导入就不在 metadata 里，一句不报错地空跑。`create_all` 只会建缺失的表，不会修改已有表的结构——开发期够用，表结构要演进就得用迁移工具，SQLAlchemy 生态的那个叫 Alembic，今天知道名字就行，等真加字段那天再学。

启动并验证：

```bash
uvicorn main:app --reload --port 8000

curl -X POST http://localhost:8000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Jerry", "email": "jerry@example.com"}'

curl http://localhost:8000/users/1
```

GET 拿到 `id` 和 `created_at`，这两个字段是数据库填的，说明真落库了。然后是今天最有仪式感的一刻：Ctrl+C 杀掉 uvicorn，重新启动，再 curl 一次 `/users/1`——数据还在。第 4 周 Day 1 说「数据在卷里，回来一切照旧」，今天轮到你的服务配得上这句话。不放心的话，绕过应用直接看库：

```bash
docker exec -it ai-agent-pg psql -U jerry -d agent_db -c "SELECT id, name, email FROM users;"
```

::: tip 开着 echo 学
`.env` 里加一行 `APP_DATABASE__ECHO=true` 再启动，终端会滚出每条请求发出的 SQL。对着 curl 看一遍：一条 INSERT 带 RETURNING、一条 SELECT，比读十遍文章直观。看完记得关掉，不然日志吵翻天。
:::

## 常见踩坑

**坑 1：网上教程一半是 1.x 的。** 识别特征：`session.query(...)` 开头的查询、`Query.get()`、`Column(String)`、`declarative_base()` 函数。这些在 2.0 里大多能跑，所以你抄下来不报错，但新代码别再写。两个动作防身：查文档时确认右上角版本是 2.0，搜教程时在关键词里加「sqlalchemy 2.0」。核心知识第 2 节那张对照表，撞见老的就在心里翻一次。

**坑 2：`ModuleNotFoundError: No module named 'psycopg2'`。** URL 写 `postgresql://`（不带 `+驱动`）时，SQLAlchemy 默认找 psycopg2，而你装的是 psycopg 3，两个是不同的包。两种修法：URL 改成 `postgresql+psycopg://`（推荐，和今天一致），或者 `pip install psycopg2-binary` 继续用老驱动。连接串三段式再记一遍：`方言+驱动://用户名:密码@主机:端口/库名`，报这个错九成是驱动段和环境里的包对不上。

**坑 3：`create_all` 空跑，查表报 `relation "users" does not exist`。** 两个来源：一是 models 没被导入，`Base.metadata` 是空的，建表静默跳过（第 5 步那行 `import models` 就是防它）；二是连错了库，表建到别的库去了。排查一条命令：`docker exec -it ai-agent-pg psql -U jerry -d agent_db -c "\dt"`，有表说明建对了，没表回到第一种原因。

**坑 4：忘了 commit，数据「丢了」。** 症状：接口返回一切正常，重启后数据没了，psql 查也没有。原因：`add` 只是登记，`commit` 才落库，你在 create 里把 commit 删了或漏了。工作单元的账本比喻记牢：add 是记账，commit 是过账，rollback 是撕账。commit 失败时 Session 会自动 rollback，get_db 的 finally 里 close 也会丢弃未提交的事务，所以不会留下半个事务——但没有 commit，就什么都没发生过。

**坑 5：绕开 get_db 自己开 Session。** 两个变体。一是图省事在模块顶部 `db = SessionLocal()` 全局共享：并发请求挤在同一个 Session、同一个事务里，互相踩脏数据，症状是偶发的、没法稳定复现的错乱。二是在路由函数里手写 `SessionLocal()` 又忘了 close：连接还不回池子，请求一多池子耗尽，报 `QueuePool limit ... overflow ... reached`。规矩一句话：Session 每请求一个，用完就还，`get_db` 已经替你把两件事管完，没有理由亲手绕开它。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Engine、Session、sessionmaker 各自的生命周期和数量级是什么？

::: details 参考答案
Engine 进程一个，启动时创建，内部持有连接池，直到进程退出；sessionmaker 也是进程一个，是造 Session 的工厂，固定绑定某个 Engine 和参数；Session 每请求一个，请求开始时创建、结束时关闭，代表一次事务。对应到今天的代码：engine 和 SessionLocal 在模块顶部，get_db 每个请求跑一遍。
:::

2. `Mapped[int] = mapped_column(primary_key=True)` 比老写法 `Column(Integer, primary_key=True)` 多给了你什么？

::: details 参考答案
类型信息回到了 Python 侧。`Mapped[int]` 注解既是 SQLAlchemy 推导列类型的依据（int 映射 INTEGER、自增主键），也是 mypy 和 IDE 看得见的字段类型；老写法里类型只是传给库的参数，Python 侧并不知道 `user.id` 是 int。可空性同理由 `Mapped[str | None]` 表达。一句话：注解即元数据。
:::

3. `get_db` 里 yield 之后的代码什么时候执行？路由函数抛了 HTTPException 还会执行吗？

::: details 参考答案
请求处理结束之后：路由函数返回或抛异常，generator 从 yield 处恢复，执行 finally 里的 `db.close()`。抛异常也会执行——`try/finally` 保证的，FastAPI 拿依赖的生成器也是这么用的：响应送出去后跑 teardown。所以 close 不依赖业务代码写没写 try，这条路是框架铺好的。
:::

4. FastAPI 的 `Depends` 和 NestJS 的 Provider 注入，哲学差异是什么？各自的代价？

::: details 参考答案
NestJS 是容器魔法：装饰器注册，构造函数声明依赖，框架扫描模块图、反射解析、自动 new 出整棵对象树，大项目整齐省事，但实例创建过程不可见，出错要钻框架排查。FastAPI 是显式函数参数：依赖是普通函数，`Depends(...)` 写在参数里，依赖链摊在函数签名上，可追踪、随手可用，代价是链长时层层声明啰嗦。一个是「交给容器」，一个是「写在脸上」。
:::

5. 今天 UserService 为什么一行没改？这兑现了 Day 3 分层时的什么承诺？

::: details 参考答案
因为 service 依赖的是 repository 的「契约」（方法名、参数、返回含义），不是它的实现。实现从内存数组换成 SQLAlchemy，构造函数多收一个 Session，但契约没变，调用处就不用变。兑现的承诺是：分层让「换实现」的成本收敛到一层，第 4 周在 NestJS 里享受过一次，今天在 FastAPI 里原样再来一次——顺带说明这个价值来自分层本身，和语言框架无关。
:::

## 延伸阅读

- [SQLAlchemy 2.0 官方 Tutorial](https://docs.sqlalchemy.org/en/20/tutorial/)，本篇所有 API 的原始出处，Unified Tutorial 一章就是为 2.0 重写的，值得通读
- [FastAPI 官方文档：Dependencies](https://fastapi.tiangolo.com/tutorial/dependencies/)，从 `Depends` 到 `yield` 依赖的完整讲解，get_db 的 teardown 语义在这里有权威说明
- [FastAPI 官方文档：SQL（关系数据库）](https://fastapi.tiangolo.com/tutorial/sql-databases/)，官方版「SQLAlchemy + FastAPI」整合教程，和今天的路线一致，可以对照查漏

今天的 `database.py`、`models.py`、`deps.py` 三件套留好：明天写 SSE 流式端点还在这个骨架上跑，后面给 Agent 存对话记录，也不过是照今天的套路再建一张 `messages` 表的事。
