# 第 8 周 · Day 7：阶段二里程碑验收，全链路一遍过

> 对应手册任务：学习「阶段二里程碑验收 + 周复盘」，动手「确认：认证 + Redis + Docker + CI/CD + 云部署 + 监控全链路」，当日产出「里程碑项目 v2 + 周记」。本篇只解决一个问题：四周搭起来的东西，怎么证明它真的在公网上活着，而不是"我记得搭过"。

## 今日目标

1. 按六项验收清单把全链路跑一遍，每项用命令拿回一个可判定的结果
2. 不达标的按排查表先定位再修复，修完重跑该项，直到全绿
3. 画架构图 v2、写 STAR 里程碑记录、写四段周记，给阶段二收口

## 概念讲解：为什么验收必须跑全链路

先说一个这四周反复出现的事实：每个环节单独都会，串起来照样断。第 5 周的登录接口本地测得好好的，第 8 周挂到 Nginx 后面照样可能 401，原因是服务器时钟偏差，或者转发时少了哪个 header；镜像推上 GHCR 了，服务器 `compose up -d` 一跑还是旧版本，因为它压根没拉新镜像。单点能力和链路能力之间隔着一整张排查表，里程碑验收验的是后者。

再说判定标准。第 1 周 Day 7 讲过识别和提取的区别，今天换个说法：**"我感觉好了"和"命令说好了"的区别**。眼睛扫一眼 Actions 页面是绿的、Grafana 面板有东西在动，这叫感觉。curl 返回 200、jq 解出 token、ab 报告 Non-2xx responses: 0，这叫证据。证据的特征是可复跑：把命令发给任何一个人，他在自己终端里敲下去，能得到同样的判定。

所以今天所有验收项长一个样：**一条命令，一个期望输出，通过或不通过，没有中间态**。六项全过，阶段二才算收口；有一项不过，它就是你下一阶段的补课清单。

## 核心知识

### 1. 六项验收清单

约定：命令默认在服务器的 bash 里跑（`ssh myserver`），需要 jq 和 ab，先装上：

```bash
sudo apt install -y jq apache2-utils
```

把 `your.domain` 换成你的域名，接口路径以你的实现为准。

**验收 1：HTTPS 域名访问全站**

```bash
curl -I http://your.domain
# 期望：301，Location 指向 https

curl -I https://your.domain
# 期望：200

curl -sv https://your.domain/api/health 2>&1 | grep -E 'subject|expire'
# 期望：subject: CN=your.domain，expire date 在未来
```

三条分别判定：明文流量被重定向、加密流量通、证书是真的且没过期。浏览器地址栏有锁只算肉眼复核，判定以命令为准。

**验收 2：登录拿 token，访问受保护接口**

```bash
TOKEN=$(curl -s -X POST https://your.domain/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"你的密码"}' \
  | jq -r .accessToken)
echo $TOKEN   # 应该是一串 eyJ 开头的字符，字段名按你的实现改

curl -s -o /dev/null -w '%{http_code}\n' https://your.domain/api/users/me
# 期望：401（没带 token，Guard 在干活）

curl -s https://your.domain/api/users/me -H "Authorization: Bearer $TOKEN"
# 期望：200，返回当前用户信息
```

401 那条别省，它证明接口真的被保护着，而不是"忘了加 Guard 恰好也能访问"。两个加分项一起验掉：用普通 user 角色的 token 调一个 admin 接口，期望 403，RBAC 齐了；连续拉两次带缓存的列表接口，第二次明显变快，或 `docker exec redis redis-cli keys '*'`（容器名按你的改）能看到缓存键，第 6 周的缓存也算过了。学习环境里 KEYS 随便敲，生产里别这么干。

**验收 3：重复请求被幂等拦截**

```bash
curl -s -X POST https://your.domain/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: milestone-001' \
  -d '{"sku":"T-001","quantity":1}' -w '\nHTTP %{http_code}\n'

# 同一条命令原样再跑一遍
```

判定：两次拿到同一个订单号（重放），或第二次返回 409（拒绝），取决于你第 6 周 Day 6 的实现，两者都算过；第二次创建出了新订单，不过。再用数据库钉死（表名、库名按你的改）：

```bash
docker exec postgres psql -U postgres -d 你的库 \
  -c "select count(*) from orders where idempotency_key = 'milestone-001';"
# 期望：1
```

**验收 4：push 一次，Actions 全绿，服务器自动更新**

