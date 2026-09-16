# 第 1 周：TypeScript 进阶 + Monorepo 工程化

> 所属阶段：企业级前端 + Node 全栈底座（第 1–4 周）

## 本周目标

掌握 TypeScript 泛型、条件类型、类型守卫等进阶类型能力，并用 pnpm workspace + Turborepo 搭建出支持构建缓存、跨包引用的 monorepo 工程骨架。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | TypeScript 泛型基础：类型变量、泛型函数/类、泛型约束 | 用泛型写一个 `createResponse<T>(data: T)` 工具函数，用 3 种不同类型调用 | `generics-basics.ts` |
| Day 2 | 条件类型 + 映射类型：`extends ? :`、`infer`、`Partial/Required/Readonly` | 实现 `DeepPartial<T>` 和 `UnwrapPromise<T>` 两个工具类型 | `advanced-types.ts` |
| Day 3 | 类型守卫 + 类型窄化：`is`、`asserts`、`satisfies` | 为 API 响应写一个 `isUser(data: unknown): data is User` 守卫 | `type-guards.ts` |
| Day 4 | Monorepo 概念 + pnpm workspace | 初始化 `apps/web` + `packages/shared` 的 monorepo 结构 | 可运行的 monorepo 骨架 |
| Day 5 | Turborepo 配置：`turbo.json`、任务管道 | 配置 `build`、`lint`、`test` 三个 pipeline，跑通缓存 | `turbo.json` + 缓存验证 |
| Day 6 | 共享类型包 + 共享工具包 | 在 `packages/shared` 中写一个 `ApiResponse` 类型和 `formatDate` 工具，两个 app 都能引用 | 跨包引用验证通过 |
| Day 7 | 周复盘 + 整理 | 用 Excalidraw 画 monorepo 结构图，写 300 字周记 | 架构图 + 周记 |

## 教程进度

- ✅ [Day 1 · 泛型基础](/week01/day1)
- ✅ [Day 2 · 条件类型与映射类型](/week01/day2)
- ✅ [Day 3 · 类型守卫与类型窄化](/week01/day3)
- ✅ [Day 4 · Monorepo 与 pnpm workspace](/week01/day4)
- ✅ [Day 5 · Turborepo 任务管道](/week01/day5)
- ✅ [Day 6 · 共享类型包与工具包](/week01/day6)
- ✅ [Day 7 · 周复盘方法论](/week01/day7)

## 本周参考

`crisweb1994/60-days-nodejs` 仓库的 Day 01–05 可作为补充。
