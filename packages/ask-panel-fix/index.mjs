/**
 * ask-panel-fix 的宿主半边。
 *
 * **空插件，这是有意为之**：本包的全部工作在浏览器侧（DOM 后处理 + 注入 CSS）。
 * 这一行的唯一职责是让 `dsh-client-modules` 的增量扫描采集到本包的 `dsh.client`
 * 声明 —— 客户端扫描只认「有活动 Loader 行」的包（读该行的包根、检查
 * `dsh.client.platform === 'web'` 且 `exports['./client']` 存在），所以没有
 * 这一行，`lib/client.js` 永远不会被下发到浏览器。
 *
 * 因此：不注册任何服务、不订阅任何事件、不读配置、不抛错。
 * 连 `inject` 都不声明 —— 空插件声明了服务反而有让 fiber 停在 PENDING 的风险。
 */

/** 什么也不做。 */
export function apply() {}
