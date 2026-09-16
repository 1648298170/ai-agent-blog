# 第 20 周 · Day 2：NestJS BFF——给前端配一个专职后端

> 对应手册任务：学习「把 NestJS BFF 接入模板」，动手「用 NestJS 做 BFF，代理前端请求到 FastAPI Agent 服务」，当日产出「BFF 层」。本篇只解决一个问题：前端不该直连 FastAPI Agent。在 Next.js 和 Agent 之间补一层专为前端服务的 NestJS BFF，聚合、鉴权收口、裁剪、隔离四件事一次做对，三条技术栈（Next.js、NestJS、FastAPI）从今天起正式同台。

## 今日目标

1. 说得清 BFF 是什么，能对「为什么不让前端直连 Agent」给出四个理由，每个配一个例子
2. 把整条请求链路定型下来：浏览器 → Next.js → NestJS BFF → FastAPI Agent → LLM，并解释清楚为什么这条路上不存在 CORS
3. 独立写出 BFF 的 chat 模块：proxy 控制器转发请求、自动附带 service token、以 `text/event-stream` 逐块透传流式响应、给下游设好超时初值，最后用 curl 走通全程

## 概念讲解：为什么不让前端直连 Agent

昨天你用 Configurator 生成了模板项目，frontend 的 Next.js 和 backend 的 FastAPI 都过了一遍。动手写代码之前，先回答一个架构问题：浏览器里的聊天请求，到底发给谁？

最直觉的答案：前端直接 fetch FastAPI 的 `http://127.0.0.1:8000/chat/stream`。跑起来第一个撞墙的就是 CORS——Agent 不配跨域响应头，浏览器直接把请求按死。但 CORS 只是最浅的一层皮，配一下就过去了。真正让直连方案越写越疼的是下面四件事。

**第一件，聚合。** 一个对话页面要三样数据：历史消息、当前用户信息、Agent 的流式回复，对应三个接口。前端直连就是三个请求、三次带 token、三套错误处理分别写；页面再复杂一点，变成七八个。BFF 出一个接口，把三路数据聚成一个响应，前端一次拿全。「页面要什么形状，我就返回什么形状」，这种按前端定制服务的思路，就是名字里 Backend for Frontend 的由来。

**第二件，鉴权收口。** 前端直连意味着 Agent 也必须认识用户 token，校验逻辑在前端入口和 Agent 各写一份，哪天换了签名算法要同步改两处，漏一处就是越权事故。有了 BFF，用户 token 的校验到 BFF 为止，只做一次；BFF 调 Agent 时换另一张脸，用服务身份。用户 token 到 BFF 结束，service token 从 BFF 开始，两段信任边界清清楚楚。

**第三件，裁剪。** Agent 的响应里有一堆不该出门的内部字段：用的哪个 model、内部 trace_id、这次调用花了多少 token 成本、prompt 模板版本。直连时这些全部裸奔到浏览器，任何人打开 F12 都能看个遍。BFF 在中间挑挑拣拣，给前端的只有该看的，内部字段留在内网。

**第四件，隔离。** 走 BFF 之后，Agent 可以不发公网，可以独立扩容、独立重启、独立升级，浏览器永远只认识一个域名。直连则把 Agent 绑死在公网上，浏览器的网络抖动直接砸到 Agent 身上，Agent 想重启都得先想想前端会不会报错。

四件事说到底是同一句话：把「服务前端」这个职责从 Agent 里剥出来，单独成层。这一层，就是今天要写的 BFF。

## 核心知识

### 1. 架构定型：请求走哪条路

把链路画下来，今天之后你的项目里请求固定走这条路：

```
浏览器 → Next.js → NestJS BFF → FastAPI Agent → LLM
```

三个要点。第一，浏览器只跟 Next.js 说话，页面和接口同源。第二，从 Next.js 往后，每一跳都是服务端发起 HTTP：Next.js 的服务端代码调 BFF，BFF 调 Agent，Agent 调 LLM，SSR 链路上没有浏览器的份。第三，LLM 只被 Agent 调用，别的地方一概碰不到。

