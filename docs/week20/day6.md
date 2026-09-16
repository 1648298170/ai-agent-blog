# 第 20 周 · Day 6：平台导航 + 页面整合——把二十周的零件装进一个壳

> 对应手册任务：学习「平台导航 + 页面整合」，动手「把对话、知识库、工具管理、监控整合到统一导航」，当日产出「平台主链路」。本篇只解决一个问题：二十周攒下的功能各自能跑，却散落在五个入口里，今天用一张按使用频率排的导航树和一个平台壳布局，把它们装进同一扇门，让「打开平台 → 干活」全程不换窗口。

## 今日目标

1. 说得清信息架构怎么定：五页导航树的排序依据是使用频率和角色可见性，不是功能分类
2. 掌握 App Router 的布局嵌套：平台壳（侧边导航 + 顶栏）包住所有页面，激活态、面包屑、外链各自怎么处理
3. 独立完成审批中心页和路由守卫（未登录跳登录、角色不够进 403），并把「前端只做体验，防线在后端」这条边界讲给别人听

## 概念讲解：为什么功能都齐了，还不算一个平台

先盘点现状。对话页面是昨天刚升级的流式 UI，跑在根路径；知识库管理界面是第 15 周做的，当时是个独立工程；MCP Server 跑没跑、挂了几台，要翻日志才知道；高危工具调用要审批，第 13 周做的 interrupt 机制在第 18 周升级过，审批按钮长在对话气泡里，审批人得守着对话窗口等它弹出来；监控在 Grafana，另一个域名，另一套账号。

五个能力，五个入口。开发者自己用，忍忍就过去了。真实用户面对的是：记五个网址，登五次，审批人天天蹲在对话流里翻 interrupt。功能完成度 100%，产品完成度可能只有 60%，缺的那 40% 叫整合。今天是总装日。

整合不是把链接堆到一个页面完事，要先回答两个问题。第一，用户进来第一眼该看到什么，导航按什么排。第二，哪些东西是所有页面共用的，壳里放什么。前者是信息架构，后者是布局，今天各解决一半，合成一个平台。

信息架构的第一条纪律：导航按使用频率排序，不按功能分类。功能分类是开发者的视角（对话、存储、工具、监控），用户不这么想，用户想的是「我每天来干什么」。对话是主入口，所有人每天都用，排第一；审批中心只有 approver 和 admin 能见，但审批人每天要看，排第二；知识库传文档查切片，周频，排第三；工具管理看 MCP Server 状态和高危工具清单，低频但出事时关键，排第四；监控直接外链 Grafana，点开新窗口，因为 Grafana 本身就是完整界面，再套一层壳纯属多余。

这条纪律的另一半是角色：member 的侧边栏里就不该出现审批中心和工具管理，不是置灰，是不出现。置灰是提醒开发者这里还有功能，消失才是对用户的诚实。

## 核心知识

本节的代码基于 Next.js App Router（第 2 周讲过，本周 Day 1 的模板同一套）。BFF 的接口名以你 Day 2–5 的实现为准，字段对不上就按自己的改，思路不变。

### 1. 信息架构：页面清单与导航树

动手前先把家底盘成一张表，每一行写清这个页面装什么、来自哪周、多久用一次、谁用：

| 页面 | 内容 | 来源 | 频率 | 谁用 |
| --- | --- | --- | --- | --- |
| 对话 | 流式对话 + 思考过程面板 | Day 5 | 日频 | 所有人 |
| 审批中心 | 待我审批的 interrupt 列表 | 第 13/18 周机制 | 日频 | approver/admin |
| 知识库 | 文档上传、切片查看 | 第 15 周 | 周频 | 所有人 |
| 工具管理 | MCP Server 状态 + 高危工具清单 | 此前各周 | 低频 | admin |
| 监控 | Grafana 外链 | 此前搭的监控系统 | 低频 | admin/approver |

这张表本身就是排序。表变成代码，就是一个带类型的导航配置数组：

