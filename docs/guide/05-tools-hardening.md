# 05 · 工具层加固与幂等

> **这一站解决「工具会伤人」的三件事**：写操作被重复执行（上游一次超时补偿重发，工单就翻倍）、高危操作拍板太快（没人点头就建单）、锤子发得太多（职责外的能力也在模型手里）。学完你将拥有：一张按职责裁剪的工具表、一层带三条纪律的幂等壳、一道先问人的审批壳，以及一份「清单顺序即拦截顺序」的壳组合器——循环本体一行不改。

**前置**：[02 · 手写工具循环](/guide/02-agent-loop)（防御 3/4 已预告幂等与审批两道壳——本章把它们拆开讲透）
**配套跑起来**：[examples/custom-tool.ts](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/packages/engine/examples/custom-tool.ts)（三件套最小示例）+ `pnpm api` 起后在 web `/` 页触发审批卡 + `pnpm test:engine`
**深读**：[参考库 · 工具箱](/reference/03-tools)（注册表 / 幂等层 / 壳组合器的字典式深讲）

---

## 一、为什么：工具越好用，越要问「执行几次、谁批准」

02 站的循环让模型「会用工具」了，但生产环境会立刻追问三件事：

1. **执行几次？** 模型重试、用户重复提问、上游超时补偿重发——「创建工单」这类**写操作**会被执行多次。传统服务里有事务与幂等键兜着；LLM 的工具调用**不受客户端事务控制**，它想再调一次就再调一次。
2. **谁批准？** 建单、退款、删数据，代价不该由模型独自拍板。模型「好心」执行的每一次都该有人点头——哪怕只是点一下「允许」。
3. **能做什么？** 给模型十把锤子，它总有办法在错误的场合抡错那把。能力边界的第一道墙不是提示词里的「请不要」，是**工具表里根本没发那把锤子**。

本章三块内容——裁剪工具表、幂等壳、审批壳——各自回应一条。

---

## 二、核心：三件套写好，工具表裁对，壳找对落点

### 2.1 三件套：说明书、图纸、真身

```ts
// examples/custom-tool.ts —— 给 Agent 加一个工具只要三件事
const addTodo = tool({
  description: "新增一条待办事项。用户说「加一个待办/记一下 XX」时调用；不要在用户只是查询时调用。",
  inputSchema: z.object({
    title: z.string().min(1).describe("待办内容，一句话概括"),
  }),
  execute: async ({ title }) => {
    const id = todos.length + 1;
    todos.push({ id, title, done: false });
    return { id, title, status: "已新增" }; // 写操作！生产场景应配幂等壳
  },
});
```

三个字段三种读者：**description 是写给模型的说明书**——写清「适合 / 不适合」，轻量模型几乎完全靠它决定调不调；**inputSchema 是 zod 图纸**——生成参数说明与执行前校验是同一张纸，`.describe()` 与 zod 的 `message` 都是写给模型看的指令（报错即修正方向，见 02 站防御 2）；**execute 是真身**——模型只点名，干活的是这里。写好三件套是本站一切加固的地基（更多范例见[扩展指南](/how-to/EXTENDING)）。

### 2.2 工具表 = 能力边界：三工人案例

```ts
// src/service/workers.ts —— 各工人的最小工具表
const WORKER_TOOLS: Record<WorkerName, AgentToolSet> = {
  order: { getOrderStatus },          // 只查订单
  refund: { createTicket },           // 只建工单
  knowledge: { searchKnowledgeBase }, // 只检索知识库
};
```

**order 工人建不了工单——不是提示词求它别建，是它手里根本没有 `createTicket`**。误伤面从工具表上就掐掉，比任何「请不要…」都可靠，也最便宜（这套裁剪的完整产品背景见[09 站](/guide/09-product)客服系统）。

### 2.3 壳：加固的统一落点

幂等与审批既不改工具定义、也不改循环——它们以「壳」的形态叠加：**壳 = 工具表 → 工具表 的纯函数**，包完仍是合法工具表（description / inputSchema 原样透传），模型看到的工具面不变。02 站说过「壳往哪加，你说了算」——本章就是那句话的兑现。

---

## 三、跑起来（先体感）

