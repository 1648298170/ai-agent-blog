# 第 1 周 · Day 4：Monorepo 与 pnpm workspace——一个仓库管住所有包

> 对应手册任务：学习「Monorepo 概念 + pnpm workspace」；动手任务「初始化 apps/web + packages/shared 的 monorepo 结构」；当日产出「可运行的 monorepo 骨架」。
>
> 一句话：前三天打磨的是 TypeScript 的类型系统，从今天起转向工程化。这篇回答一个问题——未来 23 周不断膨胀的代码，该装进什么样的仓库结构里。

## 今日目标

1. 讲得清 monorepo 和多个独立仓库各自的优劣，知道为什么这套课程非 monorepo 不可
2. 掌握 pnpm workspace 的三块积木：`pnpm-workspace.yaml`、`apps` 与 `packages` 的目录分工、`workspace:` 协议
3. 搭出 apps/web + packages/shared 的最小骨架，并用 node 跑通验证

## 概念讲解：为什么第 4 天就要上 monorepo

先往后翻翻手册。23 周结束时，你的项目大致会长成这样：

- `apps/web`：前端界面，第 2 周进场
- `apps/api`：NestJS 后端，第 3 周进场
- Python Agent 服务：更后面的主角
- `packages/shared`：上面几方共用的类型与工具函数

麻烦出在「共用」上。假设 `AgentMessage` 是前后端都要用的消息结构，现在要给它加一个 `timestamp` 字段。如果每个模块各占一个仓库（multirepo），流程是这样：进 shared 仓库改接口、提交、发新版本；切到 web 仓库，升级 shared 依赖、改调用处、提交；再切到 api 仓库，把同样的动作重复一遍。三个仓库、两轮依赖升级、至少三次提交，全靠手动同步，漏一步就是一轮排查。

换成 monorepo，shared、web、api 同住一个仓库：一个 commit 同时改掉三个包，谁漏改了字段，同一轮类型检查里当场报错。一个人维护全栈项目，这笔账不难算。

monorepo 当然不是免费午餐，把两边的代价摆在一起看：

| 维度 | multirepo（多仓库） | monorepo（单仓库） |
| --- | --- | --- |
| 跨包改动 | 改接口要发 N 个包、升 N 次依赖 | 一个 commit 全部改完 |
| 版本一致性 | 各仓库各自升级，版本容易漂移 | 整个仓库共用一把锁文件 |
| 权限隔离 | 天然隔离，适合互不信任的大团队 | 需要额外约定和工具划分边界 |
| CI 与构建 | 每个仓库只构建自己，天然增量 | 不加工具会全量构建，越堆越慢 |
| 上手门槛 | 开箱即用 | 得先理解目录约定和包管理器 |

你的处境是：一个人、一台机器、模块间改动频繁、清一色 TypeScript。这恰好是 monorepo 收益最大的场景。至于「越跑越慢」那一栏，Day 5 用 Turborepo 收拾。

## 核心知识

### 1. Monorepo 是什么

一句话定义：monorepo 把多个工程放进同一个 Git 仓库，用一套工具统一管理它们的依赖关系。

社区有个通行的目录分工：

- `apps/`：放「能独立启动的应用」，判断标准是它自己就是一个进程。web、api、agent 都住这里
- `packages/`：放「被别人 import 的库」，自己不运行。shared 类型包、UI 组件库、各种 lint 配置都在这

为什么类型定义值得单独建一个 shared 包？第 2 周你会做前后端联调：前端发出去的请求体和后端收到的请求体必须是同一个形状，差一个字段就是一次 bug。把 `AgentMessage` 这类接口放进 `@my/shared`，两端 import 同一份定义，它就成了契约。改一处，另一边编译立刻报红。契约写一份，比口头同步可靠得多。

### 2. 为什么选 pnpm

同样管包，pnpm 对 monorepo 用户有三样实惠。

第一，磁盘省。所有包集中存进一个全局 store，项目要用的包从 store 硬链接过来，同一个包装十个项目只占一份空间。

