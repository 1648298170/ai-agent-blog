# 第 1 周 · Day 3：类型守卫与类型窄化——驯服 unknown

> 对应手册任务：学习「类型守卫 + 类型窄化：is、asserts、satisfies」；动手任务「为 API 响应写一个 `isUser(data: unknown): data is User` 守卫」；当日产出 `type-guards.ts`。
>
> 一句话：外部数据在编译期没有类型，在运行时不可信任。类型守卫就是横跨这两个世界的桥——运行时做验证，编译时做收窄，一次把两件事都做完。

## 今日目标

1. 说清楚 any 与 unknown 的本质区别，明白为什么 API 响应必须用 unknown 接
2. 掌握编译器自带的窄化手段（typeof / instanceof / in / 判别联合），以及三个进阶工具：is 守卫、asserts 断言函数、satisfies 操作符
3. 亲手写出 `type-guards.ts`：一个逐字段校验 API 响应的 isUser 守卫，串起从 JSON.parse 到安全使用的完整链路

## 概念讲解：any 是谎言，unknown 才诚实

先看一段眼熟的代码：

```ts
async function loadUser(): Promise<void> {
  const res = await fetch('/api/user')
  const data: any = await res.json()
  console.log(data.name.toUpperCase())
}
```

标上 any 之后一路绿灯。但这行代码在运行时会遇到什么，完全取决于服务端今天的心情：正常时返回 `{ "id": 1, "name": "jerry" }`，没事；服务端把 name 改成 userName，`data.name` 就是 undefined，`.toUpperCase()` 直接抛 TypeError；网关返回 500 的 HTML 错误页，或者响应体根本不是合法 JSON。这些情况编译期全都安静如鸡。

类型断言也一样：

```ts
const data = JSON.parse('{"id":1}') as { id: number; name: string; email: string }
// 编译期：通过。运行时：data.name 是 undefined，toUpperCase() 抛 TypeError
console.log(data.name.toUpperCase())
```

`as` 不执行任何检查，它只是命令编译器闭嘴。问题没有消失，只是从「写代码的第十分钟」推迟到了「线上报警的凌晨三点」。

unknown 是另一种态度：「我不知道里面是什么，你想用，先证明给我看」。

```ts
const data: unknown = JSON.parse('{"id":1}')

// @ts-expect-error 'data' 是 'unknown'，不能直接读属性
console.log(data.name)
```

报错是好事。编译器在提醒你：这里是系统边界，边界之外的数据没有类型。你接下来几周要大量消费 LLM API——模型返回的 JSON 天生不可信，字段可能缺、类型可能变、内容可能是模型瞎编的。今天学的就是对付这件事的基本功。

## 核心知识

### 1. 类型窄化：编译器自己会做的事

窄化（narrowing）指在代码的某个分支里，值的类型被收窄成更具体的类型。最常见的是 typeof：

```ts
function formatId(id: string | number): string {
  if (typeof id === 'string') {
    // 这个分支里，id 是 string
    return id.trim()
  }
  // 走到这里只剩一种可能：number
  return id.toFixed(0)
}
```

instanceof 认原型链，处理错误对象很常用：

```ts
function reportError(err: unknown): void {
  if (err instanceof Error) {
    console.error(err.message) // err 已收窄为 Error
  } else {
    console.error(String(err))
  }
}
```

in 检查属性是否存在，适合字段不同的接口联合：

```ts
interface Bird {
  flySpeed: number
}
interface Fish {
  swimSpeed: number
}

function topSpeed(animal: Bird | Fish): number {
  if ('flySpeed' in animal) {
    return animal.flySpeed // 收窄为 Bird
  }
  return animal.swimSpeed // 收窄为 Fish
}
```

最重要的是判别联合（discriminated union）：给每个成员加一个字面量字段（习惯上叫 kind 或 type），然后 switch 它：

```ts
// LLM 流式接口的典型 chunk 设计
type StreamChunk =
  | { kind: 'text'; content: string }
  | { kind: 'tool_call'; tool: string; args: string }
  | { kind: 'done'; reason: string }

function handleChunk(chunk: StreamChunk): void {
  switch (chunk.kind) {
    case 'text':
      console.log(chunk.content) // chunk 只剩 text 成员
      break
    case 'tool_call':
      console.log(chunk.tool, chunk.args)
      break
    case 'done':
      console.log('结束原因：', chunk.reason)
      break
  }
}
```

