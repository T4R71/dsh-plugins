/**
 * Probe: the dynamic tool-name seam, end to end, on a real cordis context.
 *
 * Not a test — the tests are in tests/tool-names.spec.ts. This is the run whose
 * OUTPUT is quoted as evidence: it prints the real log lines a pin produces, and
 * the real members a stripped tools:sdk text retains.
 *
 * Run: node --import tsx/esm _probe-names.ts
 */
import { Context, Logger } from '@deepseek-ai/cordis'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PromptPlan from './src/index.ts'

const lines: string[] = []
// levels.default = 3: cordis's exporter default is INFO (1) and its numbers run
// ERROR 0 / INFO 1 / WARN 2 / DEBUG 3, so a warn line is dropped unless asked for.
const exporter = {
  levels: { default: 3 },
  export(message: unknown) { lines.push(Logger.format(exporter as never, message as never)) },
}

const sdkText = (tools: string[]): string => [
  'Use the SDK bindings below.',
  '',
  'interface ToolArgsMap {',
  ...tools.map(tool => '  /** ' + tool + '. */\n  ' + tool + ': { a: string };'),
  '}',
  '',
  'interface ToolOutputMap {',
  ...tools.map(tool => '  ' + tool + ': { b: string };'),
  '}',
].join('\n')

const members = (text: string): string[] => [...new Set([...text.matchAll(/^  ([A-Za-z_$][\w$]*): /gm)].map(m => m[1] ?? ''))]

async function assemble(ctx: Context, agent: unknown, tools: string[]): Promise<string> {
  const assembly = { sections: [{ name: 'persona', text: 'x' }, { name: 'tools:sdk', text: sdkText(tools) }], contexts: [], tools: [], variables: {} }
  const out = await ctx.waterfall('system-prompt/assemble', assembly, { agent, scope: agent }, async () => assembly) as { sections: { name: string; text: string }[] }
  return out.sections.find(s => s.name === 'tools:sdk')?.text ?? ''
}

const settle = (ms = 300) => new Promise(r => setTimeout(r, ms))
const rulesFileText = (body: string[]): string => ['version: 1', 'rules:', '  - id: lazy-schedule-tool-declarations', '    match:', '      kind: exact', '      value: tools:sdk', '    action:', '      kind: transform', '      transform:', ...body].join('\n') + '\n'

// ── Scenario A: a names file in force (opt-in, per-session pin) ──────────────
const dir = mkdtempSync(join(tmpdir(), 'pp-probe-'))
writeFileSync(join(dir, 'names.yaml'), ['version: 1', 'note: decision layer 2026-10-02T13:00:00+08:00', 'names:', '  - web_search'].join('\n') + '\n')
const rules = join(dir, 'prompt-plan.rules.yaml')
writeFileSync(rules, rulesFileText([
  '        - op: stripToolDecls',
  '          names:',
  '            - schedule_create',
  '            - schedule_delete',
  '            - schedule_list',
  '          namesFrom: names.yaml',
  '          dryRun: false',
]))

const ctxA = new Context()
ctxA.logger.exporter(exporter as never)
new PromptPlan(ctxA as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'art'), observe: false })
await settle()
console.log('=== A1. mount ===')
lines.forEach(l => console.log(l)); lines.length = 0

ctxA.emit('session/created', { id: 'session-A' } as never)
await settle()
console.log('=== A2. session/created ===')
lines.forEach(l => console.log(l)); lines.length = 0

const tools = ['read', 'schedule_create', 'schedule_delete', 'schedule_list', 'web_search', 'ghost_tool']
const stripped = await assemble(ctxA, { session: { id: 'session-A' } }, tools)
console.log('=== A3. assembly ===')
lines.forEach(l => console.log(l))
console.log('in :', tools.join(' '))
console.log('out:', members(stripped).join(' '))

// ── Scenario B: no namesFrom anywhere — the shipped rule file's own shape ────
lines.length = 0
const profileRules = 'M:/DSH-T4/home/profiles/desktop/prompt-plan.rules.yaml'
const ctxB = new Context()
ctxB.logger.exporter(exporter as never)
new PromptPlan(ctxB as never, { mode: 'rewrite', rulesFile: profileRules, artifactDir: join(dir, 'art'), observe: false })
await settle()
console.log('=== B1. mount against the LIVE profile rule file (read-only) ===')
lines.forEach(l => console.log(l)); lines.length = 0

ctxB.emit('session/created', { id: 'session-B' } as never)
await settle()
console.log('=== B2. session/created ===')
lines.forEach(l => console.log(l)); lines.length = 0

const kept = await assemble(ctxB, { session: { id: 'session-B' } }, ['read', 'schedule_create', 'schedule_delete', 'schedule_list', 'web_search'])
console.log('=== B3. assembly ===')
lines.forEach(l => console.log(l))
console.log('out:', members(kept).join(' '))

// ── Scenario C: the file is absent — the conservative fallback, at warn level ─
lines.length = 0
writeFileSync(rules, rulesFileText([
  '        - op: stripToolDecls',
  '          names:',
  '            - schedule_create',
  '          namesFrom: absent.yaml',
  '          dryRun: false',
]))
const ctxC = new Context()
ctxC.logger.exporter(exporter as never)
new PromptPlan(ctxC as never, { mode: 'rewrite', rulesFile: rules, artifactDir: join(dir, 'art'), observe: false })
await settle()
console.log('=== C1. mount with a MISSING names file ===')
lines.forEach(l => console.log(l)); lines.length = 0
const degraded = await assemble(ctxC, { session: { id: 'session-C' } }, ['read', 'schedule_create', 'web_search'])
console.log('=== C2. assembly ===')
lines.forEach(l => console.log(l))
console.log('out:', members(degraded).join(' '))

// ── Scenario D: the list names a tool this assembly does not declare ─────────
lines.length = 0
writeFileSync(join(dir, 'names.yaml'), ['version: 1', 'names:', '  - web_search', '  - ghost_tool'].join('\n') + '\n')
const rulesD = join(dir, 'rules-d.yaml')
writeFileSync(rulesD, rulesFileText([
  '        - op: stripToolDecls',
  '          names: []',
  '          namesFrom: names.yaml',
  '          dryRun: false',
]))
const ctxD = new Context()
ctxD.logger.exporter(exporter as never)
new PromptPlan(ctxD as never, { mode: 'rewrite', rulesFile: rulesD, artifactDir: join(dir, 'art'), observe: false })
await settle()
ctxD.emit('session/created', { id: 'session-D' } as never)
await settle()
lines.length = 0
const partial = await assemble(ctxD, { session: { id: 'session-D' } }, ['read', 'web_search'])
console.log('=== D. one requested name is not declared here ===')
lines.forEach(l => console.log(l))
console.log('out:', members(partial).join(' '))
