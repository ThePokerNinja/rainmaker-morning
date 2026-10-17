/** Client-side Stock Hacker CSV parser (matches import_scans.py). */
(function (global) {
  const SYMBOL_KEYS = ["symbol", "sym", "ticker"];
  const CONFIDENCE_KEYS = [
    "rm_confidence",
    "rm confidence",
    "custom 1",
    "custom1",
    "confidence",
    "custom quote",
  ];
  const LAST_KEYS = ["last", "price"];
  const PCT_KEYS = ["%change", "pct change", "percent change", "net chng %"];
  const GAP_KEYS = ["gap", "gap %", "gap%", "pre market gap"];
  const VOLUME_KEYS = ["volume", "vol"];

  function isMomentumBullPick(p) {
    if (p.pct_change != null && Number(p.pct_change) < 0) return false;
    if (p.gap_pct != null && Number(p.gap_pct) < 0) return false;
    return true;
  }

  function normKey(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function pick(row, keys) {
    const normalized = {};
    for (const [k, v] of Object.entries(row)) {
      if (k != null) normalized[normKey(k)] = v;
    }
    for (const key of keys) {
      const val = normalized[normKey(key)];
      if (val != null && String(val).trim() !== "") return String(val).trim();
    }
    return null;
  }

  function parseFloatVal(value) {
    if (value == null) return null;
    const cleaned = String(value).replace(/,/g, "").replace(/%/g, "").trim();
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? null : n;
  }

  function findHeaderLine(lines) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().startsWith("symbol,")) return i;
      const cols = line.split(",").map((c) => c.trim());
      if (cols.some((c) => normKey(c) === "symbol")) return i;
    }
    return null;
  }

  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === "," && !inQ) {
        out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function parseCsvText(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
    const headerIdx = findHeaderLine(lines);
    if (headerIdx == null) throw new Error("No Symbol column found in CSV");

    const headers = parseCsvLine(lines[headerIdx]);
    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const vals = parseCsvLine(lines[i]);
      if (!vals.some((v) => v)) continue;
      const row = {};
      headers.forEach((h, j) => {
        row[h] = vals[j] ?? "";
      });
      rows.push(row);
    }
    return rows;
  }

  function parseScanCsvText(text, fileName) {
    const rows = parseCsvText(text);
    const picks = [];
    for (const row of rows) {
      let symbol = pick(row, SYMBOL_KEYS);
      if (!symbol) continue;
      symbol = symbol.toUpperCase();
      const pctChange = parseFloatVal(pick(row, PCT_KEYS));
      let gapPct = parseFloatVal(pick(row, GAP_KEYS));
      if (gapPct != null && gapPct < 0) gapPct = null;
      picks.push({
        symbol,
        rm_confidence: parseFloatVal(pick(row, CONFIDENCE_KEYS)),
        last: parseFloatVal(pick(row, LAST_KEYS)),
        pct_change: pctChange,
        gap_pct: gapPct,
        pct_eod: pctChange,
        volume: parseFloatVal(pick(row, VOLUME_KEYS)),
        catalyst: {
          status: "pending",
          proxy_only: true,
          verified: null,
          headline: null,
          source_url: null,
          headlines: [],
          rm_confidence_adjusted: null,
        },
      });
    }
    const filtered = picks.filter(isMomentumBullPick);
    picks.length = 0;
    picks.push(...filtered);
    picks.sort((a, b) => {
      const ca = a.rm_confidence == null;
      const cb = b.rm_confidence == null;
      if (ca !== cb) return ca ? 1 : -1;
      return (b.rm_confidence || 0) - (a.rm_confidence || 0);
    });
    picks.forEach((p, i) => {
      p.rank = i + 1;
    });

    const stem = (fileName || "scan").replace(/\.csv$/i, "");
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    return {
      hypothesis_id: "H-001",
      session_id: stem + "-imported-" + stamp,
      scanned_at: new Date().toISOString(),
      source_file: fileName || "import.csv",
      session_label: "imported",
      pick_count: picks.length,
      picks,
    };
  }

  global.RMScanParser = { parseScanCsvText };
})(typeof window !== "undefined" ? window : globalThis);
