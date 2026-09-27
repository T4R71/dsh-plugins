import { accessEn, en } from './locales.ts'

/**
 * One access axis. The 0.1.7 workspace's permission domain exports only the
 * whole-value preset catalog (`PermissionCatalog` / `PermissionSelection`), so
 * the two-axis vocabulary is owned here rather than imported.
 */
export type PermissionAxis = 'read' | 'write'

/** A selectable value on one axis. */
export type PermissionAxisValue = 'deny' | 'workspace' | 'all' | 'custom'

/**
 * One axis as the host half publishes it on the wire: the kind, plus the custom
 * detail when the kind is custom. The client's own model keeps only the kind,
 * so this is the wire's JSON shape rather than a second axis vocabulary.
 */
export interface DualAxisAxisWire {
  kind: string
  base?: string
  /**
   * Ids of the rule groups this axis references, in reference order.
   *
   * Declared here because the stored record carries them and the editor reads
   * them back as its initial selection: omitting the member would make a group
   * pick look like it never happened on the next open.
   */
  groups?: readonly string[]
  allow?: readonly string[]
  deny?: readonly string[]
}

/**
 * The session's two axes, as the host half stores them in the settings document
 * (`dual-axis-sessions`, partitioned by session id). Not a session projection
 * value any more: the axes are outside the session log, so the shape here is the
 * stored JSON rather than a wire view.
 */
export interface DualAxisAxesWire {
  readonly read: DualAxisAxisWire
  readonly write: DualAxisAxisWire
  /**
   * What the read axis removed from the write range, as the HOST's resolution
   * computed it (`resolveEffectiveAxes` in `@t4r71/dsh-dual-axis`), or
   * `undefined` when the record carries no report — a record written before this
   * member existed, or one the intersection left alone.
   *
   * Published rather than re-derived here: the host's resolution canonicalizes
   * every root with `realpath` and derives a `workspace` base from
   * `os.tmpdir()`, so a browser cannot reproduce its root list. A surface that
   * reports a narrowing the fence does not enforce — or misses one it does — is
   * worse than one that reports nothing.
   */
  readonly narrowing?: DualAxisNarrowingWire
}

/**
 * The host's report of what the read axis removed from the write range.
 *
 * Mirrors `WriteNarrowing` in `@t4r71/dsh-dual-axis/src/groups.ts`; that
 * module is the producer and this is only the JSON spelling the document carries.
 */
export interface DualAxisNarrowingWire {
  /** Whether the read axis makes the effective write range strictly smaller. */
  readonly narrowed: boolean
  /**
   * Absolute roots the write axis permitted and the effective range does not,
   * already canonicalized by the host.
   */
  readonly droppedRoots: readonly string[]
  /** Whether an unbounded write axis became bounded, which no root list states. */
  readonly lostUnbounded: boolean
}

/** Every value the axes offer, in the dropdowns' display order. */
const AXIS_VALUES: readonly PermissionAxisValue[] = ['deny', 'workspace', 'all', 'custom']

/**
 * Narrow one axis's wire kind to a value the dropdowns can show.
 * @param kind - the kind field as it arrives on the wire.
 * @returns one of the four values, or undefined when the kind is unrecognized.
 */
export function axisValueOf(kind: string): PermissionAxisValue | undefined {
  return (AXIS_VALUES as readonly string[]).includes(kind)
    ? kind as PermissionAxisValue
    : undefined
}

/**
 * Locale dictionary key for one axis value's label. Every value states its own
 * axis except `custom`, whose editor says which axis it belongs to — the two
 * pickers have no visible caption beside them, so the copy has to carry it.
 */
export type AxisLabelKey =
  | 'axis.read.deny'
  | 'axis.read.workspace'
  | 'axis.read.all'
  | 'axis.write.deny'
  | 'axis.write.workspace'
  | 'axis.write.all'
  | 'axis.custom'
  | 'axis.unknown'

const AXIS_LABEL_KEYS: Record<PermissionAxis, Record<PermissionAxisValue, AxisLabelKey>> = {
  read: {
    'deny': 'axis.read.deny',
    'workspace': 'axis.read.workspace',
    'all': 'axis.read.all',
    'custom': 'axis.custom',
  },
  write: {
    'deny': 'axis.write.deny',
    'workspace': 'axis.write.workspace',
    'all': 'axis.write.all',
    'custom': 'axis.custom',
  },
}

/** English fallback per axis label, read from the dictionary that owns the copy. */
const DEFAULT_AXIS_LABELS: Record<AxisLabelKey, string> = {
  'axis.read.deny': accessEn['axis.read.deny'],
  'axis.read.workspace': accessEn['axis.read.workspace'],
  'axis.read.all': accessEn['axis.read.all'],
  'axis.write.deny': accessEn['axis.write.deny'],
  'axis.write.workspace': accessEn['axis.write.workspace'],
  'axis.write.all': accessEn['axis.write.all'],
  'axis.custom': accessEn['axis.custom'],
  'axis.unknown': accessEn['axis.unknown'],
}

/** Locale dictionary key for a built-in permission preset label. */
export type PermissionPresetLabelKey =
  | 'preset.readOnly'
  | 'preset.workspaceWrite'
  | 'preset.fullAccess'

const PRESET_LABEL_KEYS = new Map<string, PermissionPresetLabelKey>([
  ['read-only', 'preset.readOnly'],
  ['workspace-write', 'preset.workspaceWrite'],
  ['danger-full-access', 'preset.fullAccess'],
])

/**
 * English built-in preset labels, read from the dictionary that owns the copy
 * so a host-supplied machine value still renders as product copy on a surface
 * that has no locale seat.
 */
