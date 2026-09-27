# Adversarial review — two-layer stream-guard design

Reviewer: design-verifier. Repo `M:/dsh`, read-only on `src/`. All probes written as NEW files
under `packages/guard/stream-guard/tests/verification/`. No existing file or source file was modified.

## Verdict up front

| Finding | Verdict |
|---|---|
| F1 bimodal 8-gram Jaccard | **REPRODUCED** (counts off by +1, corpus is live) |
| F2 only 3 of 8 independent | **REPRODUCED** exactly |
| F3 layer 1 fires 45-49 chars, blind on long-line copy | **REPRODUCED** exactly |
| F4 echoR 1.000 floods / <=0.20 healthy, fires at len 8, 0.58-0.76 on config quote | **PARTLY FALSIFIED** — the core statistic holds, three of its supporting numbers do not |
| F5 matched floor suppresses the FP and makes latency tunable | **FALSIFIED** — the floor cannot suppress the FP it was proposed for |
| ">=99.9% recall" measurable from this corpus | **NOT MEASURABLE** — 3 independent positives; bound is 36.8% |
| 1024-char layer-2 budget | **FEASIBLE ONLY WITH FULL 1024-CHAR HOLDBACK** — no holdback, no layer 2 |

---

## 1. Reproduction (F1, F2, F3)

`node packages/guard/stream-guard/tests/verification/restate-scan.mts`:

```
messages with reasoning >= 1500 chars: 1447        (Lead: 1446)
  0-  5% : 1427    (Lead: 1426)
  5- 10% : 11      (Lead: 11)
 10- 15% : 1       (Lead: 1)
 95-100% : 8       (Lead: 8)
```

F1 **reproduces**. Every count is +1 versus the Lead's run because the corpus is live and this
very task appended an assistant message to it. The shape is unchanged: **nothing in 15-95%**.
The +1 drift is itself evidence for CORPUS.md §4's warning — any number read off this corpus is
a moving target.

F2 **reproduces exactly**: 3 INDEPENDENT (`b923ce6b` 120036, `session-d531c71b` 115071,
`session-3ef35930` 7155) and 5 self-study. My run resolved the same eight, with the same split.

`npx tsx .../latency-probe.mts`:

```
filler lexicon (Let me write. xN)      filler fires at     49 | prefix fires at     48
prefix drift (short intent clauses)    filler fires at     46 | prefix fires at     45
catastrophic copy (long lines)         filler fires at     -1 | prefix fires at     -1
healthy prose                          filler fires at     -1 | prefix fires at     -1
```

F3 **reproduces**. I extended it (`blindness-probe.mts`) to confirm the *reason*, which
matters for the design:

- the catastrophic long line is 109 chars; `MAX_SHORT_LINE = 60`, so `isFiller()` is `false`;
- the prefix rule needs a clause **terminator** and a **20 non-whitespace-character** gap
  tolerance, so a long line resets its counter between the two sentences it contains.

Layer 1 blindness is **structural, not incidental** — and it extends to the shape that actually
matters. On a verbatim-restatement body (the shape all 8 floods have), layer 1 is blind at
**every delta size** I tried (1, 7, 64, 512): both `filler` and `prefix` return `-1`.

---

## 2. F4/F5 — the attack

The design's layer-2 rule is reconstructed as:

```
echoR   = |grams8(reasoning) INTER grams8(text)| / |grams8(reasoning)|
coverT  = |grams8(reasoning) INTER grams8(text)| / |grams8(text)|
matched = coverT * charLen(text)          <- the proposed absolute floor
fire    = echoR >= ECHO_R  AND  matched >= FLOOR
```

### 2.1 First: the baseline actually holds on this corpus

`echo-separation.mts` reproduces the Lead's separation — and shows *why* it looks so clean:

| population | echoR | matched |
|---|---|---|
| 8 floods | 0.9997 – 1.0000 | 4369 – 120036 |
| 1440 healthy messages | max **0.1206** | max 3436 |

Across all 1448 messages the `matched` histogram is:

