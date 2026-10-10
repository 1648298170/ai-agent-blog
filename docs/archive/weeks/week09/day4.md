# 第 9 周 · Day 4：Pydantic v2 基础——让类型注解在运行时站岗

> 对应手册任务：学习「Pydantic v2 基础：BaseModel、Field、校验」，动手定义一个 `UserCreate` 模型，含 email 格式和年龄范围校验，当日产出 `user_model.py`。本篇只解决一个问题：类型注解只对静态检查器负责，数据真正进来的那一刻没人把关，Pydantic 把你昨天写的注解变成运行时的关卡，脏数据进不来，错误信息还自动生成。

## 今日目标

1. 说得清 Pydantic 解决什么问题，以及它和原生类型注解、和第 3 周用过的 zod 分别是什么关系
2. 掌握四个用法：`BaseModel` 定义模型、`Field` 加约束、`@field_validator` 与 `@model_validator` 写自定义校验、`model_dump` 系列做序列化
3. 独立完成 `UserCreate`，让非法 email 和越界年龄在校验时被拦下，并亲手解析一次 `ValidationError`

## 概念讲解：为什么需要 Pydantic

昨天写过这样的函数：

```python
def create_user(name: str, age: int) -> dict:
    return {"name": name, "age": age}
```

注解写得很规矩，mypy 也挑不出毛病。但注解只是「提示」，解释器根本不看它。下面几行全部正常运行，一声不吭：

```python
create_user(123, "18")          # name 传了 int，age 传了 str
create_user(None, None)         # 两个 None
create_user([1, 2], {"a": 1})   # 列表和字典也照单全收
```

代码里手写的字面量，静态检查器还能帮你盯着；可真正的脏数据不来自你的代码，来自外面：HTTP 请求体、LLM 吐出的 JSON、配置文件、第三方接口。这些数据到达的时刻是运行时，而类型注解在运行时等于不存在。于是你只好手写一堆防御：

```python
if not isinstance(age, int):
    raise ValueError("age 必须是整数")
if age <= 0 or age > 150:
    raise ValueError("age 超出范围")
if "@" not in email:
    raise ValueError("email 格式不对")
```

每个接口写一遍，每个字段写一遍，报错信息自己攒，漏一个分支就是一个线上 bug。

Pydantic 做的事一句话说完：类型注解 + 运行时校验 + 自动报错，三位一体。你反正要写 `age: int`（昨天已经会了），Pydantic 顺手把这条注解变成校验规则：数据合法就放行并完成类型转换，不合法就抛出带完整定位的 `ValidationError`。注解写一遍，校验规则就有了，报错信息也有了。

如果你第 3 周在 TypeScript 里用过 zod，这套思想应该很眼熟。两边概念几乎一一对应：

| 你想要的能力 | zod（TS） | Pydantic（Python） |
| --- | --- | --- |
| 定义 schema | `z.object({...})` | 继承 `BaseModel` |
| 字符串约束 | `z.string().min(2).max(20)` | `Field(min_length=2, max_length=20)` |
| 数值范围 | `z.number().min(1).max(150)` | `Field(gt=0, le=150)` |
| 邮箱格式 | `z.string().email()` | `EmailStr` |
| 解析数据 | `schema.safeParse(data)` | `Model.model_validate(data)` |
| 错误列表 | `result.error.issues` | `e.errors()` |

学 zod 时建立的「先定义 schema，再拿 schema 解析数据」这套肌肉记忆，直接搬到今天用。区别只在形态：zod 的 schema 是一个运行时对象，Pydantic 的 schema 是一个类，字段就写在类属性上。

## 核心知识

本节的代码块都是独立示例，存成 `.py` 文件用 `python` 跑一遍对照着看。最终完整文件以下面的动手任务为准。先装环境：`pip install pydantic`，再用 `python -c "import pydantic; print(pydantic.VERSION)"` 确认是 2.x，本篇所有 API 以 v2 为准。

### 1. BaseModel：字段即属性

```python
from pydantic import BaseModel

class User(BaseModel):
    id: int
    name: str
    is_active: bool = True  # 带默认值的字段

user = User(id=1, name="Jerry")
print(user.id, user.name, user.is_active)  # 1 Jerry True
```

写法和昨天的类型注解一脉相承：类属性 + 注解。差别是这些注解被 Pydantic 读走了，拿去干三件事：确定字段清单、生成 `__init__`、在实例化时逐字段做校验和类型转换。比如 `User(id="1", name="Jerry")` 不报错，`id` 会被自动转成 `int` 1——这个行为叫 lax 模式，第 5 小节细说。

字段访问就是普通属性访问，IDE 补全和静态检查都认，没有 `data["name"]` 这种字符串取值。这就是「Pydantic 模型」四个字的含义：一个带运行时校验的数据类。

