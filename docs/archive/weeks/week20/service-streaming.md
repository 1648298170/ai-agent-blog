# 主线补篇 · 客服流式化：事件契约、诚实 Thought 与断连中止

> 衔接：[Day 5](/archive/weeks/week20/day5) 给 chat 线接上了 SSE 和思考面板，[Day 2](/archive/weeks/week20/day2) 的 BFF 骨架和 [products · 客服系统](/products/service) 的 Supervisor 路由早已就位，但 agent-app 里客服线自己还是一条非流式 JSON 端点——用户点完发送，界面上只剩一句「处理中…」。本篇把三段真实上线代码串成一件事讲透：客服 SSE 化（七事件契约 + 路由先行）、假 Thought 的诚实化管道、客户端断连后停止烧 token 的三层 signal。读者默认走完 week20 主线和 [week11 补篇 · Agent 循环 TS 深入](/archive/weeks/week11/agent-loop-ts)。读完的检验标准只有一条：给你一条客服消息，你能画出它在 `GET /api/service/stream` 上的完整事件序列，并说清 abort signal 在控制器、服务层、引擎循环三层各拦在哪一拍。

三幕各修一个生产缺陷，先摆总账：

| 幕 | 症状 | 根因 | 修法 | 验证 |
| --- | --- | --- | --- | --- |
| 一 | 客服页只有「处理中…」 | 客服线只有非流式 JSON 端点（chat 线早有 SSE） | `ServiceStreamEvent` 七事件契约 + `GET /api/service/stream` | 事件序列单测逐字段断言 |
| 二 | Thought 段是每步同一句静态模板 | 管道里没有模型步间文本这一格 | `ToolLoopStepEvent.text` 三层贯穿，诚实渲染 | step.text 透传断言 |
| 三 | 客户端断连后模型烧 token 到结束 | abortSignal 全链未接线 | 三层 signal：控制器监听 close → 服务层透传 → 引擎步间熔断 | D2 三例断言 `signal.aborted` |

## 第一幕 · 「处理中…」黑盒：客服线补一条自己的 SSE

先看病灶。chat 线早就有 `GET /api/chat/stream`：`session → step* → token* → done`，等待期每一步都有反馈。客服线呢？只有 `POST /api/service/message`，跑完路由、工人、工单，一次性返回整包 JSON。中间那几秒到十几秒，前端能做的只有渲染一个 `animate-pulse` 的「处理中…」。同样 10 秒，chat 线是流水，客服线是黑盒——[Day 5](/archive/weeks/week20/day5) 讲的三重价值（等待体验、信任、可调试）在客服线上一个都兑现不了。

修法不是把 chat 的事件拿来凑合。客服线多两个自有概念：路由判定（这条消息分给谁）和转人工（工单上下文包），事件契约必须把它们表达出来。于是 `@agent-app/shared` 多了一版与 `ChatStreamEvent` 平行的契约：

```ts
export type ServiceStreamEvent =
  | { type: "session"; sessionId: string }
  | { type: "route"; route: RouteTarget; reason: string }
  | { type: "step"; step: number; toolCall: { toolName: string; input: unknown }; output: unknown; text?: string }
  | { type: "token"; text: string }
  | { type: "handoff"; handoff: ServiceHandoffPack }
  | { type: "done" }
  | { type: "error"; message: string; hint?: string };
```

七种事件，三条序列：LLM 路由 `session → route → step* → token* → done`；硬规则转人工 `session → route(human) → handoff → token* → done`；降级转人工在两者之间变异（见下）。契约放在 shared 而不是 api 里，是 week20 的架构边界：前端只见契约不见引擎，类型一份，两端同源。

这条契约里最值钱的设计是 **route 先行**。看控制器的流式主循环：

```ts
// ① 路由：硬规则优先；模型不可用 → 降级转人工（不暴露报错，与非流式同口径）
let decision: RouteDecision;
try {
  decision = await supervise({ lastUserMessage: input.message, unresolvedRounds }, history);
} catch {
  decision = { target: "human", reason: "模型路由不可用，按降级预案直接转人工（用户侧不暴露报错）" };
}
write({ type: "route", route: decision.target, reason: decision.reason });
// ……工人在此之后才开跑
```

