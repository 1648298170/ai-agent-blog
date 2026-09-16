# 第 4 周 · Day 7：阶段一里程碑验收——四个星期一条链，逐项过秤

> 手册任务：学习「阶段一里程碑验收 + 周复盘」，动手确认 monorepo + lint/test + Next.js + NestJS + PostgreSQL + Prisma 全链路打通，当日产出「里程碑项目 v1 + 周记」。
> 本篇解决的问题只有一个：怎么证明这四个星期搭的东西全链路打通了，而不是"每个好像都跑起来过"。

## 今日目标

1. 拿六项验收清单逐条过秤，每项亲眼看到预期输出，全绿才认里程碑 v1
2. 不看教程，用 Excalidraw 画出浏览器到 PostgreSQL 的全链路架构图
3. 用 STAR 法则把阶段一写成一段讲得出去的记录，配 300 字周记，git 打 tag 收口

## 概念讲解：六个组件都跑通过，不等于一条链是通的

先算一笔账。四个星期，你学了 TS 进阶、monorepo、质量门禁、Next.js 15、NestJS 分层、PostgreSQL、Prisma，凑成一套全栈底座。每个 Day 的当日产出你都拿到了：[Day 2](/week04/day2) 迁移成功，[Day 6](/week04/day6) 联调成功。但这些证明的都是单点：那一天的它，在那天的情况下，跑通过一次。

里程碑验收要的是另一种证据：六个组件拼成一条链之后，作为一个整体还能跑。这两件事中间隔着接缝。

- 契约接缝：shared 里的 `User` 类型改过之后，web 编译时看到的 `dist` 是不是新的
- 进程接缝：api 不起，web 的 `/users` 就只剩 error.tsx 兜底
- 环境接缝：`.env` 喂 Prisma，`.env.local` 喂 Next，谁漏配谁断链，断的位置还各不相同
- 生命周期接缝：容器重启之后数据在不在，卷说了算

单点学习永远踩不到接缝，接缝只在集成时暴露。所以验收清单的本质，是把每条接缝翻译成一条命令加一个预期输出。"前后端通了"是形容词，没法验收；"刷新 /users 看到刚 POST 的那条"是观察结果，可以打勾。

还有一条工程习惯提前立住：过秤自底向上。先验存储（PG），再验服务（NestJS），最后验页面（Next）。底层不绿，上层验了也白验；反过来，上层挂了还能顺着链二分，先 curl 后端，后端好就是 web 这一侧的事。

## 核心知识

### 1. 验收清单：六项逐条过秤

清单口径和手册一致。每项给"怎么验"和"通过标准"，跑一条勾一条。

**第 1 项：monorepo 与 turbo 缓存命中**

```bash
pnpm turbo build   # 第一次，部分任务 cache miss，正常
pnpm turbo build   # 什么都不改，原样再跑
```

通过标准：第二次每个任务都显示 `cache hit, replaying output`，末尾统计 `Cached: 2 cached, 2 total`（包数以你的为准），Time 那行跟着 `>>> FULL TURBO`。这个画面[第 1 周 Day 5](/week01/day5) 见过。再补一刀：往 `packages/shared/src` 加一行注释重跑，预期 shared 重建、下游跟着重建，其余不动。缓存按内容算，不按时间算，这一刀验的是增量构建还灵。

**第 2 项：lint/test 门禁**

```bash
pnpm lint
pnpm test
```

通过标准：两条全绿退出（test 走 turbo，先确认 build 已缓存，再在各包跑 `vitest run`）。门禁还要验"拦得住"：找个 ts 文件塞一个未使用变量，`git add` 后提交，预期 lint-staged 报 no-unused-vars、提交中止；撤掉改动，故意写一条不合规的提交信息再提交，预期 commitlint 报 `type may not be empty`、再次中止。两次都被拦，门禁才算在岗。只验"能过"不验"能拦"，等于只验了门没验锁。

