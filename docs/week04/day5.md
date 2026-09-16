# 第 4 周 · Day 5：NestJS + Prisma 整合——Module/Service/Controller 串成一条完整链路

> 对应手册任务：学习「NestJS + Prisma 整合：Module/Service/Controller 完整串联」，动手「把 Day 3-4 的 Prisma 操作接入 NestJS，完成 `/users` 的完整 CRUD」，当日产出「全栈 CRUD API 跑通」。本篇只解决一个问题：前四天的零件都各自验证过，项目却还是第 3 周骨架换了存储的样子；今天按生产章法把目录、模块、依赖注入、错误处理组装到位，让每个 HTTP 请求从路由进门、数据库出门，每一站都放对位置。

## 今日目标

1. 说得清 PrismaService 两个生命周期钩子各管什么，`@Global()` 免掉什么、免不掉什么
2. 掌握三块组装件：`prisma/` 目录、users/ 模块三件套、DTO 配全局校验管道
3. 独立完成 `/users` 完整 CRUD：404 与 409 来路明确，健康检查真连库，curl 逐个状态码验证通过

## 概念讲解：为什么「能跑」离「组装好」还差一步

先盘 [Day 3](/week04/day3) 收工时的家底：users.service.ts 已是 Prisma 实现，接口能跑，重启不丢数据。Day 4 又补了「创建用户同时建欢迎帖」的事务和 email 唯一索引。零件齐了，却是各自为战攒出来的，藏着三个问题。

一，门口没有验货的。POST /users 的请求体原样进 Prisma。email 格式对不对、多传的 `role: "admin"`，没人检查，全凭运气。

二，错误没有翻译。查无此人和邮箱撞唯一索引是两件事，调用方拿到的却都可能是 500。P2002、P2025 是 Prisma 的方言，404、409 才是 HTTP 的普通话，中间缺个翻译官。

三，结构没有章法。事务代码躺在哪、PrismaService 挂在哪个模块、以后加业务目录怎么摆，不先定规矩，项目一大就是事故。

这三个问题有一个共同答案：分层与登记。Controller 守 HTTP 边界，DTO 加管道在门口验货，Service 承载业务和错误语义，Module 是依赖注入容器的登记表。今天不学新语法，全是把已学零件归位，请求路线图见核心知识第 3 节。

## 核心知识

本节以 Day 2 的 schema 产出为前提（cuid id、name 可空、Cascade），字段对不上以你的 schema.prisma 为准。

### 1. PrismaService：让连接池听框架的

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

关键一行是 `extends PrismaClient`：继承之后 PrismaService 自己就是 PrismaClient，`this.user.create`、`this.$transaction` 直接可用；`@Injectable()` 把它登记进 DI 容器，全应用一个实例。Day 3 讲过的 globalThis 技巧是给没有容器的脚本准备的，Nest 里容器天生就干。

两个钩子各管一头。`onModuleInit` 在启动时触发，`await this.$connect()` 立刻建库连接。不写也能跑，PrismaClient 默认懒连接，第一条查询才连库，代价是密码错了、PG 没起，都要等第一个请求上门才炸；$connect 把配置错误提前到启动期。`onModuleDestroy` 在关停时断开连接，但它默认不监听 Ctrl+C，要 main.ts 里一行 `enableShutdownHooks()` 配合，第 1 步一起配。

### 2. @Global() PrismaModule：登记一次，处处可注入

```ts
import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

Module 在登记两件事：`providers` 写明这个模块能造出哪些服务，`exports` 声明其中哪些对外开放。按默认规矩，别的模块想注入 PrismaService，得把 PrismaModule 写进自己的 imports，模块一多每个都抄一遍，性价比极低。

`@Global()` 就是砍掉这个仪式：被标记的模块只要在 AppModule import 过一次，exports 就对全部模块可见。

两件事它没替你省。`exports: [PrismaService]` 一行不能少，全局只免 import，不免 export。「该不该全局」也不替你判断：PrismaService、日志、配置这类基础设施适合全局，业务模块全局化等于取消模块边界，慎用。

### 3. UsersModule 组装：三件套与目录结构

```ts
import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

三件套：`controllers` 登记「哪些路由归这个模块管」，`providers` 登记「这个模块能造出什么给 Controller 注入」，`imports` 声明「我依赖谁家的导出」。UsersModule 没写 imports 不是漏了：PrismaModule 是全局的。

