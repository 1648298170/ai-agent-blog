# 第 2 周 · Day 5：Server 与 Client Components——在服务端和浏览器之间画边界

> 对应手册任务：学习「Server Components vs Client Components」，动手写一个 Server Component 获取数据、一个 Client Component 处理交互，组合使用，当日产出两种组件协作的页面。本篇只解决一个问题：昨天 dashboard 已经能从服务端取数了，可一旦要加点击、切换这类交互，组件就得跑到浏览器里去。这条服务端和客户端的边界画在哪、数据怎么过河、什么东西禁止携带，今天一次说清，顺便解释 [Day 4](/week02/day4) 坑 4 那个 onClick 报错的真正原因。

## 今日目标

1. 说得清 RSC 渲染模型：哪些代码只在服务端跑、哪些只在浏览器跑、哪些两边都跑
2. 掌握三个要点：`'use client'` 标的是边界不是组件类型；props 跨边界必须可序列化，函数传不过去；Server 取数、Client 交互的组合模式
3. 在昨天的 `/dashboard` 上动手：mock 数据文件 + Server Component 取数 + Client Component 做周期切换器，组合成完整页面，并亲眼看两次「故意写错」的真实报错

## 概念讲解：为什么组件要分成两种

先复盘昨天。dashboard 的 page 里直接 `await getStats()`，数据没经过任何 API 中转就到了页面里。然后你想加个「切换统计周期」的按钮，onClick 一写，保存就报错，Day 4 坑 4 埋过这颗雷。当时的解法是「先别写交互」，今天把原因挖出来。

App Router 里的组件默认跑在服务端。服务端是 Node 环境，没有浏览器，没有点击、没有输入框、没有 window。「组件 = 浏览器里跑的函数」这个从 SPA 时代带来的默认认知，在今天这个目录结构里被反转了。

为什么要把默认值改到服务端？算一下组件全跑在浏览器里的账单：浏览器得先下载全部组件的 JS 才能开工；数据不能直接拿，得先发请求到某个 API、等响应回来再渲染，白白多一个网络往返；取数代码要单独包一层 API 路由，和展示代码隔着一堵墙；数据库地址、API 密钥这类东西更不敢放进组件，因为组件代码会原样发到每个用户的浏览器里。

组件跑在服务端，这四笔账全免：直接 `await` 取数，不用开 API 中转；密钥和数据库连接留在服务端，浏览器永远看不到；取数逻辑不进浏览器，bundle 更小；首屏 HTML 在服务端直接生成发出去。昨天 loading 到数据那条链路，背后就是这套模型在跑。

但交互物理上只能发生在浏览器里。点击、聚焦、滚动、动画，这些是浏览器的事件，服务端再强也代劳不了。所以答案不是「全部回服务端」，而是拆成两种：**Server Component 只在服务端跑，负责取数和拼装；Client Component 的代码发到浏览器里跑，负责一切交互**。默认人人都是 Server，谁要交互，谁在文件顶上写 `'use client'`，自己下到浏览器。

## 核心知识

### 1. 渲染模型：谁在哪里跑，跑几遍

| | Server Component | Client Component |
| --- | --- | --- |
| 在哪跑 | 只在服务端 | 首屏在服务端预渲染，之后在浏览器 |
| 浏览器里有它的代码吗 | 没有，只有渲染结果 | 有，整个文件进 bundle |
| 擅长 | async 取数、读数据库、用密钥 | useState、事件、window/localStorage |
| 禁忌 | hooks、onClick、浏览器 API | 直接取数、放密钥、async 组件 |

「跑几遍」值得单独说。Server Component 只跑一遍：请求来了，服务端把它渲染成结果（一串描述 UI 的数据，不是组件代码），发给浏览器，它的使命就结束了。Client Component 是「两次都跑」：首次请求时服务端会把它预渲染成 HTML，不然首屏白屏；浏览器下载 JS 后执行 hydration，把静态 HTML 激活成可交互的，从这以后每次交互都跑在浏览器里。昨天 error.tsx 的重试按钮能点，说明它走完了「预渲染 + hydration」两步。

