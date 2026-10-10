# 第 8 周 · Day 1：云服务器基础——让容器有一台 7×24 在线的机器

> 对应手册任务：学习「云服务器基础：SSH、防火墙、安全组」，动手「在云服务器上安装 Docker + Docker Compose」，当日产出「可用的云环境」。本篇只解决一个问题：第 7 周镜像已经推进了仓库，但镜像躺在仓库里不会自己跑起来。买一台云服务器，用密钥登录、关掉多余的端口、装上 Docker，让这台机器配得上接收你的第一个线上容器。

## 今日目标

1. 知道买什么：轻量应用服务器 2C2G 起步、系统选 Ubuntu 22.04/24.04、地域怎么挑
2. 掌握 SSH 三件事：密钥对登录 `ssh -i`、禁用密码登录、一份基础加固清单
3. 分得清安全组和 ufw 防火墙各管哪一层，只放行 22/80/443，并在服务器上装好 Docker + Compose 插件，跑通 hello-world

## 概念讲解：为什么需要一台云服务器

先盘一下现状：应用已经容器化，CI 会自动构建镜像并推进仓库。但镜像和跑起来的服务之间，还差一台机器。你可能会想，本地不就有机器吗？问题是本地机器当不了部署目标：家庭宽带没有固定公网 IP，路由器一重拨地址就变；笔记本要合盖、要重启、要带出门；你也不会为了一个学习项目让家里风扇 24 小时转。

云服务器卖的就是三样东西：一台放在机房里的 Linux 电脑、一个固定的公网 IP、不间断的供电和网络。对个人项目，「轻量应用服务器」是性价比最高的形态。阿里云和腾讯云都有这条产品线，和标准云主机（ECS/CVM）相比，它把带宽折成流量包按月打包卖，个人用比「标准主机 + 按流量带宽」便宜不少，控制台也做了简化；代价是扩容上限低、规格选择少。跑个人项目、博客、小工具，2C2G 起步完全够用，两三个容器加一个 Nginx 没压力。

下单时有三个选择题，比选哪家厂商更重要。

第一，地域。延迟基本等于物理距离：用户在杭州，选上海地域延迟是个位数毫秒；选新加坡，七八十毫秒起步；选硅谷，150ms 往上。原则很简单，用户在哪就买哪。但国内有个特有变量：大陆地域的服务器绑定域名对外提供 Web 服务要走 ICP 备案，纯 IP 访问不受影响；不想备案可以选香港地域，免备案，延迟略高，流量包也稍贵。本系列用 IP + 端口访问，两种地域都行。

第二，系统镜像。选 Ubuntu 22.04 LTS 或 24.04 LTS。选它不是因为它最好，而是因为它文档最多：你遇到的每个问题，大概率有人用同样的系统踩过并写了下来。LTS 意味着五年安全更新，不用一年一重装。本篇所有远程命令默认 Ubuntu + apt。

第三，登录方式。创建实例时选密钥对而不是密码，这直接引出今天的重头戏。

## 核心知识

### 1. SSH 三件事：密钥对、禁密码、加固清单

SSH 是你和服务器之间唯一的门。密码登录的问题很直接：密码可以被猜。公网上一台服务器开机不到一天，`/var/log/auth.log` 里就会堆满爆破尝试，这不是吓唬人，是每台公网机器的日常。

密钥对登录把「证明你是你」从「你知道什么」（密码）换成「你拥有什么」（私钥文件）。原理是非对称加密：创建实例时生成的密钥对，公钥被写进服务器的 `~/.ssh/authorized_keys`，私钥文件（`.pem`）下载到你本地。登录时服务器用公钥出一道只有私钥能解的题，全程不传输任何密码，几千位的密钥空间让爆破在数学上不可行。

Windows 10 之后的系统自带 OpenSSH 客户端，PowerShell 里直接用：

```powershell
# 本地 Windows PowerShell：用私钥登录服务器
ssh -i C:\Users\你\.ssh\myserver.pem root@服务器公网IP
```

