# 第 4 周 · Day 4：Prisma 事务与索引——要么全成，要么全无

> 对应手册任务：学习「Prisma 事务 + 索引」，动手写一个「创建用户并同时创建欢迎帖子」的事务，给 email 加唯一索引，当日产出「事务代码 + 索引验证」。本篇只解决两个问题：多条写库要么全部成功、要么全部回滚，不能留半截数据；email 的唯一性由数据库把关，而不是靠业务代码里那句先查再插的检查。

## 今日目标

1. 说得清事务解决什么问题（部分成功留下的脏数据），以及 `$transaction` 顺序式与交互式各自的适用场景
2. 掌握三个技术点：交互式事务的写法与超时回滚、P2002 唯一约束冲突捕获转 409、`@unique` 唯一索引与迁移
3. 独立完成：注册即发欢迎帖的事务版本，亲眼验证一次回滚；给 email 加唯一索引，用 EXPLAIN 看到 Index Scan 替代 Seq Scan

## 概念讲解：写了一半的注册，和拦不住的重复邮箱

Day 3 结束时，UsersService 的 createUser 是一条 Prisma 调用。今天加个新需求：注册成功的同时，自动给这位用户创建一篇欢迎帖子。直觉写法是这样：

```ts
async register(dto: { email: string; name: string }) {
  const user = await this.prisma.user.create({
    data: { email: dto.email, name: dto.name },
  });

  await this.prisma.post.create({
    data: {
      title: `欢迎你，${user.name}`,
      content: "欢迎来到 AI Agent 专栏，先随便逛逛。",
      userId: user.id,
    },
  });

  return user;
}
```

两条 await，各自独立提交。`user.create` 成功的那一刻，这行数据已经永久落库；接下来 `post.create` 炸了，数据库连接抖一下、字段超长、进程恰好重启，随便哪个都够。炸完之后的世界是这样：用户在，帖子没有。这叫部分成功，是脏数据里最常见的一种。

脏在哪？数据违背了「每个新用户都有一篇欢迎帖」这条业务规则。后面所有依赖这条规则的逻辑，统计、客服、给没收到帖子的用户补发，全在替这半截数据还债。你在 catch 里返回 500 没错，但状态已经不一致，重试也救不了：email 已经存在，再跑一遍这个函数，第一步就换了种死法。

事务就是解决这个问题的：把若干条数据库操作打包成一个不可分割的整体，要么全部成功提交，要么当无事发生，全部回滚。ACID 里的 A，原子性，说的就是这件事。上面两步包进事务后，`post.create` 一炸，`user.create` 已写入的数据会被一并撤掉，数据库回到调用前的样子，这时你才好意思对客户端说「失败了，请重试」。

第二个问题更隐蔽。第 3 周在内存数组上防重复注册，靠的是 Service 里先 find 再 create；Day 3 换成 Prisma 后，这套检查多半也跟着搬过来了。它有两个洞。

洞一，性能。登录、发帖、鉴权，几乎所有请求都要按 email 查一次用户。表里没有索引时，数据库只能全表扫描：从第一行读到最后一行，逐行比对 email。一万行是一万次比对，一百万行是一百万次，耗时随行数线性上涨。流量小的时候你完全察觉不到，等察觉到时多半已经是线上事故。

洞二，正确性。先查再插有缝：两个请求同时进来，都查到「这个 email 不存在」，然后各自插入，两条都成功。并发下这种「检查完再动手」的缝隙堵不住，业内叫竞态。唯一可靠的防线是把「一个 email 只能有一行」写进数据库，变成唯一约束，重复插入的那条会被数据库当场拒绝。

所以今天的两件事其实是一件事：把「要么全成」「只有一个」这类规则从业务代码下沉到数据库层，让数据库替你扛住故障和并发。

## 核心知识

本节的代码围绕 Day 3 的 users.service.ts 讲解，Prisma 客户端实例沿用你项目里的写法（下文叫 `this.prisma`），模型字段对不上就以你自己的 schema 为准。

### 1. $transaction 的两种形态

顺序式，传一个 Promise 数组：

```ts
const [user, post] = await this.prisma.$transaction([
  this.prisma.user.create({
    data: { email: dto.email, name: dto.name },
  }),
  this.prisma.post.create({
    data: { title: "欢迎你", userId: 0 }, // 问题就在这：真实的 id 拿不到
  }),
]);
```

Prisma 保证数组里的操作按序执行，任何一个失败，全部回滚。但注意一个坑：数组项是预先构造好的 Promise，写第二项时第一项还没执行，你拿不到刚创建的 user 的 id。顺序式适合「互不依赖的一批写」，比如同一次请求里更新两张表的状态；一旦后一步要用前一步的结果，它就无能为力。

交互式，传一个 async 回调，Prisma 给你一个事务专用的客户端 `tx`：

