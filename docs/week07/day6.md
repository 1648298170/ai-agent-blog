# 第 7 周 · Day 6：环境变量管理 + 密钥注入——把密码请出代码和镜像

> 对应手册任务：学习「环境变量管理 + 密钥注入」，动手「用 GitHub Secrets 注入数据库密码，写 `.env.example`」，当日产出「安全配置」。本篇只解决一个问题：昨天 CI 已经能把镜像推进 ghcr.io（见[第 7 周](/week07/) Day 5），整条流水线只剩一个洞：数据库密码还以明文散落在 compose 文件和 workflow 里。今天把这些密钥全部请出代码、日志和镜像层，让它们只活在三个地方：本地 `.env`、平台 Secrets、部署时的运行时注入，流水线照常跑。

## 今日目标

1. 说得清一次密钥泄露的完整事故剧本，以及四条铁律：`.env` 进 `.gitignore`，密钥永不进代码、日志、镜像层
2. 掌握三套机制：`.env.example` 的写法规范、GitHub Secrets（仓库级与环境级、日志掩码、`GITHUB_TOKEN` 与手动 Secret 的区别）、CI 与运行时两条注入路径
3. 独立完成安全配置：`.env.example` 提交进仓库，测试库密码从 Secrets 注入 CI，`GITHUB_TOKEN` 登录 ghcr 推镜像，用 `docker history` 验证镜像无密

## 概念讲解：一次泄露是怎么发生的

先看事故剧本，四个镜头。

镜头一，周四晚上。本地 `.env` 里的旧密码连不上同事新配的库，你图省事把 `.env` 跟代码一起 `git add .` 提交，心想「先跑通，明天删」。push 成功。

镜头二，几分钟后。GitHub 每秒都在接收公开仓库的新提交，观众里相当一部分不是人，是爬虫。它们逐 commit 扫描已知格式的密钥：AWS 的 `AKIA` 开头、数据库连接串、私钥块、高熵随机串。你的 `DATABASE_URL=postgresql://postgres:真实密码@...` 命中规则，入库。公开仓库里新提交的密钥几分钟内被爬虫抓走，这类实验和真实事故年年都有。

镜头三，周末。脚本用这串 URL 连库转了一圈，或者顺藤摸到同一文件里的云厂商 key，起了一批最贵的 GPU 实例挖矿。

镜头四，周一。云厂商账单邮件到了，四位数。你第一反应是删掉仓库里的 `.env`，没用：git 记录的是每次提交的完整快照，文件在历史里躺着，爬虫扫的恰恰是历史。此刻唯一有效的动作是轮换密钥，作废旧的。

这不是吓唬人的沙盘。2016 年 Uber 的 AWS 凭证就是从一个 GitHub 仓库流出的，5700 万用户数据被拖走，公司瞒了一年才曝光。根因都一样：代码和密钥走了同一条通道。

两类东西的天性相反。代码天生要给人看：进 git、进仓库、进镜像，复用的人越多越好。密钥天生只能给信任边界内的少数人用。塞进同一条通道，事故只是时间问题。所以今天的全部内容就一句话：分通道。代码走 git，配置走环境变量，密钥走 Secrets，镜像保持无密，容器启动那一刻才注入。

## 核心知识

本节的配置片段都可以直接抄进项目，动手任务会把它们拼成完整产出。

### 1. 四条铁律与它们各自拦住的事故

| 铁律 | 拦住的事故 |
| ---- | ---- |
| `.env` 进 `.gitignore` | 手滑 `git add .` 把密钥提交进仓库 |
| 密钥不进代码 | 密码写死在 ts、compose、workflow、Makefile 里随代码入库 |
| 密钥不进日志 | CI 日志、应用日志把密码明文打出来 |
| 密钥不进镜像层 | 镜像发布后任何人 `docker history` 读走 ENV 里的密码 |

