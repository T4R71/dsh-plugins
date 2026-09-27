---
description: "Streaming degeneration guard that brakes a filler-phrase collapse mid-stream and steers a continuation, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @t4r71/dsh-stream-guard

English | [中文](README.zh.md)

## Summary

Mount this when answers degenerate into padding: repeated announcements, or the same sentence cycling hundreds of characters, and you would rather cut and resume than let it reach you. It removes the degenerate run before it is shown, then steers the model to continue from the last real work, so a collapsing answer still finishes. It counts repeated intent openings the model has no exact phrase for, not just known filler, and can nudge a final answer that only churns. The cost is a possibly shortened answer. The `dsh` base bundle runs it with no wiring.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a model occasionally loses coherence mid-answer and pads with announcements instead of finishing. There is nothing to wire: the `dsh` base bundle already runs it, and the defaults work for most sessions — tune the budgets and channels below when you want the brake sooner, later, or on reasoning as well as text.

### When to choose it

Choose it when long autonomous answers sometimes degrade into filler and you would rather cut and resume than let the padding reach the user. Avoid it when the model must be left strictly untouched — the guard can shorten an answer — and when short announcement-style lines are themselves the deliverable, because those are exactly what the detector suppresses.

### Setting the budgets and channels

When you want to change when the brake fires or how often a turn may be resumed, mount the plugin with configuration:

```yaml
- name: '@t4r71/dsh-stream-guard'
  config:
    brakeText: true            # brake a filler run in the visible answer
    brakeReasoning: false      # leave the reasoning lexicon alone (see below)
    cycleReasoning: true       # still catch a verbatim loop in reasoning
    cycleText: false           # do not hold the visible tail back for the cycle rule
    prefixReasoning: true      # count intent openings in reasoning
    prefixText: true           # count intent openings in the visible answer
    cycleHoldChars: 1024       # tail retained per channel while the cycle rule runs
    maxContinues: 2            # continuations steered per turn
    warnAfterContinues: 10     # warn past this many continuations (never a cap)
    maxHoldChars: 8192         # ceiling on characters held back per channel
    hesitationNudge: true      # nudge on hesitation churn
    hesitationBudget: 2        # nudges allowed per session
```

| Field | Default | Meaning |
|---|---|---|
| `brakeText` | `true` | Brake a proven filler run in the visible text channel |
| `brakeReasoning` | `false` | Brake a proven filler run in the reasoning channel |
| `cycleReasoning` | `true` | Run the vocabulary-free cycle rule on the reasoning channel |
| `cycleText` | `false` | Run the cycle rule on the visible text channel |
| `prefixReasoning` | `true` | Count repeated intent openings on the reasoning channel |
| `prefixText` | `true` | Count repeated intent openings on the visible text channel |
| `cycleHoldChars` | `1024` | Tail characters retained per channel while the cycle rule is active |
| `maxContinues` | `2` | Continuation prompts issued per turn after a brake |
| `warnAfterContinues` | `10` | Continuations after which the prompt carries a warning (not a cap; steering never stops) |
| `maxHoldChars` | `8192` | Ceiling on characters held back per channel |
| `hesitationNudge` | `true` | Inject a request-side nudge on hesitation churn |
| `hesitationBudget` | `2` | Hesitation nudges allowed per session |
| `verbose` | `false` | Emit brake and nudge diagnostics through the logger |

Leave `brakeReasoning` off unless you have measured a reason to change it. The filler lexicon reads short lines in the answer far more reliably than in reasoning, where a line like "Now." is ordinary connective tissue — so on reasoning the lexicon would fire on healthy thinking. The cycle rule is a different kind of evidence and is on by default there: an exact verbatim period hundreds of characters long is not something healthy reasoning does. `cycleHoldChars` must stay above 1024, because the rule cannot prove a cycle before `CYCLE_MIN_SPAN` (512) plus one period; a smaller value silently disables it rather than making it cheaper. `cycleText` is off because on the visible channel the rule's holdback is a delay the user watches, and the lexicon already covers visible collapse.

