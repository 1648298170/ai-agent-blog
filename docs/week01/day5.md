# 第 1 周 · Day 5：Turborepo——任务管道与缓存

> 对应手册任务：学习「Turborepo 配置：turbo.json、任务管道」；动手任务「配置 `build`、`lint`、`test` 三个 pipeline，跑通缓存」；当日产出 `turbo.json` + 缓存验证。
>
> 一句话：Day 4 的 pnpm workspace 解决了「包放哪、怎么互链」，今天解决「命令怎么跑、能不能不重复跑」——Turborepo 给 monorepo 装上任务管道和缓存，让「什么都没改还全量构建」成为历史。

## 今日目标

1. 说清楚 Turborepo 在 monorepo 里管什么、不管什么：只负责任务编排与缓存，依赖安装仍然是 pnpm 的地盘
2. 写出 Turborepo 2.x 语法的 turbo.json：`tasks` 定义 build/lint/test，`dependsOn` 声明依赖关系，`outputs` 声明缓存产物
3. 亲眼验证缓存：首跑看拓扑顺序，二跑看 FULL TURBO，改一处源码看只有该重建的包重建

## 概念讲解：为什么 pnpm -r 不够用

Day 4 收工时，根 package.json 里多半有这一行：

```json
{
  "scripts": {
    "build": "pnpm -r run build"
  }
}
```

`pnpm -r` 会递归进每个子包执行同名脚本，而且它确实懂依赖顺序（默认按拓扑排序，被依赖的包先跑），这点要给它记功。两个包的时候岁月静好，包一多，两个问题就藏不住了。

第一，没有缓存。`pnpm -r build` 每次都是全量重跑：你只改了 apps/web 里的一行文案，shared 和其余几个包照样从头编译一遍。本地还能忍，CI 上没法忍——每次 push、每个 PR，所有包全部重编重测。假设全量要 4 分钟，一天几十次 CI，时间全喂给了重复劳动。

第二，没有任务管道。build 完了才能 test，test 前要不要 lint，任务之间的关系只能靠你在脚本里手写 `pnpm -r build && pnpm -r test` 串起来——串错顺序没人提醒，包与包之间的并行粒度也控制不了。

Turborepo 补的正是这两块，对应它的两大价值：

- **拓扑顺序 + 并行执行**：turbo 读取 workspace 依赖图，`shared#build` 先跑，跑完立刻调度依赖它的 `web#build`；互不依赖的包同时开跑，把多核吃满。
- **输入哈希缓存**：每个任务执行前，turbo 先对「输入」算一个哈希（源文件内容、依赖包文件、lockfile、环境变量……）。哈希没变就意味着结果必然相同，直接把上次的结果原样取回——命令不执行，连终端输出都原样回放。5 个包的项目 CI 从 4 分钟变 40 秒，秘密不是编译变快了，而是大部分任务根本没跑，缓存命中直接回放。

## 核心知识

### 1. Turborepo 在 monorepo 里的角色：只编排，不安装

先划清边界，Turborepo 不是包管理器：

- 依赖安装、workspace 链接、lockfile，全是 pnpm 的地盘，turbo 一概不管；
- turbo 不理解你的代码。它不解析 TypeScript，不知道你 import 了谁。它眼里的世界只有两样东西：各包 package.json 里声明的**脚本**（命令），以及依赖图上这些命令的**输出**。

这个「无知」恰恰是设计精髓：正因为不理解代码，turbo 才能对任何语言、任何构建工具一视同仁，也才能把「要不要重跑」简化成一个可计算的问题——输入变没变。它的情报来源只有 package.json 的依赖声明（`workspace:*` 协议）、lockfile 和 turbo.json 的任务配置。所以记住一条：**代码里 import 了不算数，package.json 里 dependencies 声明了才算数**——turbo 的拓扑图看的是后者。

### 2. turbo.json 与 tasks 字段（2.x 语法）

