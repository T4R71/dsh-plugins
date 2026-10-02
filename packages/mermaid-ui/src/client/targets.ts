/**
 * 「哪些 DOM 是 mermaid 围栏块」的唯一答案。三条通道，缺一不可。
 *
 * 一手依据（已打包的 0.2.0-rc.2 实码，从 `resources/app.asar` 里逐字节读出来的）：
 *   - `render.tsx` 的 `renderCode` 把非空围栏交给 `CodeBlock`，并传 `lang`；空的围栏例外，
 *     直接渲染 `<pre><code class="language-mermaid"/></pre>`；
 *   - `CodeBlock` 的根是 `div.md-code-block`，正文永远在 `[data-code-block-content]` 里
 *     （data 属性是组件注释里写明的稳定钩子），正文有两种形态：shiki 的 HTML，或
 *     `<pre class="plain"><code>` 明码；
 *   - `highlight.ts` 的 `LANG_ALIASES` **没有 mermaid**（实测表里 130 条，无此条），于是
 *     mermaid 围栏走明码分支，`<code>` 上不带 `language-mermaid`；
 *   - 头部有两个分支：无 `toolbarLabels` 时是 `div[data-code-block-banner] > div.infostring`
 *     （文案就是语言名）；**聊天走的是另一支** —— ui-chat 的 `markdownLabels` 带
 *     toolbarLabels，于是渲染 `CodeToolbar`，它的语言标签是
 *     `supportsHighlighting(lang) ? lang : labels.codeLabel`，mermaid 不被 shiki 支持，
 *     所以聊天里显示的是通用的「代码」标签，**"mermaid" 这个词根本不进 DOM**。
 *
 * 结论：语言名在聊天里读不到，只能从 React 的 props 上读。三条通道按可靠性排序：
 *   1. 头部出现恰好是 `mermaid` 的文案（无工具栏的 markdown 面）；
 *   2. `code.language-mermaid`（空围栏那一支，以及别的渲染器）；
 *   3. React fiber 上的 `props.lang`（聊天那一支的**唯一**信号）。
 * 第三条只读不写，读不到就退化成「不渲染」，不会误伤别的代码块。
 * @module @t4r71/dsh-mermaid-ui/client/targets
 */

/** 一个待处理/已处理的 mermaid 块。 */
export interface MermaidTarget {
  /** 图插在它后面（`anchor.after(figure)`）。 */
  anchor: Element
  /** 被隐藏的对象，也是源文本的读取对象。 */
  subject: Element
}

/** className 里带 mermaid 语言标记（`language-mermaid` / `lang-mermaid` / `mermaid`）。 */
const MERMAID_CLASS = /(?:^|\s)(?:language-|lang-)?mermaid(?:\s|$)/i

/** fiber 上往上找几层；`CodeBlock` 就是正文节点的父级，留出包装层的余量。 */
const FIBER_DEPTH = 16

/** React 18 挂在 DOM 节点上的 fiber 引用键（`__reactFiber$<随机>`）。 */
function fiberOf(node: Element): unknown {
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      return (node as unknown as Record<string, unknown>)[key]
    }
  }
  return undefined
}

interface FiberLike {
  return?: unknown
  memoizedProps?: unknown
  pendingProps?: unknown
}

/**
 * 从正文节点往上找最近的、`props.lang` 是字符串的那一层组件，读出语言提示。
 * @param node - 正文节点（`[data-code-block-content]`）。
 * @returns 语言提示；读不到返回 undefined。
 */
function fiberLang(node: Element): string | undefined {
  let fiber = fiberOf(node) as FiberLike | undefined
  for (let depth = 0; fiber !== undefined && depth < FIBER_DEPTH; depth += 1) {
    const props = (fiber.memoizedProps ?? fiber.pendingProps) as { lang?: unknown } | undefined
    if (props !== undefined && typeof props.lang === 'string') return props.lang
    fiber = fiber.return as FiberLike | undefined
  }
  return undefined
}

/** 头部文案里有没有恰好是 `mermaid` 的那一格。 */
function bannerSaysMermaid(block: Element): boolean {
  const banner = block.querySelector('[data-code-block-banner]')
  if (banner === null) return false
  for (const candidate of banner.querySelectorAll('span, div')) {
    if (candidate.textContent?.trim().toLowerCase() === 'mermaid') return true
  }
  return false
}

/**
 * 判定一个代码块是不是 mermaid 围栏。
 * @param block - `div.md-code-block`。
 * @param content - 它的 `[data-code-block-content]`。
 * @returns 是 mermaid 围栏则为真。
 */
function isMermaidBlock(block: Element, content: Element): boolean {
  if (bannerSaysMermaid(block)) return true
  if (content.querySelector('code.language-mermaid, code.lang-mermaid') !== null) return true
  return fiberLang(content)?.toLowerCase() === 'mermaid'
}

/**
 * 收集整篇文档里的 mermaid 块。
 * @param root - 搜索根，默认整篇文档。
 * @returns 目标列表；顺序即文档顺序。
 */
export function collectTargets(root: ParentNode = document): MermaidTarget[] {
  const targets: MermaidTarget[] = []
  const taken = new Set<Element>()
  for (const block of root.querySelectorAll<HTMLElement>('div.md-code-block')) {
    const content = block.querySelector<HTMLElement>('[data-code-block-content]')
    if (content === null || !isMermaidBlock(block, content)) continue
    taken.add(content)
    targets.push({ anchor: content, subject: content })
  }
  for (const code of root.querySelectorAll<HTMLElement>('pre > code')) {
    if (!MERMAID_CLASS.test(code.className)) continue
    const pre = code.parentElement
    if (pre === null || taken.has(pre) || pre.closest('div.md-code-block') !== null) continue
    taken.add(pre)
    targets.push({ anchor: pre, subject: pre })
  }
  return targets
}

/**
 * 读一个目标的 mermaid 源文本。
 * @param target - 目标。
 * @returns 围栏内容（明码分支下就是渲染器修剪过的原文）。
 */
export function sourceOf(target: MermaidTarget): string {
  return target.subject.textContent ?? ''
}
