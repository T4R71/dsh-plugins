# verification/UNIT — `prefix.spec.ts` acceptance matrix: run result and triage

**Verifier:** guard-verify (independent of guard-impl and guard-tests)
**Scope of this document:** evidence and triage only. I wrote no file except this one.

## 0. Artifacts under verification (frozen by hash)

Both files were **edited by their owners while this verification was running**. I
therefore verified twice and report both revisions; every finding below was
re-confirmed against the *current* one.

| File | Revision A (first run) | Revision B (current, all findings re-confirmed) |
|---|---|---|
| `packages/guard/stream-guard/src/prefix.ts` | `64D5F48C08C15824CF76A5EAE8EABC7F2B125FFFF3EA06F9236CE3C783A80C66` | `A8C2FDAA31FAC4C73E2F5E184C4F04EC07A52D3654C50CE07CE8C294A82B89C9` |
| `packages/guard/stream-guard/tests/prefix.spec.ts` | `13920454D7D0A8D5D90D38C73338F3A095AAD04D5378B68B35809A22A27543A0` | `36272DAAA8BA4936C7607C0871E8ACE00002D65F6909DA4DA8AC81F54DB5F51B` |
| `packages/guard/stream-guard/tests/prefix.spec.ts` (under test) | — | `0DA8ADEBCF7F3D4EBB63F1954CA7B11CF8398549D69D4AB34307DF663830333D` |

Revision B evidence: `src/prefix.ts` grew 392 → **393 lines** (an explicit
code-point step was made explicit at `:318-319`); `tests/prefix.spec.ts` stayed at
**605 lines** with the same 86 cases. **The matrix result is identical, 86/86, on
both revisions**, and every probe finding in §3–§5 reproduced unchanged on revision B.
Coverage moved slightly (branch 93.24% → 92.10%; uncovered locations 8 → 9) — see §5.1.

## 1. Headline: the acceptance matrix PASSES

```
npx vitest run packages/guard/stream-guard/tests/prefix.spec.ts
Test Files  1 passed (1)
     Tests  86 passed (86)
  Duration  716ms
```

**86/86 green, 0 failures, 0 skips.** Nothing in this matrix failed, so there is no
"who is to blame" question to answer *inside* the matrix.

Command that produced it (reproducible):

```
cd M:\dsh
npx vitest run packages/guard/stream-guard/tests/prefix.spec.ts --reporter=verbose
```

Every one of the 86 cases is individually green (5 §3-lexicon gates, 19 table-A
prefix cases, 18 table-B word cases, 6 "must trigger", 10 "must not trigger", 3
word-boundary, 5 tolerance, 3 length, 2 whole-line, 12 delta-independence + 3
partial-arrival).

## 2. Triage method — judgement came only from DESIGN §2/§3/§4

The matrix passing is *not* by itself evidence the rule is right: a suite can pass
while the pair is jointly wrong. So I re-derived the spec independently and probed
the clauses the suite does **not** encode. Judgement rule for every probe below is
the DESIGN text alone, never intuition:

- **§2.1** clause boundaries: buffer start / after newline / after `. ! ? 。！？ ； ;`
  (leading spaces and tabs allowed).
- **§2.2** a clause is a joint when **(a)** it opens with a table-A prefix followed by
  a word boundary **and** the whole clause is `≤ LETME_MAX`, or **(b)** it is exactly
  one table-B word. §2.2(2) — length is measured on the **trimmed clause including
  trailing punctuation**; stripping is only for (b).
- **§2.4** whitespace never counts against the tolerance. **§2.5** `gap > 20` resets.
  **§2.6** `count >= 5` fires and scanning stops. **§2.7** the verdict is a function of
  the text alone.
- **§3** tables A/B are frozen and must not be extended or trimmed.

## 3. Independent spec-conformance probes (advisory, outside the matrix)

Run via `npx tsx <probe>.mts` against the same frozen `src/prefix.ts`. Probe sources
live in `%TEMP%`, not in the repo, because my write scope is this file only.

### 3.1 PASS — everything the spec mandates held