```
matched [    0,   64): 1275      matched [ 1024, 2048):    1
matched [   64,  128):  123      matched [ 2048, 4096):    1
matched [  128,  256):   31      matched [ 4096, 8192):    3
matched [  256,  512):    7      matched [ 8192,   inf):    5
matched [  512, 1024):    2
```

There is a **gap between 2048 and 4369 with nothing in it**, and **no healthy message anywhere
above echoR 0.5**. That gap is the entire basis for F5. It is also an artifact — see 2.3.

### 2.2 F5 FALSIFIED: the floor cannot suppress the FP it was proposed for

`echo-fp-sweep.mts` builds healthy quotation shapes and sweeps the floor. The result is that
**`matched` and `echoR` are not independent axes** — a longer legitimate quotation raises *both*.
There is no floor value that separates them:

| healthy shape (all legitimate) | lenR | lenT | echoR | coverT | matched |
|---|---|---|---|---|---|
| 30-line verbatim code quote | 3015 | 2947 | 0.7322 | 0.8729 | 2572 |
| 14-clause policy text quoted back | 2719 | 2657 | 0.7650 | 0.9015 | 2395 |
| 40-row generated table quoted back | 2776 | 2718 | 0.8986 | 0.9794 | 2662 |
| 16-clause CJK policy quoted verbatim | 878 | 864 | 0.8763 | 0.9477 | 819 |
| summary + 3 verbatim sentences | 4305 | 1200 | **0.9904** | 0.9559 | 1147 |
| numbered plan quoting 4 reasoning sentences | 3444 | 469 | 0.4633 | 0.8556 | 401 |

Sweeping the floor from 0 to 512, the maximum healthy `echoR` **never drops below 0.9904** —
because the shape that produces it (`summary + verbatim sentences`, matched 1147) is *already*
above every floor small enough to admit a real flood. Raising the floor to 512 removes exactly
one shape and leaves the 0.9904 one untouched.

**The floor is a filter on a different quantity than the one that causes the false positive.**
It cannot work, and F5's claim that it "makes layer-2 latency tunable and monotone" is false in
the sense that matters: it does not buy separation.

### 2.3 THE KILL: a healthy answer that restates its own reasoning

`echo-kill2.mts`. This is ordinary, healthy model behaviour: the model thinks, then answers with
the same content in the visible channel. The text is **not a loop** — every sentence is distinct.

| healthy case | lenR | lenT | echoR | coverT | **matched** | fires? |
|---|---|---|---|---|---|---|
| reasoning 860 chars, answer restates it | 860 | 886 | **1.0000** | 0.9694 | **859** | **FIRES** |
| reasoning 1721, answer restates it | 1721 | 1747 | **1.0000** | 0.9719 | 1698 | **FIRES** |
| reasoning 4304, answer restates it | 4304 | 4330 | **1.0000** | 0.9719 | 4208 | **FIRES** |
| reasoning 8609, answer restates it | 8609 | 8635 | **1.0000** | 0.9719 | 8393 | **FIRES** |
| reasoning 4 sentences restated 3x | 420 | 1278 | **1.0000** | 0.9502 | 1214 | **FIRES** |
| reasoning 6 sentences quoted once | 645 | 653 | **1.0000** | 0.9871 | **645** | **FIRES** |

The third-to-last row reaches **echoR = 1.0000 with matched = 645** — three orders of magnitude
*below* the smallest flood's matched (4369, and that one is a self-study artifact). No floor can
exclude it without also excluding `session-d50364e9` (4369) and `session-3ef35930` (7155).

**This is a false positive at echoR = 1.0, the same value as every flood.** The statistic that
F4 rests on — "1.000 on all 8 catastrophic samples and <= 0.20 on healthy traffic" — has a
healthy shape at exactly 1.000.

### 2.4 F4's three supporting numbers, corrected

**(a) "fires at text length 8" — FALSIFIED.** `echo-boundary.mts` walks text length with a
3290-char reasoning buffer:

```
textLen  echoR     coverT   matched   fires@0.9
      7  0.0000    0.0000       0.0   -
      8  0.0106    1.0000       8.0   -
     40  0.3511    1.0000      40.0   -
```

