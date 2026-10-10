# 第 7 周 · Day 5：CD 第一步——把构建产物推上镜像仓库

> 对应手册任务：学习「CD：构建镜像 + 推送到 registry」，动手在 CI 中增加 build + push 到 GitHub Container Registry，当日产出「自动构建镜像」。本篇只解决一个问题：CI 的虚拟机跑完就销毁，构建产物没有落脚点，得给镜像找一个固定的家，让任何服务器在任何时候都能拉到「这份代码对应的那份镜像」。

## 今日目标

1. 说得清 registry 在 CI 和部署之间扮演什么角色，以及 Docker Hub、GHCR、阿里云 ACR 各自适合谁
2. 掌握四个配置点：`permissions: packages: write`、`login-action`、`build-push-action`、tag 策略
3. 独立写出 `docker.yml`，把 api 和 web 两个镜像推上 GHCR，并在仓库的 Packages 页亲眼看到它们

## 概念讲解：为什么需要 registry

前几天流水线已经能跑 lint 和 test 了，绿色的对勾挂在仓库首页。但仔细想一个问题：这些检查全部通过之后，产物在哪？

没有产物。lint 和 test 是「检查」，不生产任何东西。下一步要让代码变成能部署的东西，也就是 Docker 镜像。而镜像有个绕不开的特点：它是个几十上百 MB 的大文件，必须放在一个稳定的地址上，别人才拉得走。

CI 的虚拟机指望不上。GitHub 给你跑 job 的那台机器是临时的，job 一结束就销毁，镜像跟着灰飞烟灭。你自己的笔记本也不行，总不能让生产服务器 ssh 到你电脑上 `docker pull`。就像写代码要 push 到 GitHub、装依赖要从 npm 拉，镜像也需要一个专门的仓库，这就是 registry。流水线补上这一环之后长这样：

```
git push → CI 跑 lint/test → 构建镜像 → push 到 registry → 服务器 docker pull → 运行
```

registry 是 CI 和部署的交接点。CI 的职责到「把镜像放进仓库」为止，服务器的职责从「从仓库拉镜像」开始，两边互不认识也能配合，靠的就是中间那个稳定的镜像地址。至于「测试不过就不许推镜像」这类顺序约束，今天先让 docker 工作流和已有 ci.yml 各自独立跑通，联动的门禁以后用 `needs` 或分支保护再收紧，一次只学一件事。

## 核心知识

### 1. 选哪个 registry：Docker Hub、GHCR、阿里云 ACR

| | Docker Hub | GHCR | 阿里云 ACR |
|---|---|---|---|
| 和代码库的关系 | 无关，独立账号 | 就在 GitHub 仓库旁边 | 独立服务，需单独开通 |
| 推送认证 | 账号密码或令牌 | `GITHUB_TOKEN`，零配置 | AccessKey |
| 国内拉取速度 | 时好时坏，不稳定 | 能用，但不算快 | 最快，国内节点 |
| 免费额度 | 有限流和私有库限制 | 公开仓库免费推拉 | 个人版有免费额度 |

选型建议一句话：代码托管在 GitHub、CI 用 Actions，就选 GHCR，推送权限自带动、不用手工配一个 Secret，这是今天的方案。生产服务器在国内、对拉取速度敏感的项目，可以以后把镜像同步一份到 ACR，先不用管。

### 2. GHCR 的镜像名和自动到账的 GITHUB_TOKEN

GHCR 的镜像名是三段式：

```
ghcr.io/<owner>/<image>:<tag>
 仓库域名   所有者   镜像名   版本标签
```

比如 `ghcr.io/jerry/agent-api:latest`。有个硬规定：整条名字必须全小写。GitHub 用户名可以含大写字母，但拼进镜像名时必须转成小写，这个坑下面还会细说。

推镜像需要认证，而 GHCR 最香的地方是：认证用的 `GITHUB_TOKEN` 是 Actions 每次运行自动注入的临时令牌，代表「这次流水线」本身，job 结束自动作废。你不需要去 Settings 里创建任何 Secret，拿来就用。它默认权限只读，想推包必须在 workflow 里显式声明：

```yaml
permissions:
  contents: read    # 拉代码
  packages: write   # 推镜像，少了它必报 403
```

镜像的可见性默认跟随仓库：公开仓库推出公开镜像，谁都能拉；私有仓库推出私有镜像，拉取要带凭证。

### 3. tag 策略：latest、git sha、semver 各管一段

- `latest`：永远指向最近一次构建，给「想快速试一把」的人和开发环境用。它天生可变，今天拉和明天拉可能不是同一个镜像。
- `git sha`：commit 的哈希，比如 `c3f8a2e...`。不可变，一个 tag 精确对应一份代码，线上出了问题能立刻回答「跑的是哪次提交」，回滚就是换回上一个 sha。生产部署用它。
- `semver`：`v1.2.3` 这种语义化版本，标记「这批功能稳定了」的里程碑，给人看的历史坐标，通常在发版打 git tag 时附带生成。