第一条有个前提：`.gitignore` 只忽略「尚未跟踪」的文件。已经提交过的 `.env`，光加一行 ignore 不生效，得先 `git rm --cached .env` 再提交。验证方法见动手任务第 1 步。

第四条最反直觉，亲眼看一遍。假设有人手痒在 Dockerfile 里写了：

```dockerfile
ENV DATABASE_URL=postgresql://postgres:S3cret!@pg:5432/mydb
```

构建、推送，然后任何人 pull 下来敲一条命令：

```text
$ docker history my-api:latest
IMAGE   CREATED   CREATED BY                                      SIZE
...     ...       ENV DATABASE_URL=postgresql://postgres:S3c…    0B
```

ENV 的值固化在层元数据里，`docker history` 原样显示。`ARG` 别以为能幸免：构建时通过 `--build-arg` 传入的值，会以 `|TOKEN=值` 的形式出现在对应层的 CREATED BY 里，一样裸奔。

好消息是构建期通常根本不需要密钥。Day 1 的 Dockerfile 里 `npm ci`、`prisma generate`、`tsc` 没有一步要连数据库，数据库是运行时才碰的。真遇到构建期就要密钥的场景（比如拉私有 npm 包），用 BuildKit 的 `--secret`，它只在构建进程内存里过一遍，不落层，见延伸阅读。

### 2. `.env.example`：配置的契约

`.env` 不进 git，新人克隆仓库后怎么知道要配哪些变量？答案是 `.env.example`：字段和真 `.env` 完全一致，值全是假的。它进 git，是配置的「合同」。

三条规范：全字段、逐字段注释、假值格式逼真。

```text
# .env.example —— 复制为 .env 后按本机环境改值；本文件进 git，.env 永远不进

# PostgreSQL 连接串。格式：postgresql://用户名:密码@主机:端口/库名
DATABASE_URL=postgresql://postgres:changeme@localhost:5432/mydb

# Redis 连接串
REDIS_URL=redis://localhost:6379

# 服务监听端口
PORT=3000

# 运行环境：development | test | production
NODE_ENV=development

# 项目里还有其他敏感配置（如 JWT_SECRET、第三方 API key）就往下追加，规矩同上
```

假值为什么也要逼真：`changeme` 保留了 URL 的完整形状，新人替换一个词就能用；写成 `xxx` 或 `填这里`，对方会猜「是不是还要自己拼格式」。另外，注释里写清字段含义和格式，比让人翻代码找 `process.env` 的引用快得多。

它还是三个环境的对齐清单：本地 `.env`、CI 的 Secrets、部署机的 `.env`，字段全部从这一份抄。项目加了新配置却忘了更新 example，同事本地起不来还查不到原因。所以规矩是：改配置的 PR，必须同步带上 `.env.example` 的修改。

### 3. GitHub Secrets：存放、分级与掩码

存放位置：仓库页 Settings → Secrets and variables → Actions → New repository secret。存进去的值页面不再显示，workflow 里用 `${{ secrets.名字 }}` 引用。

两种级别：

- **仓库级**：本仓库所有 workflow 可用，最常用
- **环境级**：先建一个 environment（比如 `production`），Secret 挂在环境下，workflow 里声明 `environment: production` 的 job 才取得到。环境还能配「必须有人审批，job 才能开跑」，把生产密钥的接触面压到最小

掩码机制：Secret 的值一旦出现在 Actions 日志里，会被自动替换成 `***`。注意掩码是「事后打码」，不是访问控制。绕过手段一大把：字符串切片、base64 编码都能让它原形毕露。所以官方态度很明确：别把「敢 echo」当成「安全」，打印密钥这个动作本身就该消失。

`GITHUB_TOKEN` 是个特殊角色，和手动创建的 Secret 有一张对比表：

| | `secrets.GITHUB_TOKEN` | 手动 Secret |
| ---- | ---- | ---- |
| 来源 | 每次 run 自动生成 | 你手动创建 |
| 生命周期 | job 结束自动过期 | 长期有效，直到你轮换 |
| 权限 | 由 workflow 的 `permissions` 字段声明 | 配进去什么就是什么 |
| fork 的 PR | 拿不到你仓库的敏感权限 | 同样拿不到 |

