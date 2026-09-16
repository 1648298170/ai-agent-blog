# 第 6 周 · Day 4：BullMQ 消息队列基础——让慢活离开主请求

> 对应手册任务：学习「BullMQ 消息队列基础：Queue/Worker/Job」，动手用 BullMQ 写一个「发送欢迎邮件」的异步任务，当日产出「异步邮件任务跑通」。本篇只解决一个问题：注册接口里又慢又不稳的活（发邮件）不该堵在响应路上，把它们扔进队列，让后台按自己的节奏干，失败了自动重试。

## 今日目标

1. 说得清队列解决什么问题，以及削峰、解耦、重试三大价值各自对应什么场景
2. 掌握三个概念：Queue 负责投递、Worker 负责消费、Job 是一次任务从 waiting 到 completed/failed 的完整生命周期
3. 独立跑通「注册后异步发欢迎邮件」：接口毫秒级返回，Worker 在后台模拟发信，并亲眼看一次失败自动重试的全过程

## 概念讲解：为什么需要队列

前三天 Redis 在我们手里先后当了缓存和锁，今天给它第三个身份：队列。先看一个具体的痛。

用户注册接口要做两件事：写库（约 20ms）、发欢迎邮件（约 3 秒，SMTP 就是这么慢）。剧本 A，同步发：

```ts
async register(dto: RegisterDto) {
  const user = await this.users.create(dto);   // 20ms
  await this.mailer.sendWelcome(user.email);   // 3000ms，堵在这
  return { id: user.id };
}
```

用户点完注册，盯着按钮转圈 3 秒才等到响应。慢只是体感问题，真正的麻烦在后面：SMTP 服务抖一下，这一行要么挂到超时，要么直接抛错。抛错最伤，用户其实已经写进库了，页面却告诉他失败，他换个姿势再提交一次，撞上「邮箱已注册」。下游（邮件服务）的故障，就这么拖垮了上游（注册接口）。

剧本 B，异步发：

```ts
async register(dto: RegisterDto) {
  const user = await this.users.create(dto);   // 20ms
  await this.emailQueue.addWelcomeEmail(user); // 约 1ms，扔个任务就完事
  return { id: user.id };                      // 总耗时约 21ms
}
```

发邮件这件事没有消失，只是搬了地方：接口只负责「写下一个任务」，后台的 Worker 按自己的节奏取出任务、慢慢发。对比出三个价值：

- 解耦。注册代码只认识「扔任务」这一个动作。明天邮件换服务商、加抄送、改模板，改的都是 Worker，注册服务一行不动。
- 削峰。搞活动每秒涌进 1000 个注册，Worker 每秒只消化得动 50 封也没事，队列把剩下的攒着慢慢发，接口永远毫秒级。剧本 A 遇上这流量，HTTP 连接池和 SMTP 早就双双阵亡。
- 重试。发信碰上网络抖动，任务自动再来一次，还能带退避。注册代码里一行 try/catch 都不用写。

这就是生产者消费者模型：注册接口是生产者，只管往队列写「要发邮件」这件事；Worker 是消费者，从队列取活干活；Redis 里的队列是两边的缓冲带。生产和消费可以不同速、不同进程，甚至不同机器。BullMQ 是这套模型在 Node 生态最主流的实现，底层还是你第 1 天装的那个 Redis。

## 核心知识

本节的代码围绕动手任务的项目展开，可以先通读建立地图，最终以动手任务的完整文件为准。

### 1. Queue、Worker、Job 三概念与代码骨架

三个类各管一段：

```ts
import { Queue, Worker, Job } from 'bullmq';

// 生产者：往队列投递任务，一个应用里建一次、到处复用
const queue = new Queue('welcome-email', {
  connection: redis, // 复用第 1 天 RedisModule 的 ioredis 实例
});

// 投一个任务：任务名 + 数据 + 选项
await queue.add('welcome-email', { userId: 1, email: 'jerry@example.com' }, {
  attempts: 3,                                    // 最多尝试 3 次
  backoff: { type: 'exponential', delay: 1000 },  // 失败后隔 1s、2s、4s 再来
});

// 消费者：守着队列取任务，processor 每次处理一个
const worker = new Worker(
  'welcome-email',                                // 名字必须和 Queue 一致
  async (job: Job) => {
    console.log(`给 ${job.data.email} 发欢迎邮件`);
  },
  { connection: redis, concurrency: 5 },          // 同时处理 5 个任务
);
```

