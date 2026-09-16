# 第 2 周 · Day 1：ESLint + Prettier 配置——给 monorepo 立规矩

> 对应手册任务：学习「ESLint + Prettier 配置」；动手在 monorepo 根目录配置 `eslint.config.js` 和 `.prettierrc`，apps 下的包共享同一套规则；当日产出「统一 lint/format 配置」。本篇只解决一个问题：代码规范不能靠自觉、口头约定和各自的 IDE 默认值，要变成机器可执行的配置，一条命令统一检查、统一修复，谁提交都长一个样。

## 今日目标

1. 说得清 ESLint 和 Prettier 各管什么、为什么用两个工具而不是一个
2. 看懂 ESLint 9 的平铺配置：`eslint.config.js` 导出一个数组，配置即对象，顺序即优先级
3. 在仓库根目录配好统一规则，把第 1 周 [Day 5](/week01/day5) 留下的 lint 占位脚本换成真 ESLint，一条命令查完所有包

## 概念讲解：为什么需要 ESLint 和 Prettier

仓库里现在有两个包了（[Day 4](/week01/day4) 搭的骨架），先看两段随手就能写出来的代码。

packages/shared 里，质量在滑坡：

```ts
function findById(list: any[], id: number) {
  const cache = "写了但再也没用过";
  return list.find(item => item.id == id); // == 宽松比较，类型悄悄转换
}
```

`any` 放弃了类型检查，`cache` 白占内存，`==` 在字符串和数字之间偷偷转换。这些和「代码怎么排」无关，是逻辑层面的隐患。

apps/web 里，格式在漂移：

```ts
const config={host:"localhost",port:3000};
const backup = { host: "localhost", port: 3000 };
```

两个对象内容一样，排法不一样。缩进、引号、换行位置，纯审美问题，没有对错，但不统一就有代价：diff 全是噪音，review 的注意力被「这行怎么变了」吃掉，而本该看的是逻辑。

传统的两条路都不行。第一条，靠 code review 人肉把关：格式问题占用 review 精力，标准因 reviewer 而异，今天说单引号明天说双引号，还伤感情。第二条，靠每个人的 IDE 设置：没法强制，换台机器就失效，新成员第一天就把私有风格带进来。

正确的解法是把两类问题分别交给两台机器。质量类（未使用变量、`any`、`==`、可疑逻辑）交给 ESLint：它是静态分析器，规则可配可扩展，报错、报警还是放行由你定。格式类（缩进、引号、换行）交给 Prettier：它几乎不可配置，拿到文件直接整棵语法树重排，输出唯一答案。

为什么不是一个大工具全包？ESLint 9 起已经把核心里的纯格式化规则全部移除（社区挪去 `@stylistic` 系插件维护），官方态度就是「格式不归我管」；而 Prettier 完全不做语义检查，只管排版。两个工具各干一行，中间用 `eslint-config-prettier` 划清边界，这就是社区的事实标准。

## 核心知识

本节代码可以直接对照着敲，最终文件以下面的动手任务为准。所有 pnpm 命令在 PowerShell 里照抄即可，和 bash 写法一致。

### 1. ESLint 9 平铺配置：一个数组就是全部

老一代 ESLint 用 `.eslintrc.json`：JSON 配置、`extends` 继承、`env` 声明环境。ESLint 9 起默认只认平铺配置（flat config）：根目录一个 `eslint.config.js`，导出一个配置对象组成的数组。

```js
// eslint.config.js —— 最小可用的平铺配置
import js from "@eslint/js";

export default [
  { ignores: ["**/dist/**"] },        // 只写 ignores 的对象 = 全局忽略
  {
    files: ["src/**/*.ts"],           // 这块规则管哪些文件，不写就是全部
    rules: {
      "no-console": "error",          // 规则名: 严重级别
    },
  },
  js.configs.recommended,             // 官方推荐规则包，整个铺进数组
];
```

四件事看清楚。`ignores` 声明哪些文件不检查（`node_modules` 和 `.git` 默认忽略，不用写）；`files` 圈定作用范围；`rules` 是规则到严重级别的映射，级别只有三档：`"off"`、`"warn"`、`"error"`；最后一行说明推荐配置不神秘，它就是个配置对象（或数组），和手写的对象平起平坐。

数组里**顺序即优先级**：对同一条规则，后面的对象覆盖前面的。所以惯用排法是「推荐配置打底，自己的规则放后，Prettier 兜底收尾」。

数组元素又常常互相嵌套（推荐配置本身是数组），手写拍平很烦，于是有两个帮手：

