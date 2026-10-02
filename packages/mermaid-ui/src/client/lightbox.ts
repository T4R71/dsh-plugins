/**
 * 点击放大：覆盖层（lightbox）自己建 DOM、自己收拾。
 *
 * 三条纪律：
 *   1. **不依赖任何官方组件**：覆盖层是这里 createElement 出来的，DSH 换 UI 包也不影响它；
 *   2. **关掉就是关掉**：节点、监听、`<html>` 上的内联样式全部还原，body 上不留残留
 *      （验证用例直接数 `[data-mermaid-ui-lightbox]` 的个数，以及 body 子节点数前后相等）；
 *   3. **主题跟随当前的 `colorScheme`**：和渲染器同一路信号，切主题时覆盖层开着也当场换。
 *
 * 内容的做法是**用大尺寸重渲染一份 mermaid**，不是缩放主图里的那张 SVG：
 * 主图为了撑满聊天宽度是等比放大的，直接把它 CSS 放大只会得到一张放大的低分辨率图；
 * 重渲染一张宽高都更大的，才真的能看清细节（代价是关的时候要把这份新 SVG 丢掉）。
 * @module @t4r71/dsh-mermaid-ui/client/lightbox
 */
import type { ThemeMode } from './theme.ts'
import { describeError, renderMermaid } from './mermaid-runtime.ts'

/** 覆盖层根节点的标记属性（也是验证时唯一的计数器）。 */
export const LIGHTBOX_ATTR = 'data-mermaid-ui-lightbox'

/** 覆盖层里放图的那一层。 */
const STAGE_ATTR = 'data-mermaid-ui-lightbox-stage'
/** 放大后这张图愿用的宽度上限（px），实际取「视口宽 - 边距」与它的较小值。 */
const DIALOG_WIDTH_MAX = 1360
/** 放大后这张图愿用的高度上限（px）——纵向图不能顶破屏幕。 */
const DIALOG_HEIGHT_MAX = 900
/** 覆盖层四周留白（每边）。 */
const GUTTER = 48
/** 拖动平移的位移上限（px）：拖再远也不至于把图拖出视野。 */
const PAN_MAX = 400
/** 拖动方向判定的死区（px）。 */
const PAN_DEADZONE = 3
/** 图片尺寸与页面尺寸的比值：差得不多就不重渲染，直接复用主图那张。 */
const ZOOM_RATIO = 1.15

/** 当前打开的覆盖层；没有时为 undefined。同一时刻只允许一个。 */
let active: { close: () => void } | undefined

/** 视口里还能留给图多大地方。 */
function viewportBox(): { width: number; height: number } {
  const width = Math.max(240, Math.min(DIALOG_WIDTH_MAX, window.innerWidth - GUTTER * 2))
  const height = Math.max(180, Math.min(DIALOG_HEIGHT_MAX, window.innerHeight - GUTTER * 2))
  return { width: Math.floor(width), height: Math.floor(height) }
}

