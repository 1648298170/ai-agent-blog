<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import { onMounted, onBeforeUnmount } from 'vue'
import HomeHeroInfo from './components/HomeHeroInfo.vue'
import HomeTerminal from './components/HomeTerminal.vue'
import HomeStats from './components/HomeStats.vue'
import HomePillars from './components/HomePillars.vue'
import HomeStages from './components/HomeStages.vue'
import HomeCta from './components/HomeCta.vue'

const { Layout } = DefaultTheme

let cleanup = () => {}

onMounted(() => {
  const onScroll = () => {
    document.documentElement.classList.toggle(
      'jerry-scrolled',
      window.scrollY > 8
    )
  }
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  cleanup = () => window.removeEventListener('scroll', onScroll)
})

onBeforeUnmount(() => cleanup())
</script>

<template>
  <Layout>
    <template #layout-top>
      <div class="jerry-brand-line" aria-hidden="true"></div>
    </template>

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
