# 第 2 周 · Day 4：Next.js 15 App Router——让文件约定变成路由

> 对应手册任务：学习「Next.js 15 App Router：文件路由、layout、page、loading」，动手在 `apps/web` 中创建 `/dashboard` 路由，含 loading 和 error 边界，当日产出可访问的 dashboard 页面。本篇只解决一个问题：`apps/web` 还是第 1 周那个 echo 完就退场的 TS 占位包，今天把它正式升级成 Next.js 15 应用，并且路由、布局、加载、错误这四件事全部交给文件约定解决，一行路由配置都不写。

## 今日目标

1. 说得清 App Router 靠哪四个保留文件名驱动路由，page、layout、loading、error 各管什么
2. 掌握三个机制：layout 的嵌套与持久化、loading 与 Suspense 的等价关系、error 边界为什么必须是客户端组件
3. 把 `apps/web` 从占位包升级成 Next.js 15 应用，做出带加载态和错误边界的 `/dashboard` 页面，并记住 Next 15 的新规矩：`searchParams`、`params`、`cookies()` 都是 Promise，先 `await` 再用

## 概念讲解：为什么路由要交给文件管

先看现状。本周前三天把 lint、格式化、提交钩子和单测配齐了，质量门禁立起来了，但 `apps/web` 里还是第 1 周那套占位（[Day 5](/week01/day5) 的 echo 脚本），浏览器里没有任何东西可看。今天给它住进第一个真正的应用。

假设你用熟悉的配置式路由来写，第一件事是建一张路由表：

```tsx
// 配置式路由的典型写法
<Routes>
  <Route path="/" element={<Home />} />
  <Route path="/dashboard" element={<Dashboard />} />
</Routes>
```

这种写法跑得起来，但路由和组件是两张皮：路径字符串写在一处，组件文件躺在另一处，加一个页面两头都要改。更磨人的是配套设施：每个路由的代码分割要手动配，加载态要自己包 `<Suspense>`，出错兜底要自己上 `ErrorBoundary`，漏写一处，用户看到的就是白屏或者转圈到天荒地老。

App Router 把这些全部变成约定：`src/app` 目录下，文件夹名就是 URL 的一段。`app/dashboard/page.tsx` 存在，`/dashboard` 这个路由就存在，文件删掉路由就消失。加载态和错误兜底也不靠你手动包组件，框架在编译时认出 `loading.tsx`、`error.tsx` 这几个文件名，自动把 Suspense 和 ErrorBoundary 接到对应的位置。

一句话：Next.js 不只是帮你省了配置文件，而是把代码分割、流式渲染、错误恢复这些深层能力直接焊在目录结构上。你按约定放文件，能力自动到位。

## 核心知识

### 1. app 目录的文件约定：一张职责矩阵

初始化完成后，`src/app` 长这样（dashboard 一段是今天动手要加的）：

```
src/app/
├── layout.tsx          # 根布局，全站唯一
├── page.tsx            # 首页，对应 /
├── globals.css
└── dashboard/          # 文件夹名 = URL 的一段
    ├── layout.tsx      # dashboard 段布局
    ├── page.tsx        # /dashboard
    ├── loading.tsx     # 加载 fallback
    └── error.tsx       # 错误兜底
```

URL 映射规则只有一条：URL 等于从 `app` 到目标文件夹的路径。`dashboard/settings/page.tsx` 对应 `/dashboard/settings`，`blog/[slug]/page.tsx` 对应 `/blog/任意值`（动态段，今天用不上，混个脸熟）。四个保留文件名各司其职：

| 文件 | 职责 | 关键规则 |
| --- | --- | --- |
| `page.tsx` | 路由入口，渲染页面内容 | 有它路由才存在，没有就 404 |
| `layout.tsx` | 包住本段和所有子段 | 必须接收并渲染 `children`；导航时不重新挂载 |
| `loading.tsx` | 段级加载 fallback | 等价于框架自动包一层 `<Suspense>` |
| `error.tsx` | 段级错误兜底 | 必须是客户端组件，接收 `error`、`reset` 两个 props |

关键在「段」这个字：四个文件都作用于它所在的文件夹这一段。决定路由是否存在的只有 `page.tsx`，其余三个是给这段路由追加能力的，删掉它们路由照常工作，只是没了加载态和错误兜底。另外还有 `not-found.tsx` 管 404 页面、`template.tsx` 是「每次导航都重新挂载的 layout」，今天用不上，知道存在就行。

### 2. layout 的嵌套与持久化

App Router 的页面是俄罗斯套娃。访问 `/dashboard` 时，真正渲染的是三层嵌套：

```tsx
// 结构关系示意
<RootLayout>            {/* app/layout.tsx：html、body，全站唯一 */}
  <DashboardLayout>     {/* app/dashboard/layout.tsx */}
    <DashboardPage />   {/* app/dashboard/page.tsx */}
  </DashboardLayout>
</RootLayout>
```

