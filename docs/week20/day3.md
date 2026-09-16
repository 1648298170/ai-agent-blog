# 第 20 周 · Day 3：多租户 + RBAC 整合——一套系统服务多家公司，数据严格隔离

> 对应手册任务：学习「多租户 + RBAC 整合」，动手「在 BFF 层实现基于 tenant 的数据隔离和角色权限」，当日产出「多租户就绪」。本篇只解决一个问题：系统从「服务一家公司」变成「服务 N 家公司」时，A 公司的用户无论如何都摸不到 B 公司的数据，哪怕他拿到了接口地址、会手写请求、甚至伪造请求头。

## 今日目标

1. 说得清多租户三种方案的隔离性与成本取舍，以及共享表 + tenant_id 为什么是中小规模的主流选择、什么时候必须升级
2. 掌握 tenant_id 的全链路注入：JWT 载荷 → BFF Guard → 请求头 X-Tenant-ID → SQLAlchemy 全局 filter，外加 LangGraph 记忆和 RAG 知识库两块 Agent 存储的隔离
3. 独立完成多租户改造，并用「改包重放」的攻击者视角验证越权请求全部被拒

## 概念讲解：为什么先上多租户

昨天 [Day 2](/week20/day2) 把 BFF 接通了，但整个系统还默认「只有一家公司在用」。现在你的 Agent 平台要卖钱了：甲公司买了标准版，乙公司买了专业版，两家用的其实是同一套 FastAPI、同一个数据库、同一个向量库。这时你面前有两条路。

第一条路，来一个客户部署一套系统。隔离绝对干净，成本也绝对线性：10 个客户就是 10 套数据库、10 条发布流水线、10 份半夜告警。客户少了养不起，客户多了忙死你。

第二条路，所有人共用一套表，不加任何区分字段。省事，但灾难是确定性的：乙公司员工在对话框里提问，RAG 检索命中了甲公司的合同文档。这在 ToB 场景里不叫 bug，叫商业事故，是合同可以被直接终止的那种。

两条路都不行：独立部署养不起，混在一起不敢卖。你想要的是：一套部署服务所有客户（成本可控），同时每家公司的数据在逻辑上像住在独立房间里（严格隔离）。这就是多租户，SaaS 的地基。

RBAC 是第二道门。第 5 周你搭过角色体系，但那时系统里只有「一家公司」，admin 就是万能钥匙。多租户之后 admin 必须分裂：甲公司的 tenant_admin 能管理甲公司的人，碰不到乙公司一根毛；平台的 platform_admin 能看全部租户的监控，却也不该顺手翻客户的业务数据。角色回答「能做什么操作」，租户回答「能在谁身上做」，两个维度缺一个都锁不住。

## 核心知识

### 1. 三种隔离方案：一张表做决定

| 方案 | 隔离性 | 单客户成本 | 适用场景 |
| --- | --- | --- | --- |
| 独立数据库 | 最强，物理隔离 | 最高：一家一套库、一套备份迁移 | 金融、医疗、大客户指定部署 |
| 同库独立 Schema | 中，逻辑隔离 | 中：表数量随客户数翻倍 | 几十家客户，合规要求数据分开存 |
| 共享表 + tenant_id | 行级隔离，靠全局 filter 保证 | 最低：每张表加一列 | 中小规模 SaaS 的绝对主流 |

本教程走第三种。理由很实际：改动最小（加一列加一套自动过滤），硬件全客户共享，边际成本接近零。代价是把安全性从「数据库天然隔离」变成了「工程纪律保证」，所以后面的全局 filter 和越权测试一个都不能省。

什么时候该升级：某家客户的数据量把共享库的查询拖慢（吵闹邻居问题）；合同白纸黑字要求数据物理隔离；数据库连接数先顶不住了。好消息是 tenant_id 从第一天就在，从共享表迁到独立 schema 或独立库只是「按 tenant_id 导出再导入」的搬运活，业务代码一行不用改。共享表不是终点，是起点。

### 2. tenant_id 全链路注入：四段接力

原则只有一条：tenant_id 的唯一可信来源是登录时签发的 JWT，后面每一跳只准从上一跳拿，永远不准从客户端拿。

第一段，登录时写进 JWT 载荷：

```python
# app/auth.py，FastAPI 登录接口签发 JWT
import jwt
from datetime import datetime, timedelta, timezone

payload = {
    "sub": str(user.id),
    "tenant_id": user.tenant_id,  # 用户属于哪家公司，登录那一刻定死
    "role": user.role,            # member / tenant_admin / platform_admin
    "exp": datetime.now(timezone.utc) + timedelta(hours=8),
}
token = jwt.encode(payload, SECRET, algorithm="HS256")
```

