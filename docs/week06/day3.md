# 第 6 周 · Day 3：分布式锁——SET NX PX 加锁，Lua 脚本释放

> 对应手册任务：学习「分布式锁：`SET NX PX` + Lua 脚本释放」，动手实现一个「防止重复提交」的分布式锁，当日产出「防重复提交中间件」（NestJS 里用 Interceptor 落地）。本篇只解决一个问题：用户手速快过服务器，双击「提交订单」发出两个请求，被负载均衡甩到两台机器，单机内存锁各管各的，谁都拦不住谁。要把锁搬到一个所有实例都看得见的地方——前两天刚用熟的 Redis。

## 今日目标

1. 说得清单机内存锁在多实例部署下为什么失效，以及一把合格的分布式锁要同时满足哪几个条件
2. 掌握三个关键点：`SET key value NX PX ms` 一条命令的原子性、value 放随机标识的原因、释放锁为什么必须用 Lua 脚本
3. 独立完成 `LockService` 和防重复提交 `Interceptor`，用两个并发请求亲测：一成一败，第二发被拦在门外

## 概念讲解：为什么需要分布式锁

先看事故现场。下单接口里通常有一段「防重复下单」的检查：

```ts
async create(userId: string, skuId: string) {
  const exists = await this.orderRepo.findUnpaid(userId, skuId);
  if (exists) throw new BadRequestException('已有未支付订单');
  return this.orderRepo.insert({ userId, skuId });
}
```

单线程跑没有任何问题。但用户手快，双击了提交按钮，浏览器在十几毫秒内发出两个请求。列个时间线：

```text
T0       请求 A 查未支付订单：没有
T0+2ms   请求 B 查未支付订单：没有（A 的 insert 还没执行）
T0+8ms   A 执行 insert，订单 1 诞生
T0+9ms   B 执行 insert，订单 2 诞生
```

「先查后插」不是原子的，检查在并发下形同虚设。两个请求都通过了同一道检查，各自放心地往下走，这就是经典的 check-then-act 竞态。

第一反应是加锁，单机内存锁：

```ts
const holding = new Set<string>();

async function create(userId: string, skuId: string) {
  if (holding.has(userId)) throw new BadRequestException('请勿重复提交');
  holding.add(userId);
  try {
    // 查重复 + 插订单
  } finally {
    holding.delete(userId);
  }
}
```

单实例部署时它真的管用。但生产环境为了高可用通常部署多个实例，前面挂负载均衡。双击的两个请求被分流：A 落到实例 1，B 落到实例 2。两个 `holding` 集合躺在两个进程各自的内存里，互相看不见，各自放行。锁，没锁住任何东西。

根子在这：锁是一个「所有竞争者都看得见」的凭证，可见范围必须覆盖全部竞争者。进程内存做不到跨进程可见，实例一多就露馅。而做缓存那两天（回头看 [/week06/](/week06/) 的 Day 1）你已经有了那个所有实例共享的地方——Redis。「谁持有锁」这条信息写进 Redis，一台写，台台能读，互斥才真正成立。这就是分布式锁：用共享存储实现的锁。

## 核心知识

本节的命令可以在 `redis-cli` 里直接敲，代码是 ioredis 写法，客户端连接复用第 1 天 RedisModule 的那个实例。最终完整文件以下面的动手任务为准。

### 1. 加锁：SET NX PX 一条命令

先看错误写法，它曾是无数线上事故的主角：

```bash
SETNX lock:order:1001 1    # key 不存在才设置，成功
EXPIRE lock:order:1001 30  # 再补一个 30 秒过期
```

两条命令之间不是原子的。`SETNX` 刚成功，进程崩了——发布重启、OOM、K8s 探活失败强杀，都可能插在这两行中间。`EXPIRE` 没跑，key 永不过期，后面所有请求 `SETNX` 全部失败，整条业务链路卡死，直到有人半夜爬起来手动删 key。要记住：过期时间不是可选项，它是持有者崩溃时唯一的自救通道，必须和加锁绑死。

正确姿势是 Redis 2.6.12 之后的一条命令：

