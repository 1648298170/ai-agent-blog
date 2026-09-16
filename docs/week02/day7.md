# 第 2 周 · Day 7：周复盘——把质量门禁和 Next.js 变成自己的

> 手册任务：周复盘 + 整理。把 lint/format/test 配置整理进 README，写 300 字周记，当日产出：README + 周记。
> 本篇解决的问题：门禁配完、页面跑通之后，怎么确认这套东西真的进了脑子——下一个新项目，不看教程还能不能把它重新配出来。

先复述一遍 [上周 Day 7](/week01/day7) 立的规矩：复盘不是重读笔记，是输出倒逼输入。识别和提取是两回事，你认得 `npx husky init` 的每一行输出，不代表你下次配得出来。方法上周讲透了，今天直接用，流程不变：整理文档、写四段周记、做 10 题自检、git 收口。变的只是本周要提取的内容。

## 今日目标

1. 把本周的 lint/format/test 配置整理成一份「新项目质量门禁 checklist」，写进仓库 README
2. 按四段模板写一篇 300 字周记
3. 过一遍 10 题自检清单，答不上来的标记出来，回读对应 Day 的教程

## 概念讲解：门禁为什么要前置——本周主线想透才算复盘完

这一周你配了不少东西：ESLint、Prettier、husky、lint-staged、commitlint、Vitest。如果复盘只是把每条命令再认一遍，那你复述得出操作，说不出判断。今天先把本周主线里最容易被当成「配置步骤」略过、其实是工程决策的那件事想清楚：**质量检查为什么要卡在提交和 CI 这两个点上，而不是等代码写完再统一查。**

先看一个错误被发现的代价，随发现位置怎么变：

| 错误在哪被发现 | 距离写下的时间 | 代价 |
| --- | --- | --- |
| 编辑器红线 | 几秒 | 几乎为零，改掉就是 |
| pre-commit 钩子 | 几秒到几十秒 | 本地重写，没人知道 |
| CI 流水线 | 几分钟 | 重跑管道，阻塞合并 |
| code review | 几小时到几天 | 格式问题消耗队友时间，真问题被淹没 |
| 生产环境 | 几周 | 事故、回滚、加班 |

规律很简单：发现越晚，代价越大，而且涨的不是线性。所谓门禁前置，就是把错误的发现位置往表格上方推，业界叫「左移」（shift-left）。你本周配的所有工具，都是在「左移」这两个字上干活。

为什么卡在「提交」这个点？因为 commit 是代码进仓库的唯一入口，守住入口就守住了下游所有环节。而本地钩子又是所有防线里反馈最快、成本最低的一道：[Day 2](/week02/day2) 配的 lint-staged 只查暂存区文件，几秒出结果，门禁快，人才愿意守；门禁一慢一烦，就有人 `--no-verify` 绕过去。

那为什么还要 CI？因为本地钩子拦不住所有情况：`--no-verify` 一个参数就能跳过；刚 clone 的仓库没跑过 install，prepare 没执行，钩子根本不在。所以流水线要显式跑 lint 和 test 做全量兜底。两道防线各管各的：钩子拦增量，图快；CI 拦全量，图严。少了哪一道，门禁都是漏的。

还有一层现实意义：为什么第 2 周就配门禁，而不是等第 10 周「项目成型了再说」。存量代码越多，全量 lint 清零越痛；门禁配得越早，烂代码进仓库的量就越少。先立规矩，再盖楼。

把这段逻辑讲清楚了，你配的就不只是一堆工具，而是一套「错误越早越便宜」的防线设计。自检清单的第 3、4、5 题都在考它。

## 核心知识

### 1. README 复盘法：把配置写成给人看的文档

上周的输出是画图，这周换成写 README。道理一样：配置文件是写给机器执行的，README 是写给三个月后的自己和队友看的。写得出「每条配置为什么存在」，才是真懂；哪一行你说不出理由，哪一行就是你本周没消化的部分。而且这份 README 有个额外的好处：它是下一个新项目的起点，checklist 直接复用。

