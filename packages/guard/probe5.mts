import { readFileSync } from 'node:fs'
const s = readFileSync('tests/hooks.spec.ts', 'utf8')
const i = s.indexOf('function gistText')
const seg = s.slice(i, i + 1400)
seg.split('\n').forEach((l, n) => console.log(String(n) + '|' + l.replace(/\t/g, '\\t')))