kind 一确定，编译器自动把 chunk 收窄到对应成员，`chunk.content` 直接可用，一个断言都不用写。

::: tip
后面处理 LLM 的流式响应（SSE chunk）时，判别联合是标准姿势：先定义 chunk 类型，再写 handler。结构确定在手，比拿到 JSON 再猜要稳得多。
:::

### 2. 自定义守卫：is

上面的手段只认得编译期已知的联合。API 响应的起点是 unknown，编译器对它一无所知，得你自己写守卫。语法是返回类型位置上的 `x is User`：

```ts
interface User {
  id: number
  name: string
  email: string
}

function isUser(x: unknown): x is User {
  if (typeof x !== 'object' || x === null) return false
  const u = x as Record<string, unknown>
  return (
    typeof u.id === 'number' &&
    typeof u.name === 'string' &&
    typeof u.email === 'string'
  )
}
```

返回类型 `x is User` 叫类型谓词（type predicate）。效果：

```ts
const data: unknown = JSON.parse('{"id":1,"name":"jerry","email":"j@a.com"}')

if (isUser(data)) {
  // data 自动收窄为 User
  console.log(data.email.toUpperCase())
} else {
  // data 仍然是 unknown
  console.log('数据不合法，拒绝处理')
}
```

守卫返回 true，if 分支里的 data 就是 User；返回 false，else 分支里它还是 unknown。编译器完全信任你的谓词——记住这几个字，踩坑一节会回到这里。

守卫内部就是普通代码：先 typeof 过第一道门，再用 `as Record<string, unknown>` 把「某个对象」变成「键值都不知道的对象」，然后逐字段检查。这个 as 是可以接受的小妥协（前一行已确认是对象），但别把它带出守卫函数。

### 3. asserts 断言函数

is 的句式是「问一句」，asserts 的句式是「不是就炸」：

```ts
function assertIsUser(x: unknown): asserts x is User {
  if (!isUser(x)) {
    throw new Error(`非法的 User 数据：${JSON.stringify(x)}`)
  }
}

const payload: unknown = JSON.parse('{"id":1,"name":"jerry","email":"j@a.com"}')
assertIsUser(payload)
// 能走到这里，payload 就已经是 User——不合法的情况在上面就抛错了
console.log(payload.name)
```

`asserts x is User` 的语义：函数正常返回，则调用点之后 x 收窄为 User；函数抛错，程序根本走不到后面。这种失败即中断的风格叫 fail fast，适合放在系统入口，比如拿到 API 响应的第一时间。

怎么选：

| 场景 | 选择 |
| ---- | ---- |
| 数据可能不合法，需要兜底分支（降级 UI、记日志） | is 守卫 + if/else |
| 数据不合法就没法继续，早死早超生 | asserts 断言函数 |

两个细节：asserts 必须显式标注返回类型，写成箭头函数也得标；它的调用必须是独立语句，不能塞进表达式里当值用。

### 4. satisfies 操作符

TS 4.9 引入，一句话：检查归检查，推导归推导。先看问题：

```ts
interface AgentConfig {
  model: string
  temperature: number | 'auto'
}

// 写法一：satisfies——检查通过，且保留每个属性的具体类型
const tuned = {
  model: 'glm-4.6',
  temperature: 0.3
} satisfies AgentConfig

// tuned.temperature 的类型收在 number 上，直接参与计算
const doubled = tuned.temperature * 2

// 写法二：类型注解——检查通过，但类型被抬宽成声明类型
const annotated: AgentConfig = { model: 'glm-4.6', temperature: 0.3 }

// @ts-expect-error annotated.temperature 是 number | 'auto'，'auto' 分支不能乘
const tripled = annotated.temperature * 3
```

再看字面量那一侧：

```ts
const autoCfg = {
  model: 'glm-4.6',
  temperature: 'auto'
} satisfies AgentConfig
// autoCfg.temperature 的类型是字面量 'auto'，而不是 number | 'auto'
```

satisfies 也真的会拦错误，这点和 as 截然不同：

