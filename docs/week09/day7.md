# 第 9 周 · Day 7：周复盘方法论——用一次 JS→Python 迁移收口本周

> 手册任务：周复盘 + 整理。用 Python 重写第 5 周的一个 JS 工具函数，对比差异，写周记，当日产出：对比笔记 + 周记。
> 本篇解决的问题只有一个：这六天学的是一堆"Python 里 X 怎么写"，今天要把它们钉回你脑子里那张 TS 的地图上。对应得上、并且知道哪里对应不上的，才算真学会了。

## 今日目标

1. 合上教程默写五维对照表：生态、类型、校验、异步、装饰器，每个维度至少说出五条"在 TS 里写 X，Python 里写 Y"
2. 把第 1 周 packages/shared 的 formatDate 用 Python 重写，加 Pydantic 校验入参，记下至少三处行为差异
3. 按四段模板写 300 字周记，10 题自检验收，答不上的回读对应 Day

## 概念讲解：为什么"迁移对比"是本周最好的复盘方式

[第 1 周 Day 7](/week01/) 讲过复盘的底层逻辑：识别不等于提取，合上资料写不出来就是不会。那套结论本周原样有效，不复述。本周多一个有利条件：你脑子里已经装着一套完整的 TS 知识网。

新知识孤零零放一周就没了，挂在旧钩子上很难掉。TS 就是你现成的那排钩子。poetry 挂在 npm 上，mypy 挂在 tsc 上，Pydantic 挂在 zod 上，asyncio 挂在 Promise 上。今天做的所有事，本质都是挂钩子。

但挂钩子要分两步，缺一不可。第一步找对应：`Record<string, number>` 对 `dict[str, int]`，这种同构帮你学得快。第二步找差异：长得像、行为反的地方才真正值钱。`time.sleep` 在 JS 里没有对应物（Node 的 setTimeout 天生非阻塞），Python 里它冻住整个事件循环；JS 的 `new Date(数字)` 吃毫秒，Python 的 `fromtimestamp` 吃秒。对应错了不会让你 debug 到半夜，差异记漏了才会。

所以本周的"结构图复盘法"升级成"对照表复盘法"，输出还是三种：

| 输出方式 | 逼出什么 | 对应今天的产出 |
| --- | --- | --- |
| 对照表 | 对应关系是否成网 | 五维迁移总表 |
| 重写 | 手感是否真的切换 | formatDate Python 版 + 对比笔记 |
| 周记 + 自测 | 认知变化 + 细节 | 300 字周记 + 10 题自检 |

::: tip 流程不变，内容变
第 1 周 Day 7 建立的复盘流程本周照走：结构图（本周形态是对照表）、四段周记、10 题自检、git 收口。以后每个 Day 7 都是这个骨架。
:::

## 核心知识

### 1. JS↔Python 迁移对照总表（本篇核心交付）

先看五维总览，再逐维展开。默写时按这个框架来。

| 维度 | TS/Node 世界 | Python 世界 | 本周对应 |
| --- | --- | --- | --- |
| 生态 | npm + package.json + package-lock | Poetry + pyproject.toml + poetry.lock | Day 1 |
| 类型 | tsc，编译期检查，编译后擦除 | mypy，静态检查，注解运行时保留 | Day 2 |
| 校验 | zod，schema 与类型两张皮 | Pydantic v2，一个类当类型又当校验器 | Day 4-5 |
| 异步 | Promise，事件循环运行时自带 | asyncio，事件循环要自己 run | Day 3 |
| 装饰器 | TC39 提案 Stage 3，只装饰类成员 | 原生语法，函数类通吃 | Day 6 |

#### 生态：npm ↔ Poetry

高频五条，完整表 Day 1 给过，忘了回读：

| 在 Node 里你写 | 在 Python 里写 |
| --- | --- |
| npm i fastify | poetry add fastapi |
| npm i -D vitest | poetry add --group dev pytest |
| npm install（按 lock 恢复） | poetry install |
| npx tsc --noEmit | poetry run mypy app |
| npm run dev | poetry run python -m app.main |

#### 类型：tsc ↔ mypy

| 在 TS 里你写 | 在 Python 里写 |
| --- | --- |
| `string` / `number` / `boolean` | `str` / `int` 或 `float` / `bool`（number 拆成两个） |
| `string \| number` | `str \| int`（3.10+，老写法 `Union[str, int]`） |
| `name?: string` | `name: str \| None = None`（类型加默认值，两半缺一不可） |
| `string[]`、`number[]` | `list[str]`、`list[int]` |
| `Record<string, number>` | `dict[str, int]` |
| `[string, number]` | `tuple[str, int]` |
| `'a' \| 'b'` | `Literal['a', 'b']` |
| `type Status = ...` | `Status = Literal[...]` 或 `type Status = ...`（3.12） |
| tsc --noEmit | mypy app（第三方库要么自带 py.typed，要么补装 types-xxx 桩包） |

