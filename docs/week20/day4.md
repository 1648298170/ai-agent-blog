# 第 20 周 · Day 4：统一认证贯通——让每一层只信它该信的人

> 对应手册任务：学习「统一认证：NextAuth / JWT 贯通」，动手「前端登录 → BFF 鉴权 → Agent 服务信任 BFF 传入的用户上下文」，当日产出「认证贯通」。本篇只解决一个问题：用户身份从前端一路传到 FastAPI 的接口参数里，中间每一环都验过签、只信自己该信的东西，而不是把同一枚 token 从头透传到尾。

## 今日目标

1. 说得清自建 JWT 和 NextAuth 两条路线的取舍，出现什么信号时值得换 NextAuth
2. 掌握贯通三件套：refresh token 落 httpOnly cookie、BFF 换发短命 service token、FastAPI 用 Depends 注入 CurrentUser
3. 独立跑通「登录 → 对话」全链路，并亲手伪造一枚 service token，看 FastAPI 把它拒在门外

## 概念讲解：为什么贯通不能靠透传

Day 3 收工时多租户隔离已经在 BFF 落地，但 Agent 服务还有一个致命的「不知道」：不知道正在说话的是谁。FastAPI 收到的请求里没有用户身份，要么所有请求都是匿名，要么你在业务代码里到处手传 `user_id`，传着传着就有人写死、有人漏传，租户隔离名存实亡。

最省事的方案是透传：前端登录拿到的 access token，经过 BFF 原样转发给 FastAPI，两边共用同一把密钥。

```ts
// 图省事的透传：把用户凭证原样扔进内网
return fetch('http://localhost:8000/api/chat', {
  headers: { Authorization: req.headers.authorization }, // 原样转发
  // ...
});
```

一天就能跑通，但埋了三颗雷。雷一，用户 token 的暴露面被拉满：原本它只需要被 BFF 见到，现在内网每个服务都握着有效用户凭证，任何一个服务把请求头打进日志，token 就泄了。雷二，FastAPI 被迫理解用户会话的全套细节：access 过期了怎么办、refresh 要不要撤销，这些和 Agent 业务毫无关系。雷三，密钥共享意味着没法独立轮换：换一把用户密钥，所有服务跟着一起改。

正确的姿势是分段信任：用户 token 的生命止于 BFF；BFF 验签通过后，用另一把服务密钥换发一枚短命的 service token 发给 FastAPI；FastAPI 只认这枚。一张图讲透「谁信谁」：

```
浏览器                  BFF (NestJS)               FastAPI (Agent)
   │                        │                         │
   │── ① 密码登录 ─────────▶│                         │
   │◀─ accessToken ─────────│  (15m，前端存内存)        │
   │◀─ refreshToken ────────│  (7d，httpOnly cookie)  │
   │                        │                         │
   │── ② Bearer accessToken ▶                         │
   │                        │ 验签 OK，换发新 token：    │
   │                        │── ③ Bearer serviceToken ▶
   │                        │   (60s，SERVICE 密钥签)   │
   │                        │                         │ 验签 OK
   │                        │                         │ Depends(CurrentUser)
   │◀──────────────── ④ 响应（携带用户上下文）──────────│
```

三条信任边界，一句话一条：浏览器只信 BFF，密码和 refresh token 只交给 BFF；BFF 只信自己验过的签名，前端请求里说什么身份字段都不算数；FastAPI 只信服务密钥签的 service token，用户 token 就算飘到它面前也过不了验签。每段一把独立密钥，一段失守不殃及全线。

## 核心知识

### 1. 路线选择：自建 JWT 还是 NextAuth

写代码前先做决定：登录这一段用什么管。

**自建 JWT**。第 5 周你已经写过签发和校验，access/refresh 的套路都在手上。完全可控：想在 payload 里塞 `tenant_id` 就塞，想调有效期就调。代价是登录页、密码哈希、登出、CSRF 这些安全细节全自己扛。

**NextAuth v5（Auth.js）**。框架把登录页路由、会话管理、OAuth Provider 全包了：

