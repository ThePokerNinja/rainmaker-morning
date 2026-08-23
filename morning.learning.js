/* --- greenlit_panel.js --- */
/**
 * Green-light validation panel (Batch 2 #5).
 */
(function (global) {
  const PANEL_ID = "ttGreenLitPanel";
  const MIN_SAMPLE = 5;
  const MIN_TOTAL = 8;
  let timer = null;

  function pct(v) {
    return v == null ? "-" : Math.round(v * 100) + "%";
  }
  function rfmt(v) {
    return v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
  }

  function render() {
    const el = document.getElementById(PANEL_ID);
    if (!el || typeof global.RMMetrics === "undefined") return;
    const data = global.RMMetrics.greenLitValidation();
    if (!data || data.total < MIN_TOTAL) {
      el.innerHTML =
        '<div class="tt-learning-head"><h3>Validation edge</h3>' +
        '<span class="tt-learning-tag">building</span></div>' +
        '<p class="tt-learning-note">Logging trades against their validation count. ' +
        "Need " +
        MIN_TOTAL +
        "+ closed trades to show win% / avg R by 0-3 validated (have " +
        (data ? data.total : 0) +
        ").</p>";
      return;
    }

    const rows = [3, 2, 1, 0]
      .map((k) => {
        const b = data.buckets[k];
        const thin = b.trades < MIN_SAMPLE;
        const winClass = b.winRate != null && b.winRate >= 0.5 ? "is-good" : "is-weak";
        const rClass = b.avgR != null && b.avgR > 0 ? "is-good" : "is-weak";
        return (
          '<tr' +
          (thin ? ' class="is-thin"' : "") +
          '><th scope="row"><span class="glv-dots">' +
          [0, 1, 2]
            .map((i) => '<i class="glv-dot' + (i < k ? " is-lit" : "") + '"></i>')
            .join("") +
          "</span>" +
          k +
          "/3</th>" +
          '<td>' +
          b.trades +
          "</td>" +
          '<td class="' +
          winClass +
          '">' +
          pct(b.winRate) +
          "</td>" +
          '<td class="' +
          rClass +
          '">' +
          rfmt(b.avgR) +
          (thin ? '<span class="glv-thin">thin</span>' : "") +
          "</td></tr>"
        );
      })
      .join("");

    const lit3 = data.buckets[3];
    const lit0 = data.buckets[0];
    let verdict = "";
    if (lit3.trades >= MIN_SAMPLE && lit0.trades >= MIN_SAMPLE) {
      const edge =
        (lit3.avgR != null ? lit3.avgR : 0) - (lit0.avgR != null ? lit0.avgR : 0);
      verdict =
        '<p class="tt-learning-note">' +
        (edge > 0
          ? "Fully-charged (3/3) trades are running " +
            edge.toFixed(2) +
            "R better than 0/3 - diligence is paying."
          : "No edge yet for 3/3 over 0/3 - keep sampling.") +
        "</p>";
    }

    el.innerHTML =
      '<div class="tt-learning-head"><h3>Validation edge</h3>' +
      '<span class="tt-learning-tag">' +
      data.total +
      " trades - " +
      data.nDays +
      "d</span></div>" +
      '<table class="glv-table"><thead><tr>' +
      "<th>Validated</th><th>Trades</th><th>Win%</th><th>Avg R</th>" +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>" +
      verdict;
  }

  function startPoll() {
    if (timer) return;
    timer = setInterval(render, 15000);
  }

  function stopPoll() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function onLearningTabShown() {
    render();
    startPoll();
  }

  function start() {
    render();
    document.addEventListener("rm:results-tab-shown", onLearningTabShown);
    document.addEventListener("rm:strategy-tab-shown", onLearningTabShown);
    document.addEventListener("rm:trade-closed", render);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopPoll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  global.RMGreenLitPanel = { render, startPoll, stopPoll };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- backtest_h001.js --- */
/** H-001 ORH 2R intraday backtest on 5m bars (ADR-004 v0). */
(function (global) {
  const STORAGE_PREFIX = "rainmaker_backtest_h001_v1_";

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
  }

  function ptDayKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  }

  function ptMinutes(ms) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date(ms));
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return hour * 60 + minute;
  }

  function openingRangeFromBars(bars, rthStartMs, orMinutes = 5) {
    if (!bars?.length) return { orh: null, orl: null, orEndMs: null };
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    const dayBars = bars.filter((b) => ptDayKey(b.t) === lastDay);
    let orBars = [];
    let orEndMs = null;
    if (rthStartMs) {
      orEndMs = rthStartMs + orMinutes * 60 * 1000;
      orBars = dayBars.filter((b) => b.t >= rthStartMs && b.t < orEndMs);
    }
    if (!orBars.length) {
      const openMin = 6 * 60 + 30;
      orBars = dayBars.filter((b) => {
        const mins = ptMinutes(b.t);
        return mins >= openMin && mins < openMin + orMinutes;
      });
      if (orBars.length) orEndMs = orBars[orBars.length - 1].t + 60000;
    }
    if (!orBars.length) return { orh: null, orl: null, orEndMs: null };
    return {
      orh: Math.max(...orBars.map((b) => b.high ?? b.close)),
      orl: Math.min(...orBars.map((b) => b.low ?? b.close)),
      orEndMs,
    };
  }

  function simulateOrh2R(bars, meta, opts) {
    const rr = opts?.rr ?? 2;
    const rthStartMs = meta?.periods?.regular?.startMs ?? null;
    const { orh, orl, orEndMs } = openingRangeFromBars(bars, rthStartMs);
    if (orh == null || orl == null) return { error: "no_or", orh, orl };

    const stop = round2(orl - 0.01);
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    const dayBars = bars.filter((b) => ptDayKey(b.t) === lastDay);

    let entryIdx = -1;
    let entry = null;
    for (let i = 0; i < dayBars.length; i++) {
      const b = dayBars[i];
      if (orEndMs && b.t < orEndMs) continue;
      if (!orEndMs) {
        const mins = ptMinutes(b.t);
        if (mins < 6 * 60 + 35) continue;
      }
      if ((b.close ?? b.high) > orh) {
        entryIdx = i;
        entry = round2(orh);
        break;
      }
    }
    if (entry == null) return { error: "no_break", orh, orl, stop };

    const risk = entry - stop;
    if (!Number.isFinite(risk) || risk <= 0) {
      return { error: "bad_risk", orh, orl, stop, entry };
    }
    const target = round2(entry + risk * rr);

    let exit = null;
    let hit = "eod";
    for (let j = entryIdx + 1; j < dayBars.length; j++) {
      const b = dayBars[j];
      if ((b.low ?? b.close) <= stop) {
        exit = stop;
        hit = "stop";
        break;
      }
      if ((b.high ?? b.close) >= target) {
        exit = target;
        hit = "target";
        break;
      }
    }
    if (exit == null) exit = round2(dayBars[dayBars.length - 1].close);
    const r = (exit - entry) / risk;
    return {
      orh: round2(orh),
      orl: round2(orl),
      entry,
      stop,
      target,
      exit,
      hit,
      r_multiple: round4(r),
    };
  }

  /** Session VWAP series across the provided (already day-filtered) bars. */
  function vwapSeries(dayBars) {
    let cumPV = 0;
    let cumV = 0;
    return dayBars.map((b) => {
      const tp = ((b.high ?? b.close) + (b.low ?? b.close) + (b.close ?? 0)) / 3;
      const v = b.volume ?? b.v ?? 0;
      cumPV += tp * v;
      cumV += v;
      return cumV > 0 ? cumPV / cumV : b.close ?? null;
    });
  }

  /** Long VWAP-reclaim: first close back above VWAP after trading below it; stop = session low. */
  function simulateVwapReclaim(bars, meta, opts) {
    const rr = opts?.rr ?? 1.5;
    const rthStartMs = meta?.periods?.regular?.startMs ?? null;
    if (!bars?.length) return { error: "no_bars" };
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    let dayBars = bars.filter((b) => ptDayKey(b.t) === lastDay);
    dayBars = rthStartMs
      ? dayBars.filter((b) => b.t >= rthStartMs)
      : dayBars.filter((b) => ptMinutes(b.t) >= 6 * 60 + 30);
    if (dayBars.length < 3) return { error: "no_bars" };
    const vw = vwapSeries(dayBars);

    let entryIdx = -1;
    let entry = null;
    let sawBelow = false;
    for (let i = 0; i < dayBars.length; i++) {
      const c = dayBars[i].close ?? dayBars[i].high;
      if (c == null || vw[i] == null) continue;
      if (c < vw[i]) sawBelow = true;
      else if (sawBelow && c > vw[i]) {
        entryIdx = i;
        entry = round2(c);
        break;
      }
    }
    if (entry == null) return { error: "no_break", vwap: round2(vw[vw.length - 1]) };

    const low = Math.min(...dayBars.slice(0, entryIdx + 1).map((b) => b.low ?? b.close));
    const stop = round2(low - 0.01);
    const risk = entry - stop;
    if (!Number.isFinite(risk) || risk <= 0) return { error: "bad_risk", entry, stop };
    const target = round2(entry + risk * rr);

    let exit = null;
    let hit = "eod";
    for (let j = entryIdx + 1; j < dayBars.length; j++) {
      const b = dayBars[j];
      if ((b.low ?? b.close) <= stop) {
        exit = stop;
        hit = "stop";
        break;
      }
      if ((b.high ?? b.close) >= target) {
        exit = target;
        hit = "target";
        break;
      }
    }
    if (exit == null) exit = round2(dayBars[dayBars.length - 1].close);
    return {
      entry,
      stop,
      target,
      exit,
      hit,
      vwap: round2(vw[entryIdx]),
      r_multiple: round4((exit - entry) / risk),
    };
  }

  /** Dispatch to the simulator matching the strategy's entry rule. */
  function simulateForRule(bars, meta, opts) {
    if (opts?.entryRule === "vwap") return simulateVwapReclaim(bars, meta, opts);
    return simulateOrh2R(bars, meta, opts);
  }

  async function runForSymbol(symbol, opts) {
    if (typeof RMYahooFetch === "undefined") {
      return { symbol, error: "no_fetch" };
    }
    const payload = await RMYahooFetch.fetchChartBars(
      symbol,
      opts?.interval || "5m",
      opts?.range || "1d",
      { includePrePost: true }
    );
    if (!payload?.bars?.length) return { symbol, error: "no_bars" };
    const sim = simulateForRule(payload.bars, payload.meta, opts);
    return { symbol, ...sim };
  }

  function summarize(results) {
    const withR = results.filter((r) => r.r_multiple != null);
    const wins = withR.filter((r) => r.r_multiple > 0).length;
    return {
      n: withR.length,
      avgR:
        withR.length > 0
          ? round2(withR.reduce((s, r) => s + r.r_multiple, 0) / withR.length)
          : null,
      winRate: withR.length > 0 ? Math.round((wins / withR.length) * 100) : null,
      hitTarget: results.filter((r) => r.hit === "target").length,
      hitStop: results.filter((r) => r.hit === "stop").length,
      hitEod: results.filter((r) => r.hit === "eod").length,
      noEntry: results.filter((r) => r.error === "no_break").length,
      errors: results.filter((r) => r.error && r.error !== "no_break").length,
    };
  }

  async function runSession(picks, opts) {
    const list = (picks || []).slice(0, opts?.limit ?? 8);
    const results = [];
    for (const p of list) {
      const sym = typeof p === "string" ? p : p.symbol;
      if (!sym) continue;
      const rm =
        typeof p === "object"
          ? p.rm_confidence_adjusted ?? p.rm_confidence
          : null;
      results.push(await runForSymbol(sym, opts));
      const last = results[results.length - 1];
      if (rm != null) last.rm_confidence = rm;
      if (opts?.delayMs !== 0) {
        await new Promise((r) => setTimeout(r, opts?.delayMs ?? 450));
      }
    }
    const rr = opts?.rr ?? 2;
    const entryRule = opts?.entryRule || "orh";
    const report = {
      version: 1,
      template: entryRule === "vwap" ? "vwap_reclaim" : "h001_orh",
      entry_rule: entryRule,
      rr,
      strategy_id: opts?.strategyId || null,
      ran_at: new Date().toISOString(),
      session_id: opts?.sessionId || null,
      results,
      summary: summarize(results),
    };
    saveReport(report);
    return report;
  }

  function reportKey(sessionId, strategyId) {
    return STORAGE_PREFIX + (sessionId || "last") + (strategyId ? "__" + strategyId : "");
  }

  function saveReport(report) {
    try {
      // Per-strategy key so each strategy keeps its own last backtest...
      localStorage.setItem(reportKey(report.session_id, report.strategy_id), JSON.stringify(report));
      // ...and a session-default key for callers that don't know the strategy.
      localStorage.setItem(reportKey(report.session_id, null), JSON.stringify(report));
    } catch {
      /* ignore quota */
    }
  }

  function loadReport(sessionId, strategyId) {
    try {
      const scoped = strategyId
        ? localStorage.getItem(reportKey(sessionId, strategyId))
        : null;
      return JSON.parse(scoped || localStorage.getItem(reportKey(sessionId, null)) || "null");
    } catch {
      return null;
    }
  }

  function apiBase() {
    try {
      const meta =
        typeof document !== "undefined" &&
        document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      if (typeof localStorage !== "undefined") {
        const stored = localStorage.getItem("rainmaker_api_base");
        if (stored) return String(stored).replace(/\/$/, "");
      }
    } catch {
      /* ignore */
    }
    const h = (typeof location !== "undefined" && location.hostname) || "";
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (typeof global.RMAuthGate !== "undefined" && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch {
      /* ignore */
    }
    return headers;
  }

  function normalizeApiReport(json, opts) {
    const entryRule = json.entry_rule || opts?.entryRule || "orh";
    return {
      version: json.version || 2,
      mode: json.mode || "session",
      template: json.template || (entryRule === "vwap" ? "vwap_reclaim" : "h001_orh"),
      entry_rule: entryRule,
      rr: json.rr ?? opts?.rr ?? 2,
      strategy_id: json.strategy_id ?? opts?.strategyId ?? null,
      session_id: json.session_id ?? opts?.sessionId ?? null,
      range: json.range || opts?.range || "1mo",
      interval: json.interval || opts?.interval || "5m",
      source: json.source || "api",
      ran_at: json.ran_at || new Date().toISOString(),
      symbolCount: json.symbolCount ?? null,
      tradeCount: json.tradeCount ?? json.summary?.n ?? null,
      results: json.results || [],
      summary: json.summary || summarize(json.results || []),
    };
  }

  async function runSessionViaApi(picks, opts) {
    const base = apiBase();
    if (!base) throw new Error("no_api");
    const res = await fetch(base + "/backtest/session", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        picks,
        limit: opts?.limit ?? 8,
        strategyId: opts?.strategyId || null,
        entryRule: opts?.entryRule || "orh",
        rr: opts?.rr ?? 2,
        sessionId: opts?.sessionId || null,
        range: opts?.range || "1mo",
        interval: opts?.interval || "5m",
        source: opts?.source || "auto",
      }),
    });
    if (!res.ok) {
      const err = new Error("http_" + res.status);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const report = normalizeApiReport(json, opts);
    saveReport(report);
    return report;
  }

  /**
   * Prefer rm_api multi-day session backtest; fall back to browser today-only sim.
   * @returns {{ report: object, offline: boolean }}
   */
  async function runSessionPreferred(picks, opts) {
    try {
      const report = await runSessionViaApi(picks, opts);
      return { report, offline: false };
    } catch {
      const report = await runSession(picks, {
        ...opts,
        range: "1d",
        delayMs: opts?.delayMs ?? 450,
      });
      report.mode = "offline";
      report.range = "1d";
      saveReport(report);
      return { report, offline: true };
    }
  }

  global.RMBacktestH001 = {
    openingRangeFromBars,
    simulateOrh2R,
    simulateVwapReclaim,
    simulateForRule,
    vwapSeries,
    runForSymbol,
    runSession,
    runSessionViaApi,
    runSessionPreferred,
    loadReport,
    saveReport,
    summarize,
    apiBase,
  };
})(typeof window !== "undefined" ? window : global);

