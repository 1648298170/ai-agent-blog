# 第 5 周 · Day 4：RBAC 角色权限——谁能进，写在门口

> 对应手册任务：学习「RBAC：角色、权限、`@Roles()` 装饰器」，动手「定义 admin/user 角色，实现 RolesGuard」，当日产出「角色权限控制」。本篇只解决一个问题：JWT 链路通了之后，所有持 token 的用户权限一模一样，谁登录了都能删任意用户。要让服务端分得清「普通用户只动自己的数据，管理员管所有人」，而且权限检查集中在一处，不是散落在每个接口里各写一个 if。

## 今日目标

1. 说得清认证和授权的分界，以及 ACL→RBAC→ABAC 的演进逻辑，为什么大多数系统停在 RBAC
2. 掌握三个关键点：Prisma enum 角色字段、`@Roles()` 装饰器与 Reflector 的元数据流、RolesGuard 的实现与守卫执行顺序
3. 独立完成角色权限控制：种一个 admin 账号，普通用户调管理接口收到 403，admin 一路绿灯

## 概念讲解：为什么需要 RBAC

Day 1 留过一句话：认证回答「你是谁」，授权回答「你能做什么」，顺序永远是先认证后授权。这三天链路全通了：登录签发 token，JwtAuthGuard 验签，`/users/me` 认人，refresh 续期。「你是谁」已经解决，但「你能做什么」至今没人管——只要 token 有效，任何登录用户都能调 `DELETE /users/1` 删掉别人。jerry 和老板在接口面前人人平等，这不叫安全，叫裸奔没跑完。

假设你已经给用户加了个角色标记（字段的事下一节说），最直觉的改法是在每个接口里加判断：

```ts
@Delete(':id')
remove(@Param('id', ParseIntPipe) id: number, @Req() req) {
  if (req.user.role !== 'admin') {
    throw new ForbiddenException('只有管理员能删用户');
  }
  // 删除逻辑
}
```

三个接口这么写还能忍，三十个呢？权限检查和业务逻辑搅在一起，改一次规则要满文件找 if，漏掉一处就是一个后门。你真正想要的是两件事分开：**谁可以进，写在门口；怎么检查，集中一处。**

再说「谁能干什么」该怎么建模。业界三代方案，各用一句话说清：

- **ACL（访问控制列表）**：权限直接挂到人身上。张三 →〔删用户、看报表〕。用户一多这张表就爆炸，改一次权限要逐个人点。
- **RBAC（基于角色的访问控制）**：中间垫一层角色。权限挂角色（管理员 →〔删用户〕），人领角色（张三 → 管理员）。要给五十个人提权，改一个角色的定义就够了。
- **ABAC（基于属性的访问控制）**：规则写成属性表达式，「部门是财务 且 在工作时间 且 文档属于本组」。最灵活，实现和排错成本也最高，云厂商的 IAM 是它的主场。

演进逻辑一句话：ACL 是「人 → 权限」，RBAC 在中间垫了一层变成「人 → 角色 → 权限」，ABAC 把角色换成任意属性的组合。角色数量远小于用户数量，权限规则变更只发生在角色定义一处、全体成员立即生效——这就是 RBAC 的性价比，也是它霸占中后台系统的原因。这个项目两个角色够用：USER 管自己，ADMIN 管所有人。

## 核心知识

### 1. User 加 role 字段：enum，不是 String

```prisma
enum Role {
  USER
  ADMIN
}

model User {
  id       Int    @id @default(autoincrement())
  email    String @unique
  name     String
  password String
  role     Role   @default(USER) // 新增
}
```

其他字段以你第 4 周的 schema 为准，关键是 `enum Role` 和 `role` 这一行。

关键在用 enum 而不是 String：数据库层面把取值限死为 USER 或 ADMIN，手滑写成 'ADIMN' 直接插不进去。要是用 String，拼错的角色安静入库，比对时永远不相等，表现为「明明是管理员却处处 403」，查到你想哭。`@default(USER)` 同样重要：新注册用户自动是普通角色，注册接口一行都不用改。

`npx prisma migrate dev --name add-user-role` 生成迁移后，Prisma 会同步产出 TS 里的 `Role` 类型，从 `@prisma/client` 导入，'USER' 和 'ADMIN' 从此是类型层面的合法值，装饰器和 Guard 里都能用。

### 2. @Roles() 装饰器：谁可以进，写在门口

