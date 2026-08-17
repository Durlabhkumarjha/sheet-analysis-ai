// Layer 5 — the pre-submission reconciliation gate. Deterministic, no LLM: code checking
// code. Before any report is shown, every number it renders must trace to a value in the
// Findings ledger (within rounding tolerance) and every risk/recommendation must reference a
// findings risk/recommendation key. A number that matches nothing, or a claim with no basis,
// is a violation and the gate FAILS CLOSED — in dev it blocks, in prod it replaces the
// offending number with the findings value rather than displaying an unreconciled figure.
//
// This is what would have caught the "10%" concentration card automatically: the card's number
// declares the key it came from, and the gate asserts it equals the canonical value for that key.

import type { Findings, FindingKey } from "./findings";

// A number actually shown on a surface, tagged with the findings key it claims to come from.
export type RenderedNumber = {
  surface: string; // e.g. "exec-summary", "concentration-card", "chart-caption"
  label: string; // human description, for the violation message
  value: number; // the number as rendered (a fraction for shares, raw for totals)
  key: string; // which registry/findings key it should equal
};

// A risk/recommendation actually shown, tagged with the finding key it claims as its basis.
export type RenderedClaim = {
  surface: string;
  kind: "risk" | "recommendation";
  key: FindingKey | string;
  text?: string;
};

export type ReconViolation = {
  rule: "number-unreconciled" | "number-mismatch" | "claim-unsupported";
  surface: string;
  detail: string;
};

export type ReconResult = {
  ok: boolean;
  violations: ReconViolation[];
  // In prod mode, the rendered numbers with any mismatched value replaced by the canonical
  // findings value — never show an unreconciled number.
  corrected: RenderedNumber[];
};

// The flat map of canonical numeric values the report is allowed to show. Built ONLY from the
// Findings ledger (plus any deterministically-derived extras the caller registers, e.g. a
// top-N share computed by computeShares). A rendered number that matches no key here cannot
// have come from the ledger.
export function findingsRegistry(findings: Findings): Record<string, number> {
  const reg: Record<string, number> = {
    total: findings.total,
    rowCount: findings.rowCount,
    "trend.magnitude": findings.trend.magnitude,
    "trend.p": findings.trend.p,
    "category.p": findings.category.p,
    "seasonality.month.p": findings.seasonality.month.p,
    "seasonality.dayOfWeek.p": findings.seasonality.dayOfWeek.p,
  };
  for (const p of findings.periodSeries) reg[`period:${p.label}`] = p.value;
  return reg;
}

function relClose(a: number, b: number, tol: number): boolean {
  const scale = Math.max(1, Math.abs(b));
  return Math.abs(a - b) <= tol * scale;
}

export function reconcileReport(
  rendered: { numbers: RenderedNumber[]; claims: RenderedClaim[] },
  findings: Findings,
  opts: { tolerance?: number; extraRegistry?: Record<string, number>; mode?: "dev" | "prod" } = {},
): ReconResult {
  const tol = opts.tolerance ?? 0.005; // 0.5% rounding tolerance
  const registry = { ...findingsRegistry(findings), ...(opts.extraRegistry ?? {}) };
  const violations: ReconViolation[] = [];
  const corrected: RenderedNumber[] = [];

  // (1) Number reconciliation — every rendered number must equal its canonical value.
  for (const n of rendered.numbers) {
    if (!(n.key in registry)) {
      violations.push({
        rule: "number-unreconciled",
        surface: n.surface,
        detail: `"${n.label}" (${n.value}) cites key "${n.key}" which is not in the findings ledger.`,
      });
      corrected.push(n); // nothing canonical to fall back to
      continue;
    }
    const canonical = registry[n.key];
    if (!relClose(n.value, canonical, tol)) {
      violations.push({
        rule: "number-mismatch",
        surface: n.surface,
        detail: `"${n.label}" rendered ${n.value} but findings "${n.key}" = ${canonical}.`,
      });
      // Fail closed: in prod, show the canonical value; never the unreconciled one.
      corrected.push({ ...n, value: canonical });
    } else {
      corrected.push(n);
    }
  }

  // (2) Claim reconciliation — every risk/recommendation must reference a findings entry.
  const riskKeys = new Set(findings.risks.map((r) => r.key));
  const recKeys = new Set(findings.recommendationBases.map((r) => r.key));
  for (const c of rendered.claims) {
    const supported = c.kind === "risk" ? riskKeys.has(c.key as FindingKey) : recKeys.has(c.key as FindingKey);
    if (!supported) {
      violations.push({
        rule: "claim-unsupported",
        surface: c.surface,
        detail: `${c.kind} "${c.text ?? c.key}" cites key "${c.key}", absent from findings.${c.kind === "risk" ? "risks" : "recommendationBases"}.`,
      });
    }
  }

  return { ok: violations.length === 0, violations, corrected };
}

