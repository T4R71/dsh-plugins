# @t4r71/dsh-prompt-plan

Section-name-matched rewriting of the system prompt, as an installable profile
layer. One listener on the `system-prompt/assemble` waterfall, two modes:

- **`observe`** — writes what reached the seam and **returns the assembly
  unchanged**. This is the default, and it is a prerequisite, not a debug aid:
  every template section (`tool:workflow`, `tool:subagent`, `mcp:<server>`) is
  registered conditionally, so the names a rule can be written against are the
  **union over many assemblies**, not what one assembly showed.
- **`rewrite`** — applies the rule file to the sections the inner chain
  returned, and returns a new assembly.

There is no client half. This package declares no `dsh.client` and has no `-ui`
sibling.

## Where the rule file and the artifacts go

Both live in the **profile directory** — the directory the `prompt-plan` Loader
entry was declared in — **not** inside this package. A package upgrade therefore
cannot carry an operator's prompt rules with it, and a published tarball contains
no rules.

| Thing | Default | Override |
| --- | --- | --- |
| Rule file | `<profile directory>/prompt-plan.rules.yaml` | `config.rulesFile`, absolute or relative to that directory |
| Observation artifacts | `<profile directory>/prompt-plan-observations/` | `config.artifactDir`, absolute |

The profile directory is read from the **settings service**, not guessed from
`__dirname`. That read **does not work on the host this package currently runs
on**, and the plugin now says so instead of degrading quietly:
`@deepseek-ai/dsh-settings@0.2.0-rc.2` returns descriptors carrying `{ applies,
autoGenerate, base, ns, revision, schema, secrets, user, value }` and **no
`directory` member at all** — the identifier occurs zero times in that package —
so the lookup found nothing and previously answered `undefined` with nothing
logged.

What that used to cost: `ruleFilePath()` returned `undefined`, the loader
reported "no rules file path is configured", the caller cleared the pin, and
**rewrite mode then ran with no rules in force while every observation line still
said `rewrite`** and no `:rules` trace line was ever written. The plugin now
reports a `CONFIGURATION MISSING` line at mount and again on every refused load,
naming the member that is missing, the consequence, and the fix. Until the host
reports a directory, **set `config.rulesFile` to an absolute path** — an absolute
path bypasses the lookup entirely and is not reported as a gap.
On the desktop deployment measured here, the profile directory is
`M:\\DSH-T4\\home\\profiles\\desktop`, so a freshly installed package with no
configuration at all resolves to
`M:\\DSH-T4\\home\\profiles\\desktop\\prompt-plan.rules.yaml` and
`…\\prompt-plan-observations\\`. Nothing outside that directory is written.

The rule file is read with `node:fs`, not through the host's file service. That
is deliberate and its scope is worth stating exactly: the dual-axis read fence is
mounted on the **tool dispatch layer** (`ctx.tools.guard` plus a
`tools/pre-execute` listener over the four read entry points `read`,
`read_image`, `grep`, `glob`), so a plugin reading its own configuration never
enters it. This is a fact about where that fence sits, not a claim that it is
absent.

## Observation artifacts

Five files in the artifact directory, all append-only except the baseline:

| File | One line per | Contents |
| --- | --- | --- |
| `sections.jsonl` | assembly | ordinal, timestamp, **sessionId**, mode, section count, complete-shape flag, and every section's digest |
| `sections-text.jsonl` | assembly | the same with each section's **full text** (opt-in: `config.fullText`) |
| `baseline.json` | — | the accumulated index: one entry per section **name** |
| `purity.jsonl` | assembly | the evidence that the handler changed nothing, attributed to its **sessionId** |
| `README.txt` | — | the same explanation, written beside the data |

These files are **one stream shared by every session** the plugin serves, so read
`sessionId` before comparing any two lines. It is the session an assembly
belonged to, or `null` when the assembly carried no subject; it is written on
every line, including the `:rules` companion lines. An **absent** `sessionId`
member means that line predates the field and is not the same fact as `null`.

A section's digest is `{ index, name, textLength, textSha256, textPreview }`.
`index` is the position in the assembly array and is **placement evidence only**:
an assembled section carries no `order` member — the constructor copies `name`,
`text` and `interpolate` and nothing else — so array order is the only placement
fact on the wire, and no rule may match on it.

