# 第 7 周 · Day 4：GitHub Actions 基础——合并之前，机器先跑一遍

> 对应手册任务：学习「GitHub Actions 基础：workflow/on/jobs/steps」，动手写一个 CI workflow，在 push 时跑 lint + test，当日产出 `.github/workflows/ci.yml`。本篇只解决一个问题：前三天应用已经全部进了容器（见[第 7 周](/week07/)），但代码能不能合进 main，如今还靠一句「我电脑上能跑」担保；今天把这份口头担保换成机器门禁：每次 push 和 PR，GitHub 自动起一台干净的虚拟机装依赖、跑 lint 和 test，红叉拦在合并按钮前面。

## 今日目标

1. 说得清 CI 解决什么问题：干净环境验证一遍，再加「不绿不许合」的门禁，终结「我电脑上能跑」
2. 掌握 workflow 文件的四层结构：`on` 触发器（push / PR + 分支过滤）、`jobs`（并行与 `needs` 依赖）、`runs-on`、`steps` 顺序，以及三个关键 action 的分工
3. 独立产出 `.github/workflows/ci.yml`：push 到 main 或提 PR 时自动跑 `turbo lint test`，并给 main 配上「CI 绿才能合并」的分支保护

## 概念讲解：为什么需要 CI

先看没有 CI 的日子。第 1 周你在 `turbo.json` 里配好了 build / lint / test 三条管道（见[第 1 周 · Day 5](/week01/day5)），第 2 周用 pre-commit 挡提交时刻，前三天又把 api 和 web 全塞进了容器。工具链齐了，流程却还停在手工时代：

1. 改完代码，你记得跑 `pnpm turbo lint test`，队友不一定记得；周五的你记得，下周一的你未必
2. 就算记得，跑的是你的电脑：你的 Node 是 22，队友可能是 20；你本地装过的全局工具、手改过的文件，别的机器上统统没有。「本地绿」从来不等于「干净环境也绿」
3. reviewer 在 PR 里看的是 diff，lint 报错和挂掉的测试藏在终端里，人肉核对又累又漏

这三条指向同一件事：验证不该依赖人的自觉和人的机器。CI（Continuous Integration，持续集成）做的就是把它自动化：代码一 push，云端起一台全新的 Linux 虚拟机，拉代码、装依赖、跑 lint 和 test，结果直接贴在 PR 上，绿勾红叉一目了然。价值就两条。一是干净：那台机器上没有你的任何缓存和巧合，它绿了才算真的绿。二是门禁：配合分支保护设置成「CI 不绿不许合并」，问题代码在合并前被拦下，而不是合进 main 之后靠人肉回滚。

这不是抽象概念，你现在读的这篇博客就是这么发出来的。仓库里的 `.github/workflows/deploy.yml` 是一条真实在跑的 workflow：每次 push 到 main，GitHub 起虚拟机、装 pnpm、装 Node、构建 VitePress 站点、发布到 Pages。今天先拆它的语法，再照着写出自己的第一条 CI。

## 核心知识

本节的配置片段都属于最终那份 `ci.yml`，动手任务里会完整拼出来；引用 `deploy.yml` 的部分是仓库里真实存在的文件，建议打开并排对照。

### 1. workflow 文件：一个 YAML，四层结构

GitHub 只认一个位置：仓库根目录下的 `.github/workflows/`，里面每个 `.yml` 就是一条 workflow。最小骨架长这样：

```yaml
name: CI                    # 第一层：名字，显示在 Actions 标签页

on:                         # 第二层：什么时候触发
  push:
    branches: [main]
  pull_request:
    branches: [main]        # 过滤的是 PR 的目标分支，不是来源分支

jobs:                       # 第三层：干什么活，一个 job 一台独立虚拟机
  lint-and-test:
    runs-on: ubuntu-latest  # 跑在哪种机器上
    steps:                  # 第四层：job 内按顺序执行的步骤
      - uses: actions/checkout@v4
      - run: echo "hello"
```

四层各管一摊：

