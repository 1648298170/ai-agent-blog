# 第 3 周 · Day 7：周复盘——把「应该没问题」变成「亲手验过」

> 手册任务：周复盘 + 整理。用 curl 测一遍所有接口，写 300 字周记，当日产出：接口测试记录 + 周记。
> 本篇解决的问题只有一个：本周写了一堆装饰器和分层代码，怎么确认它们拼起来真的能跑，而不是「看着应该没问题」。

## 今日目标

1. 把 `/users` 的 CRUD 和校验场景用 curl 逐条测完，记下预期与实际的差异
2. 按四段模板写一篇 300 字周记
3. 过一遍 10 题自检清单，答不上来的标记出来，回读对应 Day 的教程
4. 把接口清单整理进 `apps/api/README.md`，本周产出收口

## 概念讲解：为什么要逐条 curl，而不是看着代码点头

先复述[第 1 周 Day 7](/week01/day7) 的结论：识别和提取是两回事。读代码时你认得每一行，这叫识别；把服务跑起来、请求发进去、拿到预期响应，这叫提取。本周尤其需要这一步，因为 NestJS 应用的正确性大头不在你的代码里，而在框架的运行时装配里。

「看着应该没问题」有三个盲区。

第一，类型检查管不到请求体。`tsc` 查不出 `.env` 漏配（[Day 2](/week03/day2) 讲过），同理它也查不出 POST 过来的 email 是不是合法邮箱。校验装饰器写对了没有，只有真的发一条脏数据进去、看到 400，才算数。

第二，框架的装配发生在运行时。[Day 3](/week03/day3) 提过一个坑：Controller 忘了登记进 Module 的 `controllers` 数组，编译零报错，请求直接 404。这类问题盯着代码看很难看出来，发一个请求立刻现形。

第三，HTTP 是契约，客户端只认状态码和响应体。你脑子里的「POST 创建成功」和客户端实际收到的 201 加一段 JSON 是两回事，中间隔着序列化、管道、异常过滤器好几层。

还有一层价值：回归。本周 `/users` 被改了三轮，Day 4 写 Controller，Day 5 抽 Service，Day 6 加校验，每次重构都可能弄坏上一轮的行为。今天把全套接口重跑一遍，就是在确认前六天的东西都还活着。这份清单以后就是 e2e 测试的草稿，测试代码不过是把 curl 一条条翻译成脚本。

| 输出方式 | 逼出什么 | 对应今天的产出 |
| --- | --- | --- |
| curl 逐条过 | 契约是否真的兑现 | 接口测试记录 |
| 写作 | 概念是否真的理解 | 300 字周记 |
| 自测 | 细节是否记牢 | 10 题自检清单 |

## 核心知识

### 1. curl 清单：/users 全套逐条过

先说约定：api 跑在 4000 端口（Day 3 定的，web 占 3000），用户字段以 `name`、`email` 为例，字段和你的实现对不上就换成你的，方法不变。起服务：

```bash
pnpm --filter api dev
```

测试链有顺序讲究：先看空列表，再 POST 造数据，GET 应该看得见，PUT 改，DELETE 删，最后再 GET 确认真没了。数据自造自销，不留垃圾。

| # | 场景 | 预期状态码 | 响应示例 |
| --- | --- | --- | --- |
| 1 | GET /users 列表 | 200 | `[]`（首次）或用户数组 |
| 2 | GET /users/1 单个 | 200 | `{"id":1,"name":"Jerry","email":"jerry@example.com"}` |
| 3 | GET /users/999 不存在 | 404 | `{"message":"…","error":"Not Found","statusCode":404}` |
| 4 | POST /users 合法数据 | 201 | 新建的用户对象，带 id |
| 5 | POST /users 非法 email | 400 | `{"message":["email must be an email"],"error":"Bad Request","statusCode":400}` |
| 6 | PUT /users/1 更新 | 200 | 更新后的用户对象 |
| 7 | DELETE /users/1 删除 | 200 | 响应体为空（若你的实现返回被删对象，如实记录） |

404 和 400 的 message 文案以你的实现为准，但外层三个字段的结构不变，记的时候看结构。命令清单，编号对应表格：