```js
// 帮手一：typescript-eslint 附带（本篇采用）
import tseslint from "typescript-eslint";
export default tseslint.config(a, b, c);

// 帮手二：ESLint 9.22+ 内置
import { defineConfig } from "eslint/config";
export default defineConfig(a, b, c);
```

两者都能把嵌套数组自动拍平，对本篇场景效果完全一致。typescript-eslint 官方已宣布自家的 `config` 帮手进入弃用周期，推荐迁去 `defineConfig`，网上教程两种写法都有，认得出即可。

### 2. typescript-eslint：让 ESLint 读懂 TS

ESLint 自带的解析器读不懂 TS 语法，`interface`、泛型尖括号直接解析失败。装 `typescript-eslint` 这一个包等于装齐三样：TS 解析器（parser）、`@typescript-eslint/*` 规则集（plugin）、现成配置（configs）。它的 `recommended` 预设会亮起这些红灯：

```ts
function parse(raw: any) {        // error  Unexpected any. Specify a type other than any
  const cache = "定义了但没再用"; // error  'cache' is defined but never used
  return raw;
}
```

上一档还有 `recommendedTypeChecked`：借助 tsconfig 的类型信息做检查，能查出「返回值没收窄」这类更深的坑，monorepo 里用 `projectService: true` 就不用手维护 tsconfig 清单。代价是明显变慢，今天不碰，知道有这一档即可。

### 3. Prettier 的地盘：`.prettierrc` 与两条命令

Prettier 的配置只有寥寥几个键，本篇用的这份放在仓库根目录 `.prettierrc`：

```json
{
  "printWidth": 100,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "endOfLine": "lf"
}
```

逐键说明：`printWidth` 是每行最大宽度，默认 80，这里放宽到 100；`semi` 结尾加分号；`singleQuote` 用双引号；`trailingComma` 多行结构最后一项也补逗号（增删行不产生无关 diff）；`endOfLine` 统一换行符，Windows 上配合 git 的换行处理省掉一堆麻烦。除了 `printWidth` 其余和 Prettier 默认值一致，但仍然写出来：配置文件是团队契约，写下来的才算数。

配套两条命令，体检和治疗：

```bash
pnpm exec prettier --check .   # 只报哪些文件不合格式，不动文件
pnpm exec prettier --write .   # 直接重排并写回
```

Prettier 默认只忽略 `node_modules`，不读 `.gitignore`，所以 `.prettierignore` 必须自己准备：

```text
dist
.turbo
pnpm-lock.yaml
```

最后回答一个高频问题：为什么不用 `eslint-plugin-prettier` 把 Prettier 挂成 ESLint 规则一起跑？能跑，但每次 lint 都等于全量格式化一遍，慢；格式问题混在 lint 报错里，信息噪音大。社区共识是两个工具各跑各的，ESLint 只负责承认「格式归 Prettier」。

### 4. monorepo：一份配置怎么让所有包共享

先记住平铺配置的查找规则：**从运行 ESLint 的目录开始，向上找最近的一份 `eslint.config.*`，只用那一份**，不做目录级联合并。这条规则推出两种做法。

做法一：全仓库只有根目录一份配置，子包什么都不放。跑法有两种：在根目录 `pnpm exec eslint .` 一条命令扫全仓库；或者在子包里跑 `eslint .`（cwd 是子包目录），向上查找命中根配置，天然共享。pnpm 跑子包脚本时，根目录的 `.bin` 也在 PATH 里，所以 ESLint 只装根上一份就够。

做法二：根配置当基座，需要私货的包放一个薄配置，数组展开就是新版 `extends`：

```js
// apps/web/eslint.config.js —— 做法二：站在根配置肩膀上加规则
import rootConfig from "../../eslint.config.js";

export default [
  ...rootConfig,
  { rules: { "no-console": "off" } }, // 只有 web 包放行 console
];
```

代价是：这份薄配置只有「以该包为目录跑 ESLint」时才生效，在根目录直跑会被根配置完全无视（见坑 3）。

怎么选：规则全仓库一套 → 做法一，文件少、心智负担小；包差异大了（React 包要 react-hooks 规则，Node 包要另一套）→ 做法二，而且从一演进到二只是加文件，不动根配置。本篇按手册用做法一。

## 动手任务：统一 lint/format 配置一步一步

在 ai-agent-platform 仓库根目录操作，拆成 5 步，全程约 25 分钟。

**第 1 步：装依赖。** 一条命令装齐五个：

```bash
pnpm add -Dw eslint @eslint/js typescript-eslint prettier eslint-config-prettier
```

