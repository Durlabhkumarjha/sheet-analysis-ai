import { detectHeaderRow } from "./dataQuality";

export function dedupeHeaders(headers: string[]) {
  const counts = new Map<string, number>();
  return headers.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? base : `${base} ${count + 1}`;
  });
}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[]; headerWarning?: string } {
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

  const detection = detectHeaderRow(records);
  const headerIdx = detection.firstRowIsHeader ? 0 : detection.headerIndex;
  const headers = dedupeHeaders(records[headerIdx] ?? []);
  const rows = records.slice(headerIdx + 1).map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""]))
  );
  const headerWarning = detection.firstRowIsHeader
    ? undefined
    : `The first ${headerIdx} row${headerIdx === 1 ? "" : "s"} look like a title or notes, not column names. Using row ${headerIdx + 1} (${headers.slice(0, 4).join(", ")}…) as the header.`;
  return headerWarning ? { headers, rows, headerWarning } : { headers, rows };
}
