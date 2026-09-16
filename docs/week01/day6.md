# 第 1 周 · Day 6：共享类型包与工具包——packages/shared 规范化

> 手册 Day 6 任务：学习共享类型包与共享工具包；在 packages/shared 中写一个 ApiResponse 类型和 formatDate 工具，两个 app 都能引用；当日产出为跨包引用验证通过。
>
> Day 4 搭出的 shared 只是"能被 import 到"的最简形态。本篇把它规范成真正的包：补全 exports 条件导出，用 tsc 产出 JS 与 .d.ts 双产物，再用 ApiResponse 预演一次前后端契约。

## 今日目标

1. 补齐 packages/shared 的 package.json 与 tsconfig，构建产出 dist（JS + .d.ts）
2. 实现 ApiResponse 泛型家族与 formatDate 工具，用 index.ts 统一导出
3. apps/web 通过 workspace:* 引用，运行时输出正确、类型错误拦得住，双端验证通过

## 概念讲解：为什么类型要放进共享包

先看一个事故剧本。第 2、3 周 apps/api（NestJS）加进来之后，假设 User 这个接口前端定义了一份，后端又定义了一份。某天后端把 phone 字段改名为 mobile：后端编译通过，测试通过，发布。前端那份类型还写着 phone，它编译的是自己的代码，当然也通过。流水线全绿，上线。用户打开个人资料页，手机号一栏空白，工单进来。

两份类型之间没有任何牵制，改掉一边，另一边安静地坏掉，而且要到运行时才暴露。

把 User、ApiResponse 这些"前后端都要用的形状"收进 shared，性质就变了：字段改名改的是全仓库唯一的定义，下一秒所有还在引用旧字段的代码集体编译报错。问题从线上事故降级成编译错误，发现时机从用户端提前到敲代码的那一分钟。这就是单一事实来源（Single Source of Truth）：同一个概念，全仓库只允许存在一处定义。

成本方面几乎白送。类型在编译后会被完整擦除，不占一个字节的运行时体积；formatDate 这类运行时函数虽然会进产物，但没被用到的部分会被打包器摇掉（tree-shaking）。所以"类型 + 少量纯函数"是最划算的共享单位：第 3 周起，前端 fetch 的每个接口返回值都标注为 ApiResponse&lt;T&gt;，shared 就是前后端之间的契约层。

## 核心知识

### 1. 包的 package.json 规范

name 要带作用域，比如 `@my/shared`：`@my` 标明这是内部包，天然不与 npm 公网上的包重名。version 从 0.1.0 起步，内部包虽然不发 npm，语义化版本的习惯从现在养成。type 设为 module，tsc 产出的 ESM 产物才能被 Node 直接执行。

然后是入口三兄弟，很多人卡在这里：

- `main`：最古老的入口字段，只给不认识 exports 的老工具兜底
- `types`：老的类型入口（`typings` 的别名），同样是兜底
- `exports`：现代标准（Node 12.7+），一张表同时管运行时入口和类型入口，配了它，前两个字段基本只是保险

