# 第 9 周 · Day 2：Python 类型注解——把 TypeScript 的类型直觉搬过来

> 对应手册任务：学习「Python 类型注解：Optional/Union/List/Dict/Literal」，动手写一个带类型注解的数据处理函数，用 mypy 检查，当日产出「类型注解通过」。本篇只解决一个问题：你的类型思维在[第 1 周](/week01/)已经练出来了，现在要把它翻译成 Python 语法，再配一个真的会报错的检查器，让动态语言写出静态的安全感。

## 今日目标

1. 说得清 Python 注解和 TS 类型的根本差异：注解只是提示，运行时不检查，mypy 才是裁判
2. 掌握五组语法迁移：基础类型与容器对照、`Optional` 与 `| None`、`Union` 与 `|`、`Literal`、函数签名与 `TypeVar`
3. 独立完成订单清洗函数 `clean_orders`，mypy 零报错，并亲眼看它抓住一次故意的类型错误

## 概念讲解：为什么动态类型撑不起 Agent 服务

先看一段没加注解的 Python，这是这门语言的默认状态：

```python
def clean_orders(orders, min_amount):
    paid = [o for o in orders if o.status == "paid" and o.amount >= min_amount]
    return {"count": len(paid), "total": sum(o.amount for o in paid)}
```

`orders` 里装的是什么？没人知道。IDE 猜不出 `o` 有哪些属性，补全全靠运气；调用方传个字符串列表进来，要等循环跑起来抛 `AttributeError` 才知道错。你想把 `amount` 改名，编辑器不敢全局替换，因为它分不清哪个 `.amount` 是订单的。Agent 服务天天要处理 LLM 吐出来的 JSON、配置、消息结构，这种裸奔状态写三百行就要出事。

这些问题你在 TS 里解决过：给参数和返回值标上类型，编辑器立刻活过来，错误在编译期就被拦下。Python 的答案分两半，这是和 TS 最大的心智差异。

**注解只是提示，它自己不检查。** 看这个例子：

```python
def add(a: int, b: int) -> int:
    return a + b

print(add("1", "2"))  # 正常运行，输出 "12"，一个错都不报
```

参数明明标了 `int`，传字符串照样跑，还给你拼起来了。注解写错也无所谓，`-> int` 的函数返回字符串，运行时毫无怨言。TS 的类型在 tsc 那里至少编译期要过一遍，检查完才擦除（[第 1 周](/week01/)坑 3 讲过）；Python 的注解更弱，它只是存进函数 `__annotations__` 里的一段元数据，解释器看都不看一眼。

所以完整的公式是：**类型安全的 Python = 类型注解（提供信息）+ mypy（执行检查）**。注解负责描述，mypy 负责较真，两个都到位，你才拿回 TS 那套体验：编辑器补全、提交前拦错、重构有底气。今天先把概念全部迁移过去，再花二十分钟把检查器配起来。

## 核心知识

本节的代码块都是独立示例，可以直接贴进[昨天](/week09/)建好的 agent-service 项目里跑。最终完整文件以下面的动手任务为准。

### 1. 语法对照：五分钟建立映射

你不需要重新学类型系统，只需要换一套拼写。对照表：

| 含义 | TypeScript | Python（3.10+） |
| --- | --- | --- |
| 数字 | `number` | `int` / `float`（不合并） |
| 字符串 | `string` | `str` |
| 布尔 | `boolean` | `bool` |
| 数组 | `string[]` | `list[str]` |
| 映射 | `Record<string, number>` | `dict[str, int]` |
| 元组 | `[number, string]` | `tuple[int, str]` |
| 联合 | `string \| number` | `str \| number` |
| 可空 | `string \| undefined` | `str \| None` |
| 字面量 | `'paid' \| 'pending'` | `Literal["paid", "pending"]` |
| 任意值 | `any` | `Any` |
| 泛型参数 | `<T>` | `TypeVar("T")` |
| 对象形状 | `interface` | `TypedDict` / `dataclass` |

容器统一用小写泛型：`list[int]`、`dict[str, int]`、`tuple[int, str]`，尖括号换成方括号，意义不变。Python 3.9 之前要写 `List[int]`（从 `typing` 模块导入），现在内置类型直接支持泛型，新代码一律小写。

函数签名长这样，参数用冒号标类型，返回值用 `->`：

```python
def repeat(text: str, times: int = 1) -> str:
    return text * times

print(repeat("ab", 2))  # abab
```

`times: int = 1` 一行同时写了类型和默认值，对应 TS 的 `times: number = 1`。没有花括号帮忙分组，全靠冒号和箭头分界。

