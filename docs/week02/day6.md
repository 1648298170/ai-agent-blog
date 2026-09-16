# 第 2 周 · Day 6：Server Actions——不写 API 路由，表单直接改数据

> 对应手册任务：学习「Server Actions：表单提交、数据变更」；动手「用 Server Action 实现一个简单的『创建待办』表单」；当日产出「无 API 路由的完整 CRUD 交互」。本篇只解决一个问题：改数据不再走 API 路由加 fetch 那条老链路——表单直接调用一个跑在服务端的函数，JS 没加载也能提交，改完缓存自动刷新。

## 今日目标

1. 说得清 Server Action 方案和 API 路由方案各自的链路，以及为什么前者在 JS 未加载时也能提交
2. 掌握四个语法点：`'use server'` 的函数级与文件级写法、FormData 取值、`useActionState` 与 `useFormStatus`、`revalidatePath`
3. 独立完成 `/todos` 页面：增、查、删三种操作全部跑通，全程零 API 路由，并亲眼看一次禁用 JS 后表单照样能提交

## 概念讲解：为什么需要 Server Actions

昨天（[本周 Day 5](/week02/)）的页面已经能「看」：Server Component 负责取数据，Client Component 负责接交互。但只要想「改」一条数据，就得回到老三样。往待办列表加一条，传统做法的最小完整版长这样：

```tsx
// 客户端组件
'use client';
const [text, setText] = useState('');
const [loading, setLoading] = useState(false);

async function handleSubmit() {
  setLoading(true);
  const res = await fetch('/api/todos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  setLoading(false);
  if (res.ok) router.refresh();
}
```

先得建一个 `app/api/todos/route.ts` 当接口，再把表单状态搬进 `useState`，提交前 `setLoading`，成功后 `router.refresh()`。一个「往数组里加一条」的需求，代码散在两个文件三个位置，链条上每一环都得自己接线。

更要命的是第二条：这套方案完全依赖 JS。fetch 是 JS，onClick 是 JS，bundle 没加载完，页面上的按钮就是块死的塑料。网络差一点、脚本加载慢一点，用户点什么都没反应。

Server Actions 把中间商拿掉了。你写一个普通 async 函数，标上 `'use server'`，它就只运行在服务端；编译器会给它生成一个能从浏览器安全调用的入口，于是 `<form>` 的 action 属性可以直接指向它，不再是一个 URL 字符串。浏览器提交表单是 HTML 的原生能力，一次 POST，JS 加没加载都照做；JS 加载之后，React 再把提交接管成无刷新交互。一套代码，先能用、再好用，这就是「渐进增强」。

一句安全提醒先放在这：action 是公开端点。任何拿到页面的人都能直接调它，所以校验必须写在 action 内部（今天做空值校验演示思路），正式项目再换 zod 这类校验库，别信前端传来的任何东西。

## 核心知识

### 1. `'use server'` 的两种用法

函数级，写在函数体第一行，函数必须 async：

```tsx
export default function TodosPage() {
  async function addTodo(formData: FormData) {
    'use server';
    // 改数据、刷缓存，都跑在服务端
  }
  return <form action={addTodo}>...</form>;
}
```

文件级，写在文件第一行，本文件所有导出都变成 Server Action：

```ts
'use server';

export async function createTodo(prevState: FormState, formData: FormData) {
  // ...
}
export async function deleteTodo(id: number) {
  // ...
}
```

怎么选：函数级适合「只在这个组件用一次」的小 action，就近写在 Server Component 里；文件级把 action 收拢成一个模块，Server Component 和 Client Component 都能 import。action 一旦超过两个，文件级是唯一不乱的选择，今天的动手任务就用它。

两条铁律：第一，两种写法的函数都必须是 async，标在同步函数上直接报错；第二，`'use server'` 不能出现在 `'use client'` 文件里，客户端文件只能 import 别处的 action，不能就地定义——「客户端定义服务端代码」本身就不成立。

### 2. form action 直连与 FormData

原生 HTML 的 form 本来就有 action，值是 URL。React 把它扩展成也接受函数。提交时，浏览器把表单里所有「有 name 的控件」打包成 FormData 传给这个函数：

```tsx
<form action={createTodo}>
  <input name="text" />
  <input type="hidden" name="priority" value="low" />
  <button>提交</button>
</form>
```

action 里用 `formData.get('text')` 取值。注意它的返回类型是 `FormDataEntryValue | null`，也就是 `string | File | null`，所以取出来要先 `typeof` 收窄再用。不需要 onClick，不需要 `e.preventDefault()`，React 全接管了。

