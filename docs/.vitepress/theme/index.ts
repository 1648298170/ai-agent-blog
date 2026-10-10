import DefaultTheme from 'vitepress/theme'
import Layout from './Layout.vue'
import './custom.css'

// SSG 垫片：构建期逐页预渲染在 Node 环境执行，默认主题路由的
// watchImmediate → requestAnimationFrame 链路会因无浏览器 API 抛错，
// 导致整站预渲染失败（dist 空）。
// 垫片语义 = no-op：rAF 的语义是「下一帧视觉更新」，静态渲染没有帧，
// 视觉调度回调（侧边栏滚动定位等）在服务端本就不该执行——页面静态 HTML
// 照常输出，浏览器水合后真实 rAF 接管（垫片只在 typeof window === 'undefined' 时生效）。
if (typeof window === 'undefined') {
  const g = globalThis as Record<string, unknown>
  g.requestAnimationFrame ??= () => 0
  g.cancelAnimationFrame ??= () => {}
}

export default {
  ...DefaultTheme,
  Layout
}
