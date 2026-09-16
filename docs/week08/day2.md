# 第 8 周 · Day 2：Nginx 反向代理 + HTTPS——给容器一个正式的门牌

> 对应手册任务：学习「Nginx 反向代理 + HTTPS」，动手「配置 Nginx 代理 api 和 web，用 Certbot 申请 Let's Encrypt 证书」，当日产出「HTTPS 可访问」。本篇只解决一个问题：应用已经跑在服务器的容器里，访问地址却是一串 IP 加端口，今天给它配上域名和证书，让用户从 https://your.domain 的正门进来，而不是从消防通道爬进去。

## 今日目标

1. 说得清反向代理解决什么问题，以及为什么不把容器端口直接暴露到公网
2. 看懂 Nginx 配置的四个组成部分：upstream、server 443 ssl、location 分发、proxy_set_header 三件套
3. 独立完成 DNS 解析、Nginx 代理 api 和 web、Certbot 申请证书并验证自动续期，最终浏览器地址栏出现锁

## 概念讲解：为什么需要反向代理

昨天的产出是一台装好 Docker 的云服务器，应用用 Compose 拉起来后，访问方式是 `http://服务器IP:3000`。能用，但拿不出手，问题有三个。

第一，IP 是一串数字，用户记不住，也不该记。哪天换了服务器，写在文档和名片上的地址全部作废。

第二，HTTP 是明文。用户输入的密码、携带的 token 在路上裸奔，浏览器在地址栏标一个「不安全」，微信小程序的接口、第三方 OAuth 回调更是直接拒绝 http 地址。

第三，最容易被忽略：容器端口直接暴露，等于每加一个服务就往墙上多凿一个洞。api 一个洞、web 一个洞，下周加上 Grafana 又一个洞，每个洞都是独立的攻击面，防火墙规则越写越乱，而且每个容器都得自己操心 TLS。

三个问题各有各的解法：域名解决「记不住」，DNS 的 A 记录把 `your.domain` 指到服务器 IP；证书解决「明文」，Let's Encrypt 免费发放；反向代理解决「满墙的洞」，全服务器只留 Nginx 一个入口监听 443，所有流量从这里进来，再转给内网容器。

画出来是一条单行道：

```
用户 --https--> Nginx(443) ---http---> 127.0.0.1:3000  api 容器
                                 └----> 127.0.0.1:8080  web 容器
```

用户眼里只有 `https://your.domain`，他不知道也不需要知道背后有几个容器。这就像写字楼的前台：访客只跟前台说话，前台再把人领到具体工位。工位可以搬，公司门牌不变；容器可以重启，域名不变。Nginx 就是这个前台，术语叫反向代理。「反向」是相对你平时翻墙用的那种代理说的：那种代理替用户隐藏身份，反向代理替一群服务器收口。

为什么不让容器自己扛 TLS 直接对外？能做，但没必要。证书要塞进每个镜像，90 天一换，换一次全部重启一遍；容器在 Compose 网络里的 IP 重启就变，域名没法直接指向某个容器。让 Nginx 独占 443，后端容器只听内网，各干各的，这是行业标准做法。

## 核心知识

先说路线。Nginx 有两种装法：塞进 Compose 全容器化，或者在宿主机上 `apt install nginx`。全容器化看着整齐，但证书的申请和续期要跟容器卷纠缠（坑 5 专门讲）。本篇主线选宿主机直装，理由就一个：certbot 官方对这种组合支持最好，一条命令把证书和自动续期全办好。

### 1. 先把容器端口收回内网

宿主机方案下，容器不再对公网开端口，只在宿主机本地回环上留个口子给 Nginx，改 Compose 文件：

```yaml
services:
  api:
    image: your-api:latest
    ports:
      - "127.0.0.1:3000:3000"   # 只绑本地回环，公网摸不到

  web:
    image: your-web:latest
    ports:
      - "127.0.0.1:8080:80"
```

关键在 `127.0.0.1:3000:3000` 这个写法。冒号左边不写 IP 时默认绑 `0.0.0.0`，全网可访问；写明 `127.0.0.1` 后，这个端口只有宿主机本机能连。Nginx 转发不受影响，外网直接扫 `IP:3000` 一无所获。今天配的 HTTPS 是唯一正门，别留着消防通道。