```ts
// src/common/decorators/roles.decorator.ts
import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
```

用法，注意装饰器可以叠在两级上：

```ts
@Roles(Role.ADMIN) // Controller 级：整个控制器默认都要 ADMIN
@Controller('admin')
export class AdminController {
  @Get('stats')
  stats() {
    return { users: 128 }; // 没标方法级，继承 Controller 级的 ADMIN
  }

  @Get('logs')
  @Roles(Role.ADMIN, Role.USER) // 方法级：覆盖 Controller 级，放宽为两种角色都能进
  logs() {
    return [];
  }
}

@Controller('users')
export class UsersController {
  @Delete(':id')
  @Roles(Role.ADMIN) // 只给这一个路由上锁
  remove(@Param('id', ParseIntPipe) id: number) {
    // 删除逻辑
  }

  @Get('me')
  me(@Req() req) {
    return req.user; // 没标 @Roles：不做角色限制，登录即可
  }
}
```

原理一句话：`@Roles(Role.ADMIN)` 执行时，把 `['ADMIN']` 这条**元数据**挂到路由（方法或类）身上。元数据是「贴在门上的标签」，不参与任何逻辑，专门等「读它的人」来取。这个装饰器只负责贴标签，读标签、拦人的是下一节的 RolesGuard。声明和检查分离，两边各自复用。

### 3. RolesGuard：读标签、比对、放行或拦截

```ts
// src/common/guards/roles.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service'; // 按你项目的实际路径调整
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. 读标签：先看方法级，再看 Controller 级，方法级优先
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true; // 没贴 @Roles 的路由，不做角色限制
    }

    // 2. 拿当前用户（Day 2 的 JwtAuthGuard 已经验过签，挂好了 request.user）
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.userId; // 字段名对齐你 JwtStrategy validate() 的返回值
    if (!userId) {
      throw new UnauthorizedException('先过认证，再谈权限');
    }

    // 3. 查库拿当前角色，比对
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException(`该接口需要角色：${required.join(' 或 ')}`);
    }
    return true;
  }
}
```

三个细节值得停一停。

**为什么用 getAllAndOverride。** Reflector 取两级标签有两种策略：`getAllAndMerge` 是合并，Controller 级和方法级的角色取并集；`getAllAndOverride` 是方法级优先、直接覆盖 Controller 级。本文选覆盖，因为它符合直觉：方法上明确写了 @Roles，就当方法说了算。

**为什么查库而不是把 role 塞进 token。** Day 1 的坑 5 说过，token 是快照不是直播。role 要是写进 payload，某天你把一个管理员降级成普通用户，他手里的旧 token 还揣着 ADMIN，权限照旧，要等 token 过期才收手。查库慢一点点（一次主键查询），换来「降权立刻生效」，学习项目这点开销毫无感觉。

**为什么没标签就放行。** @Roles 是可选约束：贴了标签的门查角色，没贴的只受全局 JwtAuthGuard 管（登录就能进）。这样 RolesGuard 可以放心注册成全局，不会把公开接口也拦下来。

### 4. 守卫顺序：先认证，后授权

两个 Guard 都要跑，顺序是死规矩。全局注册时，注册顺序就是执行顺序：

```ts
// app.module.ts 的 providers 里
{
  provide: APP_GUARD,
  useClass: JwtAuthGuard, // 先：验签，把 user 挂到 request 上
},
{
  provide: APP_GUARD,
  useClass: RolesGuard, // 后：读 request.user，查库比对角色
},
```

Day 2 的 JwtAuthGuard 你可能是全局注册的，也可能是按 `@UseGuards(JwtAuthGuard)` 挂在 Controller 上的。前者只需照上面追加 RolesGuard 的注册；后者在 Controller 上写 `@UseGuards(JwtAuthGuard, RolesGuard)`，括号里的顺序同样是执行顺序。

顺序为什么不能反：RolesGuard 干活的前提是 request.user 已经存在，而它由 JwtAuthGuard 负责。反过来，RolesGuard 先跑，request.user 是 undefined，所有带 @Roles 的路由全部按未认证拦下，没有请求能到达业务逻辑。「认证是授权的前提」这句话，落到代码上就是注册顺序这一行。

### 5. 401 和 403：一字之差，处理完全不同