```bash
# 1. 列表
curl http://localhost:4000/users

# 2. 单个
curl http://localhost:4000/users/1

# 3. 不存在的 id
curl http://localhost:4000/users/999

# 4. 合法创建（201）
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Jerry","email":"jerry@example.com"}'

# 5. 非法 email（400）
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Jerry","email":"not-an-email"}'

# 6. 更新
curl -X PUT http://localhost:4000/users/1 \
  -H "Content-Type: application/json" \
  -d '{"name":"Jerry Updated"}'

# 7. 删除
curl -X DELETE http://localhost:4000/users/1
```

两个提醒。一，POST 成功是 201 不是 200，这是 NestJS 对 `@Post()` 的默认约定，不看文档猜不到。二，400 的响应体别略过，`message` 数组就是 class-validator 报出来的字段错误，它正是 Day 6 那套校验的产出。想连响应头一起看，给命令加 `-i`。

### 2. Windows PowerShell：引号的坑与 Invoke-RestMethod 等价写法

Day 3 提过第一个坑：PowerShell 里的 `curl` 是 `Invoke-WebRequest` 的别名，想用真 curl 得写 `curl.exe`。今天必然要发 JSON，会撞上第二个坑：引号。

单引号字符串在 PowerShell 里原样传值，JSON 里又全是双引号，两者本该相安无事。但 PowerShell 5.1 把参数交给原生程序时有个缺陷：参数里带空格就自动包一层双引号，而且不转义内部已有的双引号。于是 `{"name": "Jerry"}`（冒号后带空格）会被拆得支离破碎，服务端收到的根本不是合法 JSON，返回 400。这时你很容易怀疑自己的校验写错了，其实是客户端把数据弄坏了。

两个解法。解法一，JSON 写紧凑，逗号冒号后都不留空格：`'{"name":"Jerry","email":"jerry@example.com"}'`，没有空格就没有包装环节，curl.exe 能原样收到。解法二，推荐：Windows 上干脆用 `Invoke-RestMethod`，它直接拿 PowerShell 字符串当请求体，引号问题从根上不存在。等价命令：

```powershell
# 1. 列表
Invoke-RestMethod http://localhost:4000/users

# 2. 单个
Invoke-RestMethod http://localhost:4000/users/1

# 4. 合法创建
Invoke-RestMethod -Method Post http://localhost:4000/users `
  -ContentType 'application/json' `
  -Body '{"name":"Jerry","email":"jerry@example.com"}'

# 5. 非法 email：4xx 时 Invoke-RestMethod 抛异常，用 try/catch 接
try {
  Invoke-RestMethod -Method Post http://localhost:4000/users `
    -ContentType 'application/json' `
    -Body '{"name":"Jerry","email":"not-an-email"}'
} catch {
  $_.Exception.Response.StatusCode.value__  # 输出 400
  $_.ErrorDetails.Message                   # 响应体，能看到 message 数组
}
```

PUT 和 DELETE 不带请求体，参数同 POST，方法换成 `-Method Put`、`-Method Delete` 即可。注意 4xx 在 `Invoke-RestMethod` 眼里是异常，清单里第 3 条的 404 也要照第 5 条那样 try/catch 接住，记录状态码靠 catch 里的 `StatusCode`。较新的 PowerShell 7 给 `Invoke-WebRequest` 加了 `-SkipHttpErrorCheck` 参数，4xx 不再抛异常，有条件可以升级着用。

### 3. 300 字周记模板

周记记认知变化，不记流水账。固定四段，每段一两句，总共 300 字上下：

1. **本周最大的收获**：用自己的话说，禁止抄教程原句，抄得出来说明没消化
2. **卡得最久的一个问题**：以及怎么解决的。这段最值钱，下周大概率还会撞上同类问题
3. **还含糊的概念**：诚实列出来。写这段不丢人，它是下周的输入
4. **下周开始前要补什么**：留具体动作，别写「多练习」这种空话

第 3 周示例，照这个密度写：

