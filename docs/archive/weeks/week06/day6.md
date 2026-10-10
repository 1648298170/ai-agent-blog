# 第 6 周 · Day 6：幂等性设计——唯一约束 + 幂等键，让重复请求只生效一次

> 对应手册任务：学习「幂等性设计：唯一约束 + 幂等键」，动手为「创建订单」接口实现基于 `idempotency-key` 的幂等控制，当日产出「幂等接口」。本篇只解决一个问题：同一个请求因为超时重试、连点、队列重发到达多次时，订单只能创建一张、款只能扣一次。这是本周四件套的收口一讲。

## 今日目标

1. 说得清幂等的定义，以及 PUT、DELETE 天然幂等、POST 为什么不是
2. 掌握四种实现路线的取舍，重点吃透「去重表 + 幂等键」这条主流路线
3. 独立完成带 `Idempotency-Key` 的创建订单接口：重试拿到首次结果，撞上「处理中」拿到 409，并验证唯一约束兜底

## 概念讲解：为什么需要幂等

先看一笔冤枉账。用户点「提交订单」，`POST /orders` 要做风控、锁库存、扣款，2 秒才能回。网关 1 秒断了连接，客户端认定失败，自动重试。服务端这边第一个请求没死，2.5 秒处干完返回了 201；第二个请求随后到达，又跑一遍完整流程。结果：两张一模一样的订单，扣了两次款，而用户只点了一次。

重复请求不止这一个来源。前端重试库超时重发，用户手抖连点，还有 Day 5 配的 `attempts: 3`——换个视角想，消费者也可能把同一个 job 收两次。队列的承诺是「至少一次投递」，重试是它的天职，重复就是它的代价。

幂等（idempotency）就是为重复而生的性质：**执行一次，与执行任意多次，效果相同。** 数学上写作 f(f(x)) = f(x)。「效果」指系统外部可见的状态——订单几张、款扣多少，不是「返回了几个响应」。

不是所有接口都要为此操心。GET 只读不写，天然幂等。PUT 是「全量设为某个值」，执行一次和多次，最终状态都是那个值；DELETE 删一次和删多次，最终状态都是「不存在」，也都天然幂等。唯独 POST 的语义是「创建新资源」，执行 n 次就创建 n 个。所以幂等设计的主战场就是 POST，以及一切「只该发生一次」的动作：支付、扣减、转账、发消息。

最后跟 Day 3 的分布式锁分清楚。锁解决「同时」，同一时刻只放一个进去；幂等解决「再次」，隔了几分钟又来一遍，照样只认第一次。重试的两连击之间，锁早就释放了。锁防住了「多人抢同一份库存」，防不住「同一个意图被提交两次」，今天补的就是这块。

## 核心知识

本节先建地图，最终以动手任务的完整代码为准。

### 1. 四种实现路线：一张选型地图

| 路线 | 一句话原理 | 能重放首次响应 | 典型场景 |
| --- | --- | --- | --- |
| 唯一约束兜底 | 数据库唯一索引，重复插入直接报错 | 不能，只能拒绝 | 所有写操作的最后一道防线 |
| 去重表 + 幂等键 | 用 key 抢占「首次资格」，记录并重放结果 | 能 | 支付、下单等对外创建接口 |
| 状态机 | 状态只能单向流转，非法流转被拒 | 能，状态本身就是结果 | 订单生命周期、支付回调 |
| Token 机制 | 先领防重令牌，提交时原子删除，删成功才放行 | 不能，只防住本次表单 | 前端表单防连点 |

逐条看：唯一约束零依赖、绝对可靠，但只能拒绝，不能把首次结果还给重试方；状态机靠 `pending → paid → shipped` 这种单向流转挡住非法操作，适合有生命周期的实体；Token 机制先领令牌、提交时原子删除，只防得住一次表单提交。**去重表 + 幂等键**是 Stripe 支付接口同款：既能拒绝重复，又能重放首次响应，体验和正确性都最好。

四条不是单选题。生产系统常常三层叠加：幂等键为主、唯一约束兜底、状态机守生命周期。今天的动手任务做前两层。

### 2. Idempotency-Key：去重表 + 幂等键的完整流程

时序走一遍，共五步：

1. 客户端生成一个 UUID 作为幂等键，第一次发起前生成，之后每次重试都复用同一个。键代表「同一个意图」，不是「同一次请求」，这是整条链路的灵魂。
2. 请求带上 `Idempotency-Key: 3f2a91c2-…` 请求头，打到 `POST /orders`。
3. 服务端先往去重表 INSERT 一行 `(key, status='processing')`。key 上有唯一约束，这步天然原子：插入成功即首次，冲突即来晚了。
4. 抢到资格的请求安心执行业务。完成后把结果写回记录：`status='done'`，连同状态码和响应体一起存进去，再设过期时间。
5. 重试的请求在第 3 步插不进去，转而读记录：done 就把存的响应体原样返回，状态码用首次的，外加 `Idempotent-Replayed: true` 响应头，告诉客户端「这是重放，不是新建」。body 与首次一字不差，订单号都在，断掉的现场就这么恢复了。

