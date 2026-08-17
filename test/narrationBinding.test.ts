// Acceptance tests for the narration-binding work: the Findings ledger is the single author
// of every conclusion, the AI is demoted to translator, and a deterministic reconciliation
// gate verifies numbers/claims before they are shown. Every expected value is derived from the
// real fixtures at runtime — never hardcoded. Fixtures A (flat/dirty cafe) and C (flat + partial
// last period mobile) are the primary witnesses; B (real upward) and D (real decline) are the
// over-correction guards.

import { describe, it, expect } from "vitest";
import {
  analyzeData,
  createExecutiveSummary,
  getRecommendedActions,
  generateSmartInsights,
  answerQuestion,
  resolveTrendChartLabel,
  type Mapping,
  type ReportSettings,
} from "../src/App";
import { buildFindings } from "../src/analysis/findings";
import { buildNarrationContract } from "../src/analysis/narration";
import { lintReport, assertTrendConsistency } from "../src/analysis/lintReport";
import { reconcileReport, findingsRegistry, type RenderedNumber } from "../src/analysis/reconcile";
import { computeShares } from "../src/metrics";
import { getFixtureA, getFixtureB, getFixtureC, getFixtureD, type Fixture } from "./fixtures/gen";

// Keys a risk/recommendation is allowed to carry. Anything outside this set is an invention.
const VALID_KEYS = new Set([
  "partial-period",
  "trend-decline",
  "trend-growth",
  "real-concentration",
  "price-driven-leader",
  "seasonality",
  "holiday",
]);

const SETTINGS: ReportSettings = {
  title: "T",
  company: "C",
  currency: "USD",
  template: "general",
  brandColor: "#000000",
};

function mappingFor(fx: Fixture): Mapping {
  return {
    ignore: "",
    date: fx.mapping.date,
    revenue: fx.mapping.revenue,
    quantity: fx.mapping.quantity,
    product: fx.mapping.product,
    customer: "",
    region: "",
    cost: "",
    profit: "",
    discount: "",
    orderId: "",
  };
}

// Every deterministic narrated surface for a fixture, as plain strings.
function narratedSurfaces(fx: Fixture) {
  const findings = buildFindings(fx.rows, fx.mapping);
  const mapping = mappingFor(fx);
  const analysis = analyzeData(fx.rows, mapping)!;
  const exec = createExecutiveSummary(analysis, SETTINGS, mapping, findings);
  const cards = getRecommendedActions(analysis, SETTINGS, findings)
    .map((a) => `${a.title}. ${a.detail}`)
    .join("\n");
  const insights = generateSmartInsights(analysis, SETTINGS, fx.rows, mapping, findings)
    .map((i) => i.text)
    .join("\n");
  const trendAnswer = answerQuestion("what's the trend over time?", analysis, SETTINGS, mapping, [], findings);
  return { findings, analysis, mapping, exec, cards, insights, trendAnswer };
}

// Independent group-by-sum (mirrors the app's rankBy without importing it).
function groupSum(rows: Record<string, string>[], labelCol: string, valueCol: string) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const label = String(r[labelCol] ?? "").trim();
    if (!label) continue;
    const v = Number(r[valueCol]);
    if (!Number.isFinite(v)) continue;
    totals.set(label, (totals.get(label) ?? 0) + v);
  }
  return [...totals.entries()]
    .map(([label, revenue]) => ({ label, revenue }))
    .sort((a, b) => b.revenue - a.revenue);
}

