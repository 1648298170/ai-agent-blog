# 第 5 周：认证授权 + 安全基础

> 所属阶段：后端工程化 + 数据 + 部署（第 5–8 周）

## 本周目标

掌握 JWT 签发 / 鉴权 / 刷新、RBAC 角色权限与 OAuth2 第三方登录流程，并为 NestJS 应用完成 SQL 注入、XSS、CSRF 等安全加固。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | JWT 原理：Header/Payload/Signature、签名验证 | 用 `@nestjs/jwt` 实现 `/auth/login` 返回 access token | JWT 签发 |
| Day 2 | JWT 鉴权：Guard + 自定义装饰器 | 写 `JwtAuthGuard` 和 `@CurrentUser()` 装饰器，保护 `/users/me` | 受保护路由可用 |
| Day 3 | Refresh Token + Token 轮换 | 实现 `/auth/refresh`，用 PostgreSQL 表存 refresh token 黑名单（第 6 周学完 Redis 后迁移） | Token 刷新链路 |
| Day 4 | RBAC：角色、权限、`@Roles()` 装饰器 | 定义 `admin`/`user` 角色，实现 `RolesGuard` | 角色权限控制 |
| Day 5 | OAuth2 概念 + 第三方登录流程 | 画出 Google OAuth 登录时序图，理解 code exchange 流程 | OAuth 时序图 |
| Day 6 | Web 安全：SQL 注入、XSS、CSRF | 用 Prisma 参数化查询验证防注入；配置 Helmet + CORS | 安全加固配置 |
| Day 7 | 周复盘 + 整理 | 用 Postman 跑一遍完整认证流程，写周记 | 认证流程记录 + 周记 |

## 教程进度

::: info 教程编写中
本周教程尚未发布，请先对照上方日程表配合手册学习，或从[第 1 周教程](/week01/)开始。
:::

## 本周参考

`60-days-nodejs` 覆盖 JWT、OAuth 2.0、RBAC 和 Web 安全防护。