```ts
// 下面这段编译会报错：'hot' 不能赋给 number | 'auto'
const wrong = {
  model: 'glm-4.6',
  temperature: 'hot'
} satisfies AgentConfig
```

三种写法各自丢什么：注解 `:` 丢掉属性的具体类型（抬宽）；`as` 丢掉检查，尤其是来源是 any 时畅通无阻；satisfies 两个都保留。写配置对象、路由表、主题色这类「要检查、又要保字面量」的常量时，优先 satisfies。

::: warning
satisfies 全程发生在编译期。它不能验证运行时数据——拿 API 响应来 satisfies 没有意义，验证外部数据是 isUser 的活，别搞混。
:::

## 动手任务：isUser 守卫一步一步

产出文件 `type-guards.ts`，共五步。

**第 1 步：定义 User 接口**

```ts
interface User {
  id: number
  name: string
  email: string
  tags: string[]
  createdAt: string // JSON 里没有 Date 类型，日期只能是字符串（ISO 8601）
}
```

createdAt 用 string 有讲究：JSON 规范里没有日期类型，JSON.parse 永远给不出 Date 对象。想表达「这是个合法日期」，靠 Date.parse 校验格式，而不是把类型写成 Date 骗自己。

**第 2 步：isUser 骨架，先过「是不是对象」这道门**

```ts
function isUser(x: unknown): x is User {
  if (typeof x !== 'object' || x === null) return false
  const u = x as Record<string, unknown>
  return true // 逐字段校验，下一步补全
}
```

两个要点。第一，两个条件必须一起写；第二，`as Record<string, unknown>` 在这里是安全的，作用是把「未知的东西」变成「键和值都未知的对象」，后面才写得出 `u.id`。

::: warning
`typeof null` 的结果也是 `'object'`，这是 JS 的历史遗留坑。只写 `typeof x === 'object'`，null 会溜进下一关。
:::

**第 3 步：逐字段校验，数组和日期单独处理**

```ts
function isUser(x: unknown): x is User {
  if (typeof x !== 'object' || x === null) return false
  const u = x as Record<string, unknown>
  return (
    typeof u.id === 'number' &&
    typeof u.name === 'string' &&
    typeof u.email === 'string' &&
    Array.isArray(u.tags) &&
    u.tags.every((tag) => typeof tag === 'string') &&
    typeof u.createdAt === 'string' &&
    !Number.isNaN(Date.parse(u.createdAt))
  )
}
```

普通字段逐个 typeof。数组先用 Array.isArray（它同时完成收窄，u.tags 变成 any[]），再用 every 检查每个元素。日期先确认是 string，再让 Date.parse 说话：解析失败返回 NaN，所以用 Number.isNaN 挡掉「长得像字符串但不是日期」的值。

守卫的写法心法：又笨又直，一个字段一行。它的读者不是编译器（编译器只信你的返回值），是三个月后改接口的你自己。

**第 4 步：串起 JSON.parse 的完整链路**

```ts
const raw =
  '{"id":1,"name":"jerry","email":"j@a.com","tags":["admin","dev"],"createdAt":"2026-09-16T09:00:00Z"}'

const data: unknown = JSON.parse(raw)

if (isUser(data)) {
  // data 是 User
  console.log(`欢迎，${data.name}！标签：${data.tags.join('、')}`)
} else {
  // data 是 unknown
  console.log('数据不合法，拒绝处理')
}
```

注意 `const data: unknown = JSON.parse(raw)` 这个显式标注：JSON.parse 的返回类型是 any，不标注的话 any 会一路传染。在边界处用 unknown 接住，是整个链路的起点。

**第 5 步：看看失败时的样子**

```ts
const badRaw = '{"id":1}' // 缺了一大半字段
const bad: unknown = JSON.parse(badRaw)

if (isUser(bad)) {
  console.log(bad.name)
} else {
  // @ts-expect-error else 分支里 bad 依然是 unknown，编译器不放过你
  console.log(bad.name)
}
```

守卫返回 false 不会得到一个「反向 User」，unknown 就是 unknown。想在这个分支用 bad，要么继续验证，要么安全地放弃。

最后把 asserts 版本也放进文件，给入口处快速失败用：

