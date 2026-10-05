/**
 * 把 ask-panel-fix 的浏览器半边打成 `lib/client.js`。
 *
 *   node build.mjs
 *
 * 产物形状由官方 loader 的真实约定决定（已取证）：
 *
 *   app.asar 里 dsh-client-modules 的 materialize() 是
 *       const registered = this.factories.get(id)
 *       const record = { id, exports: registered(this.makeRequire(edges)), … }
 *   即**工厂的返回值就是模块 exports**，loader 只调一次 `factory(require)`，
 *   不注入 `module` / `exports` 绑定。官方 bundle（以及本仓的 mermaid-ui、
 *   effort-slider）因此都在工厂内部自己声明 `var module = { exports: {} }`，
 *   模块体用 `module.exports = {…}` 导出，最后 `return module.exports`。
 *
 * 脚本纪律（全部在内存里跑完才落盘）：
 *   1. 所有断言先跑完，再写临时文件 → 复读校验 → 原子改名；任何一步失败都
 *      **不覆盖**已有产物、不留半成品；
 *   2. 产物必须真的能解析（vm.Script），并且在一个**没有 module / exports 全局、
 *      也没有 document** 的沙箱里按真实约定 `factory(require)` 物化一次 ——
 *      document 故意不提供：模块体必须能安静地跑完（与 mermaid-ui 的沙箱同形）；
 *   3. 反向校验：把内嵌的 CSS 从产物里抠回来，与源码那份逐字比对，并核对
 *      选择器用的确实是数据属性、且没有声明 max-height；
 *   4. 源漂移防线：读取时记指纹，落盘前再读一次，构建期间源码变了就整轮作废。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const PACKAGE_ID = '@t4r71/dsh-ask-panel-fix'
const SOURCE_FILE = here('./src/client.js')
const OUT_FILE = here('./lib/client.js')
const LIB_DIR = here('./lib/')

/** 断言失败即中止：此刻还没有写过任何文件。 */
function assert(condition, label, detail) {
  if (!condition) {
    throw new Error(`[build] 断言失败：${label}${detail === undefined ? '' : `\n        ↳ ${detail}`}`)
  }
  return true
}

const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const bytes = (text) => Buffer.byteLength(text, 'utf8')

/** 行尾归一：Windows 上可能用 core.autocrlf=true 检出（工作区是 CRLF）。 */
const toLf = (text) => text.replace(/\r\n?/g, '\n')

/**
 * 把源码里 `var CSS_TEXT = [ … ].join('\n')` 的**右侧表达式原文**抠出来。
 * 只做切片，不改写 —— 后面交给 VM 真实求值，避免在构建期重新实现一遍
 * 字符串拼接逻辑（那种「实现漂移」会让校验变成自说自话）。
 */
function cssExpressionText(text, label) {
  const head = 'var CSS_TEXT = ['
  const at = text.indexOf(head)
  assert(at >= 0, `${label} 里找不到 var CSS_TEXT = [`)
  assert(text.indexOf(head, at + head.length) === -1, `${label} 里出现多处 CSS_TEXT 定义`)
  const tail = "].join('\\n')"
  const end = text.indexOf(tail, at)
  assert(end > at, `${label} 的 CSS_TEXT 不是 [ … ].join('\\n') 的形状`)
  // 表达式含尾部的 .join('\n')：少了它求值出来是个数组，不是运行时那份样式文本
  return text.slice(at + 'var CSS_TEXT = '.length, end + tail.length)
}

/**
 * 在只绑定三个选择器常量的新 VM 里求值那段 CSS 表达式，拿到**运行时那一份**
 * 样式文本。表达式里若出现别的自由变量，VM 会直接 ReferenceError（响亮失败）。
 */
function evaluateCssExpression(expression, env, label) {
  const script = new vm.Script(
    `(function () {`
    + ` var FRAME_SELECTOR = ${JSON.stringify(env.anchor)};`
    + ` var GUARD_ATTR = ${JSON.stringify(env.guard)};`
    + ` var SCROLL_SELECTOR = ${JSON.stringify(env.scroll)};`
    + ` return ${expression};`
    + ` })()`,
    { filename: `${label} (CSS_TEXT)` },
  )
  const value = script.runInNewContext({})
  assert(typeof value === 'string' && value.length > 0, `${label} 的 CSS_TEXT 求值结果不是非空字符串`)
  return value
}