访问 `/dashboard` 的完整时间线：服务端渲染整棵树，Server 组件出结果、Client 组件出预渲染 HTML → HTML 流进浏览器，用户先看到内容 → 浏览器下载 JS → hydration 接管，按钮活了。前半段服务端说了算，hydration 之后浏览器说了算。

### 2. 'use client' 的真实含义：边界，不是组件类型

最常见的误解：以为 `'use client'` 是给某个组件贴「客户端组件」的标签。不是。它声明的是一条边界：**从这行所在的文件开始，这个文件和它 import 的一切，都是客户端代码**。

三个直接推论。第一，没写 'use client' 的文件 import 了写了的文件，前者仍是服务端组件，后者是边界以内的客户端「岛」，今天的 page 和 StatsBoard 就是这个关系。第二，判断一个组件跑在哪，不是看它自己写没写这行，而是沿 import 链向上找有没有穿过边界。第三，指令必须写在文件最顶部、所有 import 之前，写在别处等于没写。

边界的方向也有讲究：Server 可以 import Client，反过来不行，客户端组件里 import 一个服务端组件当孩子用是不允许的。数据要过河，只能走 props 这条独木桥，下一节说它能装什么。

### 3. props 跨边界：只带得走可序列化的东西

Server 给 Client 传 props，本质是寄快递：服务端把值序列化后写进发给浏览器的内容里，浏览器拆开还原。快递能装的东西必须能被序列化表达：数字、字符串、布尔、数组、普通对象都没问题，Date、Map、Set 这类 React 也做了支持。装不下的是：函数、类实例。

重点说函数为什么不行。函数是「将来要在浏览器里执行的代码」，它还背着闭包，闭包里可能引用着服务端的数据库连接、密钥、随便什么大对象。把这样一个东西搬进浏览器，既做不到（没法序列化），也不该做（等于把服务端内部敞开给用户）。所以 React 直接拒绝，报错大意是：函数不能直接传给 Client Components。

这不是缺陷，是设计。它逼你把「数据」和「行为」分开：数据从服务端来，走 props；行为（事件回调）只能定义在客户端组件内部。那如果回调想改的是服务端取来的数据呢？出路有两个：把相关组件包进一个更大的客户端组件，把状态提升到它身上，这是后面写复杂交互页的基本功；或者用 Server Actions，明天 Day 6 的主角。今天先把规矩焊死：onClick 的函数体永远写在客户端文件里。

有个例外值得知道：children 可以。服务端组件把已经渲染好的 JSX 当 children 塞给客户端组件是合法的，因为传过去的不是函数，是渲染结果。用一个客户端组件当外壳、里面装服务端渲染的内容，是后面会用到的组合技巧。

### 4. 组合模式：Server 取数，Client 交互

两种组件的标准协作一句话：数据在最外层的 Server Component 里取好，往下传给做交互的 Client 组件，方向永远从 Server 指向 Client：

```tsx
// page.tsx（Server）：async 取数，把纯数据递过边界
const stats = await getStats("7d");
return <StatsBoard stats={stats} />; // StatsBoard 是客户端的岛
```

这个模式下，'use client' 应该尽量往叶子下沉：只有真正需要交互的那个小组件下到浏览器，取数、布局、拼装全留在服务端，边界越小，进浏览器的代码越少。反模式是把 page 整个标成 'use client'，等于一夜回到 SPA 时代，坑 2 专门说它。

## 动手任务：两种组件协作的页面 一步一步

手册任务：写一个 Server Component 获取数据、一个 Client Component 处理交互，组合使用。就在昨天的 `/dashboard` 上做，拆成 6 步，全程约 30 分钟。数据获取先用手写 mock 模拟 fetch，第 4 周 NestJS API 就绪后只换 `getStats` 一个函数，组件一行不动。

**第 1 步：建 mock 数据文件。** 把取数逻辑从 page 抽出来，新建 `src/lib/mock-stats.ts`，顺便支持三个统计周期：

