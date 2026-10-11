# 10 · Web 前端与 SSE 流式

> **这一站解决 Agent 的最后一公里**：引擎再好，用户面对的仍是一块网页。同样是等 10 秒，「答案像流水一样长出来、每一步思考看得见」和一句「处理中…」黑盒，是两种产品。学完你将拥有：SSE 事件驱动的流式对话页、fetch + ReadableStream 手写的流解析器、把「事件序列如何演变界面」收敛成纯函数的对话状态机。

**前置**：[09 · 产品线组装](/guide/09-product)（BFF 上那套产品逻辑，本章给它一张脸）
**配套跑起来**：`pnpm api` + `pnpm --filter @agent-app/web dev`（两个终端：BFF 在前，前端在后）
**深读**：[how-to · MATURITY](/how-to/MATURITY)（这套前端的成熟度档位与生产前置项）

---

## 一、为什么：等待体验是信任问题

CLI 时代 `pnpm chat --trace` 的轨迹已经够爽——但那是给工程师看的。真实用户在浏览器里发出「订单 A-1024 到哪了」之后：

```text
非流式：点击 → 「处理中…」（10 秒黑盒）→ 整段答案砸出来
流式：  点击 → 思考过程逐步长出（✓ 查到订单）→ 答案逐段流出 → 完成
```

流式不是炫技，它同时兑现三样东西：**等待体验**（有进度就不焦虑）、**信任**（看得见模型查了什么，回答才可信）、**可调试**（卡在哪一步一目了然）。

而 Agent 场景比普通聊天机器人多两件事：**思考过程**（工具调用步）是过程信息，**审批**（高危工具挂起等人裁决）是反向控制流——只讲「流式输出文本」的教程装不下它们，需要一套事件契约。

## 二、架构铁律：前端只见契约

week20 定下的边界一句话：**前端只见契约，不见引擎**。

- 类型全部来自 `@agent-app/shared`（SSE 事件、错误体、路由判定、工单包）——纯类型包零运行时，一份契约 CLI / API / web 三端同源；
- **前端零密钥**：所有 LLM / embedding 调用都发生在 BFF 侧，密钥永远不出服务端；
- web 不依赖 `@agent-app/engine`——引擎换发型，前端无感。

三张页面各管一条产品线：

| 路由 | 页面 | 关键件 |
|---|---|---|
| `/` | 智能对话（SSE 流式） | 思考面板 + 审批卡片 + 历史会话恢复 |
| `/kb` | 知识库管理 | 上传入库（前端扩展名闸 `.txt/.md/.pdf`）+ 文档列表 + 问答试用（降级徽标） |
| `/service` | 智能客服 | 路由徽标四色（订单蓝/退款紫/知识库绿/转人工琥珀）+ 工单卡片 |

工程形态：手写 scaffold 的 Next.js 15（App Router + React 19 + Tailwind v4，非 create-next-app），刻意不用 `next/font/google`（系统字体栈，构建离线可行）。

## 三、SSE 事件契约：序列即产品

chat 线六种事件（`packages/shared` 的 `ChatStreamEvent`，与 BFF 线上格式逐字段一致）：

```ts
export type ChatStreamEvent =
  | { type: "session"; sessionId: string }   // ① 会话确定（第一条事件）
  | { type: "step"; step: number; toolCall: { toolName: string; input: unknown };
      output: unknown; text?: string }        // ② 思考步（Thought/Action/Observation）
  | { type: "approval"; approvalId: string; sessionId: string;
      toolName: string; input: unknown }      // ③ 高危工具挂起（插在它的 step 之前）
  | { type: "token"; text: string }           // ④ 答案分片（逐段追加正文）
  | { type: "done" }                          // ⑤ 收尾
  | { type: "error"; message: string; hint?: string }; // ⑥ 出错（中文 message + hint）
```

序列 = 产品语义：`session → (approval)? → step* → token* → done`，任一环节可转 `error`。service 线再加 `route` 与 `handoff` 凑成七事件：**route 先行**（路由判定在工人开跑之前发出——徽标先亮，等待变成「订单专员正在查」的合理延迟）；降级路径 route 连发两次，**前端以最后一次为准**。

