# 第 8 周 · Day 4：结构化日志——让每条日志都变得可查询

> 对应手册任务：学习「日志：结构化日志 + 日志收集」，动手「用 pino 输出 JSON 日志，配置 Nginx access log」，当日产出「结构化日志」。本篇只解决一个问题：应用上线后出了事，别再靠肉眼一行行扫日志，而是把每条日志变成带 level、time、reqId 字段的 JSON，让「查一次请求的全部日志」变成一条过滤命令的事。

## 今日目标

1. 说得清结构化日志解决什么问题，以及它和文本日志的本质区别
2. 掌握三个要点：用 pino 实现 LoggerService 适配器替换 NestJS 默认日志、用 AsyncLocalStorage 让 reqId 贯穿一次请求、定好级别规范并给敏感字段脱敏
3. 独立完成当日产出：应用日志全量 JSON 化且同请求共享 reqId，Nginx access log 换成 JSON 格式，容器日志配好轮转

## 概念讲解：为什么需要结构化日志

应用上线第三天，用户群里有人说「下单一直转圈」。你登进服务器，`docker logs` 拉出来的是这样的东西：

```text
2026-09-16 10:32:11 INFO  [OrdersController] 用户 42 下单失败: timeout
2026-09-16 10:32:12 INFO  [AuthController] 用户 43 登录成功
2026-09-16 10:32:12 WARN  [HttpClient] 重试第 1 次
2026-09-16 10:32:13 INFO  [OrdersController] 用户 42 下单失败: timeout
```

你想知道三件事：用户 42 这十分钟失败了几次？失败时上游耗时多少？这几条日志里哪些属于同一次请求？文本日志只有一个答案：正则加肉眼，一条条对。日志量到每天几百万行时，这条路就死了。

结构化日志的每行是一个 JSON 对象：

```json
{"level":30,"time":1763337131000,"reqId":"8f3a2c","userId":42,"route":"POST /orders","cost":3005,"err":"timeout","msg":"下单失败"}
```

level、time 是机器友好的字段，业务数据平铺在顶层。刚才的三个问题分别变成：过滤 `userId == 42` 数行数、取 `cost` 字段求平均、过滤 `reqId == "8f3a2c"`。查询、统计、聚合，从写正则变成按字段取值。

本质区别就一条：文本日志是写给人读的散文，结构化日志是写给机器读的记录。应用上线后，日志的第一读者是 grep、jq 和将来的日志系统，人排在它们后面。这是可观测性三大支柱里日志这一柱的地基，先把它打正。

## 核心知识

### 1. pino 与 NestLogger 适配器

pino 是 Node 生态里最快的 JSON 日志库，快的原因很朴素：它只做序列化，格式化留给读取端。基础用法两条约定：对象在前，消息在后；level 决定哪些日志真的输出。

```ts
import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
});

logger.info({ userId: 42, action: 'login' }, '登录成功');
// {"level":30,"time":1763337131000,"userId":42,"action":"login","msg":"登录成功"}
```

pino 的六个级别从小到大：trace(10)、debug(20)、info(30)、warn(40)、error(50)、fatal(60)。`level: 'info'` 的意思是 info 及以上才输出，debug 和 trace 直接丢掉。

NestJS 自带的 Logger 输出彩色文本，好在对症下药：框架留了 LoggerService 接口，实现它再 `useLogger` 注入，框架日志和业务日志就都走 pino，业务代码一行不用改：

```ts
// nest-logger.ts
import { LoggerService } from '@nestjs/common';
import pino from 'pino';
import { requestALS } from './request-context';

export class NestLogger implements LoggerService {
  private logger = pino({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });

  private withReqId(fields: Record<string, unknown> = {}) {
    const store = requestALS.getStore();
    return store ? { reqId: store.reqId, ...fields } : fields;
  }

  log(message: string, context?: string) {
    this.logger.info(this.withReqId({ context }), message);
  }
  error(message: string, stack?: string, context?: string) {
    this.logger.error(this.withReqId({ context, stack }), message);
  }
  warn(message: string, context?: string) {
    this.logger.warn(this.withReqId({ context }), message);
  }
  debug(message: string, context?: string) {
    this.logger.debug(this.withReqId({ context }), message);
  }
  verbose(message: string, context?: string) {
    this.logger.trace(this.withReqId({ context }), message);
  }
}
```

main.ts 里换上它：

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(new NestLogger());
await app.listen(3000);
```

`bufferLogs: true` 让启动阶段的日志先攒着，等 pino 就位再一起输出，启动失败也不丢日志。Nest 的 verbose 对应 pino 的 trace，这个映射细节别偷懒写成 debug，级别顺序就乱了。代码里的 `requestALS` 下一小节实现，先把文件建好。

### 2. reqId：用 AsyncLocalStorage 给请求发身份证

一次请求要过中间件、guard、controller、service，撒上七八条日志。出事后要把「同一次请求」的日志挑出来靠什么？给每个请求发一个 reqId，写进它的每条日志。

难点是传值：总不能给每个函数加一个 reqId 参数。Node 的 AsyncLocalStorage 干的就是这件事：给一条异步调用链一块私有存储，链上任何位置都能取到，链外看不见。

```ts
// request-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestLogContext {
  reqId: string;
}

