# 第 3 周 · Day 2：Node.js 模块系统与环境变量——让配置在启动那一刻就可靠

> 对应手册任务：学习「Node.js 模块系统 + 环境变量管理」，动手「用 dotenv + zod 写一个类型安全的配置模块」，当日产出 `config.ts`。本篇只解决一个问题：配置散落在项目各处的 `process.env.XXX` 里，类型清一色是 `string | undefined`，键名拼错没人管，变量漏配要等代码跑到那一行才崩。今天把这件事连根解决：配置只从一个模块出，启动那一刻校验，缺了立刻崩，崩得明明白白。

## 今日目标

1. 说得清 CJS 和 ESM 两套模块系统的区别，知道为什么项目主线是 ESM
2. 掌握 `process.env` 的三个坑：类型只有 `string | undefined`、数字其实是字符串、`"false"` 也是真值
3. 独立完成 `config.ts`：dotenv 加载、zod schema 校验、`z.infer` 推导类型三件套齐活，并亲眼看到漏配一个变量时程序在启动阶段就报错退出

## 概念讲解：为什么配置需要专门对待

昨天学事件循环，你搞清楚了代码是「怎么跑」的。今天补两件更底层的事：代码拆成多个文件后「怎么互相引用」，这是模块系统；程序跑起来后「参数从哪来」，这是环境变量。前者决定你的 import 能不能工作，后者决定你的 Agent 拿不拿得到 API 密钥。

先看一个熟悉的场景。项目里直接读环境变量的代码大概长这样：

```ts
app.listen(process.env.PORT);                  // 第 40 行
const db = connect(process.env.DATABASE_URL);  // 第 120 行
if (process.env.DEBUG) { /* ... */ }           // 第 200 行
```

看起来没什么问题，直到出事。第一，TypeScript 里 `process.env.PORT` 的类型是 `string | undefined`：环境变量本质是字符串，而且可能根本没设。`listen` 收到 `undefined` 在第 40 行报错，但病因是「你没配 PORT」，两者隔着十万八千里。第二，类型是骗人的：`.env` 里写的 `PORT=3000`，读到的是字符串 `"3000"`；`DEBUG` 配成 `"false"` 时 if 照样进，因为非空字符串都是真值。第三，静默失败：把 `PORT` 拼成 `PROT`，拿到 `undefined`，没有任何工具会提示你拼错了。第四，没人说得清项目到底需要哪些配置，新同事 clone 下来跑不起来，只能挨个问。

这四个坑的解法是同一个：别让业务代码直接摸 `process.env`。配置统一从一个模块进出，这个模块在加载时做三件事：把 `.env` 读进环境、校验每个变量的类型和格式、校验不过就让进程立刻退出。这就是今天要写的 `config.ts`。

校验这件事你在第 1 周见过雏形。[Day 1](/week01/day1) 讲泛型擦除时提过：类型编译后就不存在了，运行时想确认「数据真的是这个形状」，得自己写类型守卫。zod 做的就是把守卫标准化：用 schema 把形状声明一遍，`parse` 在运行时按 schema 检查真实数据，`z.infer` 再从同一份 schema 推导出编译期类型。一份声明，运行时和编译期两边受益。

## 核心知识

本节的代码块都是独立示例，可以在练习目录里对照着跑。最终完整文件以下面的动手任务为准。

### 1. CJS 与 ESM：两套模块系统

Node.js 有两套模块系统。老的叫 CommonJS（CJS），从 2009 年起是默认方案；新的叫 ECMAScript Modules（ESM），是 JS 语言标准的一部分。CJS 长这样：

```js
// math.cjs：用 module.exports 导出
function add(a, b) {
  return a + b;
}

module.exports = { add };

// main.cjs：用 require 导入，它是运行时的普通函数调用
const { add } = require("./math.cjs");
console.log(add(1, 2));
```

ESM 换成了语言级的 import/export：

```ts
// math.ts：用 export 导出
export function add(a: number, b: number): number {
  return a + b;
}

export const VERSION = "1.0.0";

// main.ts：用 import 导入，静态语法，模块关系在运行前就确定
import { add, VERSION } from "./math.js";
console.log(add(1, 2), VERSION);
```

写代码时体感差别主要有三点。一，require 是函数调用，写在哪都行，参数还能拼接；import 是静态语法，必须在顶层，正因为它静态，打包工具和 Tree Shaking 才有得分析。二，require 拿到的是导出值当时的拷贝，import 拿到的是绑定，导出方后来改了值，导入方看得见。三，ESM 是语言标准，顶层 await、代码分割这些新能力都只在 ESM 里提供。第 1 周的 monorepo 从第一天起就是 ESM，靠的是 package.json 里的一行：

```json
{ "type": "module" }
```

