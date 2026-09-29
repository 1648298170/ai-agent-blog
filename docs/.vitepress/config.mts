import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  base: '/ai-agent-blog/',
  title: 'AI Agent 全栈工程师',
  description:
    '从 0 基础到落地到精通的 AI Agent 全栈教程：Node + TS 主线，覆盖 LLM API → Agent 循环 → RAG → MCP → 三大产品落地',

  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }]],

  markdown: {
    lineNumbers: true,
    config: (md) => {
      const escapeHtml = md.utils.escapeHtml
      md.renderer.rules.code_inline = (tokens, idx) =>
        `<code v-pre>${escapeHtml(tokens[idx].content)}</code>`
    }
  },

  ignoreDeadLinks: [/^https?:\/\/localhost/],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: '首页', link: '/' },
      { text: '学习总纲', link: '/guide/' },
      { text: '路线图', link: '/roadmap' },
      { text: '使用指南', link: '/guide/' }
    ],

    outline: { level: [2, 3], label: '本页目录' },

    docFooter: { prev: '上一篇', next: '下一篇' },
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
              button: { buttonText: '搜索', buttonAriaLabel: '搜索' },
              modal: {
                noResultsText: '没有结果',
                resetButtonTitle: '重置搜索',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' }
              }
            }
          }
        }
      }
    },

    sidebar: [
      {
        text: '开始',
        collapsed: false,
        items: [
          { text: '前言 · 开始之前', link: '/preface' },
          { text: '学习总纲 · 双轨路径', link: '/guide/' },
          { text: '路线图 · 阶段与里程碑', link: '/roadmap' }
        ]
      },
      {
        text: '周概览 · 每周导航',
        collapsed: true,
        items: [
          { text: '第 1 周 · TypeScript 进阶 + Monorepo 工程化', link: '/week01/' },
          { text: '第 2 周 · 代码质量门禁 + 测试 + Next.js 全栈路由', link: '/week02/' },
          { text: '第 3 周 · Node.js 核心 + NestJS 入门', link: '/week03/' },
          { text: '第 4 周 · PostgreSQL + Prisma + 全栈整合', link: '/week04/' },
          { text: '第 5 周 · 认证授权 + 安全基础', link: '/week05/' },
          { text: '第 6 周 · Redis + 缓存 + 队列 + 并发控制', link: '/week06/' },
          { text: '第 7 周 · Docker + CI/CD', link: '/week07/' },
          { text: '第 8 周 · 云部署 + Nginx + 可观测性入门', link: '/week08/' },
          { text: '第 9 周 · Python 核心 + Pydantic', link: '/week09/' },
          { text: '第 10 周 · FastAPI + SSE 流式响应', link: '/week10/' },
          { text: '第 11 周 · LLM API 基础 + 结构化输出 + Vercel AI SDK', link: '/week11/' },
          { text: '第 12 周 · LangGraph + ReAct + 工具调用', link: '/week12/' },
          { text: '第 13 周 · 多 Agent 协作 + Human-in-the-Loop', link: '/week13/' },
          { text: '第 14 周 · RAG Pipeline 基础', link: '/week14/' },
          { text: '第 15 周 · RAG 进阶 + 引用溯源', link: '/week15/' },
          { text: '第 16 周 · Agent 评估工程', link: '/week16/' },
          { text: '第 17 周 · 记忆架构 + 上下文工程', link: '/week17/' },
          { text: '第 18 周 · MCP 协议 + 工具生态', link: '/week18/' },
          { text: '第 19 周 · Agent 安全 + A2A + 国产生态', link: '/week19/' },
          { text: '第 20 周 · 全栈整合 + 平台主链路', link: '/week20/' },
          { text: '第 21 周 · 生产化 + 可观测性 + 成本控制', link: '/week21/' },
          { text: '第 22 周 · 系统设计 + 项目复盘 + 简历', link: '/week22/' },
          { text: '第 23 周 · 面试冲刺', link: '/week23/' }
        ]
      },
      {
        text: 'Track A · Node + TS 主线',
        collapsed: false,
        items: [
          {
            text: '语言与类型进阶',
            collapsed: true,
            items: [
              { text: '泛型基础', link: '/week01/day1' },
              { text: '条件类型与映射类型', link: '/week01/day2' },
              { text: '类型守卫与类型窄化', link: '/week01/day3' }
            ]
          },
          {
            text: '工程底座',
            collapsed: true,
            items: [
              { text: 'Monorepo 与 pnpm workspace', link: '/week01/day4' },
              { text: 'Turborepo 任务管道', link: '/week01/day5' },
              { text: '共享类型包与工具包', link: '/week01/day6' },
              { text: '周复盘', link: '/week01/day7' },
              { text: 'ESLint 与 Prettier', link: '/week02/day1' },
              { text: 'Husky 与 Git 钩子', link: '/week02/day2' },
              { text: 'Vitest 单元测试', link: '/week02/day3' }
            ]
          },
          {
            text: 'Web 全栈',
            collapsed: true,
            items: [
              { text: 'Next.js 15 App Router', link: '/week02/day4' },
              { text: 'Server 与 Client 组件', link: '/week02/day5' },
              { text: 'Server Actions', link: '/week02/day6' },
              { text: 'Node 事件循环', link: '/week03/day1' },
              { text: '模块与环境变量', link: '/week03/day2' },
              { text: 'NestJS 入门', link: '/week03/day3' },
              { text: 'Controller 与 DTO', link: '/week03/day4' },
              { text: 'Service 与依赖注入', link: '/week03/day5' },
              { text: 'Pipe 参数校验', link: '/week03/day6' },
              { text: '周复盘', link: '/week03/day7' },
              { text: '第 2 周复盘', link: '/week02/day7' }
            ]
          },
          {
            text: '数据与 API 整合',
            collapsed: true,
            items: [
              { text: 'PostgreSQL 基础', link: '/week04/day1' },
              { text: 'Prisma 入门', link: '/week04/day2' },
              { text: 'Prisma CRUD', link: '/week04/day3' },
              { text: '事务与索引', link: '/week04/day4' },
              { text: 'NestJS 整合 Prisma', link: '/week04/day5' },
              { text: '前后端联调', link: '/week04/day6' },
              { text: '阶段一里程碑', link: '/week04/day7' },
              { text: 'JWT 签发', link: '/week05/day1' },
              { text: 'JWT 守卫', link: '/week05/day2' },
              { text: 'Refresh Token', link: '/week05/day3' },
              { text: 'RBAC', link: '/week05/day4' },
              { text: 'OAuth2', link: '/week05/day5' },
              { text: 'Web 安全', link: '/week05/day6' },
              { text: '周复盘', link: '/week05/day7' }
            ]
          },
          {
            text: '生产基建',
            collapsed: true,
            items: [
              { text: 'Redis 基础', link: '/week06/day1' },
              { text: '缓存策略', link: '/week06/day2' },
              { text: '分布式锁', link: '/week06/day3' },
              { text: 'BullMQ 队列', link: '/week06/day4' },
              { text: '重试延迟与定时', link: '/week06/day5' },
              { text: '幂等设计', link: '/week06/day6' },
              { text: 'Dockerfile', link: '/week07/day1' },
              { text: 'compose 编排', link: '/week07/day2' },
              { text: '前端容器化与 Nginx', link: '/week07/day3' },
              { text: 'GitHub Actions', link: '/week07/day4' },
              { text: '镜像推送', link: '/week07/day5' },
              { text: '密钥管理', link: '/week07/day6' },
              { text: '云服务器', link: '/week08/day1' },
              { text: 'Nginx 与 HTTPS', link: '/week08/day2' },
              { text: '自动部署', link: '/week08/day3' },
              { text: '结构化日志', link: '/week08/day4' },
              { text: '监控入门', link: '/week08/day5' },
              { text: '健康检查与优雅关闭', link: '/week08/day6' },
              { text: '阶段二里程碑', link: '/week08/day7' },
              { text: '周复盘（第 6 周）', link: '/week06/day7' },
              { text: '周复盘（第 7 周）', link: '/week07/day7' }
            ]
          },
          {
            text: 'LLM 与 Agent 核心',
            collapsed: true,
            items: [
              { text: 'LLM API 原生调用', link: '/week11/day1' },
              { text: '流式与 Function Calling', link: '/week11/day2' },
              { text: '结构化输出', link: '/week11/day3' },
              { text: 'Vercel AI SDK 后端', link: '/week11/day4' },
              { text: 'AI SDK 前端', link: '/week11/day5' },
              { text: '多供应商切换', link: '/week11/day6' },
              { text: 'Agent 循环深入（补篇）', link: '/week11/agent-loop-ts' },
              { text: 'RAG TS 全链路（补篇）', link: '/week11/rag-ts' },
              { text: 'MCP TypeScript SDK（补篇）', link: '/week11/mcp-ts' },
              { text: '记忆 TS 版（补篇）', link: '/week11/memory-ts' },
              { text: '周复盘', link: '/week11/day7' }
            ]
          },
          {
            text: 'RAG 与知识库',
            collapsed: true,
            items: [
              { text: 'RAG 概念与流程', link: '/week14/day1' },
              { text: '文档解析', link: '/week14/day2' },
              { text: '文本切块', link: '/week14/day3' },
              { text: 'Embedding', link: '/week14/day4' },
              { text: 'pgvector 向量存储', link: '/week14/day5' },
              { text: '相似度检索', link: '/week14/day6' },
              { text: 'Hybrid 混合检索', link: '/week15/day1' },
              { text: '重排序', link: '/week15/day2' },
              { text: 'Adaptive RAG', link: '/week15/day3' },
              { text: '引用溯源', link: '/week15/day4' },
              { text: 'RAG 评估', link: '/week15/day5' },
              { text: '知识库管理 UI', link: '/week15/day6' },
              { text: '周复盘（第 14 周）', link: '/week14/day7' },
              { text: '周复盘（第 15 周）', link: '/week15/day7' }
            ]
          },
          {
            text: '评估与安全',
            collapsed: true,
            items: [
              { text: '评估方法论', link: '/week16/day1' },
              { text: 'LLM-as-judge', link: '/week16/day2' },
              { text: '轨迹评估', link: '/week16/day3' },
              { text: 'promptfoo 实操', link: '/week16/day4' },
              { text: 'DeepEval 实操', link: '/week16/day5' },
              { text: '评估进 CI', link: '/week16/day6' },
              { text: 'Prompt Injection 攻防', link: '/week19/day1' },
              { text: 'OWASP 自查', link: '/week19/day2' },
              { text: 'Guardrails', link: '/week19/day3' },
              { text: 'A2A 协议', link: '/week19/day4' },
              { text: 'Dify 上手', link: '/week19/day5' },
              { text: 'Coze 与选型', link: '/week19/day6' },
              { text: '周复盘', link: '/week16/day7' }
            ]
          },
          {
            text: '三大产品落地',
            collapsed: true,
            items: [
              { text: '阶段四里程碑验收', link: '/week19/day7' },
              { text: '全栈整合', link: '/week20/day1' },
              { text: 'BFF 层', link: '/week20/day2' },
              { text: '多租户 RBAC', link: '/week20/day3' },
              { text: '统一认证', link: '/week20/day4' },
              { text: '流式对话 UI', link: '/week20/day5' },
              { text: '平台导航整合', link: '/week20/day6' },
              { text: 'Tracing 与可观测', link: '/week21/day1' },
              { text: '成本与模型路由', link: '/week21/day2' },
              { text: '限流配额', link: '/week21/day3' },
              { text: '死循环防御', link: '/week21/day4' },
              { text: '日志指标告警', link: '/week21/day5' },
              { text: '语义缓存', link: '/week21/day6' },
              { text: '周复盘（第 20 周）', link: '/week20/day7' },
              { text: '压测日与周复盘', link: '/week21/day7' },
              { text: '知识库问答落地', link: '/products/kb' },
              { text: '文档智能落地', link: '/products/docintel' },
              { text: '客服系统落地', link: '/products/service' }
            ]
          },
          {
            text: '精通与求职',
            collapsed: true,
            items: [
              { text: '系统设计方法论', link: '/week22/day1' },
              { text: '缓存三件套', link: '/week22/day2' },
              { text: '队列设计', link: '/week22/day3' },
              { text: 'STAR 复盘', link: '/week22/day4' },
              { text: '简历优化', link: '/week22/day5' },
              { text: '模拟面试', link: '/week22/day6' },
              { text: '周复盘', link: '/week22/day7' },
              { text: 'Agent 八股', link: '/week23/day1' },
              { text: '工程八股', link: '/week23/day2' },
              { text: '系统设计模拟', link: '/week23/day3' },
              { text: 'LeetCode', link: '/week23/day4' },
              { text: '完整模拟面试', link: '/week23/day5' },
              { text: '投递冲刺', link: '/week23/day6' },
              { text: '面试速查卡', link: '/week23/day7' },
              { text: 'LangChain 生态地图（加餐）', link: '/week12/langchain' },
              { text: '场景题实战（加餐）', link: '/week23/scenarios' }
            ]
          }
        ]
      },
      {
        text: 'Track B · Python 第二引擎',
        collapsed: true,
        items: [
          {
            text: 'Python 快速上手',
            collapsed: true,
            items: [
              { text: 'Python 工程环境', link: '/week09/day1' },
              { text: 'Python 类型注解', link: '/week09/day2' },
              { text: 'asyncio 基础', link: '/week09/day3' },
              { text: 'Pydantic v2 基础', link: '/week09/day4' },
              { text: 'pydantic-settings', link: '/week09/day5' },
              { text: 'Python 装饰器与上下文管理器', link: '/week09/day6' },
              { text: '周复盘', link: '/week09/day7' }
            ]
          },
          {
            text: 'FastAPI 服务',
            collapsed: true,
            items: [
              { text: 'FastAPI 起步', link: '/week10/day1' },
              { text: 'Pydantic 请求体与响应模型', link: '/week10/day2' },
              { text: 'FastAPI 分层架构', link: '/week10/day3' },
              { text: 'SQLAlchemy 2.0 与 Depends', link: '/week10/day4' },
              { text: 'SSE 流式响应', link: '/week10/day5' },
              { text: '前端消费 SSE', link: '/week10/day6' },
              { text: '周复盘', link: '/week10/day7' }
            ]
          },
          {
            text: 'LangGraph Agent',
            collapsed: true,
            items: [
              { text: 'LangGraph 核心概念', link: '/week12/day1' },
              { text: '构建第一个 Graph', link: '/week12/day2' },
              { text: '条件边与路由', link: '/week12/day3' },
              { text: '手写 ReAct 循环', link: '/week12/day4' },
              { text: 'Function Calling 定义 Tool Schema', link: '/week12/day5' },
              { text: 'Checkpointer 状态持久化', link: '/week12/day6' },
              { text: '周复盘', link: '/week12/day7' }
            ]
          },
          {
            text: '多 Agent 与 HITL',
            collapsed: true,
            items: [
              { text: '多 Agent 架构设计', link: '/week13/day1' },
              { text: 'Supervisor 实现', link: '/week13/day2' },
              { text: 'Worker Agent 实现与工具集成', link: '/week13/day3' },
              { text: 'Human-in-the-Loop', link: '/week13/day4' },
              { text: '前端审批 UI', link: '/week13/day5' },
              { text: '容错三道防线', link: '/week13/day6' },
              { text: '阶段三里程碑验收', link: '/week13/day7' }
            ]
          },
          {
            text: '记忆与上下文',
            collapsed: true,
            items: [
              { text: '记忆四分类', link: '/week17/day1' },
              { text: '短期记忆', link: '/week17/day2' },
              { text: '长期记忆', link: '/week17/day3' },
              { text: '向量记忆', link: '/week17/day4' },
              { text: 'System Prompt 设计', link: '/week17/day5' },
              { text: '记忆整合到 LangGraph', link: '/week17/day6' },
              { text: '周复盘', link: '/week17/day7' }
            ]
          },
          {
            text: 'MCP',
            collapsed: true,
            items: [
              { text: 'MCP 协议全景', link: '/week18/day1' },
              { text: '第一个 MCP Server', link: '/week18/day2' },
              { text: 'MCP Client 集成', link: '/week18/day3' },
              { text: 'MCP Resources', link: '/week18/day4' },
              { text: 'MCP 安全护栏', link: '/week18/day5' },
              { text: '工具审批 UI 升级', link: '/week18/day6' },
              { text: '周复盘', link: '/week18/day7' }
            ]
          }
        ]
      }
    ]
  }
})
