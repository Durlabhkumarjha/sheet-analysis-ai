# Computation Lineage Audit + Semantic Guards

Premise: our errors are not arithmetic — they're misinterpretations of what columns
*mean*. This doc traces every displayed value back to its formula, source column(s),
aggregation, filters, and — the column that matters most — the **assumption** each
computation makes about the data. Phase 2 turns the risky assumptions into a numbered
risk list. Phase 3 (separate change set) adds domain-agnostic guards + tests.

All file references are `src/App.tsx` unless another file is named.

---

## Shared pipeline boundary (the single sources of truth)

These are the choke points every surface is supposed to route through. If a value
bypasses one, that is a Phase-2 "filter bypass" risk by construction.

| Concern | Canonical helper | File |
|---|---|---|
| Which rows count | `canonicalRows(rows, mapping)` | `src/metrics.ts:56` |
| Junk/missing label test | `isInvalidCategory` / `cleanCategory` / `isJunkLabel` | `src/metrics.ts:8-26` |
| Number parsing | `toNumber`, `hasNumericValue` | `src/metrics.ts:28-39` |
| Share denominator (per-dimension identified total) | `identifiedTotal`, `dimensionShare` | `src/metrics.ts:73-90` |
| Drop junk from a ranked list | `realItems` | `src/metrics.ts:94` |
| Statistical verdicts (trend/season/category/entity/completeness) | `THRESHOLDS` + verdict fns | `src/analysis/verdicts.ts` |
| Findings ledger (single verdict source) | `buildFindings(rows, mapping)` | `src/analysis/findings.ts:76` |
| Narration lint / strip | `lintReport`, `sanitizeNarration` | `src/analysis/lintReport.ts` |
| Chart series guard | `validateChartSeries` / `guardBars` | `src/analysis/chartGuard.ts` |

Key unit conventions:
- `formatPercent(value)` uses `Intl.NumberFormat` `style:"percent"`, which **multiplies by 100**
  (`App.tsx:8752`). Its input MUST be a 0–1 fraction. Passing an already-×100 value double-scales.
- `dimensionShare(...)` returns a **percentage (0–100)**, not a fraction.
- `RankedItem.pct` and `computeABC(...).pct` are **fractions (0–1)**.

---

## PHASE 1 — Lineage table

### A. KPI tiles (Dashboard)

| Surface / value | Formula | Source col(s) & role | Aggregation | Filters applied | Assumption about the column |
|---|---|---|---|---|---|
| Total revenue | `analysis.totalRevenue` = Σ value | `mapping.revenue` (value) | sum over canonical rows | canonicalRows (numeric value, valid date) | the value column is a **row-total**, additively meaningful (NOT a per-unit price) |
| Avg transaction | total / rowCount | `mapping.revenue` | mean | canonicalRows | each row is one comparable transaction |
| Latest-period change | `analysis.latestPeriodChange` (fraction) | `mapping.date`,`revenue` | last full period vs prior | partial endpoint suppressed via `findings.latestPeriodPartial` (`3181`) | last period is comparable only if complete |
| Profit margin % | `totalProfit/totalRevenue*100` (`3196`) | `mapping.profit`,`revenue` | ratio of sums | canonicalRows | profit & revenue are same-basis totals |
| Top-product share | `topProduct.revenue / identifiedProdRev` | `mapping.product`,value | item sum ÷ dimension identified total | `realItems` excludes junk; denom via identified total | product field is a true low-cardinality category |

### B. Executive summary — `createExecutiveSummary(analysis, settings, mapping, findings)`

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| Trend sentence | reads `findings.trend.label`/`.direction` | date,value | Mann-Kendall on **full periods only** (`findings.ts:215`) | partial endpoints excluded; narration lint-stripped | series is a chronological metric over comparable periods |
| Seasonality sentence | `findings.seasonality` | date,value | ANOVA + η² floor `seasonEffectFloor` | partial months excluded (`findings.ts:189`) | calendar grouping is meaningful |
| Top items | `realItems(analysis.productRevenue)` | product,value | `rankBy` sum | junk → end via `pushInvalidToEnd` | product is a category, value is a total |

### C. Recommendation cards — `getRecommendedActions(analysis, settings, findings)`
Reads `findings` verdicts; emits no claim the verdict engine ruled non-significant
(enforced by `lintReport` in tests). Same source/assumptions as B.

### D. Forecast — `computeForecast(periodRevenue, periods=3)` (`6890`)

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| Point forecast | linear regression + Holt double-exp blend (chosen by R²) | date,value | per-period sums then fit | gated on `findings.trend`/completeness for narration | periods are evenly spaced & comparable; value is additive per period |

