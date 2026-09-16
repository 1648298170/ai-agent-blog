# 第 1 周 · Day 1：TypeScript 泛型基础——让类型成为参数

> 对应手册任务：学习「类型变量、泛型函数/类、泛型约束」，动手写一个 `createResponse<T>(data: T)` 工具函数，用 3 种不同类型调用，当日产出 `generics-basics.ts`。本篇只解决一个问题：函数想通用于多种类型时，不用为每种类型抄一遍，也不退化成 `any`，而是把类型本身变成参数，让类型信息完整保留到调用处。

## 今日目标

1. 说得清泛型解决什么问题，以及它和 `any` 的本质区别
2. 掌握三个语法点：泛型函数 `<T>`、泛型约束 `extends`、泛型接口与泛型类
3. 独立完成 `createResponse<T>`，用 `string`、自定义 `User`、数组三种类型调用通过编译，并亲眼看编译器抓住一次故意的类型错误

## 概念讲解：为什么需要泛型

写一个「取数组第一个元素」的函数。项目里有字符串数组、数字数组、用户数组，没有泛型时你只有两条路。

第一条路，为每种类型写一遍：

```ts
function getFirstString(list: string[]): string {
  return list[0];
}

function getFirstNumber(list: number[]): number {
  return list[0];
}

interface User {
  id: number;
  name: string;
}

function getFirstUser(list: User[]): User {
  return list[0];
}
```

三个函数体一字不差，只有类型在变。明天来了 `Order[]`，再抄一遍？这种代码改一个 bug 要改 N 处，漏一处就是隐患。

第二条路，用 `any` 一把梭：

```ts
function getFirst(list: any[]): any {
  return list[0];
}

const first = getFirst(["a", "b"]);
first.toUperCase(); // 方法名拼错了，编译器一声不吭
```

`any` 的代价很直接：`first` 是 `any` 之后，你在它上面写什么编译器都放行。拼错方法名、把 `string` 当 `number` 用，统统不报错，问题被拖到运行时才爆。更糟的是 `any` 会传染，`first` 传给谁，谁也跟着变成 `any`。

两条路都不行：复制粘贴不可维护，`any` 不可信任。你真正想要的是：逻辑只写一遍，「元素是什么类型」由调用方决定，返回值还要把正确类型带回来。

这就是泛型做的事：把类型变成参数。值可以是参数，类型也可以。在函数名后面声明一个类型变量 `<T>`，它是个占位符，调用时才被填充成具体类型。`getFirst<string>(...)` 圆括号前传的不是值，而是「这次用 string」这条信息。

## 核心知识