```ts
// lib/nav.ts
export interface NavItem {
  label: string;
  href: string;
  roles: string[];    // 哪些角色可见
  external?: boolean; // 外链用 <a>，不用 <Link>
  exact?: boolean;    // 根路径必须精确匹配，原因见第 3 节
}

export const NAV_ITEMS: NavItem[] = [
  { label: "对话", href: "/", roles: ["admin", "approver", "member"], exact: true },
  { label: "审批中心", href: "/approvals", roles: ["admin", "approver"] },
  { label: "知识库", href: "/knowledge", roles: ["admin", "approver", "member"] },
  { label: "工具管理", href: "/tools", roles: ["admin"] },
  { label: "监控", href: "https://grafana.example.com/d/agent", roles: ["admin", "approver"], external: true },
];
```

关键在导航是一份配置数据而不是写死的 JSX：排序调整、角色收紧、加新页面，都只改这一个文件；侧边栏、面包屑、守卫共用同一份定义，一处改处处改。

### 2. 平台壳：App Router 的布局嵌套

第 2 周学 App Router 时讲过 layout 嵌套，今天是它的集大成。目标目录结构：

```text
app/
├─ login/page.tsx            # 登录页，平台壳之外
├─ (platform)/               # 路由组，不占用 URL
│  ├─ layout.tsx             # 平台壳：侧边导航 + 顶栏
│  ├─ page.tsx               # 对话（主入口 /）
│  ├─ knowledge/page.tsx     # 知识库
│  ├─ tools/page.tsx         # 工具管理
│  └─ approvals/
│     ├─ page.tsx            # 审批中心
│     └─ approval-list.tsx   # 批准/拒绝的交互
```

两个设计决定。`(platform)` 是路由组，括号这段不进 URL，好处在壳只包住该包的页面，login 就留在组外，天生不带侧边栏。壳本身是个 server component，可以直连 BFF 拉数据：

```tsx
// app/(platform)/layout.tsx
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  // 服务端组件直连 BFF；客户端组件走相对路径 /api（Day 2 的代理已配好）
  const me = await fetch(`${process.env.BFF_URL}/api/me`, { cache: "no-store" }).then(r => r.json());

  // 只有能审批的角色才去拉角标数据，member 请求了也是 403
  const pending = ["admin", "approver"].includes(me.role)
    ? await fetch(`${process.env.BFF_URL}/api/approvals?status=pending&assignee=me`, { cache: "no-store" })
        .then(r => r.json())
        .catch(() => ({ data: [] }))
    : { data: [] };

  return (
    <div className="platform">
      <Sidebar role={me.role} pendingCount={pending.data.length} />
      <div className="main">
        <Topbar user={me} />
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
```

关键在 layout 只渲染一次：子路由之间跳转时 layout 不重新渲染，这是 App Router 的默认行为。侧边栏的展开状态、顶栏的用户信息不会因为换页面而闪一下重新拉取。第 2 周埋的这颗种子，今天正好长成「壳」。

### 3. 导航激活态与面包屑

激活态是导航的地感，靠 `usePathname` 判断，但根路径有个经典陷阱：

```tsx
// components/sidebar.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, type NavItem } from "@/lib/nav";

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export function Sidebar({ role, pendingCount }: { role: string; pendingCount: number }) {
  const pathname = usePathname();

  return (
    <nav className="sidebar">
      {NAV_ITEMS.filter(item => item.roles.includes(role)).map(item => {
        const className = isActive(pathname, item) ? "nav-item active" : "nav-item";
        const badge = item.href === "/approvals" && pendingCount > 0
          ? <span className="badge">{pendingCount}</span>
          : null;

        return item.external ? (
          <a key={item.href} className={className} href={item.href} target="_blank" rel="noreferrer">
            {item.label} ↗{badge}
          </a>
        ) : (
          <Link key={item.href} className={className} href={item.href}>
            {item.label}{badge}
          </Link>
        );
      })}
    </nav>
  );
}
```

