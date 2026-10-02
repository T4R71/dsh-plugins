/**
 * Section digests: the identity of one assembled section, reduced to something
 * a human can diff and a program can compare.
 *
 * Why a digest module rather than inline `createHash` calls: the observation
 * artifact and the purity self-check must compute the SAME value for the same
 * section. Two call sites with two spellings of "the section's identity" would
 * make the observer's own before/after comparison meaningless, which is exactly
 * the property this package has to be able to demonstrate.
 *
 * @module @t4r71/dsh-prompt-plan/digest
 */

import { createHash } from 'node:crypto'

/** How much of a section's text the per-assembly record keeps verbatim. */
export const TEXT_PREVIEW_LENGTH = 64

/**
 * One section reduced to its observable identity.
 *
 * `index` is NOT a rule key — the assembled section object carries no `order`
 * member (the constructor at
 * `packages/core/system-prompt/src/index.ts:602-611` copies name, text and
 * interpolate only), so array position is the sole placement evidence left. It
 * is recorded for a human reading the baseline, never matched on.
 */
export interface SectionDigest {
  /** Position in the assembly's `sections` array, 0-based. Placement evidence only. */
  readonly index: number
  /** The section's name, verbatim. */
  readonly name: string
  /** `text.length`, in UTF-16 code units — the same number JS `String.length` reports. */
  readonly textLength: number
  /** Lowercase hex sha256 of the section's text. */
  readonly textSha256: string
  /** The first {@link TEXT_PREVIEW_LENGTH} characters of the text, verbatim. */
  readonly textPreview: string
  /** Whether the section declares `interpolate: false`; absent means default (true). */
  readonly interpolate?: boolean
}

/** The minimal shape a section must have to be digested. Structural on purpose. */
export interface DigestibleSection {
  readonly name: string
  readonly text: string
  readonly interpolate?: boolean
}

/**
 * Hash one string with sha256, lowercase hex.
 * @param text - the text to hash.
 * @returns the 64-character hex digest.
 */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Reduce one section to its digest.
 * @param section - the section to reduce.
 * @param index - its position in the assembly array.
 * @returns the digest.
 */
export function digestSection(section: DigestibleSection, index: number): SectionDigest {
  // `exactOptionalPropertyTypes` is on, so the optional member is only ever
  // present when the section actually declares it. A section that omits
  // `interpolate` and one that sets it to `true` digest identically, which is
  // correct: assembly treats them the same.
  return {
    index,
    name: section.name,
    textLength: section.text.length,
    textSha256: sha256(section.text),
    textPreview: section.text.slice(0, TEXT_PREVIEW_LENGTH),
    ...section.interpolate === undefined ? {} : { interpolate: section.interpolate },
  }
}

/**
 * Reduce a whole assembly's section list.
 * @param sections - the assembly's sections.
 * @returns one digest per section, in array order.
 */
export function digestSections(sections: readonly DigestibleSection[]): SectionDigest[] {
  return sections.map((section, index) => digestSection(section, index))
}

/**
 * Compare two digests member by member.
 *
 * Deliberately NOT `index`-sensitive when used by {@link sameSectionList} for
 * the purity check: rewriting nothing must leave every section byte-identical
 * AND in place, so the caller compares the full arrays including index.
 * @param left - one digest.
 * @param right - another digest.
 * @returns whether they describe the same section at the same position.
 */
export function sameDigest(left: SectionDigest, right: SectionDigest): boolean {
  return left.index === right.index
    && left.name === right.name
    && left.textLength === right.textLength
    && left.textSha256 === right.textSha256
    && left.interpolate === right.interpolate
}

/**
 * Compare two assembly section lists for exact identity.
 * @param left - one digest list.
 * @param right - another digest list.
 * @returns whether the two assemblies carry the same sections, in the same order.
 */
export function sameSectionList(left: readonly SectionDigest[], right: readonly SectionDigest[]): boolean {
  return left.length === right.length && left.every((digest, index) => {
    const other = right[index]
    return other !== undefined && sameDigest(digest, other)
  })
}

/**
 * The members {@link sameDigest} compares, NAMED, in the order it compares them.
 *
 * Exists so that a record can state which criterion graded it without a second
 * hand-written copy of the list drifting from the comparison itself: the purity
 * record writes this tuple, and {@link firstDigestDifference} walks it.
 */
export const SAME_DIGEST_MEMBERS = ['index', 'name', 'textLength', 'textSha256', 'interpolate'] as const

/** One member of {@link SAME_DIGEST_MEMBERS}. */
export type SameDigestMember = typeof SAME_DIGEST_MEMBERS[number]

/** The first place two digest lists disagree, in a form a reader can act on. */
export type DigestDifference =
  | { readonly kind: 'count'; readonly detail: string }
  | { readonly kind: 'section'; readonly index: number; readonly name: string; readonly member: SameDigestMember; readonly before: unknown; readonly after: unknown }

/** Render one member's value for a failure sentence without lossy formatting. */
function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

/**
 * Locate the FIRST difference between two digest lists, member by member.
 *
 * WHY THIS IS SEPARATE FROM {@link sameSectionList}: that function answers yes or
 * no, and a boolean is not actionable. A purity record whose only content is
 * "something differs" leaves the reader to re-derive which of five members of
 * which of N sections moved. This returns the section index, its name, the
 * member name, and both values.
 *
 * Member order follows {@link SAME_DIGEST_MEMBERS}, so the reported member is
 * deterministic when two members of one section both differ.
 * @param before - the digest list taken before the handler ran.
 * @param after - the digest list taken after.
 * @returns the first difference, or `undefined` when the lists are identical.
 */
export function firstDigestDifference(
  before: readonly SectionDigest[],
  after: readonly SectionDigest[],
): DigestDifference | undefined {
  if (before.length !== after.length) {
    return {
      kind: 'count',
      detail: `the section count changed: ${before.length} before the handler, ${after.length} after`,
    }
  }
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index]
    const right = after[index]
    if (left === undefined || right === undefined) {
      return { kind: 'section', index, name: left?.name ?? right?.name ?? '(none)', member: 'index', before: left === undefined ? '(absent)' : 'present', after: right === undefined ? '(absent)' : 'present' }
    }
    for (const member of SAME_DIGEST_MEMBERS) {
      if (left[member] !== right[member]) {
        return { kind: 'section', index, name: left.name, member, before: left[member], after: right[member] }
      }
    }
  }
  return undefined
}

/**
 * Render a {@link DigestDifference} as the sentence a purity record carries.
 * @param difference - the located difference.
 * @returns one human-readable line naming the section and the member.
 */
export function describeDigestDifference(difference: DigestDifference): string {
  if (difference.kind === 'count') return difference.detail
  return `section ${difference.index} (${JSON.stringify(difference.name)}): ${difference.member} ${show(difference.before)} before the handler, ${show(difference.after)} after`
}
