<template>
  <section class="jsec jsec-pillars">
    <header class="jsec-head">
      <p class="jsec-kicker">WHY THIS COURSE · 内容法</p>
      <h2 class="jsec-title">为什么跟得住、学得会</h2>
    </header>

    <div class="jp-grid">
      <div v-for="(p, i) in pillars" :key="i" class="jp-item">
        <span class="jp-no" aria-hidden="true">{{ p.no }}</span>
        <div class="jp-body">
          <h3 class="jp-title">{{ p.title }}</h3>
          <p class="jp-desc">{{ p.desc }}</p>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
const pillars = [
  {
    no: '01',
    title: '每天一篇 · 保姆级深度',
    desc: '概念讲解 + 可运行代码 + 踩坑实录 + 自测题，把手册里的每一行任务真正讲透。'
  },
  {
    no: '02',
    title: '代码全部可复现',
    desc: 'TypeScript → NestJS → FastAPI → LangGraph → RAG → MCP，跟着教程一步一步敲，就能在本机跑通。'
  },
  {
    no: '03',
    title: '面向 2026 就业市场',
    desc: '直击 JD 高频考点：Agent 评估工程、Agent 安全、A2A 协议、国产模型生态。'
  },
  {
    no: '04',
    title: '手册 × 博客双轨制',
    desc: '手册管「每天做什么」，博客管「怎么学会」——每天 2–3 小时，学 → 做 → 输出，形成闭环。'
  }
]
</script>
