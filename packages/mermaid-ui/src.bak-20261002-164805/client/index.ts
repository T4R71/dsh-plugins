/**
 * mermaid 客户端插件的浏览器半边。
 *
 * 只用 DOM：不注入任何 cordis 服务，因此 `inject` 是空表（客户端插件表里的
 * `dsh.client.inject` 也同步是空表）。等齐服务那一套这里用不上，但入口形状与
 * `@t4r71/dsh-dual-axis-ui` 保持一致。
 * @module @t4r71/dsh-mermaid-ui/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createRenderer } from './renderer.ts'

/** 本插件不需要任何客户端服务：它只读文档、只写文档。 */
export const inject: readonly string[] = []

/**
 * 挂载渲染器：观察整篇文档，把 mermaid 围栏块换成 SVG；卸载时还原。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const renderer = createRenderer()
    renderer.start()
    return () => { renderer.stop() }
  }, 'mermaid-ui: markdown mermaid fences')
}
