# 第 5 周 · Day 7：周复盘方法论，把六天的认证知识串成一条会跑的链路

> 手册任务：周复盘 + 整理。用 Postman 跑一遍完整认证流程，写 300 字周记，当日产出：认证流程记录 + 周记。
> 本篇解决的问题只有一个：login、Guard、refresh、RBAC 这几块各自都验证过，串成一条完整链路还通不通，每一步你能不能在发请求之前就说出结果。

## 今日目标

1. 在 Postman 里搭出带环境变量的认证集合，跑通登录、鉴权、401、刷新、403 共七个场景，每步先写预期再验证
2. 不看教程画出认证链路架构图，三块参与者加 token 流动
3. 写四段 300 字周记，过一遍 10 题自检，答不上的回读对应 Day 的教程

## 概念讲解：链路型知识，复盘要换武器

[第 1 周 Day 7](/week01/)讲过复盘的底层逻辑：识别不等于提取，检验标准是合上资料能不能复述、能不能重做。逻辑这周照用，武器要换，因为知识形态变了。

第 1 周的 monorepo 是静态结构，节点和边不动，一张图装得下。本周的认证是动态链路：同一个 `/users/me`，不带 token 返 401，带过期或伪造的 token 也返 401，角色不够返 403，token 对了才 200。图画得出谁连着谁，画不出哪个请求走到哪条分支。检验标准于是升级成一句话：**发请求之前，先说出预期**。说得出来，说明链路在脑中是连着的；说不出来，只是教程里见过，那还叫识别。

工具选 Postman，理由很实际：前六天用 curl 测，每次手动复制 token，改一个字符全部重来。环境变量加两行脚本，就能把「登录自动存 token、后续请求引用 token」固化下来。你等于亲手搭了个最小前端，它怎么带 token，以后 Next.js 就怎么带。

| 输出方式 | 逼出什么 | 对应今天的产出 |
| --- | --- | --- |
| 跑通 | 链路和分支是否成形 | 认证流程记录 |
| 画图 | 结构是否清晰 | 认证链路架构图 |
| 写作 | 概念是否消化 | 300 字周记 |
| 自测 | 细节是否记牢 | 10 题自检清单 |

::: tip 这套流程每周只换内容
第 1 周画结构，这周跑链路，方法不变：输出倒逼输入。架构图和 Postman 集合都留好，第 6 周学完 Redis，黑名单查询从 PostgreSQL 迁走后，这条链路还要再跑一遍。
:::

## 核心知识

### 1. Postman 全流程指引

准备两件事：api 和 PostgreSQL 起着；`ACCESS_TTL` 临时改成 `30s`（Day 3 的测试技巧），演过期场景不用干等一刻钟，测完全部改回来。

先建环境 week05，加三个变量：`baseUrl` 填 `http://localhost:3000`，`accessToken` 和 `refreshToken` 留空。再建集合 week05-auth，七个场景逐个来。

**场景 1：登录，token 自动进变量。** `POST {{baseUrl}}/auth/login`，Body 选 raw、JSON：

```json
{ "email": "jerry@example.com", "password": "你的密码" }
```

预期：200，响应体里有 `accessToken` 和 `refreshToken` 两个字段（Day 3 的双 token 结构）。再在这个请求的 Scripts（旧版叫 Tests）页签加两行：

```js
const data = pm.response.json();
pm.environment.set("accessToken", data.accessToken);
pm.environment.set("refreshToken", data.refreshToken);
```

发完去环境面板确认，两个变量该有值了。

**场景 2：带 token 访问受保护路由。** `GET {{baseUrl}}/users/me`，Headers 加一条 Authorization，值写 `Bearer {{accessToken}}`。预期：200，返回 `sub` 和 `email`，这就是 Day 2 里 `@CurrentUser()` 交给 handler 的东西。

**场景 3：伪造 token，吃 401。** Authorization 的值改成 `Bearer fake.fake.fake`。预期：401，走验签失败的分支。改回变量再发，应恢复 200。

