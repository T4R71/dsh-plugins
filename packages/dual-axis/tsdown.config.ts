/**
 * 本包自带的 tsdown 配置。
 *
 * 仓库根的 tsdown.config.ts 用 workspace 列表把 vendor、packages 下的各组、apps/cli 与
 * apps/desktop-host 全部纳入，一次性把它们各自的 tsc 产物再 bundling 成 lib/index.js。
 * 本包是脱离该工作区单独发布的宿主插件包，名字不在那份列表里，因此必须自带配置并以
 * CLI 直接调用 tsdown。
 *
 * 与仓库根配置保持同一套产物契约，只去掉不适用于本包的部分：
 *   entry  ['lib/types/{index,invariant,startup}.js']  →  本包只有 index 与 fs 两个入口，
 *                                                        且 fs 是 exports["./fs"] 指向的独立出口
 *   outDir 'lib'                                       →  同
 *   format ['esm'] / platform 'node' / target 'es2024' →  同
 *   fixedExtension false                                →  同，产物必须是 .js 而非 .mjs，
 *                                                          否则 exports 里的 ./lib/index.js 落空
 *   dts false                                           →  同，声明文件由 tsc -b 产出到 lib/types
 *   clean false                                         →  同，tsdown 不得清掉 tsc 刚写下的 lib/types
 *   plugins [typertPlugin(...)]                         →  去掉，那是本体的类型图生成器，本包不参与
 *   workspace / --env.DSH_BUILD_FACE                    →  去掉，单包构建没有构建面之分
 *
 * 依赖处理：peerDependencies 里的 @deepseek-ai/* 与 zod 一律外部化，产物里保持裸 import
 * 交给宿主解析；本包没有需要内联的第三方运行时依赖。alwaysBundle 对 node: 内建返回 false，
 * 避免把 node:path 这类内建写进产物。
 */
import { builtinModules } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'

/**
 * 关掉 rolldown 侧的 tsconfig 读取：入口是 tsc -b 的产物 lib/types/*.js，里面的相对
 * import 都指向 lib/types 下真实存在的同目录文件，裸依赖一律保持裸 import，因此
 * rolldown 不需要 tsconfig 就能解析完整张图。tsconfig.json 与 tsconfig.base.json 都在
 * 包内，依赖一律由 node_modules 解析，本包不引任何工作区路径。
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
    neverBundle: [/^@deepseek-ai\//, 'zod'],
    alwaysBundle: specifier => !specifier.startsWith('@deepseek-ai/') && !BUILTINS.has(specifier),
  },
}

/**
 * index 与 fs 共用 fs-fence.ts。一次构建两个入口时 rolldown 会做代码分割，额外吐出一个
 * 哈希命名的共享 chunk；而 package.json 的 files 只声明 lib/index.js 与 lib/fs.js，
 * 那个 chunk 不进 tgz，装上去就是 ERR_MODULE_NOT_FOUND。
 *
 * rolldown 不允许「多入口 + codeSplitting: false」，所以拆成两次单入口构建，每次都只解析
 * 一个入口，各自自成闭包；两个入口文件仍然恰好落在 lib/index.js 与 lib/fs.js。
 */

export default defineConfig([
  { ...shared, name: '@t4r71/dsh-dual-axis', entry: { index: 'lib/types/index.js' } },
  { ...shared, name: '@t4r71/dsh-dual-axis/fs', entry: { fs: 'lib/types/fs.js' } },
  { ...shared, name: '@t4r71/dsh-dual-axis/read-guard', entry: { 'read-guard': 'lib/types/read-guard.js' } },
  { ...shared, name: '@t4r71/dsh-dual-axis/session-store', entry: { 'session-store': 'lib/types/session-store.js' } },
])