// =============================================================================
// AUDIT GATE — TypeScript port of the deterministic reconciliation validator
// (C1, C3, C4, C5, C6, C9, C10–C14 + the C2 duplicate-definition REVIEW route).
//
// This is a faithful port of the Python spec under `reconciliation/validator.py`;
// the JSON conformance fixtures must produce identical verdicts AND identical
// firing check-ids in both. It is PURE and deterministic: no engine imports, no
// model calls, no recompute. Engine data is mapped onto these schema types by the
// thin adapter in `auditAdapter.ts` (which is the only place that touches verdicts
// or raw rows). Runs BEFORE the narrator LLM; a single FAIL -> BLOCK halts it.
// =============================================================================

const AUDIT_CURRENCY_UNITS = new Set(["USD", "EUR", "GBP", "JPY", "INR", "currency"]);
const COVERAGE_MIN = 0.9; // below this a period is "incomplete"
const PCT_TOL = 0.01; // 1% relative tolerance for percentage / sum reproduction
const SUM_TOL = 0.01; // 1% relative tolerance for breakdown sums
const SALES_NAME_HINTS = ["sales", "_sales", "units", "qty", "quantity", "shipped", "volume"];
const XFOOT_TOL = 0.01; // 1% relative tolerance for cross-foot reconciliation
const INTERP_DEMAND_HINTS = ["units", "quantity", "demand", "sales"];

// Semantic findings (claim-binding layer) are assertions about identity/direction, not numbers.
// The numeric checks (C1-C14) key off the numeric kinds and must ignore these.
const SEMANTIC_KINDS = new Set<AuditKind>(["leader", "trend", "loss_making", "risk", "interpretation_basis"]);

export type AuditKind =
  | "scalar"
  | "percent"
  | "index"
  | "breakdown_by"
  | "anomaly"
  | "timeseries"
  | "leader"
  | "trend"
  | "loss_making"
  | "risk"
  | "interpretation_basis";
export type AuditVerdict = "PASS" | "BLOCK" | "REVIEW";

// One finding in the ledger. Optional fields are `== null` when absent — which the checks
// treat as FAIL where the field is required (never assume a missing value). `0`/`false` are
// legitimate values and are preserved (e.g. `comparedTo: 0`, `dimensionAdditive: false`).
export type LedgerFinding = {
  id: string;
  measureName: string;
  kind: AuditKind;
  value: number | string | null;
  unit?: string | null;
  formula?: string | null;
  sourceColumn?: string | null;
  rendersCurrencySymbol?: boolean;
  significanceFlag?: boolean | null;
  // percent
  partId?: string | null;
  denominatorId?: string | null;
  percentGroup?: string | null;
  // index
  scale?: string | null;
  comparedTo?: number | null;
  comparedToScale?: string | null;
  // breakdown_by
  groupCount?: number | null;
  groupSum?: number | null;
  // anomaly / timeseries
  periodId?: string | null;
  basePeriodId?: string | null;
  claimedGrain?: string | null;
  nPeriods?: number | null;
  // domain-completeness (C10–C14)
  additivity?: "extensive" | "intensive" | null;
  aggregation?: "sum" | "mean" | "recomputed" | "none" | null;
  numeratorId?: string | null;
  polarity?: "higher_better" | "lower_better" | "neutral" | null;
  superlative?: "praises_max" | "praises_min" | null;
  method?: string | null; // "share" | "pareto" | "abc" | "hhi" -> sign-sensitive
  combinedUnits?: string[] | null;
  dimensionAdditive?: boolean | null;
  // claim-binding (semantic findings: leader | trend | loss_making | risk | interpretation_basis)
  metric?: string | null; // leader: the measure it leads on, e.g. "revenue"
  entity?: string | null; // leader: the entity that actually leads, e.g. "Phones"
  direction?: "up" | "down" | "flat" | null; // trend: the engine's direction
  members?: string[] | null; // loss_making: the set of items the engine flags as loss-making
  seasonalExplained?: boolean | null; // trend: is the period change the known seasonal pattern?
};

