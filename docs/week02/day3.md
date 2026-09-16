# 第 2 周 · Day 3：Vitest 单元测试基础——给工具包的行为上保险

> 对应手册任务：学习「Vitest 基础：`describe/it/expect`、mock」，动手为 `packages/shared` 里的工具函数写 5 个单元测试，当日产出测试全绿。本篇只解决一个问题：第 1 周写下的 `formatDate` 承诺了一批行为（默认格式、补零、非法输入原样返回），这些承诺至今只活在教程和注释里，谁来保证下一次改动不把它弄坏？答案是把这批承诺写成可执行的断言，让机器在每次改动后 3 秒内替你验证一遍。

## 今日目标

1. 说得清这个 monorepo 为什么选 Vitest 而不是 Jest，三条理由各对应 Jest 的一个真实痛点
2. 掌握测试的三层积木 `describe/it/expect`，以及 mock 的三种武器 `vi.fn`、`vi.spyOn`、`vi.mock`，并且知道什么时候不该 mock
3. 独立为 `formatDate` 写 5 个单元测试，把 test 脚本接回第 1 周的 turbo 管道，亲眼看到全绿与缓存命中

## 概念讲解：为什么需要测试，为什么是 Vitest

先盘点一下 `formatDate` 现在的处境。它承诺的行为有一长串：默认模板 `YYYY-MM-DD HH:mm`、月日时分秒不足两位补零、占位符可自定义、毫秒时间戳能解析、非法输入不抛错而是原样返回。上周你用一条 `node -e` 命令手动验证过 happy path，然后呢？下次给 `formatDate` 加个 `Weekday` 占位符，手一抖把 `pad` 用错地方，编译器管不管？不管。类型检查只承诺「进出的是 string」，不承诺「内容对不对」。运行时行为的回归，编译器是天生的瞎子。

单元测试补的就是这块盲区：把「输入 → 预期输出」钉成断言，机器反复验证。回报有三层。改动后秒级回归，不用重敲 `node -e` 再肉眼比对；测试即文档，新人读五个测试就知道函数承诺了什么、没承诺什么；重构有底气，敢于动手的前提是有人兜底。

那为什么是 Vitest，不是久经沙场的 Jest？三个痛点摆在这儿。

第一，ESM。Day 6 特意讲过 shared 用 NodeNext，`.ts` 里写 `.js` 后缀导入，整个包是正经 ESM。Jest 的世界默认 CommonJS，原生 ESM 支持至今挂着实验标志，启动要加 `--experimental-vm-modules`，TypeScript 还得再请 ts-jest 或 babel 来做转换，配置平白多出一层。Vitest 生在 ESM 时代，esbuild 直接吃 TS 源码，零转换配置就能跑今天的测试。

第二，快。esbuild 编译 TypeScript 是并行原生的，watch 模式下存盘即重跑，秒级反馈。Jest 的转换链路天生重一截，包一多差距更明显。

第三，Vite 同源。apps/web 第 1 周就是 Vite 建的，Vitest 出自同一个团队，解析模块、转换 TS 的那套机制和你的应用完全一致，心智只有一套。用 Jest 等于在 Vite 旁边再养一套平行的构建配置。何况 Vitest 的 `describe/it/expect` 和 Jest 几乎同名同义，学到的断言知识随时能带走。

还有一点今天会反复印证：`formatDate` 是纯函数，不碰网络、不碰时钟（数据自己造）、不碰随机数，所以那 5 个测试一个 mock 都不需要。mock 是什么、什么时候才轮到它，放在核心知识讲，动手任务里安排一场演习。

## 核心知识

本节的代码块除标注「示意」外都可以直接运行，被测对象以下面的动手任务为准。Vitest 用的是 3.x，装法在动手任务第 1 步。

### 1. describe / it / expect：测试的三层积木

```ts
import { describe, it, expect } from 'vitest';

describe('加法', () => {
  it('两个数相加返回和', () => {
    expect(1 + 1).toBe(2);
  });
});
```

三层各司其职：`it` 是最小单元，一条测试就是一句话「在什么条件下，应该怎样」；`describe` 把相关的 it 归成一组，报告里按组折叠，红了一眼定位到是哪块功能坏了；`expect(实际值).matcher(预期值)` 是断言本体，matcher 不成立这条 it 就红。`test` 和 `it` 是同一个函数的别名，团队里统一用一个就行，本系列用 `it`。