一次构建同时打 `latest` + `sha` 两个 tag 是常见做法：latest 给想快速试的人，sha 给认真部署的机器，一个镜像两个入口，各取所需。

### 4. 构建缓存：type=gha

CI 每次运行都是一台全新虚拟机，本地的 layer 缓存永远是空的。镜像里 npm install 那一层最耗时，没有缓存的话，每次推送代码都要全量重装依赖，好几分钟耗在这上面。`type=gha` 把构建层缓存写进 GitHub Actions 自带的缓存服务，下一次构建直接命中，耗时段往往能从几分钟缩到几十秒。两个细节：`mode=max` 连中间层一起缓存，默认只缓存最终层；`scope` 划分独立缓存空间，让 api 和 web 各用各的，避免 matrix 里两个 job 互相覆盖。单个仓库的缓存上限是 10GB，超了按最久未使用淘汰，不用心疼。

## 动手任务：docker.yml 一步一步

拆成 5 步，全程约 30 分钟，前提是你有 GitHub 仓库的写权限。

**第 1 步：确认 Dockerfile 就位。** `api/` 和 `web/` 两个目录里各有一个 Dockerfile，且本地执行 `docker build ./api` 和 `docker build ./web` 都能成功。今天的所有步骤都建立在这一点上，缺了先回去补，这一步省不了。

**第 2 步：建文件，整份照抄。** 新建 `.github/workflows/docker.yml`，把两处 `<owner>` 换成你的 GitHub 用户名，注意全小写：

```yaml
name: docker

on:
  push:
    branches: [main]   # 默认分支是 master 就改掉

permissions:
  contents: read
  packages: write      # 推镜像的关键，少了它必报 403

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        app: [api, web]    # 一个模板跑两个 job
    steps:
      - name: 拉取代码
        uses: actions/checkout@v4

      - name: 初始化 Buildx
        uses: docker/setup-buildx-action@v3

      - name: 登录 GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: 构建并推送
        uses: docker/build-push-action@v6
        with:
          context: ./${{ matrix.app }}
          push: true
          tags: |
            ghcr.io/<owner>/agent-${{ matrix.app }}:latest
            ghcr.io/<owner>/agent-${{ matrix.app }}:${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.app }}
          cache-to: type=gha,mode=max,scope=${{ matrix.app }}
```

`matrix` 那三行是这份文件的杠杆：app 列表写一次，api 和 web 各生成一个 job，后面所有步骤对两个镜像各跑一遍。以后要加新服务，往列表里添一个词就行。

**第 3 步：读懂登录段。** username 填 `${{ github.actor }}`，也就是触发这次推送的账号；password 塞 `secrets.GITHUB_TOKEN`。这个 token 是 Actions 自动发的临时令牌，job 结束即作废，所以不用配置、也不存在泄漏长期密码的问题。它能推包，靠的是文件顶部那句 `packages: write`，两处配合缺一不可。

**第 4 步：读懂 tags 与缓存段。** tags 用 YAML 竖线写法列了两行，构建完成后两个 tag 指向同一个镜像：`latest` 是「最新」的代名词，`${{ github.sha }}` 那串 40 位十六进制是本次提交的指纹，永久不变。`cache-from`/`cache-to` 一进一出：先尝试从缓存恢复构建层，构建完再把新层写回缓存，`scope` 按 app 分开，两个镜像各自一套。另外缓存导出依赖 Buildx，所以前面要先跑 `setup-buildx-action`，别删。

::: tip 多架构一句带过
如果部署目标是 arm64 服务器（部分云主机、自建 ARM 机器），给 build-push-action 加一行 `platforms: linux/amd64,linux/arm64`，Buildx 会借助 QEMU 一次构建双架构镜像，代价是构建时间接近翻倍。今天默认只构建 amd64，够用。
:::

**第 5 步：提交推送并验收。** commit、push 之后打开仓库的 Actions 页，能看到 docker 这个 workflow 跑了两个 job（api、web），首次构建没有缓存，慢一点正常，第二次 push 起你会看到明显提速。全绿之后去验收：

1. 仓库首页右侧的 Packages 栏，出现 agent-api 和 agent-web 两个包
2. 点进包详情，能看到 `latest` 和那串 sha 两个 tag、镜像的 digest，页面还给出了现成的 `docker pull` 命令
3. 想实测就在本地拉一次：`docker pull ghcr.io/<owner>/agent-api:latest`。私有仓库需要先用带 `read:packages` 权限的 PAT 执行 `docker login ghcr.io`，公开镜像直接拉

第一次推送成功的那一刻，package 会自动创建并关联到你的仓库，Packages 页能看到镜像，这就是「自动构建镜像」的验收标准。

## 常见踩坑

