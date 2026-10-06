/**
 * The observation window: what actually reached the seam, written where a human
 * and a later step can read it.
 *
 * WHY THIS IS THE PREREQUISITE AND NOT A DEBUG AID. Every template section this
 * package exists to rewrite is registered CONDITIONALLY — a tool's own section
 * exists only in a composition that mounted that tool, and an MCP server's
 * section exists only while that server is configured. One assembly therefore
 * never shows the full set. The names a rule can safely be written against are
 * the UNION over many assemblies, and the only honest way to obtain that union
 * is to run with the rewriter in observe mode, change nothing, and accumulate.
 * Guessing the keys first is what the operator's decision forbids.
 *
 * FIVE ARTIFACTS, ONE DIRECTORY, all append-only so a crashed run loses nothing
 * already written:
 *
 *   sections.jsonl   one JSON object per assembly: the full digest list for that
 *                    assembly, with the assembly ordinal. Line-oriented, so a
 *                    partial last line is discardable.
 *   sections-text.jsonl
 *                    the same, but with each section's FULL text. Separate file
 *                    because it is orders of magnitude larger and most reading
 *                    never needs it.
 *   baseline.json    the accumulated index: one entry per section NAME, with the
 *                    first and last assembly that carried it, its text length
 *                    range, and the set of sha256 prefixes it has ever had. This
 *                    is the "section-name baseline" the rules are written from.
 *   purity.jsonl     one line per assembly: the evidence that this pass changed
 *                    nothing.
 *   README.txt       how to read the four files above, written on first use.
 *
 * PURITY IS NOT ASSERTED, IT IS DEMONSTRATED, AND THE CRITERION IS THE DIGESTS.
 * For every assembly, observe mode digests the sections as they arrived at the
 * seam and the sections as they were returned, and compares the two lists on
 * five members per section — `index`, `name`, `textLength`, `textSha256`,
 * `interpolate` — plus the section count. That comparison IS the criterion: any
 * assembly where it disagrees is written to `purity.jsonl` with `ok: false`,
 * naming the offending section and member, AND logged at error level, so an
 * observe window cannot pass unnoticed while silently rewriting.
 *
 * WHY `sameReference` IS RECORDED BUT IS NOT PART OF THE CRITERION.
 * The observer also records whether the waterfall listener returned the exact
 * object reference it was handed. It is DIAGNOSTIC ONLY. On the 0.1.7 upstream
 * this package sits on, `assemble` normally returns a FRESH object even when
 * every listener returned its input: the `complete: true` restore branch
 * (`packages/core/system-prompt/src/index.ts:629-634`) rebuilds the assembly
 * around a snapshot, so `produced === incoming` is false on an untouched
 * assembly. Grading on it therefore tests "did the chain below return the same
 * reference", which is a property of the CHAIN and not of this handler — it is
 * false for reasons this package cannot influence. Measured on the B2 observation
 * window: 20 assemblies, `sameSections` true on 20/20, 440/440 section digests
 * identical to an independent recomputation from the full text, and yet
 * `sameReference` false on 19/20 — one false failure per assembly, produced
 * entirely by the upstream restore. An earlier revision graded on it and
 * therefore reported 19 spurious failures. It is kept in the record because a
 * `true` is still meaningful evidence, and because a criterion that silently
 * disappears is worse than one that is labelled.
 *
 * {@link PURITY_CRITERIA} in every record states which criterion graded it, so a
 * later reader can tell a v1 line from a v2 one without guessing.
 *
 * EVERY LINE NAMES ITS SUBJECT. The files are ONE stream shared by every session
 * the plugin serves, and the ordinal is ONE counter across that stream, so without
 * a subject on the line there is no way to tell which session an assembly belonged
 * to — the two facts a rule is authored from, "what does THIS session's prompt
 * carry" and "how often does the deployment carry this section", stop being
 * separable. `sessionId` is written on every line this revision produces:
 * `sections.jsonl`, `sections-text.jsonl`, `purity.jsonl`, and the `:rules`
 * companion line. `null` means the assembly genuinely carried no subject; an
 * ABSENT member means the line was written before this field existed, which is a
 * different fact and must not be read as `null`.
 *
 * @module @t4r71/dsh-prompt-plan/observe
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { digestSections, describeDigestDifference, firstDigestDifference, sameSectionList, sha256, SAME_DIGEST_MEMBERS } from './digest.ts'
import type { SectionDigest } from './digest.ts'
import type { SectionRecord } from './sections.ts'

/** The four machine-readable artifact names, and the one human note. */
export const ARTIFACT_NAMES = {
  sections: 'sections.jsonl',
  sectionsText: 'sections-text.jsonl',
  baseline: 'baseline.json',
  purity: 'purity.jsonl',
  readme: 'README.txt',
} as const