### E. Trend / Seasonality / Completeness verdicts — `buildFindings` (`findings.ts`)

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| `trend` | Mann-Kendall p<`trendP` + SPC band | date,value | sum to monthly, fit full periods | partial first/last excluded | monthly bucket is the right period |
| `seasonality.month/dow` | one-way ANOVA, η²≥`seasonEffectFloor` | date,value | daily totals grouped | partial months skipped | day/month grouping is semantically valid |
| `periodCompleteness` | count ratio vs interior median OR calendar coverage < `partialPeriodFloor` | date | per-month count + coverage | — | endpoint truncation, not real change |
| `category` | chi-square + `categoryEffectFloor` (max/min) | product, qty | per-item volume | junk items skipped (`findings.ts:139`) | product is a real category; qty is a count |
| `entitySignals` | BH-FDR `entityAlpha` + robust z, `entityEffectFloor` | product,value | per-item sum | junk skipped | items are comparable entities |

### F. Ranked dimensions — `mappedRank` → `rankBy` (`7395`/`7403`)

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| productRevenue / customerRevenue / regionRevenue | group-by-label sum of value | product/customer/region (category), value | `rankBy` sum, desc | `cleanCategory`; junk pushed to end | grouping field is a **true category** (bounded cardinality) and value is a row-total |

### G. Value tiers / ABC / Pareto — `abcClassification` useMemo (`1359`) → `computeABC` (`6875`)

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| ABC tiers | sort desc by value; cumPct ≤0.8→A, ≤0.95→B, else C; `pct`,`cumPct` fractions | normally `mapping.product`; **fallback** to first dimension with `uniqueVals ≥ 8` (`1365-1377`) | per-label sum | `realItems`; fallback uses `cleanCategory` | **the grouped field is a legitimate item dimension** ← weakest assumption (see R1) |

### H. Customer concentration — `ConcentrationChart` (`4864`)

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| per-row share | `item.revenue / total` (fraction 0–1) | customer (category), value | sum ÷ grand total of passed items | items already `realItems`-filtered by caller (`3526`) | passed list is the customer dimension; value additive |
| top-3 / top-1 share | Σ top-k fraction | same | sum | same | concentration is over a genuine entity set |

Math here is **single-scaled and correct**: `share` is a fraction, rendered once via
`formatPercent`. Ground truth on mobile file: top-3 customers = **0.142%** (40,013 distinct
customers) — a believable tiny share, confirming no double-scale in this component.

### I. Comparison breakdown table (period-over-period) (`4137-4189`)

| Value | Formula | Source & role | Aggregation | Filters | Assumption |
|---|---|---|---|---|---|
| `{metric} change` KPI (`4137`) | `formatPercent(comparison.revenueChange)` — revenueChange is a **fraction** | revenue | ratio | canonicalRows | **CORRECT convention** (reference for the bug below) |
| Avg-transaction change (`4140`) | `formatPercent(((avg-prevAvg)/prevAvg) * 100)` | revenue | ratio ×100 | canonicalRows | per-row total |
| Per-product change (`4152→4158`) | `change = ((rev-prevRev)/prevRev)*100`; `formatPercent(change)` | product,value | per-item ratio ×100 | realItems | category |
| Per-region change (`4177→4183`) | same ×100 pattern | region,value | per-item ratio ×100 | realItems | category |

### J. Charts (hand-rolled SVG)
- Bars: `guardBars(...)` → `validateChartSeries` drops junk labels/non-finite (`chartGuard.ts`).
- Line "{metric} Over Time": series = period sums; trend label via
  `resolveTrendChartLabel(findings?.trend.label, slopePct)` (`~4615`) — **verdict governs**,
  raw slope only used as the no-verdict fallback.
- Concentration bar widths: `row.share * 100` (correct — fraction → CSS %).

---

## PHASE 2 — Semantic risk list

Risk types: (1) wrong-dimension aggregation, (2) value-semantics mismatch,
(3) percentage/unit error, (4) filter bypass.

### R1 — Wrong-dimension aggregation in the ABC/value-tier fallback  *(type 1)* — CONFIRMED
**Where:** `abcClassification` useMemo, `App.tsx:1362-1378`.
**What:** When mapped products < 8, it scans `[...additionalDimensions, ...text profiles
with unique∈[8,500]]` and adopts the **first** dimension whose distinct count is `>= 8`
(`1368`) — with **no upper bound on `additionalDimensions`** and only a lower bound on the
per-dim recheck. On the mobile file (2 real products, 25,147 locations, 40,013 customers)
the fallback can tier a near-identifier field as if it were an "item" dimension, producing
a meaningless ABC chart.
**Why it's a misinterpretation:** distinct-count ≈ row-count means the field is an
identifier/free-text key, not a categorical item. Tiering/ranking/share are only meaningful
on bounded categories.
**Fix direction (Phase 3):** cardinality/role guard — reject fallback dimensions whose
distinct-count exceeds a `THRESHOLDS` ceiling (and/or whose uniqueness ratio ≈ 1); prefer a
confirmed product/dimension role; never silently bucket a high-cardinality field as "items".