第二，node_modules 严格。这干掉了 npm/yarn 时代的一个经典隐患：幽灵依赖，下面单独说。

第三，workspace 协议是一等公民。包之间互相引用、内部包不发版直接用，原生支持。

**幽灵依赖是什么**

npm 和 yarn 安装依赖时会做「扁平化」：你依赖 A，A 又依赖 B，它们都会被提升到 node_modules 顶层，因为 Node 找模块是逐层向上搜的。副作用是：B 从没写进你的 package.json，你却可以直接 `import "B"`，而且能跑。这个 B 就是幽灵依赖。它随时可能消失：A 某天升级后不再依赖 B，你一行代码没动，项目突然起不来了。自己依赖了什么自己说不清，命运攥在别人的 package.json 手里。

pnpm 的结构不同：顶层 node_modules 只放你声明过的包，间接依赖全部收进 `.pnpm` 目录，包与包之间用符号链接串好。import 一个没声明的包，解析当场失败。问题在写代码的第十分钟暴露，而不是三个月后跟着上游升级一起爆雷。「没声明就不可用」和 TypeScript 的显式类型，是同一个哲学。

### 3. pnpm workspace 语法

pnpm 靠根目录一个 yaml 文件识别 monorepo。创建 `pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`packages` 字段列出所有子包的位置，值是 glob 通配符：`apps/*` 匹配 apps 目录下一层的所有子目录，`apps/web`、`apps/api` 都算数，更深的 `apps/web/src` 不算。要匹配任意层级写 `**`。

语法就这么多。注意一点：npm 的 monorepo 靠 package.json 里的 `workspaces` 字段，pnpm 不用，它只认这个 yaml 文件。

### 4. workspace 协议

子包之间引用依赖时，版本号这样写：

```json
{
  "dependencies": {
    "@my/shared": "workspace:*"
  }
}
```

`workspace:*` 告诉 pnpm：这个依赖别去 npm registry 找，就在本仓库的 workspace 里解析。具体动作是把 packages/shared 以符号链接放进 apps/web 的 node_modules，直指源码目录。所以你在 shared 里改一行代码，web 立刻生效。没有发版，没有 link 命令，没有要清的缓存。

冒号后的 `*`、`^`、`~` 是版本匹配规则：`*` 匹配 workspace 里该包的任意版本，`^` 和 `~` 要求它满足对应的 semver 范围。将来这套内部包真要发布，pnpm 在发布时会自动把 `workspace:*` 替换成当时的真实版本号。日常写 `*` 最省心，自家兄弟之间，不必谈 semver。

## 动手任务：初始化 monorepo 骨架

目标：一个叫 ai-agent-platform 的仓库，apps/web 引用 packages/shared 并跑出输出。以下命令在 PowerShell 和 bash 里写法一致，照抄即可。

### 第 1 步：创建仓库与目录

到你放练习项目的位置执行：

```bash
mkdir ai-agent-platform
cd ai-agent-platform
mkdir apps packages
mkdir apps/web/src packages/shared/src
```

跑完这四条，骨架的空目录就位。

### 第 2 步：根 package.json

用编辑器在仓库根目录新建 `package.json`：

```json
{
  "name": "ai-agent-platform",
  "version": "0.0.1",
  "private": true,
  "description": "23 周 AI Agent 全栈工程学习仓库"
}
```

两个字段值得多说两句。`workspaces` 不用写：那是 npm 的玩法，pnpm 只认下一步的 `pnpm-workspace.yaml`。`private: true` 必须写：根目录这个 package.json 只是管理壳，不是可发布的包，加上这行，`npm publish` 和 `pnpm publish` 都会直接拒绝执行，等于把「手滑发版」这条路堵死。

### 第 3 步：pnpm-workspace.yaml

根目录新建 `pnpm-workspace.yaml`：

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

保存这个文件的瞬间，ai-agent-platform 在 pnpm 眼里就是一个 monorepo 了。

### 第 4 步：packages/shared，契约包

两个文件。先是 `package.json`：

```json
{
  "name": "@my/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

`@my` 是自定义 scope，表明「自家内部包」。`main` 直接指向 `src/index.ts` 是最省事的跑法：不编译，让运行环境直接消费 TS 源码，第 7 步见分晓；`types` 同样指过去，编辑器的类型提示开箱即用。规范做法（tsc 编译出 dist、用 `exports` 声明入口）Day 6 再补，眼下先求链路跑通。

然后是 `src/index.ts`，导出一个类型和一个函数，正好对应「契约 + 工具」两种角色：

```ts
export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function hello(name: string): string {
  return `hello, ${name}!`;
}
```

### 第 5 步：apps/web，最小占位包

先把预期钉死：今天的 web 不装任何框架，它只是占位，唯一职责是验证 workspace 的引用链路。真正的 Next.js 第 2 周才进场。

`apps/web/package.json`：

```json
{
  "name": "@my/web",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@my/shared": "workspace:*"
  }
}
```

`apps/web/src/index.ts`：

```ts
import { hello, type AgentMessage } from "@my/shared";

const msg: AgentMessage = {
  role: "user",
  content: "monorepo 骨架已就绪",
};

console.log(hello("monorepo"));
console.log(msg);
```

### 第 6 步：安装依赖

回仓库根目录：

```bash
pnpm install
```

预期输出大致如此（耗时和路径形式因版本而异）：

```text
Done in 420ms

apps/web:dependencies:
+ @my/shared 0.0.1 <- packages/shared
```

盯住最后一行的 `<-`：`@my/shared` 链接自本地 packages/shared，不是从 registry 下载的。这一行就是 workspace 生效的铁证。

不想手改 package.json 的话，命令也行：`pnpm --filter @my/web add @my/shared`，pnpm 会自动写入 `workspace:` 协议依赖。

### 第 7 步：运行验证

```bash
cd apps/web
node --experimental-strip-types src/index.ts
```

预期输出：

```text
hello, monorepo!
{ role: 'user', content: 'monorepo 骨架已就绪' }
```

`--experimental-strip-types` 是 Node 22 自带的类型擦除能力：直接运行 .ts 文件，不需要先编译。（Node 23.6 起默认开启，写了也不冲突；第一次运行可能打印一条 ExperimentalWarning，正常现象。）

验证完 `cd` 回根目录。从今天起立个规矩：所有 pnpm 命令都在根目录执行。

### 第 8 步：检视最终结构

略去 node_modules 和 pnpm-lock.yaml 这类生成物，仓库应该长这样：

```text
ai-agent-platform/
├─ apps/
│  └─ web/
│     ├─ package.json
│     └─ src/
│        └─ index.ts
├─ packages/
│  └─ shared/
│     ├─ package.json
│     └─ src/
│        └─ index.ts
├─ package.json
└─ pnpm-workspace.yaml
```

::: tip
补一个 `.gitignore`，把 `node_modules/` 排除；`pnpm-lock.yaml` 则一定要提交，它是整个 workspace 的依赖快照。
:::

骨架完成。第 2 周 apps/web 会被替换成真正的 Next.js 工程，但仓库结构和今天建立的引用关系原样保留。

## 常见踩坑

### 坑 1：根 package.json 忘了 private: true

从 npm 迁过来的人容易犯两种错：照惯例写 `workspaces` 字段，pnpm 用不上，真正生效的是 `pnpm-workspace.yaml`，这个无害；漏掉 `private: true`，这个危险。没有这行，根目录就是一个「可发布」的包，哪天在根目录手滑 publish，整个学习仓库就上公网了。

### 坑 2：包名带 @my，要去 npm 注册这个 scope 吗

不用。`@scope` 的归属校验只发生在「发布到公网 registry」时，`workspace:` 协议的包根本不出本地。`@my/shared` 也标了 `private: true`，永远不会被发布，这个 scope 就是纯粹的命名空间，标明「项目内部包」。

### 坑 3：import @my/shared 报「找不到模块」或「找不到类型声明」

按顺序查三件事：

1. apps/web/package.json 写了 `"@my/shared": "workspace:*"` 没有？写了之后在根目录跑 `pnpm install` 没有？
2. shared 的 package.json 配了 `main` 和 `types` 没有？Node 和编辑器都靠这两个字段找入口
3. 运行时带了 `--experimental-strip-types` 没有？入口指向 .ts 时它是前提

本篇的最简方案是三件套：`type: module`、`main` 指向 src、strip-types 直接跑。网上更复杂的配置（tsc 编译、`exports` 字段、独立 d.ts）是 Day 6 的规范版，别急着抄。

### 坑 4：在子包目录里跑 pnpm install

不报错，但只装当前子包的依赖。今天两个包无所谓，等包多了，你在 apps/web 里 install，别处新增的依赖就不会被装上，症状是「明明写了却找不到」。统一习惯：install、add 都回根目录；要精确操作某个包，用 `--filter`，比如 `pnpm --filter @my/web add xxx`。

另外全程只用 pnpm。混着跑 `npm install` 会多出一套 package-lock.json 和一份结构冲突的 node_modules，只能删掉重装。

### 坑 5：shared 里写了 enum，node 跑不动

类型擦除只认「可擦除」语法：`interface`、`type`、类型注解、`as const`，擦掉后就是合法 JS。`enum` 和 `namespace` 不在此列，它们要生成真实的运行时代码，擦不掉，`--experimental-strip-types` 会直接报错。在 shared 里，用字面量联合类型代替 enum（`AgentMessage` 的 `role` 字段就是示范）。Day 6 换成 tsc 编译后，这个限制自然解除。

## 自测问题

**问题 1：给 AgentMessage 加一个 timestamp 字段，multirepo 和 monorepo 各自的操作路径是什么？**

::: details 参考答案
multirepo：进 shared 仓库改接口并发版；切到 web 仓库升级 shared 版本、适配新字段、提交；再切到 api 仓库重复一遍。至少三个仓库、两轮依赖升级、多次提交。monorepo：三个包的改动放进同一个 commit，一次提交全部完成；谁漏改，同一轮类型检查当场报错。
:::

**问题 2：什么是幽灵依赖？它最阴险的地方在哪？**

::: details 参考答案
npm/yarn 扁平化 node_modules 后，没写进 package.json 的包也能 import，比如依赖 A 的间接依赖 B。阴险之处在于它一直能跑，直到 A 升级后不再依赖 B，你的项目在「什么都没改」的某天突然崩掉，根源藏在别人的 package.json 里，很难第一时间想到。
:::

**问题 3：workspace:*、workspace:^、workspace:~ 有什么区别？内部包推荐用哪个？**

::: details 参考答案
冒号后是版本匹配规则：`*` 匹配任意版本，`^` 和 `~` 要求 workspace 内该包的版本满足对应 semver 范围。推荐 `*`：内部包同源同步，版本约束没有意义；真正发布时 pnpm 会把 `workspace:*` 替换成真实版本号。
:::

**问题 4：pnpm 靠什么结构杜绝幽灵依赖？**

::: details 参考答案
顶层 node_modules 只放 package.json 声明过的包，间接依赖全部收进 `.pnpm` 目录，彼此用符号链接串联。import 未声明的包会解析失败，问题当场暴露，而不是拖到上游升级时爆雷。
:::

**问题 5：根 package.json 去掉 private: true 会有什么后果？**

::: details 参考答案
根目录变成一个可发布的包。在根目录执行 `npm publish` 或 `pnpm publish`，会把整个 monorepo 当成一个包发上 registry。加上 `private: true`，两条发布命令都会被直接拒绝。
:::

## 延伸阅读

- [pnpm workspace 官方文档](https://pnpm.io/workspaces)：workspace 协议、`--filter` 过滤命令的权威说明
- [Turborepo：monorepo 概念指南](https://turbo.build/repo/docs)：Google、Meta 维护大型 monorepo 的思路，概念部分值得通读

第二个链接扫一遍概念就够了。Turborepo 本身忍住别装：它是明天 Day 5 的主角，专门解决 monorepo 变大后构建越来越慢的问题。
