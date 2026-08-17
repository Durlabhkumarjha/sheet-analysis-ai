// Sheet Analysis AI — Cloudflare Worker
// Handles small AI tasks so the browser never sees the API keys.
// Single provider: DeepSeek via env.DEEPSEEK_KEY.

const CREDIT_COSTS = {
  intent_parse: 1,
  polish_answer: 1,
  generate_code: 1,
  explain_result: 1,
  recommend_charts: 1,
  chart_insights_batch: 1,
  chart_insight: 1,
  chart_config: 1,
  smart_mapping: 1,
  executive_summary: 1,
  recommendations: 1,
  comparison_narrative: 1,
  ai_report: 5,
  ai_agent: 3,
  auto_insights: 2,
};
// Anonymous visitors get a small trial. Redeeming a license code upgrades a user to
// "pro": a ONE-TIME bucket of PRO_CREDITS with NO monthly refill, which bounds our
// lifetime cost per buyer. Heavy users top up separately. No client-callable reset.
const TRIAL_CREDITS = 15;
const PRO_CREDITS = 500;

function newTrialUser() {
  return { plan: "trial", credits: TRIAL_CREDITS, used: 0, periodStart: Date.now(), created: Date.now() };
}

// Trial accounts never refill; the no-op keeps callers uniform.
function refillIfDue(userData) {
  return userData;
}

// A pro user's credits live on the LICENSE record, not the browser, so access follows
// the code across devices. The bucket is ONE-TIME — no refill — which bounds cost per buyer.
function refillLicense(lic) {
  return lic;
}

// Initialize the credit pool for a redeemed license that predates this model.
function ensureLicenseCredits(lic) {
  if (typeof lic.credits !== "number") {
    lic.credits = PRO_CREDITS;
    lic.periodStart = lic.periodStart || Date.now();
  }
  return lic;
}

