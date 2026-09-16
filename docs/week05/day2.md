# 第 5 周 · Day 2：JWT 鉴权——用 Guard 和自定义装饰器锁住路由

> 对应手册任务：学习「JWT 鉴权：Guard + 自定义装饰器」，动手写 `JwtAuthGuard` 和 `@CurrentUser()` 装饰器，保护 `/users/me`，当日产出「受保护路由可用」。本篇只解决一个问题：昨天签发的 token 今天怎么用——让每个请求自己证明「我是谁」，证明逻辑只写一遍，而不是在每个接口里抄一遍。

## 今日目标

1. 说得清 Guard 在请求生命周期里的位置（middleware 之后、pipe 之前），以及 `canActivate` 返回 `false` 和抛 `UnauthorizedException` 的区别
2. 掌握三个技术点：从 `Authorization: Bearer xxx` 头里提取 token、用 `JwtService.verifyAsync` 校验、自定义 `@CurrentUser()` 参数装饰器
3. 独立完成 `JwtAuthGuard` + `@CurrentUser()`，让 `/users/me` 有三种表现：不带 token 返 401，带假 token 返 401，带真 token 返回当前用户

## 概念讲解：为什么需要 Guard

昨天写完了登录：用户提交邮箱密码，校验通过，服务端用 `JwtService.sign` 签发 token。今天用户带着 token 来请求 `/users/me`，服务端怎么知道「这个请求就是刚才那个用户发的」？

没有 Guard 时你有两条路。

第一条路，每个 handler 自己验一遍：

```ts
@Get('me')
getMe(@Headers('authorization') auth: string) {
  const token = auth?.split(' ')[1];
  if (!token) throw new UnauthorizedException();
  const payload = this.jwtService.verify(token);
  // ...按 payload 返回用户
}

@Get('orders')
getOrders(@Headers('authorization') auth: string) {
  const token = auth?.split(' ')[1];
  if (!token) throw new UnauthorizedException();
  const payload = this.jwtService.verify(token);
  // ...又是同一套
}
```

和第 1 周 Day 1 的 `getFirstString`、`getFirstNumber` 同一个病：代码一字不差，只有路由名在变。十个受保护路由就是十遍，哪天改提取逻辑要改十处，漏抄一个 `if (!token)` 就是一条裸奔的接口。

第二条路，把验证抽成 service 方法，在每个 handler 第一行调用：

```ts
@Get('me')
getMe(@Req() req: Request) {
  const user = this.authService.verifyRequest(req); // 每个接口都得记得调
  // ...
}
```

逻辑确实只写一遍了，但「记得调用」的责任落在每个人身上。新同事加接口忘了这行，路由照样裸奔，这种遗漏 code review 还不一定盯得出来。

两条路都不行：复制粘贴不可维护，靠人自觉不可靠。你真正想要的是：把「验票」固定在 handler 执行之前，由框架统一调用，handler 里只剩业务代码。

这就是 Guard 做的事。Guard 是 Nest 请求流水线上的固定环节，每个请求到达 handler 之前先过它，由它决定放行还是拒绝。可能有人会问：Express 的 middleware 不也能拦请求吗？能，但 middleware 不知道「这次要执行哪个 handler、上面标了什么装饰器」，Guard 知道，它拿到的 ExecutionContext 里有完整的路由元数据。后面写 `@Public()` 豁免时你会看到这个能力正是刚需，所以验票这件事就该归 Guard。

## 核心知识

本节的代码基于昨天的 auth 模块（`JwtModule` 已注册、登录接口能返回 token），可以直接抄进项目对照着跑，最终落地以动手任务为准。

### 1. Guard 的执行时机与 canActivate

先记整条流水线：

```
请求 → middleware → guard → interceptor（前半）→ pipe → handler
```

Guard 卡在 middleware 之后、pipe 之前。这个位置的含义：先确认「你是谁」，再校验「你带了什么数据」。一个没通过鉴权的请求，连 ValidationPipe 都不会触发，更轮不到 handler。顺序反了会怎样？未登录用户往接口塞一堆非法字段，先跑 pipe 的话他收到的是「字段格式不对」而不是「请先登录」，等于把校验规则泄露给未认证的人。

写 Guard 就是实现 `CanActivate` 接口：

```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return true; // 先无条件放行，感受一下挂载方式
  }
}
```

