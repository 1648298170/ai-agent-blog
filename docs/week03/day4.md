# 第 3 周 · Day 4：NestJS 控制器——路由、参数装饰器与 DTO

> 对应手册任务：学习「NestJS Controller：路由、参数装饰器、DTO」，动手实现 `/users` 的 GET/POST/PUT/DELETE，用 DTO 定义请求体，当日产出完整 CRUD 控制器。本篇只解决一个问题：昨天那条只会返回固定 JSON 的 HealthController，怎么长成一个能从请求的四个部位取参数、能约束请求体形状、能报对状态码的控制器。

## 今日目标

1. 说得清 `@Param`、`@Query`、`@Body`、`@Headers` 分别从请求的哪个部位取值，以及为什么尽量不用 `@Req()`
2. 掌握三个写法点：`@Controller` 前缀加 HTTP 方法装饰器组成路由表、DTO 用类而不是 interface、`@HttpCode` 显式控制状态码
3. 独立实现 `/users` 的四个端点，用 curl 逐个打通，并亲眼看到一次 201 和一次 404

## 概念讲解：路由为什么交给装饰器

昨天的 HealthController 长这样：

```ts
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
```

一条固定路由，不收任何参数，返回值永远一样。它能跑通，说明你已经尝到 Nest 的基本魔法：没写一行「监听端口、匹配路径」的代码，请求自己就走到了 `check()` 里。今天要做的 `/users` 复杂得多：同一个路径前缀下要分列表、详情、新建、更新、删除五种操作；参数有的藏在路径里（`/users/3`），有的藏在查询串里（`/users?keyword=je`），有的藏在请求体里（`{"name":"Ann"}`），还有的藏在请求头里（`Authorization: Bearer xxx`）。

用原生思路硬写，你会得到一个巨型函数：先判断 method，再切路径抠出 id，再解析查询串，再 JSON.parse 请求体，最后手拼状态码和响应体。每一步都是字符串活，类型系统全程帮不上忙，路由逻辑和业务逻辑搅成一锅粥。

Nest 的解法是把「谁处理什么」声明成装饰器元数据。应用启动时框架扫描所有控制器，把「方法 + 路径 → 处理函数」登记成路由表；请求进来由框架匹配分发，你只在函数签名里声明「我要请求的哪一块」，对应的装饰器负责把那一块取出来递到你手上。

这还不够。`@Body()` 收到的本质是一段任意 JSON，不约束它就等于裸奔。约束请求体形状的东西就是 DTO，而 DTO 必须是 class：interface 编译后会被完整擦掉，Nest 在运行时拿不到它的任何信息；class 编译后是真实存在的构造函数，class-transformer 才能围绕它干活，后天的参数校验也全靠它。第 1 周我们在 shared 包里用 `ApiResponse<T>` 约定过「响应长什么样」，DTO 就是同一份契约在请求方向上的对应物：前端按 DTO 发，后端按 DTO 收。

## 核心知识

本节的代码块都是独立片段，可以对照着读，最终完整代码以下面的动手任务为准。

### 1. 参数装饰器全家桶

```ts
import { Controller, Get, Post, Param, Query, Body, Headers } from '@nestjs/common';

@Controller('users') // 类内所有路由共享 /users 前缀
export class DemoController {
  @Get(':id')
  findOne(@Param('id') id: string) {}            // GET /users/3 → '3'

  @Get()
  findAll(@Query('keyword') keyword?: string) {} // GET /users?keyword=je → 'je'

  @Post()
  create(@Body() body: unknown) {}               // POST /users 的请求体整体

  @Get('profile')
  whoAmI(@Headers('authorization') auth?: string) {} // 请求头里那一行
}
```

四个装饰器对应请求的四个部位：`@Param` 取路径里的动态段，`@Query` 取问号后面的键值对，`@Body` 取请求体整体，`@Headers` 取请求头字段。两个细节先记住：路径参数和查询参数到手时一律是字符串（HTTP 本来就是文本协议），`page` 要参与计算得先 `Number(page)`；`@Body()` 不带参数时拿整个请求体，这才是 DTO 的正确用法，`@Body('name')` 这种只取单字段的写法偶尔有用，不成气候。

然后是 `@Req()`。它能把整个底层请求对象塞给你：

```ts
import { Req } from '@nestjs/common';
import type { Request } from 'express';

whoAmI(@Req() req: Request) {
  const auth = req.headers.authorization;
  const ip = req.ip;
}
```

