<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import HomeHeroInfo from './components/HomeHeroInfo.vue'
import HomeTerminal from './components/HomeTerminal.vue'
import HomeStats from './components/HomeStats.vue'
import HomePillars from './components/HomePillars.vue'
import HomeStages from './components/HomeStages.vue'
import HomeCta from './components/HomeCta.vue'

const { Layout } = DefaultTheme
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
