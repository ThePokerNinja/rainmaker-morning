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
