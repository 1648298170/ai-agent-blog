# 第 7 周 · Day 3：前端 Docker 化——Next.js 镜像与 Nginx 统一入口

> 对应手册任务：学习「前端 Docker 化 + Nginx 静态服务」，动手「为 Next.js 写 Dockerfile，用 Nginx 服务静态资源」，当日产出「`web.Dockerfile` + Nginx 配置」。本篇只解决一个问题：api、postgres、redis 都进了容器（见[第 7 周](/week07/) Day 1、Day 2），浏览器访问的 web 还悬在外面靠 `npm run dev` 撑着；今天把 Next.js 也打成镜像，再放进一个 Nginx 容器当全家桶的唯一大门，静态资源怎么发、缓存怎么设、`/api` 请求转给谁，在门口一次定好。

## 今日目标

1. 说得清 Next.js 容器化的两条路线：standalone 服务端运行与静态导出，各自适用什么项目，以及为什么用了 RSC 或 Server Actions 就只剩 standalone 一条路
2. 写出三阶段 `web.Dockerfile`（deps → build → runner，最终镜像只带 standalone 产物和静态资源），并搞懂 `NEXT_PUBLIC_` 变量构建期内联这个坑为什么踩、怎么绕
3. 逐行读懂 Nginx 最小配置（gzip、静态资源缓存头、`/api` 反代、`try_files` 兜底），把 web 和 nginx 加进 compose，五个服务一条命令起

## 概念讲解：为什么前端要单独操心

两天下来，你的 compose 已经能一键拉起 api、postgres、redis，但浏览器里那个 web 还得另开终端 `npm run dev`。开发时无所谓，交付时问题全来了：Node 版本对不对、依赖装没装、`next build` 跑没跑，全靠人肉；更根本的是「用户怎么访问」——总不能让对方 clone 仓库自己起服务。

前端上容器，比 api 多一道选择题。api 是纯 Node 服务，装进容器跑 `node dist/main.js` 就完了。Next.js 不一样：`next build` 产出什么，取决于你怎么配置。它既可以产出「一个必须在服务端跑起来的 Node 应用」，首屏渲染、Server Actions 都在这发生；也可以产出「一堆纯粹的 HTML/JS/CSS 文件」。产物不同，容器的活法完全不同，Nginx 在其中扮演的角色也不同。

Nginx 是今天的新面孔，一句话认识它：高性能 HTTP 服务器兼反向代理。两大本事正好覆盖两种产物：当文件服务器，直接把静态文件发给浏览器，顺带做 gzip 压缩和缓存头；当反向代理，把请求原样转给后面的容器，比如 `/api` 转给 api、页面请求转给 web。让它站在全家桶门口，浏览器只跟它打交道，还有个意外收获：前后端同源，跨域问题从根上消失。

## 核心知识

### 1. 两条路线：standalone 还是静态导出

先上对照表：

| 维度 | `output: 'standalone'` | `output: 'export'` |
| ---- | ---- | ---- |
| 产物 | 一个能独立运行的 Node 服务器（`server.js` + 裁剪过的 node_modules） | 一堆 HTML / JS / CSS 文件（`out/` 目录） |
| 服务端能力 | SSR / RSC / Server Actions / API Routes / 中间件 / 流式响应，全支持 | 全没有，页面内容在构建那一刻定死 |
| 容器里跑什么 | Node 进程 | Nginx（或任意静态服务器） |
| Nginx 的角色 | 反向代理，请求转给 Node | 文件服务器，直接读磁盘 |
| 适用 | 绝大多数真实应用 | 纯展示站：官网、文档、落地页 |

判断标准一句话：构建产物里需不需要一个活着的服务器。只要有任何页面要在「请求到达那一刻」才渲染，带登录态、查数据库、流式输出，或者用了 Server Actions、中间件、API Routes，静态导出直接出局。不是效果打折，是 `next build` 当场报错，告诉你某个特性 export 不支持。

本篇动手按 standalone 走。除了能力全，还有个实际原因：standalone 是官方为部署准备的路线，`next build` 会做依赖追踪，把运行真正需要的 node_modules 挑进产物，天然贴合 Day 1 的多阶段瘦身思路。静态导出的玩法在 Nginx 一节对照着讲，那套配置以后写官网用得上。

