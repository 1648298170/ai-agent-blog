# 第 2 周 · Day 2：Husky + lint-staged + commitlint——把质量门禁装进 git commit

> 对应手册任务：学习「Git hooks 原理、Husky、lint-staged、commitlint」；动手任务「配置 pre-commit 自动 lint、commit-msg 校验 Conventional Commits」；当日产出「提交即校验的 git hook」。本篇只解决一个问题：昨天的 ESLint 和 Prettier 只能「发现」问题，拦不住问题进仓库。今天把检查点搬到 git commit 发生的那一刻：代码不合格，提交失败；提交信息不合格，提交也失败。规范从口头约定变成物理拦截。

## 今日目标

1. 说得清 Git hooks 的触发机制，以及放在 `.git/hooks` 里的钩子为什么永远到不了队友手里、`core.hooksPath` 怎么解决
2. 掌握三件工具的分工：Husky 负责把钩子装进仓库并自动分发，lint-staged 负责只检查暂存区文件，commitlint 负责校验提交信息格式
3. 在 monorepo 根目录配好 pre-commit 与 commit-msg 两道关卡，亲眼看到两次拦截：一段带 lint 错误的代码、一条不合规的提交信息，都被挡在仓库门外

## 概念讲解：为什么检查点要放在 commit 那一刻

先盘点昨天的收尾状态：ESLint 抓代码问题，Prettier 统一格式，配置都放在根目录，全仓库共享。但它们是被动的：你不跑，它不查。赶功能的时候谁还记得跑？于是 lint 警告混着进了仓库，格式不统一的文件飘进 diff，提交信息更是自由发挥：`修改bug`、`final final fix`、`更新`。三个月后翻 git log，谁也认不出每条提交干了什么。

换个角度想。代码再乱、信息再随意，进仓库只有一条路：git commit。把检查点设在 commit 这一刻，就是设在唯一入口，一个都漏不掉。Git 原生就有这套机制，叫 hooks（钩子）：`pre-commit` 在提交对象生成前触发，`commit-msg` 在你写完提交信息后触发。钩子就是普通脚本，退出码为 0 放行，非 0 立刻中止这次提交。不用配置文件，不用额外语法，全靠退出码说话。

但原生钩子有个致命伤：它们住在 `.git/hooks/` 目录里。`.git` 是每个克隆自己的本地数据库，对象、分支指向、你的 remote 配置全在里面，它是 git 的工作状态而不是项目文件，git 从设计上就不允许提交它。你写好的 pre-commit 只存在于你这台电脑，队友 clone 下来的 `.git/hooks` 里只有一堆 `.sample` 示例。钩子不能随仓库分发，就只是一个人的自我修养，当不了团队的门禁。

解法分两步：把钩子文件放进一个正常被 git 跟踪的目录，再告诉 git「钩子从这个目录找」。这正是 Husky 干的事，用的就是 git 官方的 `core.hooksPath` 配置。在此基础上再配两件：lint-staged 回答 pre-commit 里「查什么」，只查暂存区文件，快且不误伤；commitlint 回答「提交信息长什么样」，按 Conventional Commits 规范逐条校验。三件工具各管一段，拼起来就是今天要装的门禁。

## 核心知识

### 1. Git hooks 的机制与 core.hooksPath

钩子的名字就是触发的时机。今天用到的两个：

- `pre-commit`：`git commit` 之后、提交对象生成之前。此时要提交的改动已经在暂存区，是拦截问题代码的最后机会
- `commit-msg`：提交信息写完之后。git 会把信息内容存进一个临时文件，并把文件路径作为第一个参数传给钩子，脚本里用 `$1` 接住

规则只有一条：退出码 0 放行，非 0 中止提交。

钩子默认从 `.git/hooks/` 目录加载，前面说过这个目录进不了版本库。好在 git 提供了 `core.hooksPath`，可以把加载目录指到仓库内任意路径：

```bash
git config core.hooksPath .husky
```

这一行就是全部原理：git 照常按钩子名字找文件执行，只是找的目录变了。目录从「本地私有」变成「仓库里的普通文件」，钩子就能被提交、被 clone、被全团队共享。理解了这行配置，Husky 对你来说就没有黑盒了。

