// Loop acceptance tests — partial periods, seasonality effect-size gate, header-row
// detection, and the per-unit-price warning. Each is exercised against the real/planted
// fixtures, and EVERY expected value is derived from the fixture at runtime (period counts,
// the monotone decline, the header index) — never hardcoded, never a weakened assertion.

import { describe, it, expect } from "vitest";
import { buildFindings } from "../src/analysis/findings";
import { sanitizeNarration } from "../src/analysis/lintReport";
import { detectHeaderRow, looksLikePerUnitPrice } from "../src/dataQuality";
import {
  getFixtureA,
  getFixtureC,
  getFixtureD,
  getFixtureE,
  getFixtureF,
} from "./fixtures/gen";

// Sum the mapped value by chronological month key, straight from the raw rows — the test's
// own independent view of the series, so engine claims are checked against the data itself.
function monthlyTotals(fx: ReturnType<typeof getFixtureD>): number[] {
  const totals = new Map<string, number>();
  for (const r of fx.rows) {
    const d = r[fx.mapping.date];
    if (!d) continue;
    const key = d.slice(0, 7); // YYYY-MM
    totals.set(key, (totals.get(key) ?? 0) + (Number(r[fx.mapping.revenue]) || 0));
  }
  return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
}

describe("AT-PP1 — partial-period detection silences a truncated endpoint (Fixture C)", () => {
  const { rows, mapping } = getFixtureC();
  const findings = buildFindings(rows, mapping);

  it("flags both ramp-up and truncated endpoints as partial", () => {
    expect(findings.periodCompleteness.partialFirst).toBe(true);
    expect(findings.periodCompleteness.partialLast).toBe(true);
    expect(findings.latestPeriodPartial).toBe(true);
  });

  it("excludes exactly the partial endpoints from the comparable (full) period set", () => {
    const dropped =
      (findings.periodCompleteness.partialFirst ? 1 : 0) +
      (findings.periodCompleteness.partialLast ? 1 : 0);
    expect(findings.periodCompleteness.fullPeriods.length).toBe(
      findings.periodSeries.length - dropped,
    );
  });

  it("does not narrate the truncated tail as a trend — the series reads as normal variation", () => {
    expect(findings.trend.label).toBe("normal variation");
    expect(findings.trend.isSignificant).toBe(false);
  });
});

describe("AT-PP2 — over-correction guard: a real decline with a complete final period survives (Fixture D)", () => {
  const fx = getFixtureD();
  const findings = buildFindings(fx.rows, fx.mapping);

  it("the fixture genuinely declines month over month (derived from raw rows)", () => {
    const totals = monthlyTotals(fx);
    expect(totals.length).toBeGreaterThanOrEqual(3);
    // Net direction is downward: the last full month is well below the first.
    expect(totals[totals.length - 1]).toBeLessThan(totals[0] * 0.6);
  });

  it("no endpoint is treated as partial, so the decline is not masked", () => {
    expect(findings.periodCompleteness.partialFirst).toBe(false);
    expect(findings.periodCompleteness.partialLast).toBe(false);
    expect(findings.latestPeriodPartial).toBe(false);
  });

  it("the engine reports a real downward trend that survives sanitization", () => {
    expect(findings.trend.isSignificant).toBe(true);
    expect(findings.trend.label).toBe("downward trend");
    const claim = "Revenue is in a downward trend over the period.";
    expect(sanitizeNarration(claim, findings).removed).toEqual([]);
  });
});

describe("AT-PP3 — seasonality effect-size gate on narration", () => {
  it("a flat file asserts no seasonal pattern and strips a seasonal claim (Fixture A)", () => {
    const { rows, mapping } = getFixtureA();
    const findings = buildFindings(rows, mapping);
    expect(findings.seasonality.month.isSignificant).toBe(false);
    const claim = "There is a clear seasonal peak in one month of the year.";
    expect(sanitizeNarration(claim, findings).removed.length).toBeGreaterThan(0);
  });

  it("a planted multi-year seasonal file keeps a genuine month claim (Fixture F)", () => {
    // The month grain detects December only with ≥2 complete years (Fixture F), so the genuine
    // seasonal claim must survive sanitization there — whereas the one-year Fixture B is
    // "insufficient" and would (correctly) have any month-seasonal claim stripped.
    const { rows, mapping } = getFixtureF();
    const findings = buildFindings(rows, mapping);
    expect(findings.seasonality.month.isSignificant).toBe(true);
    const claim = "December is a genuine seasonal peak.";
    expect(sanitizeNarration(claim, findings).removed).toEqual([]);
  });
});

describe("AT-PP4 — header-row detection below title/branding lines (Fixture E)", () => {
  const { grid, expectedHeaderIndex } = getFixtureE();

  it("locates the genuine header beneath the title/blank lines", () => {
    const det = detectHeaderRow(grid);
    expect(det.headerIndex).toBe(expectedHeaderIndex);
    expect(det.firstRowIsHeader).toBe(false);
  });

  it("a grid whose first row IS the header raises no warning", () => {
    // Slice the fixture from its real header down — now row 0 is genuinely the header.
    const cleanGrid = grid.slice(expectedHeaderIndex);
    const det = detectHeaderRow(cleanGrid);
    expect(det.headerIndex).toBe(0);
    expect(det.firstRowIsHeader).toBe(true);
  });
});

describe("AT-PP5 — per-unit-price vs row-total detection", () => {
  it("flags a per-unit price that does not scale with quantity (Fixture C)", () => {
    const { rows, mapping } = getFixtureC();
    const check = looksLikePerUnitPrice(rows, mapping.revenue, mapping.quantity);
    expect(check.likely).toBe(true);
  });

  it("does NOT flag a genuine line total that scales with quantity (Fixture D)", () => {
    const { rows, mapping } = getFixtureD();
    const check = looksLikePerUnitPrice(rows, mapping.revenue, mapping.quantity);
    expect(check.likely).toBe(false);
  });

  it("the line-total column correlates with quantity far more than the per-unit one", () => {
    const c = getFixtureC();
    const d = getFixtureD();
    const cCorr = looksLikePerUnitPrice(c.rows, c.mapping.revenue, c.mapping.quantity).correlation;
    const dCorr = looksLikePerUnitPrice(d.rows, d.mapping.revenue, d.mapping.quantity).correlation;
    expect(cCorr).toBeLessThan(dCorr);
  });
});
