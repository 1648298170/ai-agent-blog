<template>
  <section class="jsec jsec-stages">
    <header class="jsec-head">
      <p class="jsec-kicker">ROADMAP · 训练路线</p>
      <h2 class="jsec-title">五段式通关路线</h2>
    </header>

    <!-- 23 周进度条 -->
    <div class="jst-prog">
      <div class="jst-cells">
        <span
          v-for="w in 23"
          :key="w"
          class="jst-cell"
          :class="{ done: true, mile: [4, 8, 13, 19, 23].includes(w) }"
          :title="'第 ' + w + ' 周' + ([4, 8, 13, 19, 23].includes(w) ? ' · 里程碑' : '')"
        >
          <i aria-hidden="true">✓</i>
        </span>
      </div>
      <div class="jst-meta">
        <span class="jst-meta-item"><b>23</b> / 23 周</span>
        <span class="jst-legend">
          <span><i class="l-done"></i>已完成</span>
          <span><i class="l-mile"></i>里程碑</span>
          <span><i class="l-todo"></i>待解锁</span>
        </span>
        <span class="jst-meta-item"><b>161</b> / 161 篇</span>
      </div>
    </div>

    <!-- 5 阶段卡 -->
    <div class="jst-grid">
      <a
        v-for="s in stages"
        :key="s.no"
        class="jst-stage"
        :class="{ live: s.live }"
        :href="base + s.to"
      >
        <div class="jst-top">
          <span class="jst-no">{{ s.no }}</span>
          <span class="jst-status">{{ s.live ? '✓ 教程已完结' : '✓ 已完结' }}</span>
        </div>
        <div class="jst-weeks">{{ s.weeks }}</div>
        <h3 class="jst-title">{{ s.title }}</h3>
        <div class="jst-tags">
          <span v-for="t in s.tags" :key="t">{{ t }}</span>
        </div>
        <div class="jst-mile">
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4 22V4" />
            <path d="M4 4c3-2 6 2 10 0v9c-4 2-7-2-10 0" />
          </svg>
          <span>{{ s.mile }}</span>
        </div>
      </a>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useData } from 'vitepress'

// to 为相对路径（不带开头斜杠），渲染时拼接 site.base，
// 以兼容部署在子路径（GitHub Pages /ai-agent-blog/）的情况
const base = useData().site.value.base

const stages = [
  {
    no: 'S1',
    weeks: 'W01–04',
    title: '前端 + Node 底座',
    tags: ['TypeScript', 'Monorepo', 'Next.js', 'NestJS', 'Prisma'],
    mile: '里程碑 v1 · 全栈 CRUD',
    live: true,
    to: 'week01/'
  },
  {
    no: 'S2',
    weeks: 'W05–08',
    title: '工程化 + 数据 + 部署',
    tags: ['认证授权', 'Redis', 'Docker', 'CI/CD', '云部署'],
    mile: '里程碑 v2 · 上线 + 监控',
    live: false,
    to: 'roadmap'
  },
  {
    no: 'S3',
    weeks: 'W09–13',
    title: 'Python + Agent 核心',
    tags: ['Python', 'FastAPI', 'LLM API', 'LangGraph', 'ReAct'],
    mile: '里程碑 v3 · 多 Agent 平台',
    live: false,
    to: 'roadmap'
  },
  {
    no: 'S4',
    weeks: 'W14–19',
    title: 'RAG + 评估 + MCP + 安全',
    tags: ['RAG', '评估工程', '记忆', 'MCP', 'A2A'],
    mile: '里程碑 v4 · 安全加固全链路',
    live: false,
    to: 'roadmap'
  },
  {
    no: 'S5',
    weeks: 'W20–23',
    title: '整合 + 生产化 + 面试',
    tags: ['平台整合', '可观测性', '简历', '面试冲刺'],
    mile: '终点 · 拿下 Offer',
    live: false,
    to: 'roadmap'
  }
]
</script>
