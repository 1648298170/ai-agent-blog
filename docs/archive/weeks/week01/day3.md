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

两个使用细节，都是从签名语义推出来的，各配一组正误示例：

**细节一：返回类型必须显式标注，箭头函数也一样。** `asserts x is User` 本身就写在「返回类型」的位置——它不是函数体的描述，是给编译器的承诺书。窄化由**签名**驱动，不由函数体驱动：

```ts
// ❌ 没写返回类型标注：这是个普通的 void 函数
//    函数体里 throw 得再坚决，调用后 payload 依然是 unknown——没有窄化
function badAssert(x: unknown) {
  if (!isUser(x)) throw new Error('非法数据')
}
badAssert(payload)
// console.log(payload.name) // ❌ 报错：payload 还是 unknown

// ✅ 函数声明：asserts 写在返回类型位置
function assertIsUser(x: unknown): asserts x is User { /* ... */ }

// ✅ 箭头函数：同样写在参数列表后面的返回类型位置，一个字都不能省
const assertIsUserArrow = (x: unknown): asserts x is User => {
  if (!isUser(x)) throw new Error(`非法的 User 数据：${JSON.stringify(x)}`)
}
```

记住这条判定：**少写标注不会报错，但断言会静默失效**——比报错更危险，你以为有保护其实没有。

**细节二：调用必须是独立语句，不能塞进表达式里当值用。** 断言的「返回值」不是给表达式的，是给「调用点之后的代码」的类型影响——塞进赋值、条件、回调里，这个语义就不成立了，TS 会直接拒绝：

```ts
// ❌ 当值用：没有值可拿（void），而且窄化语义被破坏
// const ok = assertIsUserArrow(payload)

// ❌ 塞进逻辑表达式 / 条件里当布尔用
// if (payload !== null && assertIsUserArrow(payload)) { ... }

// ✅ 唯一正确姿势：单独一行，让「之后的代码」享受窄化
assertIsUserArrow(payload)
console.log(payload.name) // ✅ User
```

顺带一个相关的坑：**间接调用也会失效**。断言函数通过「没有显式类型的名字」被调用时（赋给别名、从对象里解构出来、三元里二选一），编译器追踪不到「这个名字一定是那个断言函数」，会报错 `Assertions require every name in the call target to be declared with an explicit type annotation`——要么直接用原名单独调用，要么给中转变量写显式的断言函数类型标注。

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

### 5. is / asserts / satisfies：三把刀怎么选

前三个小节各学了一把刀，现在摆在一张桌上对比。它们名字里都带着“类型检查”的味道，但回答的是三个不同的问题：

| | `is` 守卫函数 | `asserts` 断言函数 | `satisfies` 操作符 |
| --- | --- | --- | --- |
| **引入版本** | TS 2.0（2016-07） | TS 3.7（2019-11，与 `?.`/`??` 同版） | TS 4.9（2022-11） |
| **校验逻辑跑在哪** | JS 运行时（TS 没有运行时，见下方说明） | JS 运行时（TS 没有运行时，见下方说明） | 不跑——纯编译期检查 |
| **类型窄化时机** | 编译期（`is` 签名驱动） | 编译期（`asserts` 签名驱动） | 不窄化 |
| **失败时的表现** | 返回 `false`，走 else 分支 | 抛异常，中断执行 | 直接编译报错，代码跑不起来 |
| **对类型的影响** | true 分支内**窄化** | 函数调用后**窄化** | **不改变类型**，只验证兼容性 |
| **返回值** | `boolean` | `void` | 无（表达式的一部分） |
| **典型场景** | 验证外部数据（API/用户输入）、判别联合收窄 | “到这里它必然是 X”的兜底断言、库的入口校验 | 配置对象、路由表等**字面量常量**的检查 |

**先说清一件事：TS 没有运行时。** 表格里「JS 运行时」这四个字值得单独一节解释，因为它牵出 TypeScript 最根本的机制——**类型擦除（type erasure）**。

`.ts` 编译成 `.js` 的那一刻，所有类型层的东西整体蒸发：泛型参数、接口、`x is User` 的签名、`asserts x is User` 的断言标注、`satisfies`——全部不会出现在产物里。产物是不含任何类型信息的纯 JavaScript，跑在 Node 或浏览器这些 **JS 运行时**里。所以 is / asserts 其实是「双面人」，两副面孔分别活在两个世界：

