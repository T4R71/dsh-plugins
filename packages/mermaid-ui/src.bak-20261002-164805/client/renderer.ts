/**
 * 渲染引擎：把 mermaid 围栏块换成 SVG，并在三种干扰下保持正确 —— 流式输出、React
 * 重渲染、主题切换。
 *
 * 三条设计约束（也就是这个插件的全部难点）：
 *   1. **流式安全**：一次扫描看到的内容必须与上一次扫描相同，才认为它稳定了；
 *      渲染失败绝不删原文，只把原文露回来并加一行错误提示。
 *   2. **重渲染安全**：图插在一个`anchor`后面，被 React 抹掉就重画；但重画有配额
 *      （同一目标连抹三次即冷却），保证观察者不会被自己的写动作喂成死循环。
 *   3. **只碰 mermaid**：目标是 `div.md-code-block` 的内容块或裸 `pre`，其余代码块
 *      （shiki 高亮的那些）一个字节都不动。
 * @module @t4r71/dsh-mermaid-ui/client/renderer
 */
import type { ThemeMode } from './theme.ts'
import { detectTheme, observeTheme } from './theme.ts'
import type { MermaidTarget } from './targets.ts'
import { collectTargets, sourceOf } from './targets.ts'
import { describeError, renderMermaid } from './mermaid-runtime.ts'

/** 图容器的标记属性：既是「这是我插的」的判据，也是给验证用的观察点。 */
const FIGURE_ATTR = 'data-mermaid-ui-figure'
/** SVG 宿主的标记属性。 */
const HOST_ATTR = 'data-mermaid-ui-svg'
/** 原始代码块的状态：`rendered` / `error`（给验证与自愈用）。 */
const STATE_ATTR = 'data-mermaid-ui-state'
/** 被换掉的那块原文的隐藏标记。 */
const HIDDEN_ATTR = 'data-mermaid-ui-hidden'
const FIGURE_CLASS = 'dsh-mermaid-ui-figure'
const ERROR_CLASS = 'dsh-mermaid-ui-error'
const STYLE_MARKER = '@t4r71/dsh-mermaid-ui/style'

/** 控制台前缀：报告里给用户的观察点。 */
const LOG = '[mermaid-ui]'
/** 与 package.json 同步的版本号（不读 json，免得把它打进 bundle）。 */
const VERSION = '0.1.0'

/** DOM 变动到这个时长没有新的，才做一次扫描。 */
const SCAN_DEBOUNCE_MS = 100
/** 内容两次扫描之间不变，才认为这个围栏稳定了（流式安全）。 */
const STABLE_MS = 350
/** 同一目标被抹掉这么多次就不再自动重画，避免与 React 打架。 */
const MAX_STRIKES = 3
/** 触发配额后的冷却时间。 */
const STRIKE_COOLDOWN_MS = 5_000

/** 注入的样式：隐藏原文、摆图、错误提示。 */
const CSS_TEXT = `.${FIGURE_CLASS}{display:flex;justify-content:center;align-items:flex-start;padding:12px;overflow:auto}
.${FIGURE_CLASS}>[${HOST_ATTR}]{max-width:100%}
.${FIGURE_CLASS} svg{max-width:100%;height:auto}
.${ERROR_CLASS}{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.85;padding:6px 10px;margin:0 0 8px;border-left:3px solid #d9534f;white-space:pre-wrap;word-break:break-word}
[${HIDDEN_ATTR}]{display:none!important}`

/** 一个目标当前的渲染结果。 */
interface Entry {
  /** 画这张图时的源文本；源变了就作废重画。 */
  source: string
  /** 图容器（`anchor` 的下一个兄弟）。 */
  figure: HTMLElement
  /** 画这张图时的主题；主题变了就重画。 */
  mode: ThemeMode
  /** 上一次的失败原因；成功时为 undefined。 */
  error: string | undefined
}

/** 验证用手柄。 */
export interface MermaidDebugHandle {
  version: string
  /** 当前判定的主题。 */
  theme(): ThemeMode
  /** 计数与在管目标数。 */
  stats(): { rendered: number; errors: number; tracked: number; theme: ThemeMode }
  /** 立刻扫一遍（不等防抖）。 */
  rescan(): void
  /** 立刻按当前主题重画所有图。 */
  rerender(): void
}

declare global {
  interface Window {
    /** 本插件挂出来的调试/验证入口；插件卸载时删除。 */
    __DSH_MERMAID_UI__?: MermaidDebugHandle
  }
}

/** 渲染器对外面。 */
export interface MermaidRenderer {
  /** 开始观察并做首次扫描。 */
  start(): void
  /** 停止观察、撤销本插件对 DOM 的改动。 */
  stop(): void
}

