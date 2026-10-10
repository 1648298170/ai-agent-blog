# 第 6 周 · Day 1：Redis 基础——把第 5 周欠的黑名单账还上

> 对应手册任务：学习「Redis 基础：String/Hash/List/Set/ZSet」，动手「用 ioredis 实现缓存 get/set 封装，并把第 5 周的 token 黑名单从 PG 迁移到 Redis」，当日产出 `cache.service.ts`。本篇只解决一个问题：第 5 周 Day 3 结尾留的那句「学完 Redis 再回来动它」今天兑现——黑名单查询这层热数据从 PG 搬进内存，过期交给 TTL 自动完成，顺带攒出一个以后处处能用的缓存封装。

## 今日目标

1. 说得清 Redis 是什么、为什么快，五大结构各自适合什么场景
2. 掌握 ioredis 的连接与复用、TTL 的语义，封装出带 JSON 序列化和命名空间前缀的 CacheService
3. 把黑名单查询从 PG 迁到 Redis：吊销时写一个带 TTL 的 key，校验时查一次内存，过期数据自己消失，不再往 PG 里攒案底行

## 概念讲解：为什么黑名单欠着 Redis 一笔账

先复盘第 5 周 Day 3 的设计。RefreshToken 表存的是 token 的 sha256 摘要，吊销不是删记录，是往 `revokedAt` 列填时间。这个设计在「案底要留」上是对的：被吊销的 token 再次出现，就是重放攻击的实锤。但它有三笔账一直没结。

第一笔，校验路径上多一次 PG 往返。每次 `/auth/refresh` 都要拿摘要去 PG 查一遍 `revokedAt`，PG 是磁盘数据库，这个查询再快也是毫秒级，还和业务查询抢同一个连接池。

第二笔，过期数据只进不出。token 活得再长也有头，可表里的行不会自己消失。想让它们退场，就得写个定时任务批量 DELETE——又一个要部署、要监控、删早了怕误伤删晚了白占地方的东西。

第三笔，数据和它的性质不匹配。黑名单是「写一次、查几次、到点就该作废」的短命数据，PG 擅长的是「要持久、要事务、要复杂查询」。拿 PG 装黑名单，等于拿保险柜装外卖。

Redis 就是冲着这类数据来的：一个放在内存里的键值数据库，每个 key 可以设存活时间（TTL），到点自动删除，读写都是亚毫秒级。为什么快，三条：一，数据在内存，没有磁盘寻道；二，命令执行是单线程事件循环——第 3 周讲 Node 事件循环时你见过一模一样的套路，一个线程加 I/O 多路复用，同时盯着成百上千个连接，谁就绪处理谁；三，所有命令串行执行，不抢锁，GET/SET 都是 O(1)。单线程不等于慢，真正慢的是磁盘和锁竞争，Redis 两样都躲开了。

至于「案底」和「热查询」的分工，今天这样切：PG 的 RefreshToken 表继续当账本留着（轮换、审计用得上），但「这个 token 被吊销没有」这条每请求都要走的热路径，搬到 Redis。

## 核心知识

本节的代码块都是独立示例，最终完整文件以下面的动手任务为准。

### 1. 五大结构选型表

先建立整体印象，用到哪个再深入：

| 结构 | 常用命令 | 典型场景 | 一句话理由 |
| --- | --- | --- | --- |
| String | `SET` / `GET` / `INCR` | 缓存 JSON、计数器、黑名单 | 一个 key 对一个值，最通用 |
| Hash | `HSET` / `HGET` / `HGETALL` | 存对象，且经常只改其中一个字段 | 按字段读写，不用整个取出改完放回 |
| List | `LPUSH` / `RPOP` / `LRANGE` | 最新动态、简单任务队列 | 两头进出，天然有序 |
| Set | `SADD` / `SISMEMBER` | 标签、去重、共同关注 | 成员不重复，交并差是原生操作 |
| ZSet | `ZADD` / `ZRANGE` | 排行榜、按时间排程 | Set 加一个分数维度，按分数取 |

