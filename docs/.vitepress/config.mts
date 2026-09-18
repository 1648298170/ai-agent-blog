import { defineConfig } from 'vitepress'

/** 每周 7 天的短标题 */
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

/** 周 → 阶段归组（用于把同一阶段的内容聚在同一个导航分组里） */
const stageOfWeek: Record<number, string> = {
  1: 'A1', 2: 'A1', 3: 'A3', 4: 'A3',
  5: 'A4', 6: 'A4', 7: 'A4', 8: 'A4',
  9: 'B0', 10: 'B1',
  11: 'A5', 12: 'B2', 13: 'B3',
  14: 'B4', 15: 'B4',
  16: 'A7', 17: 'B5', 18: 'B6', 19: 'B8',
  20: 'A9', 21: 'A9',
  22: 'A10', 23: 'A10'
}

const link = (text: string, path: string) => ({ text, link: path })

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
      { text: '学习总纲', link: '/guide/' },
      { text: '路线图', link: '/roadmap' },
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
        text: '开始',
        collapsed: false,
        items: [
          { text: '前言 · 开始之前', link: '/preface' },
          { text: '学习总纲 · 双轨路径', link: '/guide/' },
          { text: '路线图 · 阶段与里程碑', link: '/roadmap' }
        ]
      },
      {
        text: 'Track A · Node + TS 主线（0 → 落地 → 精通）',
        collapsed: false,
        items: [
          { text: 'A1 · 语言与类型进阶（第 1 周 Day 1-3）', link: '/week01/day1' },
          { text: 'A2 · 工程底座（Monorepo / 门禁 / 测试）', link: '/week01/day4' },
          { text: 'A3 · Web 全栈（Next.js + NestJS + PG）', link: '/week02/day4' },
          { text: 'A4 · 生产基建（认证 / Redis / Docker / CI / 云）', link: '/week05/day1' },
          { text: 'A5 · LLM 与 Agent 核心（AI SDK + 工具循环 + 多 Agent）', link: '/week11/day1' },
          { text: 'A6 · RAG 与知识库（TS 全链路）', link: '/week11/rag-ts' },
          { text: 'A7 · 评估与安全', link: '/week16/day1' },
          { text: 'A8 · 三大产品落地', link: '/products/kb' },
          { text: 'A9 · 精通与求职', link: '/week22/day1' }
        ]
      },
      {
        text: 'Track B · Python 第二引擎（进阶选修）',
        collapsed: true,
        items: [
          { text: 'B0 · Python 快速上手（第 9 周）', link: '/week09/' },
          { text: 'B1 · FastAPI 服务（第 10 周）', link: '/week10/' },
          { text: 'B2 · LangGraph Agent（第 12 周）', link: '/week12/' },
          { text: 'B3 · 多 Agent 与 HITL（第 13 周）', link: '/week13/' },
          { text: 'B4 · RAG 全链路（第 14-15 周）', link: '/week14/' },
          { text: 'B5 · 评估工程（第 16 周）', link: '/week16/' },
          { text: 'B6 · 记忆与上下文（第 17 周）', link: '/week17/' },
          { text: 'B7 · MCP（第 18 周）', link: '/week18/' },
          { text: 'B8 · 安全与生态（第 19 周）', link: '/week19/' }
        ]
      },
      {
        text: '按周浏览（原 23 周路径）',
        collapsed: true,
        items: [
          { text: '第 1 周 · TypeScript 进阶 + Monorepo', link: '/week01/' },
          { text: '第 2 周 · 代码质量门禁 + Next.js', link: '/week02/' },
          { text: '第 3 周 · Node.js 核心 + NestJS', link: '/week03/' },
          { text: '第 4 周 · PostgreSQL + Prisma + 全栈整合', link: '/week04/' },
          { text: '第 5 周 · 认证授权 + 安全', link: '/week05/' },
          { text: '第 6 周 · Redis + 缓存 + 队列', link: '/week06/' },
          { text: '第 7 周 · Docker + CI/CD', link: '/week07/' },
          { text: '第 8 周 · 云部署 + 监控', link: '/week08/' },
          { text: '第 9 周 · Python + Pydantic', link: '/week09/' },
          { text: '第 10 周 · FastAPI + SSE', link: '/week10/' },
          { text: '第 11 周 · LLM API + AI SDK', link: '/week11/' },
          { text: '第 12 周 · LangGraph + ReAct', link: '/week12/' },
          { text: '第 13 周 · 多 Agent + HITL', link: '/week13/' },
          { text: '第 14 周 · RAG 基础', link: '/week14/' },
          { text: '第 15 周 · RAG 进阶', link: '/week15/' },
          { text: '第 16 周 · Agent 评估', link: '/week16/' },
          { text: '第 17 周 · 记忆 + 上下文', link: '/week17/' },
          { text: '第 18 周 · MCP', link: '/week18/' },
          { text: '第 19 周 · 安全 + 生态', link: '/week19/' },
          { text: '第 20 周 · 平台整合', link: '/week20/' },
          { text: '第 21 周 · 生产化', link: '/week21/' },
          { text: '第 22 周 · 系统设计 + 简历', link: '/week22/' },
          { text: '第 23 周 · 面试冲刺', link: '/week23/' }
        ]
      }
    ]
  }
})