```ts
const user = await this.prisma.$transaction(async (tx) => {
  const newUser = await tx.user.create({
    data: { email: dto.email, name: dto.name },
  });

  await tx.post.create({
    data: {
      title: `欢迎你，${newUser.name}`,
      content: "欢迎来到 AI Agent 专栏，先随便逛逛。",
      userId: newUser.id, // 第一步的结果，直接用
    },
  });

  return newUser;
});
```

回调里可以混业务逻辑：查、算、条件分支，再用上一步的返回值。规则只有两条：回调正常结束就提交；回调抛出任何错误，已执行的操作全部回滚。写操作必须通过 `tx` 发出，写成 `this.prisma.xxx` 就游离在事务外了。还有一条硬限制：整个回调默认要在 5 秒内跑完，超时 Prisma 报 P2028 并回滚，参数可以调：

```ts
await this.prisma.$transaction(
  async (tx) => {
    /* ... */
  },
  {
    maxWait: 5000, // 最多等多久拿到事务，默认 2000
    timeout: 10000, // 整个事务最长存活时间，默认 5000
  },
);
```

顺带一个更短的写法。「建父记录同时建子记录」这种固定形状，Prisma 支持嵌套写入：

```ts
const user = await this.prisma.user.create({
  data: {
    email: dto.email,
    name: dto.name,
    posts: {
      create: { title: `欢迎你，${dto.name}`, content: "欢迎来到 AI Agent 专栏。" },
    },
  },
  include: { posts: true },
});
```

一条 create 连子记录一起建，Prisma 内部同样包在事务里，原子性不丢。它和交互式的分工：数据形状固定的用嵌套，中间有条件逻辑（比如按注册来源决定发不发帖）用交互式。今天的动手任务主用交互式，因为它是通用工具。

### 2. P2002：把唯一约束冲突翻译成 409

email 加上唯一索引后（怎么加见动手任务第 2 步），重复注册的请求会走到另一个分支：数据库拒绝插入，Prisma 把这次拒绝包装成已知错误抛上来，错误码 P2002，官方描述是 Unique constraint failed。它不是程序 bug，是业务规则生效了，所以不该回 500，而是 409 Conflict。

```ts
import { Prisma } from "@prisma/client";
import { ConflictException } from "@nestjs/common";

async register(dto: { email: string; name: string }) {
  try {
    // ...事务代码
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ConflictException(`邮箱 ${dto.email} 已被注册`);
    }
    throw e; // 其他错误原样上抛，交给上层异常过滤器
  }
}
```

两个要点。instanceof 先验身份，因为超时 P2028、连接失败 P1001 也走同一个 catch，一律转 409 就把真故障藏起来了。最后的 `throw e` 必须留着，否则所有错误都被吞成「邮箱已被注册」。

### 3. 索引：B-tree 为什么快，什么时候不该建

一句话原理：索引把一列的值按顺序组织成一棵平衡多叉树（B-tree），查找时从树根往下走，每层比较一次就排除一大片数据，访问次数是对数级的。一百万行的表，全表扫描要摸一百万行，B-tree 大约三四次页访问就能定位目标。字典的目录页就是这个思路。

但索引不是免费的。每次 INSERT、UPDATE 都要同步维护这棵树，索引每多一个，每次写入就多一份维护成本，这叫写放大；索引本身也占存储。判断标准：

该建：高频出现在 WHERE、JOIN ON、ORDER BY 里的列；表足够大（几千行以上体感才明显）；读多写少的场景。

不该建：小表，几十行数据全表扫比走索引还快，建了纯属浪费；区分度低的列，比如 is_deleted 只有 true/false 两个值，B-tree 分不出东西；写入极重、读取极少的表，写放大的代价盖过收益。

唯一索引是索引里的特殊品种：既加速按 email 的等值查询，又替数据库执行「不许重复」的业务规则。换句话说，它不只是性能手段，它本身就是业务约束，「一个邮箱只能注册一个账号」这条规则写在 schema 里，比写在代码注释里可靠得多。Prisma 里加它只要一行 schema：单字段用 `@unique`，两个以上字段的组合唯一用 `@@unique([a, b])`。接下来动手。

## 动手任务：事务 + 唯一索引，一步一步

手册任务：写一个「创建用户并同时创建欢迎帖子」的事务，给 email 加唯一索引。拆成 5 步，全程约 30 分钟。前置条件：Day 1 的 PG 容器在跑，Day 2 的 schema、Day 3 的 users.service.ts 都在。

**第 1 步：确认现状，亲手制造一次脏数据。** 先看数据库里 email 有没有唯一约束，进 psql：

```powershell
docker exec -it ai-agent-pg psql -U jerry -d app_db
```

