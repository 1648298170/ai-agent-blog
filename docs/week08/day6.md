# 第 8 周 · Day 6：健康检查与优雅关闭——让应用进退都有交代

> 对应手册任务：学习「健康检查 + 优雅关闭」，动手「实现 /health 端点，配置 NestJS 优雅关闭」，当日产出「健康检查端点」。本篇只解决一个问题：日志和指标告诉你应用「平时怎么样」，今天补上「此刻能不能接活」和「退场时怎么收尾」两个标准答案，让部署重启不再是一段听天由命的空窗。

## 今日目标

1. 说得清 liveness 和 readiness 各回答什么问题，为什么不能用一个 `/health` 包打天下
2. 用 `@nestjs/terminus` 装上 `/health/liveness` 与 `/health/readiness` 两个端点，后者真探数据库和 Redis
3. 打通优雅关闭全链路：SIGTERM → `enableShutdownHooks` → `onModuleDestroy` 清理资源，并把 compose 的 healthcheck 与 `stop_grace_period` 配齐

## 概念讲解：为什么需要健康检查与优雅关闭

先看一段熟悉的剧本。周四晚上你 push 代码，CI 跑完构建，SSH 到服务器执行 `docker compose up -d --build`。compose 发现 api 镜像变了，停旧容器，起新容器。十几秒后你顺手刷新线上页面，502。

把这几秒放大，同时发生两件事。旧容器里，请求走到一半：任务刚入库，正要写 Redis 缓存，进程收到信号直接退场，请求死在半路。新容器里，Node 两秒就起来，Prisma 连接池还没就绪，打进来的请求拿到的是报错。Nginx 不懂这些，它只认 `127.0.0.1:3000` 通不通。

两个根因对应今天的两个主题：没有标准接口回答「我现在能不能接活」，是健康检查的事；退场时没人给时间把手里的活干完，是优雅关闭的事。

第 7 周 Day 2 给 postgres、redis 配过 healthcheck，用 `service_healthy` 解决了「api 等依赖就绪」的竞态。当时留了尾巴：api 自己呢？今天把这个环闭上。

可观测性也补齐了：日志答「当时发生了什么」，指标答「趋势如何」，健康检查答「此刻行不行」。

## 核心知识

### 1. 两个端点，两种答案

健康检查最容易犯的错，是用一个 `/health` 回答所有问题。正确姿势是拆成两个，因为「进程活着」和「能接流量」是两个独立的事实。

进程活着但数据库断了：进程没病，重启纯属添乱，该做的是摘流量、等恢复。进程死锁了：数据库再健康也没用，该做的是重启进程。一个端点只有一个布尔值，两种情况挤在一起，总有一种被误伤。

| 端点 | 回答的问题 | 探什么 | 不健康时的正确动作 |
| --- | --- | --- | --- |
| `/health/liveness` | 进程还活着吗 | 只走一遍框架本身，不碰任何依赖 | 重启进程 |
| `/health/readiness` | 能接流量吗 | 数据库、Redis 等关键依赖 | 摘掉流量，不重启 |

K8s 还有第三个 startup probe，给慢启动应用一段「先别探我」的宽限期；单机用 `start_period` 达到同样效果，知道即可。

单机 compose 用不上 kubelet，这对端点照样有用：healthcheck 靠它判断容器状态，`up -d --wait` 靠它决定要不要继续等。以后上了 K8s，同一对端点原样填进 livenessProbe 和 readinessProbe，一行不用改。

### 2. Terminus：把健康检查写成声明

NestJS 官方的健康检查模块叫 Terminus，装上就能用：

```bash
npm install @nestjs/terminus
```

先建模块：

```ts
// src/health/health.module.ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [TerminusModule, PrismaModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}
```

再写控制器：

```ts
// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  RedisHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get('liveness')
  @HealthCheck()
  liveness() {
    // 能回答这个问题本身就是活着的证明，什么都不用探
    return this.health.check([]);
  }

  @Get('readiness')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => this.prismaIndicator.pingCheck('database', this.prisma),
      async () => this.redisIndicator.pingCheck('redis', this.redis.client),
    ]);
  }
}
```

关键在 `this.health.check([...])` 的形状：每个指示器是一个函数，Terminus 依次执行、统一打包，数据库发 `SELECT 1`，Redis 发 `PING`，不用你手写。注意注入的是 PrismaService 和 ioredis 客户端，两个模块必须导出这两个 provider；v9 及更早版本里 redis 指示器的参数是 `{ type: 'redis', client }` 对象，新版直接传客户端。

两个端点的返回长这样：

```jsonc
// 依赖都正常：GET /health/readiness → 200
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  },
  "error": {},
  "details": { "database": { "status": "up" }, "redis": { "status": "up" } }
}

// redis 挂了：GET /health/readiness → 503
{
  "status": "error",
  "error": { "redis": { "status": "down", "message": "Connection is closed." } },
  "details": { "database": { "status": "up" }, "redis": { "status": "down" } }
}
```

全绿 200，任何一项挂掉就是 503。调用方只看状态码，想深挖再读 body。

### 3. compose healthcheck：把第 7 周的环闭上

