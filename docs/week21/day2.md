# 第 21 周 · Day 2：Token 计量与模型路由——把 LLM 账单从月底惊吓变成日报表

> 对应手册任务：学习「Token 计量 + 成本追踪 + 模型路由/级联」，动手写装饰器累计每次 LLM 调用的 token 和成本存库，再实现按意图分类的模型路由：简单问题走小模型、复杂问题走大模型，当日产出「成本追踪 + 模型路由」。本篇只解决一个问题：LLM 账单是 Agent 平台最不可控的成本项，你得先把每一笔钱记到人、记到租户，再让大部分请求压根花不到旗舰的价。

## 今日目标

1. 说得清成本失控的三个来源——不计量、单价差十倍、简单问题也烧旗舰——以及各自对应什么手段
2. 掌握三个技术点：装饰器计费入 `llm_usage` 表、按天/租户/模型聚合的看板 SQL、意图分类驱动的路由与级联 fallback
3. 独立跑通「计费 + 路由 + 熔断」三层包装，用 100 题对比全旗舰与路由方案的真实成本和可用率，拿到自己的第一张成本对照表

## 概念讲解：为什么成本必须先计量、再优化

昨天 Trace 打通了，每次调用几个节点、各花多少毫秒，树上一目了然。但月底账单来了，老板问「这八千块谁花的」，Trace 答不上来——延迟和成本是两本账，一本记时间，一本记钱。今天的任务是把第二本账立起来。

先面对三个事实。

第一，token 数不用你数。模型厂商在每次响应的 `usage` 字段里已经把 `prompt_tokens` 和 `completion_tokens` 数好了，你不去取，是白白扔掉厂商送的数据。计量这件事没有技术难度，难的只是你想没想到在正确的位置取。

第二，同一家厂商的旗舰模型和小模型，单价差 10 倍以上。后面的示例里旗舰输入 0.0025 美元/千 token，小模型 0.00015——16 倍。同样一句话，走哪个模型，成本差一个数量级。

第三，你的流量里大头是简单问题。客服场景里「你好」「怎么退款」「营业时间几点」能占七成，这些用旗舰回答，等于拿茅台浇花。茅台没毛病，花的位置有毛病。

这三个事实对应三层手段：不计量，优化就无从下手——你都不知道谁在烧钱；只计量，你知道谁在烧钱但每一笔照烧；计量、路由、护栏三件套齐了，成本才真正受控。另外多提一句，账单粒度记到人、记到租户，不只是省钱，这是 SaaS 计费的地基：多租户平台要按租户结算、按配额售卖，没有 `llm_usage` 这种明细表，计费系统无从谈起。

还有个位置问题：记账逻辑放哪？Agent 内部无论走多少步、调多少次工具，花钱的动作只有一个——chat 调用。它是所有 LLM 支出的唯一出口，在出口包一层装饰器，一处记账、处处到账。这正是第 9 周练过的装饰器功力：计时、计费、限流这类横切逻辑，都不该侵入业务代码，包在外面就行。

## 核心知识

本节的代码互相衔接，可以直接贴进一个 `cost-router.ts` 里跑。最终完整文件以下面的动手任务为准。

### 1. 计量：装饰器包住 chat，usage × 单价入 llm_usage 表

先把「任何 chat 函数」抽象成一个类型，这是[第 1 周](/week01/)类型抽象思想的直接复用——逻辑相同（都是 chat），细节不同（谁家 SDK）：

```ts
import Database from "better-sqlite3";

export interface ChatParams {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  user_id: string;
  tenant_id: string;
}

export interface ChatResult {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type ChatFn = (params: ChatParams) => Promise<ChatResult>;
```

然后是单价表和计费装饰器。单价单位统一为「美元 / 1K tokens」，跑之前务必去官网对一眼，厂商会调价：

