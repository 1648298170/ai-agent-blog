# 第 6 周 · Day 5：BullMQ 重试、延迟与定时——失败有退路，到点准开工

> 对应手册任务：学习「任务重试 + 延迟任务 + 定时任务」，动手「配置 job 重试策略，实现一个延迟 5 分钟的任务」，当日产出「重试 + 延迟验证」。本篇只解决一个问题：昨天跑通的队列只会把失败的任务闷头再来三次，今天让它学会三件生产必备的本事：知道哪些失败值得等一等再试，知道一个任务该在什么时刻执行，知道彻底没救时留下遗言再死。

## 今日目标

1. 说得清重试为什么必须带退避，以及判断一个错误能不能重试的标准
2. 掌握三组配置：`attempts` + `backoff` 重试策略、`delay` 延迟任务、Job Scheduler 定时任务（cron pattern + 时区）
3. 独立完成两个验证实验：故意抛错观察重试日志的间隔规律，实现「5 分钟后自动取消未支付订单」的延迟任务，并给最终失败的任务落一条死信记录

## 概念讲解：为什么「失败就重试」不够用

昨天（[Day 4](/week06/day4)）我们在 `add` 里随手写了 `attempts: 3` 和 `backoff: exponential`，重试就这么跑起来了。但把它放进生产环境，三个问题马上浮出来。

第一，为什么失败后不立刻重试，非要等？想象发信时 SMTP 服务正在重启。你 50 毫秒后再撞一次，它还在重启，还是失败。更糟的是规模：搞活动时 1000 个任务同时失败，同时立刻重试，等于对着刚倒下的服务再来一轮齐射，本来 3 秒能缓过来的下游被你亲手按在地上。这叫重试风暴。退避（backoff）就是给下游留喘息时间：第一次失败等 1 秒，第二次等 2 秒，第三次等 4 秒，间隔越拉越长，下游缓过来了，重试的成功率才真实存在。

第二，所有失败都值得重试吗？判断标准一句话：把同样的任务原封不动再执行一次，结果有没有可能变好。网络超时、下游 502、限流 429，这些是环境问题，等等再试大概率自愈，该重试。邮箱格式非法、余额不足、鉴权失败，这些是确定性错误，同样的输入永远得到同样的失败，重试 5 次只是把同一个错误打 5 遍日志，还可能把副作用（发短信、扣款）重复执行。错误分类的思想就在这：环境错误交给重试，数据错误当场判死刑。

第三，重试次数用尽之后呢？昨天的实验里三次失败后任务进入 failed 终局，日志打完就没了。生产里这是事故：一封重要邮件悄悄没发出去，三天后客诉来了才知道。终局失败必须留下痕迹：写进一张失败任务表，推一条告警，等人来捞。这就是死信（Dead Letter）的思路，借自 RabbitMQ 的死信队列概念：正常消费流程消化不了的，单独存起来，别丢。

解决完「失败了怎么办」，还有一类需求是「什么时候干」。用户下单后 5 分钟没付款要自动取消订单，每天早上 8 点半要生成昨日报表。你当然可以用 `setTimeout`，但进程一重启它就没了；也可以数据库轮询扫描，每秒空转一遍全表。这些活恰好是队列的老本行：把「到某个时刻执行」变成一个躺在 Redis 里的任务，重启不怕，多实例不重。

## 核心知识

本节的代码围绕今天的动手任务展开，可以先通读建立地图，最终以动手任务的完整文件为准。

### 1. 重试策略：attempts 与 backoff

```ts
await queue.add('send-email', { email: 'jerry@example.com' }, {
  attempts: 5,                                    // 总执行次数上限：首次 + 最多 4 次重试
  backoff: { type: 'exponential', delay: 1000 },  // 失败后隔 1s、2s、4s、8s 再来
});
```

两个容易误解的点。一是 `attempts: 5` 是总执行次数上限，含第一次，不是「重试 5 次」，最多触发 4 次重试。二是 `type: 'exponential'` 时相邻两次尝试的间隔大约逐次翻倍（delay 乘 2 的幂），`type: 'fixed'` 则每次都固定等 delay。翻倍的意义上一节讲过：轻故障快速重试，重故障自动放慢，把下游救活而不是补刀。