第一次连接会问 fingerprint，输 yes。看到提示符变成 `root@主机名`，你已经在服务器上了。

密钥能登录之后，第二件事是禁用密码登录，改的是远程的 `/etc/ssh/sshd_config`，两个指令要分清：

- `PasswordAuthentication no`：整台服务器不再接受任何密码认证，只认密钥
- `PermitRootLogin no`：root 连 SSH 都不让进，日常用普通用户，root 留给控制台 VNC 救援用

改完 `sudo systemctl restart ssh` 生效。注意这两步的前提：你已经能用密钥登录，而且建好了普通用户。顺序反了会发生什么，踩坑一节有剧本。

第三件事是一份基础加固清单，四条按优先级排：

1. 建 non-root 用户日常工作，sudo 提权，root 只留紧急通道
2. 只允许密钥登录，密码认证彻底关死
3. 装 fail2ban，把持续爆破的 IP 自动关进小黑屋
4. `sudo apt update && sudo apt upgrade` 定期跑，SSH 相关的安全更新第一时间打

### 2. 安全组 vs ufw：机房大门和房间门

新手最容易懵的一件事：系统里装了 ufw，控制台里还有个防火墙，到底听谁的？答案是它俩是两层各自独立的过滤，谁也不管谁：

- 安全组：云厂商在网络层实现的规则，不放行的数据包根本到不了你的服务器网卡。轻量应用服务器的控制台里这块就叫「防火墙」，本质是安全组（在 ECS/CVM 产品里才叫这个名字）
- ufw：Ubuntu 自带的系统防火墙，数据已经到达服务器，由内核决定放不放行

打个比方：安全组是小区门禁，ufw 是你家房门。两层都配的好处是双保险，任何一层手滑配错，另一层还兜得住。安全组在网页控制台点，ufw 在命令行敲：

```bash
# 远程 Ubuntu：启用 ufw 并只放行三个端口
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable          # 会警告可能断开 SSH，22 已放行，输 y
sudo ufw status verbose
```

安全组那层做同样的事：只留 22、80、443。还有一条铁律：3306（MySQL）、6379（Redis）这类数据库端口永远不对公网放行。数据库只应该在 Docker 内部网络里被应用容器访问，对公网开门等于把钥匙插在锁上。

### 3. 登录服务器的正确姿势：config 别名

`ssh -i C:\Users\你\.ssh\myserver.pem deploy@1.2.3.4` 每次敲一遍没法忍。在本地建一个 `C:\Users\你\.ssh\config` 文件（无扩展名）：

```
Host myserver
  HostName 1.2.3.4
  User deploy
  Port 22
  IdentityFile ~/.ssh/myserver.pem
```

之后 ssh、scp、rsync、VS Code Remote 都认这个别名：

```powershell
# 本地 Windows PowerShell
ssh myserver
```

四个字段：Host 是你起的别名，HostName 是公网 IP，User 是登录用户，IdentityFile 指向私钥。一次配置，处处生效，这周剩下的每一天你都会感谢这个文件。

### 4. 装 Docker + Compose 插件

服务器装 Docker 比本地省事，官方提供一键脚本，国内加 `--mirror Aliyun` 走阿里云的源：

```bash
# 远程 Ubuntu
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh --mirror Aliyun
```

脚本会装上 docker-ce、CLI、containerd，外加两个插件：buildx 和 compose。也就是说 Docker Compose 不用单独装，它是插件形式随脚本一起来的，验证：

```bash
docker --version
docker compose version
```

最后一步收尾，把日常用户加进 docker 组，之后敲 docker 不用带 sudo：

```bash
sudo usermod -aG docker deploy
# 退出重新登录后生效
```

## 动手任务：从下单到 hello-world

拆成 6 步，全程约 40 分钟。约定：标「本地」的命令在 Windows PowerShell 里敲，标「远程」的在 SSH 会话里敲，别敲错地方。

