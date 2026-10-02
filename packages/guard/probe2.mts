import { readFileSync } from 'node:fs'
const spec = readFileSync('tests/hooks.spec.ts', 'utf8').split(String.fromCharCode(10))
for (let i = 425; i < 470; i += 1) console.log(String(i + 1) + '\t' + spec[i])