```ts
// auth.ts：如果走 NextAuth 路线，前半段全是现成的
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: 'jwt' },
});
```

几行配置，GitHub 登录的回调处理、token 刷新、CSRF 防护都是现成的。

判断标准一句话：**要接 Google/GitHub 这类第三方登录，上 NextAuth，它至少省你一周**；只有邮箱密码登录、且第 5 周的 JWT 体系已经在跑，自建更顺手。还有一点要说透：NextAuth 管的只是浏览器到 BFF 这半段，BFF 到 FastAPI 的 service token 它帮不了一点忙，该写的今天照样写。所以本篇主线走自建，NextAuth 认个脸熟即可。

### 2. 前端：access 存内存，refresh 进 httpOnly cookie

第 5 周 Day 3 埋的伏笔今天兑现：refresh token 不放 localStorage、不放普通 cookie，由 BFF 写进 **httpOnly cookie**，JavaScript 读不到；accessToken 只存一个模块变量，不落任何持久化存储。

为什么不都用 localStorage？XSS 注入一段脚本就能掏走，而且 token 会永不过期地躺在那，页面关了它还在。内存方案的价值：页面一刷新 token 就没了，但 cookie 还在，页面起来第一件事静默调刷新接口换新。攻击者就算 XSS 得手，也只能用一下内存里的临时 token，偷不走常驻凭证。

```ts
// 前端 auth.ts：token 只放内存，过期靠 cookie 静默续期
let accessToken: string | null = null;

export async function login(email: string, password: string, tenantId: string) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, tenantId }),
  });
  const data = await res.json();
  accessToken = data.accessToken; // 只存内存，不进 localStorage
}

export async function chat(message: string): Promise<any> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  });
  if (res.status === 401) {
    // accessToken 过期：带着 httpOnly cookie 静默换新，重放一次
    const refreshed = await fetch('/api/auth/refresh', { method: 'POST' });
    if (refreshed.ok) {
      accessToken = (await refreshed.json()).accessToken;
      return chat(message);
    }
  }
  return res.json();
}
```

关键在 `let accessToken` 是模块内变量：它不进 React 状态持久化、不进 storage，刷新即清空，续期完全靠那条读不到的 cookie。

### 3. BFF：验用户 token，换发 service token

BFF 是整条信任链的翻译器，唯一同时摸得到「用户密钥」和「服务密钥」的地方。三个动作：登录时签发双 token，刷新时轮换，代理时换发。

```ts
// auth.service.ts：签发与轮换
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    // private readonly users: UsersService, // Day 3 的多租户用户体系，verify 内部查库加 bcrypt 比对
  ) {}

  async issueTokens(user: { id: string; tenantId: string; role: string }) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, tenant_id: user.tenantId, role: user.role, typ: 'access' },
      { secret: process.env.USER_JWT_SECRET, expiresIn: '15m' },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, typ: 'refresh' },
      { secret: process.env.USER_REFRESH_SECRET, expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }

  async rotate(refreshToken: string) {
    let payload: { sub: string; typ: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.USER_REFRESH_SECRET,
      });
      if (payload.typ !== 'refresh') throw new Error('typ 不对');
    } catch {
      throw new UnauthorizedException('refresh token 无效');
    }
    // 实际项目这里查一遍用户是否仍有效、refresh token 是否被撤销
    const user = { id: payload.sub, tenantId: 't-001', role: 'member' }; // 演示用，真实代码查库
    return this.issueTokens(user);
  }
}
```

