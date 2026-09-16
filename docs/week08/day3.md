# 第 8 周 · Day 3：CD 第二步——push 之后，服务器自己换新

> 对应手册任务：学习「部署全栈应用到云服务器」，动手「用 GitHub Actions 的 SSH 步骤自动部署到云服务器」，当日产出「自动部署链路」。本篇只解决一个问题：镜像在仓库里、服务器在跑、HTTPS 正门也挂好了，可每次上线仍要你手动 SSH 进服务器敲一遍 pull 和重启。今天把最后这段手活也交给流水线，让 git push 成为上线的全部动作。

## 今日目标

1. 说得清部署策略怎么选：单机规模为什么 SSH 拉镜像重启就够，k8s 要到什么规模才值得上
2. 掌握四个配置点：服务器侧的 `compose.prod.yml` 与首次手动部署、Actions 加 deploy job（`needs` 衔接构建）、`appleboy/ssh-action@v1` 三要素全走 Secrets、部署专用密钥的生成与保管
3. 独立打通整条链路：本地改一行代码 push，Actions 自动构建推送镜像、SSH 到服务器换新容器、健康检查通过，全程你的手不碰键盘

## 概念讲解：为什么需要自动部署

先盘家底。第 7 周 Day 5 把 api 和 web 两个镜像推进了 GHCR，[第 8 周](/week08/) Day 1 有了装好 Docker 的服务器，Day 2 给它配上了 Nginx 和 HTTPS。现在每次上线长这样：push 代码，等 Actions 构建推送镜像，然后你打开终端，`ssh` 登录服务器，`cd /opt/app`，`docker compose pull`，`docker compose up -d`，浏览器打开域名验证。六个动作里五个已经自动化了，剩下这一个恰恰每次都要做。

手动上线有三个毛病。第一，慢，五到十分钟是它，赶上网络抖动半小时也是它，而这几分钟里你做的全是重复劳动。第二，靠记忆，哪天忘了 `pull` 直接 `up -d`，或者忘了验证就关窗口，没有任何东西拦你。第三，没记录，晚上十一点十七分线上跑的到底是哪个 commit，只有服务器的 shell history 知道，出问题时你翻不出来。

CD 的 D 是 Deployment。第 7 周 Day 5 只做了这个 D 的前半段：产物进了仓库。今天补后半段：push 之后，流水线替你 SSH 进服务器，把你手敲的那几条命令原样敲一遍。命令一条没变，敲命令的从人换成了机器，这就是自动部署的全部。链路补完之后：

```
git push → Actions 构建 + 推送镜像到 GHCR（已有）
                │
        deploy job：SSH 到服务器（今天新增）
                ↓
   改写 IMAGE_TAG → pull → up -d → 健康检查
```

注意凭证的方向：不是服务器去连 GitHub，而是 GitHub Actions 拿着一把「服务器钥匙」进来。所以真正的准备工作只有一件——把这把钥匙安全地交给流水线。怎么个安全法，正是今天的重头。

## 核心知识

### 1. 部署策略：为什么不上 k8s

一说「自动部署」，资料动辄就上 Kubernetes。先看这两个东西在解决什么：

| | SSH + Compose | Kubernetes |
|---|---|---|
| 适合规模 | 一台机器、几个服务 | 多台机器、几十个服务 |
| 上手成本 | 半小时 | 以周计 |
| 覆盖能力 | 拉镜像、重启、健康检查、回滚 | 自愈、滚动更新、服务发现、自动扩缩 |
| 运维负担 | 管一台服务器 | 控制面、etcd、版本升级全要管 |

你的现状是一台 2C2G 的服务器、两个容器。k8s 的那些能力一个都兑现不了，代价却要全额支付。判断标准很朴素：什么时候一台机器扛不住、或者服务多到 compose 文件管不动，什么时候再谈。手册把 k8s 编排在第 21 周之后，不是它不重要，是它在单机阶段的收益为负。今天选 SSH 方案，配置点个位数，半小时跑通，回滚也顺手。

### 2. 服务器侧：让「换新」只差一个变量

服务器上已经有 Compose 在跑应用了（Day 1、Day 2 的成果）。今天做两处整理。第一处，镜像地址换成 GHCR 的正式地址，并把 tag 从写死改成变量：

```yaml
# /opt/app/compose.prod.yml
services:
  api:
    image: ghcr.io/<owner>/agent-api:${IMAGE_TAG:-latest}
    ports:
      - "127.0.0.1:3000:3000"
    env_file: .env
    restart: unless-stopped

  web:
    image: ghcr.io/<owner>/agent-web:${IMAGE_TAG:-latest}
    ports:
      - "127.0.0.1:8080:80"
    env_file: .env
    restart: unless-stopped
```