### R2 — Value-semantics mismatch: per-unit price summed as revenue  *(type 2)* — CONFIRMED
**Where:** every value-sum path when `mapping.revenue` points at a per-unit price column
(`canonicalRows` valueCol, `findings.ts` total, `rankBy`, KPIs).
**What:** Mobile `Price` is a **per-unit** price (does not scale with quantity).
`looksLikePerUnitPrice(rows, revenue, quantity)` already detects this
(`src/dataQuality.ts`, Pearson r < `PER_UNIT_CORR_FLOOR`), but the result currently only
drives a soft UI notice — totals/tiers/forecast still sum the unit price as if it were a
line total.
**Why:** summing a unit price is not a meaningful aggregate; "total revenue" becomes the sum
of sticker prices.
**Fix direction:** value-role guard — when `looksLikePerUnitPrice().likely`, prefer
`Price×Quantity` as the value (or warn + suppress revenue-as-total claims), wired into the
canonical value path so all surfaces inherit it.

### R3 — Percentage double-×100 in the comparison breakdown  *(type 3)* — CONFIRMED
**Where:** `App.tsx:4140`, `4152→4158`, `4177→4183`.
**What:** `formatPercent` already multiplies by 100, but these call sites pass a value that
is **already ×100**, so a +14.2% change renders as **+1420%** (~70× class of error the prompt
flags). Contrast `4137` which correctly passes a fraction.
**Why:** unit convention violated — `formatPercent` expects a 0–1 fraction.
**Fix direction:** pass the raw fraction (drop `* 100`) at 4140/4152/4177, OR introduce a
single canonical share/percent helper and route all three through it. Add a range guard so a
share/percentage outside a sane band is caught in tests.

### R4 — No structural range guard on shares/percentages  *(type 3, latent)* — CONFIRMED (gap)
**Where:** share computations generally (`dimensionShare`, ConcentrationChart, ABC `pct`).
**What:** Individual sites are correct today, but nothing asserts the invariants
(0 ≤ share ≤ 1 for fractions; per-dimension shares sum to ≈100%; no value double-scaled).
R3 is exactly the failure that an invariant would have caught.
**Fix direction:** range guard + a test asserting no rendered share exceeds 100% and that a
dimension's shares sum to ~100% on the real fixtures.

### R5 — Filter-parity check is by-convention only  *(type 4, latent)* — ACCEPTED-with-test
**Where:** all aggregation paths are *supposed* to start from `canonicalRows` / `realItems`.
**What:** No automated proof that every aggregated value flows through the same cleaning;
`wiring.test.ts` proves the narration/chart path but not every numeric aggregate.
**Fix direction:** filter-parity guard/test — recompute a couple of headline values directly
from raw rows through `canonicalRows` and assert equality with the app's figure on the real
fixtures.

---

## Status — all phases complete
- Phase 1 lineage table: complete (above).
- Phase 2 risk list: R1–R5 recorded.
- Phase 3 guards + tests: complete (`test/semanticGuards.test.ts`, 13 tests; full suite 70 green).
- Phase 4 transparency UI: complete (`ComputedNote` affordance on KPIs + concentration chart).
- Build smoke: `npm run build` exits 0.

### Guards added (Phase 3)
| Guard | Where | Threshold | Test |
|---|---|---|---|
| Cardinality/role | `isTierableDimension` (`src/dataQuality.ts`), wired into `abcClassification` (`App.tsx`) | `THRESHOLDS.maxTierDimensionCardinality` / `maxTierUniqueRatio` / `minTierDimensionCardinality` (`verdicts.ts`) | GUARD 1 |
| Value-role | `looksLikePerUnitPrice` (`src/dataQuality.ts`), surfaced as a mapping notice | `PER_UNIT_CORR_FLOOR` | GUARD 2 + AT-PP5 |
| Range (share) | `computeShares` + `isValidShareFraction` (`src/metrics.ts`) | shares are fractions in [0,1]; sum ≈1 | GUARD 3 |
| Percentage convention | `formatPercent` exported; comparison-table sites pass fractions | — | GUARD 4 |
| Filter parity | `canonicalRows` proven against an independent re-filter | — | GUARD 5 |

### Before/after — the two named bugs
- **Concentration / percentage double-×100 (R3)**: before — comparison-table changes were
  pre-multiplied by 100 then re-scaled by `formatPercent`, so +14.2% rendered as **+1,420%**
  (`App.tsx:4140/4152/4177`); after — the raw fraction is passed once (`(cur-prev)/prev`),
  rendering **+14.2%**. GUARD 4 pins the convention. (Customer top-3 concentration was already
  correct at **0.142%** and GUARD 3 now asserts it stays a sub-1% fraction.)
- **Value-tier dimension (R1)**: before — with mapped products < 8 (mobile has 2), the ABC
  fallback could adopt the first field with ≥ 8 distinct values, with **no upper bound** on
  user-added dimensions — tiering a 25k-distinct location / 40k-distinct customer as if it were
  an "item"; after — `isTierableDimension` refuses any field above the cardinality ceiling or
  with a near-1-per-row uniqueness ratio, so a high-cardinality identifier can never be tiered.
  GUARD 1 asserts every over-ceiling column in the mobile file is rejected.
