# 第 21 周 · Day 5：日志 + 指标 + 告警——用 Trace ID 缝合可观测性三支柱

> 对应手册任务：学习「日志 + 指标 + 告警」，动手把 Agent 的 Trace ID 注入日志、用 Prometheus 暴露 token/cost 指标，当日产出「可观测性面板」。本篇只解决一个问题：日志、指标、追踪三套系统各自为政时，排障等于在三个系统里分别大海捞针；靠一个 trace_id 把它们缝合起来，让一次故障定位变成「尖刺 → 日志 → Trace 树」的三跳直达。

## 今日目标

1. 说得清可观测性三支柱各自的分工，以及 Agent 平台为什么缺一不可
2. 掌握两个缝合动作：用 AsyncLocalStorage 把 trace_id 自动注入每行 pino 日志并透传 FastAPI；用 prom-client 把 [Day 2](/week21/day2) 的 usage 数据双写成指标
3. 独立搭出四块 Grafana 面板、三条告警规则，并完整走一遍从 Grafana 尖刺到 Langfuse 根因的三跳排障

## 概念讲解：为什么三支柱要合体

周四下午三点，运营在群里 @你：Agent 好像变慢了，有用户骂到客服。你手上有三套系统，挨个打开。

先看指标（Prometheus + Grafana）：15:32 起 P99 延迟从 8 秒跳到 45 秒，错误率冒出一个尖刺。指标像心电图，告诉你「什么时候、哪个部位不正常」，但心电图不会告诉你病因。

再开日志（第 8 周接的 pino + Loki）：15:32 前后一秒几百行，ERROR 混在 INFO 里。你知道出过错，但哪几行属于同一次慢请求？日志像病历，细节管够，就是没装订成册。

最后开 Langfuse（[Day 1](/week21/day1) 自托管的那个）：Trace 树确实清楚，第几步慢、哪个工具报错一目了然。可你不可能盯着每一次运行，等你翻到这棵树，靠的还是指标先告诉你「从 15:32 开始」。

三套系统单独看，都只回答了问题的一半。合起来才是一条完整证据链：指标负责「什么时候出事」，触发告警、圈定时间窗；日志负责「当时发生了什么」，提供细节证据；追踪负责「慢在哪一步、错在哪一环」，做结构化回放。第 8 周给 Web 应用搭了前两根支柱，本周 [Day 1](/week21/day1) 补上了第三根，今天把它们缝成一件衣服。

缺的那根线叫 trace_id。请求进入 BFF 时生成一个全局唯一的 ID，之后：它跟着 AsyncLocalStorage 走，pino 写的每一行日志自动带上；它跟着 HTTP header 穿过 BFF 到 FastAPI，Python 侧日志也带上；Langfuse 创建 trace 时直接用它当 id。于是同一个 trace_id，在 Grafana 的曲线上是一个时间点，在 Loki 里是一串日志行，在 Langfuse 里是一棵树。一处报错，三处可查。

这就是今天要搭的东西。

## 核心知识

### 1. trace_id 注入日志：复用第 8 周的 AsyncLocalStorage

trace_id 的生成不难，`crypto.randomUUID()` 一行的事。难的是「每一行日志自动带上」：全项目几百处 `logger.info`，不可能挨个加参数，漏一处关联就断。

第 8 周做请求日志时用过 AsyncLocalStorage 存请求上下文，今天原样复用。它是 Node 的「随请求走的隐形口袋」：中间件里往里放东西，这个请求后续经过的任何函数（包括 await 之后再恢复的）都能取出来，别的请求还看不见。三个文件拼起来：

```ts
// context.ts —— 隐形口袋
import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  traceId: string;
  tenantId: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): Partial<TraceContext> {
  return traceStorage.getStore() ?? {};
}
```

```ts
// logger.ts —— pino 每写一行日志，mixin 会先调一次
import pino from "pino";
import { getTraceContext } from "./context";

export const logger = pino({
  level: "info",
  mixin() {
    const { traceId, tenantId } = getTraceContext();
    return traceId ? { trace_id: traceId, tenant_id: tenantId } : {};
  },
});
```

```ts
// middleware.ts —— 入口生成（或接收）trace_id
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { traceStorage } from "./context";

export function traceMiddleware(req: Request, res: Response, next: NextFunction) {
  const traceId = req.header("x-trace-id") || randomUUID();
  res.setHeader("x-trace-id", traceId); // 响应头带回去，用户报障时直接给这个 ID
  traceStorage.run(
    { traceId, tenantId: req.header("x-tenant") ?? "default" },
    next,
  );
}
```