第二段，BFF 的 Guard 验签解出，Interceptor 覆盖写入转发头：

```ts
// bff/src/tenant/tenant.guard.ts
import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const token: string = req.headers.authorization?.slice(7) ?? '';
    const payload = this.jwt.verify(token); // 验签失败直接抛 401
    req.tenantId = payload.tenant_id;       // 唯一可信来源：JWT 载荷
    req.role = payload.role;
    return true;
  }
}

// bff/src/tenant/tenant.interceptor.ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    // 关键：覆盖，不是透传。客户端自带的 X-Tenant-ID 在这里被抹掉
    req.headers['x-tenant-id'] = String(req.tenantId);
    return next.handle();
  }
}
```

第三段，FastAPI 用依赖注入接住（第 10 周依赖注入的进阶用法）：

```python
# app/deps.py
from fastapi import Header, Depends
from sqlalchemy.orm import Session

def get_tenant_id(x_tenant_id: int = Header(alias="X-Tenant-ID")) -> int:
    return x_tenant_id  # 缺头 FastAPI 自动 422，不用自己判空

def get_session(tenant_id: int = Depends(get_tenant_id)):
    session = SessionLocal()
    session.info["tenant_id"] = tenant_id  # 挂在 session 上，供全局 filter 读取
    try:
        yield session
    finally:
        session.close()
```

第四段，SQLAlchemy 事件监听，对所有 ORM 查询自动拼 `WHERE tenant_id`。先给业务表挂 mixin：

```python
# app/models.py
from sqlalchemy import Integer
from sqlalchemy.orm import declarative_mixin, Mapped, mapped_column

@declarative_mixin
class TenantMixin:
    tenant_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)

class Document(TenantMixin, Base):
    __tablename__ = "documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str]
```

再注册两个 session 级事件：

```python
# app/db.py
from sqlalchemy import event
from sqlalchemy.orm import Session, with_loader_criteria

@event.listens_for(Session, "do_orm_execute")
def _tenant_filter(state):
    tenant_id = state.session.info.get("tenant_id")
    if tenant_id is not None and state.is_select:
        state.statement = state.statement.options(
            with_loader_criteria(
                TenantMixin,
                lambda cls: cls.tenant_id == tenant_id,
                include_aliased=True,
            )
        )

@event.listens_for(Session, "do_orm_flush")
def _stamp_tenant(session, flush_context, instances):
    tenant_id = session.info.get("tenant_id")
    for obj in session.new:
        if isinstance(obj, TenantMixin) and obj.tenant_id is None:
            obj.tenant_id = tenant_id  # 查询自动过滤，写入自动盖章
```

关键在 `with_loader_criteria`：它挂在 Session 类的事件上，对所有走 ORM 的 SELECT 生效。业务代码里从此不用再出现 tenant_id 这个词，`session.query(Document).all()` 这句代码，租户 1 调用返回 3 条，租户 2 调用返回 2 条，业务层毫不知情。隔离不依赖每个程序员的自觉，这才是它比「每个查询手动加条件」强的地方。

### 3. Agent 的存储：逐个过隔离检查清单

业务库隔离完，Agent 系统还没完。LangGraph 的记忆、RAG 的向量库都是独立存储，全局 filter 管不到它们，必须逐个处理：

| 存储 | 隔离手段 | 漏掉会怎样 |
| --- | --- | --- |
| 业务表（PostgreSQL） | tenant_id 列 + 全局 filter | 甲公司查到乙公司的数据 |
| LangGraph checkpointer | thread_id 加租户前缀 | 甲公司用户接着乙公司的会话续聊，上下文全泄 |
| 向量库（RAG 知识库） | metadata 加 tenant 过滤 | 检索结果混入别家公司的文档 |

checkpointer 的隔离就一句话：thread_id 不再是裸 UUID，而是「租户前缀 + 原始 ID」：

```python
import uuid
from fastapi import HTTPException

def make_thread_id(tenant_id: int) -> str:
    return f"t{tenant_id}:{uuid4().hex}"  # 新会话由服务端生成，天然带归属

def check_thread_owner(thread_id: str, tenant_id: int) -> None:
    if not thread_id.startswith(f"t{tenant_id}:"):
        raise HTTPException(403, "该会话不属于当前租户")
    # 续聊前必查：用户提交的 thread_id 可能是抄来的
```

向量库同理，写入和检索两端都要带租户：

