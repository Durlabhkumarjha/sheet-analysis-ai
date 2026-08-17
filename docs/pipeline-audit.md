# Pipeline Divergence Audit

Goal: find every surface that forks its own cleaning / verdict / narration logic instead
of consuming the shared pipeline, so a fix in one place stops failing to propagate.

> **Status: closed.** Phases 1–4 unified the surfaces on the shared pipeline; the wiring
> loop (`test/wiring.test.ts`) now proves the production surfaces actually consume it. The
> end-state table is in [§ End state](#end-state--surfaces-now-route-through-the-boundary);
> the original Phase-1 findings are kept below for history.

## Architectural reality (why this audit is monolith-shaped)

Every surface — Dashboard, AI Report, Forecast, Talk-to-Data, exec-summary box,
recommendation cards, Explore — is a **function inside the single `src/App.tsx` monolith**,
not a separate per-surface file. Consequences for verification:

- A "list of surface files" / per-file dependency rule does not apply; there is one file
  that both **parses uploads** (`xlsx`, the CSV worker) *and* hosts every analysis surface.
  So "no surface imports the parser" cannot be a file-level rule here. The meaningful, and
  enforced, invariant instead: **the shared analysis layer (`src/metrics.ts`,
  `src/analysis/*`) never imports the parser** — raw rows reach it only after upload.
- To prove surfaces at runtime, the surface functions (`analyzeData`, `answerQuestion`,
  `smartAnswer`, `createExecutiveSummary`, `getRecommendedActions`, `generateSmartInsights`,
  `guardBars`) were given `export` (one-word changes only) so the test can invoke and spy
  them. No logic was moved out of the monolith.

## End state — surfaces now route through the boundary

Legend: ✅ uses shared · ⚠️ partial · ➖ n/a

| Surface | Cleaning | Verdict / Findings | Narration guard (runtime) | Chart safety | Proven by |
|---|---|---|---|---|---|
| Dashboard (`analyzeData` + render) | ✅ `canonicalRows` | ✅ trend KPI reads `findings.trend` | ➖ no LLM | ✅ `guardBars` → `validateChartSeries` | spy: guardBars calls validateChartSeries |
| AI Report | ✅ | ✅ `buildNarrationContract(buildFindings)` | ✅ `sanitizeNarration` per section | ✅ `validateChartSeries` | static import + verdicts suite |
| Forecast (`ForecastChart`) | ✅ | ✅ `findings.trend` label | ➖ | ➖ | — |
| Exec-summary box (`createExecutiveSummary`) | ✅ | ✅ `findings` param at both call sites | ✅ sanitized at call site | ➖ | strip: non-empty + carries "normal variation" + lint-clean |
| Recommendation cards (`getRecommendedActions`) | ✅ `realItems` (no junk titles) | ✅ `findings.trend` (no `isTrendFlat`/"momentum") | ✅ lint-clean output | ➖ | strip: carries verdict + lint-clean |
| Talk-to-Data (`answerQuestion` / `smartAnswer`) | ✅ `realItems`/`canonicalRows` | ✅ `findings.trend` gate | ✅ `sanitizeNarration` on **both** AI and fallback paths | ✅ `validateChartSeries` | spy: smartAnswer fallback calls sanitizeNarration; strip on answerQuestion |
| Explore (`generateSmartInsights`) | ✅ `realItems` | ✅ trend insight gated on `findings` | ✅ lint-clean (flat-trend insight omitted, not faked) | ⚠️ inline | strip: non-empty + lint-clean |

**Zero remaining narration forks.** Documented, justified exceptions (not forks):

1. **`isTrendFlat` survives as the no-data fallback only.** Every narration site is
   `findings ? findings.trend… : isTrendFlat(analysis)` (or the sequential equivalent at
   App.tsx ~8014, reached only when `trendVerdict` is null). It is **module-private** (the
   wiring test asserts it is never exported) and the strip tests prove it is inert whenever
   real `findings` exist — i.e. on every real dataset. Removing it entirely was out of scope
   for this loop (Option 2: verification-first, minimal `App.tsx` churn).
2. **`latestPeriodChange` survives as a magnitude display only.** The significance/direction
   always comes from `findings.trend`; `latestPeriodChange` only supplies the "(latest period
   ↑ X%)" number, never the verdict.

