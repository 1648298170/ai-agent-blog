# 第 8 周 · Day 5：Prometheus + Grafana 入门——给服务装上仪表盘

> 对应手册任务：学习「指标：Prometheus + Grafana 入门」，动手用 `prom-client` 暴露 `/metrics` 端点，让 Prometheus 抓取、Grafana 画图，当日产出「基础监控面板」。本篇只解决一个问题：日志能告诉你「某一次请求出了什么事」，却答不出「系统现在整体快不快、错得多不多、还撑不撑得住」——指标把海量事件在发生的那一刻就聚合成几个数，配上图，你的服务才算有了仪表盘。

## 今日目标

1. 说得清指标和日志的分工：聚合数值对单条事件，以及四个黄金指标各自回答什么问题
2. 掌握 `prom-client` 四种指标类型，看到一个监控需求能立刻判断该用哪种
3. 独立跑通完整链路：NestJS 暴露 `/metrics`，Prometheus 定时抓取，Grafana 画出「QPS 按 path」和「P95 延迟」两张图

## 概念讲解：为什么有了日志还要指标

Day 4 我们用 pino 把日志拆成了结构化 JSON（见[本周日程](/week08/)），单条日志的信息量已经足够。现在换个问题：用户反馈「接口好像变慢了」，你怎么证明？

第一反应是去翻日志。一小时的请求日志可能有几十万条，用 `jq` 把 `durationMs` 抽出来算个平均？算一次几分钟，而「系统现在怎么样」这个问题你需要每 15 秒答一次。更别提日志文件还在滚动、多个实例分散在不同容器里。这不是日志不行，是日志的职责就不包括实时聚合——它是行车记录仪，出事后拿来回放取证的。

指标反过来干活。事件发生的当时，应用自己就把聚合做了：一个请求进来，计数器加一，耗时扔进分桶。存下来的不是一条条事件，而是「每个时间点一个数」的时间序列。一小时的 QPS 曲线，240 个点就画完了，不管这一小时里有多少请求。这是仪表盘，扫一眼就知道车况。

这套体系建立在四个黄金指标上，Google SRE 的总结：**延迟**（服务多快）、**流量**（扛了多少请求）、**错误**（错了多少）、**饱和度**（资源还剩多少余量）。线上出事时，这四个数答不上来任何一个，你就只能靠猜。今天的动手任务会把它们全部落地。

## 核心知识

### 1. prom-client 的四种指标类型

Node.js 生态的事实标准是 `prom-client`。它只有四种指标类型，先把地图背下来：

```ts
import client from 'prom-client';

// Counter：只增不减，重启归零
const requestTotal = new client.Counter({
  name: 'app_request_total',
  help: '请求总数',
  labelNames: ['route'],
});

// Gauge：瞬时值，可上可下
const onlineUsers = new client.Gauge({
  name: 'app_online_users',
  help: '当前在线用户数',
});

requestTotal.inc();                   // +1
requestTotal.inc({ route: '/chat' }); // 带标签 +1
onlineUsers.set(42);                  // 设为 42
onlineUsers.inc();                    // 也可以 +1
```

**Counter** 记累积量：请求总数、错误总数。它永远只调 `inc()`，「总数」本身没用，但配合 Prometheus 的 `rate()` 能算出每秒速率，这是 QPS 和错误率的基础。**Gauge** 记瞬时状态：当前内存占用、活跃连接数、队列长度。它随便上下，`set()` 设定值，`inc()` `dec()` 增减。

**Histogram** 是重头戏，专门对付「分布」这类问题。你 `observe()` 一个值，它落进预设的桶里：

```ts
const requestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP 请求耗时分布（秒）',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

requestDuration
  .labels({ method: 'GET', route: '/chat', status: '200' })
  .observe(0.073); // 落进 le="0.1" 这个桶
```