看着万能，代价有三处。第一，类型直接绑定 Express，哪天换 Fastify 适配器（Nest 官方支持）就得改代码。第二，单元测试要凭空 mock 一个巨大的 req 对象。第三，它绕过了专用装饰器「在签名处一眼看得见取了什么」的声明式好处。原则：有专用装饰器就用专用的，只有 cookies 这类框架没给专用装饰器的东西，才请 `@Req()` 出场救急。

### 2. DTO：是类，不是 interface

```ts
// ✅ class：编译后依然存在，运行时摸得到
export class CreateUserDto {
  name: string;
  email: string;
}

// ❌ interface：编译时被完整擦除，运行时无影无踪
export interface CreateUserShape {
  name: string;
  email: string;
}
```

第 1 周 Day 1 讲过泛型擦除，interface 是同一条原理：它是纯编译期的概念，tsc 的输出里找不到它。class 不一样，编译后是真实的构造函数。这个差别平时无所谓，在 Nest 里是生死线：ValidationPipe（后天 Day 6 登场）底层用 class-transformer 把请求体转换成 DTO 实例再逐字段校验，喂给它一个 interface，它在运行时什么都拿不到，校验直接静默失效。

所以在控制器里这样用：

```ts
@Post()
create(@Body() dto: CreateUserDto) {
  // dto 点得出 name、email，拼错字段名编译期就红线
}
```

还有一个容易忽略的设计点：`CreateUserDto` 里没有 `id`。id 由服务端分配，客户端说了不算。DTO 描述的是「请求应该长什么样」，不是「存储的记录长什么样」，这两件事从明天开始会分得越来越开。

### 3. 状态码：@HttpCode 与 PUT/PATCH 语义

Nest 有条默认规则：POST 响应 201 Created，其余方法响应 200 OK。POST 特殊不是偏心，201 的语义是「新资源创建成功」，正是 POST 该干的事。想偏离默认，用 `@HttpCode` 显式声明：

```ts
import { HttpCode, HttpStatus } from '@nestjs/common';

@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT) // 204：删完了，没有内容可回
remove() {}

@Post('send-code')
@HttpCode(HttpStatus.OK) // 少数场景：POST 不创建资源，比如发送验证码
send() {}
```

`HttpStatus` 是 `@nestjs/common` 导出的枚举，`HttpStatus.CREATED` 就是 201，比裸写数字可读。204 特别一点：语义上不允许带响应体，端点直接返回 `void`，别在 204 里塞 JSON。

404 不要自己拼响应，抛 Nest 内置异常：

```ts
import { NotFoundException } from '@nestjs/common';

if (!user) {
  throw new NotFoundException(`用户 ${id} 不存在`);
}
```

框架接住异常，自动回 404 和一段标准 JSON 错误体。为什么抛异常而不是返回 `null`？返回 null 响应码还是 200，调用方只能靠猜；异常让状态码说真话，这是 REST 的基本功。

最后是 PUT 和 PATCH 的语义分家：PUT 是全量替换，客户端必须送完整资源，缺的字段等于「明确要清空」；PATCH 是部分更新，只送变化的字段。改一个邮箱，PATCH 带 `{"email":"..."}` 就够了，PUT 就得把 name 也原样带上，漏带就被覆盖掉。两者都要求幂等：同一份请求发一次和发十次，服务端最终状态应当一致。今天手册要求 PUT，就按全量替换实现，加分题会补一个 PATCH。

## 动手任务：`/users` 完整 CRUD 一步一步

手册任务：实现 `/users` 的 GET/POST/PUT/DELETE，用 DTO 定义请求体。拆成 5 步，全程约 30 分钟。数据先存模块级内存数组，第 4 周换 Prisma，今天不碰数据库。

**第 1 步：建文件。** 在 `apps/api/src` 下建 `users` 目录（用 `npx nest g controller users` 生成也行，会多送一个测试文件）。目标结构：

```txt
apps/api/src/users/
├── users.controller.ts
└── dto/
    ├── create-user.dto.ts
    └── update-user.dto.ts
```

先写两个 DTO，记住是 class：

```ts
// dto/create-user.dto.ts
export class CreateUserDto {
  name: string;
  email: string;
}
```

```ts
// dto/update-user.dto.ts（加分题的 PATCH 会用，所有字段可选）
export class UpdateUserDto {
  name?: string;
  email?: string;
}
```

**第 2 步：GET 两个端点。** 新建 `users.controller.ts`，数据用模块级数组，进程内全局共享：

