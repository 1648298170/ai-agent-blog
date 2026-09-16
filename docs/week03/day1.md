# 第 3 周 · Day 1：Node.js 事件循环六阶段——看清异步代码的真正执行顺序

> 对应手册任务：学习「事件循环六阶段 + 微任务/宏任务」，动手写一个脚本，输出 setTimeout / Promise / process.nextTick 的执行顺序，验证理解，当日产出 `event-loop.js` + 输出日志。本篇只解决一个问题：同一段代码里混着 setTimeout、Promise.then、process.nextTick 时，谁能插队、谁只能排队。规则只有一套，就是事件循环的调度表。

## 今日目标

1. 说得清事件循环六个阶段各自负责什么，以及 nextTick 和微任务这两条特殊队列插在哪里
2. 掌握三条优先级规则：nextTick 先于微任务；每个回调执行完立刻清空这两条队列；poll 之后同圈紧跟 check，所以 I/O 回调里 setImmediate 必赢 setTimeout
3. 独立完成 `event-loop.js`：先写预测表，再运行验证，让日志和预测逐行对上，从此看任何混合异步代码都能默写输出序

## 概念讲解：为什么需要事件循环

阶段一你在 Next.js 里写 Server Actions，一个 `await db.query()` 挂起时，别的请求照样进来处理。Node.js 的主线程明明只有一条，凭什么没被卡死？

再追问三个更具体的问题：`setTimeout(fn, 0)` 为什么不是 0 毫秒后执行？递归的 `await` 为什么能把一个接口拖死？`process.nextTick` 和 `Promise.then` 都宣称「尽快执行」，谁更尽快？这四个问题的答案其实是同一个东西。

先立住一个事实：JavaScript 主线程同一时刻只执行一段代码，任何回调都插不进正在执行的代码中间。那 I/O 谁来做？libuv。主线程把网络、文件这些慢活扔给操作系统异步接口和 libuv 的线程池，自己继续跑后面的同步代码。等结果回来，事件循环负责决定「下一段执行谁」。它是 Node 一切并发行为的调度核心，你在 Next.js 里享受的全部并发，底层都是它在转。

不懂这张调度表时，你只能靠猜和背结论；懂了之后，输出序是可以现场推导的。这就是今天要做的事。先说清为什么这样设计，再逐个阶段拆。

## 核心知识

本节的代码块都是独立示例，存成临时 `.js` 文件执行 `node 文件名.js` 就能跑。今天的 TypeScript 帮不上忙，我们面对的是纯运行时行为。最终完整文件以下面的动手任务为准。

### 1. 六个阶段：事件循环的流水线

事件循环每转一圈，按固定顺序经过六个阶段，每个阶段是一个先进先出的回调队列：

```
timers → pending callbacks → idle, prepare → poll → check → close callbacks
  ↑                                                                     │
  └─────────────────────── 转一圈，回到 timers ──────────────────────────┘
```

| 阶段 | 职责 | 你常见的回调 |
| --- | --- | --- |
| timers | 执行到期的 `setTimeout` / `setInterval` 回调 | 定时器 |
| pending callbacks | 执行上一轮循环延后的系统级回调，比如 TCP 连接失败（`ECONNREFUSED`）这类错误有时要等系统给结果，只能推到下一轮 | 少见，碰到了再说 |
| idle, prepare | libuv 内部使用 | 基本见不到 |
| poll | 整个循环的心脏：取出新就绪的 I/O 事件并执行回调，网络、文件几乎都在这里；没活干时会在这一阶段等待 | 绝大多数 I/O 回调 |
| check | 执行 `setImmediate` 回调 | `setImmediate` |
| close callbacks | 执行关闭类回调，比如 `socket.on("close")` | 资源清理 |

两件事必须现在记住。第一，`setTimeout(fn, 0)` 的 0 会被 Node 强制改成 1 毫秒，而且到期之后还得等循环转回 timers 阶段才轮到它，所以它既不精确也不「立即」。第二，nextTick 队列和微任务队列不在这六个阶段里，它们是插队通道，下一小节细说。

### 2. 两条插队通道：process.nextTick 与微任务

微任务队列装的是 `Promise.then` / `catch` / `finally` 的回调和 `queueMicrotask` 注册的函数，`await` 后面的代码也算（它是被编译器改写过的 then）。nextTick 队列只装 `process.nextTick` 注册的函数。两条队列的规矩：

- 每个回调（不管是哪个阶段的）执行完，立刻先清空 nextTick 队列，再清空微任务队列，然后事件循环才继续走
- nextTick 优先级高于微任务，官方文档写得明确

四行代码看懂排位：