`baseline.json` is the file rules are written from. Per name it records how many
assemblies carried it, the first and last assembly ordinal, the text-length
range, the distinct sha256 values seen, how many **distinct texts** that amounts
to, the array indices it appeared at, and whether it ever declared
`interpolate: false`.

It **accumulates across restarts**, which the union argument above requires: on
mount the observer reads the index already in the directory and continues its
counters, so a second run adds to the first run's names instead of publishing an
index that covers only its own assemblies. The ordinal counter resumes one past
the highest ordinal in `sections.jsonl`, so a line's ordinal identifies exactly
one assembly for the life of the directory.

That counter is deliberately **not** per-session. It is one sequence across the
whole directory — sessions interleave into it, so two adjacent lines are often two
different sessions and one session's lines are a scattered subset. Keyed per
session it would restart at 0 for every new session, and `baseline.json`, which
is a union over the directory with no session in it, could no longer name one
assembly by ordinal. For a single session's own sequence, filter by `sessionId`
and read the ordinals in order; they will be sparse and increasing. An index whose `mode` differs from
the running mode is discarded rather than merged — an observe baseline and a
rewrite baseline must not be confused. Read `seen` against `distinctTexts`: a name seen many times
with one distinct text is static, which is what a replacement rule usually wants.

### Purity is demonstrated, not asserted

Every assembly records two independent facts: the handler **returned the same
object reference** it was handed, and the **per-section sha256** of the returned
assembly equals the one taken before the handler ran. Either alone is weak — a
reference can be returned after an in-place edit, and two digest lists can agree
by coincidence — so both are written per assembly. Any assembly where they
disagree gets `ok: false` in `purity.jsonl` **and** an error-level line in the
host log, so an observe window cannot pass unnoticed while writing.

## Cache-stability diagnostics (`cacheDiag`, off by default)

Two ledgers that answer one question: **a cache hit rate dropped — did we move the
prompt prefix, or is it the provider?** Both are written only when
`config.cacheDiag` is `true`, and both live in the same artifact directory as the
observation files.

| File | One line per | Contents |
| --- | --- | --- |
| `cache-prefix.jsonl` | assembly whose fingerprint **changed**, plus a heartbeat | the prompt fingerprint, the rule set's hash, and every section that moved |
| `cache-usage.jsonl` | model request | the four counts the adapter reported, and the hit rate they imply |

**The prompt fingerprint** identifies the assembled system prompt: per section,
its array index, name, text length, text `sha256`, and one bit for `interpolate`.
It is taken **after** every other listener on the waterfall has run, on the value
this handler is about to return — i.e. on what the model is actually sent.

A fingerprint that moved is **reported, not prevented**, and the report names
what moved:

```
prompt-plan: the assembled prompt changed at assembly 12 (session "abc") —
1 section(s) differ (text "persona"), the earliest at index 0, and the RULE SET DID NOT CHANGE.
Something other than this package's rules wrote to the prompt. This is REPORTED, never
prevented: the changed prompt has already been sent.
```

`ruleSetChanged` is the field that decides which explanation applies: a change
**with** it is this package reading a new rule file (a rule revision taking
effect at the next pin), a change **without** it is something else writing to the
prompt. The ledger carries **only hashes** — never section text; to see what a
section said, look its digest up in `sections.jsonl` (or `sections-text.jsonl`
with `config.fullText: true`).

**The usage ledger** is fed from a second seam — the `session/event` feed, on
`assistant/message`. It has to be a second seam: `system-prompt/assemble` runs
*before* the request is dispatched, so no usage exists at that point, and the
adapter's report arrives later as a session event. `assistant/message` is the only
event in the log that carries token accounting at all. A request whose adapter
reported no usage is not recorded as a row of zeros — there is no line for it.

`cacheHitRate` is `cacheReadTokens / (inputTokens + cacheReadTokens +
cacheWriteTokens)`. The three counts are **disjoint** (see `TokenUsage` in
`@deepseek-ai/dsh-llm`: `inputTokens` is uncached input only), so that denominator
is billed input tokens. It is `null` — never `1` — when the adapter reported no
cache fields or the denominator is zero.