目录跟着模块走：

```
apps/api/src/
├─ main.ts
├─ app.module.ts          # 根模块：汇总 imports
├─ app.controller.ts      # 健康检查
├─ prisma/                # 基础设施：连接与供件
│  ├─ prisma.service.ts
│  └─ prisma.module.ts
└─ users/                 # 业务模块
   ├─ users.module.ts
   ├─ users.controller.ts
   ├─ users.service.ts
   └─ dto/
      ├─ create-user.dto.ts
      └─ update-user.dto.ts
```

以后加 posts 业务，照 users/ 的骨架复制目录；换数据库，只动 prisma/。

一个 POST /users 请求的旅程：路由匹配到 UsersController；全局 ValidationPipe 拿 DTO 校验请求体，多余属性剥掉；Controller 把干净的 DTO 交给注入的 UsersService；Service 在事务里调注入的 PrismaService；SQL 发往 PostgreSQL；结果原路返回，中途的 NotFoundException、ConflictException 由异常过滤器翻成 404、409。

### 4. 错误翻译：Prisma 方言变成 HTTP 普通话

Prisma 出错时抛 `PrismaClientKnownRequestError`，带个 `code`，常用两个：P2002 唯一约束冲突，P2025 目标记录不存在。加上 findUnique 查不到返回 null 而不抛错，三种「事情不对」对应三种响应：

| Prisma 的事实 | 业务含义 | 翻译成 |
| --- | --- | --- |
| findUnique 返回 null | 查无此人 | 404，NotFoundException |
| code 为 P2025 | 改或删时目标已不存在 | 404，NotFoundException |
| code 为 P2002 | 唯一字段撞车 | 409，ConflictException |

翻译的固定句式：

```ts
import { Prisma } from "@prisma/client";
import { ConflictException } from "@nestjs/common";

try {
  // Prisma 调用
} catch (error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    throw new ConflictException("邮箱已被注册");
  }
  throw error;
}
```

instanceof 两层判断确保只翻译认识的错误，最后的 `throw error` 把别的错误原样上抛；这里为什么要一个不落，坑 3 细说。

## 动手任务：全栈 CRUD API 一步一步

手册任务：把 Day 3-4 的 Prisma 操作接入 NestJS，完成 /users 完整 CRUD。拆 5 步，约 45 分钟。前提：库在跑，迁移已应用，`npx prisma generate` 执行过。

**第 1 步：归置 prisma/，配好生命周期。** Day 3 第 1 步建过的两个文件挪进（或确认在）`src/prisma/`，内容照核心知识第 1、2 节。然后改 `app.module.ts`：

```ts
import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [PrismaModule, UsersModule],
  controllers: [AppController],
})
export class AppModule {}
```

app.service.ts 没人用了，删掉或不理都行。改 `main.ts`，两行配置一次加齐：

```ts
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks(); // 让 Ctrl+C 的 SIGINT 也触发 onModuleDestroy
  app.useGlobalPipes(new ValidationPipe({ whitelist: true })); // 全局验货，第 2 步细说
  await app.listen(4000); // 端口沿用第 3 周的约定
}

bootstrap();
```

users/ 目录还没建没关系，第 4 步补齐。

**第 2 步：DTO 与全局校验管道。** 第 3 周装过 `class-validator`、`class-transformer` 就跳过，否则补一行：

```bash
pnpm add class-validator class-transformer @nestjs/mapped-types
```

`users/dto/create-user.dto.ts`：

```ts
import { IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateUserDto {
  @IsEmail({}, { message: "email 必须是合法邮箱" })
  email: string;

  @IsOptional() // Day 2 的 schema 里 name 可空，DTO 跟着可省
  @IsString()
  @MaxLength(50)
  name?: string;
}
```

`users/dto/update-user.dto.ts`：

```ts
import { PartialType } from "@nestjs/mapped-types";
import { CreateUserDto } from "./create-user.dto";

export class UpdateUserDto extends PartialType(CreateUserDto) {}
```

全局管道已在 main.ts 配好。`whitelist: true`：请求体里凡是 DTO 没声明过的属性一律剥掉，前端多传一个 role，到不了 Prisma。想更严格就加 `forbidNonWhitelisted: true`，多余字段直接 400，联调定位问题特别快。