关键在 `exact`：对话的 href 是 `/`，如果用 `startsWith` 判断，任何路径都 `/` 开头，全站每个页面都在高亮「对话」。所以根路径必须精确匹配，其余路径用 `href + "/"` 前缀匹配，避免 `/tools` 误伤 `/tools-old` 这类邻居。审批中心旁边的角标是点睛之笔，pending 数量从壳传下来，有活儿待办一眼可见，这就是「从对话内审批升级为工作台」的第一步。

面包屑走同一份约定，把路径段映射回中文标签：

```tsx
// components/breadcrumb.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LABELS: Record<string, string> = {
  knowledge: "知识库",
  tools: "工具管理",
  approvals: "审批中心",
};

export function Breadcrumb() {
  const pathname = usePathname();
  if (pathname === "/") return null; // 主入口自己不需要面包屑
  const parts = pathname.split("/").filter(Boolean);

  return (
    <nav className="breadcrumb">
      <Link href="/">平台</Link>
      {parts.map(part => (
        <span key={part}> / {LABELS[part] ?? part}</span>
      ))}
    </nav>
  );
}
```

挂在内容区顶部即可。五页的平台面包屑只有一层，看着简单，但它给了外链和书签一个可回溯的锚点，页面多了以后价值翻倍。

### 4. 路由守卫：体验在前端，防线在后端

守卫分两道，对应两种「进不来」。

第一道，没登录。用 middleware 在请求进应用前检查 Day 4 下发的 session cookie：

```ts
// middleware.ts（项目根目录）
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/auth"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // cookie 名以你 Day 4 的实现为准
  const token = request.cookies.get("session_token")?.value;
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname); // 登录完送回原页面
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

第二道，角色不够。审批中心页面里直接检查，不够就渲染 403：

```tsx
// app/(platform)/approvals/page.tsx 开头加角色检查
const me = await fetch(`${process.env.BFF_URL}/api/me`, { cache: "no-store" }).then(r => r.json());

