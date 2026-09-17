# 第 4 周：PostgreSQL + Prisma + 全栈整合

> 所属阶段：企业级前端 + Node 全栈底座（第 1–4 周）

## 本周目标

掌握 PostgreSQL 基础 SQL 与 Prisma ORM（Schema / CRUD / 事务 / 索引），并把 Next.js + NestJS + PostgreSQL + Prisma 全链路整合为一个可跑通的全栈 CRUD 应用。

阶段一里程碑要求——确认：monorepo + lint/test + Next.js + NestJS + PostgreSQL + Prisma 全链路打通。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | PostgreSQL 安装（Docker）+ 基础 SQL | 用 `docker-compose` 启动 Postgres，创建 `users` 表，手动写 INSERT/SELECT/JOIN | 可连接的本地 PG |
| Day 2 | Prisma 初始化 + Schema 定义 | 初始化 Prisma，定义 `User` 和 `Post` 模型，运行 `prisma migrate dev` | `schema.prisma` + 迁移成功 |
| Day 3 | Prisma CRUD + 关联查询 | 用 Prisma Client 实现用户创建、带 posts 的用户查询 | `users.service.ts` 接入 Prisma |
| Day 4 | Prisma 事务 + 索引 | 写一个“创建用户并同时创建欢迎帖子”的事务，给 email 加唯一索引 | 事务代码 + 索引验证 |
| Day 5 | NestJS + Prisma 整合：Module/Service/Controller 完整串联 | 把 Day 3-4 的 Prisma 操作接入 NestJS，完成 `/users` 的完整 CRUD | 全栈 CRUD API 跑通 |
| Day 6 | 前端消费：Next.js 调用 NestJS API | 在 `apps/web` 的 Server Component 中 fetch NestJS 的 `/users`，渲染列表 | 前后端联调成功 |
| Day 7 | 阶段一里程碑验收 + 周复盘 | 确认：monorepo + lint/test + Next.js + NestJS + PostgreSQL + Prisma 全链路打通 | 里程碑项目 v1 + 周记 |

## 教程进度

- ✅[Day 1 路 PostgreSQL 基础](/week04/day1)
- ✅[Day 2 路 Prisma 入门](/week04/day2)
- ✅[Day 3 路 Prisma CRUD](/week04/day3)
- ✅[Day 4 路 事务与索引](/week04/day4)
- ✅[Day 5 路 NestJS 整合 Prisma](/week04/day5)
- ✅[Day 6 路 前后端联调](/week04/day6)
- ✅[Day 7 路 阶段一里程碑](/week04/day7)