这里回答一个昨天读模板时最容易冒出来的问题：这条路上怎么没有 CORS？因为跨域是浏览器安全模型里的概念，只有「浏览器里跑的代码去访问另一个源」才成立。页面和它请求的接口同源，跨域无从谈起；而从 Next.js 开始往后全是服务端对服务端，HTTP 客户端根本不受同源策略约束。所以不是「解决了 CORS」，是这条路从根上碰不到它。你第 5 周配过的那套 CORS 中间件，在这条链路上没有出场机会。

再回答第二个问题：Next.js 自己有 API route，顺手做转发不行吗？小项目可以。但你第 5 周在 NestJS 练的 Guard、第 10 周在 FastAPI 练的分层，在 NestJS 里有现成的模块、依赖注入、拦截器体系接着；API route 是「顺手能做」，NestJS 是「专职来做」。还有一层考虑：BFF 挂了不拖累 Next.js 渲染静态页面。模板选了独立 BFF，我们照着做，取舍细节知道有这一问即可。

### 2. proxy 控制器：@Controller('api/chat')

BFF 的骨架薄到不像话，一个普通控制器把请求搬给 Agent：

```ts
// apps/bff/src/chat/chat.controller.ts（先看骨架，完整版在动手任务里）
import { Body, Controller, Post } from '@nestjs/common';

@Controller('api/chat')
export class ChatController {
  @Post()
  async chat(@Body() dto: { message: string }) {
    // 把 dto 转发给 AgentService，再把结果还给前端
  }
}
```

薄不是缺点，位置才是重点：往后所有「为前端加工数据」的逻辑都长在这一层，聚合也好、裁剪也好、明天 Day 3 的多租户 RBAC 也好，都不再污染 Agent。真正的活儿在 AgentService 里，见下一小节。

### 3. 服务间认证：service token

BFF 调 Agent 不是匿名调用。Agent 不发公网，不代表内网里就可以裸奔：一旦内网有机器被攻破，无认证的 Agent 就是整条链路上最软的那块肉。做法是服务间认证——BFF 每次调 Agent，带一张「内部签名的 JWT」，也就是 service token。

它和你第 5 周给用户签的 JWT 是同一套技术：HS256 签名、带过期时间、验签防伪造。区别只有受众——用户 JWT 声明「我是某个用户」，service token 声明「我是 BFF 这台服务」。签发和校验的原理你在第 5 周 NestJS 侧全练过，第 10 周又在 FastAPI 侧练了 Depends 依赖注入，今天就是把两侧功力合起来用。

BFF 侧的写法（每次请求前现签一张，短有效期）：

```ts
import * as jwt from 'jsonwebtoken';

private signServiceToken(): string {
  return jwt.sign(
    { scope: 'bff' }, // 只声明服务身份，不带任何用户信息
    process.env.SERVICE_JWT_SECRET ?? 'dev-only-secret',
    { expiresIn: '30s' }, // 有效期只要盖住一次调用
  );
}
```

现签的代价可以忽略：HS256 是纯计算，微秒级。换来的是不用管理 token 的发放和吊销，泄露窗口也只有 30 秒。`SERVICE_JWT_SECRET` 由 BFF 和 FastAPI 共享，只活在两台服务的环境变量里，永远不出现在任何前端代码和 Git 仓库中。FastAPI 侧怎么校验，动手任务第 4 步见。

### 4. 流式透传：BFF 不能攒流

第 10 周 Day 5 你在 FastAPI 侧写过 StreamingResponse，让回复一个字一个字往外吐。今天 BFF 要做的，是把这条流原样搬给浏览器，一块都不能攒。

先看最顺手也最致命的错写法：

```ts
// 错误示范：把流读完再返回
const res = await this.http.post('/chat/stream', payload);
return res.data; // 等 Agent 全部生成完才拿到，用户干等 10 秒
```