```ts
import { Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';

interface User {
  id: number;
  name: string;
  email: string;
}

// 模块级内存数组：重启即清空，第 4 周换 Prisma
const users: User[] = [
  { id: 1, name: 'Jerry', email: 'jerry@example.com' },
  { id: 2, name: 'Tom', email: 'tom@example.com' },
];
let nextId = 3; // 新用户的下一个 id

@Controller('users')
export class UsersController {
  @Get()
  findAll(@Query('keyword') keyword?: string): User[] {
    if (!keyword) return users;
    return users.filter(u => u.name.includes(keyword));
  }

  @Get(':id')
  findOne(@Param('id') id: string): User {
    const user = users.find(u => u.id === Number(id));
    if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
    return user;
  }
}
```

关键在 `NotFoundException` 一抛就完事：控制权立刻交回框架，后面的代码不用操心「找不到怎么办」。`findOne` 稍后还会被 PUT 复用，404 逻辑全项目只此一份。

**第 3 步：POST/PUT/DELETE。** 先把文件顶部的 import 换成这份合并版：

```ts
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
```

再往类里追加三个方法：

```ts
@Post()
create(@Body() dto: CreateUserDto): User {
  const user: User = { id: nextId++, ...dto };
  users.push(user);
  return user; // Nest 默认回 201，不用写 @HttpCode
}

@Put(':id')
update(@Param('id') id: string, @Body() dto: CreateUserDto): User {
  const user = this.findOne(id); // 复用：找不到自动抛 404
  user.name = dto.name;          // PUT 语义：全量替换
  user.email = dto.email;
  return user;
}

@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
remove(@Param('id') id: string): void {
  const index = users.findIndex(u => u.id === Number(id));
  if (index === -1) throw new NotFoundException(`用户 ${id} 不存在`);
  users.splice(index, 1);
}
```

PUT 复用 `CreateUserDto` 是有讲究的：全量替换要求的正是「完整资源」，形状和创建一致。加分题，PATCH 用 `UpdateUserDto`（记得把 `Patch` 加进 import）：

```ts
@Patch(':id')
patch(@Param('id') id: string, @Body() dto: UpdateUserDto): User {
  const user = this.findOne(id);
  Object.assign(user, dto); // 只覆盖客户端送了的字段
  return user;
}
```

**第 4 步：注册控制器。** 打开 `app.module.ts`，把 `UsersController` 加进 controllers 数组，和昨天的 HealthController 并排（HealthController 的导入路径以你昨天实际放的位置为准）：

```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users/users.controller';

@Module({
  controllers: [UsersController /* HealthController */],
})
export class AppModule {}
```

在 `apps/api` 目录下像昨天一样启动 dev 服务，看到启动成功日志（默认 3000 端口）再进下一步。

**第 5 步：curl 逐个打通。** 按顺序执行，每一行都瞄一眼状态码：

```bash
curl http://localhost:3000/users
curl "http://localhost:3000/users?keyword=Je"
curl -i http://localhost:3000/users/1
curl -i http://localhost:3000/users/999     # 期望 404
curl -i -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Ann","email":"ann@example.com"}'        # 期望 201
curl -i -X PUT http://localhost:3000/users/1 \
  -H "Content-Type: application/json" \
  -d '{"name":"Jerry L","email":"jerry-l@example.com"}' # 期望 200
curl -i -X DELETE http://localhost:3000/users/2         # 期望 204
curl http://localhost:3000/users            # 确认 Tom 删干净了
```

`-i` 会打印状态行，201、204、404 都要亲眼见到才算数。

::: tip Windows 提示
PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，`-X`、`-d` 参数直接报错。要么显式写 `curl.exe`，要么更省心：装 VS Code 的 REST Client 插件，新建 `requests.http`，用 `###` 分隔多个请求，请求体直接写 JSON 不用转义，点 Send Request 就能看响应和状态码。上面的 curl 全部可以照抄成 .http 格式。
:::

可选加餐：让响应带上第 1 周 shared 包约定的形状。先在 `apps/api/package.json` 的 dependencies 里加 `"@my/shared": "workspace:*"`，回仓库根目录 `pnpm install`（做法和第 1 周给 apps/web 加依赖一模一样，细节见[第 1 周](/week01/)），然后：

```ts
import { type ApiResponse } from '@my/shared';

@Get()
findAll(@Query('keyword') keyword?: string): ApiResponse<User[]> {
  const data = keyword ? users.filter(u => u.name.includes(keyword)) : users;
  return { code: 0, message: 'success', data };
}
```

包不包这层看团队约定：纯 REST 风格直接返回资源体更常见，但本系列前端统一按 `ApiResponse<T>` 收响应，两个口子都留给你。今天主线代码不包装，保持最简。

## 常见踩坑

