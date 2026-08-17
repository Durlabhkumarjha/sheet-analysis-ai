// Part A — capacity + robustness sweep on REAL files (Node/V8 proxy for compute + heap).
// This is a MEASUREMENT harness, not an assertion suite. It is gated behind the
// CAPACITY_SWEEP env var so the normal `vitest run` stays fast; enable with:
//
//   CAPACITY_SWEEP=1 npx vitest run test/capacitySweep.test.ts            (PowerShell: $env:CAPACITY_SWEEP=1; ...)
//   CAPACITY_SWEEP=1 node --expose-gc ./node_modules/vitest/vitest.mjs run test/capacitySweep.test.ts   (cleaner heap deltas)
//
// It exercises the SHIPPED code path a no-touch user hits:
//   parseCsv (the exact worker parser, extracted to src/csv-parse.ts)
//   → profileColumns → createMappingFromProfiles  (auto-map, no hand authoring)
//   → canonicalRows (the shared row filter)
//   → analyzeData   (full analysis)
// reporting parse / canonical / analyze time + heap, plus a robustness log.

import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/csv-parse";
import { profileColumns, createMappingFromProfiles, analyzeData, type Mapping } from "../src/App";
import { canonicalRows, hasNumericValue } from "../src/metrics";

const RUN = !!process.env.CAPACITY_SWEEP;
const DATASET = join(__dirname, "..", "dataset");

type Corpus = { bucket: string; rel: string; curve: boolean; messy: boolean };

// Curated ~9 (not all 190): one file per row bucket for the capacity curve + a few
// deliberately-messy real files for the robustness log. car_sales_data (2.5M / 234MB)
// skipped per directive; ~250k bucket has no clean real file (gap between 129k and 559k).
const CORPUS: Corpus[] = [
  { bucket: "~1k",   rel: "archive (11)_ext/retail_sales_dataset.csv", curve: true,  messy: false },
  { bucket: "~3k",   rel: "sales_data_sample.csv",                     curve: false, messy: true  },
  { bucket: "~10k",  rel: "archive (18)_ext/dirty_cafe_sales.csv",     curve: true,  messy: true  },
  { bucket: "~37k",  rel: "archive (9)_ext/International sale Report.csv", curve: false, messy: true },
  { bucket: "~50k",  rel: "archive (15)_ext/mobile_sales_data.csv",    curve: true,  messy: false },
  { bucket: "~100k", rel: "archive (13)_ext/customer_shopping_data.csv", curve: true, messy: false },
  { bucket: "~130k", rel: "archive (9)_ext/Amazon Sale Report.csv",    curve: true,  messy: true  },
  { bucket: "~500k", rel: "archive (1)_ext/car_prices.csv",            curve: true,  messy: false },
  { bucket: "~1M",   rel: "archive (2)_ext/annex2.csv",                curve: true,  messy: false },
];

function gc() {
  // @ts-expect-error gc is only present under --expose-gc
  if (typeof global.gc === "function") global.gc();
}
function mb(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1);
}
function ms(t: number) {
  return t.toFixed(0);
}

type CurveRow = {
  bucket: string;
  rows: number;
  cols: number;
  parseMs: number;
  canonMs: number;
  analyzeMs: number;
  totalMs: number;
  heapMb: string;
  rssMb: string;
};
type RobustRow = {
  file: string;
  rows: number;
  parsedOk: boolean;
  droppedPct: string;
  mapping: string;
  flags: string[];
};

const curve: CurveRow[] = [];
const robust: RobustRow[] = [];