关键在两处。`traceStorage.run(ctx, next)` 把整条请求处理链包进上下文，Express 后续所有中间件和路由都在口袋里；`mixin()` 是 pino 的钩子，每行日志序列化前调用，返回的对象平铺进这行日志。两处一接，业务代码一行不改，日志就全带 trace_id 了。

还有个细节：`req.header("x-trace-id") || randomUUID()` 优先读上游传入，没有才生成。这样网关、压测脚本都能指定 ID，排障时能主动「预约」一次可追踪的请求。

### 2. 透传 FastAPI，直抵 Langfuse

trace_id 停在 BFF 没用。Agent 主循环在 FastAPI 那边，Langfuse 埋点也在那边，缝合线必须穿过去。

BFF 调 FastAPI 时带上 header，这是整条链路的缝合点：

```ts
import { getTraceContext } from "./context";

export async function callAgent(payload: unknown) {
  const { traceId = "" } = getTraceContext();
  const res = await fetch(`${process.env.AGENT_URL}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-trace-id": traceId },
    body: JSON.stringify(payload),
  });
  return res.json();
}
```

FastAPI 侧用中间件接住。Python 没有 AsyncLocalStorage，但有亲兄弟 contextvars，配合 logging.Filter 做同样的事：

```python
# logging_setup.py
import logging
from contextvars import ContextVar

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="-")

class TraceIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = trace_id_var.get()
        return True

_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)s trace_id=%(trace_id)s %(message)s"
))
_handler.addFilter(TraceIdFilter())

root = logging.getLogger()
root.addHandler(_handler)
root.setLevel(logging.INFO)
```

中间件里从 header 读 ID、写进 contextvar，再挂到 request.state 上给业务代码用：

```python
import time
from uuid import uuid4
from fastapi import FastAPI, Request

app = FastAPI()

@app.middleware("http")
async def trace_middleware(request: Request, call_next):
    trace_id = request.headers.get("x-trace-id", str(uuid4()))
    trace_id_var.set(trace_id)
    request.state.trace_id = trace_id
    start = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["x-trace-id"] = trace_id
        return response
    finally:
        logging.getLogger("agent").info(
            "path=%s duration_ms=%.0f",
            request.url.path, (time.perf_counter() - start) * 1000,
        )
```

最后一针：Langfuse。创建 trace 时直接用这个 id：

```python
from langfuse import Langfuse

langfuse = Langfuse()

@app.post("/chat")
async def chat(req: ChatRequest, request: Request):
    trace = langfuse.trace(
        id=request.state.trace_id,   # 和日志里的 trace_id 是同一个
        name="agent-chat",
        metadata={"tenant_id": req.tenant_id},
    )
    # Agent 主循环每一步挂到这棵树上：trace.span(name="retrieve") ...
```

Langfuse 支持自定义 trace id，UI 顶部直接按 id 搜。如果你用的是 `@observe` 装饰器自动打点，不方便指定 id，就把 trace_id 写进 trace 的 metadata，Langfuse 的搜索一样能命中。从此「日志里捞到 trace_id，贴进 Langfuse 搜索框」就是一次复制粘贴的事，不用导出文件，不用对时间戳。

### 3. 四个 LLM 业务指标：usage 表双写

[Day 2](/week21/day2) 已经把每次 LLM 调用的 token 和成本写进了 usage 表，为什么还要 Prometheus 指标？因为「过去 1 小时按模型分组的成本曲线」这种问题拿 SQL 扫表：慢、贵、还压业务库。Prometheus 的时序数据库天生干这个，还白送一套告警引擎。

双写的意思是不采集第二遍：写 usage 表的那份数据，顺手 inc 一下指标。指标类型只用到两种，各记一句话：累计量（token、成本）用 Counter，PromQL 的 rate/increase 帮你算增速；分布（延迟、步数）用 Histogram，histogram_quantile 帮你算分位数。

```ts
// metrics.ts
import client from "prom-client";

export const registry = new client.Registry();

// token 累计：谁家（tenant）用哪个模型烧了多少
export const llmTokensTotal = new client.Counter({
  name: "llm_tokens_total",
  help: "LLM token 消耗累计",
  labelNames: ["model", "tenant", "type"], // type: input | output
  registers: [registry],
});