结论：推 ghcr 只需要 `GITHUB_TOKEN` 加一句 `packages: write`，别建一个长期有效的 PAT 存进 Secrets 再用它登 registry，那是把一次性门票换成了万能钥匙。

### 4. CI 注入：密码从 Secret 到进程的两跳

链路：Actions 在 job 启动时把 Secret 解开 → 写进 service 容器和 step 的环境变量 → 测试进程从 `process.env` 读到。关键片段（完整版在动手任务第 4 步）：

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: ${{ secrets.TEST_PG_PASSWORD }}
          POSTGRES_DB: mydb_test
    steps:
      - run: npm test
        env:
          DATABASE_URL: postgresql://postgres:${{ secrets.TEST_PG_PASSWORD }}@localhost:5432/mydb_test
```

同一个 Secret 喂了两处：service 容器用它初始化 PG 的密码，测试进程用它拼连接串，两边天然一致。日志里这条 URL 会显示成 `postgresql://postgres:***@...`，这就是掩码在工作。

测试库密码其实是用完即焚的（job 一结束容器就销毁），放进 Secrets 练的是流程：万一日后换成真实库，路径一字不改。别拿生产密码来填，这是原则问题。

### 5. 运行时注入：镜像无密，容器有密

镜像推上去了，部署时密码怎么进来？Day 1 就见过答案：

```bash
docker run -e DATABASE_URL="postgresql://postgres:密码@prod-pg:5432/mydb" -p 3000:3000 my-api
```

`-e KEY=value` 注入单个变量；`-e KEY` 不带等号，从当前 shell 继承同名变量，密码不用敲进命令行历史。compose 项目则是 `env_file: .env`（[第 7 周](/week07/) Day 2 用过），密码写在部署机本地的 `.env` 里，compose 文件保持干净。

共同点：注入发生在 `docker run` 那一刻，只进容器内存，不进镜像层。镜像随便分发，谁能起容器，谁才需要拿到密码。

最后是轮换意识。密钥是有寿命的，泄露响应有固定顺序：先轮换（让新值生效、旧值作废，泄露物立刻变成废纸），再清理（`git filter-repo` 重写历史、删掉带密钥的旧镜像 tag），最后复盘。顺序不能反：清理要花几小时，空档期里爬虫还在用旧值。平时再配一把 gitleaks 扫描进 CI（延伸阅读有），把「不小心 push 了 .env」挡在合并之前。

## 动手任务：安全配置三件套，一步一步

手册任务：用 GitHub Secrets 注入数据库密码，写 `.env.example`。产出是三件套：`.gitignore` 补丁、`.env.example`、改造后的 workflow。拆 5 步，约 25 分钟。

**第 1 步：确认门关上了。** 在项目根目录（PowerShell 直接敲）：

```bash
git check-ignore -v .env
```

有输出、指向某条 ignore 规则，说明 `.env` 已被忽略；没输出就打开 `.gitignore` 加一行 `.env`。再补一道历史检查：

```bash
git log --all --oneline -- .env
```

无输出最好，`.env` 从未进过历史。有输出说明历史上提交过，处理办法见坑 1，轮换优先。顺手确认 `.dockerignore` 里也有 `.env`（Day 1 配过四行，其中就有它）。

**第 2 步：写 `.env` 和 `.env.example`。** 先把核心知识第 2 节的 `.env.example` 抄进项目根目录。然后复制一份改名为 `.env`，把 `changeme` 换成你本机真实的值。`.env` 给本机用，不进 git；`.env.example` 提交进仓库。

**第 3 步：把测试库密码存进 Secrets。** GitHub 仓库页 → Settings → Secrets and variables → Actions → New repository secret，名字 `TEST_PG_PASSWORD`，值随手生成 20 来个字符（密码管理器生成或键盘乱敲都行）。用 gh CLI 的话一条命令：