还有一个结构差异要记牢：TS 的 `number` 一统江湖，Python 分 `int` 和 `float`，`1` 和 `1.0` 是两种类型的值。好在 mypy 遵循数字塔，允许把 `int` 传给 `float` 参数，反过来不行。习惯写法：数量用 `int`，金额用 `float`，别想着学 TS 全写一个 `number` 糊弄过去。

### 2. Optional、Union 与 `|`：联合类型的三代写法

TS 里最常用的 `Order | undefined`，Python 对应 `Order | None`。`None` 就是 Python 的空值，出现在联合类型里时永远显式写出来：

```python
from dataclasses import dataclass

@dataclass
class Order:
    order_id: str
    amount: float
    status: str

def find_order(orders: list[Order], order_id: str) -> Order | None:
    for o in orders:
        if o.order_id == order_id:
            return o
    return None
```

返回值 `Order | None` 的含义和 TS 完全一致：可能找不到，调用方必须先判空再用。拿 `Order | None` 直接当 `Order` 使，mypy 立刻报错，和 tsc 一个脾气。

判空没有 `?.` 可选链，用 `is None` 显式判断：

```python
order = find_order([], "A-001")
if order is not None:
    print(order.amount)  # 这个分支里 order 已被收窄为 Order
```

这个 `if order is not None` 就是 Python 版的类型收窄，对应 TS 的 `if (order !== undefined)`，mypy 在分支内自动缩小类型。

但你会在老代码和大量教程里看到另外两种写法：

```python
from typing import Optional, Union

def find_order(orders: list[Order], order_id: str) -> Optional[Order]: ...
def parse_id(raw: str) -> Union[int, str]: ...
```

`Optional[Order]` 等价于 `Order | None`，`Union[int, str]` 等价于 `int | str`，三种写法最终是同一个东西。历史顺序：`Union` 和 `Optional` 先出生，Python 3.10 的 PEP 604 引入 `|` 运算符，联合类型从此有了原生语法。新代码一律写 `|`，更短，也更贴近你的 TS 手感；老写法必须认识，存量代码和不少第三方库还在用。

### 3. Literal、TypedDict、TypeVar：三个高频配角

**Literal 限定字面量。** 状态字段只可能是几个固定字符串时，`str` 太宽，`Literal` 精确：

```python
from typing import Literal

Status = Literal["paid", "pending", "refunded"]

def set_status(order_id: str, status: Status) -> None: ...

set_status("A-001", "paid")
# set_status("A-001", "payd")
# error: Argument 2 to "set_status" has incompatible type "Literal['payd']";
#        expected "Literal['paid', 'pending', 'refunded']"  [arg-type]
```

拼写错误在检查期就被拦下，这正是 TS 里 `'paid' | 'pending'` 的用法。`Status = Literal[...]` 这行是类型别名，对应 `type Status = ...`。

**TypedDict 和 dataclass 一句话分工。** `TypedDict` 描述一个字典的键值形状，贴在 JSON 边界上用，对应 TS 的 `interface`；`dataclass` 是真类，自动生成 `__init__`，有默认值有方法，适合业务内部的结构体。两个都只管静态检查，不做运行时校验，校验这块等本周 Day 4 的 Pydantic 主角登场。

**TypeVar 是 Python 的 `<T>`。** 第 1 周写的泛型函数，翻译过来是这样：

```python
from typing import TypeVar

T = TypeVar("T")

def get_first(items: list[T]) -> T | None:
    return items[0] if items else None

first_name = get_first(["Jerry", "Tom"])   # T 推断为 str
first_amount = get_first([199.0, 899.0])   # T 推断为 float
```

`T = TypeVar("T")` 先声明类型变量，参数 `list[T]` 和返回值 `T` 用的是同一个 T，进什么类型出什么类型，这条链路由 mypy 保证，和 `getFirst<T>` 一模一样。Python 3.12 起还有更省事的语法，连 TypeVar 都不用声明：`def get_first[T](items: list[T]) -> T | None:`。新项目直接用 3.12 语法，老代码要认得 TypeVar。

## 动手任务：清洗订单列表 一步一步

手册任务：写一个带类型注解的数据处理函数，用 mypy 检查。场景定为清洗订单列表：过滤掉未支付和小额订单，聚合计数与总额，返回结构化结果。拆成 5 步，全程约 20 分钟。

**第 1 步：装 mypy，建文件。** 在昨天用 poetry 建好的 agent-service 项目根目录执行：

```bash
poetry add --group dev mypy
```

然后在项目里新建 `process_orders.py`。下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：定义数据结构。** 用 dataclass 建订单和统计结果两个类，状态字段用 Literal 收紧：

