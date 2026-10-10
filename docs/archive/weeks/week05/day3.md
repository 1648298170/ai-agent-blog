# 第 5 周 · Day 3：Refresh Token 与轮换——让登录态活过十五分钟

> 对应手册任务：学习「Refresh Token + Token 轮换」，动手「实现 `/auth/refresh`，用 PostgreSQL 表存 refresh token 黑名单（第 6 周学完 Redis 后迁移）」，当日产出「Token 刷新链路」。本篇只解决一个问题：access token 一过期用户就被踢回登录页，把有效期拉长到七天又不安全，那就让两个 token 分工——短命的负责干活，长命的只负责续命，而且服务端随时能反悔。

## 今日目标

1. 说得清双 token 各自解决什么：access 为什么短命、refresh 为什么敢长命
2. 掌握三个要点：refresh token 存哪的取舍、RefreshToken 表为什么存 sha256 摘要、轮换与吊销的语义
3. 独立跑通 `/auth/refresh` 完整链路，并亲眼看到旧 refresh token 用第二次被拒

## 概念讲解：为什么需要两个 token

先看现状。Day 1 用 `@nestjs/jwt` 签发了 access token，Day 2 挂上 `JwtAuthGuard` 保护了 `/users/me`，链路是通的。现在只剩一个问题悬着：有效期设多长？

方案一，设长一点，7 天。用户体验好，一周不用登录。但 JWT 是无状态的，签发那一刻起服务端就撒手不管，secret 不换它就一直有效。你没有任何办法让某一个 token 单独失效：用户说「我 token 好像被偷了，帮我作废」，做不到；管理员要踢某个账号下线，也做不到。唯一的手段是换 secret，而换 secret 是核弹，全体用户陪葬。更糟的是泄露窗口：这个 token 每个请求都要带，跑在无数网络设备之间，被截获一次就能用满 7 天。

方案二，设短一点，15 分钟。泄露窗口确实小了，偷到的 token 顶多再活一刻钟。代价是用户每 15 分钟重新输一次密码。第一天能忍，第三天用户就流失了。

两条路卡在同一个根子上：一个 token 既要在每个请求里抛头露面（容易泄露），又要活得久（体验好），还要能被吊销（安全），三个愿望互相打架。

解法是拆开。签发两个 token，各管一摊：

- **access token，15 分钟。** 每个请求都带它。因为暴露频繁，干脆假设它迟早泄露，所以命短，泄露窗口只有一刻钟。真丢了就丢了，等它自然过期。
- **refresh token，7 天。** 只在调 `/auth/refresh` 时发一次，平时躺在客户端存储里不露面。暴露面小，所以敢长命。它唯一的职责就是换新的 access token。

点睛的是最后一步：refresh token 是有状态的。签发时在数据库记一笔，想吊销就改一行数据。JWT「无法吊销」的死结不是被解开的，是被绕开的——把「吊销」这件事从无状态的世界搬进一个又小又可控的有状态系统。access 过期了不要紧，refresh 还活着就能续；refresh 被吊销，整条续命链断掉，用户回到登录页。体验和安全各拿各的，谁也不用委屈谁。

## 核心知识

本节的代码跑在前两周攒下的底座上：monorepo 里的 `apps/api`，NestJS + Prisma + PostgreSQL。Day 1、Day 2 的产物（`/auth/login`、`JwtAuthGuard`、`@CurrentUser()`）直接拿来用。

### 1. refresh token 放哪：一块必争之地

access token 不纠结，跟着请求走 `Authorization: Bearer xxx` 就完了。refresh token 要在客户端躺 7 天，放哪是个绕不开的争议，两派打得有来有回。

**httpOnly cookie 派：最安全。** cookie 标上 `httpOnly` 后 JavaScript 读不到它，页面上就算被注入了恶意脚本（XSS），脚本也偷不走 token。代价有两个：浏览器发 cookie 是自动的，别的域名诱导一下就能替用户发请求（CSRF），所以必须另做 CSRF 防护；前后端分开部署时跨域 cookie 的 `SameSite`、`Domain` 配置也够喝一壶。