常用断言先认五个，够覆盖今天全部场景：

```ts
expect(formatDate(d)).toBe('2026-09-16 15:04'); // 严格相等（===）
expect({ a: 1 }).toEqual({ a: 1 });             // 深比较，对象数组必用它
expect('2026年09月16日').toMatch(/年/);          // 正则匹配（也接受子串）
expect(['MM', 'DD']).toContain('MM');           // 数组包含某元素
expect(undefined).toBeUndefined();              // 精确的空值判定
```

最容易踩的分界在 `toBe` 和 `toEqual`：`toBe` 走 `Object.is`，基本等于 `===`；而两个内容一样的对象字面量不是同一个引用，`expect({ a: 1 }).toBe({ a: 1 })` 必然失败。对象和数组一律 `toEqual`，它递归比较每一层。这条是新手测试红灯的头号来源，踩坑节细说。

### 2. mock 的三种武器与「何时该 mock」

先立规矩，再发武器。mock 的用途一句话讲完：把不确定的、慢的、有副作用的依赖，换成确定的、快的、安静的替身。所以该 mock 的是边界——网络请求、文件系统、时钟、随机数；不该 mock 的有两样：被测对象本身（mock 了它，你测的就是替身，绿得毫无意义），和你还说不清预期行为的依赖（先想清行为，再谈替换）。每加一个 mock，测试就离真实远一分，这笔账永远要算。

`vi.fn()`：凭空造一个可追踪的假函数。适合依赖通过参数注入的场景，比如回调：

```ts
// 被测函数：注册用户，成功后调用注入的通知回调
function registerUser(name: string, notify: (msg: string) => void): string {
  const id = `u_${name.toLowerCase()}`;
  notify(`欢迎 ${name}`);
  return id;
}

// 测试：notify 是外发的副作用，用 vi.fn 顶替并验证
const notify = vi.fn();
const id = registerUser('Jerry', notify);

expect(id).toBe('u_jerry');
expect(notify).toHaveBeenCalledTimes(1);
expect(notify).toHaveBeenCalledWith('欢迎 Jerry');
```

关键在 `vi.fn()` 造出来的函数自带记账本：被调了几次、每次带什么参数，全记在 `mock` 属性里，三个专用 matcher 直接查账。真发通知的邮件服务一点没被打扰。

`vi.spyOn(obj, 'method')`：给已有对象的方法套壳。函数不是参数注入、长在对象内部时，用间谍：

```ts
// 被测函数：解析失败时打 console.warn
function parseAmount(input: string): number | null {
  const n = Number(input);
  if (Number.isNaN(n)) {
    console.warn(`解析失败：${input}`);
    return null;
  }
  return n;
}

// 测试：把 console.warn 换成哑巴，既不吵又可验证
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

expect(parseAmount('abc')).toBeNull();
expect(warn).toHaveBeenCalledWith(expect.stringContaining('解析失败'));
```

关键在 `mockImplementation(() => {})`：原方法被空函数顶替，终端清净了，调用记录还留在 spy 里。`expect.stringContaining` 这种「模糊匹配」断言很实用，只验证关键片段，提示文案改字不影响测试。测完 `warn.mockRestore()` 还原，别把别人的 console 永久弄哑。

`vi.mock(path, factory)`：整个模块替换。示意代码，今天不写进仓库：

```ts
import { getUserPage } from './page';

// getUserPage 内部 import { fetchUser } from './api'
// 下面这行把 './api' 整个换成假货，fetchUser 永远返回固定数据
vi.mock('./api', () => ({
  fetchUser: vi.fn().mockResolvedValue({ id: 1, name: 'Jerry' }),
}));
```

关键特性是「提升」：无论 `vi.mock` 写在文件第几行，它都会被搬到所有 import 之前执行，保证模块加载前替身已就位。代价是 factory 里不能引用外面的变量（提升后还没初始化），真遇到就用 `vi.hoisted`。模块级 mock 是第 3 周测 NestJS 服务的主力——把数据库访问整个换掉，只留业务逻辑接受检验。

三种武器一条收尾规矩：动了 spy 和 mock，`afterEach(() => vi.restoreAllMocks())` 统一还原。至于今天：纯函数，一个 mock 都不要，5 个测试就是证明。

### 3. 测试文件放哪，包路径怎么解析