```bash
SET lock:order:1001 "a1b2c3..." NX PX 30000
```

`NX` 表示 key 不存在才设置（Not eXists），`PX 30000` 表示 30000 毫秒后自动过期。「不存在才设置」和「带过期时间」合为一条命令，要么都生效，要么都不生效，中间不可能被任何事故劈开。返回 `OK` 就是拿到锁，返回 `nil` 就是别人持着。

ioredis 里对应的调用：

```ts
const res = await redis.set('lock:order:1001', token, 'PX', 30000, 'NX');
// res === 'OK' 拿到锁；res === null 没拿到
```

### 2. value 放随机标识，释放用 Lua 脚本

加锁时那个 value，很多人随手写个 `1`，这里埋着第二颗雷。看释放锁的直觉写法 `DEL lock:order:1001`，推演一遍：

```text
T0       A 拿锁成功，TTL 3 秒
T0+3s    A 的业务还没跑完（一条慢 SQL），锁自动过期
T0+3.1s  B 加锁成功
T0+4s    A 业务结束，顺手 DEL——删掉的是 B 的锁
T0+4.1s  C 加锁成功，B 和 C 同时站在临界区里
```

A 删了一把不属于自己的锁。解法分两步。

第一步，value 放每次加锁都不同的随机串（uuid 就行）。相当于在锁上刻持有者的名字，「这锁是不是我的」从此可以判断。

第二步，释放前先 GET 比对，是自己刻的名字才 DEL。但 GET 和 DEL 是两条命令，比对完到 DEL 之间锁恰好过期、被别人拿走，照样误删。比对和删除必须一次完成，这就要 Lua 脚本：

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

Redis 单线程执行脚本，脚本跑完之前不会插入其他客户端的命令，「比对 + 删除」在一个不可分割的小黑屋里完成。两步合起来就是分布式锁释放的标准姿势：随机 value 刻名，Lua 保证认对了人才删。

### 3. 锁过期但业务没跑完：看门狗

TTL 是保底：持有者崩了，锁也会在几秒后自动放出，不会死锁。但它有另一面——业务没崩，只是跑得久（慢查询、下游超时），TTL 先到，锁被回收，别人进场，互斥就破了。

工程上的标准答案是看门狗（watchdog）：拿到锁后起个定时器，每过 TTL 的三分之一左右就检查「锁还是我的就续期」，业务跑多久锁就活多久；业务结束或进程崩了，续期自然停止。Java 的 Redisson 内置这套，Node 生态的锁库大多给 `extend()` 手动续期接口，自己拿 `setInterval` 包一层也不难。

今天不实现看门狗，记两条就够：TTL 必须设，这是防死锁的底线；TTL 设成业务 P99 耗时的好几倍（业务最慢 500ms，TTL 就给 5000ms），把「提前过期」压成小概率，真遇到长任务再上续期。

## 动手任务：防重复提交中间件一步一步

手册任务：封装 `LockService`（acquire / release，释放内置 Lua），再做成 NestJS Interceptor，key 用「用户 + 接口 + 参数摘要」。拆成 5 步，全程约 30 分钟，Redis 实例和客户端连接都用第 1 天现成的。

**第 1 步：LockService。** 在 `apps/api/src/common/lock/` 下新建 `lock.service.ts`：

```ts
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_CLIENT } from '../../redis/redis.module'; // 路径按第 1 天实际位置调整

// 释放锁的 Lua：是自己的锁才删
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

@Injectable()
export class LockService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 尝试加锁。成功返回持有令牌，失败返回 null */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  /** 释放锁。令牌对得上才真正删除，返回是否删成功 */
  async release(key: string, token: string): Promise<boolean> {
    const res = (await this.redis.eval(
      RELEASE_LUA,
      1,
      `lock:${key}`,
      token,
    )) as number;
    return res === 1;
  }
}
```

`acquire` 先生成 token 再当 value 写进去，调用方拿到的就是「锁上刻的名字」。`eval` 的参数依次是：脚本、key 的个数、key 本身、传给脚本的参数。

**第 2 步：注册模块。** 同目录新建 `lock.module.ts`，加进 AppModule 的 imports：