axios 默认 `responseType: 'json'`，会把响应体整个攒在内存里，流结束了 Promise 才 resolve。你第 10 周辛苦换来的「300 毫秒出第一个字」，在 BFF 这层被悄悄没收了。正确姿势分两步。

第一步，声明 `responseType: 'stream'`，让 axios 把响应体当成 Node 的 Readable 流交给你，而不是替你攒成完整数据：

```ts
const res = await this.http.post('/chat/stream', payload, {
  responseType: 'stream', // 关键：拿到流本身，而不是流的内容
  headers: { Authorization: `Bearer ${this.signServiceToken()}` },
});
return res.data; // Node 的 Readable，支持 for await...of
```

第二步，控制器用 `@Res()` 接管原生响应对象，先写头，再逐块转发：

```ts
@Post('stream')
async chatStream(@Body() dto: ChatRequest, @Res() res: Response) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // 告诉反向代理别替我攒
  res.flushHeaders(); // 响应头先走，浏览器立刻进入接收状态

  const stream = await this.agent.chatStream(dto);
  for await (const chunk of stream) {
    res.write(chunk); // Agent 吐一块，浏览器收一块
  }
  res.end();
}
```

三个响应头和第 10 周 FastAPI 侧那三个一模一样，不是巧合：BFF 转发的是同一种流，浏览器这头需要同样的约定。另外注意，一旦用了 `@Res()`，NestJS 的拦截器和序列化都会被跳过，响应从头到尾归你管，`res.end()` 不写连接就一直悬着。

### 5. 超时初值：管住等响应，别掐生成的流

BFF 是前端和 Agent 之间唯一的桥，Agent 卡死时 BFF 不能陪着卡死。今天给两层超时初值，完整熔断器（连续失败快速失败、半开探测）等监控周有了指标再上，Node 生态有现成的库（比如 opossum），到时候直接接。

第一层，连接和响应头阶段：`axios.create({ timeout: 15_000 })`，15 秒拿不到响应头就当 Agent 已死，果断断开。第二层，流式读取阶段：响应头到了之后 LLM 慢慢生成 60 秒是正常的，不能设整体超时去掐；要防的是「Agent 半路死掉，流悬在半空」——用空闲看门狗，超过 30 秒没有新数据就销毁流：

```ts
// 空闲看门狗：每收到一块数据重置计时，超时没有新块就 destroy
private withIdleTimeout(stream: NodeJS.ReadableStream, idleMs: number) {
  let timer = setTimeout(() => stream.destroy(), idleMs);
  stream.on('data', () => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.destroy(), idleMs);
  });
  stream.on('end', () => clearTimeout(timer));
  return stream;
}
```

`destroy()` 之后，控制器里的 `for await` 会抛错，正好落进 catch 分支给前端发一条 error 事件。两层配合，慢流能等，死流能断。至于 axios 的 `timeout` 在 `responseType: 'stream'` 下到底管到哪一步，各版本行为有差异，所以流上的安全不看它，看自己的看门狗——别把安全寄托在库的边缘行为上。

## 动手任务：BFF chat 模块一步一步

手册任务：用 NestJS 做 BFF，代理前端请求到 FastAPI Agent 服务。拆成 5 步，全程约 40 分钟。今天的产出是三个文件加一处改动，全部在昨天生成的模板项目里。

**第 1 步：建文件。** 在模板的 NestJS 应用（`apps/bff`）里新建 chat 模块，三个文件手写或用 `nest g` 生成都行：

```
apps/bff/src/chat/
├── chat.module.ts
├── agent.service.ts
└── chat.controller.ts
```

模块注册一行：

```ts
// apps/bff/src/chat/chat.module.ts
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { AgentService } from './agent.service';

@Module({
  controllers: [ChatController],
  providers: [AgentService],
})
export class ChatModule {}
```

别忘了在 `app.module.ts` 的 `imports` 数组里加上 `ChatModule`。