一份合格的质量门禁 README 有三块，缺一不可：

1. **常用命令**：lint、format、test 怎么跑，一行一个，新人克隆完先看这段
2. **门禁分层**：哪个环节、用什么工具、拦什么问题，一张表说清
3. **提交规范**：Conventional Commits 的格式和允许的 type，附两三个合规示例

写的时候自问一个问题：队友读完能不能不问任何人就把门禁配到新项目里？能，这份 README 就合格了。完整模板放在下面动手任务第一步，照抄再改。

### 2. 300 字周记模板

四段不变，和上周同一套（模板来历见[上周 Day 7](/week01/day7)）：最大收获、卡得最久、还含糊、下周前补。每段一两句，总共 300 字上下，禁止抄教程原句。

第 2 周示例，照这个密度写：

```text
① 本周最大收获：质量门禁的核心不是装了几个工具，是「错的东西过不了
git commit」这一条。ESLint 和 Prettier 本身是被动的，husky 把它们焊
在提交流程上，自觉才变成机制。
② 卡得最久：Server Action 改完数据界面不动，dev 里刷新一下又「好了」，
next build 一跑才现形——忘调 revalidatePath。教训：缓存相关的 bug
别信 dev 模式。
③ 还含糊：'use client' 边界和 bundle 的关系，只能背结论，说不出哪些
代码进了客户端包、为什么；vi.mock 的提升时机同理。
④ 下周前补：把 Day 6 的 todos 页删掉凭记忆重写一遍，卡住才允许翻教程。
```

第 3 周要测 NestJS 服务，`vi.mock` 是那周的主力武器，「还含糊」这段里点到它，下周开场就有方向。

### 3. 第 2 周知识自检清单

规则同上周：每题先口头回答，说完整了再点开答案对照。说不出来的记下题号，回读对应 Day 的教程。

**问题 1：ESLint 9 的平铺配置（flat config）和老的 `.eslintrc` 差在哪？对 monorepo 有什么好处？（Day 1）**

::: details 答案
配置从一个 JSON 对象变成 `eslint.config.js` 里按顺序合并的数组，每项还能用 `files` 圈定作用范围。老方式靠「从文件所在目录往上层找 `.eslintrc`」的级联机制；平铺配置根目录写一份就覆盖全仓库，monorepo 里不用再管子包继承哪层配置。
:::

**问题 2：ESLint 和 Prettier 各管什么？格式上的重叠怎么解决？（Day 1）**

::: details 答案
ESLint 管代码质量，比如未使用的变量、可能的逻辑隐患；Prettier 管格式，缩进、引号、换行。两者在格式规则上会打架，解法是配 `eslint-config-prettier`，把 ESLint 里所有格式类规则关掉，格式让 Prettier 一个说了算。
:::

**问题 3：Git hooks 默认放在 `.git/hooks/` 里，为什么队友永远收不到？husky 用什么机制解决？（Day 2）**

::: details 答案
`.git` 目录是每个克隆的本地数据库，git 设计上不允许提交它，里面的钩子文件自然无法随仓库分发。husky 用 git 官方的 `core.hooksPath` 配置把钩子加载目录指到仓库内被版本库跟踪的 `.husky/`，再靠 package.json 的 `prepare` 脚本保证任何人 install 后自动完成这套设置。
:::

**问题 4：lint-staged 为什么只查暂存区的文件？全量检查有什么问题？（Day 2）**

::: details 答案
pre-commit 关心的是「这次提交改了什么」，也就是暂存区的内容，只查它所以快。全量检查有两个死穴：慢，以及逼你「提交前先清零全仓库的历史遗留」——这种门禁撑不过三天就被人 `--no-verify` 绕过去。
:::

**问题 5：Conventional Commits 的格式是什么？feat 和 fix 分别对应版本号怎么变？（Day 2）**

::: details 答案
`type(scope): subject`，type 说明提交性质，scope 可选。`config-conventional` 预设允许 11 个 type：feat、fix、docs、style、refactor、perf、test、build、ci、chore、revert。feat 对应次版本号，fix 对应修订号，版本号能自动推断，CHANGELOG 能直接从 git log 生成。
:::

