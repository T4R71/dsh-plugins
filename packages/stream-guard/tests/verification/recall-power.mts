/**
 * ADVERSARIAL probe 9: is ">= 99.9% recall" measurable from this corpus?
 *
 * Defines the denominator, counts independent positives, and computes the exact
 * (Clopper-Pearson) one-sided lower confidence bound on recall for the observed data.
 * No lookup tables: the bound is computed directly from the regularized incomplete beta.
 *
 * Run: npx tsx packages/guard/stream-guard/tests/verification/recall-power.mts
 */

// --- regularized incomplete beta via continued fraction (Numerical Recipes betacf) ---
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300
  const qab = a + b, qap = a + 1, qam = a - 1
  let c = 1, d = 1 - qab * x / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d; h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return h
}
function gammaln(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x, tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j]! / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}
/** P(X <= k) for X ~ Binomial(n, p) */
function binomCdf(k: number, n: number, p: number): number {
  if (k >= n) return 1
  if (k < 0) return 0
  return regularizedBeta(n - k, k + 1, 1 - p)
}
function regularizedBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x))
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a
  return 1 - bt * betacf(b, a, 1 - x) / b
}
/** Exact one-sided lower confidence bound on p given k successes in n trials, confidence C. */
function cpLower(k: number, n: number, C = 0.95): number {
  if (k === 0) return 0
  if (k >= n) {
    // solve P(X <= n-1 | n, p) = 1 - C  ->  p^n = 1 - C
    return Math.pow(1 - C, 1 / n)
  }
  let lo = 0, hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (1 - binomCdf(k - 1, n, mid) > C) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

console.log('=== what the corpus can actually support for a ">= 99.9% recall" claim ===')
console.log('')
console.log('DENOMINATOR: what counts as a positive?')
console.log('  The design s positive unit is a "degeneration event" (a catastrophic restatement).')
console.log('  Candidates in the corpus:')
console.log('    - assistant messages with reasoning >= 1500 chars : 1448  (the scan s own gate)')
console.log('    - messages with echoR >= 0.9                       : 8    (detector-defined)')
console.log('    - INDEPENDENT of those (non-self-study sessions)    : 3')
console.log('')
console.log('  Every one of the 8 was found BY the detector being evaluated (echoR >= 0.9).')
console.log('  So the corpus supplies no independent, detector-free positive list. The')
console.log('  denominator is not "messages"; it is "degeneration events the model produced",')
console.log('  which nobody has enumerated. 8 - and 3 independent - is the whole evidence base.')
console.log('')
console.log('=== exact one-sided 95% lower confidence bounds on recall (Clopper-Pearson) ===')
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
console.log('  ' + pad('scenario', 46) + pad('n', 6) + pad('k', 6) + 'lower 95% bound on recall')
for (const [label, n, k] of [
  ['all catastrophic samples caught', 8, 8],
  ['independent catastrophic samples caught', 3, 3],
  ['minus the 5 self-study artefacts', 3, 3],
  ['if 1 of 8 were missed', 8, 7],
  ['a 1000-event corpus, all caught', 1000, 1000],
  ['a 3000-event corpus, all caught', 3000, 3000],
  ['a 10000-event corpus, all caught', 10000, 10000],
] as [string, number, number][]) {
  console.log('  ' + pad(label, 46) + pad(String(n), 6) + pad(String(k), 6) + (cpLower(k, n) * 100).toFixed(4) + '%')
}
console.log('')
console.log('=== how many positives are needed to even BOUND 99.9% ? ===')
for (const n of [3, 8, 100, 2995, 2996, 3000, 5000]) {
  const b = cpLower(n, n) * 100
  console.log('  n=' + pad(String(n), 6) + 'k=n -> lower bound ' + b.toFixed(4) + '%' + (b >= 99.9 ? '   >= 99.9% ACHIEVED' : ''))
}
const need = Math.ceil(Math.log(0.05) / Math.log(0.999))
console.log('')
console.log('  solve 0.999^n <= 0.05  ->  n >= ' + need + ' INDEPENDENT positives with ZERO misses')
console.log('  to claim a 95%-confident lower bound of 99.9% recall.')
console.log('  The corpus supplies 3. It is short by a factor of ' + (need / 3).toFixed(0) + '.')
console.log('')
console.log('=== upper bound on what the corpus can REFUTE ===')
console.log('  With 3 independent positives and 0 misses, the data are consistent with a true')
console.log('  recall anywhere in [' + (cpLower(3, 3) * 100).toFixed(1) + '%, 100%].')
console.log('  A detector with TRUE recall 40% would still show 3/3 with probability ' + Math.pow(0.4, 3).toFixed(3) + '.')
console.log('  A detector with TRUE recall 70% would still show 3/3 with probability ' + Math.pow(0.7, 3).toFixed(3) + '.')
console.log('  => "3/3 caught" is compatible with a recall as low as ~37% at 95% confidence.')
