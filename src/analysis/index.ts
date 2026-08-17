// The single public boundary of the analysis pipeline. Every surface (dashboard, AI
// report, forecast, Talk-to-Data, exec summary, rec cards, Explore) should import from
// THIS module — never reach into raw rows or re-derive verdicts inline. `analyze()` returns
// one typed object carrying the cleaned dataset and the Findings ledger together, so render
// and narration code consumes the same canonical view and a fix in one place propagates
// everywhere. That structural chokepoint is what stops surfaces from diverging.

import { canonicalRows } from "../metrics";
import { buildFindings, type Findings, type FindingsMapping } from "./findings";

export {
  buildFindings,
  deriveRisksAndRecommendations,
  type Findings,
  type FindingsMapping,
  type FindingKey,
  type Risk,
  type RecommendationBasis,
} from "./findings";
export {
  reconcileReport,
  findingsRegistry,
  type RenderedNumber,
  type RenderedClaim,
  type ReconViolation,
  type ReconResult,
} from "./reconcile";
export {
  buildNarrationContract,
  activeBans,
} from "./narration";
export {
  lintReport,
  assertTrendConsistency,
  sanitizeNarration,
  type LintResult,
  type LintViolation,
} from "./lintReport";
export {
  validateChartSeries,
  type ChartPoint,
  type ChartValidation,
} from "./chartGuard";
export {
  THRESHOLDS,
  entityOutliers,
  periodCompleteness,
  type EntitySignal,
  type EntitySignalsVerdict,
  type PeriodObservation,
  type PeriodCompletenessVerdict,
} from "./verdicts";

// The one object that crosses the boundary: a cleaned dataset paired with its verdicts.
// Holding both together (rather than passing raw rows around) is what lets a surface render
// charts and narrate findings from a single, already-gated source.
export type AnalysisResult = {
  cleanedRows: Record<string, string>[];
  findings: Findings;
};

export function analyze(
  rows: Record<string, string>[],
  mapping: FindingsMapping,
): AnalysisResult {
  return {
    cleanedRows: canonicalRows(rows, mapping as Record<string, string | undefined>),
    findings: buildFindings(rows, mapping),
  };
}
