/**
 * role-presets —— 把 `.agent-presets` 下 `role-` 开头的角色目录注册进 agent 预设名册。
 *
 * 为什么需要这个包：DSH 0.2.0-rc.2 的 agent-preset 是**注册制，不是扫盘制**。
 * 官方包 `@deepseek-ai/dsh-agent-preset` 全文只做一件事：把一行 YAML 的 config
 * 交给 `ctx.agentPresets.register()`；注册表（dsh-agent-preset-registry）只认
 * 递进来的 definition，**没有任何代码去扫描 `.agent-presets/` 目录**。于是用户
 * 放在那里的 role-recon / role-impl / role-verify 三个目录在名册里根本不存在
 * （名册只有 cordis/minimal/ptc/ptc-custom/standard）——目录是死物。
 *
 * 本包补上缺的那一步：启动时扫目录，逐个调 register()。
 *
 * 一个角色失败（YAML 坏了、register 抛了）只 warn 并继续下一个：三个角色是彼此
 * 独立的资产，一个坏掉不该把其余两个一起拖下水。
 *
 * YAML 解析用自带的 src/yaml.ts 最小实现，零第三方依赖；理由见那个文件的开头。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseYaml } from './yaml.ts'
import type { YamlValue } from './yaml.ts'
import { describe, log, LOG_PATH } from './rescue-log.ts'

// ── 救援埋点（临时）──────────────────────────────────────────────────────────
// 模块顶层就写一行：用来把「模块根本没被 import」和「import 了但 apply 没被调用」
// 这两种故障分开。这一行在 import 求值期同步落盘，不依赖 cordis 的任何东西。
log('MODULE LOADED', {
  pid: process.pid,
  argv1: process.argv[1] ?? null,
  execPath: process.execPath,
  logPath: LOG_PATH,
})


/**
 * 名册服务里本包用到的那一面：**注册一支预设**。
 *
 * 与 `@t4r71/dsh-task` 的 `AgentPresetRosterPort` 同一种写法：本包**不 import**
 * `@deepseek-ai/dsh-agent-preset-registry`。那是宿主的运行时依赖，写进本包的
 * public 类型面会让声明文件生成报 TS2883；而且 rosterless 部署（把预设树整块省掉的
 * 那些）根本没有这个服务，编译期硬依赖会让本包在那些部署里装不上。
 *
 * 所以这里只声明**契约**：id 非空且不重复（重复时实现会抛
 * `Duplicate agent preset: <id>`），返回一个注销函数。
 */
export interface AgentPresetRegistryPort {
  /**
   * 把一支预设登记进名册。
   * @param definition - 预设定义；`plugins` 是普通 cordis 行列表。
   * @returns 注销函数；调用它会把这一条从名册里收回。
   */
  register(definition: {
    /** 预设 id，名册内唯一。 */
    readonly id: string
    /** 名册里显示的名字。 */
    readonly name?: string
    /** 名册里显示的说明。 */
    readonly description?: string
    /** 排序权重；越小越靠前。 */
    readonly order?: number
    /** 行列表，交给 `mountPreset` 挂载。 */
    readonly plugins: readonly unknown[]
  }): Promise<() => void> | (() => void)
}

/** Plugin name, as registered with cordis. */
export const name = 'role-presets'

/**
 * Services this plugin reads.
 *
 * `agentPresets` 是唯一的外部依赖：本包的全部工作就是把磁盘上的目录翻译成
 * `agentPresets.register()` 的调用。
 */
export const inject = ['agentPresets']