export const requestALS = new AsyncLocalStorage<RequestLogContext>();
```

中间件里创建 store，把 next 包进 run 回调：

```ts
// request-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestALS } from './request-context';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const reqId = (req.headers['x-request-id'] as string) || randomUUID();
    res.setHeader('X-Request-Id', reqId); // 回写响应头，用户报障时报这个号
    requestALS.run({ reqId }, () => next());
  }
}
```

`run(store, callback)` 的语义：callback 里发起的一切同步、异步调用，`getStore()` 都能拿到这块 store。于是第 1 小节的 withReqId 在任何一层取 reqId 都不落空。AppModule 里注册：

```ts
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
```

从此业务代码照常 `this.logger.log(...)`，reqId 自动出现在每条日志里。报障的用户只要给出响应头里的 X-Request-Id，你过滤这个值就能重放他那次请求的完整经过。

### 3. 级别、脱敏与收集

**级别规范：dev 开 debug，prod 开 info。** 各级别记什么，一张表定死：

- fatal：进程活不下去了（启动失败、必需的数据库连不上要退出）
- error：这次请求失败了，需要有人看，但不用半夜叫醒
- warn：可疑但扛住了（重试成功、触发降级、慢查询）
- info：业务关键事件（启动完成、请求耗时、登录、下单）
- debug：排查才用得上的细节（入参出参、走到哪个分支）

dev 开 debug，因为本地要看得细；prod 开 info，因为 debug 的量常常是 info 的十倍不止，全量落盘既费磁盘又拖性能。反过来 prod 只留 error 也不行，出事时上下文全无。

**脱敏：password、token 永不入日志。** 第 5 周、第 7 周讲安全时反复提过，日志是最容易泄密的地方，因为它看起来无害。pino 的 redact 在序列化时替换字段值，给第 1 小节的 pino 配置补上：

```ts
private logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: ['password', 'token', 'accessToken', '*.password', '*.token'],
    censor: '[REDACTED]',
  },
});
```

**收集：应用只管打 stdout，剩下交给容器。** pino 默认输出到 stdout，Docker 的 json-file 驱动把它落到宿主机文件，`docker logs` 读的就是这份文件。必须配轮转：

```yaml
services:
  api:
    build: .
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

不配轮转，日志文件无限增长，直到写满磁盘。收集方案的谱系一句话记住：一两台机器、按 reqId 查线上问题，docker logs 加 grep 足够；要集中检索和长期留存，上 Loki + Promtail；ELK 是重型武器，日志量没到那个体量别碰，运维成本先把你压垮。

## 动手任务：结构化日志一步一步

手册任务：用 pino 输出 JSON 日志，配置 Nginx access log。拆成 5 步，全程约 30 分钟。

**第 1 步：装依赖、建目录。** 在项目里 `npm i pino`，src 下建 logging 目录，放 request-context.ts、request-id.middleware.ts、nest-logger.ts 三个文件。

**第 2 步：写 context 和中间件。** 把第 2 小节的两段代码贴进对应文件。中间件要最先执行，`forRoutes('*')` 全路由注册即可，Nest 中间件按注册顺序跑。

**第 3 步：接入适配器。** 把 nest-logger.ts 抄进项目，redact 配置按第 3 小节补全，main.ts 里换上 useLogger。启动一次，控制台输出的应当是单行 JSON 而不是彩色文本。

**第 4 步：验证 reqId 贯穿。** 随便找个 controller 加两行日志：

```ts
@Controller('demo')
export class DemoController {
  private readonly logger = new Logger(DemoController.name);

  @Get()
  demo() {
    this.logger.log('进入 controller');
    setTimeout(() => this.logger.log('异步回调里的日志'), 50);
    return { ok: true };
  }
}
```

`curl -i http://localhost:3000/demo` 连打两次，观察三点：同一次请求的两行日志带同一个 reqId；两次请求的 reqId 不同；响应头里有 X-Request-Id。三点都成立，ALS 链路就是通的，连 setTimeout 这种异步回调都没跑出请求上下文。

**第 5 步：Nginx JSON access log 与容器轮转。** nginx.conf 里定义 JSON 格式并启用：

```nginx
log_format json_access escape=json
  '{'
    '"time":"$time_iso8601",'
    '"remote_addr":"$remote_addr",'
    '"method":"$request_method",'
    '"uri":"$request_uri",'
    '"status":$status,'
    '"request_time":$request_time,'
    '"reqId":"$upstream_http_x_request_id"'
  '}';

server {
  listen 80;
  access_log /var/log/nginx/access.log json_access;

  location / {
    proxy_pass http://api:3000;
  }
}
```

