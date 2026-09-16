# 第 6 周 · Day 2：缓存策略——Cache-Aside、TTL 与穿透/击穿/雪崩

> 对应手册任务：学习「缓存策略：Cache-Aside、TTL、穿透/击穿/雪崩」，动手「给 /users 列表加缓存，设置 TTL，写空值缓存防穿透」，当日产出「带缓存的用户列表」。本篇只解决一个问题：昨天封装的 CacheService 还只是个零件，今天把它装进业务接口——读的时候先问 Redis 再碰 PG，写的时候让旧缓存立刻作废，并且赶在写第一行缓存代码之前，把穿透、击穿、雪崩这三种「缓存失效后的连环车祸」的雷拆掉。

## 今日目标

1. 说得清 Cache-Aside、Read-Through、Write-Through 三种读写策略各自怎么运转，为什么业界主流是 Cache-Aside
2. 能分别复述穿透、击穿、雪崩的成因与解法，每个都讲得出一段「没有防护时的故障剧本」——后端面试的高频题
3. 独立给 /users 接口加上缓存：列表走 Cache-Aside、TTL 带随机抖动、详情用空值缓存防穿透，更新和删除用户时让缓存失效

## 概念讲解：为什么缓存不是「加上就快」

昨天的黑名单场景很简单：写一次、查几次、到点死，TTL 就是全部策略。今天的 /users 列表是另一种动物：人人都在读，数据偶尔会变。「读」和「写」一旦同时存在，三个问题就躲不掉。

第一个问题，读和写的顺序谁说了算。缓存里的用户列表只是 PG 那份正本的副本，请求先读谁、数据改了先动谁，不同顺序对应不同的不一致代价，这就是「读写策略」要定的事。

第二个问题，副本不会永远新鲜。TTL 一到 key 就没了，那一瞬间的请求全部涌向 PG；要是倒下的不是一个 key 而是一批，PG 被砸出来的连锁反应怎么防。

第三个问题，缓存拦不住所有读。「查一个根本不存在的用户」这种请求，缓存里永远不会有答案，每一次都直通数据库。

这三个问题各有名字：读写策略、穿透/击穿/雪崩（缓存三连击）、缓存一致性。它们是一门课的三个章节，今天一次讲完，然后落到代码上。

## 核心知识

本节的代码块都是独立示例，最终完整文件以下面的动手任务为准。

### 1. 读写策略：三种选型，主流是 Cache-Aside

| 策略 | 读路径 | 写路径 | 谁在管缓存 | 一句话点评 |
| --- | --- | --- | --- | --- |
| Cache-Aside（旁路缓存） | 应用先查缓存，miss 查库，回填 | 应用写库，然后删缓存 | 应用自己 | 最灵活，业务说了算，事实标准 |
| Read-Through | 应用只问缓存层，miss 由缓存组件查库回填 | 通常配合 Write-Through | 缓存中间件 | 逻辑收敛，但要有现成组件 |
| Write-Through | 同上 | 应用写缓存，缓存组件同步写库 | 缓存中间件 | 写延迟被缓存和库里最慢的那个拖住 |

主流是 Cache-Aside，原因很实际：它不挑基础设施，一个 Redis 客户端就能落地；key 的粒度、TTL 的长短、哪些读值得缓存，全由业务代码决定。Read-Through 和 Write-Through 把这些活交给缓存组件（代理层或云服务内置的能力），逻辑统一，但前提是你已经有那个组件。今天全部用 Cache-Aside，记住口诀：读三步（查缓存、miss 查库、回填），写两步（更新库、删缓存）。

### 2. 穿透：查「不存在」的请求，缓存永远拦不住

故障剧本：某天深夜，有人拿脚本刷你的接口 `GET /users/999999999`，一秒 500 次。这个用户从来不存在，缓存里自然也不会有它——缓存只能拦「曾经查过的数据」，对「不存在」无能为力。于是每一发请求都完整穿过缓存层，落在 PG 上跑一条注定空手而归的查询。QPS 再高一点，PG 的连接池全被这种无效查询占着，正常接口跟着变慢。这就是穿透：不存在的 key，把缓存打穿到库。

解法两条，可以叠加：

- **空值缓存**：查库发现不存在，也把这个事实写进缓存——值是一个约定好的哨兵，TTL 设短（30 秒级）。下一发 `GET /users/999999999` 命中哨兵，直接回 404，不再碰库。
- **布隆过滤器**：在缓存前面挂一个只会答「可能存在」或「一定不存在」的概率结构，请求先问它，答「一定不存在」就直接拒绝。适合 key 集合巨大又相对固定的场景（比如商品 ID），今天的用户表用空值缓存就够了。

### 3. 击穿：热 key 过期的那一瞬间