删除要传 id，可 action 收到的只有 FormData，多余的参数怎么塞？用 `bind`：

```tsx
<form action={deleteTodo.bind(null, todo.id)}>
```

`deleteTodo.bind(null, todo.id)` 返回一个新函数，调用时自动带上 id，表单提交时 FormData 再跟在后面——所以 deleteTodo 的完整签名是 `(id: number, formData: FormData)`，用不到 FormData 可以不声明。另一个等价办法是 hidden input 塞 id，action 里 `formData.get('id')` 再转数字。两者都行，bind 不用经过 DOM，数字也不会被序列化成字符串。

### 3. useActionState 与 useFormStatus

表单直连已经能干活，但两个体验问题还没解决：提交期间按钮该禁用吧？校验失败的报错怎么显示到页面上？这对应 React 19 的两个 Hook（Next 15 内置的就是 React 19）。

`useActionState` 管「返回值」，从 react 包导入：

```tsx
const [state, formAction, isPending] = useActionState(createTodo, null);
```

它把 createTodo 包了一层，返回三样东西：state 是 action 最近一次的返回值，初始值就是第二个参数 null；formAction 是包装后的 action，绑给 form 的是它而不是原函数；isPending 表示本次提交是否进行中。用了它，action 的签名就从 `(formData)` 变成 `(prevState, formData)`——第一个参数是上一次的 state，别写反。createTodo 判空失败时 `return { error: '待办内容不能为空' }`，这个对象就会出现在 state 里，直接渲染成提示。

顺带一句历史：它的前身叫 `useFormState`，从 react-dom 导入，React 19 把它改名 `useActionState` 挪进了 react 包，还把 isPending 合进了返回值。看到老教程写 useFormState，脑内替换即可，参数顺序没变。

`useFormStatus` 管「提交状态」，从 react-dom 导入，专门给按钮用：

```tsx
function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>{pending ? '提交中…' : '提交'}</button>;
}
```

它有条反直觉的规矩：必须写在 `<form>` 内部的子组件里。它读的是 form 元素提供的上下文，渲染 `<form>` 的那个组件自己不在上下文里，写在那 pending 永远是 false。所以固定模式是：表单组件渲染 `<form>`，按钮单独抽成子组件放进去。

分工记法：要拿 action 的返回值、要让报错跨提交存活，用 useActionState，写在渲染 form 的组件里；只关心「现在提交中吗」，用 useFormStatus，写在 form 里面的子组件里。今天两个都会用到。

### 4. revalidatePath：改完数据要喊一嗓子

Next 会缓存 Server Component 的渲染结果。你在 action 里改的是服务端内存里的数组，缓存系统并不知道这事。`revalidatePath('/todos')` 的意思就是：这个路径的缓存作废，下次请求重新渲染。每个改数据的 action 末尾都该调它，否则用户加了一条待办，界面还是旧的。本地 dev 有时察觉不到（开发模式的缓存宽松），`next build` 后一跑一个准，别依赖「dev 里好像是好的」。

数据存哪？今天用模块级的内存数组假装数据库，零依赖，专注在动作本身；代价是重启归零，踩坑一节细说。第 4 周 Prisma 上场时，把 data.ts 换成数据库实现，页面和 action 一行不改——这正是今天把所有数据操作收进 data.ts 三个函数的原因：接口先定好，实现随你换。

## 动手任务：待办 CRUD 一步一步

在 apps/web 里开工（本周 Day 4 建的 Next 15 项目，目录忘了就回 [第 1 周](/week01/) 的骨架翻一眼）。目标：`/todos` 页面，查列表、加待办、删待办。拆 6 步，全程约 30 分钟。

**第 1 步：建目录和假数据库。** 新建 `app/todos/data.ts`：

```ts
export type Todo = {
  id: number;
  text: string;
  createdAt: string;
};

// 假数据库：进程内存里的一个模块级数组。
// 进程活着数据就在，重启或热更新归零。第 4 周换 Prisma，只改这个文件。
let todos: Todo[] = [
  { id: 1, text: '读完 Server Actions 文档', createdAt: '2026-09-16' },
  { id: 2, text: '跑通今天的 /todos 页面', createdAt: '2026-09-16' },
];
let nextId = 3;

export function getTodos(): Todo[] {
  return todos;
}

export function addTodo(text: string): Todo {
  const todo: Todo = {
    id: nextId++,
    text,
    createdAt: new Date().toISOString().slice(0, 10),
  };
  todos.push(todo);
  return todo;
}

export function removeTodo(id: number): void {
  todos = todos.filter((t) => t.id !== id);
}
```