/**
 * The member that attributes a line to its session, and the two questions the
 * ordinal is and is not able to answer.
 *
 * ONE COUNTER, ONE STREAM, MANY SESSIONS. The ordinal is allocated from a single
 * counter per artifact directory, resumed at mount from the highest ordinal the
 * log already holds, and it is unique across the whole directory for the life of
 * the directory. MEASURED on the desktop window this was written against: 7719
 * `sections.jsonl` assemblies, ordinals 0..7718, zero gaps, zero duplicates,
 * zero backward steps, 7719 `purity.jsonl` lines with exactly the same ordinal
 * set, and every `:rules` companion ordinal present in the main log. So
 * "ordinal 4242" identifies ONE assembly, and `baseline.json` can cross-reference
 * one — and nothing more than that. It does NOT identify a session, and it does
 * not restart per session: several sessions interleave into the one stream, so
 * two adjacent ordinals are frequently two different sessions, and a session's
 * own assemblies are a SCATTERED SUBSET of the range. That is why the counter is
 * deliberately NOT made per-session: keyed per session it would restart at 0 for
 * every new session, and "ordinal 0" would then name one assembly per session
 * instead of one assembly, which breaks the one thing the ordinal is used for —
 * the cross-reference from the baseline index, a UNION over the whole directory
 * with no session in it. Per-session numbering is `sessionId` plus a dense
 * sequence, which is a derived view a reader can build from these lines and is
 * not worth a second counter to maintain.
 */
export const SESSION_ID_FIELD = 'sessionId'

/** One section's accumulated entry in the baseline index. */
export interface BaselineEntry {
  /** The section name, exactly as registered. */
  readonly name: string
  /** How many assemblies carried it. */
  readonly seen: number
  /** The ordinal of the first assembly that carried it. */
  readonly firstAssembly: number
  /** The ordinal of the most recent assembly that carried it. */
  readonly lastAssembly: number
  /** The lowest and highest `text.length` ever observed for it. */
  readonly minLength: number
  readonly maxLength: number
  /** Full sha256 values ever observed, in first-seen order, capped by {@link BASELINE_HASH_CAP}. */
  readonly sha256: readonly string[]
  /** How many DISTINCT texts have been seen; > 1 means the section is dynamic. */
  readonly distinctTexts: number
  /** Array indices it has appeared at, deduplicated and ascending. Placement evidence only. */
  readonly indices: readonly number[]
  /** Whether any occurrence declared `interpolate: false`. */
  readonly interpolateFalse: boolean
}

/** How many distinct hashes per name the baseline keeps before it stops growing. */
export const BASELINE_HASH_CAP = 16

/** The whole accumulated index. */
export interface Baseline {
  /** Bumped when this file's shape changes; the reader refuses an unknown value. */
  readonly format: 1
  /** Assemblies recorded so far. */
  readonly assemblies: number
  /** ISO timestamp of the most recent assembly. */
  readonly updatedAt: string
  /** Which mode produced it — an observe baseline and a rewrite baseline must not be confused. */
  readonly mode: string
  /** The rule file in force at the last assembly, and its hash; absent in observe mode with no rules. */
  readonly ruleFile?: { readonly path: string; readonly sha256: string }
  /** Section name -> entry. Sorted by name when written. */
  readonly sections: Record<string, BaselineEntry>
}