/** 主图那张 SVG 的**固有**尺寸（viewBox 的宽高，mermaid 的 svg 一定带 viewBox）。 */
function intrinsicSize(host: HTMLElement | null): { width: number; height: number } | undefined {
  const svg = host?.querySelector('svg')
  const box = svg?.getAttribute('viewBox')?.trim().split(/[\s,]+/)
  if (box === undefined || box.length !== 4) return undefined
  const width = Number(box[2])
  const height = Number(box[3])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

/** 覆盖层的样式表（只注入一次，跟着标记属性走，卸载时一起删）。 */
const LIGHTBOX_CSS = `[${LIGHTBOX_ATTR}]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.62);cursor:zoom-out}
[${LIGHTBOX_ATTR}][data-scheme="light"]{background:rgba(255,255,255,.88)}
[${LIGHTBOX_ATTR}]>[${STAGE_ATTR}]{max-width:100%;max-height:100%;overflow:auto;border-radius:10px;background:#fff;padding:16px;cursor:grab;box-shadow:0 12px 40px rgba(0,0,0,.35)}
[${LIGHTBOX_ATTR}][data-scheme="dark"]>[${STAGE_ATTR}]{background:#22262c}
[${LIGHTBOX_ATTR}][data-scheme="dark"]>[${STAGE_ATTR}]>svg{background:#22262c}
[${LIGHTBOX_ATTR}]>[${STAGE_ATTR}][data-panning="true"]{cursor:grabbing}
[${LIGHTBOX_ATTR} svg]{display:block;max-width:none;height:auto}
[${LIGHTBOX_ATTR}]>[${STAGE_ATTR}]>[data-mermaid-ui-lightbox-note]{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.75;padding:8px 4px;max-width:640px}`

/** 注入覆盖层样式（幂等）。 */
function ensureLightboxStyle(): void {
  if (document.querySelector(`style[data-mermaid-ui-lightbox-css]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = '@t4r71/dsh-mermaid-ui'
  style.dataset.mermaidUiLightboxCss = ''
  style.textContent = LIGHTBOX_CSS
  document.head.append(style)
}

/**
 * 打开覆盖层；已经开着就先关掉再开（同一时刻只有一个）。
 * @param source - mermaid 源文本（从渲染器登记里拿，不用再读 DOM）。
 * @param mode - 当前主题档位。
 */
export function openLightbox(source: string, mode: ThemeMode): void {
  closeLightbox()
  ensureLightboxStyle()

  const root = document.createElement('div')
  root.setAttribute(LIGHTBOX_ATTR, '')
  root.setAttribute('data-scheme', mode)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', '放大的 mermaid 图')

  const stage = document.createElement('div')
  stage.setAttribute(STAGE_ATTR, '')
  root.append(stage)

  /** 本次开合挂上去的东西，关的时候逐条摘。 */
  const listeners: { target: EventTarget; type: string; handler: EventListener; options: AddEventListenerOptions | undefined }[] = []
  const listen = (target: EventTarget, type: string, handler: EventListener, options?: AddEventListenerOptions): void => {
    target.addEventListener(type, handler, options)
    listeners.push({ target, type, handler, options })
  }
  const rootBefore = document.documentElement.style.colorScheme
  const bodyOverflow = document.body.style.overflow
  /** 主题观察员：先建出来，关的时候一起断。 */
  const themeObserver = new MutationObserver(() => {
    root.setAttribute('data-scheme', detectScheme())
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme'] })
  let closed = false

  const close = (): void => {
    if (closed) return
    closed = true
    themeObserver.disconnect()
    for (const item of listeners) item.target.removeEventListener(item.type, item.handler, item.options)
    listeners.length = 0
    root.remove()
    document.documentElement.style.colorScheme = rootBefore
    document.body.style.overflow = bodyOverflow
    if (active?.close === close) active = undefined
  }
  active = { close }

  // 点背景/点图都关（覆盖层里没有别的可点对象，避免做成一个迷你应用）。
  listen(root, 'click', (() => { close() }) as EventListener)
  listen(document, 'keydown', ((event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
  }) as EventListener, { capture: true })

  // 拖动平移：够读大字/长图，成本只有一组 pointer 监听。
  let panning = false
  let panStart = { x: 0, y: 0 }
  let panBase = { x: 0, y: 0 }
  let pan = { x: 0, y: 0 }
  const applyPan = (): void => {
    const x = Math.max(-PAN_MAX, Math.min(PAN_MAX, pan.x))
    const y = Math.max(-PAN_MAX, Math.min(PAN_MAX, pan.y))
    stage.style.transform = `translate(${String(x)}px, ${String(y)}px)`
    stage.dataset.panning = panning ? 'true' : 'false'
  }
  listen(stage, 'pointerdown', ((event: PointerEvent) => {
    if (event.button !== 0) return
    panning = true
    panStart = { x: event.clientX, y: event.clientY }
    panBase = { ...pan }
    applyPan()
  }) as EventListener)
  listen(stage, 'pointermove', ((event: PointerEvent) => {
    if (!panning) return
    const dx = event.clientX - panStart.x
    const dy = event.clientY - panStart.y
    if (Math.abs(dx) < PAN_DEADZONE && Math.abs(dy) < PAN_DEADZONE) return
    pan = { x: panBase.x + dx, y: panBase.y + dy }
    applyPan()
  }) as EventListener)
  const endPan = (): void => { panning = false; applyPan() }
  listen(stage, 'pointerup', endPan as EventListener)
  listen(stage, 'pointercancel', endPan as EventListener)

  document.body.append(root)
  applyPan()

  void paintZoomed(stage, source, mode)
  // 覆盖层不需要焦点也能收 Esc（document 捕获阶段），但把焦点挪进来更接近常规对话框。
  root.tabIndex = -1
  root.focus({ preventScroll: true })
}

/** 当前明暗档位（只读 `colorScheme`，与渲染器同一路信号）。 */
function detectScheme(): string {
  const declared = `${document.documentElement.style.colorScheme} ${document.documentElement.getAttribute('data-theme') ?? ''}`.toLowerCase()
  if (/\bdark\b/.test(declared)) return 'dark'
  if (/\blight\b/.test(declared)) return 'light'
  return 'light'
}

/**
 * 出图（或换主题重画）之后按实测像素密度定覆盖层的宽度。
 *
 * 两种走向，都用**实测**的 `getBoundingClientRect()` 判断，不靠猜：
 *   - 图比可用空间小：放大到铺满可用宽/高（等比、取更紧的那个），看得清；
 *   - 图比可用空间大（宽图，例如横向 2000px 的流程图）：保持 1:1 原始像素，
 *     覆盖层交给 `overflow:auto` 滚动 + 拖动平移，而不是把它缩到看不清。
 * @param stage - 放图的容器。
 * @param svg - 舞台里的 SVG，可能不存在。
 */
function fitStage(stage: HTMLElement, svg: SVGElement | null): void {
  if (svg === null) return
  const box = viewportBox()
  const rect = svg.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const fit = Math.min(box.width / rect.width, box.height / rect.height)
  if (fit > 1.02) {
    stage.style.width = `${String(Math.round(box.width))}px`
    stage.style.height = `${String(Math.round(box.height))}px`
  } else {
    stage.style.width = ''
    stage.style.height = ''
  }
}

/**
 * 把大图放进覆盖层。够大就复用主图那张 SVG（不白花一次渲染），
 * 否则按覆盖层可用尺寸重渲染一份。重渲染失败就退回主图那张，绝不留一块空的覆盖层。
 * @param stage - 放图的容器。
 * @param source - mermaid 源文本。
 * @param mode - 主题档位。
 */
async function paintZoomed(stage: HTMLElement, source: string, mode: ThemeMode): Promise<void> {
  const figure = document.querySelector('[data-mermaid-ui-figure]')
  const host = figure?.querySelector<HTMLElement>('[data-mermaid-ui-svg]') ?? null
  const current = host?.querySelector('svg') ?? null
  const box = viewportBox()
  const intrinsic = intrinsicSize(host)
  const needed = intrinsic === undefined
    ? box
    : {
        width: Math.round(Math.min(box.width, intrinsic.width * ZOOM_RATIO)),
        height: Math.round(Math.min(box.height, intrinsic.height * ZOOM_RATIO)),
      }

  if (current !== null && intrinsic !== undefined && needed.width <= Math.round(intrinsic.width * ZOOM_RATIO)) {
    stage.append(current.cloneNode(true))
    fitStage(stage, stage.querySelector('svg'))
    return
  }

  try {
    const svg = await renderMermaid(source, mode, `dsh-mermaid-ui-zoom-${String(Date.now())}`)
    stage.style.width = `${String(needed.width)}px`
    stage.innerHTML = svg
    // 重渲染出来的 svg 自带 width:100%/max-width:<自然宽>：先按算好的宽度铺满。
    const svgElement = stage.querySelector('svg')
    if (svgElement !== null) {
      svgElement.style.width = '100%'
      svgElement.style.maxWidth = '100%'
      svgElement.style.height = 'auto'
    }
    fitStage(stage, svgElement)
  } catch (error: unknown) {
    if (current !== null) stage.append(current.cloneNode(true))
    fitStage(stage, stage.querySelector('svg'))
    const note = document.createElement('div')
    note.setAttribute('data-mermaid-ui-lightbox-note', '')
    note.textContent = `大图重渲染失败，显示的是主图：${describeError(error)}`
    stage.append(note)
  }
}

/** 关掉覆盖层（没开时什么也不做）；Esc/点击/再点图都走这里。 */
export function closeLightbox(): void {
  active?.close()
  active = undefined
}

/** 连同样式表一起收掉；插件卸载用它，`closeLightbox()` 只关当前这一层。 */
export function disposeLightbox(): void {
  closeLightbox()
  document.querySelector('style[data-mermaid-ui-lightbox-css]')?.remove()
}

/** 覆盖层是不是开着（验证用）。 */
export function lightboxOpen(): boolean {
  return document.querySelector(`[${LIGHTBOX_ATTR}]`) !== null
}