// ---------------------------------------------------------------------------------------
describe("AT-1 — no invented risk (Fixture A, flat dirty cafe)", () => {
  const { findings, exec, cards, insights } = narratedSurfaces(getFixtureA());

  it("every risk and recommendation cites a real finding key — none invented", () => {
    for (const r of findings.risks) expect(VALID_KEYS.has(r.key), `risk key ${r.key}`).toBe(true);
    for (const rb of findings.recommendationBases) expect(VALID_KEYS.has(rb.key), `rec key ${rb.key}`).toBe(true);
  });

  it("no surface fabricates a pricing-inconsistency / standardize / volatility risk", () => {
    const all = `${exec}\n${cards}\n${insights}`.toLowerCase();
    expect(all).not.toMatch(/standardize pricing|pricing inconsistency|price inconsistency|volatility/);
  });

  it("exec summary and recommendation cards are lint-clean against the verdicts", () => {
    expect(lintReport(exec, findings).ok).toBe(true);
    expect(lintReport(cards, findings).ok).toBe(true);
  });

  it("the narration contract carries the risk/recommendation ledger as the only allowed source", () => {
    const contract = buildNarrationContract(findings);
    expect(contract).toMatch(/RISKS \(the ONLY risks/);
    expect(contract).toMatch(/RECOMMENDATIONS \(base every action ONLY/);
    // Each derived risk's key is named in the contract.
    for (const r of findings.risks) expect(contract).toContain(`[${r.key}]`);
  });
});

// ---------------------------------------------------------------------------------------
describe("AT-2 — partial final period ⇒ no decline anywhere (Fixture C, mobile)", () => {
  const { findings, exec, cards, insights, trendAnswer } = narratedSurfaces(getFixtureC());

  it("the fixture's final period is genuinely partial", () => {
    expect(findings.latestPeriodPartial).toBe(true);
  });

  it("no narrated surface describes the latest period as a decline/drop/downturn", () => {
    for (const [name, text] of [
      ["exec", exec],
      ["cards", cards],
      ["insights", insights],
      ["trendAnswer", trendAnswer],
    ] as const) {
      // The incomplete-final-period ban is active, so lint must be clean.
      expect(lintReport(text, findings).ok, `${name} lint`).toBe(true);
      // And no raw "declin*"/"downturn"/"shrink*" survives.
      expect(text.toLowerCase(), `${name} prose`).not.toMatch(/declin|downturn|shrink/);
    }
  });

  it("the exec summary flags the final period as incomplete / not comparable", () => {
    expect(exec.toLowerCase()).toMatch(/incomplete|not comparable/);
  });
});

// ---------------------------------------------------------------------------------------
describe("AT-3 — seasonality is gated (none-witness = Fixture A; contract holds on all)", () => {
  it("Fixture A has no seasonality, so no surface asserts one and no season recommendation exists", () => {
    const { findings, exec, cards, insights } = narratedSurfaces(getFixtureA());
    expect(findings.seasonality.month.isSignificant).toBe(false);
    expect(findings.seasonality.dayOfWeek.isSignificant).toBe(false);
    expect(findings.recommendationBases.some((r) => r.key === "seasonality")).toBe(false);
    const all = `${exec}\n${cards}\n${insights}`;
    expect(lintReport(all, findings).ok).toBe(true);
  });

  it("a season recommendation exists IFF a seasonality verdict is significant (all fixtures)", () => {
    for (const fx of [getFixtureA(), getFixtureB(), getFixtureC(), getFixtureD()]) {
      const f = buildFindings(fx.rows, fx.mapping);
      const seasonal = f.seasonality.month.isSignificant || f.seasonality.dayOfWeek.isSignificant;
      const hasRec = f.recommendationBases.some((r) => r.key === "seasonality");
      expect(hasRec).toBe(seasonal);
    }
  });
});

// ---------------------------------------------------------------------------------------
describe("AT-4 — balanced dimension ⇒ no dependency claim (Fixture C)", () => {
  const { findings } = narratedSurfaces(getFixtureC());

  it("product volume is balanced, so there is no real-concentration risk", () => {
    expect(findings.category.volumeUniform).toBe(true);
    expect(findings.risks.some((r) => r.key === "real-concentration")).toBe(false);
  });

  it("the reconciliation gate rejects a concentration claim that has no basis", () => {
    const res = reconcileReport(
      { numbers: [], claims: [{ surface: "ai-report", kind: "risk", key: "real-concentration", text: "single-product dependency" }] },
      findings,
    );
    expect(res.ok).toBe(false);
    expect(res.violations[0].rule).toBe("claim-unsupported");
  });
});

// ---------------------------------------------------------------------------------------
describe("AT-5 — chart caption wording equals the chart label (Fixtures A and C)", () => {
  for (const fx of [getFixtureA(), getFixtureC()]) {
    const findings = buildFindings(fx.rows, fx.mapping);
    it(`trend label "${findings.trend.label}" drives the caption identically for every slope`, () => {
      const labels = [50, -50, 3, 0, 8, -8].map((s) => resolveTrendChartLabel(findings.trend.label, s));
      // Same source (the verdict) ⇒ same caption regardless of raw slope; and it names the verdict.
      const unique = new Set(labels);
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe("→ flat / normal variation");
      expect([...unique][0]).toContain("normal variation");
    });
  }
});

// ---------------------------------------------------------------------------------------
describe("AT-6 — concentration card equals the derived top-3 share (Fixture C, mobile)", () => {
  const { rows } = getFixtureC();
  const byCustomer = groupSum(rows, "Customer Name", "Price");
  const { top3Share } = computeShares(byCustomer, 8);

  it("the derived top-3 customer share is a tiny fraction (~0.14%), not ~10%", () => {
    const total = byCustomer.reduce((s, c) => s + c.revenue, 0);
    const expected = byCustomer.slice(0, 3).reduce((s, c) => s + c.revenue, 0) / total;
    expect(top3Share).toBeCloseTo(expected, 10);
    expect(top3Share).toBeGreaterThan(0);
    expect(top3Share).toBeLessThan(0.01); // < 1% — emphatically not the 10% double-scale artifact
  });

  it("the reconciliation gate passes the card's figure and rejects the double-scaled 10% version", () => {
    const findings = buildFindings(getFixtureC().rows, getFixtureC().mapping);
    const extra = { "concentration.top3Share": top3Share };
    const good: RenderedNumber = { surface: "concentration-card", label: "top-3 share", value: top3Share, key: "concentration.top3Share" };
    expect(reconcileReport({ numbers: [good], claims: [] }, findings, { extraRegistry: extra }).ok).toBe(true);

    const doubleScaled: RenderedNumber = { ...good, value: top3Share * 100 }; // the "10%" bug
    const res = reconcileReport({ numbers: [doubleScaled], claims: [] }, findings, { extraRegistry: extra });
    expect(res.ok).toBe(false);
    expect(res.violations[0].rule).toBe("number-mismatch");
    // Fail closed: the corrected value is the canonical share, never the double-scaled one.
    expect(res.corrected[0].value).toBeCloseTo(top3Share, 12);
  });
});

// ---------------------------------------------------------------------------------------
describe("AT-7 — over-correction guards: real signals are still narrated", () => {
  it("Fixture D (real decline, complete final period) IS narrated as a decline", () => {
    const fx = getFixtureD();
    const { findings, exec, cards } = narratedSurfaces(fx);
    expect(findings.trend.isSignificant).toBe(true);
    expect(findings.trend.direction).toBe("down");
    expect(findings.risks.some((r) => r.key === "trend-decline")).toBe(true);
    // The decline survives — it is a real finding, not a partial-period artifact.
    expect(`${exec}\n${cards}`.toLowerCase()).toMatch(/declin|downward trend/);
    expect(resolveTrendChartLabel(findings.trend.label, -8)).toMatch(/↓/);
  });

  it("Fixture B (real upward trend) IS narrated as growth", () => {
    const fx = getFixtureB();
    const { findings, exec, cards } = narratedSurfaces(fx);
    expect(findings.trend.isSignificant).toBe(true);
    expect(findings.trend.direction).toBe("up");
    expect(findings.recommendationBases.some((r) => r.key === "trend-growth")).toBe(true);
    expect(`${exec}\n${cards}`.toLowerCase()).toContain("upward trend");
    expect(resolveTrendChartLabel(findings.trend.label, 8)).toMatch(/↑/);
  });
});

// ---------------------------------------------------------------------------------------
describe("AT-8 — cross-surface trend consistency on every fixture", () => {
  for (const [name, fx] of [
    ["A flat", getFixtureA()],
    ["C partial", getFixtureC()],
    ["D decline", getFixtureD()],
    ["B upward", getFixtureB()],
  ] as const) {
    it(`Fixture ${name}: exec, cards, and trend answer all carry the one verdict label`, () => {
      const { findings, exec, cards, trendAnswer } = narratedSurfaces(fx);
      const sections = [
        { name: "exec", text: exec },
        { name: "cards", text: cards },
        { name: "trendAnswer", text: trendAnswer },
      ];
      expect(assertTrendConsistency(sections, findings).ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------------------
describe("AT-9 — pre-submission reconciliation gate fails closed", () => {
  const fx = getFixtureA();
  const findings = buildFindings(fx.rows, fx.mapping);
  const reg = findingsRegistry(findings);

  it("every rendered number that traces to findings reconciles with zero violations", () => {
    const numbers: RenderedNumber[] = [
      { surface: "exec", label: "total", value: findings.total, key: "total" },
      { surface: "kpi", label: "rows", value: findings.rowCount, key: "rowCount" },
      { surface: "chart", label: "first period", value: findings.periodSeries[0].value, key: `period:${findings.periodSeries[0].label}` },
    ];
    const res = reconcileReport({ numbers, claims: [] }, findings);
    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it("an injected wrong number is caught and replaced with the findings value (fail closed)", () => {
    const wrong: RenderedNumber = { surface: "exec", label: "total", value: findings.total * 2, key: "total" };
    const res = reconcileReport({ numbers: [wrong], claims: [] }, findings);
    expect(res.ok).toBe(false);
    expect(res.violations[0].rule).toBe("number-mismatch");
    expect(res.corrected[0].value).toBe(reg["total"]);
  });

  it("a number that traces to no findings key is a violation", () => {
    const orphan: RenderedNumber = { surface: "ai-report", label: "made-up", value: 12345, key: "nonexistent.key" };
    const res = reconcileReport({ numbers: [orphan], claims: [] }, findings);
    expect(res.ok).toBe(false);
    expect(res.violations[0].rule).toBe("number-unreconciled");
  });

  it("a supported claim passes and an unsupported one fails", () => {
    const supportedKey = findings.risks[0]?.key ?? findings.recommendationBases[0]?.key;
    const supportedKind = findings.risks[0] ? "risk" : "recommendation";
    const ok = reconcileReport(
      { numbers: [], claims: [{ surface: "ai-report", kind: supportedKind as "risk" | "recommendation", key: supportedKey }] },
      findings,
    );
    expect(ok.ok).toBe(true);

    const bad = reconcileReport(
      { numbers: [], claims: [{ surface: "ai-report", kind: "risk", key: "price-inconsistency" }] },
      findings,
    );
    expect(bad.ok).toBe(false);
    expect(bad.violations[0].rule).toBe("claim-unsupported");
  });
});
