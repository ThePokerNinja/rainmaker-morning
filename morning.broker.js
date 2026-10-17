/* --- schwab_data.js --- */
/**
 * Schwab data integration — fills, round trips, chart markers, Results merge.
 * Read-only broker truth loop (Phase 1–3 of Schwab data plan).
 */
(function (global) {
  "use strict";

  const SYNC_META_KEY = "rainmaker_schwab_sync_v1";
  const MARKER_PREFIX = "schwab-";
  const RECENT_DEBRIEF_DAYS = 7;

  function apiBase() {
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveBrokerApiBase) {
      return global.RMMorningApi.resolveBrokerApiBase();
    }
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta && meta.content && meta.content.trim()) {
        return meta.content.trim().replace(/\/$/, "");
      }
      const stored = global.localStorage && global.localStorage.getItem("rainmaker_api_base");
      if (stored) return stored.replace(/\/$/, "");
    } catch (e) {}
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return "https://rainmaker-api-waqs.onrender.com";
    }
    return "";
  }

  function todayPt() {
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.todayPt) {
      return global.RMMorningApi.todayPt();
    }
    try {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  const REAL_JOURNAL_KEY = "rainmaker_real_journal_cutover_v1";

  /** Drop pre-Schwab paper journal rows from localStorage (one-time). */
  function applyRealJournalCutover() {
    try {
      if (global.localStorage.getItem(REAL_JOURNAL_KEY) === "done") return;
    } catch (e) {
      return;
    }
    const today = todayPt();
    const key = tradesStorageKey();
    let trades = [];
    try {
      trades = JSON.parse(global.localStorage.getItem(key) || "[]");
    } catch (e) {
      trades = [];
    }
    const kept = trades.filter(function (t) {
      if (!t) return false;
      if (t.source === "schwab_api") return true;
      if (t.status === "open") {
        const opened = String(t.opened_at || "").slice(0, 10);
        return opened >= today;
      }
      const closed = String(t.closed_at || t.opened_at || "").slice(0, 10);
      return closed >= today;
    });
    try {
      global.localStorage.setItem(key, JSON.stringify(kept));
      global.localStorage.removeItem("rainmaker_chart_trades_v1");
      global.localStorage.setItem(REAL_JOURNAL_KEY, "done");
    } catch (e) {}
  }

  function isRealSchwabFill(fill) {
    if (!fill) return false;
    if (fill.source === "schwab_api") return true;
    const day = String(fill.exec_time || "").slice(0, 10);
    return day >= todayPt();
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

  function tradesStorageKey() {
    return "rainmaker_ytd_" + new Date().getFullYear();
  }

  function loadLocalTrades() {
    try {
      return JSON.parse(global.localStorage.getItem(tradesStorageKey()) || "[]");
    } catch (e) {
      return [];
    }
  }

  function loadSyncMeta() {
    try {
      return JSON.parse(global.localStorage.getItem(SYNC_META_KEY) || "null") || {};
    } catch (e) {
      return {};
    }
  }

  function saveSyncMeta(meta) {
    try {
      global.localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
    } catch (e) {}
  }

  function dateKey(iso) {
    return String(iso || "").slice(0, 10);
  }

  function dedupeKey(trade) {
    const sym = String(trade.symbol || "").toUpperCase();
    const qty = trade.quantity ?? trade.qty ?? 0;
    const entry = trade.entry_price ?? trade.entry ?? 0;
    const closed = dateKey(trade.closed_at || trade.exit_time || trade.opened_at);
    return sym + "|" + closed + "|" + qty + "|" + Math.round(Number(entry) * 100);
  }

  async function fetchJson(path, opts) {
    const base = apiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + path, {
        ...(opts || {}),
        headers: { ...authHeaders(), ...(opts && opts.headers ? opts.headers : {}) },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function fetchDataStatus() {
    return fetchJson("/schwab/data-status");
  }

  async function fetchFills(symbol) {
    const q = symbol ? "?symbol=" + encodeURIComponent(symbol) + "&limit=2000" : "?limit=2000";
    const body = await fetchJson("/trade/fills" + q);
    return (body && body.fills) || [];
  }

  async function fetchRoundTrips(symbol) {
    const q = symbol ? "?symbol=" + encodeURIComponent(symbol) : "";
    const body = await fetchJson("/trade/round-trips" + q);
    return (body && body.roundTrips) || [];
  }

  function fillsById(fills) {
    const map = {};
    (fills || []).forEach(function (f) {
      if (f && f.id) map[f.id] = f;
    });
    return map;
  }

  function matchLocalPlan(schwabTrade, localTrades) {
    const sym = String(schwabTrade.symbol || "").toUpperCase();
    const closedDay = dateKey(schwabTrade.closed_at);
    const candidates = (localTrades || []).filter(function (t) {
      return (
        t &&
        String(t.symbol || "").toUpperCase() === sym &&
        t.status === "closed" &&
        dateKey(t.closed_at) === closedDay
      );
    });
    if (!candidates.length) return schwabTrade;
    const local = candidates[0];
    const merged = { ...schwabTrade };
    if (local.stop_price != null) merged.stop_price = local.stop_price;
    if (local.target_price != null) merged.target_price = local.target_price;
    if (local.session_id) merged.session_id = local.session_id;
    if (local.plan_r != null) merged.plan_r = local.plan_r;
    else if (typeof global.RMTradeMetrics !== "undefined") {
      const pr = global.RMTradeMetrics.planR(local);
      if (pr != null) merged.plan_r = pr;
    }
    merged.realized_r = schwabTrade.r_multiple;
    if (typeof global.RMTradeMetrics !== "undefined") {
      return global.RMTradeMetrics.applyDualTrack(merged, {
        execution_channel: "schwab",
      });
    }
    merged.reconcile_status =
      merged.plan_r != null &&
      merged.realized_r != null &&
      Math.abs(merged.plan_r - merged.realized_r) < 0.05
        ? "agreed"
        : "delta";
    return merged;
  }

  function isOptionSymbol(symbol) {
    if (global.RMHoldings?.isOptionSymbol) {
      return global.RMHoldings.isOptionSymbol(symbol);
    }
    return /\d{6}[CP]\d{8}/.test(String(symbol || "").replace(/\s+/g, ""));
  }

  function roundTripToTrade(rt, entryFill, exitFill) {
    const option =
      isOptionSymbol(rt.symbol) ||
      String(entryFill?.asset_class || "").toLowerCase() === "option";
    const contractMult = option ? 100 : 1;
    const trade = {
      id: MARKER_PREFIX + String(entryFill && entryFill.id) + "-" + String(exitFill && exitFill.id),
      symbol: rt.symbol,
      instrument: option ? "option" : "stock",
      status: "closed",
      source: "schwab_api",
      execution_channel: "schwab",
      planned: false,
      filled: true,
      reconciled: true,
      entry_price: rt.entry,
      exit_price: rt.exit,
      quantity: rt.qty,
      opened_at: (entryFill && entryFill.exec_time) || null,
      closed_at: (exitFill && exitFill.exec_time) || null,
      r_multiple: rt.r_multiple,
      realized_r: rt.r_multiple,
      pnl_usd:
        Math.round((rt.exit - rt.entry) * rt.qty * contractMult * 100) / 100,
    };
    return matchLocalPlan(trade, loadLocalTrades());
  }

  function buildClosedTrades(roundTrips, fills) {
    const byId = fillsById(fills);
    const sorted = (fills || [])
      .slice()
      .sort(function (a, b) {
        return String(a.exec_time || "").localeCompare(String(b.exec_time || ""));
      });
    const out = [];
    (roundTrips || []).forEach(function (rt) {
      const symFills = sorted.filter(function (f) {
        return String(f.symbol || "").toUpperCase() === String(rt.symbol || "").toUpperCase();
      });
      let entryFill = null;
      let exitFill = null;
      for (let i = symFills.length - 1; i >= 0; i--) {
        const f = symFills[i];
        if (String(f.side || "").toUpperCase() === "SELL" && Math.abs(Number(f.price) - rt.exit) < 0.02) {
          exitFill = f;
          break;
        }
      }
      for (let i = 0; i < symFills.length; i++) {
        const f = symFills[i];
        if (String(f.side || "").toUpperCase() === "BUY" && Math.abs(Number(f.price) - rt.entry) < 0.02) {
          entryFill = f;
          break;
        }
      }
      if (!entryFill && symFills.length) {
        entryFill = symFills.find(function (f) {
          return String(f.side || "").toUpperCase() === "BUY";
        });
      }
      if (!exitFill && symFills.length) {
        exitFill = symFills
          .slice()
          .reverse()
          .find(function (f) {
            return String(f.side || "").toUpperCase() === "SELL";
          });
      }
      out.push(roundTripToTrade(rt, entryFill || byId[rt.entryFillId], exitFill));
    });
    return out;
  }

  function fillsFromToday(fills) {
    const today = todayPt();
    return (fills || []).filter(function (f) {
      return String(f.exec_time || "").slice(0, 10) >= today;
    });
  }

  function closedTradesFromToday(trades) {
    const today = todayPt();
    return (trades || []).filter(function (t) {
      return String(t.closed_at || "").slice(0, 10) >= today;
    });
  }

  function closedTradesYtd(trades) {
    const y = String(new Date().getFullYear());
    return (trades || []).filter(function (t) {
      return String(t.closed_at || t.opened_at || "").slice(0, 4) === y;
    });
  }

  function isRecentSchwabClose(trade) {
    if (!trade || trade.source !== "schwab_api") return false;
    const closed = Date.parse(trade.closed_at || trade.opened_at || "");
    if (!Number.isFinite(closed)) return false;
    return closed >= Date.now() - RECENT_DEBRIEF_DAYS * 86400000;
  }

  function chartSymbolForPosition(pos) {
    const raw = String(pos?.symbol || "").trim().toUpperCase();
    if (!raw) return "";
    if (typeof global.RMHoldings !== "undefined") {
      if (global.RMHoldings.isOptionSymbol?.(raw)) {
        return global.RMHoldings.parseOptionUnderlying(raw) || raw;
      }
    }
    return raw;
  }

  function mergeClosedTrades(localTrades, schwabTrades) {
    const today = todayPt();
    const local = (localTrades || []).filter(function (t) {
      if (!t || t.source === "schwab_api") return false;
      if (t.status !== "closed") return false;
      const closed = String(t.closed_at || t.opened_at || "").slice(0, 10);
      return closed >= today;
    });
    const schwab = closedTradesYtd(schwabTrades);
    const localKeys = {};
    local
      .filter(function (t) {
        return t.status === "closed";
      })
      .forEach(function (t) {
        localKeys[dedupeKey(t)] = true;
      });
    const mergedSchwab = schwab.filter(function (t) {
      return !localKeys[dedupeKey(t)];
    });
    return local.concat(mergedSchwab);
  }

  function getMergedClosedTrades(localTrades, schwabTrades) {
    return mergeClosedTrades(localTrades, schwabTrades).filter(function (t) {
      return t.status === "closed" && t.filled !== false;
    });
  }

  function getAllTradesForJournal(localTrades, schwabTrades) {
    const today = todayPt();
    const open = (localTrades || []).filter(function (t) {
      if (t.status !== "open") return false;
      const opened = String(t.opened_at || "").slice(0, 10);
      return opened >= today;
    });
    const closed = getMergedClosedTrades(localTrades, schwabTrades);
    return open.concat(closed);
  }

  function execTimeMs(iso) {
    const ms = Date.parse(iso || "");
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function syncAllFillMarkers(fills) {
    if (typeof global.RMAnalysisChart === "undefined" || !global.RMAnalysisChart.saveTradeMarker) {
      return 0;
    }
    let n = 0;
    (fills || []).forEach(function (fill) {
      const rawSym = String(fill.symbol || "").trim().toUpperCase();
      if (!rawSym) return;
      const chartSym = chartSymbolForPosition({ symbol: rawSym });
      if (!chartSym) return;
      const side = String(fill.side || "").toUpperCase();
      const px = Number(fill.price);
      if (!Number.isFinite(px)) return;
      const t = execTimeMs(fill.exec_time);
      const id = MARKER_PREFIX + "fill-" + String(fill.id || rawSym + "-" + t + "-" + px);
      const instrumentLabel = rawSym !== chartSym ? rawSym : null;
      if (side === "BUY") {
        global.RMAnalysisChart.saveTradeMarker({
          id: id,
          symbol: chartSym,
          entry_price: px,
          exit_price: null,
          t: t,
          session_id: null,
          filled: true,
          source: "schwab_fill",
          label: instrumentLabel,
        });
        n++;
        return;
      }
      if (side === "SELL") {
        global.RMAnalysisChart.saveTradeMarker({
          id: id,
          symbol: chartSym,
          entry_price: null,
          exit_price: px,
          t: t,
          exit_t: t,
          closed_at: fill.exec_time || new Date(t).toISOString(),
          session_id: null,
          filled: true,
          source: "schwab_fill",
          label: instrumentLabel,
        });
        n++;
      }
    });
    if (n && typeof global.RMAnalysisChart.refreshTradeOverlay === "function") {
      global.RMAnalysisChart.refreshTradeOverlay();
    }
    return n;
  }

  function syncChartMarkers(roundTrips, fills) {
    if (typeof global.RMAnalysisChart === "undefined" || !global.RMAnalysisChart.saveTradeMarker) {
      return 0;
    }
    const byId = fillsById(fills);
    let n = 0;
    (roundTrips || []).forEach(function (rt) {
      const sym = String(rt.symbol || "").trim().toUpperCase();
      if (!sym) return;
      const chartSym = chartSymbolForPosition({ symbol: sym });
      if (!chartSym) return;
      const instrumentLabel = chartSym !== sym ? sym : null;
      const symFills = (fills || []).filter(function (f) {
        return String(f.symbol || "").trim().toUpperCase() === sym;
      });
      const entryFill = symFills.find(function (f) {
        return String(f.side || "").toUpperCase() === "BUY" && Math.abs(Number(f.price) - rt.entry) < 0.02;
      });
      const exitFill = symFills
        .slice()
        .reverse()
        .find(function (f) {
          return String(f.side || "").toUpperCase() === "SELL" && Math.abs(Number(f.price) - rt.exit) < 0.02;
        });
      const markerId = MARKER_PREFIX + sym + "-" + String((entryFill && entryFill.id) || rt.entry);
      global.RMAnalysisChart.saveTradeMarker({
        id: markerId,
        symbol: chartSym,
        entry_price: rt.entry,
        exit_price: rt.exit,
        stop_price: null,
        target_price: null,
        t: execTimeMs(entryFill && entryFill.exec_time),
        exit_t: execTimeMs(exitFill && exitFill.exec_time),
        closed_at: (exitFill && exitFill.exec_time) || new Date().toISOString(),
        session_id: null,
        filled: true,
        source: "schwab_api",
        label: instrumentLabel,
      });
      n++;
    });
    if (typeof global.RMAnalysisChart.refreshTradeOverlay === "function") {
      global.RMAnalysisChart.refreshTradeOverlay();
    }
    return n;
  }

  let cachedSchwabTrades = [];
  let cachedAt = 0;
  let lastRoundTrips = [];
  let lastFills = [];

  function notifyChartMarkersUpdated() {
    if (typeof global.RMAnalysisChart?.refreshTradeOverlay === "function") {
      global.RMAnalysisChart.refreshTradeOverlay();
    }
    document.dispatchEvent(new CustomEvent("rm:chart-markers-updated"));
  }

  function applyCachedChartMarkers() {
    if (!lastRoundTrips.length && !lastFills.length) return 0;
    const n = syncChartMarkers(lastRoundTrips, lastFills) + syncAllFillMarkers(lastFills);
    if (n) notifyChartMarkersUpdated();
    return n;
  }

  async function refreshSchwabTrades(force) {
    if (!force && cachedAt && Date.now() - cachedAt < 30000 && cachedSchwabTrades.length) {
      applyCachedChartMarkers();
      return cachedSchwabTrades;
    }
    const [roundTrips, fills] = await Promise.all([fetchRoundTrips(), fetchFills()]);
    if (!roundTrips.length && !fills.length) {
      return cachedSchwabTrades;
    }
    lastRoundTrips = roundTrips;
    lastFills = fills;
    cachedSchwabTrades = closedTradesYtd(buildClosedTrades(roundTrips, fills));
    cachedAt = Date.now();
    syncChartMarkers(roundTrips, fills);
    syncAllFillMarkers(fills);
    notifyChartMarkersUpdated();
    return cachedSchwabTrades;
  }

  async function onSyncComplete(result) {
    const meta = {
      at: result && result.syncedAt ? result.syncedAt * 1000 : Date.now(),
      inserted: (result && result.inserted) || 0,
      fills: (result && result.fills) || 0,
    };
    saveSyncMeta(meta);
    const [roundTrips, fills] = await Promise.all([fetchRoundTrips(), fetchFills()]);
    cachedSchwabTrades = closedTradesYtd(buildClosedTrades(roundTrips, fills));
    cachedAt = Date.now();
    lastRoundTrips = roundTrips;
    lastFills = fills;
    syncChartMarkers(roundTrips, fills);
    syncAllFillMarkers(fills);
    notifyChartMarkersUpdated();
    document.dispatchEvent(
      new CustomEvent("rm:schwab-synced", {
        detail: { result: result, roundTrips: roundTrips, fills: fills, trades: cachedSchwabTrades },
      })
    );
    return meta;
  }

  function formatSyncMeta() {
    const meta = loadSyncMeta();
    if (!meta.at) return "";
    const when = new Date(meta.at).toLocaleString();
    const fills = meta.fills != null ? meta.fills + " fill(s) in store" : "";
    const ins =
      meta.inserted != null && meta.inserted > 0 ? meta.inserted + " new this sync" : "up to date";
    return "Last sync " + when + " · " + fills + " · " + ins;
  }

  function accountSymbols(positions) {
    const set = {};
    (positions || []).forEach(function (p) {
      const sym = String(p.symbol || "").toUpperCase();
      if (sym && Math.abs(Number(p.qty) || 0) > 0) set[sym] = true;
    });
    return set;
  }

  function formatBarsSource(src) {
    if (!src || src === "none") return "Yahoo";
    if (src === "cache") return "Cached";
    if (src === "yahoo") return "Yahoo";
    if (src === "schwab") return "Schwab";
    return String(src);
  }

  global.RMSchwabData = {
    apiBase,
    authHeaders,
    fetchDataStatus,
    fetchFills,
    fetchRoundTrips,
    buildClosedTrades,
    roundTripToTrade,
    mergeClosedTrades,
    getMergedClosedTrades,
    getAllTradesForJournal,
    refreshSchwabTrades,
    applyCachedChartMarkers,
    onSyncComplete,
    syncChartMarkers,
    syncAllFillMarkers,
    chartSymbolForPosition,
    isRecentSchwabClose,
    formatSyncMeta,
    loadSyncMeta,
    accountSymbols,
    formatBarsSource,
    applyRealJournalCutover,
    todayPt,
    getCachedSchwabTrades: function () {
      return cachedSchwabTrades.slice();
    },
  };
})(typeof window !== "undefined" ? window : this);

;
/* --- schwab.js --- */
/* Schwab broker connection client (Schwab roadmap Phase A+).
 * Read-only: connect via OAuth popup, show status, sync fills, list positions,
 * balances, optional market-hours poll. Talks only to rm_api. */
(function (global) {
  "use strict";

  const POLL_KEY = "rainmaker_schwab_poll_v1";
  const POLL_MS = 60000;
  let pollTimer = null;
  let lastKnownFillCount = null;
  let brokerApiBase = null;

  async function ensureApiBase() {
    if (brokerApiBase) return brokerApiBase;
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.probeBrokerApiBase) {
      brokerApiBase = await global.RMMorningApi.probeBrokerApiBase();
    } else {
      const h = (typeof location !== "undefined" && location.hostname) || "";
      brokerApiBase =
        h === "localhost" || h === "127.0.0.1"
          ? "https://rainmaker-api-waqs.onrender.com"
          : "";
    }
    return brokerApiBase;
  }

  function apiBase() {
    if (brokerApiBase) return brokerApiBase;
    if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveBrokerApiBase) {
      return global.RMMorningApi.resolveBrokerApiBase();
    }
    return "";
  }

  function brokerApiLabel() {
    const base = apiBase();
    if (!base) return "";
    if (base.indexOf("127.0.0.1") >= 0 || base.indexOf("localhost") >= 0) return "local API";
    return "Rainmaker cloud";
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try {
      if (typeof global.RMAuthGate !== "undefined" && global.RMAuthGate.authHeaders) {
        Object.assign(headers, global.RMAuthGate.authHeaders() || {});
      }
    } catch (e) {}
    return headers;
  }

  function hasSession() {
    try {
      return !!(global.RMAuthGate?.getToken?.() && global.RMAuthGate.getToken());
    } catch (e) {
      return false;
    }
  }

  function promptSignIn() {
    const statusEl = el("schwabStatus");
    if (statusEl) {
      statusEl.textContent = "Session expired — refresh the page to sign in.";
    }
  }

  async function getStatus() {
    const base = await ensureApiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/schwab/status", { headers: authHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function connect() {
    if (!hasSession()) {
      promptSignIn();
      const statusEl = el("schwabStatus");
      if (statusEl) {
        statusEl.textContent = "Sign in first, then connect Schwab.";
      }
      return;
    }
    const base = await ensureApiBase();
    if (!base) return;
    try {
      const res = await fetch(base + "/schwab/authorize-url", { headers: authHeaders() });
      if (!res.ok) {
        const statusEl = el("schwabStatus");
        if (statusEl) {
          statusEl.textContent =
            res.status === 401
              ? "Sign in first, then connect Schwab."
              : "Could not start Schwab login (" + res.status + ").";
        }
        if (res.status === 401) promptSignIn();
        return;
      }
      const body = await res.json();
      if (!body || !body.url) return;
      const w = global.open(body.url, "schwab_oauth", "width=520,height=720");
      const timer = global.setInterval(function () {
        if (w && w.closed) {
          global.clearInterval(timer);
          render().then(function () {
            return autoSyncIfConnected();
          });
        }
      }, 1200);
    } catch (e) {
      const statusEl = el("schwabStatus");
      if (statusEl) statusEl.textContent = "Server unreachable.";
    }
  }

  async function sync(days) {
    const base = await ensureApiBase();
    if (!base) return null;
    try {
      const res = await fetch(base + "/schwab/sync?days=" + (days || 90), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) return null;
      const body = await res.json();
      if (body && typeof global.RMSchwabData !== "undefined") {
        await global.RMSchwabData.onSyncComplete(body);
      }
      if (typeof global.RMResearch !== "undefined" && global.RMResearch.run) {
        global.RMResearch.run(true);
      }
      return body;
    } catch (e) {
      return null;
    }
  }

  async function positions() {
    const base = await ensureApiBase();
    if (!base) return [];
    try {
      const res = await fetch(base + "/schwab/positions", { headers: authHeaders() });
      if (!res.ok) return [];
      const body = await res.json();
      return (body && body.positions) || [];
    } catch (e) {
      return [];
    }
  }

  async function balances() {
    const base = await ensureApiBase();
    if (!base) return [];
    try {
      const res = await fetch(base + "/schwab/balances", { headers: authHeaders() });
      if (!res.ok) return [];
      const body = await res.json();
      return (body && body.balances) || [];
    } catch (e) {
      return [];
    }
  }

  async function disconnect() {
    const base = await ensureApiBase();
    if (!base) return;
    try {
      await fetch(base + "/schwab/disconnect", { method: "POST", headers: authHeaders() });
    } catch (e) {}
    stopPoll();
    render();
  }

  function el(id) {
    return document.getElementById(id);
  }

  function isPollEnabled() {
    try {
      return global.localStorage.getItem(POLL_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setPollEnabled(on) {
    try {
      global.localStorage.setItem(POLL_KEY, on ? "1" : "0");
    } catch (e) {}
    if (on) startPoll();
    else stopPoll();
  }

  function isMarketHoursEt() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find(function (p) {
      return p.type === "weekday";
    });
    if (weekday && (weekday.value === "Sat" || weekday.value === "Sun")) return false;
    const hour = Number(parts.find(function (p) {
      return p.type === "hour";
    })?.value || 0);
    const minute = Number(parts.find(function (p) {
      return p.type === "minute";
    })?.value || 0);
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  }

  function notifyNewFill(count) {
    const msg = count === 1 ? "New Schwab fill synced" : count + " new Schwab fills synced";
    if (typeof global.rmStatus === "function") {
      global.rmStatus(msg);
    } else {
      document.dispatchEvent(new CustomEvent("rm:toast", { detail: { message: msg } }));
    }
  }

  function shouldPollRun() {
    if (!isPollEnabled()) return false;
    if (document.visibilityState === "hidden") return false;
    if (typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()) {
      const key = global.RMWorkspaceAccordion?.getActiveKey?.();
      if (key !== "scans") return false;
    }
    return true;
  }

  function syncPollState() {
    if (shouldPollRun()) startPoll();
    else stopPoll();
  }

  function startPoll() {
    if (pollTimer || !shouldPollRun()) return;
    pollTimer = global.setInterval(async function () {
      if (!isMarketHoursEt()) return;
      const status = await getStatus();
      if (!status || !status.connected || status.needsReconnect) return;
      const before = lastKnownFillCount;
      const r = await sync(7);
      if (r && r.inserted > 0) {
        notifyNewFill(r.inserted);
      }
      if (before != null && r && r.fills > before && !(r.inserted > 0)) {
        /* fills grew without insert count — still refresh UI */
      }
      if (r) lastKnownFillCount = r.fills;
    }, POLL_MS);
  }

  function stopPoll() {
    if (pollTimer) {
      global.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function autoSyncIfConnected() {
    const status = await getStatus();
    if (!status || !status.connected || status.needsReconnect) return null;
    return sync(90);
  }

  function renderBalances(list) {
    const wrap = el("schwabBalances");
    if (!wrap) return;
    if (!list || !list.length) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = list
      .map(function (b) {
        const bp = b.buyingPower != null ? "$" + Number(b.buyingPower).toFixed(0) : "—";
        const cash = b.cashBalance != null ? "$" + Number(b.cashBalance).toFixed(0) : "—";
        const acct = b.account ? " …" + String(b.account).slice(-4) : "";
        return (
          '<div class="rm-schwab-bal">' +
          "<span>Buying power" +
          acct +
          "</span><strong>" +
          bp +
          "</strong>" +
          '<span class="meta">Cash ' +
          cash +
          "</span></div>"
        );
      })
      .join("");
  }

  function renderLastSync(status) {
    const syncEl = el("schwabLastSync");
    if (!syncEl) return;
    let line =
      typeof global.RMSchwabData !== "undefined" ? global.RMSchwabData.formatSyncMeta() : "";
    if (status && status.fillCount != null) {
      line = (line ? line + " · " : "") + status.fillCount + " fill(s) on server";
    }
    syncEl.textContent = line || "";
  }

  function publishSchwabState(status) {
    const connected = !!(status?.connected && !status?.needsReconnect);
    if (typeof global.RMResultsHero !== "undefined" && global.RMResultsHero.updateSchwabStatus) {
      global.RMResultsHero.updateSchwabStatus(connected);
    }
    return connected;
  }

  async function bootstrapDashboard() {
    await ensureApiBase();
    if (!apiBase()) return null;
    const status = await getStatus();
    if (!status) {
      publishSchwabState(null);
      return null;
    }
    const connected = publishSchwabState(status);
    if (!connected) return status;
    const pos = await positions();
    const cached =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.getBrokerPositions
        ? global.RMHoldings.getBrokerPositions()
        : [];
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.setBrokerPositions) {
      if (pos.length || !cached.length) {
        global.RMHoldings.setBrokerPositions(pos);
      }
    }
    document.dispatchEvent(new CustomEvent("rm:schwab-positions", { detail: { positions: pos } }));
    return status;
  }

  async function render() {
    const section = el("drawerSchwab");
    if (!section) return;
    section.hidden = false;
    const statusEl = el("schwabStatus");
    const connectBtn = el("schwabConnect");
    const syncBtn = el("schwabSync");
    const disconnectBtn = el("schwabDisconnect");
    const posWrap = el("schwabPositions");
    const pollCb = el("schwabPoll");
    if (pollCb) pollCb.checked = isPollEnabled();

    await ensureApiBase();
    if (!apiBase()) {
      if (statusEl) {
        statusEl.textContent = "Broker API unreachable.";
      }
      if (connectBtn) connectBtn.disabled = true;
      return;
    }

    if (!hasSession()) {
      publishSchwabState(null);
      if (statusEl) {
        statusEl.textContent = "Not signed in — refresh the page to sign in.";
      }
      if (connectBtn) {
        connectBtn.hidden = false;
        connectBtn.disabled = true;
        connectBtn.textContent = "Connect Schwab";
      }
      if (syncBtn) syncBtn.hidden = true;
      if (disconnectBtn) disconnectBtn.hidden = true;
      if (posWrap) posWrap.innerHTML = '<p class="meta">Refresh to sign in, then connect Schwab.</p>';
      renderBalances([]);
      renderLastSync(null);
      stopPoll();
      return;
    }

    const status = await getStatus();
    if (!status) {
      publishSchwabState(null);
      if (statusEl) statusEl.textContent = "Server unreachable (" + brokerApiLabel() + ").";
      if (connectBtn) connectBtn.disabled = true;
      return;
    }
    if (!status.configured) {
      if (statusEl) {
        statusEl.textContent =
          "Schwab keys missing on this API host. Local review uses Rainmaker cloud — refresh the page.";
      }
      if (connectBtn) connectBtn.disabled = true;
      return;
    }
    const cloudHint =
      brokerApiLabel() === "Rainmaker cloud" ? " · via Rainmaker cloud" : "";
    if (status.needsReconnect || !status.connected) {
      publishSchwabState(status);
      if (statusEl) {
        statusEl.textContent =
          (status.connected ? "Reconnect required." : "Not connected.") + cloudHint;
      }
      if (connectBtn) {
        connectBtn.hidden = false;
        connectBtn.disabled = false;
        connectBtn.textContent = status.connected ? "Reconnect Schwab" : "Connect Schwab";
      }
      if (syncBtn) syncBtn.hidden = true;
      if (disconnectBtn) disconnectBtn.hidden = !status.connected;
      if (posWrap) posWrap.innerHTML = "";
      renderBalances([]);
      renderLastSync(status);
      stopPoll();
      return;
    }
    publishSchwabState(status);
    if (statusEl) {
      statusEl.textContent =
        "Connected" +
        (status.accessTokenValid ? "" : " (refreshing)") +
        cloudHint +
        ".";
    }
    if (connectBtn) connectBtn.hidden = true;
    if (syncBtn) syncBtn.hidden = false;
    if (disconnectBtn) disconnectBtn.hidden = false;
    lastKnownFillCount = status.fillCount != null ? status.fillCount : lastKnownFillCount;

    const pos = await positions();
    const cached =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.getBrokerPositions
        ? global.RMHoldings.getBrokerPositions()
        : [];
    const displayPos = pos.length ? pos : cached;
    renderPositions(displayPos);
    renderBalances(await balances());
    renderLastSync(status);

    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.setBrokerPositions) {
      if (pos.length || !cached.length) {
        global.RMHoldings.setBrokerPositions(pos);
      }
    }
    if (typeof global.renderDrawerHoldings === "function") {
      global.renderDrawerHoldings();
    }
    document.dispatchEvent(new CustomEvent("rm:schwab-positions", { detail: { positions: pos } }));

    if (isPollEnabled()) startPoll();
  }

  function renderPositions(list) {
    const posWrap = el("schwabPositions");
    if (!posWrap) return;
    if (!list || !list.length) {
      posWrap.innerHTML = '<p class="meta">No open positions.</p>';
      return;
    }
    const rows = list
      .filter(function (p) {
        return p.symbol && Math.abs(Number(p.qty) || 0) > 0;
      })
      .map(function (p) {
        const qty = Number(p.qty) || 0;
        const avg = p.avgPrice != null ? " @ $" + Number(p.avgPrice).toFixed(2) : "";
        const mv = p.marketValue != null ? " · $" + Number(p.marketValue).toFixed(0) : "";
        const symEsc = String(p.symbol).replace(/"/g, "&quot;");
        return (
          '<button type="button" class="rm-schwab-pos rm-schwab-pos--click" data-schwab-symbol="' +
          symEsc +
          '" title="View on chart">' +
          "<span>" +
          p.symbol +
          avg +
          "</span><span>" +
          qty +
          " sh" +
          mv +
          "</span></button>"
        );
      })
      .join("");
    posWrap.innerHTML = rows || '<p class="meta">No open positions.</p>';
    let posClickBusy = false;
    posWrap.querySelectorAll(".rm-schwab-pos--click").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (posClickBusy) return;
        const sym = btn.getAttribute("data-schwab-symbol");
        if (!sym) return;
        posClickBusy = true;
        const holdings = global.RMHoldings?.getDisplayOpen?.() || [];
        const h =
          holdings.find(function (row) {
            return String(row.symbol).toUpperCase() === String(sym).toUpperCase();
          }) || null;
        const done = function () {
          setTimeout(function () {
            posClickBusy = false;
          }, 700);
        };
        if (h && typeof global.openHoldingOnChart === "function") {
          Promise.resolve(global.openHoldingOnChart(h)).finally(done);
        } else if (typeof global.selectTicker === "function") {
          global.selectTicker(sym, { snapChart: true, openDrawer: false });
          done();
        } else {
          done();
        }
      });
    });
  }

  function wire() {
    const connectBtn = el("schwabConnect");
    const syncBtn = el("schwabSync");
    const disconnectBtn = el("schwabDisconnect");
    const pollCb = el("schwabPoll");
    if (connectBtn) connectBtn.addEventListener("click", connect);
    if (syncBtn) {
      syncBtn.addEventListener("click", async function () {
        syncBtn.disabled = true;
        const r = await sync(90);
        syncBtn.disabled = false;
        const statusEl = el("schwabStatus");
        if (statusEl && r) {
          statusEl.textContent = "Synced " + (r.inserted || 0) + " new fill(s).";
        }
        await render();
      });
    }
    if (disconnectBtn) disconnectBtn.addEventListener("click", disconnect);
    if (pollCb) {
      pollCb.addEventListener("change", function () {
        setPollEnabled(pollCb.checked);
      });
    }
    document.addEventListener("rm:workspace-row", syncPollState);
    document.addEventListener("visibilitychange", syncPollState);
    document.addEventListener("rm:schwab-synced", function () {
      if (typeof global.renderResultsClosedTrades === "function") {
        global.renderResultsClosedTrades();
      }
      renderLastSync();
    });
    ensureApiBase()
      .then(function () {
        return render();
      })
      .then(function () {
        return autoSyncIfConnected();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  global.RMSchwab = {
    getStatus: getStatus,
    connect: connect,
    sync: sync,
    positions: positions,
    balances: balances,
    disconnect: disconnect,
    render: render,
    bootstrapDashboard: bootstrapDashboard,
    autoSyncIfConnected: autoSyncIfConnected,
    syncPollState: syncPollState,
    get _pollTimer() {
      return pollTimer;
    },
  };
})(typeof window !== "undefined" ? window : this);

