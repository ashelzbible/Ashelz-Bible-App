// Exact rational numbers on BigInt. Thresholds such as ">= 1.5 x baseline" must be decided exactly, as the Python
// engine does with `fractions.Fraction`, so the phone and the server can never disagree because of float rounding.

const abs = (a) => (a < 0n ? -a : a);
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

export class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new RangeError('zero denominator');
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(abs(n), d) || 1n;
    this.n = n / g;
    this.d = d / g;
  }

  /** Parse a decimal string such as "1.5", "-2", "1e-07" or "1E+22". */
  static parse(str) {
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(str).trim());
    if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new SyntaxError(`not a decimal number: ${str}`);
    const frac = m[3] ?? '';
    let n = BigInt((m[2] || '0') + frac);
    let d = 10n ** BigInt(frac.length);
    const exp = m[4] ? Number(m[4]) : 0;
    if (exp >= 0) n *= 10n ** BigInt(exp); else d *= 10n ** BigInt(-exp);
    return new Q(m[1] === '-' ? -n : n, d);
  }

  static of(x) { return typeof x === 'bigint' ? new Q(x) : Number.isInteger(x) && Math.abs(x) < 2 ** 53 ? new Q(BigInt(x)) : Q.parse(String(x)); }
  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  divInt(k) { return new Q(this.n, this.d * BigInt(k)); }
  cmp(o) { const l = this.n * o.d, r = o.n * this.d; return l < r ? -1 : l > r ? 1 : 0; }
  gt(o) { return this.cmp(o) > 0; }
  ge(o) { return this.cmp(o) >= 0; }
  lt(o) { return this.cmp(o) < 0; }
  le(o) { return this.cmp(o) <= 0; }
  isPositive() { return this.n > 0n; }
  toNumber() { return Number(this.n) / Number(this.d); }
}
export const q = (x) => Q.of(x);