### 手解析：为什么不用 EventSource

浏览器自带的 `EventSource` 看似现成，两条硬伤：**不便携带 sessionId 查询参数**（多轮对话的命脉）、**拿不到非 200 响应的错误体**（BFF 的中文错误提示直接丢失）。所以 [lib/api.ts](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/apps/web/lib/api.ts) 的 `streamChat` 用 fetch + ReadableStream 手解析：

```ts
const reader = res.body.getReader();
const decoder = new TextDecoder("utf-8");
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let sep = buffer.indexOf("\n\n");            // SSE 帧分隔符 = 空行
  while (sep !== -1) {
    emitFrame(buffer.slice(0, sep), onEvent);   // 一帧可能含多行
    buffer = buffer.slice(sep + 2);
    sep = buffer.indexOf("\n\n");
  }
}
buffer += decoder.decode();                     // flush 尾字节
emitFrame(buffer, onEvent);                     // 最后一帧可能没等到空行
```

`emitFrame` 逐行取 `data:` 前缀 → `JSON.parse` → 回调。三个容易漏的细节：**按 `\n\n` 切帧而不是按 chunk**（一次 read 可能半帧也可能多帧）；**流结束时 flush 尾帧**；**非 200 也要解析错误体**（`readErrorMessage` 优先读统一错误体的中文 message，非 JSON 落到「请求失败（HTTP xxx）」兜底）。

## 四、对话状态机：事件序列 → 界面状态

「事件如何演变界面」全部收敛在 [lib/chat-state.ts](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/apps/web/lib/chat-state.ts)——一个**无 React 依赖的纯函数模块**：

- **SSE 处理器映射表**：`sseHandlers` 每种事件一个纯函数（`token` = 最后一条消息 content 追加；`step` = steps 数组压栈；`approval` = 审批记录入列……）——以后新增事件种类，分发逻辑一行不改；
- **useReducer 接线**：组件里 `dispatch({ type: "sse", event })` 一条道走到底；
- **副作用纪律**：reducer 纯函数，localStorage 写入 / 滚动 / 请求全部留在组件层（page.tsx 的 useEffect 与回调）。

收益很实际：**事件顺序可以脱离组件测试**——`chatReducer(状态, 事件) → 断言新状态`，不渲染任何 DOM。除 SSE 六种外，reducer 还接 UI 侧 action：`stream-finalize`（连接正常结束但没等到 done——补收尾态，不悬挂「思考中…」）、`approval-resolved`（裁决回填；审批超时 BFF 已自动拒绝返回 404 时转「已过期」态）、`restore` / `reset`。

渲染层同样有诚实原则：[StepPanel](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/apps/web/components/StepPanel.tsx) 的 Thought 段有推理文本就展示、没有就明说「本步无文本推理——工具选择即模型的决策」，绝不拿模板话冒充思考；**Action 与 Observation 展示全文**（多行缩进 JSON，`whitespace-pre-wrap` 逐行不截断——面板限高内滚，长内容滚动可见）；审批入参走 `summarize` 压成单行摘要（卡片空间小，预览即可）。

**数据卡片**（[DataCards](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/apps/web/components/DataCards.tsx)）：列表形态的工具输出（名册 / 流水 Top10 / 每日明细 / 组合矩阵）直接渲染成带中文表头的表格卡片，插在正文之前——用户直接看数，不靠模型转述。白名单制（只认注册过的数据源工具）、字段中文表头映射、超 10 行折叠展开、给模型的指令性字段（提示/说明）不进表格。

## 五、跑起来（三页走查）

```powershell
cd agent-app
pnpm build                              # shared/engine/api 产出 dist
pnpm api                                # 终端一：BFF 起在 3000
pnpm --filter @agent-app/web dev        # 终端二：前端开发服务器
pnpm --filter @agent-app/web build      # 验证：类型检查 + 产物构建
```

走查清单（对应三页）：