`prefixReasoning` and `prefixText` are the exception to every holdback tradeoff above: they cost **no holdback at all**. The rule judges already-complete clauses and lines — a clause opening that has finished arriving, or a whole line that is a bare filler word — so it never needs text withheld to reach a verdict, and it adds no visible delay on either channel. That is exactly why both default to `true`, and it is the contrast with `cycleText`: the cycle rule is retrospective and must hold the tail back to excise a loop, whereas this rule only counts openings that are already settled. On the visible channel a repeated intent opening is weaker evidence than in reasoning, which is why the two channels have separate switches; turn `prefixText` off if your own answers legitimately open many clauses the same way.

Invalid configuration fails at startup with a clear error — a value outside the documented range, for example `maxContinues: 999` — never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-stream-guard) documents every accepted value.

### What you get

A degeneration on either channel is suppressed rather than shown: the text before it is kept, the degenerate tail is never published, and the turn continues with a prompt naming where the output stopped and forbidding preamble. The per-turn and per-session budgets bound that recovery, so a session that keeps collapsing stops being steered and is allowed to end normally instead of looping. Separately, when a finished answer shows hesitation churn — many short lines opening with "Hmm", "Wait", "Actually" — the next request carries a nudge to commit to the best answer already available. A clean answer is passed through byte-for-byte and draws no nudge.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The guard registers on `llm/stream` and wraps the provider stream. Each channel (text and reasoning) owns a holdback buffer and three detectors, layered because they trade reach against speed. The filler lexicon matches known announcement phrases line by line and fires within tens of characters, but only on the phrases it knows. The cycle rule is vocabulary-free: it looks for an exact verbatim period in the retained tail and fires on repeated content of any kind, at a hard floor of 512 characters. The prefix rule counts intent openings instead of lines: a clause that begins with one of the known intent prefixes *and* is short enough to be an announcement (18 characters or fewer), or a line that is nothing but a filler word, increments a counter; only non-whitespace characters between two openings count against a 20-character tolerance, and exceeding it resets the counter, because the model has started doing real work again. Five openings inside the tolerance is the verdict. The length gate is load-bearing rather than cosmetic — without it, ordinary planning sentences count as openings, and with it the rule adds no false positives on reasoning traffic. Measured on degenerate shapes fed one character per delta, the lexicon fires at 30–85 characters and misses five of seven real bleeds; the cycle rule catches all seven but never before 512; the prefix rule fires within roughly 60 characters on the wording-drift shape both of those miss entirely. The three leave healthy repetitive content — a 300-row table, ordinary prose, a healthy opening followed by real work — untouched. Deltas are fed to every detector and released only up to the point confirmed free of each; everything from the current run's start onward stays buffered.

That holdback is the whole design. The detector needs evidence to prove a run, and a naive consumer would have already streamed it to the user — and a published delta cannot be retracted, because `agent/assistant-stream` publishes live and the assembled message is settled from those blocks. Holding the tail back means the run that trips the threshold is still inside the buffer when the verdict fires, so the brake drops text that was never sent. Nothing is un-sent.

The prefix rule is the one detector that does not participate in that holdback. Its evidence is a settled opening rather than a span to excise: once a clause opening or a bare filler line has fully arrived, the count can be incremented without knowing anything about what follows, and the brake keeps nothing — it publishes no prefix and drops no text. Detection is therefore streaming-safe by waiting rather than by buffering: an opening split across deltas is left pending until the next character resolves it, so the same text counts the same way at any delta size.

Two further constraints shape the recovery. A mid-stream cut cannot be resumed in place: the loop's retry ladder only fires on `error` or `aborted` finishes, the request options are deep-frozen with `options.messages === session.deriveMessages()` enforced by an invariant, and the assistant message is settled from the assembled blocks. So the brake closes the blocks it cut, emits a normal `stop`, and the continuation is steered at `agent/turn-stopping` — which keeps the turn alive and runs another step with the resume prompt in the transcript. The terminal frames must be rebuilt by hand, because the stream grammar requires a `finish` and forbids leaving a block open.