三条规则。第一，根布局必须有 `<html>` 和 `<body>`，全站只能有一个，它包住所有路由。第二，任何 layout 都必须把 `children` 渲染出来，忘了写，子级内容直接消失。第三条最有意思：持久化。从 `/` 切到 `/dashboard`，根布局不卸载、不重新挂载，组件树里它还在原地，只是 children 换成了新内容；page 则每次导航都是全新的。

这解释了为什么全局导航栏、主题壳这类「全站都在」的东西放根布局：它们只挂载一次，切页面不闪不重置。反过来说，某段页面专属的标题和侧边栏，放该段自己的 layout，别污染别的段。

### 3. loading 与 error：框架替你写的两个边界

React 18 并发特性里有两个词：Suspense（数据没好先显示 fallback）和 ErrorBoundary（子树抛错显示兜底 UI）。它们的共同烦人之处在于都得写代码手动包。App Router 的做法是把这两个词变成文件名。

`loading.tsx` 编译后等价于：

```tsx
<Suspense fallback={<Loading />}>
  {/* 本段的 layout 和 page 都在里面 */}
</Suspense>
```

page 里一旦有 async 数据在等，fallback 立即顶上；数据到了，自动换成真内容。服务器走的是流式渲染：先把带 fallback 的壳发给浏览器，数据算好后再把真页面流过去。用户第一秒就有东西看，而不是干等整页。

`error.tsx` 编译后就是段级的 ErrorBoundary，捕获本段及子段（包括 page）渲染时抛出的错误。它有个反直觉的硬规定：第一行必须是 `'use client'`。原因有二：兜底 UI 里的重试按钮要挂 onClick，事件处理只能发生在客户端；而且如果它是服务端组件，服务端渲染崩了它自己跟着崩，兜底的人先倒下了。签名固定两个 props：

```tsx
"use client";

export default function SegmentError({
  error, // Error & { digest?: string }：错误对象，digest 是日志对账用的哈希
  reset, // () => void：让框架重试渲染本段
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <button onClick={() => reset()}>重试</button>;
}
```

reset 被点击后，框架把边界包住的那段重新渲染一遍。瞬时故障（网络抖动、缓存过期）重试一次可能就好了；确定性 bug 重试多少次都还是错，所以兜底 UI 里除了重试按钮，最好再给一条返回出路。

### 4. Next 15 的新规矩：三个 API 全变成了 Promise

Next 15 把 page 拿到的 `params`、`searchParams`，以及服务端的 `cookies()`、`headers()`，从同步对象改成了 Promise。背景是渲染策略的调整（静态壳加动态洞），对今天的你只需要记住结果：必须 `await`。

```tsx
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams; // ✅ Next 15 的正确姿势
  // const { range } = searchParams;    // ❌ TS 报错：Promise 上不存在 range
}
```

忘了 await 不会当场炸，而是拿到一个未决的 Promise，解构出来全是 undefined，页面「能跑但没数据」。TypeScript 会提前救你：在 Promise 类型上解构属性，红线直接画出来。条件反射记一条：Next 15 里凡是从框架手里接的这四样东西，全要 await。

## 动手任务：升级 apps/web、搭出 /dashboard 一步一步

手册任务：在 `apps/web` 中创建 `/dashboard` 路由，含 loading 和 error 边界。拆成 6 步，全程约 30 分钟。

**第 1 步：清场。** create-next-app 只肯在没有冲突文件的目录里干活，`apps/web` 现有的 package.json、tsconfig.json、src/ 都算冲突。把 apps/web 下的所有文件删掉，保留空的 apps/web 文件夹本身。占位内容本来没什么可留，第 1 周的 git 历史里都找得回来。

**第 2 步：create-next-app 就地初始化。** 在 apps/web 目录下执行，注意结尾的 `.` 表示当前目录：

```bash
pnpm dlx create-next-app@15 . --typescript --eslint --app --src-dir --no-tailwind --import-alias "@/*" --turbopack
```

七个 flag 一次性回答了它的七个提问：用 TypeScript、配 ESLint、走 App Router（不是老的 Pages Router）、代码放 src/ 下、不用 Tailwind（今天自己写样式，少一层干扰）、import 别名 `@/*`、dev 走 Turbopack。终端要是还追问了别的，回车选默认。

装完做两件收尾。打开 apps/web/package.json，把 `name` 从 "web" 改回 `"@ai-agent/web"`，create-next-app 按目录名起名，workspace 里的包名不能丢，丢了 `--filter` 就过滤不到了。再回仓库根目录跑一次 `pnpm install`，让 workspace 重新登记这个包的新依赖。子包自带的 eslint.config.mjs 先留着，第 7 天复盘时再考虑和 Day 1 的根配置合并。

