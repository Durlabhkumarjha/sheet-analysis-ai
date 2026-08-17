// Semantic-guard acceptance tests (Computation Lineage Audit, Phase 3). Each proves one of
// the column-role / value-semantics / percentage-range guards against the REAL fixtures.
// Every expected value is derived from the fixture at runtime — never hardcoded, never weakened.

import { describe, it, expect } from "vitest";
import {
  cleanCategory,
  INVALID_BUCKET,
  toNumber,
  canonicalRows,
  hasNumericValue,
  parseValidDate,
  computeShares,
  isValidShareFraction,
} from "../src/metrics";
import { isTierableDimension, looksLikePerUnitPrice } from "../src/dataQuality";
import { THRESHOLDS } from "../src/analysis/verdicts";
import { formatPercent } from "../src/App";
import { getFixtureA, getFixtureC, getFixtureD } from "./fixtures/gen";

// Independent group-by-sum — the test's own view, mirroring rankBy without importing it.
function groupSum(rows: Record<string, string>[], labelCol: string, valueCol: string) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const label = cleanCategory(r[labelCol]);
    if (label === INVALID_BUCKET) continue;
    const v = toNumber(r[valueCol]);
    if (!Number.isFinite(v)) continue;
    totals.set(label, (totals.get(label) ?? 0) + v);
  }
  return [...totals.entries()]
    .map(([label, revenue]) => ({ label, revenue }))
    .sort((a, b) => b.revenue - a.revenue);
}

function distinctCount(rows: Record<string, string>[], col: string) {
  const s = new Set<string>();
  for (const r of rows) {
    const v = cleanCategory(r[col]);
    if (v !== INVALID_BUCKET) s.add(v);
  }
  return { distinct: s.size, sampleSize: rows.length };
}