### 2. upstream、server、location：配置的骨架

在 `/etc/nginx/sites-available/` 下新建 `your.domain`，先写 HTTP 版，证书一会儿让 certbot 自己加：

```nginx
upstream api {
    server 127.0.0.1:3000;
}

upstream web {
    server 127.0.0.1:8080;
}

server {
    listen 80;
    server_name your.domain;

    location /api/ {
        proxy_pass http://api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://web;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

从上往下四个块。

`upstream` 给后端起内部名字。`upstream api` 的意思是「api 这个名字，指 127.0.0.1:3000」。好处是解耦：哪天 api 从 3000 换到 3001，或者一个变两个做负载均衡（upstream 里多写一行 server 就行），只改这一处，下面的 location 一动不动。注意必须写 `127.0.0.1:3000` 而不是容器名 `api:3000`，宿主机上的 Nginx 不认识 Compose 网络里的服务名，那是容器之间才有的黑话。

`server` 是一个虚拟主机，`listen 80` 监听端口，`server_name` 匹配域名。一台 Nginx 能挂多个 server 块，不同域名走不同规则，今天只用一个。

`location` 按请求路径分发：URL 以 `/api/` 开头交给 api，其余全部交给 web。Nginx 取最长前缀匹配，`/api/login` 命中 `location /api/`，`/` 是兜底。一个细节值得记：`proxy_pass http://api;` 结尾不带路径，原始路径原样转发，后端收到的还是 `/api/login`；写成 `proxy_pass http://api/;`（多个斜杠）会把 `/api/` 前缀剥掉再转，后端收到 `/login`。你的 NestJS 若设了全局前缀 `api`，用前者；后端路由本身没前缀，用后者。分不清就 curl 一下后端，看它想吃什么路径。

### 3. proxy_set_header 三件套

Nginx 转发请求时，默认不会把用户的原始信息带给后端，后端看到的连接来自 Nginx。这三个 header 就是把丢掉的信息补回去：

- `Host $host`：用户访问的域名。后端不少逻辑依赖它，生成跳转链接、校验 API 签名、区分虚拟主机。不传，后端看到的是 `api` 这个 upstream 名，拼出来的 URL 全是歪的。
- `X-Forwarded-For $proxy_add_x_forwarded_for`：用户的真实 IP。不传，后端日志里所有请求都来自 `127.0.0.1`，限流、封禁、风控全部失灵。`$proxy_add_x_forwarded_for` 是把用户 IP 追加到已有链上而非覆盖，多级代理时能还原完整路径。
- `X-Forwarded-Proto $scheme`：用户最初用的是 http 还是 https。不传，后端默认以为是 http，生成的 OAuth 回调地址就成了 `http://your.domain/...`，浏览器按混合内容直接拦截，这是接第三方登录时最经典的翻车现场。

一句话记法：Host 管「我是谁」，X-Forwarded-For 管「用户是谁」，X-Forwarded-Proto 管「刚才走的是哪条路」。三行照抄，别省。

### 4. HTTP 跳 HTTPS 与证书续期

证书配好后有两件收尾的事。第一，把走 80 端口的明文请求永久重定向到 https，防止用户手滑：

```nginx
server {
    listen 80;
    server_name your.domain;
    return 301 https://$host$request_uri;
}
```

`301` 是永久重定向，浏览器会记住，下次直接走 https。这一块 certbot 也能自动帮你加。

第二，续期。Let's Encrypt 的证书只有 90 天有效期。别慌，apt 装的 certbot 自带 systemd 定时器 certbot.timer，每天自动检查两次，进入到期前 30 天窗口就自动续。你要做的只是验证它真的在跑，第 6 步给命令。

## 动手任务：HTTPS 跑通，一步一步

手册任务：配置 Nginx 代理 api 和 web，用 Certbot 申请 Let's Encrypt 证书。拆成 6 步，全程约 40 分钟。把文中 `your.domain` 换成你自己的域名。

**第 1 步：DNS 解析指向服务器。** 到域名服务商（阿里云、腾讯云、Cloudflare、Namecheap 都行）的解析控制台加一条 A 记录：主机记录填 `@`（主域名）或想要的子域名如 `www`，记录值填服务器公网 IP。然后到服务器上验证生效：