/** 角色预设的展示元数据与行列表。 */
export interface Config {
  /**
   * 角色目录的父目录。
   *
   * 默认是用户主目录下的 `.dsh/.agent-presets`，也就是 DSH 自己放预设的地方。
   * 目录不存在不是错误：那只是「这台机器上没有角色预设」，本包静默什么都不做。
   */
  dir?: string
  /**
   * 只有名字以此开头的子目录才算角色预设。
   *
   * 默认 `'role-'`。这个前缀是必需的过滤器而不是装饰：同一个父目录下还有
   * `ptc-custom`、`_audit-conflicts.md` 这类东西，它们有自己的注册通道，
   * 不该被本包重复注册。
   */
  prefix?: string
  /**
   * 名册里这些预设的排序权重；越小越靠前。
   *
   * 单个角色的 `preset.yml` 里若写了 `order`，那个值优先于这里的默认值。
   */
  order?: number
}

/** Validated plugin configuration. */
export const Config: z<Config> = z.object({
  /** 角色目录的父目录；默认 `<home>/.dsh/.agent-presets`。 */
  dir: z.string().default(join(homedir(), '.dsh', '.agent-presets')),
  /** 参与扫描的子目录名前缀。 */
  prefix: z.string().default('role-'),
  /** 未在 preset.yml 里声明 order 时的默认排序权重。 */
  order: z.number().default(10),
})

/** 一个待注册的角色预设。 */
interface Preset {
  /** 预设 id：目录名本身。 */
  readonly id: string
  /** 名册里显示的名字。 */
  readonly name: string
  /** 名册里显示的说明。 */
  readonly description: string
  /** 排序权重。 */
  readonly order: number
  /** cordis 行列表，原样交给注册表。 */
  readonly plugins: YamlValue[]
}

/**
 * 目录名是否是一个合法的 preset id。
 *
 * 与官方发现条件同一条：`[a-z0-9][a-z0-9-]*`。注册表自己也会校验，这里先挡一道
 * 只是为了让 warn 说得更清楚——是「目录名不合法」而不是「注册表抛了」。
 * @param id - 目录名。
 * @returns 合法为 true。
 */
function isValidId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * 把 YAML 顶层值收成行列表。
 * @param value - `agent.cordis.yml` 的顶层值。
 * @param file - 出错时写进消息的文件路径。
 * @returns 行数组。
 * @throws 顶层不是数组、或某个元素不是映射时抛错。
 */
function toPlugins(value: YamlValue, file: string): YamlValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${file}: 顶层必须是行列表（YAML 序列），实际是 ${value === null ? 'null' : typeof value}`)
  }
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${file}: 第 ${index + 1} 行不是一行（期望映射，实际是 ${Array.isArray(entry) ? 'array' : typeof entry}）`)
    }
    const row = entry as { [key: string]: YamlValue }
    if (typeof row['id'] !== 'string' || row['id'] === '') {
      throw new Error(`${file}: 第 ${index + 1} 行缺少非空的 id`)
    }
    if (typeof row['name'] !== 'string' || row['name'] === '') {
      throw new Error(`${file}: 第 ${index + 1} 行（id=${row['id']}）缺少非空的 name`)
    }
  }
  return value
}

/**
 * 读一份可选文件，不存在就返回 null。
 * @param path - 文件绝对路径。
 * @returns 文件内容；不存在或读不动时 null。
 */
async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** `skill-filesystem` 在 agent.cordis.yml 里的行名。 */
const SKILL_FILESYSTEM_PLUGIN = '@deepseek-ai/dsh-skill-filesystem'

/**
 * 把角色目录自己的 `skills/` 交给 `skill-filesystem`。
 *
 * 为什么必须显式给：`@deepseek-ai/dsh-skill-filesystem` 的默认扫描根只有四类 ——
 *   project  `<cwd>/.dsh/skills`、`<cwd>/.agents/skills`
 *   user     `~/.dsh/skills`、`~/.agents/skills`
 *   custom   `customSkillDirs`（**默认空数组**）
 * 角色目录 `~/.dsh/.agent-presets/<角色>/skills/` **不在其中任何一类下**，所以不显式指
 * 就永远发现不了。实测症状是子代理调 `skill` 报 `skill "probe-recon" is unknown`，
 * 重启多少次都一样 —— 源码里那一行是
 * `this.customSkillDirs = (config.customSkillDirs ?? []).map((root) => resolve(root))`，
 * 而 `resolve()` 相对的是**宿主进程的 cwd**，不是角色目录。
 *
 * 只填**没写**的那一种：角色自己配了 `customSkillDirs` 就原样尊重，并留一行日志。
 * 目录里没有 `skills/` 时什么都不做 —— 不给预设塞它用不上的配置。
 * @param plugins - 已解析出的插件行（**就地**修改）。
 * @param dir - 角色目录绝对路径。
 */
