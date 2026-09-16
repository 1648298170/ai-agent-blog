# 第 3 周 · Day 5：NestJS Service 与依赖注入——让 Controller 瘦成一层皮

> 对应手册任务：学习「NestJS Service + 依赖注入」，动手把用户数据操作抽到 `UsersService`，用构造函数注入到 Controller，当日产出「分层清晰的 Users 模块」。本篇只解决一个问题：昨天的 `/users` CRUD 全糊在 Controller 里，今天把业务和数据搬进 Service，再让框架把 Service 递进 Controller，从此 HTTP 语义和业务逻辑各管各的，换存储、写单测都不用碰路由。

## 今日目标

1. 说得清为什么要分层：Controller 只管 HTTP 语义，Service 管业务和数据，以及这么拆给可测试性带来的直接好处
2. 掌握四个知识点：`@Injectable` 与 IoC 容器的「注册、解析、注入」三步、构造函数注入、providers 的完整写法、Module 的三个数组
3. 独立把昨天的胖控制器拆成 `UsersController` + `UsersService`，接口行为一个不变，并亲眼看一次「忘了注册 provider」的经典报错

## 概念讲解：为什么要把 CRUD 搬出 Controller

先看昨天的产出。路由能跑，CRUD 齐全，但业务、数据、HTTP 全堆在 `UsersController` 一个类里。抽一段最典型的：

```ts
@Controller('users')
export class UsersController {
  private users: User[] = [ /* 种子数据 */ ]; // 数据存储：业务
  private nextId = 3;                          // id 生成规则：业务

  @Post()
  create(@Body() dto: CreateUserDto): User {   // @Post/@Body：HTTP
    const user = { id: this.nextId++, ...dto }; // 组装数据：业务
    this.users.push(user);                      // 存取数据：业务
    return user;                                // 返回响应：HTTP
  }
}
```

六行方法，三种职责。今天它只是「不够优雅」，很快会变成三个具体的坑。

第一，没法单独测试。想验证「创建用户时 id 自增」这条规则，你得先起一个完整的 HTTP 服务，再发真请求过去。测的东西明明只是一段数组操作。

第二，逻辑没法复用。哪天来个定时任务也要查用户列表，你只能把 Controller import 进去调用，或者把代码复制一遍。两条路都不体面。

第三，换存储会惊动路由。第 4 周要把内存数组换成 Prisma 连 PostgreSQL，照现在这个写法，改动会一路渗到 `@Get()` 装饰器旁边。

分层的原则一句话：Controller 只管 HTTP 语义，包括路由匹配、参数解析、状态码、响应格式；Service 管业务，包括业务规则和数据存取。判断一行代码该放哪层，问一句「这行代码关心 HTTP 吗」就够了。

拆完立刻冒出新问题：Controller 怎么拿到 `UsersService` 的实例？最直觉的答案是 `new UsersService()`。能跑，但代价马上到账：Nest 负责 new Controller，它不知道里面还藏着一个 Service，于是单例没了；测试时想换成一个假的 Service，也没处下手，因为创建代码写死在类里面。

依赖注入（DI）就是来解决这个的：你别自己 new，把「我需要什么」声明出来，框架负责造好递给你。创建依赖的控制权从你手里交到框架手里，这就是控制反转（IoC）这个名字的来历。顺带埋个锚点：第 9 周起的 FastAPI 阶段你会遇到同款思想的 `Depends`，向框架声明依赖、框架负责提供，差别只是 Nest 靠构造函数参数的元数据，FastAPI 靠函数参数的默认值。

## 核心知识

本节代码基于昨天的 NestJS 项目（`apps/api`），也可以当独立示例读。最终完整文件以下面的动手任务为准。

### 1. `@Injectable` 与 IoC 容器：注册、解析、注入

先澄清一个误会：`@Injectable()` 不是「加了就自动被注入」的魔法开关，它只给类挂一份元数据，声明「我是可以被容器管理的对象」。真正让注入发生的是 `@Module()` 里的 `providers` 数组，`@Injectable` 是门票，登记才是入场。

容器干活分三步。

**注册**：应用启动时，Nest 扫描每个 `@Module` 的 `providers`，把「token → 将来用它造实例的类」登记进容器内部的映射表。

**解析**：容器要实例化 `UsersController` 时，读取它构造函数的参数类型。这个信息哪来的？TypeScript 开启 `emitDecoratorMetadata` 编译选项后，装饰器会把参数类型写进类的元数据。容器发现第一个参数是 `UsersService`，就去映射表里查。

