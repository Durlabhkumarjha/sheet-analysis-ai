import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  INVALID_BUCKET,
  isInvalidCategory,
  cleanCategory,
  isJunkLabel,
  toNumber,
  hasNumericValue,
  parseValidDate,
  inferDayFirst,
  canonicalRows,
  identifiedTotal,
  dimensionShare,
  realItems,
  computeShares,
} from "./metrics";
import { buildFindings, type Findings } from "./analysis/findings";
import { buildNarrationContract } from "./analysis/narration";
import { importFromGoogleSheets, isGoogleSheetsConfigured } from "./googleSheets";
import { sanitizeNarration } from "./analysis/lintReport";
import { validateChartSeries } from "./analysis/chartGuard";
import { THRESHOLDS } from "./analysis/verdicts";
import { buildAuditProfile } from "./analysis/auditAdapter";
import { runAudit, type LedgerFinding, type AuditVerdict, type AuditViolation } from "./analysis/reconcile";
import { detectHeaderRow, looksLikePerUnitPrice, isTierableDimension } from "./dataQuality";

// Open-source build: no hosted backend. AI features run entirely bring-your-own-key —
// requests go straight from your browser to your own AI provider. Set VITE_AI_WORKER_URL
// only if you deploy your own proxy worker; otherwise it stays empty (BYOK mode).
const AI_WORKER_URL = (import.meta.env.VITE_AI_WORKER_URL as string | undefined) || "";
const AI_WORKER_ENABLED = AI_WORKER_URL.length > 0;

function getUserId(): string {
  let id = localStorage.getItem("sai_user_id");
  if (!id) {
    id = "sai_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 10);
    localStorage.setItem("sai_user_id", id);
  }
  return id;
}

let _onCreditsUpdate: ((remaining: number) => void) | null = null;

// Calls the Worker for one small AI task. Returns parsed JSON, or null if the
// Worker is unreachable / errored — callers must handle null with a fallback.
async function callSmartAI<T = Record<string, unknown>>(
  task: string,
  data: Record<string, unknown>
): Promise<T | null> {
  if (!AI_WORKER_URL) return null;
  try {
    const response = await fetch(AI_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, userId: getUserId(), ...data })
    });
    if (response.status === 402) {
      const err = (await response.json()) as { error: string; remaining?: number };
      if (err.error === "no_credits" && _onCreditsUpdate) _onCreditsUpdate(0);
      return null;
    }
    if (!response.ok) return null;
    const result = (await response.json()) as T & { error?: string; _credits?: { remaining: number } };
    if (result && result.error) return null;
    if (result?._credits && _onCreditsUpdate) {
      _onCreditsUpdate(result._credits.remaining >= 0 ? result._credits.remaining : Infinity);
    }
    return result;
  } catch {
    return null;
  }
}

// Redeems a single-use license code (e.g. an AppSumo code) against the Worker,
// upgrading this browser's user to the paid plan. The Worker binds the code to
// the userId and returns the new balance.
async function redeemCode(code: string): Promise<{ ok: boolean; message: string; remaining?: number }> {
  if (!AI_WORKER_URL) return { ok: false, message: "Redemption isn't available right now." };
  try {
    const response = await fetch(AI_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redeem: code, userId: getUserId() })
    });
    const result = (await response.json()) as { redeemed?: boolean; restored?: boolean; message?: string; _credits?: { remaining: number } };
    if (result.redeemed) {
      return {
        ok: true,
        message: result.message || (result.restored ? "Access restored — your credits are back." : "Code redeemed — your AI actions are active."),
        remaining: result._credits?.remaining
      };
    }
    return { ok: false, message: result.message || "That code isn't valid." };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Try again." };
  }
}

type AICodeResult = {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  elapsed?: number;
};

function runAICodeSafe(
  code: string,
  rows: Record<string, string>[],
  mapping: Record<string, string>
): Promise<AICodeResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./analysis-worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      resolve({ success: false, error: "Analysis timed out" });
    }, 10000);

    worker.onmessage = (e: MessageEvent<AICodeResult>) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve({ success: false, error: e.message || "Worker error" });
    };
    worker.postMessage({ code, rows, mapping });
  });
}

type Role =
  | "ignore"
  | "date"
  | "revenue"
  | "quantity"
  | "product"
  | "customer"
  | "region"
  | "cost"
  | "profit"
  | "discount"
  | "orderId";

type Polarity = "higher_is_better" | "higher_is_worse" | "neutral";

type ColumnProfile = {
  name: string;
  guess: Role;
  confidence: number;
  type: "date" | "number" | "text" | "empty";
  missing: number;
  unique: number;
  examples: string[];
  // Enhanced profiler fields
  cardinality: number; // unique / nonEmpty (0..1). Low = good for grouping
  polarity: Polarity;
  // Numeric stats (only meaningful when type === "number")
  sum: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  skewness: number;
  q1: number;
  q3: number;
  iqr: number;
  outlierCount: number;
  varianceScore: number; // normalized stdDev/mean — high = interesting to chart
  // Date stats (only meaningful when type === "date")
  granularity: "daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "unknown";
  isMonotonic: boolean;
  // Categorical stats (only meaningful when type === "text")
  dominantValue: { value: string; pct: number } | null;
  concentrationScore: number; // Herfindahl index — high = dominated by few values
};

type DataSet = {
  fileName: string;
  headers: string[];
  rows: Record<string, string>[];
  profiles: ColumnProfile[];
  quality: DataQualitySummary;
};

export type Mapping = Record<Role, string>;

type DataQualitySummary = {
  totalRows: number;
  blankRows: number;
  duplicateRows: number;
  possibleSummaryRows: number;
};

type ReportTemplate = "sales" | "ecommerce" | "expenses" | "client" | "general" | "marketing";

type MetricDirection = "up_is_good" | "down_is_good" | "context_dependent";

type TemplateConfig = {
  metricLabel: string | null;
  metricDirection: MetricDirection;
  dimensionLabels: { product: string; customer: string; region: string } | null;
  insightContext: string;
  rfmLabel: string;
  abcLabel: string;
  concentrationLabel: string;
};

export type ReportSettings = {
  title: string;
  company: string;
  currency: string;
  template: ReportTemplate;
  brandColor: string;
};

export type Analysis = {
  rowCount: number;
  primaryMetric: string; // label: "Revenue", "Quantity", or column name
  // True when the primary metric is money (render with a currency symbol). False for a plain
  // count OR a units column mislabelled as revenue (e.g. Global_Sales = millions of units, no
  // price column) — those must render as bare numbers. Single source of truth for every surface.
  isMoney: boolean;
  totalRevenue: number;
  averageRevenue: number;
  minRevenue: number;
  maxRevenue: number;
  bestPeriod: RankedItem | null;
  previousPeriod: RankedItem | null;
  latestPeriod: RankedItem | null;
  latestPeriodChange: number | null;
  periodRevenue: RankedItem[];
  productRevenue: RankedItem[];
  regionRevenue: RankedItem[];
  customerRevenue: RankedItem[];
  // Canonical rows whose product/item label is identified vs. unidentifiable (junk/blank).
  // Both sum to rowCount. Drive the total-vs-per-product reconciliation note.
  identifiedProductRows: number;
  unidentifiedProductRows: number;
  marginByProduct: RankedItem[];
  roiByProduct: RankedItem[];
  totalProfit: number | null;
  profitByProduct: RankedItem[];
  outliers: Outlier[];
  insights: string[];
};

type Outlier = {
  label: string;
  value: number;
  type: "high" | "low";
  context: string;
  rootCause?: string;
};

type TrustScore = {
  score: number;
  label: "High" | "Medium" | "Needs review";
  detail: string;
};

type ComparisonSummary = {
  currentLabel: string;
  previousLabel: string;
  currentRevenue: number;
  previousRevenue: number;
  revenueChange: number;
  topProductChange: RankedItem | null;
  topRegionChange: RankedItem | null;
};

type RankedItem = {
  label: string;
  revenue: number;
};

// Route an additive category series (product/region/customer revenue) through the single
// chart validator before rendering: drops junk buckets AND any grand-total row that equals
// the sum of its components. Maps RankedItem.revenue ↔ the validator's {label,value} shape
// and returns the surviving RankedItems in order. Only use for additive money/count series —
// not for non-additive ones (margin %, ROI %), where "value ≈ sum of others" is meaningless.
export function guardBars(items: RankedItem[]): RankedItem[] {
  const validated = validateChartSeries(items.map((i) => ({ label: i.label, value: i.revenue })));
  const keep = new Set(validated.items.map((v) => v.label));
  return items.filter((i) => keep.has(i.label));
}

type SmartChartRecommendation = {
  chartType: "line" | "horizontal_bar" | "donut" | "scatter" | "combo" | "pareto";
  title: string;
  question: string;
  priority: number;
  xRole: Role;
  yRole: Role;
  insights: SmartInsight[];
  annotations: string[];
  resolvedData?: RankedItem[];
  isMoney?: boolean;
  isAverage?: boolean;
};

type SmartInsight = {
  type: "headline" | "top_performer" | "risk" | "gap" | "underperformers" | "trend" | "outlier" | "comparison" | "correlation";
  text: string;
  importance: "high" | "medium" | "low";
  sentiment?: "positive" | "negative" | "neutral";
};

type SmartRecommendation = {
  priority: number;
  label: string;
  title: string;
  detail: string;
  impact: string;
};

type ChartInsightSummary = {
  question: string;
  top3: { name: string; value: number; pct_of_total: number }[];
  total_items: number;
  average_value: number;
};

type ChartConfigResponse = {
  chart_type?: string | null;
  x?: string | null;
  y?: string | null;
  aggregation?: string | null;
  group_by?: string | null;
  top_n?: number | null;
  sort?: string | null;
  title?: string | null;
};

type ChartCommand = {
  type: "bar" | "pie" | "donut" | "line" | "area" | "scatter" | "funnel" | "radar" | "table" | "pivot" | "combo" | "waterfall" | "horizontal_bar";
  title: string;
  data: { label: string; value: number; group?: string }[];
};

type ForecastResult = {
  method: "linear" | "exponential" | "seasonal";
  predictions: { label: string; value: number; lower: number; upper: number }[];
  confidence: "High" | "Medium" | "Low";
  trend: number;
  r2: number;
};

type RFMSegment = "Champion" | "Loyal" | "Potential" | "At Risk" | "Slipping" | "Lost" | "New";

type CustomerHealth = {
  name: string;
  lastPurchaseDate: string | null;
  transactionCount: number;
  totalRevenue: number;
  recency: number;
  frequency: number;
  monetary: number;
  rScore: number;
  fScore: number;
  mScore: number;
  segment: RFMSegment;
};

type ChatMessage = {
  id: string;
  role: "user" | "analyst";
  text: string;
  chart?: ChartCommand;
};

type AIProvider = "openai" | "gemini" | "groq" | "openrouter" | "deepseek" | "mistral";

type AISettings = {
  provider: AIProvider;
  apiKey: string;
  model: string;
};

type AgentId = "insight" | "anomaly" | "forecast" | "report" | "action";

type AgentResult = {
  agentId: AgentId;
  text: string;
  loading: boolean;
};

const AI_AGENTS: { id: AgentId; label: string; title: string; description: string; prompt: string }[] = [
  {
    id: "insight",
    label: "Explain",
    title: "Explain My Numbers",
    description: "Synthesizes all your dashboard results into a clear narrative",
    prompt: `You are a senior data analyst explaining business results to a non-technical owner. The dashboard has already computed all KPIs, profit, margin%, and product tiers. Your job is to SYNTHESIZE these into one cohesive story.

IMPORTANT: Use ONLY the pre-computed numbers provided. Do NOT calculate any figures yourself. Items marked [LOSS-MAKING] are losing money.

Write exactly 3 paragraphs:
1. **The Big Picture** — Overall health: revenue total, profit, margin%, and trend direction.
2. **The Story Behind The Numbers** — Connect product performance (including any loss-makers) to regional patterns. Use the provided profit and margin% figures.
3. **The One Thing That Matters Most** — The single most important insight: a risk, opportunity, or warning.

Keep it under 150 words total. Use exact numbers from the provided data only.`
  },
  {
    id: "anomaly",
    label: "Patterns",
    title: "Find Hidden Patterns",
    description: "Discovers things the rule engine can't — seasonal effects, basket analysis, unusual correlations",
    prompt: `You are a data scientist looking for hidden patterns that simple rule-based analysis would miss. The dashboard already shows obvious things (top product, best region, outliers). You need to find what's BENEATH the surface.

Look for:
1. **Seasonal patterns** — Do certain products sell more in certain periods? Are there weekly/monthly cycles?
2. **Product combinations** — Do certain products tend to be bought together or by the same customers?
3. **Customer behavior shifts** — Are buying patterns changing over time? New vs returning customer mix?
4. **Unexpected correlations** — Any surprising relationships between columns (e.g., discount levels correlating with larger orders)?
5. **Segment-specific trends** — Are some regions/products growing while others decline (hidden in the average)?

For each pattern found:
## [Pattern name]
- **What**: Describe the pattern in one sentence
- **Evidence**: Exact numbers
- **Business implication**: Why this matters

Only report patterns you're confident about. If the data is too small or simple for hidden patterns, say so honestly.`
  },
  {
    id: "report",
    label: "Report",
    title: "Write Client Report",
    description: "Professional 2-page report ready to email or PDF",
    prompt: `You are a management consultant writing a report for a client. Write a polished, professional document that could be sent directly as an email or printed as a one-page brief.

IMPORTANT: Every number in this report must come from the PRE-COMPUTED METRICS above. Do NOT calculate profit, margin, or ROI yourself. If a product is marked [LOSS-MAKING], describe it as losing money — never as having "margin".

## Performance Summary
2-3 sentences: total revenue, profit, margin%, growth direction.

## Key Highlights
- 3 bullet points on positive performance — each with a specific number from the data

## Areas Needing Attention
- 2-3 bullet points on concerns — mention any LOSS-MAKING items by name with their exact loss amount

## Product & Customer Health
One paragraph connecting product mix, customer concentration, and regional balance. Use the profit and margin% figures provided.

## Recommendations
1. **This week**: [specific action with named product/customer/region]
2. **This month**: [specific action]
3. **This quarter**: [specific action]

## Outlook
2 sentences: what to expect next period and the biggest factor that will determine success.

Write in a confident tone. Use exact numbers from the data only. Make it copy-paste ready for email.`
  },
  {
    id: "action",
    label: "Actions",
    title: "Give Me an Action Plan",
    description: "5 specific actions with impact estimates, owners, and timelines",
    prompt: `You are a business strategist. Deliver exactly 5 specific actions this business should take, ordered by expected revenue impact.

IMPORTANT: Use ONLY numbers from the PRE-COMPUTED METRICS. Do NOT calculate ROI, margin, or profit yourself. Items marked [LOSS-MAKING] are losing money — recommend investigating them, never describe them as profitable.

For each action:

## [Action number]: [Specific action title naming the product/customer/region]
- **Do this**: One concrete sentence — not vague. Name names.
- **Why** (data evidence): The exact number from the provided data that triggered this
- **Expected impact**: Use the provided profit/loss figures, not self-computed estimates
- **Priority**: High / Medium
- **Timeline**: This week / This month / This quarter

Rules:
- Every action must reference a specific data point from the provided metrics — no generic advice
- If loss-making items exist, one action must address them specifically
- Cover: 1 revenue protection, 1 growth, 1 risk reduction, 1 efficiency, 1 quick win
- Use the user's currency format`
  },
  {
    id: "forecast",
    label: "Benchmark",
    title: "How Am I Doing vs Industry?",
    description: "Benchmarks your metrics against typical industry ranges",
    prompt: `You are a business benchmarking consultant. Based on the data provided, assess how this business compares to typical industry ranges. Use your knowledge of business metrics to provide context the raw numbers can't show.

Evaluate these dimensions:

## Revenue Health
- Is the average order value typical for this type of business?
- Is the growth rate healthy, average, or concerning?

## Customer Metrics
- Is customer concentration (top 3 share) risky by industry standards?
- Is the number of customers relative to revenue healthy?

## Product Mix
- Is the product concentration (top product share) typical?
- How does the number of products compare to revenue level?

## Overall Grade
Give a letter grade (A through D) with a one-sentence justification.

## Biggest Gap vs Best-in-Class
What's the ONE metric where this business falls furthest behind top performers in its category? What's the target they should aim for?

Be honest. If you don't have enough context to benchmark (unusual industry, too few data points), say so rather than guessing.`
  }
];

const AI_MODELS: Record<AIProvider, { label: string; models: { id: string; label: string }[] }> = {
  openai: {
    label: "OpenAI",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
      { id: "gpt-4.1-nano", label: "GPT-4.1 Nano" }
    ]
  },
  gemini: {
    label: "Google Gemini",
    models: [
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro" }
    ]
  },
  groq: {
    label: "Groq (Fast)",
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (Free)" },
      { id: "mixtral-8x7b-32768", label: "Mixtral 8x7B" },
      { id: "gemma2-9b-it", label: "Gemma 2 9B" }
    ]
  },
  openrouter: {
    label: "OpenRouter (Multi-model)",
    models: [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "anthropic/claude-haiku-4", label: "Claude Haiku 4" },
      { id: "openai/gpt-4o", label: "GPT-4o" },
      { id: "google/gemini-2.0-flash-001", label: "Gemini 2.0 Flash" },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
      { id: "mistralai/mistral-large-latest", label: "Mistral Large" },
      { id: "deepseek/deepseek-chat-v3-0324", label: "DeepSeek V3" }
    ]
  },
  deepseek: {
    label: "DeepSeek",
    models: [
      { id: "deepseek-chat", label: "DeepSeek V3" },
      { id: "deepseek-reasoner", label: "DeepSeek R1 (Reasoning)" }
    ]
  },
  mistral: {
    label: "Mistral AI",
    models: [
      { id: "mistral-large-latest", label: "Mistral Large" },
      { id: "mistral-small-latest", label: "Mistral Small" },
      { id: "open-mistral-nemo", label: "Mistral Nemo (Free)" }
    ]
  }
};

const ROLE_LABELS: Record<Role, string> = {
  ignore: "Ignore",
  date: "Date",
  revenue: "Revenue / sales",
  quantity: "Quantity",
  product: "Product",
  customer: "Customer",
  region: "Region",
  cost: "Cost",
  profit: "Profit",
  discount: "Discount",
  orderId: "Order ID"
};

const REQUIRED_ROLES: Role[] = [];
const RECOMMENDED_ROLES: Role[] = ["date", "revenue", "product", "customer", "region", "quantity"];
const OPTIONAL_ROLES: Role[] = ["cost", "profit", "discount", "orderId"];
const ALL_MAPPABLE_ROLES: Role[] = ["date", "revenue", "product", "customer", "region", "quantity", "cost", "profit", "discount"];

const ROLE_HINTS: Record<string, string> = {
  date: "e.g. Order Date, Transaction Date, Invoice Date",
  revenue: "e.g. Sales, Amount, Total, Revenue, Price",
  product: "e.g. Product, Item, SKU, Category, Brand",
  customer: "e.g. Customer, Client, Buyer, Account",
  region: "e.g. Region, City, Country, State, Location",
  quantity: "e.g. Qty, Quantity, Units, Count, PCS",
  cost: "e.g. Cost, COGS, Unit Cost, Purchase Price",
  discount: "e.g. Discount, Rebate, Promo, Discount %",
  profit: "e.g. Profit, Margin, Net Profit",
  orderId: "e.g. Order ID, Invoice No, Transaction ID",
};

const TEMPLATE_LABELS: Record<ReportTemplate, string> = {
  sales: "Sales performance",
  general: "General report",
  ecommerce: "Ecommerce revenue",
  expenses: "Expense review",
  client: "Client update",
  marketing: "Marketing analysis"
};

const TEMPLATE_TITLES: Record<ReportTemplate, string> = {
  sales: "Sales Performance Report",
  general: "Data Analysis Report",
  ecommerce: "Ecommerce Report",
  expenses: "Expense Review Report",
  client: "Client Update Report",
  marketing: "Marketing Analysis Report"
};

function isDefaultTitle(title: string): boolean {
  return !title || Object.values(TEMPLATE_TITLES).some((t) => t.toLowerCase() === title.toLowerCase());
}

const TEMPLATE_CONFIG: Record<ReportTemplate, TemplateConfig> = {
  sales: {
    metricLabel: "Revenue",
    metricDirection: "up_is_good",
    dimensionLabels: { product: "Product", customer: "Customer", region: "Region" },
    insightContext: "sales",
    rfmLabel: "Customer health",
    abcLabel: "Product tiers",
    concentrationLabel: "Customer concentration",
  },
  ecommerce: {
    metricLabel: "Revenue",
    metricDirection: "up_is_good",
    dimensionLabels: { product: "Product", customer: "Customer", region: "Region" },
    insightContext: "sales",
    rfmLabel: "Customer health",
    abcLabel: "Product tiers",
    concentrationLabel: "Customer concentration",
  },
  expenses: {
    metricLabel: "Spending",
    metricDirection: "down_is_good",
    dimensionLabels: { product: "Category", customer: "Vendor", region: "Department" },
    insightContext: "expenses",
    rfmLabel: "Vendor dependency",
    abcLabel: "Expense categories",
    concentrationLabel: "Vendor concentration",
  },
  marketing: {
    metricLabel: "Spend",
    metricDirection: "context_dependent",
    dimensionLabels: { product: "Campaign", customer: "Channel", region: "Market" },
    insightContext: "marketing",
    rfmLabel: "Channel health",
    abcLabel: "Campaign tiers",
    concentrationLabel: "Channel concentration",
  },
  client: {
    metricLabel: null,
    metricDirection: "up_is_good",
    dimensionLabels: { product: "Product", customer: "Client", region: "Region" },
    insightContext: "general",
    rfmLabel: "Client health",
    abcLabel: "Product tiers",
    concentrationLabel: "Client concentration",
  },
  general: {
    metricLabel: null,
    metricDirection: "up_is_good",
    dimensionLabels: null,
    insightContext: "general",
    rfmLabel: "Entity health",
    abcLabel: "Value tiers",
    concentrationLabel: "Concentration analysis",
  },
};

const CURRENCY_OPTIONS = [
  { code: "USD", label: "USD" },
  { code: "LKR", label: "LKR" },
  { code: "EUR", label: "EUR" },
  { code: "GBP", label: "GBP" },
  { code: "INR", label: "INR" }
];

function cleanColumnName(col: string): string {
  return col
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isRateColumn(col: string): boolean {
  const n = col.toLowerCase().replace(/[\s_-]+/g, "");
  return /perunit|unitprice|priceeach|avgprice|averageprice|rate$|margin|percent|pct|ratio|conversion|ctr|cpc|cpm|cpa|aov|arpu|ltv|churn|yield|efficiency|utilization|satisfaction|score$|rating$|index$|coefficient/i.test(n);
}

// Guards AI text against inventing customer analysis when no customer column is mapped.
const CUSTOMER_TERMS = /customer|at[-\s]?risk|concentration|\bRFM\b/i;

// Revenue tied to junk product/item values (ERROR/UNKNOWN/blank/Missing), excluded from product charts.
function excludedItemRevenue(analysis: Analysis): number {
  return Math.abs(analysis.productRevenue.find((p) => p.label === INVALID_BUCKET)?.revenue ?? 0);
}
function excludedItemsNote(analysis: Analysis, currency?: string): string {
  const r = excludedItemRevenue(analysis);
  const fmtR = analysis.isMoney ? formatMoney(r, currency) : r.toLocaleString(undefined, { maximumFractionDigits: 1 }) + " units";
  return r > 0 ? `${fmtR} from unidentified items excluded` : "";
}
// Single denominator for all product-share percentages: revenue of identified products only
// (junk/Missing/Invalid excluded). Falls back to total revenue when no product breakdown exists.
function identifiedProductRevenue(analysis: Analysis): number {
  return identifiedTotal(analysis.productRevenue, analysis.totalRevenue);
}

// Reconciles the headline total (all canonical rows) with the per-product universe (rows whose
// item could be identified). Returns null on clean files (no unidentified items) so the note can
// collapse gracefully — never "+ $0 from 0 transactions". Every figure is derived, not hardcoded.
type ProductReconciliation = {
  total: number;
  identifiedRevenue: number;
  unidentifiedRevenue: number;
  identifiedRows: number;
  unidentifiedRows: number;
  totalRows: number;
};
function productReconciliation(analysis: Analysis): ProductReconciliation | null {
  const unidentifiedRevenue = excludedItemRevenue(analysis);
  const unidentifiedRows = analysis.unidentifiedProductRows;
  if (unidentifiedRows <= 0 || unidentifiedRevenue <= 0) return null;
  return {
    total: analysis.totalRevenue,
    identifiedRevenue: identifiedProductRevenue(analysis),
    unidentifiedRevenue,
    identifiedRows: analysis.identifiedProductRows,
    unidentifiedRows,
    totalRows: analysis.rowCount
  };
}

// One concise, dynamically-computed sentence explaining why per-product rows (identifiedRows) are
// fewer than the total row count. Used everywhere the headline total and identified-product total
// both appear (dashboard, report, Talk-to-Data). Returns "" when there is nothing to reconcile.
function reconciliationNote(analysis: Analysis, mapping: Mapping, settings: ReportSettings): string {
  const r = productReconciliation(analysis);
  if (!r) return "";
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, settings.currency) : v.toLocaleString(undefined, { maximumFractionDigits: analysis.primaryMetric === "Count" ? 0 : 1 });
  const metric = getMetricLabel(mapping, settings.template).toLowerCase();
  const prodLabel = getDimensionLabel("product", mapping, settings.template).toLowerCase();
  return `Total ${metric} ${fmt(r.total)} = ${fmt(r.identifiedRevenue)} from identified ${prodLabel}s + ${fmt(r.unidentifiedRevenue)} from ${r.unidentifiedRows.toLocaleString()} transactions we couldn't match to a ${prodLabel} (bad or blank ${prodLabel} name). Per-${prodLabel} charts use the ${r.identifiedRows.toLocaleString()} identified rows; the total uses all ${r.totalRows.toLocaleString()} rows.`;
}

function getMetricLabel(mapping: Mapping, template?: ReportTemplate): string {
  if (template) {
    const cfg = TEMPLATE_CONFIG[template];
    if (cfg.metricLabel) return cfg.metricLabel;
  }
  const revCol = mapping.revenue || "";
  const revName = revCol.toLowerCase().replace(/[\s_-]+/g, "");
  if (/^(revenue|sales|amount|total|income|net|gross|earning)$/.test(revName)) return "Revenue";
  if (revCol) return cleanColumnName(revCol);
  if (mapping.quantity) return cleanColumnName(mapping.quantity);
  if (mapping.cost) return cleanColumnName(mapping.cost);
  return "Value";
}

// Core criterion: a value column holds UNITS, not money — a small-magnitude count named like
// "sales"/"units"/"volume" with NO price column alongside (e.g. video-game Global_Sales = millions
// of units). Summing it is not currency, so it must never be dressed with a currency symbol. Shared
// by the display (profile-based) and analyzeData (row-based) so both agree, and it mirrors the C3
// audit's looksLikeUnitsColumn so the display and the integrity warning tell the same story.
function valueColLooksLikeUnits(valueCol: string, mapping: Mapping, colMax: number, headerNames: string[]): boolean {
  if (!valueCol) return false;
  const compact = valueCol.toLowerCase().replace(/[\s_-]+/g, "");
  if (!/sales|units|qty|quantity|shipped|volume/.test(compact)) return false;
  if (!(colMax > 0 && colMax < 1000)) return false; // real money totals are rarely all < 1000
  const hasPriceColumn = headerNames.some((h) => /price|unitprice|rate|mrp/i.test(h)) || Boolean(mapping.cost);
  return !hasPriceColumn;
}

// Profile-based wrapper for surfaces that hold ColumnProfile[] (per-column table / chart formatting).
function columnIsUnitsMetric(valueCol: string, mapping: Mapping, profiles: ColumnProfile[]): boolean {
  const p = profiles.find((pr) => pr.name === valueCol);
  if (!p || p.type !== "number") return false;
  return valueColLooksLikeUnits(valueCol, mapping, p.max, profiles.map((pr) => pr.name));
}

// The primary metric is money when its name says money AND it is not really a units column. Computed
// once in analyzeData and stored on Analysis.isMoney — the single source of truth every surface reads.
function primaryMetricIsMoney(valueCol: string, mapping: Mapping, colMax: number, headerNames: string[]): boolean {
  if (!valueCol) return false;
  const nameSaysMoney =
    valueCol === mapping.revenue ||
    valueCol === mapping.cost ||
    /revenue|sales|amount|price|cost|profit|income|earning|spend|fee/i.test(valueCol);
  return nameSaysMoney && !valueColLooksLikeUnits(valueCol, mapping, colMax, headerNames);
}

function getDimensionLabel(role: "product" | "customer" | "region", mapping: Mapping, template?: ReportTemplate): string {
  if (template) {
    const cfg = TEMPLATE_CONFIG[template];
    if (cfg.dimensionLabels) return cfg.dimensionLabels[role];
  }
  const col = mapping[role];
  if (!col) return role.charAt(0).toUpperCase() + role.slice(1);
  const n = col.toLowerCase().replace(/[\s_-]+/g, "");
  if (role === "product" && /product|item|sku|service/.test(n)) return "Product";
  if (role === "customer" && /customer|client|buyer/.test(n)) return "Customer";
  if (role === "region" && /region|country|state|city|area|location/.test(n)) return "Region";
  return cleanColumnName(col);
}

function trendTone(change: number, template: ReportTemplate): "positive" | "negative" | "neutral" {
  const dir = TEMPLATE_CONFIG[template].metricDirection;
  if (dir === "context_dependent") return "neutral";
  const up = change >= 0;
  if (dir === "down_is_good") return up ? "negative" : "positive";
  return up ? "positive" : "negative";
}

function detectTemplate(headers: string[], mapping: Mapping): ReportTemplate {
  const all = headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""));
  const mapped = Object.values(mapping).filter(Boolean).map((v) => v.toLowerCase().replace(/[\s_-]+/g, ""));
  const combined = [...all, ...mapped].join(" ");

  if (/campaign|adspend|clickthrough|ctr|impression|cpc|cpm|adgroup|conversion|roas/.test(combined)) return "marketing";
  if (/expense|spending|vendor|department|reimburs|receipt|payable/.test(combined)) return "expenses";
  if (/cart|checkout|sku|shipping|coupon|storefront|shopify|woocommerce|ecommerce/.test(combined)) return "ecommerce";
  if (/client|retainer|engagement|deliverable|billable|sow|statement.?of.?work/.test(combined)) return "client";
  if (/revenue|sales|order|invoice|deal|pipeline|quota|commission/.test(combined)) return "sales";
  return "general";
}

type PromptCategory = "overview" | "rankings" | "trends" | "risks" | "actions" | "writing" | "specific";

const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  overview: "Overview",
  rankings: "Rankings",
  trends: "Trends",
  risks: "Risks",
  actions: "Actions",
  writing: "Writing",
  specific: "Specific Items",
};

function generateDynamicPrompts(
  mapping: Mapping,
  analysis: Analysis | null,
  template: ReportTemplate
): { category: PromptCategory; label: string; prompt: string }[] {
  const met = getMetricLabel(mapping, template);
  const pLabel = getDimensionLabel("product", mapping, template);
  const cLabel = getDimensionLabel("customer", mapping, template);
  const rLabel = getDimensionLabel("region", mapping, template);
  const mLow = met.toLowerCase();
  const prompts: { category: PromptCategory; label: string; prompt: string }[] = [];

  prompts.push(
    { category: "overview", label: `Total ${met}`, prompt: `What's the total ${mLow}? Break it down with key statistics.` },
    { category: "overview", label: "Executive summary", prompt: "Write a concise executive summary of this data. Focus on key findings and implications." },
    { category: "overview", label: "Data quality check", prompt: "Are there any data quality risks? Check for anomalies, missing data patterns, and suspicious values." },
    { category: "overview", label: "Key patterns", prompt: "What are the most important patterns in this data? Give specific numbers." },
  );

  if (mapping.product) {
    prompts.push(
      { category: "rankings", label: `Top ${pLabel}s by ${met}`, prompt: `Rank all ${pLabel.toLowerCase()}s by ${mLow}. Show a bar chart.` },
      { category: "rankings", label: `Best ${pLabel}`, prompt: `Which ${pLabel.toLowerCase()} should I focus on and why? Consider ${mLow} and growth trend.` },
    );
  }
  if (mapping.customer) {
    prompts.push(
      { category: "rankings", label: `Top ${cLabel}s`, prompt: `Show a bar chart of top ${cLabel.toLowerCase()}s by ${mLow}.` },
      { category: "rankings", label: `${cLabel} concentration`, prompt: `Analyze ${cLabel.toLowerCase()} concentration. Is ${mLow} too dependent on a few ${cLabel.toLowerCase()}s? What's the risk?` },
    );
  }
  if (mapping.region) {
    prompts.push(
      { category: "rankings", label: `${rLabel} breakdown`, prompt: `Show a pie chart of ${mLow} share by ${rLabel.toLowerCase()}.` },
      { category: "rankings", label: `Strongest ${rLabel}`, prompt: `Which ${rLabel.toLowerCase()} is performing best and what can we learn from it?` },
    );
  }
  if (mapping.product && mapping.region) {
    prompts.push(
      { category: "rankings", label: `${pLabel} x ${rLabel}`, prompt: `Create a pivot table showing ${mLow} by ${pLabel.toLowerCase()} and ${rLabel.toLowerCase()}.` },
    );
  }
  if (mapping.cost || mapping.profit) {
    prompts.push(
      { category: "rankings", label: "Best margin", prompt: `Which ${pLabel.toLowerCase()} has the best margin? Calculate margin percentages.` },
    );
  }

  if (mapping.date) {
    prompts.push(
      { category: "trends", label: `${met} trend`, prompt: `Show a line chart of ${mLow} trend over time by period.` },
      { category: "trends", label: "Period comparison", prompt: "Compare the latest period to the previous period. What improved, what declined, and what stayed flat?" },
      { category: "trends", label: "Best vs worst period", prompt: "Compare the best-performing period to the worst. What drove the difference?" },
      { category: "trends", label: "Forecast", prompt: `Forecast next period's ${mLow} with optimistic, baseline, and conservative estimates. Explain your reasoning.` },
    );
    if (mapping.product) {
      prompts.push(
        { category: "trends", label: `${pLabel} trends`, prompt: `Compare ${pLabel.toLowerCase()} performance across periods. Which are growing vs declining?` },
      );
    }
  }

  if (analysis && analysis.rowCount > 0) {
    prompts.push(
      { category: "risks", label: "Find anomalies", prompt: "Look for anomalies, outliers, or unusual patterns in this data. Flag anything suspicious with exact numbers." },
      { category: "risks", label: "Risk assessment", prompt: "What are the top business risks visible in this data? Consider concentration, declining trends, and data quality issues." },
      { category: "risks", label: "Confidence check", prompt: "How confident should I be in these numbers? Rate the data quality and flag any findings I should verify." },
    );
    if (mapping.cost) {
      prompts.push(
        { category: "risks", label: "Cost-saving opportunities", prompt: `Identify potential cost-saving opportunities. Where are we spending too much relative to ${mLow}?` },
      );
    }
  }

  prompts.push(
    { category: "actions", label: "Top 5 actions", prompt: "Give me 5 specific, prioritized actions I should take this week based on the data. Be concrete, not generic." },
    { category: "actions", label: "Growth opportunities", prompt: "What are the top 3 growth opportunities visible in this data?" },
  );
  if (mapping.revenue && mapping.quantity) {
    prompts.push(
      { category: "actions", label: "Pricing analysis", prompt: `Based on quantity and ${mLow} data, analyze pricing. Are there ${pLabel.toLowerCase()}s that could handle a price increase?` },
    );
  }

  prompts.push(
    { category: "writing", label: "Email to my boss", prompt: "Write a concise email to my boss summarizing performance. Professional tone, under 150 words." },
    { category: "writing", label: "Board summary", prompt: "Write a 3-paragraph board-level executive summary. Focus on strategic implications, not operational details." },
    { category: "writing", label: "Slack update", prompt: "Write a short Slack message (under 80 words) updating the team on the latest numbers. Casual but data-driven." },
    { category: "writing", label: "Manager update", prompt: "Write a manager update covering: what went well, what needs attention, and recommended next steps." },
  );

  if (analysis && analysis.productRevenue.length > 0 && mapping.product) {
    const top3 = analysis.productRevenue.slice(0, 3);
    for (const item of top3) {
      prompts.push(
        { category: "specific", label: `About "${item.label}"`, prompt: `Tell me everything about "${item.label}". What's its ${mLow}, trend, and how does it compare to others?` },
      );
    }
  }

  return prompts;
}

const MAX_ROWS = 100_000;
const WARN_ROWS = 50_000;

const STORAGE_KEYS = {
  mapping: "sheet-analysis-ai:last-mapping",
  reportSettings: "sheet-analysis-ai:report-settings",
  aiSettings: "sheet-analysis-ai:ai-settings",
  savedWorkflows: "sheet-analysis-ai:saved-workflows",
  recentFiles: "sheet-analysis-ai:recent-files"
};

type SavedWorkflow = {
  name: string;
  headers: string[];
  mapping: Mapping;
  savedAt: string;
};

type RecentFile = {
  fileName: string;
  rows: number;
  openedAt: string;
};

type AnalysisSnapshot = {
  id: string;
  fileName: string;
  uploadDate: string;
  totalRevenue: number;
  rowCount: number;
  avgMetric: number;
  primaryMetric: string;
  topProducts: RankedItem[];
  topRegions: RankedItem[];
  periodRevenue: RankedItem[];
};

const IDB_NAME = "sheet-analysis-ai";
const IDB_STORE = "snapshots";

function openSnapshotDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE, { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSnapshot(snap: AnalysisSnapshot): Promise<void> {
  const db = await openSnapshotDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(snap);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function loadSnapshots(): Promise<AnalysisSnapshot[]> {
  const db = await openSnapshotDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => { db.close(); resolve(req.result); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function clearSnapshots(): Promise<void> {
  const db = await openSnapshotDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const SAMPLE_SALES_CSV = `OrderDate,InvoiceID,CustomerName,Region,Product,Category,Quantity,UnitPrice,Discount,NetAmount,Cost
2025-01-08,INV-1001,TechMart,Jaffna,Power Bank,Accessories,6,42,3,249,114
2025-01-10,INV-1010,Elite Supplies,Negombo,HDMI Cable,Accessories,1,15,0,15,6
2025-01-11,INV-1002,Nova Traders,Negombo,Office Chair,Furniture,3,261,0,783,471
2025-01-12,INV-1011,Digital Solutions,Negombo,Webcam HD,Accessories,5,61,0,305,155
2025-01-13,INV-1004,Prime Office,Jaffna,Wireless Mouse,Accessories,2,32,4,60,32
2025-01-15,INV-1009,Office Hub,Colombo,Mechanical Keyboard,Accessories,4,110,40,400,232
2025-01-16,INV-1005,Smart Electronics,Negombo,Wireless Mouse,Accessories,4,29,12,104,52
2025-01-18,INV-1007,Smart Electronics,Colombo,Mechanical Keyboard,Accessories,4,110,0,440,216
2025-01-20,INV-1006,Digital Solutions,Colombo,Printer X,Electronics,4,210,126,714,444
2025-01-21,INV-1003,Office Hub,Negombo,External SSD,Electronics,2,100,10,190,106
2025-01-24,INV-1008,TechMart,Galle,Mechanical Keyboard,Accessories,5,105,37,488,275
2025-02-05,INV-1018,Apex Systems,Galle,Desk Lamp,Office,6,40,2,238,120
2025-02-05,INV-1021,NetGear Lanka,Jaffna,Monitor 27,Electronics,2,414,50,778,488
2025-02-06,INV-1019,Coral Enterprises,Colombo,HDMI Cable,Accessories,5,18,9,81,40
2025-02-08,INV-1017,Office Hub,Colombo,USB Hub,Accessories,1,51,3,48,24
2025-02-11,INV-1022,Prime Office,Colombo,Office Chair,Furniture,2,310,6,614,358
2025-02-16,INV-1020,Zenith Corp,Negombo,Screen Protector,Accessories,6,11,1,65,24
2025-02-17,INV-1015,Apex Systems,Kandy,Office Chair,Furniture,3,252,68,688,456
2025-02-20,INV-1012,Prime Office,Kandy,Mechanical Keyboard,Accessories,1,100,5,95,51
2025-02-20,INV-1014,Metro Traders,Colombo,External SSD,Electronics,6,108,0,648,336
2025-02-26,INV-1013,Future Shop,Negombo,Headphones,Accessories,4,67,0,268,132
2025-02-28,INV-1016,TechMart,Galle,Headphones,Accessories,5,63,9,306,125
2025-03-01,INV-1026,Coral Enterprises,Galle,USB Hub,Accessories,4,55,0,220,108
2025-03-01,INV-1027,Digital Solutions,Colombo,Monitor 27,Electronics,3,388,0,1164,735
2025-03-03,INV-1028,TechMart,Galle,Wireless Mouse,Accessories,3,25,1,74,33
2025-03-07,INV-1031,Office Hub,Negombo,Power Bank,Accessories,4,37,15,133,72
2025-03-10,INV-1024,Digital Solutions,Kandy,Printer X,Electronics,5,212,0,1060,535
2025-03-15,INV-1030,Micro Systems,Colombo,Webcam HD,Accessories,4,74,41,255,136
2025-03-18,INV-1029,TechMart,Colombo,Screen Protector,Accessories,1,11,2,9,4
2025-03-25,INV-1023,NetGear Lanka,Colombo,Printer X,Electronics,4,189,113,643,416
2025-03-26,INV-1025,Office Hub,Kandy,Power Bank,Accessories,6,35,0,210,96
2025-03-27,INV-1032,Nova Traders,Galle,Screen Protector,Accessories,6,9,0,54,18
2025-04-02,INV-1041,TechMart,Negombo,Power Bank,Accessories,1,39,0,39,19
2025-04-03,INV-1034,Connect Plus,Colombo,Headphones,Accessories,6,68,45,363,168
2025-04-03,INV-1035,Coral Enterprises,Galle,External SSD,Electronics,1,101,4,97,52
2025-04-04,INV-1040,Digital Solutions,Colombo,Printer X,Electronics,6,197,106,1076,666
2025-04-09,INV-1042,Metro Traders,Colombo,Headphones,Accessories,5,68,27,313,145
2025-04-10,INV-1036,Digital Solutions,Kandy,Mechanical Keyboard,Accessories,5,100,0,500,235
2025-04-14,INV-1039,Nova Traders,Colombo,Power Bank,Accessories,5,39,14,181,80
2025-04-16,INV-1038,Nova Traders,Kandy,Power Bank,Accessories,4,37,4,144,72
2025-04-19,INV-1033,Prime Office,Negombo,Headphones,Accessories,4,60,5,235,112
2025-04-20,INV-1037,Digital Solutions,Colombo,Printer X,Electronics,3,216,71,577,342
2025-05-04,INV-1049,TechMart,Kandy,Desk Lamp,Office,4,30,0,120,48
2025-05-08,INV-1045,Office Hub,Colombo,External SSD,Electronics,2,95,0,190,100
2025-05-12,INV-1044,TechMart,Jaffna,USB Hub,Accessories,2,47,0,94,40
2025-05-15,INV-1051,Smart Electronics,Colombo,Wireless Mouse,Accessories,2,34,0,68,28
2025-05-18,INV-1043,Digital Solutions,Negombo,Mechanical Keyboard,Accessories,1,95,5,90,48
2025-05-18,INV-1047,Digital Solutions,Kandy,Screen Protector,Accessories,2,12,4,20,10
2025-05-21,INV-1046,Velocity IT,Colombo,Screen Protector,Accessories,5,8,0,40,15
2025-05-24,INV-1048,Office Hub,Colombo,HDMI Cable,Accessories,6,12,9,63,30
2025-05-25,INV-1050,NetGear Lanka,Kandy,Tablet Stand,Accessories,4,25,10,90,44
2025-06-02,INV-1061,Elite Supplies,Colombo,Tablet Stand,Accessories,4,25,8,92,48
2025-06-03,INV-1056,Metro Traders,Colombo,Headphones,Accessories,4,63,25,227,108
2025-06-11,INV-1057,Smart Electronics,Negombo,Mechanical Keyboard,Accessories,6,108,52,596,336
2025-06-13,INV-1052,Office Hub,Galle,HDMI Cable,Accessories,6,15,0,90,30
2025-06-13,INV-1054,Metro Traders,Kandy,Office Chair,Furniture,5,281,0,1405,905
2025-06-14,INV-1053,Digital Solutions,Jaffna,Mechanical Keyboard,Accessories,6,96,63,513,294
2025-06-17,INV-1062,Future Shop,Colombo,Wireless Mouse,Accessories,4,26,14,90,44
2025-06-22,INV-1055,Office Hub,Kandy,Screen Protector,Accessories,6,11,1,65,24
2025-06-22,INV-1058,TechMart,Colombo,Mechanical Keyboard,Accessories,6,95,0,570,300
2025-06-23,INV-1060,Digital Solutions,Negombo,Wireless Mouse,Accessories,4,30,18,102,48
2025-06-26,INV-1059,TechMart,Colombo,HDMI Cable,Accessories,1,14,0,14,5
2025-07-01,INV-1066,Office Hub,Colombo,Desk Lamp,Office,4,34,3,133,64
2025-07-06,INV-1065,Global Tech,Galle,Laptop Pro,Electronics,5,821,575,3530,2630
2025-07-08,INV-1063,TechMart,Galle,Laptop Pro,Electronics,3,845,25,2510,1473
2025-07-10,INV-1071,Metro Traders,Kandy,Headphones,Accessories,6,60,14,346,162
2025-07-10,INV-1073,Bright Solutions,Colombo,HDMI Cable,Accessories,5,16,4,76,35
2025-07-13,INV-1067,Office Hub,Jaffna,HDMI Cable,Accessories,5,16,8,72,35
2025-07-15,INV-1069,Prime Office,Negombo,External SSD,Electronics,6,101,0,606,318
2025-07-16,INV-1068,Lanka Devices,Colombo,Tablet Stand,Accessories,1,25,0,25,12
2025-07-19,INV-1072,Future Shop,Jaffna,Headphones,Accessories,1,62,7,55,27
2025-07-25,INV-1064,City Supplies,Colombo,Monitor 27,Electronics,2,391,0,782,462
2025-07-26,INV-1070,Prime Office,Jaffna,HDMI Cable,Accessories,2,12,0,24,8
2025-08-03,INV-1076,TechMart,Negombo,Monitor 27,Electronics,4,408,212,1420,900
2025-08-07,INV-1081,Smart Electronics,Kandy,External SSD,Electronics,6,107,39,603,294
2025-08-09,INV-1074,TechMart,Colombo,Tablet Stand,Accessories,1,30,0,30,12
2025-08-09,INV-1078,Digital Solutions,Colombo,Mechanical Keyboard,Accessories,6,105,0,630,318
2025-08-16,INV-1080,Micro Systems,Colombo,External SSD,Electronics,5,103,77,438,275
2025-08-22,INV-1079,Micro Systems,Galle,Tablet Stand,Accessories,6,27,24,138,72
2025-08-24,INV-1077,Connect Plus,Kandy,Printer X,Electronics,3,200,84,516,339
2025-08-25,INV-1083,Digital Solutions,Colombo,Laptop Pro,Electronics,1,896,72,824,494
2025-08-26,INV-1082,Digital Solutions,Negombo,Printer X,Electronics,5,197,108,877,565
2025-08-28,INV-1075,Digital Solutions,Colombo,Printer X,Electronics,1,209,25,184,117
2025-09-02,INV-1103,TechMart,Negombo,Printer X,Electronics,7,207,130,1319,798
2025-09-03,INV-1090,Smart Electronics,Colombo,Desk Lamp,Office,4,31,0,124,60
2025-09-03,INV-1096,Future Shop,Jaffna,Wireless Mouse,Accessories,1,28,4,24,12
2025-09-05,INV-1097,TechMart,Colombo,Tablet Stand,Accessories,10,26,10,250,130
2025-09-09,INV-1091,Prime Office,Kandy,Power Bank,Accessories,2,37,10,64,30
2025-09-11,INV-1101,Office Hub,Colombo,Mechanical Keyboard,Accessories,5,88,0,440,235
2025-09-12,INV-1087,Prime Office,Colombo,HDMI Cable,Accessories,6,15,0,90,36
2025-09-13,INV-1084,NetGear Lanka,Kandy,Power Bank,Accessories,2,38,10,66,36
2025-09-16,INV-1088,Connect Plus,Jaffna,Desk Lamp,Office,3,45,16,119,66
2025-09-16,INV-1105,Quick Office,Galle,Laptop Pro,Electronics,6,868,312,4896,3174
2025-09-17,INV-1085,Apex Systems,Colombo,Webcam HD,Accessories,6,73,22,416,228
2025-09-18,INV-1086,TechMart,Kandy,USB Hub,Accessories,8,41,26,302,136
2025-09-18,INV-1107,Bright Solutions,Jaffna,Office Chair,Furniture,1,320,6,314,178
2025-09-19,INV-1092,Nova Traders,Kandy,USB Hub,Accessories,6,42,8,244,120
2025-09-20,INV-1094,Digital Solutions,Kandy,Laptop Pro,Electronics,9,905,896,7249,4752
2025-09-20,INV-1106,Global Tech,Negombo,Wireless Mouse,Accessories,3,35,0,105,45
2025-09-21,INV-1098,Connect Plus,Colombo,Desk Lamp,Office,1,45,0,45,20
2025-09-22,INV-1093,Prime Office,Galle,Power Bank,Accessories,5,41,8,197,90
2025-09-22,INV-1099,Digital Solutions,Negombo,Mechanical Keyboard,Accessories,5,95,5,470,260
2025-09-23,INV-1089,Prime Office,Colombo,Wireless Mouse,Accessories,5,34,15,155,85
2025-09-23,INV-1100,TechMart,Jaffna,Power Bank,Accessories,9,46,33,381,171
2025-09-24,INV-1104,TechMart,Kandy,Tablet Stand,Accessories,8,29,0,232,112
2025-09-25,INV-1095,Smart Electronics,Colombo,Laptop Pro,Electronics,5,826,207,3923,2300
2025-09-25,INV-1102,Nova Traders,Colombo,Mechanical Keyboard,Accessories,3,101,42,261,147
2025-10-01,INV-1111,TechMart,Jaffna,Desk Lamp,Office,5,40,30,170,90
2025-10-02,INV-1121,Smart Electronics,Negombo,Webcam HD,Accessories,4,68,24,248,148
2025-10-06,INV-1113,Digital Solutions,Jaffna,Wireless Mouse,Accessories,4,33,0,132,56
2025-10-06,INV-1114,City Supplies,Galle,Desk Lamp,Office,3,30,10,80,45
2025-10-09,INV-1119,Office Hub,Jaffna,Mechanical Keyboard,Accessories,6,88,0,528,258
2025-10-11,INV-1115,Smart Electronics,Galle,Wireless Mouse,Accessories,4,33,0,132,60
2025-10-13,INV-1108,Office Hub,Negombo,Printer X,Electronics,4,180,0,720,380
2025-10-13,INV-1117,TechMart,Galle,HDMI Cable,Accessories,5,12,3,57,25
2025-10-16,INV-1116,Office Hub,Galle,Monitor 27,Electronics,1,367,22,345,219
2025-10-17,INV-1118,TechMart,Kandy,Laptop Pro,Electronics,4,860,516,2924,2116
2025-10-21,INV-1110,Global Tech,Kandy,Printer X,Electronics,6,184,0,1104,642
2025-10-25,INV-1112,Micro Systems,Negombo,Mechanical Keyboard,Accessories,6,85,15,495,246
2025-10-25,INV-1120,Office Hub,Negombo,USB Hub,Accessories,3,46,15,123,63
2025-10-27,INV-1109,TechMart,Negombo,Headphones,Accessories,3,58,0,174,75
2025-11-01,INV-1133,Digital Solutions,Colombo,Webcam HD,Accessories,1,65,10,55,34
2025-11-01,INV-1134,Office Hub,Kandy,Office Chair,Furniture,4,290,0,1160,732
2025-11-09,INV-1123,Prime Office,Jaffna,Webcam HD,Accessories,3,61,5,178,99
2025-11-11,INV-1131,Global Tech,Colombo,External SSD,Electronics,5,105,0,525,280
2025-11-11,INV-1132,Digital Solutions,Colombo,Webcam HD,Accessories,5,71,36,319,190
2025-11-15,INV-1124,Zenith Corp,Negombo,Power Bank,Accessories,6,48,20,268,114
2025-11-15,INV-1128,City Supplies,Kandy,Wireless Mouse,Accessories,1,30,0,30,14
2025-11-16,INV-1122,City Supplies,Jaffna,Printer X,Electronics,1,211,27,184,117
2025-11-17,INV-1125,Peak Electronics,Colombo,Wireless Mouse,Accessories,6,30,2,178,78
2025-11-17,INV-1130,Coral Enterprises,Negombo,Headphones,Accessories,4,61,37,207,100
2025-11-22,INV-1127,Velocity IT,Kandy,Tablet Stand,Accessories,4,29,0,116,56
2025-11-22,INV-1129,Office Hub,Kandy,USB Hub,Accessories,1,45,0,45,20
2025-11-28,INV-1126,Office Hub,Galle,Printer X,Electronics,1,218,0,218,125
2025-11-28,INV-1135,Digital Solutions,Kandy,Wireless Mouse,Accessories,1,28,2,26,13
2025-12-01,INV-1142,Apex Systems,Galle,Power Bank,Accessories,6,44,5,259,108
2025-12-07,INV-1136,Global Tech,Galle,Desk Lamp,Office,2,36,2,70,36
2025-12-08,INV-1149,TechMart,Jaffna,Desk Lamp,Office,5,34,7,163,80
2025-12-09,INV-1147,DataLink,Jaffna,Desk Lamp,Office,2,41,0,82,38
2025-12-10,INV-1139,Smart Electronics,Colombo,External SSD,Electronics,4,111,53,391,240
2025-12-10,INV-1141,TechMart,Jaffna,Office Chair,Furniture,6,286,0,1716,972
2025-12-11,INV-1148,Bright Solutions,Galle,Wireless Mouse,Accessories,1,30,0,30,13
2025-12-12,INV-1146,Digital Solutions,Jaffna,Desk Lamp,Office,1,39,2,37,17
2025-12-16,INV-1137,TechMart,Galle,Desk Lamp,Office,4,38,18,134,64
2025-12-17,INV-1140,Office Hub,Kandy,Mechanical Keyboard,Accessories,5,90,32,418,205
2025-12-19,INV-1143,TechMart,Jaffna,HDMI Cable,Accessories,5,14,0,70,30
2025-12-22,INV-1145,Future Shop,Negombo,Mechanical Keyboard,Accessories,2,96,23,169,100
2025-12-24,INV-1138,TechMart,Jaffna,Office Chair,Furniture,2,318,70,566,356
2025-12-24,INV-1144,Office Hub,Negombo,Laptop Pro,Electronics,1,822,0,822,461`;

const SAMPLE_EXPENSE_CSV = `Date,ReceiptID,Vendor,Department,Category,Description,Amount,TaxAmount
2025-01-05,EXP-2001,Lanka Office Supplies,Engineering,Office Supplies,Pens and notebooks,4500,810
2025-01-08,EXP-2002,Dialog Axiata,Operations,Telecom,Monthly internet,18500,3330
2025-01-12,EXP-2003,Hilton Colombo,Sales,Travel,Client dinner,12800,2304
2025-01-15,EXP-2004,AWS,Engineering,Cloud Services,EC2 instances Jan,85000,15300
2025-01-18,EXP-2005,PickMe,Sales,Travel,Client visits transport,3200,576
2025-01-22,EXP-2006,Abans,Operations,Equipment,Printer cartridges,7600,1368
2025-01-28,EXP-2007,Google Workspace,Engineering,Software,Monthly subscription,22000,3960
2025-02-03,EXP-2008,Lanka Office Supplies,Marketing,Office Supplies,Presentation folders,2800,504
2025-02-05,EXP-2009,Dialog Axiata,Operations,Telecom,Monthly internet,18500,3330
2025-02-10,EXP-2010,Jetwing Hotels,Sales,Travel,Out-of-town client meeting,28500,5130
2025-02-14,EXP-2011,AWS,Engineering,Cloud Services,EC2 instances Feb,92000,16560
2025-02-18,EXP-2012,Uber Lanka,Marketing,Travel,Event logistics,4100,738
2025-02-20,EXP-2013,Figma,Engineering,Software,Annual design tools,45000,8100
2025-02-25,EXP-2014,Keells Super,Operations,Office Supplies,Pantry supplies,3500,630
2025-03-01,EXP-2015,Dialog Axiata,Operations,Telecom,Monthly internet,18500,3330
2025-03-05,EXP-2016,AWS,Engineering,Cloud Services,EC2 instances Mar,88000,15840
2025-03-08,EXP-2017,Colombo Printing,Marketing,Marketing Materials,Brochures 500pcs,15000,2700
2025-03-12,EXP-2018,PickMe,Sales,Travel,Client visits,2900,522
2025-03-15,EXP-2019,Slack,Engineering,Software,Monthly team plan,12000,2160
2025-03-20,EXP-2020,Lanka Office Supplies,HR,Office Supplies,Onboarding kits,6200,1116
2025-03-25,EXP-2021,Cinnamon Grand,Sales,Travel,Quarterly review dinner,18200,3276
2025-04-02,EXP-2022,Dialog Axiata,Operations,Telecom,Monthly internet,18500,3330
2025-04-05,EXP-2023,AWS,Engineering,Cloud Services,EC2 instances Apr,95000,17100
2025-04-10,EXP-2024,LinkedIn,Marketing,Software,Recruiter license,35000,6300
2025-04-14,EXP-2025,Abans,Operations,Equipment,Monitor for new hire,42000,7560
2025-04-18,EXP-2026,Google Workspace,Engineering,Software,Monthly subscription,22000,3960
2025-04-22,EXP-2027,Uber Lanka,Sales,Travel,Airport pickup client,1800,324
2025-04-28,EXP-2028,Colombo Printing,Marketing,Marketing Materials,Event banners,8500,1530
2025-05-01,EXP-2029,Dialog Axiata,Operations,Telecom,Monthly internet,19200,3456
2025-05-05,EXP-2030,AWS,Engineering,Cloud Services,EC2 instances May,98000,17640
2025-05-10,EXP-2031,Lanka Office Supplies,Engineering,Office Supplies,Whiteboard markers,1800,324
2025-05-15,EXP-2032,Hilton Colombo,HR,Travel,Team offsite lunch,22000,3960
2025-05-20,EXP-2033,Figma,Engineering,Software,Additional seats,15000,2700
2025-05-25,EXP-2034,PickMe,Sales,Travel,Client visits,4300,774
2025-06-02,EXP-2035,Dialog Axiata,Operations,Telecom,Monthly internet,19200,3456
2025-06-05,EXP-2036,AWS,Engineering,Cloud Services,EC2 instances Jun,102000,18360
2025-06-10,EXP-2037,Colombo Printing,Marketing,Marketing Materials,Product catalogs,12000,2160
2025-06-15,EXP-2038,Keells Super,Operations,Office Supplies,Pantry and cleaning,4200,756
2025-06-20,EXP-2039,Shangri-La,Sales,Travel,Partner summit dinner,32000,5760
2025-06-25,EXP-2040,Google Workspace,Engineering,Software,Monthly subscription,22000,3960`;

const SAMPLE_MARKETING_CSV = `Date,CampaignID,Campaign,Channel,Market,AdSpend,Impressions,Clicks,Conversions,Revenue
2025-01-05,MKT-301,New Year Sale,Google Ads,Colombo,25000,48000,1920,96,145000
2025-01-05,MKT-302,New Year Sale,Facebook,Colombo,18000,62000,2480,74,98000
2025-01-05,MKT-303,New Year Sale,Instagram,Kandy,12000,35000,1400,42,58000
2025-01-15,MKT-304,Brand Awareness,Google Ads,Galle,15000,32000,960,29,42000
2025-01-15,MKT-305,Brand Awareness,Facebook,Colombo,20000,55000,1650,50,71000
2025-02-01,MKT-306,Valentine Promo,Instagram,Colombo,22000,58000,3480,104,168000
2025-02-01,MKT-307,Valentine Promo,Google Ads,Kandy,28000,45000,2250,90,135000
2025-02-01,MKT-308,Valentine Promo,Facebook,Galle,16000,42000,1680,50,72000
2025-02-15,MKT-309,Tech Launch,Google Ads,Colombo,35000,52000,2600,78,156000
2025-02-15,MKT-310,Tech Launch,Email,Colombo,5000,12000,1440,72,108000
2025-03-01,MKT-311,March Madness,Google Ads,Colombo,30000,55000,2200,88,132000
2025-03-01,MKT-312,March Madness,Facebook,Kandy,22000,48000,1920,58,82000
2025-03-01,MKT-313,March Madness,Instagram,Galle,14000,38000,1520,46,62000
2025-03-15,MKT-314,Retargeting Q1,Google Ads,Colombo,18000,22000,1760,88,148000
2025-03-15,MKT-315,Retargeting Q1,Email,Kandy,3000,8000,960,58,87000
2025-04-01,MKT-316,Avurudu Sale,Google Ads,Colombo,40000,72000,3600,144,252000
2025-04-01,MKT-317,Avurudu Sale,Facebook,Colombo,32000,85000,3400,102,178000
2025-04-01,MKT-318,Avurudu Sale,Instagram,Kandy,20000,52000,2080,62,95000
2025-04-01,MKT-319,Avurudu Sale,Email,Galle,4000,10000,1200,60,92000
2025-04-15,MKT-320,Product Demo,Google Ads,Colombo,12000,18000,900,27,54000
2025-05-01,MKT-321,Mid-Year Push,Google Ads,Colombo,28000,50000,2000,80,120000
2025-05-01,MKT-322,Mid-Year Push,Facebook,Kandy,24000,58000,2320,70,98000
2025-05-01,MKT-323,Mid-Year Push,Instagram,Galle,15000,40000,1600,48,68000
2025-05-15,MKT-324,Loyalty Program,Email,Colombo,6000,15000,1800,108,175000
2025-05-15,MKT-325,Loyalty Program,Google Ads,Kandy,10000,20000,800,32,48000
2025-06-01,MKT-326,Summer Deals,Google Ads,Colombo,32000,58000,2900,116,185000
2025-06-01,MKT-327,Summer Deals,Facebook,Colombo,26000,65000,2600,78,118000
2025-06-01,MKT-328,Summer Deals,Instagram,Kandy,18000,45000,1800,54,82000
2025-06-15,MKT-329,Retargeting Q2,Google Ads,Colombo,20000,25000,2000,100,165000
2025-06-15,MKT-330,Retargeting Q2,Email,Galle,4000,9000,1080,65,98000`;

export function App() {
  const [dataSet, setDataSet] = useState<DataSet | null>(null);
  const [previousDataSet, setPreviousDataSet] = useState<DataSet | null>(null);
  const [comparisonFiles, setComparisonFiles] = useState<DataSet[]>([]);
  const [mapping, setMapping] = useState<Mapping>(() => loadStoredMapping());
  const [mappingStatus, setMappingStatus] = useState("");
  // Non-blocking data-quality notices surfaced after upload/mapping (header-row detection,
  // per-unit-price warning). Display-only; they never stop the user from continuing.
  const [dataNotices, setDataNotices] = useState<string[]>([]);
  const [aiMappingLoading, setAiMappingLoading] = useState(false);
  const [reportSettings, setReportSettings] = useState<ReportSettings>(() => loadStoredReportSettings());
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<AISettings>(() => loadStoredAISettings());
  const [aiLoading, setAiLoading] = useState(false);
  const [agentResults, setAgentResults] = useState<AgentResult[]>([]);
  const [expandedAgent, setExpandedAgent] = useState<AgentId | null>(null);
  const [expandedRfmSegment, setExpandedRfmSegment] = useState<RFMSegment | null>(null);
  const [expandedAbcTier, setExpandedAbcTier] = useState<"A" | "B" | "C" | null>(null);
  const [autoInsights, setAutoInsights] = useState<{ texts: string[]; loading: boolean }>({ texts: [], loading: false });
  const [promptCategory, setPromptCategory] = useState<PromptCategory | "all">("all");
  const [activeTab, setActiveTab] = useState<"upload" | "dashboard" | "explore" | "ai">("upload");
  const [excludedRows, setExcludedRows] = useState<Set<number>>(new Set());
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [fileParsing, setFileParsing] = useState(false);
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>(() => readJson(STORAGE_KEYS.savedWorkflows, [] as SavedWorkflow[]));
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(() => readJson(STORAGE_KEYS.recentFiles, [] as RecentFile[]));
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisSnapshot[]>([]);
  const [customCharts, setCustomCharts] = useState<Array<{ id: string; type: string; xCol: string; yCol: string; agg: string; groupCol: string; topN: number; colorTheme: string; title: string }>>([]);
  const [chartBuilder, setChartBuilder] = useState({ type: "bar", xCol: "", yCol: "", agg: "sum", groupCol: "", topN: 10, colorTheme: "blue", title: "" });
  const [hoveredChartType, setHoveredChartType] = useState<string | null>(null);
  const [chartBuilderOrigin, setChartBuilderOrigin] = useState<{ type: string; xCol: string; yCol: string; agg: string; groupCol: string; topN: number } | null>(null);
  const [chartPrompt, setChartPrompt] = useState("");
  const [chartPromptStatus, setChartPromptStatus] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [aiChartSuggestions, setAiChartSuggestions] = useState<Array<{ title: string; type: string; x: string; y: string; aggregation: string; reason: string }> | null>(null);
  const [aiChartSuggestionsLoading, setAiChartSuggestionsLoading] = useState(false);
  const [additionalMetrics, setAdditionalMetrics] = useState<string[]>([]);
  const [analysisMode, setAnalysisMode] = useState<"sum" | "count" | "average">("sum");
  const [identifierColumns, setIdentifierColumns] = useState<string[]>([]);
  const [additionalDimensions, setAdditionalDimensions] = useState<string[]>([]);
  const [aiReport, setAiReport] = useState<{ loading: boolean; sections: Array<{ title: string; text: string; chart?: ChartCommand }> }>({ loading: false, sections: [] });
  const [printSections, setPrintSections] = useState({ summary: true, kpis: true, comparison: true, charts: true, outliers: true, details: true, customCharts: false, aiReport: false });
  const [dashboardMode, setDashboardMode] = useState<"concise" | "full">("concise");
  const [onePagerMode, setOnePagerMode] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [aiSummary, setAiSummary] = useState<{ text: string | null; loading: boolean }>({ text: null, loading: false });
  const [aiRecommendations, setAiRecommendations] = useState<{ items: SmartRecommendation[] | null; loading: boolean }>({ items: null, loading: false });
  const [aiChartInsights, setAiChartInsights] = useState<Record<string, string>>({});
  const [creditsRemaining, setCreditsRemaining] = useState<number | null>(null);
  const [googleImporting, setGoogleImporting] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemInput, setRedeemInput] = useState("");
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemMsg, setRedeemMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const handleRedeem = async () => {
    const code = redeemInput.trim();
    if (!code || redeemBusy) return;
    setRedeemBusy(true);
    const res = await redeemCode(code);
    setRedeemBusy(false);
    setRedeemMsg({ ok: res.ok, text: res.message });
    if (res.ok) {
      if (typeof res.remaining === "number") setCreditsRemaining(res.remaining);
      setRedeemInput("");
      setTimeout(() => { setRedeemOpen(false); setRedeemMsg(null); }, 2500);
    }
  };

  useEffect(() => {
    _onCreditsUpdate = (remaining: number) => setCreditsRemaining(remaining);
    return () => { _onCreditsUpdate = null; };
  }, []);
  useEffect(() => {
    if (aiSettings.apiKey) return;
    callSmartAI("get_credits", {});
  }, []);
  const [aiComparisonNarrative, setAiComparisonNarrative] = useState<{ text: string | null; loading: boolean }>({ text: null, loading: false });
  const [whatIfPct, setWhatIfPct] = useState(0);
  const [tableSort, setTableSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [tablePage, setTablePage] = useState(0);
  const [exploreTab, setExploreTab] = useState<"talk" | "charts" | "data" | "stats" | "compare">("talk");
  const missingRequired = dataSet ? REQUIRED_ROLES.filter((r) => !mapping[r]) : [];
  const missingRecommended = dataSet ? RECOMMENDED_ROLES.filter((r) => !mapping[r]) : [];
  const generatedAt = useMemo(() => new Date(), [dataSet?.fileName]);

  const filteredRows = useMemo(() => {
    if (!dataSet) return [];
    return dataSet.rows.filter((_, i) => !excludedRows.has(i));
  }, [dataSet, excludedRows]);

  // FIX 1 — Refuse on revenue ambiguity. Before computing the hero total we confirm the mapped
  // revenue column actually holds summable, line-level amounts. If it's text, or a per-unit price
  // that doesn't scale with quantity, we block the analysis and prompt for confirmation rather
  // than charting a wrong number. The user can override once (per file/mapping) if they're sure.
  const [revenueConfirmed, setRevenueConfirmed] = useState(false);
  useEffect(() => {
    setRevenueConfirmed(false);
  }, [dataSet?.fileName, mapping.revenue, mapping.quantity]);

  const revenueConfidence = useMemo<RevenueAssessment>(() => {
    if (!dataSet) return { ok: true, column: null };
    return assessRevenueColumn(filteredRows, mapping);
  }, [dataSet, mapping, filteredRows]);

  const revenueBlocked = !revenueConfidence.ok && !revenueConfirmed;

  const analysis = useMemo(() => {
    if (!dataSet || revenueBlocked) return null;
    return analyzeData(filteredRows, mapping, reportSettings.template);
  }, [filteredRows, mapping, dataSet, reportSettings.template, revenueBlocked]);

  // FIX 2 — One row base. canonicalRows is THE single row universe (valid value + parseable
  // date). analyzeData derives it internally; findings, RFM, and the charts must consume this
  // exact same set so analysis.rowCount === findings.rowCount === the RFM base — never a second,
  // looser base that silently counts rows the dashboard total already dropped.
  const canonicalChartRows = useMemo(
    () => canonicalRows(filteredRows, mapping),
    [filteredRows, mapping]
  );

  // The Findings ledger (Layer 2) — single source of truth for the significance verdicts.
  // Every section that describes the trend/seasonality/category reads from here so they
  // cannot contradict each other or narrate noise as signal.
  const findings = useMemo<Findings | null>(() => {
    if (!dataSet) return null;
    try {
      return buildFindings(canonicalChartRows, mapping);
    } catch {
      return null;
    }
  }, [canonicalChartRows, mapping, dataSet]);

  // FIX 4 — the C1–C14 reconciliation gate, wired onto the LIVE path (ADVISORY). It runs on
  // every real report between ledger assembly and narration: profile (auditAdapter) + faithful
  // ledger (buildAuditLedger) → runAudit. ADVISORY means it surfaces/logs but never blocks the
  // render — FIX 1 already fails-closed on the revenue-ambiguity class upstream, so by the time
  // a report reaches here the gate is a second, independent integrity check, not the only one.
  const auditResult = useMemo<{ verdict: AuditVerdict; violations: AuditViolation[] } | null>(() => {
    if (!analysis || !findings) return null;
    try {
      const { columns, periods } = buildAuditProfile(canonicalChartRows, mapping, findings, {
        currency: reportSettings.currency,
      });
      const ledger = buildAuditLedger(analysis, mapping, reportSettings.currency);
      // Cross-foot the hero total across the two INDEPENDENT paths that compute it: the dashboard
      // (analyzeData over canonicalRows) and the Findings ledger (buildFindings). They must agree;
      // if a future change lets their row universes drift apart again, XFOOT flags it here.
      const crossFoot =
        findings && Number.isFinite(analysis.totalRevenue) && Number.isFinite(findings.total)
          ? [{
              label: `total ${analysis.primaryMetric}`,
              paths: { dashboard: analysis.totalRevenue, findings: findings.total },
            }]
          : [];
      const result = runAudit(ledger, columns, [], periods, crossFoot);
      if (result.verdict !== "PASS") {
        console.warn(
          `[audit gate] ${result.verdict} on ${dataSet?.fileName ?? "report"} —`,
          result.violations.map((x) => `${x.check}:${x.status} ${x.message}`),
        );
      }
      return result;
    } catch (e) {
      console.warn("[audit gate] failed to run", e);
      return null;
    }
  }, [analysis, findings, canonicalChartRows, mapping, reportSettings.currency, dataSet]);

  // Per-unit-price detection used to be a passive upload-tab note; FIX 1 promoted it to a
  // BLOCKING revenue-confidence gate (see revenueConfidence above), so it no longer rides here.
  const allDataNotices = dataNotices;

  const trustScore = useMemo(() => {
    if (!dataSet || !analysis) return null;
    return calculateTrustScore(dataSet, analysis);
  }, [analysis, dataSet]);

  const smartCharts = useMemo(() => {
    if (!dataSet || !analysis) return [];
    return recommendCharts(dataSet.profiles, analysis, mapping, reportSettings.currency, reportSettings.template, additionalMetrics, additionalDimensions, filteredRows, identifierColumns);
  }, [dataSet, analysis, mapping, reportSettings.currency, reportSettings.template, additionalMetrics, additionalDimensions, filteredRows, identifierColumns]);

  const dashboardSmartCharts = useMemo(
    () => dashboardMode === "concise" ? smartCharts.slice(0, 2) : smartCharts,
    [dashboardMode, smartCharts]
  );

  const smartInsights = useMemo(() => {
    if (!analysis) return [];
    return generateSmartInsights(analysis, reportSettings, filteredRows, mapping, findings, dataSet?.profiles ?? []);
  }, [analysis, reportSettings, filteredRows, mapping, findings]);

  const forecastResult = useMemo(() => {
    if (!analysis || analysis.periodRevenue.length < 3) return null;
    // Exclude partial endpoints from the forecast fit and anchor — a truncated final month
    // must not drag the projection down. The seasonal method is offered only when the
    // seasonality verdict actually confirms a month/weekday pattern.
    const pc = findings?.periodCompleteness;
    let series = analysis.periodRevenue;
    if (pc) {
      const trimmed = series.slice(pc.partialFirst ? 1 : 0, pc.partialLast ? series.length - 1 : series.length);
      if (trimmed.length >= 3) series = trimmed;
    }
    const seasonalAllowed = findings
      ? findings.seasonality.month.isSignificant || findings.seasonality.dayOfWeek.isSignificant
      : true;
    return computeForecast(series, 3, seasonalAllowed);
  }, [analysis, findings]);

  const customerHealth = useMemo(() => {
    if (!dataSet || !mapping.customer || !mapping.date || !mapping.revenue) return [];
    return computeRFM(canonicalChartRows, mapping.customer, mapping.date, mapping.revenue);
  }, [canonicalChartRows, mapping, dataSet]);

  const abcClassification = useMemo(() => {
    if (!analysis) return [];
    let items = analysis.productRevenue;
    if (items.length < 8 && dataSet && filteredRows.length > 0) {
      const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
      if (valueCol) {
        const candidates = [...additionalDimensions, ...dataSet.profiles.filter((p) => p.type === "text" && p.name !== mapping.product && p.unique >= 8 && p.unique <= 500).map((p) => p.name)];
        for (const dim of candidates) {
          const labels = filteredRows.map((r) => cleanCategory(r[dim])).filter((v) => v !== INVALID_BUCKET);
          const uniqueVals = new Set(labels).size;
          // Cardinality/role guard: only adopt a fallback dimension that behaves like a bounded
          // category. A high-cardinality / near-identifier field (location, customer, code) must
          // never be tiered as if it were an "item".
          if (isTierableDimension(uniqueVals, labels.length, THRESHOLDS.maxTierDimensionCardinality, THRESHOLDS.minTierDimensionCardinality, THRESHOLDS.maxTierUniqueRatio)) {
            items = rankBy(
              filteredRows.map((r) => ({ row: r, val: toNumber(r[valueCol]) })).filter((r) => Number.isFinite(r.val)),
              (r) => cleanCategory(r.row[dim]),
              (r) => r.val,
              true
            );
            break;
          }
        }
      }
    }
    items = items.filter((p) => p.label !== INVALID_BUCKET);
    if (items.length < 3) return [];
    return computeABC(items);
  }, [analysis, dataSet, filteredRows, mapping, additionalDimensions]);

  // Executive summary: render the rule-based text instantly (see summary-card),
  // then ask the Worker for an AI version and swap it in when it arrives. Any
  // failure leaves text: null, so the rule-based fallback keeps showing.
  useEffect(() => {
    if (!analysis || analysis.totalRevenue <= 0) {
      setAiSummary({ text: null, loading: false });
      return;
    }
    let cancelled = false;
    setAiSummary((prev) => ({ text: prev.text, loading: true }));

    const total = analysis.totalRevenue;
    const identifiedProdRev = identifiedProductRevenue(analysis);
    const topProduct = analysis.productRevenue.find((p) => p.label !== INVALID_BUCKET) ?? null;
    const topRegion = realItems(analysis.regionRevenue)[0];
    const top3 = analysis.customerRevenue.slice(0, 3);
    const top3Revenue = top3.reduce((s, c) => s + c.revenue, 0);
    const atRisk = customerHealth.filter((c) => c.segment === "At Risk" || c.segment === "Slipping");
    const atRiskRevenue = atRisk.reduce((s, c) => s + c.monetary, 0);
    const hasCustomer = analysis.customerRevenue.length > 0;

    const metrics = {
      metric: analysis.primaryMetric,
      metricDirection: TEMPLATE_CONFIG[reportSettings.template].metricDirection,
      domain: TEMPLATE_CONFIG[reportSettings.template].insightContext,
      currency: reportSettings.currency,
      // False when the metric is a units column mislabelled as revenue (e.g. Global_Sales): the
      // narrator must then state a plain count, never a currency amount.
      is_money: analysis.isMoney,
      total_revenue: Math.round(total),
      row_count: analysis.rowCount,
      average_transaction: Math.round(analysis.averageRevenue),
      // Trend signal for the model defers to the verdict engine (computed on COMPLETE periods).
      // When the final period is partial its raw % is a truncation artifact, so we suppress the
      // number and flag incompleteness so the model never narrates a fake move.
      trend_verdict: findings ? findings.trend.label : null,
      trend_direction: findings ? (findings.trend.isSignificant ? findings.trend.direction : "flat") : (analysis.latestPeriodChange === null ? "flat" : analysis.latestPeriodChange >= 0 ? "up" : "down"),
      trend_percent: findings?.latestPeriodPartial || analysis.latestPeriodChange === null ? null : Number((analysis.latestPeriodChange * 100).toFixed(1)),
      latest_period_partial: !!findings?.latestPeriodPartial,
      top_product: topProduct ? topProduct.label : null,
      product_share_basis: "identified product revenue (excludes unidentified/junk items)",
      identified_product_revenue: Math.round(identifiedProdRev),
      top_product_share_pct: topProduct && identifiedProdRev > 0 ? Number(((topProduct.revenue / identifiedProdRev) * 100).toFixed(1)) : null,
      top_region: topRegion ? topRegion.label : null,
      ...(hasCustomer ? {
        top3_customer_concentration_pct: top3.length > 0 && total > 0 ? Number(((top3Revenue / total) * 100).toFixed(1)) : null,
        at_risk_customer_count: atRisk.length,
        at_risk_revenue: Math.round(atRiskRevenue),
      } : {}),
      forecast_confidence: forecastResult ? forecastResult.confidence : "Low",
      total_profit: analysis.totalProfit !== null ? Math.round(analysis.totalProfit) : null,
      profit_margin_pct: analysis.totalProfit !== null && analysis.totalRevenue > 0 ? Number(((analysis.totalProfit / analysis.totalRevenue) * 100).toFixed(1)) : null,
      loss_making_categories: analysis.profitByProduct.filter((p) => p.revenue < 0).slice(0, 3).map((p) => ({ name: p.label, loss: Math.round(p.revenue) })),
    };

    const additionalInsights: Array<{ column: string; average: number; min: number; max: number; topByDimension?: Array<{ label: string; avg: number }> }> = [];
    const dimCol = mapping.product || mapping.region || "";
    for (const col of additionalMetrics) {
      const vals = filteredRows.map((r) => parseFloat(r[col])).filter((v) => !isNaN(v));
      if (vals.length === 0) continue;
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const entry: typeof additionalInsights[number] = { column: col, average: Number(avg.toFixed(2)), min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) };
      if (dimCol) {
        const groups: Record<string, number[]> = {};
        for (const row of filteredRows) {
          const dim = cleanCategory(row[dimCol]);
          const val = parseFloat(row[col]);
          if (dim !== INVALID_BUCKET && !isNaN(val)) (groups[dim] ??= []).push(val);
        }
        entry.topByDimension = Object.entries(groups)
          .map(([k, vs]) => ({ label: k, avg: Number((vs.reduce((s, v) => s + v, 0) / vs.length).toFixed(2)) }))
          .sort((a, b) => b.avg - a.avg)
          .slice(0, 3);
      }
      additionalInsights.push(entry);
    }

    const extraDimInsights: Array<{ column: string; uniqueValues: number; topValues: string[] }> = [];
    for (const col of additionalDimensions) {
      const vals = filteredRows.map((r) => (r[col] || "").toString().trim()).filter(Boolean);
      const unique = [...new Set(vals)];
      extraDimInsights.push({ column: col, uniqueValues: unique.length, topValues: unique.slice(0, 5) });
    }

    callSmartAI<{ summary?: string }>("executive_summary", {
      metrics,
      additionalInsights: additionalInsights.length > 0 ? additionalInsights : undefined,
      additionalDimensionInsights: extraDimInsights.length > 0 ? extraDimInsights : undefined,
    }).then((result) => {
      if (cancelled) return;
      let text = result && result.summary ? result.summary : null;
      if (text && !hasCustomer && CUSTOMER_TERMS.test(text)) text = null;
      // Runtime guardrail: strip any LLM sentence asserting a pattern the verdict engine
      // ruled non-significant, so the AI summary agrees with the report/forecast/dashboard.
      if (text && findings) text = sanitizeNarration(text, findings).text;
      setAiSummary({ text, loading: false });
    });

    return () => { cancelled = true; };
  }, [analysis, forecastResult, customerHealth, reportSettings.currency, additionalMetrics, additionalDimensions, filteredRows, mapping, findings]);

  useEffect(() => {
    if (activeTab !== "dashboard" || !analysis || analysis.totalRevenue <= 0) {
      setAiRecommendations({ items: null, loading: false });
      return;
    }
    let cancelled = false;
    setAiRecommendations({ items: null, loading: true });

    const total = analysis.totalRevenue;
    const top3Revenue = analysis.customerRevenue.slice(0, 3).reduce((sum, customer) => sum + customer.revenue, 0);
    const atRisk = customerHealth.filter((customer) => customer.segment === "At Risk" || customer.segment === "Slipping");
    const atRiskRevenue = atRisk.reduce((sum, customer) => sum + customer.monetary, 0);
    const hasCustomer = analysis.customerRevenue.length > 0;
    const abcCounts = { A: 0, B: 0, C: 0 };
    const abcRev = { A: 0, B: 0, C: 0 };
    for (const item of abcClassification) { abcCounts[item.tier] += 1; abcRev[item.tier] += item.pct; }
    const revPct = (frac: number) => Number((frac * 100).toFixed(1));
    const identifiedProdRev = identifiedProductRevenue(analysis);
    const topRealProduct = analysis.productRevenue.find((p) => p.label !== INVALID_BUCKET) ?? null;

    const metrics = {
      trend_verdict: findings ? findings.trend.label : null,
      trend_direction: findings ? (findings.trend.isSignificant ? findings.trend.direction : "flat") : (analysis.latestPeriodChange === null ? "flat" : analysis.latestPeriodChange >= 0 ? "up" : "down"),
      trend_percent: findings?.latestPeriodPartial || analysis.latestPeriodChange === null ? 0 : Number((analysis.latestPeriodChange * 100).toFixed(1)),
      latest_period_partial: !!findings?.latestPeriodPartial,
      ...(hasCustomer ? {
        top3_customer_concentration_pct: total > 0 ? Number(((top3Revenue / total) * 100).toFixed(1)) : 0,
        at_risk_customer_count: atRisk.length,
        at_risk_revenue: Math.round(atRiskRevenue),
      } : {}),
      tier_share_basis: "revenue share of identified product revenue (matches the Pareto/ABC chart). The counts are item counts, not revenue.",
      abc_a_count: abcCounts.A,
      abc_a_revenue_pct: revPct(abcRev.A),
      abc_b_count: abcCounts.B,
      abc_b_revenue_pct: revPct(abcRev.B),
      abc_c_count: abcCounts.C,
      abc_c_revenue_pct: revPct(abcRev.C),
      product_share_basis: "identified product revenue (excludes unidentified/junk items)",
      top_product_share_pct: topRealProduct && identifiedProdRev > 0 ? Number(((topRealProduct.revenue / identifiedProdRev) * 100).toFixed(1)) : 0,
    };

    callSmartAI<{ recommendations?: SmartRecommendation[] }>("recommendations", { metrics }).then((result) => {
      if (cancelled) return;
      const recommendations = Array.isArray(result?.recommendations)
        ? result.recommendations
            .filter((item) => item && item.label && item.title && item.detail)
            .map((item) => ({
              priority: Number(item.priority) || 999,
              label: String(item.label),
              title: String(item.title),
              detail: String(item.detail),
              impact: String(item.impact || "")
            }))
            .sort((a, b) => a.priority - b.priority)
        : [];
      // Reconciliation guard: the model sometimes fabricates a "customers are highly concentrated"
      // risk — it once claimed 90% when the true top-3 customer share is ~1%, confusing it with the
      // product A-tier %. When the real top-3 customer share is low there is no concentration risk,
      // so the whole card is a false premise (not just a wrong number) and must be dropped.
      const top3ConcPct = total > 0 ? (top3Revenue / total) * 100 : 0;
      const isFabricatedConcentration = (r: { title: string; detail: string; impact: string }) => {
        const text = `${r.title} ${r.detail} ${r.impact}`.toLowerCase();
        const aboutCustomerConcentration =
          /(concentrat|top[\s-]?\d|depend|reliance)[^.]*(customer|client|buyer|account)|(customer|client|buyer|account)[^.]*(concentrat|depend|reliance)/.test(text);
        return aboutCustomerConcentration && top3ConcPct < 25;
      };
      const reconciled = recommendations.filter((r) => !isFabricatedConcentration(r));
      const clean = !hasCustomer
        ? reconciled.filter((r) => !CUSTOMER_TERMS.test(`${r.label} ${r.title} ${r.detail} ${r.impact}`))
        : reconciled;
      setAiRecommendations({ items: clean.length > 0 ? clean : null, loading: false });
    });

    return () => { cancelled = true; };
  }, [activeTab, analysis, customerHealth, abcClassification]);

  useEffect(() => {
    if (activeTab !== "dashboard" || !analysis || dashboardSmartCharts.length === 0) {
      setAiChartInsights({});
      return;
    }
    let cancelled = false;
    setAiChartInsights({});

    const chartSummaries = dashboardSmartCharts.map((chart) => {
      const chartData = resolveSmartChartData(chart, analysis) || [];
      const base = { title: chart.title, question: chart.question, type: chart.chartType };
      // Time-series charts are stored chronologically, so the first 3 points are Jan/Feb/Mar — NOT
      // the peak. Sending those made the model say "peaked in January". Send the real peak/low and a
      // flat-vs-trending read over the WHOLE span so the caption names the true peak (e.g. June).
      if (chart.chartType === "line" && chartData.length > 0) {
        const sorted = [...chartData].sort((a, b) => b.revenue - a.revenue);
        const peak = sorted[0];
        const low = sorted[sorted.length - 1];
        const first = chartData[0];
        const last = chartData[chartData.length - 1];
        const mean = chartData.reduce((s, d) => s + d.revenue, 0) / chartData.length;
        const spread = mean > 0 ? (peak.revenue - low.revenue) / mean : 0;
        const overall = first.revenue > 0 ? Math.abs((last.revenue - first.revenue) / first.revenue) : 0;
        const round = (v: number) => Number(v.toFixed(2));
        return {
          ...base,
          periods: chartData.length,
          peakPeriod: { name: peak.label, value: round(peak.revenue) },
          lowestPeriod: { name: low.label, value: round(low.revenue) },
          firstPeriod: { name: first.label, value: round(first.revenue) },
          lastPeriod: { name: last.label, value: round(last.revenue) },
          trend: spread < 0.25 && overall < 0.1 ? "flat (normal month-to-month variation, not a real trend)" : last.revenue >= first.revenue ? "trending up" : "trending down",
        };
      }
      return { ...base, topItems: chartData.slice(0, 3).map((d) => ({ name: d.label, value: d.revenue })) };
    });

    callSmartAI<{ insights?: string[] }>("chart_insights_batch", {
      charts: chartSummaries,
      domain: TEMPLATE_CONFIG[reportSettings.template].insightContext,
      metricLabel: getMetricLabel(mapping, reportSettings.template)
    }).then((result) => {
      if (cancelled) return;
      if (result?.insights && Array.isArray(result.insights)) {
        const next: Record<string, string> = {};
        dashboardSmartCharts.forEach((chart, i) => {
          const insight = result.insights![i];
          if (insight && typeof insight === "string" && insight.trim()) {
            next[getSmartChartKey(chart)] = insight.trim();
          }
        });
        setAiChartInsights(next);
      }
    });

    return () => { cancelled = true; };
  }, [activeTab, analysis, dashboardSmartCharts, mapping, reportSettings.template]);

  const enrichedOutliers = useMemo(() => {
    if (!analysis || analysis.outliers.length === 0) return [];
    return enrichOutliersWithRootCause(analysis.outliers, filteredRows, mapping, analysis.periodRevenue);
  }, [analysis, filteredRows, mapping]);

  const previousAnalysis = useMemo(() => {
    if (!previousDataSet) return null;
    return analyzeData(previousDataSet.rows, mapping, reportSettings.template);
  }, [mapping, previousDataSet]);

  const comparison = useMemo(() => {
    if (!analysis || !previousAnalysis || !dataSet || !previousDataSet) return null;
    return compareAnalyses(analysis, previousAnalysis, dataSet.fileName, previousDataSet.fileName);
  }, [analysis, dataSet, previousAnalysis, previousDataSet]);

  useEffect(() => {
    if (!analysis || !previousAnalysis || !comparison || !dataSet || !previousDataSet) {
      setAiComparisonNarrative({ text: null, loading: false });
      return;
    }
    let cancelled = false;
    setAiComparisonNarrative({ text: null, loading: true });

    const currentName = detectPeriod(dataSet.fileName, dataSet.rows, mapping.date || undefined);
    const previousName = detectPeriod(previousDataSet.fileName, previousDataSet.rows, mapping.date || undefined);
    const payload = {
      period_type: detectComparisonPeriodType(dataSet.rows, previousDataSet.rows, mapping.date || undefined),
      current_period: {
        name: currentName,
        total_revenue: Math.round(analysis.totalRevenue),
        row_count: analysis.rowCount,
        average: Math.round(analysis.averageRevenue),
      },
      previous_period: {
        name: previousName,
        total_revenue: Math.round(previousAnalysis.totalRevenue),
        row_count: previousAnalysis.rowCount,
        average: Math.round(previousAnalysis.averageRevenue),
      },
      top3_product_changes: getTopChangePercents(analysis.productRevenue, previousAnalysis.productRevenue),
      top3_customer_changes: getTopChangePercents(analysis.customerRevenue, previousAnalysis.customerRevenue),
    };

    callSmartAI<{ narrative?: string }>("comparison_narrative", { comparison: payload }).then((result) => {
      if (cancelled) return;
      setAiComparisonNarrative({ text: result?.narrative ? result.narrative.trim() : null, loading: false });
    });

    return () => { cancelled = true; };
  }, [analysis, previousAnalysis, comparison, dataSet, previousDataSet, mapping.date]);

  const multiComparisons = useMemo(() => {
    if (!analysis || !dataSet || comparisonFiles.length === 0) return [];
    return comparisonFiles.map((cf) => {
      const cfAnalysis = analyzeData(cf.rows, mapping, reportSettings.template);
      if (!cfAnalysis) return null;
      return { file: cf, analysis: cfAnalysis, comparison: compareAnalyses(analysis, cfAnalysis, dataSet.fileName, cf.fileName) };
    }).filter(Boolean) as { file: DataSet; analysis: Analysis; comparison: ComparisonSummary }[];
  }, [analysis, dataSet, comparisonFiles, mapping]);

  const flaggedRows = useMemo(() => {
    if (!dataSet) return { blank: [] as number[], duplicate: [] as number[], summary: [] as number[] };
    const seen = new Set<string>();
    const blank: number[] = [];
    const duplicate: number[] = [];
    const summary: number[] = [];
    for (let i = 0; i < dataSet.rows.length; i++) {
      const row = dataSet.rows[i];
      const values = Object.values(row).map((v) => v.trim());
      const key = values.join("|").toLowerCase();
      if (values.every((v) => v === "")) { blank.push(i); continue; }
      if (seen.has(key)) duplicate.push(i);
      else seen.add(key);
      if (values.some((v) => /^(total|grand total|subtotal|summary)$/i.test(v))) summary.push(i);
    }
    return { blank, duplicate, summary };
  }, [dataSet]);

  const cleaningSummary = useMemo(() => {
    if (!dataSet) return null;
    const total = dataSet.rows.length;
    const excluded = excludedRows.size;
    const usable = filteredRows.length;
    return { total, excluded, usable, blank: flaggedRows.blank.length, duplicate: flaggedRows.duplicate.length, summary: flaggedRows.summary.length };
  }, [dataSet, excludedRows, filteredRows, flaggedRows]);

  const canAnalyze = Boolean(dataSet && analysis);

  const generateShareImage = useCallback(() => {
    if (!analysis || !dataSet) return;
    const S = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const brand = reportSettings.brandColor || "#6366f1";
    const metric = analysis.primaryMetric;
    const cur = reportSettings.currency;
    const fmtVal = (v: number) => metric === "Count" ? v.toLocaleString() : formatMoney(v, cur);

    // Background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, S, S);

    // Brand accent bar
    ctx.fillStyle = brand;
    ctx.fillRect(0, 0, S, 8);

    // Title
    ctx.fillStyle = "#1f2933";
    ctx.font = "bold 28px Inter, system-ui, sans-serif";
    ctx.fillText(reportSettings.title || "Data Analysis Report", 60, 60);
    ctx.font = "14px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#7b8794";
    ctx.fillText(`${dataSet.fileName} — ${new Date().toLocaleDateString()}`, 60, 86);

    // Spacer + divider
    ctx.fillStyle = "#e4e7eb";
    ctx.fillRect(60, 106, S - 120, 1);

    // KPIs — 3 cards
    const kpis = [
      { label: `Total ${metric}`, value: fmtVal(analysis.totalRevenue) },
      { label: "Rows analyzed", value: analysis.rowCount.toLocaleString() },
      { label: `Avg ${metric.toLowerCase()}`, value: metric === "Count" ? "1" : fmtVal(analysis.averageRevenue) },
    ];
    const kpiY = 130;
    const kpiW = (S - 120 - 40) / 3;
    kpis.forEach((kpi, i) => {
      const x = 60 + i * (kpiW + 20);
      ctx.fillStyle = "#f5f7fa";
      ctx.beginPath();
      ctx.roundRect(x, kpiY, kpiW, 90, 12);
      ctx.fill();
      ctx.fillStyle = brand;
      ctx.font = "bold 32px Inter, system-ui, sans-serif";
      ctx.fillText(kpi.value, x + 20, kpiY + 40);
      ctx.fillStyle = "#7b8794";
      ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.fillText(kpi.label, x + 20, kpiY + 65);
    });

    // Growth indicator
    let nextY = kpiY + 110;
    if (analysis.latestPeriodChange !== null) {
      const pct = analysis.latestPeriodChange;
      const pctText = `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}% vs last period`;
      ctx.fillStyle = pct >= 0 ? "#38a169" : "#e53e3e";
      ctx.font = "bold 16px Inter, system-ui, sans-serif";
      ctx.fillText(pctText, 60, nextY);
      nextY += 30;
    }

    // Top 3 products — thick readable bars
    nextY += 20;
    const chartData = analysis.productRevenue.slice(0, 3);
    if (chartData.length > 0) {
      ctx.fillStyle = "#1f2933";
      ctx.font = "bold 18px Inter, system-ui, sans-serif";
      ctx.fillText(`Top ${metric === "Count" ? "categories" : "products"}`, 60, nextY);

      const barAreaTop = nextY + 16;
      const barH = 52;
      const barGap = 16;
      const maxVal = Math.max(...chartData.map((d) => d.revenue), 1);
      const maxBarW = S - 120 - 220;
      chartData.forEach((item, i) => {
        const y = barAreaTop + i * (barH + barGap);
        const w = (item.revenue / maxVal) * maxBarW;
        ctx.fillStyle = "#3e4c59";
        ctx.font = "16px Inter, system-ui, sans-serif";
        ctx.fillText(item.label.length > 22 ? item.label.slice(0, 20) + "..." : item.label, 60, y + 32);
        ctx.fillStyle = brand;
        ctx.globalAlpha = 1 - i * 0.15;
        ctx.beginPath();
        ctx.roundRect(280, y + 8, Math.max(w, 4), barH - 16, 8);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#3e4c59";
        ctx.font = "bold 16px Inter, system-ui, sans-serif";
        ctx.fillText(fmtVal(item.revenue), 280 + Math.max(w, 4) + 12, y + 32);
      });
      nextY = barAreaTop + chartData.length * (barH + barGap) + 16;
    }

    // Key insights — 3 bullets
    const bulletInsights = smartInsights.slice(0, 3);
    if (bulletInsights.length > 0) {
      ctx.fillStyle = "#1f2933";
      ctx.font = "bold 16px Inter, system-ui, sans-serif";
      ctx.fillText("Key insights", 60, nextY);
      ctx.font = "13px Inter, system-ui, sans-serif";
      bulletInsights.forEach((ins, i) => {
        const y = nextY + 26 + i * 30;
        ctx.fillStyle = ins.sentiment === "positive" ? "#38a169" : ins.sentiment === "negative" ? "#e53e3e" : "#3e4c59";
        const icon = ins.sentiment === "positive" ? "▲" : ins.sentiment === "negative" ? "▼" : "●";
        const text = `${icon}  ${ins.text.length > 90 ? ins.text.slice(0, 88) + "..." : ins.text}`;
        ctx.fillText(text, 60, y);
      });
    }

    // Footer — pinned to absolute bottom with guaranteed gap
    ctx.fillStyle = "#e4e7eb";
    ctx.fillRect(60, S - 50, S - 120, 1);
    ctx.fillStyle = "#9aa5b1";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.fillText("Generated by Sheet Analysis AI", 60, S - 26);
    if (trustScore) {
      ctx.fillText(`Trust Score: ${trustScore.score}%`, S - 240, S - 26);
    }

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(reportSettings.title || "report").replace(/\s+/g, "-").toLowerCase()}-share.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [analysis, dataSet, reportSettings, smartInsights, trustScore]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.mapping, mapping);
  }, [mapping]);

  useEffect(() => {
    loadSnapshots().then(setAnalysisHistory).catch(() => {});
  }, []);

  useEffect(() => {
    if (!analysis || !dataSet || !mappingConfirmed) return;
    const snap: AnalysisSnapshot = {
      id: `${dataSet.fileName}-${Date.now()}`,
      fileName: dataSet.fileName,
      uploadDate: new Date().toISOString(),
      totalRevenue: analysis.totalRevenue,
      rowCount: analysis.rowCount,
      avgMetric: analysis.averageRevenue,
      primaryMetric: analysis.primaryMetric,
      topProducts: analysis.productRevenue.slice(0, 20),
      topRegions: analysis.regionRevenue.slice(0, 20),
      periodRevenue: analysis.periodRevenue,
    };
    saveSnapshot(snap).then(() => loadSnapshots().then(setAnalysisHistory)).catch(() => {});
  }, [analysis, dataSet, mappingConfirmed]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.reportSettings, reportSettings);
  }, [reportSettings]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.aiSettings, aiSettings);
  }, [aiSettings]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.savedWorkflows, savedWorkflows);
  }, [savedWorkflows]);

  useEffect(() => {
    saveJson(STORAGE_KEYS.recentFiles, recentFiles);
  }, [recentFiles]);

  useEffect(() => {
    if (exploreTab !== "charts" || !dataSet || !analysis || aiChartSuggestions !== null || aiChartSuggestionsLoading) return;
    setAiChartSuggestionsLoading(true);
    const metricCol = mapping.revenue || mapping.quantity || mapping.cost || "";
    const dims: Record<string, string> = {};
    if (mapping.date) dims.date = mapping.date;
    if (mapping.product) dims.product = mapping.product;
    if (mapping.customer) dims.customer = mapping.customer;
    if (mapping.region) dims.region = mapping.region;
    const numericCols = dataSet.profiles.filter((p) => p.type === "number" && p.name !== metricCol).map((p) => p.name);
    const extras = additionalMetrics.length > 0 ? additionalMetrics : numericCols.slice(0, 4);
    callSmartAI<{ charts?: Array<{ title: string; type: string; x: string; y: string; aggregation: string; reason: string }> }>("recommend_charts", {
      domain: reportSettings.template,
      metricLabel: analysis.primaryMetric,
      metricColumn: metricCol,
      dimensions: dims,
      additionalMetrics: extras,
      additionalDimensions: additionalDimensions,
      analysisMode,
      identifierColumns,
      columns: dataSet.headers,
      stats: {
        totalRows: analysis.rowCount,
        totalMetric: analysis.totalRevenue,
        periodCount: analysis.periodRevenue.length,
        productCount: analysis.productRevenue.length,
        regionCount: analysis.regionRevenue.length,
      },
    }).then((result) => {
      setAiChartSuggestionsLoading(false);
      if (result?.charts && Array.isArray(result.charts)) {
        setAiChartSuggestions(result.charts.slice(0, 6));
      } else {
        setAiChartSuggestions([]);
      }
    }).catch(() => {
      setAiChartSuggestionsLoading(false);
      setAiChartSuggestions([]);
    });
  }, [exploreTab, dataSet, analysis, aiChartSuggestions, aiChartSuggestionsLoading, mapping, additionalMetrics, additionalDimensions, analysisMode, identifierColumns, reportSettings.template]);

  function generateAutoInsights() {
    if (!analysis || !dataSet) return;
    const hasAccess = aiSettings.apiKey.trim() || (creditsRemaining !== null && creditsRemaining > 0);
    if (!hasAccess) return;
    setAutoInsights({ texts: [], loading: true });
    const insightPrompt = `Give exactly 5 quick one-line business insights from this data. Each insight must start with an emoji that represents the insight type (e.g. trending up, warning, star, target, money). Keep each insight under 20 words. Use exact numbers. No bullet points or numbering — just one insight per line.`;

    const processResponse = (response: string) => {
      const lines = response.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5);
      setAutoInsights({ texts: lines, loading: false });
    };

    if (aiSettings.apiKey.trim()) {
      callAI(insightPrompt, analysis, reportSettings, aiSettings, dataSet, 1000, mapping)
        .then(processResponse)
        .catch(() => setAutoInsights({ texts: [], loading: false }));
    } else {
      const context = buildAnalysisContext(analysis, reportSettings, dataSet, mapping);
      callSmartAI<{ text?: string }>("auto_insights", {
        systemPrompt: AI_SYSTEM_PROMPT + "\n\n" + context,
        userPrompt: insightPrompt,
      }).then((result) => {
        if (result?.text) processResponse(result.text);
        else setAutoInsights({ texts: [], loading: false });
      }).catch(() => setAutoInsights({ texts: [], loading: false }));
    }
  }

  async function createChartFromPrompt() {
    const question = chartPrompt.trim();
    if (!question || !dataSet) return;
    setChartPromptStatus({ loading: true, error: null });

    const result = await callSmartAI<ChartConfigResponse>("chart_config", {
      question,
      columns: dataSet.headers,
      types: Object.fromEntries(dataSet.profiles.map((profile) => [profile.name, profile.type])),
      roles: mapping,
    });

    const findColumn = (value: string | null | undefined): string => {
      if (!value || value === "__count__") return "";
      const normalized = value.trim().toLowerCase();
      return dataSet.headers.find((header) => header.toLowerCase() === normalized) || "";
    };
    const normalizeChartType = (value: string | null | undefined): string => {
      const type = String(value || "bar").toLowerCase().replace(/\s+/g, "_");
      if (type === "pie") return "donut";
      if (["bar", "horizontal_bar", "combo", "line", "area", "donut", "scatter", "table"].includes(type)) return type;
      return "bar";
    };
    const normalizeAggregation = (value: string | null | undefined): string => {
      const agg = String(value || "sum").toLowerCase();
      if (agg === "average" || agg === "mean") return "avg";
      if (["sum", "avg", "count", "max", "min"].includes(agg)) return agg;
      return "sum";
    };
    const normalizeTopN = (value: number | null | undefined): number => {
      if (!value || value <= 0) return 0;
      if (value <= 5) return 5;
      if (value <= 10) return 10;
      return 20;
    };

    const xCol = findColumn(result?.x);
    const yCol = result?.y === "__count__" || normalizeAggregation(result?.aggregation) === "count" ? "__count__" : findColumn(result?.y);
    const groupCol = findColumn(result?.group_by);

    if (!result || !xCol || (!yCol && normalizeAggregation(result.aggregation) !== "count")) {
      setChartPromptStatus({ loading: false, error: "Couldn't understand that. Try using the dropdowns below." });
      return;
    }

    const config = {
      type: normalizeChartType(result.chart_type),
      xCol,
      yCol: yCol || "__count__",
      agg: normalizeAggregation(result.aggregation),
      groupCol: groupCol && groupCol !== xCol ? groupCol : "",
      topN: normalizeTopN(result.top_n),
    };
    setChartBuilder((prev) => ({
      ...prev,
      ...config,
      title: result.title ? String(result.title).trim() : prev.title,
    }));
    setChartBuilderOrigin(config);
    setChartPromptStatus({ loading: false, error: null });
  }

  function applyParsedFile(fileName: string, parsed: { headers: string[]; rows: Record<string, string>[]; headerWarning?: string }) {
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      throw new Error("No usable rows found.");
    }
    setDataNotices(parsed.headerWarning ? [parsed.headerWarning] : []);
    if (parsed.rows.length > MAX_ROWS) {
      throw new Error(`This file has ${parsed.rows.length.toLocaleString()} rows. The maximum supported is ${MAX_ROWS.toLocaleString()} rows. Please split the file or use a smaller subset.`);
    }
    if (parsed.rows.length > WARN_ROWS) {
      setError(`Large file: ${parsed.rows.length.toLocaleString()} rows. Analysis may be slow on some devices.`);
    }

    const profiles = profileColumns(parsed.headers, parsed.rows);
    setDataSet({
      fileName,
      headers: parsed.headers,
      rows: parsed.rows,
      profiles,
      quality: getDataQualitySummary(parsed.rows)
    });
    setMapping(createEmptyMapping());
    setMappingStatus("");
    addRecentFile(fileName, parsed.rows.length);

    setAiMappingLoading(true);
    callSmartAI<{
      analysisMode?: "sum" | "count" | "average";
      primaryMetric?: string | null;
      domain?: string;
      metricLabel?: string;
      metricDirection?: string;
      mapping?: Record<string, string>;
      identifierColumns?: string[];
      suggestedAdditionalMetrics?: string[];
      suggestedAdditionalDimensions?: string[];
      reasoning?: string;
    }>("smart_mapping", {
      columns: profiles.map((p) => ({
        name: p.name,
        samples: p.examples?.slice(0, 5) || [],
        type: p.type,
        uniqueCount: p.unique,
        nullCount: p.missing,
        isSequential: p.type === "number" && p.cardinality > 0.95,
        isAllUnique: p.unique === parsed.rows.length,
      })),
      sampleRows: parsed.rows.slice(0, 5),
      totalRows: parsed.rows.length,
    }).then((ai) => {
      setAiMappingLoading(false);
      if (!ai?.mapping) {
        const fallback = createMappingFromProfiles(profiles);
        setMapping(fallback);
        setReportSettings((current) => { const t = detectTemplate(parsed.headers, fallback); return { ...current, template: t, title: isDefaultTitle(current.title) ? TEMPLATE_TITLES[t] : current.title }; });
        setMappingStatus("AI unavailable — using automatic detection.");
        return;
      }
      console.log("[smart_mapping] AI response:", ai);

      if (ai.analysisMode) setAnalysisMode(ai.analysisMode);
      if (ai.identifierColumns?.length) setIdentifierColumns(ai.identifierColumns.filter((c) => parsed.headers.includes(c)));

      const aiMap = ai.mapping;
      const base = createEmptyMapping();
      for (const [role, col] of Object.entries(aiMap)) {
        if (role in base && typeof col === "string" && col && parsed.headers.includes(col)) {
          (base as Record<string, string>)[role] = col;
        }
      }
      setMapping(base);
      const tmpl = (ai.domain as ReportTemplate) ?? detectTemplate(parsed.headers, base);
      setReportSettings((current) => ({
        ...current,
        template: tmpl,
        title: isDefaultTitle(current.title) ? TEMPLATE_TITLES[tmpl] : current.title,
      }));

      if (ai.suggestedAdditionalMetrics?.length) {
        const validExtra = ai.suggestedAdditionalMetrics.filter((c) => parsed.headers.includes(c));
        if (validExtra.length) setAdditionalMetrics(validExtra);
      } else {
        const mainMetric = base.revenue || base.quantity || base.cost || "";
        const mappedSet = new Set(Object.values(base).filter(Boolean));
        setAdditionalMetrics(profiles
          .filter((p) => p.type === "number" && p.name !== mainMetric && !mappedSet.has(p.name))
          .sort((a, b) => b.sum - a.sum)
          .slice(0, 4)
          .map((p) => p.name));
      }
      if (ai.suggestedAdditionalDimensions?.length) {
        const validDims = ai.suggestedAdditionalDimensions.filter((c) => parsed.headers.includes(c));
        if (validDims.length) setAdditionalDimensions(validDims);
      }

      setMappingStatus("AI-suggested mapping applied.");
    }).catch(() => {
      setAiMappingLoading(false);
      const fallback = createMappingFromProfiles(profiles);
      setMapping(fallback);
      setReportSettings((current) => { const t = detectTemplate(parsed.headers, fallback); return { ...current, template: t, title: isDefaultTitle(current.title) ? TEMPLATE_TITLES[t] : current.title }; });
      setMappingStatus("AI unavailable — using automatic detection.");
    });
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setChatMessages([]);
    setExcludedRows(new Set());
    setMappingConfirmed(false);
    setAiMappingLoading(false);
    setAiChartSuggestions(null);
    setAdditionalMetrics([]);
    setAdditionalDimensions([]);
    setAnalysisMode("sum");
    setIdentifierColumns([]);

    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["csv", "xlsx", "xls"].includes(extension)) {
      setError("Upload a CSV, XLSX, or XLS file.");
      return;
    }

    if (extension === "csv") {
      setFileParsing(true);
      const worker = new Worker(new URL("./csv-worker.ts", import.meta.url), { type: "module" });
      const text = await file.text();
      worker.postMessage(text);
      worker.onmessage = (e: MessageEvent<{ type: string; data?: { headers: string[]; rows: Record<string, string>[]; headerWarning?: string }; message?: string }>) => {
        worker.terminate();
        setFileParsing(false);
        if (e.data.type === "error") {
          setError(e.data.message ?? "Could not read this file.");
          return;
        }
        try {
          applyParsedFile(file.name, e.data.data!);
        } catch (caughtError) {
          setError(caughtError instanceof Error ? caughtError.message : "Could not read this file.");
        }
      };
      worker.onerror = () => {
        worker.terminate();
        setFileParsing(false);
        setError("Could not read this file.");
      };
    } else {
      setFileParsing(true);
      try {
        const parsed = await parseWorkbook(file);
        applyParsedFile(file.name, parsed);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Could not read this file.");
      } finally {
        setFileParsing(false);
      }
    }
  }

  async function handlePreviousFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);

    try {
      const parsed = await parseUploadedFile(file);
      const profiles = profileColumns(parsed.headers, parsed.rows);
      setPreviousDataSet({
        fileName: file.name,
        headers: parsed.headers,
        rows: parsed.rows,
        profiles,
        quality: getDataQualitySummary(parsed.rows)
      });
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not read the comparison file.");
    }
  }

  async function handleAddComparisonFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const parsed = await parseUploadedFile(file);
      if (parsed.rows.length > MAX_ROWS) {
        throw new Error(`Comparison file has too many rows (${parsed.rows.length.toLocaleString()}). Max: ${MAX_ROWS.toLocaleString()}.`);
      }
      const profiles = profileColumns(parsed.headers, parsed.rows);
      const ds: DataSet = { fileName: file.name, headers: parsed.headers, rows: parsed.rows, profiles, quality: getDataQualitySummary(parsed.rows) };
      setComparisonFiles((prev) => [...prev.filter((f) => f.fileName !== file.name), ds]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not read the comparison file.");
    }
  }

  function removeComparisonFile(fileName: string) {
    setComparisonFiles((prev) => prev.filter((f) => f.fileName !== fileName));
  }

  // Shared ingestion path for any CSV text — the built-in samples, or a sheet
  // imported from Google Drive. Returns the row count so callers can log it.
  function loadCsvText(csvText: string, fileName: string): number {
    const parsed = parseCsv(csvText);
    const profiles = profileColumns(parsed.headers, parsed.rows);
    setError(null);
    setDataNotices([]);
    setChatMessages([]);
    setExcludedRows(new Set());
    setMappingConfirmed(false);
    setDataSet({
      fileName,
      headers: parsed.headers,
      rows: parsed.rows,
      profiles,
      quality: getDataQualitySummary(parsed.rows)
    });
    const nextMapping = mergeStoredMapping(parsed.headers, createMappingFromProfiles(profiles));
    setMappingStatus(hasReusableStoredMapping(parsed.headers) ? "Mapping reused from a previous file." : "");
    setMapping(nextMapping);
    setReportSettings((current) => { const t = detectTemplate(parsed.headers, nextMapping); return { ...current, template: t, title: isDefaultTitle(current.title) ? TEMPLATE_TITLES[t] : current.title }; });
    setAiChartSuggestions(null);
    setAnalysisMode("sum");
    setIdentifierColumns([]);
    setAdditionalDimensions([]);
    const sMainMetric = nextMapping.revenue || nextMapping.quantity || nextMapping.cost || "";
    const sMappedSet = new Set(Object.values(nextMapping).filter(Boolean));
    setAdditionalMetrics(
      profiles.filter((p) => p.type === "number" && p.name !== sMainMetric && !sMappedSet.has(p.name))
        .sort((a, b) => b.sum - a.sum).slice(0, 4).map((p) => p.name)
    );
    return parsed.rows.length;
  }

  function loadSampleData(type: "sales" | "expenses" | "marketing" = "sales") {
    const csvMap = { sales: SAMPLE_SALES_CSV, expenses: SAMPLE_EXPENSE_CSV, marketing: SAMPLE_MARKETING_CSV };
    const nameMap = { sales: "sample_sales_report.csv", expenses: "sample_expense_report.csv", marketing: "sample_marketing_report.csv" };
    loadCsvText(csvMap[type], nameMap[type]);
  }

  // Pull a spreadsheet straight from the user's Google Drive. The sheet is
  // exported to CSV in the browser and then follows the exact same path as an
  // uploaded file — nothing is sent to our servers.
  async function handleGoogleSheetsImport() {
    if (googleImporting) return;
    setGoogleImporting(true);
    setError(null);
    try {
      const result = await importFromGoogleSheets();
      if (result) {
        const rowCount = loadCsvText(result.csv, result.fileName);
        addRecentFile(result.fileName, rowCount);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't import from Google Sheets.");
    } finally {
      setGoogleImporting(false);
    }
  }

  function addRecentFile(fileName: string, rowCount: number) {
    setRecentFiles((prev) => {
      const filtered = prev.filter((f) => f.fileName !== fileName);
      return [{ fileName, rows: rowCount, openedAt: new Date().toISOString() }, ...filtered].slice(0, 10);
    });
  }

  function saveCurrentWorkflow() {
    if (!dataSet) return;
    const name = dataSet.fileName.replace(/\.[^.]+$/, "").replace(/[-_]\d{4}[-_]\d{2}[-_]\d{2}.*/, "").trim() || "Untitled";
    setSavedWorkflows((prev) => {
      const filtered = prev.filter((w) => w.name !== name);
      return [{ name, headers: dataSet.headers, mapping, savedAt: new Date().toISOString() }, ...filtered].slice(0, 20);
    });
  }

  function applyWorkflow(workflow: SavedWorkflow) {
    if (!dataSet) return;
    const next = { ...createEmptyMapping() };
    for (const role of Object.keys(workflow.mapping) as Role[]) {
      if (workflow.mapping[role] && dataSet.headers.includes(workflow.mapping[role])) {
        next[role] = workflow.mapping[role];
      }
    }
    setMapping(next);
    setMappingStatus(`Mapping applied from saved workflow "${workflow.name}".`);
  }

  function deleteWorkflow(name: string) {
    setSavedWorkflows((prev) => prev.filter((w) => w.name !== name));
  }

  function updateMapping(role: Role, column: string) {
    setMapping((current) => ({ ...current, [role]: column }));
  }

  async function askQuestion(question?: string) {
    const prompt = (question ?? chatInput).trim();
    if (!prompt || !analysis) return;

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", text: prompt };
    setChatInput("");

    if (aiSettings.apiKey.trim()) {
      const loadingMsg: ChatMessage = { id: `a-${Date.now()}`, role: "analyst", text: "Thinking..." };
      setChatMessages((messages) => [...messages, userMsg, loadingMsg]);
      setAiLoading(true);
      try {
        // Include conversation history for context (last 5 exchanges)
        const recentHistory = chatMessages.slice(-10).map((m) => `${m.role === "user" ? "User" : "Analyst"}: ${m.text}`).join("\n");
        const contextualPrompt = recentHistory ? `Previous conversation:\n${recentHistory}\n\nNew question: ${prompt}` : prompt;
        const aiResponse = await callAI(contextualPrompt, analysis, reportSettings, aiSettings, dataSet, 1000, mapping);
        const { cleanText, chart } = parseChartCommand(aiResponse);
        const guardedText = findings ? sanitizeNarration(cleanText, findings).text : cleanText;
        setChatMessages((messages) =>
          messages.map((m) => (m.id === loadingMsg.id ? { ...m, text: guardedText, chart: chart ?? undefined } : m))
        );
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "AI request failed. Check your API key.";
        setChatMessages((messages) =>
          messages.map((m) => (m.id === loadingMsg.id ? { ...m, text: `Error: ${errorText}` } : m))
        );
      } finally {
        setAiLoading(false);
      }
    } else {
      // Free smart-AI path (Worker). Falls back to rule-based if the Worker is offline.
      const history = [...chatMessages, userMsg];
      const loadingMsg: ChatMessage = { id: `a-${Date.now()}`, role: "analyst", text: "Thinking..." };
      setChatMessages((messages) => [...messages, userMsg, loadingMsg]);
      setAiLoading(true);
      try {
        const result = await smartAnswer(prompt, analysis, reportSettings, dataSet, mapping, history, additionalMetrics, additionalDimensions, analysisMode, identifierColumns, findings);
        const displayText = result.warning ? `${result.text}\n\n⚠️ ${result.warning}` : result.text;
        setChatMessages((messages) =>
          messages.map((m) => (m.id === loadingMsg.id ? { ...m, text: displayText, chart: result.chart ?? undefined } : m))
        );
      } finally {
        setAiLoading(false);
      }
    }
  }

  function validateAiOutput(text: string): string {
    const warnings: string[] = [];
    const pctMatches = text.match(/(\d[\d,.]*)\s*%\s*(ROI|roi|margin|growth)/gi) || [];
    for (const m of pctMatches) {
      const num = parseFloat(m.replace(/[,%]/g, ""));
      if (num > 1000) warnings.push(`Suspicious figure: "${m.trim()}" — verify against dashboard`);
    }
    if (warnings.length > 0) {
      return text + "\n\n---\n⚠️ Note: " + warnings.join(". ") + ". See the dashboard for exact numbers.";
    }
    return text;
  }

  async function runAgent(agentId: AgentId) {
    if (!analysis) return;
    const hasAccess = aiSettings.apiKey.trim() || (creditsRemaining !== null && creditsRemaining > 0);
    if (!hasAccess) return;

    const agent = AI_AGENTS.find((a) => a.id === agentId);
    if (!agent) return;

    setAgentResults((prev) => [
      ...prev.filter((r) => r.agentId !== agentId),
      { agentId, text: "", loading: true }
    ]);

    try {
      let response: string;
      if (aiSettings.apiKey.trim()) {
        response = await callAI(agent.prompt, analysis, reportSettings, aiSettings, dataSet, 2000, mapping);
      } else {
        const context = buildAnalysisContext(analysis, reportSettings, dataSet, mapping);
        const result = await callSmartAI<{ text?: string }>("ai_agent", {
          systemPrompt: AI_SYSTEM_PROMPT + "\n\n" + context,
          userPrompt: agent.prompt,
        });
        response = result?.text || "No response from AI.";
      }
      response = validateAiOutput(response);
      setAgentResults((prev) =>
        prev.map((r) => (r.agentId === agentId ? { ...r, text: response, loading: false } : r))
      );
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "Agent request failed.";
      setAgentResults((prev) =>
        prev.map((r) => (r.agentId === agentId ? { ...r, text: `Error: ${errorText}`, loading: false } : r))
      );
    }
  }

  function clearAgentResult(agentId: AgentId) {
    setAgentResults((prev) => prev.filter((r) => r.agentId !== agentId));
  }

  async function runAllAgents() {
    if (!analysis) return;
    const hasAccess = aiSettings.apiKey.trim() || (creditsRemaining !== null && creditsRemaining > 0);
    if (!hasAccess) return;
    for (const agent of AI_AGENTS) {
      setAgentResults((prev) => [
        ...prev.filter((r) => r.agentId !== agent.id),
        { agentId: agent.id, text: "", loading: true }
      ]);
      try {
        let response: string;
        if (aiSettings.apiKey.trim()) {
          response = await callAI(agent.prompt, analysis, reportSettings, aiSettings, dataSet, 2000, mapping);
        } else {
          const context = buildAnalysisContext(analysis, reportSettings, dataSet, mapping);
          const result = await callSmartAI<{ text?: string }>("ai_agent", {
            systemPrompt: AI_SYSTEM_PROMPT + "\n\n" + context,
            userPrompt: agent.prompt,
          });
          response = result?.text || "No response from AI.";
        }
        response = validateAiOutput(response);
        setAgentResults((prev) =>
          prev.map((r) => (r.agentId === agent.id ? { ...r, text: response, loading: false } : r))
        );
      } catch (err) {
        const errorText = err instanceof Error ? err.message : "Agent request failed.";
        setAgentResults((prev) =>
          prev.map((r) => (r.agentId === agent.id ? { ...r, text: `Error: ${errorText}`, loading: false } : r))
        );
      }
    }
  }

  function copyAgentResult(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function downloadAllAgentReports() {
    const completed = AI_AGENTS.filter((a) => agentResults.find((r) => r.agentId === a.id && r.text && !r.loading));
    if (completed.length === 0) return;
    const divider = "═".repeat(60);
    const lines = [
      `SHEET ANALYSIS AI — Agent Reports`,
      `Generated: ${new Date().toLocaleString()}`,
      `File: ${dataSet?.fileName ?? "Unknown"}`,
      `Rows: ${dataSet?.rows.length.toLocaleString() ?? "N/A"}`,
      divider,
      "",
    ];
    for (const agent of completed) {
      const result = agentResults.find((r) => r.agentId === agent.id);
      if (!result?.text) continue;
      lines.push(`▶ ${agent.title.toUpperCase()}`, `  ${agent.description}`, "", result.text, "", divider, "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-analysis-${(dataSet?.fileName ?? "report").replace(/\.[^.]+$/, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function generateAIReport() {
    if (!analysis || !dataSet) return;
    const hasAccess = aiSettings.apiKey.trim() || (creditsRemaining !== null && creditsRemaining > 0);
    if (!hasAccess) return;
    setAiReport({ loading: true, sections: [] });

    const reportPrompt = `You are generating a COMPLETE business report. Analyze all the data and create a comprehensive report with these sections. For each section, provide analysis text AND a chart where relevant.

IMPORTANT: Return your response in this EXACT format — each section starts with === SECTION: Title === on its own line, followed by the analysis text. Include \`\`\`chart JSON\`\`\` blocks where appropriate.

=== SECTION: Executive Summary ===
Write a 3-4 sentence executive overview of the business performance.

=== SECTION: Key Metrics ===
Summarize the most important numbers. Include a \`\`\`chart bar chart\`\`\` of the top 5-6 key metrics.

=== SECTION: Trend Analysis ===
Analyze performance trends over time. Include a \`\`\`chart line chart\`\`\` showing the trend.

=== SECTION: Top Performers ===
Identify the best-performing products/categories/regions. Include a \`\`\`chart bar chart\`\`\` of top performers.

=== SECTION: Distribution Analysis ===
Analyze how values are distributed. Include a \`\`\`chart pie chart\`\`\` showing the distribution.

=== SECTION: Risks & Opportunities ===
Identify potential risks and growth opportunities based on the data patterns.

=== SECTION: Recommendations ===
Provide 3-5 actionable recommendations based on your analysis.

Make each section substantive with specific numbers from the data. Every chart must use the \`\`\`chart JSON\`\`\` format.`;

    try {
      let response: string;
      if (aiSettings.apiKey.trim()) {
        response = await callAI(reportPrompt, analysis, reportSettings, aiSettings, dataSet, 4000, mapping);
      } else {
        const context = buildAnalysisContext(analysis, reportSettings, dataSet, mapping);
        const result = await callSmartAI<{ text?: string }>("ai_report", {
          systemPrompt: AI_SYSTEM_PROMPT + "\n\n" + context,
          userPrompt: reportPrompt,
        });
        response = result?.text || "No response from AI.";
      }
      response = validateAiOutput(response);
      // Parse sections
      const sectionRegex = /===\s*SECTION:\s*(.+?)\s*===([\s\S]*?)(?====\s*SECTION:|$)/g;
      const sections: Array<{ title: string; text: string; chart?: ChartCommand }> = [];
      let match;
      // Runtime guardrail: route every section's prose through the verdict-gated sanitizer so
      // the report can't assert a pattern (trend/season/price-leader) the engine ruled out.
      const guard = (t: string) => (findings ? sanitizeNarration(t, findings).text : t);
      while ((match = sectionRegex.exec(response)) !== null) {
        const title = match[1].trim();
        const content = match[2].trim();
        const { cleanText, chart } = parseChartCommand(content);
        sections.push({ title, text: guard(cleanText), chart: chart ?? undefined });
      }
      // If no sections parsed, treat whole response as one section
      if (sections.length === 0) {
        const { cleanText, chart } = parseChartCommand(response);
        sections.push({ title: "AI Report", text: guard(cleanText), chart: chart ?? undefined });
      }
      setAiReport({ loading: false, sections });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "AI report generation failed.";
      setAiReport({ loading: false, sections: [{ title: "Error", text: errorText }] });
    }
  }

  function exportCleanedCsv() {
    if (!dataSet || !analysis) return;
    const rows = getUsableRows(filteredRows, mapping);
    downloadCsv(rows, `${stripExtension(dataSet.fileName)}-cleaned.csv`);
  }

  function exportSkippedRows() {
    if (!dataSet || !analysis) return;
    const excluded = dataSet.rows.filter((_, i) => excludedRows.has(i));
    const skipped = getSkippedRows(filteredRows, mapping);
    downloadCsv([...excluded, ...skipped], `${stripExtension(dataSet.fileName)}-skipped-rows.csv`);
  }

  // FIX 1 — the refuse-and-disclose prompt shown wherever the revenue total would otherwise be
  // computed. Rendered on the upload (Confirm) tab and in place of the blocked dashboard.
  const revenueGatePrompt =
    !revenueConfidence.ok && !revenueConfirmed ? (
      <div className="data-notices revenue-gate" role="alert">
        <p className="data-notice"><strong>We couldn&apos;t confirm which column is revenue — please confirm.</strong></p>
        <p className="data-notice">{revenueConfidence.detail}</p>
        <div className="smart-prompt-actions">
          <button className="agent-run-button" onClick={() => setRevenueConfirmed(true)}>
            Yes, &quot;{revenueConfidence.column}&quot; is revenue — analyze anyway
          </button>
          <span className="muted">Or choose a different revenue column in the mapping above.</span>
        </div>
      </div>
    ) : null;

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Sheet Analysis AI</p>
          <h1>Turn monthly spreadsheets into trusted manager-ready reports.</h1>
        </div>
        <div className="top-bar-actions">
          <button className="print-button" onClick={() => { setActiveTab("dashboard"); setTimeout(() => window.print(), 100); }} disabled={!canAnalyze}>
            Print / PDF
          </button>
        </div>
      </header>

      <nav className="view-tabs">
        <button className={`view-tab ${activeTab === "upload" ? "active" : ""}`} onClick={() => setActiveTab("upload")}>
          Upload
          {dataSet && <span className="tab-check" />}
        </button>
        <button
          className={`view-tab ${activeTab === "dashboard" ? "active" : ""}`}
          onClick={() => setActiveTab("dashboard")}
          disabled={!canAnalyze}
        >
          Dashboard
          {canAnalyze && trustScore && (
            <span className={`tab-badge ${trustScore.label === "High" ? "good" : trustScore.label === "Medium" ? "warn" : "bad"}`}>
              {trustScore.score}%
            </span>
          )}
        </button>
        <button
          className={`view-tab ${activeTab === "explore" ? "active" : ""}`}
          onClick={() => setActiveTab("explore")}
          disabled={!dataSet}
        >
          Explore
        </button>
        <button
          className={`view-tab ${activeTab === "ai" ? "active" : ""}`}
          onClick={() => setActiveTab("ai")}
          disabled={!canAnalyze}
        >
          Deep Analysis
        </button>
        {/* Credit badge + redeem exist only with a hosted worker. The open-source build is
            bring-your-own-key, so this whole group is hidden. */}
        {AI_WORKER_ENABLED && (
          <div className="credit-group">
            {aiSettings.apiKey
              ? <span className="credit-badge credit-unlimited">&infin; Unlimited</span>
              : creditsRemaining !== null && creditsRemaining !== Infinity
                ? <span className={`credit-badge ${creditsRemaining < 20 ? "credit-low" : creditsRemaining < 50 ? "credit-warn" : ""}`}>{creditsRemaining} credits</span>
                : creditsRemaining === Infinity
                  ? <span className="credit-badge credit-unlimited">&infin; Free</span>
                  : null
            }
            {!aiSettings.apiKey && (
              redeemOpen ? (
                <span className="redeem-inline">
                  <input
                    className="redeem-input"
                    type="text"
                    value={redeemInput}
                    placeholder="Enter code"
                    autoFocus
                    onChange={(e) => setRedeemInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRedeem(); }}
                  />
                  <button className="redeem-submit" onClick={handleRedeem} disabled={redeemBusy}>{redeemBusy ? "…" : "Apply"}</button>
                  <button className="redeem-close" aria-label="Cancel" onClick={() => { setRedeemOpen(false); setRedeemMsg(null); }}>&times;</button>
                  {redeemMsg && <span className={`redeem-msg ${redeemMsg.ok ? "ok" : "err"}`}>{redeemMsg.text}</span>}
                </span>
              ) : (
                <button className="redeem-toggle" onClick={() => setRedeemOpen(true)}>Redeem code</button>
              )
            )}
          </div>
        )}
      </nav>

      {fileParsing && (
        <div className="smart-prompt-overlay">
          <div className="smart-prompt-box info" style={{ textAlign: "center", padding: "2rem" }}>
            <div className="parsing-spinner" />
            <strong style={{ display: "block", marginTop: "1rem", fontSize: "1.1rem" }}>Parsing your file...</strong>
            <p style={{ color: "#94a3b8", marginTop: "0.5rem" }}>Large files may take a few seconds.</p>
          </div>
        </div>
      )}

      {dataSet && !mappingConfirmed && !fileParsing && (
        <div className="smart-prompt-overlay smart-prompt-see-through" onClick={(e) => { if (e.target === e.currentTarget) setMappingConfirmed(true); }}>
          <div className={`smart-prompt-box ${missingRequired.length > 0 ? "error" : missingRecommended.length > 0 ? "info" : "success"}`}>
            <div className="smart-prompt-header">
              <strong>{
                aiMappingLoading
                  ? "AI is analyzing your columns..."
                  : missingRequired.length > 0
                    ? "Help us understand your file"
                    : missingRecommended.length > 0
                      ? "Almost there — verify your columns"
                      : "All columns detected — please verify"
              }</strong>
              <p>{
                aiMappingLoading
                  ? "Hang tight — AI is choosing the best columns for readable, useful analysis."
                  : missingRequired.length > 0
                    ? "We couldn't detect some required columns. Pick the right ones from your file."
                    : "We auto-detected your columns. Verify they're correct, then continue."
              }</p>
              {aiMappingLoading && <div className="agent-loading-bar" style={{ marginTop: 8 }} />}
            </div>
            <div className="smart-prompt-fields">
              {ALL_MAPPABLE_ROLES.map((role) => {
                const isMapped = Boolean(mapping[role]);
                const isRequired = REQUIRED_ROLES.includes(role);
                return (
                  <label key={role} className={`smart-prompt-field ${isRequired && !isMapped ? "required" : ""} ${isMapped ? "mapped" : ""}`}>
                    <span>
                      {ROLE_LABELS[role]}
                      {isRequired && <em className="required-star"> *</em>}
                      {isMapped && <em className="mapped-check"> ✓</em>}
                    </span>
                    <select value={mapping[role]} onChange={(e) => updateMapping(role, e.target.value)}>
                      <option value="">{isRequired ? "-- Select column --" : "-- Skip --"}</option>
                      {dataSet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                    <span className="smart-prompt-examples">{ROLE_HINTS[role]}</span>
                  </label>
                );
              })}
            </div>
            {(() => {
              const mainMetric = mapping.revenue || mapping.quantity || mapping.cost || "";
              const primaryCols = new Set([mainMetric, mapping.date, mapping.product, mapping.customer, mapping.region].filter(Boolean));
              const extraNumerics = dataSet.profiles.filter((p) => p.type === "number" && !primaryCols.has(p.name) && !identifierColumns.includes(p.name));
              const extraDimensions = dataSet.profiles.filter((p) => p.type === "text" && !primaryCols.has(p.name) && !identifierColumns.includes(p.name));
              const idCols = dataSet.profiles.filter((p) => identifierColumns.includes(p.name) && !primaryCols.has(p.name));
              if (extraNumerics.length === 0 && extraDimensions.length === 0 && idCols.length === 0) return null;
              return (
                <div className="smart-prompt-extras">
                  <strong>Additional columns to analyze</strong>
                  <p className="muted">Select columns you want included in charts, dashboard, and AI analysis.</p>
                  {extraNumerics.length > 0 && (
                    <>
                      <p className="muted" style={{ marginTop: 8, marginBottom: 2, fontWeight: 600 }}>Numeric measures</p>
                      <div className="smart-prompt-checkboxes">
                        {extraNumerics.map((col) => (
                          <label key={col.name} className="smart-prompt-checkbox">
                            <input type="checkbox" checked={additionalMetrics.includes(col.name)} onChange={(e) => {
                              if (e.target.checked) setAdditionalMetrics((prev) => [...prev, col.name]);
                              else setAdditionalMetrics((prev) => prev.filter((c) => c !== col.name));
                            }} />
                            <span>{col.name}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                  {extraDimensions.length > 0 && (
                    <>
                      <p className="muted" style={{ marginTop: 8, marginBottom: 2, fontWeight: 600 }}>Categorical dimensions</p>
                      <div className="smart-prompt-checkboxes">
                        {extraDimensions.map((col) => (
                          <label key={col.name} className="smart-prompt-checkbox">
                            <input type="checkbox" checked={additionalDimensions.includes(col.name)} onChange={(e) => {
                              if (e.target.checked) setAdditionalDimensions((prev) => [...prev, col.name]);
                              else setAdditionalDimensions((prev) => prev.filter((c) => c !== col.name));
                            }} />
                            <span>{col.name}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                  {idCols.length > 0 && (
                    <>
                      <p className="muted" style={{ marginTop: 8, marginBottom: 2, fontWeight: 600 }}>Identifiers (excluded from analysis)</p>
                      <div className="smart-prompt-checkboxes">
                        {idCols.map((col) => (
                          <label key={col.name} className="smart-prompt-checkbox" style={{ opacity: 0.5 }}>
                            <input type="checkbox" disabled checked={false} />
                            <span>{col.name} <em style={{ opacity: 0.6 }}>(ID)</em></span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
            <div className="smart-prompt-actions">
              {missingRequired.length === 0 && (
                <button className="agent-run-button" onClick={() => { setMappingConfirmed(true); setActiveTab("dashboard"); }}>
                  Confirm &amp; View Dashboard
                </button>
              )}
              <button className="secondary-button" onClick={() => setMappingConfirmed(true)}>
                {missingRequired.length > 0 ? "Skip for now" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === "upload" && (
        <>
          <section className="workflow">
            <div className="panel">
              <span className="step-pill">1. Upload</span>
              <h2>Start with this month&apos;s file</h2>
              <p>The app reads CSV, XLSX, or XLS files, guesses the business columns, and keeps the math transparent.</p>
              <label className="file-drop">
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => { handleFileChange(e); }}
                />
                <strong>{dataSet?.fileName ?? "Choose spreadsheet"}</strong>
                <span>CSV, XLSX, or XLS</span>
              </label>
              {isGoogleSheetsConfigured() && (
                <div className="google-import-row">
                  <button className="google-sheets-button" onClick={handleGoogleSheetsImport} disabled={googleImporting}>
                    {googleImporting ? "Connecting…" : "Import from Google Sheets"}
                  </button>
                  <span className="google-import-note">We only read the one sheet you pick.</span>
                </div>
              )}
              <div className="sample-data-buttons">
                <button className="secondary-button" onClick={() => loadSampleData("sales")}>Sales sample</button>
                <button className="secondary-button" onClick={() => loadSampleData("expenses")}>Expense sample</button>
                <button className="secondary-button" onClick={() => loadSampleData("marketing")}>Marketing sample</button>
              </div>
              {error && <p className="error-text">{error}</p>}
            </div>

            <div className="panel">
              <span className="step-pill">2. Confirm</span>
              <h2>Column mapping</h2>
              {!dataSet ? (
                <p className="muted">Upload a file to see column guesses.</p>
              ) : (
                <>
                  {allDataNotices.length > 0 && (
                    <div className="data-notices">
                      {allDataNotices.map((note, i) => (
                        <p key={i} className="data-notice">⚠ {note}</p>
                      ))}
                    </div>
                  )}
                  {revenueGatePrompt}
                  <RoleMappingGroup title="Required" roles={REQUIRED_ROLES} headers={dataSet.headers} mapping={mapping} onChange={updateMapping} />
                  <RoleMappingGroup title="Recommended" roles={RECOMMENDED_ROLES} headers={dataSet.headers} mapping={mapping} onChange={updateMapping} />
                  <RoleMappingGroup title="Optional" roles={OPTIONAL_ROLES} headers={dataSet.headers} mapping={mapping} onChange={updateMapping} />
                </>
              )}
            </div>
          </section>

          {/* Instant Preview Strip — appears the moment a file is parsed */}
          {dataSet && (() => {
            const numericProfiles = dataSet.profiles.filter((p) => p.type === "number" && p.sum > 0);
            const biggestCol = numericProfiles.length > 0 ? numericProfiles.reduce((a, b) => a.sum > b.sum ? a : b) : null;
            const sparkValues: number[] = [];
            if (biggestCol) {
              for (let i = 0; i < Math.min(dataSet.rows.length, 40); i++) {
                const v = parseFloat(dataSet.rows[i]?.[biggestCol.name] ?? "");
                if (!isNaN(v)) sparkValues.push(v);
              }
            }
            const sparkMin = sparkValues.length > 0 ? Math.min(...sparkValues) : 0;
            const sparkMax = sparkValues.length > 0 ? Math.max(...sparkValues) : 1;
            const sparkRange = Math.max(sparkMax - sparkMin, 1);
            const sparkW = 280;
            const sparkH = 40;
            const sparkPath = sparkValues.length > 1
              ? sparkValues.map((v, i) => {
                  const x = (i / (sparkValues.length - 1)) * sparkW;
                  const y = sparkH - ((v - sparkMin) / sparkRange) * (sparkH - 4) - 2;
                  return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                }).join(" ")
              : "";
            return (
              <section className="instant-preview-strip">
                <div className="preview-kpis">
                  <div className="preview-kpi">
                    <strong>{dataSet.rows.length.toLocaleString()}</strong>
                    <span>Total rows</span>
                  </div>
                  {biggestCol && (
                    <div className="preview-kpi highlight">
                      <strong>{formatCompact(biggestCol.sum)}</strong>
                      <span>{biggestCol.name} (sum)</span>
                    </div>
                  )}
                  {biggestCol && (
                    <div className="preview-kpi">
                      <strong>{formatCompact(biggestCol.mean)}</strong>
                      <span>Per row avg</span>
                    </div>
                  )}
                  <div className="preview-kpi">
                    <strong>{dataSet.headers.length}</strong>
                    <span>Columns</span>
                  </div>
                </div>
                {sparkPath && (
                  <div className="preview-spark">
                    <svg viewBox={`0 0 ${sparkW} ${sparkH}`} preserveAspectRatio="none">
                      <path d={sparkPath} fill="none" stroke="var(--brand-color, #6366f1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d={`${sparkPath} L${sparkW},${sparkH} L0,${sparkH} Z`} fill="var(--brand-color, #6366f1)" opacity="0.08" />
                    </svg>
                    <span className="spark-label">{biggestCol?.name} trend</span>
                  </div>
                )}
              </section>
            );
          })()}

          {/* Data Health sentence — plain-English summary below preview strip */}
          {dataSet && (() => {
            const q = dataSet.quality;
            const totalIssues = q.blankRows + q.duplicateRows + q.possibleSummaryRows;
            const completeness = dataSet.rows.length > 0 ? ((dataSet.rows.length - q.blankRows) / dataSet.rows.length * 100) : 100;
            const ts = trustScore;
            if (totalIssues === 0) {
              return (
                <div className="data-health-sentence good">
                  <span className="health-icon">&#10003;</span>
                  Your data looks clean — {completeness.toFixed(1)}% complete, no duplicates{ts ? `, trust score ${ts.score}%` : ""}
                </div>
              );
            }
            const issues: string[] = [];
            if (q.blankRows > 0) issues.push(`${q.blankRows} blank row${q.blankRows > 1 ? "s" : ""}`);
            if (q.duplicateRows > 0) issues.push(`${q.duplicateRows} duplicate${q.duplicateRows > 1 ? "s" : ""}`);
            if (q.possibleSummaryRows > 0) issues.push(`${q.possibleSummaryRows} summary row${q.possibleSummaryRows > 1 ? "s" : ""}`);
            return (
              <div className="data-health-sentence warn">
                <span className="health-icon">&#9888;</span>
                Found {issues.join(" and ")} — clean with one click below{ts ? ` (trust score: ${ts.score}%)` : ""}
              </div>
            );
          })()}

          {dataSet && canAnalyze && (
            <div className="next-step-bar">
              <p>File loaded and mapped successfully.</p>
              <button className="agent-run-button" onClick={() => setActiveTab("dashboard")}>View Dashboard</button>
              <button className="secondary-button" onClick={() => setActiveTab("explore")}>Explore Data</button>
            </div>
          )}

          {/* Saved workflows — under Advanced */}
          {savedWorkflows.length > 0 && (
            <details className="advanced-section">
            <summary>Advanced — Saved Mappings ({savedWorkflows.length})</summary>
            <section className="saved-workflows">
              <div className="workflow-list">
                {savedWorkflows.map((w) => {
                  const matchCount = dataSet ? w.headers.filter((h) => dataSet.headers.includes(h)).length : 0;
                  const matchPercent = dataSet ? Math.round((matchCount / Math.max(w.headers.length, 1)) * 100) : 0;
                  return (
                    <article key={w.name} className="workflow-card">
                      <div>
                        <strong>{w.name}</strong>
                        <span className="muted">{w.headers.length} columns — saved {new Date(w.savedAt).toLocaleDateString()}</span>
                        {dataSet && <span className={`workflow-match ${matchPercent >= 70 ? "good" : matchPercent >= 40 ? "partial" : "low"}`}>{matchPercent}% match</span>}
                      </div>
                      <div className="workflow-actions">
                        {dataSet && matchPercent > 0 && <button className="fix-btn" onClick={() => applyWorkflow(w)}>Apply</button>}
                        <button className="cleaning-btn reset" onClick={() => deleteWorkflow(w.name)}>Delete</button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
            </details>
          )}

          {/* Recent files */}
          {recentFiles.length > 0 && !dataSet && (
            <section className="recent-files">
              <h3>Recent Files</h3>
              <div className="recent-list">
                {recentFiles.slice(0, 5).map((f) => (
                  <article key={f.fileName} className="recent-card">
                    <strong>{f.fileName}</strong>
                    <span className="muted">{f.rows} rows — {new Date(f.openedAt).toLocaleDateString()}</span>
                  </article>
                ))}
              </div>
            </section>
          )}

          {/* Inline data quality */}
          {dataSet && (flaggedRows.blank.length > 0 || flaggedRows.duplicate.length > 0 || flaggedRows.summary.length > 0) && (
            <section className="data-quality-inline">
              <h3>Data Quality</h3>
              <div className="quality-grid">
                <QualityMetric label="Total rows" value={dataSet.quality.totalRows} />
                <QualityMetric label="Blank" value={flaggedRows.blank.length} />
                <QualityMetric label="Duplicates" value={flaggedRows.duplicate.length} />
                <QualityMetric label="Summary rows" value={flaggedRows.summary.length} />
              </div>
              <div className="cleaning-buttons">
                {flaggedRows.blank.length > 0 && (
                  <button type="button" className={flaggedRows.blank.every((i) => excludedRows.has(i)) ? "cleaning-btn active" : "cleaning-btn"} onClick={() => { setExcludedRows((prev) => { const next = new Set(prev); const allExcluded = flaggedRows.blank.every((i) => next.has(i)); for (const i of flaggedRows.blank) allExcluded ? next.delete(i) : next.add(i); return next; }); }}>
                    {flaggedRows.blank.every((i) => excludedRows.has(i)) ? "✓ " : ""}Blank ({flaggedRows.blank.length})
                  </button>
                )}
                {flaggedRows.duplicate.length > 0 && (
                  <button type="button" className={flaggedRows.duplicate.every((i) => excludedRows.has(i)) ? "cleaning-btn active" : "cleaning-btn"} onClick={() => { setExcludedRows((prev) => { const next = new Set(prev); const allExcluded = flaggedRows.duplicate.every((i) => next.has(i)); for (const i of flaggedRows.duplicate) allExcluded ? next.delete(i) : next.add(i); return next; }); }}>
                    {flaggedRows.duplicate.every((i) => excludedRows.has(i)) ? "✓ " : ""}Duplicates ({flaggedRows.duplicate.length})
                  </button>
                )}
                {flaggedRows.summary.length > 0 && (
                  <button type="button" className={flaggedRows.summary.every((i) => excludedRows.has(i)) ? "cleaning-btn active" : "cleaning-btn"} onClick={() => { setExcludedRows((prev) => { const next = new Set(prev); const allExcluded = flaggedRows.summary.every((i) => next.has(i)); for (const i of flaggedRows.summary) allExcluded ? next.delete(i) : next.add(i); return next; }); }}>
                    {flaggedRows.summary.every((i) => excludedRows.has(i)) ? "✓ " : ""}Totals ({flaggedRows.summary.length})
                  </button>
                )}
                {excludedRows.size > 0 && (
                  <button type="button" className="cleaning-btn reset" onClick={() => setExcludedRows(new Set())}>Undo all</button>
                )}
              </div>
              {trustScore && (
                <div className={`trust-score-mini ${trustScore.label === "High" ? "high" : trustScore.label === "Medium" ? "medium" : "low"}`}>
                  Trust: <strong>{trustScore.score}%</strong> ({trustScore.label}) — {trustScore.detail}
                </div>
              )}
              {analysis && reconciliationNote(analysis, mapping, reportSettings) && (
                <p className="reconciliation-note">{reconciliationNote(analysis, mapping, reportSettings)}</p>
              )}
              {excludedRows.size > 0 && (
                <div className="export-links-subtle">
                  <button type="button" className="link-btn" onClick={exportCleanedCsv}>Export cleaned CSV</button>
                  <button type="button" className="link-btn" onClick={exportSkippedRows}>Export skipped rows</button>
                </div>
              )}
            </section>
          )}

        </>
      )}



      {activeTab === "dashboard" && dataSet && revenueBlocked && (
        <section className="dashboard">
          <div className="report-empty-state">
            <h2>Analysis paused — confirm the revenue column</h2>
            {revenueGatePrompt}
          </div>
        </section>
      )}

      {activeTab === "dashboard" && dataSet && analysis && canAnalyze && (
        <section className={`dashboard${onePagerMode ? " one-pager" : ""}`} id="report" style={{ "--brand-color": reportSettings.brandColor } as React.CSSProperties}>
          {/* Collapsible Report Settings */}
          <details className="collapsible-panel no-print">
            <summary>Report Settings</summary>
            <div className="settings-grid">
              <label>
                <span>Report title</span>
                <input value={reportSettings.title} onChange={(event) => setReportSettings((current) => ({ ...current, title: event.target.value }))} />
              </label>
              <label>
                <span>Company / client</span>
                <input value={reportSettings.company} placeholder="Optional" onChange={(event) => setReportSettings((current) => ({ ...current, company: event.target.value }))} />
              </label>
              <label>
                <span>Template</span>
                <select value={reportSettings.template} onChange={(event) => {
                  const tmpl = event.target.value as ReportTemplate;
                  setReportSettings((current) => ({
                    ...current,
                    template: tmpl,
                    title: isDefaultTitle(current.title) ? TEMPLATE_TITLES[tmpl] : current.title,
                  }));
                }}>
                  {(Object.entries(TEMPLATE_LABELS) as [ReportTemplate, string][]).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Currency</span>
                <select value={reportSettings.currency} onChange={(event) => setReportSettings((current) => ({ ...current, currency: event.target.value }))}>
                  {CURRENCY_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="brand-color-label">
                <span>Brand color</span>
                <div className="color-picker-wrap">
                  <input type="color" value={reportSettings.brandColor} onChange={(event) => setReportSettings((current) => ({ ...current, brandColor: event.target.value }))} />
                  <span className="color-hex">{reportSettings.brandColor}</span>
                </div>
              </label>
            </div>
          </details>

          <div className="report-cover-bar no-print">
            <span className="report-cover-title">{reportSettings.title || "Data Analysis Report"}</span>
            {reportSettings.company && <span className="report-cover-sep">|</span>}
            {reportSettings.company && <span>{reportSettings.company}</span>}
            {analysis.periodRevenue.length >= 2 && (
              <span className="report-cover-range">{analysis.periodRevenue[0].label} – {analysis.periodRevenue[analysis.periodRevenue.length - 1].label}</span>
            )}
            <span className="report-cover-sep">|</span>
            <span className="muted">{dataSet.fileName}</span>
          </div>
          <div className="report-cover print-only">
            <div>
              <h2>{reportSettings.title || "Data Analysis Report"}</h2>
              <p>
                {reportSettings.company && (<>Prepared for <strong>{reportSettings.company}</strong>. </>)}
                Generated from <strong>{dataSet.fileName}</strong> on {formatDateTime(generatedAt)}.
              </p>
              {analysis.periodRevenue.length >= 2 && (
                <p className="report-date-range">
                  Period covered: <strong>{analysis.periodRevenue[0].label}</strong> to <strong>{analysis.periodRevenue[analysis.periodRevenue.length - 1].label}</strong>
                </p>
              )}
            </div>
            <div className="report-stamp">
              <span>Report Type</span>
              <strong>{TEMPLATE_LABELS[reportSettings.template]}</strong>
            </div>
          </div>

          <div className="report-meta print-only">
            <div className="report-meta-item">
              <span>Source File</span>
              <strong>{dataSet.fileName}</strong>
            </div>
            <div className="report-meta-item">
              <span>Generated</span>
              <strong>{formatDateTime(generatedAt)}</strong>
            </div>
            <div className="report-meta-item">
              <span>Rows Analyzed</span>
              <strong>{analysis.rowCount.toLocaleString()} of {dataSet.rows.length.toLocaleString()}</strong>
            </div>
            <div className="report-meta-item">
              <span>Currency</span>
              <strong>{reportSettings.currency}</strong>
            </div>
            {trustScore && (
              <div className="report-meta-item">
                <span>Data Trust</span>
                <strong>{trustScore.score}% ({trustScore.label})</strong>
              </div>
            )}
          </div>

          {/* Dashboard Controls */}
          <div className="print-controls no-print">
            <div className="print-controls-header">
              <div className="dashboard-mode-toggle">
                <button className={`mode-btn ${dashboardMode === "concise" ? "active" : ""}`} onClick={() => setDashboardMode("concise")}>Concise</button>
                <button className={`mode-btn ${dashboardMode === "full" ? "active" : ""}`} onClick={() => setDashboardMode("full")}>Full Report</button>
              </div>
              <button className={`copy-summary-btn ${copiedSummary ? "copied" : ""}`} onClick={() => {
                const metric = analysis.primaryMetric;
                const cur = reportSettings.currency;
                const changeLine = findings?.latestPeriodPartial
                  ? ` (${partialPeriodNote(findings)})`
                  : analysis.latestPeriodChange !== null ? ` (${analysis.latestPeriodChange >= 0 ? "+" : ""}${(analysis.latestPeriodChange * 100).toFixed(1)}% vs last period)` : "";
                const identifiedRev = identifiedProductRevenue(analysis);
                const topProducts = analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET).slice(0, 3).map((p, i) => `${i + 1}. ${p.label} — ${metric === "Count" ? p.revenue.toLocaleString() : formatMoney(p.revenue, cur)} (${identifiedRev > 0 ? ((p.revenue / identifiedRev) * 100).toFixed(0) : 0}%)`).join("\n");
                const topRegions = realItems(analysis.regionRevenue).slice(0, 3).map((r, i) => `${i + 1}. ${r.label} — ${metric === "Count" ? r.revenue.toLocaleString() : formatMoney(r.revenue, cur)}`).join("\n");
                const risks = smartInsights.filter((ins) => ins.sentiment === "negative").slice(0, 2).map((ins) => `- ${ins.text}`).join("\n");
                const positives = smartInsights.filter((ins) => ins.sentiment === "positive").slice(0, 2).map((ins) => `+ ${ins.text}`).join("\n");
                const block = [
                  `${reportSettings.title || "Data Report"} — ${new Date().toLocaleDateString()}`,
                  `Total ${metric}: ${metric === "Count" ? analysis.totalRevenue.toLocaleString() : formatMoney(analysis.totalRevenue, cur)}${changeLine}`,
                  `Rows: ${analysis.rowCount.toLocaleString()} | Avg: ${metric === "Count" ? "1" : formatMoney(analysis.averageRevenue, cur)}`,
                  "",
                  topProducts ? `Top Products:\n${topProducts}` : "",
                  topRegions ? `\nTop Regions:\n${topRegions}` : "",
                  positives ? `\n${positives}` : "",
                  risks ? `\n${risks}` : "",
                  "",
                  "Generated by Sheet Analysis AI",
                ].filter(Boolean).join("\n");
                navigator.clipboard.writeText(block).then(() => {
                  setCopiedSummary(true);
                  setTimeout(() => setCopiedSummary(false), 2000);
                }).catch(() => {});
              }}>{copiedSummary ? "Copied!" : "Copy Summary"}</button>
              <button className="agent-run-button" onClick={() => window.print()}>Print Report</button>
              <button className="share-image-btn" onClick={generateShareImage}>Share Image</button>
              <label className="onepager-toggle"><input type="checkbox" checked={onePagerMode} onChange={() => setOnePagerMode((p) => !p)} /> One-pager</label>
            </div>
            <details className="print-toggles-detail">
              <summary>Print sections</summary>
              <div className="print-controls-toggles">
                {([
                  ["summary", "Executive Summary"],
                  ["kpis", "Key Metrics"],
                  ["charts", "Charts"],
                  ["outliers", "Outliers"],
                  ["details", "Column Notes"],
                  ...(customCharts.length > 0 ? [["customCharts", "Custom Charts"] as const] : []),
                  ["aiReport", "AI Report"],
                ] as const).map(([key, label]) => (
                  <label key={key} className="print-toggle">
                    <input
                      type="checkbox"
                      checked={printSections[key]}
                      onChange={() => setPrintSections((p) => ({ ...p, [key]: !p[key] }))}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </details>
          </div>

          {/* One-pager sheet — the ONLY thing that prints when one-pager mode is on (ISSUE 2).
              Hidden on screen and in normal (multi-page) print; mirrors the Share Image content. */}
          <div className="onepager-sheet">
            <div className="onepager-head">
              <h2>{reportSettings.title || "Data Analysis Report"}</h2>
              <p className="onepager-date">{dataSet.fileName} — {new Date().toLocaleDateString()}</p>
            </div>
            <div className="onepager-kpis">
              {(() => {
                const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
                const isMoneyMetric = analysis.isMoney;
                const fmtKpi = (v: number) => analysis.primaryMetric === "Count" ? v.toLocaleString() : isMoneyMetric ? formatMoney(v, reportSettings.currency) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
                return (<>
                  <div className="onepager-kpi"><strong>{fmtKpi(analysis.totalRevenue)}</strong><span>Total {analysis.primaryMetric.toLowerCase()}</span></div>
                  <div className="onepager-kpi"><strong>{analysis.rowCount.toLocaleString()}</strong><span>Rows analyzed</span></div>
                  <div className="onepager-kpi"><strong>{analysis.primaryMetric === "Count" ? "1" : fmtKpi(analysis.averageRevenue)}</strong><span>Avg per transaction</span></div>
                </>);
              })()}
            </div>
            <div className="onepager-chart">
              <h3>{analysis.primaryMetric} by {getDimensionLabel("product", mapping, reportSettings.template).toLowerCase()}</h3>
              <HorizontalBarChart items={guardBars(analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET)).slice(0, 6)} currency={reportSettings.currency} />
            </div>
            {smartInsights.length > 0 && (
              <ul className="onepager-insights">
                {smartInsights.slice(0, 3).map((ins, i) => (
                  <li key={i} className={ins.sentiment ?? ""}>{ins.text}</li>
                ))}
              </ul>
            )}
            <div className="onepager-foot">Generated by Sheet Analysis AI{trustScore ? ` — Trust Score: ${trustScore.score}%` : ""}</div>
          </div>

          <article className={`summary-card${!printSections.summary ? " hide-print" : ""}`}>
            <h3>Executive summary{aiSummary.loading && <span className="method-badge">Refining with AI…</span>}{!aiSummary.loading && aiSummary.text && <span className="method-badge">AI</span>}</h3>
            {(aiSummary.text ?? createExecutiveSummary(analysis, reportSettings, mapping, findings)).split("\n\n").map((para, i) => <p key={i}>{para}</p>)}
          </article>

          {dashboardMode === "full" && (
            <div className={`recommendation-strip${!printSections.summary ? " hide-print" : ""}`}>
              {(aiRecommendations.items ?? getRecommendedActions(analysis, reportSettings, findings)).map((action) => (
                <article key={action.title}>
                  <span>{action.label}</span>
                  <strong>{action.title}</strong>
                  <p>{action.detail}{("impact" in action && action.impact) ? ` Impact: ${action.impact}` : ""}</p>
                </article>
              ))}
            </div>
          )}

          {/* FIX 3 — Disclose row loss by DEFAULT (concise view), not buried in the Full-only
              column-notes card. Every total/trend above is computed on analyzed rows only; if a
              material share was dropped, say so up front and escalate to a warning past 10%. */}
          {(() => {
            const used = analysis.rowCount;
            const totalRows = dataSet.rows.length;
            const dropped = totalRows - used;
            if (dropped <= 0) return null;
            const dropPct = totalRows > 0 ? dropped / totalRows : 0;
            const warn = dropPct >= 0.1;
            const what = mapping.date && mapping.revenue
              ? "date or revenue value"
              : mapping.date ? "date" : "value";
            return (
              <div className={`row-loss-disclosure${warn ? " warn" : ""}`} role={warn ? "alert" : undefined}>
                <span className="row-loss-icon">{warn ? "⚠" : "ℹ"}</span>
                <span>
                  <strong>{used.toLocaleString()}</strong> of <strong>{totalRows.toLocaleString()}</strong> rows analyzed
                  {" "}({(dropPct * 100).toFixed(1)}% dropped — their mapped {what} couldn&apos;t be read).
                  {warn ? " Every total and trend below reflects only the analyzed rows." : ""}
                </span>
              </div>
            );
          })()}

          {/* FIX 4 — the reconciliation gate's verdict, surfaced ADVISORY (never blocks render).
              PASS shows nothing; a BLOCK/REVIEW lists the failing checks so an integrity problem
              in a number the dashboard renders is visible rather than silent. */}
          {auditResult && auditResult.verdict !== "PASS" && (
            <div className="audit-advisory" role="alert">
              <span className="audit-advisory-icon">⚠</span>
              <div>
                <strong>Integrity check: {auditResult.verdict}</strong> — {auditResult.violations.length}{" "}
                {auditResult.violations.length === 1 ? "issue" : "issues"} the reconciliation gate flagged in
                the figures below.
                <ul className="audit-advisory-list">
                  {auditResult.violations.slice(0, 4).map((x, i) => (
                    <li key={i}>
                      <code>{x.check}</code> {x.message}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className={`kpi-grid${!printSections.kpis ? " hide-print" : ""}`}>
            {(() => {
              const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
              const isMoneyMetric = analysis.isMoney;
              const fmtKpi = (v: number) => analysis.primaryMetric === "Count" ? v.toLocaleString() : isMoneyMetric ? formatMoney(v, reportSettings.currency) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
              const valueRole = valueCol ? `${valueCol} (${analysis.primaryMetric.toLowerCase()})` : analysis.primaryMetric.toLowerCase();
              const filters = canonicalFilterNote(mapping);
              return (<>
                <Kpi label={`Total ${analysis.primaryMetric.toLowerCase()}`} value={fmtKpi(analysis.totalRevenue)} note={{ source: valueRole, aggregation: "sum over analyzed rows", filters, n: analysis.rowCount }} />
                <Kpi label="Rows analyzed" value={analysis.rowCount.toLocaleString()} note={{ source: "all mapped columns", aggregation: "count of analyzed rows", filters, n: analysis.rowCount }} />
                <Kpi label="Avg per transaction" value={analysis.primaryMetric === "Count" ? "1" : fmtKpi(analysis.averageRevenue)} note={{ source: valueRole, aggregation: "mean per analyzed row", filters, n: analysis.rowCount }} />
              </>);
            })()}
            {(() => {
              const flatTrend = findings ? findings.trend.label === "normal variation" : isTrendFlat(analysis);
              // A truncated final period's change is not comparable — show it as incomplete,
              // never as a colored up/down move.
              const partial = !!findings?.latestPeriodPartial;
              const cov = findings?.periodCompleteness.lastEvidence?.coverage ?? 0;
              return (
                <Kpi
                  label={partial ? "Latest period (incomplete)" : flatTrend ? "Latest period (normal variation)" : "Latest period change"}
                  value={analysis.latestPeriodChange === null ? "Not enough data" : partial ? `~${Math.round(cov * 100)}% of a period` : formatPercent(analysis.latestPeriodChange)}
                  tone={analysis.latestPeriodChange === null || flatTrend || partial ? "neutral" : trendTone(analysis.latestPeriodChange, reportSettings.template)}
                  note={mapping.date ? { source: `${mapping.date} (date) + ${analysis.primaryMetric.toLowerCase()}`, aggregation: "last full period vs prior, as a fraction", filters: `${canonicalFilterNote(mapping)}; partial endpoints excluded`, n: findings ? findings.periodSeries.length : 0 } : undefined}
                />
              );
            })()}
            {analysis.totalProfit !== null && (
              <Kpi
                label="Total profit"
                value={formatMoney(analysis.totalProfit, reportSettings.currency)}
                tone={analysis.totalProfit >= 0 ? "positive" : "negative"}
              />
            )}
            {analysis.totalProfit !== null && analysis.totalRevenue > 0 && (
              <Kpi
                label="Profit margin"
                value={`${((analysis.totalProfit / analysis.totalRevenue) * 100).toFixed(1)}%`}
                tone={analysis.totalProfit / analysis.totalRevenue >= 0.1 ? "positive" : analysis.totalProfit / analysis.totalRevenue >= 0 ? "neutral" : "negative"}
              />
            )}
          </div>

          {/* Additional Metrics KPIs */}
          {additionalMetrics.length > 0 && dataSet && (
            <div className={`kpi-grid${!printSections.kpis ? " hide-print" : ""}`}>
              {additionalMetrics.filter((col) => !identifierColumns.includes(col)).map((col) => {
                const vals = filteredRows.map((r) => parseFloat(r[col])).filter((v) => !isNaN(v));
                if (vals.length === 0) return null;
                const total = vals.reduce((s, v) => s + v, 0);
                const avg = vals.length > 0 ? total / vals.length : 0;
                const forceAvg = isRateColumn(col);
                const agg = forceAvg ? "average" : analysisMode;
                const isMoney = /revenue|sales|amount|price|cost|profit|income|earning|spend|fee|tax|shipping/i.test(col) && !columnIsUnitsMetric(col, mapping, dataSet.profiles);
                const fmtVal = (v: number) => isMoney ? formatMoney(v, reportSettings.currency) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
                const displayVal = agg === "count" ? vals.length.toLocaleString() : agg === "average" ? fmtVal(avg) : fmtVal(total);
                const label = `${agg === "count" ? "Count" : agg === "average" ? "Avg" : "Total"} ${cleanColumnName(col)}`;
                return <Kpi key={col} label={label} value={displayVal} />;
              })}
            </div>
          )}

          {/* What-If Scenario Cards */}
          {dashboardMode === "full" && analysis.totalRevenue > 0 && (() => {
            const total = analysis.totalRevenue;
            const cur = reportSettings.currency;
            const custLabel = getDimensionLabel("customer", mapping, reportSettings.template);
            const topCust = realItems(analysis.customerRevenue)[0];
            const avg = analysis.periodRevenue.length > 0 ? total / analysis.periodRevenue.length : 0;
            const best = analysis.bestPeriod;
            const worst = analysis.periodRevenue.length > 1 ? [...analysis.periodRevenue].sort((a, b) => a.revenue - b.revenue)[0] : null;

            const scenarios: { title: string; result: number; change: number; detail: string; color: string }[] = [];
            if (topCust) {
              const pct = -Math.round((topCust.revenue / total) * 100);
              scenarios.push({ title: `Lose ${topCust.label}`, result: total - topCust.revenue, change: pct, detail: `${topCust.label} accounts for ${Math.abs(pct)}% of total — losing this ${custLabel.toLowerCase()} would be significant`, color: "red" });
            }
            if (best && avg > 0) {
              const pct = Math.round(((best.revenue - avg) / total) * 100);
              if (pct > 0) scenarios.push({ title: "Best period repeats", result: total * (1 + pct / 100), change: pct, detail: `${best.label} was your peak at ${formatMoney(best.revenue, cur)}`, color: "green" });
            }
            if (worst && avg > 0) {
              const pct = Math.round(((worst.revenue - avg) / total) * 100);
              if (pct < 0) scenarios.push({ title: "Worst period repeats", result: total * (1 + pct / 100), change: pct, detail: `${worst.label} was your lowest at ${formatMoney(worst.revenue, cur)}`, color: "orange" });
            }

            return (
              <div className="whatif-panel no-print">
                <h4>What if...</h4>
                <div className="whatif-grid">
                  {scenarios.map((s) => (
                    <div key={s.title} className={`scenario-card scenario-${s.color}`} onClick={() => setWhatIfPct(Math.max(-50, Math.min(50, s.change)))}>
                      <div className="scenario-title">{s.title}</div>
                      <div className="scenario-result">{formatMoney(s.result, cur)} <span className={s.change > 0 ? "positive" : "negative"}>({s.change > 0 ? "+" : ""}{s.change}%)</span></div>
                      <div className="scenario-detail">{s.detail}</div>
                    </div>
                  ))}
                  <div className={`scenario-card scenario-custom ${whatIfPct !== 0 ? (whatIfPct > 0 ? "scenario-green" : "scenario-red") : ""}`}>
                    <div className="scenario-title">Custom scenario</div>
                    <input type="range" min={-50} max={50} step={5} value={whatIfPct} onChange={(e) => setWhatIfPct(Number(e.target.value))} className="whatif-slider" />
                    <div className="scenario-result">{formatMoney(total * (1 + whatIfPct / 100), cur)} <span className={whatIfPct > 0 ? "positive" : whatIfPct < 0 ? "negative" : ""}>({whatIfPct > 0 ? "+" : ""}{whatIfPct}%)</span></div>
                    {whatIfPct !== 0 && <button className="whatif-reset" onClick={(e) => { e.stopPropagation(); setWhatIfPct(0); }}>Reset</button>}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Smart Insights Strip */}
          {smartInsights.length > 0 && (
            <div className={`smart-insights-strip${!printSections.kpis ? " hide-print" : ""}`}>
              {smartInsights.slice(0, 6).map((insight, i) => (
                <span key={i} className={`smart-insight-chip ${insight.importance}${insight.sentiment ? ` ${insight.sentiment}` : ""}`}>
                  {insight.text}
                </span>
              ))}
            </div>
          )}

          {/* Forecast */}
          {forecastResult && (
            <ChartCard title={`${analysis.primaryMetric} Forecast — Next ${forecastResult.predictions.length} Periods`}>
              <ForecastChart historical={analysis.periodRevenue} forecast={forecastResult} currency={reportSettings.currency} trendLabel={findings?.trend.label} isMoney={analysis.isMoney} />
            </ChartCard>
          )}

          {/* Customer Health */}
          {customerHealth.length > 0 && dashboardMode === "full" && (() => {
            const segments: Record<RFMSegment, CustomerHealth[]> = { Champion: [], Loyal: [], Potential: [], "At Risk": [], Slipping: [], Lost: [], New: [] };
            for (const c of customerHealth) segments[c.segment].push(c);
            const segmentColors: Record<RFMSegment, string> = { Champion: "#059669", Loyal: "#2563eb", Potential: "#7c3aed", "At Risk": "#d97706", Slipping: "#ea580c", Lost: "#dc2626", New: "#0891b2" };
            const segmentLabels: Record<RFMSegment, string> = { Champion: "Best customers", Loyal: "Regulars", Potential: "Promising", "At Risk": "Needs attention", Slipping: "Slipping away", Lost: "Gone quiet", New: "New" };
            const atRiskRevenue = segments["At Risk"].reduce((s, c) => s + c.monetary, 0) + segments["Slipping"].reduce((s, c) => s + c.monetary, 0);
            const expandedList = expandedRfmSegment ? [...segments[expandedRfmSegment]].sort((a, b) => b.totalRevenue - a.totalRevenue) : [];
            const cur = reportSettings.currency;
            const expandSegmentCustomerList = (segment: RFMSegment) => {
              setExpandedRfmSegment(expandedRfmSegment === segment ? null : segment);
            };
            const copyCustomerList = () => {
              if (!expandedRfmSegment) return;
              const totalSegmentRevenue = expandedList.reduce((s, c) => s + c.totalRevenue, 0);
              const heading = expandedRfmSegment === "At Risk" || expandedRfmSegment === "Slipping"
                ? `Customers needing attention (${expandedList.length}):`
                : `${segmentLabels[expandedRfmSegment]} customers (${expandedList.length}):`;
              const lines = expandedList.map((c, i) =>
                `${i + 1}. ${c.name} — last purchase ${formatLastPurchase(c.recency).replace(" ⚠️", "")} — ${formatMoney(c.totalRevenue, cur)} total`
              );
              const totalLabel = expandedRfmSegment === "At Risk" || expandedRfmSegment === "Slipping"
                ? "Total at-risk revenue"
                : "Total segment revenue";
              navigator.clipboard.writeText(`${heading}\n${lines.join("\n")}\n\n${totalLabel}: ${formatMoney(totalSegmentRevenue, cur)}`).catch(() => {});
            };
            return (
              <section className="rfm-section">
                <h3>{TEMPLATE_CONFIG[reportSettings.template].rfmLabel} <span className="method-badge" title="Based on RFM analysis — scores by how recently and frequently they transact, and how much they contribute">i RFM method</span></h3>
                <p className="section-subtitle">Which {getDimensionLabel("customer", mapping, reportSettings.template).toLowerCase()}s need attention?</p>
                <div className="rfm-overview">
                  {(Object.entries(segments) as [RFMSegment, CustomerHealth[]][]).filter(([, list]) => list.length > 0).map(([seg, list]) => (
                    <button key={seg} className={`rfm-badge rfm-badge-clickable ${expandedRfmSegment === seg ? "rfm-badge-active" : ""}`} style={{ borderColor: segmentColors[seg] }} onClick={() => expandSegmentCustomerList(seg)}>
                      <strong style={{ color: segmentColors[seg] }}>{list.length}</strong>
                      <span>{segmentLabels[seg]}</span>
                      <span className="rfm-rev">{formatCompact(list.reduce((s, c) => s + c.monetary, 0))}</span>
                    </button>
                  ))}
                </div>
                {atRiskRevenue > 0 && (
                  <p className="rfm-warning">{segments["At Risk"].length + segments["Slipping"].length} customers worth {formatMoney(atRiskRevenue, cur)} haven't bought recently — reach out before they leave</p>
                )}
                {expandedRfmSegment && expandedList.length > 0 && (
                  <div className="rfm-detail-panel" style={{ borderColor: segmentColors[expandedRfmSegment] }}>
                    <div className="rfm-detail-header">
                      <strong style={{ color: segmentColors[expandedRfmSegment] }}>{segmentLabels[expandedRfmSegment]} — {expandedList.length} customer{expandedList.length !== 1 ? "s" : ""} worth {formatMoney(expandedList.reduce((s, c) => s + c.monetary, 0), cur)}</strong>
                    </div>
                    <table className="rfm-detail-table customer-table">
                      <thead>
                        <tr><th>Customer Name</th><th>Last Purchase</th><th>Orders</th><th>Total Spent</th></tr>
                      </thead>
                      <tbody>
                        {expandedList.map((c) => (
                          <tr key={c.name}>
                            <td><strong>{c.name}</strong></td>
                            <td>{formatLastPurchase(c.recency)}</td>
                            <td>{c.transactionCount}</td>
                            <td>{formatMoney(c.totalRevenue, cur)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="rfm-detail-footer">
                      <button className="link-btn" onClick={copyCustomerList}>Copy customer list</button>
                      {false && (
                      <button className="link-btn" onClick={() => {
                        const lines = expandedList.map((c, i) => `${i + 1}. ${c.name} — last purchase ${c.recency === 9999 ? "unknown" : c.recency === 0 ? "today" : `${c.recency} days ago`} — ${formatMoney(c.monetary, cur)} total`);
                        const text = `${segmentLabels[expandedRfmSegment!]} (${expandedList.length}):\n${lines.join("\n")}\n\nTotal ${analysis!.primaryMetric.toLowerCase()}: ${formatMoney(expandedList.reduce((s, c) => s + c.monetary, 0), cur)}\nGenerated by Sheet Analysis AI`;
                        navigator.clipboard.writeText(text).catch(() => {});
                      }}>Copy customer list</button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })()}

          {/* Product Tiers */}
          {abcClassification.length > 0 && dashboardMode === "full" && (() => {
            const tierLabels: Record<string, string> = { A: "Core earners", B: "Growth potential", C: "Low performers" };
            const tierAdvice: Record<string, string> = { A: "Protect these — they drive your business", B: "Invest here for growth", C: "Consider dropping or repricing" };
            const tierColors: Record<string, string> = { A: "#059669", B: "#2563eb", C: "#94a3b8" };
            const cur = reportSettings.currency;
            const expandedProducts = expandedAbcTier ? abcClassification.filter((x) => x.tier === expandedAbcTier).sort((a, b) => b.revenue - a.revenue) : [];
            const expandTierProductList = (tier: "A" | "B" | "C") => {
              setExpandedAbcTier(expandedAbcTier === tier ? null : tier);
            };
            const copyProductList = () => {
              if (!expandedAbcTier) return;
              const tierRevenue = expandedProducts.reduce((s, p) => s + p.revenue, 0);
              const lines = expandedProducts.map((p, i) =>
                `${i + 1}. ${p.label} — ${formatMoney(p.revenue, cur)} — ${(p.pct * 100).toFixed(1)}% of ${analysis.primaryMetric.toLowerCase()}`
              );
              navigator.clipboard.writeText(`${tierLabels[expandedAbcTier]} (${expandedProducts.length} ${getDimensionLabel("product", mapping, reportSettings.template).toLowerCase()}s):\n${lines.join("\n")}\n\nTotal tier ${analysis.primaryMetric.toLowerCase()}: ${formatMoney(tierRevenue, cur)}`).catch(() => {});
            };
            return (
            <section className="abc-section">
              <h3>{TEMPLATE_CONFIG[reportSettings.template].abcLabel} <span className="method-badge" title="Based on ABC/Pareto analysis — the same 80/20 rule used by supply chain managers to prioritize resources">i Pareto method</span></h3>
              <p className="section-subtitle">Where does the {analysis.primaryMetric.toLowerCase()} actually come from?</p>
              {reconciliationNote(analysis, mapping, reportSettings) && (
                <p className="excluded-note">{reconciliationNote(analysis, mapping, reportSettings)}</p>
              )}
              <div className="abc-summary">
                {(["A", "B", "C"] as const).map((tier) => {
                  const items = abcClassification.filter((x) => x.tier === tier);
                  if (items.length === 0) return null;
                  const pctTotal = (items.reduce((s, x) => s + x.pct, 0) * 100).toFixed(0);
                  return (
                    <button key={tier} className={`abc-tag ${tier.toLowerCase()} ${expandedAbcTier === tier ? "abc-tag-active" : ""}`} onClick={() => expandTierProductList(tier)}>
                      {tierLabels[tier]}: {items.length} items = {pctTotal}% of {analysis.primaryMetric.toLowerCase()}
                    </button>
                  );
                })}
              </div>
              <div className="abc-visual">
                {abcClassification.slice(0, 12).map((item) => (
                  <div key={item.label} className={`abc-block ${item.tier.toLowerCase()}`} style={{ flex: Math.max(item.pct * 10, 0.5) }}>
                    <span className="abc-block-label">{item.label}</span>
                    <span className="abc-block-pct">{(item.pct * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
              {expandedAbcTier && expandedProducts.length > 0 && (
                <div className="abc-detail-panel" style={{ borderColor: tierColors[expandedAbcTier] }}>
                  <div className="abc-detail-header">
                    <strong style={{ color: tierColors[expandedAbcTier] }}>{tierLabels[expandedAbcTier]} — {tierAdvice[expandedAbcTier]}</strong>
                  </div>
                  <table className="rfm-detail-table">
                    <thead>
                      <tr><th>{getDimensionLabel("product", mapping, reportSettings.template)}</th><th>{analysis.primaryMetric}</th><th>Share</th><th>Cumulative</th></tr>
                    </thead>
                    <tbody>
                      {expandedProducts.map((p) => (
                        <tr key={p.label}>
                          <td><strong>{p.label}</strong></td>
                          <td>{formatMoney(p.revenue, cur)}</td>
                          <td>{(p.pct * 100).toFixed(1)}%</td>
                          <td>{(p.cumPct * 100).toFixed(0)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="rfm-detail-footer">
                    <button className="link-btn" onClick={copyProductList}>Copy product list</button>
                    {false && (
                    <button className="link-btn" onClick={() => {
                      const lines = expandedProducts.map((p, i) => `${i + 1}. ${p.label} — ${formatMoney(p.revenue, cur)} (${(p.pct * 100).toFixed(1)}%)`);
                      const text = `${tierLabels[expandedAbcTier!]} (${expandedProducts.length} products):\n${lines.join("\n")}\n\nGenerated by Sheet Analysis AI`;
                      navigator.clipboard.writeText(text).catch(() => {});
                    }}>Copy product list</button>
                    )}
                  </div>
                </div>
              )}
            </section>
            );
          })()}

          <div className={`dashboard-grid${!printSections.charts ? " hide-print" : ""}`}>
            {dashboardSmartCharts.map((sc) => {
              const rawData = resolveSmartChartData(sc, analysis);
              if (!rawData || rawData.length === 0) return null;
              const invalidEntry = rawData.find((d) => d.label === INVALID_BUCKET);
              const chartData = rawData.filter((d) => d.label !== INVALID_BUCKET);
              if (chartData.length === 0) return null;
              const isLine = sc.chartType === "line";
              const isConcentration = sc.chartType === "pareto";
              const isDonut = sc.chartType === "donut";
              const chartInsight = aiChartInsights[getSmartChartKey(sc)] ?? generateAutoInsight(sc, chartData, reportSettings.currency);
              return (
                <ChartCard key={sc.title} title={sc.title}>
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 6px", fontStyle: "italic" }}>{sc.question}</p>
                  {isLine ? (
                    // A line chart over the date axis IS the metric's time trend, so its slope
                    // annotation must read the same verdict as the canonical trend chart — never
                    // a locally-computed direction that could contradict it.
                    <LineChart data={chartData} currency={reportSettings.currency} trendLabel={sc.xRole === "date" ? findings?.trend.label : undefined} isMoney={sc.isMoney !== false && analysis.isMoney} />
                  ) : isConcentration ? (
                    <ConcentrationChart items={chartData} currency={reportSettings.currency} />
                  ) : isDonut ? (
                    <DonutChart items={chartData} currency={reportSettings.currency} isMoney={sc.isMoney !== false && analysis.isMoney} />
                  ) : (
                    <HorizontalBarChart items={chartData} currency={reportSettings.currency} isMoney={sc.isMoney !== false && analysis.isMoney} isAverage={sc.isAverage === true} />
                  )}
                  {chartInsight && (
                    <div className="chart-insights">
                      <div className="insight-line">
                        <span className="insight-dot medium" />
                        <span>{chartInsight}</span>
                      </div>
                    </div>
                  )}
                  {invalidEntry && (
                    <p style={{ fontSize: "11px", color: "#94a3b8", fontStyle: "italic", margin: "4px 0 0" }}>
                      Note: {(sc.isMoney === false || !analysis.isMoney) ? `${Math.abs(invalidEntry.revenue).toLocaleString(undefined, { maximumFractionDigits: 0 })} units` : formatMoney(Math.abs(invalidEntry.revenue), reportSettings.currency)} from {sc.xRole === "product" ? "unidentified items" : "rows with missing/invalid values"} excluded
                    </p>
                  )}
                  <p style={{ fontSize: "11px", color: "#94a3b8", fontStyle: "italic", margin: "4px 0 0" }}>
                    {(() => {
                      const dimCol = sc.xRole === "product" ? mapping.product : sc.xRole === "region" ? mapping.region : sc.xRole === "customer" ? mapping.customer : "";
                      const total = countAnalyzedRows(filteredRows, mapping);
                      const used = countAnalyzedRows(filteredRows, mapping, dimCol || undefined);
                      const base = used < total
                        ? `Based on ${used.toLocaleString()} of ${total.toLocaleString()} transactions`
                        : `Based on ${total.toLocaleString()} transactions`;
                      return base + (!isLine && chartData.length > 8 ? ` · Showing top 8 of ${chartData.length}` : "");
                    })()}
                  </p>
                </ChartCard>
              );
            })}
            {/* Fallback: show original charts if no smart charts were generated */}
            {smartCharts.length === 0 && (
              <>
                {analysis.periodRevenue.length > 0 && (
                  <ChartCard title={`${analysis.primaryMetric} trend`}>
                    <LineChart data={analysis.periodRevenue} currency={reportSettings.currency} trendLabel={findings?.trend.label} isMoney={analysis.isMoney} />
                    {findings && <div className="chart-verdict">Verdict: {findings.trend.label}.</div>}
                  </ChartCard>
                )}
                {analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET).length > 0 && (
                  <ChartCard title={`${analysis.primaryMetric} by ${getDimensionLabel("product", mapping, reportSettings.template).toLowerCase()}`}><HorizontalBarChart items={guardBars(analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET))} currency={reportSettings.currency} /></ChartCard>
                )}
                {dashboardMode === "full" && analysis.regionRevenue.filter((p) => p.label !== INVALID_BUCKET).length > 0 && (
                  <ChartCard title={`${analysis.primaryMetric} by ${getDimensionLabel("region", mapping, reportSettings.template).toLowerCase()}`}><HorizontalBarChart items={guardBars(analysis.regionRevenue.filter((p) => p.label !== INVALID_BUCKET))} currency={reportSettings.currency} colorByPerformance /></ChartCard>
                )}
                {dashboardMode === "full" && analysis.customerRevenue.filter((p) => p.label !== INVALID_BUCKET).length > 0 && (
                  <ChartCard title={`Top ${getDimensionLabel("customer", mapping, reportSettings.template).toLowerCase()}s`}><HorizontalBarChart items={guardBars(analysis.customerRevenue.filter((p) => p.label !== INVALID_BUCKET))} currency={reportSettings.currency} /></ChartCard>
                )}
                {dashboardMode === "full" && analysis.marginByProduct.length > 0 && (
                  <ChartCard title={`Margin by ${getDimensionLabel("product", mapping, reportSettings.template).toLowerCase()}`}><HorizontalBarChart items={analysis.marginByProduct} currency={reportSettings.currency} pctOverride={Object.fromEntries(analysis.marginByProduct.map((m) => {
                    const rev = analysis.productRevenue.find((p) => p.label === m.label)?.revenue ?? 0;
                    return [m.label, rev > 0 ? Math.round((m.revenue / rev) * 100) : 0];
                  }))} /></ChartCard>
                )}
                {dashboardMode === "full" && analysis.roiByProduct.length > 0 && (
                  <ChartCard title={`ROI by ${getDimensionLabel("product", mapping, reportSettings.template).toLowerCase()}`}><HorizontalBarChart items={analysis.roiByProduct.map((r) => ({ label: r.label, revenue: Math.round(r.revenue * 10) / 10 }))} currency="%" /></ChartCard>
                )}
                {dashboardMode === "full" && analysis.customerRevenue.length >= 3 && (
                  <ChartCard title={TEMPLATE_CONFIG[reportSettings.template].concentrationLabel}>
                    <ConcentrationChart items={analysis.customerRevenue} currency={reportSettings.currency} />
                  </ChartCard>
                )}
              </>
            )}
          </div>

          {(dashboardMode === "full" || enrichedOutliers.length <= 3) && enrichedOutliers.length > 0 && (
            <section className={`outlier-section${!printSections.outliers ? " hide-print" : ""}`}>
              <h3>Unusual patterns</h3>
              <div className="outlier-grid">
                {enrichedOutliers.slice(0, dashboardMode === "concise" ? 2 : undefined).map((outlier, i) => (
                  <article key={i} className={`outlier-card ${outlier.type}`}>
                    <div className="outlier-icon">{outlier.type === "high" ? "▲" : "▼"}</div>
                    <div>
                      <strong>{outlier.label}</strong>
                      <p>{outlier.context}</p>
                      {outlier.rootCause && <p className="outlier-root-cause">{outlier.rootCause}</p>}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {dashboardMode === "full" && (
          <div className={`report-details-grid${!printSections.details ? " hide-print" : ""}`}>
            <article className="detail-card">
              <h3>Data quality notes
                <span className="column-info-tooltip" title={getMappedRoles(mapping).map((item) => `${ROLE_LABELS[item.role]}: ${item.column}`).join("\n")}>
                  &#9432;
                </span>
              </h3>
              <ul className="report-notes">
                {getDataQualityNotes(dataSet, analysis).map((note) => (<li key={note}>{note}</li>))}
              </ul>
              <dl className="mapping-list print-only">
                {getMappedRoles(mapping).map((item) => (<div key={item.role}><dt>{ROLE_LABELS[item.role]}</dt><dd>{item.column}</dd></div>))}
              </dl>
            </article>
          </div>
          )}

          {/* Custom charts rendered for print if toggled on */}
          {printSections.customCharts && customCharts.length > 0 && (
            <section className="cb2">
              <div className="section-title">
                <span className="step-pill">Custom Charts</span>
                <h2>Your custom charts</h2>
              </div>
              {customCharts.map((cc) => {
                const chartData = computeCustomChartData(canonicalChartRows, cc.xCol, cc.yCol, cc.agg, cc.groupCol, cc.topN);
                const chartTitle = cc.title || buildCustomChartTitle(cc.xCol, cc.yCol, cc.agg, cc.groupCol);
                return (
                  <div key={cc.id} className="custom-chart-wrapper">
                    <AIChart chart={{ type: cc.type as ChartCommand["type"], title: chartTitle, data: chartData }} colorTheme={cc.colorTheme} brandColor={reportSettings.brandColor} />
                  </div>
                );
              })}
            </section>
          )}

          {/* AI Report sections for print */}
          {printSections.aiReport && aiReport.sections.length > 0 && (
            <section className="ai-report-print-section">
              <div className="section-title">
                <span className="step-pill">AI Analysis</span>
                <h2>AI-Generated Report</h2>
              </div>
              {aiReport.sections.map((section, i) => (
                <article key={i} className="ai-report-card">
                  <h3>{section.title}</h3>
                  <div className="ai-report-text">{section.text.split("\n").filter(Boolean).map((line, j) => <p key={j}>{line}</p>)}</div>
                  {section.chart && <AIChart chart={section.chart} brandColor={reportSettings.brandColor} />}
                </article>
              ))}
            </section>
          )}

          <footer className="report-footer">
            <div>
              <span>{reportSettings.company || "Sheet Analysis AI"} — Generated on {formatDateTime(generatedAt)}</span>
            </div>
            <span>Powered by Sheet Analysis AI</span>
          </footer>
        </section>
      )}

      {activeTab === "explore" && dataSet && (
        <div style={{ "--brand-color": reportSettings.brandColor } as React.CSSProperties}>
          {/* Explore sub-tabs */}
          <nav className="explore-nav">
            <button className={`explore-nav-btn ${exploreTab === "talk" ? "active" : ""}`} onClick={() => setExploreTab("talk")}>Talk to Data</button>
            <button className={`explore-nav-btn ${exploreTab === "charts" ? "active" : ""}`} onClick={() => setExploreTab("charts")}>Chart Builder</button>
            <button className={`explore-nav-btn ${exploreTab === "data" || exploreTab === "stats" ? "active" : ""}`} onClick={() => setExploreTab("data")}>Data &amp; Stats</button>
            <button className={`explore-nav-btn ${exploreTab === "compare" ? "active" : ""}`} onClick={() => setExploreTab("compare")}>Compare Files</button>
          </nav>

          {/* Talk to Data */}
          {exploreTab === "talk" && analysis && (
            <section className="ai-chat-section ai-chat-hero">
              <div className="section-title">
                <span className="step-pill">Ask Your Data</span>
                <h2>Chat with your data — get charts, insights &amp; answers</h2>
                <p className="muted">Ask anything about your data. AI generates code that runs on your data locally — your data never leaves the browser.</p>
              </div>
              <form className="chat-form chat-form-hero" onSubmit={(event) => { event.preventDefault(); askQuestion(); }}>
                <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="e.g. Compare all products, show revenue trend, which region is best..." />
                <button type="submit" disabled={aiLoading}>{aiLoading ? "Thinking..." : "Ask"}</button>
              </form>
              <div className="chat-suggestions">
                <span className="chat-suggestions-label">Try asking:</span>
                {getSmartSuggestions(mapping, analysis).map((s) => (
                  <button key={s.label} onClick={() => askQuestion(s.prompt)} disabled={aiLoading}>{s.label}</button>
                ))}
              </div>
              <div className="chat-log chat-log-tall">
                {chatMessages.length === 0 ? (
                  <div className="chat-empty-state">
                    <p>Your conversation will appear here. Ask a question above or pick a suggestion.</p>
                    <p className="muted">AI creates charts, tables, and insights. Follow-up questions keep context.</p>
                  </div>
                ) : (
                  [...chatMessages].reverse().map((message) => (
                    <div key={message.id} className={`chat-row ${message.role}`}>
                      <strong>{message.role === "user" ? "You" : "Data Analyst"}</strong>
                      <p style={{ whiteSpace: "pre-line" }}>{message.text}</p>
                      {message.chart && <AIChart chart={message.chart} brandColor={reportSettings.brandColor} />}
                    </div>
                  ))
                )}
              </div>
              {(() => {
                const dynamicPrompts = generateDynamicPrompts(mapping, analysis, reportSettings.template);
                const activeCategories = [...new Set(dynamicPrompts.map((p) => p.category))];
                return (
                  <details className="prompt-templates-detail">
                    <summary>Browse prompt templates ({dynamicPrompts.length} available)</summary>
                    <div className="prompt-categories">
                      <button className={`prompt-cat-btn ${promptCategory === "all" ? "active" : ""}`} onClick={() => setPromptCategory("all")}>All</button>
                      {activeCategories.map((key) => (
                        <button key={key} className={`prompt-cat-btn ${promptCategory === key ? "active" : ""}`} onClick={() => setPromptCategory(key)}>{PROMPT_CATEGORY_LABELS[key]}</button>
                      ))}
                    </div>
                    <div className="quick-actions">
                      {dynamicPrompts.filter((t) => promptCategory === "all" || t.category === promptCategory).map((t) => (
                        <button key={t.label} onClick={() => askQuestion(t.prompt)} disabled={aiLoading}>{t.label}</button>
                      ))}
                    </div>
                  </details>
                );
              })()}
            </section>
          )}

          {/* Chart Builder — 2-panel redesign */}
          {exploreTab === "charts" && (() => {
            const cbTypes = [
              { type: "bar", label: "Bar", icon: (<svg viewBox="0 0 24 24"><rect x="2" y="14" width="4" height="8" rx="1" fill="currentColor" opacity=".5"/><rect x="8" y="6" width="4" height="16" rx="1" fill="currentColor" opacity=".7"/><rect x="14" y="2" width="4" height="20" rx="1" fill="currentColor"/><rect x="20" y="10" width="2" height="12" rx="1" fill="currentColor" opacity=".4"/></svg>) },
              { type: "horizontal_bar", label: "H-Bar", icon: (<svg viewBox="0 0 24 24"><rect x="2" y="3" width="18" height="4" rx="1" fill="currentColor"/><rect x="2" y="9" width="14" height="4" rx="1" fill="currentColor" opacity=".7"/><rect x="2" y="15" width="8" height="4" rx="1" fill="currentColor" opacity=".4"/></svg>) },
              { type: "combo", label: "Combo", icon: (<svg viewBox="0 0 24 24"><rect x="3" y="12" width="4" height="10" rx="1" fill="currentColor" opacity=".4"/><rect x="10" y="8" width="4" height="14" rx="1" fill="currentColor" opacity=".4"/><rect x="17" y="5" width="4" height="17" rx="1" fill="currentColor" opacity=".4"/><polyline points="5,10 12,4 19,7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>) },
              { type: "line", label: "Line", icon: (<svg viewBox="0 0 24 24"><polyline points="2,18 8,8 14,13 22,3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>) },
              { type: "area", label: "Area", icon: (<svg viewBox="0 0 24 24"><path d="M2,18 L8,8 L14,13 L22,3 L22,22 L2,22 Z" fill="currentColor" opacity=".2"/><polyline points="2,18 8,8 14,13 22,3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>) },
              { type: "donut", label: "Donut", icon: (<svg viewBox="0 0 24 24"><path d="M12 2 A10 10 0 0 1 22 12 L18 12 A6 6 0 0 0 12 6 Z" fill="currentColor"/><path d="M22 12 A10 10 0 0 1 6 20 L8 17 A6 6 0 0 0 18 12 Z" fill="currentColor" opacity=".6"/><path d="M6 20 A10 10 0 0 1 12 2 L12 6 A6 6 0 0 0 8 17 Z" fill="currentColor" opacity=".3"/></svg>) },
              { type: "scatter", label: "Dots", icon: (<svg viewBox="0 0 24 24"><circle cx="5" cy="16" r="2" fill="currentColor" opacity=".5"/><circle cx="10" cy="9" r="2" fill="currentColor" opacity=".7"/><circle cx="15" cy="14" r="2" fill="currentColor" opacity=".5"/><circle cx="19" cy="5" r="2" fill="currentColor"/></svg>) },
              { type: "table", label: "Table", icon: (<svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="5" rx="1" fill="currentColor" opacity=".7"/><rect x="2" y="9" width="9" height="4" rx="1" fill="currentColor" opacity=".2"/><rect x="13" y="9" width="9" height="4" rx="1" fill="currentColor" opacity=".2"/><rect x="2" y="15" width="9" height="4" rx="1" fill="currentColor" opacity=".1"/><rect x="13" y="15" width="9" height="4" rx="1" fill="currentColor" opacity=".1"/></svg>) },
            ] as { type: string; label: string; icon: React.ReactNode }[];
            const makeTitle = (x: string, y: string, agg: string, group: string) => buildCustomChartTitle(x, y, agg, group);
            const previewType = (chartBuilder.xCol ? (hoveredChartType || chartBuilder.type) : "bar") as ChartCommand["type"];
            const xIsDateAxis = chartBuilder.xCol ? isDateColumn(canonicalChartRows, chartBuilder.xCol) : false;
            const previewData = chartBuilder.xCol ? computeCustomChartData(canonicalChartRows, chartBuilder.xCol, chartBuilder.yCol, chartBuilder.agg, chartBuilder.groupCol, chartBuilder.topN) : [];
            const previewTitle = chartBuilder.title || (chartBuilder.xCol ? makeTitle(chartBuilder.xCol, chartBuilder.yCol, chartBuilder.agg, chartBuilder.groupCol) : "");

            // Auto-insight for current chart — adapts to data type
            const chartInsightText = (() => {
              if (!previewData.length) return "";
              const sorted = [...previewData].sort((a, b) => b.value - a.value);
              const total = sorted.reduce((s, d) => s + d.value, 0);
              const top = sorted[0];
              if (!top) return "";
              const topPct = total > 0 ? ((top.value / total) * 100).toFixed(0) : "0";
              const yProfile = chartBuilder.yCol ? dataSet.profiles.find((p) => p.name === chartBuilder.yCol) : null;
              const isRevenue = yProfile?.guess === "revenue" || yProfile?.guess === "cost" || yProfile?.guess === "profit";
              const isCount = chartBuilder.yCol === "__count__";
              const fmtVal = (v: number) => isRevenue ? formatMoney(v, reportSettings.currency) : formatCompact(v);

              if (previewType === "line" || previewType === "area") {
                const first = previewData[0]?.value ?? 0;
                const last = previewData[previewData.length - 1]?.value ?? 0;
                const change = first > 0 ? (((last - first) / first) * 100).toFixed(1) : "0";
                return `Trend: ${Number(change) >= 0 ? "+" : ""}${change}% from first to last. Peak: ${top.label} (${fmtVal(top.value)})`;
              }
              if (isCount) {
                return sorted.length >= 2
                  ? `${top.label} is most common with ${top.value} entries (${topPct}% of total)`
                  : `${top.label}: ${top.value} entries`;
              }
              if (sorted.length >= 2) {
                const mult = top.value / (sorted[1]?.value || top.value || 1);
                if (mult < 1.05) {
                  return `${top.label} and ${sorted[1].label} are nearly tied (~${topPct}% each)`;
                }
                const tail = mult >= 1.1 ? ` — ${mult.toFixed(1)}x more than #2` : "";
                return isRevenue
                  ? `${top.label} leads with ${fmtVal(top.value)} (${topPct}% of total)${tail}`
                  : `${top.label} has the highest ${chartBuilder.yCol || "value"} at ${fmtVal(top.value)} (${topPct}% of total)${tail}`;
              }
              return `${top.label}: ${fmtVal(top.value)}`;
            })();

            type ChartSuggestion = { title: string; chartType: string; x: string; y: string; aggregation: string; reason: string; previewData: Array<{ label: string; value: number }> };
            const aiSugs: ChartSuggestion[] = (aiChartSuggestions || []).map((sg) => {
              const previewData = computeChartPreview(sg.x, sg.y, sg.aggregation, dataSet.rows, 5);
              return { title: sg.title, chartType: sg.type, x: sg.x, y: sg.y, aggregation: sg.aggregation, reason: sg.reason, previewData };
            });
            const fallbackSugs: ChartSuggestion[] = aiSugs.length === 0 && !aiChartSuggestionsLoading
              ? getChartBuilderSuggestions(dataSet.profiles, analysis!, mapping, reportSettings.currency).slice(0, 5).map((sc) => {
                  const data =
                    sc.chartType === "line" ? analysis!.periodRevenue.slice(0, 6).map((d) => ({ label: d.label, value: d.revenue }))
                    : sc.xRole === "product" && sc.yRole === "profit" ? analysis!.marginByProduct.slice(0, 5).map((d) => ({ label: d.label, value: d.revenue }))
                    : sc.xRole === "product" ? realItems(analysis!.productRevenue).slice(0, 5).map((d) => ({ label: d.label, value: d.revenue }))
                    : sc.xRole === "region" ? realItems(analysis!.regionRevenue).slice(0, 5).map((d) => ({ label: d.label, value: d.revenue }))
                    : sc.xRole === "customer" ? realItems(analysis!.customerRevenue).slice(0, 5).map((d) => ({ label: d.label, value: d.revenue }))
                    : realItems(analysis!.productRevenue).slice(0, 5).map((d) => ({ label: d.label, value: d.revenue }));
                  return { title: sc.title, chartType: sc.chartType, x: mapping[sc.xRole] || "", y: mapping[sc.yRole] || mapping.revenue || "", aggregation: "sum", reason: sc.question, previewData: data };
                })
              : [];
            const suggestions: ChartSuggestion[] = aiSugs.length > 0 ? aiSugs : fallbackSugs;

            return (
          <section className="cb2">
            {aiSettings.apiKey && (
              <div className="cb2-natural-language">
                <input
                  value={chartPrompt}
                  onChange={(e) => { setChartPrompt(e.target.value); setChartPromptStatus((prev) => ({ ...prev, error: null })); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createChartFromPrompt();
                    }
                  }}
                  placeholder="Describe the chart you want... e.g. 'revenue by product as a bar chart'"
                  disabled={chartPromptStatus.loading}
                />
                <button type="button" onClick={() => void createChartFromPrompt()} disabled={chartPromptStatus.loading || !chartPrompt.trim()}>
                  {chartPromptStatus.loading ? "Creating..." : "Create"}
                </button>
              </div>
            )}
            {aiSettings.apiKey && chartPromptStatus.error && <p className="cb2-nl-error">{chartPromptStatus.error}</p>}
            <div className="cb2-studio">
              {/* LEFT — Large preview area */}
              <div className="cb2-canvas">
                {/* Suggested charts row (shown when nothing is configured) */}
                {!chartBuilder.xCol && aiChartSuggestionsLoading && (
                  <div className="cb2-suggestions">
                    <p className="cb2-panel-label">AI is analyzing your data for chart suggestions...</p>
                    <div className="agent-loading-bar" />
                  </div>
                )}
                {!chartBuilder.xCol && !aiChartSuggestionsLoading && suggestions.length > 0 && (
                  <div className="cb2-suggestions">
                    <p className="cb2-panel-label">{aiChartSuggestions && aiChartSuggestions.length > 0 ? "AI-recommended charts — click to build" : "Suggested for your data — click one to start"}</p>
                    <div className="cb2-suggestion-row">
                      {suggestions.map((sg, idx) => (
                        <button key={idx} className="cb2-suggestion-card" onClick={() => {
                          const xCol = sg.x || "";
                          const yCol = sg.y || "";
                          const chartType = sg.chartType === "line" ? "line" : sg.chartType === "donut" ? "donut" : sg.chartType === "scatter" ? "scatter" : "bar";
                          const agg = sg.aggregation || "sum";
                          if (xCol) {
                            const config = { xCol, yCol: yCol || "__count__", type: chartType, agg, groupCol: "", topN: agg === "none" ? 0 : 10 };
                            setChartBuilder((p) => ({ ...p, ...config }));
                            setChartBuilderOrigin(config);
                          }
                        }}>
                          <div className="cb2-suggestion-mini">
                            {sg.previewData.slice(0, 4).map((d, j) => (
                              <div key={j} className="cb2-mini-bar" style={{ height: `${Math.max((d.value / (sg.previewData[0]?.value || 1)) * 100, 10)}%` }} />
                            ))}
                          </div>
                          <span className="cb2-suggestion-title">{sg.title}</span>
                          <span className="cb2-suggestion-q">{sg.reason}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Placeholder when no suggestions */}
                {!chartBuilder.xCol && suggestions.length === 0 && (
                  <div className="cb2-placeholder">
                    <svg viewBox="0 0 80 80" width="80" height="80"><rect x="10" y="44" width="12" height="24" rx="3" fill="#e2e8f0"/><rect x="26" y="30" width="12" height="38" rx="3" fill="#cbd5e1"/><rect x="42" y="18" width="12" height="50" rx="3" fill="#e2e8f0"/><rect x="58" y="36" width="12" height="32" rx="3" fill="#cbd5e1"/></svg>
                    <p>Pick what to measure on the right</p>
                    <span>Chart appears instantly as you select</span>
                  </div>
                )}

                {/* Chart Doctor — warnings */}
                {chartBuilder.xCol && (() => {
                  const warnings: { text: string; suggestion?: string; suggestedType?: string }[] = [];
                  const uniqueLabels = new Set(previewData.map((d) => d.label)).size;
                  if ((chartBuilder.type === "donut") && uniqueLabels > 6) {
                    warnings.push({ text: `Pie/donut charts work best with 2-6 slices. You have ${uniqueLabels}.`, suggestion: "Try a bar chart", suggestedType: "bar" });
                  }
                  if (chartBuilder.type === "line" && chartBuilder.xCol) {
                    const xProfile = dataSet.profiles.find((p) => p.name === chartBuilder.xCol);
                    if (xProfile && xProfile.type !== "date") {
                      warnings.push({ text: "Line charts imply a time sequence. Your X-axis isn't a date column.", suggestion: "Switch to bar", suggestedType: "bar" });
                    }
                  }
                  if (chartBuilder.type === "scatter" && previewData.length < 5) {
                    warnings.push({ text: "Scatter plots need more data points to show meaningful patterns." });
                  }
                  if (uniqueLabels > 20 && chartBuilder.type === "bar") {
                    warnings.push({ text: `${uniqueLabels} bars makes the chart hard to read.`, suggestion: "Enable Top 10", suggestedType: undefined });
                  } else if (uniqueLabels > 15 && chartBuilder.type !== "table" && chartBuilder.type !== "pivot") {
                    warnings.push({ text: `${uniqueLabels} categories is a lot for one chart. Consider limiting with "Show top" or switching to table.` });
                  }
                  if (chartBuilder.agg === "sum" && chartBuilder.yCol) {
                    const yColManual = !chartBuilderOrigin || chartBuilder.yCol !== chartBuilderOrigin.yCol;
                    if (yColManual && /percent|pct|%|rate|ratio|margin|growth|discount|conversion/i.test(chartBuilder.yCol)) {
                      warnings.push({ text: "This looks like a percentage/rate column — summing it may not make sense.", suggestion: "Use Average", suggestedType: undefined });
                    }
                  }
                  if ((chartBuilder.type === "pie") && uniqueLabels > 6) {
                    warnings.push({ text: `Pie charts with ${uniqueLabels} slices are hard to read.`, suggestion: "Try a bar chart", suggestedType: "bar" });
                  }
                  if (warnings.length === 0) return null;
                  return (
                    <div className="chart-doctor">
                      {warnings.map((w, i) => (
                        <div key={i} className="chart-doctor-warning">
                          <span>{w.text}</span>
                          {w.suggestedType && (
                            <button onClick={() => setChartBuilder((p) => ({ ...p, type: w.suggestedType! }))}>{w.suggestion}</button>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Live chart preview */}
                {chartBuilder.xCol && (
                  <>
                    <AIChart chart={{ type: previewType, title: previewTitle, data: previewData }} colorTheme={chartBuilder.colorTheme} brandColor={reportSettings.brandColor} />
                    {chartInsightText && (
                      <p className="cb2-auto-insight">{chartInsightText}</p>
                    )}
                    <div className="cb2-canvas-actions">
                      <button className="cb2-save-btn" onClick={() => { const id = Date.now().toString(36); setCustomCharts((prev) => [...prev, { id, ...chartBuilder }]); }}>
                        Save chart
                      </button>
                      <input className="cb2-title-inline" placeholder="Name your chart..." value={chartBuilder.title} onChange={(e) => setChartBuilder((p) => ({ ...p, title: e.target.value }))} />
                    </div>
                  </>
                )}
              </div>

              {/* RIGHT — Guided setup */}
              <div className="cb2-config">
                {/* Step 1: What to measure */}
                <label className="cb2-field">
                  <span>1. What to measure</span>
                  <select value={chartBuilder.yCol} onChange={(e) => setChartBuilder((p) => ({ ...p, yCol: e.target.value }))}>
                    <option value="" disabled>Pick a number...</option>
                    <option value="__count__">Just count rows</option>
                    {dataSet.headers.filter((h) => { const pr = dataSet.profiles.find((p) => p.name === h); return pr?.type === "number"; }).map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </label>

                {/* Step 2: Group by */}
                <label className="cb2-field">
                  <span>2. Group by {chartBuilder.xCol && <button className="cb2-field-clear" onClick={(e) => { e.preventDefault(); setChartBuilder((p) => ({ ...p, xCol: "", groupCol: "" })); }}>×</button>}</span>
                  <select value={chartBuilder.xCol} onChange={(e) => {
                    const col = e.target.value;
                    const profile = dataSet.profiles.find((p) => p.name === col);
                    const isDate = profile?.type === "date" || profile?.guess === "date";
                    const isNum = profile?.type === "number";
                    let suggested = chartBuilder.type;
                    if (isDate) suggested = "line";
                    else if (isNum && chartBuilder.yCol && chartBuilder.yCol !== "__count__") suggested = "scatter";
                    else if (!isNum) { suggested = (profile?.unique ?? 0) <= 6 ? "donut" : "bar"; }
                    if (col && (!chartBuilder.yCol || chartBuilder.yCol === "__count__")) {
                      const firstNum = dataSet.profiles.find((p) => p.type === "number" && p.name !== col);
                      setChartBuilder((p) => ({ ...p, xCol: col, type: suggested, yCol: firstNum ? firstNum.name : "__count__" }));
                    } else {
                      setChartBuilder((p) => ({ ...p, xCol: col, type: suggested }));
                    }
                  }}>
                    <option value="">Pick a category...</option>
                    {dataSet.headers.map((h) => {
                      const pr = dataSet.profiles.find((p) => p.name === h);
                      const badge = pr?.type === "date" ? " (date)" : pr?.type === "text" ? ` (${pr.unique} items)` : "";
                      return <option key={h} value={h}>{h}{badge}</option>;
                    })}
                  </select>
                </label>

                {/* Step 3+: Only show after steps 1-2 are filled */}
                {chartBuilder.xCol && (
                  <>
                    {/* Summarize */}
                    <label className="cb2-field">
                      <span>3. Summarize</span>
                      <select value={chartBuilder.agg} onChange={(e) => setChartBuilder((p) => ({ ...p, agg: e.target.value }))}>
                        <option value="sum">Add up all values</option>
                        <option value="avg">Show the average</option>
                        <option value="count">Count entries</option>
                        <option value="max">Show the highest</option>
                        <option value="min">Show the lowest</option>
                      </select>
                    </label>

                    {/* Split by (optional) */}
                    <label className="cb2-field">
                      <span>4. Split by (optional) {chartBuilder.groupCol && <button className="cb2-field-clear" onClick={(e) => { e.preventDefault(); setChartBuilder((p) => ({ ...p, groupCol: "" })); }}>×</button>}</span>
                      <select value={chartBuilder.groupCol} onChange={(e) => setChartBuilder((p) => ({ ...p, groupCol: e.target.value }))}>
                        <option value="">No split</option>
                        {dataSet.headers.filter((h) => h !== chartBuilder.xCol && dataSet.profiles.find((p) => p.name === h)?.type === "text").map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>

                    {/* Chart type — inline row */}
                    <div className="cb2-type-row">
                      <span className="cb2-field-label">Chart style</span>
                      <div className="cb2-type-icons">
                        {cbTypes.map((ct) => (
                          <button
                            key={ct.type}
                            className={`cb2-type-mini ${chartBuilder.type === ct.type ? "active" : ""}`}
                            onClick={() => setChartBuilder((p) => ({ ...p, type: ct.type }))}
                            onMouseEnter={() => setHoveredChartType(ct.type)}
                            onMouseLeave={() => setHoveredChartType(null)}
                            title={ct.label}
                          >
                            {ct.icon}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Compact row: Top N + Color */}
                    <div className="cb2-compact-row">
                      <label className="cb2-field cb2-half">
                        <span>Show top</span>
                        <select value={xIsDateAxis ? 0 : chartBuilder.topN} disabled={xIsDateAxis} title={xIsDateAxis ? "Date axes show every period in chronological order" : undefined} onChange={(e) => setChartBuilder((p) => ({ ...p, topN: Number(e.target.value) }))}>
                          {xIsDateAxis && <option value={0}>All (timeline)</option>}
                          <option value={5}>5</option>
                          <option value={10}>10</option>
                          <option value={20}>20</option>
                          <option value={0}>All</option>
                        </select>
                      </label>
                      <div className="cb2-themes cb2-half">
                        <span>Color</span>
                        <div className="cb2-theme-chips">
                          {([
                            { id: "brand", c: reportSettings.brandColor },
                            { id: "blue", c: "#3b82f6" },
                            { id: "emerald", c: "#059669" },
                            { id: "sunset", c: "#f97316" },
                            { id: "purple", c: "#7c3aed" },
                            { id: "rose", c: "#e11d48" },
                            { id: "slate", c: "#475569" },
                          ] as { id: string; c: string }[]).map((t) => (
                            <button key={t.id} type="button" className={`cb2-theme-dot ${chartBuilder.colorTheme === t.id ? "active" : ""}`} style={{ background: t.c }} title={t.id === "brand" ? "Brand color" : t.id} onClick={() => setChartBuilder((p) => ({ ...p, colorTheme: t.id }))} />
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Reset controls */}
                    <div className="cb2-reset-controls">
                      {chartBuilderOrigin && (
                        <button className="cb2-reset-link" title="Revert your tweaks back to the suggested chart's settings" onClick={() => setChartBuilder((p) => ({ ...p, ...chartBuilderOrigin }))}>
                          Reset chart
                        </button>
                      )}
                      <button className="cb2-reset-btn" title="Clear everything and start a brand-new chart from scratch" onClick={() => { if (!window.confirm("Clear this chart and start a new one? Your current selections will be lost.")) return; setChartBuilder({ type: "bar", xCol: "", yCol: "", agg: "sum", groupCol: "", topN: 10, colorTheme: "blue", title: "" }); setChartBuilderOrigin(null); }}>
                        New chart
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Saved charts below */}
            {customCharts.length > 0 && (
              <div className="cb2-saved">
                <p className="cb2-panel-label">{customCharts.length} saved chart{customCharts.length !== 1 ? "s" : ""}</p>
                {customCharts.map((cc) => {
                  const chartData = computeCustomChartData(canonicalChartRows, cc.xCol, cc.yCol, cc.agg, cc.groupCol, cc.topN);
                  const chartTitle = cc.title || makeTitle(cc.xCol, cc.yCol, cc.agg, cc.groupCol);
                  return (
                    <div key={cc.id} className="custom-chart-wrapper hover-expand">
                      <div className="custom-chart-header">
                        <input className="custom-chart-title-edit" value={cc.title} placeholder={chartTitle} onChange={(e) => setCustomCharts((prev) => prev.map((c) => c.id === cc.id ? { ...c, title: e.target.value } : c))} />
                        <button className="custom-chart-remove" onClick={() => setCustomCharts((prev) => prev.filter((c) => c.id !== cc.id))} title="Remove chart">x</button>
                      </div>
                      <AIChart chart={{ type: cc.type as ChartCommand["type"], title: cc.title || chartTitle, data: chartData }} colorTheme={cc.colorTheme} brandColor={reportSettings.brandColor} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
            );
          })()}

          {/* Browse Data */}
          {exploreTab === "data" && (
          <section className="explore-section">
            <div className="section-title">
              <span className="step-pill">Data Table</span>
              <h2>Browse your data</h2>
            </div>
            {/* Data Profile Bar */}
            {(() => {
              const typeCounts = { date: 0, number: 0, text: 0, empty: 0 };
              let totalMissing = 0;
              for (const p of dataSet.profiles) { typeCounts[p.type]++; totalMissing += p.missing; }
              const totalCells = dataSet.profiles.length * dataSet.rows.length;
              const completeness = totalCells > 0 ? ((totalCells - totalMissing) / totalCells * 100) : 100;
              return (
                <div className="data-profile-bar">
                  <span>{dataSet.rows.length.toLocaleString()} rows</span>
                  <span>{dataSet.headers.length} columns ({typeCounts.number} numeric, {typeCounts.text} text, {typeCounts.date} date)</span>
                  <span>{completeness.toFixed(1)}% complete</span>
                </div>
              );
            })()}
            <DataTable
              rows={filteredRows}
              headers={dataSet.headers}
              sort={tableSort}
              onSort={setTableSort}
              filter={tableFilter}
              onFilter={setTableFilter}
              page={tablePage}
              onPage={setTablePage}
            />
            {/* Statistics (collapsed under data) */}
            <details className="stats-collapsible">
              <summary>Statistics &amp; Correlation</summary>
              {(() => {
                const numCols = getNumericColumns(dataSet.headers, filteredRows);
                if (numCols.length === 0) return <p className="muted" style={{ padding: "12px" }}>No numeric columns detected.</p>;
                return (
                  <>
                    <SummaryStatsTable rows={filteredRows} numericCols={numCols} />
                    {numCols.length >= 2 && (
                      <div style={{ marginTop: 16 }}>
                        <h4 style={{ fontSize: "0.9rem", marginBottom: 8 }}>Correlation Matrix</h4>
                        <CorrelationMatrix rows={filteredRows} numericCols={numCols} />
                      </div>
                    )}
                  </>
                );
              })()}
            </details>
          </section>
          )}

          {exploreTab === "compare" && analysis && (
          <section className="explore-section">
            <div className="section-title">
              <span className="step-pill">Compare</span>
              <h2>Compare with previous periods</h2>
              <p className="muted">Upload previous files to see what changed — revenue, products, and regions side by side.</p>
            </div>
            {(() => {
              const currentPeriod = detectPeriod(dataSet.fileName, dataSet.rows, mapping.date || undefined);
              const prevPeriod = previousDataSet ? detectPeriod(previousDataSet.fileName, previousDataSet.rows, mapping.date || undefined) : null;
              return (
              <>
            <div className="compare-files-grid">
              <div className="compare-file-slot">
                <span className="compare-file-label">File 1 (Current)</span>
                <div className={`compare-file-box ${dataSet ? "filled" : ""}`}>
                  <strong>{currentPeriod}</strong>
                  <span className="muted">{dataSet.fileName} — {dataSet.rows.length.toLocaleString()} rows</span>
                </div>
              </div>
              <div className="compare-arrow">vs</div>
              <div className="compare-file-slot">
                <span className="compare-file-label">File 2 (Previous period)</span>
                <label className={`compare-file-box upload ${previousDataSet ? "filled" : ""}`}>
                  <input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handlePreviousFileChange} />
                  <strong>{prevPeriod ?? "Upload comparison file"}</strong>
                  {previousDataSet ? <span className="muted">{previousDataSet.fileName} — {previousDataSet.rows.length.toLocaleString()} rows</span> : <span className="muted">CSV, XLSX, or XLS</span>}
                </label>
                {previousDataSet && (
                  <button type="button" className="cleaning-btn reset" onClick={() => setPreviousDataSet(null)}>Remove</button>
                )}
              </div>
            </div>
            <p className="muted" style={{ fontSize: "0.78rem", marginTop: 8 }}>For accurate comparison, both files should have the same column structure (e.g., monthly exports from the same system).</p>

            {comparison && previousAnalysis && (
              <>
                <div className="comparison-notes checkin-narrative" style={{ marginTop: 16 }}>
                  <h4>Comparison narrative{aiComparisonNarrative.loading && <span className="method-badge">Refining with AI…</span>}{!aiComparisonNarrative.loading && aiComparisonNarrative.text && <span className="method-badge">AI</span>}</h4>
                  <p>{aiComparisonNarrative.text ?? generateComparisonNarrative(comparison, analysis, previousAnalysis, currentPeriod, prevPeriod, reportSettings)}</p>
                </div>
                <div className="comparison-grid" style={{ marginTop: 16 }}>
                  <Kpi label={`${currentPeriod} ${analysis.primaryMetric.toLowerCase()}`} value={analysis.isMoney ? formatMoney(comparison.currentRevenue, reportSettings.currency) : comparison.currentRevenue.toLocaleString(undefined, { maximumFractionDigits: 1 })} />
                  <Kpi label={`${prevPeriod} ${analysis.primaryMetric.toLowerCase()}`} value={analysis.isMoney ? formatMoney(comparison.previousRevenue, reportSettings.currency) : comparison.previousRevenue.toLocaleString(undefined, { maximumFractionDigits: 1 })} />
                  <Kpi label={`${analysis.primaryMetric} change`} value={formatPercent(comparison.revenueChange)} tone={trendTone(comparison.revenueChange, reportSettings.template)} />
                  <Kpi label={`${currentPeriod} rows`} value={analysis.rowCount.toLocaleString()} />
                  <Kpi label={`${prevPeriod} rows`} value={previousAnalysis.rowCount.toLocaleString()} />
                  <Kpi label="Avg transaction change" value={previousAnalysis.averageRevenue === 0 ? "N/A" : formatPercent((analysis.averageRevenue - previousAnalysis.averageRevenue) / previousAnalysis.averageRevenue)} tone={trendTone(analysis.averageRevenue - previousAnalysis.averageRevenue, reportSettings.template)} />
                </div>
                {analysis.productRevenue.length > 0 && previousAnalysis.productRevenue.length > 0 && (
                  <div className="comparison-breakdown">
                    <h4>{getDimensionLabel("product", mapping, reportSettings.template)} comparison</h4>
                    <div className="comparison-breakdown-table">
                      <table>
                        <thead><tr><th>Product</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead>
                        <tbody>
                          {realItems(analysis.productRevenue).map((p) => {
                            const prev = previousAnalysis.productRevenue.find((pp) => pp.label === p.label);
                            const prevRev = prev?.revenue ?? 0;
                            const change = prevRev === 0 ? (p.revenue > 0 ? 1 : 0) : (p.revenue - prevRev) / prevRev;
                            return (
                              <tr key={p.label}>
                                <td><strong>{p.label}</strong></td>
                                <td>{formatMoney(p.revenue, reportSettings.currency)}</td>
                                <td>{formatMoney(prevRev, reportSettings.currency)}</td>
                                <td className={change >= 0 ? "positive" : "negative"}>{formatPercent(change)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                {analysis.regionRevenue.length > 0 && previousAnalysis.regionRevenue.length > 0 && (
                  <div className="comparison-breakdown">
                    <h4>Region comparison</h4>
                    <div className="comparison-breakdown-table">
                      <table>
                        <thead><tr><th>Region</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead>
                        <tbody>
                          {realItems(analysis.regionRevenue).map((r) => {
                            const prev = previousAnalysis.regionRevenue.find((pr) => pr.label === r.label);
                            const prevRev = prev?.revenue ?? 0;
                            const change = prevRev === 0 ? (r.revenue > 0 ? 1 : 0) : (r.revenue - prevRev) / prevRev;
                            return (
                              <tr key={r.label}>
                                <td><strong>{r.label}</strong></td>
                                <td>{formatMoney(r.revenue, reportSettings.currency)}</td>
                                <td>{formatMoney(prevRev, reportSettings.currency)}</td>
                                <td className={change >= 0 ? "positive" : "negative"}>{formatPercent(change)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}

            <details className="multi-compare-details" style={{ marginTop: 12 }}>
              <summary>Add more files for multi-period comparison</summary>
              <div className="multi-compare">
                <label className="compare-upload">
                  <input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleAddComparisonFile} />
                  <strong>Add another file</strong>
                  <span>Compare across multiple months or quarters</span>
                </label>
                {comparisonFiles.length > 0 && (
                  <div className="comparison-file-list">
                    {comparisonFiles.map((cf) => (
                      <div key={cf.fileName} className="comparison-file-item">
                        <span>{cf.fileName} ({cf.rows.length.toLocaleString()} rows)</span>
                        <button type="button" className="cleaning-btn reset" onClick={() => removeComparisonFile(cf.fileName)}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>

            {multiComparisons.length > 0 && (
              <div className="multi-compare-table" style={{ marginTop: 16 }}>
                <table>
                  <thead>
                    <tr><th>File</th><th>Period</th><th>{analysis.primaryMetric}</th><th>Rows</th><th>vs Current</th></tr>
                  </thead>
                  <tbody>
                    <tr className="current-row">
                      <td><strong>{dataSet.fileName}</strong></td>
                      <td>{currentPeriod}</td>
                      <td>{formatMoney(analysis.totalRevenue, reportSettings.currency)}</td>
                      <td>{analysis.rowCount}</td>
                      <td>--</td>
                    </tr>
                    {multiComparisons.map((mc) => (
                      <tr key={mc.file.fileName}>
                        <td>{mc.file.fileName}</td>
                        <td>{detectPeriod(mc.file.fileName, mc.file.rows, mapping.date || undefined)}</td>
                        <td>{formatMoney(mc.analysis.totalRevenue, reportSettings.currency)}</td>
                        <td>{mc.analysis.rowCount}</td>
                        <td className={mc.comparison.revenueChange >= 0 ? "positive" : "negative"}>
                          {formatPercent(mc.comparison.revenueChange)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
              </>
              );
            })()}

            {/* Analysis History from IndexedDB */}
            {analysisHistory.length > 0 && (
              <details className="history-section" style={{ marginTop: 16 }}>
                <summary>Analysis history ({analysisHistory.length} snapshot{analysisHistory.length !== 1 ? "s" : ""})</summary>
                <p className="muted" style={{ fontSize: "0.8rem", margin: "6px 0" }}>Stored locally in your browser — never on any server.</p>
                <div className="history-cards">
                  {analysisHistory.sort((a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime()).slice(0, 20).map((snap) => (
                    <div key={snap.id} className="history-card">
                      <div>
                        <strong>{snap.fileName}</strong>
                        <span className="muted">{new Date(snap.uploadDate).toLocaleDateString()} — {snap.rowCount.toLocaleString()} rows</span>
                      </div>
                      <div>
                        <span>{snap.primaryMetric}: {formatCompact(snap.totalRevenue)}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="history-actions">
                  <button type="button" className="link-btn" onClick={() => {
                    const blob = new Blob([JSON.stringify(analysisHistory, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = "analysis-history.json"; a.click();
                    URL.revokeObjectURL(url);
                  }}>Export history (JSON)</button>
                  <button type="button" className="link-btn" onClick={() => {
                    const input = document.createElement("input");
                    input.type = "file"; input.accept = ".json";
                    input.onchange = async (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (!file) return;
                      const text = await file.text();
                      try {
                        const imported = JSON.parse(text) as AnalysisSnapshot[];
                        for (const snap of imported) await saveSnapshot(snap);
                        setAnalysisHistory(await loadSnapshots());
                      } catch { /* ignore bad JSON */ }
                    };
                    input.click();
                  }}>Import history</button>
                  <button type="button" className="link-btn" style={{ color: "#dc2626" }} onClick={() => {
                    clearSnapshots().then(() => setAnalysisHistory([])).catch(() => {});
                  }}>Clear history</button>
                </div>
              </details>
            )}
          </section>
          )}

        </div>
      )}

      {activeTab === "ai" && dataSet && analysis && canAnalyze && (
        <>
          {aiSettings.apiKey && (
            <div className="byok-status-banner">
              <span className="byok-status-icon">&#10003;</span>
              <span>Using your <strong>{AI_MODELS[aiSettings.provider].label}</strong> key &mdash; unlimited questions, no credits used</span>
            </div>
          )}

          {/* Blurred preview when no key AND no credits */}
          {!aiSettings.apiKey && (creditsRemaining === null || creditsRemaining <= 0) && (
            <div className="ai-blurred-preview">
              <div className="ai-blurred-content">
                <div className="ai-blur-card">
                  <strong>Talk to Data</strong>
                  <p>Ask questions in plain English — &quot;Compare products by revenue&quot;, &quot;Show trend chart&quot;</p>
                  <span className="ai-blur-tag">Conversational AI</span>
                </div>
                <div className="ai-blur-card">
                  <strong>AI Report</strong>
                  <p>One-click full analysis: executive summary, trends, charts, risks, recommendations</p>
                  <span className="ai-blur-tag">5 credits</span>
                </div>
                <div className="ai-blur-card">
                  <strong>AI Agents</strong>
                  <p>5 specialized analysts: Insights, Anomalies, Forecast, Report Writer, Action Plan</p>
                  <span className="ai-blur-tag">3 credits each</span>
                </div>
              </div>
              <div className="ai-blurred-overlay">
                <p>Credits exhausted. Connect your own AI key for unlimited access.</p>
              </div>
            </div>
          )}

          {/* === AI-only features (require API key or credits) === */}
          {(aiSettings.apiKey || (creditsRemaining !== null && creditsRemaining > 0)) && (
          <>
          <section className="ai-insights-section">
            <div className="section-title">
              <span className="step-pill">Auto Insights</span>
              <h2>AI-generated highlights</h2>
            </div>
            {autoInsights.loading ? (
              <div className="auto-insights-loading">
                <div className="agent-loading-bar" />
                <p className="muted">Generating insights...</p>
              </div>
            ) : autoInsights.texts.length > 0 ? (
              <div className="auto-insights-grid">
                {autoInsights.texts.map((text, i) => (
                  <article key={i} className="auto-insight-card"><p>{text}</p></article>
                ))}
              </div>
            ) : (
              <div className="auto-insights-empty">
                <button className="agent-run-button" onClick={generateAutoInsights}>Generate quick insights{!aiSettings.apiKey && " (2 credits)"}</button>
                {aiSettings.apiKey && <span className="ai-cost-estimate">~200-400 tokens</span>}
              </div>
            )}
          </section>

          {/* Deep Analysis — AI Report + Agents */}
          {(aiSettings.apiKey || (creditsRemaining !== null && creditsRemaining > 0)) && <section className="ai-deep-analysis">
            <div className="section-title">
              <span className="step-pill">Deep Analysis</span>
              <h2>Full AI-powered reports &amp; agents</h2>
            </div>

            {/* AI Report card */}
            <div className="ai-deep-card">
              <div className="ai-deep-card-header">
                <div>
                  <strong>Full AI Report</strong>
                  <span className="ai-deep-desc">7-section analysis with charts. ~15-30 seconds.</span>
                </div>
                <span className="ai-cost-badge">{aiSettings.apiKey ? "~2,000-4,000 tokens" : "5 credits"}</span>
              </div>
              {aiReport.loading ? (
                <div className="ai-report-loading">
                  <div className="loading-spinner" />
                  <p>Generating comprehensive report...</p>
                </div>
              ) : aiReport.sections.length > 0 ? (
                <div className="ai-report-content">
                  {aiReport.sections.map((section, i) => (
                    <article key={i} className="ai-report-card">
                      <h3>{section.title}</h3>
                      <div className="ai-report-text">{section.text.split("\n").filter(Boolean).map((line, j) => <p key={j}>{line}</p>)}</div>
                      {section.chart && <AIChart chart={section.chart} brandColor={reportSettings.brandColor} />}
                    </article>
                  ))}
                  <div className="ai-report-actions">
                    <button className="agent-run-button" onClick={generateAIReport}>Regenerate</button>
                    <button className="secondary-button" onClick={() => setAiReport({ loading: false, sections: [] })}>Clear</button>
                  </div>
                </div>
              ) : (
                <>
                <button className="agent-run-button ai-report-btn" onClick={generateAIReport}>
                  Generate Full AI Report{!aiSettings.apiKey && " (5 credits)"}
                </button>
                {aiSettings.apiKey && <span className="ai-cost-estimate">~2,000-4,000 tokens per report</span>}
                </>
              )}
            </div>

            {/* Divider */}
            <div className="ai-deep-divider"><span>or run individual agents</span></div>

            {/* Agents grid inside deep analysis */}
            <div className="ai-agents-header">
              <button className="agent-run-all-btn" onClick={runAllAgents} disabled={!analysis || agentResults.some((r) => r.loading)}>
                {agentResults.some((r) => r.loading) ? "Running..." : `Run All Agents${!aiSettings.apiKey ? ` (${AI_AGENTS.length * 3} credits)` : ""}`}
              </button>
              <span className="ai-cost-badge">{aiSettings.apiKey ? "~5,000-10,000 tokens total" : `${AI_AGENTS.length * 3} credits total`}</span>
              {agentResults.some((r) => r.text && !r.loading) && (
                <button className="agent-download-all-btn" onClick={downloadAllAgentReports}>Download All Reports</button>
              )}
            </div>
            <div className="agents-grid">
              {AI_AGENTS.map((agent) => {
                const result = agentResults.find((r) => r.agentId === agent.id);
                return (
                  <article key={agent.id} className={`agent-card ${result?.loading ? "loading" : ""} ${result?.text ? "has-result" : ""}`}>
                    <div className="agent-card-header">
                      <div>
                        <span className="agent-label">{agent.label}</span>
                        <strong>{agent.title}</strong>
                        <p>{agent.description}</p>
                      </div>
                      <div className="agent-card-actions">
                        <button className="agent-run-button" onClick={() => runAgent(agent.id)} disabled={(!aiSettings.apiKey && !(creditsRemaining !== null && creditsRemaining > 0)) || !analysis || (result?.loading ?? false)}>
                          {result?.loading ? "Running..." : result?.text ? "Re-run" : `Run${!aiSettings.apiKey ? " (3 credits)" : ""}`}
                        </button>
                      </div>
                    </div>
                    {result?.loading && (<div className="agent-result"><div className="agent-loading-bar" /><p className="muted">Agent is analyzing your data...</p></div>)}
                    {result?.text && !result.loading && (
                      <div className="agent-result">
                        <div className="agent-result-actions">
                          <button className="agent-action-btn" onClick={() => setExpandedAgent(expandedAgent === agent.id ? null : agent.id)}>{expandedAgent === agent.id ? "Collapse" : "Expand"}</button>
                          <button className="agent-action-btn" onClick={() => copyAgentResult(result.text)}>Copy</button>
                          <button className="agent-action-btn agent-clear-button" onClick={() => clearAgentResult(agent.id)}>Clear</button>
                        </div>
                        {expandedAgent !== agent.id && (
                          <div className="agent-output agent-output-rich agent-output-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(result.text) }} />
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>

            {/* Expanded agent report — full width below cards */}
            {expandedAgent && (() => {
              const agent = AI_AGENTS.find((a) => a.id === expandedAgent);
              const result = agentResults.find((r) => r.agentId === expandedAgent);
              if (!agent || !result?.text) return null;
              return (
                <div className="agent-expanded-report">
                  <div className="agent-expanded-header">
                    <div>
                      <span className="agent-label">{agent.label}</span>
                      <h3>{agent.title}</h3>
                    </div>
                    <div className="agent-expanded-actions">
                      <button className="agent-action-btn" onClick={() => copyAgentResult(result.text)}>Copy to clipboard</button>
                      <button className="agent-action-btn" onClick={() => setExpandedAgent(null)}>Close</button>
                    </div>
                  </div>
                  <div className="agent-output agent-output-rich agent-output-full" dangerouslySetInnerHTML={{ __html: renderMarkdown(result.text) }} />
                </div>
              );
            })()}
          </section>}
          </>
          )}

          {/* BYOK Settings — small secondary link */}
          <details className="collapsible-panel byok-link" style={{ marginTop: 24 }}>
            <summary>{aiSettings.apiKey ? `API Key Connected (${AI_MODELS[aiSettings.provider].label})` : (AI_WORKER_ENABLED ? "Out of credits? Use your own key" : "Connect your AI key to enable AI features")}</summary>
            <div className="settings-grid">
              <label>
                <span>Provider</span>
                <select value={aiSettings.provider} onChange={(event) => { const provider = event.target.value as AIProvider; setAiSettings((current) => ({ ...current, provider, model: AI_MODELS[provider].models[0].id })); }}>
                  {Object.entries(AI_MODELS).map(([key, value]) => (<option key={key} value={key}>{value.label}</option>))}
                </select>
              </label>
              <label>
                <span>Model</span>
                <select value={aiSettings.model} onChange={(event) => setAiSettings((current) => ({ ...current, model: event.target.value }))}>
                  {AI_MODELS[aiSettings.provider].models.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                </select>
              </label>
              <label className="api-key-label">
                <span>API Key</span>
                <input type="password" value={aiSettings.apiKey} placeholder={`Paste your ${AI_MODELS[aiSettings.provider].label} API key`} onChange={(event) => setAiSettings((current) => ({ ...current, apiKey: event.target.value }))} />
              </label>
            </div>
            <p className="provider-hint">{getProviderHint(aiSettings.provider)}</p>
            <p className="ai-settings-note">Your API key stays in your browser. We never store or send it to our servers.</p>
          </details>
        </>
      )}
    </main>
  );
}

function RoleMappingGroup({
  title,
  roles,
  headers,
  mapping,
  onChange
}: {
  title: string;
  roles: Role[];
  headers: string[];
  mapping: Mapping;
  onChange: (role: Role, column: string) => void;
}) {
  return (
    <div className="mapping-group">
      <h3>{title}</h3>
      {roles.map((role) => (
        <label key={role} className="mapping-row">
          <span>{ROLE_LABELS[role]}</span>
          <select value={mapping[role]} onChange={(event) => onChange(role, event.target.value)}>
            <option value="">Select column</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

// "How this was computed" metadata — the same lineage dimensions documented in
// docs/computation-lineage.md (source column & role, aggregation, filters, n), built at render
// time from the live mapping so it always reflects what was actually computed.
type ComputedLineage = {
  source: string;
  aggregation: string;
  filters: string;
  n: number;
};

function ComputedNote({ lineage }: { lineage: ComputedLineage }) {
  return (
    <details className="computed-note hide-print">
      <summary>how computed</summary>
      <dl>
        <div><dt>Source</dt><dd>{lineage.source}</dd></div>
        <div><dt>Aggregation</dt><dd>{lineage.aggregation}</dd></div>
        <div><dt>Filters</dt><dd>{lineage.filters}</dd></div>
        <div><dt>n</dt><dd>{lineage.n.toLocaleString()}</dd></div>
      </dl>
    </details>
  );
}

// The canonical row-inclusion rule, described in words for the "how computed" affordance.
function canonicalFilterNote(mapping: Mapping): string {
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  const parts: string[] = [];
  if (valueCol) parts.push("blank/non-numeric values excluded");
  if (mapping.date) parts.push("invalid dates excluded");
  return parts.length > 0 ? parts.join("; ") : "none";
}

function Kpi({
  label,
  value,
  tone = "neutral",
  note,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative";
  note?: ComputedLineage;
}) {
  return (
    <article className={`kpi-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <ComputedNote lineage={note} />}
    </article>
  );
}

function QualityMetric({ label, value }: { label: string; value: number }) {
  return (
    <article className={value > 0 && label !== "Imported rows" ? "quality-card warning" : "quality-card"}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </article>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  const cardRef = useRef<HTMLElement>(null);

  const exportAsPng = useCallback(() => {
    const el = cardRef.current;
    if (!el) return;
    const svg = el.querySelector("svg");
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const bbox = svg.getBoundingClientRect();
    if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.round(bbox.width)));
    if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.round(bbox.height)));
    const blob = new Blob([clone.outerHTML], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = 2;
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      const link = document.createElement("a");
      link.download = `${title.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase()}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, [title]);

  return (
    <article className="chart-card" ref={cardRef}>
      <div className="chart-card-header">
        <h3>{title}</h3>
        <button className="chart-export-btn no-print" onClick={exportAsPng} title="Download as PNG">Export PNG</button>
      </div>
      {children}
    </article>
  );
}

// The single source of truth for a trend chart's slope annotation. When a verdict label is
// supplied it GOVERNS: a "normal variation" verdict shows "→ flat / normal variation" no
// matter how far the raw endpoints differ, and only a real up/down verdict prints a slope
// number — so the chart can never contradict the trend verdict. The raw-slope branch is the
// no-verdict fallback (findings === null, e.g. no data), the same Option-2 stance as
// isTrendFlat: local logic survives only where there is no verdict to honor.
export function resolveTrendChartLabel(trendLabel: string | undefined, slopePct: number): string {
  if (trendLabel) {
    if (trendLabel === "normal variation") return "→ flat / normal variation";
    return `${trendLabel === "upward trend" ? "↑ +" : "↓ "}${Math.abs(slopePct).toFixed(0)}%/mo`;
  }
  return Math.abs(slopePct) < 2
    ? "→ flat"
    : `${slopePct >= 0 ? "↑ +" : "↓ "}${Math.abs(slopePct).toFixed(0)}%/mo`;
}

function LineChart({ data, currency, showAnnotations = true, trendLabel, isMoney = true }: { data: RankedItem[]; currency: string; showAnnotations?: boolean; trendLabel?: string; isMoney?: boolean }) {
  const fmtC = (v: number) => isMoney ? formatMoney(v, currency) : Math.round(v).toLocaleString();
  if (data.length === 0) return <p className="muted">No trend data found.</p>;
  const width = 640;
  const height = 220;
  const padding = 28;
  const rightPadding = 74;
  const plotWidth = width - padding - rightPadding;
  const max = Math.max(...data.map((item) => item.revenue), 1);
  const min = Math.min(...data.map((item) => item.revenue), 0);
  const range = Math.max(max - min, 1);
  const peakIdx = data.reduce((best, item, i) => item.revenue > data[best].revenue ? i : best, 0);
  const troughIdx = data.reduce((worst, item, i) => item.revenue < data[worst].revenue ? i : worst, 0);
  const points = data.map((item, index) => {
    const x =
      data.length === 1
        ? width / 2
        : padding + (index / (data.length - 1)) * plotWidth;
    const y = height - padding - ((item.revenue - min) / range) * (height - padding * 2);
    return { ...item, x, y };
  });
  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");

  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const periodCount = Math.max(data.length - 1, 1);
  const slopePct = firstPoint && firstPoint.revenue !== 0
    ? ((lastPoint.revenue - firstPoint.revenue) / Math.abs(firstPoint.revenue) / periodCount) * 100
    : 0;
  const slopeLabel = resolveTrendChartLabel(trendLabel, slopePct);
  const peakPoint = points[peakIdx];
  const troughPoint = points[troughIdx];
  const peakLabelY = Math.max(peakPoint.y - 18, 12);
  const troughLabelY = Math.min(troughPoint.y + 24, height - 10);
  const trendLabelX = Math.min((lastPoint?.x ?? width - rightPadding) + 8, width - 8);
  const trendLabelY = Math.max(Math.min((lastPoint?.y ?? padding) + (slopePct >= 0 ? -8 : 14), height - 10), 12);

  return (
    <div className="line-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Trend line chart">
        <line x1={padding} y1={height - padding} x2={width - rightPadding} y2={height - padding} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} />
        {showAnnotations && (
          <>
            <line
              x1={firstPoint?.x ?? padding}
              y1={firstPoint?.y ?? height - padding}
              x2={lastPoint?.x ?? width - rightPadding}
              y2={lastPoint?.y ?? height - padding}
              className="annotation-trend-line"
              strokeDasharray="6,4"
              stroke="#6b7280"
              strokeWidth="1.5"
              opacity="0.5"
            />
            <text x={trendLabelX} y={trendLabelY} className="annotation-label" fontSize="10" fill="#6b7280">{slopeLabel}</text>
          </>
        )}
        <path d={path} />
        {points.map((point, i) => (
          <g key={point.label}>
            <circle
              cx={point.x}
              cy={point.y}
              r={showAnnotations && (i === peakIdx || i === troughIdx) ? 5 : 4}
              fill={showAnnotations && i === peakIdx ? "#ef4444" : showAnnotations && i === troughIdx ? "#2563eb" : undefined}
            />
            {(i === 0 || i === points.length - 1) && i !== peakIdx && i !== troughIdx && (
              <text
                x={point.x}
                y={point.y - 10}
                textAnchor={i === 0 ? "start" : "end"}
                className="chart-point-label"
              >
                {formatCompact(point.revenue)}
              </text>
            )}
            {showAnnotations && i === peakIdx && (
              <text x={point.x} y={peakLabelY} textAnchor="middle" className="annotation-badge" fontSize="10" fill="#b42318">
                ▲ Peak: {formatCompact(point.revenue)}, {point.label}
              </text>
            )}
            {showAnnotations && i === troughIdx && peakIdx !== troughIdx && (
              <text x={point.x} y={troughLabelY} textAnchor="middle" className="annotation-badge" fontSize="10" fill="#1d4ed8">
                ▼ Low: {formatCompact(point.revenue)}, {point.label}
              </text>
            )}
            {false && showAnnotations && i === peakIdx && (
              <text x={point.x} y={point.y - 20} textAnchor="middle" className="annotation-badge" fontSize="8" fill="#10b981">▲ PEAK</text>
            )}
            {false && showAnnotations && i === troughIdx && peakIdx !== troughIdx && (
              <text x={point.x} y={point.y + 20} textAnchor="middle" className="annotation-badge" fontSize="8" fill="#ef4444">▼ LOW</text>
            )}
            {(i === 0 || i === points.length - 1) && (
              <text
                x={point.x}
                y={height - 6}
                textAnchor={i === 0 ? "start" : "end"}
                className="chart-axis-label"
              >
                {point.label}
              </text>
            )}
            <title>
              {point.label}: {fmtC(point.revenue)}
            </title>
          </g>
        ))}
      </svg>
      <div className="chart-caption">
        <span>Peak: {fmtC(max)}</span>
        <span>{slopeLabel}</span>
        <span>{data.length} periods</span>
      </div>
    </div>
  );
}

function HorizontalBarChart({ items, currency, showAnnotations = true, pctOverride, colorByPerformance = false, isMoney = true, isAverage = false }: { items: RankedItem[]; currency: string; showAnnotations?: boolean; pctOverride?: Record<string, number>; colorByPerformance?: boolean; isMoney?: boolean; isAverage?: boolean }) {
  if (items.length === 0) return <p className="muted">Map this column to generate the breakdown.</p>;
  const fmtValue = (v: number) => isMoney ? formatMoney(v, currency) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const hasNegatives = items.some((item) => item.revenue < 0);
  const topRows = items.slice(0, hasNegatives ? 20 : 8);
  const othersRevenue = items.slice(hasNegatives ? 20 : 8).reduce((s, item) => s + item.revenue, 0);
  const othersCount = items.length - topRows.length;
  const rows = othersCount > 0 ? [...topRows, { label: `Others (${othersCount})`, revenue: othersRevenue }] : topRows;
  const total = items.reduce((s, item) => s + Math.abs(item.revenue), 0);
  const max = Math.max(...rows.map((item) => Math.abs(item.revenue)), 1);
  const avg = total / items.length;
  const topIdx = rows.reduce((best, item, i) => item.revenue > rows[best].revenue ? i : best, 0);
  const width = 640;
  const rowHeight = 34;
  const barHeight = 12;
  const labelWidth = 150;
  const rightPadding = 86;
  const topPadding = 24;
  const chartHeight = topPadding + rows.length * rowHeight + 6;
  const barWidth = width - labelWidth - rightPadding;
  const avgX = labelWidth + Math.min(Math.max(avg / max, 0), 1) * barWidth;
  const avgPct = max > 0 ? (avg / max) * 100 : 0;
  return (
    <div className="horizontal-chart">
      <svg className="horizontal-bar-svg" viewBox={`0 0 ${width} ${chartHeight}`} role="img" aria-label="Horizontal bar chart with average and top annotations">
        {showAnnotations && (
          <>
            {/* Dashed average line for the bar value axis. */}
            <line
              x1={avgX}
              y1={12}
              x2={avgX}
              y2={chartHeight - 4}
              className="annotation-avg-line avgline"
              stroke="#6b7280"
              strokeDasharray="6,4"
              strokeWidth="1.5"
              opacity="0.5"
            />
            <text x={Math.min(avgX + 6, width - 76)} y={14} className="annotation-label" fontSize="10" fill="#6b7280">
              Avg: {isMoney ? formatCompact(avg) : avg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
            </text>
          </>
        )}
        {rows.map((item, i) => {
          const y = topPadding + i * rowHeight;
          const absPct = max > 0 ? Math.abs(item.revenue) / max : 0;
          const barW = Math.max(absPct * barWidth, 3);
          const barEnd = labelWidth + barW;
          const totalPct = total > 0 ? Math.round((Math.abs(item.revenue) / total) * 100) : 0;
          const isTop = showAnnotations && i === topIdx;
          const valueLabelX = Math.min(barEnd + 8, width - 58);
          const barColor = hasNegatives ? (item.revenue >= 0 ? "#22c55e" : "#ef4444") : colorByPerformance ? (item.revenue >= avg ? undefined : "#CBD5E1") : undefined;
          return (
            <g key={item.label} className={`horizontal-row${isTop ? " top-performer" : ""}`}>
              <text x="0" y={y + 14} className="horizontal-svg-label">
                {item.label}
              </text>
              <rect x={labelWidth} y={y + 4} width={barWidth} height={barHeight} rx="6" className="horizontal-svg-track" />
              <rect x={labelWidth} y={y + 4} width={barW} height={barHeight} rx="6" className="horizontal-svg-bar" fill={barColor} />
              <text x={valueLabelX} y={y + 14} className="horizontal-svg-value">
                {fmtValue(item.revenue)}
              </text>
              {showAnnotations && (
                <text x={valueLabelX} y={y + 28} className="pct-label horizontal-svg-pct">
                  ({pctOverride && item.label in pctOverride ? pctOverride[item.label] : totalPct}%)
                </text>
              )}
              {isTop && !hasNegatives && (
                <text x={Math.min(barEnd + 8, width - 44)} y={y + 2} className="annotation-badge badge-top" fontSize="10">
                  ▲ Top
                </text>
              )}
              <title>
                {item.label}: {fmtValue(item.revenue)} ({pctOverride && item.label in pctOverride ? pctOverride[item.label] : totalPct}%)
              </title>
            </g>
          );
        })}
      </svg>
      {false && items.slice(0, 8).map((item, i) => {
        const pct = total > 0 ? ((item.revenue / total) * 100).toFixed(0) : "0";
        const isTop = i === 0 && showAnnotations;
        const isBelowAvg = showAnnotations && item.revenue < avg;
        return (
          <div key={item.label} className={`horizontal-row${isTop ? " top-performer" : ""}${isBelowAvg ? " below-avg" : ""}`}>
            <div className="horizontal-label">
              <span>{item.label}{isTop && <span className="badge-top"> ★</span>}</span>
              <strong>{formatMoney(item.revenue, currency)}{showAnnotations && <span className="pct-label"> ({pct}%)</span>}</strong>
            </div>
            <div className="horizontal-track">
              <i style={{ width: `${Math.max((item.revenue / max) * 100, 3)}%` }} />
              {showAnnotations && (
                <span className="avg-marker" style={{ left: `${Math.min(avgPct, 98)}%` }} title={`Average: ${formatMoney(avg, currency)}`} />
              )}
            </div>
          </div>
        );
      })}
      {showAnnotations && (
        <div className="chart-caption">
          {isAverage
            ? <span>Overall avg: {fmtValue(avg)}</span>
            : <><span>Average: {fmtValue(avg)}</span><span>Total: {fmtValue(total)}</span></>
          }
        </div>
      )}
    </div>
  );
}

function ConcentrationChart({ items, currency, sourceLabel = "customer (entity)" }: { items: RankedItem[]; currency: string; sourceLabel?: string }) {
  const { rows, total, topShare, top3Share } = computeShares(items, 8);
  if (total === 0) return <p className="muted">No revenue data to show concentration.</p>;
  return (
    <div className="concentration-chart">
      {topShare > 0.4 && (
        <div className="concentration-warning">
          Top customer accounts for {formatPercent(topShare)} of revenue — high dependency risk.
        </div>
      )}
      {top3Share > 0.7 && topShare <= 0.4 && (
        <div className="concentration-warning mild">
          Top 3 customers account for {formatPercent(top3Share)} — moderate concentration.
        </div>
      )}
      {rows.map((row) => (
        <div key={row.label} className="concentration-row">
          <div className="concentration-label">
            <span>{row.label}</span>
            <strong>{formatPercent(row.share)}</strong>
          </div>
          <div className="horizontal-track">
            <i style={{ width: `${Math.max(row.share * 100, 3)}%` }} />
          </div>
          <span className="concentration-cumulative">{formatPercent(row.cumulativeShare)} cumulative</span>
        </div>
      ))}
      <p className="concentration-footer">Total: {formatMoney(total, currency)} across {items.length} customers</p>
      <ComputedNote lineage={{ source: sourceLabel, aggregation: "each entity's value ÷ Σ all entities (share, 0–100%)", filters: "missing/invalid labels excluded", n: items.length }} />
    </div>
  );
}

// A genuine share/concentration visual — a donut of each slice's % of the whole, distinct from the
// ranked "by product" bar. Input is already top-N + an "Other (k)" bucket, so the slices reconcile
// exactly to the identified total shown in the center.
function DonutChart({ items, currency, isMoney = true }: { items: RankedItem[]; currency: string; isMoney?: boolean }) {
  const total = items.reduce((s, i) => s + Math.abs(i.revenue), 0);
  if (total <= 0) return <p className="muted">No data to show share.</p>;
  const palette = ["#6366f1", "#22c55e", "#f59e0b", "#ec4899", "#06b6d4", "#94a3b8"];
  const fmtVal = (v: number) => isMoney ? formatMoney(v, currency) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const size = 180;
  const cx = size / 2;
  const cy = size / 2;
  const r = 70;
  const strokeW = 26;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const slices = items.map((item, i) => {
    const share = Math.abs(item.revenue) / total;
    const slice = { ...item, share, color: palette[i % palette.length], dash: share * circ, offset };
    offset += share * circ;
    return slice;
  });
  const topShare = slices[0]?.share ?? 0;
  return (
    <div className="donut-chart">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Share donut chart" className="donut-svg">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eef2f7" strokeWidth={strokeW} />
        {slices.map((s) => (
          <circle
            key={s.label}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={strokeW}
            strokeDasharray={`${s.dash.toFixed(2)} ${(circ - s.dash).toFixed(2)}`}
            strokeDashoffset={(-s.offset).toFixed(2)}
            transform={`rotate(-90 ${cx} ${cy})`}
          >
            <title>{s.label}: {fmtVal(s.revenue)} ({formatPercent(s.share)})</title>
          </circle>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="11" fill="#64748b">Top {Math.min(slices.length, 3)} = {formatPercent(slices.slice(0, 3).reduce((sum, s) => sum + s.share, 0))}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="13" fill="#1e293b" fontWeight="600">{fmtVal(total)}</text>
      </svg>
      <ul className="donut-legend">
        {slices.map((s) => (
          <li key={s.label}>
            <span className="donut-swatch" style={{ background: s.color }} />
            <span className="donut-legend-label">{s.label}</span>
            <strong>{formatPercent(s.share)}</strong>
          </li>
        ))}
      </ul>
      <p className="donut-footer muted">{slices[0]?.label} is the largest share at {formatPercent(topShare)} · slices sum to {fmtVal(total)}.</p>
    </div>
  );
}

function ForecastChart({ historical: rawHistorical, forecast, currency, trendLabel, isMoney = true }: { historical: RankedItem[]; forecast: ForecastResult; currency: string; trendLabel?: string; isMoney?: boolean }) {
  const isLong = rawHistorical.length > 24;
  const historical = isLong ? rawHistorical.slice(-12) : rawHistorical;
  const zoomLabel = isLong ? "Last 12 periods + forecast" : null;

  const width = 640;
  const height = 240;
  const padding = 36;
  const allValues = [...historical.map((h) => h.revenue), ...forecast.predictions.map((p) => p.upper)];
  const minVal = Math.min(...allValues, ...forecast.predictions.map((p) => p.lower), 0);
  const maxVal = Math.max(...allValues, 1);
  const range = Math.max(maxVal - minVal, 1);
  const totalPoints = historical.length + forecast.predictions.length;

  const toX = (i: number) => padding + (i / Math.max(totalPoints - 1, 1)) * (width - padding * 2);
  const toY = (v: number) => height - padding - ((v - minVal) / range) * (height - padding * 2);

  const histPath = historical.map((h, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(h.revenue).toFixed(1)}`).join(" ");
  const foreStart = historical.length - 1;
  const forecastPath = [
    `M${toX(foreStart).toFixed(1)},${toY(historical[foreStart]?.revenue ?? 0).toFixed(1)}`,
    ...forecast.predictions.map((p, i) => `L${toX(historical.length + i).toFixed(1)},${toY(p.value).toFixed(1)}`)
  ].join(" ");

  const bandPoints = forecast.predictions.map((p, i) => ({
    x: toX(historical.length + i),
    upper: toY(p.upper),
    lower: toY(p.lower),
  }));
  const bandPath = bandPoints.length > 0 ? [
    `M${toX(foreStart).toFixed(1)},${toY(historical[foreStart]?.revenue ?? 0).toFixed(1)}`,
    ...bandPoints.map((bp) => `L${bp.x.toFixed(1)},${bp.upper.toFixed(1)}`),
    ...bandPoints.slice().reverse().map((bp) => `L${bp.x.toFixed(1)},${bp.lower.toFixed(1)}`),
    `L${toX(foreStart).toFixed(1)},${toY(historical[foreStart]?.revenue ?? 0).toFixed(1)}`,
    "Z"
  ].join(" ") : "";

  const methodLabel = forecast.method === "linear" ? "Linear trend" : forecast.method === "exponential" ? "Exponential smoothing" : "Seasonal pattern";

  // --- Plain-language summary (no jargon on the face) ---
  const fmtC = (v: number) => isMoney ? formatMoney(Math.round(v), currency) : Math.round(v).toLocaleString();
  const preds = forecast.predictions;
  const nextAvg = preds.length > 0 ? preds.reduce((s, p) => s + p.value, 0) / preds.length : 0;
  const rangeLow = preds.length > 0 ? Math.min(...preds.map((p) => p.lower)) : 0;
  const rangeHigh = preds.length > 0 ? Math.max(...preds.map((p) => p.upper)) : 0;
  // Characterize the whole span — a flat series must read as flat, not as growth.
  const hMean = rawHistorical.reduce((s, h) => s + h.revenue, 0) / Math.max(rawHistorical.length, 1);
  const hMax = Math.max(...rawHistorical.map((h) => h.revenue), 0);
  const hMin = Math.min(...rawHistorical.map((h) => h.revenue), 0);
  const hSpread = hMean > 0 ? (hMax - hMin) / hMean : 0;
  const hFirst = rawHistorical[0]?.revenue ?? 0;
  const hLast = rawHistorical[rawHistorical.length - 1]?.revenue ?? 0;
  const overallPct = hFirst > 0 ? ((hLast - hFirst) / hFirst) * 100 : 0;
  // Defer to the trend verdict when available so the forecast Outlook never disagrees with
  // the exec summary / trend section. Fall back to the local heuristic only if unset.
  const flat = trendLabel ? trendLabel === "normal variation" : hSpread < 0.25 && Math.abs(overallPct) < 10;
  const outlook = trendLabel
    ? trendLabel === "normal variation"
      ? "Flat & steady"
      : trendLabel === "upward trend"
        ? "Gradual growth"
        : "Gentle decline"
    : flat
      ? "Flat & steady"
      : overallPct >= 0
        ? "Gradual growth"
        : "Gentle decline";
  const plainSentence = `${flat ? "Held roughly steady — expect" : "Expect"} about ${fmtC(nextAvg)} per period over the next ${preds.length} period${preds.length === 1 ? "" : "s"} (likely ${fmtC(rangeLow)}–${fmtC(rangeHigh)}).`;

  // --- Collision-free x ticks: evenly spaced, last historical always shown, no crowding. ---
  const step = Math.max(1, Math.ceil(historical.length / 5));
  const tickIdxs: number[] = [];
  for (let i = 0; i < historical.length; i += step) tickIdxs.push(i);
  if (tickIdxs[tickIdxs.length - 1] !== foreStart) {
    if (foreStart - tickIdxs[tickIdxs.length - 1] < step / 2) tickIdxs.pop();
    tickIdxs.push(foreStart);
  }
  const foreMidX = (toX(foreStart) + toX(totalPoints - 1)) / 2;

  return (
    <div className="forecast-chart">
      <div className="forecast-summary">
        <div className="forecast-card">
          <span>Outlook</span>
          <strong>{outlook}</strong>
        </div>
        <div className="forecast-card">
          <span>Next {preds.length} period{preds.length === 1 ? "" : "s"}</span>
          <strong>~{fmtC(nextAvg)}<small> avg</small></strong>
        </div>
        <div className="forecast-card">
          <span>Likely range</span>
          <strong>{fmtC(rangeLow)} – {fmtC(rangeHigh)}</strong>
        </div>
      </div>
      <p className="forecast-sentence">{plainSentence}</p>
      {zoomLabel && <p className="muted" style={{ fontSize: "0.75rem", margin: "0 0 4px", fontStyle: "italic" }}>{zoomLabel}</p>}
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Forecast chart">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#e2e8f0" strokeWidth="1" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#e2e8f0" strokeWidth="1" />
        <line x1={toX(foreStart)} y1={padding} x2={toX(foreStart)} y2={height - padding} stroke="#cbd5e1" strokeDasharray="4 3" strokeWidth="1" />
        <text x={foreMidX} y={padding - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">Forecast</text>
        {bandPath && <path d={bandPath} fill="var(--brand-color, #6366f1)" opacity="0.12" />}
        <path d={histPath} fill="none" stroke="var(--brand-color, #6366f1)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d={forecastPath} fill="none" stroke="var(--brand-color, #6366f1)" strokeWidth="2" strokeDasharray="6 4" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
        {historical.map((h, i) => (
          <circle key={`h-${i}`} cx={toX(i)} cy={toY(h.revenue)} r={totalPoints > 20 ? 2 : 3} fill="var(--brand-color, #6366f1)" />
        ))}
        {forecast.predictions.map((p, i) => (
          <g key={`f-${i}`}>
            <circle cx={toX(historical.length + i)} cy={toY(p.value)} r={4} fill="white" stroke="var(--brand-color, #6366f1)" strokeWidth="2" />
            <text x={toX(historical.length + i)} y={toY(p.value) + (i % 2 === 0 ? -10 : -22)} textAnchor="middle" fontSize="9" fill="#1e293b" fontWeight="600">{formatCompact(p.value)}</text>
          </g>
        ))}
        {tickIdxs.map((idx) => (
          <text key={`xl-${idx}`} x={toX(idx)} y={height - 8} textAnchor={idx === 0 ? "start" : idx === foreStart ? "end" : "middle"} fontSize="9" fill="#94a3b8">{historical[idx]?.label}</text>
        ))}
      </svg>
      <p className="forecast-legend muted">Solid = actual · dashed = forecast · shaded = likely range.</p>
      <details className="forecast-method-details">
        <summary>How we calculated this</summary>
        <p>
          {methodLabel} fitted to {rawHistorical.length} period{rawHistorical.length === 1 ? "" : "s"} of history.
          The shaded band is a 95% prediction interval (it widens further out because uncertainty grows).
          {forecast.confidence === "High"
            ? " The trend fits the data closely, so confidence is high."
            : forecast.confidence === "Medium"
            ? " This is a reasonable estimate; more history would sharpen it."
            : " With under 6 periods this is a rough estimate — it improves with 12+ periods."}
          {` Model fit (R²): ${(forecast.r2 * 100).toFixed(0)}%.`}
        </p>
      </details>
    </div>
  );
}

function BarSeries({ data }: { data: RankedItem[] }) {
  const max = Math.max(...data.map((item) => item.revenue), 1);
  return (
    <div className="bar-series">
      {data.slice(-10).map((item) => (
        <div key={item.label} className="bar-row">
          <span>{item.label}</span>
          <div>
            <i style={{ width: `${Math.max((item.revenue / max) * 100, 2)}%` }} />
          </div>
          <strong>{formatCompact(item.revenue)}</strong>
        </div>
      ))}
    </div>
  );
}

function RankedList({ items }: { items: RankedItem[] }) {
  if (items.length === 0) return <p className="muted">Map this column to generate the breakdown.</p>;
  return (
    <ol className="ranked-list">
      {items.slice(0, 6).map((item) => (
        <li key={item.label}>
          <span>{item.label}</span>
          <strong>{formatMoney(item.revenue)}</strong>
        </li>
      ))}
    </ol>
  );
}

function generateRuleBasedChart(question: string, analysis: Analysis, settings: ReportSettings, mapping?: Mapping): ChartCommand | null {
  const q = question.toLowerCase();
  const met = analysis.primaryMetric;

  const wantsDonut = q.includes("donut");
  const wantsPie = q.includes("pie") || q.includes("share") || q.includes("split") || q.includes("composition");
  const wantsLine = q.includes("line") || q.includes("over time");
  const wantsScatter = q.includes("scatter") || q.includes("correlation");
  const type = wantsDonut ? "donut" as const : wantsPie ? "pie" as const : wantsScatter ? "scatter" as const : wantsLine ? "line" as const : "bar" as const;

  // Forecast questions → line chart with projection
  if (/forecast|predict|next\s+\d+\s*month|projection|future|ahead|upcoming/.test(q) && analysis.periodRevenue.length > 0) {
    const lastThree = analysis.periodRevenue.slice(-3);
    const avg = lastThree.length ? sum(lastThree.map((p) => p.revenue)) / lastThree.length : 0;
    const forecastPoints = [{ label: "Forecast 1", value: Math.round(avg) }, { label: "Forecast 2", value: Math.round(avg) }, { label: "Forecast 3", value: Math.round(avg) }];
    return { type: "line", title: `${met} Forecast (${settings.currency})`, data: [...analysis.periodRevenue.map((p) => ({ label: p.label, value: p.revenue })), ...forecastPoints] };
  }
  // Driver / cause / why questions → product breakdown bar chart
  if (/driving|cause|why|factor|contribut|break\s*down|behind|explain.*(?:trend|change|decline|growth)|reason/.test(q) && analysis.productRevenue.length > 0) {
    return { type: "bar", title: `${met} Breakdown — What's Driving the Numbers`, data: analysis.productRevenue.slice(0, 8).map((p) => ({ label: p.label, value: p.revenue })) };
  }
  // Recommendations / actions → no chart
  if (/should i|recommend|action|suggestion|what.*do|advice|next step|plan/.test(q)) {
    return null;
  }
  // Trend questions → line chart
  if (/trend|going up|going down|growing|declining|direction|over time|monthly|weekly/.test(q) && analysis.periodRevenue.length > 0) {
    return { type: "line", title: `${met} Trend (${settings.currency})`, data: analysis.periodRevenue.map((p) => ({ label: p.label, value: p.revenue })) };
  }
  // Named product entity → highlight that product in context
  const pLabel = mapping ? getDimensionLabel("product", mapping, settings.template) : "Product";
  const cLabel = mapping ? getDimensionLabel("customer", mapping, settings.template) : "Customer";
  const rLabel = mapping ? getDimensionLabel("region", mapping, settings.template) : "Region";
  for (const p of analysis.productRevenue) {
    if (q.includes(p.label.toLowerCase()) && analysis.productRevenue.length > 0) {
      return { type: "bar", title: `${p.label} vs Other ${pLabel}s`, data: analysis.productRevenue.slice(0, 8).map((pr) => ({ label: pr.label, value: pr.revenue })) };
    }
  }
  // Product questions
  if (/(product|item|sku|category|best product|top product|compare product|worst product|all product)/.test(q) && analysis.productRevenue.length > 0) {
    const realProd = realItems(analysis.productRevenue);
    const data = q.includes("worst") || q.includes("bottom")
      ? realProd.slice(-10).reverse().map((p) => ({ label: p.label, value: p.revenue }))
      : realProd.slice(0, 10).map((p) => ({ label: p.label, value: p.revenue }));
    return { type, title: `${met} by ${pLabel} (${settings.currency})`, data };
  }
  // Region questions
  if (/(region|country|city|area|territory|location|best region|top region|compare region)/.test(q) && analysis.regionRevenue.length > 0) {
    return { type, title: `${met} by ${rLabel} (${settings.currency})`, data: realItems(analysis.regionRevenue).slice(0, 10).map((r) => ({ label: r.label, value: r.revenue })) };
  }
  // Customer questions
  if (/(customer|client|buyer|top customer|best customer|top 10)/.test(q) && analysis.customerRevenue.length > 0) {
    return { type, title: `${met} by ${cLabel} (${settings.currency})`, data: realItems(analysis.customerRevenue).slice(0, 10).map((c) => ({ label: c.label, value: c.revenue })) };
  }
  // ROI questions
  if (/\broi\b|return on investment/.test(q) && analysis.roiByProduct.length > 0) {
    return { type, title: `ROI by ${pLabel} (%)`, data: analysis.roiByProduct.slice(0, 10).map((m) => ({ label: m.label, value: Math.round(m.revenue * 10) / 10 })) };
  }
  // Margin / profit questions
  if (/(margin|profit|cost)/.test(q) && analysis.marginByProduct.length > 0) {
    return { type, title: `Margin by ${pLabel} (${settings.currency})`, data: analysis.marginByProduct.slice(0, 10).map((m) => ({ label: m.label, value: m.revenue })) };
  }
  // Concentration questions
  if (/concentrat|depend|diversif/.test(q) && analysis.customerRevenue.length > 0) {
    return { type: "bar", title: `${cLabel} Concentration (${settings.currency})`, data: realItems(analysis.customerRevenue).slice(0, 10).map((c) => ({ label: c.label, value: c.revenue })) };
  }
  // Summary / overview → line chart
  if (/summary|overview|everything|big picture|how.*doing/.test(q) && analysis.periodRevenue.length > 0) {
    return { type: "line", title: `${met} Overview (${settings.currency})`, data: analysis.periodRevenue.map((p) => ({ label: p.label, value: p.revenue })) };
  }
  // Explicit chart requests
  if (/(chart|graph|plot|visualize|show|breakdown|pivot|compare)/.test(q)) {
    if (analysis.productRevenue.length > 0) {
      return { type, title: `${met} by ${pLabel} (${settings.currency})`, data: realItems(analysis.productRevenue).slice(0, 10).map((p) => ({ label: p.label, value: p.revenue })) };
    }
    if (analysis.periodRevenue.length > 0) {
      return { type: "line", title: `${met} Trend (${settings.currency})`, data: analysis.periodRevenue.map((p) => ({ label: p.label, value: p.revenue })) };
    }
  }
  return null;
}

function parseChartCommand(text: string): { cleanText: string; chart: ChartCommand | null } {
  const chartMatch = text.match(/```chart\s*\n?([\s\S]*?)\n?```/);
  if (!chartMatch) return { cleanText: text, chart: null };
  try {
    const parsed = JSON.parse(chartMatch[1].trim());
    if (parsed.type && parsed.data && Array.isArray(parsed.data)) {
      const cleanText = text.replace(/```chart\s*\n?[\s\S]*?\n?```/, "").trim();
      // Single chart validator: strips junk categories AND drops any grand-total row mixed
      // in with its own components, so an AI chart can't show "Total" beside its parts.
      const isShare = parsed.type === "pie" || parsed.type === "donut";
      const data = validateChartSeries(parsed.data as ChartCommand["data"], { isShare }).items;
      return { cleanText, chart: { ...parsed, data } as ChartCommand };
    }
  } catch { /* ignore parse errors */ }
  return { cleanText: text, chart: null };
}

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h4 class="md-h3">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="md-h2">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="md-h1">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^[-*] (.+)$/gm, '<li class="md-li">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="md-li md-ol"><span class="md-num">$1.</span> $2</li>')
    .replace(/\b(High)\b/gi, '<span class="severity-badge severity-high">High</span>')
    .replace(/\b(Medium)\b/gi, '<span class="severity-badge severity-medium">Medium</span>')
    .replace(/\b(Low)\b/gi, '<span class="severity-badge severity-low">Low</span>')
    .replace(/\n{2,}/g, '<div class="md-break"></div>')
    .replace(/\n/g, "<br/>");
}

function brandColorPalette(hex: string): string[] {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const lighten = (amt: number) => `#${[r, g, b].map((c) => Math.min(255, c + Math.round((255 - c) * amt)).toString(16).padStart(2, "0")).join("")}`;
  const darken = (amt: number) => `#${[r, g, b].map((c) => Math.max(0, Math.round(c * (1 - amt))).toString(16).padStart(2, "0")).join("")}`;
  return [hex, lighten(0.2), lighten(0.4), lighten(0.6), darken(0.15), hex, lighten(0.2), lighten(0.4)];
}

const COLOR_THEMES: Record<string, string[]> = {
  blue: ["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#1d4ed8", "#2563eb", "#3b82f6", "#60a5fa"],
  emerald: ["#059669", "#10b981", "#34d399", "#6ee7b7", "#047857", "#059669", "#10b981", "#34d399"],
  sunset: ["#ea580c", "#f97316", "#fb923c", "#fdba74", "#c2410c", "#ea580c", "#f97316", "#fb923c"],
  purple: ["#7c3aed", "#8b5cf6", "#a78bfa", "#c4b5fd", "#6d28d9", "#7c3aed", "#8b5cf6", "#a78bfa"],
  rose: ["#e11d48", "#f43f5e", "#fb7185", "#fda4af", "#be123c", "#e11d48", "#f43f5e", "#fb7185"],
  slate: ["#334155", "#475569", "#64748b", "#94a3b8", "#1e293b", "#334155", "#475569", "#64748b"],
  default: ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#dc2626", "#0891b2", "#ca8a04", "#6366f1"],
};

function AIChart({ chart, colorTheme, brandColor }: { chart: ChartCommand; colorTheme?: string; brandColor?: string }) {
  if (!chart.data || chart.data.length === 0) return null;
  const max = Math.max(...chart.data.map((d) => Math.abs(d.value)), 1);
  const COLORS = colorTheme === "brand" && brandColor ? brandColorPalette(brandColor) : (COLOR_THEMES[colorTheme ?? ""] ?? COLOR_THEMES.default);

  if (chart.type === "pie") {
    const total = chart.data.reduce((s, d) => s + d.value, 0);
    let cumAngle = 0;
    const slices = chart.data.map((d, i) => {
      const angle = (d.value / total) * 360;
      const startAngle = cumAngle;
      cumAngle += angle;
      const midAngle = ((startAngle + cumAngle) / 2) * (Math.PI / 180);
      const large = angle > 180 ? 1 : 0;
      const r = 80;
      const cx = 100, cy = 100;
      const x1 = cx + r * Math.cos((startAngle - 90) * Math.PI / 180);
      const y1 = cy + r * Math.sin((startAngle - 90) * Math.PI / 180);
      const x2 = cx + r * Math.cos((cumAngle - 90) * Math.PI / 180);
      const y2 = cy + r * Math.sin((cumAngle - 90) * Math.PI / 180);
      return { ...d, color: COLORS[i % COLORS.length], path: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`, pct: d.value / total, midAngle };
    });
    return (
      <div className="ai-chart ai-pie-chart">
        <h4>{chart.title}</h4>
        <div className="pie-layout">
          <svg viewBox="0 0 200 200" width="200" height="200">
            {slices.map((s, i) => (<path key={i} d={s.path} fill={s.color}><title>{s.label}: {formatCompact(s.value)} ({formatPercent(s.pct)})</title></path>))}
          </svg>
          <div className="pie-legend">
            {slices.map((s, i) => (
              <div key={i} className="pie-legend-item">
                <span className="pie-swatch" style={{ background: s.color }} />
                <span>{s.label}</span>
                <strong>{formatPercent(s.pct)}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (chart.type === "donut") {
    const total = chart.data.reduce((s, d) => s + d.value, 0);
    const R = 80, IR = 50, cx = 100, cy = 100;
    let cumAngle = 0;
    const slices = chart.data.map((d, i) => {
      const angle = (d.value / total) * 360;
      const startAngle = cumAngle;
      cumAngle += angle;
      const large = angle > 180 ? 1 : 0;
      const toRad = (deg: number) => (deg - 90) * Math.PI / 180;
      const ox1 = cx + R * Math.cos(toRad(startAngle)), oy1 = cy + R * Math.sin(toRad(startAngle));
      const ox2 = cx + R * Math.cos(toRad(cumAngle)), oy2 = cy + R * Math.sin(toRad(cumAngle));
      const ix2 = cx + IR * Math.cos(toRad(cumAngle)), iy2 = cy + IR * Math.sin(toRad(cumAngle));
      const ix1 = cx + IR * Math.cos(toRad(startAngle)), iy1 = cy + IR * Math.sin(toRad(startAngle));
      const path = `M ${ox1} ${oy1} A ${R} ${R} 0 ${large} 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${IR} ${IR} 0 ${large} 0 ${ix1} ${iy1} Z`;
      return { ...d, color: COLORS[i % COLORS.length], path, pct: d.value / total };
    });
    return (
      <div className="ai-chart ai-pie-chart">
        <h4>{chart.title}</h4>
        <div className="pie-layout">
          <svg viewBox="0 0 200 200" width="200" height="200">
            {slices.map((s, i) => (<path key={i} d={s.path} fill={s.color}><title>{s.label}: {formatCompact(s.value)} ({formatPercent(s.pct)})</title></path>))}
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize="14" fontWeight="700" fill="#1e293b">{formatCompact(total)}</text>
          </svg>
          <div className="pie-legend">
            {slices.map((s, i) => (
              <div key={i} className="pie-legend-item">
                <span className="pie-swatch" style={{ background: s.color }} />
                <span>{s.label}</span>
                <strong>{formatPercent(s.pct)}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (chart.type === "scatter") {
    const w = 500, h = 280, pad = 40;
    const groups = [...new Set(chart.data.map((d) => d.group ?? ""))];
    const values = chart.data.map((d) => d.value);
    const minV = Math.min(...values), maxV = Math.max(...values);
    const range = Math.max(maxV - minV, 1);
    const pts = chart.data.map((d, i) => ({
      x: pad + (i / Math.max(chart.data.length - 1, 1)) * (w - pad * 2),
      y: h - pad - ((d.value - minV) / range) * (h - pad * 2),
      ...d
    }));
    const showLabels = pts.length <= 15;
    return (
      <div className="ai-chart ai-scatter-chart">
        <h4>{chart.title}</h4>
        <svg viewBox={`0 0 ${w} ${h}`} role="img">
          <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e2e8f0" />
          <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="#e2e8f0" />
          {pts.map((p, i) => {
            const gIdx = groups.indexOf(p.group ?? "");
            return (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r="5" fill={COLORS[gIdx % COLORS.length]} opacity="0.7">
                  <title>{p.label}: {formatCompact(p.value)}{p.group ? ` (${p.group})` : ""}</title>
                </circle>
                {showLabels && (
                  <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize="8.5" fill="#334155" fontWeight="500">{formatCompact(p.value)}</text>
                )}
                {showLabels && pts.length <= 10 && (
                  <text x={p.x} y={h - pad + 13} textAnchor="middle" fontSize="7.5" fill="#94a3b8">{p.label.length > 10 ? p.label.slice(0, 9) + "…" : p.label}</text>
                )}
              </g>
            );
          })}
        </svg>
        {groups.length > 1 && groups[0] !== "" && (
          <div className="pie-legend">
            {groups.map((g, i) => (
              <div key={g} className="pie-legend-item">
                <span className="pie-swatch" style={{ background: COLORS[i % COLORS.length] }} />
                <span>{g}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (chart.type === "line" || chart.type === "area") {
    const w = 500, h = 240, pad = 36;
    const minV = Math.min(...chart.data.map((d) => d.value), 0);
    const range = Math.max(max - minV, 1);
    const pts = chart.data.map((d, i) => ({
      x: chart.data.length === 1 ? w / 2 : pad + (i / (chart.data.length - 1)) * (w - pad * 2),
      y: h - pad - ((d.value - minV) / range) * (h - pad * 2),
      ...d
    }));
    const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const areaPath = chart.type === "area" ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${h - pad} L ${pts[0].x.toFixed(1)} ${h - pad} Z` : "";
    const showAllLabels = pts.length <= 12;
    return (
      <div className="ai-chart ai-line-chart">
        <h4>{chart.title}</h4>
        <svg viewBox={`0 0 ${w} ${h}`} role="img">
          <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e2e8f0" />
          {chart.type === "area" && <path d={areaPath} fill={COLORS[0]} opacity="0.15" />}
          <path d={linePath} fill="none" stroke={COLORS[0]} strokeWidth="2.5" />
          {pts.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="4" fill={COLORS[0]}><title>{p.label}: {formatCompact(p.value)}</title></circle>
              {showAllLabels && <text x={p.x} y={p.y - 10} textAnchor="middle" fontSize="9" fill="#334155" fontWeight="600">{formatCompact(p.value)}</text>}
              {(i === 0 || i === pts.length - 1 || (showAllLabels && pts.length <= 8)) && (
                <text x={p.x} y={h - pad + 14} textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"} fontSize="8.5" fill="#64748b">{p.label}</text>
              )}
            </g>
          ))}
        </svg>
      </div>
    );
  }

  if (chart.type === "combo") {
    const w = 500, h = 260, pad = 40;
    const barData = chart.data.filter((d) => !d.group || d.group === "bar");
    const lineData = chart.data.filter((d) => d.group === "line");
    const useLineData = lineData.length > 0 ? lineData : barData;
    const barMax = Math.max(...barData.map((d) => d.value), 1);
    const lineMax = Math.max(...useLineData.map((d) => d.value), 1);
    const barW = barData.length > 0 ? Math.min((w - pad * 2) / barData.length - 4, 40) : 30;
    const pts = useLineData.map((d, i) => ({
      x: useLineData.length === 1 ? w / 2 : pad + 20 + (i / Math.max(useLineData.length - 1, 1)) * (w - pad * 2 - 40),
      y: h - pad - ((d.value / lineMax) * (h - pad * 2 - 10)),
      ...d
    }));
    const linePath = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    return (
      <div className="ai-chart ai-combo-chart">
        <h4>{chart.title}</h4>
        <svg viewBox={`0 0 ${w} ${h}`} role="img">
          <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e2e8f0" />
          <line x1={pad} y1={pad - 10} x2={pad} y2={h - pad} stroke="#e2e8f0" />
          {barData.map((d, i) => {
            const barH = (d.value / barMax) * (h - pad * 2 - 10);
            const x = pad + 20 + (i / Math.max(barData.length - 1, 1)) * (w - pad * 2 - 40) - barW / 2;
            return (
              <g key={`bar-${i}`}>
                <rect x={x} y={h - pad - barH} width={barW} height={barH} rx={3} fill={COLORS[0]} opacity={0.6}>
                  <title>{d.label}: {formatCompact(d.value)}</title>
                </rect>
                {barData.length <= 10 && (
                  <text x={x + barW / 2} y={h - pad + 14} textAnchor="middle" fontSize="8" fill="#64748b">{d.label.length > 8 ? d.label.slice(0, 7) + "…" : d.label}</text>
                )}
              </g>
            );
          })}
          <path d={linePath} fill="none" stroke={COLORS[1] || "#ef4444"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {pts.map((p, i) => (
            <g key={`pt-${i}`}>
              <circle cx={p.x} cy={p.y} r="4" fill={COLORS[1] || "#ef4444"}><title>{p.label}: {formatCompact(p.value)}</title></circle>
              {pts.length <= 10 && <text x={p.x} y={p.y - 10} textAnchor="middle" fontSize="9" fontWeight="600" fill="#334155">{formatCompact(p.value)}</text>}
            </g>
          ))}
        </svg>
      </div>
    );
  }

  if (chart.type === "waterfall") {
    const w = 500, h = 260, pad = 40;
    let running = 0;
    const segments = chart.data.map((d) => {
      const start = running;
      running += d.value;
      return { ...d, start, end: running };
    });
    const allVals = segments.flatMap((s) => [s.start, s.end]);
    const minV = Math.min(...allVals, 0);
    const maxV = Math.max(...allVals, 1);
    const range = Math.max(maxV - minV, 1);
    const barW = Math.min((w - pad * 2) / segments.length - 4, 50);
    const toY = (v: number) => h - pad - ((v - minV) / range) * (h - pad * 2 - 10);
    return (
      <div className="ai-chart ai-waterfall-chart">
        <h4>{chart.title}</h4>
        <svg viewBox={`0 0 ${w} ${h}`} role="img">
          <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e2e8f0" />
          {minV < 0 && <line x1={pad} y1={toY(0)} x2={w - pad} y2={toY(0)} stroke="#94a3b8" strokeDasharray="4 3" strokeWidth="1" />}
          {segments.map((s, i) => {
            const x = pad + 10 + i * ((w - pad * 2 - 20) / segments.length);
            const top = Math.min(toY(s.start), toY(s.end));
            const barH = Math.abs(toY(s.start) - toY(s.end));
            const isPositive = s.value >= 0;
            const isLast = i === segments.length - 1;
            return (
              <g key={i}>
                <rect x={x} y={top} width={barW} height={Math.max(barH, 2)} rx={3} fill={isLast ? COLORS[2] || "#7c3aed" : isPositive ? COLORS[0] : COLORS[3] || "#ef4444"}>
                  <title>{s.label}: {s.value >= 0 ? "+" : ""}{formatCompact(s.value)} (total: {formatCompact(s.end)})</title>
                </rect>
                <text x={x + barW / 2} y={top - 6} textAnchor="middle" fontSize="9" fontWeight="600" fill="#334155">{s.value >= 0 ? "+" : ""}{formatCompact(s.value)}</text>
                <text x={x + barW / 2} y={h - pad + 14} textAnchor="middle" fontSize="8" fill="#64748b">{s.label.length > 8 ? s.label.slice(0, 7) + "…" : s.label}</text>
                {i < segments.length - 1 && (
                  <line x1={x + barW} y1={toY(s.end)} x2={x + (w - pad * 2 - 20) / segments.length} y2={toY(s.end)} stroke="#cbd5e1" strokeDasharray="3 2" strokeWidth="1" />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  if (chart.type === "horizontal_bar") {
    const total = chart.data.reduce((s, d) => s + d.value, 0);
    return (
      <div className="ai-chart ai-bar-chart">
        <h4>{chart.title}</h4>
        {chart.data.slice(0, 20).map((d, i) => {
          const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : "0";
          return (
            <div key={i} className="horizontal-row">
              <div className="horizontal-label">
                <span>{d.label}</span>
                <strong>{formatCompact(d.value)} <span className="pct-label">({pct}%)</span></strong>
              </div>
              <div className="horizontal-track">
                <i style={{ width: `${Math.max((d.value / max) * 100, 3)}%`, background: COLORS[i % COLORS.length] }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (chart.type === "funnel") {
    const sorted = [...chart.data].sort((a, b) => b.value - a.value);
    const topVal = sorted[0]?.value || 1;
    const h = sorted.length * 44 + 20;
    const w = 400, cx = w / 2;
    return (
      <div className="ai-chart">
        <h4>{chart.title}</h4>
        <svg viewBox={`0 0 ${w} ${h}`} role="img">
          {sorted.map((d, i) => {
            const pct = d.value / topVal;
            const barW = Math.max(pct * (w - 60), 40);
            const y = 10 + i * 44;
            return (
              <g key={i}>
                <rect x={cx - barW / 2} y={y} width={barW} height={36} rx={6} fill={COLORS[i % COLORS.length]} opacity={1 - i * 0.08}>
                  <title>{d.label}: {formatCompact(d.value)}</title>
                </rect>
                <text x={cx} y={y + 22} textAnchor="middle" fontSize="11" fontWeight="700" fill="white">{d.label}: {formatCompact(d.value)}</text>
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  if (chart.type === "radar") {
    const n = chart.data.length;
    if (n < 3) return <div className="ai-chart"><h4>{chart.title}</h4><p className="muted">Radar chart needs at least 3 categories.</p></div>;
    const cx = 140, cy = 140, R = 110;
    const angleStep = (2 * Math.PI) / n;
    const maxVal = Math.max(...chart.data.map((d) => d.value), 1);
    const pts = chart.data.map((d, i) => {
      const a = -Math.PI / 2 + i * angleStep;
      const r = (d.value / maxVal) * R;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), lx: cx + (R + 16) * Math.cos(a), ly: cy + (R + 16) * Math.sin(a), ...d };
    });
    const polyPoints = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    return (
      <div className="ai-chart">
        <h4>{chart.title}</h4>
        <svg viewBox="0 0 280 280" role="img">
          {[0.25, 0.5, 0.75, 1].map((s) => (
            <polygon key={s} points={chart.data.map((_, i) => { const a = -Math.PI / 2 + i * angleStep; return `${(cx + s * R * Math.cos(a)).toFixed(1)},${(cy + s * R * Math.sin(a)).toFixed(1)}`; }).join(" ")} fill="none" stroke="#e2e8f0" strokeWidth="1" />
          ))}
          {chart.data.map((_, i) => { const a = -Math.PI / 2 + i * angleStep; return <line key={i} x1={cx} y1={cy} x2={cx + R * Math.cos(a)} y2={cy + R * Math.sin(a)} stroke="#e2e8f0" />; })}
          <polygon points={polyPoints} fill={COLORS[0]} fillOpacity="0.2" stroke={COLORS[0]} strokeWidth="2" />
          {pts.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r="4" fill={COLORS[0]}><title>{p.label}: {formatCompact(p.value)}</title></circle>
              <text x={p.lx} y={p.ly} textAnchor="middle" fontSize="8.5" fill="#475569">{p.label}</text>
              <text x={p.lx} y={p.ly + 11} textAnchor="middle" fontSize="8" fontWeight="600" fill="#1e293b">{formatCompact(p.value)}</text>
            </g>
          ))}
        </svg>
      </div>
    );
  }

  if (chart.type === "table" || chart.type === "pivot") {
    if (chart.type === "pivot" && chart.data.some((d) => d.group)) {
      const rowLabels = [...new Set(chart.data.map((d) => d.label))];
      const colLabels = [...new Set(chart.data.map((d) => d.group ?? ""))];
      return (
        <div className="ai-chart ai-pivot-table">
          <h4>{chart.title}</h4>
          <div className="pivot-scroll">
            <table>
              <thead><tr><th></th>{colLabels.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {rowLabels.map((row) => (
                  <tr key={row}>
                    <td><strong>{row}</strong></td>
                    {colLabels.map((col) => {
                      const cell = chart.data.find((d) => d.label === row && d.group === col);
                      return <td key={col}>{cell ? formatCompact(cell.value) : "—"}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    return (
      <div className="ai-chart ai-table-chart">
        <h4>{chart.title}</h4>
        <table>
          <thead><tr><th>Label</th><th>Value</th></tr></thead>
          <tbody>
            {chart.data.map((d, i) => (<tr key={i}><td>{d.label}</td><td><strong>{formatCompact(d.value)}</strong></td></tr>))}
          </tbody>
        </table>
      </div>
    );
  }

  // Default: bar chart
  return (
    <div className="ai-chart ai-bar-chart">
      <h4>{chart.title}</h4>
      {chart.data.slice(0, 20).map((d, i) => (
        <div key={i} className="horizontal-row">
          <div className="horizontal-label">
            <span>{d.label}</span>
            <strong>{formatCompact(d.value)}</strong>
          </div>
          <div className="horizontal-track">
            <i style={{ width: `${Math.max((d.value / max) * 100, 3)}%`, background: COLORS[i % COLORS.length] }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function computeCustomChartData(
  rows: Record<string, string>[],
  xCol: string,
  yCol: string,
  agg: string,
  groupCol: string,
  topN: number = 10
): ChartCommand["data"] {
  if (!xCol) return [];
  const limit = topN > 0 ? topN : 999;
  // Date/time x-axes must read chronologically and show every period — ranking by value
  // or truncating with "Show top N" would scramble or hide the timeline.
  const xIsDate = isDateColumn(rows, xCol);
  const dateKey = (s: string) => { const d = parseValidDate(s); return d ? d.getTime() : 0; };

  if (agg === "none") {
    return rows.slice(0, limit).map((row) => {
      const x = toNumber(row[xCol]);
      const y = toNumber(row[yCol]);
      return { label: String(Number.isFinite(x) ? x : 0), value: Number.isFinite(y) ? y : 0 };
    });
  }

  if (!yCol || yCol === "__count__") {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = cleanCategory(row[xCol] ?? "");
      if (key === INVALID_BUCKET) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const countEntries = [...counts.entries()];
    if (xIsDate) {
      return countEntries
        .sort((a, b) => dateKey(a[0]) - dateKey(b[0]))
        .map(([label, value]) => ({ label, value }));
    }
    return countEntries
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([label, value]) => ({ label, value }));
  }

  if (groupCol) {
    const groups = new Map<string, Map<string, number[]>>();
    for (const row of rows) {
      const x = cleanCategory(row[xCol] ?? "");
      const g = cleanCategory(row[groupCol] ?? "");
      const v = toNumber(row[yCol]);
      if (!Number.isFinite(v) || x === INVALID_BUCKET || g === INVALID_BUCKET) continue;
      if (!groups.has(x)) groups.set(x, new Map());
      const gMap = groups.get(x)!;
      if (!gMap.has(g)) gMap.set(g, []);
      gMap.get(g)!.push(v);
    }
    const xTotals = new Map<string, number>();
    for (const [x, gMap] of groups) {
      let total = 0;
      for (const vals of gMap.values()) total += vals.reduce((a, b) => a + b, 0);
      xTotals.set(x, total);
    }
    const topXKeys = xIsDate
      ? [...xTotals.keys()].sort((a, b) => dateKey(a) - dateKey(b))
      : [...xTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
    const result: ChartCommand["data"] = [];
    for (const x of topXKeys) {
      const gMap = groups.get(x)!;
      for (const [g, vals] of gMap) {
        const value = agg === "avg" ? vals.reduce((a, b) => a + b, 0) / vals.length
          : agg === "min" ? Math.min(...vals)
          : agg === "max" ? Math.max(...vals)
          : agg === "count" ? vals.length
          : vals.reduce((a, b) => a + b, 0);
        result.push({ label: x, value, group: g });
      }
    }
    return result;
  }

  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const key = cleanCategory(row[xCol] ?? "");
    const v = toNumber(row[yCol]);
    if (!Number.isFinite(v) || key === INVALID_BUCKET) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(v);
  }
  const bucketRows = [...buckets.entries()]
    .map(([label, vals]) => {
      const value = agg === "avg" ? vals.reduce((a, b) => a + b, 0) / vals.length
        : agg === "min" ? Math.min(...vals)
        : agg === "max" ? Math.max(...vals)
        : agg === "count" ? vals.length
        : vals.reduce((a, b) => a + b, 0);
      return { label, value };
    });
  if (xIsDate) {
    return bucketRows.sort((a, b) => dateKey(a.label) - dateKey(b.label));
  }
  return bucketRows
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

const AGG_TITLE_WORDS: Record<string, string> = { sum: "Total", avg: "Average", count: "Count of", min: "Min", max: "Max" };

// Builds a readable chart title without doubling words — e.g. a "sum" of a field already
// named "Total Spent" reads "Total Spent by …", not "Total Total Spent by …".
function buildCustomChartTitle(x: string, y: string, agg: string, group: string): string {
  const by = group ? `${x} and ${group}` : x;
  if (!y || y === "__count__") return `Count by ${by}`;
  const aggWord = AGG_TITLE_WORDS[agg] || agg;
  const yl = y.toLowerCase().trim();
  const al = aggWord.toLowerCase();
  let metric: string;
  if (yl.startsWith(al + " ") || yl === al) metric = y.trim();
  else if (agg === "sum" && /(^|\s)(total|amount|revenue|sales|spent|spend|gmv|value|income|cost|profit)(\s|$)/i.test(y)) metric = y.trim();
  else metric = `${aggWord} ${y.trim()}`;
  return `${metric} by ${by}`;
}

function createEmptyMapping(): Mapping {
  return {
    ignore: "",
    date: "",
    revenue: "",
    quantity: "",
    product: "",
    customer: "",
    region: "",
    cost: "",
    profit: "",
    discount: "",
    orderId: ""
  };
}

function createDefaultAISettings(): AISettings {
  return {
    provider: "openai",
    apiKey: "",
    model: "gpt-4o-mini"
  };
}

function loadStoredAISettings(): AISettings {
  return { ...createDefaultAISettings(), ...readJson<Partial<AISettings>>(STORAGE_KEYS.aiSettings, {}) };
}

function createDefaultReportSettings(): ReportSettings {
  return {
    title: TEMPLATE_TITLES.sales,
    company: "",
    currency: "USD",
    template: "sales",
    brandColor: "#2563eb"
  };
}

function loadStoredMapping(): Mapping {
  return { ...createEmptyMapping(), ...readJson<Partial<Mapping>>(STORAGE_KEYS.mapping, {}) };
}

function loadStoredReportSettings(): ReportSettings {
  return {
    ...createDefaultReportSettings(),
    ...readJson<Partial<ReportSettings>>(STORAGE_KEYS.reportSettings, {})
  };
}

function mergeStoredMapping(headers: string[], guessedMapping: Mapping): Mapping {
  const stored = loadStoredMapping();
  const next = { ...guessedMapping };
  for (const role of Object.keys(stored) as Role[]) {
    if (stored[role] && headers.includes(stored[role])) {
      next[role] = stored[role];
    }
  }
  // Re-apply aggregate revenue preference after stored override to prevent
  // per-unit columns (UnitPrice) from being used when a total column (NetAmount) exists
  const perUnit = /unitprice|priceeach|mrp|sellingprice|saleprice/i;
  if (next.revenue && perUnit.test(next.revenue.replace(/[\s_-]+/g, ""))) {
    const aggregate = headers.find((h) => {
      const n = h.toLowerCase().replace(/[\s_-]+/g, "");
      return /(net|total|sales|revenue|gross)/.test(n) && guessRole(h, "number") === "revenue";
    });
    if (aggregate) next.revenue = aggregate;
  }
  return next;
}

function hasReusableStoredMapping(headers: string[]) {
  const stored = loadStoredMapping();
  return (Object.keys(stored) as Role[]).some((role) => stored[role] && headers.includes(stored[role]));
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    if (!value) return fallback;
    const parsed = JSON.parse(value);
    if (Array.isArray(fallback)) return parsed as T;
    return { ...fallback, ...parsed } as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can fail in private browsing; the app should still work without persistence.
  }
}

async function parseUploadedFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!["csv", "xlsx", "xls"].includes(extension)) {
    throw new Error("Upload a CSV, XLSX, or XLS file.");
  }
  return extension === "csv" ? parseCsv(await file.text()) : await parseWorkbook(file);
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; headerWarning?: string } {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) records.push(row);

  return buildParsedFromGrid(records);
}

// Turn a raw cell grid into headers + row objects, first checking whether the genuine header
// row sits below title/branding lines (FIX 4). When it does, we use the detected header and
// attach a non-blocking warning instead of silently treating a title line as column names.
function buildParsedFromGrid(records: string[][]): {
  headers: string[];
  rows: Record<string, string>[];
  headerWarning?: string;
} {
  const detection = detectHeaderRow(records);
  const headerIdx = detection.firstRowIsHeader ? 0 : detection.headerIndex;
  const headers = dedupeHeaders((records[headerIdx] ?? []).map(String));
  const rows = records.slice(headerIdx + 1).map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, String(record[index] ?? "").trim()]))
  );
  const headerWarning = detection.firstRowIsHeader
    ? undefined
    : `The first ${headerIdx} row${headerIdx === 1 ? "" : "s"} look like a title or notes, not column names. Using row ${headerIdx + 1} (${headers.slice(0, 4).join(", ")}…) as the header.`;
  return headerWarning ? { headers, rows, headerWarning } : { headers, rows };
}

async function parseWorkbook(file: File): Promise<{ headers: string[]; rows: Record<string, string>[]; headerWarning?: string }> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet) {
    throw new Error("The workbook does not contain a readable sheet.");
  }
  const records = XLSX.utils
    .sheet_to_json<string[]>(firstSheet, { header: 1, defval: "" })
    .map((r) => (r ?? []).map(String));
  return buildParsedFromGrid(records);
}

function dedupeHeaders(headers: string[]) {
  const counts = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base} ${count + 1}`;
  });
}

function getDataQualitySummary(rows: Record<string, string>[]): DataQualitySummary {
  const seen = new Set<string>();
  let blankRows = 0;
  let duplicateRows = 0;
  let possibleSummaryRows = 0;

  for (const row of rows) {
    const values = Object.values(row).map((value) => value.trim());
    const normalized = values.join("|").toLowerCase();
    if (values.every((value) => value === "")) blankRows += 1;
    if (seen.has(normalized)) duplicateRows += 1;
    else seen.add(normalized);
    if (values.some((value) => /^(total|grand total|subtotal|summary)$/i.test(value))) {
      possibleSummaryRows += 1;
    }
  }

  return {
    totalRows: rows.length,
    blankRows,
    duplicateRows,
    possibleSummaryRows
  };
}

export function profileColumns(headers: string[], rows: Record<string, string>[]): ColumnProfile[] {
  return headers.map((name) => {
    const values = rows.map((row) => row[name] ?? "");
    const nonEmpty = values.filter((value) => value.trim() !== "");
    const type = detectType(nonEmpty);
    const guess = guessRole(name, type);
    const uniqueCount = new Set(nonEmpty).size;
    const nonEmptyCount = nonEmpty.length || 1;
    const cardinality = uniqueCount / nonEmptyCount;
    const polarity = inferPolarity(name);

    // Numeric stats
    let numSum = 0, numMean = 0, numMedian = 0, numStdDev = 0, numMin = 0, numMax = 0;
    let numSkewness = 0, numQ1 = 0, numQ3 = 0, numIqr = 0, numOutlierCount = 0, varianceScore = 0;
    if (type === "number" && nonEmpty.length > 0) {
      const nums = nonEmpty.map(toNumber).filter(Number.isFinite).sort((a, b) => a - b);
      if (nums.length > 0) {
        numSum = nums.reduce((a, b) => a + b, 0);
        numMean = numSum / nums.length;
        numMedian = nums[Math.floor(nums.length / 2)];
        numMin = nums[0];
        numMax = nums[nums.length - 1];
        const variance = nums.reduce((acc, v) => acc + (v - numMean) ** 2, 0) / nums.length;
        numStdDev = Math.sqrt(variance);
        varianceScore = numMean !== 0 ? numStdDev / Math.abs(numMean) : 0;
        // Quartiles
        numQ1 = nums[Math.floor(nums.length * 0.25)];
        numQ3 = nums[Math.floor(nums.length * 0.75)];
        numIqr = numQ3 - numQ1;
        numOutlierCount = nums.filter((v) => v < numQ1 - 1.5 * numIqr || v > numQ3 + 1.5 * numIqr).length;
        // Skewness (Fisher-Pearson)
        if (numStdDev > 0 && nums.length > 2) {
          const n = nums.length;
          numSkewness = (n / ((n - 1) * (n - 2))) * nums.reduce((acc, v) => acc + ((v - numMean) / numStdDev) ** 3, 0);
        }
      }
    }

    // Date stats
    let granularity: ColumnProfile["granularity"] = "unknown";
    let isMonotonic = false;
    if (type === "date" && nonEmpty.length > 1) {
      const dates = nonEmpty.map((v) => new Date(v).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
      if (dates.length > 1) {
        isMonotonic = dates.every((d, i) => i === 0 || d >= dates[i - 1]);
        const gaps = dates.slice(1).map((d, i) => d - dates[i]);
        const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        const day = 86400000;
        if (medianGap < day * 2) granularity = "daily";
        else if (medianGap < day * 10) granularity = "weekly";
        else if (medianGap < day * 45) granularity = "monthly";
        else if (medianGap < day * 120) granularity = "quarterly";
        else granularity = "yearly";
      }
    }

    // Categorical stats
    let dominantValue: ColumnProfile["dominantValue"] = null;
    let concentrationScore = 0;
    if (type === "text" && nonEmpty.length > 0) {
      const freq: Record<string, number> = {};
      for (const v of nonEmpty) freq[v] = (freq[v] || 0) + 1;
      const counts = Object.values(freq).sort((a, b) => b - a);
      const topValue = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      const topPct = topValue[1] / nonEmpty.length;
      if (topPct > 0.4) dominantValue = { value: topValue[0], pct: topPct };
      // Herfindahl index
      concentrationScore = counts.reduce((acc, c) => acc + (c / nonEmpty.length) ** 2, 0);
    }

    return {
      name,
      guess,
      confidence: guess === "ignore" ? 25 : 80,
      type,
      missing: values.length - nonEmpty.length,
      unique: uniqueCount,
      examples: nonEmpty.slice(0, 3),
      cardinality,
      polarity,
      sum: numSum,
      mean: numMean,
      median: numMedian,
      stdDev: numStdDev,
      min: numMin,
      max: numMax,
      skewness: numSkewness,
      q1: numQ1,
      q3: numQ3,
      iqr: numIqr,
      outlierCount: numOutlierCount,
      varianceScore,
      granularity,
      isMonotonic,
      dominantValue,
      concentrationScore,
    };
  });
}

export function detectType(values: string[]): ColumnProfile["type"] {
  if (values.length === 0) return "empty";
  const sample = values.slice(0, 20);
  const numberHits = sample.filter((value) => Number.isFinite(toNumber(value))).length;
  const dateHits = sample.filter((value) => !Number.isNaN(Date.parse(value))).length;
  if (dateHits / sample.length >= 0.7) return "date";
  if (numberHits / sample.length >= 0.7) return "number";
  return "text";
}

export function guessRole(name: string, type: ColumnProfile["type"]): Role {
  const normalized = name.toLowerCase().replace(/[_\s-]+/g, "");
  if (/(date|orderdate|saledate|transactiondate|invoicedate|inwarddate|dispatchdate|shipdate|deliverydate|created|released|published|started)/.test(normalized)) return "date";
  if (/^(time|day|month|year|quarter|period|yearof|yearofrelease)$/.test(normalized)) return "date";
  if (type === "date" && /^(time|day|month|year)$/.test(normalized)) return "date";
  if (/(revenue|sales|amount|net|totalamount|totalspent|totalrevenue|grossamt|grossamount|saleprice|sellingprice|unitprice|priceeach|mrp|price|income|earning|value|spend|globalsales|totalsales|netsales)/.test(normalized)) {
    return "revenue";
  }
  if (/(qty|quantity|quantityordered|quantitysold|orderquantity|pcs|units|hours)/.test(normalized)) return "quantity";
  if (/(product|item|sku|productline|productname|productcategory|subcategory|brand|carmake|carmodel|game|movie|book|course|campaign|title|servicename)/.test(normalized)) return "product";
  if (/^(name)$/.test(normalized)) return "product";
  if (/(customer|customername|client|buyer|salesperson|contactname|account|publisher|developer|author|vendor|supplier|company)/.test(normalized)) return "customer";
  if (/(region|city|country|county|area|territory|state|province|location|customerlocation|district|zone|market|platform|channel|source|department|genre|category|type)/.test(normalized)) return "region";
  if (/(cost|unitcost|cogs|totalcost|expense)/.test(normalized)) return "cost";
  if (/(profit|margin|commission|commissionearned)/.test(normalized)) return "profit";
  if (/(discount|rebate|discountapplied|discountpercentage)/.test(normalized)) return "discount";
  if (/(orderid|ordernumber|invoiceid|invoiceno|transactionid|receiptid)/.test(normalized)) return "orderId";
  if (type === "number" && !/(id|code|phone|zip|postal|weight|age|tax|shipping|count|rating|score)/.test(normalized)) return "revenue";
  return "ignore";
}

function inferPolarity(name: string): Polarity {
  const n = name.toLowerCase();
  if (/revenue|sales|profit|income|score|rating|growth|conversion|retention|quantity|units|orders|amount|total|gmv|arr|mrr/.test(n))
    return "higher_is_better";
  if (/cost|expense|churn|bounce|error|complaint|refund|return|debt|risk|loss|defect|discount|cogs|opex|capex/.test(n))
    return "higher_is_worse";
  return "neutral";
}

export function createMappingFromProfiles(profiles: ColumnProfile[]): Mapping {
  const mapping = createEmptyMapping();
  // Treat "_" and "-" as word boundaries so "product_id" / "Order ID" / "ship-postal-code" are
  // recognised as identifiers (the old \bid\b missed "product_id" because "_" is a word char).
  const isIdColumn = (name: string) => /(^|[\s_-])(id|code|zip|postal|index|row)s?([\s_-]|$)/i.test(name);
  // A human-readable label column ("product_name", "customer_name") — preferred over a cryptic id.
  const isNameColumn = (name: string) => /name/i.test(name);
  for (const profile of profiles) {
    if (profile.guess === "ignore") continue;
    const role = profile.guess;
    const cur = mapping[role];
    if (!cur) {
      mapping[role] = profile.name;
    } else if (role === "product" || role === "customer" || role === "region") {
      // Prefer a readable dimension: swap an id/code column for a non-id one, and swap a generic
      // column for a "*name*" label — so "product_id" becomes "product_name", not a cryptic SKU.
      const curIsId = isIdColumn(cur);
      const newIsId = isIdColumn(profile.name);
      if (curIsId && !newIsId) mapping[role] = profile.name;
      else if (!curIsId && !newIsId && !isNameColumn(cur) && isNameColumn(profile.name)) mapping[role] = profile.name;
    }
  }
  // Resolve the revenue column from SUMMABLE candidates only. A revenue-named column that is
  // actually text (e.g. "Sales Channel" = "Amazon.in") or an identifier/index must never be
  // summed as money — excluding them here is what stops the auto-map from picking a text column
  // over the real numeric amount. (detectType can mislabel large-integer numeric columns as
  // "date", so we exclude only genuine text, not "not-number".) We reassign even for a single
  // candidate, to override a text/id column the first pass may have latched onto.
  const numericRevCandidates = profiles.filter(
    (p) => p.guess === "revenue" && p.type !== "text" && !isIdColumn(p.name),
  );
  if (numericRevCandidates.length > 0) {
    const global = numericRevCandidates.find((p) => /(global|total|net|overall|grand)/i.test(p.name));
    const aggregate = numericRevCandidates.find((p) => /(sales|revenue|amount|gross|income)/i.test(p.name));
    const bySum = [...numericRevCandidates].sort((a, b) => b.sum - a.sum)[0];
    mapping.revenue = (global ?? aggregate ?? bySum).name;
  }
  return mapping;
}

function computeChartPreview(xCol: string, yCol: string, aggregation: string, rows: Record<string, string>[], limit: number): Array<{ label: string; value: number }> {
  if (!xCol || !yCol) return [];
  if (aggregation === "none") {
    return rows.slice(0, limit).map((r) => ({ label: r[xCol] || "", value: Number(r[yCol]) || 0 }));
  }
  const groups: Record<string, number[]> = {};
  for (const r of rows) {
    const key = r[xCol] || "(blank)";
    if (!groups[key]) groups[key] = [];
    if (yCol === "__count__") groups[key].push(1);
    else groups[key].push(Number(r[yCol]) || 0);
  }
  const agg = (vals: number[]): number => {
    if (aggregation === "avg") return vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    if (aggregation === "count") return vals.length;
    if (aggregation === "max") return Math.max(...vals);
    if (aggregation === "min") return Math.min(...vals);
    return vals.reduce((a, b) => a + b, 0);
  };
  return Object.entries(groups)
    .map(([label, vals]) => ({ label, value: agg(vals) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function getSmartChartKey(chart: SmartChartRecommendation): string {
  return `${chart.title}::${chart.question}`;
}

function resolveSmartChartData(chart: SmartChartRecommendation, analysis: Analysis): RankedItem[] | null {
  return chart.resolvedData
    ?? (chart.xRole === "date" ? analysis.periodRevenue
    : chart.xRole === "product" && chart.yRole === "profit" ? analysis.profitByProduct
    : chart.xRole === "product" ? analysis.productRevenue
    : chart.xRole === "region" ? analysis.regionRevenue
    : chart.xRole === "customer" ? analysis.customerRevenue
    : null);
}

function buildChartInsightSummary(question: string, items: RankedItem[]): ChartInsightSummary | null {
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.revenue, 0);
  const sorted = [...items].sort((a, b) => b.revenue - a.revenue);
  return {
    question,
    top3: sorted.slice(0, 3).map((item) => ({
      name: item.label,
      value: Number(item.revenue.toFixed(2)),
      pct_of_total: total > 0 ? Number(((item.revenue / total) * 100).toFixed(1)) : 0
    })),
    total_items: items.length,
    average_value: Number((total / items.length).toFixed(2))
  };
}

function generateAutoInsight(chart: SmartChartRecommendation, items: RankedItem[], currency: string): string {
  const templateInsight = chart.insights[0]?.text;
  if (templateInsight) return templateInsight;
  const summary = buildChartInsightSummary(chart.question, items);
  if (!summary || summary.top3.length === 0) return "";
  const top = summary.top3[0];
  const fmtVal = chart.isMoney === false ? (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : (v: number) => formatMoney(v, currency);
  return `${top.name} leads with ${fmtVal(top.value)} (${top.pct_of_total}% of total) across ${summary.total_items} items.`;
}

// Tie-aware description of a ranked distribution. When the top entries are within ~5% of each
// other it reports a near-tie ("~33% each") rather than crowning a false leader, and never
// prints a multiple below 1.1x ("1.0x more than" is meaningless).
function describeDistributionLead(items: { label: string; value: number }[], fmt: (v: number) => string): string {
  const sorted = [...items].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length === 0) return "";
  const top = sorted[0];
  const total = sorted.reduce((s, d) => s + d.value, 0);
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  const second = sorted[1];
  if (!second) return `${top.label} leads with ${fmt(top.value)} (${pct(top.value)}%)`;
  const mult = top.value / second.value;
  if (mult < 1.05) {
    const tied = sorted.filter((d) => top.value / d.value < 1.05);
    const names = tied.slice(0, 3).map((d) => d.label);
    return `${names.join(", ")} are nearly tied (~${pct(top.value)}% each)`;
  }
  if (mult < 1.1) return `${top.label} narrowly leads ${second.label} (${pct(top.value)}% vs ${pct(second.value)}%)`;
  return `${top.label} leads with ${fmt(top.value)} (${pct(top.value)}%) — ${mult.toFixed(1)}x ${second.label}`;
}

function recommendCharts(profiles: ColumnProfile[], analysis: Analysis, mapping: Mapping, currency: string, template?: ReportTemplate, extraMetrics: string[] = [], extraDimensions: string[] = [], rows: Record<string, string>[] = [], idColumns: string[] = []): SmartChartRecommendation[] {
  const charts: SmartChartRecommendation[] = [];
  const idSet = new Set(idColumns);
  const dateCol = profiles.find((p) => p.guess === "date" && p.isMonotonic);
  const revCols = profiles.filter((p) => p.guess === "revenue" && !idSet.has(p.name));
  const costCols = profiles.filter((p) => p.guess === "cost" && !idSet.has(p.name));
  const prodCol = profiles.find((p) => p.guess === "product");
  const custCol = profiles.find((p) => p.guess === "customer");
  const regionCol = profiles.find((p) => p.guess === "region");
  const mappedCols = new Set(Object.values(mapping).filter(Boolean));
  const allowedNums = new Set([...Array.from(mappedCols), ...extraMetrics].filter((c) => !idSet.has(c)));
  const numCols = profiles.filter((p) => p.type === "number" && p.guess !== "orderId" && allowedNums.has(p.name) && !idSet.has(p.name));
  const metric = analysis.primaryMetric;
  const cur = currency;
  const productLabel = getDimensionLabel("product", mapping, template);
  const customerLabel = getDimensionLabel("customer", mapping, template);
  const regionLabel = getDimensionLabel("region", mapping, template);
  // Primary-metric charts render money only when Analysis.isMoney; a units column (Global_Sales)
  // and a plain count both show bare numbers, never a currency symbol.
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, cur) : v.toLocaleString(undefined, { maximumFractionDigits: metric === "Count" ? 0 : 1 });

  // Q1: "What happened over time?" → Line chart
  if (dateCol && analysis.periodRevenue.length > 1) {
    const insights: SmartInsight[] = [];
    const series = analysis.periodRevenue;
    const peak = analysis.bestPeriod;
    const low = [...series].sort((a, b) => a.revenue - b.revenue)[0] ?? null;
    const first = series[0].revenue;
    const last = series[series.length - 1].revenue;
    const mean = series.reduce((s, p) => s + p.revenue, 0) / series.length;
    const maxV = Math.max(...series.map((p) => p.revenue));
    const minV = Math.min(...series.map((p) => p.revenue));
    const spread = mean > 0 ? (maxV - minV) / mean : 0;
    const overallChange = first > 0 ? ((last - first) / first) * 100 : 0;
    // Characterize the whole span, not just the last step — a flat series must read as flat,
    // never as "momentum". Only call it a trend when the full-span move is real.
    if (spread < 0.25 && Math.abs(overallChange) < 10) {
      insights.push({
        type: "trend",
        text: `${metric} held roughly steady across ${series.length} periods — ranging ${fmt(minV)}–${fmt(maxV)} (${Math.round(spread * 100)}% spread)`,
        importance: "high",
        sentiment: "neutral",
      });
    } else {
      const dir = overallChange >= 0 ? "up" : "down";
      const sentiment: SmartInsight["sentiment"] = template ? trendTone(overallChange, template) : (overallChange >= 0 ? "positive" : "negative");
      insights.push({
        type: "trend",
        text: `${metric} trended ${dir} ${formatPercent(overallChange)} from ${series[0].label} to ${series[series.length - 1].label}`,
        importance: "high",
        sentiment,
      });
    }
    if (peak) {
      insights.push({ type: "top_performer", text: `Peak: ${peak.label} at ${fmt(peak.revenue)}`, importance: "medium" });
    }
    if (low && peak && low.label !== peak.label) {
      insights.push({ type: "underperformers", text: `Lowest: ${low.label} at ${fmt(low.revenue)}`, importance: "low" });
    }
    charts.push({
      chartType: "line",
      title: `${metric} Over Time`,
      question: "What's the trend?",
      priority: 100,
      xRole: "date",
      yRole: "revenue",
      insights,
      annotations: ["peak", "trough", "trendline"],
      resolvedData: analysis.periodRevenue,
    });
  }

  // Q2: "What's driving the numbers?" → Product bar
  const realProducts = analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET);
  if (prodCol && realProducts.length > 0) {
    const identifiedRev = identifiedProductRevenue(analysis);
    const top = realProducts[0];
    const topPct = identifiedRev > 0 ? ((top.revenue / identifiedRev) * 100).toFixed(1) : "0";
    const insights: SmartInsight[] = [
      { type: "top_performer", text: `${top.label} leads with ${fmt(top.revenue)} (${topPct}% of identified product revenue)`, importance: "high" },
    ];
    if (realProducts.length >= 2) {
      const gap = top.revenue / (realProducts[1]?.revenue || 1);
      if (gap > 2) insights.push({ type: "gap", text: `${top.label} is ${gap.toFixed(1)}x larger than #2 (${realProducts[1].label})`, importance: "medium" });
    }
    const avg = identifiedRev / realProducts.length;
    const below = realProducts.filter((p) => p.revenue < avg);
    if (below.length > 0) {
      insights.push({ type: "underperformers", text: `${below.length} of ${realProducts.length} ${productLabel.toLowerCase()}s are below average (${fmt(avg)})`, importance: "medium" });
    }
    charts.push({
      chartType: "horizontal_bar",
      title: `${metric} by ${productLabel}`,
      question: `Which ${productLabel.toLowerCase()}s perform best?`,
      priority: 90,
      xRole: "product",
      yRole: "revenue",
      insights,
      annotations: ["average_line", "pct_of_total"],
      resolvedData: analysis.productRevenue,
    });
  }

  // Q3: "Where is the business?" → Region bar
  if (regionCol && realItems(analysis.regionRevenue).length > 0) {
    const realRegions = realItems(analysis.regionRevenue);
    const regionBase = identifiedTotal(analysis.regionRevenue, analysis.totalRevenue);
    const top = realRegions[0];
    const topPct = regionBase > 0 ? ((top.revenue / regionBase) * 100).toFixed(1) : "0";
    const insights: SmartInsight[] = [
      { type: "top_performer", text: `${top.label} leads at ${fmt(top.revenue)} (${topPct}% of identified ${regionLabel.toLowerCase()} revenue)`, importance: "high" },
    ];
    if (realRegions.length >= 2) {
      const ratio = top.revenue / (realRegions[realRegions.length - 1]?.revenue || 1);
      if (ratio > 2) insights.push({ type: "gap", text: `Top region outperforms lowest by ${ratio.toFixed(1)}x`, importance: "medium" });
    }
    charts.push({
      chartType: "horizontal_bar",
      title: `${metric} by ${regionLabel}`,
      question: `Which ${regionLabel.toLowerCase()}s lead?`,
      priority: 85,
      xRole: "region",
      yRole: "revenue",
      insights,
      annotations: ["average_line", "pct_of_total"],
      resolvedData: analysis.regionRevenue,
    });

    if (mapping.profit && mapping.region && rows.length > 0) {
      const profitByRegion = rankBy(
        rows.map((r) => ({ row: r, profit: toNumber(r[mapping.profit]) })).filter((r) => Number.isFinite(r.profit)),
        (item) => cleanCategory(item.row[mapping.region]),
        (item) => item.profit,
        true
      );
      if (profitByRegion.length > 0) {
        charts.push({
          chartType: "horizontal_bar",
          title: `Profit by ${regionLabel}`,
          question: `Which ${regionLabel.toLowerCase()}s are most profitable?`,
          priority: 72,
          xRole: "region",
          yRole: "profit",
          insights: [],
          annotations: ["zero_line"],
          resolvedData: profitByRegion,
        });
      }
    }
  }

  // Q4: "Who are the key customers?" → Pareto / Concentration
  if (custCol && realItems(analysis.customerRevenue).length >= 3) {
    const realCustomers = realItems(analysis.customerRevenue);
    const custBaseInsight = identifiedTotal(analysis.customerRevenue, analysis.totalRevenue);
    const top3 = realCustomers.slice(0, 3);
    const top3Pct = custBaseInsight > 0
      ? ((top3.reduce((s, c) => s + c.revenue, 0) / custBaseInsight) * 100).toFixed(0)
      : "0";
    const highRisk = Number(top3Pct) > 60;
    const insights: SmartInsight[] = [{
      type: "risk",
      text: highRisk
        ? `Top 3 ${customerLabel.toLowerCase()}s = ${top3Pct}% of total — high concentration risk`
        : `Top 3 ${customerLabel.toLowerCase()}s = ${top3Pct}% — healthy spread`,
      importance: "high",
      sentiment: highRisk ? "negative" : "positive",
    }];
    charts.push({
      chartType: "pareto",
      title: `${customerLabel} Concentration`,
      question: `How concentrated is ${metric.toLowerCase()}?`,
      priority: 80,
      xRole: "customer",
      yRole: "revenue",
      insights,
      annotations: ["pareto_line", "concentration_warning"],
      resolvedData: analysis.customerRevenue,
    });
  }

  // Q5: "Is the business profitable?" → Margin combo
  if (analysis.marginByProduct.length > 0) {
    const realMargin = realItems(analysis.marginByProduct);
    const worst = [...realMargin].sort((a, b) => a.revenue - b.revenue)[0];
    const insights: SmartInsight[] = [];
    if (worst && worst.revenue < 0) {
      insights.push({ type: "risk", text: `${worst.label} has negative margin (${fmt(worst.revenue)})`, importance: "high", sentiment: "negative" });
    }
    const best = realMargin[0];
    if (best) insights.push({ type: "top_performer", text: `Best margin: ${best.label} at ${fmt(best.revenue)}`, importance: "medium" });
    charts.push({
      chartType: "combo",
      title: `Margin by ${productLabel}`,
      question: `Where are margins strongest?`,
      priority: 75,
      xRole: "product",
      yRole: "profit",
      insights,
      annotations: ["low_margin_warning"],
      resolvedData: analysis.marginByProduct,
    });
  }

  // Q5b: "What's the ROI?" → ROI bar (when revenue + cost mapped)
  if (realItems(analysis.roiByProduct).length > 0) {
    const realRoi = realItems(analysis.roiByProduct);
    const best = realRoi[0];
    const worst = [...realRoi].sort((a, b) => a.revenue - b.revenue)[0];
    const insights: SmartInsight[] = [
      { type: "top_performer", text: `Best ROI: ${best.label} at ${best.revenue.toFixed(1)}%`, importance: "high" },
    ];
    if (worst && worst.revenue < 0) {
      insights.push({ type: "risk", text: `${worst.label} has negative ROI (${worst.revenue.toFixed(1)}%)`, importance: "high", sentiment: "negative" });
    }
    charts.push({
      chartType: "horizontal_bar",
      title: `ROI by ${productLabel}`,
      question: `Which ${productLabel.toLowerCase()}s have the best return?`,
      priority: template === "marketing" ? 95 : 70,
      xRole: "product",
      yRole: "revenue",
      insights,
      annotations: ["average_line", "zero_line"],
      resolvedData: analysis.roiByProduct,
    });
  }

  // Q5c: "Where is profit coming from?" → Profit bar with loss-makers
  // Use a granular dimension (8+ items) for meaningful profit breakdown
  if (mapping.profit && analysis.totalProfit !== null && rows.length > 0) {
    let profitData = analysis.profitByProduct;
    let profitDimLabel = productLabel;
    if (profitData.length < 8) {
      const candidates = [...extraDimensions, ...profiles.filter((p) => p.type === "text" && !idSet.has(p.name) && p.name !== mapping.product).map((p) => p.name)];
      for (const dim of candidates) {
        const uniqueVals = new Set(rows.map((r) => cleanCategory(r[dim])).filter((v) => v !== INVALID_BUCKET)).size;
        if (uniqueVals >= 8 && uniqueVals <= 200) {
          profitData = rankBy(
            rows.map((r) => ({ row: r, profit: toNumber(r[mapping.profit]) })).filter((r) => Number.isFinite(r.profit)),
            (item) => cleanCategory(item.row[dim]),
            (item) => item.profit,
            true
          );
          profitDimLabel = cleanColumnName(dim);
          break;
        }
      }
    }
    if (profitData.length > 0) {
      const lossMakers = profitData.filter((p) => p.revenue < 0);
      const best = profitData[0];
      const insights: SmartInsight[] = [];
      if (best) insights.push({ type: "top_performer", text: `${best.label} leads profit at ${fmt(best.revenue)}`, importance: "high" });
      if (lossMakers.length > 0) {
        const top3Loss = lossMakers.slice(-3).reverse();
        const lossNames = top3Loss.map((p) => `${p.label} (${fmt(p.revenue)})`).join(", ");
        insights.push({ type: "risk", text: `Loss-makers: ${lossNames} — investigate pricing or discounting`, importance: "high", sentiment: "negative" });
      }
      charts.push({
        chartType: "horizontal_bar",
        title: `Profit by ${profitDimLabel}`,
        question: `Which ${profitDimLabel.toLowerCase()}s make or lose money?`,
        priority: 78,
        xRole: "product",
        yRole: "profit",
        insights,
        annotations: ["zero_line", "loss_warning"],
        resolvedData: profitData,
      });
    }
  }

  // Q6: "How concentrated is the mix?" → share donut. Distinct lens from the Q2 ranked bar:
  // groups the long tail into "Other" and frames the insight as concentration, not magnitude,
  // so it doesn't restate the same ranked list as the bar chart.
  const realProductsComp = analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET);
  if (realProductsComp.length >= 2 && realProductsComp.length <= 8) {
    const identifiedRev = identifiedProductRevenue(analysis);
    const TOP = 5;
    const topItems = realProductsComp.slice(0, TOP);
    const rest = realProductsComp.slice(TOP);
    const otherSum = rest.reduce((s, p) => s + p.revenue, 0);
    const compData: RankedItem[] = otherSum > 0
      ? [...topItems, { label: `Other (${rest.length})`, revenue: otherSum }]
      : realProductsComp;
    const topConcPct = identifiedRev > 0 ? ((topItems.reduce((s, p) => s + p.revenue, 0) / identifiedRev) * 100).toFixed(0) : "0";
    const insights: SmartInsight[] = [
      { type: "headline", text: `Top ${topItems.length} ${productLabel.toLowerCase()}s make up ${topConcPct}% of identified product ${metric.toLowerCase()}`, importance: "medium" },
    ];
    charts.push({
      chartType: "donut",
      title: `${metric} Share`,
      question: `How concentrated is ${metric.toLowerCase()}?`,
      priority: 60,
      xRole: "product",
      yRole: "revenue",
      insights,
      annotations: ["center_total", "dominant_slice"],
      resolvedData: compData,
    });
  }

  // Q7: "Are there relationships?" → Scatter (if 2+ numeric cols)
  if (numCols.length >= 2 && analysis.rowCount >= 10) {
    const pairs: { a: ColumnProfile; b: ColumnProfile; corr: number }[] = [];
    for (let i = 0; i < Math.min(numCols.length, 5); i++) {
      for (let j = i + 1; j < Math.min(numCols.length, 5); j++) {
        const corr = numCols[i].varianceScore > 0 && numCols[j].varianceScore > 0
          ? Math.abs(numCols[i].varianceScore - numCols[j].varianceScore) < 2 ? 0.5 : 0.2
          : 0;
        if (corr > 0.3) pairs.push({ a: numCols[i], b: numCols[j], corr });
      }
    }
    if (pairs.length > 0) {
      const best = pairs.sort((a, b) => b.corr - a.corr)[0];
      charts.push({
        chartType: "scatter",
        title: `${best.a.name} vs ${best.b.name}`,
        question: "Is there a relationship?",
        priority: 50,
        xRole: (best.a.guess || "revenue") as Role,
        yRole: (best.b.guess || "cost") as Role,
        insights: [{ type: "headline", text: `Exploring correlation between ${best.a.name} and ${best.b.name}`, importance: "low" }],
        annotations: ["trendline"],
      });
    }
  }

  // Q8: Charts for user-selected additional metrics (by primary dimension)
  if (rows.length > 0) {
    const dimCol = mapping.product || mapping.region || mapping.customer || "";
    for (const col of extraMetrics) {
      if (col === mapping.revenue || col === mapping.cost || col === mapping.profit || idSet.has(col)) continue;
      const label = cleanColumnName(col);
      const useAvg = isRateColumn(col);
      const colIsMoney = /revenue|sales|amount|price|cost|profit|income|earning|spend|fee|tax|shipping/i.test(col) && !columnIsUnitsMetric(col, mapping, profiles);
      if (dimCol) {
        const groups: Record<string, number[]> = {};
        let excludedSum = 0;
        for (const row of rows) {
          const dim = cleanCategory(row[dimCol]);
          const val = parseFloat(row[col]);
          if (isNaN(val)) continue;
          if (dim === INVALID_BUCKET) excludedSum += val;
          else (groups[dim] ??= []).push(val);
        }
        const data: RankedItem[] = Object.entries(groups)
          .map(([k, vals]) => ({
            label: k,
            revenue: useAvg ? vals.reduce((s, v) => s + v, 0) / vals.length : vals.reduce((s, v) => s + v, 0),
          }))
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 10);
        if (data.length > 0) {
          const prefix = useAvg ? "Avg" : "Total";
          const dimNoun = cleanColumnName(dimCol).toLowerCase();
          const fmtUnits = (v: number) => colIsMoney ? formatMoney(v, currency) : v.toLocaleString(undefined, { maximumFractionDigits: useAvg ? 1 : 0 });
          // Sum metrics: append the junk bucket so the chart shows the standard excluded note
          // and the headline gap to the grand-total KPI is explained.
          const resolvedData = !useAvg && excludedSum > 0 ? [...data, { label: INVALID_BUCKET, revenue: excludedSum }] : data;
          charts.push({
            chartType: "horizontal_bar",
            title: `${prefix} ${label} by ${cleanColumnName(dimCol)}`,
            question: `How does ${label.toLowerCase()} vary across ${dimNoun}?`,
            priority: 45,
            xRole: "product" as Role,
            yRole: "revenue" as Role,
            insights: [{ type: "headline" as const, text: `${data[0].label} leads with ${fmtUnits(data[0].revenue)}${colIsMoney ? "" : " " + label.toLowerCase()} across ${data.length} ${dimNoun}s`, importance: "medium" as const }],
            annotations: ["average_line"],
            resolvedData,
            isMoney: colIsMoney,
            isAverage: useAvg,
          });
        }
      }
    }

    // Q9: Charts for user-selected additional dimensions (primary metric by that dimension)
    const metricCol = mapping.revenue || mapping.quantity || mapping.cost || "";
    for (const col of extraDimensions) {
      if (!metricCol) continue;
      const label = cleanColumnName(col);
      const groups: Record<string, number> = {};
      for (const row of rows) {
        const dim = cleanCategory(row[col]);
        const val = parseFloat(row[metricCol]);
        if (dim !== INVALID_BUCKET && !isNaN(val)) {
          groups[dim] = (groups[dim] || 0) + val;
        }
      }
      const data: RankedItem[] = Object.entries(groups)
        .map(([k, v]) => ({ label: k, revenue: v }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      if (data.length >= 2) {
        charts.push({
          chartType: data.length <= 6 ? "donut" : "horizontal_bar",
          title: `${metric} by ${label}`,
          question: `How is ${metric.toLowerCase()} distributed across ${label.toLowerCase()}?`,
          priority: 40,
          xRole: "product" as Role,
          yRole: "revenue" as Role,
          insights: [{ type: "headline" as const, text: `${describeDistributionLead(data.map((d) => ({ label: d.label, value: d.revenue })), fmt)} across ${data.length} ${label.toLowerCase()} values`, importance: "medium" as const }],
          annotations: ["pct_of_total"],
          resolvedData: data,
        });
      }
    }
  }

  return ensureVariety(charts);
}

function ensureVariety(suggestions: SmartChartRecommendation[]): SmartChartRecommendation[] {
  const sorted = suggestions.sort((a, b) => b.priority - a.priority);
  const selected: SmartChartRecommendation[] = [];
  const usedTypes = new Set<string>();
  const usedYRoles = new Set<string>();

  for (const s of sorted) {
    if (usedTypes.has(s.chartType) && selected.length < 4) continue;
    if (usedYRoles.has(s.yRole) && selected.length < 3) continue;
    selected.push(s);
    usedTypes.add(s.chartType);
    usedYRoles.add(s.yRole);
    if (selected.length >= 5) break;
  }

  if (selected.length < 5) {
    for (const s of sorted) {
      if (!selected.includes(s)) { selected.push(s); if (selected.length >= 5) break; }
    }
  }
  return selected;
}

function generateTypeBasedSuggestions(profiles: ColumnProfile[], analysis: Analysis, currency: string): SmartChartRecommendation[] {
  const dateCols = profiles.filter((p) => p.type === "date");
  const numCols = profiles.filter((p) => p.type === "number" && p.guess !== "orderId");
  const catCols = profiles.filter((p) => p.type === "text" && p.unique >= 2 && p.unique <= 50);
  const charts: SmartChartRecommendation[] = [];

  if (dateCols.length > 0 && numCols.length > 0) {
    charts.push({
      chartType: "line", title: `${numCols[0].name} over time`, question: `How does ${numCols[0].name} change?`,
      priority: 90, xRole: "date" as Role, yRole: "revenue" as Role, insights: [], annotations: ["trendline"],
    });
  }
  if (catCols.length > 0 && numCols.length > 0) {
    charts.push({
      chartType: "horizontal_bar", title: `${numCols[0].name} by ${catCols[0].name}`, question: `How does ${numCols[0].name} break down?`,
      priority: 85, xRole: "product" as Role, yRole: "revenue" as Role, insights: [], annotations: ["average_line"],
    });
  }
  if (catCols.length > 0) {
    const smallCat = catCols.find((c) => c.unique <= 8) || catCols[0];
    charts.push({
      chartType: "donut", title: `Distribution of ${smallCat.name}`, question: `What's the breakdown of ${smallCat.name}?`,
      priority: 75, xRole: "product" as Role, yRole: "revenue" as Role, insights: [], annotations: [],
    });
  }
  if (numCols.length >= 2) {
    charts.push({
      chartType: "scatter", title: `${numCols[0].name} vs ${numCols[1].name}`, question: "Is there a relationship?",
      priority: 70, xRole: "revenue" as Role, yRole: "cost" as Role, insights: [], annotations: ["trendline"],
    });
  }
  if (catCols.length > 0) {
    const cat = [...catCols].sort((a, b) => b.unique - a.unique)[0];
    charts.push({
      chartType: "horizontal_bar", title: `Most common ${cat.name}`, question: `Which ${cat.name} appears most?`,
      priority: 65, xRole: "product" as Role, yRole: "quantity" as Role, insights: [], annotations: [],
    });
  }
  return charts;
}

function generateUniversalSuggestions(profiles: ColumnProfile[]): SmartChartRecommendation[] {
  const first = profiles[0];
  if (!first) return [];
  return [{
    chartType: "horizontal_bar", title: `Top ${first.name} values`, question: `What appears most in ${first.name}?`,
    priority: 45, xRole: "product" as Role, yRole: "quantity" as Role, insights: [], annotations: [],
  }];
}

function getChartBuilderSuggestions(profiles: ColumnProfile[], analysis: Analysis, mapping: Mapping, currency: string): SmartChartRecommendation[] {
  let suggestions = recommendCharts(profiles, analysis, mapping, currency);
  if (suggestions.length < 3) {
    const typeBased = generateTypeBasedSuggestions(profiles, analysis, currency);
    const existing = new Set(suggestions.map((s) => `${s.chartType}-${s.xRole}-${s.yRole}`));
    for (const t of typeBased) {
      if (!existing.has(`${t.chartType}-${t.xRole}-${t.yRole}`)) suggestions.push(t);
    }
  }
  if (suggestions.length < 2) {
    suggestions = [...suggestions, ...generateUniversalSuggestions(profiles)];
  }
  return ensureVariety(suggestions);
}

function getMappedRoles(mapping: Mapping) {
  return (Object.keys(mapping) as Role[])
    .filter((role) => role !== "ignore" && mapping[role])
    .map((role) => ({ role, column: mapping[role] }));
}

function getDataQualityNotes(dataSet: DataSet, analysis: Analysis) {
  const notes: string[] = [];
  const totalRows = dataSet.rows.length;
  const unusableRows = totalRows - analysis.rowCount;
  const missingColumns = dataSet.profiles.filter((profile) => profile.missing > 0);

  notes.push(`${analysis.rowCount.toLocaleString()} of ${totalRows.toLocaleString()} rows were usable for revenue analysis.`);

  if (unusableRows > 0) {
    notes.push(`${unusableRows.toLocaleString()} rows were skipped because the mapped date or revenue value could not be read.`);
  }

  if (missingColumns.length > 0) {
    notes.push(
      `${missingColumns.length.toLocaleString()} columns contain missing values; review them before sending a final report.`
    );
  } else {
    notes.push("No missing values were detected in the imported columns.");
  }

  if (dataSet.quality.duplicateRows > 0) {
    notes.push(`${dataSet.quality.duplicateRows.toLocaleString()} possible duplicate rows were found.`);
  }

  if (dataSet.quality.possibleSummaryRows > 0) {
    notes.push(
      `${dataSet.quality.possibleSummaryRows.toLocaleString()} possible total or summary rows were detected.`
    );
  }

  notes.push("Column roles are based on automatic guesses and the current user-confirmed mapping.");
  return notes;
}

function calculateTrustScore(dataSet: DataSet, analysis: Analysis): TrustScore {
  const totalRows = Math.max(dataSet.rows.length, 1);
  const skippedRows = dataSet.rows.length - analysis.rowCount;
  const missingColumns = dataSet.profiles.filter((profile) => profile.missing > 0).length;
  const penalty =
    (skippedRows / totalRows) * 45 +
    (dataSet.quality.duplicateRows / totalRows) * 20 +
    (dataSet.quality.possibleSummaryRows / totalRows) * 25 +
    Math.min(missingColumns * 3, 15);
  const score = Math.max(0, Math.round(100 - penalty));
  const label = score >= 85 ? "High" : score >= 65 ? "Medium" : "Needs review";
  const detail =
    label === "High"
      ? "This file looks clean enough for a manager-ready report."
      : label === "Medium"
        ? "This file is usable, but review the quality notes before sharing."
        : "Review skipped rows, duplicates, summary rows, and missing values before using this report.";
  return { score, label, detail };
}

export function computeRFM(rows: Record<string, string>[], customerCol: string, dateCol: string, revenueCol: string): CustomerHealth[] {
  if (!customerCol || !dateCol || !revenueCol) return [];

  // FIX 2 — consume the shared canonical row set and the shared parsers (toNumber/parseValidDate),
  // not parseFloat/new Date, so RFM's row base is identical to analyzeData's and findings'.
  const customerMap = new Map<string, { dates: number[]; total: number; count: number }>();
  for (const row of rows) {
    const name = (row[customerCol] ?? "").trim();
    if (!name || isInvalidCategory(name)) continue;
    const parsedDate = parseValidDate(row[dateCol]);
    const revRaw = toNumber(row[revenueCol]);
    const rev = Number.isFinite(revRaw) ? revRaw : 0;
    if (!customerMap.has(name)) customerMap.set(name, { dates: [], total: 0, count: 0 });
    const entry = customerMap.get(name)!;
    if (parsedDate) entry.dates.push(parsedDate.getTime());
    entry.total += rev;
    entry.count += 1;
  }

  if (customerMap.size < 3) return [];

  const allDates = [...customerMap.values()].flatMap((e) => e.dates);
  const maxDate = allDates.length > 0 ? Math.max(...allDates) : Date.now();
  const dayMs = 86400000;

  const customers = [...customerMap.entries()].map(([name, data]) => {
    const lastDate = data.dates.length > 0 ? Math.max(...data.dates) : 0;
    const recency = lastDate > 0 ? Math.round((maxDate - lastDate) / dayMs) : 9999;
    return {
      name,
      lastPurchaseDate: lastDate > 0 ? new Date(lastDate).toISOString() : null,
      transactionCount: data.count,
      totalRevenue: data.total,
      recency,
      frequency: data.count,
      monetary: data.total
    };
  });

  // Assign quintile scores (1-5)
  const assignScores = (values: number[], higherIsBetter: boolean): number[] => {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    return values.map((v) => {
      const rank = sorted.indexOf(v) / Math.max(n - 1, 1);
      const score = Math.ceil(rank * 5) || 1;
      return higherIsBetter ? score : 6 - score;
    });
  };

  const rScores = assignScores(customers.map((c) => c.recency), false);
  const fScores = assignScores(customers.map((c) => c.frequency), true);
  const mScores = assignScores(customers.map((c) => c.monetary), true);

  const mapSegment = (r: number, f: number, m: number): RFMSegment => {
    if (r >= 4 && f >= 4 && m >= 4) return "Champion";
    if (r >= 3 && f >= 3 && m >= 3) return "Loyal";
    if (r >= 4 && f <= 2) return "New";
    if (r <= 2 && f >= 3 && m >= 3) return "At Risk";
    if (r <= 2 && f >= 2) return "Slipping";
    if (r <= 1 && f <= 2) return "Lost";
    return "Potential";
  };

  return customers.map((c, i) => ({
    ...c,
    rScore: rScores[i],
    fScore: fScores[i],
    mScore: mScores[i],
    segment: mapSegment(rScores[i], fScores[i], mScores[i]),
  }));
}

function formatLastPurchase(recency: number): string {
  if (recency === 9999) return "Unknown";
  if (recency <= 0) return "0 days ago";
  const label = `${recency} day${recency === 1 ? "" : "s"} ago`;
  return recency > 90 ? `${label} ⚠️` : label;
}

function computeABC(items: RankedItem[]): { label: string; revenue: number; pct: number; cumPct: number; tier: "A" | "B" | "C" }[] {
  if (items.length === 0) return [];
  const total = items.reduce((s, i) => s + i.revenue, 0);
  if (total === 0) return [];
  const sorted = [...items].sort((a, b) => b.revenue - a.revenue);
  let cumulative = 0;
  return sorted.map((item) => {
    cumulative += item.revenue;
    const pct = item.revenue / total;
    const cumPct = cumulative / total;
    const tier: "A" | "B" | "C" = cumPct <= 0.8 ? "A" : cumPct <= 0.95 ? "B" : "C";
    return { label: item.label, revenue: item.revenue, pct, cumPct, tier };
  });
}

function computeForecast(periodRevenue: RankedItem[], periods = 3, seasonalAllowed = true): ForecastResult | null {
  const values = periodRevenue.map((p) => p.revenue);
  const n = values.length;
  if (n < 3) return null;

  // Linear regression
  const sumX = values.reduce((s, _, i) => s + i, 0);
  const sumY = values.reduce((s, v) => s + v, 0);
  const sumXY = values.reduce((s, v, i) => s + i * v, 0);
  const sumX2 = values.reduce((s, _, i) => s + i * i, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  const linearPred = (i: number) => intercept + slope * i;

  // R-squared for linear
  const yMean = sumY / n;
  const ssTot = values.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = values.reduce((s, v, i) => s + (v - linearPred(i)) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Exponential smoothing (Holt's double exponential)
  const alpha = 0.4;
  const beta = 0.2;
  let level = values[0];
  let trend = values.length > 1 ? values[1] - values[0] : 0;
  const emaPred: number[] = [level];
  for (let i = 1; i < n; i++) {
    const prevLevel = level;
    level = alpha * values[i] + (1 - alpha) * (prevLevel + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    emaPred.push(level + trend);
  }
  const emaError = values.reduce((s, v, i) => s + Math.abs(v - emaPred[i]) / Math.max(Math.abs(v), 1), 0) / n;

  // Seasonal naive (only if n >= 6 AND the seasonality verdict confirms a real month/weekday
  // pattern — otherwise the forecast must not present itself as "Seasonal pattern").
  const seasonLen = seasonalAllowed ? (n >= 12 ? 12 : n >= 6 ? Math.min(n, 6) : 0) : 0;
  let seasonalError = Infinity;
  const seasonPred: number[] = [...values];
  if (seasonLen > 0) {
    for (let i = seasonLen; i < n; i++) {
      seasonPred[i] = values[i - seasonLen] + (slope * seasonLen);
    }
    seasonalError = values.slice(seasonLen).reduce((s, v, i) =>
      s + Math.abs(v - seasonPred[i + seasonLen]) / Math.max(Math.abs(v), 1), 0
    ) / Math.max(n - seasonLen, 1);
  }

  // Linear MAPE on last 3
  const testStart = Math.max(0, n - 3);
  const linearError = values.slice(testStart).reduce((s, v, i) =>
    s + Math.abs(v - linearPred(testStart + i)) / Math.max(Math.abs(v), 1), 0
  ) / Math.min(3, n);

  // Pick best method
  type Method = "linear" | "exponential" | "seasonal";
  const errors: [Method, number][] = [["linear", linearError], ["exponential", emaError]];
  if (seasonLen > 0) errors.push(["seasonal", seasonalError]);
  errors.sort((a, b) => a[1] - b[1]);
  const bestMethod = errors[0][0];

  // Standard error for confidence band
  const residuals = values.map((v, i) => v - linearPred(i));
  const stdErr = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(n - 2, 1));

  // Generate predictions
  const predictions: ForecastResult["predictions"] = [];
  const lastLabel = periodRevenue[n - 1].label;
  for (let p = 1; p <= periods; p++) {
    const idx = n - 1 + p;
    let value: number;
    if (bestMethod === "linear") {
      value = linearPred(idx);
    } else if (bestMethod === "exponential") {
      value = level + trend * p;
    } else {
      const baseIdx = idx - seasonLen;
      value = (baseIdx >= 0 && baseIdx < n ? values[baseIdx] : values[n - 1]) + slope * p;
    }
    const bandWidth = stdErr * 1.96 * Math.sqrt(p);
    predictions.push({
      label: `${lastLabel}+${p}`,
      value: Math.max(0, value),
      lower: Math.max(0, value - bandWidth),
      upper: value + bandWidth,
    });
  }

  const confidence: ForecastResult["confidence"] = n >= 12 && r2 > 0.7 ? "High" : n >= 6 ? "Medium" : "Low";

  return { method: bestMethod, predictions, confidence, trend: slope, r2 };
}

// True when a column is predominantly parseable dates (not pure numbers, which are
// quantities/ids). Used so date/time x-axes render chronologically rather than ranked.
function isDateColumn(rows: Record<string, string>[], col: string): boolean {
  if (!col) return false;
  let nonEmpty = 0;
  let dated = 0;
  for (const row of rows) {
    const raw = row[col];
    if (raw == null || String(raw).trim() === "") continue;
    nonEmpty++;
    const t = String(raw).trim();
    if (!/^\d+(\.\d+)?$/.test(t) && parseValidDate(t)) dated++;
    if (nonEmpty >= 60) break;
  }
  return nonEmpty >= 3 && dated / nonEmpty >= 0.8;
}

// True when the period series is essentially flat across its full span — small peak-to-trough
// spread AND a small start-to-end move. Used to suppress "momentum"/"upward trend" framing that
// a single +N% period-over-period step would otherwise trigger.
function isTrendFlat(analysis: Analysis): boolean {
  const series = analysis.periodRevenue;
  if (series.length < 2) return true;
  const mean = series.reduce((s, p) => s + p.revenue, 0) / series.length;
  if (mean <= 0) return true;
  const maxV = Math.max(...series.map((p) => p.revenue));
  const minV = Math.min(...series.map((p) => p.revenue));
  const spread = (maxV - minV) / mean;
  const first = series[0].revenue;
  const last = series[series.length - 1].revenue;
  const overall = first > 0 ? Math.abs((last - first) / first) * 100 : 0;
  return spread < 0.25 && overall < 10;
}

// The last-vs-prior period change is only a meaningful signal when the final period is
// complete. A truncated final month shows an artificial "drop" that is purely truncation, so
// when findings say the latest period is partial NO surface may narrate that change as a
// trend / decline / growth. Returns the user-facing note to show instead, or null when the
// change is safe to narrate normally.
function partialPeriodNote(findings?: Findings | null): string | null {
  if (!findings?.latestPeriodPartial) return null;
  const cov = findings.periodCompleteness.lastEvidence?.coverage ?? 0;
  return `latest period incomplete (~${Math.round(cov * 100)}% of a typical period) — not comparable`;
}

// Whether the last-vs-prior change may be narrated directionally at all (i.e. the final
// period is complete). When false, callers must fall back to partialPeriodNote().
function latestChangeComparable(findings?: Findings | null): boolean {
  return !findings?.latestPeriodPartial;
}

// Rows actually used by a chart: valid date (if mapped) AND a populated numeric value, and — for
// a dimension breakdown — a non-junk category value. Mirrors analyzeData's validRows filter.
function countAnalyzedRows(rows: Record<string, string>[], mapping: Mapping, dimCol?: string): number {
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  const dayFirst = mapping.date ? inferDayFirst(rows, mapping.date) : undefined;
  let n = 0;
  for (const row of rows) {
    if (valueCol && !hasNumericValue(row[valueCol])) continue;
    if (mapping.date && !parseValidDate(row[mapping.date], dayFirst)) continue;
    if (dimCol && cleanCategory(row[dimCol] ?? "") === INVALID_BUCKET) continue;
    n++;
  }
  return n;
}

// FIX 1 — Revenue confidence gate. The hero total and every downstream metric must NOT be
// computed when we can't confirm the mapped revenue column actually holds row-level revenue
// amounts. Two failure shapes both warrant a refuse-and-disclose (never guess-and-hide):
//   (a) revenue mapped onto a non-numeric/text column — nothing summable lives there;
//   (b) the column looks like a per-UNIT price (doesn't scale with quantity) — summing it
//       would silently overstate/understate the total.
// Returns ok:true (with the confirmed column, or null when no revenue is mapped) or a refusal
// naming the column and the reason so the UI can prompt for confirmation instead of charting a
// wrong number.
export type RevenueAssessment =
  | { ok: true; column: string | null }
  | { ok: false; column: string; reason: "non-numeric" | "per-unit-price"; detail: string };

export function assessRevenueColumn(
  rows: Record<string, string>[],
  mapping: Mapping,
): RevenueAssessment {
  const col = mapping.revenue;
  if (!col) return { ok: true, column: null };

  // (a) Genuinely non-numeric: the column holds no summable amounts. We test the ACTUAL cell
  // content rather than the profiler's type guess — detectType can mislabel large integer
  // prices/ids as "date", which would produce a false "this is a date column" disclosure.
  let nonEmpty = 0;
  let numeric = 0;
  const sampleLimit = Math.min(rows.length, 1000);
  for (let i = 0; i < sampleLimit; i++) {
    const cell = rows[i]?.[col];
    if (cell && cell.trim() !== "") {
      nonEmpty += 1;
      if (hasNumericValue(cell)) numeric += 1;
    }
  }
  if (nonEmpty > 0 && numeric / nonEmpty < 0.5) {
    return {
      ok: false,
      column: col,
      reason: "non-numeric",
      detail: `"${col}" doesn't contain numbers we can sum (only ${((numeric / nonEmpty) * 100).toFixed(0)}% of its values are numeric) — it can't be a revenue total. Pick the column that holds the line-item amount.`,
    };
  }

  if (mapping.quantity) {
    const check = looksLikePerUnitPrice(rows, col, mapping.quantity);
    if (check.likely) {
      return {
        ok: false,
        column: col,
        reason: "per-unit-price",
        detail: `"${col}" looks like a per-unit price, not a line total — it doesn't scale with "${mapping.quantity}" (correlation ${check.correlation.toFixed(2)}). Summing it would misstate revenue; multiply price × quantity, or pick the column that already holds the line total.`,
      };
    }
  }

  return { ok: true, column: col };
}

// FIX 4 — the ledger half of the audit gate. `buildAuditProfile` (auditAdapter) supplies the
// column/period PROFILE; this supplies the faithful LedgerFinding[] of the numbers the report
// actually renders, tagged with the integrity metadata the C-checks read (unit, additivity,
// aggregation, source column, group count/sum). It does NOT recompute — every value is copied
// verbatim from the already-gated `analysis`, so the gate validates the SAME numbers the
// dashboard shows. Kept minimal: the hero total (+ quantity if that is the metric) and the
// product breakdown. The total drives C3 (units-as-dollars) / C10 (additivity); the breakdown
// drives C9 (a 'by product' slice must reconstruct the column's distinct count and total).
export function buildAuditLedger(
  analysis: Analysis,
  mapping: Mapping,
  currency: string,
): LedgerFinding[] {
  const ledger: LedgerFinding[] = [];
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || null;
  // The hero metric's unit: currency for revenue/cost, "units" when quantity is the metric.
  const isMoney = Boolean(mapping.revenue || (!mapping.revenue && !mapping.quantity && mapping.cost));
  const unit = isMoney ? currency : mapping.quantity ? "units" : currency;
  const rendersCurrencySymbol = unit === currency && isMoney;

  ledger.push({
    id: "total",
    measureName: `total ${analysis.primaryMetric}`,
    kind: "scalar",
    value: analysis.totalRevenue,
    unit,
    sourceColumn: valueCol,
    rendersCurrencySymbol,
    additivity: "extensive",
    aggregation: "sum",
  });

  if (mapping.product && analysis.productRevenue.length > 0) {
    const real = realItems(analysis.productRevenue);
    const groupSum = real.reduce((s, p) => s + p.revenue, 0);
    ledger.push({
      id: "breakdown:product",
      measureName: `${analysis.primaryMetric} by product`,
      kind: "breakdown_by",
      value: null,
      unit,
      sourceColumn: mapping.product,
      rendersCurrencySymbol,
      groupCount: real.length,
      groupSum,
      additivity: "extensive",
      aggregation: "sum",
      dimensionAdditive: true,
    });
  }

  return ledger;
}

export function analyzeData(rows: Record<string, string>[], mapping: Mapping, template?: ReportTemplate): Analysis | null {
  // Determine the primary numeric column: revenue > quantity > cost > first numeric column
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  const primaryMetric = getMetricLabel(mapping, template);
  const hasDate = Boolean(mapping.date);
  const hasValue = Boolean(valueCol);

  // Need at least one numeric column OR a date column with categories
  if (!hasValue && !hasDate) {
    // Try to find any numeric-looking column from the first row
    if (rows.length === 0) return null;
    const firstRow = rows[0];
    const numericCol = Object.keys(firstRow).find((key) => {
      const sample = rows.slice(0, 20).map((r) => toNumber(r[key]));
      return sample.filter(Number.isFinite).length >= sample.length * 0.5;
    });
    if (!numericCol) return null;
    // Re-call with a temporary mapping using the found numeric column
    const tempMapping = { ...mapping, revenue: numericCol };
    const result = analyzeData(rows, tempMapping, template);
    if (result) result.primaryMetric = numericCol;
    return result;
  }

  // If we have a value column, build rows with numeric values
  if (hasValue) {
    // canonicalRows is the single row filter shared by every surface.
    const dayFirst = hasDate ? inferDayFirst(rows, mapping.date) : undefined;
    const validRows = canonicalRows(rows, mapping).map((row) => ({
      row,
      date: hasDate ? (parseValidDate(row[mapping.date], dayFirst) ?? new Date(0)) : new Date(0),
      revenue: toNumber(row[valueCol])
    }));

    if (validRows.length === 0) return null;

    const totalRevenue = sum(validRows.map((item) => item.revenue));
    const periodRevenue = hasDate
      ? rankBy(
          validRows,
          (item) => `${item.date.getFullYear()}-${String(item.date.getMonth() + 1).padStart(2, "0")}`,
          (item) => item.revenue,
          false
        )
      : [];
    const productRevenue = mappedRank(validRows, mapping.product);
    const regionRevenue = mappedRank(validRows, mapping.region);
    const customerRevenue = mappedRank(validRows, mapping.customer);
    const unidentifiedProductRows = mapping.product
      ? validRows.filter((item) => isInvalidCategory(item.row[mapping.product])).length
      : 0;
    const identifiedProductRows = validRows.length - unidentifiedProductRows;
    const marginByProduct =
      mapping.product && mapping.cost && valueCol !== mapping.cost
        ? pushInvalidToEnd(rankBy(
            validRows,
            (item) => cleanCategory(item.row[mapping.product]),
            (item) => item.revenue - toNumber(item.row[mapping.cost]),
            true
          ))
        : mapping.product && mapping.profit
        ? pushInvalidToEnd(rankBy(
            validRows,
            (item) => cleanCategory(item.row[mapping.product]),
            (item) => toNumber(item.row[mapping.profit]),
            true
          ))
        : [];
    const totalProfit = mapping.profit
      ? validRows.reduce((s, item) => s + toNumber(item.row[mapping.profit]), 0)
      : null;
    const profitByProduct = mapping.product && mapping.profit
      ? pushInvalidToEnd(rankBy(
          validRows,
          (item) => cleanCategory(item.row[mapping.product]),
          (item) => toNumber(item.row[mapping.profit]),
          true
        ))
      : [];
    const roiByProduct =
      mapping.product && mapping.cost && mapping.revenue
        ? (() => {
            const groups = new Map<string, { rev: number; cost: number }>();
            for (const item of validRows) {
              const key = cleanCategory(item.row[mapping.product]);
              const cost = toNumber(item.row[mapping.cost]);
              if (!Number.isFinite(cost) || cost === 0) continue;
              const g = groups.get(key) ?? { rev: 0, cost: 0 };
              g.rev += item.revenue;
              g.cost += cost;
              groups.set(key, g);
            }
            return pushInvalidToEnd([...groups.entries()]
              .map(([label, g]) => ({ label, revenue: ((g.rev - g.cost) / g.cost) * 100 }))
              .sort((a, b) => b.revenue - a.revenue));
          })()
        : [];
    const bestPeriod = [...periodRevenue].sort((a, b) => b.revenue - a.revenue)[0] ?? null;
    const latestPeriod = periodRevenue[periodRevenue.length - 1] ?? null;
    const previousPeriod = periodRevenue[periodRevenue.length - 2] ?? null;
    const latestPeriodChange =
      latestPeriod && previousPeriod && previousPeriod.revenue !== 0
        ? (latestPeriod.revenue - previousPeriod.revenue) / previousPeriod.revenue
        : null;

    const outliers = detectOutliers(validRows.map((item) => item.revenue), periodRevenue, productRevenue);

    const valMax = validRows.length > 0 ? Math.max(...validRows.map((item) => item.revenue)) : 0;
    const headerNames = rows[0] ? Object.keys(rows[0]) : [];
    const isMoney = primaryMetric === "Count" ? false : primaryMetricIsMoney(valueCol, mapping, valMax, headerNames);

    return {
      rowCount: validRows.length,
      primaryMetric,
      isMoney,
      totalRevenue,
      averageRevenue: totalRevenue / validRows.length,
      minRevenue: Math.min(...validRows.map((item) => item.revenue)),
      maxRevenue: Math.max(...validRows.map((item) => item.revenue)),
      bestPeriod,
      previousPeriod,
      latestPeriod,
      latestPeriodChange,
      periodRevenue,
      productRevenue,
      regionRevenue,
      customerRevenue,
      identifiedProductRows,
      unidentifiedProductRows,
      marginByProduct,
      roiByProduct,
      totalProfit,
      profitByProduct,
      outliers,
      insights: buildInsights(totalRevenue, bestPeriod, productRevenue, regionRevenue, isMoney)
    };
  }

  // Date only (no numeric column) — count-based analysis
  const dateOnlyDayFirst = mapping.date ? inferDayFirst(rows, mapping.date) : undefined;
  const validRows = rows
    .map((row) => ({ row, date: parseValidDate(row[mapping.date], dateOnlyDayFirst) ?? new Date(NaN), revenue: 1 }))
    .filter((item) => !Number.isNaN(item.date.getTime()));

  if (validRows.length === 0) return null;

  const totalRevenue = validRows.length;
  const periodRevenue = rankBy(
    validRows,
    (item) => `${item.date.getFullYear()}-${String(item.date.getMonth() + 1).padStart(2, "0")}`,
    (item) => item.revenue,
    false
  );
  const productRevenue = mappedRank(validRows, mapping.product);
  const regionRevenue = mappedRank(validRows, mapping.region);
  const customerRevenue = mappedRank(validRows, mapping.customer);
  const bestPeriod = [...periodRevenue].sort((a, b) => b.revenue - a.revenue)[0] ?? null;
  const latestPeriod = periodRevenue[periodRevenue.length - 1] ?? null;
  const previousPeriod = periodRevenue[periodRevenue.length - 2] ?? null;
  const latestPeriodChange =
    latestPeriod && previousPeriod && previousPeriod.revenue !== 0
      ? (latestPeriod.revenue - previousPeriod.revenue) / previousPeriod.revenue
      : null;

  return {
    rowCount: validRows.length,
    primaryMetric: "Count",
    isMoney: false,
    totalRevenue,
    averageRevenue: 1,
    minRevenue: 1,
    maxRevenue: 1,
    bestPeriod,
    previousPeriod,
    latestPeriod,
    latestPeriodChange,
    periodRevenue,
    productRevenue,
    regionRevenue,
    customerRevenue,
    identifiedProductRows: mapping.product
      ? validRows.filter((item) => !isInvalidCategory(item.row[mapping.product])).length
      : validRows.length,
    unidentifiedProductRows: mapping.product
      ? validRows.filter((item) => isInvalidCategory(item.row[mapping.product])).length
      : 0,
    marginByProduct: [],
    roiByProduct: [],
    totalProfit: null,
    profitByProduct: [],
    outliers: [],
    insights: buildInsights(totalRevenue, bestPeriod, productRevenue, regionRevenue, false)
  };
}

function getUsableRows(rows: Record<string, string>[], mapping: Mapping) {
  return rows.filter((row) => isUsableAnalysisRow(row, mapping));
}

function getSkippedRows(rows: Record<string, string>[], mapping: Mapping) {
  return rows.filter((row) => !isUsableAnalysisRow(row, mapping));
}

function isUsableAnalysisRow(row: Record<string, string>, mapping: Mapping) {
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  const hasDate = Boolean(mapping.date);
  const hasValue = Boolean(valueCol);
  if (!hasDate && !hasValue) return true; // will be filtered later by analyzeData
  if (hasDate && hasValue) {
    const date = new Date(row[mapping.date]);
    const val = toNumber(row[valueCol]);
    return !Number.isNaN(date.getTime()) && Number.isFinite(val);
  }
  if (hasDate) return !Number.isNaN(new Date(row[mapping.date]).getTime());
  return Number.isFinite(toNumber(row[valueCol]));
}

function detectPeriod(fileName: string, rows: Record<string, string>[], dateCol?: string): string {
  // Try filename first: "sales-jan-2026.csv", "report_2026_Q1.xlsx", "March 2026.csv"
  const name = fileName.replace(/\.[^.]+$/, "");
  const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const monthAbbr = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const lower = name.toLowerCase().replace(/[_-]/g, " ");

  // Match "jan 2026" or "january 2026"
  for (let i = 0; i < 12; i++) {
    const re = new RegExp(`(${monthNames[i]}|${monthAbbr[i]})\\s*(\\d{4})`, "i");
    const m = lower.match(re);
    if (m) return `${monthAbbr[i].charAt(0).toUpperCase() + monthAbbr[i].slice(1)} ${m[2]}`;
  }
  // Match "2026 Q1" or "Q1 2026"
  const qm = lower.match(/q([1-4])\s*(\d{4})/i) || lower.match(/(\d{4})\s*q([1-4])/i);
  if (qm) {
    const q = qm[1].length === 4 ? qm[2] : qm[1];
    const y = qm[1].length === 4 ? qm[1] : qm[2];
    return `Q${q} ${y}`;
  }
  // Match "2026-01" or "202601"
  const ym = name.match(/(\d{4})[\s_-]?(0[1-9]|1[0-2])/);
  if (ym) return `${monthAbbr[parseInt(ym[2], 10) - 1].charAt(0).toUpperCase() + monthAbbr[parseInt(ym[2], 10) - 1].slice(1)} ${ym[1]}`;

  // Fallback: check date column for date range
  if (dateCol && rows.length > 0) {
    const dates = rows.map((r) => new Date(r[dateCol])).filter((d) => !isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime());
    if (dates.length > 0) {
      const first = dates[0];
      const last = dates[dates.length - 1];
      if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) {
        return `${monthAbbr[first.getMonth()].charAt(0).toUpperCase() + monthAbbr[first.getMonth()].slice(1)} ${first.getFullYear()}`;
      }
      const q1 = Math.floor(first.getMonth() / 3) + 1;
      const q2 = Math.floor(last.getMonth() / 3) + 1;
      if (q1 === q2 && first.getFullYear() === last.getFullYear()) return `Q${q1} ${first.getFullYear()}`;
      return `${monthAbbr[first.getMonth()].charAt(0).toUpperCase() + monthAbbr[first.getMonth()].slice(1)} ${first.getFullYear()} – ${monthAbbr[last.getMonth()].charAt(0).toUpperCase() + monthAbbr[last.getMonth()].slice(1)} ${last.getFullYear()}`;
    }
  }

  return fileName.replace(/\.[^.]+$/, "");
}

function compareAnalyses(
  current: Analysis,
  previous: Analysis,
  currentLabel: string,
  previousLabel: string
): ComparisonSummary {
  return {
    currentLabel,
    previousLabel,
    currentRevenue: current.totalRevenue,
    previousRevenue: previous.totalRevenue,
    revenueChange:
      previous.totalRevenue === 0 ? 0 : (current.totalRevenue - previous.totalRevenue) / previous.totalRevenue,
    topProductChange: getLargestMovement(current.productRevenue, previous.productRevenue),
    topRegionChange: getLargestMovement(current.regionRevenue, previous.regionRevenue)
  };
}

function generateComparisonNarrative(
  comparison: ComparisonSummary,
  current: Analysis,
  previous: Analysis,
  currentPeriod: string,
  previousPeriod: string | null,
  settings: ReportSettings
): string {
  const prev = previousPeriod ?? "the previous period";
  const met = current.primaryMetric;
  const revenueSentence = comparison.revenueChange >= 0
    ? `${met} is up ${formatPercent(comparison.revenueChange)} in ${currentPeriod} compared to ${prev}, moving from ${formatMoney(previous.totalRevenue, settings.currency)} to ${formatMoney(current.totalRevenue, settings.currency)}.`
    : `${met} is down ${formatPercent(Math.abs(comparison.revenueChange))} in ${currentPeriod} compared to ${prev}, moving from ${formatMoney(previous.totalRevenue, settings.currency)} to ${formatMoney(current.totalRevenue, settings.currency)}.`;
  const averageChange = previous.averageRevenue === 0 ? null : (current.averageRevenue - previous.averageRevenue) / previous.averageRevenue;
  const averageSentence = averageChange === null
    ? `Average transaction value is ${formatMoney(current.averageRevenue, settings.currency)} in ${currentPeriod}.`
    : `Average transaction value ${averageChange >= 0 ? "increased" : "decreased"} by ${formatPercent(Math.abs(averageChange))}, from ${formatMoney(previous.averageRevenue, settings.currency)} to ${formatMoney(current.averageRevenue, settings.currency)}.`;
  const productSentence = comparison.topProductChange
    ? comparison.topProductChange.revenue >= 0
      ? `${comparison.topProductChange.label} was the top product mover, adding ${formatMoney(comparison.topProductChange.revenue, settings.currency)}.`
      : `${comparison.topProductChange.label} was the biggest product decline, losing ${formatMoney(Math.abs(comparison.topProductChange.revenue), settings.currency)}.`
    : "No product-level movement was available for this comparison.";
  const rowsSentence = `Rows changed from ${previous.rowCount.toLocaleString()} to ${current.rowCount.toLocaleString()}, so read the revenue movement together with volume changes.`;
  return `${revenueSentence} ${averageSentence} ${productSentence} ${rowsSentence}`;
}

function getTopChangePercents(current: RankedItem[], previous: RankedItem[]) {
  const labels = new Set([...current.map((item) => item.label), ...previous.map((item) => item.label)]);
  return [...labels]
    .map((label) => {
      const currentValue = current.find((item) => item.label === label)?.revenue ?? 0;
      const previousValue = previous.find((item) => item.label === label)?.revenue ?? 0;
      const changePct = previousValue === 0 ? (currentValue > 0 ? 100 : 0) : ((currentValue - previousValue) / previousValue) * 100;
      return { name: label, change_pct: Number(changePct.toFixed(1)) };
    })
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 3);
}

function detectComparisonPeriodType(
  currentRows: Record<string, string>[],
  previousRows: Record<string, string>[],
  dateColumn?: string
): string {
  if (!dateColumn) return "period-over-period";
  const currentDates = currentRows.map((row) => new Date(row[dateColumn])).filter((date) => !Number.isNaN(date.getTime()));
  const previousDates = previousRows.map((row) => new Date(row[dateColumn])).filter((date) => !Number.isNaN(date.getTime()));
  if (currentDates.length === 0 || previousDates.length === 0) return "period-over-period";
  const currentMid = new Date((Math.min(...currentDates.map((d) => d.getTime())) + Math.max(...currentDates.map((d) => d.getTime()))) / 2);
  const previousMid = new Date((Math.min(...previousDates.map((d) => d.getTime())) + Math.max(...previousDates.map((d) => d.getTime()))) / 2);
  const monthDiff = Math.abs((currentMid.getFullYear() - previousMid.getFullYear()) * 12 + currentMid.getMonth() - previousMid.getMonth());
  if (monthDiff === 1) return "month-over-month";
  if (monthDiff === 3) return "quarter-over-quarter";
  if (monthDiff === 12) return "year-over-year";
  return "period-over-period";
}

function getLargestMovement(current: RankedItem[], previous: RankedItem[]) {
  const labels = new Set([...current.map((item) => item.label), ...previous.map((item) => item.label)]);
  const movements = [...labels].map((label) => ({
    label,
    revenue:
      (current.find((item) => item.label === label)?.revenue ?? 0) -
      (previous.find((item) => item.label === label)?.revenue ?? 0)
  }));
  return movements.sort((a, b) => Math.abs(b.revenue) - Math.abs(a.revenue))[0] ?? null;
}

function pushInvalidToEnd(items: RankedItem[]): RankedItem[] {
  const idx = items.findIndex((r) => r.label === INVALID_BUCKET);
  if (idx >= 0 && idx < items.length - 1) {
    const [invalid] = items.splice(idx, 1);
    items.push(invalid);
  }
  return items;
}

function mappedRank(
  rows: Array<{ row: Record<string, string>; revenue: number }>,
  column: string
): RankedItem[] {
  if (!column) return [];
  return pushInvalidToEnd(rankBy(rows, (item) => cleanCategory(item.row[column]), (item) => item.revenue, true));
}

function rankBy<T>(
  rows: T[],
  labelSelector: (item: T) => string,
  valueSelector: (item: T) => number,
  descending: boolean
): RankedItem[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = labelSelector(row);
    totals.set(label, (totals.get(label) ?? 0) + valueSelector(row));
  }
  return [...totals.entries()]
    .map(([label, revenue]) => ({ label, revenue }))
    .sort((a, b) => (descending ? b.revenue - a.revenue : a.label.localeCompare(b.label)));
}

function detectOutliers(rowValues: number[], periodRevenue: RankedItem[], productRevenue: RankedItem[]): Outlier[] {
  const outliers: Outlier[] = [];

  // Detect outlier rows using IQR method (2.5x multiplier to avoid over-flagging)
  if (rowValues.length >= 5) {
    const sorted = [...rowValues].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    const highThreshold = q3 + 2.5 * iqr;
    const lowThreshold = q1 - 2.5 * iqr;
    const highCount = rowValues.filter((v) => v > highThreshold).length;
    const lowCount = rowValues.filter((v) => v < lowThreshold).length;
    if (highCount > 0 && highCount <= rowValues.length * 0.05) outliers.push({ label: `${highCount} unusually high row${highCount > 1 ? "s" : ""}`, value: highThreshold, type: "high", context: `Above ${formatMoney(highThreshold)}` });
    if (lowCount > 0 && lowCount <= rowValues.length * 0.05) outliers.push({ label: `${lowCount} unusually low row${lowCount > 1 ? "s" : ""}`, value: lowThreshold, type: "low", context: `Below ${formatMoney(lowThreshold)}` });
  }

  // Detect period-over-period spikes/drops (>50% change)
  for (let i = 1; i < periodRevenue.length; i++) {
    const prev = periodRevenue[i - 1].revenue;
    const curr = periodRevenue[i].revenue;
    if (prev === 0) continue;
    const change = (curr - prev) / prev;
    if (change > 0.5) outliers.push({ label: `${periodRevenue[i].label} spike`, value: change, type: "high", context: `+${formatPercent(change)} vs ${periodRevenue[i - 1].label}` });
    if (change < -0.3) outliers.push({ label: `${periodRevenue[i].label} drop`, value: change, type: "low", context: `${formatPercent(change)} vs ${periodRevenue[i - 1].label}` });
  }

  // Detect product dominance (single identified product > 50% of identified product revenue)
  const realProducts = realItems(productRevenue);
  if (realProducts.length >= 2) {
    const identifiedRev = realProducts.reduce((s, p) => s + p.revenue, 0);
    const topShare = identifiedRev > 0 ? realProducts[0].revenue / identifiedRev : 0;
    if (topShare > 0.5) outliers.push({ label: `${realProducts[0].label} dominance`, value: topShare, type: "high", context: `${formatPercent(topShare)} of identified product revenue` });
  }

  return outliers;
}

function enrichOutliersWithRootCause(outliers: Outlier[], rows: Record<string, string>[], mapping: Mapping, periodRevenue: RankedItem[]): Outlier[] {
  if (!mapping.date || (!mapping.customer && !mapping.product)) return outliers;
  const valueCol = mapping.revenue || mapping.quantity || mapping.cost || "";
  if (!valueCol) return outliers;

  return outliers.map((o) => {
    if (!o.label.includes("spike") && !o.label.includes("drop")) return o;
    const periodLabel = o.label.replace(/ spike$/, "").replace(/ drop$/, "");
    const periodRows = rows.filter((r) => {
      const dateStr = r[mapping.date] ?? "";
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return false;
      const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      return label === periodLabel || dateStr.startsWith(periodLabel);
    });
    if (periodRows.length === 0) return o;

    const causes: string[] = [];

    // Check customer concentration in this period
    if (mapping.customer) {
      const custTotals = new Map<string, number>();
      for (const r of periodRows) {
        const cust = r[mapping.customer] ?? "";
        const val = parseFloat(r[valueCol] ?? "") || 0;
        custTotals.set(cust, (custTotals.get(cust) ?? 0) + val);
      }
      const periodTotal = [...custTotals.values()].reduce((s, v) => s + v, 0);
      const topCust = [...custTotals.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topCust && periodTotal > 0 && topCust[1] / periodTotal > 0.4) {
        causes.push(`${topCust[0]} contributed ${((topCust[1] / periodTotal) * 100).toFixed(0)}% of this period`);
      }
    }

    // Check product concentration
    if (mapping.product) {
      const prodTotals = new Map<string, number>();
      for (const r of periodRows) {
        const prod = r[mapping.product] ?? "";
        const val = parseFloat(r[valueCol] ?? "") || 0;
        prodTotals.set(prod, (prodTotals.get(prod) ?? 0) + val);
      }
      const periodTotal = [...prodTotals.values()].reduce((s, v) => s + v, 0);
      const topProd = [...prodTotals.entries()].sort((a, b) => b[1] - a[1])[0];
      if (topProd && periodTotal > 0 && topProd[1] / periodTotal > 0.4) {
        causes.push(`${topProd[0]} drove ${((topProd[1] / periodTotal) * 100).toFixed(0)}%`);
      }
    }

    // Check if order count vs order value
    const avg = periodRevenue.reduce((s, p) => s + p.revenue, 0) / periodRevenue.length;
    const periodVal = periodRevenue.find((p) => p.label === periodLabel)?.revenue ?? 0;
    const avgRowCount = rows.length / Math.max(periodRevenue.length, 1);
    if (periodRows.length > avgRowCount * 1.3) {
      causes.push(`Order count ${((periodRows.length / avgRowCount - 1) * 100).toFixed(0)}% above normal`);
    } else if (periodVal > avg * 1.3 && periodRows.length <= avgRowCount * 1.1) {
      causes.push("Average order value higher than normal (not order count)");
    }

    return { ...o, rootCause: causes.length > 0 ? causes.join(". ") + "." : undefined };
  });
}

// Structured command returned by the Worker's intent_parse task.
type SmartCommand = {
  intent: string;
  dimension?: "product" | "region" | "customer" | "period" | null;
  direction?: "top" | "bottom" | null;
  top_n?: number | null;
  entity?: string | null;
  chart_type?: ChartCommand["type"] | "none" | null;
};

function chartFromItems(type: ChartCommand["type"], title: string, items: RankedItem[], limit = 10): ChartCommand {
  // Never chart the junk/missing bucket as a real category.
  return { type, title, data: realItems(items).slice(0, limit).map((i) => ({ label: i.label, value: i.revenue })) };
}

function dimensionItems(command: SmartCommand, analysis: Analysis): { items: RankedItem[]; noun: string } | null {
  switch (command.dimension) {
    case "product": { const items = realItems(analysis.productRevenue); return items.length ? { items, noun: "product" } : null; }
    case "region": { const items = realItems(analysis.regionRevenue); return items.length ? { items, noun: "region" } : null; }
    case "customer": { const items = realItems(analysis.customerRevenue); return items.length ? { items, noun: "customer" } : null; }
    case "period": return analysis.periodRevenue.length ? { items: analysis.periodRevenue, noun: "period" } : null;
    default: return null;
  }
}

// Computes the raw findings (and a chart) locally from the already-analysed data,
// keyed off the structured intent. Returns null when the intent can't be served,
// so the caller can fall back to the rule-based answerer.
function executeIntent(command: SmartCommand, analysis: Analysis, settings: ReportSettings): { text: string; chart: ChartCommand | null } | null {
  const cur = settings.currency;
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, cur) : v.toLocaleString(undefined, { maximumFractionDigits: analysis.primaryMetric === "Count" ? 0 : 1 });
  const pct = (v: number, total: number) => (total > 0 ? ((v / total) * 100).toFixed(1) : "0");
  const magPct = (v: number) => `${(Math.abs(v) * 100).toFixed(1)}%`;
  const metric = analysis.primaryMetric.toLowerCase();
  const chartType: ChartCommand["type"] | null =
    command.chart_type && command.chart_type !== "none" ? command.chart_type : null;

  switch (command.intent) {
    case "total":
      return { text: `Total ${metric} ${fmt(analysis.totalRevenue)} across ${analysis.rowCount.toLocaleString()} rows. Average ${fmt(analysis.averageRevenue)}.`, chart: null };

    case "average":
      return { text: `Average transaction value ${fmt(analysis.averageRevenue)} across ${analysis.rowCount.toLocaleString()} rows.`, chart: null };

    case "ranking": {
      const dim = dimensionItems(command, analysis);
      if (!dim) return null;
      const n = Math.max(1, Math.min(command.top_n ?? 5, dim.items.length));
      const bottom = command.direction === "bottom";
      const picked = bottom ? [...dim.items].slice(-n).reverse() : dim.items.slice(0, n);
      const rankBase = identifiedTotal(dim.items, analysis.totalRevenue);
      const list = picked.map((it, i) => `${i + 1}. ${it.label} ${fmt(it.revenue)} (${pct(it.revenue, rankBase)}%)`).join("; ");
      return {
        text: `${bottom ? "Bottom" : "Top"} ${n} ${dim.noun}s by ${metric}: ${list}.`,
        chart: chartFromItems(chartType ?? "horizontal_bar", `${bottom ? "Bottom" : "Top"} ${dim.noun}s`, picked, n)
      };
    }

    case "trend": {
      if (analysis.periodRevenue.length < 2) return { text: "Not enough periods to determine a trend.", chart: null };
      const dir = analysis.latestPeriodChange === null ? "flat" : analysis.latestPeriodChange >= 0 ? "up" : "down";
      const change = analysis.latestPeriodChange !== null ? `${magPct(analysis.latestPeriodChange)} ${dir}` : "n/a";
      const peak = analysis.bestPeriod ? ` Peak ${analysis.bestPeriod.label} at ${fmt(analysis.bestPeriod.revenue)}.` : "";
      return {
        text: `Trend is ${dir}; latest period changed ${change} vs previous.${peak}`,
        chart: chartFromItems(chartType ?? "line", `${analysis.primaryMetric} Trend`, analysis.periodRevenue, analysis.periodRevenue.length)
      };
    }

    case "forecast": {
      const lastThree = analysis.periodRevenue.slice(-3);
      if (lastThree.length === 0) return { text: "Need at least 3 periods of data for a forecast.", chart: null };
      const avg = sum(lastThree.map((p) => p.revenue)) / lastThree.length;
      const vals = analysis.periodRevenue.map((p) => p.revenue);
      const trend = vals.length >= 2 ? ((vals[vals.length - 1] - vals[0]) / Math.max(vals[0], 1)) * 100 : 0;
      const fc = [1, 2, 3].map((i) => ({ label: `Forecast ${i}`, value: Math.round(avg) }));
      return {
        text: `Projected next period about ${fmt(avg)}. Trend ${trend >= 0 ? "+" : ""}${trend.toFixed(1)}% over ${vals.length} periods.`,
        chart: { type: "line", title: `${analysis.primaryMetric} Forecast`, data: [...analysis.periodRevenue.map((p) => ({ label: p.label, value: p.revenue })), ...fc] }
      };
    }

    case "driver": {
      const parts: string[] = [];
      if (analysis.latestPeriodChange !== null) parts.push(`${analysis.primaryMetric} ${analysis.latestPeriodChange >= 0 ? "grew" : "declined"} ${magPct(analysis.latestPeriodChange)} in the latest period.`);
      const realProd = realItems(analysis.productRevenue);
      if (realProd.length >= 2) {
        const top = realProd[0];
        parts.push(`Biggest contributor ${top.label} at ${fmt(top.revenue)} (${pct(top.revenue, identifiedTotal(analysis.productRevenue, analysis.totalRevenue))}%).`);
      }
      const realReg = realItems(analysis.regionRevenue);
      if (realReg.length >= 2) parts.push(`Top region ${realReg[0].label}.`);
      if (analysis.outliers.length > 0) {
        const o = analysis.outliers[0];
        parts.push(`Notable: ${o.label} (${o.type === "high" ? "spike" : "drop"}) — ${o.context}.`);
      }
      if (parts.length === 0) return null;
      return {
        text: parts.join(" "),
        chart: analysis.productRevenue.length ? chartFromItems(chartType ?? "bar", "What's driving the numbers", analysis.productRevenue, 8) : null
      };
    }

    case "composition": {
      const dim = dimensionItems(command, analysis) ?? (realItems(analysis.productRevenue).length ? { items: realItems(analysis.productRevenue), noun: "product" } : null);
      if (!dim) return null;
      const n = Math.max(3, Math.min(command.top_n ?? 6, dim.items.length));
      const top = dim.items.slice(0, n);
      const compBase = identifiedTotal(dim.items, analysis.totalRevenue);
      const list = top.map((it) => `${it.label} ${pct(it.revenue, compBase)}%`).join(", ");
      return {
        text: `Share of ${metric} by ${dim.noun}: ${list}.`,
        chart: chartFromItems(chartType ?? "donut", `${dim.noun} share`, top, n)
      };
    }

    case "concentration": {
      const realCust = realItems(analysis.customerRevenue);
      if (realCust.length < 3) return { text: "Need at least 3 customers to assess concentration.", chart: null };
      const top3 = realCust.slice(0, 3);
      const conc = pct(sum(top3.map((c) => c.revenue)), identifiedTotal(analysis.customerRevenue, analysis.totalRevenue));
      return {
        text: `Top 3 customers account for ${conc}% of revenue (${top3.map((c) => c.label).join(", ")}). ${Number(conc) > 50 ? "That's high concentration risk." : "Reasonably diversified."}`,
        chart: chartFromItems(chartType ?? "horizontal_bar", "Customer concentration", analysis.customerRevenue, 10)
      };
    }

    case "anomaly": {
      const n = analysis.outliers.length;
      if (n === 0) return { text: "No unusual patterns detected in the data.", chart: null };
      const top = analysis.outliers[0];
      return { text: `Found ${n} unusual pattern${n > 1 ? "s" : ""}. Most notable: ${top.label} (${top.type === "high" ? "spike" : "drop"}) — ${top.context}.`, chart: null };
    }

    case "summary": {
      const changeLine = analysis.latestPeriodChange !== null ? ` Trend ${analysis.latestPeriodChange >= 0 ? "up" : "down"} ${magPct(analysis.latestPeriodChange)} vs last period.` : "";
      const sumProd = realItems(analysis.productRevenue)[0];
      const sumReg = realItems(analysis.regionRevenue)[0];
      const topProd = sumProd ? ` Top product ${sumProd.label} (${pct(sumProd.revenue, identifiedTotal(analysis.productRevenue, analysis.totalRevenue))}%).` : "";
      const topReg = sumReg ? ` Top region ${sumReg.label}.` : "";
      return {
        text: `Total ${metric} ${fmt(analysis.totalRevenue)} across ${analysis.rowCount.toLocaleString()} rows; average ${fmt(analysis.averageRevenue)}.${changeLine}${topProd}${topReg}`,
        chart: analysis.periodRevenue.length ? chartFromItems(chartType ?? "line", `${analysis.primaryMetric} Overview`, analysis.periodRevenue, analysis.periodRevenue.length) : null
      };
    }

    case "actions": {
      const actions: string[] = [];
      const aProd = realItems(analysis.productRevenue);
      const aCust = realItems(analysis.customerRevenue);
      const aReg = realItems(analysis.regionRevenue);
      if (aProd[0]) actions.push(`Protect ${aProd[0].label} (${pct(aProd[0].revenue, identifiedTotal(analysis.productRevenue, analysis.totalRevenue))}% of identified product revenue).`);
      if (aCust.length >= 3) {
        const conc = Number(pct(sum(aCust.slice(0, 3).map((c) => c.revenue)), identifiedTotal(analysis.customerRevenue, analysis.totalRevenue)));
        if (conc > 50) actions.push(`Diversify — top 3 customers are ${conc.toFixed(0)}% of revenue.`);
      }
      if (analysis.latestPeriodChange !== null && analysis.latestPeriodChange < -0.05) actions.push(`Investigate the ${magPct(analysis.latestPeriodChange)} decline.`);
      if (aReg.length >= 2) {
        const weak = aReg[aReg.length - 1];
        actions.push(`Review ${weak.label} (weakest region at ${fmt(weak.revenue)}).`);
      }
      if (actions.length === 0) return { text: "Data looks healthy overall. Keep monitoring monthly.", chart: null };
      return { text: `Recommended actions: ${actions.slice(0, 4).join(" ")}`, chart: null };
    }

    case "specific_item": {
      const name = (command.entity || "").toLowerCase().trim();
      if (!name) return null;
      const search = (rawItems: RankedItem[], noun: string) => {
        const items = realItems(rawItems);
        const idx = items.findIndex((it) => {
          const label = it.label.toLowerCase();
          return label === name || label.includes(name) || name.includes(label);
        });
        if (idx === -1) return null;
        const it = items[idx];
        const base = identifiedTotal(rawItems, analysis.totalRevenue);
        return {
          text: `${it.label}: ${fmt(it.revenue)} (${pct(it.revenue, base)}% of identified ${noun} revenue). Ranked #${idx + 1} of ${items.length} ${noun}s.`,
          chart: chartFromItems(chartType ?? "horizontal_bar", `${noun} comparison`, items, 8)
        };
      };
      return search(analysis.productRevenue, "product") || search(analysis.customerRevenue, "customer") || search(analysis.regionRevenue, "region");
    }

    case "health":
      return {
        text: "Customer health scores everyone by recency, frequency, and spending into segments (Best, Regulars, Promising, Needs attention, Slipping away, Gone quiet). See the Customer Health section on the Dashboard.",
        chart: null
      };

    default:
      return null;
  }
}

// True when the question is a straight fact/rank/share lookup about a named entity
// ("tell me about Smoothie", "how is Salad doing", "Smoothie share", "where does X rank").
// For these the narrative must be canonical — never freehand from the model.
function isEntityLookupQuestion(q: string): boolean {
  return /tell me about|what about|how('?s| is| are| did)|how much|performance|doing|stats?\b|info on|breakdown|rank|share|where does|^[^?]{0,28}\??$/.test(q);
}

// Builds the authoritative, canonical sentence for a question that targets exactly ONE identified
// entity (product/region/customer). Rank, "#N of M", and share are taken from the canonical metrics
// table — junk labels are excluded so the item universe is the identified count (e.g. 8, not 10),
// and the share uses that dimension's own identified denominator. Returns null when zero or more than
// one identified entity is named, so callers fall through to the general AI/rule path.
function canonicalItemNarrative(
  question: string,
  analysis: Analysis,
  mapping: Mapping,
  settings: ReportSettings,
  dataSet: DataSet | null
): string | null {
  const q = question.toLowerCase();
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, settings.currency) : v.toLocaleString(undefined, { maximumFractionDigits: analysis.primaryMetric === "Count" ? 0 : 1 });
  const metric = analysis.primaryMetric.toLowerCase();
  const prod = realItems(analysis.productRevenue);
  const reg = realItems(analysis.regionRevenue);
  const cust = realItems(analysis.customerRevenue);
  const prodLabel = getDimensionLabel("product", mapping, settings.template).toLowerCase();
  const regLabel = getDimensionLabel("region", mapping, settings.template).toLowerCase();
  const custLabel = getDimensionLabel("customer", mapping, settings.template).toLowerCase();

  type Hit = { item: RankedItem; idx: number; count: number; base: number; noun: string; dim: "product" | "region" | "customer" };
  const findHit = (
    list: RankedItem[],
    base: number,
    noun: string,
    dim: "product" | "region" | "customer"
  ): Hit | null => {
    let best: Hit | null = null;
    list.forEach((it, idx) => {
      const label = it.label.toLowerCase();
      if (label && q.includes(label) && (!best || label.length > best.item.label.length)) {
        best = { item: it, idx, count: list.length, base, noun, dim };
      }
    });
    return best;
  };
  const prodBase = identifiedTotal(analysis.productRevenue, analysis.totalRevenue);
  const regBase = identifiedTotal(analysis.regionRevenue, analysis.totalRevenue);
  const custBase = identifiedTotal(analysis.customerRevenue, analysis.totalRevenue);
  const hits = [
    findHit(prod, prodBase, prodLabel, "product"),
    findHit(reg, regBase, regLabel, "region"),
    findHit(cust, custBase, custLabel, "customer")
  ].filter((h): h is Hit => h !== null);
  if (hits.length !== 1) return null;
  const hit = hits[0];

  const sharePct = hit.base > 0 ? ((hit.item.revenue / hit.base) * 100).toFixed(1) : "0";
  let line = `${hit.item.label}: ${fmt(hit.item.revenue)} (${sharePct}% of identified ${hit.noun} ${metric}). Ranked #${hit.idx + 1} of ${hit.count} ${hit.noun}s by ${metric}.`;

  // Units rank — only when the question references units/volume AND a quantity column is mapped,
  // computed from the same canonical row universe (junk items excluded) so it never fabricates.
  if (
    hit.dim === "product" &&
    mapping.product &&
    mapping.quantity &&
    dataSet &&
    /\bunit|\bquantit|\bqty\b|volume|sold|how many/.test(q)
  ) {
    const unitsRank = rankBy(
      // Identified items with a genuinely numeric quantity — skip blank/ERROR quantities so a NaN
      // can never poison a product's unit total (which would scramble the ranking).
      canonicalRows(dataSet.rows, mapping).filter(
        (r) => !isInvalidCategory(r[mapping.product]) && hasNumericValue(r[mapping.quantity])
      ),
      (r) => cleanCategory(r[mapping.product]),
      (r) => toNumber(r[mapping.quantity]),
      true
    );
    const uIdx = unitsRank.findIndex((u) => u.label === hit.item.label);
    if (uIdx >= 0) line += ` By units it ranks #${uIdx + 1} of ${unitsRank.length}.`;
  }
  return line;
}

// Post-validation safety net for the AI/Worker narrative: if the model calls a specific identified
// product the "top performer"/"#1" when it is not actually rank #1, append a canonical correction.
// Conservative — only fires when exactly one identified product is named, to avoid false positives.
function correctNarrative(text: string, analysis: Analysis, mapping: Mapping, settings: ReportSettings): string {
  const lower = text.toLowerCase();
  const topClaim = /#\s*1\b|top performer|top-performer|best[- ]?sell|number one|ranks?\s*(?:first|#?\s*1|highest)|the (?:top|leading|best)\b/.test(lower);
  if (!topClaim) return text;
  const prod = realItems(analysis.productRevenue);
  if (prod.length === 0) return text;
  const named = prod.filter((p) => p.label && lower.includes(p.label.toLowerCase()));
  if (named.length !== 1) return text;
  const idx = prod.indexOf(named[0]);
  if (idx <= 0) return text; // it really is #1 — nothing to correct
  const base = identifiedTotal(analysis.productRevenue, analysis.totalRevenue);
  const prodLabel = getDimensionLabel("product", mapping, settings.template).toLowerCase();
  const metric = analysis.primaryMetric.toLowerCase();
  const share = base > 0 ? ((named[0].revenue / base) * 100).toFixed(1) : "0";
  return `${text}\n\nCorrection: ${named[0].label} ranks #${idx + 1} of ${prod.length} ${prodLabel}s by ${metric} (${share}% of identified ${prodLabel} ${metric}) — not the top ${prodLabel}. The leading ${prodLabel} is ${prod[0].label}.`;
}

// Free smart-AI flow: classify intent on the Worker, compute findings locally,
// then polish into prose on the Worker. Falls back to the rule-based answerer
// whenever the Worker is unreachable or the intent can't be served.
export async function smartAnswer(
  question: string,
  analysis: Analysis,
  settings: ReportSettings,
  dataSet: DataSet | null,
  mapping: Mapping,
  history: ChatMessage[],
  extraMetrics: string[] = [],
  extraDimensions: string[] = [],
  mode: "sum" | "count" | "average" = "sum",
  idColumns: string[] = [],
  findings?: Findings | null
): Promise<{ text: string; chart: ChartCommand | null; warning?: string }> {
  const fallback = () => {
    const raw = answerQuestion(question, analysis, settings, mapping, history, findings);
    // The rule-based answer must clear the same Layer-4 guard as the AI path, so a flat-data
    // answer can't slip a trend/seasonal/momentum claim past the verdict engine.
    const text = findings ? sanitizeNarration(raw, findings).text : raw;
    return { text, chart: generateRuleBasedChart(question, analysis, settings, mapping) };
  };

  if (!dataSet) return fallback();

  // Guardrail: a fact/rank/share lookup about a single named entity gets a canonical answer.
  // Rank ("#3 of 8"), share, and total come straight from the metrics table — never freehand
  // from the model, which has invented ranks ("#1 of 10" counting junk) and total-based shares.
  const q = question.toLowerCase().trim();
  if (isEntityLookupQuestion(q)) {
    const canonical = canonicalItemNarrative(question, analysis, mapping, settings, dataSet);
    if (canonical) {
      return { text: canonical, chart: generateRuleBasedChart(question, analysis, settings, mapping) };
    }
  }

  const types: Record<string, string> = {};
  for (const p of dataSet.profiles) types[p.name] = p.type;
  const roles: Record<string, string> = {};
  for (const [role, col] of Object.entries(mapping)) if (col) roles[role] = col;

  // Build context: column names + 5 sample rows (never full data)
  const sampleRows = dataSet.rows.slice(0, 5).map((row) => {
    const clean: Record<string, string> = {};
    for (const col of dataSet.headers) clean[col] = row[col] ?? "";
    return clean;
  });

  // CALL 1: AI generates JavaScript code (1 credit)
  const codeResponse = await callSmartAI<{ code?: string; error?: string }>("generate_code", {
    question,
    columns: dataSet.headers,
    types,
    roles,
    sampleRows,
    additionalMetrics: extraMetrics,
    additionalDimensions: extraDimensions,
    analysisMode: mode,
    identifierColumns: idColumns
  });

  if (!codeResponse?.code) return fallback();

  // RUN CODE: Execute on the canonical row set (same universe as the dashboard) so AI-path
  // values match every other surface — never the raw, date-unfiltered rows. Numeric cells can
  // carry thousands separators or currency ("1,234.56", "$1,234"); the AI-generated code parses
  // with a bare Number(), which returns NaN for those and silently undercounts every aggregate
  // (e.g. a region total off by the sum of all comma-formatted rows). Normalize numeric columns
  // to plain numbers first — the same toNumber() the rest of the app uses — so the code's sums
  // match the dashboard.
  const numericCols = new Set<string>(dataSet.profiles.filter((pr) => pr.type === "number").map((pr) => pr.name));
  for (const col of [roles.revenue, roles.quantity, roles.cost, roles.profit, roles.discount, ...extraMetrics]) {
    if (col) numericCols.add(col);
  }
  const cleanedRows = canonicalRows(dataSet.rows, roles).map((row) => {
    const out: Record<string, string> = { ...row };
    for (const col of numericCols) {
      const v = out[col];
      if (v != null && v !== "") {
        const n = toNumber(v);
        if (Number.isFinite(n)) out[col] = String(n);
      }
    }
    return out;
  });
  const result = await runAICodeSafe(codeResponse.code, cleanedRows, roles);

  if (!result.success || !result.data) return fallback();

  const resultData = result.data as Record<string, unknown>;

  // Build chart from result if AI suggested one
  let chart: ChartCommand | null = null;
  const chartType = resultData.chartType as string | undefined;
  const rawDetails = resultData.details as Array<{ label: string; value: number }> | undefined;
  // Single chart validator: drops junk buckets AND any grand-total-vs-components row, so the
  // AI path can't render a "Total" bar alongside its own parts.
  const isShareChart = chartType === "pie" || chartType === "donut";
  const details = rawDetails ? validateChartSeries(rawDetails, { isShare: isShareChart }).items : undefined;
  if (chartType && chartType !== "none" && details && details.length > 0) {
    chart = {
      type: (chartType === "bar" ? "horizontal_bar" : chartType) as ChartCommand["type"],
      title: (resultData.chartTitle as string) || "Analysis result",
      data: details.slice(0, 20)
    };
  }

  // CALL 2: AI explains the result (1 credit)
  const metricLabel = getMetricLabel(mapping, settings.template);
  const domain = TEMPLATE_CONFIG[settings.template].insightContext;
  const explanation = await callSmartAI<{ explanation?: string }>("explain_result", {
    question,
    result: JSON.stringify(resultData.answer ?? resultData),
    domain,
    metricLabel,
    // When the metric is a units column mislabelled as revenue, tell the model to state plain
    // counts, never a currency amount (mirrors the exec-summary payload the worker honours).
    is_money: analysis.isMoney
  });

  const rawText = explanation?.explanation || JSON.stringify(resultData.answer ?? resultData);
  let text = correctNarrative(rawText, analysis, mapping, settings);
  // Runtime guardrail: drop any sentence asserting a pattern the verdict engine ruled
  // non-significant, so the BYOK explanation can't contradict the report/forecast/dashboard.
  if (findings) text = sanitizeNarration(text, findings).text;
  // Append the reconciliation note to total/overall answers so the total-vs-per-product gap is explained.
  const wantsRecon = /total|overall|summary|overview|how much/.test(q) && !/(product|item|region|customer)/.test(q);
  if (wantsRecon) {
    const recon = reconciliationNote(analysis, mapping, settings);
    if (recon && !text.includes(recon)) text += `\n\n${recon}`;
  }
  return { text, chart, warning: resultData.warning as string | undefined };
}

export function answerQuestion(question: string, analysis: Analysis, settings: ReportSettings, mapping?: Mapping, chatHistory?: ChatMessage[], findings?: Findings | null): string {
  const q = question.toLowerCase().trim();
  // The verdict engine is the single source of truth for trend/momentum. When findings is
  // available, every trend claim defers to it; isTrendFlat/latestPeriodChange are only the
  // pre-findings fallback so the rule-based path still answers when findings is absent.
  const trendVerdict = findings?.trend ?? null;
  const trendIsReal = trendVerdict ? trendVerdict.isSignificant : !isTrendFlat(analysis);
  const cur = settings.currency;
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, cur) : v.toLocaleString(undefined, { maximumFractionDigits: analysis.primaryMetric === "Count" ? 0 : 1 });
  const pct = (v: number, total: number) => total > 0 ? ((v / total) * 100).toFixed(1) : "0";
  const metric = analysis.primaryMetric.toLowerCase();
  const prodLabel = mapping ? getDimensionLabel("product", mapping, settings.template).toLowerCase() : "product";
  const custLabel = mapping ? getDimensionLabel("customer", mapping, settings.template).toLowerCase() : "customer";
  const regLabel = mapping ? getDimensionLabel("region", mapping, settings.template).toLowerCase() : "region";

  // Junk/missing buckets are never shown as a real category, ranked, or counted in a share.
  // Each dimension's shares use that dimension's own identified total as the denominator.
  const prod = realItems(analysis.productRevenue);
  const reg = realItems(analysis.regionRevenue);
  const cust = realItems(analysis.customerRevenue);
  const prodBase = identifiedTotal(analysis.productRevenue, analysis.totalRevenue);
  const regBase = identifiedTotal(analysis.regionRevenue, analysis.totalRevenue);
  const custBase = identifiedTotal(analysis.customerRevenue, analysis.totalRevenue);
  // Reconciliation note appended to total/summary answers so the total-vs-per-product gap is explained.
  const recon = mapping ? reconciliationNote(analysis, mapping, settings) : "";
  const reconTail = recon ? ` ${recon}` : "";

  // Repeat detection: if last analyst answer was very similar question, add context
  const lastUserMsg = chatHistory ? [...chatHistory].reverse().find((m) => m.role === "user") : null;
  const isRepeat = lastUserMsg && lastUserMsg.text.toLowerCase().trim() === q;

  // --- PRIORITY 1: Most specific patterns first ---

  // Forecast (must check before "trend" — questions often contain both words)
  if (/forecast|predict|next\s+\d+\s*month|projection|future|ahead|upcoming/.test(q)) {
    const lastThree = analysis.periodRevenue.slice(-3);
    if (lastThree.length === 0) return "Need at least 3 periods of data for forecasting.";
    const forecast = sum(lastThree.map((item) => item.revenue)) / lastThree.length;
    const vals = analysis.periodRevenue.map((p) => p.revenue);
    const rawTrend = vals.length >= 2 ? ((vals[vals.length - 1] - vals[0]) / Math.max(vals[0], 1)) * 100 : 0;
    // Trend statement defers to the verdict engine — a raw first-vs-last % is not a trend claim.
    const trendSentence = trendVerdict
      ? `The series shows ${trendVerdict.label} over ${vals.length} periods.`
      : `Trend is ${rawTrend >= 0 ? "+" : ""}${rawTrend.toFixed(1)}% over ${vals.length} periods.`;
    return `Projected next period: approximately ${fmt(forecast)}. ${trendSentence} ${analysis.bestPeriod ? `Peak was ${analysis.bestPeriod.label} at ${fmt(analysis.bestPeriod.revenue)}.` : ""} Check the Dashboard forecast chart for confidence bands.`;
  }

  // Driver / cause / why (must check before "trend")
  if (/driving|cause|why|factor|contribut|break\s*down|behind|explain.*(?:trend|change|decline|growth)|reason/.test(q)) {
    const parts: string[] = [];
    if (analysis.latestPeriodChange !== null) {
      const note = partialPeriodNote(findings);
      parts.push(
        note
          ? `${analysis.primaryMetric}: ${note}.`
          : `${analysis.primaryMetric} ${analysis.latestPeriodChange >= 0 ? "grew" : "declined"} ${formatPercent(Math.abs(analysis.latestPeriodChange))} in the latest period.`,
      );
    }
    if (prod.length >= 2) {
      const top = prod[0];
      const bottom = prod[prod.length - 1];
      parts.push(`Biggest contributor: ${top.label} at ${fmt(top.revenue)} (${pct(top.revenue, prodBase)}% of identified ${prodLabel} ${metric}). Smallest: ${bottom.label} at ${fmt(bottom.revenue)}.`);
    }
    if (reg.length >= 2) {
      parts.push(`Top ${regLabel}: ${reg[0].label} (${fmt(reg[0].revenue)}). Weakest: ${reg[reg.length - 1].label}.`);
    }
    if (cust.length >= 3) {
      const top3Rev = cust.slice(0, 3).reduce((s, c) => s + c.revenue, 0);
      const conc = Number(pct(top3Rev, custBase));
      if (conc > 50) parts.push(`Concentration risk: top 3 ${custLabel}s are ${conc.toFixed(0)}% of ${metric}.`);
    }
    if (analysis.outliers.length > 0) {
      const o = analysis.outliers[0];
      parts.push(`Notable pattern: ${o.label} (${o.type === "high" ? "spike" : "drop"}) — ${o.context}`);
    }
    return parts.length > 0 ? parts.join(" ") : "Not enough data dimensions to identify drivers. Map product, region, and customer columns for a fuller breakdown.";
  }

  // Recommendations / actions / what should I do
  if (/should i|recommend|action|suggestion|what.*do|advice|next step|plan/.test(q)) {
    const actions: string[] = [];
    if (prod[0]) {
      const topPct = pct(prod[0].revenue, prodBase);
      actions.push(`Protect ${prod[0].label} (${topPct}% of identified ${prodLabel} ${metric}) — review stock, pricing, and marketing support.`);
    }
    if (cust.length >= 3) {
      const top3Rev = cust.slice(0, 3).reduce((s, c) => s + c.revenue, 0);
      const conc = Number(pct(top3Rev, custBase));
      if (conc > 50) actions.push(`Diversify ${custLabel} base — top 3 ${custLabel}s are ${conc.toFixed(0)}% of ${metric}. Losing one would be significant.`);
    }
    // A single down period on a statistically flat series is noise — don't frame it as a
    // structural decline. Only advise investigating when the verdict confirms a real downturn
    // (or, pre-findings, the heuristic isn't flat).
    const declineIsReal =
      latestChangeComparable(findings) &&
      (trendVerdict ? (trendIsReal && trendVerdict.direction === "down") : !isTrendFlat(analysis));
    if (analysis.latestPeriodChange !== null && analysis.latestPeriodChange < -0.05 && declineIsReal) {
      actions.push(`Investigate the ${formatPercent(Math.abs(analysis.latestPeriodChange))} decline — check if it's seasonal or a structural problem.`);
    }
    if (reg.length >= 2) {
      const weak = reg[reg.length - 1];
      actions.push(`Review ${weak.label} (weakest ${regLabel} at ${fmt(weak.revenue)}) — apply the playbook from ${reg[0].label}.`);
    }
    // Momentum advice only when the verdict engine confirms a real upward trend — never off a
    // single-period delta (which is noise on a globally flat series).
    const momentumUp = trendVerdict ? (trendIsReal && trendVerdict.direction === "up") : (latestChangeComparable(findings) && analysis.latestPeriodChange !== null && analysis.latestPeriodChange > 0.05 && !isTrendFlat(analysis));
    if (momentumUp) {
      actions.push(`Capitalize on the confirmed upward trend — consider expanding top product lines.`);
    }
    return actions.length > 0
      ? `Based on your data:\n${actions.slice(0, 5).map((a, i) => `${i + 1}. ${a}`).join("\n")}`
      : "Your data looks healthy overall. Keep monitoring monthly for changes.";
  }

  // Summary / overview / how am I doing
  if (/summary|overview|everything|big picture|how.*doing|how.*business|status/.test(q) && !/(product|region|customer)/.test(q)) {
    const partial = partialPeriodNote(findings);
    const latestSuffix = analysis.latestPeriodChange === null
      ? ""
      : partial
        ? ` (${partial})`
        : ` (latest period ${analysis.latestPeriodChange >= 0 ? "↑" : "↓"} ${formatPercent(Math.abs(analysis.latestPeriodChange))} vs prior)`;
    const changeLine = trendVerdict
      ? ` Trend: ${trendVerdict.label}${latestSuffix}.`
      : analysis.latestPeriodChange !== null
        ? partial
          ? ` ${partial}.`
          : ` Trend: ${analysis.latestPeriodChange >= 0 ? "↑" : "↓"} ${formatPercent(Math.abs(analysis.latestPeriodChange))} vs last period.`
        : "";
    const topProd = prod[0] ? ` Top ${prodLabel}: ${prod[0].label} (${pct(prod[0].revenue, prodBase)}% of identified ${prodLabel} ${metric}).` : "";
    const topReg = reg[0] ? ` Top ${regLabel}: ${reg[0].label}.` : "";
    return `Total ${metric}: ${fmt(analysis.totalRevenue)} across ${analysis.rowCount.toLocaleString()} transactions. Average: ${fmt(analysis.averageRevenue)}.${changeLine}${topProd}${topReg}${reconTail}`;
  }

  // Named entity detection: check if a specific product/customer/region name is in the question
  for (const p of prod) {
    if (q.includes(p.label.toLowerCase())) {
      const rank = prod.indexOf(p) + 1;
      return `${p.label}: ${fmt(p.revenue)} (${pct(p.revenue, prodBase)}% of identified ${prodLabel} ${metric}). Ranked #${rank} of ${prod.length} ${prodLabel}s.`;
    }
  }
  for (const c of cust) {
    if (q.includes(c.label.toLowerCase())) {
      const rank = cust.indexOf(c) + 1;
      return `${c.label}: ${fmt(c.revenue)} total (${pct(c.revenue, custBase)}% of ${metric}). Ranked #${rank} of ${cust.length} ${custLabel}s.`;
    }
  }
  for (const r of reg) {
    if (q.includes(r.label.toLowerCase())) {
      const rank = reg.indexOf(r) + 1;
      return `${r.label}: ${fmt(r.revenue)} (${pct(r.revenue, regBase)}% of identified ${regLabel} ${metric}). Ranked #${rank} of ${reg.length} ${regLabel}s.`;
    }
  }

  // --- PRIORITY 2: Standard patterns ---

  // Total revenue
  if (/total revenue|how much|total sales/.test(q) && !/(product|region|customer)/.test(q)) {
    return `Total ${metric}: ${fmt(analysis.totalRevenue)} across ${analysis.rowCount.toLocaleString()} transactions.${reconTail}`;
  }
  // Average order
  if (/average order|avg transaction|per order|average transaction|avg order/.test(q)) {
    return `Average transaction value is ${fmt(analysis.averageRevenue)}.`;
  }
  // Best product
  if (/(best|top|#1|biggest|highest|leading) product/.test(q) || (q.includes("product") && /(best|top|#1)/.test(q))) {
    const top = prod[0];
    if (!top) return "Map a product column to identify the best product.";
    return `${top.label} leads with ${fmt(top.revenue)} (${pct(top.revenue, prodBase)}% of identified ${prodLabel} ${metric}).`;
  }
  // Worst product
  if (/(worst|bottom|lowest|weakest) product/.test(q)) {
    const last = prod[prod.length - 1];
    return last ? `${last.label} is the lowest performer at ${fmt(last.revenue)}.` : "Map a product column to compare products.";
  }
  // Best region
  if (/(best|top|#1|biggest|highest|leading) region/.test(q) || (q.includes("region") && /(best|top)/.test(q))) {
    const top = reg[0];
    return top ? `${top.label} is the top ${regLabel} with ${fmt(top.revenue)}.` : "Map a region column to compare regions.";
  }
  // Worst region
  if (/(worst|bottom|lowest|weakest) region/.test(q)) {
    const last = reg[reg.length - 1];
    return last ? `${last.label} is the weakest ${regLabel} at ${fmt(last.revenue)}.` : `Map a ${regLabel} column to compare ${regLabel}s.`;
  }
  // Top customer
  if (/(best|top|#1|biggest|highest) customer/.test(q) || /top.*customer/.test(q)) {
    const top = cust[0];
    return top ? `${top.label} is the top ${custLabel} at ${fmt(top.revenue)}.` : `Map a ${custLabel} column to identify top ${custLabel}s.`;
  }
  // Trend (checked AFTER forecast and driver)
  if (/trend|going up|going down|growing|declining|direction|over time|monthly|weekly/.test(q)) {
    if (analysis.latestPeriodChange !== null) {
      const peak = analysis.bestPeriod ? ` Peak: ${analysis.bestPeriod.label} (${fmt(analysis.bestPeriod.revenue)}).` : "";
      const latest = formatPercent(analysis.latestPeriodChange);
      const note = partialPeriodNote(findings);
      // When the final period is partial, its change is a truncation artifact — report the
      // trend verdict (computed on complete periods only) and flag the endpoint as incomplete.
      const latestClause = note
        ? `the ${note}`
        : `the latest period changed by ${latest} compared to the previous period`;
      if (trendVerdict) {
        if (!trendIsReal) {
          return note
            ? `${analysis.primaryMetric} shows ${trendVerdict.label} over the full period (${note}).${peak}`
            : `${analysis.primaryMetric} shows ${trendVerdict.label} over the full period — the latest period changed by ${latest} vs the previous one, but that's within the noise band, not a trend.${peak}`;
        }
        return `${analysis.primaryMetric} shows ${trendVerdict.label} — ${latestClause}.${peak}`;
      }
      if (isTrendFlat(analysis)) {
        return note
          ? `${analysis.primaryMetric} is roughly flat over the full period (${note}).${peak}`
          : `${analysis.primaryMetric} is roughly flat over the full period — the latest period changed by ${latest} vs the previous one, but that's normal variation, not a trend.${peak}`;
      }
      if (note) return `${analysis.primaryMetric} trend over the full period excludes the incomplete latest period (${note}).${peak}`;
      const dir = analysis.latestPeriodChange >= 0 ? "growing" : "declining";
      return `${analysis.primaryMetric} is ${dir} — latest period changed by ${latest} compared to the previous period.${peak}`;
    }
    return "Not enough periods to determine a trend. Upload data with at least 2 time periods.";
  }
  // Best period / peak
  if (/(best|peak|highest) (month|period|week|quarter)/.test(q)) {
    return analysis.bestPeriod ? `Best period was ${analysis.bestPeriod.label} with ${fmt(analysis.bestPeriod.revenue)}.` : "No periods detected.";
  }
  // Worst period
  if (/(worst|lowest|weakest) (month|period|week|quarter)/.test(q)) {
    const worst = [...analysis.periodRevenue].sort((a, b) => a.revenue - b.revenue)[0];
    return worst ? `Worst period was ${worst.label} with ${fmt(worst.revenue)}.` : "No periods detected.";
  }
  // At-risk customers
  if (/at risk|losing|churn|leaving|attention/.test(q)) {
    return "Check the Customer Health section on the Dashboard — it identifies customers who haven't purchased recently and may need re-engagement. Look for those marked 'Needs attention' or 'Slipping away'.";
  }
  // Customer health / segments
  if (/customer health|customer segment|how.*customers.*doing/.test(q)) {
    return "The Customer Health section on the Dashboard scores all customers by purchase recency, frequency, and spending. It groups them into: Best customers, Regulars, Promising, Needs attention, Slipping away, and Gone quiet.";
  }
  // Anomalies / outliers / spikes
  if (/anomal|outlier|unusual|spike|abnormal/.test(q)) {
    const n = analysis.outliers.length;
    if (n === 0) return "No unusual patterns detected in your data.";
    const top = analysis.outliers[0];
    return `Found ${n} unusual pattern${n > 1 ? "s" : ""}. Most notable: ${top.label} (${top.type === "high" ? "spike" : "drop"}) — ${top.context}`;
  }
  // Compare products
  if (/compare product|product vs|all product|product comparison/.test(q)) {
    if (prod.length === 0) return "Map a product column to compare products.";
    const top3 = prod.slice(0, 3);
    return `Top 3 ${prodLabel}s: ${top3.map((p, i) => `${i + 1}. ${p.label} (${fmt(p.revenue)})`).join(", ")}.`;
  }
  // Compare regions
  if (/compare region|region vs|all region|region comparison/.test(q)) {
    if (reg.length === 0) return "Map a region column to compare regions.";
    const top3 = reg.slice(0, 3);
    return `Top 3 ${regLabel}s: ${top3.map((r, i) => `${i + 1}. ${r.label} (${fmt(r.revenue)})`).join(", ")}.`;
  }
  // Concentration / dependence / diversification
  if (/concentrat|depend|diversif/.test(q)) {
    if (cust.length < 3) return "Need at least 3 customers to assess concentration.";
    const top3Rev = cust.slice(0, 3).reduce((s, c) => s + c.revenue, 0);
    const concPct = pct(top3Rev, custBase);
    return Number(concPct) > 50
      ? `Top 3 customers account for ${concPct}% of revenue — that's high concentration risk. Losing any one could significantly impact your business.`
      : `Top 3 customers account for ${concPct}% of revenue — reasonably diversified.`;
  }
  // ROI (junk/missing buckets are never named as a real product)
  if (/\broi\b|return on investment/.test(q) && realItems(analysis.roiByProduct).length > 0) {
    const realRoi = realItems(analysis.roiByProduct);
    const top = realRoi[0];
    const worst = [...realRoi].sort((a, b) => a.revenue - b.revenue)[0];
    let answer = `Best ROI: ${top.label} at ${top.revenue.toFixed(1)}%.`;
    if (worst && worst.revenue < 0) answer += ` Warning: ${worst.label} has negative ROI (${worst.revenue.toFixed(1)}%).`;
    const avg = realRoi.reduce((s, r) => s + r.revenue, 0) / realRoi.length;
    answer += ` Average ROI across all ${prodLabel}s: ${avg.toFixed(1)}%.`;
    return answer;
  }
  // Margin / profit
  if (/(margin|profit|cost)/.test(q) && !/product/.test(q)) {
    const top = realItems(analysis.marginByProduct)[0];
    return top ? `Best margin: ${top.label} at ${fmt(top.revenue)}. Map a cost column for detailed margin analysis.` : "Map a cost column to calculate margins.";
  }
  // Dataset info
  if (/how many row|how much data|dataset size|file size|how big/.test(q)) {
    return `Your dataset has ${analysis.rowCount.toLocaleString()} rows.`;
  }
  // Help / what can you do
  if (/what can you|help|what should i ask|what do you know/.test(q)) {
    return `I can answer questions about your ${metric}, ${prodLabel}s, ${regLabel}s, ${custLabel}s, trends, forecasts, anomalies, and concentration risk — all instantly without AI. Try: 'What's my total ${metric}?', 'Top ${prodLabel}s', 'Show me the trend', 'What's driving this?', 'What should I do?', 'Forecast next 3 months'.`;
  }
  // Legacy patterns
  if (q.includes("boss") || q.includes("client") || q.includes("email")) {
    return `Subject: ${settings.title || "Monthly performance report"} update. ${analysis.primaryMetric} reached ${fmt(analysis.totalRevenue)} across ${analysis.rowCount.toLocaleString()} transactions. ${analysis.bestPeriod?.label ?? "Best period"} led performance. Key focus: ${prod[0]?.label ?? `top ${prodLabel}`} and ${reg[0]?.label ?? `top ${regLabel}`}.`;
  }
  if (q.includes("manager")) {
    return createExecutiveSummary(analysis, settings, mapping, findings);
  }
  if (/change|increase|decrease/.test(q) && !/what.*change/.test(q)) {
    if (!analysis.latestPeriod || !analysis.previousPeriod || analysis.latestPeriodChange === null) return "Not enough periods to explain period-over-period change.";
    const note = partialPeriodNote(findings);
    if (note) return `The ${note}: ${analysis.latestPeriod.label} only partially covers its period, so its ${formatPercent(analysis.latestPeriodChange)} move vs ${analysis.previousPeriod.label} is not a like-for-like comparison.`;
    return `${analysis.latestPeriod.label} changed by ${formatPercent(analysis.latestPeriodChange)} compared with ${analysis.previousPeriod.label} (${fmt(analysis.previousPeriod.revenue)} → ${fmt(analysis.latestPeriod.revenue)}).`;
  }
  // Fallback — helpful message with AI upsell
  if (isRepeat) {
    return `I've already answered a similar question. Try asking about a different angle — like a specific product, region, or customer name. Or connect an AI provider for deeper natural language analysis.`;
  }
  return `I couldn't find a specific answer for that using built-in analysis. I can answer questions about: total ${metric}, top/worst ${prodLabel}s, ${regLabel}s, ${custLabel}s, trends, forecasts, anomalies, concentration risk, and recommendations. For deeper questions, connect an AI provider above.`;
}

export function getRecommendedActions(analysis: Analysis, settings: ReportSettings, findings?: Findings | null) {
  // Junk/missing buckets are never offered as a real entity to act on.
  const topProduct = realItems(analysis.productRevenue)[0] ?? null;
  const topRegion = realItems(analysis.regionRevenue)[0] ?? null;
  const latestChange = analysis.latestPeriodChange;
  const actions = [
    {
      label: "Focus",
      title: topProduct ? `Protect ${topProduct.label}` : "Map product data",
      detail: topProduct
        ? `${topProduct.label} is the largest mapped product at ${formatMoney(topProduct.revenue, settings.currency)}. Review stock, pricing, and campaign support.`
        : "Map a product column to identify where revenue is concentrated."
    },
    {
      label: "Growth",
      title: topRegion ? `Review ${topRegion.label}` : "Map region data",
      detail: topRegion
        ? `${topRegion.label} leads mapped regional revenue. Compare its playbook against weaker regions.`
        : "Map a region column to identify the strongest and weakest markets."
    },
    (() => {
      // The trend verdict is the single source of truth — never the isTrendFlat heuristic.
      // When findings deems the series flat (normal variation), say so plainly; the word
      // "momentum" is reserved for a verdict that is actually significant.
      const trend = findings?.trend ?? null;
      const isReal = trend ? trend.isSignificant : !isTrendFlat(analysis);
      // A truncated final period's change is a truncation artifact — quote the incomplete note
      // instead of the bogus percent so no card narrates a fake move.
      const partial = partialPeriodNote(findings);
      const latestPhrase = partial ? partial : `latest ${formatPercent(latestChange ?? 0)}`;
      if (latestChange === null) {
        return { label: "Trend", title: "Add more periods", detail: "More dated rows are needed for reliable period-over-period movement." };
      }
      if (trend && !isReal) {
        return {
          label: "Trend",
          title: "Trend is normal variation",
          detail: `The series shows ${trend.label} — period-to-period moves (${latestPhrase}) are within the noise band, not a real trend. Don't plan around them.`,
        };
      }
      if (!isReal) {
        return { label: "Trend", title: "Trend is essentially flat", detail: `${partial ? `The ${partial}; the` : `Latest period moved ${formatPercent(latestChange)} vs the prior one, but the`} full series is flat — treat this as normal variation, not a trend.` };
      }
      const down = trend ? trend.direction === "down" : latestChange < 0;
      return {
        label: down ? "Risk" : "Momentum",
        title: down ? "Investigate the decline" : "Use the upward trend",
        detail: `The series shows a real ${trend ? trend.label : down ? "downward trend" : "upward trend"} (${latestPhrase}). Use this as the first discussion point in the report.`,
      };
    })()
  ];

  return actions;
}

function buildInsights(
  totalRevenue: number,
  bestPeriod: RankedItem | null,
  productRevenue: RankedItem[],
  regionRevenue: RankedItem[],
  isMoney = true
) {
  // Never name a junk/missing bucket as the top product/region.
  const topProduct = realItems(productRevenue)[0];
  const topRegion = realItems(regionRevenue)[0];
  const fmt = (v: number) => isMoney ? formatMoney(v) : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return [
    `Mapped ${isMoney ? "revenue" : "value"} totals ${fmt(totalRevenue)}.`,
    bestPeriod ? `${bestPeriod.label} is the best period at ${fmt(bestPeriod.revenue)}.` : "",
    topProduct ? `${topProduct.label} is the top product.` : "",
    topRegion ? `${topRegion.label} is the strongest region.` : ""
  ].filter(Boolean);
}

export function generateSmartInsights(analysis: Analysis, settings: ReportSettings, rows?: Record<string, string>[], mapping?: Mapping, findings?: Findings | null, profiles: ColumnProfile[] = []): SmartInsight[] {
  const insights: SmartInsight[] = [];
  const metric = analysis.primaryMetric;
  const cur = settings.currency;
  // Money unless the metric is a plain count OR a units column mislabelled as revenue — read the
  // single source of truth (analysis.isMoney) so every caller agrees, no currency symbol on units.
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, cur) : v.toLocaleString(undefined, { maximumFractionDigits: metric === "Count" ? 0 : 1 });
  const custLabel = mapping ? getDimensionLabel("customer", mapping, settings.template).toLowerCase() : "customer";
  const prodLabel = mapping ? getDimensionLabel("product", mapping, settings.template).toLowerCase() : "product";

  // 1. Headline number
  insights.push({
    type: "headline",
    text: `Total ${metric.toLowerCase()}: ${fmt(analysis.totalRevenue)}`,
    importance: "high",
  });

  // 2. Top performer (skip Missing/Invalid bucket) — share is of identified product revenue
  if (analysis.productRevenue.length > 0) {
    const top = analysis.productRevenue.find((p) => p.label !== INVALID_BUCKET) ?? analysis.productRevenue[0];
    const base = identifiedProductRevenue(analysis);
    const topPct = base > 0 ? ((top.revenue / base) * 100).toFixed(1) : "0";
    insights.push({
      type: "top_performer",
      text: `${top.label} leads with ${fmt(top.revenue)} (${topPct}% of identified product ${metric.toLowerCase()})`,
      importance: "high",
    });
  }

  // 3. Concentration risk (skip Missing/Invalid bucket)
  if (realItems(analysis.customerRevenue).length >= 3) {
    const validCustomers = realItems(analysis.customerRevenue);
    const custConcBase = identifiedTotal(analysis.customerRevenue, analysis.totalRevenue);
    const top3 = validCustomers.slice(0, 3);
    const top3Pct = custConcBase > 0
      ? ((top3.reduce((s, c) => s + c.revenue, 0) / custConcBase) * 100).toFixed(0)
      : "0";
    const isRisk = Number(top3Pct) > 60;
    insights.push({
      type: "risk",
      text: isRisk
        ? `⚠️ Top 3 ${custLabel}s = ${top3Pct}% of total — high concentration risk`
        : `✓ ${metric} spread across ${custLabel}s (top 3 = ${top3Pct}%)`,
      importance: "high",
      sentiment: isRisk ? "negative" : "positive",
    });
  }

  // 4. Gap analysis (skip Missing/Invalid bucket). A "standout leader" claim must clear the
  // multiple-comparison-corrected entity test — a raw 2× gap between #1 and #2 fires by chance
  // on any wide catalog. When findings is absent, fall back to the raw ratio.
  if (analysis.productRevenue.length >= 2) {
    const validProducts = analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET);
    if (validProducts.length >= 2) {
      const gap = validProducts[0].revenue / (validProducts[1].revenue || 1);
      const leaderIsReal = findings
        ? findings.entitySignals.highs.includes(validProducts[0].label)
        : gap > 2;
      if (gap > 2 && leaderIsReal) {
        insights.push({
          type: "gap",
          text: `${validProducts[0].label} is ${gap.toFixed(1)}x larger than #2 (${validProducts[1].label})`,
          importance: "medium",
        });
      }
    }
  }

  // 5. Below-average count (over identified products only — junk excluded)
  {
    const realProducts = analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET);
    if (realProducts.length >= 3) {
      const avg = identifiedProductRevenue(analysis) / realProducts.length;
      const below = realProducts.filter((p) => p.revenue < avg);
      if (below.length > 0) {
        insights.push({
          type: "underperformers",
          text: `${below.length} of ${realProducts.length} ${prodLabel}s below average (${fmt(avg)})`,
          importance: "medium",
        });
      }
    }
  }

  // 6. Trend direction — period-over-period, but reconciled with the full-span trend so a single
  // step never reads as sustained growth when the series is actually flat.
  if (analysis.latestPeriodChange !== null && analysis.periodRevenue.length >= 2) {
    const partial = partialPeriodNote(findings);
    // A partial final period's % is a truncation artifact — show the incomplete note instead.
    const pct = formatPercent(analysis.latestPeriodChange);
    const latestPhrase = partial ? partial : `latest period ${pct} vs previous`;
    const trendVerdict = findings?.trend ?? null;
    const trendIsReal = trendVerdict ? trendVerdict.isSignificant : !isTrendFlat(analysis);
    if (!trendIsReal) {
      insights.push({
        type: "trend",
        text: trendVerdict
          ? `${metric} shows ${trendVerdict.label} overall; ${latestPhrase}`
          : `${metric} is roughly flat overall; ${latestPhrase}`,
        importance: "high",
        sentiment: "neutral",
      });
    } else {
      const dir = trendVerdict ? (trendVerdict.direction === "down" ? "declining" : "growing") : (analysis.latestPeriodChange >= 0 ? "growing" : "declining");
      const sentiment: SmartInsight["sentiment"] = trendTone(analysis.latestPeriodChange, settings.template);
      insights.push({
        type: "trend",
        text: trendVerdict
          ? `${metric} shows ${trendVerdict.label} (${dir}); ${latestPhrase}`
          : `${metric} is ${dir} at ${pct} vs previous period`,
        importance: "high",
        sentiment,
      });
    }
  }

  // 7. Outlier detection
  if (analysis.outliers.length > 0) {
    const o = analysis.outliers[0];
    insights.push({
      type: "outlier",
      text: `${o.label} is an outlier (${o.type === "high" ? "unusually high" : "unusually low"}) — ${o.context}`,
      importance: "medium",
    });
  }

  // 8. Period comparison (best vs latest)
  if (analysis.bestPeriod && analysis.latestPeriod && analysis.bestPeriod.label !== analysis.latestPeriod.label) {
    const diff = analysis.bestPeriod.revenue - analysis.latestPeriod.revenue;
    if (diff > 0 && analysis.latestPeriod.revenue > 0) {
      const pctOff = ((diff / analysis.bestPeriod.revenue) * 100).toFixed(0);
      insights.push({
        type: "comparison",
        text: `Latest period is ${pctOff}% below peak (${analysis.bestPeriod.label})`,
        importance: "medium",
        sentiment: "negative",
      });
    }
  }

  // 9. Correlation-based insights
  if (rows && rows.length > 5 && mapping) {
    const discountCol = mapping.discount;
    const qtyCol = mapping.quantity;
    const revCol = mapping.revenue;
    if (discountCol && qtyCol) {
      const r = computeCorrelation(rows, discountCol, qtyCol);
      if (r > 0.5) insights.push({ type: "correlation", text: "Higher discounts drive more orders", importance: "medium", sentiment: "neutral" });
    }
    if (discountCol && revCol) {
      const r = computeCorrelation(rows, discountCol, revCol);
      if (r < -0.3) insights.push({ type: "correlation", text: "⚠️ Discounts may be hurting revenue", importance: "high", sentiment: "negative" });
    }
  }

  // 10. Profit / loss-maker warnings
  if (analysis.totalProfit !== null && analysis.profitByProduct.length > 0) {
    const lossMakers = analysis.profitByProduct.filter((p) => p.revenue < 0);
    if (lossMakers.length > 0) {
      const worst = lossMakers[lossMakers.length - 1];
      const salesForWorst = analysis.productRevenue.find((p) => p.label === worst.label);
      const salesStr = salesForWorst ? ` despite ${fmt(salesForWorst.revenue)} in sales` : "";
      insights.push({
        type: "risk",
        text: `${worst.label} loses money: ${fmt(worst.revenue)}${salesStr}`,
        importance: "high",
        sentiment: "negative",
      });
    }
    if (analysis.totalProfit > 0 && analysis.totalRevenue > 0) {
      const margin = ((analysis.totalProfit / analysis.totalRevenue) * 100).toFixed(1);
      insights.push({
        type: "headline",
        text: `Overall profit margin: ${margin}%`,
        importance: "medium",
        sentiment: Number(margin) >= 10 ? "positive" : "neutral",
      });
    }
  }

  return insights;
}

function getDisplayInsights(analysis: Analysis, settings: ReportSettings) {
  const smart = generateSmartInsights(analysis, settings);
  return smart.slice(0, 6).map((i) => i.text);
}

export function createExecutiveSummary(analysis: Analysis, settings?: ReportSettings, mapping?: Mapping, findings?: Findings | null) {
  const metric = analysis.primaryMetric.toLowerCase();
  const cur = settings?.currency;
  // Read Analysis.isMoney so a units column (e.g. Global_Sales) renders as a plain number, never $.
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, cur) : v.toLocaleString(undefined, { maximumFractionDigits: metric === "count" ? 0 : 1 });
  const parts: string[] = [];
  const periods = analysis.periodRevenue.length;
  const prodLabel = mapping ? getDimensionLabel("product", mapping, settings?.template).toLowerCase() : "product";
  const custLabel = mapping ? getDimensionLabel("customer", mapping, settings?.template).toLowerCase() : "customer";
  const regLabel = mapping ? getDimensionLabel("region", mapping, settings?.template).toLowerCase() : "region";
  // Per-dimension identified totals (junk excluded) — shares use these, never global total.
  const prodBaseEx = identifiedTotal(analysis.productRevenue, analysis.totalRevenue);
  const regBaseEx = identifiedTotal(analysis.regionRevenue, analysis.totalRevenue);

  let overview = `Total ${metric} reached ${fmt(analysis.totalRevenue)} across ${analysis.rowCount.toLocaleString()} transactions`;
  if (periods > 0) overview += ` spanning ${periods} months`;
  if (analysis.latestPeriodChange !== null) {
    // Prefer the statistical trend verdict (Findings) over the single-step heuristic so the
    // summary uses the same words as the forecast outlook and trend section.
    const verdictFlat = findings ? findings.trend.label === "normal variation" : isTrendFlat(analysis);
    // A truncated final period's change is a truncation artifact — flag it as incomplete
    // rather than quoting a percent that contradicts the verdict.
    const partial = partialPeriodNote(findings);
    const latestParen = partial ? partial : `latest period ${formatPercent(analysis.latestPeriodChange)} vs the prior one`;
    if (verdictFlat) {
      overview += `, holding roughly flat across the period (normal variation, not a real trend; ${latestParen})`;
    } else {
      const up = findings ? findings.trend.direction === "up" : analysis.latestPeriodChange >= 0;
      const metricDir = settings ? TEMPLATE_CONFIG[settings.template].metricDirection : "up_is_good";
      const isGood = metricDir === "down_is_good" ? !up : metricDir === "up_is_good" ? up : true;
      const label = findings ? findings.trend.label : up ? "upward trend" : "downward trend";
      const dir = isGood ? "positive trajectory" : "concerning trend";
      const movePhrase = partial ? partial : `${up ? "growing" : "dropping"} ${formatPercent(analysis.latestPeriodChange)} in the latest period`;
      overview += `, on a ${label} (${movePhrase}) — a ${dir}`;
    }
  }
  overview += ".";
  parts.push(overview);

  const realProd = realItems(analysis.productRevenue);
  const top1 = realProd[0];
  const top2 = realProd[1];
  const top3 = realProd[2];
  if (top1 && prodBaseEx > 0) {
    const pct = (top1.revenue / prodBaseEx) * 100;
    const judgment = pct > 40 ? "carrying significant weight" : pct > 20 ? "leading well" : "part of a well-diversified mix";
    let line = `${top1.label} drives ${pct.toFixed(0)}% of identified ${prodLabel} ${metric} — ${judgment}`;
    if (top2 && top3) line += `, followed by ${top2.label} and ${top3.label}`;
    else if (top2) line += `, followed by ${top2.label}`;
    parts.push(line + ".");
  }

  const realCust = realItems(analysis.customerRevenue);
  const custBaseEx = identifiedTotal(analysis.customerRevenue, analysis.totalRevenue);
  const top1Customer = realCust[0];
  if (top1Customer && custBaseEx > 0) {
    const cPct = (top1Customer.revenue / custBaseEx) * 100;
    const top3CustPct = realCust.slice(0, 3).reduce((s, c) => s + c.revenue, 0) / custBaseEx * 100;
    if (top3CustPct > 50) {
      parts.push(`Biggest risk: ${top3CustPct.toFixed(0)}% of ${metric} comes from just 3 ${custLabel}s — if ${top1Customer.label} leaves, you lose ${cPct.toFixed(0)}% overnight.`);
    } else if (cPct > 25) {
      parts.push(`Watch ${custLabel} concentration: ${top1Customer.label} alone accounts for ${cPct.toFixed(0)}% of ${metric}.`);
    }
  }

  const top1Region = realItems(analysis.regionRevenue)[0];
  // Trend claims here defer to the verdict engine (Findings) when available, matching the
  // overview/forecast/dashboard wording instead of the single-step heuristic.
  const realDecline = findings ? (findings.trend.isSignificant && findings.trend.direction === "down") : !isTrendFlat(analysis);
  const realUp = findings ? (findings.trend.isSignificant && findings.trend.direction === "up") : !isTrendFlat(analysis);
  if (analysis.latestPeriodChange !== null && analysis.latestPeriodChange < -0.1 && realDecline) {
    const worstProduct = [...realProd].sort((a, b) => a.revenue - b.revenue)[0];
    parts.push(`${analysis.primaryMetric} has been declining${worstProduct ? ` — ${worstProduct.label} is the weakest ${prodLabel} and needs investigation` : ""}.`);
  } else if (top1Region && regBaseEx > 0) {
    const rPct = (top1Region.revenue / regBaseEx) * 100;
    parts.push(`${top1Region.label} leads at ${rPct.toFixed(0)}% of identified ${regLabel} ${metric}${analysis.latestPeriodChange !== null && analysis.latestPeriodChange >= 0 && realUp ? " — the upward momentum is encouraging" : ""}.`);
  }

  if (analysis.totalProfit !== null && analysis.totalRevenue > 0) {
    const margin = ((analysis.totalProfit / analysis.totalRevenue) * 100).toFixed(1);
    const lossMakers = analysis.profitByProduct.filter((p) => p.revenue < 0);
    let profitLine = `Overall profit margin is ${margin}%`;
    if (lossMakers.length > 0) {
      const top3Loss = lossMakers.slice(-3).reverse();
      const lossNames = top3Loss.map((p) => `${p.label} (${fmt(p.revenue)})`).join(", ");
      profitLine += ` — but ${lossMakers.length} ${prodLabel}${lossMakers.length > 1 ? "s are" : " is"} loss-making: ${lossNames}. These need pricing review`;
    }
    parts.push(profitLine + ".");
  }

  if (realItems(analysis.roiByProduct).length > 0) {
    const realRoi = realItems(analysis.roiByProduct);
    const bestRoi = realRoi[0];
    const negativeRoi = realRoi.filter((r) => r.revenue < 0);
    let roiLine = `Best ROI: ${bestRoi.label} at ${bestRoi.revenue.toFixed(1)}%`;
    if (negativeRoi.length > 0) {
      roiLine += ` — ${negativeRoi.length} ${prodLabel}${negativeRoi.length > 1 ? "s" : ""} showing negative ROI and need review`;
    }
    parts.push(roiLine + ".");
  }

  return parts.join("\n\n");
}

function getSmartSuggestions(mapping: Record<Role, string>, analysis: Analysis | null): { label: string; prompt: string }[] {
  const suggestions: { label: string; prompt: string }[] = [];
  const value = mapping.revenue || mapping.quantity || mapping.cost || "";
  const metric = mapping.revenue ? "revenue" : mapping.quantity ? "quantity" : mapping.cost ? "cost" : "values";

  if (mapping.product && value) {
    suggestions.push({ label: `Compare ${mapping.product}`, prompt: `Compare all ${mapping.product} values by ${metric}. Show a bar chart.` });
  }
  if (mapping.region && value) {
    suggestions.push({ label: `${mapping.region} breakdown`, prompt: `Show a pie chart of ${metric} share by ${mapping.region}.` });
  }
  if (mapping.customer && value) {
    suggestions.push({ label: `Top ${mapping.customer}`, prompt: `Which ${mapping.customer} is most valuable? Analyze concentration risk. Give exact numbers.` });
  }
  if (mapping.date && value) {
    suggestions.push({ label: `${metric} trend`, prompt: `Show a line chart of ${metric} trend over time by period.` });
  }
  if (mapping.product && mapping.region && value) {
    suggestions.push({ label: `${mapping.product} x ${mapping.region}`, prompt: `Create a pivot table showing ${metric} by ${mapping.product} and ${mapping.region}.` });
  }
  if (value && analysis && analysis.rowCount > 0) {
    suggestions.push({ label: "Find anomalies", prompt: "Look for anomalies, outliers, or unusual patterns in this data. Flag anything suspicious with exact numbers." });
  }
  if (suggestions.length === 0) {
    suggestions.push(
      { label: "Summarize data", prompt: "Summarize this dataset. What are the key numbers and patterns?" },
      { label: "Find patterns", prompt: "What patterns or trends do you see in this data? Give specific numbers." },
      { label: "Top values", prompt: "What are the top values in this data? Show a bar chart." },
    );
  }
  return suggestions.slice(0, 6);
}

function getFollowUpSuggestions(lastMessage: string, analysis: Analysis | null, chatHistory?: ChatMessage[]): { label: string; prompt: string }[] {
  if (!lastMessage || !analysis) return [];
  const lower = lastMessage.toLowerCase();
  const followUps: { label: string; prompt: string }[] = [];

  // Track what's already been asked to avoid repeating suggestions
  const allAsked = (chatHistory ?? []).filter((m) => m.role === "user").map((m) => m.text.toLowerCase());
  const wasAsked = (keyword: RegExp) => allAsked.some((a) => keyword.test(a));

  // After product mention → ask for trend or customer breakdown
  for (const p of analysis.productRevenue.slice(0, 5)) {
    if (lower.includes(p.label.toLowerCase())) {
      followUps.push({ label: `${p.label} trend`, prompt: `Show me ${p.label}'s trend over time as a line chart.` });
      followUps.push({ label: `Who buys ${p.label}?`, prompt: `Which customers buy ${p.label} the most? Show a breakdown.` });
      break;
    }
  }

  // After ranking → ask for bottom performers
  if (/top|best|highest|leading|#1/.test(lower) && !wasAsked(/worst|bottom|lowest/)) {
    followUps.push({ label: "Bottom performers", prompt: "What about the bottom performers? Show the worst performing items." });
  }

  // After risk/warning → ask for action
  if (/risk|warning|concern|decline|drop|decrease|attention/.test(lower) && !wasAsked(/should i|recommend|action|what.*do/)) {
    followUps.push({ label: "What should I do?", prompt: "What specific actions should I take to address these risks?" });
  }

  // After trend → ask what's driving it and forecast
  if (/trend|growing|declining|increasing|decreasing|period/.test(lower)) {
    if (!wasAsked(/driving|cause|why|factor|break.*down/)) {
      followUps.push({ label: "What's driving this?", prompt: "What's driving this trend? Break down the contributing factors." });
    }
    if (!wasAsked(/forecast|predict|next.*month|projection/)) {
      followUps.push({ label: "Forecast next 3 months", prompt: "Based on this data, forecast the next 3 months." });
    }
  }

  // After driver/cause → suggest actions or forecast
  if (/driver|driving|factor|cause|breakdown|contribut/.test(lower)) {
    if (!wasAsked(/should i|recommend|action|what.*do/)) {
      followUps.push({ label: "What should I do?", prompt: "Based on these findings, what actions should I take?" });
    }
    const topRealProduct = realItems(analysis.productRevenue)[0];
    if (topRealProduct && !wasAsked(new RegExp(topRealProduct.label.toLowerCase()))) {
      followUps.push({ label: `Deep dive: ${topRealProduct.label}`, prompt: `Tell me more about ${topRealProduct.label}` });
    }
  }

  // After forecast → suggest actions or risk check
  if (/forecast|projected|next period|prediction/.test(lower)) {
    if (!wasAsked(/risk|anomal|unusual|concern/)) {
      followUps.push({ label: "Any risks to watch?", prompt: "Are there any risks or anomalies I should watch out for?" });
    }
    if (!wasAsked(/should i|recommend|action|what.*do/)) {
      followUps.push({ label: "What should I do?", prompt: "What actions should I take based on this forecast?" });
    }
  }

  // After any answer with no specific follow-ups → generic useful next steps
  if (followUps.length === 0) {
    if (!wasAsked(/summary|overview|big picture/)) {
      followUps.push({ label: "Full overview", prompt: "Give me a complete overview of my data." });
    }
    if (analysis.productRevenue[0] && !wasAsked(/compare product|all product/)) {
      followUps.push({ label: "Compare products", prompt: "Compare all products side by side." });
    }
    if (!wasAsked(/concentrat|depend|diversif/)) {
      followUps.push({ label: "Concentration risk", prompt: "How concentrated is my customer base? Am I too dependent on a few customers?" });
    }
  }

  return followUps.slice(0, 3);
}

function downloadCsv(rows: Record<string, string>[], fileName: string) {
  const headers = Object.keys(rows[0] ?? {});
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header] ?? "")).join(","))
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeCsvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function stripExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "");
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function formatMoney(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

// `style:"percent"` multiplies by 100, so `value` MUST be a 0–1 fraction. Passing an
// already-×100 number double-scales (14.2 → "1,420%"). Exported for the convention regression.
export function formatPercent(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1
  }).format(value);
}

function formatDateTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function buildAnalysisContext(analysis: Analysis, settings: ReportSettings, dataSet: DataSet | null, mapping?: Mapping): string {
  const cur = settings.currency;
  const fmt = (v: number) => analysis.isMoney ? formatMoney(v, cur) : v.toLocaleString(undefined, { maximumFractionDigits: analysis.primaryMetric === "Count" ? 0 : 1 });
  const pct = (v: number) => v.toFixed(1) + "%";
  const lines: string[] = [
    `Report: ${settings.title || "Data Analysis Report"}`,
    settings.company ? `Company: ${settings.company}` : "",
    `Currency: ${cur}`,
    "",
    "=== PRE-COMPUTED METRICS (use ONLY these numbers) ===",
    "",
    "--- TOTALS ---",
    `Total ${analysis.primaryMetric}: ${fmt(analysis.totalRevenue)}`,
    `Rows analyzed: ${analysis.rowCount}`,
    `Average per row: ${fmt(analysis.averageRevenue)}`,
  ];

  if (analysis.totalProfit !== null) {
    const margin = analysis.totalRevenue > 0 ? (analysis.totalProfit / analysis.totalRevenue) * 100 : 0;
    lines.push(
      `Total Profit: ${fmt(analysis.totalProfit)}`,
      `Profit Margin: ${pct(margin)}`,
    );
  }

  if (analysis.periodRevenue.length > 0) {
    lines.push("", "--- PERIOD TREND (listed chronologically; first row is the START of the series, NOT the peak) ---");
    for (const p of analysis.periodRevenue) lines.push(`${p.label}: ${fmt(p.revenue)}`);
    if (analysis.latestPeriodChange !== null) lines.push(`Latest period change: ${formatPercent(analysis.latestPeriodChange)}`);
    const worstPeriod = [...analysis.periodRevenue].sort((a, b) => a.revenue - b.revenue)[0];
    if (analysis.bestPeriod) lines.push(`PEAK period (highest revenue): ${analysis.bestPeriod.label} at ${fmt(analysis.bestPeriod.revenue)} — only this period may be called the peak.`);
    if (worstPeriod) lines.push(`LOWEST period: ${worstPeriod.label} at ${fmt(worstPeriod.revenue)}.`);
  }

  const realProductsCtx = analysis.productRevenue.filter((p) => p.label !== INVALID_BUCKET);
  if (realProductsCtx.length > 0) {
    const identifiedRev = identifiedProductRevenue(analysis);
    const excludedRev = excludedItemRevenue(analysis);
    lines.push("", "--- BY PRODUCT (revenue, profit, margin%) ---");
    lines.push(`Identified product revenue (share denominator): ${fmt(identifiedRev)} across ${realProductsCtx.length} products.`);
    lines.push("Express every product share as a percentage of identified product revenue, NOT of total revenue.");
    if (excludedRev > 0) lines.push(`Excluded: ${fmt(excludedRev)} from unidentified/junk items — never list "Missing", "Invalid", "Unknown", or "ERROR" as a product.`);
    for (const p of realProductsCtx.slice(0, 10)) {
      const profitItem = analysis.profitByProduct.find((x) => x.label === p.label);
      const profit = profitItem?.revenue;
      const marginPct = profit !== undefined && p.revenue !== 0 ? (profit / p.revenue) * 100 : null;
      const isLoss = profit !== undefined && profit < 0;
      const sharePct = identifiedRev > 0 ? (p.revenue / identifiedRev) * 100 : 0;
      let line = `${p.label}: revenue=${fmt(p.revenue)} (${pct(sharePct)} of identified product revenue)`;
      if (profit !== undefined) line += `, profit=${fmt(profit)}, margin=${pct(marginPct!)}${isLoss ? " [LOSS-MAKING]" : ""}`;
      lines.push(line);
    }
  }

  if (analysis.profitByProduct.length > 0) {
    const lossMakers = analysis.profitByProduct.filter((p) => p.revenue < 0);
    if (lossMakers.length > 0) {
      lines.push("", "--- LOSS-MAKING ITEMS (negative profit) ---");
      for (const lm of lossMakers) lines.push(`${lm.label}: LOSES ${fmt(Math.abs(lm.revenue))}`);
    }
  }

  const realRegionsCtx = realItems(analysis.regionRevenue);
  if (realRegionsCtx.length > 0) {
    const regionBase = identifiedTotal(analysis.regionRevenue, analysis.totalRevenue);
    const excludedRegion = Math.abs(analysis.regionRevenue.find((r) => r.label === INVALID_BUCKET)?.revenue ?? 0);
    lines.push("", "--- BY REGION (share = % of identified region revenue) ---");
    lines.push(`Identified region revenue (share denominator): ${fmt(regionBase)}.`);
    if (excludedRegion > 0) lines.push(`Excluded: ${fmt(excludedRegion)} with no/invalid location — report as a labeled exclusion, never as a region and never as "the highest region".`);
    for (const r of realRegionsCtx.slice(0, 8)) {
      const sharePct = regionBase > 0 ? (r.revenue / regionBase) * 100 : 0;
      lines.push(`${r.label}: ${fmt(r.revenue)} (${pct(sharePct)} of identified region revenue)`);
    }
  }

  const realCustomersCtx = realItems(analysis.customerRevenue);
  if (realCustomersCtx.length > 0) {
    lines.push("", "--- TOP CUSTOMERS ---");
    for (const c of realCustomersCtx.slice(0, 8)) lines.push(`${c.label}: ${fmt(c.revenue)}`);
  }

  if (analysis.roiByProduct.length > 0) {
    lines.push("", "--- ROI BY PRODUCT (pre-computed) ---");
    for (const r of analysis.roiByProduct.slice(0, 8)) lines.push(`${r.label}: ${pct(r.revenue)} ROI`);
  }

  if (dataSet) {
    lines.push(
      "",
      "--- DATA QUALITY ---",
      `Source: ${dataSet.fileName}, ${dataSet.quality.totalRows} rows, ${dataSet.quality.blankRows} blank, ${dataSet.quality.duplicateRows} duplicates`
    );
  }

  // Layer 3 — append the deterministic narration contract so the LLM gates its language
  // on the same significance verdicts the dashboard does. Built from raw rows+mapping so
  // it is independent of the descriptive aggregates above.
  if (mapping && dataSet) {
    try {
      const findings = buildFindings(dataSet.rows, mapping);
      lines.push("", buildNarrationContract(findings));
    } catch {
      // Findings are advisory; never block context assembly on a stats failure.
    }
  }

  return lines.filter(Boolean).join("\n");
}

const AI_SYSTEM_PROMPT = `You are a sharp business data analyst embedded in a spreadsheet analysis tool. The user has uploaded a spreadsheet and the tool has pre-computed all metrics for you.

CRITICAL ACCURACY RULES (MUST follow):
- Use ONLY numbers from the "PRE-COMPUTED METRICS" section below. Every figure you write MUST appear in the provided data.
- NEVER calculate, estimate, or derive any number yourself. No arithmetic. No ROI computation. No margin computation.
- If you need profit, margin%, or ROI — read the provided value. Do NOT compute it from revenue and cost.
- A negative profit means a LOSS. Never call a loss a "margin" or "high margin". Say "loses money" or "loss of $X".
- Items marked [LOSS-MAKING] are unprofitable. Never describe them positively.
- If a number is not in the provided data, do not mention it. It is better to say less than to invent a figure.
- Before writing any number, verify it appears in the data below. If it doesn't, remove it.

RESPONSE FORMAT (follow exactly):
FINDING: [One sentence — the key takeaway from the data]
DETAIL: [2-3 sentences explaining the finding with specific numbers from the data]
ACTION: [One sentence — what the user should do about this finding]

RULES:
- Never exceed 5 sentences total unless the user asks for a detailed report.
- Be direct and specific. Reference actual column names and values.
- Use the user's currency format consistently.
- When asked for emails or summaries, write them in a professional tone ready to send.
- When asked for recommendations, give specific, numbered actions.

CHART CREATION:
When the user asks for a chart, visualization, pivot, or breakdown, include a JSON chart command block in your response AFTER the text. Format:

\`\`\`chart
{"type":"bar","title":"Revenue by Product","data":[{"label":"Product A","value":5000},{"label":"Product B","value":3000}]}
\`\`\`

Supported chart types: "bar", "pie", "donut", "scatter", "line", "table", "pivot"
- "donut" is a pie chart with a hole — use for share/proportion views.
- "scatter" is for showing distribution or correlation — plot individual data points.
- For "pivot" type, include a "group" field in each data item for the column grouping.
- Use ONLY numbers from the provided data. Never compute chart values yourself.
- If the user says "show me", "chart", "visualize", "graph", "plot", "pivot", "breakdown by", always generate a chart block.`;

function getProviderHint(provider: AIProvider): string {
  switch (provider) {
    case "openai":
      return "Get your API key from platform.openai.com/api-keys. Cost: ~$0.01-0.05 per query.";
    case "gemini":
      return "Get your API key from aistudio.google.com/apikey. Free tier available.";
    case "groq":
      return "Get your API key from console.groq.com/keys. Free tier available with fast inference.";
    case "openrouter":
      return "Get your API key from openrouter.ai/keys. Access Claude, GPT, Gemini, Llama, and more with one key.";
    case "deepseek":
      return "Get your API key from platform.deepseek.com/api-keys. Very affordable pricing.";
    case "mistral":
      return "Get your API key from console.mistral.ai/api-keys. Free tier available for small models.";
  }
}

const OPENAI_COMPATIBLE_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions"
};

async function callOpenAICompatible(
  endpoint: string,
  model: string,
  apiKey: string,
  systemMessage: string,
  question: string,
  providerLabel: string,
  maxTokens = 1000
): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: question }
      ],
      temperature: 0.3,
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      (errorData as Record<string, Record<string, string>>)?.error?.message ||
        `${providerLabel} API error (${response.status})`
    );
  }

  const data = await response.json();
  return (data as { choices: { message: { content: string } }[] }).choices[0]?.message?.content ?? "No response from AI.";
}

async function callAI(
  question: string,
  analysis: Analysis,
  settings: ReportSettings,
  aiSettings: AISettings,
  dataSet: DataSet | null,
  maxTokens = 1000,
  mapping?: Mapping
): Promise<string> {
  const context = buildAnalysisContext(analysis, settings, dataSet, mapping);
  const systemMessage = `${AI_SYSTEM_PROMPT}\n\n${context}`;
  const providerLabel = AI_MODELS[aiSettings.provider]?.label ?? aiSettings.provider;

  // Gemini uses a different API format
  if (aiSettings.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiSettings.model}:generateContent?key=${aiSettings.apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemMessage }] },
        contents: [{ parts: [{ text: question }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: maxTokens }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        (errorData as Record<string, Record<string, string>>)?.error?.message ||
          `Gemini API error (${response.status})`
      );
    }

    const data = await response.json();
    return (data as { candidates: { content: { parts: { text: string }[] } }[] }).candidates?.[0]?.content?.parts?.[0]?.text ?? "No response from AI.";
  }

  // All other providers use OpenAI-compatible format
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[aiSettings.provider];
  if (!endpoint) throw new Error("Unsupported AI provider.");

  return callOpenAICompatible(endpoint, aiSettings.model, aiSettings.apiKey, systemMessage, question, providerLabel, maxTokens);
}

function getNumericColumns(headers: string[], rows: Record<string, string>[]): string[] {
  return headers.filter((h) => {
    const sample = rows.slice(0, 100).map((r) => r[h]?.trim()).filter(Boolean);
    if (sample.length === 0) return false;
    const numCount = sample.filter((v) => !isNaN(Number(v.replace(/[,$%]/g, "")))).length;
    return numCount / sample.length > 0.6;
  });
}

function parseNum(v: string): number {
  return Number(v.replace(/[,$%]/g, "")) || 0;
}

type ColumnStats = {
  col: string;
  count: number;
  missing: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  sum: number;
};

function computeColumnStats(rows: Record<string, string>[], col: string): ColumnStats {
  const vals: number[] = [];
  let missing = 0;
  for (const row of rows) {
    const raw = row[col]?.trim();
    if (!raw || raw === "") { missing++; continue; }
    const n = parseNum(raw);
    if (!isNaN(n)) vals.push(n);
    else missing++;
  }
  if (vals.length === 0) return { col, count: 0, missing, mean: 0, median: 0, stdDev: 0, min: 0, max: 0, sum: 0 };
  vals.sort((a, b) => a - b);
  const sum = vals.reduce((s, v) => s + v, 0);
  const mean = sum / vals.length;
  const median = vals.length % 2 === 0 ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2 : vals[Math.floor(vals.length / 2)];
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  const stdDev = Math.sqrt(variance);
  return { col, count: vals.length, missing, mean, median, stdDev, min: vals[0], max: vals[vals.length - 1], sum };
}

function computeCorrelation(rows: Record<string, string>[], colA: string, colB: string): number {
  const pairs: [number, number][] = [];
  for (const row of rows) {
    const a = row[colA]?.trim();
    const b = row[colB]?.trim();
    if (!a || !b) continue;
    const na = parseNum(a);
    const nb = parseNum(b);
    if (isNaN(na) || isNaN(nb)) continue;
    pairs.push([na, nb]);
  }
  if (pairs.length < 3) return 0;
  const n = pairs.length;
  const sumA = pairs.reduce((s, p) => s + p[0], 0);
  const sumB = pairs.reduce((s, p) => s + p[1], 0);
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0, varA = 0, varB = 0;
  for (const [a, b] of pairs) {
    cov += (a - meanA) * (b - meanB);
    varA += (a - meanA) ** 2;
    varB += (b - meanB) ** 2;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : cov / denom;
}

function getColumnDataTypes(rows: Record<string, string>[], col: string): { number: number; text: number; date: number; empty: number } {
  const result = { number: 0, text: 0, date: 0, empty: 0 };
  for (const row of rows) {
    const v = row[col]?.trim();
    if (!v || v === "") { result.empty++; continue; }
    if (!isNaN(Number(v.replace(/[,$%]/g, "")))) { result.number++; continue; }
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(v) || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(v)) { result.date++; continue; }
    result.text++;
  }
  return result;
}

function parseFilterExpr(filter: string, headers: string[]): ((row: Record<string, string>) => boolean) | null {
  const headerLower = headers.map((h) => h.toLowerCase());
  function findCol(name: string): string | null {
    const idx = headerLower.indexOf(name.toLowerCase().trim());
    return idx >= 0 ? headers[idx] : null;
  }
  function cleanVal(v: string): string {
    return v.replace(/^['"]|['"]$/g, "").trim();
  }
  function numVal(v: string): number {
    return Number(v.replace(/[,$%]/g, ""));
  }

  // column in ('val1','val2')
  const inMatch = filter.match(/^(.+?)\s+in\s*\((.+)\)$/i);
  if (inMatch) {
    const col = findCol(inMatch[1]);
    if (col) {
      const vals = inMatch[2].split(",").map((v) => cleanVal(v).toLowerCase());
      return (row) => vals.includes((row[col] ?? "").toLowerCase().trim());
    }
  }

  // column >= <= != > < =
  const cmpMatch = filter.match(/^(.+?)\s*(>=|<=|!=|>|<|=)\s*(.+)$/);
  if (cmpMatch) {
    const col = findCol(cmpMatch[1]);
    if (col) {
      const op = cmpMatch[2];
      const right = cleanVal(cmpMatch[3]);
      const rightNum = numVal(right);
      const isNum = !isNaN(rightNum);
      return (row) => {
        const cell = (row[col] ?? "").trim();
        if (isNum) {
          const cellNum = numVal(cell);
          if (isNaN(cellNum)) return false;
          if (op === "=") return cellNum === rightNum;
          if (op === "!=") return cellNum !== rightNum;
          if (op === ">") return cellNum > rightNum;
          if (op === "<") return cellNum < rightNum;
          if (op === ">=") return cellNum >= rightNum;
          if (op === "<=") return cellNum <= rightNum;
        }
        const cellLow = cell.toLowerCase();
        const rightLow = right.toLowerCase();
        if (op === "=") return cellLow === rightLow;
        if (op === "!=") return cellLow !== rightLow;
        return false;
      };
    }
  }

  return null;
}

function DataTable({ rows, headers, sort, onSort, filter, onFilter, page, onPage }: {
  rows: Record<string, string>[];
  headers: string[];
  sort: { col: string; dir: "asc" | "desc" } | null;
  onSort: (s: { col: string; dir: "asc" | "desc" } | null) => void;
  filter: string;
  onFilter: (f: string) => void;
  page: number;
  onPage: (p: number) => void;
}) {
  const PAGE_SIZE = 50;
  const [showHints, setShowHints] = useState(false);
  const filtered = useMemo(() => {
    if (!filter.trim()) return rows;
    const expr = parseFilterExpr(filter.trim(), headers);
    if (expr) return rows.filter(expr);
    const lower = filter.toLowerCase();
    return rows.filter((row) => headers.some((h) => (row[h] ?? "").toLowerCase().includes(lower)));
  }, [rows, headers, filter]);
  const sorted = sort
    ? [...filtered].sort((a, b) => {
        const va = a[sort.col] ?? "";
        const vb = b[sort.col] ?? "";
        const na = Number(va.replace(/[,$%]/g, ""));
        const nb = Number(vb.replace(/[,$%]/g, ""));
        if (!isNaN(na) && !isNaN(nb)) return sort.dir === "asc" ? na - nb : nb - na;
        return sort.dir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      })
    : filtered;
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const sampleCol = headers[0] ?? "column";
  const sampleNumCol = headers.find((h) => {
    const v = rows[0]?.[h];
    return v && !isNaN(Number(v.replace(/[,$%]/g, "")));
  }) ?? "Amount";
  const sampleTextCol = headers.find((h) => {
    const v = rows[0]?.[h];
    return v && isNaN(Number(v.replace(/[,$%]/g, "")));
  }) ?? "Name";
  const sampleTextVal = rows[0]?.[sampleTextCol] ?? "value";

  function handleSort(col: string) {
    if (sort?.col === col) {
      onSort(sort.dir === "asc" ? { col, dir: "desc" } : null);
    } else {
      onSort({ col, dir: "asc" });
    }
  }

  return (
    <div className="data-table-wrap">
      <div className="data-table-controls">
        <input className="data-table-search" placeholder="Search or filter (e.g. Age>30, Region='North')..." value={filter} onChange={(e) => { onFilter(e.target.value); onPage(0); }} />
        <button className="data-table-hint-btn" onClick={() => setShowHints(!showHints)} title="Filter help">?</button>
        <span className="data-table-count">{filtered.length.toLocaleString()} of {rows.length.toLocaleString()} rows</span>
      </div>
      {showHints && (
        <div className="data-table-hints">
          <strong>Filter syntax</strong>
          <div className="data-table-hint-grid">
            <span className="hint-label">Text search</span><code>north</code><span className="hint-desc">finds &quot;north&quot; in any column</span>
            <span className="hint-label">Exact match</span><code>{sampleTextCol}='{sampleTextVal}'</code><span className="hint-desc">rows where {sampleTextCol} is exactly &quot;{sampleTextVal}&quot;</span>
            <span className="hint-label">Not equal</span><code>{sampleTextCol}!='{sampleTextVal}'</code><span className="hint-desc">exclude a specific value</span>
            <span className="hint-label">Numeric</span><code>{sampleNumCol}&gt;500</code><span className="hint-desc">greater than, also &lt; &gt;= &lt;= =</span>
            <span className="hint-label">Multiple values</span><code>{sampleTextCol} in ('{sampleTextVal}','other')</code><span className="hint-desc">match any value in the list</span>
          </div>
          <p className="muted">Column names are case-insensitive. Click any column header to sort.</p>
        </div>
      )}
      <div className="data-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="row-num">#</th>
              {headers.map((h) => (
                <th key={h} onClick={() => handleSort(h)} className={sort?.col === h ? "sorted" : ""}>
                  {h} {sort?.col === h ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr key={page * PAGE_SIZE + i}>
                <td className="row-num">{page * PAGE_SIZE + i + 1}</td>
                {headers.map((h) => <td key={h}>{row[h]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="data-table-pagination">
          <button disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</button>
          <span>Page {page + 1} of {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

function SummaryStatsTable({ rows, numericCols }: { rows: Record<string, string>[]; numericCols: string[] }) {
  const stats = numericCols.map((col) => computeColumnStats(rows, col));
  return (
    <div className="data-table-scroll">
      <table className="data-table stats-table">
        <thead>
          <tr>
            <th>Column</th>
            <th>Count</th>
            <th>Missing</th>
            <th>Sum</th>
            <th>Mean</th>
            <th>Median</th>
            <th>Std Dev</th>
            <th>Min</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.col}>
              <td><strong>{s.col}</strong></td>
              <td>{s.count.toLocaleString()}</td>
              <td>{s.missing.toLocaleString()}</td>
              <td>{s.sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td>{s.mean.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td>{s.median.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td>{s.stdDev.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td>{s.min.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
              <td>{s.max.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CorrelationMatrix({ rows, numericCols }: { rows: Record<string, string>[]; numericCols: string[] }) {
  const MAX_DEFAULT = 15;
  const [selectedCols, setSelectedCols] = useState<string[]>(() => numericCols.slice(0, MAX_DEFAULT));
  const [showSelector, setShowSelector] = useState(false);
  const cols = selectedCols.filter((c) => numericCols.includes(c));
  const matrix = cols.map((a) => cols.map((b) => a === b ? 1 : computeCorrelation(rows, a, b)));
  function corrColor(v: number): string {
    if (v >= 0.7) return "#166534";
    if (v >= 0.3) return "#16a34a";
    if (v > -0.3) return "#64748b";
    if (v > -0.7) return "#dc2626";
    return "#991b1b";
  }
  function corrBg(v: number): string {
    const abs = Math.abs(v);
    if (abs >= 0.7) return v > 0 ? "#dcfce7" : "#fee2e2";
    if (abs >= 0.3) return v > 0 ? "#f0fdf4" : "#fef2f2";
    return "#f8fafc";
  }
  function toggleCol(col: string) {
    setSelectedCols((prev) => prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]);
  }
  return (
    <div>
      <div className="corr-col-controls">
        <span className="muted">Showing {cols.length} of {numericCols.length} numeric columns</span>
        <button className="cleaning-btn" onClick={() => setShowSelector(!showSelector)}>{showSelector ? "Hide columns" : "Select columns"}</button>
      </div>
      {showSelector && (
        <div className="corr-col-selector">
          {numericCols.map((c) => (
            <label key={c} className="corr-col-chip">
              <input type="checkbox" checked={cols.includes(c)} onChange={() => toggleCol(c)} />
              <span>{c}</span>
            </label>
          ))}
        </div>
      )}
      {cols.length >= 2 ? (
        <div className="data-table-scroll">
          <table className="data-table corr-table">
            <thead>
              <tr>
                <th></th>
                {cols.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {cols.map((row, ri) => (
                <tr key={row}>
                  <td><strong>{row}</strong></td>
                  {matrix[ri].map((v, ci) => (
                    <td key={ci} style={{ background: corrBg(v), color: corrColor(v), fontWeight: Math.abs(v) >= 0.5 ? 600 : 400, textAlign: "center" }}>
                      {v.toFixed(2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Select at least 2 columns to see correlations.</p>
      )}
      {cols.length >= 2 && (() => {
        const pairs: { a: string; b: string; r: number }[] = [];
        for (let i = 0; i < cols.length; i++) {
          for (let j = i + 1; j < cols.length; j++) {
            const r = matrix[i][j];
            if (r > 0.5 || r < -0.3) pairs.push({ a: cols[i], b: cols[j], r });
          }
        }
        pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
        const top = pairs.slice(0, 5);
        if (top.length === 0) return <p className="muted" style={{ marginTop: 12 }}>No strong correlations detected between your numeric columns.</p>;
        return (
          <div style={{ marginTop: 16 }}>
            <h4 style={{ fontSize: "0.9rem", marginBottom: 8 }}>Key correlations</h4>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {top.map((p, i) => {
                let text: string;
                if (p.r > 0.7) text = `📈 ${p.a} and ${p.b} are strongly linked — when one goes up, the other tends to follow`;
                else if (p.r > 0.5) text = `📊 ${p.a} and ${p.b} show a moderate connection`;
                else if (p.r < -0.5) text = `📉 ${p.a} and ${p.b} move in opposite directions — when one increases, the other tends to decrease`;
                else text = `⚠️ ${p.a} may be negatively affecting ${p.b}`;
                return <li key={i} style={{ padding: "4px 0", fontSize: "0.85rem", color: "#334155" }}>{text}</li>;
              })}
            </ul>
          </div>
        );
      })()}
    </div>
  );
}

function DataTypeDistribution({ rows, headers }: { rows: Record<string, string>[]; headers: string[] }) {
  const distributions = headers.map((h) => ({ col: h, ...getColumnDataTypes(rows, h) }));
  const total = rows.length;
  return (
    <div className="dtype-grid">
      {distributions.map((d) => {
        const parts = [
          { label: "Number", count: d.number, color: "#3b82f6" },
          { label: "Text", count: d.text, color: "#8b5cf6" },
          { label: "Date", count: d.date, color: "#f59e0b" },
          { label: "Empty", count: d.empty, color: "#e5e7eb" },
        ].filter((p) => p.count > 0);
        return (
          <article key={d.col} className="dtype-card">
            <strong>{d.col}</strong>
            <div className="dtype-bar">
              {parts.map((p) => (
                <div key={p.label} className="dtype-segment" style={{ width: `${(p.count / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.count}`} />
              ))}
            </div>
            <div className="dtype-legend">
              {parts.map((p) => (
                <span key={p.label}><span className="dtype-dot" style={{ background: p.color }} />{p.label} {((p.count / total) * 100).toFixed(0)}%</span>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function NullHeatmap({ rows, headers }: { rows: Record<string, string>[]; headers: string[] }) {
  const CHUNK = Math.max(1, Math.ceil(rows.length / 50));
  const chunks: number[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    chunks.push(headers.map((h) => {
      const nullCount = slice.filter((r) => !r[h]?.trim()).length;
      return nullCount / slice.length;
    }));
  }
  const minColWidth = headers.length > 20 ? 40 : undefined;
  const gridWidth = minColWidth ? headers.length * minColWidth : undefined;
  return (
    <div className="null-heatmap-wrap">
      {headers.length > 20 && <p className="muted" style={{ marginBottom: 4 }}>Scroll horizontally to see all {headers.length} columns</p>}
      <div className="null-heatmap-scroll" style={gridWidth ? { overflowX: "auto" } : undefined}>
        <div style={gridWidth ? { minWidth: gridWidth } : undefined}>
          <div className="null-heatmap-labels">
            {headers.map((h) => <span key={h} title={h}>{h}</span>)}
          </div>
          <div className="null-heatmap-grid" style={{ gridTemplateColumns: `repeat(${headers.length}, 1fr)` }}>
            {chunks.map((chunk, ci) =>
              chunk.map((ratio, hi) => (
                <div
                  key={`${ci}-${hi}`}
                  className="null-heatmap-cell"
                  style={{ background: ratio === 0 ? "#dcfce7" : ratio < 0.3 ? "#fef9c3" : ratio < 0.7 ? "#fed7aa" : "#fecaca", opacity: ratio === 0 ? 0.5 : 1 }}
                  title={`${headers[hi]} rows ${ci * CHUNK + 1}-${Math.min((ci + 1) * CHUNK, rows.length)}: ${(ratio * 100).toFixed(0)}% null`}
                />
              ))
            )}
          </div>
        </div>
      </div>
      <div className="null-heatmap-legend">
        <span><span className="dtype-dot" style={{ background: "#dcfce7" }} />0% null</span>
        <span><span className="dtype-dot" style={{ background: "#fef9c3" }} />&lt;30%</span>
        <span><span className="dtype-dot" style={{ background: "#fed7aa" }} />30-70%</span>
        <span><span className="dtype-dot" style={{ background: "#fecaca" }} />&gt;70%</span>
      </div>
    </div>
  );
}