**第 3 步：UsersService，Day 3-4 的操作入驻。** 新建 `users/users.service.ts`，整文件照抄：

```ts
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(createUserDto: CreateUserDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: createUserDto.email, name: createUserDto.name },
        });
        await tx.post.create({
          data: {
            title: "欢迎帖",
            content: `你好，${user.name ?? user.email}，注册成功，这是系统为你创建的第一篇帖子。`,
            published: true,
            authorId: user.id,
          },
        });
        return tx.user.findUnique({ where: { id: user.id }, include: { posts: true } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(`邮箱 ${createUserDto.email} 已被注册`);
      }
      throw error;
    }
  }

  findAll() {
    return this.prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { posts: true },
    });
    if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    await this.findOne(id); // 复用：不存在直接 404
    try {
      return await this.prisma.user.update({ where: { id }, data: updateUserDto });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2025") throw new NotFoundException(`用户 ${id} 不存在`);
        if (error.code === "P2002") throw new ConflictException("邮箱已被注册");
      }
      throw error;
    }
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.user.delete({ where: { id } });
  }
}
```

说明四点。一，create 是 Day 4「建用户同时建欢迎帖」的事务搬进 API，两条 create 要么都落库要么都不落；嵌套写法（`posts: { create: ... }`）单条调用也是原子的，选交互式是给注册后的后续步骤留位置。二，update 先 findOne 复用 404 再执行；并发里目标恰好被人删掉，update 自己抛 P2025，catch 再翻一次 404，双保险。三，remove 敢只写一条 delete，靠的是 Day 2 的 onDelete: Cascade；你的 schema 没开，就换回 Day 3 第 4 步的 $transaction 写法。四，id 按 cuid 字符串处理，id 若是 Int 自增，把参数类型换成 number。

**第 4 步：Controller、健康检查、模块收口。** 新建 `users/users.controller.ts`：

```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto); // POST 默认就是 201
  }

  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id") id: string) {
    await this.usersService.remove(id);
  }
}
```

三个细节。POST 默认 201，不用显式写；DELETE 用 @HttpCode(204) 改成「成功且无内容」；id 没挂管道，cuid 是自定义格式没有现成管道，id 若是自增数字就挂 ParseIntPipe。Controller 不碰 Prisma、不写 try/catch，错误翻译全在 Service，它只对 HTTP 形状负责，第 5 步验证。

把 `app.controller.ts` 改成健康检查：

```ts
import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";

@Controller("health")
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: "ok", database: "up" };
  }
}
```

一条 `$queryRaw` 是最便宜的探针：能发出去并有响应，进程到 PostgreSQL 的链路就是活的。PrismaModule 是全局的，AppController 一个模块都不用 import，第 2 节当场兑现。数据库挂了它会 500，价值就在坏消息传得快。

最后把 users.module.ts 放进 users/，全部零件就位。

**第 5 步：curl 全流程验证。** 启动服务：

```bash
cd apps/api
npm run start:dev
```

另开一个终端（Windows 用户先看 tip），按剧本走：

```bash
# 0. 健康检查：进程和库都活着
curl http://localhost:4000/health
# {"status":"ok","database":"up"}

# 1. 创建用户：posts 里躺着欢迎帖，事务真的跑了
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"email":"jerry@example.com","name":"Jerry"}'
# 201，返回 id、email、name、createdAt、posts

# 2. 同邮箱再来一次：撞唯一索引
curl -i -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"email":"jerry@example.com","name":"Jerry2"}'
# HTTP/1.1 409 Conflict，message 是 Service 里那句中文

# 3. 列表与详情
curl http://localhost:4000/users
curl http://localhost:4000/users/<第1步返回的id>

# 4. 改名
curl -X PATCH http://localhost:4000/users/<id> \
  -H "Content-Type: application/json" \
  -d '{"name":"Jerry Lee"}'

# 5. 查一个不存在的：404 翻译生效
curl -i http://localhost:4000/users/not-exist-id
# HTTP/1.1 404 Not Found

# 6. 删除，再查：204 之后是 404
curl -i -X DELETE http://localhost:4000/users/<id>
curl -i http://localhost:4000/users/<id>
```

curl -i 是为了盯状态码，别只看 body。这套 201、409、404、204 就是 /users 的契约，明天前端靠它分流。最后 Ctrl+C：enableShutdownHooks 让进程先走 onModuleDestroy 断连接再退出，这是给生产环境留的。

