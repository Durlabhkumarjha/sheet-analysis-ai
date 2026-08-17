# =============================================================================
# AUDIT GATE — reference Python implementation of the deterministic reconciliation
# validator (C1, C3, C4, C5, C6, C9, C10-C14 + the C2 duplicate-definition REVIEW
# route) PLUS the claim-binding layer (BIND-0/LEADER/TREND/SEASONAL/LOSS/RISK/INTERP)
# and cross-foot (XFOOT). C1-C14 guard NUMBERS; BIND-* guard semantic CLAIMS (identity,
# direction, risk, interpretation); XFOOT reconciles a total across independent paths.
# The TypeScript port lives in `src/analysis/reconcile.ts` (runAudit); the JSON
# conformance fixtures under `fixtures/` must produce IDENTICAL verdicts AND identical
# firing check-ids in both runtimes.
#
# Pure and deterministic: no I/O, no model calls, no recompute of statistics. The
# inputs are plain dicts using the SAME camelCase keys as the TypeScript schema
# types (LedgerFinding / AuditColumnProfile / AuditClaim / AuditPeriod), so a single
# shared JSON fixture feeds both runtimes unchanged.
# =============================================================================

from __future__ import annotations

import math
from typing import Any

AUDIT_CURRENCY_UNITS = {"USD", "EUR", "GBP", "JPY", "INR", "currency"}
COVERAGE_MIN = 0.9        # below this a period is "incomplete"
PCT_TOL = 0.01            # 1% relative tolerance for percentage / sum reproduction
SUM_TOL = 0.01            # 1% relative tolerance for breakdown sums
SALES_NAME_HINTS = ["sales", "_sales", "units", "qty", "quantity", "shipped", "volume"]

MEASURE_KINDS = {"scalar", "breakdown_by", "timeseries"}
SIGN_METHODS = {"share", "pareto", "abc", "hhi"}

# Semantic findings (claim-binding layer) are assertions about identity/direction, not numbers.
# The numeric checks (C1-C14) key off the numeric kinds and must ignore these.
SEMANTIC_KINDS = {"leader", "trend", "loss_making", "risk", "interpretation_basis"}
XFOOT_TOL = 0.01          # 1% relative tolerance for cross-foot reconciliation
INTERP_DEMAND_HINTS = ("units", "quantity", "demand", "sales")


def _is_number(x: Any) -> bool:
    # Booleans are a subclass of int in Python but are never legitimate ledger values.
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def audit_close(a: Any, b: Any, tol: float) -> bool:
    """Relative tolerance, NOT absolute: |a-b|/|b| <= tol, with b==0 -> |a| <= tol.
    A None operand is never 'close' (missing -> FAIL). Mirrors the TS `auditClose`."""
    if a is None or b is None:
        return False
    if b == 0:
        return abs(a) <= tol
    return abs(a - b) / abs(b) <= tol


def is_currency_unit(unit: Any) -> bool:
    return unit is not None and unit in AUDIT_CURRENCY_UNITS


def looks_like_units_column(p: dict) -> bool:
    """Small-magnitude float column whose name implies counts/sales, with no price column."""
    name = str(p.get("name", "")).lower()
    name_hint = any(h in name for h in SALES_NAME_HINTS)
    col_max = p.get("colMax")
    small = col_max is not None and col_max < 1000
    floaty = p.get("dtype") == "float"
    return name_hint and small and floaty and not p.get("hasPriceEvidence", False)


def _violation(check: str, status: str, finding_id: Any, message: str, upstream_fix: str) -> dict:
    return {"check": check, "status": status, "findingId": finding_id,
            "message": message, "upstreamFix": upstream_fix}


# --- checks ---