```js
console.log("A 同步代码");
process.nextTick(() => console.log("B nextTick"));
Promise.resolve().then(() => console.log("C Promise.then"));
setTimeout(() => console.log("D setTimeout"), 0);
// 输出：A → B → C → D
```

同步代码 A 最先跑完，这没人能抢。随后主模块结束，先清 nextTick 队列得到 B，再清微任务队列得到 C，事件循环这才开始第一圈，在 timers 阶段执行 D。你可以把 setTimeout 的回调理解成「宏任务」：它老老实实排在六个阶段里，永远排在两条插队通道后面。

nextTick 为什么要设计得比 Promise 还急？官方给的理由是：有些 API 需要在「调用栈展开之后、事件循环继续之前」这个时机处理错误、清理资源，比 Promise 的续体更早一步。日常写代码，能用 `queueMicrotask` 就别用 `process.nextTick`，后者插队太狠，用过头会出事，踩坑一节有现场。

### 3. setImmediate 对决 setTimeout：胜负取决于 poll

两个都号称「尽快执行」的 API，走的却不是一条道：`setTimeout(fn, 0)` 的回调送去 timers 阶段排队，`setImmediate(fn)` 的回调送去 check 阶段排队。比较它们就是比较两个阶段的先后。

在主模块顶层同时注册两者，顺序是不确定的：

```js
setTimeout(() => console.log("setTimeout"), 0);
setImmediate(() => console.log("setImmediate"));
// 两个都先输出过，同一台机器上多跑几次顺序会变
```

原因在计时器那 1 毫秒。主模块执行完后，循环第一圈进到 timers 阶段时，这 1 毫秒过没过去，取决于进程启动耗时和系统调度，纯属竞速。过去了就先跑 setTimeout，没过去就一路走到 poll，再进 check，setImmediate 领先。

但换成在 I/O 回调（也就是正处于 poll 阶段）里注册，胜负就定了：

```js
const fs = require("node:fs");

fs.readFile(__filename, () => {
  setTimeout(() => console.log("setTimeout"), 0);
  setImmediate(() => console.log("setImmediate"));
});
// 输出恒为：setImmediate → setTimeout
```

此刻人在 poll 阶段，这一圈继续往下走就是 check，setImmediate 同圈就能执行；而 timers 在一圈的最前面，setTimeout 必须等下一圈。这是 Node 官方文档用来演示阶段顺序的例子，也是面试的标准答案：主模块里顺序不定，I/O 回调里 setImmediate 一定先。

## 动手任务：`event-loop.js` 一步一步

手册任务：写一个脚本，输出 `setTimeout` / `Promise` / `process.nextTick` 的执行顺序，验证理解。拆成 5 步，全程约 25 分钟。核心纪律：每一步先在纸上写出预测输出，再运行对照，错了就停下找原因，找不出原因不许进下一步。

**第 1 步：建文件。** 在本周的练习目录新建 `event-loop.js`。今天写纯 JavaScript，`node event-loop.js` 直接跑。默认按 CommonJS 处理；万一你的练习目录配了 `"type": "module"` 导致 `require` 报错，把文件后缀改成 `.cjs` 就行。

**第 2 步：小实验一，四种排队方式。** 把下面四行写进 `event-loop.js`，先写预测再运行：

```js
console.log("A 同步代码");
process.nextTick(() => console.log("B nextTick"));
Promise.resolve().then(() => console.log("C Promise.then"));
setTimeout(() => console.log("D setTimeout"), 0);
```

预期输出 `A → B → C → D`，理由就是核心知识第 2 小节那套排位。跑出来一致，说明插队规则你已经拿到了。

**第 3 步：小实验二，每个 timer 之间清一次微任务。** 在文件末尾追加：

```js
setTimeout(() => {
  console.log("timer 甲");
  Promise.resolve().then(() => console.log("甲的微任务"));
}, 0);
setTimeout(() => console.log("timer 乙"), 0);
```

关键问题：甲的微任务会插在甲和乙中间，还是等乙跑完才执行？预期输出是 `D → timer 甲 → 甲的微任务 → timer 乙`。因为 Node 11 起，每个回调执行完就立刻清空 nextTick 和微任务队列，不是攒到整个阶段结束。甲和乙是同一毫秒注册的，在 timers 阶段按注册顺序执行，甲跑完先清它的微任务，乙才轮得上。

**第 4 步：小实验三，顶层竞速。** 单独建个 `race.js`，只放两行：

```js
setTimeout(() => console.log("setTimeout"), 0);
setImmediate(() => console.log("setImmediate"));
```

连跑 5 次。你会看到顺序偶尔翻转，这就是核心知识第 3 小节说的竞速。看完现象，把 `race.js` 删掉，别把它并进主文件，它的不确定性会污染后面的日志。

