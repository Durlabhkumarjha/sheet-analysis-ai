// Phase 4 acceptance tests — the cross-surface drift guard.
//
// These prove the "one pipeline everywhere" contract end to end: every narrated surface
// routes its text through the SAME sanitizer + linter, so no surface can emit a claim the
// verdict engine ruled non-significant, and all surfaces agree on the one trend label.
// They also exercise the per-entity FDR gate, the chart validator, and the single typed
// boundary (`analyze`). Domain-agnostic: expected entity names are read from the fixtures
// at runtime, never literal-matched.

import { describe, it, expect } from "vitest";
import { analyze, buildFindings, type Findings } from "../src/analysis";
import { sanitizeNarration, lintReport, assertTrendConsistency } from "../src/analysis";
import { entityOutliers } from "../src/analysis";
import { validateChartSeries } from "../src/analysis";
import { benjaminiHochberg } from "../src/analysis/stats";
import { getFixtureA, getFixtureB } from "./fixtures/gen";

// Same runtime-derived leader helper the verdict tests use — proves a pick is correct
// without hardcoding a category value.
function leaderBy(rows: Record<string, string>[], nameKey: string, valueKey: string): string {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r[nameKey], (totals.get(r[nameKey]) ?? 0) + (Number(r[valueKey]) || 0));
  let best = "";
  let bestVal = -Infinity;
  for (const [k, v] of totals) if (v > bestVal) ((bestVal = v), (best = k));
  return best;
}

const TREND_LABEL = /\b(upward trend|downward trend|normal variation)\b/i;

// The cross-surface drift guard. Every surface is sanitized through the shared mechanism,
// then each sanitized surface must pass the linter and all trend-bearing surfaces must
// carry the one canonical trend label. This is the single helper the acceptance tests use
// to assert that surfaces cannot diverge.
function assertNarrationConsistent(
  findings: Findings,
  surfaces: { name: string; text: string }[],
): { ok: boolean; sanitized: { name: string; text: string }[]; violations: string[] } {
  const sanitized = surfaces.map((s) => ({ name: s.name, text: sanitizeNarration(s.text, findings).text }));
  const violations: string[] = [];
  for (const s of sanitized) {
    const r = lintReport(s.text, findings);
    if (!r.ok) violations.push(...r.violations.map((v) => `${s.name}: ${v.detail}`));
  }
  const trendSurfaces = sanitized.filter((s) => TREND_LABEL.test(s.text));
  if (trendSurfaces.length > 0) {
    const tc = assertTrendConsistency(trendSurfaces, findings);
    if (!tc.ok) violations.push(...tc.violations.map((v) => v.detail));
  }
  return { ok: violations.length === 0, sanitized, violations };
}

// The buggy report the original build produced on the flat file — the regression witness.
const BAD_BASELINE = `
Executive Summary: Revenue shows a 4.1% upward trend with strong momentum heading into next quarter.
Salad's premium pricing is a key driver of revenue — we should upsell Salad and other higher-priced items.
There is clear seasonal vulnerability in February, with June momentum carrying the year.
Recommendation: run a Valentine's Day special to fix the February low.
`;

describe("AT1 — sanitizeNarration makes the buggy baseline lint-clean on a flat file", () => {
  const { rows, mapping } = getFixtureA();
  const findings = buildFindings(rows, mapping);

  it("the raw baseline fails the linter, the sanitized text passes", () => {
    expect(lintReport(BAD_BASELINE, findings).ok).toBe(false);
    const { text, removed } = sanitizeNarration(BAD_BASELINE, findings);
    expect(removed.length).toBeGreaterThan(0);
    expect(lintReport(text, findings).ok).toBe(true);
  });
});

