# 第 4 周 · Day 3：Prisma CRUD 与关联查询——把内存数组换成真数据库

> 对应手册任务：学习「Prisma CRUD + 关联查询」，动手用 Prisma Client 实现用户创建和带 posts 的用户查询，当日产出接入 Prisma 的 `users.service.ts`。本篇只解决一个问题：第 3 周的 UsersService 数据躺在内存数组里，重启就失忆，关联全靠手拼，今天用 Prisma Client 把它逐方法搬进昨天迁移建好的表里，而且 Controller 一行不改。

## 今日目标

1. 说得清 PrismaClient 为什么必须全局单例，`globalThis` 技巧防的是什么泄漏
2. 掌握 `create`、`findMany`、`findUnique`、`update`、`delete` 五件套，以及 `include`、`select`、`where`（OR/contains）和 skip/take 分页的常用写法
3. 把内存版 `users.service.ts` 逐方法替换成 Prisma 实现，重启后接口照常工作，亲眼看一次「换了发动机，方向盘没动」

## 概念讲解：为什么必须换掉内存数组

第 3 周的 UsersService 大概长这样：

```ts
@Injectable()
export class UsersService {
  private users: User[] = [];
  private nextId = 1;
  // ...
}
```

当时它够用，因为那周只关心「接口长什么样」。但数组这层存储有三宗罪。

一，重启即失忆。`nest start --watch` 每次保存文件都重启进程，数组归零。你刚造的测试用户，改一行代码就没了。

二，关联靠手拼。Post 属于 User，内存里只能开两个数组，查「用户和他的文章」要 forEach 一遍手工组装。这套写法有个正式名字，叫 N+1 问题，核心知识第 3 节细说。

三，查询能力为零。按 email 模糊搜索、分页、排序，每个需求都得手写 filter/slice，写完还没有索引可用。

昨天 schema 定好、迁移跑完，数据库里 users 和 posts 两张表正空着。但表只是容器，代码和表之间还差一个翻译：拼 SQL、传参数、把结果行映射成对象、防注入，这些脏活 Prisma Client 全包了。`prisma generate` 已经根据 schema 生成了带类型的客户端，`prisma.user` 上每个方法的参数和返回值都严格对上你的模型，字段拼错，编译期就报错。

今天的路线：先弄清实例怎么建（单例），再过一遍五件套和关联查询，最后逐方法替换 UsersService。

## 核心知识

先统一口径。假设昨天的模型长这样，字段对不上的以你的 schema 为准，本文所有调用方式不变：

```prisma
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String
  posts Post[]
}

model Post {
  id       Int     @id @default(autoincrement())
  title    String
  content  String?
  author   User    @relation(fields: [authorId], references: [id])
  authorId Int
}
```

### 1. PrismaClient 单例：globalThis 防的是热重载泄漏

`new PrismaClient()` 不是建了个普通对象，它背后连着数据库连接池。连接是重资源，建得慢，占着不走。

问题出在开发环境的热重载。写在模块顶层的 `const prisma = new PrismaClient()` 会随模块一起被反复重新执行：每次保存代码，旧实例还没释放，新实例又建好了。攒到十几个，Prisma 就会报 Too many Prisma clients are already running，连接数被自己吃光。

解法是把实例挂到 `globalThis` 上，它活在模块体系之外，热重载冲不掉：

```ts
import { PrismaClient } from "@prisma/client";

function createPrismaClient() {
  return new PrismaClient();
}

// 给 globalThis 补类型声明，不然 TS 不认识 prisma 这个属性
declare global {
  var prisma: PrismaClient | undefined;
}

const prisma = globalThis.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.prisma = prisma;
}

export default prisma;
```

关键一行是 `globalThis.prisma ?? createPrismaClient()`：第一次跑，全局没有，建一个挂上去；热重载后模块重新执行，全局还挂着上一个，直接取回，全进程始终一个实例。生产环境不往全局挂，因为没有热重载，模块只执行一次，`new` 一次天然就是单例。

这套技巧是给没有依赖注入容器的场景准备的，比如独立脚本。Nest 有更体面的做法：把 PrismaClient 包成 Service 交给 DI 容器，容器按「每个应用一个实例」管理，动手任务第 1 步就做这件事。