**第 3 项：Next dashboard 可访问**

```bash
pnpm --filter @my/web dev
```

浏览器开 `http://localhost:3000/dashboard`（第 2 周 Day 4 建的那页），正常渲染即过。懒得开浏览器就 `curl -I http://localhost:3000/dashboard`，看到 `200 OK` 也算。

**第 4 项：NestJS CRUD 与校验 400**

```bash
pnpm --filter api dev    # 4000 端口，3000 是 web 的，别记岔
curl http://localhost:4000/users
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Milestone","email":"not-an-email"}'
```

通过标准三条：GET 返回 200 和真实数据；非法 email 的 POST 返回 400，响应体 message 数组点名 `email must be an email`，这是全局 ValidationPipe 在干活；换成合法 email 重发，返回 201 而不是 200，Nest 对 `@Post()` 的默认约定。有余力就把 PUT、DELETE 各来一发，第 3 周 Day 7 的七连测整个搬来重跑最好。PowerShell 用户留意：终端里的 `curl` 是别名，引号会被拆坏，换单独的 `curl.exe` 或 `Invoke-RestMethod`。

**第 5 项：PG 数据持久化，重启容器数据还在**

```bash
docker compose restart postgres
docker exec -it ai-agent-pg psql -U jerry -d app_db
```

psql 里执行：

```sql
SELECT count(*) FROM "User";
```

通过标准：重启前后 count 一致。想验得更狠一档：`docker compose down` 再 `up -d`，容器删了重建，数据照旧，因为数据躺在 pgdata 卷里，[第 4 周 Day 1](/week04/day1) 那两行 volumes 干的就是这个。一个高频冤案提前拆：表名必须带双引号。Prisma 迁移建的表叫 `"User"`，大写开头，PG 对不带引号的标识符一律折成小写，写 `FROM User` 会报 `relation "user" does not exist`，那不是数据丢了，是引号没写。

**第 6 项：前后端联调，页面渲染真数据**

三个进程起齐：PG（`docker compose up -d`）、api、web。浏览器开 `http://localhost:3000/users`，三条标准一条不能少：

1. 列表内容和第 5 项 SELECT 的结果一致，不是 mock 数组里那个数据库查无此人的 Jerry
2. 用 POST 或 Prisma Studio（`localhost:5555`）加一条用户，刷新页面立刻出现，证明 `no-store` 在拦缓存
3. `Ctrl+C` 停掉 api，刷新页面，看到 error.tsx 的兜底界面而不是白屏；重启 api 点「重试」，页面恢复

六项全绿，手册里那句"全链路打通"才算数。哪项卡住，下一节按表排查。

### 2. 不达标排查表

| 症状 | 先查什么 | 常见原因和修法 |
| --- | --- | --- |
| 二跑 build 没有 FULL TURBO，全在重新执行 | turbo.json | 一，build 任务没配 `outputs: ["dist/**"]`，缓存没存产物；二，任务名和子包 script 名不一致，turbo 根本扫不到；三，跑过 `--force` 或删过 `.turbo/`，缓存被清空。对照第 1 周 Day 5 的配置逐行核 |
| `prisma migrate dev` 报 drift 要 reset | 有没有人绕过迁移改库 | 手动 CREATE TABLE、直接改表、或在别的分支跑过别的迁移，都会让库和迁移历史对不上。开发库让它 reset 重建是正解，入场费是练习数据，[第 4 周 Day 2](/week04/day2) 交代过这笔账；两个分支迁移撞车时，先让两边迁移都应用上，再重新生成一个合并迁移，别手改时间戳 |
| `/users` 页面 fetch failed，兜底 UI 出场 | API_URL 三连 | 一，api 起了吗：`curl http://localhost:4000/users` 直接打后端，后端不通先修后端；二，`.env.local` 改过没：Next 只在启动时读环境变量，改完必须重启 dev server；三，值写对没：是 `localhost:4000`，而且 web 哪天进了容器，`localhost` 指向容器自己，得换成 compose 里的服务名 |

