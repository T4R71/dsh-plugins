// Verify the Fisher exact implementation against the hypergeometric definition.
function lgamma(x: number): number { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp); let ser = 1.000000000190015; for (let j = 0; j < 6; j++) ser += c[j]! / ++y; return -tmp + Math.log(2.5066282746310005 * ser / x) }
const lchoose = (n: number, k: number): number => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)
/** Two-sided Fisher exact. a=row1col1, b=row1col2, c=row2col1, d=row2col2. */
function fisher(a: number, b: number, c: number, d: number): number {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = a + b + c + d
  const prob = (k: number): number => Math.exp(lchoose(r1, k) + lchoose(r2, c1 - k) - lchoose(n, c1))
  const p0 = prob(a)
  let sum = 0
  for (let k = Math.max(0, c1 - r2); k <= Math.min(r1, c1); k++) { const p = prob(k); if (p <= p0 * (1 + 1e-9)) sum += p }
  return Math.min(1, sum)
}
console.log('sanity: a fair 2x2 with identical rates -> p should be large')
console.log('  5,5,5,5 -> p =', fisher(5, 5, 5, 5).toFixed(4))
console.log('sanity: strong association 20,5,5,20 -> p should be tiny')
console.log('  20,5,5,20 -> p =', fisher(20, 5, 5, 20).toExponential(3))
console.log('')
console.log('the measured tables:')
console.log('  turn-level   a=11 b=102 c=3 d=263 -> p =', fisher(11, 102, 3, 263).toFixed(4))
console.log('  session-lvl  a=2  b=13  c=3 d=58  -> p =', fisher(2, 13, 3, 58).toFixed(4))