```ts
// src/lib/mock-stats.ts
export const RANGES = ["7d", "30d", "90d"] as const;
export type Range = (typeof RANGES)[number]; // "7d" | "30d" | "90d"

export type Stats = {
  conversations: number;
  tokens: number;
  activeAgents: number;
};

const MOCK_TABLE: Record<Range, Stats> = {
  "7d": { conversations: 128, tokens: 86_400, activeAgents: 3 },
  "30d": { conversations: 574, tokens: 401_300, activeAgents: 5 },
  "90d": { conversations: 1_802, tokens: 1_286_000, activeAgents: 7 },
};

export async function getStats(range: Range): Promise<Stats> {
  // 模拟网络延迟；第 4 周接 NestJS 时删掉这行，换成真的 fetch
  await new Promise(resolve => setTimeout(resolve, 800));
  return MOCK_TABLE[range];
}
```

`(typeof RANGES)[number]` 是第 1 周类型知识的日常应用：从常量数组里把字面量联合类型抠出来，以后改 RANGES 的值，Range 自动跟着变，不用两头维护。

**第 2 步：写 Client Component。** 新建 `src/app/dashboard/stats-board.tsx`，今天的主角之一：

```tsx
// src/app/dashboard/stats-board.tsx
"use client"; // 边界从这行开始：本文件和它 import 的一切都跑在浏览器里

import { useState } from "react";
import type { Range, Stats } from "@/lib/mock-stats"; // type 导入编译后擦除，不算把服务端代码带进浏览器

export default function StatsBoard({
  statsByRange,
}: {
  statsByRange: Record<Range, Stats>; // 从服务端漂过来的：纯数据，可序列化
}) {
  const [range, setRange] = useState<Range>("7d"); // state 只能长在客户端
  const stats = statsByRange[range];

  return (
    <div>
      <nav style={{ marginBottom: 16 }}>
        {(Object.keys(statsByRange) as Range[]).map(r => (
          <button
            key={r}
            onClick={() => setRange(r)} // 回调定义在这里，不是从服务端传进来的
            disabled={r === range}
            style={{ marginRight: 8 }}
          >
            {r}
          </button>
        ))}
      </nav>
      <ul>
        <li>对话数：{stats.conversations}</li>
        <li>Token 消耗：{stats.tokens.toLocaleString()}</li>
        <li>在线 Agent：{stats.activeAgents}</li>
      </ul>
    </div>
  );
}
```

对照核心知识逐条检查：'use client' 在第一行；useState 和 onClick 全在文件内部，没有一样从外面传进来；props 只有 `Record<Range, Stats>` 这种纯数据结构，序列化毫无压力。

**第 3 步：改写 page.tsx。** Server Component 负责取数和组合，把昨天的 page 整个替换：

```tsx
// src/app/dashboard/page.tsx
import StatsBoard from "./stats-board";
import { getStats, type Range, type Stats } from "@/lib/mock-stats";

export default async function DashboardPage() {
  // 三份数据并行取，总耗时约 800ms，不是 800 × 3
  const [stats7d, stats30d, stats90d] = await Promise.all([
    getStats("7d"),
    getStats("30d"),
    getStats("90d"),
  ]);

  const statsByRange: Record<Range, Stats> = {
    "7d": stats7d,
    "30d": stats30d,
    "90d": stats90d,
  };

  // 数据在这里过边界：Server 递给 Client，只带数据，不带行为
  return <StatsBoard statsByRange={statsByRange} />;
}
```

保存后访问 http://localhost:3000/dashboard：昨天写的 loading.tsx 先出现约 800ms，然后三个按钮和 7d 的数据一起出来。点 30d、90d，内容瞬间切换，loading 不再出现，因为切换发生在浏览器里，压根没回服务端。这就是「取数在服务端、交互在客户端」的体感。昨天的 range=crash 触发器随旧 page 退休，error.tsx 留着，将来接真 API 出错时它还会出手。

