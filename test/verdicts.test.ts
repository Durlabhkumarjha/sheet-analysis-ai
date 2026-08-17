import { describe, it, expect } from "vitest";
import { buildFindings } from "../src/analysis/findings";
import { buildNarrationContract, activeBans } from "../src/analysis/narration";
import { lintReport, assertTrendConsistency } from "../src/analysis/lintReport";
import { THRESHOLDS } from "../src/analysis/verdicts";
import { getFixtureA, getFixtureB, getFixtureF, FIXTURE_F_HIGH_MONTH } from "./fixtures/gen";

// Domain-agnostic: the engine must never hardcode a category value, and neither may its
// tests. We derive the expected leader from the fixture rows themselves and compare it to
// what the engine reports — proving the pick is correct without literal-matching a name.
function leaderBy(
  rows: Record<string, string>[],
  nameKey: string,
  valueKey: string,
): string {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const v = Number(r[valueKey]) || 0;
    totals.set(r[nameKey], (totals.get(r[nameKey]) ?? 0) + v);
  }
  let best = "";
  let bestVal = -Infinity;
  for (const [k, v] of totals) if (v > bestVal) ((bestVal = v), (best = k));
  return best;
}

// The current build's buggy output, captured verbatim from the spec. The linter must
// reject it — this is the regression baseline (was xfail before the engine existed).
const BAD_BASELINE = `
Executive Summary: Revenue shows a 4.1% upward trend with strong momentum heading into next quarter.
Salad's premium pricing is a key driver of revenue — we should upsell Salad and other higher-priced items.
There is clear seasonal vulnerability in February, with June momentum carrying the year.
Recommendation: run a Valentine's Day special to fix the February low.
`;

describe("Fixture A — real dirty_cafe_sales.csv (uniform noise)", () => {
  const { rows, mapping } = getFixtureA();
  const findings = buildFindings(rows, mapping);

  it("calls the trend normal variation", () => {
    expect(findings.trend.label).toBe("normal variation");
    expect(findings.trend.isSignificant).toBe(false);
  });

  it("treats the tiny volume gap as uniform via the effect-size floor, not significance", () => {
    // Real-file regression: with n≈9,000 chi-square is significant (p<0.05) on a trivial
    // ~10% spread. The max/min effect-size floor is what correctly keeps it uniform.
    expect(findings.category.p).toBeLessThan(THRESHOLDS.categoryP);
    expect(findings.category.volumeUniform).toBe(true);
  });

  it("finds no weekday seasonality; cannot test month on one year of data", () => {
    // The cafe file spans a single year, so the month grain (monthly totals, ≥2 years) is
    // untestable — "insufficient", NOT "none". Weekday runs on daily totals and finds nothing.
    expect(findings.seasonality.month.label).toBe("insufficient");
    expect(findings.seasonality.dayOfWeek.label).toBe("none");
  });

  it("finds no holiday lift", () => {
    expect(findings.holiday.label).toBe("no_lift");
  });

  it("flags Salad's revenue lead as price-driven, not demand", () => {
    expect(findings.category.volumeUniform).toBe(true);
    expect(findings.category.revenueLeader).toBe(leaderBy(rows, mapping.product, mapping.revenue));
    expect(findings.category.leaderFixedPrice).toBe(true);
    expect(findings.category.priceDriven).toBe(true);
    expect(findings.category.isSignificant).toBe(false);
  });

  it("narration contract bans the noise vocabulary and mandates the Salad caveat", () => {
    const contract = buildNarrationContract(findings).toLowerCase();
    expect(contract).toContain("normal variation");
    expect(contract).toContain((findings.category.revenueLeader ?? "").toLowerCase());
    expect(contract).toContain("unit price");
    // Every non-significant concept must contribute a ban.
    const concepts = activeBans(findings).map((b) => b.concept);
    expect(concepts).toContain("trend");
    expect(concepts).toContain("seasonality");
    expect(concepts).toContain("holiday");
    expect(concepts).toContain("price-driven leader");
  });

  it("linter REJECTS the buggy baseline report", () => {
    const result = lintReport(BAD_BASELINE, findings);
    expect(result.ok).toBe(false);
    const joined = result.violations.map((v) => v.detail).join(" ").toLowerCase();
    expect(joined).toContain("momentum");
    expect(joined).toContain("seasonal");
    const leader = (findings.category.revenueLeader ?? "").toLowerCase();
    expect(joined).toContain(`upsell ${leader}`);
  });

  it("linter ACCEPTS a contract-compliant report", () => {
    const good = `Executive Summary: revenue is flat — normal variation month to month, with no detectable seasonal, weekday, or holiday pattern.
Salad ranks #1 in revenue only because of its unit price, not because it sells more units; do not treat it as a demand play.
Forecast outlook: normal variation. Trend section: normal variation.`;
    const result = lintReport(good, findings);
    expect(result.ok).toBe(true);
  });
});