第 7 周给 postgres 写过 `pg_isready` 的 healthcheck，今天 api 用同样格式，探测命令换成打自己的 readiness：

```yaml
# docker-compose.yml 的 api 服务
api:
  build: ./server
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/health/readiness"]
    interval: 15s
    timeout: 3s
    retries: 3
    start_period: 20s   # 给连接池初始化留宽限，呼应第 7 周的慢启动
```

关键在探的是 readiness 不是 liveness：容器健康应该反映「能不能干活」，数据库没连上就该报不健康；`curl -f` 在 503 时返回非零，正好当失败信号。

两个细节。一，`node:20-slim` 镜像里没有 curl，healthcheck 会永远失败，Dockerfile 里补一行 `RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*`，或者用 Node 18+ 自带的 fetch，零依赖：

```yaml
test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

二，探测要克制：`interval` 别设 1s，每探一次都是真打一发数据库查询；`/health` 也别透到公网。

配好后收益立等可取：`docker compose up -d --wait` 会等到 api 变 healthy 才返回，CI 再也不会「启动成功、实际半死」地绿灯放行。

### 4. 优雅关闭：从 SIGTERM 到干净的退出

`docker stop` 不是一刀毙命。它先给容器主进程发 SIGTERM，等一段宽限期（默认 10 秒），进程还没退才补一刀 SIGKILL。优雅关闭的全部内容，就是回答「这 10 秒里干什么」。

应用侧要做的只有一件事：让 NestJS 接住信号并执行钩子。

```ts
// src/main.ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); // 没有这行，下面的钩子一个都不会跑
await app.listen(3000);
```

开了之后，停机流程变成：HTTP 不再收新请求，在途请求处理完；`onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown` 三个钩子依次触发；全部结束进程退出。清场代码写在第一个钩子里就够：

```ts
// src/redis/redis.service.ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis({ host: process.env.REDIS_HOST });

  async onModuleDestroy() {
    // quit() 发完剩余命令再握手告别；disconnect() 是立刻硬断，别用错
    await this.client.quit();
  }
}
```

```ts
// src/report/report.worker.ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';

@Injectable()
export class ReportWorker implements OnModuleDestroy {
  private readonly worker = new Worker('report', async (job) => {
    /* 生成报表，一个 job 可能要跑几十秒 */
  });

  async onModuleDestroy() {
    // 不再取新 job，等正在跑的 job 做完才返回
    await this.worker.close();
  }
}
```

关键在 `worker.close()`：BullMQ 的 worker 关闭不是立刻断线，而是停止拉取新任务、等在途任务跑完。没有它，SIGKILL 会把跑到一半的 job 直接腰斩，队列里留下悬案。

应用外还要配宽限期，job 要跑 30 秒，默认 10 秒等不完：

```yaml
api:
  stop_grace_period: 30s   # docker stop 愿意等的时间，要盖过最长的在途任务
```

串起来，完整时序是：

```
docker stop api
  → SIGTERM
  → Nest：停止收新请求，在途请求收尾
  → onModuleDestroy：worker.close() 等在途 job、redis.quit()
  → 进程正常退出（退出码 0）
→ 30 秒内没退完才 SIGKILL（退出码 137）
```

诚实说一句：单机上旧容器停、新容器 healthy 之间仍有几秒空窗，彻底消灭要靠先启新再停旧或蓝绿发布。今天做到的是两件确定的事：旧进程干完在途的活再走，新进程没就绪前不被误判。上了 K8s 再补最后一块：Pod 被删时摘流量和发信号几乎同时发生，配个 `preStop` 钩子 sleep 几秒，给摘流量留时间。

## 动手任务：健康检查端点一步一步

手册任务：实现 `/health` 端点，配置 NestJS 优雅关闭。拆成 5 步，全程约 30 分钟。

**第 1 步：装依赖，搭骨架。** `npm install @nestjs/terminus`，按第 2 节建 `src/health/` 两个文件，HealthModule 加进 AppModule 的 imports。readiness 两个指示器先注释，`curl -i http://localhost:3000/health/liveness` 应看到 200。

**第 2 步：接上依赖，亲眼看一次 503。** 放开两个指示器。报「Can't resolve dependencies」就把 PrismaModule、RedisModule 加进 imports，并确认它们导出了服务。两个端点都 200 后，做今天最值钱的对照实验：

```bash
docker compose stop redis   # 掐掉依赖
curl -i http://localhost:3000/health/liveness   # 仍然 200：进程没死
curl -i http://localhost:3000/health/readiness  # 变成 503：不能接活了
docker compose start redis  # 恢复后 readiness 自己变回 200
```

进程在、依赖不可用，一分钟内被清清楚楚区分开。

**第 3 步：开停机钩子。** main.ts 加 `app.enableShutdownHooks()`，给 RedisService 和报表 worker 补上 `onModuleDestroy`（照抄第 4 节）。Ctrl+C 触发一次，日志应出现 `Nest application successfully shut down`。