exports 是今天的重点，先把它的核心部分单独摘出来看：

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  }
}
```

"." 这个键表示包的根路径，`import '@my/shared'` 命中的就是它。值是条件对象，里面的键叫"条件"，解析方按声明顺序逐个匹配，命中即停：

- `types`：TypeScript 找类型声明时命中，指向 .d.ts
- `import`：消费方以 ESM 方式导入时命中，指向 .js
- `require`：CJS 的 require 命中，第 3 周 NestJS 真需要时再补

两条纪律记牢。其一，types 永远放第一位：TS 同样按顺序匹配条件，如果 import 排在前面，TS 命中 .js 就停手，类型凭空丢失。其二，exports 是白名单，一旦存在，没列出来的子路径一律导入不了，这是刻意设计的封闭保护，不是 bug。

完整的 package.json 如下，可直接抄：

```json
{
  "name": "@my/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

private 防止哪天手滑把它发上 npm；files 声明发布时只带 dist；scripts.build 用 tsc 编译。

### 2. TypeScript 双构建：JS 和 .d.ts 各司其职

双构建指一次 tsc 同时产出两样东西：给运行时的 JS，给编译器的 .d.ts 类型声明。tsconfig 如下：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"]
}
```

关键是 declaration: true，它让每个 .ts 文件额外生成一份同名 .d.ts。

为什么消费方要 .d.ts，而不是直接读 .ts 源码？因为 web 的 Vite、未来的 NestJS 在编译自己代码时，只需要知道 shared 里每个导出"长什么样"，不需要也不应该重新编译 shared 的实现。.d.ts 只描述形状（接口、函数签名），没有实现代码，解析快、体积小。而 NodeNext 解析规则下，包入口期望的正是 .js 加 .d.ts 的组合，直接指向 .ts 源文件走不通。

outDir 与 rootDir 决定产物结构：rootDir 锁定 src，outDir 指向 dist，构建后 dist 的目录是 src 的镜像。declarationMap 和 sourceMap 属于体验加分项：在消费方项目里点进 shared 的代码，能直接跳回 src 源文件。

### 3. 目录组织：类型、工具、桶文件

```text
packages/shared/
├── src/
│   ├── index.ts
│   ├── types/
│   │   └── api.ts
│   └── utils/
│       └── formatDate.ts
├── dist/              # 构建产物，进 .gitignore
├── package.json
└── tsconfig.json
```

src/types/api.ts 放"形状"：ApiResponse 一家子和 Paginated。src/utils/formatDate.ts 放纯函数：无副作用、不依赖任何框架，哪天换框架它照样能用。src/index.ts 是桶文件（barrel），把内部模块统一 re-export，对外只有一个门面。

桶文件的取舍一句话：它让消费方一行 import 拿到全部导出，代价是 `export *` 会削弱 tree-shaking（打包器对具名导出的静态分析更准）。内部包对体积不敏感，方便优先，哪天真要抠体积再拆子路径导出。

### 4. 消费方如何引用

apps 这边只需要三步：

1. apps/web/package.json 的 dependencies 加上 `"@my/shared": "workspace:*"`，然后在仓库根目录执行 pnpm install。pnpm 会在 apps/web/node_modules 里建一个指向 packages/shared 的软链接。workspace:* 的含义是：这个依赖永远取工作区里的本地包，绝不去 registry 下载
2. apps/web 的 tsconfig 不需要为 shared 做特殊配置，Vite 模板默认的 moduleResolution: "bundler" 认识 exports 表；用 NodeNext 也一样
3. 写 import：

```ts
import { formatDate, type ApiResponse } from '@my/shared';
```

一条 import 语句背后是两次独立解析，分开看就明白 exports 两个条件各自的用途：

- 运行时：Vite 或 Node 读 `import` 条件，加载 dist/index.js，formatDate 从这里来
- 类型期：TS 读 `types` 条件，加载 dist/index.d.ts，ApiResponse 从这里来

这也解释了一个经典怪象：types 条件漏配时，代码能跑，类型却悄悄变成 any。

## 动手任务：把 shared 做成规范包并双端验证

### ① 规范 packages/shared/package.json

把 Day 4 的最简配置整体替换为上文"核心知识 1"里那份完整 package.json。如果根目录没装过 TypeScript，顺手装上：

```powershell
pnpm --filter "@my/shared" add -D typescript
```

### ② 写 tsconfig.json

新建 packages/shared/tsconfig.json，内容照抄"核心知识 2"的配置。

### ③ 实现 ApiResponse 与 formatDate

新建 src/types/api.ts：

```ts
/**
 * 接口统一返回结构。
 * 第 3 周 apps/api（NestJS）的每个接口都包一层这个结构，
 * data 的具体类型由泛型参数 T 决定。
 */
export interface ApiResponse<T = unknown> {
  /** 业务状态码：0 成功，非 0 失败 */
  code: number;
  /** 人类可读的提示信息 */
  message: string;
  /** 业务数据本体 */
  data: T;
}

/** 成功响应：code 收窄为字面量 0，data 必为 T */
export interface ApiSuccess<T> extends ApiResponse<T> {
  code: 0;
}

/** 失败响应：data 必为 null */
export interface ApiError extends ApiResponse<null> {
  code: 1;
}

/** 接口的真实返回：成功或失败，用 res.code === 0 收窄 */
export type ApiResult<T> = ApiSuccess<T> | ApiError;

/** 分页结构，列表接口的 data 常用它包裹 */
export interface Paginated<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}
```

ApiResult 是联合类型，code 为字面量 0 或 1，消费方用 `if (res.code === 0)` 就能自动收窄。真实项目的错误码往往是一段区间，届时可以补一个 isOk 类型守卫，思路不变。

再新建 src/utils/formatDate.ts：

```ts
const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 格式化日期。
 * @param input   Date 实例、毫秒时间戳，或可被 Date 解析的字符串
 * @param pattern 占位符：YYYY、MM、DD、HH、mm、ss
 */