**第 4 步：犯罪现场 A，在 Server Component 里用 hooks。** 打开 page.tsx，顶部加 `import { useState } from "react";`，再在 DashboardPage 函数体第一行加：

```tsx
const [range, setRange] = useState<Range>("7d"); // 故意的，看完报错就删
```

保存，终端和页面同时报错，大意是：你导入的东西需要 useState，它只能在 Client Component 里用，但这个文件及其父级都没标 'use client'。两个细节值得看：TypeScript 没拦你，这个 import 类型上完全合法，错误是 Next 在编译运行时才抛的；报错给的出路很明确，要么标 'use client'，要么别用 hooks。看完把这两行删掉，恢复原状。

**第 5 步：犯罪现场 B，把函数当 props 传过边界。** 先给 StatsBoard 动个小手术：props 类型里加一行 `formatTokens: (n: number) => string;`，渲染 Token 的那行改成 `<li>Token 消耗：{formatTokens(stats.tokens)}</li>`。然后在 page.tsx 里传入：

```tsx
return (
  <StatsBoard statsByRange={statsByRange} formatTokens={n => n.toLocaleString()} />
);
```

保存，报错大意是：函数不能直接传给 Client Components。箭头函数再小也是函数，过不了序列化这一关。修法照核心知识第 3 节的规矩：行为挪进客户端组件内部。把 formatTokens 相关改动全撤掉，恢复成第 2 步里 `stats.tokens.toLocaleString()` 的写法。

两次犯罪都值回票价：一个告诉你 hooks 是客户端专属，一个告诉你函数是边界上的违禁品。

**第 6 步：验收。** dev 服务挂着，逐条核对：

- `/dashboard`：loading 先出现，约 800ms 后按钮和数据一起到
- 点 30d / 90d：秒切，loading 不再出现，当前周期按钮呈 disabled 态
- DevTools 的 Sources 面板能搜到 stats-board 的代码；getStats 和 MOCK_TABLE 不在浏览器里
- 全项目搜 'use client'，只出现在 stats-board.tsx 和昨天的 error.tsx，page 没被传染

::: tip 验收命令
`pnpm --filter @ai-agent/web dev` 全程挂着。想加深体感，把 mock 延迟从 800 改成 3000：首屏 loading 变成 3 秒（取数在服务端，慢在等服务端），但切换周期永远是 0ms（交互在浏览器，不碰网络）。一处延迟的改动，两种截然不同的现象，正好对应边界的两侧。
:::

## 常见踩坑

**坑 1：在 Server Component 里用 hooks。** 症状就是第 4 步的报错。hooks 的本质是把状态挂在浏览器里那棵持久的组件树上，服务端渲染是一次性的，没有「这棵树」可挂，useState、useEffect、useRef 在服务端全都没有意义。发现自己在 page.tsx 里想写 useState，先停一下问自己：这是交互状态吗？是，就把它连同用到它的 UI 拆进一个 'use client' 文件；不是（比如只是个格式化的中间值），普通 `const` 就够了。

**坑 2：图省事把整个 page 标成 'use client'。** 一时痛快，账单在后面：page 不能再是 async 组件，直接 await 取数的路断了（客户端组件不支持 async，报错大意是 Client Components 还不支持 async/await）；哪天手滑把数据库连接、密钥写进来，会原样打进浏览器 bundle；首屏退化成先下载 JS 再渲染，loading.tsx 那套流式渲染的收益也没了。正确姿势是把 'use client' 往叶子推：只让真正交互的小组件下浏览器，其余全留服务端。

**坑 3：把函数、类实例当 props 传给客户端组件。** 第 5 步亲眼看过报错了。记住三条出口：事件回调写在客户端组件内部；数据在服务端预取好再传；服务端渲染好的 JSX 可以当 children 传，那不是函数，是渲染结果。多个组件要联动交互时，就再包一层客户端组件把状态提升上去，这是后面写复杂页面的基本功。