A text needs ~93 characters for echoR to clear 0.9 against a 3000-char buffer. The real
pathology is not short text — it is that **`matched` is completely invariant to reasoning-buffer
size** (92.9 at reasoning = 188 and at reasoning = 6016). The `echoR`-alone failure mode is real;
"text length 8" is the wrong description of it, and it led the design to a floor that does not
address the actual failure.

**(b) "0.58-0.76 on a healthy config quote" — NOT REPRODUCED.** My config-block quote
(`echo-gap.mts`) scores **echoR = 0.1444, coverT = 0.2492, matched = 104**. A config block is
short and mostly key names; it does not push echoR up. The quote shapes that *do* push it up are
the verbatim code/policy/table quotes in 2.2, which the Lead's number understates (0.73-0.99).

**(c) honesty check on the "<=0.20 healthy" claim — MISLEADING.** It is true of *this corpus*,
but only because this corpus contains **no healthy long self-quotation at all**:

```
assistant messages total                              : 6253
text >= 200 chars quoting a 200-char reasoning window :    8   <- all 8 are the floods
```

Zero healthy messages in 6253 quote their own reasoning at length. The corpus is a
**degeneration-heavy development corpus** whose healthy half happens to contain no extended
self-quotation. Treating "healthy echoR <= 0.20" as a property of healthy traffic is exactly the
error CORPUS.md §4 warns about in a different guise.

### 2.5 What I could NOT break

Stated plainly, so the failed attempts count as evidence too:

- **Faithful *paraphrase* summary** (`echo-fp-probe.mts`, shape A): echoR 0.170, matched 146. Safe.
- **CJK paraphrase** (shape E): echoR 0.779, matched 120 — high echoR but far below any useful floor.
- **Near-verbatim translation** into another language (shape H): echoR **0.005**. Gram overlap is
  script-bound; a translated answer is invisible to this metric. Safe, but see the miss below.
- **Changelog / licence / generated table** *as fresh text* (shapes C, D, I): echoR 0.35-0.79 —
  below 0.9. They only become dangerous when *quoted from reasoning*, which is 2.2's finding.
- **Short text inside a huge buffer** (shape F): `matched` is small and *does not grow* with
  buffer size, so a floor >= 128 does suppress it. The Lead's floor does fix *this* case.

So: F5 is not universally broken. It is broken for the case it was introduced to fix, and the
case it does fix (short text in a big buffer) is not the one that threatens the design.

### 2.6 The symmetric miss (not asked, but load-bearing)

`echoR` is `|grams(reasoning) INTER grams(text)| / |grams(reasoning)|`. A model that degenerates
**inside the text channel only** — no reasoning block, or reasoning that does not contain the
loop — has `echoR = 0` and is invisible. Of the 8 floods, all 8 have reasoning and text as
*byte-identical twins* (lenR - lenT is 0 or 2 in every row). The corpus contains **no instance**
of a text-only collapse, so the design has never been tested against the shape where `echoR` is
structurally blind. A recall claim of 99.9% over this corpus does not cover it.

---

## 3. Is ">=99.9% recall" measurable from this corpus? **No.**

### The denominator

The natural positive unit is *a degeneration event the model produced*. Nobody has enumerated
those. The corpus supplies three candidate denominators, all flawed:

| candidate denominator | count | why it is not the right one |
|---|---|---|
| assistant messages with reasoning >= 1500 chars | 1448 | almost all negative; not an event count |
| messages with echoR >= 0.9 | 8 | **selected by the detector under test** — circular |
| independent (non-self-study) positives | **3** | the only defensible number |

Every one of the 8 was found *by* `echoR >= 0.9`. There is no detector-free ground-truth list of
degeneration events, so **recall against this corpus is not falsifiable** — a missed event is
invisible by construction, because the only way an event enters the set is by the detector firing.

### Statistical power with 3 independent positives

`recall-power.mts` computes exact Clopper-Pearson one-sided 95% lower bounds:

| scenario | n | k | lower 95% bound on recall |
|---|---|---|---|
| all catastrophic samples caught | 8 | 8 | **68.77%** |
| independent samples caught | 3 | 3 | **36.84%** |
| a 1000-event corpus, all caught | 1000 | 1000 | 99.70% |
| a 3000-event corpus, all caught | 3000 | 3000 | **99.90%** |