def check_c1_provenance(ledger: list[dict], claims: list[dict]) -> list[dict]:
    v: list[dict] = []
    counts: dict[str, int] = {}
    for f in ledger:
        counts[f["id"]] = counts.get(f["id"], 0) + 1
    for fid in sorted(i for i, c in counts.items() if c > 1):
        v.append(_violation("C1", "FAIL", fid, f"ledger id '{fid}' is not unique",
                            "assign one id per finding"))
    by_id = {f["id"]: f for f in ledger}
    for c in claims:
        # Semantic (evaluative) claims carry a claimType and are bound by check_bind_claims, not here.
        if c.get("claimType") is not None:
            continue
        ledger_id = c.get("ledgerId")
        truth_f = by_id.get(ledger_id)
        if truth_f is None:
            v.append(_violation("C1", "FAIL", ledger_id,
                                f"claim cites missing ledger id '{ledger_id}': {c.get('text')!r}",
                                "every rendered number must trace to a ledger finding"))
            continue
        truth = truth_f.get("value")
        rendered = c.get("renderedValue")
        if _is_number(truth) and _is_number(rendered):
            if not audit_close(rendered, truth, PCT_TOL):
                v.append(_violation("C1", "FAIL", ledger_id,
                                    f"rendered {rendered} != ledger {truth} for {c.get('text')!r}",
                                    "render the ledger value verbatim"))
        elif rendered != truth:
            v.append(_violation("C1", "FAIL", ledger_id,
                                f"rendered {rendered!r} != ledger {truth!r}",
                                "render the ledger value verbatim"))
    return v


def check_c3_unit_typing(ledger: list[dict], profile: list[dict]) -> list[dict]:
    v: list[dict] = []
    prof = {p["name"]: p for p in profile}
    for f in ledger:
        kind = f.get("kind")
        if kind in ("scalar", "breakdown_by", "timeseries") and f.get("unit") is None:
            v.append(_violation("C3", "FAIL", f["id"], f"finding '{f['id']}' has no unit",
                                "type every measure with a unit"))
        if f.get("rendersCurrencySymbol") and not is_currency_unit(f.get("unit")):
            v.append(_violation("C3", "FAIL", f["id"],
                                f"finding '{f['id']}' renders '$' but unit is {f.get('unit')!r}",
                                "drop the currency symbol or correct the unit"))
        src = f.get("sourceColumn")
        if src and src in prof:
            p = prof[src]
            if is_currency_unit(f.get("unit")) and looks_like_units_column(p):
                v.append(_violation("C3", "FAIL", f["id"],
                                    f"column '{p['name']}' (max {p.get('colMax')}, no price column) is units, "
                                    f"but finding '{f['id']}' declares currency {f.get('unit')!r}",
                                    "type this column as 'units'; remove $ from all derived findings"))
    return v


def check_c4_percent(ledger: list[dict]) -> list[dict]:
    v: list[dict] = []
    by_id = {f["id"]: f for f in ledger}
    groups: dict[str, list[dict]] = {}
    for f in ledger:
        if f.get("kind") != "percent":
            continue
        part_id = f.get("partId")
        denom_id = f.get("denominatorId")
        if part_id is None or denom_id is None:
            v.append(_violation("C4", "FAIL", f["id"],
                                f"percent '{f['id']}' missing part_id/denominator_id",
                                "every % must name its numerator and denominator"))
            continue
        if part_id not in by_id or denom_id not in by_id:
            v.append(_violation("C4", "FAIL", f["id"],
                                f"percent '{f['id']}' references missing part/denominator finding",
                                "point part_id/denominator_id at real findings"))
            continue
        part = by_id[part_id].get("value")
        denom = by_id[denom_id].get("value")
        part_num = part if _is_number(part) else None
        denom_num = denom if _is_number(denom) else None
        expected = (part_num / denom_num) * 100 if (part_num is not None and denom_num not in (None, 0)) else None
        val = f.get("value") if _is_number(f.get("value")) else None
        if expected is None or not audit_close(val, expected, PCT_TOL):
            msg = (f"percent '{f['id']}' = {f.get('value')}; part/denom*100 = {expected:.4f} "
                   f"(part={part}, denom={denom})") if expected is not None \
                else f"percent '{f['id']}' has zero denominator"
            v.append(_violation("C4", "FAIL", f["id"], msg, "recompute as part/denominator*100"))
        if not (val is not None and 0 <= val <= 100):
            v.append(_violation("C4", "FAIL", f["id"],
                                f"percent '{f['id']}' = {f.get('value')} outside [0,100]",
                                "a share cannot exceed 100% or be negative"))
        if f.get("percentGroup"):
            groups.setdefault(f["percentGroup"], []).append(f)
    for gid, members in groups.items():
        total = sum(m["value"] for m in members if _is_number(m.get("value")))
        if total > 100 + PCT_TOL * 100:
            v.append(_violation("C4", "FAIL", members[0]["id"],
                                f"percent group '{gid}' sums to {total:.2f}% (> 100%)",
                                "parts of one whole cannot exceed 100%"))
    return v