**第 5 步：拼最终版 + 预测表 + 留日志。** 把 `event-loop.js` 清空，写入整合版。前三步的实验全部搬进一个 I/O 回调里，一是因为从 poll 阶段内部看 check 和 timers 的先后最清楚，二是这样输出完全确定，日志可复现：

```js
// event-loop.js —— 最终版：全部实验收进一个 I/O 回调，输出完全确定
const fs = require("node:fs");

console.log("--- 第 1 部分：同步代码 ---");

fs.readFile(__filename, "utf8", () => {
  // 此刻正处在 poll 阶段的回调里
  console.log("readFile 回调执行（poll 阶段）");

  console.log("--- 第 2 部分：队列优先级 ---");
  process.nextTick(() => console.log("1. nextTick 队列"));
  Promise.resolve().then(() => console.log("2. 微任务：Promise.then"));
  setTimeout(() => console.log("4. setTimeout（下一轮 timers 阶段）"), 0);
  setImmediate(() => console.log("3. setImmediate（本轮 check 阶段）"));

  console.log("--- 第 3 部分：每个回调之间清空微任务 ---");
  setTimeout(() => {
    console.log("timer 甲");
    Promise.resolve().then(() => console.log("甲之后的微任务"));
  }, 0);
  setTimeout(() => console.log("timer 乙"), 0);
});

console.log("--- 第 1 部分：同步代码结束 ---");
```

运行前先填这张预测表，每一行都要写出理由：

| 序号 | 输出行 | 靠什么排队 | 排在这个位置的原因 |
| --- | --- | --- | --- |
| 1 | 第 1 部分：同步代码 | 同步 | 顶层代码从上到下跑完才进事件循环 |
| 2 | 第 1 部分：同步代码结束 | 同步 | 同上 |
| 3 | readFile 回调执行 | poll 阶段 | 主模块只注册了这一个 I/O，循环进 poll 后执行它 |
| 4 | 第 2 部分 / 第 3 部分 两行标题 | 同步 | 回调体本身是同步代码，注册动作不等 |
| 5 | 1. nextTick 队列 | nextTick 队列 | readFile 回调一结束，先清 nextTick |
| 6 | 2. 微任务：Promise.then | 微任务队列 | nextTick 清空后才轮到微任务 |
| 7 | 3. setImmediate | check 阶段 | poll → check 同一圈就走完，不用等下一圈 |
| 8 | 4. setTimeout | timers 阶段 | timers 在下一圈，还要等满 1 毫秒 |
| 9 | timer 甲 | timers 阶段 | 同一圈 timers，按注册顺序 |
| 10 | 甲之后的微任务 | 微任务队列 | 甲这个回调一结束立刻清空 |
| 11 | timer 乙 | timers 阶段 | 排在甲后 |
| 12 | （无） |  | 乙没有注册微任务，循环结束 |

填完再运行，逐行核对。任何一行对不上，回到对应小节找原因，别放过。

::: tip 运行命令
直接跑：`node event-loop.js`。留日志：`node event-loop.js > event-loop.log`，或者直接把终端输出复制存成 `event-loop.log`。多跑几次确认输出稳定，日志和脚本一起算当日产出。
:::

## 常见踩坑

**坑 1：把 `setTimeout(fn, 0)` 当「马上执行」。** 0 会被强制成 1 毫秒，到期后还得排队等循环转回 timers 阶段。Node 里「尽快」其实分三档：想要「本轮回调之后立刻」用 `process.nextTick` 或微任务；想要「本轮循环内、I/O 之后」用 `setImmediate`；`setTimeout(fn, 0)` 是最慢的一档。分不清这三档，写限流、重试、优雅关闭时就会拿到莫名其妙的顺序。

**坑 2：递归 process.nextTick 会饿死整个循环。** 看这段代码：

```js
function hungry() {
  process.nextTick(hungry);
}
hungry();
setTimeout(() => console.log("永远轮不到"), 0);
```

每个 nextTick 回调结束，调度器都先清 nextTick 队列，而这个队列永远清不完，事件循环被钉死在原地，timers 和 I/O 一次都轮不到。官方文档专门警告过这一点。换成 `setImmediate` 递归就能活：check 阶段每圈只执行一批，中间 poll 有机会处理 I/O。微任务同理，递归 `await` 一个立刻 resolve 的 Promise 一样能卡死接口。