位置用「与源码同住」的惯例：`src/utils/formatDate.test.ts`，Vitest 默认就扫描 `**/*.test.ts`，零配置。导入写 `from './formatDate.js'`，沿用 Day 6 的口诀「引谁，就写它编译后的文件名」，Vitest 原生认这种 ESM 后缀并自动映射回 `.ts` 源码。

解析 workspace 包是另一回事，两种方案。方案 A，相对路径：在 shared 内部测自己，就像今天这样直接 `./formatDate.js`，零配置，最简单。方案 B，`vite-tsconfig-paths`：当你在 apps/web 里写组件测试要 `import { formatDate } from '@my/shared'` 时，有个坑——pnpm 的 symlink 把包名指向 packages/shared，其 package.json 的 exports 又把 import 条件指到 dist，测试跑到的其实是构建产物；改了 src 忘了 build，测试对着旧 dist 照样全绿，这叫假绿。让测试直连源码的解法之一：

```ts
// packages/shared/vitest.config.ts（或 apps/web 下同名文件）
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
});
```

前提是 tsconfig 里配好 `paths` 把 `@my/shared` 映射到 `../packages/shared/src/index.ts`。另一条路更省事：Day 5 的 turbo.json 里 test 任务早就写了 `dependsOn: ["build"]`，每次跑测试前 turbo 先把 dist 构建新鲜。两条路选一条走到底，别叠加着纠结。

## 动手任务：5 个测试接回 turbo，一步一步

手册任务：为 `packages/shared` 里的工具函数写 5 个单元测试。被测对象就是 [Day 6](/week01/day6) 写进 shared 的 `formatDate`，测试它，等于给第 1 周的作业补上验收。拆成 7 步，全程约 30 分钟。

**第 1 步：装 Vitest，加脚本。** 仓库根目录执行：

```powershell
pnpm --filter "@my/shared" add -D vitest
```

然后打开 packages/shared/package.json，scripts 里加一行：

```json
"test": "vitest run"
```

为什么是 `vitest run` 而不是 `vitest`：不带参数的 vitest 进 watch 模式，存盘自动重跑，本地开发很爽；但它长驻不退出，第 7 步接进 turbo 时会把管道卡死。管道里一律 `run`，watch 留给你自己的终端。

**第 2 步：建测试文件，跑绿第一个。** 新建 packages/shared/src/utils/formatDate.test.ts：

```ts
import { describe, it, expect } from 'vitest';
import { formatDate } from './formatDate.js';

describe('formatDate', () => {
  it('默认模板输出 YYYY-MM-DD HH:mm', () => {
    const d = new Date(2026, 8, 16, 15, 4, 30);
    expect(formatDate(d)).toBe('2026-09-16 15:04');
  });
});
```

注意造数据的写法：`new Date(2026, 8, 16, 15, 4, 30)` 是本地时区的 2026-09-16 15:04:30，月份参数 8 表示 9 月（从 0 数起，和 `formatDate` 里的 `getMonth() + 1` 是同一件事的两面）。构造走本地时区，`formatDate` 内部的 `getFullYear/getMonth` 也读本地时区，两端一致，机器放到地球上任何时区这个断言都成立。跑一下：

```powershell
pnpm --filter "@my/shared" test
```

看到 `1 passed`，第一根绿条到手。

**第 3 步：补第 2、3 个测试。** 往 describe 里继续加：

```ts
it('月、日、时、分、秒不足两位时补零', () => {
  const d = new Date(2026, 0, 5, 3, 7, 9); // 2026-01-05 03:07:09
  expect(formatDate(d, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-01-05 03:07:09');
});

it('自定义模板支持中文混排', () => {
  const d = new Date(2026, 8, 16, 15, 4);
  expect(formatDate(d, 'YYYY年MM月DD日 HH:mm')).toBe('2026年09月16日 15:04');
});
```

这两个测试钉住的行为：`pad` 函数的存在意义（补零），以及正则替换的正确性（任意模板里的占位符都被换成对应值）。Day 6 的验收只手动跑过一遍 happy path，现在每个承诺对应一条测试。

**第 4 步：补第 4、5 个测试。**

```ts
it('接受毫秒时间戳', () => {
  const ts = new Date(2026, 8, 16, 15, 4).getTime();
  expect(formatDate(ts)).toBe('2026-09-16 15:04');
});

it('非法输入原样返回字符串', () => {
  expect(formatDate('不是日期')).toBe('不是日期');
  expect(formatDate(NaN)).toBe('NaN');
});
```