```bash
dig +short your.domain
# 输出你的服务器 IP 就对了，没输出就等几分钟再试
```

两件事提前确认：安全组放行 80 和 443（昨天 Day 1 的操作，80 别漏，申请证书要用）；域名解析到国内云服务器必须先完成 ICP 备案，否则 Web 流量会被拦，备案在云厂商后台走流程，通常要几个工作日，图省事选香港或海外节点，免备案。

**第 2 步：容器端口收回内网。** 按核心知识第 1 节改 Compose 的 ports，重新拉起：

```bash
docker compose up -d
curl http://127.0.0.1:3000/api/health   # 在服务器本机验证容器还活着
```

**第 3 步：装 Nginx，先跑通 HTTP。** 证书往后放，先让代理本身工作：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo nano /etc/nginx/sites-available/your.domain
```

把核心知识第 2 节的配置贴进去（此刻全是 80 端口），启用站点并检查语法：

```bash
sudo ln -s /etc/nginx/sites-available/your.domain /etc/nginx/sites-enabled/
sudo nginx -t          # syntax is ok / test is successful 才继续
sudo systemctl reload nginx
```

用手机开流量（绕开本地缓存）访问 `http://your.domain`，页面能打开、`/api/` 路径有数据返回，代理就通了。

**第 4 步：certbot 一条命令上证书。** DNS 和 80 端口都确认没问题后：

```bash
sudo certbot --nginx -d your.domain
```

它会问你邮箱（到期提醒用）和是否同意条款，然后自动做三件事：向 Let's Encrypt 申请证书，文件落在 `/etc/letsencrypt/live/your.domain/`；把你的 server 块改写成 `listen 443 ssl` 并挂上证书路径；追加重定向，80 端口的流量全部 301 到 https。打开配置文件看一眼，certbot 改过的内容都带注释，和核心知识第 4 节对得上。

背后原理顺带说一句：Let's Encrypt 要验证你真的控制这个域名，方式是访问 `http://your.domain/.well-known/acme-challenge/` 下的一串随机字符，certbot 的 nginx 插件临时加一条 location 应付验证，通过后删掉。这就是为什么 DNS 必须先生效、80 端口必须先放行。

**第 5 步：验证 HTTPS 和重定向。**

```bash
curl -I http://your.domain
# 期望：301 Moved Permanently，Location 是 https 地址
curl -I https://your.domain
# 期望：200，证书信息正常
```

再用浏览器打开 `https://your.domain`，地址栏出现锁，点开能看到 Let's Encrypt 签发的证书和有效期。到这里，当日产出达成。

**第 6 步：验证自动续期。** 证书 90 天一换，确认定时器在岗：

```bash
systemctl list-timers | grep certbot   # 能看到 certbot.timer 的下次触发时间
sudo certbot renew --dry-run           # 演练一次续期，不真申请，不占配额
```

两个命令都正常，续期就不用再管了。真到续期那天，certbot 续完会自动 reload Nginx，不中断服务。

::: tip 卡住了怎么排查
分段定位：先 `curl http://127.0.0.1:3000` 验容器，再在本机 `curl -H "Host: your.domain" http://127.0.0.1` 验 Nginx 代理，最后用域名验 DNS 和证书。三段哪段断，问题就在哪段，别一上来就怀疑证书。
:::

## 常见踩坑

**坑 1：upstream 里写了容器名。** `server api:3000` 这种写法只在 Nginx 也装进容器、跟应用同一个 Compose 网络时才成立。本篇的宿主机 Nginx 解析不了 Compose 内部 DNS，reload 时直接报 `host not found in upstream`。宿主机路线就老老实实写 `127.0.0.1:3000`。

**坑 2：ports 写成 `3000:3000`。** 少了 `127.0.0.1:` 前缀就是绑 `0.0.0.0`，任何人都能绕过 HTTPS 直接 `http://IP:3000` 访问明文接口，证书成了摆设。改完 Compose 记得 `docker compose up -d` 重建容器，光 reload Nginx 没用。

**坑 3：三件套抄漏了。** 症状都很有迷惑性：漏 `Host`，后端生成的链接和签名校验莫名出错；漏 `X-Forwarded-For`，日志里 IP 全是 127.0.0.1，想封个恶意 IP 时发现没数据；漏 `X-Forwarded-Proto`，别的都好，就 OAuth 回调报错，控制台一条 mixed content。这三个 header 不会让 Nginx 报错，只会出诡异 bug。遇到「加了代理之后行为不对」，先检查这三行。

