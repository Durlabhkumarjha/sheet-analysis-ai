// Layer 2 — the Findings ledger: the single source of truth. Every rendered section
// (exec summary, KPIs, forecast outlook, trend caption, per-chart captions, the AI
// report) must read its verdict/label from this object instead of re-deriving from
// raw numbers. That structural single-source is what stops three sections of the same
// report from disagreeing about whether the trend is up, flat, or down.

import { isInvalidCategory, parseValidDate, inferDayFirst, toNumber } from "../metrics";
import {
  categorySignal,
  entityOutliers,
  holidayLift,
  periodCompleteness,
  seasonality,
  trend,
  type CategoryVerdict,
  type EntitySignalsVerdict,
  type HolidayVerdict,
  type PeriodCompletenessVerdict,
  type PeriodObservation,
  type PriceInfo,
  type SeasonalityVerdict,
  type TrendVerdict,
} from "./verdicts";

// Minimal role map — matches the app's Mapping but only needs these roles here.
export type FindingsMapping = {
  date?: string;
  revenue?: string;
  quantity?: string;
  cost?: string;
  product?: string;
};

// Every risk/recommendation the AI is allowed to narrate is tied to one of these finding
// keys. The key is what the reconciliation gate matches a rendered claim against — a claim
// that names no key (e.g. an invented "standardize pricing" risk) is a violation. There is
// no "value range is high/wide" key on purpose: a range is never a risk unless a verdict
// flags it.
export type FindingKey =
  | "partial-period"
  | "trend-decline"
  | "trend-growth"
  | "real-concentration"
  | "price-driven-leader"
  | "seasonality"
  | "holiday";

// A risk is a deterministically-derived, gated statement of something genuinely wrong/notable.
// The AI may rephrase `text` but may NOT add a risk whose key is absent here.
export type Risk = { key: FindingKey; severity: "low" | "medium" | "high"; text: string };

// A recommendation basis is the only ground on which the AI may build an action. A category
// with no basis here gets NO recommendation — the AI must not manufacture one.
export type RecommendationBasis = { key: FindingKey; text: string };

export type Findings = {
  rowCount: number;
  valueLabel: string; // which metric the verdicts are about (e.g. "revenue")
  total: number;
  periodSeries: { label: string; value: number }[];
  periodCompleteness: PeriodCompletenessVerdict;
  // True when the final period is a fragment (truncated month). When set, no surface may
  // narrate the last-vs-prior change as a trend/decline/growth — it is not comparable.
  latestPeriodPartial: boolean;
  trend: TrendVerdict;
  category: CategoryVerdict;
  seasonality: SeasonalityVerdict;
  holiday: HolidayVerdict;
  entitySignals: EntitySignalsVerdict; // which items are genuinely exceptional (FDR-corrected)
  // The ONLY risks/recommendations any narrated surface may state. Derived from the gated
  // verdicts above, never from raw rows — this is what demotes the AI from analyst to translator.
  risks: Risk[];
  recommendationBases: RecommendationBasis[];
};