- `name`：给人看的，Actions 标签页按它区分多条 workflow
- `on`：触发器。`push` 是「有人推了代码」，`pull_request` 是「有人提了 PR」，各自能用 `branches` 过滤，但过滤对象不同：`push.branches` 管「往哪个分支 push」，`pull_request.branches` 管「PR 的目标分支是什么」。这个组合是标准打法：日常在 feature 分支干活，push 不触发、不刷屏；提 PR 时以 pull_request 触发跑门禁；PR 合并会对 main 产生一次 push，再兜底跑一遍
- `jobs`：多个 job 默认并行，各自一台全新虚拟机，互相看不见对方的磁盘；需要先后顺序就写 `needs`
- `steps`：从上到下执行，任何一步退出码非零，后面的步骤直接跳过，整个 job 标红。这个 fail-fast 正是门禁的底气：一步红，全盘红

`runs-on: ubuntu-latest` 说的是用 GitHub 托管的虚拟机，最新 LTS Ubuntu，自带 Docker 和常用工具。公开仓库跑它不计时，私有仓库每月送两千分钟，跑 lint 和 test 绰绰有余。

拿仓库里那条真实的 `deploy.yml` 对照，四层全部对得上，还多出两个值得认识的东西：

```yaml
# .github/workflows/deploy.yml（节选）
on:
  push:
    branches: [main]
  workflow_dispatch:        # 手动触发：Actions 页面多一个 Run workflow 按钮

jobs:
  build:
    runs-on: ubuntu-latest
    # ……构建步骤……
  deploy:
    needs: build            # 先构建，后部署
    runs-on: ubuntu-latest
```

`needs: build` 的意思是 deploy 这台虚拟机等 build 成功了才开跑，和第 2 天 compose 的 `depends_on` 是同一种思路：顺序是声明出来的，不是赌出来的。它还有个隐含行为：build 失败时 deploy 不跑也不红，显示为「跳过」，因为对一个没发生的前提没必要报错。另外两个字段今天用不上，混个脸熟：`permissions` 声明这条 workflow 的令牌权限（部署 Pages 要写权限，CI 只读就够）；`concurrency` 让同一时刻只有一条部署在跑，连续 push 不打架。

### 2. 三个关键 action：拉代码、装 pnpm、装 Node

steps 有两种写法：`uses` 引用别人封装好的 action，相当于 npm 世界的包；`run` 直接敲 shell 命令。CI 的前三步全世界长得都差不多，因为每台虚拟机都是裸机，得先把工具装齐：

```yaml
steps:
  - name: Checkout
    uses: actions/checkout@v4     # 把仓库代码拉到虚拟机上

  - name: Setup pnpm
    uses: pnpm/action-setup@v4    # 装 pnpm，版本故意不写，往下看

  - name: Setup Node
    uses: actions/setup-node@v4
    with:
      node-version: 22
      cache: pnpm                 # 把 pnpm 的包缓存挂到 GitHub 缓存上，下次提速
```

三个 action 各管一段，顺序还不能换：

- `actions/checkout@v4`：不拉代码，后面一切无从谈起。默认只浅克隆最近一次提交；`deploy.yml` 里的 `fetch-depth: 0` 拉全量历史，那是 VitePress 要算文章的更新时间，CI 跑 lint 和 test 用默认就够
- `pnpm/action-setup@v4`：虚拟机上没有 pnpm，这一步负责装。妙在不写 `version` 也能工作：它去读根目录 `package.json` 的 `packageManager` 字段。这个字段是第 1 周 Day 5 装 turbo 时按提示补上的（见[第 1 周 · Day 5](/week01/day5)），从今天起它多了个消费者：本地一份、CI 一份，版本永远一致，谁也漂不了
- `actions/setup-node@v4`：装指定版本的 Node；`cache: pnpm` 把 pnpm 的下载缓存存进 GitHub 的缓存服务，第二次跑 `install` 从缓存拿包，能省一大半时间

顺序上 pnpm 必须排在 Node 前面：`cache: pnpm` 需要 setup-node 找到 pnpm 的可执行文件来定位 store，反过来写这步直接报错。`deploy.yml` 里同样是 Checkout → pnpm → Node，照抄不会错。`@v4` 是 action 的版本号，用法和 npm 钉大版本一致，放心用。

### 3. 命令层：frozen-lockfile + 第 1 周的 turbo 管道

环境齐了，剩下两行 `run` 才是 CI 的正题：

```yaml
      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint and test
        run: pnpm turbo lint test   # run 可省略，第 1 周 Day 5 讲过等价关系
```

第一行 `--frozen-lockfile`：lockfile 写什么装什么，缺一个条目直接报错，绝不顺手更新。要的就是这份死板：本地 install 可以宽松，CI 必须严格复现仓库声明的状态。