::: tip Windows 终端
PowerShell 里 curl 是 Invoke-WebRequest 的别名，-X、-H、单引号 JSON 都会闹别扭：要么命令写全 curl.exe 并转义双引号，要么开一个 Git Bash 窗口照抄。本文命令均为 bash 写法。
:::

## 常见踩坑

**坑 1：@Global 了，却忘了 exports。** 全局只免 import，不免 export。没导出的服务照样注入不上，启动直接报 Nest can't resolve dependencies。先看 exports，再想 @Global。

**坑 2：不开 whitelist，多余字段直通 Prisma。** 校验只管已声明字段合不合格，不管多余字段该不该进。前端多传一个 role，一路传进 user.create 的 data，Prisma 报 Unknown argument，本该门口 400 的事变成 500。whitelist: true 一行治好。

**坑 3：catch 里忘了原样上抛。** 只想处理 P2002，手一滑把所有错误都翻成 409，网络错误、代码 bug 也被改了脸，事故变成玄学。instanceof 两层判断加 throw error，一步不能省。

**坑 4：enableShutdownHooks 没配，关停钩子白写。** 没这行，Nest 不监听 SIGINT/SIGTERM，Ctrl+C 直接退出进程，onModuleDestroy 不执行，$disconnect 形同虚设。开发期看不出，生产滚动更新时连接就是被硬掐断的。main.ts 一行，一次配好。

**坑 5：健康检查只报进程不碰库。** 返回 `{ status: "ok" }` 只能证明进程没死，PG 容器停了它照样报 ok。让探针走真实链路，一条 $queryRaw`SELECT 1`，挂了就让它 500。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `@Global()` 替你省了什么？没替你省什么？

::: details 参考答案
省的是各模块反复 import PrismaModule；没省的两件：exports: [PrismaService] 依然要写；「该不该全局」依然要自己判断，基础设施适合全局，业务模块不适合。
:::

2. onModuleInit 里的 `await this.$connect()` 不写应用也能跑，那它换来了什么？

::: details 参考答案
PrismaClient 默认懒连接，第一条查询才连库。$connect 把连接建立（连同它暴露的密码错、地址错、库没起）提前到启动那一刻，启动即失败，而不是等某个请求 500。
:::

3. P2002 和 P2025 分别是什么事实？各自翻成什么 HTTP 状态码？findUnique 查不到又该怎么处理？

::: details 参考答案
P2002 是唯一约束冲突，翻成 409 ConflictException；P2025 是 update/delete 目标不存在，翻成 404 NotFoundException。findUnique 查不到不抛错、返回 null，要自己判空后抛 NotFoundException。
:::

4. 一个 POST /users 请求从进来到返回，按顺序经过哪几站？

::: details 参考答案
路由匹配到 UsersController；ValidationPipe 用 DTO 校验请求体并剥掉多余属性；Controller 把 DTO 交给注入的 UsersService；Service 在 $transaction 里调注入的 PrismaService；SQL 到 PostgreSQL；结果原路返回，中途异常由异常过滤器翻成 404/409。
:::

5. 为什么 catch 里必须 `instanceof Prisma.PrismaClientKnownRequestError`，并且最后要 `throw error`？

::: details 参考答案
try 里抛的不全是可翻译的已知错误，网络故障、代码 bug 抛的是别的类型。instanceof 加 code 确保只翻译认识的错误；throw error 把不认识的原样上抛给框架兜底，否则错误被错译或吞掉，排查等于蒙眼。
:::

## 延伸阅读

- [NestJS 官方 Prisma 配方](https://docs.nestjs.com/recipes/sql/prisma)，PrismaService 与 PrismaModule 的官方推荐写法，和今天的手法同源
- [NestJS 官方 Modules 文档](https://docs.nestjs.com/modules)，@Global 的官方定义与模块解析规则
- [Prisma 错误码参考](https://www.prisma.io/docs/orm/reference/error-reference)，P2002、P2025 之外还有一整页错误码，翻译前先来翻一遍

第 1 周的类型与契约、第 3 周的 Nest 骨架、本周的 PostgreSQL 和 Prisma，今天第一次在同一个工程里各就各位。/users 接口和数据留着别动，明天 Day 6 让 apps/web 的页面真正消费它们，前端从此告别 mock。
