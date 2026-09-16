# 第 6 周：Redis + 缓存 + 队列 + 并发控制

> 所属阶段：后端工程化 + 数据 + 部署（第 5–8 周）

## 本周目标

掌握 Redis 数据结构与缓存策略（Cache-Aside / TTL / 防穿透），并用 BullMQ 消息队列、分布式锁与幂等键解决高并发下的重复提交与一致性问题。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | Redis 基础：String/Hash/List/Set/ZSet | 用 `ioredis` 实现缓存 `get/set` 封装，并把第 5 周的 token 黑名单从 PG 迁移到 Redis | `cache.service.ts` |
| Day 2 | 缓存策略：Cache-Aside、TTL、穿透/击穿/雪崩 | 给 `/users` 列表加缓存，设置 TTL，写空值缓存防穿透 | 带缓存的用户列表 |
| Day 3 | 分布式锁：`SET NX PX` + Lua 脚本释放 | 实现一个“防止重复提交”的分布式锁 | 防重复提交中间件 |
| Day 4 | BullMQ 消息队列基础：Queue/Worker/Job | 用 BullMQ 写一个“发送欢迎邮件”的异步任务 | 异步邮件任务跑通 |
| Day 5 | 任务重试 + 延迟任务 + 定时任务 | 配置 job 重试策略，实现一个延迟 5 分钟的任务 | 重试 + 延迟验证 |
| Day 6 | 幂等性设计：唯一约束 + 幂等键 | 为“创建订单”接口实现基于 `idempotency-key` 的幂等控制 | 幂等接口 |
| Day 7 | 周复盘 + 整理 | 画一张“请求进入后的缓存→锁→队列”流程图，写周记 | 流程图 + 周记 |

## 教程进度

- 鉁?[Day 1 路 Redis 基础](/week06/day1)
- 鉁?[Day 2 路 缓存策略](/week06/day2)
- 鉁?[Day 3 路 分布式锁](/week06/day3)
- 鉁?[Day 4 路 BullMQ 队列](/week06/day4)
- 鉁?[Day 5 路 重试延迟与定时](/week06/day5)
- 鉁?[Day 6 路 幂等设计](/week06/day6)
- 鉁?[Day 7 路 周复盘](/week06/day7)