Queue 是投递口，只写不读；Worker 是消化口，守着队列等活；Job 是一个具体任务的实例，`job.data` 是你 add 时传的数据，`job.id` 是它的身份证。两边靠同名队列对话，名字对不上就是最经典的翻车现场，踩坑区细说。

connection 传第 1 天的 ioredis 实例是安全的：BullMQ 在需要阻塞命令的地方会自动 duplicate 出新连接，不会把你共享的那条连接堵死。Worker 因为要用阻塞命令等活，天生要多占一条连接，这是它和 Queue 的一个隐藏差别。

### 2. Job 的生命周期

一个 job 从 add 那一刻起有了状态，核心流转是：waiting → active → completed 或 failed。投递后在 waiting 排队；Worker 取走进入 active；processor 的 Promise resolve 就是 completed，抛错就是 failed。

failed 不一定是终局。attempts 还有剩余时，BullMQ 把任务挪进 delayed 睡一个退避时长，再送回 waiting 等下一轮，直到成功或次数用尽。两个事件钩子最常用，排障全靠它们：

```ts
worker.on('completed', job => {
  console.log(`[${job.id}] 发送完成，共尝试 ${job.attemptsMade} 次`);
});

worker.on('failed', (job, err) => {
  console.error(`[${job?.id}] 第 ${job?.attemptsMade} 次失败：${err.message}`);
});
```

想看全队列的账本，Queue 上有现成的：`await queue.getJobCounts()` 返回 waiting、active、completed、failed、delayed 各多少个。想看图形界面也有：官方的 Taskforce.sh 或开源的 bull-board，几行代码挂个路由就能看到每个 job 的明细，今天知道存在即可，不展开。

### 3. 为什么用 BullMQ，而不是裸 Redis List

学完第 1 天你可能会想：List 不就是队列吗？LPUSH 进、BRPOP 出，十行代码的事：

```ts
await redis.lpush('jobs', JSON.stringify({ userId: 1, email: 'jerry@example.com' }));
const [, raw] = await redis.brpop('jobs', 0); // 0 表示没活就一直等
```

能跑，但四件事得自己造轮子：

1. 没有 ACK。BRPOP 取出的瞬间任务就从 List 里消失了，消费者还没处理完就崩溃，这个任务永久丢失，没有任何补偿。
2. 没有重试。处理失败任务不会回来，想重试得自己写「失败塞回队列加计数」。
3. 没有延迟。List 说不了「5 分钟后再执行」，得自己拿 ZSet 加轮询拼一个。
4. 没有优先级、并发控制、限速、状态查询，面板更是无从谈起。

BullMQ 把这些全包了：底层用 Hash 存任务数据、ZSet 管理 waiting/delayed/优先级、Stream 推事件；任务取走没确认就视作未完成、自动回队重试。手写这些不难，写对很难，所以几乎没人手写。

## 动手任务：异步欢迎邮件一步一步

手册任务：用 BullMQ 写一个「发送欢迎邮件」的异步任务，注册接口投递、Worker 后台模拟发送。拆成 5 步，全程约 25 分钟。

**第 1 步：装包。** 在项目根目录执行 `npm install bullmq`。Redis 用第 1 天装的那个，不需要任何额外组件。

**第 2 步：写生产者 EmailQueueService。** 新建 `src/email/email-queue.service.ts`，把 Queue 包成一个可注入的服务：