每个 job 身上都带着计数器 `job.attemptsMade`：第一次执行时是 0，每失败一次加一。completed 事件里它告诉你「这个任务总共试了几次才成功」，failed 事件里它是判断「还有没有救」的依据。

### 2. 错误分类与 UnrecoverableError

分类落实在 processor 的代码里。BullMQ 提供了专门的错误类来表达「这个任务没救了」：

```ts
import { UnrecoverableError } from 'bullmq';

// processor 内部
if (typeof job.data.email !== 'string' || !job.data.email.includes('@')) {
  // 确定性错误：重试也不会变好，直接跳过剩余次数，立即终局
  throw new UnrecoverableError('邮箱格式非法');
}
// 环境性错误：普通 Error，交给 attempts + backoff 安排
throw new Error('SMTP 连接超时');
```

普通 Error 会走完整的重试剧本；`UnrecoverableError` 一抛，job 直接进 failed 终局，剩余的 attempts 全部作废。这样不可救的任务只占一次执行，可救的任务才有重试预算。

最终失败的死信落点，靠 failed 事件里的判定：

```ts
worker.on('failed', (job, err) => {
  const final =
    err instanceof UnrecoverableError ||
    (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  if (final) {
    // 生产里：写 failed_jobs 表（job.id、job.data、err.message、时间）+ 推送告警
    // 这就是死信思路：终局失败留痕，等人来捞
  }
});
```

两个条件缺一不可：`UnrecoverableError` 可能第一次就终局（此时次数远没用完），次数型终局则要等 `attemptsMade` 追平 `attempts`。

### 3. 延迟任务与定时任务

延迟任务只需要一个 `delay` 选项，单位毫秒：

```ts
const FIVE_MINUTES = 5 * 60 * 1000;
await queue.add('cancel-unpaid-order', { orderId: 'A-1001' }, { delay: FIVE_MINUTES });
```

add 之后 job 不进 waiting，而是进 delayed 状态睡大觉，时间一到被 Worker 自动捞回 waiting 执行。它睡在 Redis 里，进程重启、发版部署都带不走它。

但有一个关键设计：到点之后别闭眼执行。这 5 分钟里用户可能已经付款了。队列只负责「到点提醒」，动不动手由复查决定：

```ts
// processor 到点后第一件事：查最新状态
const order = await ordersRepo.findOneBy({ id: job.data.orderId });
if (order.status !== 'unpaid') return; // 已支付，任务正常结束，什么都不做
await ordersRepo.update({ id: order.id }, { status: 'cancelled' });
```

定时任务用 Job Scheduler。场景：每天早上 8 点半生成昨日报表：

```ts
await queue.upsertJobScheduler(
  'daily-report',                                  // 调度器 id，固定不变
  { pattern: '0 30 8 * * *', tz: 'Asia/Shanghai' }, // 每天 08:30:00，按上海时间算
  { name: 'daily-report', data: { range: '昨天全天' } }, // 到点投出的 job 长这样
);

await queue.removeJobScheduler('daily-report'); // 不用了就删，它会一直常驻 Redis
```

`upsertJobScheduler` 以 id 注册，同一个 id 调多次是更新而不是叠加，天然幂等。cron pattern 用六段式，从左到右是秒、分、时、日、月、星期（秒可省略，但建议写全），`0 30 8 * * *` 即每天 8 点 30 分 0 秒。固定间隔场景把 pattern 换成 `every: 5_000`（每 5 秒）就行。

版本注意：老教程里 `queue.add(name, data, { repeat: { pattern } })` 的写法从 v5.16 起废弃，v6 已彻底移除，现在一律用 Job Scheduler。如果你项目里的 bullmq 报 `upsertJobScheduler` 不存在，先 `npm ls bullmq` 看版本，升级比硬写旧 API 划算。

## 动手任务：重试 + 延迟验证一步一步