**场景 4：过期 token，吃 401。** TTL 是 30s，等一分钟再访问 `/users/me`。预期：401，这次走 exp 过期的分支。伪造和过期内部抛的异常不同（`JsonWebTokenError` 和 `TokenExpiredError`），都被 Guard 的 try/catch 统一转成 401。

**场景 5：refresh 换新。** `POST {{baseUrl}}/auth/refresh`，Authorization 写 `Bearer {{refreshToken}}`，场景 1 那两行脚本照贴。预期：200，返回全新一对 token，环境变量同步更新，旧 refreshToken 从此作废。拿新 accessToken 重访 `/users/me`，预期 200：这就是用户视角的无感续命。

**场景 6：重放被拒。** 场景 5 发送前先把旧 refreshToken 复制留底，刷完把 Authorization 换成这份旧值再发一次。预期：401，检测到 token 重放。紧接着拿场景 5 的新 refresh 再试，同样是 401：连坐把该用户的整条续命链吊销了。Day 3 的设计，亲眼看一次比读十遍深。

**场景 7：角色不够，吃 403。** 用 user 角色的账号登录（Day 4 定义了 admin 和 user 两种角色），带它的 accessToken 访问你挂了 `@Roles('admin')` 的路由，具体路径以你的实现为准。预期：403，不是 401：验签已通过、身份明确，是 RolesGuard 发现角色不够拦下的。用户登着，只是没资格。

**收口。** 集合菜单里 Export 导出 JSON，配一张「每步预期对实际」的记录（截图或表格），合起来就是当日产出「认证流程记录」。

### 2. 认证链路架构图要素

工具还是 Excalidraw，第 1 周 Day 7 用过的那个，手绘风，10 分钟画完，别做成美术品。文字版清单：

```text
节点（3 块，方框表示）：
  ① 客户端 client：浏览器 / Postman / 以后的 Next.js
  ② API 服务 api：NestJS，业务路由 + Guard 流水线
  ③ 认证服务 auth：/auth/login、/auth/refresh，连着 RefreshToken 表
  （学习项目里 ②③ 同一个进程，图上照样分开画，职责不同）

边（token 流动，箭头标注内容与寿命）：
  client → auth：POST /auth/login，email + password
  auth → client：accessToken（15m）+ refreshToken（7d）
  client → api：业务请求 + Authorization: Bearer <accessToken>
  access 过期后 client → auth：POST /auth/refresh + Bearer <refreshToken>
  auth → client：全新一对 token，旧的作废
  auth ↔ PostgreSQL：按 sha256 摘要写入与核对

内部标注（2 处，写在方框里）：
  api：Guard 验签（secret 重算）→ request.user → handler
  auth：验签 → 查 RefreshToken 表 → 轮换（吊销旧 + 签发新，一个事务）
```

三个层次记牢：**块是参与者，边是 token 流动，标注是内部工序**。少了边上的寿命标注，看图的人答不出哪个 token 活多久；少了内部标注，Guard 站在哪一层就看不出来。检验标准：看图的人 30 秒内能答出 access token 从哪来、往哪送、死在哪。

### 3. 300 字周记模板

四段结构和第 1 周一样：最大收获、卡得最久、还含糊、下周前补。规则不变，禁止抄教程原句，第三段最值钱。第 5 周示例，照这个密度写：

```text
① 本周最大收获：认证和授权是两个问题，你是谁、你能做什么，401 和
403 各管一问。JWT 无状态是优点也是笔债，双 token 把债还了：短的每个
请求都抛头露面所以命短，长的躺在库里随时能被吊销。RBAC 只是 Guard 后
面再问一句角色。
② 卡得最久：/users/me 返回的数据一直不对劲，查了半小时，最后发现
Guard 里 verifyAsync 忘了 await，挂上 request.user 的是个 Promise；更
吓人的是假 token 也返回 200，等于没保护。
③ 还含糊：OAuth2 只画了时序图，code 换 token 没亲手写过；PKCE 只知道
是防 code 被截的；CSP 的具体策略背不下来。
④ 下周前补：用 admin 账号把 Postman 里 403 那步跑成 200；OAuth 时序
图脱稿重画一次。
```