export type AuditColumnProfile = {
  name: string;
  inferredRole: string; // "measure" | "dimension" | "date" | ...
  declaredUnit?: string | null;
  dtype: string; // "float" | "int" | "str" | "date"
  distinctCount?: number;
  colMin?: number | null;
  colMax?: number | null;
  colSum?: number | null;
  dateGrain?: string | null;
  hasPriceEvidence?: boolean;
};

export type AuditPeriod = { pid: string; coverage: number };

// A claim the narrator asserts. A *numeric* claim (claimType == null) carries ledgerId +
// renderedValue and is bound by C1. A *semantic* claim carries claimType + cites (+ subject/
// predicate) and is bound by the BIND-* checks. The two never overlap on one claim.
export type AuditClaim = {
  text: string;
  // numeric provenance (C1)
  ledgerId?: string | null;
  renderedValue?: number | string | null;
  // semantic binding (BIND-*)
  claimType?: "leader" | "trend_direction" | "loss_making" | "risk_alert" | "interpretation" | null;
  subject?: string | null; // metric ("revenue") or entity ("Tables") the claim is about
  predicate?: string | null; // leader: entity claimed to lead; trend: "up"|"down"|"flat"|"concern"; interp: "price_driven"|"demand_driven"
  cites?: string | null; // the finding id this claim is grounded in
};

// One cross-foot group: the same headline total computed along >=2 independent aggregation paths.
export type CrossFootGroup = { label: string; paths: Record<string, number> };

export type AuditViolation = {
  check: string;
  status: "FAIL" | "REVIEW";
  findingId: string | null;
  message: string;
  upstreamFix: string;
};

// --- helpers (ported verbatim from the spec's `_close` / `_is_currency` / units heuristic) ---

// Relative tolerance, NOT absolute: |a-b|/|b| <= tol, with b==0 -> |a| <= tol. A null/undefined
// operand is never "close" (missing -> FAIL). Mirrors the Python `_close`.
function auditClose(a: number | null | undefined, b: number | null | undefined, tol: number): boolean {
  if (a == null || b == null) return false;
  if (b === 0) return Math.abs(a) <= tol;
  return Math.abs(a - b) / Math.abs(b) <= tol;
}

function isCurrencyUnit(unit: string | null | undefined): boolean {
  return unit != null && AUDIT_CURRENCY_UNITS.has(unit);
}

// Small-magnitude float column whose name implies counts/sales, with no price column alongside.
function looksLikeUnitsColumn(p: AuditColumnProfile): boolean {
  const name = p.name.toLowerCase();
  const nameHint = SALES_NAME_HINTS.some((h) => name.includes(h));
  const small = p.colMax != null && p.colMax < 1000;
  const floaty = p.dtype === "float";
  return nameHint && small && floaty && !p.hasPriceEvidence;
}

// --- checks ---