```ts
import { Injectable, Inject, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

@Injectable()
export class EmailQueueService implements OnModuleDestroy {
  private readonly queue: Queue;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {
    // REDIS_CLIENT 换成你第 1 天 RedisModule 实际定义的注入令牌
    this.queue = new Queue('welcome-email', { connection: this.redis });
  }

  addWelcomeEmail(user: { id: number; email: string }) {
    // 只传 Worker 干活必需的最小字段，原因见踩坑 4
    return this.queue.add(
      'welcome-email',
      { userId: user.id, email: user.email },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100, // 完成的任务保留最近 100 条，方便排查
      },
    );
  }

  async onModuleDestroy() {
    await this.queue.close(); // 退出前关连接，养成习惯
  }
}
```

关键在构造函数里那句 `new Queue(...)`：整个应用只建一个 Queue 实例反复用，别每发一封邮件 new 一个，那是在给 Redis 制造连接垃圾。

**第 3 步：注册接口投递任务。** 在注册服务里注入 EmailQueueService，写完库就投递：

```ts
async register(dto: RegisterDto) {
  const user = await this.users.create(dto);
  await this.emailQueue.addWelcomeEmail(user);
  return { id: user.id };
}
```

跑起来调一次注册接口，体感立变：原来转圈 3 秒，现在几乎瞬间返回。邮件还没发，但「要发」这件事已经落在 Redis 里了。

**第 4 步：写 Worker。** 新建 `src/email/email.worker.ts`，同样做成可注入的服务，模块初始化时启动：

```ts
import { Injectable, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';

@Injectable()
export class EmailWorker implements OnModuleInit, OnModuleDestroy {
  private worker: Worker;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleInit() {
    this.worker = new Worker(
      'welcome-email',
      async (job: Job) => {
        console.log(`[${job.id}] 开始给 ${job.data.email} 发欢迎邮件`);
        // 模拟 SMTP 耗时，真实项目里换成 nodemailer 发信
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`[${job.id}] 欢迎邮件已发送`);
      },
      { connection: this.redis, concurrency: 5 },
    );

    this.worker.on('completed', job =>
      console.log(`[${job.id}] completed，共尝试 ${job.attemptsMade} 次`),
    );
    this.worker.on('failed', (job, err) =>
      console.error(`[${job?.id}] failed（第 ${job?.attemptsMade} 次）：${err.message}`),
    );
  }

  async onModuleDestroy() {
    await this.worker.close();
  }
}
```

关键在 processor 里的 `await`：BullMQ 以 Promise 定成败，resolve 即 completed、reject 即 failed。模拟耗时的 setTimeout 必须包成 Promise 等掉，否则任务瞬间「假完成」。

**第 5 步：跑通，再看一次重试。** 把两个服务注册进 EmailModule 的 providers，EmailQueueService 放进 exports，再让注册接口所在模块 import EmailModule。重启应用，开始验收。

先跑正常流程：调注册接口，盯控制台。顺序应该是：接口立刻返回 201，约两秒后打出「开始给 xx 发邮件」，接着「欢迎邮件已发送」「completed」。任务在后台完成，主请求从头到尾没等它。

再看重试：在 processor 第一行临时加一句 `if (job.data.email.startsWith('fail')) throw new Error('SMTP 模拟故障');`，注册一个 `fail@example.com`。控制台会演出完整剧本：failed，睡 1 秒再来，failed，睡 2 秒再来，三次用尽，failed 终局。看完把这句删掉，保持任务能跑通，这就是当日产出。

::: tip 顺手看一眼底层
用第 1 天的 redis-cli 执行 `keys bull:welcome-email:*`，能看到 BullMQ 的底层结构：Hash 存任务数据，ZSet 管排队和延迟。队列账本则给 EmailQueueService 加个方法，内部调 `this.queue.getJobCounts()` 就有。想看图形界面，bull-board 挂个路由就行，留到明天玩个够。
:::

## 常见踩坑

**坑 1：Queue 和 Worker 的名字对不上。** 投递用 `welcome-email`，Worker 写成 `welcome_email`，add 照样成功、日志一行不报，任务全卡在 waiting 没人消费。这类 bug 的特征就是「无报错、无消费」，排查时先逐字比对两边队列名，连大小写一起比。

**坑 2：以为重试是默认就有的。** attempts 不写默认就是 1，失败一次直接终局 failed。所谓「开箱即用的重试」，指的是配一个字段就生效，不是不配也有。顺手把 backoff 带上，不然三次重试会在几十毫秒内连环撞墙，等于没歇。