// ---------------------------------------------------------------------------------------
describe("GUARD 1 — cardinality/role guard refuses high-cardinality fields as tier dimensions (R1)", () => {
  const { rows } = getFixtureC(); // real mobile_sales_data.csv
  const cols = Object.keys(rows[0]);
  const MAX = THRESHOLDS.maxTierDimensionCardinality;
  const MIN = THRESHOLDS.minTierDimensionCardinality;
  const RATIO = THRESHOLDS.maxTierUniqueRatio;

  it("the mobile file genuinely contains an identifier-like (very high cardinality) column", () => {
    // Proves the test bites: at least one text column has more distinct values than the ceiling.
    const overCeiling = cols.filter((c) => distinctCount(rows, c).distinct > MAX);
    expect(overCeiling.length).toBeGreaterThan(0);
  });

  it("every column above the cardinality ceiling is rejected as a tier dimension", () => {
    for (const c of cols) {
      const { distinct, sampleSize } = distinctCount(rows, c);
      if (distinct > MAX) {
        expect(
          isTierableDimension(distinct, sampleSize, MAX, MIN, RATIO),
          `${c} (${distinct} distinct) must not be tierable`,
        ).toBe(false);
      }
    }
  });

  it("a near-identifier (≈1 distinct value per row) is rejected even below the absolute ceiling", () => {
    // Synthetic: 600 distinct over 700 rows → ratio ~0.86 > maxTierUniqueRatio, but < MAX.
    expect(isTierableDimension(600, 700, MAX, MIN, RATIO)).toBe(false);
  });

  it("a genuine bounded category (handful of repeated values) is accepted", () => {
    // e.g. 12 distinct labels across all rows — well inside the band.
    expect(isTierableDimension(12, rows.length, MAX, MIN, RATIO)).toBe(true);
  });

  it("too few distinct values to Pareto is rejected (mobile has only 2 products)", () => {
    const products = distinctCount(rows, getFixtureC().mapping.product);
    expect(products.distinct).toBeLessThan(MIN);
    expect(isTierableDimension(products.distinct, products.sampleSize, MAX, MIN, RATIO)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
describe("GUARD 2 — value-role guard detects a per-unit price vs a row total (R2)", () => {
  it("flags the mobile Price column as per-unit (does not scale with quantity)", () => {
    const { rows, mapping } = getFixtureC();
    expect(looksLikePerUnitPrice(rows, mapping.revenue, mapping.quantity).likely).toBe(true);
  });

  it("does not flag a genuine line total that scales with quantity (Fixture D)", () => {
    const { rows, mapping } = getFixtureD();
    expect(looksLikePerUnitPrice(rows, mapping.revenue, mapping.quantity).likely).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
describe("GUARD 3 — range guard: shares are fractions, never exceed 100%, sum to ~100% (R3/R4)", () => {
  it("customer concentration on the mobile file is a tiny, valid fraction (~0.14%), not double-scaled", () => {
    const { rows } = getFixtureC();
    // Customer concentration = each customer's summed value over the grand total.
    const byCustomer = groupSum(rows, "Customer Name", "Price");
    expect(byCustomer.length).toBeGreaterThan(1000); // genuinely high-cardinality entity set

    const { top3Share, rows: shareRows } = computeShares(byCustomer);

    // Independent recomputation of the top-3 share straight from the grouped totals.
    const total = byCustomer.reduce((s, c) => s + c.revenue, 0);
    const expectedTop3 = byCustomer.slice(0, 3).reduce((s, c) => s + c.revenue, 0) / total;
    expect(top3Share).toBeCloseTo(expectedTop3, 10);

    // The real answer is a fraction of a percent — emphatically not ~0.7 (70%) or >1 (a
    // double-scale artifact). Asserted as a band so it stays derived, not hardcoded.
    expect(top3Share).toBeGreaterThan(0);
    expect(top3Share).toBeLessThan(0.01); // < 1%
    expect(isValidShareFraction(top3Share)).toBe(true);
    for (const r of shareRows) expect(isValidShareFraction(r.share)).toBe(true);
  });

  it("no rendered share exceeds 100% and shares sum to ~100% (mobile customers + cafe products)", () => {
    const cases: { label: string; items: { label: string; revenue: number }[] }[] = [
      { label: "mobile customers", items: groupSum(getFixtureC().rows, "Customer Name", "Price") },
      { label: "cafe products", items: groupSum(getFixtureA().rows, getFixtureA().mapping.product, getFixtureA().mapping.revenue) },
    ];
    for (const { label, items } of cases) {
      const { rows, total } = computeShares(items); // no limit → full set
      expect(total, label).toBeGreaterThan(0);
      const sum = rows.reduce((s, r) => s + r.share, 0);
      expect(sum, `${label} shares must sum to ~1`).toBeCloseTo(1, 6);
      for (const r of rows) {
        expect(isValidShareFraction(r.share), `${label}: ${r.label} share in range`).toBe(true);
        expect(r.share, `${label}: ${r.label} ≤ 100%`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("GUARD 4 — percentage convention: formatPercent expects a fraction (R3 regression)", () => {
  it("renders a 0–1 fraction as a percent (0.142 → 14.2%)", () => {
    expect(formatPercent(0.142)).toBe("14.2%");
  });

  it("an already-×100 value double-scales — the exact bug the comparison table had", () => {
    // 14.2 (already a percentage) wrongly fed in renders as ~1,420%. This documents why the
    // comparison-table change must be passed as a fraction, not pre-multiplied by 100.
    expect(formatPercent(14.2)).not.toBe("14.2%");
    expect(formatPercent(14.2)).toMatch(/1,?420%/);
  });

  it("a period-over-period change is a fraction (114.2 vs 100 → 0.142, renders 14.2%)", () => {
    const current = 114.2;
    const prev = 100;
    const change = (current - prev) / prev; // the corrected formula — no * 100
    expect(formatPercent(change)).toBe("14.2%");
  });
});

// ---------------------------------------------------------------------------------------
describe("GUARD 5 — filter parity: the shared row filter matches an independent recomputation (R5)", () => {
  it("canonicalRows includes exactly the rows with a populated numeric value AND a valid date (cafe)", () => {
    const { rows, mapping } = getFixtureA();
    // Independent application of the same inclusion rule, row by row.
    const expected = rows.filter(
      (r) => hasNumericValue(r[mapping.revenue]) && parseValidDate(r[mapping.date]) !== null,
    );
    const canonical = canonicalRows(rows, mapping);
    expect(canonical.length).toBe(expected.length);

    // And the headline total computed through the shared filter equals the independent sum.
    const canonicalTotal = canonical.reduce((s, r) => s + toNumber(r[mapping.revenue]), 0);
    const expectedTotal = expected.reduce((s, r) => s + toNumber(r[mapping.revenue]), 0);
    expect(canonicalTotal).toBeCloseTo(expectedTotal, 6);
    expect(canonical.length).toBeGreaterThan(0);
    expect(canonical.length).toBeLessThan(rows.length); // the dirty file really does drop rows
  });
});