关键在 `${IMAGE_TAG:-latest}`：镜像 tag 不再写死，由 `.env` 里的 `IMAGE_TAG` 决定，没设时兜底 latest。Compose 会自动读项目目录下的 `.env` 做这个替换。第二处，给 `.env` 补一行。这个文件昨天就有，装着第 7 周 Day 6 请出代码的那些运行时密钥，今天只加一行：

```bash
# /opt/app/.env 末尾追加
IMAGE_TAG=latest
```

为什么坚持按变量走而不是统一用 latest：第 7 周 Day 5 讲过，latest 是可变标签，拿它部署等于放弃回答「线上跑的是哪份代码」。让流水线每次把本次 commit 的 sha 写进这一行，线上版本从此精确到 commit，回滚也有据可查。这个机制下面的部署脚本会兑现。

如果镜像是私有的，服务器要先登录一次 GHCR 才拉得动，密码用只带 `read:packages` 权限的 PAT（第 7 周 Day 6 的最小权限原则）：

```bash
echo "<PAT>" | docker login ghcr.io -u <github用户名> --password-stdin
```

登录凭证落在服务器的 `~/.docker/config.json`，一次即可。公开镜像跳过这步。

### 3. Actions 侧：deploy job 与三个 Secrets

在第 7 周 Day 5 写的 `docker.yml` 里加一个 job，让它排在构建之后：

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: SSH 部署到云服务器
        uses: appleboy/ssh-action@v1
        env:
          IMAGE_TAG: ${{ github.sha }}
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          envs: IMAGE_TAG
          script: |
            set -e
            cd /opt/app
            sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$IMAGE_TAG/" .env
            docker compose -f compose.prod.yml pull
            docker compose -f compose.prod.yml up -d --remove-orphans
            docker image prune -f
            for i in $(seq 1 10); do
              if curl -fsS http://127.0.0.1:3000/api/health > /dev/null 2>&1; then
                echo "health 检查通过，部署完成"
                exit 0
              fi
              sleep 3
            done
            echo "health 检查失败，当前容器状态："
            docker compose -f compose.prod.yml ps
            exit 1
```

四个要点。`needs: build` 把部署排在构建 job 后面，镜像没推成功就不部署，这个 id 要和你 docker.yml 里已有的构建 job 对上（Day 5 的示例里叫 build）。`appleboy/ssh-action@v1` 干的事就一件：用你给的私钥 SSH 到 host，把 script 原样在服务器上执行，`uses` 那行下面的全是它的参数。`host`、`username`、`key` 三个值全部来自 Secrets，呼应第 7 周 Day 6 的铁律：workflow 文件进 git，长期凭证绝不能出现在里面，只活在平台 Secrets 里、注入发生在运行时。`envs: IMAGE_TAG` 是传变量的桥：step 里 `env` 块定义的变量经它带进远程 shell，脚本里的 `$IMAGE_TAG` 才有值。

### 4. 部署专用密钥，而不是你的个人私钥

`SERVER_SSH_KEY` 这个 Secret 里放的私钥，强烈建议专门生成一把，别把你登录用的那把个人私钥塞进去。理由有三。可吊销：哪天怀疑泄漏，从服务器 `authorized_keys` 删掉那行、重生成一把就完事，你的个人 key 不受牵连。影响面小：这把钥匙只开这一台服务器这一个账号，而个人私钥能开你所有的机器。可追溯：key 的注释里写明用途，一年后翻服务器看到它，你不用猜它是干嘛的。

生成和安装两步，在本地机器上执行：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/deploy_key -N "" -C "github-actions-deploy"
ssh-copy-id -i ~/.ssh/deploy_key.pub <user>@<server-ip>
ssh -i ~/.ssh/deploy_key <user>@<server-ip> "echo ok"
```