**注入**：查到了，就先实例化 `UsersService`（它自己若还有依赖，递归解析），把实例传给 `UsersController` 的构造函数。查不到，就是你今天会亲眼见到的那条报错。

默认 scope 下 `UsersService` 全应用只造一次，之后谁注入拿到的都是同一个实例。这是单例：省内存、能共享状态，但反过来提醒你，别把「跟单个请求绑定的状态」（比如当前登录用户）存进 Service 字段，那种状态不属于全应用。

### 2. 构造函数注入：官方推荐的那一种

```ts
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // 方法里直接 this.usersService.findAll()
}
```

关键一行是 `constructor(private readonly usersService: UsersService)`。`private readonly` 是 TypeScript 参数属性简写：声明参数的同时声明同名只读字段，Nest 传进来的实例自动挂上去。

它对面还有一种属性注入：

```ts
export class UsersController {
  @Inject(UsersService)
  private readonly usersService!: UsersService;
}
```

能跑，但不推荐。构造函数注入的依赖是「不给就不让出生」，缺了当场炸；属性注入的依赖是「出生后再补」，你手动 `new UsersController()` 时属性还是 undefined，错误被拖到第一次调用才爆，和 `any` 把问题拖到运行时是同一个坏味道。`@Inject(token)` 真正常见的用处是配合自定义 token 指定注入目标，第 4 节会用到。

### 3. providers 的完整写法与 UsersModule 的组织

`providers: [UsersService]` 是个简写，完整形态长这样：

```ts
providers: [
  {
    provide: UsersService, // token：容器里登记的钥匙
    useClass: UsersService, // 实现：拿这把钥匙来换时，用哪个类造实例
  },
],
```

两个要素各司其职：`provide` 回答「用什么名字取」，`useClass` 回答「取到的是谁造的」。简写就是两者恰好同名时的语法糖。`provide` 不一定是类，字符串、Symbol 都行，这是第 4 节的伏笔。

Module 一共三个数组，今天的 `UsersModule`：

```ts
@Module({
  imports: [],                        // 本模块要用到的其他模块
  controllers: [UsersController],    // 注册路由
  providers: [UsersService],          // 注册可注入对象
})
export class UsersModule {}
```

`controllers` 管 HTTP 层，`providers` 管可注入层，`imports` 管依赖关系。同时确认 `app.module.ts` 的 `imports` 里有 `UsersModule`（用 Nest CLI 生成资源时它会自动加，手动建模块就要自己补）。

### 4. 依赖倒置：token 指向接口，给 Prisma 留门

现在 Controller 依赖的是 `UsersService` 这个具体类。依赖倒置原则说：高层（Controller）和低层（内存版 Service）都该依赖抽象，不依赖具体实现。落到 Nest 里分三步。

```ts
// users.service.interface.ts
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './users.service';

export const USERS_SERVICE = Symbol('USERS_SERVICE');

export interface IUsersService {
  findAll(keyword?: string): User[];
  findOne(id: number): User;
  create(dto: CreateUserDto): User;
  update(id: number, dto: UpdateUserDto): User;
  remove(id: number): void;
}
```

```ts
// users.module.ts：token 指到当前实现
providers: [{ provide: USERS_SERVICE, useClass: UsersService }],
```

```ts
// users.controller.ts：依赖接口，token 要显式写
export class UsersController {
  constructor(
    @Inject(USERS_SERVICE) private readonly usersService: IUsersService,
  ) {}
}
```

为什么必须加个 Symbol？接口是纯编译期的东西，[第 1 周 Day 1](/week01/day1) 讲过类型擦除：编译成 JS 后接口消失，容器在运行时需要一个真实存在的 key，字符串或 Symbol 都行，Symbol 更防撞。`@Inject(USERS_SERVICE)` 就是在说「这个参数按 token 取，别按类型猜」。

这套写法的回报在第 4 周：Day 3 接 Prisma 时新写一个 `PrismaUsersService`，把 `useClass` 换掉，Controller 一行不动，换库完成。也要说句实话：现在只有一个实现，直接注入具体类完全够用，接口 token 是到时候才真正用上的招。今天知道有这条路，比今天就把路铺满更重要。

## 动手任务：拆出 UsersService 一步一步

手册任务：把用户数据操作抽到 `UsersService`，用构造函数注入到 Controller。拆成 5 步，全程约 25 分钟。以下代码都可以直接照抄。