## Wiring fix applied during this loop

`smartAnswer`'s no-network **fallback path** previously returned the rule-based
`answerQuestion` text *without* `sanitizeNarration` — only the AI path sanitized. That meant a
rule-based Talk-to-Data answer could bypass the Layer-4 guard. The fallback now runs the same
`sanitizeNarration(text, findings)` as the AI path (App.tsx, `smartAnswer` `fallback()`).

## Root cause — Talk-to-Data (one sentence)

Talk-to-Data diverged because `answerQuestion` / `smartAnswer` originally received only the
`Analysis` aggregate and re-derived trend/momentum claims from `analysis.latestPeriodChange`
and the heuristic `isTrendFlat()` — never the `Findings` ledger — so a globally-flat dataset
still produced "Trend +X% / growth momentum" answers that contradicted the report and forecast.

---

# Appendix — original Phase 1 findings (historical)

## Shared modules (the canonical pipeline)

| Concern | Canonical module / function |
|---|---|
| Row cleaning + invalid filter | `src/metrics.ts` → `canonicalRows`, `cleanCategory`, `isInvalidCategory`, `isJunkLabel`, `realItems`, `identifiedTotal`, `toNumber`, `parseValidDate` |
| Verdict / significance engine | `src/analysis/verdicts.ts` → `trend`, `categorySignal`, `seasonality`, `holidayLift` (+ `THRESHOLDS`) |
| Findings ledger (single source of truth) | `src/analysis/findings.ts` → `buildFindings` → `Findings` |
| Narration contract | `src/analysis/narration.ts` → `buildNarrationContract`, `activeBans` |
| Deterministic linter | `src/analysis/lintReport.ts` → `lintReport`, `assertTrendConsistency` |

### Competing/forked implementations found

- `isTrendFlat(analysis)` — App.tsx:6896. A spread/percent heuristic that is a **second**
  trend implementation, independent of `verdicts.ts` `trend()` (Mann-Kendall + noise band).
  Used by Talk-to-Data and Recommendation cards.
- `analysis.latestPeriodChange` — a raw last-vs-prior delta computed in `analyzeData`,
  used as a trend signal by Talk-to-Data, Rec cards, and the driver/summary answers.
- Inline last-vs-first percent: `answerQuestion` forecast branch (App.tsx:7833).

## Surface → module usage matrix

Legend: ✅ uses shared · ⚠️ partial · ❌ forks/bypasses · ➖ n/a

