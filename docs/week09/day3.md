# 第 9 周 · Day 3：asyncio 基础——协程、事件循环与 gather 并发

> 对应手册任务：学习「asyncio 基础：`async/await`、`asyncio.gather`」，动手写 3 个异步函数模拟 API 调用，用 `gather` 并发执行，当日产出 `async_demo.py`。本篇只解决一个问题：你在第 3 周深学过 Node 事件循环，看 Python 的 `async/await` 觉得眼熟，但两套异步的底层机制并不相同——把 Node 的直觉原样搬过来，第一段代码就会踩坑。今天先把差异讲透，再把并发真正跑起来。

## 今日目标

1. 说得清 Python 异步和 Node 异步的核心差异：JS 的回调即调度、循环内建在运行时里；Python 的协程只是语法，必须有事件循环显式驱动才执行
2. 掌握四个语法点：`async def` 与 `await`、`asyncio.run`、`create_task`、`asyncio.gather`
3. 独立完成 `async_demo.py`：3 个模拟 API 用 gather 并发执行，亲眼看到 6 秒变 3 秒，并亲手触发一次 gather 的异常传播

## 概念讲解：JS 的异步是内建的，Python 的不是

第 3 周拆 Node 事件循环时你早就知道：写 `setTimeout(fn, 0)`，fn 不会立刻执行，但也不需要你操心「谁来执行它」。V8 和 libuv 把循环内建在运行时里，任何回调只要注册了就会被自动调度。调用即调度，这是 JS 异步的默认设定。你从没写过 `eventLoop.run(main())` 这种代码。

Python 不是这样。`async def` 定义的函数叫协程函数，调用它不会执行函数体，只会创建一个协程对象——一段「待执行」的代码，放在那里一动不动。谁来执行它？事件循环。而事件循环不会自己跑起来，要你显式启动。这就是 `asyncio.run()` 存在的原因：创建事件循环、把你交给它的协程跑完、关闭循环，一条命令包办。

先跑一段什么都不 await 的代码，感受「调用不等于执行」：

```python
import asyncio

async def say(text: str) -> str:
    return f"收到：{text}"

coro = say("你好")  # 函数体一行都没执行，只拿到一个协程对象
print(type(coro))   # <class 'coroutine'>
```

运行后输出 `<class 'coroutine'>`，外加一条警告 `RuntimeWarning: coroutine 'say' was never awaited`。同样的写法放进 JS，`say("你好")` 早就把结果返回了。这就是第一处要修正的直觉：Python 里，协程是半成品，事件循环才是工厂。

由此推出三条硬规则，今天全部用得上：

1. `await` 只能写在 `async def` 里，普通函数里写 `await` 直接 `SyntaxError: 'await' outside async function`
2. 调用 `async` 函数只是创建协程，必须交给 `await` 或 `create_task` 才开始执行
3. 事件循环必须显式启动，程序入口统一写 `asyncio.run(main())`

## 核心知识

本节的代码块都是独立示例，存成 `.py` 文件用 `python` 直接跑。最终完整文件以下面的动手任务为准。

### 1. 最小异步程序：async def、await、asyncio.run

```python
import asyncio
import time

async def call_api(name: str, seconds: float) -> str:
    print(f"{time.strftime('%X')} {name} 发起调用")
    await asyncio.sleep(seconds)  # 模拟网络等待，期间让出控制权
    print(f"{time.strftime('%X')} {name} 拿到响应")
    return f"{name} 的数据"

async def main() -> None:
    result = await call_api("接口A", 1)
    print(result)

asyncio.run(main())
```

预期输出（时间随运行时刻变）：

```
21:30:05 接口A 发起调用
21:30:06 接口A 拿到响应
接口A 的数据
```

关键一行是 `asyncio.run(main())`：它先把 `main()` 这个协程对象变成循环的第一个任务，然后启动循环。整个程序从上到下只有这一处点火，其余协程都靠 await 链条被带动起来。这就是 JS 和 Python 在工程结构上最显眼的差别：Node 的 `main()` 直接调用，Python 的 `main()` 要塞给 `asyncio.run`。

