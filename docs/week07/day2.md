# 第 7 周 · Day 2：docker-compose 多服务编排——一条命令拉起全栈

> 对应手册任务：学习「docker-compose：多服务编排」，动手写 `docker-compose.yml` 编排 api + postgres + redis，当日产出「一键启动全栈」。本篇只解决一个问题：昨天你已经把 api 塞进了一个容器（见[第 7 周](/week07/) Day 1），今天要加数据库和缓存，总不能开三个终端手敲三条 `docker run`，而是把「有哪些服务、怎么连接、谁先谁后、健不健康」全部写进一份 YAML，交给一条命令。

## 今日目标

1. 说得清 compose 解决什么问题：一条命令起全家，外加声明式的网络、依赖顺序和健康检查
2. 掌握 `docker-compose.yml` 的 `services` 逐字段写法：`build` / `image` / `ports` / `environment` / `env_file` / `volumes` / `depends_on` / `healthcheck` / `restart`
3. 独立跑通全栈：`docker compose up -d` 之后 api 自动等 PG 就绪、自动跑迁移再启动，`docker compose down` 一条命令收摊

## 概念讲解：为什么需要 compose

先看没有 compose 的日子。昨天你的 api 容器跑通了，今天项目要连 PostgreSQL 和 Redis，于是手动操作变成了这样：

```bash
docker network create mynet

docker run -d --name pg --network mynet \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mydb \
  -v pgdata:/var/lib/postgresql/data postgres:16-alpine

docker run -d --name redis --network mynet redis:7-alpine

docker run -d --name api --network mynet \
  -e DATABASE_URL=postgresql://postgres:postgres@pg:5432/mydb \
  -p 3000:3000 my-api
```

四个命令还只是开始。真实的麻烦在后头：

1. 启动顺序没保证。api 起来时 PG 还在初始化，连库直接 `ECONNREFUSED`，api 崩了
2. 密码、端口、镜像版本散落在命令行参数里，昨天敲的命令今天想不起来
3. 想重启整套环境，得按相反顺序手动 stop、rm 一圈
4. 同事拿到你的项目，第一件事是问你「那个 redis 是带什么参数起的来着」

本质上，你缺的不是新容器，而是一份**可以提交进 git 的环境描述**：三个服务、一张网络、一个数据卷、谁依赖谁，全写成声明。compose 做的就是这件事。

```bash
docker compose up -d    # 起全家
docker compose down     # 收全家
```

写一份 `docker-compose.yml` 放在项目根目录，上面那串命令、那张网络、那个顺序问题，全部变成文件里的几十行配置。环境跟着代码走，谁拉下来谁就能一键起。

## 核心知识

本节的配置片段都属于最终那份 `docker-compose.yml`，动手任务里会完整拼出来。

### 1. services：一个字段一个意图

```yaml
services:
  api:
    build:
      context: .
      dockerfile: api.Dockerfile   # 昨天的产出，直接复用
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    env_file:
      - .env
    restart: unless-stopped
```

逐个字段过一遍，每个都有明确的分工：

- `build` vs `image`：二选一。`build` 说「这个服务用本地 Dockerfile 现场构建」，`image` 说「直接拉现成镜像」。api 用 `build`（复用昨天的 `api.Dockerfile`），postgres 和 redis 用 `image`
- `ports`：格式是 `"宿主机端口:容器端口"`。发布出去是给**你电脑上的**工具用的，比如用 DBeaver 连 PG、用浏览器访问 api
- `environment`：直接写死的环境变量，适合不敏感的配置
- `env_file`：从文件批量读入环境变量，密码、连接串这类东西放 `.env` 里，compose 文件保持干净
- `volumes`：挂载数据卷，PG 的数据全靠它活过容器重建（下面单独讲）
- `depends_on`：声明依赖顺序和就绪条件（下面单独讲）
- `restart`：容器挂了怎么办。`no`（默认，挂了就挂着）、`always`（永远拉起，包括你自己 stop 之后开机还会自启）、`unless-stopped`（挂了拉起，但你手动 stop 的就别动）、`on-failure`（只在非零退出码时拉起）。日常开发闭眼选 `unless-stopped`

另外两个顶层键：`volumes`（声明命名数据卷）和 `networks`（自定义网络）。网络基本不用写，compose 会自动给每个项目建一张默认网络，项目名做前缀，比如目录叫 `ai-agent-study`，网络就叫 `ai-agent-study_default`。这就够了。