### 2. 开启 standalone：从 next.config 到三阶段 Dockerfile

第一步永远是配置：

```ts
// next.config.ts
const nextConfig = {
  output: "standalone", // 构建产物改为「可独立运行」形态
};

export default nextConfig;
```

`next build` 之后，`.next` 里多出一个 `standalone` 目录：`server.js`、一份被裁剪的 `node_modules`、一个精简的 `package.json`。注意官方文档的提醒：`public/` 和 `.next/static/` 不在 standalone 里，要自己拷进去。所以运行一个 standalone 应用需要三样东西：

- `.next/standalone/`：服务器本体
- `.next/static/`：带内容哈希的前端 JS/CSS 分片
- `public/`：图片等公共文件

对应的三阶段 Dockerfile：

```dockerfile
# ---------- 阶段一 deps：只装依赖 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ---------- 阶段二 build：跑 next build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 阶段三 runner：只带运行必需品 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

# 三样缺一不可：服务器、静态资源、公共文件
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
```

和 Day 1 的 api.Dockerfile 有两个关键差异，值得停下看。

其一，runner 不再 `npm ci --omit=dev`。Day 1 里 NestJS 的运行依赖要你自己区分 dev 和 prod；Next 的 standalone 已经用依赖追踪把「运行需要的最小 node_modules」挑好放进产物了，直接整份拷就是最优解，多余的一个都没有。

其二，`ENV HOSTNAME=0.0.0.0`：server.js 监听的地址受这个变量控制，部分版本默认只绑回环地址，容器里一旦如此，外面（Nginx）的请求一律被拒。显式绑 0.0.0.0 才接受来自容器网络的连接。

至于 deps 和 build 为什么拆开，还是 Day 1 的缓存原则：依赖安装的输入只有清单文件，单独成一个阶段后，改源码重新构建，deps 阶段整个复用，只有 build 重跑。

### 3. 头号坑：NEXT_PUBLIC_ 变量是构建期内联的

假设 web 需要知道 api 的地址，顺手写法是这样：

```ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
fetch(`${API_BASE}/chat`);
```

本地开发没问题：`.env.local` 里写上 `NEXT_PUBLIC_API_URL=http://localhost:3000`，请求打得通。进了容器，想当然地在 compose 里改值：

```yaml
web:
  environment:
    NEXT_PUBLIC_API_URL: http://api:3000
```

容器起来，页面发出的请求还是打向 localhost:3000，纹丝不动。为什么？浏览器里没有 process.env。`NEXT_PUBLIC_` 前缀的变量，Next 在 `next build` 那一刻做「内联」：把值当字符串直接替换进打包产物。上面那行代码 build 完已经是 `fetch("http://localhost:3000/chat")`，写死的字面量。运行时往容器灌环境变量，改的是 Node 进程的 process.env，客户端 bundle 里的字面量不归它管。验证方法很直观，构建完在产物里搜：

```powershell
Get-ChildItem .next -Recurse -Filter *.js | Select-String "localhost:3000"
```

能亲眼看到被烧进去的地址。

一句话总结：没有前缀的 `process.env.XXX` 是服务端运行时变量，容器里改了立刻生效；`NEXT_PUBLIC_` 是构建期变量，想改值只能重新 build。出路两条：

1. 服务端中转：让 Server Component 或路由处理器在运行时读 `process.env.API_URL`（不带前缀，运行时生效），把值作为 props 传给客户端组件
2. 同源反代，今天的正解：客户端只写相对路径 `fetch("/api/chat")`，由 Nginx 把 `/api` 转给 api 容器。API 地址这个概念直接消失，没有变量可踩坑，还顺手消灭了跨域

### 4. Nginx 最小配置逐行

项目根目录建 `nginx/default.conf`，完整内容如下，动手任务会原样挂进容器：

