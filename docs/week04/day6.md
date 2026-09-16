# 第 4 周 · Day 6：前端消费——Next.js 调用 NestJS API

> 对应手册任务：学习「前端消费：Next.js 调用 NestJS API」，动手「在 `apps/web` 的 Server Component 中 fetch NestJS 的 `/users`，渲染列表」，当日产出「前后端联调成功」。本篇只解决一个问题：mock 数组和 PostgreSQL 是两套事实，今天用一次服务端 fetch 把它们接通，接完还要换环境不改代码。

## 今日目标

1. 说得清 Server Component 里 fetch 的三条规矩——必须绝对地址、地址走环境变量、Next 15 默认不缓存——以及为什么今天不用配 CORS
2. 掌握三件配套设施：`lib/api.ts` 统一取数出口（复用 [第 1 周 Day 6](/week01/day6) 的 `ApiResponse<T>` 契约）、`loading.tsx` 流式加载、`error.tsx` 错误兜底
3. 独立完成 `/users` 列表页和 `/users/[id]` 详情页，改库立刻可见、后端停机有兜底

## 概念讲解：从 mock 到真数据隔着什么

先摆现状：`apps/web` 页面里的数据还是组件顶部的 `const mockUsers = [...]`，而 `apps/api` 的 `/users` 身后站着 Prisma 和 PostgreSQL——前五天你刚建的。两套事实各活各的：库里加个用户，页面不知道；页面里那个 Jerry，库里查无此人。联调就是把「渲染」和「数据」之间的等号接上。

接的时候，十个人里九个的第一反应是 `fetch('/api/users')`。但 Server Component 跑在 Next 的 Node 服务里，不在浏览器：浏览器发请求时有「当前页面的源」，相对路径会被自动补全；Node 的 fetch 没有 origin 可参照，解析不了，直接抛 `TypeError: Failed to parse URL`。第一条规矩：服务端 fetch 必须绝对地址。

那好，`fetch('http://localhost:4000/users')`（4000 是第 3 周 Day 3 定的端口，3000 让给了 apps/web）。本机能跑，也只在本机能跑。翻车来得很快：上线换域名；docker-compose 里 web 和 api 是两个容器，web 容器的 `localhost` 是它自己，api 不在那儿；换台机器端口又不同。地址是环境的属性，环境的属性不写死在代码里，交给环境变量。

最后摘掉一块心病：CORS。你可能已经准备去后端配 CORS 了，今天不用。CORS 是浏览器的安全机制：浏览器替页面发跨源请求前，要先问目标服务器同不同意，不同意就扣下响应。今天的 fetch 发生在 Next 的服务端，Node 不是浏览器，不执行这套检查，服务端到服务端和 curl 一样自由。什么时候会撞上？等你在 Client Component 里让浏览器直连 4000 那天（第 2 周 Day 6 的场景接真后端时），到时再配。

## 核心知识

### 1. 取数三件套：绝对地址、环境变量、契约类型

环境变量放在 `apps/web/.env.local`，Next 会自动加载：

```bash
API_URL=http://localhost:4000
```

没带 `NEXT_PUBLIC_` 前缀，它只在服务端可见，不进浏览器产物——内部 API 的地址本就不该让浏览器知道。取数代码收进统一出口 `apps/web/lib/api.ts`：

```ts
import { type ApiResponse, type User } from '@my/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function getUsers(): Promise<User[]> {
  // fetch 对 4xx/5xx 不抛错，只有网络层失败才抛，状态得自己看
  const res = await fetch(`${API_URL}/users`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`GET /users 失败：${res.status}`);
  }
  const body: ApiResponse<User[]> = await res.json();
  return body.data;
}
```

关键一行是 `const body: ApiResponse<User[]> = await res.json()`：第 1 周 Day 6 说的「前端 fetch 的返回值都标注为 `ApiResponse<T>`」，今天兑现。`json()` 返回的类型是 `any`，[Day 1](/week01/day1) 讲过 any 会沿调用链传染，这行就是截断点，`body.data` 之后的字段都有编译器背书。如果你的 `/users` 走第 3 周 Day 4 留的另一个口子——直接返回数组不包壳——标注改成 `User[]`、去掉 `.data` 即可。