**问题 6：这个 monorepo 选 Vitest 而不是 Jest 的三条理由分别对应 Jest 的什么痛点？（Day 3）**

::: details 答案
一是 ESM：shared 是 NodeNext ESM，Jest 默认 CommonJS，原生 ESM 至今挂着实验标志，TS 还得请 ts-jest 或 babel；Vitest 用 esbuild 直接吃 TS 源码，零转换配置。二是快：esbuild 并行编译，watch 秒级重跑。三是 Vite 同源：apps/web 本来就是 Vite，测试和应用共享同一套模块解析心智，不必再养一套 Jest 配置。
:::

**问题 7：`vi.mock` 写在测试文件的第几行有区别吗？这个特性带来什么限制？（Day 3）**

::: details 答案
没区别。`vi.mock` 会被提升，无论写在文件哪里都搬到所有 import 之前执行，保证被替换的模块加载前替身已就位。代价是 factory 里不能引用外部变量（提升时它们还没初始化），真遇到就用 `vi.hoisted`。
:::

**问题 8：page、layout、loading、error 四个文件各自的职责是什么？哪个决定路由是否存在？（Day 4）**

::: details 答案
page 是路由入口，渲染页面内容，只有它决定路由是否存在；layout 包住本段和所有子段，必须渲染 `children`，导航时不重新挂载；loading 等价于框架自动包的一层 Suspense fallback；error 是段级错误边界，必须是客户端组件，接收 `error` 和 `reset` 两个 props。四个文件都作用于所在的段。
:::

**问题 9：`'use client'` 的边界含义是什么？它是不是表示「这个组件只在客户端运行」？（Day 5）**

::: details 答案
不是。它是模块级声明：这个文件和它 import 的模块会进客户端 bundle，水合之后可以用状态、事件、浏览器 API。写了 `'use client'` 的组件首屏照样由服务端渲染出 HTML。它划的是服务端与客户端的边界，不是渲染开关；没写的文件默认 Server Component，不能碰事件和浏览器 API。数据跨边界要靠 props，值必须可序列化。
:::

**问题 10：用 Server Action 替代 API 路由提交表单，链路上少了哪几步？为什么 JS 没加载也能提交？（Day 6）**

::: details 答案
少三步：手写 API 路由处理函数、客户端 fetch 调用、手动处理加载态和刷新缓存。Server Action 是标了 `'use server'` 的 async 函数，编译器生成能从浏览器安全调用的入口，`<form>` 的 action 直接指向函数本身。浏览器提交表单是 HTML 原生能力，JS 没加载也照做；加载后 React 再接管成无刷新交互。
:::

::: tip 10 题全对也别飘
全对说明本周及格。README、周记、git 收口三件事做完，本周才算收口。答不上来的题别硬背答案，回读对应 Day 的对应小节，理解了自然记得住。
:::

## 动手任务：完成本周复盘

按顺序做完四步，预计 60 到 80 分钟。

**第一步：写质量门禁 README（25 分钟）**

对照下面的模板写进仓库根 README。模板是底稿，逐项核对你仓库里的真实配置，命令、glob、工具版本以自己的为准。看不懂某行的地方，正好就是你要回读的地方。

