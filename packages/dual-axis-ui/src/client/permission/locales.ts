/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** Locale namespace shared by both current-session permission pickers. */
export const PERMISSION_ACCESS_NS = 'permission.access'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '权限',
  'description': '选择新会话的默认权限模式',
  'loading': '加载中',
  'unavailable': '不可用',
  'preset.readOnly': '仅可查看',
  'preset.workspaceWrite': '工作区内修改',
  'preset.fullAccess': '完全权限',
} satisfies Record<string, string>

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Permission',
  'description': 'Choose the default permission mode for new sessions',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
} satisfies Record<PermissionSettingsKey, string>

/**
 * Simplified Chinese dictionary for the two current-session axis pickers. Each
 * axis is a four-value dropdown (`deny / workspace / all / custom`), and the two
 * dropdowns must stay unambiguous for assistive technology, for role-based
 * locators, and for the eye: the two pickers sit side by side with no visible
 * caption, so every value states its own axis in the copy itself. `custom` is the
 * one shared value — "自定义" opens a path editor whose contents say which axis it
 * belongs to, and the two pickers are already told apart by the other three.
 */
export const accessZh = {
  'axis.read.deny': '禁止读',
  'axis.read.workspace': '工作区读',
  'axis.read.all': '全盘读',
  'axis.write.deny': '禁止写',
  'axis.write.workspace': '工作区写',
  'axis.write.all': '全盘写',
  'axis.custom': '自定义',
  'axis.unknown': '未设置',  'editor.readTitle': '读取权限 · 自定义路径',
  'editor.writeTitle': '写入权限 · 自定义路径',
  'editor.base': '底座',
  'editor.readBase': '读取权限的底座',
  'editor.writeBase': '写入权限的底座',
  'editor.baseDeny': '概不允许',
  'editor.baseWorkspace': '会话工作区',
  'editor.baseAll': '整台主机',
  'editor.allow': '额外放行的绝对路径（每行一条）',
  'editor.readAllow': '读取权限额外放行的绝对路径',
  'editor.writeAllow': '写入权限额外放行的绝对路径',
  'editor.deny': '排除的绝对路径（每行一条，优先于放行）',
  'editor.readDeny': '读取权限排除的绝对路径',
  'editor.writeDeny': '写入权限排除的绝对路径',
  'editor.hint': '允许的范围 = 底座 + 放行 − 排除；一条路径同时出现在两边时，排除优先。',
  'editor.submit': '应用',
  'editor.sending': '提交中…',
  'editor.cancel': '取消',
  'editor.failed': '宿主没有接受这次改动：自定义路径需要审批，未获批准时不写入。',
  'editor.notStored': '宿主执行了这条命令，但设置文档里没有出现这次改动：它被拒绝了。下拉仍显示当刻生效的取值。',  'editor.problemBase': '未知的底座。',
  'editor.problemPath': '路径必须是绝对路径（以斜杠、盘符或双反斜杠开头）。',
  'editor.problemComma': '路径里不能含逗号：宿主用逗号分隔参数。',
  'editor.groups': '规则组（可多选，也可以一个都不选）',
  'editor.groupBoth': '读 + 写',
  'editor.groupRead': '仅读侧',
  'editor.groupWrite': '仅写侧',
  'editor.groupNone': '两侧都没有规则',
  'editor.groupMissing': '设置页没有定义这个 id',
  'editor.groupsEmpty': '设置页还没有定义规则组。',
  'narrowing.title': '写轴被读轴收窄',
  'narrowing.body': '实际生效的写范围 = 写轴 ∩ 读轴。下面这些根本来由写轴放行，读轴不覆盖它们，因此写不进去。',
  'narrowing.removed': '读轴从写范围里削掉了：{roots}',
  'narrowing.none': '（没有）',
  'narrowing.lostUnbounded': '写轴本来无界（整台主机），现在被收成读轴的范围。',
  'narrowing.marker': '{title}：{removed}',
  'editor.problemGroupId': '选中的规则组 id 里含分隔符（竖线、逗号或等号），宿主读不出这个 id。请到设置页改掉这个 id。',
  'readLabel': '读取权限，当前：{name}',
  'writeLabel': '写入权限，当前：{name}',
  'customSummary': '自定义路径，基于{base}',
  'customAllow': '额外允许：{paths}',
  'customDeny': '额外禁止：{paths}',
  'customNone': '无',
  'close': '关闭',
  'preset.readOnly': '仅可查看',
  'preset.workspaceWrite': '工作区内修改',
  'preset.fullAccess': '完全权限',
  'confirm.title': '确认放开权限？',
  'confirm.description': '这次改动会把该条访问轴放到「整台主机」或额外的绝对路径上，后续操作将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '确认放开',
} satisfies Record<string, string>

