# 第 9 周 · Day 6：Python 装饰器与上下文管理器——把「前后都要做的事」交给语法

> 对应手册任务：学习「Python 装饰器 + 上下文管理器」，动手写一个计时装饰器和一个数据库连接上下文管理器，当日产出「两个工具」。本篇只解决一个问题：计时、开关连接这类「把正事前后夹住」的代码，不该手写进每个函数，而是收进一个 `@` 和一个 `with`，让语法本身保证它执行。这是本周最后一个学习日，这两个机制是 Python 生态的通用语法，后面 FastAPI 的路由注册、LangGraph 的工具定义，底层全是它们。

## 今日目标

1. 说得清装饰器的本质是高阶函数，`@` 只是 `f = deco(f)` 的语法糖，以及它和 NestJS 装饰器的实现差别
2. 掌握四个语法点：`functools.wraps`、带参装饰器的三层嵌套、类版 `__enter__/__exit__`、`@contextmanager` 的 yield 写法
3. 独立完成计时装饰器 `timed` 和数据库连接上下文 `DbConnection`，亲眼看到一次「抛了异常连接照样关」和「不包 wraps 函数名变 wrapper」

## 概念讲解：为什么要把「前后」做成语法

先看没有装饰器的日子。你在调 Agent 接口，想知道每个环节各花多少毫秒，于是写：

```python
import time

def retrieve_memory(query: str) -> list[str]:
    start = time.perf_counter()
    result: list[str] = []  # 这里是真正的业务
    print(f"retrieve_memory 耗时 {(time.perf_counter() - start) * 1000:.2f} ms")
    return result
```

计时三行，业务一行。明天要给 `call_llm`、`format_answer` 加同样的计时，就再抄两份；想统一改成结构化日志，改三处；想临时关掉计时做压测，又是三处。读代码的人也遭罪：函数名底下先扒三行计时，才找到正事在哪。这和[第 1 周](/week01/)说的「为每种类型抄一遍函数」是同一类病，只是这次重复的不是逻辑主体，是裹在逻辑外面的壳。

装饰器的解法：把「包装」本身写成一个函数。Python 里函数是一等公民，能当参数传，也能当返回值还回来。于是可以写一个高阶函数，接收原函数，返回一个包好了计时的替身。`@` 只是这一步的语法糖：

```python
def timed(func):                 # 收一个函数
    def wrapper(*args, **kwargs):
        result = func(*args, **kwargs)  # 调用原函数
        return result
    return wrapper               # 还一个函数

@timed
def retrieve_memory(query: str) -> list[str]: ...

# 下面两段完全等价：
def retrieve_memory(query: str) -> list[str]: ...
retrieve_memory = timed(retrieve_memory)
```

看见没，`@timed` 没有引入任何新机制，它就是一行赋值的缩写。你其实已经用过装饰器了：本周 [Day 2](/week09/) 的 `@dataclass`，接收类、返回补好 `__init__` 的类。装饰器不止能装饰函数，类也能装。

从 NestJS 过来的人会问：这不就是 `@Injectable()` 那套吗？形似，实现差得远。JS 的装饰器在语言层面长期只是个提案，TS 靠 `experimentalDecorators` 这个实验开关先行支持，NestJS 再叠上 `reflect-metadata` 在运行时反射类型，三层东西凑出来的约定；Python 的装饰器是原生语法（PEP 318，2004 年就有了），`@` 就是一次普通的函数调用，任何「函数进、函数出」的东西都能当装饰器，零配置零反射。所以你在 Python 里看到 `@`，可以确定它干了什么：调用了一次函数。

框架为什么爱用它？看两句代码就懂：FastAPI 的 `@app.get("/orders")` 挂在函数头上，路由表里就多了一条；LangGraph 的 `@tool` 挂上去，这个函数就进了 Agent 的工具清单，名字、参数、文档全从函数身上提取。这叫声明式注册：注册信息写在定义处，框架扫描收集，业务函数保持纯净，不用维护一份中心化的注册清单。写过一阵你就回不去了。