三条表覆盖验收日最常见的三种挂法。共同心法一句话：自底向上二分，先确认底层可用，再往上追。

### 3. 全链路架构图：Excalidraw 文字版清单

和[第 1 周 Day 7](/week01/day7) 画 monorepo 图同一套方法：先凭记忆画，卡住翻这周教程确认，合上继续。清单如下：

```text
节点（6 个，方框）：
  ① 浏览器：用户所在，只认识 localhost:3000
  ② apps/web：Next.js 15，端口 3000，Server Component 里发 fetch
  ③ packages/shared：@my/shared，User 与 ApiResponse<T> 契约
  ④ apps/api：NestJS，端口 4000，Controller/Service 分层
  ⑤ Prisma Client：apps/api 内部，Service 的取数工具
  ⑥ PostgreSQL：docker 容器 ai-agent-pg，端口 5432，数据卷 pgdata

实线边（3 条，运行时请求）：
  浏览器 → apps/web
  apps/web → apps/api（标注 API_URL，值来自 .env.local）
  apps/api → PostgreSQL（边上标 Prisma Client）

虚线边（2 条，类型依赖，不是运行时请求）：
  apps/web ⇢ packages/shared（workspace:*）
  apps/api ⇢ packages/shared（workspace:*）
```

和第 1 周那张图比，三个新要求。第一，边从一条变三条，类型依赖和运行时请求必须用两种线分开，混着画会让人以为浏览器的请求要路过 shared。第二，每条 HTTP 边标端口，3000 和 4000 谁是谁，图上一眼定。第三，PG 旁边标卷名，持久化的下落一目了然。画完导出 PNG，命名 `week04-fullstack.png`，第 1 周的 `week01-monorepo.png` 别删，两张并排放，四个星期的生长肉眼可见。

### 4. STAR 法则：把里程碑写成一段讲得出去的话

里程碑 v1 不只是一个 tag，还得是一段你说得出、别人听得懂的项目记录。模板四段：

| 段 | 写什么 | 一句话标准 |
| --- | --- | --- |
| Situation 情境 | 当时面对什么状况 | 不了解背景的人也能听懂 |
| Task 任务 | 要解决什么，约束是什么 | 有边界，不是"做个项目" |
| Action 行动 | 做了什么决策，为什么 | 重点写取舍，不是步骤复述 |
| Result 结果 | 可验证的产出 | 有观察得到的证据，最好有数字 |

阶段一示例，展开一个决策：共享类型为什么放 packages/shared。

```text
S：monorepo 里两个应用各自开发，apps/web 要渲染用户，apps/api 要
返回用户，同一份 User 类型和 ApiResponse 契约两边都要用。
T：两端类型同源，改一处两端生效；同时 web 不能依赖 api 的源码，
也不想手抄两份等着漂移。
A：抽 @my/shared，两端 workspace:* 引用。两个关键取舍：类型放任何
一端都会让另一端依赖它端源码，放独立包，谁也不依赖谁；User 定义成
对外契约，只暴露愿意暴露的字段，不复用 Prisma 生成的类型，避免表
结构（以及将来的密码哈希字段）泄漏进前端。turbo 管道挂 ^build，
下游构建前 shared 必先构建。
R：契约一处改、两端编译期同步生效；联调时 body.data 点出的每个
字段都有编译器背书；类型编译期擦除，运行时零成本。
```

照这个密度再写两三条，比如"为什么选 PostgreSQL 不选 MySQL"（[Day 1](/week04/day1) 有现成素材）、"为什么取数放 Server Component 而不是浏览器里 fetch"，阶段一的 STAR 素材就齐了。四段里 Action 最值钱，面试和复盘问的全是它。

### 5. 周记四段式