再看 `await asyncio.sleep(seconds)`。await 的语义是「让出控制权」：当前协程在此挂起，控制权交还事件循环，循环趁这段等待的空档去跑别的就绪任务，等这边的 Future 完成，再切回断点继续。行为上和 JS 的 await 一致，区别只在驱动者——Node 是引擎内建的循环在转，Python 是你用 `asyncio.run` 启动的循环在转。后面的示例都沿用上面定义的 `call_api`。

### 2. 连排 await 是串行：create_task 才算「调用即调度」

JS 程序员的肌肉记忆是：`const p = fetch(url)` 这一调用，请求已经发出去了，`await p` 只是等结果。把这份直觉带进 Python，第一个坑就来了：

```python
async def main() -> None:
    start = time.perf_counter()
    r1 = await call_api("接口A", 2)  # 等 A 做完，才轮到下一行
    r2 = await call_api("接口B", 2)
    r3 = await call_api("接口C", 2)
    print(f"串行总耗时：{time.perf_counter() - start:.1f} 秒")
```

预期输出的时间戳每隔 2 秒才动一下：

```
21:31:00 接口A 发起调用
21:31:02 接口A 拿到响应
21:31:02 接口B 发起调用
21:31:04 接口B 拿到响应
21:31:04 接口C 发起调用
21:31:06 接口C 拿到响应
串行总耗时：6.0 秒
```

await 是「等它做完再往下走」，三个协程从头到尾没有同时存在过，总耗时 2+2+2=6 秒，一个字节都没并发。想要 JS 那种「调用即调度」，用 `create_task` 把协程包装成任务，事件循环下一轮就开始跑它：

```python
async def main() -> None:
    start = time.perf_counter()
    t1 = asyncio.create_task(call_api("接口A", 2))  # 创建即注册进循环
    t2 = asyncio.create_task(call_api("接口B", 2))
    t3 = asyncio.create_task(call_api("接口C", 2))
    r1 = await t1  # 三个任务早就在跑了，这里只是分别等结果
    r2 = await t2
    r3 = await t3
    print(f"并发总耗时：{time.perf_counter() - start:.1f} 秒", r1, r2, r3)
```

预期输出：

```
21:32:00 接口A 发起调用
21:32:00 接口B 发起调用
21:32:00 接口C 发起调用
21:32:02 接口A 拿到响应
21:32:02 接口B 拿到响应
21:32:02 接口C 拿到响应
并发总耗时：2.0 秒 接口A 的数据 接口B 的数据 接口C 的数据
```

关键一行是 `asyncio.create_task(...)`：它对应 JS 里「调用返回 Promise 的函数」那一下——函数已经开始执行，你手里拿的是凭据，稍后凭它取结果。区别只是 Python 必须写得这么明白，JS 天生如此。另外注意保存 `create_task` 的返回值再 await，别写成「射后不理」：没有引用的任务可能被垃圾回收中途蒸发，官方文档专门提醒过这一点。

### 3. asyncio.gather：并发、按序返回、异常传播

三个任务「创建再分别 await」还是啰嗦，gather 一行搞定，直接对照 `Promise.all` 记：

```python
async def main() -> None:
    start = time.perf_counter()
    r1, r2, r3 = await asyncio.gather(
        call_api("接口A", 1),
        call_api("接口B", 2),
        call_api("接口C", 3),
    )
    print(r1, r2, r3, f"总耗时 {time.perf_counter() - start:.1f} 秒")
```

三个任务同时开跑（时间戳同一秒），总耗时约 3 秒，等于最慢的那个，不是三者之和——和 `Promise.all` 一样。返回值顺序永远等于传参顺序，跟谁先完成无关——也和 `Promise.all` 一样。

异常传播是两套机制最容易混淆的地方，对照着记：