第二行是今天的点睛之笔。`turbo lint test` 跑的就是第 1 周在 `turbo.json` 里配的那两条管道：lint 各包并行扫一遍；test 挂着 `dependsOn: ["build"]`，每个包先出自己的 dist 再跑测试，shared 的产物现场构建，不用你操心。当时这条管道只在本地手动跑，从今天起挂在每次 PR 上自动跑。第 1 周埋的种子，今天正式进 CI。

两个进阶配置今天用不上，知道有这回事就行。monorepo 里只改一行文档也全量跑测试很浪费，`on.push.paths` 能按目录过滤触发；想精确到「只跑受影响的包」，用 dorny/paths-filter 或 turbo 的 `--filter`。要同时验证 Node 20 和 22、Linux 和 macOS，`strategy.matrix` 能把一份配置展开成多个并行 job。

## 动手任务：`.github/workflows/ci.yml` 一步一步

手册任务：写一个 CI workflow，在 push 时跑 lint + test。拆成 5 步，全程约 20 分钟。前提：第 1 周的 monorepo 骨架还在（pnpm workspace + `turbo.json` 的 lint / test 管道），根目录 `package.json` 里有 `packageManager` 字段。

**第 1 步：建文件。** 在仓库根目录新建 `.github/workflows/ci.yml`。目录以点开头，`workflows` 是复数，少一个 s GitHub 都认不出来。它就是仓库的一部分，写完记得提交，不进 git 不生效。

**第 2 步：写触发器。**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

为什么是这两个：`pull_request` 是门禁主战场，PR 目标是 main 才触发，feature 分支上怎么推都不刷屏；`push` 限定 main 是兜底，管住 PR 合并后的那次提交，也管住偶尔直推 main 的热修。单人开发不走 PR 的话，删掉 `pull_request` 整段、去掉 `push` 的 branches 过滤，每次 push 都跑，门禁照样成立。

**第 3 步：装环境。** 建 job，把核心知识第 2 节的三件套搬进来，顺手装依赖：

```yaml
jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
```

`node-version: 22` 和 `deploy.yml` 里的保持一致：本地、CI、部署三条链路一个版本。这段和博客仓库那条部署 workflow 的前四步一字不差，建议并排打开对照着读一遍。

**第 4 步：接上 turbo，拼出完整文件。** 最后加一个 step：

```yaml
      - name: Lint and test
        run: pnpm turbo lint test
```

::: details 完整文件对照
四段拼起来，最终 `.github/workflows/ci.yml` 长这样（YAML 对缩进敏感，抄的时候留意）：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Lint and test
        run: pnpm turbo lint test