// 成本累计，单位美元，Counter 允许小数
export const llmCostTotal = new client.Counter({
  name: "llm_cost_total",
  help: "LLM 调用成本累计（USD）",
  labelNames: ["model", "tenant"],
  registers: [registry],
});

// 单次 LLM 调用耗时分布，桶按 LLM 实际延迟范围设
export const llmRequestDuration = new client.Histogram({
  name: "llm_request_duration_seconds",
  help: "单次 LLM 调用耗时分布",
  labelNames: ["model", "status"],
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

// 单次 Agent 任务执行步数分布
export const agentSteps = new client.Histogram({
  name: "agent_steps",
  help: "单次 Agent 任务执行的步数",
  labelNames: ["tenant"],
  buckets: [1, 2, 4, 8, 16, 25],
  registers: [registry],
});
```

埋点接在 Day 2 的计量处：

```ts
import { llmTokensTotal, llmCostTotal, llmRequestDuration } from "./metrics";

export async function callLlm(
  req: { model: string; tenant: string; runId: string },
  invoke: () => Promise<LlmResponse>,
) {
  const timer = llmRequestDuration.startTimer({ model: req.model });
  let status = "ok";
  try {
    const res = await invoke();
    const usage = toUsage(req, res); // Day 2 已有的换算：token 数 × 单价 → 成本
    await db.usage.create({ data: usage }); // 第一写：落库，明细和账单靠它
    // 第二写：指标，曲线和告警靠它们
    llmTokensTotal.inc(
      { model: req.model, tenant: req.tenant, type: "input" },
      usage.inputTokens,
    );
    llmTokensTotal.inc(
      { model: req.model, tenant: req.tenant, type: "output" },
      usage.outputTokens,
    );
    llmCostTotal.inc({ model: req.model, tenant: req.tenant }, usage.costUsd);
    return res;
  } catch (err) {
    status = "error";
    throw err;
  } finally {
    timer({ status }); // 结束计时才打标签，失败的调用同样被计时
  }
}
```

两个细节。`startTimer()` 返回的函数在 finally 里调用，且调用时才给 `status` 打标签：成功的请求落进 `{status="ok"}` 序列，失败的落进 `{status="error"}`，错误率面板的分子分母就靠这一步分出来。agent_steps 在 Agent 主循环结束处 `agentSteps.observe(steps, { tenant })` 记一次总步数；[Day 4](/week21/day4) 把 recursion_limit 设成了 25，P95 步数一旦逼近 25，说明有一批任务在硬撞天花板，这要在用户投诉之前看到。

### 4. 面板与告警：让指标自己开口

指标有了，剩下是让它们变成「能看的图」和「会叫的铃」。Grafana 四块面板的 PromQL 直接抄：

```promql
# 面板 1a：QPS，按模型分曲线
sum by (model) (rate(llm_request_duration_seconds_count[5m]))

# 面板 1b：P95 延迟
histogram_quantile(0.95,
  sum by (le) (rate(llm_request_duration_seconds_bucket[5m])))

# 面板 2：每小时成本，Legend 填 {{model}} 自动按模型分色
sum by (model) (increase(llm_cost_total[1h]))

# 面板 3：P95 步数
histogram_quantile(0.95,
  sum by (le) (rate(agent_steps_bucket[5m])))

# 面板 4：错误率（%）
100 * sum(rate(llm_request_duration_seconds_count{status="error"}[5m]))
    / sum(rate(llm_request_duration_seconds_count[5m]))
```

告警是面板的自动化版本：人盯曲线会走神，规则不会。三条：

```yaml
# alerts.yml —— 挂进 Prometheus 的 rule_files
groups:
  - name: agent
    rules:
      - alert: DailyCostBudget80Percent
        expr: sum(increase(llm_cost_total[24h])) > 40  # 日预算 $50 的 80%
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "近 24h LLM 成本已达日预算的 80%，检查是否有任务在空转"
      - alert: LlmP99LatencyHigh
        expr: >
          histogram_quantile(0.99,
            sum by (le) (rate(llm_request_duration_seconds_bucket[5m]))) > 30
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "LLM P99 延迟超过 30s，已持续 10 分钟"
      - alert: ErrorRateAbove5Percent
        expr: >
          100 * sum(rate(llm_request_duration_seconds_count{status="error"}[5m]))
              / sum(rate(llm_request_duration_seconds_count[5m])) > 5
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "LLM 调用错误率超过 5%"
```

通知出口是 Alertmanager 的 webhook。飞书和钉钉的自定义机器人各认各的 JSON 格式，Alertmanager 发的是自家格式，中间需要一个转接头：

```yaml
# alertmanager.yml
route:
  group_by: ["alertname"]
  group_wait: 30s
  receiver: im-webhook

receivers:
  - name: im-webhook
    webhook_configs:
      # 钉钉用 prometheus-webhook-dingtalk 起一个转接服务
      # 飞书同理，几十行的小适配器把 alert 转成 {"msg_type":"text",...}
      - url: "http://webhook-adapter:8080/send"
```

## 动手任务：三支柱合体一步一步

拆成 6 步，全程约 45 分钟，最终产出四块面板加三条告警。

**第 1 步：建 metrics.ts。** 把核心知识 3 的注册代码存成 `bff/src/metrics.ts`，先不管埋点，文件里目前只有指标定义。

**第 2 步：在 Day 2 的计量点双写。** 找到 Day 2 写 usage 表的装饰器或函数，把 `callLlm` 的埋点逻辑合进去。`toUsage`、`db.usage.create` 都是已有的，新增的只有四个 inc/observe 调用。

**第 3 步：暴露 /metrics 并配置抓取。** BFF 加一个端点，Prometheus 加一个 job：

```ts
import express from "express";
import { registry } from "./metrics";

const app = express();

app.get("/metrics", async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
```

```yaml
# prometheus.yml 的 scrape_configs 追加
scrape_configs:
  - job_name: "bff"
    scrape_interval: 15s
    static_configs:
      - targets: ["host.docker.internal:3000"]
```

起服务后先 `curl localhost:3000/metrics`，能搜到 `llm_tokens_total` 的 HELP 行和样本行就通了。

**第 4 步：缝合 trace_id。** 核心知识 1、2 的代码依次落地：BFF 的 context/logger/middleware，`traceMiddleware` 注册在 `app.use` 最前面；FastAPI 的 logging 配置和中间件加进 main.py，记得 `import logging_setup`；`langfuse.trace` 用 `request.state.trace_id`。验证方法很有手感：`curl -s -D -` 发一次请求，抄下响应头里的 `x-trace-id`，拿它去 grep 两个服务的日志，BFF 和 Python 应该同时命中。

**第 5 步：搭 Grafana 面板。** 数据源指向 Prometheus，新建 Dashboard，按核心知识 3 的四段 PromQL 建面板：QPS/延迟、成本曲线、P95 步数、错误率。面板 2 的 Legend 填 `{{model}}`，曲线自动按模型分色。发几轮对话，看着曲线动起来，这一步的爽感是今天最强的。

**第 6 步：告警 + 三跳排障演练。** alerts.yml 挂进 Prometheus，alertmanager.yml 配好转接头。然后故意制造一个 bad case：把某个工具的 URL 改成不通的域名，发起一次对话，走三跳：

- 第一跳，Grafana：错误率面板几分钟内冒尖（抓取间隔 15s），P99 延迟同步抬升。知道了「什么时候、什么面」。
- 第二跳，日志：Loki 查 `{app="bff"} | json | level="error"`，或直接用响应头里的 x-trace-id，拿到 trace_id 后把两个服务的日志串起来看：工具调用超时，重试三次。
- 第三跳，Langfuse：把 trace_id 贴进搜索框，打开那棵树，第 3 个 span 红着，点开 inputs，URL 域名拼错了一目了然。根因落定。

改回 URL，把面板 JSON 和告警配置提交进仓库，当日产出「可观测性面板」完成。

::: tip 为什么值得演练一遍
三跳排障是今天所有工作的验收标准。没完整走过一遍的监控体系，等于没装：真出事时你不知道哪一跳会断。
:::

## 常见踩坑

**坑 1：高基数 label 会撑爆 Prometheus。** tenant 适合做 label（就几十个），user_id、session_id、trace_id 绝对不行（每天百万级）。label 每个取值组合都是一条独立时间序列，基数上万，内存和查询双双完蛋。判断标准：这个字段的去重取值会不会持续无界增长？会，就放日志里查，别放 label。

**坑 2：Histogram 的 buckets 抄 HTTP 模板。** 网上教程里 `[0.005, 0.01, 0.025]` 那套是给毫秒级 API 延迟用的，LLM 调用动辄几秒到几十秒，全部挤进第一桶，P95 画出来是一条贴地直线。图很好看，数据没用。桶要按被测对象的真实范围设，LLM 延迟用 `[0.5, 1, 2, 5, 10, 30, 60]` 这档。

**坑 3：缝合线只缝一半。** 最常见的翻车：BFF 日志带了 trace_id，fetch 忘了加 `x-trace-id` header，Python 日志和 Langfuse 全部断开。三支柱缝合是全链路的事，断一环等于断全部。验收动作就一个：拿同一个 trace_id，能在三个系统里各查出东西。

**坑 4：以为 webhook 填个 URL 就能通飞书/钉钉。** Alertmanager 发的 JSON 长一个样，国内 IM 机器人要的格式各长各的样，直接对接是通的，但消息进不去。钉钉用 prometheus-webhook-dingtalk，飞书也需要个小转接服务。别自己裸写正则硬转，用现成转接头，顺便白拿消息模板功能。

**坑 5：把「日预算 80%」的口径想当然。** `increase(llm_cost_total[24h])` 是滚动 24 小时窗口，凌晨 4 点的窗口里含着昨天下午的峰值，和财务说的「自然日」不是一回事。运营能接受就用滚动窗口，简单且无状态；非要自然日，得配 recording rule 加 offset，或者让告警读 usage 表的日汇总。先问清口径，再选实现，别反过来。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 三支柱各自回答什么问题？为什么任何单独一个都完不成排障？

::: details 参考答案
指标回答「什么时候、哪个面出了问题」，存储成本低、保留周期长，负责告警触发和时间窗圈定；日志回答「当时具体发生了什么」，细节最全，但缺请求维度的装订；追踪回答「这次请求慢在哪一步、错在哪一环」，结构化最好，但不宜常态盯屏。排障链条是指标圈范围、日志找证据、追踪定位根因，三环缺一，链条就断。
:::

2. 为什么 tenant 放进 label 没问题，trace_id 却绝对不行？

::: details 参考答案
label 的每个取值组合都会创建独立时间序列。tenant 的去重取值是有限的几十个，可控；trace_id 每次请求一个新值，几小时就能造出百万条序列，内存和查询都会被打爆。判断标准是「去重取值是否持续无界增长」：是，就留在日志里查；否，才配做 label。
:::

3. 错误率面板依赖哪个设计？为什么 startTimer 的 status 标签要在计时结束时才打？

::: details 参考答案
依赖 Histogram 的 status 标签，错误率等于 `status="error"` 的速率除以全部速率。prom-client 允许 `startTimer()` 先开始计时、结束时再补标签，成功落 `status="ok"`，失败落 `status="error"`。如果一开始就把标签定死，成败还未知，请求会被分进错误的序列，错误率将永远为零。
:::

4. 三跳排障的每一跳，交接靠的是什么？

::: details 参考答案
第一跳靠时间：Grafana 尖刺给出故障时间窗；第二跳靠 trace_id：从响应头或错误日志拿到 ID，串起 BFF 与 FastAPI 两段日志；第三跳靠同一个 ID 落在 Langfuse 的 trace id 上：搜索直达调用树根因。接力棒从头到尾是同一个 trace_id，这就是缝合的全部意义。
:::

5. usage 表和 metrics 都记了 token 和成本，两边怎么分工？

::: details 参考答案
usage 表是明细账，支持任意维度的事后查询、对账、出账单，但聚合查询慢且压业务库；metrics 是预聚合的曲线，回答趋势、对比、告警这类固定问题，快且自带告警引擎，但不支持任意明细下钻。双写就是明细归账本、趋势归时序库，各干各的活。
:::

## 延伸阅读

- [prom-client README](https://github.com/siimon/prom-client)，Counter/Histogram/Gauge 的全部用法与 Express 集成，今天四个指标的官方出处
- [Prometheus 告警规则文档](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/)，for、labels、annotations 的准确语义，写规则前值得通读一遍
- [prometheus-webhook-dingtalk](https://github.com/timonwong/prometheus-webhook-dingtalk)，钉钉转接头的部署与消息模板配置，飞书适配器照着它写一个就行

今天的面板和告警配置留好，[Day 7](/week21/day7) 压测 100 并发时，延迟和成本怎么看、日预算会不会烧穿，全靠这套面板说话。