### 2. Field：给字段加约束

```python
from pydantic import BaseModel, Field

class Profile(BaseModel):
    name: str = Field(min_length=2, max_length=20)
    age: int = Field(gt=0, le=150)
    nickname: str = Field(default="匿名", max_length=12)

p = Profile(name="Jerry", age=30)
print(p.nickname)  # 匿名
```

`Field` 的常用参数分三组：数值约束 `gt`（大于）、`ge`（大于等于）、`lt`、`le`；字符串与集合约束 `min_length`、`max_length`；元信息 `default`、`description`。约束写在字段定义处，一眼看清这个字段合法长什么样，不用翻校验代码。校验失败时的报错也是自动的：`age=200` 会得到一条 `Input should be less than or equal to 150`。

### 3. 校验器：@field_validator 与 @model_validator

内置约束不够用时写校验器。单字段逻辑用 `@field_validator`，跨字段逻辑用 `@model_validator`：

```python
from pydantic import BaseModel, field_validator, model_validator

class Account(BaseModel):
    username: str
    password: str
    confirm: str

    @field_validator("username")
    @classmethod
    def clean_username(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("用户名不能是空白")
        return v

    @model_validator(mode="after")
    def passwords_match(self) -> "Account":
        if self.password != self.confirm:
            raise ValueError("两次密码不一致")
        return self
```

两个要点。第一，`@field_validator` 里面套一层 `@classmethod`，第一个参数是 `cls`，被校验的值是第二个参数（习惯命名 `v`）。校验器同时是「转换器」：`return` 什么，字段最终就是什么，所以它既能校验也能归一化（比如 strip）。第二，`@model_validator(mode="after")` 拿到的是校验完的 `self`，所有字段已经就位，适合做跨字段检查，记得 `return self`。

**重点提醒：网上教程一大半还是 v1 语法。** 老代码里的 `@validator("username")`、`@root_validator` 就是 v1 写法，v2 里已弃用，见到这俩词先确认教程版本再照抄。v2 的对应物就是上面的 `@field_validator` 和 `@model_validator`。

### 4. ValidationError：结构化错误

```python
from pydantic import BaseModel, ValidationError

class Item(BaseModel):
    name: str
    qty: int

try:
    Item(name=123, qty="abc")
except ValidationError as e:
    print(e.error_count())  # 2
    for err in e.errors():
        print(err["loc"], err["type"])
    # ('name',) string_type
    # ('qty',) int_parsing
```

`e.errors()` 返回一个列表，每条错误三个关键字段：`loc` 是定位路径，元组形式，顶层字段是一元组 `('name',)`，嵌套对象的字段是 `('user', 'name')`，列表元素是 `('items', 0, 'price')`，索引也会进路径；`msg` 是给人看的错误描述；`type` 是机器可读的错误码，比如 `string_type`、`int_parsing`，写程序化分支拿它判断，比解析 msg 文本可靠。直接打印 `e` 本身则是一段排版好的多行报告，扔进日志很合适。

### 5. 序列化：model_dump 系列

模型不是终点，数据还要进出。v2 把方向分得很清楚：

```python
from pydantic import BaseModel

class User(BaseModel):
    id: int
    name: str

user = User(id=1, name="Jerry")

user.model_dump()            # {'id': 1, 'name': 'Jerry'}，出去成 dict
user.model_dump_json()       # '{"id":1,"name":"Jerry"}'，出去成 JSON 字符串

User.model_validate({"id": "1", "name": "Jerry"})       # dict 进来成模型
User.model_validate_json('{"id": 1, "name": "Jerry"}')  # JSON 字符串直接进来
```

方向一对：`model_dump` / `model_dump_json` 是模型出去，`model_validate` / `model_validate_json` 是数据进来。`model_validate_json` 不是「`json.loads` 再 `model_validate`」的语法糖，它底层用 Rust 直接解析，更快，网络报文本来就是 JSON 字符串时优先用它。

再记一张 v1 对照表，专门用来认老教程：`.dict()` 对应 `model_dump()`，`.json()` 对应 `model_dump_json()`，`.parse_obj()` 对应 `model_validate()`，`.parse_raw()` 对应 `model_validate_json()`。看到 `.parse_obj` 就知道这篇是 v1 时代的文章。

### 6. lax 与 strict：`"18"` 该不该变成 18

Pydantic 默认是 lax（宽松）模式：类型不完全匹配但能安全转换的数据，自动转。最典型的是字符串数字：

```python
from pydantic import BaseModel

class Form(BaseModel):
    age: int

print(Form(age="18").age)   # 18，str 被转成 int
print(Form(age=18.0).age)   # 18，无小数部分的 float 也收
```