手册任务：配置 job 重试策略，实现一个延迟 5 分钟的任务。拆成 5 步，全程约 30 分钟。今天不改动昨天的 Nest 项目，建一个独立实验室脚本，跑完即弃；同样的配置原样搬回 `EmailQueueService` 完全成立。

**第 1 步：建实验室。** 在昨天项目的根目录新建 `task-control-lab.ts`（放项目里是为了直接复用已装的 bullmq 和 ioredis），写入骨架：

```ts
// task-control-lab.ts —— 今天的实验室，跑完即弃
import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';

// BullMQ 官方建议：连接上关掉命令级的自动重试，阻塞等待类命令才不会报错
const connection = new Redis({ maxRetriesPerRequest: null });

const queue = new Queue('task-lab', { connection });

// 模拟订单表：A-1001 一直没付款，A-1002 两分钟后付了
const orders = new Map<string, string>([
  ['A-1001', 'unpaid'],
  ['A-1002', 'paid'],
]);

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
```

**第 2 步：写带错误分类的 Worker。** 接着往文件里加。processor 按 job.name 分三个分支，failed 事件里做终局判定：

```ts
const worker = new Worker(
  'task-lab',
  async (job: Job) => {
    if (job.name === 'send-email') {
      const { email } = job.data;
      // 分类一：参数错误，重试无意义，立即终局
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new UnrecoverableError(`邮箱格式非法：${email}`);
      }
      // 分类二：环境错误，前两次模拟 SMTP 抖动，第三次放行
      if (job.attemptsMade < 2) {
        throw new Error('SMTP 连接超时');
      }
      console.log(`[${now()}] 给 ${email} 发送成功`);
      return;
    }

    if (job.name === 'cancel-unpaid-order') {
      // 关键：到点先复查，这 5 分钟里用户可能已经付款
      const status = orders.get(job.data.orderId) ?? '不存在';
      if (status !== 'unpaid') {
        console.log(`[${now()}] 订单 ${job.data.orderId} 状态是 ${status}，无需取消`);
        return; // 正常完成，不是失败
      }
      orders.set(job.data.orderId, 'cancelled');
      console.log(`[${now()}] 订单 ${job.data.orderId} 未支付超时，已自动取消`);
      return;
    }

    if (job.name === 'daily-report') {
      console.log(`[${now()}] 生成报表，参数：${JSON.stringify(job.data)}`);
    }
  },
  { connection },
);

worker.on('completed', job =>
  console.log(`[${now()}] ${job.name} 完成，共尝试 ${job.attemptsMade} 次`),
);

worker.on('failed', (job, err) => {
  const final =
    err instanceof UnrecoverableError ||
    (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
  const tail = final ? '，最终失败落入死信' : '，稍后自动重试';
  console.error(`[${now()}] ${job?.name} 第 ${job?.attemptsMade} 次失败：${err.message}${tail}`);
  if (final) {
    // 生产里：写 failed_jobs 表 + 推送告警，留下遗言
  }
});
```

**第 3 步：跑重试验证。** 文件末尾加上投递代码并运行：

```ts
async function main() {
  // 实验 1：重试策略 + 错误分类
  const retryOpts = { attempts: 5, backoff: { type: 'exponential' as const, delay: 1000 } };
  await queue.add('send-email', { email: 'flaky@example.com' }, retryOpts); // 会抖两次
  await queue.add('send-email', { email: 'not-an-email' }, retryOpts);       // 参数错误
}

main();
```

执行 `npx tsx task-control-lab.ts`（没装过 tsx 会自动拉取），盯控制台：

```
[10:00:00] send-email 第 1 次失败：SMTP 连接超时，稍后自动重试
[10:00:00] send-email 第 1 次失败：邮箱格式非法：not-an-email，最终失败落入死信
[10:00:01] send-email 第 2 次失败：SMTP 连接超时，稍后自动重试
[10:00:03] send-email 完成，共尝试 3 次
```

对着时间戳读三件事：第 1 次失败到第 2 次隔约 1 秒，第 2 次到成功隔约 2 秒，间隔翻倍，这就是 exponential 退避；`not-an-email` 只出现一行就进死信，attempts 剩 4 次也不浪费；`attempts: 5` 是上限不是目标，第 3 次成功就收工。看完 Ctrl+C 退出即可。这一段就是产出里的「重试验证」。

