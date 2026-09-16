<template>
  <div class="jhi">
    <p class="jhi-eyebrow">
      <span class="jhi-eyebrow-dot" aria-hidden="true"></span>
      JERRY&rsquo;S WORKSHOP · 训练日志 W01&ndash;W23
    </p>

    <h1 class="jhi-title">
      23 周，训练成<br />
      <span class="jhi-grad">AI Agent 全栈工程师</span>
    </h1>

    <p class="jhi-tagline">
      从 TypeScript、Next.js、NestJS 到 FastAPI，再到 LangGraph、RAG 与
      MCP——配套《23 周每日执行手册》的保姆级教程。每天 2&ndash;3 小时：学 &rarr;
      敲 &rarr; 测 &rarr; 输出，一条不断档的成长路径。
    </p>

    <div class="jhi-actions">
      <a class="jbtn jbtn-primary" :href="base + 'week01/'">
        进入第 1 周 · Day 1 <span aria-hidden="true">&rarr;</span>
      </a>
      <a class="jbtn jbtn-ghost" :href="base + 'roadmap'">23 周路线图</a>
      <a class="jbtn jbtn-ghost" :href="base + 'guide/'">使用指南</a>
    </div>

    <p class="jhi-status">
      <span class="jhi-pulse" aria-hidden="true"></span>
      当前进度：第 1 周已完成 · 7 / 161 篇 · 持续更新中
    </p>
  </div>
</template>

<script setup lang="ts">
// 站点可能部署在子路径（如 GitHub Pages 的 /ai-agent-blog/），
// 组件内的链接必须用 site.base 拼接，否则部署后路由解析失败
import { useData } from 'vitepress'

const base = useData().site.value.base
</script>