**localStorage 派：最省事。** 存取就一行代码，跨域和 CSRF 都不存在。软肋只有一个，但很致命：localStorage 对 JS 完全开放，XSS 一旦发生，偷走的不只是 15 分钟的 access，而是 7 天的 refresh。

一句话总结这个争议：cookie 把风险从 XSS 挪到 CSRF，localStorage 反过来。没有免费的安全，只有「你明确接受了什么风险」。

**本教程走 Authorization 头方案**，即前端把 refresh token 存在客户端存储里，刷新时用请求头递给服务端——风险档位和 localStorage 一致。理由很实际：前后端分离加本地开发时最简单，curl 和 Postman 直接就能测；不自动带凭证，CSRF 从根上不存在。代价也白纸黑字写在这：这个方案成立的前提是 XSS 防护做到位（本周 Day 6 专门补这一课），并且团队认下这个取舍。如果你的应用是纯 Web 且前后端同域，生产环境建议换 httpOnly cookie；如果是手机 App，没有 cookie 这回事，安全存储加请求头就是标准做法。

### 2. RefreshToken 表：存摘要，留案底

refresh token 的「有状态」落在一张表上。给 `schema.prisma` 加模型（沿用上周定下的惯例，字段用 camelCase）：

```prisma
model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())

  @@index([userId])
}
```

别忘了关系字段要成对，`User` 那边补一行 `refreshTokens RefreshToken[]`，不然 schema 校验过不了。然后照旧跑迁移：在仓库根目录执行 `pnpm --filter api exec prisma migrate dev --name add_refresh_token`。

逐字段看这张表为什么长这样：

- `userId`：这条 token 属于谁。吊销某人全部 token、用户改密码后连坐清理，都靠它，所以补了索引。
- `tokenHash`：**存的是 sha256 摘要，不是 token 原文。** 数据库一旦被拖，攻击者拿到的是一堆单向哈希，反推不出原 token，换不了 access。核对这个字段时也一样：拿用户传来的原文现场算一次 sha256 再比对。`@unique` 既保证不重复，又让「按摘要查」走索引。
- `expiresAt`：这条记录自己的死期。和 JWT 内部的过期声明互为双保险，后文细说。
- `revokedAt`：**吊销不是 `delete`，是往这列填时间。** 这就是「黑名单」的全部语义：被吊销的记录永远留在表里，而不是删掉。留案底的原因在下一节，它就是重放检测的证据。

### 3. 轮换：一次性的 refresh token，防重放

**轮换（rotation）** 的规矩一句话：refresh token 用一次就作废，每次刷新都发一对全新的。

为什么这么较真？推演一次攻击就懂了。假设攻击者从某处偷到了你的 refresh token，而你毫不知情。没有轮换时，你俩拿着同一个 token 各刷各的，相安无事，攻击者能陪你续命续到天荒地老。有了轮换，就变成赛跑：谁先来刷，谁拿走新一代 token，另一个人手里的立刻变成废纸。更妙的是那个瞬间——已作废的 token 又出现，服务端立刻知道了两件事：这个 token 被用过，而且现在拿它的人不是刚才那个人，八成有一方是贼。既然分不清谁是贼，就全部连坐：把该用户的 refresh token 全部吊销，逼真用户重新登录。真用户重新登录时输了密码，贼手里的 token 已经是死字符串。

代价是用户可能被误伤（自己两台设备打架、网络重试），但安全上这笔账算得过来：宁可偶尔重登一次，不让被盗的 token 无声无息活 7 天。

整条 `/auth/refresh` 链路长这样，动手任务就按它逐格实现：

