# 第 9 周 · Day 5：pydantic-settings——给配置一个类型安全的单一入口

> 对应手册任务：学习「Pydantic 嵌套模型 + 配置管理」，动手「用 pydantic-settings 管理环境变量配置」，当日产出 `config.py`。本篇只解决一个问题：配置散落在项目各处的 `os.getenv` 里，拿到的清一色是 `str | None`，键名拼错没人管，变量漏配要等代码跑到那一行才崩。第 3 周 Day 2 你用 dotenv + zod 解决过一次，今天在 Python 里再做一遍，顺便验证「配置即代码」这套思想跨语言成立。

## 今日目标

1. 说得清 pydantic-settings 相当于 dotenv + zod 的合体，以及 `BaseSettings` 在 v2 里为什么搬了家
2. 掌握三个配置点：`env_prefix` 前缀隔离、`env_nested_delimiter` 嵌套展开、`env_file` 加载 .env；外加嵌套模型组装和 `lru_cache` 单例
3. 独立完成 `config.py`：嵌套校验、`settings.database.url` 点号访问、`get_settings()` 单例三件套齐活，并亲眼看到漏配一个变量时程序在启动阶段就崩

## 概念讲解：为什么 os.getenv 撑不起 agent-service

先看 Python 项目的默认写法。数据库地址、Redis 地址、LLM 的 API key，全靠 `os.getenv`：

```python
import os

db_url = os.getenv("DATABASE_URL")
pool_size = int(os.getenv("POOL_SIZE", "5"))
api_key = os.getenv("LLM_API_KEY")
```

四个老问题一个不少。第一，`os.getenv` 返回 `str | None`，mypy 也救不了你，类型就是可能没有，每个使用点都得判空。第二，`POOL_SIZE` 拿到的是字符串，要自己 `int()` 转一圈，环境里写了个 `abc` 就在运行时炸 `ValueError`。第三，`LLM_API_KEY` 拼成 `LLM_APIKEY`，getenv 静默返回 None，拼写错误没人抓。第四，`api_key` 忘了配，报错发生在用到它的那一刻，可能是启动后三分钟，也可能是个 None 一路安静地传染下去。

这套问题你在第 3 周 Day 2 用 dotenv + zod 解决过：dotenv 把 `.env` 读进 `process.env`，zod schema 在启动时校验并推导类型，缺了立刻崩。当时定的规矩是「配置只从一个模块出，启动那一刻校验」。今天把这套规矩原样搬进 Python，而且工具更省事，pydantic-settings 一个包把加载和校验全包了：

| 第 3 周 Day 2（TS） | 本周（Python） |
| --- | --- |
| `import "dotenv/config"` 读 .env | `env_file=".env"` 写进 SettingsConfigDict |
| zod schema 声明形状 | Pydantic 嵌套模型声明形状 |
| `z.infer` 从 schema 推导类型 | 模型本身就是类型，mypy 直接认 |
| `safeParse` 启动即校验 | `Settings()` 实例化即校验 |
| 缺字段启动崩 | 缺字段抛 ValidationError，同样是启动崩 |

差别只在路线：zod 是「schema 这个值推导出类型」，Pydantic 是「类型注解反过来当校验器」。你在[本周](/week09/)前几天已经用 `BaseModel` 校验过数据，今天只是换个入口——环境变量——喂同样的模型。

## 核心知识

本节的代码块都是独立示例，可以直接贴进[本周](/week09/)的 agent-service 项目里跑。最终完整文件以下面的动手任务为准。

### 1. 最小可用的 BaseSettings（先过 v1/v2 这道坎）

先说一个几乎百分之百会撞上的坑：`BaseSettings` 不在 pydantic 里。v2 把它拆去了独立包 pydantic-settings，导入路径是：

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    debug: bool = False
    api_key: str
