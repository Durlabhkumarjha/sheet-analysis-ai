// Layer 1 — the statistics verdict engine. Pure functions that decide whether a
// pattern is real signal or sampling noise. Each returns a structured verdict so
// downstream layers (Findings ledger, narration contract, linter) can gate language
// on `isSignificant` rather than re-deciding from raw numbers.

import {
  benjaminiHochberg,
  chiSquareP,
  fDistributionP,
  mean,
  median,
  normalTwoSidedP,
  stdDev,
} from "./stats";

// Every tunable lives here. No significance/effect-size magic numbers inline anywhere
// in the engine — change behavior by editing a threshold and documenting why.
export const THRESHOLDS = {
  // Mann-Kendall two-sided p below this is required to call a series a real trend.
  trendP: 0.05,
  // Control-limit width (in sigmas) for SPC / holiday checks.
  spcSigma: 2,
  // ANOVA/Kruskal p below this is required to call month/weekday variation seasonal.
  seasonalityP: 0.05,
  // A holiday must lift the window mean by at least this fraction of baseline...
  holidayEffect: 0.15,
  // ...AND push the window mean outside baseline mean ± (holidaySigma * baseline sd).
  holidaySigma: 2,
  // Chi-square goodness-of-fit p below this means item volumes are non-uniform.
  categoryP: 0.05,
  // ...AND the top category must total at least this multiple of the bottom category
  // (max/min ratio). Significance alone flags trivial gaps on large n; this effect-size
  // floor keeps a 9% wobble "uniform" while a 5× real difference clears it easily.
  categoryEffectFloor: 1.2,
  // Seasonal/weekday variation must clear seasonalityP AND explain at least this share
  // of total variance (η² = SS_between / SS_total). 0.01 = 1%, well below a real 40%
  // weekend lift but above the ~0.0005 η² of pure noise.
  seasonEffectFloor: 0.01,
  // Per-entity outlier test (which products/regions are genuinely exceptional).
  // FDR level for the Benjamini-Hochberg correction applied across all entities at once.
  entityAlpha: 0.05,
  // ...AND an entity must differ from the median by at least this ratio (value/median for a
  // high, median/value for a low). Stops a barely-significant 10% gap from being called a
  // "winner" while a genuine 2× leader clears it. Mirrors categoryEffectFloor in spirit.
  entityEffectFloor: 1.5,
  // Need at least this many entities before multiple-comparison testing is meaningful.
  minEntitiesForOutlier: 4,
  // A leading/trailing period is "partial" when its observation count is below this
  // fraction of the interior-period median OR its data spans less than this fraction of
  // the calendar unit. Partial endpoints are excluded from trend/forecast/seasonality and
  // never narrated as a decline/growth — a truncated last month is not a real drop.
  partialPeriodFloor: 0.7,
  // Minimum number of periods before a trend test is meaningful.
  minPeriodsForTrend: 4,
  // Minimum groups and per-group observations before a seasonality test runs.
  minSeasonGroups: 2,
  minPerSeasonGroup: 2,
  // Trailing window (days) used as the holiday baseline.
  holidayBaselineDays: 28,
  // ---- Semantic (column-role) guards — not statistical, but tunable in one place. ----
  // A field may be tiered/ranked/share-computed only if it behaves like a bounded category.
  // Above this many distinct values it is treated as an identifier / free-text key, never an
  // "item" dimension (e.g. a 25k-distinct location or 40k-distinct customer column on a 50k-row
  // file). Domain-agnostic: judged purely by cardinality shape, never by column name.
  maxTierDimensionCardinality: 1000,
  // ...AND its distinct/row ratio must stay below this — a field with ~one value per row is an
  // identifier regardless of absolute count.
  maxTierUniqueRatio: 0.5,
  // Minimum distinct values before tiering/Pareto is meaningful at all.
  minTierDimensionCardinality: 8,
} as const;

export type Direction = "up" | "down" | "flat";

export type TrendVerdict = {
  kind: "trend";
  isSignificant: boolean;
  direction: Direction;
  magnitude: number; // overall start-to-end change as a fraction (0.05 = +5%)
  method: string;
  detail: string;
  label: "upward trend" | "downward trend" | "normal variation";
  p: number;
};