async function checkAndDeductCredits(env, userId, task) {
  if (!env.CREDITS) return { allowed: true, remaining: -1, cost: 0 };
  const cost = CREDIT_COSTS[task] || 1;
  const userKey = `user:${userId}`;
  const raw = await env.CREDITS.get(userKey);
  const userData = raw ? JSON.parse(raw) : newTrialUser();

  // Pro users: deduct from the license pool (shared across their devices).
  if (userData.plan === "pro" && userData.license) {
    const licKey = `license:${userData.license}`;
    const licRaw = await env.CREDITS.get(licKey);
    if (licRaw) {
      const lic = ensureLicenseCredits(refillLicense(JSON.parse(licRaw)));
      if (lic.credits < cost) {
        await env.CREDITS.put(licKey, JSON.stringify(lic));
        return { allowed: false, remaining: lic.credits, cost };
      }
      lic.credits -= cost;
      lic.used = (lic.used || 0) + cost;
      await env.CREDITS.put(licKey, JSON.stringify(lic));
      return { allowed: true, remaining: lic.credits, cost };
    }
    // License record missing — fall through and treat as trial.
  }

  // Trial users: credits on the user record.
  if (userData.credits < cost) {
    if (!raw) await env.CREDITS.put(userKey, JSON.stringify(userData));
    return { allowed: false, remaining: userData.credits, cost };
  }
  userData.credits -= cost;
  userData.used = (userData.used || 0) + cost;
  await env.CREDITS.put(userKey, JSON.stringify(userData));
  return { allowed: true, remaining: userData.credits, cost };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, request);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400, request);
    }

    const userId = body.userId;

    if (body.task === "get_credits" && userId) {
      if (!env.CREDITS) {
        return json({ _credits: { remaining: -1, cost: 0, unlimited: true } }, 200, request);
      }
      const userKey = `user:${userId}`;
      const raw = await env.CREDITS.get(userKey);
      const userData = raw ? JSON.parse(raw) : newTrialUser();
      if (userData.plan === "pro" && userData.license) {
        const licKey = `license:${userData.license}`;
        const licRaw = await env.CREDITS.get(licKey);
        if (licRaw) {
          const lic = ensureLicenseCredits(refillLicense(JSON.parse(licRaw)));
          await env.CREDITS.put(licKey, JSON.stringify(lic));
          return json({ _credits: { remaining: lic.credits, cost: 0 }, plan: "pro" }, 200, request);
        }
      }
      await env.CREDITS.put(userKey, JSON.stringify(userData));
      return json({ _credits: { remaining: userData.credits, cost: 0 }, plan: userData.plan || "trial" }, 200, request);
    }

    // Redeem a license code. The code is the key: the credit pool lives on the
    // license, so entering it on any device (even after clearing storage) restores
    // access. First redeem activates the pool; later redeems restore the same pool.
    if (body.redeem && userId && env.CREDITS) {
      const code = String(body.redeem).trim().toUpperCase();
      if (!code) return json({ error: "invalid_code", message: "Enter a code." }, 200, request);
      // Validity comes from the single "validcodes" set (one KV value), not per-code
      // keys — so 10k codes cost one write to seed instead of 10k.
      const validRaw = await env.CREDITS.get("validcodes");
      const valid = validRaw ? JSON.parse(validRaw) : [];
      if (!valid.includes(code)) return json({ error: "invalid_code", message: "That code isn't valid." }, 200, request);
      const licKey = `license:${code}`;
      const licRaw = await env.CREDITS.get(licKey);
      let lic = licRaw ? JSON.parse(licRaw) : null;
      const wasRedeemed = !!lic; // a license record exists only after first redeem
      if (wasRedeemed) {
        lic = ensureLicenseCredits(refillLicense(lic));
      } else {
        lic = { status: "redeemed", credits: PRO_CREDITS, used: 0, periodStart: Date.now(), created: Date.now(), firstUserId: userId, redeemedAt: Date.now() };
      }
      await env.CREDITS.put(licKey, JSON.stringify(lic));
      // Point this browser at the license.
      const userKey = `user:${userId}`;
      const existingRaw = await env.CREDITS.get(userKey);
      const existing = existingRaw ? JSON.parse(existingRaw) : {};
      await env.CREDITS.put(userKey, JSON.stringify({ plan: "pro", license: code, created: existing.created || Date.now() }));
      return json({
        redeemed: true,
        restored: wasRedeemed,
        plan: "pro",
        message: wasRedeemed ? "Access restored — your credits are back." : `Code redeemed — ${PRO_CREDITS} AI actions added.`,
        _credits: { remaining: lic.credits, cost: 0 }
      }, 200, request);
    }

    // Admin-only: bulk-load license codes into KV. Guarded by ADMIN_SECRET.
    // POST { seedLicenses: ["CODE1","CODE2"], adminSecret: "<env.ADMIN_SECRET>" }
    if (body.seedLicenses && env.CREDITS) {
      if (!env.ADMIN_SECRET || body.adminSecret !== env.ADMIN_SECRET) {
        return json({ error: "unauthorized" }, 403, request);
      }
      const codes = Array.isArray(body.seedLicenses) ? body.seedLicenses : [];
      const validRaw = await env.CREDITS.get("validcodes");
      const set = new Set(validRaw ? JSON.parse(validRaw) : []);
      let added = 0;
      for (const c of codes) {
        const code = String(c).trim().toUpperCase();
        if (code && !set.has(code)) { set.add(code); added++; }
      }
      await env.CREDITS.put("validcodes", JSON.stringify([...set]));
      return json({ seeded: added, total: set.size, received: codes.length }, 200, request);
    }

    if (env.CREDITS) {
      // Every AI task must carry a userId and pass the credit check. No userId ⇒ reject,
      // so nobody can call the AI anonymously and bill it to our DeepSeek balance.
      if (!userId) {
        return json({ error: "missing_user", message: "A userId is required." }, 400, request);
      }
      const creditCheck = await checkAndDeductCredits(env, userId, body.task);
      if (!creditCheck.allowed) {
        return json({
          error: "no_credits",
          remaining: creditCheck.remaining,
          needed: creditCheck.cost,
          message: "Credits exhausted. Connect your own AI key for unlimited access."
        }, 402, request);
      }
      try {
        const result = await handleTask(body, env, request);
        const resultBody = await result.clone().json();
        return json({ ...resultBody, _credits: { remaining: creditCheck.remaining, cost: creditCheck.cost } }, result.status, request);
      } catch (e) {
        return json({ error: "worker_error", detail: String(e) }, 500, request);
      }
    }

    // Only reached when no credit store is bound (local/dev). Never in production.
    try {
      return await handleTask(body, env, request);
    } catch (e) {
      return json({ error: "worker_error", detail: String(e) }, 500, request);
    }
  }
};

