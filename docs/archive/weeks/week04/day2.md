# 第 4 周 · Day 2：Prisma 初始化与 Schema 定义——让数据库结构长出类型

> 对应手册任务：学习「Prisma 初始化 + Schema 定义」，动手「初始化 Prisma，定义 `User` 和 `Post` 模型，运行 `prisma migrate dev`」，当日产出「`schema.prisma` + 迁移成功」。本篇只解决一个问题：昨天手写的 SQL 是字符串，表结构和 TypeScript 之间隔着一条没人看管的鸿沟，今天用一份 schema 文件把两边焊死，结构改一处，迁移 SQL 和 client 类型跟着变。

## 今日目标

1. 说得清连数据库的三种姿势（纯 SQL、查询构造器、ORM）各自换来什么、付出什么，以及 Prisma 的 schema-first 特殊在哪
2. 掌握三个关键点：`datasource` 与 `.env` 的分工、模型修饰器（`@default(cuid())`、`@relation`、`onDelete: Cascade`）、`migrate dev` 与 `migrate deploy` 的边界
3. 独立完成 User/Post 两个模型的定义并跑通首次迁移，在 `prisma/migrations` 里亲眼看到生成的 SQL，在 IDE 里摸到生成的类型

## 概念讲解：昨天还行，今天为什么换姿势

昨天你和 PG 短兵相接：docker compose 起库，手写 CREATE TABLE、INSERT、SELECT、JOIN，全跑通了。先别急着上新工具，想想项目继续长大，这套写法会先在哪里疼。

疼三处。第一，SQL 是字符串。`pool.query("SELECT id, email FROM users WHERE email = $1", [email])` 这行代码，表名改了、字段拼错了，编译器一声不吭，要等运行时查库才炸。第二，结果没有类型。`rows` 里每一行都是 any，你点 `.name`，点对了没人夸，点错了没人管，错误一路溜进业务代码。第三，表结构没有唯一事实源。表活在数据库里，代码里那个手写的 `interface User` 只是它的影子，同步全靠人肉：明天加一列忘了改接口，类型就开始说谎。

解决这三处疼，社区有三条路，一条比一条管得宽。

第一条，纯 SQL，用 pg 这类驱动直连，就是昨天的姿势。零抽象、最灵活，任何 SQL 特性都使得动，代价是三处疼全自己扛：防注入靠自己参数化，类型靠自己标注，结构同步靠自己记。SQL 功底深、查询高度定制时它是对的。

第二条，查询构造器，代表 Knex。把 SQL 拆成函数调用：

```ts
const user = await knex("users").where({ email }).first();
```

不再是裸字符串，注入解决大半，链式调用也顺手。但表结构不归它管：users 有哪些列、email 是不是 string，它不知道，返回值的类型要么 any 要么靠额外定义补。第三处疼没治。

第三条，ORM，代表 TypeORM、Sequelize、Prisma。用「模型」描述表，查库变成 `prisma.user.findUnique(...)` 这样的方法调用，结构、类型、迁移、关联一个体系全包。

Prisma 在 ORM 里走了条特别的路，叫 schema-first。TypeORM 是 code-first：先写带装饰器的 TS 实体类，数据库从代码来。Prisma 反过来：先写一份跟语言无关的 `schema.prisma`，它是唯一事实源，迁移 SQL 从它生成，数据库向它看齐；client 类型也从它生成，代码向它看齐。类型是机器照 schema 算出来的，不是人手写完再祈祷没过时。鸿沟就是这么填掉的。

## 核心知识

本节先看清文件和命令长什么样，建立整体印象，一切以动手任务里你亲手跑出来的为准。

### 1. `prisma init` 生成的两个文件

在 apps/api 里执行 `npx prisma init`，得到两样东西：

```
apps/api/
├─ prisma/
│  └─ schema.prisma   # 唯一事实源：表结构写在这里
└─ .env               # 连接串写在这里
```

schema.prisma 开头是两个块：

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}
```

`datasource` 声明连什么库：`provider` 是方言，决定迁移 SQL 按 PG 语法生成；`url` 指向环境变量 `DATABASE_URL`，注意只是指个路，真正的值在 `.env`。密码这种东西住 `.env`，schema 要提交进 git，`.env` 要进 `.gitignore`，两套房东。

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agentdb?schema=public"
```