export type CategoryVerdict = {
  kind: "category";
  isSignificant: boolean; // true when volumes are significantly non-uniform
  volumeUniform: boolean;
  revenueLeader: string | null;
  volumeLeader: string | null;
  leaderFixedPrice: boolean;
  priceDriven: boolean; // revenue lead comes from unit price, not demand
  method: string;
  detail: string;
  p: number;
};

export type SeasonVerdict = {
  isSignificant: boolean;
  // "insufficient" = the test could not be run for lack of data (e.g. < 2 complete years for
  // the month grain). It is NOT the same as "none" (tested, no pattern) — narration must say
  // "not enough data to test", never "no seasonality".
  label: "none" | "detected" | "insufficient";
  high: string | null;
  low: string | null;
  method: string;
  detail: string;
  p: number;
};

export type SeasonalityVerdict = {
  kind: "seasonality";
  month: SeasonVerdict;
  dayOfWeek: SeasonVerdict;
};

export type HolidayVerdict = {
  kind: "holiday";
  isSignificant: boolean;
  label: "lift" | "no_lift";
  hits: { date: string; lift: number; significant: boolean }[];
  method: string;
  detail: string;
};

// ---------------------------------------------------------------------------
// Trend: Mann-Kendall for direction/significance + an SPC noise-band guard.
// ---------------------------------------------------------------------------
export function trend(series: number[]): TrendVerdict {
  const n = series.length;
  const flat = (detail: string, p = 1): TrendVerdict => ({
    kind: "trend",
    isSignificant: false,
    direction: "flat",
    magnitude: 0,
    method: "Mann-Kendall + SPC",
    detail,
    label: "normal variation",
    p,
  });

  if (n < THRESHOLDS.minPeriodsForTrend) {
    return flat(`Only ${n} periods — too few to test a trend.`);
  }

  // Mann-Kendall S statistic and its normal-approximation variance.
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      s += Math.sign(series[j] - series[i]);
    }
  }
  // Variance with tie correction.
  const counts = new Map<number, number>();
  for (const v of series) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of counts.values()) tieTerm += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  let z = 0;
  if (varS > 0) {
    if (s > 0) z = (s - 1) / Math.sqrt(varS);
    else if (s < 0) z = (s + 1) / Math.sqrt(varS);
  }
  const p = varS > 0 ? normalTwoSidedP(z) : 1;

  // SPC noise band via detrending: fit an OLS line, then compare the modelled net
  // change against the scatter of points around that line. A genuine trend moves the
  // series by far more than its own residual noise; random walk does not. (Using the
  // residual band rather than per-step variance avoids a single outlier period — e.g.
  // a December spike — vetoing an otherwise clean monotonic trend.)
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += series[i]; sxy += i * series[i]; sxx += i * i;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / n;
  const residuals = series.map((v, i) => v - (intercept + slope * i));
  const residualStd = stdDev(residuals);
  const netChange = Math.abs(slope) * (n - 1);
  const moveExceedsNoise =
    residualStd === 0 ? netChange !== 0 : netChange > THRESHOLDS.spcSigma * residualStd;

  const first = series[0];
  // Magnitude is the FITTED net change (slope × span) as a fraction of the start level, so its
  // sign always matches the trend direction below. Using raw last−first let a rise-then-crash
  // series report a negative magnitude while Mann-Kendall called the direction "up".
  const magnitude = first !== 0 ? (slope * (n - 1)) / Math.abs(first) : 0;

  const isSignificant = p < THRESHOLDS.trendP && moveExceedsNoise;
  if (!isSignificant) {
    const seriesMean = mean(series);
    const cv = seriesMean !== 0 ? stdDev(series) / Math.abs(seriesMean) : 0;
    return flat(
      `Mann-Kendall p=${p.toFixed(3)} (need <${THRESHOLDS.trendP}); ` +
        `net change ${netChange.toFixed(2)} within ±${THRESHOLDS.spcSigma}σ residual band; ` +
        `series CV ${(cv * 100).toFixed(1)}%. No real trend.`,
      p,
    );
  }

  // Direction from the fitted slope so it agrees with `magnitude`; for a significant trend the
  // slope and Mann-Kendall S sign coincide (a near-zero slope fails the SPC noise-band gate above).
  const direction: Direction = slope >= 0 ? "up" : "down";
  return {
    kind: "trend",
    isSignificant: true,
    direction,
    magnitude,
    method: "Mann-Kendall + SPC",
    detail:
      `Mann-Kendall p=${p.toFixed(3)} (<${THRESHOLDS.trendP}); net change ${netChange.toFixed(2)} ` +
      `exceeds ±${THRESHOLDS.spcSigma}σ residual band. Real ${direction === "up" ? "upward" : "downward"} trend.`,
    label: direction === "up" ? "upward trend" : "downward trend",
    p,
  };
}