空密码短语（`-N ""`）是必须的：Actions 没法替你回答交互式提问。安全靠的是上面说的「影响面小、可吊销」兜底，而不是密码短语。最后那条 `echo ok` 打出 ok，再把 `~/.ssh/deploy_key` 的完整内容（从 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END OPENSSH PRIVATE KEY-----`，一行不能少）粘进 Secret `SERVER_SSH_KEY`。

### 5. 脚本四连与回滚

部署脚本每一行都有分工：`sed` 把本次 commit 的 sha 写进 `.env`，线上版本从此有据可查；`pull` 只拉变化的镜像层，没变的服务秒过；`up -d --remove-orphans` 只重建镜像变了的服务，顺带清掉 compose 文件里已删掉的服务；`prune -f` 回收换新产生的悬空层，磁盘不慢性泄漏。最后那段 for 循环是唯一从「用户视角」做的检查：容器起来不等于应用活着，curl 连续重试十次都失败就打印容器状态并以 `exit 1` 收场，让 Actions 页面亮红灯。开头那行 `set -e` 不是装饰，坑 5 专门讲它救的是什么事。另外，curl 的路径按你的实际情况换：现在还没有专门的健康检查路由，就先指到任意一个轻量 GET 接口（比如根路径），Day 6 会实现正式的 `/health`，到时改回来。

回滚的底气来自第 7 周 Day 5 的 tag 策略：每个 sha 都是不可变标签，registry 里永远躺着那份构建好的镜像。线上出问题，最快的处置是回镜像而不是改代码：

```bash
ssh <user>@<server-ip>
cd /opt/app
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<上一次上线的sha>/' .env
docker compose -f compose.prod.yml pull && docker compose -f compose.prod.yml up -d
```

全程不经过构建，耗时约等于一次 pull。`git revert` 再 push 当然也能上线修复，但那要走完构建整条链路，几分钟起步。紧急止血用镜像回滚，事后修根因再用 push。

## 动手任务：打通自动部署链路一步一步

手册任务：用 GitHub Actions 的 SSH 步骤自动部署到云服务器。拆成 5 步，全程约 40 分钟。

**第 1 步：整理服务器侧。** SSH 登服务器，把 `/opt/app/compose.prod.yml` 换成上面带 `${IMAGE_TAG:-latest}` 的版本，`.env` 末尾追加 `IMAGE_TAG=latest`，私有镜像按第 2 节登录 GHCR。然后做首次手动部署，这一步既是验收服务器侧配置，也是给自动部署留下一个「已知能跑」的起点：

```bash
cd /opt/app
docker compose -f compose.prod.yml pull
docker compose -f compose.prod.yml up -d
curl -I http://127.0.0.1:3000
```

curl 能通，服务器侧就绪。

**第 2 步：生成部署专用密钥。** 按第 4 节的三条命令做：生成、`ssh-copy-id` 上服务器、`echo ok` 验证。ok 没打出来之前不要进下一步。

**第 3 步：配三个 Secrets。** 仓库 Settings → Secrets and variables → Actions → New repository secret，逐个添加：`SERVER_HOST` 填服务器 IP，`SERVER_USER` 填登录用户（Day 1 用的那个），`SERVER_SSH_KEY` 粘 `deploy_key` 私钥文件的完整内容，首尾的 BEGIN/END 行都要。

**第 4 步：给 docker.yml 加 deploy job。** 把第 3 节的 deploy job 追加到 workflow，`needs` 指向你文件里真实的构建 job id。顺手在 workflow 顶级加一组并发控制：

```yaml
concurrency:
  group: deploy
  cancel-in-progress: true
```

连续 push 时，后一次会取消还在跑的前一次流水线，防止两个部署同时在服务器上 `up -d` 打架。

::: tip 触发分支
这份 docker.yml 只在 push 到 main 时触发（第 7 周 Day 5 的设定），所以「push 即上线」严格说是「合到 main 即上线」。功能分支只跑构建不碰服务器，这个默认行为正好是想要的。
:::

**第 5 步：改一行代码，验收全链路。** 给 api 随便加一行能在线上看到的改动（改个接口返回值就行），commit、push。打开 Actions 页：构建 job 绿了之后 deploy job 自动开跑，ssh 步骤的日志里能看到 pull 的层、容器的重建、最后那句「health 检查通过」。再打开 `https://your.domain`，看到你的新改动。整条链路里你没碰过服务器，这就是当日产出「自动部署链路」。

## 常见踩坑

**坑 1：私钥粘贴不完整。** `SERVER_SSH_KEY` 必须是整个私钥文件，从 `-----BEGIN OPENSSH PRIVATE KEY-----` 到 `-----END OPENSSH PRIVATE KEY-----` 一行不少。用编辑器复制时首尾行最容易丢，症状是 deploy job 报 invalid private key。用 `cat ~/.ssh/deploy_key` 原样输出再复制，比手动框选稳。

**坑 2：needs 指错了 job。** `needs` 认的是 job 的 id（`jobs:` 下面那层键名），不是 `name:` 显示名。写错了 workflow 直接解析失败，报 `needs job 'xxx' which is not defined`。回头数一下缩进：deploy 和 build 平级，都缩进在 `jobs:` 下两层。

**坑 3：.env 里没有 IMAGE_TAG 那行。** `sed` 找不到匹配行时不报错也不改，静默成功。现象很迷惑：deploy job 全绿，但 `docker ps` 里跑的还是旧镜像，因为 compose 兜底用了 latest，恰好也是旧的。上服务器 `grep IMAGE_TAG .env` 一查便知。第 1 步先把这行写进去，就是为了让 sed 永远有得改。