```text
① 本周最大收获：后端代码分了层之后，每层都可替换。Controller 只做
翻译，Service 不碰 HTTP，Module 管装配。加上 zod 在启动时校验配置，
程序从第一秒起就只跑在「输入已验证」的状态里。
② 卡得最久：用 curl 测 POST 一直 400，查了一小时校验装饰器，最后发
现是 PowerShell 把 JSON 的引号拆了，服务端根本没收到合法数据。教训：
先怀疑客户端，再怀疑服务端。
③ 还含糊：poll 阶段和 check 阶段的边界细节；DI 容器怎么处理循环依
赖。
④ 下周前补：把 Day 1 的事件循环脚本脱稿写一遍，重点六阶段的触发时
机。
```

### 4. 第 3 周自检清单

规则同第 1 周：每题先口头回答，说完整了再点开答案对照。口头说不出来的记下题号，回读对应 Day 的教程。

**问题 1：事件循环六个阶段按顺序报一遍，各自负责什么？（Day 1）**

::: details 答案
timers（执行到期的 setTimeout/setInterval 回调）→ pending callbacks（执行上一轮延迟的系统回调）→ idle, prepare（内部使用）→ poll（取新 I/O 事件并执行 I/O 回调）→ check（执行 setImmediate）→ close callbacks（处理关闭事件）。每阶段之间，微任务队列会被清空。
:::

**问题 2：process.nextTick 和 Promise.then 都是微任务，谁先执行？（Day 1）**

::: details 答案
nextTick 先。Node 内部维护两个队列，nextTick 队列优先级高于 Promise 微任务队列，清空时先清完 nextTick 再清 Promise。因为 nextTick 能无限插队饿死 I/O，一般场景建议用 Promise。
:::

**问题 3：setImmediate 和 setTimeout(fn, 0) 谁先执行？（Day 1）**

::: details 答案
主模块里顺序不确定，取决于进程启动耗时，谁先都可能。但在 I/O 回调内部，setImmediate 永远先于 setTimeout：I/O 回调所在的 poll 阶段之后紧跟着 check 阶段，而 timers 要等下一轮循环。这也是 setImmediate 存在的意义，给当前周期一个确定的后置时机。
:::

**问题 4：ESM 里拿当前文件所在目录，正确写法是什么？（Day 2）**

::: details 答案
`const __dirname = path.dirname(fileURLToPath(import.meta.url))`。`__dirname` 是 CJS 模块包装函数的参数，ESM 取消了这层包装，改用标准的 `import.meta`。
:::

**问题 5：配置为什么要在启动时用 zod 校验，而不是等用到时再报错？（Day 2）**

::: details 答案
启动即崩有三个好处：错误离病因最近，堆栈清晰；所有缺失项一次列全，不用修一个跑一次；进程非零退出，部署脚本和容器能感知失败。运行到一半才崩，服务可能已经处理过请求，排查完全是另一个量级。
:::

**问题 6：Module、Controller、Provider 的职责各用一句话说清。谁来 new Service？（Day 3）**

::: details 答案
Module 是装配清单，登记本模块有哪些控制器和服务；Controller 接请求、调服务、回响应，不写业务；Provider（Service）承载业务，不碰 HTTP 概念。实例化由 Nest 的 DI 容器完成，业务代码里不该出现 `new UsersService()`。
:::

**问题 7：NestJS 的依赖注入默认是单例吗？意味着什么？（Day 5）**

::: details 答案
是，默认作用域是 Singleton，整个应用一份实例，所有注入它的地方共享同一份状态。要「每请求一个实例」得显式改成 Request 作用域，但那会带来性能开销，非必要不动。
:::

**问题 8：DTO 为什么必须用 class，不能用 interface？（Day 4）**

::: details 答案
interface 编译后就被擦除，运行时不存在；class 加上装饰器后，元数据保留到运行时，class-validator 靠这些元数据做校验。ValidationPipe 在运行时干活，它只认得 class。
:::

**问题 9：ValidationPipe 的 whitelist 和 transform 各做什么？（Day 6）**

::: details 答案
whitelist 把请求体里多余的字段剥掉，凡是 DTO 上没挂装饰器的属性一律不进处理链（配合 forbidNonWhitelisted 可以改成直接 400）；transform 把普通对象转换成 DTO 类的实例，要连类型一起自动转换（比如把 query 里的字符串转成 number）得再开 enableImplicitConversion 选项。
:::

**问题 10：什么是胖控制器？拿什么标准判断？（Day 3、Day 5）**

