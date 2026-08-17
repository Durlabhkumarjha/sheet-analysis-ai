// Layer 3 (charts) — the single chart-series validator. Every surface that renders a
// categorical series (dashboard bars, AI-report charts, Talk-to-Data chart commands) must
// route its data through validateChartSeries so the same two mistakes are caught in one
// place instead of being re-guarded inline at each render site:
//
//   1. Junk/missing buckets (ERROR / UNKNOWN / blank / "Missing/Invalid") rendered as if
//      they were a real category.
//   2. A grand-total row mixed in with its own components — e.g. a "Total" bar that equals
//      the sum of the other bars, which double-counts and dwarfs every real slice.
//
// It also sanity-checks a share/percentage breakdown: the parts should sum to ~100% against
// a single denominator. A breakdown that sums to far more (or less) than 100% signals the
// slices were computed against different denominators or include a total.

import { isJunkLabel } from "../metrics";

export type ChartPoint = { label: string; value: number };

export type ChartValidation = {
  items: ChartPoint[];
  issues: string[];
  dropped: { label: string; reason: string }[];
};

export type ValidateOptions = {
  // Treat values as a share/percentage breakdown (each slice a % of one whole). Enables the
  // "parts sum to ~100%" sanity check.
  isShare?: boolean;
  // Fractional tolerance for the total-vs-components match (default 2%).
  totalTolerance?: number;
};

// Labels that explicitly announce themselves as an aggregate. Domain-agnostic: these are
// structural words ("total", "sum", "all", "overall", "grand total"), never category values.
const TOTAL_LABEL = /\b(grand[\s-]?total|total|subtotal|sum|overall|all\s+(items|products|categories|regions))\b/i;

export function validateChartSeries(
  points: ChartPoint[],
  opts: ValidateOptions = {},
): ChartValidation {
  const issues: string[] = [];
  const dropped: { label: string; reason: string }[] = [];
  const tol = opts.totalTolerance ?? 0.02;

  // (1) Drop junk labels and non-finite/negative-for-share values.
  let items = points.filter((p) => {
    if (isJunkLabel(p.label)) {
      dropped.push({ label: String(p.label), reason: "junk/missing label" });
      return false;
    }
    if (!Number.isFinite(p.value)) {
      dropped.push({ label: p.label, reason: "non-finite value" });
      return false;
    }
    return true;
  });

  // (2) Grand-total-vs-components: if one slice's value ≈ the sum of all the OTHERS (within
  // tol) and there are at least 3 slices, that slice is a total mixed in with its parts.
  // Prefer an explicitly-named total; otherwise fall back to the largest matching slice.
  if (items.length >= 3) {
    const grandSum = items.reduce((s, p) => s + p.value, 0);
    let totalIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const rest = grandSum - items[i].value;
      if (rest <= 0) continue;
      const matchesRest = Math.abs(items[i].value - rest) <= tol * rest;
      if (!matchesRest) continue;
      // A named total wins immediately; an unnamed match must be the largest such slice.
      if (TOTAL_LABEL.test(items[i].label)) {
        totalIdx = i;
        break;
      }
      if (totalIdx === -1 || items[i].value > items[totalIdx].value) totalIdx = i;
    }
    if (totalIdx !== -1) {
      const t = items[totalIdx];
      issues.push(`Dropped "${t.label}" — it equals the sum of the other slices (a grand total mixed with its components).`);
      dropped.push({ label: t.label, reason: "grand total mixed with components" });
      items = items.filter((_, i) => i !== totalIdx);
    }
  }

  // (3) Share sanity: a percentage breakdown should sum to ~100% against one denominator.
  if (opts.isShare && items.length > 0) {
    const sum = items.reduce((s, p) => s + p.value, 0);
    if (sum > 105 || sum < 95) {
      issues.push(`Share breakdown sums to ${sum.toFixed(0)}%, not ~100% — slices may use different denominators or include a total.`);
    }
  }

  return { items, issues, dropped };
}
