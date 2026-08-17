// The ONLY glue between the engine and the pure audit gate. It assembles the column
// profiles and period coverages the validator (`reconcile.ts` runAudit) needs from the
// app's existing signals — it does NOT recompute statistics or re-derive verdicts. Raw
// stats (min/max/sum/distinct) have no single home in the engine, so they are gathered in
// one cheap pass over `canonicalRows`; everything semantic is read from existing signals:
//   • has_price_evidence  <- the positive `looksLikePerUnitPrice` scaling signal (dataQuality.ts)
//   • period coverage      <- `findings.periodCompleteness.coverageByPeriod` (verdicts.ts)
//
// The ledger of LedgerFindings is built separately (Phase 2 — the engine tags each finding
// with additivity/polarity/significance at emission); this adapter only produces the PROFILE.

import { canonicalRows, hasNumericValue, isInvalidCategory, toNumber } from "../metrics";
import { looksLikePerUnitPrice } from "../dataQuality";
import type { Findings, FindingsMapping } from "./findings";
import type { AuditColumnProfile, AuditPeriod } from "./reconcile";

function gatherNumeric(rows: Record<string, string>[], col: string): {
  min: number | null;
  max: number | null;
  sum: number;
  distinct: number;
} {
  let min: number | null = null;
  let max: number | null = null;
  let sum = 0;
  const seen = new Set<number>();
  for (const r of rows) {
    if (!hasNumericValue(r[col])) continue;
    const x = toNumber(r[col]);
    sum += x;
    if (min == null || x < min) min = x;
    if (max == null || x > max) max = x;
    seen.add(x);
  }
  return { min, max, sum, distinct: seen.size };
}

// For a dimension column: its cardinality (junk/missing excluded, matching the rest of the
// pipeline) and the measure total grouped across it — the figure a `breakdown_by` over this
// column must reconstruct (C9 col_sum) at the count it must match (C9 distinct_count).
function gatherCategory(rows: Record<string, string>[], col: string, measureCol: string): {
  distinct: number;
  sum: number;
} {
  const cats = new Set<string>();
  let sum = 0;
  for (const r of rows) {
    const label = String(r[col] ?? "").trim();
    if (!label || isInvalidCategory(label)) continue;
    cats.add(label);
    if (measureCol && hasNumericValue(r[measureCol])) sum += toNumber(r[measureCol]);
  }
  return { distinct: cats.size, sum };
}

export function buildAuditProfile(
  rows: Record<string, string>[],
  mapping: FindingsMapping,
  findings: Findings,
  opts: { currency?: string } = {},
): { columns: AuditColumnProfile[]; periods: AuditPeriod[] } {
  const clean = canonicalRows(rows, mapping as Record<string, string | undefined>);
  const currency = opts.currency ?? "USD";
  const qtyCol = mapping.quantity ?? "";
  const columns: AuditColumnProfile[] = [];

  // Measure columns. dtype is "float" so the C3 units-mislabel heuristic can fire on a
  // small-magnitude count column wrongly typed as currency.
  const measures: { col: string; unit: string }[] = [];
  if (mapping.revenue) measures.push({ col: mapping.revenue, unit: currency });
  if (mapping.cost) measures.push({ col: mapping.cost, unit: currency });
  if (mapping.quantity) measures.push({ col: mapping.quantity, unit: "units" });

  for (const { col, unit } of measures) {
    const s = gatherNumeric(clean, col);
    // has_price_evidence fails toward "no evidence": only the POSITIVE scales-with-quantity
    // signal counts (a genuine line total = price x qty correlates with quantity), and only on
    // a sufficient sample (>=20 pairs). Large magnitude alone is NOT sufficient — a big units
    // count would clear it falsely — and a thin sample or a flat per-unit-price reading leaves
    // evidence absent. Withholding evidence lets C3 raise a reviewed BLOCK rather than silently
    // passing a units-as-dollars report. A units column never has it.
    let hasPriceEvidence = false;
    if (unit !== "units" && qtyCol && col !== qtyCol) {
      const puc = looksLikePerUnitPrice(rows, col, qtyCol);
      hasPriceEvidence = puc.sampleSize >= 20 && !puc.likely;
    }
    columns.push({
      name: col,
      inferredRole: "measure",
      declaredUnit: unit,
      dtype: "float",
      distinctCount: s.distinct,
      colMin: s.min,
      colMax: s.max,
      colSum: s.sum,
      dateGrain: null,
      hasPriceEvidence,
    });
  }

  // Dimension column (the mapped product/category). col_sum is the measure total grouped by
  // it; distinct_count is its cardinality — what a breakdown over it must match.
  const measureCol = mapping.revenue ?? mapping.quantity ?? mapping.cost ?? "";
  if (mapping.product) {
    const d = gatherCategory(clean, mapping.product, measureCol);
    columns.push({
      name: mapping.product,
      inferredRole: "dimension",
      declaredUnit: null,
      dtype: "str",
      distinctCount: d.distinct,
      colMin: null,
      colMax: null,
      colSum: d.sum,
      dateGrain: null,
      hasPriceEvidence: false,
    });
  }

  // Periods. Read each period's real coverage from the completeness evidence rather than
  // assuming interiors are always complete: prefer the per-period `coverageByPeriod` map, fall
  // back to the endpoint evidence, and only default to 1.0 when the engine offers nothing for
  // that period. This keeps C6 (anomaly edge-symmetry) honest if a sparse interior month ever
  // appears, instead of hard-coding today's first/last-only limitation as fact.
  const pc = findings.periodCompleteness;
  const series = findings.periodSeries;
  const periods: AuditPeriod[] = series.map((p, i) => {
    const byPeriod = pc.coverageByPeriod?.[p.label];
    let coverage: number;
    if (byPeriod != null) coverage = byPeriod;
    else if (i === 0 && pc.partialFirst) coverage = pc.firstEvidence?.coverage ?? 1.0;
    else if (i === series.length - 1 && pc.partialLast) coverage = pc.lastEvidence?.coverage ?? 1.0;
    else coverage = 1.0;
    return { pid: p.label, coverage };
  });

  return { columns, periods };
}
