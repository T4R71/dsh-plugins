import { readFileSync } from 'node:fs'
const src = readFileSync('tests/hooks.spec.ts', 'utf8')
const at = src.indexOf('function gistText')
const block = src.slice(at, at + 380)
console.log(JSON.stringify(block))