/** One assembly's record in `sections.jsonl`. */
export interface AssemblyRecord {
  readonly ordinal: number
  readonly at: string
  /**
   * The session this assembly belonged to, or `null` when it had no subject.
   *
   * Always present on a line this revision writes. See {@link SESSION_ID_FIELD}
   * for why an absent member is a THIRD state, and for what the ordinal does and
   * does not identify.
   */
  readonly sessionId: string | null
  readonly mode: string
  readonly sectionCount: number
  readonly completeShape: boolean
  readonly sections: readonly SectionDigest[]
}

/**
 * The version of the purity criterion, written into every record.
 *
 *   1  `ok` required BOTH `sameReference` and `sameSections`. That made the
 *      record fail on an untouched assembly, because 0.1.7's `assemble` returns
 *      a fresh object through its `complete: true` restore branch regardless of
 *      what any listener did. Superseded.
 *   2  `ok` requires the DIGEST comparison only: equal section counts and, for
 *      every section, five equal members (`index`, `name`, `textLength`,
 *      `textSha256`, `interpolate`). `sameReference` is still recorded, as
 *      diagnostic information that does not affect `ok`. Current.
 *
 * A line without this member was written by criterion 1. The reader of a mixed
 * file must not compare `ok` across the boundary.
 */
export const PURITY_CRITERIA = 2

/** The members the criterion compares per section, re-exported for the record. */
export const PURITY_GRADED_MEMBERS = SAME_DIGEST_MEMBERS

/** One assembly's purity evidence in `purity.jsonl`. */
export interface PurityRecord {
  readonly ordinal: number
  readonly at: string
  /** The session this assembly belonged to, or `null` when it had no subject. */
  readonly sessionId: string | null
  /**
   * Which criterion graded this line. `2` is current; an absent member means
   * the line predates the member (criterion 1). See {@link PURITY_CRITERIA}.
   */
  readonly criteria: number
  /**
   * Whether the handler returned the exact object reference it was handed.
   * DIAGNOSTIC ONLY — it does NOT contribute to `ok`. See the module doc.
   */
  readonly sameReference: boolean
  /**
   * The primary evidence: every section digested identically, at the same index,
   * before and after. Equal to `ok` on every line this version writes.
   */
  readonly sameSections: boolean
  /** Section count before and after. A change is a failure on its own. */
  readonly countBefore: number
  readonly countAfter: number
  /** The claim, as a boolean a reader can gate on: the digest comparison, and nothing else. */
  readonly ok: boolean
  /** Which evidence failed, when one did. Empty exactly when `ok` is true. */
  readonly failures: readonly string[]
  /** The first place the two digest lists disagreed, when they did. */
  readonly firstDifference?: {
    readonly kind: 'count' | 'section'
    readonly sectionIndex?: number
    readonly sectionName?: string
    readonly member?: string
    readonly before?: unknown
    readonly after?: unknown
  }
}

/** The observer's configuration. */
export interface ObserverOptions {
  /** Absolute directory for the artifacts; created if absent. */
  readonly directory: string
  /** The mode string recorded in each line. */
  readonly mode: string
  /** Called once per failing record, so the host log carries it too. */
  readonly report: (record: PurityRecord) => void
}