To claim a 95%-confident lower bound of 99.9% recall you need

```
0.999^n <= 0.05   ->   n >= 2995 independent positives with ZERO misses
```

The corpus supplies **3**. It is short by a factor of **998**.

Concretely, "3/3 caught" is consistent with a true recall as low as **36.8%** at 95% confidence.
A detector whose real recall is 40% shows 3/3 with probability 0.064; one at 70% shows 3/3 with
probability 0.343. **The corpus cannot distinguish a 37% detector from a 99.99% detector.**

### Verdict on the target

">=99.9% recall" is **meaningful as an engineering goal and meaningless as a claim from this
corpus.** Two further problems make it worse than a sample-size issue:

1. **2 of the 3 independent positives are the same session** pattern (`session-d531c71b` supplies
   both 115071 and, per CORPUS.md, blocks #1437/#1438/#1439). Events within one session are not
   independent trials; the effective n is closer to 2 than 3.
2. **The positives are twins, not a distribution.** All 8 have `coverT = 1.0000` and `lenR` within
   2 of `lenT`. They are one failure mode sampled 8 times, not 8 kinds of failure. A 99.9% recall
   bound computed over one degenerate family says nothing about the families the guard misses —
   text-only collapse (§2.6), line-granular bleed (README, Known Limitations), and semantic
   repetition in fresh wording are all documented as *invisible by design*.

A defensible restatement: *"the detector caught 8/8 known floods, of which 3 are independent;
the 95% lower bound on recall is 36.8%, and no recall target above ~70% is supportable from this
corpus."* If a 99.9% claim is required, it needs a held-out, detector-independent, time-frozen
corpus with >= 2995 labelled events — which does not exist here.

---

## 4. The 1024-character layer-2 budget

### It is feasible — but only with the full holdback, which the design wants to avoid

Constants as shipped: `CYCLE_MIN_SPAN = 512`, `CYCLE_MAX_PERIOD = 512`,
`CYCLE_MIN_SPAN + CYCLE_MAX_PERIOD = 1024` (the `cycleHold` default), schema floor `>= 1024`.

The earliest a cycle verdict can fire is `max(512, 2 * period)` characters
(`blindness-probe.mts`):

```
period=2..256   -> fires at 512    WITHIN BUDGET
period=257      -> fires at 544    WITHIN BUDGET
period=400      -> fires at 800    WITHIN BUDGET
period=512      -> fires at 1024   EXACTLY AT BUDGET
```

So **the 1024-char budget is exactly `2 * CYCLE_MAX_PERIOD`, and it is exactly large enough and
not one character more.** For any period above 512 the rule cannot fire inside the budget at all —
by construction, since 512 is the maximum period considered.

### Is it feasible *without* holdback? No.

This is the load-bearing point and the design's own code says so. `cycleFloor()` returns
`chars.length - cycleHold`; `takeSafe()` takes `min(runStart, cycleFloor())`. The rule is
**retrospective**: it recognises a repetition only after the repetition exists, so the text it
needs is text it must not have published. With `cycleHold = 1024` the guard cannot release the
last 1024 characters, and the verdict is reachable at 512-1024. Without that holdback the verdict
still *fires* at 512-1024 but the loop has already been published, and a published delta cannot be
retracted (README: `agent/assistant-stream` publishes live).

**Layer 2 at a 1024-character budget is a holdback design. There is no holdback-free variant at
that budget.** The design should say so explicitly rather than presenting 1024 as a latency target
that might be met cheaply.

### The visible-delay cost on the text channel

Measured with realistic newline-terminated prose (`delay-probe2.mts`, 22090 chars / 200 lines):

| cycleHold | peak lag | final lag | visible% |
|---|---|---|---|
| 0 (rule off) | 110 | **0** | 100.0% |
| 64 | 110 | 64 | 99.7% |
| 256 | 256 | 256 | 98.8% |
| 512 | 512 | 512 | 97.7% |
| **1024** | **1024** | **1024** | **95.4%** |

The lag is **not** a startup delay — it is a **permanent sliding window**. The user sees text up to
`now - 1024` for the entire answer. Consequences:

- The tail 1024 characters of *every* answer appear only when the block closes.
- An answer shorter than 1024 characters is **completely invisible until it ends**:

```
answer=327 chars  -> visible before close=0    NOTHING SHOWN UNTIL THE END
answer=872 chars  -> visible before close=0    NOTHING SHOWN UNTIL THE END
answer=1640 chars -> visible before close=616
```

- At a typical 60 chars/s this adds **~17 seconds** before the first character of a short answer.

This independently confirms the README's measurement (74 -> 1024 chars of lag on 9010 chars of
healthy prose) and the decision to keep `cycleText: false`. **The design's own conclusion is
correct and the numbers hold.** A layer-2 rule that must fire within 1024 characters and is
retrospective therefore belongs on the reasoning channel only, exactly as shipped.