第 5 个测试钉的是 Day 6 里「宽松派」的取舍：解析失败不抛错、返回原值字符串。`formatDate(NaN)` 走的路径是 `new Date(NaN)` 得 Invalid Date，`getTime()` 为 NaN，于是原样返回 `String(NaN)`，也就是 `'NaN'`。将来谁要是把这里改成抛异常，测试立刻变红，两行 diff 摆在一起，code review 一眼看出「这是行为变更」——测试作为可执行文档的价值就在这儿。

再跑一次 `pnpm --filter "@my/shared" test`，`5 passed`，手册的「测试全绿」到手。

**第 5 步：故意弄红一次。** 把第一个测试的断言改成 `'2026-09-16 15:05'`，再跑。红色报告会把 expected 和 received 并排打印，文件、行号、差异一目了然。看懂这份报告，你就懂了断言到底在防什么。看完改回来，保持全绿。

**第 6 步：mock 演习。** 在同目录新建 mock-drill.test.ts，把核心知识 2 的两种武器各练一遍（代码自包含，不依赖 shared 的源码）：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

function registerUser(name: string, notify: (msg: string) => void): string {
  const id = `u_${name.toLowerCase()}`;
  notify(`欢迎 ${name}`);
  return id;
}

function parseAmount(input: string): number | null {
  const n = Number(input);
  if (Number.isNaN(n)) {
    console.warn(`解析失败：${input}`);
    return null;
  }
  return n;
}

describe('mock 演习', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('vi.fn：验证回调被正确调用', () => {
    const notify = vi.fn();
    const id = registerUser('Jerry', notify);
    expect(id).toBe('u_jerry');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('欢迎 Jerry');
  });

  it('vi.spyOn：把 console.warn 换成哑巴再验证', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseAmount('abc')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('解析失败'));
  });
});
```

跑绿之后删掉这个文件——它是演习场，不属于 shared 的正式测试。`vi.mock` 的模块级替换不用急，第 3 周测 NestJS 时真刀真枪地用。

**第 7 步：接回 turbo 管道。** 仓库根目录执行：

```powershell
pnpm turbo test --filter=@my/shared
```

turbo 会先跑 `shared#build` 再跑 `shared#test`——Day 5 配的 `test dependsOn: ["build"]` 在这一步真正生效，test 任务能被扫到的前提正是第 1 步把脚本名写成了 `test`，任务名必须和子包脚本名一致。再执行一遍同样的命令：两个任务都 cache hit，连测试报告都原样回放，这就是 Day 5 说的「连 stdout 都缓存」。别担心测到陈旧结果——测试文件内容也是任务哈希的输入，改一个字符缓存就失效重跑。

::: tip 本地两档速度
日常开发用 `pnpm --filter "@my/shared" exec vitest` 进 watch 模式，存盘即重跑；提交前用 `pnpm turbo test`，走依赖管道和缓存。两条命令各管一段，别混着用。
:::

## 常见踩坑

**坑 1：字符串日期造数据，时区炸在别人电脑上。** `new Date('2026-09-16')` 按规范被解析成 UTC 午夜，在 UTC-5 的机器上本地日期是 9 月 15 日，断言 16 当场红——你本地全绿，CI 或海外同事一跑就挂，环境相关的失败最难排查。规则：测试里造时间一律用 `new Date(年, 月, 日, ...)` 数字构造器，和被测代码同走本地时区，走到哪都一样。顺带记住月份从 0 数起。

**坑 2：拿 toBe 测对象，永远红。** `expect(tokens).toBe({ YYYY: '2026' })` 里两个对象字面量再像也不是同一个引用，`Object.is` 必判 false。基本类型用 `toBe`，对象和数组一律 `toEqual`。判断口诀：断言右边是对象或数组字面量，就轮到 `toEqual` 了。

**坑 3：watch 模式混进管道，turbo 永不收工。** `"test": "vitest"` 挂上 package.json，`turbo test` 就卡在这个长驻进程上直到超时。Day 5 讲过 dev 这类长驻任务要么 `cache: false` 要么别进管道，测试任务的正解是 `vitest run`，watch 是你终端里的私享品。

**坑 4：在 apps 里测到旧 dist，假绿。** apps/web 的测试 `import '@my/shared'` 时，解析到的是 packages/shared/dist 的构建产物。改了 src 忘了 build，测试对着旧产物跑，全绿但验证的不是你刚写的代码——比红更危险，它给你错误的安全感。两条解法（核心知识 3 展开过）：靠 turbo 的 `dependsOn: ["build"]` 保证产物新鲜，或用 vite-tsconfig-paths 把包名指回源码。