这行告诉 Node：此目录下的 `.js` 文件一律按 ESM 解析，不写就默认按 CJS。于是新手最常撞的墙出现了：文件里写 import 却没加这行，运行时报 `Cannot use import statement outside a module`；反过来加了这行还在用 require，报 `require is not defined`。单个文件想例外，靠扩展名：`.mjs` 强制 ESM，`.cjs` 强制 CJS，优先级高于 package.json。

还有个 CJS 时代的老朋友在 ESM 里消失了：`__dirname`。CJS 的模块本质是 Node 拿你的文件内容包一层函数再执行，`__dirname`、`__filename`、`require`、`module` 都是那层函数的参数；ESM 取消了这层包装，改用标准的 `import.meta`。要拿当前文件所在目录：

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log(__dirname); // 当前文件所在目录的绝对路径
```

`import.meta.url` 是当前文件的 `file://` URL，`fileURLToPath` 把它转成普通路径。以后要读项目里的静态文件（提示词模板、知识库文档），这几行就是钥匙。

### 2. process.env 的真相：一切皆 string | undefined

环境变量是操作系统交给进程的一组字符串键值对，Node 把它们挂在 `process.env` 上。注意「字符串」三个字，所有坑都源于此：

```ts
const port = process.env.PORT;
// port 的类型：string | undefined

const portNumber: number = process.env.PORT;
// 报错：Type 'string | undefined' is not assignable to type 'number'

console.log(process.env.PORT + 1);                 // PORT=3000 时输出 "30001"，加号变拼接
console.log(process.env.DEBUG ? "开" : "关");       // DEBUG="false" 时输出 "开"，非空字符串都是真值
```

三个问题叠在一起：`undefined` 无处不在，拼错键名也得到 undefined 且无提示；数字是字符串，算术变拼接、相等比较永远失败；没有布尔类型，`"false"` 和 `"no"` 都按真值处理。

结论：`process.env` 的内容是「不可信的外部输入」，和用户提交的表单没有本质区别。既然是外部输入，就该在边界处校验并转换成可靠类型，而不是让它流进业务代码。这正是 zod 的用武之地。

### 3. zod：一份 schema，两份保险

zod 的用法一句话：先声明 schema，再用 schema 校验数据、推导类型。

```ts
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  DEBUG: z.enum(["true", "false"]),
  DATABASE_URL: z.string().url(),
});

const env = EnvSchema.parse({
  PORT: "3000",
  DEBUG: "true",
  DATABASE_URL: "postgres://localhost:5432/agent",
});

console.log(env.PORT.toFixed(0)); // 3000，env.PORT 的类型是 number
```

逐行拆。`z.coerce.number()`：环境变量是字符串，coerce 表示「先转换再校验」，`"3000"` 变成 `3000`，后面的 `.int().min(1).max(65535)` 才有意义。布尔值故意不用 `z.coerce.boolean()`，因为 `Boolean("false")` 是 `true`，配 `"false"` 会校验出一个「真」来；用 `z.enum(["true", "false"])` 只认这两个字面量，之后再接 `.transform` 转成真正的布尔。`z.string().url()` 要求合法 URL 格式：连不上数据库和地址写错是两种问题，后者在启动时就能拦下。

再看类型这一半，主角是 `z.infer`：

```ts
type Env = z.infer<typeof EnvSchema>;
// { PORT: number; DEBUG: "true" | "false"; DATABASE_URL: string }
```

`z.infer<typeof EnvSchema>` 的意思是：从 schema 这个值身上，推导出「校验通过的数据」的类型。注意这里没有手写任何 interface：schema 是唯一的事实来源，运行时的校验规则和编译期的类型都从它出。第 1 周的 `ApiResponse<T>` 是手写的类型声明；配置模块换成 zod 后类型是推导出来的，schema 一改，类型自动跟着改，不存在两边漂移这回事。

校验不过时 `parse` 会抛 ZodError，把所有不满足的字段一次列全；`safeParse` 不抛异常，返回 `{ success, data, error }`，让你自己决定怎么处理。启动配置适合 safeParse：拿到错误后打印一份人类能读的清单，再 `process.exit(1)` 让进程带着失败码退出。这就是 fail fast：配置不齐，程序一分钟都不该跑。

## 动手任务：`config.ts` 一步一步

手册任务：用 dotenv + zod 写一个类型安全的配置模块。拆成 5 步，全程约 25 分钟。

**第 1 步：建项目。** 在本周练习目录新建子目录 `day2-config`，初始化并安装依赖：

```bash
mkdir day2-config
cd day2-config
npm init -y
npm install dotenv zod
npm install -D typescript tsx @types/node
```

tsx 是「直接运行 TypeScript」的运行器，边转译边跑，不用先生成 .js 文件。然后在 package.json 里加两个字段：

