# 第 7 周 · Day 7：周复盘——串起一次 push 的完整旅程

> 手册任务：周复盘 + 整理。从零走一遍 push → CI → 镜像 → 部署的完整流程，写周记，当日产出：流程文档 + 周记。
> 本篇解决的问题只有一个：这六天学的 Dockerfile、compose、workflow、GHCR 都是零件，今天要验证它们连起来还是不是一台能跑的机器。

## 今日目标

1. 从零走通一条完整链路：改一行代码，push，看 CI 逐站变绿，GHCR 出新镜像，本地拉下来确认改动真的在镜像里
2. 把链路写成"一次 push 的旅程"流程文档，每一站写清发生了什么、看什么日志、挂了从哪查
3. 按四段模板写 300 字周记，过 10 题自检清单，git 打 tag 收口

## 概念讲解：零件都对，链条未必通

这周六天，你每天交付一个零件：Day 1 的多阶段 Dockerfile，Day 2 的 compose 编排，Day 3 的 Next standalone 加 Nginx，Day 4 的 CI workflow，Day 5 的 GHCR 推送，Day 6 的 Secrets。每个零件当天都验证过，都好使。

但零件好使不等于流水线好使。真实交付是一条链：代码要过 CI，CI 要出镜像，镜像要进 registry，registry 的镜像还要能在别的机器上跑起来。链上有大量接缝，每一道都没验证过：本地 `docker build` 有分层缓存，CI 的 runner 每次都是一台新机器，缓存要另外搬；本地镜像名随手起，GHCR 强制全小写外加 owner 前缀；compose 里服务间用服务名互访，镜像一旦离开你这台机器，运行时配置全靠环境变量注入。任何一道接缝对不上，链就在那断。

所以本周复盘的检验标准，从第 1 周的"合上资料能不能复述"（方法论见[第 1 周](/week01/) Day 7）升级为：**从零走一遍，链能不能通**。方法不变，还是输出倒逼输入，只是产出从画结构图换成写流程文档：

| 输出方式 | 逼出什么 | 对应今天的产出 |
| --- | --- | --- |
| 走流程 | 零件之间的接缝通不通 | 完整链路跑一遍 |
| 写流程文档 | 每一站是否真的知道发生了什么 | "一次 push 的旅程" |
| 写作 + 自测 | 认知变化 + 细节记忆 | 300 字周记 + 10 题清单 |

为什么强调写下来？因为第一次走通可能带着运气：恰好 Secrets 配对了，恰好镜像名没大写。流程文档的价值是把"运气走通"变成"照着走就能通"。你排错时最贵的成本从来不是修，是不知道自己断在哪一站。这份文档还有第二个身份：下周部署到服务器，它就是操作手册。

## 核心知识

### 1. 流程文档：一次 push 的旅程

先给全景。这条链一共六站，前五站今天走通，第六站留给下周。把下面这张表抄进笔记，就是流程文档的骨架，动手任务里再往里填你自己项目的真实值：

| 站点 | 发生了什么 | 看什么日志 | 失败排查入口 |
| --- | --- | --- | --- |
| ① 本地 commit | 改动进 git 历史，这一站决定后面所有站的内容物 | `git status` 确认没有漏提交的文件，`git log --stat` 看这个提交带了什么 | add 错文件用 `git restore --staged` 撤出暂存区，已提交的用 `git reset --soft HEAD~1` 重新来；重点确认 `.env` 没被带上 |
| ② push | 分支推上 GitHub，workflow 的 `on: push` 命中，一次运行排队 | 终端 push 的回显；仓库 Actions 页能看到这次运行出现 | push 被拒是远端有新提交，`git pull --rebase` 再推；Actions 没触发查 `on` 的分支过滤 |
| ③ CI：lint + test | GitHub 分配一台全新 runner，checkout、装依赖、lint、test 逐 step 执行，任一步非零退出整站变红 | Actions 页点进这次运行，逐 step 展开；红 X 的 step 从下往上找第一个报错 | lint 挂本地 `npx eslint .` 复现最快；test 挂看断言信息；依赖装不上查 node 版本和 lockfile 是否提交 |
| ④ CI：构建镜像 | runner 上经 buildx 执行 docker build，分层照常生效；但 runner 用完即焚，本地缓存带不过去，要靠 cache-from / cache-to 显式搬 | build 那段日志，数一数多少层标 CACHED；首次全量构建属正常 | 构建失败看第一条 ERROR，多半是 COPY 的文件不在构建上下文里、路径或大小写不符 |
| ⑤ 推 GHCR | 用 GITHUB_TOKEN 登录 ghcr.io，docker push，镜像落到 `ghcr.io/<owner>/<镜像名>:<tag>` | push 日志末尾的 digest（镜像指纹）；GitHub 个人页的 Packages 列表 | denied 三连查：镜像名带大写、owner 写错、token 缺 packages: write 权限 |
| ⑥ 服务器拉取部署（下周） | 服务器上 `docker compose pull` 拉新镜像，`up -d` 重建容器 | 先占位，下周补 | 先占位 |