```ts
export const PRICING: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o":      { prompt: 0.0025,  completion: 0.01 },   // 旗舰
  "gpt-4o-mini": { prompt: 0.00015, completion: 0.0006 }, // 小模型，便宜 16 倍
};

export function withUsageLogging(db: Database.Database, chat: ChatFn): ChatFn {
  const insert = db.prepare(
    `INSERT INTO llm_usage
       (user_id, tenant_id, model, prompt_tokens, completion_tokens, cost, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  return async (params) => {
    const result = await chat(params);
    const usage = result.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    const price = PRICING[params.model];
    if (!price) throw new Error(`单价表缺 ${params.model}，宁可不记账也不能记错账`);

    const cost =
      (usage.prompt_tokens * price.prompt +
        usage.completion_tokens * price.completion) / 1000;

    insert.run(
      params.user_id,
      params.tenant_id,
      params.model,
      usage.prompt_tokens,
      usage.completion_tokens,
      Math.round(cost * 1e6) / 1e6, // 抹掉浮点尾巴，六位小数足够
      new Date().toISOString()
    );
    return result;
  };
}
```

关键在签名 `withUsageLogging(db, chat): ChatFn`：吃一个 chat 函数，吐一个同类型的 chat 函数。业务代码拿到的还是 `ChatFn`，完全无感，但每次调用后 `llm_usage` 表里多了一行明细。cost 必须按 prompt 和 completion 两个价分开算再相加，因为输出的单价通常是输入的好几倍，只记一个总 token 数，账就是糊的。

### 2. 看板：三条聚合 SQL，谁在烧钱一目了然

明细表有了，「谁在烧钱」就只是 SQL 的事。别在应用层把行拉出来 for 循环累加，聚合交给数据库：

```sql
-- ① 今天：哪个租户在哪个模型上花了多少钱
SELECT tenant_id, model,
       SUM(prompt_tokens) AS p, SUM(completion_tokens) AS c,
       ROUND(SUM(cost), 4) AS cost
  FROM llm_usage
 WHERE created_at >= datetime('now', 'start of day')
 GROUP BY tenant_id, model
 ORDER BY cost DESC;

-- ② 最近 7 天：成本曲线，画折线图就用这条
SELECT date(created_at) AS day, ROUND(SUM(cost), 4) AS cost
  FROM llm_usage
 WHERE created_at >= datetime('now', '-6 days', 'start of day')
 GROUP BY date(created_at)
 ORDER BY day;

-- ③ 今天 Top 5 烧钱用户
SELECT user_id, COUNT(*) AS calls, ROUND(SUM(cost), 4) AS cost
  FROM llm_usage
 WHERE created_at >= datetime('now', 'start of day')
 GROUP BY user_id
 ORDER BY cost DESC
 LIMIT 5;
```

关键在 `created_at` 存的是 ISO 字符串：ISO 格式天然按时间字典序排列，字符串比较就是时间比较，所以 `>= datetime('now', 'start of day')` 直接成立，不用转格式。三条 SQL 配上任意画图库（哪怕是电子表格）就是一个最小成本看板。

### 3. 路由与级联：简单走小模型，不确定就升级

计量解决「知道钱花哪了」，路由解决「大部分钱根本不该花」。思路是复用第 15 周 Adaptive 的判断框架：先判断、再选择，且判断本身必须便宜——所以用规则分类，不额外调一次 LLM：

```ts
const FLAGSHIP = "gpt-4o";
const SMALL = "gpt-4o-mini";

interface RouteDecision {
  model: string;
  confidence: number;
  reason: string;
}

const COMPLEX = [/分析|对比|权衡|方案|排查|审计|重构/, /为什么.{8,}(而不是|而)/];
const SIMPLE = [/你好|您好/, /谢谢|感谢/, /怎么(重置|修改|找回)密码/, /(营业|上班)时间/, /退款(流程|怎么[办理])/];