`canActivate` 返回 `true` 放行；返回 `false` 拒绝，框架回一个 403；抛 `UnauthorizedException` 则回 401。这里藏着 HTTP 语义的关键区分：

- 401：我不知道你是谁。没带 token、token 伪造、token 过期，都算这类
- 403：我知道你是谁，但你没资格。普通用户去敲管理员接口

有点绕的是 401 的英文名叫 Unauthorized，实际含义却是「未认证」；403 才是真正的「未授权」。所以身份校验失败要主动抛 `UnauthorizedException`，光 `return false` 前端只会收到 403，被当成「无权限」处理而不是「该跳登录页了」。

### 2. 提取 Bearer token 并校验

请求头长这样：`Authorization: Bearer eyJhbGciOiJIUzI1NiIs...`。Bearer 意为「持有者」：谁持有这个 token，谁就是声称的那个身份。完整的 Guard 实现：

```ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('缺少 token');
    }
    try {
      const payload = await this.jwtService.verifyAsync(token);
      request.user = payload; // 挂到 request 上，@CurrentUser() 从这里取
    } catch {
      throw new UnauthorizedException('token 无效或已过期');
    }
    return true;
  }

  private extractToken(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
```

三个关键点。第一，`context.switchToHttp().getRequest()` 是 Guard 里拿请求对象的标准姿势，ExecutionContext 屏蔽了底层是 Express 还是 Fastify，将来换框架这段不用动。第二，`verifyAsync` 会校验签名和有效期，过期抛 `TokenExpiredError`，签名不对抛 `JsonWebTokenError`，都是异常，所以用 `try/catch` 接住统一转成 401，别把原始错误直接漏给客户端。第三，校验通过后把 payload 挂到 `request.user`，这是社区约定俗成的位置，下一步的装饰器就从这里读。

### 3. @CurrentUser() 装饰器与 request.user 的类型

payload 挂上去了，handler 怎么优雅地取？最直接的是 `@Req()`：

```ts
@Get('me')
getMe(@Req() req: Request) {
  return req.user; // 能跑，但 handler 背上了整个 request
}
```

能跑，但不理想：handler 依赖了整个 request 对象，单测时得 mock 一大坨，拿到的 user 类型也不精确。Nest 的答案是自定义参数装饰器：

```ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest();
    return request.user;
  },
);
```

`createParamDecorator` 的回调能拿到 ExecutionContext，切换到 HTTP 上下文取出 request，把 `user` 摘出来。用法：

```ts
@Get('me')
@UseGuards(JwtAuthGuard)
getMe(@CurrentUser() user: JwtPayload) {
  return user; // 类型精确到 JwtPayload，不是 any
}
```

handler 从此只依赖「当前用户」这一个值，不知道 request 的存在，将来底层换 Fastify、上层加 GraphQL，只改装饰器一处。

还剩一个类型问题：`request.user = payload` 这行会报 TS2339，因为 Express 的 `Request` 类型里压根没有 `user` 属性。先定义 payload 接口（字段以你昨天 sign 时实际传入的为准）：

```ts
export interface JwtPayload {
  sub: number; // subject，即用户 id
  email: string;
}
```

再用模块扩充给 Request 补上这个字段：

```ts
// src/types/express.d.ts
import { JwtPayload } from '../auth/jwt-payload.interface';

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtPayload;
  }
}
```

注意扩充的是 `express-serve-static-core` 而不是 `express`：`@types/express` 的 `Request` 是从它导入再转出口的，直接对 `express` 做扩充经常不生效。这段 `declare module` 是第 1 周类型体操的回响：不改任何源码，从外部给已有类型「补形状」，补完之后全项目的 `request.user` 都有了类型。

### 4. 局部 @UseGuards vs 全局 APP_GUARD + @Public()

`@UseGuards(JwtAuthGuard)` 写在方法上保护单个路由，写在 `@Controller('users')` 上保护整个控制器，这是局部挂法，显式、一眼看得出谁受保护。路由少时够用。

但当全站九成接口都要登录时，逐个加装饰器就危险了：忘了加的那条直接裸奔。更稳的是全局注册：

```ts
// app.module.ts
providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
```

全局 Guard 对每条路由生效，包括登录注册，它们会被拦死，所以需要豁免机制：

```ts
// src/auth/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Guard 里加几行判断：

```ts
constructor(
  private readonly jwtService: JwtService,
  private readonly reflector: Reflector,
) {}

