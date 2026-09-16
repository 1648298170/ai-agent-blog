# 第 3 周 · Day 6：参数校验——用 Pipe 把垃圾数据挡在 Service 之前

> 对应手册任务：学习「NestJS Pipe + class-validator」，动手「为 DTO 添加 `@IsEmail`、`@MinLength` 等校验，写全局 `ValidationPipe`」，当日产出「参数校验生效」。本篇只解决一个问题：Day 4、Day 5 建好的 Users 模块，Controller 接客、Service 干活，分层是清楚了，可 `@Body()` 收进来的东西没人查。空字符串的名字、乱写的邮箱、负数年龄，一路畅通无阻地进了内存数组。今天在路由和 Service 之间装一道关卡：数据不合法，请求当场被 400 弹回，Service 一行都不用跑。

## 今日目标

1. 说得清 Pipe 的两个用途：transform 转换、validate 校验，以及它卡在「参数解析之后、路由方法执行之前」的时机
2. 会给 DTO 挂 class-validator 装饰器：`@IsEmail`、`@IsString`、`@IsInt`、`@Min`、`@MinLength`、`@IsOptional`、`@IsEnum` 一套打齐
3. 独立完成全局 `ValidationPipe` 三参数配置，亲眼看一条垃圾请求被 400 拦下，并能逐条读懂响应体里的报错

## 概念讲解：为什么校验必须在门口做

先复现事故现场。用 curl 朝 Day 5 的成果开一发：

```bash
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "", "email": "not-an-email", "age": -5, "role": "superadmin", "isAdmin": true}'
```

返回 201，创建成功。看一眼 Service 里的数组，现在它存着：名字是空字符串、邮箱是个普通字符串、年龄是 -5、role 是枚举里根本不存在的 superadmin，外加一个 DTO 里从没声明过的 isAdmin。后面的 GET 接口把这些原样吐出去，下游一旦信了「邮箱是合法格式」的假设（比如拿它发通知、做唯一性判断），错误就会在离案发现场很远的地方炸开，排查成本翻倍。

有人会问：DTO 里不是写了 `name: string` 吗？没用。TypeScript 的类型活在编译期，网络请求进来的是纯 JSON，这一步没有编译器参与。[第 1 周 Day 1](/week01/day1) 讲泛型擦除时说过：运行时不存在 T，同样也不存在 `string`。类型标注拦不住 HTTP。

那校验写在哪？三个位置摆出来看。写在 Controller 里，每个方法开头十几行 if/else，第二天就有人复制到另一个接口改漏一处。写在 Service 里，校验和业务逻辑搅在一起，Service 不再是「只关心用户数据」的角色。写一个类似 [第 1 周 Day 3](/week01/day3) 的 `isUser` 守卫统一调用？思路对了，但规则还是手写的：每加一个字段，守卫跟着加一段 typeof，漏写一个编译器不会提醒你。

真正想要的是：规则跟着 DTO 声明一次，框架在所有接口统一执行，Controller 和 Service 一行业务代码都不用改。这就是 Pipe 干的事。`isUser` 和 `ValidationPipe` 是同一个想法的两个版本：前者手写过程式的逐字段检查，后者把检查变成装饰器，声明式地贴在字段上。框架替你写了那个守卫，还附送统一的报错格式。

## 核心知识

本节的代码就是最终要写进 `apps/api` 的形状，动手任务时直接照抄。

### 1. Pipe：卡在路由方法之前的关卡

Pipe 是一个实现了 `PipeTransform` 接口的类，核心只有一个方法。自己写一个最小的看看形状：

```ts
import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class ParseAgePipe implements PipeTransform<string, number> {
  transform(value: string) {
    const age = Number(value);
    if (Number.isNaN(age)) {
      throw new BadRequestException('age 必须是数字');
    }
    return age; // 转换后的值继续往下传
  }
}
```