turbo.json 放在仓库根目录，是 turbo 的总配置。Turborepo 2.x 用顶层 `tasks` 字段定义任务（1.x 时代这个字段叫 `pipeline`，已废弃，新版直接报错，踩坑一节细说）。本篇要用的完整配置长这样：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "lint": {},
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    }
  }
}
```

逐个字段拆开看：

- `$schema`：让编辑器获得智能提示和校验，建议永远带上；
- `tasks` 的键（build/lint/test）是任务名。执行 `turbo build` 时，turbo 会扫描所有子包的 package.json，找到同名 script 的包各跑一次——所以**任务名必须和子包脚本名一致**；
- `dependsOn`：本任务开跑前要等谁，下一小节展开；
- `outputs`：声明哪些产物要进缓存，glob 相对各自包目录。`["dist/**"]` 表示缓存整个 dist；省略不写或写空数组，等于不缓存任何文件（但日志永远会被缓存）。

lint 任务写了个空对象 `{}`，这是合法写法，意思是「这个任务存在，用默认配置」。三个任务三种形状：build 有上游依赖有产物，test 依赖同包的 build，lint 无依无靠——正好覆盖 dependsOn 的全部用法。

### 3. 任务依赖图：dependsOn 的三种写法

dependsOn 数组里能放三种字符串，含义完全不同：

**`"^build"`——依赖上游包的同名任务。** `^` 的意思是「先把我依赖的包的 build 全部跑完」。web 依赖 shared，那么 `web#build` 的 `^build` 就等于宣布：`shared#build` 成功之后我才开跑。turbo 从依赖图最底层（不被任何内部包依赖的包）开始逆流而上，多级依赖（a→b→c）时逐级递归成立。

**`"build"`（不带 ^）——依赖本包内的其他任务。** test 的 `dependsOn: ["build"]` 意思是：每个包先跑完自己的 build，再跑自己的 test。注意它不等别的包的 build，只管同包内两个任务的先后。

**`"web#lint"`——点名某个包的某个任务。** 语法是 `包名#任务名`，适合表达跨包跨任务的精确关系，比如 docs 的 build 必须等 web 的类型检查完成。

区别记法：带 `^` 看的是**依赖关系**（上游），不带看的是**同包顺序**，`#` 是**点名指定**。新手最常见的错误是把 `dependsOn: ["build"]` 当 `["^build"]` 用——少个帽子，构建顺序立刻乱套。

### 4. 缓存机制：输入哈希与输出回放

缓存的核心问题是：怎么判定「这次运行」和「上次运行」输入一样？turbo 的答案是哈希。

每个任务执行前，turbo 计算两把哈希。全局哈希：影响所有任务的因素，包括根 package.json 与 lockfile 的变化（依赖一变，全体任务 miss）、`globalDependencies` 声明的文件、`globalEnv` 声明的变量。任务哈希：只影响自己，包括任务定义、本包源文件内容、**依赖包的文件内容**、本包的 package.json 与相关 lockfile 部分、`env` 声明的环境变量。任一把变了，这个任务就 cache miss，老实重跑并把新结果写进缓存；都没变，cache hit。

命中的时候 turbo 做两件事，一样不含糊：

1. **回放日志**：上次运行的 stdout/stderr 原样重演到终端——你会看到编译输出一字不差地「打印」出来，但 tsc 进程压根没启动。这就是「连 stdout 都缓存」；
2. **恢复产物**：把 outputs 声明的文件（比如 dist/）从缓存目录拷回原位。没声明 outputs 的任务只回放日志、不还文件——这是 outputs 漏配会出诡异 bug 的根源。

缓存放哪？仓库根的 `.turbo/` 目录（本地缓存在 `.turbo/cache`），所以它必须进 .gitignore。两个常用开关：任务里写 `"cache": false` 永不缓存（dev 这种长驻任务必须关）；命令行加 `--force` 无视缓存强制重跑（怀疑缓存有诈时用）。另外 `inputs` 可以反向缩小哈希范围——比如 test 任务只关心 src 和测试文件，README 改一改不该让它失效——在默认行为基础上微调时用 `$TURBO_DEFAULT$` 起头。

::: tip
改根 package.json 的依赖或 lockfile，会让**所有**任务缓存失效，这是全局哈希在起作用。想让根目录的 tsconfig.base.json 之类共享配置也触发全局失效，把它加进 `globalDependencies`。
:::

