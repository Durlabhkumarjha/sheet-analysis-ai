// Wiring verification — proves the PRODUCTION surfaces actually consume the shared pipeline,
// not just that the shared library passes its own unit tests.
//
// Architectural reality (documented in docs/pipeline-audit.md): every surface lives as a
// function inside the single src/App.tsx monolith — there are no per-surface files. So the
// audit adapts:
//   • Static: App.tsx imports the boundary; the forked trend heuristic is module-private;
//     the analysis layer never imports the raw parser.
//   • Runtime spies: the chart surface routes through validateChartSeries; the Talk-to-Data
//     fallback routes its narration through sanitizeNarration.
//   • Strip-replaces-with-truth: on the flat fixture every narrated surface is non-empty,
//     lint-clean (no claim the verdict engine ruled out survives), and the trend-bearing
//     surfaces carry the canonical verdict label instead of going to a stub.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Shared spies, hoisted so the vi.mock factories (which run before imports) can see them.
const spies = vi.hoisted(() => ({
  validateChartSeries: vi.fn(),
  sanitizeNarration: vi.fn(),
}));

// Wrap the real shared functions so we can prove App.tsx calls THEM at runtime (the spy
// replaces the very binding App imports), while still exercising the real implementation.
vi.mock("../src/analysis/chartGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/analysis/chartGuard")>();
  return {
    ...actual,
    validateChartSeries: (...args: Parameters<typeof actual.validateChartSeries>) => {
      spies.validateChartSeries(...args);
      return actual.validateChartSeries(...args);
    },
  };
});

vi.mock("../src/analysis/lintReport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/analysis/lintReport")>();
  return {
    ...actual,
    sanitizeNarration: (...args: Parameters<typeof actual.sanitizeNarration>) => {
      spies.sanitizeNarration(...args);
      return actual.sanitizeNarration(...args);
    },
  };
});

import {
  analyzeData,
  guardBars,
  answerQuestion,
  createExecutiveSummary,
  getRecommendedActions,
  generateSmartInsights,
  smartAnswer,
  resolveTrendChartLabel,
  type Mapping,
  type ReportSettings,
} from "../src/App";
import { buildFindings } from "../src/analysis/findings";
import { lintReport } from "../src/analysis/lintReport";
import { getFixtureA, getFixtureB, getFixtureD } from "./fixtures/gen";

// ---- shared fixtures -------------------------------------------------------
const FIX = getFixtureA();
const MAPPING: Mapping = {
  ignore: "",
  date: FIX.mapping.date,
  revenue: FIX.mapping.revenue,
  quantity: FIX.mapping.quantity,
  product: FIX.mapping.product,
  customer: "",
  region: "",
  cost: "",
  profit: "",
  discount: "",
  orderId: "",
};
const SETTINGS: ReportSettings = {
  title: "T",
  company: "C",
  currency: "USD",
  template: "general",
  brandColor: "#000000",
};
const findings = buildFindings(FIX.rows, FIX.mapping);
const analysis = analyzeData(FIX.rows, MAPPING)!;

const APP_SRC = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");

// The analysis pipeline — must stay parser-free so raw rows reach it only after upload.
const ANALYSIS_FILES = [
  "../src/metrics.ts",
  "../src/analysis/index.ts",
  "../src/analysis/stats.ts",
  "../src/analysis/verdicts.ts",
  "../src/analysis/findings.ts",
  "../src/analysis/narration.ts",
  "../src/analysis/lintReport.ts",
  "../src/analysis/chartGuard.ts",
];

