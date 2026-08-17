// Small, dependency-free statistical primitives used by the verdict engine.
// Implementations are standard numerical-recipes approximations (erf, regularized
// incomplete gamma/beta) chosen so the whole stats layer stays in the browser with
// no framework. Accuracy is well within what a p<0.05 significance gate needs.

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Sample standard deviation (n-1). Returns 0 for fewer than 2 points.
export function stdDev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

// Coefficient of variation (stddev / mean), as a fraction. 0 when mean is 0.
export function coefficientOfVariation(xs: number[]): number {
  const m = mean(xs);
  if (m === 0) return 0;
  return stdDev(xs) / Math.abs(m);
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Abramowitz & Stegun 7.1.26 error-function approximation (|error| < 1.5e-7).
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// Standard normal CDF.
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Two-sided p-value for a standard-normal z statistic.
export function normalTwoSidedP(z: number): number {
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// Natural log of the gamma function (Lanczos approximation).
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized lower incomplete gamma P(a, x) via series / continued fraction.
function regularizedGammaP(a: number, x: number): number {
  if (x <= 0 || a <= 0) return 0;
  if (x < a + 1) {
    // Series expansion.
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < 200; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  // Continued fraction for Q(a,x), then P = 1 - Q.
  const tiny = 1e-30;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  const q = Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  return 1 - q;
}

// Upper-tail p-value for a chi-square statistic with df degrees of freedom.
export function chiSquareP(chi2: number, df: number): number {
  if (df <= 0) return 1;
  if (chi2 <= 0) return 1;
  return 1 - regularizedGammaP(df / 2, chi2 / 2);
}

// Continued fraction for the incomplete beta (Numerical Recipes `betacf`), evaluated by the
// modified Lentz method. Each iteration applies TWO coefficients — the even step (index 2m) and
// the odd step (index 2m+1) — keeping each `aa` aligned with the iteration index. Collapsing
// these into one branch-per-index loop double-counts the first coefficient (it is already baked
// into the initial `d = 1 - qab*x/qap`), which is the bug this replaces.
function betacf(x: number, a: number, b: number): number {
  const tiny = 1e-30;
  const eps = 3e-14;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    // Even step (coefficient d_{2m}).
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    // Odd step (coefficient d_{2m+1}).
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a, b).
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  // Use the symmetry relation I_x(a,b) = 1 - I_{1-x}(b,a) when x is past the CF's fast region.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betacf(x, a, b)) / a;
  }
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

// Upper-tail p-value for an F statistic with (df1, df2) degrees of freedom.
export function fDistributionP(f: number, df1: number, df2: number): number {
  if (f <= 0 || df1 <= 0 || df2 <= 0) return 1;
  const x = df2 / (df2 + df1 * f);
  return regularizedIncompleteBeta(x, df2 / 2, df1 / 2);
}

// Benjamini-Hochberg false-discovery-rate control. Given a parallel array of p-values
// (one per hypothesis tested simultaneously), returns a boolean per hypothesis: true
// when it stays significant after correcting for multiple comparisons at level `alpha`.
// Why this matters: testing N entities each at p<0.05 yields ~0.05*N false positives by
// chance alone — on 20 products you'd "find" one fake winner every time. BH finds the
// largest rank r where p(r) <= (r/N)*alpha and rejects all hypotheses ranked <= r.
export function benjaminiHochberg(pValues: number[], alpha = 0.05): boolean[] {
  const n = pValues.length;
  if (n === 0) return [];
  const ordered = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let maxRank = -1;
  for (let r = 0; r < n; r++) {
    if (ordered[r].p <= ((r + 1) / n) * alpha) maxRank = r;
  }
  const significant = new Array<boolean>(n).fill(false);
  for (let r = 0; r <= maxRank; r++) significant[ordered[r].i] = true;
  return significant;
}