注意「先查后插」在这里行不通：

```ts
// 反面教材：check-then-act 竞态
const existing = await repo.findByKey(key);
if (!existing) {
  // 并发的两个请求都查到 null，都通过检查，都往下创建订单
  await repo.insert(key);
}
```

判断和写入必须是一次原子动作：唯一约束的 INSERT 冲突（今天的方案），或 Redis 的 `SET NX`（Day 3 的老朋友）。check 和 set 之间不能有空隙，道理和那一讲同源。

一个细节：业务失败要不要也存？参数错、余额不足这类 4xx，存下来并重放同一个错误，免得重试反复打库；进程崩溃这类意外，记录停在 processing，交给过期清理回收。

### 3. 「首次处理中」：并发窗口里的第二个请求

读记录其实有第三种结果：processing——首次还在干活，同 key 的第二个请求已经到了。这个窗口几毫秒到几秒，处理不好比不处理还坏：把 processing 当 done 返回个空响应，客户端拿到个没有订单号的成功，直接懵掉。

两种正解：

- **回 409 Conflict**，附 `Retry-After: 1`，让客户端稍后再来。简单、不占资源，Stripe 就是这么做的。客户端隔几百毫秒重试，大概率命中 done 拿到缓存。
- **服务端轮询**等 done 再返回缓存结果。客户端一次成功，代价是占着连接干等，还得设等待上限。

推荐第一种，动手任务也这么实现。唯一不能选的是「把 processing 当成功返回」。

### 4. 幂等与分布式锁：分工与配合

- 防的东西：锁防**并发**（同一时刻来多个），幂等防**重放**（隔一阵又来一遍）
- 保护对象：锁保护**资源**（库存、热点行），幂等保护**结果**（意图只生效一次）
- 时间尺度：锁是毫秒到秒，幂等是分钟到天

两者常配合。幂等键管「排队认号」，业务内部再用 Day 3 的锁保护扣库存那一瞬间。有意思的是，幂等抢占本身就靠唯一约束或 SET NX——思想同源，作用面不同：一个锁资源，一个锁「首次资格」。

面试一句话：**「分布式锁保证同一时刻只有一个请求在改，幂等保证同一个请求只生效一次；锁管并发，幂等管重放。支付接口两个都上：锁住扣款那一下，幂等住整个请求。」**

## 动手任务：给「创建订单」加幂等控制，一步一步

手册任务：为「创建订单」接口实现基于 idempotency-key 的幂等控制。拆成 5 步，约 30 分钟，PG 和 Redis 都用本周现成的。

**第 1 步：建两张表。** 在 Prisma schema 里追加两个模型，然后 `npx prisma migrate dev --name add-order-idempotency`：

```prisma
model Order {
  id             String   @id @default(uuid())
  userId         Int      // 类型对齐第 4 周 User 模型的主键
  sku            String
  amount         Int
  idempotencyKey String   @unique // 唯一约束兜底：同 key 的订单插不进第二张
  createdAt      DateTime @default(now())
}

model IdempotencyRecord {
  key          String   @id // 幂等键本身当主键，天然唯一
  userId       Int
  status       String   // processing | done
  statusCode   Int?
  responseBody String?
  createdAt    DateTime @default(now())
  expiresAt    DateTime // 24 小时后过期，清理任务按它删
}
```

关键一行是 `idempotencyKey String @unique`：Order 表上的唯一约束是兜底防线，幂等层哪天出 bug，第二张重复订单也插不进库。key 在去重表里直接当主键，天然唯一。

