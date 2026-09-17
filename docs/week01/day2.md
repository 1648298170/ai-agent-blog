# 第 1 周 · Day 2：条件类型与映射类型——写自己的工具类型

> 对应手册任务：学习「条件类型 + 映射类型：`extends ? :`、`infer`、`Partial`/`Required`/`Readonly`」，动手实现 `DeepPartial<T>` 和 `UnwrapPromise<T>` 两个工具类型，当日产出 `advanced-types.ts`。昨天我们学会了把类型当参数传，今天更进一步：把类型当数据算。读完这篇，你不仅能看懂 `Partial` 这类内置工具类型的源码，还能亲手造出两个官方没有的。

## 今日目标

1. 掌握条件类型 `extends ? :` 的语法和「分发」特性，能读懂类型层面的 if/else
2. 会用 `infer` 在条件类型里捕获类型，能手写 `ReturnType` 的等价实现
3. 掌握映射类型的 `in keyof` 遍历和 `+/-` 修饰符，独立完成 `DeepPartial<T>` 和 `UnwrapPromise<T>`

## 概念讲解：为什么需要「类型层面的计算」

先看两个真实开发里天天撞见的问题。

问题一：API 返回的 User 有 20 个字段，编辑资料的表单只想改 name 和 email。

```ts
interface User {
  id: number;
  name: string;
  email: string;
  avatar: string;
  createdAt: string;
  // 真实项目里还有十几个字段
}

function updateUser(id: number, patch: User) {}

// updateUser(1, { name: "新名字" });
// ❌ 报错：缺少 id、email 等必填字段，除非把 20 个字段全抄一遍
```

你当然可以手动定义一个 `OptionalUser`，字段全部加 `?`。但 User 一改，两个类型就得同步改两遍，迟早改漏。我们真正想要的是：从 User 出发，自动「算」出一个字段全可选的类型。

问题二：拿到了 `Promise<User>`，想在类型层面提前把 User 取出来。比如一个 async 函数的返回类型是 `Promise<{ id: number; name: string }>`，你想把里面那个对象类型提取出来用到别处，而不是每次手抄。

这两个需求指向同一件事：新类型不该靠手写，该从旧类型计算得来。TypeScript 的类型系统是图灵完备的，类型可以写条件判断，也可以递归。今天学它的两块基石：

- 条件类型：类型世界的 `if / else`
- 映射类型：类型世界的 `for` 循环

昨天 `createResponse<T>` 解决的是「类型当参数传」，今天解决「类型当数据算」。学完写的每个工具类型，都会收进同一个文件：`advanced-types.ts`。

## 核心知识