为什么默认宽松？Web 表单和 URL 参数传上来的值全是字符串，宽松模式让后端少写一遍手工转换。代价是可能有脏数据蒙混过关：本来该是用户手输的数字，结果是前端 bug 拼进来的字符串，也被悄悄转好了。

想收紧就开 strict：`Field(strict=True)` 单字段生效，或 `model_config = ConfigDict(strict=True)` 整个模型生效。strict 下 `"18"` 直接报错，必须是货真价实的 int。经验法则：边界数据（外部 API、webhook、LLM 输出）倾向宽松加显式校验器，内部服务之间倾向严格。FastAPI 默认走宽松路线，这个话题下周展开。

## 动手任务：`UserCreate` 一步一步

手册任务：定义 `UserCreate` 模型，含 email 格式和年龄范围校验。拆成 5 步，全程约 20 分钟。

**第 1 步：装环境，建文件。** 执行 `pip install "pydantic[email]"`——方括号里的 extra 会连着装上 `email-validator`，这是 `EmailStr` 的依赖，不装的话一用就报错。然后在练习目录新建 `user_model.py`，下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：定义模型骨架。** 按「用户注册」的语义摆字段，能交给内置约束的先交给内置：

```python
from pydantic import BaseModel, EmailStr, Field

class UserCreate(BaseModel):
    name: str = Field(min_length=2, max_length=20)
    email: EmailStr
    age: int = Field(gt=0, le=150)
    is_admin: bool = False
```

四行字段，四类约束各占一行：长度约束、邮箱格式、数值范围、默认值。`EmailStr` 只认合法邮箱，`"jerry"` 这种会在校验时报 `value is not a valid email address` 系列错误。写到这里，手册要求的「email 格式 + 年龄范围」其实已经完成，但真实模型从来不止内置约束能覆盖的这点事，继续。

**第 3 步：加自定义校验。** name 去首尾空格并拒绝纯空白，是单字段逻辑，用 `@field_validator`；未成年人不能开管理员，是跨字段逻辑，用 `@model_validator`：

```python
from pydantic import field_validator, model_validator

class UserCreate(BaseModel):
    # ...第 2 步的字段原样保留...

    @field_validator("name")
    @classmethod
    def clean_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("姓名不能是空白")
        return v

    @model_validator(mode="after")
    def admin_needs_adult(self) -> "UserCreate":
        if self.is_admin and self.age < 18:
            raise ValueError("未成年人不能设为管理员")
        return self
```

两个校验器的返回值都不能省：`clean_name` 返回的是 strip 之后的值，顺手完成归一化；`admin_needs_adult` 必须 `return self`。

**第 4 步：合法数据全流程走一遍。** 文件末尾加上：

```python
if __name__ == "__main__":
    ok = UserCreate(name="  Jerry  ", email="jerry@example.com", age=30)
    print(ok.name)              # Jerry，校验器把空格吃掉了
    print(ok.model_dump())      # {'name': 'Jerry', 'email': 'jerry@example.com', 'age': 30, 'is_admin': False}
    print(ok.model_dump_json()) # 一行 JSON 字符串
```

`name` 传进去时两边带空格，拿回来的是干净的 `Jerry`，这就是「校验器即转换器」。

**第 5 步：故意传坏数据，读错误。** 再加两段，先看字段级错误：

```python
    from pydantic import ValidationError

    try:
        UserCreate(name="J", email="not-an-email", age=200)
    except ValidationError as e:
        for err in e.errors():
            print(err["loc"], "->", err["type"])
        # ('name',) -> string_too_short
        # ('email',) -> value_error
        # ('age',) -> less_than_equal
```

三条字段错误一次性全列出来，谁错、错在哪、什么类型，互不遮挡。注意此时 `admin_needs_adult` 没有执行：字段校验有失败时，`mode="after"` 的模型校验器直接跳过，它假设字段先合法。再看跨字段那条：

```python
    try:
        UserCreate(name="Jerry", email="jerry@example.com", age=15, is_admin=True)
    except ValidationError as e:
        print(e.errors()[0]["loc"])   # ()，模型级错误的定位是空元组
```

字段全部合法，模型级校验器拦下了「15 岁管理员」。它的 `loc` 是空元组 `()`，因为它不属于任何单个字段。

::: tip 运行命令
在文件所在目录执行 `python user_model.py`。pydantic 是 FastAPI 的直接依赖，下周装 FastAPI 时会自动带上，今天单独装是为了先把注意力放在模型本身。运行时报 `email-validator is not installed`，就回第 1 步补装。
:::

## 常见踩坑