A verdict that fires while a tool call is open is declined rather than acted on: a half-open tool call assembles to nothing, so braking there would corrupt the step instead of shortening the answer. Detection is per channel and per stream; budgets are per session and per turn.

#### Keeping the braked message replayable

A brake rewrites text that carried a provider signature, so the guard rebuilds the replay envelope instead of forfeiting it — and the two signature kinds need opposite handling.

A **text** signature is only `{v:1, id}`: it names the item and carries no text, so the provider takes the text from the block itself. The truncated text is therefore what goes on the wire, with the item's original id intact, and the cache prefix stays readable up to the cut point.

A **reasoning** signature is replayed *verbatim* — the provider pushes the stored item and ignores the block's own text — so carrying the original through would put the entire suppressed loop back on the wire while the transcript claimed otherwise. The guard rewrites that signature's `summary` to the text it actually kept. The rewrite is faithful rather than invented: on this provider the `summary` is a byte-identical mirror of the reasoning text (measured across 1983 signatures: uniform key set, none carrying an `encrypted_content` blob, and `summary[0].text` equal to the block text in every case), which is why rewriting it is accurate and why the guard can tell when it is not. A signature shape it does not fully recognise — including one carrying an opaque provider blob — is never guessed at: the envelope is dropped instead, degrading that one message to provider-neutral history. Guessing wrong would silently re-send the loop, which is strictly worse than losing the item ids.

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [LLM streaming subsystem reference](../../../docs/subsystems/llm-streaming.md) — the `llm/stream` waterfall, `StreamChunk` grammar, and the stream invariant this guard's output must satisfy.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-stream-guard) — every accepted config field and its source declaration.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Post-brake continuation prompt

#### What the model sees

After a filler run is braked, the steered continuation message below is appended to the transcript. When real text preceded the run, a short tail of it is appended after a resume label so the model resumes at the cut instead of restarting. The wording follows the conversation's own script — a CJK-scripted transcript gets Chinese wording, everything else gets Latin wording, and a script-free transcript falls back to Latin because the guard never guesses a language it cannot see — so both shipped forms are documented below.

##### Continuation prompt (Latin script)

```markdown
Continue from where the text above was cut off. Do not repeat or restate what you have already written.

Where you stopped: …<tail of the last real text, up to 240 characters>
```

##### Continuation prompt (CJK script)

```markdown
从上面被截断的地方接着写。不要重复或复述已经写过的内容。

上次写到：…<tail of the last real text, up to 240 characters>
```

#### Token effect

Zero tokens until a brake fires. Each continuation is retained history for that turn, bounded by `maxContinues` per turn (there is no session-wide cap, only the `warnAfterContinues` wording escalation); the appended tail is capped at 240 characters.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Hesitation nudge

#### What the model sees

When a finished answer shows hesitation churn, the next request carries the nudge below. It never truncates anything — class-B churn has already been written by the time the pattern is visible.

##### Hesitation nudge (Latin script)

```markdown
You seem to be re-deriving the same conclusion. If you already have enough evidence, settle on it and continue; if you need more, say exactly what is missing.
```

##### Hesitation nudge (CJK script)

```markdown
你似乎在同一结论周围反复推导。如果已有足够证据，请收敛到结论并继续；如果还需要更多信息，请明确说明缺什么。
```

#### Token effect