| 状态码 | 语义 | 触发场景 | 前端该做什么 |
| --- | --- | --- | --- |
| 401 Unauthorized | 未认证（不知道你是谁） | 没带 token、token 过期、伪造 | 静默走 refresh（Day 3 链路）或跳登录页 |
| 403 Forbidden | 已认证但没权限 | token 有效，角色不够 | 提示「无权限」，别跳登录页 |

401 的名字是 HTTP 规范的历史遗留，它真正的意思是 unauthenticated（未认证）。记法：**401 是「我不认识你」，403 是「我认识你，但你不行」。** 前者重新登录可能救，后者重新登录一万次还是 403，问题不在身份，在权限。

## 动手任务：角色权限控制一步一步

拆成 6 步，全程约 30 分钟。

**第 1 步：加 role 字段并迁移。** schema 照核心知识第 1 节改，然后执行：

```bash
npx prisma migrate dev --name add-user-role
```

迁移完用 `npx prisma studio` 打开看一眼，User 表多出 role 列，存量用户默认全填 USER。

**第 2 步：写 @Roles 装饰器。** 新建 `src/common/decorators/roles.decorator.ts`，代码照核心知识第 2 节，不到 10 行。

**第 3 步：写 RolesGuard。** 新建 `src/common/guards/roles.guard.ts`，代码照核心知识第 3 节。两处按你项目调整：PrismaService 的 import 路径；request.user 上用户 id 的字段名，Day 2 的 JwtStrategy `validate()` 返回什么，这里就读什么。

**第 4 步：注册守卫，确认顺序。** 全局注册照核心知识第 4 节的 providers 写，RolesGuard 必须排在 JwtAuthGuard 后面。

**第 5 步：种一个 admin 账号。** 光有 role 字段，全库都是 USER，没人能过 ADMIN 的门。新建 `prisma/seed.ts`：

```ts
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs'; // 注意是 bcryptjs，和 Day 1 保持一致

const prisma = new PrismaClient();

async function main() {
  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {}, // 已存在就什么都不动
    create: {
      email: 'admin@example.com',
      name: 'admin',
      password: await bcrypt.hash('admin123456', 10),
      role: Role.ADMIN,
    },
  });
  console.log('admin 已就位：admin@example.com / admin123456');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

用 upsert 而不是 create：种子脚本会被反复执行，create 碰到重复邮箱直接报错，upsert 保证「有就不动，没有才建」。再在 package.json 里告诉 Prisma 种子脚本在哪：

```json
"prisma": {
  "seed": "ts-node prisma/seed.ts"
}
```

然后执行 `npx prisma db seed`。

**第 6 步：给接口挂 @Roles，三个请求验证。** 在你现有的删除接口上叠一行装饰器：

```ts
@Delete(':id')
@Roles(Role.ADMIN) // 就叠这一行
remove(@Param('id', ParseIntPipe) id: number) {
  // 删除逻辑保持你第 4 周的原样
}
```

重启服务，依次发三个请求：

```bash
# 请求 1：不带 token → JwtAuthGuard 拦下，401
curl -X DELETE http://localhost:3000/users/1

# 请求 2：普通用户的 token → 认证通过，RolesGuard 拦下，403
curl -X DELETE http://localhost:3000/users/1 \
  -H "Authorization: Bearer <jerry的token>"
# {"message":"该接口需要角色：ADMIN","error":"Forbidden","statusCode":403}

# 请求 3：admin 的 token → 两个守卫都放行
curl -X DELETE http://localhost:3000/users/1 \
  -H "Authorization: Bearer <admin的token>"