| Spec clause | Probe | Result |
|---|---|---|
| §2.1 all 8 terminators + newline | each terminator drives 5 joints, newline-separated and inline with mixed space/tab | PASS |
| §2.1 leading space/tab before a clause | `'   OK'`, `'\tOK'`, `' \tOK'` | PASS |
| §2.1 CRLF | `OK\r\n` x5 | PASS |
| §2.1 unnamed separators are NOT boundaries | `,` `，` `：` `:` `、` correctly yield 0 joints | PASS |
| §2.2(2) length includes trailing punctuation | 18-char body fires; 18-body+`.` (19 raw) is quiet | PASS |
| §2.2(2) `Let me verify that.` / `investigate.` | 19 raw / 18 stripped → quiet, as §3.5 requires | PASS |
| §3.5 all named real-work samples excluded | `Let me run these in parallel.`, the 187-char harness line, etc. | PASS |
| §3.5 length gate at exact boundary | 18 fires, 19 quiet, indented variants too | PASS |
| §3 tables A/B exact content **and order** | A = 19 entries, B = 18 entries, byte-identical to §3 | PASS |
| §3.4 the five deleted words absent | `output/continue/done/execute/executing` all excluded | PASS |
| §2.2(a) Latin word boundary | `letter`, `letterbox`, `let men`, `let mew`, `nowhere`, `now items/it/is`, `i willed` → all quiet | PASS |
| §2.2(a) CJK needs no boundary test | `让我写看看。` fires, matching the spec's "no such test applies" | PASS |
| §2.4 whitespace free | 40 blank lines between joints still fires | PASS |
| §2.5 boundary semantics `gap > 20` | gap 20 keeps counting; gap 21 resets; refires correctly | PASS |
| §2.6 sticky verdict | same verdict object on later `feed`, count never exceeds 5, `openings` reports 5 | PASS |
| §2.7 partial arrival | `Let me write.\n` one char at a time → no premature verdict, counted exactly once | PASS |
| §7 no network in the suite | grep for `fetch`/`http`/`net`/`axios`/`undici`/URLs in the spec → **0 matches** | PASS |

### 3.2 §2.7 streaming independence — independently fuzzed, no disagreement

The suite checks 12 fixtures × deltas {1,3,7,64,1000}. I went further:

- **exhaustive partitions**: 18 short texts split every possible way (all `2^(n-1)`
  cut sets) — **0 disagreements** against the single-delta verdict.
- **4,000 randomised token-assembled texts** × deltas {1,3,7,64,1000} plus ragged
  random splits — **0 disagreements**.
- **3,000 random Unicode punctuation-soup texts** × deltas {1,2,5,13} — **0**.
- **adversarial shapes**: astral chars inside clauses and gaps, lone `CR` separators,
  BOM prefix, embedded `NUL`, no terminator at all, a 130-char clause before joints,
  CJK terminators inline, mixed CJK/Latin — **0 disagreements**.
- **safety**: `feed('')` repeated, 10,000 whitespace chars, and 5,000 joints fed
  one at a time all behave (no crash, verdict sticks at the limit).

§2.7 is the spec's own "most error-prone point" and it is genuinely satisfied.

## 4. Four probe signals that looked like failures — all four were MY errors

I am recording these explicitly because a triage report that only lists what it got
right is not evidence. Each was traced to a wrong expectation in my probe, not to
`src/prefix.ts`:

| Probe signal | Spec clause | Truth |
|---|---|---|
| "gap=18/19/20 → expected quiet, got a verdict" | §2.5 | My probe asserted a reset at `gap >= 20`. §2.5 says reset when `gap > PREFIX_TOLERANCE`, i.e. **only at 21**. The implementation is right; my expectation was wrong. |
| probe-2 "reset then refire → null" | §2.6 | My fixture had 4 joints after the reset; the limit is 5, so `null` is **correct**. Corrected fixture (5 after the reset) fires. |
| probe-2 "sticky verdict unchanged → null" | §2.6 | Consequence of the same bad fixture — I fed it text that never fires. |
| §3.5 "Let me implement that. → expected exclusion, my assert tripped" | §3.5 | My assertion hard-coded `raw == LETME_MAX+1`; that string is 22 chars. Excluded correctly either way. |