```text
客户端                              服务端                              PostgreSQL
   │                                  │                                   │
   │ POST /auth/refresh               │                                   │
   │ Authorization: Bearer <refresh>  │                                   │
   ├─────────────────────────────────►│                                   │
   │                                  │ ① verifyAsync：验签名、验有效期      │
   │                                  │    （JWT 层面，伪造/过期在这挡下）    │
   │                                  │ ② sha256(原 token) 算出摘要         │
   │                                  │ ③ 按摘要查 refresh_tokens ────────►│
   │                                  │ ◄────────── 一条记录（或没有）──────│
   │                                  │ ④ 查无记录 ──────────→ 401 无效     │
   │                                  │ ⑤ revokedAt 非空 → 重放实锤：       │
   │                                  │    吊销该用户全部 token → 401       │
   │                                  │ ⑥ expiresAt 已过 → 401 请重新登录   │
   │                                  │ ⑦ 事务：旧记录填上 revokedAt、       │
   │                                  │    插入新 token 的摘要 ───────────►│
   │                                  │ ⑧ 签发新 access(15m) + 新 refresh(7d)│
   │◄─────────────────────────────────│                                   │
   │ 200 { accessToken, refreshToken }                                    │
   │  （旧 refresh 从此作废，前端两个都要换成新的）                            │
```

## 动手任务：`/auth/refresh` 一步一步

手册任务：实现 `/auth/refresh`，用 PostgreSQL 表存 refresh token 黑名单。拆成 5 步，全程约 30 分钟。假设 Day 1 的 `AuthService` 里已经有验完密码后拿到用户、签出 access token 的 `login` 方法，字段名对不上就按你自己的改。

**第 1 步：建表。** 把核心知识第 2 节的 `RefreshToken` 模型加进 `schema.prisma`，`User` 补上反向关系字段，跑迁移。跑完进 psql 执行 `\dt` 瞄一眼，`refresh_tokens` 表在，心里就有底了。

**第 2 步：登录改发双 token。** 改 `auth.service.ts`，先备好两件小工具：

```ts
import { createHash } from "crypto";

const ACCESS_TTL = "15m";
const REFRESH_TTL = "7d";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

private sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
```

再写一个私有的签发方法，登录和刷新都要用它：

```ts
private async issueTokenPair(userId: string, revokeHash?: string) {
  const accessToken = this.jwtService.sign({ sub: userId }, { expiresIn: ACCESS_TTL });
  const refreshToken = this.jwtService.sign(
    { sub: userId, typ: "refresh" },
    { expiresIn: REFRESH_TTL },
  );

  const create = this.prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: this.sha256(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });

  // 带 revokeHash 时是轮换：吊销旧的 + 写入新的，必须同生共死
  if (revokeHash) {
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { tokenHash: revokeHash },
        data: { revokedAt: new Date() },
      }),
      create,
    ]);
  } else {
    await create;
  }

  return { accessToken, refreshToken };
}
```

注意 refresh 的 payload 里塞了个 `typ: "refresh"`，这是给后面区分 token 用的。`login` 里把原来的单 token 签发换成 `return this.issueTokenPair(user.id)`，返回结构从 `{ accessToken }` 变成 `{ accessToken, refreshToken }`，之前对接过登录接口的调用方要同步改。

**第 3 步：实现 refresh 主流程。** 照着流程图逐格翻译，还是 `auth.service.ts`：

```ts
async refresh(rawToken: string) {
  // ① JWT 层：验签名、验有效期
  let payload: { sub: string; typ?: string };
  try {
    payload = await this.jwtService.verifyAsync(rawToken);
  } catch {
    throw new UnauthorizedException("refresh token 无效或已过期");
  }
  if (payload.typ !== "refresh") {
    throw new UnauthorizedException("这不是 refresh token");
  }

  // ②③ 按摘要查户口
  const tokenHash = this.sha256(rawToken);
  const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

  // ④ 查无记录：不是我们签的，或记录被清理过
  if (!record) {
    throw new UnauthorizedException("refresh token 无效");
  }

  // ⑤ 已吊销的 token 又出现了：重放实锤，连坐
  if (record.revokedAt) {
    await this.prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new UnauthorizedException("检测到 token 重放，请重新登录");
  }

  // ⑥ 双保险：表里的死期
  if (record.expiresAt < new Date()) {
    throw new UnauthorizedException("refresh token 已过期，请重新登录");
  }

  // ⑦⑧ 轮换：作废旧的，签发一对新的
  return this.issueTokenPair(record.userId, tokenHash);
}
```