// ---------------------------------------------------------------------------
// Category: chi-square goodness-of-fit on volumes + fixed-price detection.
// ---------------------------------------------------------------------------
export type PriceInfo = { distinctPrices: number; price: number };

export function categorySignal(
  quantityByItem: Record<string, number>,
  priceByItem: Record<string, PriceInfo>,
): CategoryVerdict {
  const items = Object.keys(quantityByItem);
  const base = (detail: string): CategoryVerdict => ({
    kind: "category",
    isSignificant: false,
    volumeUniform: true,
    revenueLeader: null,
    volumeLeader: null,
    leaderFixedPrice: false,
    priceDriven: false,
    method: "chi-square goodness-of-fit",
    detail,
    p: 1,
  });

  if (items.length < 2) return base("Fewer than 2 items — nothing to compare.");

  const quantities = items.map((i) => quantityByItem[i]);
  const total = quantities.reduce((s, q) => s + q, 0);
  if (total <= 0) return base("No quantities to compare.");

  const k = items.length;
  const expected = total / k;
  const chi2 = quantities.reduce((s, q) => s + (q - expected) ** 2 / expected, 0);
  const p = chiSquareP(chi2, k - 1);

  // Dual gate: a real volume winner needs both statistical significance AND a meaningful
  // effect size. Effect size = max/min ratio of category totals. On large n, chi-square
  // declares a 9% wobble "significant" (p≈0); the ratio floor vetoes that as noise.
  const maxQ = Math.max(...quantities);
  const minQ = Math.min(...quantities);
  const effectRatio = minQ > 0 ? maxQ / minQ : Infinity;
  const isRealVolumeWinner =
    p < THRESHOLDS.categoryP && effectRatio >= THRESHOLDS.categoryEffectFloor;
  const volumeUniform = !isRealVolumeWinner;

  // Revenue per item = quantity × mean unit price.
  const revenueByItem = items.map((i) => ({
    item: i,
    revenue: quantityByItem[i] * (priceByItem[i]?.price ?? 0),
    qty: quantityByItem[i],
  }));
  const revenueLeader = [...revenueByItem].sort((a, b) => b.revenue - a.revenue)[0]?.item ?? null;
  const volumeLeader = [...revenueByItem].sort((a, b) => b.qty - a.qty)[0]?.item ?? null;
  const leaderFixedPrice =
    revenueLeader != null && (priceByItem[revenueLeader]?.distinctPrices ?? 0) === 1;

  // The revenue lead is price-driven when the leader does not win on volume
  // (volumes are uniform OR a different item moves the most units) and the leader
  // carries a single fixed price — i.e. it ranks #1 on revenue purely via its price.
  const priceDriven =
    revenueLeader != null &&
    leaderFixedPrice &&
    (volumeUniform || revenueLeader !== volumeLeader);

  const detail = volumeUniform
    ? `Volumes are effectively uniform (chi-square p=${p.toFixed(3)}, max/min ${effectRatio.toFixed(2)} < ${THRESHOLDS.categoryEffectFloor} floor). ` +
      (priceDriven
        ? `"${revenueLeader}" leads revenue only because of its unit price, not demand.`
        : `No item wins on demand.`)
    : `Volumes are non-uniform (chi-square p=${p.toFixed(3)} < ${THRESHOLDS.categoryP}, max/min ${effectRatio.toFixed(2)} ≥ ${THRESHOLDS.categoryEffectFloor}). ` +
      `"${volumeLeader}" genuinely outsells the rest.`;

  return {
    kind: "category",
    isSignificant: !volumeUniform,
    volumeUniform,
    revenueLeader,
    volumeLeader,
    leaderFixedPrice,
    priceDriven,
    method: "chi-square goodness-of-fit",
    detail,
    p,
  };
}

