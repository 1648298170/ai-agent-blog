# 第 4 周 · Day 1：PostgreSQL 安装与基础 SQL——给数据安个真正的家

> 对应手册任务：学习「PostgreSQL 安装（Docker）+ 基础 SQL」，动手用 docker compose 启动 Postgres，创建 `users` 表，手动写 INSERT/SELECT/JOIN，当日产出「可连接的本地 PG」。本篇只解决一个问题：NestJS Users 模块的数据一直住在内存数组里，进程一重启就全没了，今天把它搬进一个真正的数据库，并且让你能裸手写出最基本的 SQL。

## 今日目标

1. 说得清为什么这个项目选 PostgreSQL 而不是 MySQL，以及它能一路陪你走到后面的 RAG 周
2. 掌握四个操作：用 docker compose 启动 `postgres:17` 并解释每一行配置、用 `psql` 连进库、写 `CREATE TABLE` 建表、手写 INSERT/SELECT/JOIN
3. 独立完成：本地跑起一个数据可持久化的 PG，建 `users` 和 `posts` 两张表，插数据，用 INNER JOIN 和 LEFT JOIN 各查一次，亲眼看两者的结果差在哪

## 概念讲解：内存数组撑不了几天

第 3 周的 Users 模块，数据大概是这样存的：

```ts
private users: User[] = [];
```

写 demo 时它很好用，认真想三秒，四个问题全露出来了。

第一，重启即失忆。`npm run start:dev` 一重启，注册过的用户全没了。进程内存不是存储，连缓存都算不上。

第二，多实例不共享。哪天部署两个 NestJS 实例做负载均衡，A 实例注册的用户 B 实例看不见，因为数组各是各的。

第三，没有约束。同一个 email 注册两次？数组照单全收。id 发重了？没人拦。业务规则全靠手写 `find()` 逐条检查，漏写一条就出脏数据。

第四，查询全靠自己。「按注册时间倒序取前 5 个」这种需求，数据库一行 SQL 的事，数组要手写排序加截断，还没有索引。

数据库把这四件事一次性接走：磁盘持久化、多连接共享、约束（NOT NULL、UNIQUE、外键）、查询语言 SQL。

那为什么选 PostgreSQL，不选同样流行的 MySQL？三条理由，第一条和本课程直接相关：

1. **pgvector 扩展**。后面 RAG 周要存文本的向量、做相似度检索。PG 装个 pgvector 扩展就能干，业务数据和向量数据躺在同一个库里，一个 JOIN 就能关联。MySQL 生态里没有同等成熟、随处可装的开源等价物，到那时你就得再引入一个独立的向量数据库。
2. **MVP 阶段的一致性**。PG 一个库同时覆盖关系表、向量（pgvector）和文档（jsonb）。项目早期最怕技术栈分裂，一个存储多面手，比「MySQL + 向量库 + 缓存」三件套好养得多。
3. **生态**。官方 Docker 镜像、Prisma 的一等公民支持、Supabase 和 Neon 这些托管服务，以后从本地迁上云几乎零改动。

今天先不上 Prisma，那是 Day 2 的事。先裸手写 SQL，因为 ORM 最终生成的东西就是这些语句，这层看懂了，后面用 Prisma 时你才知道它每一步在替你干什么。

## 核心知识

本节的 SQL 都是独立讲解示例，先对照着读懂就行，别急着往库里敲——表要到动手任务才建，而且 `email` 带 UNIQUE 约束，示例数据和动手任务的 INSERT 重复了会报错。以动手任务的数据为准。

### 1. 用 docker compose 启动 pg:17

不装 Windows 安装包，Docker 起一个干净的 PG，用完即弃，换版本只改一个数字。在练习目录新建 `docker-compose.yml`：

