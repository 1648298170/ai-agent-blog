# 第 3 周：Node.js 核心 + NestJS 入门

> 所属阶段：企业级前端 + Node 全栈底座（第 1–4 周）

## 本周目标

吃透 Node.js 事件循环与模块系统，并用 NestJS 搭建出 Controller / Service 分层清晰、带 DTO 参数校验的完整 CRUD API。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | Node.js 事件循环六阶段 + 微任务/宏任务 | 写一个脚本，输出 `setTimeout/Promise/process.nextTick` 的执行顺序，验证理解 | `event-loop.js` + 输出日志 |
| Day 2 | Node.js 模块系统 + 环境变量管理 | 用 `dotenv` + `zod` 写一个类型安全的配置模块 | `config.ts` |
| Day 3 | NestJS 环境搭建 + 模块/控制器/服务分层 | 用 Nest CLI 创建 `apps/api`，写一个 `HealthController` 返回 `{ status: 'ok' }` | 可运行的 NestJS 项目 |
| Day 4 | NestJS Controller：路由、参数装饰器、DTO | 实现 `/users` 的 GET/POST/PUT/DELETE，用 DTO 定义请求体 | 完整 CRUD 控制器 |
| Day 5 | NestJS Service + 依赖注入 | 把用户数据操作抽到 `UsersService`，用构造函数注入到 Controller | 分层清晰的用户模块 |
| Day 6 | NestJS Pipe + class-validator | 为 DTO 添加 `@IsEmail`、`@MinLength` 等校验，写全局 `ValidationPipe` | 参数校验生效 |
| Day 7 | 周复盘 + 整理 | 用 curl 测一遍所有接口，写周记 | 接口测试记录 + 周记 |

## 教程进度

- 鉁?[Day 1 路 事件循环](/week03/day1)
- 鉁?[Day 2 路 模块与环境变量](/week03/day2)
- 鉁?[Day 3 路 NestJS 入门](/week03/day3)
- 鉁?[Day 4 路 Controller 与 DTO](/week03/day4)
- 鉁?[Day 5 路 Service 与依赖注入](/week03/day5)
- 鉁?[Day 6 路 Pipe 参数校验](/week03/day6)
- 鉁?[Day 7 路 周复盘](/week03/day7)

## 本周参考

NestJS 系统学习计划建议 Day 1 搭脚手架、Day 2 写 Controller、Day 3 做 Service 分层。