**A missing `cacheWriteTokens` is not one of those refusals.** DeepSeek's adapter
maps `cache_read_input_tokens` and never reports a write count, so treating "no
write count" as "cannot compute" made this column `null` on **every live request**.
The two absences mean different things: a missing **read** count means nothing is
known about hits, so no rate is invented; a missing **write** count is zero for the
denominator only. The host reads the fields the same way —
`@deepseek-ai/dsh-token-meter`'s `bucketsFrom` is `cacheReadTokens ?? 0` and
`cacheWriteTokens ?? 0`.

### Across a restart

The fingerprint memory is **resumed from the ledger tail** when the plugin mounts,
so a prompt that changed while the process was down is still reported as a change
rather than filed as a fresh baseline. Without that, every restart would make each
subject look new and the first post-restart line would say `first: true` — a silent
**miss** in the one thing this feature exists to report. That line carries
`restored: true` and names the hash it compared against.

Two limits are inherent and are stated rather than hidden:

- **No section detail on that line.** The ledger stores no per-section digests, so
  `changedSections` and `changedSectionCount` are **absent** on the first line after
  a restart. The verdict is unaffected — `changed` and `ruleSetChanged` come from
  the two hashes, which do survive — only the per-section *naming* is missing. The
  host log says so rather than reporting "0 sections differ".
- **A change made entirely while the process was down is timestamped at the
  restart**, not at the edit. It is still reported and `previousPromptSha256` names
  the old hash, but its time is when it was first observed. That is inherent to
  observing from inside the process.

The resume reads at most `RESTORE_SCAN_LINES` (200) lines from the end, so a large
ledger cannot slow startup; a subject whose last line fell outside that window
loses its memory and costs exactly one `first: true`.

### What these two files can and cannot conclude

**A hit-rate drop on a request whose fingerprint changed a moment earlier is
attributable to the system prompt — that is, to this process.** That is the
positive result, and it is the only one.

**A hit-rate drop with an UNCHANGED fingerprint does not make the provider
guilty.** A provider KV cache hits on the longest common token **prefix of the
whole request**: system prompt **and** message history **and** tool schemas. These
files fingerprint the **system prompt only**. So an unchanged fingerprint
*excludes* the system prompt and nothing else — a diverging message history, a
changed tool result, a cache TTL expiry and a provider-side eviction all remain
possible, and **none of them appears in either file**.

`firstChangedIndex` bounds the claim further: sections before that index are
byte-identical and in the same order, which is the only part of the prefix this
fingerprint can vouch for. Everything from there on may have moved.

### What "detecting injection" does and does not mean here

The fingerprint makes a prompt modification **visible and attributable**. It does
**not** prevent one, and it cannot:

- it is taken **after** every other listener has run, so by the time a change is
  visible the modified prompt **has already been sent**. Nothing here can stop a
  prompt from being modified — that is the assembly chain upstream, not this
  package;
- an **unchanged** fingerprint proves nothing: it is a hash of the assembled
  sections, so an injection that reproduces a previous prompt byte for byte, or
  one arriving through a channel this fingerprint does not cover (tool schemas,
  `contexts`, the message history), is invisible to it;
- nothing here is a **gate**. A changed prefix is logged and recorded and the
  assembly is returned exactly as it would have been without the diagnostics —
  there is a test that asserts precisely that. Refusing an assembly because its
  prefix moved would cost a turn and save nothing, since the prefix has already
  moved by then.

The honest one-line summary: **it is an attribution log, not a defence.**

### Both ledgers are capped

Each ledger holds at most `config.cacheLedgerLines` lines, then rotates:
`cache-prefix.jsonl` → `.1` → `.2` … up to `config.cacheLedgerKeep` copies, with
the oldest deleted. The defaults (2000 lines × 5 files per ledger) put a hard
ceiling of **10 000 lines per ledger**, and a line is a few hundred bytes of
numbers and 64-character hex digests. Nothing here grows without bound, and no
section text is ever written to it. A count below 1 configured by hand is clamped
to 1 rather than honoured, because an unbounded diagnostic is exactly the failure
this feature must not reproduce.

On a steady state where nothing changes, the ledger is **not** silent and not a
line per turn: a heartbeat line is written every `config.cacheHeartbeat` (default
200) assemblies of a subject, so "nothing changed" is a positive statement rather
than an empty file that could equally mean "the listener died".

### Reading the two together