```nginx
server {
    listen 80;                    # 监听容器的 80 端口
    server_name _;                # 不挑域名，任何 Host 都接

    # ---- 压缩：文本类响应体积砍 60% 以上 ----
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;         # 小于 1KB 不压，压完反而更大

    # ---- /api：转发给 api 容器，服务名即主机名（Day 2 的 DNS 规则）----
    location /api/ {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ---- 带内容哈希的构建产物：内容一变文件名就变，放心长缓存 ----
    location /_next/static/ {
        proxy_pass http://web:3000;
        expires 365d;
        add_header Cache-Control "public, immutable";
    }

    # ---- 其余请求：全部交给 Next 服务 ----
    location / {
        proxy_pass http://web:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;      # 流式响应（SSE）不攒包，agent 吐字才顺滑
    }
}
```

逐块拆开。

`server` 块的 `listen 80` 定监听端口；`server_name _` 是通配写法，单容器单站点不需要按域名分流，来者不拒。`/api/` 里那组 `proxy_set_header` 是把客户端的真实信息带给 api：`Host` 是原始域名，`X-Real-IP` 和 `X-Forwarded-For` 是来源 IP（不带头的话 api 看到的永远是 nginx 容器的 IP），`X-Forwarded-Proto` 标记原始协议。以后在 Nest 里做日志、限流，这些头就是事实来源。

`proxy_pass` 的尾斜杠是个经典暗坑：URL 不带路径部分（`http://api:3000`）时，原始 URI 原样透传，api 收到的还是 `/api/chat`；写成 `http://api:3000/`（多个斜杠）就变成「剥掉 location 匹配的前缀再拼上去」，api 收到的是 `/chat`。你的 Nest 路由带不带 `api` 前缀，决定用哪种写法。走 Nginx 就 404、直连 api 容器却正常时，先查这里。

`expires 365d` 加 `Cache-Control: public, immutable`：`/_next/static/` 下的文件名全带内容哈希，内容一变、哈希一变、URL 跟着变，同一个 URL 的内容永远不会再变。所以敢让浏览器缓存一年，`immutable` 还免掉了到期后的条件请求。反过来说，HTML 页面绝不能这么设，HTML 是「发现新版本」的入口，必须每次校验，这组头只属于带哈希的静态资源。

`proxy_buffering off`：Nginx 默认把上游响应攒够一批再发给客户端，对普通页面是优化，对逐字输出的流式接口是灾难，用户要等全部生成完才看到第一个字。关掉缓冲，来一个字节转一个字节。

最后是静态导出路线的对照。如果哪天你写的是纯静态站，把 `out/` 拷进 Nginx 镜像，`location /` 换成这样：

```nginx
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
```

`try_files` 的参数是从左到右的尝试顺序。`$uri`：把请求路径当文件找，`/logo.png` 去找 `…/html/logo.png`；`$uri/`：文件没有就当目录找，命中目录就按默认页补全；`/index.html`：都没找到，返回入口 HTML，把路径交给前端 JS 去解释。最后一段是精髓：纯客户端路由的 SPA（React Router 那类）访问 `/chat` 时，磁盘上根本没有 chat 这个文件，没有兜底就直接 404；有了兜底，返回的 index.html 里那份 JS 会读出地址栏的 `/chat`，前端路由自己渲染对应页面。「本地好好的，上了 Nginx 一刷新就 404」，标准答案就是这行。

## 动手任务：三件套扩成五件套 一步一步

手册任务：为 Next.js 写 Dockerfile，用 Nginx 服务静态资源，全部加进 compose。拆成 5 步，全程约 35 分钟。以下假设前端代码在仓库的 `web/` 目录；目录结构不同的话，把 compose 里的 context 和 dockerfile 路径换成实际位置即可。命令在 PowerShell 执行。

**第 1 步：web 项目准备，三件事。** 先在 `next.config.ts` 开 `output: "standalone"`，照核心知识第 2 节那三行抄。再在 web 目录建 `.dockerignore`，规矩照 Day 1，把 dist 换成 Next 的产物目录：

```text
node_modules
.next
.git
.env
```

然后清理客户端代码里的 API 地址：全局搜 `NEXT_PUBLIC_`，凡是拼 API 地址的，一律改成相对路径 `fetch("/api/...")`。同源方案生效的前提，是客户端不再持有任何绝对地址。

**第 2 步：写 web.Dockerfile。** web 目录下新建 `web.Dockerfile`，内容照核心知识第 2 节完整抄。三行 COPY 对应三样产物，一样都不能少：漏了 standalone，容器直接起不来；漏了 `.next/static`，首页能开但样式全丢、按钮全死；漏了 `public`，图片集体 404。