def check_c5_index_scale(ledger: list[dict]) -> list[dict]:
    v: list[dict] = []
    for f in ledger:
        if f.get("kind") != "index":
            continue
        if f.get("scale") is None:
            v.append(_violation("C5", "FAIL", f["id"], f"index '{f['id']}' has no declared scale",
                                "declare the index scale (e.g. 0-1 or 0-10000)"))
        if f.get("comparedTo") is not None and f.get("comparedToScale") != f.get("scale"):
            v.append(_violation("C5", "FAIL", f["id"],
                                f"index '{f['id']}' on scale {f.get('scale')!r} compared to threshold "
                                f"{f.get('comparedTo')} on scale {f.get('comparedToScale')!r}",
                                "put index and threshold on the same scale before comparing"))
    return v


def check_c6_edge_symmetry(ledger: list[dict], periods: list[dict]) -> list[dict]:
    v: list[dict] = []
    pmap = {p["pid"]: p for p in periods}
    for f in ledger:
        if f.get("kind") != "anomaly":
            continue
        for pid in (f.get("periodId"), f.get("basePeriodId")):
            if pid is None:
                continue
            p = pmap.get(pid)
            if p is None:
                v.append(_violation("C6", "FAIL", f["id"],
                                    f"anomaly '{f['id']}' references unknown period '{pid}'",
                                    "register every period with its coverage"))
            elif p["coverage"] < COVERAGE_MIN:
                v.append(_violation("C6", "FAIL", f["id"],
                                    f"anomaly '{f['id']}' uses period '{pid}' at "
                                    f"{round(p['coverage'] * 100)}% coverage (incomplete)",
                                    "exclude incomplete edge periods from anomaly detection"))
    return v


def check_c9_cardinality(ledger: list[dict], profile: list[dict]) -> list[dict]:
    v: list[dict] = []
    prof = {p["name"]: p for p in profile}
    for f in ledger:
        if f.get("kind") != "breakdown_by":
            continue
        src = f.get("sourceColumn")
        if src is None or src not in prof:
            v.append(_violation("C9", "FAIL", f["id"],
                                f"breakdown '{f['id']}' has no source column profile",
                                "attach the source column profile"))
            continue
        p = prof[src]
        if f.get("groupCount") is None or f.get("groupSum") is None:
            v.append(_violation("C9", "FAIL", f["id"],
                                f"breakdown '{f['id']}' missing group_count/group_sum",
                                "emit group_count and group_sum for every breakdown"))
            continue
        distinct = p.get("distinctCount") or 0
        if f.get("groupCount") != distinct:
            v.append(_violation("C9", "FAIL", f["id"],
                                f"breakdown '{f['id']}' groups {f.get('groupCount')} but column "
                                f"'{p['name']}' has {distinct} distinct values",
                                "aggregate the full column, not a truncated slice"))
        if p.get("colSum") is not None and not audit_close(f.get("groupSum"), p.get("colSum"), SUM_TOL):
            v.append(_violation("C9", "FAIL", f["id"],
                                f"breakdown '{f['id']}' sums {f.get('groupSum')} but column "
                                f"'{p['name']}' totals {p.get('colSum')}",
                                "the breakdown must reconstruct the column total"))
    return v


