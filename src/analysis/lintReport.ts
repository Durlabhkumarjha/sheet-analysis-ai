// Layer 4 — the consistency linter. Deterministic, no LLM. Runs over the final
// assembled report text and fails on (a) any banned phrase whose pattern is not
// statistically present, and (b) a trend label that is not identical across the
// sections that must agree. This is the regression guard the tests assert on.

import type { Findings } from "./findings";
import { activeBans } from "./narration";

export type LintViolation = { rule: "banned-phrase" | "trend-inconsistency"; detail: string };
export type LintResult = { ok: boolean; violations: LintViolation[] };

const ALL_TREND_LABELS = ["upward trend", "downward trend", "normal variation"];

// A banned phrase is allowed when it is negated — "no seasonal pattern" correctly states
// the absence of a pattern, whereas "seasonal vulnerability" asserts one. We look back a
// short window before each match for a negator so reports can (and should) say "no X".
const NEGATORS = ["no ", "not ", "n't ", "without ", "lack", "absence", "nothing", "no detectable", "isn't", "aren't", "non-"];

function isNegated(haystack: string, matchIndex: number): boolean {
  const window = haystack.slice(Math.max(0, matchIndex - 40), matchIndex);
  return NEGATORS.some((neg) => window.includes(neg));
}

// (a) Banned-phrase scan. A report concerns exactly one dataset, so any phrase implying
// a pattern necessarily refers to the (non-significant) metric — we reject it wherever
// it appears (unless negated) rather than guessing proximity windows that prose defeats.
export function lintReport(text: string, findings: Findings): LintResult {
  const haystack = text.toLowerCase();
  const violations: LintViolation[] = [];

  for (const ban of activeBans(findings)) {
    for (const phrase of ban.phrases) {
      if (!phrase) continue;
      let from = 0;
      let idx = haystack.indexOf(phrase, from);
      while (idx !== -1) {
        if (!isNegated(haystack, idx)) {
          violations.push({
            rule: "banned-phrase",
            detail: `"${phrase}" appears but ${ban.concept} is not statistically significant.`,
          });
          break; // one violation per phrase is enough
        }
        from = idx + phrase.length;
        idx = haystack.indexOf(phrase, from);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// Runtime sanitizer — the shared mechanism every narrated surface (report, exec box,
// recommendation cards, Talk-to-Data) routes its final text through. It drops any sentence
// that carries a non-negated active banned phrase, so output is guaranteed to pass
// lintReport. Deterministic, no LLM: the same bans that fail the linter remove the sentence.
export function sanitizeNarration(text: string, findings: Findings): { text: string; removed: string[] } {
  const bans = activeBans(findings);
  if (bans.length === 0) return { text, removed: [] };

  const removed: string[] = [];
  const offends = (sentence: string): boolean => {
    const lower = sentence.toLowerCase();
    for (const ban of bans) {
      for (const phrase of ban.phrases) {
        if (!phrase) continue;
        const idx = lower.indexOf(phrase);
        if (idx !== -1 && !isNegated(lower, idx)) return true;
      }
    }
    return false;
  };

  // Process paragraph by paragraph so list/line structure survives, splitting each into
  // sentence-ish chunks on terminal punctuation.
  const cleanedParas = text.split(/\n+/).map((para) => {
    const parts = para.split(/(?<=[.!?])\s+/);
    const kept = parts.filter((s) => {
      if (s.trim() && offends(s)) {
        removed.push(s.trim());
        return false;
      }
      return true;
    });
    return kept.join(" ");
  });

  const cleaned = cleanedParas.filter((p) => p.trim().length > 0).join("\n");
  return { text: cleaned, removed };
}

// (b) Trend-label consistency. Each passed section must contain the canonical trend
// label and must NOT contain a different trend label. Use for exec summary, forecast
// outlook, and the trend section.
export function assertTrendConsistency(
  sections: { name: string; text: string }[],
  findings: Findings,
): LintResult {
  const canonical = findings.trend.label;
  const violations: LintViolation[] = [];
  const others = ALL_TREND_LABELS.filter((l) => l !== canonical);

  for (const section of sections) {
    const lower = section.text.toLowerCase();
    if (!lower.includes(canonical)) {
      violations.push({
        rule: "trend-inconsistency",
        detail: `Section "${section.name}" is missing the canonical trend label "${canonical}".`,
      });
    }
    for (const other of others) {
      if (lower.includes(other)) {
        violations.push({
          rule: "trend-inconsistency",
          detail: `Section "${section.name}" uses "${other}" but the canonical label is "${canonical}".`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