```bash
gh secret set TEST_PG_PASSWORD --body "你生成的那串密码"
```

注意值别和任何真实环境一致。

**第 4 步：改造 workflow。** 在 Day 5 的 build + push workflow 上动两处：测试 job 的密码改从 Secrets 来，登录 ghcr 用 `GITHUB_TOKEN`。完整参考版，可以直接对照着改：

```yaml
name: ci

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: ${{ secrets.TEST_PG_PASSWORD }}
          POSTGRES_DB: mydb_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
        env:
          DATABASE_URL: postgresql://postgres:${{ secrets.TEST_PG_PASSWORD }}@localhost:5432/mydb_test
          NODE_ENV: test

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
```

两个 job 各看一处：`test` 里同一个 Secret 喂了 service 容器和 step env，密码两边一致；`build-and-push` 里 `permissions` 声明了 `packages: write`，这是 `GITHUB_TOKEN` 能推镜像的全部前提。

**第 5 步：验证三处。** push 后进 Actions 页面：

一看日志。连接串里的密码位置显示 `***`，掩码生效；`build-and-push` 里没有手敲的任何密码，登录成功本身就是 `GITHUB_TOKEN` 在工作的证据。

二打前 4 位。真想确认 Secret 传没传到，安全写法是只打印前 4 位（runner 是 ubuntu，bash 语法可用）：

```yaml
      - run: echo "TEST_PG_PASSWORD 前缀: ${TEST_PG_PASSWORD:0:4}****"
        env:
          TEST_PG_PASSWORD: ${{ secrets.TEST_PG_PASSWORD }}
```

前 4 位不足以反推全值，只够确认「传进来的就是我存的那份」。

三查镜像。本地对同一 Dockerfile 构建出的镜像跑：

```bash
docker history my-api:latest
```

从上往下扫 ENV 行和 RUN 行，不该出现任何密码。Day 1 的 Dockerfile 本来就没写过数据库相关 ENV，这一步是把「没手痒加过」变成「检查过」。

::: tip 当日产出
三件套：`.gitignore` 里的 `.env`（外加 `.dockerignore` 里的同名行）、提交进仓库的 `.env.example`、改造后的 workflow（测试密码走 Secrets、推镜像走 `GITHUB_TOKEN`）。这套配置不挑项目，换一个仓库原样能用。
:::

## 常见踩坑

**坑 1：泄露后第一反应是删文件。** 删掉工作区的 `.env` 只是让你自己看不见，git 历史里躺着，registry 的旧镜像层里可能也躺着。正确顺序永远是：轮换（作废旧值）→ 清理（`git filter-repo` 重写历史、删旧镜像 tag）→ 复盘（把密钥扫描加进 CI）。轮换动作五分钟就能完成，清理要几小时，先用轮换把损失锁死。

**坑 2：把掩码当保险箱。** `***` 只在 Actions 日志里做字符串替换，切片、编码随便一绕就露出来，GitHub 文档自己都写了别依赖它。验证密钥是否到位，用第 5 步的「只打前 4 位」，或者更干脆：看下游行为，测试连上库了，密码自然是对的。

**坑 3：觉得 `ARG` 比 `ENV` 安全。** 运行时确实读不到 ARG，但 `--build-arg` 传进来的值会以 `|TOKEN=值` 的形式出现在 `docker history` 的层记录里，和 ENV 一个下场。构建期需要密钥只有一条正路：BuildKit 的 `--secret`，构建完即焚，不落任何层。

**坑 4：给 ghcr 建长期 PAT。** 有人发现 `GITHUB_TOKEN` 推完 ghcr 还要配权限，嫌麻烦，就建一个经典 PAT 存进 Secrets 用它登录。对比第 3 节那张表：`GITHUB_TOKEN` 是 job 结束就作废的一次性门票，PAT 是放在仓库里永不过期的万能钥匙，任何能改 workflow 的人都有机会读到。多写一行 `permissions`，换来密钥自动过期，这笔账怎么算都划算。

