import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
// The real Sheet Analysis AI engine (same code the website runs)
import { analyze } from "../src/analysis/index";

// Read a .csv or .xlsx file into rows of text values
function loadRows(filePath: string): Record<string, string>[] {
  const isCsv = filePath.toLowerCase().endsWith(".csv");
  const wb = XLSX.read(readFileSync(filePath), { type: "buffer", raw: isCsv });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, {
    raw: false,
    defval: "",
    dateNF: "yyyy-mm-dd",
  });
}

const server = new McpServer({ name: "sheet-analysis-ai", version: "1.0.0" });

server.registerTool(
  "list_columns",
  {
    description:
      "List the column names and first 3 rows of a CSV or Excel file. Call this first to find which columns hold the date, revenue, quantity, cost and product.",
    inputSchema: { filePath: z.string().describe("Full path to a .csv or .xlsx file") },
  },
  async ({ filePath }) => {
    const rows = loadRows(filePath);
    const out = { rowCount: rows.length, columns: Object.keys(rows[0] ?? {}), sample: rows.slice(0, 3) };
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "analyze_sheet",
  {
    description:
      "Analyse a CSV or Excel file. Returns totals, period series, trend, category, seasonality, outliers, risks and recommendation bases. Every number is computed in code from the source rows, not by the AI model.",
    inputSchema: {
      filePath: z.string().describe("Full path to a .csv or .xlsx file"),
      date: z.string().optional().describe("Name of the date column"),
      revenue: z.string().optional().describe("Name of the revenue / amount column"),
      quantity: z.string().optional().describe("Name of the quantity column"),
      cost: z.string().optional().describe("Name of the cost column"),
      product: z.string().optional().describe("Name of the product / category column"),
    },
  },
  async ({ filePath, ...mapping }) => {
    const rows = loadRows(filePath);
    const { findings } = analyze(rows, mapping);
    return { content: [{ type: "text", text: JSON.stringify(findings, null, 2) }] };
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