**第 2 步：写 AgentService。** 先装依赖：

```bash
cd apps/bff
npm install axios jsonwebtoken
npm install -D @types/jsonwebtoken
```

然后写对下游的全部出口，service token 的签发也收在这一个文件里：

```ts
// apps/bff/src/chat/agent.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';

export interface ChatRequest {
  message: string;
  historyId?: string;
}

@Injectable()
export class AgentService {
  // 对下游 Agent 的专用 HTTP 实例：baseURL、超时、认证都收在这一个口子
  private readonly http = axios.create({
    baseURL: process.env.AGENT_SERVICE_URL ?? 'http://127.0.0.1:8000',
    timeout: 15_000, // 第一层超时：15 秒拿不到响应头就断
  });

  // 流式：转发 /chat/stream，返回 Node 的 Readable 流
  async chatStream(payload: ChatRequest) {
    const res = await this.http.post('/chat/stream', payload, {
      responseType: 'stream',
      headers: { Authorization: `Bearer ${this.signServiceToken()}` },
    });
    return this.withIdleTimeout(res.data, 30_000); // 第二层：空闲看门狗
  }

  private signServiceToken(): string {
    return jwt.sign(
      { scope: 'bff' },
      process.env.SERVICE_JWT_SECRET ?? 'dev-only-secret',
      { expiresIn: '30s' },
    );
  }

  private withIdleTimeout(stream: NodeJS.ReadableStream, idleMs: number) {
    let timer = setTimeout(() => stream.destroy(), idleMs);
    stream.on('data', () => {
      clearTimeout(timer);
      timer = setTimeout(() => stream.destroy(), idleMs);
    });
    stream.on('end', () => clearTimeout(timer));
    return stream;
  }
}
```

关键在 `axios.create` 这个动作：baseURL、timeout、认证头集中在构造时声明，明天加租户头、后天加用户上下文，都只改这一个文件。

**第 3 步：写控制器，流式透传。** 这是今天的主体：

```ts
// apps/bff/src/chat/chat.controller.ts
import { Body, Controller, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { AgentService, ChatRequest } from './agent.service';

@Controller('api/chat')
export class ChatController {
  constructor(private readonly agent: AgentService) {}

  @Post('stream')
  async chatStream(@Body() dto: ChatRequest, @Res() res: Response) {
    // 三个响应头：和第 10 周 FastAPI 侧的同款约定
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const stream = await this.agent.chatStream(dto);
      for await (const chunk of stream) {
        res.write(chunk); // Agent 吐一块，浏览器收一块
      }
    } catch {
      // Agent 掉线或看门狗掐流：发一条 error 事件，而不是挂死连接
      res.write('event: error\ndata: {"message":"agent unavailable"}\n\n');
    } finally {
      res.end(); // 无论如何都收尾
    }
  }
}
```

两个容易忽略的点。`res.flushHeaders()` 让响应头立刻出发，浏览器不等第一块数据就进入流式接收状态；`finally` 里的 `res.end()` 保证任何分支下连接都会关闭，忘写它，连接耗尽是迟早的事。

**第 4 步：FastAPI 侧挂上校验。** 到 BFF 为止只算修了一半，Agent 这头得真的验。装 PyJWT，然后写依赖：

```bash
pip install pyjwt
```

```python
# agent-service/app/deps.py
import os
import jwt
from fastapi import Header, HTTPException

SERVICE_JWT_SECRET = os.environ.get("SERVICE_JWT_SECRET", "dev-only-secret")

async def require_service_token(authorization: str = Header(...)):
    """校验 BFF 的服务身份 token，不过就 401"""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        payload = jwt.decode(
            authorization.removeprefix("Bearer "),
            SERVICE_JWT_SECRET,
            algorithms=["HS256"],
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="invalid service token")
    if payload.get("scope") != "bff":
        raise HTTPException(status_code=401, detail="wrong scope")
    return payload
```

再把第 10 周 Day 5 写好的流式路由挂上这道门，改动只有一行：