describe.skipIf(!RUN)("Part A — real-file capacity + robustness sweep", () => {
  for (const item of CORPUS) {
    it(
      `${item.bucket}  ${item.rel}`,
      () => {
        const path = join(DATASET, item.rel);
        const baseName = item.rel.split("/").pop() ?? item.rel;

        let parsedOk = true;
        let parseMs = 0,
          canonMs = 0,
          analyzeMs = 0;
        let rowsLen = 0,
          colsLen = 0,
          canonLen = 0;
        let mapping: Mapping | null = null;
        let profiles: ReturnType<typeof profileColumns> = [];
        let parsedRows: Record<string, string>[] = [];
        const flags: string[] = [];

        gc();
        const heap0 = process.memoryUsage().heapUsed;
        const rss0 = process.memoryUsage().rss;

        try {
          const text = readFileSync(path, "utf8");

          let t = performance.now();
          const parsed = parseCsv(text);
          parseMs = performance.now() - t;

          parsedRows = parsed.rows;
          rowsLen = parsed.rows.length;
          colsLen = parsed.headers.length;

          profiles = profileColumns(parsed.headers, parsed.rows);
          mapping = createMappingFromProfiles(profiles);

          t = performance.now();
          const canon = canonicalRows(parsed.rows, mapping as Record<string, string | undefined>);
          canonMs = performance.now() - t;
          canonLen = canon.length;

          t = performance.now();
          analyzeData(parsed.rows, mapping);
          analyzeMs = performance.now() - t;
        } catch (err) {
          parsedOk = false;
          const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 6).join(" >> ") : "";
          flags.push(`THREW: ${err instanceof Error ? err.message : String(err)} || ${stack}`);
        }

        const heapDelta = process.memoryUsage().heapUsed - heap0;
        const rssDelta = process.memoryUsage().rss - rss0;

        // ---- robustness analysis (auto-map mis-role + silent coercion checks) ----
        if (mapping) {
          const m = mapping;
          const findProfile = (col: string) => profiles.find((p) => p.name === col);

          const revCol = m.revenue;
          if (revCol) {
            const rp = findProfile(revCol);
            if (rp && rp.type !== "number")
              flags.push(`revenue '${revCol}' auto-mapped from a ${rp.type} column (mis-role?)`);
          } else {
            flags.push("no revenue column auto-detected");
          }
          if (m.date) {
            const dp = findProfile(m.date);
            if (dp && dp.type !== "date")
              flags.push(`date '${m.date}' auto-mapped from a ${dp.type} column (mis-role?)`);
          }
          // numeric columns left on the floor that look like measures
          for (const p of profiles) {
            if (p.type === "number" && p.guess === "ignore" && /amount|price|total|revenue|sales|cost|qty|quantity|value|spend/i.test(p.name))
              flags.push(`numeric '${p.name}' left unmapped (guess=ignore)`);
          }
          // silent coercion / silent exclusion: non-empty revenue cells that aren't numeric.
          // These are dropped from totals without any user-facing error. One O(n) pass.
          if (revCol && parsedRows.length > 0) {
            let nonEmptyNonNumeric = 0;
            for (const row of parsedRows) {
              const cell = row[revCol];
              if (cell && cell.trim() !== "" && !hasNumericValue(cell)) nonEmptyNonNumeric += 1;
            }
            if (nonEmptyNonNumeric > 0) {
              const pct = ((nonEmptyNonNumeric / parsedRows.length) * 100).toFixed(1);
              flags.push(`revenue '${revCol}': ${nonEmptyNonNumeric} non-empty cells (${pct}%) silently excluded as non-numeric`);
            }
          }
        }

        const droppedPct = rowsLen > 0 ? (((rowsLen - canonLen) / rowsLen) * 100).toFixed(1) : "n/a";
        const mapStr = mapping
          ? Object.entries(mapping)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")
          : "(none)";

        if (item.curve) {
          curve.push({
            bucket: item.bucket,
            rows: rowsLen,
            cols: colsLen,
            parseMs,
            canonMs,
            analyzeMs,
            totalMs: parseMs + canonMs + analyzeMs,
            heapMb: mb(heapDelta),
            rssMb: mb(rssDelta),
          });
        }
        if (item.messy || !parsedOk || flags.length > 0) {
          robust.push({ file: baseName, rows: rowsLen, parsedOk, droppedPct, mapping: mapStr, flags });
        }

        // Per-file line (visible with --reporter=verbose or in stdout)
        console.log(
          `\n[${item.bucket}] ${baseName}\n` +
            `  rows=${rowsLen} cols=${colsLen} dropped=${droppedPct}%\n` +
            `  parse=${ms(parseMs)}ms canonical=${ms(canonMs)}ms analyze=${ms(analyzeMs)}ms ` +
            `total=${ms(parseMs + canonMs + analyzeMs)}ms\n` +
            `  heapΔ=${mb(heapDelta)}MB rssΔ=${mb(rssDelta)}MB\n` +
            `  map: ${mapStr}\n` +
            (flags.length ? `  flags: ${flags.join(" | ")}\n` : ""),
        );
      },
      900_000,
    );
  }

  it("print summary tables", () => {
    const sortable = [...curve].sort((a, b) => a.rows - b.rows);
    let t1 =
      "\n================ TABLE 1: compute vs row count (Node/V8) ================\n" +
      "bucket   rows      cols  parse(ms)  canon(ms)  analyze(ms)  total(ms)  heapΔ(MB)  rssΔ(MB)\n";
    for (const r of sortable) {
      t1 +=
        `${r.bucket.padEnd(8)} ${String(r.rows).padEnd(9)} ${String(r.cols).padEnd(5)} ` +
        `${ms(r.parseMs).padStart(8)}  ${ms(r.canonMs).padStart(8)}  ${ms(r.analyzeMs).padStart(10)}  ` +
        `${ms(r.totalMs).padStart(8)}  ${r.heapMb.padStart(8)}  ${r.rssMb.padStart(7)}\n`;
    }

    let t2 = "\n================ TABLE 2: robustness log (messy / flagged real files) ================\n";
    for (const r of robust) {
      t2 +=
        `\n• ${r.file}  (rows=${r.rows}, parsedOk=${r.parsedOk}, dropped=${r.droppedPct}%)\n` +
        `    map: ${r.mapping}\n` +
        (r.flags.length ? `    flags: ${r.flags.join(" | ")}\n` : "    flags: none\n");
    }

    console.log(t1 + t2);
  });
});