`User` 为什么放 `@my/shared`？在 web 里再抄一份是两处维护，字段一改两边漂移，单一事实来源的道理第 1 周 Day 6 讲透了；从 apps/api 的 Prisma 生成类型直接 import，等于把表结构泄漏进前端，还制造源码级耦合——表里将来会有 `passwordHash` 这种不该出门的字段。shared 的 `User` 是对外契约，只暴露自愿暴露的子集。

### 2. fetch 缓存语义：Next 15 默认不缓存

Next 14 及更早，App Router 的 fetch 默认缓存（`force-cache`）；Next 15 反转：默认不缓存，每次请求都发真 HTTP。四种写法摆一起看：

```ts
fetch(url);                                // 15 默认：不缓存，等同 no-store
fetch(url, { cache: 'no-store' });         // 显式写出来，语义同上，意图更清楚
fetch(url, { next: { revalidate: 60 } });  // 缓存 60 秒，过期后下次请求取新值
fetch(url, { cache: 'force-cache' });      // 缓存直到主动重新验证
```

怎么选，看「数据变了要不要立刻看见」：管理列表刚改完就要核对，用 `no-store`；统计面板容忍分钟级延迟，`revalidate: 60` 省一大堆重复请求。今天的 users 列表用 `no-store`：联调阶段改库，页面必须立刻反映。至于这个反转带来的「旧教程还能不能信」，坑 3 一起说。

### 3. loading.tsx 与 error.tsx：把等待和故障变成 UI

数据要过 Prisma、Nest、HTTP 三道手，快不了也保不齐，App Router 给了两件开箱设施。

`loading.tsx`：放在路由段下，Next 自动把该段页面包进 Suspense，先流兜底内容、数据到了再补真实内容，感知从「白屏等待」变成「骨架先行」。

`error.tsx`：路由段的错误边界。后端停机时 fetch 抛 `TypeError: fetch failed`，`!res.ok` 时你 throw 的错，都被它接住。两条硬规矩：顶部必须写 `'use client'`（要渲染「重试」按钮，点击只有浏览器能处理）；接得住本段及子段页面组件的错，接不住同级 layout 的错（归 `global-error` 管）。

还有个容易混的：404 不是错误，查无此人是正常业务结果，用 `notFound()` 渲染专门的 not-found 界面，别 throw 进 error 边界。

## 动手任务：列表页 + 详情页一步一步

手册任务：在 Server Component 里 fetch NestJS 的 `/users` 并渲染列表，外加详情页。拆 6 步，全程约 40 分钟。

**第 1 步：把后端立起来。** 启动 Postgres（第 4 周 Day 1 的 `docker compose up -d`），另开终端在 `apps/api` 执行 `npm run start:dev`，然后 `curl http://localhost:4000/users` 确认拿到真数据。

**第 2 步：对齐契约。** 检查 `packages/shared` 里的 `User`：字段以 `schema.prisma` 为准，至少 `id`、`name`、`email`，要展示 `createdAt` 就补上，在 `src/index.ts` re-export。改过源码回仓库根目录跑 `pnpm turbo build --filter=@my/shared`（产物在 `dist/`，不重建下游看到的还是旧类型）。再确认 `apps/web/package.json` 里有 `"@my/shared": "workspace:*"`，接过线的话 `pnpm install` 一次即可。

**第 3 步：环境变量 + 取数出口。** `apps/web` 下新建 `.env.local`，写入上面那行 `API_URL`；再新建 `lib/api.ts`，内容照抄核心知识 1 的 `getUsers`。

::: tip .env.local 不进 git
`.env.local` 默认被 ignore，这是对的——它本来就因环境而异。给仓库留一份 `.env.example`（只写键名），新同事复制改名就能跑。
:::

**第 4 步：列表页。** 新建 `apps/web/app/users/page.tsx`：