**第 1 步：买服务器。** 控制台操作：选轻量应用服务器，地域按你的用户选（大陆要备案、香港免备案，取舍见概念讲解），镜像选 Ubuntu 22.04，规格 2C2G 流量套餐。登录方式一定选「密钥对」，创建新的密钥对，浏览器会下载一个 `.pem` 文件，把它移到 `C:\Users\你\.ssh\` 并改名为 `myserver.pem`。这个文件就是你的私钥：丢了只能重置服务器，泄露等于服务器送人。开机完成后记下公网 IP。

**第 2 步：首次登录并建日常用户。**

```powershell
# 本地
ssh -i C:\Users\你\.ssh\myserver.pem root@公网IP
```

如果报 "UNPROTECTED PRIVATE KEY"，是 Windows 认为私钥文件权限太开放，先按踩坑 1 修 ACL。登进去后建 deploy 用户、给 sudo 权限，把密钥也搬过去：

```bash
# 远程（root）
adduser deploy                # 设个密码，其他信息一路回车
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

**第 3 步：验证 deploy 密钥登录。** 这一步不能跳。开一个新 PowerShell 窗口：

```powershell
# 本地
ssh -i C:\Users\你\.ssh\myserver.pem deploy@公网IP
```

能进去，说明 deploy + 密钥这条路通了，下一步禁密码才有底气。

**第 4 步：禁密码、锁 root、装 fail2ban。** 回到服务器（deploy 身份，命令带 sudo）：

```bash
# 远程（deploy）
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sshd -T | grep -iE 'passwordauth|permitroot'   # 两行都应输出 no
sudo systemctl restart ssh
sudo apt update && sudo apt install -y fail2ban
sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

`sshd -T` 输出的才是真实生效的配置。如果它仍显示 yes，多半是 `/etc/ssh/sshd_config.d/` 目录里有 cloud-init 放的覆盖文件，进去把 `PasswordAuthentication yes` 那行同样改掉。铁律：改完 SSH 配置，旧会话别关，新窗口验证能登录，再关旧的。

**第 5 步：两层防火墙各配各的。** 云控制台：轻量服务器的「防火墙」页，放行 22、80、443（22 一般默认有）。服务器里：

```bash
# 远程（deploy）
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

80 和 443 现在放行了但没人监听，属于正常，明天部署服务后这两个端口才有内容可访问。

**第 6 步：装 Docker 并跑通验证。**

```bash
# 远程（deploy）
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh --mirror Aliyun
sudo usermod -aG docker deploy
exit
```

用第 3 步的命令重新登录，然后：

```bash
# 远程（重新登录后的 deploy）
docker run hello-world
```

看到 "Hello from Docker!"，当日产出达成：一台能用密钥登录、只开三个端口、装好 Docker + Compose 的服务器，这就是「可用的云环境」。

::: tip 顺手把 config 别名配了
回到本地，按核心知识第 3 节建好 `~/.ssh/config`，之后 `ssh myserver` 一条命令上服务器。今天多做这一步，明天部署时能少打很多字。
:::

## 常见踩坑

**坑 1：Windows 报私钥权限太开放。** OpenSSH 要求私钥只有本人可读，Windows 文件的继承权限往往不满足，报 "WARNING: UNPROTECTED PRIVATE KEY FILE"。两条命令修好：

```powershell
# 本地
icacls C:\Users\你\.ssh\myserver.pem /inheritance:r
icacls C:\Users\你\.ssh\myserver.pem /grant:r "$($env:USERNAME):R"
```

第一条去掉继承来的权限，第二条只给当前用户读权限，改完重新 ssh 即可。这个问题只会在 Windows 上遇到，Linux 和 macOS 的 `.ssh` 目录权限天然干净。

**坑 2：把自己锁在门外。** 经典剧本：只有 root 能登录，先把 `PermitRootLogin` 改成 no，root 进不去，deploy 又没建，服务器当场变砖。两个保命习惯：改 SSH 配置前，先用新用户 + 密钥验证过一次登录；改完后旧会话保持连着，新窗口确认能登录再关。真锁死了也别慌，云控制台都提供网页版 VNC 终端，能从「机房里面」登进去救。

