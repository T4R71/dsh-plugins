/**
 * 本包自带的 tsdown 配置。结构与 packages/plan-tree/tsdown.config.ts 相同，只按本包的
 * 实际入口收窄。
 *
 * 与仓库根配置保持同一套产物契约：
 *   entry  lib/types/index.js                           →  **只有一个入口**
 *   outDir 'lib'                                        →  同；exports["."].default 与 main 都指向 lib/index.js
 *   format ['esm'] / platform 'node' / target 'es2024'  →  同
 *   fixedExtension false                                →  同，产物必须是 .js 而非 .mjs
 *   dts false / clean false                             →  同，声明文件由 tsc -b 产出，tsdown 不得清掉 lib/types
 *
 * **为什么只有一个入口**：历史上这里还有第二个入口 `session-store`，为的是 `cordis.patch.yml`
 * 里一个名叫 `task-runs` 的 Loader 行。那一行在本宿主里**从来没有装载成功过**（profile 里对它
 * 0 命中），于是那个入口、它的 `exports["./session-store"]` 与它自己的 `Config` 都是为一个不存在的
 * 行留的遗迹 —— 2026-10-01 收尾清理一并删掉。账本不需要任何行：它是本包自己的一个 JSON 文件，
 * `src/session-store.ts` 被内联进 lib/index.js，由 `task` 那一行直接调用。
 *
 * 依赖处理：peerDependencies 里的 `@deepseek-ai/*` 一律外部化，产物里保持裸 import 交给宿主解析。
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
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)])

/** 这次构建的产物契约。 */
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
 * 单入口构建：rolldown 不会做代码分割，也就不会额外吐出一个哈希命名的共享 chunk
 * （那种 chunk 不进 package.json 的 files，装上去就是 ERR_MODULE_NOT_FOUND）。
 * 入口取 `tsc -b` 的产物 lib/types/index.js，它把 `./session-store.ts` 一起内联进来。
 */
export default defineConfig([
  { ...shared, name: '@t4r71/dsh-task', entry: { index: 'lib/types/index.js' } },
]) satisfies UserConfig[]
