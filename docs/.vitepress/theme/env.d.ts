// 让 TS/Volar 认识 CSS 副作用导入与静态资源导入
declare module '*.css' {
  const content: string
  export default content
}

declare module '*.scss' {
  const content: string
  export default content
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