**坑 3：ufw enable 把自己踢下线。** 没放行 22 就 `enable`，ufw 默认拒绝所有入站，SSH 当场断。好在这只影响系统这一层，安全组还在，VNC 进去补一句 `sudo ufw allow 22/tcp` 就能回来。记住顺序：先 allow 22，再 enable。

**坑 4：docker 命令提示 permission denied。** 人已经加进 docker 组却还要 sudo，原因是加组之后没重新登录，组身份还没生效。退出 SSH 重登即可，急用可以 `newgrp docker` 临时切一次组。有人图省事一直用 `sudo docker`，也能跑，但后面写 Compose 部署脚本时到处是 sudo，很难看，一步到位改掉。

**坑 5：国内服务器拉镜像超时。** 连 hello-world 都拉不动时，不是 Docker 坏了，是到 Docker Hub 的网络不通。给 Docker 配镜像加速：编辑 `/etc/docker/daemon.json`，把 `registry-mirrors` 指向可用的加速地址（阿里云控制台的容器镜像服务里有为你生成的专属地址），保存后 `sudo systemctl restart docker`。机器在国内，这个问题后面还会碰到，先把姿势记住。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 安全组和 ufw 各工作在哪一层？只配其中一层行不行？

::: details 参考答案
安全组在云厂商的网络层，不放行的包到不了服务器网卡；ufw 在服务器内核层，包已到达后由系统决定放行。只配一层也能工作，但两层是双保险：任何一层配错（比如安全组手滑开了 3306），另一层还能兜底。代价是排障时要多想一层，「端口不通」可能卡在任意一层。
:::

2. 禁用密码登录之前必须先确认什么？顺序反了会怎样？

::: details 参考答案
必须先用「新用户 + 密钥」成功登录过一次。顺序反了，比如先禁密码、锁 root，而密钥这条路没验证过，一旦不通就没有任何远程入口，只能靠控制台 VNC 救援。铁律：改 SSH 配置时旧会话不关，新窗口验证通过再动下一步。
:::

3. 为什么 3306、6379 不该出现在安全组放行列表里？

::: details 参考答案
数据库只应被应用容器在 Docker 内部网络里访问，不需要也不应该暴露公网。对公网开数据库端口，等于把爆破面从 SSH 扩大到整个数据库，Redis 未授权访问更是常年被扫描的头号目标。运维要查数据，先 SSH 登上服务器再连，不开门。
:::

4. `ssh myserver` 直接能连上，靠的是哪个文件？四个关键字段各是什么？

::: details 参考答案
本地 `~/.ssh/config`，Windows 上是 `C:\Users\你\.ssh\config`。Host 是自定义别名，HostName 是公网 IP，User 是登录用户，IdentityFile 是私钥路径。ssh、scp、rsync、VS Code Remote 都读这个文件。
:::

5. `docker ps` 报 permission denied，`sudo docker ps` 却正常，为什么？

::: details 参考答案
当前用户不在 docker 组，或者加了组但没重新登录，组身份没生效。docker.sock 默认属于 docker 组，`sudo usermod -aG docker 用户名` 加进去再重新登录，就能免 sudo。别长期用 sudo docker 凑合，脚本化部署时处处别扭。
:::

## 延伸阅读

- [Docker 官方安装文档（Ubuntu）](https://docs.docker.com/engine/install/ubuntu/)，一键脚本背后的 apt 源安装法，想精确控制版本时用它
- [docker/docker-install 仓库](https://github.com/docker/docker-install)，get.docker.com 脚本的源码，`--mirror` 参数的说明在这里
- [fail2ban 官方仓库](https://github.com/fail2ban/fail2ban)，默认 sshd jail 的工作原理和配置项
- [ssh_config 手册](https://man.openbsd.org/ssh_config)，Host 别名能配的字段远不止今天这四个

今天产出的这台机器，接下来一周就是主战场：明天把第 7 周推上仓库的镜像拉下来，用 Compose 让它真正跑成一个线上服务。