**坑 4：DNS 没生效就跑 certbot。** 报错 `Failed authorization procedure`，八成是域名还没解析过来，或者安全组没放行 80。先 `dig +short your.domain` 确认 IP，再查安全组。另外 Let's Encrypt 有频率限制，同一域名一周内重复申请次数有限，调试期想反复申请，加 `--staging` 参数用测试环境，证书不受信但流程一模一样，跑通了再来真的。

**坑 5：想全容器化，certbot 的卷是第一道坎。** Nginx 放进 Compose 后，证书目录 `/etc/letsencrypt` 得在 certbot 容器和 nginx 容器之间共享卷，webroot 验证目录同样要共享，续期完还得想办法让 nginx 容器 reload。三件事在宿主机上都是免费的，进了容器全要手工搭。等链路跑熟了想迁移，记住原则：证书只存宿主机 `/etc/letsencrypt`，只读挂给 nginx 容器，续期交给宿主机的 certbot.timer，别在容器里另起一套。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 反向代理和「容器端口直接暴露」相比，解决了哪些问题？

::: details 参考答案
三个：唯一入口，全服务器只开 443，攻击面和防火墙规则收敛到一处；统一 TLS，证书只在 Nginx 一处安装和续期，后端容器不用管；解耦，容器重启、换端口、扩容只改 upstream 一处，对外域名始终不变。
:::

2. proxy_set_header 三件套各自补回什么信息？漏掉的典型症状是什么？

::: details 参考答案
Host 补「访问的域名」，漏了后端拼 URL 和签名校验出错；X-Forwarded-For 补「用户真实 IP」，漏了日志全是 127.0.0.1、限流风控失灵；X-Forwarded-Proto 补「原始协议」，漏了后端生成 http 回调地址，OAuth 回调和 mixed content 报错。
:::

3. `proxy_pass http://api;` 和 `proxy_pass http://api/;` 差在哪？

::: details 参考答案
多的那个斜杠是「替换前缀」的意思。不带斜杠，原始路径原样转发，`/api/login` 到后端还是 `/api/login`；带斜杠，location 匹配到的 `/api/` 被剥掉，后端收到 `/login`。选哪个取决于后端路由有没有 api 前缀。
:::

4. `certbot --nginx -d your.domain` 一条命令做了几件事？证书放在哪，靠什么续期？

::: details 参考答案
四件：向 Let's Encrypt 申请证书（HTTP-01 验证，临时加 location 应付 `.well-known/acme-challenge` 的抽查）；证书写入 `/etc/letsencrypt/live/your.domain/`；把 server 块改写为 443 ssl 并挂上证书；追加 80 到 443 的 301 重定向。续期靠 systemd 的 certbot.timer 每天检查，进入到期前 30 天自动续，用 `certbot renew --dry-run` 可以演练。
:::

5. 为什么 Compose 里写 `127.0.0.1:3000:3000`，公网访问不到，Nginx 却能转发？

::: details 参考答案
`127.0.0.1:` 前缀让端口只绑宿主机的本地回环，公网摸不到；但 Nginx 就跑在宿主机上，对它来说 127.0.0.1 是自己家，随便连。「外网进不来、本机随便连」正是想要的效果。
:::

## 延伸阅读

- [Nginx 官方文档：http proxy 模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)，proxy_pass 和 proxy_set_header 的权威说明，斜杠语义写得很细
- [Certbot 官方站点](https://certbot.eff.org/)，按系统和 Web 服务器给出安装指令，EFF 维护
- [Let's Encrypt 文档](https://letsencrypt.org/docs/)，频率限制和 staging 测试环境的说明值得读
- [MDN：X-Forwarded-For](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Headers/X-Forwarded-For)，三个 X- 开头请求头的标准定义

今天产出的 `/etc/nginx/sites-available/your.domain` 和 `/etc/letsencrypt/` 证书目录留好，明天 Day 3 的自动部署往服务器上更新容器时，这个入口一个字都不用改。卡壳的回[本周日程](/week08/)对照 Day 1 的服务器环境自查一遍。