今天的主角是 String：缓存和黑名单都是它。判断标准一句话——value 是一个整体、读就整体读，用 String；要按字段操作，才考虑 Hash。

### 2. compose 追加 redis 服务

第 4 周 Day 1 那份 docker-compose.yml，在 `services` 里追加一个服务，原有的 postgres 保持不动：

```yaml
services:
  # ……postgres 等原有服务保持不动……
  redis:
    image: redis:7-alpine
    container_name: ai-agent-redis
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data

volumes:
  # pgdata 是原有声明，保持不动
  redis-data:
```

缓存丢了能重建；黑名单丢了，影响也只是「已吊销的 token 复活到它本来的过期时间」。所以这个 volume 甚至是可选的，求个心理稳妥就留着。

### 3. ioredis 连接与复用

ioredis 是 Node 生态最常用的 Redis 客户端。NestJS 里做一个全局模块，全进程只建一次连接：

```ts
// redis.module.ts
import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const client = new Redis({
          host: process.env.REDIS_HOST ?? '127.0.0.1',
          port: Number(process.env.REDIS_PORT ?? 6379),
          maxRetriesPerRequest: 1,
        });
        client.on('error', (err) => console.error('[redis]', err.message));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleDestroy() {
    this.redis.quit();
  }
}
```

关键有三处。`@Global()`：别的模块直接注入，不用人人 `imports` 一遍。`on('error', ...)`：Node 的规则是 error 事件没监听器就抛异常，不挂这一行，Redis 一断线整个进程跟着倒。`maxRetriesPerRequest: 1`：默认一条命令失败会重试 20 次，Redis 抖一下你的请求集体挂起几秒，限到 1 次让失败尽快浮出来。

单连接够用吗？够。ioredis 底层还是第 3 周那个老朋友事件循环：一条连接上同时挂起成百上千条未完成的命令，响应到了再各自回调。连接本身不是瓶颈，别手痒去建池。

### 4. TTL：到点自动消失

```ts
await redis.set('session:42', raw);            // 永不过期，慎用
await redis.set('session:42', raw, 'EX', 900); // 900 秒后自动删除
await redis.expire('session:42', 900);         // 给已有 key 补 TTL
const left = await redis.ttl('session:42');    // 剩余秒数；-2 表示 key 不存在
```

关键在 `EX` 必须跟 SET 同一条命令。先 SET 再单独 EXPIRE 是两条命令，第一条成了第二条没执行（进程崩了、连接断了），这个 key 就永生了。过期这件事本身不花你的钱：Redis 对过期 key 是惰性删除加定期抽样，不用你安排任何人去打扫。

### 5. CacheService：get/set/del 加序列化加前缀

Redis 的 value 只认字符串和二进制，JS 对象进出要过一遍 `JSON.stringify` / `JSON.parse`。再加上命名空间前缀和可选 TTL，就是当日产出的主体：

```ts
// cache.service.ts
import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.module';

@Injectable()
export class CacheService {
  private readonly prefix = 'app:';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(this.prefix + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlSeconds === undefined) {
      await this.redis.set(this.prefix + key, raw);
    } else {
      await this.redis.set(this.prefix + key, raw, 'EX', ttlSeconds);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}
```

前缀解决的是「多个服务共用一个 Redis 实例」时的撞 key 和归属不清：排查时 `KEYS app:*` 一眼分清是谁的。`get<T>` 的类型由调用方指定，注意它是断言不是校验，存进去什么取出来还是什么。

## 动手任务：CacheService 加黑名单迁移，一步一步

手册任务拆成 5 步，全程约 30 分钟。

**第 1 步：起 Redis。** 把第 2 小节的 redis 服务追加进第 4 周那份 compose 文件，`docker compose up -d redis`，然后 `docker compose exec redis redis-cli ping`，回一个 PONG 就算通了。

