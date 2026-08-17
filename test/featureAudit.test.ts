// Pre-v1 feature audit — runtime probe (verification only, no production changes).
// Gated behind FEATURE_AUDIT so it stays out of the normal suite. Drives the SHIPPED
// no-touch path (parseCsv → auto-map → analyzeData/buildFindings) on the real data-loss
// files + clean controls, and dumps the integrity-critical signals as evidence.
//
//   FEATURE_AUDIT=1 npx vitest run test/featureAudit.test.ts

import { describe, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../src/csv-parse";
import { profileColumns, createMappingFromProfiles, analyzeData, assessRevenueColumn, computeRFM, buildAuditLedger, type Mapping } from "../src/App";
import { buildFindings } from "../src/analysis/findings";
import { canonicalRows } from "../src/metrics";
import { buildAuditProfile } from "../src/analysis/auditAdapter";
import { runAudit, type LedgerFinding, type AuditColumnProfile } from "../src/analysis/reconcile";

const RUN = !!process.env.FEATURE_AUDIT;
const DATASET = join(__dirname, "..", "dataset");

const FILES: { tag: string; rel: string }[] = [
  { tag: "data-loss",  rel: "archive (9)_ext/Amazon Sale Report.csv" },
  { tag: "data-loss",  rel: "archive (13)_ext/customer_shopping_data.csv" },
  { tag: "data-loss",  rel: "archive (9)_ext/International sale Report.csv" },
  { tag: "control",    rel: "sales_data_sample.csv" },
  { tag: "control",    rel: "archive (15)_ext/mobile_sales_data.csv" },
  { tag: "control",    rel: "archive (18)_ext/dirty_cafe_sales.csv" },
];

function topShare(items: { label: string; revenue: number }[]) {
  const total = items.reduce((s, i) => s + Math.abs(i.revenue), 0);
  if (total <= 0 || items.length === 0) return 0;
  return Math.abs(items[0].revenue) / total;
}

describe.skipIf(!RUN)("feature audit — runtime probe on real files", () => {
  for (const f of FILES) {
    it(`${f.tag}  ${f.rel}`, () => {
      const text = readFileSync(join(DATASET, f.rel), "utf8");
      const parsed = parseCsv(text);
      const profiles = profileColumns(parsed.headers, parsed.rows);
      const mapping = createMappingFromProfiles(profiles) as Mapping;

      const raw = parsed.rows.length;

      // FIX 1 — revenue confidence gate (refuse-and-disclose). "before" is what analyzeData
      // would still sum if the gate were absent; "after" is whether the live path now refuses.
      const rev = assessRevenueColumn(parsed.rows, mapping);
      const beforeTotal = (() => {
        try {
          return analyzeData(parsed.rows, mapping)?.totalRevenue ?? null;
        } catch {
          return null;
        }
      })();
      const gateLine = rev.ok
        ? `gate=PASS revenue='${rev.column ?? "(none)"}' beforeTotal=${beforeTotal}`
        : `gate=BLOCK reason=${rev.reason} col='${rev.column}' beforeTotal=${beforeTotal} → totals suppressed; "${rev.detail}"`;

      let analysis: ReturnType<typeof analyzeData> = null;
      let analyzeErr = "";
      try {
        // Mirror the live path: when the gate blocks, the engine does not compute totals.
        analysis = rev.ok ? analyzeData(parsed.rows, mapping) : null;
      } catch (e) {
        analyzeErr = e instanceof Error ? e.message : String(e);
      }

      // FIX 2 — one row base. analysis, findings, and RFM must all consume the SAME canonicalRows
      // set. "before" = findings on raw rows (a looser, date-blind base); "after" = findings on
      // canonicalRows. analysis.rowCount, findings(canon).rowCount and the RFM base must agree.
      const canon = canonicalRows(parsed.rows, mapping as Record<string, string | undefined>);
      let analysisRowCount = -1;
      try { analysisRowCount = analyzeData(parsed.rows, mapping)?.rowCount ?? 0; } catch { analysisRowCount = -1; }
      let findingsRawBase = -1;
      let findingsCanonBase = -1;
      try { findingsRawBase = buildFindings(parsed.rows, mapping).rowCount; } catch { /* noop */ }
      try { findingsCanonBase = buildFindings(canon, mapping).rowCount; } catch { /* noop */ }
      const rfmBase = mapping.customer && mapping.date && mapping.revenue
        ? computeRFM(canon, mapping.customer, mapping.date, mapping.revenue).reduce((s, c) => s + c.transactionCount, 0)
        : null;
      const fix2Match = analysisRowCount === findingsCanonBase && (rfmBase === null || rfmBase === analysisRowCount);
      const fix2Line =
        `analysis=${analysisRowCount} findings(canon)=${findingsCanonBase} RFMbase=${rfmBase ?? "n/a"} ` +
        `MATCH=${fix2Match}  (before: findings(raw)=${findingsRawBase})`;

      // FIX 3 — row-loss disclosure shown in the DEFAULT (concise) dashboard view. These are the
      // exact numbers the concise banner renders; drop% >= 10% escalates it to a warning.
      const fix3Total = parsed.rows.length;
      const fix3Used = analysisRowCount > 0 ? analysisRowCount : 0;
      const fix3Drop = fix3Total > 0 ? (fix3Total - fix3Used) / fix3Total : 0;
      const fix3Line = fix3Used < fix3Total
        ? `${fix3Used} of ${fix3Total} analyzed, ${(fix3Drop * 100).toFixed(1)}% dropped → concise banner ${fix3Drop >= 0.1 ? "SHOWN as WARNING" : "shown (info)"}`
        : `no rows dropped → no banner`;

      // FIX 4 — wire the C1–C14 reconciliation gate onto the live path (ADVISORY). Mirror the
      // app: when FIX 1 blocks (analysis === null) the gate is never reached — that's the honest
      // outcome, the ambiguity is already refused upstream. Otherwise build the SAME profile +
      // ledger the app builds and run the gate; print the verdict and any firing check ids.
      let fix4Line: string;
      if (!rev.ok) {
        fix4Line = `gate not reached — FIX1 blocked '${rev.column}' (${rev.reason}) upstream; no live audit`;
      } else {
        try {
          const liveAnalysis = analyzeData(parsed.rows, mapping);
          const liveFindings = buildFindings(canon, mapping);
          if (!liveAnalysis) {
            fix4Line = "analysis null (non-FIX1) — gate not run";
          } else {
            const { columns, periods } = buildAuditProfile(canon, mapping, liveFindings, { currency: "USD" });
            const ledger = buildAuditLedger(liveAnalysis, mapping, "USD");
            const res = runAudit(ledger, columns, [], periods);
            const fired = res.violations.map((x) => `${x.check}:${x.status}`).join(",") || "none";
            fix4Line = `verdict=${res.verdict} fired=[${fired}] (ledger=${ledger.length} findings, cols=${columns.length})`;
          }
        } catch (e) {
          fix4Line = `THREW: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // FIX 4 (demonstration) — prove the wired gate actually FIRES on the units-as-dollars
      // failure class. Build a deliberately wrong ledger: the hero total sourced from a
      // small-magnitude, name-hinted UNITS column (e.g. "Quantity Sold") but tagged as currency.
      // This is exactly what FIX 1 intercepts on the real files before the audit runs, so we
      // construct it directly to confirm runAudit reaches C3 and BLOCKs. Same engine entrypoint.
      const unitsCol: AuditColumnProfile = {
        name: "Quantity Sold",
        inferredRole: "measure",
        declaredUnit: "USD",
        dtype: "float",
        distinctCount: 10,
        colMin: 1,
        colMax: 10,
        colSum: 12345,
        dateGrain: null,
        hasPriceEvidence: false,
      };
      const badLedger: LedgerFinding[] = [
        {
          id: "total",
          measureName: "total revenue",
          kind: "scalar",
          value: 12345,
          unit: "USD",
          sourceColumn: "Quantity Sold",
          rendersCurrencySymbol: true,
          additivity: "extensive",
          aggregation: "sum",
        },
      ];
      const demo = runAudit(badLedger, [unitsCol], [], []);
      const demoC3 = demo.violations.some((x) => x.check === "C3" && x.status === "FAIL");
      const fix4Demo = `units-as-dollars synthetic → verdict=${demo.verdict} C3fires=${demoC3}`;

      let findingsSummary = "(not built)";
      try {
        const fnd = buildFindings(canon, mapping);
        findingsSummary =
          `trend=${fnd.trend.label}/${fnd.trend.direction} sig=${fnd.trend.isSignificant} | ` +
          `seasonality month=${fnd.seasonality.month.isSignificant} dow=${fnd.seasonality.dayOfWeek.isSignificant} | ` +
          `latestPartial=${fnd.latestPeriodPartial} | ` +
          `entitySignals=${fnd.entitySignals.outliers?.length ?? "?"} | ` +
          `risks=[${fnd.risks.map((r) => r.key).join(",")}] | ` +
          `findingsRowCount=${fnd.rowCount}`;
      } catch (e) {
        findingsSummary = `THREW: ${e instanceof Error ? e.message : String(e)}`;
      }

      const valid = analysis?.rowCount ?? 0;
      const dropPct = raw > 0 ? (((raw - valid) / raw) * 100).toFixed(1) : "n/a";
      const roles = (["revenue", "date", "product", "customer", "region", "quantity"] as const)
        .map((r) => `${r}=${mapping[r] || "-"}`)
        .join(" ");

      console.log(
        `\n[${f.tag}] ${f.rel.split("/").pop()}\n` +
          `  rawRows=${raw} validRows=${valid} drop=${dropPct}% analysisNull=${analysis === null}` +
          (analyzeErr ? ` analyzeErr=${analyzeErr}` : "") +
          `\n  roles: ${roles}\n` +
          `  FIX1 ${gateLine}\n` +
          `  FIX2 ${fix2Line}\n` +
          `  FIX3 ${fix3Line}\n` +
          `  FIX4 ${fix4Line}\n` +
          `  FIX4 ${fix4Demo}\n` +
          (analysis
            ? `  total=${analysis.totalRevenue} avg=${analysis.averageRevenue} min=${analysis.minRevenue} max=${analysis.maxRevenue}\n` +
              `  periods=${analysis.periodRevenue.length} products=${analysis.productRevenue.length} ` +
              `topProductShare=${(topShare(analysis.productRevenue) * 100).toFixed(1)}% ` +
              `customers=${analysis.customerRevenue.length} topCustShare=${(topShare(analysis.customerRevenue) * 100).toFixed(1)}%\n` +
              `  outliers=${analysis.outliers.length} ${analysis.outliers.slice(0, 3).map((o) => `${o.type}:${o.label}=${o.value}`).join(", ")}\n`
            : "  (analyzeData returned null — surfaces refuse to render)\n") +
          `  findings: ${findingsSummary}\n`,
      );
    });
  }
});
