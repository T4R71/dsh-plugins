/**
 * Reading the excerpt back out of a settle envelope, for the tests that bound it.
 *
 * An envelope block is the excerpt the parent is meant to read, followed by the
 * framing that says how to read the rest. The excerpt is therefore the prefix of
 * the block, up to the line that opens the framing — measured from the block the
 * transcript holds rather than re-derived, so a `<= gistChars` assertion here is a
 * bound on the real envelope.
 *
 * @module @t4r71/dsh-guard/tests
 */

/** The line that ends the excerpt and opens the framing. */
const FRAMING = /^Envelope of its closing message \(/

/**
 * The excerpt an envelope carries.
 *
 * @param body - the envelope block of a rewritten settlement, framing and all.
 * @returns the excerpt with the blank separator the envelope puts after it
 *   trimmed off; blank lines inside the excerpt are kept.
 */
export function previewIn(body: string): string {
  const lines = body.split('\n')
  const to = lines.findIndex(line => FRAMING.test(line))
  if (to < 0) {
    throw new Error('the envelope reader found no framing: ' + JSON.stringify(body.slice(0, 120)))
  }
  return lines.slice(0, to).join('\n').trim()
}