Both files share the artifact directory and each line carries an ISO timestamp,
its own `ordinal`, and the `sessionId` it belongs to (`null` when the assembly or
the event had no subject). To attribute a drop: find the `cache-usage.jsonl` line
whose hit rate fell, then look in `cache-prefix.jsonl` for a changed line of the
same `sessionId` immediately before it on the clock. A change there is the answer;
no change there means the cause is outside the system prompt and outside these
files.

## Rule file

YAML, **parsed by this package** — see "Why there is no YAML dependency" below.
JSON is accepted too, because it is a subset of the same reader's input; no flag
is needed.

```yaml
version: 1

rules:
  # ---- exact match: an ordinary section, registered under a literal name ----
  - id: persona-prefix
    note: "The deployment's own persona opener."
    match:
      kind: exact
      value: deployment:persona-prefix
    action:
      kind: replace
      text: |
        You are an AI agent operated under a deployment policy.
        Answer in the operator's language unless told otherwise.
    required: true

  # ---- prefix match: a template section whose name carries parameters ----
  - id: tool-workflow
    note: "tool:<name> sections are registered per tool; only some compositions have them."
    match:
      kind: prefix
      value: tool:workflow
    action:
      kind: append
      text: "Run the workflow tool's steps in the declared order."
    required: false

  # ---- regex match: several families at once, with a boundary ----
  - id: every-tool-section
    match:
      kind: regex
      value: "^tool[:_]"
    action:
      kind: wrap
      prefix: "<tool-section>"
      suffix: "</tool-section>"
    required: false

  # ---- delete ----
  - id: drop-session-query
    match:
      kind: exact
      value: tool:session-query
    action:
      kind: delete
    required: false

  # ---- prepend ----
  - id: before-plan
    match:
      kind: exact
      value: plan:tree
    action:
      kind: prepend
      text: "The task tree below is the plan of record."
    required: false

  # ---- replace with fragments that are spliced to the tail ----
  # A rule file cannot register a scoped section, so the upstream same-name
  # replacement (a scoped registration shadows a global one) is out of reach
  # here. Splice reaches the same outcome from the rewrite side: the matched
  # section is removed and the fragments appended after everything that survived.
  - id: move-mcp-block
    match:
      kind: prefix
      value: "mcp:"
    action:
      kind: replace
      splice: true
      fragments:
        - text: "MCP servers available in this session are described below."
    required: false

  # ---- writing into a section the deployment emptied on purpose ----
  # Off by default. See "An empty section is not a place to write" below; opt in
  # only when the emptiness is not a deployment decision you would contradict.
  - id: fill-ptc-only
    match:
      kind: exact
      value: tools:ptc-only
    action:
      kind: replace
      allowEmpty: true
      text: |
        `run_code` is the only tool you may call directly.
    required: false
```

### Matching and actions

| `match.kind` | `value` means | Note |
| --- | --- | --- |
| `exact` | the whole section name | for ordinary sections |
| `prefix` | a string prefix — **not** a segment boundary: `tool` matches `tool:workflow` and `toolchest:x` | use `regex: "^tool[:_]"` for a boundary |
| `regex` | a pattern compiled without the `g` flag, so `test` keeps no state | for template families |

| `action.kind` | Members | Effect |
| --- | --- | --- |
| `replace` | `text` | the matched section keeps its name and gets new text — **unless it was empty**, see below |
| `replace` | `fragments[]`, optional `splice` | the matched section is dropped; each fragment becomes a section named `<matched>~<index>~<n>`; with `splice: true` those fragments are appended after every surviving section instead of taking the matched position |
| `replace` | `allowEmpty` (default `false`) | write into the matched section even when its text is empty. No other kind accepts it |
| `delete` | — | the section is removed |
| `prepend` | `text` | a section named `<matched>~<index>~pre` is inserted before it |
| `append` | `text` | a section named `<matched>~<index>~post` is inserted after it |
| `wrap` | `prefix`, `suffix` | `<matched>~<index>~open` before and `<matched>~<index>~close` after |

| Rule member | Default | Meaning |
| --- | --- | --- |
| `id` | required | unique; every diagnostic names it |
| `match` | required | `{ kind, value }` |
| `action` | required | `{ kind, … }` |
| `required` | `true` | an unmatched rule is an **error** in rewrite mode |
| `all` | `true` | rewrite every match; `false` rewrites only the first |
| `note` | — | free text, carried into diagnostics |