另一半问题跟函数无关，跟资源有关。数据库连接、文件句柄、锁，共同点是「用完必须归还」。手动管理就是 try/finally：

```python
conn = create_conn(dsn)
try:
    conn.execute("SELECT 1")
finally:
    conn.close()
```

finally 保证关闭，没错，问题是这层壳每个调用处都要写一遍，忘一处就漏一个连接。上下文管理器把这对「进/出」收进协议，`with` 语句接手 finally：

```python
with create_conn(dsn) as conn:
    conn.execute("SELECT 1")
# 不管块里发生了什么，出来时连接一定已关闭
```

一句话总结今天：装饰器管函数的前后，上下文管理器管代码块的前后。思路和泛型一脉相承——重复的东西别写进每一处，把它变成参数、变成语法。

## 核心知识

本节的代码块都是独立示例，可以直接贴进[本周](/week09/)建好的 agent-service 项目里跑。最终完整文件以下面的动手任务为准。

### 1. 装饰器与 functools.wraps：保住函数的身份证

```python
from functools import wraps

def log_call(func):
    @wraps(func)                    # 就这一行，把身份证复印过来
    def wrapper(*args, **kwargs):
        print(f"调用 {func.__name__}，参数 {args} {kwargs}")
        return func(*args, **kwargs)
    return wrapper

@log_call
def greet(name: str) -> str:
    """向对方问好。"""
    return f"你好，{name}"

print(greet("Jerry"))
print(greet.__name__, "|", greet.__doc__)
# 调用 greet，参数 ('Jerry',) {}
# 你好，Jerry
# greet | 向对方问好。
```

关键在 `@wraps(func)`：把 `__name__`、`__doc__` 这些元数据从原函数复制到 wrapper 上。删掉这一行再跑，最后一行输出变成 `wrapper | None`，函数被包装后，名字和文档全丢了。这不只是好看问题：日志和监控按函数名聚合，满屏 `wrapper` 没法看；pytest 用例名、异常堆栈里也会出现一串 `wrapper`，排查时对不上真函数。所以规矩定死：写装饰器，`@wraps` 必带。

还有个细节值得多看一眼：`@wraps(func)` 自己就是个带参装饰器。`@` 后面跟的不必是裸名字，表达式也行，先求值，求值结果再当装饰器用。这个细节是下一节的钥匙。

### 2. 带参装饰器：三层嵌套

计时还想配个阈值「只报慢调用」，配置从哪进来？`@timed(threshold_ms=80)` 括号里带的是参数，不是函数，所以装饰器外面得再包一层「收参数的函数」：

```python
from functools import wraps

def retry(times: int):
    def decorator(func):                # 第二层：收到真正的函数
        @wraps(func)
        def wrapper(*args, **kwargs):   # 第三层：收到真正的调用参数
            for i in range(times):
                try:
                    return func(*args, **kwargs)
                except Exception:
                    if i == times - 1:
                        raise
        return wrapper
    return decorator

calls: list[int] = []

@retry(times=3)
def flaky_call() -> str:
    calls.append(1)
    if len(calls) < 3:
        raise ConnectionError("网络抖动")
    return "ok"

print(flaky_call(), len(calls))  # ok 3
```

三层分工记牢：外层收配置（times）、中层收函数（func）、内层收调用参数（args/kwargs）。为什么必须三层？看 `@retry(times=3)` 发生了什么：先求值 `retry(3)`，返回 decorator；再用 decorator 装饰函数。也就是说，带参装饰器是「先吃参数，吐出一个装饰器，装饰器再吃函数」。少写一层，配置和函数就挤在同一层；写成 `@retry` 忘了括号更隐蔽，函数会被当成 `times` 传进去，定义时不报错，调用时才炸。

### 3. 上下文管理器：with 的两种写法

类版，实现 `__enter__` 和 `__exit__` 两个方法：

```python
class Timer:
    def __enter__(self):
        print("进入")
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        print("退出")
        return False

with Timer():
    print("干活")
# 进入 / 干活 / 退出
```