```yaml
services:
  postgres:
    image: postgres:17
    container_name: ai-agent-pg
    environment:
      POSTGRES_USER: jerry
      POSTGRES_PASSWORD: dev123456
      POSTGRES_DB: app_db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

逐行说清楚：

- `POSTGRES_USER / POSTGRES_PASSWORD`：首次初始化时创建的超级用户和密码；`POSTGRES_DB`：默认创建的库名。注意三个变量只在数据卷为空时生效一次，这是新手第一大坑，踩坑章节细说。
- `ports: "5432:5432"`：端口映射，格式是宿主机端口:容器端口。左边是你本机连接用的端口，右边固定 5432 别动。
- `volumes` 两行是持久化的关键：PG 的全部数据落在容器内的 `/var/lib/postgresql/data`，挂到名为 `pgdata` 的数据卷上。容器删了重建，数据还在。

### 2. 连接：psql 与客户端工具

psql 是 PG 自带的命令行客户端，容器里就有，最直接的进法：

```powershell
docker exec -it ai-agent-pg psql -U jerry -d app_db
```

`-U` 指用户，`-d` 指库。进去后提示符变成 `app_db=#`，这就是你的 SQL 战场。

也可以用图形工具（VS Code 的 PostgreSQL 扩展、DBeaver、pgAdmin 都行），连接串统一是：

```
postgresql://jerry:dev123456@localhost:5432/app_db
```

这串字符 Day 2 配 Prisma 时原样照抄，先存好。psql 里三个元命令今天就够用：`\dt` 列出所有表，`\d users` 看 users 表结构，`\q` 退出。它们以反斜杠开头，即敲即执行，不需要分号。

### 3. DDL：CREATE TABLE 与类型选择

建 `users` 表：

```sql
CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

每列都是「列名 类型 约束」三段。值得停下看的点：

- `GENERATED ALWAYS AS IDENTITY`：自增主键的现代标准写法，插数据时不用管 id，数据库自己发号；`ALWAYS` 还意味着手动插 id 会直接报错，防止两处发号打架。
- `email` 上两个约束分工明确：`NOT NULL` 拦「没填」，`UNIQUE` 拦「重复」。业务上 email 唯一，这行就是数据库替你把关，Service 里那套 `find()` 检查可以退休了。
- `TIMESTAMPTZ` 而不是 `TIMESTAMP`：带时区的时间戳，存的是绝对时刻，取出来按会话时区显示，永远选带 TZ 的那个。`DEFAULT now()` 表示插入时不写这列就自动填当前时间。
- `VARCHAR(255)` 的长度在 PG 里只是个检查上限，不预分配空间，和 `TEXT` 性能几乎没差别。写 255 是社区习惯，全用 TEXT 也完全没问题。

### 4. DML：INSERT 与 SELECT

```sql
-- 插一行，id 和 created_at 都不用给
INSERT INTO users (email, name) VALUES ('jerry@example.com', 'Jerry');

-- 一次插多行
INSERT INTO users (email, name) VALUES
  ('tom@example.com', 'Tom'),
  ('ann@example.com', 'Ann');

-- 全表查
SELECT * FROM users;

-- 条件查：字符串用单引号
SELECT id, name FROM users WHERE email = 'jerry@example.com';

-- 排序加截断
SELECT id, name, created_at FROM users ORDER BY created_at DESC LIMIT 5;

-- 改
UPDATE users SET name = 'Jerry Liu' WHERE id = 1;

-- 删：永远先写 WHERE，不写就是全表清空
DELETE FROM users WHERE id = 999;
```

六个语句就是增删改查的最小集。`SELECT *` 临时看数据方便，写正式查询时建议像例子那样明确列出列名。

### 5. JOIN：把两张表接起来

真实业务一张表不够。用户发帖子，就是典型的一对多：一个 user 有多篇 post，每篇 post 属于一个 user。建第二张表，用外键 `user_id` 指回去：

```sql
CREATE TABLE posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

关键在 `REFERENCES users(id)`：这是外键。往 posts 插一行 `user_id = 99` 而 users 里没有 99，数据库直接报错。第 3 周要在 Service 里手写检查的「帖子必须属于真实用户」，数据库一层就做掉了。

查「每个用户发了哪些帖」，把两张表按 `posts.user_id = users.id` 接起来：

```sql
-- INNER JOIN：只保留两边都能匹配上的行
SELECT u.name, p.title
FROM users u
INNER JOIN posts p ON p.user_id = u.id;

-- LEFT JOIN：左表全部保留，右边没匹配上的补 NULL
SELECT u.name, p.title
FROM users u
LEFT JOIN posts p ON p.user_id = u.id;
```