还有个小知识：老教程开头都写 `version: "3.8"`，现在的 Compose V2 已经废弃这个字段，写了会警告，直接不写。

### 2. 容器名即 DNS：服务间怎么找到彼此

这是今天最重要的一个心智模型，值得单独一节。

先记住结论：**同一个 compose 项目里的服务，互相用服务名当主机名访问**。api 的数据库连接串里，主机写 `postgres`，不是 `localhost`：

```text
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/mydb?schema=public
                                        ↑
                              这个位置是服务名，不是 localhost
```

为什么能这样？因为容器有自己独立的网络栈。你启动一个容器，它就不是「跑在你电脑上的一个进程」那么简单，它有自己的 `localhost`。在 api 容器里敲 `localhost`，指向的是 api 容器自己，自己身上没有 5432 端口，连接必然失败。

而 compose 把三个服务放进同一张默认网络后，Docker 内置的 DNS 服务器会登记每个服务名。api 发起对 `postgres` 的连接，DNS 把它解析到 postgres 容器的内部 IP。这套机制下甚至不需要知道 IP 是什么，服务名就是地址。

端口这件事也要分两面看。假设 postgres 这样发布：

```yaml
ports:
  - "5433:5432"
```

容器之间互访走的是**容器端口 5432**，`5433` 这个宿主机端口跟你无关，它只服务于你电脑上的外部工具（本机已经装了 PG 占了 5432，所以对外换个 5433，避免打架）。一句话总结：**内部通信用服务名 + 容器端口，外部访问用 localhost + 宿主机端口**，两套地址别混。

### 3. depends_on + healthcheck：启动了不等于就绪了

postgres 容器「启动」和 postgres「可以接连接」是两回事。容器起来后还要跑 initdb、建库、建用户，这几秒里谁连谁死。裸的 `depends_on` 只保证启动顺序：

```yaml
# 只保证 postgres 先 start，不保证它 ready
depends_on:
  - postgres
```

api 照样可能在 PG 就绪前冲上去，撞个 `ECONNREFUSED`。正确写法是加上健康条件：

```yaml
depends_on:
  postgres:
    condition: service_healthy   # 等健康检查通过，而不只是等它启动
  redis:
    condition: service_healthy
```

`service_healthy` 依赖每个服务自己的 `healthcheck`，让服务自己报告「我行了」：

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U postgres -d mydb"]
  interval: 5s       # 每 5 秒探一次
  timeout: 3s        # 单次探测超过 3 秒算失败
  retries: 5         # 连续失败 5 次才标记 unhealthy
  start_period: 10s  # 启动后 10 秒内的失败不算数，给初始化留时间
```

postgres 官方镜像自带 `pg_isready`，Redis 更简单，`redis-cli ping` 返回 PONG 就是活的：

```yaml
healthcheck:
  test: ["CMD", "redis-cli", "ping"]
```

`CMD` 和 `CMD-SHELL` 的区别：`CMD` 直接执行不带 shell，`CMD-SHELL` 经过 shell，可以用变量拼接和管道。没有特殊需要时用 `CMD` 更干净。

这套机制组合起来，api 的启动流程就变成：postgres 就绪 → redis 就绪 → api 才创建。竞态从根上消除，而不是靠「崩了靠 restart 拉起来再赌一次」。

## 动手任务：docker-compose.yml 一步一步

手册任务：写 `docker-compose.yml` 编排 api + postgres + redis，做到一键启动。拆成 5 步，全程约 25 分钟。前提：昨天 Day 1 的 `api.Dockerfile` 还在项目根目录，项目里有 Prisma 的 `schema.prisma` 和迁移文件。

**第 1 步：建文件。** 项目根目录新建两个文件：`docker-compose.yml` 和 `.env`。`.env` 先填好，注意主机名的位置：

```text
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/mydb?schema=public
REDIS_URL=redis://redis:6379
PORT=3000
```

两处服务名 `postgres`、`redis` 就是稍后 compose 里的服务名，一字不差才能被 DNS 解析。另外现在就把 `.env` 加进 `.gitignore`，密钥文件不进仓库，第 6 天会专门讲怎么管密钥。

**第 2 步：写 postgres 和 redis 两个服务。** 往 `docker-compose.yml` 里写：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    ports:
      - "5433:5432"   # 宿主机 5433 → 容器 5432，避开本机已装的 PG
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d mydb"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped
```