**第 4 步：延迟任务。** 往 `main` 里追加实验 2：

```ts
  // 实验 2：延迟任务。演示用 10 秒，正式场景把常量换成 5 * 60 * 1000
  const TEN_SECONDS = 10_000;
  await queue.add('cancel-unpaid-order', { orderId: 'A-1001' }, { delay: TEN_SECONDS });
  await queue.add('cancel-unpaid-order', { orderId: 'A-1002' }, { delay: TEN_SECONDS });

  const counts = await queue.getJobCounts();
  console.log(`[${now()}] 投递完毕，delayed 里睡着 ${counts.delayed} 个任务`);
```

再跑一次。开头会打出「delayed 里睡着 2 个任务」，10 秒后两行日志准时到达：A-1002 已付款，跳过；A-1001 未支付，取消。注意 A-1002 走的是 completed 不是 failed，「到点但不用干」是正常完成。手册要求的 5 分钟版本：把 `10_000` 改成 `5 * 60 * 1000` 再投一次，等 5 分钟回来看，两行日志一字不差。这一段加上第 3 步，就是产出「重试 + 延迟验证」。delay 的单位是毫秒，`delay: 5` 之类的手滑不会报错，只是 5 毫秒后立刻执行。

**第 5 步：定时任务。** 往 `main` 末尾追加实验 3，并加上收摊代码：

```ts
  // 实验 3：Job Scheduler，先每 5 秒一次验证机制转得动
  await queue.upsertJobScheduler(
    'daily-report',
    { every: 5_000 },
    { name: 'daily-report', data: { range: '昨天 00:00 - 24:00' } },
  );
}

// 60 秒后收摊：先删调度器，再关连接
setTimeout(async () => {
  await queue.removeJobScheduler('daily-report'); // 不删它会常驻 Redis，明天还在跑
  await worker.close();
  await queue.close();
  connection.quit();
  process.exit(0);
}, 60_000);
```

跑起来每隔 5 秒打一行「生成报表」。60 秒后自动收摊。正式版把第二个参数换成 `{ pattern: '0 30 8 * * *', tz: 'Asia/Shanghai' }`，就是每天早 8 点半的报表任务，今天的实验到点会自动退出，不用等它。

::: tip 验收清单
以下五条全部亲眼看到，当日产出才算达成：退避间隔 1 秒、2 秒逐次拉长；`not-an-email` 一行日志进死信；delayed 计数从 2 变 0；已支付订单走 completed 分支；报表任务每 5 秒触发一次且删掉后安静。挂上 Day 4 提过的 bull-board，还能看到 delayed 状态里的任务趴在那等时间到。
:::

## 常见踩坑

**坑 1：processor 里 try/catch 把错误吞了。** 写业务代码的手感是 try/catch 兜底，但在 processor 里 catch 完不重新 throw，BullMQ 只看 Promise：不 reject 就是成功。任务带着真实的失败被标成 completed，重试不触发，死信不落库，邮件实际没发出去但账面全绿。想记日志就在 catch 里打完日志再把错误原样 throw 出去，吞错等于假完成。

**坑 2：不分类，所有错误一律重试到底。** 参数错误重试 5 次，同一个堆栈打 5 遍还是小事；如果 processor 里有副作用（发短信、扣库存），确定性失败重试 5 次就是 5 次重复副作用。分类要放在 processor 入口最先做：先把「重试也不会变好」的用 `UnrecoverableError` 拦下，剩下的才值得占用重试预算。

**坑 3：延迟任务到点闭眼执行。** 到点后不查订单最新状态，直接执行取消，用户在第 4 分钟付的款照样被取消，这是资损级事故。想提前取消可以用 `queue.removeJob(job.id)`，但支付回调和到点执行可能只差几毫秒撞车，remove 不是绝对保险。「到点复查、状态不对就正常返回」是最后一道闸，必须有。