```python
# 写入：上传文档时把租户写进 metadata
chunks = splitter.split_text(doc.text)
vectorstore.add_texts(chunks, metadatas=[{"tenant_id": tenant_id}] * len(chunks))

# 检索：过滤条件里永远有租户，代码里不存在「不过滤」的分支
hits = vectorstore.similarity_search(
    query, k=5, filter={"tenant_id": tenant_id},
)
```

检查清单就三条，但每次新增存储都要重新过一遍：新加了文件存储？路径里带租户目录。新加了缓存？key 里加租户前缀。多租户系统的数据泄漏，八成出在「新存储忘了接隔离」。

### 4. RBAC 复用：给角色挂上租户维度

第 5 周的 RolesGuard 今天几乎不用改：它读的角色来自 req.role，而 req.role 由 TenantGuard 从 JWT 解出，角色天然跟着租户走：

```ts
// bff/src/auth/roles.guard.ts，第 5 周的角色守卫
import { Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';

export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const required = Reflect.getMetadata('roles', ctx.getHandler()) ?? [];
    if (required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest();
    return required.includes(req.role);
  }
}
```

用法上分清两类接口：

```ts
// 租户级操作：本公司管理，只能操作 req.tenantId 这家公司
@Roles('tenant_admin', 'platform_admin')
@UseGuards(TenantGuard, RolesGuard)
@Post('users')
inviteUser(@Req() req) { /* 加人范围被锁死在自家租户 */ }

// 平台级操作：租户列表、套餐调整，tenant_admin 一律 403
@Roles('platform_admin')
@Get('admin/tenants')
listTenants() { ... }
```

两个 admin 的边界要划死：tenant_admin 的权力边界是「本公司」；platform_admin 的边界是「平台运维」，它操作具体租户时要显式指定目标，而不是默认全库可见。守卫管角色，全局 filter 管范围，两道锁一起上。

## 动手任务：多租户改造一步一步

在昨天 BFF 项目的基础上动手，拆成 5 步，全程约 45 分钟。

**第 1 步：表加列，造两家公司。** 给业务表挂上 TenantMixin，迁移后造种子数据：租户 1（甲公司）3 条文档，租户 2（乙公司）2 条文档。没有两家公司的真实数据，后面所有验证都是空话。