export function formatDate(
  input: Date | number | string,
  pattern = 'YYYY-MM-DD HH:mm',
): string {
  const date = input instanceof Date ? input : new Date(input);

  // 解析失败：原样返回（取舍见下文）
  if (Number.isNaN(date.getTime())) {
    return String(input);
  }

  const tokens: Record<string, string> = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1), // 月份从 0 开始，必须 +1
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };

  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token]);
}
```

非法输入的取舍：这里对解析失败的输入返回原值字符串。两种流派，抛错更严格，问题在开发期就炸出来；返回原值更宽容，展示层的坏数据不至于把页面渲染搞崩。工具库一般选宽松，业务侧再决定怎么处理，这里选宽松。

::: warning 秒级时间戳
formatDate 只认毫秒时间戳。传 10 位的秒级时间戳（如 1799999999）会被解析成 1970 年 1 月，因为 JS 的 Date 一律按毫秒计。拿到秒级先乘 1000。
:::

### ④ index.ts 桶导出

新建 src/index.ts：

```ts
export * from './types/api.js';
export * from './utils/formatDate.js';
```

::: tip 为什么 .ts 文件里写的是 .js？
NodeNext 模式要求 ESM 的相对导入必须带明确的文件扩展名，而 tsc 编译时会把 ./types/api.js 对应回源码的 ./types/api.ts。记住口诀：引谁，就写它编译后的文件名。
:::

### ⑤ 构建产出 dist

在仓库根目录执行：

```powershell
pnpm turbo build --filter=@my/shared
```

turbo 会按 Day 5 配好的管道先构建依赖再构建目标，命中缓存会提示 cache hit，属于正常。构建完检查产物，dist 应该长这样：

```text
packages/shared/dist/
├── index.js
├── index.d.ts
├── index.js.map
├── index.d.ts.map
├── types/
│   ├── api.js
│   └── api.d.ts
└── utils/
    ├── formatDate.js
    └── formatDate.d.ts
```

也可以用等价的 pnpm 原生命令：`pnpm --filter "@my/shared" build`。

### ⑥ apps/web 引用并运行验证

先接线：apps/web/package.json 的 dependencies 加上 `"@my/shared": "workspace:*"`，仓库根目录执行 pnpm install。

然后在任意会执行的文件里（比如入口文件）加几行：

```ts
// apps/web/src/main.ts（或任意会被执行的文件）
import { formatDate } from '@my/shared';

console.log(formatDate(new Date()));                                    // 2026-09-16 15:04
console.log(formatDate('2026-09-16T15:04:30', 'YYYY年MM月DD日 HH:mm')); // 2026年09月16日 15:04
console.log(formatDate('不是日期'));                                     // 不是日期（原样返回）
```

启动 dev server，浏览器控制台应看到对应输出。再用 Node 单独验证运行时链路：

```powershell
# 在 apps/web 目录下执行
node -e "import('@my/shared').then(m => console.log(m.formatDate(Date.now())))"
```

能打印出当前时间，说明软链、exports、dist 产物整条链都是通的。手册说的"跨包引用验证通过"，指的就是运行时和类型这两条链路都通。

### ⑦ 模拟一次前后端契约

不真的建 apps/api（NestJS 第 3 周才装），用"假接口"在 web 里把契约演示出来。手册要求"两个 app 都能引用"，目前仓库里只有 apps/web 一个消费方，第二个就是第 3 周的 apps/api，今天把契约备好，到时 shared 一行不用改。

新建 apps/web/src/api/user.ts：

```ts
import type { ApiResult } from '@my/shared';

/** User 只定义一次，第 3 周 apps/api 直接从 @my/shared 引走 */
export interface User {
  id: number;
  name: string;
  email: string;
}

/** 假接口：第 3 周把 Promise.resolve 换成真的 fetch('/api/users/1') */
export function fetchUser(): Promise<ApiResult<User>> {
  return Promise.resolve({
    code: 0,
    message: 'ok',
    data: { id: 1, name: 'Jerry', email: 'jerry@example.com' },
  });
}
```

用的时候：

```ts
import { fetchUser } from './api/user';

async function loadUser() {
  const res = await fetchUser();
  if (res.code === 0) {
    // 这个分支里 res.data 已收窄为 User
    console.log(`用户：${res.data.name}（${res.data.email}）`);
  } else {
    console.error(`失败：${res.message}`);
  }
}

loadUser();
```

把鼠标悬停在 res.data 上，类型显示 User，敲 `res.data.` 会提示 id、name、email：这就是契约在编辑器里的样子。

### ⑧ 故意传错，验证类型在岗

随便找个文件临时写上：

```ts
import { formatDate, type ApiResponse } from '@my/shared';

// 泛型参数是 string，data 却给了 number
const bad: ApiResponse<string> = {
  code: 0,
  message: 'ok',
  data: 42, // 标红：不能将类型"number"分配给类型"string"
};