```powershell
# 本地 PowerShell
git commit --allow-empty -m "chore: stage2 milestone acceptance"
git push
gh run watch    # 装了 GitHub CLI 并登录过的话，终端里盯这次 run
```

Actions 全绿只是前半段，判定标准在后半段：服务器上的容器真的换了。等部署步骤跑完，上服务器看：

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.RunningFor}}'
# 期望：api 容器的 uptime 是 minutes 前，不是 days 前
```

再顺手在页面上确认一个本次提交改过的功能点。全绿但线上没变，是最常见的假通过，排查表第 2 条专门治它。

**验收 5：Grafana 有 QPS 和 P95 曲线**

```bash
ab -n 3000 -c 50 https://your.domain/api/health
```

压测跑着的时候打开 Grafana：QPS 面板曲线应该抬起来，压完落回去；P95 面板应该有一条有数值的线。曲线对压测有反应才算过。一条死平线说明数据没进来，去排查表第 3 条。

**验收 6：压测下重启 api，无 502**

这道题有个前置要说破：api 只有一个实例时，它停下来就没人接流量，502 是必然。所以这不是 bug，是这道题的考点：先加第二个实例。compose 里照抄 api 加一份，绑到 3001，Nginx 的 upstream 加一行：

```yaml
# docker-compose.yml 追加，环境变量和卷照抄 api
  api2:
    image: 你的api镜像:latest
    ports:
      - "127.0.0.1:3001:3000"
```

```nginx
upstream api {
    server 127.0.0.1:3000;
    server 127.0.0.1:3001;   # 新增这行
}
```

```bash
docker compose up -d api2
sudo nginx -t && sudo systemctl reload nginx
```

然后两个窗口配合：

```bash
# 窗口 A：持续压 60 秒
ab -t 60 -c 20 https://your.domain/api/health

# 窗口 B：压测进行时，停掉一个实例再拉起来
docker compose stop api
docker compose start api
```

判定看窗口 A 的汇总：`Non-2xx responses: 0`。`Failed requests` 若非 0，看它后面的分解，只有 Length 一项的话是响应体长度每次不同（比如 /health 带时间戳），无害。原理两半：本周 Day 6 的优雅关闭让被停实例把手头请求处理完；Nginx 发现一台连接拒绝，自动把请求转给 upstream 里活着的那台。注意探针用 GET 的 /health，POST 默认不会被 Nginx 重试，拿下单接口当探针会误报。

::: tip 六项跑完留一份底
把每条命令和实际输出贴进 `docs/week08/acceptance.md`。这份带命令和输出的记录就是 milestone v2 的验收报告，STAR 的 R 段直接从这里取数。
:::

### 2. 不达标排查表

| 症状 | 第一步查什么 | 常见原因和修法 |
| --- | --- | --- |
| https 打不开或证书警告 | `sudo certbot renew --dry-run`；`systemctl list-timers \| grep certbot`；`sudo nginx -t` | 证书没续上：80 端口被安全组收回了，续期验证过不去，放行 80 再 dry-run；Nginx 配置有语法错，回 Day 2 检查 sites-enabled |
| Actions 全绿，线上还是旧版本 | `docker ps` 看容器 uptime | `docker compose up -d` 发现本地已有同名镜像就直接用，不拉新的。部署脚本先 `docker compose pull` 再 `up -d`，或写 `docker compose up -d --pull always` |
| Grafana 面板没数据 | Prometheus 页面 Status → Targets，或 `curl -s http://127.0.0.1:9090/api/v1/targets \| jq '.data.activeTargets[] \| {scrapeUrl, health}'` | target 状态 down：prometheus.yml 的抓取地址写错（写了容器名，但 Prometheus 跑在宿主机上，得用 127.0.0.1:3000）；api 容器没起，/metrics 没人应答 |
| 带 token 也 401 | `timedatectl` 看服务器时钟 | 系统时间偏差大，JWT 的 exp 校验直接判过期。`sudo timedatectl set-ntp true` 开同步 |
| 压测一重启就 502 | upstream 里是不是只有一个 server | 单实例没有备份可切。回验收 6 的前置，把第二个实例加上 |

用法原则：先定位，再动手。每一行都是"症状、一条定位命令、修法"，别跳过中间那条直接重启全家桶。重启能把症状盖住，盖不住病因。

### 3. 架构图 v2：在 v1 上加四类线

第 1 周 Day 7 画过 v1：三个包节点、一条 workspace:* 依赖边。v2 不是推倒重来，是在 v1 上做加法，真实项目的架构图也是这么长的。先看全貌：

