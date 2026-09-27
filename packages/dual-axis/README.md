# @t4r71/dsh-dual-axis

The dual-axis access-mode bundle (host half): the file sandbox's read and write axes — each `deny | workspace | all | custom`, with `custom` carrying absolute `allow` and `deny` path lists — as an installable profile layer with its Plugins-page configuration.

## ⚠ This bundle disables an official UI row

Installing this bundle turns OFF the upstream row `ui-permission`
(`@deepseek-ai/dsh-client-ui-permission-presets`, declared in
`@deepseek-ai/dsh-web-app`'s `cordis.patch.yml`) — see `cordis.patch.yml` in this package.
That is a deliberate REPLACEMENT, not a coincidental clash, and it is not reversible by
flipping `disabled: false` while this bundle is installed.

**What is replaced.** This bundle's client half registers the same three surfaces the
upstream row registers, which is why the two cannot both be active:

| Surface | Upstream | This bundle |
| --- | --- | --- |
| Composer control | `conversation.input.permission` | same slot, two axis dropdowns instead of one preset picker |
| General-settings row | `settings.general.item`, id `permission`, order `-20` | same slot and id |
| `/permission` picker | `command.decorate({ name: 'permission' })` | same decoration, over the same command |

Two independent mechanisms would fail a client boot with both rows active, so removing
the disable is not an option:

1. **`conversation.input.permission` is a single-occupant slot.** `ui-conversation`
   declares it `{ kind: 'single', scope: 'session' }`, and a second registration throws
   `single slot "<name>" already has a registration` (`packages/client/ui-slots/src/index.ts:1216-1218`).
   Renaming a locale namespace does not address this.
2. **Locale namespaces are single-occupant per (namespace, locale).** Both rows register
   `permission.access` and `settings.permission`; the second `register` throws
   `locale namespace "<ns>" already has locale "<locale>"`
   (`packages/client/locale/src/client/index.ts:415-419`).

**Behaviour that changes.** The composer control becomes two independent read/write axis
dropdowns (`deny | workspace | all | custom`) submitting `/axis <axis>:<value>` instead of
one preset picker submitting `/permission <preset>`. The General-settings row keeps its
position and its default-preset meaning. The `/permission` slash picker keeps the upstream
preset list.

**To get the official UI back**, uninstall this bundle (drop `@t4r71/dsh-dual-axis` from the
profile's `dsh.profile.bundles` and from its `package.json` dependencies). The row that
carries the disable is this package's `cordis.patch.yml`, so it leaves with the bundle and
`ui-permission` activates again. Leaving the bundle installed and editing the row to
`disabled: false` restarts the collision above and the client hangs on "Loading plugins".

## Model Experience

The axes are stated to the model in a runtime-context paragraph of their own, contributed under the section name `sandbox:dual-axis` (order `SANDBOX_POLICY + 1`, so it follows 0.1.7's own `sandbox:policy` line rather than interrupting it). The paragraph names both axes as resolved ranges — every allow root and every deny root, not a mode name — and states how they are enforced, including the fact that this build does not intersect them. It is re-rendered at every assembly, so a mid-session axis change reaches the model on the next request.

The paragraph is not a new model-visible input in the log sense: it is derived from the session's stored axis pair, the current definitions of the rule groups that pair references, and the session header's `cwd`, and the agent loop logs the rendered snapshot as model history like every other runtime-context entry. The refusal a fence returns is built from the same `src/scope-prompt.ts` functions, so the range the model read and the range it is denied by cannot disagree.

The axes are NOT in the session log. A package-declared event type is outside 0.1.7's `KNOWN_SESSION_EVENT_TYPES`, and `Session.append` takes no envelope option, so such an event cannot be marked `ignorable` and a log carrying it is refused whole by `validateStoredEvents` — the session becomes unopenable after a restart. The pair therefore lives in this package's own settings namespace (see Settings below), and the only axis record left in a session log is the write base mirrored onto 0.1.7's own `sandbox/mode`.

## What 0.1.7 removed, and what this package carries instead

| Capability | 0.1.6 home | 0.1.7 state | This package |
| --- | --- | --- | --- |
| Axis algebra | `dsh-sandbox/access`, `dsh-sandbox/scope` | deleted (0 hits tree-wide) | `src/axis.ts`, `src/scope.ts` |
| Per-session axis pair | `sandbox/mode` payload `readScope`/`writeScope` | payload locked to `{ mode, source }`; a plugin event type is refused whole by the log validator | `src/session-store.ts` (settings namespace `dual-axis-sessions`), with `src/session-axes.ts` mirroring the write base onto `sandbox/mode` |
| Read-path fence | `dsh-fs-sandbox` (358 lines, 8 read overrides) | deleted; reads pass through | `src/fs-fence.ts` |
| Settings section | `settings.register(ns, schema)` | only Loader-entry Config | `src/config.ts` |
| Dual write entry | `setSandboxScopes` | only `setSandboxMode(session, mode)` | the store writes the pair; `mirrorWriteMode` writes the mode |

## Layout

| Path | Role |
| --- | --- |
| `src/axis.ts` | The four axis kinds, the mode bijection, `effectiveScopes` |
| `src/scope.ts` | `resolveScope` / `scopeContains`: the pure allow/deny range algebra |
| `src/config.ts` | Loader-entry `Config` with both axes `.volatile()`, and `normalizeScope` |
| `src/session-store.ts` | The per-session axis pair: namespace `dual-axis-sessions`, the memoized read, the whole-document write with its revision-fence retry, and the GC sweep |
| `src/session-axes.ts` | The write base's mirror onto 0.1.7's own `sandbox/mode` event |
| `src/fs-fence.ts` | `DualAxisFileSystem`: the read-path fence |
| `src/read-guard.ts` | The `/read-guard` entry point: the tool-dispatch fence for both axes |
| `src/scope-prompt.ts` | The model-facing range text: one source for the runtime-context paragraph and the refusal |
| `src/index.ts` | The plugin class: registers the axis command and the range paragraph, seeds each new session — a subagent child from its parent's stored pair (`inheritedAxes`), every other session from the settings row's live pair — and schedules the GC sweep |
| `tests/seed-parity.spec.ts` | The cross-package drift gate: the same rows through this package's `seedPair` and through `@t4r71/dsh-dual-axis-ui`'s `sessionAxesSeed`, asserted byte for byte |
| `src/fs.ts` | The `/fs` entry point exporting the backend |

## Settings

Two namespaces, both Loader entry ids, each field declared `.volatile()` because 0.1.7 refuses to project or write a non-volatile field.

`dual-axis` is the row the Plugins page edits: the two axes a NEW session starts from (`read`, `write`), the rule-group library (`groups`), and the group ids a new session starts out referencing (`defaultGroups`). All four are SEEDS. For a session that has been USED they are read once, at creation, and never again; for one nobody has used yet the row stays live, and editing it moves that session's axes (see "A session with no record").

A newly created session reads these values through `ctx.settings.describe()` rather than through the `Config` the plugin captured at mount: 0.1.7's loader does not commit a settings-page save back into that captured accessor, so reading it would keep seeding sessions with the value the process started on until the next restart. `describe()` re-projects the entry's live config on every call, which is the same read the settings row's own summary uses. A composition without the `settings` service falls back to the captured `Config`.

```yaml
- id: dual-axis
  name: '@t4r71/dsh-dual-axis'
  config:
    read: { kind: all }
    write: { kind: workspace }
- id: dual-axis-sessions
  name: '@t4r71/dsh-dual-axis/session-store'
```

`dual-axis-sessions` is the store: one field, `axes`, `session id -> { read, write }`. It is a separate entry rather than a field on the row above because the row's namespace carries the Plugins-page form, and a field the row's form does not declare is one more thing that form has to render around. The client half registers no page for this namespace.

Every decision path reads the STORE, plus the group library by id, and nothing else — except for a session the store holds NO record of, where the row's seeds are the session's pair until the repair write lands (see "A session with no record"). Once a session has a record, the row's seeds are never consulted for it again. Reading is memoized on the namespace's `revision`, so a decision path pays one `settings.describe()` per document change rather than one per tool dispatch.

### Writing, and what a lost write does

The whole `axes` field is written in one `replace`, because removing a record needs the whole map anyway. Every attempt re-reads the namespace revision first, and a refused write is retried up to four times (0/25/75/200 ms) against the revision the other writer produced. If every attempt is refused the store throws `SessionAxesConflictError` (`code: 'DUAL_AXIS_AXES_CONFLICT'`); `/axis` renders that as a command error beside the picker, and the session-creation path logs it. A write is never reported as applied when it was not stored.

### A session with no record

A session with no record is not an error and it never hides a control. Every live decision path — the model-facing paragraph, the read fence, and `/axis` — reads through `SessionAxesStore.ensure`, which answers `seedPair` (`seedAxesFor`'s pure core): the settings row's `read`/`write` plus its `defaultGroups`, or, for a subagent child, its parent's stored pair. That value is what the session runs under and what the pickers show, so "interface shows A, host enforces B" cannot happen.

### When the record is written

The record is written when the session is USED, not when it is created. `pin` writes at creation only for a session that already has content, and `ensure` schedules its repair write only for one that does; a session with neither a record nor any content is answered by a seed RECOMPUTED ON EVERY READ, so the settings row stays live for it.

This matters because of how a conversation actually starts. The workspace picker reopens the SAME session id when you start a new conversation in the same workspace — measured, not assumed: two consecutive "new session in nvidiaDlssGlom" clicks left `[data-conversation-session]` at the same id, and the workspace's session list was unchanged. Freezing at creation therefore pinned a conversation nobody had had to whatever the row said the day the picker first opened it, and later edits never reached it. A session that has been used freezes as before: the record is the session's own pair from then on.

**"Used" means content beyond the loop's own runtime-context snapshot** (`src/content.ts`, `hasContent`). The agent loop appends that snapshot on every turn, the first included, before any human input exists, so counting it would make every session look used the moment anything rendered its prompt. It is identified by `source.kind === 'runtime-context'`, the discriminant the loop writes and reads back, rather than by its rendered text, which is prose that changes with every contribution. Every other message counts — a real user turn, an assistant reply, the skill catalogue — because each means the session has entered a turn. The predicate walks the session's already-materialized event array with no copy or parse per event, and the sessions it is asked about are exactly the ones nobody has used, so the scan is short.

Two writes therefore freeze a pair, and both are deliberate: the first real turn, and `/axis` — which calls `SessionAxesStore.set` unconditionally, so a manual pick freezes an empty session too, and the manual value wins over any later settings-row edit.

### Degenerate states

A repair never overwrites a record that appeared while it was waiting, and a repair that cannot be stored is logged and re-armed, never thrown at the decision path that scheduled it.

`DEFAULT_AXES` (read `all`, write `workspace`) is what `SessionAxesStore.getOr` answers for a caller that holds no session to build a seed from; it is not the pair a session with no record is held to. `getOr`'s remaining callers hold no session, because `ensure` — which the live paths use — is the one that can answer a seed. An unreadable settings row answers `DEFAULT_AXES` on BOTH sides — `seedPair` and the client half's `SESSION_AXES_FALLBACK` — so even the failure branch agrees.

The client half recomputes that same seed locally (`sessionAxesSeed` in `@t4r71/dsh-dual-axis-ui`, which shares no import with this package), because it must display the pair this host is enforcing for a session the document carries no record of. `tests/seed-parity.spec.ts` feeds both implementations the same rows and asserts the answers are the same bytes, key order included; it is the only thing that stops the two from drifting.

### Garbage collection

Records are dropped when the session they belong to no longer exists, and the signal is the persistence layer: an id absent from `sessionPersistence.list()` has no stored log. The sweep runs at start-up (15 s in, after the loader and the persistence backend are up) and every 30 s after that. It never runs on `session/disposed` — residency churn disposes a session whose file is still on disk, and dropping that record would silently reset a session about to be resumed. A sweep that cannot judge (no persistence service, or a failed listing) removes nothing and says so in the log.

## Building

The package resolves every `@deepseek-ai/*` import from its own `node_modules`: `pnpm install` then `tsc -b` and `tsdown` work in a directory tree that contains nothing but this package. `tsconfig.base.json` holds the compiler options this package needs and declares no `paths`; `tsconfig.json` adds only the package's own entry point.

Tests run from source through tsx (`TSX_TSCONFIG_PATH=tsconfig.runtime.json node --import tsx/esm --test tests/*.spec.ts`) and resolve the same way, with one exception: `tests/settings.spec.ts` and `tests/session-store.spec.ts` read `isVolatilePath` and `volatileForm` from `@deepseek-ai/dsh-settings/schema`, and that package ships `lib/types/schema.js` while declaring no `./schema` subpath in its exports map, so Node cannot resolve the specifier. `tsconfig.runtime.json` maps that one specifier to the shipped file inside the installed dependency. Dropping the mapping requires `@deepseek-ai/dsh-settings` to export `./schema`.

## Known Limitations and Deferred Work

- **The write axis is NOT intersected with the read axis.** This build enforces the two axes independently: `read-guard` grades a write call with the write axis's deny list alone, and the inherited write fence grades the same call by the write axis's base mode. A path the read axis denies is therefore still writable when the write axis allows it. The client half's settings copy states the opposite (`读轴放行、写轴不放行，仍然写不了`), so the copy and the enforcement disagree. The runtime-context paragraph states the enforced behavior, not the intended invariant.
- **The read axis is enforced at the tool-dispatch layer only.** `read-guard` inspects the four read entry points in its `READ_TOOLS` table (`read`, `read_image`, `grep`, `glob`); a command tool, a child process, or a script is fenced for writes by the sandbox mode but never for reads. Mounting `DualAxisFileSystem` closes that path for `ctx.fs` consumers, which does not include command tools.
- The refusal text tells the model that reaching a refused path through another tool is not a permitted workaround. That is a rule statement; the enforcement gap above is the reason it cannot be stated as a fence. It also states the layering per axis: the read axis and either axis's allow/deny path entries bind the tool layer alone, while only a write axis's BASE tier is mirrored onto the session sandbox mode and enforced again below that layer — an `all` base mirrors to `danger-full-access` and so has no layer below.
- **A subagent child whose parent session holds no record falls back to the settings row.** `inheritedAxes` looks the parent's record up by the id the child's header names, resident or not, and returns `undefined` when that id has no record; the child is then seeded with the settings-page pair. It is still seeded, which is what keeps the read fence from falling back to the deployment defaults for that child. Residency deliberately does not participate: the client half reads the same document by the same id and cannot observe which sessions this process has materialized, so keying the seed on residency would make the two halves disagree for exactly that child.

- `DualAxisFileSystem` (`src/fs-fence.ts`) is **not mounted and not wired**. No profile composes its row — the shipped `cordis.patch.yml` carries it commented out, because mounting it means taking the `fs` service from the composition's own `fs-sandbox` row — and its per-call `ReadAxes` trailing parameter has no producer: 0.1.7's `SandboxExecutionPolicy` has no `readScope`/`writeScope` members, so a consumer that does not thread the pair gets the deployment DEFAULT read axis, never this package's per-session store. The read fence actually in force is `read-guard.ts`. The module is kept for `readAxisRefusal` / `readAxisRefusalAsync`, the canonical read-axis containment predicates, and for an operator who replaces the filesystem backend by hand (disable `fs-sandbox`, mount this row, and thread the axes).
- The client half lives in a separate package (`@t4r71/dsh-dual-axis-ui`); this package declares no `dsh.client`.