// formatDate 不接受布尔值
console.log(formatDate(true)); // 标红：类型"boolean"不能赋给"Date | number | string"
```

编辑器立刻标红；如果项目配了 tsc 检查（如 vue-tsc --noEmit 或 tsc -b），构建也会被拦下。注意类型只在编译期存在，运行时不会拦你，所以将来接真实接口时还要加运行时校验，那是后面几周的话题。验证完把这两段删掉。

### ⑨ 提交

先确认 dist 被忽略（根目录 .gitignore 有 dist 这一行即可），然后：

```powershell
git add packages/shared apps/web pnpm-lock.yaml
git commit -m "feat(shared): 规范化共享包，新增 ApiResponse 与 formatDate"
```

想写详细一点，可以带正文：

```text
feat(shared): 规范化共享包，新增 ApiResponse 与 formatDate

- package.json 补全 exports 条件导出与 files 白名单
- tsc 构建产出 dist（JS + .d.ts）
- apps/web 通过 workspace:* 引用，完成类型与运行时双验证
```

## 常见踩坑

**1. 只配 main 没配 exports，或配了 exports 却想导子路径。** `import '@my/shared/types/api'` 直接报 ERR_PACKAGE_PATH_NOT_EXPORTED，因为 exports 是白名单，"." 之外的路径没列出就是封死。解法二选一：统一从根入口导入，或给 exports 补一条 `"./types/api"` 子路径。

**2. 改了 shared 的类型，消费方没反应。** shared 是"构建产物消费"，改源码必须重新 build；turbo 有缓存，怀疑缓存作怪就加 --force 强制重建。VSCode 的 TS server 也会缓存旧的 .d.ts，Ctrl+Shift+P 执行 TypeScript: Restart TS Server 常能药到病除。

**3. 月份差 1 或没补零。** JS 的 Date 月份从 0 计数，getMonth() 返回 0 到 11，显示前必须加 1；再加 padStart 补零，否则用户看到 2026-9-16 这种半成品。构造函数同理，new Date(2026, 8, 16) 是 9 月 16 日。

**4. exports 里 types 条件没放最前。** TS 按声明顺序匹配条件，import 排在前面时 TS 命中 .js 即停止，不再找类型声明，所有导入静默降级为 any。types 永远第一个。

**5. 依赖写成 "^0.1.0" 而不是 "workspace:\*"。** pnpm 会去 npm registry 找 @my/shared，内部包没发布过，安装直接失败；碰巧有同名第三方包更糟，装回来一段陌生代码。工作区内引用一律 workspace:*。

## 自测问题

1. 消费方为什么需要 .d.ts，而不是直接引 .ts 源文件？
2. exports 的 types 条件为什么必须排在第一位？
3. formatDate 里 getMonth() 为什么要加 1？
4. workspace:* 和 ^0.1.0 这两种写法，pnpm 的处理有何不同？
5. 桶文件解决了什么问题，代价是什么？

::: details 第 1 题答案
.d.ts 只包含类型形状，没有实现。消费方编译自己的代码时只需要知道导出"长什么样"，不必重新编译 shared 的源码；.js 加 .d.ts 的组合也是 Node 与 TS 模块解析的标准形态，直接指向 .ts 在 NodeNext 下走不通。
:::

::: details 第 2 题答案
TS 和 Node 一样，按声明顺序逐个匹配 exports 的条件，命中即停。如果 import 排在 types 前面，TS 命中 .js 后就不再找类型声明，所有导入静默变成 any。
:::

::: details 第 3 题答案
JS 的 Date 月份从 0 计数，0 代表一月，getMonth() 返回 0 到 11。显示给用户前必须加 1，再配合 padStart 补零。
:::

::: details 第 4 题答案
workspace:* 让 pnpm 在工作区内建软链，直接使用本地包的产物，内容永远同步；^0.1.0 会去 npm registry 下载，内部包没发布过就安装失败，甚至装到同名第三方包。
:::

::: details 第 5 题答案
桶文件提供统一出口，消费方一行 import 拿到全部导出，不用记内部路径；代价是 export * 削弱 tree-shaking。内部包体积影响小，方便优先，体积敏感时再改子路径导出。
:::

## 延伸阅读

- [Node.js 官方文档：package.json 的 exports 字段](https://nodejs.org/api/packages.html#exports)
- [TypeScript tsconfig 参考](https://www.typescriptlang.org/tsconfig/)
- [TypeScript 模块解析参考](https://www.typescriptlang.org/docs/handbook/modules/reference.html)
- [pnpm workspaces](https://pnpm.io/workspaces)