### 2. CRUD 五件套

增：

```ts
const user = await prisma.user.create({
  data: { email: "jerry@example.com", name: "Jerry" },
});
// 返回完整 User，id 由 autoincrement 生成
```

`data` 里还能嵌套建关联数据，一次请求落两张表：

```ts
const user = await prisma.user.create({
  data: {
    email: "jerry@example.com",
    name: "Jerry",
    posts: {
      create: [{ title: "第一篇", content: "Hello Prisma" }],
    },
  },
  include: { posts: true },
});
```

关键在 `posts: { create: [...] }`：外键 authorId 由 Prisma 自动回填，不用你管。

查多条。`where` 支持 AND/OR/NOT 任意嵌套，`contains` 等价于 SQL 的 LIKE：

```ts
// 名字带 J，或者 email 是这个值的用户
const users = await prisma.user.findMany({
  where: {
    OR: [{ name: { contains: "J" } }, { email: "jerry@example.com" }],
  },
});
```

查单条：

```ts
const user = await prisma.user.findUnique({ where: { id: 1 } });
// 返回 User | null，找不到不抛错，返回 null
```

注意 findUnique 的 where 只认带 `@id` 或 `@unique` 的字段，这是它能走唯一索引的前提。按普通字段查用 findFirst。

改和删：

```ts
const updated = await prisma.user.update({
  where: { id: 1 },
  data: { name: "新名字" },
});

await prisma.user.delete({ where: { id: 1 } });
// 目标不存在时抛 P2025 错误，不是返回 null，动手任务里处理
```

### 3. include 关联查询：顺手解决 N+1

先看反面教材。查 20 个用户及各自的文章，直觉写法：

```ts
const users = await prisma.user.findMany();
for (const u of users) {
  u.posts = await prisma.post.findMany({ where: { authorId: u.id } });
}
```

1 条查用户的 SQL，加 20 条查文章的，一共 21 条。列表页每秒被打一次，数据库每秒挨 21 刀。这就是 N+1：1 次查列表，N 次查关联，N 越大死得越快。第 3 周内存版的 forEach 手拼，就是它的前身。

正解是 `include`：

```ts
const users = await prisma.user.findMany({
  include: { posts: true },
});
// 每个 user 身上多了 posts 数组，类型也跟着变：User & { posts: Post[] }
```

Prisma 底层只发两条 SQL：一条查 users，一条查 posts 且 authorId in (...)，然后在客户端拼好。「带 posts 的用户查询」说的就是它，返回值类型精确到多出来的 posts 字段。

只想拿部分字段时用 `select` 裁剪：

```ts
const users = await prisma.user.findMany({
  select: {
    id: true,
    name: true,
    posts: { select: { title: true } },
  },
});
// 出库的就只有 id、name 和文章标题
```

注意 include 和 select 在同一层互斥。想要「裁剪主表 + 带关联」，就把 select 嵌进关联字段，像上面那样。

### 4. 分页：skip/take + count

列表接口的标配是「当页数据 + 总数」：

```ts
const page = 1;
const pageSize = 10;
const where = { name: { contains: "J" } };

const [users, total] = await prisma.$transaction([
  prisma.user.findMany({
    where,
    skip: (page - 1) * pageSize,
    take: pageSize,
    orderBy: { id: "desc" },
  }),
  prisma.user.count({ where }),
]);
```

三个细节。skip/take 的换算公式是 `（页码 - 1）× 每页条数`，第 1 页 skip 0。count 的 where 必须和 findMany 一致，不然页码对不上，所以抽成变量传两处。orderBy 必须给，数据库不承诺默认顺序，不给排序，翻页可能出现重复和遗漏。`$transaction` 让两条查询并发执行，一次往返。

## 动手任务：users.service.ts 接入 Prisma 一步一步

手册任务：用 Prisma Client 实现用户创建、带 posts 的用户查询，产出接入 Prisma 的 users.service.ts。拆成 5 步，全程约 30 分钟。前提：昨天的迁移已跑完，`npx prisma generate` 执行过。

**第 1 步：建 PrismaService。** 新建 `src/prisma/prisma.service.ts`：

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