`route` 事件在工人开跑之前发出——路由判定先行，是流式版独有的可视性增量。为什么这一拍要抢？因为路由结果对用户是即时信息：徽标先亮（订单蓝 / 退款紫 / 知识库绿 / 转人工琥珀），用户第一时间知道「我被分给了谁」，剩下的等待不再是悬空的黑盒，而是「订单专员正在查」的合理延迟。supervise 本身只花一次小调用，route 的提前量几乎白送。

第二处设计藏在降级分支。工人跑到一半失败（模型网关不可达），按 [products · 客服系统](/products/service) 的上线检查清单第 8 条，降级方向只有一个——转人工，不给报错页。但此时前端徽标已经亮了「订单」，怎么办？补发一次 route：

```ts
} catch (err) {
  if (signal.aborted) return; // abort 引发的拒绝（AbortError 等）：安静收场
  // 工人失败同样降级转人工：补发 route(human) 让前端徽标切到真实出口，再走工单流
  const reason = `工人 ${decision.target} 处理失败（模型不可用），按降级预案转人工`;
  write({ type: "route", route: "human", reason });
  await this.streamHandoff(sessionId, reason, history, write);
}
```

也就是说降级路径上 route 事件连发两次：先业务路由、再 human 降级，**前端以最后一次为准**。这不用任何新机制——service 页的事件状态机里，route 分支就是 `patchLast` 就地覆盖，后到天然胜先到。注意精确口径：连发两次只发生在「路由成功、工人失败」这条路上；若是路由本身就不可用，第一次 route 直接就是 human，只发一次。

第三处设计在引擎侧，回答一个容易被忽略的问题：工人怎么流式化？答案是不动它。`packages/engine/src/service/workers.ts` 增量导出一个 `runWorkerStreaming`，既有的 `runWorker` 一行未动、`POST /message` 字节不变：

```ts
export async function runWorkerStreaming(
  name: WorkerName,
  input: WorkerInput,
  options?: WorkerStreamingOptions,
): Promise<WorkerStreamingResult> {
  const result = await runToolLoop({
    model: createModel(),
    system: WORKER_PROMPTS[name],
    messages: buildMessages(input),
    tools: WORKER_TOOLS[name],
    maxSteps: 5,
    onStep: options?.onStep,   // 工具步实时外发给调用方（API 转成 step 事件）
    signal: options?.signal,   // 断开即中止（第三幕的主角）
  });
  return { messages: result.messages }; // 最终文本弃用——API 拿去 streamText 收尾
}
```

`runToolLoop` 收尾那轮的 `result.text` 是非流式产物，直接弃用；返回循环后的完整消息历史（含全部工具往来），API 侧拿着同一份工人提示词（`workerSystemPrompt` 只读出口）再 `streamText` 一次，换逐 token 可视。多一次生成调用，换 SSE 的逐段输出——和 chat 线 week20 BFF 的同一形态。为什么 `runWorker` 不直接改？CLI 还在用它，HTTP 非流式端点还在用它，「既有调用方零改动、零感知」是这套引擎从 [week11](/archive/weeks/week11/agent-loop-ts) 立下的铁律：想插钩子，加可选参数；想换产物，开新出口。

转人工路径还有个讨喜的细节：告知文本不是模型产物、没有天然分片边界，`chunkText(reply)` 按定宽 16 字切片成 token 事件——纯粹为了前端逐段渲染的流式体感（太大失去渐进感、太小事件数爆炸，16 取中）。

最后一个容易踩的坑：8000 字长度闸必须写在 SSE 响应头 **之前**。`res.flushHeaders()` 一旦执行，连接就只能以 200 + error 事件收场，再也给不出 4xx 状态码——所以超长校验抢在头上，手写 JSON 错误体与全局过滤器的 `{ statusCode, message }` 形状对齐。这是 [Day 5](/archive/weeks/week20/day5) 「SSE 不能中途换状态码」在客服线的重演。

