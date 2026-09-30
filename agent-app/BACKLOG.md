# agent-app 待办清单（BACKLOG）

> 挂账不遗忘。每项标注触发条件——到条件再开工，不提前透支。

## ① Multi-Agent 教学落地（下一项，等现有七模块学完再开工）

**触发条件**：按各模块 README 建议顺序学完 tools → rag → memory → service → mcp → guardrails → evals（多 Agent 是单 Agent 的乘法，基础不牢学它容易糊涂）。

**教学主张**：多 Agent = 单 Agent 的乘法，不是玄学——每个"Agent"就是独立 system prompt + 独立职责 + 受控输入输出的 `runToolLoop` 组合。多 Agent 的新问题只有三个：**分工**（谁干什么）、**共享状态**（互相知道什么）、**质量闭环**（谁验收）。

### P1 升格叙事（半小时，零代码）
`service/README.md` 增补一章「你就是多 Agent：Supervisor 模式」——用已有代码教第一个多 Agent 模式：
- supervisor = 路由 Agent（硬规则 + 三分类），workers = 三个专家 Agent（独立 system prompt + 最小权限工具表），HandoffPack = Agent 间上下文交接
- 对照业界：LangGraph 的 supervisor 模式、CrewAI 的 manager+crew——同一思想不同皮肤

### P2 `teams/` 流水线（核心新增，模块八）
```text
packages/engine/src/teams/
├── types.ts       # TaskPlan / PlanStep / TeamResult 契约
├── blackboard.ts  # 共享黑板：任务状态单一事实源（内存版，接口留持久化缝）
├── planner.ts     # 规划 Agent：目标 → 有序步骤 JSON（宽松解析+重试一次，同 supervisor 套路）
├── executor.ts    # 执行 Agent：逐步骤调 runToolLoop（每步一个带工具的单 Agent）
├── critic.ts      # 评审 Agent：验收结果，不达标带反馈打回（重试上限，evals 思想进运行时）
├── pipeline.ts    # 编排：planner → (executor → critic)* 循环，全程 trace（🧩🔧🔍 区分角色）
└── index.ts + README.md（模块八，标准九节体例）
```
- 示例目标：「查订单 A-1024，未发货就建催发工单」——正好逼出规划/执行/验收三分工
- 依赖倒置（planner/critic 可注假件），离线单测全绿
- 入口：`pnpm team "目标"` CLI；真实成本 ≈ 3-8 次 LLM 调用/流水线

### P3 A2A 落地（week19 Day 4 的代码化）
- `GET /.well-known/agent-card.json`：本机 Agent Card（名称/skills/端点）
- `POST /a2a/tasks`：接收外部 Agent 委托 → 路由到对应 worker 或 teams 流水线 → 回传 artifact（契约进 packages/shared）
- 狗粮：起两个 agent-app 实例，A 读 B 的 Agent Card、委托「查订单」、收回结果

### 验收与风险
- P2 验收：typecheck 全绿 + 离线单测 + `pnpm team` 真实跑通（trace 可见三角色）
- 风险：glm-4-flash 计划 JSON 稳定性（宽松解析+重试一次+失败降级单步）；critic 打回死循环（重试上限 2 次，超限带「未完全达成」诚实收尾）

## ② 其他挂账（按 SECURITY.md / README 既有记录）

| 项 | 来源 | 触发条件 |
| --- | --- | --- |
| 在线评估（trace 回流数据集） | evals/README 路线图 | 有真实流量后 |
| MCP 服务器身份 TOFU 指纹 / 检索内容沙箱 | SECURITY.md 结构性档 | 安全篇深入时 |
| 认证 / 多租户 / 限流 | README「后续扩展」 | week20 生产化阶段 |
| evals 注入回归集（红队 E1-E8 载荷入 evals） | SECURITY.md 结构性档 | 学 evals 时顺手做 |