300 字是刻意限制，逼你从一堆收获里挑出配得上「最大」的那个。

### 4. 第 5 周知识自检清单

规则同第 1 周：每题先口头回答，说完整了再点开对照，说不出的记下题号。

**问题 1：JWT 的三段各装什么？签名起的是什么作用？（Day 1）**

::: details 答案
Header 装签名算法（如 HS256），Payload 装声明（sub、iat、exp 及业务字段），Signature 是用 secret 对前两段算出的 HMAC。签名防篡改：内容一改，配不出对应的新签名，服务端重算对不上就拒收。它不防偷看，前两段 base64url 解码即明文。
:::

**问题 2：密码能放进 JWT 的 payload 吗？为什么？（Day 1）**

::: details 答案
不能。base64url 是编码不是加密，token 贴进 jwt.io 谁都读得到明文。签名只保证没被改过，不保证没人看得见。payload 只放识别身份的最小字段（sub、email），真要保密得用 JWE 加密，那是另一套东西。
:::

**问题 3：access token 定 15 分钟、refresh token 敢定 7 天，长短的依据是什么？（Day 3）**

::: details 答案
依据是暴露面。access 每个请求都带、跑在网络里，假设它迟早泄露，命短才压得住泄露窗口；refresh 只在刷新时发一次，平时不露面，暴露面小所以敢长命。加上 refresh 有状态、存库、随时可吊销，出事能掐断，这是它敢长命的另一半底气。
:::

**问题 4：Guard 和 Pipe 谁先执行？这个顺序意味着什么？（Day 2）**

::: details 答案
流水线是 middleware → guard → interceptor → pipe → handler，Guard 在 pipe 之前。意味着先确认「你是谁」，再校验「你带了什么数据」：未通过认证的请求不会触发 ValidationPipe，接口的字段校验规则不会泄露给未认证的人。
:::

**问题 5：@CurrentUser() 是怎么拿到当前用户的？（Day 2）**

::: details 答案
分两步。Guard 验签通过后把 payload 挂到 request.user；@CurrentUser() 是 createParamDecorator 造的参数装饰器，回调里经 ExecutionContext 切到 HTTP 上下文取出 request，返回 request.user。Guard 负责写入，装饰器负责读出，handler 本身不碰 request。
:::

**问题 6：RBAC 里 401 和 403 各在什么时刻出现？（Day 4）**

::: details 答案
401 是未认证：没带 token、token 伪造或过期，服务端不知道你是谁。403 是未授权：验签通过、身份明确，但角色不够，比如 user 访问 @Roles('admin') 的路由被 RolesGuard 拦下。前端拿 401 跳登录页，拿 403 提示无权限，两个语义不能混。
:::

**问题 7：OAuth2 授权码模式为什么要用 code 中转，不直接把 token 发给前端？（Day 5）**

::: details 答案
浏览器侧是不安全环境，token 和 client_secret 都不能出现在前端。授权码模式让授权服务器先发一个短期、一次性的 code 给前端，前端转交自己的后端，后端再拿 code 加 client_secret 走后端信道换 token。token 全程不经过浏览器；code 就算被截获，一次性、短命、还得配 secret 才能换，损失窗口小得多。
:::

**问题 8：SameSite 防住 CSRF 的原理是什么？（Day 6）**

::: details 答案
CSRF 能成立，靠的是浏览器对跨站请求也自动附带 cookie。SameSite 给 cookie 加了发送范围限制：标了 Strict 或 Lax 之后，跨站请求不再自动携带该 cookie，伪造的请求失去了「自动附带的凭证」，到服务端就是个未登录请求，攻击链条断掉。Lax 放行顶级导航的 GET，是现在的浏览器默认档。
:::