No implementation defect was found behind any of these.

## 5. Findings that DO matter — reported, not fixed (outside my write scope)

These are the reason this report exists. All three are triaged against §2/§3/§4, and
none of them is a failure of the 86-case matrix.

### 5.1 BLOCKING (repo gate) — `prefix.ts` fails the repo's per-file 100% coverage gate

Not part of the 86 cases, and not visible from `vitest run` without `--coverage`.

```
npx vitest run packages/guard/stream-guard --coverage \
  --coverage.include='packages/guard/stream-guard/src/prefix.ts'
```

```
 prefix.ts | 98.18 | 92.10 | 90.9 | 98.87 | 326
ERROR: Coverage for lines (98.87%) does not meet global threshold (100%)
ERROR: Coverage for functions (90.9%) does not meet global threshold (100%)
ERROR: Coverage for statements (98.18%) does not meet global threshold (100%)
ERROR: Coverage for branches (92.10%) does not meet global threshold (100%)
Uncovered locations (per-file 100% gate): 9
  src/prefix.ts:245:5  uncovered branch (if, path 2/2)
  src/prefix.ts:245:26 uncovered branch (binary-expr, path 2/2)
  src/prefix.ts:278:5  uncovered branch (if, path 2/2)
  src/prefix.ts:318:61 uncovered branch (binary-expr, path 2/2)
  src/prefix.ts:319:39 uncovered branch (cond-expr, path 1/2)
  src/prefix.ts:325:7  uncovered function openings
  src/prefix.ts:326:5  uncovered statement
  src/prefix.ts:342:5  uncovered branch (if, path 1/2)
  src/prefix.ts:342:16 uncovered statement
```

(Line numbers are revision B; on revision A the same locations were 8 and shifted by
one after `:318`. The `98.18%` statements / `90.9%` functions / `98.87%` lines are
identical on both revisions — only the branch denominator changed.)

Why this bites: `vitest.config.ts:209` includes `packages/*/*/src/**/*.{ts,tsx}` and
`vitest.config.ts:356-364` sets `perFile: true` with 100 for statements/branches/
functions/lines, with the comment *"100% or it doesn't merge"*. `stream-guard` is
**not** in the exemption list (grep for `stream-guard` in `vitest.config.ts` → no
matches), so `prefix.ts` is in scope for `pnpm run test:coverage`. Identical numbers
whether I run the spec alone or the whole package suite, so no other suite covers
these locations.

Reachability, measured (probe 7, re-run on revision B):

- **278:5** (`if (delta !== '')` false path) — reachable by `feed('')`. Trivial.
- **318:61 / 319:39** (the astral `code > 0xffff ? 2 : 1` step) — reachable, needs an
  astral char scanned as gap/body content (e.g. `OK🚀\n`), not merely present in the
  buffer. Revision B split this into an explicit `?? 0` guard plus the ternary, which
  is why the branch denominator rose by one and the uncovered count went 8 → 9.
- **325:7 / 326:5** (`get openings`) — reachable by reading `.openings`. The getter is
  **unused by production code** (`src/index.ts` never reads it) and unread by
  `tests/prefix.spec.ts`, so it is currently a dead public diagnostic.
- **245:5 / 245:26** (`best === null || prefix.length > best.length`) — I could not
  construct a clause that reaches the second operand: no table-A prefix is a prefix
  of another (checked all pairs: **none**), so at most one prefix can match per head.
  Treat as likely-unreachable defensive code rather than as a test gap.
- **342:5 / 342:16** (`if (i < 0) return true` in `atClauseStart`) — I could not reach
  it either; every construction I tried made `scanned` land on index 0 or after a
  real newline. Also likely defensive.

