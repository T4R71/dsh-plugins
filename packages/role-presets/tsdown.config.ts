/**
 * 本包自带的 tsdown 配置，与 packages/task/tsdown.config.ts 同一套产物契约：
 *   entry  lib/types/index.js  →  outDir 'lib'  →  exports["."].default 与 main 都指向 lib/index.js
 *   format ['esm'] / platform 'node' / target 'es2024' / fixedExtension false
 *   dts false / clean false（声明文件由 tsc -b 产出，tsdown 不得清掉 lib/types）
 *
 * 依赖处理：@deepseek-ai/* 一律外部化，保持裸 import 交给宿主解析；本包没有第三方
 * 运行时依赖（YAML 读取是自带的最小实现），所以 alwaysBundle 只需要挡住 node: 内建。
 */
import { builtinModules } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'

/** 关掉 rolldown 侧的 tsconfig 读取：入口是 tsc -b 的产物，图已完整。 */
const noTsconfig = {
  name: 't4-no-tsconfig',
  options(options: Record<string, unknown>) {
    options.tsconfig = false
    return options
  },
}

/** Node 内建模块：带 node: 前缀的写法与裸写法都算内建。 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)])

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

export default defineConfig([
  { ...shared, name: '@t4r71/dsh-role-presets', entry: { index: 'lib/types/index.js' } },
]) satisfies UserConfig[]