```text
用户 --https--> Nginx(443) --http--> api ×2 --> PostgreSQL
                        |                |----> Redis
                        |--http--> web
GitHub 仓库 --push--> Actions --构建推送--> GHCR
                        |
                        +--SSH 触发--> 服务器：docker compose pull <--拉镜像-- GHCR
Prometheus --抓取 /metrics--> api          Grafana --查询--> Prometheus
```

凭记忆画的时候照这份清单走：

```text
保留（v1 原有）：
  apps/web、packages/shared 节点和 workspace:* 依赖边
  pnpm / turbo / tsc 三处职责标注

新增节点（按位置摆）：
  用户：最左边
  Nginx：紧挨用户，443，全图唯一对外端口
  api ×2、web 容器；PostgreSQL、Redis 两个存储
  GitHub 仓库、Actions、GHCR：一条 CI 流，画在上方
  Prometheus、Grafana：画在下方

新增边（v2 的重点，四类）：
  入口线：用户 → Nginx 标 https；Nginx → api / web 标 http
  部署线：Actions → GHCR 标 push 镜像；Actions → 服务器标 SSH 触发；服务器 → GHCR 标 compose pull
  拉取线：Prometheus → api 标 /metrics，箭头从 Prometheus 出发，方向别画反
  查询线：Grafana → Prometheus 标 PromQL

标注（至少 3 处）：
  Nginx 旁：证书 90 天，certbot.timer 自动续
  api 旁：优雅关闭 + /health + /metrics
  GHCR 旁：镜像 tag 与 git commit 对应
```

v1 的边和 v2 的边性质不一样，画之前必须想明白：v1 的边是依赖关系，v2 的边大多是数据流向。尤其 Prometheus 那条线，数据从 api 流向 Prometheus，但动作发起方是 Prometheus，是拉不是推，箭头方向才画得对。

检验标准和第 1 周一样朴素：拿给没见过这个项目的人，30 秒内他能答出两件事，一个 https 请求从浏览器到 PostgreSQL 要经过几站，一次 push 之后镜像怎么走到服务器。答不出来说明主干淹在细节里，删枝叶。

### 4. STAR 记录：里程碑 v2

四周的产出要变成一段能复用的经历，用 STAR 四段。每段逼出一样东西：S（情境）逼你交代背景和约束，T（任务）逼你说清目标怎么量化，A（行动）逼你讲做了什么，R（结果）逼你拿证据说话。A 段最容易写成流水账，解药是每份 STAR 至少含一个决策：比较过什么，选了什么，代价是什么。

milestone v2 示例，重点看 A 段里"为什么单机 SSH 部署而不是 k8s"那段：

```text
S：四周前项目只在本地能跑：接口没认证，数据裸奔，部署方式是手动敲命令。
T：四周内把它变成公网可用的生产形态，验收标准六条：HTTPS、认证、幂等、
push 即部署、监控曲线、重启无 502。约束：一台 2C2G 云服务器，课余时间。
A：按周推进：第 5 周 JWT + RBAC；第 6 周 Redis 缓存、分布式锁、BullMQ、
幂等键；第 7 周 Dockerfile、compose、Actions 构建推送 GHCR；第 8 周 Nginx
+ HTTPS + SSH 自动部署 + Prometheus/Grafana。
关键决策：部署方案在 k8s 和单机 compose 之间选了后者。理由三条：2C2G
扛不住 k8s 控制面的固定开销；这个项目规模一个 compose 文件管得住；镜像、
声明式编排、健康检查这些概念不随平台变，先在单机上把它们学扎实。代价：
没有自愈和自动扩缩容，机器挂了服务就挂，记为已知技术债，迁移触发条件
是流量或可用性要求超过单机。
R：六项验收第一次挂一项（压测重启 502），加第二个实例后全部通过；push
到线上更新约 3 分钟；能对着 Grafana 说出当前 QPS 和 P95 的量级。
```

为什么把 k8s 的取舍写进去：面试官问部署经历，想听的从来不是"我用了什么"，而是"你为什么没用别的"。单机 compose 是这个约束下的正确答案，讲清楚它不丢人，还显得清醒。答不出代价和触发条件，这个决策就白做了。

### 5. 周记四段式

模板和[第 1 周复盘](/week01/)相同：收获、卡点、含糊、补课，300 字上下。第 8 周示例：