执行 `\d users`，看输出末尾的索引列表。schema 是唯一事实来源：schema.prisma 里 email 那行如果只写着 `String`（Day 2 建表时多半如此，约束是今天才讲的东西），这里就不会有 `users_email_key`。然后连插两行相同 email：

```sql
INSERT INTO users (email, name) VALUES ('dup@example.com', 'Jerry');
INSERT INTO users (email, name) VALUES ('dup@example.com', 'Jerry Again');
SELECT * FROM users WHERE email = 'dup@example.com';
```

两行都成功，没人拦。这就是待会要消灭的脏数据，先删掉：

```sql
DELETE FROM users WHERE email = 'dup@example.com';
```

**第 2 步：加唯一索引，跑迁移。** schema.prisma 里给 email 加约束：

```prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String
  createdAt DateTime @default(now()) @map("created_at")

  posts Post[]

  @@map("users")
}
```

执行迁移：

```powershell
npx prisma migrate dev --name add_email_unique
```

Prisma 生成一个新的迁移目录，里面的 SQL 核心就一句：

```sql
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
```

注意：这条语句会先扫描全表，验证存量数据没有重复，第 1 步的脏数据要是不删，迁移会直接失败并告诉你哪个值重复了。这本身就是约束在替你把关。迁移完再试一次 `INSERT` 相同 email，这次报 `duplicate key value violates unique constraint "users_email_key"`。还有个附赠：schema 里标了 `@unique` 之后，`prisma.user.findUnique({ where: { email } })` 从此可用，findUnique 只认唯一字段。

**第 3 步：写事务，并亲眼验证回滚。** 在 users.service.ts 里加方法：

```ts
async register(dto: { email: string; name: string }) {
  return this.prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: dto.email, name: dto.name },
    });

    await tx.post.create({
      data: {
        title: `欢迎你，${user.name}`,
        content: "欢迎来到 AI Agent 专栏，先随便逛逛。",
        userId: user.id,
      },
    });

    // throw new Error("模拟事务后半段失败"); // 验证回滚时临时取消注释

    return user;
  });
}
```

把它接到第 3 周留下的 POST /users 路由上，controller 里把原来对 createUser 的调用换成 register（路由要是还没接好，临时接一条能触发它的就行，Day 5 会正式串）。启动应用，先做回滚实验：取消那行 throw 的注释，发一次请求：

```powershell
curl.exe -X POST http://localhost:3000/users -H "Content-Type: application/json" -d "{\"email\":\"rollback@example.com\",\"name\":\"RB\"}"
```

请求会 500。关键不是报错，是报错之后库里有没有留下半截数据，psql 里查：

```sql
SELECT count(*) FROM users WHERE email = 'rollback@example.com';
```

count 是 0。第一步的 `user.create` 明明执行过，第二步抛错后它被整个撤掉了，这就是回滚。看完把 throw 注释回去，再发一次同样的请求，这次成功，查库验证用户和帖子都在：

```sql
SELECT u.email, p.title
FROM users u JOIN posts p ON p.user_id = u.id
WHERE u.email = 'rollback@example.com';
```

一行结果，email 和欢迎帖的 title，两步全部落库。

**第 4 步：捕获 P2002，转成 409。** 重复注册同一个 email，现在数据库会拒绝。给 register 套上「核心知识 2」的 try/catch，同一个请求连发两次：第一次 201，第二次 409，body 里是那句「邮箱 xxx 已被注册」。到这一步，防重复注册彻底不再依赖先查再插。

**第 5 步：EXPLAIN 验证索引命中。** 灌一批测试数据，让表大到能看出扫描方式的差别：

```sql
INSERT INTO users (email, name)
SELECT 'user' || g || '@example.com', '用户' || g
FROM generate_series(1, 5000) AS g;
```

两条查询对比：

```sql
EXPLAIN SELECT * FROM users WHERE email = 'user1234@example.com';
EXPLAIN SELECT * FROM users WHERE name = '用户1234';
```

email 那条的输出里有 `Index Scan using users_email_key`，走了索引；name 那条输出 `Seq Scan on users`，全表扫，因为 name 没建索引。cost 和 width 的数字会和你机器上的略有出入，看这两个关键字段就行。这两行输出就是今天的索引验证产出。看完把测试数据清掉：

```sql
DELETE FROM users WHERE email LIKE 'user%';
```

::: tip 要不要给 name 也建一个？
如果按 name 查是高频需求，照方抓药：schema 里给 name 加 `@index`，再 migrate 一次。但先过一遍「核心知识 3」的判断标准，别逢列就建。今天的任务只要求 email 唯一索引。
:::

## 常见踩坑

**坑 1：交互式事务里写了 this.prisma 而不是 tx。** 回调里 `this.prisma.user.create` 走的是普通连接，游离在事务外，它写的行不会被回滚。规矩只有一条：事务回调里的所有数据库操作一律以 `tx` 开头。这是最隐蔽也最致命的疏漏，代码评审时重点盯它。