两个细节：`escape=json` 防止 URI 里的特殊字符打坏 JSON 结构；`$upstream_http_x_request_id` 取的是应用回写的 X-Request-Id 响应头，Nginx 访问日志从此能和应用日志用同一个 reqId 对上。status 和 request_time 不加引号，保持数字类型。docker-compose.yml 里给 api 和 nginx 两个服务都配上第 3 小节的 logging 段，`nginx -t` 检查通过再 reload。

::: tip 验证命令
`docker compose up -d` 后请求几次 `http://localhost/`，`docker logs <api容器> 2>&1 | grep reqId` 看应用日志；`docker exec <nginx容器> tail /var/log/nginx/access.log` 看 Nginx 日志。加 `2>&1` 是把容器的标准错误也并进管道，保险。两边拿同一个 reqId 对一对，对上了，今天的链路就闭环了。
:::

## 常见踩坑

**坑 1：参数顺序写反。** pino 的约定是对象在前、消息在后。`logger.info('登录成功', { userId: 42 })` 不报错，但对象会被当成字符串格式化参数揉进 msg，userId 不再是可查询字段。肌肉记忆：先对象，后消息。

**坑 2：定时任务里 reqId 是 undefined。** cron、队列消费者不在任何 HTTP 请求里，`getStore()` 返回 undefined，withReqId 就不加字段。这不是 bug，是本来就没有请求。要串日志，在任务入口自己起一块 store：`requestALS.run({ reqId: jobId }, handler)`。

**坑 3：redact 拦不住拼进消息的敏感信息。** ``logger.info(`用户 ${phone} 修改密码，新密码 ${password}`)`` 这种模板字符串走的是 msg 字段，redact 只处理对象字段路径，一点办法没有。规范定死：敏感值永远不进字符串。要记录的走结构化字段交给 redact，要展示的（手机号、邮箱）先自己打码再拼。

**坑 4：level 是数字不是字符串。** `{"level":30}` 里的 30 就是 info，pino 为了性能输出数字，60 才是 fatal。人看着别扭是暂时的：dev 端配 pino-pretty 转成彩色文本，日志平台读取时再做映射。别把 30 当成错误码去排查半天。

**坑 5：json-file 不配轮转等于埋雷。** 默认无限增长，磁盘写满那天容器集体罢工，日志大到 tail 都吃力。max-size 和 max-file 必须成对出现，一个管单文件上限，一个管保留几个文件，10m 加 3 个是够用的起点。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 结构化日志和文本日志的本质区别是什么？

::: details 参考答案
字段化。level、time、reqId、userId 都是独立字段，可以精确过滤、统计、聚合；文本日志只能靠正则和肉眼。第一读者是机器而不是人，这是可查询、可统计的前提。
:::

2. reqId 为什么不加参数也能贯穿整条调用链？

::: details 参考答案
中间件里 `requestALS.run({ reqId }, () => next())` 创建了一块属于这次请求的 store，AsyncLocalStorage 保证 run 回调内发起的所有同步和异步调用都能 `getStore()` 取到它。调用链上任何一层的日志读的都是同一块 store，reqId 自然贯穿。
:::

3. 为什么 dev 开 debug、prod 开 info？各级别分别记什么？

::: details 参考答案
debug 的量常是 info 的十倍以上，prod 全量落盘费磁盘拖性能，所以 prod 从 info 起步；dev 要看细节所以开 debug。fatal 记进程级灾难，error 记请求失败，warn 记扛住的可疑事件，info 记业务关键节点，debug 记排查细节。
:::

4. redact 的盲区在哪里，怎么补救？

::: details 参考答案
它只作用于对象的字段路径，模板字符串拼进 msg 的敏感值碰不到。补救：敏感值一律走结构化字段交给 redact；确需展示的（手机号、邮箱）在拼字符串前自己打码。
:::

5. 容器里的应用为什么日志打 stdout，而不是自己写文件？

::: details 参考答案
stdout 是应用和运行环境的边界。应用只管输出，落盘、轮转、采集交给 Docker 日志驱动统一管理，应用崩了日志还在，将来换 Loki 收集应用一行不改。自己写文件要处理路径、权限、轮转，全是分外的事。
:::

## 延伸阅读

- [pino 官方文档](https://getpino.io/#/docs/api)，级别、redact、transport 的权威说明，今天所有 pino 配置的出处
- [Node.js：AsyncLocalStorage](https://nodejs.org/api/async_context.html)，ALS 的语义和边界，reqId 方案的原理依据
- [NestJS：Logger](https://docs.nestjs.com/techniques/logger)，LoggerService 接口定义和自定义日志的官方做法
- [Nginx：ngx_http_log_module](http://nginx.org/en/docs/http/ngx_http_log_module.html)，log_format 与 escape=json 的原始文档
- [Docker：json-file 日志驱动](https://docs.docker.com/config/containers/logging/json-file/)，max-size、max-file 轮转参数说明

今天的三个文件和两份配置留在项目里，别删。reqId 这条线后面讲指标和链路追踪时还要接着用，它会升级成贯穿多个服务的 traceId。
