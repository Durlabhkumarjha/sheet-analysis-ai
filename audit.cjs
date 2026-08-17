#!/usr/bin/env node

/**
 * Sheet Analysis AI — Feature Audit Script
 * 
 * Run this in your project root:
 *   node audit.js
 * 
 * It scans your codebase and checks if each planned feature exists.
 * Reports: ✅ Found, ❌ Missing, ⚠️ Partial
 */

const fs = require("fs");
const path = require("path");

// ─── Configuration ───
const SRC_DIR = "./src";
const WORKER_DIR = "./worker";

// ─── Helper: recursively find all JS/JSX/TS/TSX files ───
function getAllFiles(dir, extensions = [".js", ".jsx", ".ts", ".tsx"]) {
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.includes("node_modules") && !entry.name.startsWith(".")) {
        results = results.concat(getAllFiles(fullPath, extensions));
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    // Directory doesn't exist
  }
  return results;
}

// ─── Helper: search all files for a pattern ───
function searchCode(files, patterns) {
  const allCode = files.map(f => {
    try { return fs.readFileSync(f, "utf8"); } catch { return ""; }
  }).join("\n");
  
  if (typeof patterns === "string") {
    return allCode.toLowerCase().includes(patterns.toLowerCase());
  }
  
  if (Array.isArray(patterns)) {
    return patterns.some(p => allCode.toLowerCase().includes(p.toLowerCase()));
  }
  
  return false;
}

// ─── Helper: search for pattern and return which file contains it ───
function findInCode(files, patterns) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  for (const f of files) {
    try {
      const code = fs.readFileSync(f, "utf8").toLowerCase();
      for (const p of pats) {
        if (code.includes(p.toLowerCase())) {
          return { found: true, file: f, pattern: p };
        }
      }
    } catch {}
  }
  return { found: false };
}