::: details 答案
业务逻辑堆进 Controller，Service 形同虚设。判断标准一条：这个方法离开 HTTP 还能不能测。Controller 里出现了数据存储操作和成段业务分支，就是胖了，该下沉到 Service。
:::

::: tip 全对也别飘
全对说明第 3 周及格，不说明可以跳过收尾。curl 记录、周记、README 三件事做完，本周才算收口。这是第二次走这套流程，动作应该比第 1 周快。
:::

## 动手任务：接口清单进 README，本周收口

按顺序做完五步，预计 75 到 90 分钟。

**第一步：逐条过 curl 清单（25 分钟）**

起服务，对照 7 条表格逐条执行。开个文本文件，每条记两样：实际状态码、和预期的差异。预期不符的就是下周的 bug 单，能当场修更好。

**第二步：把接口清单整理进 apps/api/README.md（20 分钟）**

脚手架生成的 README 是模板货，替换成自己的契约文档。给一份骨架，往里填：

```markdown
# apps/api

NestJS 后端服务，本周承载 /users CRUD。

## 启动

pnpm --filter api dev    # 监听 http://localhost:4000

## 接口清单

| 方法 | 路径 | 说明 | 请求体 | 成功状态码 |
| --- | --- | --- | --- | --- |
| GET | /users | 用户列表 | 无 | 200 |
| GET | /users/:id | 单个用户，不存在返回 404 | 无 | 200 |
| POST | /users | 创建用户，非法字段返回 400 | `{ "name", "email" }` | 201 |
| PUT | /users/:id | 更新用户 | 同上 | 200 |
| DELETE | /users/:id | 删除用户 | 无 | 200 |

## 校验规则

<!-- 把 Day 6 你自己定的规则填进来，例如 name 的长度下限、email 格式 -->

## 示例

curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Jerry","email":"jerry@example.com"}'
```

README 的读者是未来的你和同事，写「怎么调」，不写「怎么实现」。校验规则那段刻意留了占位：按你在 Day 6 实际写的装饰器填，别照抄别处的。

**第三步：写 300 字周记（15 分钟）**

按四段模板写，对照示例的密度。「还含糊」那段别敷衍，它是下周的补课清单。

**第四步：10 题自检（15 分钟）**

逐题口头回答，答不上的记下题号和对应的 Day，回读该 Day 的对应小节。回读也算复盘的一部分。

**第五步：git 收尾（10 分钟）**

```bash
git add apps/api
git commit -m "docs(api): 接口清单与测试记录"
git tag week03-done
```

## 常见踩坑

**只看状态码不看响应体。** 看到 200 就点头，没发现返回的对象多了或少了一层。契约包括状态码、响应体、响应头三样，curl 加 `-i` 一次看全。

**POST 返回 400 就去查校验装饰器。** 先排除客户端：PowerShell 拆引号是最常见的冤案，换 `Invoke-RestMethod` 或到 cmd 里用 `curl.exe` 重发一遍，400 还在才回头查服务端。排查顺序永远是：先确定服务端收到了什么，再讨论服务端处理得对不对。

**README 写成实现说明。** 大段贴 Controller 源码，讲自己用了什么装饰器。调用者不关心实现，只关心路径、方法、请求体、状态码。实现变了 README 不用动，契约变了才要动，这是分界线。

**复盘变成重读教程。** 把 Day 1 到 Day 6 又刷了一遍，接口一条没测。判断标准还是那条：合上资料，题答得出、接口测得完、图和清单拿得出手。

## 延伸阅读

- [NestJS 官方文档：Validation](https://docs.nestjs.com/techniques/validation)，ValidationPipe、whitelist、transform 的完整说明，Day 6 那套的官方版
- [NestJS 官方文档：Pipes](https://docs.nestjs.com/pipes)，管道的执行时机和自定义方法
- [MDN：HTTP 响应状态码](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status)，201、400、404 这些数字的权威定义
- [Everything curl](https://everything.curl.dev/)，`-i`、`-v`、`-X` 的更多用法，接口排查的瑞士军刀

下周开始前，把周记第四段留的动作清掉，把清单里预期不符的条目修掉。第 3 周到此收口。