canActivate(context: ExecutionContext) {
  const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
    context.getHandler(), // 方法上的 @Public() 优先
    context.getClass(),   // 其次看 controller 级
  ]);
  if (isPublic) return true;
  // ...接着走原有验证
}
```

`SetMetadata` 往路由上贴标记，`Reflector` 在 Guard 里读标记，这正是概念讲解里说的「Guard 拿得到路由元数据」。两种挂法的取舍一句话：默认安全选全局加 `@Public()`，默认上锁、显式开锁，忘了配置的后果是「合法接口 401」，一测就发现；局部挂法忘了加的后果是「接口裸奔」，不出事没人知道。两种错误相比，永远让代码尽早报错更划算。今天的动手任务先用局部挂法，全局改造留作加分题。

## 动手任务：`JwtAuthGuard` + `@CurrentUser()` 一步一步

手册任务：写 `JwtAuthGuard` 和 `@CurrentUser()` 装饰器，保护 `/users/me`。拆成 6 步，全程约 30 分钟，前提是昨天的登录接口能正常返回 token。

**第 1 步：准备占位路由。** 在 users 模块的控制器里放一条没受保护的 `/users/me`，先让它能跑：

```ts
import { Controller, Get } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get('me')
  getMe() {
    return { id: 1, email: 'jerry@example.com' }; // 占位，最后一步替换
  }
}
```

用浏览器或 curl 先访问一次，确认路由通，再动手加锁。先有可用的底座再加保护，出问题时才分得清是哪层引入的。

**第 2 步：声明 payload 类型和 request.user。** 新建 `src/auth/jwt-payload.interface.ts` 和 `src/types/express.d.ts`，代码照抄核心知识第 3 小节。写完随便找个文件敲 `request.user`，IDE 能点出 `sub` 和 `email` 就说明扩充生效了。

**第 3 步：写 Guard。** 新建 `src/auth/jwt-auth.guard.ts`，把核心知识第 2 小节的完整实现抄进来。这一版先不接 Reflector，局部挂法用不到。

**第 4 步：写装饰器。** 新建 `src/auth/current-user.decorator.ts`，代码在核心知识第 3 小节，不到十行。

**第 5 步：挂锁替换占位。** 改造控制器：

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';

@Controller('users')
export class UsersController {
  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser() user: JwtPayload) {
    return user;
  }
}
```

**第 6 步：三种请求验收。** 启动项目，依次发三条：

```bash
# 1. 不带 token，期望 401
curl http://localhost:3000/users/me

# 2. 带编造的 token，期望 401
curl http://localhost:3000/users/me -H "Authorization: Bearer fake.fake.fake"

# 3. 先登录拿真 token，期望 200，返回 payload
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"jerry@example.com","password":"你的密码"}'

curl http://localhost:3000/users/me \
  -H "Authorization: Bearer <上一步返回的 accessToken>"
```

三条全部符合预期，当日产出「受保护路由可用」达成。

::: tip 验收不过怎么排查
第 3 条返 401：先检查 token 复制得完不完整、`Bearer` 和 token 之间只有一个空格；再核对昨天设置的过期时间，刚签发就过期也会 401。第 1、2 条返了 403：说明 Guard 里走了 `return false`，改成抛 `UnauthorizedException`。第 2 条居然 200：八成是 `verifyAsync` 忘了 `await`，见坑 2。
:::

## 常见踩坑

**坑 1：`return false` 得到的是 403，不是 401。** 身份校验失败时顺手写 `return false` 是最常见的错。前端拿到 403 会走「无权限」分支而不是「跳登录」分支，用户明明是 token 过期，界面却提示没有权限，排查一圈才发现是状态码语义用反了。身份问题抛 `UnauthorizedException`（401），权限问题才轮到 403，比如后面写角色控制时「普通用户访问管理员接口」。

**坑 2：`verifyAsync` 忘了 await。** `canActivate` 是 async 函数，`verifyAsync` 返回 Promise。忘了 `await`，`try/catch` 包住的只是一张欠条，校验失败不会进 catch，Guard 直接放行，等于没保护；更隐蔽的是 `request.user` 挂上去的是一个 Promise，handler 返回的数据也是乱的。自测办法：故意发一条假 token，看返回的是 401 还是 200。

**坑 3：`declare module 'express'` 扩充不生效。** `@types/express` 的 `Request` 是从 `express-serve-static-core` 导入再转出口的，直接扩充 `express` 时 TS 合并的是另一个声明，红线照旧。要扩充就扩充 `express-serve-static-core`。另外确认 d.ts 文件在 tsconfig 的 include 范围内，文件没进编译，扩充自然无效。