**坑 4：Job Scheduler 残留。** 调度器注册一次就常驻 Redis，跨进程重启、跨项目生命周期。今天实验完忘了 `removeJobScheduler`，明天你的控制台还在每 5 秒打一行报表。顺带澄清一个误会：`removeOnComplete` 清理的是已完成的 job 记录，删不掉调度本身，定时任务第二天照样准点再来。

**坑 5：cron 时区想当然。** 不写 `tz` 时 pattern 按进程所在时区解读，而容器镜像的默认时区多是 UTC，你以为的北京时间 8:30 实际是 16:30 才触发。跨时区部署的服务一律显式写 `tz: 'Asia/Shanghai'`。另外 BullMQ 的 cron 是六段式，秒在最前面，从老系统抄来五段 cron 直接贴，含义会整体错一位。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么重试必须带退避？如果 1000 个任务同时失败且都立即重试，会发生什么？

::: details 参考答案
失败时下游往往正在故障或过载，立即重试大概率再撞一次南墙。1000 个任务同时失败、同时立即重试，等于对刚倒下的下游再来一轮齐射（重试风暴），把本可几秒恢复的服务彻底打死。exponential 退避让间隔逐次翻倍，给下游留出恢复窗口，也错开了重试的峰。
:::

2. 判断一个错误能不能重试的标准是什么？`UnrecoverableError` 抛出后 job 的命运是什么？

::: details 参考答案
标准：把同样的任务原封不动再执行一次，结果有没有可能变好。网络超时、下游 5xx、限流是环境错误，可能自愈，该重试；参数校验失败、业务规则不满足是确定性错误，永远同样结果，不该重试。抛出 `UnrecoverableError` 后 job 立即进入 failed 终局，剩余的 attempts 全部作废，只占一次执行。
:::

3. `attempts: 5` 最多执行几次？failed 事件里怎么判定「最终失败」该落死信了？

::: details 参考答案
最多执行 5 次，含首次，即最多 4 次重试；第 3 次成功就停，不是必须跑满。判定终局：`err instanceof UnrecoverableError`（可能首次即终局，次数没用完），或 `job.attemptsMade >= (job.opts.attempts ?? 1)`（次数用尽）。两者满足其一就该写失败表、推告警。
:::

4. 延迟任务到点后为什么要先复查业务状态再动手？这 5 分钟里可能发生了什么？

::: details 参考答案
任务只是约定了「5 分钟后来看一眼」，不是「5 分钟后必须取消」。这 5 分钟里用户可能已完成支付、订单可能被客服手动处理。闭眼执行会把已支付订单强制取消，造成资损。`queue.removeJob` 可以提前撤任务，但存在和到点执行撞车的可能，所以到点复查状态、不对就正常返回，是必须保留的最后防线。
:::

5. 新版 BullMQ 用什么 API 注册定时任务？`{ pattern: '0 30 8 * * *', tz: 'Asia/Shanghai' }` 表示什么？注册后忘了删会怎样？

::: details 参考答案
用 `queue.upsertJobScheduler(调度器id, repeat选项, 任务选项)`，同一 id 重复调用是更新，天然幂等；旧的 `repeat` 选项写法 v5.16 起废弃、v6 已移除。该配置表示按上海时间每天 08:30:00 投出一个 job，cron 是六段式，最左是秒。调度器常驻 Redis，忘了 `removeJobScheduler` 它就按节奏一直投任务，重启进程也拦不住。
:::

## 延伸阅读

- [BullMQ 官方文档：Retrying Failing Jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)，attempts、backoff 与重试生命周期的原始出处
- [BullMQ 官方文档：Job Schedulers](https://docs.bullmq.io/guide/job-schedulers)，新版定时任务全貌，含 repeat 选项的废弃迁移说明
- [BullMQ 模式：Stop Retrying Jobs](https://docs.bullmq.io/patterns/stop-retrying-jobs)，`UnrecoverableError` 的官方示例与适用场景

今天看着「共尝试 3 次」心里可以留个疙瘩：如果第 1 次尝试把邮件发出去一半才崩呢？同一个任务被处理多次时，下游怎么保证不重复生效，正是明天 Day 6 幂等性设计要收的口。