继承 PrismaClient 后，this 上就是完整的五件套。两个生命周期钩子负责启动时连接、关停时断开；想让 Ctrl+C 也触发 onModuleDestroy，在 main.ts 里加一行 `app.enableShutdownHooks()`。

再建 `src/prisma/prisma.module.ts`：

```ts
import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

到 AppModule 的 imports 里加上 PrismaModule。`@Global()` 之后所有模块都能直接注入 PrismaService，不用每个模块再 import 一遍。DI 容器保证全应用只有一个实例，核心知识第 1 节的泄漏问题，在 Nest 里到这一步就解决了。

**第 2 步：改骨架。** 打开 users.service.ts，删掉 `private users` 数组、nextId 计数器和手写的 User 接口，换成：

```ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureExists(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
  }
}
```

存了三周的状态没了，换成构造函数注入的 PrismaService，这是第 3 周 Day 5 练熟的写法。返回值类型从此由 Prisma 生成，不用手写。ensureExists 是私有小工具：update、remove 动手前先确认人在不在，不在就抛 404。为什么不直接依赖 update/delete 抛的 P2025？也行，catch 里认 `e.code === "P2025"` 再抛 NotFoundException，效果一样；先查再改更好读，二选一。

**第 3 步：create 与 findAll。**

```ts
create(createUserDto: CreateUserDto) {
  return this.prisma.user.create({ data: createUserDto });
}

findAll() {
  return this.prisma.user.findMany({ orderBy: { id: "asc" } });
}
```

对比内存版：create 少了 nextId++ 和 push，id 由数据库的 autoincrement 生成，多实例部署也不会重号；findAll 给 orderBy 保持升序，和第 3 周的数组顺序一致。前提是 DTO 字段和模型对得上，上周 DTO 里多出来的字段模型还没地方放，先对齐再跑。

**第 4 步：findOne（带 posts）、update、remove。**

```ts
async findOne(id: number) {
  const user = await this.prisma.user.findUnique({
    where: { id },
    include: { posts: true },
  });
  if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
  return user;
}

async update(id: number, updateUserDto: UpdateUserDto) {
  await this.ensureExists(id);
  return this.prisma.user.update({
    where: { id },
    data: updateUserDto,
  });
}