**坑 4：全局 Guard 把登录接口也拦死了。** 注册了 `APP_GUARD` 之后没给 auth 路由加 `@Public()`，登录接口自己都要求 token，用户永远登录不进去，自己把自己锁在门外。改造全局方案时，记得 `getAllAndOverride` 的查找数组要同时传 `getHandler()` 和 `getClass()`，`@Public()` 不管贴在方法上还是控制器上都能被读到。

**坑 5：`@CurrentUser()` 拿到的是签发时刻的快照。** payload 在 sign 那一刻定死，用户之后改了昵称、换了邮箱、被封号，老 token 里的信息不会跟着变，过期前一直「有效」。需要最新数据，就在 handler 里拿 `user.sub` 再查一次库。同一件事的另一面：别往 payload 里塞密码、手机号这类敏感字段，JWT 的 payload 只是 base64 编码，不是加密，把 token 贴到 jwt.io 任何人都能读出原文，能放进去的只有「足够识别身份」的最小字段集。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Guard 在请求生命周期的哪个环节执行？在 pipe 之前意味着什么？

::: details 参考答案
middleware 之后、interceptor 和 pipe 之前。意味着鉴权先于参数校验：未通过认证的请求不会触发 ValidationPipe、不会执行 handler，接口的校验规则也不会泄露给未认证的人。
:::

2. `canActivate` 里 `return false` 和抛 `UnauthorizedException` 分别返回什么状态码？各对应什么场景？

::: details 参考答案
`return false` 得 403，抛 `UnauthorizedException` 得 401。401 表示「未认证」，用于没带 token、token 伪造、token 过期；403 表示「未授权」，用于身份明确但权限不够。身份校验失败必须抛异常而不是 `return false`，否则前端会把「该登录」误判成「无权限」。
:::

3. `@CurrentUser()` 是怎么拿到用户数据的？它和 Guard 怎么配合？

::: details 参考答案
分两步：Guard 在验证通过后把 payload 写进 `request.user`；`@CurrentUser()` 是参数装饰器，在参数绑定阶段通过 `createParamDecorator` 的回调拿到 ExecutionContext，`switchToHttp().getRequest()` 取出 request，返回 `request.user`。Guard 负责写入，装饰器负责读出，handler 本身不碰 request。
:::

4. 局部 `@UseGuards` 和全局 `APP_GUARD` + `@Public()` 各适合什么场景？判断依据是什么？

::: details 参考答案
受保护路由占少数时用局部挂法，显式可读；绝大多数接口都要登录时用全局加 `@Public()`，默认上锁、显式开锁。判断依据是「忘了配置时哪种错误先暴露」：全局方案的失误表现为合法接口 401，一测就发现；局部方案的失误表现为接口裸奔，不出事没人知道，所以默认安全的方向永远更划算。
:::

5. 为什么 `request.user` 需要 `declare module`？为什么扩充的是 `express-serve-static-core`？

::: details 参考答案
Express 的 `Request` 类型里没有 `user` 属性，直接赋值会报 TS2339。模块扩充能在不改源码的前提下给已有接口合并新字段，这正是第 1 周类型体操的用武之地。而 `@types/express` 的 `Request` 是从 `express-serve-static-core` 导入再转出口的，对源头扩充，合并结果才能流到项目里每一处 `Request`。
:::

## 延伸阅读

- [NestJS 官方文档：Guards](https://docs.nestjs.com/guards)，本篇 `canActivate`、`APP_GUARD`、`Reflector` 的原始出处，生命周期时序图值得收藏
- [NestJS 官方文档：Custom Decorators](https://docs.nestjs.com/custom-decorators)，`createParamDecorator` 和 `SetMetadata` 的完整说明
- [NestJS 官方文档：Authentication](https://docs.nestjs.com/security/authentication)，官方 JWT 完整配方，本篇的 token 提取逻辑就出自这里
- 本系列第 1 周（[/week01/](/week01/)）的类型体操，`declare module` 的前置知识；本周 Day 1（[/week05/](/week05/)）的 token 签发，payload 字段的出处

今天的产出 `JwtAuthGuard` 和 `@CurrentUser()` 留好，后面写角色权限（RBAC）、给 Agent 平台的管理接口分层放行时，都是在这条 Guard 上继续叠判断，地基今天已经打好。