// ---------------------------------------------------------------------------
// Seasonality: one-way ANOVA across month groups and weekday groups.
//
// METHOD (two-grain — the unit of observation matches the period being tested):
//   • MONTH test runs on MONTHLY TOTALS (one observation per complete calendar month), grouped
//     by month-of-year (Jan…Dec). A "December effect" is a property of months, so the month IS
//     the observation. This requires ≥2 complete years; with one year each month bucket holds a
//     single, autocorrelated observation that cannot separate a real season from a one-off, so
//     the month verdict is "insufficient" (handled in `seasonality()` before this runs).
//   • WEEKDAY test runs on DAILY TOTALS grouped by weekday — the day IS weekday's natural grain,
//     and a year supplies ~52 weekly replicates per weekday, which is plenty of power.
// We deliberately do NOT use per-transaction rows (which inflate N and make ANOVA flag trivial
// differences). The η² floor below vetoes any statistically-significant-but-tiny effect
// regardless of N. A `sparseLabel` lets the month grain report "insufficient" (not "none") when
// the groups are too thin to test.
// ---------------------------------------------------------------------------
function anova(groups: Record<string, number[]>, sparseLabel: "none" | "insufficient" = "none"): SeasonVerdict {
  const keys = Object.keys(groups).filter((k) => groups[k].length >= THRESHOLDS.minPerSeasonGroup);
  const none = (detail: string, p = 1): SeasonVerdict => ({
    isSignificant: false,
    label: "none",
    high: null,
    low: null,
    method: "one-way ANOVA",
    detail,
    p,
  });
  const sparse = (detail: string): SeasonVerdict =>
    sparseLabel === "insufficient" ? insufficientSeason(detail) : none(detail);

  if (keys.length < THRESHOLDS.minSeasonGroups) {
    return sparse(`Only ${keys.length} usable groups — too few to test seasonality.`);
  }

  const all: number[] = [];
  for (const k of keys) all.push(...groups[k]);
  const grandMean = mean(all);
  const N = all.length;
  const k = keys.length;

  let ssBetween = 0;
  let ssWithin = 0;
  for (const key of keys) {
    const g = groups[key];
    const gm = mean(g);
    ssBetween += g.length * (gm - grandMean) ** 2;
    for (const v of g) ssWithin += (v - gm) ** 2;
  }
  const dfBetween = k - 1;
  const dfWithin = N - k;
  if (dfWithin <= 0 || ssWithin === 0) {
    return sparse("Not enough within-group variation to run ANOVA.");
  }
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const f = msBetween / msWithin;
  const p = fDistributionP(f, dfBetween, dfWithin);

  // Dual gate: significance (p) AND effect size (η² = variance explained by group).
  // On large n, ANOVA flags a sub-1% η² as "significant"; the η² floor vetoes that noise.
  const ssTotal = ssBetween + ssWithin;
  const eta2 = ssTotal > 0 ? ssBetween / ssTotal : 0;
  const isReal = p < THRESHOLDS.seasonalityP && eta2 >= THRESHOLDS.seasonEffectFloor;

  if (!isReal) {
    return none(
      `ANOVA F=${f.toFixed(2)}, p=${p.toFixed(3)}, η²=${eta2.toFixed(4)} ` +
        `(need p<${THRESHOLDS.seasonalityP} AND η²≥${THRESHOLDS.seasonEffectFloor}). No real seasonal pattern.`,
      p,
    );
  }

  const groupMeans = keys.map((key) => ({ key, m: mean(groups[key]) }));
  groupMeans.sort((a, b) => b.m - a.m);
  return {
    isSignificant: true,
    label: "detected",
    high: groupMeans[0].key,
    low: groupMeans[groupMeans.length - 1].key,
    method: "one-way ANOVA",
    detail: `ANOVA F=${f.toFixed(2)}, p=${p.toFixed(3)} < ${THRESHOLDS.seasonalityP}, η²=${eta2.toFixed(4)} ≥ ${THRESHOLDS.seasonEffectFloor}. Real variation; highest ${groupMeans[0].key}, lowest ${groupMeans[groupMeans.length - 1].key}.`,
    p,
  };
}