### 2. Husky 9：一条命令装好钩子

Husky 做的事用上面的原理就能概括：把钩子放进 `.husky/` 目录，把 `core.hooksPath` 指过去，再解决「队友 clone 之后怎么自动配置」。v9 的初始化简化到一条命令：

```bash
npx husky init
```

它一次做三件事：给根 package.json 加 `"prepare": "husky"` 脚本；创建 `.husky/` 目录，里面带一个默认的 `pre-commit` 文件；设置 `core.hooksPath`。跑完可以验证：

```bash
git config core.hooksPath
# .husky/_（v9 指向 .husky 下的自动生成目录，旧版本直接指 .husky，效果一致）
```

关键是 `prepare` 这个 npm 生命周期脚本：任何人在仓库里执行 `pnpm install`，包管理器都会自动跑一遍 prepare，钩子目录就自动配好。分发问题从此不存在，新同事什么都不用知道，装完依赖门禁就位。

v9 还有个顺眼的变化：`.husky/` 里的钩子文件就是纯命令，一行一条。v8 时代每个钩子开头必须写两行样板（shebang 加 source husky.sh），v9 全免了，新建文件、写上命令，它就是钩子。

### 3. lint-staged：只查即将提交的文件

pre-commit 里最容易想到的写法是直接跑全量检查，比如 `pnpm turbo lint`。[第 1 周 Day 5](/week01/day5) 你体会过全量构建有多浪费，lint 同理：你只改了 packages/shared 里一个函数，凭什么陪 apps/web 的历史遗留问题一起被拦？全量检查还会逼你「提交前先清零全仓库的错误」，这门禁撑不过三天就被人人 `--no-verify` 绕过去。

lint-staged 的思路是只查这次提交真正包含的内容：拿到暂存区里的文件列表，按 glob 规则匹配，匹配上的才交给对应任务。配置长这样（放在根 package.json 里）：

```json
"lint-staged": {
  "*.{ts,tsx,js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml,css}": ["prettier --write"]
}
```

关键在 staged 这个词：没 `git add` 的文件一律不查。你工作区里躺着十个没写完的文件，只要没暂存，再脏也不影响这次提交。这让「提交一部分改动」成为日常操作，而不是每次提交都先来一场全仓库大扫除。

另一个贴心细节：`eslint --fix` 或 `prettier --write` 改动了文件后，lint-staged 会自动把改动重新 add 进提交，修好的内容直接跟着进去，不用你再补一轮命令。

### 4. commitlint 与 Conventional Commits

提交信息规范叫 Conventional Commits，格式一句话说完：`type(scope): subject`。type 说明这次提交的性质，scope 可选、写影响范围，subject 一句话讲清做了什么。`@commitlint/config-conventional` 预设里 type 只允许 11 个：feat（新功能）、fix（修 bug）、docs（文档）、style（格式类小改）、refactor（重构）、perf（性能）、test（测试）、build（构建与依赖）、ci（流水线）、chore（杂务）、revert（回滚）。日常开发基本在前五个里打转。

commitlint 拿你的提交信息逐条对规则：type 必须在枚举里且小写、subject 不能为空、结尾不能带句号、整行不超过 100 字符。为什么值得较真？因为规范的提交信息是机器可读的：feat 对应次版本号、fix 对应修订号，版本号能自动推断，CHANGELOG 能直接从 git log 生成。人较真这一下，机器后面全都还回来。

## 动手任务：在 monorepo 根目录配齐三件套

手册任务：配置 pre-commit 自动 lint、commit-msg 校验 Conventional Commits。拆成 5 步，全程约 20 分钟。所有命令都在仓库根目录执行，这正是 monorepo 的要点：git 仓库只有一个，`.git` 在根目录（[第 1 周 Day 4](/week01/day4) 搭的骨架），钩子也只有根目录这一份，装好即对 apps/ 和 packages/ 下所有子包生效。

**第 1 步：安装四个依赖。**

```bash
pnpm add -D -w husky lint-staged @commitlint/cli @commitlint/config-conventional
```

`-w` 把依赖装进根 package.json。钩子是仓库级设施，依赖装在根上；装进子包的话，钩子脚本在根目录根本找不到它们。

