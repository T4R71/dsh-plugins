/**
 * 本包自带的 tsdown 配置。结构与 packages/dual-axis/tsdown.config.ts 相同，只按本包的
 * 实际入口收窄。
 *
 * 与仓库根配置保持同一套产物契约：
 *   entry  lib/types/{index,session-store}.js           →  两个入口
 *   outDir 'lib'                                        →  同；exports["."].default 指向 lib/index.js，
 *                                                          exports["./session-store"].default 指向 lib/session-store.js
 *   format ['esm'] / platform 'node' / target 'es2024'  →  同
 *   fixedExtension false                                →  同，产物必须是 .js 而非 .mjs
 *   dts false / clean false                             →  同，声明文件由 tsc -b 产出，tsdown 不得清掉 lib/types
 *
 * session-store 必须是**独立入口**：它是一个独立的 Loader 行
 * （\`cordis.patch.yml\` 里的 \`plan-tree-sessions\`），行名要解析到 lib/session-store.js。它同时
 * 也被 index 入口内联进 lib/index.js —— 两个入口各自自成闭包，只有两行都装载时才有两份
 * 模块实例，而这两行之间不共享任何可变状态（Config 与空 apply 都是常量）。
 *
 * 依赖处理：peerDependencies 里的 @deepseek-ai/* 一律外部化，产物里保持裸 import 交给宿主解析。
 * alwaysBundle 对 node: 内建返回 false，避免把 node:path 这类内建写进产物。
 */
import { builtinModules } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'

/**
 * 关掉 rolldown 侧的 tsconfig 读取：入口是 tsc -b 的产物 lib/types/*.js，其中的相对
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

/** 两个入口共用的产物契约。 */
const shared: UserConfig = {
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
}

/**
 * 一次构建两个入口时 rolldown 会做代码分割，额外吐出一个哈希命名的共享 chunk；而
 * package.json 的 files 只声明 lib/index.js 与 lib/session-store.js，那个 chunk 不进 tgz，
 * 装上去就是 ERR_MODULE_NOT_FOUND。rolldown 不允许「多入口 + codeSplitting: false」，
 * 所以拆成两次单入口构建，每次都只解析一个入口，各自自成闭包。
 */
export default defineConfig([{ ...shared, name: '@t4r71/dsh-team-tree', entry: { index: 'lib/types/index.js' } }]) satisfies UserConfig[]
