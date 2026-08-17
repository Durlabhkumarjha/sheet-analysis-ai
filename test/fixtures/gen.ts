// Deterministic fixtures for the verdict engine.
//
// Fixture A is the REAL Kaggle `dirty_cafe_sales.csv` (n≈9,000 clean rows after the
// engine drops ERROR/UNKNOWN/blank values). It is uniform random noise — items are
// roughly evenly distributed (max/min ≈ 1.09), each item has one fixed unit price, and
// dates are spread across the year (no real month/weekday/holiday pattern). It is the
// regression witness: the original bug narrated this flat file as pricing strategy +
// seasonality. We read it from disk so the test runs against the actual data, not a copy.
//
// Fixture B plants real signal: weekend +40%, December ~2×, a +5%/period upward trend,
// and one product selling ~5× the units of the others. It is the over-correction guard.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Fixture = {
  rows: Record<string, string>[];
  mapping: { date: string; product: string; quantity: string; revenue: string };
};

// Minimal CSV parser — the cafe file is unquoted, comma-separated, one record per line.
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, j) => (row[h] = (cells[j] ?? "").trim()));
    out.push(row);
  }
  return out;
}

// Seeded PRNG (mulberry32) for reproducible fixtures.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Fixture A — the real dirty_cafe_sales.csv, read from disk alongside this module.
export function getFixtureA(): Fixture {
  const csvPath = fileURLToPath(new URL("./dirty_cafe_sales.csv", import.meta.url));
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  return {
    rows,
    mapping: { date: "Transaction Date", product: "Item", quantity: "Quantity", revenue: "Total Spent" },
  };
}

// Fixture C — the REAL mobile_sales_data.csv (50k rows), read from disk. It is flat over
// time (trend p ≈ 0.63, normal variation) but its endpoints are PARTIAL: the first month
// (2023-03) carries ~35% of a typical month's volume and the last month (2025-03) ~65%,
// stopping mid-month. It is the partial-period witness: the original build read the truncated
// final month as a ~30% "decline". `Inward Date` is the correct event date (Dispatch Date
// lags and flattens the series); `Price` is a per-UNIT price, so it also exercises FIX 5.
export function getFixtureC(): Fixture {
  const csvPath = fileURLToPath(new URL("./mobile_sales_data.csv", import.meta.url));
  const rows = parseCsv(readFileSync(csvPath, "utf8"));
  return {
    rows,
    mapping: { date: "Inward Date", product: "Product", quantity: "Quantity Sold", revenue: "Price" },
  };
}

// Fixture D — a GENUINE downward trend with a COMPLETE final period. Every month is full
// (all calendar days, uniform transaction count), revenue falls ~10% per month. The trend is
// real (monotonic, clears the noise band) and the last month is NOT partial, so the
// completeness gate must leave it intact and the decline must survive sanitization. It is the
// over-correction guard for FIX 1: the partial-period rule must not silence a real decline.
export function getFixtureD(seed = 4242): Fixture {
  const rand = rng(seed);
  const rows: Record<string, string>[] = [];
  const year = 2024;
  const items = ["Alpha", "Beta", "Gamma", "Delta"];
  for (let m = 0; m < 12; m++) {
    const monthFactor = Math.pow(0.9, m); // −10% per month — a clear, real decline
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, m, day);
      const txns = 12; // uniform volume → every month is "complete"
      for (let t = 0; t < txns; t++) {
        const item = items[Math.floor(rand() * items.length)];
        const qty = 1 + Math.floor(rand() * 3);
        const price = 10;
        const revenue = price * qty * monthFactor * (0.95 + rand() * 0.1);
        rows.push({
          "Transaction Date": iso(date),
          Item: item,
          Quantity: String(qty),
          "Total Spent": (Math.round(revenue * 100) / 100).toString(),
        });
      }
    }
  }
  return {
    rows,
    mapping: { date: "Transaction Date", product: "Item", quantity: "Quantity", revenue: "Total Spent" },
  };
}

