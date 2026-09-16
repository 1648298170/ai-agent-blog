# 第 21 周 · Day 3：限流与配额——没有限流的 LLM 平台等于钱包裸奔

> 对应手册任务：学习「限流 + 配额 + 异常防御」，动手在 BFF 层实现基于 Redis 的限流、在 Agent 层加超时和重试上限，当日产出限流中间件。本篇只解决一个问题：LLM 应用每次调用都真金白银，接口不设防，一个恶意用户或一个失控循环就能一夜刷光你的预算。限流管「太快」，配额管「太多」，超时和重试上限管「太久」，三道闸一起上，钱包才算穿上裤子。

## 今日目标

1. 说得清固定窗口、滑动窗口、令牌桶、漏桶四种限流算法的差别、画法和各自适用场景
2. 掌握基于 Redis 的滑动窗口限流（ZSET + Lua 原子操作，复用第 6 周分布式锁练过的 Lua 功力），按 user_id 和 tenant_id 双维度限流
3. 独立完成 NestJS 限流 Guard，被限流时返回 429 加 Retry-After 头；再给 Agent 层加上会话步数上限、分级超时和重试上限

## 概念讲解：为什么 LLM 应用必须先限流再上线

传统 Web 接口多扛一次请求，成本接近零。LLM 应用不一样，每次调用按 token 计费，一次深度推理折算下来几分到几块钱。成本结构变了，防御思路也得跟着变。

风险来自三个方向。第一个是恶意用户：`/chat` 接口挂上公网，别人写个脚本一分钟打一千次，烧的是你的 API Key。第二个是失控的 Agent：ReAct 循环里模型判断出错，工具调用结果不理想就换个思路再来，一个会话悄悄跑两百步，中间没人拦。第三个是你自己的代码：下游超时你重试，重试又超时再重试，流量像滚雪球，第 13 周容错篇管这叫重试风暴。

三道防线各管一段：限流管速率，单位时间最多几次；配额管总量，这个月最多几次；超时和重试上限管单次调用的最坏情况。少任何一道，另外两道都会被绕过去。限流挡得住爆发式刷接口，挡不住每分钟 9 次的细水长流，那要靠配额；配额挡得住月度总量，挡不住一次调用挂死 5 分钟拖垮整个服务，那要靠超时。

## 核心知识

### 1. 限流算法四式

**固定窗口**：把时间切成等长的格子，每格一个计数器，格子一换从头数。

```
窗口1（10:00:00~10:00:59）   窗口2（10:01:00~10:01:59）
┌─────────────┐            ┌─────────────┐
│ ■■■■■■■■ 8  │            │ ■■■■■■■■ 8  │
└─────────────┘            └─────────────┘
```

规则是每分钟最多 10 次，两个窗口各放 8 个，谁都没破线。但 10:00:59 放进 8 个、10:01:01 又放进 8 个，2 秒内实际通过 16 个。这就是固定窗口的临界突刺：单看每个窗口都合规，交界处能塞进双倍流量。一句话适用：签到、每日领奖这类粗粒度、不怕突刺的场景，实现一个 INCR 加 EXPIRE 就够。

**滑动窗口**：不切格子，任意时刻往回看一个窗口长度，只数这段里的请求。

```
              任意时刻往回看 60 秒
  ────────┬─────────────────────● 现在
          └────── 只数这段 ──────┘
        10:00:20              10:01:20
```

「最近 60 秒不超过 10 次」，窗口边界跟着当前时刻滑，交界处塞不进双倍。计数精确，代价是要记下每个请求的时间戳，比固定窗口重。一句话适用：按用户限 API 这种要求精确计数的场景。

**令牌桶**：令牌以固定速率掉进桶里，请求取到令牌才放行，桶空就拒绝。

```
   以 r 个/秒的速率往桶里放令牌
           ↓   ●   ●   ●
         ┌─────────────┐
         │ ●  ●  ●  □  │   桶容量 b：最多攒 b 个
         └─────────────┘
                ↓
       取到令牌放行，桶空拒绝
```

