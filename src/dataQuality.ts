// Pre-analysis data-quality heuristics that run on the RAW upload, before the rest of the
// pipeline assumes "row 0 is the header" or "the revenue column is a row total". Both checks
// are deliberately domain-agnostic: they judge the SHAPE of values (fill, numericness,
// uniqueness, correlation), never specific column names, products, regions, or file types.

// ----------------------------------------------------------------------------------------
// FIX 4 — Header-row detection.
//
// Real-world exports often carry title/branding/blank lines above the genuine header row
// (e.g. "ACME Analytics — Quarterly Sales Export", a "Generated …" line, a blank, THEN the
// column names). If we blindly treat the first line as the header, every column name and
// every downstream verdict is garbage. We scan the first rows and pick the first one that
// LOOKS like a header — mostly-filled, non-numeric, short, unique label cells — sitting
// above rows that look like data.

export type HeaderDetection = {
  headerIndex: number; // index into the scanned grid of the most header-like row
  confidence: number; // 0..1 score of that row's header-likeness
  firstRowIsHeader: boolean; // true when headerIndex === 0 (no warning needed)
};

const NUMERIC_RE = /^-?[\d.,$%\s]+$/;

function isNumericCell(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!NUMERIC_RE.test(t)) return false;
  return Number.isFinite(Number(t.replace(/[$,%\s]/g, "")));
}

// Score how much a single grid row resembles a column-header row. The width is the grid's
// widest row so a sparse title line ("ACME …", "", "", "") is correctly penalised on fill.
function headerLikeness(row: string[], width: number): number {
  if (width === 0) return 0;
  const cells = row.map((c) => (c ?? "").trim());
  const nonEmpty = cells.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) return 0;

  const fillRatio = nonEmpty.length / width;
  const numericRatio = nonEmpty.filter(isNumericCell).length / nonEmpty.length;
  const uniqueRatio = new Set(nonEmpty.map((c) => c.toLowerCase())).size / nonEmpty.length;
  // Headers are short labels, not sentences or paragraphs of prose.
  const shortRatio = nonEmpty.filter((c) => c.length <= 40).length / nonEmpty.length;

  // A header is well-filled, non-numeric, all-unique, and short. Numeric content is the
  // strongest disqualifier (data rows are numeric), so it carries the most weight.
  const score =
    0.3 * fillRatio +
    0.3 * (1 - numericRatio) +
    0.25 * uniqueRatio +
    0.15 * shortRatio;
  return score;
}

// Returns the first row in the scan window that is plausibly a header (clears an absolute
// bar) AND is at least as header-like as every row below it in the window — i.e. the rows
// underneath read as data, not as more headers. Falls back to row 0 when nothing qualifies.
export function detectHeaderRow(grid: string[][], scanRows = 10): HeaderDetection {
  const window = grid.slice(0, scanRows);
  if (window.length === 0) return { headerIndex: 0, confidence: 0, firstRowIsHeader: true };

  const width = Math.max(...window.map((r) => r.filter((c) => (c ?? "").trim().length > 0).length), 1);
  const scores = window.map((r) => headerLikeness(r, width));

  // Absolute bar a row must clear to be considered a header at all.
  const MIN_HEADER_SCORE = 0.6;

  let best = 0;
  for (let i = 0; i < window.length; i++) {
    if (scores[i] < MIN_HEADER_SCORE) continue;
    // Must out-score (or tie) every later row in the window: a genuine header is more
    // header-like than the data beneath it.
    const dominatesBelow = scores.slice(i + 1).every((s) => s <= scores[i] + 1e-9);
    if (dominatesBelow) {
      best = i;
      break;
    }
  }

  return {
    headerIndex: best,
    confidence: scores[best] ?? 0,
    firstRowIsHeader: best === 0,
  };
}

// ----------------------------------------------------------------------------------------
// FIX 5 — Per-unit price vs row total.
//
// When the column mapped as "revenue" is actually a per-UNIT price (common in product
// catalogues / inventory exports) while a separate quantity column exists, summing it as if
// it were a line total silently overstates/understates revenue and mis-weights every item.
// Signal: a genuine row total scales with quantity (price × qty), so value and quantity
// correlate positively; a per-unit price is independent of how many units sold, so the
// correlation collapses toward zero.

export type PerUnitPriceCheck = {
  likely: boolean;
  correlation: number; // Pearson r between value and quantity over valid numeric pairs
  sampleSize: number;
};

function toNum(s: string): number {
  const n = Number(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const cov = n * sxy - sx * sy;
  const dx = n * sxx - sx * sx;
  const dy = n * syy - sy * sy;
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? cov / denom : 0;
}

// |correlation| below this is treated as "value does not scale with quantity" → per-unit price.
// We test the ABSOLUTE value: a per-unit price is INDEPENDENT of quantity (r ≈ 0). A strongly
// negative correlation (e.g. a real line total whose big-ticket items sell in small counts)
// is NOT a per-unit price and must not be refused — testing `< floor` alone misfired on those.
const PER_UNIT_CORR_FLOOR = 0.2;

export function looksLikePerUnitPrice(
  rows: Record<string, string>[],
  valueCol: string,
  qtyCol: string,
): PerUnitPriceCheck {
  if (!valueCol || !qtyCol) return { likely: false, correlation: 0, sampleSize: 0 };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of rows) {
    const v = toNum(row[valueCol]);
    const q = toNum(row[qtyCol]);
    if (!Number.isFinite(v) || !Number.isFinite(q) || q <= 0) continue;
    xs.push(v);
    ys.push(q);
  }
  if (xs.length < 20) return { likely: false, correlation: 0, sampleSize: xs.length };
  // Need quantity to actually vary, otherwise correlation is undefined/meaningless.
  if (new Set(ys).size < 2) return { likely: false, correlation: 0, sampleSize: xs.length };

  const correlation = pearson(xs, ys);
  return { likely: Math.abs(correlation) < PER_UNIT_CORR_FLOOR, correlation, sampleSize: xs.length };
}

// ----------------------------------------------------------------------------------------
// Cardinality / role guard.
//
// Tiering (ABC/Pareto), ranking, and share computations are only meaningful on a BOUNDED
// category — a field with a handful-to-hundreds of repeated values. A field with thousands of
// distinct values, or roughly one distinct value per row, is an identifier / free-text key
// (customer name, location, order id, SKU code) and must never be silently bucketed as an
// "item" dimension. This judges the SHAPE of the field (distinct count and distinct/row ratio)
// only — never the column name or its contents — so it stays domain-agnostic.
export function isTierableDimension(
  distinctCount: number,
  sampleSize: number,
  maxDistinct: number,
  minDistinct = 8,
  maxUniqueRatio = 0.5,
): boolean {
  if (distinctCount < minDistinct) return false; // too few groups to tier/Pareto
  if (distinctCount > maxDistinct) return false; // identifier / free-text key
  if (sampleSize > 0 && distinctCount / sampleSize > maxUniqueRatio) return false; // ~1 per row
  return true;
}