表格里有三处接缝，单独叮嘱：

**站③到站④，缓存是两回事。** 本地构建快，是层缓存存在你机器上；CI 每次新机器，不配缓存搬运就每次全量重来。这不是坏了，是缓存没搬。想搬，用 buildx 的 cache-from / cache-to 存到 GitHub Actions 缓存或 registry。

**站⑤的命名有硬规矩。** `ghcr.io/<owner>/<镜像名>` 全小写，owner 是你的 GitHub 用户名或组织名。本地镜像叫 `ai-agent-api` 随便跑，push 时名字里带一个大写字母就直接被拒。

**站⑥今天只立牌子。** 但有两件事现在就要有数：服务器拉镜像走 ghcr.io 前缀；密码不进镜像，部署时靠环境变量注入。这两条今天自检清单里都有。

### 2. 排错速查表

流程走断了别乱试，按症状对号入座：

| 症状 | 第一现场 | 按这个顺序查 |
| --- | --- | --- |
| CI 红了 | Actions 页逐 step 看，展开红 X 的 step 读最后几十行 | 先分清挂在哪段：lint、test、build、push。lint 挂本地复现；build 挂看第一条 ERROR；压根没跑起来查 `on` 触发条件 |
| 镜像太大 | `docker images` 看 SIZE，`docker history <镜像>` 看哪层肥 | 十有八九没多阶段：查 runner 阶段是不是 `npm ci --omit=dev`，有没有把 builder 的 node_modules 整个拷过来；再查 .dockerignore 是否漏了 node_modules |
| 容器起不来 | `docker logs <容器名>`，一闪退的容器日志也在 | 日志有报错照着修；看不出名堂跑 `docker compose config` 打印解析后的最终配置，多半是 YAML 缩进或字段拼错 |
| 连不上 DB | 先问一句：连接的发起方在容器里还是在你电脑上 | 容器到容器（compose 内）：服务名 + 容器端口，写 localhost 必错；容器到宿主机：host.docker.internal（Linux 加 --add-host）；再不行查 PG 的 listen_addresses 和防火墙 |

这张表的正确用法：断在哪一站，先看该站第一现场，把信息收集够了再动手。跳过现场直接猜，是排错最大的时间黑洞。

### 3. 300 字周记模板

四段不变：最大收获、卡得最久、还含糊、下周前补，每段的定义见[第 1 周](/week01/) Day 7。第 7 周示例，照这个密度写：

```text
① 本周最大收获：镜像是分层攒出来的，Dockerfile 的指令顺序就是缓存
策略，变化慢的放前面，改一行代码才不用重装全部依赖。多阶段构建把
1.2GB 砍到 180MB，本质是让干活的人和上岗的人分家。
② 卡得最久：容器里连不上 PG，报 ECONNREFUSED，查了半天才发现连接
串里写的是 localhost，容器里的 localhost 指容器自己。换成服务名
postgres 一条命令就通。
③ 还含糊：buildx 的 cache-from/cache-to 照抄能跑，两种缓存模式差别
没吃透；GITHUB_TOKEN 的权限模型也是一知半解。
④ 下周前补：把 CI 日志 build 那段逐行读一遍，标出哪些层 CACHED、哪
些重跑，说得出为什么。
```