1. **类型窄化——编译期**。`if (isUser(x))` 之后 x 变成 User，这是 tsc 在类型检查阶段干的活，依据是签名里那句 `x is User`；窄化完成后，签名就被擦掉了
2. **实际校验逻辑——JS 运行时**。你写的 `typeof x === 'object' && 'id' in x`、`throw new Error(...)`，编译后就是普通 JS 代码，和「类型」再无关系

眼见为实，看 `isUser` 编译前后：

```ts
// 源码（.ts）——签名对编译器说话
function isUser(x: unknown): x is User {
  return typeof x === 'object' && x !== null && 'id' in x && typeof x.id === 'number';
}
```

```js
// 产物（.js）——「: x is User」整段蒸发，只剩逻辑
function isUser(x) {
  return typeof x === 'object' && x !== null && 'id' in x && typeof x.id === 'number';
}
```

产物里的 `isUser` 根本不知道"User"是什么——它只是一个返回布尔值的普通函数。

这个事实顺带解释了本篇前面的两个伏笔：**第 1 天的坑「泛型是编译期的，运行时不存在」，现在可以把话说全——TS 的一切类型层构造都没有运行时**；**「守卫逻辑写错编译器不背锅」的原因也在这**——签名向编译器承诺"返回 true 则是 User"，但产物里实际执行的是你那段 JS，它判得对不对，编译期无从验证。至于 satisfies，它是三个里最「轻」的：纯编译期检查，擦除后连影子都不剩。

两张表还不过瘾，用同一段数据把三种方式各跑一遍，看“失败行为”和“类型影响”的差异最直观：

```ts
// 同一个 data: unknown，三种处理姿势

// 姿势一：is——宽容路线。不是 User？没关系，走 else 分支处理
if (isUser(data)) {
  console.log(data.name); // 窄化成 User
} else {
  console.log('数据不合法，给用户一个友好提示'); // 程序继续跑
}

// 姿势二：asserts——严格路线。不是 User？当场崩，不往下走
assertIsUser(data);
console.log(data.name); // 断言后窄化成 User；但如果 data 不合法，
                        // 上一行已经抛错，这行根本执行不到

// 姿势三：satisfies——管不了这事。data 是运行时才有的值，
// satisfies 只在编译期工作，对 unknown 运行时数据无能为力：
const local = { model: 'glm-4.6', temperature: 0.3 } satisfies AgentConfig;
// 它检查的是「这个字面量长得对不对」，不是「那个变量运行时是什么」
```

**选型口诀**：

1. **数据从外部来**（网络/用户输入/文件）→ 运行时必须真检验：拿得到“不是它”的后续处理就 `is`，拿了也没法处理、不如快崩的就 `asserts`
2. **数据是自己写的字面量**（配置/常量表）→ 编译期检查就够：`satisfies`，检查通过还保留字面量推导
3. **你比编译器懂**（明确知道某处类型但 TS 推不出来）→ `as` 断言，但它是最后手段——前三者失败会“告诉你”，`as` 失败会“骗你”

两个高频误用提前打预防针：

```ts
// 误用 1：给 asserts 函数写了个不抛错的实现
function badAssert(x: unknown): asserts x is User {
  // 什么都没做！asserts 只是函数签名上的承诺，
  // 抛不抛错全看实现——空实现等于对编译器撒谎，
  // 类型窄化了但运行时该崩还是崩
}

// 误用 2：把 satisfies 当运行时校验用
// const ok = responseData satisfies User;  // ❌ 没有意义
// responseData 的类型是 unknown/any，satisfies 对它无从检查；
// 运行时验证永远走 is / asserts
```

最后把今天全部武器放进一张总表（含第 1 节的原生窄化和第 4 节提过的 `as` / `:`）：