/**
 * 按真实 loader 的约定执行产物：跑一遍脚本 → 取 bundle factory →
 * 用**恰好一个参数** `factory(require)` 调用，把返回值当模块 exports。
 * 沙箱里**故意不提供** module / exports / document。
 */
function materializeArtifact(artifact, filename) {
  const registrations = []
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  new vm.Script(artifact, { filename }).runInContext(context)

  assert(registrations.length === 1, `产物应当只注册一个 bundle factory，实际 ${registrations.length}`)
  const registration = registrations[0]
  assert(registration.id === PACKAGE_ID, '产物注册的 id 与包名不一致（row id 必须等于包名）', String(registration.id))
  assert(typeof registration.factory === 'function', '产物的 factory 不是函数')

  // 只传 require：多传 module/exports 会把「工厂不自足」这个错误掩盖掉
  const stubRequire = () => { throw new Error('构建期不应真的 require 任何模块') }
  const exported = registration.factory(stubRequire)
  return { exported, context }
}

/* ────────────────────── 1. 读源码 ────────────────────── */

const source = toLf(readFileSync(SOURCE_FILE, 'utf8'))
const manifest = JSON.parse(readFileSync(here('./package.json'), 'utf8'))

/* ────────────────────── 2. 源码前置断言 ────────────────────── */
/* 缺任何一条，产物都会「构建成功但页面上什么都不发生」，所以这里必须炸。 */

assert(manifest.name === PACKAGE_ID, 'package.json 的包名与本脚本的包名不一致', String(manifest.name))
assert(
  manifest.dsh?.client?.platform === 'web',
  'package.json 缺少 dsh.client.platform = "web"：客户端扫描会直接跳过本包',
  JSON.stringify(manifest.dsh?.client),
)
assert(
  manifest.exports?.['./client'] !== undefined,
  'package.json 缺少 exports["./client"]：客户端扫描会抛「declares dsh.client but exports no ./client bundle」',
)
assert(
  manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'package.json 缺少 dsh.bundle.patch：本包会被标成「异常 · not-bundle」，也进不了 profile 的 bundles 列表',
)
assert(
  manifest.files?.includes('lib/client.js'),
  'package.json 的 files 里没有 lib/client.js：发布时会把产物漏掉',
)

/* 三个选择器常量：从源码里读出来，与下面 CSS/产物的断言同源。 */
const SELECTORS = {
  anchor: '[data-question-key]',
  guard: 'data-ask-panel-fix',
  scroll: '[data-question-scroll]',
}
const sourceSelectors = {
  anchor: /var FRAME_SELECTOR = '([^']*)'/.exec(source)?.[1],
  guard: /var GUARD_ATTR = '([^']*)'/.exec(source)?.[1],
  scroll: /var SCROLL_SELECTOR = '([^']*)'/.exec(source)?.[1],
}
assert(
  JSON.stringify(sourceSelectors) === JSON.stringify(SELECTORS),
  '源码里的三个选择器常量与本脚本钉住的契约不一致',
  JSON.stringify(sourceSelectors),
)
const ANCHOR = SELECTORS.anchor
const GUARD_ATTR = SELECTORS.guard
const SCROLL_SELECTOR = SELECTORS.scroll