再给 `auth.controller.ts` 加路由，从请求头里把 token 摘出来：

```ts
import { Headers, HttpCode, Post, UnauthorizedException } from "@nestjs/common";

@Post("refresh")
@HttpCode(200)
refresh(@Headers("authorization") auth: string) {
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    throw new UnauthorizedException("缺少 refresh token");
  }
  return this.authService.refresh(token);
}
```

顺手把登出也写了。**登出的全部本质就是吊销**，删前端存储只是掩耳盗铃，服务端的记录不死，token 就还活着：

```ts
async logout(rawToken: string) {
  // updateMany：重复登出时第二次匹配不到行，也不报错
  await this.prisma.refreshToken.updateMany({
    where: { tokenHash: this.sha256(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
```

控制器加一个 `@Post("logout")`，同样从请求头取 token 调它，写法和 refresh 一样。

**第 4 步：跑通主链路。** 启动服务，先登录拿一对 token，再用 refreshToken 换新：

```bash
curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"jerry@example.com","password":"你的密码"}'

curl -s -X POST http://localhost:3000/auth/refresh \
  -H "Authorization: Bearer <登录返回的 refreshToken>"
```

第二次调用应该返回一对全新的 token。注意验证 access token 那条线也没断：拿新 accessToken 去调 `/users/me`，照常 200。

**第 5 步：亲眼看一次重放被拒。** 拿**第一次**的旧 refreshToken 再刷一次，预期 401「检测到 token 重放，请重新登录」。更有意思的是紧跟着拿第 4 步的新 refreshToken 再刷：也是 401。因为第 5 步的连坐把该用户的 token 全吊销了，新 token 横死。这不是 bug，是设计：服务端分不清真用户和贼，只能全部赶回登录页。用 curl 走完这三步，对轮换的理解比读十遍文章都深。

::: tip 测试技巧
等 access token 自然过期要 15 分钟，等不起。把 `ACCESS_TTL` 临时改成 `"30s"` 重启：先刷一次链路，睡一分钟，拿旧 accessToken 调 `/users/me` 吃个 401，再用 refreshToken 刷出新的、重试 `/users/me` 成功，这才是用户视角的完整体验。测完记得改回来。
:::

## 常见踩坑

**坑 1：把 refresh token 原文存进数据库。** 有人觉得存原文比对方便，还能「找回」发给用户的 token。问题是数据库一被拖，攻击者拿着全表 token 直接批量换 access，双 token 的安全设计当场清零。存 sha256 摘要，拖库拿到的只是一堆不可逆的哈希。这条和密码不能明文存储是同一条原理，别双标。

**坑 2：两种 token 不分家。** refresh token 也是用同一个 secret 签的合法 JWT，如果你的 `JwtAuthGuard` 只验签名不看别的，用户拿 7 天有效的 refresh token 直接就能调 `/users/me`，access 设成 15 分钟等于白设。本篇在 refresh 的 payload 里加了 `typ: "refresh"`，刷新接口会检查它；严谨起见，业务接口的 Guard 也应该把带 `typ` 的 token 挡掉，两头都设防。

**坑 3：轮换不用事务。** 吊销旧 token 和插入新 token 写成两条独立语句，第一条跑完服务崩了，用户手里旧 token 已作废、新 token 没发出去，直接被锁死在登录页。第 4 周 Day 4 练的 `prisma.$transaction` 正是为这种「两步必须同生共死」的场景准备的，`issueTokenPair` 里那对数组写法不是装饰。

**坑 4：检测到重放只回 401。** 「已吊销的 token 又来了」是系统里少数确凿的入侵信号，只回个 401 等于发现贼进门只把门关上。正确姿势是连坐：吊销该用户全部 refresh token，必要时记日志报警。宁可误伤真用户多登一次，不让可疑 token 多活一秒。