```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx main.ts"
  }
}
```

再新建 `tsconfig.json`，给类型检查用：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["*.ts"]
}
```

`"type": "module"` 让项目按 ESM 解析，和第 1 周 monorepo 的选择保持一致。

**第 2 步：写 `.env` 和 `.env.example`。** 新建 `.env`：

```bash
PORT=3000
DEBUG=true
DATABASE_URL=postgres://localhost:5432/agent
OPENAI_API_KEY=sk-local-demo-key
```

再复制一份存成 `.env.example`，把值换成占位符：

```bash
PORT=3000
DEBUG=true
DATABASE_URL=postgres://用户名:密码@localhost:5432/agent
OPENAI_API_KEY=sk-你的密钥
```

规矩只有一条但必须记死：`.env.example` 提交进仓库，`.env` 永远不提交。顺手建个 `.gitignore`：

```text
node_modules
.env
```

example 的作用是告诉后来者「这个项目需要哪些变量、什么格式」，clone 之后 `cp .env.example .env` 填上真值就能跑；`.env` 里装的则是真密钥。dotenv 负责在启动时把 `.env` 读进 `process.env`，从此开发和运行都不用手动 export。

**第 3 步：写 `config.ts`，schema 是核心。**

```ts
// config.ts
import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DEBUG: z.enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DATABASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1, "缺少 OpenAI API Key"),
});

export type Config = z.infer<typeof ConfigSchema>;

const parsed = ConfigSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("配置校验失败，启动终止：");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config: Config = parsed.data;
```

逐段看。第一行 `import "dotenv/config"` 是纯副作用导入：不拿任何导出值，只为让它执行时把 `.env` 读进 `process.env`，它必须排在任何读取 `process.env` 的代码之前。PORT 加了 `.default(3000)`，没配就用默认值，少一个必填项。DEBUG 的链条从左往右读：枚举校验，没配置就当 `"true"`，最后 transform 成真正的布尔值。`safeParse(process.env)` 校验整个环境变量对象，通过后 `parsed.data` 只包含 schema 声明的四个字段，`PATH` 之类的系统变量全被过滤掉，config 对象干干净净。

还有一行值得盯着看：`export type Config = z.infer<typeof ConfigSchema>`。配置的类型是从 schema 推导的：`config.PORT` 是 number，`config.DEBUG` 是 boolean，没有一个字段带 undefined，因为「可能缺」这件事已经在边界上被校验和默认值解决了。

**第 4 步：写 `main.ts`，用上配置。**

```ts
// main.ts
import { config } from "./config.js";

console.log("端口 + 1 =", config.PORT + 1); // 3001，数字加法，不再是 "30001"
console.log("调试模式：", config.DEBUG ? "开" : "关");
console.log("密钥前缀：", config.OPENAI_API_KEY.slice(0, 6) + "...");
```

注意 import 路径写的是 `./config.js` 而不是 `./config.ts`，这不是笔误。TypeScript 编译产物是 .js 文件，NodeNext 规范要求 import 写「编译后的文件名」，tsx 会自动把 `./config.js` 对应到 `./config.ts`。第一次见到这个规则的人，十个有九个在这里被 `Cannot find module` 拦下。

**第 5 步：亲手弄坏一次。** 把 `.env` 里的 `OPENAI_API_KEY` 注释掉，`PORT` 改成 `abc`，再跑 `npm run dev`，你会看到类似输出（措辞随 zod 版本略有差异）：

```text
配置校验失败，启动终止：
  OPENAI_API_KEY: 缺少 OpenAI API Key
  PORT: Expected number, received nan
