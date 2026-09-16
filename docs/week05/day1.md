# 第 5 周 · Day 1：JWT 原理与签发——让服务器认出每个请求的主人

> 对应手册任务：学习「JWT 原理：Header/Payload/Signature、签名验证」，动手用 `@nestjs/jwt` 实现 `/auth/login` 返回 access token，当日产出「JWT 签发」。本篇只解决一个问题：阶段一的 CRUD 接口谁都能调，要让服务端在不存任何会话状态的前提下，靠一串带签名的 token 认出「这个请求是谁发的」。

## 今日目标

1. 说得清认证和授权的分界，以及 session 和 JWT 各自的适用场景
2. 掌握 JWT 三段结构：Header、Payload、Signature，明白签名防的是篡改、不是偷看
3. 独立跑通 `/auth/register` 和 `/auth/login`，拿到 access token，并在 jwt.io 上亲手解码、篡改、看验签翻脸

## 概念讲解：为什么需要 JWT

阶段一收官时，全链路已经通了：Next.js 调 NestJS，Prisma 读写 PostgreSQL。但接口是裸奔的——`GET /users` 谁都能调，`DELETE /users/1` 更是。加认证之前，先分清两个常被混用的词。

**认证（Authentication）回答「你是谁」。** 账号密码登录、token 验证，都是认证。**授权（Authorization）回答「你能做什么」。** 管理员能删别人的帖子、普通用户不能，这是授权。顺序永远是先认证后授权：不知道你是谁，谈你能做什么没有意义。今天只做认证，授权留给本周 Day 4 的 RBAC。

接下来才是真正的问题。HTTP 是无状态协议，每个请求都是独立的，服务端不记得上一个请求。用户在登录接口证明了一次自己是 Jerry，下一秒调 `/users` 时，服务端凭什么还认得他？

传统答案是 session：登录成功后服务端存一张表「session id → 用户」，响应里 `Set-Cookie` 发给浏览器；之后每次请求自动带 cookie，服务端查表认人。可靠，但状态在服务端手里：部署两个实例就得共享会话存储（通常是 Redis），不然用户请求落到第二台机器上就成了陌生人。

另一个答案是 JWT：登录成功后服务端用一把只有自己知道的密钥，签一串 token 发给客户端；之后每个请求带上这串 token，服务端用同一把密钥验签。用户身份写在 token 里，服务端什么都不用记。

两者怎么选，一张表说清：

| 维度 | Session | JWT |
| --- | --- | --- |
| 状态存放在哪 | 服务端（内存或 Redis） | 客户端，服务端只保管密钥 |
| 水平扩展 | 多实例要共享会话存储 | 天然无状态，任何实例都能验签 |
| 注销 | 服务端删记录，立刻生效 | 难，过期前 token 一直有效 |
| 传输成本 | cookie 只装一个短 id | 三段字符串，几百字节起步 |
| 典型场景 | 服务端渲染的传统网页 | 前后端分离、纯 API、跨服务 |

这个项目选 JWT，理由落在表里最后一行：Next.js 和 NestJS 分离部署，浏览器跨域调 API，cookie 那套处理起来别扭；后面 Agent 相关服务也打算复用同一套 token 验证。但别神化它，「注销难」是真实代价，Day 3 会专门还这笔债。

## 核心知识

### 1. JWT 三段结构：Header.Payload.Signature

先看实物。jwt.io 官网首页那个示例 token（你自己签出来的结构一模一样，只是字段不同）：

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

三个部分用两个点隔开，顺序是 Header、Payload、Signature，前两段是 base64url 编码，解开就是明文：

```json
// 第一段 Header 解码后：说明用什么算法签名
{ "alg": "HS256", "typ": "JWT" }

// 第二段 Payload 解码后：装的是「声明」
{ "sub": "1234567890", "name": "John Doe", "iat": 1516239022 }
```

HS256 是 HMAC-SHA256 的缩写。`sub` 是规范定义的标准声明，意思是「这个 token 属于谁」。第三段 Signature 是精髓，算法一行写完：

```text
Signature = HMAC-SHA256(
  base64url(Header) + "." + base64url(Payload),
  secret                    // 只有服务端知道
)
```

关键认识有三条。一，base64url 是编码不是加密，任何人拿到 token 都能解出头两段明文——所以 JWT 里绝不放密码。二，签名挡的是篡改：攻击者改了 Payload 里一个字母，却没有 secret，算不出配套的新签名；服务端重算一遍对不上，token 作废。三，服务端从头到尾不需要存这个 token，它只保管 secret，验证就是「用同一把密钥把签名重算一遍，看结果是否一致」。这就是「无状态」的全部含义。

### 2. exp 与 iat：token 的生死簿

签发时 @nestjs/jwt 会自动往 Payload 里写两个数字：`iat`（issued at，签发时刻）和 `exp`（expiration，过期时刻），都是 Unix 秒级时间戳。你不用手写，配置里给 `expiresIn: "2h"`，它算好 exp 塞进去；验证时发现当前时间超过 exp，直接抛 `TokenExpiredError`。