// Derive the risk/recommendation ledger from the already-gated verdicts. Each entry is tied to
// a verdict that cleared its significance + effect-size gate, so a "risk" can never come from a
// raw value being high or a range being wide — only from a flagged finding.
export function deriveRisksAndRecommendations(
  f: Pick<
    Findings,
    "valueLabel" | "trend" | "category" | "seasonality" | "holiday" | "latestPeriodPartial" | "periodSeries" | "periodCompleteness"
  >,
): { risks: Risk[]; recommendationBases: RecommendationBasis[] } {
  const risks: Risk[] = [];
  const recommendationBases: RecommendationBasis[] = [];
  const label = f.valueLabel;

  if (f.latestPeriodPartial) {
    const lastLabel = f.periodSeries[f.periodSeries.length - 1]?.label ?? "the final period";
    const cov = f.periodCompleteness.lastEvidence?.coverage ?? 0;
    risks.push({
      key: "partial-period",
      severity: "low",
      text: `The latest period (${lastLabel}) is incomplete — it spans only ~${Math.round(cov * 100)}% of a typical period, so its lower value is a coverage artifact, not a decline, and is not comparable to full periods.`,
    });
    recommendationBases.push({
      key: "partial-period",
      text: `Exclude or clearly flag the incomplete final period before reporting any period-over-period change.`,
    });
  }

  if (f.trend.isSignificant && f.trend.direction === "down") {
    const pct = `${(f.trend.magnitude * 100).toFixed(0)}%`;
    risks.push({
      key: "trend-decline",
      severity: "high",
      text: `${label} shows a statistically real downward trend (${pct} start-to-end, ${f.trend.method}).`,
    });
    recommendationBases.push({
      key: "trend-decline",
      text: `Investigate the real downward trend in ${label}.`,
    });
  }

  if (f.trend.isSignificant && f.trend.direction === "up") {
    recommendationBases.push({
      key: "trend-growth",
      text: `Build on the statistically real upward trend in ${label}.`,
    });
  }

  if (f.category.isSignificant && !f.category.volumeUniform && f.category.volumeLeader) {
    risks.push({
      key: "real-concentration",
      severity: "medium",
      text: `Volume is concentrated in "${f.category.volumeLeader}", which genuinely outsells the rest.`,
    });
    recommendationBases.push({
      key: "real-concentration",
      text: `Reduce dependence on "${f.category.volumeLeader}" by growing demand for other items.`,
    });
  }

  if (f.category.priceDriven && f.category.revenueLeader) {
    risks.push({
      key: "price-driven-leader",
      severity: "low",
      text: `"${f.category.revenueLeader}" leads revenue only on unit price, not demand — its revenue rank overstates how popular it is.`,
    });
    recommendationBases.push({
      key: "price-driven-leader",
      text: `Treat "${f.category.revenueLeader}" as a price-driven leader, not a demand driver; do not plan an upsell around its volume.`,
    });
  }

  if (f.seasonality.month.isSignificant || f.seasonality.dayOfWeek.isSignificant) {
    const high = f.seasonality.month.isSignificant ? f.seasonality.month.high : f.seasonality.dayOfWeek.high;
    recommendationBases.push({
      key: "seasonality",
      text: `Plan around the real seasonal pattern${high ? ` (peak ${high})` : ""}.`,
    });
  }

  if (f.holiday.isSignificant) {
    recommendationBases.push({
      key: "holiday",
      text: `Plan around the detected holiday lift.`,
    });
  }

  return { risks, recommendationBases };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Common fixed-date holidays plus US Thanksgiving for the years present in the data.
// Deterministic so tests and the holiday verdict agree on the same calendar.
export function defaultHolidays(years: number[]): string[] {
  const out: string[] = [];
  for (const y of years) {
    out.push(`${y}-01-01`, `${y}-02-14`, `${y}-07-04`, `${y}-10-31`, `${y}-12-25`);
    // 4th Thursday of November.
    const nov1 = new Date(y, 10, 1);
    const firstThu = ((4 - nov1.getDay() + 7) % 7) + 1;
    out.push(isoDate(new Date(y, 10, firstThu + 21)));
  }
  return out;
}

export function buildFindings(
  rows: Record<string, string>[],
  mapping: FindingsMapping,
): Findings {
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  const dateCol = mapping.date || "";
  const productCol = mapping.product || "";
  const qtyCol = mapping.quantity || "";
  const valueLabel = mapping.revenue ? "revenue" : mapping.quantity ? "quantity" : mapping.cost ? "cost" : "value";

  // Daily totals (for trend / seasonality / holiday) and per-month / per-weekday groups.
  const dailyTotals = new Map<string, number>(); // ISO date -> summed value
  const monthKeyTotals = new Map<string, number>(); // YYYY-MM -> summed value (chronological trend)
  // Per-month metadata for the partial-period (completeness) verdict: observation count and
  // the first/last calendar day with data, so we can measure both volume and coverage.
  const monthMeta = new Map<
    string,
    { count: number; minDay: number; maxDay: number; year: number; month: number }
  >();
  const years = new Set<number>();

  // Per-item volume and price for the category verdict.
  const qtyByItem: Record<string, number> = {};
  const valueByItem: Record<string, number> = {}; // summed metric per item, for entity-outlier test
  const priceSamples: Record<string, Set<number>> = {};
  const priceList: Record<string, number[]> = {};

  let total = 0;
  let validRows = 0;

  // Day-first inference for the mapped date column, computed once (see metrics.inferDayFirst).
  const dayFirst = dateCol ? inferDayFirst(rows, dateCol) : undefined;

  for (const row of rows) {
    const value = valueCol ? toNumber(row[valueCol]) : NaN;
    const hasValue = Number.isFinite(value) && (valueCol ? String(row[valueCol] ?? "").trim() !== "" : false);
    if (valueCol && !hasValue) continue;

    // Canonical row universe: when a date column is mapped, a row whose date does not parse is
    // excluded from the ledger too — so findings.total / rowCount match the dashboard's
    // canonicalRows exactly (they used to diverge, which the cross-foot gate now guards against).
    const parsedDate = dateCol ? parseValidDate(row[dateCol], dayFirst) : null;
    if (dateCol && !parsedDate) continue;

    const v = hasValue ? value : 0;
    total += v;
    validRows += 1;

    if (dateCol) {
      const d = parsedDate;
      if (d) {
        const iso = isoDate(d);
        dailyTotals.set(iso, (dailyTotals.get(iso) ?? 0) + v);
        const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthKeyTotals.set(mk, (monthKeyTotals.get(mk) ?? 0) + v);
        const day = d.getDate();
        const meta = monthMeta.get(mk);
        if (meta) {
          meta.count += 1;
          if (day < meta.minDay) meta.minDay = day;
          if (day > meta.maxDay) meta.maxDay = day;
        } else {
          monthMeta.set(mk, { count: 1, minDay: day, maxDay: day, year: d.getFullYear(), month: d.getMonth() });
        }
        years.add(d.getFullYear());
      }
    }

    if (productCol) {
      const item = String(row[productCol] ?? "").trim();
      // Skip missing-data sentinels (ERROR/UNKNOWN/blank/N/A) so junk pseudo-categories
      // don't distort the volume distribution — consistent with the rest of the app.
      if (item && !isInvalidCategory(item)) {
        const qty = qtyCol ? toNumber(row[qtyCol]) : 1;
        const qtyValid = Number.isFinite(qty) && qty > 0;
        qtyByItem[item] = (qtyByItem[item] ?? 0) + (qtyValid ? qty : 1);
        valueByItem[item] = (valueByItem[item] ?? 0) + v;
        // Unit price = value / quantity when a valid quantity is present; the raw value
        // when there is no quantity column. When a quantity column exists but THIS cell is
        // junk (ERROR/blank), skip the sample — don't misread the full total as a unit price.
        const unit = qtyCol ? (qtyValid ? v / qty : null) : v;
        if (unit != null && Number.isFinite(unit) && unit > 0) {
          const rounded = Math.round(unit * 100) / 100;
          (priceSamples[item] ??= new Set()).add(rounded);
          (priceList[item] ??= []).push(rounded);
        }
      }
    }
  }

  // Chronological period series (all periods, for display).
  const periodSeries = [...monthKeyTotals.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));

  // Per-period observations for the completeness verdict — same chronological order, with
  // coverage = (last day with data − first day + 1) / days in that month. A truncated final
  // month (data through the 20th of 31) yields coverage ≈ 0.65; a late-starting ramp-up month
  // yields the same via a high minDay.
  const periodObs: PeriodObservation[] = periodSeries.map((p) => {
    const meta = monthMeta.get(p.label);
    if (!meta) return { label: p.label, value: p.value, count: 0, coverage: 0 };
    const daysInMonth = new Date(meta.year, meta.month + 1, 0).getDate();
    const coverage = (meta.maxDay - meta.minDay + 1) / daysInMonth;
    return { label: p.label, value: p.value, count: meta.count, coverage };
  });
  const completeness = periodCompleteness(periodObs);

  // Month keys that are partial endpoints — excluded from the seasonality fit so a half-month
  // doesn't masquerade as a low/high season.
  const partialMonthKeys = new Set<string>();
  if (completeness.partialFirst && periodSeries.length > 0) partialMonthKeys.add(periodSeries[0].label);
  if (completeness.partialLast && periodSeries.length > 0)
    partialMonthKeys.add(periodSeries[periodSeries.length - 1].label);

  // Seasonality groups — two grains (see verdicts.ts `anova`):
  //  • MONTH test: one observation per complete calendar month (monthly total), bucketed by
  //    month-of-year. `completeYears` counts the distinct years that contribute a complete month;
  //    the month test only runs with ≥2, so a single December cannot masquerade as a season.
  //  • WEEKDAY test: daily totals bucketed by weekday (the day is weekday's natural period).
  // Both skip days/months inside a partial endpoint month (full periods only).
  const monthTotalsByMonth: Record<string, number[]> = {};
  const completeYearSet = new Set<number>();
  for (const [mk, tot] of monthKeyTotals.entries()) {
    if (partialMonthKeys.has(mk)) continue;
    const year = Number(mk.slice(0, 4));
    const monthIdx = Number(mk.slice(5, 7)) - 1;
    (monthTotalsByMonth[MONTH_NAMES[monthIdx]] ??= []).push(tot);
    completeYearSet.add(year);
  }
  const completeYears = completeYearSet.size;

  const byDayOfWeek: Record<string, number[]> = {};
  for (const [iso, val] of dailyTotals.entries()) {
    const d = new Date(iso);
    const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (partialMonthKeys.has(mk)) continue;
    (byDayOfWeek[WEEKDAY_NAMES[d.getDay()]] ??= []).push(val);
  }

  // Price info for the category verdict.
  const priceByItem: Record<string, PriceInfo> = {};
  for (const item of Object.keys(qtyByItem)) {
    const samples = priceList[item] ?? [];
    const distinctPrices = priceSamples[item]?.size ?? 0;
    const price = samples.length > 0 ? samples.reduce((s, x) => s + x, 0) / samples.length : 0;
    priceByItem[item] = { distinctPrices, price };
  }

  const dailySeries = [...dailyTotals.entries()].map(([date, value]) => ({ date, value }));
  const holidayCalendar = defaultHolidays([...years]);

  const base = {
    rowCount: validRows,
    valueLabel,
    total,
    periodSeries,
    periodCompleteness: completeness,
    latestPeriodPartial: completeness.partialLast,
    // Trend fits the COMPLETE periods only — a partial first/last month is excluded so a
    // truncated endpoint can't manufacture or mask a trend.
    trend: trend(completeness.fullPeriods.map((p) => p.value)),
    category: categorySignal(qtyByItem, priceByItem),
    seasonality: seasonality(monthTotalsByMonth, byDayOfWeek, completeYears),
    holiday: holidayLift(dailySeries, holidayCalendar),
    entitySignals: entityOutliers(valueByItem),
  };

  // The risk/recommendation ledger is derived from the gated verdicts above — the single
  // author of every conclusion a narrated surface is allowed to state.
  const { risks, recommendationBases } = deriveRisksAndRecommendations(base);

  return { ...base, risks, recommendationBases };
}