**第 3 步：写 nginx 配置。** 项目根目录建 `nginx/default.conf`，内容照核心知识第 4 节抄。配置里 `api` 和 `web` 两个主机名，就是接下来 compose 里的服务名，跟 Day 2 的 DNS 规则一字不差地对上。

**第 4 步：compose 加两个服务。** 在 Day 2 那份 docker-compose.yml 的 services 里追加：

```yaml
  web:
    build:
      context: ./web
      dockerfile: web.Dockerfile
    expose:
      - "3000"          # 只在容器网络里可见，不映射到宿主机
    restart: unless-stopped

  nginx:
    image: nginx:1.27-alpine
    ports:
      - "8080:80"       # 全家桶对外的唯一入口
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - web
      - api
    restart: unless-stopped
```

`expose` 和 `ports` 的区别是今天版图的最后一块拼图：`ports` 把端口发布到宿主机，`expose` 只在容器网络里声明可见。web 没理由让浏览器直连，入口已经交给 Nginx，所以只 expose。顺手把 api 的 `3000:3000` 映射也拿掉，调试要用再加回来，最小暴露面永远是安全加分项。volumes 那行把配置文件只读挂载（`:ro`）进容器，Nginx 镜像的约定是加载 `/etc/nginx/conf.d/*.conf`，以后改配置只需 `docker compose restart nginx`，不用重新构建。nginx 的 `depends_on` 用裸形式就够：web 起晚几秒无非短暂 502，随后自愈，犯不着配 healthcheck。

**第 5 步：起全家，验证四件事。**

```powershell
docker compose up -d --build
docker compose ps
```

ps 里五个服务全是 Up（postgres、redis 应为 healthy）。然后按清单验：

1. `Invoke-WebRequest -UseBasicParsing http://localhost:8080`：状态 200，响应体是页面 HTML，说明 nginx → web 这条链通了
2. 地址换成 api 的某个真实路由再请求一次：响应来自 api 容器，说明 nginx → api 链也通了
3. 用 `curl.exe -H "Accept-Encoding: gzip" -I http://localhost:8080` 看响应头（注意敲 `curl.exe`，PowerShell 里裸的 `curl` 是 Invoke-WebRequest 的别名）：大文件响应应带 `Content-Encoding: gzip`；再随便挑一个 `/_next/static/` 下的文件看头，`Cache-Control` 里应有 `max-age=31536000, immutable`
4. 浏览器打开 `http://localhost:8080` 走一遍真实功能，F12 的 Network 面板确认页面所有请求都打向 8080 同源，没有一个指向 3000

四条全过，`docker compose down` 收摊，数据卷照旧保留（Day 2 讲过 down 不删卷）。

::: tip 502 了怎么排查
502 Bad Gateway 意思是 Nginx 活着，但转发目标没接住。按顺序查：`docker compose ps` 看 web 是否 Up；`docker compose logs nginx` 看它想转给谁；再从 nginx 容器内部直接敲 web 的门：`docker compose exec nginx wget -qO- http://web:3000`。能通就是配置问题（多半在 location 或尾斜杠），不能通就是 web 的问题（多半是 HOSTNAME 没绑 0.0.0.0，或容器在重启循环）。
:::

## 常见踩坑

**坑 1：给容器传 `NEXT_PUBLIC_` 变量，改了不生效。** 症状：页面请求还打向构建时的旧地址。原因：`NEXT_PUBLIC_` 在 `next build` 时被内联成字符串字面量烧进产物，运行时环境变量只影响 Node 进程，动不了客户端 bundle。出路有两条：服务端读不带前缀的 `process.env` 再传给客户端；或者干脆同源相对路径加 Nginx 反代，让这个变量从根上消失。回看核心知识第 3 节。

**坑 2：runner 三样拷漏。** 最常见的是漏 `.next/static`：页面能打开，样式全无、交互全死，Network 面板里一堆 JS 404。官方文档明说 `public` 和 `.next/static` 不在 standalone 里，要手动拷。记忆点：standalone 目录只是服务器本体，浏览器要加载的资源一样都不在里面。