**坑 4：磁盘越滚越满。** 每次 push 一个新 sha 镜像，几百 MB 一个。`docker image prune -f` 只清悬空层，带 sha 标签的旧镜像一个不少全留着。磁盘报警时用 `docker image prune -af` 一次清光所有未使用镜像，放心清——回滚靠的是 registry 里永远躺着的 sha tag，本地删了照样拉得回来。

**坑 5：部署失败，job 却是绿的。** `appleboy/ssh-action` 默认不中断执行：script 里某条命令失败，后面的照跑，最后一条命令成功整个 step 就算成功。curl 挂了流水线还打绿勾，等于健康检查白做。脚本开头 `set -e`（第一条失败即停）加失败分支显式 `exit 1`，红线才真正可靠。验证方法：故意把 curl 的端口写错 push 一次，看 job 变不变红，验完改回来。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 单机两三个服务的规模，为什么 SSH 拉镜像重启就够？什么信号出现才值得考虑 k8s？

::: details 参考答案
SSH 方案配置点个位数、半小时跑通，拉镜像、重启、健康检查、回滚全覆盖；k8s 解决的是多机调度、自愈、扩缩，单机上这些收益兑现不了，控制面的运维成本却要全额支付。信号：一台机器扛不住要横向扩、服务数量多到 compose 难维护、需要滚动更新零停机。在那之前，简单就是优势。
:::

2. deploy job 的 host、username、key 为什么必须走 Secrets？这呼应第 7 周 Day 6 的什么原则？

::: details 参考答案
workflow 文件进 git，对仓库有读权限的人都看得见，私有仓库也有被拖库的一天。服务器 IP 加登录私钥是长期凭证，写明文等于钥匙插在门上。原则就是「密钥走 Secrets」：代码走 git，密钥走平台加密保管，注入只发生在 job 运行时，日志里还会自动打码，三层保险各管一段。
:::

3. 为什么用部署专用密钥，而不是把你个人的 SSH 私钥放进 Secrets？

::: details 参考答案
三点：可单独吊销，泄漏时删掉 authorized_keys 里那行、重新生成即可，个人 key 不受牵连；影响面小，它只开这一台服务器这一个账号，个人私钥能开你所有机器；用途可追溯，注释里写明 github-actions-deploy，日后排查不会猜。空密码短语是因为 Actions 无法回答交互提问，安全性靠影响面小和可吊销兜底。
:::

4. 部署脚本里 pull、`up -d --remove-orphans`、prune、curl 四步各自负责什么？哪一步是「用户视角」的检查？

::: details 参考答案
pull 把新镜像层拉到本地，未变的层秒过；up -d 只重建镜像变了的服务，--remove-orphans 顺带清掉 compose 里已删除的服务；prune 回收悬空层防止磁盘慢性泄漏；curl 是从外部验证应用真的在响应，前三个全成功也不代表应用活着，它是唯一代表用户利益的检查，失败必须让 job 变红。
:::

5. 线上出 bug 要立刻回滚，具体敲什么？为什么比 `git revert` 再走一遍流水线快？

::: details 参考答案
SSH 进服务器，把 `.env` 里的 IMAGE_TAG 改回上一次上线的 sha，然后 `docker compose -f compose.prod.yml pull && up -d`。sha 是不可变标签，那份镜像在 registry 里永远躺着，拉下来就能跑，全程不经过构建。revert 要重新走构建、推送、部署整条链路，分钟级起步。紧急止血回镜像，事后修根因再 push。
:::

## 延伸阅读

- [appleboy/ssh-action](https://github.com/appleboy/ssh-action)，今天的主角，README 把 host、key、envs、script_stop 每个参数都讲了一遍，值得通读
- [GitHub 文档：在 Actions 中使用 Secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)，仓库级与环境级 Secrets、日志掩码的官方说明
- [Docker 文档：Compose 环境变量](https://docs.docker.com/compose/environment-variables/)，`${IMAGE_TAG:-latest}` 这类插值和 `.env` 文件的读取规则
- [Docker 文档：docker image prune](https://docs.docker.com/reference/cli/docker/image/prune/)，`-f` 和 `-af` 的区别，坑 4 的原始出处

今天打通之后，push 就是上线，第 7 周开始的 CI/CD 在这里闭环。明天 Day 4 开始补「跑起来之后看得见」的部分：pino 结构化日志。链路卡壳的回[本周日程](/week08/)，把 Day 1 的服务器环境和 Day 2 的 Nginx 入口对照检查一遍。
