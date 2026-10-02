import { readFileSync } from 'node:fs'
const s = readFileSync('tests/hooks.spec.ts', 'utf8')
const i = s.indexOf('function gistText')
const j = s.indexOf('\\n}', i)
console.log(s.slice(i, j + 2))
console.log('---HAS FILTER: ' + String(s.slice(i, j).includes('.filter(')))