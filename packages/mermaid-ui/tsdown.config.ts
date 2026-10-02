/**
 * 双半边的打包配置，形状照抄 `@t4r71/dsh-dual-axis-ui`（同为「宿主空插件 + 浏览器实包」的包）。
 *
 * 浏览器半边必须长成 DSH 客户端模块系统认得的加载器闭包工厂：CJS、单文件
 * `lib/client.js`、外裹 `window.__ModuleLoader__.load({ id, factory })`。这里的差异只有一处：
 * **mermaid 运行体要打进这个文件**（核心渲染器里没有它，模块表也没有这一行），因此
 * `inlineDynamicImports` 必须为真 —— mermaid 11 靠动态 import 惰性加载各图种，若被拆成
 * 独立 chunk，DSH 的 `/plugins/<id>/<file>` 路由并不认识它，运行时就是 404。
 */
import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

const noTsconfig = {
  name: 't4-no-tsconfig',
  options(options: Record<string, unknown>) {
    options.tsconfig = false
    return options
  },
}

/** 浏览器模块表里的平台模块；与 DSH 的 PLATFORM_MODULES 同一份清单。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 平台模块：保持 import；其余跨插件值导入一律是构建错误。 */
const CLIENT_EXTERNALS = new Set(PLATFORM_MODULES)

const id = '@t4r71/dsh-mermaid-ui'

/** 浏览器半边的纯度门禁：跨插件的值导入要么走模块表，要么是构建错误。 */
function purityPlugin() {
  return {
    name: 't4-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.has(source)) return null
      throw new Error(
        'client bundle purity: ' + JSON.stringify(source) + ' 不在默认客户端外部列表或 ' + id
        + ' 的 dsh.client.external 里；跨插件的值导入必须走模块表或 cordis 服务（type-only 导入会被抹掉，不会到这里）',
      )
    },
  }
}

/** Node 半边：普通 ESM，跨包依赖外部化。 */
const nodeHalf = {
  name: id,
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    alwaysBundle: (specifier: string) => !specifier.startsWith('@deepseek-ai/'),
  },
}

/** 浏览器半边：加载器闭包工厂，恰好落在 lib/client.js。 */
const clientHalf = {
  name: id + '/client',
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  // 这个文件每次开页面都要下载：mermaid 全量图种不压缩是 7 MB，压缩后 ~3.5 MB。
  minify: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.has(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: [
        process.env.NODE_ENV === 'development' ? 'development' : 'production',
        'browser', 'import', 'module', 'default',
      ],
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [noTsconfig, purityPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    // mermaid 11 的图种是动态 import：不内联就会落成 DSH 路由不认识的独立 chunk。
    // （rolldown 把 `inlineDynamicImports` 标成弃用，等价的新写法是 codeSplitting: false。）
    codeSplitting: false,
    banner: (chunk: { isEntry: boolean; fileName: string }) => 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id)
      + ', ' + (chunk.isEntry ? '' : 'chunk: ' + JSON.stringify(chunk.fileName) + ', ')
      + 'factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeHalf, clientHalf]
