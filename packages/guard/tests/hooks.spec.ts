/**
 * Unit tests for the six hooks, one group per item.
 *
 * These run against the modules directly, with a hand-built context — no
 * cordis, no agent loop, no network — matching `guard.spec.ts`. Every switch is
 * exercised in both positions: the point of a default-conservative switch is
 * that "off" is a real, tested behaviour and not an untested hope.
 *
 * @module @t4r71/dsh-guard/tests
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boundJobOutput } from '../src/joblog.ts'
import { appendLedger, ledgerLine } from '../src/ledger.ts'
import { dedupeInjections, messageBody } from '../src/dedup.ts'
import { rereadKey, suppressRepeatRead, stampOf } from '../src/reread.ts'
import { envelopeContent, tailExcerpt } from '../src/envelope.ts'
import { byteLength, retainHeadBytes, retainTailBytes, sha256Hex, spillDirectory, writeSpill } from '../src/spill.ts'
import { apply } from '../src/index.ts'
import { runSpillFailureChild } from './spill-failure-child.mts'

/** A scratch directory; the caller removes it in a `finally`. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'guard-test-'))
}

/** One text block, spelled out so excess-property checks stay satisfied. */
function text(value: string): { type: 'text', text: string } {
  return { type: 'text', text: value }
}

/** A context that records listeners instead of dispatching them. */
function recordContext(): { listeners: Map<string, ((...a: any[]) => any)[]>, ctx: any } {
  const listeners = new Map<string, ((...a: any[]) => any)[]>()
  return {
    listeners,
    ctx: {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on(name: string, fn: (...a: any[]) => any) {
        listeners.set(name, [...(listeners.get(name) ?? []), fn])
        return () => {}
      },
    },
  }
}

/** The single listener `apply` registered on one seam. */
function listenerOn(listeners: Map<string, ((...a: any[]) => any)[]>, seam: string): any {
  const list = listeners.get(seam) ?? []
  assert.equal(list.length, 1, 'exactly one listener on ' + seam)
  return list[0]
}

// ---------------------------------------------------------------------------
// spill: the shared primitives every bound is built on
// ---------------------------------------------------------------------------

test('retainHeadBytes cuts on a UTF-8 boundary, never inside a character', () => {
  const cjk = '中文中文'
  assert.equal(byteLength(cjk), 12)
  assert.equal(retainHeadBytes(cjk, 3), '中')
  assert.equal(retainHeadBytes(cjk, 4), '中', 'a cut inside a character backs off to the boundary')
  assert.equal(retainHeadBytes(cjk, 12), cjk)
  assert.equal(retainHeadBytes(cjk, 100), cjk)
  assert.equal(retainHeadBytes(cjk, 0), '')
})

test('retainTailBytes cuts on a UTF-8 boundary and keeps the end', () => {
  const cjk = '中文中文'
  assert.equal(retainTailBytes(cjk, 3), '文')
  assert.equal(retainTailBytes(cjk, 12), cjk)
  assert.equal(retainTailBytes(cjk, 0), '')
  assert.equal(retainTailBytes('abcdef', 2), 'ef')
})

test('sha256Hex is the real digest of the exact bytes', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
})