**坑 5：`.env.example` 的三种死法。** 一是写了真实值，example 变成第二个泄露源；二是字段缺斤少两，新人复制后项目起不来，又查不到原因；三是没注释，没人知道 `DATABASE_URL` 该是什么格式。再送一条隐蔽的：compose 里 `env_file` 和 `environment` 同时写同一个变量时，`environment` 优先，不知道这条覆盖规则的，调试到怀疑人生。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `.env` 已经 push 到公开仓库 20 分钟，按顺序说出你的前三个动作。

::: details 参考答案
立刻轮换密钥，作废旧值；评估影响面，这串密码能碰到哪些资源、要不要查访问记录；然后才轮到清理（`git filter-repo` 重写历史）并通知协作者重新克隆。删文件排在最后，甚至不用排，它不解决任何问题。
:::

2. 为什么「密钥不进镜像」？`docker history` 在哪个环节把值暴露出来？

::: details 参考答案
镜像是用来发布和分发的，任何 pull 到它的人都读得到层记录。ENV 的值在构建时固化进层元数据，`docker history` 直接显示；`--build-arg` 传的值同样以 `|名字=值` 的形式出现在层记录里。正解是镜像无密、运行时用 `-e` 或 `env_file` 注入，容器有密而镜像干净。
:::

3. `secrets.GITHUB_TOKEN` 和手动创建的 Secret，至少说出三个区别。

::: details 参考答案
来源：每次 run 自动生成 vs 手动创建存放；生命周期：job 结束自动过期 vs 长期有效直到轮换；权限：由 workflow 的 `permissions` 字段逐 job 声明 vs 配进去什么就能用什么；可见范围：fork 的 PR 拿不到敏感权限 vs 同样隔离但值永不过期。所以推 ghcr 优先用 `GITHUB_TOKEN`。
:::

4. 描述密码从 GitHub Secrets 到测试进程 `process.env.DATABASE_URL` 的完整链路。

::: details 参考答案
Secret 存在仓库设置里 → job 启动时 Actions 把 `${{ secrets.TEST_PG_PASSWORD }}` 求值 → 一路写入 service 容器的 `POSTGRES_PASSWORD`（PG 那侧生效）和 step 的 `env`（拼进 `DATABASE_URL`）→ 测试进程从环境变量读到 → 万一打进日志，掩码替换成 `***`。
:::

5. `.env.example` 的三条规范是什么？为什么假值也要「格式逼真」？

::: details 参考答案
全字段、逐字段注释、假值格式逼真。逼真的假值保留了真实配置的形状（比如完整 URL），新人替换一个词就能跑起来；垃圾假值会让对方猜格式，甚至在开发期就错过 URL 解析类的配置校验。
:::

## 延伸阅读

- [GitHub Docs：Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)，仓库级/环境级/组织级 Secret 的官方说明，掩码机制的边界也写在这里
- [GitHub Docs：Automatic token authentication](https://docs.github.com/en/actions/security-guides/automatic-token-authentication)，`GITHUB_TOKEN` 的生成、过期与 `permissions` 字段的权威解释
- [The Twelve-Factor App：Config](https://12factor.net/config)，「配置存环境变量」这套思想的原典，一分钟读完
- [gitleaks](https://github.com/gitleaks/gitleaks)，密钥扫描工具，加一个 CI step 就能挡住「不小心 push 了 .env」
- [Docker Docs：Build secrets](https://docs.docker.com/build/building/secrets/)，构建期真需要密钥时的 `--secret` 方案，不落镜像层

今天的产出三件套留好。明天（Day 7）从零走一遍 push → CI → 镜像 → 部署的完整流程时，你会庆幸今天把「安全」这一环焊死了：流水线跑得越自动，密钥的出口就越要收窄。