```python
from dataclasses import dataclass, field
from typing import Literal

Status = Literal["paid", "pending", "refunded"]


@dataclass
class Order:
    order_id: str
    amount: float
    status: Status


@dataclass
class OrderSummary:
    total_count: int
    total_amount: float
    order_ids: list[str] = field(default_factory=list)
```

`@dataclass` 装饰器替你生成 `__init__`，字段声明长得像 interface，但它是能实例化的真类。`field(default_factory=list)` 是「可变默认值」的安全写法，为什么不能直接 `= []`，踩坑一节细说。

**第 3 步：写清洗函数。** 过滤加聚合，签名把类型说全：

```python
def clean_orders(orders: list[Order], min_amount: float = 0.0) -> OrderSummary:
    """过滤掉未支付和低于阈值的订单，统计数量与总额。"""
    paid = [o for o in orders if o.status == "paid" and o.amount >= min_amount]
    return OrderSummary(
        total_count=len(paid),
        total_amount=round(sum(o.amount for o in paid), 2),
        order_ids=[o.order_id for o in paid],
    )
```

签名一行信息量很大：参数是 `list[Order]`，阈值是带默认值的 `float`，返回 `OrderSummary`。函数体内的 `o.status == "paid"`，mypy 能借着 Literal 类型确认比较合法；你要是手滑写成 `o.state`，检查立刻报错。

文件末尾加一段调用，验证能跑：

```python
if __name__ == "__main__":
    raw_orders = [
        Order("A-001", 199.0, "paid"),
        Order("A-002", 59.9, "pending"),    # 未支付，过滤
        Order("A-003", 25.0, "paid"),       # 低于 50，过滤
        Order("A-004", 899.0, "refunded"),  # 已退款，过滤
        Order("A-005", 120.0, "paid"),
    ]

    summary = clean_orders(raw_orders, min_amount=50.0)
    print(f"共 {summary.total_count} 单，合计 {summary.total_amount} 元")
    print(f"订单号：{summary.order_ids}")
```

`poetry run python process_orders.py`，输出「共 2 单，合计 319.0 元」。注意这一步只证明程序能跑，类型对不对，还得上检查器。

**第 4 步：跑 mypy，看它抓现行。** 先正常检查一遍：

```bash
poetry run mypy process_orders.py
# Success: no issues found in 1 source file
```

然后故意传错。在文件末尾加一行（保持注释状态，想看报错就取消注释）：

```python
# bad = clean_orders(["A-001"], min_amount=10)
# error: Argument 1 to "clean_orders" has incompatible type "list[str]";
#        expected "list[Order]"  [arg-type]
```

取消注释再跑 mypy，红字立刻出现。有意思的是，此刻 `poetry run python process_orders.py` 依旧能启动，直到循环里访问 `o.status` 才炸。注解不拦运行，mypy 不放过静态，两件事对照着看，「检查器」的价值就清楚了。看完把错误行重新注释掉，保持零报错。

**第 5 步：配渐进策略，别一步登天。** mypy 默认档很宽松，没写注解的函数会整个跳过。在 pyproject.toml 里加一段，先要求「写了注解的必须对，没写的也检查函数体」：

```toml
[tool.mypy]
check_untyped_defs = true
warn_return_any = true
```

以后想更严，逐个模块开 strict：

```toml
[[tool.mypy.overrides]]
module = "agent_service.*"
disallow_untyped_defs = true
```

策略是渐进的：今天先让默认档零报错，本周内把 strict 一块一块打开。老项目一次性全 strict，报错几百条，谁都会弃疗。

::: tip 命令汇总
装工具 `poetry add --group dev mypy`；检查单个文件 `poetry run mypy process_orders.py`；检查整个项目 `poetry run mypy .`。配置放在 pyproject.toml 的 `[tool.mypy]` 段，改完即生效，下次运行自动读取。
:::

## 常见踩坑

**坑 1：以为加了注解就有了类型检查。** 这是从 TS 过来最容易栽的认知坑。TS 的检查和编译是一体的，`tsc` 不过，编译不过；Python 的注解只是元数据，解释器不看不查。团队里有人不装 mypy，你写的注解对他来说就是注释。记住分工：注解提供信息，mypy 执行检查，IDE 顺带拿注解做补全。少了检查器这一环，体验原样退回动态语言。

**坑 2：可变默认值，TS 里没有的坑。** TS 的默认参数每次调用重新求值，Python 的默认值只在函数定义时求值一次，所有调用共享：

```python
def collect(order: Order, bucket: list[Order] = []) -> list[Order]:
    bucket.append(order)
    return bucket
# 两次调用共享同一个 bucket，数据悄悄串了
```