```

三个请求分别踩中 401、403、放行，把响应和第 5 节那张表对上号，这条链路你就真的通了。

::: tip 验证前的准备
admin 的 token 用 admin@example.com / admin123456 走一遍 `/auth/login` 就有。请求 3 真的会删掉 id 为 1 的用户，拿测试库练，别拿有真数据的库。
:::

## 常见踩坑

**坑 1：守卫顺序反了，全线 401。** RolesGuard 注册在 JwtAuthGuard 前面，request.user 还没挂上就有人读，undefined 按未认证处理，所有带 @Roles 的接口无一幸免。排查办法：401 发生在「明明带了合法 token」的请求上，就去查注册顺序。

**坑 2：分不清 getAllAndOverride 和 getAllAndMerge。** Controller 标 `@Roles(Role.ADMIN)`、方法标 `@Roles(Role.USER)`，用 Override 是方法级说了算（USER 可进，ADMIN 反而不行），用 Merge 是取并集（两个都行）。两种都是合法设计，选错的表现是「权限忽宽忽窄，跟标签对不上」。想清楚要覆盖还是要合并，再下手。

**坑 3：把角色校验托付给前端。** 前端按角色藏按钮、路由守卫拦页面，都只是体验优化：接口暴露在公网，curl 一分钟就能绕过界面直接打。判断标准只有一条：**前端藏 UI 是为了让产品好用，后端校验才是为了系统安全。** 两者都得做，但防线只认后端。

**坑 4：改了角色，老 token 还揣着旧权限。** 图省事把 role 写进 JWT payload 不是不行，省一次查库，但天花板在那：token 是快照，降级管理员后他手里的 ADMIN 还能用，直到过期。所以本文的 RolesGuard 每次查库。真要两全，可以 role 进 token 走快路径、查库做兜底，或者把敏感操作的 token 有效期调短。

**坑 5：403 之后引导用户重新登录。** 看到 403 就跳登录页，用户重新登录、再试、再 403，死循环。401 才该触发 refresh 或重登录，403 的正确处理是明确提示「当前账号没有这个权限」。把两种状态码的处理写进前端响应拦截器，别散在各页面里。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 认证和授权分别回答什么问题？401 和 403 分别对应哪一个？

::: details 参考答案
认证回答「你是谁」，对应 401（未认证：没带 token、过期、伪造）；授权回答「你能做什么」，对应 403（已认证但角色不够）。顺序永远是先认证后授权，代码上体现为 JwtAuthGuard 先于 RolesGuard 执行。
:::

2. ACL、RBAC、ABAC 各用一句话说清，为什么大多数系统停在 RBAC？

::: details 参考答案
ACL 把权限直接挂到人身上；RBAC 中间垫一层角色，人领角色、权限挂角色；ABAC 把角色换成任意属性组合的表达式。RBAC 性价比最高：角色数远小于用户数，权限规则变更只改角色定义一处、全体成员立即生效；ABAC 灵活但实现和排错成本高，一般系统用不上。
:::

3. `@Roles(Role.ADMIN)` 的信息存在哪？RolesGuard 怎么拿到它？

::: details 参考答案
SetMetadata 把 `['ADMIN']` 作为元数据挂到路由（方法或 Controller 类）上，像贴在门上的标签，不参与逻辑。RolesGuard 在运行时用 `Reflector.getAllAndOverride(ROLES_KEY, [handler, class])` 读出，方法级优先于 Controller 级，都没有则返回 undefined、直接放行。
:::

4. JwtAuthGuard 为什么必须在 RolesGuard 之前执行？反了会怎样？

::: details 参考答案
RolesGuard 比对角色依赖 request.user，而它由 JwtAuthGuard 验签后挂上。顺序反了，RolesGuard 先跑时 request.user 是 undefined，全部按未认证拦截，所有带 @Roles 的路由无差别 401。全局 APP_GUARD 的执行顺序等于注册顺序，`@UseGuards(A, B)` 的执行顺序等于括号里的顺序。
:::

5. 前端已经按角色隐藏了按钮，后端为什么还要校验？

::: details 参考答案
前端藏 UI 只是体验优化：接口暴露在公网，绕过界面用 curl 直接请求毫无门槛，改一下本地代码就能调出隐藏功能。安全的判断标准不是「界面上有没有入口」，而是「后端拦不拦」。前端负责好用，后端负责安全，防线只认后端。
:::

## 延伸阅读

- [NestJS 官方文档：Authorization](https://docs.nestjs.com/security/authorization)，本篇 @Roles + RolesGuard 的原始出处。官方版把角色放进 payload，和本文的查库版对照着看，正好复习 Day 1 坑 5 的「快照论」
- [NestJS 官方文档：Guards](https://docs.nestjs.com/guards)，执行顺序、全局注册、元数据与 Reflector 的完整说明
- [MDN：403 Forbidden](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status/403)，顺手把同目录的 401 也读了，两个状态码的语义边界一次搞清
- [Prisma 官方文档：Database Seeding](https://www.prisma.io/docs/orm/prisma-migrate/workflows/seeding)，种子脚本的进阶玩法：多环境种子、给集成测试造数据

今天产出的 RolesGuard 和 @Roles() 留好，Day 5 接 OAuth 第三方登录时，回调里新建的用户直接落进默认角色 USER；将来要加 moderator 之类的第三个角色，也只是 enum 加一项、@Roles 换个参数的事。