async remove(id: number) {
  await this.ensureExists(id);
  await this.prisma.$transaction([
    this.prisma.post.deleteMany({ where: { authorId: id } }),
    this.prisma.user.delete({ where: { id } }),
  ]);
}
```

findOne 就是「带 posts 的用户查询」，include 把关联一次带出。remove 里先删文章再删人：authorId 是外键，用户名下还有文章时数据库会拦着不让删（坑 5 详说）。$transaction 保证两步要么都成，要么都不成，不会出现文章删了人还在的中间态。

::: tip 想亲眼看 SQL？
给 PrismaService 加个构造函数：

```ts
constructor() {
  super({ log: ["query"] });
}
```

控制台会打出每条 SQL。include 是不是真的只发两条，眼见为实。
:::

**第 5 步：验证 Controller 零改动。** users.controller.ts 一行不改，重启服务，用上周的同款 curl 依次打 POST /users、GET /users、GET /users/1。看三件事：

1. POST 返回的 id 是数据库生成的，连续重启也不重置
2. GET /users/1 带出了 posts 数组（响应比上周多了这个字段，属于新能力；不想暴露就把 include 删掉，方法签名不变）
3. 再重启一次服务，GET /users 数据还在。今天所有的活，就为这一刻

第 3 周 Day 5 说过的那句话今天兑现：Controller 只认识 UsersService 的方法签名，签名没变，底下从数组换成哪种数据库，它既不知道也不关心。这就是依赖注入攒到今天的利息。

## 常见踩坑

**坑 1：到处 new PrismaClient()。** 把实例化写进 Service 方法里，或者每个请求建一个，连接池分分钟被自己吃光，报 Too many Prisma clients。规则一句话：全应用一个实例。Nest 里交给 DI 容器，独立脚本用 globalThis 技巧，怎么都行，就是不能随手 new。

**坑 2：给 findUnique 传非唯一字段。** `findUnique({ where: { name: "Jerry" } })` 过不了类型检查，因为 name 没有 @unique。两条出路：给字段加 @unique（要改 schema 重新迁移），或者改用 findFirst，它接受任意条件，返回第一条匹配。昨天给 email 标的 @unique，今天 `findUnique({ where: { email } })` 能直接用，就是那时埋下的回报。

**坑 3：include 和 select 同时写。** 同一层既 include 又 select，类型直接报错，二者互斥。要「主表裁剪 + 关联裁剪」就全用 select，关联字段里嵌套：`select: { id: true, posts: { select: { title: true } } }`。

**坑 4：把 N+1 带进数据库。** 「先 findMany 再循环查关联」的代码，每多一个用户就多一条 SQL，数据量一大接口肉眼可见地变慢。任何查完列表马上 forEach 查库的写法都值得警觉，用 include 换掉，两条 SQL 封顶。

**坑 5：删用户报 P2003。** 用户名下还有文章时执行 delete，外键约束直接拦下，抛 P2003。两种解法：教程里的 $transaction 先删文章再删人，不用动 schema；或者把关系改成级联删除 `@relation(fields: [authorId], references: [id], onDelete: Cascade)`，删用户时数据库自动带走他的文章，但要改 schema 重新迁移。删文章没人拦，因为外键长在 Post 身上，单向依赖。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. globalThis 单例技巧防的是什么？为什么生产环境不需要？

::: details 参考答案
开发环境热重载反复重新执行模块，模块顶层的 new PrismaClient() 每次都造出新实例，旧连接不释放，攒多了报 Too many Prisma clients。globalThis 活在模块体系外，重载后还能取回第一次创建的实例。生产没有热重载，模块只执行一次，new 一次就是单例，不需要兜底。
:::

2. findUnique 和 findFirst 怎么选？

::: details 参考答案
findUnique 的 where 只接受 @id 或 @unique 标记的字段，能走唯一索引，找不到返回 null；findFirst 接受任意过滤条件，返回第一条匹配。按唯一字段查用 findUnique，按普通字段查用 findFirst。找不到时两者都返回 null，都不抛错，判空是自己的事。
:::

3. 「带 posts 的用户查询」怎么写？只想返回 id、name 和文章标题时怎么写？

::: details 参考答案
`findUnique({ where: { id }, include: { posts: true } })`，返回类型自动带上 posts: Post[]。裁剪版全用 select：`select: { id: true, name: true, posts: { select: { title: true } } }`。include 和 select 同一层互斥，关联字段在 select 里嵌套 select。
:::

4. N+1 问题是什么？include 怎么解决的？

::: details 参考答案
查 1 次列表，再对 N 条记录各查 1 次关联，共 N+1 条 SQL，N 一大数据库就被打爆。include 让 Prisma 只发 2 条：主表一条，关联表用外键 in (...) 一条，然后在客户端拼好。判断标准：看到「查列表后循环查库」就该换成 include。
:::

5. 分页接口为什么必须返回 total？count 的 where 有什么讲究？

::: details 参考答案
前端要靠 total 算总页数，只有当页数据渲染不出分页器。count 的 where 必须和 findMany 完全一致，否则算出来的是全表总数，页码和数据显示对不上。抽成一个 where 变量传两处，再放进同一个 $transaction 并发执行。
:::

## 延伸阅读

- [Prisma 官方 CRUD 参考](https://www.prisma.io/docs/orm/reference/crud)，五件套每个方法的完整参数表，嵌套写入的所有姿势都在这
- [Prisma 关联查询](https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries)，include 的多层嵌套、在 where 里按关联过滤（`posts: { some: ... }`）这些进阶玩法
- [Prisma 分页](https://www.prisma.io/docs/orm/prisma-client/queries/pagination)，skip/take 之外还有 cursor 分页，数据量大时更稳，取舍讲得很清楚

今天的产出 `users.service.ts` 和 `prisma/` 目录留好。从这个节点起，项目里的数据重启不丢、关联不用手拼，后面不管给 Post 做增删改查还是写更复杂的查询，套路和今天一模一样：想清楚要什么数据，写成 Prisma 调用，让类型先过一遍，剩下的交给它。