假设 Jerry 两篇、Tom 一篇、Ann 零篇：INNER JOIN 出 3 行，Ann 根本不出现；LEFT JOIN 出 4 行，Ann 照样在，只是 `title` 是 NULL。「列出所有用户及其帖子，没发过帖的也要显示」这种需求，就是 LEFT JOIN 的场景。

## 动手任务：起库、建表、手写 SQL，一步一步

拆成 5 步，全程约 30 分钟。前提：本机已装 Docker Desktop 且处于运行状态。

**第 1 步：建目录和 compose 文件。** PowerShell 里执行：

```powershell
mkdir week04-sql
cd week04-sql
```

在此目录新建 `docker-compose.yml`，内容照抄核心知识第 1 节那份。密码先用示例的 `dev123456`，本地练手够用，别拿它上生产。

**第 2 步：启动并确认就绪。**

```powershell
docker compose up -d
docker compose ps
```

`ps` 输出里 STATE 是 running 即可。再瞄一眼日志确认 PG 完全就绪：

```powershell
docker compose logs postgres
```

在输出里找 `ready to accept connections`，它出现两次（一次 IPv4、一次 IPv6）才算真正就绪，之前的连接会被拒。

**第 3 步：进 psql，建两张表。**

```powershell
docker exec -it ai-agent-pg psql -U jerry -d app_db
```

把核心知识第 3、5 节的两条 `CREATE TABLE` 原样敲进去。psql 里多行输入没问题，看到分号才执行。建完用 `\dt` 检查，应该列出 `users` 和 `posts` 两行；再用 `\d users` 看一眼表结构，那些约束都挂在列上。

**第 4 步：插数据，玩单表查询。** 先插 3 个用户和 3 篇帖子：

```sql
INSERT INTO users (email, name) VALUES
  ('jerry@example.com', 'Jerry'),
  ('tom@example.com', 'Tom'),
  ('ann@example.com', 'Ann');

INSERT INTO posts (user_id, title, content) VALUES
  (1, '你好，PostgreSQL', '从内存数组搬进数据库'),
  (1, 'JOIN 才是灵魂', '两张表接起来才有业务'),
  (2, 'Tom 的第一帖', '数组再见');
```

注意 Ann 故意不发帖，第 5 步要用她。然后逐条执行：

```sql
SELECT * FROM users;
SELECT name FROM users ORDER BY created_at DESC LIMIT 2;
SELECT id, title FROM posts WHERE user_id = 1;
UPDATE users SET name = 'Jerry Liu' WHERE email = 'jerry@example.com';
SELECT * FROM users; -- 再看一眼，Jerry 变成 Jerry Liu 了
```

**第 5 步：JOIN 对比。** 两条查询分别执行：

```sql
SELECT u.name, p.title
FROM users u
INNER JOIN posts p ON p.user_id = u.id;

SELECT u.name, p.title
FROM users u
LEFT JOIN posts p ON p.user_id = u.id;
```

数行数：INNER 是 3 行，没有 Ann；LEFT 是 4 行，最后一行 Ann 的 title 是空白（NULL）。这个对比就是今天要带走的核心体感。看完 `\q` 退出，容器留着别删。

::: tip 连接信息存好
`postgresql://jerry:dev123456@localhost:5432/app_db` 这条连接串和整个容器留好，Day 2 初始化 Prisma 时 `schema.prisma` 里的 `url` 就填它。`docker compose down` 停掉没关系，数据在卷里，`docker compose up -d` 回来一切照旧。
:::

## 常见踩坑

**坑 1：改了 `POSTGRES_PASSWORD` 却不生效。** 三个 `POSTGRES_*` 环境变量只在数据卷第一次初始化时执行。你改了密码、重启容器，PG 看到卷里已有数据，直接跳过初始化，用的还是旧密码。练手阶段的解法最干脆：`docker compose down -v` 把数据卷一起删掉再 `up -d`，从头初始化。`-v` 会清数据，生产环境别碰，本地第一天无所谓。

**坑 2：端口冲突。** 本机以前装过 PG 且还在跑，5432 就被占了，容器起来又立刻退出，日志里能翻到 `address already in use`。把映射改成 `"5433:5432"`，之后连接一律走 `localhost:5433`。注意只有冒号左边的宿主机端口能改，右边的容器内端口永远是 5432。