`__enter__` 在进 with 块时执行，返回值交给 `as` 后面的变量；`__exit__` 在离开时执行，无论块里正常走完、return 还是抛异常，它都必被调用，这就是 with 内置的 finally。三个参数是异常信息：没异常时是三个 `None`，有异常时是异常的类型、值、回溯。返回值要当心：返回 `True` 等于告诉解释器「异常我处理了」，异常就地被吞；返回 `False` 或 `None`，异常继续往外抛。日常写法永远是 `return False`，清理归清理，异常交给调用方。

函数版，`@contextmanager` 加一个带 yield 的生成器：

```python
from contextlib import contextmanager

@contextmanager
def tag(name: str):
    print(f"<{name}>")       # yield 前：__enter__ 干的事
    try:
        yield name           # with 块在这里执行
    finally:
        print(f"</{name}>")  # yield 后：__exit__ 干的事

with tag("div"):
    print("内容")
# <div> / 内容 / </div>
```

yield 把函数切成两段：前段是进入时做的事，后段是退出时做的事，with 块的执行体恰好嵌在 yield 挂起的那一瞬间。两种写法怎么选：只需要一对前后动作，函数版五六行更顺手；要维护状态、返回复杂对象（比如连接池），类版更清楚。两种今天都得写一遍，后面读框架源码时到处是它们。

## 动手任务：计时装饰器 + 数据库连接上下文 一步一步

手册任务：写一个计时装饰器和一个数据库连接上下文管理器。拆成 5 步，全程约 25 分钟，全部只用标准库。

**第 1 步：建文件。** 在[本周](/week09/)建好的 agent-service 项目里新建 `timer.py` 和 `db_context.py`。前 3 步写第一个工具，后 2 步写第二个，写完这两个文件就是当日产出。

**第 2 步：朴素计时装饰器，先摔一跤。** 在 `timer.py` 写下不带 `@wraps` 的版本：

```python
import time

def timed(func):
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        result = func(*args, **kwargs)
        elapsed = (time.perf_counter() - start) * 1000
        print(f"{func.__name__} 耗时 {elapsed:.2f} ms")
        return result
    return wrapper

@timed
def ping() -> None:
    time.sleep(0.05)

ping()
print(ping.__name__)
```

`poetry run python timer.py` 跑一下。日志那行完全正常，最后一行却输出 `wrapper`，函数名丢了。计时打印的 `func.__name__` 没问题（闭包里拿的是原函数），但外面世界看到的 `ping` 已经是替身。修复只要一行：文件顶部加 `from functools import wraps`，`def wrapper` 上面加 `@wraps(func)`，再跑，输出变回 `ping`。另外记住 `time.perf_counter()`：单调递增的高精度计时器，不受系统改时间影响，测耗时永远用它，别用 `time.time()`。

**第 3 步：升级带参版。** 把 `timed` 改造成三层结构，加「慢调用阈值」，低于阈值的调用不打印，日志不再刷屏：

```python
import time
from functools import wraps

def timed(threshold_ms: float = 0.0):
    """计时装饰器：耗时达到 threshold_ms 才打印，0 表示全打。"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            result = func(*args, **kwargs)
            elapsed = (time.perf_counter() - start) * 1000
            if elapsed >= threshold_ms:
                print(f"[slow] {func.__name__} 耗时 {elapsed:.2f} ms")
            return result
        return wrapper
    return decorator

if __name__ == "__main__":
    @timed(threshold_ms=80.0)
    def call_llm(model: str) -> str:
        time.sleep(0.1)
        return f"{model} 的回复"

    @timed(threshold_ms=80.0)
    def quick_check() -> None:
        time.sleep(0.02)

    print(call_llm("demo-model"))  # 先打印 [slow] call_llm 耗时 ~100 ms
    quick_check()                  # 20ms，低于阈值，安静
    print(call_llm.__name__)       # call_llm，wraps 保住了
```

这就是第一个工具的完成形态：默认 `threshold_ms=0.0` 全量打印，压测时传个阈值只盯慢调用。跑一遍，输出对得上就过关。

**第 4 步：类版数据库连接上下文。** 换到 `db_context.py`。手头没有真数据库，写个假连接，重点看开关时机：

