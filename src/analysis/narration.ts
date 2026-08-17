// Layer 3 (deterministic half) — the narration contract. The BYOK LLM is handed the
// Findings object as its ONLY source of facts plus this contract; it may rephrase but
// never re-derive. The same banned vocabulary drives the Layer-4 linter (lintReport),
// so what the model is told not to say and what we reject are always in sync.

import type { Findings } from "./findings";

// Words/phrases that imply real signal. Each group is forbidden when its verdict is
// non-significant. Lowercased; matched case-insensitively.
export const BANNED_VOCAB = {
  trend: [
    "momentum",
    "surge",
    "surging",
    "accelerating",
    "strong growth",
    "upward trend",
    "downward trend",
    "declining trend",
    "rising trend",
    "trending up",
    "trending down",
    "gaining steam",
    "trajectory",
  ],
  seasonality: [
    "seasonal",
    "seasonality",
    "seasonal vulnerability",
    "seasonal dip",
    "seasonal peak",
    "vulnerability",
    "off-season",
  ],
  holiday: [
    "valentine",
    "holiday special",
    "holiday boost",
    "holiday lift",
    "christmas special",
    "holiday spike",
  ],
  // Applied when the revenue leader is price-driven, not demand-driven.
  priceLeader: [
    "premium pricing",
    "premium-pricing",
    "key driver",
    "is a driver",
    "demand for",
    "capitalize on",
    "popular item",
    "best seller",
    "bestseller",
    "customer favorite",
  ],
  // Applied when the FINAL period is incomplete. Its lower value is a truncation artifact, so
  // any directional-decline language about "the latest period" is a lie. Bare "drop" is left
  // out deliberately — it legitimately describes an outlier elsewhere; these are the words that
  // only ever mean "the series went down".
  partialPeriod: [
    "decline",
    "declining",
    "declined",
    "downward",
    "downturn",
    "shrinking",
    "shrank",
    "contracting",
    "investigate the drop",
    "investigate the decline",
  ],
} as const;

// The list of (concept, banned phrases) that are active for a given Findings object —
// only the non-significant verdicts contribute. Shared by the contract and the linter.
export function activeBans(findings: Findings): { concept: string; phrases: string[] }[] {
  const bans: { concept: string; phrases: string[] }[] = [];
  if (!findings.trend.isSignificant) bans.push({ concept: "trend", phrases: [...BANNED_VOCAB.trend] });
  if (!findings.seasonality.month.isSignificant && !findings.seasonality.dayOfWeek.isSignificant) {
    bans.push({ concept: "seasonality", phrases: [...BANNED_VOCAB.seasonality] });
  }
  if (!findings.holiday.isSignificant) bans.push({ concept: "holiday", phrases: [...BANNED_VOCAB.holiday] });
  if (findings.category.priceDriven) {
    const leader = findings.category.revenueLeader;
    const phrases: string[] = [...BANNED_VOCAB.priceLeader];
    if (leader) phrases.push(`upsell ${leader}`.toLowerCase(), `upselling ${leader}`.toLowerCase());
    bans.push({ concept: "price-driven leader", phrases });
  }
  if (findings.latestPeriodPartial) {
    bans.push({ concept: "incomplete final period", phrases: [...BANNED_VOCAB.partialPeriod] });
  }
  return bans;
}

export function buildNarrationContract(findings: Findings): string {
  const f = findings;
  const lines: string[] = [
    "=== NARRATION CONTRACT (mandatory) ===",
    "These statistical verdicts are the ONLY source of truth about patterns. You may rephrase them but must NOT re-derive, contradict, or invent new patterns from the raw numbers.",
    "",
    `TREND: ${f.trend.label} (${f.trend.detail})`,
    `SEASONALITY (month): ${f.seasonality.month.label} (${f.seasonality.month.detail})`,
    `SEASONALITY (weekday): ${f.seasonality.dayOfWeek.label} (${f.seasonality.dayOfWeek.detail})`,
    `HOLIDAY: ${f.holiday.label} (${f.holiday.detail})`,
    `CATEGORY: ${f.category.detail}`,
    "",
    "RULES:",
    `- The trend MUST be described as "${f.trend.label}" everywhere. Use these exact words in the executive summary, the forecast outlook, and the trend section.`,
  ];

  const bans = activeBans(f);
  if (bans.length > 0) {
    lines.push("- Do NOT use any of these words/phrases (the pattern they imply is NOT statistically present):");
    for (const b of bans) lines.push(`    [${b.concept}] ${b.phrases.join(", ")}`);
  }

  if (f.category.priceDriven && f.category.revenueLeader) {
    lines.push(
      `- "${f.category.revenueLeader}" ranks #1 in revenue ONLY because of its unit price, not demand. ` +
        `You MUST state this, and you MUST NOT recommend upselling it as a demand play.`,
    );
  }

  // FIX 3 — the contract rules that demote the model from analyst to translator. They are
  // stated unconditionally so the model never has to infer them from the verdicts.
  lines.push(
    "",
    "ADDITIONAL RULES (mandatory):",
    "- Narrate ONLY the findings, risks, and recommendations given here. Do NOT compute, derive, or add any number or claim not present.",
    "- If the trend is normal variation OR the latest period is incomplete: do NOT say decline/drop/down/growth/momentum and do NOT recommend investigating a change. State it as normal variation; if the latest period is incomplete, say it is not comparable.",
    "- If seasonality is \"none\": do NOT assert a seasonal pattern, name a peak month, or recommend a season-based action.",
    "- If month seasonality is \"insufficient\": the data does NOT span enough complete years to test it. Say it cannot be assessed yet (not that there is no seasonality), and do NOT name a peak month or recommend a season-based action.",
    "- If a dimension is uniform/balanced: do NOT call it concentration, dependency, or over-reliance.",
    "- Do NOT characterize a value range, price, or spread as a risk, inconsistency, or volatility unless it appears in RISKS below.",
    "- Never claim you verified anything. When a section has no supported finding, state the supported fact plainly rather than filling space.",
  );

  // FIX 2 — risks and recommendations are DATA. The model may narrate ONLY these.
  lines.push("", "RISKS (the ONLY risks you may state — narrate these, invent none):");
  if (f.risks.length === 0) {
    lines.push(
      "    (none) — do not state any risk, inconsistency, volatility, or dependency. A value being high or a range being wide is NOT a risk.",
    );
  } else {
    for (const r of f.risks) lines.push(`    [${r.key}] (${r.severity}) ${r.text}`);
  }

  lines.push("", "RECOMMENDATIONS (base every action ONLY on these):");
  if (f.recommendationBases.length === 0) {
    lines.push(
      "    (none) — if nothing is supported, recommend only verifying data quality; do not manufacture an action.",
    );
  } else {
    for (const rb of f.recommendationBases) lines.push(`    [${rb.key}] ${rb.text}`);
  }

  const allFlat =
    !f.trend.isSignificant &&
    !f.seasonality.month.isSignificant &&
    !f.seasonality.dayOfWeek.isSignificant &&
    !f.holiday.isSignificant &&
    !f.category.isSignificant;
  if (allFlat) {
    lines.push(
      "",
      "- Nothing in this data is statistically significant. The correct, complete report says so plainly " +
        '(e.g. "revenue is flat; no detectable seasonal, weekday, or holiday pattern"). That is a valid report, not a gap to fill.',
    );
  }

  return lines.join("\n");
}