describe("TASK 1 — static wiring audit", () => {
  it("the surface monolith imports the shared pipeline boundary", () => {
    expect(APP_SRC).toMatch(/from\s+["']\.\/analysis\/chartGuard["']/);
    expect(APP_SRC).toMatch(/from\s+["']\.\/analysis\/lintReport["']/);
    expect(APP_SRC).toMatch(/from\s+["']\.\/analysis\/findings["']/);
    expect(APP_SRC).toContain("validateChartSeries");
    expect(APP_SRC).toContain("sanitizeNarration");
    expect(APP_SRC).toContain("buildFindings");
  });

  it("the forked trend heuristic is module-private — it can never be a surface's public path", () => {
    // Option-2 stance: isTrendFlat survives only as the no-data fallback (findings === null).
    // It must not be exported, so no other module can adopt the fork; the behavioral tests
    // below prove it is inert whenever real findings exist.
    expect(APP_SRC).not.toMatch(/export\s+function\s+isTrendFlat/);
    expect(APP_SRC).toMatch(/function\s+isTrendFlat/); // still present, as the documented fallback
  });

  it("the analysis layer never imports the raw CSV/XLSX parser", () => {
    for (const rel of ANALYSIS_FILES) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src, `${rel} must not import the parser`).not.toMatch(/\bxlsx\b/i);
      expect(src, `${rel} must not import a worker`).not.toMatch(/csv-worker|analysis-worker/);
    }
  });
});

describe("TASK 2 — runtime call-path proof (spies)", () => {
  beforeEach(() => {
    spies.validateChartSeries.mockClear();
    spies.sanitizeNarration.mockClear();
  });

  it("the chart surface (guardBars) actually calls validateChartSeries and drops junk", () => {
    const out = guardBars([
      { label: "A", revenue: 10 },
      { label: "ERROR", revenue: 5 },
      { label: "B", revenue: 7 },
    ]);
    expect(spies.validateChartSeries).toHaveBeenCalled();
    expect(out.map((o) => o.label)).not.toContain("ERROR");
  });

  it("Talk-to-Data (smartAnswer rule-based fallback) routes narration through sanitizeNarration", async () => {
    // dataSet=null forces the deterministic fallback (no network), which — after the wiring
    // fix — runs the rule-based answer through the same Layer-4 sanitizer as the AI path.
    const res = await smartAnswer(
      "what's the trend over time?",
      analysis,
      SETTINGS,
      null,
      MAPPING,
      [],
      [],
      [],
      "sum",
      [],
      findings,
    );
    expect(spies.sanitizeNarration).toHaveBeenCalled();
    expect(res.text.trim().length).toBeGreaterThan(0);
  });
});

describe("TASK 3 — strip replaces lies with the verdict (surfaces never go empty on flat data)", () => {
  const LABEL = findings.trend.label;

  it("the fixture is genuinely flat", () => {
    expect(LABEL).toBe("normal variation");
  });

  it("executive summary: non-empty, carries the canonical label, lint-clean", () => {
    const t = createExecutiveSummary(analysis, SETTINGS, MAPPING, findings);
    expect(t.trim().length).toBeGreaterThan(0);
    expect(t.toLowerCase()).toContain(LABEL);
    expect(lintReport(t, findings).ok).toBe(true);
  });

  it("Talk-to-Data trend answer: non-empty, carries the label, lint-clean", () => {
    const t = answerQuestion("what's the trend over time?", analysis, SETTINGS, MAPPING, [], findings);
    expect(t.trim().length).toBeGreaterThan(0);
    expect(t.toLowerCase()).toContain(LABEL);
    expect(lintReport(t, findings).ok).toBe(true);
  });

  it("recommendation cards: non-empty, carry the verdict, lint-clean", () => {
    const actions = getRecommendedActions(analysis, SETTINGS, findings);
    expect(actions.length).toBeGreaterThan(0);
    const joined = actions.map((a) => `${a.title}. ${a.detail}`).join(" ");
    expect(joined.toLowerCase()).toContain(LABEL);
    expect(lintReport(joined, findings).ok).toBe(true);
  });

  it("Explore insights: non-empty and lint-clean (the flat-trend insight is correctly omitted, not lied about)", () => {
    const ins = generateSmartInsights(analysis, SETTINGS, FIX.rows, MAPPING, findings);
    expect(ins.length).toBeGreaterThan(0);
    const joined = ins.map((i) => i.text).join(" ");
    expect(lintReport(joined, findings).ok).toBe(true);
  });

  it("chart trend label obeys the verdict and ignores raw slope on a flat file", () => {
    // The contradiction this guards: a flat verdict with endpoints that differ by a lot.
    // The verdict must win — no ↑/↓ glyph, no slope number — regardless of slopePct.
    for (const slope of [50, -50, 3, 0]) {
      const label = resolveTrendChartLabel(findings.trend.label, slope);
      expect(label).toBe("→ flat / normal variation");
      expect(label).not.toMatch(/[↑↓]/);
    }
  });
});

// The cross-surface trend-direction guard: the chart label, the recommendation cards, and the
// executive summary must all agree with the ONE verdict — proven on a flat file (Fixture A), a
// real downward trend (Fixture D), and a real upward trend (Fixture B). Direction is derived
// from each fixture's own verdict, never hardcoded.
describe("TASK 4 — chart label + cards + exec summary never contradict the trend verdict", () => {
  const GLYPH: Record<string, RegExp> = {
    up: /↑/,
    down: /↓/,
    flat: /→ flat/,
  };
  const OPPOSITE_PROSE: Record<string, RegExp> = {
    up: /\bdownward trend\b/i,
    down: /\bupward trend\b/i,
    flat: /\b(upward|downward) trend\b/i,
  };

  for (const [name, fx] of [
    ["A (flat)", getFixtureA()],
    ["D (downward)", getFixtureD()],
    ["B (upward)", getFixtureB()],
  ] as const) {
    const findings = buildFindings(fx.rows, fx.mapping);
    const mapping: Mapping = { ...MAPPING, date: fx.mapping.date, revenue: fx.mapping.revenue, quantity: fx.mapping.quantity, product: fx.mapping.product };
    const analysis = analyzeData(fx.rows, mapping)!;
    const dir = findings.trend.direction; // "up" | "down" | "flat"

    it(`Fixture ${name}: chart label matches verdict direction (${name})`, () => {
      // A genuinely up/down series has a non-zero raw slope; the flat one shows the flat label.
      const slope = dir === "up" ? 8 : dir === "down" ? -8 : 5;
      const label = resolveTrendChartLabel(findings.trend.label, slope);
      expect(label).toMatch(GLYPH[dir]);
      // It must never carry the OPPOSITE direction's glyph.
      if (dir === "up") expect(label).not.toMatch(/↓/);
      if (dir === "down") expect(label).not.toMatch(/↑/);
      if (dir === "flat") expect(label).not.toMatch(/[↑↓]/);
    });

    it(`Fixture ${name}: cards + exec summary carry no claim opposite to the verdict`, () => {
      const exec = createExecutiveSummary(analysis, SETTINGS, mapping, findings);
      const cards = getRecommendedActions(analysis, SETTINGS, findings)
        .map((a) => `${a.title}. ${a.detail}`)
        .join(" ");
      const both = `${exec} ${cards}`;
      expect(both).not.toMatch(OPPOSITE_PROSE[dir]);
      expect(lintReport(exec, findings).ok).toBe(true);
      expect(lintReport(cards, findings).ok).toBe(true);
    });
  }
});