`-D` 装成 devDependencies（规范工具不进生产依赖），`-w` 指定装到 workspace 根——Day 4 的坑里说过，monorepo 里 add 统一回根目录。

**第 2 步：开 ESM，写根配置。** 先在根 `package.json` 加一行 `"type": "module"`（根目录没有别的 `.js` 文件，加上零副作用；不加的话下一步的 `import` 会直接报错）。然后新建 `eslint.config.js`：

```js
// eslint.config.js —— 仓库根目录，所有包共用这一份
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", ".turbo/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier, // 必须放最后：关掉前面所有配置里和 Prettier 冲突的规则
);
```

四块内容：忽略构建产物和 turbo 缓存目录；JS 通用推荐规则打底；TS 推荐规则铺上（含解析器替换，TS 文件从此读得懂）；`eslint-config-prettier` 收尾。它不是插件，就是一包「关闭规则」的开关，只关不开，必须排在最后才能压住所有来源的格式类规则。

**第 3 步：落盘 Prettier 配置。** 把核心知识 3 的 `.prettierrc` 和 `.prettierignore` 原样放到仓库根目录。

**第 4 步：换掉 Day 5 的占位脚本。** Day 5 留的是 `echo lint placeholder`，今天让它上岗。packages/shared 和 apps/web 两个 `package.json` 的 lint 脚本都换成：

```json
"lint": "eslint ."
```

根 `package.json` 的 scripts 新增两行（原有的 `turbo build` 等不动）：

```json
"format": "prettier --write .",
"format:check": "prettier --check ."
```

在根目录跑 `pnpm lint`：turbo 驱动两个包并行执行各自的 `eslint .`，子包里向上找到根配置，这就是「共享」。再跑一次，命中缓存，FULL TURBO——lint 任务的缓存行为和 Day 5 验证的一致。

**第 5 步：亲眼看见规则在工作。** 在两个包各放一个故意写烂的文件 `apps/web/src/lint-demo.ts`、`packages/shared/src/lint-demo.ts`，内容相同：

```ts
export function risky(payload: any) {
  const unused = "定义了但没人用";
  return payload.id;
}
```

跑 `pnpm lint`，输出大致长这样（列号以你的文件为准）：

```text
apps/web/src/lint-demo.ts
  1:31  error  Unexpected any. Specify a type other than any  @typescript-eslint/no-explicit-any
  2:9   error  'unused' is defined but never used              @typescript-eslint/no-unused-vars

packages/shared/src/lint-demo.ts
  （同款两条）
```

两个包、同一条规则、同一份报错——共享配置验证通过。再在文件里加一行 `debugger;`，在根目录跑 `pnpm exec eslint . --fix`，`debugger` 被自动删除，另外两条还在：有些规则可自动修复，有些必须人改，这就是 `--fix` 的边界。最后删掉两个 demo 文件，跑 `pnpm format` 让全仓库排齐，`pnpm lint` 和 `pnpm format:check` 全绿，当日产出达成。

::: tip 收尾两件事
ESLint 9 要求 Node ≥ 18.18，Turborepo 同代要求更高，你第 1 周的环境已经满足。VS Code 里把默认格式化器设为 Prettier 并开启「保存时格式化」，写代码时就顺手排版，`format:check` 只是兜底。
:::

## 常见踩坑

**坑 1：`eslint.config.js` 里的 `import` 直接报错。** 症状：`SyntaxError: Cannot use import statement outside a module`。根因：根 `package.json` 没写 `"type": "module"`，Node 把 `.js` 文件当 CommonJS 解析，`import` 语法不合法。两个解法：加上 `"type": "module"`（本篇做法），或者把文件改名 `eslint.config.mjs`，效果完全一样。

**坑 2：拿着老教程配 ESLint 9。** 教程里出现 `.eslintrc.json`、`"extends": [...]`、`"env": { "browser": true }`、`root: true`，全是上一代的东西，ESLint 9 默认不认 `.eslintrc`。心里备一张换算表：`extends` 继承变成 `import` + 数组元素；`env` 变成 `languageOptions.globals`（配合 `globals` 包按环境注入）；`root: true` 没有对应物，因为平铺配置根本不级联。最快的自保方法：教程截图里没有 `eslint.config.js`，直接换一篇。

**坑 3：在根目录跑 ESLint，子包配置不生效。** 症状：给 apps/web 精心写了 `eslint.config.js`，在根目录 `pnpm exec eslint .` 一跑，包里的规则毫无反应。原因就是查找规则：从运行目录向上找**最近一份**，根目录有配置就用根的，子包那份被完全无视，更不存在两层合并。子包配置生效的唯一方式是以该包为运行目录跑 ESLint（turbo 正是这么干的）。反过来，全仓库只要根配置一套时，子包千万别手痒再放一份，放了也是死配置。