```powershell
cd agent-app
pnpm build
pnpm examples:custom-tool     # 一个请求串两个工具：先 addTodo 再 listTodos
pnpm test:engine              # 幂等层 / 壳组合器的离线单测

# 审批体感（默认 AGENT_CONFIRM_TOOLS=createTicket）：
pnpm api                      # BFF 起在 :3000
# 浏览器打开 web 的「智能对话」页，输入「帮我创建一个工单：测试审批」：
#   ① 弹出审批卡，流挂起——没有任何 step 事件，execute 真的被闸住了
#   ② 点「拒绝」→ 模型礼貌收尾；点「允许」→ 拿到工单号
#   ③ 同一会话再要求建同样的工单 → 同一个工单号（幂等命中，真执行只有一次）
```

---

## 四、两道壳、一条顺序（真实案例驱动）

### 4.1 幂等壳：把「提交订单」的防双击做在服务端

**故障**：模型重试或用户重复提问，写操作执行多次，生产库多出没人要的脏数据。**防御**：`wrapToolsWithIdempotency` 给工具表套壳，同键在 TTL 窗口内只真执行一次：

```ts
// src/tools/idempotency.ts —— run() 的脉络（简化）
run<T>(scope: string, toolName: string, args: unknown, execute: () => Promise<T>) {
  const key = `${scope}::${toolName}::${stableStringify(args)}`;    // ③ scope 隔离
  const hit = this.entries.get(key);
  if (hit !== undefined && hit.expiresAt > now) return hit.promise; // ② 在途共享

  const promise = execute().then(
    (result) => result,
    (err) => { this.entries.delete(key); throw err; },              // ① 成功才缓存
  );
  this.entries.set(key, { promise, expiresAt: now + this.ttlMs });  // TTL 默认 10 分钟
  return promise; // 单例上限 500 条，按插入序淘汰防长跑泄漏
}
```

参数指纹由 `stableStringify` 生成：对象键排序、`undefined` 字段剔除——`{a:1,b:2}` 与 `{b:2,a:1}` 必然同指纹。三条纪律，缺一不可：

| 纪律 | 防什么 | 比喻 |
|---|---|---|
| ① 成功才缓存 | 失败被缓存 → 合理重试被堵死 | 第一锅煮糊了不占灶 |
| ② 在途共享 | 同键并发各执行各 → 并发穿透 | 电梯已在路上，第二个人跟着上，不再叫一台 |
| ③ scope 隔离 | 跨会话同参数误去重，两笔业务变一笔 | 隔壁包间点了同样的菜，不能拼一单 |

**设计对照**：业界标准是客户端显式幂等键（Stripe 的 `Idempotency-Key` 请求头）；Agent 场景模型不可靠地生成键——退一档用**参数指纹**：内容真变了才算新调用。实测：同会话重复建单拿到同一个 `TK-` 工单号（`test:engine` 里的 `idempotency.spec.ts` 盯着这套语义）。

### 4.2 审批壳：大额转账前的那通确认电话

**故障**：模型「好心」帮用户建单/删数据——有些代价不该由模型拍板。**防御**：API 层把交给循环的工具表先包壳，命中名单的工具 execute 前挂起等人工裁决：

```ts
// apps/api/src/chat/tool-approval.ts —— 命中名单的工具换成审批版 execute
execute: async (input: unknown, options: ToolCallOptions) => {
  const approved = await context.registry.confirm(
    { sessionId: context.sessionId, toolName: name, input },
    context.emit,        // 先发 approval SSE 事件（前端弹审批卡）
    context.timeoutMs,   // 默认 60s（DEFAULT_CONFIRM_TIMEOUT_MS），超时自动拒绝
  );
  if (!approved) return { denied: true, reason: "用户拒绝执行该工具" }; // 拒绝值模型可见
  return original(input, options);                                      // 允许才真正执行
},
```

四个要点：**名单** `AGENT_CONFIRM_TOOLS` 默认 `createTicket`，显式置空即关闭（零变化默认）；**裁决**走 `POST /api/chat/approve`，按 approvalId 精确唤醒且要求 sessionId 匹配（跨会话裁决按未知处理）；**超时自动拒绝**是 fail-closed——没接电话就不扣款；**拒绝值是结构化返回而非异常**——模型看得见，能解释「用户拒绝了」并礼貌收尾，而不是当成失败换个参数再试。