def check_c10_additivity(ledger: list[dict]) -> list[dict]:
    v: list[dict] = []
    for f in ledger:
        if f.get("kind") not in MEASURE_KINDS:
            continue
        if f.get("additivity") is None:
            v.append(_violation("C10", "FAIL", f["id"],
                                f"measure '{f['id']}' does not declare additivity",
                                "tag every measure extensive (summable) or intensive (rate/ratio)"))
            continue
        if f.get("additivity") == "intensive":
            agg = f.get("aggregation")
            if agg in ("sum", "mean"):
                v.append(_violation("C10", "FAIL", f["id"],
                                    f"intensive measure '{f['id']}' was aggregated by {agg!r} "
                                    f"(average-of-ratios / summed rate)",
                                    "recompute from numerator/denominator totals, never sum or mean a rate"))
            elif agg == "recomputed":
                if f.get("numeratorId") is None or f.get("denominatorId") is None:
                    v.append(_violation("C10", "FAIL", f["id"],
                                        f"intensive measure '{f['id']}' claims 'recomputed' but lacks "
                                        f"numerator_id/denominator_id",
                                        "point a recomputed rate at its extensive numerator and denominator"))
    return v


def check_c11_polarity(ledger: list[dict]) -> list[dict]:
    v: list[dict] = []
    for f in ledger:
        if f.get("superlative") is None:
            continue
        if f.get("polarity") is None:
            v.append(_violation("C11", "FAIL", f["id"],
                                f"finding '{f['id']}' uses superlative framing but declares no polarity",
                                "declare higher_better / lower_better / neutral before praising an extreme"))
            continue
        if f.get("superlative") == "praises_max" and f.get("polarity") != "higher_better":
            v.append(_violation("C11", "FAIL", f["id"],
                                f"finding '{f['id']}' praises the MAX of a {f.get('polarity')!r} measure "
                                f"('leads/best/dominates' on something where lower is better)",
                                "reframe the highest value as 'most/highest' and as attention, not achievement"))
        if f.get("superlative") == "praises_min" and f.get("polarity") != "lower_better":
            v.append(_violation("C11", "FAIL", f["id"],
                                f"finding '{f['id']}' praises the MIN of a {f.get('polarity')!r} measure",
                                "the lowest value is only 'best' when lower is better; reframe"))
    return v


def check_c12_sign_hygiene(ledger: list[dict], profile: list[dict]) -> list[dict]:
    v: list[dict] = []
    prof = {p["name"]: p for p in profile}
    for f in ledger:
        method = f.get("method")
        triggers = f.get("kind") in ("percent", "index") or (method is not None and method in SIGN_METHODS)
        if not triggers:
            continue
        col = f.get("sourceColumn")
        if col and col in prof:
            p = prof[col]
            cmin, cmax = p.get("colMin"), p.get("colMax")
            if cmin is not None and cmax is not None and cmin < 0 and cmax > 0:
                v.append(_violation("C12", "FAIL", f["id"],
                                    f"finding '{f['id']}' ({method or f.get('kind')}) runs over column "
                                    f"'{col}' with mixed signs (min {cmin}, max {cmax})",
                                    "split positive/negative pools or block shares; signed parts break share/Pareto/HHI"))
    return v


def check_c13_unit_homogeneity(ledger: list[dict]) -> list[dict]:
    v: list[dict] = []
    for f in ledger:
        combined = f.get("combinedUnits")
        if combined and len(set(combined)) > 1:
            uniq = sorted(set(combined))
            v.append(_violation("C13", "FAIL", f["id"],
                                f"aggregate '{f['id']}' sums across multiple units/currencies {uniq} "
                                f"without normalization",
                                "convert to one unit/currency (e.g. FX) before aggregating"))
    return v


def check_c14_non_duplication(ledger: list[dict]) -> list[dict]:
    v: list[dict] = []
    for f in ledger:
        if f.get("kind") != "breakdown_by":
            continue
        if f.get("dimensionAdditive") is False and f.get("aggregation") == "sum":
            v.append(_violation("C14", "FAIL", f["id"],
                                f"breakdown '{f['id']}' sums a non-additive dimension "
                                f"(hierarchy or multi-touch attribution) -> double counting",
                                "aggregate at one level only, or de-duplicate before summing"))
    return v