故障剧本：某个 key 是全站最热的，比如用户排行榜，每秒上千次读，TTL 10 分钟。10 分钟到的那一毫秒，key 消失，这一毫秒里在飞的几百个请求同时 miss、同时查库、同时回填。PG 瞬间收到一波脉冲，连接池打满，其他接口排队超时。这就是击穿：一个热 key 的过期，成了并发打库的扳机。

注意它和穿透的区别：穿透查的数据压根不存在，击穿查的数据存在、只是缓存恰好过期。一个是「无中生有」，一个是「趁虚而入」。

解法两条：

- **互斥锁**：miss 之后先抢锁，抢到的那个请求去查库回填，其他人等一小会再重试。并发被锁收束成一次库查询。锁怎么用 `SET NX PX` 造，明天 Day 3 专门讲。
- **逻辑过期**：key 干脆不设物理 TTL，把过期时间写进 value 里。读到「已逻辑过期」就先返回旧值，同时异步起一个任务查库回填。用「短暂的旧」换「永不打库」，适合能容忍陈旧几秒的展示型数据。

今天的 /users 并发量用不上这两招，先把药方记在心里。

### 4. 雪崩：一批 key 同一秒倒下

故障剧本有两种。第一种是自己埋的雷：晚上八点缓存预热，十万个 key 全设了 30 分钟 TTL，八点三十分整批同时过期，miss 洪峰整体砸向 PG。第二种更干脆：Redis 宕机，缓存层整体消失，所有读瞬间全部落在库上。殊途同归：PG 被打满，整站变慢甚至挂掉。这就是雪崩：倒下的不是一个 key，是一面墙。

解法对症下药。对「同时过期」，给 TTL 加随机抖动，把过期时间打散，公式一行：

```ts
const ttl = TTL_BASE + Math.floor(Math.random() * TTL_JITTER);
// 例：300 + [0, 60) 的随机数 → 300–359 秒之间各自倒计时
```

对「Redis 挂了」，靠高可用部署（哨兵或集群，运维话题）加服务自身的限流降级——缓存层抛异常时别让接口跟着 500，宁可降级直查库（见坑 5）。

一句话记住三连击的分工：穿透防「不存在」，击穿防「热 key 过期」，雪崩防「成批倒下」。

### 5. 一致性：先更新库，再删缓存

Cache-Aside 的写路径有个经典选择题：更新数据时，先动库还是先动缓存？先把错误答案排掉。

「先删缓存，再更新库」：删完缓存、库还没改完的窗口里，一个并发读 miss 了，查库拿到旧值，回填——缓存里从此躺着一个已作废的旧值，TTL 多长它就错多久。

「更新库，同时更新缓存」：两个写请求并发时回填顺序可能颠倒，缓存可能停在旧值；而且「更新缓存」这步一旦失败，旧值就一直占着位。删比更新安全：删是幂等的，失败可以重试。

所以主流答案是「先更新库，再删缓存」。它也有窗口期：一个读请求在库更新前查到了旧值、又在删除之后才回填，旧值照样进缓存。但这要求「读的查库比写的更新先发生」和「读的回填比写的删除后发生」同时成立，概率远低于「先删后更」那个必然出现的窗口。要更较真还有延迟双删、订阅 binlog 之类的进阶玩法，今天知道窗口存在、以及为什么这个顺序最稳，就够了。

## 动手任务：给 /users 接上 Cache-Aside，一步一步

手册任务：给 /users 列表加缓存，设置 TTL，写空值缓存防穿透。拆成 5 步，全程约 30 分钟。底座是第 5 周的 users 模块（NestJS + Prisma）加昨天的 CacheService。

**第 1 步：看清现状。** 假设 `users.service.ts` 目前长这样，每个请求全程打库：

```ts
async findAll(page = 1, pageSize = 20) {
  return this.prisma.user.findMany({
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: { id: 'asc' },
  });
}

async findOne(id: number) {
  const user = await this.prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundException('用户不存在');
  return user;
}
```

今天要做的就是把这两条读路径改成先过缓存。构造函数里注入昨天的 `private readonly cache: CacheService`，文件顶部补两个导入：`User` 来自 `@prisma/client`，`NotFoundException` 来自 `@nestjs/common`。

**第 2 步：列表走 Cache-Aside，TTL 带抖动。**

```ts
const LIST_TTL_BASE = 300;   // 基准 5 分钟
const LIST_TTL_JITTER = 60;  // 随机抖动上限

private listTtl(): number {
  return LIST_TTL_BASE + Math.floor(Math.random() * LIST_TTL_JITTER);
}

async findAll(page = 1, pageSize = 20) {
  const key = `users:list:${page}:${pageSize}`;

  // ① 先问缓存
  const cached = await this.cache.get<User[]>(key);
  if (cached !== null) return cached;

  // ② miss 才查库
  const users = await this.prisma.user.findMany({
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: { id: 'asc' },
  });

  // ③ 回填，TTL 打散
  await this.cache.set(key, users, this.listTtl());
  return users;
}
```