**坑 1：照着 v1 教程抄代码。** 判断教程版本看三个特征：出现 `@validator` / `@root_validator`，出现 `.dict()` / `.parse_obj()`，模型里定义 `class Config:` 类——占一个就是 v1 教程。v2 对应写法：`@field_validator` / `@model_validator`、`model_dump()` / `model_validate()`、`model_config = ConfigDict(...)`。搜中文教程尤其要留神，v1 时代的文章存量很大。

**坑 2：EmailStr 一用就崩。** 报 `ImportError: email-validator is not installed` 不是 pydantic 坏了，是缺可选依赖。`pip install "pydantic[email]"` 一次装齐。方括号要加引号，防止被 shell 当成通配符处理。

**坑 3：lax 模式替你「修」数据，你以为校验过了。** `Form(age="18")` 通过且 age 变成 18。多数时候这是方便（表单来的全是字符串），但它意味着字符串形态的数字永远不会被拦。想区分「类型本来就不对」和「格式能转」，前者要拦就开 `strict=True`，后者交给校验器处理。

**坑 4：校验器忘了 return。** 校验器不是纯检查函数，它的返回值就是字段的新值。忘了 return，字段值变成 `None`，接着被「字段不能是 None」这条规则拦下，报错指向的方向和真正的 bug 完全不搭，越查越懵。写校验器的肌肉记忆：参数收 `v`，结尾必 `return`。

**坑 5：可变默认值这次不用怕。** 写普通 Python 函数时 `def f(items=[])` 是著名大坑，列表被所有调用共享。Pydantic 里标准写法是 `Field(default_factory=list)`，而且直接写 `tags: list[str] = []` 也不会共享——Pydantic 对默认值做深拷贝，每个实例各拿各的。这大概是 Python 里少数几个「可变默认值无害」的地方，但团队协作时还是建议用 `default_factory`，看的人不心虚。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `age: int` 的注解已经写了，Pydantic 还解决什么？

::: details 参考答案
注解只对静态检查器负责，运行时解释器不看它，外部数据（请求体、LLM 输出、配置文件）进来时没有任何检查。Pydantic 把注解变成运行时校验规则：类型转换、约束检查、结构化报错一次完成，替代手写的 isinstance / if / raise 样板。
:::

2. lax 和 strict 的区别是什么？`"18"` 在两种模式下各发生什么？

::: details 参考答案
lax（默认）允许能安全转换的类型自动转，`"18"` 变成 int 18；strict 只接受类型本就正确的值，`"18"` 直接抛 `ValidationError`。web 表单全是字符串，适合 lax；内部接口想严格把关，用 `Field(strict=True)` 或 `ConfigDict(strict=True)`。
:::

3. 怎么一眼判断一篇 Pydantic 教程是 v1 还是 v2？

::: details 参考答案
看三个特征：校验器写法（`@validator` / `@root_validator` 是 v1，`@field_validator` / `@model_validator` 是 v2）；序列化方法（`.dict()` / `.parse_obj()` 是 v1，`model_dump()` / `model_validate()` 是 v2）；配置写法（`class Config:` 是 v1，`model_config = ConfigDict(...)` 是 v2）。
:::

4. `ValidationError.errors()` 的每条错误里，`loc`、`msg`、`type` 分别是什么？嵌套字段报错时 `loc` 长什么样？

::: details 参考答案
`loc` 是定位路径（元组），顶层字段是 `('age',)`，嵌套对象的字段是 `('user', 'name')`，列表元素是 `('items', 0, 'price')`，模型级校验器的错误是空元组 `()`；`msg` 是给人读的描述；`type` 是机器可读的错误码（如 `string_type`），写程序化分支用 `type`，不要去解析 `msg` 文本。
:::

5. `@field_validator` 和 `@model_validator` 各适合什么场景？`mode="after"` 是什么意思？

::: details 参考答案
单字段的检查和归一化用 `@field_validator`，它拿到该字段的值，返回值就是字段新值；跨字段的检查用 `@model_validator`。`mode="after"` 表示在所有字段校验完成之后运行，拿到的是 `self`，字段都已合法——所以任何字段校验失败时它不会执行。`mode="before"` 则在字段校验前拿到原始输入，适合做预处理。
:::

## 延伸阅读

- [Pydantic v2 官方文档：Models](https://docs.pydantic.dev/latest/concepts/models/)，BaseModel、序列化、strict 模式的原始出处，概念页值得通读
- [Pydantic v2 官方文档：Validators](https://docs.pydantic.dev/latest/concepts/validators/)，两种校验器的全部用法，包括 `mode="before"` 和 `Annotated` 写法
- [zod 文档](https://zod.dev/)，回头翻一眼第 3 周用过的 zod，对照今天的映射表，两边思想完全同构

今天的产出 `user_model.py` 留好。下周 FastAPI 的请求体、之后 LangGraph 的状态定义，主角都是今天这个 `BaseModel`。
