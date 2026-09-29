<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { useRoute } from 'vitepress'
import { nextTick, watch } from 'vue'
import HomeHeroInfo from './components/HomeHeroInfo.vue'
import HomeTerminal from './components/HomeTerminal.vue'
import HomeStats from './components/HomeStats.vue'
import HomePillars from './components/HomePillars.vue'
import HomeStages from './components/HomeStages.vue'
import HomeCta from './components/HomeCta.vue'

const { Layout } = DefaultTheme

// 侧边栏自动定位：路由变化后把高亮菜单项滚进可视区。
// VitePress 只负责加 is-active 类和展开分组，不负责滚动——菜单长（100+ 项）时
// 高亮项常落在侧边栏视口之外，用户感知为"没定位到"。block:'nearest' 只滚
// 侧边栏自己的滚动容器，不动正文。双 rAF 等 VPSidebarItem 的展开动画先跑完。
const route = useRoute()
watch(
  () => route.path,
  async () => {
    await nextTick()
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector('.VPSidebarItem.is-active')
          ?.scrollIntoView({ block: 'nearest' })
      })
    })
  },
  { immediate: true }
)
</script>

<template>
  <Layout>
    <template #home-hero-info>
      <HomeHeroInfo />
    </template>

    <template #home-hero-image>
      <HomeTerminal />
    </template>

    <template #home-hero-after>
      <HomeStats />
    </template>

    <template #home-features-before>
      <HomePillars />
      <HomeStages />
      <HomeCta />
    </template>
  </Layout>
</template>