```ts
function assertIsUser(x: unknown): asserts x is User {
  if (!isUser(x)) {
    throw new Error(`非法的 User 数据：${JSON.stringify(x)}`)
  }
}
```

存盘，`type-guards.ts` 完成。

## 常见踩坑

**坑 1：as User 是断言，不是转换。** 它不执行任何运行时代码，数据该缺字段还是缺，该崩还是崩。as 的潜台词是「我知道我在干什么」——前提是你真的知道。对 API 响应用 as，等于闭着眼睛过马路。

**坑 2：any 能读属性，unknown 不能，这正是 any 危险的原因。**

```ts
const a: any = JSON.parse('{"id":1}')
a.name.foo.bar // 编译通过，运行时 TypeError

const u: unknown = JSON.parse('{"id":1}')
// @ts-expect-error unknown 上不允许读属性
u.name
```

any 不是「任何类型」，是「关闭检查」。unknown 能装下任何值，但用之前必须先收窄。新代码里想写 any 的地方，先问一句：我是不是其实想要 unknown？

**坑 3：守卫逻辑写错，编译器不背锅。** 编译器信任谓词的返回值，不审查你的校验代码。isUser 里忘了检查 email，返回 true 的瞬间 data 就被当成 User，email 在运行时是 undefined。类型谓词本质上是程序员向编译器立下的承诺。对策：结构复杂时手写守卫容易漏，第 3 周会引入 zod——声明 schema、自动生成守卫，把「写错校验」的空间大幅压缩。本篇只预告，不展开。

**坑 4：JSON.parse 返回 any，别让它传染。** 从 parse 到你的业务代码之间没有任何防线。第一行就用 unknown 变量显式接住，让 any 的活动范围止步于边界。

**坑 5：asserts 不是「更强的 is」。** asserts 的语义是抛错中断，用在「不合法就无法继续」的入口；需要在 else 分支做降级处理（错误 UI、日志上报）时，老老实实用 is。另外 asserts 函数漏写返回类型标注时，TS 会把它当普通函数，调用点不会收窄。

## 自测问题

**问题 1：`const data = JSON.parse(raw) as User` 和 `if (isUser(data))` 都能让后续代码把 data 当 User 用，本质区别是什么？**

::: details 查看答案
as 只影响编译期，零运行时检查，数据非法时错误延迟到使用现场才爆。isUser 在运行时真的逐字段验证，失败走 else 分支，类型收窄建立在真实检查之上。
:::

**问题 2：判别联合为什么能收窄？把 kind 字段删掉、改成三个可选字段会发生什么？**

::: details 查看答案
判别字段在每个成员里是不同的字面量（'text'、'tool_call'、'done'），比较一次就能唯一确定成员。改成可选字段后，多个成员可能同时「看起来匹配」，编译器无法唯一排除其他成员，只能停在宽类型上，取字段就得加断言。
:::

**问题 3：is 和 asserts 各适合什么场景？**

::: details 查看答案
is 适合「数据可能不合法，我要有兜底」：if/else 两个分支分别处理。asserts 适合「不合法就没必要继续」：入口处 fail fast，抛错中断，调用点之后自动收窄。
:::

**问题 4：类型注解、as、satisfies 三种写法各丢掉什么？**

::: details 查看答案
注解丢掉每个属性的具体类型（抬宽成声明类型）；as 丢掉检查（来源是 any 时畅通无阻）；satisfies 检查和具体类型都保留，但它只管编译期，验证不了运行时数据。
:::

**问题 5：为什么 User 的 createdAt 定义为 string 而不是 Date？**

::: details 查看答案
JSON 规范没有日期类型，JSON.parse 只能产出 string、number、boolean、null、数组、对象。写成 Date 是编译期谎言；正确做法是定义为 string，在守卫里用 Date.parse 校验格式，需要时再 `new Date(u.createdAt)`。
:::

## 延伸阅读

- [TypeScript Handbook：Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)——本篇主题的官方完整版
- [TypeScript 3.0 发布说明：unknown 类型](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html#new-unknown-top-type)
- [TypeScript 4.9 发布说明：satisfies 操作符](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
- [zod 官网](https://zod.dev)——第 3 周的主角，schema 即守卫