```tsx
import Link from 'next/link';
import { getUsers } from '@/lib/api'; // @ 别名是 create-next-app 自带的

export default async function UsersPage() {
  const users = await getUsers();
  return (
    <main>
      <h1>用户列表</h1>
      <ul>
        {users.map((u) => (
          <li key={u.id}>
            <Link href={`/users/${u.id}`}>{u.name}</Link>（{u.email}）
          </li>
        ))}
      </ul>
      {users.length === 0 && <p>还没有用户，先 POST 一条</p>}
    </main>
  );
}
```

关键在 `async`：Server Component 里直接 `await` 取数是官方姿势（第 2 周 Day 5）。空数组分支别省，空库打开页面时它就是全部体验。

**第 5 步：详情页。** 先给 `lib/api.ts` 加一个函数：

```ts
export async function getUser(id: number): Promise<User | null> {
  const res = await fetch(`${API_URL}/users/${id}`, { cache: 'no-store' });
  if (res.status === 404) return null; // 查无此人是正常结果，交给页面调 notFound()
  if (!res.ok) {
    throw new Error(`GET /users/${id} 失败：${res.status}`);
  }
  const body: ApiResponse<User> = await res.json();
  return body.data;
}
```

再新建 `apps/web/app/users/[id]/page.tsx`：

```tsx
import { notFound } from 'next/navigation';
import { getUser } from '@/lib/api';

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>; // Next 15：params 是 Promise，不是对象
}) {
  const { id } = await params; // 必须 await，否则拿到的是 Promise 对象
  const userId = Number(id); // 路径参数到手是字符串，第 3 周 Day 4 的老坑
  if (Number.isNaN(userId)) notFound();
  const user = await getUser(userId);
  if (!user) notFound();
  return (
    <main>
      <h1>{user.name}</h1>
      <p>邮箱：{user.email}</p>
    </main>
  );
}
```

关键一行是 `params: Promise<{ id: string }>`：Next 15 的破坏性变更，14 里 params 是普通对象，15 起是 Promise，必须 `await`。看到不 `await` 的写法，那是 14 时代的教程，直接翻页。

**第 6 步：loading、error、验收。** 新建 `apps/web/app/users/loading.tsx`：

```tsx
export default function Loading() {
  return <p>正在加载用户…</p>;
}
```

再新建 `apps/web/app/users/error.tsx`：

```tsx
'use client';

export default function UsersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <h2>用户服务暂时不可用</h2>
      <p>{error.message}</p>
      <button onClick={() => reset()}>重试</button>
    </main>
  );
}
```

两个文件都放 `app/users/` 段下，详情页（`/users/[id]`）是它的子段，同样受用。最后按清单验收，逐条亲眼看：

1. 两个服务都起，访问 `http://localhost:3000/users`，列表内容与数据库一致
2. 用 POST 接口或 Prisma Studio 加一条用户，刷新页面立刻出现——`no-store` 生效的证据
3. 点名字进详情页；访问 `/users/9999`，看到 404 界面而不是 error 兜底
4. `Ctrl+C` 停掉 Nest，刷新列表页，看到 error.tsx 兜底；先重新起 Nest 再点「重试」，页面恢复

都过了就提交：`feat(web): users 列表与详情接入 NestJS API`。

## 常见踩坑

**坑 1：相对路径在 Server Component 里必炸，在浏览器里却好好的。** `fetch('/api/users')` 在 Client Component 里能跑（有 origin 可补全），搬到 Server Component 就 `Failed to parse URL`。判断标准只有一条：代码跑在哪，Node 里必须绝对地址。

**坑 2：把 localhost 写进代码，进容器当天就挂。** 硬编码 `http://localhost:4000`，本机正常；进了 Docker，`localhost` 指向 web 容器自己，api 近在咫尺却找不到，构建期零报错，只在运行时 502。规矩：地址只从 `process.env.API_URL` 来，各环境各配各的值，代码一个字不动。

**坑 3：抄 Next 14 教程，一抄两个坑。** 坑一：params 从对象变 Promise，不 `await` 就用，轻则渲染错乱，重则报错。坑二：fetch 默认从缓存反转为不缓存，「默认有缓存」的 14 心智整段作废。识别旧教程最快特征：`params: { id: string }` 没包 Promise。

