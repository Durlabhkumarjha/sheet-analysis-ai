// Canonical metrics layer — the single source of truth for which rows count and how
// shares are computed. Every surface (dashboard, chart builder, AI report, Talk-to-Data
// rule path AND Worker/AI path) must route through these helpers so the same metric
// returns the identical dollar value and the identical percentage everywhere.

export const INVALID_BUCKET = "Missing/Invalid";

export function isInvalidCategory(val: string): boolean {
  if (!val) return true;
  const t = val.trim();
  if (!t) return true;
  const n = t.toLowerCase();
  return /^(error|unknown|n\/?a|#n\/?a|null|none|undefined|missing|invalid|#ref!|#value!|#div\/0!|#name\?|#num!|-|--|---)$/.test(n);
}

export function cleanCategory(val: string): string {
  return isInvalidCategory(val) ? INVALID_BUCKET : val.trim();
}

// True for any category label that represents junk/missing data and must never be shown
// as a real product/region/payment/customer or counted in a share denominator. Catches both
// the normalized INVALID_BUCKET and raw "ERROR"/"Unknown"/blank labels (e.g. from the AI path).
export function isJunkLabel(label: string | undefined | null): boolean {
  if (label == null) return true;
  return label === INVALID_BUCKET || isInvalidCategory(String(label));
}

export function toNumber(value: string): number {
  const cleaned = String(value ?? "").replace(/[$,%\s,]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : Number.NaN;
}

// A genuinely populated numeric cell. NOTE: toNumber("") returns 0 (finite), so a blank cell
// would otherwise count as a valid $0 value and inflate counts — require non-blank here.
export function hasNumericValue(raw: string | undefined): boolean {
  if (raw == null || String(raw).trim() === "") return false;
  return Number.isFinite(toNumber(raw));
}

// Numeric date like 5/8/2022, 16-05-2021, 06.05.21 — three integer fields with / - or . separators.
const NUMERIC_DATE_RE = /^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})$/;

function buildDate(year: number, month1: number, day: number): Date | null {
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  if (year < 100) year += year < 70 ? 2000 : 1900; // 2-digit year: 00-69 → 2000s, 70-99 → 1900s
  if (year < 1900 || year > 2100) return null;
  const d = new Date(year, month1 - 1, day);
  // Reject rollovers (e.g. 31 Feb → 2 Mar) so an impossible date is dropped, not silently shifted.
  if (d.getFullYear() !== year || d.getMonth() !== month1 - 1 || d.getDate() !== day) return null;
  return d;
}

// Parse a date string, correctly handling DAY-FIRST formats (DD/MM/YYYY, DD-MM-YY) that the
// native `new Date()` rejects or misreads. `dayFirst` resolves the genuinely ambiguous case
// (both fields ≤ 12): pass the column-level inference from `inferDayFirst`; when omitted we
// auto-detect per value (a field > 12 is unambiguous) and otherwise fall back to month-first.
export function parseValidDate(value: string | undefined, dayFirst?: boolean): Date | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "") return null;

  // ISO yyyy-mm-dd (and yyyy/mm/dd) — unambiguous, parse explicitly to avoid TZ surprises.
  const isoMatch = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(s);
  if (isoMatch) {
    return buildDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const m = NUMERIC_DATE_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    // Only treat the THIRD field as the year here (first-field years are the ISO case above).
    if (a > 12 && b <= 12) return buildDate(y, b, a); // first field is the day → day-first
    if (b > 12 && a <= 12) return buildDate(y, a, b); // second field is the day → month-first
    // Ambiguous (both ≤ 12): honour the column hint, else default month-first (US).
    return dayFirst ? buildDate(y, b, a) : buildDate(y, a, b);
  }

  // Fallback for month-name / ISO-datetime / other native-parseable formats.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  if (year < 1900 || year > 2100) return null;
  return d;
}

