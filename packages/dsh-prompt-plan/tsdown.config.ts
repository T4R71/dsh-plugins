/**
 * 本包自带的 tsdown 配置。
 *
 * 与 dual-axis 的约定逐条对齐（entry 换成本包唯一的 index，其余保持不变）：
 *   entry  lib/types/index.js  →  本包只有 index 一个入口
 *   outDir 'lib' / format ['esm'] / platform 'node' / target 'es2024' / fixedExtension false
 *   dts false（声明文件由 tsc -b 产出到 lib/types）/ clean false（tsdown 不得清掉 tsc 的产物）
 *   sourcemap false，plugins [noTsconfig]（入口是 tsc 产物，rolldown 不需要 tsconfig）
 *
 * 依赖处理：peerDependencies 里的 @deepseek-ai/* 外部化，产物保持裸 import 交给宿主解析；
 * node: 内建返回 false，不写进产物。
 */
import { builtinModules } from 'node:module'
import { defineConfig, type UserConfig } from 'tsdown'

/** 关掉 rolldown 侧的 tsconfig 读取：入口是 tsc -b 的产物 lib/types/index.js。 */
const noTsconfig = {
  name: 't4-no-tsconfig',
  options(options: Record<string, unknown>) {
    options.tsconfig = false
    return options
  },
}

/** Node 内建模块：带 node: 前缀的写法与裸写法都算内建。 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])

const config: UserConfig = {
  name: '@t4r71/dsh-prompt-plan',
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
}

export default defineConfig([config])
