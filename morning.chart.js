/* --- chart_hub.js --- */
/** SPY comparison chart + scan overlays — rendering delegated to RMAnalysisChart. */
(function (global) {
  const SYM_COLORS = [
    "#4eb8c9",
    "#2db8a8",
    "#d4a24a",
    "#8b7fd4",
    "#5ba8c9",
    "#e8954f",
    "#6bc4b8",
  ];
  const SWEEP_MS = 1100;
  const KEEP_MS = 550;
  const CHART_LIVE_RTH_MS = 60000;
  const CHART_LIVE_EXT_MS = 60000;
  const CHART_LIVE_TICK_MS = 60000;
  const BARS_WARM_CACHE_KEY = "rm_chart_bars_v1";
  const BARS_WARM_CACHE_MS = 4 * 60 * 1000;
  const BARS_WARM_CACHE_MAX = 8;

  const state = {
    interval: "5m",
    range: "1d",
    overlays: new Map(),
    newsBySym: new Map(),
    spyPct: [],
    candidateSeries: null,
    metrics: null,
    container: null,
    scanActive: false,
    candidateSym: null,
    scanningSym: null,
    spyLoadError: null,
    resizeBound: false,
    animLock: Promise.resolve(),
    sessionPicks: [],
    sessionMeta: null,
    marketSession: "unknown",
    barMeta: {},
    spyBars: [],
    livePoll: null,
    lastLiveRefreshAt: 0,
    liveRefreshing: false,
    lastDataAt: 0,
    headerPoll: null,
    lastGood: null,
    dataStale: false,
    /** Keep morning-open X window after news scan until user pans/zooms. */
    morningScanViewLock: false,
  };

  function $(id) {
    const root = state.container;
    if (root) {
      const scoped = root.querySelector("#" + id);
      if (scoped) return scoped;
    }
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function fvTip(kicker, title, desc, stat) {
    if (typeof RMUiTips === "undefined") return "";
    return RMUiTips.fvTipData(kicker, title, desc, stat);
  }

  function fmtPct(v) {
    const n = Number(v);
    if (Number.isNaN(n)) return "";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function colorFor(sym, list) {
    const i = list.indexOf(sym);
    return SYM_COLORS[(i >= 0 ? i : 0) % SYM_COLORS.length];
  }

  function chartPerfColors() {
    let bull = "#2db8a8";
    let bear = "#e8954f";
    let bullStrong = "#1a9e92";
    let bearStrong = "#d46a3a";
    let neutral = "#7a9aa6";
    try {
      const root = getComputedStyle(document.documentElement);
      const pick = (name, fb) => root.getPropertyValue(name).trim() || fb;
      bull = pick("--chart-candle-up", pick("--bull", bull));
      bear = pick("--chart-candle-down", pick("--bear", bear));
      bullStrong = pick("--bull-strong", bullStrong);
      bearStrong = pick("--bear-strong", bearStrong);
      neutral = pick("--chart-neutral", neutral);
    } catch (_) {
      /* pre-DOM */
    }
    return { bull, bear, bullStrong, bearStrong, neutral };
  }

  function colorForPerformance(pct) {
    const c = chartPerfColors();
    const n = Number(pct);
    if (!Number.isFinite(n)) return c.neutral;
    if (n >= 2) return c.bullStrong;
    if (n >= 0.5) return c.bull;
    if (n <= -2) return c.bearStrong;
    if (n <= -0.5) return c.bear;
    return c.neutral;
  }

  function colorForOverlay(sym, series, pick) {
    const last = series?.[series.length - 1]?.pct;
    if (last != null && Number.isFinite(last)) return colorForPerformance(last);
    const scanPct = pick?.pct_change;
    if (scanPct != null && Number.isFinite(Number(scanPct))) {
      return colorForPerformance(Number(scanPct));
    }
    return colorFor(sym, [...state.overlays.keys(), sym]);
  }

  function nyTradingDayKey() {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
      }).format(new Date());
    } catch {
      return "";
    }
  }

  function barsCacheKey(symbol, interval, range) {
    const day = nyTradingDayKey();
    return symbol + "|" + interval + "|" + range + (day ? "|" + day : "");
  }

  function barsFetchSource(symbol, opts) {
    if (opts?.source) return opts.source;
    if (String(symbol || "").toUpperCase() === "SPY") return "yahoo";
    return "auto";
  }

  function barSessionDayEt(ms) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
      }).format(new Date(ms));
    } catch {
      return "";
    }
  }

  function priorTradingDayEt(dayKey) {
    const d = new Date(dayKey + "T12:00:00Z");
    if (!Number.isFinite(d.getTime())) return dayKey;
    d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return d.toISOString().slice(0, 10);
  }

  function nyMarketMinutesNow() {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(new Date());
      const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
      const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
      return h * 60 + m;
    } catch {
      return 12 * 60;
    }
  }

  function intradayBarsStale(bars, range) {
    const rg = String(range || "1d").toLowerCase();
    if (rg !== "1d" && rg !== "5d") return false;
    if (!bars?.length) return true;
    const lastMs = bars[bars.length - 1]?.t;
    if (!lastMs) return true;
    const lastDay = barSessionDayEt(lastMs);
    const today = nyTradingDayKey();
    if (!lastDay || !today) return false;
    if (nyMarketMinutesNow() < 9 * 60 + 30) {
      return lastDay < priorTradingDayEt(today);
    }
    return lastDay < today;
  }

  function readBarsWarmCache(key) {
    try {
      const raw =
        typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem(BARS_WARM_CACHE_KEY);
      if (!raw) return null;
      const store = JSON.parse(raw);
      const entry = store?.[key];
      if (!entry?.bars?.length || !entry.at) return null;
      if (Date.now() - entry.at > BARS_WARM_CACHE_MS) return null;
      const parts = String(key).split("|");
      const rg = parts[2] || "1d";
      if (intradayBarsStale(entry.bars, rg)) return null;
      return entry.bars;
    } catch {
      return null;
    }
  }

  function writeBarsWarmCache(key, bars) {
    if (!bars?.length) return;
    try {
      const raw =
        typeof sessionStorage !== "undefined" &&
        sessionStorage.getItem(BARS_WARM_CACHE_KEY);
      const store = raw ? JSON.parse(raw) : {};
      store[key] = { bars, at: Date.now() };
      const keys = Object.keys(store);
      if (keys.length > BARS_WARM_CACHE_MAX) {
        keys.sort((a, b) => (store[a]?.at || 0) - (store[b]?.at || 0));
        for (let i = 0; i < keys.length - BARS_WARM_CACHE_MAX; i++) {
          delete store[keys[i]];
        }
      }
      sessionStorage.setItem(BARS_WARM_CACHE_KEY, JSON.stringify(store));
    } catch {
      /* quota / private mode */
    }
  }

  function applyFetchedBars(symbol, interval, range, bars, meta, barsSource) {
    const key = barsCacheKey(symbol, interval, range);
    if (!state.cache) state.cache = {};
    state.cache[key] = bars;
    writeBarsWarmCache(key, bars);
    if (meta) {
      if (!state.barMeta) state.barMeta = {};
      state.barMeta[String(symbol || "").toUpperCase()] = meta;
      if (meta.periods?.regular?.startMs) {
        state.sessionMeta = meta;
        state.marketSession = meta.marketState || state.marketSession;
      }
    }
    if (barsSource) {
      state.barsSource = barsSource;
      updateBarsSourceBadge(barsSource);
    }
    if (String(symbol || "").toUpperCase() === "SPY") {
      state.spyBars = bars;
    }
  }

  async function fetchBars(symbol, interval, range, opts) {
    const iv = interval || state.interval;
    const rg = range || state.range;
    const key = barsCacheKey(symbol, iv, rg);
    const source = barsFetchSource(symbol, opts);
    if (!state.cache) state.cache = {};
    if (!opts?.bustCache && state.cache[key]) {
      if (!intradayBarsStale(state.cache[key], rg)) {
        return state.cache[key];
      }
      delete state.cache[key];
    }
    if (!opts?.bustCache) {
      const warm = readBarsWarmCache(key);
      if (warm?.length) {
        applyFetchedBars(symbol, iv, rg, warm, null, null);
        return warm;
      }
    }
    let payload = null;
    if (typeof RMYahooFetch !== "undefined") {
      const apiOnly =
        opts?.apiOnly === true ||
        (typeof global !== "undefined" && global.__rmChartBootApiOnly);
      payload = await RMYahooFetch.fetchChartBars(symbol, iv, rg, {
        includePrePost: opts?.includePrePost !== false,
        apiOnly,
        source,
      });
    }
    let bars = payload?.bars || payload;
    let meta = payload?.meta || null;
    let barsSource = payload?.source || meta?.source || null;
    const barsFromProvider = barsSource || source;
    if (
      bars?.length &&
      intradayBarsStale(bars, rg) &&
      barsFromProvider !== "yahoo" &&
      !opts?.bustCache
    ) {
      payload = await RMYahooFetch.fetchChartBars(symbol, iv, rg, {
        includePrePost: opts?.includePrePost !== false,
        apiOnly:
          opts?.apiOnly === true ||
          (typeof global !== "undefined" && global.__rmChartBootApiOnly),
        source: "yahoo",
      });
      bars = payload?.bars || payload;
      meta = payload?.meta || null;
      barsSource = payload?.source || meta?.source || "yahoo";
    }
    if (bars?.length && intradayBarsStale(bars, rg)) {
      applyFetchedBars(symbol, iv, rg, bars, meta, barsSource);
      setChartStale(true);
      return bars;
    }
    if (bars) {
      applyFetchedBars(symbol, iv, rg, bars, meta, barsSource);
    }
    return bars;
  }

  function getSessionFromClock() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date());
    const weekday = parts.find((p) => p.type === "weekday")?.value || "";
    if (weekday === "Sat" || weekday === "Sun") return "closed";
    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    const mins = hour * 60 + minute;
    if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
    if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
    if (mins >= 16 * 60 && mins < 20 * 60) return "post";
    return "closed";
  }

  function currentMarketSession() {
    return state.marketSession && state.marketSession !== "unknown"
      ? state.marketSession
      : getSessionFromClock();
  }

  function liveChartRefreshMs(session) {
    if (session === "regular") return CHART_LIVE_RTH_MS;
    if (session === "pre" || session === "post") return CHART_LIVE_EXT_MS;
    return 0;
  }

  function shouldLiveRefreshChart() {
    if (state.scanActive || document.hidden || state.liveRefreshing) return false;
    return liveChartRefreshMs(currentMarketSession()) > 0;
  }

  function updateChartSessionHint() {
    const session = currentMarketSession();
    const compare =
      typeof RMAnalysisChart !== "undefined" &&
      RMAnalysisChart.state?.symbol === RMAnalysisChart.COMPARE_SYM;
    // "Compare SPY + picks" only once at least one pick overlay exists;
    // otherwise it's just the SPY baseline.
    const hasPicks = (state.overlays && state.overlays.size > 0) || !!state.candidateSeries;
    const mode = compare && hasPicks ? "Compare SPY + picks" : "SPY";
    // Session/interval info is merged into the panel submeta line; the live
    // pill (#chartHeadLive) already conveys the session state itself.
    const infoEl = document.getElementById("chartHeadInfo");
    if (infoEl) {
      infoEl.textContent = "· " + mode + " · " + state.interval + " · Pre · Open · After";
    }
    updateChartHeader(session);
    document.dispatchEvent(
      new CustomEvent("rm:market-session", { detail: { session } })
    );
  }

  function formatHeaderDate() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      month: "numeric",
      day: "numeric",
      year: "2-digit",
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return get("month") + "." + get("day") + "." + get("year");
  }

  function formatHeaderTime() {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date()) + " PT";
  }

  function updateChartHeader(session) {
    const sess = session || currentMarketSession();
    const dateEl = document.getElementById("chartHeadDate");
    if (dateEl) dateEl.textContent = formatHeaderDate() + " · " + formatHeaderTime();
    const liveEl = document.getElementById("chartHeadLive");
    if (!liveEl) return;
    const map = {
      regular: { state: "live", text: "live" },
      pre: { state: "ext", text: "pre" },
      post: { state: "ext", text: "after" },
      closed: { state: "closed", text: "closed" },
    };
    const info = map[sess] || map.closed;
    liveEl.dataset.state = info.state;
    const txt = liveEl.querySelector(".ws-panel-live-text");
    if (txt) txt.textContent = info.text;
    if (state.barsSource) updateBarsSourceBadge(state.barsSource);
  }

  function updateBarsSourceBadge(src) {
    const el = document.getElementById("chartHeadBarsSource");
    if (!el) return;
    const label =
      typeof RMSchwabData !== "undefined" && RMSchwabData.formatBarsSource
        ? RMSchwabData.formatBarsSource(src)
        : src === "schwab"
          ? "Schwab"
          : src === "yahoo"
            ? "Yahoo"
            : src || "";
    if (!label || label === "none") {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = "Bars · " + label;
    el.dataset.source = src || "";
  }

  function startHeaderClock() {
    if (state.headerPoll) return;
    updateChartHeader();
    // Tick the date/time live (seconds-resolution wall clock, PT).
    state.headerPoll = setInterval(() => updateChartHeader(), 1000);
  }

  function stopHeaderClock() {
    if (state.headerPoll) {
      clearInterval(state.headerPoll);
      state.headerPoll = null;
    }
  }

  let resizePaintTimer = null;

  function onChartWindowResize() {
    clearTimeout(resizePaintTimer);
    resizePaintTimer = setTimeout(() => {
      resizePaintTimer = null;
      renderChartView();
    }, 150);
  }

  function normalizePctSeries(bars) {
    if (!bars?.length) return [];
    const base = bars[0].close;
    if (!base) return [];
    return bars.map((b) => ({
      t: b.t,
      pct: ((b.close - base) / base) * 100,
    }));
  }

  function alignToSpy(spySeries, symSeries) {
    if (!spySeries.length || !symSeries.length) return [];
    const out = [];
    let j = 0;
    for (const s of spySeries) {
      while (j < symSeries.length - 1 && symSeries[j + 1].t <= s.t) j++;
      const pt = symSeries[j];
      if (Math.abs(pt.t - s.t) < 3600000) out.push({ t: s.t, pct: pt.pct });
    }
    return out;
  }

  function overlayTipMeta(sym) {
    if (sym === "SPY") {
      const last = state.spyPct[state.spyPct.length - 1];
      return {
        kicker: "Benchmark",
        title: "SPY",
        desc: "S&P 500 ETF rebased to 0% at day open (includes pre/post when available). Pick overlays share this time axis.",
        stat: last != null ? fmtPct(last.pct) + " vs open" : "",
      };
    }
    const o = state.overlays.get(sym);
    const last = o?.series?.[o.series.length - 1];
    const headlines = headlinesFromCatalyst(state.newsBySym.get(sym));
    let desc = "Validated on the unified chart after news scan.";
    if (headlines.length) {
      const top = String(headlines[0].title || "").trim();
      if (top) desc = "Top headline: " + (top.length > 120 ? top.slice(0, 119) + "…" : top);
    }
    return {
      kicker: "Chart overlay",
      title: sym,
      desc,
      stat: last != null ? fmtPct(last.pct) + " vs open" : "",
    };
  }

  function legendHtml() {
    const syms = ["SPY", ...state.overlays.keys()];
    const stageStat =
      state.overlays.size + " validated · " + state.interval + " · " + state.range;
    return (
      '<div class="chart-hub-legend" id="chartHubLegend">' +
      syms
        .map((s) => {
          const col = s === "SPY" ? "#8b9cb3" : colorFor(s, [...state.overlays.keys()]);
          const meta = overlayTipMeta(s);
          return (
            '<span class="chart-hub-legend-item fv-tip-target" tabindex="0"' +
            fvTip(meta.kicker, meta.title, meta.desc, meta.stat) +
            '><i style="background:' + col + '"></i>' + escapeHtml(s) + "</span>"
          );
        })
        .join("") +
      '<span class="chart-hub-scan-status fv-tip-target" id="chartScanStatus" tabindex="0"' +
      fvTip(
        "Scan progress",
        "News validation",
        "Live status while picks are checked against recent headlines. Validated symbols stay on the chart.",
        stageStat
      ) +
      "></span></div>"
    );
  }

  function bindChartTips(root) {
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(root || state.container);
    (root || state.container)?.querySelectorAll(".chart-hub-legend-item").forEach((el) => {
      if (el.dataset.tfBound || el.textContent.trim() === "SPY") return;
      el.dataset.tfBound = "1";
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        const sym = el.textContent.trim().split(/\s/)[0];
        if (sym && sym !== "SPY") {
          document.dispatchEvent(
            new CustomEvent("rm:select-ticker", { detail: { symbol: sym } })
          );
        }
      });
    });
  }

  function updateLegend() {
    const wrap = state.container?.querySelector(".chart-hub-legend-wrap");
    const status = $("chartScanStatus")?.textContent || "";
    if (wrap) {
      wrap.innerHTML = legendHtml();
      setScanStatus(status);
      bindChartTips(wrap);
    }
  }

  function setChartLoading(on) {
    const el = $("chLoadingMsg");
    if (el) el.hidden = !on;
  }

  function setChartStale(on) {
    state.dataStale = !!on;
    const el = $("chStaleChip");
    if (el) el.hidden = !on;
  }

  function fmtClock(ms) {
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(ms));
    } catch {
      return "";
    }
  }

  function setChartError(msg) {
    const el = $("chEmptyMsg");
    if (!el) return;
    if (msg) {
      setChartStale(false);
      let html = '<span class="ch-empty-text">' + escapeHtml(msg) + "</span>";
      if (state.lastDataAt) {
        html +=
          '<span class="ch-empty-stale">Last good data ' +
          escapeHtml(fmtClock(state.lastDataAt)) +
          " PT</span>";
      }
      html += '<button type="button" class="ch-empty-retry" id="chRetryBtn">Retry</button>';
      el.innerHTML = html;
      el.hidden = false;
      const btn = el.querySelector("#chRetryBtn");
      if (btn) {
        btn.onclick = () => {
          setChartError(null);
          setChartLoading(true);
          reloadChart(state.container)
            .catch(() => {})
            .finally(() => setChartLoading(false));
        };
      }
    } else {
      el.innerHTML = "";
      el.hidden = true;
    }
  }

  async function renderChartView(opts) {
    if (!state.spyPct.length && state.spyBars?.length) {
      state.spyPct = normalizePctSeries(state.spyBars);
    }
    updateLegend();
    updateChartSessionHint();
    if (typeof RMAnalysisChart !== "undefined") {
      await RMAnalysisChart.render(global.RMChartHub, {
        preserveView: opts?.preserveView !== false,
        syncHub: opts?.syncHub !== false,
        fit: opts?.fit === true,
        resetView: opts?.resetView === true,
      });
    }
  }

  async function refreshChartDataLive() {
    if (!shouldLiveRefreshChart() || !state.container) return;
    const session = currentMarketSession();
    const minGap = liveChartRefreshMs(session);
    const now = Date.now();
    if (state.lastLiveRefreshAt && now - state.lastLiveRefreshAt < minGap - 1000) return;
    state.liveRefreshing = true;
    try {
      const iv = state.interval;
      const rg = state.range;
      // Incremental: refresh only the symbols currently on the live view, busting
      // just their cache keys instead of wiping the whole cache and rebuilding
      // every overlay. Unrelated cached series (other intervals / analysis tickers)
      // and overlay metadata (color, news) are preserved, which avoids flicker.
      const freshSpy = await fetchBars("SPY", iv, rg, {
        bustCache: true,
        skipWorkspaceLoader: true,
      });
      if (freshSpy?.length) {
        state.spyBars = freshSpy;
        state.spyPct = normalizePctSeries(freshSpy);
        state.lastGood = {
          spyPct: state.spyPct,
          spyBars: state.spyBars,
          at: Date.now(),
          interval: iv,
          range: rg,
        };
        if (state.dataStale) setChartStale(false);
      }
      for (const [sym, o] of [...state.overlays.entries()]) {
        const bars = await fetchBars(sym, iv, rg, { bustCache: true });
        const series = alignToSpy(state.spyPct, normalizePctSeries(bars));
        if (series.length) {
          const col = colorForOverlay(sym, series, null) || o.color;
          state.overlays.set(sym, { series, color: col });
        }
      }
      if (state.candidateSym) {
        const cbars = await fetchBars(state.candidateSym, iv, rg, { bustCache: true });
        state.candidateSeries = alignToSpy(state.spyPct, normalizePctSeries(cbars));
      }
      state.lastDataAt = Date.now();
      state.lastLiveRefreshAt = Date.now();
      await renderChartView();
    } finally {
      state.liveRefreshing = false;
    }
  }

  function startLiveChartRefresh(container) {
    stopLiveChartRefresh();
    if (container) ensureChartShell(container, { deferLoad: true });
    startHeaderClock();
    state.livePoll = setInterval(() => {
      updateChartHeader();
      refreshChartDataLive().catch(() => {});
    }, CHART_LIVE_TICK_MS);
  }

  function stopLiveChartRefresh() {
    if (state.livePoll) {
      clearInterval(state.livePoll);
      state.livePoll = null;
    }
    stopHeaderClock();
  }

  async function ensureSpyLoaded(opts) {
    if (state.spyPct.length) return state.spyPct;
    state.spyLoadError = null;
    setChartError(null);

    const stage = state.container?.querySelector(".chart-hub-stage");
    let overlay = null;
    const ws = global.RMWorkspaceLoad;
    const useWorkspaceLoader =
      !opts?.skipWorkspaceLoader &&
      !state.scanActive &&
      ws &&
      typeof ws.mountMiniLoader === "function" &&
      stage;

    if (useWorkspaceLoader) {
      overlay = document.createElement("div");
      overlay.className = "ch-stage-fetch-loader";
      stage.appendChild(overlay);
      ws.mountMiniLoader(overlay, "Shape of Data", "Loading SPY baseline…");
    } else {
      setChartLoading(true);
    }

    const bars = await fetchBars("SPY", state.interval, state.range);

    if (overlay) {
      ws.revealSlot(overlay);
      overlay.remove();
    } else {
      setChartLoading(false);
    }

    if (!bars?.length) {
      // Transient fetch failure: if we still hold a good series for the SAME
      // interval/range, keep showing it (flagged stale) instead of blanking the
      // chart with a hard error. Only fall back to the error when there is no
      // usable prior data for the current view.
      const lg = state.lastGood;
      if (
        lg &&
        lg.interval === state.interval &&
        lg.range === state.range &&
        lg.spyPct?.length &&
        !intradayBarsStale(lg.spyBars || [], state.range)
      ) {
        state.spyPct = lg.spyPct;
        state.spyBars = lg.spyBars || [];
        state.lastDataAt = lg.at || state.lastDataAt;
        state.spyLoadError = null;
        setChartError(null);
        setChartStale(true);
        return state.spyPct;
      }
      state.spyPct = [];
      state.spyLoadError =
        "Could not load chart data (market data API offline or stale). Refresh, or check rm_api on Render.";
      setChartStale(false);
      setChartError(state.spyLoadError);
      return state.spyPct;
    }
    state.spyPct = normalizePctSeries(bars);
    state.lastDataAt = Date.now();
    state.lastGood = {
      spyPct: state.spyPct,
      spyBars: state.spyBars,
      at: state.lastDataAt,
      interval: state.interval,
      range: state.range,
    };
    state.spyLoadError = null;
    setChartStale(false);
    setChartError(null);
    return state.spyPct;
  }

  function setScanStatus(text) {
    const el = $("chartScanStatus");
    if (el) el.textContent = text || "";
  }

  function pickHasNews(p) {
    const c = p?.catalyst || {};
    return !!(c.verified || (c.headlines && c.headlines.length) || c.headline);
  }

  /** Session picks without headlines still get overlay lines (e.g. published CSV). */
  function pickEligibleForOverlay(p) {
    const sym = String(p?.symbol || "").toUpperCase();
    return !!sym && sym !== "SPY";
  }

  function headlinesFromCatalyst(cat) {
    if (!cat) return [];
    if (cat.headlines && cat.headlines.length) return cat.headlines;
    if (cat.headline) return [{ title: cat.headline, url: cat.source_url || null }];
    return [];
  }

  function setSymbolNews(sym, catalyst) {
    const key = String(sym || "").toUpperCase();
    if (!key) return;
    state.newsBySym.set(key, catalyst || {});
  }

  function setScanningSymbol(sym) {
    state.scanningSym = sym ? String(sym).toUpperCase() : null;
  }

  async function loadOverlaySeries(sym) {
    await ensureSpyLoaded({ skipWorkspaceLoader: true });
    const bars = await fetchBars(sym, state.interval, state.range);
    const pct = normalizePctSeries(bars);
    return alignToSpy(state.spyPct, pct);
  }

  async function addOverlay(sym, color, catalyst, pick) {
    const key = String(sym || "").toUpperCase();
    if (!key || state.overlays.has(key)) return;
    const series = await loadOverlaySeries(key);
    if (!series.length) return;
    const col = color || colorForOverlay(key, series, pick);
    state.overlays.set(key, { series, color: col });
    if (catalyst) setSymbolNews(key, catalyst);
    const compareView =
      typeof RMAnalysisChart !== "undefined" &&
      RMAnalysisChart.state?.symbol === RMAnalysisChart.COMPARE_SYM;
    const shouldFit = state.scanActive || compareView;
    const preserveX =
      state.scanActive ||
      (typeof RMAnalysisChart !== "undefined" &&
        RMAnalysisChart.isMorningScanView?.(global.RMChartHub));
    await renderChartView({ fit: shouldFit, preserveView: preserveX || !shouldFit });
    // #8: the left→right sweep should fire on a real ticker-add, not just
    // candidate previews — gives every approved pick a visible scan beat.
    if (typeof RMAnalysisChart !== "undefined") RMAnalysisChart.fireBeam();
    document.dispatchEvent(
      new CustomEvent("rm:ticker-added", { detail: { symbol: key } })
    );
  }

  function queueAnim(fn) {
    state.animLock = state.animLock.then(fn, fn);
    return state.animLock;
  }

  async function reloadChart(container, opts) {
    if (container) state.container = container;
    state.cache = {};
    state.spyPct = [];
    state.spyBars = [];
    state.candidateSeries = null;
    state.candidateSym = null;
    const kept = [...state.overlays.entries()];
    const news = new Map(state.newsBySym);
    state.overlays.clear();
    await ensureSpyLoaded();
    for (const [sym, o] of kept) {
      const series = await loadOverlaySeries(sym);
      if (series.length) state.overlays.set(sym, { series, color: o.color });
    }
    state.newsBySym = news;
    await renderChartView({
      resetView: opts?.resetView === true,
      preserveView: opts?.resetView === true ? false : opts?.preserveView !== false,
    });
  }

  async function reloadOverlaysFromSession() {
    const picks = state.sessionPicks || [];
    state.overlays.clear();
    state.newsBySym.clear();
    await ensureSpyLoaded();
    for (const p of picks.filter(pickEligibleForOverlay)) {
      const sym = String(p.symbol || "").toUpperCase();
      if (sym) await addOverlay(sym, null, p.catalyst, p);
    }
    await renderChartView();
  }

  async function preloadSessionOverlays(picks) {
    if (state.scanActive) return;
    state.sessionPicks = picks || [];
    await ensureSpyLoaded({ skipWorkspaceLoader: true });
    for (const p of (picks || []).filter(pickEligibleForOverlay)) {
      const sym = String(p.symbol || "").toUpperCase();
      if (!sym || state.overlays.has(sym)) continue;
      try {
        await addOverlay(sym, null, p.catalyst, p);
      } catch {
        /* skip failed symbol */
      }
    }
  }

  function isMobileChartRow() {
    return (
      global.matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-snap-chart")
    );
  }

  function syncMobileChartChrome() {
    const fsBtn = document.getElementById("btnChartFullscreen");
    const settingsBtn = document.getElementById("btnChartSettings");
    const toggles = document.querySelector("#workspaceChart .ca-toggles");
    const yAxis = document.getElementById("caYAxis");
    const actions = document.querySelector("#workspaceChart .ws-panel-head-actions");
    if (!fsBtn) return;
    const inline = isMobileChartRow() && !!toggles;
    if (inline) {
      const anchor = yAxis || toggles.firstElementChild;
      if (fsBtn.parentElement !== toggles) {
        toggles.insertBefore(fsBtn, anchor);
      } else if (anchor && fsBtn.nextElementSibling !== anchor) {
        toggles.insertBefore(fsBtn, anchor);
      }
      fsBtn.classList.add("ca-chart-fs-toolbar");
      fsBtn.classList.remove("ca-chart-fs-overlay");
      if (settingsBtn) settingsBtn.hidden = true;
    } else {
      if (actions && fsBtn.parentElement !== actions) actions.appendChild(fsBtn);
      fsBtn.classList.remove("ca-chart-fs-toolbar", "ca-chart-fs-overlay");
      if (settingsBtn) settingsBtn.hidden = false;
    }
  }

  function stageShellHtml() {
    return (
      '<div class="ca-chart-fs-slot" id="caChartFsSlot" aria-hidden="true"></div>' +
      '<p class="ch-empty-msg" id="chEmptyMsg" hidden></p>' +
      '<p class="ch-loading-msg ch-loading-msg--draw" id="chLoadingMsg" hidden>' +
      '<span class="ch-loading-kicker">Drawing</span> <span class="ch-loading-sym">…</span></p>' +
      '<div class="ch-stale-chip" id="chStaleChip" hidden>Live data delayed · showing last good</div>' +
      '<div class="ch-scan-beam" id="chScanBeam" hidden></div>'
    );
  }

  function chartPanel(container) {
    return container || document.getElementById("chartHubView");
  }

  function consolidateChartPanel(panel) {
    if (!panel) return null;
    let uni =
      panel.querySelector("#chartHubUnified") ||
      panel.querySelector(":scope > .chart-hub-unified");
    panel.querySelectorAll(".chart-hub-unified").forEach((node) => {
      if (node !== uni) node.remove();
    });
    panel.querySelectorAll(":scope > .chart-hub-mount").forEach((node) => node.remove());
    panel.querySelectorAll(":scope > .ws-load-slot").forEach((node) => node.remove());
    if (!uni) {
      uni = document.createElement("div");
      uni.className = "chart-hub-unified";
      uni.id = "chartHubUnified";
      panel.appendChild(uni);
    } else if (uni.parentElement !== panel) {
      panel.prepend(uni);
    }
    Array.from(panel.children).forEach((child) => {
      if (child !== uni && !child.classList.contains("ws-col-loader")) {
        child.remove();
      }
    });
    return uni;
  }

  function unifiedShellMarkup() {
    // #8: the legend wrap was removed (it crowded the column head — the
    // "smashed in" look). Scan status now lives in the column submeta
    // (#chartScanStatus) and validated symbols read off the chart overlays.
    return (
      '<div class="ca-toolbar-wrap"></div>' +
      '<div class="chart-hub-main">' +
      '<div class="chart-hub-stage ca-analysis-stage">' +
      stageShellHtml() +
      "</div></div>"
    );
  }

  function ensureChartShell(container, opts) {
    const panel = chartPanel(container);
    const uni = consolidateChartPanel(panel);
    if (!uni) return null;
    state.container = uni;
    const needsBuild = opts?.force || !uni.querySelector(".chart-hub-stage");
    if (needsBuild) {
      uni.innerHTML = unifiedShellMarkup();
      if (typeof RMAnalysisChart !== "undefined") {
        RMAnalysisChart.mount(uni, global.RMChartHub, {
          deferLoad: !!opts?.deferLoad,
        });
      }
      bindChartTips(uni);
      startHeaderClock();
      syncMobileChartChrome();
      if (!state.resizeBound) {
        window.addEventListener("resize", onChartWindowResize);
        state.resizeBound = true;
      }
    } else if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.container = uni;
      RMAnalysisChart.state.hub = global.RMChartHub;
    }
    return uni;
  }

  async function mountStage(container) {
    ensureChartShell(container, { force: true });
    await ensureSpyLoaded();
    await renderChartView();
  }

  async function renderComparisonProgressive(container, loadSlot) {
    if (state.scanActive) return;
    const panel = chartPanel(container);
    if (!loadSlot || typeof loadSlot !== "function") {
      await renderComparison(panel);
      return;
    }
    const ws = global.RMWorkspaceLoad;
    ws?.updateColumnLoader?.("chart", "Shape of Data · loading SPY…", 28);
    ensureChartShell(panel, { deferLoad: true });
    await ensureSpyLoaded({ skipWorkspaceLoader: true });
    ws?.updateColumnLoader?.("chart", "Shape of Data · rendering…", 82);
    if (typeof RMAnalysisChart !== "undefined" && !state.scanActive) {
      RMAnalysisChart.state.symbol = "SPY";
    }
    await renderChartView();
    const msg = panel.querySelector("#chLoadingMsg");
    if (msg) msg.hidden = true;
  }

  async function renderComparison(container, opts) {
    if (state.scanActive) return;
    ensureChartShell(chartPanel(container));
    await ensureSpyLoaded();
    await renderChartView({
      fit: opts?.fit === true,
      preserveView: opts?.fit !== true,
    });
  }

  async function syncFromSession(picks, opts) {
    if (state.scanActive) return;
    if (state.container) ensureChartShell(state.container);
    state.sessionPicks = picks || [];
    const list = (picks || []).filter(pickEligibleForOverlay);
    for (const p of list) {
      const sym = String(p.symbol || "").toUpperCase();
      if (!sym) continue;
      if (state.overlays.has(sym)) {
        setSymbolNews(sym, p.catalyst);
        const o = state.overlays.get(sym);
        if (o?.series?.length) {
          const col = colorForOverlay(sym, o.series, p);
          state.overlays.set(sym, { series: o.series, color: col });
        }
        continue;
      }
      await addOverlay(sym, null, p.catalyst, p);
    }
    if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
      if (RMAnalysisChart.syncToolbarFromHub) {
        RMAnalysisChart.syncToolbarFromHub();
      }
    }
    const preserveView = opts?.preserveView === true;
    const fit = opts?.fit !== false && !state.morningScanViewLock;
    await renderChartView({ fit, preserveView });
  }

  function openFullscreenModalFallback(sourceContainer) {
    let modal = document.getElementById("chartFullscreenModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "chartFullscreenModal";
      modal.className = "chart-fullscreen hidden";
      modal.innerHTML =
        '<div class="chart-fullscreen-inner">' +
        '<header class="chart-fullscreen-head"><h2>Chart</h2>' +
        '<button type="button" class="side-drawer-close" id="btnCloseChartFs" aria-label="Close">×</button></header>' +
        '<div id="chartFullscreenBody"></div></div>';
      document.body.appendChild(modal);
      document.getElementById("btnCloseChartFs").onclick = () => modal.classList.add("hidden");
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.classList.add("hidden");
      });
    }
    modal.classList.remove("hidden");
    const body = document.getElementById("chartFullscreenBody");
    if (body && sourceContainer) {
      body.innerHTML = sourceContainer.innerHTML;
      bindChartTips(body);
      const uni = body.querySelector(".chart-hub-unified") || body;
      if (typeof RMAnalysisChart !== "undefined") {
        const hub = global.RMChartHub;
        RMAnalysisChart.mount(uni, hub, { deferLoad: true });
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            RMAnalysisChart.refresh(uni, hub);
          });
        });
      }
    }
  }

  function openFullscreen(sourceContainer) {
    const panel = document.getElementById("workspaceChart");
    if (!panel) {
      openFullscreenModalFallback(sourceContainer);
      return;
    }
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl === panel) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    const onFsChange = () => {
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (active !== panel) {
        panel.classList.remove("ws-panel--chart-fs");
        document.removeEventListener("fullscreenchange", onFsChange);
        document.removeEventListener("webkitfullscreenchange", onFsChange);
        if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refresh) {
          requestAnimationFrame(() => {
            RMAnalysisChart.refresh(panel.querySelector(".chart-hub-unified"), global.RMChartHub);
          });
        }
      }
    };
    panel.classList.add("ws-panel--chart-fs");
    const req = panel.requestFullscreen || panel.webkitRequestFullscreen;
    if (!req) {
      panel.classList.remove("ws-panel--chart-fs");
      openFullscreenModalFallback(sourceContainer);
      return;
    }
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    req
      .call(panel)
      .then(() => {
        if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refresh) {
          requestAnimationFrame(() => {
            RMAnalysisChart.refresh(panel.querySelector(".chart-hub-unified"), global.RMChartHub);
          });
        }
      })
      .catch(() => {
        panel.classList.remove("ws-panel--chart-fs");
        document.removeEventListener("fullscreenchange", onFsChange);
        document.removeEventListener("webkitfullscreenchange", onFsChange);
        openFullscreenModalFallback(sourceContainer);
      });
  }

  async function prepareScanIntroPan() {
    stopLiveChartRefresh();
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.cancelViewPanAnim) {
      RMAnalysisChart.cancelViewPanAnim();
    }
    state.interval = "5m";
    state.range = "1d";
    consolidateChartPanel(chartPanel());
    ensureChartShell(chartPanel());
    if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
    }
    setChartLoading(true);
    setChartError(null);
    try {
      await ensureSpyLoaded({ skipWorkspaceLoader: true });
    } finally {
      setChartLoading(false);
    }
    if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.hub = global.RMChartHub;
      RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
      if (RMAnalysisChart.syncToolbarFromHub) {
        RMAnalysisChart.syncToolbarFromHub();
      }
      await RMAnalysisChart.render(global.RMChartHub, {
        fit: false,
        preserveView: true,
        syncHub: true,
      });
      if (RMAnalysisChart.animateToMorningOpenForScan) {
        await RMAnalysisChart.animateToMorningOpenForScan(global.RMChartHub, {
          force: true,
          durationMs: 2200,
        });
      }
      state.morningScanViewLock = true;
    }
  }

  async function beginScanSequence(_symbols, opts) {
    if (!opts?.skipIntroPan) {
      await prepareScanIntroPan();
    }
    state.scanActive = true;
    state.cache = {};
    if (!opts?.skipIntroPan) {
      state.spyPct = [];
      state.spyBars = [];
    }
    state.overlays.clear();
    state.newsBySym.clear();
    state.candidateSym = null;
    state.candidateSeries = null;
    state.scanningSym = null;
    if (opts?.skipIntroPan) {
      try {
        await ensureSpyLoaded({ skipWorkspaceLoader: true });
      } catch (_) {
        /* pan path already loaded SPY */
      }
    }
    setScanStatus("News scan · 5m day · compare mode");
  }

  async function previewCandidate(symbol) {
    return queueAnim(async () => {
      const sym = String(symbol || "").toUpperCase();
      state.candidateSym = sym;
      state.candidateSeries = null;
      setScanningSymbol(sym);
      document.dispatchEvent(
        new CustomEvent("rm:scan-ticker", { detail: { symbol: sym } })
      );
      setScanStatus("Scanning " + sym + " · 5m vs SPY");
      const series = await loadOverlaySeries(sym);
      if (!series.length) return;
      state.candidateSeries = series;
      if (typeof RMAnalysisChart !== "undefined") {
        RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
      }
      await renderChartView({ fit: true, preserveView: true });
      if (typeof RMAnalysisChart !== "undefined") RMAnalysisChart.fireBeam();
    });
  }

  function waitMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function dismissCandidate(symbol) {
    return queueAnim(async () => {
      const sym = String(symbol || "").toUpperCase();
      if (state.candidateSym === sym) state.candidateSym = null;
      state.candidateSeries = null;
      setScanningSymbol(null);
      await renderChartView();
    });
  }

  async function resolveCandidate(symbol, keep, meta) {
    return queueAnim(async () => {
      const sym = String(symbol || "").toUpperCase();

      if (keep) {
        await waitMs(KEEP_MS);
        state.candidateSym = null;
        state.candidateSeries = null;
        setScanningSymbol(null);
        await addOverlay(sym, null, meta?.catalyst, meta?.pick);
        setScanStatus(sym + " · news validated · on chart");
        return;
      }

      state.candidateSym = null;
      state.candidateSeries = null;
      setScanningSymbol(null);
      state.newsBySym.delete(sym);
      await renderChartView();
      setScanStatus(sym + " · no recent news · removed");
    });
  }

  async function finishScanSequence() {
    state.morningScanViewLock = true;
    state.scanActive = false;
    state.candidateSym = null;
    state.candidateSeries = null;
    state.scanningSym = null;
    setScanStatus(
      state.overlays.size
        ? state.overlays.size + " tickers on unified 5m chart"
        : "Scan complete"
    );
    if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
      if (RMAnalysisChart.syncToolbarFromHub) {
        RMAnalysisChart.syncToolbarFromHub();
      }
    }
    await renderChartView({ fit: false, preserveView: true });
    if (typeof RMAnalysisChart !== "undefined") {
      if (RMAnalysisChart.prepareScanIntroFromView) {
        RMAnalysisChart.prepareScanIntroFromView(global.RMChartHub);
      }
      if (RMAnalysisChart.ensureMorningScanView) {
        await RMAnalysisChart.ensureMorningScanView(global.RMChartHub);
      }
    }
    if (state.container) startLiveChartRefresh(state.container);
  }

  function addValidatedSymbol(symbol) {
    resolveCandidate(symbol, true);
  }

  function resetOverlays() {
    state.overlays.clear();
    state.newsBySym.clear();
    state.scanActive = false;
    state.morningScanViewLock = false;
    state.scanningSym = null;
    state.candidateSeries = null;
    renderChartView();
  }

  async function renderPickMini(symbol, container) {
    if (!container || !symbol) return;
    container.innerHTML = '<p class="meta">Loading 5m…</p>';
    const bars = await fetchBars(symbol, "5m", "1d");
    if (!container.isConnected) return;
    const pct = normalizePctSeries(bars);
    const w = container.clientWidth || 280;
    const m = computeMiniMetrics(pct, w, 72);
    container.innerHTML =
      '<div class="pick-mini-chart"><svg class="chart-hub-svg" viewBox="0 0 ' + w + ' 72">' +
      '<path fill="none" stroke="#4eb8c9" stroke-width="1.5" d="' + miniPath(pct, m) + '"/></svg></div>';
  }

  function computeMiniMetrics(series, width, height) {
    const w = Math.max(120, width || 280);
    const h = height || 72;
    const pad = { l: 4, r: 4, t: 4, b: 4 };
    let yMin = Infinity;
    let yMax = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const p of series) {
      yMin = Math.min(yMin, p.pct);
      yMax = Math.max(yMax, p.pct);
      tMin = Math.min(tMin, p.t);
      tMax = Math.max(tMax, p.t);
    }
    const py = (yMax - yMin) * 0.1 || 0.5;
    return {
      pad,
      innerW: w - pad.l - pad.r,
      innerH: h - pad.t - pad.b,
      yMin: yMin - py,
      yMax: yMax + py,
      tMin,
      tMax: tMax <= tMin ? tMin + 1 : tMax,
      x: (t) => pad.l + ((t - tMin) / (tMax - tMin)) * (w - pad.l - pad.r),
      y: (v) => pad.t + (h - pad.t - pad.b) - ((v - (yMin - py)) / (yMax - yMin + 2 * py)) * (h - pad.t - pad.b),
    };
  }

  function miniPath(series, m) {
    if (!series.length) return "";
    let d = "M" + m.x(series[0].t) + " " + m.y(series[0].pct);
    for (let i = 1; i < series.length; i++) {
      d += " L" + m.x(series[i].t) + " " + m.y(series[i].pct);
    }
    return d;
  }

  async function addCompareTicker(symbol) {
    const key = String(symbol || "").toUpperCase();
    if (!key || key === "SPY") return false;
    if (state.overlays.has(key)) return true;
    await addOverlay(key);
    return true;
  }

  function getBarMeta(symbol) {
    return state.barMeta?.[String(symbol || "").toUpperCase()] || null;
  }

  function init() {
    const panel = chartPanel();
    if (panel && !state.scanActive) renderComparison(panel);
  }

  global.RMChartHub = {
    init,
    renderComparison,
    renderComparisonProgressive,
    prepareScanIntroPan,
    beginScanSequence,
    previewCandidate,
    dismissCandidate,
    resolveCandidate,
    finishScanSequence,
    syncFromSession,
    preloadSessionOverlays,
    pickEligibleForOverlay,
    setSymbolNews,
    addValidatedSymbol,
    resetOverlays,
    renderPickMini,
    fetchBars,
    addCompareTicker,
    getBarMeta,
    openFullscreen,
    syncMobileChartChrome,
    ensureSpyLoaded,
    reloadChart,
    reloadOverlaysFromSession,
    renderChartView,
    startLiveChartRefresh,
    stopLiveChartRefresh,
    startHeaderClock,
    stopHeaderClock,
    refreshChartDataLive,
    currentMarketSession,
    setChartError,
    state,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- ema_overlay.js --- */
/**
 * EMA practical guide overlay (Phase 8a) - 9 / 21 / 50 / 200 lines on price pane.
 * Config: config/ema_strategy.json (G7-B adaptive 200).
 */
(function (global) {
  const DEFAULT_MA = {
    type: "ema",
    periods: [9, 21, 50, 200],
    show_200_min_bars: 200,
    colors: {
      ema9: "#22c55e",
      ema21: "#eab308",
      ema50: "#3b82f6",
      ema200: "#a855f7",
    },
    hidden_200_chip: "Need longer range for 200 EMA",
  };

  let strategy = null;
  let loadPromise = null;

  function calcEMA(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function loadConfig() {
    if (strategy) return Promise.resolve(strategy);
    if (loadPromise) return loadPromise;
    loadPromise = fetch("config/ema_strategy.json?v=20260601")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        strategy = json || { ma: DEFAULT_MA, version: "2026-06-01" };
        return strategy;
      });
    return loadPromise;
  }

  function getMaConfig() {
    return strategy?.ma || DEFAULT_MA;
  }

  function computeStack(fullBars) {
    if (!fullBars?.length) return null;
    const closes = fullBars.map((b) => b.close);
    if (closes.some((c) => c == null || !Number.isFinite(c))) return null;
    return {
      ema9: calcEMA(closes, 9),
      ema21: calcEMA(closes, 21),
      ema50: calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
      barCount: fullBars.length,
    };
  }

  function seriesForView(fullBars, viewBars, stack) {
    if (!stack || !viewBars?.length) return null;
    const idxByT = new Map(fullBars.map((b, i) => [b.t, i]));
    function pick(key) {
      return viewBars.map((b) => {
        const i = idxByT.get(b.t);
        if (i == null || i < 0) return NaN;
        return stack[key][i];
      });
    }
    return {
      ema9: pick("ema9"),
      ema21: pick("ema21"),
      ema50: pick("ema50"),
      ema200: pick("ema200"),
      barCount: stack.barCount,
    };
  }

  function lineDefs(ma) {
    const colors = ma.colors || DEFAULT_MA.colors;
    return [
      { key: "ema9", label: "EMA 9", color: colors.ema9, width: 1.25 },
      { key: "ema21", label: "EMA 21", color: colors.ema21, width: 1.35 },
      { key: "ema50", label: "EMA 50", color: colors.ema50, width: 1.5 },
      {
        key: "ema200",
        label: "EMA 200",
        color: colors.ema200,
        width: 1.6,
        minBars: ma.show_200_min_bars ?? 200,
      },
    ];
  }

  function includeInMetrics(m, viewSeries, mergeFn) {
    if (!viewSeries || !mergeFn) return m;
    let lo = Infinity;
    let hi = -Infinity;
    for (const def of lineDefs(getMaConfig())) {
      if (def.minBars && viewSeries.barCount < def.minBars) continue;
      const arr = viewSeries[def.key];
      if (!arr) continue;
      for (const v of arr) {
        if (!Number.isFinite(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (!Number.isFinite(lo)) return m;
    return mergeFn(m, lo, hi, 0.06);
  }

  const EMA_DESC = {
    ema9: "Fast trend - short-term momentum",
    ema21: "Swing trend - pullback support/resistance",
    ema50: "Intermediate trend - stage filter",
    ema200: "Long trend - major support/resistance",
  };

  function renderLine(values, bars, m, color, width, title, escapeAttr, svgTitle, trendHint, renderIndPath, defKey) {
    if (!values?.length || !bars?.length) return "";
    let d = "";
    for (let i = 0; i < bars.length; i++) {
      if (!Number.isFinite(values[i])) continue;
      d += (d ? " L" : "M") + m.x(bars[i].t) + " " + m.y(values[i]);
    }
    if (!d) return "";
    const tipTitle =
      title + (trendHint && title.indexOf("EMA 50") >= 0 ? " - " + trendHint : "");
    const desc = EMA_DESC[defKey] || "Exponential moving average";
    if (typeof renderIndPath === "function") {
      return renderIndPath(d, {
        color,
        width: width || 1.3,
        title: tipTitle,
        desc,
        stat: title,
        classExtra: "ca-ema-line-wrap",
      });
    }
    return (
      '<path class="ca-chart-line ca-ema-line" fill="none" stroke="' +
      color +
      '" stroke-width="' +
      (width || 1.3) +
      '" data-ema="' +
      escapeAttr(title) +
      '" d="' +
      d +
      '">' +
      svgTitle(tipTitle) +
      "</path>"
    );
  }

  function render(viewBars, viewSeries, m, helpers) {
    if (!viewBars?.length || !viewSeries || !helpers) return "";
    const ma = getMaConfig();
    const { escapeAttr, svgTitle, trendHint, renderIndPath } = helpers;
    let svg = '<g class="ca-ema-overlay">';
    for (const def of lineDefs(ma)) {
      if (def.minBars && viewSeries.barCount < def.minBars) continue;
      svg += renderLine(
        viewSeries[def.key],
        viewBars,
        m,
        def.color,
        def.width,
        def.label,
        escapeAttr,
        svgTitle,
        trendHint,
        renderIndPath,
        def.key
      );
    }
    return svg + "</g>";
  }

  function hint200Hidden(barCount) {
    const ma = getMaConfig();
    const min = ma.show_200_min_bars ?? 200;
    if (barCount >= min) return "";
    return ma.hidden_200_chip || DEFAULT_MA.hidden_200_chip;
  }

  global.RMEmaOverlay = {
    loadConfig,
    getMaConfig,
    computeStack,
    seriesForView,
    includeInMetrics,
    render,
    hint200Hidden,
    lineDefs,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- ema_signals.js --- */
/**
 * EMA signal engine (Phase 8b) — trend, stack, crosses, pullbacks.
 * Config: config/ema_strategy.json (G7–G12).
 */
(function (global) {
  const DEFAULT = {
    signals: {
      trend_filter: {
        uptrend: "close > ema50 && close > ema200",
        downtrend: "close < ema50 && close < ema200",
      },
      golden_cross: { fast: 9, slow: 21, require_uptrend: true },
      death_cross: { fast: 9, slow: 21, require_downtrend: true },
      pullback: {
        touch_tolerance_pct: 0.15,
        ema_levels: [9, 21],
        confirm_close_above_ema: true,
        swing_lookback_bars: 8,
      },
      tap_enabled: ["golden_cross", "pullback_buy"],
    },
    short_signals: { allow_short_signals: false, death_cross_chart_marker: true },
    primary_action: { default_rr: 2 },
    c2_chips: {
      trend_labels: {
        uptrend: "EMA: Uptrend",
        downtrend: "EMA: Downtrend",
        chop: "EMA: Chop",
      },
      event_labels: {
        golden_cross: "Golden cross",
        death_cross: "Death cross — wait",
        pullback_9: "Pullback 9",
        pullback_21: "Pullback 21",
        stack_aligned: "Stack aligned",
      },
    },
  };

  let strategy = null;

  function cfg() {
    return strategy || DEFAULT;
  }

  function loadConfig() {
    if (strategy) return Promise.resolve(strategy);
    return fetch("config/ema_strategy.json?v=20260601")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        strategy = json || DEFAULT;
        return strategy;
      });
  }

  function emaKey(period) {
    return period === 9 ? "ema9" : period === 21 ? "ema21" : period === 50 ? "ema50" : "ema200";
  }

  function trendAt(i, bar, stack) {
    const close = bar?.close;
    if (close == null || !stack) return "chop";
    const e50 = stack.ema50?.[i];
    const e200 = stack.ema200?.[i];
    const has200 = stack.barCount >= 200 && Number.isFinite(e200);
    if (has200 && close > e50 && close > e200) return "uptrend";
    if (has200 && close < e50 && close < e200) return "downtrend";
    if (!has200 && Number.isFinite(e50)) {
      if (close > e50 * 1.001) return "uptrend";
      if (close < e50 * 0.999) return "downtrend";
    }
    return "chop";
  }

  function stackAligned(i, stack, ma) {
    const look = ma?.slope_lookback_bars ?? 3;
    if (i < look || stack.barCount < 200) return false;
    const keys = ["ema9", "ema21", "ema50", "ema200"];
    for (let k = 0; k < keys.length - 1; k++) {
      if (!(stack[keys[k]][i] > stack[keys[k + 1]][i])) return false;
    }
    const signs = [];
    for (const key of keys) {
      const a = stack[key][i - look];
      const b = stack[key][i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      signs.push(Math.sign(b - a) || 0);
    }
    const s0 = signs[0];
    return s0 !== 0 && signs.every((s) => s === s0);
  }

  function crossUp(fast, slow, i) {
    return fast[i - 1] <= slow[i - 1] && fast[i] > slow[i];
  }

  function crossDown(fast, slow, i) {
    return fast[i - 1] >= slow[i - 1] && fast[i] < slow[i];
  }

  function nearEma(bar, emaVal, tolPct) {
    if (!Number.isFinite(emaVal) || emaVal === 0) return false;
    const low = bar.low ?? bar.close;
    const diff = Math.abs(low - emaVal) / emaVal * 100;
    return diff <= tolPct;
  }

  function detect(fullBars, stack) {
    if (!fullBars?.length || !stack) return { events: [], lastTrend: "chop", stackAligned: false };
    const c = cfg();
    const sig = c.signals || DEFAULT.signals;
    const labels = c.c2_chips?.event_labels || DEFAULT.c2_chips.event_labels;
    const trendLabels = c.c2_chips?.trend_labels || DEFAULT.c2_chips.trend_labels;
    const tapSet = new Set(sig.tap_enabled || ["golden_cross", "pullback_buy"]);
    const pb = sig.pullback || DEFAULT.signals.pullback;
    const tol = pb.touch_tolerance_pct ?? 0.15;
    const events = [];
    const lastIdx = fullBars.length - 1;

    for (let i = 1; i < fullBars.length; i++) {
      const bar = fullBars[i];
      const tr = trendAt(i, bar, stack);
      const e9 = stack.ema9;
      const e21 = stack.ema21;

      if (crossUp(e9, e21, i)) {
        const ok = !sig.golden_cross?.require_uptrend || tr === "uptrend";
        events.push({
          i,
          t: bar.t,
          type: "golden_cross",
          tap: ok && tapSet.has("golden_cross"),
          label: labels.golden_cross || "Golden cross",
          trend: tr,
          signalSource: "ema_golden_cross",
        });
      }
      if (crossDown(e9, e21, i)) {
        const ok = !sig.death_cross?.require_downtrend || tr === "downtrend";
        events.push({
          i,
          t: bar.t,
          type: "death_cross",
          tap: false,
          label: labels.death_cross || "Death cross — wait",
          trend: tr,
          marker: c.short_signals?.death_cross_chart_marker !== false,
          signalSource: "ema_death_cross",
        });
      }

      if (tr === "uptrend" && tapSet.has("pullback_buy")) {
        for (const period of pb.ema_levels || [9, 21]) {
          const key = emaKey(period);
          const emaVal = stack[key]?.[i];
          if (!nearEma(bar, emaVal, tol)) continue;
          if (pb.confirm_close_above_ema && bar.close <= emaVal) continue;
          const dedupe = events.some(
            (e) => e.i === i && e.type === "pullback_buy" && e.period === period
          );
          if (dedupe) continue;
          events.push({
            i,
            t: bar.t,
            type: "pullback_buy",
            period,
            tap: true,
            label: period === 9 ? labels.pullback_9 || "Pullback 9" : labels.pullback_21 || "Pullback 21",
            trend: tr,
            signalSource: period === 9 ? "ema_pullback_9" : "ema_pullback_21",
          });
        }
      }
    }

    const lastTrend = trendAt(lastIdx, fullBars[lastIdx], stack);
    const aligned = stackAligned(lastIdx, stack, sig.ema_stack);

    return {
      events,
      lastTrend,
      lastTrendLabel: trendLabels[lastTrend] || trendLabels.chop || "EMA: Chop",
      stackAligned: aligned,
      stackLabel: labels.stack_aligned || "Stack aligned",
      swingLookback: pb.swing_lookback_bars ?? 8,
      defaultRr: c.primary_action?.default_rr ?? 2,
    };
  }

  function eventsInWindow(events, vw) {
    if (!vw) return events;
    return events.filter((e) => e.t >= vw.tMin && e.t <= vw.tMax);
  }

  function tooltipForEvent(ev) {
    if (!ev) return "";
    if (ev.type === "golden_cross") return "EMA 9 crossed above 21 in uptrend. Tap to preview EMA plan.";
    if (ev.type === "pullback_buy") return "Pullback to EMA " + ev.period + " with close confirmation. Tap to preview EMA plan.";
    if (ev.type === "death_cross") return "EMA 9 crossed below 21. Wait — no short plan.";
    return ev.label || "";
  }

  function swingLow(bars, endIdx, lookback) {
    let lo = Infinity;
    for (let i = Math.max(0, endIdx - lookback + 1); i <= endIdx; i++) {
      const v = bars[i]?.low ?? bars[i]?.close;
      if (v != null && Number.isFinite(v)) lo = Math.min(lo, v);
    }
    return Number.isFinite(lo) ? lo : null;
  }

  global.RMEmaSignals = {
    loadConfig,
    detect,
    eventsInWindow,
    tooltipForEvent,
    trendAt,
    swingLow,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- fundamental_value.js --- */
/**
 * Fundamental Value overlay - stepped fair P/E series (overlay only; never scales chart).
 */
(function (global) {
  const DEFAULT_CFG = {
    line: { color: "#facc15", width: 2.5, dash: "", label: "Fair Value" },
    shading: { enabled: false, opacity: 0.08, undervalued: "#22c55e", overvalued: "#ef4444" },
    cacheTtlMs: 86400000,
    unavailableMessage: "Fundamentals unavailable",
  };

  let cfg = null;
  let loadPromise = null;
  const memCache = new Map();
  let resolvedApiBase = null;

  function defaultApiBase() {
    const h = typeof location !== "undefined" ? location.hostname : "";
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return PROD_API;
  }

  function fvPayloadScore(payload) {
    if (!payload || payload.error) return 0;
    if (!hasHistoricalSeries(payload)) return 0;
    let score = 1;
    if (payload.dataSource === "yahoo") score = 2;
    const series = payload.series || [];
    const last = series[series.length - 1];
    if (
      Number.isFinite(payload.fairValue) &&
      last &&
      Math.abs(last.fairValue - payload.fairValue) < 1
    ) {
      score += 1;
    }
    return score;
  }

  async function resolveApiBase() {
    if (resolvedApiBase) return resolvedApiBase;
    const candidates =
      typeof location !== "undefined" &&
      (location.hostname === "localhost" || location.hostname === "127.0.0.1")
        ? ["http://127.0.0.1:8765", "http://127.0.0.1:8767", "http://127.0.0.1:8788", PROD_API]
        : [PROD_API];
    let bestBase = null;
    let bestScore = 0;
    for (const base of candidates) {
      try {
        const r = await fetch(base + "/fundamentals/valuation?symbol=META&range=5y", {
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        const score = fvPayloadScore(j);
        if (score > bestScore) {
          bestScore = score;
          bestBase = base;
        }
        if (score >= 3) break;
      } catch {
        /* try next */
      }
    }
    resolvedApiBase = bestBase || defaultApiBase();
    return resolvedApiBase;
  }

  function apiBase() {
    return resolvedApiBase || defaultApiBase();
  }

  const PROD_API = "https://rainmaker-api.onrender.com";

  function cacheKey(symbol, range) {
    return String(symbol || "").toUpperCase() + "|" + String(range || "5y");
  }

  function hasHistoricalSeries(payload) {
    return Array.isArray(payload?.series) && payload.series.length >= 2;
  }

  function readSessionCache(key) {
    try {
      const raw = sessionStorage.getItem("rm_fv_cache_v8:" + key);
      if (!raw) return null;
      const row = JSON.parse(raw);
      if (!row || !row.at || !row.payload) return null;
      const ttl = cfg?.cacheTtlMs ?? DEFAULT_CFG.cacheTtlMs;
      if (Date.now() - row.at > ttl) return null;
      if (!hasHistoricalSeries(row.payload) && !row.payload?.error) return null;
      return row.payload;
    } catch {
      return null;
    }
  }

  function writeSessionCache(key, payload) {
    try {
      sessionStorage.setItem(
        "rm_fv_cache_v8:" + key,
        JSON.stringify({ at: Date.now(), payload })
      );
    } catch {
      /* quota */
    }
  }

  function loadConfig() {
    if (cfg) return Promise.resolve(cfg);
    if (loadPromise) return loadPromise;
    loadPromise = fetch("config/fundamental_value.json?v=20260602")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        cfg = json || DEFAULT_CFG;
        return cfg;
      });
    return loadPromise;
  }

  function getConfig() {
    return cfg || DEFAULT_CFG;
  }

  const GDF_PE_MIN = 5;

  function fairPE(growthPct) {
    const g = Number(growthPct);
    if (!Number.isFinite(g)) return { pe: 15, tag: "PE15" };
    if (g <= 5) return { pe: Math.max(GDF_PE_MIN, Math.min(15, 8.5 + 2 * g)), tag: "GDF" };
    if (g < 15) return { pe: 15, tag: "PE15" };
    return { pe: g, tag: "PE_EQ_G" };
  }

  function gapLabel(gapPct) {
    if (gapPct == null || !Number.isFinite(gapPct)) return "";
    const abs = Math.abs(gapPct);
    if (abs < 3) return "Fairly valued vs earnings";
    if (gapPct < 0) return "Undervalued vs earnings";
    return "Extended vs earnings";
  }

  function fmtMoney(v) {
    if (v == null || !Number.isFinite(v)) return "-";
    return "$" + v.toFixed(2);
  }

  function fmtPct(v, signed) {
    if (v == null || !Number.isFinite(v)) return "-";
    const n = Math.abs(v).toFixed(1);
    if (!signed) return n + "%";
    if (v > 0) return n + "% above";
    if (v < 0) return n + "% below";
    return "on fair value";
  }

  function tooltipPayload(valuation, lastClose) {
    const c = getConfig();
    if (!valuation || valuation.error) {
      const detail =
        valuation?.error === "no_eps"
          ? "No trailing EPS for this symbol (common for ETFs)."
          : "Start rm_api locally or retry later.";
      return {
        kicker: "Fundamentals",
        title: c.unavailableMessage,
        desc: detail,
        stat: "",
        variant: "fv-unavailable",
      };
    }
    const fv = valuation.fairValue;
    const g = valuation.growthPct;
    const label = valuation.formulaLabel || valuation.formula || "";
    const price = lastClose != null ? lastClose : valuation.lastPrice;
    let gapPct = valuation.gapPct;
    if ((gapPct == null || !Number.isFinite(gapPct)) && fv > 0 && price != null) {
      gapPct = ((price - fv) / fv) * 100;
    }
    const gStr = g != null && Number.isFinite(g) ? "g=" + g.toFixed(1) + "%" : "";
    const title =
      "Fair value " + fmtMoney(fv) + " - " + label + (gStr ? " (" + gStr + ")" : "");
    const desc =
      price != null
        ? "Price " + fmtPct(gapPct, true) + " - " + gapLabel(gapPct)
        : gapLabel(gapPct);
    let stat = "";
    if (valuation.forwardEps != null && Number.isFinite(valuation.forwardEps)) {
      stat = "Forward EPS " + fmtMoney(valuation.forwardEps);
    }
    return {
      kicker: "Fair Value",
      title,
      desc,
      stat,
      variant: gapPct != null && gapPct < -3 ? "fv-under" : gapPct > 3 ? "fv-over" : "fv-fair",
      gapPct,
      fairValue: fv,
    };
  }

  async function fetchValuationFrom(base, symbol, range) {
    const url =
      base +
      "/fundamentals/valuation?symbol=" +
      encodeURIComponent(symbol) +
      "&range=" +
      encodeURIComponent(range);
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  }

  async function fetchValuation(symbol, range) {
    const sym = String(symbol || "").toUpperCase();
    const rg = String(range || "5y").trim().toLowerCase() || "5y";
    const key = cacheKey(sym, rg);
    if (memCache.has(key)) {
      const row = memCache.get(key);
      const ttl = cfg?.cacheTtlMs ?? DEFAULT_CFG.cacheTtlMs;
      if (Date.now() - row.at < ttl && hasHistoricalSeries(row.payload)) {
        return row.payload;
      }
      memCache.delete(key);
    }
    const sess = readSessionCache(key);
    if (sess) {
      memCache.set(key, { at: Date.now(), payload: sess });
      return sess;
    }
    await loadConfig();
    const localBase = await resolveApiBase();
    let payload = null;
    try {
      payload = await fetchValuationFrom(localBase, sym, rg);
    } catch {
      payload = null;
    }
    if (!payload?.error && !hasHistoricalSeries(payload)) {
      if (localBase !== PROD_API) {
        try {
          const prod = await fetchValuationFrom(PROD_API, sym, rg);
          if (prod && hasHistoricalSeries(prod)) payload = prod;
        } catch {
          /* prod unavailable */
        }
      }
    }
    if (!payload) return { error: "network", symbol: sym, range: rg, series: [] };
    if (payload.error) {
      if (!Array.isArray(payload.series)) payload.series = [];
      return payload;
    }
    if (hasHistoricalSeries(payload)) {
      memCache.set(key, { at: Date.now(), payload });
      writeSessionCache(key, payload);
    }
    return payload;
  }

  function normalizeSeries(valuation) {
    if (!valuation) return [];
    if (valuation.series?.length) return valuation.series;
    if (Number.isFinite(valuation.fairValue) && valuation.asOf) {
      return [{ t: valuation.asOf, fairValue: valuation.fairValue, period: "current" }];
    }
    return [];
  }

  function fvKnots(valuation) {
    const knots = normalizeSeries(valuation)
      .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.fairValue))
      .map((p) => ({ t: p.t, fv: p.fairValue }))
      .sort((a, b) => a.t - b.t);
    const anchorT = valuation?.asOf || Date.now();
    const anchorFv = valuation?.fairValue;
    if (Number.isFinite(anchorFv)) {
      const last = knots[knots.length - 1];
      if (!last || last.t < anchorT - 86400000 || Math.abs(last.fv - anchorFv) > 0.01) {
        if (last && last.t >= anchorT - 86400000) {
          last.fv = anchorFv;
          last.t = anchorT;
        } else {
          knots.push({ t: anchorT, fv: anchorFv });
        }
      }
    }
    return knots;
  }

  function interpolateFvAt(t, knots) {
    if (!knots.length) return NaN;
    if (t <= knots[0].t) return knots[0].fv;
    if (t >= knots[knots.length - 1].t) return knots[knots.length - 1].fv;
    for (let i = 1; i < knots.length; i++) {
      const a = knots[i - 1];
      const b = knots[i];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        if (span <= 0) return b.fv;
        const w = (t - a.t) / span;
        return a.fv + (b.fv - a.fv) * w;
      }
    }
    return knots[knots.length - 1].fv;
  }

  function smoothValuesForView(viewBars, valuation) {
    const knots = fvKnots(valuation);
    if (!knots.length || !viewBars?.length) return null;
    const values = viewBars.map((bar) => interpolateFvAt(bar.t, knots));
    const unique = new Set(values.filter(Number.isFinite));
    return { values, pointCount: knots.length, uniqueCount: unique.size, knots };
  }

  function seriesForView(viewBars, valuation) {
    return smoothValuesForView(viewBars, valuation);
  }

  /** Price + FV data extents for Y-axis (FAST Graphs: both lines visible). */
  function valueExtents(viewBars, valuation) {
    const pack = seriesForView(viewBars, valuation);
    if (!pack) return null;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const b of viewBars) {
      const hi = b.high ?? b.close;
      const lo = b.low ?? b.close;
      if (hi != null) yMax = Math.max(yMax, hi);
      if (lo != null) yMin = Math.min(yMin, lo);
    }
    for (const v of pack.values) {
      if (Number.isFinite(v)) {
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return null;
    return { yMin, yMax, uniqueCount: pack.uniqueCount, pointCount: pack.pointCount };
  }

  function mapY(m, price, top, floor) {
    const raw = m.y(price);
    if (raw >= top && raw <= floor) return { y: raw, clamp: null };
    return { y: null, clamp: raw < top ? "above" : "below" };
  }

  function buildSmoothPath(values, bars, m) {
    const top = m.pad.t;
    const floor = m.mainH - m.pad.b;
    const xLeft = m.pad.l;
    const xRight = m.w - m.pad.r;
    const pts = [];
    let anyClamped = null;
    for (let i = 0; i < bars.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      let x = m.x(bars[i].t);
      if (!Number.isFinite(x)) x = i === 0 ? xLeft : xRight;
      x = Math.max(xLeft, Math.min(xRight, x));
      const mapped = mapY(m, v, top, floor);
      if (mapped.clamp) anyClamped = mapped.clamp;
      if (mapped.y != null) pts.push({ x, y: mapped.y, v });
    }
    if (pts.length < 2) return null;
    let d = "M" + pts[0].x + " " + pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      d += " L" + pts[i].x + " " + pts[i].y;
    }
    const last = pts[pts.length - 1];
    return {
      d,
      lastY: last.y,
      lastV: last.v,
      clamp: anyClamped,
      xLeft,
      xRight,
    };
  }

  function buildStepLines(values, bars, m) {
    const top = m.pad.t;
    const floor = m.mainH - m.pad.b;
    const xLeft = m.pad.l;
    const xRight = m.w - m.pad.r;
    const horizontals = [];
    let i = 0;
    let anyClamped = null;
    while (i < bars.length) {
      if (!Number.isFinite(values[i])) {
        i++;
        continue;
      }
      const v = values[i];
      let j = i;
      while (j + 1 < bars.length && values[j + 1] === v) j++;
      let x0 = m.x(bars[i].t);
      let x1 = m.x(bars[j].t);
      if (!Number.isFinite(x0)) x0 = xLeft;
      if (!Number.isFinite(x1)) x1 = xRight;
      x0 = Math.max(xLeft, Math.min(xRight, x0));
      x1 = Math.max(xLeft, Math.min(xRight, x1));
      if (x1 < x0) {
        const tmp = x0;
        x0 = x1;
        x1 = tmp;
      }
      const mapped = mapY(m, v, top, floor);
      if (mapped.clamp) anyClamped = mapped.clamp;
      if (mapped.y != null) {
        horizontals.push({ x0, x1, y: mapped.y, v, clamp: null });
      }
      i = j + 1;
    }
    if (!horizontals.length) {
      return anyClamped ? { horizontals: [], verticals: [], offScaleOnly: true, clamp: anyClamped } : null;
    }

    const verticals = [];
    for (let k = 1; k < horizontals.length; k++) {
      const prev = horizontals[k - 1];
      const cur = horizontals[k];
      if (prev.y !== cur.y) {
        verticals.push({ x: cur.x0, y0: prev.y, y1: cur.y });
      }
    }

    const last = horizontals[horizontals.length - 1];
    return {
      horizontals,
      verticals,
      lastY: last.y,
      lastV: last.v,
      clamp: anyClamped,
      offScaleOnly: false,
      xLeft,
      xRight,
    };
  }

  function fvOffScaleClamp(m, fv) {
    if (!m || !Number.isFinite(fv) || !Number.isFinite(m.yMin) || !Number.isFinite(m.yMax)) {
      return null;
    }
    if (fv < m.yMin) return "below";
    if (fv > m.yMax) return "above";
    return null;
  }

  function renderOffScaleFv(m, valuation, lastClose, helpers, clamp) {
    const c = getConfig();
    const tip = tooltipPayload(helpers.tooltipValuation || valuation, lastClose);
    const { escapeAttr, fvTipData, displayFairValue } = helpers;
    const lineCfg = c.line || DEFAULT_CFG.line;
    const color = lineCfg.color || "#facc15";
    const width = lineCfg.width || 2;
    const dash = "6 4";
    const displayFv =
      Number.isFinite(displayFairValue) ? displayFairValue
      : Number.isFinite(valuation?.fairValue) ? valuation.fairValue
      : NaN;
    if (!Number.isFinite(displayFv)) return "";

    const top = m.pad.t;
    const floor = m.mainH - m.pad.b;
    const y = clamp === "above" ? top + 10 : floor - 4;
    const x0 = m.pad.l;
    const x1 = m.w - m.pad.r;
    const d = "M" + x0 + " " + y + " L" + x1 + " " + y;
    const tipAttr =
      typeof fvTipData === "function"
        ? fvTipData(tip.kicker, tip.title, tip.desc, tip.stat, tip.variant)
        : "";
    const edge =
      clamp === "above" ? "above chart scale" : "below chart scale";
    const labelText =
      (lineCfg.label || "Fair Value") +
      " " +
      fmtMoney(displayFv) +
      " (" +
      edge +
      ")";

    let svg =
      '<g class="ca-fv-overlay ca-fv-overlay--off-scale" data-fv-clamp="' +
      escapeAttr(clamp) +
      '">';
    svg +=
      '<path class="ca-fv-line ca-fv-line--off-scale ca-ind-visible" fill="none" d="' +
      d +
      '" stroke="' +
      color +
      '" stroke-width="' +
      width +
      '" stroke-opacity="0.72" stroke-dasharray="' +
      dash +
      '" vector-effect="non-scaling-stroke" pointer-events="none"/>';
    svg +=
      '<path class="ca-ind-hit ca-fv-hit fv-tip-target" tabindex="0"' +
      tipAttr +
      ' fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" d="' +
      d +
      '"/>';
    svg +=
      '<text class="ca-fv-label ca-fv-label--off-scale" x="' +
      (m.w - m.pad.r - 4) +
      '" y="' +
      (clamp === "above" ? y + 11 : y - 5) +
      '" text-anchor="end" fill="' +
      color +
      '" font-size="9" pointer-events="none">' +
      escapeAttr(labelText) +
      "</text>";
    svg += "</g>";
    return svg;
  }

  function render(viewBars, m, valuation, lastClose, helpers) {
    if (!viewBars?.length || !m || !helpers) return "";
    const pack = seriesForView(viewBars, valuation);
    if (!pack) return "";

    const displayFv =
      Number.isFinite(helpers.displayFairValue) ? helpers.displayFairValue
      : Number.isFinite(valuation?.fairValue) ? valuation.fairValue
      : NaN;
    const path = buildSmoothPath(pack.values, viewBars, m);
    if (!path) {
      const clamp = fvOffScaleClamp(m, displayFv);
      if (clamp) {
        return renderOffScaleFv(m, valuation, lastClose, helpers, clamp);
      }
      return "";
    }

    const c = getConfig();
    const tip = tooltipPayload(helpers.tooltipValuation || valuation, lastClose);
    const { escapeAttr, fvTipData, displayFairValue } = helpers;
    const lineCfg = c.line || DEFAULT_CFG.line;
    const color = lineCfg.color || "#facc15";
    const width = lineCfg.width || 2.5;
    const dash = lineCfg.dash || "";

    const tipAttr =
      typeof fvTipData === "function"
        ? fvTipData(tip.kicker, tip.title, tip.desc, tip.stat, tip.variant)
        : "";

    const labelFv = Number.isFinite(displayFairValue) ? displayFairValue : path.lastV;
    const labelText = (lineCfg.label || "Fair Value") + " " + fmtMoney(labelFv);

    let svg = '<g class="ca-fv-overlay">';
    svg +=
      '<path class="ca-fv-line ca-ind-visible" fill="none" d="' +
      path.d +
      '" stroke="' +
      color +
      '" stroke-width="' +
      width +
      '" stroke-opacity="0.92"' +
      (dash ? ' stroke-dasharray="' + dash + '"' : "") +
      ' vector-effect="non-scaling-stroke" pointer-events="none"/>';
    svg +=
      '<path class="ca-ind-hit ca-fv-hit fv-tip-target" tabindex="0"' +
      tipAttr +
      ' fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" d="' +
      path.d +
      '"/>';
    svg +=
      '<text class="ca-fv-label" x="' +
      (m.w - m.pad.r - 4) +
      '" y="' +
      (path.lastY - 5) +
      '" text-anchor="end" fill="' +
      color +
      '" font-size="9" pointer-events="none">' +
      escapeAttr(labelText) +
      "</text>";
    svg += "</g>";
    return svg;
  }

  global.RMFundamentalValue = {
    loadConfig,
    getConfig,
    fairPE,
    fetchValuation,
    tooltipPayload,
    seriesForView,
    valueExtents,
    render,
    gapLabel,
    hasHistoricalSeries,
    normalizeSeries,
    buildStepLines,
    buildSmoothPath,
    smoothValuesForView,
    fvKnots,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- chart_scan.js --- */
/** Chart scan v1 - hold/drag a circle on the chart, analyze region, educator debrief. */
(function (global) {
  const SCANS_KEY = "rainmaker_chart_scans_v1";
  const MIN_CIRCLE_PX = 14;

  let circleEl = null;
  let activeMenu = null;
  let activeMenuMount = null;
  const undoStack = [];
  const UNDO_MAX = 40;
  let suppressUndo = false;

  function cloneScan(scan) {
    return scan ? JSON.parse(JSON.stringify(scan)) : null;
  }

  function pushUndo(entry) {
    if (suppressUndo || !entry) return;
    undoStack.push(entry);
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  function undoLastScan() {
    const entry = undoStack.pop();
    if (!entry) return false;
    suppressUndo = true;
    try {
      if (entry.type === "add") {
        dismissMenu();
        saveAll(loadAll().filter((n) => n.id !== entry.scan.id));
        if (typeof global.RMAgent !== "undefined") {
          global.RMAgent.renderDebrief(null);
          document.getElementById("agentPanel")?.classList.add("hidden");
        }
      } else if (entry.type === "remove") {
        const all = loadAll();
        if (!all.some((n) => n.id === entry.scan.id)) {
          all.push(entry.scan);
          saveAll(all);
        }
      } else if (entry.type === "move") {
        dismissMenu();
        upsertScan(cloneScan(entry.before), { skipUndo: true });
      }
    } finally {
      suppressUndo = false;
    }
    repaintChart();
    return true;
  }

  function canUndo() {
    return undoStack.length > 0;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function storageKey(symbol) {
    if (typeof global.RMAnalysisChart?.scanStorageKey === "function") {
      return global.RMAnalysisChart.scanStorageKey(symbol);
    }
    return String(symbol || "").trim().toUpperCase();
  }

  function loadAll() {
    try {
      return JSON.parse(localStorage.getItem(SCANS_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveAll(list) {
    try {
      localStorage.setItem(SCANS_KEY, JSON.stringify(list.slice(-120)));
    } catch {
      /* ignore */
    }
  }

  function scansForSymbol(sym) {
    const key = storageKey(sym);
    if (!key) return [];
    return loadAll().filter((n) => storageKey(n.symbol) === key);
  }

  function upsertScan(node, opts) {
    const all = loadAll();
    const i = all.findIndex((n) => n.id === node.id);
    const isNew = i < 0;
    if (i >= 0) all[i] = node;
    else all.push(node);
    saveAll(all);
    if (!opts?.skipUndo && isNew) {
      pushUndo({ type: "add", scan: cloneScan(node) });
    }
    return node;
  }

  function removeScan(id, opts) {
    if (!opts?.skipUndo) {
      const existing = loadAll().find((n) => n.id === id);
      if (existing) pushUndo({ type: "remove", scan: cloneScan(existing) });
    }
    saveAll(loadAll().filter((n) => n.id !== id));
  }

  function dismissScan(id) {
    removeScan(id);
    dismissMenu();
    if (typeof global.RMAgent !== "undefined") {
      global.RMAgent.renderDebrief(null);
      document.getElementById("agentPanel")?.classList.add("hidden");
    }
    repaintChart();
  }

  function parseHeadlineTime(h) {
    const raw = h?.published ?? h?.pubDate ?? h?.time ?? h?.date ?? h?.ts;
    if (raw == null) return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }

  function dedupeHeadlines(list) {
    const seen = new Set();
    const out = [];
    for (const h of list || []) {
      const title = String(h?.title || h?.headline || "").trim();
      if (!title) continue;
      const key = title.toLowerCase().slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...h, title });
    }
    return out;
  }

  function regionSlackMs(region) {
    const span = Math.max((region.tMax || 0) - (region.tMin || 0), region.radiusT * 2 || 60000);
    return Math.min(86400000 * 2, Math.max(span * 2, 2 * 3600000));
  }

  function barValue(b, valueKey) {
    if (valueKey === "pct") return b.pct != null ? b.pct : b.close;
    return b.close;
  }

  function chartMetrics() {
    return global.RMAnalysisChart?.state?.metrics || null;
  }

  function circleRadiusPx(scan, m) {
    if (scan.radiusPx > 0) return scan.radiusPx;
    if (!m?.x || !m?.y || scan.centerT == null) return 4;
    const vk = scan.valueKey || "price";
    const cx = m.x(scan.centerT);
    const centerAxis = scanAxisValue(m, scan.centerP, vk);
    const cy = m.y(centerAxis);
    const rx =
      scan.radiusT != null ? Math.abs(m.x(scan.centerT + scan.radiusT) - cx) : 0;
    const ry =
      scan.radiusP != null
        ? Math.abs(m.y(scanAxisValue(m, scan.centerP + scan.radiusP, vk)) - cy)
        : 0;
    return Math.max(4, rx, ry);
  }

  function pointInRegion(t, price, region) {
    const m = chartMetrics();
    if (
      region.shape === "circle" &&
      region.centerT != null &&
      region.centerP != null &&
      m?.x &&
      m?.y
    ) {
      const vk = region.valueKey || "price";
      const rPx = circleRadiusPx(region, m);
      const cx = m.x(region.centerT);
      const centerAxis = scanAxisValue(m, region.centerP, vk);
      const priceAxis = scanAxisValue(m, price, vk);
      const cy = m.y(centerAxis);
      const px = m.x(t);
      const py = m.y(priceAxis);
      const dx = px - cx;
      const dy = py - cy;
      return dx * dx + dy * dy <= rPx * rPx;
    }
    return (
      t >= region.tMin &&
      t <= region.tMax &&
      price >= region.pMin &&
      price <= region.pMax
    );
  }

  function timeInScanRegion(t, region) {
    const m = chartMetrics();
    if (region.shape === "circle" && region.centerT != null && m?.x) {
      const rPx = circleRadiusPx(region, m);
      return Math.abs(m.x(t) - m.x(region.centerT)) <= rPx;
    }
    return t >= region.tMin && t <= region.tMax;
  }

  function barsInRegion(bars, region) {
    const vk = region.valueKey || "price";
    return (bars || []).filter((b) => {
      const p = barValue(b, vk);
      if (p == null || !Number.isFinite(p)) return false;
      return pointInRegion(b.t, p, region);
    });
  }

  function matchHeadlinesToRegion(headlines, region, hiT, loT) {
    const center = region.centerT ?? (region.tMin + region.tMax) / 2;
    const slack = regionSlackMs(region);
    const scored = [];

    for (const h of dedupeHeadlines(headlines)) {
      const t = parseHeadlineTime(h);
      const title = h.title || "Headline";
      let score = 0;
      let tag = "recent";

      if (t != null) {
        if (timeInScanRegion(t, region)) {
          score += 120;
          tag = "in circle";
        } else if (t >= region.tMin - slack && t <= region.tMax + slack) {
          const dist = Math.abs(t - center);
          score += 70 - (dist / slack) * 25;
          tag = "near circle";
        } else {
          continue;
        }
        if (hiT != null && Math.abs(t - hiT) <= slack / 3) score += 12;
        if (loT != null && Math.abs(t - loT) <= slack / 3) score += 12;
      } else {
        score = 8;
      }

      scored.push({ title, t, tag, score, url: h.url || h.link || null, summary: h.summary || "" });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  function calcEMA(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function calcRSI(closes, period) {
    period = period || 14;
    if (closes.length < period + 1) return [];
    const rsi = [];
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) avgGain += ch;
      else avgLoss -= ch;
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = 0; i < period; i++) rsi.push(null);
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      const gain = ch > 0 ? ch : 0;
      const loss = ch < 0 ? -ch : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return rsi;
  }

  function calcMACD(closes) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macd = ema12.map((v, i) => v - ema26[i]);
    const signal = calcEMA(macd, 9);
    const hist = macd.map((v, i) => v - signal[i]);
    return { macd, signal, hist };
  }

  function fmtPrice(v, pctMode) {
    if (v == null || !Number.isFinite(v)) return "-";
    if (pctMode) return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    return "$" + v.toFixed(2);
  }

  function fmtTime(t) {
    if (!t) return "recent";
    try {
      return new Date(t).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
    } catch {
      return "";
    }
  }

  function formatCatalyst(hits, headlineCount) {
    if (!hits.length) {
      if (headlineCount > 0) {
        return (
          "No headlines line up with this circle. " +
          headlineCount +
          " loaded - widen the circle toward the move or session open."
        );
      }
      return (
        "No headlines loaded. Run Scan + news or open from a scan pick, then Analyze again."
      );
    }
    return hits
      .map((hit) => {
        const when = hit.t ? fmtTime(hit.t) + " PT" : "recent";
        return "- " + when + " (" + hit.tag + "): " + hit.title;
      })
      .join("\n");
  }

  function analyzeRegion(opts) {
    const region = opts.region || opts;
    const bars = opts.bars || [];
    const headlines = opts.headlines || [];
    const pctMode = opts.pctMode === true;
    const slice = barsInRegion(bars, region);
    if (slice.length < 2) {
      return {
        technicals: "Circle too small - drag a wider circle over at least two bars.",
        catalyst: formatCatalyst([], headlines.length),
        catalystItems: [],
        confidence: "low - need more bars in the selection.",
        confidenceLevel: "low",
      };
    }

    const closes = bars.map((b) => b.close);
    const rsiAll = calcRSI(closes);
    const macdAll = calcMACD(closes);
    const endIdx = bars.findIndex((b) => b.t >= region.tMax);
    const idx = endIdx >= 0 ? endIdx : bars.length - 1;
    const rsiVal = rsiAll[idx];
    const hist = macdAll.hist[idx];

    let hi = -Infinity;
    let lo = Infinity;
    let hiT = null;
    let loT = null;
    for (const b of slice) {
      const h = b.high ?? b.close;
      const l = b.low ?? b.close;
      if (h > hi) {
        hi = h;
        hiT = b.t;
      }
      if (l < lo) {
        lo = l;
        loT = b.t;
      }
    }
    const startClose = slice[0].close;
    const endClose = slice[slice.length - 1].close;
    const movePct =
      startClose && endClose ? ((endClose - startClose) / Math.abs(startClose)) * 100 : 0;
    const structure =
      movePct > 0.35 ? "uptrend in circle" : movePct < -0.35 ? "downtrend in circle" : "range";

    const rsiNote =
      rsiVal == null
        ? "RSI n/a"
        : rsiVal <= 30
          ? "RSI " + rsiVal.toFixed(0) + " oversold"
          : rsiVal >= 70
            ? "RSI " + rsiVal.toFixed(0) + " overbought"
            : "RSI " + rsiVal.toFixed(0);
    const macdNote =
      hist == null ? "MACD n/a" : hist >= 0 ? "MACD hist +" + hist.toFixed(2) : "MACD hist " + hist.toFixed(2);

    const technicals =
      structure +
      ", " +
      movePct.toFixed(2) +
      "% close-to-close. " +
      rsiNote +
      ", " +
      macdNote +
      ". High " +
      fmtPrice(hi, pctMode) +
      ", low " +
      fmtPrice(lo, pctMode) +
      ".";

    const newsHits = matchHeadlinesToRegion(headlines, region, hiT, loT);
    const catalyst = formatCatalyst(newsHits, headlines.length);

    let confidenceLevel = "low";
    const inCircleNews = newsHits.filter((h) => h.tag === "in circle").length;
    if (inCircleNews && Math.abs(movePct) >= 0.4) confidenceLevel = "high";
    else if (newsHits.length && Math.abs(movePct) >= 0.25) confidenceLevel = "med";
    else if (newsHits.length) confidenceLevel = "med";

    const confidence =
      confidenceLevel +
      " - " +
      (confidenceLevel === "high"
        ? "headline(s) in the circle align with the move."
        : confidenceLevel === "med"
          ? newsHits.length
            ? "nearby headlines may explain the move - confirm on price."
            : "price action only - no nearby headlines."
          : "thin evidence - widen the circle or refresh news.");

    return {
      technicals,
      catalyst,
      catalystItems: newsHits,
      confidence,
      confidenceLevel,
      hi,
      lo,
      hiT,
      loT,
      movePct,
      structure,
      rsiVal,
      hist,
      barCount: slice.length,
    };
  }

  function repaintChart() {
    if (typeof global.RMAnalysisChart !== "undefined") {
      global.RMAnalysisChart.paint?.();
    }
  }

  function publishDebrief(scan, analysis) {
    const pctMode =
      typeof global.RMAnalysisChart !== "undefined" &&
      global.RMAnalysisChart.state?.metrics?.mode === "pct";
    const rangeLabel =
      analysis.hi != null && analysis.lo != null
        ? fmtPrice(analysis.lo, pctMode) + " ? " + fmtPrice(analysis.hi, pctMode)
        : null;
    const ctx = {
      title: (scan.symbol || "Chart") + " scan",
      hint: fmtTime(scan.tMin) + " ? " + fmtTime(scan.tMax),
      technicals: analysis.technicals,
      catalyst: analysis.catalyst,
      catalystItems: analysis.catalystItems,
      confidence: analysis.confidence,
      confidenceLevel: analysis.confidenceLevel,
      scanId: scan.id,
      symbol: scan.symbol,
      rangeLabel,
      metrics: {
        movePct: analysis.movePct,
        structure: analysis.structure,
        rsi: analysis.rsiVal,
        macdHist: analysis.hist,
        hi: analysis.hi,
        lo: analysis.lo,
        bars: analysis.barCount,
      },
    };
    document.dispatchEvent(new CustomEvent("rm:debrief", { detail: ctx }));
    if (typeof global.RMAgent !== "undefined") {
      global.RMAgent.renderDebrief(ctx);
      global.RMAgent.openPanel?.();
    }
  }

  function translateScan(scan, dT, dP) {
    if (!scan) return scan;
    scan.centerT = (scan.centerT || 0) + dT;
    scan.centerP = (scan.centerP || 0) + dP;
    scan.tMin = (scan.tMin || 0) + dT;
    scan.tMax = (scan.tMax || 0) + dT;
    scan.pMin = (scan.pMin || 0) + dP;
    scan.pMax = (scan.pMax || 0) + dP;
    return scan;
  }

  function previewScanMove(snapshot, dT, dP) {
    const moved = cloneScan(snapshot);
    translateScan(moved, dT, dP);
    upsertScan(moved, { skipUndo: true });
    repaintChart();
    return moved;
  }

  function commitScanMove(snapshot, dT, dP) {
    const before = cloneScan(snapshot);
    const after = cloneScan(snapshot);
    translateScan(after, dT, dP);
    upsertScan(after, { skipUndo: true });
    if (Math.abs(dT) > 0 || Math.abs(dP) > 0) {
      pushUndo({ type: "move", before, after: cloneScan(after) });
    }
    repaintChart();
    return after;
  }

  function revertScanMove(snapshot) {
    upsertScan(cloneScan(snapshot), { skipUndo: true });
    repaintChart();
  }

  function createScanNode(symbol, region) {
    return {
      id: "scan-" + Date.now(),
      symbol: storageKey(symbol),
      shape: region.shape || "circle",
      centerT: region.centerT,
      centerP: region.centerP,
      radiusPx: region.radiusPx,
      tMin: region.tMin,
      tMax: region.tMax,
      pMin: region.pMin,
      pMax: region.pMax,
      valueKey: region.valueKey || "price",
      created_at: new Date().toISOString(),
      confidence: null,
    };
  }

  function dismissMenu() {
    activeMenu?.remove();
    activeMenu = null;
    activeMenuMount = null;
  }

  function chartMountFrom(el) {
    return el?.closest?.(".ca-chart-mount") || el;
  }

  function bindMenuActions(menu, onPick) {
    menu.addEventListener(
      "pointerdown",
      (e) => {
        e.stopPropagation();
      },
      true
    );
    menu.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const act = btn.dataset.act;
      dismissMenu();
      onPick(act);
    });
  }

  function showMenu(anchorEl, clientX, clientY, items, onPick) {
    dismissMenu();
    const mount = chartMountFrom(anchorEl);
    if (!mount) return;
    const menu = document.createElement("div");
    menu.className = "ca-scan-menu";
    menu.setAttribute("role", "menu");
    menu.innerHTML = items
      .map(
        (it) =>
          '<button type="button" class="ca-scan-menu-btn' +
          (it.act === "analyze" ? " ca-scan-menu-btn--primary" : "") +
          (it.act === "dismiss" ? " ca-scan-menu-btn--dismiss" : "") +
          (it.act === "note" ? " ca-scan-menu-btn--note" : "") +
          '" role="menuitem" data-act="' +
          escapeAttr(it.act) +
          '">' +
          escapeHtml(it.label) +
          "</button>"
      )
      .join("");
    mount.appendChild(menu);
    activeMenuMount = mount;
    const mr = mount.getBoundingClientRect();
    const left = Math.max(4, Math.min(clientX - mr.left, mr.width - menu.offsetWidth - 4));
    const top = Math.max(4, Math.min(clientY - mr.top, mr.height - menu.offsetHeight - 4));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    bindMenuActions(menu, onPick);
    activeMenu = menu;
    const close = (e) => {
      if (!activeMenu || activeMenu.contains(e.target)) return;
      dismissMenu();
      document.removeEventListener("pointerdown", close, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
    requestAnimationFrame(() => reattachOverlays(mount));
  }

  function reattachOverlays(mount) {
    const host = mount?.closest?.(".ca-chart-mount") || mount || activeMenuMount;
    if (!host) return;
    if (activeMenu && !activeMenu.isConnected) {
      host.appendChild(activeMenu);
    }
    const wrap = host.querySelector(".ca-chart-svg-wrap");
    if (circleEl && wrap && !circleEl.isConnected) {
      wrap.appendChild(circleEl);
    }
  }

  async function refreshAnalyzeOpts(opts) {
    const chart = global.RMAnalysisChart;
    if (chart?.ensureSymbolNews && opts.symbol) {
      await chart.ensureSymbolNews(opts.symbol);
    }
    opts.headlines = chart?.headlinesForChartSymbol?.(opts.symbol) || opts.headlines || [];
    opts.bars = chart?.state?.bars || opts.bars || [];
    opts.pctMode = chart?.state?.metrics?.mode === "pct";
    return opts;
  }

  async function runAnalyze(scan, opts) {
    await refreshAnalyzeOpts(opts);
    const analysis = analyzeRegion({
      region: scan,
      bars: opts.bars,
      headlines: opts.headlines,
      pctMode: opts.pctMode,
    });
    scan.confidence = analysis.confidenceLevel;
    scan.analyzed_at = new Date().toISOString();
    scan.catalyst_preview = analysis.catalystItems?.[0]?.title || null;
    upsertScan(scan, { skipUndo: true });
    publishDebrief(scan, analysis);
    dismissMenu();
    repaintChart();
    return { scan, analysis };
  }

  async function saveResearchToStory(scan, analysis) {
    if (typeof global.RMTradeStory === "undefined") return null;
    return global.RMTradeStory.appendEvent({
      type: "research",
      symbol: scan.symbol,
      scan_id: scan.id,
      t_min: scan.tMin,
      t_max: scan.tMax,
      p_min: scan.pMin,
      p_max: scan.pMax,
      confidence: scan.confidence || analysis.confidenceLevel,
      technicals: analysis.technicals,
      catalyst: analysis.catalyst,
    });
  }

  function showDraftMenu(wrap, scan, opts) {
    showMenu(
      wrap,
      opts.clientX,
      opts.clientY,
      [
        { act: "analyze", label: "Analyze" },
        { act: "deep", label: "Queue deep research" },
        { act: "note", label: "Note" },
        { act: "dismiss", label: "Dismiss" },
      ],
      (act) => {
        if (act === "dismiss") {
          dismissScan(scan.id);
          return;
        }
        if (act === "analyze") {
          void runAnalyze(scan, opts);
          return;
        }
        if (act === "deep") {
          void runAnalyze(scan, opts).then(function (result) {
            if (global.RMResearch && global.RMResearch.queueFromChartScan) {
              void global.RMResearch.queueFromChartScan(result.scan, result.analysis);
            }
          });
          return;
        }
        if (act === "note") {
          if (typeof global.RMAnalysisChart?.openNoteForScan === "function") {
            global.RMAnalysisChart.openNoteForScan(scan, opts.clientX, opts.clientY);
          }
        }
      }
    );
  }

  function showExistingMenu(wrap, scan, opts) {
    showMenu(
      wrap,
      opts.clientX,
      opts.clientY,
      [
        { act: "analyze", label: "Analyze" },
        { act: "deep", label: "Queue deep research" },
        { act: "dismiss", label: "Dismiss" },
      ],
      (act) => {
        if (act === "dismiss") {
          dismissScan(scan.id);
          return;
        }
        if (act === "deep") {
          void runAnalyze(scan, opts).then(function (result) {
            if (global.RMResearch && global.RMResearch.queueFromChartScan) {
              void global.RMResearch.queueFromChartScan(result.scan, result.analysis);
            }
          });
          return;
        }
        void runAnalyze(scan, opts);
      }
    );
  }

  function beginCircle(wrap, cx, cy) {
    cancelCircle();
    if (!wrap) return;
    const el = document.createElement("div");
    el.className = "ca-scan-circle";
    el.setAttribute("aria-hidden", "true");
    wrap.appendChild(el);
    circleEl = el;
    updateCircle(wrap, cx, cy, cx, cy);
  }

  function updateCircle(wrap, cx, cy, ex, ey) {
    if (!circleEl || !wrap) return;
    const wr = wrap.getBoundingClientRect();
    const r = Math.max(0, Math.hypot(ex - cx, ey - cy));
    const size = r * 2;
    circleEl.style.left = cx - wr.left + "px";
    circleEl.style.top = cy - wr.top + "px";
    circleEl.style.width = size + "px";
    circleEl.style.height = size + "px";
    circleEl.style.aspectRatio = "1";
  }

  function cancelCircle() {
    circleEl?.remove();
    circleEl = null;
  }

  function endCircle(wrap, cx, cy, ex, ey) {
    cancelCircle();
    const r = Math.hypot(ex - cx, ey - cy);
    if (r < MIN_CIRCLE_PX) return null;
    return { cx, cy, ex, ey, r, wrap };
  }

  function regionIntersectsView(scan, vw) {
    if (!vw) return true;
    return scan.tMax >= vw.tMin && scan.tMin <= vw.tMax;
  }

  function scanAxisValue(m, value, valueKey) {
    const chart = global.RMAnalysisChart;
    if (chart?.axisStoredValueToChart) {
      return chart.axisStoredValueToChart(m, value, valueKey);
    }
    return value;
  }

  function renderRegionsSvg(m, symbol, vw) {
    if (!m?.x || !m?.y) return "";
    const nodes = scansForSymbol(symbol);
    if (!nodes.length) return "";

    let markup = "";
    for (const scan of nodes) {
      if (!regionIntersectsView(scan, vw)) continue;

      const tip =
        scan.catalyst_preview || scan.note || "Chart scan - click to analyze or dismiss";
      const attrs =
        ' class="ca-scan-region ca-chart-node ca-chart-node--scan" data-node-kind="scan" data-scan-id="' +
        escapeAttr(scan.id) +
        '" title="' +
        escapeAttr(tip) +
        '"';

      if (scan.shape === "circle" && scan.centerT != null && scan.centerP != null) {
        const vk = scan.valueKey || "price";
        const cx = m.x(scan.centerT);
        const centerAxis = scanAxisValue(m, scan.centerP, vk);
        const cy =
          centerAxis != null && Number.isFinite(centerAxis)
            ? m.y(centerAxis)
            : m.y(scan.centerP);
        const r = Math.max(4, circleRadiusPx(scan, m));
        markup +=
          "<g" +
          attrs +
          '><circle class="ca-scan-region-fill" cx="' +
          cx.toFixed(1) +
          '" cy="' +
          cy.toFixed(1) +
          '" r="' +
          r.toFixed(1) +
          '"/></g>';
        continue;
      }

      const vk = scan.valueKey || "price";
      const x0 = m.x(scan.tMin);
      const x1 = m.x(scan.tMax);
      const pMaxAxis = scanAxisValue(m, scan.pMax, vk);
      const pMinAxis = scanAxisValue(m, scan.pMin, vk);
      const y0 = m.y(pMaxAxis);
      const y1 = m.y(pMinAxis);
      const x = Math.min(x0, x1);
      const y = Math.min(y0, y1);
      const w = Math.abs(x1 - x0);
      const h = Math.abs(y0 - y1);
      if (w < 2 && h < 2) continue;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      markup +=
        "<g" +
        attrs +
        '><ellipse class="ca-scan-region-fill" cx="' +
        cx.toFixed(1) +
        '" cy="' +
        cy.toFixed(1) +
        '" rx="' +
        Math.max(4, w / 2).toFixed(1) +
        '" ry="' +
        Math.max(4, h / 2).toFixed(1) +
        '"/></g>';
    }

    if (!markup) return "";
    return '<g class="ca-scan-regions">' + markup + "</g>";
  }

  function handleNodeTap(node, clientX, clientY) {
    const id = node?.dataset?.scanId;
    if (!id) return false;
    const scan = loadAll().find((n) => n.id === id);
    if (!scan) return false;
    const chart = global.RMAnalysisChart;
    const st = chart?.state;
    const wrap = node.closest(".ca-chart-svg-wrap");
    showExistingMenu(wrap, scan, {
      clientX,
      clientY,
      symbol: st?.symbol || scan.symbol,
      bars: st?.bars || [],
      headlines: chart?.headlinesForChartSymbol?.(st?.symbol || scan.symbol) || [],
      pctMode: st?.metrics?.mode === "pct",
    });
    return true;
  }

  function completeCircleGesture(wrap, region, opts) {
    const scan = createScanNode(opts.symbol, region);
    upsertScan(scan);
    repaintChart();
    showDraftMenu(wrap, scan, opts);
    reattachOverlays(wrap);
    return scan;
  }

  function getScanForDebrief(scanId) {
    return loadAll().find((n) => n.id === scanId) || null;
  }

  global.RMChartScan = {
    SCANS_KEY,
    loadAll,
    scansForSymbol,
    upsertScan,
    removeScan,
    dismissScan,
    analyzeRegion,
    renderRegionsSvg,
    beginCircle,
    updateCircle,
    cancelCircle,
    endCircle,
    completeCircleGesture,
    showDraftMenu,
    showExistingMenu,
    handleNodeTap,
    runAnalyze,
    saveResearchToStory,
    getScanForDebrief,
    dismissMenu,
    undo: undoLastScan,
    canUndo,
    reattachOverlays,
    previewScanMove,
    commitScanMove,
    revertScanMove,
    // legacy aliases
    beginLasso: beginCircle,
    updateLasso: updateCircle,
    cancelLasso: cancelCircle,
    endLasso: endCircle,
  };
})(typeof window !== "undefined" ? window : globalThis);

;
/* --- chart_analysis.js --- */
/** Unified analysis chart: SPY compare + overlays, candles, S/R, indicators, notes. */
(function (global) {
  const NOTES_KEY = "rainmaker_chart_notes_v1";
  const TRADES_KEY = "rainmaker_chart_trades_v1";
  const PREFS_KEY = "rainmaker_chart_prefs_v1";
  const MACDRSI_BUY_DEFAULT_KEY = "rm_macdrsi_buy_default_v2";
  const COMPARE_SYM = "__COMPARE__";
  const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "5y"];
  const INTERVALS = ["1m", "2m", "5m", "15m", "30m", "1h", "1d"];
  // Yahoo only serves intraday intervals for a limited lookback. Requesting a
  // range longer than the interval supports (e.g. 5m over 3mo) returns ZERO
  // bars, which blanks the chart. These caps mirror Yahoo's documented limits.
  // An interval/range combo must satisfy two bounds:
  //  - MAX: Yahoo only serves intraday intervals for a limited lookback, and
  //    large intraday datasets render poorly in the compare view (1h capped at
  //    60d, not Yahoo's 730d), so 3mo+ resolves to daily bars.
  //  - MIN: a daily interval over a 1-day range yields a single bar (no chart),
  //    so daily needs at least a few days.
  const INTERVAL_MAX_DAYS = {
    "1m": 7,
    "2m": 60,
    "5m": 60,
    "15m": 60,
    "30m": 60,
    "1h": 60,
    "1d": 1000000,
  };
  const INTERVAL_MIN_DAYS = {
    "1d": 2,
  };
  const RANGE_DAYS = {
    "1d": 1,
    "5d": 5,
    "1mo": 31,
    "3mo": 93,
    "6mo": 186,
    "1y": 366,
    "5y": 1825,
  };
  const RANGE_LABELS = {
    ytd: "YTD",
  };
  function rangeDays(range) {
    if (range === "ytd") {
      const now = new Date();
      const start = new Date(now.getFullYear(), 0, 1);
      return Math.max(1, Math.ceil((now - start) / 86400000));
    }
    return RANGE_DAYS[range] ?? 1;
  }
  function rangeLabel(range) {
    return RANGE_LABELS[range] || range;
  }
  // Sensible default interval for each range (matches typical charting apps).
  const DEFAULT_INTERVAL = {
    "1d": "5m",
    "5d": "15m",
    "1mo": "1h",
    "3mo": "1d",
    "6mo": "1d",
    ytd: "1d",
    "1y": "1d",
    "5y": "1d",
  };

  function comboValid(interval, range) {
    const rD = rangeDays(range);
    const maxD = INTERVAL_MAX_DAYS[interval] ?? 1000000;
    const minD = INTERVAL_MIN_DAYS[interval] ?? 0;
    return rD <= maxD && rD >= minD;
  }

  function nearestValidRange(interval, fromRange) {
    if (comboValid(interval, fromRange)) return fromRange;
    const idx = RANGES.indexOf(fromRange);
    const rD = rangeDays(fromRange);
    const tooLong = rD > (INTERVAL_MAX_DAYS[interval] ?? 1000000);
    if (tooLong) {
      for (let i = idx - 1; i >= 0; i--) {
        if (comboValid(interval, RANGES[i])) return RANGES[i];
      }
    } else {
      for (let i = idx + 1; i < RANGES.length; i++) {
        if (comboValid(interval, RANGES[i])) return RANGES[i];
      }
    }
    return fromRange;
  }

  // Nudge the dimension the user did NOT just pick into a valid combo. Changing
  // the range snaps the interval to that range's sensible default; changing the
  // interval grows/shrinks the range to the nearest span the interval supports.
  // Returns true if an adjustment was made (so callers can repaint the toolbar).
  function clampRangeInterval(changed) {
    if (comboValid(state.interval, state.range)) return false;
    if (changed === "interval") {
      const r = nearestValidRange(state.interval, state.range);
      if (r !== state.range) {
        state.range = r;
        return true;
      }
      return false;
    }
    const def = DEFAULT_INTERVAL[state.range] || "1d";
    if (def !== state.interval && comboValid(def, state.range)) {
      state.interval = def;
      return true;
    }
    return false;
  }
  const PST_TZ = "America/Los_Angeles";
  const CHART_LAYERS_KEY = "rm_chart_layers_v1";
  const STRUCTURE_OR_MINUTES = 5;
  let _chartLayersConfig = null;
  const MIN_VIEW_WINDOW_MS = 5 * 60 * 1000;
  // Empty plot space to the right of the last bar (TradingView-style right offset).
  const VIEW_RIGHT_PAD_RATIO = 0.08;
  // Default load zoom: show the trailing portion of the range (right-aligned).
  const DEFAULT_VIEW_VISIBLE_RATIO = 0.5;
  const CHART_WHEEL_ZOOM = 1.14;
  const Y_VIEW_OFFSET_MAX = 0.72;
  const TRADE_PLAN_PROJ_MS = 20 * 60 * 60 * 1000;
  let _chartColors = null;
  function chartColors() {
    if (_chartColors) return _chartColors;
    let bull = "#2db8a8";
    let bear = "#e8954f";
    let accent = "#4eb8c9";
    let bullStrong = "#1a9e92";
    let tradeNode = bull;
    try {
      const root = getComputedStyle(document.documentElement);
      const pick = (name, fb) => root.getPropertyValue(name).trim() || fb;
      bull = pick("--chart-candle-up", pick("--bull", bull));
      bear = pick("--chart-candle-down", pick("--bear", bear));
      accent = pick("--accent", accent);
      bullStrong = pick("--bull-strong", bullStrong);
      tradeNode = pick("--chart-trade-node", bull);
    } catch (_) {
      /* pre-DOM */
    }
    _chartColors = { bull, bear, accent, bullStrong, candleUp: bull, candleDown: bear, tradeNode };
    return _chartColors;
  }
  function nodeStyle(kind) {
    const c = chartColors();
    const styles = {
      note: { fill: "#d4a24a", kicker: "Note" },
      news: { fill: "#8b7fd4", kicker: "News" },
      trade: { fill: c.tradeNode, kicker: "Trade" },
      event: { fill: c.tradeNode, kicker: "Event" },
      pick: { fill: c.tradeNode, kicker: "Morning Pulse" },
    };
    return styles[kind] || styles.event;
  }
  function symColorPalette() {
    const c = chartColors();
    return [c.accent, c.bull, "#d4a24a", "#8b7fd4", "#5ba8c9", c.bear, "#6bc4b8"];
  }
  function colorFor(sym, list) {
    const palette = symColorPalette();
    const i = list.indexOf(sym);
    return palette[(i >= 0 ? i : 0) % palette.length];
  }

  const state = {
    container: null,
    hub: null,
    symbol: "SPY",
    bars: [],
    events: [],
    srLines: [],
    srOverrides: {},
    indicators: { macd: true, rsi: true, ichimoku: true, macdrsiBuy: true, volume: true, emaStack: false, fairValue: false },
    showSR: true,
    showEvents: true,
    activeNoteId: null,
    noteEditorAnchor: null,
    mapHighlight: null,
    metrics: null,
    fullExtent: null,
    viewWindow: null,
    w: 640,
    h: 320,
    interval: "5m",
    range: "1d",
    yAxisPct: null,
    yView: { scale: 1, offset: 0 },
    dismissedSr: {},
    paneSplit: 0.72,
    priorClose: null,
    tradePlan: null,
    tradePlanExpanded: false,
    fundamentalValuation: null,
    _fvFetchGen: 0,
    debriefWindow: null,
    activeTradeMarkerId: null,
    instrumentContext: null,
    _viewContextKey: "",
    extraSymbols: [],
    chartLoading: false,
    addMode: "load",
  };

  const brushDrag = {
    active: null,
    startX: 0,
    startVw: null,
    pointerId: null,
    captureEl: null,
    moveCount: 0,
  };
  let _repaintBusy = false;
  let _repaintQueued = false;
  let viewPanAnim = null;
  /** Fixed brush track (5:30am→close) during scan intro — stops slider track from resizing. */
  let scanBrushExtentLock = null;
  /** 60m before 9:30 ET RTH — used when session meta supplies the open timestamp. */
  const SCAN_OPEN_LEAD_MS = 60 * 60 * 1000;
  /** Left edge on PST chart labels during scan intro (1h before 6:30 AM PT open). */
  const PT_SCAN_CHART_LEFT_MIN = 5 * 60 + 30;
  const SCAN_OPEN_PAN_MIN_MS = 1500;
  const SCAN_OPEN_PAN_MAX_MS = 3200;
  const chartPointer = {
    pointerId: null,
    startX: 0,
    startY: 0,
    startVw: null,
    moved: false,
    panning: false,
    holdTimer: null,
    pendingNode: null,
    captureEl: null,
    panRaf: null,
    lastClientX: 0,
    lastClientY: 0,
    yAxisZone: false,
    startYView: null,
    frozenYDomain: null,
    lasso: false,
    scanDraw: false,
    cededToScroll: false,
  };
  const rightScanPointer = {
    active: false,
    mode: null,
    drawing: false,
    startX: 0,
    startY: 0,
    moved: false,
    captureEl: null,
    scanMove: null,
    suppressMenu: false,
  };
  let schwabMarkerSyncAt = 0;
  const CHART_HOLD_MS = 450;
  const CHART_MOVE_PX = 5;
  const srDrag = { active: false, id: null, pointerId: null, moved: false };

  // Item 9: the chart defaults to a crosshair cursor. Panning ("hand") is only
  // armed while Spacebar is held (desktop) or two fingers are down (touch).
  let chartPanArmed = false;
  let chartHovered = false;
  const activeTouchPoints = new Set();
  let chartKeyBound = false;

  function $(sel, root) {
    return (root || state.container || document).querySelector(sel);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function fvTip(kicker, title, desc, stat, variant) {
    if (typeof RMUiTips === "undefined") return "";
    return RMUiTips.fvTipData(kicker, title, desc, stat, variant);
  }

  function hubState() {
    return state.hub?.state || state.hub || global.RMChartHub?.state || {};
  }

  function chartHubRef() {
    return state.hub || global.RMChartHub || null;
  }

  function chartHubData(hubRef) {
    const ref = hubRef || chartHubRef();
    if (ref?.state && (ref.state.spyBars || ref.state.spyPct)) return ref.state;
    if (ref?.spyBars || ref?.spyPct) return ref;
    return hubState();
  }

  function isCompareMode() {
    return state.symbol === COMPARE_SYM;
  }

  /** Price series used for % axis, S/R, and candles (SPY base in compare view). */
  function chartPriceSymbol() {
    return isCompareMode() ? "SPY" : barsFetchSymbol(state.symbol);
  }

  function barsFetchSymbol(sym) {
    const key = String(sym || "").trim();
    if (!key || key === COMPARE_SYM) return key;
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.barsSymbolForSelectValue) {
      return global.RMHoldings.barsSymbolForSelectValue(key);
    }
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolForSelectValue) {
      return global.RMHoldings.chartSymbolForSelectValue(key);
    }
    if (/^holding:/i.test(key)) return key;
    return key.toUpperCase();
  }

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function usePctAxis() {
    if (state.yAxisPct != null) return !!state.yAxisPct;
    return isCompareMode();
  }

  /** Map dollar FV series onto the active Y-axis (price or % vs prior close). */
  function fvValuationForChart(m, valuation) {
    if (!valuation || valuation.error) return valuation;
    if (!m || m.mode !== "pct") return valuation;
    const base = priorCloseForSymbol(chartPriceSymbol());
    if (!base || base <= 0) return null;
    const toPct = (price) => ((Number(price) - base) / base) * 100;
    const out = Object.assign({}, valuation);
    if (Number.isFinite(out.fairValue)) out.fairValue = toPct(out.fairValue);
    if (out.series?.length) {
      out.series = out.series.map((p) => ({
        ...p,
        fairValue: Number.isFinite(p.fairValue) ? toPct(p.fairValue) : p.fairValue,
      }));
    }
    return out;
  }

  function mergeFvIntoMetrics(m, viewBars, valuation) {
    if (!valuation || !viewBars?.length || typeof global.RMFundamentalValue === "undefined") {
      return m;
    }
    const fvChart = fvValuationForChart(m, valuation) || valuation;
    if (m.mode === "pct") {
      const pack = global.RMFundamentalValue.seriesForView(viewBars, fvChart);
      if (!pack?.values?.length) return m;
      let yMin = m.yMin;
      let yMax = m.yMax;
      for (const v of pack.values) {
        if (!Number.isFinite(v)) continue;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
      return recomputeYScale(m, yMin, yMax, 0.1);
    }
    const fvExt = global.RMFundamentalValue.valueExtents(viewBars, fvChart);
    return fvExt ? recomputeYScale(m, fvExt.yMin, fvExt.yMax, 0.1) : m;
  }

  function chartFetchStepLabel() {
    const lbl = symbolLabel(state.symbol) || barsFetchSymbol(state.symbol) || "…";
    return "Loading " + lbl + "…";
  }

  function setChartLoading(on) {
    state.chartLoading = !!on;
    const el = $("#chLoadingMsg");
    const mount = $(".ca-chart-mount");
    const overlay = mount?.querySelector(".ch-stage-fetch-loader");
    if (on) {
      if (el) el.hidden = true;
      const step = overlay?.querySelector(".ws-load-step");
      if (step) step.textContent = chartFetchStepLabel();
      return;
    }
    if (el) el.hidden = true;
  }

  function showChartFetchLoader(mount) {
    if (!mount) return;
    mount.classList.add("ca-chart-mount--fetching");
    let overlay = mount.querySelector(".ch-stage-fetch-loader");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "ch-stage-fetch-loader";
      mount.appendChild(overlay);
    }
    const ws = global.RMWorkspaceLoad;
    if (ws?.mountMiniLoader) {
      ws.mountMiniLoader(overlay, "Shape of Data", chartFetchStepLabel());
    } else if (ws?.loaderShell) {
      overlay.innerHTML = ws.loaderShell({
        size: "mini",
        title: "Shape of Data",
        step: chartFetchStepLabel(),
      });
    } else {
      overlay.innerHTML =
        '<div class="ws-load-shell ws-load-shell--mini" role="status" aria-live="polite" aria-busy="true">' +
        '<p class="ws-load-title">Shape of Data</p>' +
        '<p class="ws-load-step">' +
        escapeHtml(chartFetchStepLabel()) +
        "</p></div>";
    }
    mount.querySelector(".ca-pane-resizer")?.remove();
    setChartLoading(true);
  }

  function clearChartFetchLoader(mount) {
    if (!mount) return;
    mount.classList.remove("ca-chart-mount--fetching");
    const overlay = mount.querySelector(".ch-stage-fetch-loader");
    if (overlay) {
      if (global.RMWorkspaceLoad?.revealSlot) global.RMWorkspaceLoad.revealSlot(overlay);
      overlay.remove();
    }
  }

  function priorCloseForSymbol(sym) {
    const hub = hubState();
    const meta = state.hub?.getBarMeta?.(sym) || hub.barMeta?.[sym];
    if (meta?.priorClose != null) return Number(meta.priorClose);
    if (state.priorClose != null && state.symbol === sym) return state.priorClose;
    if (state.bars?.length && state.symbol === sym) {
      return state.bars[0].open ?? state.bars[0].close;
    }
    return null;
  }

  function dismissSrLine(id) {
    if (!id) return;
    state.dismissedSr[id] = true;
    paint();
  }

  let planFlagTapLock = 0;
  const planFlagTouch = { active: false, pointerId: null, startX: 0, startY: 0 };
  const PLAN_FLAG_MOVE_PX = 14;

  function isMobileChartUI() {
    return (
      typeof matchMedia !== "undefined" && matchMedia("(max-width: 640px)").matches
    );
  }

  function isMobileChartRow() {
    return (
      isMobileChartUI() && document.body.classList.contains("is-mobile-snap-chart")
    );
  }

  function useCollapsedPlanFlag() {
    return !state.tradePlanExpanded;
  }

  function isMobilePerfChart() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function chartLayersEnabled() {
    if (isMobilePerfChart()) return false;
    if (_chartLayersConfig && _chartLayersConfig.enabled === false) return false;
    try {
      const v = localStorage.getItem(CHART_LAYERS_KEY);
      if (v === "0" || v === "false") return false;
    } catch {
      /* ignore */
    }
    return true;
  }

  function wrapChartLayers(intelSvg, dataSvg) {
    if (!chartLayersEnabled()) return intelSvg + dataSvg;
    return (
      '<g class="ca-layer-intel">' +
      intelSvg +
      '</g><g class="ca-layer-data">' +
      dataSvg +
      "</g>"
    );
  }

  function syncPlanMountChrome(mount) {
    if (!mount) return;
    const expanding = !!(state.tradePlan && state.tradePlanExpanded && isMobileChartRow());
    mount.classList.toggle("ca-chart-mount--plan-expanded", expanding);
    mount.classList.toggle(
      "ca-chart-mount--plan-flag",
      !!(state.tradePlan && useCollapsedPlanFlag())
    );
  }

  /** Fast path: plan flag / limit-stop lines only (skip full chart chrome rebuild). */
  function refreshTradePlanVisual() {
    const mount = state.container?.querySelector(".ca-chart-mount");
    if (
      mount &&
      state.bars?.length &&
      !isCompareMode() &&
      state.tradePlan?.symbol === state.symbol
    ) {
      syncPlanMountChrome(mount);
      repaintChartSvg();
      return;
    }
    if (state.container) schedulePaint();
  }

  function collapseTradePlanOnChart() {
    if (!state.tradePlanExpanded) {
      hidePlanPanel();
      return;
    }
    state.tradePlanExpanded = false;
    hidePlanPanel();
    refreshTradePlanVisual();
  }

  function dismissExpandedTradePlan() {
    if (!state.tradePlan || !state.tradePlanExpanded) return;
    collapseTradePlanOnChart();
  }

  function hidePlanPanel() {
    const panel = document.getElementById("caPlanPanel");
    const backdrop = document.getElementById("caPlanPanelBackdrop");
    panel?.classList.add("hidden");
    backdrop?.classList.add("hidden");
    panel?.setAttribute("aria-hidden", "true");
    backdrop?.setAttribute("aria-hidden", "true");
    hideResultsPlanPanel();
  }

  function hideResultsPlanPanel() {
    const slot = document.getElementById("ttResultsPlanSlot");
    if (slot) {
      slot.classList.add("hidden");
      slot.hidden = true;
    }
  }

  function showResultsPlanPanel() {
    if (!state.tradePlan) return;
    hideResultsPlanPanel();
    if (typeof RMUiTips !== "undefined") RMUiTips.hide?.();
    if (typeof RMResultsHero !== "undefined") {
      void RMResultsHero.showSetup(state.tradePlan.symbol, state.tradePlan);
      return;
    }
    ensureResultsPlanPanel();
    const slot = document.getElementById("ttResultsPlanSlot");
    if (slot) {
      slot.classList.remove("hidden");
      slot.hidden = false;
    }
    updatePlanPanelStat();
  }

  function surfacePlanToResults() {
    if (!state.tradePlan) return;
    const sym = state.tradePlan.symbol;
    if (typeof RMUiTips !== "undefined") RMUiTips.hide?.();
    if (typeof RMResultsHero !== "undefined") {
      void RMResultsHero.showSetup(sym, state.tradePlan);
    } else {
      showResultsPlanPanel();
    }
    if (typeof window.surfacingTradePlanToResults === "function") {
      window.surfacingTradePlanToResults(sym);
    }
    const detail = {
      stage: "plan",
      symbol: sym,
      selectKey: state.symbol,
      plan: state.tradePlan,
      source: "chart",
    };
    if (typeof global.dispatchTradeJourney === "function") {
      global.dispatchTradeJourney(detail);
    } else {
      document.dispatchEvent(new CustomEvent("rm:trade-journey", { detail }));
    }
  }

  function activatePlanFlag(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const now = Date.now();
    if (now - planFlagTapLock < 400) return;
    planFlagTapLock = now;
    if (!state.tradePlan) return;
    if (state.tradePlanExpanded) {
      collapseTradePlanOnChart();
      closeTradePreview();
      return;
    }
    surfacePlanToResults();
    state.tradePlanExpanded = true;
    refreshTradePlanVisual();
    // Item 11: slide in the projected-trade mock chart.
    openProjectedTradePreview();
  }

  function chartFocusSymbolForHero() {
    if (typeof RMResultsHero !== "undefined") {
      return RMResultsHero.resolveFocusSymbol();
    }
    if (isCompareMode()) return "SPY";
    const sym = state.symbol;
    if (sym && sym !== COMPARE_SYM) {
      if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolForSelectValue) {
        return global.RMHoldings.chartSymbolForSelectValue(sym) || "SPY";
      }
      if (!/^holding:/i.test(String(sym))) return String(sym).toUpperCase();
    }
    return "SPY";
  }

  function dispatchResultsHero(detail) {
    document.dispatchEvent(
      new CustomEvent("rm:results-hero", { detail: detail || {} })
    );
  }

  function dispatchChartTickerHero(symbol) {
    dispatchResultsHero({
      mode: "ticker",
      symbol: symbol || chartFocusSymbolForHero(),
    });
  }

  function buyMetaFromChartNode(node) {
    const src = node?.dataset?.signalSource || "macd_rsi";
    const isEma = src.startsWith("ema_");
    return {
      kicker: node?.dataset?.fvKicker || (isEma ? "EMA signal" : "Buy"),
      title: node?.dataset?.fvTitle || "",
      desc: node?.dataset?.fvDesc || "",
      time: node?.dataset?.fvStat || "",
      signalSource: src,
      signalType: node?.dataset?.signalType || "",
      signalLabel: node?.dataset?.signalLabel || "",
    };
  }

  function applyEmaSignalFromNode(node) {
    if (!node || typeof RMTradeFooter === "undefined" || !RMTradeFooter.recommendFromEmaSignal) return false;
    const idx = parseInt(node.dataset.barIdx || "", 10);
    if (!Number.isFinite(idx) || !state.bars[idx]) return false;
    const pack = state.lastEmaPack || {};
    const plan = RMTradeFooter.recommendFromEmaSignal({
      symbol: state.symbol,
      barIndex: idx,
      bars: state.bars,
      swingLookback: pack.swingLookback,
      defaultRr: pack.defaultRr,
      signalSource: node.dataset.signalSource,
      signalLabel: node.dataset.signalLabel,
    });
    if (!plan) return false;
    syncTradePlan(plan);
    if (typeof global.RMTradeStory !== "undefined") {
      void global.RMTradeStory.syncPlan(plan, { signal_source: plan.signal_source });
    }
    dispatchResultsHero({
      mode: "signal",
      symbol: chartFocusSymbolForHero(),
      meta: buyMetaFromChartNode(node),
    });
    openProjectedTradePreview();
    return true;
  }

  function isHoldingChartSymbol(sym) {
    return (
      typeof global.RMHoldings !== "undefined" &&
      global.RMHoldings.isHoldingSelectKey?.(String(sym || ""))
    );
  }

  function syncTradePlan(plan) {
    if (!plan?.symbol) {
      state.tradePlan = null;
      collapseTradePlanOnChart();
      paint();
      return;
    }
    const planSym = String(plan.symbol).trim();
    const symKey = isHoldingChartSymbol(planSym)
      ? typeof global.RMHoldings !== "undefined" && global.RMHoldings.normalizeHoldingSelectKey
        ? global.RMHoldings.normalizeHoldingSelectKey(planSym)
        : planSym
      : planSym.toUpperCase();
    if (state.tradePlan?.symbol && state.tradePlan.symbol !== symKey) {
      collapseTradePlanOnChart();
    }
    const rr = plan.rr != null ? Number(plan.rr) : 2;
    state.tradePlan = {
      symbol: symKey,
      entry: round2(plan.entry),
      stop: round2(plan.stop),
      target: round2(plan.target),
      target1: plan.target1 != null ? round2(plan.target1) : null,
      target2: plan.target2 != null ? round2(plan.target2) : null,
      qty: Math.max(1, parseInt(plan.qty, 10) || 100),
      rr,
      orh: plan.orh ?? null,
      orl: plan.orl ?? null,
    };
    applyPlanRR(state.tradePlan, rr);
    if (
      state.symbol !== state.tradePlan.symbol &&
      !isCompareMode() &&
      !isHoldingChartSymbol(state.symbol)
    ) {
      state.symbol = state.tradePlan.symbol;
    }
    paint();
  }

  function refreshTradeOverlay() {
    refreshMorningTradePlan();
    paint();
  }

  function refreshMorningTradePlan() {
    if (isCompareMode()) {
      state.tradePlan = null;
      collapseTradePlanOnChart();
      return;
    }
    if (isHoldingChartSymbol(state.symbol)) {
      state.tradePlan = null;
      collapseTradePlanOnChart();
      return;
    }
    const jf = global.__rmJourneyFocus;
    if (
      jf &&
      (jf.selectKey === state.symbol || jf.symbol === state.symbol) &&
      jf.stage !== "manage" &&
      state.tradePlan
    ) {
      return;
    }
    if (!state.symbol || !state.bars?.length) return;
    const sym = state.symbol;
    if (state.tradePlan?.symbol && state.tradePlan.symbol !== sym) {
      collapseTradePlanOnChart();
    }
    if (typeof RMTradeFooter === "undefined" || !RMTradeFooter.recommendMorningSetup) return;
    const pick = RMTradeFooter.pickForSymbol?.(sym) || null;
    const prev = state.tradePlan;
    const plan = RMTradeFooter.recommendMorningSetup(pick || sym, {
      bars: state.bars,
      srLines: state.srLines,
      rthStartMs: hubState()?.sessionMeta?.periods?.regular?.startMs,
      lastPrice: state.bars[state.bars.length - 1]?.close,
    });
    if (!plan) return;
    const rr = prev?.symbol === sym && prev?.rr != null ? prev.rr : plan.rr ?? 2;
    const qty = prev?.symbol === sym && prev?.qty ? prev.qty : plan.qty ?? 100;
    state.tradePlan = {
      symbol: sym,
      entry: round2(plan.entry),
      stop: round2(plan.stop),
      target: round2(plan.target),
      target1: plan.target1 != null ? round2(plan.target1) : null,
      target2: plan.target2 != null ? round2(plan.target2) : null,
      qty,
      rr,
      orh: plan.orh ?? null,
      orl: plan.orl ?? null,
    };
    applyPlanRR(state.tradePlan, rr);
  }

  function planProfit(plan) {
    if (!plan?.entry || !plan?.target) return null;
    return round2((plan.target - plan.entry) * (plan.qty || 100));
  }

  function planRisk(plan) {
    if (!plan?.entry || !plan?.stop) return null;
    return round2((plan.entry - plan.stop) * (plan.qty || 100));
  }

  function applyPlanRR(plan, rr) {
    const risk = plan.entry - plan.stop;
    if (!risk || risk <= 0) return plan;
    plan.target1 = round2(plan.entry + risk);
    plan.target2 = round2(plan.entry + risk * rr);
    plan.target = plan.target2;
    plan.rr = rr;
    return plan;
  }

  function pushPlanToFooter(plan) {
    const entryEl = document.getElementById("tfEntry");
    const stopEl = document.getElementById("tfStop");
    const targetEl = document.getElementById("tfTarget");
    const qtyEl = document.getElementById("tfQty");
    if (entryEl && plan.entry != null) entryEl.value = plan.entry;
    if (stopEl && plan.stop != null) stopEl.value = plan.stop;
    if (targetEl && plan.target != null) targetEl.value = plan.target;
    if (qtyEl && plan.qty != null) qtyEl.value = plan.qty;
    if (typeof RMTradeFooter !== "undefined" && RMTradeFooter.onPlanChartEdit) {
      RMTradeFooter.onPlanChartEdit(plan);
    }
  }

  function fmtPstTime(ms) {
    return new Date(ms).toLocaleTimeString("en-US", {
      timeZone: PST_TZ,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  function fmtPstRange(tMin, tMax) {
    return fmtPstTime(tMin) + " — " + fmtPstTime(tMax) + " PST";
  }

  function fmtChartDate(ms) {
    return new Date(ms).toLocaleDateString("en-US", {
      timeZone: PST_TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  // ~1.5 days. Above this a window clearly spans multiple sessions, so axis
  // labels and the range readout switch from clock time to calendar dates
  // (otherwise multi-day/multi-month charts show repeating AM/PM times).
  const MULTIDAY_MS = 36 * 60 * 60 * 1000;

  function fmtChartShortDate(ms) {
    return new Date(ms).toLocaleDateString("en-US", {
      timeZone: PST_TZ,
      month: "numeric",
      day: "numeric",
    });
  }

  function fmtAxisTick(ms, spanMs) {
    return spanMs > MULTIDAY_MS ? fmtChartShortDate(ms) : fmtPstTime(ms);
  }

  function fmtAxisRange(tMin, tMax) {
    if (tMax - tMin > MULTIDAY_MS) {
      return fmtChartDate(tMin) + " — " + fmtChartDate(tMax);
    }
    return fmtPstRange(tMin, tMax);
  }

  // Multi-day / daily charts map x by bar index (not wall-clock ms) so weekends
  // and overnight sessions don't leave empty gaps on the plot.
  function shouldUseContinuousAxis() {
    if (state.interval === "1d") return true;
    return rangeDays(state.range) > 1;
  }

  function collectMasterTimes(hub) {
    const set = new Set();
    if (isCompareMode()) {
      for (const p of hub.spyPct || []) {
        if (p?.t != null) set.add(p.t);
      }
      if (!set.size) {
        for (const b of hub.spyBars || []) {
          if (b?.t != null) set.add(b.t);
        }
      }
    } else {
      for (const b of state.bars || []) {
        if (b?.t != null) set.add(b.t);
      }
    }
    return [...set].sort((a, b) => a - b);
  }

  function buildTimeIndex(times) {
    const map = new Map();
    times.forEach((t, i) => map.set(t, i));
    return { times, map, count: times.length };
  }

  function refreshTimeIndex(hub) {
    if (!shouldUseContinuousAxis()) {
      state.timeIndex = null;
      return;
    }
    state.timeIndex = buildTimeIndex(collectMasterTimes(hub));
  }

  function nearestTimeIndex(timeIndex, t) {
    const times = timeIndex?.times;
    const n = times?.length || 0;
    if (!n) return 0;
    if (t <= times[0]) return 0;
    if (t >= times[n - 1]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    if (lo < n - 1 && Math.abs(times[lo + 1] - t) < Math.abs(times[lo] - t)) return lo + 1;
    return lo;
  }

  function timeToAxisRatio(t, ext, timeIndex) {
    if (shouldUseContinuousAxis() && timeIndex?.count > 1) {
      return nearestTimeIndex(timeIndex, t) / (timeIndex.count - 1);
    }
    const span = ext.tMax - ext.tMin;
    return span > 0 ? (t - ext.tMin) / span : 0;
  }

  function axisRatioToTime(ratio, ext, timeIndex) {
    const r = Math.max(0, Math.min(1, ratio));
    if (shouldUseContinuousAxis() && timeIndex?.count > 1) {
      return timeIndex.times[Math.round(r * (timeIndex.count - 1))];
    }
    return ext.tMin + r * (ext.tMax - ext.tMin);
  }

  function viewWindowToIndices(vw, ti) {
    return {
      iMin: nearestTimeIndex(ti, vw.tMin),
      iMax: nearestTimeIndex(ti, vw.tMax),
    };
  }

  function indicesToViewWindow(iMin, iMax, ti) {
    const n = ti.count - 1;
    let lo = Math.max(0, Math.min(n, iMin));
    let hi = Math.max(0, Math.min(n, iMax));
    if (lo > hi) {
      const tmp = lo;
      lo = hi;
      hi = tmp;
    }
    return { tMin: ti.times[lo], tMax: ti.times[hi] };
  }

  function svgTitle(label) {
    if (!label) return "";
    return "<title>" + escapeHtml(label) + "</title>";
  }

  /** Visible indicator stroke + wide transparent hit path for RMUiTips. */
  function renderIndPath(d, opts) {
    if (!d) return "";
    opts = opts || {};
    const title = opts.title || "Indicator";
    const tip = fvTip(
      opts.kicker || "Indicator",
      title,
      opts.desc || "",
      opts.stat || "",
      "chart-ind-line"
    );
    const dash = opts.dash ? ' stroke-dasharray="' + opts.dash + '"' : "";
    const opacity = opts.opacity != null ? ' opacity="' + opts.opacity + '"' : "";
    const filter = opts.filter ? ' filter="' + opts.filter + '"' : "";
    const extra = opts.classExtra ? " " + opts.classExtra : "";
    const idAttr = opts.id ? ' id="' + opts.id + '"' : "";
    return (
      '<g class="ca-ind-line' +
      extra +
      '">' +
      '<path class="ca-ind-visible"' +
      idAttr +
      ' fill="none" stroke="' +
      (opts.color || "#8b9cb3") +
      '" stroke-width="' +
      (opts.width || 1.5) +
      '"' +
      dash +
      opacity +
      filter +
      ' d="' +
      d +
      '" pointer-events="none">' +
      svgTitle(title) +
      "</path>" +
      '<path class="ca-ind-hit fv-tip-target" tabindex="0"' +
      tip +
      ' fill="none" stroke="transparent" stroke-width="14" pointer-events="stroke" d="' +
      d +
      '"/></g>'
    );
  }

  /** Horizontal indicator line (S/R, plan levels, last price dash). */
  function renderIndHLine(x1, y, x2, opts) {
    opts = opts || {};
    const title = opts.title || "Line";
    const tip = fvTip(
      opts.kicker || "Indicator",
      title,
      opts.desc || "",
      opts.stat || "",
      "chart-ind-line"
    );
    const dash = opts.dash ? ' stroke-dasharray="' + opts.dash + '"' : "";
    const opacity = opts.opacity != null ? ' opacity="' + opts.opacity + '"' : "";
    const extra = opts.groupClass ? " " + opts.groupClass : "";
    const visCls =
      "ca-ind-visible" + (opts.visibleClass ? " " + opts.visibleClass : "");
    return (
      '<g class="ca-ind-line' +
      extra +
      '">' +
      '<line class="' +
      visCls +
      '" x1="' +
      x1 +
      '" y1="' +
      y +
      '" x2="' +
      x2 +
      '" y2="' +
      y +
      '" stroke="' +
      (opts.color || "#8b9cb3") +
      '" stroke-width="' +
      (opts.width || 1.5) +
      '"' +
      dash +
      opacity +
      ' pointer-events="none">' +
      svgTitle(title) +
      "</line>" +
      '<line class="ca-ind-hit fv-tip-target" tabindex="0"' +
      tip +
      ' x1="' +
      x1 +
      '" y1="' +
      y +
      '" x2="' +
      x2 +
      '" y2="' +
      y +
      '" stroke="transparent" stroke-width="14"/></g>'
    );
  }

  function renderChartDateLabel(m) {
    if (m.tMin == null || m.tMax == null) return "";
    return (
      '<text class="ca-chart-date" x="' +
      chartRightEdge(m, 10) +
      '" y="' +
      (m.pad.t + 14) +
      '" text-anchor="end" fill="#c5d0de" font-size="12" font-weight="700" font-variant-numeric="tabular-nums">' +
      escapeHtml(fmtAxisRange(m.tMin, m.tMax)) +
      "</text>"
    );
  }

  function fmtPctAxis(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  }

  function fmtPriceAxis(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    if (Math.abs(n) >= 1000) return "$" + n.toFixed(0);
    if (Math.abs(n) >= 100) return "$" + n.toFixed(1);
    return "$" + n.toFixed(2);
  }

  function fmtLastPriceLabel(v, pctMode) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    if (pctMode) return fmtPctAxis(n);
    return "$" + n.toFixed(2);
  }

  function resolveLastPriceQuote(allBars, viewBars, m) {
    if (!allBars?.length || !m) return null;
    const last = allBars[allBars.length - 1];
    const close = last.close;
    if (!Number.isFinite(close)) return null;
    const prev = allBars.length > 1 ? allBars[allBars.length - 1 - 1] : null;
    const pctMode = m.mode === "pct";
    const base = priorCloseForSymbol(state.symbol);
    const yVal = pctMode && base ? ((close - base) / base) * 100 : close;
    const y = m.y(yVal);
    const prevClose = prev?.close ?? last.open ?? close;
    const up = close >= prevClose;
    let xLast = null;
    if (viewBars?.length) {
      const lastInView = viewBars[viewBars.length - 1];
      if (lastInView?.t === last.t) xLast = m.x(lastInView.t);
    }
    return {
      close,
      yVal,
      y,
      xLast,
      up,
      pctMode,
      label: fmtLastPriceLabel(yVal, pctMode),
      title: (state.symbol || "Price") + " last " + fmtLastPriceLabel(yVal, pctMode),
    };
  }

  function renderLastPricePill(m, quote) {
    if (!quote || !Number.isFinite(quote.y)) return "";
    const pillH = isMobileChartUI() ? 16 : 18;
    const fontSize = isMobileChartUI() ? 9 : 10;
    const charW = fontSize * 0.62;
    const pillW = Math.max(42, Math.ceil(quote.label.length * charW) + 14);
    const mainBottom = m.mainH - m.pad.b;
    const yMid = Math.max(
      m.pad.t + pillH / 2 + 2,
      Math.min(mainBottom - pillH / 2 - 2, quote.y)
    );
    const pillRight = m.w - 2;
    const pillLeft = pillRight - pillW;
    const pillTop = yMid - pillH / 2;
    const cc = chartColors();
    const stroke = quote.up ? cc.candleUp : cc.bear;
    const fill = quote.up ? "rgba(45, 184, 168, 0.18)" : "rgba(232,149,79,0.18)";
    const textFill = quote.up ? "#d4f4fa" : "#ffe8d4";
    const lineX1 =
      quote.xLast != null
        ? Math.max(m.pad.l, Math.min(quote.xLast + 4, pillLeft - 6))
        : m.pad.l;
    let svg = '<g class="ca-last-price">';
    svg += renderIndHLine(lineX1, yMid, pillLeft - 3, {
      color: stroke,
      width: 1,
      dash: "5 4",
      opacity: 0.9,
      title: quote.title || "Last price",
      desc: "Most recent close on this range",
      stat: quote.label,
      kicker: "Price",
      groupClass: "ca-last-price-line-wrap",
    });
    svg +=
      '<g pointer-events="none">' +
      '<rect class="ca-last-price-pill" x="' +
      pillLeft +
      '" y="' +
      pillTop +
      '" width="' +
      pillW +
      '" height="' +
      pillH +
      '" rx="' +
      (pillH / 2) +
      '" ry="' +
      (pillH / 2) +
      '" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-width="1.25"/>' +
      '<text class="ca-last-price-pill__text" x="' +
      (pillLeft + pillW / 2) +
      '" y="' +
      (yMid + (fontSize - 2) / 2) +
      '" text-anchor="middle" fill="' +
      textFill +
      '" font-size="' +
      fontSize +
      '" font-weight="700" font-variant-numeric="tabular-nums">' +
      escapeHtml(quote.label) +
      "</text></g></g>";
    return svg;
  }

  // Yahoo 1m pre/post bars often have volume=0 and bogus wick extremes that
  // flatten the whole chart. For axis scaling (and candle wicks), ignore those
  // phantom wicks and cap any remaining single-bar tail to ~3% from close.
  const WICK_SCALE_CAP = 0.03;

  function barLoHiForLayout(b) {
    const c = b.close ?? b.open;
    let lo = b.low ?? c;
    let hi = b.high ?? c;
    if (!c || c <= 0) return { lo, hi };
    if (!b.volume) {
      const bodyLo = Math.min(b.open ?? c, c);
      const bodyHi = Math.max(b.open ?? c, c);
      return { lo: bodyLo, hi: bodyHi };
    }
    lo = Math.max(lo, c * (1 - WICK_SCALE_CAP));
    hi = Math.min(hi, c * (1 + WICK_SCALE_CAP));
    return { lo, hi };
  }

  /** Candle low in axis units — matches wick capping used by renderCandles(). */
  function barLayoutLowAxis(m, bar) {
    const { lo } = barLoHiForLayout(bar);
    return planPriceToY(m, lo);
  }

  function barLayoutLowPx(m, bar) {
    const v = barLayoutLowAxis(m, bar);
    if (v == null || !Number.isFinite(v)) return null;
    return m.y(v);
  }

  function useCloseTightScale() {
    return state.range === "1d" && state.interval !== "1d";
  }

  function addBarToYExtents(b, yMin, yMax, pctMode, base) {
    const c = b.close ?? b.open;
    if (!Number.isFinite(c)) return { yMin, yMax };
    if (useCloseTightScale()) {
      if (pctMode && base) {
        const v = ((c - base) / base) * 100;
        return { yMin: Math.min(yMin, v), yMax: Math.max(yMax, v) };
      }
      return { yMin: Math.min(yMin, c), yMax: Math.max(yMax, c) };
    }
    const { lo, hi } = barLoHiForLayout(b);
    if (pctMode && base) {
      return {
        yMin: Math.min(yMin, ((lo - base) / base) * 100),
        yMax: Math.max(yMax, ((hi - base) / base) * 100),
      };
    }
    return { yMin: Math.min(yMin, lo), yMax: Math.max(yMax, hi) };
  }

  function sliceSeriesForWindow(series, vw) {
    if (!series?.length) return [];
    if (!vw) return series.slice();
    const out = [];
    let before = null;
    for (const p of series) {
      if (p.t < vw.tMin) {
        before = p;
        continue;
      }
      if (p.t > vw.tMax) {
        if (out.length) out.push(p);
        break;
      }
      if (!out.length && before) out.push(before);
      out.push(p);
    }
    return out;
  }

  function sliceBarsForWindow(bars, vw) {
    if (!bars?.length) return [];
    if (!vw) return bars.slice();
    const out = [];
    let before = null;
    for (const b of bars) {
      if (b.t < vw.tMin) {
        before = b;
        continue;
      }
      if (b.t > vw.tMax) {
        if (out.length) out.push(b);
        break;
      }
      if (!out.length && before) out.push(before);
      out.push(b);
    }
    return out;
  }

  function viewXSpanPad(dataSpan) {
    const span = Math.max(dataSpan, 1);
    return Math.max(0.5, span * VIEW_RIGHT_PAD_RATIO);
  }

  function applyXWindow(m, vw, packSeries) {
    m._viewPacked = false;
    m._packTimes = null;
    const pack = packSeries || [];
    if (shouldUseContinuousAxis() && pack.length > 1) {
      const times = pack.map((p) => p.t).filter((t) => t != null);
      if (times.length > 1) {
        const tMap = new Map();
        times.forEach((t, i) => tMap.set(t, i));
        const n = times.length;
        m.tMin = times[0];
        m.tMax = times[n - 1];
        m._continuous = true;
        m._viewPacked = true;
        m._packTimes = times;
        m._iMin = 0;
        m._iMax = n - 1;
        m._timeIndex = state.timeIndex;
        const xSpan = (n - 1) + viewXSpanPad(n - 1);
        m.x = (t) => {
          const i = tMap.has(t) ? tMap.get(t) : nearestTimeIndex({ times }, t);
          return m.pad.l + (i / xSpan) * m.innerW;
        };
        return m;
      }
    }
    const ti = state.timeIndex;
    if (shouldUseContinuousAxis() && ti?.count > 1) {
      let iMin = 0;
      let iMax = ti.count - 1;
      if (vw) {
        iMin = nearestTimeIndex(ti, vw.tMin);
        iMax = nearestTimeIndex(ti, vw.tMax);
        if (iMin > iMax) {
          const tmp = iMin;
          iMin = iMax;
          iMax = tmp;
        }
      }
      m.tMin = ti.times[iMin];
      m.tMax = ti.times[iMax];
      m._continuous = true;
      m._iMin = iMin;
      m._iMax = iMax;
      m._timeIndex = ti;
      const span = (iMax - iMin) + viewXSpanPad(iMax - iMin) || 1;
      m.x = (t) => {
        const idx = ti.map.has(t) ? ti.map.get(t) : nearestTimeIndex(ti, t);
        return m.pad.l + ((idx - iMin) / span) * m.innerW;
      };
      return m;
    }
    m._continuous = false;
    if (!vw) return m;
    m.tMin = vw.tMin;
    const dataSpan = vw.tMax <= vw.tMin ? 1 : vw.tMax - vw.tMin;
    m.tMax = vw.tMax + viewXSpanPad(dataSpan);
    m.x = (t) => m.pad.l + ((t - m.tMin) / (m.tMax - m.tMin)) * m.innerW;
    return m;
  }

  function recomputeYScale(m, yMin, yMax, padRatio) {
    const py = (yMax - yMin) * (padRatio != null ? padRatio : 0.08) || 0.5;
    m.yMin = yMin - py;
    m.yMax = yMax + py;
    const span = m.yMax - m.yMin;
    const base = yMin - py;
    m.y = (v) => m.pad.t + m.innerH - ((v - base) / span) * m.innerH;
    return m;
  }

  function mergeYExtents(m, nextMin, nextMax, maxGrowRatio) {
    if (!Number.isFinite(nextMin) || !Number.isFinite(nextMax)) return m;
    const baseMin = m.yMin;
    const baseMax = m.yMax;
    const baseSpan = baseMax - baseMin;
    if (!Number.isFinite(baseSpan) || baseSpan <= 0) {
      return recomputeYScale(m, nextMin, nextMax, 0.08);
    }
    const grow = maxGrowRatio != null ? maxGrowRatio : 0.12;
    let lo = Math.min(baseMin, nextMin);
    let hi = Math.max(baseMax, nextMax);
    if (lo >= baseMin && hi <= baseMax) return m;
    lo = Math.max(lo, baseMin - baseSpan * grow);
    hi = Math.min(hi, baseMax + baseSpan * grow);
    return recomputeYScale(m, lo, hi, 0.08);
  }

  function refineMetricsForViewWindow(m, seriesList, vw, packSeries) {
    if (!vw) return m;
    let yMin = Infinity;
    let yMax = -Infinity;
    const pctMode = m.mode === "pct";
    const pctBase = pctMode ? priorCloseForSymbol(chartPriceSymbol()) : null;
    for (const s of seriesList) {
      for (const p of s || []) {
        if (p.t < vw.tMin || p.t > vw.tMax) continue;
        if (pctMode && p.pct != null) {
          yMin = Math.min(yMin, p.pct);
          yMax = Math.max(yMax, p.pct);
        }
        if (p.high != null || p.low != null || p.close != null) {
          const ext = addBarToYExtents(p, yMin, yMax, pctMode, pctBase);
          yMin = ext.yMin;
          yMax = ext.yMax;
        }
      }
    }
    applyXWindow(m, vw, packSeries);
    if (!Number.isFinite(yMin)) return m;
    return recomputeYScale(m, yMin, yMax, 0.1);
  }

  function clampYViewOffset(offset) {
    return Math.max(-Y_VIEW_OFFSET_MAX, Math.min(Y_VIEW_OFFSET_MAX, offset || 0));
  }

  function clampYView(yv) {
    const scale = Math.min(8, Math.max(0.2, yv?.scale || 1));
    const offset = clampYViewOffset(yv?.offset);
    return { scale, offset };
  }

  function snapshotAutoYDomain(m) {
    if (!m || !Number.isFinite(m._autoYMin) || !Number.isFinite(m._autoYMax)) return null;
    return { yMin: m._autoYMin, yMax: m._autoYMax };
  }

  function stampAutoYDomain(m) {
    if (!m || !Number.isFinite(m.yMin) || !Number.isFinite(m.yMax)) return m;
    m._autoYMin = m.yMin;
    m._autoYMax = m.yMax;
    return m;
  }

  function applyFrozenYDomain(m, dom) {
    if (!dom || !m) return m;
    m.yMin = dom.yMin;
    m.yMax = dom.yMax;
    const span = m.yMax - m.yMin || 1;
    m.y = (v) => m.pad.t + m.innerH - ((v - m.yMin) / span) * m.innerH;
    return m;
  }

  function applyPanFrozenY(m) {
    if (chartPointer.panning && chartPointer.frozenYDomain) {
      applyFrozenYDomain(m, chartPointer.frozenYDomain);
    }
    return m;
  }

  // Manual Y-axis scale/pan applied on top of the auto-fit domain. scale > 1 zooms
  // the price axis in (taller candles); offset shifts the visible domain (vertical pan,
  // expressed as a fraction of the visible span).
  function applyYView(m) {
    if (!m || m.yMin == null || m.yMax == null) return m;
    const yv = clampYView(state.yView);
    if (yv.scale === 1 && yv.offset === 0) {
      state.yView = yv;
      return m;
    }
    state.yView = yv;
    const lo = m.yMin;
    const hi = m.yMax;
    const center = (lo + hi) / 2;
    const half = (hi - lo) / 2 || 0.5;
    const newHalf = half / yv.scale;
    const shift = yv.offset * newHalf * 2;
    const nMin = center - newHalf + shift;
    const nMax = center + newHalf + shift;
    const span = nMax - nMin || 1;
    m.yMin = nMin;
    m.yMax = nMax;
    m.y = (v) => m.pad.t + m.innerH - ((v - nMin) / span) * m.innerH;
    return m;
  }

  function resetYView() {
    state.yView = { scale: 1, offset: 0 };
  }

  function collectFullExtent(hubRef) {
    const hs = chartHubData(hubRef);
    let tMin = Infinity;
    let tMax = -Infinity;
    if (isCompareMode()) {
      for (const p of hs.spyPct || []) {
        tMin = Math.min(tMin, p.t);
        tMax = Math.max(tMax, p.t);
      }
    } else {
      for (const b of state.bars) {
        tMin = Math.min(tMin, b.t);
        tMax = Math.max(tMax, b.t);
      }
    }
    if (!Number.isFinite(tMin)) return null;
    const out = { tMin, tMax: tMax <= tMin ? tMin + 1 : tMax };
    if (scanMorningViewHeld(hubRef) && !viewPanAnim?.lockTMax) {
      const lead = morningLeadMinMs(hubRef);
      if (lead != null) out.tMin = Math.min(out.tMin, lead);
    }
    return out;
  }

  function spyDataExtent(hubRef) {
    const hs = chartHubData(hubRef);
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const p of hs.spyPct || []) {
      tMin = Math.min(tMin, p.t);
      tMax = Math.max(tMax, p.t);
    }
    if (!Number.isFinite(tMin)) return null;
    return { tMin, tMax: tMax <= tMin ? tMin + 1 : tMax };
  }

  function scanMorningViewHeld(hubRef) {
    return !!(
      hubState().morningScanViewLock ||
      isMorningScanView(hubRef) ||
      viewPanAnim?.lockTMax ||
      scanBrushExtentLock
    );
  }

  function clearMorningScanViewLock() {
    const hub = chartHubRef();
    if (hub?.state) hub.state.morningScanViewLock = false;
  }

  function lockScanBrushExtent(hubRef) {
    const raw = spyDataExtent(hubRef) || state.fullExtent;
    if (!raw) return;
    const lead = morningLeadMinMs(hubRef);
    scanBrushExtentLock = {
      tMin: lead != null ? Math.min(raw.tMin, lead) : raw.tMin,
      tMax: raw.tMax,
    };
  }

  function isMorningScanView(hubRef) {
    const lead = morningLeadMinMs(hubRef);
    const vw = state.viewWindow;
    return !!(
      lead != null &&
      isCompareMode() &&
      vw &&
      vw.tMin <= lead + 3 * 60 * 1000
    );
  }

  /** 5:30 AM on PST chart labels — 1h before 6:30 AM PT / 9:30 ET open. */
  function morningLeadMinMs(hubRef) {
    const hs = chartHubData(hubRef);
    const bars = hs.spyBars || [];
    const anchor =
      bars.length > 0
        ? bars[bars.length - 1].t
        : hs.spyPct?.[hs.spyPct.length - 1]?.t;
    if (!anchor) return null;
    const mins = ptMinutes(anchor);
    return anchor - (mins - PT_SCAN_CHART_LEFT_MIN) * 60 * 1000;
  }

  function allowedViewTMin(e, hubRef) {
    if (!e) return null;
    if (isMorningScanView(hubRef)) {
      const lead = morningLeadMinMs(hubRef);
      if (lead != null) return Math.min(e.tMin, lead);
    }
    return e.tMin;
  }

  function chartBrushExtent(hub) {
    if (scanBrushExtentLock) return { ...scanBrushExtentLock };
    const e = state.fullExtent;
    if (!e) return null;
    let tMin = e.tMin;
    const lead = morningLeadMinMs(hub);
    if (lead != null && scanMorningViewHeld(hub)) {
      tMin = Math.min(tMin, lead);
    }
    return { tMin, tMax: e.tMax };
  }

  function defaultViewWindow(e) {
    const fullSpan = Math.max(e.tMax - e.tMin, 1);
    const visibleSpan = Math.max(MIN_VIEW_WINDOW_MS, fullSpan * DEFAULT_VIEW_VISIBLE_RATIO);
    let tMin = e.tMax - visibleSpan;
    if (tMin < e.tMin) tMin = e.tMin;
    return { tMin, tMax: e.tMax };
  }

  function ensureViewWindow() {
    if (viewPanAnim) return;
    const before = state.viewWindow ? { ...state.viewWindow } : null;
    const e = state.fullExtent;
    if (!e) {
      state.viewWindow = null;
      return;
    }
    const hubRef = chartHubRef();
    const minT = allowedViewTMin(e, hubRef);
    if (!state.viewWindow) {
      state.viewWindow = defaultViewWindow(e);
      return;
    }
    const span = state.viewWindow.tMax - state.viewWindow.tMin;
    const fullSpan = e.tMax - e.tMin;
    const scanMorningHold = scanMorningViewHeld(hubRef);
    // After switching from intraday to multi-year daily, keep the old zoom window
    // (a few hours) and slice down to 0–1 bars — reset to default zoom instead.
    if (fullSpan > 0 && span < fullSpan * 0.15 && !scanMorningHold) {
      state.viewWindow = defaultViewWindow(e);
      return;
    }
    if (
      (span < MIN_VIEW_WINDOW_MS || span > fullSpan * 1.01) &&
      !scanMorningHold
    ) {
      state.viewWindow = defaultViewWindow(e);
      return;
    }
    let tMin = state.viewWindow.tMin;
    let tMax = state.viewWindow.tMax;
    if (tMax < minT || tMin > e.tMax) {
      state.viewWindow = defaultViewWindow(e);
      return;
    }
    if (tMin < minT) {
      if (scanMorningHold) {
        tMin = minT;
      } else {
        tMax += minT - tMin;
        tMin = minT;
      }
    }
    if (tMax > e.tMax) {
      tMin -= tMax - e.tMax;
      tMax = e.tMax;
    }
    if (tMax - tMin < MIN_VIEW_WINDOW_MS) {
      state.viewWindow = defaultViewWindow(e);
      return;
    }
    const next = { tMin, tMax };
    if (before && (before.tMin !== next.tMin || before.tMax !== next.tMax)) {
    }
    state.viewWindow = next;
  }

  function viewContextKey() {
    return String(state.range || "") + "|" + String(state.interval || "");
  }

  function markViewContextChanged() {
    const key = viewContextKey();
    if (state._viewContextKey && state._viewContextKey !== key) {
      if (!scanMorningViewHeld(chartHubRef()) && !hubState().scanActive) {
        resetViewWindow();
      }
    }
    state._viewContextKey = key;
  }

  function resetViewWindow(opts) {
    const held = scanMorningViewHeld(chartHubRef());
    if (held && opts?.force !== true) return;
    scanBrushExtentLock = null;
    state.viewWindow = null;
    resetYView();
    ensureViewWindow();
  }

  function updateFullExtent(hubRef) {
    state.fullExtent = collectFullExtent(hubRef || chartHubRef());
    if (!viewPanAnim) {
      ensureViewWindow();
    }
  }

  /** Keep the user's current zoom; only ensure a view + stable brush track for scan intro. */
  function prepareScanIntroFromView(hubRef) {
    if (!state.fullExtent) state.fullExtent = collectFullExtent(hubRef);
    if (!state.viewWindow && state.fullExtent) {
      state.viewWindow = defaultViewWindow(state.fullExtent);
    }
    lockScanBrushExtent(hubRef);
    paintNow();
  }

  function tradePlanProjectionEnd(bars) {
    if (!bars?.length) return null;
    return bars[bars.length - 1].t + TRADE_PLAN_PROJ_MS;
  }

  /** Next RTH open (ET) after the last bar — anchor for the mobile buy flag. */
  function nextSessionOpenMs(bars) {
    if (!bars?.length) return null;
    const lastT = bars[bars.length - 1].t;
    const lastDay = etDayKey(lastT);
    let probe = lastT + 10 * 60 * 60 * 1000;
    for (let i = 0; i < 40; i++) {
      const dk = etDayKey(probe);
      const mins = etMinutes(probe);
      if (dk > lastDay && mins >= ET_RTH_OPEN_MIN - 2) {
        const openProbe = probe - (mins - ET_RTH_OPEN_MIN) * 60 * 1000;
        return openProbe;
      }
      probe += 60 * 60 * 1000;
    }
    return lastT + TRADE_PLAN_PROJ_MS;
  }

  function planFlagHitRect(x, yEntry, poleTop, flagW) {
    const mobile = isMobileChartUI();
    const fw = flagW ?? (mobile ? 14 : 18);
    const padX = mobile ? 12 : 10;
    const padY = mobile ? 12 : 10;
    const labelW = mobile ? 56 : 64;
    let top = (poleTop != null ? poleTop : yEntry) - padY;
    const bottom = yEntry + padY;
    if (top >= bottom) top = bottom - Math.max(8, padY * 2);
    const left = x - fw - labelW - padX;
    const right = x + padX + 6;
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  function chartRightEdge(m, inset) {
    return m.w - m.pad.r - (inset != null ? inset : 6);
  }

  /** Place end-of-line labels so text grows left and stays inside the plot. */
  function endLabelAnchor(m, xAt, reserve) {
    const edge = chartRightEdge(m, reserve != null ? reserve : 8);
    const x = Math.max(m.pad.l + 4, Math.min(xAt - 6, edge));
    return { x, anchor: x >= edge - 24 ? "end" : "start" };
  }

  function timeTickAnchor(m, x) {
    const edge = chartRightEdge(m, 4);
    if (x >= edge - 32) return { x: edge, anchor: "end" };
    if (x <= m.pad.l + 32) return { x: m.pad.l + 4, anchor: "start" };
    return { x, anchor: "middle" };
  }

  function planFlagX(m, viewBars) {
    if (!viewBars?.length) return m.pad.l + 40;
    const last = viewBars[viewBars.length - 1];
    const reserve = isMobileChartUI() ? 82 : 96;
    const xBar = m.x(last.t);
    return Math.max(m.pad.l + 20, Math.min(xBar + 6, chartRightEdge(m, reserve)));
  }

  /** Y of chart date label — upper bound for the flag pole. */
  function planFlagDateY(m) {
    return m.pad.t + 14;
  }

  /** Pole top halfway between entry and date row; stays below date text. */
  function planFlagPoleTop(m, yEntryPx, expanded) {
    const dateY = planFlagDateY(m);
    const clearance = expanded ? 20 : isMobileChartUI() ? 26 : 30;
    const minTop = dateY + clearance;
    const baseOffset = expanded ? 16 : isMobileChartUI() ? 22 : 26;
    const baseTop = yEntryPx - baseOffset;
    const midTop = baseTop + (dateY - baseTop) * 0.5;
    return Math.max(minTop, midTop);
  }

  /** Pennant at pole top (pole drawn separately). Waves on hover via CSS. */
  function planFlagFabricSvg(x, poleTop, flagW, flagH) {
    const cc = chartColors();
    const d =
      "M0 0 L" + -flagW + " " + flagH * 0.35 + " L0 " + flagH + " Z";
    return (
      '<g class="ca-plan-flag-mount" transform="translate(' +
      x +
      " " +
      poleTop +
      ')">' +
      '<g class="ca-plan-flag-fabric" pointer-events="none">' +
      '<path class="ca-plan-flag-shape" d="' +
      d +
      '" fill="' +
      cc.tradeNode +
      '" stroke="' +
      cc.bullStrong +
      '" stroke-width="0.75"/>' +
      "</g></g>"
    );
  }

  function renderMorningBuyFlag(m, viewBars, plan) {
    const cc = chartColors();
    const entryVal = planPriceToY(m, plan.entry);
    if (entryVal == null || !Number.isFinite(entryVal)) return "";
    const yEntry = m.y(entryVal);
    if (!Number.isFinite(yEntry)) return "";
    const x = planFlagX(m, viewBars);
    const poleTop = planFlagPoleTop(m, yEntry, false);
    const flagW = isMobileChartUI() ? 14 : 18;
    const flagH = isMobileChartUI() ? 10 : 13;
    const hit = planFlagHitRect(x, yEntry, poleTop, flagW);
    const profit = planProfit(plan);
    const risk = planRisk(plan);
    const rr =
      plan.rr != null
        ? plan.rr
        : plan.entry > plan.stop
          ? ((plan.target2 ?? plan.target) - plan.entry) / (plan.entry - plan.stop)
          : 0;
    const labelX = x - flagW - (isMobileChartUI() ? 8 : 10);
    const lineX1 = Math.max(m.pad.l, x - 72);
    const lineX2 = Math.min(chartRightEdge(m, 4), x + 4);
    return (
      '<g class="ca-trade-plan ca-trade-plan--flag-only">' +
      '<line class="ca-plan-entry-mark" x1="' +
      lineX1 +
      '" y1="' +
      yEntry +
      '" x2="' +
      lineX2 +
      '" y2="' +
      yEntry +
      '" stroke="' +
      cc.tradeNode +
      '" stroke-width="2" stroke-dasharray="6 4" opacity="0.95">' +
      svgTitle("Buy limit · next open $" + Number(plan.entry).toFixed(2)) +
      "</line>" +
      '<g class="ca-plan-flag ca-plan-flag--buy fv-tip-target" tabindex="0" data-plan-flag="1" aria-label="' +
      (isMobileChartUI()
        ? "Morning setup buy at next open. Tap to expand levels, tap again for Target Trades."
        : "Morning setup buy at next open. Tap to expand levels, tap again to edit setup.") +
      '">' +
      '<rect class="ca-plan-flag-hit" pointer-events="all" x="' +
      hit.x +
      '" y="' +
      hit.y +
      '" width="' +
      hit.width +
      '" height="' +
      hit.height +
      '" fill="rgba(61,186,122,0.001)" stroke="none"/>' +
      fvTip(
        "RM morning setup",
        plan.symbol + " · buy next open",
        "Limit buy at $" +
          Number(plan.entry).toFixed(2) +
          " on the following session open. Tap flag to show full setup.",
        (profit != null ? "Proj profit $" + profit : "") +
          (risk != null ? " · Risk $" + risk : "") +
          " · " +
          plan.qty +
          " sh · " +
          (rr ? rr.toFixed(1) + "R" : ""),
        "plan-flag"
      ) +
      '><line pointer-events="none" x1="' +
      x +
      '" y1="' +
      poleTop +
      '" x2="' +
      x +
      '" y2="' +
      yEntry +
      '" stroke="' +
      cc.tradeNode +
      '" stroke-width="2"/>' +
      planFlagFabricSvg(x, poleTop, flagW, flagH) +
      '<text pointer-events="none" class="ca-plan-flag-label" x="' +
      labelX +
      '" y="' +
      (poleTop + flagH * 0.72) +
      '" text-anchor="end" fill="' +
      cc.tradeNode +
      '" font-size="' +
      (isMobileChartUI() ? 9 : 11) +
      '" font-weight="800">BUY</text>' +
      '<text pointer-events="none" class="ca-plan-flag-price" x="' +
      labelX +
      '" y="' +
      (poleTop + flagH + 9) +
      '" text-anchor="end" fill="#9ed4b8" font-size="' +
      (isMobileChartUI() ? 8 : 9) +
      '" font-weight="600">$' +
      Number(plan.entry).toFixed(2) +
      "</text></g></g>"
    );
  }

  function dispatchSelectTradePlan() {
    const sym = state.tradePlan?.symbol;
    if (!sym) return;
    hidePlanPanel();
    if (typeof window.selectTradeSetup === "function") {
      window.selectTradeSetup(sym);
      return;
    }
    document.dispatchEvent(
      new CustomEvent("rm:select-ticker", { detail: { symbol: sym, toggle: false } })
    );
  }

  function bindRmRecStripMount(mount) {
    if (!mount || mount.dataset.rmRecBound === "1") return;
    mount.dataset.rmRecBound = "1";
    mount.addEventListener("click", (e) => {
      if (!e.target.closest("#caRmRec")) return;
      e.preventDefault();
      e.stopPropagation();
      dispatchSelectTradePlan();
    });
  }

  function loadAllNotes() {
    try {
      return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveAllNotes(data) {
    localStorage.setItem(NOTES_KEY, JSON.stringify(data));
  }

  function notesForSymbol(sym) {
    const key = isCompareMode() ? "SPY" : markerStorageKey(sym);
    return loadAllNotes()[key] || [];
  }

  function noteStorageKey(sym) {
    return isCompareMode() ? "SPY" : markerStorageKey(sym || state.symbol);
  }

  function persistNote(sym, note) {
    const key = noteStorageKey(sym);
    const all = loadAllNotes();
    const list = all[key] || [];
    if (!Array.isArray(note.tags)) note.tags = [];
    const idx = list.findIndex((n) => n.id === note.id);
    if (idx >= 0) list[idx] = note;
    else list.push(note);
    all[key] = list;
    saveAllNotes(all);
    document.dispatchEvent(new CustomEvent("rm:notes-updated", { detail: { symbol: key, id: note.id } }));
    return note;
  }

  function deleteNote(sym, id) {
    const key = noteStorageKey(sym);
    const all = loadAllNotes();
    all[key] = (all[key] || []).filter((n) => n.id !== id);
    saveAllNotes(all);
    document.dispatchEvent(new CustomEvent("rm:notes-updated", { detail: { symbol: key, id } }));
  }

  function reflectTagsForNotes() {
    if (typeof RMTradeDebrief !== "undefined" && RMTradeDebrief.REFLECT_TAGS) {
      return RMTradeDebrief.REFLECT_TAGS;
    }
    return [
      { id: "regime_mismatch", label: "Regime mismatch" },
      { id: "no_plan", label: "No plan" },
      { id: "stop_honored", label: "Stop honored" },
      { id: "good_process", label: "Good process" },
    ];
  }

  function loadAllTradeMarkers() {
    try {
      return JSON.parse(localStorage.getItem(TRADES_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function markerStorageKey(sym) {
    return barsFetchSymbol(String(sym || "").trim()) || String(sym || "").toUpperCase();
  }

  function chartSymbolMatches(a, b) {
    return markerStorageKey(a) === markerStorageKey(b);
  }

  function tradeMarkersForSymbol(sym) {
    const all = loadAllTradeMarkers();
    const chartSym = markerStorageKey(sym);
    const raw = String(sym || "").trim().toUpperCase();
    const keys = new Set();
    if (chartSym && chartSym !== COMPARE_SYM) keys.add(chartSym);
    if (raw && raw !== COMPARE_SYM) keys.add(raw);
    const seen = new Set();
    const out = [];
    for (const k of keys) {
      for (const tm of all[k] || []) {
        if (!tm?.id || seen.has(tm.id)) continue;
        seen.add(tm.id);
        out.push(tm);
      }
    }
    return out.sort((a, b) => (a.t || 0) - (b.t || 0));
  }

  function saveTradeMarker(marker, opts) {
    const key = markerStorageKey(marker.symbol);
    if (!key) return null;
    const all = loadAllTradeMarkers();
    const list = all[key] || [];
    const id = marker.id || "tm-" + Date.now();
    const existing = list.findIndex((m) => m.id === id);
    const entry = {
      id,
      symbol: key,
      entry: marker.entry_price,
      exit: marker.exit_price ?? null,
      stop: marker.stop_price,
      target: marker.target_price,
      t: marker.t || Date.now(),
      exit_t: marker.exit_t || (marker.closed_at ? Date.parse(marker.closed_at) : null),
      closed_at: marker.closed_at || null,
      session_id: marker.session_id || null,
      filled: marker.filled !== false,
      label: marker.label || null,
    };
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
    all[key] = list.slice(-48);
    localStorage.setItem(TRADES_KEY, JSON.stringify(all));
    if (
      !(opts && opts.skipServerSync) &&
      typeof global.RMTradeStory !== "undefined" &&
      global.RMTradeStory.syncChartMarker
    ) {
      void global.RMTradeStory.syncChartMarker(entry);
    }
    if (chartSymbolMatches(state.symbol, key)) paint();
    return entry;
  }

  async function syncSchwabMarkersForChart(chartSym) {
    if (typeof global.RMSchwabData === "undefined") return;
    const now = Date.now();
    if (now - schwabMarkerSyncAt < 15000) return;
    schwabMarkerSyncAt = now;
    try {
      if (global.RMSchwabData.applyCachedChartMarkers) {
        const n = global.RMSchwabData.applyCachedChartMarkers();
        if (n) return;
      }
      if (global.RMSchwabData.refreshSchwabTrades) {
        await global.RMSchwabData.refreshSchwabTrades(true);
      }
    } catch {
      schwabMarkerSyncAt = 0;
    }
  }

  function chartTapSymbol() {
    return isCompareMode() ? "SPY" : barsFetchSymbol(state.symbol);
  }

  function chartPointerBlocksDrag(target) {
    return target.closest(
      ".ca-plan-flag, .ca-plan-flag-hit, [data-plan-flag], .ca-sr-line, .ca-sr-line-hit, .ca-pane-resizer, #caNoteEditor, .ca-time-brush, .ca-scan-menu"
    );
  }

  function chartTapTarget(target) {
    return target.closest(
      ".ca-chart-node, .ca-ind-hit, .ca-fv-hit, .ca-holding-band"
    );
  }

  function scanCircleRadiusPx(scan, m) {
    if (!scan || !m?.x || !m?.y) return 4;
    if (scan.radiusPx > 0) return scan.radiusPx;
    if (scan.centerT == null || scan.centerP == null) return 4;
    const vk = scan.valueKey || "price";
    const cx = m.x(scan.centerT);
    const centerAxis = scanCenterAxisY(m, scan);
    const cy = m.y(centerAxis);
    const rx =
      scan.radiusT != null ? Math.abs(m.x(scan.centerT + scan.radiusT) - cx) : 0;
    const ry =
      scan.radiusP != null
        ? Math.abs(
            m.y(axisStoredValueToChart(m, scan.centerP + scan.radiusP, vk)) - cy
          )
        : 0;
    return Math.max(4, rx, ry);
  }

  function scanRimAnchor(scan, clientX, clientY) {
    const m = state.metrics;
    const svg = $("#caChartSvg");
    if (!m?.x || !m?.y || !svg || scan?.centerT == null || scan.centerP == null) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const cx = m.x(scan.centerT);
    const cy = m.y(scanCenterAxisY(m, scan));
    const rPx = scanCircleRadiusPx(scan, m);
    const sx = ((clientX - rect.left) / rect.width) * m.w;
    const sy = ((clientY - rect.top) / rect.height) * m.h;
    let angle = Math.atan2(sy - cy, sx - cx);
    if (!Number.isFinite(angle)) angle = -Math.PI / 2;
    const px = cx + rPx * Math.cos(angle);
    const py = cy + rPx * Math.sin(angle);
    const rimClientX = rect.left + (px / m.w) * rect.width;
    const rimClientY = rect.top + (py / m.h) * rect.height;
    const data = chartPointFromClient(rimClientX, rimClientY);
    if (!data) return null;
    return {
      angle,
      px,
      py,
      t: data.t,
      price: data.price,
      pct: data.pct,
    };
  }

  function openNoteForScan(scan, clientX, clientY) {
    const anchor = scanRimAnchor(scan, clientX, clientY);
    if (!anchor) return false;
    const key = noteStorageKey(state.symbol);
    const all = loadAllNotes();
    let note =
      (scan.noteId && (all[key] || []).find((n) => n.id === scan.noteId)) ||
      (all[key] || []).find((n) => n.scan_id === scan.id);

    if (!note) {
      note = {
        id: "n-" + Date.now(),
        t: anchor.t,
        scan_id: scan.id,
        scan_angle: anchor.angle,
        text: scan.note || "",
        tags: [],
      };
      if (state.metrics?.mode === "pct" && anchor.pct != null) note.pct = anchor.pct;
      else if (anchor.price != null) note.price = anchor.price;
    } else {
      note.scan_id = scan.id;
      note.scan_angle = anchor.angle;
      note.t = anchor.t;
      if (state.metrics?.mode === "pct" && anchor.pct != null) note.pct = anchor.pct;
      else if (anchor.price != null) note.price = anchor.price;
      if (scan.note && !note.text) note.text = scan.note;
    }

    persistNote(key, note);
    state.activeNoteId = note.id;
    state.noteEditorAnchor = { x: anchor.px, y: anchor.py };
    syncNoteEditor();
    paint();
    requestAnimationFrame(() => {
      positionNoteEditorOverlay();
      const input = noteEditorHost($(".ca-chart-mount"))?.querySelector("#caNoteInput");
      input?.focus();
      input?.select();
    });
    return true;
  }

  function renderChartNode(opts) {
    const kind = opts.kind || "event";
    const style = nodeStyle(kind);
    const x = opts.x;
    const y = opts.y;
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) return "";
    const active = opts.active ? " ca-chart-node--active" : "";
    let attrs =
      ' class="ca-chart-node ca-chart-node--' +
      kind +
      active +
      ' fv-tip-target" tabindex="0" data-node-kind="' +
      kind +
      '"';
    if (opts.id) attrs += ' data-note-id="' + escapeAttr(opts.id) + '"';
    if (opts.nodeId) attrs += ' data-node-id="' + escapeAttr(opts.nodeId) + '"';
    if (opts.markerId) attrs += ' data-marker-id="' + escapeAttr(opts.markerId) + '"';
    if (opts.symbol) attrs += ' data-symbol="' + escapeAttr(opts.symbol) + '"';
    attrs += fvTip(
      opts.kicker || style.kicker,
      opts.title || "",
      opts.desc || "",
      opts.stat || ""
    );
    const r = opts.active ? 9 : 7;
    const stroke = opts.active ? "#fcd34d" : "#fff";
    const strokeW = opts.active ? 2.5 : 1.5;
    return (
      "<g" +
      attrs +
      '><circle cx="' +
      x +
      '" cy="' +
      y +
      '" r="' +
      r +
      '" fill="' +
      style.fill +
      '" stroke="' +
      stroke +
      '" stroke-width="' +
      strokeW +
      '"/><text x="' +
      x +
      '" y="' +
      (y + 3) +
      '" text-anchor="middle" fill="#fff" font-size="8" pointer-events="none">?</text></g>'
    );
  }

  function nearestBarIndex(bars, ms) {
    if (!bars?.length || ms == null) return -1;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const d = Math.abs(bars[i].t - ms);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function findDayExtrema(bars) {
    if (!bars?.length) return [];
    const out = [];
    let maxIdx = 0;
    let minIdx = 0;
    for (let i = 0; i < bars.length; i++) {
      const h = bars[i].high ?? bars[i].close;
      const l = bars[i].low ?? bars[i].close;
      const maxH = bars[maxIdx].high ?? bars[maxIdx].close;
      const minL = bars[minIdx].low ?? bars[minIdx].close;
      if (h >= maxH) maxIdx = i;
      if (l <= minL) minIdx = i;
    }
    out.push({
      idx: maxIdx,
      kind: "high",
      t: bars[maxIdx].t,
      price: bars[maxIdx].high ?? bars[maxIdx].close,
    });
    if (minIdx !== maxIdx) {
      out.push({
        idx: minIdx,
        kind: "low",
        t: bars[minIdx].t,
        price: bars[minIdx].low ?? bars[minIdx].close,
      });
    }
    for (let i = 2; i < bars.length - 2; i++) {
      const h = bars[i].high ?? bars[i].close;
      const l = bars[i].low ?? bars[i].close;
      const isHigh =
        h > (bars[i - 1].high ?? bars[i - 1].close) &&
        h > (bars[i + 1].high ?? bars[i + 1].close);
      const isLow =
        l < (bars[i - 1].low ?? bars[i - 1].close) &&
        l < (bars[i + 1].low ?? bars[i + 1].close);
      if (isHigh) out.push({ idx: i, kind: "high", t: bars[i].t, price: h });
      if (isLow) out.push({ idx: i, kind: "low", t: bars[i].t, price: l });
    }
    return out;
  }

  function parseHeadlineMs(h) {
    const pub = h?.published || h?.pubDate || h?.date;
    if (!pub) return null;
    const ms = Date.parse(pub);
    return Number.isNaN(ms) ? null : ms;
  }

  function headlinesForSymbol(sym) {
    const hub = hubState();
    const cat = hub.newsBySym?.get?.(sym);
    if (!cat) return [];
    if (cat.headlines?.length) return cat.headlines;
    if (cat.headline) return [{ title: cat.headline, published: cat.published }];
    return [];
  }

  function headlinesForChartSymbol(sym) {
    return headlinesForSymbol(barsFetchSymbol(sym || state.symbol));
  }

  async function ensureSymbolNews(sym) {
    const fetchSym = barsFetchSymbol(sym);
    if (!fetchSym || fetchSym === COMPARE_SYM || typeof global.RMNewsScan === "undefined") {
      return;
    }
    const hub = hubState();
    if (hub.newsBySym?.get?.(fetchSym)?.headlines?.length) return;
    try {
      const result = await global.RMNewsScan.scanSymbolNews(fetchSym);
      const headlines = (result.articles || []).map((a) => ({
        title: a.title,
        url: a.link,
        published: a.date,
      }));
      if (headlines.length && hub.newsBySym) {
        hub.newsBySym.set(fetchSym, {
          headlines,
          headline: headlines[0]?.title || "",
          status: result.hasCatalyst ? "confirmed" : "proxy",
        });
      }
    } catch {
      /* optional */
    }
  }

  function buildNewsNodes(bars, sym) {
    if (!bars?.length) return [];
    const extrema = findDayExtrema(bars);
    const headlines = headlinesForSymbol(sym);
    const nodes = [];
    const seen = new Set();
    for (const h of headlines) {
      const ms = parseHeadlineMs(h);
      if (ms == null) continue;
      const idx = nearestBarIndex(bars, ms);
      if (idx < 0) continue;
      const nearExtrema = extrema.some((ex) => Math.abs(ex.idx - idx) <= 3);
      if (!nearExtrema) continue;
      const key = idx + "-" + String(h.title || "").slice(0, 48);
      if (seen.has(key)) continue;
      seen.add(key);
      const bar = bars[idx];
      nodes.push({
        kind: "news",
        nodeId: "news-" + sym + "-" + idx + "-" + nodes.length,
        t: bar.t,
        price: bar.close,
        title: sym,
        desc: h.title || "News",
        stat: new Date(ms).toLocaleString(),
      });
    }
    return nodes;
  }

  function pickHighlightNodes(bars, pick) {
    if (!bars?.length || !pick) return [];
    const extrema = findDayExtrema(bars);
    const sym = pick.symbol;
    const out = [];
    const high = extrema.find((e) => e.kind === "high");
    const low = extrema.find((e) => e.kind === "low");
    const first = bars[0];
    if (first) {
      out.push({
        kind: "pick",
        nodeId: "pick-open",
        symbol: sym,
        t: first.t,
        price: first.close,
        title: sym + " · session open",
        desc: "First bar of the trading day",
        stat: fmtPstTime(first.t) + " PST",
      });
    }
    if (high) {
      out.push({
        kind: "pick",
        nodeId: "pick-high",
        symbol: sym,
        t: high.t,
        price: high.price,
        title: sym + " · day high",
        desc: "Session high — click to deselect",
        stat: fmtPstTime(high.t) + " PST",
      });
    }
    if (low && (!high || low.idx !== high.idx)) {
      out.push({
        kind: "pick",
        nodeId: "pick-low",
        symbol: sym,
        t: low.t,
        price: low.price,
        title: sym + " · day low",
        desc: "Session low — click to deselect",
        stat: fmtPstTime(low.t) + " PST",
      });
    }
    return out;
  }

  function pricePlausibleForBar(price, bar) {
    if (!bar || !Number.isFinite(price)) return false;
    const ref = bar.close ?? bar.open ?? bar.high ?? bar.low;
    if (!Number.isFinite(ref) || ref <= 0) return false;
    return price >= ref * 0.45 && price <= ref * 1.55;
  }

  function tradeMarkerTimeMs(tm, role) {
    if (role === "exit") {
      if (tm.exit_t != null && Number.isFinite(tm.exit_t)) return tm.exit_t;
      if (tm.closed_at) {
        const ms = Date.parse(tm.closed_at);
        if (Number.isFinite(ms)) return ms;
      }
    }
    return tm.t;
  }

  function tradeMarkerYPx(m, bars, tm, role) {
    const ms = tradeMarkerTimeMs(tm, role);
    const bar = nearestBarByTime(bars, ms) || bars[0];
    const raw = role === "exit" ? tm.exit : tm.entry;
    if (!bar) return yPxFromPrice(m, Number(raw));
    if (tm.label || !pricePlausibleForBar(Number(raw), bar)) {
      const field = role === "exit" ? "high" : "low";
      return m.y(barFieldToAxis(m, bar, field));
    }
    return yPxFromPrice(m, Number(raw));
  }

  function setDebriefWindow(opts) {
    if (!opts || !opts.symbol) {
      state.debriefWindow = null;
      return;
    }
    state.debriefWindow = {
      symbol: markerStorageKey(opts.symbol),
      tStart: opts.tStart != null ? opts.tStart : null,
      tEnd: opts.tEnd != null ? opts.tEnd : null,
    };
  }

  function clearDebriefWindow() {
    state.debriefWindow = null;
    state.activeTradeMarkerId = null;
    state.instrumentContext = null;
    paint();
  }

  function focusDebriefWindow(tStart, tEnd) {
    if (!Number.isFinite(tStart) || !Number.isFinite(tEnd)) return;
    const tMin = Math.min(tStart, tEnd);
    const tMax = Math.max(tStart, tEnd);
    const span = Math.max(tMax - tMin, 15 * 60 * 1000);
    const pad = span * 0.35;
    state.viewWindow = { tMin: tMin - pad, tMax: tMax + pad };
  }

  function openHoldingsForChart(sym) {
    if (typeof global.RMHoldings === "undefined" || !global.RMHoldings.getDisplayOpen) return [];
    const chartSym = markerStorageKey(barsFetchSymbol(sym || state.symbol));
    if (!chartSym || chartSym === COMPARE_SYM) return [];
    return global.RMHoldings.getDisplayOpen().filter(function (h) {
      const cs =
        typeof global.RMHoldings.chartSymbolFor === "function"
          ? global.RMHoldings.chartSymbolFor(h)
          : h.symbol;
      return cs && markerStorageKey(cs) === chartSym && h.entry_price != null;
    });
  }

  function renderHoldingBands(m, viewBars) {
    if (!viewBars?.length || isCompareMode()) return "";
    const holdings = openHoldingsForChart(state.symbol);
    if (!holdings.length) return "";
    const vw = state.viewWindow;
    const lastBar = viewBars[viewBars.length - 1];
    const lastPrice = lastBar?.close;
    if (!Number.isFinite(lastPrice)) return "";
    let svg = "";
    for (const h of holdings) {
      const entry = Number(h.entry_price);
      if (!Number.isFinite(entry) || entry <= 0) continue;
      const entryMs = Date.parse(h.entry_date || h.opened_at || "");
      const t0 = Number.isFinite(entryMs) ? entryMs : viewBars[0].t;
      if (vw && (t0 > vw.tMax || lastBar.t < vw.tMin)) continue;
      const x0 = m.x(Math.max(t0, vw ? vw.tMin : t0));
      const x1 = m.x(lastBar.t);
      const yEntry = m.y(entry);
      const yLast = m.y(lastPrice);
      const top = Math.min(yEntry, yLast);
      const height = Math.max(2, Math.abs(yLast - yEntry));
      const left = Math.min(x0, x1);
      const width = Math.max(6, Math.abs(x1 - x0));
      const profit = lastPrice >= entry;
      const fill = profit ? "rgba(61,186,122,0.14)" : "rgba(232,149,79,0.14)";
      const stroke = profit ? "rgba(61,186,122,0.5)" : "rgba(232,149,79,0.5)";
      const hid = escapeAttr(String(h.id || h.symbol || ""));
      svg +=
        '<rect class="ca-holding-band" data-holding-id="' +
        hid +
        '" x="' +
        left +
        '" y="' +
        top +
        '" width="' +
        width +
        '" height="' +
        height +
        '" fill="' +
        fill +
        '" stroke="' +
        stroke +
        '" stroke-width="1" pointer-events="auto"/>' +
        '<line class="ca-holding-band-entry" x1="' +
        left +
        '" x2="' +
        (left + width) +
        '" y1="' +
        yEntry +
        '" y2="' +
        yEntry +
        '" stroke="' +
        stroke +
        '" stroke-width="1.5" stroke-dasharray="4 3" pointer-events="none"/>';
    }
    return svg;
  }

  function renderDebriefWindow(m, bars) {
    const dw = state.debriefWindow;
    const chartSym = chartPriceSymbol();
    if (!dw || dw.symbol !== chartSym || !bars?.length) return "";
    if (dw.tStart == null || dw.tEnd == null) return "";
    const tMin = Math.min(dw.tStart, dw.tEnd);
    const tMax = Math.max(dw.tStart, dw.tEnd);
    const x0 = m.x(tMin);
    const x1 = m.x(tMax);
    if (!Number.isFinite(x0) || !Number.isFinite(x1)) return "";
    const y0 = m.pad.t;
    const y1 = m.mainH - m.pad.b;
    const left = Math.min(x0, x1);
    const width = Math.abs(x1 - x0);
    return (
      '<rect x="' +
      left +
      '" y="' +
      y0 +
      '" width="' +
      width +
      '" height="' +
      (y1 - y0) +
      '" fill="rgba(212,162,74,0.10)" stroke="rgba(212,162,74,0.35)" stroke-width="1" pointer-events="none" class="ca-debrief-window"/>'
    );
  }

  function setActiveTradeMarker(markerId, instrumentLabel) {
    state.activeTradeMarkerId = markerId || null;
    if (instrumentLabel !== undefined) {
      state.instrumentContext = instrumentLabel || null;
    }
    paintToolbar();
    const mount = $(".ca-chart-mount");
    if (mount) ensureChartStatus(mount);
    paint();
  }

  function markerIsActive(tm, role) {
    const active = state.activeTradeMarkerId;
    if (!active || !tm?.id) return false;
    if (active === tm.id) return true;
    return active === tm.id + "-" + role;
  }

  function renderTradeMarkers(m, bars) {
    if (!bars?.length) return "";
    const chartSym = isCompareMode() ? "SPY" : chartPriceSymbol();
    void syncSchwabMarkersForChart(chartSym);
    const markers = tradeMarkersForSymbol(chartSym);
    if (!markers.length) return "";
    const vw = state.viewWindow;
    let svg = "";
    for (const tm of markers) {
      const inst = tm.label ? " (" + tm.label + ")" : "";
      const tipSym = state.instrumentContext || tm.label || chartSym;
      if (tm.entry != null && Number.isFinite(Number(tm.entry))) {
        const entryMs = tradeMarkerTimeMs(tm, "entry");
        const entryBar =
          nearestBarByTime(bars, entryMs) || bars.find((b) => b.t >= entryMs) || bars[0];
        const entryY = tradeMarkerYPx(m, bars, tm, "entry");
        if (
          entryBar &&
          entryY != null &&
          (!vw || entryMs == null || (entryMs >= vw.tMin && entryMs <= vw.tMax))
        ) {
          svg += renderChartNode({
            kind: "trade",
            nodeId: tm.id + "-entry",
            markerId: tm.id,
            active: markerIsActive(tm, "entry"),
            x: m.x(entryBar.t),
            y: entryY,
            title: tipSym + " entry" + inst,
            desc: "Entry $" + Number(tm.entry).toFixed(2) + inst,
            stat: fmtPstTime(entryMs) + " PST",
          });
        }
      }
      if (tm.exit != null && Number.isFinite(Number(tm.exit))) {
        const exitMs = tradeMarkerTimeMs(tm, "exit");
        const exitBar =
          nearestBarByTime(bars, exitMs) || bars.find((b) => b.t >= exitMs) || bars[bars.length - 1];
        const exitY = tradeMarkerYPx(m, bars, tm, "exit");
        if (
          exitBar &&
          exitY != null &&
          (!vw || exitMs == null || (exitMs >= vw.tMin && exitMs <= vw.tMax))
        ) {
          svg += renderChartNode({
            kind: "trade",
            nodeId: tm.id + "-exit",
            markerId: tm.id,
            active: markerIsActive(tm, "exit"),
            x: m.x(exitBar.t) + 10,
            y: exitY,
            title: tipSym + " exit" + inst,
            desc: "Exit $" + Number(tm.exit).toFixed(2) + inst,
            stat: fmtPstTime(exitMs) + " PST",
          });
        }
      }
    }
    return svg;
  }

  function renderNewsNodes(m, bars, sym) {
    const vw = state.viewWindow;
    let svg = "";
    for (const n of buildNewsNodes(bars, sym)) {
      if (vw && (n.t < vw.tMin || n.t > vw.tMax)) continue;
      svg += renderChartNode({
        kind: "news",
        nodeId: n.nodeId,
        x: m.x(n.t),
        y: yPxFromPrice(m, n.price),
        title: n.title,
        desc: n.desc,
        stat: n.stat,
      });
    }
    return svg;
  }

  function renderMapHighlightNodes(m, bars) {
    const hl = state.mapHighlight;
    if (!hl || hl.symbol !== state.symbol || !bars?.length) return "";
    const vw = state.viewWindow;
    let svg = "";
    for (const n of pickHighlightNodes(bars, hl.pick)) {
      if (vw && (n.t < vw.tMin || n.t > vw.tMax)) continue;
      svg += renderChartNode({
        kind: "pick",
        nodeId: n.nodeId,
        symbol: n.symbol,
        x: m.x(n.t),
        y: yPxFromPrice(m, n.price),
        title: n.title,
        desc: n.desc,
        stat: n.stat,
      });
    }
    return svg;
  }

  function calcEMA(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function calcMACD(closes) {
    const ema12 = calcEMA(closes, 12);
    const ema26 = calcEMA(closes, 26);
    const macd = ema12.map((v, i) => v - ema26[i]);
    const signal = calcEMA(macd, 9);
    const hist = macd.map((v, i) => v - signal[i]);
    return { macd, signal, hist };
  }

  function calcRSI(closes, period) {
    period = period || 14;
    const out = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < period) {
        out.push(50);
        continue;
      }
      let gains = 0;
      let losses = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = closes[j] - closes[j - 1];
        if (d >= 0) gains += d;
        else losses -= d;
      }
      const rs = losses === 0 ? 100 : gains / losses;
      out.push(100 - 100 / (1 + rs));
    }
    return out;
  }

  // Wilder's smoothing (a.k.a. RMA / SMMA), matching ThinkScript
  // MovingAverage(AverageType.WILDERS, ...). Seeded with the first value, then
  // w[i] = (w[i-1] * (length - 1) + x[i]) / length.
  function calcWilders(values, length) {
    const out = [];
    let prev = values.length ? values[0] : 0;
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : (prev * (length - 1) + values[i]) / length;
      out.push(prev);
    }
    return out;
  }

  // ThinkScript "macdrsi_BUY" / TrendReversal signal:
  //   Diff = MACD(12,26,9).Diff   (histogram = macd line - signal line)
  //   twoBarPivotMACD = Diff>Diff[1] and Diff[1]>Diff[2] and Diff[2]<Diff[3] and Diff[3]<Diff[4]
  //   RSI = Wilders RSI(14); overSoldRSI = RSI <= 30
  //   TrendReversal = twoBarPivotMACD and highest(overSoldRSI[1], 4) > 0
  // i.e. a 2-bar pivot low in the MACD histogram while RSI was oversold within the
  // previous 4 bars.
  function calcMacdRsiBuySignals(closes, opts) {
    const o = opts || {};
    const fast = o.fast || 12;
    const slow = o.slow || 26;
    const sigLen = o.signal || 9;
    const rsiLen = o.rsiLength || 14;
    const rsiFloor = o.rsiFloor != null ? o.rsiFloor : 30;
    const n = closes.length;
    const flags = new Array(n).fill(false);
    if (n < slow + 5) return { signals: flags, diff: [], rsi: [] };

    const emaFast = calcEMA(closes, fast);
    const emaSlow = calcEMA(closes, slow);
    const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
    const signalLine = calcEMA(macdLine, sigLen);
    const diff = macdLine.map((v, i) => v - signalLine[i]);

    const chg = closes.map((p, i) => (i === 0 ? 0 : p - closes[i - 1]));
    const absChg = chg.map((v) => Math.abs(v));
    const netAvg = calcWilders(chg, rsiLen);
    const totAvg = calcWilders(absChg, rsiLen);
    const rsi = closes.map((_, i) => {
      const ratio = totAvg[i] !== 0 ? netAvg[i] / totAvg[i] : 0;
      return 50 * (ratio + 1);
    });

    for (let i = 4; i < n; i++) {
      const twoBarPivot =
        diff[i] > diff[i - 1] &&
        diff[i - 1] > diff[i - 2] &&
        diff[i - 2] < diff[i - 3] &&
        diff[i - 3] < diff[i - 4];
      if (!twoBarPivot) continue;
      let oversoldRecent = false;
      for (let k = 1; k <= 4; k++) {
        if (i - k >= 0 && rsi[i - k] <= rsiFloor) {
          oversoldRecent = true;
          break;
        }
      }
      flags[i] = twoBarPivot && oversoldRecent;
    }
    return { signals: flags, diff, rsi };
  }

  /** Place buy-bag below candle low; skip markers that would orphan on the pane floor. */
  function layoutBuyBag(m, yLowPx, scale) {
    if (!Number.isFinite(yLowPx)) return null;
    const bottom = m.mainH - m.pad.b;
    const top = m.pad.t;
    const floorBag = bottom - 28;
    if (yLowPx < top - 4 || yLowPx > bottom - 4) return null;
    const anchor = yLowPx;
    const bagY = Math.min(anchor + 22, floorBag);
    if (bagY - anchor < 6) return null;
    if (bagY >= floorBag - 2 && anchor < floorBag - 30) return null;
    return { anchor, bagY, stemTop: bagY - 11 * (scale || 1) };
  }

  /** Compact money-bag glyph (~18×22 local units). Coins jingle on hover/click via CSS + buy_bag_fx.js. */
  function moneyBagGlyph() {
    return (
      '<rect class="ca-buy-bag-hit" x="-11" y="-12" width="22" height="26" fill="rgba(240,198,74,0.001)"/>' +
      '<g class="ca-buy-bag__bag" pointer-events="none">' +
      '<path d="M-4 -4.2 C-7.8 0.2 -8.2 6.2 -4.8 9.2 C-2.2 11.2 2.2 11.2 4.8 9.2 C8.2 6.2 7.8 0.2 4 -4.2 Z" fill="#d4a017" stroke="#5c4208" stroke-width="0.75"/>' +
      '<path d="M-4 -4.2 C-2.5 2 2.5 2 4 -4.2 Z" fill="#f5d76e" opacity="0.55"/>' +
      '<path d="M-1.8 -0.5 C-2.2 3.5 -0.8 6.5 0.5 7.2" fill="none" stroke="rgba(255,248,210,0.5)" stroke-width="0.9" stroke-linecap="round"/>' +
      '<path d="M-4.5 -4.2 L-2.8 -8.2 L2.8 -8.2 L4.5 -4.2 Z" fill="#b8860b" stroke="#5c4208" stroke-width="0.6"/>' +
      '<path d="M-2.2 -8.2 C0 -9.6 2.2 -9.6 2.2 -8.2" fill="none" stroke="#4a3606" stroke-width="0.7" stroke-linecap="round"/>' +
      '<circle cx="0" cy="-8.8" r="0.9" fill="#ffe566" stroke="#8b6914" stroke-width="0.45"/>' +
      '<text x="0" y="5.2" text-anchor="middle" font-size="6.5" font-weight="800" fill="#2a1f05" font-family="system-ui,sans-serif">$</text>' +
      "</g>" +
      '<g class="ca-buy-bag__coins" pointer-events="none">' +
      '<circle class="ca-buy-bag__coin ca-buy-bag__coin--1" cx="-7" cy="-2" r="1.65" fill="#fcd34d" stroke="#a16207" stroke-width="0.4"/>' +
      '<circle class="ca-buy-bag__coin ca-buy-bag__coin--2" cx="7" cy="-3" r="1.5" fill="#fde68a" stroke="#a16207" stroke-width="0.4"/>' +
      '<circle class="ca-buy-bag__coin ca-buy-bag__coin--3" cx="-8" cy="3" r="1.35" fill="#fbbf24" stroke="#92400e" stroke-width="0.4"/>' +
      '<circle class="ca-buy-bag__coin ca-buy-bag__coin--4" cx="8" cy="2" r="1.55" fill="#fcd34d" stroke="#a16207" stroke-width="0.4"/>' +
      '<circle class="ca-buy-bag__coin ca-buy-bag__coin--5" cx="0" cy="-9" r="1.25" fill="#fde68a" stroke="#a16207" stroke-width="0.4"/>' +
      '<circle class="ca-buy-bag__coin ca-buy-bag__coin--6" cx="-3" cy="-7" r="1.1" fill="#fbbf24" stroke="#92400e" stroke-width="0.4"/>' +
      "</g>"
    );
  }

  function renderEmaSignalMarkers(m, fullBars) {
    if (
      !state.indicators.emaStack ||
      typeof global.RMEmaOverlay === "undefined" ||
      typeof global.RMEmaSignals === "undefined"
    ) {
      return "";
    }
    const stack = global.RMEmaOverlay.computeStack(fullBars);
    if (!stack) return "";
    const pack = global.RMEmaSignals.detect(fullBars, stack);
    state.lastEmaPack = pack;
    const vw = state.viewWindow;
    const tipSym = symbolLabel(state.symbol);
    const scale = isMobileChartUI() ? 0.95 : 1.08;
    let svg = "";
    for (const ev of pack.events) {
      if (vw && (ev.t < vw.tMin || ev.t > vw.tMax)) continue;
      const bar = fullBars[ev.i];
      if (!bar) continue;
      const x = m.x(bar.t);
      const yLow = barLayoutLowPx(m, bar);
      if (yLow == null) continue;
      if (ev.type === "death_cross" && ev.marker) {
        const y = yLow - 8;
        svg +=
          '<g class="ca-chart-node ca-ema-death fv-tip-target" tabindex="0" data-node-kind="signal" data-signal-type="death_cross" data-signal-source="ema_death_cross" data-bar-idx="' +
          ev.i +
          '" data-signal-label="' +
          escapeAttr(ev.label) +
          '"' +
          fvTip(
            "Wait",
            tipSym + " · " + ev.label,
            global.RMEmaSignals.tooltipForEvent(ev),
            fmtPstTime(bar.t) + " PST",
            "ema-death"
          ) +
          '><line x1="' +
          (x - 4) +
          '" y1="' +
          (y - 4) +
          '" x2="' +
          (x + 4) +
          '" y2="' +
          (y + 4) +
          '" stroke="#f97316" stroke-width="1.4"/><line x1="' +
          (x + 4) +
          '" y1="' +
          (y - 4) +
          '" x2="' +
          (x - 4) +
          '" y2="' +
          (y + 4) +
          '" stroke="#f97316" stroke-width="1.4"/></g>';
        continue;
      }
      if (!ev.tap) continue;
      const bagClass =
        ev.type === "golden_cross"
          ? "ca-buy-bag--ema-golden"
          : "ca-buy-bag--ema-pullback";
      const bagLayout = layoutBuyBag(m, yLow, scale);
      if (!bagLayout) continue;
      const bagY = bagLayout.bagY;
      const stemTop = bagLayout.stemTop;
      const title = tipSym + " · " + ev.label;
      const desc = global.RMEmaSignals.tooltipForEvent(ev);
      svg +=
        '<g class="ca-chart-node ca-buy-bag ca-buy-bag--ema ' +
        bagClass +
        ' fv-tip-target" tabindex="0" data-node-kind="signal" data-signal-type="' +
        escapeAttr(ev.type) +
        '" data-signal-source="' +
        escapeAttr(ev.signalSource) +
        '" data-bar-idx="' +
        ev.i +
        '" data-signal-label="' +
        escapeAttr(ev.label) +
        '" data-node-id="' +
        escapeAttr("ema-" + ev.type + "-" + bar.t) +
        '"' +
        fvTip("EMA", title, desc, fmtPstTime(bar.t) + " PST", "ema-signal") +
        ">" +
        '<line class="ca-buy-bag-stem" pointer-events="none" x1="' +
        x +
        '" y1="' +
        bagLayout.anchor +
        '" x2="' +
        x +
        '" y2="' +
        stemTop +
        '" stroke="rgba(78,184,201,0.55)" stroke-width="1"/>' +
        '<g class="ca-buy-bag__scene" transform="translate(' +
        x +
        "," +
        bagY +
        ") scale(" +
        scale +
        ')">' +
        moneyBagGlyph() +
        "</g></g>";
    }
    return svg;
  }

  function renderMacdRsiBuySignals(m, fullBars, viewBars, opts) {
    if (!state.indicators.macdrsiBuy) return "";
    const calcBars = fullBars || viewBars;
    if (!calcBars || calcBars.length < 31) return "";
    const closes = calcBars.map((b) => b.close);
    const { signals } = calcMacdRsiBuySignals(closes);
    const vw = state.viewWindow;
    const tipSym =
      opts?.tipSymbol ||
      (isCompareMode() ? "SPY" : symbolLabel(state.symbol));
    const scale = isMobileChartUI() ? 0.95 : 1.08;
    let svg = "";
    for (let i = 0; i < calcBars.length; i++) {
      if (!signals[i]) continue;
      const bar = calcBars[i];
      if (vw && (bar.t < vw.tMin || bar.t > vw.tMax)) continue;
      const x = m.x(bar.t);
      const yLow = barLayoutLowPx(m, bar);
      if (yLow == null) continue;
      const bagLayout = layoutBuyBag(m, yLow, scale);
      if (!bagLayout) continue;
      const bagY = bagLayout.bagY;
      const stemTop = bagLayout.stemTop;
      svg +=
        '<g class="ca-chart-node ca-buy-bag ca-buy-bag--macd fv-tip-target" tabindex="0" data-node-kind="buy" data-signal-source="macd_rsi" data-node-id="' +
        escapeAttr("macdrsi-buy-" + bar.t) +
        '"' +
        fvTip(
          "Buy",
          tipSym + " buy signal",
          "MACD histogram 2-bar pivot up with RSI oversold in the prior 4 bars.",
          fmtPstTime(bar.t) + " PST",
          "buy-flag"
        ) +
        ">" +
        '<line class="ca-buy-bag-stem" pointer-events="none" x1="' +
        x +
        '" y1="' +
        bagLayout.anchor +
        '" x2="' +
        x +
        '" y2="' +
        stemTop +
        '" stroke="#d4a017" stroke-width="1.1" stroke-dasharray="2 2" opacity="0.75"/>' +
        '<g class="ca-buy-bag__scene" transform="translate(' +
        x +
        " " +
        bagY +
        ") scale(" +
        scale +
        ')">' +
        moneyBagGlyph() +
        "</g></g>";
    }
    return svg;
  }

  const ICHIMOKU_DISPLACE = 26;
  /** Tenkan/Kijun need 26 bars; Senkou B cloud needs 52 (not 78). */
  const ICHIMOKU_MIN_BARS = 26;

  function calcIchimoku(bars) {
    const mid = (i, len) => {
      const slice = bars.slice(Math.max(0, i - len + 1), i + 1);
      const highs = slice.map((b) => b.high ?? b.close);
      const lows = slice.map((b) => b.low ?? b.close);
      return (Math.max(...highs) + Math.min(...lows)) / 2;
    };
    const tenkan = bars.map((_, i) => mid(i, 9));
    const kijun = bars.map((_, i) => mid(i, 26));
    const spanA = tenkan.map((t, i) => (t + kijun[i]) / 2);
    const spanB = bars.map((_, i) => mid(i, 52));
    return { tenkan, kijun, spanA, spanB };
  }

  function ichimokuInputBars(bars, pctMode) {
    if (!pctMode || !bars.length) return bars;
    const base = priorCloseForSymbol(chartPriceSymbol());
    if (!base) return bars;
    const toPct = (p) =>
      Number.isFinite(p) ? ((p - base) / base) * 100 : NaN;
    return bars.map((b) => ({
      t: b.t,
      open: toPct(b.open ?? b.close),
      high: toPct(b.high ?? b.close),
      low: toPct(b.low ?? b.close),
      close: toPct(b.close),
    }));
  }

  function buildIchimokuView(fullBars, viewBars) {
    const ichi = calcIchimoku(fullBars);
    const indexByT = new Map();
    for (let i = 0; i < fullBars.length; i++) indexByT.set(fullBars[i].t, i);
    const viewIdx = viewBars.map((b) => {
      const i = indexByT.get(b.t);
      return i != null ? i : -1;
    });
    return { ichi, viewIdx };
  }

  function ichimokuSeriesAtView(values, viewIdx) {
    return viewIdx.map((fi) => (fi >= 0 && Number.isFinite(values[fi]) ? values[fi] : NaN));
  }

  function includeIchimokuInMetrics(m, pack, viewBars) {
    if (!pack || !viewBars.length) return m;
    const { ichi, viewIdx } = pack;
    const k = ICHIMOKU_DISPLACE;
    let iMin = Infinity;
    let iMax = -Infinity;
    for (let vi = 0; vi < viewBars.length; vi++) {
      const fi = viewIdx[vi];
      if (fi < 0) continue;
      const pts = [];
      const si = fi - k;
      if (si >= 0) pts.push(ichi.spanA[si], ichi.spanB[si]);
      for (const v of pts) {
        if (!Number.isFinite(v)) continue;
        iMin = Math.min(iMin, v);
        iMax = Math.max(iMax, v);
      }
    }
    if (!Number.isFinite(iMin)) return m;
    return mergeYExtents(m, iMin, iMax, 0.1);
  }

  function findSupportResistance(bars, priorClose) {
    // One support + one resistance (draggable). Derive levels from the actual
    // visible price action (percentile of lows/highs) so they always land ON
    // the chart instead of an arbitrary +/-1% of prior close that scrolls off
    // the auto-scaled viewport. Reuse any drag override so a hand-placed level
    // survives a data reload.
    const ov = state.srOverrides || {};
    let support = null;
    let resist = null;
    const valid = (bars || []).filter(
      (b) => b && (b.low ?? b.close) != null && (b.high ?? b.close) != null
    );
    if (valid.length >= 8) {
      const lows = valid.map((b) => b.low ?? b.close).sort((a, b) => a - b);
      const highs = valid.map((b) => b.high ?? b.close).sort((a, b) => a - b);
      const at = (arr, p) =>
        arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
      support = at(lows, 0.12);
      resist = at(highs, 0.88);
    } else {
      const pc =
        priorClose ??
        priorCloseForSymbol(state.symbol) ??
        (bars?.length ? bars[0].open ?? bars[0].close : null);
      if (!pc) return [];
      support = pc * 0.99;
      resist = pc * 1.01;
    }
    const lines = [
      {
        id: "sr-support",
        price: round2(ov["sr-support"] ?? support),
        kind: "support",
        label: "Support",
      },
      {
        id: "sr-resist",
        price: round2(ov["sr-resist"] ?? resist),
        kind: "resistance",
        label: "Resistance",
      },
    ];
    return lines.filter((l) => !state.dismissedSr[l.id]);
  }

  function computePctMetrics(spyPct, extraSeries, width, layout) {
    const w = Math.max(280, width || 640);
    const totalH = layout?.totalH || state.h || 320;
    const mainH = layout?.mainH ?? totalH;
    const paneH = layout?.paneH || 0;
    const pad = { l: 46, r: 6, t: 12, b: 26 };
    const innerW = w - pad.l - pad.r;
    const innerH = mainH - pad.t - pad.b;
    let yMin = Infinity;
    let yMax = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;
    const all = [spyPct].concat(extraSeries || []);
    for (const s of all) {
      for (const p of s) {
        yMin = Math.min(yMin, p.pct);
        yMax = Math.max(yMax, p.pct);
        tMin = Math.min(tMin, p.t);
        tMax = Math.max(tMax, p.t);
      }
    }
    if (!Number.isFinite(yMin)) {
      yMin = -1;
      yMax = 1;
      tMin = Date.now() - 3600000;
      tMax = Date.now();
    }
    const py = (yMax - yMin) * 0.1 || 0.5;
    const dataSpan = tMax <= tMin ? 1 : tMax - tMin;
    const xSpan = dataSpan + viewXSpanPad(dataSpan);
    return {
      w,
      h: totalH,
      mainH,
      paneH,
      pad,
      innerW,
      innerH,
      yMin: yMin - py,
      yMax: yMax + py,
      tMin,
      tMax: tMax <= tMin ? tMin + 1 : tMax,
      mode: "pct",
      x: (t) => pad.l + ((t - tMin) / xSpan) * innerW,
      y: (v) => pad.t + innerH - ((v - (yMin - py)) / (yMax - yMin + 2 * py)) * innerH,
    };
  }

  function indicatorPaneCount() {
    let n = 0;
    // Volume is no longer its own row - it renders as a faint overlay anchored
    // to the bottom of the main price pane (see renderVolumeOverlay).
    if (state.indicators.macd) n++;
    if (state.indicators.rsi) n++;
    return n;
  }

  function layoutChartHeights(totalH, paneCount) {
    if (!paneCount) {
      return { totalH, mainH: totalH, paneH: 0, paneCount: 0 };
    }
    const split = Math.min(0.85, Math.max(0.45, state.paneSplit || 0.72));
    const mainH = Math.max(80, Math.floor(totalH * split));
    const rem = Math.max(0, totalH - mainH);
    const paneH = Math.max(24, Math.floor(rem / paneCount));
    return {
      totalH,
      mainH: Math.max(80, totalH - paneH * paneCount),
      paneH,
      paneCount,
    };
  }

  function measureChartSize() {
    const main = state.container?.querySelector(".chart-hub-main");
    const stage =
      state.container?.querySelector(".ca-analysis-stage") ||
      state.container?.querySelector(".chart-hub-stage");
    const wrap = stage?.querySelector(".ca-chart-svg-wrap");
    const brush = stage?.querySelector(".ca-time-brush:not([hidden])");
    const toolbar = state.container?.querySelector(".ca-toolbar-wrap");
    const mountChrome = chartMountChromeHeight(stage);
    const mobileChartSnap =
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-snap-chart");
    const brushReserve = brush?.offsetHeight || (mobileChartSnap ? 30 : 36);

    const w = Math.max(280, main?.clientWidth || stage?.clientWidth || 640);
    let h = 0;

    if (wrap && wrap.clientHeight >= 48) {
      h = wrap.clientHeight;
    } else if (stage && stage.clientHeight >= 48) {
      h = stage.clientHeight - mountChrome;
      if (!brush && state.fullExtent) h -= brushReserve;
    } else if (main && main.clientHeight >= 48) {
      h = main.clientHeight - (toolbar?.offsetHeight || 0) - mountChrome;
      if (!brush && state.fullExtent) h -= brushReserve;
    } else {
      h = Math.max(200, Math.round(w * 0.48));
    }

    state.w = w;
    state.h = Math.max(160, Math.floor(h));
    return { w: state.w, h: state.h };
  }

  function chartTotalHeight() {
    return state.h;
  }

  function pctAsBars(series) {
    return (series || []).map((p) => ({
      t: p.t,
      open: p.pct,
      high: p.pct,
      low: p.pct,
      close: p.pct,
    }));
  }

  function renderIndicatorPanes(closes, bars, m) {
    let svg = "";
    let yOff = m.mainH;
    m._indicatorPanes = [];
    const paneH = m.paneH || Math.max(36, Math.floor((m.h - m.mainH) / Math.max(1, indicatorPaneCount())));
    const paneW = m.w - m.pad.l - m.pad.r;
    if (state.indicators.macd && closes.length > 26 && bars.length > 26) {
      const macd = calcMACD(closes);
      const histMin = Math.min(...macd.hist);
      const histMax = Math.max(...macd.hist);
      const scale = Math.max(Math.abs(histMin), Math.abs(histMax)) || 1;
      m._indicatorPanes.push({
        kind: "macd",
        y0: yOff,
        h: paneH,
        scale,
        midY: yOff + paneH / 2,
      });
      svg +=
        '<rect x="' +
        m.pad.l +
        '" y="' +
        yOff +
        '" width="' +
        paneW +
        '" height="' +
        paneH +
        '" fill="rgba(0,0,0,0.22)"/>' +
        renderMacdSub(macd, bars, m, yOff, paneH);
      yOff += paneH;
    }
    if (state.indicators.rsi && closes.length > 15 && bars.length > 15) {
      m._indicatorPanes.push({
        kind: "rsi",
        y0: yOff,
        h: paneH,
        min: 0,
        max: 100,
        pad: 4,
      });
      svg +=
        '<rect x="' +
        m.pad.l +
        '" y="' +
        yOff +
        '" width="' +
        paneW +
        '" height="' +
        paneH +
        '" fill="rgba(0,0,0,0.22)"/>' +
        renderSubPane(calcRSI(closes), bars, m, yOff, paneH, chartColors().accent, "RSI");
    }
    return svg;
  }

  function computePriceLayout(bars, width, layout) {
    const w = Math.max(280, width || 640);
    const totalH = layout?.totalH || state.h || 320;
    const mainH = layout?.mainH ?? totalH;
    const paneH = layout?.paneH || 0;
    const pad = { l: 46, r: 6, t: 12, b: 26 };
    let yMin = Infinity;
    let yMax = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;
    const pctMode = usePctAxis();
    const base = priorCloseForSymbol(chartPriceSymbol());
    for (const b of bars) {
      const close = b.close;
      const ext = addBarToYExtents(b, yMin, yMax, pctMode, base);
      yMin = ext.yMin;
      yMax = ext.yMax;
      tMin = Math.min(tMin, b.t);
      tMax = Math.max(tMax, b.t);
    }
    if (!Number.isFinite(yMin)) {
      yMin = pctMode ? -1 : 0;
      yMax = pctMode ? 1 : 1;
      tMin = Date.now() - 3600000;
      tMax = Date.now();
    }
    const py = (yMax - yMin) * 0.1 || (pctMode ? 0.5 : 0.5);
    const innerW = w - pad.l - pad.r;
    const innerH = mainH - pad.t - pad.b;
    return {
      w,
      h: totalH,
      mainH,
      paneH,
      pad,
      innerW,
      innerH,
      yMin: yMin - py,
      yMax: yMax + py,
      tMin,
      tMax: tMax <= tMin ? tMin + 1 : tMax,
      mode: pctMode ? "pct" : "price",
      x: (t) => pad.l + ((t - tMin) / (tMax - tMin)) * innerW,
      y: (v) => pad.t + innerH - ((v - (yMin - py)) / (yMax - yMin + 2 * py)) * innerH,
      _indicatorPanes: [],
    };
  }

  function priceSeriesToPct(bars, priorClose) {
    const base = priorClose || bars[0]?.open || bars[0]?.close;
    if (!base) return [];
    return bars.map((b) => ({
      t: b.t,
      pct: ((b.close - base) / base) * 100,
    }));
  }

  function compareSpyBase(spyBars, hub) {
    return (spyBars?.[0]?.close) ?? (hub?.spyBars?.[0]?.close) ?? null;
  }

  /** Map overlay %-vs-open onto SPY's price scale for $ compare mode. */
  function compareRebasePctToPrice(pct, spyBase) {
    if (spyBase == null || pct == null || !Number.isFinite(pct)) return null;
    return spyBase * (1 + pct / 100);
  }

  /** Bar-shaped series for Y-extent math in compare $ mode (SPY + rebased picks). */
  function compareDollarSeriesLists(hub, spyBars) {
    const spyBase = compareSpyBase(spyBars, hub);
    const toBarSeries = (pctSeries) =>
      (pctSeries || [])
        .map((p) => {
          const close = compareRebasePctToPrice(p.pct, spyBase);
          if (close == null) return null;
          return { t: p.t, close, high: close, low: close };
        })
        .filter(Boolean);
    const lists = [spyBars || hub?.spyBars || []];
    for (const o of hub?.overlays?.values() || []) {
      lists.push(toBarSeries(o.series));
    }
    if (hub?.candidateSeries) lists.push(toBarSeries(hub.candidateSeries));
    return lists;
  }

  function computeComparePriceMetrics(spyBars, width, layout, hub) {
    const w = Math.max(280, width || 640);
    const totalH = layout?.totalH || state.h || 320;
    const mainH = layout?.mainH ?? totalH;
    const paneH = layout?.paneH || 0;
    const pad = { l: 46, r: 6, t: 12, b: 26 };
    let yMin = Infinity;
    let yMax = -Infinity;
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const b of spyBars || []) {
      const hi = b.high ?? b.close;
      const lo = b.low ?? b.close;
      yMin = Math.min(yMin, lo);
      yMax = Math.max(yMax, hi);
      tMin = Math.min(tMin, b.t);
      tMax = Math.max(tMax, b.t);
    }
    const spyBase = compareSpyBase(spyBars, hub);
    for (const o of hub?.overlays?.values() || []) {
      for (const p of o.series || []) {
        const v = compareRebasePctToPrice(p.pct, spyBase);
        if (v == null) continue;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
        tMin = Math.min(tMin, p.t);
        tMax = Math.max(tMax, p.t);
      }
    }
    if (hub?.candidateSeries) {
      for (const p of hub.candidateSeries) {
        const v = compareRebasePctToPrice(p.pct, spyBase);
        if (v == null) continue;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
        tMin = Math.min(tMin, p.t);
        tMax = Math.max(tMax, p.t);
      }
    }
    if (!Number.isFinite(yMin)) {
      yMin = 0;
      yMax = 1;
      tMin = Date.now() - 3600000;
      tMax = Date.now();
    }
    const py = (yMax - yMin) * 0.1 || 0.5;
    const innerW = w - pad.l - pad.r;
    const innerH = mainH - pad.t - pad.b;
    return {
      w,
      h: totalH,
      mainH,
      paneH,
      pad,
      innerW,
      innerH,
      yMin: yMin - py,
      yMax: yMax + py,
      tMin,
      tMax: tMax <= tMin ? tMin + 1 : tMax,
      mode: "price",
      x: (t) => pad.l + ((t - tMin) / (tMax - tMin)) * innerW,
      y: (v) => pad.t + innerH - ((v - (yMin - py)) / (yMax - yMin + 2 * py)) * innerH,
    };
  }

  function pathD(series, m) {
    if (!series.length) return "";
    const yVal = (p) => (p.pct != null ? p.pct : p.close != null ? p.close : p.v);
    let d = "M" + m.x(series[0].t) + " " + m.y(yVal(series[0]));
    for (let i = 1; i < series.length; i++) {
      d += " L" + m.x(series[i].t) + " " + m.y(yVal(series[i]));
    }
    return d;
  }

  function pathDFromBars(bars, m) {
    if (!bars.length) return "";
    const base = priorCloseForSymbol(state.symbol);
    const pctMode = m.mode === "pct";
    let d = "";
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const v = pctMode && base ? ((b.close - base) / base) * 100 : b.close;
      const seg = (i === 0 ? "M" : " L") + m.x(b.t) + " " + m.y(v);
      d += seg;
    }
    return d;
  }

  async function fetchBars(symbol, interval, range) {
    if (state.hub?.fetchBars) {
      return (await state.hub.fetchBars(symbol, interval, range)) || [];
    }
    if (typeof RMYahooFetch !== "undefined") {
      const payload = await RMYahooFetch.fetchChartBars(symbol, interval, range);
      return payload?.bars || payload || [];
    }
    return [];
  }

  const SYM_RECENT_KEY = "rainmaker_sym_recent_v1";
  const SYM_INPUT_KEY = "rainmaker_sym_input_v1";

  function normalizeTickerInput(raw) {
    return String(raw || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9.-]/g, "");
  }

  function loadSymRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(SYM_RECENT_KEY) || "[]");
      return Array.isArray(list)
        ? list.map((s) => normalizeTickerInput(s)).filter(Boolean)
        : [];
    } catch {
      return [];
    }
  }

  function symInputLast() {
    try {
      return normalizeTickerInput(localStorage.getItem(SYM_INPUT_KEY) || "");
    } catch {
      return "";
    }
  }

  function rememberSymInput(sym) {
    const s = normalizeTickerInput(sym);
    if (!s) return;
    try {
      localStorage.setItem(SYM_INPUT_KEY, s);
      const next = [s, ...loadSymRecent().filter((x) => x !== s)].slice(0, 12);
      localStorage.setItem(SYM_RECENT_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
    refreshSymInputDatalist();
  }

  /** Tickers opened via Symbol → View also appear in the View dropdown. */
  function rememberViewSymbol(sym) {
    const s = normalizeTickerInput(sym);
    if (!s || s === COMPARE_SYM) return;
    const holdingVals = new Set(holdingSymbols());
    if (holdingVals.has(s)) return;
    if (!state.extraSymbols.includes(s)) state.extraSymbols.unshift(s);
    if (state.extraSymbols.length > 12) state.extraSymbols.length = 12;
    lastToolbarSymbolsKey = "";
  }

  function addedViewSymbols() {
    const holdingSet = new Set(holdingSymbols());
    const seen = new Set();
    const out = [];
    for (const s of state.extraSymbols || []) {
      const key = String(s || "").trim();
      if (!key || key === COMPARE_SYM || key === "SPY" || holdingSet.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  function syncSymbolInputFromView() {
    const inp = $("#caSymInput");
    if (!inp || isCompareMode()) return;
    const raw = state.symbol;
    if (/^holding:/i.test(String(raw))) {
      if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolForSelectValue) {
        inp.value = global.RMHoldings.chartSymbolForSelectValue(raw) || "";
      }
      return;
    }
    if (raw && raw !== COMPARE_SYM) inp.value = normalizeTickerInput(raw);
  }

  function refreshSymInputDatalist() {
    const dl = document.getElementById("caSymRecent");
    if (!dl) return;
    dl.innerHTML = loadSymRecent()
      .map((s) => '<option value="' + escapeAttr(s) + '"></option>')
      .join("");
  }

  function symRecentDatalistHtml() {
    return (
      '<datalist id="caSymRecent">' +
      loadSymRecent()
        .map((s) => '<option value="' + escapeAttr(s) + '"></option>')
        .join("") +
      "</datalist>"
    );
  }

  function holdingSymbols() {
    if (typeof global.RMHoldings === "undefined") return [];
    const rows = global.RMHoldings.getDisplayOpen
      ? global.RMHoldings.getDisplayOpen()
      : global.RMHoldings.getOpen
        ? global.RMHoldings.getOpen()
        : [];
    const seenId = new Set();
    const out = [];
    for (const h of rows) {
      const v =
        global.RMHoldings.holdingSelectValue
          ? global.RMHoldings.holdingSelectValue(h)
          : String(h?.symbol || "")
              .trim()
              .toUpperCase();
      const id = h?.id || v;
      if (!v || v === COMPARE_SYM || seenId.has(id)) continue;
      seenId.add(id);
      out.push(v);
    }
    return out;
  }

  /** View dropdown: holdings → SPY → symbols you opened via Symbol box → Compare. */
  function getSymbols() {
    const holdings = holdingSymbols().filter((s) => s !== "SPY");
    return [...holdings, "SPY", ...addedViewSymbols(), COMPARE_SYM];
  }

  function symbolLabel(sym) {
    if (sym === COMPARE_SYM) return "Compare — SPY + picks";
    if (sym === "SPY") return "SPY";
    const labels = holdingsLabelMap();
    const norm =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.normalizeHoldingSelectKey
        ? global.RMHoldings.normalizeHoldingSelectKey(sym)
        : sym;
    if (labels && labels[norm]) return labels[norm];
    if (/^holding:/i.test(String(sym)) && global.RMHoldings?.labelForSelectValue) {
      return global.RMHoldings.labelForSelectValue(sym);
    }
    if (holdingSymbols().includes(sym)) return sym + " · holding";
    return sym;
  }

  function parseHeadlineTime(h) {
    const raw = h?.published || h?.pubDate || h?.time || h?.ts || h?.date;
    if (raw == null) return null;
    const ms = typeof raw === "number" ? raw : Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }

  function eventsFromHub(sym) {
    const hub = hubState();
    if (sym === COMPARE_SYM) {
      const out = [];
      for (const [s, cat] of hub.newsBySym || []) {
        const headlines = cat?.headlines?.length
          ? cat.headlines
          : cat?.headline
            ? [{ title: cat.headline }]
            : [];
        headlines.slice(0, 2).forEach((h, i) => {
          out.push({
            id: s + "-ev-" + i,
            title: s + ": " + (h.title || "News"),
            sym: s,
            t: parseHeadlineTime(h),
          });
        });
      }
      return out.slice(0, 8);
    }
    const cat = hub.newsBySym?.get?.(sym);
    if (!cat) return [];
    const headlines = cat.headlines?.length
      ? cat.headlines
      : cat.headline
        ? [{ title: cat.headline }]
        : [];
    return headlines.slice(0, 6).map((h, i) => ({
      id: "ev-" + i,
      title: h.title || "News",
      t: parseHeadlineTime(h),
    }));
  }

  function nearestBarByTime(bars, t) {
    if (!bars?.length) return null;
    let best = bars[0];
    let bestD = Math.abs(bars[0].t - t);
    for (const b of bars) {
      const d = Math.abs(b.t - t);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  function srChipButtonsHtml() {
    if (!state.srLines.length) return "";
    return state.srLines
      .map(
        (line) =>
          '<button type="button" class="ca-sr-chip" data-sr-dismiss="' +
          escapeAttr(line.id) +
          '" title="Dismiss ' +
          escapeAttr(line.label) +
          '">' +
          escapeHtml(line.label) +
          " " +
          fmtPriceAxis(line.price) +
          " ×</button>"
      )
      .join("");
  }

  function chartStatusFvLine(payload) {
    if (!payload) return null;
    if (Number.isFinite(payload.fairValue)) {
      let s = "Model FV $" + payload.fairValue.toFixed(2);
      if (payload.eps != null && Number.isFinite(payload.eps)) {
        s += " · EPS $" + Number(payload.eps).toFixed(2);
      }
      if (payload.formulaLabel) s += " × " + payload.formulaLabel;
      if (payload.growthPct != null && Number.isFinite(payload.growthPct)) {
        const yrs = payload.growthYears;
        const yrLabel =
          yrs != null && Number.isFinite(yrs) && yrs > 0 ? " (" + yrs + "y CAGR)" : "";
        s += " · g=" + payload.growthPct.toFixed(1) + "%" + yrLabel;
      }
      if (payload.gapPct != null && Number.isFinite(payload.gapPct)) {
        const abs = Math.abs(payload.gapPct).toFixed(0);
        s +=
          payload.gapPct > 0
            ? " · " + abs + "% above fair value"
            : " · " + abs + "% below fair value";
      }
      const ds = payload.dataSource;
      if (ds && ds !== "edgar") {
        const tag =
          ds === "yahoo_only" || ds === "yahoo"
            ? "Yahoo fallback"
            : String(ds);
        s += " · " + tag;
      } else if (payload.dataQuality === "sparse") {
        s += " · sparse EPS history";
      }
      return s;
    }
    if (payload.error === "negative_eps") return "FV unavailable · negative EPS";
    if (payload.error === "no_eps") return "FV unavailable · no EPS";
    if (payload.error) return "FV unavailable";
    return null;
  }

  function chartStatusC2Line() {
    const kpi = global.RMColumnKPI;
    if (!kpi?.computeC2 || !kpi?.resolveTradeStoryStage) return "—";
    const c2 = kpi.computeC2(kpi.resolveTradeStoryStage());
    if (!c2) return "—";
    const bits = [c2.posture].filter(Boolean);
    const sig = (c2.signals || []).slice(0, 2);
    if (sig.length) bits.push(sig.join(" · "));
    return bits.join(" · ") || "—";
  }

  function ensureChartStatus(mount) {
    if (!mount) return;
    const legacySr = mount.querySelector(".ca-sr-overlay");
    if (legacySr) legacySr.remove();
    let ov = mount.querySelector(".ca-chart-status");
    if (!ov) {
      ov = document.createElement("div");
      ov.className = "ca-chart-status";
      ov.setAttribute("aria-live", "polite");
      ov.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-sr-dismiss]");
        if (btn) dismissSrLine(btn.dataset.srDismiss);
      });
      mount.appendChild(ov);
    }
    const fvActive =
      state.indicators.fairValue === true && !isCompareMode();
    if (isCompareMode()) {
      ov.hidden = true;
      ov.innerHTML = "";
      return;
    }
    const fvLine = fvActive ? chartStatusFvLine(state.fundamentalValuation) : null;
    const structureLine = chartStatusStructureLine();
    const c2Line = chartStatusC2Line();
    const srHtml = state.showSR && state.srLines.length ? srChipButtonsHtml() : "";
    ov.hidden = false;
    let html = "";
    if (state.instrumentContext) {
      html +=
        '<div class="ca-chart-status-row ca-chart-status-row--trade">' +
        '<span class="ca-chart-status-kicker">Trade</span> ' +
        '<span class="ca-chart-status-trade">' +
        escapeHtml(state.instrumentContext) +
        "</span></div>";
    }
    if (srHtml) {
      html +=
        '<div class="ca-chart-status-row ca-chart-status-row--sr">' +
        '<span class="ca-chart-status-kicker">S/R</span>' +
        '<span class="ca-chart-status-sr-chips">' +
        srHtml +
        "</span></div>";
    }
    if (structureLine) {
      html +=
        '<div class="ca-chart-status-row">' +
        '<span class="ca-chart-status-kicker">Structure</span> ' +
        '<span class="ca-chart-status-structure">' +
        escapeHtml(structureLine) +
        "</span></div>";
    }
    if (fvActive && fvLine) {
      html +=
        '<div class="ca-chart-status-row">' +
        '<span class="ca-chart-status-kicker">Status</span> ' +
        '<span class="ca-chart-status-fv">' +
        escapeHtml(fvLine) +
        "</span></div>";
    } else if (fvActive) {
      html +=
        '<div class="ca-chart-status-row">' +
        '<span class="ca-chart-status-kicker">Status</span> ' +
        '<span class="ca-chart-status-fv">FV loading…</span></div>';
    }
    html +=
      '<div class="ca-chart-status-row">' +
      '<span class="ca-chart-status-kicker">C2</span> ' +
      '<span class="ca-chart-status-c2">' +
      escapeHtml(c2Line) +
      "</span></div>";
    ov.innerHTML = html;
  }

  function renderSrLines(m, bottom) {
    if (!state.showSR || !state.srLines.length) return "";
    const cc = chartColors();
    let svg = "";
    for (const line of state.srLines) {
      const color =
        line.kind === "support"
          ? cc.bear
          : line.kind === "resistance"
            ? cc.bull
            : "#8b9cb3";
      const dash = line.kind === "pivot" ? "2 4" : "6 4";
      const pc = priorCloseForSymbol(chartPriceSymbol());
      const yVal =
        m.mode === "pct" && pc
          ? ((line.price - pc) / pc) * 100
          : line.price;
      const yPx = m.y(yVal);
      const top = m.pad.t;
      const floor = m.mainH - m.pad.b;
      // Skip a level that maps outside the visible price pane (e.g. a focused
      // pick's S/R while the axis is showing SPY in compare $ mode).
      if (yPx < top - 1 || yPx > floor + 1) continue;
      const x1 = m.pad.l;
      const x2 = m.w - m.pad.r;
      // Wide transparent hit line for easy pointer-drag grabbing + identifier tip.
      const srStat = fmtPriceAxis(line.price);
      const srTip = fvTip(
        "S/R",
        line.label,
        line.kind === "pivot" ? "Auto pivot level" : "Drag to adjust level",
        srStat,
        "chart-ind-line"
      );
      svg +=
        '<line class="ca-sr-line-hit fv-tip-target" tabindex="0"' +
        srTip +
        ' data-sr-id="' +
        escapeAttr(line.id) +
        '" x1="' +
        x1 +
        '" y1="' +
        yPx +
        '" x2="' +
        x2 +
        '" y2="' +
        yPx +
        '" stroke="transparent" stroke-width="14" />';
      svg +=
        '<line class="ca-sr-line" data-sr-id="' +
        escapeAttr(line.id) +
        '" x1="' +
        x1 +
        '" y1="' +
        yPx +
        '" x2="' +
        x2 +
        '" y2="' +
        yPx +
        '" stroke="' +
        color +
        '" stroke-width="1.25" stroke-dasharray="' +
        dash +
        '" opacity="0.9">' +
        svgTitle(line.label + " $" + Number(line.price).toFixed(2) + " — drag to adjust") +
        "</line>";
      // Price tag pinned to the right edge.
      svg +=
        '<text class="ca-sr-tag" data-sr-id="' +
        escapeAttr(line.id) +
        '" x="' +
        (x2 - 2) +
        '" y="' +
        (yPx - 3) +
        '" text-anchor="end" fill="' +
        color +
        '">' +
        escapeHtml(fmtPriceAxis(line.price)) +
        "</text>";
    }
    return svg;
  }

  function planPriceToY(m, price) {
    if (m.mode === "pct") {
      const base = priorCloseForSymbol(chartPriceSymbol()) || price;
      return ((price - base) / base) * 100;
    }
    return price;
  }

  function barFieldToAxis(m, bar, field) {
    const raw = bar?.[field] ?? bar?.close;
    return planPriceToY(m, raw);
  }

  function yPxFromPrice(m, price) {
    const v = planPriceToY(m, price);
    if (v == null || !Number.isFinite(v)) return null;
    return m.y(v);
  }

  /** Map stored scan/note values (price or pct) onto the active chart axis. */
  function axisStoredValueToChart(m, value, valueKey) {
    if (value == null || !Number.isFinite(Number(value))) return value;
    if (m.mode !== "pct") return value;
    if (valueKey === "pct") return value;
    return planPriceToY(m, value);
  }

  function scanCenterAxisY(m, scan) {
    const vk = scan?.valueKey || "price";
    return axisStoredValueToChart(m, scan.centerP, vk);
  }

  function emaViewForAxis(m, emaView) {
    if (!emaView || m.mode !== "pct") return emaView;
    const base = priorCloseForSymbol(chartPriceSymbol());
    if (!base || base <= 0) return emaView;
    const toPct = (v) => (Number.isFinite(v) ? ((v - base) / base) * 100 : v);
    const mapArr = (arr) => (arr ? arr.map(toPct) : arr);
    return {
      ema9: mapArr(emaView.ema9),
      ema21: mapArr(emaView.ema21),
      ema50: mapArr(emaView.ema50),
      ema200: mapArr(emaView.ema200),
      barCount: emaView.barCount,
    };
  }

  function planLineY(m, price) {
    const v = planPriceToY(m, price);
    if (v == null || !Number.isFinite(v)) return null;
    return m.y(v);
  }

  function chartMountChromeHeight(stage) {
    if (!stage) return 0;
    const rmRec = stage.querySelector("#caRmRec");
    const brush = stage.querySelector(".ca-time-brush:not([hidden])");
    return (rmRec?.offsetHeight || 0) + (brush?.offsetHeight || 0);
  }

  function includeTradePlanInMetrics(m) {
    const plan = state.tradePlan;
    if (!plan || plan.symbol !== state.symbol || isCompareMode()) return m;
    const levels = useCollapsedPlanFlag()
        ? [plan.entry]
        : [plan.entry, plan.stop, plan.target1, plan.target2, plan.target].filter(
            (v) => v != null && Number.isFinite(v)
          );
    if (!levels.length) return m;
    let pMin = Infinity;
    let pMax = -Infinity;
    for (const price of levels) {
      if (!Number.isFinite(price)) continue;
      const axisVal = planPriceToY(m, price);
      pMin = Math.min(pMin, axisVal);
      pMax = Math.max(pMax, axisVal);
    }
    if (!Number.isFinite(pMin)) return m;
    return mergeYExtents(m, pMin, pMax, useCollapsedPlanFlag() ? 0.08 : 0.22);
  }

  function renderTradePlanLines(m, bars) {
    const cc = chartColors();
    const plan = state.tradePlan;
    if (!plan || plan.symbol !== state.symbol || isCompareMode() || !bars?.length) return "";
    if (useCollapsedPlanFlag()) return "";
    const yEntry = planLineY(m, plan.entry);
    const yStop = planLineY(m, plan.stop);
    const yTarget1 = plan.target1 != null ? planLineY(m, plan.target1) : null;
    const yTarget2 = planLineY(m, plan.target2 ?? plan.target);
    let svg = '<g class="ca-trade-plan ca-trade-plan-lines">';
    const lines = [
      ["Entry", yEntry, cc.tradeNode, "", plan.entry],
      ["Stop", yStop, cc.bear, "5 4", plan.stop],
    ];
    if (yTarget1 != null) lines.push(["Limit 1", yTarget1, cc.bull, "4 3", plan.target1]);
    lines.push(["Limit 2", yTarget2, cc.bull, "5 4", plan.target2 ?? plan.target]);
    for (const [label, y, color, dash, price] of lines) {
      if (y == null || !Number.isFinite(y)) continue;
      const tag = endLabelAnchor(m, m.w - m.pad.r - 4, 0);
      const priceStr = "$" + Number(price).toFixed(2);
      svg += renderIndHLine(m.pad.l, y, m.w - m.pad.r, {
        color,
        width: 1.5,
        dash,
        title: label,
        desc: "Trade plan level",
        stat: priceStr,
        kicker: "Plan",
        groupClass: "ca-plan-line-wrap",
        visibleClass: "ca-plan-line",
      });
      svg +=
        '<text class="ca-plan-line-label" x="' +
        tag.x +
        '" y="' +
        (y - 3) +
        '" text-anchor="' +
        tag.anchor +
        '" fill="' +
        color +
        '" font-size="9" font-weight="700" pointer-events="none">' +
        escapeHtml(label + " " + priceStr) +
        "</text>";
    }
    svg += "</g>";
    return svg;
  }

  function renderExpandedPlanFlag(m, viewBars, plan) {
    const cc = chartColors();
    const yEntry = planLineY(m, plan.entry);
    if (yEntry == null || !Number.isFinite(yEntry)) return "";
    const yEntryPx = m.y(yEntry);
    if (!Number.isFinite(yEntryPx)) return "";
    const x = planFlagX(m, viewBars);
    const poleTop = planFlagPoleTop(m, yEntryPx, true);
    const flagW = 12;
    const flagH = 8;
    const hit = planFlagHitRect(x, yEntryPx, poleTop, flagW);
    const profit = planProfit(plan);
    const risk = planRisk(plan);
    const rr =
      plan.rr != null
        ? plan.rr
        : plan.entry > plan.stop
          ? ((plan.target2 ?? plan.target) - plan.entry) / (plan.entry - plan.stop)
          : 0;
    return (
      '<g class="ca-trade-plan ca-trade-plan-flag-layer">' +
      '<g class="ca-plan-flag ca-plan-flag--expanded fv-tip-target" tabindex="0" data-plan-flag="1" aria-label="' +
      (isMobileChartUI()
        ? "Morning setup. Tap for setup in Results."
        : "Morning setup. Tap to open setup in Results.") +
      '">' +
      '<rect class="ca-plan-flag-hit" pointer-events="all" x="' +
      hit.x +
      '" y="' +
      hit.y +
      '" width="' +
      hit.width +
      '" height="' +
      hit.height +
      '" fill="rgba(61,186,122,0.001)" stroke="none"/>' +
      fvTip(
        "RM morning setup",
        plan.symbol + " limit entry",
        "Setup expanded on chart. Tap again to open Target Trades (mobile) or toggle this panel (desktop).",
        (profit != null ? "Proj profit $" + profit : "") +
          (risk != null ? " · Risk $" + risk : "") +
          " · " +
          plan.qty +
          " sh · " +
          (rr ? rr.toFixed(1) + "R" : ""),
        "plan-flag"
      ) +
      '"><line pointer-events="none" x1="' +
      x +
      '" y1="' +
      poleTop +
      '" x2="' +
      x +
      '" y2="' +
      yEntryPx +
      '" stroke="' +
      cc.tradeNode +
      '" stroke-width="1.5"/>' +
      planFlagFabricSvg(x, poleTop, flagW, flagH) +
      "</g></g>"
    );
  }

  function renderTradePlanFlag(m, viewBars) {
    const plan = state.tradePlan;
    if (!plan || plan.symbol !== state.symbol || isCompareMode() || !viewBars?.length) return "";
    if (useCollapsedPlanFlag()) return renderMorningBuyFlag(m, viewBars, plan);
    return renderExpandedPlanFlag(m, viewBars, plan);
  }

  function renderTradePlanProjection(m, bars, bottom) {
    const cc = chartColors();
    const plan = state.tradePlan;
    if (!plan || !bars?.length) return "";
    if (useCollapsedPlanFlag()) return "";
    const lastBar = bars[bars.length - 1];
    const xStart = m.x(lastBar.t);
    const gutterW = Math.max(48, Math.min(m.innerW * 0.14, 110));
    const xEnd = Math.min(m.w - m.pad.r - 2, xStart + gutterW);
    if (xEnd <= xStart + 10) return "";
    const yLast = planLineY(m, lastBar.close);
    const yEntry = planLineY(m, plan.entry);
    const yT1 = plan.target1 != null ? planLineY(m, plan.target1) : null;
    const yT2 = planLineY(m, plan.target2 ?? plan.target);
    const x1 = xStart + (xEnd - xStart) * 0.22;
    const x2 = xStart + (xEnd - xStart) * 0.58;
    let path = "M" + xStart + " " + yLast + " L" + x1 + " " + yEntry;
    if (yT1 != null) path += " L" + x2 + " " + yT1;
    path += " L" + xEnd + " " + yT2;
    let svg =
      '<g class="ca-trade-proj">' +
      '<rect class="ca-trade-proj-zone" x="' +
      xStart +
      '" y="' +
      m.pad.t +
      '" width="' +
      (xEnd - xStart) +
      '" height="' +
      (bottom - m.pad.t) +
      '"/>' +
      '<text class="ca-trade-proj-label" x="' +
      (xStart + 6) +
      '" y="' +
      (m.pad.t + 12) +
      '">Next session · projected path</text>' +
      '<path class="ca-trade-proj-path" d="' +
      path +
      '"/>';
    const labels = [
      ["Entry", plan.entry, yEntry, cc.tradeNode],
      ["Stop", plan.stop, planLineY(m, plan.stop), cc.bear],
      ["Sell 1", plan.target1 ?? plan.target, yT1, cc.bull],
      ["Sell 2", plan.target2 ?? plan.target, yT2, cc.bull],
    ];
    let yOff = 0;
    for (const [lbl, price, y, color] of labels) {
      if (y == null || price == null) continue;
      const projLabelX = endLabelAnchor(m, xEnd, 4);
      svg +=
        '<text x="' +
        projLabelX.x +
        '" y="' +
        (y + yOff) +
        '" text-anchor="' +
        projLabelX.anchor +
        '" fill="' +
        color +
        '" font-size="9" font-weight="600">' +
        escapeHtml(lbl + " $" + Number(price).toFixed(2)) +
        "</text>";
      yOff += 0;
    }
    svg += "</g>";
    return svg;
  }

  function planPanelBodyHtml(plan) {
    const rr =
      plan.entry > plan.stop ? (plan.target - plan.entry) / (plan.entry - plan.stop) : 2;
    const t1 = Number(plan.target1 ?? plan.target).toFixed(2);
    const t2 = Number(plan.target2 ?? plan.target).toFixed(2);
    return (
      '<dl class="ca-plan-panel-levels">' +
      '<div><dt>Entry</dt><dd>$' +
      Number(plan.entry).toFixed(2) +
      "</dd></div>" +
      '<div><dt>Stop</dt><dd>$' +
      Number(plan.stop).toFixed(2) +
      "</dd></div>" +
      '<div><dt>Target 1</dt><dd>$' +
      t1 +
      "</dd></div>" +
      '<div><dt>Target 2</dt><dd>$' +
      t2 +
      "</dd></div></dl>" +
      '<label class="ca-plan-field">Qty<input type="number" id="caPlanQty" min="1" step="1" value="' +
      plan.qty +
      '"></label>' +
      '<label class="ca-plan-field">R:R<input type="range" id="caPlanRR" min="1" max="4" step="0.5" value="' +
      (plan.rr ?? rr).toFixed(1) +
      '"><span id="caPlanRRVal">' +
      (plan.rr ?? rr).toFixed(1) +
      "R</span></label>" +
      '<p class="ca-plan-stat" id="caPlanStat"></p>' +
      '<p class="ca-plan-panel-next">Levels are on the chart. Adjust qty/R:R here, then open Target Trades.</p>' +
      '<footer class="ca-plan-panel-foot">' +
      '<button type="button" class="secondary btn-sm" id="caPlanDismiss">Collapse setup</button>' +
      '<button type="button" class="primary btn-sm" id="caPlanOpenTrades">Target Trades</button>' +
      "</footer>"
    );
  }

  function planPanelHtml() {
    const plan = state.tradePlan;
    if (!plan) return "";
    return (
      '<div class="ca-plan-panel ca-plan-panel--embedded" id="ttResultsPlanPanel" aria-labelledby="caPlanPanelTitle">' +
      '<header class="ca-plan-panel-head">' +
      '<p class="ca-plan-panel-title" id="caPlanPanelTitle">' +
      escapeHtml(plan.symbol) +
      " morning setup</p>" +
      "</header>" +
      planPanelBodyHtml(plan) +
      "</div>"
    );
  }

  function updatePlanPanelStat() {
    const plan = state.tradePlan;
    const stat = document.getElementById("caPlanStat");
    if (!plan || !stat) return;
    const profit = planProfit(plan);
    const risk = planRisk(plan);
    stat.textContent =
      (profit != null ? "Proj profit $" + profit : "") +
      (risk != null ? " · Risk $" + risk : "") +
      " · L1 $" +
      Number(plan.target1 ?? plan.target).toFixed(2) +
      " · L2 $" +
      Number(plan.target2 ?? plan.target).toFixed(2);
  }

  function planHintBarHtml(plan) {
    const t1 = Number(plan.target1 ?? plan.target).toFixed(2);
    const t2 = Number(plan.target2 ?? plan.target).toFixed(2);
    return (
      '<div class="ca-plan-hint-bar" id="caPlanHintBar" role="region" aria-label="Morning trade setup">' +
      '<div class="ca-plan-hint-bar-row">' +
      '<span class="ca-plan-hint-kicker">Setup on chart</span>' +
      '<span class="ca-plan-hint-lvl ca-plan-hint-entry">Entry $' +
      Number(plan.entry).toFixed(2) +
      "</span>" +
      '<span class="ca-plan-hint-lvl ca-plan-hint-stop">Stop $' +
      Number(plan.stop).toFixed(2) +
      "</span>" +
      '<span class="ca-plan-hint-lvl ca-plan-hint-t1">Sell 1 $' +
      t1 +
      "</span>" +
      '<span class="ca-plan-hint-lvl ca-plan-hint-t2">Sell 2 $' +
      t2 +
      "</span>" +
      '<button type="button" class="primary btn-sm" id="caPlanHintTrades">Target Trades</button>' +
      "</div>" +
      '<p class="ca-plan-hint-sub">Green = entry · Orange = stop · Cyan = targets · Tap flag again or use Target Trades</p>' +
      "</div>"
    );
  }

  function ensurePlanHintBar(mount) {
    const plan = state.tradePlan;
    const show =
      plan &&
      plan.symbol === state.symbol &&
      !isCompareMode() &&
      !useCollapsedPlanFlag() &&
      isMobileChartUI();
    if (!show) {
      mount.querySelector("#caPlanHintBar")?.remove();
      return;
    }
    let bar = mount.querySelector("#caPlanHintBar");
    if (!bar) {
      const holder = document.createElement("div");
      holder.innerHTML = planHintBarHtml(plan);
      bar = holder.firstElementChild;
      mount.insertBefore(bar, mount.firstChild);
    } else {
      bar.outerHTML = planHintBarHtml(plan);
    }
  }

  function bindPlanHintBar(mount) {
    if (!mount || mount.dataset.planHintBound === "1") return;
    mount.dataset.planHintBound = "1";
    mount.addEventListener("click", (e) => {
      if (!e.target.closest("#caPlanHintTrades")) return;
      e.preventDefault();
      e.stopPropagation();
      dispatchSelectTradePlan();
    });
  }

  function rmRecStripHtml(plan) {
    if (!plan) return "";
    return (
      '<div class="ca-rm-rec" id="caRmRec">' +
      '<span class="ca-rm-rec-kicker">RM morning setup</span>' +
      '<span class="ca-rm-rec-item ca-rm-rec-entry"><span class="ca-rm-rec-lbl">LMT</span> $' +
      Number(plan.entry).toFixed(2) +
      "</span>" +
      '<span class="ca-rm-rec-item ca-rm-rec-stop"><span class="ca-rm-rec-lbl">Stop</span> $' +
      Number(plan.stop).toFixed(2) +
      "</span>" +
      '<span class="ca-rm-rec-item ca-rm-rec-t1"><span class="ca-rm-rec-lbl">Sell 1</span> $' +
      Number(plan.target1 ?? plan.target).toFixed(2) +
      "</span>" +
      '<span class="ca-rm-rec-item ca-rm-rec-t2"><span class="ca-rm-rec-lbl">Sell 2</span> $' +
      Number(plan.target2 ?? plan.target).toFixed(2) +
      "</span>" +
      '<span class="ca-rm-rec-hint">Click setup → Target Trades</span></div>'
    );
  }

  function ensureRmRecStrip(mount) {
    const plan = state.tradePlan;
    if (
      !plan ||
      plan.symbol !== state.symbol ||
      isCompareMode() ||
      !isMobileChartUI() ||
      useCollapsedPlanFlag()
    ) {
      mount.querySelector("#caRmRec")?.remove();
      return;
    }
    let strip = mount.querySelector("#caRmRec");
    if (!strip) {
      const holder = document.createElement("div");
      holder.innerHTML = rmRecStripHtml(plan);
      strip = holder.firstElementChild;
      strip.setAttribute("role", "button");
      strip.setAttribute("tabindex", "0");
      strip.setAttribute("title", "Show RM confidence and trade levels in Target Trades");
      mount.insertBefore(strip, mount.firstChild);
    } else {
      strip.outerHTML = rmRecStripHtml(plan);
    }
  }

  function bindPlanPanel() {
    const panel = document.getElementById("ttResultsPlanPanel");
    if (!panel || panel.dataset.bound === "1") return;
    panel.dataset.bound = "1";
    const qtyEl = panel.querySelector("#caPlanQty");
    const rrEl = panel.querySelector("#caPlanRR");
    const rrVal = panel.querySelector("#caPlanRRVal");
    const sync = () => {
      const plan = state.tradePlan;
      if (!plan) return;
      plan.qty = Math.max(1, parseInt(qtyEl?.value, 10) || 100);
      if (rrEl) {
        plan.rr = parseFloat(rrEl.value) || 2;
        applyPlanRR(plan, plan.rr);
        if (rrVal) rrVal.textContent = plan.rr.toFixed(1) + "R";
      }
      updatePlanPanelStat();
      pushPlanToFooter(plan);
      paint();
    };
    qtyEl?.addEventListener("input", sync);
    rrEl?.addEventListener("input", sync);
    panel.querySelector("#caPlanDismiss")?.addEventListener("click", (e) => {
      e.preventDefault();
      collapseTradePlanOnChart();
      paint();
    });
    panel.querySelector("#caPlanOpenTrades")?.addEventListener("click", (e) => {
      e.preventDefault();
      dispatchSelectTradePlan();
    });
  }

  function planFlagFromEvent(e) {
    const direct = e.target?.closest?.("[data-plan-flag], .ca-plan-flag-hit, .ca-plan-flag");
    if (direct) return direct;
    const picked = document.elementFromPoint(e.clientX, e.clientY);
    return picked?.closest?.("[data-plan-flag], .ca-plan-flag-hit, .ca-plan-flag") || null;
  }

  function resetPlanFlagTouch() {
    planFlagTouch.active = false;
    planFlagTouch.pointerId = null;
  }

  function onPlanFlagPointerDown(e) {
    if (e.button !== 0) return;
    const flag = planFlagFromEvent(e);
    if (!flag) return;
    planFlagTouch.active = true;
    planFlagTouch.pointerId = e.pointerId != null ? e.pointerId : "mouse";
    planFlagTouch.startX = e.clientX;
    planFlagTouch.startY = e.clientY;
    e.stopPropagation();
  }

  function onChartPlanFlagPointerUp(e) {
    const flag = planFlagFromEvent(e);
    if (!flag) {
      resetPlanFlagTouch();
      return;
    }
    const pid = e.pointerId != null ? e.pointerId : "mouse";
    if (planFlagTouch.active) {
      if (planFlagTouch.pointerId !== pid) return;
      const moved = Math.hypot(e.clientX - planFlagTouch.startX, e.clientY - planFlagTouch.startY);
      resetPlanFlagTouch();
      if (moved > PLAN_FLAG_MOVE_PX) return;
    } else if (chartPointer.moved) {
      return;
    }
    activatePlanFlag(e);
  }

  function onPlanFlagPointerCancel() {
    resetPlanFlagTouch();
  }

  /* ---- Draggable S/R levels (#4) ---- */
  function srLineFromEvent(e) {
    const el = e.target?.closest?.(".ca-sr-line-hit, .ca-sr-line");
    const id = el?.dataset?.srId;
    if (!id) return null;
    return state.srLines.find((l) => l.id === id) || null;
  }

  function onSrPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    const line = srLineFromEvent(e);
    if (!line) return;
    srDrag.active = true;
    srDrag.id = line.id;
    srDrag.pointerId = e.pointerId != null ? e.pointerId : "mouse";
    srDrag.moved = false;
    e.preventDefault();
    e.stopPropagation();
    window.addEventListener("pointermove", onSrPointerMove);
    window.addEventListener("pointerup", onSrPointerUp);
    window.addEventListener("pointercancel", onSrPointerUp);
    window.addEventListener("mousemove", onSrPointerMove);
    window.addEventListener("mouseup", onSrPointerUp);
  }

  function onSrPointerMove(e) {
    if (!srDrag.active) return;
    const pt = chartPointFromClient(e.clientX, e.clientY);
    if (!pt) return;
    let price = pt.price;
    if (price == null && pt.pct != null) {
      const base = priorCloseForSymbol(state.symbol);
      if (base) price = base * (1 + pt.pct / 100);
    }
    if (price == null || !Number.isFinite(price)) return;
    const line = state.srLines.find((l) => l.id === srDrag.id);
    if (!line) return;
    srDrag.moved = true;
    line.price = round2(price);
    state.srOverrides = state.srOverrides || {};
    state.srOverrides[line.id] = line.price;
    repaintChartSvg();
  }

  function onSrPointerUp() {
    if (!srDrag.active) return;
    const moved = srDrag.moved;
    srDrag.active = false;
    srDrag.id = null;
    srDrag.pointerId = null;
    srDrag.moved = false;
    window.removeEventListener("pointermove", onSrPointerMove);
    window.removeEventListener("pointerup", onSrPointerUp);
    window.removeEventListener("pointercancel", onSrPointerUp);
    window.removeEventListener("mousemove", onSrPointerMove);
    window.removeEventListener("mouseup", onSrPointerUp);
    if (moved) {
      // Feed the dragged levels into the morning entry flow.
      refreshMorningTradePlan();
      ensureChartStatus($(".ca-chart-mount"));
      repaintChartSvg();
    }
  }

  function symBarHtml() {
    return (
      '<div class="ca-toolbar ca-toolbar--secondary" id="caSymBar">' +
      '<label class="ca-field ca-field--grow ca-field--compact ca-field--sym">' +
      '<span class="ca-field-label">Symbol</span><input type="text" id="caSymInput" class="ca-text-input" list="caSymRecent" placeholder="Add sym" maxlength="8" autocapitalize="characters" aria-label="Add symbol" value="' +
      escapeAttr(symInputLast()) +
      '"></label>' +
      symRecentDatalistHtml() +
      '<div class="ca-mode-seg" role="group" aria-label="Add mode">' +
      '<button type="button" class="ca-mode-btn' +
      (state.addMode !== "compare" ? " is-on" : "") +
      '" id="caModeLoad" data-mode="load" aria-pressed="' +
      (state.addMode !== "compare" ? "true" : "false") +
      '">View</button>' +
      '<button type="button" class="ca-mode-btn' +
      (state.addMode === "compare" ? " is-on" : "") +
      '" id="caModeCompare" data-mode="compare" aria-pressed="' +
      (state.addMode === "compare" ? "true" : "false") +
      '">Compare</button>' +
      "</div>" +
      '<button type="button" class="ca-toggle ca-add-btn" id="caSymGo">' +
      (state.addMode === "compare" ? "+" : "Add") +
      "</button>" +
      "</div>"
    );
  }

  function toolbarHtml(symbols) {
    const hub = hubState();
    const syms = symbols.length ? symbols : getSymbols();
    return (
      '<div class="ca-toolbar ca-toolbar--primary">' +
      '<label class="ca-field ca-field--view"><span class="ca-field-label">View</span><select id="caSymbol" aria-label="Chart symbol">' +
      syms
        .map(
          (s) =>
            '<option value="' +
            escapeAttr(s) +
            '"' +
            (state.symbol === s ? " selected" : "") +
            ">" +
            escapeHtml(symbolLabel(s)) +
            "</option>"
        )
        .join("") +
      "</select></label>" +
      '<label class="ca-field ca-field--range"><select id="caRange" aria-label="Lookback range">' +
      RANGES.map(
        (r) =>
          '<option value="' +
          r +
          '"' +
          (state.range === r ? " selected" : "") +
          ">" +
          rangeLabel(r) +
          "</option>"
      ).join("") +
      "</select></label>" +
      '<label class="ca-field ca-field--interval"><select id="caInterval" aria-label="Candle interval">' +
      INTERVALS.map(
        (iv) =>
          '<option value="' +
          iv +
          '"' +
          (state.interval === iv ? " selected" : "") +
          ">" +
          iv +
          "</option>"
      ).join("") +
      "</select></label>" +
      '<div class="ca-toggles">' +
      toggleBtn("caYAxis", usePctAxis() ? "%" : "$", usePctAxis(), "ca-yaxis-toggle") +
      indicatorsDropdownHtml() +
      "</div>" +
      symBarHtml() +
      "</div>"
    );
  }

  function noteEditorOverlayHtml() {
    return (
      '<div class="ca-note-overlay hidden" id="caNoteEditor" role="dialog" aria-label="Chart note">' +
      '<input type="text" id="caNoteInput" class="ca-note-overlay-input" maxlength="140" placeholder="Note…" autocomplete="off">' +
      '<div class="ca-note-overlay-tags rm-debrief-tags" id="caNoteTags" role="group" aria-label="Note tags"></div>' +
      '<div class="ca-note-overlay-actions">' +
      '<button type="button" class="ca-note-overlay-btn" id="caDeleteNote" title="Delete note" aria-label="Delete note">×</button>' +
      '<button type="button" class="ca-note-overlay-btn" id="caCloseNote" title="Done" aria-label="Done">✓</button>' +
      "</div></div>"
    );
  }

  function renderNoteTagButtons(note) {
    const host = document.getElementById("caNoteTags");
    if (!host) return;
    const selected = new Set((note && note.tags) || []);
    host.innerHTML = reflectTagsForNotes()
      .map((tag) => {
        const on = selected.has(tag.id) ? " is-selected" : "";
        return (
          '<button type="button" class="rm-debrief-tag ca-note-tag' +
          on +
          '" data-note-tag="' +
          escapeHtml(tag.id) +
          '">' +
          escapeHtml(tag.label) +
          "</button>"
        );
      })
      .join("");
  }

  function toggleNoteTag(tagId) {
    const key = isCompareMode() ? "SPY" : state.symbol;
    const note = (loadAllNotes()[key] || []).find((n) => n.id === state.activeNoteId);
    if (!note || !tagId) return;
    note.tags = Array.isArray(note.tags) ? note.tags.slice() : [];
    const idx = note.tags.indexOf(tagId);
    if (idx >= 0) note.tags.splice(idx, 1);
    else note.tags.push(tagId);
    persistNote(key, note);
    renderNoteTagButtons(note);
  }

  function toggleBtn(id, label, on, extra, disabled) {
    return (
      '<button type="button" class="ca-toggle' +
      (on ? " is-on" : "") +
      (extra ? " " + extra : "") +
      '" id="' +
      id +
      '" aria-pressed="' +
      (on ? "true" : "false") +
      '"' +
      (disabled ? ' disabled aria-disabled="true"' : "") +
      ">" +
      escapeHtml(label) +
      "</button>"
    );
  }

  const INDICATOR_MENU = [
    {
      id: "caSr",
      label: "S/R",
      tip: {
        title: "Support / resistance",
        desc: "Horizontal levels from recent swing lows and highs on the price pane. Drag a line to adjust.",
        stat: "On by default",
      },
      isOn: () => state.showSR,
      toggle: () => {
        state.showSR = !state.showSR;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caEvents",
      label: "Events",
      tip: {
        title: "News events",
        desc: "Headline markers on the chart when scan or news timestamps align with price bars.",
        stat: "Price pane markers",
      },
      isOn: () => state.showEvents,
      toggle: () => {
        state.showEvents = !state.showEvents;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caIchi",
      label: "Ichimoku",
      tip: {
        title: "Ichimoku cloud",
        desc: "Senkou Span A/B cloud fill on the price pane.",
        stat: "Needs ~26+ bars (cloud ~52)",
      },
      isOn: () => state.indicators.ichimoku,
      toggle: () => {
        state.indicators.ichimoku = !state.indicators.ichimoku;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caVolume",
      label: "Volume",
      tip: {
        title: "Volume overlay",
        desc: "Volume bars behind candles; color highlights when the cursor is near the band.",
        stat: "Price pane backdrop",
      },
      isOn: () => state.indicators.volume,
      toggle: () => {
        state.indicators.volume = !state.indicators.volume;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caMacd",
      label: "MACD",
      tip: {
        title: "MACD pane",
        desc: "Moving-average convergence/divergence sub-chart below price.",
        stat: "Lower indicator pane",
      },
      isOn: () => state.indicators.macd,
      toggle: () => {
        state.indicators.macd = !state.indicators.macd;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caRsi",
      label: "RSI",
      tip: {
        title: "RSI pane",
        desc: "Relative strength index sub-chart (14-period default).",
        stat: "Lower indicator pane",
      },
      isOn: () => state.indicators.rsi,
      toggle: () => {
        state.indicators.rsi = !state.indicators.rsi;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caMacdRsiBuy",
      label: "Buy",
      tip: {
        title: "MACD + RSI buy bags",
        desc: "Money-bag markers when MACD histogram pivots up while RSI was oversold.",
        stat: "Tap bag for plan preview",
      },
      isOn: () => state.indicators.macdrsiBuy,
      toggle: () => {
        state.indicators.macdrsiBuy = !state.indicators.macdrsiBuy;
        saveChartPrefs();
        paint();
      },
    },
    {
      id: "caEmaStack",
      label: "EMA",
      tip: {
        title: "EMA stack",
        desc: "9 / 21 / 50 / 200 exponential moving averages on the price pane.",
        stat: "200 EMA needs long range",
      },
      isOn: () => state.indicators.emaStack,
      toggle: () => {
        state.indicators.emaStack = !state.indicators.emaStack;
        saveChartPrefs();
        paint();
        document.dispatchEvent(new CustomEvent("rm:chart-indicators"));
      },
    },
    {
      id: "caFairValue",
      label: "Fair Value",
      tip: {
        title: "Fair Value",
        desc: "Growth-adjusted fair P/E from trailing EPS. Works on $ or % axis; ETFs without EPS show nothing.",
        stat: "Orange dashed line",
      },
      isOn: () => state.indicators.fairValue,
      disabled: () => isCompareMode(),
      toggle: () => {
        const next = !state.indicators.fairValue;
        state.indicators.fairValue = next;
        if (!next) {
          state.fundamentalValuation = null;
          state._fvFetchGen += 1;
        }
        saveChartPrefs();
        if (next) void ensureFundamentalValue();
        paint();
        document.dispatchEvent(new CustomEvent("rm:chart-indicators"));
      },
    },
  ];

  function indicatorMenuBtn(item) {
    const on = item.isOn();
    const dis = item.disabled?.() || false;
    const tip = item.tip || {};
    const ariaLabel =
      item.label + (on ? ", on" : ", off") + (tip.desc ? ". " + tip.desc : "");
    const tipAttrs = fvTip(
      "Indicators",
      tip.title || item.label,
      tip.desc || "",
      tip.stat || "",
      "chart-ind"
    );
    return (
      '<button type="button" role="menuitemcheckbox" tabindex="0"' +
      ' class="ca-toggle ca-ind-item fv-tip-target' +
      (on ? " is-on" : "") +
      (dis ? " is-disabled" : "") +
      '" data-ind-toggle="' +
      escapeAttr(item.id) +
      '" id="' +
      item.id +
      '" aria-label="' +
      escapeAttr(ariaLabel) +
      '" aria-checked="' +
      (on ? "true" : "false") +
      '" aria-pressed="' +
      (on ? "true" : "false") +
      '"' +
      (dis ? ' disabled aria-disabled="true"' : "") +
      tipAttrs +
      "><span class=\"ca-ind-item-label\">" +
      escapeHtml(item.label) +
      '</span><span class="ca-ind-item-state" aria-hidden="true">' +
      (on ? "On" : "Off") +
      "</span></button>"
    );
  }

  function syncIndicatorMenuButton(btn, item) {
    if (!btn || !item) return;
    const on = item.isOn();
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.setAttribute("aria-checked", on ? "true" : "false");
    const tip = item.tip || {};
    btn.setAttribute(
      "aria-label",
      item.label + (on ? ", on" : ", off") + (tip.desc ? ". " + tip.desc : "")
    );
    const st = btn.querySelector(".ca-ind-item-state");
    if (st) st.textContent = on ? "On" : "Off";
  }

  function isMobileChartIndicatorMenu() {
    return isMobileChartUI();
  }

  function getIndicatorMenu() {
    return document.getElementById("caIndicatorsMenu");
  }

  function getIndicatorMenuBtn() {
    return state.container?.querySelector("#caIndicatorsBtn") || null;
  }

  function portalIndicatorMenu(menu) {
    if (!menu || menu.parentElement === document.body) return;
    document.body.appendChild(menu);
  }

  function restoreIndicatorMenuPortal(menu) {
    if (!menu || menu.parentElement !== document.body) return;
    const home = state.container?.querySelector("#caIndicators");
    if (home) home.appendChild(menu);
  }

  function clearIndicatorMenuPosition(menu) {
    if (!menu) return;
    menu.style.position = "";
    menu.style.left = "";
    menu.style.right = "";
    menu.style.transform = "";
    menu.style.top = "";
    menu.style.zIndex = "";
    menu.style.maxHeight = "";
    menu.style.overflowY = "";
    menu.style.minWidth = "";
    menu.style.maxWidth = "";
    menu.style.width = "";
    menu.style.overflowX = "";
    restoreIndicatorMenuPortal(menu);
  }

  function positionIndicatorMenu(menu, btn) {
    if (!menu || !btn || !isMobileChartIndicatorMenu()) {
      clearIndicatorMenuPosition(menu);
      return;
    }
    portalIndicatorMenu(menu);
    const gap = 6;
    const edge = 8;
    const btnRect = btn.getBoundingClientRect();
    const top = Math.round(btnRect.bottom + gap);
    const maxW = Math.min(240, window.innerWidth - edge * 2);
    const maxH = Math.max(120, Math.round(window.innerHeight - top - edge));
    menu.style.position = "fixed";
    menu.style.top = top + "px";
    menu.style.left = "auto";
    menu.style.right = "auto";
    menu.style.transform = "none";
    menu.style.zIndex = "130";
    menu.style.width = "max-content";
    menu.style.minWidth = "176px";
    menu.style.maxWidth = maxW + "px";
    menu.style.maxHeight = maxH + "px";
    menu.style.overflowY = "auto";
    menu.style.overflowX = "hidden";
    const menuW = menu.offsetWidth || 176;
    let left = Math.round(btnRect.right - menuW);
    if (left < edge) left = edge;
    if (left + menuW > window.innerWidth - edge) {
      left = Math.max(edge, window.innerWidth - edge - menuW);
    }
    menu.style.left = left + "px";
  }

  function openIndicatorMenu(menu, btn) {
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => positionIndicatorMenu(menu, btn));
    });
  }

  function closeIndicatorMenu() {
    const menu = getIndicatorMenu();
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    clearIndicatorMenuPosition(menu);
    getIndicatorMenuBtn()?.setAttribute("aria-expanded", "false");
  }

  function ensureIndicatorMenuBindings() {
    const root = state.container;
    if (!root || root.dataset.rmIndMenuBound === "1") return;
    root.dataset.rmIndMenuBound = "1";

    const onReposition = () => {
      const menu = getIndicatorMenu();
      const btn = getIndicatorMenuBtn();
      if (menu && btn && !menu.hidden) positionIndicatorMenu(menu, btn);
    };
    global.addEventListener("resize", onReposition);
    global.addEventListener("scroll", onReposition, true);

    root.addEventListener("click", (e) => {
      const indBtn = e.target.closest("#caIndicatorsBtn");
      if (indBtn && root.contains(indBtn)) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof RMUiTips !== "undefined") RMUiTips.hide();
        const menu = getIndicatorMenu();
        if (!menu) return;
        if (menu.hidden) {
          openIndicatorMenu(menu, indBtn);
        } else {
          closeIndicatorMenu();
        }
        return;
      }

      const btn = e.target.closest("[data-ind-toggle]");
      if (!btn || !btn.closest("#caIndicatorsMenu")) return;
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return;

      const id = btn.dataset.indToggle;
      const item = INDICATOR_MENU.find((x) => x.id === id);
      if (!item || item.disabled?.()) return;

      item.toggle();
      syncIndicatorMenuButton(btn, item);
      updateIndicatorBtn();
      if (typeof RMUiTips !== "undefined") RMUiTips.hide();
    });

    document.addEventListener("click", (e) => {
      if (e.target.closest("#caIndicators") || e.target.closest("#caIndicatorsMenu")) return;
      closeIndicatorMenu();
      if (typeof RMUiTips !== "undefined") RMUiTips.hide();
    });
  }

  function indicatorActiveCount() {
    let n = 0;
    if (state.showSR) n++;
    if (state.showEvents) n++;
    if (state.indicators.ichimoku) n++;
    if (state.indicators.volume) n++;
    if (state.indicators.macd) n++;
    if (state.indicators.rsi) n++;
    if (state.indicators.macdrsiBuy) n++;
    if (state.indicators.emaStack) n++;
    if (state.indicators.fairValue && !isCompareMode()) n++;
    return n;
  }

  function indicatorsDropdownHtml() {
    const count = indicatorActiveCount();
    return (
      '<div class="ca-ind-dropdown" id="caIndicators">' +
      '<button type="button" class="ca-toggle ca-ind-btn' +
      (count ? " is-on" : "") +
      '" id="caIndicatorsBtn" aria-haspopup="true" aria-expanded="false" aria-label="Chart indicators menu"><span class="ca-ind-label ca-ind-label--full">Indicators</span><span class="ca-ind-label ca-ind-label--short">Ind</span>' +
      '<span class="ca-ind-count' +
      (count ? "" : " is-empty") +
      '">' +
      count +
      "</span>" +
      '<span class="ca-ind-caret" aria-hidden="true">▾</span></button>' +
      '<div class="ca-ind-menu" id="caIndicatorsMenu" hidden role="menu" aria-label="Chart indicators">' +
      INDICATOR_MENU.map(indicatorMenuBtn).join("") +
      "</div></div>"
    );
  }

  function updateIndicatorBtn() {
    const btn = $("#caIndicatorsBtn");
    if (!btn) return;
    const count = indicatorActiveCount();
    btn.classList.toggle("is-on", count > 0);
    const c = btn.querySelector(".ca-ind-count");
    if (c) {
      c.textContent = String(count);
      c.classList.toggle("is-empty", count === 0);
    }
  }

  function renderYAxis(m, bottom) {
    const ticks = 5;
    const ySpan = m.yMax - m.yMin;
    let svg = "";
    for (let i = 0; i <= ticks; i++) {
      const v = m.yMin + (i / ticks) * ySpan;
      const y = m.y(v);
      svg +=
        '<line x1="' +
        m.pad.l +
        '" y1="' +
        y +
        '" x2="' +
        (m.w - m.pad.r) +
        '" y2="' +
        y +
        '" stroke="#243041" stroke-width="1"/>';
      svg +=
        '<text class="ca-axis-y" x="' +
        (m.pad.l - 5) +
        '" y="' +
        (y + 3) +
        '" text-anchor="end" fill="#8b9cb3" font-size="9" font-variant-numeric="tabular-nums">' +
        escapeHtml(m.mode === "pct" ? fmtPctAxis(v) : fmtPriceAxis(v)) +
        "</text>";
    }
    if (m.mode === "pct" && m.yMin < 0 && m.yMax > 0) {
      const y0 = m.y(0);
      svg +=
        '<line x1="' +
        m.pad.l +
        '" y1="' +
        y0 +
        '" x2="' +
        (m.w - m.pad.r) +
        '" y2="' +
        y0 +
        '" stroke="#4a5a6e" stroke-width="1.25" stroke-dasharray="5 4"/>';
      svg +=
        '<text class="ca-axis-y ca-axis-y--zero" x="' +
        (m.pad.l - 5) +
        '" y="' +
        (y0 + 3) +
        '" text-anchor="end" fill="#c5d0de" font-size="9" font-weight="600">0%</text>';
    }
    svg +=
      '<text class="ca-axis-y-unit" x="4" y="' +
      (m.pad.t + 10) +
      '" text-anchor="start" fill="#6b7a8f" font-size="8" font-weight="600">' +
      escapeHtml(m.mode === "pct" ? "0% = open" : "Price") +
      "</text>";
    return svg;
  }

  function intervalToMs(interval) {
    const iv = String(interval || "5m").toLowerCase();
    const m = /^(\d+)(m|h|d)$/.exec(iv);
    if (!m) return 5 * 60 * 1000;
    const n = parseInt(m[1], 10);
    if (m[2] === "m") return n * 60 * 1000;
    if (m[2] === "h") return n * 60 * 60 * 1000;
    return n * 24 * 60 * 60 * 1000;
  }

  function isPstMinuteAligned(ms, stepMin) {
    if (!Number.isFinite(ms) || stepMin <= 0) return false;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PST_TZ,
      second: "numeric",
      hour12: false,
    }).formatToParts(new Date(ms));
    const sec = parseInt(parts.find((p) => p.type === "second")?.value || "0", 10);
    if (sec !== 0) return false;
    const mins = ptMinutes(ms);
    if (stepMin >= 1440) return mins === 0;
    return mins % stepMin === 0;
  }

  /** Next PST wall-clock tick on or after ms (ToS-style :00 / :30 grid). */
  function alignTimeCeilPst(ms, stepMs) {
    const stepMin = Math.max(1, Math.round(stepMs / 60000));
    let t = ms;
    for (let guard = 0; guard < 2880; guard++) {
      if (t >= ms && isPstMinuteAligned(t, stepMin)) return t;
      t += 60000;
    }
    return ms;
  }

  function chooseTimeAxisStepMs(spanMs, intervalMs, multiDay) {
    const barMin = Math.max(1, Math.round(intervalMs / 60000));
    const intradayPoolMin = [1, 5, 15, 30, 60, 120, 240, 360];
    const dayPoolMin = [1440, 2880, 4320, 7200, 10080];
    const poolMin = multiDay ? dayPoolMin : intradayPoolMin;
    const candidates = poolMin
      .map((min) => min * 60000)
      .filter((stepMs) => {
        const stepMin = stepMs / 60000;
        return stepMin >= barMin && stepMin % barMin === 0;
      });
    if (!candidates.length) candidates.push(intervalMs);
    const maxTicks = 24;
    const minTicks = 3;
    for (const step of candidates) {
      const n = Math.ceil(spanMs / step);
      if (n >= minTicks && n <= maxTicks) return step;
    }
    return candidates[candidates.length - 1];
  }

  function buildTimeAxisTickTimes(tMin, tMax, stepMs) {
    const times = [];
    const maxTicks = 10;
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax) || tMax <= tMin) return times;
    let t = alignTimeCeilPst(tMin, stepMs);
    while (t <= tMax && times.length < maxTicks) {
      times.push(t);
      const next = alignTimeCeilPst(t + stepMs, stepMs);
      t = next <= t ? t + stepMs : next;
    }
    return times;
  }

  function renderTimeAxis(m, axisY) {
    const span = m.tMax - m.tMin;
    const multiDay = span > MULTIDAY_MS;
    const intervalMs = intervalToMs(state.interval);
    const stepMs = chooseTimeAxisStepMs(span, intervalMs, multiDay);
    const tickTimes = buildTimeAxisTickTimes(m.tMin, m.tMax, stepMs);
    let svg = "";
    let lastX = -Infinity;
    const minLabelPx = 40;
    for (const t of tickTimes) {
      const x = m.x(t);
      if (!Number.isFinite(x) || x - lastX < minLabelPx) continue;
      lastX = x;
      const tick = timeTickAnchor(m, x);
      svg +=
        '<text class="ca-axis-time" x="' +
        tick.x +
        '" y="' +
        axisY +
        '" text-anchor="' +
        tick.anchor +
        '" fill="#8b9cb3" font-size="10">' +
        escapeHtml(fmtAxisTick(t, span)) +
        "</text>";
    }
    svg +=
      '<text class="ca-axis-tz" x="' +
      m.pad.l +
      '" y="' +
      (axisY - 12) +
      '" text-anchor="start" fill="#6b7a8f" font-size="9" font-weight="600">' +
      (multiDay ? "PST date" : "PST") +
      "</text>";
    return svg;
  }

  function fmtSubAxisVal(v) {
    if (!Number.isFinite(v)) return "";
    if (v === 0) return "0";
    // Sub-pane scales (MACD, RSI) span very different magnitudes. Fixed 1-decimal
    // rounding collapses small MACD-histogram values (common on quiet sessions or
    // when computed off % series) to "0", making the axis look blank. Use ~2
    // significant digits for sub-1 magnitudes so the scale stays meaningful.
    if (Math.abs(v) >= 1) return String(Math.round(v * 10) / 10);
    return String(Number(v.toPrecision(2)));
  }

  function renderSubPaneYAxis(m, y0, h, ticks, scaleY) {
    let svg = "";
    for (const v of ticks) {
      const y = scaleY(v);
      svg +=
        '<line x1="' +
        m.pad.l +
        '" y1="' +
        y +
        '" x2="' +
        (m.w - m.pad.r) +
        '" y2="' +
        y +
        '" stroke="#243041" stroke-width="1" opacity="0.45"/>';
      svg +=
        '<text class="ca-axis-y ca-axis-y--sub" x="' +
        (m.pad.l - 4) +
        '" y="' +
        (y + 3) +
        '" text-anchor="end" fill="#8b9cb3" font-size="8" font-variant-numeric="tabular-nums">' +
        escapeHtml(fmtSubAxisVal(v)) +
        "</text>";
    }
    return svg;
  }

  const ET_RTH_OPEN_MIN = 9 * 60 + 30;
  const ET_RTH_CLOSE_MIN = 16 * 60;

  function etDayKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }

  function etMinutes(ms) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date(ms));
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return hour * 60 + minute;
  }

  function resolveSessionMeta(hubRef) {
    const hs = chartHubData(hubRef);
    if (hs.sessionMeta?.periods?.regular?.startMs) return hs.sessionMeta;
    const sym = isCompareMode() ? "SPY" : state.symbol;
    const fromBar =
      (typeof hubRef?.getBarMeta === "function" ? hubRef.getBarMeta(sym) : null) ||
      state.hub?.getBarMeta?.(sym) ||
      hs.barMeta?.[sym];
    if (fromBar?.periods?.regular?.startMs) return fromBar;
    return hs.sessionMeta || fromBar || null;
  }

  function ptDayKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: PST_TZ });
  }

  function ptMinutes(ms) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: PST_TZ,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date(ms));
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return hour * 60 + minute;
  }

  function sessionDayBars(bars, sessionMeta) {
    if (!bars?.length) return [];
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    let dayBars = bars.filter((b) => ptDayKey(b.t) === lastDay);
    const rthStartMs = sessionMeta?.periods?.regular?.startMs ?? null;
    if (rthStartMs) dayBars = dayBars.filter((b) => b.t >= rthStartMs);
    else {
      const openMin = 6 * 60 + 30;
      dayBars = dayBars.filter((b) => ptMinutes(b.t) >= openMin);
    }
    return dayBars.length ? dayBars : bars.filter((b) => ptDayKey(b.t) === lastDay);
  }

  function computeOrhOrl(bars, sessionMeta, orMinutes) {
    orMinutes = orMinutes ?? STRUCTURE_OR_MINUTES;
    if (!bars?.length) return { orh: null, orl: null };
    const rthStartMs = sessionMeta?.periods?.regular?.startMs ?? null;
    if (typeof global.RMBacktestH001 !== "undefined" && RMBacktestH001.openingRangeFromBars) {
      const r = RMBacktestH001.openingRangeFromBars(bars, rthStartMs, orMinutes);
      return { orh: r.orh, orl: r.orl };
    }
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    const dayBars = bars.filter((b) => ptDayKey(b.t) === lastDay);
    let orBars = [];
    if (rthStartMs) {
      const end = rthStartMs + orMinutes * 60 * 1000;
      orBars = dayBars.filter((b) => b.t >= rthStartMs && b.t < end);
    }
    if (!orBars.length) {
      const openMin = 6 * 60 + 30;
      orBars = dayBars.filter((b) => {
        const mins = ptMinutes(b.t);
        return mins >= openMin && mins < openMin + orMinutes;
      });
    }
    if (!orBars.length) return { orh: null, orl: null };
    return {
      orh: Math.max(...orBars.map((b) => b.high ?? b.close)),
      orl: Math.min(...orBars.map((b) => b.low ?? b.close)),
    };
  }

  function computeVwap(bars, sessionMeta) {
    const dayBars = sessionDayBars(bars, sessionMeta);
    if (!dayBars.length) return null;
    let pv = 0;
    let vol = 0;
    for (const b of dayBars) {
      const v = Number(b.volume) || 0;
      const typical = ((b.high ?? b.close) + (b.low ?? b.close) + (b.close ?? 0)) / 3;
      pv += typical * v;
      vol += v;
    }
    if (vol > 0) return pv / vol;
    const last = dayBars[dayBars.length - 1];
    return last?.close ?? null;
  }

  function computeVwapSeries(bars, sessionMeta) {
    const dayBars = sessionDayBars(bars, sessionMeta);
    if (!dayBars.length) return [];
    let cumPV = 0;
    let cumV = 0;
    return dayBars.map((b) => {
      const tp = ((b.high ?? b.close) + (b.low ?? b.close) + (b.close ?? 0)) / 3;
      const v = Number(b.volume) || 0;
      cumPV += tp * v;
      cumV += v;
      const vwap = cumV > 0 ? cumPV / cumV : b.close ?? null;
      return { t: b.t, vwap };
    });
  }

  function shouldShowStructureOverlays() {
    if (isCompareMode() || !state.bars?.length) return false;
    const plan = state.tradePlan;
    if (plan?.symbol === state.symbol && (plan.orh != null || plan.orl != null)) return true;
    const intraday = state.range === "1d" || /m$/.test(state.interval || "");
    return intraday;
  }

  function resolveStructureLevels(bars, sessionMeta) {
    const plan = state.tradePlan?.symbol === state.symbol ? state.tradePlan : null;
    const computed = computeOrhOrl(bars, sessionMeta);
    return {
      orh: plan?.orh ?? computed.orh,
      orl: plan?.orl ?? computed.orl,
      vwap: computeVwap(bars, sessionMeta),
    };
  }

  function includeStructureInMetrics(m, bars, sessionMeta) {
    if (!shouldShowStructureOverlays()) return m;
    const levels = resolveStructureLevels(bars, sessionMeta);
    const prices = [levels.orh, levels.orl, levels.vwap].filter(
      (v) => v != null && Number.isFinite(v)
    );
    if (!prices.length) return m;
    const axisPrices = prices.map((p) => planPriceToY(m, p));
    return mergeYExtents(m, Math.min(...axisPrices), Math.max(...axisPrices), 0.06);
  }

  function renderStructureOverlays(m, bars, viewBars, sessionMeta) {
    if (!shouldShowStructureOverlays()) return "";
    const levels = resolveStructureLevels(bars, sessionMeta);
    const x1 = m.pad.l;
    const x2 = m.w - m.pad.r;
    let svg = '<g class="ca-structure-overlays">';
    const drawLevel = (price, label, color, dash) => {
      if (price == null || !Number.isFinite(price)) return;
      const yVal = planPriceToY(m, price);
      const yPx = m.y(yVal);
      const top = m.pad.t;
      const floor = m.mainH - m.pad.b;
      if (yPx < top - 1 || yPx > floor + 1) return;
      svg += renderIndHLine(x1, yPx, x2, {
        color,
        width: 1.25,
        dash,
        title: label,
        desc: "Session structure",
        stat: fmtPriceAxis(price),
        kicker: "Structure",
        visibleClass: "ca-structure-line",
      });
      svg +=
        '<text class="ca-structure-tag" x="' +
        (x2 - 2) +
        '" y="' +
        (yPx - 3) +
        '" text-anchor="end" fill="' +
        color +
        '" font-size="9" font-weight="600" pointer-events="none">' +
        escapeHtml(label + " " + fmtPriceAxis(price)) +
        "</text>";
    };
    drawLevel(levels.orh, "ORH", "#5ba8c9", "5 4");
    drawLevel(levels.orl, "ORL", "#e8954f", "5 4");
    const vwapSeries = computeVwapSeries(bars, sessionMeta);
    if (vwapSeries.length > 1) {
      let d = "";
      let started = false;
      for (let i = 0; i < vwapSeries.length; i++) {
        const pt = vwapSeries[i];
        if (pt.t < m.tMin || pt.t > m.tMax) continue;
        if (pt.vwap == null || !Number.isFinite(pt.vwap)) continue;
        const x = m.x(pt.t);
        const y = m.y(planPriceToY(m, pt.vwap));
        if (!Number.isFinite(y)) continue;
        d += (started ? " L" : "M") + x + " " + y;
        started = true;
      }
      if (d) {
        svg += renderIndPath(d, {
          color: "#d4a24a",
          width: 1.35,
          dash: "3 2",
          title: "VWAP",
          desc: "Session volume-weighted average",
          stat: levels.vwap != null ? fmtPriceAxis(levels.vwap) : "",
          classExtra: "ca-structure-vwap",
          opacity: 0.88,
        });
      }
    }
    svg += "</g>";
    return svg;
  }

  function chartStatusStructureLine() {
    if (isCompareMode() || !state.bars?.length) return null;
    const lastClose = state.bars[state.bars.length - 1]?.close;
    if (lastClose == null) return null;
    const hub = hubState();
    const meta = resolveSessionMeta(hub);
    const levels = resolveStructureLevels(state.bars, meta);
    const bits = [];
    if (levels.vwap != null) {
      bits.push(lastClose >= levels.vwap ? "Above VWAP" : "Below VWAP");
    }
    if (levels.orh != null) {
      bits.push(lastClose >= levels.orh ? "ORH break" : "Below ORH");
    }
    return bits.length ? bits.join(" · ") : null;
  }

  function sessionBandRect(m, tStart, tEnd, bottom, cls) {
    const start = Math.max(tStart, m.tMin);
    const end = Math.min(tEnd, m.tMax);
    if (end <= start) return "";
    const x = m.x(start);
    const w = Math.max(0, m.x(end) - x);
    if (w <= 0) return "";
    return (
      '<rect class="ca-session-band ca-session-band--' +
      cls +
      '" x="' +
      x +
      '" y="' +
      m.pad.t +
      '" width="' +
      w +
      '" height="' +
      (bottom - m.pad.t) +
      '"/>'
    );
  }

  function renderSessionBands(m, meta, bottom, allBars) {
    const bars = allBars || [];
    const periods = meta?.periods;
    let svg = '<g class="ca-session-bands">';
    let drewBand = false;

    if (bars.length) {
      const byDay = new Map();
      for (const b of bars) {
        const dk = etDayKey(b.t);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk).push(b);
      }
      for (const dayBars of byDay.values()) {
        const pre = dayBars.filter((b) => etMinutes(b.t) < ET_RTH_OPEN_MIN);
        const post = dayBars.filter((b) => etMinutes(b.t) >= ET_RTH_CLOSE_MIN);
        if (pre.length) {
          svg += sessionBandRect(
            m,
            Math.min(...pre.map((b) => b.t)),
            Math.max(...pre.map((b) => b.t)),
            bottom,
            "pre"
          );
          drewBand = true;
        }
        if (post.length) {
          svg += sessionBandRect(
            m,
            Math.min(...post.map((b) => b.t)),
            Math.max(...post.map((b) => b.t)),
            bottom,
            "post"
          );
          drewBand = true;
        }
      }
    }

    if (periods && !drewBand) {
      for (const s of [
        { key: "pre", cls: "pre" },
        { key: "post", cls: "post" },
      ]) {
        const p = periods[s.key];
        if (!p?.startMs || !p?.endMs) continue;
        svg += sessionBandRect(m, p.startMs, p.endMs, bottom, s.cls);
        drewBand = true;
      }
    }

    svg += "</g>";
    return drewBand ? svg : "";
  }

  function renderGrid(m, bottom) {
    let svg = "";
    for (let i = 0; i <= 6; i++) {
      const x = m.pad.l + (m.innerW * i) / 6;
      svg +=
        '<line x1="' +
        x +
        '" y1="' +
        m.pad.t +
        '" x2="' +
        x +
        '" y2="' +
        bottom +
        '" stroke="#243041" stroke-width="1" opacity="0.65"/>';
    }
    return svg;
  }

  function renderCompareSvg(hub) {
    const vw = state.viewWindow;
    const pctMode = usePctAxis();
    const spyFull = hub.spyPct || [];
    const spyPct = sliceSeriesForWindow(spyFull, vw);
    const spyBars = sliceBarsForWindow(hub.spyBars || [], vw);
    const overlaySeries = [...(hub.overlays?.values() || [])].map((o) =>
      sliceSeriesForWindow(o.series, vw)
    );
    if (hub.candidateSeries) overlaySeries.push(sliceSeriesForWindow(hub.candidateSeries, vw));
    measureChartSize();
    const panes = indicatorPaneCount();
    const layout = layoutChartHeights(state.h, panes);
    const totalH = layout.totalH;
    const comparePctSeries = [spyFull]
      .concat([...(hub.overlays?.values() || [])].map((o) => o.series))
      .concat(hub.candidateSeries ? [hub.candidateSeries] : []);
    const compareDollarSeries = compareDollarSeriesLists(hub, spyBars);
    const m = pctMode
      ? computePctMetrics(spyPct, overlaySeries, state.w, layout)
      : computeComparePriceMetrics(spyBars, state.w, layout, hub);
    refineMetricsForViewWindow(
      m,
      pctMode ? comparePctSeries : compareDollarSeries,
      vw,
      pctMode ? spyPct : spyBars
    );
    stampAutoYDomain(m);
    applyPanFrozenY(m);
    applyYView(m);
    state.metrics = m;
    const bottom = m.mainH - m.pad.b;
    const axisY = bottom + 14;
    let intel =
      (m._continuous ? "" : renderSessionBands(m, resolveSessionMeta(hub), bottom, hub.spyBars || [])) +
      renderGrid(m, bottom) +
      renderYAxis(m, bottom) +
      renderTimeAxis(m, axisY) +
      renderChartDateLabel(m);

    // Volume backdrop reflects the SPY base series in compare mode. In % mode
    // the bottom of the pane is below the lowest series, so bars stay subtle.
    if (!pctMode) intel += renderVolumeOverlay(spyBars, m);

    // S/R lines for the focused symbol also render in compare mode so they're
    // visible from the default "SPY + picks" view (renderSrLines maps via
    // m.mode and self-clips levels outside the pane).
    if (state.showSR && state.srLines.length) {
      intel += renderSrLines(m, bottom);
    }

    if (state.indicators.ichimoku && spyPct.length >= ICHIMOKU_MIN_BARS) {
      const pseudo = pctAsBars(spyPct);
      intel += renderIchimoku(pseudo, m, buildIchimokuView(pseudo, pseudo));
    }

    const spyPath = pctMode ? pathD(spyPct, m) : pathDFromBars(spyBars, m);
    let data = renderIndPath(spyPath || "M0,0", {
      id: "chSpy",
      color: "#8b9cb3",
      width: 2.5,
      title: "SPY",
      desc: pctMode ? "% change vs day open (PM/RTH/AH)" : "SPY price line",
      stat: "Compare baseline",
      opacity: spyPath ? 1 : 0.25,
      classExtra: "ch-spy-line",
    });

    const spyLast = pctMode ? spyPct[spyPct.length - 1] : spyBars[spyBars.length - 1];
    const spyAll = pctMode ? spyFull : hub.spyBars || [];
    const spyQuote = resolveLastPriceQuote(
      spyAll,
      pctMode ? spyPct : spyBars,
      Object.assign({}, m, { mode: pctMode ? "pct" : "price" })
    );
    if (spyQuote && spyLast) {
      spyQuote.title = "SPY last " + spyQuote.label;
      spyQuote.xLast = m.x(spyLast.t);
      spyQuote.y = pctMode ? m.y(spyLast.pct) : m.y(spyLast.close);
      spyQuote.label = pctMode
        ? fmtLastPriceLabel(spyLast.pct, true)
        : fmtLastPriceLabel(spyLast.close, false);
      const spyPrev = pctMode
        ? spyPct[Math.max(0, spyPct.length - 2)]
        : spyBars[Math.max(0, spyBars.length - 2)];
      const lastVal = pctMode ? spyLast.pct : spyLast.close;
      const prevVal = pctMode ? spyPrev?.pct : spyPrev?.close ?? spyLast.open;
      spyQuote.up = lastVal >= prevVal;
      data += renderLastPricePill(m, spyQuote);
    }

    // #8 fix: pick overlays must draw in BOTH % and $ modes. Overlay series are
    // stored as %-vs-day-open; in $ mode we rebase them onto SPY's price scale
    // (price = spyBase × (1 + pct/100)) so approved picks render next to SPY
    // instead of vanishing the moment the axis flips to $.
    {
    const spyBase = compareSpyBase(spyBars, hub);
    const seriesY = (pt) => {
      const pct = pt.pct != null ? pt.pct : 0;
      if (pctMode) return m.y(pct);
      const price = compareRebasePctToPrice(pct, spyBase);
      return price == null ? null : m.y(price);
    };
    const seriesPath = (series) => {
      if (!series.length) return "";
      let d = "";
      for (let i = 0; i < series.length; i++) {
        const y = seriesY(series[i]);
        if (y == null) return "";
        d += (i === 0 ? "M" : " L") + m.x(series[i].t) + " " + y;
      }
      return d;
    };
    const syms = [...(hub.overlays?.keys() || [])];
    for (const [sym, o] of hub.overlays || []) {
      const series = sliceSeriesForWindow(o.series, vw);
      const d = seriesPath(series);
      if (!d) continue;
      data += renderIndPath(d, {
        color: o.color,
        width: 2,
        title: sym,
        desc: "Pick overlay vs SPY",
        stat: "Compare overlay",
        classExtra: "ch-kept-line",
      });
      const last = series[series.length - 1];
      const ly = last ? seriesY(last) : null;
      if (last && ly != null) {
        const lx = m.x(last.t);
        const symTag = endLabelAnchor(m, lx, sym.length * 7 + 8);
        data +=
          '<text class="ch-sym-label" x="' +
          symTag.x +
          '" y="' +
          (ly - 6) +
          '" text-anchor="' +
          symTag.anchor +
          '" fill="' +
          o.color +
          '">' +
          escapeHtml(sym) +
          "</text>";
      }
    }

    const candidateSeries = sliceSeriesForWindow(hub.candidateSeries, vw);
    const candD = seriesPath(candidateSeries);
    if (candidateSeries.length && candD) {
      const sym = hub.candidateSym || "?";
      const col = colorFor(sym, syms.concat(sym));
      data += renderIndPath(candD, {
        color: col,
        width: 2.5,
        filter: "url(#chGlow)",
        title: sym,
        desc: "Scanning candidate overlay vs SPY",
        stat: "Candidate",
        classExtra: "ch-candidate-line ch-path-sweep",
      });
      const last = candidateSeries[candidateSeries.length - 1];
      const cy = seriesY(last);
      if (cy != null) {
        const clx = m.x(last.t);
        const candTag = endLabelAnchor(m, clx, sym.length * 7 + 8);
        data +=
          '<text class="ch-cand-label" x="' +
          candTag.x +
          '" y="' +
          (cy - 8) +
          '" text-anchor="' +
          candTag.anchor +
          '" fill="' +
          col +
          '">' +
          escapeHtml(sym) +
          "</text>";
      }
    }
    }

    data +=
      '<text class="ch-sym-label ch-spy-label" x="' +
      m.pad.l +
      '" y="' +
      (m.pad.t + 10) +
      '" fill="#8b9cb3">SPY' +
      (spyLast
        ? " · " +
          escapeHtml(
            pctMode ? fmtPctAxis(spyLast.pct) : fmtPriceAxis(spyLast.close)
          )
        : "") +
      "</text>";

    if (state.showEvents && state.events.length && spyPct.length) {
      for (let i = 0; i < state.events.length; i++) {
        const ev = state.events[i];
        const idx = Math.min(spyPct.length - 1 - i * 2, spyPct.length - 1);
        const x = m.x(spyPct[idx].t);
        data += renderChartNode({
          kind: "event",
          nodeId: ev.id || "ev-" + i,
          x,
          y: m.pad.t + 8,
          title: ev.sym || "Event",
          desc: ev.title || "News event",
          stat: fmtPstTime(spyPct[idx].t) + " PST",
        });
      }
    }

    const noteSym = "SPY";
    for (const note of loadAllNotes()[noteSym] || []) {
      if (vw && (note.t < vw.tMin || note.t > vw.tMax)) continue;
      const x = m.x(note.t);
      const y = m.y(note.pct != null ? note.pct : 0);
      data += renderChartNode({
        kind: "note",
        id: note.id,
        x,
        y,
        title: noteSym,
        desc: note.text || "Chart note",
        stat: new Date(note.t).toLocaleString(),
      });
    }

    if (panes) {
      const closes = pctMode ? spyPct.map((p) => p.pct) : spyBars.map((b) => b.close);
      const indBars = pctMode ? spyPct : spyBars;
      intel += renderIndicatorPanes(closes, indBars, m);
    }

    const spyBarsFull = hub.spyBars || [];
    if (spyBarsFull.length >= 31) {
      data += renderMacdRsiBuySignals(m, spyBarsFull, spyBars, {
        tipSymbol: "SPY",
        pctMode,
        pctSeries: pctMode ? spyFull : null,
      });
    }

    const svg =
      '<svg class="ca-chart-svg chart-hub-svg" id="caChartSvg" viewBox="0 0 ' +
      m.w +
      " " +
      totalH +
      '" preserveAspectRatio="none">' +
      '<defs><filter id="chGlow" x="-20%" y="-20%" width="140%" height="140%">' +
      '<feGaussianBlur stdDeviation="2" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
      wrapChartLayers(intel, data) +
      "</svg>";
    return svg;
  }

  function renderBrushMiniSeries(series) {
    const cc = chartColors();
    const ext = state.fullExtent;
    if (!series?.length || !ext) return "";
    const vals = series.map((p) => p.pct ?? p.close ?? 0);
    const yMin = Math.min(...vals);
    const yMax = Math.max(...vals);
    const span = yMax - yMin || 1;
    const pts = series
      .map((p) => {
        const x = timeToAxisRatio(p.t, ext, state.timeIndex) * 100;
        const y = 21 - (((p.pct ?? p.close ?? 0) - yMin) / span) * 18;
        return x.toFixed(2) + "," + y.toFixed(2);
      })
      .join(" ");
    return (
      '<polyline points="' +
      pts +
      '" fill="none" stroke="' +
      cc.accent +
      '" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity="0.85"/>'
    );
  }

  function brushTrackHtml() {
    return (
      '<div class="ca-time-brush" aria-label="Chart time range">' +
      '<div class="ca-time-brush-track" id="caBrushTrack">' +
      '<svg class="ca-time-brush-mini" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"></svg>' +
      '<div class="ca-time-brush-shade ca-time-brush-shade--left"></div>' +
      '<div class="ca-time-brush-shade ca-time-brush-shade--right"></div>' +
      '<div class="ca-time-brush-selection">' +
      '<button type="button" class="ca-time-brush-bumper ca-time-brush-bumper--start" aria-label="Drag to adjust start time" title="Drag to adjust start">' +
      '<span class="ca-time-brush-bumper-grip" aria-hidden="true"></span></button>' +
      '<button type="button" class="ca-time-brush-bumper ca-time-brush-bumper--end" aria-label="Drag to adjust end time" title="Drag to adjust end">' +
      '<span class="ca-time-brush-bumper-grip" aria-hidden="true"></span></button>' +
      "</div></div></div>"
    );
  }

  function updateBrushVisuals(brush, hub) {
    const ext = chartBrushExtent(hub) || state.fullExtent;
    const vw = state.viewWindow;
    if (!brush || !ext || !vw) {
      if (brush) brush.hidden = true;
      return;
    }
    brush.hidden = false;
    const track = brush.querySelector("#caBrushTrack");
    const leftShade = brush.querySelector(".ca-time-brush-shade--left");
    const rightShade = brush.querySelector(".ca-time-brush-shade--right");
    const selection = brush.querySelector(".ca-time-brush-selection");
    const startHandle = brush.querySelector(".ca-time-brush-bumper--start");
    const endHandle = brush.querySelector(".ca-time-brush-bumper--end");
    const mini = brush.querySelector(".ca-time-brush-mini");
    if (!track || !selection || !startHandle || !endHandle) return;

    const ti = state.timeIndex;
    const leftPct = timeToAxisRatio(vw.tMin, ext, ti) * 100;
    const rightPct = timeToAxisRatio(vw.tMax, ext, ti) * 100;
    const selLeft = Math.max(0, Math.min(100, leftPct));
    const selRight = Math.max(0, Math.min(100, rightPct));

    selection.style.left = selLeft + "%";
    selection.style.width = Math.max(0, selRight - selLeft) + "%";
    if (leftShade) {
      leftShade.style.width = selLeft + "%";
    }
    if (rightShade) {
      rightShade.style.left = selRight + "%";
      rightShade.style.width = Math.max(0, 100 - selRight) + "%";
    }
    if (mini && !brushDrag.active) {
      const series = isCompareMode() ? hub.spyPct || [] : state.bars || [];
      mini.innerHTML = renderBrushMiniSeries(series);
    }
  }

  function applyBrushViewWindow(tMin, tMax, brush) {
    state.viewWindow = { tMin, tMax };
    updateBrushVisuals(brush, hubState());
    requestAnimationFrame(() => repaintChartSvg({ viewOnly: true }));
  }

  function bindTimeBrush(brush) {
    if (!brush || brush.dataset.bound === "1") return;
    const track = brush.querySelector("#caBrushTrack");
    const startHandle = brush.querySelector(".ca-time-brush-bumper--start");
    const endHandle = brush.querySelector(".ca-time-brush-bumper--end");
    const selection = brush.querySelector(".ca-time-brush-selection");
    if (!track || !startHandle || !endHandle || !selection) return;
    brush.dataset.bound = "1";

    let chartRaf = null;

    const syncChart = () => {
      if (chartRaf) cancelAnimationFrame(chartRaf);
      chartRaf = requestAnimationFrame(() => {
        chartRaf = null;
        repaintChartSvg({ viewOnly: true });
      });
    };

    const applyWindow = (tMin, tMax) => {
      scanBrushExtentLock = null;
      clearMorningScanViewLock();
      state.viewWindow = { tMin, tMax };
      updateBrushVisuals(brush, hubState());
      syncChart();
    };

    const onPointerMove = (e) => {
      if (!brushDrag.active || !state.fullExtent || !brushDrag.startVw) return;
      brushDrag.moveCount += 1;
      e.preventDefault();
      const rect = track.getBoundingClientRect();
      if (!rect.width) return;
      const full = state.fullExtent;
      const ti = state.timeIndex;
      if (shouldUseContinuousAxis() && ti?.count > 1) {
        const dRatio = (e.clientX - brushDrag.startX) / rect.width;
        const dIdx = Math.round(dRatio * (ti.count - 1));
        let { iMin, iMax } = viewWindowToIndices(brushDrag.startVw, ti);
        const minSpan = 2;
        if (brushDrag.active === "start") {
          iMin = Math.max(0, Math.min(iMax - minSpan, iMin + dIdx));
        } else if (brushDrag.active === "end") {
          iMax = Math.min(ti.count - 1, Math.max(iMin + minSpan, iMax + dIdx));
        } else {
          iMin += dIdx;
          iMax += dIdx;
          if (iMin < 0) {
            iMax -= iMin;
            iMin = 0;
          }
          if (iMax > ti.count - 1) {
            iMin -= iMax - (ti.count - 1);
            iMax = ti.count - 1;
          }
        }
        const vwNext = indicesToViewWindow(iMin, iMax, ti);
        applyWindow(vwNext.tMin, vwNext.tMax);
        return;
      }
      const dt = ((e.clientX - brushDrag.startX) / rect.width) * (full.tMax - full.tMin);
      let tMin = brushDrag.startVw.tMin;
      let tMax = brushDrag.startVw.tMax;
      if (brushDrag.active === "start") {
        tMin = Math.max(full.tMin, Math.min(tMax - MIN_VIEW_WINDOW_MS, brushDrag.startVw.tMin + dt));
      } else if (brushDrag.active === "end") {
        tMax = Math.min(full.tMax, Math.max(tMin + MIN_VIEW_WINDOW_MS, brushDrag.startVw.tMax + dt));
      } else {
        tMin = brushDrag.startVw.tMin + dt;
        tMax = brushDrag.startVw.tMax + dt;
        if (tMin < full.tMin) {
          tMax += full.tMin - tMin;
          tMin = full.tMin;
        }
        if (tMax > full.tMax) {
          tMin -= tMax - full.tMax;
          tMax = full.tMax;
        }
      }
      applyWindow(tMin, tMax);
    };

    const endDrag = (e) => {
      if (!brushDrag.active) return;
      brushDrag.active = null;
      brushDrag.startVw = null;
      brushDrag.moveCount = 0;
      brush.classList.remove("is-dragging");
      setChartInteracting(false);
      if (brushDrag.captureEl?.releasePointerCapture && brushDrag.pointerId != null) {
        try {
          brushDrag.captureEl.releasePointerCapture(brushDrag.pointerId);
        } catch {
          /* ignore */
        }
      }
      brushDrag.captureEl = null;
      brushDrag.pointerId = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      const hub = hubState();
      requestAnimationFrame(() => {
        updateBrushVisuals(brush, hub);
        repaintChartSvg({ viewOnly: true });
      });
    };

    const beginDrag = (role, e) => {
      if (!state.fullExtent || !state.viewWindow) return;
      e.preventDefault();
      e.stopPropagation();
      brushDrag.moveCount = 0;
      brushDrag.active = role;
      brushDrag.startX = e.clientX;
      brushDrag.startVw = { ...state.viewWindow };
      brushDrag.pointerId = e.pointerId;
      brushDrag.captureEl = e.currentTarget;
      brush.classList.add("is-dragging");
      setChartInteracting(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
    };

    startHandle.addEventListener("pointerdown", (e) => beginDrag("start", e));
    endHandle.addEventListener("pointerdown", (e) => beginDrag("end", e));
    selection.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ca-time-brush-bumper")) return;
      beginDrag("move", e);
    });

    track.addEventListener("pointerdown", (e) => {
      if (
        e.target.closest(".ca-time-brush-bumper") ||
        e.target.closest(".ca-time-brush-selection")
      ) {
        return;
      }
      if (!state.fullExtent || !state.viewWindow) return;
      const rect = track.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const full = state.fullExtent;
      const ti = state.timeIndex;
      if (shouldUseContinuousAxis() && ti?.count > 1) {
        const { iMin, iMax } = viewWindowToIndices(state.viewWindow, ti);
        const width = Math.max(2, iMax - iMin);
        let centerIdx = Math.round(pct * (ti.count - 1));
        let newMin = Math.max(0, centerIdx - Math.floor(width / 2));
        let newMax = Math.min(ti.count - 1, newMin + width);
        if (newMax - newMin < 2) newMax = Math.min(ti.count - 1, newMin + 2);
        applyBrushViewWindow(ti.times[newMin], ti.times[newMax], brush);
        return;
      }
      const span = state.viewWindow.tMax - state.viewWindow.tMin;
      let tMin = full.tMin + pct * (full.tMax - full.tMin) - span / 2;
      tMin = Math.max(full.tMin, Math.min(full.tMax - span, tMin));
      applyBrushViewWindow(tMin, tMin + span, brush);
    });
  }

  function paintBrush(mount, hub) {
    if (!mount) return;
    let brush = mount.querySelector(".ca-time-brush");
    if (!state.fullExtent || !state.viewWindow) {
      if (brush) brush.hidden = true;
      return;
    }
    if (!brush) {
      const holder = document.createElement("div");
      holder.innerHTML = brushTrackHtml();
      brush = holder.firstElementChild;
      mount.appendChild(brush);
      bindTimeBrush(brush);
    } else if (!brush.querySelector(".ca-time-brush-bumper--start")) {
      brush.remove();
      const holder = document.createElement("div");
      holder.innerHTML = brushTrackHtml();
      brush = holder.firstElementChild;
      mount.appendChild(brush);
      bindTimeBrush(brush);
    } else if (brush.dataset.bound !== "1") {
      bindTimeBrush(brush);
    }
    updateBrushVisuals(brush, hub);
  }

  function setMapHighlight(symbol, pick) {
    const sym = symbol ? String(symbol).toUpperCase() : null;
    if (!sym || !pick) {
      state.mapHighlight = null;
    } else {
      state.mapHighlight = { symbol: sym, pick };
    }
    if (state.container) paint();
  }

  function renderCandles(bars, m) {
    if (!bars.length) return "";
    const cc = chartColors();
    const bw = Math.max(2, (m.innerW / bars.length) * 0.6);
    const base = priorCloseForSymbol(chartPriceSymbol());
    const yPrice = (p) =>
      m.mode === "pct" && base ? ((p - base) / base) * 100 : p;
    let svg = "";
    for (const b of bars) {
      const x = m.x(b.t);
      const o = b.open ?? b.close;
      const c = b.close;
      const { lo, hi } = barLoHiForLayout(b);
      const up = c >= o;
      const col = up ? cc.candleUp : cc.bear;
      svg +=
        '<line x1="' +
        x +
        '" y1="' +
        m.y(yPrice(hi)) +
        '" x2="' +
        x +
        '" y2="' +
        m.y(yPrice(lo)) +
        '" stroke="' +
        col +
        '" stroke-width="1"/>';
      const yHi = m.y(yPrice(Math.max(o, c)));
      const yLo = m.y(yPrice(Math.min(o, c)));
      const top = Math.min(yHi, yLo);
      const h = Math.max(1, Math.abs(yLo - yHi));
      svg +=
        '<rect x="' +
        (x - bw / 2) +
        '" y="' +
        top +
        '" width="' +
        bw +
        '" height="' +
        h +
        '" fill="' +
        col +
        '"/>';
    }
    return '<g class="ca-candles">' + svg + "</g>";
  }

  function renderLine(values, bars, m, color, dash, yFn, title, desc) {
    if (!values.length || !bars.length) return "";
    const y = yFn || m.y;
    let d = "";
    for (let i = 0; i < bars.length; i++) {
      if (!Number.isFinite(values[i])) continue;
      d += (d ? " L" : "M") + m.x(bars[i].t) + " " + y(values[i]);
    }
    if (!d) return "";
    return renderIndPath(d, {
      color,
      width: 1.5,
      dash,
      title: title || "Indicator",
      desc: desc || "",
      stat: "",
    });
  }

  function renderIchimoku(viewBars, m, pack) {
    if (!viewBars.length || !pack) return "";
    const { ichi, viewIdx } = pack;
    const k = ICHIMOKU_DISPLACE;
    let cloud = "";
    for (let vi = 1; vi < viewBars.length; vi++) {
      const fi0 = viewIdx[vi - 1];
      const fi1 = viewIdx[vi];
      if (fi0 < 0 || fi1 < 0) continue;
      const s0 = fi0 - k;
      const s1 = fi1 - k;
      if (s1 < 0 || s0 < 0) continue;
      const a0 = ichi.spanA[s0];
      const a1 = ichi.spanA[s1];
      const b0 = ichi.spanB[s0];
      const b1 = ichi.spanB[s1];
      if (![a0, a1, b0, b1].every(Number.isFinite)) continue;
      const x0 = m.x(viewBars[vi - 1].t);
      const x1 = m.x(viewBars[vi].t);
      const bull = a1 >= b1;
      cloud +=
        '<polygon class="ca-ind-hit fv-tip-target" tabindex="0"' +
        fvTip(
          "Indicator",
          "Ichimoku cloud",
          "Senkou Span A/B projected +26 periods — teal when Span A is above B.",
          bull ? "Bull cloud" : "Bear cloud",
          "chart-ind-line"
        ) +
        ' points="' +
        x0 +
        "," +
        m.y(a0) +
        " " +
        x1 +
        "," +
        m.y(a1) +
        " " +
        x1 +
        "," +
        m.y(b1) +
        " " +
        x0 +
        "," +
        m.y(b0) +
        '" fill="' +
        (bull ? "rgba(78,184,201,0.12)" : "rgba(232,149,79,0.12)") +
        '" pointer-events="fill">' +
        svgTitle("Ichimoku cloud (Senkou A/B +26)") +
        "</polygon>";
    }
    return cloud;
  }

  function renderSubPane(values, bars, m, y0, h, color, label) {
    let min = 0;
    let max = 100;
    if (label !== "RSI") {
      min = Infinity;
      max = -Infinity;
      for (const v of values) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      if (!Number.isFinite(min)) return "";
    }
    const pad = 4;
    const scaleY = (v) => y0 + h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    const ticks = label === "RSI" ? [30, 50, 70] : [min, (min + max) / 2, max];
    let d = "M" + m.x(bars[0].t) + " " + scaleY(values[0]);
    for (let i = 1; i < bars.length; i++) {
      d += " L" + m.x(bars[i].t) + " " + scaleY(values[i]);
    }
    return (
      '<g class="ca-subpane">' +
      renderSubPaneYAxis(m, y0, h, ticks, scaleY) +
      '<text x="' +
      m.pad.l +
      '" y="' +
      (y0 + 12) +
      '" fill="#8b9cb3" font-size="10" pointer-events="none">' +
      escapeHtml(label) +
      "</text>" +
      renderIndPath(d, {
        color,
        width: 1.2,
        title: label,
        desc: label === "RSI" ? "Relative strength index (14-period default)" : label + " sub-pane",
        stat: label === "RSI" ? "30 / 50 / 70 guides" : "",
      }) +
      "</g>"
    );
  }

  // Volume overlays the bottom of the MAIN price pane (TradingView-style):
  // slightly-off-grey at rest, colored bull/bear ONLY when the cursor is near
  // the volume band (driven by the .ca-vol-overlay.is-near class set in
  // onChartHover, item 8). Bars render across the full window including pre/post.
  function renderVolumeOverlay(bars, m) {
    if (!state.indicators.volume || !bars || !bars.length) return "";
    let max = 0;
    for (const b of bars) {
      const v = Number(b.volume) || 0;
      if (v > max) max = v;
    }
    if (max <= 0) return "";
    const bottom = m.mainH - m.pad.b;
    // Volume occupies the lower ~22% of the main pane.
    const band = Math.max(28, (m.mainH - m.pad.t - m.pad.b) * 0.22);
    // Expose the band geometry so onChartHover can detect cursor proximity.
    m._volBandTop = bottom - band;
    m._volBandBottom = bottom;
    const scaleH = (v) => ((Number(v) || 0) / max) * band;
    let bw = 3;
    if (bars.length > 1) {
      const span = Math.abs(m.x(bars[bars.length - 1].t) - m.x(bars[0].t));
      bw = Math.max(1, Math.min(10, (span / bars.length) * 0.7));
    }
    let rects = "";
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const v = Number(b.volume) || 0;
      if (v <= 0) continue; // pre/post bars with real volume still draw
      const vh = Math.max(1, scaleH(v)); // floor so light pre/post volume is visible
      const up = (b.close ?? 0) >= (b.open ?? b.close ?? 0);
      const x = m.x(b.t) - bw / 2;
      rects +=
        '<rect class="ca-vol-bar" data-dir="' +
        (up ? "up" : "down") +
        '" x="' +
        x.toFixed(1) +
        '" y="' +
        (bottom - vh).toFixed(1) +
        '" width="' +
        bw.toFixed(1) +
        '" height="' +
        vh.toFixed(1) +
        '"/>';
    }
    return '<g class="ca-vol-overlay" aria-hidden="true">' + rects + "</g>";
  }

  function renderMacdSub(macd, bars, m, y0, h) {
    const cc = chartColors();
    let histBars = "";
    let macdPath = "";
    let signalPath = "";
    const min = Math.min(...macd.hist);
    const max = Math.max(...macd.hist);
    const scale = Math.max(Math.abs(min), Math.abs(max)) || 1;
    const midY = y0 + h / 2;
    for (let i = 0; i < bars.length; i++) {
      const x = m.x(bars[i].t);
      const v = macd.hist[i];
      const y = midY - (v / scale) * (h / 2 - 8);
      histBars +=
        '<rect x="' +
        (x - 1.5) +
        '" y="' +
        Math.min(y, midY) +
        '" width="3" height="' +
        Math.max(1, Math.abs(y - midY)) +
        '" fill="' +
        (v >= 0 ? cc.bull : cc.bear) +
        '" pointer-events="none"/>';
    }
    const lineY = (v) => midY - (v / scale) * (h / 2 - 8);
    const macdScaleY = (v) => lineY(v);
    const macdTicks = [-scale, 0, scale];
    if (bars.length) {
      macdPath = "M" + m.x(bars[0].t) + " " + lineY(macd.macd[0]);
      signalPath = "M" + m.x(bars[0].t) + " " + lineY(macd.signal[0]);
      for (let i = 1; i < bars.length; i++) {
        macdPath += " L" + m.x(bars[i].t) + " " + lineY(macd.macd[i]);
        signalPath += " L" + m.x(bars[i].t) + " " + lineY(macd.signal[i]);
      }
    }
    return (
      '<g class="ca-subpane">' +
      renderSubPaneYAxis(m, y0, h, macdTicks, macdScaleY) +
      '<text x="' +
      m.pad.l +
      '" y="' +
      (y0 + 12) +
      '" fill="#8b9cb3" font-size="10" pointer-events="none">MACD</text>' +
      histBars +
      renderIndPath(signalPath, {
        color: "#8b9cb3",
        width: 1,
        title: "MACD signal",
        desc: "9-period EMA of the MACD line",
        stat: "12 / 26 / 9",
      }) +
      renderIndPath(macdPath, {
        color: "#d4a24a",
        width: 1,
        title: "MACD line",
        desc: "12 EMA minus 26 EMA — histogram shows momentum vs signal",
        stat: "12 / 26 / 9",
      }) +
      "</g>"
    );
  }

  function renderSymbolSvg(bars) {
    const vw = state.viewWindow;
    const viewBars = sliceBarsForWindow(bars, vw);
    const hub = hubState();
    measureChartSize();
    const panes = indicatorPaneCount();
    const layout = layoutChartHeights(state.h, panes);
    const totalH = layout.totalH;
    let m = computePriceLayout(viewBars, state.w, layout);
    refineMetricsForViewWindow(m, [viewBars], vw, viewBars);
    const pctMode = usePctAxis();
    const ichiFull = ichimokuInputBars(bars, pctMode);
    const ichiView = ichimokuInputBars(viewBars, pctMode);
    const ichiPack =
      state.indicators.ichimoku && bars.length >= ICHIMOKU_MIN_BARS
        ? buildIchimokuView(ichiFull, ichiView)
        : null;
    if (ichiPack) includeIchimokuInMetrics(m, ichiPack, viewBars);
    let emaView = null;
    if (state.indicators.emaStack && typeof global.RMEmaOverlay !== "undefined") {
      const stack = global.RMEmaOverlay.computeStack(bars);
      emaView = global.RMEmaOverlay.seriesForView(bars, viewBars, stack);
      if (emaView) {
        emaView = emaViewForAxis(m, emaView);
        m = global.RMEmaOverlay.includeInMetrics(m, emaView, mergeYExtents);
      }
    }
    const fvActive =
      state.indicators.fairValue === true &&
      !isCompareMode() &&
      typeof global.RMFundamentalValue !== "undefined";
    const fvPayload = fvActive ? state.fundamentalValuation : null;
    m = includeTradePlanInMetrics(m);
    const sessionMeta = resolveSessionMeta(hub);
    m = includeStructureInMetrics(m, bars, sessionMeta);
    stampAutoYDomain(m);
    applyPanFrozenY(m);
    applyYView(m);
    state.metrics = m;
    const closes = viewBars.map((b) => b.close);
    const bottom = m.mainH - m.pad.b;
    const axisY = bottom + 14;
    let intel =
      (m._continuous ? "" : renderSessionBands(m, sessionMeta, bottom, bars)) +
      renderGrid(m, bottom) +
      renderYAxis(m, bottom) +
      renderTimeAxis(m, axisY) +
      renderChartDateLabel(m);
    intel += renderVolumeOverlay(viewBars, m);
    if (state.showSR && state.srLines.length) {
      intel += renderSrLines(m, bottom);
    }
    intel += renderStructureOverlays(m, bars, viewBars, sessionMeta);
    intel += renderDebriefWindow(m, viewBars);
    intel += renderHoldingBands(m, viewBars);
    if (typeof global.RMChartScan !== "undefined" && !isCompareMode()) {
      intel += global.RMChartScan.renderRegionsSvg(m, state.symbol, vw);
    }
    intel += renderTradePlanLines(m, viewBars);
    intel += renderTradePlanProjection(m, bars, bottom);
    if (ichiPack && viewBars.length > 1) {
      intel += renderIchimoku(viewBars, m, ichiPack);
    }
    if (emaView && viewBars.length > 1) {
      if (global.RMEmaSignals && !state.lastEmaPack) {
        const stackFull = global.RMEmaOverlay.computeStack(bars);
        if (stackFull) state.lastEmaPack = global.RMEmaSignals.detect(bars, stackFull);
      }
      intel += global.RMEmaOverlay.render(viewBars, emaView, m, {
        escapeAttr,
        svgTitle,
        trendHint: state.lastEmaPack?.lastTrendLabel || "",
        renderIndPath,
      });
    }

    let data = renderCandles(viewBars, m);
    const lastQuote = resolveLastPriceQuote(bars, viewBars, m);
    if (lastQuote) data += renderLastPricePill(m, lastQuote);
    data += renderTradeMarkers(m, viewBars);
    data += renderTradePlanFlag(m, viewBars);

    if (state.showEvents && state.events.length) {
      for (let i = 0; i < state.events.length; i++) {
        const ev = state.events[i];
        // Place at the real headline time when known; skip if it falls outside
        // the current view window. Fall back to a spread near recent bars when
        // the headline carries no timestamp (item 16).
        if (ev.t != null) {
          if (vw && (ev.t < vw.tMin || ev.t > vw.tMax)) continue;
          const bar = nearestBarByTime(viewBars, ev.t);
          if (!bar) continue;
          data += renderChartNode({
            kind: "event",
            nodeId: ev.id || "sym-ev-" + i,
            x: m.x(ev.t),
            y: m.y(barFieldToAxis(m, bar, "high")),
            title: state.symbol,
            desc: ev.title || "Event",
            stat: fmtPstTime(ev.t) + " PST",
          });
          continue;
        }
        const idx = Math.max(0, Math.min(viewBars.length - 1 - i * 2, viewBars.length - 1));
        const bar = viewBars[idx];
        if (!bar) continue;
        data += renderChartNode({
          kind: "event",
          nodeId: ev.id || "sym-ev-" + i,
          x: m.x(bar.t),
          y: m.y(barFieldToAxis(m, bar, "close")),
          title: state.symbol,
          desc: ev.title || "Event",
          stat: fmtPstTime(bar.t) + " PST",
        });
      }
    }

    data += renderNewsNodes(m, viewBars, state.symbol);
    data += renderMapHighlightNodes(m, viewBars);

    for (const note of notesForSymbol(state.symbol)) {
      if (vw && (note.t < vw.tMin || note.t > vw.tMax)) continue;
      const anchor = noteAnchorFromData(note, m);
      if (!anchor) continue;
      data += renderChartNode({
        kind: "note",
        id: note.id,
        x: anchor.x,
        y: anchor.y,
        title: state.symbol,
        desc: note.text || "Chart note",
        stat: new Date(note.t).toLocaleString(),
      });
    }

    data += renderMacdRsiBuySignals(m, bars, viewBars);
    data += renderEmaSignalMarkers(m, bars);

    if (panes) {
      intel += renderIndicatorPanes(closes, viewBars, m);
    }
    if (fvActive && viewBars.length > 1) {
      const lastClose = viewBars[viewBars.length - 1].close;
      const fvHelpers = {
        escapeAttr,
        fvTipData:
          typeof RMUiTips !== "undefined" ? RMUiTips.fvTipData.bind(RMUiTips) : null,
      };
      const hasSeries =
        fvPayload &&
        (global.RMFundamentalValue.hasHistoricalSeries(fvPayload) ||
          Number.isFinite(fvPayload.fairValue));
      const fvChart = fvValuationForChart(m, fvPayload) || fvPayload;
      const fvSvg =
        hasSeries
          ? global.RMFundamentalValue.render(viewBars, m, fvChart, lastClose, {
              ...fvHelpers,
              displayFairValue: fvPayload.fairValue,
              tooltipValuation: fvPayload,
            })
          : "";
      intel += fvSvg;
    }
    const svg =
      '<svg class="ca-chart-svg chart-hub-svg" id="caChartSvg" viewBox="0 0 ' +
      m.w +
      " " +
      totalH +
      '" preserveAspectRatio="none">' +
      wrapChartLayers(intel, data) +
      "</svg>";
    return svg;
  }

  function noteAnchorFromData(note, m) {
    if (!note || !m) return null;
    if (note.scan_id && typeof global.RMChartScan !== "undefined") {
      const scan = global.RMChartScan.getScanForDebrief(note.scan_id);
      if (scan?.centerT != null && scan.centerP != null && m.x && m.y) {
        const rPx = scanCircleRadiusPx(scan, m);
        const cx = m.x(scan.centerT);
        const cy = m.y(scanCenterAxisY(m, scan));
        const angle = note.scan_angle ?? scan.noteAngle ?? -Math.PI / 2;
        return {
          x: cx + rPx * Math.cos(angle),
          y: cy + rPx * Math.sin(angle),
        };
      }
    }
    const x = m.x(note.t);
    const y =
      note.pct != null
        ? m.y(note.pct)
        : note.price != null
          ? m.y(planPriceToY(m, note.price))
          : m.mainH / 2;
    return { x, y };
  }

  function noteEditorHost(mount) {
    return mount || null;
  }

  function noteEditorPositionBox(mount) {
    const wrap = mount?.querySelector(".ca-chart-svg-wrap");
    if (!wrap) return null;
    return { wrap, boxW: wrap.clientWidth, boxH: wrap.clientHeight, top: wrap.offsetTop };
  }

  function positionNoteEditorOverlay() {
    const mount = $(".ca-chart-mount");
    const host = noteEditorHost(mount);
    const editor = host ? host.querySelector("#caNoteEditor") : null;
    const svg = mount?.querySelector("#caChartSvg");
    const m = state.metrics;
    const box = noteEditorPositionBox(mount);
    if (!host || !editor || !svg || !m || !box || !state.noteEditorAnchor || editor.classList.contains("hidden")) {
      return;
    }
    const { boxW, boxH, top: wrapTop } = box;
    if (boxW <= 0 || boxH <= 0) return;
    let left = (state.noteEditorAnchor.x / m.w) * boxW + 8;
    let top = wrapTop + (state.noteEditorAnchor.y / m.h) * boxH + 8;
    editor.classList.remove("hidden");
    const ew = editor.offsetWidth || 168;
    const eh = editor.offsetHeight || 32;
    left = Math.max(4, Math.min(left, boxW - ew - 4));
    top = Math.max(wrapTop + 4, Math.min(top, wrapTop + boxH - eh - 4));
    editor.style.left = left + "px";
    editor.style.top = top + "px";
  }

  let noteEditorWired = false;

  function saveActiveNoteText() {
    const key = isCompareMode() ? "SPY" : state.symbol;
    const note = (loadAllNotes()[key] || []).find((n) => n.id === state.activeNoteId);
    const input = $("#caNoteInput");
    if (!note || !input) return;
    note.text = input.value || "";
    persistNote(key, note);
  }

  function closeNoteEditor() {
    saveActiveNoteText();
    state.activeNoteId = null;
    state.noteEditorAnchor = null;
    syncNoteEditor();
    paint();
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(state.container);
  }

  function ensureNoteEditorOverlay(mount) {
    if (!mount) return;
    const host = noteEditorHost(mount);
    if (!host) return;
    let editor = host.querySelector("#caNoteEditor");
    if (!editor) {
      noteEditorWired = false;
      host.insertAdjacentHTML("beforeend", noteEditorOverlayHtml());
      editor = host.querySelector("#caNoteEditor");
    }
    if (!noteEditorWired && editor) {
      noteEditorWired = true;
      editor.addEventListener("click", (e) => e.stopPropagation());
      editor.addEventListener("mousedown", (e) => e.stopPropagation());
      const input = editor.querySelector("#caNoteInput");
      editor.querySelectorAll(".ca-note-overlay-btn").forEach((btn) => {
        btn.addEventListener("mousedown", (e) => e.preventDefault());
      });
      input?.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          closeNoteEditor();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeNoteEditor();
        }
      });
      input?.addEventListener("blur", (e) => {
        if (!state.activeNoteId) return;
        const next = e.relatedTarget;
        if (next && editor.contains(next)) return;
        saveActiveNoteText();
        paint();
      });
      editor.querySelector("#caDeleteNote")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const key = isCompareMode() ? "SPY" : state.symbol;
        if (state.activeNoteId) deleteNote(key, state.activeNoteId);
        state.activeNoteId = null;
        state.noteEditorAnchor = null;
        syncNoteEditor();
        paint();
      });
      editor.querySelector("#caCloseNote")?.addEventListener("click", (e) => {
        e.stopPropagation();
        closeNoteEditor();
      });
      editor.querySelector("#caNoteTags")?.addEventListener("click", (e) => {
        const btn = e.target.closest?.("[data-note-tag]");
        if (!btn) return;
        e.stopPropagation();
        e.preventDefault();
        toggleNoteTag(btn.getAttribute("data-note-tag"));
      });
    }
    syncNoteEditor();
  }

  function syncNoteEditor() {
    const mount = $(".ca-chart-mount");
    const host = noteEditorHost(mount);
    const editor = host ? host.querySelector("#caNoteEditor") : null;
    const input = host ? host.querySelector("#caNoteInput") : null;
    if (!editor || !input) return;
    const key = isCompareMode() ? "SPY" : state.symbol;
    const note = (loadAllNotes()[key] || []).find((n) => n.id === state.activeNoteId);
    if (note) {
      if (!Array.isArray(note.tags)) note.tags = [];
      input.value = note.text || "";
      renderNoteTagButtons(note);
      editor.classList.remove("hidden");
      requestAnimationFrame(() => positionNoteEditorOverlay());
    } else {
      editor.classList.add("hidden");
      input.value = "";
      renderNoteTagButtons(null);
    }
  }

  function openNoteAt(t, priceOrPct, anchorX, anchorY) {
    const key = isCompareMode() ? "SPY" : state.symbol;
    const id = "n-" + Date.now();
    const note = isCompareMode()
      ? { id, t, pct: priceOrPct, text: "", tags: [] }
      : { id, t, price: priceOrPct, text: "", tags: [] };
    persistNote(key, note);
    state.activeNoteId = id;
    state.noteEditorAnchor = { x: anchorX, y: anchorY };
    syncNoteEditor();
    paint();
    requestAnimationFrame(() => {
      positionNoteEditorOverlay();
      const input = noteEditorHost($(".ca-chart-mount"))?.querySelector("#caNoteInput");
      input?.focus();
      input?.select();
    });
  }

  function selectNote(id) {
    state.activeNoteId = id;
    const key = isCompareMode() ? "SPY" : state.symbol;
    const note = (loadAllNotes()[key] || []).find((n) => n.id === id);
    const anchor = noteAnchorFromData(note, state.metrics);
    state.noteEditorAnchor = anchor;
    syncNoteEditor();
    paint();
    requestAnimationFrame(() => {
      positionNoteEditorOverlay();
      const input = noteEditorHost($(".ca-chart-mount"))?.querySelector("#caNoteInput");
      input?.focus();
      input?.select();
    });
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(state.container);
  }

  function chartInteractExempt(target) {
    return target.closest(
      ".ca-buy-bag, .ca-buy-bag-hit, .ca-chart-node.ca-buy-bag, #fvMapTip, .fv-map-tip, .ca-plan-flag, .ca-plan-flag-hit, [data-plan-flag], .ca-rm-rec, .ca-trade-plan, .ca-trade-proj, .ca-pane-resizer, #caNoteEditor, .ca-time-brush, .ca-sr-line, .ca-sr-line-hit, .ca-ind-hit, .ca-fv-hit"
    );
  }

  /* ---- Crosshair + cursor readout (item 9) ---- */
  function fmtCrosshairTime(t) {
    if (!t) return "";
    const d = new Date(t);
    const intraday = state.range === "1d" || /m$/.test(state.interval || "");
    try {
      return intraday
        ? d.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            timeZone: PST_TZ,
          })
        : d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: PST_TZ,
          });
    } catch {
      return "";
    }
  }

  function ensureCrosshair(wrap) {
    let ch = wrap.querySelector(".ca-crosshair");
    if (!ch) {
      ch = document.createElement("div");
      ch.className = "ca-crosshair";
      ch.setAttribute("aria-hidden", "true");
      ch.innerHTML =
        '<div class="ca-crosshair-x"></div><div class="ca-crosshair-y"></div>' +
        '<div class="ca-crosshair-price"></div><div class="ca-crosshair-time"></div>';
      wrap.appendChild(ch);
    }
    return ch;
  }

  function hideCrosshair() {
    const ch = state.container?.querySelector(".ca-crosshair");
    if (ch) ch.classList.remove("is-on");
  }

  function indicatorPaneAt(py, m) {
    for (const pane of m?._indicatorPanes || []) {
      if (py >= pane.y0 && py < pane.y0 + pane.h) return pane;
    }
    return null;
  }

  function crosshairLabelForPane(py, pane) {
    if (!pane) return "";
    if (pane.kind === "rsi") {
      const pad = pane.pad ?? 4;
      const inner = Math.max(1, pane.h - pad * 2);
      const ratio = Math.max(0, Math.min(1, (pane.y0 + pane.h - pad - py) / inner));
      const v = pane.min + ratio * (pane.max - pane.min);
      return "RSI " + v.toFixed(1);
    }
    if (pane.kind === "macd") {
      const band = Math.max(1, pane.h / 2 - 8);
      const v = ((pane.midY - py) / band) * pane.scale;
      return "MACD " + (v >= 0 ? "+" : "") + v.toFixed(2);
    }
    return "";
  }

  function crosshairValueLabel(pt, py, m) {
    const pane = indicatorPaneAt(py, m);
    if (pane) return crosshairLabelForPane(py, pane);
    if (pt && pt.price != null) return "$" + round2(pt.price);
    if (pt && pt.pct != null) return (pt.pct >= 0 ? "+" : "") + pt.pct.toFixed(2) + "%";
    return "";
  }

  function onChartHoverLeave() {
    chartHovered = false;
    hideCrosshair();
    if (typeof RMUiTips !== "undefined") RMUiTips.hide();
  }

  function onChartHover(e) {
    chartHovered = true;
    const tipTarget = e.target?.closest?.(".fv-tip-target, .ca-ind-hit, .ca-fv-hit");
    if (typeof RMUiTips !== "undefined") {
      const planFlag =
        tipTarget &&
        (tipTarget.dataset?.planFlag === "1" || tipTarget.classList?.contains("ca-plan-flag"));
      if (tipTarget && !planFlag) RMUiTips.show(tipTarget);
      else RMUiTips.hide();
    }
    // Crosshair is a desktop/mouse affordance; touch uses tap + two-finger pan.
    if (e.pointerType === "touch") return;
    const wrap = e.currentTarget;
    const svg = $("#caChartSvg");
    const m = state.metrics;
    if (!wrap || !svg || !m || chartPointer.panning) {
      hideCrosshair();
      return;
    }
    // Don't fight interactive overlays (flags, bags, notes, S/R handles).
    if (chartInteractExempt(e.target) && !e.target.closest("#caChartSvg")) {
      hideCrosshair();
      return;
    }
    const wr = wrap.getBoundingClientRect();
    if (!wr.width || !wr.height) return;
    const x = e.clientX - wr.left;
    const y = e.clientY - wr.top;
    const pt = chartPointFromClient(e.clientX, e.clientY);
    const rect = svg.getBoundingClientRect();
    const py = rect.height ? ((e.clientY - rect.top) / rect.height) * (m.h || state.h) : y;

    // Toggle volume coloring only when the cursor is near the volume band.
    if (rect.height && m._volBandTop != null) {
      const near = py >= m._volBandTop - 8 && py <= m._volBandBottom + 4;
      svg.querySelector(".ca-vol-overlay")?.classList.toggle("is-near", near);
    }

    const ch = ensureCrosshair(wrap);
    ch.classList.add("is-on");
    ch.querySelector(".ca-crosshair-x").style.transform = "translateX(" + x.toFixed(1) + "px)";
    ch.querySelector(".ca-crosshair-y").style.transform = "translateY(" + y.toFixed(1) + "px)";
    const pl = ch.querySelector(".ca-crosshair-price");
    const tl = ch.querySelector(".ca-crosshair-time");
    pl.style.transform = "translateY(" + y.toFixed(1) + "px)";
    tl.style.transform = "translateX(" + x.toFixed(1) + "px)";
    pl.textContent = crosshairValueLabel(pt, py, m);
    tl.textContent = pt ? fmtCrosshairTime(pt.t) : "";
  }

  function chartUndoAllowed() {
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) {
      return false;
    }
    if (chartHovered) return true;
    const panel = state.container?.closest(".ws-panel--chart");
    return !!(panel && !panel.classList.contains("ws-panel--collapsed"));
  }

  function onChartKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      if (!chartUndoAllowed()) return;
      if (typeof global.RMChartScan !== "undefined" && global.RMChartScan.undo()) {
        e.preventDefault();
      }
      return;
    }
    if (e.code !== "Space" && e.key !== " ") return;
    if (!chartHovered) return; // only hijack space while pointer is over a chart
    const ae = document.activeElement;
    if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable)) {
      return; // never steal space from a focused field
    }
    if (!chartPanArmed) {
      chartPanArmed = true;
      updateChartSvgCursor();
      hideCrosshair();
    }
    e.preventDefault();
  }

  function onChartKeyUp(e) {
    if (e.code !== "Space" && e.key !== " ") return;
    if (chartPanArmed) {
      chartPanArmed = false;
      updateChartSvgCursor();
    }
  }

  function onChartEscape(e) {
    if (e.key === "Escape" && tradePreviewOpen) closeTradePreview();
  }

  function ensureChartKeyBind() {
    if (chartKeyBound) return;
    chartKeyBound = true;
    window.addEventListener("keydown", onChartKeyDown, true);
    window.addEventListener("keydown", onChartEscape);
    window.addEventListener("keyup", onChartKeyUp);
    window.addEventListener("blur", () => {
      if (chartPanArmed) {
        chartPanArmed = false;
        updateChartSvgCursor();
      }
    });
  }

  function trackTouchDown(e) {
    if (e.pointerType !== "touch") return;
    activeTouchPoints.add(e.pointerId);
    if (activeTouchPoints.size >= 2) chartPointer.twoFinger = true;
  }

  function trackTouchUp(e) {
    if (e.pointerType !== "touch") return;
    activeTouchPoints.delete(e.pointerId);
    if (activeTouchPoints.size < 2) chartPointer.twoFinger = false;
  }

  /* ---- Trade preview overlay: projected + projected-vs-realized (item 11) ---- */
  const TRADE_NOTE_KEY = "rainmaker_trade_preview_notes_v1";
  let tradePreviewOpen = false;

  function loadTradeNotes() {
    try {
      return JSON.parse(localStorage.getItem(TRADE_NOTE_KEY)) || {};
    } catch {
      return {};
    }
  }
  function tradeNote(id) {
    return loadTradeNotes()[id] || "";
  }
  function saveTradeNote(id, text) {
    if (!id) return;
    const all = loadTradeNotes();
    if (text && text.trim()) all[id] = text.trim();
    else delete all[id];
    try {
      localStorage.setItem(TRADE_NOTE_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  function money(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const sign = n < 0 ? "-" : "";
    return sign + "$" + Math.abs(round2(n)).toFixed(2);
  }

  // A compact "mock chart" of the trade: entry → forked path to target (up) and
  // stop (down); in realized mode it also draws the actual exit path.
  function buildPreviewSvg(d) {
    const W = 320;
    const H = 158;
    const padT = 14;
    const padB = 14;
    const levels = [d.entry, d.stop, d.target2 ?? d.target, d.target1, d.exit].filter(
      (v) => v != null && Number.isFinite(v)
    );
    if (levels.length < 2) return "";
    const lo = Math.min(...levels);
    const hi = Math.max(...levels);
    const span = hi - lo || 1;
    const yOf = (p) => padT + (1 - (p - lo) / span) * (H - padT - padB);
    const xEntry = 26;
    const xFork = W * 0.52;
    const xEnd = W - 70;
    const line = (p, cls, label) => {
      if (p == null || !Number.isFinite(p)) return "";
      const y = yOf(p).toFixed(1);
      return (
        '<line class="ca-tp-lvl ' + cls + '" x1="6" y1="' + y + '" x2="' + (W - 64) + '" y2="' + y + '"/>' +
        '<text class="ca-tp-lvl-txt" x="' + (W - 60) + '" y="' + (Number(y) + 3).toFixed(1) + '">$' +
        round2(p) + "</text>"
      );
    };
    const eY = yOf(d.entry);
    const tY = yOf(d.target2 ?? d.target);
    const sY = yOf(d.stop);
    let paths =
      '<path class="ca-tp-path ca-tp-path--up" d="M' + xEntry + " " + eY.toFixed(1) +
      " L" + xFork.toFixed(1) + " " + eY.toFixed(1) + " L" + xEnd + " " + tY.toFixed(1) + '"/>' +
      '<path class="ca-tp-path ca-tp-path--down" d="M' + xFork.toFixed(1) + " " + eY.toFixed(1) +
      " L" + xEnd + " " + sY.toFixed(1) + '"/>';
    if (d.exit != null && Number.isFinite(d.exit)) {
      const xY = yOf(d.exit);
      paths +=
        '<path class="ca-tp-path ca-tp-path--real" d="M' + xEntry + " " + eY.toFixed(1) +
        " L" + xEnd + " " + xY.toFixed(1) + '"/>';
    }
    return (
      '<svg class="ca-tp-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      line(d.target2 ?? d.target, "ca-tp-lvl--target", "T") +
      line(d.target1, "ca-tp-lvl--target1", "T1") +
      line(d.entry, "ca-tp-lvl--entry", "Entry") +
      line(d.stop, "ca-tp-lvl--stop", "Stop") +
      (d.exit != null ? line(d.exit, "ca-tp-lvl--exit", "Exit") : "") +
      paths +
      "</svg>"
    );
  }

  function ensureTradePreview(mount) {
    let panel = mount.querySelector(".ca-trade-preview");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "ca-trade-preview";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Trade preview");
      mount.appendChild(panel);
    }
    return panel;
  }

  function closeTradePreview() {
    tradePreviewOpen = false;
    const mount = state.container?.querySelector(".ca-chart-mount");
    mount?.classList.remove("ca-preview-open");
    const panel = mount?.querySelector(".ca-trade-preview");
    if (panel) panel.classList.remove("is-open");
  }

  function openTradePreview(opts) {
    const mount = state.container?.querySelector(".ca-chart-mount");
    if (!mount) return;
    const mode = opts?.mode === "realized" ? "realized" : "projected";
    const d = opts?.data || {};
    const qty = d.qty || 100;
    const entry = d.entry;
    const stop = d.stop;
    const target = d.target2 ?? d.target;
    if (entry == null || stop == null) return;
    const svg = buildPreviewSvg(d);
    const risk = Number.isFinite(entry - stop) ? (entry - stop) * qty : null;
    const reward =
      target != null && Number.isFinite(target - entry) ? (target - entry) * qty : null;
    const rr = risk && reward ? Math.abs(reward / risk) : d.rr;
    const noteId = opts?.noteId || (mode + ":" + (d.symbol || state.symbol) + ":" + entry);
    const realizedR =
      mode === "realized" && d.exit != null && entry - stop
        ? (d.exit - entry) / (entry - stop)
        : null;
    const realizedPnl =
      mode === "realized" && d.exit != null ? (d.exit - entry) * qty : null;

    const rows = [
      ["Entry", "$" + round2(entry)],
      ["Stop", "$" + round2(stop)],
      d.target1 != null ? ["Target 1", "$" + round2(d.target1)] : null,
      target != null ? ["Target", "$" + round2(target)] : null,
      ["Risk", money(risk != null ? -Math.abs(risk) : null)],
      ["Reward", money(reward)],
      rr != null ? ["R:R", "1 : " + round2(rr)] : null,
    ].filter(Boolean);
    if (mode === "realized") {
      rows.push(["Exit", d.exit != null ? "$" + round2(d.exit) : "open"]);
      rows.push(["Realized", realizedR != null ? round2(realizedR) + "R" : "—"]);
      rows.push(["P/L", money(realizedPnl)]);
    }

    const statHtml = rows
      .map(
        (r) =>
          '<div class="ca-tp-stat"><span>' + r[0] + "</span><strong>" + r[1] + "</strong></div>"
      )
      .join("");

    const panel = ensureTradePreview(mount);
    panel.innerHTML =
      '<div class="ca-tp-head">' +
      '<div><p class="ca-tp-kicker">' +
      (mode === "realized" ? "Projected vs realized" : "Projected trade") +
      '</p><h4 class="ca-tp-title">' +
      escapeHtml(d.symbol || state.symbol || "") +
      "</h4></div>" +
      '<button type="button" class="ca-tp-close" aria-label="Close preview">×</button>' +
      "</div>" +
      '<div class="ca-tp-chart">' + svg + "</div>" +
      (mode === "realized"
        ? '<p class="ca-tp-legend"><span class="ca-tp-key ca-tp-key--proj">Projected</span>' +
          '<span class="ca-tp-key ca-tp-key--real">Realized</span></p>'
        : "") +
      '<div class="ca-tp-stats">' + statHtml + "</div>" +
      '<label class="ca-tp-note-lbl">Notes' +
      '<textarea class="ca-tp-note" rows="3" placeholder="Why this trade? What happened?">' +
      escapeHtml(tradeNote(noteId)) +
      "</textarea></label>";

    panel.querySelector(".ca-tp-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTradePreview();
    });
    const ta = panel.querySelector(".ca-tp-note");
    ta?.addEventListener("input", () => saveTradeNote(noteId, ta.value));
    ta?.addEventListener("pointerdown", (e) => e.stopPropagation());

    hideCrosshair();
    tradePreviewOpen = true;
    mount.classList.add("ca-preview-open");
    requestAnimationFrame(() => panel.classList.add("is-open"));
  }

  function openProjectedTradePreview() {
    const plan = state.tradePlan;
    if (!plan || plan.entry == null) return false;
    openTradePreview({ mode: "projected", data: { ...plan }, noteId: "plan:" + plan.symbol });
    return true;
  }

  function openRealizedTradePreview(markerId) {
    const id = String(markerId || "").replace(/-(entry|exit)$/, "");
    const tm = tradeMarkersForSymbol(chartPriceSymbol()).find((m) => m.id === id);
    if (!tm) return false;
    setActiveTradeMarker(id, tm.label || state.instrumentContext);
    openTradePreview({
      mode: "realized",
      noteId: "trade:" + tm.id,
      data: {
        symbol: tm.symbol,
        entry: tm.entry,
        stop: tm.stop,
        target: tm.target,
        exit: tm.exit,
        qty: 100,
      },
    });
    return true;
  }

  function regionFromClientCircle(x0, y0, x1, y1) {
    const center = chartPointFromClient(x0, y0);
    if (!center) return null;
    const radiusPx = Math.hypot(x1 - x0, y1 - y0);
    if (radiusPx < 14) return null;
    const vKey = center.price != null ? "price" : center.pct != null ? "pct" : null;
    if (!vKey || center[vKey] == null) return null;

    const centerT = center.t;
    const centerP = center[vKey];
    let tMin = centerT;
    let tMax = centerT;
    let pMin = centerP;
    let pMax = centerP;
    const samples = [
      [x0 - radiusPx, y0],
      [x0 + radiusPx, y0],
      [x0, y0 - radiusPx],
      [x0, y0 + radiusPx],
    ];
    for (const [sx, sy] of samples) {
      const pt = chartPointFromClient(sx, sy);
      if (!pt) continue;
      tMin = Math.min(tMin, pt.t);
      tMax = Math.max(tMax, pt.t);
      const pv = pt[vKey];
      if (pv != null && Number.isFinite(pv)) {
        pMin = Math.min(pMin, pv);
        pMax = Math.max(pMax, pv);
      }
    }

    return {
      shape: "circle",
      centerT,
      centerP,
      radiusPx,
      valueKey: vKey,
      tMin,
      tMax,
      pMin,
      pMax,
    };
  }

  function chartScanOpts(clientX, clientY) {
    return {
      clientX,
      clientY,
      symbol: state.symbol,
      bars: state.bars,
      events: state.events,
      pctMode: state.metrics?.mode === "pct",
    };
  }

  function chartPointFromClient(clientX, clientY) {
    const svg = $("#caChartSvg");
    const m = state.metrics;
    if (!svg || !m) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const px = ((clientX - rect.left) / rect.width) * m.w;
    const py = ((clientY - rect.top) / rect.height) * m.h;
    let t;
    if (m._viewPacked && m._packTimes?.length > 1) {
      const ratio = Math.max(0, Math.min(1, (px - m.pad.l) / m.innerW));
      const idx = Math.round(ratio * (m._packTimes.length - 1));
      t = m._packTimes[idx];
    } else {
      t = m.tMin + ((px - m.pad.l) / m.innerW) * (m.tMax - m.tMin);
    }
    const ySpan = m.mainH - m.pad.t - m.pad.b;
    const value = m.yMin + ((ySpan - (py - m.pad.t)) / ySpan) * (m.yMax - m.yMin);
    if (m.mode === "pct") return { t, px, py, pct: value };
    if (state.bars.length || isCompareMode()) return { t, px, py, price: value };
    return null;
  }

  function resolveRthOpenMs(hubRef) {
    const meta = resolveSessionMeta(hubRef);
    if (meta?.periods?.regular?.startMs) return meta.periods.regular.startMs;
    const hs = chartHubData(hubRef);
    const bars = hs.spyBars || [];
    const anchor =
      bars.length > 0
        ? bars[bars.length - 1].t
        : hs.spyPct?.[hs.spyPct.length - 1]?.t;
    if (!anchor) return null;
    const mins = etMinutes(anchor);
    return anchor - (mins - ET_RTH_OPEN_MIN) * 60 * 1000;
  }

  function clampPanWindowAllowLead(tMin, tMax) {
    const full = state.fullExtent;
    if (!full) return { tMin, tMax };
    if (tMax > full.tMax) {
      const shift = tMax - full.tMax;
      tMax = full.tMax;
      tMin -= shift;
    }
    if (tMax - tMin < MIN_VIEW_WINDOW_MS) {
      tMax = tMin + MIN_VIEW_WINDOW_MS;
      if (tMax > full.tMax) {
        tMax = full.tMax;
        tMin = tMax - MIN_VIEW_WINDOW_MS;
      }
    }
    return { tMin, tMax };
  }

  function morningOpenViewTarget(hub, vw) {
    if (!vw) return null;
    const leadMin = morningLeadMinMs(hub);
    if (leadMin == null) return null;
    const span = Math.max(MIN_VIEW_WINDOW_MS, vw.tMax - vw.tMin);
    return clampPanWindowAllowLead(leadMin, leadMin + span);
  }

  function morningOpenAlreadyVisible(hub, vw) {
    const leadMin = morningLeadMinMs(hub);
    if (leadMin == null || !vw) return true;
    return vw.tMin <= leadMin + 2 * 60 * 1000;
  }

  function cancelViewPanAnim() {
    if (viewPanAnim?.raf) cancelAnimationFrame(viewPanAnim.raf);
    viewPanAnim = null;
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function scanPanDurationMs(start, end) {
    const ext = state.fullExtent;
    if (!ext) return SCAN_OPEN_PAN_MIN_MS + 400;
    const fullSpan = Math.max(ext.tMax - ext.tMin, 1);
    const delta = Math.abs(end.tMin - start.tMin);
    const ratio = delta / fullSpan;
    return Math.round(
      Math.min(SCAN_OPEN_PAN_MAX_MS, Math.max(SCAN_OPEN_PAN_MIN_MS, 800 + ratio * 2200))
    );
  }

  function applyFitForRender(opts) {
    if (!opts?.fit) return;
    const preserveX =
      state.viewWindow &&
      (scanMorningViewHeld(chartHubRef()) ||
        (isCompareMode() &&
          (hubState().scanActive ||
            hubState().morningScanViewLock ||
            opts?.preserveView === true ||
            isMorningScanView())));
    if (preserveX) {
      resetYView();
      return;
    }
    resetViewWindow({ force: true });
  }

  function animateViewWindowTo(target, opts) {
    cancelViewPanAnim();
    const vw = state.viewWindow;
    if (!vw || !target) return Promise.resolve();
    const start = { tMin: vw.tMin, tMax: vw.tMax };
    const lockTMax = opts?.lockTMax === true;
    const end = lockTMax
      ? { tMin: target.tMin, tMax: start.tMax }
      : clampPanWindowAllowLead(target.tMin, target.tMax);
    if (
      Math.abs(start.tMin - end.tMin) < 45 * 1000 &&
      (!lockTMax || Math.abs(start.tMax - end.tMax) < 45 * 1000)
    ) {
      state.viewWindow = end;
      paintNow();
      return Promise.resolve();
    }
    const duration = opts?.durationMs ?? scanPanDurationMs(start, end);
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        const raw = Math.min(1, (now - t0) / duration);
        const t = easeInOutCubic(raw);
        state.viewWindow = {
          tMin: start.tMin + (end.tMin - start.tMin) * t,
          tMax: lockTMax ? start.tMax : start.tMax + (end.tMax - start.tMax) * t,
        };
        paintNow();
        if (raw < 1) {
          viewPanAnim = { raf: requestAnimationFrame(tick), lockTMax };
        } else {
          state.viewWindow = end;
          state.fullExtent = collectFullExtent(chartHubRef());
          paintNow();
          viewPanAnim = null;
          resolve();
        }
      };
      viewPanAnim = { raf: requestAnimationFrame(tick), lockTMax };
    });
  }

  async function ensureMorningScanView(hubRef, opts) {
    if (!hubState().morningScanViewLock && !opts?.force) return;
    cancelViewPanAnim();
    if (hubRef) state.hub = hubRef;
    const leadMin = morningLeadMinMs(hubRef);
    if (leadMin == null) return;
    if (!state.fullExtent) state.fullExtent = collectFullExtent(hubRef);
    if (!state.viewWindow && state.fullExtent) {
      state.viewWindow = defaultViewWindow(state.fullExtent);
    }
    lockScanBrushExtent(hubRef);
    const vw = state.viewWindow;
    if (!vw) return;
    if (morningOpenAlreadyVisible(hubRef, vw)) {
      paintNow();
      return;
    }
    const target = { tMin: leadMin, tMax: vw.tMax };
    await animateViewWindowTo(target, {
      durationMs: opts?.animate === false ? 1 : 480,
      lockTMax: true,
    });
    state.fullExtent = collectFullExtent(hubRef);
    paintNow();
  }

  async function animateToMorningOpenForScan(hubRef, opts) {
    cancelViewPanAnim();
    if (hubRef) state.hub = hubRef;
    const leadMin = morningLeadMinMs(hubRef);
    if (leadMin == null) return;
    if (!state.fullExtent) state.fullExtent = collectFullExtent(hubRef);
    if (!state.viewWindow && state.fullExtent) {
      state.viewWindow = defaultViewWindow(state.fullExtent);
    }
    lockScanBrushExtent(hubRef);
    const vw = state.viewWindow;
    if (!vw) return;
    if (!opts?.force && morningOpenAlreadyVisible(hubRef, vw)) return;
    const target = { tMin: leadMin, tMax: vw.tMax };
    const panOpts = Object.assign({ durationMs: 2200, lockTMax: true }, opts || {});
    await animateViewWindowTo(target, panOpts);
    state.fullExtent = collectFullExtent(hubRef);
    paintNow();
  }

  function clampPanWindow(tMin, tMax) {
    const full = state.fullExtent;
    if (!full) return { tMin, tMax };
    if (tMin < full.tMin) {
      tMax += full.tMin - tMin;
      tMin = full.tMin;
    }
    if (tMax > full.tMax) {
      tMin -= tMax - full.tMax;
      tMax = full.tMax;
    }
    if (tMax - tMin < MIN_VIEW_WINDOW_MS) {
      const center = (tMin + tMax) / 2;
      tMin = center - MIN_VIEW_WINDOW_MS / 2;
      tMax = center + MIN_VIEW_WINDOW_MS / 2;
      if (tMin < full.tMin) {
        tMin = full.tMin;
        tMax = Math.min(full.tMax, tMin + MIN_VIEW_WINDOW_MS);
      }
      if (tMax > full.tMax) {
        tMax = full.tMax;
        tMin = Math.max(full.tMin, tMax - MIN_VIEW_WINDOW_MS);
      }
    }
    return { tMin, tMax };
  }

  function syncChartViewAfterZoom() {
    const mount = $(".ca-chart-mount");
    updateBrushVisuals(mount?.querySelector(".ca-time-brush"), hubState());
    scheduleInteractRepaint();
  }

  /** Zoom time window in/out around the horizontal center of the chart. */
  function zoomViewWindowFromCenter(zoomIn) {
    const full = state.fullExtent;
    const vw = state.viewWindow;
    if (!full || !vw) return;
    const ti = state.timeIndex;

    if (shouldUseContinuousAxis() && ti?.count > 1) {
      let { iMin, iMax } = viewWindowToIndices(vw, ti);
      const span = Math.max(2, iMax - iMin);
      const fullSpan = ti.count - 1;
      if (!zoomIn && span >= fullSpan) return;
      const nextSpan = zoomIn
        ? Math.max(2, Math.round(span / CHART_WHEEL_ZOOM))
        : Math.min(fullSpan, Math.round(span * CHART_WHEEL_ZOOM));
      if (nextSpan === span) return;
      const iCenter = (iMin + iMax) / 2;
      let newMin = Math.round(iCenter - nextSpan / 2);
      let newMax = newMin + nextSpan;
      if (newMin < 0) {
        newMax -= newMin;
        newMin = 0;
      }
      if (newMax > ti.count - 1) {
        newMin -= newMax - (ti.count - 1);
        newMax = ti.count - 1;
      }
      if (newMax - newMin < 2) return;
      state.viewWindow = indicesToViewWindow(newMin, newMax, ti);
      syncChartViewAfterZoom();
      return;
    }

    const span = vw.tMax - vw.tMin;
    const fullSpan = full.tMax - full.tMin;
    if (!zoomIn && span >= fullSpan * 0.995) return;
    const nextSpan = zoomIn
      ? Math.max(MIN_VIEW_WINDOW_MS, span / CHART_WHEEL_ZOOM)
      : Math.min(fullSpan, span * CHART_WHEEL_ZOOM);
    if (Math.abs(nextSpan - span) < 1) return;
    const center = (vw.tMin + vw.tMax) / 2;
    let tMin = center - nextSpan / 2;
    let tMax = center + nextSpan / 2;
    ({ tMin, tMax } = clampPanWindow(tMin, tMax));
    state.viewWindow = { tMin, tMax };
    syncChartViewAfterZoom();
  }

  /** Zoom price axis in/out (wheel over Y-axis gutter). */
  function zoomYViewFromCenter(zoomIn) {
    const base = clampYView(state.yView);
    const factor = zoomIn ? CHART_WHEEL_ZOOM : 1 / CHART_WHEEL_ZOOM;
    const scale = Math.min(8, Math.max(0.2, base.scale * factor));
    if (Math.abs(scale - base.scale) < 0.001) return;
    state.yView = clampYView({ scale, offset: base.offset });
    scheduleInteractRepaint();
  }

  function chartYAxisZoneFromEvent(e) {
    const m = state.metrics;
    const svg = $("#caChartSvg");
    if (!m || !svg) return false;
    const r = svg.getBoundingClientRect();
    if (!r.width) return false;
    const sx = ((e.clientX - r.left) / r.width) * (m.w || state.w);
    return sx <= (m.pad?.l ?? 46) + 4;
  }

  function onChartWheel(e) {
    if (!state.metrics || !state.fullExtent || !state.viewWindow) return;
    const wrap = e.currentTarget;
    if (!wrap?.closest?.(".ca-chart-svg-wrap")) return;
    if (chartInteractExempt(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const zoomIn = e.deltaY < 0;
    if (chartYAxisZoneFromEvent(e)) zoomYViewFromCenter(zoomIn);
    else zoomViewWindowFromCenter(zoomIn);
  }

  function chartPointerTarget(target) {
    return target.closest("#caChartSvg, .ca-chart-svg-wrap");
  }

  function chartPointerActive(e) {
    const id = e.pointerId != null ? e.pointerId : "mouse";
    return id === chartPointer.pointerId;
  }

  function setChartInteracting(on) {
    const mount = $(".ca-chart-mount");
    if (mount) mount.classList.toggle("is-chart-interacting", !!on);
  }

  const interactRepaint = { lastAt: 0, pending: false, minMs: 120 };

  function scheduleInteractRepaint() {
    const now = performance.now();
    if (now - interactRepaint.lastAt >= interactRepaint.minMs) {
      interactRepaint.lastAt = now;
      repaintChartSvg({ viewOnly: true });
      return;
    }
    if (interactRepaint.pending) return;
    interactRepaint.pending = true;
    requestAnimationFrame(() => {
      interactRepaint.pending = false;
      interactRepaint.lastAt = performance.now();
      repaintChartSvg({ viewOnly: true });
    });
  }

  function beginChartPanning() {
    if (!chartPointer.yAxisZone && (!state.fullExtent || !state.viewWindow)) return;
    chartPointer.panning = true;
    chartPointer.frozenYDomain =
      snapshotAutoYDomain(state.metrics) || chartPointer.frozenYDomain;
    chartPointer.captureEl?.classList.add("is-chart-panning");
    setChartInteracting(true);
    hideCrosshair();
    updateChartSvgCursor();
  }

  function applyYAxisScaleDrag(clientDy) {
    const base = clampYView(chartPointer.startYView);
    const factor = Math.exp(-clientDy / 180);
    const scale = Math.min(8, Math.max(0.2, base.scale * factor));
    state.yView = clampYView({ scale, offset: base.offset });
    repaintChartSvg();
  }

  function syncChartPanView(clientDx, clientDy) {
    if (clientDy != null && state.metrics?.innerH) {
      const base = clampYView(chartPointer.startYView);
      state.yView = clampYView({
        scale: base.scale,
        offset: base.offset + clientDy / state.metrics.innerH,
      });
    }
    const full = state.fullExtent;
    const svg = $("#caChartSvg");
    if (full && svg && chartPointer.startVw) {
      const rect = svg.getBoundingClientRect();
      if (rect.width) {
        const ti = state.timeIndex;
        if (shouldUseContinuousAxis() && ti?.count > 1) {
          const dRatio = clientDx / rect.width;
          const dIdx = Math.round(dRatio * (ti.count - 1));
          let { iMin, iMax } = viewWindowToIndices(chartPointer.startVw, ti);
          iMin -= dIdx;
          iMax -= dIdx;
          if (iMin < 0) {
            iMax -= iMin;
            iMin = 0;
          }
          if (iMax > ti.count - 1) {
            iMin -= iMax - (ti.count - 1);
            iMax = ti.count - 1;
          }
          state.viewWindow = indicesToViewWindow(iMin, iMax, ti);
        } else {
          const dt = (clientDx / rect.width) * (full.tMax - full.tMin);
          let tMin = chartPointer.startVw.tMin - dt;
          let tMax = chartPointer.startVw.tMax - dt;
          ({ tMin, tMax } = clampPanWindow(tMin, tMax));
          state.viewWindow = { tMin, tMax };
        }
      }
    }
    const mount = $(".ca-chart-mount");
    updateBrushVisuals(mount?.querySelector(".ca-time-brush"), hubState());
    scheduleInteractRepaint();
  }

  function clearChartPointerHold() {
    if (chartPointer.holdTimer) {
      clearTimeout(chartPointer.holdTimer);
      chartPointer.holdTimer = null;
    }
  }

  function endChartPointer() {
    clearChartPointerHold();
    if (chartPointer.panRaf) {
      cancelAnimationFrame(chartPointer.panRaf);
      chartPointer.panRaf = null;
    }
    const wrap = chartPointer.captureEl;
    if (
      wrap?.releasePointerCapture &&
      chartPointer.pointerId != null &&
      chartPointer.pointerId !== "mouse"
    ) {
      try {
        wrap.releasePointerCapture(chartPointer.pointerId);
      } catch {
        /* ignore */
      }
    }
    wrap?.classList.remove("is-chart-panning");
    if (chartPointer.panning) repaintChartSvg({ viewOnly: true });
    setChartInteracting(false);
    chartPointer.pointerId = null;
    chartPointer.startVw = null;
    chartPointer.moved = false;
    chartPointer.panning = false;
    chartPointer.pendingNode = null;
    chartPointer.captureEl = null;
    chartPointer.yAxisZone = false;
    chartPointer.startYView = null;
    chartPointer.frozenYDomain = null;
    if (chartPointer.scanDraw && typeof global.RMChartScan !== "undefined") {
      global.RMChartScan.cancelCircle();
    }
    chartPointer.lasso = false;
    chartPointer.scanDraw = false;
    updateChartSvgCursor();
    window.removeEventListener("mousemove", onChartDragMove);
    window.removeEventListener("mouseup", onChartDragUp);
    window.removeEventListener("pointermove", onChartDragMove);
    window.removeEventListener("pointerup", onChartDragUp);
    window.removeEventListener("pointercancel", onChartDragUp);
  }

  function chartScanDeltaFromClient(startX, startY, clientX, clientY, valueKey) {
    const startPt = chartPointFromClient(startX, startY);
    const curPt = chartPointFromClient(clientX, clientY);
    if (!startPt || !curPt) return null;
    const vKey = valueKey || (startPt.price != null ? "price" : "pct");
    const dT = curPt.t - startPt.t;
    const dP = (curPt[vKey] ?? 0) - (startPt[vKey] ?? 0);
    if (!Number.isFinite(dT) || !Number.isFinite(dP)) return null;
    return { dT, dP };
  }

  function endRightScanPointer(opts) {
    if (rightScanPointer.drawing && typeof global.RMChartScan !== "undefined") {
      global.RMChartScan.cancelCircle();
    }
    rightScanPointer.active = false;
    rightScanPointer.mode = null;
    rightScanPointer.drawing = false;
    rightScanPointer.moved = false;
    rightScanPointer.captureEl = null;
    rightScanPointer.scanMove = null;
    if (opts?.suppressMenu) rightScanPointer.suppressMenu = true;
    window.removeEventListener("mousemove", onRightScanDragMove);
    window.removeEventListener("mouseup", onRightScanDragUp);
    window.removeEventListener("contextmenu", onRightScanContextBlock, true);
  }

  function onRightScanContextBlock(e) {
    if (!rightScanPointer.active) return;
    e.preventDefault();
  }

  function onRightScanDragMove(e) {
    if (!rightScanPointer.active) return;
    const dx = e.clientX - rightScanPointer.startX;
    const dy = e.clientY - rightScanPointer.startY;
    if (Math.hypot(dx, dy) >= CHART_MOVE_PX) rightScanPointer.moved = true;

    if (rightScanPointer.mode === "draw" && typeof global.RMChartScan !== "undefined") {
      if (!rightScanPointer.drawing) {
        rightScanPointer.drawing = true;
        global.RMChartScan.beginCircle(
          rightScanPointer.captureEl,
          rightScanPointer.startX,
          rightScanPointer.startY
        );
      }
      e.preventDefault();
      global.RMChartScan.updateCircle(
        rightScanPointer.captureEl,
        rightScanPointer.startX,
        rightScanPointer.startY,
        e.clientX,
        e.clientY
      );
      return;
    }

    if (
      rightScanPointer.mode === "move" &&
      rightScanPointer.moved &&
      rightScanPointer.scanMove &&
      typeof global.RMChartScan !== "undefined"
    ) {
      const delta = chartScanDeltaFromClient(
        rightScanPointer.startX,
        rightScanPointer.startY,
        e.clientX,
        e.clientY,
        rightScanPointer.scanMove.snapshot?.valueKey
      );
      if (delta) {
        e.preventDefault();
        global.RMChartScan.previewScanMove(
          rightScanPointer.scanMove.snapshot,
          delta.dT,
          delta.dP
        );
      }
    }
  }

  function onRightScanDragUp(e) {
    if (!rightScanPointer.active) return;
    if (e.button !== 2) return;

    const moved = rightScanPointer.moved;
    const wrap = rightScanPointer.captureEl;

    if (rightScanPointer.mode === "draw" && typeof global.RMChartScan !== "undefined") {
      const circle = global.RMChartScan.endCircle(
        wrap,
        rightScanPointer.startX,
        rightScanPointer.startY,
        e.clientX,
        e.clientY
      );
      rightScanPointer.drawing = false;
      if (circle) {
        const region = regionFromClientCircle(
          circle.cx,
          circle.cy,
          circle.ex,
          circle.ey
        );
        if (region) {
          global.RMChartScan.completeCircleGesture(
            wrap,
            region,
            chartScanOpts(e.clientX, e.clientY)
          );
        }
      }
    } else if (
      rightScanPointer.mode === "move" &&
      rightScanPointer.scanMove &&
      typeof global.RMChartScan !== "undefined"
    ) {
      if (moved) {
        const delta = chartScanDeltaFromClient(
          rightScanPointer.startX,
          rightScanPointer.startY,
          e.clientX,
          e.clientY,
          rightScanPointer.scanMove.snapshot?.valueKey
        );
        if (delta && (Math.abs(delta.dT) > 0 || Math.abs(delta.dP) > 0)) {
          global.RMChartScan.commitScanMove(
            rightScanPointer.scanMove.snapshot,
            delta.dT,
            delta.dP
          );
        } else {
          global.RMChartScan.revertScanMove(rightScanPointer.scanMove.snapshot);
        }
      }
    }

    endRightScanPointer({ suppressMenu: moved });
  }

  function onChartRightScanDown(e) {
    if (e.button !== 2) return;
    if (!chartPointerTarget(e.target)) return;
    if (rightScanPointer.active) return;
    const m = state.metrics;
    if (!m || isCompareMode()) return;

    const scanNode = e.target.closest('[data-node-kind="scan"][data-scan-id]');
    if (
      !scanNode &&
      chartInteractExempt(e.target) &&
      !e.target.closest("#caChartSvg")
    ) {
      return;
    }
    if (e.target.closest(".ca-scan-menu, .ca-scan-circle")) return;

    e.preventDefault();

    rightScanPointer.active = true;
    rightScanPointer.startX = e.clientX;
    rightScanPointer.startY = e.clientY;
    rightScanPointer.moved = false;
    rightScanPointer.drawing = false;
    rightScanPointer.captureEl = e.currentTarget;

    if (scanNode && typeof global.RMChartScan !== "undefined") {
      const scan = global.RMChartScan.getScanForDebrief(scanNode.dataset.scanId);
      if (!scan) {
        endRightScanPointer();
        return;
      }
      rightScanPointer.mode = "move";
      rightScanPointer.scanMove = {
        scanId: scan.id,
        snapshot: JSON.parse(JSON.stringify(scan)),
      };
    } else {
      rightScanPointer.mode = "draw";
    }

    window.addEventListener("mousemove", onRightScanDragMove);
    window.addEventListener("mouseup", onRightScanDragUp);
    window.addEventListener("contextmenu", onRightScanContextBlock, true);
  }

  function handleChartNodeTap(node) {
    if (!node) return;
    if (node.dataset.noteId) {
      selectNote(node.dataset.noteId);
      return;
    }
    if (node.classList?.contains("ca-ind-hit") || node.classList?.contains("ca-fv-hit")) {
      if (typeof global.RMUiTips !== "undefined") global.RMUiTips.show(node);
      return;
    }
    const kind = node.dataset.nodeKind;
    if (kind === "scan" && node.dataset.scanId && typeof global.RMChartScan !== "undefined") {
      global.RMChartScan.handleNodeTap(
        node,
        chartPointer.lastClientX,
        chartPointer.lastClientY
      );
      return;
    }
    if (kind === "signal" && node.dataset.signalType === "death_cross") {
      dispatchResultsHero({
        mode: "signal",
        symbol: chartTapSymbol(),
        meta: buyMetaFromChartNode(node),
      });
      return;
    }
    if (kind === "signal" && node.dataset.barIdx) {
      applyEmaSignalFromNode(node);
      return;
    }
    if (kind === "buy" || node.classList.contains("ca-buy-bag")) {
      if (
        node.classList.contains("ca-buy-bag--macd") &&
        typeof global.RMBuyBagFx !== "undefined"
      ) {
        global.RMBuyBagFx.pulse(node);
      }
      dispatchResultsHero({
        mode: "signal",
        symbol: chartTapSymbol(),
        meta: buyMetaFromChartNode(node),
      });
      openProjectedTradePreview();
      return;
    }
    if (kind === "trade" && node.dataset.nodeId) {
      const markerId =
        node.dataset.markerId || String(node.dataset.nodeId).replace(/-(entry|exit)$/, "");
      const tm = tradeMarkersForSymbol(chartPriceSymbol()).find((m) => m.id === markerId);
      setActiveTradeMarker(markerId, tm?.label || state.instrumentContext);
      document.dispatchEvent(
        new CustomEvent("rm:chart-trade-focus", {
          detail: { markerId, nodeId: node.dataset.nodeId },
        })
      );
      openRealizedTradePreview(node.dataset.nodeId);
      return;
    }
    if (kind === "pick" && node.dataset.symbol) {
      const sym = String(node.dataset.symbol).toUpperCase();
      dispatchResultsHero({ mode: "ticker", symbol: sym });
      document.dispatchEvent(
        new CustomEvent("rm:select-ticker", {
          detail: { symbol: sym, toggle: true, skipHero: true },
        })
      );
    }
  }

  function onChartDragMove(e) {
    if (!chartPointerActive(e)) return;
    if (chartPointer.pointerId === "mouse" && e.type === "pointermove") return;
    if (chartPointer.pointerId !== "mouse" && e.type === "mousemove") return;
    chartPointer.lastClientX = e.clientX;
    chartPointer.lastClientY = e.clientY;
    const dx = e.clientX - chartPointer.startX;
    const dy = e.clientY - chartPointer.startY;
    // Gesture already handed to the workspace accordion (row navigation).
    if (chartPointer.cededToScroll) return;
    const dist = Math.hypot(dx, dy);
    if (dist >= CHART_MOVE_PX) clearChartPointerHold();
    if (!chartPointer.panning) {
      const touch = chartPointer.pointerId !== "mouse";
      const verticalDominant = Math.abs(dy) > Math.abs(dx) * 1.4;
      // A clearly-vertical touch swipe in the plot is a row-slide gesture, not a
      // chart pan — cede it so the user can scroll to the next snap row. The
      // left y-axis gutter (yAxisZone) keeps vertical price control; horizontal
      // and diagonal swipes still pan the time axis.
      if (touch && !chartPointer.yAxisZone && verticalDominant && Math.abs(dy) >= 12) {
        chartPointer.cededToScroll = true;
        return;
      }
      if (dist < CHART_MOVE_PX) return;
      // Ambiguous-but-vertical: wait for the cede check above to resolve before
      // committing to a pan, so we don't hijack a developing swipe.
      if (touch && !chartPointer.yAxisZone && verticalDominant) return;
      // Item 9: pan ("hand") is gated. The left y-axis gutter always allows its
      // price drag; otherwise a mouse needs Spacebar held and touch needs two
      // fingers. A plain mouse drag stays a crosshair/click (no pan).
      const panAllowed =
        chartPointer.yAxisZone ||
        (touch ? chartPointer.twoFinger : chartPanArmed);
      if (!panAllowed) return;
      chartPointer.moved = true;
      beginChartPanning();
    }
    if (!chartPointer.panning) return;
    e.preventDefault();
    if (chartPointer.panRaf) return;
    chartPointer.panRaf = requestAnimationFrame(() => {
      chartPointer.panRaf = null;
      const ddx = chartPointer.lastClientX - chartPointer.startX;
      const ddy = chartPointer.lastClientY - chartPointer.startY;
      if (chartPointer.yAxisZone) applyYAxisScaleDrag(ddy);
      else syncChartPanView(ddx, ddy);
    });
  }

  function onChartDragUp(e) {
    if (!chartPointerActive(e)) return;
    if (!chartPointer.moved && !chartPointer.cededToScroll) {
      if (chartPointer.pendingNode) {
        handleChartNodeTap(chartPointer.pendingNode);
      } else if (!chartPointer.yAxisZone) {
        dismissExpandedTradePlan();
        dispatchChartTickerHero();
      }
    }
    endChartPointer();
  }

  function onChartDragDown(e) {
    if (e.button !== 0) return;
    if (!chartPointerTarget(e.target)) return;
    if (chartPointerBlocksDrag(e.target)) return;
    if (chartPointer.pointerId != null) return;
    const m = state.metrics;
    if (!m) return;

    const node = chartTapTarget(e.target);
    chartPointer.pendingNode = node || null;
    chartPointer.pointerId = e.pointerId != null ? e.pointerId : "mouse";
    chartPointer.startX = e.clientX;
    chartPointer.startY = e.clientY;
    chartPointer.lastClientX = e.clientX;
    chartPointer.lastClientY = e.clientY;
    chartPointer.moved = false;
    chartPointer.panning = false;
    chartPointer.startVw = state.viewWindow ? { ...state.viewWindow } : null;
    chartPointer.captureEl = e.currentTarget;
    chartPointer.startYView = clampYView(state.yView);
    chartPointer.frozenYDomain = snapshotAutoYDomain(state.metrics);
    chartPointer.yAxisZone = false;
    chartPointer.cededToScroll = false;
    const svgEl = $("#caChartSvg");
    if (svgEl && m) {
      const r = svgEl.getBoundingClientRect();
      if (r.width) {
        const sx = ((e.clientX - r.left) / r.width) * (m.w || state.w);
        chartPointer.yAxisZone = sx <= (m.pad?.l ?? 46) + 4;
      }
    }

    clearChartPointerHold();
    if (!node && !chartPointer.yAxisZone) {
      chartPointer.holdTimer = setTimeout(() => {
        chartPointer.holdTimer = null;
        if (chartPointer.moved || chartPointer.pointerId == null) return;
        const pt = chartPointFromClient(chartPointer.lastClientX, chartPointer.lastClientY);
        if (!pt) return;
        if (pt.pct != null) openNoteAt(pt.t, pt.pct, pt.px, pt.py);
        else if (pt.price != null) openNoteAt(pt.t, pt.price, pt.px, pt.py);
        endChartPointer();
      }, CHART_HOLD_MS);
    }

    window.addEventListener("mousemove", onChartDragMove);
    window.addEventListener("mouseup", onChartDragUp);
    window.addEventListener("pointermove", onChartDragMove);
    window.addEventListener("pointerup", onChartDragUp);
    window.addEventListener("pointercancel", onChartDragUp);
  }

  function ensureChartPointerBind(mount) {
    const wrap = mount?.querySelector(".ca-chart-svg-wrap");
    if (!wrap || wrap.dataset.chartPtrBound === "1") return;
    wrap.dataset.chartPtrBound = "1";
    ensureChartKeyBind();
    wrap.addEventListener("pointerdown", trackTouchDown, true);
    wrap.addEventListener("pointerup", trackTouchUp, true);
    wrap.addEventListener("pointercancel", trackTouchUp, true);
    wrap.addEventListener("pointermove", onChartHover);
    wrap.addEventListener("pointerenter", onChartHover);
    wrap.addEventListener("pointerleave", onChartHoverLeave);
    // Money-bag taps are exempt from the pan pointer path, so catch them here to
    // slide in the projected-trade preview (item 11).
    wrap.addEventListener("click", (e) => {
      const bag = e.target.closest(".ca-buy-bag");
      if (!bag) return;
      if (bag.dataset.nodeKind === "signal") return;
      if (
        bag.classList.contains("ca-buy-bag--macd") &&
        typeof global.RMBuyBagFx !== "undefined"
      ) {
        global.RMBuyBagFx.pulse(bag);
      }
      openProjectedTradePreview();
    });
    wrap.addEventListener("mousedown", onChartRightScanDown);
    wrap.addEventListener("contextmenu", (e) => {
      if (rightScanPointer.active || rightScanPointer.suppressMenu) {
        e.preventDefault();
        rightScanPointer.suppressMenu = false;
      }
    });
    wrap.addEventListener("pointerdown", onSrPointerDown, true);
    wrap.addEventListener("mousedown", onChartDragDown);
    wrap.addEventListener("pointerdown", onPlanFlagPointerDown, true);
    wrap.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      onChartDragDown(e);
    });
    wrap.addEventListener("pointerup", onChartPlanFlagPointerUp);
    wrap.addEventListener("pointercancel", onPlanFlagPointerCancel);
    wrap.addEventListener("dblclick", (e) => {
      if (chartInteractExempt(e.target)) return;
      e.preventDefault();
      resetViewWindow({ force: true });
      repaintChartSvg();
      const host = wrap.closest(".ca-chart-mount") || $(".ca-chart-mount");
      updateBrushVisuals(host?.querySelector(".ca-time-brush"), hubState());
    });
    wrap.addEventListener("wheel", onChartWheel, { passive: false });
  }

  function updateChartSvgCursor() {
    const svg = $("#caChartSvg");
    if (!svg) return;
    // crosshair by default; grab once pan is armed (spacebar); grabbing mid-pan.
    svg.style.cursor = chartPointer.panning
      ? "grabbing"
      : chartPanArmed
        ? "grab"
        : "crosshair";
  }

  function ensurePlanPanel(mount) {
    mount.querySelector("#caPlanPanel")?.remove();
    mount.querySelector("#caPlanPanelBackdrop")?.remove();
    ensureResultsPlanPanel();
  }

  function ensureResultsPlanPanel() {
    if (typeof RMResultsHero !== "undefined") {
      hideResultsPlanPanel();
      return;
    }
    const slot = document.getElementById("ttResultsPlanSlot");
    if (!slot || !state.tradePlan) {
      if (slot) slot.innerHTML = "";
      hideResultsPlanPanel();
      return;
    }
    const plan = state.tradePlan;
    let panel = document.getElementById("ttResultsPlanPanel");
    if (!panel) {
      slot.innerHTML = planPanelHtml();
      bindPlanPanel();
      panel = document.getElementById("ttResultsPlanPanel");
    }
    if (panel) {
      const title = panel.querySelector("#caPlanPanelTitle");
      if (title) title.textContent = plan.symbol + " morning setup";
      const qtyEl = panel.querySelector("#caPlanQty");
      const rrEl = panel.querySelector("#caPlanRR");
      const rrVal = panel.querySelector("#caPlanRRVal");
      if (qtyEl) qtyEl.value = String(plan.qty);
      if (rrEl) rrEl.value = (plan.rr ?? 2).toFixed(1);
      if (rrVal) rrVal.textContent = (plan.rr ?? 2).toFixed(1) + "R";
      panel.querySelectorAll(".ca-plan-panel-levels dd").forEach((dd, i) => {
        const vals = [
          plan.entry,
          plan.stop,
          plan.target1 ?? plan.target,
          plan.target2 ?? plan.target,
        ];
        if (vals[i] != null) dd.textContent = "$" + Number(vals[i]).toFixed(2);
      });
    }
    updatePlanPanelStat();
  }

  function ensurePaneResizer(mount) {
    const panes = indicatorPaneCount();
    let resizer = mount.querySelector(".ca-pane-resizer");
    if (!panes) {
      resizer?.remove();
      return;
    }
    if (!resizer) {
      resizer = document.createElement("div");
      resizer.className = "ca-pane-resizer";
      resizer.innerHTML = '<span class="ca-pane-resizer-grip" aria-hidden="true"></span>';
      mount.appendChild(resizer);
      bindPaneResizer(resizer, mount);
    }
    const wrap = mount.querySelector(".ca-chart-svg-wrap");
    const m = state.metrics;
    if (wrap && m?.mainH && m?.h) {
      const svgTop = wrap.offsetTop;
      const ratio = m.mainH / m.h;
      resizer.style.top = svgTop + ratio * wrap.clientHeight - 5 + "px";
    }
  }

  function bindPaneResizer(resizer, mount) {
    if (resizer.dataset.bound === "1") return;
    resizer.dataset.bound = "1";
    let dragging = false;
    resizer.addEventListener("pointerenter", () => resizer.classList.add("is-hot"));
    resizer.addEventListener("pointerleave", () => {
      if (!dragging) resizer.classList.remove("is-hot");
    });
    resizer.addEventListener("pointerdown", (e) => {
      dragging = true;
      resizer.classList.add("is-dragging", "is-hot");
      resizer.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    resizer.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = mount.getBoundingClientRect();
      state.paneSplit = Math.min(0.85, Math.max(0.45, (e.clientY - rect.top) / rect.height));
      paint();
    });
    const endDrag = () => {
      dragging = false;
      resizer.classList.remove("is-dragging");
      resizer.classList.remove("is-hot");
    };
    resizer.addEventListener("pointerup", endDrag);
    resizer.addEventListener("pointercancel", endDrag);
  }

  async function loadTickerSymbol(raw) {
    const sym = normalizeTickerInput(raw);
    if (!sym) return;
    rememberSymInput(sym);
    rememberViewSymbol(sym);
    state.symbol = sym;
    state.activeNoteId = null;
    state.noteEditorAnchor = null;
    await reload();
    syncSymbolInputFromView();
    const sel = $("#caSymbol");
    if (sel) sel.value = sym;
  }

  async function addCompareSymbol(raw) {
    const sym = normalizeTickerInput(raw);
    if (!sym || !state.hub?.addCompareTicker) return;
    rememberSymInput(sym);
    await state.hub.addCompareTicker(sym);
    state.symbol = COMPARE_SYM;
    await reload();
  }

  function bindToolbar() {
    const symEl = $("#caSymbol");
    const rgEl = $("#caRange");
    const ivEl = $("#caInterval");
    if (symEl) {
      symEl.onchange = () => {
        state.symbol = symEl.value;
        state.activeNoteId = null;
        state.noteEditorAnchor = null;
        syncSymbolInputFromView();
        syncNoteEditor();
        if (isCompareMode() && state.hub?.sessionPicks?.length && state.hub.syncFromSession) {
          void state.hub.syncFromSession(state.hub.sessionPicks);
          return;
        }
        reload();
      };
    }
    if (rgEl) {
      rgEl.onchange = async () => {
        state.range = rgEl.value;
        clampRangeInterval("range");
        saveChartPrefs();
        await applyHubRangeInterval();
      };
    }
    if (ivEl) {
      ivEl.onchange = async () => {
        state.interval = ivEl.value;
        clampRangeInterval("interval");
        saveChartPrefs();
        await applyHubRangeInterval();
      };
    }
    const symInput = $("#caSymInput");
    refreshSymInputDatalist();
    if (symInput && !symInput.value) symInput.value = symInputLast();
    const runAdd = () => {
      const v = symInput?.value;
      if (!v) return;
      if (state.addMode === "compare") addCompareSymbol(v);
      else loadTickerSymbol(v);
    };
    $("#caSymGo")?.addEventListener("click", runAdd);
    symInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runAdd();
    });
    symInput?.addEventListener("change", () => {
      const v = normalizeTickerInput(symInput.value);
      if (v) symInput.value = v;
    });
    const setAddMode = (mode) => {
      state.addMode = mode === "compare" ? "compare" : "load";
      const loadBtn = $("#caModeLoad");
      const cmpBtn = $("#caModeCompare");
      const go = $("#caSymGo");
      const compare = state.addMode === "compare";
      if (loadBtn) {
        loadBtn.classList.toggle("is-on", !compare);
        loadBtn.setAttribute("aria-pressed", !compare ? "true" : "false");
      }
      if (cmpBtn) {
        cmpBtn.classList.toggle("is-on", compare);
        cmpBtn.setAttribute("aria-pressed", compare ? "true" : "false");
      }
      if (go) go.textContent = compare ? "+" : "Add";
    };
    $("#caModeLoad")?.addEventListener("click", () => setAddMode("load"));
    $("#caModeCompare")?.addEventListener("click", () => setAddMode("compare"));
    const yBtn = $("#caYAxis");
    if (yBtn) {
      yBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.yAxisPct = !usePctAxis();
        resetYView();
        if (isCompareMode()) resetViewWindow({ force: true });
        saveChartPrefs();
        syncYAxisToggle();
        paintNow();
        if (state.indicators.fairValue && !isCompareMode()) void ensureFundamentalValue();
      };
    }
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(state.container);
  }

  function bindToggle(sel, fn) {
    const el = $(sel);
    if (!el) return;
    el.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
      const on = el.classList.contains("is-on");
      el.classList.toggle("is-on", !on);
      el.setAttribute("aria-pressed", !on ? "true" : "false");
    };
  }

  async function applyHubRangeInterval() {
    markViewContextChanged();
    resetViewWindow({ force: true });
    setChartLoading(true);
    paint();
    const hub = hubState();
    if (state.hub?.state) {
      state.hub.state.interval = state.interval;
      state.hub.state.range = state.range;
    }
    try {
      if (state.hub?.reloadChart) {
        await state.hub.reloadChart(state.container, { resetView: true });
      } else {
        await reload({ resetView: true, preserveView: false });
      }
    } finally {
      setChartLoading(false);
      paintToolbar();
      resetViewWindow({ force: true });
      paint();
      if (state.indicators.fairValue === true && !isCompareMode()) {
        void ensureFundamentalValue();
      }
    }
  }

  function renderChartContent(mount, svgHtml) {
    let wrap = mount.querySelector(".ca-chart-svg-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "ca-chart-svg-wrap";
      mount.insertBefore(wrap, mount.firstChild);
    }
    wrap.innerHTML = svgHtml;
  }

  function clearChartMount(mount) {
    const wrap = mount.querySelector(".ca-chart-svg-wrap");
    if (wrap) wrap.innerHTML = "";
    const brush = mount.querySelector(".ca-time-brush");
    if (brush) brush.hidden = true;
  }

  function repaintChartSvg(opts) {
    if (_repaintBusy) {
      _repaintQueued = true;
      return;
    }
    _repaintBusy = true;
    if (typeof RMUiTips !== "undefined") RMUiTips.hide();
    const mount = $(".ca-chart-mount");
    if (!mount) {
      _repaintBusy = false;
      return;
    }
    const hub = hubState();
    const svg = isCompareMode() ? renderCompareSvg(hub) : renderSymbolSvg(state.bars);
    renderChartContent(mount, svg);
    const viewOnly = opts?.viewOnly === true;
    if (!viewOnly) {
      ensureNoteEditorOverlay(mount);
    }
    updateChartSvgCursor();
    if (!viewOnly && typeof RMUiTips !== "undefined") RMUiTips.bind(state.container);
    if (!viewOnly) positionNoteEditorOverlay();
    _repaintBusy = false;
    if (_repaintQueued) {
      _repaintQueued = false;
      repaintChartSvg(opts);
    }
  }

  function syncYAxisToggle() {
    const yBtn = $("#caYAxis");
    if (!yBtn) return;
    const pct = usePctAxis();
    yBtn.textContent = pct ? "%" : "$";
    yBtn.classList.toggle("is-on", pct);
    yBtn.setAttribute("aria-pressed", pct ? "true" : "false");
    yBtn.title = pct
      ? "Y-axis: percent (click for $)"
      : "Y-axis: price (click for %)";
  }

  function paintToolbar() {
    if (typeof RMUiTips !== "undefined") RMUiTips.hide();
    const tb = $(".ca-toolbar-wrap");
    if (!tb) return;
    syncYAxisToggle();
    const syms = getSymbols();
    const symKey = syms.join("\u0001");
    if (symKey === lastToolbarSymbolsKey && tb.querySelector("#caSymbol")) {
      syncSymbolOptions();
      if (typeof RMChartHub !== "undefined") RMChartHub.syncMobileChartChrome?.();
      return;
    }
    lastToolbarSymbolsKey = symKey;
    const hint = tb.querySelector(".ca-chart-hint");
    const hintMarkup = hint ? hint.outerHTML : "";
    tb.innerHTML = hintMarkup + toolbarHtml(syms);
    ensureIndicatorMenuBindings();
    bindToolbar();
    syncYAxisToggle();
    if (typeof RMChartHub !== "undefined") RMChartHub.syncMobileChartChrome?.();
  }

  let paintRaf = null;
  let lastToolbarSymbolsKey = "";
  let holdingsLabelCache = { key: "", map: null };

  const fpsMeter = {
    raf: null,
    frames: 0,
    last: 0,
    fps: 0,
    el: null,
  };

  function invalidateHoldingsLabelCache() {
    holdingsLabelCache.key = "";
    holdingsLabelCache.map = null;
  }

  function holdingsLabelMap() {
    if (typeof global.RMHoldings === "undefined" || !global.RMHoldings.getDisplayOpen) {
      return null;
    }
    const rows = global.RMHoldings.getDisplayOpen();
    const key = rows
      .map((h) =>
        global.RMHoldings.holdingSelectValue
          ? global.RMHoldings.holdingSelectValue(h)
          : h.symbol
      )
      .join("|");
    if (holdingsLabelCache.key === key && holdingsLabelCache.map) return holdingsLabelCache.map;
    const map = {};
    rows.forEach((h) => {
      const v = global.RMHoldings.holdingSelectValue(h);
      const sym = String(h.symbol).trim();
      const isOpt =
        h.instrument === "option" ||
        (global.RMHoldings.isOptionSymbol && global.RMHoldings.isOptionSymbol(sym));
      const label =
        isOpt && global.RMHoldings.formatOptionLabel
          ? global.RMHoldings.formatOptionLabel(sym)
          : sym;
      map[v] = label + " · holding";
    });
    holdingsLabelCache = { key, map };
    return map;
  }

  function ensureFpsMeter(mount) {
    if (!mount || !chartFpsDebugEnabled()) return;
    let el = mount.querySelector(".ca-fps-meter");
    if (!el) {
      el = document.createElement("div");
      el.className = "ca-fps-meter";
      el.setAttribute("aria-hidden", "true");
      mount.appendChild(el);
      fpsMeter.el = el;
      startFpsMeter();
    }
    el.textContent = (fpsMeter.fps || 0) + " fps";
  }

  function chartFpsDebugEnabled() {
    try {
      if (localStorage.getItem("rm_fps_debug") === "1") return true;
    } catch (_) {}
    return /(?:^|[?&])fps=1(?:&|$)/.test(global.location?.search || "");
  }

  function chartFpsVisible() {
    if (document.visibilityState === "hidden") return false;
    if (!chartFpsDebugEnabled()) return false;
    const panel = state.container?.closest(".ws-panel--chart");
    if (panel?.classList.contains("ws-panel--collapsed")) return false;
    if (typeof matchMedia !== "undefined" && matchMedia("(max-width: 640px)").matches) {
      const acc = global.RMWorkspaceAccordion;
      if (acc?.getActiveKey && acc.getActiveKey() !== "chart") return false;
    }
    return true;
  }

  function startFpsMeter() {
    if (fpsMeter.raf != null) return;
    fpsMeter.last = performance.now();
    const tick = (now) => {
      if (chartFpsVisible()) fpsMeter.frames++;
      const elapsed = now - fpsMeter.last;
      if (elapsed >= 450) {
        fpsMeter.fps = chartFpsVisible()
          ? Math.round((fpsMeter.frames * 1000) / elapsed)
          : 0;
        fpsMeter.frames = 0;
        fpsMeter.last = now;
        if (fpsMeter.el) fpsMeter.el.textContent = fpsMeter.fps + " fps";
      }
      fpsMeter.raf = requestAnimationFrame(tick);
    };
    fpsMeter.raf = requestAnimationFrame(tick);
  }

  function fpsMeterSnapshot() {
    return { fps: fpsMeter.fps, visible: chartFpsVisible() };
  }

  function schedulePaint() {
    if (paintRaf != null) cancelAnimationFrame(paintRaf);
    paintRaf = requestAnimationFrame(() => {
      paintRaf = null;
      paintNow();
    });
  }

  function paint() {
    schedulePaint();
  }

  function paintNow() {
    const stage = $(".ca-analysis-stage");
    if (!stage) return;
    let mount = stage.querySelector(".ca-chart-mount");
    if (!mount) {
      mount = document.createElement("div");
      mount.className = "ca-chart-mount";
      stage.appendChild(mount);
    }
    const hub = hubState();
    const loading = stage.querySelector("#chLoadingMsg");
    updateFullExtent(chartHubRef());
    refreshTimeIndex(hub);
    if (state.chartLoading) {
      showChartFetchLoader(mount);
      return;
    }
    clearChartFetchLoader(mount);
    if (isCompareMode()) {
      if (!hub.spyPct?.length) {
        if (loading) loading.hidden = !!hub.spyLoadError;
        clearChartMount(mount);
        return;
      }
      if (loading) loading.hidden = true;
      renderChartContent(mount, renderCompareSvg(hub));
    } else if (!state.bars.length) {
      if (loading) loading.hidden = true;
      clearChartMount(mount);
      if (!state.chartLoading) {
        const msg =
          hub.spyLoadError ||
          "Could not load chart data. Run .\\start-morning.ps1 locally or tap Retry.";
        if (typeof hub.setChartError === "function") hub.setChartError(msg);
      }
      return;
    } else {
      if (loading) loading.hidden = true;
      if (
        state.symbol &&
        (!state.tradePlan || state.tradePlan.symbol !== state.symbol)
      ) {
        refreshMorningTradePlan();
      }
      renderChartContent(mount, renderSymbolSvg(state.bars));
    }
    paintBrush(mount, hub);
    ensureRmRecStrip(mount);
    ensurePlanHintBar(mount);
    bindRmRecStripMount(mount);
    bindPlanHintBar(mount);
    syncPlanMountChrome(mount);
    ensurePlanPanel(mount);
    ensurePaneResizer(mount);
    ensureChartStatus(mount);
    ensureFpsMeter(mount);
    ensureNoteEditorOverlay(mount);
    ensureChartPointerBind(mount);
    updateChartSvgCursor();
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(state.container);
    positionNoteEditorOverlay();
    state.lastPaintW = state.w;
    state.lastPaintH = state.h;
    scheduleLayoutSettle();
  }

  function fireBeam() {
    const beam = $("#chScanBeam");
    const m = state.metrics;
    if (!beam || !m) return;
    beam.hidden = false;
    beam.style.animation = "none";
    beam.offsetHeight;
    beam.style.left = m.pad.l + "px";
    beam.style.width = m.innerW + "px";
    beam.style.animation = "ch-beam 1100ms linear forwards";
    setTimeout(() => { beam.hidden = true; }, 1150);
  }

  function chartWidth() {
    measureChartSize();
    return state.w;
  }

  let chartResizeObs = null;
  let chartResizeRaf = null;

  function bindChartResize() {
    const target =
      state.container?.querySelector(".chart-hub-main") ||
      state.container?.querySelector(".ca-analysis-stage");
    if (!target || chartResizeObs) return;
    chartResizeObs = new ResizeObserver(() => {
      if (chartResizeRaf) cancelAnimationFrame(chartResizeRaf);
      chartResizeRaf = requestAnimationFrame(() => {
        chartResizeRaf = null;
        const prevW = state.lastPaintW || 0;
        const prevH = state.lastPaintH || 0;
        measureChartSize();
        if (Math.abs(state.w - prevW) <= 1 && Math.abs(state.h - prevH) <= 1) return;
        state.lastPaintW = state.w;
        state.lastPaintH = state.h;
        const hub = hubState();
        if (isCompareMode() && !(hub.spyPct?.length)) return;
        if (!isCompareMode() && !state.bars.length) return;
        repaintChartSvg();
        const brush = state.container?.querySelector(".ca-time-brush");
        if (brush) updateBrushVisuals(brush, hub);
      });
    });
    chartResizeObs.observe(target);
  }

  function scheduleLayoutSettle() {
    requestAnimationFrame(() => {
      const prevH = state.lastPaintH || 0;
      measureChartSize();
      if (Math.abs(state.h - prevH) <= 2) return;
      state.lastPaintW = state.w;
      state.lastPaintH = state.h;
      const hub = hubState();
      if (isCompareMode() && hub.spyPct?.length) {
        repaintChartSvg();
        const brush = state.container?.querySelector(".ca-time-brush");
        if (brush) updateBrushVisuals(brush, hub);
      } else if (!isCompareMode() && state.bars.length) {
        repaintChartSvg();
        const brush = state.container?.querySelector(".ca-time-brush");
        if (brush) updateBrushVisuals(brush, hub);
      }
    });
  }

  async function ensureFundamentalValue() {
    if (
      state.indicators.fairValue !== true ||
      isCompareMode() ||
      typeof global.RMFundamentalValue === "undefined"
    ) {
      state.fundamentalValuation = null;
      return;
    }
    const gen = ++state._fvFetchGen;
    await global.RMFundamentalValue.loadConfig();
    const payload = await global.RMFundamentalValue.fetchValuation(
      barsFetchSymbol(state.symbol),
      state.range
    );
    if (gen !== state._fvFetchGen || state.indicators.fairValue !== true) return;
    state.fundamentalValuation = payload;
    repaintChartSvg();
    const mount = $(".ca-chart-mount");
    if (mount) ensureChartStatus(mount);
  }

  async function reload(opts) {
    const preserveView = opts?.preserveView !== false;
    const resetView = opts?.resetView === true;
    if (opts?.syncHub !== false) syncFromHub();
    markViewContextChanged();
    if (resetView || !preserveView) resetViewWindow({ force: resetView });
    state.w = chartWidth();
    if (isCompareMode()) {
      setChartLoading(true);
      paint();
      try {
        if (state.hub?.ensureSpyLoaded) await state.hub.ensureSpyLoaded();
        state.events = eventsFromHub(COMPARE_SYM);
      } finally {
        setChartLoading(false);
      }
      state.tradePlan = null;
      paintToolbar();
      paint();
      document.dispatchEvent(
        new CustomEvent("rm:chart-bars", {
          detail: { symbol: COMPARE_SYM, compare: true },
        })
      );
      return;
    }
    setChartLoading(true);
    paint();
    let fetchErr = null;
    try {
      const fetchSym = barsFetchSymbol(state.symbol);
      state.bars = await fetchBars(fetchSym, state.interval, state.range);
      const meta = state.hub?.getBarMeta?.(fetchSym);
      state.priorClose = meta?.priorClose ?? null;
      state.srLines = findSupportResistance(state.bars, state.priorClose);
      await ensureSymbolNews(state.symbol);
      state.events = eventsFromHub(state.symbol);
      if (!state.bars.length) {
        fetchErr =
          hubState().spyLoadError ||
          "No price data for " +
          symbolLabel(state.symbol) +
          " (" +
          fetchSym +
          "). Check connection and retry.";
      }
    } catch (e) {
      state.bars = [];
      fetchErr = e?.message || "Chart fetch failed";
    } finally {
      setChartLoading(false);
    }
    if (fetchErr && state.hub?.setChartError) state.hub.setChartError(fetchErr);
    else if (state.bars.length && state.hub?.setChartError) state.hub.setChartError(null);
    refreshMorningTradePlan();
    void ensureFundamentalValue();
    if (typeof global.RMSchwabData !== "undefined" && global.RMSchwabData.refreshSchwabTrades) {
      void global.RMSchwabData.refreshSchwabTrades(false).then(() => paint());
    }
    paintToolbar();
    paint();
    document.dispatchEvent(
      new CustomEvent("rm:chart-bars", {
        detail: { symbol: state.symbol, compare: isCompareMode() },
      })
    );
  }

  function syncFromHub() {
    const hub = hubState();
    if (hub.interval) state.interval = hub.interval;
    if (hub.range) state.range = hub.range;
  }

  function syncToolbarFromHub() {
    syncFromHub();
    clampRangeInterval("range");
    const rgEl = $("#caRange");
    const ivEl = $("#caInterval");
    if (rgEl) rgEl.value = state.range;
    if (ivEl) ivEl.value = state.interval;
    const symEl = $("#caSymbol");
    if (symEl && isCompareMode()) symEl.value = COMPARE_SYM;
    syncSymbolInputFromView();
  }

  function ensureMobileIndicatorDefaults() {
    if (
      typeof matchMedia === "undefined" ||
      !matchMedia("(max-width: 640px)").matches
    ) {
      return;
    }
    try {
      if (sessionStorage.getItem("rm_mobile_chart_ind_v1") === "1") return;
      sessionStorage.setItem("rm_mobile_chart_ind_v1", "1");
    } catch {
      return;
    }
    state.indicators.macd = false;
    state.indicators.rsi = false;
    state.indicators.ichimoku = false;
    state.indicators.macdrsiBuy = true;
    saveChartPrefs();
    paintToolbar();
    paint();
  }

  function migrateMacdrsiBuyDefaultOn() {
    state.indicators.macdrsiBuy = true;
    try {
      if (localStorage.getItem(MACDRSI_BUY_DEFAULT_KEY) === "1") return;
      localStorage.setItem(MACDRSI_BUY_DEFAULT_KEY, "1");
      let p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (!p || typeof p !== "object") p = {};
      if (!p.indicators) p.indicators = {};
      p.indicators.macdrsiBuy = true;
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* keep in-memory default on */
    }
  }

  function loadChartPrefs() {
    migrateMacdrsiBuyDefaultOn();
    let p = null;
    try {
      p = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    } catch {
      p = null;
    }
    state.indicators.macdrsiBuy = true;
    if (!p || typeof p !== "object") {
      saveChartPrefs();
      return;
    }
    if (p.indicators && typeof p.indicators === "object") {
      ["macd", "rsi", "ichimoku", "macdrsiBuy", "volume", "emaStack", "fairValue"].forEach((k) => {
        if (typeof p.indicators[k] === "boolean") state.indicators[k] = p.indicators[k];
      });
    }
    if (typeof p.showSR === "boolean") state.showSR = p.showSR;
    if (typeof p.showEvents === "boolean") state.showEvents = p.showEvents;
    if (p.yAxisPct === true || p.yAxisPct === false || p.yAxisPct === null) {
      state.yAxisPct = p.yAxisPct;
    }
    if (typeof p.interval === "string" && INTERVALS.includes(p.interval)) {
      state.interval = p.interval;
    }
    if (typeof p.range === "string" && RANGES.includes(p.range)) {
      state.range = p.range;
    }
    clampRangeInterval("range");
    if (state.interval === "1m" && state.range === "1d") {
      state.interval = "5m";
    }
  }

  function saveChartPrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          indicators: {
            macd: state.indicators.macd,
            rsi: state.indicators.rsi,
            ichimoku: state.indicators.ichimoku,
            macdrsiBuy: state.indicators.macdrsiBuy,
            volume: state.indicators.volume,
            emaStack: state.indicators.emaStack,
            fairValue: state.indicators.fairValue,
          },
          showSR: state.showSR,
          showEvents: state.showEvents,
          yAxisPct: state.yAxisPct,
          interval: state.interval,
          range: state.range,
        })
      );
    } catch {
      /* ignore quota / disabled storage */
    }
  }

  async function loadChartLayersConfig() {
    try {
      const r = await fetch("config/chart_layers.json");
      if (r.ok) _chartLayersConfig = await r.json();
    } catch (_) {
      /* optional config */
    }
  }

  function mount(container, hubRef, opts) {
    if (!container) return;
    state.container = container;
    state.hub = hubRef;
    syncFromHub();
    void loadChartLayersConfig();
    loadChartPrefs();
    if (typeof global.RMEmaOverlay !== "undefined") void global.RMEmaOverlay.loadConfig();
    if (typeof global.RMEmaSignals !== "undefined") void global.RMEmaSignals.loadConfig();
    if (typeof global.RMFundamentalValue !== "undefined") void global.RMFundamentalValue.loadConfig();
    ensureMobileIndicatorDefaults();
    clampRangeInterval("range");
    state._viewContextKey = viewContextKey();
    if (state.hub?.state) {
      state.hub.state.interval = state.interval;
      state.hub.state.range = state.range;
    }
    if (!state.symbol) state.symbol = "SPY";
    bindChartResize();
    ensureIndicatorMenuBindings();
    paintToolbar();
    updateIndicatorBtn();
    if (!opts?.deferLoad) {
      void reload({ resetView: true, preserveView: false });
    }
  }

  function syncSymbolOptions() {
    const sel = $("#caSymbol");
    if (!sel) return;
    const current = state.symbol;
    const syms = getSymbols();
    sel.innerHTML = syms
      .map(
        (s) =>
          '<option value="' +
          escapeAttr(s) +
          '"' +
          (current === s ? " selected" : "") +
          ">" +
          escapeHtml(symbolLabel(s)) +
          "</option>"
      )
      .join("");
    if (current && syms.includes(current)) sel.value = current;
  }

  async function render(hubRef, opts) {
    state.hub = hubRef || state.hub;
    measureChartSize();
    const preserveView = opts?.preserveView !== false;
    if (opts?.syncHub !== false) syncFromHub();
    if (isCompareMode()) {
      state.events = eventsFromHub(COMPARE_SYM);
      syncSymbolOptions();
      // Item 6: when a scan adds a ticker, refit Y so every series stays visible.
      // During scan, keep the morning-open time window the user panned to.
      applyFitForRender(opts);
      paintNow();
      if (hubState().candidateSeries) fireBeam();
      return;
    }
    await reload({ preserveView, resetView: opts?.resetView === true });
  }

  function refresh(container, hubRef, opts) {
    state.container = container || state.container;
    state.hub = hubRef || state.hub;
    return render(state.hub, opts);
  }

  global.RMAnalysisChart = {
    mount,
    render,
    paint,
    refresh,
    reload,
    fireBeam,
    saveTradeMarker,
    tradeMarkersForSymbol,
    setMapHighlight,
    syncTradePlan,
    collapseTradePlanOnChart,
    dismissExpandedTradePlan,
    ensureResultsPlanPanel,
    showResultsPlanPanel,
    surfacePlanToResults,
    ensureMobileIndicatorDefaults,
    refreshMorningTradePlan,
    refreshTradeOverlay,
    dismissSrLine,
    loadTickerSymbol,
    addCompareSymbol,
    syncSymbolOptions,
    syncSymbolInputFromView,
    syncToolbarFromHub,
    ensureSymbolNews,
    headlinesForChartSymbol,
    scanStorageKey: markerStorageKey,
    openNoteForScan,
    axisStoredValueToChart,
    setDebriefWindow,
    clearDebriefWindow,
    focusDebriefWindow,
    setActiveTradeMarker,
    fpsMeter: fpsMeterSnapshot,
    animateToMorningOpenForScan,
    ensureMorningScanView,
    prepareScanIntroFromView,
    isMorningScanView,
    cancelViewPanAnim,
    COMPARE_SYM,
    state,
  };

  document.addEventListener("rm:schwab-positions", () => {
    invalidateHoldingsLabelCache();
    lastToolbarSymbolsKey = "";
    syncSymbolOptions();
    if (state.symbol) {
      const symEl = $("#caSymbol");
      if (symEl && [...symEl.options].some((o) => o.value === state.symbol)) {
        symEl.value = state.symbol;
      }
    }
    syncSymbolInputFromView();
  });
})(typeof window !== "undefined" ? window : globalThis);

