self.onmessage = (e: MessageEvent<{ code: string; rows: Record<string, string>[]; mapping: Record<string, string> }>) => {
  const { code, rows, mapping } = e.data;
  try {
    const fn = new Function("rows", "mapping", code + "\nreturn analyze(rows, mapping);");
    const start = Date.now();
    const result = fn(rows, mapping);
    const elapsed = Date.now() - start;
    if (elapsed > 10000) {
      self.postMessage({ success: false, error: "Analysis timed out", elapsed });
      return;
    }
    self.postMessage({ success: true, data: result, elapsed });
  } catch (err) {
    self.postMessage({ success: false, error: err instanceof Error ? err.message : "Code execution failed" });
  }
};
