# 第 5 周 · Day 5：OAuth2 与第三方登录——只借权限，不碰密码

> 对应手册任务：学习「OAuth2 概念 + 第三方登录流程」，动手画出 Google OAuth 登录时序图、理解 code exchange 流程，当日产出「OAuth 时序图」。本篇只解决一个问题：用户点了「用 Google 登录」，前提是 Google 的密码不能经过你的服务器。

## 今日目标

1. 说得清密码反模式错在哪，OAuth2 用什么思路替代它
2. 认得全四种角色，讲得清授权码模式的每一步
3. 独立画出 Google OAuth 时序图，箭头标清方向、序号、载荷，答得上为什么前端不能拿 code 换 token

## 概念讲解：为什么需要 OAuth2

自家账号体系齐了，但用户看注册页：又一个邮箱又一个密码，很多人转身就走。解法就是那颗按钮：用 Google 登录。

第一个念头很危险。2007 年前后真有网站弹框要用户的 Google 密码，替他去登一次，通了就算注册。这就是密码反模式：想借身份，却索要钥匙。

错在哪。一，拿到的远多于要的：只想知道用户是谁，拿到的却是全权钥匙。二，被迫保管明文密码：库被拖一次，赔的是别人家的门。三，无法单独收回：想撤销只能改密码，全部设备下线。四，没有边界：「只借七天」没得谈。

真正的需求是：不交密码，只给一份范围受限、可撤销、有期限的许可，就像代客泊车钥匙，能点火，打不开后备箱。OAuth2（RFC 6749，2012 年）就是把发这种钥匙标准化的协议。

## 核心知识

### 1. 四种角色：一场委托里的四方

| 角色 | 含义 | Google 登录场景里是谁 |
| --- | --- | --- |
| Resource Owner（资源所有者） | 数据的主人，有权给许可 | 用户本人 |
| Client（客户端） | 想借数据的应用 | 你的 NestJS 应用 |
| Authorization Server（授权服务器） | 认证用户、签发许可 | Google 的授权页 |
| Resource Server（资源服务器） | 存数据、认通行证 | Google 的 userinfo API |

授权服务器和资源服务器都是 Google，为什么拆开？职责不同，一个发证一个验票。这四张脸你都见过：自家体系里 `/auth/login` 签 token 是授权服务器，业务 API 验 token 是资源服务器，前端是客户端，用户是资源所有者。区别只在于：自家四个角色在一栋楼里；OAuth2 把楼拆成两栋，每步按公共规范走。

### 2. 授权码模式：完整时序

第三方登录最常用的是授权码模式（authorization code），五条生命线，箭头序号对应下方步骤：

```text
 用户/浏览器         你的后端            Google 授权服务器     Google 资源服务器
                  (NestJS)            (accounts.google.com)   (userinfo API)
    │                │                        │                    │
    │ ① 点「用 Google 登录」                  │                    │
    │───────────────>│                        │                    │
    │                │                        │                    │
    │ ② 302 跳授权页(client_id, redirect_uri, scope,              │
    │    state, code_challenge)               │                    │
    │<───────────────│                        │                    │
    │                │                        │                    │
    │ ③ 打开授权页，验证用户，展示同意页       │                    │
    │────────────────────────────────────────>│                    │
    │                │                        │                    │
    │ ④ 用户同意，302 回跳 redirect_uri       │                    │
    │    ?code=abc&state=xyz（一次性短时效）   │                    │
    │<────────────────────────────────────────│                    │
    │                │                        │                    │
    │ ⑤ GET /auth/google/callback?code&state  │                    │
    │───────────────>│  验 state 与 ② 一致     │                    │
    │                │                        │                    │
    │                │ ⑥ POST /token           │                    │
    │                │    code + client_id + client_secret         │
    │                │    + redirect_uri + code_verifier           │
    │                │───────────────────────>│                    │
    │                │                        │                    │
    │                │ ⑦ access_token + id_token                    │
    │                │<───────────────────────│                    │
    │                │                        │                    │
    │                │ ⑧ GET /userinfo，Bearer access_token        │
    │                │────────────────────────────────────────────>│
    │                │          sub / email / name                 │
    │                │<────────────────────────────────────────────│
    │                │                        │                    │
    │ ⑨ 查库建用户，签自家 JWT 给前端         │                    │
    │<───────────────│                        │                    │
```

