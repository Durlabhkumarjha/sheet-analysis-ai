# Sheet Analysis AI Product Roadmap

## Target

Build a simple, premium spreadsheet analysis tool for normal business users and data analysts.

The product should feel easier than Power BI and more reliable than asking a chatbot to inspect a file. The core promise is:

Upload a messy spreadsheet, confirm the important columns, get a clean dashboard and manager-ready report.

## Current MVP

- CSV, XLSX, and XLS upload
- Sample sales data
- Automatic column profiling
- User-confirmed column mapping
- Revenue KPIs
- Period trend chart
- Product, region, and customer breakdowns
- Executive summary
- Data quality notes
- Column assumptions
- Local rule-based report Q&A
- Browser print/PDF export

## Product Principles

- Do the math in code, not inside an LLM.
- Let users confirm assumptions before analysis.
- Make the first useful report in under one minute.
- Keep the UI simple enough for non-technical users.
- Keep enough transparency for analysts to trust it.
- Every report should explain what data was used and what may be wrong.

## AppSumo-Ready Priorities

### 1. Report Export

- Add a dedicated PDF/report view.
- Add company/report title controls.
- Add logo upload.
- Add generated date and source file.
- Add assumptions, data quality notes, and KPI sections.
- Add a clean executive-summary page.

### 2. Better Visuals

- Add polished chart states for empty/weak data.
- Add line chart labels and period comparison.
- Add margin chart when cost/profit is mapped.
- Add customer concentration view.
- Add outlier detection.

### 3. Data Cleaning

- Detect duplicate rows.
- Detect blank rows.
- Detect total/summary rows.
- Parse currency symbols and percentages more robustly.
- Let users exclude bad rows.
- Show a "what was cleaned" section.

### 4. AI Layer

- Add bring-your-own API key first.
- AI should choose deterministic tools.
- Tools should calculate:
  - compare periods
  - rank by metric
  - calculate margin
  - forecast revenue
  - find outliers
  - write manager summary
- AI should explain calculated results, not invent numbers.

### 5. Saved Workflows

- Save previous column mappings in local storage.
- Reuse mappings for similar monthly files.
- Add recent reports.
- Later add accounts/cloud sync if needed.

## Later

- Multiple sheets per workbook
- Drag-and-drop report builder
- White-label reports
- Desktop packaging with Tauri or Electron
- Team sharing
- Scheduled monthly report generation