本节的代码块都是独立示例，可以直接贴进 [TypeScript Playground](https://www.typescriptlang.org/play) 对照着看。最终完整文件以下面的动手任务为准。

### 1. 泛型函数与类型变量

```ts
function getFirst<T>(list: T[]): T {
  return list[0];
}

const a = getFirst<string>(["a", "b"]); // 方式一：显式指定 T 是 string
const b = getFirst([1, 2, 3]);          // 方式二：根据实参推断 T 是 number

console.log(a.toUpperCase()); // OK，a 是 string
console.log(b.toFixed(2));    // OK，b 是 number
// console.log(a.toFixed(2)); // 报错：Property 'toFixed' does not exist on type 'string'
```

关键在第一行 `function getFirst<T>(list: T[]): T`：`<T>` 声明类型变量，参数 `T[]` 表示「元素类型为 T 的数组」，返回值 `T` 表示「取出的还是那个 T」。三处是同一个 T，进什么类型就出什么类型，这条链路由编译器保证。

两种调用方式怎么选：推断够用就省略，代码干净；推断有歧义或你想收窄类型时，显式写 `<string>`。显式指定的优先级高于推断，写了就以你的为准。

### 2. 泛型约束

在泛型函数体内，T 是「未知类型」，你不能假设它有任何属性。想写一个「按 id 查找」的函数，直接访问 `item.id` 会报错，因为 T 可能是 string。这时用 `extends` 给 T 加约束：

```ts
interface User {
  id: number;
  name: string;
}

interface Order {
  id: number;
  title: string;
}

function findById<T extends { id: number }>(items: T[], id: number): T | undefined {
  return items.find(item => item.id === id);
}

const users: User[] = [
  { id: 1, name: "Jerry" },
  { id: 2, name: "Tom" },
];
const orders: Order[] = [{ id: 1, title: "MacBook" }];

const u = findById(users, 1);  // User | undefined
const o = findById(orders, 1); // Order | undefined
// findById(["a", "b"], 1); // 报错：Type 'string' does not satisfy the constraint '{ id: number; }'
console.log(u?.name, o?.title);
```

关键一行是 `<T extends { id: number }>`：它告诉编译器「T 至少要有 id: number 这个形状」。换来两件事：函数体内可以放心用 `item.id`，调用处传不满足约束的类型直接报错。另外注意返回值是 `T | undefined` 而不是 T，因为 find 可能找不到，这个细节以后写业务时经常救你一命。

第二个常用约束是 `keyof`，限定「某个对象的属性名」：

```ts
function getProp<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const user = { id: 1, name: "Jerry" };

const userId = getProp(user, "id");     // 类型是 number
const userName = getProp(user, "name"); // 类型是 string
// getProp(user, "email"); // 报错：Argument of type '"email"' is not assignable to parameter of type '"id" | "name"'
console.log(userId, userName);
```

关键在 `K extends keyof T`：`keyof T` 把 T 的属性名组成联合类型 `"id" | "name"`，K 只能取其中的值，属性名传错在编译期就被拦下。返回值 `T[K]` 还能精确到对应属性的类型，传 `"name"` 拿到 string，传 `"id"` 拿到 number。

类型参数还支持默认值，不传时兜底：

```ts
interface Result<T = string> {
  code: number;
  message: string;
  data: T;
}

const text: Result = { code: 0, message: "ok", data: "hello" };     // T 用默认值 string
const count: Result<number> = { code: 0, message: "ok", data: 42 }; // 显式覆盖
console.log(text.data.length, count.data.toFixed(0));
```

关键在 `<T = string>`：`Result` 不带参数时 T 就是 string，带了参数就以你的为准。给「大多数情况下都是同一类型」的接口设默认值，调用方能少写很多尖括号。

### 3. 泛型接口与泛型类

泛型接口最典型的场景是 API 响应包装。`code` 和 `message` 每个接口都一样，只有 `data` 千变万化，正好交给 T：

```ts
interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

const orderRes: ApiResponse<{ orderId: string; amount: number }> = {
  code: 0,
  message: "success",
  data: { orderId: "A-001", amount: 199 },
};

console.log(orderRes.data.orderId.toUpperCase()); // data 的类型精确到每个字段
```

关键一行是 `data: T`：一个接口描述了所有接口的公共形状，具体 data 是什么，使用时再填。

泛型类同理，类型参数写在类名后面，整个类的字段和方法都能用：

```ts
class Stack<T> {
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
  }

  pop(): T | undefined {
    return this.items.pop();
  }

  size(): number {
    return this.items.length;
  }
}

const names = new Stack<string>();
names.push("Jerry");
names.push("Tom");
// names.push(42); // 报错：Argument of type 'number' is not assignable to parameter of type 'string'
console.log(names.pop()?.toUpperCase(), names.size()); // TOM 1
```

关键一行是 `new Stack<string>()`：实例化时把 T 定死为 string，这个实例从此只收 string。`pop()` 返回 `T | undefined`，空栈弹出是 undefined，别忘判空。

## 动手任务：`createResponse<T>` 一步一步

手册任务：用泛型写 `createResponse<T>(data: T)`，用 3 种不同类型调用。拆成 5 步，全程约 20 分钟。

**第 1 步：建文件。** 在本周的练习目录新建 `generics-basics.ts`。下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：定义类型和函数。** 响应结构包含 `code`、`message`、`data` 三个字段，前两个固定，`data` 用 T：

```ts
interface User {
  id: number;
  name: string;
  email: string;
}

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

function createResponse<T>(data: T): ApiResponse<T> {
  return {
    code: 0,
    message: "success",
    data, // 属性简写，等价于 data: data
  };
}
```

关键在返回值类型 `ApiResponse<T>`：data 进来是 T，包进响应对象后还是 T，类型一点没丢。这里要是图省事写成 `data: any`，所有调用方拿到的 data 都是 any，泛型就白学了。

**第 3 步：用三种类型调用。**

```ts
// 调用 1：T 显式指定为 string
const res1 = createResponse<string>("服务已启动");
console.log(res1.data.toUpperCase());

// 调用 2：T 自动推断为 User
const user: User = { id: 1, name: "Jerry", email: "jerry@example.com" };
const res2 = createResponse(user);
console.log(res2.data.name); // res2.data 是 User，点得出 name

// 调用 3：T 显式指定为 User[]，体会「T 可以是任何类型，包括数组」
const users: User[] = [
  { id: 1, name: "Jerry", email: "jerry@example.com" },
  { id: 2, name: "Tom", email: "tom@example.com" },
];
const res3 = createResponse<User[]>(users);
console.log(res3.data.length, res3.data[0].name);
```

三个调用故意混用了「显式指定」和「自动推断」两种写法。在 IDE 或 Playground 里把鼠标悬停在 res1、res2、res3 上，亲眼看 data 的类型分别是什么。

**第 4 步：故意传错，看编译器抓现行。** 在文件末尾加上下面这行（保持注释状态），想看报错就取消注释再编译：

```ts
// const wrong = createResponse<string>(42);
// error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
```

看完报错，把这行重新注释掉或删掉，保持文件能通过编译。

**第 5 步：读懂这条报错。** 拆开看：你显式写了 `<string>`，T 被锁定为 string，于是 `data` 参数的类型就是 string；`42` 是 number，进不来。换成 `function createResponse(data: any)` 的写法，这行会静默通过，错误被拖到运行时才爆。泛型把「调用那一刻的类型」变成了编译器可验证的事实，这就是它和 any 的分水岭。

::: tip 编译命令
在文件所在目录执行 `npx tsc --strict --noEmit generics-basics.ts`。没装 TypeScript 就先 `npm install -g typescript`，或者直接用在线 Playground。保持第 4 步的错误行为注释状态，最终文件应当零报错。
:::

## 常见踩坑

**坑 1：泛型字母随便起，但别真随便。** `<T>` 是 Type 的首字母，纯属惯例，写成 `<W>` 编译器也认。但社区有默认约定：`T`（Type）、`K` 和 `V`（Key/Value）、`E`（Element）、`R`（Return）。类型参数一多，裸字母就没法读了，这时用带语义的名字，比如 `createResponse<TData>`、`getProp<TObj, TKey>`。判断标准：三个月后的你自己能不能一眼看懂。

**坑 2：能省略 `<T>` 是因为推断，有歧义时必须显式。** 看这个翻车现场：

```ts
const empty = createResponse([]);         // T 被推断为 never[]，empty.data 基本没法用
const fixed = createResponse<User[]>([]); // 显式指定，才是用户数组
fixed.data.push({ id: 3, name: "Ann", email: "ann@example.com" });
console.log(empty.data.length); // length 能访问，但也就只剩 length 了
```

推断依赖实参携带的类型信息。空数组、空对象字面量不带任何信息，推断就废了。记住一条：推断结果不靠谱时，显式写 `<T>`，这永远是最稳的。

**坑 3：泛型是编译期的，运行时不存在。** `createResponse` 编译成 JS 后长这样，T 被完全擦掉：

```ts
// function createResponse(data) {
//   return { code: 0, message: "success", data };
// }
```

所以运行时你拿不到 T：不能 `instanceof T`，也写不了「如果 T 是 string 就……」这种运行时分支。需要运行时判断类型，用类型守卫函数，或者把构造函数、哨兵值显式传进去。想验证擦除，把编译输出翻出来看一眼，印象比读十句话深。

**坑 4：T 和 any 的本质区别。** 一句话：`any` 是放弃检查，泛型是参数化类型并保留关联。对比：

```ts
function wrapAny(data: any): { data: any } {
  return { data };
}

function wrapGen<T>(data: T): { data: T } {
  return { data };
}

const anyResult = wrapAny("hello"); // anyResult.data 是 any，检查从此断掉
const genResult = wrapGen("hello"); // genResult.data 是 string，检查继续
console.log(anyResult.data, genResult.data.length);
```

两个函数都能接受任何值，差别在调用之后：any 版把「这是个 string」的信息扔了，泛型版把它带出来了。「函数内部不关心具体类型」和「调用方要拿回正确类型」这两件事同时成立，只有泛型做得到。

**坑 5：不要为了泛型而泛型。** 一个函数这辈子只处理 `User`，就直接写 `data: User`，更短更清楚。泛型是为「逻辑相同、类型不同」的复用而生的。我的判断标准：当你在写第二个「只有类型不一样」的重载时，才值得回头抽泛型，第一遍忍住。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 什么时候必须显式写 `<T>`，什么时候可以省略？

::: details 参考答案
实参类型明确、无歧义时可以省略，编译器会推断。必须显式的场景：实参不带类型信息（如空数组 `[]`）；推断结果不是你想要的（要收窄或指定更宽的类型）；类型信息只在返回值一侧（如 `parse<T>(raw: string): T`，参数里根本看不出 T 该是什么）。
:::

2. `T extends { id: number }` 是什么意思？它约束了谁？

::: details 参考答案
意思是：调用方传给 T 的类型必须至少包含 `{ id: number }` 这个形状。它约束的是调用方能用哪些类型替换 T；换来的是函数体内可以安全访问 `value.id`，以及调用处类型不满足时立刻编译报错。
:::

3. `getProp<T, K extends keyof T>(obj: T, key: K): T[K]` 里，K 和返回值是怎么确定的？

::: details 参考答案
T 由第一个实参推断；`keyof T` 把 T 的属性名组成联合类型，K 被约束为其中之一，由第二个实参锁定；返回值 `T[K]` 表示「T 上 K 属性的类型」，传 `"name"` 得 string，传 `"id"` 得 number，属性名和属性类型都错不了。
:::

4. 泛型和 any 都能让函数「通用」，什么时候绝对不该用 any？

::: details 参考答案
只要这个值后续还会被使用、传递，就不该是 any，因为 any 会关掉检查并沿调用链传染。any 只适合临时调试或确实完全未知的外部数据；即便那种场景，`unknown` 也几乎总是更好，它逼你先收窄类型再使用。
:::

5. `interface Result<T = string>` 的默认值什么时候生效？

::: details 参考答案
使用 `Result` 而完全不带类型参数时，T 取 string；一旦写了 `Result<number>`，默认值就被覆盖。默认值最常出现在接口和类型别名上，用来让「多数情况只有一种类型」的场景少写尖括号。
:::

## 延伸阅读

- [TypeScript Handbook：Generics](https://www.typescriptlang.org/docs/handbook/2/generics.html)，官方泛型章节，本篇所有语法点的原始出处，值得通读一遍
- [TypeScript Handbook：Keyof Types](https://www.typescriptlang.org/docs/handbook/2/keyof-types.html)，`keyof` 的官方说明，和泛型约束搭配着看
- [TypeScript Playground](https://www.typescriptlang.org/play)，把今天的代码贴进去，悬停变量看推断出的类型，比看十遍文章都直观

今天的产出 `generics-basics.ts` 留好，`ApiResponse<T>` 这个形状后面封装 Agent 的接口时还会反复用到。