桶边界自己定，原则是覆盖你关心的区间。落桶之后，服务端就能反推出「95% 的请求快于多少秒」这类分位数。**Summary** 和 Histogram 一样算分位数，区别一句话：Summary 在你的应用进程里把分位数算好再暴露，而 Histogram 只交出桶计数、把算分位数的活留给服务端。看起来 Summary 更贴心，但分位数没有「跨实例相加」的数学运算，部署两个实例后 Summary 就算不出整体的 P95 了。结论：多实例聚合场景一律 Histogram，这也正是今天要用的。

### 2. NestJS 接入：/metrics 端点与打点中间件

接入只做三件事：暴露端点、收默认指标、给 HTTP 请求打点。`npm install prom-client` 之后逐个来。

端点是个普通 Controller，把所有指标按文本格式吐出去：

```ts
// src/metrics/metrics.controller.ts
import { Controller, Get, Header } from '@nestjs/common';
import client from 'prom-client';

@Controller()
export class MetricsController {
  @Get('metrics')
  @Header('Content-Type', client.register.contentType)
  metrics(): Promise<string> {
    return client.register.metrics();
  }
}
```

`register.metrics()` 返回的文本长这样，Prometheus 就吃这个格式：

```
# HELP http_request_duration_seconds HTTP 请求耗时分布（秒）
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/chat",status="200",le="0.1"} 12
http_request_duration_seconds_bucket{method="GET",route="/chat",status="200",le="+Inf"} 15
http_request_duration_seconds_count{method="GET",route="/chat",status="200"} 15
```

然后是打点中间件，今天最核心的一段代码：

```ts
// src/metrics/metrics.middleware.ts
import type { Request, Response, NextFunction } from 'express';
import client from 'prom-client';

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP 请求耗时分布（秒）',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpRequestDuration.startTimer({ method: req.method });
  res.on('finish', () => {
    // Express 类型里没声明 route 字段，这里收窄一次
    const route = (req as Request & { route?: { path?: string } }).route?.path ?? 'unmatched';
    end({ route, status: String(res.statusCode) });
  });
  next();
}
```

关键两处。`startTimer()` 返回一个 `end` 函数，调用它时才计算耗时并 `observe`，正好卡在 `finish` 事件（响应已发完）上，不阻塞请求本身。`route` 标签取的是 `req.route.path`，也就是 `/users/:id` 这样的路由模板——`finish` 触发时路由早已匹配完成。为什么不用真实 URL，坑 2 专门说。

最后在 `main.ts` 里把两件事挂上：

```ts
import { NestFactory } from '@nestjs/core';
import client from 'prom-client';
import { metricsMiddleware } from './metrics/metrics.middleware';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  client.collectDefaultMetrics(); // 进程默认指标：CPU、内存、事件循环延迟
  app.use(metricsMiddleware);

  await app.listen(3000);
}
bootstrap();
```

`collectDefaultMetrics()` 白送一批饱和度指标：`process_resident_memory_bytes`、`nodejs_eventloop_lag_seconds` 等，四个黄金指标里的「饱和度」直接就有了。

### 3. Prometheus：pull 模型与抓取配置

Prometheus 是 pull 模型：它不等你的应用推数据，而是自己每 15 秒来 GET 一次你的 `/metrics`。应用要做的事只有一件——把「当前所有指标的快照」放在一个端点上，谁来查都给同一份。反过来推数据的应用，挂了都没人知道；pull 模式下抓取失败，Prometheus 界面上 target 立刻变红。

告诉它抓谁，靠 `prometheus.yml`：

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'api'
    static_configs:
      - targets: ['api:3000'] # api 是 compose 里的服务名
```

再把 Prometheus 和 Grafana 加进已有的 `docker-compose.yml`：

```yaml
services:
  # ……已有的 api 服务保持不变
  prometheus:
    image: prom/prometheus:v2.53.0
    ports:
      - '9090:9090'
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    restart: unless-stopped

  grafana:
    image: grafana/grafana:11.1.0
    ports:
      - '3001:3000' # 宿主机 3001，避开 api 的 3000
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
    volumes:
      - grafana-data:/var/lib/grafana
    restart: unless-stopped

volumes:
  grafana-data:
```

`docker compose up -d` 之后打开 `http://localhost:9090/targets`，`api` 这个 job 显示 UP，链路的前半段就通了。