本节的代码块都是独立示例，可以直接贴进 [TypeScript Playground](https://www.typescriptlang.org/play) 对照着看，悬停类型名看推导结果。最终完整文件以下面的动手任务为准。

### 1. 条件类型：`extends ? :`

语法长得很像 JS 的三元表达式，只是运算对象从值换成了类型：

```ts
type IsString<T> = T extends string ? true : false;

type S1 = IsString<"hello">; // true，字面量类型 "hello" 是 string 的子类型
type S2 = IsString<number>;  // false
```

关键一行是 `T extends string ? true : false`：T 是 string 的子类型时，整个类型等于 `true`，否则等于 `false`。注意它和昨天泛型约束的区别：约束里的 `extends` 是门槛，不满足直接报错；条件类型里的 `extends` 是判断，根据结果走不同分支。

条件可以嵌套，从上往下依次匹配，先命中先得：

```ts
type TypeName<T> =
  T extends string   ? "string"   :
  T extends number   ? "number"   :
  T extends boolean  ? "boolean"  :
  T extends Function ? "function" :
  "object";

type N1 = TypeName<"ts">;       // "string"
type N2 = TypeName<() => void>; // "function"
type N3 = TypeName<string[]>;   // "object"
```

#### 重要特性：分发（Distributivity）

如果 T 是联合类型，而且是「裸」的（没有被元组、数组之类包住），条件类型会把联合的每个成员分别代入计算，再把结果合并成新联合：

```ts
type ToArray<T> = T extends any ? T[] : never;

type R1 = ToArray<string | number>; // string[] | number[]
```

`string | number` 先拆开：string 算出 `string[]`，number 算出 `number[]`，最后合并。注意结果不是 `(string | number)[]`。

不想分发？用元组把 T 包一层，让它不再裸露：

```ts
type ToArrayNoDist<T> = [T] extends [any] ? T[] : never;

type R2 = ToArrayNoDist<string | number>; // (string | number)[]
```

::: tip 分发不是坑，是武器
下午写 `DeepPartial` 靠的正是分发：联合类型的每个成员会被各自递归处理，结果天然正确。什么时分发、什么时不分发，你要能自己选。
:::

### 2. `infer`：在条件类型里挖一个洞

`extends` 只能回答「是不是」，`infer` 能把匹配到的类型抓出来用。它只能出现在条件类型的 `extends` 子句里，作用是给类型模板中的某个位置起个名字：

```ts
type MyReturnType<T> = T extends (...args: any[]) => infer R ? R : never;

function getUser() {
  return { id: 1, name: "Alice" };
}

type U = MyReturnType<typeof getUser>;
// { id: number; name: string }，函数返回值类型被提取出来了
```

关键一行是 `(...args: any[]) => infer R`：先写一个「任意参数的函数」模板，`infer R` 的意思是「返回值位置是什么类型先不管，记作 R」。匹配成功后走 true 分支返回 R，等于把挖到的类型交了出来；T 不是函数时走 false 分支返回 never。

再看一个从数组里提取元素类型的：

```ts
type ArrayElement<T> = T extends (infer E)[] ? E : never;

type E1 = ArrayElement<string[]>;   // string
type E2 = ArrayElement<number[]>;   // number
type E3 = ArrayElement<["a", "b"]>; // "a" | "b"
```

还记得昨天的 `createResponse<T>` 吗？真实项目里这类接口函数几乎都是异步的，返回值会被自动包上一层 Promise：

```ts
async function fetchUser() {
  return { id: 1, name: "Alice" };
}

type FetchResult = MyReturnType<typeof fetchUser>;
// Promise<{ id: number; name: string }>，async 函数的返回类型被包了一层 Promise
```

拿到了 `Promise<...>` 却拆不开？这正是下午 `UnwrapPromise<T>` 要解决的问题，先把坑记下。

### 3. 映射类型：`in keyof` 遍历

条件类型是 if/else，映射类型就是 for 循环：基于旧类型的每个属性，生成新类型的每个属性。

```ts
type AllReadonly<T> = {
  readonly [K in keyof T]: T[K];
};

type ReadonlyUser = AllReadonly<User>;
// { readonly id: number; readonly name: string; readonly email: string; ... }

const u: ReadonlyUser = { id: 1, name: "Alice", email: "a@b.c" };
// u.id = 2; // ❌ 无法为 "id" 赋值，因为它是只读属性
```

关键一行是 `[K in keyof T]`：`keyof T` 是「T 的所有属性名组成的联合类型」（昨天 `getProp` 里约束 K 时用过它），`K in` 让 K 依次取遍这些属性名。`T[K]` 是索引访问，取 K 对应的属性类型。前面的 `readonly` 给每个属性加只读修饰符。

修饰符可以加也可以减，加号是默认值，平时都省略：

```ts
// 加修饰符（+ 可省略）
type MyPartial<T>  = { [K in keyof T]?: T[K] };         // 每个属性可选

// 减修饰符
type NoReadonly<T> = { -readonly [K in keyof T]: T[K] }; // 去掉只读
type NoOptional<T> = { [K in keyof T]-?: T[K] };         // 去掉可选
```

现在手写 `MyPartial`，和官方 `Partial` 正面对比：

```ts
const p1: MyPartial<User> = { name: "只改名字" };  // ✅ 其他字段不传也行
const p2: Partial<User>   = { name: "也只改名字" }; // ✅ 行为完全一致
```

打开 `node_modules/typescript/lib/lib.es5.d.ts`，搜 `type Partial`，官方实现就一行，和你写的一模一样。所谓内置工具类型，没有魔法。

### 4. 内置工具类型的原理拆解

有了前两节打底，三个最常用的内置工具类型可以一口气手写完：

```ts
// MyPartial（第 3 节写过）：
// type MyPartial<T> = { [K in keyof T]?: T[K] };

// Required：每个属性去掉可选。关键在 -?，它不光去掉问号，还会把 undefined 一并清掉
type MyRequired<T> = { [K in keyof T]-?: T[K] };

// Readonly：每个属性加只读（第 3 节的 AllReadonly 就是它）
type MyReadonly<T> = { readonly [K in keyof T]: T[K] };
```

验证 `MyRequired`：

```ts
interface DraftUser {
  id?: number;
  name?: string;
}

type Filled = MyRequired<DraftUser>;
// { id: number; name: string }

// const x: Filled = { id: 1 }; // ❌ 报错：缺少 name
const y: Filled = { id: 1, name: "Alice" }; // ✅
```

::: tip 了解即可：as 重映射
TS 4.1 起映射时可以用 `as` 改属性名，配合模板字符串类型批量生成方法名：

```ts
interface Account {
  id: number;
  name: string;
}

type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

type AccountGetters = Getters<Account>;
// { getId: () => number; getName: () => string }
```

今天不要求掌握，看懂它在干什么就行，后面学到模板字符串类型再回来细看。
:::

## 动手任务：`DeepPartial<T>` 与 `UnwrapPromise<T>`

手册任务：实现 `DeepPartial<T>` 和 `UnwrapPromise<T>` 两个工具类型。拆成 6 步，全程约 25 分钟，边读边敲，不要复制粘贴。

**第 1 步：建文件。** 在本周的练习目录新建 `advanced-types.ts`，先把后面几步要用的嵌套结构写进去：

```ts
interface Article {
  title: string;
  author: {
    name: string;
    profile: {
      bio: string;
      link: string;
    };
  };
}
```

**第 2 步：写一版只处理第一层的。** `Partial` 只让第一层字段可选，嵌套对象内部的字段照样必填。最直觉的想法：对每个属性再做一次 Partial：

```ts
type DeepPartialV1<T> = {
  [K in keyof T]?: Partial<T[K]>;
};
```

**第 3 步：测试，发现嵌套没生效。**

```ts
const draft1: DeepPartialV1<Article> = {
  author: {
    name: "先填名字",
    // profile: { bio: "只改简介" },
    // ❌ 一旦写 profile，bio 和 link 必须给全，因为 Partial 只压扁了一层
  },
};
```

`author` 这层生效了，`name` 可以不传；但 `profile` 里面还是老样子。问题出在 `Partial<T[K]>`：它最多再往下压一层，遇到更深的对象就无能为力。

**第 4 步：递归改造。** 本质需求是：属性类型是对象时，应该对它继续做 DeepPartial，而不是 Partial。翻译成代码：

```ts
type DeepPartialV2<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartialV2<T[K]> : T[K];
};

const draft2: DeepPartialV2<Article> = {
  author: {
    profile: { bio: "只改简介" }, // ✅ 通过，link 可以先不写
  },
};
```

关键一行是 `T[K] extends object ? DeepPartialV2<T[K]> : T[K]`：属性是对象就递归，不是就原样保留。类型可以引用自己，这就是类型层面的递归，强大，但边界要自己守，见下一步。

**第 5 步（进阶）：递归的三个陷阱——函数、数组与内置对象。** V2 在纯对象上够用了，但拿到真实世界的类型上会连环翻车。先看全貌：

```ts
interface FormState {
  name: string;
  tags: string[];
  createdAt: Date;
  onSubmit: (e: Event) => void;
}

type Broken = DeepPartialV2<FormState>;
// name?: string
// tags?: (string | undefined)[]      ← 陷阱 2：数组元素被「可选化」污染
// createdAt?: { getTime?: ... }      ← 陷阱 3：Date 被拆成十几个可选方法
// onSubmit?: {}                      ← 陷阱 1：函数的调用签名直接丢了
```

**陷阱 1 的机制**：函数确实是 object，于是进了映射分支。而 `keyof ((e: Event) => void)` 的结果是 `never`——函数类型上没有任何“属性键”，`[K in never]` 一次都不会迭代，映射结果就是空对象 `{}`。签名没了，`draft.onSubmit?.(e)` 会直接报“类型上不存在此调用”。

**陷阱 2 的机制**：数组同样是 object，同态映射会保留数组形状，但 `?` 修饰符落到数组上就变成“元素可为 undefined”——得到 `(string | undefined)[]`，遍历时每个元素都得判空。

**陷阱 3 的机制**：Date/RegExp/Error/Promise 这类内置对象自带一大堆方法属性，被当成普通对象逐个“可选化”之后，`new Date()` 再也赋不进 `createdAt` 字段。

**修复第一版**——递归前先分流：函数透传、数组只递归元素类型：

```ts
type DeepPartialV3<T> =
  T extends (...args: any[]) => any
    ? T                                          // 函数：原样返回
    : T extends (infer E)[]
      ? DeepPartialV3<E>[]                       // 数组：只递归元素类型
      : T extends object
        ? { [K in keyof T]?: DeepPartialV3<T[K]> }
        : T;
```

name、tags、onSubmit 都修好了——**但 V3 还藏着两个坑**：救不了 Date，还会弄丢元组：

```ts
type D = DeepPartialV3<Date>;              // { getTime?: () => number; ... } ❌ 还是被肢解
type P = DeepPartialV3<[string, number]>;  // (string | number)[]            ❌ 元组退化成数组
```

元组 `[string, number]` 能匹配 `(infer E)[]`（E 被推断为 `string | number`），但重建时只剩数组形状——每个位置的类型信息丢了。

**生产级终版**——内置对象黑名单 + 同态映射保元组：

```ts
type BuiltIn = Function | Date | RegExp | Error | Promise<any>;

type DeepPartial<T> =
  T extends BuiltIn
    ? T                                            // 1. 函数与内置对象：整体透传
    : T extends readonly any[]
      ? { [K in keyof T]: DeepPartial<T[K]> }      // 2. 数组/元组：同态映射保结构，逐元素递归
      : T extends object
        ? { [K in keyof T]?: DeepPartial<T[K]> }   // 3. 普通对象：递归 + 加可选
        : T;                                       // 4. 原始类型：透传
```

第 2 分支是精髓：`{ [K in keyof T]: ... }` 作用在数组/元组上是**同态映射**——TS 会保住原本的形状（数组还是数组、元组还是元组、每个位置的类型不变），只对元素套用 DeepPartial。注意这里刻意不加 `?`：元组元素不允许声明为可选，数组语义上也不需要每个元素 undefined。

```ts
type Fixed = DeepPartial<FormState>;
// name?: string
// tags?: string[]                    ← 数组结构完整
// createdAt?: Date                   ← 内置对象原样保留
// onSubmit?: (e: Event) => void      ← 函数原样保留

type TupleKept = DeepPartial<[string, number]>;  // [string, number] ✅ 元组保住了

const draft3: DeepPartial<Article> = {
  title: "条件类型入门（草稿）",
  tags: ["ts"],
  author: { profile: { bio: "先写个开头" } }, // ✅ 深层字段全部可选
};
```

两个补充：① 条件类型遇到**裸联合类型会分发**——`DeepPartial<{ a: string } | null>` 会对两个成员分别求值（null 走分支 4 透传），这通常正是你要的语义；② 生产代码不必手写：[type-fest](https://github.com/sindresorhus/type-fest) 的 `DeepPartial` 就是这套思路的加强版（额外处理了 Map/Set/WeakMap 系列），`import type { DeepPartial } from 'type-fest'` 即用——但现在你知道它的每一行分别在防什么。

**第 6 步：`UnwrapPromise<T>`，递归拆 Promise。** 回到第 2 节埋的坑：`fetchUser` 的返回类型是 `Promise<{ id: number; name: string }>`，想拆开外层。思路：如果 T 是 `Promise<R>`，用 `infer` 把 R 挖出来，对 R 重复这个过程；不是 Promise 就原样返回：

```ts
type UnwrapPromise<T> = T extends Promise<infer R> ? UnwrapPromise<R> : T;

type A = UnwrapPromise<Promise<{ id: number; name: string }>>; // { id: number; name: string }
type B = UnwrapPromise<Promise<Promise<string>>>;              // string
type C = UnwrapPromise<number>;                                 // number，不是 Promise 直接透传

// fetchUser 是第 2 节定义的那个 async 函数
type UserData = UnwrapPromise<MyReturnType<typeof fetchUser>>;
// { id: number; name: string }
```

`B` 为什么是 string？第一次匹配挖出 `Promise<string>`，递归第二次挖出 string，第三次 string 不匹配 Promise，原样返回。像剥洋葱，剥到不是 Promise 为止。最后这行和 `MyReturnType` 组合，一行拿到 async 函数真正的返回类型。

::: tip 编译命令与官方同类
在文件所在目录执行 `npx tsc --strict --noEmit advanced-types.ts`，应当零报错。另外 TS 4.5 内置的 `Awaited<T>` 干的就是 `UnwrapPromise` 的事（还多处理了 thenable 等边角）。自己写一遍的意义在于：下次需要官方没有的工具类型，你知道怎么造。
:::

## 常见踩坑

**坑 1：DeepPartial 无脑递归，函数变空对象。** 机制：`keyof ((e: Event) => void)` 是 `never`，`[K in never]` 一次不迭代，映射结果就是 `{}`——函数的调用签名整个消失。数组同样中招（元素被 `?` 污染成 `(string | undefined)[]`），Date 等内置对象也会被拆成一堆可选方法。解法分两层：先分流（函数透传、数组只递归元素）；再补黑名单（`BuiltIn = Function | Date | RegExp | Error | Promise<any>` 整体透传）+ 用同态映射 `{ [K in keyof T]: ... }` 的数组分支保住元组结构——完整推导见动手任务第 5 步。

**坑 2：infer 的位置写错。** `infer` 只能出现在条件类型的 `extends` 子句里，还得嵌在具体的类型模板中：

```ts
// type Bad1 = infer R;
// ❌ 报错："infer" 声明只能出现在条件类型的 extends 子句中

// type Bad2<T> = T extends Promise<infer R> ? R : infer R;
// ❌ false 分支里也不能用 infer
```

记一个口诀：infer 必须长在 extends 后面的类型模板里，true/false 分支里都不行。

**坑 3：分发特性导致裸类型和包裹类型结果不同。**

```ts
type IsNever<T> = T extends never ? true : false;
type X = IsNever<never>; // never，不是 true！

type IsNeverFixed<T> = [T] extends [never] ? true : false;
type Y = IsNeverFixed<never>; // true
```

never 是空联合，分发时没有成员可以代入，结果还是空联合 never。想判断 never，必须用元组 `[T]` 阻止分发。写工具类型时遇到「结果莫名变成 never」，先检查是不是分发惹的祸。

**坑 4：映射类型对原始类型直接透传。**

```ts
type S = MyPartial<string>; // string，原样返回
```

映射类型只对对象结构起作用，遇到 string、number 这类原始类型会直接透传，不报错也不变形。这通常是好事，递归到叶子自动停下；但如果你指望它对原始类型做点什么，就会扑个空。想对原始类型分支处理，得靠条件类型，`DeepPartial` 完整版的第 4 个分支 `: T` 就是这个兜底。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `IsString<string | number>` 的结果是 `false` 吗？

::: details 参考答案
不是。联合类型发生分发，`IsString<string>` 是 true，`IsString<number>` 是 false，合并成 `true | false`，也就是 boolean。
:::

2. 手写 `MyReturnType<T>`，infer 写在哪里，捕获的是什么？

::: details 参考答案
`type MyReturnType<T> = T extends (...args: any[]) => infer R ? R : never;`
infer R 写在 extends 子句里函数模板的返回值位置，捕获函数的返回值类型。T 不是函数时走 false 分支返回 never。
:::

3. `Partial<T>` 的实现只有一行，默写出来，并指出两个关键语法。

::: details 参考答案
`type Partial<T> = { [K in keyof T]?: T[K] };`
关键语法：`[K in keyof T]` 遍历属性名；`?` 可选修饰符（默认是加号，省略不写）。
:::

4. `UnwrapPromise<Promise<Promise<string>>>` 结果是什么，过程是怎样的？

::: details 参考答案
string。每匹配一次 `T extends Promise<infer R>` 就剥掉一层 Promise 并对 R 递归，直到 T 不再是 Promise，走 false 分支原样返回。
:::

5. 为什么 `T extends never ? true : false` 传入 never 得到的是 never？怎么修？

::: details 参考答案
never 是空联合，分发时没有成员可代入，结果为空联合 never。用元组阻止分发：`[T] extends [never] ? true : false`。
:::

## 延伸阅读

- [TypeScript Handbook：Conditional Types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)，条件类型官方章节，分发特性的原始出处，值得通读
- [TypeScript Handbook：Mapped Types](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html)，映射类型官方章节，修饰符加减讲得比本篇细
- [TypeScript Handbook：Utility Types](https://www.typescriptlang.org/docs/handbook/utility-types.html)，内置工具类型总览，现在你可以点开每个的类型定义试着自己读懂了

今天的产出 `advanced-types.ts` 留好，`DeepPartial` 和 `UnwrapPromise` 在后面封装 Agent 配置和异步流程时会反复用到。有余力的话，去 type-challenges 的 easy 难度找几道练手，但别贪多，明天还要在今天的地基上盖楼。