### 4. 第 7 周知识自检清单

规则照旧：每题先口头回答，说完整了再点开对照。说不出来的记下题号，回读对应 Day 的教程。

**问题 1：镜像和容器是什么关系？`docker run` 让它们发生了什么？（Day 1）**

::: details 答案
镜像是只读模板（类），容器是它的运行实例（实例）。docker run 从镜像创建容器：镜像不变，容器在只读层之上多一个可写层；容器删了可写层消失，镜像毫发无损，随时再起新容器。
:::

**问题 2：分层缓存为什么会因为 COPY 顺序不对而全失效？正确顺序是什么？（Day 1）**

::: details 答案
缓存失效向后传染：某层输入变了，它之后的层全部重做。依赖层的输入是 package.json 和 lockfile，源码层的输入是全部源码。`COPY . .` 写在 `npm ci` 前面，改一行代码就让源码层失效，依赖层排在后面跟着重做，每次构建都重装依赖。正确顺序：变化慢的先拷（lockfile、prisma schema），`COPY . .` 压轴。
:::

**问题 3：多阶段构建的收益从哪来？瘦掉的是什么？（Day 1）**

::: details 答案
单阶段把 devDependencies、npm 缓存、源码、编译器全带进镜像。多阶段让 builder 干活（装全部依赖、generate、编译），runner 上岗（只带生产依赖、dist、.prisma 生成物），中间产物随 builder 丢弃。本项目镜像从约 1.2GB 降到约 180MB，拉取快，攻击面也小。
:::

**问题 4：同一 compose 项目里 api 连 PG，主机名写什么？为什么？（Day 2）**

::: details 答案
写服务名 postgres。同一 compose 项目的服务共用默认网络，Docker 内置 DNS 把服务名解析到对应容器的 IP。写 localhost 指向 api 容器自己，它身上没有 5432 端口，连接立刻 ECONNREFUSED。
:::

**问题 5：healthcheck 是干嘛的？和裸 depends_on 差在哪？（Day 2）**

::: details 答案
启动不等于就绪，PG 容器起来还要 initdb、建库。healthcheck 让服务自己探测并报告状态（如 pg_isready），配合 `depends_on: condition: service_healthy`，api 等依赖真正就绪才创建。裸 depends_on 只保证启动顺序，竞态还在，start_period 再给慢初始化一段宽限期。
:::

**问题 6：Next.js 为什么用 standalone 输出？node_modules 整个拷进镜像不行吗？（Day 3）**

::: details 答案
standalone 是 next build 产出的一份自包含最小运行时：server.js 加运行所需的生产依赖，不含完整 node_modules 和构建工具链。整个拷几百 MB 是白背，容器里只需要 node 进程。镜像小、启动快，这是前端镜像能瘦下来的关键一步。
:::

**问题 7：Nginx 的 `try_files $uri $uri/ /index.html` 各段什么意思？去掉回退会怎样？（Day 3）**

::: details 答案
请求进来先按 $uri 找真实文件，再按 $uri/ 找目录，都找不到回退到 /index.html。去掉回退，用户刷新或直达前端路由的子路径时，Nginx 找不到对应文件直接 404；有了回退，所有未知路径都交回前端路由处理。
:::

**问题 8：GitHub Actions workflow 的核心字段有哪些？各管什么？（Day 4）**

::: details 答案
`on` 管什么时候触发（push、pull_request、手动）；`jobs` 管任务，每个 job 一台独立 runner，默认并行，用 needs 声明依赖改串行；`steps` 管 job 内的步骤，`uses` 引用现成 action（如 actions/checkout），`run` 执行命令。另有 runs-on 指定系统，name 是给人看的名字。
:::

**问题 9：GHCR 镜像名的完整格式是什么？有哪些硬性规定？（Day 5）**

::: details 答案
`ghcr.io/<owner>/<镜像名>:<tag>`。owner 是 GitHub 用户名或组织名，整个名字必须全小写，带大写直接 push 失败。tag 不写默认 latest，好习惯是 latest 和 commit sha 各打一个，拉取方才知道拉的是哪次构建。
:::

**问题 10：数据库密码为什么绝不能进镜像层？正确做法是什么？（Day 6）**