服务端通了，前端怎么接？service 页把七种事件映射成一个状态机：`handleEvent` 里一个 switch 七个分支，全部落在「最后一条助手消息」上——`patchLast` 就地更新，流式的那条气泡随事件逐渐长出来：

```tsx
case "route":
  // 路由判定先行：徽标 + reason 在回复生成之前就渲染（降级连发时以最后一次为准）
  patchLast((turn) => ({ ...turn, route: event.route, reason: event.reason }));
  break;
case "step":
  patchLast((turn) => ({ ...turn, steps: [...turn.steps, { step: event.step, toolName: event.toolCall.toolName, input: event.toolCall.input, output: event.output, text: event.text }] }));
  break;
case "token":
  patchLast((turn) => ({ ...turn, text: turn.text + event.text }));
  break;
```

`session` 落 localStorage（刷新恢复），`handoff` 渲染工单卡片，`done`/`error` 收尾态。还有一条容易被忽略的工程口径：`streamRound` 与 `POST /message` 共用同一个 sessionStore 和「连续未解决」计数表——会话入账逐行同款，两条端点的历史端到端连续，用户混用也串得起上下文。这套事件序列不是文档说说：`service.stream.spec.ts` 把 mock 出的一次工人回答断言成 `[session, route, step, token×3, done]` 的精确序列，再拿历史端点验会话回写——契约钉在测试里，改坏任何一环都红给你看。

## 第二幕 · 假 Thought：管道铺通，文本诚实

SSE 通了，新的尴尬跟着来。chat 线的思考面板是 Thought / Action / Observation 三段式（[Day 5](/archive/weeks/week20/day5) 的 ReAct 可视形态），客服线复用同一组件。但 Thought 那一段，最初渲染的是每步同一句静态模板——不管模型这步到底「说」没说话，面板都填一句占位话术。

这比没有思考更糟。没有思考，用户只是看不见；假思考，用户看见了假的。企业场景里，客服主管点开面板是要验「它凭什么查订单」的，一句模板话术冒充模型推理，信任崩得比黑盒更快。修法分三层贯穿，把模型真实的步间文本一路接到像素。

引擎层，`runToolLoop` 捕获每一步伴随工具调用的文本：

```ts
messages.push(...result.response.messages); // ① 入账：模型的调用意图
// 步间文本快照：模型伴随工具调用"说"的那句话（有则随 onStep 广播，无则 undefined）
const stepText = result.text.trim();
// ……
onStep?.({
  step,
  toolCall: { toolName: call.toolName, input: call.input },
  output: output.value,
  text: stepText || undefined, // 空串归一为 undefined：订阅方 "in text" 判断更省心
});
```

契约层，`ToolLoopStepEvent` 与两条 SSE 流的 step 事件都加上 `text?: string`——可选字段，透传不加工，chat 服务里就一句 `text: event.text`，注释写着「诚实透传，不造模板话」。UI 层，StepPanel 的渲染只有一行逻辑：

```tsx
<span className="font-semibold text-purple-600">Thought</span>{" "}
{/* 诚实原则：模型本步有推理文本就原样展示，没有就明说——绝不拿模板话冒充模型思考 */}
{step.text?.trim() || "（本步无文本推理——工具选择即模型的决策）"}
```

有真文本，原样展示；没有，明说没有。为什么这句「没有」不能省？因为默认接的 glm-4-flash 是 function-calling 模型，此字段常态为 undefined——它调工具前不说话，**工具选择本身就是它的思考**。那这条管道岂不是白铺？不是。GLM-4.5+、R1 这类推理模型伴随调用会输出成段推理文本，管道今天为它们预先铺好，切换模型零改动；而当下每一步诚实的「无文本推理」，配上 Action（调了什么工具、什么参数）和 Observation（拿回了什么），对用户已经是完整的决策证据链。诚实 UI 的原则就一句话：有则展示、无则明说，绝不造。