就这么点东西：数据从 `transform` 进去，处理完返回，不合法就抛异常。由此得出 Pipe 的两个用途：**转换**，进去 `"25"` 出来 `25`，Nest 内置的 `ParseIntPipe`、`ParseUUIDPipe` 干的就是这个；**校验**，数据不合法直接抛错，请求到此为止。多数 Pipe 两者兼有，上面这个例子就同时做了转换和拦截。

执行时机是重点：Pipe 跑在「路由参数解析之后、控制器方法执行之前」。请求带着垃圾数据进门，Pipe 先过手，抛了 `BadRequestException`，框架直接回 400，控制器方法根本不会被调用。「挡在 Service 之前」就是这么挡的。

`ValidationPipe` 是 Nest 内置的通用版：它自己不认识你的业务字段，而是读 DTO 类上的装饰器元数据，调用 class-validator 执行规则。所以接下来你要写的不是 Pipe，是规则。

### 2. class-validator：把规则写在字段旁边

先装包，在 `apps/api` 目录下：

```bash
npm i class-validator class-transformer
```

class-validator 提供装饰器规则，class-transformer 负责对象转换，`ValidationPipe` 底层同时依赖两者，两个包缺一不可。

常用装饰器一套打齐，直接看目标产物：

```ts
import {
  IsString, IsInt, IsEmail, Min, MinLength, MaxLength, IsOptional, IsEnum,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MinLength(2, { message: '用户名至少 2 个字符' })
  @MaxLength(20)
  name: string;

  @IsEmail({}, { message: 'email 必须是合法邮箱' })
  email: string;

  @IsInt()
  @Min(0, { message: 'age 不能为负' })
  age: number;

  @IsEnum(['admin', 'user'])
  @IsOptional()
  role?: 'admin' | 'user';
}
```

读法：一个字段上的装饰器从上往下是「与」的关系，全过才算合法。`name` 必须是字符串、长度 2 到 20；`age` 必须是整数且不小于 0。`@IsOptional()` 的语义是「字段可以不出现，出现了才校验」，所以 role 可以不带，带了就必须是 admin 或 user 之一。

`message` 选项自定义报错文案。注意 `@IsEmail({}, { message: ... })` 有两个参数：第一个对象是校验规则自身的选项（`@IsEmail` 留空即可），第二个才是 message。位置写错不报编译错误，只是文案静默不生效，坑 2 专门说它。

顺带一句：校验库不止这一家。[Day 2](/week03/day2) 用 zod 校验过环境变量，NestJS 里 zod 也有对应玩法，自己封一个 ZodValidationPipe，或用 `@anatine/zod-openapi` 这类封装，思路与本文同构，先把官方默认的 class-validator 用熟即可。

### 3. 全局 ValidationPipe：三个参数各管一件事

`main.ts` 里一次配置，全部接口同时生效：

```ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // 剥掉 DTO 里没声明的字段
      forbidNonWhitelisted: true, // 遇到没声明的字段直接 400，而不是悄悄剥掉
      transform: true,            // 普通对象转成 DTO 实例，并按声明类型做基础转换
    }),
  );
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
```

`whitelist: true` 管的是「字段白名单」。请求体里出现 DTO 没声明的字段（开头那发 curl 里的 isAdmin），校验通过前先被剥掉，Controller 拿到的对象干干净净。它防的是一类真实攻击：往注册接口塞一个 `isAdmin: true`，赌后端拿整个 body 直接入库，一次就越权。

`forbidNonWhitelisted: true` 把「悄悄剥掉」升级成「明确拒绝」。只开 whitelist 时，多余字段被静默丢弃，调用方以为字段存上了，实际没有；开了这个参数，直接 400 并指名道姓：`property isAdmin should not exist`。调试期间强烈建议开着。