const DEFAULT_PRESET_LABELS: Record<PermissionPresetLabelKey, string> = {
  'preset.readOnly': en['preset.readOnly'],
  'preset.workspaceWrite': en['preset.workspaceWrite'],
  'preset.fullAccess': en['preset.fullAccess'],
}

/**
 * Render one axis value under its product label. The axis is required because
 * the two pickers share no visible caption, so the label itself says which axis
 * it belongs to ("工作区读" under the read picker, "工作区写" under the write one).
 * @param value - the axis value.
 * @param axis - the axis the value belongs to, which selects the copy.
 * @param t - optional locale dictionary lookup for the built-in labels.
 * @returns the localized label, or the English label without a locale seat.
 */
export function axisLabel(
  value: PermissionAxisValue,
  axis: PermissionAxis,
  t?: (key: AxisLabelKey) => string,
): string {
  const key: AxisLabelKey = AXIS_LABEL_KEYS[axis][value]
  return t?.(key) ?? DEFAULT_AXIS_LABELS[key]
}

/**
 * The NAME half of one dropdown's trigger label: one word per value.
 *
 * A `custom` axis renders as the bare word and nothing else. It used to append
 * its base and group count, which is how a group pick on an already-custom axis
 * became visible; the trigger does not have room for that text, and the editor a
 * `custom` pick opens states the base, the groups and both path lists in full,
 * so the detail lives there instead of on the trigger. Nothing else observes the
 * difference: a submission is judged by the stored record the read-back
 * compares against, never by the trigger's text.
 *
 * An absent value (no stored record, or a kind this build does not know) says so
 * instead of borrowing a value: the two dropdowns must render even when nothing
 * can be claimed about the axis, and "未设置" is the honest label for that.
 * @param value - the axis value to name, or `undefined` when there is none.
 * @param axis - which axis this name belongs to.
 * @param t - locale lookup for the label.
 * @returns the name to interpolate into the trigger's `readLabel`/`writeLabel`.
 */
export function axisValueName(
  value: PermissionAxisValue | undefined,
  axis: PermissionAxis,
  t: (key: AxisLabelKey) => string,
): string {
  if (value === undefined) return t('axis.unknown')
  return axisLabel(value, axis, key => t(key))
}

/**
 * One line of the widening report that sits beside the write axis, or nothing to
 * render.
 *
 * The content comes from the HOST's resolution of the same inputs — the roots it
 * names are the roots it will refuse — so this function only decides how to spell
 * them, never whether the narrowing happened. An absent report and a report that
 * removed nothing both yield `undefined`: the notice appears exactly when the
 * fence is narrower than the write axis.
 */
export interface NarrowingNotice {
  /** The heading, naming the invariant. */
  readonly title: string
  /** What the intersection removed, in the roots' own spelling. */
  readonly removed: string
  /** The unbounded-to-bounded sentence, or empty when the roots carry the loss. */
  readonly lostUnbounded: string
  /**
   * Whether the write trigger's corner marker is shown. It is the only part of
   * the report visible with the editor closed, and it carries no text: the
   * trigger's label is the picked value and nothing else.
   */
  readonly marked: boolean
  /**
   * The marker's accessible name — the whole report in one sentence, since the
   * marker itself has no room and no text. Built HERE rather than at the call
   * site so the sentences that need parameters are interpolated with them: a
   * caller that forwards a key-only lookup leaves literal placeholders on screen.
   */
  readonly marker: string
}

/** The locale lookups one notice needs; the dictionary itself owns the copy. */
export type NarrowingText = (key: NarrowingKey, params?: Record<string, string>) => string

/** Dictionary keys the notice is built from. */
export type NarrowingKey =
  | 'narrowing.title'
  | 'narrowing.body'
  | 'narrowing.removed'
  | 'narrowing.none'
  | 'narrowing.lostUnbounded'
  | 'narrowing.marker'

/**
 * Build the write axis's narrowing notice.
 * @param narrowing - the host's report, or `undefined` when there is none.
 * @param t - locale lookup for every sentence.
 * @returns the notice to render, or `undefined` when nothing was removed.
 */
export function narrowingNotice(
  narrowing: DualAxisNarrowingWire | undefined,
  t: NarrowingText,
): NarrowingNotice | undefined {
  if (narrowing === undefined || !narrowing.narrowed) return undefined
  const roots = narrowing.droppedRoots.length === 0
    ? t('narrowing.none')
    : narrowing.droppedRoots.join('\n')
  const title = t('narrowing.title')
  const removed = t('narrowing.removed', { roots })
  return {
    title,
    removed,
    lostUnbounded: narrowing.lostUnbounded ? t('narrowing.lostUnbounded') : '',
    marked: true,
    marker: t('narrowing.marker', { title, removed }),
  }
}

/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Render a permission preset under its product label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @param t - optional locale dictionary lookup for built-in product labels.
 * @returns the localized built-in label, or the host's own name VERBATIM.
 */
export function displayPermissionPreset(
  value: string,
  name: string,
  t?: (key: PermissionPresetLabelKey) => string,
): string {
  const key = PRESET_LABEL_KEYS.get(value)
  if (key !== undefined && (name === value || name === DEFAULT_PRESET_LABELS[key])) {
    return t?.(key) ?? DEFAULT_PRESET_LABELS[key]
  }
  // Verbatim, deliberately not `displayPresetName(name)`: rewriting a deployment's
  // own preset name (`custom-mode` becoming `Custom Mode`) invents a label its
  // operator never wrote and cannot search for. Only the three built-in machine
  // values above are this package's to relabel.
  return name
}