async function handleTask(body, env, request) {
  const task = body && body.task;

  if (task === "intent_parse") {
    const system = intentParseSystemPrompt(body);
    const user = String(body.question || "");
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed) return json({ intent: "unknown" }, 200, request);
    return json(parsed, 200, request);
  }

  if (task === "polish_answer") {
    const system =
      "You are a friendly data analyst. The browser already computed the exact " +
      "findings from the user's spreadsheet. Rewrite the raw findings as a clear, " +
      "natural answer of 2-3 sentences. Keep every number exactly as given — never " +
      "invent or change numbers. No jargon, no preamble. If a finding hints at a risk " +
      "or an obvious next step, mention it briefly. Plain text only.";
    const user = `Question: ${String(body.question || "")}\nRaw findings: ${String(body.raw_findings || "")}`;
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    return json({ answer: raw.trim() }, 200, request);
  }

  if (task === "executive_summary") {
    const metrics = body.metrics || {};
    const dirNote = metrics.metricDirection === "down_is_good"
      ? "IMPORTANT: This is expense data — frame growing numbers as a CONCERN, declining numbers as POSITIVE."
      : metrics.metricDirection === "context_dependent"
      ? "IMPORTANT: This is marketing data — frame ROI and efficiency positively, raw spending growth as neutral."
      : "";
    const extraParts = [];
    if (body.additionalInsights && body.additionalInsights.length > 0) {
      extraParts.push(
        "The user also selected these additional columns for analysis. " +
        "Weave ONE notable pattern from them into your summary (e.g. which category has the highest average, " +
        "or if the range is surprisingly wide): " + JSON.stringify(body.additionalInsights)
      );
    }
    if (body.additionalDimensionInsights && body.additionalDimensionInsights.length > 0) {
      extraParts.push(
        "Additional categorical dimensions selected: " + JSON.stringify(body.additionalDimensionInsights) +
        ". Mention the most notable dimension if relevant."
      );
    }
    const system =
      "You are a senior business analyst writing the executive summary at the top of a " +
      "data report. You are given the key figures the browser already computed from the " +
      "user's spreadsheet (numbers only — no raw rows). Write EXACTLY 4 sentences: " +
      "(1) headline performance with total and trend; " +
      "(2) what's driving results — top product/region; " +
      "(3) biggest risk visible in the provided numbers; " +
      "(4) one specific action to take. " +
      (extraParts.length > 0 ? extraParts.join(" ") + " " : "") +
      "Only reference dimensions that actually appear in the provided metrics. If a metric is absent " +
      "(for example there is no customer concentration or at-risk figure), do NOT mention customers, " +
      "concentration, at-risk, or RFM at all, and never state a metric is zero or missing. " +
      "Use every number exactly as given — never invent, drop, or alter a number. " +
      "Format money using the given currency. Be direct and specific, no preamble, no bullet points, no headings. " +
      (dirNote ? dirNote + " " : "") +
      'Return ONLY a JSON object, no markdown: {"summary": "<the 4 sentences>"}';
    const user = JSON.stringify(body.metrics || {});
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed || !parsed.summary) return json({ error: "bad_output" }, 502, request);
    return json({ summary: String(parsed.summary).trim() }, 200, request);
  }

  if (task === "recommendations") {
    const system =
      "You are a senior business analyst generating smart recommendation cards for a dashboard. " +
      "The browser sends only summary numbers computed from the spreadsheet (a subset of: trend direction " +
      "and percent, customer concentration and at-risk figures, ABC product tier counts and percentages, and " +
      "top product percent of total). Use ONLY the numbers actually present in the provided object. Do not " +
      "invent names, categories, currency, or raw-row facts. If a figure is absent (for example there is no " +
      "customer concentration or at-risk figure), do NOT mention customers, concentration, at-risk, or RFM, " +
      "and never recommend diversifying a customer base. Return 3 to 5 concise, specific recommendation cards ranked " +
      "by business priority. Each card must have priority as a number, label as a short category, title as " +
      "a direct action, detail as one sentence with exact provided numbers, and impact as a short expected " +
      'business effect. Return ONLY a JSON object, no markdown: {"recommendations":[{"priority":1,"label":"Risk","title":"...","detail":"...","impact":"..."}]}';
    const user = JSON.stringify(body.metrics || {});
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.recommendations)) return json({ error: "bad_output" }, 502, request);
    const recommendations = parsed.recommendations
      .filter((item) => item && item.label && item.title && item.detail)
      .slice(0, 5)
      .map((item, index) => ({
        priority: Number(item.priority) || index + 1,
        label: String(item.label).trim(),
        title: String(item.title).trim(),
        detail: String(item.detail).trim(),
        impact: String(item.impact || "").trim()
      }));
    if (recommendations.length === 0) return json({ error: "bad_output" }, 502, request);
    return json({ recommendations }, 200, request);
  }

  if (task === "chart_config") {
    const system =
      "You convert a user's natural-language chart request into a chart builder configuration. " +
      "You are given the user's question, exact column names, column types, and mapped roles. " +
      "Use only exact column names from the provided columns list for x, y, and group_by. " +
      "Use y=\"__count__\" when the user asks to count rows or when no numeric measure is needed. " +
      "Choose chart_type from: bar, horizontal_bar, combo, line, area, donut, scatter, table. " +
      "Choose aggregation from: sum, avg, count, max, min. group_by may be null. " +
      "top_n should be 5, 10, 20, or 0 for all. sort should be desc, asc, or none. " +
      "If the request cannot be mapped to real columns, return nulls for the uncertain fields. " +
      'Return ONLY a JSON object, no markdown: {"chart_type":"bar","x":"Exact column or null","y":"Exact column, __count__, or null","aggregation":"sum","group_by":null,"top_n":10,"sort":"desc","title":"Short chart title"}';
    const user = JSON.stringify({
      question: body.question || "",
      columns: body.columns || [],
      types: body.types || {},
      roles: body.roles || {}
    });
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed) return json({ error: "bad_output" }, 502, request);
    return json({
      chart_type: parsed.chart_type ?? null,
      x: parsed.x ?? null,
      y: parsed.y ?? null,
      aggregation: parsed.aggregation ?? null,
      group_by: parsed.group_by ?? null,
      top_n: parsed.top_n ?? null,
      sort: parsed.sort ?? null,
      title: parsed.title ?? null
    }, 200, request);
  }

  if (task === "comparison_narrative") {
    const system =
      "You are a senior business analyst writing the narrative at the top of a file comparison dashboard. " +
      "The browser sends only computed comparison numbers: period type, current period name/total revenue/row count/average, " +
      "previous period name/total revenue/row count/average, top 3 product change percentages, and top 3 customer change percentages. " +
      "Use only those numbers. Do not invent product names, customer names, currency, causes, or raw-row facts. " +
      "Write exactly 4 sentences explaining what changed: overall revenue, average/volume, product movers, and customer movers. " +
      'Return ONLY a JSON object, no markdown: {"narrative":"4 sentences explaining what changed"}';
    const user = JSON.stringify(body.comparison || {});
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed || !parsed.narrative) return json({ error: "bad_output" }, 502, request);
    return json({ narrative: String(parsed.narrative).trim() }, 200, request);
  }

  if (task === "generate_code") {
    const columns = JSON.stringify(body.columns || []);
    const types = JSON.stringify(body.types || {});
    const roles = JSON.stringify(body.roles || {});
    const samples = JSON.stringify((body.sampleRows || []).slice(0, 5));
    const extraMetrics = body.additionalMetrics || [];
    const extraDims = body.additionalDimensions || [];
    const mode = body.analysisMode || "sum";
    const idCols = body.identifierColumns || [];
    const extraContext = [];
    if (extraMetrics.length > 0) extraContext.push("Additional numeric columns the user wants analyzed: " + JSON.stringify(extraMetrics));
    if (extraDims.length > 0) extraContext.push("Additional categorical dimensions the user wants analyzed: " + JSON.stringify(extraDims));
    if (idCols.length > 0) extraContext.push("Identifier columns (never sum these, use for lookups/grouping only): " + JSON.stringify(idCols));
    if (mode !== "sum") extraContext.push("Analysis mode: " + mode + " — use this aggregation by default (not sum)");
    const system = [
      "You are a data analyst who writes JavaScript code to answer questions about spreadsheet data.",
      "",
      "The user's data has these columns: " + columns,
      "Column types: " + types,
      "Mapped roles: " + roles,
      ...(extraContext.length > 0 ? ["", ...extraContext] : []),
      "",
      "Here are 5 sample rows:",
      samples,
      "",
      "Write a JavaScript function called analyze(rows, mapping) that answers the user's question.",
      "The function receives:",
      "- rows: array of objects, each object is one row with column names as keys, all values are strings",
      "- mapping: object mapping roles to column names (e.g., {revenue: 'UnitPrice', product: 'Product'})",
      "",
      "CRITICAL NULL HANDLING RULES:",
      "- Always convert numeric values: Number(row[col]) || 0",
      "- Check string values exist: (row[col] || '').toString()",
      "- For averages: exclude null rows, count them separately",
      "- If >20% of relevant values are null, add warning to result",
      "- Parse dates safely: new Date(row[col]) — check isNaN",
      "",
      "RETURN FORMAT:",
      "Return a plain object with:",
      "- answer: the main finding (object with specific numbers)",
      "- details: array of {label, value} objects for chart rendering, sorted by value descending",
      "- warning: string if data quality issues found (optional)",
      '- chartType: suggested chart type ("bar","line","donut","scatter","none")',
      "- chartTitle: descriptive title for the chart",
      "",
      "Return ONLY the function code. No markdown. No explanation.",
      "Start with: function analyze(rows, mapping) {"
    ].join("\n");
    const user = String(body.question || "");
    const raw = await callDeepSeek(env, system, user, 2000);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const code = raw.replace(/^```\w*\n?/gm, "").replace(/```$/gm, "").trim();
    return json({ code }, 200, request);
  }

  if (task === "explain_result") {
    const domain = String(body.domain || "general");
    const metricLabel = String(body.metricLabel || "Value");
    // is_money is false when the metric is a units column mislabelled as revenue (e.g. a
    // "sales"-named count with no price). Then the model must never dress numbers as currency.
    const isMoney = body.is_money !== false;
    const system = [
      "You are a data analyst explaining findings to a business owner.",
      "",
      'The user asked: "' + String(body.question || "") + '"',
      "Domain: " + domain,
      "Metric label: " + metricLabel,
      "",
      "The analysis computed these results:",
      String(body.result || "{}"),
      "",
      "Write a 2-4 sentence explanation in plain language.",
      "- Use specific names and numbers from the results",
      "- If there's a warning about data quality, mention it",
      "- If something is concerning (big drop, high concentration), flag it",
      "- If there's an action to take, suggest it briefly",
      '- Match the domain: if expenses, "spending" not "revenue"',
      (isMoney
        ? "- Figures are monetary — format them with a currency symbol."
        : '- The metric is a COUNT of units, NOT money. Write every figure as a plain number (e.g. "8,821 units"), NEVER with a currency symbol.'),
      '- Never say "the data shows" — just state the finding directly',
      "",
      'Return ONLY JSON: {"explanation": "your 2-4 sentences"}'
    ].join("\n");
    const user = "Explain these results.";
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed || !parsed.explanation) return json({ error: "bad_output" }, 502, request);
    return json({ explanation: String(parsed.explanation).trim() }, 200, request);
  }

  if (task === "recommend_charts") {
    const metricCol = String(body.metricColumn || "");
    const dims = body.dimensions || {};
    const extras = body.additionalMetrics || [];
    const extraDims = body.additionalDimensions || [];
    const mode = body.analysisMode || "sum";
    const idCols = body.identifierColumns || [];
    const extraLines = [];
    if (extraDims.length > 0) extraLines.push("Additional categorical dimensions: " + JSON.stringify(extraDims));
    if (idCols.length > 0) extraLines.push("Identifier columns (never sum, use for grouping/lookup only): " + JSON.stringify(idCols));
    if (mode !== "sum") extraLines.push("Default aggregation mode: " + mode + " (use this instead of sum where appropriate)");
    const system = [
      "You are a data analyst recommending charts for a Chart Builder.",
      "",
      "Data domain: " + String(body.domain || "general"),
      "Primary metric column: " + metricCol + " (label: " + String(body.metricLabel || "Value") + ")",
      "Dimension columns: " + JSON.stringify(dims),
      "Additional numeric columns: " + JSON.stringify(extras),
      ...(extraLines.length > 0 ? extraLines : []),
      "All columns: " + JSON.stringify(body.columns || []),
      "Key stats: " + JSON.stringify(body.stats || {}),
      "",
      "Recommend 4-6 charts. Use EXACT column names from above. For each chart:",
      '- title: descriptive (e.g., "Global Sales by Genre", "NA Sales vs EU Sales")',
      '- type: "bar", "line", "donut", "scatter"',
      "- x: exact column name for x-axis",
      "- y: exact column name for y-axis (or \"__count__\" for counting rows)",
      '- aggregation: "sum", "avg", "count", "max", "min", or "none"',
      "- reason: one sentence why this chart matters",
      "",
      "Rules:",
      "- Use ONLY the provided column names exactly as given",
      "- First chart: time trend (line) using the date column if available",
      "- Include bar charts for top categories",
      "- If additional categorical dimensions exist, use them as x-axis for at least one chart",
      "- When comparing two numeric columns (e.g. NA_Sales vs EU_Sales), use type 'scatter' with aggregation 'none' — each row is one point",
      "- Include at least one donut for composition",
      "- Use additional numeric columns for interesting cross-column charts",
      "- Each chart should answer a DIFFERENT question",
      "",
      'Return ONLY JSON: {"charts": [{"title":"...","type":"...","x":"...","y":"...","aggregation":"...","reason":"..."}, ...]}'
    ].join("\n");
    const user = "Recommend charts for the Chart Builder.";
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.charts)) return json({ error: "bad_output" }, 502, request);
    return json({ charts: parsed.charts.slice(0, 6) }, 200, request);
  }

  if (task === "chart_insights_batch") {
    const system = [
      "You are a data analyst. Generate one short insight sentence for each chart.",
      "Each insight should be specific (mention names and numbers from the data provided).",
      "Do not invent numbers or names — use only what is given.",
      "",
      "Charts to write insights for:",
      JSON.stringify(body.charts || []),
      "",
      'Return ONLY JSON: {"insights": ["sentence1", "sentence2", ...]}'
    ].join("\n");
    const user = "Write insight sentences.";
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed || !Array.isArray(parsed.insights)) return json({ error: "bad_output" }, 502, request);
    return json({ insights: parsed.insights }, 200, request);
  }

  if (task === "smart_mapping") {
    const columns = JSON.stringify(body.columns || []);
    const samples = JSON.stringify((body.sampleRows || []).slice(0, 5));
    const totalRows = body.totalRows || "unknown";
    const system = [
      "You are a senior business analyst. Examine ALL columns together and map them for READABLE, USEFUL analysis.",
      "",
      "Column profiles (with uniqueCount, nullCount, isSequential, isAllUnique flags): " + columns,
      "Sample rows: " + samples,
      "Total rows in dataset: " + totalRows,
      "",
      "GROUPING RULES — ALWAYS prefer readable names over ID codes:",
      "- product: prefer 'Category'/'Sub-Category'/'Product Name' (readable labels, moderate cardinality 2-200) over 'Product ID'",
      "- customer: prefer 'Customer Name' over 'Customer ID'. Names are readable; IDs are not.",
      "- region: must be a GEOGRAPHIC location (Region/State/City/Country). Prefer 2-20 distinct values (e.g. South/West/East). Do NOT map sales channels (In-store/Online/Takeaway) or order types as region — put those in suggestedAdditionalDimensions instead",
      "- When both an ID column and a Name column exist for the same entity, ALWAYS use the Name",
      "- A column with uniqueCount close to totalRows is usually an identifier, not a useful grouping",
      "",
      "METRIC: choose real business value (Sales/Revenue/Profit/Amount). Never an identifier.",
      "",
      "IDENTIFIERS — list in identifierColumns, NEVER sum/average/chart these:",
      "- Row ID, Order ID, Customer ID, Product ID, Postal Code, ZIP",
      "- Any column named id/code/zip/postal/index/row (case-insensitive)",
      "- Any sequential-number column (isSequential=true)",
      "- Any near-all-unique numeric column (isAllUnique=true)",
      "",
      "MODE:",
      '- "sum" for real measures (revenue, sales, amounts, spending)',
      '- "count" for lists/directories with no meaningful numeric measure',
      '- "average" for ratings, scores, percentages',
      "",
      "If a Profit column exists, ALWAYS include it in suggestedAdditionalMetrics.",
      "If Discount/Quantity columns exist, include them too.",
      "",
      "mapping roles: date, revenue (primary metric), product, customer, region, quantity, cost (COGS/expense — NOT profit), profit (net profit — NOT cost), discount, orderId",
      "IMPORTANT: cost and profit are DIFFERENT roles. Never map the same column to both. If only Profit exists (no Cost column), set cost to empty string and profit to the Profit column.",
      'domain: one of "sales","ecommerce","expenses","marketing","client","general"',
      "metricLabel: human-readable name (Sales, Revenue, Count, Rating, etc.)",
      'metricDirection: "up_is_good", "down_is_good", or "context_dependent"',
      "reasoning: 2-3 sentences explaining WHY you chose each grouping column over alternatives",
      "",
      "Return ONLY JSON:",
      '{"analysisMode":"...","primaryMetric":"col_name or null","metricLabel":"...","metricDirection":"...","domain":"...","mapping":{"date":"...","revenue":"...","product":"...","customer":"...","region":"...","quantity":"...","cost":"...","profit":"...","discount":"...","orderId":"..."},"identifierColumns":["..."],"suggestedAdditionalMetrics":["..."],"suggestedAdditionalDimensions":["..."],"reasoning":"..."}'
    ].join("\n");
    const user = "Analyze these columns and decide the mapping strategy.";
    const raw = await callDeepSeek(env, system, user, 1500);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    if (!parsed) return json({ error: "bad_output" }, 502, request);
    return json(parsed, 200, request);
  }

  if (task === "chart_insight") {
    const system =
      "You are a data analyst writing one short insight sentence below a dashboard chart. " +
      "The browser sends only the chart's computed summary: the question answered by the chart, " +
      "top 3 items with name, value, and percent of total, total number of items, and average value. " +
      "Use only those numbers. Do not invent units, currency, causes, raw-row facts, or names. " +
      "Write exactly one sentence that states the main takeaway and includes at least one provided number. " +
      'Return ONLY a JSON object, no markdown: {"insight":"one sentence"}';
    const user = JSON.stringify(body.summary || {});
    const raw = await callDeepSeek(env, system, user);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    const parsed = extractJson(raw);
    const insight = parsed && (parsed.insight || parsed.text);
    if (!insight) return json({ error: "bad_output" }, 502, request);
    return json({ insight: String(insight).trim() }, 200, request);
  }

  if (task === "ai_report") {
    const system = String(body.systemPrompt || "You are a senior data analyst. Analyze the provided data summary and generate a comprehensive report.");
    const user = String(body.userPrompt || "");
    const raw = await callDeepSeek(env, system, user, 3000);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    return json({ text: raw.trim() }, 200, request);
  }

  if (task === "ai_agent") {
    const system = String(body.systemPrompt || "You are a data analyst.");
    const user = String(body.userPrompt || "");
    const raw = await callDeepSeek(env, system, user, 2000);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    return json({ text: raw.trim() }, 200, request);
  }

  if (task === "auto_insights") {
    const system = String(body.systemPrompt || "You are a data analyst generating quick insights.");
    const user = String(body.userPrompt || "");
    const raw = await callDeepSeek(env, system, user, 1500);
    if (raw == null) return json({ error: "ai_unavailable" }, 503, request);
    return json({ text: raw.trim() }, 200, request);
  }

  return json({ error: "unknown_task" }, 400, request);
}