exp 也是 JWT 一切「后悔药难题」的根源：过期之前，token 在服务端眼里始终有效。用户点了注销、账号被封、密码改了，签出去的 token 照样好使。想立刻作废只有两条路：把有效期设得很短，或者服务端维护黑名单——后者等于把状态又存回了服务端。Day 3 用 refresh token 解这个矛盾。

### 3. bcrypt：密码绝不明文入库

登录要验密码，前提是密码得先存进数据库。明文存等于埋雷：数据库一拖库，所有用户的密码直接泄露。所以要存哈希：单向函数，原文进、乱码出，不可逆。

为什么不用 SHA-256？太快了。快对用户是好事，对暴力破解也是。bcrypt 专门为密码设计：自带随机盐（同一个密码每次哈希结果都不同），成本因子还能调节，让每次计算刻意变慢。

工程上还有个坑要提前说：npm 上叫 `bcrypt` 的包是原生模块，安装时走 node-gyp 现场编译，Windows 上没装 Visual Studio Build Tools 基本必翻车。`bcryptjs` 是纯 JavaScript 实现，零编译，API 几乎一致，学习项目直接用它。

## 动手任务：注册 + 登录拿 token，一步一步

手册任务：用 `@nestjs/jwt` 实现 `/auth/login` 返回 access token。前置条件：阶段一的全栈项目能跑，Prisma 已接入 NestJS。拆成 5 步，全程约 40 分钟。

**第 1 步：装依赖，给 User 补上 password 字段。** 在 `apps/api` 下执行：

```bash
npm install @nestjs/jwt bcryptjs
npm install -D @types/bcryptjs
```

第 4 周建 User 模型时还用不上密码，现在补一个字段（其他字段以你第 4 周的 schema 为准，关键是新增 `password`）：

```prisma
model User {
  id       Int    @id @default(autoincrement())
  email    String @unique
  name     String
  password String // 新增
  posts    Post[]
}
```

改完跑 `npx prisma migrate dev --name add-user-password`，迁移成功后库里就多了这一列。

**第 2 步：密钥进环境变量。** 在 `apps/api/.env` 里加两行：

```text
JWT_SECRET=dev-only-0f3c8a2e91b64d75a8c5e6f2
JWT_EXPIRES_IN=2h
```

第 3 周 Day 2 用 dotenv + zod 写的 config 模块现在派上用场：在 zod schema 里加 `JWT_SECRET: z.string().min(16)`，启动时缺变量或密钥太短直接报错拒启，问题在启动那一刻暴露，而不是在用户登录失败时。secret 是整个体系的根：它一泄露，任何人都能签出「合法」token 冒充任意用户。所以它永远不进代码、不进 git，去 `.gitignore` 确认有 `.env`。

**第 3 步：AuthModule 里注册 JwtModule。** 新建 `src/auth/auth.module.ts`：

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET"),
        signOptions: { expiresIn: config.get<string>("JWT_EXPIRES_IN", "2h") },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
```

关键在 `registerAsync` 而不是 `register`：secret 存在环境变量里，要等 ConfigService 就绪才能读到，`useFactory` 是个异步工厂，正好等配置好了再实例化（如果你第 3 周的 config 是自己封的模块，工厂里换成你自己的取值方式）。工厂产出两样东西：`secret` 供验签，`signOptions.expiresIn` 让每次签发自动写 exp——就是核心知识第 2 节说的那两个字段。

**第 4 步：注册接口，密码哈希入库。** 新建 `src/auth/auth.service.ts`（PrismaService 按你第 4 周的路径引入）：

```ts
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string) {
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) {
      throw new ConflictException("邮箱已被注册");
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: { email, name: email.split("@")[0], password: hash },
    });
    return { id: user.id, email: user.email };
  }
}
```

关键一行是 `bcrypt.hash(password, 10)`：第二个参数是成本因子，迭代 2^10 轮，耗时几十毫秒。这个「慢」是故意的，暴力试密码的成本跟着一起翻倍。返回值刻意只挑 id 和 email，password 哈希不往外发。

**第 5 步：登录接口，验密码、签 token。** 在 AuthService 里加 `login` 方法：

```ts
async login(email: string, password: string) {
  const user = await this.prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new UnauthorizedException("邮箱或密码错误");
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    throw new UnauthorizedException("邮箱或密码错误");
  }
  const accessToken = await this.jwt.signAsync({
    sub: user.id,
    email: user.email,
  });
  return { accessToken };
}
```

两处 throw 故意写成同一句话：如果「用户不存在」和「密码错误」返回不同文案，攻击者能用报错差异枚举出哪些邮箱注册过。再补控制器（DTO 写法是第 3 周 Day 6 的老朋友），并把 `AuthModule` 加进 AppModule 的 imports：

```ts
import { Body, Controller, Post } from "@nestjs/common";
import { IsEmail, IsString, MinLength } from "class-validator";

class AuthDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  register(@Body() dto: AuthDto) {
    return this.auth.register(dto.email, dto.password);
  }

  @Post("login")
  login(@Body() dto: AuthDto) {
    return this.auth.login(dto.email, dto.password);
  }
}
```

启动服务，用 curl 走一遍：

```bash
# 注册
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"jerry@example.com","password":"secret123"}'