| 行为 | JS `Promise.all` | Python `asyncio.gather` 默认 |
| --- | --- | --- |
| 一个失败 | 整体立刻 reject | 整体立刻抛异常 |
| 其他任务 | 继续跑，结果被忽略 | 继续跑，不会被自动取消 |
| 「全都要」的写法 | `Promise.allSettled` | `gather(..., return_exceptions=True)` |

```python
async def failing_api() -> str:
    await asyncio.sleep(1)
    raise RuntimeError("接口B 挂了")

async def main() -> None:
    try:
        await asyncio.gather(call_api("接口A", 2), failing_api())
    except RuntimeError as e:
        print(f"整体抛出：{e}")

    results = await asyncio.gather(
        call_api("接口A", 2),
        failing_api(),
        return_exceptions=True,
    )
    print(results)
```

关键在第一段：第 1 秒 `failing_api` 抛错，整条 gather 立刻把异常抛给 await 它的人，`接口A` 不受影响，仍在后台跑完，只是结果没人收。预期输出省略 `call_api` 自己的打印，关键两行是：

```
整体抛出：接口B 挂了
（约 2 秒后）
['接口A 的数据', RuntimeError('接口B 挂了')]
```

第二段的 `return_exceptions=True` 让异常不再向上抛，而是当作「结果」放进列表对应位置，相当于 `Promise.allSettled`。代价是列表里混着正常值和异常对象，取出来要先 `isinstance(x, BaseException)` 判断，拿到就当正常值用必翻车。

### 4. asyncio.sleep 与 time.sleep：一字之差，天壤之别

```python
import time

async def blocking() -> None:
    time.sleep(3)            # 语法完全合法，但事件循环被卡死 3 秒

async def polite() -> None:
    await asyncio.sleep(3)   # 让出控制权 3 秒，其他任务照常跑
```

`asyncio.sleep` 是「可等待的睡」：挂起当前协程，3 秒后由循环唤醒，期间循环空出来跑别的任务。`time.sleep` 是「抱着循环一起睡」：事件循环跑在当前线程里，线程被卡 3 秒，所有任务集体停摆——不是变慢，是全停。

对照 Node：这和你在 JS 里写 `readFileSync`、写 `while (true) {}` 是同一类问题，事件循环线程被占住，谁也调度不了。后面写 FastAPI 时同理：路由函数里一个 `time.sleep` 或一次同步的 `requests.get`，整个服务的吞吐直接塌掉。真实项目里发 HTTP 请求用 `httpx`（`httpx.AsyncClient`）或 `aiohttp`，一句话记住：`requests` 是同步库，进了异步代码就卡循环，别用。

## 动手任务：`async_demo.py` 一步一步

手册任务：写 3 个异步函数模拟 API 调用，用 gather 并发执行。拆成 5 步，全程约 20 分钟。

**第 1 步：建文件。** 在[本周](/week09/)的练习目录（Day 1 建的 `agent-service` 里开个 `demos` 目录也行）新建 `async_demo.py`。下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：写 3 个模拟 API 的异步函数。** 故意让三个接口耗时不同：1 秒、2 秒、3 秒，等会儿对比才有看头：

```python
import asyncio
import time


async def fetch_user(user_id: int) -> dict:
    """模拟用户接口：耗时 1 秒。"""
    await asyncio.sleep(1)
    return {"id": user_id, "name": f"用户{user_id}"}


async def fetch_orders(user_id: int) -> list[str]:
    """模拟订单接口：耗时 2 秒。"""
    await asyncio.sleep(2)
    return [f"订单A-{user_id}", f"订单B-{user_id}"]


async def fetch_points(user_id: int) -> int:
    """模拟积分接口：耗时 3 秒。"""
    await asyncio.sleep(3)
    return 1800
```

关键在每个函数体里的 `await asyncio.sleep(...)`：它模拟的是「等网络响应」。写成 `time.sleep` 这个 demo 就废了，三个任务轮流把循环卡死，gather 也救不了。

**第 3 步：先写串行版，看清「假的并发」。** 加上 main 和入口：