**问题 9：Helmet 做了什么？它动你的业务代码吗？（Day 6）**

::: details 答案
一组安全响应头中间件：X-Frame-Options 防点击劫持、Strict-Transport-Security 强制 HTTPS、X-Content-Type-Options 防 MIME 嗅探、Content-Security-Policy 限制资源加载来源等。它不改任何业务代码，靠响应头指挥浏览器启用安全行为，注册一次全站生效。
:::

**问题 10：CORS 配置里 origin: '*' 和 credentials: true 为什么不能同时开？（Day 6）**

::: details 答案
`*` 表示任意源都能读响应；credentials 模式下浏览器会自动带 cookie 等凭证。两个一起开，等于任何恶意页面都能借用户的浏览器带着登录态访问接口并读回响应。所以规范直接规定：凭证模式下 Access-Control-Allow-Origin 不允许是 `*`，浏览器会拒收。正确做法是维护 Origin 白名单，命中后回显具体来源，再显式开 credentials。
:::

::: tip 10 题全对也别飘
全对说明第 5 周及格。流程、图、周记、git 四件事做完，本周才算收口。
:::

## 动手任务：完成本周复盘

五步，预计 60 到 90 分钟。

**第一步：跑 Postman 全流程（30 分钟）。** 照核心知识第 1 节搭好环境和集合，七个场景逐个过，每个请求发出前先写下预期（状态码加关键字段），再点 Send 对照。对不上的当场回读对应 Day，那就是本周的认知漏洞。

**第二步：画认证链路架构图（20 分钟）。** 关掉教程，凭记忆对照文字清单画，卡住翻 Day 1 到 Day 3 的教程确认，合上继续，对着抄没有复盘效果。导出 PNG 命名 `week05-auth-flow.png`，`.excalidraw` 源文件一并存档。

**第三步：写 300 字周记（15 分钟）。** 四段模板，对照示例的密度，「还含糊」那段别敷衍，它是下周的输入。

**第四步：做自检清单（15 分钟）。** 10 题口头过完，答不上的记下题号和对应 Day，回读该教程的对应小节。

**第五步：git 收口（10 分钟）。** 未提交的内容按类型分开：认证代码一个提交，Helmet 和 CORS 配置一个，Postman 集合加周记一个文档提交。最后打标签：

```bash
git tag week05-done
```

原则照旧：一个提交只做一件事。

## 常见踩坑

**环境变量是旧的。** 改了 TTL 重启服务、或中途换了账号，变量里躺的还是老 token，于是明明刚登录却 401。排查 401 时第一步先点开环境面板看变量的当前值，再查别的。

**预期写成「应该能通」。** 能通不是预期，状态码加关键字段才是。预期不具体，跑完只是又看了一遍绿灯，识别冒充了提取。

**401 和 403 排查方向搞反。** 收到 403 却去查 token 新旧，方向反了。401 查身份三件事：带没带、全不全、过没过期；403 查账号角色和路由上的 @Roles()。

**复盘变成重读教程。** 六篇教程又刷一遍，眼睛过了手没动。判断标准不变：合上资料，流程跑得出、图画得出、题答得出。

## 延伸阅读

- [Postman 官方文档：Scripting](https://learning.postman.com/docs/writing-scripts/intro-to-scripts/)，本篇那两行脚本和环境变量的官方说明
- [jwt.io](https://jwt.io)，第 1 题答不上就把 token 贴回去玩一遍，三段结构立刻直观
- [OWASP：Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)，token 有效期、存储方案的权威清单
- [第 1 周 Day 7](/week01/)，复盘方法论的原始出处；[本周日程](/week05/)，六天内容的总目录

第 6 周开学前，把周记第四段的补课动作清掉。RefreshToken 表和 Postman 集合都留好：学完 Redis，黑名单查询要从 PostgreSQL 迁过去，这条链路还要再跑。第 5 周到此收口。