**坑 5：只有一条过期判断。** 有人问：JWT 里不是自带 `exp` 吗，表里的 `expiresAt` 是不是多余？不多余，两个检查在不同层面。JWT 层的验证靠签名和 `exp`，挡的是伪造和篡改，但被吊销的 token 签名依然合法，JWT 层看不出它死没死；表里的 `revokedAt` 和 `expiresAt` 才是它真正的户口本。反过来只查表也不行，没验签的 token 连「是谁签的」都存疑。先验签、再查库，一道都不能省。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. access token 设 15 分钟、refresh token 敢设 7 天，长短差异的依据是什么？

::: details 参考答案
依据是暴露面。access token 每个请求都带，跑在网络里，假设它迟早泄露，所以命短，把泄露窗口压到一刻钟。refresh token 只在刷新时发一次，平时不露面，暴露面小，所以敢长命。同时 refresh 有状态、可吊销，即使出事也能随时掐断，这是它敢长命的另一半底气。
:::

2. refresh token 存 httpOnly cookie 和客户端存储（localStorage 档）各冒什么风险？本教程为什么走 Authorization 头？

::: details 参考答案
httpOnly cookie：JS 读不到，XSS 偷不走，但浏览器自动带 cookie 引入 CSRF 风险，跨域配置也麻烦。客户端存储：存取方便、无 CSRF，但 XSS 一旦发生 token 就被偷走。一句话，cookie 把风险从 XSS 挪到 CSRF，localStorage 反过来。本教程选 Authorization 头是因为前后端分离加本地开发最简单、不自动带凭证所以无 CSRF，前提是认下 XSS 风险并做好防护（Day 6）；纯 Web 同域生产环境建议 httpOnly cookie，App 端本来就用安全存储加请求头。
:::

3. RefreshToken 表为什么存 sha256 摘要而不是原文？为什么吊销是填 `revokedAt` 而不是删记录？

::: details 参考答案
存摘要防拖库：数据库泄露时攻击者拿到的只是单向哈希，反推不出原 token，换不了 access；核对时拿用户传来的原文现场算一次哈希比对即可。不删记录是为了留案底：已吊销的 token 再次出现是重放的证据，记录删了，重放检测就成了无本之木。这行保留的「案底」就是黑名单的全部语义。
:::

4. 什么是 token 轮换？它防的是什么攻击？

::: details 参考答案
轮换指 refresh token 用一次即作废，每次刷新发一对全新 token。防的是重放：攻击者和真用户拿着同一个偷来的 token，谁先用谁拿走新一代，另一方再用旧 token 就会暴露「已吊销 token 复活」，服务端借此发现泄露并连坐吊销，把损失从「无声无息续命 7 天」压到「当场断链」。
:::

5. 登出时只删前端的 token 存储够不够？为什么？

::: details 参考答案
不够。删本地存储只是让「这一台设备」忘了 token，那个字符串本身还是合法 JWT，数据库记录也还活着，攻击者拿到照样能用。登出的本质是服务端吊销：把对应 refresh token 的 `revokedAt` 填上，续命链才算真正掐断。删前端存储只是顺手收个尾，不是安全边界。
:::

## 延伸阅读

- [Auth0：Refresh Token Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)，轮换 + 重放检测的完整方法论，本文连坐策略的工业级版本，值得一读
- [OWASP：Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)，会话生命周期的权威清单，token 有效期、吊销语义都能对号入座
- [RFC 6749 第 6 节：Refreshing an Access Token](https://datatracker.ietf.org/doc/html/rfc6749#section-6)，refresh token 概念的原始出处，OAuth 2.0 规范原文

今天的 RefreshToken 表和轮换逻辑留好。第 6 周学完 Redis 后会回来动它：把黑名单查询这层热数据从 PostgreSQL 迁到 Redis，再加缓存。Day 4 的 RBAC 角色权限，也直接盖在今天的认证底座上。