// A month/weekday verdict for the case where the test simply could not be run. Distinct from
// "none" so narration says "not enough data to test" rather than "no seasonal pattern".
function insufficientSeason(detail: string): SeasonVerdict {
  return {
    isSignificant: false,
    label: "insufficient",
    high: null,
    low: null,
    method: "one-way ANOVA",
    detail,
    p: 1,
  };
}

// Minimum complete years before the month grain can be tested at all. With one cycle, a single
// elevated month is an anecdote, not an established pattern.
export const MIN_COMPLETE_YEARS_FOR_MONTH = 2;

export function seasonality(
  monthTotalsByMonth: Record<string, number[]>,
  byDayOfWeek: Record<string, number[]>,
  completeYears: number,
): SeasonalityVerdict {
  const month =
    completeYears < MIN_COMPLETE_YEARS_FOR_MONTH
      ? insufficientSeason(
          `Only ${completeYears} complete year${completeYears === 1 ? "" : "s"} of data — need ≥${MIN_COMPLETE_YEARS_FOR_MONTH} to test month-over-month seasonality. Cannot distinguish a seasonal month from a one-off.`,
        )
      : anova(monthTotalsByMonth, "insufficient");
  return {
    kind: "seasonality",
    month,
    dayOfWeek: anova(byDayOfWeek, "none"),
  };
}

// ---------------------------------------------------------------------------
// Holiday lift: window mean vs trailing baseline, gated on effect AND control limits.
// ---------------------------------------------------------------------------
export function holidayLift(
  dailySeries: { date: string; value: number }[],
  holidayCalendar: string[],
): HolidayVerdict {
  const byDate = new Map<string, number>();
  for (const d of dailySeries) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.value);
  const sortedDates = [...byDate.keys()].sort();

  const hits: { date: string; lift: number; significant: boolean }[] = [];
  for (const holiday of holidayCalendar) {
    const windowVal = byDate.get(holiday);
    if (windowVal == null) continue;
    const hDate = new Date(holiday).getTime();
    if (Number.isNaN(hDate)) continue;
    // Trailing baseline: the holidayBaselineDays days immediately before the holiday.
    const baseline: number[] = [];
    for (const d of sortedDates) {
      const t = new Date(d).getTime();
      const ageDays = (hDate - t) / 86_400_000;
      if (ageDays > 0 && ageDays <= THRESHOLDS.holidayBaselineDays) baseline.push(byDate.get(d)!);
    }
    if (baseline.length < 3) continue;
    const baseMean = mean(baseline);
    const baseSd = stdDev(baseline);
    if (baseMean <= 0) continue;
    const lift = (windowVal - baseMean) / baseMean;
    const outsideControl = windowVal > baseMean + THRESHOLDS.holidaySigma * baseSd;
    const significant = lift >= THRESHOLDS.holidayEffect && outsideControl;
    hits.push({ date: holiday, lift, significant });
  }

  const anySignificant = hits.some((h) => h.significant);
  return {
    kind: "holiday",
    isSignificant: anySignificant,
    label: anySignificant ? "lift" : "no_lift",
    hits,
    method: "window vs trailing baseline + control limits",
    detail: anySignificant
      ? `Holiday lift detected on ${hits.filter((h) => h.significant).map((h) => h.date).join(", ")}.`
      : hits.length === 0
        ? "No holidays present in the data window."
        : `No holiday cleared both the ${(THRESHOLDS.holidayEffect * 100).toFixed(0)}% effect and ±${THRESHOLDS.holidaySigma}σ control limits.`,
  };
}