两处根本差异必须单记。其一，tsc 身兼检查和转译，TS 必须编译成 JS 才能跑；mypy 只检查不改代码，Python 源文件直接运行。其二，TS 类型编译后擦除殆尽，Python 注解运行时还在，函数带着 `__annotations__`。Pydantic 的运行时校验就建在这上面。本周前三天能串成一条线，靠的就是这条：**注解运行时可见，所以类型和校验才能合用一个定义**。

#### 校验：zod ↔ Pydantic v2

| 在 zod 里你写 | 在 Pydantic v2 里写 |
| --- | --- |
| `z.object({ name: z.string() })` | `class User(BaseModel): name: str` |
| `z.string().min(1)` | `Field(min_length=1)` |
| `z.number().int().min(0).max(150)` | `Field(ge=0, le=150)` |
| `.default('x')` | `Field(default='x')` |
| `schema.parse(data)`（失败抛错） | `User(**data)` 或 `model_validate(data)`（失败抛 ValidationError） |
| `schema.safeParse(data)` | 没有等价物，自己 `try/except ValidationError` |
| `z.string().email()` | `EmailStr`（要额外装 email-validator） |
| `.transform(s => ...)` | `@field_validator`（v1 叫 `@validator`） |
| `z.infer<typeof schema>` | 不需要，User 本身就能放在注解位置 |

最后一行是整个维度最值钱的差异：zod 里 schema 和类型是两套东西，靠 `z.infer` 桥接；Pydantic 里一个类全包，mypy 眼里它是类型，运行时它是校验器，FastAPI 还拿它做请求解析和序列化。一份定义三处用，这就是"运行时注解"换来的红利。

#### 异步：Promise ↔ asyncio

| 在 JS 里你写 | 在 Python 里写 |
| --- | --- |
| `async function f() {}` | `async def f(): ...`（调用返回协程对象，不执行） |
| `f().then(...)` | 没有 then，`await f()` 是唯一消费方式 |
| `await Promise.all([a(), b()])` | `await asyncio.gather(a(), b())`（结果按传入顺序，不按完成顺序） |
| `new Promise(r => setTimeout(r, 1000))` | `await asyncio.sleep(1)` |
| `setTimeout(fn, 1000)` 非阻塞 | 千万别 `time.sleep(1)`，会冻住整个循环；要延时用 `asyncio.sleep`，要延后回调用 `loop.call_later` |
| Node 启动即有事件循环 | `asyncio.run(main())` 手动起循环 |
| `fs.readFile` 自动进 libuv 线程池 | 阻塞调用冻住一切，要包 `await asyncio.to_thread(fn)` |

心法一句话：Node 的事件循环藏在运行时底下，你顺手就并发了；asyncio 的事件循环是个库，摆在明面上，你显式才并发。JS 的坑是忘了 await 还能跑（拿到 pending Promise），Python 的坑是忘了 run 直接没动静（只有 RuntimeWarning）。

#### 装饰器：提案 ↔ 原生

TS 侧现状一句话：装饰器在 TC39 走到 Stage 3 还没进正式标准，TS 5 起按新提案实现，但只能装饰类和类成员，独立函数没有 `@`；Angular、NestJS 用的还是 tsconfig 里 `experimentalDecorators` 那套老语法。所以 TS 工程里给普通函数加横切逻辑，写的是高阶函数：

```ts
const timed = withTiming(fetchUser); // 没有 @fetchUser 这种写法
```

Python 的 `@` 是 2004 年就进语言的原生语法，函数、方法、类通吃，还配了 functools 这套配套设施：

```python
@with_timing
def fetch_user(): ...
```

| 想做的事 | TS 写法 | Python 写法 |
| --- | --- | --- |
| 给函数加计时/重试 | 高阶函数手动包 | `@` 装饰器，定义处一行 |
| 保留原函数元数据 | 无此问题 | `@functools.wraps(func)` 必加 |
| 注册路由 | Express 手动 `app.get()`；Nest `@Get()` | `@app.get('/users')`（FastAPI 原生） |
| 依赖注入 | Nest `@Injectable()` 注册到 module | `Depends()` 参数声明 |