妙处在一个「攒」字：用户一分钟没动，桶里攒了 b 个令牌，下一分钟可以一次性突发 b 个请求。真实用户的流量本来就不是匀速的，令牌桶允许合理突发、又用桶容量封了顶，所以它是业界默认推荐，各家云厂商的 API 限流大多是它。一句话适用：面向真实用户、需要容忍合理突发的场景。

**漏桶**：请求先流进桶里，以恒定速率漏给下游，桶满则新请求直接拒绝。

```
    请求流入（时多时少）
      ↘   ↘   ↘
    ┌~~~~~~~~~~~┐
    │  ██████   │   桶满，新请求直接拒绝
    └─────┬─────┘
          ↓ 恒定 r 个/秒流出 → 下游
```

不管来得多猛，给下游的永远是匀速。它保护的是下游而不是用户：适合下游只能匀速消费的场景（比如往队列里灌），交互式 API 用它会让用户觉得时快时慢。一句话适用：需要强行整流、保护脆弱下游的场景。

选型口诀：要精确计数选滑动窗口，要容忍突发选令牌桶，要强行匀速选漏桶，图省事且不怕突刺才用固定窗口。

### 2. Redis 滑动窗口：ZSET 加 Lua

直觉写法是两步：先 ZCARD 数一数窗口内的请求数，没超再 ZADD 写进去。并发下两个请求同时数到 9，都认为没超限，都放行，窗口里进来 11 个，限流形同虚设。这是典型的 check-then-act 竞态，第 6 周实现分布式锁时见过同款问题：判断和写入必须变成一个不可分割的动作。

Redis 执行 Lua 脚本期间不会插入任何其他命令，把清理旧记录、计数、判断、写入、设过期全塞进一段 Lua，天然原子。窗口本身用 ZSET 存：member 是请求唯一 id，score 是时间戳，按 score 范围清理和统计。

```ts
// rate-limiter.ts
import Redis from "ioredis";

export const redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");

export interface LimitResult {
  allowed: boolean;
  remaining: number;     // 窗口内还剩几个名额
  retryAfterSec: number; // 被限时，建议多少秒后再试
}

// 滑动窗口：member = 唯一 id，score = 请求时间戳（毫秒）
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2]) -- 窗口长度（毫秒）
local limit  = tonumber(ARGV[3])
local id     = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window) -- 清掉滑出窗口的旧记录
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, id)
  redis.call('PEXPIRE', key, window) -- 冷 key 自动过期，不常驻内存
  return {1, limit - count - 1, 0}
end
-- 被限流：算最早一条记录还有几秒滑出窗口
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry  = math.ceil((window - (now - tonumber(oldest[2]))) / 1000)
if retry < 1 then retry = 1 end
return {0, 0, retry}
`;

export async function slidingWindowLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<LimitResult> {
  const now = Date.now();
  const [allowed, remaining, retryAfterSec] = (await redis.eval(
    SLIDING_WINDOW_LUA,
    1,
    key,
    now,
    windowMs,
    limit,
    `${now}:${Math.random()}`, // 唯一 id，防同毫秒请求互相覆盖
  )) as number[];

  return { allowed: allowed === 1, remaining, retryAfterSec };
}
```

关键在整段 Lua：五个动作一次跑完，中间不可能插进别的请求。`retryAfterSec` 不是拍脑袋给的，是根据窗口里最早那条记录算出来的精确等待时间，后面塞进 Retry-After 头。

### 3. 双维度限流与 NestJS Guard

单一维度不够。只按用户限，一个 500 人的租户每人每分钟 10 次，合计 5000 次/分，个个合规，账单照样爆。只按租户限，大租户里一个恶意账号能把全公司的额度吃光。所以 user_id 和 tenant_id 各设一道闸：用户级 10 次/分，租户级 1000 次/时，先撞哪道拦哪道。

被限流时返回 429，并且必须带 `Retry-After` 头。不带的话，客户端的默认行为往往是立刻重试，你限了流反而换来一轮重试风暴。

### 4. 配额体系：限流管快慢，配额管总量

限流挡不住细水长流：每分钟 9 次、永远不碰 10 次的线，一个月也能打三十多万次。配额管月度总量，也是免费/付费档位的分界线，SaaS 商业化的地基就码在这张表上。

```ts
// quota.ts —— 月度配额表 + 超额降级
export type Plan = "free" | "pro" | "enterprise";

