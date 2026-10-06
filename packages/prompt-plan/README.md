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
```

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

## Building

```sh
pnpm install      # resolves this package's own dependencies
pnpm run build    # tsc -b && tsdown
```

`tsc -b` writes declarations and the intermediate JS to `lib/types`; `tsdown`
bundles `lib/types/index.js` to `lib/index.js` with the `@deepseek-ai/*` peers
externalized. The build does not need the workspace it lives in.
