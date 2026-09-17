# 第 2 周：代码质量门禁 + 测试 + Next.js 全栈路由

> 所属阶段：企业级前端 + Node 全栈底座（第 1–4 周）

## 本周目标

建立"提交即校验"的代码质量门禁（ESLint / Prettier / Husky / Vitest），并用 Next.js 15 App Router 完成 Server Components 与 Server Actions 的全栈路由开发。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | ESLint + Prettier 配置 | 在 monorepo 根目录配置 `eslint.config.js` 和 `.prettierrc`，两个 app 共享 | 统一 lint/format 配置 |
| Day 2 | Husky + lint-staged + commitlint | 配置 pre-commit 自动 lint、commit-msg 校验 Conventional Commits | 提交即校验的 git hook |
| Day 3 | Vitest 基础：`describe/it/expect`、mock | 为 `packages/shared` 里的工具函数写 5 个单元测试 | 测试全绿 |
| Day 4 | Next.js 15 App Router：文件路由、layout、page、loading | 在 `apps/web` 中创建 `/dashboard` 路由，含 loading 和 error 边界 | 可访问的 dashboard 页面 |
| Day 5 | Server Components vs Client Components | 写一个 Server Component 获取数据 + 一个 Client Component 处理交互，组合使用 | 两种组件协作的页面 |
| Day 6 | Server Actions：表单提交、数据变更 | 用 Server Action 实现一个简单的“创建待办”表单 | 无 API 路由的完整 CRUD 交互 |
| Day 7 | 周复盘 + 整理 | 整理 lint/format/test 配置到 README，写周记 | README + 周记 |

## 教程进度

- ✅[Day 1 · ESLint 与 Prettier](/week02/day1)
- ✅[Day 2 · Husky 与 Git 钩子](/week02/day2)
- ✅[Day 3 · Vitest 单元测试](/week02/day3)
- ✅[Day 4 · Next.js 15 App Router](/week02/day4)
- ✅[Day 5 · Server 与 Client 组件](/week02/day5)
- ✅[Day 6 · Server Actions](/week02/day6)
- ✅[Day 7 · 周复盘](/week02/day7)

## 本周参考

Next.js 全栈路线图指出 App Router + Server Components 是 Next.js 15 的核心。
