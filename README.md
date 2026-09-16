# AI Agent 全栈工程师 · 23 周通关教程（博客项目）

配套《企业级 AI Agent 全栈工程师 · 23 周每日执行手册》的 VitePress 博客教程。

手册负责"每天做什么"，本博客负责"怎么学会"——每天一篇保姆级教程：概念讲解 + 可运行代码 + 踩坑实录 + 自测题。

## 本地运行

```bash
cd ai-agent-blog
npm install        # 或 pnpm install
npm run docs:dev   # 开发服务器 http://localhost:5173
```

## 构建

```bash
npm run docs:build     # 产出 docs/.vitepress/dist
npm run docs:preview   # 本地预览构建结果
```

## 目录结构

```text
ai-agent-blog/
├── package.json
└── docs/
    ├── .vitepress/config.mts   # 站点配置：导航 + 侧边栏（5 阶段 × 23 周）
    ├── index.md                # 首页
    ├── roadmap.md              # 23 周路线图
    ├── guide/index.md          # 使用指南
    └── weekNN/                 # 每周一个目录
        ├── index.md            # 周概览（日程表 + 参考资源）
        └── dayN.md             # 每天一篇教程（第 1 周已写完）
```

## 如何追加新一周的教程

1. 复制 `docs/week01/day1.md` 的结构作为模板（今日目标 → 概念讲解 → 核心知识 → 动手任务 → 常见踩坑 → 自测问题 → 延伸阅读）
2. 在 `docs/weekNN/` 下创建 `day1.md` ~ `day7.md`
3. 在 `.vitepress/config.mts` 的 sidebar 中，把对应周从单链接展开成带 Day 列表的分组（参考 `week01` 的写法）
4. 更新对应 `weekNN/index.md` 的"教程进度"部分

## 部署

当前采用 **GitHub Actions 自动部署到 GitHub Pages**（本仓库已配置 `.github/workflows/deploy.yml`）。

- **Vercel / Netlify（备选）**：导入仓库，构建命令 `pnpm docs:build`，输出目录 `docs/.vitepress/dist`

### deploy.yml 配置说明

整体流程一图流：

```text
push 到 main ──► checkout 代码 ──► 装 pnpm ──► 装 Node 22 ──► pnpm install
                                                                              │
线上访问 ◄── deploy-pages 发布 ◄── upload-pages-artifact 打包 ◄── vitepress build
```

#### 1. 触发条件

```yaml
on:
  push:
    branches: [main]     # 只有 main 分支的推送才触发部署
  workflow_dispatch: {}  # 允许在 Actions 页面手动点按钮重跑
```

#### 2. 权限声明（GitHub Pages 部署的核心）

```yaml
permissions:
  contents: read    # 读仓库代码
  pages: write      # 向 Pages 服务写入产物
  id-token: write   # OIDC 免密令牌
```

`id-token: write` 是关键：GitHub 会为工作流自动签发短期令牌，**全程不需要配置任何 Secret**——这是官方推荐的 Pages 部署方式（比老式的 PAT + gh-pages 分支方案安全，令牌用完即焚）。

#### 3. 并发控制

```yaml
concurrency:
  group: pages           # 所有部署共用一个"队列"
  cancel-in-progress: false  # 排队等待，不取消进行中的部署
```

连续快速 push 多次时，部署不会并发打架，也不会中途掐断正在发布的版本（掐断 = 线上可能半新半旧）。

#### 4. build 任务（构建产物）

| 步骤 | 作用 |
|------|------|
| `actions/checkout@v4` | 拉代码（`fetch-depth: 0` 取全历史，供"最后更新时间"类功能使用） |
| `pnpm/action-setup@v4` | 安装 pnpm——**自动读取 package.json 里的 `packageManager: "pnpm@11.17.0"`**，保证 CI 与本地同版本（这就是为什么之前要加这个字段） |
| `actions/setup-node@v4` | 安装 Node 22，并开启 **pnpm 依赖缓存**（命中后 install 从 ~40s 降到 ~3s） |
| `pnpm install --frozen-lockfile` | 严格按 lockfile 安装，lockfile 与 package.json 不一致时直接报错，杜绝"本地能跑 CI 挂" |
| `pnpm docs:build` | VitePress 构建，产出 `docs/.vitepress/dist` |
| `actions/upload-pages-artifact@v3` | 把 dist 打包成制品上传 |

#### 5. deploy 任务（发布上线）

```yaml
deploy:
  environment:
    name: github-pages
    url: ${{ steps.deployment.outputs.page_url }}
  needs: build                    # build 成功才执行
  steps:
    - uses: actions/deploy-pages@v4   # 把制品发布到 Pages
```

### 常见自定义

- **换默认分支**：`branches: [main]` 改成你的分支名
- **换 Node 版本**：`node-version: 22` 改掉即可（VitePress 要求 ≥18）
- **绑定自定义域名**：仓库 Settings → Pages → Custom domain 填入域名并加 DNS CNAME 记录；同时把 `config.mts` 的 `base: '/ai-agent-blog/'` 改成 `base: '/'`
- **看部署日志/重跑**：仓库 Actions 页 → 点对应运行记录 → 展开红色/黄色步骤

### 排错速查

| 症状 | 先检查 |
|------|--------|
| Actions 成功但 404 | 仓库 Settings → Pages → Build source 是否为 **GitHub Actions**；`config.mts` 的 `base` 是否与仓库名一致 |
| 页面出来了但样式丢失 | `base` 路径配错（F12 看 CSS 请求是否 404） |
| install 阶段失败 | 本地跑 `pnpm install` 后提交更新的 `pnpm-lock.yaml` |
| esbuild 相关报错 | `pnpm-workspace.yaml` 的 `allowBuilds: esbuild: true` 是否还在 |

> 顺带一提：这套 workflow 正是学习手册**第 7 周（Docker + CI/CD）** GitHub Actions 部分的实战案例，学到那周时可以回来对着真实项目读一遍。