```python
async def main() -> None:
    start = time.perf_counter()

    user = await fetch_user(1)
    orders = await fetch_orders(1)
    points = await fetch_points(1)

    print("结果：", user, orders, points)
    print(f"串行耗时：{time.perf_counter() - start:.1f} 秒")


if __name__ == "__main__":
    asyncio.run(main())
```

运行 `python async_demo.py`，预期输出：

```
结果： {'id': 1, 'name': '用户1'} ['订单A-1', '订单B-1'] 1800
串行耗时：6.0 秒
```

6 秒，正好 1+2+3。代码里明明全是 await，怎么还在排队？因为 await 的语义是「等它做完再往下走」，三个协程从未同时运行。这是新手最容易自我感觉良好的地方：语法全对，一行没并发。

**第 4 步：换成 gather，看数字腰斩。** 把 main 里的三行 await 换成一个 gather：

```python
async def main() -> None:
    start = time.perf_counter()

    user, orders, points = await asyncio.gather(
        fetch_user(1),
        fetch_orders(1),
        fetch_points(1),
    )

    print("结果：", user, orders, points)
    print(f"并发耗时：{time.perf_counter() - start:.1f} 秒")
```

再次运行，预期输出：

```
结果： {'id': 1, 'name': '用户1'} ['订单A-1', '订单B-1'] 1800
并发耗时：3.0 秒
```

还是那三个函数，一行逻辑没改，6 秒变 3 秒，正好等于最慢的接口。结果顺序和传参顺序一致，user、orders、points 各归各位，不管谁先完成。

**第 5 步：加一个必挂的接口，抓一次异常。** 往文件里再加一个函数，然后照注释做两组实验：

```python
async def fetch_vip(user_id: int) -> str:
    """模拟一个必然失败的接口。"""
    await asyncio.sleep(1)
    raise RuntimeError(f"vip-{user_id} 接口超时")


# 实验 1：默认行为。把 main 里的 gather 换成下面这行再运行：
# await asyncio.gather(fetch_user(1), fetch_vip(1))
# 第 1 秒整条 gather 抛 RuntimeError，main 直接崩，fetch_user 的结果拿不到

# 实验 2：收集异常。换成下面这段再运行：
# results = await asyncio.gather(
#     fetch_user(1),
#     fetch_vip(1),
#     return_exceptions=True,
# )
# print(results)  # [{'id': 1, 'name': '用户1'}, RuntimeError('vip-1 接口超时')]
```

两组各跑一遍。实验 1 对应 `Promise.all` 的「一个 reject 整体 reject」；实验 2 对应 `Promise.allSettled`，异常躺进了结果列表。看完把实验代码保持注释，让最终文件的输出停在第 4 步的干净样子。

::: tip 运行环境
`python async_demo.py` 直接跑，只用标准库，Python 3.9 及以上即可（`list[str]` 写法要 3.9+）。第 1 天配的 poetry 环境可用可不用，本篇不依赖第三方库。
:::

## 常见踩坑

**坑 1：调用 async 函数却忘了交给循环。** `fetch_user(1)` 直接调用，既不 await 也不 create_task，函数体永远不执行，只有一条 `RuntimeWarning: coroutine 'fetch_user' was never awaited`。更隐蔽的是当普通值用：`print(fetch_user(1))` 打印出 `<coroutine object fetch_user at 0x...>`，程序不崩，结果全错。判断标准一句话：看到 `coroutine object` 字样，就是漏了 await。

**坑 2：以为写了 await 就是并发。** 复盘今天最重要的结论：连排的三个 await 是顺序执行，总耗时是三者之和；先 `create_task` 再 await，或直接 `gather`，总耗时才约等于最慢的那个。口诀：await 之前没有「注册动作」（create_task 或 gather），就没有并发。从 JS 过来的同学把「调用即调度」的直觉倒过来记：Python 里，调用只是造协程，注册进循环才算开始干活。

