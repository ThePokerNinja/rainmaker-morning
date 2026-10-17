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