## 动手任务：配置 build/lint/test 管道

在 Day 4 的骨架上开工：根 package.json + pnpm-workspace.yaml + packages/shared + apps/web。下文包名以 `@ai-agent/shared`、`@ai-agent/web` 为例，和你 Day 4 取的不一样就自行替换。

**第 1 步：安装 turbo 到 workspace 根**

```powershell
pnpm add -D -w turbo
```

`-w` 表示装进根 package.json 而不是某个子包——turbo 是全局编排工具，天然属于根。装完执行 `pnpm exec turbo --version` 能打印版本号，就算成功。

::: tip
如果 turbo 提示根 package.json 缺 `packageManager` 字段，按提示补一行，比如 `"packageManager": "pnpm@11.0.0"`（版本号以 `pnpm --version` 的输出为准）。
:::

**第 2 步：给两个子包补上三个同名脚本**

turbo 的任务名对应子包脚本名，先把脚本备齐。packages/shared/package.json：

```json
{
  "name": "@ai-agent/shared",
  "scripts": {
    "build": "tsc",
    "lint": "echo lint placeholder - eslint lands in week 2",
    "test": "node --test"
  }
}
```

apps/web/package.json 照抄一份（name 换成 `@ai-agent/web`）。三点说明：

- build 用你 Day 4 配好的 tsc 命令（有的骨架写 `tsc -p tsconfig.json`，效果一样），今天的主角不是它；
- lint 是占位脚本，echo 一句话就够。今天验证的是「管道通不通」，不是「检查严不严」，第 2 周 ESLint 上岗；
- test 用 Node 22 内置的 test runner：`node --test` 会自动扫描包内 `*.test.*` 模式的文件。

`node --test` 找不到测试文件会直接报错，所以给两个包各建一个 `smoke.test.mjs`（放包根目录）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 占位冒烟测试：只验证 test 管道本身，第 2 周换 vitest
test('smoke: pipeline works', () => {
  assert.equal(1 + 1, 2)
})
```

::: warning
占位脚本里的 echo 文案刻意用英文：npm/pnpm 的脚本在 Windows 上由 cmd 执行，脚本里写中文 echo 十有八九输出乱码。中文留给源码注释，别进 scripts。
:::

**第 3 步：确认 web 声明了对 shared 的依赖**

turbo 的拓扑图来自 package.json 的依赖声明。Day 4 如果已经让 web 依赖 shared（`"@ai-agent/shared": "workspace:*"`），跳过这步；还没有就补一条：

```powershell
pnpm --filter @ai-agent/web add "@ai-agent/shared@workspace:*"
```

::: warning
没有这条依赖边，shared 和 web 在 turbo 眼里就是两座孤岛：`^build` 的顺序编排无从谈起，第 7 步的缓存实验也做不出预期效果。
:::

**第 4 步：写 turbo.json**

仓库根目录新建 turbo.json，内容就是核心知识里那份配置：

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "lint": {},
    "test": {
      "dependsOn": ["build"],
      "outputs": []
    }
  }
}
```

顺手在根 package.json 的 scripts 里加个快捷方式，以后少敲几个字：

```json
{
  "scripts": {
    "build": "turbo build",
    "lint": "turbo lint",
    "test": "turbo test"
  }
}
```

**第 5 步：首跑，观察拓扑顺序**

```powershell
pnpm turbo build
```

输出大致长这样（哈希值和耗时每次不同，下同）：

```
• Packages in scope: @ai-agent/shared, @ai-agent/web
• Running build in 2 packages
• Remote caching disabled
@ai-agent/shared:build: cache miss, executing 3f2a1b4c
@ai-agent/shared:build: > build
@ai-agent/shared:build: > tsc
@ai-agent/web:build: cache miss, executing 9d8e7f6a
@ai-agent/web:build: > build
@ai-agent/web:build: > tsc

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
  Time:    2.8s
```