文字版对照：

1. 用户点按钮，前端请求后端发起登录。
2. 后端回 302 跳授权页，URL 带 `client_id`、`redirect_uri`（须与注册一致）、`scope`、`state`（随机数防 CSRF），走 PKCE 还有 `code_challenge`。
3. 授权页上用户在 Google 认证，同意页写明申请的数据范围。
4. 用户同意，Google 生成一次性短时效的 code，302 回 redirect_uri。
5. 后端收到回调，先验 state。
6. 后端拿 code 加 `client_secret`（注册时发的密钥）换 access_token，secret 只在这一步出场。
7. Google 验过 code、secret、redirect_uri，发回 access_token，走 OIDC 还有 id_token。
8. 后端拿 access_token 调 userinfo，取到 sub（Google 侧用户唯一标识）、email、name。
9. 后端按 sub 查库建用户，再用 Day 1 的流程签自家 JWT 发给前端。

图上最该盯三道边界：Google 密码只在用户与 Google 之间（③），client_secret 只在后端与 Google 之间（⑥），access_token 只在服务端用（⑧）。

### 3. 为什么前端不能拿 code 直接换 token

code 反正回跳在浏览器 URL 上，为什么不让前端 JS 拿着它直接换 token？

因为换 token 要出示 client_secret，向 Google 证明「来的是那个注册过的应用」。前端没有保密能力：JS 打包文件谁都下载得到，secret 写进去等于贴在门上，所以换 token 必须挪到后端。

纯 SPA、手机 App 没有后端，天生是公开客户端，无 secret 可带。补丁叫 PKCE（RFC 7636，读 pixy）：发起登录时客户端生成随机串 code_verifier，把它的 SHA-256 哈希 code_challenge 随第 ② 步交给 Google；换 token 时出示明文 verifier，Google 现算哈希比对，对得上才发。截走 code 的人没有 verifier，照样换不出。secret 证明「我有一个只有我知道的东西」，PKCE 证明「我先前交过它的哈希」。OAuth 2.1 草案已把 PKCE 列为标配。

### 4. scope、OIDC，和你自家 JWT 的位置

scope 是借条上的限额。`scope=openid email profile` 意思是：只要身份标识、邮箱和基本资料。Google 把申请的 scope 逐条展示在同意页上，用户看得见才点得下。原则是最小权限。

再解一个常见误会：OAuth2 是授权协议，不是登录协议。它只回答「能不能拿数据」，没规定用户是谁，而第三方登录要的恰是后者。补这块的是 OIDC（OpenID Connect）：在 OAuth2 之上加一层认证，多申请 `openid` scope，token 端点多返回一个 id_token。id_token 是个 JWT，Google 用私钥签名，payload 里装着 sub。Day 1 学的验签逻辑在这里原样复用，只是签名方换成 Google。所以「Google 登录」准确说是 OIDC。

最后把三样东西摆在一起：

- 自家 JWT 体系：你既是授权服务器（签 token）又是资源服务器（验 token），一手包办。
- Google 第三方登录：认证外包给 Google，它的 token 只在后端用一次，发给用户的还是自家 JWT。
- 第 20 周统一认证，就是把这两套捏进同一个模块。

## 动手任务：画 Google OAuth 时序图，一步一步

今天不写代码，画得出才算真懂。全程约 20 分钟，纸笔、Excalidraw、draw.io 都行。

**第 1 步：备好要素清单。** 顶部一排参与者各一条生命线，今天五条：用户/浏览器、你的后端、Google 授权服务器、Google 资源服务器。每条箭头有方向、有序号、线上标数据（client_id、state、code、secret、token），哪个标不出来说明哪步没懂。

**第 2 步：凭记忆画第一稿。** 合上文章，照第 2 小节的九步文字版画。卡住的地方就是没懂的地方。

**第 3 步：标三道边界。** Google 密码的路径、client_secret 的路径、access_token 的路径，各用一种记号标出。这张图的价值不在流程，在边界。

**第 4 步：脱稿讲一遍。** 从点按钮讲到拿到自家 JWT，一分钟，不看图，重点讲清为什么绕两次。

**第 5 步：存档。** 拍照或导出，存进本周目录，这就是当日产出「OAuth 时序图」。

::: tip 对照用：标准时序十条
画完对着下面十条核对（第一稿务必先自己画）：