这条管道有测试钉死：`service.stream.spec.ts` 里 mock 的工具步带着 `text: "我先查一下订单状态。"`，断言它逐字段透传到了 SSE 的 step 事件——管道通不通，不靠肉眼。

顺带一提捕获时机：`stepText` 在入账之后、工具调度之前拍快照，onStep 在回灌落账后才广播——注释原话「订阅方看到的一定是已提交的状态」。观察性钩子不改变任何账务顺序，这是 onStep 从第一版就定下的纪律，Thought 管道只是骑在它上面的乘客。

## 第三幕 · 断连烧钱：三层 signal 贯穿

前两幕修体验，这一幕修账单。SSE 有个先天缺陷：客户端跑路（关页面、点停止、断网），服务端默认不知道，模型会继续生成到自然结束——token 照烧，产出去处是已关闭的 socket。项目 BACKLOG 里这条挂账写得很直白：「SSE 客户端断开不中止生成：abortSignal 未接线，断连后模型继续烧 token」。

修法是三层贯穿一条 signal。第一层在控制器，把「对端消失」接到 `AbortController`：

```ts
/** 把「对端消失」接到 AbortController：close 且未写完 → abort 生成 */
private wireDisconnectAbort(res: Response): AbortController {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  return abort;
}
```

六行代码，两个知识点。其一，Express 的 `close` 事件在正常收尾时也会触发——我们自己 `res.end()` 算 close，客户端消失也算 close，必须用 `writableEnded` 区分「写完了」与「对端先走」：只有后者才 abort，正常收尾不误伤。其二，这段在 chat 和 service 两个控制器里是同款复制，非流式 `POST` 端点也用它（passthrough 拿到 res）——断开中止不是流式的专属问题，只是流式把它放大得最明显。

第二层是透传。service 的 `streamRound` 把 signal 交给 `runWorkerStreaming`，chat 的 `chatStream` 交给 `runToolLoop`；最终答案的 `streamText` 也接上 `abortSignal: signal`——断开后底层流被取消，不再向网关要新 token。服务层不碰 HTTP，不判断谁断的，只管把信号递下去。

第三层在引擎循环，两个拦截时机：

```ts
for (let step = 1; step <= maxSteps; step++) {
  // 调度下一次模型调用之前先看信号：客户端已断开就不再发起（烧 token 没有意义）。
  // 抛错而不是返回半截结果——与「请求进行中被 abort」时 generateText 的拒绝
  // 语义保持一致，调用方用同一条 catch 路径处理两种中止时机。
  if (signal?.aborted) {
    throw new Error(TOOL_LOOP_ABORTED);
  }
  const result = await generateText({ model, messages, tools: schemaTools, system, abortSignal: signal });
```

时机一：步间熔断——工具执行回灌之后、下一次模型调用之前检查 `aborted`，客户端已经不在了，继续调模型纯粹烧 token，直接抛 `TOOL_LOOP_ABORTED` 退出。时机二：在飞调用——`generateText` 的 `abortSignal` 让 SDK 在模型调用层响应中止，正在进行的请求以 AbortError 拒绝。刻意设计在于：预中止抛错、在飞中止拒绝，两种时机统一成「异常」这一条 catch 路径，调用方不必区分。

最终答案那段的 `streamText` 同样接 signal，收尾的 token 循环里还有最后一道保险：

```ts
let answer = "";
for await (const delta of textStream) {
  if (signal?.aborted) break; // 断开后不再 emit（写已关的 socket 没有意义）
  answer += delta;
  emit({ type: "token", text: delta });
}

if (signal?.aborted) {
  // 断开收场：不回写半截答案（污染下一轮上下文）、不发 done——客户端没等到
  // 完整回答是既成事实，会话里保留它的提问即可，下次追问有上下文可续。
  return;
}
await this.sessionStore.append(sessionId, { role: "assistant", content: answer });
emit({ type: "done" });
```