mypy 默认不拦这个（flake8-bugbear 的 B006 规则会拦）。标准写法是 `None` 哨兵：

```python
def collect(order: Order, bucket: list[Order] | None = None) -> list[Order]:
    bucket = bucket if bucket is not None else []
    bucket.append(order)
    return bucket
```

**坑 3：把 `Optional` 当成「参数可以不传」。** `def f(x: int | None)` 只表示 x 可以是 None，不表示 x 可以省略，省略要靠默认值：`x: int | None = None`。这两个概念在 TS 里也是分开的（`x?: number` 和 `x: number | undefined` 不是一回事），平移时别合二为一。

**坑 4：新旧语法混着写。** 老代码里 `List[int]`、`Dict[str, int]`、`Optional[Order]`、`Union[int, str]` 满天飞，它们和 `list[int]`、`dict[str, int]`、`Order | None`、`int | str` 完全等价，只是出生年代不同。规则很简单：自己写新代码，一律用小写内置泛型和 `|` 运算符；读老代码，认得出就行。同一个文件里别混用，看的人难受。

**坑 5：全项目一步 `--strict`，当天弃疗。** strict 打开的检查项有几十个，老项目第一次跑能报三位数错误。渐进路线：第一步默认档跑通；第二步加 `check_untyped_defs = true`，让没注解的函数体也被检查；第三步新模块先 strict，用 overrides 圈出来；最后老模块逐个迁移。类型检查是给新代码上保险的，不是一次性替老代码还债的，今天只要求第一步。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `add("1", "2")` 在注解了 `int` 的情况下为什么能正常运行？注解到底在什么时候起作用？

::: details 参考答案
解释器不检查注解，它只是把注解存进 `__annotations__`，运行时照常按动态类型执行，所以 `"1" + "2"` 得到 `"12"`。注解起作用的时刻有三种：mypy 或 pyright 静态检查时报错、IDE 靠它补全和提示、以及支持它的库（比如后面的 Pydantic）读取它做运行时校验。
:::

2. `Optional[int]`、`Union[int, None]`、`int | None` 是什么关系？新代码写哪个？

::: details 参考答案
三者完全等价，都是「int 或者 None」。`Optional` 只是 `Union[X, None]` 的简写，`|` 是 Python 3.10 引入的原生联合类型语法（PEP 604）。新代码一律写 `int | None`，更短也更接近 TS 手感；前两种在存量代码里大量存在，要看得懂。
:::

3. 状态字段用 `str` 还是 `Literal["paid", "pending"]`？差别体现在哪？

::: details 参考答案
取值只有固定几种就用 Literal。差别在检查强度：`str` 接受任意字符串，状态值拼错要等运行时才出问题；Literal 把合法值收成几个字面量，`"payd"` 这种拼写错误在 mypy 阶段就被拦下，对应 TS 的 `'paid' | 'pending'`。
:::

4. `TypedDict` 和 `dataclass` 分别适合什么场景？运行时校验谁来管？

::: details 参考答案
`TypedDict` 描述字典的键和值类型，适合贴在 JSON 边界、不想转成类的场景，对应 TS 的 interface；`dataclass` 是真类，自动生成 `__init__`，支持默认值和方法，适合业务内部的结构体。两者都只做静态检查，不做运行时校验，校验这块由本周 Day 4 的 Pydantic BaseModel 补上。
:::

5. TS 的 `getFirst<T>(list: T[]): T | undefined` 翻译成 Python 长什么样？

::: details 参考答案
老写法先 `T = TypeVar("T")`，再 `def get_first(items: list[T]) -> T | None`；Python 3.12 起可以直接写 `def get_first[T](items: list[T]) -> T | None`，类型参数挪进了函数名后面的方括号。调用时同样支持推断，传 `["a", "b"]` 进去，T 就是 str。
:::

## 延伸阅读

- [Python 官方 typing 文档](https://docs.python.org/3/library/typing.html)，所有注解类型的原始出处，当字典查
- [mypy 官方文档](https://mypy.readthedocs.io/)，命令行选项和 strict 各项检查的说明都在这里，配置 pyproject 前值得通读 command line 一节
- [PEP 604](https://peps.python.org/pep-0604/)，`X | Y` 联合类型语法的提案原文，短短几页，看完你就明白 `Optional` 为什么可以被取代

今天的产出 `process_orders.py` 留好，`Order` 这个 dataclass 到本周 Day 4 会被换成 Pydantic 的 BaseModel，到时候你会看到同一份注解怎么长出运行时校验的能力。