// Fixture E — raw upload rows where the real header is NOT the first row: two sparse,
// title/branding lines and a blank line sit above it. Used to test header-row detection
// (FIX 4). Returns the pre-parse grid plus the index where the genuine header lives, derived
// here so the test never literal-matches column names.
export type RawGridFixture = { grid: string[][]; expectedHeaderIndex: number };
export function getFixtureE(): RawGridFixture {
  const grid: string[][] = [
    ["ACME Analytics — Quarterly Sales Export", "", "", ""],
    ["Generated 2024-01-15", "", "", ""],
    ["", "", "", ""],
    ["Date", "Product", "Quantity", "Revenue"],
    ["2024-01-02", "Alpha", "3", "30"],
    ["2024-01-03", "Beta", "1", "10"],
    ["2024-01-04", "Gamma", "2", "20"],
  ];
  return { grid, expectedHeaderIndex: 3 };
}

// Fixture F — a GENUINE recurring monthly season across MULTIPLE complete years. Three full
// calendar years (2022–2024), every month complete, December ≈ 2× a baseline month, repeated
// every year. No trend and no weekday effect, so the signal is purely month-of-year. This is the
// witness that the month grain (monthly totals over ≥2 complete years) DETECTS a real season —
// the complement to Fixture B, where one year of the same December lift is correctly
// "insufficient". December is planted as the high month; the test reads that back at runtime.
export function getFixtureF(seed = 7777): Fixture {
  const rand = rng(seed);
  const rows: Record<string, string>[] = [];
  const items = ["Alpha", "Beta", "Gamma", "Delta"];
  for (const year of [2022, 2023, 2024]) {
    for (let m = 0; m < 12; m++) {
      const decemberSpike = m === 11 ? 2 : 1; // December ≈ 2× a baseline month, every year
      const daysInMonth = new Date(year, m + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, m, day);
        const txns = 10; // uniform volume → every month complete, no weekday structure
        for (let t = 0; t < txns; t++) {
          const item = items[Math.floor(rand() * items.length)];
          const qty = 1 + Math.floor(rand() * 3);
          const revenue = 10 * qty * decemberSpike * (0.97 + rand() * 0.06);
          rows.push({
            "Transaction Date": iso(date),
            Item: item,
            Quantity: String(qty),
            "Total Spent": (Math.round(revenue * 100) / 100).toString(),
          });
        }
      }
    }
  }
  return {
    rows,
    mapping: { date: "Transaction Date", product: "Item", quantity: "Quantity", revenue: "Total Spent" },
  };
}

// The month planted as the recurring high season in Fixture F — derived here so tests assert
// detection without literal-matching a month name in the test body.
export const FIXTURE_F_HIGH_MONTH = "December";

// Fixture B — planted weekend, December, trend, and volume signals.
export function getFixtureB(seed = 999): Fixture {
  const rand = rng(seed);
  const rows: Record<string, string>[] = [];
  const year = 2023;
  // Item volume weights: "Hot Item" moves ~5× the units of the rest.
  const items: { item: string; price: number; weight: number }[] = [
    { item: "Widget A", price: 3, weight: 1 },
    { item: "Widget B", price: 3, weight: 1 },
    { item: "Widget C", price: 3, weight: 1 },
    { item: "Widget D", price: 3, weight: 1 },
    { item: "Hot Item", price: 3, weight: 5 },
  ];
  const weightTotal = items.reduce((s, it) => s + it.weight, 0);
  const pickItem = () => {
    let r = rand() * weightTotal;
    for (const it of items) {
      r -= it.weight;
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  };

  for (let m = 0; m < 12; m++) {
    const monthTrend = Math.pow(1.05, m); // +5% per period (month)
    const decemberSpike = m === 11 ? 2 : 1; // December ≈ 2× a baseline month
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, m, day);
      const dow = date.getDay();
      const weekend = dow === 0 || dow === 6 ? 1.4 : 1; // weekends +40%
      const dayFactor = monthTrend * decemberSpike * weekend;
      const txns = 14; // transactions per day
      for (let t = 0; t < txns; t++) {
        const it = pickItem();
        const qty = 1 + Math.floor(rand() * 3);
        const revenue = it.price * qty * dayFactor;
        rows.push({
          "Transaction Date": iso(date),
          Item: it.item,
          Quantity: String(qty),
          "Total Spent": (Math.round(revenue * 100) / 100).toString(),
        });
      }
    }
  }
  return {
    rows,
    mapping: { date: "Transaction Date", product: "Item", quantity: "Quantity", revenue: "Total Spent" },
  };
}