```
:::

**第 5 步：弄红它一次，再上锁。** 门禁这东西，没亲眼看过它拦人，就等于不存在。

先故意弄红：开个分支，随便找个包造一个未使用的变量（或注释掉一个测试断言），push 上去，开 PR。仓库的 Actions 标签页很快出现一条转黄圈的运行记录，点进去能看到每一步的实时日志，和本地终端一模一样；跑完，PR 上出现红叉。修掉再推一次，眼看它变绿。

然后上锁：仓库 Settings → Branches → Add branch protection rule，Branch name pattern 填 `main`，勾上 Require a pull request before merging 和 Require status checks to pass before merging，在搜索列表里选中 `lint-and-test`，保存。从此红叉的 PR 合并按钮点不动，「我电脑上能跑」作废，说话算数的只有那台虚拟机。job id 起得有意义，在这里就有回报：保护规则列表里显示的就是它。

注意门槛：分支保护对公开仓库免费；私有仓库在免费计划下开不了这个入口，要 Pro 及以上计划。

## 常见踩坑

**坑 1：第一次跑就红，`ERR_PNPM_OUTDATED_LOCKFILE`。** 意思是 lockfile 和 package.json 对不上：本地改了依赖却没提交更新后的 `pnpm-lock.yaml`。本地 `pnpm install` 会顺手把 lockfile 更新掉，你毫无感觉，CI 拒绝代劳。解法就是把最新 lockfile 一起提交。把这条红叉当成 CI 的见面礼：它第一次出手就抓到了一个真实隐患。

**坑 2：本地绿，CI 红。** 九成是版本漂移：本地 Node 20、CI 写了 22，或者本地 pnpm 和仓库声明的不一致。对策全在今天的配置里：pnpm 版本交给 `packageManager` 字段统一，Node 版本三处（本地、CI、部署）对齐。剩下一成是「本地有、仓库里没有」的东西：全局安装的工具、忘了提交的文件。CI 红不是 CI 找茬，它在告诉你代码依赖了一个没写进仓库的事实。

**坑 3：同一个 PR，CI 跑了两遍。** `on.push` 不写 `branches` 过滤时，往 feature 分支每推一次，push 事件触发一遍，pull_request 事件再触发一遍，两台虚拟机干同一件事。修法就是第 2 步的写法：push 限定 main。只保留 `pull_request` 一个触发器也行，代价是失去合并到 main 后的兜底检查。

**坑 4：Actions 标签页空空如也。** 文件写了却像没写。挨个检查：目录是不是 `.github/workflows/`（点开头、workflows 复数）、文件是不是在仓库根目录、YAML 缩进有没有错（编辑器装个 YAML 插件，能自动标红）、以及最朴素的——推上去了吗。GitHub 对语法错误的文件会在 Actions 页面给出提示，前提是你打开了那个页面。

**坑 5：把机密写进 ci.yml。** 公开仓库里 workflow 文件全世界可读，日志里 `echo` 出来的环境变量也全世界可看。测试要用的数据库密码、API key，一律走仓库 Settings → Secrets and variables → Actions，step 里用 `${{ secrets.XXX }}` 引用，日志自动打码。这块第 6 天专门讲，今天先记住底线：ci.yml 里不出现任何明文机密。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `on.push.branches` 和 `on.pull_request.branches` 过滤的分别是什么？

::: details 参考答案
`push.branches` 过滤「往哪个分支 push 才触发」；`pull_request.branches` 过滤「PR 的目标（base）分支是什么才触发」。门禁主要挂在 pull_request 上，push 限定 main 用于兜底合并后的那次提交。
:::

2. 两个 job 不写 `needs` 会怎样？`deploy.yml` 里 deploy 为什么需要 `needs: build`？前置失败时它是什么状态？

::: details 参考答案
不写 needs，多个 job 各自一台虚拟机并行，互相看不见。写了 needs 变成先后顺序，前置成功才开跑。deploy 消费 build 的产物，必须等；build 失败时 deploy 显示为「跳过」而不是「失败」，对没发生的前提不报错。
:::

3. `pnpm/action-setup@v4` 不写 version，它从哪知道装哪个版本？为什么这是推荐做法？

::: details 参考答案
读根目录 `package.json` 的 `packageManager` 字段（第 1 周 Day 5 补的那一行）。版本只有这一个事实来源，本地和 CI 都以它为准，永不漂移。前提是该字段存在且版本号真实，否则 action 会报错找不到版本。
:::

4. `cache: pnpm` 缓存的是什么？为什么有了缓存还是要跑 `pnpm install`？

::: details 参考答案
缓存的是 pnpm 的 store（下载的包本体），不是各包的 node_modules。install 依然要跑：它负责把包链接进 workspace、执行 postinstall、布置目录结构。缓存省掉的只是「从网络重新下载」，通常能把装依赖时间砍掉一大半。
:::

5. `pnpm turbo lint test` 和进每个包手动跑 lint、test 差在哪？

::: details 参考答案
turbo 按 `turbo.json` 的管道编排：lint 各包并行；test 依赖同包 build，dist 现场构建；有缓存的任务直接回放日志恢复产物。一条命令覆盖整个 monorepo，不漏包、顺序不会错，第 1 周配好的管道原样复用。手动跑既容易漏，也享受不到这些。
:::

## 延伸阅读

- [GitHub Actions：workflow 语法参考](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions)，官方对 `on` / `jobs` / `steps` 每个字段的权威说明，今天所有配置项的原始出处
- [pnpm/action-setup](https://github.com/pnpm/action-setup)，这个 action 的仓库，README 讲清了它读 `packageManager` 的规则和常见报错
- [Turborepo：CI Vendors 指南](https://turborepo.com/docs/guides/ci-vendors)，turbo 在各家 CI 平台上的接法，GitHub Actions 章节就是今天的进阶版

今天的 `ci.yml` 留好。明天 Day 5 往里面加一个新 job：用前三天的 Dockerfile 构建镜像、推到 GitHub Container Registry，让流水线从「验证代码」长到「交付产物」。从今天起，你的 main 分支由机器守门。
