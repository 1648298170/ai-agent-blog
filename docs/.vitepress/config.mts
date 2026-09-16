import { defineConfig } from 'vitepress'

const w = (n: number, title: string) => ({
  text: `第 ${n} 周 · ${title}`,
  link: `/week${String(n).padStart(2, '0')}/`
})

const week01 = {
  text: '第 1 周 · TypeScript 进阶 + Monorepo',
  collapsed: false,
  items: [
    { text: '周概览', link: '/week01/' },
    { text: 'Day 1 · 泛型基础', link: '/week01/day1' },
    { text: 'Day 2 · 条件类型与映射类型', link: '/week01/day2' },
    { text: 'Day 3 · 类型守卫与类型窄化', link: '/week01/day3' },
    { text: 'Day 4 · Monorepo 与 pnpm workspace', link: '/week01/day4' },
    { text: 'Day 5 · Turborepo 任务管道', link: '/week01/day5' },
    { text: 'Day 6 · 共享类型包与工具包', link: '/week01/day6' },
    { text: 'Day 7 · 周复盘方法论', link: '/week01/day7' }
  ]
}

export default defineConfig({
  lang: 'zh-CN',
  base: '/ai-agent-blog/',
  title: 'AI Agent 全栈工程师',
  description:
    '配套《企业级 AI Agent 全栈工程师 · 23 周每日执行手册》的保姆级博客教程：TypeScript → Next.js → NestJS → FastAPI → LangGraph → RAG → MCP',

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],

  markdown: {
    lineNumbers: true
  },

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: '路线图', link: '/roadmap' },
      { text: '第 1 周教程', link: '/week01/' },
      { text: '使用指南', link: '/guide/' }
    ],

    outline: { level: [2, 3], label: '本页目录' },

    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',

    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: {
                buttonText: '搜索',
                buttonAriaLabel: '搜索'
              },
              modal: {
                noResultsText: '没有结果',
                resetButtonTitle: '重置搜索',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭'
                }
              }
            }
          }
        }
      }
    },

    sidebar: [
      {
        text: '阶段一 · 前端 + Node 底座（第 1–4 周）',
        collapsed: false,
        items: [
          week01,
          w(2, '代码质量门禁 + Next.js 全栈路由'),
          w(3, 'Node.js 核心 + NestJS 入门'),
          w(4, 'PostgreSQL + Prisma + 全栈整合')
        ]
      },
      {
        text: '阶段二 · 工程化 + 数据 + 部署（第 5–8 周）',
        collapsed: true,
        items: [
          w(5, '认证授权 + 安全基础'),
          w(6, 'Redis + 缓存 + 队列 + 并发控制'),
          w(7, 'Docker + CI/CD'),
          w(8, '云部署 + Nginx + 可观测性入门')
        ]
      },
      {
        text: '阶段三 · Python + FastAPI + Agent 核心（第 9–13 周）',
        collapsed: true,
        items: [
          w(9, 'Python 核心 + Pydantic'),
          w(10, 'FastAPI + SSE 流式响应'),
          w(11, 'LLM API 基础 + 结构化输出 + AI SDK'),
          w(12, 'LangGraph + ReAct + 工具调用'),
          w(13, '多 Agent 协作 + Human-in-the-Loop')
        ]
      },
      {
        text: '阶段四 · RAG + 评估 + 记忆 + MCP + 安全（第 14–19 周）',
        collapsed: true,
        items: [
          w(14, 'RAG Pipeline 基础'),
          w(15, 'RAG 进阶 + 引用溯源'),
          w(16, 'Agent 评估工程'),
          w(17, '记忆架构 + 上下文工程'),
          w(18, 'MCP 协议 + 工具生态'),
          w(19, 'Agent 安全 + A2A + 国产生态')
        ]
      },
      {
        text: '阶段五 · 整合 + 生产化 + 面试（第 20–23 周）',
        collapsed: true,
        items: [
          w(20, '全栈整合 + 平台主链路'),
          w(21, '生产化 + 可观测性 + 成本控制'),
          w(22, '系统设计 + 项目复盘 + 简历'),
          w(23, '面试冲刺')
        ]
      }
    ]
  }
})