```ts
// auth.controller.ts：登录落 cookie，刷新读 cookie
import { Controller, Post, Body, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  async login(
    @Body() body: { email: string; password: string; tenantId: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    // const user = await this.users.verify(body.email, body.password, body.tenantId);
    const user = { id: 'u-1', tenantId: body.tenantId, role: 'member' }; // 演示用
    const { accessToken, refreshToken } = await this.auth.issueTokens(user);
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,               // JS 读不到，XSS 偷不走
      secure: true,                 // 只走 HTTPS
      sameSite: 'strict',
      path: '/api/auth/refresh',    // 只随刷新请求带上，别的接口看不见
      maxAge: 7 * 24 * 3600 * 1000,
    });
    return { accessToken }; // refreshToken 不走响应体，只走 cookie
  }

  @Post('refresh')
  async refresh(@Req() req: Request) {
    const token = req.cookies?.['refresh_token'];
    if (!token) throw new UnauthorizedException('缺少 refresh token');
    const { accessToken } = await this.auth.rotate(token);
    return { accessToken };
  }
}
```

然后是主角，代理时换发 service token：

```ts
// agent.service.ts：校验用户 token，剥离签名，换发 service token 再转发
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AgentService {
  constructor(private readonly jwt: JwtService) {}

  async chat(authHeader: string | undefined, message: string) {
    // 1. 校验用户 accessToken（用户密钥）
    const userToken = authHeader?.replace('Bearer ', '');
    if (!userToken) throw new UnauthorizedException('未登录');
    let payload: { sub: string; tenant_id: string; role: string };
    try {
      payload = await this.jwt.verifyAsync(userToken, {
        secret: process.env.USER_JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('accessToken 无效或过期');
    }

    // 2. 换发 service token（服务密钥，60 秒短命）
    const serviceToken = await this.jwt.signAsync(
      { sub: payload.sub, tenant_id: payload.tenant_id, role: payload.role, typ: 'service' },
      { secret: process.env.SERVICE_JWT_SECRET, expiresIn: '60s' },
    );

    // 3. 转发给 FastAPI，用户 token 到此为止
    const res = await fetch('http://localhost:8000/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({ message }),
    });
    return res.json();
  }
}
```

关键在第 2 步那 60 秒：service token 只活一次内网转发，BFF 每次现签，成本忽略不计，被截获的利用窗口也几乎为零。`typ: 'service'` 是给 FastAPI 留的验明正身字段。

### 4. FastAPI：只认服务密钥，Depends 注入 CurrentUser

FastAPI 侧不用知道 refresh、撤销、租户表这些事，它只做一件事：验服务密钥的签名，把 payload 变成类型安全的 `CurrentUser`。

```python
# deps.py：校验 service token，注入 CurrentUser
import os
from dataclasses import dataclass
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

SERVICE_JWT_SECRET = os.environ["SERVICE_JWT_SECRET"]
bearer = HTTPBearer()

@dataclass
class CurrentUser:
    user_id: str
    tenant_id: str
    role: str

async def get_current_user(
    creds: HTTPAuthorizationCredentials = Depends(bearer),
) -> CurrentUser:
    try:
        payload = jwt.decode(
            creds.credentials,
            SERVICE_JWT_SECRET,
            algorithms=["HS256"],  # 锁死算法，防 alg 混淆攻击
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="service token 无效")
    if payload.get("typ") != "service":
        raise HTTPException(status_code=401, detail="不是 service token")
    return CurrentUser(
        user_id=payload["sub"],
        tenant_id=payload["tenant_id"],
        role=payload["role"],
    )
```

```python
# main.py：业务接口声明一个参数，身份就到了
from fastapi import FastAPI, Depends
from pydantic import BaseModel
from deps import CurrentUser, get_current_user

app = FastAPI()

class ChatIn(BaseModel):
    message: str

@app.post("/api/chat")
async def chat(body: ChatIn, user: CurrentUser = Depends(get_current_user)):
    # user.tenant_id 天然可用，Day 3 的多租户隔离在这里接上
    return {"reply": f"用户 {user.user_id}（租户 {user.tenant_id}，角色 {user.role}）问：{body.message}"}
```

关键在 `Depends(get_current_user)`：校验逻辑写一遍，业务接口声明一个参数就拿到 `CurrentUser`，拿不到这个注入的请求根本进不了函数体。身份从「到处手传的参数」变成了「框架保证的前提」。

## 动手任务：把认证串起来，一步一步

