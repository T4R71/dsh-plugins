/**
 * 本包的宿主半边。这个包的实质内容全在浏览器半边，但 0.1.7 的客户端扫描只处理
 * 「有活动 Loader 行」的包：包名没有行，`dsh.client` 就不会被采集成客户端行，
 * 浏览器半边永远不会下发。这个空插件就是那一行的落点。
 * @module @t4r71/dsh-dual-axis-ui
 */

/** 插件名，loader 诊断用。 */
export const name = 'dual-axis-ui'

/** 不做任何事：两个界面面都由 ./client 那半边承担。 */
export default async function apply(): Promise<void> {}
