# @agent-app/web

week20 形态：**Next.js 前端消费自研 BFF API**（`apps/api`），类型契约来自 `@agent-app/shared`——
前端只见契约，不依赖 `@agent-app/engine`；前端零密钥，所有 LLM / embedding 调用都发生在 BFF 侧。

## 启动

```powershell
# 前置：BFF 起在 3000（agent-app 根：pnpm build 后 node apps/api/dist/main.js）
pnpm --filter @agent-app/web dev     # 开发服务器 http://localhost:3009（端口由 apps/web/.env 的 PORT 驱动）
# 或根 README 的组合方式：pnpm api（3000）+ 另一个终端 pnpm --filter @agent-app/web dev
```

环境变量：`NEXT_PUBLIC_API_BASE`（默认 `http://localhost:3000`）——BFF 地址，构建期内联，
部署时改地址只需 `NEXT_PUBLIC_API_BASE=https://bff.example.com pnpm build`。

## 三个页面

| 路由 | 功能 |
| --- | --- |
| `/` | 智能对话：SSE 流式（fetch + ReadableStream 手解析，非 EventSource）——session/step/token/done/error 事件驱动渲染；每条回答带可折叠「思考过程」面板（Thought/Action/Observation）；顶部 sessionId + 新会话 |
| `/kb` | 知识库管理：上传入库（前端扩展名闸 + multipart）、文档列表（删除，confirm 确认）、问答试用（answer + 引用列表 + 降级徽标） |
| `/service` | 智能客服：路由徽标（订单/退款/知识库/转人工四色）+ reason；转人工渲染工单卡片；sessionId 经 localStorage 保持 |

## 工程说明

- **手写 scaffold**（非 create-next-app）：Next 15 App Router + React 19 + Tailwind v4（`@tailwindcss/postcss`），无 UI 组件库、无 `next/font/google`（系统字体栈，构建离线可行）
- **tsconfig 独立成套**（不继承根 `tsconfig.base.json`）：根是 `moduleResolution: NodeNext`（Node ESM，相对导入带 `.js` 后缀），Next App Router 要求 `bundler` + `jsx: preserve` + next 插件，两者互斥——Next 官方脚手架即本形态
- **web 的 typescript 锁 5.9.x**：Next 15 的类型集成按 TS 5.x 设计，workspace 根的 TS 7 只服务 engine/api/cli 的 NodeNext 编译，各包各用各的
- SSE 答案分片事件名是 `token`（与 `@agent-app/shared` 的 `ChatStreamEvent`、api 实际线格式逐字段一致）