然后启动：

```bash
pnpm --filter @ai-agent/web dev
```

浏览器打开 http://localhost:3000，看到 Next.js 默认首页，升级完成。

**第 3 步：创建 /dashboard 路由。** 在 src/app 下新建 dashboard 文件夹，先放 layout 和 page 两个文件。

```tsx
// src/app/dashboard/layout.tsx
import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <section style={{ padding: "16px 24px" }}>
      <h1>Agent 控制台</h1>
      {children}
    </section>
  );
}
```

```tsx
// src/app/dashboard/page.tsx
type Stats = { conversations: number; tokens: number; activeAgents: number };

async function getStats(range: string): Promise<Stats> {
  // 人为延迟 1.5 秒，模拟真实接口，也给第 4 步留观测窗口
  await new Promise(resolve => setTimeout(resolve, 1500));
  return { conversations: 128, tokens: 86_400, activeAgents: 3 };
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range = "7d" } = await searchParams; // Next 15：先 await 再解构
  if (range === "crash") {
    throw new Error("统计服务超时"); // 第 5 步的错误触发器，先埋上
  }
  const stats = await getStats(range);

  return (
    <div>
      <p>统计周期：{range}</p>
      <ul>
        <li>对话数：{stats.conversations}</li>
        <li>Token 消耗：{stats.tokens}</li>
        <li>在线 Agent：{stats.activeAgents}</li>
      </ul>
    </div>
  );
}
```

保存后访问 http://localhost:3000/dashboard：页面干等 1.5 秒，然后数据一次性出现。注意这段时间没有任何加载提示，体验是灾难级的，第 4 步解决。

**第 4 步：加 loading.tsx。**

```tsx
// src/app/dashboard/loading.tsx
export default function DashboardLoading() {
  return (
    <p role="status" style={{ padding: "24px", color: "#666" }}>
      正在加载统计数据…
    </p>
  );
}
```

再访问 /dashboard：先看到「正在加载统计数据…」，1.5 秒后无缝换成真实内容，从首页切回来也一样。`role="status"` 顺手加了无障碍语义，屏幕阅读器会在内容插入时播报，这就是手册说的「可访问」里最便宜的一条。

原理对照核心知识第 3 节：框架把 loading.tsx 编译成包住整个 dashboard 段的 Suspense，fallback 对应的事实是「page 还没 ready」，不是你手动 setState。一行 Suspense 没写，流式渲染已经在工作。

**第 5 步：加 error.tsx。**

```tsx
// src/app/dashboard/error.tsx
"use client"; // 少了这行，构建直接报错

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: "24px" }}>
      <h2>数据加载失败</h2>
      <p>{error.message}</p>
      <button onClick={() => reset()}>重试</button>
      <a href="/dashboard">返回正常页面</a>
    </div>
  );
}
```

访问 http://localhost:3000/dashboard?range=crash：loading 一闪（甚至来不及看清），错误兜底出现。点「重试」，又回到错误页，因为 range 还是 crash，确定性错误重试不解决，这正是它和「返回正常页面」链接并存的原因，后者是普通 `<a>`，整页导航回去。

两个细节值得看。error.tsx 里能点按钮、能读 error.message，证明它确实跑在客户端。如果这个错误发生在生产构建里，message 会被脱敏成通用文案，只留 error.digest 这个哈希串给你去服务端日志对号入座，开发环境才给你看原文。

**第 6 步：验收。** dev 服务挂着，逐条核对：

- `/dashboard`：先 loading 后数据
- `/dashboard?range=30d`：统计周期显示 30d，证明 await searchParams 整条链路是通的
- `/dashboard?range=crash`：错误页出现，重试可点，返回链接能回正常页
- DevTools 的 Elements 面板里给 `<body>` 加个自定义属性（比如 data-check="1"），在 / 和 /dashboard 之间来回导航，属性一直在，说明根布局没有重新挂载

::: tip 验收命令
`pnpm --filter @ai-agent/web dev` 全程挂着，改文件保存即热更新。四条全绿，当日产出「可访问的 dashboard 页面」就算落地。想多玩一步，把延迟从 1500 改成 5000，来回切路由，体会 fallback 出现的时机和你手写 isLoading 那套方案的差别。
:::

## 常见踩坑

**坑 1：在旧占位包上直接跑 create-next-app。** 报错信息大意是目录里有会冲突的文件。create-next-app 对非空目录里的 package.json、tsconfig.json 零容忍，别和它较劲，先清空再初始化。真想保留旧文件，就生成到旁边的临时目录再挪进来。另外它起包名用的是目录名，workspace 里记得手动改回 `@ai-agent/web`，否则根目录的 `--filter` 和 turbo 任务都找不到这个包。

