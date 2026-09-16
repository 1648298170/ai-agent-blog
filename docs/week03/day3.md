# 第 3 周 · Day 3：NestJS 起步——给 monorepo 补上后端这一半

> 对应手册任务：学习「NestJS 环境搭建 + 模块/控制器/服务分层」，动手用 Nest CLI 创建 `apps/api`，写一个 HealthController 返回 `{ status: 'ok' }`，当日产出「可运行的 NestJS 项目」。本篇只解决一个问题：给已经跑着 Next.js 的 monorepo 补一个能随业务长大的后端服务，而不是再写一个三个月后没人敢动的 Express 脚本。

## 今日目标

1. 说得清企业后端为什么选 NestJS，裸 Express 从哪一步开始失控
2. 记住三个角色的分工：Module 装配、Controller 接客、Provider 干活，以及它们对应的文件约定
3. 独立完成 `apps/api`：CLI 创建、HealthController 返回 `{ status: 'ok' }`、请求验证通过、接进根目录的 turbo 管道

## 概念讲解：为什么后端选 NestJS

裸写 Express 的起点都很爽。三十行 `app.js`，`app.get` 挂两个路由，一个能跑的后端就有了。

三个月后再看这个文件：路由函数里查数据库、拼响应、写日志；鉴权逻辑散落在几个中间件里；想给某个函数写单测，发现它和 `req`/`res` 缠在一起，不起真服务根本测不了。新人接手更惨，一个接口的实现分散在三个文件，靠全文搜索才能拼出全貌。

问题不在 Express 弱，在于它不给你任何结构：文件怎么分、依赖怎么传、边界画在哪，全靠团队自觉。而自觉是最不可靠的东西。

NestJS 就是来解决这件事的。它默认跑在 Express 之上（`@nestjs/platform-express`），HTTP 处理还是那套，只是用三条约定把结构焊死：

1. **装饰器声明路由。** `@Get()` 往方法上一挂，方法体里只剩业务，不再手写 `app.get(path, handler)`。
2. **依赖注入。** 需要哪个服务，构造函数里声明就行，框架负责创建实例、传进来。服务可替换、可 mock，单测不用起服务。
3. **模块化。** 每个功能一个 `@Module`，应用的骨架在代码里一眼可见，不靠人脑记。

打个比方：裸 Express 给你一堆木材，房子怎么搭自己定；NestJS 给你一套带承重墙的户型，装修随意，拆墙不行。恰恰是不许拆墙，项目才活得久。对企业来说还有一层：NestJS 全 TypeScript，装饰器写法和 Next.js 一脉相承，前后端一个心智，交接成本低。

## 核心知识

本节的代码就是最终要写进 `apps/api` 的形状，动手任务时直接照抄。

### 1. Module / Controller / Provider：三个角色一台戏

拿餐厅打比方：Controller 是服务员，接单、传菜，不炒菜；Provider（通常叫 Service）是厨师，真正干活；Module 是排班表，登记这家店有哪些服务员和厨师，没有登记的人不能上岗。

对应到文件约定：

```text
src/
├─ app.module.ts              # 根模块：整个应用的装配清单
├─ app.controller.ts          # 脚手架自带示例，先不动
├─ app.service.ts             # 同上
└─ health/                    # 一个功能一个目录
   ├─ health.controller.ts    # GET /health
   └─ health.service.ts       # 健康检查的真实逻辑
```

职责红线只有一条：Controller 不碰数据库，Service 不碰 `req`/`res`。守住这条线，Service 的每个方法不依赖 HTTP 概念就能单测，分层才没有白分。

### 2. 装饰器：把配置写在类旁边

```ts
import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth() {
    return this.healthService.getHealth();
  }
}
```

装饰器本质上就是函数，调用它会给类贴上元数据。Nest 启动时读这些元数据：`@Controller('health')` 是路由前缀，`@Get()` 补上后缀，两者拼出 `GET /health`。方法返回的对象自动序列化成 JSON，不用自己 `res.send`。

再看构造函数那行，它一次干了两件事：`private readonly` 是 TypeScript 的参数属性简写，声明依赖的同时把它变成类成员；而这个依赖的实例由 Nest 的 DI 容器造好塞进来。你从头到尾没写 `new HealthService()`，这就是依赖注入。

### 3. main.ts：四行引导代码背后发生了什么

```ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
```

`NestFactory.create(AppModule)` 一执行，框架拿着根模块这份装配清单干了一串事：实例化所有 Provider，把依赖注入各个 Controller，扫描装饰器生成路由表，最后 `listen` 把端口打开。从这一刻起，请求进来走的是框架铺好的路：路由匹配 → Controller → Service → 返回。