收场纪律也有讲究：流式端点 catch 到 `signal.aborted` 就安静收场——对方已经收不到任何事件，发 error 事件是往已关闭的 socket 白写。而非流式 `POST /api/chat` 反过来刻意不静默：断开引发的中止换算成明确的中文错误上抛——它的调用方依赖「要么完整结果、要么明确失败」的二值语义，静默返回半截会把「未完成」伪装成「完成」：

```ts
if (options?.signal?.aborted) {
  throw new Error("客户端已断开连接，本次生成已中止，未产生完整回复");
}
```

同一个 signal，两种收场，各服其主。

怎么证明这套接线真的生效？`chat.controller.spec.ts` 的 D2 三例是范本：supertest 做不了「中途断开」，就手动把 Nest 的 http server 监听到随机端口，用原生 `http.request` 发请求，进到服务层后 `req.destroy()` 制造对端消失：

```ts
await waitFor(() => captured !== undefined); // 路由已进服务层
expect(captured?.signal?.aborted).toBe(false); // 此时连接还在
req.destroy(); // 对端消失（响应未写完——正是烧 token 的那个窗口）
await waitFor(() => captured?.signal?.aborted === true); // close → abort 接线生效
```

断言口径是 `signal.aborted === true`，断的是接缝不是实现；轮询 `waitFor` 比固定 sleep 稳（断开 → abort 是跨事件循环的异步链）。第三例反着测：服务正常完成、连接正常收尾，断言 `aborted === false`——`writableEnded` 防误伤，防的就是这一拍。

## 踩坑实录（这一轮真实发生的）

**① `next build` 与 `next dev` 共写 `.next`。** 为了验证生产构建，先跑了 `next build` 又顺手起了 `next dev`，两边共写同一个 `.next` 目录，webpack chunk 错乱，页面随机 500。清掉 `.next` 立愈。教训一句话：生产构建与开发服务器不要混写同一个产物目录，构建后要预览就用 `next start`。

**② Playwright 断言「纹丝不动」。** 验证「定高壳 + 消息区独立滚动」的布局改造时，用 Playwright 量 textarea 的 `boundingBox().bottom`：流式输出前后都是 849，两次读数分毫不差——消息区在内部滚，输入框钉在原地。布局回归不一定要截图比对，一个「两次测量相等」的断言更便宜也更稳。

**③ 冒烟脚本的管道编码。** PowerShell 管道向 node 进程传中文默认按 GBK 打碎，node 按 UTF-8 读成乱码，关键词匹配全失效（ARCHITECTURE 踩坑实录第 6 条的同款）。SSE 冒烟最终改成 node 原生 fetch 写 `.mjs` 脚本、结果落文件再核对——跨进程传文本，能不借管道就不借。

**延伸阅读 · 顺带修的 50 并发竞态。** 同一轮工业差距审查还揪出另一条 bug：会话 append 是「读 → await LLM 压缩（秒级）→ 写回」，并发下后写者整体覆盖先写者，消息静默丢失——压缩那次秒级 LLM 调用把竞态窗口从「理论存在」拉宽成「高并发下必然发生」。修法两层：内存版每个会话一条 Promise 链（串行队列），「读-压-写」三步整体排队，跨会话不互相放大等待；Redis 版只锁危险的「压缩重写」段（RPUSH 本身单命令原子，锁不锁都安全），拿不到锁本轮跳过压缩、消息先原子落账，at-least-once 优先于 exactly-once：

```ts
const holder = randomUUID(); // 持有人令牌：释放时的比对依据
const acquired = (await client.setNxPx(key, holder, SESSION_LOCK_TTL_MS)) === "OK"; // SET NX PX 30000
// 释放必须「GET 比对持有人一致才 DEL」，且用 Lua 原子化——否则两步之间锁恰好
// 过期、别人拿到新锁，迟到的 DEL 会误删他人的锁（经典误删事故）
```

测试口径很漂亮：50 个并发 append 与顺序 append 的最终状态逐字段相等——「并发 == 顺序」就是不丢消息的准确数学表达，内存版与 Redis 版各测一遍。