`transform: true` 干两件事。第一，把请求体从普通对象变成 DTO 类的实例，`dto instanceof CreateUserDto` 为 true。第二，按字段的声明类型做基础类型转换，对 query 参数尤其要命：URL 里一切都是字符串，`?age=25` 到手是 `"25"`，字段声明成 number、挂了 `@IsInt()`，不开 transform 就会被误杀成「不是整数」。

校验失败时，框架回 400，响应体长这样：

```json
{
  "message": [
    "email must be an email",
    "name must be longer than or equal to 2 characters",
    "age must not be less than 0"
  ],
  "error": "Bad Request",
  "statusCode": 400
}
```

三个字段要认得：`message` 是数组，每条对应一条没过的规则，自定义 message 后这里就显示你的中文文案；`error` 和 `statusCode` 是 Nest 统一异常格式的一部分。前端拿到 400，遍历 message 数组，就能把每条错误指到具体的输入框。

## 动手任务：`ValidationPipe` 一步一步

手册任务：给 `CreateUserDto` 加校验装饰器，注册全局 `ValidationPipe`，看到 400。拆成 5 步，全程约 25 分钟。

**第 1 步：装包。** 在 `apps/api` 下执行 `npm i class-validator class-transformer`。

**第 2 步：给 DTO 挂规则。** 打开 Day 4 建的 `users/dto/create-user.dto.ts`，照核心知识第 2 节的成品改写，四个字段一个不落，装饰器从上往下就是每个字段的规则清单。

**第 3 步：注册全局管道。** 用核心知识第 3 节的完整 `main.ts` 替换现有文件，`useGlobalPipes` 放在 `create` 之后、`listen` 之前。

**第 4 步：三发 curl 验收。** 重启服务，依次发：

```bash
# 第一发：合法数据，应当 201
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Jerry", "email": "jerry@example.com", "age": 25}'

# 第二发：脏数据，应当 400，message 数组逐条列出罪名
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "J", "email": "not-an-email", "age": -5}'

# 第三发：多余字段，应当 400，报 property isAdmin should not exist
curl -X POST http://localhost:4000/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Jerry", "email": "jerry@example.com", "age": 25, "isAdmin": true}'
```

第二发的 400 响应里应该能看到三条 message，全是自定义的中文文案。第三发证明 forbidNonWhitelisted 立住了。哪发没按预期来，先查拼写，再对照坑 1。

**第 5 步：whitelist 对照实验。** 把 `forbidNonWhitelisted` 暂时改成 false（whitelist 保持 true），再发第三发：请求 201 了，但在 Controller 里临时加一行 `console.log(dto)`，你会发现 isAdmin 不见了。这就是「静默剥离」。看完把参数改回 true，删掉 console.log。两个参数的差别，亲眼看过一遍比读十遍文档都牢。

::: tip 提示
全局生效是这套配置的意义：以后所有新接口，DTO 挂上装饰器就自动受保护，不用再注册什么。个别接口想要不同规则，可以就近在参数或方法上挂 `@UsePipes(new ValidationPipe({...}))`，但全局那份三参数配置保持不动，别在每个控制器里各配各的，报错格式迟早分叉。
:::

## 常见踩坑

**坑 1：DTO 写成 interface，校验静默失效。** Day 4 建 DTO 时如果用了 interface，装饰器根本没地方挂；就算类型标注都写了，全局管道也一声不吭。原因回到类型擦除：interface 编译后不存在，框架元数据里记录的类型是 Object，`ValidationPipe` 一看「不是类」，直接原样放行，一行报错都没有，脏数据照进数组。这是新手最常见也最难察觉的失效方式。对策一句话：DTO 必须是 class，装饰器只能挂在运行时真实存在的东西上。

**坑 2：message 写错位置，自定义文案不生效。** `@IsEmail({ message: '...' })` 编译不报错，校验也照常跑，唯独报错还是英文。因为第一个参数对象是给校验规则本身传配置的，message 属于第二个参数：`@IsEmail({}, { message: '...' })`。单参数的装饰器（比如 `@Min`）则是 `@Min(0, { message: '...' })`。规律：规则参数在前，校验选项在后。