**坑 1：路径参数到手是字符串，直接和数字比较永远 false。** `@Param('id')` 拿到的是 `'3'` 不是 `3`，写 `users.find(u => u.id === id)` 用了严格相等，number 和 string 永远不相等，接口表现成「查谁都 404」，而且不报任何错。今天用 `Number(id)` 转换；Nest 其实有更地道的写法 `@Param('id', ParseIntPipe) id: number`，转不成数字还会自动回 400，后天讲 Pipe 时正式请它出场。

**坑 2：`@Get(':id')` 声明在前，会吞掉后面声明的固定路由。** Nest 按方法在类里的声明顺序登记路由，先声明的先匹配。假如你后来加一个 `@Get('search')` 并写在 `findOne` 后面，GET /users/search 会先被 `@Get(':id')` 接走，拿着 `'search'` 去 `Number()` 得到 NaN，回 404，你盯着 search 的代码查半天却毫无问题。规则很简单：固定路由放前面，带参数的动态路由放后面。

**坑 3：DTO 手一滑写成 interface，后天校验全数失效。** interface 编译后不存在，ValidationPipe 靠 class-transformer 在运行时「new 出 DTO 实例再校验」，拿 interface 喂进去，转换结果是个没有类型信息的空壳，所有校验规则形同虚设，而且没有任何报错提醒你。这就是官方文档明确要求 DTO 用 class 的原因。`type` 别名同理，一样不行。

**坑 4：忍不住用 `@Req()` 和 `@Res()`。** `@Req` 的三个代价前面讲过。`@Res` 更狠：一旦注入，Nest 就不再替你处理响应，返回值不会被序列化，状态码也不会自动设，你得手动 `res.status(201).send(...)`，等于退回原生 Express 写法。两个都算逃生舱口，逃生舱口是用来逃生的，不是用来当正门的。

**坑 5：改一行代码，数据全没了，别当 bug 查。** `start:dev` 是 watch 模式，文件一保存进程就重启，模块级数组跟着归零。刚才 POST 建的用户「不见了」，是内存存储的既定行为，不是控制器写错。要数据活过重启，等第 4 周的 Prisma。顺带一句：多个单元测试共享同一个模块级数组也容易互相污染，明天把数据操作抽进 Service 时一并解决。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `@Param('id')`、`@Query('keyword')`、`@Body()`、`@Headers('authorization')` 分别从请求的哪个部位取值？

::: details 参考答案
路径动态段（`/users/3` 里的 3）、URL 问号后的查询串（`?keyword=je`）、请求体整体、请求头指定字段。前两者到手永远是字符串，要参与数值计算得先转换。
:::

2. DTO 为什么必须写成 class，interface 不行？

::: details 参考答案
interface 是纯编译期概念，编译产物里被完整擦除，运行时不存在；class 编译后是真实的构造函数。Nest 的 ValidationPipe 依赖 class-transformer 在运行时把请求体转成 DTO 实例再校验，喂 interface 等于喂空气，校验静默失效。这和第 1 周讲的「泛型运行时不存在」是同一条原理。
:::

3. Nest 里 POST 的默认状态码是多少？想让 DELETE 回 204，代码怎么写？

::: details 参考答案
POST 默认 201 Created，其余方法默认 200 OK。DELETE 加 `@HttpCode(HttpStatus.NO_CONTENT)`，且端点返回 void，204 语义上不允许带响应体。
:::

4. PUT 和 PATCH 的语义差别是什么？各举一个适用场景。

::: details 参考答案
PUT 全量替换，客户端送完整资源，漏送字段等于明确清空，适合表单整页保存这类「整份提交」的场景；PATCH 部分更新，只送变化字段，适合改单个属性（只改邮箱）。两者都要求幂等：同一请求重复发送，服务端最终状态一致。
:::

5. 什么情况下才该用 `@Req()`？用它取 headers 有什么代价？

::: details 参考答案
专用装饰器覆盖不到的字段才用它，典型是 cookies。代价：类型绑定底层平台（默认 Express，换 Fastify 要改代码）、单元测试要 mock 整个 req 对象、失去签名处「看得见取了什么」的声明式好处。
:::

## 延伸阅读

- [NestJS 官方文档：Controllers](https://docs.nestjs.com/controllers)，路由与参数装饰器的原始出处，末尾还讲了请求负载和异步处理
- [NestJS 官方文档：Validation](https://docs.nestjs.com/techniques/validation)，DTO 为什么用 class 的官方解释，后天 Day 6 的预习材料
- [MDN：HTTP 响应状态码](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status)，201/204/404 的权威定义，顺手把 4xx 家族全过一遍

今天的 `users.controller.ts` 留好：路由处理和数据操作现在还揉在一个类里，明天就把数据抽进 `UsersService`，见识 Nest 真正的招牌菜「依赖注入」。本周完整日程见[第 3 周目录](/week03/)。
