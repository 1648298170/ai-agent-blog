# 第 7 周 · Day 1：Docker 基础——镜像、容器与多阶段 Dockerfile

> 对应手册任务：学习「Docker 基础：镜像、容器、Dockerfile」，动手「为 NestJS 写一个多阶段 Dockerfile，构建并运行」，当日产出 `api.Dockerfile`。本篇只解决一个问题：让 api 服务在任何装了 Docker 的机器上一条命令跑起来，不挑系统、不重复装依赖，镜像还要从约 1.2GB 瘦到约 180MB。

## 今日目标

1. 说得清镜像和容器的关系（类与实例），以及分层缓存为什么能让「改一行代码」不触发「重装全部依赖」
2. 掌握六个高频指令的语义：`FROM`、`COPY`、`RUN`、`CMD`、`EXPOSE`、`ENV`，学会按「文件变化频率」给指令排序
3. 独立写出多阶段的 `api.Dockerfile`，构建出约 180MB 的镜像，在容器里连上宿主机 PostgreSQL 跑通接口

## 概念讲解：为什么需要 Docker

前六周，api 在你本机跑得好好的：Node 22、PostgreSQL、Redis 全装在宿主机上，`npm run start:dev` 一敲就起。这周开始要交付，麻烦来了。换台机器，Node 得重装、版本得对齐，PG 和 Redis 得重配；哪天上 Linux 服务器装依赖，某个原生模块当场编译失败。你经历过的「在我机器上能跑」，本质是应用的依赖散落在机器各处，换个环境就对不上号。

Docker 的思路简单直接：把「应用 + 运行时 + 依赖」整体打成一份镜像。镜像走到哪，行为就一致到哪，连 Node 本身都在镜像里带着，宿主机唯一的要求是装了 Docker。

理解 Docker，抓一对概念就够：镜像和容器。镜像是只读模板，容器是它的运行实例，就是类与实例的关系。`docker images` 列出本机所有的类，`docker run` 从某个类 new 出一个实例，`docker ps` 列出正在跑的实例。一个镜像可以同时起 N 个容器，各自持有独立的可写层，容器删了可写层消失，镜像毫发无损。

第二个关键是分层。镜像不是一整块文件，是一叠只读层，Dockerfile 里每条 `COPY`、`RUN` 都会产出一层。构建时 Docker 逐条比对：指令没变、输入文件也没变，就直接复用上次的结果，输出里标 `CACHED`；任何一层失效，排在它后面的层全部重做。这解释了一个新手困惑：为什么有人改一行代码重新构建要等五分钟，有人十秒完事。差别不在 Docker 的快慢，在 Dockerfile 的指令顺序。今天动手部分就围着这条转。

## 核心知识

本节命令在 PowerShell 里可以直接照敲；Dockerfile 一律以 api 项目根目录（package.json 所在目录）为构建上下文。

### 1. 六个指令的语义与排序原则

| 指令 | 语义 | 备注 |
| ---- | ---- | ---- |
| `FROM` | 指定基础镜像，一切的起点 | `node:22-alpine`：Node 22 + 精简 Alpine Linux，底座约 160MB |
| `COPY` | 把构建上下文的文件拷进镜像 | 输入文件的校验和参与缓存判断 |
| `RUN` | 构建时执行命令，结果固化成一层 | `npm ci`、`npm run build` 都在此刻跑 |
| `CMD` | 容器启动时执行的默认命令 | 构建期不执行，写多条时只有最后一条生效 |
| `EXPOSE` | 声明容器监听的端口 | 纯文档，真正开端口靠 `docker run -p` |
| `ENV` | 写入镜像的环境变量 | 运行时可读，`docker run -e` 能覆盖 |

最容易混的是 `RUN` 和 `CMD`：`RUN` 在 `docker build` 时执行，产物固化进镜像；`CMD` 到 `docker run` 那一刻才执行，构建期它只是一句声明。`ENV` 是配置入口，今天连数据库的 `DATABASE_URL` 就靠 `-e` 注入覆盖。另外你会见到 `WORKDIR /app`，它只负责把工作目录定到 `/app`，让后面的 COPY 和 CMD 都用相对路径。

指令排序的最佳实践一句话讲完：按文件变化频率从慢到快排。依赖清单几周不变，schema 偶尔变，源码一天变几十次，顺序就该是 lockfile → schema → 源码。这样改代码时，前面的层全部命中缓存，重跑的只有源码层和它之后的构建步骤。

### 2. 多阶段构建：builder 与 runner 分家

先看单阶段的下场：一个阶段干完所有事，装全部依赖（含 TypeScript 这些 devDependencies）、编译、起服务。镜像里于是躺着完整 node_modules、npm 缓存、原始源码、编译器，而运行时真正需要的只有 dist 和生产依赖。`docker images` 一看，约 1.2GB。