**坑 3：processor 里丢掉 await，任务假完成。** processor 是 async 函数，里面调异步操作不等它，Promise 立刻 resolve，job 秒变 completed，实际活儿还悬在空中。今天第 4 步的 setTimeout 是故意的教具，真实场景里换成 `await mailer.send(...)` 是同一个道理：异步链断在哪，任务就假完成在哪。

**坑 4：往 job.data 里塞整个用户对象。** job.data 会原样躺在 Redis 里，挂上 bull-board 后页面上看得一清二楚。密码哈希、token 这类字段绝不进队列；正确姿势是只传 userId，Worker 拿 id 现查库，还能顺带拿到最新资料。超大的 payload 同理别塞，Redis 内存不是这么花的。

**坑 5：把任务队列当发布订阅用。** 起两个 Worker 监听同一个队列，一个任务只会被其中一个处理，两边是竞争消费，不是广播。队列里的任务是「要做的事」，做完就没了；想要一份消息人人都收到一份，那是 Redis Pub/Sub 或 Stream 的活，别找错工具。竞争消费恰好是我们想要的：多起一个 Worker 就是加一份吞吐。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 注册接口同步发邮件，除了慢，还有哪两个致命伤？削峰、解耦、重试分别解决什么场景？

::: details 参考答案
致命伤：一是脆，下游邮件服务抖动直接把注册接口拖下水，返回失败但用户已入库，引发重复提交；二是不可恢复，失败就失败了，没有重试机制。解耦：下游逻辑变更不动上游代码；削峰：流量洪峰被队列吸收，消费按固定速率消化；重试：临时故障自动退避重试，不用手写补偿逻辑。
:::

2. Queue、Worker、Job 各是什么角色？谁是生产者，谁是消费者？

::: details 参考答案
Queue 是投递口，生产者（注册接口）调 add 把任务写进 Redis；Worker 是消化口，用阻塞命令等活，取出任务执行 processor；Job 是一个任务的实例，携带 data、id 和全部状态。Queue 只写、Worker 只读，两者靠同名队列对话。
:::

3. 一个 job 从投递到完成经过哪些状态？failed 一定是终点吗？

::: details 参考答案
waiting（排队）→ active（Worker 取走）→ completed 或 failed。failed 不是终点：attempts 还有剩余时，任务先进 delayed 睡一个退避时长，再回 waiting 等下一轮，直到成功或次数用尽。判断一个 failed 任务还有没有救，看 attempts 和 attemptsMade 的差值。
:::

4. 裸 Redis List 十行就能实现队列，为什么还要 BullMQ？

::: details 参考答案
List 没有 ACK：BRPOP 取出的瞬间任务即消失，消费者中途崩溃任务就永久丢；也没有重试、延迟、优先级、并发控制，状态查询和面板无从谈起。BullMQ 用 Hash 存数据、ZSet 管排队延迟优先级、Stream 推事件，把不丢、可重试、可观测这三件事全做成了配置项。
:::

5. 起三个 Worker 监听同一个队列，一个 job 会被处理几次？

::: details 参考答案
一次。多个 Worker 是竞争消费，任务出队即被其中一个独占。想横向扩容提高吞吐，多起几个 Worker 就行，这正是任务队列的用法；想要一份消息多方订阅，得换 Pub/Sub 或 Stream。
:::

## 延伸阅读

- [BullMQ 官方文档](https://docs.bullmq.io/)，Queue/Worker/Job 三章是本篇的原始出处，Connections 一节把连接复用讲得比本篇更细
- [BullMQ GitHub 仓库](https://github.com/taskforcesh/bullmq)，README 的示例可对照今天的骨架看，issue 区是排障素材库
- [bull-board](https://github.com/felixmosh/bull-board)，开箱即用的队列面板，明天玩重试和延迟任务时挂上，job 状态一目了然

今天的 `welcome-email` 队列留好，明天在它上面配重试策略、做延迟 5 分钟的任务，那正是 Day 5 的主菜。