1. `/`：问「订单A-1024到哪了」→ 思考面板逐步长出 → 答案流式；问「帮我建个工单」→ 审批卡片（允许/拒绝；60s 不裁决 BFF 自动拒绝，前端转「已过期」）；刷新页面 → localStorage 里的 sessionId 恢复历史（压缩摘要轮渲染为居中弱化条）。
2. `/kb`：上传 `samples/company-faq.md` → 「N 块入库」→ 列表刷新；问 FAQ 里没有的问题看「老实说不知道」。
3. `/service`：输入「转人工」→ 徽标先亮琥珀色 → 工单卡片（工单号/原因/用户摘要/最近对话）。

## 六、坑与取舍（真实案例）

**坑 1 · `NEXT_PUBLIC_` 是构建期内联**。`NEXT_PUBLIC_API_BASE` 在 `next build` 时被**字面替换进产物 JS**——部署后改环境变量无效。换 BFF 地址 = 带着新值重新 build（compose 里正是构建参数般地钉死了 `http://localhost:3000`）。

**坑 2 · `next dev` 不读 `.env` 里的 `PORT`**。想让前端避开 3000，写进 `.env` 的 PORT 无效——Next 的端口只认 package.json 脚本的 `-p` 参数或**进程级**环境变量（生产容器里正是用进程环境变量 `PORT=3001` + `HOSTNAME=0.0.0.0`，后者不钉死会绑不上：Docker 默认把 HOSTNAME 设成容器 ID，standalone server.js 拿它当绑定地址）。

**取舍 · 两种恢复失败，两种策略**。挂载时恢复上次会话（读 localStorage → 拉历史）失败要**静默**——API 未起或会话过期，保持全新界面即可；用户主动切换历史会话失败要**出声**——以错误气泡提示、界面不清空（用户刚点的操作失败了却无反应，比报错更糟）。同一座城市两种消防策略，按「是不是用户主动发起」划线。

## 七、动手任务（做完才算通关）

1. 打开 DevTools → Network → 选中 stream 请求 → EventStream 页签，对照本章事件序列逐条打勾（你会亲眼看到 `data: {"type":"token",...}` 的原始帧）。
2. 在 `chat-state.ts` 里找到 `stream-finalize` 的分支，然后制造一次「断流」（发送后立刻杀掉 BFF 进程），观察界面不悬挂「思考中…」而是转错误态。
3. **改造**：给 `error` 事件的渲染加一个「重试」按钮（把上一条用户消息重新发送）——state 已有 errorMessage/errorHint，你只需在组件层接线。

## 自测题（先凭记忆答，再展开）

1. 为什么用 fetch + ReadableStream 手解析而不用浏览器自带的 EventSource？
2. 帧是怎么切的？一次 `reader.read()` 返回的内容恰好是半帧或整帧吗？流结束时还要做什么？
3. reducer 纯函数 + 副作用全在组件层，换来什么具体收益？

<details><summary>答案</summary>

1. 两个硬伤：EventSource 不便携带 sessionId 查询参数（多轮对话续接不上）；拿不到非 200 响应的错误体（BFF 统一错误体的中文 message + hint 直接丢失）。
2. 按 `\n\n`（空行）切帧，帧内逐行取 `data:` 前缀 JSON.parse；一次 read 可能是半帧也可能多帧，所以要 buffer 拼接 + 循环切；流结束时要 `decoder.decode()` flush 尾字节并补发最后一帧（它可能没等到空行）。
3. 「事件序列如何演变状态」变成可脱离组件断言的纯函数——`chatReducer(状态, 事件) → 新状态`，不渲染 DOM 即可测试事件顺序；副作用集中在组件层，也让 reducer 可预测、可回放。

</details>

---

## 延伸

- 源码走读：[lib/chat-state.ts](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/apps/web/lib/chat-state.ts)（状态机）· [lib/api.ts](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/apps/web/lib/api.ts)（SSE 手解析）
- 归档周教程：[week20 · 全栈整合](/archive/weeks/week20/)（BFF / RBAC / 流式 UI 的原始叙述）· [客服流式化补篇](/archive/weeks/week20/service-streaming)（七事件契约 + route 先行 + 三层 abort signal）
- 产品实战：[知识库问答落地](/products/kb)
- 下一站：[11 · 生产化与成熟度](/guide/11-production) —— 前端有了脸，接下来给整套系统换上真实的骨：持久化、部署、以及离生产还差几步的诚实清单