**第 1 步：盘点昨天。** 打开 `users.controller.ts`，用「这行代码关心 HTTP 吗」逐行过一遍：`users` 数组、`nextId`、组装数据、查找和过滤，全是业务；装饰器、`@Body()`、状态码，是 HTTP。圈出来的业务部分，就是第 2 步要搬走的清单。

**第 2 步：建 `users.service.ts`，搬业务。** 在 users 目录新建文件，把圈出来的代码连同两个 DTO 的 import 一起搬进来，加上 `@Injectable()`：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

export interface User {
  id: number;
  name: string;
  email: string;
}

@Injectable()
export class UsersService {
  private users: User[] = [
    { id: 1, name: 'Jerry', email: 'jerry@example.com' },
    { id: 2, name: 'Tom', email: 'tom@example.com' },
  ];
  private nextId = 3;

  findAll(keyword?: string): User[] {
    if (!keyword) return this.users;
    return this.users.filter((u) => u.name.includes(keyword));
  }

  findOne(id: number): User {
    const user = this.users.find((u) => u.id === id);
    if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
    return user;
  }

  create(dto: CreateUserDto): User {
    const user: User = { id: this.nextId++, ...dto };
    this.users.push(user);
    return user;
  }

  update(id: number, dto: UpdateUserDto): User {
    const user = this.findOne(id);
    Object.assign(user, dto);
    return user;
  }