**第 4 步：compose 配齐。** 给 api 加 healthcheck 和 `stop_grace_period: 30s`（镜像没 curl 先补装），`docker compose up -d --wait` 拉起，用 `docker inspect api --format '{{json .State.Health.Status}}'` 看它从 starting 变 healthy。

**第 5 步：演练一次完整退场。** `docker compose stop api`，同时盯日志：onModuleDestroy 的输出在前，优雅关机日志在后，最后查退出码：

```bash
docker inspect api --format '{{.State.ExitCode}}'
# 0 = 自己干干净净退出的；137 = 被 SIGKILL 补了刀，回去查哪步没配对
```

::: tip 验证清单
`curl -i` 两个端点、`stop redis` 做依赖故障演练、`--wait` 等健康、`stop api` 看退出码。四件事全部符合预期，健康检查和优雅关闭就算落地了。
:::

## 常见踩坑

**坑 1：liveness 里塞依赖检查，引发重启风暴。** 把数据库探活写进 liveness，数据库抖 10 秒，所有实例同时变红被挨个重启，依赖故障升级成全站故障。记住分工：liveness 只证明「我还能回答 HTTP」，依赖一律放 readiness。

**坑 2：healthcheck 打错镜像的软肋。** `node:20-slim` 里没有 curl，healthcheck 永远失败，容器永远 unhealthy，`--wait` 永远等不到。要么在 Dockerfile 里装 curl，要么用 node fetch 探针，别跟镜像较劲。

**坑 3：以为 unhealthy 会自动重启。** 单机 Docker 的 `restart` 策略不看健康状态，unhealthy 只是打个标签，没人管。想让健康状态参与决策，要么部署脚本用 `--wait` 让它显式失败，要么交给 K8s。

**坑 4：宽限期盖不住最长的在途任务。** job 要跑 30 秒，`stop_grace_period` 还是默认 10 秒，SIGKILL 照样腰斩，优雅关闭配了个寂寞。取值标准是「最慢的在途任务要多久」。反过来，钩子跑完了进程却迟迟不退，八成是 Nginx 的 keep-alive 空闲连接挂着，Node 19+ 可在停机时调 `httpServer.closeIdleConnections()` 收掉。

**坑 5：SIGTERM 根本没到 node 手里。** 配置全对，`docker stop` 却总以 137 收场？先看谁在当 PID 1。ENTRYPOINT 用 shell 形式（`ENTRYPOINT node dist/main.js`）时 PID 1 是 `/bin/sh`，默认不向子进程转发信号；`npm start` 当入口也有同样的老毛病。用 exec 形式 `ENTRYPOINT ["node", "dist/main.js"]`，或配 tini。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. liveness 和 readiness 各回答什么问题？各自的失败对应的正确动作是什么？

::: details 参考答案
liveness 回答「进程还活着吗」，只探自身，失败时重启进程；readiness 回答「能不能接流量」，探依赖，失败时摘流量不重启。反过来用：依赖抖动引发重启风暴，或进程已死还在接请求。
:::

2. 为什么 liveness 里不该 ping 数据库？误配之后的连锁反应是什么？

::: details 参考答案
数据库故障时进程本身健康，重启解决不了问题，只会丢掉在途请求和本地状态。连锁反应：所有实例 liveness 同时变红、全部被重启，重启完数据库还是坏的，再红再重启。
:::

3. `docker stop api` 之后 Docker 具体做了什么？默认等多久？`stop_grace_period` 改的是哪一段？

::: details 参考答案
先向容器主进程发 SIGTERM，等宽限期（默认 10 秒），进程未退出再发 SIGKILL 强杀。`stop_grace_period` 改的就是这段宽限期，取值要盖过最长的在途任务。
:::

4. 忘了 `app.enableShutdownHooks()`，`onModuleDestroy` 还会执行吗？

::: details 参考答案
收到 SIGTERM 时不会。不开钩子，NestJS 对停机信号不做响应，进程被直接终止，钩子一次都不跑；只有代码里显式调 `app.close()`（如测试里）才执行。「本地正常、线上丢数据」的悬案，十有八九是这行没加。
:::

5. 优雅关闭全配对了，`docker stop` 却每次都以 137 退出码收场，先检查什么？

::: details 参考答案
先看容器的 PID 1 是谁。ENTRYPOINT 用了 shell 形式或 `npm start` 当入口，SIGTERM 就停在 `/bin/sh` 或 npm 那层，到不了 node。改成 exec 形式 `ENTRYPOINT ["node", "dist/main.js"]`，或加 tini。
:::

## 延伸阅读

- [NestJS Terminus 官方文档](https://docs.nestjs.com/recipes/terminus)，健康检查的原始出处，全部指示器清单在此
- [docker stop 命令文档](https://docs.docker.com/engine/reference/commandline/stop/)，信号与宽限期的权威说明，`-t` 就是 compose 的 `stop_grace_period`
- [Kubernetes 容器生命周期钩子](https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/)，preStop 的官方解释

今天补上了可观测性的「此刻行不行」和退场的规矩，明天 Day 7 阶段二里程碑验收，把认证、Redis、Docker、CI/CD、部署、监控、健康检查连成整条链路过一遍。卡壳的回[本周日程](/week08/)对照自查。