**第 2 步：写 IdempotencyService。** 新建 `src/orders/idempotency.service.ts`，三个方法各管一段：

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  // 原子抢占：第一次插入成功，同 key 的后来者抛 P2002（唯一约束冲突）
  async tryAcquire(key: string, userId: number) {
    try {
      return await this.prisma.idempotencyRecord.create({
        data: {
          key,
          userId,
          status: 'processing',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return null; // 没抢到：已有同 key 记录
      }
      throw e; // 其他错误照常抛，别吞
    }
  }

  async getByKey(key: string) {
    return this.prisma.idempotencyRecord.findUnique({ where: { key } });
  }

  // 业务做完，把首次响应原样存回去，之后的重试全靠它
  async complete(key: string, statusCode: number, body: unknown) {
    await this.prisma.idempotencyRecord.update({
      where: { key },
      data: {
        status: 'done',
        statusCode,
        responseBody: JSON.stringify(body),
      },
    });
  }
}
```

关键在 tryAcquire 里的 `create`：插入走数据库唯一约束，「判断存在」和「占住这个 key」是一次原子操作，先查后插的竞态从根上不存在了。

**第 3 步：订单接口三段式。** 新建 `orders.service.ts` 和 `orders.controller.ts`，把第 2 小节的流程落下来：

```ts
// orders.service.ts
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

export interface CreateOrderDto {
  sku: string;
  amount: number;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(dto: CreateOrderDto, key: string, userId: number) {
    // 第一段：抢首次资格
    const record = await this.idempotency.tryAcquire(key, userId);
    if (!record) {
      const existing = await this.idempotency.getByKey(key);
      if (existing.userId !== userId) {
        throw new UnauthorizedException('幂等键不属于当前用户');
      }
      if (existing.status === 'done') {
        return {
          replayed: true,
          statusCode: existing.statusCode ?? 201,
          body: JSON.parse(existing.responseBody as string),
        };
      }
      throw new ConflictException('相同请求正在处理中，请稍后重试'); // 409
    }

    // 第二段：干业务（风控、锁库存、扣款该待的地方）
    const order = await this.prisma.order.create({
      data: {
        userId,
        sku: dto.sku,
        amount: dto.amount,
        idempotencyKey: key, // 表上的唯一约束在这兜底
      },
    });
    const body = {
      orderId: order.id,
      sku: order.sku,
      amount: order.amount,
    };

    // 第三段：存首次响应
    await this.idempotency.complete(key, 201, body);
    return { replayed: false, statusCode: 201, body };
  }
}
```

```ts
// orders.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';

@Controller()
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('orders')
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') key: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key) {
      // 没带 key 的 POST 不值得保护，直接打回，Stripe 同款要求
      throw new BadRequestException('创建订单必须携带 Idempotency-Key 请求头');
    }
    const userId = 1; // 演示写死，实际从第 5 周的 JWT 里解出
    const result = await this.ordersService.create(dto, key, userId);
    if (result.replayed) {
      res.setHeader('Idempotent-Replayed', 'true'); // 重放标识
    }
    res.status(result.statusCode);
    return result.body;
  }
}
```

把两个 service 注册进模块的 providers，重启应用，开始验收。

**第 4 步：验证三个场景。** 用本周一直在用的 Postman 新建 POST 请求，Headers 加 `Idempotency-Key`，值手动写死一个 UUID。别用 `{{$guid}}` 动态变量，它每次发送都换新值，正好违反「重试复用同一个 key」。

- 场景一（首次）：发送，得 201，记下 body 里的 orderId。
- 场景二（重试重放）：原样再发一次，得 201，orderId 一字不差，响应头多一行 `Idempotent-Replayed: true`。进 PG 查 `Order` 表，只有一行——这就是「执行多次效果相同」。
- 场景三（处理中 409）：在 `create` 的第二段开头临时加 `await new Promise(r => setTimeout(r, 3000));` 模拟慢业务，重启后 3 秒内连发两次：第一个 3 秒后 201，第二个立刻 409。验证完删掉这行。

**第 5 步：验证唯一约束兜底。** 幂等层是主防线，唯一约束是防线背后的防线。连进 PG（第 4 周的连接方式）直接执行：

```sql
INSERT INTO "Order" (id, "userId", sku, amount, "idempotencyKey", "createdAt")
VALUES (gen_random_uuid(), 1, 'A-1001', 199, 'demo-key', now());