注册思想值得单独说：装饰器可以完全不改变函数行为，只在 import 时把函数登记进一张注册表，框架启动后遍历这张表统一调度。FastAPI 的路由表、Click 的命令组、NestJS 的 provider，底层是同一招，**声明处即注册处**。第 10 周写 FastAPI 你会天天用。

### 2. 实操：用 Python 重写 formatDate

手册要求重写一个旧的 JS 工具函数。这里选第 1 周 packages/shared 里的 formatDate：它是纯函数、无框架依赖、当年踩的坑一个不缺，是最佳对比样本。先看 TS 原版的关键部分（完整版见[第 1 周](/week01/) Day 6）：

```ts
const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDate(
  input: Date | number | string,
  pattern = 'YYYY-MM-DD HH:mm',
): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input); // 解析失败原样返回
  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1), // 月份从 0 开始
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => tokens[t]);
}
```

30 行里一半在造轮子：pad 是手搓的，token 替换是手写的，月份加一要心里记着。Python 版：

```python
from datetime import datetime


def format_date(
    value: datetime | int | str,
    pattern: str = "%Y-%m-%d %H:%M",
) -> str:
    """格式化日期。value 接受 datetime、秒级时间戳或 ISO 8601 字符串。"""
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = (
                datetime.fromtimestamp(value)
                if isinstance(value, int)
                else datetime.fromisoformat(value)
            )
        except (ValueError, OverflowError, OSError):
            return str(value)  # 解析失败原样返回，与 TS 版同一取舍
    return dt.strftime(pattern)
```

跑起来：

```python
print(format_date("2026-09-16T15:04:30"))                          # 2026-09-16 15:04
print(format_date("2026-09-16T15:04:30", "%Y年%m月%d日 %H:%M"))     # 2026年09月16日 15:04
print(format_date("不是日期"))                                     # 不是日期
```

对比笔记，五处差异逐条记（这就是今天的核心产出）：

1. **格式化：手搓对开箱即用。** JS 标准库没有日期格式化，pad、token、正则替换全自己写；Python 的 `strftime` 从 C 标准库继承，`%Y %m %d %H %M %S` 直接用。占位符体系换了：`YYYY-MM-DD` 变 `%Y-%m-%d`，`mm` 是分钟这件事在两边的含义还不一样（JS 的 mm 是自己定的 token，Python 的 %M 是标准）。
2. **解析：宽进对严进。** `new Date('不是日期')` 不抛错，返回 Invalid Date，要自己用 `isNaN(date.getTime())` 查；`fromisoformat` 不认识就直接抛 ValueError，try/except 接。宽松要你事后兜底，严格逼你当场处理。
3. **时间戳：毫秒对秒。** JS 的 Date 一律毫秒，第 1 周的坑是"秒要乘 1000"；Python 的 `fromtimestamp` 一律秒，方向反过来了，毫秒要先 `// 1000`。
4. **月份：加一对从 1 数。** `getMonth()` 从 0 起要 `+1`，Python 的月份数字天生从 1 起。当年手搓的 pad 和加一，Python 里全不需要。
5. **时区：半斤八两但更直白。** 两边默认都给你本地时区；Python 的 `datetime.now()` 是 naive datetime（不带 tzinfo），跨时区必须显式 `zoneinfo` 或 `timezone.utc`，第 10 周写服务端还会撞上，先留个记号。

再加 Pydantic 校验入参，把 Day 4 的知识用上。假设这个函数走 HTTP 接口进来，入参先过模型：

```python
import re
from pydantic import BaseModel, field_validator

ALLOWED_TOKENS = {"%Y", "%m", "%d", "%H", "%M", "%S"}


class DateFormatParams(BaseModel):
    value: datetime | int | str
    pattern: str = "%Y-%m-%d %H:%M"

    @field_validator("pattern")
    @classmethod
    def check_pattern(cls, v: str) -> str:
        for token in re.findall(r"%.", v):
            if token not in ALLOWED_TOKENS:
                raise ValueError(f"不支持的占位符：{token}")
        return v


def format_date_safe(raw: dict) -> str:
    params = DateFormatParams.model_validate(raw)
    return format_date(params.value, params.pattern)
```

对照着看就很清楚：zod 里这条校验是 `.refine()` 挂在 schema 链上，Pydantic 里是 `@field_validator` 挂在类里；`safeParse` 的活儿由 `model_validate` 加 try/except 承担。行为等价，形态一个偏函数式，一个偏类。

### 3. 300 字周记

模板和第 1 周完全一样，四段，记认知变化不记流水账：最大收获、卡得最久、还含糊、下周前补。第 9 周示例，照这个密度写：