export function medianOf(xs: number[]): number {
  return median(xs);
}

// ---------------------------------------------------------------------------
// Per-entity outliers: which entities (products/regions/customers) are genuinely
// exceptional vs the pack — corrected for multiple comparisons.
// ---------------------------------------------------------------------------
export type EntitySide = "high" | "low" | "none";
export type EntitySignal = {
  entity: string;
  value: number;
  z: number;
  p: number;
  significant: boolean;
  side: EntitySide;
};
export type EntitySignalsVerdict = {
  kind: "entitySignals";
  method: string;
  alpha: number;
  results: EntitySignal[];
  highs: string[]; // entities significantly above the pack (corrected)
  lows: string[]; // entities significantly below the pack (corrected)
  anySignificant: boolean;
};

// Decide which entities stand out from the rest, gating on BOTH a multiple-comparison-
// corrected p-value (Benjamini-Hochberg over all entities) AND an effect-size floor. We
// score each entity by a robust z (deviation from the median in MAD units) so a single
// extreme value can't inflate the spread and mask everything else. Without the BH step,
// "X is the standout product" fires by chance on any wide catalog; without the effect
// floor, a trivially-significant gap on large n reads as a real winner.
export function entityOutliers(valueByEntity: Record<string, number>): EntitySignalsVerdict {
  const entities = Object.keys(valueByEntity);
  const empty = (): EntitySignalsVerdict => ({
    kind: "entitySignals",
    method: "robust z (median/MAD) + Benjamini-Hochberg FDR",
    alpha: THRESHOLDS.entityAlpha,
    results: [],
    highs: [],
    lows: [],
    anySignificant: false,
  });

  if (entities.length < THRESHOLDS.minEntitiesForOutlier) return empty();

  const values = entities.map((e) => valueByEntity[e]);
  const med = median(values);
  const mad = median(values.map((v) => Math.abs(v - med)));
  const scale = 1.4826 * mad; // MAD → σ for a normal distribution
  if (scale <= 0) return empty(); // no spread → nobody is an outlier

  const zs = values.map((v) => (v - med) / scale);
  const ps = zs.map((z) => normalTwoSidedP(z));
  const sig = benjaminiHochberg(ps, THRESHOLDS.entityAlpha);

  const results: EntitySignal[] = entities.map((entity, i) => {
    const value = values[i];
    const ratioHigh = med > 0 ? value / med : Infinity;
    const ratioLow = value > 0 ? med / value : Infinity;
    const effectHigh = zs[i] > 0 && ratioHigh >= THRESHOLDS.entityEffectFloor;
    const effectLow = zs[i] < 0 && ratioLow >= THRESHOLDS.entityEffectFloor;
    const significant = sig[i] && (effectHigh || effectLow);
    const side: EntitySide = !significant ? "none" : zs[i] > 0 ? "high" : "low";
    return { entity, value, z: zs[i], p: ps[i], significant, side };
  });

  const highs = results.filter((r) => r.side === "high").map((r) => r.entity);
  const lows = results.filter((r) => r.side === "low").map((r) => r.entity);
  return {
    kind: "entitySignals",
    method: "robust z (median/MAD) + Benjamini-Hochberg FDR",
    alpha: THRESHOLDS.entityAlpha,
    results,
    highs,
    lows,
    anySignificant: highs.length > 0 || lows.length > 0,
  };
}

// One time-bucket (e.g. a calendar month) summarised for the completeness check:
// how many observations it carries and what fraction of its calendar unit the data spans.
//   count    — number of rows that fell in this period
//   coverage — (last day with data − first day with data + 1) / days in the calendar unit,
//              in [0,1]. A month with rows only on the 1st–20th of 31 has coverage ≈ 0.65.
export type PeriodObservation = {
  label: string;
  value: number;
  count: number;
  coverage: number;
};