  remove(id: number): void {
    this.findOne(id);
    this.users = this.users.filter((u) => u.id !== id);
  }
}
```

注意 `User` 接口跟着数据操作走，也搬过来并 `export`，Controller 还要用它标返回类型。`NotFoundException` 放在 Service 里抛是 Nest 官方文档的常见写法，它本质是框架级错误通道，不算破坏分层。

**第 3 步：改造 Controller，瘦身。** 删掉搬走的字段和方法体，换成构造函数注入加一行委托：

```ts
import {
  Body, Controller, Delete, Get,
  Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { User, UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  findAll(@Query('keyword') keyword?: string): User[] {
    return this.usersService.findAll(keyword);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): User {
    return this.usersService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateUserDto): User {
    return this.usersService.create(dto);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ): User {
    return this.usersService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number): void {
    this.usersService.remove(id);
  }
}
```

每个方法瘦成一行，只剩 HTTP 语义。这一行委托不是废话，它标明了参数从哪来、响应是什么类型，这两件事仍是 Controller 的本职。

**第 4 步：注册 provider。** 确认 `users.module.ts` 的 `providers` 里有 `UsersService`：

```ts
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
```

**第 5 步：验证，然后故意弄坏一次。** 先正常验证（命令见下方 tip）。然后把 `providers: [UsersService]` 临时改成 `providers: []`，保存，看报错：

```text
Nest can't resolve dependencies of the UsersController (?). Please make sure
that the argument UsersService at index [0] is available in the UsersModule context.
```

读懂它：`at index [0]` 指构造函数第 0 个参数，`available in the UsersModule context` 指在这个模块的 providers（或它 imports 进来的模块导出）里找不到对应 token。这条报错是 Nest 开发生涯出镜率最高的前三名，今天见过，以后三秒定位。看完把 providers 改回去，恢复启动。

::: tip 启动与验证
在 `apps/api` 目录执行 `npm run start:dev`，另开终端用 curl 过一遍：`curl http://localhost:3000/users`、`curl -X POST http://localhost:3000/users -H "Content-Type: application/json" -d "{\"name\":\"Ann\",\"email\":\"ann@example.com\"}"`、`curl -X DELETE http://localhost:3000/users/1`。行为和昨天完全一致，才算拆完。
:::

## 常见踩坑

**坑 1：忘了在 providers 里注册。** 症状就是上面那条 `Nest can't resolve dependencies` 报错。修法永远两选一：把类加进本模块 `providers`；或者它本来注册在别的模块，那就在那个模块的 `exports` 里导出，再在本模块 `imports` 引入。新手九成是前者，剩下一成是真的需要跨模块共享。

**坑 2：在 Controller 里手动 new Service。** `new UsersService()` 绕过了容器：这个实例不在容器里，单例失效；Service 自己若有别的注入依赖，你 new 的时候也传不进去；测试时更没法替换成假实现。注入的本质是把创建权上交框架，手动 new 是把创建权又要回去，两头好处全丢。

**坑 3：Controller 和 Service 的边界来回荡秋千。** 两个方向都会翻车。往下漏：把 `@Res()`、状态码操作搬进 Service，业务层从此绑死 HTTP；往上漏：把「email 重复返回 409」整个判断写在 Controller，业务规则散落在路由层，别处复用不了。正确拆法是 Service 判断重复并抛错，Controller 决定这个错映射成 409 还是 400。口诀还是那句：关心 HTTP 吗。

**坑 4：依赖箭头回头。** 依赖方向必须一路向下：Controller → Service → 数据层。Service 反过来 import Controller，分层等于白拆。两个 Service 互相注入也别急着用 `forwardRef` 硬解，那是设计在报警，通常说明该把公共部分抽成第三个 Service。

**坑 5：拿接口直接当注入 token。** 写了 `constructor(private usersService: IUsersService)`，又在 providers 里注册 `UsersService`，期望容器「按接口匹配实现」。做不到：接口编译后就被擦掉了，容器在运行时看到的 token 是个对不上号的 `Object`，直接报 can't resolve。接口只能管编译期类型，运行期匹配必须靠真实存在的 token 加 `@Inject(USERS_SERVICE)` 显式指定，回看核心知识第 4 节的三段代码。

**坑 6：漏加 `@Injectable()` 侥幸能跑，然后突然炸。** 被注入的类如果自己没有任何依赖，容器照样 new 得出来，程序能跑，你会误以为这装饰器可有可无。等哪天这个 Service 注入了第二个依赖（比如日志服务），它类上没有元数据，容器解析不出参数，当场报错。结论：Service 一律加 `@Injectable()`，别赌。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 一行代码放在 Controller 还是 Service，判断标准是什么？

::: details 参考答案
问「这行代码关心 HTTP 吗」。路由匹配、参数解析、状态码、响应格式，关心，放 Controller；业务规则和数据存取，不关心，放 Service。典型案例是「email 重复返回 409」：重复判断是业务，放 Service 抛错；409 是 HTTP 语义，放 Controller 映射。
:::

2. `providers: [UsersService]` 的完整形态是什么？`provide` 和 `useClass` 各起什么作用？

::: details 参考答案
完整形态是 `{ provide: UsersService, useClass: UsersService }`。`provide` 是登记进容器的 token，回答「用什么钥匙取」；`useClass` 回答「取的时候用哪个类造实例」。简写是两者同名时的语法糖。`provide` 也可以是字符串或 Symbol，自定义 token 时就靠它们。
:::

3. 容器完成一次注入要经过哪三步？`UsersService` 默认是单例意味着什么？

::: details 参考答案
注册（扫描 `@Module` 的 providers，登记 token 到类的映射）、解析（读 Controller 构造函数参数的元数据，查映射表）、注入（先递归实例化依赖，再把实例传入构造函数）。默认 scope 下全应用只有一个 `UsersService` 实例，所有注入方共享；因此不要在 Service 里存放跟单个请求绑定的状态。
:::

4. 构造函数注入比属性注入好在哪？

::: details 参考答案
构造函数注入是「不给依赖就不让实例出生」，缺依赖当场报错，且 `private readonly` 保证依赖不可变、类型明确。属性注入是「出生后再补」，手动 new 时属性是 undefined，错误拖到第一次调用才爆。`@Inject(token)` 的本职是配合自定义 token 指定注入目标，不是用来做属性注入的。
:::

5. 为什么 TS 接口不能直接当注入 token？正确的写法是什么？

::: details 参考答案
接口是纯编译期的，编译成 JS 后被擦除，运行时容器找不到一个真实存在的 key 去匹配，于是报 can't resolve。正确写法：定义字符串或 Symbol 作 token，注册时用 `{ provide: USERS_SERVICE, useClass: 当前实现 }`，注入时用 `@Inject(USERS_SERVICE)` 显式指定，参数类型标成接口。换实现时只改 `useClass`，调用方不动。
:::

## 延伸阅读

- [NestJS 官方文档：Providers](https://docs.nestjs.com/providers)，Service、`@Injectable`、注入的本篇原始出处，示例值得跟着敲一遍
- [NestJS 官方文档：Custom Providers](https://docs.nestjs.com/fundamentals/custom-providers)，`provide/useClass/useValue/useFactory` 全景，把 token 机制讲透
- [NestJS 官方文档：Injection Scopes](https://docs.nestjs.com/fundamentals/injection-scopes)，单例与 request 级 scope 的细节，今天知道默认单例就够，需要时回来查

今天的 Users 模块收好。第 4 周 Day 3 会把 `UsersService` 里的内存数组换成 Prisma：到那天你会发现，要动的只有这一个类的内部实现，路由、DTO、Module 注册全部原封不动，这就是今天拆层的全部回报。明天按[本周日程](/week03/)进入 Day 6，给 DTO 加上真正的校验。