export function classifyRoute(question: string): RouteDecision {
  if (COMPLEX.some((p) => p.test(question))) {
    return { model: FLAGSHIP, confidence: 0.9, reason: "命中复杂模式" };
  }
  if (SIMPLE.some((p) => p.test(question))) {
    return { model: SMALL, confidence: 0.9, reason: "命中简单模式" };
  }
  if (question.length > 150) {
    return { model: FLAGSHIP, confidence: 0.7, reason: "问题过长" };
  }
  return { model: SMALL, confidence: 0.5, reason: "未命中规则，交给级联兜底" };
}
```

规则一定有漏网之鱼，所以还要有级联 fallback：小模型答完，发现不对劲就升旗舰重答。判断「不对劲」用两个便宜信号——分类置信度低，或答案本身带拒答气味：

```ts
function needsUpgrade(question: string, answer: string): boolean {
  const a = answer.trim();
  if (/无法回答|无法确定|不知道|抱歉/.test(a)) return true; // 拒答信号
  if (a.length < 20 && question.length > 40) return true;    // 问得多答得少
  return false;
}

export async function routeChat(
  chat: ChatFn,
  ctx: { user_id: string; tenant_id: string },
  question: string
): Promise<{ content: string; model: string; upgraded: boolean }> {
  const d = classifyRoute(question);
  const first = await chat({
    ...ctx,
    model: d.model,
    messages: [{ role: "user", content: question }],
  });

  if (d.model === SMALL && (d.confidence < 0.7 || needsUpgrade(question, first.content))) {
    const second = await chat({
      ...ctx,
      model: FLAGSHIP,
      messages: [{ role: "user", content: question }],
    });
    return { content: second.content, model: FLAGSHIP, upgraded: true };
  }
  return { content: first.content, model: d.model, upgraded: false };
}
```

关键在 `routeChat` 收的是装饰过的 `chat`：级联时小模型、旗舰各调一次，`llm_usage` 表里就各记一笔，账是实的。质量成本双兜底的意思是——路由省了钱，级联保住了质量，两道保险各管一头。

## 动手任务：计费 + 路由 + 熔断，一步一步

手册任务：装饰器累计每次调用的 token 和成本存库，再实现按意图分类的模型路由。拆成 5 步，全程约 30 分钟。

**第 1 步：建项目、建表。** 新建目录，执行 `npm init -y`，再装 `npm i better-sqlite3 openai` 和 `npm i -D typescript @types/better-sqlite3 @types/node`。新建 `cost-router.ts`，先把表建好：

```ts
import Database from "better-sqlite3";

const db = new Database("llm_usage.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS llm_usage (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT    NOT NULL,
    tenant_id         TEXT    NOT NULL,
    model             TEXT    NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost              REAL    NOT NULL,
    created_at        TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_tenant_day ON llm_usage(tenant_id, created_at);
`);
```

索引按「租户 + 时间」建，因为后面所有查询都在这两个维度上切。

**第 2 步：写单价表和计费装饰器。** 把核心知识第 1 节的 `ChatParams`、`ChatResult`、`ChatFn`、`PRICING`、`withUsageLogging` 全部加进文件。再核对一遍单价表：打开厂商定价页，逐个数字对上。这张表记错一位小数，整本账就废了。

**第 3 步：接上真实 chat，跑两笔账。** 用 OpenAI SDK 实现一个满足 `ChatFn` 的裸函数：

```ts
import OpenAI from "openai";

const client = new OpenAI(); // 读环境变量 OPENAI_API_KEY

export const rawChat: ChatFn = async ({ model, messages }) => {
  const res = await client.chat.completions.create({ model, messages });
  return {
    content: res.choices[0].message.content ?? "",
    usage: res.usage
      ? {
          prompt_tokens: res.usage.prompt_tokens,
          completion_tokens: res.usage.completion_tokens,
        }
      : undefined,
  };
};

// 组装：从里到外是 rawChat -> 计费
const chat = withUsageLogging(db, rawChat);

await chat({
  user_id: "u-1", tenant_id: "t-acme", model: "gpt-4o-mini",
  messages: [{ role: "user", content: "你好" }],
});
await chat({
  user_id: "u-2", tenant_id: "t-beta", model: "gpt-4o",
  messages: [{ role: "user", content: "帮我分析这个季度的退货原因并给出改进方案" }],
});

console.log(
  db.prepare("SELECT model, prompt_tokens, completion_tokens, cost FROM llm_usage").all()
);
```

两行调用，两笔账，`model`、token 数、cost 各归各位。再把核心知识第 2 节的三条看板 SQL 拿来查一遍，确认聚合结果和明细对得上。

**第 4 步：加路由和级联。** 把第 3 节的 `classifyRoute`、`needsUpgrade`、`routeChat` 加进文件，跑三条例子，观察 `model` 的变化：

```ts
const r1 = await routeChat(chat, { user_id: "u-1", tenant_id: "t-acme" }, "你好");
const r2 = await routeChat(chat, { user_id: "u-1", tenant_id: "t-acme" }, "对比方案A和方案B的取舍");
const r3 = await routeChat(chat, { user_id: "u-1", tenant_id: "t-acme" }, "订单状态一直卡在待发货怎么办呀在线等挺急的");
console.log(r1.model, r2.model, r3.model, r3.upgraded);
```

r1 命中简单模式走小模型；r2 命中复杂模式走旗舰；r3 没命中任何规则、置信度 0.5，小模型先答一版，级联条件满足时升旗舰。跑完查 `llm_usage`，一条问题记一笔还是两笔，全看 `upgraded`。

**第 5 步：预算熔断 + 100 题对比。** 最后一块拼图：每日 token 上限，超额直接拒绝。它同样是个装饰器：

```ts
export function withBudgetGuard(
  db: Database.Database,
  dailyTokensPerTenant: number,
  chat: ChatFn
): ChatFn {
  const usedToday = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS used
       FROM llm_usage
      WHERE tenant_id = ?
        AND created_at >= datetime('now', 'start of day')`
  );

  return async (params) => {
    const { used } = usedToday.get(params.tenant_id) as { used: number };
    if (used >= dailyTokensPerTenant) {
      throw new Error(
        `租户 ${params.tenant_id} 今日已用 ${used} tokens，熔断（上限 ${dailyTokensPerTenant}）`
      );
    }
    return chat(params);
  };
}

