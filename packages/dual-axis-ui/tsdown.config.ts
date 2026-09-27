import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'

const noTsconfig = {
  name: 't4-no-tsconfig',
  options(options: Record<string, unknown>) {
    options.tsconfig = false
    return options
  },
}

/** 包内 tsc 产物与它被编译出来的源码之间的分界段。 */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** 浏览器模块表里的平台模块；与 DSH 的 PLATFORM_MODULES 同一份清单。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** 本包在 dsh.client.external 里额外申请的模块表行；当前没有额外的。 */
const REQUESTED_EXTERNALS = []

/** 平台模块 + 本包申请的行：这些保持 import，其余跨插件值导入一律是构建错误。 */
const CLIENT_EXTERNALS = new Set([...PLATFORM_MODULES, ...REQUESTED_EXTERNALS])

const id = '@t4r71/dsh-dual-axis-ui'

const CSS_VIRTUAL_PREFIX = '\0t4-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 生成一个「注入 style 标签 + 导出类名映射」的虚拟模块。 */
function styleInjectionModule(pluginId, fileId, css, classMap) {
  const source = [
    'const css = ' + JSON.stringify(css) + ';',
    'const tagId = ' + JSON.stringify(pluginId + '/' + basename(fileId)) + ';',
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    '  tag.dataset.plugin = ' + JSON.stringify(pluginId) + ';',
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : 'export default ' + JSON.stringify(classMap) + ';')
  return source.join('\n')
}

/**
 * 解析 .module.css 的真实路径。
 *
 * tsc 只把样式表当类型引用，不会把它复制进 lib/types，所以从 lib/types/**.js 里读到的
 * `./X.module.css` 在那个目录下并不存在。这里把命中 `lib/types` 的路径折回源码树，
 * 与 DSH 本体 tsdown.client.ts 的 sourceAssetPath 同一条规则。
 * @param source - import 里写的路径。
 * @param importer - 发起 import 的产物文件。
 * @returns 样式表在源码树里的绝对路径。
 */
function cssFileOf(source, importer) {
  if (isAbsolute(source)) return source
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

/** 浏览器半边的插件：CSS Modules 就地编译。 */
function cssModulesPlugin() {
  return {
    name: 't4-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      return CSS_VIRTUAL_PREFIX + cssFileOf(source, importer ?? source) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0))) {
        classMap[local] = exp.name
      }
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }
}

/** 浏览器半边的纯度门禁：跨插件的值导入要么走模块表，要么是构建错误。 */
function purityPlugin() {
  return {
    name: 't4-client-bundle-purity',
    resolveId(source) {
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
    alwaysBundle: specifier => !specifier.startsWith('@deepseek-ai/'),
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
  clean: false,
  deps: {
    neverBundle: specifier => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: specifier => !CLIENT_EXTERNALS.has(specifier),
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
  plugins: [noTsconfig, purityPlugin(), cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: chunk => 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(id)
      + ', ' + (chunk.isEntry ? '' : 'chunk: ' + JSON.stringify(chunk.fileName) + ', ')
      + 'factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}


export default [nodeHalf, clientHalf]