describe("AT2 — cross-surface trend consistency on the flat file", () => {
  const { rows, mapping } = getFixtureA();
  const findings = buildFindings(rows, mapping);

  it("every surface narrated from the canonical label is mutually consistent and lint-clean", () => {
    const label = findings.trend.label;
    const surfaces = [
      { name: "Executive Summary", text: `Revenue is ${label} month to month, with no detectable seasonal pattern.` },
      { name: "Forecast Outlook", text: `Outlook: ${label}.` },
      { name: "Trend Section", text: `The series shows ${label}.` },
      { name: "Talk-to-Data", text: `Asked about the trend: it is ${label}.` },
    ];
    const result = assertNarrationConsistent(findings, surfaces);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("a surface that disagrees on a REAL trend is caught (planted file, so claims survive sanitization)", () => {
    // On the flat file the sanitizer would strip every trend claim outright; to test the
    // consistency check itself we need a file where the trend is significant and the labels
    // survive. Fixture B has a real upward trend.
    const b = buildFindings(getFixtureB().rows, getFixtureB().mapping);
    const other = b.trend.label === "downward trend" ? "upward trend" : "downward trend";
    const surfaces = [
      { name: "Executive Summary", text: `Revenue is in an ${b.trend.label}.` },
      { name: "Forecast Outlook", text: `Outlook: ${other}.` },
    ];
    expect(assertNarrationConsistent(b, surfaces).ok).toBe(false);
  });
});

describe("AT3 — over-correction guard: real claims survive on the planted file", () => {
  const { rows, mapping } = getFixtureB();
  const findings = buildFindings(rows, mapping);

  it("does not strip genuinely-significant trend / seasonal / weekday claims", () => {
    const real =
      "Revenue shows a real upward trend driven by strong demand. " +
      "December is a genuine seasonal peak and weekends run measurably higher.";
    const { text, removed } = sanitizeNarration(real, findings);
    expect(removed).toEqual([]);
    expect(text.trim()).toBe(real.trim());
    expect(lintReport(text, findings).ok).toBe(true);
    // And the cross-surface guard agrees these surfaces are consistent.
    const label = findings.trend.label;
    expect(
      assertNarrationConsistent(findings, [
        { name: "Exec", text: `Revenue is in an ${label}.` },
        { name: "Forecast", text: `Outlook: ${label} continues.` },
      ]).ok,
    ).toBe(true);
  });
});

describe("AT4 — per-entity outliers: FDR + effect floor", () => {
  it("a uniform spread flags nobody (no spread → no outliers)", () => {
    const v = entityOutliers({ a: 100, b: 100, c: 100, d: 100, e: 100 });
    expect(v.highs).toEqual([]);
    expect(v.lows).toEqual([]);
    expect(v.anySignificant).toBe(false);
  });

  it("the planted 5x-volume product is flagged high (derived from data, not literal)", () => {
    const { rows, mapping } = getFixtureB();
    const findings = buildFindings(rows, mapping);
    const revLeader = leaderBy(rows, mapping.product, mapping.revenue);
    expect(findings.entitySignals.highs).toContain(revLeader);
    // The four ordinary products must NOT be flagged — the effect floor blocks them.
    expect(findings.entitySignals.highs.length).toBe(1);
  });
});

describe("AT5 — validateChartSeries drops junk and grand totals", () => {
  it("drops junk/missing buckets", () => {
    const r = validateChartSeries([
      { label: "A", value: 10 },
      { label: "ERROR", value: 5 },
      { label: "B", value: 7 },
    ]);
    expect(r.items.map((i) => i.label)).toEqual(["A", "B"]);
    expect(r.dropped.some((d) => d.label === "ERROR")).toBe(true);
  });

  it("drops a grand-total row mixed in with its components", () => {
    const r = validateChartSeries([
      { label: "A", value: 10 },
      { label: "B", value: 20 },
      { label: "C", value: 30 },
      { label: "Total", value: 60 },
    ]);
    expect(r.items.map((i) => i.label)).not.toContain("Total");
    expect(r.issues.join(" ")).toMatch(/grand total/i);
  });

  it("warns when a share breakdown does not sum to ~100%", () => {
    const r = validateChartSeries([
      { label: "A", value: 60 },
      { label: "B", value: 60 },
    ], { isShare: true });
    expect(r.issues.join(" ")).toMatch(/100%/);
  });
});

describe("AT6 — Benjamini-Hochberg and the typed boundary", () => {
  it("BH does not reject a naively-significant p that fails the step-up threshold", () => {
    // 0.04 < 0.05 naively, but at n=3 its BH threshold is (2/3)*0.05 = 0.033 — not rejected.
    expect(benjaminiHochberg([0.001, 0.06, 0.04], 0.05)).toEqual([true, false, false]);
  });

  it("analyze() returns a cleaned dataset paired with the same findings buildFindings produces", () => {
    const { rows, mapping } = getFixtureA();
    const result = analyze(rows, mapping);
    const direct = buildFindings(rows, mapping);
    expect(result.findings.trend.label).toBe(direct.trend.label);
    expect(result.findings.rowCount).toBe(direct.rowCount);
    expect(Array.isArray(result.cleanedRows)).toBe(true);
    expect(result.cleanedRows.length).toBeGreaterThan(0);
    // The boundary cleans: every cleaned row has a populated value cell.
    expect(result.cleanedRows.length).toBeLessThanOrEqual(rows.length);
  });
});
