/**
 * mermaid 运行体：**惰性**加载 + 渲染 + 错误归一。
 *
 * 惰性是有意的：mermaid 打进 lib/client.js 后有几 MB，但只要这个会话里没出现过
 * mermaid 围栏，就不该付它的执行开销（`import()` 在打包时被内联，执行推迟到第一次调用）。
 * @module @t4r71/dsh-mermaid-ui/client/mermaid-runtime
 */
import type { ThemeMode } from './theme.ts'

/** 本包用到的 mermaid 面的最小接口（只依赖 initialize / render，不跟版本细节耦合）。 */
export interface MermaidApi {
  /** 合并式配置：每次渲染前按当前主题设一次。 */
  initialize(config: Record<string, unknown>): void
  /** 渲染一段 mermaid 源文本，返回 SVG 字符串。 */
  render(id: string, text: string): Promise<{ svg: string; bindFunctions?: ((element: Element) => void) | undefined }>
}

/** 渲染超时：mermaid 解析死循环（某些畸形输入）时不能把这一块永远挂着。 */
const RENDER_TIMEOUT_MS = 15_000

let loading: Promise<MermaidApi> | undefined

/**
 * 取 mermaid 运行体（同一份只加载一次，失败也不缓存失败结果）。
 * @returns 可用的 mermaid API。
 */
export function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((module) => {
    const candidate = (module as { default?: MermaidApi }).default ?? (module as unknown as MermaidApi)
    if (typeof candidate?.render !== 'function' || typeof candidate.initialize !== 'function') {
      throw new Error('mermaid 模块没有 initialize/render 导出')
    }
    return candidate
  }).catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}

/** 给一个 promise 套超时；超时后原 promise 的结果被丢弃（mermaid 没有取消入口）。 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { reject(new Error(`渲染超时（${ms} ms）`)) }, ms)
    work.then(
      (value) => { window.clearTimeout(timer); resolve(value) },
      (error: unknown) => { window.clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** 清掉 mermaid 渲染失败时可能留在 body 上的临时节点（它自己不一定收得干净）。 */
function dropTemporaries(id: string): void {
  for (const candidate of [id, `d${id}`]) {
    document.getElementById(candidate)?.remove()
  }
}

/**
 * 渲染一段 mermaid 源文本。
 * @param source - 围栏里的原文。
 * @param mode - 当前主题档位。
 * @param id - 本次渲染的 DOM id（同时用作 mermaid 的临时节点名）。
 * @returns SVG 字符串。
 * @throws {Error} 语法错、主题不支持、超时，都会抛；调用方负责把原文留在原地。
 */
export async function renderMermaid(source: string, mode: ThemeMode, id: string): Promise<string> {
  const api = await loadMermaid()
  api.initialize({
    startOnLoad: false,
    // 严格模式：标签里的 HTML 走 DOMPurify，助手写的东西不当作可信 HTML。
    securityLevel: 'strict',
    // 不让 mermaid 自己往页面里塞错误图形：错误提示由本包渲染，原文必须留在原地。
    suppressErrorRendering: true,
    theme: mode === 'dark' ? 'dark' : 'default',
    darkMode: mode === 'dark',
    fontFamily: 'inherit',
  })
  try {
    const result = await withTimeout(api.render(id, source), RENDER_TIMEOUT_MS)
    if (typeof result.svg !== 'string' || result.svg.length === 0) throw new Error('mermaid 没有返回 SVG')
    return result.svg
  } finally {
    dropTemporaries(id)
  }
}

/**
 * 把任意抛出物压成一行可读的错误。
 *
 * mermaid 的解析错误是多行的（`Parse error on line N:` + 源码片段 + `Expecting ...`），
 * 首行只有位置，末行才是「期望什么」，因此两头都留。
 * @param error - 抛出物。
 * @returns 单行短消息。
 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const head = lines[0] ?? '未知错误'
  const tail = lines.length > 1 ? lines[lines.length - 1] ?? '' : ''
  const joined = tail.length > 0 && tail !== head ? `${head} ${tail}` : head
  return joined.length > 240 ? `${joined.slice(0, 237)}…` : joined
}