`volumes` 里的 `pgdata` 是命名数据卷，把 PG 的数据目录挂出来。没有它，容器一删数据就没了；有了它，就算 `down` 掉再 `up`，表和数据都还在。文件末尾还要声明这个卷：

```yaml
volumes:
  pgdata:
```

**第 3 步：写 api 服务。** 在 `postgres`、`redis` 同层级再加一个服务：

```yaml
  api:
    build:
      context: .
      dockerfile: api.Dockerfile
    ports:
      - "3000:3000"
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: sh -c "npx prisma migrate deploy && node dist/main"
    restart: unless-stopped
```

两个新面孔。`env_file` 把第 1 步的 `.env` 整个灌进容器，`DATABASE_URL` 就位。`command` 覆盖镜像里的默认启动命令，先跑迁移再起服务：`prisma migrate deploy` 把 `prisma/migrations` 里攒的迁移按顺序打到库里，全部成功才 `&&` 到 `node dist/main`。迁移失败服务就不该起，这个顺序是业务正确性，不是仪式感。

`sh -c` 那层壳不能省：`&&` 是 shell 语法，compose 的 `command` 默认不经过 shell，不套壳的话 `&&` 会被当成参数原样传给 npx。另外这个写法有个前提：镜像里得装了 prisma CLI。昨天多阶段构建如果只拷了生产依赖，检查 prisma 是不是在 `dependencies` 里，或者把 CLI 一起装进运行阶段，否则 `npx` 会现场去下载，慢且不可复现。

::: details 完整文件对照
三个片段拼起来，最终 `docker-compose.yml` 长这样（yaml 对缩进敏感，抄的时候留意）：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: mydb
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d mydb"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  api:
    build:
      context: .
      dockerfile: api.Dockerfile
    ports:
      - "3000:3000"
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    command: sh -c "npx prisma migrate deploy && node dist/main"
    restart: unless-stopped

volumes:
  pgdata:
```

:::

**第 4 步：一键启动，逐层验证。** 在项目根目录执行：

```bash
docker compose up -d --build
```

`--build` 强制重新构建 api 镜像（昨天构建过一次，不加的话默认复用旧镜像）。然后按顺序验证三件事：

```bash
docker compose ps          # 看状态：postgres、redis 应显示 healthy
docker compose logs -f api # 盯日志：先看到 prisma 迁移输出，再看到 Nest 启动成功
docker compose exec postgres psql -U postgres -d mydb -c "\dt"
                           # 进 PG 列表：迁移建出来的表都在
```

最后浏览器或 curl 访问 `http://localhost:3000`，走一个真实请求。三服务编排，一条命令，这就是今天的产出。

**第 5 步：收摊，搞清删掉的是什么。** 关机不删环境用 `docker compose stop`，回来 `docker compose start`，数据卷原封不动。真正拆家用 `docker compose down`，它删容器、删网络，但**保留数据卷**，所以下次 `up` 数据还在。而 `docker compose down -v` 里的 `-v` 是 `--volumes`，连这个项目声明的命名卷一起删，**PG 里所有数据当场清零，不可恢复**。它不是危险参数，是「我知道我在干什么」参数：schema 改得一团糟想从零来过、或者换一套测试数据时，它会救你。但每次敲下去之前，问自己一句：库里有没有还想要的东西。

::: tip 命令小抄
新版命令是 `docker compose`（带空格，Docker CLI 插件），老教程里的 `docker-compose`（带连字符）是旧独立版，两者功能基本一致，推荐用新的。另外 `docker compose config` 可以打印解析变量后的最终配置，怀疑文件写错时先看它。
:::

## 常见踩坑

**坑 1：容器里的 localhost 不是你的电脑。** 连接串写 `localhost:5432` 报 `ECONNREFUSED`，九成是这个坑。每个容器有独立的网络栈，容器内的 localhost 指向容器自己。服务间通信一律用服务名。真有「容器里访问宿主机服务」的需求（比如连本机起的大模型），Docker Desktop 提供了特殊域名 `host.docker.internal`，但它只该出现在开发场景，生产里没有这回事。