手册任务：前端登录 → BFF 鉴权 → Agent 服务信任用户上下文。拆成 6 步，全程约 40 分钟。BFF 侧三个文件的完整逻辑就是核心知识 2、3 的代码，直接照抄。

**第 1 步：准备两套三把密钥。** 任意目录执行 `openssl rand -base64 32` 生成三串随机值。BFF 的 `.env` 放三把：`USER_JWT_SECRET`、`USER_REFRESH_SECRET`、`SERVICE_JWT_SECRET`；FastAPI 的 `.env` 只放 `SERVICE_JWT_SECRET` 一把，且必须与 BFF 侧完全一致。注意用户那两把密钥绝不出现在 FastAPI 侧，这是「不透传」的物理保证。

**第 2 步：BFF 挂上 cookie 支持。** `npm i cookie-parser @types/cookie-parser`，在 `main.ts` 里 `app.use(cookieParser())`，否则刷新接口读不到 `req.cookies`。

**第 3 步：放好三个路由。** `AuthController` 的 login/refresh 加上代理 Agent 的 `@Post('api/agent/chat')`，把请求头里的 Authorization 传给 `AgentService.chat`。代码照核心知识 2、3 抄，抄完启动 NestJS。

**第 4 步：FastAPI 接上校验。** `pip install "fastapi" "pyjwt"`，新建 `deps.py` 和 `main.py`（代码在上文），`uvicorn main:app --port 8000` 启动。

**第 5 步：全链路演示。** 前端调 `login('jerry@example.com', 'secret', 't-001')`，再调 `chat('你好')`。打开浏览器 DevTools：Application 面板能看到 `refresh_token` 这条 cookie，httpOnly 一列打着勾，Console 里执行 `document.cookie` 读不到它。chat 的响应应该形如：

```json
{ "reply": "用户 u-1（租户 t-001，角色 member）问：你好" }
```

看到自己的 user_id 和 tenant_id 从 FastAPI 回来，这条链就通了。

**第 6 步：断点测试，伪造 service token。** 新建 `test_forge.py`，专攻「FastAPI 会不会被骗」：

```python
# test_forge.py：两种假 token，都应当被 401 拒绝
import jwt, requests

URL = "http://localhost:8000/api/chat"

# 伪造 1：用用户密钥签一个长得一模一样的 service token
forged = jwt.encode(
    {"sub": "u-1", "tenant_id": "t-001", "role": "admin", "typ": "service"},
    "user-jwt-secret-换成你BFF的USER_JWT_SECRET",
    algorithm="HS256",
)
r1 = requests.post(URL, json={"message": "hi"}, headers={"Authorization": f"Bearer {forged}"})

# 伪造 2：直接拿真实 accessToken 打 FastAPI（绕过 BFF）
# 从 BFF 登录响应里拿 accessToken 后替换下面占位符
# r2 = requests.post(URL, json={"message": "hi"}, headers={"Authorization": f"Bearer {真实accessToken}"})

print(r1.status_code)  # 401：用户密钥签的，服务密钥验不过
# print(r2.status_code)  # 同样 401：密钥不同 + typ 不是 service，双保险都拦
```

跑一次，看到 401 才算当日产出达标。这两个数字是整条设计成立的最硬证据：FastAPI 不认「用户的凭证」，只认「BFF 的背书」。

::: tip 快速自测登录
不写前端也可以先用 curl 验 BFF：`curl -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"jerry@example.com","password":"secret","tenantId":"t-001"}' -c cookies.txt`，再拿返回的 accessToken 手动调代理接口。
:::

## 常见踩坑

**坑 1：两套密钥写成同一个值。** 有人觉得「反正都是我自己签」，把 `USER_JWT_SECRET` 和 `SERVICE_JWT_SECRET` 配成一串。后果是用户 token 立刻能冒充 service token，「不越过 BFF」的整个设计作废。`typ` 字段能挡一层，但根子是密钥必须独立，生成时就用两条不同的随机串。