格式是 `postgresql://用户名:密码@主机:端口/库名?schema=public`，五段对照 docker-compose.yml 填，末尾 `?schema=public` 别删，它是 PG 的命名空间，删了 Prisma 不知道表放哪。

`generator` 声明生成什么：`prisma-client-js` 表示生成 Node 用的 client，默认输出到 `node_modules/.prisma/client`，业务代码里的类型全部来自这里。

monorepo 里这套东西放哪：`prisma/` 目录、`.env`、两个依赖，全部跟着 apps/api 走，命令也都在 apps/api 下执行。判断标准很简单：client 的消费方是 API 服务，依赖装谁家、生成物就落谁家。想在仓库根目录一把梭，`pnpm --filter api exec prisma migrate dev` 效果等价。

### 2. 模型语法：把 User 和 Post 写进 schema

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  posts     Post[]
}

model Post {
  id        String   @id @default(cuid())
  title     String
  content   String?
  published Boolean  @default(false)
  createdAt DateTime @default(now())
  author    User     @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId  String

  @@index([authorId])
}
```

逐个拆。字段是三段式：名字、类型、修饰器。`String?` 的问号表示可空，对应昨天 SQL 里的 NULL 列。

- `@id` 声明主键；`@default(cuid())` 表示插入时不传 id，Prisma 自动生成一个不重复、不暴露顺序的字符串 id。想要数字自增就写 `Int @id @default(autoincrement())`。取舍：cuid 短、适合直接暴露给前端的资源，uuid 也行，用长度换全局唯一。
- `@unique` 唯一约束，迁移时转成 UNIQUE 索引，重复插入直接报错。
- `@default(now())` 建行时间自动填，不用代码里手动 `new Date()`。
- `@relation` 是一对多的核心。外键永远住在「多」的一方：`authorId` 是真实落库的列，`author` 和 User 上的 `posts Post[]` 是「关系字段」，只存在于 schema，查询时用来带出关联数据，不占数据库字段。`fields: [authorId]` 指向外键列，`references: [id]` 指向对方主键。
- `onDelete: Cascade`：删除 User 时，数据库连带删掉他名下的 Post。不写时默认行为更保守，会拦住删除报外键错误。这是把删除权放大一个量级的开关，想清楚再开。
- `@@index([authorId])`：PG 不会自动给外键列建索引，删作者、按作者查帖子都会慢，手动补一个。索引的更多门道 Day 4 展开。

关系两边必须成对：Post 写了 `author`，User 就得有 `posts Post[]`，缺一边 schema 校验都过不了。

### 3. `migrate dev`：一条命令，三件事

```bash
npx prisma migrate dev --name init
```

它依次做三件事。一，算差异：把 schema 和上次迁移的状态做对比，为了保证算得准，它会临时建一个影子库重放历史迁移（本地 docker 里的超级用户权限天然够用）。二，生成并应用迁移：差异写成 `prisma/migrations/<时间戳>_init/migration.sql`，再把这份 SQL 在你的库上执行，并在 `_prisma_migrations` 表里记一笔。三，重新生成 client：schema 变了，`@prisma/client` 的类型跟着重算，这步自动完成。

migration.sql 打开长这样（节选），就是昨天你手写的那种 SQL：

```sql
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
```

`dev` 还有个孪生兄弟 `deploy`，边界必须一次记住：

| | `migrate dev` | `migrate deploy` |
| --- | --- | --- |
| 生成新迁移 | 会 | 不会 |
| 应用已有迁移 | 会 | 会 |
| 检测 drift 并要求 reset | 会（有权清库） | 不会 |
| 重新生成 client | 会 | 不会 |
| 使用场景 | 开发机 | 生产 / CI |

一句话：dev 是开发时的驾驶座，一切以你为本；deploy 是发布时的执行器，一切以迁移文件为准。

## 动手任务：初始化 + 建模 + 迁移，一步一步

手册任务：初始化 Prisma，定义 `User` 和 `Post` 模型，跑通 `prisma migrate dev`。拆成 5 步，全程约 25 分钟。

**第 1 步：装依赖。** 终端进到 apps/api：

```bash
cd apps/api
pnpm add -D prisma       # CLI：init / migrate / generate / studio 这些命令
pnpm add @prisma/client  # 运行时：业务代码里 import 的包
```

为什么一个带 `-D` 一个不带：CLI 只在开发机上用，不进构建产物，放 devDependencies；client 是运行时依赖，打包要带上，必须进 dependencies。装完 `npx prisma -v` 能打印版本号就算成功。

**第 2 步：初始化，填连接串。**

```bash
npx prisma init
```

得到 `prisma/schema.prisma` 和 `.env`（apps/api 已有 `.env` 的话它会追加，不覆盖旧内容）。把连接串改成昨天 compose 里的真实配置，对照核心知识第 1 节的格式逐段填。填完别急着验证，第 4 步的迁移本身就是连通性测试。

**第 3 步：写模型。** 把核心知识第 2 节的两个 model 追加到 schema.prisma 末尾，然后跑一次：

```bash
npx prisma format   # 字段自动对齐，白送的格式化
npx prisma validate # 只校验不迁移，零报错再进下一步
```

注意 `authorId` 的拼写必须和 `@relation(fields: [...])` 里写的完全一致，手滑一个字母就是一轮排查。

**第 4 步：跑迁移，正面迎接 drift。**

```bash
npx prisma migrate dev --name init
```

成功标志是终端打出 Your database is now in sync with your schema 和 Generated Prisma Client。

有个高概率插曲：昨天你在同一个库里手动 CREATE TABLE 过，这些表不属于任何迁移文件，Prisma 会检测到 drift，问你是否 reset。选 yes，它会清空这个库再按迁移文件重建，昨天的练习数据会没。这不是事故，是入场费：从今天起，表结构的唯一入口是迁移文件，谁都不能绕过它直接改库。真想保留昨天的表，换个思路：改 `.env` 里的库名，进容器用 createdb 建个新库再跑迁移，旧库原样躺着。

**第 5 步：验证三件事。**

第一，打开 `prisma/migrations/<时间戳>_init/migration.sql`，认一认里面的 `CREATE TABLE "User"`、`CREATE UNIQUE INDEX "User_email_key"`、`FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE`。昨天学的 SQL 一个词都没白学，今天只是换了个东西替你写。

第二，`npx prisma studio`，浏览器打开 localhost:5555，左边列着 User 和 Post，这是 Prisma 送的可视化面板，以后查数据很顺手。

第三，摸一下生成的类型。在 apps/api/src 下新建 `check-type.ts`：

```ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// 悬停 findByEmail，返回类型是 Promise<User | null>，这个 User 就是从 schema 生成的
const findByEmail = prisma.user.findUnique({
  where: { email: "jerry@example.com" },
});
```

在 IDE 里悬停 `findByEmail` 看类型；把 `"jerry@example.com"` 改成 `42`，红线立刻出现。文件不用跑，留着，明天写 CRUD 从它开始。

::: tip Prisma 命令速查
`npx prisma format` 格式化 schema；`npx prisma validate` 只校验；`npx prisma generate` 只重新生成 client；`npx prisma studio` 可视化看数据。改了 schema 之后，统一入口永远是 `migrate dev`，其余都是配角。
:::

## 常见踩坑

**坑 1：连接串和 compose 对不上。** 报 Can't reach database server 或认证失败，九成是 `.env` 五段里有一段填错：用户名密码不是 compose 里那对、端口不是映射出来的那个、库名拼写不一致。逐项对着 docker-compose.yml 抄，别凭记忆。`?schema=public` 被顺手删掉也会以另一种方式炸。

**坑 2：migrate dev 和 migrate deploy 拿错。** dev 是开发机专用：生成迁移、应用迁移、重生成 client，还握着 reset 清库的权力。deploy 是生产/CI 专用：只把 migrations 目录里已有的文件挨个应用，绝不生成、绝不 reset。本地误用 deploy，改了 schema 却没有迁移生成；生产误用 dev，存在清空生产库的风险。背一句：开发 dev，发布 deploy。

**坑 3：关系只写了一半。** Post 上写了 `author`，User 上忘了 `posts Post[]`，validate 直接报错，提示关系缺对面字段。一对多永远成对出现：带 `fields` 的一方持有真实外键列，`Post[]` 一方只是查询入口，不落库。

**坑 4：onDelete: Cascade 想当然。** 默认行为是拦住你：删一个名下还有帖子的用户，外键报错。加了 Cascade 才是删用户连带删光帖子。开之前想清楚：删一个测试用户，他名下几万条帖子跟着蒸发，这种事值不值得自动发生。默认值保守，是有道理的。

**坑 5：schema 改了，类型没跟上。** `@prisma/client` 刚装好时是个空壳，真正的内容是第一次 migrate dev（或手动 generate）之后生成到 `node_modules/.prisma/client` 的。所以 clone 下来的项目直接跑会报 `@prisma/client did not initialize yet`，先跑 `npx prisma generate`；改了 schema 但类型里没有新字段，也是同一个原因。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 纯 SQL、查询构造器、ORM 三条路各自的核心取舍是什么？Prisma 的 schema-first 又特殊在哪？

::: details 参考答案
纯 SQL 零抽象最灵活，但类型、注入防护、结构同步全靠自己；查询构造器把 SQL 函数化，注入解决大半，但表结构不归它管，类型要另配；ORM 用模型描述表，结构、类型、迁移、关联一体。schema-first 特殊在唯一事实源是一份独立的 schema.prisma：迁移 SQL 由它生成（数据库向它看齐），client 类型也由它生成（代码向它看齐），类型是机器算出来的，不会和数据库漂移。
:::

2. `npx prisma migrate dev --name init` 一条命令依次做了哪三件事？

::: details 参考答案
一，借影子库对比 schema 和上次迁移，算出差异；二，把差异写成 prisma/migrations 下的 migration.sql，在目标库执行并记入 `_prisma_migrations` 表；三，重新生成 `@prisma/client`，让类型跟上 schema。
:::

3. `migrate dev` 和 `migrate deploy` 分别什么时候用？用错了各有什么后果？

::: details 参考答案
dev 在开发机用：生成迁移、应用迁移、重生成 client，检测到 drift 时有权 reset 清库。deploy 在生产/CI 用：只应用已有迁移文件，不生成、不 reset。本地误用 deploy，改了 schema 却不生成迁移；生产误用 dev，存在清空生产库的风险。
:::

4. `author User @relation(fields: [authorId], references: [id], onDelete: Cascade)` 这行里，哪个是真实落库的列？删一个有帖子的用户会发生什么？不写 `onDelete` 呢？

::: details 参考答案
`authorId` 是真实列，`author` 是查询用的关系字段，不占数据库字段。写了 Cascade，删用户时数据库连带删掉他名下所有帖子；不写时默认行为是拦住删除、报外键错误，直到先处理掉那些帖子。
:::

5. 业务代码里 import 的 `User` 类型是从哪来的？为什么昨天没有、今天有了？

::: details 参考答案
来自 `@prisma/client`，但真正的内容是第一次 migrate dev（或手动 generate）时根据 schema.prisma 生成到 `node_modules/.prisma/client` 的，`@prisma/client` 只是把它转发出来。昨天没跑过生成，它是个空壳；今天迁移成功，类型就长出来了，以后 schema 每改一次都会重新生成。
:::

## 延伸阅读

- [Prisma 官方文档：Schema](https://www.prisma.io/docs/orm/prisma-schema)，datasource、generator、模型语法的原始出处，字段修饰器拿不准就来查
- [Prisma 官方文档：Migrate](https://www.prisma.io/docs/orm/prisma-migrate)，migrate dev 与 deploy 的官方对照，dev 的 reset 行为讲得很细
- [Prisma 官方文档：Client](https://www.prisma.io/docs/orm/prisma-client)，明天 CRUD 的预习材料，findUnique、findMany、include 先混个脸熟

今天的产出 `schema.prisma` 和整个 `prisma/migrations` 目录要一起提交进 git，迁移文件就是数据库的历史。明天 Day 3，拿着今天生成的 client 写真正的 CRUD 和带 posts 的关联查询。