| 写法 | 校验逻辑跑在哪 | 失败行为 | 改变类型吗 | 一句话定位 |
| --- | --- | --- | --- | --- |
| `typeof` / `in` / `instanceof` | JS 运行时（本身是 JS 运算符），窄化在编译期 | 走 else | 分支内窄化 | 内建工具，优先用 |
| 判别联合 `kind` | 不跑（纯编译期比较字面量） | 不适用 | switch 分支窄化 | 数据设计的窄化 |
| `is` | JS 运行时（你写的逻辑），窄化在编译期 | 返回 false | true 分支窄化 | 外部数据的守门员 |
| `asserts` | JS 运行时（你写的抛错），窄化在编译期 | 抛错中断 | 调用后窄化 | 不可能的分支就崩 |
| `satisfies` | 不跑（纯编译期） | 编译报错 | **不改**，保留推导 | 字面量的质检章 |
| `: 注解` | 不跑（纯编译期） | 编译报错 | 抬宽到声明类型 | 声明契约，丢细节 |
| `as` | 不跑（无校验） | 不失败（骗编译器） | 强制视为目标类型 | 最后手段 |

三个特性各来自一个时代，版本背后有脉络可记：TS 2.0（2016）是严格类型系统的分水岭，`is` 守卫与 unknown 思想配套而生；TS 3.7（2019）半年集中攻空值安全，`asserts` 和可选链 `?.`、空值合并 `??` 同版发布——它是"运行时兜底版"的类型保护；TS 4.9（2022）的 `satisfies` 补的是注解抬宽与 `as` 骗人之间的空档。如今 TS 5.x 三者均稳定多年，无需顾虑兼容性，但版本敏感度（"asserts 是 3.7 加的"）偶尔会被面试官当新鲜度探针。

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

窄化的引擎是**排除法**：一次比较必须能证明「某些成员不可能」，编译器才把它们踢出联合。两种设计在排除法下的表现天差地别。

**好版（判别联合）**——每个成员的 kind 是**必填的、互不相同**的字面量：

```ts
type StreamChunk =
  | { kind: 'text'; content: string }
  | { kind: 'tool_call'; tool: string; args: string }
  | { kind: 'done'; reason: string }

declare const chunk: StreamChunk;
if (chunk.kind === 'text') {
  // 排除法开动：
  //   tool_call 成员的 kind 是 'tool_call'，绝不可能 === 'text' → 踢掉
  //   done 成员同理 → 踢掉
  //   只剩 text 成员 → chunk.content 直接可用
  console.log(chunk.content); // ✅
}
```

关键在「**互不相同的字面量**」：`chunk.kind === 'text'` 这个检查对另外两个成员**恒为假**——编译器能 100% 排除它们。

**坏版（可选字段）**——删掉 kind，用三个可选字段区分：

```ts
type LooseChunk =
  | { text?: string; content: string }
  | { tool?: string; args: string }
  | { reason: string }

declare const loose: LooseChunk;
if (loose.text !== undefined) {
  // 排除法失灵：
  //   { reason: string } 这个成员——text 在它身上是可选的，可以有也可以没有，
  //   「loose.text !== undefined」对它【可能为真】→ 排除不掉
  //   编译器一个成员都踢不掉，loose 还是 LooseChunk 全体
  console.log(loose.content); // ❌ 报错：content 不一定存在
}
```

问题出在**可选字段的检查对谁都可能为真**：存在性检查（`!== undefined`、`in`）无法证明任何成员不可能——于是联合纹丝不动，取字段要么层层 `?.`，要么 `as` 断言（回到骗编译器的老路）。

一句话：判别字段给编译器的是「一次比较、其余成员恒假」的**数学保证**；可选字段只给「我大概率是这个」的**概率暗示**——排除法只认前者。

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

**问题 6：同一个 unknown 数据，is、asserts、satisfies 各能对它做什么？**

::: details 查看答案
is 和 asserts 都能处理：is 返回 boolean、true 分支窄化、false 走兜底逻辑；asserts 抛错式快崩、调用点后窄化——两者的校验逻辑都跑在 JS 运行时，窄化都发生在编译期（TS 没有运行时，类型签名编译即擦除）。satisfies 什么都做不了——它只在编译期检查字面量的兼容性，对运行时才确定值的 unknown 无从下手。一句话：前两者在 JS 运行时守门（宽容 vs 严格），satisfies 是字面量的编译期质检章。
:::

## 延伸阅读

- [TypeScript Handbook：Narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)——本篇主题的官方完整版
- [TypeScript 3.0 发布说明：unknown 类型](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html#new-unknown-top-type)
- [TypeScript 4.9 发布说明：satisfies 操作符](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator)
- [zod 官网](https://zod.dev)——第 3 周的主角，schema 即守卫