async function injectSkillDirs(plugins: YamlValue[], dir: string): Promise<void> {
  const skillsDir = join(dir, 'skills')
  try {
    const info = await stat(skillsDir)
    if (!info.isDirectory()) return
  } catch {
    return
  }
  for (const entry of plugins) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const row = entry as { [key: string]: YamlValue }
    if (row['name'] !== SKILL_FILESYSTEM_PLUGIN) continue
    const raw = row['config']
    const config =
      raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { [key: string]: YamlValue })
        : {}
    if (config['customSkillDirs'] !== undefined) {
      log('skill-filesystem: 角色自己配了 customSkillDirs，不覆盖', { dir })
      return
    }
    row['config'] = { ...config, customSkillDirs: [skillsDir] }
    log('skill-filesystem: 已注入 customSkillDirs', { dir, skillsDir })
    return
  }
}

/**
 * 读一个角色目录，组装出它的 preset definition。
 *
 * 目录里必须有 `agent.cordis.yml`；没有就返回 null（调用方按「跳过并 warn」处理）。
 * `preset.yml` 是可选的，缺了就用 id 兜底当显示名。
 * @param dir - 角色目录绝对路径。
 * @param id - 预设 id（目录名）。
 * @param defaultOrder - preset.yml 没有 order 时的默认权重。
 * @returns 待注册的预设；目录里没有 agent.cordis.yml 时 null。
 * @throws agent.cordis.yml 存在但读不动、解析失败或结构不对时抛错。
 */
async function readPreset(dir: string, id: string, defaultOrder: number): Promise<Preset | null> {
  const agentFile = join(dir, 'agent.cordis.yml')
  const source = await readOptional(agentFile)
  if (source === null) return null

  const plugins = toPlugins(parseYaml(source), agentFile)
  // 角色自己的技能目录要显式交给 skill-filesystem，否则永远发现不了（见函数上的长注释）。
  await injectSkillDirs(plugins, dir)

  let displayName = id
  let description = ''
  let order = defaultOrder
  const metaSource = await readOptional(join(dir, 'preset.yml'))
  if (metaSource !== null) {
    const meta = parseYaml(metaSource)
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
      const record = meta as { [key: string]: YamlValue }
      if (typeof record['name'] === 'string' && record['name'] !== '') displayName = record['name']
      if (typeof record['description'] === 'string') description = record['description']
      if (typeof record['order'] === 'number') order = record['order']
    }
  }

  return { id, name: displayName, description, order, plugins }
}

/**
 * Register every `prefix`-matching role directory under `dir`.
 * @param ctx - cordis context carrying the `agentPresets` service.
 * @param config - validated {@link Config}.
 */
export default async function apply(ctx: Context, config: Config): Promise<void> {
  log('ENTER apply', { hasCtx: ctx !== undefined && ctx !== null, config: config as unknown })
  try {
    return await run(ctx, config)
  } catch (error) {
    // 最关键的一行：apply 自己抛出时，error.message + stack 必须落到文件里。
    // 宿主把 apply 的异常包装成「插件异常」时常常只剩一句摘要，stack 会丢。
    log('!! APPLY THREW (top level)', describe(error))
    throw error
  }
}

/**
 * apply 的实现体。
 *
 * 与 {@link apply} 分开只为了一件事：让整个函数体都处在 try/catch 之内，任何
 * 早退路径之外的意外抛出都能带着 stack 落进救援日志。
 * @param ctx - cordis context。
 * @param config - validated {@link Config}。
 */