---

## 5. Bottom line

1. **F1, F2, F3 reproduce.** Layer 1 is fast (45-49 chars) and structurally blind on the
   restatement shape — confirmed at every delta size, not just the probe's.
2. **F4's core statistic reproduces on this corpus** (8 floods at ~1.0, healthy at <=0.12) but
   **three of its supporting numbers do not**: it does not fire at text length 8 (needs ~93);
   the config quote is 0.14, not 0.58-0.76; and "healthy <= 0.20" is an artifact of a corpus
   containing **zero** healthy long self-quotations in 6253 messages.
3. **F5 is falsified.** `matched = coverT * len(text)` is not an independent axis from `echoR`;
   it rises with the same long legitimate quotes that raise `echoR`. The maximum healthy `echoR`
   never falls below **0.9904** at any floor up to 512, and a healthy answer that restates its
   own reasoning fires at **echoR = 1.0000 with matched = 645** — below every flood. The floor
   does suppress the one case it was not needed for (short text in a big buffer).
4. **A two-layer design on this metric needs a different discriminator than an absolute floor.**
   The candidate that actually separates the two populations in this corpus is `coverT`
   (floods 1.0000 vs healthy <= 0.98) *combined with* an explicit exclusion for quoted material —
   i.e. content type, not volume. Volume is the wrong variable.
5. **">=99.9% recall" is not measurable here.** 3 independent positives (effectively ~2, one
   session) give a 95% lower bound of **36.8%**; 2995 independent positives with zero misses are
   needed to bound 99.9%. The 8 positives are also one failure mode sampled 8 times, and none of
   them exercises the text-only collapse where `echoR` is structurally blind.
6. **The 1024-char layer-2 budget is feasible only with the full 1024-char holdback** — the rule
   is retrospective, so the budget *is* the holdback. The visible cost is a permanent 1024-char
   delay on the text channel, total invisibility for answers under 1024 chars, ~17 s to first
   character at 60 chars/s. Put layer 2 on reasoning only, as the shipped defaults already do.

### Probe files (all new, none modifying existing code)

| file | what it establishes |
|---|---|
| `tests/verification/echo-fp-probe.mts` | 9 healthy shapes vs the echoR+floor rule |
| `tests/verification/echo-fp-sweep.mts` | floor sweep; max healthy echoR never < 0.9904 |
| `tests/verification/echo-separation.mts` | floods vs 1440 healthy on echoR/coverT/matched |
| `tests/verification/echo-boundary.mts` | falsifies "fires at text length 8"; matched invariance |
| `tests/verification/echo-kill.mts` | extractive-recap family scaling |
| `tests/verification/echo-kill2.mts` | **the kill: healthy self-restatement fires at echoR 1.0, matched 645** |
| `tests/verification/echo-real-corpus.mts` | matched distribution, danger zone is empty in this corpus |
| `tests/verification/echo-gap.mts` | the gap is a corpus artifact; 0/6253 healthy self-quotations |
| `tests/verification/recall-power.mts` | Clopper-Pearson bounds; n >= 2995 needed for 99.9% |
| `tests/verification/budget-probe.mts` | cycle earliest-fire formula vs the 1024 budget |
| `tests/verification/delay-probe.mts` | first (superseded) delay measurement |
| `tests/verification/delay-probe2.mts` | corrected realistic visible-delay numbers |
| `tests/verification/blindness-probe.mts` | layer-1 blindness at all delta sizes; budget boundary |
