# 11 · 生产化与成熟度

> **这一站解决「从 Demo 到生产」的距离问题**：这个距离不是一步登天，而是一张诚实的差距清单。学完你将拥有：env 一键切换的真实持久化（pgvector + Redis）、一条命令拉起的四容器全栈、双形态部署——以及一张逐模块标注「离生产还差几步」的成熟度矩阵。

**前置**：[03 · 记忆与上下文压缩](/guide/03-memory)（存储接口与 env 工厂是本章地基）+ [10 · Web 前端](/guide/10-frontend)（三页前端等着容器化）
**配套跑起来**：`pnpm infra:up` → 切存储开关 → `pnpm stack:up`（全流程见第七节）
**深读**：[how-to · MATURITY](/how-to/MATURITY)（每个模块的档位与生产前置项——本章的诚实清单全文）

---

## 一、为什么：先定义「生产」是什么

「能跑」和「能上生产」之间隔着三个维度的追问：**数据会丢吗**（重启之后会话还在吗）、**挂了会炸吗**（模型网关抖一下整个系统死吗）、**被攻击会漏吗**（没有认证限流，公网上就是裸奔）。

[how-to · MATURITY](/how-to/MATURITY) 把答案整理成三档：

| 档 | 定义 | 本项目对应 |
|---|---|---|
| **Demo** | 跑通概念，重启丢状态，单进程 | 内存存储默认值、零配置可跑 |
| **单实例** | 单机可长期跑（持久化/容错有了） | pgvector + Redis + 契约测试 |
| **生产前置** | 上生产前还差什么 | 重试退避 / RBAC / 限流 / OTel……（见第六节） |

教学价值恰恰在最后一张表：**「诚实边界」比「什么都能」更值钱**——知道差几步，比以为没有差距安全得多。

## 二、持久化三层落地：同接口多实现 + env 工厂

第 03 站定下的接口（`SessionStore` / `PreferenceStore` / `EpisodicStore`）+ 第 04 站的 `RagStore`，在这里全部有了真实实现，由环境变量一键切换：

```env
RAG_STORE=memory | json | pgvector      # 知识库（默认 json 快照）
SESSION_STORE=memory | redis            # 会话窗口（默认 memory）
PREFERENCE_STORE=memory | pg            # 用户偏好
EPISODIC_STORE=memory | pgvector        # 情景记忆（向量召回）
```

三条工程纪律撑住这次升级：

1. **不配置 = 与改造前完全一致**（离线优先铁律：没装 Docker 的机器照常跑 `pnpm chat`；不认识的 store 值会警告并回退内存默认）；
2. **业务代码零改动**——`chat.service` 只认接口，工厂读 env 装配实现；
3. **契约测试背书**——同一套断言跑所有实现（memory 常跑；redis/pgvector 在 `RUN_INFRA_TESTS=1` 时跑），新增第四份实现只需挂上契约，不用复制断言。

**实测验证**（数据真的在里面，不要凭信）：

```powershell
pnpm infra:up                                                  # pgvector(pg16) + redis(7)，等 healthy
$env:SESSION_STORE = "redis"; $env:RAG_STORE = "pgvector"; pnpm chat
docker compose exec redis redis-cli --scan --pattern "agent:sess:*"   # 会话 key 在
docker compose exec redis redis-cli ttl "agent:sess:<sessionId>"      # TTL > 0（24h 每次写入续期）
docker compose exec postgres psql -U agent -c "select count(*) from kb_chunks"   # 知识块在
```

## 三、一键全栈：compose 四容器

[docker-compose.yml](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/docker-compose.yml) 把 pg + redis + api + web 四个容器打成一条命令：`pnpm stack:up`（= `docker compose --profile app up -d --build`）。两个设计值得抄：

- **profile 门禁**：api/web 挂在 `app` profile 下——不带 `--profile` 的 `docker compose up -d`（即 `pnpm infra:up`）行为分毫不变，「不配置 = 一致」铁律延伸到了容器层；
- **.env 经变量替换流入容器，永不进镜像**：compose 的 `${OPENAI_API_KEY:-}` 从 agent-app/.env 读值注入容器**运行时环境**，空默认值保证无 .env 也能起容器（首次调 LLM 才报中文配置提示）——镜像里没有密钥，推仓库推 registry 都不心虚。

**地址方向记一句话：容器互访用服务名，浏览器访问用宿主机端口。**

```text
api 容器内：  PG_CONNECTION_STRING=postgres://agent:agent@postgres:5432/agent   ← 服务名+容器端口
浏览器侧：    NEXT_PUBLIC_API_BASE=http://localhost:3000                        ← 宿主机映射端口
```

这两个方向是同一枚硬币的两面：api 与 pg/redis 同在 compose 网络里，认识的是服务名；页面 JS 跑在**你的浏览器**里（不在 compose 网络里），只认识宿主机端口（postgres 宿主机侧是 5433，避让本机已占用的 5432）。

## 四、部署双形态与可观测：诚实版

- **博客站（本教程站）**：GitHub Actions 自动部署 GitHub Pages——push 到 main 即构建发布，OIDC 短期令牌免密，全程零 Secret；
- **应用站**：`Dockerfile.api` / `Dockerfile.web`（Next.js standalone）两个镜像，`pnpm stack:up` 本地即生产形态。

