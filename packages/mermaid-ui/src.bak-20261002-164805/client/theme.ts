/**
 * 主题感知：DSH 的界面主题由 ui-layout 的 theme-presenter 写在
 * `document.documentElement.style.colorScheme`（一手依据：
 * `packages/client/ui-layout/src/client/theme-presenter.ts` 里
 * `document.documentElement.style.colorScheme = scheme`），class / data 属性只是兜底。
 * 这里只回答「现在该用 mermaid 的哪个内置主题」，并在它变化时通知调用方重画。
 * @module @t4r71/dsh-mermaid-ui/client/theme
 */

/** mermaid 内置主题只区分明暗两档。 */
export type ThemeMode = 'dark' | 'light'

/** 主题信号变化到重画之间的合并窗口。 */
const THEME_DEBOUNCE_MS = 120

/** 从 `rgb(r, g, b)` 这类计算值里取相对亮度；取不到返回 undefined。 */
function luminanceOf(color: string): number | undefined {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(color)
  if (match === null) return undefined
  const [, r, g, b, alpha] = match
  if (r === undefined || g === undefined || b === undefined) return undefined
  // 全透明等于没设背景色：这一步判不出来，交给下一档信号（否则默认页面会被判成暗色）。
  if (alpha !== undefined && Number(alpha) === 0) return undefined
  return (0.2126 * Number(r) + 0.7152 * Number(g) + 0.0722 * Number(b)) / 255
}

/**
 * 判定当前界面是明还是暗。
 *
 * 顺序是有意的：主题呈现器写的 `color-scheme` 是权威信号；class/data 属性是第二手；
 * 背景色亮度只是最后的兜底（例如呈现器还没跑起来的首帧）。
 * @returns 当前主题档位。
 */
export function detectTheme(): ThemeMode {
  const root = document.documentElement
  const declared = `${root.style.colorScheme} ${root.getAttribute('data-color-scheme') ?? ''} ${root.getAttribute('data-theme') ?? ''}`.toLowerCase()
  if (/\bdark\b/.test(declared)) return 'dark'
  if (/\blight\b/.test(declared)) return 'light'
  const classes = typeof root.className === 'string' ? root.className.toLowerCase() : ''
  if (/(^|\s)(dark|theme-dark)(\s|$)/.test(classes)) return 'dark'
  if (/(^|\s)(light|theme-light)(\s|$)/.test(classes)) return 'light'
  const body = document.body
  if (body !== null) {
    const luminance = luminanceOf(getComputedStyle(body).backgroundColor)
    if (luminance !== undefined) return luminance < 0.5 ? 'dark' : 'light'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 观察主题变化。
 *
 * 三条来源都要听：`<html>` 上的 style/class/data 属性、以及系统配色偏好
 * （偏好为 system 的档位下，呈现器只改 style，但媒体查询本身也会变）。
 * @param onChange - 主题档位变化时回调（同档位重复变化会被合并掉）。
 * @returns 解除观察的函数。
 */
export function observeTheme(onChange: (mode: ThemeMode) => void): () => void {
  let last = detectTheme()
  let timer: number | undefined
  const settle = (): void => {
    timer = undefined
    const mode = detectTheme()
    if (mode === last) return
    last = mode
    onChange(mode)
  }
  const schedule = (): void => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(settle, THEME_DEBOUNCE_MS)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
  })
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', schedule)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', schedule)
    if (timer !== undefined) window.clearTimeout(timer)
  }
}