// Infer whether a date column is day-first by scanning for an unambiguous signal: any value
// whose first field exceeds 12 can only be a day. Returns true (day-first), false (month-first),
// or undefined (no evidence either way — callers then default to month-first).
export function inferDayFirst(rows: Record<string, string>[], dateCol: string): boolean | undefined {
  if (!dateCol) return undefined;
  let dayFirstHits = 0;
  let monthFirstHits = 0;
  for (const row of rows) {
    const s = String(row[dateCol] ?? "").trim();
    const m = NUMERIC_DATE_RE.exec(s);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirstHits += 1;
    else if (b > 12 && a <= 12) monthFirstHits += 1;
    if (dayFirstHits >= 5 && dayFirstHits > monthFirstHits * 4) return true;
  }
  if (dayFirstHits === 0 && monthFirstHits === 0) return undefined;
  return dayFirstHits > monthFirstHits;
}

// THE single row filter. A row is canonical (in-period, analyzable) when its primary value
// column is a populated number AND, if a date column is mapped, the date parses. This is the
// only place row inclusion is decided — analyzeData, the chart builder, and the AI/Worker code
// path all run on the output of this function so they share one row universe.
export function canonicalRows(
  rows: Record<string, string>[],
  mapping: Record<string, string | undefined>
): Record<string, string>[] {
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  const dateCol = mapping.date || "";
  const dayFirst = dateCol ? inferDayFirst(rows, dateCol) : undefined;
  return rows.filter((row) => {
    if (valueCol && !hasNumericValue(row[valueCol])) return false;
    if (dateCol && !parseValidDate(row[dateCol], dayFirst)) return false;
    return true;
  });
}

// THE single share-denominator helper. The denominator for a dimension's percentages is that
// dimension's own identified total (junk/missing excluded) — NOT a global revenue figure and
// NOT another dimension's total. Product shares ÷ product total, region shares ÷ region total,
// etc. Falls back to `fallback` only when the dimension has no identified categories at all.
export function identifiedTotal(
  items: { label: string; revenue: number }[],
  fallback = 0
): number {
  const real = items.filter((it) => !isJunkLabel(it.label));
  if (real.length === 0) return fallback;
  return real.reduce((s, it) => s + it.revenue, 0);
}

// Share of a value within its dimension, as a percentage of that dimension's identified total.
export function dimensionShare(
  value: number,
  items: { label: string; revenue: number }[],
  fallbackTotal = 0
): number {
  const base = identifiedTotal(items, fallbackTotal);
  return base > 0 ? (value / base) * 100 : 0;
}

// The identified (non-junk) members of a ranked list, preserving order. Use for first/last/rank
// and for any display loop so "Missing/Invalid" is never rendered as a real category.
export function realItems<T extends { label: string }>(items: T[]): T[] {
  return items.filter((it) => !isJunkLabel(it.label));
}

// A share is a FRACTION in [0, 1]. Anything outside (within float tolerance) signals a
// double-scale bug (a value already ×100 fed back into a percent formatter) or a bad
// denominator. This is the range guard the concentration/Pareto/share surfaces assert against.
export function isValidShareFraction(share: number): boolean {
  return Number.isFinite(share) && share >= -1e-9 && share <= 1 + 1e-9;
}

// THE single share computation. Denominator is the sum over ALL `items`; each row's share and
// running cumulative share are returned as FRACTIONS in [0, 1] (never pre-multiplied by 100),
// so a downstream `formatPercent` scales exactly once. `limit` caps how many rows are returned
// (e.g. top 8) while keeping the denominator over the full set. Negative revenues (refunds) can
// in principle push a share outside [0, 1]; callers validate with isValidShareFraction.
export function computeShares<T extends { revenue: number }>(
  items: T[],
  limit = items.length,
): {
  rows: (T & { share: number; cumulativeShare: number })[];
  total: number;
  topShare: number;
  top3Share: number;
} {
  const total = items.reduce((s, i) => s + i.revenue, 0);
  let cumulative = 0;
  const rows = items.slice(0, limit).map((item) => {
    cumulative += item.revenue;
    return {
      ...item,
      share: total > 0 ? item.revenue / total : 0,
      cumulativeShare: total > 0 ? cumulative / total : 0,
    };
  });
  const topShare = rows[0]?.share ?? 0;
  const top3Share = rows.slice(0, 3).reduce((s, r) => s + r.share, 0);
  return { rows, total, topShare, top3Share };
}