三处关键。key 把 `page` 和 `pageSize` 都编了进去：影响查询结果的参数必须进 key，否则第 2 页会命中第 1 页的缓存。判断命中用 `cached !== null` 而不是真值判断：空列表 `[]` 是合法的缓存值，不能当 miss。回填的 TTL 走 `listTtl()`，每个 key 的倒计时各不相同，这就是抖动公式的落地。

**第 3 步：详情加空值缓存，防穿透。**

```ts
const NOT_FOUND = 'NOT_FOUND'; // 哨兵：约定「查过，不存在」
const DETAIL_TTL = 600;
const NULL_TTL = 30;           // 空值只缓存 30 秒

async findOne(id: number) {
  const key = `users:detail:${id}`;

  const cached = await this.cache.get<User | string>(key);
  if (cached === NOT_FOUND) throw new NotFoundException('用户不存在');
  if (cached !== null) return cached as User;

  const user = await this.prisma.user.findUnique({ where: { id } });
  if (!user) {
    await this.cache.set(key, NOT_FOUND, NULL_TTL);
    throw new NotFoundException('用户不存在');
  }

  await this.cache.set(key, user, DETAIL_TTL);
  return user;
}
```

两处关键。哨兵必须是 null 以外的值：CacheService 的 `get` 用 null 表示 miss，你存 null 进去，转一圈 JSON 回来还是 null，永远被当 miss，空值缓存等于没写。空值的 TTL 故意只有 30 秒：不然用户刚注册完立刻查自己，缓存还举着「不存在」的牌子，就闹笑话了。

**第 4 步：更新和删除时失效缓存。** 按第 5 小节定的顺序，先更新库，成功后删缓存：

```ts
async update(id: number, dto: UpdateUserDto) {
  const user = await this.prisma.user.update({ where: { id }, data: dto });
  await this.cache.del(`users:detail:${id}`); // 先更新库，再删缓存
  return user;
}

async remove(id: number) {
  await this.prisma.user.delete({ where: { id } });
  await this.cache.del(`users:detail:${id}`);
}
```

列表缓存没删，是故意的。列表 key 带分页维度，一次改动牵连所有页，精确删除要么按模式扫 key、要么引入版本号，成本不低。通行取舍是：越聚合的缓存越难精确失效，TTL 就该越短（列表的 5 分钟在流量大的站点会压到 1 分钟内）；越精确的 key（按 id 的详情）越值得精确失效，TTL 也可以放长。这句话比任何代码都值钱。

**第 5 步：验证三件事。**

命中：连发两次 `curl localhost:3000/users`，第二次的耗时肉眼可见地掉下来；进 `docker compose exec redis redis-cli`，`KEYS app:users:*` 能看到列表 key。等它过期重建几次，`TTL app:users:list:1:20` 每次读数都不同——抖动在工作的证据。

防穿透：`curl localhost:3000/users/999999` 打两次，第二次表面看不出差别，但 `GET app:users:detail:999999` 返回 `"NOT_FOUND"`、TTL 在 30 秒内，说明这发已经不碰 PG 了。

失效：改一个用户的昵称再查详情，拿到新值；`KEYS` 里那条 detail key 不在了——是你删的，不是它恰好过期。

::: tip 今天的账
改动前 /users 每次请求等于一次 PG 查询；改动后等于一次内存 GET（亚毫秒），只有 miss 和写后第一次读才碰库。代价是多了一套要维护的失效逻辑和一个会宕机的中间件。这笔账，几乎所有「读多写少」的接口都划算。
:::

## 常见踩坑

**坑 1：拿 null 当空值哨兵。** 觉得「查不到就存 null」，结果 `JSON.stringify(null)` 是字符串 `"null"`，`parse` 回来还是 null，被 `get` 的判空逻辑一口咬定是 miss——空值缓存永远不生效，每次照样打库，你还以为防住了。哨兵必须是 null 以外的值（字符串 `'NOT_FOUND'`、空串都行），并且判断命中时先比哨兵再判 null。

**坑 2：先删缓存，再更新库。** 顺序一反，窗口期从「极小概率」变成「必然出现」：删完缓存、库还没改完的空档里，任何并发读都会把旧值查出来回填进缓存，之后 TTL 多长，用户看到的数据就错多久。口诀背牢：先更新库，再删缓存。

**坑 3：列表 key 不带查询参数。** 所有分页共用 `users:list` 一个 key，第 1 页请求回填后，第 2 页请求命中它，返回第 1 页的数据。凡是影响查询结果的参数——page、pageSize、筛选条件、排序——都得编进 key。反过来也要有数：参数组合越多，key 越碎片，命中率越低，所以「值得缓存」的通常是少数几个热门组合。