**第 2 步：接客户端。** 在 `apps/api` 执行 `npm i ioredis`，建 `redis.module.ts`（第 3 小节代码照抄），加进 AppModule 的 imports，`.env` 里补上 `REDIS_HOST` 和 `REDIS_PORT`。启动项目，控制台没有 `[redis]` 报错，连接就算建好。

**第 3 步：写 CacheService。** 建 `cache.service.ts`（第 5 小节代码照抄），注册进 AppModule 的 providers。随手验证一下进出：

```ts
await cacheService.set('hello', { name: 'Jerry' }, 60);
const back = await cacheService.get<{ name: string }>('hello'); // { name: 'Jerry' }
```

**第 4 步：迁黑名单。** 第 5 周的吊销动作是「往 RefreshToken 表的 `revokedAt` 填时间」，校验是「查这列空不空」。PG 账本照旧记，但热查询换到 Redis 上。新建 `token-blacklist.service.ts`：

```ts
// token-blacklist.service.ts
import { Injectable } from '@nestjs/common';
import { CacheService } from './cache.service';

@Injectable()
export class TokenBlacklistService {
  constructor(private readonly cache: CacheService) {}

  /** 吊销时调用；ttlSeconds 传这个 token 的剩余存活秒数 */
  async revoke(tokenHash: string, ttlSeconds: number): Promise<void> {
    await this.cache.set(`auth:blacklist:${tokenHash}`, 1, ttlSeconds);
  }

  /** 校验时调用 */
  async isRevoked(tokenHash: string): Promise<boolean> {
    return (await this.cache.get(`auth:blacklist:${tokenHash}`)) !== null;
  }
}
```

两个衔接点。key 沿用第 5 周的 sha256 摘要，token 原文不出现在任何 key 里，和当年不存明文是同一条理由。剩余秒数从表的 `expiresAt` 算：`Math.floor((expiresAt.getTime() - Date.now()) / 1000)`，算出来小于等于 0 就不用写了，它本来就过期了。然后把第 5 周 AuthService 里两处替换：登出和轮换填 `revokedAt` 的地方，各追加一行 `revoke()`；`/auth/refresh` 里查 `revokedAt` 的地方，换成 `isRevoked()` 先问 Redis。

TTL 设成剩余寿命是点睛之笔：token 自然过期的那一刻，黑名单里那条记录同步消失。存着的每一秒都有意义，没有一个 key 在为已经死掉的 token 站岗。

**第 5 步：验证闭环。** 把第 5 周的 Postman 集合整链再跑一遍（第 5 周 Day 7 预告过的那趟回访）：登出，拿旧 refresh token 请求，应得 401。再进 `docker compose exec redis redis-cli`，`KEYS app:auth:blacklist:*` 能看到那条 key，`TTL` 能看到倒计时在走。等它归零，`EXISTS` 返回 0——没有任何人动手，key 自己没了。想回收 PG 里积压的过期行，什么时候写个一次性 DELETE 都行，不写也不影响正确性，这正是迁移换来的从容。

::: tip 迁移收益对账
对比一下：PG 方案里一次校验是一次磁盘查询，过期行靠你自己打扫；Redis 方案里一次校验是一次内存 GET（亚毫秒），过期这件事的成本为零。写进 key 的 TTL，就是那个「再也不用写的定时清理任务」。
:::

## 常见踩坑

**坑 1：SET 和 EXPIRE 分两条命令发。** 上面提过，再强调一次因为真会翻车：两条命令之间进程崩了或连接断了，key 没有过期时间，永远躺在库里，黑名单里出现一个永生 key 等于永久的查询负担。凡是「设置值加设置过期」的场景，一律 `SET key value EX seconds` 一条命令完成，原子性是 Redis 给的免费午餐。

**坑 2：把黑名单塞进一个大 Set 结构。** 「黑名单」听上去就该用 Set，于是 `SADD blacklist <hash>`。问题马上来：Set 的成员没有独立 TTL，你没法让「这条五分钟后消失、那条两小时后消失」，只能整个 key 一起过期或永不过期。正确姿势反直觉：每个 token 单独一个 String key（`auth:blacklist:<hash>`），TTL 各设各的。选数据结构看操作需求，不看名字像不像。