**坑 3：只开 forbidNonWhitelisted，不开 whitelist。** 以为两个参数独立生效，只配了前者，结果多余字段既不报错也不剥离，原样进 Controller。class-validator 的约定是 forbidNonWhitelisted 只在 whitelist 开启时才工作，官方示例也总是两个一起出现。抄配置时成对抄，别只抄一半。

**坑 4：query 参数校验全灭。** 给列表接口的 query 挂 `@IsInt() page: number`，一测全 400，报「必须是整数」。不是规则写错，是 query 里一切皆字符串，`"2"` 过不了 `@IsInt`。两个解法：开 `transform: true` 让框架按声明类型转换（本文主线），或单独给参数挂 `ParseIntPipe`。class-transformer 另有更激进的 `enableImplicitConversion` 开关，本篇不碰，知道有这个选项即可。

**坑 5：指望装饰器做业务校验。** 「邮箱必须是合法格式」是装饰器的活，「邮箱没被注册过」不是。装饰器只看得到本次请求的字段值，查事实要访问存储，那是 Service 的地盘。判断标准一句话：规则只依赖这个值本身，上装饰器；要问数据库或其他数据，进 Service。校验挡格式，Service 查事实，两层各司其职，别混。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Pipe 的两个用途分别是什么？ValidationPipe 在请求处理流程中的执行时机在哪一步？

::: details 参考答案
转换和校验，一个 Pipe 可以同时干两件事。执行时机在路由参数解析之后、控制器方法执行之前；校验失败抛 `BadRequestException`，框架直接回 400，控制器方法不会执行。
:::

2. whitelist、forbidNonWhitelisted、transform 三个参数各管什么？

::: details 参考答案
whitelist 剥掉 DTO 未声明的字段，防「塞字段」式攻击；forbidNonWhitelisted 把静默剥离升级为 400 报错，只在 whitelist 开启时生效；transform 把普通对象转成 DTO 实例，并按声明类型做基础转换，典型场景是 query 里的 `"25"` 转成 25。
:::

3. DTO 为什么必须是 class，不能是 interface？

::: details 参考答案
装饰器需要挂在运行时存在的目标上。interface 编译后擦除，框架元数据里只剩 Object，ValidationPipe 识别不出待校验的类，会静默放行。class 在运行时真实存在，装饰器元数据才能被读到。
:::

4. 收到 400 后，怎么从响应体定位是哪几条规则没过？

::: details 参考答案
看 `message` 数组，每条对应一条失败的规则，自定义过 message 的显示你的文案；`error` 和 `statusCode` 来自 Nest 统一异常格式。前端遍历 message 数组，就能把错误映射到具体输入框。
:::

5. 「邮箱已被注册」这条规则该校验在哪层？为什么？

::: details 参考答案
Service 层。装饰器校验只依赖字段值本身（格式、长度、范围），查重需要访问用户存储，Pipe 里拿不到也不该拿。「格式合法」和「事实成立」是两件事，前者在门口，后者在业务里。
:::

## 延伸阅读

- [NestJS 官方文档：Validation](https://docs.nestjs.com/techniques/validation)，本篇所有配置项的原始出处，Global scoped pipe 和 Transform payload objects 两节值得精读
- [NestJS 官方文档：Pipes](https://docs.nestjs.com/pipes)，Pipe 的完整机制，包括自定义 Pipe 和参数级、方法级、全局级三种绑定范围
- [class-validator GitHub](https://github.com/typestack/class-validator)，全部装饰器清单，本文用了七个，需要别的规则来这查

第 1 周手写的 isUser 和今天的 ValidationPipe 是同一件事的两个版本：想法都是「外部数据进门先验」，差别只在一个手写、一个声明。明天 Day 7 复盘，用 curl 把这周所有接口过一遍，你会看到每道边界都立住了。
