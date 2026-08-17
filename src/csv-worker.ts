import { parseCsv } from "./csv-parse";

self.onmessage = (e: MessageEvent<string>) => {
  try {
    const result = parseCsv(e.data);
    self.postMessage({ type: "success", data: result });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : "CSV parse failed" });
  }
};