// C1 — every rendered number cites a real ledger id and equals it; ids are unique.
export function checkC1Provenance(ledger: LedgerFinding[], claims: AuditClaim[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const counts = new Map<string, number>();
  for (const f of ledger) counts.set(f.id, (counts.get(f.id) ?? 0) + 1);
  for (const id of [...counts.keys()].filter((i) => (counts.get(i) ?? 0) > 1).sort()) {
    v.push({ check: "C1", status: "FAIL", findingId: id, message: `ledger id '${id}' is not unique`, upstreamFix: "assign one id per finding" });
  }
  const byId = new Map(ledger.map((f) => [f.id, f]));
  for (const c of claims) {
    // Semantic (evaluative) claims carry a claimType and are bound by checkBindClaims, not here.
    if (c.claimType != null) continue;
    const ledgerId = c.ledgerId ?? null;
    const truthF = ledgerId != null ? byId.get(ledgerId) : undefined;
    if (!truthF) {
      v.push({ check: "C1", status: "FAIL", findingId: ledgerId, message: `claim cites missing ledger id '${ledgerId}': ${JSON.stringify(c.text)}`, upstreamFix: "every rendered number must trace to a ledger finding" });
      continue;
    }
    const truth = truthF.value;
    if (typeof truth === "number" && typeof c.renderedValue === "number") {
      if (!auditClose(c.renderedValue, truth, PCT_TOL)) {
        v.push({ check: "C1", status: "FAIL", findingId: ledgerId, message: `rendered ${c.renderedValue} != ledger ${truth} for ${JSON.stringify(c.text)}`, upstreamFix: "render the ledger value verbatim" });
      }
    } else if (c.renderedValue !== truth) {
      v.push({ check: "C1", status: "FAIL", findingId: ledgerId, message: `rendered ${JSON.stringify(c.renderedValue)} != ledger ${JSON.stringify(truth)}`, upstreamFix: "render the ledger value verbatim" });
    }
  }
  return v;
}

// C3 — every measure has a unit; a currency symbol only on currency; units never mislabelled $.
export function checkC3UnitTyping(ledger: LedgerFinding[], profile: AuditColumnProfile[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const prof = new Map(profile.map((p) => [p.name, p]));
  for (const f of ledger) {
    if ((f.kind === "scalar" || f.kind === "breakdown_by" || f.kind === "timeseries") && f.unit == null) {
      v.push({ check: "C3", status: "FAIL", findingId: f.id, message: `finding '${f.id}' has no unit`, upstreamFix: "type every measure with a unit" });
    }
    if (f.rendersCurrencySymbol && !isCurrencyUnit(f.unit)) {
      v.push({ check: "C3", status: "FAIL", findingId: f.id, message: `finding '${f.id}' renders '$' but unit is ${JSON.stringify(f.unit ?? null)}`, upstreamFix: "drop the currency symbol or correct the unit" });
    }
    if (f.sourceColumn && prof.has(f.sourceColumn)) {
      const p = prof.get(f.sourceColumn)!;
      if (isCurrencyUnit(f.unit) && looksLikeUnitsColumn(p)) {
        v.push({ check: "C3", status: "FAIL", findingId: f.id, message: `column '${p.name}' (max ${p.colMax}, no price column) is units, but finding '${f.id}' declares currency ${JSON.stringify(f.unit)}`, upstreamFix: "type this column as 'units'; remove $ from all derived findings" });
      }
    }
  }
  return v;
}

// C4 — each % = part/denominator*100, in [0,100]; sibling parts of one whole sum <= 100.
export function checkC4Percent(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const byId = new Map(ledger.map((f) => [f.id, f]));
  const groups = new Map<string, LedgerFinding[]>();
  for (const f of ledger) {
    if (f.kind !== "percent") continue;
    if (f.partId == null || f.denominatorId == null) {
      v.push({ check: "C4", status: "FAIL", findingId: f.id, message: `percent '${f.id}' missing part_id/denominator_id`, upstreamFix: "every % must name its numerator and denominator" });
      continue;
    }
    if (!byId.has(f.partId) || !byId.has(f.denominatorId)) {
      v.push({ check: "C4", status: "FAIL", findingId: f.id, message: `percent '${f.id}' references missing part/denominator finding`, upstreamFix: "point part_id/denominator_id at real findings" });
      continue;
    }
    const part = byId.get(f.partId)!.value;
    const denom = byId.get(f.denominatorId)!.value;
    const partNum = typeof part === "number" ? part : null;
    const denomNum = typeof denom === "number" ? denom : null;
    const expected = partNum != null && denomNum != null && denomNum !== 0 ? (partNum / denomNum) * 100 : null;
    const val = typeof f.value === "number" ? f.value : null;
    if (expected == null || !auditClose(val, expected, PCT_TOL)) {
      v.push({
        check: "C4", status: "FAIL", findingId: f.id,
        message: expected != null
          ? `percent '${f.id}' = ${f.value}; part/denom*100 = ${expected.toFixed(4)} (part=${part}, denom=${denom})`
          : `percent '${f.id}' has zero denominator`,
        upstreamFix: "recompute as part/denominator*100",
      });
    }
    if (!(val != null && val >= 0 && val <= 100)) {
      v.push({ check: "C4", status: "FAIL", findingId: f.id, message: `percent '${f.id}' = ${f.value} outside [0,100]`, upstreamFix: "a share cannot exceed 100% or be negative" });
    }
    if (f.percentGroup) {
      const arr = groups.get(f.percentGroup) ?? [];
      arr.push(f);
      groups.set(f.percentGroup, arr);
    }
  }
  for (const [gid, members] of groups) {
    const total = members.reduce((s, m) => s + (typeof m.value === "number" ? m.value : 0), 0);
    if (total > 100 + PCT_TOL * 100) {
      v.push({ check: "C4", status: "FAIL", findingId: members[0].id, message: `percent group '${gid}' sums to ${total.toFixed(2)}% (> 100%)`, upstreamFix: "parts of one whole cannot exceed 100%" });
    }
  }
  return v;
}

// C5 — indices declare a scale; a threshold is compared on the same scale.
export function checkC5IndexScale(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  for (const f of ledger) {
    if (f.kind !== "index") continue;
    if (f.scale == null) {
      v.push({ check: "C5", status: "FAIL", findingId: f.id, message: `index '${f.id}' has no declared scale`, upstreamFix: "declare the index scale (e.g. 0-1 or 0-10000)" });
    }
    if (f.comparedTo != null && f.comparedToScale !== f.scale) {
      v.push({ check: "C5", status: "FAIL", findingId: f.id, message: `index '${f.id}' on scale ${JSON.stringify(f.scale ?? null)} compared to threshold ${f.comparedTo} on scale ${JSON.stringify(f.comparedToScale ?? null)}`, upstreamFix: "put index and threshold on the same scale before comparing" });
    }
  }
  return v;
}

// C6 — anomalies must not reference incomplete (edge) periods; coverage rule is symmetric.
export function checkC6EdgeSymmetry(ledger: LedgerFinding[], periods: AuditPeriod[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const pmap = new Map(periods.map((p) => [p.pid, p]));
  for (const f of ledger) {
    if (f.kind !== "anomaly") continue;
    for (const pid of [f.periodId, f.basePeriodId]) {
      if (pid == null) continue;
      const p = pmap.get(pid);
      if (p == null) {
        v.push({ check: "C6", status: "FAIL", findingId: f.id, message: `anomaly '${f.id}' references unknown period '${pid}'`, upstreamFix: "register every period with its coverage" });
      } else if (p.coverage < COVERAGE_MIN) {
        v.push({ check: "C6", status: "FAIL", findingId: f.id, message: `anomaly '${f.id}' uses period '${pid}' at ${Math.round(p.coverage * 100)}% coverage (incomplete)`, upstreamFix: "exclude incomplete edge periods from anomaly detection" });
      }
    }
  }
  return v;
}

// C9 — a 'by X' breakdown's group count and sum match the source column's reality.
export function checkC9Cardinality(ledger: LedgerFinding[], profile: AuditColumnProfile[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const prof = new Map(profile.map((p) => [p.name, p]));
  for (const f of ledger) {
    if (f.kind !== "breakdown_by") continue;
    if (f.sourceColumn == null || !prof.has(f.sourceColumn)) {
      v.push({ check: "C9", status: "FAIL", findingId: f.id, message: `breakdown '${f.id}' has no source column profile`, upstreamFix: "attach the source column profile" });
      continue;
    }
    const p = prof.get(f.sourceColumn)!;
    if (f.groupCount == null || f.groupSum == null) {
      v.push({ check: "C9", status: "FAIL", findingId: f.id, message: `breakdown '${f.id}' missing group_count/group_sum`, upstreamFix: "emit group_count and group_sum for every breakdown" });
      continue;
    }
    const distinct = p.distinctCount ?? 0;
    if (f.groupCount !== distinct) {
      v.push({ check: "C9", status: "FAIL", findingId: f.id, message: `breakdown '${f.id}' groups ${f.groupCount} but column '${p.name}' has ${distinct} distinct values`, upstreamFix: "aggregate the full column, not a truncated slice" });
    }
    if (p.colSum != null && !auditClose(f.groupSum, p.colSum, SUM_TOL)) {
      v.push({ check: "C9", status: "FAIL", findingId: f.id, message: `breakdown '${f.id}' sums ${f.groupSum} but column '${p.name}' totals ${p.colSum}`, upstreamFix: "the breakdown must reconstruct the column total" });
    }
  }
  return v;
}

// C10 — intensive measures (rates/ratios) may never be summed/mean-averaged; recompute instead.
export function checkC10Additivity(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const measureKinds = new Set<AuditKind>(["scalar", "breakdown_by", "timeseries"]);
  for (const f of ledger) {
    if (!measureKinds.has(f.kind)) continue;
    if (f.additivity == null) {
      v.push({ check: "C10", status: "FAIL", findingId: f.id, message: `measure '${f.id}' does not declare additivity`, upstreamFix: "tag every measure extensive (summable) or intensive (rate/ratio)" });
      continue;
    }
    if (f.additivity === "intensive") {
      if (f.aggregation === "sum" || f.aggregation === "mean") {
        v.push({ check: "C10", status: "FAIL", findingId: f.id, message: `intensive measure '${f.id}' was aggregated by ${JSON.stringify(f.aggregation)} (average-of-ratios / summed rate)`, upstreamFix: "recompute from numerator/denominator totals, never sum or mean a rate" });
      } else if (f.aggregation === "recomputed") {
        if (f.numeratorId == null || f.denominatorId == null) {
          v.push({ check: "C10", status: "FAIL", findingId: f.id, message: `intensive measure '${f.id}' claims 'recomputed' but lacks numerator_id/denominator_id`, upstreamFix: "point a recomputed rate at its extensive numerator and denominator" });
        }
      }
    }
  }
  return v;
}

// C11 — superlative framing must agree with the measure's good/bad direction (polarity).
export function checkC11Polarity(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  for (const f of ledger) {
    if (f.superlative == null) continue;
    if (f.polarity == null) {
      v.push({ check: "C11", status: "FAIL", findingId: f.id, message: `finding '${f.id}' uses superlative framing but declares no polarity`, upstreamFix: "declare higher_better / lower_better / neutral before praising an extreme" });
      continue;
    }
    if (f.superlative === "praises_max" && f.polarity !== "higher_better") {
      v.push({ check: "C11", status: "FAIL", findingId: f.id, message: `finding '${f.id}' praises the MAX of a ${JSON.stringify(f.polarity)} measure ('leads/best/dominates' on something where lower is better)`, upstreamFix: "reframe the highest value as 'most/highest' and as attention, not achievement" });
    }
    if (f.superlative === "praises_min" && f.polarity !== "lower_better") {
      v.push({ check: "C11", status: "FAIL", findingId: f.id, message: `finding '${f.id}' praises the MIN of a ${JSON.stringify(f.polarity)} measure`, upstreamFix: "the lowest value is only 'best' when lower is better; reframe" });
    }
  }
  return v;
}

// C12 — share/Pareto/ABC/HHI are unsafe on mixed-sign columns (refunds, credits, neg margins).
export function checkC12SignHygiene(ledger: LedgerFinding[], profile: AuditColumnProfile[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const prof = new Map(profile.map((p) => [p.name, p]));
  const signMethods = new Set(["share", "pareto", "abc", "hhi"]);
  for (const f of ledger) {
    const triggers = f.kind === "percent" || f.kind === "index" || (f.method != null && signMethods.has(f.method));
    if (!triggers) continue;
    const col = f.sourceColumn;
    if (col && prof.has(col)) {
      const p = prof.get(col)!;
      if (p.colMin != null && p.colMax != null && p.colMin < 0 && p.colMax > 0) {
        v.push({ check: "C12", status: "FAIL", findingId: f.id, message: `finding '${f.id}' (${f.method ?? f.kind}) runs over column '${col}' with mixed signs (min ${p.colMin}, max ${p.colMax})`, upstreamFix: "split positive/negative pools or block shares; signed parts break share/Pareto/HHI" });
      }
    }
  }
  return v;
}

// C13 — an aggregate may combine only one unit/currency; mixed -> must normalize first.
export function checkC13UnitHomogeneity(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  for (const f of ledger) {
    if (f.combinedUnits && new Set(f.combinedUnits).size > 1) {
      const uniq = [...new Set(f.combinedUnits)].sort();
      v.push({ check: "C13", status: "FAIL", findingId: f.id, message: `aggregate '${f.id}' sums across multiple units/currencies ${JSON.stringify(uniq)} without normalization`, upstreamFix: "convert to one unit/currency (e.g. FX) before aggregating" });
    }
  }
  return v;
}

// C14 — hierarchical dimensions / multi-touch attribution must not be summed (double counting).
export function checkC14NonDuplication(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  for (const f of ledger) {
    if (f.kind !== "breakdown_by") continue;
    if (f.dimensionAdditive === false && f.aggregation === "sum") {
      v.push({ check: "C14", status: "FAIL", findingId: f.id, message: `breakdown '${f.id}' sums a non-additive dimension (hierarchy or multi-touch attribution) -> double counting`, upstreamFix: "aggregate at one level only, or de-duplicate before summing" });
    }
  }
  return v;
}

// C2 (detect) — mechanical to detect, judgment to resolve -> REVIEW, routed to the AI auditor.
export function detectDuplicateDefinitions(ledger: LedgerFinding[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  const byName = new Map<string, LedgerFinding[]>();
  for (const f of ledger) {
    if (SEMANTIC_KINDS.has(f.kind)) continue; // semantic findings have no formula/value to duplicate
    const arr = byName.get(f.measureName) ?? [];
    arr.push(f);
    byName.set(f.measureName, arr);
  }
  for (const [name, members] of byName) {
    const formulas = new Set(members.map((m) => m.formula).filter((x): x is string => x != null));
    const values = new Set(
      members.filter((m) => typeof m.value === "number").map((m) => Math.round((m.value as number) * 1e6) / 1e6),
    );
    if (formulas.size > 1 || values.size > 1) {
      const ids = members.map((m) => m.id).join(", ");
      const formulaList = [...formulas].sort();
      v.push({
        check: "C2", status: "REVIEW", findingId: null,
        message: `measure '${name}' has multiple definitions/values across [${ids}] (formulas=${JSON.stringify(formulaList)})`,
        upstreamFix: "AI auditor: confirm these are genuinely distinct measures (e.g. gross vs net) and rename; otherwise collapse to one definition",
      });
    }
  }
  return v;
}

// --- claim binding (BIND-*) ---
// The numeric gate guards NUMBERS; these guard CLAIMS — assertions about identity, ranking,
// direction, risk, and interpretation that carry no number for C1 to check. The contract mirrors
// C1's ledger discipline: every evaluative claim must CITE a finding, and we verify the citation
// deterministically. A contradicting/unbound claim BLOCKS (it is never rewritten); the message
// names the correct value so the upstream fix is obvious.
export function checkBindClaims(
  ledger: LedgerFinding[],
  claims: AuditClaim[],
  columns: AuditColumnProfile[],
): AuditViolation[] {
  const v: AuditViolation[] = [];
  const byId = new Map(ledger.map((f) => [f.id, f]));
  const colNames = columns.map((p) => p.name.toLowerCase());

  for (const c of claims) {
    const ct = c.claimType;
    if (ct == null) continue; // numeric provenance claim -> handled by C1

    // BIND-0: every evaluative claim must cite a backing finding that exists.
    if (c.cites == null) {
      v.push({ check: "BIND-0", status: "FAIL", findingId: null, message: `${ct} claim ${JSON.stringify(c.text)} cites no finding`, upstreamFix: "the narrator may not assert without a backing finding" });
      continue;
    }
    const f = byId.get(c.cites);
    if (!f) {
      v.push({ check: "BIND-0", status: "FAIL", findingId: c.cites, message: `${ct} claim ${JSON.stringify(c.text)} cites missing finding '${c.cites}'`, upstreamFix: "cite a finding that exists in the ledger" });
      continue;
    }

    // BIND-LEADER: the claimed entity must equal the leader finding's entity.
    if (ct === "leader") {
      if (f.kind !== "leader" || (c.subject && f.metric !== c.subject)) {
        v.push({ check: "BIND-LEADER", status: "FAIL", findingId: f.id, message: `leader claim ${JSON.stringify(c.text)} cites a non-leader / wrong-metric finding '${f.id}'`, upstreamFix: "cite the leader finding for this metric" });
      } else if (c.predicate !== f.entity) {
        v.push({ check: "BIND-LEADER", status: "FAIL", findingId: f.id, message: `claims '${c.predicate}' leads ${c.subject}, but finding says '${f.entity}'`, upstreamFix: `name the actual leader '${f.entity}' or drop the claim` });
      }
    }

    // BIND-TREND / BIND-SEASONAL: direction must match; a seasonal trough is not a 'concern'.
    else if (ct === "trend_direction") {
      const pred = c.predicate;
      if (pred === "up" || pred === "down" || pred === "flat") {
        if (f.kind !== "trend" || pred !== f.direction) {
          v.push({ check: "BIND-TREND", status: "FAIL", findingId: f.id, message: `claims trend '${pred}' but finding direction is '${f.direction}'`, upstreamFix: `state the actual direction '${f.direction}' or drop the claim` });
        }
      } else if (pred === "concern") {
        if (f.seasonalExplained === true) {
          v.push({ check: "BIND-SEASONAL", status: "FAIL", findingId: f.id, message: `narrates a seasonal trough/peak as a concern to investigate (${JSON.stringify(c.text)})`, upstreamFix: "do not alarm on a change the engine explains as the seasonal pattern" });
        }
      }
    }

    // BIND-LOSS: the entity must be in the engine's loss-making set.
    else if (ct === "loss_making") {
      const members = f.members ?? [];
      if (f.kind !== "loss_making" || c.subject == null || !members.includes(c.subject)) {
        v.push({ check: "BIND-LOSS", status: "FAIL", findingId: f.id, message: `claims '${c.subject}' is loss-making; not in loss set ${JSON.stringify(members)}`, upstreamFix: "only items the engine flags as loss-making may be called so" });
      }
    }

    // BIND-RISK: only raise risks the engine flagged as significant.
    else if (ct === "risk_alert") {
      if (f.kind !== "risk" || f.significanceFlag !== true) {
        v.push({ check: "BIND-RISK", status: "FAIL", findingId: f.id, message: `raises a risk not flagged significant by the engine (finding '${f.id}')`, upstreamFix: "do not raise risks below the significance threshold" });
      }
    }

    // BIND-INTERP: price/demand talk requires the column to actually exist.
    else if (ct === "interpretation") {
      const pred = c.predicate;
      if (pred === "price_driven" && !colNames.some((n) => n.includes("price"))) {
        v.push({ check: "BIND-INTERP", status: "FAIL", findingId: f.id, message: "asserts a PRICE interpretation, but the data has no price column", upstreamFix: "no price column exists; cannot claim price-driven" });
      }
      if (pred === "demand_driven" && !colNames.some((n) => INTERP_DEMAND_HINTS.some((k) => n.includes(k)))) {
        v.push({ check: "BIND-INTERP", status: "FAIL", findingId: f.id, message: "asserts a DEMAND interpretation with no units/quantity column", upstreamFix: "no volume column exists; cannot claim demand-driven" });
      }
    }
  }
  return v;
}

// --- cross-foot (XFOOT) — the engine vs ITSELF ---
// The same headline total must reconcile across independent aggregation paths. If KPIs sum 40k
// rows and the trend sums 99k rows, the reconstructed total won't match — caught with no AI.
export function checkXfoot(groups: CrossFootGroup[]): AuditViolation[] {
  const v: AuditViolation[] = [];
  for (const g of groups) {
    const entries = Object.entries(g.paths ?? {});
    if (entries.length < 2) {
      v.push({ check: "XFOOT", status: "FAIL", findingId: null, message: `cross-foot '${g.label}' needs >=2 independent paths, got ${JSON.stringify(Object.keys(g.paths ?? {}))}`, upstreamFix: "compute the total along at least two aggregation paths" });
      continue;
    }
    const [refName, refVal] = entries[0];
    for (const [name, val] of entries.slice(1)) {
      if (!auditClose(val, refVal, XFOOT_TOL)) {
        v.push({ check: "XFOOT", status: "FAIL", findingId: null, message: `'${g.label}' disagrees across paths: ${refName}=${refVal.toFixed(2)} vs ${name}=${val.toFixed(2)} (different row base / filter)`, upstreamFix: "unify the row base; every aggregation must sum the same rows" });
      }
    }
  }
  return v;
}

// --- runner ---

// A single FAIL -> BLOCK. No FAILs but >=1 REVIEW -> REVIEW. Otherwise PASS.
export function runAudit(
  ledger: LedgerFinding[],
  columns: AuditColumnProfile[],
  claims: AuditClaim[],
  periods: AuditPeriod[] = [],
  crossFoot: CrossFootGroup[] = [],
): { verdict: AuditVerdict; violations: AuditViolation[] } {
  const violations: AuditViolation[] = [
    ...checkC1Provenance(ledger, claims),
    ...checkC3UnitTyping(ledger, columns),
    ...checkC4Percent(ledger),
    ...checkC5IndexScale(ledger),
    ...checkC6EdgeSymmetry(ledger, periods),
    ...checkC9Cardinality(ledger, columns),
    ...checkC10Additivity(ledger),
    ...checkC11Polarity(ledger),
    ...checkC12SignHygiene(ledger, columns),
    ...checkC13UnitHomogeneity(ledger),
    ...checkC14NonDuplication(ledger),
    ...detectDuplicateDefinitions(ledger),
    ...checkBindClaims(ledger, claims, columns),
    ...checkXfoot(crossFoot),
  ];

  let verdict: AuditVerdict;
  if (violations.some((x) => x.status === "FAIL")) verdict = "BLOCK";
  else if (violations.some((x) => x.status === "REVIEW")) verdict = "REVIEW";
  else verdict = "PASS";
  return { verdict, violations };
}

export function formatAuditReport(verdict: AuditVerdict, violations: AuditViolation[]): string {
  const lines = [`VERDICT: ${verdict}`, "=".repeat(60)];
  if (violations.length === 0) lines.push("All mechanical checks passed.");
  for (const x of violations) {
    lines.push(`[${x.status}] ${x.check}  finding=${x.findingId}`);
    lines.push(`    why: ${x.message}`);
    lines.push(`    fix: ${x.upstreamFix}`);
  }
  return lines.join("\n");
}