describe("Fixture B — planted signal (over-correction guard)", () => {
  const { rows, mapping } = getFixtureB();
  const findings = buildFindings(rows, mapping);

  it("detects the real upward trend", () => {
    expect(findings.trend.isSignificant).toBe(true);
    expect(findings.trend.direction).toBe("up");
    expect(findings.trend.label).toBe("upward trend");
  });

  it("cannot test the month grain on a single year (insufficient, not detected)", () => {
    // Fixture B is ONE year. A December that is 2× every other month is, on one cycle, an
    // anecdote: the month test runs on monthly totals and needs ≥2 complete years to separate a
    // recurring season from a one-off. The honest verdict is "insufficient", never "detected".
    expect(findings.seasonality.month.label).toBe("insufficient");
    expect(findings.seasonality.month.isSignificant).toBe(false);
  });

  it("detects the weekend lift (weekday grain has ample within-year replicates)", () => {
    expect(findings.seasonality.dayOfWeek.isSignificant).toBe(true);
    expect(findings.seasonality.dayOfWeek.label).toBe("detected");
    expect(["Saturday", "Sunday"]).toContain(findings.seasonality.dayOfWeek.high);
  });

  it("detects the high-volume product (clears the effect-size floor)", () => {
    // Over-correction guard: the planted 5× winner must clear the same max/min floor that
    // suppressed Fixture A's 10% noise — proving the floor discriminates signal from noise.
    expect(findings.category.isSignificant).toBe(true);
    expect(findings.category.volumeUniform).toBe(false);
    expect(findings.category.volumeLeader).toBe(leaderBy(rows, mapping.product, mapping.quantity));
  });

  it("the weekend effect clears the significance/η² floor", () => {
    expect(findings.seasonality.dayOfWeek.p).toBeLessThan(THRESHOLDS.seasonalityP);
  });
});

describe("Fixture F — genuine recurring month season across multiple years", () => {
  const { rows, mapping } = getFixtureF();
  const findings = buildFindings(rows, mapping);

  it("detects the recurring December lift on the month grain (≥2 complete years)", () => {
    // The complement to Fixture B: the SAME December lift, but repeated over three full years,
    // is now a testable, recurring season. The month grain must detect it and name December.
    expect(findings.seasonality.month.label).toBe("detected");
    expect(findings.seasonality.month.isSignificant).toBe(true);
    expect(findings.seasonality.month.high).toBe(FIXTURE_F_HIGH_MONTH);
    expect(findings.seasonality.month.p).toBeLessThan(THRESHOLDS.seasonalityP);
  });

  it("finds no weekday pattern (none was planted)", () => {
    expect(findings.seasonality.dayOfWeek.isSignificant).toBe(false);
  });
});

describe("Fixture C — consistency", () => {
  const { rows, mapping } = getFixtureA();
  const findings = buildFindings(rows, mapping);

  it("renders one trend label across all three sections", () => {
    const label = findings.trend.label;
    const sections = [
      { name: "Executive Summary", text: `Overall the data is ${label}.` },
      { name: "Forecast Outlook", text: `Outlook: ${label}.` },
      { name: "Trend Section", text: `The series is ${label}.` },
    ];
    expect(assertTrendConsistency(sections, findings).ok).toBe(true);
  });

  it("catches a self-contradicting report", () => {
    const sections = [
      { name: "Executive Summary", text: "Overall the data is normal variation." },
      { name: "Forecast Outlook", text: "Outlook: downward trend." },
      { name: "Trend Section", text: "The series is normal variation." },
    ];
    expect(assertTrendConsistency(sections, findings).ok).toBe(false);
  });

  it("lintReport passes on contract-compliant text for both fixtures", () => {
    const b = buildFindings(getFixtureB().rows, getFixtureB().mapping);
    expect(lintReport("Revenue shows a real upward trend driven by strong demand.", b).ok).toBe(true);
    expect(lintReport("Revenue is flat; normal variation with no seasonal pattern.", findings).ok).toBe(true);
  });
});