**坑 3：异步函数里用同步阻塞调用。** `time.sleep`、`requests.get`、一次性读大文件，都会把事件循环线程占住，所有协程跟着停摆。代码不报错，就是莫名「卡」。FastAPI 里同理：重计算或同步 IO 放进路由，服务并发能力直接归零，后面 FastAPI 章节还会考这一条。解法两选一：换异步库（httpx、aiofiles），或者把阻塞调用丢进线程池（`asyncio.to_thread`）。

**坑 4：误解 gather 的异常行为。** 默认一个抛、整体抛，而且其余任务不会被取消，还在后台跑完，只是结果没人收。想全都要，加 `return_exceptions=True`，但列表里混着正常值和异常对象，取值前逐个 `isinstance(x, BaseException)` 检查，直接当正常结果用必翻车。另外注意 try/except 捕获后，后台那些「没人收」的任务可能还在跑，别以为程序已经消停了。

**坑 5：到处写 asyncio.run。** `asyncio.run` 是程序入口，全程序调一次。在已经跑着的循环里再调它（最常见：Jupyter Notebook 自带运行中的循环），报 `RuntimeError: asyncio.run() cannot be called from a running event loop`。Notebook 里不用 run，单元格顶层直接 `await main()`。普通脚本里也别在一个 async 函数内部再 asyncio.run，入口归入口，里面归 await。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 调用 `async def` 函数的那一瞬间发生了什么？函数体什么时候才真正执行？

::: details 参考答案
只创建一个协程对象，函数体一行不执行。它被 `await`（当前协程驱动它）或 `asyncio.create_task`（事件循环调度它）之后才开始跑。这是 Python 和 JS 最大的差异：JS 调用即调度，Python 调用只造协程，注册进循环才算调度。
:::

2. `await` 的语义是什么？「让出控制权」让给了谁？

::: details 参考答案
await 把当前协程挂起，控制权交还事件循环；循环去跑其他就绪任务，等被 await 的结果可用，再切回断点继续。行为上和 JS 的 await 一致，区别在驱动者：Node 是引擎内建的循环自动转，Python 是 `asyncio.run` 显式启动的循环在转。
:::

3. 三个连排 `await` 和一次 `gather`，耗时差在哪？为什么？

::: details 参考答案
连排 await 总耗时约等于三者之和：每个 await 都要「等它做完才走下一行」，三个协程从未同时运行。gather 把三个协程同时注册进循环，各自推进互不等待，总耗时约等于最慢的那个。差别不在函数本身，在「什么时候注册进循环」。
:::

4. `gather` 里一个任务抛异常，默认整体怎样？`return_exceptions=True` 改变了什么？分别对应 JS 的哪个 API？

::: details 参考答案
默认整体立刻抛出该异常，其余任务不取消、继续跑完，结果被丢弃，对应 `Promise.all` 一个 reject 整体 reject。`return_exceptions=True` 让异常不再抛出，而是作为结果放进列表对应位置，相当于 `Promise.allSettled`，取值时要逐个 isinstance 判断。
:::

5. 在 async 函数里写 `time.sleep(3)` 会怎样？写成 `await time.sleep(3)` 又会怎样？

::: details 参考答案
前者合法但致命：事件循环线程被阻塞 3 秒，期间所有任务停摆，程序不报错只是全卡。后者直接 `TypeError: object NoneType can't be used in 'await' expression`，因为 `time.sleep` 返回 None，不是可等待对象——报错反而是好事，把你拦住了。
:::

## 延伸阅读

- [Python 官方文档：asyncio 并发任务](https://docs.python.org/zh-cn/3/library/asyncio-task.html)，coroutine、task、gather 的原始出处，有中文版，值得通读
- [Real Python: Async IO in Python](https://realpython.com/async-io-python/)，把「异步不是多线程」这件事讲得最透的一篇
- [httpx 文档](https://www.python-httpx.org/)，今天用 sleep 模拟网络，真发请求时看它的 `AsyncClient`，requests 的异步替身

今天的产出 `async_demo.py` 留好，`gather` 并发调多个接口再按序收结果这个形状，后面写 FastAPI 服务、并发请求多个 LLM 时会天天用。