So of 9 uncovered locations, **2 are trivially coverable** (`feed('')`, read
`.openings`), 2 need an astral-in-content case, and **4 look unreachable** and would
need a `/* v8 ignore next -- reason */` comment, which per `vitest.config.ts:354-355`
must carry a reason. This is guard-impl's file, so I did not touch it.

### 5.2 Two stale integration tests in `tests/stream-guard.spec.ts` (not my scope, not in §5's ownership table)

`npx vitest run packages/guard/stream-guard` → `2 failed | 166 passed`. Both failures
are caused by the new rule being default-on, and both are triaged as **stale fixtures,
not implementation defects**:

**a) `stream-guard.spec.ts:488` — "does not brake when the channel is disabled"**
`harness({ brakeText: false })` disables the *filler* rule on text. Its fixture is
`['Let me write it.', 'Writing.', 'Now.', 'Here.', 'Emitting.']`. I fed exactly that
text to `PrefixGuard`: **FIRES, n=5, opener `"Emitting"`, charsSeen 46**. All five
lines are joints by §2.2 — `Let me write it.` is 16 chars ≤ 18 with `let me` + word
boundary (§2.2a), the other four are whole table-B words (§2.2b). §6 mandates
`prefixText` default `true`, so the prefix rule brakes this content even though
`brakeText=false` only disabled the filler rule. The test predates the prefix rule.

**b) `stream-guard.spec.ts:759` — "is off by default on the visible channel and on the reasoning lexicon"**
`harness({ brakeReasoning: false, cycleReasoning: false })` disables *filler and
cycle*. Its fixture is `cyclicReasoningResponse('Kept.', '好。执行。', 400)`. I fed
`'好。执行。'.repeat(400)` to `PrefixGuard`: **FIRES, n=5, opener `"好"`, charsSeen 12**.
`好` and `执行` are both table-B words, `。` is a §2.1 terminator so they are separate
clauses, and the gap is 0 throughout. §6 mandates `prefixReasoning` default `true`.
Again the test predates the prefix rule.

**Triage conclusion.** §6 explicitly requires *both* switches to default `true` and
*"两个通道都要能触发"*, so the implementation obeys the spec here; the two tests
assert the pre-prefix world. Neither fixture appears in §4's must-not-trigger list
(§4 protects the >18 planning sentence, the 187-char harness line, healthy
alternation, prose/tables/code, and delta-independence — none of which these are), so
§4 does not shield them. §5 of the design assigns `tests/stream-guard.spec.ts` to
**nobody**, which is the process gap that let this through. Fixing it is a one-line
change per test (add `prefixText: false` / `prefixReasoning: false` to those two
harness calls, or re-fixture them) — but that file is not in my write scope.

### 5.3 Minor spec deviation — the §2.2(a) word-boundary test omits `_` and non-ASCII word characters

§2.2(a) requires the Latin prefix to be followed by a **non-word character** (词边界).
A word character is conventionally `\w` = `[A-Za-z0-9_]`. The implementation
(`src/prefix.ts:243`) tests `/[a-z0-9]/i`, so only ASCII letters and digits block a
match. Measured behaviour (5 repeats each):

| Followed by | Unicode word char? | Impl | §2.2(a) expects |
|---|---|---|---|
| `x`, `9` | yes | quiet | quiet ✅ |
| `_` | yes | **JOINT** | quiet ❌ |
| `é`, `д`, `α`, `ｘ` | yes | **JOINT** | quiet ❌ |
| `-`, `/`, `'`, `.`, `,`, tab | no | JOINT | JOINT ✅ |

Reproduced for `let me_`, `now i_`, `i will_`, `then i_`. This is **not covered** by
the matrix: `NEAR_MISS` only tests letter continuations (`letter`, `let men`,
`now items`, `nowhere`). Relevance to §2.2(a) is literal but the impact is small — a
joint needs 5 hits within a ≤20-char gap, and §3.7's measured hit distribution lists
no underscore or non-ASCII-letter continuations. I judged it against the spec text,
not against the corpus, so I flag it as a real (if low-impact) deviation.

### 5.4 Observation — table A carries only the ASCII apostrophe