```python
# agent-service/app/api/routers/chat.py（只看改动行）
from fastapi import APIRouter, Depends
from app.deps import require_service_token

# 路由级依赖：这个 router 下的所有端点都先过 service token 校验
router = APIRouter(dependencies=[Depends(require_service_token)])
```

两侧共享的密钥用环境变量给：`SERVICE_JWT_SECRET=同一个值`。开发期两边的默认值一致就行，上线前必须换成真密钥并只走环境变量。

**第 5 步：起服务，curl 三连验证。** 两个终端：

```bash
# 终端 1：起 Agent（第 10 周的项目或模板的 backend）
cd agent-service && uvicorn app.main:app --port 8000

# 终端 2：起 BFF，注意避开 Next.js 的 3000 端口
cd apps/bff
PORT=3001 npm run start:dev
# Windows PowerShell 写法：$env:PORT="3001"; npm run start:dev
```

三条验证，一条都不能少：

```bash
# 验证 1：直打 Agent 不带 token，期望 401（服务间认证生效）
curl -i -X POST http://127.0.0.1:8000/chat/stream \
  -H "Content-Type: application/json" -d '{"message":"你好"}'

# 验证 2：打 BFF 流式端点，期望响应头三件套 + data: 逐块到达
curl -N -X POST http://127.0.0.1:3001/api/chat/stream \
  -H "Content-Type: application/json" -d '{"message":"你好"}'

# 验证 3：停掉 Agent 再打 BFF，期望收到 error 事件后连接正常关闭
curl -N -X POST http://127.0.0.1:3001/api/chat/stream \
  -H "Content-Type: application/json" -d '{"message":"你好"}'
```

验证 1 看到 401 和 `invalid service token`，说明 Agent 的门装上了；验证 2 用 `curl -N` 能看到 `data:` 一段一段打印出来，间隔肉眼可见，说明整条流式链路通了；验证 3 在几秒内收到 `event: error` 那一行且 curl 正常退出，说明 BFF 兜底生效，没有挂死。三样全过，BFF 层就算立住了。Next.js 侧的接线今天先不动，Day 6 平台导航时用 rewrites 把同域路径转给 BFF 一次配齐。

::: tip 前置条件
验证依赖第 10 周 Day 5 产出的 `/chat/stream` 端点。如果你的 Agent 项目里路径不同，把 AgentService 里的 `'/chat/stream'` 换成自己的。非流式的 `/chat` 转发今天没有写，Agent 侧也没有对应端点，Day 3 做聚合接口时自然会补上，今天聚焦流式这条主链路。
:::

## 常见踩坑

**坑 1：`@Res()` 一出手，NestJS 标准流程就靠边站。** 用了 `@Res()` 的路由，拦截器、序列化拦截器、自动状态码统统跳过，响应从头到尾你自己管。忘了 `res.end()` 连接就悬着，压测时连接数打满先炸的就是你。如果只想改改头、不想接管整个响应，改用 `@Res({ passthrough: true })`，NestJS 还会替你收尾。

**坑 2：攒流的不止 axios 一个。** `responseType` 忘写 `'stream'` 是第一处；BFF 前面如果挂了 Nginx，它默认也会缓冲响应，所以 `X-Accel-Buffering: no` 这行头别省；要是你给 NestJS 全局装了 compression 中间件，每次 `res.write` 之后还得补一句 `res.flush()`，否则又被它攒上了。流式链路上任何一层攒，用户看到的都是「干等 10 秒」，排查时逐层看，别只盯着自己的代码。

**坑 3：service token 泄到前端或仓库。** 它是 BFF 的服务身份，进了前端代码等于把内网钥匙发给所有人。三条纪律：只放在环境变量里；`.env` 加进 `.gitignore`；`dev-only-secret` 这个默认值只配开发期用，上线前换掉。代码里那两个 `?? 'dev-only-secret'` 是为了本地开箱能跑，不是让你带到生产的。