# 登录，拿 token
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"jerry@example.com","password":"secret123"}'
```

登录成功会返回：

```json
{ "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiO..." }
```

这串 accessToken 就是当日产出「JWT 签发」。

::: tip 去 jwt.io 亲手验三段
打开 [jwt.io](https://jwt.io)，把 accessToken 粘进 Debugger，Encoded 框里三段自动分色，Decoded 区给出头两段明文，能看到 `sub`、`email`、`iat`、`exp`。做两个实验。实验一：把 Decoded 里的 email 改一个字母，底部立刻变成 Invalid Signature——你动了 Payload，又算不出新签名，篡改当场被抓。实验二：把下方 verify signature 框里的密钥换成你的 `JWT_SECRET`，状态变 Signature Verified——这正是服务端验签在做的事：用同一把密钥重算一遍。
:::

## 常见踩坑

**坑 1：把敏感信息塞进 Payload。** base64url 是编码，token 一贴进 jwt.io 谁都读得到明文。密码、手机号、API key 一律不放。JWT 的签名只保证「没被改过」，不保证「没人看得见」；要保密得用 JWE 加密，那是另一套东西。

**坑 2：secret 硬编码进代码，或者提交进了仓库。** 泄露的后果是灾难性的：攻击者能签发任意 sub 的合法 token，冒充任何用户，而且你很难察觉。开发放 .env（并确认 .gitignore 有它），生产用环境变量或配置中心注入，密钥定期轮换。

**坑 3：以为登出等于让 token 失效。** JWT 发出去就是泼出去的水。用户点「退出登录」，前端删掉 token 只是让浏览器忘了它，token 本身在 exp 之前依然能通过验证。短有效期 + refresh token、服务端黑名单，都是围绕这个缺陷的补救，Day 3 展开。

**坑 4：装了 bcrypt 而不是 bcryptjs。** `npm install bcrypt` 在 Windows 上大概率触发 node-gyp 编译报错，错误堆栈一屏放不下。bcryptjs 免编译，代价是哈希慢几倍——对一个每秒没有几千次登录的学习项目，这点差距毫无感觉。

**坑 5：往 Payload 里塞整个 user 对象。** token 是快照不是直播：用户改了昵称，已签发的 token 里还是旧数据，要等 exp 过期才更新；而且 Payload 越大，每个请求都多背几百字节的税。只放 sub 这类稳定标识，最新资料每次查库。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 认证和授权分别回答什么问题？401 和 403 状态码各对应哪个？

::: details 参考答案
认证回答「你是谁」，授权回答「你能做什么」。401 Unauthorized 这个名字有误导性，实际表示认证失败或缺失；403 Forbidden 表示认证通过了但权限不够。顺序上永远先认证后授权。
:::

2. JWT 三段各自装什么？签名挡得住篡改，挡得住偷看吗？

::: details 参考答案
Header 装签名算法（如 HS256），Payload 装声明（sub、iat、exp 及业务字段），Signature 是用 secret 对前两段算出的 HMAC。签名只防篡改：内容一改就对不上；不防偷看，前两段 base64url 解码即明文，敏感信息一律不放。
:::

3. 服务端不存任何已签发的 token，它凭什么相信一个请求携带的 token 是自己签的？

::: details 参考答案
HMAC 的性质：同样的输入加同样的 secret，永远得到同样的签名；不知道 secret 就造不出匹配的签名。服务端拿收到的 Header 和 Payload，用自己的 secret 重算一遍，与第三段比对，一致才放行。整个过程不需要查任何存储。
:::

4. 为什么 JWT 注销难？生产上有哪些补救手段？

::: details 参考答案
有效性只由 exp 决定，token 一旦签出，服务端没有「收回」这个动作。补救：短有效期 access token 配 refresh token（Day 3 的主题）；要立即封禁就维护黑名单，等于局部回到有状态；轮换 secret 能作废全部旧 token，但会误伤所有用户，属于最后手段。
:::

5. 同一个密码，bcrypt.hash 每次结果都不一样，登录时怎么验证？

::: details 参考答案
每次哈希都用随机盐，盐混在输出里，所以结果每次不同，用 `===` 直接比对必然失败。bcrypt.compare 会从哈希串里拆出盐，用同样的盐重算一遍再比对，返回布尔值。这也是为什么哈希只能比、不能「解」。
:::

## 延伸阅读

- [jwt.io](https://jwt.io)，官网 Debugger 是理解三段结构最直观的工具，把今天的 token 贴进去玩透
- [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519)，JWT 的规范原文，标准声明的定义都在这，挑 sub、exp、iat 几节读就有收获
- [NestJS 官方文档：Authentication](https://docs.nestjs.com/security/authentication)，官方认证章节，明天的 Guard 写法会紧贴它

今天的产出「JWT 签发」只算上半场：token 能发、能验，但业务接口还不认识它，`GET /users` 依然是裸的。明天写 `JwtAuthGuard` 和 `@CurrentUser()` 装饰器，让受保护的路由学会验 token、取用户，完整安排见[本周日程](/week05/)。