`allowEmpty` lives on the **action**, not on the rule — next to `splice`, which
is the other `replace`-only switch — because it is a statement about what that one
replacement does rather than about the rule's lifetime.

**`required: true` is the default on purpose.** A rule that silently stopped
matching is the failure this package is most likely to suffer: template sections
come and go with the composition, and a section merely absent from one assembly
is not evidence that the rule was wrong. The refusal names the rule, its matcher,
and the ten section names closest to the unmatched key, so a typo is a one-line
fix. Set `required: false` on a rule aimed at a conditional section.

Rules apply in file order, and each rule sees the previous rule's output —
including the fragments it created, whose names are deterministic. Reordering the
file can therefore change the result.

### An empty section is not a place to write

`replace` **skips a section whose text is empty**, and says so in the rule trace:
the empty section is left exactly as it arrived, and the `:rules` line carries
`SKIPPED n empty section(s)` together with the fix. Both forms are covered — the
`text` form and the `fragments` form — because both write into the same place.

The reason is that upstream empties a section **on purpose**, per deployment:

| Section | Empty when | Who empties it |
| --- | --- | --- |
| `tools:ptc-only` | the deployment is not in PTC mode | `dsh-tools`, `collapseSection` — its own comment reads "both renders empty: native calls do execute there, so the rule is false" |
| `context:file-reference` | no `read` tool is mounted | `dsh-file-reference-local` |
| `harness:identity` | `includeHarnessIdentity: false` | `dsh-system-prompt` |

and `dsh-system-prompt` then **drops every empty section** (`.filter(text =>
text.length > 0)`). So an empty section is the owning module saying "this
deployment does not want this", and a rewrite that fills it puts a statement into
the prompt that nothing in the running composition stands behind. Measured before
this guard existed: an empty `tools:ptc-only` came back as a 65-character
assertion, in an assembly where the section had been collapsed to `""` precisely
because that assertion was **false**.

When the emptiness really is not a decision you would be contradicting, write
`allowEmpty: true` on the action. It is refused on every other kind, so a rule
file cannot carry a switch that could never fire, and the trace then prints
`allowEmpty` so the intent is visible in an observation window rather than only
in the rule file.

### What this package carries that upstream owns

Upstream ships the assembly invariants — non-empty names, no duplicate names,
`text` is a string — as a companion plugin that `inject`s the `invariants`
service. The 0.1.7-rc.2 desktop composition does **not** mount that service (see
"Measured against the 0.1.7-rc.2 artifact" below), so those assertions do not run
there. This package carries an equivalent and runs it on its own output, with the
upstream message text, so a failure reads the same either way.

### `complete: true` sections are refused, not rewritten

A `complete: true` section is snapshotted **before** the waterfall runs and
restored afterwards, with the sections collapsed to that one element
(`packages/core/system-prompt/src/index.ts:601-611` and `:629-634`). No listener's
rewrite survives it. The mark is not on the assembly — the assembled section
carries name, text and interpolate only — so the only available test is the
**restore's output shape**: a sections array shorter than two. Rewrite mode
refuses such an assembly and logs why; observe mode records the shape and carries
on. The test and its limits are documented next to the code in `src/sections.ts`.

### Why there is no YAML dependency

The rules file is YAML because a human hand-authors it. It is parsed by
`src/yaml.ts`, a deliberately small reader that **accepts exactly the constructs
the documented schema uses and refuses everything else by name**, with a line
number. Measured on this machine, no YAML library is resolvable from anywhere
this plugin runs:

```text
$ node -e "for(const m of ['js-yaml','yaml'])try{console.log(m,require.resolve(m,{paths:['C:/Users/TRI/.dsh/profiles/desktop']}))}catch(e){console.log(m,'FAIL',e.code)}"
js-yaml FAIL MODULE_NOT_FOUND
yaml FAIL MODULE_NOT_FOUND
```

`js-yaml@4.3.2` and `yaml@2.9.1` exist only inside `M:\\dsh-plugins\\node_modules\\.pnpm`,
a workspace store that no installed profile resolves through — the desktop
profile installs with `nodeLinker: hoisted` and contains exactly one package
besides this one. See the README of the release notes for the full probe.