**坑 4：Prettier 格式化完，ESLint 又报警。** 症状：`prettier --write` 之后 `eslint .` 报引号、分号类错误，或者 IDE 保存一次格式变一次，两个工具来回打架。根因：配置里混进了格式类规则（比如引了 `@stylistic` 系插件或老 preset），没有关干净。解法就一条：确认 `eslint-config-prettier` 装了，且放在配置数组的最后一位。它的原理是「只关规则、不定义风格」，排后面才能把所有来源的冲突规则全部关掉，排错了位置等于没装。

**坑 5：`prettier --write .` 把整个仓库都动了一遍。** 症状：dist 产物、`.turbo` 缓存、`pnpm-lock.yaml` 全被格式化，git status 一片红，lockfile 还冒出无意义 diff。根因：Prettier 默认只忽略 `node_modules`，不读 `.gitignore`。解法：根目录放 `.prettierignore`，把 `dist`、`.turbo`、`pnpm-lock.yaml` 列进去。判断标准很简单：凡是机器生成的文件，一律进 ignore 名单。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. ESLint 和 Prettier 各管什么？为什么不用一个大工具全包？

::: details 参考答案
ESLint 管代码质量（未使用变量、`any`、可疑逻辑），规则可配置；Prettier 管代码格式（缩进、引号、换行），几乎不可配置，直接整文件重排。不能全包：ESLint 9 已把核心格式化规则全部移除，官方明确格式不归它管；Prettier 又完全不做语义检查。两者中间靠 `eslint-config-prettier` 划界，这是社区事实标准。
:::

2. 平铺配置里数组的顺序为什么重要？`eslint-config-prettier` 为什么必须排最后？

::: details 参考答案
平铺配置对同一条规则「后面的对象覆盖前面的」，顺序即优先级。`eslint-config-prettier` 的工作方式是只关规则、不定义新规则，只有排在所有其他配置之后，才能把推荐配置、插件等一切来源里和 Prettier 冲突的格式类规则全部关掉；排在前面会被后面的配置重新打开，等于没装。
:::

3. ESLint 从哪里查找配置文件？monorepo 的两种共享做法分别适合什么场景？

::: details 参考答案
从运行 ESLint 的目录开始，向上找最近的一份 `eslint.config.*`，只用那一份，不级联合并。只有根配置一份（做法一）适合全仓库规则统一的场景，子包不放假配置；根配置当基座、个别包放薄配置用数组展开再导出（做法二）适合包之间规则差异大的场景，注意薄配置只有以该包为运行目录跑时才生效。
:::

4. 为什么不推荐用 `eslint-plugin-prettier` 把 Prettier 挂进 ESLint 一起跑？

::: details 参考答案
两个代价：每次 lint 都相当于全量格式化一遍，慢；格式问题混进 lint 报错，输出噪音大、定位困难。社区共识是两个工具各跑各的命令，ESLint 侧只需用 `eslint-config-prettier` 承认「格式归 Prettier 管」。
:::

5. `prettier --check .` 和 `prettier --write .` 的区别是什么？CI 里该用哪个？

::: details 参考答案
`--check` 只检查并报告哪些文件不合格式，不修改任何文件；`--write` 直接重排并写回磁盘。CI 里用 `--check`：流水线不该替你改代码，检查不过就把构建打红，逼着提交前在本地跑 `--write` 修好再来。
:::

## 延伸阅读

- [ESLint 官方：Configuration Files](https://eslint.org/docs/latest/use/configure/configuration-files)，平铺配置的完整规则：配置对象全部字段、查找顺序、全局忽略，本篇第 1、4 小节的原始出处
- [typescript-eslint：Getting Started](https://typescript-eslint.io/getting-started)，TS 项目接入 ESLint 的官方路径，含 `recommendedTypeChecked` 和 `projectService` 的进阶说明
- [Prettier 官方：Options](https://prettier.io/docs/en/options)，全部配置项及默认值，本篇 `.prettierrc` 每个键的解释都源于此
- [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier)，README 附带完整的冲突规则清单和安装位置说明

今天的产出是四份文件：`eslint.config.js`、`.prettierrc`、`.prettierignore`、换上新脚本的 `package.json`。连同 Day 5 的 turbo lint 管道，这就是以后接 CI 门禁的现成地基：流水线里加一行 `pnpm format:check` 和 `pnpm lint`，不合格的提交直接挡在门外。