INSERT INTO "Order" (id, "userId", sku, amount, "idempotencyKey", "createdAt")
VALUES (gen_random_uuid(), 1, 'A-1001', 199, 'demo-key', now());
-- ERROR: duplicate key value violates unique constraint "Order_idempotencyKey_key"
```

第二条 INSERT 被数据库当场拒绝。哪怕去重记录被误删、代码漏了校验，重复订单也进不了库。收尾：去重记录不能无限膨胀，用 Day 5 的定时任务每天删一次 `expiresAt` 已过期的行。

::: tip 去重表放 PG 还是 Redis
PG 去重表：响应体可长存、同库可审计、事务一致。Redis（`SET key value NX EX 86400`）：快、自带过期。今天响应要重放、要审计，放 PG 最稳；追求吞吐可以 Redis 做第一道抢占、PG 存最终响应。只有一条红线：别把响应缓存只放 Redis——缓存一丢，重试就穿了。
:::

## 常见踩坑

**坑 1：重试时生成了新的幂等键。** 最常见也最隐蔽。客户端每次请求都 `crypto.randomUUID()` 现生成，服务端看每次都是新 key，次次「首次」，幂等等于没做。key 要跟着「这一次下单意图」走：发起前生成一次存住，重试拦截器里原样复用。

```ts
const key = crypto.randomUUID(); // 生成一次
try {
  await axios.post('/orders', payload, { headers: { 'Idempotency-Key': key } });
} catch {
  // 重试复用同一个 key，千万别重新生成
  await axios.post('/orders', payload, { headers: { 'Idempotency-Key': key } });
}
```

**坑 2：先查后插，窗口期双订单。** `findUnique` 查一下没记录就往下走，并发的两个请求都查到 null、都通过检查、都创建了订单。判断加写入必须原子：唯一约束的 INSERT 冲突，或 `SET NX`。Day 3 讲锁时说的「check 和 set 之间有空隙」，原话照搬到这里依然成立。

**坑 3：只记状态，不存响应体。** 去重表里只有个「已处理」布尔位，重试来了返回空 body，或者现查订单拼个新响应。前者客户端拿着成功找不到订单号，后者首次若失败语义就乱了。三件套一起存：状态码、响应体、完成时间，重放的就是首次原文。

**坑 4：键的维度和生命周期混乱。** 裸全局 key 可能被别的用户撞到甚至冒用，记录里要存 userId，冲突时先校验归属。不设过期，去重表无限膨胀；TTL 要大于客户端最大重试周期（重试器撑 10 分钟，TTL 至少 24 小时），到期靠定时任务清理。

**坑 5：以为上了分布式锁就不需要幂等。** 锁在处理结束后就释放，重试隔一秒再来，畅通无阻；反过来幂等也不限制同时，processing 窗口里该加锁还得加锁。它们回答两个不同的问题，配合着用，谁也替代不了谁。面试就按第 4 小节那句话答。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 一句话给出幂等的定义，并说明 PUT、DELETE 天然幂等而 POST 不是的原因。

::: details 参考答案
定义：执行一次与执行任意多次，系统外部可见的效果相同，即 f(f(x)) = f(x)。PUT 是「全量设为某个值」，DELETE 的最终状态都是「不存在」，均与次数无关；POST 的语义是创建新资源，执行 n 次创建 n 个，所以必须额外设计。
:::

2. 四种实现路线各适合什么场景？为什么支付、下单类接口主流选「去重表 + 幂等键」？

::: details 参考答案
唯一约束做兜底；状态机适合有生命周期的实体；Token 机制防表单连点；去重表加幂等键既能拒绝重复又能重放首次响应。支付类接口的客户端重试需要拿回首次结果（订单号、交易号），只有这条路同时满足「拒绝重复」和「恢复现场」。
:::

3. 同 key 的第二个请求撞上 processing 状态，返回 409 和服务端等待轮询各有什么取舍？

::: details 参考答案
409 加 Retry-After：实现简单、不占连接，代价是客户端多跑一轮重试；等待轮询：客户端一次拿到结果，但服务端占连接干等，还要设上限防止首请求挂死拖垮等待者。实践中推荐 409，Stripe 也这么做；绝不能把 processing 当成功返回空结果。
:::

4. 幂等和分布式锁的区别，面试一句话怎么说清？为什么常配合使用？

::: details 参考答案
锁保证同一时刻只有一个请求在改（防并发），幂等保证同一个请求只生效一次（防重放）；锁保护资源，幂等保护结果。锁释放后重试照样穿透，所以替代不了幂等；幂等抢到资格后，业务里的库存扣减等热点操作仍需要锁。支付接口两个都上。
:::

5. 幂等键由谁生成、何时生成？过期时间怎么定？

::: details 参考答案
由客户端生成，第一次发起请求前生成，之后所有重试复用同一个——key 标识「同一个意图」。服务端生成的 key 关联不起两次重试，没有意义。过期时间要大于客户端最大重试周期（如重试最多 10 分钟，TTL 至少 24 小时），到期由定时任务清理。
:::

## 延伸阅读

- [Stripe：Idempotency Keys](https://docs.stripe.com/api/idempotent_requests)，业界标杆的幂等键实现，本篇流程的直接参照
- [RFC 9110：Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)，HTTP 语义规范对幂等方法的权威定义
- [IETF：Idempotency-Key Header 草案](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)，把该请求头标准化的提案，看业界怎么约定重试与过期

今天的产出「幂等接口」留好。明天 Day 7 周复盘，把四件套画成一张「先问缓存、再抢幂等键、锁住热点资源、慢活进队列」的流程图，这一周就串成一条完整的链了。