**坑 3：proxy_pass 尾斜杠一念之差。** `http://api:3000` 原样透传 `/api/chat`，`http://api:3000/` 剥掉前缀只传 `/chat`。两个写法都没错，错的是跟 Nest 路由的实际前缀不匹配。症状很有辨识度：直连 api 容器一切正常，走 Nginx 就 404。

**坑 4：把 HTML 和带哈希的资源一锅炖进长缓存。** 有人图省事在 `location /` 也加上 `expires 365d`：第二天发了新版，用户看到的还是昨天那页，因为 HTML 被浏览器缓存死了。规则一句话：入口文档每次校验，带内容哈希的资源才配永久缓存。反过来全不设缓存，每次访问都全量拉 JS，Nginx 这层等于白站。

**坑 5：静态导出路线删掉 try_files 的兜底段。** `try_files $uri $uri/` 之后没有 `/index.html`，磁盘上不存在的路径直接 404，前端路由的子页面一刷新就死。Next 的静态导出会给每个路由生成对应 HTML，问题不明显；换成纯客户端路由的 SPA，这行就是生死线。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 项目满足什么条件就必须选 standalone，不能静态导出？

::: details 参考答案
产物需要「活着的服务器」的任一场景：请求时才渲染的页面（登录态、实时数据、流式输出）、Server Actions、API Routes、中间件。判据很简单：把 output 改成 export 跑一次 build，Next 会对不支持的特性直接报错。纯展示站（官网、文档、落地页）构建时全静态，才适合导出。
:::

2. runner 阶段为什么不用 `npm ci --omit=dev`，直接拷 standalone 产物就行？

::: details 参考答案
standalone 目录里的 node_modules 是 Next 依赖追踪挑出的「运行必需最小集」，比手动装生产依赖更准也更小，整份拷过来就是最优解。Day 1 的 NestJS 没有这待遇，所以那边要自己 `--omit=dev` 重装。
:::

3. compose 里给 web 配 `NEXT_PUBLIC_API_URL` 为什么不生效？正确做法有哪些？

::: details 参考答案
NEXT_PUBLIC_ 变量在 build 时被内联成字面量写进客户端 bundle，运行时环境变量改的是 Node 进程，管不到浏览器里跑的代码。正确做法：一，服务端读不带前缀的 process.env（运行时生效），通过 props 或配置接口传给客户端；二，同源方案，客户端只写相对路径 /api/...，由 Nginx 反代到 api 容器，变量直接不需要存在。
:::

4. `try_files $uri $uri/ /index.html` 三段各是什么意思？去掉最后一段会怎样？

::: details 参考答案
从左到右依次尝试：把请求路径当文件找；当目录找并按默认页补全；都失败就返回入口 index.html，交给前端路由解释地址栏路径。去掉兜底段后，磁盘上不存在的路径直接 404，表现为子页面刷新或直接输入 URL 打不开。
:::

5. `/_next/static/` 为什么敢设 `expires 365d` 加 immutable？HTML 为什么不能这么设？

::: details 参考答案
该目录下的文件名带内容哈希，内容一变文件名就变，同一 URL 的内容永不改变，缓存再久也不会拿到旧资源，immutable 还省掉条件请求。HTML 引用的是哪个哈希版本的 JS，每次部署后才更新，HTML 必须每次校验，否则用户会被锁死在旧版本里。
:::

## 延伸阅读

- [Next.js with-docker 官方示例](https://github.com/vercel/next.js/tree/canary/examples/with-docker)，今天这份三阶段 Dockerfile 的出处，另有多阶段与静态导出两个变体可对照
- [Next.js Self-hosting 指南](https://nextjs.org/docs/app/guides/self-hosting)，standalone 产物结构、public 与 static 为什么要手动拷、镜像优化的官方口径
- [Nginx try_files 指令文档](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files)，兜底语法的权威定义，同页能跳到 proxy_pass、expires 相关模块

今天的 `web.Dockerfile` 和 `nginx/default.conf` 留好。明天 Day 4 开始写 GitHub Actions，先让 lint 和 test 在每次 push 时自动跑起来，Day 5 再把 api 和 web 两份镜像的构建、推送全交给流水线，今天写的东西到那时一行都不用改。