**第 2 步：登录签发带 tenant_id 的 JWT。** 用户表加 tenant_id 和 role 列，登录接口按「核心知识」第一段的代码签发。拿两个用户的账号各换一个 token，去 [jwt.io](https://jwt.io) 解开看载荷，确认 tenant_id 和 role 都在。

**第 3 步：BFF 挂 Guard 和 Interceptor。** 在 main.ts 里全局挂载（`app.useGlobalGuards(...)`、`app.useGlobalInterceptors(...)`），转发 FastAPI 的请求统一从 `req.headers['x-tenant-id']` 取值。重启 BFF。

**第 4 步：FastAPI 接全局 filter。** 加上 deps.py 的 get_session 和 db.py 的两个事件监听。用甲公司 token 走 BFF 查文档列表，只返回 3 条；换乙公司 token 再查，只剩 2 条。业务代码一行没改，结果却变了，这就是 filter 在工作。

**第 5 步：攻击者测试。** 别只测正常路径，换上攻击者视角，三个动作：

```bash
# 攻击 1：合法 token + 伪造别人的租户头
curl -H "Authorization: Bearer $TOKEN_A" \
     -H "X-Tenant-ID: 2" \
     http://localhost:3000/api/kb
# 预期：返回的还是租户 1 的 3 条。BFF 用 JWT 里的值覆盖了你的伪造头

# 攻击 2：绕过 BFF 直连 FastAPI
curl -H "X-Tenant-ID: 1" http://localhost:8000/kb
# 预期：拒绝或超时。8000 只监听内网/容器网络，这是部署层的第二道锁

# 攻击 3：抄别人的 thread_id 续聊
curl -H "Authorization: Bearer $TOKEN_A" \
     -H "X-Thread-ID: t2:abc123" \
     http://localhost:3000/api/chat
# 预期：403。前缀校验发现这个会话属于租户 2
```

三发全被拦下，「多租户就绪」这块牌子才算挂上墙。

::: tip 测试顺序
先跑攻击 1 再跑攻击 2。攻击 1 验证的是 BFF 的头覆盖逻辑，攻击 2 验证的是网络拓扑。如果攻击 1 失败（返回了租户 2 的数据），先回头查 Interceptor 是不是没挂上，别急着动 FastAPI。
:::

## 常见踩坑

**坑 1：只在查询加过滤，忘了写入时盖章。** 全局 filter 管查不管插：INSERT 时 tenant_id 为空、又没走 do_orm_flush 的自动盖章，就会产生「无主行」。更阴的是全局 filter 会把无主行对所有人隐藏，数据像凭空消失，排查半天才发现是 NULL。双保险：列设 NOT NULL，盖章事件照挂。

**坑 2：raw SQL 绕过全局 filter。** with_loader_criteria 只拦截 ORM 查询，`session.execute(text("SELECT ..."))` 和手写的 Core 层 update、delete 都不在保护范围。团队立条规矩：多租户表的操作一律走 ORM；确要 raw SQL，必须手动拼 tenant_id 条件，code review 里重点盯。

**坑 3：checkpointer 只加前缀，不校验归属。** 加前缀解决了「新建会话天然带租户」，但用户续聊时提交的 thread_id 可能是抄来的。服务端必须先过 check_thread_owner 再读 checkpoint，否则前缀只是装饰。

**坑 4：把 tenant_admin 当万能 admin 用。** 哪天看到 tenant_admin 能调「全部租户列表」接口，就是两个维度混了。自查方法：对任何一个接口问两个问题——这个操作是什么角色？作用在哪个租户身上？答不清的接口就有越权风险。

**坑 5：FastAPI 无条件信任 X-Tenant-ID。** 这套架构里 FastAPI 只信 BFF，前提是攻击 2 的网络隔离真的做到位。哪天为了调试把 8000 端口暴露到公网，任何人手写一个头就能冒充任何租户。内部服务的信任边界是「网络不可达」，不是「没人会试」。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 三种多租户方案怎么选？从共享表升级的信号有哪些？

::: details 参考答案
中小规模、无物理隔离的合规要求，选共享表 + tenant_id，改动和成本都最小。升级信号：大客户把共享库查询拖慢（吵闹邻居）、合同要求数据物理隔离、连接数或存储顶不住。因为 tenant_id 一直都在，迁移只是按租户搬运数据，业务代码不用重写。
:::

2. 全局 filter（do_orm_execute + with_loader_criteria）解决了什么问题？什么情况下会失效？

::: details 参考答案
它把「每条查询手动加 WHERE tenant_id」变成 session 级自动行为，隔离不依赖程序员自觉。失效场景：raw SQL（text()）、Core 层 update/delete、没挂 TenantMixin 的表，以及绕开 get_session 直接创建的 session（session.info 里没有 tenant_id，filter 不生效）。
:::

3. 为什么 X-Tenant-ID 必须由 BFF 覆盖写入，而不是透传客户端原本的头？

::: details 参考答案
因为 tenant_id 的唯一可信来源是 JWT。请求头客户端可以随便设，BFF 若原样透传，攻击者拿自己的合法 token 就能指定任意租户。覆盖写入保证转发头和 token 归属一致，这正是攻击 1 要验证的点。
:::

4. checkpointer 的 thread_id 加了租户前缀后，还差哪一步才能防横向越权？

::: details 参考答案
续聊时的归属校验。前缀只保证服务端新建的 thread_id 带租户信息，拦不住用户提交别人的 thread_id。读 checkpoint 前必须 check_thread_owner：前缀不等于当前租户就 403。
:::

5. tenant_admin 和 platform_admin 的权力边界分别是什么？举一个必须 platform_admin 的接口。

::: details 参考答案
tenant_admin 的边界是本公司：管本公司的用户、知识库、会话，动作范围被全局 filter 锁在自家租户。platform_admin 的边界是平台运维：全部租户列表、套餐与配额调整、平台监控，操作具体租户时要显式指定目标。租户列表、跨租户监控这类接口必须 platform_admin。
:::

## 延伸阅读

- SQLAlchemy 官方文档 [ORM Querying API（with_loader_criteria 与 Filtered Loader Criteria）](https://docs.sqlalchemy.org/en/20/orm/queryguide/api.html)，今天全局 filter 的原始出处，示例和注意事项都值得通读
- LangGraph 官方文档 [Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)，看懂 thread 与 checkpoint 的生命周期，就明白为什么前缀隔离够用
- Qdrant 官方文档 [Filtering](https://qdrant.tech/documentation/concepts/filtering/)，向量检索过滤条件的语法参考；用 pgvector + LangChain 的写法今天已经给出
- [Day 2 的 BFF 教程](/week20/day2)，今天的 Guard 和 Interceptor 都挂在它搭好的骨架上，忘了接口结构就回去翻

今天的改造留在 BFF 和 FastAPI 项目里。JWT 载荷中已经有了 tenant_id、role、sub，这就是一份完整的用户上下文，明天 [Day 4](/week20/day4) 做统一认证贯通时，把它扩展成前端登录到 Agent 服务的完整身份链路，改动量比你想的小。