**坑 2：error.tsx 忘写 'use client'。** 构建会直接失败，提示 error 文件必须是客户端组件。这不是风格建议，是硬约束：reset 的 onClick 是事件处理，只有客户端能干；服务端崩了它还得活着兜底。注意别误伤 loading.tsx，它只做展示，加不加 'use client' 都行，别把「error 必须」记成「都必须」。

**坑 3：Next 15 忘了 await，拿到的是 Promise 不是值。** 典型症状：页面能开，数据位置全空。TypeScript 的信号更早：在 Promise 类型上解构属性，属性不存在，红线直接画出来。开发环境运行时也会给同步访问的警告。一句话规则：Next 15 里 `params`、`searchParams`、`cookies()`、`headers()` 四样，接到手先 await。

**坑 4：在 layout 里写交互。** layout 默认是 Server Component，往里面塞 onClick、useState 那套，保存就报错，大意是事件处理器不能出现在服务端组件里。解法是把交互部分拆成单独文件，顶部加 'use client'，再作为子组件用回来。这正是明天 Day 5 的主题，今天先记住规则：文件顶部没有 'use client'，就当自己跑在服务端，别碰浏览器 API 和事件。

**坑 5：文件名拼错不报错，只是 404。** `page.tsx` 写成 `Page.tsx`，本地 Windows 上可能侥幸跑起来（文件系统大小写不敏感），CI 的 Linux 上必炸；写成 `pages.tsx`、`dashboard.page.tsx`，框架统统不认识，路由静默消失，没有任何报错提醒。loading.tsx、error.tsx 同理，一个字母不能差。怀疑路由没生效时，第一件事核对文件名拼写，第二件事确认文件在 src/app 下面：用了 `--src-dir`，app 目录就在 src 里，直接在包根建 app/ 是白搭。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. page.tsx、layout.tsx、loading.tsx、error.tsx 各自的职责是什么？哪个文件决定了路由是否存在？

::: details 参考答案
page 是路由入口，渲染页面内容，它存在路由才存在；layout 包住本段及所有子段，必须渲染 children，导航时不重新挂载；loading 是段级 Suspense 的 fallback；error 是段级错误边界，必须是客户端组件，接收 error 和 reset。四个文件都作用于所在的段，其中只有 page.tsx 决定路由是否存在，其余三个是给这段追加能力，删掉后路由照常工作。
:::

2. error.tsx 为什么必须是客户端组件？reset 被点击后发生什么？

::: details 参考答案
兜底 UI 需要事件处理（重试按钮的 onClick），事件只能发生在客户端；而且服务端渲染崩溃时服务端组件自己也渲染不出来，兜底的人会先倒下。reset 点击后框架重试渲染边界包住的那段：瞬时错误可能就此恢复，确定性错误会再次进入错误页，所以兜底 UI 里除了重试还要给返回出路。
:::

3. loading.tsx 和 `<Suspense>` 是什么关系？为什么用户第一秒就能看到东西？

::: details 参考答案
loading.tsx 编译时被包成 Suspense fallback，围住该段的 layout 和 page。page 里有 async 数据未就绪时显示 fallback；服务端走流式渲染，先把带 fallback 的壳发给浏览器，数据算好后再把真实内容流过去替换。用户第一秒看到的是壳和 fallback，而不是干等整页。
:::

4. Next 15 里 page 的 searchParams 是什么类型？不 await 会怎样？

::: details 参考答案
是 Promise，比如 `Promise<{ range?: string }>`，必须先 await 再解构。不 await 拿到的是未决的 Promise，解构属性全是 undefined，页面空转；TypeScript 会在编译期报「属性在 Promise 上不存在」，开发环境运行时也有警告。params、cookies()、headers() 同理。
:::

5. layout 的「持久化」指什么？怎么验证？

::: details 参考答案
指导航时 layout 不卸载、不重新挂载，它的 DOM 节点和状态跨页面保留，只有 children 换成新路由内容。验证：在 DevTools 给根布局的节点（如 body）加个自定义属性，页面间来回导航，属性还在，说明这棵子树没有重建。全局导航栏放根布局就是为了只挂载一次。
:::

## 延伸阅读

- [Next.js 官方文档：Layouts and Pages](https://nextjs.org/docs/app/getting-started/layouts-and-pages)，本篇职责矩阵的原始出处，文件约定一节值得精读
- [Next.js 官方文档：Error Handling](https://nextjs.org/docs/app/getting-started/error-handling)，error.tsx、reset 和 digest 机制的官方说明
- [Next.js 15 升级指南](https://nextjs.org/docs/app/guides/upgrading/version-15)，params、searchParams、cookies() 改为 Promise 的官方解释，以后迁移旧项目时照着对

今天升级完的 apps/web 是本周后半程的主战场。明天 Day 5 讲 Server Components 与 Client Components，第一个真正的客户端组件就从 dashboard 页面里拆出来。