Zero tokens until churn is detected. Each nudge is retained history, bounded by `hesitationBudget` per session; at most one nudge is issued per distinct assistant message.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **The CJK lexicon is unmeasured** — the English filler families and the hesitation ratio were calibrated on 7,395–7,431 real healthy samples; the Chinese families were added for reach, from the same intent rather than from counts. Only whole-line matches count and ordinary Chinese discourse markers are excluded, but the false-positive rate on Chinese traffic is unknown.
- **The prefix rule reads only two shapes** — it counts a short clause that opens with a listed intent prefix ("Let me", "I need to", "让我", "接下来", and the like, 18 characters or fewer) and a whole line that is a bare filler word from a deliberately narrow list ("ok", "go", "now", "write", "emit", "here", "final", "writing", "producing", "emitting", plus "好", "现在", "写", "输出", "生成", "写入", "接下去", "执行"). A semantic-level repeat that carries none of those openings — the same conclusion restated in fresh wording, a loop of full sentences that never open with an intent marker — is still invisible to it. That is the honest boundary: this rule catches a stalled model's *tics*, not a stalled model's *meaning*.
- **Reasoning is not watched by the filler lexicon** — `brakeReasoning` stays off because the lexicon reads reasoning poorly: a line like "Now." is ordinary connective tissue there, so the lexicon would fire on healthy thinking. The cycle rule and the prefix rule carry that channel instead, and the prefix rule is the only one of the two that can fire before 512 characters.
- **A bleed repeated at line granularity is still missed** — the cycle rule requires an exact verbatim character period. The reference implementation pairs it with a line-level rule that this port does not have, so a collapse that varies each repetition while restating the same lines is not caught by the cycle rule; the prefix rule catches it only when those lines begin with a listed opening.
- **The cycle rule cannot fire on a loop shorter than 512 characters** — it needs that much verbatim repetition before the pattern is proven, so a model that collapses immediately still shows that much degeneration. This is why the prefix rule, which fires at 55–68 characters on the shapes the other two miss, is the fast layer rather than a replacement for it.
- **The visible channel runs the lexicon and the prefix rule, not the cycle rule** — `cycleText` stays off because holding the tail back for the cycle rule costs the live stream a permanent ~1024-character lag (measured: 74 characters of lag with the rule off, 1024 with it on, against 9,010 characters of healthy prose). The lexicon catches the same collapse thousands of characters earlier at no display cost, and `prefixText` adds reach at no display cost at all, so the cycle rule is spent on the reasoning channel, where nobody watches the stream.
- **A brake can shorten a legitimate answer** — suppression is the point, and the continuation is a recovery, not a guarantee the original text returns.
- **Budgets are in-process** — per-session state lives in memory and does not survive a restart, so a fresh process starts with a full allowance.
- **No mid-stream resume** — recovery always crosses a step boundary; the guard cannot re-request inside one stream.
- **Verdicts during an open tool call are dropped, not deferred** — the run is released and the guard keeps watching, so that particular collapse is not braked.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked notes.

The filler detector is a port of the `ds-guard` proxy's `src/guards/filler.rs`; the holdback buffer and the turn-boundary continuation are new here, because the reference owns its socket and can re-POST, while DSH publishes deltas live and cannot retract them. Thresholds were calibrated on the reference's real corpus: the hesitation ratio 0.50 costs 9 false positives in 7,431 healthy samples (0.12%), against 38 at 0.30. The per-session nudge cap exists because counting nudge markers in the transcript reported "already nudged: 0" on 61 consecutive turns.

The cycle rule is ported from the `dsh-loop-guard` reference's `trailingCycle`. The reference runs two rules per channel (`repeating-cycle` and `reasoning-lines`); only the first is ported, so a bleed whose repetition is at line granularity without an exact character period is still not caught here. The reference also yields each chunk immediately and only accumulates a copy, so it can stop a stream but never excise the loop; the holdback here is what makes the excision possible.

The prefix rule replaced an earlier opener rule (`src/opener.ts`, window 20 lines, ratio 0.8, minimum 16 lines) that judged the same failure by line counts and proportions. That framing was the wrong shape: an opening count with a character tolerance reaches the wording-drift shape the opener rule missed entirely, and reaches it inside ~60 characters where the cycle rule needs 512. The opener rule and its spec were deleted rather than kept alongside it.