## 自测 6 题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `route` 事件为什么要在回复生成之前发？它买到的是什么，代价又是什么？

::: details 参考答案
买到的是路由判定的即时可视：徽标先亮，用户第一时间知道被分给谁，剩余等待从悬空黑盒变成「专员正在处理」的合理延迟。代价几乎没有——supervise 本来就是流程第一步，只是把结果提前 write 出来，多花的只是几字节的 SSE 帧。
:::

2. 降级转人工时 route 为什么连发两次而不是想办法「改发」？前端「以最后一次为准」靠什么保证？

::: details 参考答案
SSE 是单向追加流，已发出的帧收不回来，「改」的实现只能是再发一次。前端事件状态机里 route 分支就是 `patchLast` 就地覆盖最后一条对话的路由字段，后到天然胜先到，不需要任何额外协议。注意只有「路由成功、工人失败」才连发两次；路由本身不可用时第一次 route 就是 human，只发一次。
:::

3. 为什么 `runWorker` 不直接改成流式，而是新增 `runWorkerStreaming`？

::: details 参考答案
CLI 和非流式端点还在消费 `runWorker`，直接改会动它们的返回语义。新增出口 + 只读导出 `workerSystemPrompt`，让流式路径复用同一套提示词、工具表、maxSteps，而既有调用方零改动零感知——「既有行为字节不变」是引擎从 week11 立下的铁律。最终文本在流式路径被弃用，由 API 侧 `streamText` 收尾，代价是多一次生成调用。
:::

4. `wireDisconnectAbort` 里的 `writableEnded` 判断防的是什么？去掉它，哪条测试会红？

::: details 参考答案
`close` 事件在服务端正常 `res.end()` 时也触发，不加区分会把每一次正常收尾都当成「对端消失」误 abort。会红的是 D2 第三例「正常收尾不触发 abort」：服务发完 session/done 事件正常结束，断言 `captured.signal.aborted === false`——去掉判断后正常收尾也被 abort，用例当场失败。
:::

5. 步间检查 `signal.aborted` 和 `generateText` 的 `abortSignal` 各拦哪个时机？为什么统一成抛错一条 catch 路径？

::: details 参考答案
步间检查拦「上一步刚回灌、下一步还没发起」的间隙——此时没有任何在飞请求，只能自己抛 `TOOL_LOOP_ABORTED` 主动退出；`abortSignal` 拦「模型调用正在飞」——SDK 在调用层响应中止，以 AbortError 拒绝。统一成异常语义后，调用方一条 catch 处理两种时机，流式端点判 `signal.aborted` 安静收场即可，不必关心中止发生在哪一拍。
:::

6. glm-4-flash 下 `step.text` 常态为 undefined，这条 Thought 管道还有价值吗？

::: details 参考答案
有，两层。当下：诚实原则要求「有则展示、无则明说」，面板明写「本步无文本推理——工具选择即模型的决策」，配合 Action/Observation 仍是完整证据链，且绝不拿模板话冒充思考。未来：GLM-4.5+、R1 类推理模型伴随调用会输出成段推理文本，管道（engine 捕获 → shared 契约 → UI 渲染）已三层贯穿，换模型零改动。管道为明天铺，诚实为今天守。
:::

---

三幕回头看是一条主线：**契约先行（事件先于实现定义在 shared）、零变化铁律（新出口不动旧函数）、诚实收场（不造模板话、不回写半截答案、不静默伪装完成）**。这三条不只在流式化里成立，agent-app 从 [week11](/archive/weeks/week11/agent-loop-ts) 的手写循环到 [week11 · MCP 接入](/archive/weeks/week11/mcp-ts) 的工具合并，一路都是同一个纪律。想跑真流程：`agent-app` 目录 `pnpm api` 起在 3000，另开终端 `pnpm --filter @agent-app/web dev`，`/service` 页发一条「订单 A-1024 到哪了」，再中途关掉页面看服务端日志安静收场。本周其余安排见[本周日程](/archive/weeks/week20/)。
