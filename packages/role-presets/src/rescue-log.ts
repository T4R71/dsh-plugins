/**
 * 救援用文件日志 —— 与 ctx 无关，只依赖 node:fs。
 *
 * 为什么不用 ctx.logger：本包此刻的故障症状是「名册里没有角色」，而故障可能发生在
 * **apply 根本没被调用**、**模块根本没被 import**、或 **apply 抛了但日志没进任何
 * 可见通道**这三种完全不同的层次上。ctx.logger 属于宿主，宿主没跑到这一步时它一句
 * 话都不会说；而且它的输出落在哪里取决于宿主怎么配的日志后端，救援现场未必看得到。
 *
 * 所以这里的写入**绕开整个 cordis**：appendFileSync 直写磁盘。日志文件里连
 * 「MODULE LOADED」都没有，就说明模块压根没被 import；有 MODULE LOADED 没有
 * 「ENTER apply」，就说明 import 到了但 apply 没跑（inject 没就绪 / 插件没被挂）。
 *
 * 写入本身**绝不抛**：日志通道坏了不能把插件自己也带崩——那会制造一个比原故障更难
 * 查的二次故障。所有异常一律吞掉。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 日志文件绝对路径。 */
export const LOG_PATH = 'C:\\DSH-RESCUE\\role-presets.log'

/**
 * 追加一行带时间戳的日志。
 * @param event - 事件名（短、大写、可 grep）。
 * @param detail - 附加信息；对象会被 JSON 化。
 */
export function log(event: string, detail?: unknown): void {
  const stamp = new Date().toISOString()
  let tail = ''
  if (detail !== undefined) {
    if (detail instanceof Error) {
      tail = ` ${detail.name}: ${detail.message}\n${detail.stack ?? '(no stack)'}`
    } else if (typeof detail === 'string') {
      tail = ` ${detail}`
    } else {
      try {
        tail = ` ${JSON.stringify(detail)}`
      } catch {
        tail = ` ${String(detail)}`
      }
    }
  }
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `[${stamp}] ${event}${tail}\n`, 'utf8')
  } catch {
    // 日志写不进去不是插件的错，更不能因此中断插件的启动。
  }
}

/** 把任意抛出物连同 stack 变成一段可读文本。 */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n--- stack ---\n${error.stack ?? '(no stack)'}`
  }
  return `(non-Error) ${String(error)}`
}