### 4. Grafana：数据源与第一个面板

Grafana 只管一件事：从数据源读数、画图。打开 `http://localhost:3001`（默认 admin/admin），先配数据源：左侧 Connections → Data sources → Add Prometheus，URL 填 `http://prometheus:9090`，点 Save & test。注意填的是 compose 服务名而不是 localhost，原因坑 4 讲。

然后建 Dashboard，加两个面板。只学两条 PromQL 就够今天用。

面板一，QPS 按 path：

```promql
sum by (route) (rate(http_request_duration_seconds_count[5m]))
```

`rate()` 一句话：取时间序列在窗口内的每秒平均增速，把 Counter 的累积值换算成速率，QPS 就是它的本来含义。

面板二，P95 延迟：

```promql
histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket[5m])))
```

`histogram_quantile()` 一句话：根据各桶的累积计数反推分布，返回「95% 的请求都快于这个值」。注意 `by` 里必须保留 `le` 标签，函数靠它定位桶边界，漏了整条查询就废了。

图画出来，离告警只差半步：在 Prometheus 里写一条规则，比如「5xx 比率连续 5 分钟超过 5% 就触发」，触发了交给 Alertmanager 发通知。思路知道即可，今天先把图跑通。

## 动手任务：基础监控面板一步一步

手册任务：用 `prom-client` 暴露 `/metrics`，Prometheus 抓取，Grafana 画图。拆成 5 步，全程约 40 分钟。

**第 1 步：装依赖，建目录。** 在项目里 `npm install prom-client`，新建 `src/metrics/` 目录，放下面两步的三个文件。

**第 2 步：暴露 /metrics 并收默认指标。** 把核心知识第 2 节的 `MetricsController` 写进 `src/metrics/`，记得在 `AppModule` 的 `controllers` 里注册它。`main.ts` 加上 `client.collectDefaultMetrics()`。本地起服务，`curl localhost:3000/metrics`，能看到 `process_cpu_user_seconds_total` 这类输出就对了。

**第 3 步：接打点中间件。** 把 `metrics.middleware.ts` 原样抄进去，`main.ts` 挂上 `app.use(metricsMiddleware)`。用 curl 打几次任意接口，再回头看 `/metrics` 的输出，`http_request_duration_seconds_bucket` 的计数应该涨了，`route` 标签是路由模板而不是真实 URL。

**第 4 步：Prometheus 进 compose。** 写 `prometheus.yml`，在 `docker-compose.yml` 加 `prometheus` 和 `grafana` 两个服务。`docker compose up -d` 后打开 `http://localhost:9090/targets`，确认 `api` 是 UP。是 DOWN 就回去看坑 3。

**第 5 步：Grafana 配数据源，画两张图。** 数据源指向 `http://prometheus:9090`，新建 Dashboard，按核心知识第 4 节的两条 PromQL 加面板。想看到曲线动起来，开个终端循环打请求：`while (1) { curl localhost:3000/chat; Start-Sleep -m 200 }`（PowerShell），等一两个抓取周期，QPS 和 P95 就有值了。保存这个 Dashboard，它就是当日产出。

::: tip 验证清单
链路三段各自可独立验证：应用侧 `curl localhost:3000/metrics` 看文本输出；抓取侧 `http://localhost:9090/targets` 看 UP；展示侧在 Grafana 的 Explore 里随便查一条 `up` 看有没有数据。哪段断了修哪段，别从头猜。
:::

## 常见踩坑

**坑 1：时间单位混乱。** 社区惯例是指标名以 `_seconds` 结尾、值用秒。PromQL 的 `rate()` 和 `histogram_quantile()` 不做任何单位换算，你要是把毫秒值 `observe` 进名为 `_seconds` 的指标，算出来的 P95 会凭空大一千倍，而且没人报错。全程认准秒。

**坑 2：label 用了高基数值。** `route` 标签如果填真实 URL，`/users/123`、`/users/456` 每个都是一条新时间序列，指标在内存里按序列数收费，爬一波爬虫你的指标量直接爆炸。所以中间件取的是 `req.route.path`（`/users/:id`），模板值有限，序列数可控。判断标准：一个标签的可能取值超过几百个，就该警惕。