```text
① 本周最大收获：部署不是把程序拷到服务器，是一条链：代码到镜像到仓库
到拉取到编排到入口再到观测，每一环都有对应的验收命令。学会了用命令证
明，不再用"我感觉好了"骗自己。
② 卡得最久：压测下重启 api 满屏 502，一度怀疑 Nginx 坏了。后来才懂单实
例停下来就是没人接流量，加第二个实例、upstream 加一行才归零。想通一件
事：高可用不是重启快，是停一台还有一台。
③ 还含糊：PromQL 只会抄面板上的查询，自己写不出来；BullMQ 的重试和延
迟任务当时跑通就翻篇了，现在讲不全。
④ 下一阶段前补：把 Grafana 面板里每条查询语句逐条读懂；重跑第 6 周
Day 5 的重试任务，脱稿讲一遍 job 的状态流转。
```

## 动手任务：验收、修复、收口

预计 2 到 3 小时。验收和修复的时间不可预估，一项修不完很正常，哪天修完哪天补 tag，一样算数。

**第一步：跑六项验收（约 40 分钟）。** 按核心知识第 1 节逐项跑，每项记三样东西：命令、实际输出、通过与否。全过的项也留记录，凑齐了就是验收报告。

**第二步：修不达标项。** 对着排查表先定位再动手，修完把该项验收完整重跑。注意项与项有联动：验收 6 加的 api2，会让验收 4 的部署步骤多一个服务要拉起。

**第三步：画架构图 v2（20 分钟）。** 关掉教程，凭记忆按第 3 节清单画，卡住翻 Day 1 到 Day 6 确认，合上继续。导出 PNG 命名 `week08-topology.png`，和第 1 周的 v1 放一起，两张图并排看，八周的增量一目了然。

**第四步：写 STAR 记录（20 分钟）。** 按第 4 节示例的密度写自己的版本，A 段必须含至少一个带代价的决策。写完通读一遍，把"使用了""学习了"这类词全删，留下的才是动作。

**第五步：写周记（15 分钟）。** 四段式，300 字，对照第 5 节示例的密度。第三段"还含糊"写不出来，回重跑一遍验收，哪个项答得磕巴，它就是。

**第六步：git 收口。** 验收报告、架构图、STAR、周记分类型提交，打阶段标签：

```bash
git add docs && git commit -m "docs(week08): 阶段二验收报告与周记"
git tag stage2-done
git push origin stage2-done
```

push 这个 tag 会触发一次完整流水线，正好把验收 4 再过一遍。

## 常见踩坑

**验收变演示。** 只测顺利路径：登录成功、下单成功、面板打得开。401、重复请求、压测中重启这些找茬项全跳过。演示证明能跑通，验收证明边界在哪，里程碑要的是后者。

**排查靠重启。** 症状一出，docker restart、systemctl restart 三连。重启能把不少问题暂时盖住，比如连接池满了、内存漏了，病因还在，过几天照犯。排查表每行中间那条定位命令就是防这个的。

**压测把自己服务器打挂。** 2C2G 的机器，并发 50 已经够看曲线了，拉到几百并发，压测本身成了故障源，数据库连接池先爆，观察到的数据全失真。压测的目的是让曲线有形状，不是把服务打死。

**架构图 v2 画成拓扑大全。** DNS、防火墙、安全组全画上去，图变成部署说明书。主干检验就一条：30 秒说清一个请求的完整路径和一次部署的完整路径，说不清就删。

**STAR 写成课程表。** "第 5 周学了 JWT，第 6 周学了 Redis"，这是目录不是经历。没有决策、代价、量化结果的 STAR，面试时撑不过第二个追问。

## 延伸阅读

- [Prometheus HTTP API：targets 端点](https://prometheus.io/docs/prometheus/latest/querying/api/#targets)，排查表第 3 条那行 curl 的官方说明
- [docker compose up 官方文档](https://docs.docker.com/reference/cli/docker/compose/up/)，`--pull` 参数的行为，排查表第 2 条的依据
- [Nginx：proxy_next_upstream](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_next_upstream)，验收 6 里"连接拒绝自动换下一台"的机制出处
- [gh run watch](https://cli.github.com/manual/gh_run_watch)，在终端里盯 Actions run 的官方命令

阶段二到此收口：一台自己的服务器，一条 push 就能走完的部署链路，一套看得见 QPS 和 P95 的面板。验收报告和两张架构图存好，它们是这两个月最硬的证据。卡壳的回[本周日程](/week08/)对照 Day 1 到 Day 6 自查。