if (!["admin", "approver"].includes(me.role)) {
  return (
    <div className="forbidden">
      <h1>403</h1>
      <p>审批中心需要 approver 或 admin 角色。你的防线在 BFF，这里只是提前告诉你别白点。</p>
    </div>
  );
}
```

关键在第 5 周 RBAC 就立下的边界：前端守卫是体验优化，让没权限的人别点了半天表单才被拒绝。它不是安全机制，页面代码跑在用户浏览器里，cookie 可以伪造，角色可以改。真正的防线在 BFF 和 Agent 服务，每个接口都要重新验 token、验角色、验租户（Day 3 的活）。一句话记牢：前端挡君子，后端挡所有人。

## 动手任务：平台主链路 一步一步

手册任务：把对话、知识库、工具管理、监控整合到统一导航。拆成 5 步，全程约 60 分钟。

**第 1 步：列页面清单。** 照第 1 节那张表，把你手上真实存在的模块填进去，一行一页，标清来源和频率。频率拿不准就按「你自己上周各用了几次」估。表排好序，抄进 `lib/nav.ts`。这张表就是今天所有代码的图纸。

**第 2 步：搭平台壳。** 按第 2 节的目录树建 `(platform)` 路由组和 `layout.tsx`，把 Sidebar、Topbar、Breadcrumb 三个组件照抄进去。Topbar 放用户信息和租户切换器，切换接口调 Day 3 的多租户能力，调完记得 `router.refresh()`，原因见坑 3。此时壳里还没有页面，先随便放个占位 `page.tsx`，浏览器里确认：侧边栏五项、角色过滤生效、点监控新开 Grafana。

**第 3 步：把已有页面搬进来。** 对话页从 Day 5 的位置挪到 `(platform)/page.tsx`，知识库 UI 从第 15 周的工程挪到 `(platform)/knowledge/page.tsx`，挪的是文件位置，URL 由路由组决定，对话仍然是 `/`。工具管理新建一页，两份数据并排拉：

```tsx
// app/(platform)/tools/page.tsx
export default async function ToolsPage() {
  const [servers, riskyTools] = await Promise.all([
    fetch(`${process.env.BFF_URL}/api/mcp/servers`, { cache: "no-store" }).then(r => r.json()),
    fetch(`${process.env.BFF_URL}/api/tools?risk=high`, { cache: "no-store" }).then(r => r.json()),
  ]);

  return (
    <main>
      <h1>工具管理</h1>
      <section>
        <h2>MCP Server 状态</h2>
        <ul>{servers.data.map((s: { name: string; status: string }) => (
          <li key={s.name}>{s.name}：<strong>{s.status}</strong></li>
        ))}</ul>
      </section>
      <section>
        <h2>高危工具清单</h2>
        <ul>{riskyTools.data.map((t: { name: string; risk: string }) => (
          <li key={t.name}>{t.name}（{t.risk}，调用需审批）</li>
        ))}</ul>
      </section>
    </main>
  );
}
```

监控不建页面，导航里那条外链就是它的全部。搬完点一遍导航，每页都该带壳、激活态正确、面包屑对得上。

**第 4 步：写审批中心。** 页面拉「待我审批」列表，交互交给客户端组件：

```tsx
// app/(platform)/approvals/approval-list.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Interrupt {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export function ApprovalList({ items }: { items: Interrupt[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function decide(id: string, decision: "approve" | "reject") {
    setBusyId(id);
    await fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    setBusyId(null);
    router.refresh(); // 刷新列表和侧边栏角标，两处都是 server 拉的数据
  }

  if (items.length === 0) return <p>没有待审批的任务。</p>;

  return (
    <ul>
      {items.map(item => (
        <li key={item.id} className="approval-card">
          <div>
            <strong>{item.toolName}</strong>
            <pre>{JSON.stringify(item.args, null, 2)}</pre>
            <small>{item.reason} · {item.createdAt}</small>
          </div>
          <div>
            <button disabled={busyId === item.id} onClick={() => decide(item.id, "approve")}>批准</button>
            <button disabled={busyId === item.id} onClick={() => decide(item.id, "reject")}>拒绝</button>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

批准接口调的就是第 18 周 interrupt 流程里那个放行端点，只是入口从对话气泡换成了工作台列表。审批人从此不用蹲对话流，侧边栏角标会通知他来这一页。

**第 5 步：加路由守卫，走一遍主链路。** middleware 照第 4 节抄，审批中心页加角色检查。然后按清单自测：

::: tip 收工前自测清单
1. 退出登录，直敲 `/approvals`，应跳 `/login?from=/approvals`，登录后回到审批中心
2. 用 member 账号登录，侧边栏只有对话和知识库，直敲 `/approvals` 看到 403 页
3. 拿 member 的 token 直接 `curl` BFF 的审批接口，应被拒。被拒才说明防线真的在后端
4. 切换租户，页面和侧边栏角标跟着变
5. 从对话里触发一次高危工具调用，interrupt 出现在审批中心，批准后对话继续
全部通过，平台主链路就算跑通。
:::

## 常见踩坑

**坑 1：激活态全站高亮「对话」。** 侧边栏用 `pathname.startsWith(item.href)` 判断，对话的 href 是 `/`，任何路径都匹配。修法就是导航配置里的 `exact: true`，根路径走精确相等。同理，`/tools` 的前缀匹配要写成 `item.href + "/"`，不然未来 `/tools-old` 也会点亮 `/tools`。

**坑 2：整个 layout 标了 "use client"。** 图省事把壳整个做成客户端组件，fetch BFF、读环境变量的服务端能力全没了，数据只能一层层 props 往下钻，构建还给黄色警告。原则：壳保持 server component，交互下沉成叶子级 client 组件。Sidebar、Topbar、Breadcrumb 是客户端的，layout 本身不是。

**坑 3：租户切换成功，页面没反应。** Topbar 里 POST 切换接口返回 200，当前租户确实变了，但 server component 的渲染结果不会自己更新，看到的还是旧租户的数据。修法是切换完成后调 `router.refresh()`，让整棵树重新拉取。忘了这一行，用户会以为切换功能是坏的。

**坑 4：把前端守卫当安全机制。** middleware 和 403 页只负责体验。攻击者不需要浏览器，拿一个 member 的 token 直接 curl BFF 的审批接口，前端代码一行都拦不住。每个 BFF 接口都要独立验角色和租户，这活 Day 3 干过，今天只是再确认一遍：前端挡君子，后端挡所有人。

**坑 5：外链用了 `<Link>`。** `next/link` 是给应用内路由的，用在 Grafana 外链上不会新开窗口，预取也会浪费，控制台还会警告。外链一律原生 `<a>` 加 `target="_blank" rel="noreferrer"`，导航配置里的 `external` 字段就是干这个的。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 五页导航的排序依据是什么？为什么监控是外链而不是内页？

::: details 参考答案
依据是使用频率加角色可见性：日频的对话和审批中心在前，周频的知识库居中，低频的工具管理靠后，低频且已有完整界面的监控直接外链。Grafana 本身就是成熟界面，套壳反而损失功能，外链新窗口是最诚实的整合。
:::

2. 子路由之间跳转时，平台壳的 layout 会重新渲染吗？这对导航设计意味着什么？

::: details 参考答案
不会。App Router 里匹配过的 layout 在子路由导航时保持挂载，只有 children 变。意味着侧边栏状态、顶栏用户信息在换页面时不会闪烁也不会重复请求，壳里的数据一次拉取全站复用；也意味着壳里的数据想刷新得靠 `router.refresh()` 主动触发。
:::

3. 根路径 `/` 的激活态判断为什么必须特殊处理？

::: details 参考答案
因为几乎所有路径都以 `/` 开头，用前缀匹配会让「对话」在全站每个页面都高亮。根路径必须精确相等，其他路径用 `href + "/"` 前缀匹配防止误伤兄弟路径。导航配置里的 `exact` 字段就是给根路径准备的。
:::

4. 前端路由守卫和后端权限校验各负责什么？为什么前端只做体验？

::: details 参考答案
前端守卫负责体验：没登录尽早跳登录页，角色不够尽早给 403，别让用户填完表单才被拒绝。后端校验负责安全：每个接口独立验 token、角色、租户。前端只做体验是因为页面代码跑在用户浏览器里，cookie 可伪造、代码可篡改，任何人可以绕过前端直打接口，防线只能在服务端。
:::

5. 审批中心相比对话内审批，升级点在哪里？它复用了第 13/18 周的什么？

::: details 参考答案
复用了整套 interrupt 机制：Agent 暂停、等待外部决策、按 decision 放行的流程一个字没改。升级的只是入口：审批动作从对话气泡里的按钮，变成工作台里一个可筛选、可批量查看的待办列表，审批人不必守着对话流，侧边栏角标会把待办推到他眼前。
:::

## 延伸阅读

- [Next.js：Layouts and Pages](https://nextjs.org/docs/app/getting-started/layouts-and-pages)，布局嵌套与路由组的官方说明，第 2 周学的基础今天全用上了
- [Next.js：usePathname](https://nextjs.org/docs/app/api-reference/functions/use-pathname)，激活态判断的依据，注意它只能在客户端组件里用
- [Next.js：Middleware](https://nextjs.org/docs/app/api-reference/functions/middleware)，登录重定向的标准位置，matcher 的写法值得细读
- 本周前五天的产出（BFF、多租户、认证、流式对话 UI）都在[第 20 周目录](/week20/)里，今天的平台壳每一步都踩在它们上面

今天的产出「平台主链路」留好。明天 Day 7 复盘要走的「登录 → 对话 → RAG → 工具审批」完整流程，跑的就是今天这条链，收工前把自测清单五项全点一遍，明天省一半的事。