**坑 5：mock 不还原，污染同文件其他测试。** 演习里 spy 吞掉了 console.warn，要是 afterEach 忘了 `vi.restoreAllMocks()`，后面任何测试真出 warning 也会被静默吞掉，排查时你会怀疑人生。规矩：动了 spy 和 mock 就统一还原；以及那条铁律——被测函数本身永远不 mock，能 mock 的只有它的依赖。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 这个 monorepo 放弃 Jest 选 Vitest 的三条理由，每条对应 Jest 的什么痛点？

::: details 参考答案
① ESM 原生：shared 是 NodeNext ESM，Jest 默认 CommonJS，原生 ESM 至今要加 `--experimental-vm-modules` 且挂着实验标志，TS 还需 ts-jest 或 babel 转换；Vitest 用 esbuild 直接吃 TS 源码，零转换配置。② 快：esbuild 并行编译加秒级 watch 重跑。③ Vite 同源：apps/web 本来就是 Vite，测试与应用共享同一套模块解析和转换心智，不必再养一套 Jest 配置。另外 API 兼容 Jest，describe/it/expect 的知识直接平移。
:::

2. `toBe` 和 `toEqual` 的分界线画在哪？

::: details 参考答案
`toBe` 走 `Object.is`（基本等于 `===`），适合 number/string/boolean 以及「必须是同一个引用」的场合；`toEqual` 递归深比较，对象和数组必须用它——两个内容相同的字面量不是同一个引用，`toBe` 必然失败。
:::

3. `vi.fn`、`vi.spyOn`、`vi.mock` 分别什么场景用？判断「该不该 mock」的标准是什么？

::: details 参考答案
`vi.fn` 凭空造可追踪的假函数，适合依赖通过参数注入（回调、通知）；`vi.spyOn` 给已存在对象的方法套壳，适合收敛模块内部副作用（console、Math.random），测完 restore；`vi.mock` 整模块替换且被提升到文件顶部，适合换掉网络、数据库这类外部依赖模块。标准：只 mock 边界（网络/时钟/随机/磁盘），永不 mock 被测对象本身；每加一个 mock 测试就离真实远一分，纯函数一个 mock 都不该有。
:::

4. turbo.json 里 test 任务的 `dependsOn: ["build"]` 今天哪一步靠它？如果写成 `["^build"]` 含义怎么变？

::: details 参考答案
第 7 步 `pnpm turbo test` 时，turbo 先跑本包的 build 再跑 test，保证测试消费到的 dist 是新鲜的。`["^build"]` 则表示先跑完上游依赖包的 build——对 shared 这种没有内部依赖的包两者无差别，但对依赖 shared 的 web 来说，带 `^` 才能保证 `shared#build` 先完成。记法沿用 Day 5：带 `^` 看上游依赖，不带看同包顺序。
:::

5. 为什么测试里造时间用 `new Date(2026, 8, 16, 15, 4)`？哪种字符串写法最危险？

::: details 参考答案
数字构造器按本地时区解释，`formatDate` 内部的 `getFullYear/getMonth` 也按本地时区读，两端一致，任何时区的机器结果相同。字符串里，带时间且不带时区标记的（如 `'2026-09-16T15:04:00'`）按本地时区解析，其实也安全；真正的雷是纯日期字符串 `'2026-09-16'`——没有时间部分就按 UTC 午夜解析，在西半球时区本地日期会变成前一天，断言必挂且只在部分机器上挂。
:::

## 延伸阅读

- [Vitest 官方文档：API 参考](https://vitest.dev/api/)，describe/it/expect 和全部 matcher 的权威出处，断言卡壳时先查它
- [Vitest 官方文档：Mocking](https://vitest.dev/guide/mocking.html)，vi.fn/spyOn/mock 与 vi.hoisted 的全部细节，第 3 周之前值得通读
- [Vitest 官方文档：与其他工具的对比](https://vitest.dev/guide/comparisons.html)，Vitest 与 Jest 的官方逐项对比，看完更清楚今天的选型不是玄学

今天的 5 个测试是 shared 的第一道安全网。此后每次改 `formatDate`，先 `pnpm turbo test` 再提交；第 3 周写 NestJS 接口时，mock 会从演习场走向日常。