**坑 3：单引号和双引号用混。** SQL 里字符串只能用单引号：`'Jerry'`。双引号在 PG 里是标识符引用：`"Jerry"` 会被当成列名或表名，写成 `WHERE name = "Jerry"` 会报 `column "Jerry" does not exist`。表名列名统一小写蛇形（`user_id`、`created_at`），一旦用双引号建出 `"UserName"` 这种，以后每次引用都得带引号且大小写一字不差，纯自找麻烦。顺带一句：关键字 `SELECT` 和 `select` 都认，社区惯例是关键字大写、标识符小写，照惯例写可读性最好。

**坑 4：JOIN 忘写 ON，行数爆炸。** users 3 行、posts 3 行，JOIN 不带 ON 会得到 3 × 3 = 9 行，这叫笛卡尔积。发现查询行数远超预期，先检查 ON 有没有写。另一个方向性错误：LEFT JOIN 以左表为准，`FROM users LEFT JOIN posts` 保留全部用户，`FROM posts LEFT JOIN users` 保留全部帖子，FROM 里两张表的顺序一换，语义就换了。

**坑 5：psql 里敲了语句没反应。** 九成是分号忘写。psql 靠分号判断语句结束，没等到就一直收输入，提示符从 `app_db=#` 变成 `app_db-#` 就是在等下文。多行语句放心写，写完分号回车即执行。而 `\dt`、`\d`、`\q` 这类反斜杠元命令是即敲即执行，不需要也不应该加分号。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 这个项目选 PostgreSQL 而不是 MySQL，哪条理由和后面的课程直接相关？

::: details 参考答案
pgvector 扩展。后面 RAG 周要存向量、做相似度检索，PG 加个扩展就能在同一个库里同时管业务数据和向量数据；MySQL 没有同等成熟的自建方案，到时候得额外引入独立向量库，技术栈就分裂了。
:::

2. `docker compose down` 和 `docker compose down -v` 差在哪？分别什么场景用？

::: details 参考答案
`down` 停容器并删除容器和网络，但数据卷保留，数据不丢，`up -d` 回来数据还在；`down -v` 连数据卷一起删，所有表和数据清零。日常停启用前者；想彻底重来（比如坑 1 里改初始化环境变量）才用后者。
:::

3. `email` 列的 `NOT NULL` 和 `UNIQUE` 各拦住什么？`DEFAULT now()` 什么时候生效？

::: details 参考答案
`NOT NULL` 拦「没填」，插入时这列缺失或显式给 NULL 都报错；`UNIQUE` 拦「重复」，已有相同值就拒绝插入。`DEFAULT now()` 只在 INSERT 没提供这列的值时生效，自动填当前时间；显式给了值就用你的。
:::

4. 同一份数据（Jerry 2 篇、Tom 1 篇、Ann 0 篇），INNER JOIN 和 LEFT JOIN 的结果差在哪一行？

::: details 参考答案
差 Ann 那一行。INNER JOIN 只保留两边能匹配的行，Ann 没帖子，整行消失；LEFT JOIN 保留左表全部行，Ann 照样出现，只是 `title` 列是 NULL。要「没发帖的用户也列出来」就用 LEFT JOIN。
:::

5. `'Jerry'` 和 `"Jerry"` 在 PG 里有什么区别？

::: details 参考答案
单引号包的是字符串字面量，双引号包的是标识符（表名、列名）。`SELECT 'Jerry'` 返回一个字符串，`SELECT "Jerry"` 会被当成列名去找叫 Jerry 的列，找不到就报错。记一句话：值用单引号，名字尽量不用引号。
:::

## 延伸阅读

- [PostgreSQL 官方 Tutorial](https://www.postgresql.org/docs/current/tutorial.html)，官方入门教程，本篇所有 SQL 语法的原始出处
- [Docker Hub 的 postgres 镜像页](https://hub.docker.com/_/postgres)，`POSTGRES_*` 环境变量的权威说明，坑 1 的官方解释就在这
- [pgvector 仓库](https://github.com/pgvector/pgvector)，RAG 周的主角，现在混个眼熟就行

今天的 PG 实例、两张表和那条连接串都留好，接下来按[本周日程](/week04/)进入 Day 2，用 Prisma 把这个裸库接管下来。