```markdown
## 质量门禁

### 常用命令

| 命令 | 作用 |
| --- | --- |
| pnpm lint | 全仓库 ESLint 检查 |
| pnpm format | Prettier 格式化全部文件 |
| pnpm test | 经 turbo 跑所有包的测试（vitest run） |

### 门禁分层

| 防线 | 工具 | 拦什么 | 触发时机 |
| --- | --- | --- | --- |
| 编辑时 | 编辑器 ESLint / Prettier 插件 | 即时红线和格式提示 | 写代码时 |
| 提交时 | husky + lint-staged | 暂存区文件的 lint 错误和格式问题 | git commit |
| 提交信息 | commitlint | 不符合 Conventional Commits 的信息 | commit-msg |
| CI | 流水线显式跑 lint + test | 全量兜底（本地钩子可被 --no-verify 绕过） | push / PR |

### 新项目质量门禁 checklist

- [ ] 根目录 `eslint.config.js`（平铺配置，全仓库一份）
- [ ] 根目录 `.prettierrc`，配 `.prettierignore`
- [ ] `eslint-config-prettier` 关闭 ESLint 的格式规则
- [ ] `npx husky init`，确认 `git config core.hooksPath` 有输出
- [ ] `.husky/pre-commit` 写入 `npx lint-staged`
- [ ] 根 package.json 配 lint-staged：
      `*.{ts,tsx,js,mjs,cjs}` 跑 `eslint --fix` + `prettier --write`，
      `*.{json,md,yml,yaml,css}` 跑 `prettier --write`
- [ ] 根目录 `commitlint.config.js` extends `@commitlint/config-conventional`
- [ ] `.husky/commit-msg` 写入 `npx --no -- commitlint --edit "$1"`
- [ ] Vitest 接进 turbo，管道里用 `vitest run` 不用 watch
- [ ] CI 显式跑 lint 和 test（钩子只管本地，别指望它兜底）

### 提交规范

格式 `type(scope): subject`。允许的 type：feat / fix / docs / style /
refactor / perf / test / build / ci / chore / revert。

合规示例：

- `feat(todos): 支持删除待办`
- `fix(shared): formatDate 跨月计算错误`
- `docs: 补充质量门禁 README`
```

**第二步：写 300 字周记（20 分钟）**

按四段模板写，对照上面的示例密度。第 3 段「还含糊」别敷衍，第 3 周测 NestJS 之前，它就是你的补课清单。

**第三步：做自检清单（15 分钟）**

10 题逐个口头回答，答不上来的记下题号，回读对应 Day 教程。回读也是复盘的一部分，不丢人。

**第四步：git 提交整理（15 分钟）**

今天恰好有实弹演习的机会：README 和周记的提交本身就要过一遍本周配的门禁。提交时盯着终端，看 lint-staged 跑了暂存文件、commitlint 校验了你的信息——门禁在你眼前工作，这比任何复盘都直观。

```bash
# README 一个提交，周记一个提交，一个提交只做一件事：
git add README.md
git commit -m "docs: 补充质量门禁 README"
git add docs
git commit -m "docs: 第 2 周周记"

# 打标签收口：
git tag week02-done
```

注意 README 的提交信息刚好走 `docs` 这个 type，上周你大概还觉得这些枚举是死记硬背，今天用一次就长在身上了。

## 常见踩坑

**README 写成配置文件的搬运。** 把 `eslint.config.js` 和 package.json 里的段落原样贴进去，机器认识，人不认识。README 的读者是人，每段配置配一句「为什么存在」，写不出的那行就是你的知识缺口。

**checklist 只剩命令，丢了「为什么」。** 十条命令抄下来不叫门禁，那叫默写。每条后面能补出一句理由（比如 lint-staged 为什么只查暂存区、CI 为什么要兜底），这份 checklist 才能在新项目里活下来。

**周记写成功能清单。** 「周一配了 ESLint，周二配了 husky」，这是目录。四段模板里第 2 段「卡得最久」最值钱，本周谁还没被 revalidatePath 或者钩子不生效坑过一次？写出来，下周少踩。

**自检先看答案。** 老规矩：先口头回答再点开折叠。认得答案和说得出来隔着一条鸿沟，第 9 题尤其容易「一看就懂，一问就倒」。

## 延伸阅读

- [第 1 周 Day 7：周复盘方法论](/week01/day7)：四段周记和自检清单的规矩原点，本周流程照它执行
- [Conventional Commits 官网](https://www.conventionalcommits.org)：type 枚举和版本号对应关系的权威出处
- 「左移测试」（shift-left testing）：本篇概念讲解的理论靠山，想深入可以搜这个词，核心一句话：测试做得越早，修复越便宜

下周开始前，把周记第 4 段留的补课动作清掉。第 2 周到此收口。