const README_TEXT = `prompt-plan observation artifacts
==================================

Written by @t4r71/dsh-prompt-plan while it sat on the system-prompt/assemble
waterfall. In observe mode the plugin changes NOTHING; every file here describes
an assembly that went to the model unmodified.

WHICH SESSION A LINE BELONGS TO — READ THIS FIRST
  Every file here is ONE stream shared by every session the plugin served, and
  "ordinal" is ONE counter across that stream, not a per-session number. So
  ordinal 4242 identifies exactly one assembly — that is what makes it usable as
  a cross-reference — but it does NOT say which session it was, and two adjacent
  lines are frequently two different sessions, because sessions interleave.

  "sessionId" on a line is the answer: the session that assembly belonged to, or
  null when the assembly carried no subject at all. It is written on every line
  of sections.jsonl, sections-text.jsonl, purity.jsonl and the ":rules"
  companion lines. An ABSENT "sessionId" member is a third state: that line was
  written before this field existed. Do not read a missing member as null.

  To get a session's own sequence, filter by sessionId and read the ordinals in
  order; they will be sparse and increasing. The counter is deliberately NOT
  restarted per session, because a per-session ordinal could not be used as the
  cross-reference baseline.json is built from.

sections.jsonl
  One line per assembly. Fields: ordinal, at, sessionId, mode, sectionCount,
  completeShape, and "sections" — an array of { index, name, textLength,
  textSha256, textPreview, interpolate? }. The full text is NOT here; see
  sections-text.jsonl. "index" is the position in the assembly array and is
  placement evidence ONLY: an assembled section carries no "order" member
  (packages/core/system-prompt/src/index.ts:602-611 copies name, text and
  interpolate only), so array position is the only placement fact on the wire.

sections-text.jsonl
  The same lines — same ordinal, at, sessionId, mode, sectionCount and
  completeShape — with each section's full "text" in place of its preview and
  hash. Large; read it with a filter, not whole.

baseline.json
  The accumulated index — THE FILE RULES ARE WRITTEN FROM. One entry per
  section NAME, containing: how many assemblies carried it, the first and last
  assembly ordinals, the text-length range, the distinct sha256 values seen
  (capped), how many distinct texts that amounts to, the array indices it
  appeared at, and whether it ever declared interpolate: false.

  Read "seen" against "distinctTexts": a name with seen>1 and distinctTexts>1
  is dynamic (re-rendered every turn), which is normal. A name with
  distinctTexts == 1 across many assemblies has static text, which is what a
  replacement rule usually targets.

  UNION, NOT ONE ASSEMBLY. Template sections are registered conditionally, so a
  name absent from one assembly is not absent from the deployment. Write rules
  against names that appear here with a seen count you are happy with, and give
  a rule "required: false" when the section is conditional.

purity.jsonl
  One line per assembly: { ordinal, at, sessionId, criteria, sameReference,
  sameSections, countBefore, countAfter, ok, failures, firstDifference? }.

  "criteria" says WHICH CRITERION GRADED THE LINE, and a reader of a file that
  spans a package upgrade has to look at it before comparing "ok" across lines:

    criteria: 2  (current)  "ok" is true exactly when the DIGEST COMPARISON
                 found nothing: the section count is unchanged AND, section for
                 section, all five of index, name, textLength, textSha256 and
                 interpolate are equal before and after the handler ran.
    criteria absent         the line predates the member and was written under
                 criterion 1, which ALSO required sameReference to be true.

  WHY CRITERION 1 WAS WRONG, since a mixed file will show exactly this: on the
  0.1.7 upstream this plugin sits on, "assemble" returns a FRESH object even when
  every listener returned its input, because the "complete: true" restore branch
  (packages/core/system-prompt/src/index.ts:629-634) rebuilds the assembly around
  a snapshot taken before the waterfall ran. So sameReference is a fact about the
  CHAIN BELOW THIS HANDLER, not about this handler, and it is false for reasons
  the plugin cannot influence. Criterion 1 therefore wrote one false failure per
  assembly: the B2 window holds 20 assemblies, in which sameSections was true on
  20/20 and every one of 440 section digests matched an independent recomputation
  from the full text — and 19 of the 20 lines still said "ok": false.

  sameReference IS STILL RECORDED, and a "true" in it is meaningful: it is the
  one value that proves the handler returned the very object it was handed. It
  simply does not decide "ok" any more.

  "failures" names the section and the member, e.g.
    section 3 ("tool:pwsh"): textSha256 "ab..." before the handler, "cd..." after
  A count change is reported the same way, as "the section count changed: ...".

  In observe mode "ok" must be true on every line written under criteria 2. A
  false line means this pass changed something; the host log carries the same
  record at error level.
`