```ts
import { Global, Module } from '@nestjs/common';
import { LockService } from './lock.service';

@Global()
@Module({
  providers: [LockService],
  exports: [LockService],
})
export class LockModule {}
```

连接不在自己手里建，注入第 1 天的 `REDIS_CLIENT`，全进程仍然只有那一条连接。`@Global()` 让业务模块直接注入 `LockService`，不用挨个 import。

**第 3 步：防重复提交 Interceptor。** 同目录新建 `no-duplicate-submit.interceptor.ts`：

```ts
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { Observable, finalize } from 'rxjs';
import { LockService } from './lock.service';

@Injectable()
export class NoDuplicateSubmitInterceptor implements NestInterceptor {
  constructor(private readonly lock: LockService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = (req.user as { id?: string })?.id ?? req.ip ?? 'anon';
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex')
      .slice(0, 16); // 截短，key 别太长
    const key = `submit:${userId}:${req.method}:${req.path}:${bodyHash}`;

    const token = await this.lock.acquire(key, 5000);
    if (!token) {
      throw new HttpException('操作太快，请勿重复提交', HttpStatus.TOO_MANY_REQUESTS);
    }

    return next.handle().pipe(
      finalize(() => {
        // 成功、抛错都会走到这里，相当于 try/finally；void 表示不阻塞响应
        void this.lock.release(key, token);
      }),
    );
  }
}
```

key 的拼法是本篇的文眼：`用户 + 方法 + 路径 + 参数摘要`。同一用户对同一接口、同一份参数，5 秒窗口内只放一个请求进来。参数进了摘要，改过内容的重新提交不会被误拦；用户互不干扰，A 抢到锁不影响 B 下单。TTL 给 5000ms，是第 3 小节「业务 P99 的十倍」那条原则的直接应用。

**第 4 步：挂到下单接口上。**

```ts
import { Body, Controller, Post, UseInterceptors } from '@nestjs/common';
import { NoDuplicateSubmitInterceptor } from 'src/common/lock/no-duplicate-submit.interceptor';

@Controller('orders')
export class OrderController {
  @Post()
  @UseInterceptors(NoDuplicateSubmitInterceptor)
  create(@Body() dto: { skuId: string; count: number }) {
    return this.orderService.create(dto); // 内部还是「查重复 + 插订单」
  }
}
```

**第 5 步：并发验证。** 为了让两个请求必然重叠，先在 `create` 的实现里临时加一句 `await new Promise(r => setTimeout(r, 1000))`，然后起服务，两个请求同时打（Git Bash 或 WSL 里执行）：

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"skuId":"A-1","count":1}' -o /dev/null -w "%{http_code}\n" &

curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"skuId":"A-1","count":1}' -o /dev/null -w "%{http_code}\n" &