The word lists are measured, not invented. Over 2,159 reasoning blocks and 103,581 non-empty lines, 23,371 lines (22.56%) are openings — these sessions were degenerating heavily the whole time, with nothing intercepting them. On the 1,469 blocks of genuine work in the corpus the rule fires on 8, and every one was hand-checked as a genuine death loop: within the firing blocks, openings are 36.7%–98.9% of non-empty lines (the largest, a 115,071-character block, is 10,190 non-empty lines of which 10,082 are openings — 98.9%), and the runs that trip it look like `Let me read.` / `OK.` / `Producing.`. Against a line-granular simulation of the same rule over the same corpus, the miss rate is zero. By entry, `let me` dominates at 13,633 hits, then `ok` 2,738, `go` 2,593, `producing` 2,375, `writing` 1,585, `i'll` 141, `让我` 96, `now` 55, everything else under 50. Openings that occur in the corpus but are ordinary prose — `实际上`, `所以`, `等等`, `另外`, `嗯`, `好，`, `如果`, `或者` — are excluded on purpose, because admitting them would fire on healthy writing. The corpus keeps growing as work continues, so any trigger count read from it is a moving target: the reproducible number is the miss rate, not the block count. Development sessions are excluded from the genuine-work figure because the model in them is writing about the filler words themselves — quoting this plugin's own fixtures and listing `OK` / `好。执行。` as test data — which fires the rule for a reason that has nothing to do with the model looping.

Two limits on the lists are deliberate and should not be relaxed. The first is the list of whole-line fillers: it is frozen to the original `FILLER_ONEWORD` family (`src/guards/filler.rs:42-53`) — `ok`/`go`/`now`/`write`/`emit`/`here`/`final`/`writing`/`producing`/`emitting` on the Latin side, with the Chinese counterparts `好`/`现在`/`写`/`输出`/`生成`/`写入`/`接下去`/`执行`. Adding `output`/`continue`/`done`/`execute`/`executing` was tried and reverted: they bought exactly one additional firing block and that block was a false positive — a model writing test code that listed filler words as data inside a fenced sample. The reference's own comment warned about this, calling the list deliberately narrow because a looser rule "would flag list output like `Name` / `core` / `dsh`". The Chinese `输出` stays: it belongs to the Chinese family and added no false positives. The second limit is the 18-character ceiling on an intent prefix. It is load-bearing, not cosmetic: scanning 102,936 lines, the count of lines judged filler rises 6,597 at 12 characters, 13,008 at 14, 13,497 at 16, and 13,565 at 18 — with zero real work newly captured at every one of those — then jumps to 13,579 at 20, 13,582 at 24, and saturates there, and each step past 18 admits genuine planning text such as `Let me verify that.` and `Let me implement that.`. Dropping the ceiling entirely sweeps in ordinary long reasoning, where 11,471 lines that merely begin with an intent prefix are normal content.

Two defects in the cut were found by measuring what the brake *keeps*, not merely whether it fires — neither was visible from a pass/fail. The first: `span` is `max(minSpan, 2 * period)`, an identity satisfied by every period at or below `minSpan / 2`, so inferring the period from it returned 2 or 3 for every short period and the cut landed inside the repetition; the scan now reports the period it actually matched. The second was data loss: `runStart` doubles as the release cursor, which the line scanner advances only for newline-terminated lines, so an unterminated buffer pinned the cut to 0 and discarded everything before the loop — a real 34-character answer followed by a newline-free loop kept 0 characters. Both are regression-tested.

Open questions, none decided. Whether the reasoning lexicon should stay off now that the signature can be rewritten — the rewrite removes the reason it was off, leaving only the question of whether filler in reasoning is evidence worth acting on. And `containment` from the reference, a cross-call restatement measure, has no equivalent here. The `cycleText` question is now measured rather than open: a permanent ~1024-character visible lag (74 → 1024 on 9,010 characters of healthy prose) buys a rule the lexicon already beats to the collapse by thousands of characters, so it stays off. Revisit only if a real visible collapse is found that the lexicon missed.

</details>