// ─── Run Audit ───
function runAudit() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     SHEET ANALYSIS AI — COMPLETE FEATURE AUDIT          ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const srcFiles = getAllFiles(SRC_DIR);
  const workerFiles = getAllFiles(WORKER_DIR);
  const allFiles = [...srcFiles, ...workerFiles];

  if (srcFiles.length === 0) {
    console.log("❌ No source files found in ./src — are you running this from the project root?\n");
    console.log("Usage: cd your-project && node audit.js\n");
    return;
  }

  console.log(`📁 Scanning ${srcFiles.length} source files + ${workerFiles.length} worker files...\n`);

  let totalFeatures = 0;
  let foundFeatures = 0;
  let missingFeatures = 0;
  let partialFeatures = 0;
  const missing = [];
  const partial = [];

  function check(category, featureName, patterns, description) {
    totalFeatures++;
    const result = findInCode(allFiles, Array.isArray(patterns) ? patterns : [patterns]);
    
    if (result.found) {
      foundFeatures++;
      console.log(`  ✅ ${featureName}`);
    } else {
      missingFeatures++;
      console.log(`  ❌ ${featureName}`);
      missing.push({ category, feature: featureName, description, searchedFor: patterns });
    }
  }

  function checkPartial(category, featureName, requiredPatterns, description) {
    totalFeatures++;
    const required = Array.isArray(requiredPatterns) ? requiredPatterns : [requiredPatterns];
    const foundCount = required.filter(p => searchCode(allFiles, p)).length;
    
    if (foundCount === required.length) {
      foundFeatures++;
      console.log(`  ✅ ${featureName}`);
    } else if (foundCount > 0) {
      partialFeatures++;
      const missingPats = required.filter(p => !searchCode(allFiles, p));
      console.log(`  ⚠️  ${featureName} (${foundCount}/${required.length} parts found)`);
      partial.push({ category, feature: featureName, description, missing: missingPats });
    } else {
      missingFeatures++;
      console.log(`  ❌ ${featureName}`);
      missing.push({ category, feature: featureName, description, searchedFor: required });
    }
  }

  // ══════════════════════════════════════════════
  // TAB 1: UPLOAD
  // ══════════════════════════════════════════════
  console.log("━━━ TAB 1: UPLOAD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  
  check("Upload", "File upload (CSV/XLSX/XLS)", 
    ["drag", "drop", "file", "xlsx", "csv"],
    "Drag-drop or click file upload supporting CSV, XLSX, XLS");

  check("Upload", "XLSX parsing library", 
    ["xlsx", "sheetjs", "read_file", "readFile"],
    "Uses XLSX.js or SheetJS to parse Excel files");

  check("Upload", "Column type detection (profiler)", 
    ["profilecolumn", "profile_column", "columnprofile", "detecttype", "detect_type", "datatype"],
    "Scans columns to detect type: number, text, date");

  check("Upload", "Instant Preview Strip", 
    ["instantpreview", "instant_preview", "previewstrip", "preview_strip", "preview strip"],
    "Shows 4 KPI cards + sparkline immediately after parse, before mapping");

  check("Upload", "Sparkline in preview", 
    ["sparkline", "spark_line", "mini chart", "minichart"],
    "Small trend line in the instant preview strip");

  check("Upload", "Data Health sentence", 
    ["data health", "datahealth", "looks clean", "data looks", "complete", "duplicates detected"],
    "Shows 'Your data looks clean' or warns about issues before mapping");

  check("Upload", "Column mapping popup", 
    ["columnmap", "column_map", "mapping", "mapcolumn", "maprole", "map_role"],
    "Auto-detects and lets user confirm column roles");

  check("Upload", "Confidence scoring on mapping", 
    ["confidence", "confidencescore", "confidence_score"],
    "Shows confidence level for each column guess");

  check("Upload", "Smart column detection (AI-enhanced)", 
    ["column_detection", "smartdetect", "smart_detect", "task.*column"],
    "Uses Cloudflare Worker AI to improve column role detection");

  check("Upload", "Data Quality Panel", 
    ["trustscore", "trust_score", "trust score", "dataquality", "data_quality"],
    "Shows trust score 0-100% with cleaning buttons");

  check("Upload", "One-click cleaning buttons", 
    ["excluderow", "exclude_row", "removeblank", "removeduplicate", "cleandata", "clean_data"],
    "Toggle buttons to exclude blank/duplicate/summary rows");

  check("Upload", "Sample data button", 
    ["sample", "demo", "sampledata", "sample_data", "use sample"],
    "Button to load built-in demo CSV");

  check("Upload", "Auto-navigate to Dashboard after mapping", 
    ["activetab.*dashboard", "settab.*dashboard", "navigate.*dashboard", "confirm.*dashboard", "view dashboard"],
    "Switches to Dashboard tab after user confirms mapping");

  // ══════════════════════════════════════════════
  // TAB 2: DASHBOARD
  // ══════════════════════════════════════════════
  console.log("\n━━━ TAB 2: DASHBOARD ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  check("Dashboard", "Report Settings (title, company, currency, brand color)", 
    ["reportsetting", "report_setting", "reporttitle", "brandcolor", "brand_color", "brand-color"],
    "Collapsible panel with title, company, template, currency, brand color");

  check("Dashboard", "Brand color CSS variable", 
    ["--brand-color", "--brand_color", "brandcolor"],
    "CSS variable that flows into charts, bars, lines, KPIs");

  check("Dashboard", "Concise / Full toggle", 
    ["concise", "fullreport", "full_report", "reportmode", "report_mode"],
    "Toggle between 1-page concise and full detailed report");

  check("Dashboard", "Copy Summary button", 
    ["copysummary", "copy_summary", "copy summary", "clipboard", "navigator.clipboard"],
    "One-click copy formatted text block to clipboard");

  check("Dashboard", "Share Image export (1080x1080)", 
    ["shareimage", "share_image", "share image", "1080", "html2canvas", "tocanvas", "topng"],
    "Generate 1080x1080 PNG for WhatsApp/Slack sharing");

  check("Dashboard", "Print report", 
    ["window.print", "print report", "printreport"],
    "Print button with section toggles");

  check("Dashboard", "One-pager PDF mode", 
    ["one.?pager", "onepager", "single.*a4", "1.*page"],
    "Constrains print to single A4 page");

  check("Dashboard", "Executive Summary (rule-based)", 
    ["executivesummary", "executive_summary", "createexecutivesummary"],
    "Rule-based prose summary — no AI needed");

  check("Dashboard", "Executive Summary (AI-enhanced)", 
    ["task.*executive_summary", "executive_summary.*ai", "aisummary", "smartexecutive", "smart.*summary"],
    "AI-polished executive summary via Cloudflare Worker");

  check("Dashboard", "Recommendation Strip", 
    ["recommendation", "getrecommended", "recommendedaction", "recommended_action"],
    "Action cards: Focus, Growth, Risk based on data patterns");

  check("Dashboard", "Smart Recommendations (AI-enhanced)", 
    ["task.*recommendation", "airecommendation", "smartrecommend"],
    "AI-generated recommendations via Cloudflare Worker");

  check("Dashboard", "KPI Grid (4 cards)", 
    ["kpi", "kpicard", "kpi_card", "totalgrid", "metriccard"],
    "Total metric, rows, average, period change");

  check("Dashboard", "What-If Simulator (slider)", 
    ["whatif", "what_if", "what-if", "simulator"],
    "Slider -50% to +50% with live recalculation");

  check("Dashboard", "What-If presets (lose top customer, best/worst month)", 
    ["lose.*customer", "best.*month.*repeat", "worst.*month.*repeat", "preset"],
    "3 preset scenario buttons in What-If simulator");

  check("Dashboard", "Smart Insights Strip", 
    ["smartinsight", "smart_insight", "generatesmartinsight", "insightstrip"],
    "Up to 6 colored chips with 8 template patterns");

  check("Dashboard", "Revenue Forecast Chart", 
    ["forecast", "computeforecast", "compute_forecast", "linearregression", "exponentialsmooth"],
    "3-method forecast with confidence band");

  check("Dashboard", "Forecast confidence labels (plain English)", 
    ["fairly confident", "directional", "not enough data", "confidencelabel"],
    "Human-readable confidence instead of High/Medium/Low");

  check("Dashboard", "Smart Charts Grid", 
    ["smartchart", "smart_chart", "recommendchart", "recommend_chart"],
    "Auto-generated charts based on mapped columns");

  check("Dashboard", "On-chart annotations: average line on bars", 
    ["avg.*line", "average.*line", "avgline", "averageline", "dashed.*avg", "dashed.*average"],
    "Dashed average line on bar charts with label");

  check("Dashboard", "On-chart annotations: peak/trough on lines", 
    ["peak", "trough", "peakpoint", "troughpoint", "▲.*peak", "▼.*low"],
    "Peak and trough markers on line charts");

  check("Dashboard", "On-chart annotations: % of total on bars", 
    ["pctoftotal", "pct_of_total", "percentoftotal", "% of total"],
    "Percentage labels above each bar");

  check("Dashboard", "Chart insight sentences (AI-enhanced)", 
    ["task.*chart_insight", "chartinsight", "chart_insight", "smartchartinsight"],
    "AI-polished insight sentences below each chart");

  check("Dashboard", "Customer Health / RFM", 
    ["rfm", "computerfm", "compute_rfm", "recency", "frequency", "monetary"],
    "RFM scoring with customer segments");

  check("Dashboard", "RFM plain-English segment names", 
    ["best customer", "regular", "needs attention", "slipping away", "gone quiet"],
    "Renamed from Champion/Loyal/At Risk to plain English");

  check("Dashboard", "RFM click-to-expand customer lists", 
    ["expandsegment", "expand_segment", "segmentdetail", "segment_detail", "customertable", "customer_table", "customerlist"],
    "Click a segment badge to see individual customer names");

  check("Dashboard", "Copy customer list button", 
    ["copycustomer", "copy_customer", "copy customer list"],
    "Copy individual customer names from expanded segment");

  check("Dashboard", "Product ABC Classification", 
    ["abc", "computeabc", "compute_abc", "pareto", "core.*earner", "growth.*potential", "low.*perform"],
    "A/B/C product tiers based on Pareto principle");

  check("Dashboard", "ABC click-to-expand product lists", 
    ["expandtier", "expand_tier", "tierdetail", "tier_detail", "productlist"],
    "Click a tier to see individual product names");

  check("Dashboard", "Outlier detection", 
    ["outlier", "detectoutlier", "detect_outlier", "anomaly", "iqr"],
    "Detect unusual patterns using IQR method");

  check("Dashboard", "Root cause analysis on outliers", 
    ["rootcause", "root_cause", "root cause", "enrichoutlier", "why.*happen"],
    "Cross-reference to explain WHY an anomaly occurred");

  check("Dashboard", "Methodology badges (ⓘ tooltips)", 
    ["methodology", "rfm method", "pareto method", "ⓘ", "tooltip.*method"],
    "Small badges showing the method name for credibility");

  // ══════════════════════════════════════════════
  // TAB 3: EXPLORE — Chart Builder
  // ══════════════════════════════════════════════
  console.log("\n━━━ TAB 3: EXPLORE — Chart Builder ━━━━━━━━━━━━━━━━━━━━━━");

  check("Chart Builder", "Suggested charts row", 
    ["suggestedchart", "suggested_chart", "suggestchart", "chartsuggestion"],
    "4-6 clickable chart thumbnails at top of Chart Builder");

  check("Chart Builder", "3-tier suggestion fallback", 
    ["ensurevariety", "ensure_variety", "typebased", "type_based", "universalsuggestion"],
    "Semantic → Type-based → Universal fallback for any dataset");

  check("Chart Builder", "Progressive field setup", 
    ["progressive", "fieldappear", "step.*setup"],
    "Fields appear one at a time after previous is filled");

  check("Chart Builder", "Chart type: Bar", ["bar"], "Bar chart type");
  check("Chart Builder", "Chart type: Horizontal Bar", 
    ["horizontal_bar", "horizontalbar", "hbar"], "Horizontal bar chart type");
  check("Chart Builder", "Chart type: Line", ["linechart", "line chart", "type.*line"], "Line chart type");
  check("Chart Builder", "Chart type: Area", ["areachart", "area chart", "type.*area"], "Area chart type");
  check("Chart Builder", "Chart type: Donut", ["donut", "doughnut"], "Donut chart type");
  check("Chart Builder", "Chart type: Scatter", ["scatter"], "Scatter chart type");
  check("Chart Builder", "Chart type: Combo (bar + line)", 
    ["combo", "dualaxis", "dual_axis", "dual axis", "secondaryy"], 
    "Combo chart with bar + line on dual Y-axis");
  check("Chart Builder", "Chart type: Table", ["table"], "Table view");

  check("Chart Builder", "Natural language chart creation (AI)", 
    ["task.*chart_config", "chartconfig", "nlchart", "describe.*chart", "natural.*chart"],
    "Text input: type what you want, AI generates chart config");

  check("Chart Builder", "Chart Doctor warnings", 
    ["chartdoctor", "chart_doctor", "chart doctor", "donut.*categor", "pie.*categor", "warning.*chart"],
    "Warns when chart choices are bad (pie with 15 categories, etc.)");

  check("Chart Builder", "Auto-insight sentence below charts", 
    ["autoinsight", "auto_insight", "auto insight", "insightsentence"],
    "One-line insight generated from chart data");

  check("Chart Builder", "Adaptive insight for non-revenue data", 
    ["count of", "count mode", "generic.*numeric", "nonrevenue", "non_revenue"],
    "Insight sentences adapt when data isn't revenue");

  check("Chart Builder", "Reset: Start over button", 
    ["start.*over", "startover", "resetall", "reset_all", "clearall", "clear_all"],
    "Clears all chart builder fields");

  check("Chart Builder", "Reset: Restore original suggestion", 
    ["restore.*original", "restoreoriginal", "resetsuggest"],
    "Reverts to the clicked suggestion's config");

  check("Chart Builder", "Per-field × clear buttons", 
    ["clearfield", "clear_field", "field.*clear", "removefilter"],
    "Small × to clear individual fields");

  check("Chart Builder", "Saved charts gallery", 
    ["savedchart", "saved_chart", "customchart", "custom_chart", "savechart"],
    "Gallery of user-saved charts");

  check("Chart Builder", "Hover-expand on saved charts", 
    ["hover.*expand", "scale.*1.4", "hover.*preview", "onmouseenter.*scale"],
    "Cards expand on hover to show preview");

  check("Chart Builder", "Export chart as PNG", 
    ["exportpng", "export_png", "topng", "to_png", "downloadchart", "chartpng"],
    "Download individual chart as 2x resolution PNG");

  check("Chart Builder", "Plain English field labels", 
    ["group by", "what to measure", "summarize by", "split by"],
    "Fields labeled in plain English, not X-axis/Y-axis jargon");

  // ══════════════════════════════════════════════
  // TAB 3: EXPLORE — Data & Stats
  // ══════════════════════════════════════════════
  console.log("\n━━━ TAB 3: EXPLORE — Data & Stats ━━━━━━━━━━━━━━━━━━━━━━━");

  check("Data & Stats", "Data Profile bar", 
    ["dataprofile", "data_profile", "data profile", "rows.*columns.*numeric"],
    "One-line summary: rows, columns, types, completeness");

  check("Data & Stats", "Data table with sort/filter", 
    ["sortcolumn", "sort_column", "filterdata", "filter_data", "pagination"],
    "Browseable table with click-to-sort and text filter");

  check("Data & Stats", "Summary statistics", 
    ["summarystats", "summary_stats", "stddev", "std_dev", "median", "standarddeviation"],
    "Count, missing, sum, mean, median, std dev, min, max per numeric column");

  check("Data & Stats", "Correlation matrix", 
    ["correlation", "correlationmatrix", "correlation_matrix", "pearson"],
    "Heatmap of Pearson correlations between numeric columns");

  // ══════════════════════════════════════════════
  // TAB 3: EXPLORE — Compare Files
  // ══════════════════════════════════════════════
  console.log("\n━━━ TAB 3: EXPLORE — Compare Files ━━━━━━━━━━━━━━━━━━━━━━");

  check("Compare Files", "File comparison (upload 2nd file)", 
    ["comparefile", "compare_file", "file comparison", "file2", "previousperiod"],
    "Upload a second file for side-by-side comparison");

  check("Compare Files", "Smart period detection", 
    ["detectperiod", "detect_period", "monthovermonth", "yearoveryear", "month_over_month", "year_over_year"],
    "Auto-detect if comparison is MoM, YoY, quarterly, etc.");

  check("Compare Files", "Comparison KPI cards", 
    ["comparisonkpi", "comparison_kpi", "revenuchange", "changepct"],
    "6 KPI cards showing current vs previous");

  check("Compare Files", "Comparison narrative (AI-enhanced)", 
    ["task.*comparison_narrative", "comparisonnarrative", "comparison_narrative", "smartcomparison"],
    "AI-generated narrative explaining what changed");

  check("Compare Files", "Monthly Check-In narrative (rule-based)", 
    ["monthlycheckin", "monthly_checkin", "monthly check", "checkinnarrative"],
    "Rule-based narrative for monthly comparisons");

  check("Compare Files", "Analysis History (IndexedDB)", 
    ["indexeddb", "indexed_db", "idb", "analysissnapshot", "analysis_snapshot", "localsnapshot"],
    "Store lightweight analysis snapshots locally");

  check("Compare Files", "History export/import", 
    ["exporthistory", "export_history", "importhistory", "import_history"],
    "JSON backup of analysis history");

  // ══════════════════════════════════════════════
  // TAB 4: AI INSIGHTS
  // ══════════════════════════════════════════════
  console.log("\n━━━ TAB 4: AI INSIGHTS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  check("AI Insights", "AI Provider Settings panel", 
    ["providersetting", "provider_setting", "aiprovider", "ai_provider"],
    "6 providers, 22 models, API key storage");

  check("AI Insights", "Blurred preview (no API key)", 
    ["blurred", "blur.*preview", "unlock.*ai", "enter.*key.*unlock"],
    "Shows blurred cards when no API key connected");

  check("AI Insights", "Talk to Data — clickable question buttons", 
    ["questionbutton", "question_button", "generatequestion", "clickable.*question", "askbutton"],
    "Grid of clickable pre-generated questions from data");

  check("AI Insights", "Talk to Data — dynamic follow-up suggestions", 
    ["followup", "follow_up", "followupsuggestion", "contextualsuggestion", "getfollowup"],
    "Follow-up buttons change after each answer");

  check("AI Insights", "Talk to Data — rule-based answers (no API)", 
    ["rulebasedanswer", "rule_based_answer", "answerquestion", "answer_question", "fallback.*answer"],
    "15-20 common questions answered without AI");

  check("AI Insights", "Talk to Data — AI intent parsing", 
    ["intent_parse", "intentparse", "parseintent", "task.*intent"],
    "Cloudflare Worker parses question into structured command");

  check("AI Insights", "Talk to Data — AI answer polishing", 
    ["polish_answer", "polishanswer", "task.*polish"],
    "Worker polishes raw computed answer into natural prose");

  check("AI Insights", "Conversation memory", 
    ["chathistory", "chat_history", "conversationmemory", "conversation_memory", "lastmessage"],
    "Remembers last N messages for context");

  check("AI Insights", "Smart suggestions (from column mappings)", 
    ["smartsuggestion", "smart_suggestion", "getsmartsuggestion"],
    "Contextual suggestions based on actual column names");

  check("AI Insights", "Prompt templates", 
    ["prompttemplate", "prompt_template", "templatebutton"],
    "Pre-built prompt templates across categories");

  check("AI Insights", "Token cost estimator", 
    ["tokencost", "token_cost", "estimatedcost", "estimated_cost", "estimated cost"],
    "Shows estimated token cost before each AI call");

  check("AI Insights", "AI Report (7 sections)", 
    ["aireport", "ai_report", "generateaireport", "fullreport"],
    "One-click full AI analysis report");

  check("AI Insights", "5 AI Agents", 
    ["aiagent", "ai_agent", "runagent", "run_agent"],
    "5 specialized agents: Explain, Patterns, Report, Actions, Benchmark");

  check("AI Insights", "Sequential agent execution", 
    ["sequential", "runsequential", "oneatatime", "one_at_a_time"],
    "Agents run one at a time, not in parallel");

  check("AI Insights", "BYOK (Bring Your Own Key)", 
    ["byok", "bring.*own.*key", "apikey", "api_key", "userkey"],
    "Users can connect their own API keys for heavy AI features");

  // ══════════════════════════════════════════════
  // CLOUDFLARE WORKER
  // ══════════════════════════════════════════════
  console.log("\n━━━ CLOUDFLARE WORKER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  check("Worker", "Worker file exists", 
    ["export default", "export default {"],
    "Cloudflare Worker entry point exists");

  check("Worker", "Groq provider", 
    ["groq", "api.groq.com"],
    "Groq API integration in Worker");

  check("Worker", "Cerebras provider", 
    ["cerebras", "api.cerebras"],
    "Cerebras API integration in Worker");

  check("Worker", "Gemini provider", 
    ["gemini", "generativelanguage.googleapis"],
    "Google Gemini API integration in Worker");

  check("Worker", "Mistral provider", 
    ["mistral", "api.mistral"],
    "Mistral API as 4th provider");

  check("Worker", "Provider fallback chain", 
    ["fallback", "callwithfallback", "call_with_fallback", "try.*catch.*continue", "provider.*chain"],
    "Tries multiple providers, falls back on failure");

  check("Worker", "CORS headers", 
    ["access-control-allow-origin", "corsheader", "cors_header"],
    "Proper CORS setup for browser requests");

  check("Worker", "Task: column_detection", 
    ["column_detection"],
    "System prompt for smart column detection");

  check("Worker", "Task: intent_parse", 
    ["intent_parse"],
    "System prompt for question intent parsing");

  check("Worker", "Task: polish_answer", 
    ["polish_answer"],
    "System prompt for polishing computed answers");

  check("Worker", "Task: chart_config", 
    ["chart_config"],
    "System prompt for natural language chart creation");

  check("Worker", "Task: chart_insight", 
    ["chart_insight"],
    "System prompt for chart insight sentences");

  check("Worker", "Task: executive_summary", 
    ["executive_summary"],
    "System prompt for AI executive summary");

  check("Worker", "Task: recommendations", 
    ["task.*recommendation", "\"recommendations\""],
    "System prompt for AI recommendations");

  check("Worker", "Task: comparison_narrative", 
    ["comparison_narrative"],
    "System prompt for file comparison narrative");

  // ══════════════════════════════════════════════
  // CROSS-CUTTING FEATURES
  // ══════════════════════════════════════════════
  console.log("\n━━━ CROSS-CUTTING FEATURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  check("Cross-cutting", "Privacy: no data sent to server", 
    ["never.*leave", "never.*sent", "browser.*only", "client.*side", "privacy"],
    "Privacy messaging about data staying in browser");

  check("Cross-cutting", "Offline fallback", 
    ["navigator.online", "offline", "isoffline", "is_offline", "navigator.onLine"],
    "Detects offline state and falls back gracefully");

  check("Cross-cutting", "callSmartAI utility function", 
    ["callsmartai", "call_smart_ai", "callworker", "call_worker"],
    "Universal function to call Cloudflare Worker");

  check("Cross-cutting", "Worker URL as configurable constant", 
    ["worker_url", "workerurl", "proxy_url", "proxyurl", "api_proxy", "workers.dev"],
    "Worker URL defined as a constant, easy to change");

  check("Cross-cutting", "PWA / Service Worker", 
    ["serviceworker", "service_worker", "service-worker", "manifest"],
    "Progressive Web App capability");

  // ══════════════════════════════════════════════
  // RESULTS
  // ══════════════════════════════════════════════
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                      RESULTS                            ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Total features checked:  ${String(totalFeatures).padStart(3)}                          ║`);
  console.log(`║  ✅ Found:                ${String(foundFeatures).padStart(3)}  (${((foundFeatures/totalFeatures)*100).toFixed(0)}%)                       ║`);
  console.log(`║  ⚠️  Partial:              ${String(partialFeatures).padStart(3)}                          ║`);
  console.log(`║  ❌ Missing:              ${String(missingFeatures).padStart(3)}  (${((missingFeatures/totalFeatures)*100).toFixed(0)}%)                       ║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (missing.length > 0) {
    console.log("\n━━━ MISSING FEATURES (need to build) ━━━━━━━━━━━━━━━━━━━━");
    
    // Group by category
    const grouped = {};
    for (const m of missing) {
      if (!grouped[m.category]) grouped[m.category] = [];
      grouped[m.category].push(m);
    }
    
    for (const [category, features] of Object.entries(grouped)) {
      console.log(`\n  [${category}]`);
      for (const f of features) {
        console.log(`    ❌ ${f.feature}`);
        console.log(`       ${f.description}`);
      }
    }
  }

  if (partial.length > 0) {
    console.log("\n━━━ PARTIAL FEATURES (need completion) ━━━━━━━━━━━━━━━━━━");
    for (const p of partial) {
      console.log(`\n  ⚠️  ${p.feature} (${p.category})`);
      console.log(`     Missing parts: ${p.missing.join(", ")}`);
    }
  }

  // Priority recommendations
  console.log("\n━━━ PRIORITY ACTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  
  const criticalMissing = missing.filter(m => 
    ["On-chart annotations", "RFM click-to-expand", "Share Image", 
     "Smart period detection", "AI intent parsing", "callSmartAI",
     "RFM plain-English segment names", "Auto-navigate"].some(k => 
      m.feature.includes(k)
    )
  );

  if (criticalMissing.length > 0) {
    console.log("\n  🔴 CRITICAL (fix before launch):");
    for (const m of criticalMissing) {
      console.log(`     → ${m.feature}`);
    }
  }

  const importantMissing = missing.filter(m => !criticalMissing.includes(m));
  if (importantMissing.length > 0) {
    console.log("\n  🟡 IMPORTANT (fix in first week):");
    for (const m of importantMissing.slice(0, 10)) {
      console.log(`     → ${m.feature}`);
    }
    if (importantMissing.length > 10) {
      console.log(`     ... and ${importantMissing.length - 10} more`);
    }
  }

  if (missing.length === 0 && partial.length === 0) {
    console.log("\n  🎉 ALL FEATURES FOUND! Your product is ready for launch.");
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

runAudit();