| Surface | Cleaning | Verdict engine | Findings ledger | Narration contract | Linter (runtime) | Chart safety |
|---|---|---|---|---|---|---|
| Dashboard (`analyzeData` + render) | ✅ `canonicalRows` | ⚠️ trend KPI reads `findings`; rest uses `latestPeriodChange` | ⚠️ trend KPI only | ➖ no LLM | ➖ | ⚠️ inline junk filter at render (3375/3430), no shared validator |
| AI Report (`buildAnalysisContext`→`callAI`/`callSmartAI`) | ✅ | ✅ via `buildNarrationContract(buildFindings)` (8638) | ✅ | ✅ contract injected | ❌ **`lintReport` never called at runtime** | ⚠️ junk strip at 5130 |
| Forecast (`ForecastChart`) | ✅ | ✅ `trendLabel` from `findings` | ✅ | ➖ | ➖ | ➖ |
| Exec-summary box (`createExecutiveSummary`) | ✅ | ✅ at call site 3077 (`findings` passed) | ⚠️ 3077 passes findings; 8039 call site does NOT | ⚠️ template, partial | ❌ | ➖ |
| Recommendation cards (`getRecommendedActions`) | ❌ `analysis.productRevenue[0]`/`regionRevenue[0]` **unfiltered** (junk bucket can surface) | ❌ `isTrendFlat` + "Momentum" label | ❌ no `findings` param | ❌ none | ❌ | ➖ |
| Talk-to-Data (`answerQuestion` + BYOK path) | ⚠️ entities via `realItems`/`identifiedTotal` ✅; BYOK runs on `canonicalRows` ✅ | ❌ own trend: `latestPeriodChange`, `isTrendFlat`, raw % (7833) | ❌ no `findings` param | ❌ only `correctNarrative` (rank-#1 fix only) | ❌ | ⚠️ junk strip at 7769 |
| Explore (`generateSmartInsights`, charts) | ✅ mostly `realItems`/`identifiedProductRevenue` | ❌ own gap/"Nx larger"/risk heuristics | ❌ no `findings` | ➖ template | ❌ | ⚠️ inline |

## Root cause — Talk-to-Data

`answerQuestion` (App.tsx:7799) and the BYOK `callSmartQuery` path (7699+) receive only the
`Analysis` aggregate object — **never the `Findings` ledger**. They re-derive trend/forecast/
momentum claims directly from `analysis.latestPeriodChange`, `analysis.periodRevenue`, and the
heuristic `isTrendFlat()`, none of which pass through `verdicts.ts`. So when the dataset is
globally flat (Fixture A), Talk-to-Data still emits "Trend is +X%", "growth momentum", or
"Capitalize on …", contradicting the AI report and forecast which call the same data flat.

Entity counting is **not** the divergence — Talk-to-Data already routes ranks/shares through
`realItems`/`identifiedTotal`, so junk categories are excluded. The divergence is specifically:
(1) trend/momentum narration escaping the significance gate, and (2) no narration contract /
`lintReport` applied to either the rule-based answer or the BYOK explanation.

## Other confirmed forks (beyond Talk-to-Data)

1. **Recommendation cards** (`getRecommendedActions`, 8052): reads `analysis.productRevenue[0]`
   and `regionRevenue[0]` **without** the invalid-category filter → can title a card
   "Protect Missing/Invalid". Uses `isTrendFlat` and a "Momentum" label rather than the
   `findings.trend` verdict. No `findings` parameter at all.
2. **Linter is test-only.** `lintReport`/`assertTrendConsistency` are imported only by
   `test/verdicts.test.ts`. No runtime surface post-processes LLM/template output through it,
   so the Layer-4 guard never actually runs in the product.
3. **`createExecutiveSummary` second call site** (8039) omits `findings`, so that path degrades
   to the pre-guardrail template.
4. **No shared chart validator.** Junk filtering is duplicated inline at each render site
   (3375, 3430, 5130, 7769). There is no single check for "series mixes a grand total with its
   components" or "share breakdown sums to ~100% against one denominator". Summary-row detection
   exists only at import-time column profiling (1626, 5866).

## Phase 2 plan (derived from the above)

- Give `answerQuestion`, `getRecommendedActions`, `generateSmartInsights`, and the BYOK
  explain path a `Findings` parameter; replace every `isTrendFlat`/`latestPeriodChange` trend
  claim with `findings.trend` (and per-entity claims with a multiple-comparison-corrected
  verdict — Phase 3 rule 2).
- Filter rec-card top entity through `realItems`.
- Apply `lintReport(text, findings)` at runtime to every narrated surface (report, exec box,
  rec cards, Talk-to-Data) — strip/regenerate on violation.
- Add a single `validateChartSeries` used by every chart render (Phase 3 rule 3).
- Expose a single typed boundary (`AnalysisResult` = cleaned dataset + `Findings`) so render/
  narration code cannot import raw rows (Phase 4).