assert(
  /module\.exports\s*=\s*\{\s*apply\s*:/.test(source),
  'client.js 没有用 module.exports 导出 apply（免全局的导出通道要求模块体自己赋值）',
)
assert(/var\s+inject\s*=\s*\[\]/.test(source), 'client.js 顶层找不到 var inject = [] 声明')
assert(
  !/window\.__DSH_[\w]*__\s*=\s*\{[^}]*apply/.test(source),
  'client.js 疑似又出现了「往 window 上挂导出通道」的写法：重物化不重跑模块体，读全局会拿到陈旧导出',
)

/* 字符卫生：这些字符会破坏脚本标签或 JS 字符串字面量。 */
assert(!/<\/script/i.test(source), 'client.js 含 </script>，会截断脚本标签')
assert(!/[\u2028\u2029]/.test(source), 'client.js 含 U+2028/U+2029，会破坏 JS 字符串字面量')

/* ── CSS 的三条红线（源码那一份）─────────────────────────────────────────
   注意「不许出现哈希类名」**只对 CSS 生效**：源码注释里为了讲清「为什么不用
   类名」会提到 `.mAtvLq_` 这个编译产物标识，那是文档不是选择器。
   这里把 CSS_TEXT 的**表达式原文**交给 VM 真实求值，不在构建期重写一遍
   字符串拼接逻辑 —— 否则校验会与运行时漂移，变成自说自话。 */
const SOURCE_CSS = evaluateCssExpression(cssExpressionText(source, 'src/client.js'), SELECTORS, 'src/client.js')
assert(
  !/\.[A-Za-z][\w-]*_[A-Za-z0-9_-]*/.test(SOURCE_CSS),
  '注入的 CSS 里出现了带哈希前缀的类名选择器（那正是本插件要避开的编译产物标识）',
)
assert(
  SOURCE_CSS.includes(`${ANCHOR} > [${GUARD_ATTR}="card"] {`),
  'CSS 里找不到卡片规则（选择器必须是「数据属性 > 自带属性」的形状）',
)
assert(
  SOURCE_CSS.includes(`${ANCHOR} > [${GUARD_ATTR}="card"] > ${SCROLL_SELECTOR} {`),
  'CSS 里找不到内层滚动容器规则',
)
assert(!SOURCE_CSS.includes('max-height'), 'CSS 不该声明 max-height（要继承官方那份上限）')
assert(!SOURCE_CSS.includes('!important'), 'CSS 不该用 !important（特异性已经足够）')

/* ────────────────────── 3. 生成产物（纯内存，未落盘） ────────────────────── */

const banner = [
  '/* 由 build.mjs 生成，请勿直接编辑；改 src/client.js 后重新构建（node build.mjs）。 */',
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(PACKAGE_ID)},`,
  '  factory: function (require) {',
  // loader 不注入 module：工厂必须自己声明，返回值才是模块 exports（官方 bundle 同形）
  '    var module = { exports: {} };',
  source,
  "    if (module.exports && typeof module.exports.apply === 'function') return module.exports;",
  `    throw new Error(${JSON.stringify(`${PACKAGE_ID}: bundle 未设置导出（require 或模块体有问题）`)});`,
  '  },',
  '});',
  '',
].join('\n')

assert(banner.includes(`id: ${JSON.stringify(PACKAGE_ID)}`), '产物里 bundle id 与包名不一致')
assert(
  banner.indexOf('var module = { exports: {} };') < banner.indexOf('var PACKAGE_ID'),
  '工厂的 var module = { exports: {} }; 必须出现在模块体之前（loader 不注入 module）',
)
assert(banner.includes('bundle 未设置导出'), '产物工厂丢了「导出不对就抛错」的响亮失败分支')

/* ────────────── 4. 产物级校验：真的解析一遍、真的物化一遍 ────────────── */

const PARSED = { ok: false }
try {
  new vm.Script(banner, { filename: 'lib/client.js' })
  PARSED.ok = true
} catch (error) {
  assert(false, '产物无法被 JS 引擎解析，绝不落盘', String(error?.message ?? error))
}

const LOADED = { ok: false, inject: null, applyReal: false }
{
  // document 故意不提供：模块体（含 IIFE 的立即调用）必须在没有 DOM 时也能跑完。
  const { exported } = materializeArtifact(banner, 'lib/client.js')
  assert(exported !== null && typeof exported === 'object', '工厂没有返回 exports 对象')
  assert(typeof exported.apply === 'function', 'exports.apply 不是函数（loader 会拿不到可激活的插件）')
  assert(Array.isArray(exported.inject), 'exports.inject 不是数组', JSON.stringify(exported.inject))
  assert(
    exported.inject.length === 0,
    'exports.inject 应为空表（本插件不注入任何客户端服务）',
    JSON.stringify(exported.inject),
  )
  const applySource = String(exported.apply)
  assert(applySource.includes('createPatcher'), 'exports.apply 不像真身（函数体里没有 createPatcher）')
  assert(applySource.includes('.effect('), 'exports.apply 没有把副作用注册进 ctx.effect（卸载时不会还原）')
  assert(
    applySource.includes('ask-panel-fix: question panel scroll'),
    'exports.apply 的 ctx.effect 标签对不上',
  )
  // 补丁逻辑本身（sweep 在 createPatcher 的闭包里，不在 apply 的函数体文本里）——
  // 所以这条在**产物全文**上判，而不是在 apply 的 toString 上判。
  assert(banner.includes(`'${ANCHOR}'`), '产物里没有定位锚点字面量')
  assert(banner.includes('MutationObserver'), '产物里没挂 MutationObserver（新卡片出现时不会被接管）')
  LOADED.inject = exported.inject
  LOADED.applyReal = true
  LOADED.ok = true
}

/* 反向校验：产物里内嵌的 CSS 必须与源码那份逐字一致（同一套求值路径）。 */
const CSS_CHECK = { ok: false, bytes: 0, rules: 0, identical: false }
{
  const artifactCss = evaluateCssExpression(cssExpressionText(banner, 'lib/client.js'), SELECTORS, 'lib/client.js')
  assert(artifactCss === SOURCE_CSS, '产物里内嵌的 CSS 与源码那份不一致')
  CSS_CHECK.identical = true
  CSS_CHECK.bytes = bytes(artifactCss)
  CSS_CHECK.rules = artifactCss.split('}').length - 1
}

/* ────────────────────── 5. 落盘：临时文件 → 复读校验 → 原子改名 ────────────────────── */

const SOURCE_AT_READ = sha(source)
const SOURCE_NOW = sha(toLf(readFileSync(SOURCE_FILE, 'utf8')))
assert(
  SOURCE_NOW === SOURCE_AT_READ,
  '构建期间源码被改动（有人在并发编辑），本次产物作废、不落盘 —— 请等源码稳定后重跑',
  `读取时 ${SOURCE_AT_READ.slice(0, 16)}；现在 ${SOURCE_NOW.slice(0, 16)}`,
)

mkdirSync(LIB_DIR, { recursive: true })
const previous = existsSync(OUT_FILE) ? toLf(readFileSync(OUT_FILE, 'utf8')) : null
const previousBytes = previous === null ? 0 : bytes(previous)

let writeState
if (previous === banner) {
  writeState = 'unchanged（内容一致，未写盘 —— 幂等）'
} else {
  const tmpFile = `${OUT_FILE}.tmp-${process.pid}`
  try {
    writeFileSync(tmpFile, banner, 'utf8')
    const reread = readFileSync(tmpFile, 'utf8')
    assert(reread === banner, '临时文件复读与内存产物不一致')
    new vm.Script(reread, { filename: 'lib/client.js (tmp)' })
    renameSync(tmpFile, OUT_FILE)
  } catch (error) {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true })
    assert(false, `写入失败（已有产物未被改动，仍是 ${previousBytes} bytes）`, String(error?.message ?? error))
  }
  writeState = `written ${bytes(banner)} bytes（临时文件校验通过 → 原子改名；旧产物 ${previousBytes} bytes）`
}

/* ────────────────────── 6. 摘要 ────────────────────── */

const flag = (on) => (on ? 'yes' : 'no')
console.log(`[build] ${PACKAGE_ID} -> lib/client.js`)
console.log(`  artifact     ${bytes(banner)} bytes  sha256 ${sha(banner)}`)
console.log(`  source       src/client.js ${SOURCE_AT_READ.slice(0, 16)}`)
console.log(`  anchor       ${ANCHOR}   guard ${GUARD_ATTR}   scroll ${SCROLL_SELECTOR}`)
console.log(`  embedded css ${CSS_CHECK.bytes} bytes  ${CSS_CHECK.rules} 条规则  identical to source: ${flag(CSS_CHECK.identical)}`)
console.log(`  css redlines no-hash-class: yes | no-max-height: yes | no-important: yes`)
console.log(`  export       module.exports.apply: ${flag(LOADED.applyReal)} | inject: ${JSON.stringify(LOADED.inject)}`)
console.log(`  checks       parse(vm.Script): ${flag(PARSED.ok)} | materialized as factory(require) w/o document: ${flag(LOADED.ok)} | bundle id: ${PACKAGE_ID}`)
console.log(`  write        ${writeState}`)