### 4.3 洋葱叠加：清单顺序即拦截顺序

顺序本身就是安全语义：**审批必须在幂等外面**——被用户拒绝的调用不该污染幂等缓存（否则「拒绝」被缓存成结果，用户改主意批了也不执行）。这套顺序不靠注释守护，靠组合器声明：

```ts
// apps/api/src/chat/tool-assembly.ts —— 组装车间：顺序即配置
const shells: ((table: ToolSet) => ToolSet)[] = [];
if (approval !== undefined && approval.confirmTools.size > 0) {
  shells.push((table) => wrapToolsWithApproval(table, approval.confirmTools, { /* … */ }));
}
shells.push((table) => wrapToolsWithIdempotency(table, idempotency, { scope: sessionId }));
return composeToolShells(baseTools, shells);  // shells[0] 最外：审批在外、幂等在内
```

`composeToolShells(base, shells)` 里数组顺序 = 书写顺序 = 拦截顺序，`shells[0]` 最靠外、最先看到调用；空数组 = 原表原样返回。将来加限流壳 / 审计壳，清单里添一行即可。

---

## 五、坑与取舍

**坑 1 · 幂等键里为什么必须有 scope**。键 = scope（通常是 sessionId）+ 工具名 + 参数指纹。去掉 scope，两个会话提交内容相同的工单会被去重成一单——**跨会话的相同参数是两笔业务**。会话销毁时还有 `clearScope` 清掉该会话全部条目，防陈旧跨会话命中。

**坑 2 · 审批壳为什么只挂在流式端点**。非流式 `POST /api/chat` 没有 SSE 通道可推审批卡，包壳只会白等 60 秒——所以名单非空时非流式端点直接返回 400 引导用户改走流式端点（有意的行为变更，而默认名单含 createTicket，等于默认就拦）。

**坑 3 · 两本登记簿都在进程内存**。幂等与审批的登记簿重启即清——等价于「缓存窗口过期」，教程规模下是可接受的取舍；跨实例部署要共享幂等窗口时，换 Redis SETNX + TTL 实现，接口不变。

---

## 六、动手任务（做完才算通关）

1. 跑 `pnpm examples:custom-tool`，回答：为什么一个用户请求串出了两个工具调用？
2. web `/` 页触发审批卡：先拒绝看模型的收尾话术，再放行；然后**同一会话**重复同样的建单请求，验证拿到同一个工单号。
3. **改造**：给 examples 里的 `addTodo` 套上 `wrapToolsWithIdempotency`（scope 用固定字符串），同一句「加一个待办 X」发两遍，验证清单里只有一条新增。

## 自测题（先凭记忆答，再展开）

1. 幂等键由哪三部分组成？为什么必须带 scope？
2. 三条纪律各自防什么故障？去掉「成功才缓存」会发生什么？
3. 为什么审批壳必须在幂等壳外面？`composeToolShells` 的清单顺序是什么语义？

<details><summary>答案</summary>

1. scope（通常 sessionId）+ 工具名 + 规范化参数指纹（stableStringify：键排序、undefined 剔除）。带 scope 是因为跨会话的相同参数是两笔业务，不能互相去重。
2. 成功才缓存→防失败堵死重试；在途共享→防同键并发各执行各；scope 隔离→防跨会话误去重。去掉第一条：一次网络抖动的失败被缓存，模型随后的合理重试全部命中「缓存的结果」，调用永远失败。
3. 被用户拒绝的调用不该进幂等缓存（否则拒绝成了结果，改主意批准也不执行）。清单顺序 = 拦截顺序：shells[0] 最外、最先看到调用。

</details>

---

## 延伸

- [参考库 · 工具箱](/reference/03-tools) —— 注册表 / 幂等层 / 壳组合器的完整语义与代码走读
- [扩展指南](/how-to/EXTENDING) —— 加一个自定义工具的完整步骤与验收清单
- 归档周教程：[week11 · 工具三件套与循环](/archive/weeks/week11/) · [week18 · Day 5-6 安全护栏与审批](/archive/weeks/week18/)
- 下一站：[06 · 护栏与安全红队](/guide/06-safety) —— 工具之外的防线：脱敏、防注入、审计账本，全部来自真实红队实验