## 动手任务：创建 apps/api 一步一步

手册任务：用 Nest CLI 创建 `apps/api`，写 HealthController 返回 `{ status: 'ok' }`，接入根目录 turbo 管道。拆成 5 步，全程约 25 分钟。

**第 1 步：脚手架，一次装对。** 在仓库根目录（有 `pnpm-workspace.yaml` 的那一层）执行：

```powershell
npx @nestjs/new@latest apps/api --package-manager pnpm --skip-git --skip-install --strict
pnpm install
```

首次运行 npx 会问是否安装包，输 `y` 回车。四个参数各有用处：

- `--package-manager pnpm`：不指定的话 CLI 默认用 npm，会在 workspace 里另起炉灶
- `--skip-git`：monorepo 已经有 git 了，再嵌套一个 `.git` 目录就是事故
- `--skip-install`：monorepo 的关键。不让它在 `apps/api` 里就地安装，装依赖回根目录统一走 workspace，版本收进根 `pnpm-lock.yaml`
- `--strict`：启用严格 TypeScript 配置，和第 1 周的要求对齐

装过全局 CLI 的话，等价命令是 `nest new apps/api --package-manager pnpm --skip-git --skip-install --strict`。

**第 2 步：认识脚手架给的东西。** 展开看结构：

```text
apps/api/
├─ src/
│  ├─ main.ts               # 引导：NestFactory + listen
│  ├─ app.module.ts         # 根模块
│  ├─ app.controller.ts     # 示例路由 GET /
│  ├─ app.controller.spec.ts
│  └─ app.service.ts        # 示例服务
├─ test/                    # e2e 测试
├─ nest-cli.json
├─ tsconfig.json
└─ package.json
```

这套示例本身就是一个完整的最小闭环，先读懂再动手：`main.ts` 引导，`app.module.ts` 登记，controller 和 service 干活。接下来不动它们，另起一个 `health` 目录，按同样的套路写一遍，肌肉记忆才算建立。

**第 3 步：先写厨师，再写服务员。** 先写被依赖的一方。新建 `apps/api/src/health/health.service.ts`：

```ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}
```

`@Injectable()` 的意思是：这个类注册为可注入的 Provider，DI 容器接管它的创建。再新建 `apps/api/src/health/health.controller.ts`，内容就是核心知识第 2 节那段，照抄即可。

**第 4 步：登记进 AppModule，改端口，启动。** 编辑 `apps/api/src/app.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';

@Module({
  imports: [],
  controllers: [AppController, HealthController],
  providers: [AppService, HealthService],
})
export class AppModule {}
```

没登记的角色上不了岗，这一步不能省。然后把 `main.ts` 里的端口从 3000 改成 4000（`process.env.PORT ?? 4000`），原因很现实：`apps/web` 的 dev 服务默认占 3000，两个都要常驻，撞车必炸。启动：

```powershell
pnpm --filter api start:dev
```

看到 `Nest application successfully started` 就成了。

**第 5 步：验证，接入 turbo 管道。** 另开一个终端：

```powershell
Invoke-RestMethod http://localhost:4000/health
```

输出 `status` 列是 `ok`，任务完成。想看原始 JSON 就用 `curl.exe http://localhost:4000/health`。

最后一步是让 api 加入 monorepo 的统一调度。脚手架的开发脚本叫 `start:dev`，而 turbo 按脚本名找活干，和 web 的 `dev` 不一致就会被跳过。打开 `apps/api/package.json`，把脚本名对齐：

```json
"scripts": {
  "dev": "nest start --watch",
  "build": "nest build",
  "start:prod": "node dist/main.js"
}
```

再确认根目录 `turbo.json` 的 `build` 任务把 api 的产物目录算进缓存（turbo v1 的配置键叫 `pipeline`，v2 叫 `tasks`）：

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

根目录的 `"dev": "turbo dev"`、`"build": "turbo build"` 搭 monorepo 时就配好了，不用动。在根目录跑 `pnpm build`，看到 `apps/api/dist` 生成，管道正式打通。以后 `pnpm dev` 一条命令，web 和 api 一起跑。

::: tip 本地起停
dev 是常驻进程，`Ctrl+C` 停。如果关了终端端口还占着，用 `netstat -ano | findstr :4000` 找到最后一列的 PID，再 `taskkill /PID 那个数字 /F`。
:::

## 常见踩坑

**坑 1：端口撞车，报 EADDRINUSE。** Next.js 和 Nest 的默认端口都是 3000，谁后起谁炸，报错 `listen EADDRINUSE`。规则很简单：每个 app 的端口写死且互相错开，保留 `process.env.PORT` 覆盖口子，部署到不同环境才不用改代码。