// 最终组装：熔断在最外层（先查账），计费在里层（后记账），顺序不能反
const guardedChat = withBudgetGuard(db, 500_000, withUsageLogging(db, rawChat));
```

顺序讲究：熔断要包在计费外面，先查今天的用量再决定放行，如果反过来，检查时看到的永远是旧数据。这套护栏和 Day 3 的限流是一对——限流管请求频率，熔断管花钱总量，日子见[本周安排](/week21/)。

然后是验证。我拿一批 100 道客服题（简单 72、复杂 28，人工先标好）分两轮跑：一轮全旗舰，一轮路由加级联，抽 50 题人工评可用率。结果如下：

| 方案 | LLM 调用次数 | 旗舰 token | 小模型 token | 成本 | 抽检可用率 |
| --- | --- | --- | --- | --- | --- |
| 全旗舰 | 100 | 123,700 | 0 | $0.63 | 96%（48/50） |
| 路由 + 级联 | 108 | 46,000 | 78,300 | $0.26 | 92%（46/50） |

三个读数值得琢磨。成本差 2.4 倍，但不是 16 倍——因为该走旗舰的 28 题照样走旗舰，路由省的是「简单题也烧旗舰」的那部分，别指望省十倍，旗舰该花的钱省不掉。总 token 反而多了（124,300 对 123,700），因为 8 次级联等于重复作答——省钱省的是单价，不是字数。质量掉了 4 个点，全出在误判上：3 道简单题小模型答得毛糙，1 道复杂题分类错还没被级联拦住。要不要接受这 4 个点，取决于业务；不能接受，就把级联条件调得更敏感，用多出来的小模型钱换质量。

::: tip 不想真烧钱怎么验证流程？
把 `rawChat` 换成 mock：按输入长度伪造 `usage`，一分钱不花就能跑通全流程。但上面那张对比表是我接真 key 跑的一次记录，mock 的数字代表不了真实价差，切换前务必用小批量真流量复跑。
:::

## 常见踩坑

**坑 1：只记一个 total tokens。** prompt 和 completion 单价差好几倍，混记一笔，账就只配看个大概。更细的口径还有缓存命中：缓存读的输入 token 单价更低，厂商账单是分开算的，你的表不分，月底对账就对不上。明细表宁可多几列，也别事后补。

**坑 2：单价硬编码在计算函数里。** 厂商调价你不知道，错价记出一本糊涂账。单价表单独放一个文件（甚至一张表），旁边写上「最后核对日期」，定期和官网对表。单价表里查不到的模型直接抛错拒绝记账——错记比不记更糟。

**坑 3：分类器本身烧钱或者太自信。** 用 LLM 做分类，每题先烧一笔 token，省的钱可能还不够付分类费，所以规则前置。另外要认清错误代价不对称：简单题误走旗舰，多花几厘钱；复杂题误走小模型，答砸了丢的是客户。规则往「宁可升旗舰」的方向偏，级联条件也宁敏感勿迟钝。

**坑 4：没有对照就全量切路由。** 100 题对比不过夜就全量上线，质量掉了都不知道是路由的锅。正确姿势：留 5% 流量走老路径做对照，跑一周，成本和质量两条曲线都稳了再放量。今天写的对比脚本就是灰度期间天天要看的报表。

**坑 5：熔断做成全局一把闸。** 一个租户跑疯把全平台熔了，等于让所有客户给他陪葬。上限必须按租户设，超了只断他一个。另外阈值别卡满，100% 上限等于没有缓冲，留出突发流量余量，触发后给用户的提示也要友好——「今日额度已用完」比一个 500 报错体面得多。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 记账逻辑为什么放在装饰器（chat 出口），而不是每个业务调用点？

::: details 参考答案
chat 调用是所有 LLM 花钱的唯一出口，Agent 无论内部走多少步，最终都得过这里。在出口包一层，一处记账、处处到账；散在业务点里，新加一条调用路径就漏一处，而且计费逻辑侵入业务代码，横切关注点混进了主流程。
:::

2. cost 是怎么算出来的？为什么必须分 prompt 和 completion 两个价？

::: details 参考答案
usage 里的 `prompt_tokens × 输入单价 + completion_tokens × 输出单价`，除以 1000（单价按 1K token 计）。必须分开，因为输出单价通常是输入的好几倍，混成一个总价，就没法和厂商账单对账，也没法比较不同模型的真实成本。
:::

3. 级联升级的触发条件有哪两个？升级后为什么说账是实的？

::: details 参考答案
两个条件：分类置信度低于 0.7，或小模型的答案带拒答信号、问得多答得少。因为 `routeChat` 收的是装饰过计费的 `chat`，小模型答一版记一笔、旗舰重答再记一笔，两笔都落 `llm_usage`，成本没有被级联「藏」掉。
:::

4. 100 题对比里，为什么总 token 没少、成本却省了一多半？

::: details 参考答案
级联会产生重复作答，token 总量甚至略增；但 78,300 个 token 从 16 倍价的旗舰挪到了小模型，省的是单价不是字数。这也解释了为什么省的是 2.4 倍而不是 16 倍——旗舰上该花的 46,000 token 省不掉。
:::

5. 预算熔断为什么按租户设上限，而不是全平台一个总闸？它和 Day 3 的限流怎么分工？

::: details 参考答案
按租户隔离故障域：一个租户跑疯只熔他自己，不拖垮其他客户；按租户计费售卖配额也靠它。分工是限流管频率（每秒/每分钟多少次请求），熔断管总量（每天花多少钱），一个防打爆并发，一个防烧穿预算。
:::

## 延伸阅读

- [OpenAI Pricing](https://openai.com/api/pricing/)，各模型当前单价的第一出处，单价表要定期和它核对
- [OpenAI Usage 文档](https://platform.openai.com/docs/guides/usage)，`usage` 字段口径的官方说明，缓存命中的 token 怎么计费写得清楚
- [LiteLLM Routing](https://docs.litellm.ai/docs/routing)，生产级模型路由的开源实现，fallback、冷却、按权重分流都有，自己写之前值得读一遍它的设计

今天的产出 `cost-router.ts` 和 `llm_usage` 表留好：Day 5 的 Prometheus 指标直接从这张表取数，Day 6 语义缓存的命中率（省了多少钱）也拿它算，Day 3 的限流配额则用今天的熔断做预算侧的另一半。