/**
 * The accumulating observer. One instance per mounted plugin; it owns the
 * ordinal counter and the in-memory baseline.
 */
export class Observer {
  private ordinal = 0
  private baseline: Record<string, BaselineEntry> = {}
  private ready: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  /**
   * @param options - artifact directory, mode string, and the failure reporter.
   */
  constructor(private readonly options: ObserverOptions) {
    // Resumed SYNCHRONOUSLY, and in the constructor rather than in the first
    // queued write, because `record` takes its ordinal from this field before
    // any write is queued: hydrating later would number this run's first
    // assembly 0 and collide with the run that already used 0.
    this.baseline = this.readBaseline()
    this.ordinal = this.readNextOrdinal()
  }

  /**
   * Read the accumulated index this directory already holds.
   *
   * ACROSS A RESTART, NOT JUST WITHIN ONE. Every launch constructs a fresh
   * Observer, so without this read the first write of a run would publish an
   * index covering only the assemblies of that run and silently drop every name
   * the previous runs established — and the union over many assemblies, which
   * is the whole reason observe mode exists, is exactly what that destroys.
   * Because the file is an index rather than a log, nothing can reconstruct it
   * from the `.jsonl` lines afterwards, so the read has to happen here.
   *
   * Synchronous on purpose: this runs once per mount, never on a turn, and the
   * counter it supplies has to be in place before the first assembly is
   * recorded.
   * @returns the entries on disk, or an empty index when there are none.
   */
  private readBaseline(): Record<string, BaselineEntry> {
    const path = join(this.options.directory, ARTIFACT_NAMES.baseline)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { format?: unknown, mode?: unknown, sections?: unknown }
      // An index written by a different mode describes different assemblies, so
      // it is discarded rather than merged: an observe baseline and a rewrite
      // baseline must not be confused.
      if (parsed.format !== 1 || parsed.mode !== this.options.mode) return {}
      if (parsed.sections === null || typeof parsed.sections !== 'object') return {}
      const entries: Record<string, BaselineEntry> = {}
      for (const [name, entry] of Object.entries(parsed.sections as Record<string, BaselineEntry>)) {
        if (entry !== null && typeof entry === 'object' && Array.isArray(entry.sha256)) entries[name] = entry
      }
      return entries
    } catch {
      // Missing is the first run; unreadable is not fatal either. Neither may
      // stop the observation — the lines this run writes are worth more than the
      // index it could not read.
      return {}
    }
  }

  /**
   * The ordinal this run's first assembly takes.
   *
   * Read from the ASSEMBLY LOG rather than from `baseline.assemblies`: the log
   * is append-only and is the record every artifact line cross-references, so
   * one past its highest ordinal can never collide with a line already written.
   * @returns the next free ordinal.
   */
  private readNextOrdinal(): number {
    try {
      const text = readFileSync(join(this.options.directory, ARTIFACT_NAMES.sections), 'utf8')
      let highest = -1
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        try {
          const ordinal = (JSON.parse(line) as { ordinal?: unknown }).ordinal
          if (typeof ordinal === 'number' && Number.isFinite(ordinal) && ordinal > highest) highest = ordinal
        } catch {
          // A torn last line is expected on a crashed run and is skipped.
        }
      }
      return highest + 1
    } catch {
      return 0
    }
  }

  /** Create the directory and the human note, once. */
  private async prepare(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.options.directory, { recursive: true })
      await writeFile(join(this.options.directory, ARTIFACT_NAMES.readme), README_TEXT, 'utf8')
    })()
    return this.ready
  }

  /**
   * Record one assembly.
   *
   * The before/after digests are computed by the CALLER, from the values it
   * actually held; this method only writes them. That is deliberate: an observer
   * that recomputed the "before" digest from a value it kept would be measuring
   * its own copy rather than the assembly.
   * @param before - the sections as they arrived, in array order.
   * @param after - the sections as they were returned, in array order.
   * @param sameReference - whether the returned assembly was the incoming object.
   * @param completeShape - whether the complete-section shape was detected.
   * @param fullText - whether to also write the full-text artifact.
   * @param ruleFile - the rule file in force, when there was one.
   * @param ruleTrace - a rendered per-rule trace, when rewrite mode produced one.
   * @param sessionId - the session this assembly belonged to; `undefined` means it
   *   carried no subject, and is recorded as `null` rather than omitted, so a
   *   reader can tell "no subject" from "older line, before the field existed".
   */
  record(
    before: readonly SectionRecord[],
    after: readonly SectionRecord[],
    sameReference: boolean,
    completeShape: boolean,
    fullText: boolean,
    ruleFile: { path: string; sha256: string } | undefined,
    ruleTrace: readonly string[],
    sessionId: string | undefined,
  ): Promise<void> {
    const ordinal = this.ordinal
    this.ordinal += 1
    const at = new Date().toISOString()
    // Normalised ONCE, here, so all four lines that follow attribute the assembly
    // to the same subject by construction rather than by four spellings of it.
    const subject: string | null = sessionId ?? null
    const beforeDigests = digestSections(before)
    const afterDigests = digestSections(after)
    // THE CRITERION (PURITY_CRITERIA 2): the digest lists, and nothing else.
    // sameDigest compares index, name, textLength, textSha256 and interpolate;
    // sameSectionList adds the count. firstDigestDifference re-walks the SAME
    // comparison to name the section and the member, so a failure sentence
    // cannot describe a difference the boolean did not find.
    const sameSections = sameSectionList(beforeDigests, afterDigests)
    const difference = sameSections ? undefined : firstDigestDifference(beforeDigests, afterDigests)
    const failures: string[] = []
    if (difference !== undefined) failures.push(describeDigestDifference(difference))
    // sameReference is NOT a criterion here. On 0.1.7 the upstream complete:true
    // restore branch makes it false on an untouched assembly, so grading on it
    // produced one spurious failure per assembly in the B2 observation window.
    // Recorded for diagnostics; never gating.
    const purity: PurityRecord = {
      ordinal,
      at,
      [SESSION_ID_FIELD]: subject,
      criteria: PURITY_CRITERIA,
      sameReference,
      sameSections,
      countBefore: before.length,
      countAfter: after.length,
      ok: failures.length === 0,
      failures,
      ...difference === undefined
        ? {}
        : difference.kind === 'count'
          ? { firstDifference: { kind: 'count' as const, before: before.length, after: after.length } }
          : {
              firstDifference: {
                kind: 'section' as const,
                sectionIndex: difference.index,
                sectionName: difference.name,
                member: difference.member,
                before: difference.before,
                after: difference.after,
              },
            },
    }

    const record: AssemblyRecord = {
      ordinal,
      at,
      [SESSION_ID_FIELD]: subject,
      mode: this.options.mode,
      sectionCount: after.length,
      completeShape,
      sections: afterDigests,
    }

    // One chained write per assembly: order in the files matches ordinal order,
    // and a slow disk never reorders two assemblies against each other.
    this.queue = this.queue.then(async () => {
      await this.prepare()
      const directory = this.options.directory
      await appendFile(join(directory, ARTIFACT_NAMES.sections), JSON.stringify(record) + '\n', 'utf8')
      if (fullText) {
        const textRecord = {
          ...record,
          sections: after.map((section, index) => ({
            index,
            name: section.name,
            textLength: section.text.length,
            text: section.text,
            ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
          })),
        }
        await appendFile(join(directory, ARTIFACT_NAMES.sectionsText), JSON.stringify(textRecord) + '\n', 'utf8')
      }
      await appendFile(join(directory, ARTIFACT_NAMES.purity), JSON.stringify(purity) + '\n', 'utf8')
      if (!purity.ok) this.options.report(purity)
      this.accumulate(afterDigests, ordinal)
      if (ruleTrace.length > 0) {
        await appendFile(
          join(directory, ARTIFACT_NAMES.sections),
          JSON.stringify({ ordinal, at, [SESSION_ID_FIELD]: subject, mode: `${this.options.mode}:rules`, ruleFile, trace: ruleTrace }) + '\n',
          'utf8',
        )
      }
      await this.writeBaseline(ruleFile)
    })
    return this.queue
  }

  /** Fold one assembly's digests into the accumulated index. */
  private accumulate(digests: readonly SectionDigest[], ordinal: number): void {
    for (const digest of digests) {
      const existing = this.baseline[digest.name]
      if (existing === undefined) {
        this.baseline[digest.name] = {
          name: digest.name,
          seen: 1,
          firstAssembly: ordinal,
          lastAssembly: ordinal,
          minLength: digest.textLength,
          maxLength: digest.textLength,
          sha256: [digest.textSha256],
          distinctTexts: 1,
          indices: [digest.index],
          interpolateFalse: digest.interpolate === false,
        }
        continue
      }
      const isNewText = !existing.sha256.includes(digest.textSha256)
      this.baseline[digest.name] = {
        name: existing.name,
        seen: existing.seen + 1,
        firstAssembly: existing.firstAssembly,
        lastAssembly: ordinal,
        minLength: Math.min(existing.minLength, digest.textLength),
        maxLength: Math.max(existing.maxLength, digest.textLength),
        sha256: isNewText && existing.sha256.length < BASELINE_HASH_CAP
          ? [...existing.sha256, digest.textSha256]
          : existing.sha256,
        // Counted separately from the hash list, which is capped: past the cap
        // the count still grows, so "is this section dynamic" stays answerable.
        distinctTexts: isNewText ? existing.distinctTexts + 1 : existing.distinctTexts,
        indices: existing.indices.includes(digest.index) ? existing.indices : [...existing.indices, digest.index].sort((a, b) => a - b),
        interpolateFalse: existing.interpolateFalse || digest.interpolate === false,
      }
    }
  }

  /** Write the accumulated index, sorted by name so a human diff stays readable. */
  private async writeBaseline(ruleFile: { path: string; sha256: string } | undefined): Promise<void> {
    const sections: Record<string, BaselineEntry> = {}
    for (const name of Object.keys(this.baseline).sort()) {
      const entry = this.baseline[name]
      if (entry !== undefined) sections[name] = entry
    }
    const baseline: Baseline = {
      format: 1,
      assemblies: this.ordinal,
      updatedAt: new Date().toISOString(),
      mode: this.options.mode,
      ...ruleFile === undefined ? {} : { ruleFile },
      sections,
    }
    await writeFile(join(this.options.directory, ARTIFACT_NAMES.baseline), JSON.stringify(baseline, null, 2) + '\n', 'utf8')
  }

  /**
   * Wait for every queued write to finish.
   *
   * The waterfall handler must NOT await this: a disk write inside the assembly
   * path would put filesystem latency in front of every model turn. The plugin
   * awaits it when it unloads, so a clean shutdown loses nothing.
   * @returns a promise that settles when the queue is empty.
   */
  async drain(): Promise<void> {
    await this.queue
  }

  /** @returns the artifacts' directory, for the mount-time log line. */
  get directory(): string {
    return this.options.directory
  }

  /** @returns a stable digest of the whole observation so far, for a log line. */
  summary(): string {
    const names = Object.keys(this.baseline)
    return `${this.ordinal} assembly(ies), ${names.length} distinct section name(s), baseline sha256 ${sha256(JSON.stringify(names))}`
  }
}