export const PLANS: Record<Plan, { monthlyCalls: number; degradeTo: string | null }> = {
  free:       { monthlyCalls: 100,    degradeTo: "gpt-4o-mini" }, // 超额降级到小模型
  pro:        { monthlyCalls: 10_000, degradeTo: "gpt-4o-mini" },
  enterprise: { monthlyCalls: 100_000, degradeTo: null },         // 超额硬拒绝
};

export async function consumeQuota(
  tenantId: string,
  plan: Plan,
): Promise<"as-is" | string> {
  const month = new Date().toISOString().slice(0, 7); // "2026-09"，一月一个计数器
  const key = `quota:${tenantId}:${month}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, 32 * 86_400); // 次月自动过期，不用跑清理任务

  const { monthlyCalls, degradeTo } = PLANS[plan];
  if (used <= monthlyCalls) return "as-is"; // 额度内，正常调用
  if (degradeTo) return degradeTo;          // 超额降级：转小模型，服务不断、体验降级
  throw new Error("本月配额已用完，请联系商务扩容"); // 企业档超额：拒绝
}
```

超额策略分两档：免费档降级到小模型，服务不断、质量变差，顺便变成付费转化的话术；付费档直接拒绝并提示扩容，因为人家付的钱对应明确的资源边界。降级还是拒绝是产品决策，代码上只是两个分支。

### 5. 异常防御：分级超时与重试上限

LLM 接口的 P99 可能到 30 秒。所有调用一刀切设 5 秒超时，正常的慢请求会被误杀；一刀切设 120 秒，故障时连接堆满拖垮整个服务。分级超时按任务类型拆：分类改写 5 秒，普通对话 30 秒，深度推理 120 秒。

重试守第 13 周容错的老规矩：只重试确定没成功的操作（连接被拒、429），超时属于「结果未知」，重试前想清楚会不会重复扣费；重试次数有上限，2 次封顶；间隔用指数退避，给下游喘气的时间。

## 动手任务：限流中间件一步一步

手册任务：BFF 层实现基于 Redis 的限流，Agent 层加超时和重试上限。拆成 5 步，全程约 30 分钟。

**第 1 步：装依赖、建文件。** 在项目里执行 `npm install ioredis`，把第 2 步的 `rate-limiter.ts` 建好，再新建 `rate-limit.guard.ts` 和 `agent-guard.ts`。

**第 2 步：写滑动窗口限流器。** 代码就是核心知识第 2 节那份，原样抄进 `rate-limiter.ts`。注意 Lua 里 `PEXPIRE` 只在放行时刷新：一段时间没人请求，key 自动消失，窗口从零开始，这正是想要的行为。

**第 3 步：写 Guard 并全局注册。** 路由用装饰器声明限额，Guard 里叠加租户级闸门：

```ts
// rate-limit.guard.ts
import {
  CanActivate, ExecutionContext, HttpException, HttpStatus,
  Injectable, SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { slidingWindowLimit } from "./rate-limiter";

export const RATE_LIMIT_KEY = "rateLimit";
export const RateLimit = (limit: number, windowMs: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowMs });

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<{ limit: number; windowMs: number } | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!options) return true; // 没声明限额的接口直接放行

    const http = context.switchToHttp();
    const req = http.getRequest<{ headers: Record<string, string> }>();
    const userId = req.headers["x-user-id"];
    const tenantId = req.headers["x-tenant-id"];
    if (!userId || !tenantId) return true; // 鉴权层应已保证，这里兜底

    // 双维度：用户级按路由声明（默认 10 次/分），租户级固定 1000 次/时
    const user = await slidingWindowLimit(
      `rl:user:${userId}`, options.limit, options.windowMs,
    );
    const tenant = await slidingWindowLimit(
      `rl:tenant:${tenantId}`, 1000, 3_600_000,
    );

    const blocked = !user.allowed ? user : !tenant.allowed ? tenant : undefined;
    if (blocked) {
      const res = http.getResponse<{ setHeader: (n: string, v: string) => void }>();
      res.setHeader("Retry-After", String(blocked.retryAfterSec));
      throw new HttpException(
        { code: 42901, message: "请求过于频繁，请稍后再试" },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
```

```ts
// app.module.ts —— 全局注册，所有路由自动过闸
import { APP_GUARD } from "@nestjs/core";

@Module({
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}

// 某个控制器里这样声明限额
// @Post("chat")
// @RateLimit(10, 60_000) // 用户级：10 次/分钟
// chat() { ... }
```

**第 4 步：Agent 层三道保险。** BFF 限流防的是「人」，Agent 内部的循环调用不走 HTTP，Guard 看不见，必须自己设防：

```ts
// agent-guard.ts
import { redis } from "./rate-limiter";

const MAX_STEPS = 50; // 每会话步数上限，ReAct 循环的硬顶

export async function assertSessionBudget(sessionId: string): Promise<void> {
  const key = `session:${sessionId}:steps`;
  const steps = await redis.incr(key);
  if (steps === 1) await redis.expire(key, 86_400); // 一天后自动清零
  if (steps > MAX_STEPS) {
    throw new Error(`本会话已执行 ${MAX_STEPS} 步，请开启新会话`);
  }
}

// 分级超时：LLM 的 P99 可能到 30 秒，一刀切要么误杀要么拖垮
export type LlmTask = "fast" | "chat" | "deep";
const TIMEOUT_MS: Record<LlmTask, number> = {
  fast: 5_000,
  chat: 30_000,
  deep: 120_000,
};

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`调用超时（${ms}ms）`)), ms),
    ),
  ]);
}

// 重试上限 2 次 + 指数退避，只用于幂等或可接受重复扣费的调用
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  task: LlmTask,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await withTimeout(fn(), TIMEOUT_MS[task]);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); // 500ms、1s
      }
    }
  }
  throw lastError;
}

// Agent 每一步开头都过这两道：先查步数预算，再带着超时和重试上限调 LLM
// await assertSessionBudget(sessionId);
// const reply = await callWithRetry(() => llm.complete(prompt), "chat");
```

**第 5 步：打满额度验证。** 把 BFF 服务跑起来，用同一个 user-id 连打 12 次 `/chat`，亲眼看第 11 次开始变 429。

::: tip 验证命令
```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    -H "x-user-id: u1" -H "x-tenant-id: t1" \
    http://localhost:3000/chat
done
```
前 10 行应是 200，后 2 行是 429。想看 Retry-After 头，把 `-o /dev/null -w "%{http_code}\n"` 换成 `-i`。租户级闸门要打满 1000 次才拦，不必硬测，代码路径和用户级完全相同。
:::

## 常见踩坑

**坑 1：拿固定窗口顶包。** 限每分钟 100 次，攻击者在 10:00:59 打 100 个、10:01:01 再打 100 个，2 秒 200 个穿堂过。固定窗口的实现只要三行，这个便宜恰恰是它的陷阱。防的是突刺就得用滑动窗口或令牌桶，固定窗口只配管签到。

**坑 2：判断和写入分开写。** ZCARD 一下、再 ZADD 一下，单线程调试时完美无缺，一上并发就漏。限流逻辑天生跑在高频路径上，竞态不是会不会遇到的问题，是几点钟遇到的问题。凡是「先查后写」的计数逻辑，一律进 Lua。

**坑 3：只在 BFF 层设防。** 用户一分钟发 1 条消息，规规矩矩，但他那条消息触发的 Agent 循环内部跑了 200 步 LLM 调用，全都不走 HTTP，Guard 睁眼瞎。BFF 限流防爬虫，会话步数上限防自己，两层各防各的，缺一不可。这就是手册里说的双保险。

**坑 4：429 不带 Retry-After。** 客户端收到 429，不知道等多久，默认行为是立刻再打，你限流的收益被重试吃光，还雪上加霜。服务端带好 Retry-After，客户端也得配合：读到 429 就按头里的秒数等，等不及就直接熔断。这是个双边协议，只做一半等于没做。

**坑 5：对超时无脑重试。** LLM 调用超时 5 次，重试 5 次，最坏 6 次扣费，而且第一次可能已经在服务端完成了。超时是「结果未知」，不是「确定失败」。连接被拒、收到 429 这类确定没成功的才放心重试；超时的要么带幂等键去重，要么把次数压到最低并接受偶尔重复扣费。上限 2 次、指数退避，是给下游也是给自己的钱包留活路。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 固定窗口的临界突刺是怎么产生的？滑动窗口和令牌桶各自怎么解决它？

::: details 参考答案
突刺出在窗口交界：两个相邻窗口各自合规，交界处 2 秒内能塞进双倍流量。滑动窗口让边界随当前时刻滑动，靠「只数最近 60 秒」消灭了交界；令牌桶不关心窗口边界，靠桶容量 b 给瞬时突发封顶，攒多少最多花多少。
:::

2. 限流的判断和写入为什么必须放进 Lua 脚本？不用会发生什么？

::: details 参考答案
分开写是 check-then-act 竞态：两个并发请求同时读到计数 9、都判断未超限、都写入，窗口里进来 11 个。Redis 执行 Lua 期间不插入其他命令，清理、计数、判断、写入、设过期一次跑完，天然原子。第 6 周分布式锁的解锁逻辑用的是同一招。
:::

3. 用户级 10 次/分和租户级 1000 次/时各防什么？去掉租户级会怎样？

::: details 参考答案
用户级防单个账号刷接口，租户级防「每个用户都合规、加起来爆账单」。去掉租户级，500 人的租户每人每分钟打 9 次，合计 4500 次/分，没有一个人触发限流，成本照样失控。双维度的本质是：速率风险的聚合单位不只是单个用户。
:::

4. 429 响应里的 Retry-After 头起什么作用？客户端拿到后该怎么做？

::: details 参考答案
告诉客户端多少秒后再试，值由服务端根据限流窗口精确算出（本篇是窗口内最早一条记录滑出窗口的时间）。客户端读到 429 应按该秒数等待后重试，或多轮 429 直接熔断降级。不带这个头，客户端会立刻重试，形成重试风暴。
:::

5. LLM 补全接口超时之后能不能直接重试？判断标准是什么？

::: details 参考答案
不能无脑重试。超时属于结果未知：请求可能已在服务端完成并扣费，重试等于二次付费。标准是第 13 周的幂等原则——连接被拒、429（按 Retry-After 等待后）这类确定没成功的可以重试；超时的要么带幂等键让服务端去重，要么控制次数并接受偶尔重复扣费的代价。
:::

## 延伸阅读

- [Redis 官方文档：Eval scripts](https://redis.io/docs/latest/commands/eval/)，Lua 脚本在 Redis 里的执行语义，「脚本执行期间不插入其他命令」的官方原始出处
- [MDN：HTTP 429 Too Many Requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429)，429 与 Retry-After 的标准语义，客户端和服务端都该读一遍
- [NestJS 官方文档：Guards](https://docs.nestjs.com/guards)，Guard 的执行时机、Reflector 取路由元数据、APP_GUARD 全局注册的权威说明

今天的产出 `rate-limiter.ts` 和 `rate-limit.guard.ts` 留好，往后任何要挂到公网的服务，这两个文件都是上线清单的第一项：限流配额做完，钱包才算穿上了裤子。