**第 2 步：初始化 husky。**

```bash
npx husky init
```

确认三处变化：根 package.json 多了 `"prepare": "husky"`；多出 `.husky/` 目录，里面有个 `pre-commit` 文件，默认内容是 `npm test`，根目录连 test 脚本都没有，对我们没用；`git config core.hooksPath` 有输出。用编辑器把 `.husky/pre-commit` 的内容整个替换成一行：

```
npx lint-staged
```

顺带说明：`.husky/` 下如果看到 `_` 子目录，那是自动生成的内部文件，不用管，有洁癖可以把它加进 `.gitignore`。

**第 3 步：配置 lint-staged。** 在根 package.json 里加一段（和 scripts 平级）：

```json
"lint-staged": {
  "*.{ts,tsx,js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml,css}": ["prettier --write"]
}
```

任务按昨天配好的 `eslint.config.js` 和 `.prettierrc` 执行，昨天的工作今天直接复用：钩子只负责在正确的时机调用它们。

**第 4 步：配置 commitlint。** 根目录新建 `commitlint.config.js`：

```js
module.exports = { extends: ['@commitlint/config-conventional'] };
```

再用编辑器在 `.husky/` 下新建 `commit-msg` 文件（是文件不是目录），内容一行：

```
npx --no -- commitlint --edit "$1"
```

`$1` 就是核心知识第 1 节说的临时文件路径；`--edit` 让 commitlint 校验这个文件里的内容；`--no` 让 npx 在找不到本地 commitlint 时直接报错退出，而不是弹「要不要帮你安装」的交互卡住提交。新建钩子文件后，回根目录补一句 `npx husky` 重建一次内部转发脚本，最稳妥。

**第 5 步：验证两道关卡。** 分三幕。

第一幕测 pre-commit。往 packages/shared/src/index.ts 里临时塞一行能被 ESLint 抓住且 `--fix` 修不掉的错，比如一个未使用的变量：

```ts
const unusedFlag = 1; // 故意的：no-unused-vars 报错，且 --fix 自动修不了
```

```bash
git add .
git commit -m "test: 验证 pre-commit"
```

预期看到 lint-staged 列出任务、eslint 报 no-unused-vars、提交中止。要故意选修不掉的错才有这一幕：能被 `--fix` 修掉的错误会被钩子默默修好放行，你看不到拦截。

第二幕测 commit-msg。删掉那行错误代码，`git add .` 之后换个不合规的信息提交：

```bash
git commit -m "修好了"
```

预期 pre-commit 顺利通过，commitlint 报 `type may not be empty`，提交再次中止。两次失败，两道关卡各拦一次，都在岗。

第三幕走正门：

```bash
git commit -m "chore: 配置 husky、lint-staged 与 commitlint"
```

这一次提交本身就是当日产出的验收：它同时穿过了两道门。

::: tip 逃生门
急事当前门禁挡路时，`git commit --no-verify`（简写 `-n`）可以跳过所有钩子硬提交。把它当消防斧：存在的意义是紧急破窗，不是日常进门。靠它进仓库的提交，问题一个不少全在里面。
:::

## 常见踩坑

**坑 1：在子包里执行 `npx husky init`。** monorepo 里 `.git` 只在根目录，钩子是仓库级设施。在 apps/web 里跑 init，生成的 `.husky/` 和 package.json 改动全落在子包里，轻则钩子不触发，重则两套配置互相打架。记 [第 1 周 Day 4](/week01/day4) 的老规矩：install、add 回根目录，钩子相关的一切同理，用 `-w` 装依赖，在根目录初始化。

**坑 2：用 PowerShell 的 echo 重定向创建钩子文件。** Windows 下顺手会写 `echo npx lint-staged > .husky/pre-commit`。PowerShell 5.1 的 `>` 默认输出 UTF-16 编码，git 自带的 sh 读不了这种文件，钩子要么报错要么静默装死，排查起来极其迷惑。本文所有配置文件一律用编辑器创建，就是躲这个坑。