**坑 4：'use client' 写错位置，或者方向搞反。** 位置错：指令必须在文件第一行、所有 import 之前。写在 import 后面它就是个普通字符串，框架不认，你还会纳闷明明写了怎么还报 hooks 错误。方向反：依赖箭头只能 Server 指向 Client。想在一个客户端组件里 `import { getStats } from "@/lib/mock-stats"` 直接取数，等于把取数代码拖进浏览器，密钥泄漏、bundle 膨胀都是这么来的。数据要进客户端，永远走 props。

**坑 5：客户端组件里用 useEffect 加 fetch 取数。** 这是从旧项目带来的肌肉记忆：挂载后发请求、setState 存数据、手动管 loading。在 RSC 里这套优先级最低：数据能上移到服务端组件就上移，客户端只管交互。今天 stats-board 里一行取数代码都没有，这是最健康的形态。真有必须客户端取数的场景（比如依赖浏览器地理位置），到那天再写不迟，别一上来就滑回老路。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 一个文件顶部没写 'use client'，它一定是 Server Component 吗？判断一个组件跑在哪，准确依据是什么？

::: details 参考答案
默认情况下是。准确依据是 import 链：从入口往下，只要没穿过任何 'use client' 边界，所有文件都是服务端组件；一旦穿过，边界所在的文件和它 import 的一切都是客户端代码。'use client' 标的是边界不是组件类型，所以看一个组件跑在哪，要沿它的导入链向上找边界，而不是只看它自己写没写这行。
:::

2. Server Component 和 Client Component 各跑几遍、分别在哪跑？

::: details 参考答案
Server Component 只跑一遍，在服务端，把渲染结果（不是组件代码）发给浏览器，代码不进 bundle。Client Component 两次都跑：首屏由服务端预渲染成 HTML，浏览器下载 JS 后 hydration 激活，此后每次交互都跑在浏览器里。服务端那遍是为了首屏速度和可抓取的 HTML，浏览器那遍是为了交互。
:::

3. 为什么函数不能当 props 从 Server 传给 Client？如果点击按钮后想改变服务端取来的数据，有哪些出路？

::: details 参考答案
props 跨边界靠序列化，函数背着闭包，闭包可能引用服务端的数据库连接和密钥，既没法序列化也不该暴露给浏览器。这是刻意设计，逼你把数据和行为分开。出路：事件回调定义在客户端组件内部；跨组件联动就把它们包进一个更大的客户端组件，把状态提升上去；要真正触发服务端逻辑，用 Server Actions，明天 Day 6 的主题。
:::

4. 数据库连接串、onClick、await 取数、localStorage、useState，这五样分别只能放哪边？

::: details 参考答案
数据库连接串和 await 取数只能放服务端组件，放客户端轻则报错，重则密钥进 bundle；onClick、localStorage、useState 只能放客户端组件，服务端没有浏览器环境和事件。分不清时问一句「这东西离开浏览器还有意义吗」：有，放服务端；没有，放客户端。
:::

5. 为什么不建议把 page.tsx 整个标成 'use client'？'use client' 的最佳落点在哪？

::: details 参考答案
整页标 client 后：async 组件直接 await 取数的路断了；服务端专属代码可能被打进浏览器 bundle；首屏退回先下 JS 再渲染，流式渲染和 loading.tsx 的收益消失。最佳落点是交互的最小单元：把 'use client' 往叶子组件下沉，边界尽量小，取数和拼装留在服务端，只有真正响应事件的那个小组件下到浏览器。
:::

## 延伸阅读

- [Next.js 官方文档：Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)，本篇渲染模型和组合模式的原始出处，值得通读
- [React 官方文档：Server Components](https://react.dev/reference/rsc/server-components)，RSC 的设计动机，函数为什么不能过边界讲得最透
- [Next.js 官方文档：use client 指令](https://nextjs.org/docs/app/api-reference/directives/use-client)，指令位置规则和边界语义的权威说明

今天页面里「函数传不过边界」的别扭，明天 Day 6 的 Server Actions 会给出官方解法：标了 'use server' 的函数，可以被客户端组件合法调用。