模板还是[第 1 周 Day 7](/week01/day7) 那四段：最大收获、卡得最久、还含糊、下周前补什么。第 4 周示例，照这个密度写：

```text
① 本周最大收获：表结构、迁移 SQL、client 类型从一份 schema.prisma
长出来，改结构的入口从此只有一个，迁移文件就是数据库的 git log。
② 卡得最久：migrate dev 第一次就报 drift 要 reset，愣了半天不敢点
yes，翻文档才明白是 Day 1 手建的表不算任何迁移的功劳，reset 是入
场费不是事故。
③ 还含糊：事务 rollback 的边界，include 和 select 的取舍，能跑但
说不出理由。
④ 下阶段前补：Day 4 的事务例子脱稿重写一遍；Prisma 文档 relation
queries 章节通读。
```

## 动手任务：验收日完整流程

五步，留足 120 分钟，别压缩前两步。

**第一步：六项过秤（40 分钟）。** 按核心知识 1 逐项跑，服务自底向上起。每项跑完当场打勾或记卡点，别全跑完再回忆，记忆会替你美化结果。

**第二步：画全链路架构图（20 分钟）。** 关掉教程画，导出 `week04-fullstack.png`，`.excalidraw` 源文件一起存。

**第三步：写 STAR（20 分钟）。** packages/shared 那条照示例写透，再自选两条，存进笔记，文件名 `phase-one.md`。

**第四步：写 300 字周记（15 分钟）。** 四段模板，别写成功能清单。

**第五步：git 收口（15 分钟）。** 周记、架构图、STAR 分开提交，最后打 tag：

```bash
git add docs
git commit -m "docs: 阶段一周记与全链路架构图"
git tag milestone-v1
```

tag 打下去，阶段一收口。四周前你还在和泛型较劲，现在手里是一条从浏览器直通数据卷的完整链路。

## 常见踩坑

**只验成功路径。** 六项都绿就收工，一次拦截、一次故障都没验过。门禁没拦过脏提交、页面没见过 api 停机，这两块就等于没过秤。成功路径验的是"能跑"，失败路径验的是"能扛"，里程碑两个都要。

**一口气改好几处再验。** 清单挂了两项，顺手全修完再重跑，结果还挂，信息量归零。验收日一次只改一处、重跑一次，纪律比平时严，因为你要的是每项独立打勾。

**STAR 写成功能清单。** "实现了 monorepo、配置了门禁、搭了前后端"，这是目录不是 Action。每个决策后面得跟着"为什么这么选、放弃了什么"。判断标准：拿掉项目名，还能不能分清哪句是"你的决策"、哪句是"教程的步骤"。

**架构图照第 1 周的老画法。** 三条实线挤成一条，类型依赖画成运行时调用，端口一个不标。第 1 周全图只有一条边，怎么画都错不到哪去；现在链路长了，两种线、端口、卷名，少一样，这张图就回答不了"谁在请求谁、数据住在哪"。

## 延伸阅读

- [Turborepo 官方文档：Caching](https://turborepo.com/docs/caching)，缓存 key 怎么算、outputs 存什么，排查"缓存不生效"的权威出处
- [Prisma 官方文档：Prisma Migrate](https://www.prisma.io/docs/orm/prisma-migrate)，迁移、drift、reset 的完整说明，排查表第二行的原文
- [Excalidraw](https://excalidraw.com)：还是它，手绘风专治美术冲动
- [Wikipedia：Situation, task, action, result](https://en.wikipedia.org/wiki/Situation,_task,_action,_result)：STAR 的出处和变体，十分钟读完

阶段一到此收口。第 5 周进阶段二，第一件事是给这套链路加登录：JWT、Guard、角色权限。到那时 User 表要添密码字段了，而契约里依然不会有它，今天 STAR 里那条"表结构和对外契约分离"的决策，下周开始兑现。

本周完整日程见[第 4 周目录](/week04/)。