**坑 2：把慢操作塞进交互式事务。** 默认 5 秒超时不是摆设。事务持有连接和锁，回调里调外部 HTTP 接口、发邮件、sleep，超时就是 P2028 加整单回滚。原则：事务里只放数据库操作，快进快出。要调外部服务，先在事务外拿到结果，再开一个只写库的事务收尾。

**坑 3：schema 和数据库各说各话。** 手动在 psql 里建的索引、约束，schema.prisma 不知道；反过来，schema 里写了但没跑 migrate，数据库里也没有。两边漂移久了，迁移迟早没法收场。习惯：一切结构变更走 schema + `prisma migrate dev`，psql 只用来看（`\d`、EXPLAIN），不用来改。

**坑 4：表太小，EXPLAIN 看不到 Index Scan，以为索引白建了。** 十几行的表，优化器算笔账：全表扫比先查索引再取行更便宜，于是选 Seq Scan。这是正确行为，不是索引坏了，所以第 5 步要先灌 5000 行。另外 EXPLAIN 只算计划不执行，想看真实耗时用 EXPLAIN ANALYZE，它会真的跑一遍这条语句。

**坑 5：以为索引越多越好。** 每个索引都是一棵要维护的 B-tree：INSERT 一次，每棵树都要写一次；UPDATE 撞到索引列，树也要跟着改。一张写多读少的表背上七八个索引，写入被明显拖慢，其中大半可能一个月都用不上一次。建索引是拿写入速度换查询速度的买卖，下单前先确认这列真的常被查。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 顺序式 `$transaction` 和交互式各适合什么场景？后一步要用前一步的结果时选哪个？

::: details 参考答案
顺序式传 Promise 数组，适合互不依赖的一批写操作，一个失败全部回滚；但数组项是预先构造的，拿不到前面步骤的执行结果。交互式传 async 回调，回调里可以混业务逻辑、直接使用上一步的返回值，需要传递结果时选它。纯粹「建父记录同时建子记录」还可以用嵌套写入，一条 create 搞定。
:::

2. 交互式事务回调里抛了错误，已执行的写操作会怎样？默认超时多久，超时报什么码？

::: details 参考答案
回调抛出任何错误，事务整体回滚，已执行的写操作全部撤销，数据库回到事务开始前的状态。默认超时 5 秒（maxWait 默认 2 秒），超时抛 P2028 并回滚。需要更长时间，通过第二个参数调 timeout。
:::

3. P2002 是什么？为什么 Service 里「先 findUnique 再 create」替代不了唯一约束？

::: details 参考答案
P2002 是 Prisma 的唯一约束冲突错误码，表示数据库拒绝了违反唯一索引的写入。先查再插是检查和行动两步，两个并发请求可能同时通过检查、各自插入成功，这个时间缝应用层堵不住；唯一约束由数据库在写入瞬间强制执行，是最后防线。先查再插可以留着生成更友好的错误提示，但兜底必须是约束本身。
:::

4. B-tree 索引为什么快？哪三类情况不该建索引？

::: details 参考答案
B-tree 把列值按序组织成平衡多叉树，查找每层比较一次就排除一大片，访问次数是对数级，百万行约三四次页访问就能定位；全表扫描则要线性摸完每一行。不该建：小表，全表扫本来更快；区分度低的列（布尔、状态枚举），树分不出东西；写入极重、读取极少的表，索引维护成本（写放大）盖过查询收益。
:::

5. EXPLAIN 输出里的 Seq Scan 和 Index Scan 分别意味着什么？加了索引却仍看到 Seq Scan，可能是什么原因？

::: details 参考答案
Seq Scan 是全表扫描，逐行读整张表再过滤；Index Scan 是先查索引定位匹配行的位置，再回表取数据。仍看到 Seq Scan 的常见原因：表太小，优化器判断全表扫更便宜，这是正确行为；或者查询条件里的列没建索引，比如按 name 查而只有 email 有索引。
:::

## 延伸阅读

- [Prisma 官方文档：Transactions](https://www.prisma.io/docs/orm/prisma-client/transactions)，顺序式、交互式、隔离级别、超时参数的权威说明
- [Prisma Error Reference](https://www.prisma.io/docs/orm/reference/error-reference)，P2002、P2028 等错误码的官方解释，排障先翻这页
- [PostgreSQL 官方文档：Indexes](https://www.postgresql.org/docs/current/indexes.html)，索引类型与使用准则，EXPLAIN 的细节在同站 Query Planning 一章

今天的 register 方法和 `users_email_key` 索引留好，明天按[本周日程](/week04/)进 Day 5，把 Day 3、Day 4 攒下的 Prisma 操作接进 NestJS 的 Module、Service、Controller，串出完整的 /users CRUD。