多阶段构建让「干活的人」和「上岗的人」分家：builder 阶段装全部依赖、生成 Prisma Client、跑 tsc；runner 阶段从同一个 `node:22-alpine` 出发，只带生产依赖和 dist。最终镜像约 180MB，砍掉 85%，中间产物随 builder 一起丢弃。

NestJS + Prisma 项目的关键是 `prisma generate` 的位置：它在 builder 里执行，排在 `npm ci` 之后、`npm run build` 之前。它生成的引擎文件落在 `node_modules/.prisma/client`，而 runner 里 `npm ci --omit=dev` 装出来的是「干净」的生产依赖，不含这份生成产物，所以要从 builder 拷回来。漏了这步，构建照样成功，容器一启动就报 PrismaClient 未初始化。

### 3. .dockerignore：构建上下文的闸门

`docker build` 会把上下文目录整个发给守护进程，不拦就是照单全收。`.dockerignore` 就是闸门，今天的最小配置四行：

```text
node_modules
dist
.git
.env
```

理由对应着来：node_modules 几百 MB，且里面的二进制是 Windows 下装的，进了 Linux 容器就是废品；dist 是构建产物，镜像里会重新生成；.env 是密钥，烙进镜像等于把密码随身发布。

## 动手任务：`api.Dockerfile` 一步一步

手册任务：为 NestJS 的 api 写多阶段 Dockerfile，构建并运行。拆成 5 步，全程约 30 分钟（不含第一次 npm ci 的下载时间）。以下命令全部在 PowerShell 执行。

**第 1 步：写 .dockerignore。** 在 api 项目根目录新建 `.dockerignore`，内容照核心知识第 3 节那四行。先关闸门再构建，顺序别反。

**第 2 步：写 builder 阶段。** 同目录新建 `api.Dockerfile`，先来上半段：

```dockerfile
# ---------- 阶段一 builder：装依赖 + 构建 ----------
FROM node:22-alpine AS builder
WORKDIR /app

# 变化最慢的先拷：依赖清单
COPY package*.json ./
RUN npm ci

# 次慢的：prisma schema，generate 依赖它
COPY prisma ./prisma
RUN npx prisma generate

# 变化最快的最后拷：源码
COPY . .
RUN npm run build
```

关键在顺序：`COPY . .` 压轴，改源码时上面四层的输入都没变，`npm ci` 和 `prisma generate` 直接命中缓存。另外 builder 阶段故意不设 `NODE_ENV=production`，否则 npm ci 会跳过 devDependencies，TypeScript 缺席，构建当场失败。

**第 3 步：写 runner 阶段。** 往同一个文件追加：

```dockerfile
# ---------- 阶段二 runner：只带产物 + 生产依赖 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

# Prisma Client 是 generate 出来的，prod 安装里没有，从 builder 带回
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/main.js"]
```

关键有三处。第二段 `FROM` 是重新洗牌，builder 的东西不主动拿就不会进来；`npm ci --omit=dev` 重装一份纯生产依赖，比整包拷 builder 的 node_modules 小得多；`CMD` 用 JSON 数组写法（exec form），信号能直达 node 进程，`docker stop` 时 NestJS 才有机会优雅退出。两个特例提前说：schema.prisma 配了自定义 output 的，`.prisma` 那行改成拷自定义目录；启动时想跑 `prisma migrate deploy` 的，把 prisma 目录也拷进 runner。

**第 4 步：构建并运行，连宿主机 PG。** 在 api 目录执行：

```powershell
docker build -t ai-agent-api -f api.Dockerfile .
```

第一次要几分钟。跑完起容器（连接串换成你本机 PG 的实际账号密码）：

```powershell
docker run --rm --name api -p 3000:3000 -e "DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/aiagent" ai-agent-api
```

重点讲 `host.docker.internal`。容器有独立的网络栈，容器里的 localhost 指容器自己，连接串里写 `localhost:5432` 等于在连一个不存在的 PG。Windows 和 Mac 上 Docker 跑在虚拟机里，Docker Desktop 专门提供了 host.docker.internal 这个域名，解析出来就是宿主机；你原来的 DATABASE_URL 里如果是 127.0.0.1，只换这一处就行。Linux 没有这层虚拟机，要额外加 `--add-host=host.docker.internal:host-gateway`。Redis 同理，`-e "REDIS_URL=redis://host.docker.internal:6379"` 一起传进去。`-p 3000:3000` 的意思是「宿主机端口:容器端口」，本机 3000 被占就写 `-p 3001:3000`。

**第 5 步：验证接口、缓存和体积。** 另开一个 PowerShell 窗口：

```powershell
docker ps
docker images ai-agent-api
Invoke-WebRequest -UseBasicParsing http://localhost:3000
```

`docker ps` 里 api 状态是 Up，接口有响应（换成你现成的任意 GET 路由），`docker images` 的 SIZE 一列落在 180MB 上下。最后验证缓存：改一行 src 里的代码保存，重新执行第 4 步的 build 命令，盯着输出，`npm ci`、`prisma generate` 那几行应该都是 `CACHED`，只有源码拷贝和编译重跑，十几秒收工。验证完 `docker stop api` 收摊。