async function run(ctx: Context, rawConfig: Config | undefined): Promise<void> {
  // Cordis 对 YAML 里**没写 `config` 键**的行传 `undefined`，而不是 `{}`。
  // 实测症状（2026-10-14，真实装载路径）：
  //   [18:22:53.774] ENTER apply {"hasCtx":true}          ← 没有 config 字段
  //   [18:22:53.813] !! APPLY THREW TypeError: Cannot read properties of undefined (reading 'dir')
  // 这一层兜底让「不给 config」与「给空 config」等价，不依赖调用方怎么写。
  // 注意：schemastery 的 `Config` 默认值只在 Config() 被应用时生效，
  // 而这里拿到的是 loader 原样递进来的对象，所以必须自己归一化。
  const config: Config = rawConfig ?? ({} as Config)
  const dir = config.dir ?? join(homedir(), '.dsh', '.agent-presets')
  const prefix = config.prefix ?? 'role-'
  const defaultOrder = config.order ?? 10
  log('resolve config', { dir, prefix, defaultOrder })

  // ⚠️ 服务就绪不能靠 `export const inject`（实测，见下方注释）。
  // 改走 ctx.inject([...], cb)：回调只在依赖真的就绪时跑一次，
  // 且 cb 收到的 ctx 是**已经带好那些服务**的子上下文。
  // 拿不到就永远不跑 —— 那正是「rosterless 部署」该有的行为。
  const ready = ctx.get('agentPresets') as AgentPresetRegistryPort | undefined
  log('ctx.get("agentPresets") @apply', {
    got: ready !== undefined && ready !== null,
    hasRegister: typeof (ready as { register?: unknown } | undefined)?.register,
  })
  if (ready !== undefined && typeof ready.register === 'function') {
    log('service already live — register now')
    await registerAll(ctx, ready, { dir, prefix, defaultOrder })
    return
  }
  log('service NOT live yet — deferring to ctx.inject()')
  ctx.inject(['agentPresets'], (child: Context) => {
    const registry = child.get('agentPresets') as AgentPresetRegistryPort | undefined
    log('ctx.inject callback fired', {
      got: registry !== undefined && registry !== null,
      hasRegister: typeof (registry as { register?: unknown } | undefined)?.register,
    })
    if (registry === undefined || typeof registry.register !== 'function') {
      log('!! AGENTPRESETS UNAVAILABLE inside inject callback')
      return
    }
    // 回调可以是同步的；异步工作挂出去，异常单独落盘。
    void registerAll(child, registry, { dir, prefix, defaultOrder }).catch((error: unknown) => {
      log('!! registerAll THREW (deferred)', describe(error))
    })
  })
  return
}

/**
 * 一次注册要用的三个已解析参数。
 */
interface ResolvedOptions {
  readonly dir: string
  readonly prefix: string
  readonly defaultOrder: number
}

/**
 * 扫目录并逐个注册：本包真正的逻辑主体。
 *
 * 与 {@link run} 分开是因为它有**两个调用点**——服务已经就绪时 run 直接同步调它，
 * 服务尚未就绪时由 `ctx.inject()` 的回调（拿到带服务的子 ctx 之后）调它。
 *
 * ⚠️ 2026-10-14 实测推翻了原先的假设：`export const inject = ['agentPresets']` 对
 * 函数式插件的 apply 调用时机**不构成保证**。真实装载日志：
 *   ENTER apply {"hasCtx":true,"config":{}}
 *   resolve config {...}
 *   ctx.get("agentPresets") {"got":false,"typeofRegistry":"undefined"}
 *   !! AGENTPRESETS UNAVAILABLE — bail out, nothing registered
 * 即：registry 自己 inject 了 ['loader','sessionProjections']（其构造函数里的
 * super(ctx,'agentPresets') 才是服务名的注册点），那两样没就绪时 registry 行不激活，
 * agentPresets 也就不存在。
 *
 * 取舍：**不**轮询等待（会与宿主的行序赛跑，且没就绪时该不该重试没有可靠判据）。
 * 改为把注册工作交给 `ctx.inject()` 二次挂载——回调只在依赖真的就绪时跑一次，
 * 拿不到就永远不跑，那正是「rosterless 部署」该有的行为。见 {@link run} 的调用点。
 *
 * 名册服务走 ctx.get 取，而不是属性访问：本包没有（也不该有）
 * @deepseek-ai/dsh-agent-preset-registry 的类型依赖，所以 Context 上不存在
 * ctx.agentPresets 这个属性。
 *
 * @param ctx - 带 `agentPresets` 服务的 cordis 上下文（`ctx.effect` 挂在这里）。
 * @param registry - 已经确认可用的名册服务。
 * @param options - 已解析的三个参数。
 */
