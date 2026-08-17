# Sheet Analysis AI

## What It Is

A browser-based spreadsheet analysis tool that turns messy CSV, XLSX, and XLS files into clean dashboards and manager-ready reports in under one minute. No backend, no signup, no data leaves the browser.

## Who It's For

- Small business owners who export sales data from Shopify, QuickBooks, or POS systems
- Freelancers and consultants who prepare client reports from spreadsheets
- Data analysts who need a faster alternative to Power BI for simple monthly reports
- Marketing managers tracking campaign performance across regions or products
- Anyone who gets a monthly spreadsheet and needs to make sense of it quickly

## App Structure (4 Tabs)

### 1. Upload
- Supports CSV, XLSX, and XLS files (up to 100,000 rows)
- Automatically detects column types: date, revenue, product, customer, region, cost, discount
- Smart column mapping popup — user confirms before analysis begins
- **No mandatory columns** — works with any numeric data, date-only files, or auto-detects first numeric column
- Saved mappings auto-apply to similar monthly files
- **Inline data quality panel**: trust score, blank/duplicate/summary row counts, one-click cleaning buttons
- Match percentage shown when uploading similar files

### 2. Dashboard
- Collapsible **Report Settings** panel (title, company, template, currency, brand color)
- **Print / Export controls** with per-section checkboxes (summary, KPIs, comparison, charts, outliers, details, custom charts, AI report)
- Executive summary and recommended actions generated from data
- KPIs: total metric, rows analyzed, average, period-over-period change
- Revenue trend line chart with data labels
- Breakdown by product, region, and customer (horizontal bar charts)
- Margin-by-product chart (when cost column is mapped)
- Customer concentration analysis with risk warnings
- Outlier and anomaly detection
- **File Comparison** (upload + results in one place on Dashboard)
  - Clear "File 1 vs File 2" visual layout
  - 6 KPIs: revenue, rows, avg transaction for both periods
  - Product-by-product comparison table with change %
  - Region-by-region comparison table with change %
  - Multi-file comparison table (collapsible, unlimited files)
- Custom charts rendered for print (when toggled on)
- AI report sections rendered for print (when toggled on)
- Print-ready cover page with metadata (source file, date, rows, trust score)
- 4 report templates: Sales, E-commerce, Expenses, Client

### 3. Explore
- **Chart Builder**: create custom charts from any columns
  - 7 chart types: bar, pie, donut, scatter, line, table, pivot
  - X-axis / Y-axis column selection
  - 5 aggregation modes: sum, avg, count, min, max
  - Optional group-by column
  - Add unlimited charts, remove individually
  - **Export charts as PNG** (2x resolution)
- **Raw Data Table**: browse actual data rows
  - Text filter across all columns
  - Click-to-sort on any column (ascending/descending)
  - Pagination (50 rows per page)
- **Summary Statistics**: descriptive stats for all numeric columns
  - Count, missing, sum, mean, median, std dev, min, max
- **Correlation Matrix**: heatmap showing correlation between numeric columns
  - Color-coded: green (positive), red (negative)
- **Data Type Distribution**: visual bar showing number/text/date/empty breakdown per column
- **Null & Blank Heatmap**: row-chunk visualization of missing data patterns
  - Color-coded: green (complete) → red (mostly null)

### 4. AI Insights
- Collapsible **AI Provider Settings** panel (auto-opens if no key set)
  - Supports 6 providers: OpenAI, Google Gemini, Groq, OpenRouter, DeepSeek, Mistral
  - 22 AI models available across providers
  - API key stored locally in browser, never sent to any server
- **Talk to Data** (hero feature): conversational AI interface at the top
  - Natural language queries: "Compare products", "Which product sold most?", "Show revenue trend"
  - AI generates charts (bar, pie, line, scatter, pivot, table) based on questions
  - Quick suggestion buttons for common queries
  - 22 prompt templates across 5 categories (Analysis, Writing, Strategy, Data Quality, Comparisons)
- **Auto Insights**: AI-generated highlights when connected
- **One-click AI Report**: generates full report with executive summary, trends, charts, risks, and recommendations
  - Parsed into titled sections with optional inline charts
  - Includable in print via checkbox
- **AI Agents**: 5 one-click agents — Key Insights, Anomaly Detection, Revenue Forecast, Executive Report, Action Plan
- AI uses deterministic math (never invents numbers)

## Smart Data Cleaning

- Detects blank rows, duplicate rows, and total/summary rows
- One-click exclude buttons per issue type (inline in Upload tab)
- "What was cleaned" summary so users know what happened
- Export cleaned CSV or skipped rows separately
- Trust score (0-100%) rates data quality — shown as badge on Dashboard tab

## Flexible Analysis

- Works with any spreadsheet — no mandatory columns required
- If a value column (revenue/quantity/cost) is mapped → full analysis with sums and averages
- If only date is mapped → count-based analysis (events per period)
- If no columns mapped → auto-detects first numeric column from data
- `primaryMetric` label adapts (Revenue, Quantity, Cost, Count, or auto-detected column name)

## What Makes It Different

| Feature | Sheet Analysis AI | InstaCharts | SheetMagic | Columns |
|---------|------------------|-------------|------------|---------|
| No backend / no signup | Yes | No | No | No |
| Data never leaves browser | Yes | No | No | No |
| Auto column detection | Yes | No | Partial | No |
| Data cleaning with undo | Yes | No | No | No |
| Trust score | Yes | No | No | No |
| Outlier detection | Yes | No | No | No |
| Customer concentration | Yes | No | No | No |
| Multi-file comparison | Yes | No | No | Partial |
| Manual chart builder (7 types) | Yes | No | Partial | No |
| Summary stats + correlation | Yes | No | No | No |
| Null heatmap + data types | Yes | No | No | No |
| Export charts as PNG | Yes | No | No | No |
| Printable reports with controls | Yes | No | No | No |
| One-click AI report | Yes | No | No | No |
| BYOK AI (6 providers) | Yes | No | 1 provider | No |
| AI agents (one-click) | Yes | No | No | No |
| Saved mappings | Yes | No | No | No |
| Lifetime deal friendly | Yes (zero server cost) | No | No | No |

## Technical Details

- **Stack**: React + TypeScript + Vite (frontend-only SPA)
- **Hosting**: Any static host (Netlify, Vercel, Cloudflare Pages, S3)
- **File parsing**: XLSX.js for Excel files, custom CSV parser
- **Charts**: SVG-based, no chart library dependency (7 types: bar, pie, donut, scatter, line, table, pivot)
- **AI**: Direct browser-to-provider API calls (no proxy server)
- **Storage**: localStorage for settings, mappings, workflows
- **Size**: ~614 KB JS + ~31 KB CSS (gzipped: ~200 KB + ~7 KB)
- **Row limit**: 100,000 rows per file
- **PWA**: Service worker ready (Netlify config included)
- **Contact**: sheetanalysisai@gmail.com

## Pricing Model (AppSumo)

- Lifetime deal: one-time purchase (~$39)
- No server costs (everything runs in browser)
- AI costs paid directly by user to their chosen provider (BYOK)
- No usage limits, no monthly fees, no subscriptions
- Revenue = AppSumo deal sales only

## File Structure

```
src/
  App.tsx        - Main application (types, components, logic, AI)
  styles.css     - All styles including print CSS
  main.tsx       - Entry point
index.html       - HTML shell
vite.config.ts   - Build config
netlify.toml     - Netlify deployment config
public/
  privacy.html   - Privacy policy page
  terms.html     - Terms of service page
  robots.txt     - SEO
  sitemap.xml    - SEO
  icons/         - PWA icons
```