def detect_duplicate_definitions(ledger: list[dict]) -> list[dict]:
    """C2 (detect) — mechanical to detect, judgment to resolve -> REVIEW."""
    v: list[dict] = []
    by_name: dict[str, list[dict]] = {}
    for f in ledger:
        if f.get("kind") in SEMANTIC_KINDS:
            continue  # semantic findings are not numeric measures; no formula/value to duplicate
        by_name.setdefault(f["measureName"], []).append(f)
    for name, members in by_name.items():
        formulas = {m["formula"] for m in members if m.get("formula") is not None}
        # Round to 1e-6 with JS Math.round semantics (round half toward +Inf == floor(x+0.5)).
        values = {math.floor(m["value"] * 1e6 + 0.5) / 1e6 for m in members if _is_number(m.get("value"))}
        if len(formulas) > 1 or len(values) > 1:
            ids = ", ".join(m["id"] for m in members)
            formula_list = sorted(formulas)
            v.append(_violation("C2", "REVIEW", None,
                                f"measure '{name}' has multiple definitions/values across [{ids}] "
                                f"(formulas={formula_list})",
                                "AI auditor: confirm these are genuinely distinct measures (e.g. gross vs net) "
                                "and rename; otherwise collapse to one definition"))
    return v


# --- claim binding (BIND-*) ---
# The numeric gate guards NUMBERS; these guard CLAIMS — assertions about identity, ranking,
# direction, risk, and interpretation that carry no number for C1 to check. The contract mirrors
# C1's ledger discipline: every evaluative claim must CITE a finding, and we verify the citation
# deterministically. A contradicting/unbound claim BLOCKS (it is never rewritten); the message
# names the correct value so the upstream fix is obvious.

def check_bind_claims(ledger: list[dict], claims: list[dict], columns: list[dict]) -> list[dict]:
    by_id = {f["id"]: f for f in ledger}
    col_names = [str(p.get("name", "")).lower() for p in columns]
    v: list[dict] = []

    for c in claims:
        ct = c.get("claimType")
        if ct is None:
            continue  # numeric provenance claim -> handled by C1
        text = c.get("text")

        # BIND-0: every evaluative claim must cite a backing finding that exists.
        cited = c.get("cites")
        if cited is None:
            v.append(_violation("BIND-0", "FAIL", None,
                                f"{ct} claim {text!r} cites no finding",
                                "the narrator may not assert without a backing finding"))
            continue
        f = by_id.get(cited)
        if f is None:
            v.append(_violation("BIND-0", "FAIL", cited,
                                f"{ct} claim {text!r} cites missing finding '{cited}'",
                                "cite a finding that exists in the ledger"))
            continue

        # BIND-LEADER: the claimed entity must equal the leader finding's entity.
        if ct == "leader":
            subject = c.get("subject")
            if f.get("kind") != "leader" or (subject and f.get("metric") != subject):
                v.append(_violation("BIND-LEADER", "FAIL", f["id"],
                                    f"leader claim {text!r} cites a non-leader / wrong-metric finding '{f['id']}'",
                                    "cite the leader finding for this metric"))
            elif c.get("predicate") != f.get("entity"):
                v.append(_violation("BIND-LEADER", "FAIL", f["id"],
                                    f"claims '{c.get('predicate')}' leads {subject}, but finding says '{f.get('entity')}'",
                                    f"name the actual leader '{f.get('entity')}' or drop the claim"))

        # BIND-TREND / BIND-SEASONAL: direction must match; a seasonal trough is not a 'concern'.
        elif ct == "trend_direction":
            pred = c.get("predicate")
            if pred in ("up", "down", "flat"):
                if f.get("kind") != "trend" or pred != f.get("direction"):
                    v.append(_violation("BIND-TREND", "FAIL", f["id"],
                                        f"claims trend '{pred}' but finding direction is '{f.get('direction')}'",
                                        f"state the actual direction '{f.get('direction')}' or drop the claim"))
            elif pred == "concern":
                if f.get("seasonalExplained") is True:
                    v.append(_violation("BIND-SEASONAL", "FAIL", f["id"],
                                        f"narrates a seasonal trough/peak as a concern to investigate ({text!r})",
                                        "do not alarm on a change the engine explains as the seasonal pattern"))

        # BIND-LOSS: the entity must be in the engine's loss-making set.
        elif ct == "loss_making":
            members = f.get("members") or []
            if f.get("kind") != "loss_making" or c.get("subject") not in members:
                v.append(_violation("BIND-LOSS", "FAIL", f["id"],
                                    f"claims '{c.get('subject')}' is loss-making; not in loss set {members}",
                                    "only items the engine flags as loss-making may be called so"))

        # BIND-RISK: only raise risks the engine flagged as significant.
        elif ct == "risk_alert":
            if f.get("kind") != "risk" or f.get("significanceFlag") is not True:
                v.append(_violation("BIND-RISK", "FAIL", f["id"],
                                    f"raises a risk not flagged significant by the engine (finding '{f['id']}')",
                                    "do not raise risks below the significance threshold"))

        # BIND-INTERP: price/demand talk requires the column to actually exist.
        elif ct == "interpretation":
            pred = c.get("predicate")
            if pred == "price_driven" and not any("price" in n for n in col_names):
                v.append(_violation("BIND-INTERP", "FAIL", f["id"],
                                    "asserts a PRICE interpretation, but the data has no price column",
                                    "no price column exists; cannot claim price-driven"))
            if pred == "demand_driven" and not any(
                    k in n for n in col_names for k in INTERP_DEMAND_HINTS):
                v.append(_violation("BIND-INTERP", "FAIL", f["id"],
                                    "asserts a DEMAND interpretation with no units/quantity column",
                                    "no volume column exists; cannot claim demand-driven"))
    return v


