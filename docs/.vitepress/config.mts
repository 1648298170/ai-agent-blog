import { defineConfig } from 'vitepress'

/** 每周 7 天的短标题（与周概览页"教程进度"一致） */
const dayTitles: Record<number, string[]> = {
  2: ['ESLint 与 Prettier', 'Husky 与 Git 钩子', 'Vitest 单元测试', 'Next.js 15 App Router', 'Server 与 Client 组件', 'Server Actions', '周复盘'],
  3: ['事件循环', '模块与环境变量', 'NestJS 入门', 'Controller 与 DTO', 'Service 与依赖注入', 'Pipe 参数校验', '周复盘'],
  4: ['PostgreSQL 基础', 'Prisma 入门', 'Prisma CRUD', '事务与索引', 'NestJS 整合 Prisma', '前后端联调', '阶段一里程碑'],
  5: ['JWT 签发', 'JWT 守卫', 'Refresh Token', 'RBAC', 'OAuth2', 'Web 安全', '周复盘'],
  6: ['Redis 基础', '缓存策略', '分布式锁', 'BullMQ 队列', '重试延迟与定时', '幂等设计', '周复盘'],
  7: ['Dockerfile', 'compose 编排', '前端容器化与 Nginx', 'GitHub Actions', '镜像推送', '密钥管理', '周复盘'],
  8: ['云服务器', 'Nginx 与 HTTPS', '自动部署', '结构化日志', '监控入门', '健康检查与优雅关闭', '阶段二里程碑'],
  9: ['Python 环境', '类型注解', 'asyncio', 'Pydantic 基础', '配置管理', '装饰器与上下文', '周复盘'],
  10: ['FastAPI 入门', '请求响应模型', '分层架构', 'SQLAlchemy 与 DI', 'SSE 流式', '前端消费 SSE', '周复盘'],
  11: ['LLM 原生 API', '流式与 FC 底层', '结构化输出', 'AI SDK 后端', 'AI SDK 前端', '多供应商切换', '周复盘'],
  12: ['LangGraph 概念', '最小 Graph', '条件边', '裸 ReAct', '工具定义', 'Checkpointer', '周复盘'],
  13: ['多 Agent 架构', 'Supervisor', 'Worker 实现', 'interrupt 审批', '审批 UI', '容错', '阶段三里程碑'],
  14: ['RAG 概念', '文档解析', '文本切块', 'Embedding', 'pgvector', '相似度检索', '周复盘'],
  15: ['Hybrid 检索', '重排序', 'Adaptive RAG', '引用溯源', 'RAG 评估', '知识库 UI', '周复盘'],
  16: ['评估方法论', 'LLM-as-judge', '轨迹评估', 'promptfoo', 'DeepEval', '评估进 CI', '周复盘'],
  17: ['记忆架构', '上下文压缩', '长期记忆', '向量记忆', 'System Prompt 设计', '记忆整合', '周复盘'],
  18: ['MCP 概念', 'MCP Server', 'MCP Client', 'MCP Resources', '安全护栏', '审批升级', '周复盘'],
  19: ['注入攻防', 'OWASP 自查', 'Guardrails', 'A2A 协议', 'Dify 上手', 'Coze 与选型', '阶段四里程碑'],
  20: ['模板结构分析', 'NestJS BFF', '多租户 RBAC', '统一认证', '流式对话 UI', '平台导航整合', '周复盘'],
  21: ['LangSmith 与 Langfuse', 'Token 计量与模型路由', '限流配额', '死循环防御', '日志指标告警', '语义缓存', '压测复盘'],
  22: ['系统设计', '缓存三件套', '队列设计', 'STAR 复盘', '简历优化', '模拟面试', '周复盘'],
  23: ['Agent 八股', '工程八股', '系统设计模拟', 'LeetCode', '完整模拟面试', '投递冲刺', '速查卡']
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 各周附加的加餐页 */
const bonus: Record<number, { text: string; link: string }> = {
  12: { text: '加餐 · LangChain 生态地图', link: '/week12/langchain' },
  23: { text: '加餐 · 场景题实战', link: '/week23/scenarios' }
}

const w = (n: number, title: string) => ({
  text: `第 ${n} 周 · ${title}`,
  collapsed: true,
  items: [
    { text: '周概览', link: `/week${pad(n)}/` },
    ...(dayTitles[n] ?? []).map((t, i) => ({
      text: `Day ${i + 1} · ${t}`,
      link: `/week${pad(n)}/day${i + 1}`
    })),
    ...(bonus[n] ? [bonus[n]] : [])
  ]
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
    lineNumbers: true,
    config: (md) => {
      // 行内代码统一加 v-pre：否则 {{ var }} 会被 Vue 当插值求值
      // （undefined 时轻则内容被吞，重则整页 SSR 渲染中断）
      const escapeHtml = md.utils.escapeHtml
      md.renderer.rules.code_inline = (tokens, idx) =>
        `<code v-pre>${escapeHtml(tokens[idx].content)}</code>`
    }
  },

  // 教程正文里的本地开发地址（http://localhost:3000 等）是示例不是链接
  ignoreDeadLinks: [/^https?:\/\/localhost/],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: '前言', link: '/preface' },
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
      { text: '前言 · 开始之前', link: '/preface' },
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
      },
      {
        text: '落地实战（三大产品）',
        collapsed: true,
        items: [
          { text: '知识库问答从 0 到上线', link: '/products/kb' },
          { text: '文档智能：结构化理解', link: '/products/docintel' },
          { text: '客服系统：从演示到真上线', link: '/products/service' }
        ]
      }
    ]
  }
})