看三个地方：`shared:build` 排在 `web:build` 前面，`^build` 在起作用；两个任务都是 `cache miss, executing`，首次运行没有缓存可命中；末尾统计 `0 cached, 2 total`。那行 Remote caching disabled 表示当前只用本地缓存，团队共享缓存是以后的事。跑完看一眼两个包的 dist 目录，产物已经在了。

**第 6 步：再跑一次，看 FULL TURBO**

什么都不改，原样再执行一遍 `pnpm turbo build`：

```
@ai-agent/shared:build: cache hit, replaying output 3f2a1b4c
@ai-agent/shared:build: > build
@ai-agent/shared:build: > tsc
@ai-agent/web:build: cache hit, replaying output 9d8e7f6a

 Tasks:    2 successful, 2 total
Cached:    2 cached, 2 total
  Time:    0.2s >>> FULL TURBO
```

`cache hit, replaying output`——终端上的「编译输出」是缓存回放的，tsc 进程根本没启动，所以总耗时从 2.8 秒掉到零点几秒。行尾那句 **FULL TURBO** 是 turbo 的招牌彩蛋：本次运行的所有任务全部命中缓存，一个没漏。这就是「4 分钟变 40 秒」的机制在两个包上的样子。

**第 7 步：改 shared 源码，验证精准失效**

往 packages/shared/src/index.ts 里随便改点什么（加一行注释即可），再跑 `pnpm turbo build`：

```
@ai-agent/shared:build: cache miss, executing 7c1d2e3f
@ai-agent/shared:build: > tsc
@ai-agent/web:build: cache miss, executing 4a5b6c7d
@ai-agent/web:build: > tsc

 Tasks:    2 successful, 2 total
Cached:    0 cached, 2 total
```

分析这份结果。`shared:build` miss 好理解：自己的源文件变了，哈希跟着变。`web:build` 为什么也 miss？因为任务哈希里包含**依赖包的文件内容**——shared 的源码参与了 web 的哈希计算。这不是 bug，是正确性要求：web 的编译产物依赖 shared 的类型和实现，上游变了下游必须重编。用错误的缓存换来的快，是埋雷的快。

再做个反向实验：还原 shared 的改动，去改 apps/web/src 下的任意文件，再跑 build。这次 `shared:build` 命中缓存（它和它的依赖什么都没变），只有 `web:build` 重建。两个实验连起来看：**改谁，谁及其下游重建；与它无关的包全部回放**。项目越大，这条规则的收益越夸张——CI 提速的原理就在这。

**第 8 步：跑通 lint 和 test，收尾 .gitignore**

```powershell
pnpm turbo lint test
```

lint 首次真实执行（echo 一行，随即入缓存）；test 因为 `dependsOn: ["build"]` 会先确认 build（已缓存，直接回放），再在每个包里跑 `node --test`，两个 smoke 测试通过。原样再跑一遍这条命令，六个任务全部命中，FULL TURBO 再现。

最后把 turbo 的工作目录从 git 里排除，根 .gitignore 加一行：

```
.turbo/
```

（Day 4 如果还没建 .gitignore，顺手把 `node_modules/` 和 `dist/` 一起补上。）

当日产出自查：根目录有 turbo.json；`pnpm turbo build` 连跑两次，第二次出现 FULL TURBO；改 shared 源码后能解释谁重建、为什么。三项齐了，收工。

## 常见踩坑

**坑 1：turbo.json 写成 1.x 的 pipeline 字段。** Turborepo 2.x 只认 `tasks`，旧字段 `pipeline` 在新版直接报配置错误（提示已移除）。从老教程、老仓库抄配置时，先看顶层字段名。编辑器里 `$schema` 标红报错，通常也是配置结构对不上 schema 的信号。

**坑 2：子包没有同名 script。** turbo.json 里定义了 `build`，某个子包 package.json 没有 build 脚本——这个包会被静默跳过（设计如此：任务配置全局生效，没脚本的包不参与）。但如果**所有**包都没有同名脚本，turbo 会提示没有可执行的任务。排查口诀：任务名 = 子包脚本名，一个字母都不能差。