test('writeSpill returns the path written and the file reads back byte-identical', () => {
  const root = scratch()
  try {
    const path = writeSpill(join(root, 'a', 'b'), 'x.txt', 'héllo 中文')
    assert.ok(path !== undefined, 'a writable directory yields a path')
    assert.equal(readFileSync(path as string, 'utf8'), 'héllo 中文')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('writeSpill reports failure instead of throwing', () => {
  const root = scratch()
  try {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    assert.equal(writeSpill(join(blocker, 'sub'), 'x.txt', 'y'), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('spillDirectory sanitises the session id out of the path', () => {
  const dir = spillDirectory('settle', 'a/b-c:d')
  assert.ok(!dir.includes('a/b'), dir)
  assert.ok(dir.startsWith(tmpdir()))
})
// ---------------------------------------------------------------------------
// item 1: the job_output bound
// ---------------------------------------------------------------------------

const JOB = { enabled: true, maxBytes: 300, spillRoot: '' }

test('item1: under the cap nothing changes, and the array keeps its identity', () => {
  const content = [text('short')]
  const out = boundJobOutput({ name: 'job_output', isError: false, exec: {}, content }, JOB)
  assert.equal(out.bounded, false)
  assert.equal(out.content, content, 'an untouched dispatch keeps its identity')
})

test('item1: exactly at the cap is not over it', () => {
  const body = 'x'.repeat(300)
  const out = boundJobOutput({ name: 'job_output', isError: false, exec: {}, content: [text(body)] }, JOB)
  assert.equal(out.bounded, false)
  assert.equal(byteLength(body), 300)
})

test('item1: over the cap keeps the tail, states the counts, and spills the whole text', () => {
  const lines = Array.from({ length: 200 }, (_, i) => 'line ' + String(i))
  const body = lines.join('\n')
  const out = boundJobOutput({
    name: 'job_output', isError: false, exec: { callId: 'c1' }, subCallId: 'c1:ptc:1', content: [text(body)],
  }, { enabled: true, maxBytes: 300, spillRoot: '' })
  assert.equal(out.bounded, true)
  assert.ok(out.totalBytes > 300, 'the source really was over the cap')
  const logged = out.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.ok(logged.includes('[job_output truncated'), 'the reader is told it was truncated')
  assert.ok(logged.includes('line 199'), 'the tail survives')
  assert.ok(!logged.includes('line 0'), 'the head is the part that goes')
  const spill = out.spillPath
  assert.ok(spill !== undefined, 'a full copy was written')
  assert.equal(readFileSync(spill as string, 'utf8'), body, 'the spilled copy is the original, byte for byte')
  assert.ok(out.keptBytes <= 300 + byteLength('\n'), 'keptBytes ' + String(out.keptBytes))
})

test('item1: the switch off leaves an oversized result untouched', () => {
  const body = 'y'.repeat(5000)
  const content = [text(body)]
  const out = boundJobOutput({ name: 'job_output', isError: false, exec: {}, content },
    { enabled: false, maxBytes: 300, spillRoot: '' })
  assert.equal(out.bounded, false)
  assert.equal(out.content, content)
})

test('item1: other tools, failures, and non-text blocks are never rewritten', () => {
  const big = [text('z'.repeat(5000))]
  assert.equal(boundJobOutput({ name: 'pwsh', isError: false, exec: {}, content: big }, JOB).bounded, false)
  assert.equal(boundJobOutput({ name: 'job_output', isError: true, exec: {}, content: big }, JOB).bounded, false)
  const image = [{ type: 'image' } as never]
  assert.equal(boundJobOutput({ name: 'job_output', isError: false, exec: {}, content: image }, JOB).bounded, false)
})

test('item1: a cap too small for the notice still keeps the notice', () => {
  const out = boundJobOutput({ name: 'job_output', isError: false, exec: {}, content: [text('q'.repeat(5000))] },
    { enabled: true, maxBytes: 1, spillRoot: '' })
  assert.equal(out.bounded, true)
  const logged = out.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.ok(logged.includes('truncated'))
})
// ---------------------------------------------------------------------------
// item 2: the cost ledger
// ---------------------------------------------------------------------------

test('item2: ledgerLine records the usage the event already carries', () => {
  const line = ledgerLine('s1', {
    compactionId: 'c-1', shadowedTokenCount: 54105, shadowedSeqs: [1, 2, 3], provider: 'a',
    model: 'deepseek-flash', maxTokens: 65536,
    usage: { inputTokens: 87531, outputTokens: 2605, totalTokens: 110872, cacheReadTokens: 20736 },
  }, new Date('2026-10-02T00:00:00.000Z'))
  const parsed = JSON.parse(line) as Record<string, unknown>
  assert.equal(parsed.time, '2026-10-02T00:00:00.000Z')
  assert.equal(parsed.session, 's1')
  assert.equal(parsed.shadowedTokens, 54105)
  assert.equal(parsed.shadowedNodes, 3)
  assert.deepEqual(parsed.usage, { inputTokens: 87531, outputTokens: 2605, totalTokens: 110872, cacheReadTokens: 20736 })
})

test('item2: ledgerLine omits what the event does not carry instead of inventing a zero', () => {
  const parsed = JSON.parse(ledgerLine('s2', {}, new Date(0))) as Record<string, unknown>
  assert.equal(parsed.usage, undefined, 'no usage is reported as no usage, not as zeros')
  assert.equal(parsed.shadowedTokens, undefined)
})

test('item2: ledgerLine drops non-numeric and non-finite usage fields', () => {
  const parsed = JSON.parse(ledgerLine('s3', {
    usage: { inputTokens: 1, outputTokens: 'lots', totalTokens: Number.NaN },
  }, new Date(0))) as { usage: Record<string, number> }
  assert.deepEqual(parsed.usage, { inputTokens: 1 })
})

test('item2: appendLedger writes one line per call and is off when disabled', () => {
  const root = scratch()
  try {
    const file = join(root, 'nested', 'cost.jsonl')
    assert.equal(appendLedger({ enabled: true, file }, '{"a":1}'), true)
    assert.equal(appendLedger({ enabled: true, file }, '{"a":2}'), true)
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"a":2}\n')
    assert.equal(appendLedger({ enabled: false, file }, '{"a":3}'), false)
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n{"a":2}\n')
    assert.equal(appendLedger({ enabled: true, file: '' }, '{"a":4}'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
// ---------------------------------------------------------------------------
// item 3: injection dedup
// ---------------------------------------------------------------------------

/** One injected message with a producer source. */
function injected(id: string, kind: string, body: string, form = 'snapshot'): any {
  return { id, role: 'user', content: [text(body)], source: { kind, form } }
}

test('item3: drops the later of two byte-identical injections from one producer', () => {
  const a = injected('1', 'runtime-context', 'SAME')
  const b = injected('2', 'runtime-context', 'SAME')
  const out = dedupeInjections([a, b], { enabled: true })
  assert.deepEqual(out.messages, [a])
  assert.equal(out.dropped.length, 1)
})

test('item3: keeps distinct bodies from one producer', () => {
  const out = dedupeInjections([injected('1', 'time-context', 'T1'), injected('2', 'time-context', 'T2')], { enabled: true })
  assert.equal(out.messages.length, 2, '19 distinct time-context bodies measured; none may be dropped')
  assert.equal(out.dropped.length, 0)
})

test('item3: never treats a human turn as a repeat', () => {
  const out = dedupeInjections([injected('1', 'user', 'yes'), injected('2', 'user', 'yes')], { enabled: true })
  assert.equal(out.messages.length, 2)
})

test('item3: keeps identical bodies from different producers', () => {
  const out = dedupeInjections([injected('1', 'runtime-context', 'SAME'), injected('2', 'skill-catalog', 'SAME')], { enabled: true })
  assert.equal(out.messages.length, 2, 'provenance is part of the identity')
})

test('item3: keeps identical bodies under different forms', () => {
  const out = dedupeInjections([injected('1', 'guard', 'SAME', 'notice'), injected('2', 'guard', 'SAME', 'snapshot')], { enabled: true })
  assert.equal(out.messages.length, 2)
})

test('item3: is a no-op with the switch off, and returns the same array', () => {
  const input = [injected('1', 'runtime-context', 'SAME'), injected('2', 'runtime-context', 'SAME')]
  const out = dedupeInjections(input, { enabled: false })
  assert.equal(out.messages, input, 'off means the very same array, not a copy')
  assert.equal(out.dropped.length, 0)
})

test('item3: leaves a message it cannot read as text alone', () => {
  const image = { id: '1', role: 'user', content: [{ type: 'image' }], source: { kind: 'runtime-context' } }
  assert.equal(messageBody(image as never), undefined)
  assert.equal(dedupeInjections([image, { ...image, id: '2' }] as never, { enabled: true }).messages.length, 2)
})

test('item3: reads an empty body as empty text, not as unreadable', () => {
  const a = injected('1', 'runtime-context', '')
  assert.equal(messageBody(a), '')
  assert.equal(dedupeInjections([a, injected('2', 'runtime-context', '')], { enabled: true }).messages.length, 1)
})
// ---------------------------------------------------------------------------
// item 4: repeat-read suppression
// ---------------------------------------------------------------------------

test('item4: rereadKey separates the parameters that change the answer', () => {
  assert.equal(rereadKey({ file_path: '/a' }), '/a\u0000-\u0000-')
  assert.notEqual(rereadKey({ file_path: '/a' }), rereadKey({ file_path: '/a', offset: 1 }))
  assert.notEqual(rereadKey({ file_path: '/a', offset: 1 }), rereadKey({ file_path: '/a', offset: 2 }))
  assert.notEqual(rereadKey({ file_path: '/a' }), rereadKey({ file_path: '/b' }))
  assert.equal(rereadKey({}), undefined)
  assert.equal(rereadKey(null), undefined)
  assert.equal(rereadKey({ file_path: '' }), undefined)
})

test('item4: the first read is recorded, the second is a pointer', () => {
  const root = scratch()
  try {
    const file = join(root, 'f.txt')
    writeFileSync(file, 'content')
    const seen = new Map()
    const first = suppressRepeatRead('read', { file_path: file }, seen, { enabled: true })
    assert.equal(first.suppress, false, 'the first read is served in full')
    assert.ok(first.record !== undefined, 'and its stamp is recorded')
    seen.set(rereadKey({ file_path: file }), first.record)
    const second = suppressRepeatRead('read', { file_path: file }, seen, { enabled: true })
    assert.equal(second.suppress, true)
    const pointer = second.text ?? ''
    assert.ok(pointer.includes(file), 'the pointer names the path')
    assert.ok(pointer.includes('has not changed'), 'and says why it is safe')
    assert.ok(pointer.includes('offset'), 'and names the way to force the bytes back')
    assert.ok(!pointer.includes('content'), 'and does not repeat the file body')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('item4: a changed file voids the pointer', () => {
  const root = scratch()
  try {
    const file = join(root, 'f.txt')
    writeFileSync(file, 'one')
    const seen = new Map()
    seen.set(rereadKey({ file_path: file }), stampOf(file))
    writeFileSync(file, 'one and a bit more')
    const out = suppressRepeatRead('read', { file_path: file }, seen, { enabled: true })
    assert.equal(out.suppress, false, 'a stale pointer would be a silent wrong value')
    assert.ok((out.reason ?? '').includes('changed'))
    assert.ok(out.record !== undefined, 'and the new stamp becomes the baseline')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('item4: switch off, other tools, and a missing file are all served normally', () => {
  const root = scratch()
  try {
    const file = join(root, 'f.txt')
    writeFileSync(file, 'x')
    const seen = new Map()
    seen.set(rereadKey({ file_path: file }), stampOf(file))
    assert.equal(suppressRepeatRead('read', { file_path: file }, seen, { enabled: false }).suppress, false)
    assert.equal(suppressRepeatRead('pwsh', { file_path: file }, seen, { enabled: true }).suppress, false)
    const gone = suppressRepeatRead('read', { file_path: join(root, 'nope.txt') }, seen, { enabled: true })
    assert.equal(gone.suppress, false)
    assert.equal(gone.record, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('item4: stampOf reports size and mtime and refuses a directory', () => {
  const root = scratch()
  try {
    const file = join(root, 'f.txt')
    writeFileSync(file, 'abc')
    assert.equal(stampOf(file)?.size, 3)
    assert.equal(typeof stampOf(file)?.mtimeMs, 'number')
    assert.equal(stampOf(root), undefined, 'a directory is not a readable file')
    assert.equal(stampOf(join(root, 'missing')), undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
// ---------------------------------------------------------------------------
// the settle envelope: a dumb pipe that knows no protocol
//
// Guard keeps the closing message's TAIL verbatim and nothing else. It does not
// know what a status line looks like, what a summary line is, or what headings a
// dispatch brief asks for — `@t4r71/dsh-task` owns all of that. Every test here
// asserts only that a slice of the ORIGINAL text appears character for character.
// A test that matched on `状态：` or `## 结论` would be reintroducing the coupling
// this shape exists to remove.
// ---------------------------------------------------------------------------

/** A settlement message shaped exactly as `createSettlementMessage` builds one. */
function settlement(closing: string, childId = 'child-1'): any {
  return {
    id: 'm1',
    role: 'user',
    content: [
      text('Background subagent ' + childId + ' finished and will do no further work unless you send it more.'),
      text('Its closing message:'),
      text(closing),
    ],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent ' + childId, senderSessionId: childId },
  }
}

/** The envelope part of a rewritten settlement: everything after the lead-ins. */
function envelopeBody(content: any[] | undefined): string {
  assert.ok(content !== undefined && content.length > 0)
  return (content as any[])[(content as any[]).length - 1].text as string
}

/** The whole envelope message as one string, for the "appears verbatim" checks. */
function envelopeWhole(content: any[] | undefined): string {
  assert.ok(content !== undefined)
  return (content as any[]).map(b => (b.type === 'text' ? b.text : '')).join('\n')
}

/** Characters, counted the same way `tailExcerpt` counts them. */
function chars(value: string): number {
  return Array.from(value).length
}

test('tailExcerpt returns the tail verbatim, with no interpretation of what it holds', () => {
  const closing = ['intro line', 'middle', '尾行一', '尾行二'].join('\n')
  const tail = tailExcerpt(closing, 20)
  assert.ok(closing.endsWith(tail), 'the excerpt is a suffix of the original, unmodified')
  // Twenty characters reach back into 'middle', so the budget lands mid-line and
  // the walk-back drops that partial line rather than shipping half of it.
  assert.equal(tail, 'middle\n尾行一\n尾行二', 'the cut is on a line boundary, not mid-line')
  assert.equal(tail.split('\n')[0], 'middle', 'and the opening line is whole')
  assert.ok(chars(tail) <= 20)
  // The property that matters at any budget: what comes back is a literal suffix
  // of the original, and it starts on a line boundary unless no boundary fits.
  for (const budget of [3, 8, 14, 19, 21, 25, 40]) {
    const cut = tailExcerpt(closing, budget)
    assert.ok(closing.endsWith(cut), 'budget ' + String(budget) + ' is a suffix of the original')
    assert.ok(chars(cut) <= budget, 'budget ' + String(budget) + ' is an upper bound')
    assert.ok(cut === '' || cut === closing || closing.includes('\n' + cut),
      'budget ' + String(budget) + ' starts on a line boundary: ' + JSON.stringify(cut))
  }
})

test('tailExcerpt keeps the input untouched when it already fits', () => {
  const closing = 'a short closing message\nwith two lines'
  assert.equal(tailExcerpt(closing, 500), closing)
  assert.equal(tailExcerpt(closing, chars(closing)), closing, 'exactly the budget keeps it all')
})

test('tailExcerpt cuts one over-long line hard, and the result never exceeds the budget', () => {
  const long = 'x'.repeat(500)
  const tail = tailExcerpt(long, 20)
  assert.equal(tail, 'x'.repeat(20), 'no newline to cut on, so the cut is at the budget')
  assert.equal(chars(tail), 20)
  for (const budget of [1, 2, 3, 7, 50, 499]) {
    assert.ok(chars(tailExcerpt(long, budget)) <= budget, 'budget ' + String(budget) + ' is a bound')
  }
  assert.equal(tailExcerpt(long, 0), '', 'zero keeps nothing')
})

// --- the core invariant -----------------------------------------------------

test('dumb pipe: the tail of the closing message appears character for character', () => {
  // The child wrote the two lines the dispatch brief asks for, at the end, where
  // the brief asks for them. Guard has no idea what they mean and does not look
  // for them — the assertions below compare the literal slice of the closing
  // message the envelope is supposed to carry, and never match on its content.
  // 200 filler lines, so the message is far larger than the 500-character default
  // and the tail really is a tail rather than the whole thing.
  const opening = Array.from({ length: 200 }, (_v, i) => 'filler line ' + String(i)).join('\n')
  const ending = ['状态：完成', '接线完成，测试全绿。'].join('\n')
  const closing = opening + '\n' + ending
  const content = envelopeContent(settlement(closing) as never, { enabled: true, tailChars: 500 })
  const body = envelopeBody(content)
  const tail = tailExcerpt(closing, 500)
  assert.ok(chars(closing) > 500, 'the fixture really is longer than the budget')
  assert.ok(chars(tail) <= 500, 'the tail respects the budget')
  assert.ok(closing.endsWith(tail), 'the tail is a literal suffix of what the child wrote')
  assert.ok(tail.endsWith(ending), 'and it ends on the child\'s last line, verbatim')
  assert.ok(!tail.includes('filler line 0'), 'the opening is genuinely gone, so this is a tail')
  assert.ok(body.includes(tail + '\n'), 'and those characters are in the envelope, verbatim')
  // A tight budget: the two lines still survive whole, because the cut walks back
  // to a line boundary rather than shipping half a line.
  const tight = tailExcerpt(closing, 40)
  assert.ok(tight.endsWith(ending), 'a tight budget still carries the last two lines whole')
  assert.ok(chars(tight) <= 40, 'and it stays inside the budget: ' + String(chars(tight)))
  const tightBody = envelopeBody(envelopeContent(settlement(closing) as never, { enabled: true, tailChars: 40 }))
  assert.ok(tightBody.includes(tight + '\n'), 'the tight tail is reproduced verbatim too')
})

test('dumb pipe: a child that followed no convention at all is preserved just the same', () => {
  // Deliberately noisy: no status line, no headings, unbalanced quotes, a stray
  // percent sign. A pipe that interprets nothing has nothing to be confused by.
  const messy = [
    'so here\'s the thing %% ',
    '    weird   indentation',
    '',
    '## not one of anybody\'s headings',
    'trailing backslash \\',
  ].join('\n')
  const body = envelopeBody(envelopeContent(settlement(messy) as never, { enabled: true, tailChars: 500 }))
  assert.ok(body.includes(messy + '\n'), 'the whole closing message is inside the envelope unchanged')
  assert.ok(body.includes('sha256 '), 'and it is still spilled and hashed')
  const path = /Full text: (\S+)/.exec(body)?.[1]
  assert.ok(path !== undefined)
  assert.equal(readFileSync(path as string, 'utf8'), messy, 'read-back is exactly what was written')
})

test('dumb pipe: no protocol text is invented for a child that wrote none', () => {
  const body = envelopeBody(envelopeContent(settlement('just prose about nothing') as never,
    { enabled: true, tailChars: 500 }))
  assert.ok(body.includes('just prose about nothing'), 'its own words are carried')
  // The envelope adds framing and a pointer. It must not add a status line:
  // guard has no idea the token exists, and could only print one by inventing it.
  assert.ok(!body.includes('状态：'), 'nothing is fabricated')
})

test('dumb pipe: the envelope is the lead-ins, the tail and the pointer — nothing else', () => {
  const closing = '## 结论\nshipped\n\n## 证据\nsrc/a.ts:12\n\n## 判不了\nnone'
  const content = envelopeContent(settlement(closing) as never, { enabled: true, tailChars: 500 })
  assert.equal(content?.[0]?.type === 'text' ? content[0].text : '',
    'Background subagent child-1 finished and will do no further work unless you send it more.')
  assert.equal(content?.[1]?.type === 'text' ? content[1].text : '', 'Its closing message:')
  assert.equal(content?.length, 3, 'two lead-ins and one envelope block')
  const body = envelopeBody(content)
  assert.ok(body.includes(closing + '\n'), 'the closing text is carried verbatim, headings and all')
  assert.ok(body.includes('Full text: '), 'the pointer is there')
  assert.ok(body.includes('sha256 '), 'and the hash')
  assert.ok(body.includes('bytes, '), 'and the byte count')
  assert.ok(body.includes('verbatim end of'), 'and the English note about what the tail is')
})

test('fidelity: envelopeContent spills the exact closing text and reports its real hash', () => {
  const closing = '## 结论\nshipped it\n\n## 证据\nsrc/a.ts:12\n\n## 判不了\nnone'
  const content = envelopeContent(settlement(closing) as never, { enabled: true, tailChars: 500 })
  const whole = envelopeWhole(content)
  assert.ok(whole.includes('sha256 ' + sha256Hex(closing)), 'the hash is of the exact closing text')
  assert.ok(whole.includes(String(byteLength(closing)) + ' bytes'), 'and the byte count is real')
  const path = /Full text: (\S+)/.exec(whole)?.[1]
  assert.ok(path !== undefined)
  assert.equal(readFileSync(path as string, 'utf8'), closing, 'the parent reads back exactly what the child wrote')
})

test('fidelity: the switch off returns undefined, and other messages are never touched', () => {
  assert.equal(envelopeContent(settlement('x'), { enabled: false, tailChars: 500 }), undefined)
  const user = { id: 'm2', role: 'user', content: [text('Its closing message:'), text('x')], source: { kind: 'user' } }
  assert.equal(envelopeContent(user as never, { enabled: true, tailChars: 500 }), undefined)
  const guard = { id: 'm3', role: 'user', content: [text('nudge')], source: { kind: 'guard', form: 'notice', summary: 's' } }
  assert.equal(envelopeContent(guard as never, { enabled: true, tailChars: 500 }), undefined)
})

test('fidelity: a shapeless or empty settlement is left untouched', () => {
  const noClosing = { id: 'm', role: 'user', source: { kind: 'subagent-settled', senderSessionId: 'c' },
    content: [text('Background subagent c finished and will do no further work unless you send it more.'), text('It left no closing message.')] }
  assert.equal(envelopeContent(noClosing as never, { enabled: true, tailChars: 500 }), undefined, 'nothing to save')
  const leafOnly = { id: 'm', role: 'user', source: { kind: 'subagent-settled' }, content: [text('Its closing message:')] }
  assert.equal(envelopeContent(leafOnly as never, { enabled: true, tailChars: 500 }), undefined)
  const image = { id: 'm', role: 'user', source: { kind: 'subagent-settled' },
    content: [text('Its closing message:'), { type: 'image' }] }
  assert.equal(envelopeContent(image as never, { enabled: true, tailChars: 500 }), undefined)
})

test('fidelity: an envelope is never wrapped a second time', () => {
  const first = envelopeContent(settlement('first closing message') as never, { enabled: true, tailChars: 500 })
  assert.ok(first !== undefined)
  const again = { ...settlement('first closing message'), content: first }
  assert.equal(envelopeContent(again as never, { enabled: true, tailChars: 500 }), undefined,
    'the second pass declines, so the tail cannot be nested')
})

test('fidelity: a concrete report survives at a control-plane size', () => {
  const closing = ['## 结论', 'delta 交付完成。', '', '## 证据', '- a.ts:1', '- b.ts:2', '', '## 判不了', '没测并发。',
    '', '状态：完成', '接线完成、默认未启用，测试 69/69 真跑通过。'].join('\n')
  const body = envelopeBody(envelopeContent(settlement(closing) as never, { enabled: true, tailChars: 500 }))
  assert.ok(body.length <= 700, 'the whole envelope stays a control-plane message: ' + String(body.length))
  assert.ok(body.includes('状态：完成'))
  assert.ok(body.includes('69/69'))
})

test('fidelity: when the spill cannot be written the original message is returned', () => {
  // The failure needs `tmpdir()` to name a path nothing can be written under,
  // which this process cannot arrange: `node:os` is a builtin whose namespace
  // cannot be redirected here, and the real spill root is writable by
  // construction. `spill-failure-child.mts` copies the two modules with that one
  // import redirected and runs the copy; this asserts the verdict of that run.
  const run = runSpillFailureChild()
  assert.equal(run.status, 0, 'writeSpill refuses and no envelope replaces the original: '
    + run.stdout + run.stderr)
  assert.match(run.stdout, /pass 2/, 'both redirected tests ran: ' + run.stdout)
})

// ---------------------------------------------------------------------------
// wiring: `apply` registers every seam, and each switch really gates
// ---------------------------------------------------------------------------

test('wiring: apply registers the five new hooks, with one pre-step listener for items 3/5/6', () => {
  const { ctx, listeners } = recordContext()
  apply(ctx, {} as never)
  for (const seam of ['tools/ptc-dispatch-log', 'session/event', 'agent/pre-step', 'tools/post-execute']) {
    assert.equal((listeners.get(seam) ?? []).length, 1, 'exactly one listener on ' + seam)
  }
  assert.equal((listeners.get('agent/pre-step') ?? []).length, 1,
    'items 3, 5 and 6 share ONE registration: two would each rebuild the array from next()')
})

test('wiring: the ptc-dispatch-log listener bounds a big job_output and honours its switch', async () => {
  const big = 'm'.repeat(40000)
  const run = async (config: Record<string, unknown>): Promise<any[]> => {
    const { ctx, listeners } = recordContext()
    apply(ctx, config as never)
    const fn = listenerOn(listeners, 'tools/ptc-dispatch-log')
    return await fn(
      { name: 'job_output', isError: false, subCallId: 'c:ptc:1', exec: {}, content: [text(big)] },
      async () => [text(big)],
    )
  }
  const on = await run({ jobOutputMaxBytes: 200 })
  assert.ok(on[0].text.includes('truncated'), 'on: the logged copy is bounded')
  const off = await run({ jobOutputBound: false })
  assert.equal(off[0].text.length, 40000, 'off: the logged copy is untouched')
})

test('wiring: the post-execute listener is a no-op for read while the switch is off', async () => {
  const { ctx, listeners } = recordContext()
  apply(ctx, {} as never)
  const fn = listenerOn(listeners, 'tools/post-execute')
  const accepted = { kind: 'accept', content: [text('file body')] }
  const out = await fn(
    { name: 'read', arguments: { file_path: 'x' }, agent: { session: { id: 's' } } },
    { isError: false, content: [text('file body')] },
    async () => accepted,
  )
  assert.equal(out, accepted, 'default off: the very same decision object comes back')
})

test('wiring: the session/event listener writes the ledger only for compaction/summary', () => {
  const root = scratch()
  try {
    const file = join(root, 'cost.jsonl')
    const { ctx, listeners } = recordContext()
    apply(ctx, { costLedgerFile: file } as never)
    const fn = listenerOn(listeners, 'session/event')
    fn({ id: 'sess-1' }, { type: 'turn/start', data: { turn: 1 } })
    assert.throws(() => readFileSync(file, 'utf8'), 'an unrelated event writes nothing')
    fn({ id: 'sess-1' }, { type: 'compaction/summary', data: { shadowedTokenCount: 10, usage: { inputTokens: 5 } } })
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>
    assert.equal(parsed.session, 'sess-1')
    assert.equal(parsed.shadowedTokens, 10)
    assert.deepEqual(parsed.usage, { inputTokens: 5 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('wiring: the ledger switch off writes nothing at all', () => {
  const root = scratch()
  try {
    const file = join(root, 'cost.jsonl')
    const { ctx, listeners } = recordContext()
    apply(ctx, { costLedger: false, costLedgerFile: file } as never)
    listenerOn(listeners, 'session/event')({ id: 's' }, { type: 'compaction/summary', data: {} })
    assert.throws(() => readFileSync(file, 'utf8'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('wiring: the pre-step listener envelopes and dedupes in one pass', async () => {
  const { ctx, listeners } = recordContext()
  apply(ctx, {} as never)
  const fn = listenerOn(listeners, 'agent/pre-step')
  const settled = settlement('## 结论\nok\n## 证据\nx.ts:1')
  const messages = [settled, injected('d1', 'runtime-context', 'IDENTICAL'), injected('d2', 'runtime-context', 'IDENTICAL')]
  const decision = await fn({ messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages.length, 2, 'one repeat dropped, the settlement kept')
  assert.ok(!decision.messages.some((m: any) => m.id === 'd2'), 'the later duplicate is the one that goes')
  const enveloped = decision.messages.find((m: any) => m.id === 'm1')
  const whole = enveloped.content.map((b: any) => b.text).join('\n')
  assert.ok(whole.includes('sha256 '), 'and the settlement is enveloped')
  assert.equal(enveloped.source, settled.source, 'source is kept verbatim')
  assert.equal(enveloped.id, 'm1', 'and so is the id')
})

test('wiring: both pre-step switches off leave every message byte-identical', async () => {
  const { ctx, listeners } = recordContext()
  apply(ctx, { settleEnvelope: false, dedupeInjections: false } as never)
  const fn = listenerOn(listeners, 'agent/pre-step')
  const settled = settlement('## 结论\nok')
  const messages = [settled, injected('d1', 'runtime-context', 'SAME'), injected('d2', 'runtime-context', 'SAME')]
  const decision = await fn({ messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages, messages, 'the very same array comes back')
  assert.equal(decision.messages[0].content, settled.content, 'and the harness original is intact')
})

test('wiring: a rejected step is never rewritten', async () => {
  const { ctx, listeners } = recordContext()
  apply(ctx, {} as never)
  const fn = listenerOn(listeners, 'agent/pre-step')
  const rejection = { kind: 'reject' }
  const out = await fn({ messages: [settlement('## 结论\nx')] }, async () => rejection)
  assert.equal(out, rejection)
})

test('wiring: enabled=false disables both pre-step rules even with their own switches on', async () => {
  const { ctx, listeners } = recordContext()
  apply(ctx, { enabled: false } as never)
  const fn = listenerOn(listeners, 'agent/pre-step')
  const messages = [settlement('## 结论\nx'), injected('d1', 'runtime-context', 'SAME'), injected('d2', 'runtime-context', 'SAME')]
  const decision = await fn({ messages, turn: 1, step: 1 }, async () => ({ kind: 'enter', messages }))
  assert.equal(decision.messages, messages)
})