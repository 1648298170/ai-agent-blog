<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'

/**
 * 终端视觉锚点：一条 Agent 工具调用对话流，循环播放。
 * - cmd / agent 两行做逐字符打字机（ghost span 占位防抖动）
 * - 其余行整行浮现，节奏 360ms
 * - prefers-reduced-motion 时直接静态呈现全部内容
 */

interface Line {
  tag: 'cmd' | 'sys' | 'you' | 'plan' | 'tool' | 'done' | 'agent'
  text: string
}

const SCRIPT: Line[] = [
  { tag: 'cmd', text: 'jerry agent run --task "统计上周订单并写周报"' },
  { tag: 'sys', text: 'LangGraph 编译完成 · 3 个工具已挂载' },
  { tag: 'you', text: '帮我统计上周订单量，写成一页周报' },
  { tag: 'plan', text: '先 query_db 取数据 → 再 write_report 生成文档' },
  { tag: 'tool', text: 'query_db("SELECT count(*) FROM orders …")' },
  { tag: 'done', text: '→ 1,284 单 · 环比 +12%' },
  { tag: 'tool', text: 'write_report("weekly-report.md")' },
  { tag: 'done', text: '→ 已生成 /out/weekly-report.md' },
  { tag: 'agent', text: '上周 1,284 单（环比 +12%），周报已交付。' }
]

const LABELS: Record<string, string> = {
  cmd: '$',
  sys: 'sys',
  you: 'YOU',
  plan: 'PLAN',
  tool: 'TOOL',
  done: 'OUT',
  agent: 'AGENT'
}

const TYPE_TAGS = ['cmd', 'agent']

const cur = ref(-2) // -2 = 初始空白（SSR），-1 = 起始暂停
const chars = ref(0)
const allDone = ref(false)
const started = ref(false)

let stopped = false
let timer: ReturnType<typeof setTimeout> | null = null

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })

function label(tag: string): string {
  return LABELS[tag] ?? ''
}

function typedText(line: Line, index: number): string {
  if (index !== cur.value) return line.text
  return line.text.slice(0, chars.value)
}

async function play() {
  while (!stopped) {
    cur.value = -1
    chars.value = 0
    allDone.value = false
    await wait(600)

    for (let i = 0; i < SCRIPT.length; i++) {
      if (stopped) return
      cur.value = i
      const line = SCRIPT[i]

      if (TYPE_TAGS.includes(line.tag)) {
        chars.value = 0
        for (let c = 1; c <= line.text.length; c++) {
          if (stopped) return
          chars.value = c
          await wait(26 + Math.random() * 34)
        }
        await wait(300)
      } else {
        await wait(380)
      }
    }

    cur.value = SCRIPT.length - 1
    allDone.value = true
    await wait(4200)
  }
}

onMounted(() => {
  started.value = true
  const reduce =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) {
    // 静态呈现：全部行可见，不播放
    cur.value = SCRIPT.length - 1
    chars.value = SCRIPT[SCRIPT.length - 1].text.length
    allDone.value = true
    return
  }
  play()
})

onBeforeUnmount(() => {
  stopped = true
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="jt-wrap" aria-label="AI Agent 运行过程演示（终端动画）">
    <div class="jt-term">
      <div class="jt-bar">
        <span class="jt-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="jt-title">jerry@ai-agent — ~/workshop</span>
        <span class="jt-shell">zsh</span>
      </div>

      <div class="jt-body">
        <div
          v-for="(l, i) in SCRIPT"
          :key="i"
          class="jt-line"
          :class="[
            'jt-t-' + l.tag,
            {
              on: started && (i <= cur || allDone),
              'jt-is-typed': TYPE_TAGS.includes(l.tag),
              cur:
                started &&
                ((i === cur && !allDone) ||
                  (allDone && i === SCRIPT.length - 1))
            }
          ]"
        >
          <span class="jt-tag" aria-hidden="true">{{ label(l.tag) }}</span>
          <span class="jt-tx">
            <template v-if="TYPE_TAGS.includes(l.tag)">
              <span class="jt-ghost" aria-hidden="true">{{ l.text }}</span>
              <span class="jt-typed">{{ typedText(l, i) }}</span>
            </template>
            <template v-else>{{ l.text }}</template>
          </span>
        </div>
      </div>

      <div class="jt-status">
        <span class="jt-status-left">
          <i class="jt-led" :class="{ ok: allDone }" aria-hidden="true"></i>
          {{ allDone ? 'done · 2.4s · 0 errors' : 'agent running' }}
        </span>
        <span class="jt-status-right">week01 · day7</span>
      </div>
    </div>
  </div>
</template>