```text
① 本周最大收获：类型不一定是"编译完就擦"的东西。Python 注解运行时还
在，Pydantic 拿它做校验，mypy 拿它做检查，一份模型两头认。TS 里
schema 和类型两张皮，这周体会到一张皮的顺。
② 卡得最久：gather 里混了 time.sleep，三个"并发"任务加起来比串行还
慢。查了才懂事件循环单线程，time.sleep 冻的是整个循环；换 await
asyncio.sleep 或 asyncio.to_thread 才算真并发。
③ 还含糊：__exit__ 返回 True 吞异常的边界场景没吃透；model_validator
和 field_validator 怎么分工还在靠查。
④ 下周前补：把 Day 3 的 async_demo 故意写一版阻塞的错误示例，亲眼看
耗时差异；Settings 的 env_prefix 用起来，别让配置裸奔。
```

### 4. 第 9 周知识自检清单

规则不变：每题先口头回答，说完整了再点开对照。说不出来的记题号，回读对应 Day。

**问题 1：npm 有 node_modules 天生隔离，Python 为什么非要 venv 不可？（Day 1）**

::: details 答案
pip 默认把包装进解释器自己的全局 site-packages，机器上所有项目共享一份，A 要 fastapi 0.110、B 要 0.115 时后装的顶掉先装的。npm 每个项目一个 node_modules，隔离是自带的。venv 就是给项目造一份私有解释器和包目录，把 Python 从"只有全局安装"掰回 npm 的模式。
:::

**问题 2：`Optional[str]` 的新语法是什么？它和默认值是什么关系？（Day 2）**

::: details 答案
新语法是 `str | None`，PEP 604，3.10 起可以直接写，不必再从 typing 导入 Optional，两者完全等价。注意它只对应类型那一半；TS 的 `name?: string` 是"可以为空加缺省"，Python 要写全 `name: str | None = None`，光有类型注解不给默认值，调用时照样必须传。
:::

**问题 3：连续 await 三个协程，和 `asyncio.gather` 包起来 await，差在哪？（Day 3）**

::: details 答案
连续 await 是逐个等完再跑下一个，总耗时约等于三者之和；gather 把协程同时交给事件循环调度，总耗时约等于最慢那个。对应关系是 `Promise.all` 对 `gather`。另外 gather 的结果顺序按传入顺序排，不按完成顺序。
:::

**问题 4：异步函数里要停 2 秒，`time.sleep(2)` 错在哪？（Day 3）**

::: details 答案
协程是单线程协作式调度，time.sleep 会霸着线程不放，整个事件循环连同所有并发任务一起冻结，"并发"直接退化成串行还更慢。要延时用 `await asyncio.sleep(2)`，它把控制权还给循环；实在躲不开的阻塞调用（重计算、同步 IO 库）用 `asyncio.to_thread` 丢进线程。Node 里没有这个坑，因为 setTimeout 生来就是非阻塞的。
:::

**问题 5：Pydantic v2 里字段级和模型级校验器的装饰器分别叫什么？v1 里对应什么？（Day 4）**

::: details 答案
字段级是 `@field_validator`（v1 叫 `@validator`），模型级是 `@model_validator`（v1 叫 `@root_validator`）。v2 的 field_validator 下面要记得叠一个 `@classmethod`，漏了会有告警。
:::

**问题 6：`model_dump()` 是干嘛的？v1 里对应哪个方法？它一家人还有谁？（Day 4）**

::: details 答案
v2 里把模型实例导出成 dict 的方法，v1 对应 `.dict()`。一家人：`model_dump_json()` 出 JSON 字符串，`model_validate(dict)` 从 dict 建模型，`model_validate_json(str)` 从 JSON 字符串建模型。记法：v2 把导出导入全改姓 model_。
:::

**问题 7：`SettingsConfigDict` 里最该配的两个参数是什么，各解决什么问题？（Day 5）**

::: details 答案
`env_file=".env"` 指定从哪个文件读环境变量，本地开发不用手动 export；`env_prefix="APP_"` 给所有变量加统一前缀，避免和系统变量或其他服务的变量撞名（字段 `database_url` 对应读 `APP_DATABASE_URL`）。常再配一个 `extra="ignore"`，容许多余变量，防止环境里有无关变量时直接报错。
:::

**问题 8：写装饰器时 `@functools.wraps(func)` 不加会怎样？（Day 6）**

::: details 答案
包装函数会顶替原函数的 `__name__`、`__doc__`、`__module__` 等元数据，全都变成 wrapper。后果是日志打不出真实函数名、`help()` 和调试器显示错乱、按名字序列化会翻车。wraps 把这些元数据拷贝过来，还顺手标了 `__wrapped__` 指回原函数。写装饰器它是固定搭配，必加。
:::

