# @agent-app/shared

跨端共享契约包：**纯类型，零运行时逻辑**。存放 HTTP API（`apps/api`）、CLI（`apps/cli`）与
未来的 web 前端（`apps/web`）共同消费的类型契约——SSE 流式事件、统一错误体、客服路由判定、
转人工上下文包。契约只有一份，端与端之间不会各画各的形状。

## 为什么 exports 指向 dist（设计取舍）

`package.json` 的 `exports` 是 `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`。

曾考虑过让 `exports` 直接指向 `./src/index.ts`（零构建消费），但 `apps/api` 用 **tsc 发射构建**
（`rootDir: "src"` + `outDir: "dist"`）：若类型解析落到包外部的 `.ts` 源文件，该文件会进入
api 的编译程序，触发 `TS6059: File ... is not under 'rootDir'`。因此本包选择与 `@agent-app/engine`
同款的做法：**带 `build` 脚本（tsc + declaration）**，`exports` 指向 `dist` 的 `.d.ts`。

消费前提：先执行一次 `pnpm build`（或 `pnpm -r build`，workspace 会按依赖拓扑先建本包）。
`pnpm typecheck` / `pnpm api` 等命令在此之前需要 `dist` 存在，详见根 README 的快速开始。

## 与 @agent-app/engine 的关系

`engine` 以 devDependency 方式引用本包（仅 `import type`，编译后被擦除，运行时零依赖）；
`supervisor` / `handoff` 模块会把 `RouteDecision` / `ServiceHandoffPack` 等契约再出口，
包内外既有引用路径不变。引擎保持框架无关（不依赖 @nestjs/*，也不依赖任何 app）。