```

两个问题一次列全，而不是修一个跑一次再撞下一个。PowerShell 里接着执行 `echo $LASTEXITCODE`（macOS/Linux 是 `echo $?`）会看到退出码 1，部署脚本和容器重启策略靠它感知失败。还要留意一件事：这种错 `npx tsc --noEmit` 查不出来，类型检查管不到 `.env` 这种运行时才读的外部数据，这正是「启动时校验配置」存在的理由。改回正确配置，程序恢复运行。

::: tip 运行与类型检查
`npm run dev` 用 tsx 直接运行；`npx tsc --noEmit` 做纯类型检查，不产出文件。两条命令都应当零报错。
:::

## 常见踩坑

**坑 1：`"type": "module"` 一加，老代码全炸。** 报错无非两种：`Cannot use import statement outside a module`，是文件按 CJS 解析但你写了 import；`require is not defined`，是加了 type 但某处还在用 require。判断规则记一条：package.json 的 `type` 决定 `.js` 的默认身份，`.mjs` 和 `.cjs` 扩展名可以逐文件覆盖它。npm 上的老包大多自带 CJS 入口，在 ESM 项目里默认导入通常也能用，Node 会做兼容；真遇到只能 require 的包，用 `createRequire` 过桥。新项目别纠结，直接 ESM。

**坑 2：ESM 里没有 `__dirname`。** 它是 CJS 模块包装函数的参数，ESM 取消了这层包装，迁移老代码一跑就报 `__dirname is not defined`。解法就是核心知识里那三行：`fileURLToPath(import.meta.url)` 转成路径，再 `path.dirname` 取目录，`__filename` 同理。别拿 `process.cwd()` 顶替，那是「执行命令时所在的目录」，和「文件所在的目录」是两回事，从别的目录运行脚本时两者并不相等。

**坑 3：环境变量是字符串，且永远是。** `PORT + 1` 得到 `"30001"`；`DEBUG="false"` 时 if 照进；`process.env.PORT === 3000` 永远 false，一边字符串一边数字。解法是用 `z.coerce.number()` 在边界处转换。更隐蔽的是 `z.coerce.boolean()`：它按 `Boolean()` 规则转换，任何非空字符串都是 true，`"false"` 转出来还是 true。布尔特判用 `z.enum(["true", "false"]).transform(...)`，只认这两个字面量。

**坑 4：dotenv 加载晚了，读到的全是 undefined。** `import "dotenv/config"` 必须在「读取 process.env 的代码执行之前」运行。ESM 的 import 按书写顺序执行，所以把它放在 config.ts 第一行，并让 config.ts 成为唯一读环境变量的地方，时机就永远正确。典型翻车写法是在别的模块顶部直接 `process.env.XXX`，而那个模块又排在 dotenv 之前被导入。规矩定死：业务代码要配置只能 `import { config }`，不许自己摸 `process.env`。

**坑 5：把 `.env` 提交进仓库。** 密钥进了 git 历史，删都删不干净，等于把钥匙插在门上。团队规范是 `.env` 进 `.gitignore`，`.env.example` 进仓库且只放占位符。本地开发密钥泄露尚可重置，公司密钥泄露一次就够写事故报告了。提交前扫一眼 `git status`，看到 `.env` 就收手。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. package.json 里 `"type": "module"` 影响什么？某个文件想用 CJS 有什么办法？

::: details 参考答案
决定该目录下 `.js` 文件默认按 ESM 还是 CJS 解析，不写则默认 CJS。例外靠扩展名：`.mjs` 强制 ESM，`.cjs` 强制 CJS，优先级高于 package.json；子目录也可以放自己的 package.json 覆盖。
:::

2. ESM 里 `__dirname` 为什么不存在？正确替代写法是什么？

::: details 参考答案
`__dirname` 是 CJS 模块包装函数的参数，ESM 取消了这层包装，改为标准的 `import.meta`。替代写法：`const __dirname = path.dirname(fileURLToPath(import.meta.url))`。
:::

3. `PORT` 配成 `3000` 时 `process.env.PORT + 1` 得到什么？`DEBUG="false"` 时 `if (process.env.DEBUG)` 会怎样？为什么？

::: details 参考答案
得到字符串 `"30001"`，加号遇到字符串做拼接；if 会进分支，因为 `"false"` 是非空字符串，按真值处理。根因：环境变量只有字符串一种类型，没有数字和布尔。
:::

4. 为什么配置校验要放在启动时 fail fast，而不是等用到时再报错？

::: details 参考答案
启动即崩有三个好处：错误离病因最近，堆栈清晰；所有缺失项一次列全，不用修一个跑一次；进程立刻非零退出，部署脚本、CI、容器重启策略都能感知。运行到一半才崩，服务可能已经处理过请求、写过数据，排查难度完全是另一个量级。
:::

5. `z.infer<typeof ConfigSchema>` 解决了什么问题？如果改成手写 `interface Config` 会怎样？

::: details 参考答案
它从 schema 推导出校验通过后的数据类型，让运行时校验和编译期类型共享同一份事实来源。手写 interface 等于同一个形状写两遍，schema 改了 interface 忘改时，类型检查照常通过，但运行时行为和类型对不上，这种漂移最隐蔽。呼应第 1 周的类型守卫：类型会被擦除，zod 让「守卫条件」和「类型声明」合为一体。
:::

## 延伸阅读

- [Node.js 官方文档：ESM](https://nodejs.org/api/esm.html)，模块解析规则、import.meta、CJS 互操作的第一手资料，遇到加载报错先查它
- [zod 文档](https://zod.dev/)，schema、coerce、transform、z.infer 的完整说明，今天只用到它的一小角
- [dotenv 仓库](https://github.com/motdotla/dotenv)，`.env` 加载细节和多环境用法都在 README 里

今天的产出 `config.ts` 留好。后面接大模型 API 时，密钥、模型名、超时时间全部从这一个口子出，配置这层地基从第一天就是稳的。