**坑 3：在主模块断言 setImmediate 和 setTimeout 的固定顺序。** 顶层注册时两者是竞速关系，不同机器、同机器不同次，结果都可能不同。网上新旧教程结论互相打架，多半只是各自机器上的巧合。要比较就放进 I/O 回调里比，那里 setImmediate 恒先。面试遇到这题，先说「不定」，再讲 poll 和 timers 的位置关系，才拿得到分。

**坑 4：以为微任务只在阶段之间清空一次。** Node 10 及更早版本确实是一个阶段结束时统一清一次微任务，所以老代码和老面试题里会出现 `D → timer 甲 → timer 乙 → 甲的微任务` 这种顺序。Node 11 起改成每个回调执行完立刻清，和浏览器对齐。动手任务第 3 步验证的就是这件事。读旧文章时先看发布日期，把版本差异当成变量。

**坑 5：把浏览器的「宏任务/微任务」二分法原样搬进 Node。** 浏览器里没有 setImmediate，事件循环也不分六阶段；Node 的宏任务分散在 timers、check 等多个阶段里。两边共用的只有一条规则：微任务在每个宏任务回调之后清空，优先级高于一切宏任务。其余细节按各自运行时重新对表，别混着背。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 按顺序说出六个阶段，并各用一句话说清职责。

::: details 参考答案
timers（执行到期的 setTimeout / setInterval 回调）→ pending callbacks（执行上一轮延后的系统级回调，如 TCP 连接错误）→ idle, prepare（libuv 内部使用）→ poll（取出新就绪的 I/O 事件并执行回调，是 I/O 的主战场，没活时会在此等待）→ check（执行 setImmediate 回调）→ close callbacks（执行 socket 关闭这类清理回调），然后回到 timers 开始下一圈。
:::

2. `process.nextTick`、`queueMicrotask`、`setTimeout(fn, 0)`、`setImmediate` 四个都表示「尽快」，典型先后顺序是什么？

::: details 参考答案
nextTick 最先（每个回调结束后第一个清空），微任务第二，之后进入宏任务：在 I/O 回调内 setImmediate 恒先于 setTimeout，因为 poll 后同圈就是 check；在主模块顶层两者顺序不定。没有 context 就别断言 immediate 和 timer 的先后，这是这道题隐藏的考点。
:::

3. 为什么 I/O 回调里 `setImmediate` 一定先于 `setTimeout(fn, 0)` 执行？

::: details 参考答案
I/O 回调在 poll 阶段执行，执行完清空 nextTick 和微任务后，这一圈继续往下就是 check 阶段，setImmediate 的回调同圈就能跑；而 timers 阶段在循环圈的最前面，setTimeout 的回调要等下一圈，外加 1 毫秒的最小延迟。一个是同圈直达，一个是下一圈绕行，胜负没有悬念。
:::

4. 下面代码在 Node 18 上的输出是什么？Node 10 上呢？

```js
setTimeout(() => {
  console.log("甲");
  Promise.resolve().then(() => console.log("微任务"));
}, 0);
setTimeout(() => console.log("乙"), 0);
```

::: details 参考答案
Node 11 及以上（含 18）输出：甲 → 微任务 → 乙。每个回调执行完立刻清空微任务队列，所以微任务插在甲和乙中间。Node 10 及更早输出：甲 → 乙 → 微任务，微任务攒到一个阶段结束才统一清空。
:::

5. 递归 `process.nextTick` 和递归 `setImmediate` 都能无限循环，为什么后果差这么多？

::: details 参考答案
nextTick 队列的清空优先级高于一切阶段调度，递归注册会让队列永远清不完，事件循环停在原地，timers 和 I/O 全部饿死。setImmediate 的回调排在 check 阶段，每圈循环只执行一批，执行完还会走完 poll 等阶段，I/O 和定时器照常有机会运行。所以需要「循环但不阻塞」时用 setImmediate，需要「立刻」但要控制深度时才碰 nextTick。
:::

## 延伸阅读

- [Node.js 官方指南：The Node.js Event Loop, Timers, and process.nextTick()](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)，六阶段、两条队列、setImmediate 对决 setTimeout 的原始出处，本篇每个结论都能在里面找到对应段落
- [libuv 设计概览：The I/O loop](https://docs.libuv.org/en/v1.x/design.html)，事件循环的 C 层实现，想看「轮子」本身怎么转的读这篇
- [Philip Roberts：What the heck is the event loop anyway?](https://www.youtube.com/watch?v=8aGh-ZQkENk)，JSConf EU 的经典演讲，讲的是浏览器事件循环，动画演示直观，「微任务插在宏任务之间」的直觉从这里建立最省力

今天的产出 `event-loop.js` 和 `event-loop.log` 留好。本周后面讲流、网络、进程通信，遇到「这行为什么先执行」时，回来翻这张预测表就行。