::: details 答案
镜像层只读且随镜像分发，推上 registry 后有权限的人都能拉，docker history、导出层文件都能把 ENV 烧进层的值翻出来。密码一旦进层，撤回只能删镜像换密码。正确做法：.dockerignore 排除 .env，镜像里只留非敏感默认值，密码在运行时用 env_file、-e 或 Secrets 注入。
:::

::: tip 10 题全对也别飘
全对说明本周零件都认识，不说明链条通。走流程、写文档、打 tag 三件事做完，本周才算收口。
:::

## 动手任务：走一遍，写下来

按顺序五步，预计 90 分钟。前提：Day 1 到 Day 6 的产出都在位，仓库 Secrets 已配好。

**第 1 步：从零走一遍完整流程（30 分钟）。** 改一处肉眼可见的代码，比如接口的一个返回文案。然后：

```bash
git add -A
git commit -m "chore: 复盘走查，验证完整流水线"
git push
```

push 完打开仓库 Actions 页，从这次运行开始逐 step 读日志：lint、test、build、push 一段不跳。build 段记下哪些层标 CACHED；push 段抄下 digest 和镜像 tag。最后本地验证改动真的进了镜像：

```bash
docker pull ghcr.io/<你的用户名>/<镜像名>:<sha标签>
docker run --rm -p 3000:3000 <拉下来的镜像>
```

访问一下，确认那处改动在。验证要拉 sha 标签，latest 是会漂移的指针，本地又有旧镜像缓存，拉它验证不算数。

**第 2 步：写流程文档（20 分钟）。** 把核心知识第 1 节的六站表格抄进笔记，占位符全部换成真实值：仓库名、workflow 文件名、镜像全名、分支名。第六站先空着。

**第 3 步：写 300 字周记（15 分钟）。** 四段模板，对照示例的密度。"还含糊"那段别敷衍，它是下周的补课清单。

**第 4 步：做自检清单（15 分钟）。** 10 题逐个口头回答，答不上来的记题号，回读对应 Day 的教程。

**第 5 步：git 提交整理（10 分钟）。** 先查一件本周特有的事，再收口：

```bash
# .env 必须被忽略，.env.example 必须在仓库里：
git check-ignore .env
git status

# 散落的改动分开提交：
git add .github
git commit -m "ci: 完善构建推送流水线"
git add docs
git commit -m "docs: 第 7 周流程文档与周记"

# 打标签收口：
git tag week07-done
```

## 常见踩坑

**流程文档照抄不填值。** 表格抄完就归档，镜像名还是 `<你的用户名>` 占位符。判断标准：把文档发给三个月后的自己，他不用翻仓库就能照着走。做不到，就是没填完。

**CI 绿了就算完。** 绿只代表通过，不代表你知道它干了什么。第一次走流程必须逐 step 读日志，重点是 build 段哪些层 CACHED。今天跳过这步，下次红了只能干瞪眼。

**用 latest 验证镜像。** latest 指向会变，本地还留着旧的同名镜像，你验证的未必是刚推的那次构建。sha 标签和 commit 一一对应，拉它验证才作数。

**周记只写收获不写含糊。** 第三段空着或写个"无"，等于宣布本周没有欠账，这几乎不可能为真。含糊清单就是下周的输入，藏着不写，亏的是自己。

## 延伸阅读

- [Workflow syntax for GitHub Actions](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions)：on / jobs / steps / needs 的权威定义，自检第 8 题的原始出处
- [Working with the Container registry](https://docs.github.com/en/packages/working-with-a-container-registry)：GHCR 镜像命名和 GITHUB_TOKEN 权限的官方说明，站⑤的细节都在这
- [Docker 构建缓存](https://docs.docker.com/build/cache/)：分层缓存机制与 buildx 缓存搬运，读懂站④为什么快、为什么慢
- 复盘方法论的四段周记、10 题自检，规矩定于[第 1 周](/week01/) Day 7，本周是这套模板的第七次使用

下周把第六站补上：找一台 Linux 服务器，把今天推上 GHCR 的镜像拉下来跑起来，那份流程文档就是部署手册。第 7 周到此收口。