```

老教程里 `from pydantic import BaseSettings` 是 v1 时代的写法，在 v2 里直接 ImportError，报错信息会明确告诉你它搬去了 pydantic-settings。所以第一件事是装包：

```bash
pip install pydantic-settings
```

有了模型，实例化那一下就是校验：环境变量名默认就是字段名（大小写不敏感），`API_KEY=sk-xxx` 喂给 `api_key`，`DEBUG=true` 自动转成 `True`。`bool`、`int`、`float` 的转换和校验全是 pydantic 做的，不用再手写 `int(os.getenv(...))`。字段类型是 `str` 而环境里没有 `API_KEY`，`Settings()` 当场抛 `ValidationError`。这就是 fail fast：配置错误在启动那一刻爆，不是跑到连库那行才爆。

### 2. 前缀与嵌套：SettingsConfigDict 三件套

真实项目的配置有几十个字段，直接拍平会变成 `DATABASE_URL`、`DATABASE_POOL_SIZE`、`REDIS_URL` 的一字长蛇阵。pydantic-settings 的答案是「前缀 + 嵌套」，全在 `model_config` 里声明：

```python
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

class DatabaseSettings(BaseModel):
    url: str
    pool_size: int = 5

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="APP_",              # 只认 APP_ 开头的变量
        env_nested_delimiter="__",      # 双下划线切开嵌套层级
        env_file=".env",                # 顺便把 .env 读了，dotenv 不用另装
    )

    debug: bool = False
    database: DatabaseSettings
```

关键一行是 `env_nested_delimiter="__"`：`APP_DATABASE__URL` 会被拆成 `database.url`。双下划线是层级分隔符，单下划线只是字段名里的普通字符，这个区分明天你就会感谢它。于是 .env 长这样：

```bash
APP_DEBUG=true
APP_DATABASE__URL=postgresql://postgres:postgres@localhost:5432/agent
APP_DATABASE__POOL_SIZE=20
```

`env_prefix="APP_"` 解决的是污染问题：机器上的环境变量成百上千（`PATH`、`HOME`、Shell 的一堆），前缀把「本项目的配置」圈出来，也避免和别的服务撞名。注意 .env 里也要带前缀，`env_prefix` 不会替你补。优先级记一条就够：真实环境变量 > .env 文件 > 字段默认值。生产环境往容器里注入真实变量压过一切，本地开发写 .env，同一套代码两副面孔。

### 3. 嵌套模型：约束写在深处，启动时统一算账

嵌套不只是分组好看，真正的好处是深层字段的约束和顶层一起校验。约束用 `Field` 写在叶子所在的模型里：

```python
from pydantic import BaseModel, Field

class DatabaseSettings(BaseModel):
    url: str
    pool_size: int = Field(default=5, ge=1, le=100)
    echo: bool = False

class LLMSettings(BaseModel):
    api_key: str
    model: str = "gpt-4o-mini"
    timeout: float = Field(default=30.0, gt=0)
```

`APP_DATABASE__POOL_SIZE=999` 进来，`Settings()` 当场报 `Input should be less than or equal to 100`。你在本周前几天给业务模型写的那套 `Field` 约束，原封不动复用在配置上：配置不再是裸字符串，而是被校验过的对象树。读取全程点号访问，IDE 补全一路点到底：

```python
settings = Settings()
settings.database.url        # str，不是 str | None
settings.database.pool_size  # int，已经是数字
settings.llm.api_key         # str
```

这一幕和第 3 周的 `config.databaseUrl` 一模一样。两边对照着看你会发现，dotenv+zod 和 pydantic-settings 是同一个思想的两种拼写：形状用代码声明，校验在启动时一次做完，业务代码拿到的永远是干净类型。「配置即代码」不是某个库的功能，是一种跨语言模式，你在[第 1 周](/week01/)练出的那套类型直觉，在这里直接兑现。

## 动手任务：`config.py` 一步一步

手册任务：用 pydantic-settings 管理环境变量配置。拆成 5 步，全程约 25 分钟。

**第 1 步：装包、建文件。** 在 agent-service 项目根目录执行 `pip install pydantic-settings`（uv 管理的项目用 `uv add pydantic-settings`）。然后新建两个文件：`config.py` 和 `.env`。顺手确认 `.gitignore` 里有 `.env`，密钥文件进 git 是事故，不是失误。

**第 2 步：写 .env。** 照抄这份：

```bash
APP_DEBUG=true
APP_DATABASE__URL=postgresql://postgres:postgres@localhost:5432/agent
APP_DATABASE__POOL_SIZE=20
APP_REDIS__URL=redis://localhost:6379/0
APP_LLM__API_KEY=sk-demo-key-123
APP_LLM__MODEL=gpt-4o-mini
```

注意 `APP_DATABASE__URL` 中间是双下划线，对应嵌套层级。再建一份同结构、填假值的 `.env.example` 进 git，告诉后来者要配什么，这个习惯第 3 周就有，保持。

**第 3 步：写 config.py。**

```python
from functools import lru_cache

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseModel):
    url: str
    pool_size: int = Field(default=5, ge=1, le=100)
    echo: bool = False


