/**
 * 本包的宿主半边。这个包的实质内容全在浏览器半边，但客户端扫描只处理
 * 「有活动 Loader 行」的包：包名没有行，`dsh.client` 就不会被采集，浏览器半边
 * 永远不会下发。这个空插件就是那一行的落点（同 `@t4r71/dsh-dual-axis-ui`）。
 * @module @t4r71/dsh-mermaid-ui
 */

/** 插件名，loader 诊断用。 */
export const name = 'mermaid-ui'

/** 不做任何事：全部逻辑都由 ./client 那半边承担。 */
export default async function apply(): Promise<void> {}