**坑 1：镜像名里有大写字母。** GHCR 要求镜像名全小写。GitHub 用户名 `Jerry` 直接拼进镜像名，push 时就报 `invalid reference format`。所以第 2 步让你把 `<owner>` 手工写成小写，而不是拿 `${{ github.repository_owner }}` 原样拼，那个变量会保留大写。报错信息里完全看不出「大小写」三个字，第一次撞上基本都要查半天。

**坑 2：漏了 packages: write。** 症状是登录成功、构建成功，最后 push 那一步 403 denied。`GITHUB_TOKEN` 默认只读是安全默认值，权限必须显式声明。回头检查 docker.yml 顶部的 `permissions` 块，是不是写在了 workflow 一级而不是 jobs 里面对的位置。

**坑 3：缓存不写 scope。** matrix 里两个 job 并发跑，共用同一个默认缓存空间，你写我覆盖，命中率反而低。`scope=${{ matrix.app }}` 给 api 和 web 各留一块自留地。另外 10GB 上限是整个仓库所有缓存共享的，`mode=max` 存得细也存得多，超限后被清是正常现象，不是配置坏了。

**坑 4：拿 latest 部署生产。** latest 是可变标签，用它部署等于主动放弃回答「线上跑的是哪份代码」的能力，回滚更是无从下手。给人的便捷入口用 latest，给机器的部署凭据用 sha，这条线要划死。

**坑 5：私有仓库的镜像拉不动。** 服务器上 `docker pull` 报 denied，别急着改 workflow，推送和拉取是两回事。私有镜像必须先在服务器上 `docker login ghcr.io`，用户名是 GitHub 账号，密码用一个只带 `read:packages` 权限的 PAT，永远不要在服务器上存 GitHub 的登录密码。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么推 GHCR 不需要事先配置任何 Secret？`GITHUB_TOKEN` 从哪来、默认能干什么？

::: details 参考答案
`GITHUB_TOKEN` 是 Actions 每次运行自动注入的临时令牌，代表这次流水线本身，job 结束即失效，所以拿来就用、无需配置。默认权限只读，能推镜像靠 workflow 里显式声明 `packages: write`。它和手工创建的 PAT、repo Secrets 是两回事，后者是长期凭证，需要人去配置和保管。
:::

2. `ghcr.io/Jerry/Agent-API:latest` 这个镜像名错在哪？

::: details 参考答案
两处大写：owner 段的 `Jerry` 和镜像名的 `Agent-API`。GHCR 要求镜像地址全小写，GitHub 用户名本身可以含大写，但拼进镜像名时必须转小写。这是新手推 GHCR 最常见的报错来源，错误信息 `invalid reference format` 还完全不提示原因。
:::

3. latest、git sha、semver 三种 tag 各适合什么场景？生产部署该用哪种？

::: details 参考答案
latest 永远指向最近一次构建，适合快速试用和开发环境，可变是它的本性；sha（commit 哈希）不可变，一个 tag 精确对应一份代码，适合生产部署、审计和回滚；semver 标记对外发布的版本里程碑，是给人看的历史坐标。生产用 sha，发版时再补 semver，latest 只当便捷入口。
:::

4. `cache-from`/`cache-to` 的 type=gha 解决什么问题？`mode=max` 和 `scope` 各自的作用？

::: details 参考答案
CI 每次运行都是全新虚拟机，本地 layer 缓存为空，npm install 等耗时层每次全量重跑。type=gha 借 GitHub Actions 的缓存服务存取构建层，跨运行复用。mode=max 连中间层一起缓存，默认只缓存最终层；scope 划分独立缓存空间，matrix 里 api 和 web 各用各的，避免并发时互相覆盖。
:::

5. 镜像推送成功，但服务器上 `docker pull` 报 denied，按什么顺序排查？

::: details 参考答案
先看镜像可见性：私有镜像必须先 `docker login ghcr.io`。再查凭证：密码应是带 `read:packages` 权限的 PAT。最后核对镜像名：owner 是否小写、包名和 tag 是否抄对，直接复制 Packages 页给出的 pull 命令最稳。公开镜像还报错，多半是名字抄错了。
:::

## 延伸阅读

- [docker/build-push-action](https://github.com/docker/build-push-action)，今天的主角，README 把 tags、cache、platforms 每个参数都讲了一遍，值得通读
- [GitHub 文档：Working with the Container registry](https://docs.github.com/en/packages/working-with-a-container-registry)，镜像可见性、权限、PAT 拉取的官方说明
- [docker/login-action](https://github.com/docker/login-action)，登录 GHCR、Docker Hub、ACR 通用的登录 Action
- [docker/metadata-action](https://github.com/docker/metadata-action)，tag 想自动化（从 git tag 生成 semver、短 sha）就靠它，进阶再学不迟

两个镜像躺进仓库之后，CI 这边的活就干完了。接下来的问题变成：服务器怎么把它们拉下来、跑起来、跑稳。这两个带着 sha 的镜像地址，就是后面部署环节的输入，今天先把这份「随时可拉」的家底攒下。