class RedisSettings(BaseModel):
    url: str = "redis://localhost:6379/0"
    max_connections: int = Field(default=10, ge=1)


class LLMSettings(BaseModel):
    api_key: str
    model: str = "gpt-4o-mini"
    timeout: float = Field(default=30.0, gt=0)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="APP_",
        env_nested_delimiter="__",
        env_file=".env",
        extra="ignore",
    )

    debug: bool = False
    database: DatabaseSettings
    redis: RedisSettings = RedisSettings()
    llm: LLMSettings


@lru_cache
def get_settings() -> Settings:
    return Settings()


if __name__ == "__main__":
    s = get_settings()
    print(s.debug, type(s.debug))                          # True <class 'bool'>
    print(s.database.url)                                  # postgresql://...
    print(s.database.pool_size, type(s.database.pool_size))  # 20 <class 'int'>
    print(s.llm.model)                                     # gpt-4o-mini
```

逐段看。三个子模型都是普通 `BaseModel`，只有最外层 `Settings` 继承 `BaseSettings`——环境变量的入口只有一个。`extra="ignore"` 是给 .env 兜底：默认的 `extra="forbid"` 会把 .env 里模型没声明的变量当成错误直接拒收（详见坑 4）。`lru_cache` 让 `get_settings()` 只在第一次调用时真正读环境建对象，之后所有人共享同一份。

**第 4 步：故意漏配，看它在启动那一刻就崩。** 把 `.env` 里的 `APP_LLM__API_KEY` 注释掉，再跑：

```bash
python config.py
```

输出类似（措辞随 pydantic 版本略有差异）：

```text
pydantic_core.ValidationError: 1 validation error for Settings
llm.api_key
  Field required [type=missing, ...]
```

注意报错里的 `llm.api_key`：嵌套路径直接标出来了，缺在哪一层一目了然。对比 `os.getenv` 版本，同样的漏配那边的 `api_key` 是 None，程序照常启动，直到某个请求真的去调 LLM 才在远方炸开。看完把注释还原。

**第 5 步：体会单例的用法。** 在别的模块里要配置，只 import 一个函数：

```python
from config import get_settings

settings = get_settings()
```

规矩和第 3 周一样：业务代码不许自己摸 `os.environ`，要配置只能走 `get_settings()`。全项目只实例化一次，校验只跑一次，改配置只有一个入口。

::: tip 运行与检查
`python config.py` 应当打印四行配置值；`mypy config.py` 应当零报错，[本周](/week09/) Day 2 配好的检查器今天照常执勤。测试想覆盖某项配置时，先 `get_settings.cache_clear()` 清缓存，再 `monkeypatch.setenv("APP_DEBUG", "true")`，最后重新调用 `get_settings()`。
:::

## 常见踩坑

**坑 1：照老教程 `from pydantic import BaseSettings`，直接 ImportError。** v1 时代它确实住在 pydantic 里，v2 拆去了独立的 pydantic-settings 包。`pip install pydantic-settings`，导入改成 `from pydantic_settings import BaseSettings`，完事。顺带一句：v1 教程里内嵌的 `class Config: env_prefix = ...` 写法，v2 也换成了 `model_config = SettingsConfigDict(...)`。搜中文教程先看导入语句，一眼判断新旧。

**坑 2：嵌套分隔符写成单下划线。** `env_nested_delimiter="__"` 声明的是双下划线，那 `APP_DATABASE_URL` 就不会被切成 `database.url`，pydantic 找不到叫 `database_url` 的字段：该字段必填就报 `database.url Field required`，有默认值就更阴险，静默连上默认库。口诀：嵌套层级用双下划线，字段名内部才用单下划线。另一个相关行为：嵌套字段给了带值的默认实例、又用环境变量只覆盖其中一个叶子时，其余叶子回落到子模型的字段默认值，不是你实例里的值。简单原则：整棵子树要么必填、要么全走字段默认值，别混。

**坑 3：.env 的相对路径跟的是运行目录，不是文件目录。** `env_file=".env"` 以「执行命令时所在目录」为基准解析。在项目根跑 `python config.py` 没事，从别处跑 `python agent-service/config.py` 就读不到文件，症状是一排字段集体报缺。稳妥写法是锚定文件自身位置：

```python
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