The reader's supported subset, in full: block mappings and sequences by
indentation (spaces only), flow `[a, b]` and `{a: b}` on one line, plain and
quoted scalars, block scalars `|`, `>-`, `|+`, comments, and the scalar forms
`true`/`false`/`null`/`~`/integers/floats. Refused by name: tab indentation,
anchors, aliases, tags, merge keys, multi-document streams, cross-line flow
collections, duplicate keys.

## Configuration

```yaml
- id: prompt-plan
  name: '@t4r71/dsh-prompt-plan'
  config:
    rulesFile: ''        # '' -> <profile dir>/prompt-plan.rules.yaml; use an ABSOLUTE path until the host reports a settings directory
    mode: observe        # observe | rewrite
    artifactDir: ''      # '' -> <profile dir>/prompt-plan-observations
    fullText: false      # also write sections-text.jsonl
    observe: true        # false stops writing any artifact
    cacheDiag: false     # the cache-stability ledgers; see below. OFF by default
    cacheLedgerLines: 2000   # lines per cache ledger file before it rotates
    cacheLedgerKeep: 4       # rotated copies kept, .1 ... .n
    cacheHeartbeat: 200      # assemblies between heartbeat lines; 0 = changes only
    cacheRecordEveryAssembly: false   # true = a prefix line per assembly, not only on change
```

`cacheDiag` is independent of `observe`: with `observe: false` and `cacheDiag:
true` the observation artifacts stop and the two cache ledgers keep going. With
`cacheDiag` false (the default) nothing in this section runs at all — no second
listener, no directory read, no file — and the mount line says so, so "not
running" is distinguishable from "running and found nothing".

The row id `prompt-plan` is the Loader entry id and therefore the settings
namespace, so a profile-level `cordis.patch.yml` can change any of these without
editing this package.

**Ship it in `observe` first.** Run a normal working session, let the assemblies
accumulate, then read `baseline.json` and write rules against the names that are
actually there. Switching to `rewrite` with a guessed rule set is what the
`required` default exists to make loud, not what it exists to make safe.

## Guarding is not this package's job

This package **used to** carry a second, overlapping implementation of the two
degeneration guards (streaming collapse, turn completion) under
`src/guards/**`, mountable either through a `guards` field on this row or
through a `@t4r71/dsh-prompt-plan/guards` subpath row under the plugin name
`prompt-plan-guards`.

**Both are gone, and neither is coming back.** The repo keeps exactly one guard
implementation — `@t4r71/dsh-guard` (`packages/guard`) — and that is the one
to install. Consequences worth knowing before you upgrade:

- there is **no `guards` config field** on this row any more; a profile that
  still sets it fails schema validation at mount, so delete the field;
- there is **no `./guards` subpath** in `exports`; a row naming
  `@t4r71/dsh-prompt-plan/guards` no longer resolves;
- `src/guards/**` and its build outputs are removed, so nothing in this package
  registers an `llm/stream` or turn-boundary listener.

This package does one thing: section-name-matched rewriting of the assembled
system prompt. Guarding behaviour belongs to `@t4r71/dsh-guard`.

## Layout

| Path | Role |
| --- | --- |
| `src/index.ts` | The plugin class and the waterfall listener |
| `src/config.ts` | The Loader-entry `Config`, all fields volatile, and the settings-directory read, which returns the REASON it has no directory instead of `undefined` |
| `src/sections.ts` | The three upstream invariants, the API-shape gate, and the complete-shape test |
| `src/digest.ts` | Section digests and list comparison |
| `src/naming.ts` | The three match kinds, their compiler, and the nearest-name hint |
| `src/actions.ts` | The five actions |
| `src/rewrite.ts` | The pass: order, `required` semantics, the final invariant check |
| `src/rules.ts` | The rule file: path resolution, reading, schema validation |
| `src/yaml.ts` | The YAML subset reader |
| `src/transform.ts` | The declarative, shape-preserving transforms a rule applies to a section's text instead of replacing it |
| `src/observe.ts` | The five artifacts and the purity record |
| `src/cache.ts` | The capped cache-stability ledgers: the prompt fingerprint, the section diff, and the per-request usage record |

## Building

```sh
pnpm install      # resolves this package's own dependencies
pnpm run build    # tsc -b && tsdown
```

`tsc -b` writes declarations and the intermediate JS to `lib/types`; `tsdown`
bundles `lib/types/index.js` to `lib/index.js` with the `@deepseek-ai/*` peers
externalized. The build does not need the workspace it lives in.
