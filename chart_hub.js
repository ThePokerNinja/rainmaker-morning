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