async function registerAll(
  ctx: Context,
  registry: AgentPresetRegistryPort,
  options: ResolvedOptions,
): Promise<void> {
  const { dir, prefix, defaultOrder } = options

  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
    log('readdir ok', { dir, entries: dirents.map(d => d.name) })
  } catch (error) {
    // 目录不存在是正常状态（这台机器没有角色预设），不是故障。
    log('readdir FAILED', { dir, code: (error as NodeJS.ErrnoException).code, detail: describe(error) })
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    ctx.logger?.warn?.(`role-presets: 读不了目录 ${dir}：${String(error)}`)
    return
  }

  const candidates: string[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    if (!dirent.name.startsWith(prefix)) continue
    const id = dirent.name
    if (!isValidId(id)) {
      log('skip: bad id', { where: join(dir, id) })
      ctx.logger?.warn?.(`role-presets: 跳过 ${join(dir, id)}：目录名不是合法的 preset id（须匹配 [a-z0-9][a-z0-9-]*）`)
      continue
    }
    candidates.push(id)
  }
  candidates.sort()
  log('candidates', { count: candidates.length, ids: candidates })

  for (const id of candidates) {
    const where = join(dir, id)
    log('--- role BEGIN', { id, where })
    try {
      const preset = await readPreset(where, id, defaultOrder)
      if (preset === null) {
        log('role SKIP: no agent.cordis.yml', { where })
        ctx.logger?.warn?.(`role-presets: 跳过 ${where}：目录里没有 agent.cordis.yml`)
        continue
      }
      if (preset.plugins.length === 0) {
        log('role SKIP: empty plugin list', { where })
        ctx.logger?.warn?.(`role-presets: 跳过 ${where}：agent.cordis.yml 里没有任何行`)
        continue
      }
      log('role parsed', { id, name: preset.name, order: preset.order, plugins: preset.plugins })
      const unregister = await registry.register({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        order: preset.order,
        plugins: preset.plugins,
      })
      // 卸载时把名册里这一条收回去，避免热重载后留下孤儿记录。
      ctx.effect(
        () => () => {
          try {
            unregister()
          } catch (error) {
            ctx.logger?.warn?.(`role-presets: 注销 ${preset.id} 失败：${String(error)}`)
          }
        },
        `role-presets: ${preset.id}`,
      )
      log('role REGISTERED ok', { id: preset.id, unregisterType: typeof unregister })
      ctx.logger?.info?.(`role-presets: 已注册 ${preset.id}（${preset.name}，${preset.plugins.length} 行）`)
    } catch (error) {
      // 单个角色失败不能拖垮其他：warn 后继续下一个。
      // 这一行是排查「角色没进名册」的主证据：error.message + stack 全在。
      log(`!! role FAILED ${id}`, describe(error))
      ctx.logger?.warn?.(`role-presets: 注册 ${id} 失败：${String(error)}`)
    } finally {
      log('--- role END', { id })
    }
  }
  log('LEAVE registerAll (normal)', { dir, candidates: candidates.length })
}