**坑 4：端口打架。** Next.js 默认 3000，NestJS 默认也是 3000，两个同时起必有一个起不来。约定俗成：Next.js 3000、BFF 3001、FastAPI 8000。今天用到的三个环境变量——`PORT`、`AGENT_SERVICE_URL`、`SERVICE_JWT_SECRET`——建议直接写进各自应用的 `.env`，明天加配置项时就在这个基础上长。

**坑 5：超时一刀切。** 给流式接口套一个整体 timeout（比如 20 秒），LLM 生成到一半被掐，前端收到半截回复还以为生成完了。方向反了也一样：完全不设，Agent 死掉后连接挂到天荒地老。记住今天的两层结构：响应头之前靠 axios 的 15 秒，流上靠 30 秒空闲看门狗，慢流能等，死流能断，两边都不误伤。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 不让前端直连 Agent 的四个理由，分别对应什么问题？

::: details 参考答案
聚合：一个页面要多个接口的数据，直连就得多请求多处理，BFF 按页面形状一次给全。鉴权收口：用户 token 只在 BFF 验一次，Agent 不需要认识用户。裁剪：内部字段（model、trace_id、成本）止步于 BFF，不出内网。隔离：Agent 不发公网，独立伸缩重启都不牵动前端，浏览器只认识一个域名。
:::

2. 浏览器 → Next.js → BFF → Agent 这条链路，为什么从头到尾没有 CORS？

::: details 参考答案
CORS 是浏览器安全模型的概念，只约束「浏览器里跑的代码访问另一个源」。浏览器只跟 Next.js 说话且同源，不触发；从 Next.js 往后全是服务端发 HTTP，服务端之间不存在同源策略。不是解决了 CORS，是这条路根本碰不到它。
:::

3. service token 和第 5 周的用户 JWT 有什么区别？30 秒的有效期为什么够用？

::: details 参考答案
同一套技术（HS256 签名、带过期、验签），区别在声明的内容：用户 JWT 说「我是某个用户」，service token 说「我是 BFF 这台服务」。够用是因为每次请求前现签，token 的生命期只需要覆盖一次 HTTP 调用，顺带把泄露窗口压到最小。签发是微秒级计算，现签不构成开销。
:::

4. BFF 攒流会发生什么？链路上有哪些攒流的位置？

::: details 参考答案
用户体验退回「干等 10 秒才一次性出全文」，第 10 周做的流式在 BFF 这层失效。攒流的位置至少三处：axios 的 `responseType` 没写 `'stream'`（攒在内存里）、反向代理默认缓冲（用 `X-Accel-Buffering: no` 关掉）、compression 中间件（每次 write 后手动 `res.flush()`）。
:::

5. BFF 对下游的超时，流式和非流式接口分别怎么设？为什么不能一刀切？

::: details 参考答案
非流式：一个整体 timeout（如 15 秒）就够，响应完整才算完。流式必须分两层：响应头之前用 axios timeout 兜底，拿到流之后不能设整体超时（LLM 慢慢生成是正常的），改设空闲看门狗——超过阈值没有新数据块就销毁流。一刀切要么掐断正常的长生成，要么放任死流挂死连接。
:::

## 延伸阅读

- [NestJS 官方文档：Server-Sent Events](https://docs.nestjs.com/techniques/server-sent-events)，NestJS 自己当 SSE 服务端产出流式响应的官方做法，和今天「透传别人的流」对照着看，两种角色就都齐了
- [MDN：Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)，SSE 报文格式和响应头约定的一手资料，三个响应头的出处
- [Phil Calçado：The Backend for Frontend Pattern](https://philcalcado.com/2015/09/18/the_backend_for_frontend_pattern.html)，2015 年 SoundCloud 工程师提出 BFF 的原文，今天的四个收益往上翻能找到最初的动机

今天的产出 chat 模块留好。明天 Day 3 的多租户 RBAC 直接建在这层上，service token 的载荷里也快要装进租户信息了。