**坑 3：带 lint 错误的文件没被拦，以为钩子失灵。** 先问一句：那个文件 `git add` 了吗？lint-staged 只查暂存区，没暂存的文件再脏也不管，这是设计不是 bug。反过来也要心里有数：`--fix` 改过的文件会被自动重新暂存进提交，偶尔你会觉得「提交里的代码和我写的不太一样」，那是钩子替你修的，`git show` 看一眼这次提交的 diff 就踏实了。

**坑 4：subject 首字母大写被拒。** 英文信息写成 `feat: Add login button`，commitlint 报 `subject must not be sentence-case`。config-conventional 的 subject-case 规则禁止 subject 以首字母大写的句式开头，小写 `add login button` 或直接写中文都没问题。另一个高频撞墙是整行超过 100 字符，细节挪到 body 里去写。

**坑 5：钩子不生效的排查清单。** 按顺序查三样：一，`git config core.hooksPath` 有没有输出，没有就是 prepare 没跑过，回根目录执行 `npx husky` 或重新 `pnpm install`；二，新加的钩子文件建好后有没有再跑一次 `npx husky` 重建转发脚本；三，安装依赖时是不是带了 `--ignore-scripts`，它会跳过所有生命周期脚本，prepare 也包括在内。另外 CI 上没钩子是正常的，钩子服务于本地提交，流水线靠显式跑 lint 兜底，两道防线各管各的。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `.git/hooks` 里的钩子为什么到不了队友手里？Husky 的解决方案分哪两步？

::: details 参考答案
`.git` 是每个克隆的本地数据库，存的是对象、配置和状态，git 设计上不允许提交它，所以里面的钩子文件无法随仓库分发。Husky 两步走：把钩子放进被版本库跟踪的 `.husky/` 目录；用 `core.hooksPath` 让 git 从这个目录加载钩子，再靠 package.json 的 prepare 脚本保证任何人 install 后自动完成这套配置。
:::

2. pre-commit 和 commit-msg 分别在什么时机触发？commit-msg 脚本里的 `$1` 指什么？

::: details 参考答案
pre-commit 在 `git commit` 之后、提交对象生成之前触发，此时改动已在暂存区，是拦截问题代码的最后机会；commit-msg 在提交信息写完之后触发，git 把信息存进一个临时文件，`$1` 就是这个文件的路径，`commitlint --edit "$1"` 校验的正是它。两个钩子退出码非 0 都会中止提交。
:::

3. pre-commit 里为什么用 lint-staged，而不是直接 `pnpm turbo lint`？

::: details 参考答案
全量 lint 又慢又会拿历史遗留问题拦住与本次无关的提交，等于逼人先清零全仓库错误才许提交，最后大家集体 `--no-verify` 绕过门禁。lint-staged 只把暂存区里匹配 glob 的文件交给任务，快且不误伤，还支持「只提交一部分改动」的日常工作流。
:::

4. monorepo 里钩子为什么装在根目录就能对 apps/web、packages/shared 全部生效？

::: details 参考答案
monorepo 只有这一个 git 仓库，`.git` 在根目录，`core.hooksPath` 是仓库级配置，git 不管提交发生在哪个子目录都从同一处加载钩子。所以根目录一份配置看住所有子包；对应的四个依赖也要用 `-w` 装在根 package.json，钩子脚本才能解析到它们。
:::

5. `feat: Add login button`、`修复登录bug`、`feat: add login button.` 这三条信息分别死在哪条规则上？

::: details 参考答案
第一条死在 subject-case：subject 不能是首字母大写的句式开头；第二条死在 type-empty：没有 type；第三条死在 subject-full-stop：subject 结尾不能带句号。合规写法如 `feat: add login button` 或 `fix: 修复登录校验`。
:::

## 延伸阅读

- [husky 官方文档](https://typicode.github.io/husky/)，v9 的安装、钩子编写与 FAQ，十分钟通读
- [lint-staged GitHub 仓库](https://github.com/lint-staged/lint-staged)，README 讲清了配置语法和部分暂存场景的处理方式
- [commitlint 官方文档](https://commitlint.js.org/)，全部规则清单，想自定义规则时来查
- [Conventional Commits 规范中文版](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，规范原文，type 与版本号的对应关系在这里

今天配好的门禁会一直用下去。明天给 packages/shared 写完 Vitest 单测后，我们会回到 `.husky/pre-commit`，让测试也过一遍这道门。