可观测的现状是一档半：**有** trace——`AGENT_TRACE=1` 后每步思考/行动/观察/路由/检索/压缩带图标打到 stderr，`pnpm stack:logs` 容器里同样生效；**诚实承认没有**——结构化日志（JSON 行）、请求关联 ID 贯穿、指标与告警、OTel 全链路追踪，全部未做（生产前置项，素材见 [week21](/archive/weeks/week21/) 的 LangSmith / Langfuse / OTel GenAI 议题）。演示级图标流与工业级可观测的分界线，我们画在明处。

## 五、成本意识：token 是线性烧的

手写循环每一轮都把**全部历史重发**一遍——成本随轮数线性上涨，这是结构性成本不是 bug。第一道闸已经在 03 站装好：滚动摘要压缩（超 40 条触发，旧消息压成 ≤150 字摘要，窗口回到 20 条）。第二道闸「语义缓存」（相似问题直接返回缓存答案，不再调模型）**未做**——生产前置项，做法素材见 [week21 Day 6](/archive/weeks/week21/day6)。配套的 token 用量聚合与成本面板也挂了账：usage 现在飘过就丢。

## 六、诚实清单：生产前置未做项

这张表每一条都能在 [how-to · MATURITY](/how-to/MATURITY) 与 [BACKLOG](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/BACKLOG.md) 里找到出处：

| 未做项 | 差在哪 | 挂账 |
|---|---|---|
| 重试与退避 | 模型调用失败即失败，无 429/5xx 指数退避 | BACKLOG #3 |
| 认证 / RBAC 多租户 / 限流 | web/api 对公网是裸奔 | BACKLOG #5 |
| 幂等缓存跨实例 | 进程内存版，重启即清（接口已留 Redis SETNX 缝） | MATURITY |
| 审批登记簿跨实例 | 进程内存，多实例需共享 | MATURITY |
| 在线评估 | 76 例是离线考卷，真实流量未回流 | BACKLOG |
| OTel / 结构化日志 | trace 是 stderr 图标流，无 trace-id 贯穿 | BACKLOG #6 |
| 语义缓存 / 成本面板 | 见第五节 | BACKLOG #10 |

## 七、跑起来（生产化全流程）

```powershell
cd agent-app
pnpm infra:up                                       # ① 基础设施：pg(5433) + redis(6379)
$env:SESSION_STORE = "redis"; pnpm chat             # ② 单切一项验证持久化（+第二节验证命令）
Remove-Item Env:SESSION_STORE                       #    清掉开关回到默认
pnpm stack:up                                       # ③ 一键全栈：四容器（存储开关 compose 已设好）
pnpm stack:logs                                     # ④ 跟看 api + web 日志（trace 也在里面）
# 浏览器访问 http://localhost:3001（web），它调用的是宿主机 3000（api）
pnpm stack:down                                     # ⑤ 只撤 api+web，pg/redis 原地不动（数据卷保留）
```

## 八、动手任务（做完才算通关）

1. `SESSION_STORE=redis` 下聊几轮，`redis-cli ttl` 验证「每次写入续期 24h」（先查 TTL，再发一条消息，再查——数字变了）。
2. `pnpm stack:up` 后把 api 容器 `docker restart agent-app-api`，刷新浏览器——会话历史还在（Redis 没重启），体会「应用无状态、数据在基座」的生产形态。
3. **改造**：给 `docker-compose.yml` 的 web 服务把宿主机端口从 3001 改成 5173，验证一行配置换端口、镜像零重建。

## 自测题（先凭记忆答，再展开）

1. 三档成熟度（Demo / 单实例 / 生产前置）分别怎么定义？本项目默认配置在哪一档？
2. 「容器互访用服务名，浏览器访问用宿主机端口」——为什么 api 连 PG 用 `postgres:5432`，而页面 JS 里却是 `localhost:3000`？
3. `.env` 里的密钥是怎么进容器的？为什么说它「永不进镜像」？

<details><summary>答案</summary>

1. Demo = 跑通概念、重启丢状态、单进程；单实例 = 单机可长期跑（持久化/容错）；生产前置 = 上生产前还差的清单。默认（json 快照 + memory 存储）在 Demo 档，零配置可跑是刻意的。
2. api 容器与 pg/redis 同在 compose 网络，DNS 解析服务名直达（PG 对容器暴露 5432）；页面 JS 跑在用户宿主机的浏览器里，不在 compose 网络中，只能走宿主机映射端口 3000 找 api。
3. compose 的变量替换 `${OPENAI_API_KEY:-}` 在**起容器时**从 .env 读值注入容器运行时环境变量；Dockerfile 构建阶段碰不到 .env，镜像层里没有密钥——所以推镜像不泄密。

</details>

---

## 延伸

- [how-to · MATURITY](/how-to/MATURITY) —— 每个模块的档位与生产前置项（本章诚实清单的全文版）
- [参考库 · 三层记忆](/reference/04-memory) —— 存储接口契约与契约测试挂法
- 归档周教程：[week14 · pgvector](/archive/weeks/week14/) · [week17 · Redis 记忆](/archive/weeks/week17/) · [week21 · 可观测与成本](/archive/weeks/week21/) · [week22 · 系统设计](/archive/weeks/week22/)
- 下一站：[12 · 学完之后：演进方向](/guide/12-roadmap) —— 十二站走完，这张诚实清单就是你的下一份地图