/** 注入一次性样式表。 */
function ensureStyle(): void {
  if (document.querySelector(`style[data-plugin-css="${STYLE_MARKER}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = '@t4r71/dsh-mermaid-ui'
  style.dataset.pluginCss = STYLE_MARKER
  style.textContent = CSS_TEXT
  document.head.append(style)
}

/** 节点是不是我们插的图（用来过滤自己制造的变动，省掉无谓扫描）。 */
function isOurs(node: Node | null): boolean {
  if (node === null) return false
  const element = node instanceof Element ? node : node.parentElement
  if (element === null) return false
  return element.closest(`[${FIGURE_ATTR}]`) !== null
}

/** 建/取图容器：永远是 `anchor` 的下一个兄弟。 */
function ensureFigure(target: MermaidTarget): HTMLElement {
  const sibling = target.anchor.nextElementSibling
  if (sibling instanceof HTMLElement && sibling.hasAttribute(FIGURE_ATTR)) return sibling
  const figure = document.createElement('div')
  figure.className = FIGURE_CLASS
  figure.setAttribute(FIGURE_ATTR, '')
  target.anchor.after(figure)
  return figure
}

/** 取 SVG 宿主（图容器里那个块）。 */
function ensureHost(figure: HTMLElement): HTMLElement {
  const existing = figure.querySelector<HTMLElement>(`[${HOST_ATTR}]`)
  if (existing !== null) return existing
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  figure.replaceChildren(host)
  return host
}

/** 只把原文露回来：错误路径用它，`state="error"` 这个观察点必须留下。 */
function show(subject: Element): void {
  subject.removeAttribute(HIDDEN_ATTR)
}

/** 彻底复位：原文露回来、状态标记清掉。自愈与卸载用它。 */
function reset(subject: Element): void {
  subject.removeAttribute(HIDDEN_ATTR)
  subject.removeAttribute(STATE_ATTR)
}

/**
 * 建一个渲染器。
 * @returns 可 start/stop 的渲染器。
 */
export function createRenderer(): MermaidRenderer {
  /** 在管目标：键是目标里的 `subject`。用 Map 而非 WeakMap 是因为主题切换要遍历它。 */
  const entries = new Map<Element, Entry>()
  /** 上一次扫描看到的源文本，用于「两次一致才算稳定」。 */
  const seen = new WeakMap<Element, string>()
  /** 正在渲染中的目标，防止同一目标并发出两张图。 */
  const pending = new WeakSet<Element>()
  /** 被 React 抹掉的次数与冷却截止时间。 */
  const strikes = new WeakMap<Element, { count: number; until: number }>()
  let observer: MutationObserver | undefined
  let detachTheme: (() => void) | undefined
  let timer: number | undefined
  let running = false
  let sequence = 0
  let rendered = 0
  let errors = 0
  let mode: ThemeMode = 'light'

  function schedule(delay: number): void {
    if (!running) return
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => { timer = undefined; rescan() }, delay)
  }

  function rescan(): void {
    if (!running) return
    let waiting = false
    for (const target of collectTargets()) {
      const subject = target.subject
      if (!subject.isConnected) continue
      const source = sourceOf(target)
      // 围栏已经出现但内容还没到（流式开头）：等下一轮，别拿空文本去喂 mermaid。
      if (source.trim().length === 0) continue
      const entry = entries.get(subject)
      if (entry !== undefined && entry.source === source && entry.figure.isConnected) continue
      if (seen.get(subject) !== source) {
        // 与上次不同：记下来，等它安静 STABLE_MS 之后再做决定。
        seen.set(subject, source)
        strikes.delete(subject)
        waiting = true
        continue
      }
      if (pending.has(subject)) continue
      const strike = strikes.get(subject)
      if (strike !== undefined && strike.count >= MAX_STRIKES && Date.now() < strike.until) continue
      pending.add(subject)
      void paint(target, source)
    }
    heal()
    if (waiting) schedule(STABLE_MS)
  }

  /** 自愈：图没了就把原文放回去并允许重画（带配额）。 */
  function heal(): void {
    for (const [subject, entry] of [...entries]) {
      if (!subject.isConnected) {
        entries.delete(subject)
        continue
      }
      if (entry.figure.isConnected) continue
      reset(subject)
      entries.delete(subject)
      seen.delete(subject)
      const previous = strikes.get(subject)
      strikes.set(subject, {
        count: (previous?.count ?? 0) + 1,
        until: Date.now() + STRIKE_COOLDOWN_MS,
      })
    }
  }

  /** 画一张新的图。 */
  async function paint(target: MermaidTarget, source: string): Promise<void> {
    const subject = target.subject
    const id = `dsh-mermaid-ui-${String(++sequence)}`
    const theme = mode
    try {
      const svg = await renderMermaid(source, theme, id)
      if (!running || !subject.isConnected) return
      // 渲染期间文本又变了：这一张已经过期，交给下一轮。
      if (sourceOf(target) !== source) return
      const figure = ensureFigure(target)
      figure.dataset.mermaidUiTheme = theme
      ensureHost(figure).innerHTML = svg
      subject.setAttribute(STATE_ATTR, 'rendered')
      subject.setAttribute(HIDDEN_ATTR, '')
      entries.set(subject, { source, figure, mode: theme, error: undefined })
      rendered += 1
      if (rendered === 1) console.info(`${LOG} 首个 mermaid 块已渲染成 SVG（${String(svg.length)} 字节）`)
    } catch (error: unknown) {
      if (!running || !subject.isConnected) return
      if (sourceOf(target) !== source) return
      const message = describeError(error)
      const figure = ensureFigure(target)
      figure.dataset.mermaidUiTheme = theme
      figure.replaceChildren()
      const strip = document.createElement('div')
      strip.className = ERROR_CLASS
      strip.setAttribute('role', 'note')
      strip.textContent = `Mermaid 渲染失败：${message}`
      figure.append(strip, ensureHost(figure))
      // 原文必须留在原地：失败时用户看到的是「错误提示 + 原始代码块」，不是空白。
      show(subject)
      subject.setAttribute(STATE_ATTR, 'error')
      entries.set(subject, { source, figure, mode: theme, error: message })
      errors += 1
      console.warn(`${LOG} 渲染失败，已保留原始代码块：${message}`)
    } finally {
      pending.delete(subject)
    }
  }

  /** 主题变了：就地重画，失败保持旧图。 */
  async function repaintAll(next: ThemeMode): Promise<void> {
    for (const [subject, entry] of [...entries]) {
      if (!subject.isConnected || !entry.figure.isConnected) continue
      if (entry.mode === next || pending.has(subject)) continue
      pending.add(subject)
      try {
        const svg = await renderMermaid(entry.source, next, `dsh-mermaid-ui-${String(++sequence)}`)
        if (!running || !subject.isConnected || !entry.figure.isConnected) continue
        entry.figure.dataset.mermaidUiTheme = next
        ensureHost(entry.figure).innerHTML = svg
        entry.mode = next
      } catch (error: unknown) {
        // 保持已经画好的那张：换主题失败不该把内容抹掉。
        console.warn(`${LOG} 主题重画失败，保留旧图：${describeError(error)}`)
      } finally {
        pending.delete(subject)
      }
    }
  }

  function start(): void {
    if (running) return
    running = true
    mode = detectTheme()
    ensureStyle()
    observer = new MutationObserver((records) => {
      // 只有自己造成的变动就不必扫描（自激闸）。注意「删除了东西」永远不能算自己造成的：
      // 图被 React 抹掉正是这一路，吞掉它就再没人把原文放回来。
      const ignorable = records.every((record) => {
        if (isOurs(record.target)) return true
        if (record.removedNodes.length > 0) return false
        return record.addedNodes.length > 0 && [...record.addedNodes].every((node) => isOurs(node))
      })
      if (ignorable) return
      schedule(SCAN_DEBOUNCE_MS)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
    detachTheme = observeTheme((next) => {
      mode = next
      schedule(0)
      void repaintAll(next)
    })
    window.__DSH_MERMAID_UI__ = {
      version: VERSION,
      theme: () => mode,
      stats: () => ({ rendered, errors, tracked: entries.size, theme: mode }),
      rescan: () => { rescan() },
      rerender: () => { void repaintAll(mode) },
    }
    console.info(`${LOG} 就绪 v${VERSION}：开始监视 mermaid 围栏块（主题 ${mode}）`)
    // 首屏可能在插件挂载前就画好了；再在 DOMContentLoaded 后补一次。
    schedule(0)
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { schedule(0) }, { once: true })
    }
  }

  function stop(): void {
    if (!running) return
    running = false
    observer?.disconnect()
    observer = undefined
    detachTheme?.()
    detachTheme = undefined
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    // 卸载即还原：图删掉，原文露回来。
    for (const [subject, entry] of entries) {
      entry.figure.remove()
      reset(subject)
    }
    entries.clear()
    document.querySelector(`style[data-plugin-css="${STYLE_MARKER}"]`)?.remove()
    delete window.__DSH_MERMAID_UI__
  }

  return { start, stop }
}

/** 供客户端半边直接取用的单例工厂别名。 */
export { VERSION as MERMAID_UI_VERSION }