**坑 2：忘了在 Module 登记，报 can't resolve dependencies。** 启动时报 `Nest can't resolve dependencies for the HealthController. Please make sure that the argument HealthService at index [0] is available in the AppModule context`。这报错其实把答案写在脸上了：`HealthService` 没进 `providers` 数组。更隐蔽的是反过来忘登记 Controller，不报错，直接 404，你得对着浏览器怀疑人生。排查口诀：404 查 controllers，resolve 报错查 providers。

**坑 3：Controller 里写业务逻辑。** 一个字段的 health 直接 return 当然没事，但业务一复杂，Controller 就会长成新的上帝文件，塞满 SQL 和分支，Service 形同虚设。判断标准就一条：这个方法离开 HTTP 还能不能测？Controller 只做翻译，把请求翻译成 Service 的入参，把返回值翻译成响应，别的都不属于它。

**坑 4：在 apps/api 里直接 npm install。** 子目录里一跑，本地多出一份 `package-lock.json`，依赖和根 `pnpm-lock.yaml` 从此各走各路，版本漂移就这么开始的。monorepo 里的铁律：装依赖永远在根目录，`pnpm add --filter api 包名`，删包同理。

**坑 5：PowerShell 的 curl 不是 curl。** 它是 `Invoke-WebRequest` 的别名，GET 请求能凑合用，但 `-d`、`-H` 这些参数行为完全不同（那边的参数叫 `-Body`、`-ContentType`）。验证接口统一用 `curl.exe`（Windows 10 起自带，写全后缀就会绕过别名）或 `Invoke-RestMethod`，别两套混着用。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Module、Controller、Provider 各自的职责一句话说清。谁来 `new HealthService()`？

::: details 参考答案
Module 是装配清单，登记本模块有哪些控制器和服务；Controller 接请求、调服务、回响应，不写业务；Provider（Service）承载业务逻辑，不碰 HTTP 概念。`new HealthService()` 由 Nest 的 DI 容器完成，业务代码里永远不该出现这个 new。
:::

2. `@Controller('health')` 的参数和 `@Get()` 的参数分别决定 URL 的哪一段？

::: details 参考答案
前者是控制器级前缀，后者在方法上补上剩余路径，两者拼接成完整路由。`@Controller('health')` 加无参 `@Get()` 得到 `GET /health`；如果写成 `@Get('detail')` 就是 `GET /health/detail`。前缀收在控制器里，方法只关心自己的后半段。
:::

3. 启动报 `Nest can't resolve dependencies`，第一反应查哪里？

::: details 参考答案
查报错里点名的那个服务有没有注册进对应 Module 的 `providers` 数组。这是最常见的新手报错，信息也最友好：缺什么、在哪个 Module 缺，都写在报错文本里，照着补一行就好。
:::

4. 为什么在 `apps/api` 目录里直接 `npm install 包名` 是错的？正确命令是什么？

::: details 参考答案
会生成独立于 workspace 的 `package-lock.json`，依赖版本脱离根 `pnpm-lock.yaml` 的管辖，两份锁文件各装各的，迟早漂移出不一致。正确做法是在根目录执行 `pnpm add --filter api 包名`，让 workspace 统一记账。
:::

5. `NestFactory.create(AppModule)` 执行之后、端口可访问之前，框架按什么顺序做了哪几件事？

::: details 参考答案
读根模块的装配清单，实例化所有 Provider，把依赖注入到各个 Controller，扫描装饰器元数据生成路由表，然后 `app.listen` 打开端口。之后每个请求都按「路由匹配 → Controller → Service → 序列化返回」这条链路走。
:::

## 延伸阅读

- [NestJS 官方文档：First Steps](https://docs.nestjs.com/first-steps)，从安装到跑起第一个接口，今天全流程的官方版
- [NestJS 官方文档：Controllers](https://docs.nestjs.com/controllers)，路由、状态码、请求参数的完整规则，`@Controller` 的进阶用法都在这
- [NestJS 官方文档：Providers](https://docs.nestjs.com/providers)，依赖注入的原理和自定义 Provider，读懂它就明白 DI 容器替你干了什么
- [Turborepo 配置参考](https://turbo.build/repo/docs/reference/configuration)，`tasks`、`outputs`、`persistent` 每个字段的确切含义

今天的产出 `apps/api` 留好。`{ status: 'ok' }` 看着单薄，但模块、控制器、服务这副骨架已经立起来了，本周后面给 Agent 接 LLM、做流式接口，都是往这副骨架上挂新目录、新 Module，一行装配搞定。另外，[第 1 周 Day 1](/week01/day1) 写的 `ApiResponse<T>` 很快会在响应包装里派上用场，翻出来复习一下。