model_config = SettingsConfigDict(
    env_file=BASE_DIR / ".env",
    env_prefix="APP_",
    env_nested_delimiter="__",
)
```

**坑 4：.env 里混进未声明的变量，直接 ValidationError。** pydantic-settings 默认 `extra="forbid"`，而且读 .env 时不看 `env_prefix`，文件里所有条目都会交给模型。手滑多写一行 `DATABASE_URL=...`（忘了 APP_ 前缀）或从别的项目复制了一段，启动就报 `Extra inputs are not permitted`。解法就是动手任务里那行 `extra="ignore"`，一劳永逸。

**坑 5：print(settings) 把密钥打进日志。** 默认 repr 和 `model_dump()` 会把 `api_key` 原样吐出来，日志一收集，密钥就巡展了。治本办法是声明成 `SecretStr`：

```python
from pydantic import SecretStr

class LLMSettings(BaseModel):
    api_key: SecretStr
```

打印时只显示 `SecretStr('**********')`，真要用时 `settings.llm.api_key.get_secret_value()` 显式取出。「显式取出」这个设计本身就是提醒：取密钥是个敏感动作，别顺手。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. pydantic v2 里 `BaseSettings` 从哪导入？为什么它不在 pydantic 主包里？

::: details 参考答案
从独立包 pydantic-settings 导入：`from pydantic_settings import BaseSettings`。v2 把「从环境读配置」从核心拆了出去，核心只管数据校验，配置加载按需安装。`from pydantic import BaseSettings` 是 v1 写法，v2 下直接 ImportError。
:::

2. `env_prefix="APP_"` 和 `env_nested_delimiter="__"` 各管什么？`APP_DATABASE__POOL_SIZE` 映射到哪个字段？

::: details 参考答案
前缀圈定「本项目关心哪些环境变量」，也避免与其他服务撞名；分隔符声明用什么符号切嵌套层级。`APP_DATABASE__POOL_SIZE` 去掉前缀后按双下划线切开，映射到 `settings.database.pool_size`。单下划线只是字段名的一部分，不参与切层。
:::

3. 真实环境变量、.env 文件、字段默认值，三者优先级如何？生产环境怎么利用这个顺序？

::: details 参考答案
真实环境变量 > .env 文件 > 字段默认值。生产环境在容器里注入真实变量压过一切，本地开发用 .env，默认值兜底。同一份镜像不用改代码就能切换环境。
:::

4. 为什么用 `@lru_cache` 包 `get_settings()`？测试里想换一份配置怎么做？

::: details 参考答案
让全项目共享一个 Settings 实例：环境只读一次、校验只跑一次、行为可预期，配置也只有一个入口。测试里先 `get_settings.cache_clear()` 清缓存，`monkeypatch.setenv` 设新值，再调 `get_settings()`。忘了 cache_clear 拿到的还是旧实例，这是单例的标准代价。
:::

5. 「fail fast」为什么比「用到时才报错」好？和第 3 周 zod 版配置对照，说明了什么？

::: details 参考答案
配置错误在部署那一刻就已确定，越早爆越好定位：启动即崩，日志里一眼看到缺什么、错在哪层；拖到运行时，炸点远离病因，还可能是 None 一路不报错地传染。dotenv+zod 和 pydantic-settings 语言不同、写法不同，但「声明形状、启动校验、缺了就崩」这个骨架完全同构，配置即代码是跨语言模式，不是某个库的私有功能。
:::

## 延伸阅读

- [pydantic-settings 官方文档](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)，前缀、嵌套分隔符、dotenv、SecretStr、各种配置项的完整说明，今天只用到它的一角
- [Pydantic Fields 文档](https://docs.pydantic.dev/latest/concepts/fields/)，`ge/le/gt` 等约束项清单，配置校验和业务校验共用这一套
- [The Twelve-Factor App：配置](https://12factor.net/zh_cn/config)，「配置存在环境变量里」这个约定的原始出处，值得一读原文

今天的产出 `config.py` 留好，`LLMSettings` 就是给明天准备的：agent-service 接 LLM 客户端时，密钥、模型名、超时全部从 `get_settings().llm` 出，业务代码一行 `os.environ` 都不用碰。