;
/* --- research_report_pdf.js --- */
/**
 * Branded research report PDF export (Rainmaker DS tokens).
 * Uses jsPDF text layout (reliable on mobile; no html2canvas blank-page bug).
 */
(function (global) {
  "use strict";

  const ACCENT = [78, 184, 201];
  const BULL = [45, 184, 168];
  const INK = [12, 18, 24];
  const MUTED = [100, 116, 141];
  const CARD = [22, 31, 42];

  const JSPDF_SRC =
    "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-rm-pdf-lib="' + src + '"]')) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.dataset.rmPdfLib = src;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("Failed to load " + src));
      };
      document.head.appendChild(s);
    });
  }

  async function ensurePdfLibs() {
    await loadScriptOnce(JSPDF_SRC);
    if (!global.jspdf) {
      throw new Error("PDF library unavailable");
    }
  }

  function fmtTime(ts) {
    if (!ts) return "-";
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch (e) {
      return "-";
    }
  }

  function reportFilename(idea) {
    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    return "rainmaker-research-" + sid + ".pdf";
  }

  function stripMarkdown(line) {
    return String(line || "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#+\s+/, "")
      .replace(/^\s*-\s+/, "")
      .trim();
  }

  function parseMarkdownSections(md) {
    const sections = [];
    const lines = String(md || "").split("\n");
    let current = { title: "", lines: [] };

    function flush() {
      if (!current.title && !current.lines.length) return;
      sections.push({
        title: current.title,
        body: current.lines.join("\n").trim(),
      });
      current = { title: "", lines: [] };
    }

    lines.forEach(function (line) {
      const h2 = line.match(/^##\s+(.+)/);
      const h1 = line.match(/^#\s+(.+)/);
      if (h2) {
        flush();
        current.title = h2[1].trim();
        return;
      }
      if (h1 && h1[1].toLowerCase() !== "research report") {
        flush();
        current.title = h1[1].trim();
        return;
      }
      if (/^\*\*Prompt:\*\*/i.test(line)) return;
      current.lines.push(line);
    });
    flush();
    return sections.filter(function (s) {
      return s.title || s.body;
    });
  }

  function bodyLines(body) {
    return String(body || "")
      .split("\n")
      .map(stripMarkdown)
      .filter(Boolean)
      .map(function (line) {
        return line.startsWith("-") || line.startsWith(" - ") ? " -  " + line.replace(/^[- - ]\s*/, "") : line;
      });
  }

  async function download(idea, report, detail) {
    const raw = (report && report.body) || "";
    if (!raw || !idea) {
      throw new Error("No report to export");
    }
    await ensurePdfLibs();

    const jsPDF = global.jspdf.jsPDF;
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const marginX = 48;
    const marginBottom = 52;
    const maxW = pageW - marginX * 2;
    let y = 0;

    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    const prompt = idea.prompt || "Research report";
    const summary = idea.summary || "";
    const status = (idea.status || "done").toUpperCase();
    const updated = fmtTime(idea.updated_at || idea.created_at);

    function drawTopBand() {
      doc.setFillColor.apply(doc, ACCENT);
      doc.rect(0, 0, pageW, 5, "F");
      doc.setFillColor.apply(doc, BULL);
      doc.rect(0, 5, pageW, 3, "F");
    }

    function newPage() {
      doc.addPage();
      drawTopBand();
      y = 44;
    }

    function ensureSpace(need) {
      if (y + need > pageH - marginBottom) {
        newPage();
      }
    }

    function writeLines(lines, opts) {
      const fontSize = (opts && opts.size) || 10;
      const lineH = fontSize * 1.45;
      const style = (opts && opts.style) || "normal";
      const color = (opts && opts.color) || INK;
      doc.setFont("helvetica", style);
      doc.setFontSize(fontSize);
      doc.setTextColor.apply(doc, color);
      lines.forEach(function (line) {
        const wrapped = doc.splitTextToSize(line, maxW);
        ensureSpace(wrapped.length * lineH + 4);
        doc.text(wrapped, marginX, y);
        y += wrapped.length * lineH + ((opts && opts.gap) || 4);
      });
    }

    function writeSectionTitle(title) {
      ensureSpace(28);
      doc.setDrawColor.apply(doc, ACCENT);
      doc.setLineWidth(0.75);
      doc.line(marginX, y, pageW - marginX, y);
      y += 14;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, ACCENT);
      doc.text(String(title).toUpperCase(), marginX, y);
      y += 16;
    }

    drawTopBand();
    y = 28;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, ACCENT);
    doc.text("RAINMAKER", marginX, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Morning - Research concierge", marginX, y + 12);
    doc.text("#" + sid, pageW - marginX, y, { align: "right" });
    doc.text(updated, pageW - marginX, y + 12, { align: "right" });
    y += 36;

    doc.setFillColor.apply(doc, CARD);
    doc.setDrawColor(58, 74, 94);
    doc.setLineWidth(0.5);
    const cardTop = y;
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("RESEARCH QUESTION", marginX + 12, y);
    y += 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(232, 237, 244);
    const promptLines = doc.splitTextToSize(prompt, maxW - 24);
    ensureSpace(promptLines.length * 18 + 40);
    doc.text(promptLines, marginX + 12, y);
    y += promptLines.length * 18 + 8;

    if (summary) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(126, 200, 212);
      const sumLines = doc.splitTextToSize(summary, maxW - 24);
      doc.text(sumLines, marginX + 12, y);
      y += sumLines.length * 14 + 6;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, BULL);
    doc.text(status, marginX + 12, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Probabilistic - no performance guarantees", marginX + 52, y);
    y += 16;
    doc.roundedRect(marginX, cardTop, maxW, y - cardTop, 4, 4, "FD");
    y += 20;

    const sections = parseMarkdownSections(raw);
    if (!sections.length) {
      writeSectionTitle("Report");
      writeLines(bodyLines(raw), { size: 10 });
    } else {
      sections.forEach(function (sec) {
        if (sec.title) {
          writeSectionTitle(sec.title);
        }
        writeLines(bodyLines(sec.body), { size: 10, gap: 6 });
        y += 8;
      });
    }

    const artifacts = (detail && detail.artifacts) || [];
    const sources = artifacts.filter(function (a) {
      return a.kind === "snippet" || a.kind === "raw_doc" || a.kind === "attachment";
    });
    if (sources.length) {
      writeSectionTitle("Sources");
      sources.slice(0, 12).forEach(function (a) {
        const src = ((a.meta && a.meta.source) || "source").toString();
        writeLines([stripMarkdown(a.title || "source") + " (" + src + ")"], {
          size: 9,
          color: MUTED,
          gap: 2,
        });
      });
    }

    ensureSpace(24);
    doc.setDrawColor(58, 74, 94);
    doc.line(marginX, y, pageW - marginX, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Rainmaker Morning - thepokerninja.github.io/rainmaker-morning", marginX, y);

    doc.save(reportFilename(idea));
  }

  global.RMResearchPdf = { download, reportFilename };
})(
  typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this
);

;
/* --- research_panel.js --- */
/**
 * Server-side research: inbox queue + walk-forward backtest + live expectancy.
 */
(function (global) {
  "use strict";

  const CACHE_KEY = "rainmaker_research_wf_v1";
  const INBOX_CACHE_KEY = "rainmaker_research_inbox_v1";
  const BASE_SYMBOLS = ["SPY", "QQQ"];
  const PROD_API = "https://rainmaker-api-waqs.onrender.com";
  let selectedIdeaId = null;
  let inboxIdeas = [];
  let queueBusy = false;
  let queueFlash = "";
  let queueFlashKind = "";
  let drawerDetail = null;
  let drawerWired = false;
  let researchDeepLinkOpened = false;
  let inboxPollTimer = null;
  let lastInboxSyncAt = 0;

  function isLocalHost() {
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1";
  }

  function isLocalApiUrl(url) {
    return /127\.0\.0\.1:8765|localhost:8765/i.test(url || "");
  }

  function apiBase() {
    // Research inbox is open on local rm_api; avoid stale prod overrides on :8787.
    if (isLocalHost()) return "http://127.0.0.1:8765";
    try {
      if (global.RMMorningApi && typeof global.RMMorningApi.resolveApiBase === "function") {
        const shared = global.RMMorningApi.resolveApiBase();
        if (shared) return String(shared).replace(/\/$/, "");
      }
    } catch (e) {}
    try {
      if (global.RMAuthGate && typeof global.RMAuthGate.getApiBase === "function") {
        const gate = global.RMAuthGate.getApiBase();
        if (gate) return String(gate).replace(/\/$/, "");
      }
    } catch (e) {}
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) {
        const normalized = stored.replace(/\/$/, "");
        if (!isLocalApiUrl(normalized)) return normalized;
      }
    } catch (e) {}
    return PROD_API;
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (e) {}
    return headers;
  }

  function authHeadersMultipart() {
    const headers = {};
    try {
      if (global.RMAuthGate && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (e) {}
    return headers;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch (e) {
      return "—";
    }
  }

  function statusClass(st) {
    if (st === "done") return "is-good";
    if (st === "failed") return "is-weak";
    if (st === "running") return "is-running";
    return "";
  }

  function parseResearchDeepLink() {
    try {
      const p = new URLSearchParams(global.location.search);
      const id = p.get("research");
      if (id) selectedIdeaId = id;
    } catch (e) {}
  }

  function needsLogin() {
    try {
      const base = apiBase();
      const prodApi = base && !isLocalApiUrl(base);
      if (prodApi) {
        return !global.RMAuthGate?.getToken?.() || !global.RMAuthGate.getToken();
      }
      if (!global.RMAuthGate?.authRequired?.()) return false;
      return !global.RMAuthGate.getToken?.() || !global.RMAuthGate.getToken();
    } catch (e) {
      return false;
    }
  }

  function queueErrorMessage(err, resStatus) {
    const msg = String((err && err.message) || err || "");
    if (
      msg === "Failed to fetch" ||
      msg.includes("NetworkError") ||
      msg === "The user aborted a request."
    ) {
      if (!isLocalHost()) {
        return "Rainmaker API offline — Render may be waking up. Wait 30s and try again.";
      }
      return "API unreachable — start rm_api locally (port 8765).";
    }
    if (msg === "Invalid admin token" || msg.includes("Invalid admin token")) {
      if (needsLogin()) {
        return "Not signed in — refresh the page to sign in, then try Process next again.";
      }
      return "Process next needs the latest API on Render — redeploy rm_api, then hard-refresh.";
    }
    if (resStatus === 401) {
      const base = apiBase();
      if (isLocalApiUrl(base)) {
        return "Local rm_api rejected the request — restart rm_api without RM_CRON_TOKEN set.";
      }
      if (global.RMAuthGate?.getToken?.()) {
        return "Session expired — open Account, sign out, and sign in again.";
      }
      return "Not signed in — refresh the page to sign in, then try again.";
    }
    if (resStatus === 404) {
      const base = apiBase();
      if (base && (base.includes("127.0.0.1") || base.includes("localhost"))) {
        return "Research API not on local rm_api — restart it from tools/rm_api (port 8765).";
      }
      return "Research API not on Render yet — push latest rm_api and redeploy.";
    }
    if (resStatus === 405) {
      return "Delete not on API yet — wait for deploy, then hard-refresh.";
    }
    if (msg === "no_api") {
      return "No API URL — set rainmaker-api-base or use the published app.";
    }
    return msg;
  }

  async function fetchInbox(force) {
    const base = apiBase();
    if (!base) {
      return { ideas: [], error: "no_api" };
    }
    if (!force) {
      try {
        const cached = JSON.parse(global.sessionStorage.getItem(INBOX_CACHE_KEY) || "null");
        if (cached && cached.at && Date.now() - cached.at < 60000) {
          inboxIdeas = cached.ideas || [];
          return { ideas: inboxIdeas, error: null };
        }
      } catch (e) {}
    }
    const res = await apiFetch("/research/ideas?limit=30", { headers: authHeaders() });
    if (!res.ok) {
      return { ideas: [], error: queueErrorMessage(null, res.status) };
    }
    const data = await res.json();
    inboxIdeas = data.ideas || [];
    try {
      const capRes = await apiFetch("/capture/today?limit=20", { headers: authHeaders() });
      if (capRes.ok) {
        const capData = await capRes.json();
        const extras = (capData.captures || []).map(function (c) {
          return {
            id: c.id,
            prompt: "[" + (c.kind || "note") + "] " + (c.body || ""),
            status: c.status || "open",
            source: "capture",
          };
        });
        inboxIdeas = extras.concat(inboxIdeas);
      }
    } catch (e) {}
    try {
      global.sessionStorage.setItem(
        INBOX_CACHE_KEY,
        JSON.stringify({ at: Date.now(), ideas: inboxIdeas })
      );
    } catch (e) {}
    return { ideas: inboxIdeas, error: null };
  }

  async function fetchIdeaDetail(id) {
    const base = apiBase();
    if (!base || !id) return null;
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(id), {
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  }

  async function apiFetch(path, opts) {
    const base = apiBase();
    if (!base) throw new Error("no_api");
    const timeoutMs = isLocalHost() ? 15000 : 45000;
    const ctrl = new AbortController();
    const timer = setTimeout(function () {
      ctrl.abort();
    }, timeoutMs);
    try {
      return await fetch(base + path, { ...(opts || {}), signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function queueIdea(payload) {
    const res = await apiFetch("/research/ideas", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () {
        return {};
      });
      const e = new Error(err.detail || "queue_failed");
      e.status = res.status;
      throw e;
    }
    const data = await res.json();
    await fetchInbox(true);
    return data;
  }

  async function attachToIdea(id, payload) {
    const base = apiBase();
    if (!base) return null;
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(id) + "/attachments", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload || {}),
    });
    return res.ok ? await res.json() : null;
  }

  async function uploadToIdea(id, file, title) {
    const base = apiBase();
    if (!base || !file) return null;
    const fd = new FormData();
    fd.append("file", file);
    if (title) fd.append("title", title);
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(id) + "/upload", {
      method: "POST",
      headers: authHeadersMultipart(),
      body: fd,
    });
    return res.ok ? await res.json() : null;
  }

  async function processNextInbox() {
    const base = apiBase();
    if (!base) throw new Error("API offline");
    const res = await fetch(base + "/research/process", {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
    });
    if (!res.ok) {
      const err = await res.json().catch(function () {
        return {};
      });
      const e = new Error(err.detail || "Process failed (" + res.status + ")");
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  function inboxQueueBarHtml(ideas) {
    const queued = (ideas || []).filter(function (i) {
      return i.status === "queued";
    }).length;
    const running = (ideas || []).some(function (i) {
      return i.status === "running";
    });
    if (!queued && !running) return "";
    const label = running
      ? "Research running on server…"
      : queued + " queued · auto-runs every ~15m";
    return (
      '<div class="rm-research-queue-bar">' +
      '<span class="rm-research-queue-bar-copy">' +
      escapeHtml(label) +
      "</span>" +
      (queued
        ? '<button type="button" class="btn-sm primary" id="btnInboxProcess">Process now</button>'
        : '<span class="rm-research-queue-bar-pulse" aria-hidden="true"></span>') +
      "</div>"
    );
  }

  function inboxSyncLabelHtml() {
    if (!lastInboxSyncAt) {
      return '<span class="rm-research-sync-label">Syncing…</span>';
    }
    const sec = Math.max(0, Math.floor((Date.now() - lastInboxSyncAt) / 1000));
    const text =
      sec < 8 ? "Live" : sec < 60 ? sec + "s ago" : Math.floor(sec / 60) + "m ago";
    return '<span class="rm-research-sync-label">' + escapeHtml(text) + "</span>";
  }

  function syncInboxPoll(ideas) {
    const needs = (ideas || []).some(function (i) {
      return i.status === "queued" || i.status === "running";
    });
    if (needs && !inboxPollTimer) {
      inboxPollTimer = global.setInterval(function () {
        void refreshInbox(true);
      }, 60000);
    } else if (!needs && inboxPollTimer) {
      global.clearInterval(inboxPollTimer);
      inboxPollTimer = null;
    }
  }

  const TRASH_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
    "</svg>";

  function canDeleteIdea(idea) {
    return idea && (idea.status === "done" || idea.status === "failed");
  }

  function deleteButtonHtml(ideaId) {
    return (
      '<button type="button" class="btn-icon rm-research-delete" data-idea-id="' +
      escapeHtml(ideaId) +
      '" title="Delete report" aria-label="Delete report">' +
      TRASH_ICON_SVG +
      "</button>"
    );
  }

  async function deleteIdea(ideaId) {
    const res = await apiFetch("/research/ideas/" + encodeURIComponent(ideaId), {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(function () {
        return {};
      });
      const e = new Error(err.detail || "Delete failed (" + res.status + ")");
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  async function submitFeedback(ideaId, feedback) {
    const base = apiBase();
    if (!base) throw new Error("API offline");
    const res = await fetch(base + "/research/ideas/" + encodeURIComponent(ideaId) + "/feedback", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ feedback: feedback }),
    });
    if (!res.ok) throw new Error("Feedback failed");
    return res.json();
  }

  function feedbackHtml(idea) {
    if (!idea || idea.status !== "done") return "";
    const fb = idea.feedback || "";
    return (
      '<div class="rm-research-feedback" role="group" aria-label="Rate this research">' +
      '<button type="button" class="btn-sm secondary rm-research-fb' +
      (fb === "up" ? " is-active" : "") +
      '" data-fb="up" title="Helpful">👍</button>' +
      '<button type="button" class="btn-sm secondary rm-research-fb' +
      (fb === "down" ? " is-active" : "") +
      '" data-fb="down" title="Not helpful">👎</button>' +
      "</div>"
    );
  }

  function reportsEmptyHtml() {
    return (
      '<div class="rm-research-empty">' +
      '<div class="rm-research-empty-graphic" aria-hidden="true">' +
      '<svg viewBox="0 0 120 72" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M8 56h104" stroke="currentColor" stroke-opacity="0.2"/>' +
      '<path d="M16 48l18-14 16 10 22-26 30 30" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>' +
      '<circle cx="88" cy="18" r="4" fill="currentColor" opacity="0.35"/>' +
      "</svg></div>" +
      '<p class="rm-research-empty-title">No reports yet</p>' +
      '<p class="meta rm-research-empty-copy">Submit a question in the desk above — finished reports appear here.</p>' +
      "</div>"
    );
  }

  function reportsAccordionHtml(ideas) {
    if (!ideas.length) {
      return reportsEmptyHtml();
    }
    return (
      '<div class="rm-research-acc-list">' +
      ideas
        .map(function (idea) {
          const sid = idea.short_id || (idea.id || "").slice(0, 8);
          const canOpen = idea.status === "done" || idea.status === "failed";
          const openLabel = idea.status === "done" ? "Open report" : "View";
          const deleteBtn = canDeleteIdea(idea) ? deleteButtonHtml(idea.id) : "";
          return (
            '<article class="rm-research-acc" data-idea-id="' +
            escapeHtml(idea.id) +
            '">' +
            '<p class="rm-research-acc-prompt">' +
            escapeHtml(idea.prompt || "Research prompt") +
            "</p>" +
            '<p class="rm-research-acc-meta meta">' +
            '<span class="rm-research-inbox-status ' +
            statusClass(idea.status) +
            '">' +
            escapeHtml(idea.status || "queued") +
            "</span> #" +
            escapeHtml(sid) +
            " · " +
            fmtTime(idea.updated_at || idea.created_at) +
            "</p>" +
            (canOpen || deleteBtn
              ? '<div class="rm-research-acc-actions">' +
                (canOpen
                  ? '<button type="button" class="btn-sm secondary rm-research-open" data-idea-id="' +
                    escapeHtml(idea.id) +
                    '">' +
                    openLabel +
                    "</button>"
                  : "") +
                deleteBtn +
                "</div>"
              : "") +
            "</article>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  async function downloadResearchReport(idea, report, detail) {
    const body = (report && report.body) || "";
    if (!body) return;
    if (!global.RMResearchPdf || !global.RMResearchPdf.download) {
      throw new Error("PDF export unavailable");
    }
    await global.RMResearchPdf.download(idea, report, detail);
  }

  function emailResearchReport(idea, report) {
    const body = (report && report.body) || idea.summary || "";
    const prompt = idea.prompt || "Research report";
    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    let link = "";
    try {
      link =
        location.origin +
        location.pathname +
        "?research=" +
        encodeURIComponent(idea.id);
    } catch (e) {}
    const excerpt = body.slice(0, 1200);
    const mailBody =
      "Rainmaker research #" +
      sid +
      "\n\n" +
      prompt +
      "\n\n" +
      excerpt +
      (body.length > 1200
        ? "\n\n[Truncated in email — download PDF in app for full report]"
        : "") +
      (link ? "\n\nOpen in app: " + link : "");
    const subject = "Rainmaker research: " + prompt.slice(0, 60);
    location.href =
      "mailto:?subject=" +
      encodeURIComponent(subject) +
      "&body=" +
      encodeURIComponent(mailBody);
  }

  function ensureResearchDrawer() {
    if (document.getElementById("researchReportDrawer")) return;
    const backdrop = document.createElement("div");
    backdrop.id = "researchBackdrop";
    backdrop.className = "drawer-backdrop hidden";
    backdrop.setAttribute("aria-hidden", "true");
    const drawer = document.createElement("aside");
    drawer.id = "researchReportDrawer";
    drawer.className = "side-drawer is-closed";
    drawer.setAttribute("aria-hidden", "true");
    drawer.innerHTML =
      '<div class="side-drawer-inner research-drawer-inner">' +
      '<header class="side-drawer-header">' +
      "<div><h2 id=\"researchDrawerTitle\">Research</h2>" +
      '<p class="meta" id="researchDrawerSubtitle">Report</p></div>' +
      '<button type="button" id="btnCloseResearchDrawer" class="side-drawer-close" aria-label="Close">×</button>' +
      "</header>" +
      '<div class="research-drawer-scroll" id="researchDrawerBody"></div>' +
      '<footer class="research-drawer-footer" id="researchDrawerFooter" hidden>' +
      '<button type="button" class="btn-sm secondary" id="btnResearchDownload">Download PDF</button>' +
      '<button type="button" class="btn-sm secondary" id="btnResearchShare">Share</button>' +
      '<button type="button" class="btn-icon rm-research-delete-detail" id="btnResearchDelete" title="Delete report" aria-label="Delete report">' +
      TRASH_ICON_SVG +
      "</button></footer></div>";
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    backdrop.addEventListener("click", closeResearchDrawer);
    drawer.querySelector("#btnCloseResearchDrawer")?.addEventListener("click", closeResearchDrawer);
  }

  function wireResearchDrawer() {
    if (drawerWired) return;
    drawerWired = true;
    ensureResearchDrawer();
    document.getElementById("btnResearchDownload")?.addEventListener("click", function () {
      if (!drawerDetail || !drawerDetail.report || !drawerDetail.report.body) return;
      const btn = document.getElementById("btnResearchDownload");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Preparing PDF…";
      }
      downloadResearchReport(drawerDetail.idea, drawerDetail.report, drawerDetail)
        .catch(function (e) {
          console.warn("research pdf", e);
          setQueueFlash("PDF export failed — check connection and try again.", "err");
        })
        .finally(function () {
          if (btn) {
            btn.disabled = false;
            btn.textContent = "Download PDF";
          }
        });
    });
    document.getElementById("btnResearchShare")?.addEventListener("click", function () {
      if (!drawerDetail) return;
      emailResearchReport(drawerDetail.idea, drawerDetail.report);
    });
    document.getElementById("btnResearchDelete")?.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (!drawerDetail || !drawerDetail.idea) return;
      void handleDeleteIdea(drawerDetail.idea.id);
    });
  }

  function closeResearchDrawer() {
    const backdrop = document.getElementById("researchBackdrop");
    const drawer = document.getElementById("researchReportDrawer");
    if (backdrop) {
      backdrop.classList.add("hidden");
      backdrop.setAttribute("aria-hidden", "true");
    }
    if (drawer) {
      drawer.classList.remove("open");
      drawer.classList.add("is-closed");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (
      !document.getElementById("orderDrawer")?.classList.contains("open") &&
      !document.getElementById("scanDrawer")?.classList.contains("open") &&
      !document.getElementById("tradeDebriefDrawer")?.classList.contains("open")
    ) {
      document.body.classList.remove("drawer-open");
    }
    drawerDetail = null;
  }

  function openResearchDrawer(detail) {
    if (!detail || !detail.idea) return;
    wireResearchDrawer();
    drawerDetail = detail;
    const idea = detail.idea;
    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    const titleEl = document.getElementById("researchDrawerTitle");
    const subEl = document.getElementById("researchDrawerSubtitle");
    const bodyEl = document.getElementById("researchDrawerBody");
    const footerEl = document.getElementById("researchDrawerFooter");
    if (titleEl) titleEl.textContent = (idea.prompt || "Research").slice(0, 120);
    if (subEl) {
      subEl.textContent =
        "#" + sid + " · " + (idea.status || "queued") + " · " + fmtTime(idea.updated_at || idea.created_at);
    }
    if (bodyEl) bodyEl.innerHTML = drawerBodyHtml(detail);
    if (footerEl) {
      const hasReport = !!(detail.report && detail.report.body);
      footerEl.hidden = !hasReport;
      const dl = document.getElementById("btnResearchDownload");
      const sh = document.getElementById("btnResearchShare");
      if (dl) dl.hidden = !hasReport;
      if (sh) sh.hidden = !hasReport;
    }
    const backdrop = document.getElementById("researchBackdrop");
    const drawer = document.getElementById("researchReportDrawer");
    if (backdrop) {
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
    }
    if (drawer) {
      drawer.classList.remove("is-closed");
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("drawer-open");
    bodyEl?.querySelectorAll(".rm-research-fb").forEach(function (btn) {
      btn.addEventListener("click", async function (ev) {
        ev.stopPropagation();
        const id = idea.id;
        const fb = btn.getAttribute("data-fb");
        if (!id || !fb) return;
        try {
          await submitFeedback(id, fb);
          const refreshed = await fetchIdeaDetail(id);
          openResearchDrawer(refreshed);
          await refreshInbox(true);
        } catch (e) {
          console.warn("research feedback", e);
        }
      });
    });
    bindAttachHandlers(drawer, idea.id);
  }

  async function handleDeleteIdea(ideaId) {
    if (!ideaId) return;
    try {
      await deleteIdea(ideaId);
      try {
        global.sessionStorage.removeItem(INBOX_CACHE_KEY);
      } catch (e) {}
      if (selectedIdeaId === ideaId) selectedIdeaId = null;
      closeResearchDrawer();
      setQueueFlash("Report deleted.", "ok");
      const panel = document.getElementById("ttResearchPanel");
      await refreshInbox(true);
    } catch (e) {
      setQueueFlash(queueErrorMessage(e, e.status), "err");
      const panel = document.getElementById("ttResearchPanel");
      renderInbox(panel, inboxIdeas, false, null);
    }
  }

  function drawerBodyHtml(detail) {
    if (!detail || !detail.idea) {
      return '<p class="meta">No report loaded.</p>';
    }
    const idea = detail.idea;
    const report = detail.report;
    const artifacts = detail.artifacts || [];
    let html = '<div class="rm-research-detail">';
    if (idea.summary) {
      html += "<p>" + escapeHtml(idea.summary) + "</p>";
    }
    html += feedbackHtml(idea);
    if (idea.error) {
      html += '<p class="is-weak">' + escapeHtml(idea.error) + "</p>";
    }
    if (report && report.body) {
      html += '<pre class="rm-research-report">' + escapeHtml(report.body) + "</pre>";
    }
    const snippets = artifacts.filter(function (a) {
      return a.kind === "snippet" || a.kind === "attachment" || a.kind === "raw_doc";
    });
    if (snippets.length) {
      html += "<h5>Sources</h5><ul class='rm-research-sources'>";
      snippets.slice(0, 8).forEach(function (a) {
        html +=
          "<li><strong>" +
          escapeHtml(a.title || "source") +
          "</strong> — " +
          escapeHtml((a.body || "").slice(0, 160)) +
          "</li>";
      });
      html += "</ul>";
    }
    if (idea.status === "queued" || idea.status === "failed") {
      html +=
        '<div class="rm-research-attach">' +
        '<textarea id="researchAttachText" rows="3" placeholder="Paste paywalled notes or URLs…"></textarea>' +
        '<input type="file" id="researchAttachFile" accept=".pdf,.txt,.md" />' +
        '<button type="button" class="btn-sm secondary" id="btnResearchAttach">Attach</button>' +
        "</div>";
    }
    html += "</div>";
    return html;
  }

  function queueStatusHtml() {
    if (!queueFlash) return '<p class="rm-research-queue-status meta" id="researchQueueStatus" hidden></p>';
    const cls =
      "rm-research-queue-status meta rm-research-queue-status--" + (queueFlashKind || "info");
    return '<p class="' + cls + '" id="researchQueueStatus" role="status">' + escapeHtml(queueFlash) + "</p>";
  }

  function inboxComposeHtml() {
    const btnLabel = queueBusy ? "Queuing…" : "Submit";
    const btnDisabled = queueBusy ? " disabled" : "";
    return (
      '<div class="rm-research-compose">' +
      queueStatusHtml() +
      '<label class="rm-research-field">' +
      '<span class="rm-research-field-label">Your question</span>' +
      '<textarea id="researchPrompt" rows="2" placeholder="e.g. Is ZS a good buy right now?"></textarea>' +
      "</label>" +
      '<div class="rm-research-compose-row">' +
      '<label class="rm-research-field rm-research-field--symbols">' +
      '<span class="rm-research-field-label">Tickers <span class="rm-research-optional">optional</span></span>' +
      '<input type="text" id="researchSymbols" placeholder="ZS, SPY" />' +
      "</label>" +
      '<button type="button" class="btn-sm primary rm-research-queue-btn" id="btnResearchQueue"' +
      btnDisabled +
      ">" +
      btnLabel +
      "</button>" +
      "</div></div>"
    );
  }

  function researchHeroHtml(ideas, errBlock) {
    const doneN = (ideas || []).filter(function (i) {
      return i.status === "done";
    }).length;
    return (
      '<section class="rm-research-hero">' +
      '<div class="rm-research-hero-bg" aria-hidden="true">' +
      '<div class="rm-research-hero-mesh"></div>' +
      '<div class="rm-research-hero-glow"></div>' +
      '<img class="rm-research-hero-mark" src="assets/rm-story-icon.svg" alt="" decoding="async" />' +
      "</div>" +
      '<div class="rm-research-hero-body">' +
      '<div class="rm-research-hero-top">' +
      "<div>" +
      '<p class="rm-research-kicker">Concierge research</p>' +
      '<h3 class="rm-research-hero-title">Research desk</h3>' +
      '<p class="rm-research-hero-sub">Ask once — we gather sources, synthesize a report, and open it in your drawer.</p>' +
      "</div>" +
      '<div class="rm-research-sync" id="researchSyncStatus" title="Auto-syncs when you open Strategy">' +
      '<span class="rm-research-sync-dot" aria-hidden="true"></span>' +
      inboxSyncLabelHtml() +
      (doneN ? '<span class="rm-research-sync-count">' + doneN + " ready</span>" : "") +
      "</div></div>" +
      errBlock +
      inboxComposeHtml() +
      inboxQueueBarHtml(ideas) +
      "</div></section>"
    );
  }

  function renderInbox(root, ideas, loading, inboxError) {
    if (!root) return;
    const inboxRoot = root.querySelector(".rm-research-inbox") || root;
    if (loading) {
      inboxRoot.innerHTML =
        '<div class="rm-research-inbox-inner rm-research-inbox-inner--loading">' +
        '<section class="rm-research-hero rm-research-hero--loading">' +
        '<div class="rm-research-hero-body">' +
        '<p class="rm-research-kicker">Concierge research</p>' +
        '<h3 class="rm-research-hero-title">Research desk</h3>' +
        '<span class="tt-learning-tag">loading</span></div></section></div>';
      return;
    }
    const errBlock = inboxError
      ? '<p class="rm-research-queue-status rm-research-queue-status--err">' +
        escapeHtml(inboxError) +
        "</p>"
      : "";
    const reportCount = (ideas || []).length;
    inboxRoot.innerHTML =
      '<div class="rm-research-inbox-inner">' +
      researchHeroHtml(ideas, errBlock) +
      '<section class="rm-research-reports-panel">' +
      '<header class="rm-research-reports-head">' +
      '<h4 class="rm-research-reports-title">Your reports</h4>' +
      '<span class="rm-research-reports-count meta">' +
      (reportCount ? reportCount + " total" : "Waiting for first submission") +
      "</span></header>" +
      reportsAccordionHtml(ideas) +
      "</section></div>";

    inboxRoot.querySelector("#btnInboxProcess")?.addEventListener("click", async function () {
      const btn = inboxRoot.querySelector("#btnInboxProcess");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Processing…";
      }
      setQueueFlash("Running research on server…", "info");
      try {
        const out = await processNextInbox();
        if (out.skipped) {
          setQueueFlash(
            out.reason === "job_already_running"
              ? "Another job is running — we'll sync when it finishes."
              : "Nothing queued to process.",
            "warn"
          );
        } else if (out.status === "done") {
          setQueueFlash("Report ready — open it from Your reports.", "ok");
          if (out.idea_id) selectedIdeaId = out.idea_id;
        } else if (out.status === "failed") {
          setQueueFlash("Research failed — tap View below.", "err");
          if (out.idea_id) selectedIdeaId = out.idea_id;
        } else {
          setQueueFlash("Processed — refresh list.", "ok");
        }
        await refreshInbox(true);
        if (selectedIdeaId) await showDetail(selectedIdeaId);
      } catch (e) {
        setQueueFlash(queueErrorMessage(e, e.status), "err");
        await refreshInbox(true);
      }
    });
    inboxRoot.querySelector("#btnResearchQueue")?.addEventListener("click", function () {
      void submitQueue();
    });
    inboxRoot.querySelectorAll(".rm-research-open").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        const id = btn.getAttribute("data-idea-id");
        selectedIdeaId = id;
        void showDetail(id);
      });
    });
    inboxRoot.querySelectorAll(".rm-research-delete").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = btn.getAttribute("data-idea-id");
        void handleDeleteIdea(id);
      });
    });
  }

  function bindAttachHandlers(root, ideaId) {
    const btn = root.querySelector("#btnResearchAttach");
    if (!btn || !ideaId) return;
    btn.addEventListener("click", async function () {
      const text = root.querySelector("#researchAttachText")?.value?.trim();
      const file = root.querySelector("#researchAttachFile")?.files?.[0];
      if (text) {
        await attachToIdea(ideaId, { text: text, title: "User paste" });
      }
      if (file) {
        await uploadToIdea(ideaId, file, file.name);
      }
      await showDetail(ideaId);
    });
  }

  function setQueueFlash(message, kind) {
    queueFlash = message || "";
    queueFlashKind = kind || "info";
  }

  async function submitQueue() {
    const panel = document.getElementById("ttResearchPanel");
    const inboxRoot = panel?.querySelector(".rm-research-inbox");
    const prompt = inboxRoot?.querySelector("#researchPrompt")?.value?.trim();
    if (!prompt) {
      setQueueFlash("Enter a research prompt first.", "warn");
      renderInbox(panel, inboxIdeas, false, null);
      return;
    }
    if (needsLogin()) {
      setQueueFlash("Not signed in — refresh the page to sign in first.", "err");
      renderInbox(panel, inboxIdeas, false, null);
      return;
    }
    const symRaw = inboxRoot?.querySelector("#researchSymbols")?.value || "";
    const symbols = symRaw
      .split(/[,\s]+/)
      .map(function (s) {
        return s.trim().toUpperCase();
      })
      .filter(Boolean);
    queueBusy = true;
    setQueueFlash("Queuing on server…", "info");
    renderInbox(panel, inboxIdeas, false, null);
    try {
      const data = await queueIdea({
        prompt: prompt,
        symbols: symbols,
        tags: ["inbox"],
        continuity: false,
        parent_id: selectedIdeaId || undefined,
      });
      selectedIdeaId = data.id;
      const ahead = data.queued_ahead != null ? Number(data.queued_ahead) : 0;
      const sid = data.short_id || (data.id || "").slice(0, 8);
      setQueueFlash(
        "Queued #" +
          sid +
          (ahead > 0 ? " — " + ahead + " ahead in line." : " — next up.") +
          " Cron runs every ~15 min.",
        "ok"
      );
      if (inboxRoot?.querySelector("#researchPrompt")) inboxRoot.querySelector("#researchPrompt").value = "";
      await refreshInbox(true);
      document
        .getElementById("ttResearchPanel")
        ?.querySelector('.rm-research-acc[data-idea-id="' + selectedIdeaId + '"]')
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      setQueueFlash(queueErrorMessage(e, e.status), "err");
      console.warn("research queue", e);
    } finally {
      queueBusy = false;
      renderInbox(panel, inboxIdeas, false, null);
    }
  }

  async function showDetail(id) {
    if (!id) return;
    selectedIdeaId = id;
    const detail = await fetchIdeaDetail(id);
    openResearchDrawer(detail);
  }

  async function refreshInbox(force) {
    const panel = document.getElementById("ttResearchPanel");
    if (!panel) return;
    renderInbox(panel, [], true, null);
    const result = await fetchInbox(force);
    const ideas = result.ideas || [];
    inboxIdeas = ideas;
    lastInboxSyncAt = Date.now();
    syncInboxPoll(ideas);
    renderInbox(
      panel,
      ideas,
      false,
      result.error ? queueErrorMessage({ message: result.error }, null) : null
    );
    if (selectedIdeaId && /[?&]research=/.test(location.search) && !researchDeepLinkOpened) {
      researchDeepLinkOpened = true;
      await showDetail(selectedIdeaId);
    }
    const wfSlot = panel.querySelector(".rm-research-wf-slot");
    if (wfSlot && panel._wfData) {
      renderWalkForward(wfSlot, panel._wfData, false, panel._wfEntryRule);
    }
  }

  async function queueFromChartScan(scan, analysis) {
    const sym = scan?.symbol || "SPY";
    const prompt =
      "Explain price action in " +
      sym +
      " from chart scan region (" +
      new Date(scan.tMin).toLocaleTimeString() +
      "–" +
      new Date(scan.tMax).toLocaleTimeString() +
      ")";
    return queueIdea({
      prompt: prompt,
      symbols: [sym],
      tags: ["chart_scan"],
      context: {
        tMin: scan.tMin,
        tMax: scan.tMax,
        confidence: scan.confidence || analysis?.confidenceLevel,
        technicals: analysis?.technicals,
        catalyst: analysis?.catalyst,
      },
    });
  }

  function activeEntryRule() {
    try {
      if (global.RMStrategies && global.RMStrategies.getActive) {
        return global.RMStrategies.getActive().entryRule || "orh";
      }
    } catch (e) {}
    return "orh";
  }

  function entryRuleLabel(rule) {
    if (rule === "vwap") return "VWAP reclaim";
    return "ORH";
  }

  function walkForwardSymbols() {
    const syms = BASE_SYMBOLS.slice();
    try {
      const picks =
        typeof global.getMorningSession === "function"
          ? global.getMorningSession()?.picks
          : null;
      const first = picks?.[0]?.symbol;
      if (first) {
        const key = String(first).toUpperCase();
        if (!syms.includes(key)) syms.push(key);
      }
    } catch (e) {}
    return syms;
  }

  function fmtR(v) {
    if (v == null || Number.isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "R";
  }

  function loadCache() {
    try {
      return JSON.parse(global.sessionStorage.getItem(CACHE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }

  function saveCache(data) {
    try {
      global.sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  async function walkForward(symbol, entryRule) {
    const base = apiBase();
    if (!base) return { symbol, error: "no_api" };
    const res = await fetch(base + "/backtest/walk-forward", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        symbol,
        entryRule: entryRule || "orh",
        range: "1mo",
        interval: "5m",
        source: "auto",
      }),
    });
    if (!res.ok) {
      return { symbol, error: "http_" + res.status };
    }
    return await res.json();
  }

  async function fetchExpectancy() {
    const base = apiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/trade/expectancy", { headers: authHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function cardHtml(wf, entryRule) {
    if (wf.error) {
      return (
        '<article class="rm-research-card rm-research-card--err">' +
        "<h4>" +
        wf.symbol +
        '</h4><p class="meta">' +
        wf.error +
        "</p></article>"
      );
    }
    const is = wf.inSample || {};
    const oos = wf.outSample || {};
    const gap = wf.overfitGap;
    const gapWarn = gap != null && gap > 0.5;
    const oosN = oos.n || 0;
    const beats = oos.avgR != null && oos.avgR > 0;
    const ruleLabel = entryRuleLabel(entryRule || wf.entryRule);
    return (
      '<article class="rm-research-card' +
      (gapWarn ? " rm-research-card--warn" : "") +
      '">' +
      "<header><h4>" +
      wf.symbol +
      '</h4><span class="rm-research-rr">' +
      ruleLabel +
      " · best R:R " +
      (wf.bestRr != null ? wf.bestRr : "—") +
      ":1</span></header>" +
      '<div class="rm-research-grid">' +
      '<div><span class="rm-research-k">In-sample</span><strong>' +
      fmtR(is.avgR) +
      "</strong><span class=\"meta\">" +
      (is.n || 0) +
      " days · " +
      (is.winRate != null ? is.winRate + "% win" : "") +
      "</span></div>" +
      '<div><span class="rm-research-k">Out-of-sample</span><strong class="' +
      (beats ? "is-good" : "is-weak") +
      '">' +
      fmtR(oos.avgR) +
      "</strong><span class=\"meta\">" +
      oosN +
      " days · " +
      (oos.winRate != null ? oos.winRate + "% win" : "") +
      "</span></div>" +
      '<div><span class="rm-research-k">Overfit gap</span><strong>' +
      (gap != null ? gap.toFixed(2) + "R" : "—") +
      "</strong>" +
      (gapWarn ? '<span class="rm-research-flag">high · treat in-sample with caution</span>' : "") +
      "</div></div>" +
      '<p class="meta rm-research-src">Bars: ' +
      (typeof RMSchwabData !== "undefined"
        ? RMSchwabData.formatBarsSource(wf.source || "yahoo")
        : wf.source || "yahoo") +
      " · " +
      (wf.inSampleDays || 0) +
      "+" +
      (wf.outSampleDays || 0) +
      " trading days</p></article>"
    );
  }

  function renderWalkForward(root, data, loading, entryRule) {
    if (!root) return;
    const rule = entryRule || data?.entryRule || activeEntryRule();
    if (!apiBase()) {
      root.innerHTML =
        '<div class="tt-learning-head"><h3>Walk-forward</h3></div>' +
        '<p class="meta">Set <code>rainmaker-api-base</code> to load walk-forward backtests.</p>';
      return;
    }
    if (loading) {
      root.innerHTML =
        '<div class="tt-learning-head"><h3>Walk-forward</h3><span class="tt-learning-tag">loading</span></div>' +
        '<p class="meta">SPY, QQQ' +
        (walkForwardSymbols().length > 2 ? ", + session pick" : "") +
        " (1mo, 5m, " +
        entryRuleLabel(rule) +
        ")…</p>";
      return;
    }
    const cards = (data.walkForward || []).map(function (wf) {
      return cardHtml(wf, rule);
    }).join("");
    const exp = data.expectancy;
    let liveBlock = "";
    if (exp && exp.ok) {
      const e = exp.expectancy || {};
      liveBlock =
        '<div class="rm-research-live">' +
        "<h4>Your realized trades (server store)</h4>" +
        "<p><strong>$" +
        (exp.realizedPnl != null ? Number(exp.realizedPnl).toFixed(0) : "—") +
        "</strong> realized · " +
        (exp.roundTrips || 0) +
        " round trips · win " +
        (e.winRate != null ? e.winRate + "% win" : "—") +
        " · avg R " +
        fmtR(e.avgR) +
        "</p>" +
        '<p class="meta">' +
        (exp.note || "") +
        " Sync Schwab fills in Account → Schwab.</p></div>";
    }
    const updated =
      data && data.at
        ? Math.max(0, Math.floor((Date.now() - data.at) / 60000))
        : null;
    const freshMeta =
      updated == null
        ? "Auto-updates when you open Strategy"
        : updated < 1
          ? "Updated just now"
          : "Updated " + updated + "m ago";
    root.innerHTML =
      '<section class="rm-research-wf">' +
      '<header class="rm-research-wf-head">' +
      "<div>" +
      '<p class="rm-research-kicker">Validation</p>' +
      "<h3>Walk-forward</h3>" +
      '<p class="meta">In/out sample on SPY/QQQ · ' +
      entryRuleLabel(rule) +
      ".</p></div>" +
      '<span class="rm-research-wf-meta meta">' +
      escapeHtml(freshMeta) +
      "</span></header>" +
      '<div class="rm-research-cards">' +
      cards +
      "</div>" +
      liveBlock +
      "</section>";
  }

  function ensurePanelStructure(panel) {
    if (!panel) return;
    panel.classList.add("rm-research-shell");
    if (!panel.querySelector(".rm-research-inbox")) {
      panel.innerHTML =
        '<div class="rm-research-inbox"></div><div class="rm-research-wf-slot"></div>';
    }
  }

  function renderPanel(root, data, loading, entryRule) {
    if (!root) return;
    const isMainInbox = root.id === "ttResearchPanel";
    if (isMainInbox) {
      ensurePanelStructure(root);
      const inboxEl = root.querySelector(".rm-research-inbox");
      const wfEl = root.querySelector(".rm-research-wf-slot");
      root._wfData = data;
      root._wfEntryRule = entryRule;
      if (inboxEl && !inboxEl.dataset.mounted) {
        inboxEl.dataset.mounted = "1";
        void refreshInbox(false);
      }
      renderWalkForward(wfEl, data, loading, entryRule);
      return;
    }
    root._wfData = data;
    root._wfEntryRule = entryRule;
    renderWalkForward(root, data, loading, entryRule);
  }

  async function run(force) {
    const panel = document.getElementById("ttResearchPanel");
    const stratSlot = document.getElementById("ttResearchStrategySlot");
    const entryRule = activeEntryRule();
    ensurePanelStructure(panel);
    if (!force) {
      const cached = loadCache();
      if (cached && cached.at && Date.now() - cached.at < 3600000 && cached.entryRule === entryRule) {
        renderPanel(panel, cached, false, entryRule);
        if (stratSlot) renderPanel(stratSlot, cached, false, entryRule);
        return;
      }
    }
    renderPanel(panel, null, true, entryRule);
    if (stratSlot) renderPanel(stratSlot, null, true, entryRule);
    const walkForwardResults = [];
    for (const sym of walkForwardSymbols()) {
      try {
        walkForwardResults.push(await walkForward(sym, entryRule));
      } catch (e) {
        walkForwardResults.push({ symbol: sym, error: String(e.message || e) });
      }
    }
    const expectancy = await fetchExpectancy();
    const payload = {
      at: Date.now(),
      entryRule,
      walkForward: walkForwardResults,
      expectancy,
    };
    saveCache(payload);
    renderPanel(panel, payload, false, entryRule);
    if (stratSlot) renderPanel(stratSlot, payload, false, entryRule);
  }

  function mountStrategySlot() {
    const board = document.getElementById("pickListStrategy");
    if (!board || document.getElementById("ttResearchStrategySlot")) return;
    const slot = document.createElement("section");
    slot.id = "ttResearchStrategySlot";
    slot.className = "tt-learning-panel rm-research-strategy-slot";
    board.appendChild(slot);
  }

  function init() {
    parseResearchDeepLink();
    const panel = document.getElementById("ttResearchPanel");
    if (panel) run(false);
    document.addEventListener("rm:auth-ready", function () {
      void refreshInbox(true);
    });
    document.addEventListener("rm:research-digest", function () {
      void refreshInbox(true);
    });
    document.addEventListener("rm:strategy-tab-shown", function () {
      ensurePanelStructure(panel);
      void refreshInbox(true);
      run(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.RMResearch = {
    run,
    walkForward,
    fetchExpectancy,
    renderPanel,
    activeEntryRule,
    walkForwardSymbols,
    queueIdea,
    queueFromChartScan,
    refreshInbox,
    fetchInbox,
  };
})(typeof window !== "undefined" ? window : this);

;
/* --- scanner_calibration.js --- */
/** RM decile vs 1R hit rate — backtest + live (Tier 1 calibration). */
(function (global) {
  const DECILE_COUNT = 10;
  const MIN_N = 30;

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function decileForScore(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return null;
    const clamped = Math.max(0, Math.min(100, s));
    if (clamped >= 100) return 9;
    return Math.min(9, Math.floor(clamped / 10));
  }

  function decileLabel(d) {
    if (d === 9) return "90–100";
    return d * 10 + "–" + (d * 10 + 9);
  }

  function hit1R(r) {
    return r != null && Number.isFinite(r) && r >= 1;
  }

  function aggregateDeciles(items) {
    const buckets = Array.from({ length: DECILE_COUNT }, (_, d) => ({
      decile: d,
      label: decileLabel(d),
      n: 0,
      hit1R: 0,
      sumR: 0,
      rCount: 0,
    }));
    for (const it of items) {
      if (it.r_multiple == null) continue;
      const d = decileForScore(it.rm);
      if (d == null) continue;
      const b = buckets[d];
      b.n++;
      if (hit1R(it.r_multiple)) b.hit1R++;
      b.sumR += it.r_multiple;
      b.rCount++;
    }
    return buckets
      .filter((b) => b.n > 0)
      .map((b) => ({
        decile: b.decile,
        label: b.label,
        n: b.n,
        hit1R: b.hit1R,
        hit1RPct: Math.round((b.hit1R / b.n) * 100),
        avgR: b.rCount ? round2(b.sumR / b.rCount) : null,
      }));
  }

  function thresholdStats(items, minRm, label) {
    const subset = items.filter(
      (it) => it.r_multiple != null && (Number(it.rm) || 0) >= minRm
    );
    if (!subset.length) {
      return { label, minRm, n: 0, hit1R: 0, hit1RPct: null, avgR: null };
    }
    const hit = subset.filter((it) => hit1R(it.r_multiple)).length;
    const sumR = subset.reduce((s, it) => s + it.r_multiple, 0);
    return {
      label,
      minRm,
      n: subset.length,
      hit1R: hit,
      hit1RPct: Math.round((hit / subset.length) * 100),
      avgR: round2(sumR / subset.length),
    };
  }

  function buildReport(source, items) {
    const withR = items.filter((it) => it.r_multiple != null);
    const sumR = withR.reduce((s, it) => s + it.r_multiple, 0);
    return {
      source,
      totalN: withR.length,
      avgR: withR.length ? round2(sumR / withR.length) : null,
      hit1RPct: withR.length
        ? Math.round((withR.filter((it) => hit1R(it.r_multiple)).length / withR.length) * 100)
        : null,
      bands: aggregateDeciles(items),
      rm50: thresholdStats(items, 50, "RM ? 50"),
      rm70: thresholdStats(items, 70, "RM ? 70"),
      insufficient: withR.length < MIN_N,
    };
  }

  function itemsFromBacktest(picks, backtestReport) {
    const pickBySym = {};
    for (const p of picks || []) {
      if (p?.symbol) pickBySym[p.symbol] = p;
    }
    const items = [];
    for (const r of backtestReport?.results || []) {
      const p = pickBySym[r.symbol];
      const rm =
        r.rm_confidence ??
        p?.rm_confidence_adjusted ??
        p?.rm_confidence;
      if (r.r_multiple == null) continue;
      items.push({ symbol: r.symbol, rm, r_multiple: r.r_multiple });
    }
    return items;
  }

  function itemsFromLiveTrades(trades) {
    const items = [];
    for (const t of trades || []) {
      if (t.status !== "closed" || t.filled === false) continue;
      if (
        typeof RMTradeMetrics !== "undefined" &&
        !RMTradeMetrics.isPlannedTrade(t)
      ) {
        continue;
      }
      const rm = t.rm_confidence_adjusted ?? t.rm_confidence;
      const r =
        typeof RMTradeMetrics !== "undefined"
          ? RMTradeMetrics.rMultiple(t)
          : t.r_multiple;
      if (r == null) continue;
      items.push({ symbol: t.symbol, rm, r_multiple: r });
    }
    return items;
  }

  function calibrateBacktest(picks, backtestReport) {
    return buildReport("backtest", itemsFromBacktest(picks, backtestReport));
  }

  function calibrateLive(trades) {
    return buildReport("live", itemsFromLiveTrades(trades));
  }

  function fmtThresholdRow(t) {
    if (!t?.n) return t.label + " — no data";
    return (
      t.label +
      " — " +
      t.hit1RPct +
      "% hit 1R (" +
      t.hit1R +
      "/" +
      t.n +
      ")" +
      (t.avgR != null ? " — avg " + (t.avgR >= 0 ? "+" : "") + t.avgR.toFixed(2) + "R" : "")
    );
  }

  function renderBandTable(report, title) {
    if (!report?.totalN) {
      return (
        '<div class="tt-cal-block"><h5>' +
        title +
        '</h5><p class="meta">No R data yet — run backtest or close planned trades.</p></div>'
      );
    }
    let rows = "";
    for (const b of report.bands) {
      rows +=
        "<tr><td>" +
        b.label +
        "</td><td>" +
        b.n +
        "</td><td>" +
        b.hit1RPct +
        "%</td><td>" +
        (b.avgR != null
          ? (b.avgR >= 0 ? "+" : "") + b.avgR.toFixed(2) + "R"
          : "—") +
        "</td></tr>";
    }
    const note = report.insufficient
      ? '<p class="tt-cal-note">N=' +
        report.totalN +
        " — illustrative until N≥" +
        MIN_N +
        " (M1-spec).</p>"
      : "";
    return (
      '<div class="tt-cal-block"><h5>' +
      title +
      (report.avgR != null
        ? ' — <span class="tt-cal-summary">' +
          (report.avgR >= 0 ? "+" : "") +
          report.avgR.toFixed(2) +
          "R avg — " +
          report.hit1RPct +
          "% hit 1R</span>"
        : "") +
      "</h5>" +
      '<table class="tt-cal-table"><thead><tr><th>RM decile</th><th>N</th><th>Hit 1R</th><th>Avg R</th></tr></thead><tbody>' +
      rows +
      "</tbody></table>" +
      '<p class="tt-cal-thresholds">' +
      fmtThresholdRow(report.rm50) +
      " — " +
      fmtThresholdRow(report.rm70) +
      "</p>" +
      note +
      "</div>"
    );
  }

  function renderPanel(picks, backtestRaw, trades) {
    const bt = backtestRaw?.results?.length
      ? calibrateBacktest(picks, backtestRaw)
      : buildReport("backtest", []);
    const live = calibrateLive(trades || []);
    const rule = backtestRaw?.entry_rule || "orh";
    const rr = backtestRaw?.rr != null ? backtestRaw.rr : 2;
    const btLabel =
      rule === "vwap"
        ? "Backtest - VWAP " + rr + "R"
        : "Backtest - ORH " + rr + "R";
    const rangeNote =
      backtestRaw?.range && backtestRaw.range !== "1d"
        ? " · " + backtestRaw.range
        : backtestRaw?.mode === "offline"
          ? " · today only"
          : "";
    return (
      '<div class="tt-calibration-grid">' +
      renderBandTable(bt, btLabel + rangeNote) +
      renderBandTable(live, "Live - planned closes") +
      "</div>"
    );
  }

  global.RMCalibration = {
    MIN_N,
    decileForScore,
    decileLabel,
    hit1R,
    calibrateBacktest,
    calibrateLive,
    itemsFromBacktest,
    itemsFromLiveTrades,
    renderBandTable,
    renderPanel,
    fmtThresholdRow,
  };
})(typeof window !== "undefined" ? window : global);

;
/* --- monthly_review.js --- */
/** Monthly hypothesis review ? DECISIONS.log.md entry (Tier 1). */
(function (global) {
  const STORAGE_KEY = "rainmaker_monthly_review_drafts";

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function monthKey(d) {
    const dt = d || new Date();
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
  }

  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveDrafts(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  function saveDraft(draft) {
    const list = loadDrafts();
    const id = draft.id || "review-" + Date.now();
    const next = { ...draft, id, saved_at: new Date().toISOString() };
    const idx = list.findIndex((d) => d.id === id);
    if (idx >= 0) list[idx] = next;
    else list.unshift(next);
    saveDrafts(list.slice(0, 12));
    return next;
  }

  function calibrationSummary(btReport, liveReport) {
    const parts = [];
    if (typeof RMCalibration !== "undefined") {
      if (btReport?.rm50?.n) parts.push("BT " + RMCalibration.fmtThresholdRow(btReport.rm50));
      if (liveReport?.rm50?.n) parts.push("Live " + RMCalibration.fmtThresholdRow(liveReport.rm50));
    }
    return parts.join("; ");
  }

  function buildDecisionsMarkdown(opts) {
    const mk = opts.month || monthKey();
    const title = opts.title || "H-001 monthly review " + mk;
    const decision = (opts.decision || "").trim() || "(describe one weight/threshold change)";
    const evidenceParts = [];
    if (opts.backtestAvgR != null && opts.backtestN) {
      evidenceParts.push(
        "Backtest " +
          (opts.backtestAvgR >= 0 ? "+" : "") +
          Number(opts.backtestAvgR).toFixed(2) +
          "R avg (N=" +
          opts.backtestN +
          ")"
      );
    }
    if (opts.liveAvgR != null && opts.liveN) {
      evidenceParts.push(
        "Live " +
          (opts.liveAvgR >= 0 ? "+" : "") +
          Number(opts.liveAvgR).toFixed(2) +
          "R avg (N=" +
          opts.liveN +
          " planned)"
      );
    }
    if (opts.driftR != null && Number.isFinite(opts.driftR)) {
      evidenceParts.push(
        "Drift live?backtest " +
          (opts.driftR >= 0 ? "+" : "") +
          opts.driftR.toFixed(2) +
          "R"
      );
    }
    const evidence = evidenceParts.length
      ? evidenceParts.join("; ")
      : "Run backtest + close planned trades first";
    const cal = (opts.calibrationNote || "").trim();
    const notes = [cal, opts.changeAfter ? "After change: " + opts.changeAfter : ""]
      .filter(Boolean)
      .join(" · ");

    return (
      "## D-0XX — " +
      title +
      "\n\n" +
      "| Field | Value |\n" +
      "|-------|--------|\n" +
      "| Date | " +
      (opts.date || new Date().toISOString().slice(0, 10)) +
      " |\n" +
      "| Milestone | M1 |\n" +
      "| Assumption IDs | H-001 |\n" +
      "| Decision | " +
      decision +
      " |\n" +
      "| Confidence | M |\n" +
      "| Status | proposed |\n" +
      "| Evidence | " +
      evidence +
      " |\n" +
      "| Owner | Michael |\n" +
      (notes ? "| Notes | " + notes + " |\n" : "") +
      "\n---\n"
    );
  }

  function autoMetrics(getTrades, session, backtestReport) {
    let liveReport = null;
    let btReport = null;
    if (typeof RMCalibration !== "undefined" && typeof getTrades === "function") {
      liveReport = RMCalibration.calibrateLive(getTrades());
      if (session?.picks?.length && backtestReport) {
        btReport = RMCalibration.calibrateBacktest(session.picks, backtestReport);
      }
    }
    const backtestAvgR = backtestReport?.summary?.avgR ?? btReport?.avgR ?? null;
    const backtestN = backtestReport?.summary?.n ?? btReport?.totalN ?? 0;
    const liveAvgR = liveReport?.avgR ?? null;
    const liveN = liveReport?.totalN ?? 0;
    const driftR =
      backtestAvgR != null && liveAvgR != null
        ? round2(liveAvgR - backtestAvgR)
        : null;
    return {
      backtestAvgR,
      backtestN,
      liveAvgR,
      liveN,
      driftR,
      calibrationNote: calibrationSummary(btReport, liveReport),
      btReport,
      liveReport,
    };
  }

  async function copyMarkdown(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  global.RMMonthlyReview = {
    monthKey,
    loadDrafts,
    saveDraft,
    buildDecisionsMarkdown,
    autoMetrics,
    copyMarkdown,
  };
})(typeof window !== "undefined" ? window : global);

;
/* --- trade_debrief.js --- */
/**
 * Trade debrief - deterministic "What happened?" Reflect flow for recent Schwab closes.
 */
(function (global) {
  "use strict";

  const REFLECT_TAGS = [
    { id: "regime_mismatch", label: "Regime mismatch" },
    { id: "no_plan", label: "No plan" },
    { id: "stop_honored", label: "Stop honored" },
    { id: "stop_tight", label: "Stop too tight" },
    { id: "held_too_long", label: "Held too long" },
    { id: "good_process", label: "Good process" },
  ];

  let activeTrade = null;
  let selectedTags = new Set();
  let wired = false;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "N/A";
    const sign = n >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(n).toFixed(2);
  }

  function fmtTime(iso) {
    if (!iso) return "N/A";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return String(iso).slice(0, 16);
    }
  }

  function holdMinutes(trade) {
    const a = Date.parse(trade.opened_at || "");
    const b = Date.parse(trade.closed_at || "");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return Math.round((b - a) / 60000);
  }

  function fmtHold(mins) {
    if (mins == null) return "N/A";
    if (mins < 60) return mins + "m";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? h + "h " + m + "m" : h + "h";
  }

  function chartSymbolForTrade(trade) {
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolFor) {
      return global.RMHoldings.chartSymbolFor({
        symbol: trade.symbol,
        instrument: trade.instrument,
      });
    }
    return String(trade.symbol || "").trim().toUpperCase();
  }

  function optionDirection(symbol) {
    const s = String(symbol || "").replace(/\s+/g, "").toUpperCase();
    const m = s.match(/\d{6}([CP])\d{8}/);
    if (!m) return null;
    return m[1] === "C" ? "long_call" : "long_put";
  }

  function tradeDirection(trade) {
    if (trade.instrument === "option" || optionDirection(trade.symbol)) {
      return optionDirection(trade.symbol) || "long_call";
    }
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price ?? trade.exit_premium;
    if (entry != null && exit != null && exit < entry) return "long_loss";
    return "long_stock";
  }

  function biasLeanFromPct(pct) {
    if (pct == null || !Number.isFinite(pct)) return null;
    if (pct > 0.05) return 1;
    if (pct < -0.05) return -1;
    return 0;
  }

  function pulseLeanForTradeDay(trade) {
    if (trade.engine_bias && typeof trade.engine_bias.lean === "number") {
      return trade.engine_bias.lean;
    }
    const day = String(trade.opened_at || trade.closed_at || "").slice(0, 10);
    if (!day || typeof global.RMMarket === "undefined" || !global.RMMarket.loadBiasLog) {
      return null;
    }
    const log = global.RMMarket.loadBiasLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (!e || e.at == null) continue;
      let eDay;
      try {
        eDay = new Date(e.at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      } catch (err) {
        eDay = String(e.at).slice(0, 10);
      }
      if (eDay === day) {
        return biasLeanFromPct(e.marketPct);
      }
    }
    return null;
  }

  function pulseLabel(lean) {
    if (lean == null) return "Unknown";
    if (lean > 0) return "Bullish";
    if (lean < 0) return "Bearish";
    return "Neutral";
  }

  function sessionLabel(iso) {
    if (!iso) return "N/A";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).formatToParts(new Date(iso));
      const hour = Number(parts.find((p) => p.type === "hour")?.value);
      if (!Number.isFinite(hour)) return "RTH";
      if (hour < 9) return "Pre-market";
      if (hour >= 16) return "After-hours";
      return "RTH";
    } catch (e) {
      return "RTH";
    }
  }

  function exitKind(trade) {
    const exit = trade.exit_price ?? trade.exit_premium;
    const stop = trade.stop_price ?? trade.stop_premium;
    const target = trade.target_price;
    if (exit == null) return "unknown";
    if (stop != null && Math.abs(exit - stop) / Math.max(Math.abs(stop), 0.01) < 0.02) {
      return "stop-out";
    }
    if (target != null && Math.abs(exit - target) / Math.max(Math.abs(target), 0.01) < 0.02) {
      return "target";
    }
    return "discretionary";
  }

  function isPlanned(trade) {
    if (typeof global.RMTradeMetrics !== "undefined" && global.RMTradeMetrics.isPlannedTrade) {
      return global.RMTradeMetrics.isPlannedTrade(trade);
    }
    return trade.planned !== false && trade.source !== "schwab_api";
  }

  function priceLine(trade) {
    const isOpt = trade.instrument === "option";
    const entry = isOpt ? trade.entry_premium ?? trade.entry_price : trade.entry_price;
    const exit = isOpt ? trade.exit_premium ?? trade.exit_price : trade.exit_price;
    const unit = isOpt ? " premium" : "";
    let s = "";
    if (entry != null) s += "entry $" + Number(entry).toFixed(2) + unit;
    if (exit != null) s += (s ? " | " : "") + "exit $" + Number(exit).toFixed(2) + unit;
    return s || "N/A";
  }

  function realizedRDisplay(trade) {
    if (typeof global.RMTradeMetrics === "undefined") {
      return trade.r_multiple != null ? Number(trade.r_multiple).toFixed(2) + "R" : "N/A";
    }
    const rr = global.RMTradeMetrics.realizedR(trade);
    if (rr != null) return (rr >= 0 ? "+" : "") + Number(rr).toFixed(2) + "R";
    const stop = trade.stop_price ?? trade.stop_premium;
    if (stop == null && !isPlanned(trade)) return "N/A (no stop)";
    return "N/A";
  }

  function suggestTags(trade, learnings) {
    const tags = new Set();
    const lean = pulseLeanForTradeDay(trade);
    const dir = tradeDirection(trade);
    const mins = holdMinutes(trade);
    const planned = isPlanned(trade);
    const kind = exitKind(trade);

    if (!planned) tags.add("no_plan");

    if (lean != null) {
      const against =
        (lean < 0 && (dir === "long_call" || dir === "long_stock")) ||
        (lean > 0 && dir === "long_put");
      if (against) tags.add("regime_mismatch");
    }

    if (kind === "stop-out") tags.add("stop_honored");
    if (mins != null && mins < 15 && (trade.pnl_usd == null || trade.pnl_usd < 0)) {
      tags.add("stop_tight");
    }
    if (mins != null && mins > 240) tags.add("held_too_long");

    if (
      planned &&
      kind === "stop-out" &&
      typeof global.RMTradeMetrics !== "undefined" &&
      global.RMTradeMetrics.reconcileStatus(trade) === "agreed"
    ) {
      tags.add("good_process");
    }

    (learnings || []).forEach(function (ln) {
      if (/regime|against.*pulse|bearish.*call|bullish.*put/i.test(ln)) tags.add("regime_mismatch");
      if (/no plan|imported from schwab/i.test(ln)) tags.add("no_plan");
      if (/stop honored|stopped out/i.test(ln)) tags.add("stop_honored");
      if (/impulse|within 15/i.test(ln)) tags.add("stop_tight");
      if (/held.*long|4\+ hours/i.test(ln)) tags.add("held_too_long");
    });

    return tags;
  }

  function buildLearnings(trade) {
    const out = [];
    const lean = pulseLeanForTradeDay(trade);
    const dir = tradeDirection(trade);
    const mins = holdMinutes(trade);
    const planned = isPlanned(trade);
    const kind = exitKind(trade);

    if (!planned) {
      out.push(
        "No Rainmaker plan - imported from Schwab. Add a retrospective stop in debrief to compute R."
      );
    }

    if (lean != null) {
      const pulse = pulseLabel(lean);
      if (lean < 0 && dir === "long_call") {
        out.push("Pulse was " + pulse.toLowerCase() + "; long call traded against regime.");
      } else if (lean > 0 && dir === "long_put") {
        out.push("Pulse was " + pulse.toLowerCase() + "; long put traded against regime.");
      } else if (lean !== 0) {
        out.push("Pulse was " + pulse.toLowerCase() + " on trade day - direction aligned with lean.");
      }
    }

    if (mins != null && mins < 15) {
      out.push("Exit within 15m of entry - impulse / quick stop flag.");
    } else if (mins != null && mins > 240) {
      out.push("Held " + fmtHold(mins) + " - review whether thesis needed earlier exit.");
    }

    if (kind === "stop-out") {
      out.push("Exit matched stop zone - stop honored.");
    } else if (kind === "target") {
      out.push("Exit near planned target.");
    }

    if (planned && typeof global.RMTradeMetrics !== "undefined") {
      const status = global.RMTradeMetrics.reconcileStatus(trade);
      if (status === "delta") {
        const pr = global.RMTradeMetrics.planR(trade);
        const rr = global.RMTradeMetrics.realizedR(trade);
        out.push(
          "Plan vs realized delta - Plan " +
            (pr != null ? pr.toFixed(2) : "?") +
            "R vs Realized " +
            (rr != null ? rr.toFixed(2) : "?") +
            "R."
        );
      }
    }

    if (trade.pnl_usd != null && trade.pnl_usd < 0 && kind === "stop-out" && !planned) {
      out.push("Stop-out without a written setup - capture what assumption broke.");
    }

    while (out.length < 2) {
      if (trade.instrument === "option") {
        out.push("Options trade - R uses premium; verify contract qty x 100 for P/L.");
        break;
      }
      out.push("Review chart structure at entry vs exit window.");
      break;
    }

    return out.slice(0, 4);
  }

  function buildDebrief(trade) {
    if (!trade) return null;
    const learnings = buildLearnings(trade);
    const lean = pulseLeanForTradeDay(trade);
    const planned = isPlanned(trade);
    const pr =
      typeof global.RMTradeMetrics !== "undefined" ? global.RMTradeMetrics.planR(trade) : trade.plan_r;
    const rr =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.realizedR(trade)
        : trade.realized_r;

    return {
      trade: trade,
      facts: {
        symbol: trade.symbol,
        instrument: trade.instrument || "stock",
        qty: trade.quantity ?? trade.qty,
        prices: priceLine(trade),
        opened: fmtTime(trade.opened_at),
        closed: fmtTime(trade.closed_at),
        hold: fmtHold(holdMinutes(trade)),
        pnl: fmtUsd(trade.pnl_usd),
        realizedR: realizedRDisplay(trade),
        exitKind: exitKind(trade),
      },
      context: {
        pulseLean: lean,
        pulseLabel: pulseLabel(lean),
        session: sessionLabel(trade.opened_at),
        chartSymbol: chartSymbolForTrade(trade),
      },
      planDelta: planned
        ? {
            hasPlan: true,
            planR: pr,
            realizedR: rr,
            dual:
              typeof global.RMTradeMetrics !== "undefined"
                ? global.RMTradeMetrics.fmtDualTrack(trade)
                : "",
            reconcile:
              typeof global.RMTradeMetrics !== "undefined"
                ? global.RMTradeMetrics.reconcileStatus(trade)
                : trade.reconcile_status,
          }
        : {
            hasPlan: false,
            message: "No Rainmaker plan - imported from Schwab",
          },
      learnings: learnings,
      suggestedTags: [...suggestTags(trade, learnings)],
    };
  }

  function renderDebriefHtml(debrief) {
    if (!debrief) return "";
    const f = debrief.facts;
    const c = debrief.context;
    const p = debrief.planDelta;
    let html = "";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Facts</h3>";
    html += '<div class="rm-debrief-facts">';
    html += "<div><strong>" + escapeHtml(f.symbol) + "</strong> | " + escapeHtml(f.instrument);
    if (f.qty != null) html += " | qty " + escapeHtml(f.qty);
    html += "</div>";
    html += "<div>" + escapeHtml(f.prices) + "</div>";
    html +=
      "<div>" +
      escapeHtml(f.opened) +
      " -> " +
      escapeHtml(f.closed) +
      " | hold " +
      escapeHtml(f.hold) +
      "</div>";
    html +=
      "<div>P/L " +
      escapeHtml(f.pnl) +
      " | Realized " +
      escapeHtml(f.realizedR) +
      " | " +
      escapeHtml(f.exitKind) +
      "</div>";
    html += "</div></section>";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Context</h3>";
    html += '<p class="meta">Pulse: <strong>' + escapeHtml(c.pulseLabel) + "</strong>";
    html += " | Session: " + escapeHtml(c.session);
    html += " | Chart: " + escapeHtml(c.chartSymbol) + "</p>";
    html += "</section>";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Plan</h3>";
    if (p.hasPlan) {
      html += '<p class="meta">' + escapeHtml(p.dual || "Plan on file") + "</p>";
      if (p.reconcile === "delta") {
        html += '<p class="meta rm-debrief-warn">Reconcile delta - plan R differed from realized.</p>';
      }
    } else {
      html += '<p class="meta">' + escapeHtml(p.message) + "</p>";
      html +=
        '<label class="rm-debrief-stop-label">Retrospective stop (premium/price)<input type="number" step="0.01" id="debriefRetroStop" class="rm-debrief-stop-input" placeholder="Optional"></label>';
    }
    html += "</section>";

    html += '<section class="rm-debrief-section">';
    html += '<h3>Platform learnings</h3><ul class="rm-debrief-learnings">';
    debrief.learnings.forEach(function (ln) {
      html += "<li>" + escapeHtml(ln) + "</li>";
    });
    html += "</ul></section>";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Reflect tags</h3>";
    html += '<div class="rm-debrief-tags" id="debriefTags">';
    REFLECT_TAGS.forEach(function (tag) {
      const on = debrief.suggestedTags.indexOf(tag.id) >= 0 ? " is-selected" : "";
      html +=
        '<button type="button" class="rm-debrief-tag' +
        on +
        '" data-tag="' +
        escapeHtml(tag.id) +
        '">' +
        escapeHtml(tag.label) +
        "</button>";
    });
    html += "</div>";
    html +=
      '<label class="rm-debrief-note-label">Note<textarea id="debriefNoteText" rows="2" placeholder="Optional one-liner"></textarea></label>';
    html += '<button type="button" class="btn-block" id="debriefSaveBtn">Save Reflect note</button>';
    html += '<p class="meta rm-debrief-save-status" id="debriefSaveStatus" aria-live="polite"></p>';
    html += "</section>";

    return html;
  }

  async function focusChartForDebrief(trade) {
    if (!trade || typeof global.RMAnalysisChart === "undefined") return;
    const chartSym = chartSymbolForTrade(trade);
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.expand("chart");
    }
    if (typeof global.closeOrderDrawer === "function") {
      global.closeOrderDrawer();
    }
    const symEl = $("caSymbol");
    if (symEl) {
      let hasOpt = false;
      symEl.querySelectorAll("option").forEach(function (o) {
        if (o.value === chartSym) hasOpt = true;
      });
      if (!hasOpt) {
        const opt = document.createElement("option");
        opt.value = chartSym;
        opt.textContent = chartSym;
        symEl.appendChild(opt);
      }
      symEl.value = chartSym;
    }
    global.RMAnalysisChart.state.symbol = chartSym;
    global.RMAnalysisChart.state.showEvents = true;
    const tStart = Date.parse(trade.opened_at || "");
    const tEnd = Date.parse(trade.closed_at || "");
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price ?? trade.exit_premium;
    if (global.RMAnalysisChart.saveTradeMarker) {
      global.RMAnalysisChart.saveTradeMarker({
        id: "debrief-" + String(trade.id || trade.symbol),
        symbol: chartSym,
        entry_price: entry,
        exit_price: exit,
        stop_price: trade.stop_price ?? trade.stop_premium ?? null,
        target_price: trade.target_price ?? null,
        t: Number.isFinite(tStart) ? tStart : Date.now(),
        exit_t: Number.isFinite(tEnd) ? tEnd : null,
        closed_at: trade.closed_at || new Date().toISOString(),
        session_id: trade.session_id || null,
        filled: true,
        source: trade.source || "debrief",
        label:
          trade.instrument === "option" || chartSym !== String(trade.symbol || "").trim().toUpperCase()
            ? trade.symbol
            : null,
      });
    }
    if (global.RMAnalysisChart.setActiveTradeMarker) {
      global.RMAnalysisChart.setActiveTradeMarker(
        "debrief-" + String(trade.id || trade.symbol),
        trade.symbol
      );
    }
    if (global.RMAnalysisChart.setDebriefWindow) {
      global.RMAnalysisChart.setDebriefWindow({
        symbol: chartSym,
        tStart: Number.isFinite(tStart) ? tStart : null,
        tEnd: Number.isFinite(tEnd) ? tEnd : null,
      });
    }
    if (global.RMAnalysisChart.reload) {
      await global.RMAnalysisChart.reload({ preserveView: false, resetView: true });
    } else if (global.RMAnalysisChart.paint) {
      global.RMAnalysisChart.paint();
    }
    if (
      global.RMAnalysisChart.focusDebriefWindow &&
      Number.isFinite(tStart) &&
      Number.isFinite(tEnd)
    ) {
      global.RMAnalysisChart.focusDebriefWindow(tStart, tEnd);
      global.RMAnalysisChart.paint?.();
    }
  }

  function clearChartDebrief() {
    if (typeof global.RMAnalysisChart !== "undefined" && global.RMAnalysisChart.clearDebriefWindow) {
      global.RMAnalysisChart.clearDebriefWindow();
    }
  }

  function openDrawer() {
    const drawer = $("tradeDebriefDrawer");
    const backdrop = $("debriefBackdrop");
    if (!drawer) return;
    drawer.classList.remove("is-closed");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    if (backdrop) {
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("debrief-open");
  }

  function closeDebrief() {
    const drawer = $("tradeDebriefDrawer");
    const backdrop = $("debriefBackdrop");
    if (drawer) {
      drawer.classList.add("is-closed");
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (backdrop) {
      backdrop.classList.add("hidden");
      backdrop.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("debrief-open");
    activeTrade = null;
    selectedTags = new Set();
    clearChartDebrief();
  }

  function wirePanelEvents(debrief) {
    selectedTags = new Set(debrief.suggestedTags || []);
    const tagsEl = $("debriefTags");
    if (tagsEl) {
      tagsEl.querySelectorAll(".rm-debrief-tag").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const tag = btn.getAttribute("data-tag");
          if (!tag) return;
          if (selectedTags.has(tag)) {
            selectedTags.delete(tag);
            btn.classList.remove("is-selected");
          } else {
            selectedTags.add(tag);
            btn.classList.add("is-selected");
          }
        });
      });
    }
    const saveBtn = $("debriefSaveBtn");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        void saveDebriefNote(activeTrade, debrief);
      });
    }
  }

  async function saveDebriefNote(trade, debrief) {
    if (!trade) return;
    const statusEl = $("debriefSaveStatus");
    const noteText = ($("debriefNoteText") && $("debriefNoteText").value.trim()) || "";
    const retroStop = $("debriefRetroStop") ? Number($("debriefRetroStop").value) : null;
    const tags = selectedTags.size ? [...selectedTags] : debrief?.suggestedTags || [];
    const lean = debrief?.context?.pulseLean ?? pulseLeanForTradeDay(trade);
    let realizedR =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.realizedR(trade)
        : trade.realized_r;
    if (realizedR == null && Number.isFinite(retroStop)) {
      const entry = trade.entry_price ?? trade.entry_premium;
      const exit = trade.exit_price ?? trade.exit_premium;
      const risk = entry - retroStop;
      if (entry != null && exit != null && risk > 0) {
        realizedR = Math.round(((exit - entry) / risk) * 10000) / 10000;
      }
    }
    const summary =
      noteText ||
      tags
        .map(function (id) {
          const t = REFLECT_TAGS.find(function (x) {
            return x.id === id;
          });
          return t ? t.label : id;
        })
        .join("; ") ||
      (debrief?.facts?.exitKind === "stop-out" ? "Stopped out debrief." : "Trade debrief.");

    const storyDay = String(trade.closed_at || trade.opened_at || "").slice(0, 10);
    const event = {
      type: "note",
      subtype: "what_happened",
      trade_id: trade.id || null,
      symbol: trade.symbol,
      tags: tags,
      summary: summary,
      learnings: debrief?.learnings || [],
      snapshot: {
        pulse_lean: lean,
        realized_r: realizedR,
        pnl_usd: trade.pnl_usd ?? null,
        instrument: trade.instrument || "stock",
        exit_kind: debrief?.facts?.exitKind || null,
      },
    };

    if (typeof global.RMTradeStory !== "undefined" && global.RMTradeStory.appendEvent) {
      await global.RMTradeStory.appendEvent(event, { storyId: storyDay || undefined });
    }

    if (statusEl) {
      statusEl.textContent = "Saved - Reflect note stored for " + (storyDay || "today") + ".";
    }
    document.dispatchEvent(
      new CustomEvent("rm:debrief-saved", { detail: { trade: trade, event: event } })
    );
  }

  function isMobileChartFirst() {
    return (
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: 640px)").matches
    );
  }

  async function openDebrief(trade, opts) {
    if (!trade) return;
    ensureWired();
    const mobileFirst = isMobileChartFirst();
    const chartOnly = opts?.chartOnly === true || (mobileFirst && opts?.reflectPanel !== true);
    activeTrade = trade;
    const debrief = buildDebrief(trade);
    const subtitle = $("debriefSubtitle");
    if (subtitle) {
      subtitle.textContent =
        (trade.instrument === "option" ? "Option | " : "") +
        String(trade.closed_at || "").slice(0, 10);
    }
    await focusChartForDebrief(trade);
    if (typeof global.rmStatus === "function") {
      global.rmStatus(
        chartOnly
          ? trade.symbol + " on chart  -  tap What happened? again for Reflect."
          : trade.symbol + " trade window highlighted on chart."
      );
    }
    if (chartOnly) {
      requestAnimationFrame(function () {
        const chart = document.getElementById("workspaceChart");
        if (chart) chart.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }
    const body = $("debriefBody");
    if (body) {
      body.innerHTML = renderDebriefHtml(debrief);
      wirePanelEvents(debrief);
    }
    openDrawer();
  }

  function ensureWired() {
    if (wired) return;
    wired = true;
    const closeBtn = $("btnCloseDebrief");
    const backdrop = $("debriefBackdrop");
    if (closeBtn) closeBtn.addEventListener("click", closeDebrief);
    if (backdrop) backdrop.addEventListener("click", closeDebrief);
  }

  function initClosedListDelegation() {
    const list = $("ttResultsClosedList");
    if (!list || list.dataset.debriefWired === "1") return;
    list.dataset.debriefWired = "1";
    list.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-debrief-id]");
      if (btn) {
        const id = btn.getAttribute("data-debrief-id");
        const trades =
          typeof global.RMTrades !== "undefined" && global.RMTrades.getJournalTrades
            ? global.RMTrades.getJournalTrades()
            : [];
        const trade = trades.find(function (t) {
          return String(t.id) === String(id);
        });
        if (!trade) return;
        const same =
          activeTrade &&
          String(activeTrade.id) === String(trade.id) &&
          typeof global.RMAnalysisChart !== "undefined" &&
          global.RMAnalysisChart.state?.debriefWindow;
        if (same && isMobileChartFirst()) {
          void openDebrief(trade, { reflectPanel: true });
        } else {
          void openDebrief(trade);
        }
        return;
      }
      const row = ev.target.closest(".trade-item[data-trade-id]");
      if (!row) return;
      const id = row.getAttribute("data-trade-id");
      const trades =
        typeof global.RMTrades !== "undefined" && global.RMTrades.getJournalTrades
          ? global.RMTrades.getJournalTrades()
          : typeof global.getJournalTrades === "function"
            ? global.getJournalTrades()
            : [];
      const trade = trades.find(function (t) {
        return String(t.id) === String(id);
      });
      if (!trade) return;
      highlightClosedTradeRow(id);
      void focusChartForDebrief(trade);
    });
    list.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".trade-item[data-trade-id]");
      if (!row) return;
      ev.preventDefault();
      row.click();
    });
  }

  function highlightClosedTradeRow(tradeId) {
    const list = $("ttResultsClosedList");
    if (!list) return;
    list.querySelectorAll(".trade-item--active").forEach(function (el) {
      el.classList.remove("trade-item--active");
    });
    if (!tradeId) return;
    const row = list.querySelector('.trade-item[data-trade-id="' + tradeId + '"]');
    if (row) {
      row.classList.add("trade-item--active");
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function init() {
    ensureWired();
    initClosedListDelegation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  document.addEventListener("rm:results-closed-rendered", initClosedListDelegation);

  global.RMTradeDebrief = {
    REFLECT_TAGS,
    buildDebrief,
    buildLearnings,
    suggestTags,
    openDebrief,
    closeDebrief,
    saveDebriefNote,
    focusChartForDebrief,
    highlightClosedTradeRow,
    chartSymbolForTrade,
    pulseLeanForTradeDay,
    init,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- agent_overlay.js --- */
/** Educator overlay — chart-scan / debrief explainer (contextual; no free-form chat primary). */
(function (global) {
  const TIPS = {
    ".price-move": "Percent change vs prior close at scan time (morning = gap + premarket).",
    ".pick-gap": "Gap-up % = open above prior close; bull momentum qualifier.",
    ".ca-holding-band": "Open position band — entry date and avg price from Schwab or manual holding.",
    ".ca-chart-node--scan": "Chart scan node — saved research region on this symbol.",
    ".rm-meter": "H-001 RM confidence from MorningMomentumScanner weights.",
    ".fv-tip-target": "Market map cell — hover for index, breadth, or pick context.",
    "#btnCustomScan": "Runs live H-001 gap-up momentum scan via Yahoo screeners.",
  };

  const POS_KEY = "rainmaker_agent_panel_pos_v1";

  let debriefContext = null;
  let dragState = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "";
    return sign + v.toFixed(2) + "%";
  }

  function fmtNum(v, digits) {
    if (v == null || !Number.isFinite(v)) return "—";
    return v.toFixed(digits == null ? 1 : digits);
  }

  function fmtHeadlineTime(t) {
    if (!t) return "";
    try {
      return new Date(t).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
    } catch {
      return "";
    }
  }

  function loadPanelPos() {
    try {
      return JSON.parse(sessionStorage.getItem(POS_KEY) || "null");
    } catch {
      return null;
    }
  }

  function savePanelPos(panel) {
    if (!panel || panel.classList.contains("hidden")) return;
    const r = panel.getBoundingClientRect();
    try {
      sessionStorage.setItem(
        POS_KEY,
        JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })
      );
    } catch {
      /* ignore */
    }
  }

  function applyPanelPos(panel) {
    const pos = loadPanelPos();
    if (!pos || pos.left == null || pos.top == null) return;
    panel.style.right = "auto";
    panel.style.left = Math.max(8, pos.left) + "px";
    panel.style.top = Math.max(8, pos.top) + "px";
    panel.style.transform = "none";
    panel.dataset.userPos = "1";
  }

  function clampPanelPos(panel, left, top) {
    const r = panel.getBoundingClientRect();
    const w = r.width || panel.offsetWidth || 280;
    const h = r.height || panel.offsetHeight || 200;
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
    };
  }

  function bindPanelDrag(panel) {
    const head = panel.querySelector(".agent-head");
    if (!head || head.dataset.dragBound === "1") return;
    head.dataset.dragBound = "1";

    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.transform = "none";
      panel.dataset.userPos = "1";
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: r.left,
        top: r.top,
      };
      panel.classList.add("is-dragging");
      head.setPointerCapture(e.pointerId);
    });

    head.addEventListener("pointermove", (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const next = clampPanelPos(panel, dragState.left + dx, dragState.top + dy);
      panel.style.left = next.left + "px";
      panel.style.top = next.top + "px";
    });

    const endDrag = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      dragState = null;
      panel.classList.remove("is-dragging");
      savePanelPos(panel);
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
  }

  function confidenceBadge(level) {
    const lv = String(level || "low").toLowerCase();
    const label = lv === "high" ? "High" : lv === "med" ? "Med" : "Low";
    return (
      '<span class="agent-conf-badge is-' +
      escapeHtml(lv) +
      '" title="Evidence strength">' +
      escapeHtml(label) +
      "</span>"
    );
  }

  function structureClass(structure) {
    const s = String(structure || "").toLowerCase();
    if (s.includes("up")) return "is-up";
    if (s.includes("down")) return "is-down";
    return "is-flat";
  }

  function renderMetricChip(k, v, cls) {
    return (
      '<div class="agent-metric' +
      (cls ? " " + cls : "") +
      '"><span class="agent-metric-k">' +
      escapeHtml(k) +
      '</span><strong class="agent-metric-v">' +
      escapeHtml(v) +
      "</strong></div>"
    );
  }

  function renderCatalystList(items) {
    if (!items?.length) {
      return (
        '<p class="agent-empty">No headlines in window — run Scan + news or widen the circle.</p>'
      );
    }
    return (
      '<ul class="agent-catalyst-list">' +
      items
        .map((hit) => {
          const tag = hit.tag === "in circle" ? "in" : "near";
          const when = fmtHeadlineTime(hit.t);
          return (
            '<li class="agent-catalyst-item">' +
            '<span class="agent-cat-tag is-' +
            tag +
            '">' +
            (tag === "in" ? "In" : "Near") +
            "</span>" +
            (when ? '<time class="agent-cat-time">' + escapeHtml(when) + "</time>" : "") +
            '<span class="agent-cat-title">' +
            escapeHtml(hit.title || "") +
            "</span></li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function renderDebriefBody(ctx) {
    if (!ctx) {
      return (
        '<div class="agent-idle">' +
        '<p class="agent-idle-lead">Research assistant</p>' +
        '<p class="agent-idle-copy">Right-click a chart circle → <strong>Analyze</strong>. Structured debrief lands here — not open chat.</p>' +
        "</div>"
      );
    }

    const m = ctx.metrics || {};
    const moveCls =
      m.movePct > 0.05 ? "is-pos" : m.movePct < -0.05 ? "is-neg" : "";
    const macdVal = m.macdHist;
    const macdLabel =
      macdVal == null
        ? "—"
        : (macdVal >= 0 ? "+" : "") + fmtNum(macdVal, 2);
    const macdCls = macdVal > 0 ? "is-pos" : macdVal < 0 ? "is-neg" : "";

    const metrics =
      '<div class="agent-metrics">' +
      renderMetricChip("Move", fmtPct(m.movePct), moveCls) +
      renderMetricChip(
        "Shape",
        m.structure || "—",
        "agent-metric--shape " + structureClass(m.structure)
      ) +
      renderMetricChip("RSI", m.rsi == null ? "—" : fmtNum(m.rsi, 0)) +
      renderMetricChip("MACD", macdLabel, macdCls) +
      renderMetricChip("Bars", m.bars != null ? String(m.bars) : "—") +
      "</div>";

    const range =
      m.hi != null || m.lo != null
        ? '<div class="agent-range-row">' +
          '<span class="agent-range-k">Range</span>' +
          '<span class="agent-range-v">' +
          escapeHtml(ctx.rangeLabel || "—") +
          "</span></div>"
        : "";

    const confidenceCopy = ctx.confidence
      ? String(ctx.confidence).replace(/^[^:]+:\s*/i, "")
      : "";

    return (
      '<article class="agent-debrief is-live">' +
      '<div class="agent-debrief-head">' +
      '<div class="agent-debrief-title">' +
      '<span class="agent-sym">' +
      escapeHtml(ctx.symbol || ctx.title || "Scan") +
      "</span>" +
      confidenceBadge(ctx.confidenceLevel) +
      "</div>" +
      (ctx.hint
        ? '<p class="agent-window">' + escapeHtml(ctx.hint) + "</p>"
        : "") +
      "</div>" +
      metrics +
      range +
      '<section class="agent-sec">' +
      '<h4 class="agent-sec-k">Catalyst</h4>' +
      renderCatalystList(ctx.catalystItems) +
      "</section>" +
      (confidenceCopy
        ? '<p class="agent-conf-note">' + escapeHtml(confidenceCopy) + "</p>"
        : "") +
      (ctx.scanId
        ? '<div class="agent-debrief-actions">' +
          '<button type="button" class="agent-act agent-act--primary" id="agentDebriefSave">Save to story</button>' +
          '<button type="button" class="agent-act" id="agentDebriefDismiss">Close</button>' +
          "</div>"
        : "") +
      "</article>"
    );
  }

  function renderDebrief(ctx) {
    debriefContext = ctx || null;
    const log = $("agentLog");
    const panel = $("agentPanel");
    if (!log) return;

    log.innerHTML = renderDebriefBody(ctx);

    if (panel) {
      panel.classList.toggle("has-debrief", !!ctx);
      panel.classList.toggle("is-idle", !ctx);
    }

    const hint = $("agentHint");
    if (hint) {
      hint.textContent = ctx
        ? "Drag header to reposition · Ctrl+Z undoes scan edits"
        : "Hover controls for tips";
    }

    bindDebriefActions(ctx);
  }

  function bindDebriefActions(ctx) {
    $("agentDebriefDismiss")?.addEventListener("click", () => {
      $("agentPanel")?.classList.add("hidden");
    });
    $("agentDebriefSave")?.addEventListener("click", () => {
      if (!ctx?.scanId || typeof RMChartScan === "undefined") return;
      const scan = RMChartScan.getScanForDebrief(ctx.scanId);
      if (!scan) return;
      const analysis = RMChartScan.analyzeRegion({
        region: scan,
        bars: typeof RMAnalysisChart !== "undefined" ? RMAnalysisChart.state?.bars : [],
        headlines:
          typeof RMAnalysisChart !== "undefined"
            ? RMAnalysisChart.headlinesForChartSymbol?.(scan.symbol)
            : [],
        pctMode: RMAnalysisChart?.state?.metrics?.mode === "pct",
      });
      void RMChartScan.saveResearchToStory(scan, analysis).then(() => {
        const hint = $("agentHint");
        if (hint) hint.textContent = "Saved to today's trade story.";
        const saveBtn = $("agentDebriefSave");
        if (saveBtn) {
          saveBtn.textContent = "Saved";
          saveBtn.disabled = true;
        }
      });
    });
  }

  function bindHoverTips() {
    document.body.addEventListener(
      "mouseover",
      (e) => {
        if (debriefContext) return;
        const t = e.target.closest(Object.keys(TIPS).join(","));
        if (!t) return;
        const sel = Object.keys(TIPS).find((k) => t.matches(k));
        if (sel) {
          const hint = $("agentHint");
          if (hint) hint.textContent = TIPS[sel];
        }
      },
      { passive: true }
    );
  }

  function openPanel() {
    const panel = $("agentPanel");
    if (!panel) return;
    panel.classList.remove("hidden");
    applyPanelPos(panel);
  }

  function togglePanel() {
    $("agentPanel")?.classList.toggle("hidden");
  }

  function mount() {
    if ($("agentPanel")) return;

    const panel = document.createElement("aside");
    panel.id = "agentPanel";
    panel.className = "agent-panel hidden is-idle";
    panel.innerHTML =
      '<header class="agent-head" title="Drag to move">' +
      '<div class="agent-head-main">' +
      '<span class="agent-live-dot" aria-hidden="true"></span>' +
      '<div class="agent-head-text">' +
      '<strong class="agent-head-title">Research</strong>' +
      '<span class="agent-hint-line" id="agentHint">Hover controls for tips</span>' +
      "</div></div>" +
      '<button type="button" class="agent-close side-drawer-close" id="agentClose" aria-label="Close">×</button>' +
      "</header>" +
      '<div class="agent-body" id="agentLog"></div>';

    document.body.appendChild(panel);
    renderDebrief(null);
    bindPanelDrag(panel);
    applyPanelPos(panel);

    const trigger = $("btnBrandGuide") || document.querySelector(".brand-guide-trigger");
    if (trigger) {
      trigger.addEventListener("dblclick", (e) => {
        e.preventDefault();
        togglePanel();
      });
    }

    $("agentClose").onclick = () => panel.classList.add("hidden");
    bindHoverTips();
    document.addEventListener("rm:debrief", (e) => {
      if (e.detail) {
        renderDebrief(e.detail);
        openPanel();
      }
    });

    window.addEventListener(
      "resize",
      () => {
        if (panel.classList.contains("hidden") || panel.dataset.userPos !== "1") return;
        const r = panel.getBoundingClientRect();
        const next = clampPanelPos(panel, r.left, r.top);
        panel.style.left = next.left + "px";
        panel.style.top = next.top + "px";
        savePanelPos(panel);
      },
      { passive: true }
    );
  }

  global.RMAgent = {
    mount,
    renderDebrief,
    togglePanel,
    openPanel,
    getDebriefContext: () => debriefContext,
  };
})(typeof window !== "undefined" ? window : globalThis);