function intentParseSystemPrompt(body) {
  const columns = JSON.stringify(body.columns || []);
  const types = JSON.stringify(body.types || {});
  const roles = JSON.stringify(body.roles || {});
  return [
    "You are a data analyst assistant. A user uploaded a spreadsheet and is asking a question about it.",
    "",
    "The spreadsheet has these columns: " + columns,
    "Column types: " + types,
    "Column roles: " + roles,
    "",
    "Your job: figure out what the user wants and return a JSON command so the app can show the right answer from the LOCAL data.",
    "",
    "Return ONLY a JSON object with these fields:",
    "{",
    '  "intent": what the user wants. One of:',
    '    "total" - they want a single number (total, sum, how much)',
    '    "average" - they want an average value',
    '    "ranking" - they want to see items ranked (best, worst, top, bottom)',
    '    "trend" - they want to see how something changed over time',
    '    "forecast" - they want to predict the future',
    '    "driver" - they want to know WHY something happened or what caused a change',
    '    "composition" - they want to see the breakdown/share of categories',
    '    "concentration" - they want to know if too much depends on a few items',
    '    "anomaly" - they want to find unusual patterns or spikes/drops',
    '    "summary" - they want an overall overview',
    '    "actions" - they want advice on what to do',
    '    "health" - they want to know about customer health/risk/churn',
    '    "specific_item" - they asked about one specific product/customer/region by name',
    '    "comparison" - they want to compare two or more things',
    '    "unknown" - you cannot understand the question',
    "",
    '  "dimension": which column to group by. Use the ROLE name:',
    '    "product" - group by the product/item column',
    '    "region" - group by the region/location column',
    '    "customer" - group by the customer column',
    '    "period" - group by time/date',
    '    null - no grouping needed',
    "",
    '  "direction": "top" or "bottom" or null',
    '  "top_n": number or null',
    '  "entity": if the user mentioned a specific name, put it here, otherwise null',
    '  "chart_type": "line" or "bar" or "horizontal_bar" or "donut" or "scatter" or "none"',
    '  "time_filter": if the user mentioned a specific time (March, Q1, 2024, last month), put it here, otherwise null',
    "}",
    "",
    "Important: understand the user's INTENT, not just their words. The user may ask in any language. They may use slang, abbreviations, or vague phrasing. Figure out what they actually want to know about their business data.",
    "",
    "A few examples:",
    '"kaunsa product sabse zyada bika?" → ranking, dimension:product, direction:top',
    '"why revenue down?" → driver, dimension:product',
    '"next quarter ka prediction do" → forecast, dimension:period',
    '"top 3 customers" → ranking, dimension:customer, direction:top, top_n:3',
    '"March me kya hua?" → driver, dimension:product, time_filter:March',
    '"show me the trend" → trend, dimension:period',
    '"is everything okay?" → summary',
    '"what should I focus on?" → actions',
    "",
    "Return ONLY valid JSON. No markdown. No explanation."
  ].join("\n");
}

async function callDeepSeek(env, systemPrompt, userMessage, maxTokens = 1000) {
  if (!env.DEEPSEEK_KEY) return null;
  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.DEEPSEEK_KEY
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        max_tokens: maxTokens,
        temperature: 0
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

// Pull a JSON object out of a model response, tolerating ```json fences or
// surrounding prose.
function extractJson(text) {
  let t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function json(obj, status, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" }
  });
}

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