**问题 9：`__exit__` 的三个参数什么时候非 None？返回 True 和返回 False 各意味着什么？（Day 6）**

::: details 答案
with 块里抛了异常，`__exit__(exc_type, exc_val, exc_tb)` 三个参数就收到异常的类型、值、回溯；正常走完则三个全是 None。返回 True 表示"这个异常我处理了"，异常就地吞掉，with 外面再也看不到；返回 False 或 None，异常继续向外抛。语义类似 catch 里 rethrow 与否：True 是吞，None 是放行。
:::

**问题 10：什么是装饰器的"注册思想"？举一个框架里的例子。（Day 6）**

::: details 答案
装饰器可以不改函数任何行为，只在定义时（import 阶段）把函数登记进一张注册表（dict 或 list），框架启动后遍历注册表统一调度。FastAPI 的 `@app.get('/users')` 把 handler 挂进路由表，请求来了按路径查表调用；Click 的命令组、NestJS 的 provider 注册同一思路。好处是声明处即注册处，业务文件不用碰任何中心化配置。
:::

::: tip 全对也别跳过收口
10 题全对说明本周及格。对照表默写、formatDate 重写、周记、git 收口四件做完，本周才算关账。
:::

## 动手任务：完成本周复盘

按顺序五步，预计 75 到 100 分钟。

**第一步：默写五维对照表（20 分钟）**

合上教程，开 Excalidraw 或一张白纸，按"生态、类型、校验、异步、装饰器"五个区块默写，每块至少五条 X 对 Y。卡住的翻对应 Day 确认后合上继续。画不出对照表，说明本周知识还是散点。

**第二步：重写 formatDate（30 分钟）**

在 agent-service 里建 `app/utils/format_date.py`（函数 + Pydantic 入参模型）和 `tests/test_format_date.py`，至少三个用例：ISO 字符串格式化、自定义 pattern、非法输入原样返回。跑 `poetry run pytest` 和 `poetry run mypy app`，两个都绿。然后把上面五条对比笔记按自己的话重写一遍，这是今天真正的交付物。

**第三步：写 300 字周记（20 分钟）**

四段模板，对照示例密度。第三段"还含糊"别敷衍，它是第 10 周的补课清单。

**第四步：做自检清单（15 分钟）**

10 题逐个口头回答，答不上的记题号回读。回读也是复盘的一部分。

**第五步：git 收口（10 分钟）**

未提交的内容分开提交，然后打 tag：

```bash
git add app/utils/format_date.py tests/
git commit -m "feat(utils): Python 重写 formatDate，含 Pydantic 入参校验"
git add docs/
git commit -m "docs: 第 9 周迁移对照笔记与周记"
git tag week09-done
```

老原则：一个提交只做一件事。

## 常见踩坑

**对照表抄完存起来再不看。** 抄一遍只是识别，默写一遍才是提取。检验标准就一条：合上所有资料，五维各写五条，写不全的才是你本周真正的漏洞。

**只记对应不记差异。** `Record` 对 `dict` 这种对应不会害你，害你的是"长得像行为反"的点：fromtimestamp 吃秒、time.sleep 冻循环、safeParse 没有等价物。对照表里标星号的应该是差异列，不是对应列。

**重写成逐行翻译。** 把 TS 版的 pad、token 表、正则替换用 Python 语法原样再做一遍，代码行数没少，还把 strftime 晾在一边。迁移的目的不是翻译代码，是换一种方式想问题：同一件事，Python 世界的惯用法是什么。

**周记只夸不惭。** 全写收获，"还含糊"一笔带过，等于把下周的输入掐了。第 1 周就说过的：这段最值钱，写不出多半是在回避。

## 延伸阅读

- [第 1 周教程](/week01/)：formatDate 的 TS 原版在 Day 6，复盘四件套的原始模板在 Day 7
- [第 9 周日程](/week09/)：对照表哪一行默不出来，就回读哪一天
- [datetime 与 strftime 官方文档](https://docs.python.org/3/library/datetime.html#strftime-and-strptime-format-codes)：占位符速查，%f 微秒、%z 时区偏移都在这张表上
- [Pydantic v2 迁移指南](https://docs.pydantic.dev/latest/migration/)：v1 老写法对 v2 新写法的官方对照，查 `.dict()` 改名这类问题最方便

下周开始前，把周记第四段留的两个补课动作清掉。第 9 周到此收口。