/** Current-session axis-picker key union. */
export type PermissionAccessKey = keyof typeof accessZh

/** English dictionary for the two current-session axis pickers. */
export const accessEn = {
  'axis.read.deny': 'Deny read',
  'axis.read.workspace': 'Read workspace',
  'axis.read.all': 'Read all',
  'axis.write.deny': 'Deny write',
  'axis.write.workspace': 'Write workspace',
  'axis.write.all': 'Write all',
  'axis.custom': 'Custom',
  'axis.unknown': 'Not set',  'editor.readTitle': 'Read access · custom paths',
  'editor.writeTitle': 'Write access · custom paths',
  'editor.base': 'Base',
  'editor.readBase': 'Read access base',
  'editor.writeBase': 'Write access base',
  'editor.baseDeny': 'Deny everything',
  'editor.baseWorkspace': 'Session workspace',
  'editor.baseAll': 'The whole host',
  'editor.allow': 'Additional allowed absolute paths (one per line)',
  'editor.readAllow': 'Absolute paths read access also allows',
  'editor.writeAllow': 'Absolute paths write access also allows',
  'editor.deny': 'Excluded absolute paths (one per line, they win)',
  'editor.readDeny': 'Absolute paths read access excludes',
  'editor.writeDeny': 'Absolute paths write access excludes',
  'editor.hint': 'Allowed = base + allowed − excluded; when a path is on both lists, the exclusion wins.',
  'editor.submit': 'Apply',
  'editor.sending': 'Applying…',
  'editor.cancel': 'Cancel',
  'editor.failed': 'The host refused this change: custom paths need approval, and nothing is written without it.',
  'editor.notStored': 'The host ran the command but the settings document never showed this change, so it was refused. The dropdown still shows the value in force.',  'editor.problemBase': 'Unknown base.',
  'editor.problemPath': 'A path must be absolute (start with a slash, a drive letter, or a double backslash).',
  'editor.problemComma': 'A path cannot contain a comma: the host separates its arguments with commas.',
  'editor.groups': 'Rule groups (pick any number, or none at all)',
  'editor.groupBoth': 'read + write',
  'editor.groupRead': 'read side only',
  'editor.groupWrite': 'write side only',
  'editor.groupNone': 'no rules on either side',
  'editor.groupMissing': 'the settings page does not define this id',
  'editor.groupsEmpty': 'The settings page defines no rule groups yet.',
  'narrowing.title': 'The read axis narrowed the write axis',
  'narrowing.body': 'The write range in force is the write axis INTERSECTED with the read axis. These roots the write axis granted are not covered by the read axis, so nothing can be written there.',
  'narrowing.removed': 'The read axis removed these from the write range: {roots}',
  'narrowing.none': '(none)',
  'narrowing.lostUnbounded': 'The write axis was unbounded (the whole host) and is now held to the read range.',
  'narrowing.marker': '{title}: {removed}',
  'editor.problemGroupId': 'A selected rule-group id carries a separator (a bar, a comma, or an equals sign), so the host cannot read it back. Rename that id on the settings page.',
  'readLabel': 'Read access, current: {name}',
  'writeLabel': 'Write access, current: {name}',
  'customSummary': 'Custom paths over {base}',
  'customAllow': 'Also allowed: {paths}',
  'customDeny': 'Also denied: {paths}',
  'customNone': 'none',
  'close': 'Close',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'confirm.title': 'Widen access?',
  'confirm.description': 'This change puts that access axis on the whole host, or on additional absolute paths. Later actions reduce confirmation steps and can run more things directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Widen access',
} satisfies Record<PermissionAccessKey, string>