**坑 3：outputs 不配，产物不缓存。** 症状很诡异：明明 cache hit，dist 里却没有最新产物，甚至目录是空的。原因是 outputs 省略时 turbo 只缓存日志不缓存文件——日志回放给你看，文件不还给你。规则：**产生文件的任务必须声明 outputs**；只看终端输出的任务（比如 lint）才配省略。

**坑 4：turbo run 和 pnpm turbo 的等价关系。** `turbo build`、`turbo run build`、`pnpm turbo build`、`pnpm exec turbo build` 四种写法指向同一件事（run 是默认子命令；pnpm 只是替你在 node_modules/.bin 里找 turbo 这个可执行文件）。另外，turbo 必须装在 workspace 根（`pnpm add -D -w turbo`），装到某个子包里，根目录连命令都调不到。

**坑 5：缓存命中了，CI 却出错或没变快：环境变量没进哈希。** 构建脚本读了环境变量（比如把 API 地址打进产物），turbo.json 却没用 `env` 声明它——本地和 CI 的变量值不同、哈希却相同，CI 直接回放了本地缓存，产物里是错的值。反过来，把每次部署都变的值（时间戳之类）声明进 env，会导致永远 miss。原则：**影响产物的变量用 env / globalEnv 锁进哈希，不影响的不声明**。另外较新的 2.x 版本默认 strict 环境模式，没声明的变量可能根本传不进脚本，遇到「变量未定义」先想起这里。

**坑 6：Windows 下脚本里的中文。** 承接第 2 步的 warning：脚本由 cmd 执行，`echo "构建中"` 大概率输出乱码。占位脚本一律用英文，中文写在源码注释里。

## 自测问题

**问题 1：`dependsOn: ["^build"]` 和 `dependsOn: ["build"]` 差在哪？**

::: details 查看答案
`^build` 等上游：本包 package.json 里声明的每个内部依赖，它们的 build 任务先完成。`build`（不带 ^）等自己：同包内的 build 先完成，不管别的包。前者顺着依赖图往上游看，后者只看本包内部。
:::

**问题 2：一个任务的缓存哈希由哪些输入决定？**

::: details 查看答案
任务哈希：任务定义（turbo.json）、本包源文件内容、依赖包的文件内容、本包 package.json 与相关 lockfile、`env` 声明的环境变量。全局哈希（全体任务共享）：根 package.json 与 lockfile 变化、`globalDependencies` 文件、`globalEnv` 变量。任一变化都会让对应任务 cache miss。
:::

**问题 3：改了 shared 的源码，web 的 build 为什么也 cache miss？这合理吗？**

::: details 查看答案
因为 web 的任务哈希包含依赖包 shared 的文件内容。合理且必要：web 的产物依赖 shared 的类型与实现，上游变了而下游不重建，缓存就会拿旧产物冒充新结果——快是快了，埋的是雷。
:::

**问题 4：lint 不写 outputs、build 写 `["dist/**"]`，两者命中缓存时行为差在哪？**

::: details 查看答案
两者都会回放终端日志。但只有声明了 outputs 的任务会恢复文件产物：build 命中后 dist 被完整还回；lint 无产物可还。反过来，build 忘写 outputs，命中后日志照放、dist 是空的。
:::

**问题 5：Turborepo 和 pnpm 在这套体系里各管什么？**

::: details 查看答案
pnpm：依赖安装、workspace 链接、lockfile——「包怎么连」。turbo：按依赖图编排任务顺序、并行调度、按输入哈希缓存与回放——「命令怎么跑、要不要重跑」。turbo 不装依赖、不读代码，只认 package.json 的脚本与依赖声明。
:::

## 延伸阅读

- [Turborepo 官方文档](https://turbo.build/repo/docs)——从安装到进阶的完整入口
- [配置任务（Configuring Tasks）](https://turbo.build/repo/docs/crafting-your-repository/configuring-tasks)——tasks 各字段的官方讲解
- [缓存机制（Caching）](https://turbo.build/repo/docs/core-concepts/caching)——哈希输入、输出回放、故障排查
- [turbo.json 配置参考](https://turbo.build/repo/docs/reference/configuration)——所有字段的权威定义，随查随用