增、查、删三件事对应三个函数。「查」压根不需要 action：Server Component 每次渲染时直接调 `getTodos()`，这是本周 Day 5 学过的内容。

**第 2 步：写 actions。** 同目录新建 `app/todos/actions.ts`：

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { addTodo, removeTodo } from './data';

export type FormState = { error: string } | null;

export async function createTodo(
  prevState: FormState,
  formData: FormData
): Promise<FormState> {
  const text = formData.get('text');
  if (typeof text !== 'string' || text.trim() === '') {
    return { error: '待办内容不能为空' };
  }
  addTodo(text.trim());
  revalidatePath('/todos');
  return null; // 成功：state 归位，上次的报错随之消失
}

export async function deleteTodo(id: number): Promise<void> {
  removeTodo(id);
  revalidatePath('/todos');
}
```

两个 action，两种形状：createTodo 走 useActionState，所以签名带 prevState、有返回值；deleteTodo 直连 form action，用 bind 传 id，改完即止。

**第 3 步：页面骨架。** `app/todos/page.tsx`：

```tsx
import { getTodos } from './data';
import { deleteTodo } from './actions';
import { TodoForm, DeleteButton } from './todo-form';

export default function TodosPage() {
  const todos = getTodos();

  return (
    <main style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'sans-serif' }}>
      <h1>待办</h1>
      <TodoForm />
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todos.map((todo) => (
          <li
            key={todo.id}
            style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0' }}
          >
            <span>
              {todo.text}
              <small style={{ color: '#999' }}>（{todo.createdAt}）</small>
            </span>
            <form action={deleteTodo.bind(null, todo.id)}>
              <DeleteButton />
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

整个页面是 Server Component，唯一的客户端代码在第 4、5 步的两个按钮组件里。说句提气的话：就算把 DeleteButton 换成普通的 `<button>删除</button>`，删除功能照样工作，因为 form action 是浏览器原生行为。

**第 4 步：创建表单。** 新建 `app/todos/todo-form.tsx`：

```tsx
'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createTodo, type FormState } from './actions';

export function TodoForm() {
  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    createTodo,
    null
  );

  return (
    <form action={formAction}>
      <input name="text" placeholder="要做什么？" style={{ marginRight: 8 }} />
      <button type="submit" disabled={isPending}>
        {isPending ? '添加中…' : '添加'}
      </button>
      {state?.error && <p style={{ color: 'crimson' }}>{state.error}</p>}
    </form>
  );
}
```

客户端组件 import 了 actions.ts 里的 createTodo——文件级 `'use server'` 声明保证了这个 import 拿到的只是「可调用的引用」，函数体永远不会进客户端 bundle。泛型 `<FormState, FormData>` 第一个是 state 类型、第二个是 payload 类型，顺序别记反。

**第 5 步：删除按钮。** 追加到同一个文件：

```tsx
export function DeleteButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? '删除中…' : '删除'}
    </button>
  );
}
```

它必须作为 `<form>` 的子组件存在（第 3 步已经这么放了），useFormStatus 才读得到状态。注意它没写 onClick，`type="submit"` 触发的是外层表单的提交。

**第 6 步：验证三件事。** 启动 dev server，访问 `http://localhost:3000/todos`。一验功能：添加一条、删除一条、空内容提交看行内报错，都该符合预期。二验渐进增强：打开 DevTools，按 Ctrl+Shift+P 唤出命令面板，执行 Disable JavaScript，刷新页面后再提交——照样能加能删，页面整页刷新，只是 pending 动画和行内报错没了，它们要等 JS 加载后才有。三验痕迹：看 dev server 终端，每次提交都有一条 `POST /todos 200` 日志，那就是 Server Action 走的网络通道。

当日产出自查：`/todos` 页面增查删全通；禁 JS 后创建依然成功；项目里搜 `app/api`，一个路由文件都没有。三项齐了，收工。

## 常见踩坑

**坑 1：`'use server'` 放错地方。** 三种典型错法：标在同步函数上（报错，action 必须是 async 函数）；同一文件顶部同时写 `'use client'` 和 `'use server'`（两个指令互斥，直接报错）；在客户端组件里内联定义 action——不行，客户端文件只能 import 别处的 action。函数级 `'use server'` 只能出现在服务端文件或 Server Component 内部，认准这条再动手。

**坑 2：input 忘了写 name。** `formData.get('text')` 拿到 null，九成是 `<input>` 没写 `name="text"`。FormData 只收「有 name 的控件」，id、placeholder 它一概不认；另外 disabled 的控件也不会被收进去。字段名和 get 的参数是同一个字符串，多打一个字母都取不到。

**坑 3：useActionState 的 action 第一个参数是 prevState，不是 FormData。** 签名是 `(prevState, formData)`，状态在前。顺手写成 `async (formData: FormData)`，类型对不上；就算用 any 骗过去，运行时 prevState 位置收到的会是 FormData，逻辑全乱。迁移老代码时最容易在这里想当然，老 useFormState 也是这个顺序，没得讨价还价。

**坑 4：useFormStatus 写在渲染 `<form>` 的组件里，pending 永远是 false。** 它读的是 form 内部的上下文，渲染 form 的组件站在上下文外面。正确姿势是把按钮抽成子组件放进 `<form>` 里，今天的 DeleteButton 就是这个形状。另外它感知的是「自己所在这张表单」的提交，页面上多张表单互不干扰。

**坑 5：改了数据忘调 revalidatePath，界面纹丝不动。** action 执行了、数组也变了，但页面用的还是缓存的渲染结果。规矩定死：每个改数据的 action，末尾必调 `revalidatePath('/todos')`。dev 模式下缓存宽松，可能刷新一下就「好了」，别被骗——`next build` 加 `next start` 跑一遍生产构建，忘了调的地方立刻现形。

**坑 6：内存数组动不动就清零。** 重启 dev server 归零，改了 data.ts 触发热更新也归零，有时你只是加了个分号，列表就「丢了」。这不是 bug，是内存数据库的本性：数据挂在进程上，进程或模块一重载就重来。本周的应对就是接受它，把它当特性；第 4 周 Prisma + 真数据库上场，data.ts 换实现，这页代码一行不改。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 函数级和文件级 `'use server'` 各适合什么场景？它们共同的硬性要求是什么？

::: details 参考答案
函数级写在函数体第一行，适合只在当前 Server Component 用一次的小 action；文件级写在文件第一行，所有导出都是 action，适合集中管理、被多处 import。共同要求：函数必须 async；`'use server'` 不能出现在 `'use client'` 文件里，客户端文件只能 import action。
:::

2. 为什么禁用 JS 后表单还能提交？禁用 JS 会失去哪些东西？

::: details 参考答案
form 的 action 直连 Server Action 时，提交走的是浏览器原生的表单 POST，这是 HTML 的能力，不依赖 JS。失去的是 JS 加载后的「增强」部分：pending 状态、按钮禁用、行内错误提示、无刷新更新，页面会退化为整页刷新的普通表单。
:::

3. useActionState 和 useFormStatus 分别解决什么问题？各自应该写在哪个层级？

::: details 参考答案
useActionState 解决「action 返回值怎么用」：拿到 state（最近一次返回值，含错误信息）和 isPending，写在渲染 `<form>` 的组件里，action 签名随之变成 `(prevState, formData)`。useFormStatus 解决「提交状态怎么读」：给表单内部任意子组件（典型是按钮）读 pending，必须写在 `<form>` 里面的子组件，写在渲染 form 的组件里永远拿到 false。
:::

4. 忘了调 revalidatePath 会发生什么？为什么 dev 里可能看不出来？

::: details 参考答案
数据在 action 里改了，但页面对应路径的渲染结果还在缓存里，界面显示旧数据。dev 模式缓存策略宽松、频繁重编译，经常刷新一下就绕过去了；生产构建里缓存是认真生效的，问题稳定复现。所以规矩是改数据必调 revalidatePath，并用 build + start 验证。
:::

5. deleteTodo 需要拿到列表项的 id，有哪两种写法？各自的代价是什么？

::: details 参考答案
一是 `deleteTodo.bind(null, todo.id)`，调用点直接闭包传参，action 签名是 `(id, formData)`；二是 hidden input 塞 id，action 里 `formData.get('id')` 再转数字，要经过 DOM 且拿到的是字符串需要转换。bind 更直接，是官方文档的推荐姿势。
:::

## 延伸阅读

- [Next.js：Updating Data](https://nextjs.org/docs/app/getting-started/updating-data)，Server Actions 的官方入口，本篇所有概念点的原始出处
- [Next.js：Forms 指南](https://nextjs.org/docs/app/guides/forms)，表单、校验、pending 的组合玩法，比本篇更进一步
- [React：useActionState](https://react.dev/reference/react/useActionState)，返回值三元组和 prevState 的权威定义
- [React：useFormStatus](https://react.dev/reference/react-dom/hooks/useFormStatus)，「必须写在 form 内部」的官方解释

今天的 `app/todos` 留好。data.ts 的三个函数就是第 4 周 Prisma 的接口预演：到时候只换实现，页面和 action 一行不动——你会庆幸今天把数据操作收得这么整齐。