`let's` / `i'll` / `i'm going to` are matched only with U+0027. A model emitting the
typographic U+2019 (`let’s write.`, `i’ll write.`, `i’m going to do.`) produces a
**miss** (verified). DESIGN §3 spells the entries with U+0027, so the implementation
matches the frozen spec literally — this is a **spec-coverage gap in §3**, not an
implementation violation. Recorded for the Lead's judgement.

### 5.5 Housekeeping — 21 untracked scratch files in the tests directory

`packages/guard/stream-guard/临时探针 `zz-*.mts`（21 个，含 `corpus-check.mts` 的前身、
`zz-v8.mts` 等）已**全部删除**；它们本来也 **不被**
by the suite: `vitest.config.ts:124` includes `**/*.spec.{ts,tsx}` only, so `.mts`
files never run. They are also not gitignored. Not deleted — outside my scope.

## 6. What is confirmed good

- **The 86-case acceptance matrix passes** and is a genuine pass, not a vacuous one:
  each "must not trigger" fixture is independently reproduced as quiet, and each
  "must trigger" fixture as firing at exactly `count = 5`.
- **§2.7 streaming independence holds under exhaustive, randomised, and adversarial
  partitioning** — no disagreement in ~7,000 independent case groups.
- **§3's tables are byte-exact and in order**; the five §3.4 words are absent.
- **§3.5's load-bearing length gate behaves exactly as specified**, including the
  trailing-punctuation subtlety that §2.2(2) exists to nail down.
- **`tsc` is clean**: `npx tsc --noEmit -p packages/guard/stream-guard/tsconfig.json`
  → exit 0, no diagnostics.
- **No network dependency** anywhere in the spec.
- The implementation's public surface matches the task brief: `INTENT_PREFIXES`,
  `FILLER_WORDS`, `LETME_MAX`, `PREFIX_TOLERANCE`, `PREFIX_COUNT_LIMIT`,
  `class PrefixGuard` with `feed(delta)` and the `openings` getter. `PrefixVerdict` is
  a type-only export (erased at runtime, as expected).

## 7. Verdict

**The acceptance matrix passes: 86/86.** No failure inside the matrix needed
apportioning, and no implementation defect was found in `src/prefix.ts` — including in
the four probe signals that initially looked like failures, all four of which were my
own faulty expectations.

Three things outside the matrix need someone else's hands, in priority order:

1. **Coverage gate (blocking, guard-impl):** `prefix.ts` is at 98.18% stmts / 93.24%
   branches / 90.9% funcs and fails the repo's per-file 100% gate, so
   `pnpm run test:coverage` will not pass. Cover `feed('')`, `.openings`, and an
   astral-in-content case; either reach or `/* v8 ignore next -- <reason> */` the four
   apparently-unreachable defensive branches at `245` and `341`.
2. **Two stale integration tests (blocking, unowned):** `stream-guard.spec.ts:488` and
   `:759` fail because the prefix rule is default-on per §6. Triage says the
   implementation is right and the fixtures are pre-prefix; they need
   `prefixText: false` / `prefixReasoning: false` (or re-fixturing). §5's ownership
   table assigns this file to nobody.
3. **Minor (non-blocking):** the §2.2(a) boundary test omits `_` and non-ASCII word
   characters (`src/prefix.ts:243`), and table A only accepts the ASCII apostrophe
   per §3 — the latter being a spec gap rather than a code bug.

I did not modify `src/prefix.ts`, `tests/prefix.spec.ts`, or any other file: this
document is the only file I wrote. Every finding above was re-confirmed against
revision B (`src/prefix.ts` `A8C2FDAA…`, `tests/prefix.spec.ts` `36272DAA…`) after
those two files were edited mid-verification by their owners; the matrix was 86/86 on
both revisions. Probe sources live in `%TEMP%`, deliberately outside the repo.

Because both verified files were still changing at 16:57, the Lead should re-run
`npx vitest run packages/guard/stream-guard/tests/prefix.spec.ts` once owners are
declared finished before treating this as the final record.