# --- cross-foot (XFOOT) — the engine vs ITSELF ---
# The same headline total must reconcile across independent aggregation paths. If KPIs sum 40k
# rows and the trend sums 99k rows, the reconstructed total won't match — caught with no AI.

def check_xfoot(groups: list[dict]) -> list[dict]:
    v: list[dict] = []
    for g in groups:
        label = g.get("label")
        paths = g.get("paths") or {}
        if len(paths) < 2:
            v.append(_violation("XFOOT", "FAIL", None,
                                f"cross-foot '{label}' needs >=2 independent paths, got {list(paths)}",
                                "compute the total along at least two aggregation paths"))
            continue
        items = list(paths.items())
        ref_name, ref_val = items[0]
        for name, val in items[1:]:
            if not audit_close(float(val), float(ref_val), XFOOT_TOL):
                v.append(_violation("XFOOT", "FAIL", None,
                                    f"'{label}' disagrees across paths: {ref_name}={ref_val:,.2f} vs "
                                    f"{name}={val:,.2f} (different row base / filter)",
                                    "unify the row base; every aggregation must sum the same rows"))
    return v


# --- runner ---

def run_audit(ledger: list[dict], columns: list[dict], claims: list[dict],
              periods: list[dict] | None = None,
              cross_foot: list[dict] | None = None) -> dict:
    """A single FAIL -> BLOCK. No FAILs but >=1 REVIEW -> REVIEW. Otherwise PASS."""
    periods = periods or []
    cross_foot = cross_foot or []
    violations: list[dict] = []
    violations += check_c1_provenance(ledger, claims)
    violations += check_c3_unit_typing(ledger, columns)
    violations += check_c4_percent(ledger)
    violations += check_c5_index_scale(ledger)
    violations += check_c6_edge_symmetry(ledger, periods)
    violations += check_c9_cardinality(ledger, columns)
    violations += check_c10_additivity(ledger)
    violations += check_c11_polarity(ledger)
    violations += check_c12_sign_hygiene(ledger, columns)
    violations += check_c13_unit_homogeneity(ledger)
    violations += check_c14_non_duplication(ledger)
    violations += detect_duplicate_definitions(ledger)
    violations += check_bind_claims(ledger, claims, columns)
    violations += check_xfoot(cross_foot)

    if any(x["status"] == "FAIL" for x in violations):
        verdict = "BLOCK"
    elif any(x["status"] == "REVIEW" for x in violations):
        verdict = "REVIEW"
    else:
        verdict = "PASS"
    return {"verdict": verdict, "violations": violations}
