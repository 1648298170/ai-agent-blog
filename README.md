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

- **Vercel / Netlify**：导入仓库，构建命令 `npm run docs:build`，输出目录 `docs/.vitepress/dist`
- **GitHub Pages**：参考 [VitePress 官方部署指南](https://vitepress.dev/guide/deploy#github-pages)