**坑 4：所有 TTL 写死同一个常量。** `set(key, value, 300)` 到处复制，同一批回填的 key 同一秒倒下，等于亲手布好雪崩的雷，平时没流量看不出问题，预热或流量高峰准时爆炸。抖动公式一行的事：基准值加 `Math.random()` 的随机量，让每个 key 各自倒计时。

**坑 5：Redis 一挂，全站跟着挂。** CacheService 底层的 ioredis 一抛错，没人接住，接口直接 500——缓存层本该是锦上添花，结果成了单点故障。至少给缓存读写包一层降级：异常时当 miss 处理，读路径自动退回查库：

```ts
private async safeGet<T>(key: string): Promise<T | null> {
  try {
    return await this.cache.get<T>(key);
  } catch {
    return null; // 缓存坏了就当没命中，走库
  }
}
```

回填的 `set` 同样包一层，失败就静默放弃（下一发请求会再试）。雪崩那一节说的「限流降级」，落到代码里就是这么朴素。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Cache-Aside、Read-Through、Write-Through 三种策略的差别在哪？为什么业务代码里主流是 Cache-Aside？

::: details 参考答案
差别在「谁管缓存」：Cache-Aside 由应用代码自己读写和回填缓存；Read-Through 和 Write-Through 把查库回填、同步写库这些活交给缓存组件，应用只面对缓存层。主流是 Cache-Aside 因为它不挑基础设施、一个客户端就能落地，key 粒度和 TTL 全由业务决定；代价是读写逻辑散落在业务代码里，一致性要自己操心。
:::

2. 穿透和击穿都是「缓存没拦住、请求打到库」，一句话怎么区分？

::: details 参考答案
穿透是查「根本不存在」的数据，缓存里永远不会有答案，每一发都直通数据库；击穿是查「存在但缓存恰好过期」的热点数据，过期瞬间的并发整体涌向数据库。一个是无中生有，一个是趁虚而入。解法也不同：穿透用空值缓存或布隆过滤器，击穿用互斥锁或逻辑过期。
:::

3. TTL 抖动公式防的是三连击里的哪一个？雪崩还有哪种与过期无关的成因，靠什么防？

::: details 参考答案
抖动防的是「大批 key 同时过期」这种雪崩：基准 TTL 加随机量，把过期时间打散到一段区间里。雪崩还有一种成因是 Redis 整体宕机，缓存层瞬间消失，靠高可用部署（哨兵/集群）扛，靠服务侧限流降级兜底——缓存异常时退回查库而不是全站 500。
:::

4. 为什么写路径是「先更新库，再删缓存」？反过来会怎样？这个顺序还有窗口期吗？

::: details 参考答案
反过来「先删缓存再更新库」会出现必然的脏回填：删除和更新之间的并发读 miss、查到旧值、回填，缓存从此躺着一个作废值。「先更新库再删缓存」的窗口期需要「读的查库早于写的更新、读的回填晚于写的删除」同时成立才触发，概率极低。要进一步压缩有延迟双删、订阅 binlog 等方案。另外删缓存比更新缓存安全：删是幂等的，失败可重试。
:::

5. 空值缓存的两条纪律是什么？各是为什么？

::: details 参考答案
一是哨兵不能用 null：CacheService 的 get 拿 null 表示 miss，存 null 转一圈 JSON 回来还是 null，空值缓存永远不生效，得用 'NOT_FOUND' 这类字符串哨兵。二是空值的 TTL 要短（30 秒级）：它是为挡住恶意刷请求临时立的牌子，留太久会把「刚创建的数据」也挡在门外，新用户注册完立刻查自己会被误判成不存在。
:::

## 延伸阅读

- [AWS ElastiCache 文档：Caching Strategies](https://docs.aws.amazon.com/AmazonElastiCache/latest/mem-ug/Strategies.html)，lazy loading 与 write-through 的原始出处，Cache-Aside 在 AWS 语境里就叫 lazy loading，读完能拿到另一套行业词汇
- [Scaling Memcache at Facebook（NSDI 2013 论文）](https://www.cs.bu.edu/~jbest/papers/memcache-fb.pdf)，工业界应对热 key、雪崩、不一致的第一手材料，著名的 lease 机制就是冲着击穿去的
- [小林 coding：图解网络与 Redis 系列](https://www.xiaolincoding.com/)，站内《图解 Redis》把穿透/击穿/雪崩画成了三张图，面试前把图记熟比背文字牢靠

今天的产出「带缓存的用户列表」留好。击穿那把互斥锁的原料 `SET NX PX`，明天 Day 3 正式开工。