```python
class FakeConnection:
    """假连接：只用 closed 标记开合，肉眼可验证。"""

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.closed = False

    def execute(self, sql: str) -> str:
        if self.closed:
            raise RuntimeError("连接已关闭")
        return f"[{self.dsn}] {sql}"


class DbConnection:
    """类版上下文管理器：__enter__ 建连，__exit__ 必关。"""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def __enter__(self) -> FakeConnection:
        print(f"打开连接 {self._dsn}")
        self._conn = FakeConnection(self._dsn)
        return self._conn

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        print(f"关闭连接 {self._dsn}")
        self._conn.closed = True
        return False


if __name__ == "__main__":
    dsn = "postgres://localhost/agent"

    with DbConnection(dsn) as conn:
        print(conn.execute("SELECT 1"))

    print("--- 异常路径 ---")
    try:
        with DbConnection(dsn) as conn:
            print(conn.execute("SELECT 1"))
            raise RuntimeError("处理结果集时炸了")
    except RuntimeError as e:
        print(f"捕获到异常: {e}")
```

`poetry run python db_context.py`，注意异常路径的输出顺序：`打开连接` → 执行 → `关闭连接` → `捕获到异常`。连接先被关掉，异常才落到外面的 except。这就是 `__exit__` 的 finally 语义：块里炸了它也执行，执行完才放异常走，而这一切没写一行 try/finally 样板。

**第 5 步：用 @contextmanager 再写一遍。** 在 `db_context.py` 末尾追加函数版，同一件事换种写法，演示代码接在刚才那个 `if __name__ == "__main__":` 块里：

```python
from contextlib import contextmanager

@contextmanager
def db_conn(dsn: str):
    print(f"打开连接 {dsn}")
    conn = FakeConnection(dsn)
    try:
        yield conn
    finally:
        conn.closed = True
        print(f"关闭连接 {dsn}")
```

```python
    try:
        with db_conn("postgres://localhost/agent") as conn:
            print(conn.execute("SELECT 1"))
            raise RuntimeError("又炸了")
    except RuntimeError as e:
        print(f"捕获到异常: {e}")
```

再跑一遍，输出顺序和第 4 步的异常路径完全一致：yield 前的 `打开连接` 是 enter，finally 里的 `关闭连接` 是 exit，块里抛错也照样关。两个文件到此完工，这就是当日产出。

::: tip 运行命令
两个文件都只用标准库，不用加任何依赖，`poetry run python timer.py`、`poetry run python db_context.py` 分别跑，直接 `python` 也行。想把 `timed` 贴到本周 Day 3 的异步函数上试试也行，你会发现耗时永远接近 0：同步 wrapper 拿到的是 coroutine 对象，函数体根本没执行。异步装饰器得再包一层 `async def`，属于进阶话题，先知道有这回事。
:::

## 常见踩坑

**坑 1：装饰器忘了 return wrapper。** 装饰器返回 None，`@` 完成后函数名就绑到 None 上了，一调用就 `TypeError: 'NoneType' object is not callable`。报错位置在调用处，离定义处十万八千里，新手常盯着调用行发懵。写完装饰器先查两处 return：装饰器本身 `return wrapper`，wrapper 里 `return func(*args, **kwargs)`（确定不要返回值的场景，也想清楚再省）。

**坑 2：把 `@wraps` 当可写可不写。** 单个函数看不出危害，危害在聚合处：日志按 `__name__` 聚合全是 wrapper；pytest 的用例名和失败信息显示 wrapper；出了异常看堆栈，几层装饰器叠出几个 wrapper，定位真实函数要扒半天。排查可读性的成本是一次一行 `@wraps` 能免掉的，把它当成和 def 后面的冒号一样必写。

**坑 3：带参装饰器的括号。** `@retry` 和 `@retry(times=3)` 是两个世界。前者把函数本身当成 times 传进去，定义时不报错，调用时才莫名其妙地炸；后者才是正路。规则很简单：只要装饰器是「先吃参数」的工厂（哪怕参数全有默认值），使用时永远带括号，写 `@retry()`。