**坑 3：Prometheus target 一直 DOWN。** `targets` 里写了 `localhost:3000`，但 Prometheus 跑在容器里，容器里的 localhost 是容器自己。api 和 Prometheus 同在 compose 网络时用服务名 `api:3000`；api 还在宿主机上跑（比如 `npm run start:dev` 阶段），Windows/macOS 写 `host.docker.internal:3000`。

**坑 4：Grafana 数据源测试不通。** 和坑 3 同根：Save & test 是从 Grafana 容器里发出的请求，填 `localhost:9090` 访问的是 Grafana 容器自己。填 `http://prometheus:9090`。浏览器里打不开这个地址是正常的，它只在 compose 网络内有效。

**坑 5：只看平均值。** 平均耗时 50ms 看着很健康，可能是 99 个 10ms 的请求拽着一个 4 秒的请求求平均。慢请求永远被大量快请求稀释，平均值回答不了「有多少用户在忍受慢」。这就是为什么面板要画 P95 而不是均值，也是 Histogram 存在的理由。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 日志和指标各自回答什么问题？什么场景必须用指标？

::: details 参考答案
日志记录单条事件的完整上下文，回答「那次到底发生了什么」，用于事后排查；指标在事件发生时就聚合成时间序列，回答「系统整体现在怎么样」，用于实时观察和告警。需要看趋势、算速率、跨时间对比时必须用指标——拿日志现算聚合，等于把日志系统当数据库使。
:::

2. Counter 和 Gauge 的区别是什么？「当前在线连接数」用哪个？

::: details 参考答案
Counter 只增不减、重启归零，靠 `rate()` 换算速率；Gauge 是瞬时值，可上可下。「当前在线连接数」用 Gauge，因为它会降——连接断开数字要回落，Counter 表达不了「减少」这件事。「累计连接过多少次」才是 Counter。
:::

3. Histogram 和 Summary 都能暴露分位数，多实例部署选哪个，为什么？

::: details 参考答案
选 Histogram。Summary 在应用进程内把 P95 之类算死了才暴露，而分位数之间没有可聚合的数学运算，两个实例各自的 P95 没法合并成整体 P95。Histogram 只交出各桶计数，聚合交给服务端：先 `sum by (le)` 把多实例的桶加起来，再 `histogram_quantile` 算整体分位数。
:::

4. 四个黄金指标分别是什么？对应到今天的动手任务，各落在哪？

::: details 参考答案
延迟、流量、错误、饱和度。流量：`rate(http_request_duration_seconds_count[5m])` 即 QPS 图；延迟：P95 面板；错误：同一指标的 `status` 标签过滤 5xx 算错误率；饱和度：`collectDefaultMetrics()` 白送的 CPU、内存、事件循环延迟。
:::

5. `route` 标签为什么必须用 `/users/:id` 这样的模板值？

::: details 参考答案
真实 URL 里的路径参数每个都不同（`/users/123`、`/users/456`），每个取值都会生成一条独立时间序列，高流量下标签基数失控，内存和存储双双爆炸。模板值是有限集合，序列数收敛在路由数量上。顺带一提，这也是为什么 URL 里的查询参数永远不该进标签。
:::

## 延伸阅读

- [Prometheus 官方文档：Metric Types](https://prometheus.io/docs/concepts/metric_types/)，四种指标类型的原始定义，篇幅不长，值得对照 prom-client 的 API 读一遍
- [prom-client GitHub](https://github.com/siimon/prom-client)，README 覆盖了今天用到的全部 API，包括 `startTimer` 的细节
- [Google SRE：Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)，四个黄金指标的出处，整章都在讲「监控到底为了什么」

今天这套「应用打点 → Prometheus 存数 → Grafana 画图」是个通用套路。下周聊 LangSmith 追踪和 token 成本面板时你会发现，成本监控就是同一件事换了一批指标名：把花的钱变成 Counter，面板立刻就有了。