**坑 3：在请求路径里 new 客户端。** `new Redis()` 写进了被频繁调用的代码路径，连接数随流量涨，直到撞上服务端的 maxclients 上限，全线报错。客户端在全局模块里建一次，谁用谁注入。单连接的底气来自事件循环，一条连接足以同时挂起海量命令。

**坑 4：get 回来不判 null。** key 过期了、被删了、从未存在过，`redis.get` 一律返回 null。跳过判空直接 `JSON.parse(raw)`，会炸出 `Unexpected token u` 这类运行时错误，而且只在缓存恰好失效时触发，测试环境难复现。`raw === null ? null : JSON.parse(raw)` 这个三元的顺序别写反。

**坑 5：Date 对象过一遍 JSON 就不是 Date 了。** `JSON.stringify(new Date())` 得到字符串，`JSON.parse` 回来还是字符串，`instanceof Date` 是 false。CacheService 的 `get<T>` 只断言不转换，类型对不上编译器帮不了你。存之前自己转成 ISO 字符串或时间戳，取之后手动还原。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Redis 单线程为什么还快？它和 PG 的性能差距本质来自哪里？

::: details 参考答案
三个原因：数据在内存，没有磁盘 I/O；命令执行单线程，没有锁竞争和线程切换开销；I/O 多路复用让单线程同时服务大量连接。和 PG 的差距本质是定位不同：PG 要持久化和事务，数据落盘、走 B+ 树索引；Redis 在内存里按 key 定位，读写都是亚毫秒。
:::

2. 五大结构各自的典型场景？黑名单为什么偏偏用 String 而不是 Set？

::: details 参考答案
String 缓存整对象和计数器，Hash 按字段操作对象，List 有序队列和最新列表，Set 去重和集合运算，ZSet 排行榜和按分数范围取。黑名单要的是每个 token 独立的 TTL，Set 结构的成员没有独立过期时间，只有 String 的 key 级 TTL 能做到一条记录一个倒计时。
:::

3. `SET key value EX 60` 和先 `SET` 再 `EXPIRE` 差在哪？

::: details 参考答案
前者是一条原子命令，要么整体生效要么不执行；后者是两条命令，中间中断就留下一个没有 TTL 的永生 key。这个坑有通用形态：「两步操作」之间任何中断都会留下中间状态，能用一条原子命令就不要拆两条。
:::

4. CacheService 里的 JSON 序列化和命名空间前缀分别解决什么问题？

::: details 参考答案
序列化是因为 Redis 的 value 只认字符串和二进制，不认识 JS 对象；前缀是为了多服务共用一个 Redis 时不撞 key、排查时按前缀一眼分清归属。另外 `get<T>` 的类型参数只是断言，运行时不会校验。
:::

5. 黑名单迁到 Redis 后，比 PG 方案优雅在哪？代价是什么？

::: details 参考答案
优雅：校验从磁盘查询变成内存 GET；过期交给 TTL 自动完成，不再积压过期行；短命数据不再压在业务库上。代价：Redis 默认不是强持久化，重启可能丢一小段 key，被丢的已吊销 token 会复活到自然过期，所以 PG 账本仍然留着兜底；系统也多了一个要运维的中间件。这笔账通常换得值，但要心里有数。
:::

## 延伸阅读

- [Redis 官方文档：Data types](https://redis.io/docs/latest/develop/data-types/)，五大结构的官方说明，每个结构都配了交互示例
- [ioredis GitHub](https://github.com/redis/ioredis)，README 就是最好的教程，连接、重试、pipeline 的写法全在里面
- [Redis 官方文档：Key expiration](https://redis.io/docs/latest/develop/use/key-expiration/)，TTL 的完整语义：过期如何触发，惰性删除和定期抽样的细节

今天的产出 `cache.service.ts` 留好。黑名单只是它接的第一单，往后凡是「读得多、能过期、丢了能重建」的数据，都可以往里放。