wait
```

末尾的 `&` 让两个 curl 并发执行。预期输出一行 `201` 一行 `429`：先到的拿到锁进业务，后到的 `acquire` 拿到 null，被拦截器挡在门外。等几秒再单发第三次，应该稳定 `201`——业务结束锁已释放，正常提交不受影响。验证完删掉那句临时延时。

::: tip 前端也该做
按钮置灰、loading 遮罩是第一道防线，便宜且体验好。但前端挡不住刷新重放、脚本直发、双击穿透，服务端这把锁才是底线。两层都要有，本篇负责后者。
:::

## 常见踩坑

**坑 1：SETNX 和 EXPIRE 分两条命令写。** 中间进程一崩，key 永生，全站死锁。这是分布式锁最著名的事故形态——哪怕代码里两行紧挨着，也挡不住进程外的发布重启。永远用 `SET key value NX PX ms` 一条命令。

**坑 2：释放锁直接 DEL。** 不看 value 就删，删的可能是别人的锁（推演见核心知识第 2 节的时间线）。更隐蔽的变体：GET 比对和 DEL 分开写，两条命令之间锁过期换了主人，照样误删。认准 Lua 脚本，比对和删除锁死在一个原子里。

**坑 3：TTL 拍脑袋。** 设太短（比如 100ms），业务一慢锁先没了，互斥失效；设太长（比如 10 分钟），进程崩溃后接口整段不可用。量一次业务 P99 耗时，乘 10 倍起步。真有长任务，上第 3 节说的续期，别靠加大 TTL 硬扛。

**坑 4：key 粒度设计错。** 只拼接口不拼用户，全站用户在同一接口排队，吞吐直接归零；只拼用户不拼参数，用户买完 A 商品想马上买 B，被误拦。粒度要对齐「竞争的单位」：防重复提交的竞争单位是「这个人 + 这个动作 + 这份参数」，少拼一段就多误伤一类人。

**坑 5：把锁当万能药。** 锁只保证「同一时刻一个请求进临界区」，不保证业务只成功一次。请求 A 拿锁、下单成功、响应却丢在网络里，用户稍后重试，此时锁早已释放，请求 B 又会创建一单。防重复提交的完整答案是「锁 + 幂等」：锁拦住手快的，幂等兜住重试的。Day 6 会专门做幂等键，这里先留个钩子。另外，Redis 主从切换瞬间锁可能丢（主库没来得及同步就挂了），对此业界有争议中的 Redlock 方案，见延伸阅读；对多数业务，单实例 Redis 的小概率失控可以接受。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `SETNX` 成功、`EXPIRE` 没执行，会发生什么？为什么 `SET NX PX` 一条命令能避免？

::: details 参考答案
key 永不过期，后续所有加锁请求失败，业务卡死，得人工删 key 才能恢复。`SET NX PX` 把「不存在才设置」和「过期时间」合并成一条命令，Redis 对单条命令的执行是原子的，中间不可能插入进程崩溃。
:::

2. value 为什么要放随机串？释放锁为什么必须用 Lua，「GET 比对 + DEL」两条命令不行吗？

::: details 参考答案
随机串是持有者标识，用来判断「这把锁是不是我的」，防止删掉别人的锁。GET 和 DEL 是两条命令，中间锁可能恰好过期、被他人拿走，DEL 就删错了。Lua 脚本在 Redis 单线程里一次执行完，比对和删除不可分割。
:::

3. TTL 设短了、设长了各出什么问题？起点值怎么定？

::: details 参考答案
太短：业务没跑完锁先过期，互斥被破，并发裸奔。太长：进程崩溃后锁长时间占着 key，接口不可用的窗口变大。起点是业务 P99 耗时放大一个数量级；业务时长不可控时用看门狗或 `extend()` 定时续期。
:::

4. 防重复提交的 key 为什么要拼「用户 + 接口 + 参数摘要」？去掉任何一段会怎样？

::: details 参考答案
竞争单位是「同一用户对同一接口提交同一份内容」，key 必须精确覆盖这个单位。去掉用户：所有人互相拦，吞吐崩塌。去掉参数摘要：用户改了内容重新提交也被误拦。去掉接口：在这个页面提交过，换个页面也被拦。每一段都对应一类误伤。
:::

5. 有了这把锁，还需要做幂等吗？

::: details 参考答案
需要。锁拦「同时」，拦不住「先后」：响应丢失或超时后用户过几秒再试，锁已释放，第二个请求照样通过。幂等（幂等键、唯一约束、幂等表）保证同一操作重复执行结果不变，两者互补，合起来才是防重复提交的完整答案。
:::

## 延伸阅读

- [Redis 官方：SET 命令](https://redis.io/docs/latest/commands/set/)，`NX`、`PX` 参数的权威说明，页面示例里就有分布式锁的用法
- [Redis 官方：Distributed locks pattern](https://redis.io/docs/latest/develop/use/patterns/distributed-locks/)，分布式锁模式的完整版，含 Redlock 算法与主从失效问题的来龙去脉
- [NestJS 官方：Interceptors](https://docs.nestjs.com/interceptors)，拦截器的执行时机、和 Guard、Filter 的关系，今天只用到它最小的一个切面

`LockService` 留好。明天的 BullMQ 队列、Day 6 的幂等键，加上今天这把锁，是同一套并发防线上的三块拼图，后两块都会回来复用它。