**坑 2：改了代码不生效。** `docker compose up -d` 默认复用已有镜像，你改的代码根本没进容器。镜像是构建出来的产物，代码变了要加 `--build`：`docker compose up -d --build`。改了 `.env` 同理，拿不准就跑一次 `up -d`，Compose V2 能识别环境变化并重建对应容器，没重建就 `down` 再 `up`。

**坑 3：把宿主机端口当通信端口。** 宿主机用 5433 连 PG（映射 `5433:5432`），容器之间却必须连 `postgres:5432`。把 `5433` 写进 `DATABASE_URL` 是高频事故：要么连不上，要么莫名其妙连上了别的库。判断方法就一条：这条连接发起方在容器里还是在你电脑上？在容器里，用服务名 + 容器端口；在你电脑上，用 localhost + 宿主机端口。

**坑 4：healthcheck 探错目标。** `pg_isready` 不带 `-d` 时探测的是默认库，不带 `-U` 时用的是当前用户，都可能与实际初始化不符，探出来「健康」但 api 连不上。探测命令要和 `environment` 里配置的用户、库名一致。Redis 偶尔有人写 `curl localhost:6379`，Redis 不说 HTTP，`redis-cli ping` 才是正解。

**坑 5：`.env` 进了 git。** compose 文件可以开源，`.env` 不行，里面全是密码和连接串。仓库里放一份 `.env.example`，字段齐全、值全空，队友复制成 `.env` 自己填。写 `.gitignore` 的时机是第一次提交**之前**，文件进了历史再删就很费劲。第 6 天讲 CI 里的密钥注入，会接着用今天这份文件。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. api 容器里 `DATABASE_URL` 的主机名为什么写 `postgres`？写 `localhost` 会发生什么？

::: details 参考答案
同一 compose 项目的服务共用默认网络，Docker 内置 DNS 会把服务名解析到对应容器。写 `localhost` 指向 api 容器自己，它没有 5432 端口，连接立刻 `ECONNREFUSED`。
:::

2. 裸 `depends_on` 和 `condition: service_healthy` 差在哪？`start_period: 10s` 是干嘛的？

::: details 参考答案
裸 `depends_on` 只保证 postgres 容器先启动，不保证它初始化完成，api 可能撞上启动竞态。`service_healthy` 会等 healthcheck 通过才创建 api，把「启动顺序」升级成「就绪顺序」。`start_period` 给服务一段宽限期，这期间探测失败不计入 retries，专门容纳 initdb 这类慢初始化。
:::

3. `ports: "5433:5432"` 两个数字各管谁？api 连 PG 该用哪个？

::: details 参考答案
左边的 5433 是宿主机端口，给你电脑上的外部工具用；右边的 5432 是容器端口，服务间通信用。api 在容器里，所以连 `postgres:5432`，跟 5433 无关。
:::

4. `docker compose down` 和 `down -v` 分别删掉什么？什么时候该用 `-v`？

::: details 参考答案
`down` 删容器和项目网络，保留命名数据卷，PG 数据下次 `up` 还在。`down -v` 额外删除 compose 文件里声明的命名卷，数据永久清零。schema 乱到想从零重建、或要换一套干净测试数据时用 `-v`，用之前确认卷里没有还想要的数据。
:::

5. `command` 里的 `&&` 为什么必须包在 `sh -c "..."` 里？

::: details 参考答案
`&&` 是 shell 的语法，compose 的 `command` 默认不经过 shell 解析，直接写会被当成参数传给第一个命令。`sh -c` 显式起一个 shell 来解释整条链，保证「迁移成功才启动服务」的顺序成立。
:::

## 延伸阅读

- [Compose 文件参考](https://docs.docker.com/reference/compose-file/)，官方对 `services` 每个字段的权威说明，今天所有配置项的原始出处
- [Compose 网络机制](https://docs.docker.com/compose/how-tos/networking/)，服务名 DNS、默认网络、跨项目通信的官方解释，想搞懂容器网络模型看这篇
- [docker compose 命令行参考](https://docs.docker.com/reference/cli/docker-compose/)，`up` / `logs` / `exec` / `down` 全部子命令和参数，`down -v` 的行为定义就在这里

今天的 `docker-compose.yml` 留好，Day 3 给前端写完 Dockerfile 后，往 `services` 里加一个 `web` 服务就是完整四件套，Day 4 的 CI 构建的也是它。从今天起，你的项目环境开始跟着代码走。