**坑 4：把 404 扔进 error 边界。** 图省事写 `if (!res.ok) throw`，用户访问一个删掉的用户，看到「服务不可用」加重试按钮——重试一万次也是 404。语义分流：404 走 `notFound()`，有专门界面；5xx、网络断才 throw 给 error.tsx。

**坑 5：改了 shared 忘了重新构建。** shared 的类型活在 `dist/*.d.ts` 里，改了 `src/` 不重跑 build，apps/web 看到的还是旧形状：新字段点不出来，删掉的字段还留着。先 `pnpm turbo build --filter=@my/shared`；第 1 周 Day 5 的管道若挂了 `^build`，构建 web 时自动带上。User 字段对不上的编译报错是契约在报警，把 shared 对齐 schema，别改成 any。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么 Server Component 里 fetch 必须写绝对地址？同样的 `fetch('/api/users')` 在浏览器里为什么可以？

::: details 参考答案
相对地址要参照「当前源」补全。浏览器有页面 origin（协议+域名+端口），自动补成完整 URL；Server Component 跑在 Node 里，没有 origin，fetch 解析不了相对路径，直接抛 `TypeError: Failed to parse URL`。
:::

2. Next 15 里 fetch 的默认缓存行为是什么？`no-store`、`revalidate: 60`、`force-cache` 各适合什么场景？

::: details 参考答案
默认不缓存（14 及以前默认缓存，15 反转）。改完要立刻可见的用 `no-store`；容忍分钟级延迟、读多写少的用 `next: { revalidate: 60 }`；几乎不变的用 `force-cache`。拿不准就实测，看后端日志有没有新请求。
:::

3. 今天的方案为什么不受 CORS 限制？什么时候会真的撞上？

::: details 参考答案
CORS 是浏览器执行的安全机制，管的是浏览器页面跨源发请求。今天的 fetch 在 Next 的 Node 服务端，服务端之间不经过浏览器，CORS 不登场。等哪天在 Client Component 里让浏览器直连 `localhost:4000`（端口不同就是跨源）才会撞上，届时在 Nest 开 CORS 或改同源代理。
:::

4. `error.tsx` 为什么必须是 Client Component？`reset` 是干什么的？它接不住哪些错误？

::: details 参考答案
它要渲染「重试」按钮并响应点击，交互只发生在浏览器；`reset` 是 Next 传入的重试函数，调用会重新渲染出错的路由段。它接不住同级及上层 layout 的错（root layout 归 `global-error.tsx` 管），也接不住 `notFound()`（那走 not-found 界面）。
:::

5. `User` 类型为什么放 `@my/shared`，而不是在 web 里再抄一份、或直接 import apps/api 的 Prisma 生成类型？

::: details 参考答案
再抄一份破坏单一事实来源，字段一改两边漂移（第 1 周 Day 6）；直接引 Prisma 生成类型等于把表结构泄漏进前端，表里将来会有不该出门的字段（密码哈希）。shared 的 `User` 是对外契约，只暴露自愿暴露的子集。
:::

## 延伸阅读

- [Next.js 官方文档：Fetching Data](https://nextjs.org/docs/app/getting-started/fetching)，App Router 取数的官方姿势，本篇第 2、3 节的原始出处
- [Next.js 官方文档：error.js 文件约定](https://nextjs.org/docs/app/api-reference/file-conventions/error)，错误边界的字段与层级关系，含 `global-error`
- [MDN：CORS](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/CORS)，跨源机制的本质讲解，为浏览器直连那天备好

今天的 `lib/api.ts` 和两个页面留好。这根管子今天是单行的：只读。想让页面「写」数据，得让浏览器直连 API，CORS 预告届时兑现。明天 Day 7 是阶段一里程碑验收：monorepo、lint/test、Next.js、NestJS、PostgreSQL、Prisma 一条链过秤，本周完整日程见[第 4 周目录](/week04/)。