**坑 2：cookie 不设 path。** `res.cookie` 不写 `path` 默认是 `/`，之后每个请求都背着 refresh token 到处跑。设成 `path: '/api/auth/refresh'`，它只在刷新那一刻出现，暴露面缩到最小。

**坑 3：service token 有效期照抄 15 分钟。** 它只活一次内网转发，60 秒绰绰有余，也不存在刷新一说，BFF 每次现签。长有效期等于放大被截获后的利用窗口，和它的定位完全相反。

**坑 4：FastAPI 只验签名不验 typ。** 密钥分离时用户 token 本来就过不了验签，但你防不了哪天有人把密钥配串（见坑 1）。`typ != "service"` 的检查是一行代码的便宜保险，别省。同理 `algorithms=["HS256"]` 必须显式写，锁死算法，不给 alg 混淆攻击留门。

**坑 5：图调试方便把 accessToken 塞进 localStorage。** 一旦塞了，httpOnly 那套就白搭。localStorage 里的凭证在页面关闭后还在，攻击者拿到的就是一枚长效通行证。内存方案的代价只是「刷新页面多一次静默续期请求」，收益是凭证随页面生灭。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么用户 token 不直接透传给 FastAPI？说出三个理由。

::: details 参考答案
一，暴露面：内网每个服务都握着有效用户凭证，任何一处日志泄露就泄密；二，耦合：FastAPI 被迫理解 access/refresh/撤销这套会话细节；三，轮换：密钥共享导致用户密钥一换所有服务跟着改。换发 service token 后，三个问题都不存在。
:::

2. refresh token 为什么放 httpOnly cookie，而不和 accessToken 一起放内存？

::: details 参考答案
内存里的 token 一刷新页面就没了，而 refresh token 的职责恰恰是「活得比页面久」，它必须持久存在某处。httpOnly cookie 让 JavaScript 读不到，XSS 偷不走；配合 `path` 限制和 `sameSite`，只在刷新请求里出现。
:::

3. service token 为什么短命，且不需要 refresh 机制？

::: details 参考答案
它只活「BFF 转发到 FastAPI」这一次请求的窗口，60 秒足够，BFF 每次现签，签发成本忽略不计。短命换来的收益是被截获后几乎没有利用窗口。refresh 机制是为「用户会话要长期存活」设计的，服务间调用没有这个需求。
:::

4. 出现什么信号时值得上 NextAuth？它管哪一段、不管哪一段？

::: details 参考答案
要接 Google/GitHub 等第三方 OAuth 登录时值得上，Provider、回调、刷新、CSRF 全是现成的，至少省一周。它管浏览器到 BFF 这半段的登录与会话；BFF 到 FastAPI 的 service token 换发不归它管，该手写的照样手写。
:::

5. FastAPI 里 `CurrentUser` 是怎么进入业务函数的？伪造 token 测试验证了什么？

::: details 参考答案
`HTTPBearer` 从请求头提取 Bearer token，`jwt.decode` 用 SERVICE_JWT_SECRET 验签并锁死算法，检查 `typ == "service"` 后构造 `CurrentUser`，经 `Depends` 注入业务函数；拿不到注入的请求进不了函数体。伪造测试验证：用用户密钥签的假 service token 和绕过 BFF 的真 accessToken 都被 401 拒绝，证明 FastAPI 只认 BFF 的背书。
:::

## 延伸阅读

- [Auth.js 官方文档](https://authjs.dev)，NextAuth v5 的权威出处，重点看 Providers 和 Session（JWT 策略）两章
- [RFC 7519：JSON Web Token](https://datatracker.ietf.org/doc/html/rfc7519)，`sub`、`exp`、`typ` 这些字段的原始定义
- [MDN：Set-Cookie](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers/Set-Cookie)，httpOnly、secure、sameSite、path 四个属性逐项读一遍

今天打通的身份链路，明天直接复用：Day 5 的流式对话接口照旧走这条 service token 通道，`CurrentUser` 里那个 `tenant_id` 届时直接决定知识库检索的范围。