::: tip 排查容器问题
容器一闪退，先看日志：`docker logs api`。报错带 PrismaClient 回看坑 5，报 ECONNREFUSED 回看坑 4。另外本机 PG 默认可能只监听 127.0.0.1，容器从外部连不上时，检查 postgresql.conf 的 listen_addresses 并放开 pg_hba.conf。
:::

## 常见踩坑

**坑 1：不写 .dockerignore 就构建。** `COPY . .` 会把宿主机的 node_modules 原样拷进镜像，几百 MB 的体积只是小事，里面那些 Windows 二进制进了 Linux 容器全是废品，报错形态千奇百怪。判断方法：构建输出里出现 node_modules 的传输进度，说明闸门没关。

**坑 2：`COPY . .` 写在依赖安装前面。** 源码层校验和一变，排在它后面的 `npm ci` 跟着失效，每次构建都全量重装依赖，改一行代码等五分钟。回看核心知识第 1 节的排序原则：变化慢的在前，变化快的在后。

**坑 3：把 EXPOSE 当成开了端口。** EXPOSE 是写给人和工具看的声明，真正把端口映射到宿主机的是 `-p` 参数。只写 EXPOSE 不写 -p，浏览器里就是拒绝连接。两个一起用才有意义，读 Dockerfile 的人一眼知道容器监听什么。

**坑 4：容器里连不上宿主机 PG。** localhost 在容器里指向容器自身，这条路天生不通。Windows/Mac 换 host.docker.internal，Linux 加 --add-host。连不上还分两种报错：connection refused 多半是 PG 没监听外部地址，timeout 多半是防火墙拦了，先分清再动手。

**坑 5：prisma generate 时机或位置不对。** 放在 npm ci 之前，@prisma/client 还没装，命令直接失败；只在 builder 里跑、runner 忘了带 .prisma，构建成功但容器启动即抛「PrismaClient did not initialize yet」。记忆点：generate 的产物是生成文件，装依赖不会凭空生出它，哪个阶段要用，哪个阶段就得备好。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 镜像和容器是什么关系？`docker run` 分别让它们发生了什么？

::: details 参考答案
镜像是只读模板（类），容器是运行实例（实例）。docker run 从镜像创建一个容器：镜像本身不变，容器在只读层之上多一个可写层；容器删除后可写层消失，镜像还在，随时能再起新容器。
:::

2. 为什么 `COPY package*.json` 必须排在 `COPY . .` 前面？反过来会怎样？

::: details 参考答案
缓存失效会向后传染：某层变了，它之后的层全部重做。依赖层的输入是 package.json 和 lockfile，源码层的输入是全部源码。清单在前，改源码时依赖层命中缓存；源码在前，改一行代码就让源码层失效，依赖层排在其后跟着重做，等于每次构建都重装依赖。
:::

3. `RUN` 和 `CMD` 都表示执行命令，本质差别在哪？

::: details 参考答案
RUN 在 docker build 期间执行，结果固化成镜像层；CMD 构建期不执行，只在容器启动时作为默认命令运行，且一个 Dockerfile 里写多条 CMD 只有最后一条生效。
:::

4. runner 阶段为什么要重新 `npm ci --omit=dev`，而不是把 builder 的 node_modules 整个拷过来？

::: details 参考答案
builder 的 node_modules 含全部 devDependencies，整包拷等于白瘦身。生产模式重装只保留运行时依赖，配合 dist 和 .prisma 生成物，镜像从约 1.2GB 降到约 180MB。代价是构建期多装一次依赖，换来镜像更小、攻击面更小。
:::

5. 容器里的应用用 `localhost:5432` 连宿主机 PG 为什么必败？正确做法是什么？

::: details 参考答案
容器有独立的网络命名空间，localhost 指容器自己，它的 5432 上没有 PG。Windows/Mac 上 Docker Desktop 提供 host.docker.internal 域名指向宿主机，连接串替换 host 即可；Linux 上要加 --add-host=host.docker.internal:host-gateway。若仍连不上，检查宿主机 PG 的 listen_addresses 是否只监听了回环地址。
:::

## 延伸阅读

- [Dockerfile Reference](https://docs.docker.com/engine/reference/builder/)，官方指令手册，本篇六个指令的原始出处，CMD 和 EXPOSE 的边角语义都在这里
- [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)，多阶段构建官方教程，含按阶段裁剪依赖的进阶写法
- [Prisma 部署指南：Docker](https://www.prisma.io/docs/orm/prisma-client/deployment/docker)，prisma generate 在镜像里怎么摆，官方给出的参考答案

今天的 `api.Dockerfile` 留好。明天写 docker-compose.yml，把 api、web、PostgreSQL、Redis 一并拉起，到时候 `DATABASE_URL` 也不用再绕宿主机一圈了。
