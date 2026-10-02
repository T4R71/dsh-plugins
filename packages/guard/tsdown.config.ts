/**
 * 本包自带的 tsdown 配置。结构与 packages/stream-guard/tsdown.config.ts 相同，只按本包
 * 的实际入口收窄。
 *
 * 与仓库根配置保持同一套产物契约：
 *   entry  ['lib/types/index.js']                       →  本包只有一个入口
 *   outDir 'lib'                                        →  同；exports["."].default 指向 lib/index.js
 *   format ['esm'] / platform 'node' / target 'es2024'  →  同
 *   fixedExtension false                                →  同，产物必须是 .js 而非 .mjs
 *   dts false / clean false                             →  同，声明文件由 tsc -b 产出，tsdown 不得清掉 lib/types
 *
 * 依赖处理：peerDependencies 里的 @deepseek-ai/* 一律外部化，产物里保持裸 import 交给宿主解析。
 * alwaysBundle 对 node: 内建返回 false，避免把 node:path 这类内建写进产物。
 */
import { builtinModules } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'

/**
 * 关掉 rolldown 侧的 tsconfig 读取：入口是 tsc -b 的产物 lib/types/index.js，其中的相对
 * import 都指向同目录下真实存在的文件，裸依赖一律保持裸 import，因此 rolldown 不需要
 * tsconfig 就能解析完整张图。
 */
const noTsconfig = {
  name: 't4-no-tsconfig',
  options(options: Record<string, unknown>) {
    options.tsconfig = false
    return options
  },
}

/** Node 内建模块：带 node: 前缀的写法与裸写法都算内建。 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

export default defineConfig({
  name: '@t4r71/dsh-guard',
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
  plugins: [noTsconfig],
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    alwaysBundle: specifier => !specifier.startsWith('@deepseek-ai/') && !BUILTINS.has(specifier),
  },
} satisfies UserConfig)