export type PeriodCompletenessVerdict = {
  kind: "periodCompleteness";
  // True when the FIRST / LAST period is a fragment of a real period (ramp-up or a
  // truncated final month), so it must be excluded from trend/forecast/seasonality and
  // never narrated as a decline or growth.
  partialFirst: boolean;
  partialLast: boolean;
  firstEvidence: { ratio: number; coverage: number } | null;
  lastEvidence: { ratio: number; coverage: number } | null;
  // The periods that ARE comparable — endpoints dropped only when partial. This is what
  // trend/forecast/seasonality should fit against.
  fullPeriods: { label: string; value: number }[];
  // Per-period calendar coverage (label -> coverage in [0,1]) for EVERY observed period, not
  // just the endpoints. Consumers (e.g. the audit adapter) read interior coverage from here
  // instead of assuming interior periods are always complete. Empty only when no periods.
  coverageByPeriod: Record<string, number>;
  // The interior-period median observation count used as the "typical period" baseline.
  typicalCount: number;
  method: string;
  detail: string;
};

// Decide whether the leading and/or trailing periods are partial. A period is partial when
// it carries far fewer observations than a typical (interior) period OR its data spans less
// than a fraction of the calendar unit — either signals a ramp-up first month or a truncated
// final month. We compare ONLY the endpoints against the median of the interior periods, so a
// single short month in the middle (a real dip) is never mistaken for incompleteness.
//
// Why this gate exists: a final month that only has data through the 20th will show a ~30%
// "drop" that is an artifact of truncation, not a real decline. Excluding partial endpoints
// from the trend fit, and refusing to narrate their last-vs-prior change as a decline, is the
// single fix for that class of false claim across every surface.
export function periodCompleteness(periods: PeriodObservation[]): PeriodCompletenessVerdict {
  const none = (detail: string): PeriodCompletenessVerdict => ({
    kind: "periodCompleteness",
    partialFirst: false,
    partialLast: false,
    firstEvidence: null,
    lastEvidence: null,
    fullPeriods: periods.map((p) => ({ label: p.label, value: p.value })),
    coverageByPeriod: Object.fromEntries(periods.map((p) => [p.label, p.coverage])),
    typicalCount: 0,
    method: "endpoint count ratio vs interior median + calendar coverage",
    detail,
  });

  // Need at least one interior period plus two endpoints to have a baseline to compare to.
  if (periods.length < 3) return none("too few periods to judge completeness");

  const floor = THRESHOLDS.partialPeriodFloor;
  const interior = periods.slice(1, -1);
  const medCount = median(interior.map((p) => p.count));
  if (medCount <= 0) return none("no interior observations to form a baseline");

  const first = periods[0];
  const last = periods[periods.length - 1];
  const firstRatio = first.count / medCount;
  const lastRatio = last.count / medCount;

  const partialFirst = firstRatio < floor || first.coverage < floor;
  const partialLast = lastRatio < floor || last.coverage < floor;

  const fullPeriods = periods
    .filter((p, i) => {
      if (i === 0 && partialFirst) return false;
      if (i === periods.length - 1 && partialLast) return false;
      return true;
    })
    .map((p) => ({ label: p.label, value: p.value }));

  const parts: string[] = [];
  if (partialFirst)
    parts.push(
      `first period "${first.label}" is partial (${Math.round(firstRatio * 100)}% of typical volume, ${Math.round(first.coverage * 100)}% calendar coverage)`,
    );
  if (partialLast)
    parts.push(
      `last period "${last.label}" is partial (${Math.round(lastRatio * 100)}% of typical volume, ${Math.round(last.coverage * 100)}% calendar coverage)`,
    );

  return {
    kind: "periodCompleteness",
    partialFirst,
    partialLast,
    firstEvidence: { ratio: firstRatio, coverage: first.coverage },
    lastEvidence: { ratio: lastRatio, coverage: last.coverage },
    fullPeriods,
    coverageByPeriod: Object.fromEntries(periods.map((p) => [p.label, p.coverage])),
    typicalCount: medCount,
    method: "endpoint count ratio vs interior median + calendar coverage",
    detail: parts.length ? parts.join("; ") : "all periods are complete",
  };
}