**坑 4：`__exit__` 顺手 return True。** True 表示「异常已处理」，with 块里的错误被无声吞掉，程序带着坏状态继续跑，比崩溃难查十倍。除非你在写「捕获特定异常再重试」这类明确要吞的工具，否则 `__exit__` 永远 return False。真要按异常类型做判断，用 `exc_type` 参数比，别用返回值兜。

**坑 5：`@contextmanager` 忘了 try/finally。** yield 后面的清理代码，只有正常路径会执行；with 块抛异常时，异常被注入到 yield 挂起点，生成器直接向外抛，yield 之后的代码全被跳过，连接就漏了。所以函数版的铁律：清理动作包进 `try/finally`，yield 放 try 里。类版没这个问题，`__exit__` 协议自带保证。很多人写完函数版只测正常路径就收工，上线才开始漏资源，就是栽在这。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `@timed` 加在函数定义上方，等价于哪条赋值语句？为什么说装饰器是高阶函数？

::: details 参考答案
等价于 `f = timed(f)`：先正常定义函数，再把函数名重新绑定为装饰器的返回值。高阶函数指接收函数作参数或返回函数的函数，timed 两头都占了，进是原函数，出是 wrapper。`@` 没有引入任何新机制，只是这次函数调用的语法糖。
:::

2. 不加 `@wraps`，最先暴露问题的场景有哪些？

::: details 参考答案
函数的 `__name__` 变成 `wrapper`、`__doc__` 变成 None。最先暴露的：按函数名聚合的日志和监控全是 wrapper；pytest 用例名和失败堆栈显示 wrapper；多层装饰器叠在一起时，traceback 和调试器里几个 wrapper 套娃，对不上真实函数。`@wraps` 把原函数的元数据复制过来，成本一行。
:::

3. 带参装饰器为什么要三层函数？`@timed(threshold_ms=80)` 这行按什么顺序求值？

::: details 参考答案
`@` 后面必须跟一个装饰器，而 `timed(threshold_ms=80)` 是「接收参数、返回装饰器」的调用。求值顺序：先执行 `timed(80)` 得到 decorator，再用 decorator 装饰紧随其后的函数。三层各司其职：外层收配置、中层收函数、内层收调用时的实参。`@wraps(func)` 用的也是同一原理，`wraps(func)` 先求值。
:::

4. `__exit__` 返回 True 和 False 分别意味着什么？日常该返回哪个？

::: details 参考答案
返回 True 表示「异常我处理过了」，with 块里的异常就地吞掉，程序继续跑；返回 False 或 None，异常照常往外抛，交给上层处理。日常永远返回 False。上下文管理器只负责清理资源，不替业务做错误决策，被吞掉的异常比崩溃更难排查。
:::

5. 同一个数据库连接上下文，类版和 `@contextmanager` 版各是什么结构？yield 在其中扮演什么角色？

::: details 参考答案
函数版是「yield 前开连接 + try/yield/finally 关连接」，五六行搞定；类版实现 `__enter__`（建连并返回）和 `__exit__`（必关），行数多些但状态管理更清晰。yield 把函数切两段：前段对应 `__enter__`，后段对应 `__exit__`，with 块的执行体恰好嵌在 yield 挂起的位置。简单前后动作用函数版，要维护状态、返回复杂对象用类版。
:::

## 延伸阅读

- [functools 官方文档](https://docs.python.org/3/library/functools.html#functools.wraps)，`wraps` 和它背后的 `update_wrapper` 的说明，一页读完
- [contextlib 官方文档](https://docs.python.org/3/library/contextlib.html)，`@contextmanager` 的异常注入细节，还有 `closing`、`suppress` 这些现成的小工具
- [PEP 343](https://peps.python.org/pep-0343/)，with 语句的提案原文，看协议设计者怎么定义「保证退出」的语义

今天的产出 `timer.py` 和 `db_context.py` 留好。`timed` 在后面调 Agent 各环节耗时时直接往函数头上一贴；两种上下文写法是模板，等进了 FastAPI，`@app.get()` 注册路由、LangGraph 的 `@tool` 注册工具，全是今天这套机制换层皮，到时你看到的不是新语法，是老朋友。
