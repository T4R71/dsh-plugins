/**
 * 双轴访问模式组合包的浏览器半边：把这一条能力的两个界面面合成一个客户端插件。
 *
 * 为什么是一个插件而不是两个：0.1.7 的客户端模块系统里，客户端行 id 就是包名
 * （client/modules/src/client/manifest.ts 的 WebBootEntry.id），`dsh.client` 是单个对象，
 * `stripClientSuffix` 只剥掉结尾的 /client —— 一个 npm 包因此只能带一个客户端半边。
 * 两个界面面（设置页那一行、输入框上方的两个下拉）于是共用这一次 apply。
 *
 * @module @t4r71/dsh-dual-axis/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply as applyPermission, inject as permissionInject } from './permission/index.ts'
import { apply as applyRow, inject as rowInject } from './row/index.ts'

/*
 * 两份 inject 的并集：客户端插件在装载期等齐两个界面面各自要的服务，
 * 少一项就会让其中一面在挂载时读不到服务。
 */
export const inject = [...new Set([...permissionInject, ...rowInject])]

/**
 * 挂载两个界面面：下拉那面先挂（它注册会话输入区的 slot 与词典），配置行那面随后。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  applyPermission(ctx)
  applyRow(ctx)
}
