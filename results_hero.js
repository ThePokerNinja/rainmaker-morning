/** Results tab hero (r3/c3) — ticker dashboard + setup visualization. */
(function (global) {
  const LOGO_URL =
    "https://storage.googleapis.com/iexcloud-hl37opg/api/logos/";
  const quoteCache = new Map();
  let mode = "idle";
  let currentSym = null;
  let ctx = {
    getSession: () => null,
    getActivePick: () => null,
    getScanningSymbol: () => null,
    getTrades: () => [],
    getJournalTrades: () => [],
    collectOpenRows: () => [],
    renderOpenRow: () => "",
    openResultsTab: () => {},
    pickScore: () => null,
    onCtaAction: () => {},
  };

  const INDEX_SYMS = new Set(["SPY", "QQQ", "IWM", "VIX", "^VIX"]);

  function isIndexSymbol(sym) {
    const s = String(sym || "").toUpperCase().replace(/^\^/, "");
    return INDEX_SYMS.has(s) || INDEX_SYMS.has("^" + s);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fmtPrice(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    return v >= 1000 ? v.toFixed(2) : v.toFixed(2);
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function fmtVol(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }

  function fmtCap(n) {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    if (v >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    return String(Math.round(v));
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function sessionLabel(q) {
    if (!q?.session) return "";
    if (q.session === "pre") return "Pre-market";
    if (q.session === "post") return "After hours";
    if (q.session === "closed") return "Market closed";
    return "At close";
  }

  function findPick(sym) {
    const session = ctx.getSession?.();
    if (!session?.picks?.length) return null;
    return session.picks.find((p) => p.symbol === sym) || null;
  }

  function isCompareChart() {
    if (typeof RMAnalysisChart === "undefined") return false;
    return RMAnalysisChart.state?.symbol === RMAnalysisChart.COMPARE_SYM;
  }

  function resolveChartSelectSymbol(raw) {
    const key = String(raw || "").trim();
    if (!key) return "";
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolForSelectValue) {
      return global.RMHoldings.chartSymbolForSelectValue(key);
    }
    if (/^holding:/i.test(key)) return "";
    return key.toUpperCase();
  }

  function resolveFocusSymbol(preferred) {
    if (preferred) {
      if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartFocusFromSelectKey) {
        const f = global.RMHoldings.chartFocusFromSelectKey(preferred);
        if (f) return f.symbol || f.displayKey;
      }
      return resolveChartSelectSymbol(preferred) || String(preferred).toUpperCase();
    }
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol) {
      const raw = RMAnalysisChart.state.symbol;
      if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartFocusFromSelectKey) {
        const f = global.RMHoldings.chartFocusFromSelectKey(raw);
        if (f) return f.symbol || f.displayKey;
      }
    }
    const scanning = ctx.getScanningSymbol?.();
    if (scanning) return scanning;
    if (typeof RMChartHub !== "undefined") {
      if (RMChartHub.state?.scanningSym) return RMChartHub.state.scanningSym;
      if (RMChartHub.state?.candidateSym) return RMChartHub.state.candidateSym;
    }
    if (typeof RMAnalysisChart !== "undefined") {
      const sym = RMAnalysisChart.state?.symbol;
      const compare = RMAnalysisChart.COMPARE_SYM;
      if (sym && sym !== compare) {
        const resolved = resolveChartSelectSymbol(sym);
        if (resolved) return resolved;
      }
      if (sym === compare) return "SPY";
    }
    const active = ctx.getActivePick?.();
    if (active?.symbol) return active.symbol;
    return "SPY";
  }

  function chartBarsForSymbol(sym) {
    const s = String(sym || "").toUpperCase();
    if (typeof RMChartHub !== "undefined") {
      if (s === "SPY" && RMChartHub.state?.spyBars?.length) {
        return RMChartHub.state.spyBars;
      }
      const ov = RMChartHub.state?.overlays?.get?.(s);
      if (ov?.length) return ov;
      if (RMChartHub.state?.candidateSym === s && RMChartHub.state?.candidateSeries?.length) {
        return RMChartHub.state.candidateSeries.map((p) => ({
          close: p.pct,
          high: p.pct,
          low: p.pct,
          open: p.pct,
          t: p.t,
        }));
      }
    }
    if (typeof RMAnalysisChart !== "undefined") {
      const st = RMAnalysisChart.state;
      const chartSym = resolveChartSelectSymbol(st?.symbol);
      if (
        st?.bars?.length &&
        (chartSym === s || st.symbol === s || (s === "SPY" && isCompareChart()))
      ) {
        return st.bars;
      }
    }
    return null;
  }

  function quoteFromChart(sym, bars, pick) {
    if (!bars?.length) return null;
    const last = bars[bars.length - 1];
    const first = bars[0];
    let priorClose =
      typeof RMChartHub !== "undefined"
        ? RMChartHub.state?.barMeta?.[sym]?.priorClose
        : null;
    if (priorClose == null && typeof RMAnalysisChart !== "undefined") {
      priorClose = RMAnalysisChart.state?.barMeta?.priorClose ?? null;
    }
    if (priorClose == null) priorClose = first?.open ?? last.close;
    const price = last.close ?? last.open;
    let chg = null;
    if (price != null && priorClose != null && priorClose !== 0) {
      chg = ((price - priorClose) / priorClose) * 100;
    }
    const highs = bars.map((b) => b.high ?? b.close).filter(Number.isFinite);
    const lows = bars.map((b) => b.low ?? b.close).filter(Number.isFinite);
    return {
      symbol: sym,
      price,
      chg,
      session:
        typeof RMChartHub !== "undefined"
          ? RMChartHub.state?.marketSession || "unknown"
          : "unknown",
      prevClose: priorClose,
      open: first?.open ?? pick?.open ?? null,
      dayHigh: highs.length ? Math.max(...highs) : null,
      dayLow: lows.length ? Math.min(...lows) : null,
      volume: pick?.volume ?? null,
      gapPct: pick?.gap_pct ?? null,
      rm: pick
        ? (ctx.pickScore?.(pick) ?? pick.rm_confidence ?? null)
        : null,
      pick,
      bars,
      fromChart: true,
      at: Date.now(),
    };
  }

  function heroRoot() {
    return $("ttResultsHero");
  }

  function heroInner() {
    return $("ttResultsHeroInner");
  }

  function perfStripEl() {
    return $("ttResultsPerfStrip");
  }

  function openRailEl() {
    return $("ttResultsOpenRail");
  }

  function deskCtaEl() {
    return $("ttResultsDeskCta");
  }

  function commandCenterEl() {
    return $("ttResultsCommandCenter");
  }

  function setHeroMode(next) {
    mode = next;
    const root = heroRoot();
    if (!root) return;
    root.dataset.mode = next;
    root.classList.toggle("tt-results-hero--setup", next === "setup");
    root.classList.toggle("tt-results-hero--ticker", next === "ticker");
    root.classList.toggle("tt-results-hero--signal", next === "signal");
    root.classList.toggle("tt-results-hero--idle", next === "idle");
    root.classList.toggle("tt-results-hero--overview", next === "overview");
    root.classList.toggle("tt-results-hero--position", next === "position");
  }

  function holdingFromCtx(h) {
    return h || null;
  }

  function positionLabel(h) {
    if (typeof RMHoldings !== "undefined" && RMHoldings.formatOptionLabel) {
      const lbl = RMHoldings.formatOptionLabel(h?.symbol);
      if (lbl && lbl !== String(h?.symbol || "").trim()) return lbl;
    }
    return String(h?.symbol || "").trim();
  }

  function positionHeroHtml(h, q) {
    const sym = String(h?.symbol || "").trim();
    const isOpt =
      h?.instrument === "option" ||
      (typeof RMHoldings !== "undefined" && RMHoldings.isOptionSymbol?.(sym));
    const parsed =
      isOpt && typeof RMHoldings !== "undefined" && RMHoldings.parseOptionContract
        ? RMHoldings.parseOptionContract(sym)
        : null;
    const qty = Math.abs(Number(h?.quantity ?? h?.qty) || 0);
    const avg = h?.entry_price ?? h?.avgPrice;
    const mv = h?.market_value ?? h?.marketValue;
    const pnl =
      typeof RMHoldings !== "undefined" && RMHoldings.openPositionPnl
        ? RMHoldings.openPositionPnl(h)
        : null;
    const up = q?.chg != null && Number(q.chg) >= 0;
    const chgCls = up ? "tt-hero-price--up" : "tt-hero-price--down";
    const spark = sparklinePath(q?.bars, 320, 72);
    const title = positionLabel(h);
    let sub = parsed
      ? parsed.right +
        " · " +
        parsed.expiryShort +
        " · $" +
        parsed.strike +
        (parsed.right === "Call" ? " call" : " put")
      : isOpt
        ? "Option contract"
        : "Stock position";
    if (qty) sub += " · " + qty + (isOpt ? " contracts" : " shares");
    if (parsed?.underlying) sub = parsed.underlying + " · " + sub;
    const stats = [];
    if (avg != null) stats.push(["Avg", "$" + Number(avg).toFixed(2) + (isOpt ? " prem" : "")]);
    if (q?.price != null) stats.push(["Mark", fmtPrice(q.price)]);
    if (mv != null) stats.push(["Value", fmtUsd(Number(mv))]);
    if (pnl?.dollars != null) {
      stats.push([
        "Open P/L",
        (pnl.dollars >= 0 ? "+" : "") + fmtUsd(pnl.dollars),
      ]);
    }
    const grid = stats
      .map(([l, v]) => metricCell(l, v))
      .join("");
    return (
      '<div class="tt-hero-card tt-hero-card--position">' +
      '<header class="tt-hero-head">' +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">Open position</p>' +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(title) +
      "</h3>" +
      '<p class="tt-hero-exchange">' +
      escapeHtml(sub) +
      "</p></div>" +
      (q?.price != null
        ? '<div class="tt-hero-price-block ' +
          chgCls +
          '"><span class="tt-hero-price">' +
          escapeHtml(fmtPrice(q.price)) +
          '</span><span class="tt-hero-chg">' +
          escapeHtml(fmtPct(q.chg)) +
          "</span></div>"
        : "") +
      "</header>" +
      '<div class="tt-hero-chart-band">' +
      (spark
        ? '<svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg>'
        : '<div class="tt-hero-spark-placeholder rm-desk-spark-idle" aria-hidden="true"></div>') +
      "</div>" +
      (grid ? '<div class="tt-hero-metrics tt-hero-metrics--position">' + grid + "</div>" : "") +
      backToOverviewLinkHtml() +
      "</div>"
    );
  }

  async function showOpenPosition(holding) {
    const h = holdingFromCtx(holding);
    if (!h?.symbol) {
      requestOverviewRefresh({ soft: false });
      return;
    }
    const inner = heroInner();
    if (!inner) return;
    const quoteSym =
      typeof RMHoldings !== "undefined" && RMHoldings.quoteSymbolFor
        ? RMHoldings.quoteSymbolFor(h)
        : String(h.symbol).trim().toUpperCase();
    currentSym = quoteSym;
    setHeroMode("position");
    showPlanSlot(false);
    ctx.openResultsTab?.();
    const instant = safeQuoteFromChart(
      quoteSym,
      chartBarsForSymbol(quoteSym),
      null
    );
    if (hasQuoteData(instant)) {
      inner.innerHTML = positionHeroHtml(h, instant);
    } else {
      inner.innerHTML = positionHeroHtml(h, { symbol: quoteSym });
    }
    try {
      const q = await loadQuote(quoteSym);
      if (hasQuoteData(q)) {
        inner.innerHTML = positionHeroHtml(h, q);
      }
    } catch {
      /* keep instant */
    }
  }

  function readConvictionCopy() {
    const kickerEl = document.querySelector("#headerMoodCopy .hm-kicker");
    const lineEl = document.querySelector("#headerMoodCopy .hm-line");
    if (kickerEl?.textContent?.trim()) {
      return {
        kicker: kickerEl.textContent.trim(),
        line:
          lineEl?.textContent?.trim() ||
          "Mixed signals. The tape hasn't picked a side yet.",
      };
    }
    if (typeof RMHeaderMood !== "undefined" && RMHeaderMood.TIERS) {
      const st = RMHeaderMood.getState?.();
      const tier = RMHeaderMood.TIERS.find((t) => t.id === (st?.tier || "neutral"));
      if (tier) return { kicker: tier.kicker, line: tier.line };
    }
    return {
      kicker: "Undecided",
      line: "Mixed signals. The tape hasn't picked a side yet.",
    };
  }

  function indexChip(sym, indices) {
    const key = sym === "VIX" ? "^VIX" : sym;
    const hit =
      indices?.[sym] || indices?.[key] || indices?.[sym.replace("^", "")];
    if (!hit || hit.price == null) return "";
    const chg = hit.chg ?? hit.pct_change ?? null;
    const up = chg != null && Number(chg) >= 0;
    return (
      '<span class="rm-desk-index ' +
      (up ? "rm-desk-index--up" : chg != null ? "rm-desk-index--down" : "") +
      '">' +
      '<span class="rm-desk-index-sym">' +
      escapeHtml(sym.replace("^", "")) +
      "</span>" +
      '<span class="rm-desk-index-px">' +
      escapeHtml(fmtPrice(hit.price)) +
      "</span>" +
      (chg != null
        ? '<span class="rm-desk-index-chg">' + escapeHtml(fmtPct(chg)) + "</span>"
        : "") +
      "</span>"
    );
  }

  async function schwabConnectedAsync() {
    if (typeof RMSchwab === "undefined" || !RMSchwab.getStatus) return false;
    try {
      const st = await RMSchwab.getStatus();
      return !!(st?.connected && !st?.needsReconnect);
    } catch {
      return false;
    }
  }

  const schwabStatusCache = { at: 0, connected: false };
  let schwabStatusKnown = false;
  let schwabPrefetchInflight = null;

  function updateSchwabStatus(connected) {
    schwabStatusKnown = true;
    schwabStatusCache.at = Date.now();
    schwabStatusCache.connected = !!connected;
    if (mode === "overview" || mode === "idle") {
      requestOverviewRefresh({ soft: true });
    }
  }

  function schwabConnectedSync() {
    if (typeof RMHoldings !== "undefined" && RMHoldings.getBrokerPositions) {
      if (RMHoldings.getBrokerPositions().length) return true;
    }
    if (Date.now() - schwabStatusCache.at < 120000) return schwabStatusCache.connected;
    return schwabStatusCache.connected;
  }

  function prefetchSchwabStatusForOverview() {
    if (schwabStatusKnown || Date.now() - schwabStatusCache.at < 60000) return;
    if (schwabPrefetchInflight) return;
    schwabPrefetchInflight = ensureSchwabReadyForOverview().finally(() => {
      schwabPrefetchInflight = null;
    });
  }

  async function ensureSchwabReadyForOverview() {
    if (schwabStatusKnown) return;
    try {
      if (typeof RMChunkLoader !== "undefined") {
        await RMChunkLoader.ensureBroker();
      }
      if (typeof RMSchwab !== "undefined" && RMSchwab.bootstrapDashboard) {
        await RMSchwab.bootstrapDashboard();
        return;
      }
      if (typeof RMSchwab !== "undefined" && RMSchwab.getStatus) {
        const st = await RMSchwab.getStatus();
        updateSchwabStatus(!!(st?.connected && !st?.needsReconnect));
        return;
      }
      updateSchwabStatus(false);
    } catch {
      updateSchwabStatus(false);
    }
  }

  function collectOpenSymbols() {
    const syms = [];
    const seen = new Set();
    const trades = ctx.getTrades?.() || [];
    trades
      .filter((t) => t && t.status === "open")
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(b.opened_at || "") || 0) - (Date.parse(a.opened_at || "") || 0)
      )
      .forEach((t) => {
        const s = String(t.symbol || "").toUpperCase();
        if (!s || seen.has(s)) return;
        seen.add(s);
        syms.push(s);
      });
    if (typeof RMHoldings !== "undefined" && RMHoldings.getBrokerPositions) {
      RMHoldings.getBrokerPositions().forEach((p) => {
        const s = String(p.symbol || "").toUpperCase();
        if (!s || seen.has(s)) return;
        seen.add(s);
        syms.push(s);
      });
    }
    return syms;
  }

  function resolveResultsCta(bundle) {
    const overviewCtx = bundle || {};
    const openSyms = overviewCtx.openSyms || [];
    const pickN = overviewCtx.pickCount || 0;
    const pulseStop = overviewCtx.pulseGate === "stop" || overviewCtx.c1?.gate === "stop";
    if (openSyms.length) {
      const sym = openSyms[0];
      const label =
        typeof RMHoldings !== "undefined" &&
        RMHoldings.isOptionSymbol?.(sym) &&
        RMHoldings.formatOptionLabel
          ? RMHoldings.formatOptionLabel(sym)
          : sym;
      return {
        action: "review_symbol",
        label: "Review " + label + " on chart",
        symbol: sym,
      };
    }
    if (pickN > 0) {
      return { action: "compare_picks", label: "Compare " + pickN + " picks" };
    }
    if (!overviewCtx.schwabConnected) {
      return { action: "connect_schwab", label: "Connect Schwab" };
    }
    if (pulseStop) {
      const stage = overviewCtx.stage || overviewCtx.kpi?.stage;
      const closedN = (overviewCtx.tradesClosedToday || []).length;
      if (stage === "reflect" && closedN > 0) {
        return {
          action: "review_closed",
          label:
            "Review today's " + closedN + " close" + (closedN === 1 ? "" : "s"),
          hint: "Risk-off day — journal what worked before tomorrow.",
        };
      }
      return {
        action: "review_symbol",
        label: "Stand aside — watch SPY",
        symbol: "SPY",
        hint: "Pulse gate is stop. No new setups — watch tape or stay flat.",
      };
    }
    if (!pickN) {
      return { action: "load_scan", label: "Load morning scan" };
    }
    return { action: "chart_focus", label: "Open chart focus" };
  }

  function personalStripParts(overviewCtx) {
    const parts = [];
    const openN = overviewCtx.openSyms?.length || 0;
    if (openN) parts.push(openN + " open");
    if (overviewCtx.pickCount) parts.push(overviewCtx.pickCount + " picks");
    if (overviewCtx.charge != null && overviewCtx.charge > 0) {
      parts.push(overviewCtx.charge + " green-light" + (overviewCtx.charge === 1 ? "" : "s"));
    }
    if (overviewCtx.pulseLabel) parts.push(overviewCtx.pulseLabel);
    return parts;
  }

  function kpiSignalPills(data) {
    const pills = [];
    const c1 = data.c1;
    const c2 = data.c2;
    if (c1?.gate) {
      pills.push("C1 " + String(c1.gate).toUpperCase());
    }
    if (c2?.gate) {
      pills.push("C2 " + String(c2.gate).toUpperCase());
    }
    (c1?.signals || []).slice(0, 2).forEach((s) => pills.push(String(s)));
    return pills
      .slice(0, 5)
      .map((p) => '<span class="rm-desk-pill">' + escapeHtml(p) + "</span>")
      .join("");
  }

  function overviewHeroHtml(data) {
    const copy = data.conviction;
    const bias = data.bias;
    const indices = data.indices || {};
    const chips = ["SPY", "QQQ", "VIX"].map((s) => indexChip(s, indices)).filter(Boolean).join("");
    const spark = sparklinePath(data.bars, 320, 72);
    const drivers = (bias?.market?.drivers || []).slice(0, 3);
    const driverPills = drivers
      .map(
        (d) =>
          '<span class="rm-desk-pill">' + escapeHtml(String(d)) + "</span>"
      )
      .join("");
    const kpiPills = kpiSignalPills(data);
    const personal = personalStripParts(data);
    const narrative = data.deskNarrative || copy.line;
    return (
      '<section class="rm-results-desk">' +
      '<div class="rm-results-desk-bg" aria-hidden="true">' +
      '<div class="rm-results-desk-mesh"></div>' +
      '<div class="rm-results-desk-glow"></div>' +
      '<img class="rm-results-desk-mark" src="assets/rm-story-icon.svg" alt="" decoding="async" />' +
      "</div>" +
      '<div class="rm-results-desk-body">' +
      '<div class="rm-results-desk-top">' +
      "<div>" +
      '<p class="rm-results-desk-kicker">Morning desk</p>' +
      '<h3 class="rm-results-desk-title">' +
      escapeHtml(copy.kicker) +
      "</h3>" +
      '<p class="rm-results-desk-sub">' +
      escapeHtml(narrative) +
      "</p>" +
      (data.c1?.posture || data.c2?.posture
        ? '<p class="rm-results-desk-signals meta">' +
          escapeHtml(
            [data.c1?.posture, data.c2?.posture].filter((p) => p && p !== "—").join(" · ")
          ) +
          "</p>"
        : "") +
      "</div>" +
      (bias?.market?.label
        ? '<span class="rm-results-desk-pulse" title="Morning Pulse">' +
          escapeHtml(bias.market.label) +
          "</span>"
        : "") +
      "</div>" +
      (chips ? '<div class="rm-results-desk-indices">' + chips + "</div>" : "") +
      '<div class="rm-results-desk-chart-band">' +
      (spark
        ? '<svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg>'
        : '<div class="tt-hero-spark-placeholder rm-desk-spark-idle" aria-hidden="true"></div>') +
      "</div>" +
      (kpiPills || driverPills
        ? '<div class="rm-results-desk-pills">' + kpiPills + driverPills + "</div>"
        : "") +
      (personal.length
        ? '<p class="rm-results-desk-personal">' + escapeHtml(personal.join(" · ")) + "</p>"
        : "") +
      "</div></section>"
    );
  }

  function deskCtaHtml(cta) {
    if (!cta) return "";
    return (
      '<button type="button" class="primary rm-results-desk-cta" data-results-cta="' +
      escapeHtml(cta.action) +
      '"' +
      (cta.symbol ? ' data-results-symbol="' + escapeHtml(cta.symbol) + '"' : "") +
      (cta.focus ? ' data-results-focus="' + escapeHtml(cta.focus) + '"' : "") +
      ">" +
      escapeHtml(cta.label) +
      "</button>"
    );
  }

  function perfStripHtml(bundle) {
    const s = bundle?.journal;
    if (!s?.trades) return "";
    const chip = (label, value, cls) =>
      '<div class="rm-perf-chip">' +
      '<span class="rm-perf-chip-k">' +
      escapeHtml(label) +
      "</span>" +
      '<strong class="' +
      (cls || "") +
      '">' +
      escapeHtml(value) +
      "</strong></div>";
    const signR = (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
    const chips = [
      chip("Trades", String(s.trades)),
      s.winPct != null
        ? chip("Win rate", s.winPct + "%", s.winPct >= 50 ? "is-pos" : "is-neg")
        : "",
      s.avgR != null
        ? chip("Expectancy", signR(s.avgR), s.avgR >= 0 ? "is-pos" : "is-neg")
        : "",
      s.totalR != null
        ? chip("Total", signR(s.totalR), s.totalR >= 0 ? "is-pos" : "is-neg")
        : "",
      s.totalPnl != null
        ? chip("P&L", fmtUsd(s.totalPnl), s.totalPnl >= 0 ? "is-pos" : "is-neg")
        : "",
    ]
      .filter(Boolean)
      .join("");
    let followHtml = "";
    if (typeof RMMetrics !== "undefined" && RMMetrics.convictionFollowRate) {
      const cf = RMMetrics.convictionFollowRate(30);
      if (cf && cf.eligible > 0) {
        followHtml =
          '<p class="rm-perf-follow">Followed conviction <strong>' +
          cf.followed +
          "/" +
          cf.eligible +
          "</strong> day" +
          (cf.eligible === 1 ? "" : "s") +
          " · " +
          Math.round(cf.rate * 100) +
          "% follow-through</p>";
      }
    }
    const spark =
      typeof global.RMJournal !== "undefined" && global.RMJournal.equitySparklineSvg
        ? global.RMJournal.equitySparklineSvg(s.equity)
        : "";
    return (
      '<div class="rm-perf-head">' +
      '<h3 class="tt-results-section-title">Your account</h3>' +
      spark +
      "</div>" +
      '<div class="rm-perf-stats">' +
      chips +
      "</div>" +
      followHtml
    );
  }

  function renderPerfStrip(bundle) {
    const el = perfStripEl();
    if (!el) return;
    const html = perfStripHtml(bundle);
    if (!html) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = html;
  }

  function renderOpenRail(bundle) {
    const list = $("ttResultsOpenList");
    const meta = $("ttResultsOpenMeta");
    const rail = openRailEl();
    if (!list) return;
    const rows = ctx.collectOpenRows?.() || [];
    if (!rows.length) {
      list.innerHTML =
        '<p class="cal-list-empty meta">No open positions — connect Schwab or open a setup from the chart footer.</p>';
      if (meta) meta.textContent = "";
      if (rail) rail.classList.add("is-empty");
      document.dispatchEvent(new CustomEvent("rm:results-open-rendered"));
      return;
    }
    if (rail) rail.classList.remove("is-empty");
    const journalN = rows.filter((r) => r.kind === "journal").length;
    if (meta) {
      meta.textContent =
        rows.length +
        " open position" +
        (rows.length === 1 ? "" : "s") +
        (journalN ? " · " + journalN + " in journal" : "");
    }
    const renderRow = ctx.renderOpenRow;
    list.innerHTML = rows.map((row) => (renderRow ? renderRow(row) : "")).join("");
    document.dispatchEvent(new CustomEvent("rm:results-open-rendered"));
  }

  function renderCtaSlot(bundle) {
    const el = deskCtaEl();
    if (!el) return;
    const cta = bundle?.cta || resolveResultsCta(bundle);
    const hint = cta?.hint
      ? '<p class="meta rm-results-desk-cta-hint">' + escapeHtml(cta.hint) + "</p>"
      : "";
    el.innerHTML = hint + deskCtaHtml(cta);
    el.hidden = !cta;
  }

  function buildOverviewContextSync() {
    if (typeof RMResultsContext !== "undefined" && RMResultsContext.buildResultsContext) {
      const bundle = RMResultsContext.buildResultsContext({
        getSession: ctx.getSession,
        getTrades: ctx.getTrades,
        getJournalTrades: ctx.getJournalTrades || ctx.getTrades,
        schwabConnectedSync,
        collectOpenSymbols,
        readConvictionCopy,
      });
      if (!bundle.bars?.length) {
        bundle.bars = chartBarsForSymbol("SPY");
      }
      bundle.cta = resolveResultsCta(bundle);
      return bundle;
    }
    const conviction = readConvictionCopy();
    const bias =
      typeof RMMarket !== "undefined" && RMMarket.getLastMorningBias
        ? RMMarket.getLastMorningBias()
        : null;
    const indices =
      typeof RMMarket !== "undefined" && RMMarket.getCachedIndices
        ? RMMarket.getCachedIndices()
        : {};
    const session = ctx.getSession?.();
    const pickCount = session?.pick_count || session?.picks?.length || 0;
    const openSyms = collectOpenSymbols();
    let pulseGate = null;
    let pulseLabel = null;
    let charge = null;
    if (typeof RMColumnKPI !== "undefined" && RMColumnKPI.compute) {
      const kpi = RMColumnKPI.compute();
      pulseGate = kpi?.c1?.gate || null;
      charge = kpi?.charge ?? null;
    }
    if (bias?.market?.label) pulseLabel = bias.market.label.toLowerCase();
    const bars = chartBarsForSymbol("SPY");
    const overviewCtx = {
      conviction,
      bias,
      indices,
      bars,
      pickCount,
      openSyms,
      pulseGate,
      pulseLabel,
      charge,
      schwabConnected: schwabConnectedSync(),
    };
    overviewCtx.cta = resolveResultsCta(overviewCtx);
    return overviewCtx;
  }

  function renderCommandCenter(bundle) {
    const cc = commandCenterEl();
    if (cc) cc.classList.toggle("is-overview", mode === "overview");
    renderPerfStrip(bundle);
    renderOpenRail(bundle);
    if (mode === "overview") {
      renderCtaSlot(bundle);
    } else {
      const ctaEl = deskCtaEl();
      if (ctaEl) {
        ctaEl.innerHTML = "";
        ctaEl.hidden = true;
      }
    }
  }

  function refreshOpenRail() {
    renderOpenRail(buildOverviewContextSync());
  }

  function refreshPerfStrip() {
    renderPerfStrip(buildOverviewContextSync());
  }

  function overviewSkeletonHtml() {
    return (
      '<section class="rm-results-desk rm-results-desk--skeleton" aria-busy="true">' +
      '<div class="rm-results-desk-bg" aria-hidden="true">' +
      '<div class="rm-results-desk-mesh"></div>' +
      '<div class="rm-results-desk-glow"></div>' +
      "</div>" +
      '<div class="rm-results-desk-body">' +
      '<p class="rm-results-desk-kicker">Morning desk</p>' +
      '<div class="rm-desk-skel-line rm-desk-skel-line--title"></div>' +
      '<div class="rm-desk-skel-line rm-desk-skel-line--sub"></div>' +
      '<div class="rm-results-desk-chart-band rm-desk-skel-chart"></div>' +
      "</div></section>"
    );
  }

  function handleHeroActions(e) {
    const back = e.target.closest?.("[data-results-back]");
    if (back) {
      e.preventDefault();
      requestOverviewRefresh({ soft: false });
      return;
    }
    const btn = e.target.closest?.("[data-results-cta]");
    if (
      !btn ||
      (!btn.closest("#ttResultsHeroInner") && !btn.closest("#ttResultsDeskCta"))
    )
      return;
    const action = btn.getAttribute("data-results-cta");
    const sym = btn.getAttribute("data-results-symbol");
    const focus = btn.getAttribute("data-results-focus");
    ctx.onCtaAction?.({ action, symbol: sym, focus: focus || undefined });
  }

  function backToOverviewLinkHtml() {
    return (
      '<p class="rm-results-desk-back">' +
      '<button type="button" class="btn-link" data-results-back="1">Back to overview</button></p>'
    );
  }

  let overviewGen = 0;
  let lastOverviewHtml = "";
  let overviewRefreshTimer = null;
  let overviewRefreshSoft = false;

  function applyOverviewHtml(inner, html) {
    if (!inner || !html || inner.innerHTML === html) return false;
    inner.innerHTML = html;
    lastOverviewHtml = html;
    inner.classList.remove("is-desk-loading");
    return true;
  }

  function requestOverviewRefresh(opts) {
    const soft = !!opts?.soft;
    if (!soft) {
      overviewRefreshSoft = false;
      if (overviewRefreshTimer) {
        clearTimeout(overviewRefreshTimer);
        overviewRefreshTimer = null;
      }
    } else if (overviewRefreshTimer) {
      overviewRefreshSoft = true;
      return;
    }
    const delay = soft ? 360 : 0;
    overviewRefreshTimer = setTimeout(() => {
      const runSoft = overviewRefreshSoft;
      overviewRefreshTimer = null;
      overviewRefreshSoft = false;
      showOverview({ soft: runSoft });
    }, delay);
  }

  function showOverview(opts) {
    const inner = heroInner();
    if (!inner) return;
    const soft = !!opts?.soft;
    const gen = ++overviewGen;
    currentSym = null;
    setHeroMode("overview");
    showPlanSlot(false);

    const hasDesk = !!inner.querySelector(".rm-results-desk:not(.rm-results-desk--skeleton)");
    if (!hasDesk && !soft) {
      inner.classList.add("is-desk-loading");
      inner.innerHTML = overviewSkeletonHtml();
    } else if (soft && hasDesk) {
      inner.classList.add("is-desk-refreshing");
    }

    if (!schwabStatusKnown && !opts?.skipSchwabWait) {
      void ensureSchwabReadyForOverview().then(() => {
        if (gen === overviewGen) showOverview({ soft: true, skipSchwabWait: true });
      });
      if (!hasDesk) return;
    }

    const data = buildOverviewContextSync();
    if (gen !== overviewGen) return;
    renderCommandCenter(data);
    const html = overviewHeroHtml(data);
    if (html === lastOverviewHtml && hasDesk) {
      inner.classList.remove("is-desk-refreshing");
      prefetchSchwabStatusForOverview();
      return;
    }
    applyOverviewHtml(inner, html);
    inner.classList.remove("is-desk-refreshing");
    prefetchSchwabStatusForOverview();
  }

  function metricCell(label, value, sub) {
    return (
      '<div class="tt-hero-metric">' +
      '<span class="tt-hero-metric-label">' +
      escapeHtml(label) +
      "</span>" +
      '<span class="tt-hero-metric-value">' +
      escapeHtml(value) +
      "</span>" +
      (sub ? '<span class="tt-hero-metric-sub">' + escapeHtml(sub) + "</span>" : "") +
      "</div>"
    );
  }

  function sparklinePath(bars, w, h) {
    if (!bars?.length) return "";
    const closes = bars.map((b) => b.close).filter((c) => c != null);
    if (closes.length < 2) return "";
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const step = w / (closes.length - 1);
    const pts = closes.map((c, i) => {
      const x = i * step;
      const y = h - ((c - min) / span) * (h - 8) - 4;
      return x.toFixed(1) + "," + y.toFixed(1);
    });
    return "M" + pts.join(" L");
  }

  function marketIndexQuote(sym) {
    if (typeof RMMarket === "undefined" || !RMMarket.getCachedIndices) return null;
    const hit = RMMarket.getCachedIndices()?.[sym];
    if (!hit || hit.price == null) return null;
    return {
      symbol: sym,
      price: hit.price,
      chg: hit.chg ?? hit.pct_change ?? null,
      prevClose: hit.prevClose ?? hit.previousClose ?? null,
      session: hit.session || "unknown",
      fromMarket: true,
    };
  }

  const prefetchInflight = new Map();

  async function loadQuote(sym) {
    const cached = quoteCache.get(sym);
    if (cached && Date.now() - cached.at < 45000) return cached.data;
    const pick = findPick(sym);
    let bars = chartBarsForSymbol(sym);
    let data = null;
    if (typeof RMYahooFetch !== "undefined") {
      try {
        data = await RMYahooFetch.fetchQuote(sym, { timeoutMs: 9000 });
      } catch {
        data = null;
      }
    }
    const market = marketIndexQuote(sym);
    if (!bars?.length && typeof RMYahooFetch !== "undefined") {
      try {
        const payload = await RMYahooFetch.fetchChartBars(sym, "5m", "1d", {
          includePrePost: true,
        });
        bars = payload?.bars || payload;
      } catch {
        bars = bars || null;
      }
    }
    const fromChart = quoteFromChart(sym, bars, pick);
    const dayHigh =
      bars?.length &&
      Math.max(...bars.map((b) => b.high ?? b.close).filter(Number.isFinite));
    const dayLow =
      bars?.length &&
      Math.min(...bars.map((b) => b.low ?? b.close).filter(Number.isFinite));
    const enriched = {
      symbol: sym,
      price:
        data?.price ?? fromChart?.price ?? market?.price ?? pick?.last ?? null,
      chg:
        data?.chg ?? fromChart?.chg ?? market?.chg ?? pick?.pct_change ?? null,
      session:
        data?.session ?? fromChart?.session ?? market?.session ?? "unknown",
      prevClose:
        data?.prevClose ?? fromChart?.prevClose ?? market?.prevClose ?? null,
      open: pick?.open ?? fromChart?.open ?? bars?.[0]?.open ?? null,
      dayHigh: dayHigh || fromChart?.dayHigh || null,
      dayLow: dayLow || fromChart?.dayLow || null,
      volume: pick?.volume ?? null,
      gapPct: pick?.gap_pct ?? null,
      rm: pick
        ? (ctx.pickScore?.(pick) ?? pick.rm_confidence ?? null)
        : null,
      pick,
      bars: bars || fromChart?.bars || null,
      at: Date.now(),
    };
    quoteCache.set(sym, { at: Date.now(), data: enriched });
    return enriched;
  }

  function hasQuoteData(q) {
    return !!(q && (q.price != null || (q.bars && q.bars.length >= 1)));
  }

  function newsCardHtml(pick) {
    const cat = pick?.catalyst;
    if (!cat?.headline) return "";
    const tone =
      cat.headline_sentiment === "up"
        ? "bullish"
        : cat.headline_sentiment === "down"
          ? "bearish"
          : "neutral";
    return (
      '<article class="tt-hero-news">' +
      '<span class="tt-hero-news-icon" aria-hidden="true">?</span>' +
      '<p class="tt-hero-news-text">' +
      escapeHtml(cat.headline) +
      "</p>" +
      '<p class="tt-hero-news-meta">Catalyst — ' +
      escapeHtml(tone) +
      (cat.source ? " — " + escapeHtml(cat.source) : "") +
      "</p></article>"
    );
  }

  function tickerHeroHtml(sym, q, opts) {
    const up = q.chg != null && Number(q.chg) >= 0;
    const chgCls = up ? "tt-hero-price--up" : "tt-hero-price--down";
    const scanning = opts?.scanning;
    const kicker = scanning
      ? "Scanning now"
      : q.pick
        ? "Rainmaker pick"
        : "Chart focus";
    const company = q.pick?.company || q.pick?.name || "";
    const title = company ? company + " (" + sym + ")" : sym;
    const logoSrc = LOGO_URL + sym + ".png";
    const spark = sparklinePath(q.bars, 320, 72);
    const rangeTxt =
      q.dayLow != null && q.dayHigh != null
        ? fmtPrice(q.dayLow) + " – " + fmtPrice(q.dayHigh)
        : "—";
    const hasPick = !!q.pick;
    const cols = hasPick
      ? [
          [
            ["Previous close", fmtPrice(q.prevClose)],
            ["Open", fmtPrice(q.open)],
            ["Gap", q.gapPct != null ? fmtPct(q.gapPct) : "—"],
            ["RM score", q.rm != null ? String(Math.round(q.rm)) : "—"],
          ],
          [
            ["Day range", rangeTxt],
            ["Volume", fmtVol(q.volume)],
            ["Session", sessionLabel(q)],
            ["EOD %", q.pick?.pct_eod != null ? fmtPct(q.pick.pct_eod) : "—"],
          ],
          [
            ["Last", fmtPrice(q.price)],
            ["Change", fmtPct(q.chg)],
            ["Float", q.pick?.float_m != null ? fmtVol(q.pick.float_m * 1e6) : "—"],
            ["Vol ratio", q.pick?.vol_ratio != null ? Number(q.pick.vol_ratio).toFixed(1) + "x" : "—"],
          ],
          [
            ["Catalyst", q.pick?.catalyst?.status === "ok" ? "Validated" : "Scan pick"],
            ["News", q.pick?.catalyst?.headline ? "Headline" : "—"],
            ["Sector", q.pick?.sector || "—"],
            ["Theme", q.pick?.theme || "—"],
          ],
        ]
      : [
          [
            ["Previous close", fmtPrice(q.prevClose)],
            ["Open", fmtPrice(q.open)],
            ["Day range", rangeTxt],
            ["Session", sessionLabel(q)],
          ],
          [
            ["Last", fmtPrice(q.price)],
            ["Change", fmtPct(q.chg)],
          ],
        ];
    const grid = cols
      .map(
        (col) =>
          '<div class="tt-hero-metrics-col">' +
          col.map(([l, v]) => metricCell(l, v)).join("") +
          "</div>"
      )
      .join("");

    return (
      '<div class="tt-hero-card tt-hero-card--ticker">' +
      '<header class="tt-hero-head">' +
      '<div class="tt-hero-brand">' +
      '<div class="tt-hero-logo-wrap">' +
      '<img class="tt-hero-logo" src="' +
      escapeHtml(logoSrc) +
      '" alt="" width="56" height="56" loading="lazy" onerror="this.classList.add(\'tt-hero-logo--fallback\');this.removeAttribute(\'src\');this.textContent=\'' +
      escapeHtml(sym.slice(0, 2)) +
      "'\">" +
      '<span class="tt-hero-logo-fallback" aria-hidden="true">' +
      escapeHtml(sym.slice(0, 2)) +
      "</span></div>" +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">' +
      escapeHtml(kicker) +
      "</p>" +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(title) +
      "</h3>" +
      '<p class="tt-hero-exchange">Nasdaq / NYSE — USD — Rainmaker tape</p></div></div>' +
      '<div class="tt-hero-price-block ' +
      chgCls +
      '">' +
      '<span class="tt-hero-price">' +
      escapeHtml(fmtPrice(q.price)) +
      "</span>" +
      '<span class="tt-hero-chg">' +
      escapeHtml(fmtPct(q.chg)) +
      "</span>" +
      '<span class="tt-hero-session">' +
      escapeHtml(sessionLabel(q)) +
      "</span></div></header>" +
      '<div class="tt-hero-chart-band">' +
      (spark
        ? '<svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg>'
        : '<div class="tt-hero-spark-placeholder">Loading intraday shape…</div>') +
      "</div>" +
      (opts?.buyMeta ? buyMetaBanner(opts.buyMeta) : "") +
      newsCardHtml(q.pick) +
      '<div class="tt-hero-metrics">' +
      grid +
      "</div>" +
      backToOverviewLinkHtml() +
      '<p class="tt-hero-footnote">Tap a money bag or map cell for this view — Tap the setup flag for trade levels</p></div>'
    );
  }

  function setupLadderSvg(plan, bars) {
    const prices = [
      plan.target2 ?? plan.target,
      plan.target1 ?? plan.target,
      plan.entry,
      plan.stop,
    ].filter((p) => p != null);
    if (!prices.length) return "";
    const min = Math.min(...prices, ...(bars || []).map((b) => b.low ?? b.close));
    const max = Math.max(...prices, ...(bars || []).map((b) => b.high ?? b.close));
    const span = max - min || 1;
    const yFor = (p) => 12 + (1 - (p - min) / span) * 136;
    const levels = [
      { p: plan.entry, label: "Entry", cls: "entry" },
      { p: plan.stop, label: "Stop", cls: "stop" },
      { p: plan.target1 ?? plan.target, label: "Sell 1", cls: "t1" },
      { p: plan.target2 ?? plan.target, label: "Sell 2", cls: "t2" },
    ];
    let svg =
      '<svg class="tt-hero-setup-svg" viewBox="0 0 280 160" xmlns="http://www.w3.org/2000/svg">';
    const spark = sparklinePath(bars, 200, 100);
    if (spark) {
      svg +=
        '<g transform="translate(64 24)"><path d="' +
        spark +
        '" fill="none" stroke="rgba(78,184,201,0.35)" stroke-width="1.5"/></g>';
    }
    levels.forEach((lv) => {
      if (lv.p == null) return;
      const y = yFor(lv.p);
      svg +=
        '<line x1="16" y1="' +
        y +
        '" x2="264" y2="' +
        y +
        '" class="tt-hero-setup-line tt-hero-setup-line--' +
        lv.cls +
        '"/>' +
        '<text x="20" y="' +
        (y - 4) +
        '" class="tt-hero-setup-lbl tt-hero-setup-lbl--' +
        lv.cls +
        '">' +
        escapeHtml(lv.label) +
        "</text>" +
        '<text x="240" y="' +
        (y + 4) +
        '" class="tt-hero-setup-val">$' +
        Number(lv.p).toFixed(2) +
        "</text>";
    });
    svg += "</svg>";
    return svg;
  }

  function setupHeroHtml(sym, plan, q) {
    const rr =
      plan.entry > plan.stop
        ? ((plan.target2 ?? plan.target) - plan.entry) / (plan.entry - plan.stop)
        : null;
    return (
      '<div class="tt-hero-card tt-hero-card--setup">' +
      '<header class="tt-hero-head tt-hero-head--setup">' +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">Morning setup</p>' +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(sym) +
      " trade plan</h3>" +
      '<p class="tt-hero-exchange">Levels drawn on chart — green entry — orange stop — cyan targets</p></div>' +
      (rr != null
        ? '<span class="tt-hero-rr-badge">' + rr.toFixed(1) + "R</span>"
        : "") +
      "</header>" +
      '<div class="tt-hero-setup-body">' +
      setupLadderSvg(plan, q?.bars) +
      '<div class="tt-hero-setup-levels">' +
      metricCell("Entry", "$" + Number(plan.entry).toFixed(2)) +
      metricCell("Stop", "$" + Number(plan.stop).toFixed(2)) +
      metricCell("Sell 1", "$" + Number(plan.target1 ?? plan.target).toFixed(2)) +
      metricCell("Sell 2", "$" + Number(plan.target2 ?? plan.target).toFixed(2)) +
      metricCell("Qty", String(plan.qty || 100)) +
      metricCell("R:R", (plan.rr ?? 2).toFixed(1) + "R") +
      "</div>" +
      (plan.entry > plan.stop
        ? (function () {
            const profit = Math.round(
              ((plan.target2 ?? plan.target) - plan.entry) * (plan.qty || 100)
            );
            const risk = Math.round((plan.entry - plan.stop) * (plan.qty || 100));
            return (
              '<p class="tt-hero-setup-stat">Proj profit $' +
              escapeHtml(String(profit)) +
              " &middot; Risk $" +
              escapeHtml(String(risk)) +
              "</p>"
            );
          })()
        : "") +
      "</div>" +
      backToOverviewLinkHtml() +
      "</div>"
    );
  }

  function signalHeroHtml(sym, meta, q) {
    const spark = sparklinePath(q?.bars, 320, 72);
    const src = meta?.signalSource || "macd_rsi";
    const isEma = src.startsWith("ema_");
    const title = meta?.title || sym + (isEma ? " EMA signal" : " buy signal");
    const up = q?.chg != null && Number(q.chg) >= 0;
    let kicker = "Buy flag";
    let exchange = sym + " · MACD + RSI · " + escapeHtml(meta?.time || "Intraday");
    let desc =
      meta?.desc ||
      "MACD histogram 2-bar pivot up with RSI oversold in the prior 4 bars.";
    let pills =
      '<span class="tt-hero-pill">Histogram pivot</span>' +
      '<span class="tt-hero-pill">RSI floor touch</span>' +
      '<span class="tt-hero-pill">Entry marker</span>';
    if (src === "ema_golden_cross") {
      kicker = "Golden cross";
      exchange = sym + " · EMA 9/21 · " + escapeHtml(meta?.time || "Intraday");
      desc = meta?.desc || "EMA 9 crossed above 21 in uptrend. Plan uses signal close, swing stop, 2R target.";
      pills =
        '<span class="tt-hero-pill">EMA cross</span>' +
        '<span class="tt-hero-pill">Uptrend filter</span>' +
        '<span class="tt-hero-pill">2R plan</span>';
    } else if (src === "ema_pullback_9" || src === "ema_pullback_21") {
      kicker = meta?.signalLabel || "Pullback buy";
      exchange = sym + " · EMA pullback · " + escapeHtml(meta?.time || "Intraday");
      desc =
        meta?.desc ||
        "Pullback to EMA with close confirmation. Plan uses signal close, swing stop, 2R target.";
      pills =
        '<span class="tt-hero-pill">Pullback</span>' +
        '<span class="tt-hero-pill">Swing stop</span>' +
        '<span class="tt-hero-pill">2R plan</span>';
    } else if (src === "ema_death_cross") {
      kicker = "Death cross";
      exchange = sym + " · EMA 9/21 · wait";
      desc = meta?.desc || "Bearish cross — visible for context. No short plan (long-first).";
      pills =
        '<span class="tt-hero-pill">Wait</span>' +
        '<span class="tt-hero-pill">No plan</span>' +
        '<span class="tt-hero-pill">Long-first</span>';
    }
    return (
      '<div class="tt-hero-card tt-hero-card--signal' +
      (isEma ? " tt-hero-card--ema" : "") +
      '">' +
      '<header class="tt-hero-head">' +
      '<div class="tt-hero-titles">' +
      '<p class="tt-hero-kicker">' +
      escapeHtml(kicker) +
      "</p>" +
      "<h3 class=\"tt-hero-title\">" +
      escapeHtml(title) +
      "</h3>" +
      '<p class="tt-hero-exchange">' +
      exchange +
      "</p></div>" +
      (q?.price != null
        ? '<div class="tt-hero-price-block ' +
          (up ? "tt-hero-price--up" : "tt-hero-price--down") +
          '"><span class="tt-hero-price">' +
          escapeHtml(fmtPrice(q.price)) +
          '</span><span class="tt-hero-chg">' +
          escapeHtml(fmtPct(q.chg)) +
          "</span></div>"
        : "") +
      "</header>" +
      (spark
        ? '<div class="tt-hero-chart-band"><svg class="tt-hero-spark" viewBox="0 0 320 72" preserveAspectRatio="none" aria-hidden="true"><path class="tt-hero-spark-fill" d="' +
          spark +
          ' L320,72 L0,72 Z"/><path class="tt-hero-spark-line" d="' +
          spark +
          '"/></svg></div>'
        : "") +
      '<article class="tt-hero-news tt-hero-news--signal">' +
      '<span class="tt-hero-news-icon" aria-hidden="true">&#9889;</span>' +
      '<p class="tt-hero-news-text">' +
      escapeHtml(desc) +
      "</p></article>" +
      '<div class="tt-hero-signal-pills">' +
      pills +
      "</div>" +
      backToOverviewLinkHtml() +
      "</div>"
    );
  }

  function buyMetaBanner(meta) {
    if (!meta?.desc && !meta?.title) return "";
    return (
      '<article class="tt-hero-news tt-hero-news--buy">' +
      '<span class="tt-hero-news-icon" aria-hidden="true">&#9889;</span>' +
      '<p class="tt-hero-news-text">' +
      escapeHtml(meta.desc || meta.title) +
      "</p>" +
      (meta.time
        ? '<p class="tt-hero-news-meta">Buy marker &middot; ' + escapeHtml(meta.time) + "</p>"
        : "") +
      "</article>"
    );
  }

  function idleHeroHtml() {
    const sym = resolveFocusSymbol();
    return (
      '<div class="tt-hero-card tt-hero-card--idle">' +
      '<p class="tt-hero-kicker">Results focus</p>' +
      "<h3 class=\"tt-hero-title\">" +
      (sym ? escapeHtml(sym) + " on chart" : "Pick a ticker on the chart") +
      "</h3>" +
      '<p class="tt-hero-idle-copy">Click a <strong>money bag</strong> for the ticker story, or the <strong>setup flag</strong> to see entry, stop, and targets visualized here.</p></div>'
    );
  }

  function showPlanSlot(on) {
    const slot = $("ttResultsPlanSlot");
    if (!slot) return;
    slot.classList.toggle("hidden", !on);
    slot.hidden = !on;
  }

  function safeQuoteFromChart(sym, bars, pick) {
    try {
      return quoteFromChart(sym, bars, pick);
    } catch {
      return null;
    }
  }

  async function renderTicker(sym, opts) {
    const inner = heroInner();
    if (!inner) return;
    currentSym = sym;
    setHeroMode("ticker");
    showPlanSlot(false);
    const pick = findPick(sym);
    const bars = chartBarsForSymbol(sym);
    const instant = safeQuoteFromChart(sym, bars, pick);
    if (hasQuoteData(instant)) {
      inner.innerHTML = tickerHeroHtml(sym, instant, opts);
    } else {
      inner.innerHTML =
        '<div class="tt-hero-loading">Loading ' + escapeHtml(sym) + "...</div>";
    }
    ctx.openResultsTab?.();
    try {
      const q = await loadQuote(sym);
      if (hasQuoteData(q)) {
        inner.innerHTML = tickerHeroHtml(sym, q, opts);
        return;
      }
      if (hasQuoteData(instant)) return;
      inner.innerHTML =
        '<div class="tt-hero-card tt-hero-card--error"><p>Loading tape for ' +
        escapeHtml(sym) +
        "... refresh chart or try again.</p></div>";
    } catch {
      const fallback = safeQuoteFromChart(sym, chartBarsForSymbol(sym), pick);
      if (hasQuoteData(fallback)) {
        inner.innerHTML = tickerHeroHtml(sym, fallback, opts);
        return;
      }
      if (hasQuoteData(instant)) return;
      inner.innerHTML =
        '<div class="tt-hero-card tt-hero-card--error"><p>Could not load quote for ' +
        escapeHtml(sym) +
        ".</p></div>";
    }
  }

  async function showTicker(symbol, opts) {
    const sym = resolveFocusSymbol(symbol);
    if (!sym) {
      showDefault();
      return;
    }
    if (isIndexSymbol(sym) && !opts?.scanning && !findPick(sym)) {
      requestOverviewRefresh({ soft: false });
      return;
    }
    await renderTicker(sym, opts);
  }

  async function showSetup(symbol, planOverride) {
    const focus =
      typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartFocusFromSelectKey
        ? global.RMHoldings.chartFocusFromSelectKey(symbol)
        : null;
    const symKey = focus?.selectKey || String(symbol || "").trim();
    const sym =
      focus?.symbol ||
      resolveChartSelectSymbol(symbol) ||
      String(symbol || "").toUpperCase();
    let plan = planOverride;
    if (!plan && typeof RMAnalysisChart !== "undefined") {
      plan = RMAnalysisChart.state?.tradePlan;
    }
    if (!plan?.symbol || (plan.symbol !== symKey && plan.symbol !== sym)) {
      if (typeof RMTradeFooter !== "undefined") {
        const pick = findPick(sym) || { symbol: sym, last: null };
        plan =
          RMTradeFooter.recommendMorningSetup?.(pick) ||
          RMTradeFooter.recommendPlan?.(pick);
      }
    }
    if (!plan) {
      await showTicker(sym);
      return;
    }
    const inner = heroInner();
    if (!inner) return;
    currentSym = sym;
    setHeroMode("setup");
    showPlanSlot(false);
    const bars = chartBarsForSymbol(sym);
    const instant = safeQuoteFromChart(sym, bars, findPick(sym));
    inner.innerHTML = setupHeroHtml(sym, plan, instant || { bars });
    ctx.openResultsTab?.();
    const q = await loadQuote(sym);
    if (hasQuoteData(q) || q?.bars?.length) {
      inner.innerHTML = setupHeroHtml(sym, plan, q);
    }
    if (typeof RMUiTips !== "undefined") RMUiTips.hide?.();
  }

  async function showBuySignal(symbol, meta) {
    const sym = String(symbol || resolveFocusSymbol() || "SPY").toUpperCase();
    const inner = heroInner();
    if (!inner) return;
    currentSym = sym;
    setHeroMode("signal");
    showPlanSlot(false);
    ctx.openResultsTab?.();
    const pick = findPick(sym);
    const bars = chartBarsForSymbol(sym);
    const instant = safeQuoteFromChart(sym, bars, pick);
    if (hasQuoteData(instant)) {
      inner.innerHTML = signalHeroHtml(sym, meta, instant);
    } else {
      inner.innerHTML =
        '<div class="tt-hero-loading">Loading ' + escapeHtml(sym) + " signal...</div>";
    }
    const q = await loadQuote(sym);
    if (hasQuoteData(q)) {
      inner.innerHTML = signalHeroHtml(sym, meta, q);
      return;
    }
    if (!hasQuoteData(instant)) {
      const fallback = safeQuoteFromChart(sym, chartBarsForSymbol(sym), pick);
      inner.innerHTML = signalHeroHtml(sym, meta, fallback || q);
    }
  }

  function showDefault() {
    const inner = heroInner();
    const hasDesk = !!inner?.querySelector(".rm-results-desk:not(.rm-results-desk--skeleton)");
    requestOverviewRefresh({ soft: hasDesk });
  }

  function configure(options) {
    ctx = { ...ctx, ...options };
  }

  let refreshHeroTimer = null;
  let overviewPollTimer = null;
  let chartBarsRefreshTimer = null;

  function resultsTabVisible() {
    const panel = $("scansTabResults");
    return panel && !panel.hidden;
  }

  function refreshHero() {
    if (mode === "setup" && currentSym) void showSetup(currentSym);
    else if (mode === "position") return;
    else if (mode === "ticker" && currentSym) void showTicker(currentSym);
    else if (mode === "overview" || mode === "idle") {
      requestOverviewRefresh({ soft: true });
    } else if (currentSym) void showTicker(currentSym);
    else requestOverviewRefresh({ soft: true });
  }

  function startOverviewPoll() {
    if (overviewPollTimer) return;
    overviewPollTimer = setInterval(() => {
      if (!resultsTabVisible()) return;
      if (mode === "overview") requestOverviewRefresh({ soft: true });
    }, 30000);
  }

  function stopOverviewPoll() {
    if (!overviewPollTimer) return;
    clearInterval(overviewPollTimer);
    overviewPollTimer = null;
  }

  function scheduleRefreshHero() {
    if (refreshHeroTimer) clearTimeout(refreshHeroTimer);
    refreshHeroTimer = setTimeout(() => {
      refreshHeroTimer = null;
      refreshHero();
    }, 180);
  }

  function scheduleOverviewFromChartBars() {
    if (!resultsTabVisible() || mode !== "overview") return;
    if (chartBarsRefreshTimer) return;
    chartBarsRefreshTimer = setTimeout(() => {
      chartBarsRefreshTimer = null;
      requestOverviewRefresh({ soft: true });
    }, 700);
  }

  function wire() {
    document.addEventListener("click", handleHeroActions);
    document.addEventListener("rm:results-hero", (e) => {
      const d = e.detail || {};
      if (d.mode === "setup") void showSetup(d.symbol, d.plan);
      else if (d.mode === "signal") void showBuySignal(d.symbol, d.meta);
      else if (d.mode === "overview") requestOverviewRefresh({ soft: false });
      else void showTicker(d.symbol, d.opts);
    });
    document.addEventListener("rm:results-tab-shown", () => {
      startOverviewPoll();
    });
    document.addEventListener("rm:auth-ready", () => {
      schwabStatusKnown = false;
      void ensureSchwabReadyForOverview();
    });
    document.addEventListener("rm:schwab-positions", () => {
      if (mode === "overview") requestOverviewRefresh({ soft: true });
    });
    document.addEventListener("rm:trade-closed", () => {
      if (mode === "overview") requestOverviewRefresh({ soft: true });
      else {
        refreshPerfStrip();
        refreshOpenRail();
      }
    });
    document.addEventListener("rm:notes-updated", () => {
      if (mode === "overview") requestOverviewRefresh({ soft: true });
    });
    document.addEventListener("rm:results-content-updated", () => {
      refreshPerfStrip();
      refreshOpenRail();
    });
    document.addEventListener("rm:trade-journey", (e) => {
      const d = e.detail || {};
      const sym = String(d.symbol || d.selectKey || "").trim();
      if (!sym) return;
      if (d.stage === "plan") {
        void showSetup(sym, d.plan);
        return;
      }
      if (d.stage === "open") {
        const trades = ctx.getTrades?.() || [];
        const open = trades.find(
          (t) =>
            t.status === "open" &&
            (t.symbol === sym ||
              String(t.symbol || "").toUpperCase() === sym.toUpperCase())
        );
        if (open) {
          void showOpenPosition({
            symbol: open.symbol,
            entry_price: open.entry_price ?? open.entry_premium,
            quantity: open.quantity ?? open.contracts,
            instrument: open.instrument || "stock",
            source: open.source || "journal",
          });
        } else {
          void showSetup(sym, d.plan);
        }
        return;
      }
      if (d.stage === "manage" && d.holding) {
        void showOpenPosition(d.holding);
        return;
      }
      if (d.stage === "close") {
        requestOverviewRefresh({ soft: true });
      }
    });
    document.addEventListener("rm:scan-ticker", (e) => {
      const sym = e.detail?.symbol;
      if (!sym) return;
      const panel = $("scansTabResults");
      if (panel?.hidden) return;
      void showTicker(sym, { scanning: true });
    });
    document.addEventListener("rm:chart-bars", () => {
      const panel = $("scansTabResults");
      if (!panel || panel.hidden) return;
    if (mode === "overview") scheduleOverviewFromChartBars();
      else if (mode !== "position") scheduleRefreshHero();
    });
  }

  wire();

  function prefetchQuote(sym) {
    const s = String(sym || "")
      .trim()
      .toUpperCase();
    if (!s) return Promise.resolve(null);
    const cached = quoteCache.get(s);
    if (cached && Date.now() - cached.at < 45000) return Promise.resolve(cached.data);
    if (prefetchInflight.has(s)) return prefetchInflight.get(s);
    const p = loadQuote(s)
      .catch(() => null)
      .finally(() => {
        prefetchInflight.delete(s);
      });
    prefetchInflight.set(s, p);
    return p;
  }

  global.RMResultsHero = {
    configure,
    showTicker,
    showSetup,
    showBuySignal,
    showOverview,
    showOpenPosition,
    showDefault,
    updateSchwabStatus,
    ensureSchwabReadyForOverview,
    resolveFocusSymbol,
    refresh: refreshHero,
    refreshOpenRail,
    refreshPerfStrip,
    renderCommandCenter,
    prefetchQuote,
  };
})(typeof window !== "undefined" ? window : globalThis);