1. 用户/浏览器 → 你的后端（NestJS）：点「用 Google 登录」
2. 你的后端 → 浏览器：302 跳授权页（client_id, scope, state, code_challenge）
3. 浏览器 → Google 授权服务器：打开授权页，用户验证并同意
4. 授权服务器 → 浏览器：同意，302 回跳带 code
5. 浏览器 → 你的后端：GET /auth/google/callback?code=abc&state=xyz
6. 你的后端 → 授权服务器：POST /token（code + client_secret + code_verifier）
7. 授权服务器 → 你的后端：access_token + id_token
8. 你的后端 → Google 资源服务器：GET /userinfo（Bearer access_token）
9. 资源服务器 → 你的后端：sub / email / name
10. 你的后端 → 浏览器：查库建用户，签发自家 JWT
:::

## 常见踩坑

**坑 1：把 OAuth2 当登录协议。** 它只定义授权，授权页上的登录是 Google 自己的事，做「用登录」要靠 OIDC。连带一个错法：拿到 access_token 就当会话凭证发给前端。钥匙不是身份证。

**坑 2：redirect_uri 想当然地填。** 必须事先在 Google 后台注册，请求时一字不差，localhost 和 127.0.0.1 是两个地址，本地开发常翻车在这。它决定 code 送到哪。

**坑 3：state 当摆设。** 回调必须核对 state 与发出的一致。不核对的风险叫登录 CSRF：攻击者把自己的 code 塞给你的 callback，受害者被登进攻击者的账号。一个随机数对一次账，成本趋近零。

**坑 4：id_token 和 access_token 分不清。** id_token 给客户端看，用来确认用户是谁（验签读 sub）；access_token 给资源服务器看，用来调 userinfo。拿 id_token 调接口、从 access_token 抠身份，都是拿错钥匙开错门。

**坑 5：拿到 email 就敢关联老账号。** 先看 email_verified 是否为 true，再想并号策略。若见邮箱就并，攻击者可用不验证邮箱的提供者伪造邮箱登进受害者账号。第 20 周专门处理。

## 自测问题

先自己答，再展开对照，答不上来的回对应小节看一遍。

1. 密码反模式的要害是什么？OAuth2 用什么思路取代了它？

::: details 参考答案
要害：为借身份交出全权凭证，不能限额、不能单独撤销，还得替人保管明文。取代思路是委托授权：密码不出门，换发一张范围受限、有期限、可撤销的通行证。
:::

2. 四种角色在 Google 登录场景里分别是谁？在你自家 JWT 体系里呢？

::: details 参考答案
Google 场景：用户、你的应用、Google 授权页、userinfo API。自家：用户是资源所有者，前端是客户端，/auth/login 是授权服务器，业务 API 是资源服务器。
:::

3. 为什么先发 code 再换 token，而不是让 Google 直接把 token 放在回跳 URL 里？

::: details 参考答案
直接回跳 token，长命凭证暴露在 URL、历史记录和 Referrer 里。两段式让浏览器只经手一次性短时效的 code，token 在后端与 Google 间直接交付，兑换时还同时验 client_secret 和 redirect_uri。公开客户端没有 secret，由 PKCE 补上。
:::

4. PKCE 靠什么让截走 code 的人换不出 token？

::: details 参考答案
发起时已把 code_verifier 的哈希交给 Google，兑换须出示明文 verifier 现算比对。截走 code 的人拿不到 verifier，哈希推不回原串，兑换被拒。本质是用先前承诺的随机数替代保密的 secret。
:::

5. OAuth2 和 OIDC 是什么关系？id_token 你怎么敢信？

::: details 参考答案
OAuth2 只管授权，OIDC 是其上的认证层：多申请 openid scope，多返回一个 id_token。id_token 是 Google 私钥签名的 JWT，sub 标识用户。用 Google 公布的公钥验签，校验 iss、aud、exp，全过才采信。
:::

## 延伸阅读

- [Google 官方：Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)，今天时序的权威版本
- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)，规范原文，四种角色与授权码模式的出处
- [openid.net/connect](https://openid.net/connect/)，OIDC 官网，讲它和 OAuth2 的分工

今天的时序图收好，第 20 周统一认证时它就是施工图。明天讲 Web 安全，CSRF 和今天的 state 参数是一家人，完整安排见[本周日程](/week05/)。
