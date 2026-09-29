(function () {
  const STORAGE_KEY = "rainmaker_ytd_" + new Date().getFullYear();
  const WS_COL_TITLE = {
    market: "Morning Pulse",
    chart: "Shape of Data",
    scans: "Target Trades",
  };

  let session = null;
  let activePick = null;
  let activeHolding = null;
  let instrument = "stock";
  let newsScanRunning = false;
  let marketScanRunning = false;
  let pickChartObserver = null;
  let pickListScanningSym = null;
  let historySelection = null;
  const SCANS_TAB_KEY = "rainmaker_scans_tab_v1";
  const SCANS_DISMISSED_KEY = "rainmaker_scans_dismissed_v1";
  let scansTab = "results";
  let schwabClosedTrades = [];

  const $ = (id) => document.getElementById(id);

  function loadScansTabPref() {
    try {
      const t = localStorage.getItem(SCANS_TAB_KEY);
      if (t === "results" || t === "strategy") scansTab = t;
      else if (t === "scan") scansTab = "results";
    } catch {
      /* ignore */
    }
  }

  function saveScansTabPref() {
    try {
      localStorage.setItem(SCANS_TAB_KEY, scansTab);
    } catch {
      /* ignore */
    }
  }

  function setScansTab(tab, opts) {
    const next = tab === "strategy" ? "strategy" : "results";
    scansTab = next;
    if (!opts?.skipSave) saveScansTabPref();
    document.querySelectorAll("[data-scans-tab]").forEach((btn) => {
      const on = btn.dataset.scansTab === next;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const panels = {
      results: $("scansTabResults"),
      strategy: $("scansTabStrategy"),
    };
    Object.keys(panels).forEach((key) => {
      const el = panels[key];
      if (!el) return;
      const on = key === next;
      el.classList.toggle("hidden", !on);
      el.hidden = !on;
    });
    if (next === "strategy") {
      const afterLearning = () => {
        renderStrategyTemplatesTab();
        refreshStrategyLearning();
        if (typeof RMResearch !== "undefined" && RMResearch.run) RMResearch.run(false);
        if (typeof RMGreenLitPanel !== "undefined" && RMGreenLitPanel.render) RMGreenLitPanel.render();
      };
      if (typeof RMChunkLoader !== "undefined") {
        void RMChunkLoader.ensureLearning().then(afterLearning);
      } else {
        afterLearning();
      }
      if (opts?.viaScrollDown) {
        window._rmStrategyBurstEligible = true;
      } else {
        window._rmStrategyBurstEligible = false;
      }
      document.dispatchEvent(new CustomEvent("rm:strategy-tab-shown"));
      if (opts?.viaScrollDown) {
        const carry = Math.max(0, Number(opts.scrollCarryPx) || 0);
        const scrollStrategyTop = () => {
          const scroll = document.querySelector("#scansTabStrategy .tt-strategy-scroll");
          if (!scroll) return;
          const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          scroll.scrollTop = carry > 0 ? Math.min(max, carry) : 0;
        };
        requestAnimationFrame(() => requestAnimationFrame(scrollStrategyTop));
      }
    }
    if (next === "results") {
      window._rmStrategyBurstEligible = false;
      renderResultsTab();
      if (typeof RMResultsHero !== "undefined" && !opts?.skipHero) {
        RMResultsHero.showDefault();
      }
      document.dispatchEvent(new CustomEvent("rm:results-tab-shown"));
      const scrollResults = () => {
        const scroll = document.querySelector("#scansTabResults .tt-results-scroll");
        if (!scroll) return;
        if (opts?.viaScrollUp) {
          const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
          const carry = Math.max(0, Number(opts.scrollCarryPx) || 0);
          scroll.scrollTop = carry > 0 ? Math.max(0, max - carry) : max;
        } else {
          scroll.scrollTop = 0;
        }
      };
      if (opts?.viaScrollUp) {
        requestAnimationFrame(() => requestAnimationFrame(scrollResults));
      } else {
        requestAnimationFrame(scrollResults);
      }
    }
    updateResultsTabBadge();
  }

  function updateResultsTabBadge() {
    const btn = $("scansTabBtnResults");
    if (!btn) return;
    const n = session?.pick_count || session?.picks?.length || 0;
    const base = "Results";
    btn.textContent = n > 0 ? base + " · " + n : base;
  }

  function scansPanelDismissed() {
    try {
      return localStorage.getItem(SCANS_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setScansPanelDismissed(on) {
    const panel = $("workspaceScans");
    if (!panel) return;
    panel.classList.toggle("ws-panel--dismissed", !!on);
    panel.setAttribute("aria-hidden", on ? "true" : "false");
    try {
      if (on) localStorage.setItem(SCANS_DISMISSED_KEY, "1");
      else localStorage.removeItem(SCANS_DISMISSED_KEY);
    } catch {
      /* ignore */
    }
  }

  function clearScanSession() {
    session = null;
    activePick = null;
    historySelection = null;
    if (typeof RMChartHub !== "undefined") {
      RMChartHub.resetOverlays?.();
      RMChartHub.state.sessionPicks = [];
    }
    if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.state.symbol = "SPY";
      RMAnalysisChart.state.tradePlan = null;
      RMAnalysisChart.reload?.({ resetView: true });
    }
    setPickListHtml("");
    updateResultsActiveSection();
    if (typeof RMResultsHero !== "undefined") RMResultsHero.showDefault();
    renderCalendarUi(undefined, "drawer");
    renderCalendarUi(undefined, "results");
    refreshMarketAfterSessionClear();
    const picksHeading = $("picksHeading");
    if (picksHeading) picksHeading.textContent = WS_COL_TITLE.scans;
    setPageTitle("Rainmaker Morning");
    setHeaderMeta("");
    refreshScanButton();
  }

  function refreshMarketAfterSessionClear() {
    if (typeof RMMarket !== "undefined") {
      RMMarket.stopLivePickRefresh?.();
      const mp = $("marketPanel");
      if (mp) {
        void RMMarket.refreshMarketPanel(mp, [], { soft: false }).catch(() => {});
      }
    }
    const hi = $("marketHighlights");
    if (hi) {
      hi.innerHTML = "";
      hi.classList.add("hidden");
      hi.setAttribute("aria-hidden", "true");
    }
    refreshMarketThemes();
    refreshChartHub({ compare: false });
  }

  function dismissScansPanel() {
    clearScanSession();
    setScansTab("results");
    setScansPanelDismissed(true);
    status("Scan cleared · Target Trades hidden — use footer Import or Rainmaker scan");
    if (typeof RMWorkspaceAccordion !== "undefined") {
      RMWorkspaceAccordion.expand("chart");
    }
  }

  function showScansPanel() {
    setScansPanelDismissed(false);
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }

  function estimatePickPlan(p) {
    const entry = Number(p.last ?? p.open ?? p.price);
    if (!Number.isFinite(entry) || entry <= 0) return null;
    const stop = Math.round(entry * 0.98 * 100) / 100;
    const risk = entry - stop;
    const target = Math.round((entry + risk * 2) * 100) / 100;
    const qty = 100;
    const cost = entry * qty;
    const eodPct = Number(p.pct_eod ?? p.pct_change);
    const closePx = Number.isFinite(eodPct) ? entry * (1 + eodPct / 100) : null;
    const gainClose = closePx != null ? (closePx - entry) * qty : null;
    return { entry, stop, target, qty, cost, gainClose, eodPct };
  }

  function renderScanMetricsStrip() {
    const strip = $("scanMetricsStrip");
    if (!strip || !session?.picks?.length) {
      if (strip) strip.hidden = true;
      return;
    }
    const picks = sortPicksByGapUp(session.picks).slice(0, 12);
    let totalCost = 0;
    let totalGain = 0;
    let gainN = 0;
    let entrySum = 0;
    for (const p of picks) {
      const plan = estimatePickPlan(p);
      if (!plan) continue;
      entrySum += plan.entry;
      totalCost += plan.cost;
      if (plan.gainClose != null) {
        totalGain += plan.gainClose;
        gainN++;
      }
    }
    const avgEntry = picks.length ? entrySum / picks.length : null;
    const realized =
      typeof RMTradeMetrics !== "undefined"
        ? RMTradeMetrics.sessionStats(getTrades(), session.session_id)
        : null;
    strip.hidden = false;
    let html = "";
    if (realized) {
      html +=
        '<p class="tt-metrics-label">Realized · planned closes</p>' +
        '<div class="tt-metrics-grid tt-metrics-grid--realized">' +
        '<article class="tt-metric-card"><span class="tt-metric-kicker">Closed</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(String(realized.trades)) +
        '</strong><span class="tt-metric-sub">footer / drawer</span></article>' +
        '<article class="tt-metric-card"><span class="tt-metric-kicker">Expectancy</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(
          realized.avgR != null
            ? (realized.avgR >= 0 ? "+" : "") + realized.avgR.toFixed(2) + "R"
            : realized.pct + "%"
        ) +
        '</strong><span class="tt-metric-sub">' +
        escapeHtml(
          realized.avgR != null
            ? realized.wins + "/" + realized.trades + " winners"
            : "win rate (no stop data)"
        ) +
        "</span></article>" +
        '<article class="tt-metric-card"><span class="tt-metric-kicker">Total R</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(
          realized.totalR != null
            ? (realized.totalR >= 0 ? "+" : "") + realized.totalR.toFixed(2) + "R"
            : "—"
        ) +
        '</strong><span class="tt-metric-sub">sum of R-multiples</span></article>' +
        '<article class="tt-metric-card tt-metric-card--gain"><span class="tt-metric-kicker">P&amp;L</span>' +
        '<strong class="tt-metric-val">' +
        escapeHtml(fmtUsd(realized.totalPnl)) +
        '</strong><span class="tt-metric-sub">realized $</span></article></div>';
    }
    html +=
      '<p class="tt-metrics-label">' +
      (realized ? "Model · scan prices" : "Session model") +
      "</p>" +
      '<div class="tt-metrics-grid">' +
      '<article class="tt-metric-card"><span class="tt-metric-kicker">Session</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(String(session.pick_count || picks.length)) +
      '</strong><span class="tt-metric-sub">gap-up picks</span></article>' +
      '<article class="tt-metric-card"><span class="tt-metric-kicker">Avg entry</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(avgEntry != null ? fmtUsd(avgEntry) : "—") +
      '</strong><span class="tt-metric-sub">model @ last</span></article>' +
      '<article class="tt-metric-card"><span class="tt-metric-kicker">Cost @ 100 sh</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(fmtUsd(totalCost)) +
      '</strong><span class="tt-metric-sub">notional deploy</span></article>' +
      '<article class="tt-metric-card tt-metric-card--gain"><span class="tt-metric-kicker">Gain @ close</span>' +
      '<strong class="tt-metric-val">' +
      escapeHtml(gainN ? fmtUsd(totalGain) : "—") +
      '</strong><span class="tt-metric-sub">' +
      (gainN ? "sum EOD % × 100 sh" : "needs EOD %") +
      "</span></article></div>";
    strip.innerHTML = html;
  }

  function h001BacktestFootHtml(report) {
    if (!report?.summary) {
      return (
        '<span id="h001BacktestStat">Backtest · run on session picks</span>' +
        '<button type="button" class="btn-sm secondary" id="btnRunH001Backtest">Run backtest</button>'
      );
    }
    const s = report.summary;
    const avg =
      s.avgR != null
        ? (s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(2) + "R avg"
        : "no fills";
    const detail =
      s.n +
      " sim · " +
      s.hitTarget +
      " target · " +
      s.hitStop +
      " stop · " +
      s.noEntry +
      " no break";
    return (
      '<span id="h001BacktestStat">' +
      escapeHtml(avg) +
      " · " +
      escapeHtml(detail) +
      "</span>" +
      '<button type="button" class="btn-sm secondary" id="btnRunH001Backtest">Re-run</button>'
    );
  }

  function refreshStrategyBacktest() {
    const foot = $("h001BacktestFoot");
    if (!foot) return;
    const report =
      typeof RMBacktestH001 !== "undefined"
        ? RMBacktestH001.loadReport(backtestScopeId())
        : null;
    foot.innerHTML = h001BacktestFootHtml(report);
    $("btnRunH001Backtest")?.addEventListener("click", () => void runAllChartStrategyBacktests());
  }

  function renderCalibrationPanel() {
    const panel = $("ttCalibrationPanel");
    if (!panel || typeof RMCalibration === "undefined") return;
    const backtestRaw =
      typeof RMBacktestH001 !== "undefined"
        ? RMBacktestH001.loadReport(backtestScopeId())
        : null;
    panel.innerHTML =
      '<h4 class="tt-learning-title">Scanner calibration</h4>' +
      '<p class="meta">RM decile vs 1R hit rate — compare backtest simulation to live planned closes.</p>' +
      RMCalibration.renderPanel(session?.picks, backtestRaw, getTrades());
  }

  function renderMonthlyReviewPanel() {
    const panel = $("ttMonthlyReviewPanel");
    if (!panel || typeof RMMonthlyReview === "undefined") return;
    const backtestRaw =
      typeof RMBacktestH001 !== "undefined"
        ? RMBacktestH001.loadReport(backtestScopeId())
        : null;
    const m = RMMonthlyReview.autoMetrics(getTrades, session, backtestRaw);
    const driftWarn =
      m.driftR != null && Math.abs(m.driftR) >= 0.5
        ? '<p class="tt-review-warn">Drift live−backtest ' +
          (m.driftR >= 0 ? "+" : "") +
          m.driftR.toFixed(2) +
          "R — review assumptions before changing weights.</p>"
        : "";
    const drafts = RMMonthlyReview.loadDrafts();
    const draftOpts = drafts
      .map(
        (d) =>
          '<option value="' +
          escapeHtml(d.id) +
          '">' +
          escapeHtml(d.month || d.saved_at?.slice(0, 10) || d.id) +
          "</option>"
      )
      .join("");
    panel.innerHTML =
      '<h4 class="tt-learning-title">Monthly review</h4>' +
      '<p class="meta">One documented change per month → paste into <code>DECISIONS.log.md</code>.</p>' +
      driftWarn +
      '<div class="tt-review-metrics">' +
      '<span>Backtest: ' +
      escapeHtml(
        m.backtestAvgR != null
          ? (m.backtestAvgR >= 0 ? "+" : "") + m.backtestAvgR.toFixed(2) + "R (N=" + m.backtestN + ")"
          : "—"
      ) +
      "</span>" +
      '<span>Live: ' +
      escapeHtml(
        m.liveAvgR != null
          ? (m.liveAvgR >= 0 ? "+" : "") + m.liveAvgR.toFixed(2) + "R (N=" + m.liveN + ")"
          : "—"
      ) +
      "</span></div>" +
      (m.calibrationNote
        ? '<p class="meta tt-review-cal">' + escapeHtml(m.calibrationNote) + "</p>"
        : "") +
      '<label class="tt-review-field"><span>Decision (one change)</span>' +
      '<textarea id="reviewDecision" rows="3" placeholder="e.g. Raise RM gate to ≥55 — RM 50–69 band underperformed in live closes."></textarea></label>' +
      '<label class="tt-review-field"><span>After change (optional)</span>' +
      '<input type="text" id="reviewAfter" placeholder="e.g. Re-run backtest next session; target +0.3R avg" /></label>' +
      '<div class="tt-review-actions">' +
      '<button type="button" class="btn-sm primary" id="btnCopyReview">Copy DECISIONS entry</button>' +
      '<button type="button" class="btn-sm secondary" id="btnCopySetupCalib">Copy setup weight proposal</button>' +
      '<button type="button" class="btn-sm secondary" id="btnSaveReviewDraft">Save draft</button>' +
      (drafts.length
        ? '<select id="reviewDraftPick" class="tt-review-select"><option value="">Load draft…</option>' +
          draftOpts +
          "</select>"
        : "") +
      "</div>" +
      '<pre id="reviewPreview" class="tt-review-preview hidden" aria-live="polite"></pre>';
    $("btnCopyReview")?.addEventListener("click", () => copyMonthlyReviewEntry(m));
    $("btnCopySetupCalib")?.addEventListener("click", () => copySetupCalibrationEntry());
    $("btnSaveReviewDraft")?.addEventListener("click", () => saveMonthlyReviewDraft(m));
    $("reviewDraftPick")?.addEventListener("change", (e) => {
      const id = e.target.value;
      if (!id) return;
      const d = drafts.find((x) => x.id === id);
      if (d?.decision) $("reviewDecision").value = d.decision;
      if (d?.changeAfter) $("reviewAfter").value = d.changeAfter;
    });
  }

  function reviewFormValues() {
    return {
      decision: ($("reviewDecision")?.value || "").trim(),
      changeAfter: ($("reviewAfter")?.value || "").trim(),
    };
  }

  async function copySetupCalibrationEntry() {
    if (typeof RMMonthlyReview === "undefined" || !RMMonthlyReview.buildSetupCalibrationMarkdown) {
      status("Setup calibration unavailable");
      return;
    }
    const md = RMMonthlyReview.buildSetupCalibrationMarkdown(getTrades, {
      month: RMMonthlyReview.monthKey(),
    });
    const preview = $("reviewPreview");
    if (preview) {
      preview.textContent = md;
      preview.classList.remove("hidden");
    }
    const ok = await RMMonthlyReview.copyMarkdown(md);
    status(ok ? "Setup weight proposal copied" : "Copy failed — see preview below");
  }

  async function copyMonthlyReviewEntry(metrics) {
    if (typeof RMMonthlyReview === "undefined") return;
    const form = reviewFormValues();
    const md = RMMonthlyReview.buildDecisionsMarkdown({
      ...metrics,
      ...form,
      month: RMMonthlyReview.monthKey(),
    });
    const preview = $("reviewPreview");
    if (preview) {
      preview.textContent = md;
      preview.classList.remove("hidden");
    }
    const ok = await RMMonthlyReview.copyMarkdown(md);
    status(ok ? "DECISIONS entry copied — paste into DECISIONS.log.md" : "Copy failed — see preview below");
  }

  function saveMonthlyReviewDraft(metrics) {
    if (typeof RMMonthlyReview === "undefined") return;
    const form = reviewFormValues();
    RMMonthlyReview.saveDraft({
      month: RMMonthlyReview.monthKey(),
      ...metrics,
      ...form,
    });
    status("Review draft saved locally");
    renderMonthlyReviewPanel();
  }

  function refreshStrategyLearning(opts) {
    refreshStrategyCards();
    renderCalibrationPanel();
    renderMonthlyReviewPanel();
    if (!opts?.light && typeof scheduleChartStrategyBacktests === "function") {
      scheduleChartStrategyBacktests();
    }
  }

  let journeyFocus = null;

  function chartFocusCurrent() {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol) {
      const raw = RMAnalysisChart.state.symbol;
      if (typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromSelectKey) {
        return RMHoldings.chartFocusFromSelectKey(raw);
      }
    }
    if (activePick && typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromPick) {
      return RMHoldings.chartFocusFromPick(activePick);
    }
    return null;
  }

  function highlightJourneyOpenRow(detail) {
    const list = $("ttResultsOpenList");
    if (!list || !detail) return;
    list.querySelectorAll(".trade-item--active").forEach((el) => {
      el.classList.remove("trade-item--active");
    });
    const sym = String(detail.symbol || "")
      .trim()
      .toUpperCase();
    const selectKey = detail.selectKey;
    let row = null;
    if (selectKey) {
      row = list.querySelector(
        '[data-open-select-key="' + CSS.escape(String(selectKey)) + '"]'
      );
    }
    if (!row && sym) {
      row = [...list.querySelectorAll("[data-open-symbol]")].find(
        (el) =>
          String(el.getAttribute("data-open-symbol") || "")
            .trim()
            .toUpperCase() === sym
      );
    }
    if (row) row.classList.add("trade-item--active");
  }

  function dispatchTradeJourney(detail) {
    const focus = chartFocusCurrent();
    const sym =
      detail.symbol ||
      focus?.symbol ||
      focus?.displayKey ||
      (detail.selectKey ? String(detail.selectKey).toUpperCase() : null);
    const selectKey = detail.selectKey || focus?.selectKey || sym;
    const payload = {
      stage: detail.stage || "plan",
      symbol: sym,
      selectKey,
      plan: detail.plan,
      holding: detail.holding,
      source: detail.source || "app",
      ...detail,
    };
    if (payload.stage === "close") {
      journeyFocus = null;
      window.__rmJourneyFocus = null;
    } else {
      journeyFocus = { selectKey, symbol: sym, stage: payload.stage };
      window.__rmJourneyFocus = journeyFocus;
    }
    document.dispatchEvent(new CustomEvent("rm:trade-journey", { detail: payload }));
    if (payload.stage === "plan" || payload.stage === "close") {
      refreshStrategyLearning({ light: payload.stage === "plan" });
    }
    if (payload.stage === "open" || payload.stage === "plan") {
      highlightJourneyOpenRow(payload);
    }
  }

  window.dispatchTradeJourney = dispatchTradeJourney;
  window.chartFocusCurrent = chartFocusCurrent;

  let chartBtGen = 0;
  let chartBtTimer = null;
  let chartBtLastSym = "";

  function chartSymbolForBacktest() {
    if (typeof RMAnalysisChart === "undefined") return null;
    const raw = RMAnalysisChart.state?.symbol;
    if (!raw || raw === RMAnalysisChart.COMPARE_SYM) return null;
    if (typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolForSelectValue) {
      return RMHoldings.chartSymbolForSelectValue(raw) || null;
    }
    if (/^holding:/i.test(String(raw))) return null;
    return String(raw).toUpperCase();
  }

  function backtestScopeId() {
    const sym = chartSymbolForBacktest();
    if (sym) return "chart:" + sym;
    if (session?.session_id) return session.session_id;
    return "last";
  }

  function picksForBacktest() {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol === RMAnalysisChart.COMPARE_SYM) {
      return [];
    }
    const sym = chartSymbolForBacktest();
    if (sym) return [{ symbol: sym }];
    if (session?.picks?.length) return session.picks;
    return [];
  }

  function scheduleChartStrategyBacktests() {
    clearTimeout(chartBtTimer);
    chartBtTimer = setTimeout(() => {
      void runAllChartStrategyBacktests({ silent: true });
    }, 650);
  }

  async function runAllChartStrategyBacktests(opts) {
    if (typeof RMStrategies === "undefined" || typeof RMBacktestH001 === "undefined") return;
    const picks = picksForBacktest();
    const sym = picks[0]?.symbol;
    if (!picks.length || !sym) return;
    const live = RMStrategies.list().filter((s) => s.status === "live");
    if (!live.length) return;
    const gen = ++chartBtGen;
    if (!opts?.silent) status("Backtesting " + sym + " · " + live.length + " strategies…");
    for (const s of live) {
      if (gen !== chartBtGen) return;
      await runH001BacktestForSession(s.id, { silent: true, picks });
    }
    if (gen !== chartBtGen) return;
    refreshStrategyLearning();
    if (!opts?.silent) status("Strategy backtests updated · " + sym);
  }

  async function runH001BacktestForSession(strategyId, opts) {
    const picks = opts?.picks || picksForBacktest();
    if (!picks.length) {
      if (!opts?.silent) status("Select a symbol on the chart or load a scan to backtest");
      return;
    }
    const chartOnly = !!chartSymbolForBacktest() && picks.length === 1 && picks[0].symbol === chartSymbolForBacktest();
    const strat =
      typeof RMStrategies !== "undefined"
        ? typeof strategyId === "string"
          ? RMStrategies.get(strategyId)
          : RMStrategies.getActive()
        : null;
    const rr = strat?.rr ?? 2;
    const entryRule = strat?.entryRule || "orh";
    if (!opts?.silent) {
      status(
        "Backtest \u00b7 " +
          (strat?.name || "ORH") +
          (chartOnly ? " \u00b7 " + picks[0].symbol + " (chart)" : "") +
          " \u00b7 1mo \u00b7 5m \u00b7 fetching\u2026"
      );
    }
    try {
      if (typeof RMBacktestH001 === "undefined") throw new Error("backtest module missing");
      const runFn = RMBacktestH001.runSessionPreferred || RMBacktestH001.runSession;
      let report;
      let offline = false;
      if (RMBacktestH001.runSessionPreferred) {
        const out = await RMBacktestH001.runSessionPreferred(picks, {
          sessionId: backtestScopeId(),
          limit: 8,
          rr,
          entryRule,
          strategyId: strat?.id,
          range: "1mo",
          interval: "5m",
        });
        report = out.report;
        offline = out.offline;
      } else {
        report = await runFn(picks, {
          sessionId: backtestScopeId(),
          limit: 8,
          rr,
          entryRule,
          strategyId: strat?.id,
        });
      }
      if (!opts?.silent) refreshStrategyLearning();
      const s = report.summary;
      const symCount =
        report.symbolCount ??
        new Set((report.results || []).map((r) => r.symbol).filter(Boolean)).size;
      const tradeLabel = (s.n || 0) + " trade" + (s.n === 1 ? "" : "s");
      const symLabel = symCount + " symbol" + (symCount === 1 ? "" : "s");
      if (!opts?.silent) {
        status(
          (offline ? "Backtest (offline, today only) \u00b7 " : "Backtest done \u00b7 ") +
            (s.avgR != null ? (s.avgR >= 0 ? "+" : "") + s.avgR.toFixed(2) + "R avg" : "no entries") +
            " (" +
            tradeLabel +
            " \u00b7 " +
            symLabel +
            ")"
        );
      }
      return report;
    } catch (e) {
      if (!opts?.silent) status("Backtest error: " + (e.message || e));
      throw e;
    }
  }

  function fmtRr(rr) {
    return Number.isInteger(rr) ? String(rr) : Number(rr).toFixed(1);
  }

  // 2-state strategy board (item 18, mirrors the news list<->full pattern): the
  // Scan>Strategy tab shows a card list by default; clicking a card opens a full
  // detail view; "Back" returns to the list. No middle/preview state.
  let strategyDetailId = null;

  function strategyPerfLabel(perf) {
    if (!perf || perf.n == null || perf.n === 0) return null;
    const parts = [];
    if (perf.avgR != null) parts.push((perf.avgR >= 0 ? "+" : "") + perf.avgR.toFixed(2) + "R");
    if (perf.winRate != null) parts.push(perf.winRate + "% win");
    parts.push(perf.n + " trade" + (perf.n === 1 ? "" : "s"));
    return parts.join(" \u00b7 ");
  }

  function strategyCardHtml(s, activeId, perf) {
    const isActive = s.id === activeId;
    const live = s.status === "live";
    const rrLabel = "R:R " + fmtRr(s.rr) + ":1";
    const rules = (s.rules || []).map((r) => "<li>" + escapeHtml(r) + "</li>").join("");
    let foot;
    if (!live) {
      foot = '<span class="tt-strategy-perf tt-strategy-perf--soon">Coming soon</span>';
    } else {
      const label = strategyPerfLabel(perf);
      const perfSpan =
        '<span class="tt-strategy-perf' +
        (label ? " tt-strategy-perf--has" : "") +
        '">' +
        (label ? escapeHtml(label) : "Backtest to score") +
        "</span>";
      const useBtn = isActive
        ? '<button type="button" class="btn-sm tt-strat-use is-active" disabled>Active</button>'
        : '<button type="button" class="btn-sm tt-strat-use" data-strat-use="' +
          s.id +
          '">Use</button>';
      const btBtn =
        '<button type="button" class="btn-sm secondary" data-strat-backtest="' +
        s.id +
        '">Backtest</button>';
      foot = perfSpan + '<span class="tt-strategy-foot-actions">' + useBtn + btBtn + "</span>";
    }
    return (
      '<article class="tt-strategy-card' +
      (isActive ? " tt-strategy-card--active" : "") +
      (live ? "" : " tt-strategy-card--soon") +
      '" data-strat-id="' +
      s.id +
      '">' +
      '<header class="tt-strategy-card-head"><span class="tt-strategy-badge">' +
      escapeHtml(s.badge) +
      '</span><span class="tt-strategy-risk">' +
      rrLabel +
      "</span></header>" +
      "<h4>" +
      escapeHtml(s.name) +
      "</h4>" +
      '<p class="meta">' +
      escapeHtml(s.summary) +
      "</p>" +
      (rules ? '<ul class="tt-strategy-rules">' + rules + "</ul>" : "") +
      '<footer class="tt-strategy-foot">' +
      foot +
      "</footer></article>"
    );
  }

  // Persona + Setup context for the Scan>Strategy tab (item 13). The OOTB setup
  // is "Rainmaker Morning Momentum" (the H-001 active strategy). Persona is
  // switchable and remembered via RMStrategies.setPersona.
  function strategyPersonaBarHtml(active) {
    if (typeof RMStrategies?.getPersona !== "function") return "";
    const persona = RMStrategies.getPersona();
    const personaList = RMStrategies.personas ? RMStrategies.personas() : [];
    const opts = personaList
      .map(
        (p) =>
          '<option value="' +
          escapeHtml(p.id) +
          '"' +
          (p.id === persona.id ? " selected" : "") +
          (p.status !== "live" ? " disabled" : "") +
          ">" +
          escapeHtml(p.name) +
          (p.status !== "live" ? " (soon)" : "") +
          "</option>"
      )
      .join("");
    const setupName = active?.id === RMStrategies.DEFAULT_ACTIVE_ID ? "Rainmaker Morning Momentum" : active?.name;
    return (
      '<div class="tt-persona-bar">' +
      '<label class="tt-persona-field"><span class="tt-persona-label">Persona</span>' +
      '<select class="tt-persona-select" data-persona-select>' +
      opts +
      "</select></label>" +
      '<div class="tt-persona-field"><span class="tt-persona-label">Setup</span>' +
      '<span class="tt-persona-setup">' +
      escapeHtml(setupName || "\u2014") +
      "</span></div>" +
      "</div>"
    );
  }

  function strategyDetailHtml(s, activeId, perf) {
    const isActive = s.id === activeId;
    const live = s.status === "live";
    const rules = (s.rules || []).map((r) => "<li>" + escapeHtml(r) + "</li>").join("");
    const label = live ? strategyPerfLabel(perf) : null;
    const useBtn = !live
      ? '<span class="tt-strategy-perf tt-strategy-perf--soon">Coming soon</span>'
      : isActive
        ? '<button type="button" class="btn-sm tt-strat-use is-active" disabled>Active</button>'
        : '<button type="button" class="btn-sm tt-strat-use" data-strat-use="' +
          s.id +
          '">Use this strategy</button>';
    const btBtn = live
      ? '<button type="button" class="btn-sm secondary" data-strat-backtest="' + s.id + '">Backtest</button>'
      : "";
    // Item 14: desktop-only "learn" affordance - a data-bearing element that can
    // push itself into the Results hero scan tab. Mobile flow deferred.
    const isDesktop =
      typeof global.matchMedia === "function" ? global.matchMedia("(min-width: 641px)").matches : true;
    const heroBtn =
      live && isDesktop
        ? '<button type="button" class="btn-sm tt-strat-learn" data-strat-hero="' +
          s.id +
          '">\u26a1 Preview in hero</button>'
        : "";
    return (
      '<div class="tt-strategy-detail" data-strat-id="' +
      s.id +
      '">' +
      '<button type="button" class="tt-strategy-back" data-strat-back="1">\u2190 All strategies</button>' +
      '<header class="tt-strategy-detail-head">' +
      '<span class="tt-strategy-badge">' +
      escapeHtml(s.badge) +
      "</span>" +
      "<h3>" +
      escapeHtml(s.name) +
      "</h3>" +
      '<span class="tt-strategy-risk">R:R ' +
      fmtRr(s.rr) +
      ":1</span>" +
      "</header>" +
      '<p class="tt-strategy-detail-summary">' +
      escapeHtml(s.summary) +
      "</p>" +
      (label
        ? '<p class="tt-strategy-perf tt-strategy-perf--has">' + escapeHtml(label) + "</p>"
        : live
          ? '<p class="meta">Runs automatically for the chart symbol · tap Backtest to refresh.</p>'
          : "") +
      (rules ? '<ul class="tt-strategy-rules tt-strategy-rules--detail">' + rules + "</ul>" : "") +
      '<footer class="tt-strategy-detail-foot">' +
      useBtn +
      btBtn +
      heroBtn +
      "</footer>" +
      "</div>"
    );
  }

  function strategyBacktestMetaHtml() {
    const sym = chartSymbolForBacktest();
    const label = sym || (session?.picks?.length ? "session picks" : "\u2014");
    return (
      '<div class="tt-strategy-bt-meta">' +
      '<span class="meta">Backtests follow the chart' +
      (sym ? " · <strong>" + escapeHtml(sym) + "</strong>" : "") +
      " · auto-refresh on load</span>" +
      '<button type="button" class="btn-sm secondary" id="btnRefreshChartBacktests">Refresh</button>' +
      "</div>"
    );
  }

  function renderStrategyTemplatesTab() {
    const root = $("pickListStrategy");
    if (!root || typeof RMStrategies === "undefined") return;
    const scope = backtestScopeId();
    const active = RMStrategies.getActive();
    // Detail (full) state: a single strategy expanded with a Back button.
    if (strategyDetailId) {
      const s = RMStrategies.get(strategyDetailId);
      if (s) {
        const report =
          typeof RMBacktestH001 !== "undefined" && s.status === "live"
            ? RMBacktestH001.loadReport(scope, s.id)
            : null;
        const perf = typeof RMStrategies.perfFor === "function" ? RMStrategies.perfFor(s, report) : null;
        root.innerHTML = strategyDetailHtml(s, active.id, perf);
        bindStrategyBoard(root);
        return;
      }
      strategyDetailId = null;
    }
    const ranked =
      typeof RMBacktestH001 !== "undefined"
        ? RMStrategies.rankRecommended(RMBacktestH001.loadReport, scope)
        : RMStrategies.recommended().map((s) => ({ strategy: s, perf: null }));
    const cards = ranked
      .map(({ strategy, perf }) => strategyCardHtml(strategy, active.id, perf))
      .join("");
    root.innerHTML =
      strategyPersonaBarHtml(active) +
      strategyBacktestMetaHtml() +
      '<div class="tt-strategy-active">' +
      '<div class="tt-strategy-active-copy"><span class="tt-strategy-active-kicker">Active strategy</span>' +
      '<span class="tt-strategy-active-name">\u26a1 ' +
      escapeHtml(active.name) +
      " \u00b7 R:R " +
      fmtRr(active.rr) +
      ":1</span></div>" +
      '<span class="tt-strategy-active-hint">Drives the target-trade footer</span></div>' +
      '<div class="tt-strategy-section-head"><h3 class="tt-strategy-title">Recommended</h3>' +
      '<span class="meta">ORH / VWAP engines scored on chart symbol · 1mo when API is up · today-only offline fallback.</span></div>' +
      '<div class="tt-strategy-grid">' +
      cards +
      "</div>" +
      '<div class="tt-strategy-section-head"><h3 class="tt-strategy-title">My strategies</h3></div>' +
      '<div class="tt-strategy-mine">' +
      '<p class="meta">Build your own from a template or a prompt \u2014 coming soon.</p>' +
      '<button type="button" class="btn-sm secondary" data-strat-new="1">+ New strategy</button>' +
      "</div>" +
      setupAttributionSectionHtml(active.id);
    bindStrategyBoard(root);
  }

  function setupAttributionSectionHtml(playId) {
    if (typeof RMSetupAttribution === "undefined") {
      return "";
    }
    const report = RMSetupAttribution.buildReport(getTrades(), { play_id: playId });
    return RMSetupAttribution.renderWinnersTable(report);
  }

  function bindStrategyBoard(root) {
    if (!root) return;
    if (root._stratChange) root.removeEventListener("change", root._stratChange);
    root._stratChange = (e) => {
      const sel = e.target.closest("[data-persona-select]");
      if (!sel) return;
      if (RMStrategies.setPersona(sel.value)) {
        const p = RMStrategies.getPersona();
        status("Persona \u2192 " + p.name);
      } else {
        status("That persona isn\u2019t available yet");
      }
      renderStrategyTemplatesTab();
    };
    root.addEventListener("change", root._stratChange);
    if (root._stratClick) root.removeEventListener("click", root._stratClick);
    root._stratClick = (e) => {
      if (e.target.closest("#btnRefreshChartBacktests")) {
        void runAllChartStrategyBacktests();
        return;
      }
      if (e.target.closest("[data-strat-back]")) {
        strategyDetailId = null;
        renderStrategyTemplatesTab();
        return;
      }
      const useId = e.target.closest("[data-strat-use]")?.dataset.stratUse;
      if (useId) return useStrategy(useId);
      const btId = e.target.closest("[data-strat-backtest]")?.dataset.stratBacktest;
      if (btId) return void runH001BacktestForSession(btId);
      const heroId = e.target.closest("[data-strat-hero]")?.dataset.stratHero;
      if (heroId) return previewStrategyInHero(heroId);
      if (e.target.closest("[data-strat-new]")) {
        status("Custom strategies \u2014 coming soon");
        return;
      }
      const card = e.target.closest(".tt-strategy-card[data-strat-id]");
      if (card) {
        strategyDetailId = card.dataset.stratId;
        renderStrategyTemplatesTab();
      }
    };
    root.addEventListener("click", root._stratClick);
  }

  // Item 14: make the strategy "alive" - set it active and push the resolved
  // focus symbol into the Results hero (which opens the Results tab).
  function previewStrategyInHero(id) {
    if (typeof RMStrategies === "undefined") return;
    RMStrategies.setActive(id);
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh();
    const hero = global.RMResultsHero;
    if (!hero || typeof hero.showSetup !== "function") {
      status("Hero preview unavailable");
      return;
    }
    let sym = "";
    try {
      sym = hero.resolveFocusSymbol ? hero.resolveFocusSymbol() : "";
    } catch (_) {}
    if (!sym) sym = (session?.picks && session.picks[0]?.symbol) || "SPY";
    void hero.showSetup(sym);
    const s = RMStrategies.get(id);
    status("Previewing " + (s ? s.name : "strategy") + " in hero \u2192 " + sym);
  }

  function useStrategy(id) {
    if (typeof RMStrategies === "undefined") return;
    if (!RMStrategies.setActive(id)) {
      status("That strategy isn\u2019t available yet");
      return;
    }
    renderStrategyTemplatesTab();
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh();
    const s = RMStrategies.getActive();
    status("Active strategy \u2192 " + s.name + " (R:R " + fmtRr(s.rr) + ":1)");
  }

  function refreshStrategyCards() {
    if (!$("scansTabStrategy")?.hidden) renderStrategyTemplatesTab();
  }

  let publishedSessionCache = null;
  let publishedSessionCacheDone = false;

  async function getPublishedSessionOffer() {
    if (publishedSessionCacheDone) return publishedSessionCache;
    publishedSessionCacheDone = true;
    publishedSessionCache = await fetchPublishedSession();
    return publishedSessionCache;
  }

  function publishedEntryHtml(data) {
    if (!data?.picks?.length) return "";
    const label = (data.scanned_at || "").slice(0, 16).replace("T", " ") || "Published";
    return (
      '<button type="button" class="calendar-entry calendar-entry--published" id="ttLoadPublishedScan">' +
      '<span class="cal-entry-kind">Published</span> ' +
      escapeHtml(label) +
      " · " +
      (data.pick_count || data.picks.length) +
      " picks · session.json" +
      '<span class="cal-entry-hint">Tap to load into Results</span></button>'
    );
  }

  function bindPublishedEntry() {
    $("ttLoadPublishedScan")?.addEventListener("click", () => loadPublishedSessionInteractive());
  }

  function renderResultsTab() {
    updateResultsActiveSection();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    renderCalibrationPanel();
    renderMonthlyReviewPanel();
    document.dispatchEvent(new CustomEvent("rm:results-content-updated"));
    /* Hero is driven by RMResultsHero (setScansTab / chart clicks), not reset here. */
  }

  function collectOpenPositionRows() {
    const rows = [];
    const seen = new Set();
    const display =
      typeof RMHoldings !== "undefined" && RMHoldings.getDisplayOpen
        ? RMHoldings.getDisplayOpen()
        : [];
    display.forEach((h) => {
      const sym = String(h.symbol || "").toUpperCase();
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      rows.push({ kind: "holding", holding: h, symbol: sym });
    });
    getTrades()
      .filter((t) => t && t.status === "open")
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(b.opened_at || "") || 0) - (Date.parse(a.opened_at || "") || 0)
      )
      .forEach((t) => {
        const sym = String(t.symbol || "").toUpperCase();
        if (!sym || seen.has(sym)) return;
        seen.add(sym);
        rows.push({ kind: "journal", trade: t, symbol: sym });
      });
    return rows;
  }

  function openRowDisplaySym(sym) {
    if (
      typeof RMHoldings !== "undefined" &&
      RMHoldings.isOptionSymbol?.(sym) &&
      RMHoldings.formatOptionLabel
    ) {
      return RMHoldings.formatOptionLabel(sym);
    }
    return sym;
  }

  function openRowPnlSpan(holdingOrTrade, kind) {
    let pnl = null;
    if (kind === "holding" && typeof RMHoldings !== "undefined" && RMHoldings.openPositionPnl) {
      pnl = RMHoldings.openPositionPnl(holdingOrTrade);
    }
    if (pnl == null || pnl.dollars == null) return "";
    const cls = pnl.dollars >= 0 ? "rm-open-pnl--pos" : "rm-open-pnl--neg";
    const sign = pnl.dollars >= 0 ? "+" : "";
    return (
      '<span class="rm-open-row-pnl rm-open-pnl ' +
      cls +
      '">' +
      sign +
      fmtUsd(pnl.dollars) +
      "</span>"
    );
  }

  function renderOpenPositionRow(row) {
    const sym = row.symbol;
    const title = escapeHtml(openRowDisplaySym(sym));
    let rowId = "";
    let selectKey = sym;
    let meta = "";
    let pnl = "";

    if (row.kind === "holding") {
      const h = row.holding;
      rowId = h.id || "";
      selectKey =
        typeof RMHoldings !== "undefined" && RMHoldings.holdingSelectValue
          ? RMHoldings.holdingSelectValue(h)
          : sym;
      const isOpt =
        h.instrument === "option" ||
        (typeof RMHoldings !== "undefined" && RMHoldings.isOptionSymbol?.(sym));
      const parts = [];
      const qty = Math.abs(Number(h.quantity) || 0);
      if (qty) parts.push(qty + (isOpt ? " ct" : " sh"));
      if (h.entry_price != null) {
        parts.push("avg $" + Number(h.entry_price).toFixed(2) + (isOpt ? " prem" : ""));
      }
      meta = escapeHtml(parts.join(" · "));
      pnl = openRowPnlSpan(h, "holding");
    } else {
      const t = row.trade;
      rowId = t.id || "";
      const isOpt = t.instrument === "option";
      const parts = [];
      const entry = isOpt ? t.entry_premium ?? t.entry_price : t.entry_price;
      if (entry != null) {
        parts.push("entry $" + Number(entry).toFixed(2) + (isOpt ? " prem" : ""));
      }
      const when = (t.opened_at || "").slice(0, 10);
      if (when) parts.push(when);
      meta = escapeHtml(parts.join(" · "));
    }

    return (
      '<div class="rm-open-row trade-item trade-item--click" data-open-row-id="' +
      escapeHtml(rowId) +
      '" data-open-kind="' +
      escapeHtml(row.kind) +
      '" data-open-symbol="' +
      escapeHtml(sym) +
      '" data-open-select-key="' +
      escapeHtml(selectKey) +
      '" role="button" tabindex="0" title="Show on chart">' +
      '<div class="rm-open-row-head">' +
      '<span class="rm-open-row-title">' +
      title +
      "</span>" +
      pnl +
      "</div>" +
      (meta ? '<div class="rm-open-row-meta">' + meta + "</div>" : "") +
      "</div>"
    );
  }

  function renderResultsOpenTrades() {
    if (typeof RMResultsHero !== "undefined" && RMResultsHero.refreshOpenRail) {
      RMResultsHero.refreshOpenRail();
    }
    if (journeyFocus) highlightJourneyOpenRow(journeyFocus);
  }

  function resolveOpenRowHolding(rowEl) {
    const kind = rowEl.getAttribute("data-open-kind");
    const rowId = rowEl.getAttribute("data-open-row-id");
    const rowSym = rowEl.getAttribute("data-open-symbol");
    if (kind === "holding" && typeof RMHoldings !== "undefined") {
      const rows = RMHoldings.getDisplayOpen?.() || [];
      if (rowId) {
        const hit =
          rows.find((h) => String(h.id) === String(rowId)) ||
          rows.find((h) => String(h.id).toLowerCase() === String(rowId).toLowerCase());
        if (hit) return hit;
      }
      if (rowSym) {
        const symKey = String(rowSym).trim().toUpperCase();
        const hit = rows.find((h) => String(h.symbol || "").trim().toUpperCase() === symKey);
        if (hit) return hit;
      }
    }
    if (kind === "journal" && rowId) {
      const t = getTrades().find((x) => String(x.id) === String(rowId));
      if (!t) return null;
      return {
        id: t.id,
        symbol: t.symbol,
        instrument: t.instrument || "stock",
        entry_price: t.entry_premium ?? t.entry_price,
        quantity: t.quantity,
        source: t.source || "journal",
        status: "open",
      };
    }
    return null;
  }

  function focusOpenPositionOnChart(h) {
    if (!h?.symbol) return;
    showScansPanel();
    if (scansTab !== "results") setScansTab("results", { skipHero: true });
    void openHoldingOnChart(h);
  }

  function initOpenListDelegation() {
    const list = $("ttResultsOpenList");
    if (!list || list.dataset.openWired === "1") return;
    list.dataset.openWired = "1";
    list.addEventListener("click", (ev) => {
      const row = ev.target.closest(".trade-item[data-open-row-id]");
      if (!row) return;
      const h = resolveOpenRowHolding(row);
      if (!h) return;
      list.querySelectorAll(".trade-item--active").forEach((el) => {
        el.classList.remove("trade-item--active");
      });
      row.classList.add("trade-item--active");
      focusOpenPositionOnChart(h);
    });
    list.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".trade-item[data-open-row-id]");
      if (!row) return;
      ev.preventDefault();
      row.click();
    });
  }

  function tradeRMultiple(t) {
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.rMultiple) {
      const r = RMTradeMetrics.rMultiple(t);
      return r != null && Number.isFinite(r) ? r : null;
    }
    return t.r_multiple != null && Number.isFinite(t.r_multiple) ? t.r_multiple : null;
  }

  function tradePnl(t) {
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.pnlUsd) {
      const p = RMTradeMetrics.pnlUsd(t);
      return p != null && Number.isFinite(p) ? p : null;
    }
    return t.pnl_usd != null && Number.isFinite(t.pnl_usd) ? t.pnl_usd : null;
  }

  function computeJournalStats(trades) {
    const closed = (trades || [])
      .filter((t) => t && t.status === "closed" && t.filled !== false)
      .slice()
      .sort(
        (a, b) =>
          (Date.parse(a.closed_at || a.opened_at || "") || 0) -
          (Date.parse(b.closed_at || b.opened_at || "") || 0)
      );
    let wins = 0;
    let winN = 0;
    let rSum = 0;
    let rN = 0;
    let pnl = 0;
    let pnlSeen = false;
    let cum = 0;
    const equity = [];
    for (const t of closed) {
      const r = tradeRMultiple(t);
      if (r != null) {
        cum += r;
        rSum += r;
        rN++;
        equity.push(Math.round(cum * 100) / 100);
      }
      const entry = t.entry_price ?? t.entry_premium;
      const exit = t.exit_price;
      if (entry != null && exit != null) {
        winN++;
        if (exit > entry) wins++;
      }
      const p = tradePnl(t);
      if (p != null) {
        pnl += p;
        pnlSeen = true;
      }
    }
    return {
      trades: closed.length,
      winPct: winN ? Math.round((wins / winN) * 100) : null,
      winN,
      wins,
      avgR: rN ? Math.round((rSum / rN) * 100) / 100 : null,
      totalR: rN ? Math.round(rSum * 100) / 100 : null,
      totalPnl: pnlSeen ? Math.round(pnl * 100) / 100 : null,
      equity,
    };
  }

  function equitySparklineSvg(values, w, h) {
    if (!values || values.length < 2) return "";
    const width = w || 200;
    const height = h || 40;
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);
    const y = (v) => height - ((v - min) / range) * height;
    const pts = values
      .map((v, i) => (i * stepX).toFixed(1) + "," + y(v).toFixed(1))
      .join(" ");
    const last = values[values.length - 1];
    const cls = last >= 0 ? "is-pos" : "is-neg";
    return (
      '<svg class="rm-equity ' +
      cls +
      '" viewBox="0 0 ' +
      width +
      " " +
      height +
      '" preserveAspectRatio="none" role="img" aria-label="Cumulative R equity curve">' +
      '<line class="rm-equity-zero" x1="0" y1="' +
      y(0).toFixed(1) +
      '" x2="' +
      width +
      '" y2="' +
      y(0).toFixed(1) +
      '"></line>' +
      '<polyline points="' +
      pts +
      '"></polyline>' +
      "</svg>"
    );
  }

  function renderResultsPerformance() {
    if (typeof RMResultsHero !== "undefined" && RMResultsHero.refreshPerfStrip) {
      RMResultsHero.refreshPerfStrip();
      return;
    }
    const el = $("ttResultsPerfStrip") || $("ttResultsPerf");
    if (!el) return;
    const s = computeJournalStats(getJournalTrades());
    if (!s.trades) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
  }

  function renderResultsClosedTrades() {
    renderResultsPerformance();
    const el = $("ttResultsClosedList");
    const meta = $("ttResultsClosedMeta");
    if (!el) return;
    const closed = getJournalTrades().filter((t) => t.status === "closed");
    if (!closed.length) {
      el.innerHTML =
        '<p class="cal-list-empty">No closed trades yet. Connect Schwab and sync fills, or close a setup in the footer.</p>';
      if (meta) meta.textContent = "";
      return;
    }
    const schwabN = closed.filter((t) => t.source === "schwab_api").length;
    const recentSchwabN =
      typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
        ? closed.filter((t) => RMSchwabData.isRecentSchwabClose(t)).length
        : 0;
    if (meta) {
      meta.textContent =
        closed.length +
        " closed · YTD log" +
        (schwabN ? " · " + schwabN + " from Schwab" : "") +
        (recentSchwabN ? " · " + recentSchwabN + " this week" : "");
    }
    const sorted = closed.slice().sort((a, b) => {
      const aRecent =
        typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
          ? RMSchwabData.isRecentSchwabClose(a)
          : false;
      const bRecent =
        typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
          ? RMSchwabData.isRecentSchwabClose(b)
          : false;
      if (aRecent !== bRecent) return aRecent ? -1 : 1;
      return (
        (Date.parse(b.closed_at || b.opened_at || "") || 0) -
        (Date.parse(a.closed_at || a.opened_at || "") || 0)
      );
    });
    el.innerHTML = sorted
      .map((t) => {
        const isOpt = t.instrument === "option";
        const isRecent =
          typeof RMSchwabData !== "undefined" && RMSchwabData.isRecentSchwabClose
            ? RMSchwabData.isRecentSchwabClose(t)
            : false;
        let line =
          "<strong>" +
          escapeHtml(t.symbol) +
          "</strong> " +
          escapeHtml(t.instrument || "stock");
        if (t.source === "schwab_api") line += ' <span class="rm-schwab-badge">Schwab</span>';
        if (isRecent) line += ' <span class="rm-debrief-recent-badge">This week</span>';
        const entry = isOpt ? t.entry_premium ?? t.entry_price : t.entry_price;
        const exit = isOpt ? t.exit_premium ?? t.exit_price : t.exit_price;
        if (entry != null) line += " · entry " + Number(entry).toFixed(2) + (isOpt ? " prem" : "");
        if (exit != null) line += " · exit " + Number(exit).toFixed(2) + (isOpt ? " prem" : "");
        const pr = typeof RMTradeMetrics !== "undefined" ? RMTradeMetrics.planR(t) : null;
        const rr =
          typeof RMTradeMetrics !== "undefined"
            ? RMTradeMetrics.realizedR(t) ?? tradeRMultiple(t)
            : tradeRMultiple(t);
        if (pr != null && rr != null && typeof RMTradeMetrics !== "undefined") {
          line +=
            ' · <span class="rm-dual-r">' +
            escapeHtml(RMTradeMetrics.fmtDualTrack(t)) +
            "</span>";
        } else if (rr != null) {
          line += " · " + (rr >= 0 ? "+" : "") + Number(rr).toFixed(2) + "R";
        } else if (!isPlannedTrade(t) && isOpt) {
          line += " · R N/A";
        }
        if (t.pnl_usd != null) line += " · " + fmtUsd(t.pnl_usd);
        const when = (t.closed_at || t.opened_at || "").slice(0, 10);
        if (when) line += " · " + escapeHtml(when);
        const debriefBtn =
          t.id &&
          ((isRecent && t.source === "schwab_api") ||
            (t.planned !== false && (t.source === "footer" || t.source === "dashboard")))
            ? ' <button type="button" class="btn-link rm-debrief-btn" data-debrief-id="' +
              escapeHtml(t.id || "") +
              '">What happened?</button>'
            : "";
        const rowClass =
          "trade-item trade-item--click" +
          (isRecent ? " trade-item--recent-schwab" : "");
        return (
          '<div class="' +
          rowClass +
          '" data-trade-id="' +
          escapeHtml(t.id || "") +
          '" role="button" tabindex="0" title="Show on chart">' +
          line +
          debriefBtn +
          "</div>"
        );
      })
      .join("");
    document.dispatchEvent(new CustomEvent("rm:results-closed-rendered"));
  }

  function isPlannedTrade(t) {
    return typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.isPlannedTrade
      ? RMTradeMetrics.isPlannedTrade(t)
      : t.planned !== false && t.source !== "schwab_api";
  }

  function updateResultsActiveSection() {
    const block = $("ttResultsActive");
    const title = $("ttResultsActiveTitle");
    const meta = $("ttResultsActiveMeta");
    if (!block) return;
    const has = !!(session?.picks?.length);
    block.classList.toggle("hidden", !has);
    block.hidden = !has;
    if (!has) {
      delete block.dataset.actionsWired;
      if ($("scanMetricsStrip")) {
        $("scanMetricsStrip").hidden = true;
        $("scanMetricsStrip").innerHTML = "";
      }
      updateResultsTabBadge();
      return;
    }
    const scanned = (session.scanned_at || "").slice(0, 16).replace("T", " ");
    if (title) {
      title.textContent = session.source_file || session.session_label || "Active scan";
    }
    if (meta) {
      meta.textContent =
        scanned +
        " · " +
        (session.pick_count || session.picks.length) +
        " picks · " +
        (session.source_kind || "scan");
    }
    renderScanMetricsStrip();
    updateResultsTabBadge();
    const active = $("ttResultsActive");
    if (active && active.dataset.actionsWired !== "1") {
      active.dataset.actionsWired = "1";
      $("btnResultsCompare")?.addEventListener("click", () => {
        if (typeof RMChartHub === "undefined" || !session?.picks?.length) return;
        void RMChartHub.syncFromSession(session.picks).then(() => {
          if (typeof RMAnalysisChart !== "undefined") {
            RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
            if (RMAnalysisChart.syncToolbarFromHub) {
              RMAnalysisChart.syncToolbarFromHub();
            }
            void RMAnalysisChart.render(RMChartHub, {
              fit: true,
              preserveView: false,
            });
          }
          status(session.pick_count + " picks on compare chart");
        });
      });
      $("btnClearLoadedScan")?.addEventListener("click", () => {
        clearScanSession();
        setScansTab("results");
        renderCalendarUi(undefined, "results");
        status("Scan cleared — pick another from history");
      });
    }
  }

  async function loadPublishedSessionInteractive() {
    showScansPanel();
    if (!(await loadPublishedSession())) {
      status("No published session.json found");
      return;
    }
    try {
      await onSessionLoaded({
        runNewsScan: false,
        entryType: "published",
        sourceKind: "published",
        focusResults: true,
      });
      publishedSessionCacheDone = false;
      publishedSessionCache = session;
      status(session.pick_count + " picks · published scan loaded");
    } catch (e) {
      status(e.message || "Could not load published scan");
    }
  }

  function refreshScanButton() {
    const busy = marketScanRunning || newsScanRunning;
    document.body.classList.toggle("rm-scan-active", busy);
    if (typeof RMBrandLogo !== "undefined") RMBrandLogo.sync();
    if (typeof RMHeaderMood !== "undefined") RMHeaderMood.refresh();
    const btn = $("btnCustomScan");
    if (!btn) return;
    btn.classList.toggle("is-scanning", busy);
    btn.setAttribute("aria-busy", busy ? "true" : "false");
    const active = btn.querySelector(".btn-rm-scan-active");
    const idle = btn.querySelector(".btn-rm-scan-idle");
    if (active) {
      if (busy) {
        const base = active.getAttribute("data-src") || "assets/scan-progress.gif?v=2";
        active.src = base.split("&t=")[0] + "&t=" + Date.now();
      }
      active.hidden = !busy;
    }
    if (idle) idle.hidden = busy;
  }

  const REMOVE_REASON_LABELS = {
    no_stock_worthy_news_today: "no catalyst headlines today",
    news_fetch_error: "news unavailable (kept)",
    below_news_rank_cutoff: "outside top news rank",
    gap_down: "gap down (bull scan only)",
    gap_down_or_negative_day: "gap down or negative day %",
  };

  /** Only top N picks by RM score get RSS catalyst checks. */
  const NEWS_TOP_N = 15;

  function showToast(message, type) {
    const stack = $("toastStack");
    if (!stack || !message) return;
    const el = document.createElement("div");
    el.className =
      "toast toast--" + (type === "success" ? "success" : type === "info" ? "info" : "warn");
    el.setAttribute("role", "status");
    el.textContent = message;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast--show"));
    const dismiss = () => {
      el.classList.remove("toast--show");
      setTimeout(() => el.remove(), 280);
    };
    setTimeout(dismiss, 4200);
    el.addEventListener("click", dismiss);
  }

  function removalReasonLabel(reason) {
    return REMOVE_REASON_LABELS[reason] || String(reason || "filtered out").replace(/_/g, " ");
  }

  function sortPicksByGapUp(picks) {
    return [...picks].sort((a, b) => {
      const ga = a.gap_pct != null ? Number(a.gap_pct) : -1;
      const gb = b.gap_pct != null ? Number(b.gap_pct) : -1;
      if (gb !== ga) return gb - ga;
      const ra = a.rm_confidence != null ? Number(a.rm_confidence) : 0;
      const rb = b.rm_confidence != null ? Number(b.rm_confidence) : 0;
      if (rb !== ra) return rb - ra;
      return (a.rank || 99) - (b.rank || 99);
    });
  }

  function sessionAccuracyStats(sessionId) {
    if (!sessionId) return null;
    if (typeof RMTradeMetrics !== "undefined") {
      return RMTradeMetrics.sessionStats(getTrades(), sessionId);
    }
    const closed = getTrades().filter(
      (t) =>
        t.session_id === sessionId &&
        t.status === "closed" &&
        t.filled !== false
    );
    if (!closed.length) return null;
    let wins = 0;
    for (const t of closed) {
      const entry = t.entry_price ?? t.entry_premium;
      const exit = t.exit_price;
      if (entry != null && exit != null && exit > entry) wins++;
    }
    return {
      trades: closed.length,
      wins,
      pct: Math.round((wins / closed.length) * 100),
    };
  }

  function formatAccuracyBadge(sessionId, stored) {
    const a = sessionAccuracyStats(sessionId) || stored;
    if (!a) return "";
    const label =
      typeof RMTradeMetrics !== "undefined"
        ? RMTradeMetrics.fmtBadge(a)
        : a.pct + "% (" + a.wins + "/" + a.trades + ")";
    return ' · <span class="cal-accuracy">' + escapeHtml(label) + "</span>";
  }

  function persistScanSession(opts) {
    if (!session || typeof RMScanStore === "undefined") return;
    const acc = sessionAccuracyStats(session.session_id);
    if (acc) session.accuracy = acc;
    session.closed_trades = getTrades().filter(
      (t) => t.session_id === session.session_id && t.status === "closed"
    );
    if (!session.source_kind && session.source_file) {
      session.source_kind = /import/i.test(session.source_file) ? "import" : "scan";
    }
    RMScanStore.saveSession(session, {
      entryType: opts?.entryType || session.entry_type || session.source_kind || "session",
      sourceKind: opts?.sourceKind || session.source_kind || "scan",
    });
    const searchVal = $("drawerCalSearch")?.value || "";
    if ($("scanDrawer")?.classList.contains("open")) {
      renderCalendarUi(searchVal, "drawer");
    }
    if (!$("scansTabResults")?.hidden) {
      renderCalendarUi($("ttResultsCalSearch")?.value || "", "results");
    }
  }

  function focusChartSymbol(symbol) {
    if (!symbol || typeof RMAnalysisChart === "undefined") return;
    const raw = String(symbol).trim();
    const sym =
      typeof RMHoldings !== "undefined" && RMHoldings.isHoldingSelectKey?.(raw)
        ? RMHoldings.normalizeHoldingSelectKey(raw)
        : String(raw)
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9.-]/g, "");
    RMAnalysisChart.state.symbol = sym;
    RMAnalysisChart.state.activeNoteId = null;
    RMAnalysisChart.state.noteEditorAnchor = null;
    if (RMAnalysisChart.syncSymbolOptions) RMAnalysisChart.syncSymbolOptions();
    const symEl = $("caSymbol");
    if (symEl) {
      let hasOpt = false;
      symEl.querySelectorAll("option").forEach((o) => {
        if (o.value === sym) hasOpt = true;
      });
      if (!hasOpt) {
        const opt = document.createElement("option");
        opt.value = sym;
        opt.textContent =
          typeof RMHoldings !== "undefined" && RMHoldings.labelForSelectValue
            ? RMHoldings.labelForSelectValue(sym)
            : sym;
        symEl.appendChild(opt);
      }
      symEl.value = sym;
    }
    if (typeof RMAnalysisChart.syncSymbolInputFromView === "function") {
      RMAnalysisChart.syncSymbolInputFromView();
    }
    if (RMAnalysisChart.reload) RMAnalysisChart.reload({ preserveView: true });
  }

  function assertChartViewSymbol(symbol) {
    if (!symbol || typeof RMAnalysisChart === "undefined") return;
    const sym =
      typeof RMHoldings !== "undefined" && RMHoldings.isHoldingSelectKey?.(symbol)
        ? RMHoldings.normalizeHoldingSelectKey(symbol)
        : String(symbol).trim();
    RMAnalysisChart.state.symbol = sym;
    if (RMAnalysisChart.syncSymbolOptions) RMAnalysisChart.syncSymbolOptions();
    const symEl = $("caSymbol");
    if (symEl) {
      let hasOpt = false;
      symEl.querySelectorAll("option").forEach((o) => {
        if (o.value === sym) hasOpt = true;
      });
      if (!hasOpt) {
        const opt = document.createElement("option");
        opt.value = sym;
        opt.textContent =
          typeof RMHoldings !== "undefined" && RMHoldings.labelForSelectValue
            ? RMHoldings.labelForSelectValue(sym)
            : sym;
        symEl.appendChild(opt);
      }
      symEl.value = sym;
    }
    if (typeof RMAnalysisChart.syncSymbolInputFromView === "function") {
      RMAnalysisChart.syncSymbolInputFromView();
    }
  }

  let holdingNavToken = 0;

  function pickFromHolding(h, selectKey) {
    if (!h) return null;
    const sel =
      selectKey ||
      (typeof RMHoldings !== "undefined" && RMHoldings.holdingSelectValue
        ? RMHoldings.holdingSelectValue(h)
        : String(h.symbol || "").trim().toUpperCase());
    const chartSym =
      typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolFor
        ? RMHoldings.chartSymbolFor(h)
        : String(h.symbol || "").trim().toUpperCase();
    const last =
      (typeof RMHoldings !== "undefined" && RMHoldings.currentPrice
        ? RMHoldings.currentPrice(h)
        : null) ??
      h.entry_price ??
      null;
    if (last == null && h.entry_price == null) return null;
    return {
      symbol: String(sel).trim(),
      chartSymbol: chartSym,
      last: last ?? Number(h.entry_price),
      rm_confidence: h.rm_confidence,
      catalyst: { status: h.source === "schwab" ? "schwab" : "holding" },
      _holding: h,
      _fromSchwab: h.source === "schwab",
    };
  }

  function waitForChartReady(selectKey, quoteSym) {
    return new Promise(function (resolve) {
      const timeoutMs = 12000;
      const matches = function () {
        if (typeof RMAnalysisChart === "undefined") return false;
        const st = RMAnalysisChart.state || {};
        const cur = String(st.symbol || "");
        const expectedBars =
          typeof RMHoldings !== "undefined" && RMHoldings.barsSymbolForSelectValue
            ? RMHoldings.barsSymbolForSelectValue(selectKey || cur)
            : String(quoteSym || selectKey || "").toUpperCase();
        const curBars =
          typeof RMHoldings !== "undefined" && RMHoldings.barsSymbolForSelectValue
            ? RMHoldings.barsSymbolForSelectValue(cur)
            : typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolForSelectValue
              ? RMHoldings.chartSymbolForSelectValue(cur) || cur.toUpperCase()
              : cur.toUpperCase();
        const symOk =
          cur === selectKey ||
          curBars === expectedBars ||
          cur.toUpperCase() === String(quoteSym || "").toUpperCase();
        return symOk && Array.isArray(st.bars) && st.bars.length > 0;
      };
      if (matches()) {
        resolve();
        return;
      }
      const timer = setTimeout(function () {
        document.removeEventListener("rm:chart-bars", onBars);
        resolve();
      }, timeoutMs);
      const onBars = function () {
        if (matches()) {
          clearTimeout(timer);
          document.removeEventListener("rm:chart-bars", onBars);
          resolve();
        }
      };
      document.addEventListener("rm:chart-bars", onBars);
    });
  }

  function ensureHoldingChartMarker(h, chartSym) {
    if (
      !h ||
      typeof RMAnalysisChart === "undefined" ||
      !RMAnalysisChart.saveTradeMarker ||
      h.entry_price == null
    ) {
      return;
    }
    const entryMs = Date.parse(h.entry_date || h.opened_at || "");
    RMAnalysisChart.saveTradeMarker({
      id: "holding-open-" + String(h.id || chartSym).replace(/\s+/g, "_"),
      symbol: chartSym,
      entry_price: Number(h.entry_price),
      exit_price: null,
      t: Number.isFinite(entryMs) ? entryMs : Date.now(),
      session_id: h.session_id || null,
      filled: true,
      source: h.source || "holding",
    });
  }

  async function openHoldingOnChart(h) {
    if (!h?.symbol) return;
    const navToken = ++holdingNavToken;
    try {
      const drawer = $("orderDrawer");
      if (drawer?.classList.contains("open")) {
        drawer.classList.remove("open");
        drawer.classList.add("is-closed");
        drawer.setAttribute("aria-hidden", "true");
        $("orderBackdrop")?.classList.add("hidden");
      }
      if (typeof RMWorkspaceAccordion !== "undefined") RMWorkspaceAccordion.expand("chart");
      const sel =
        typeof RMHoldings !== "undefined" && RMHoldings.holdingSelectValue
          ? RMHoldings.holdingSelectValue(h)
          : h.symbol;
      const chartSym =
        typeof RMHoldings !== "undefined" && RMHoldings.chartSymbolFor
          ? RMHoldings.chartSymbolFor(h)
          : h.symbol;
      const quoteSym =
        typeof RMHoldings !== "undefined" && RMHoldings.quoteSymbolFor
          ? RMHoldings.quoteSymbolFor(h)
          : chartSym;
      focusChartSymbol(sel);
      await waitForChartReady(sel, quoteSym);
      if (navToken !== holdingNavToken) return;
      assertChartViewSymbol(sel);
      ensureHoldingChartMarker(h, quoteSym);
      const pick = pickFromHolding(h, sel);
      if (navToken !== holdingNavToken) return;
      if (pick) {
        activePick = pick;
        if (pick.chartSymbol) highlightTicker(pick.chartSymbol);
        if (typeof RMTradeFooter !== "undefined") {
          if (typeof RMTradeFooter.refresh === "function") RMTradeFooter.refresh(pick);
          else RMTradeFooter.selectPick(pick);
        }
      }
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
        RMAnalysisChart.refreshTradeOverlay();
      } else if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.paint) {
        RMAnalysisChart.paint();
      }
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setActiveTradeMarker) {
        RMAnalysisChart.setActiveTradeMarker(
          null,
          chartSym !== String(h.symbol || "").trim().toUpperCase() ? h.symbol : null
        );
      }
      if (navToken !== holdingNavToken) return;
      assertChartViewSymbol(sel);
      syncMobilePickChrome();
      if (typeof RMResultsHero !== "undefined" && RMResultsHero.showOpenPosition) {
        void RMResultsHero.showOpenPosition(h);
      }
      const focus =
        typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromHolding
          ? RMHoldings.chartFocusFromHolding(h)
          : null;
      dispatchTradeJourney({
        stage: "manage",
        symbol: focus?.symbol || chartSym,
        selectKey: focus?.selectKey || sel,
        holding: h,
        source: "holding",
      });
      const symLabel =
        typeof RMHoldings !== "undefined" && RMHoldings.formatOptionLabel
          ? RMHoldings.formatOptionLabel(h.symbol)
          : String(h.symbol || "").trim();
      const isOptView =
        typeof RMHoldings !== "undefined" && RMHoldings.isOptionSymbol?.(h.symbol);
      status(isOptView ? "Chart → " + symLabel : "Chart → " + h.symbol);
    } finally {
      /* latest click wins via holdingNavToken */
    }
  }

  function syncChartHoldingSymbols() {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.syncSymbolOptions) {
      RMAnalysisChart.syncSymbolOptions();
    }
  }

  function syncLivePickRefresh() {
    const mp = $("marketPanel");
    if (!mp || typeof RMMarket === "undefined") return;
    if (session?.picks?.length) {
      RMMarket.startLivePickRefresh(mp, () => session?.picks || []);
    } else {
      RMMarket.stopLivePickRefresh();
    }
  }

  function syncLiveChartRefresh() {
    const el = $("chartHubView");
    if (!el || typeof RMChartHub === "undefined") return;
    RMChartHub.startLiveChartRefresh(el);
  }

  function stopLiveChartRefresh() {
    if (typeof RMChartHub !== "undefined") RMChartHub.stopLiveChartRefresh();
  }

  function syncBackgroundActivity() {
    const hidden = document.visibilityState === "hidden";
    const mobile =
      isMobileWorkspace() ||
      (typeof RMMobilePerf !== "undefined" && RMMobilePerf.isMobilePerf());
    const activeKey =
      typeof RMWorkspaceAccordion !== "undefined" && RMWorkspaceAccordion.getActiveKey
        ? RMWorkspaceAccordion.getActiveKey()
        : null;

    if (mobile && activeKey !== "chart") {
      RMHeaderBg?.setFpsForcedPoster?.(false);
    }

    const booting = document
      .getElementById("morningWorkspace")
      ?.classList.contains("morning-workspace--booting");
    let mediaTier = "full";
    if (hidden) {
      mediaTier = "poster";
    } else if (booting) {
      mediaTier = "preload";
    } else if (mobile) {
      mediaTier = "poster";
    }
    RMHeaderBg?.setMediaTier?.(mediaTier);

    if (!hidden && (booting || mobile)) {
      RMHeaderMood?.pausePoll?.();
    } else if (!hidden) {
      RMHeaderMood?.resumePoll?.();
    } else {
      RMHeaderMood?.pausePoll?.();
    }

    if (hidden) {
      RMHeaderBg?.setVideoPaused?.(true);
    } else {
      RMHeaderBg?.setVideoPaused?.(false);
    }

    syncHeaderFpsWatch(mobile, activeKey, hidden);

    const chartAllowed = !hidden && (!mobile || activeKey === "chart");
    const chartPanelReady = !!document
      .getElementById("workspaceChart")
      ?.classList.contains("ws-panel--ready");
    if (chartAllowed && chartPanelReady) {
      syncLiveChartRefresh();
    } else {
      stopLiveChartRefresh();
    }

    const mp = $("marketPanel");
    const marketAllowed = !hidden && (!mobile || activeKey === "market");
    if (marketAllowed && session?.picks?.length && mp && typeof RMMarket !== "undefined") {
      RMMarket.startLivePickRefresh(mp, () => session?.picks || []);
    } else if (typeof RMMarket !== "undefined") {
      RMMarket.stopLivePickRefresh();
    }
  }

  let headerFpsWatchTimer = null;
  let headerLowFpsSecs = 0;

  function syncHeaderFpsWatch(mobile, activeKey, hidden) {
    const watch =
      mobile && activeKey === "chart" && !hidden && typeof RMAnalysisChart !== "undefined";
    if (!watch) {
      if (headerFpsWatchTimer) {
        clearInterval(headerFpsWatchTimer);
        headerFpsWatchTimer = null;
      }
      headerLowFpsSecs = 0;
      if (typeof RMAnalysisChart !== "undefined") {
        RMAnalysisChart.startHeaderFpsSample?.(false);
      }
      return;
    }
    RMAnalysisChart?.startHeaderFpsSample?.(true);
    if (headerFpsWatchTimer) return;
    headerFpsWatchTimer = setInterval(() => {
      const fps = RMAnalysisChart.getHeaderFpsSample?.() ?? 60;
      if (fps > 0 && fps < 24) {
        headerLowFpsSecs += 1;
        if (headerLowFpsSecs >= 2) {
          RMHeaderBg?.setFpsForcedPoster?.(true);
        }
      } else {
        headerLowFpsSecs = 0;
      }
    }, 1000);
  }

  function syncLiveRefresh() {
    syncBackgroundActivity();
  }

  function refreshMarketThemes() {
    const el = $("marketThemes");
    if (el && typeof RMMarketThemes !== "undefined") {
      RMMarketThemes.refresh(el, { picks: session?.picks || [] }).catch(() => {});
    }
  }

  function highlightTicker(symbol) {
    document.querySelectorAll(".pick-row-selected").forEach((el) => {
      el.classList.remove("pick-row-selected");
    });
    document.querySelectorAll(".fv-map-cell--selected").forEach((el) => {
      el.classList.remove("fv-map-cell--selected");
    });
    document.querySelectorAll(".chart-hub-legend-item--selected").forEach((el) => {
      el.classList.remove("chart-hub-legend-item--selected");
    });
    if (!symbol) return;
    const row = document.querySelector('.pick-row[data-symbol="' + symbol + '"]');
    if (row) row.classList.add("pick-row-selected");
    document
      .querySelectorAll('.fv-map-cell[data-symbol="' + symbol + '"]')
      .forEach((el) => el.classList.add("fv-map-cell--selected"));
    document.querySelectorAll(".chart-hub-legend-item").forEach((el) => {
      if (el.textContent.trim().startsWith(symbol)) {
        el.classList.add("chart-hub-legend-item--selected");
      }
    });
  }

  function clearPickTradeInsight() {
    document.querySelectorAll(".pick-trade-insight").forEach((el) => {
      el.hidden = true;
      el.textContent = "";
    });
    const orphan = $("pickSetupInsight");
    if (orphan) {
      orphan.hidden = true;
      orphan.innerHTML = "";
    }
    const planSlot = $("ttResultsPlanSlot");
    if (planSlot) {
      planSlot.classList.add("hidden");
      planSlot.hidden = true;
    }
  }

  function formatPickTradeInsightHtml(p, plan) {
    const rm = pickScore(p);
    let profitTxt = "—";
    let rrTxt = "";
    if (plan && plan.entry > plan.stop) {
      const qty = plan.qty || 100;
      const profit = ((plan.target2 ?? plan.target) - plan.entry) * qty;
      const rr = ((plan.target2 ?? plan.target) - plan.entry) / (plan.entry - plan.stop);
      profitTxt = "$" + Math.round(profit);
      rrTxt = rr.toFixed(1) + "R";
    }
    return (
      "<strong>RM " +
      (rm != null ? Math.round(rm) : "—") +
      "</strong> · Proj " +
      escapeHtml(profitTxt) +
      (rrTxt ? " · " + escapeHtml(rrTxt) : "") +
      "<br>LMT $" +
      (plan?.entry != null ? Number(plan.entry).toFixed(2) : "—") +
      " · Stop $" +
      (plan?.stop != null ? Number(plan.stop).toFixed(2) : "—") +
      " · Sell1 $" +
      (plan?.target1 != null ? Number(plan.target1).toFixed(2) : "—") +
      " · Sell2 $" +
      (plan?.target2 != null ? Number(plan.target2).toFixed(2) : "—")
    );
  }

  function resolvePickForSelect(symbol) {
    let raw = String(symbol || "").trim();
    if (!raw) return null;
    let sym = raw.toUpperCase();
    if (/^holding:/i.test(raw) && typeof RMHoldings !== "undefined") {
      sym = RMHoldings.chartSymbolForSelectValue(raw) || sym;
    }
    const fromSession = (session?.picks || []).find((x) => x.symbol === sym);
    if (fromSession) return fromSession;
    if (typeof RMHoldings !== "undefined") {
      const holdings = RMHoldings.getDisplayOpen() || [];
      const h = holdings.find((row) => {
        const cs = RMHoldings.chartSymbolFor(row);
        return cs === sym || String(row.symbol).toUpperCase() === sym;
      });
      if (h) {
        const last = RMHoldings.currentPrice(h) ?? h.entry_price;
        if (last != null || h.entry_price != null) {
          return {
            symbol: sym,
            last: last ?? Number(h.entry_price),
            rm_confidence: h.rm_confidence,
            catalyst: { status: h.source === "schwab" ? "schwab" : "holding" },
            _holding: h,
            _fromSchwab: h.source === "schwab",
          };
        }
      }
    }
    let last = null;
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol === sym) {
      const bars = RMAnalysisChart.state.bars;
      last = bars?.length ? bars[bars.length - 1].close : null;
    }
    const plan =
      typeof RMTradeFooter !== "undefined"
        ? RMTradeFooter.recommendMorningSetup?.(sym) || RMTradeFooter.recommendPlan?.({ symbol: sym, last })
        : null;
    last = last ?? plan?.price ?? plan?.entry;
    if (last == null) return null;
    return {
      symbol: sym,
      last,
      rm_confidence: null,
      catalyst: { status: "chart" },
      _chartOnly: true,
    };
  }

  function updatePickTradeInsight(symbol) {
    clearPickTradeInsight();
    if (!symbol) return;
    const sym = String(symbol).toUpperCase();
    const p = resolvePickForSelect(sym);
    if (!p) return;
    const plan =
      typeof RMTradeFooter !== "undefined"
        ? RMTradeFooter.recommendMorningSetup?.(p) || RMTradeFooter.recommendPlan(p)
        : null;
    const html = formatPickTradeInsightHtml(p, plan);
    const row = document.querySelector('.pick-row[data-symbol="' + sym + '"]');
    if (row) {
      let insight = row.querySelector(".pick-trade-insight");
      if (!insight) {
        insight = document.createElement("div");
        insight.className = "pick-trade-insight";
        row.querySelector(".pick-accordion-summary")?.appendChild(insight);
      }
      insight.innerHTML = html;
      insight.hidden = false;
      if (row.tagName === "DETAILS") row.open = true;
    }
    if (
      typeof RMAnalysisChart !== "undefined" &&
      RMAnalysisChart.state?.tradePlan?.symbol === sym
    ) {
      RMAnalysisChart.showResultsPlanPanel?.();
      return;
    }
  }

  function scrollPickIntoView(symbol) {
    const row = document.querySelector('.pick-row[data-symbol="' + symbol + '"]');
    if (row) {
      if (row.tagName === "DETAILS") row.open = true;
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    const hero = $("ttResultsHero");
    if (hero) {
      hero.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const orphan = $("pickSetupInsight");
    if (orphan && !orphan.hidden) {
      orphan.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    $("workspaceScans")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function isMobileWorkspace() {
    return (
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-ws-accordion")
    );
  }

  function syncMobilePickChrome() {
    const chartSym =
      typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol
        ? String(RMAnalysisChart.state.symbol)
        : "";
    const hasChartContext =
      !!activePick?.symbol ||
      (chartSym && chartSym !== "SPY" && chartSym !== "COMPARE");
    const showJourney =
      isMobileWorkspace() &&
      document.body.classList.contains("is-mobile-snap-chart") &&
      hasChartContext;
    document.body.classList.toggle("is-mobile-chart-pick", showJourney);
    if (typeof RMMarket !== "undefined") RMMarket.syncMobileMarketSettings?.();
    if (typeof RMChartHub !== "undefined") RMChartHub.syncMobileChartChrome?.();
  }

  function getHoldingForSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym || typeof RMHoldings === "undefined") return null;
    const holdings = RMHoldings.getDisplayOpen() || [];
    return (
      holdings.find((h) => {
        const cs = RMHoldings.chartSymbolFor(h);
        return cs === sym || String(h.symbol).toUpperCase() === sym;
      }) || null
    );
  }

  function clearTickerSelection() {
    holdingNavToken++;
    activePick = null;
    highlightTicker(null);
    clearPickTradeInsight();
    syncMobilePickChrome();
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setMapHighlight) {
      RMAnalysisChart.setMapHighlight(null);
    }
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(null);
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
      RMAnalysisChart.refreshTradeOverlay();
    } else if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.syncTradePlan) {
      RMAnalysisChart.syncTradePlan(null);
    }
  }

  function selectTicker(symbol, opts) {
    const p = resolvePickForSelect(symbol);
    if (!p) {
      status(String(symbol || "").toUpperCase() + " — no quote data for trade setup.");
      return;
    }
    const focus =
      typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromPick
        ? RMHoldings.chartFocusFromPick(p)
        : null;
    const sym = focus?.selectKey || String(symbol || "").toUpperCase();
    if (opts?.toggle && activePick?.symbol === sym) {
      clearTickerSelection();
      return;
    }
    holdingNavToken++;
    activePick = p;
    highlightTicker(sym);
    focusChartSymbol(sym);
    updatePickTradeInsight(sym);
    if (typeof RMResultsHero !== "undefined" && !opts?.skipHero) {
      void RMResultsHero.showTicker(sym);
    }
    scrollPickIntoView(sym);
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setMapHighlight) {
      RMAnalysisChart.setMapHighlight(sym, p);
    }
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.selectPick(p);
    syncMobilePickChrome();
    if (isMobileWorkspace() && opts?.snapChart !== false) {
      if (typeof RMWorkspaceAccordion !== "undefined") {
        RMWorkspaceAccordion.expand("chart");
      }
    }
    if (opts?.openDrawer) showDrawerTrade(p);
    if (opts?.fromSetup) {
      status(p._chartOnly ? sym + " setup · chart symbol (add to scan for RM score)" : sym + " setup · see Target Trades");
    }
  }

  function surfacingTradePlanToResults(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    showScansPanel();
    setScansTab("results", { skipHero: true });
    if (typeof RMWorkspaceAccordion !== "undefined" && isMobileWorkspace()) {
      RMWorkspaceAccordion.expand("scans");
    }
    if (typeof RMResultsHero !== "undefined") {
      void RMResultsHero.showSetup(sym);
    } else if (typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.showResultsPlanPanel?.();
    }
    selectTicker(sym, {
      toggle: false,
      fromSetup: true,
      snapChart: false,
      skipHero: true,
    });
    requestAnimationFrame(() => {
      $("ttResultsHero")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function selectTradeSetup(symbol) {
    const sym = String(symbol || activePick?.symbol || "").toUpperCase();
    if (!sym) return;
    surfacingTradePlanToResults(sym);
  }

  function saveOpenTradeFromPlan(plan) {
    if (
      plan.engine_bias == null &&
      typeof RMMarket !== "undefined" &&
      RMMarket.currentBiasSnapshot
    ) {
      plan.engine_bias = RMMarket.currentBiasSnapshot();
    }
    const trades = getTrades().filter(
      (t) => !(t.symbol === plan.symbol && t.status === "open")
    );
    if (plan.planned == null && (plan.source === "footer" || plan.source === "dashboard")) {
      plan.planned = true;
    }
    if (!plan.id) {
      plan.id = "journal-" + String(plan.symbol || "sym") + "-" + Date.now();
    }
    trades.push(plan);
    saveTrades(trades);
    if (typeof RMHoldings !== "undefined") {
      RMHoldings.upsertFromTrade({
        symbol: plan.symbol,
        instrument: plan.instrument || "stock",
        entry_price: plan.entry_price ?? plan.entry_premium,
        quantity: plan.quantity ?? plan.contracts,
        rm_confidence: plan.rm_confidence_adjusted ?? plan.rm_confidence,
        session_id: plan.session_id,
      });
    }
    renderHoldings();
    renderDrawerYtd();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    refreshPickRow(plan.symbol);
    persistScanSession();
    if (typeof RMMetrics !== "undefined") {
      RMMetrics.markTradeOpen({ symbol: plan.symbol, session_id: plan.session_id });
    }
    status("Trade entered · " + plan.symbol + " added to holdings");
  }

  // Single source of truth for fill interpretation across BOTH close UIs (the
  // footer stepper and the order drawer). Accepts a raw <select> value
  // ("filled" / "not_filled"), an explicit boolean, or undefined (defaults to
  // filled). Keeping this in one place stops the two UIs from drifting.
  function isFilledFromInput(input) {
    const raw = input?.fill_status != null ? input.fill_status : input?.filled;
    return raw !== false && raw !== "not_filled";
  }

  function closeTradeFromPlan(opts) {
    const sym = opts.symbol;
    const pick =
      (session?.picks || []).find((x) => x.symbol === sym) || activePick;
    const filled = isFilledFromInput(opts);
    const exitPrice = opts.exit_price;
    const trades = getTrades();
    const idx = trades.findIndex((t) => t.symbol === sym && t.status === "open");
    const patch = {
      closed_at: new Date().toISOString(),
      status: filled ? "closed" : "not_filled",
      filled,
      exit_price: exitPrice,
      reconciled: false,
      reconcile_status: "delta",
      execution_channel: opts.execution_channel || "platform",
      source: opts.source || "footer",
    };
    let entryPrice = opts.entry_price;
    let stopPrice = opts.stop_price;
    let targetPrice = opts.target_price;
    let tradeIdx = idx;
    if (idx >= 0) {
      entryPrice = entryPrice ?? trades[idx].entry_price;
      stopPrice = stopPrice ?? trades[idx].stop_price;
      targetPrice = targetPrice ?? trades[idx].target_price;
      trades[idx] = { ...trades[idx], ...patch };
    } else {
      trades.push({
        id: "journal-" + sym + "-" + Date.now(),
        symbol: sym,
        session_id: session?.session_id,
        instrument: "stock",
        rm_confidence: pick?.rm_confidence,
        entry_price: entryPrice,
        stop_price: stopPrice,
        target_price: targetPrice,
        quantity: opts.quantity,
        source: opts.source || "footer",
        planned: opts.planned !== false,
        ...patch,
      });
      tradeIdx = trades.length - 1;
    }
    if (filled && typeof RMTradeMetrics !== "undefined" && tradeIdx >= 0) {
      trades[tradeIdx] = RMTradeMetrics.enrichClosedTrade(trades[tradeIdx], {
        planned: opts.planned !== false,
      });
    }
    if (filled && typeof RMSetupFingerprint !== "undefined" && tradeIdx >= 0) {
      trades[tradeIdx] = RMSetupFingerprint.finalizeOnClose(
        trades[tradeIdx],
        pick,
        null,
        {}
      );
    }
    saveTrades(trades);
    if (filled && typeof RMTradeStory !== "undefined" && tradeIdx >= 0) {
      void RMTradeStory.syncExit(trades[tradeIdx]);
    }
    if (typeof RMHoldings !== "undefined" && filled) {
      const open = RMHoldings.findOpenBySymbol(sym);
      if (open) RMHoldings.closeHolding(open.id, exitPrice);
    }
    if (filled && typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.saveTradeMarker) {
      RMAnalysisChart.saveTradeMarker({
        symbol: sym,
        entry_price: entryPrice,
        exit_price: exitPrice,
        stop_price: stopPrice,
        target_price: targetPrice,
        session_id: session?.session_id,
        filled,
        t: Date.now(),
        closed_at: patch.closed_at,
      });
    }
    renderHoldings();
    renderLearningStats();
    renderDrawerYtd();
    renderScanMetricsStrip();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    refreshPickRow(sym);
    if ($("ttCalibrationPanel")) refreshStrategyLearning();
    persistScanSession();
    activePick = null;
    highlightTicker(null);
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.setMapHighlight) {
      RMAnalysisChart.setMapHighlight(null);
    }
    if (typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(null);
    if (typeof RMMetrics !== "undefined") {
      RMMetrics.markTradeClose({
        symbol: sym,
        filled,
        r_multiple: tradeIdx >= 0 ? trades[tradeIdx]?.r_multiple ?? null : null,
        source: patch.source,
      });
      document.dispatchEvent(new CustomEvent("rm:trade-closed", { detail: { symbol: sym } }));
    }
    const focus =
      typeof RMHoldings !== "undefined" && RMHoldings.chartFocusFromSelectKey
        ? RMHoldings.chartFocusFromSelectKey(sym)
        : null;
    dispatchTradeJourney({
      stage: "close",
      symbol: focus?.symbol || sym,
      selectKey: focus?.selectKey || sym,
      source: patch.source || "footer",
    });
    status((filled ? "Closed (filled)" : "Not filled") + " — " + sym);
  }

  function wireTradeFooter() {
    if (typeof RMTradeFooter === "undefined") return;
    RMTradeFooter.init({
      getSession: () => session,
      getTrades: getJournalTrades,
      getActivePick: () => activePick,
      getHolding: getHoldingForSymbol,
      pickScore,
      status,
      saveOpenTrade: saveOpenTradeFromPlan,
      closeTrade: closeTradeFromPlan,
      onSelect: (pick) => {
        activePick = pick;
        highlightTicker(pick.symbol);
      },
    });
  }

  function getHeroWeightConfig() {
    if (typeof RMScanConfig === "undefined") return {};
    const cfg = scanConfigDraft || RMScanConfig.load();
    return RMScanConfig.normalizeHeroWeights(cfg.weights || RMScanConfig.DEFAULTS.weights);
  }

  function pickHeroStepsHtml() {
    const shortLabels = {
      float: "Float filter",
      news: "News proxy",
      vol: "Volume surge",
      move: "Intraday move",
      daily: "Daily momentum",
    };
    const weights = getHeroWeightConfig();
    const rows =
      typeof RMScanConfig !== "undefined"
        ? RMScanConfig.criteriaRows().slice(0, 5)
        : RM_WEIGHTS.slice(0, 5).map((w) => ({
            key: w.id,
            hint: w.label,
            weightKey: w.id,
          }));
    return rows
      .map((row, i) => {
        const step = i + 1;
        const key = row.weightKey || row.key;
        const pts = Math.round(Number(weights[key]) || 0);
        const title = shortLabels[row.key] || row.label || "Criterion";
        const hint = row.hint || title;
        return (
          '<li class="pick-hero-step" data-weight-key="' +
          escapeAttr(key) +
          '">' +
          '<span class="pick-hero-step-num" aria-hidden="true">' +
          step +
          "</span>" +
          '<div class="pick-hero-step-body">' +
          '<div class="pick-hero-step-head">' +
          '<span class="pick-hero-step-title">' +
          escapeHtml(title) +
          "</span>" +
          '<span class="pick-hero-step-pts">+' +
          pts +
          "</span>" +
          '<button type="button" class="pick-hero-step-info" aria-label="' +
          escapeAttr(title + " details") +
          '">' +
          '<span class="pick-hero-step-info-icon" aria-hidden="true">i</span>' +
          '<span class="pick-hero-step-tip" role="tooltip">' +
          escapeHtml(hint) +
          "</span></button></div>" +
          '<div class="pick-hero-step-slider">' +
          '<input type="range" class="pick-hero-weight-slider" data-weight-key="' +
          escapeAttr(key) +
          '" min="0" max="50" step="1" value="' +
          pts +
          '" aria-label="' +
          escapeAttr(title + " score weight") +
          '">' +
          '<span class="pick-hero-step-slider-val">' +
          pts +
          "%</span></div></div></li>"
        );
      })
      .join("");
  }

  function pickHeroWeightFooterHtml() {
    if (typeof RMScanConfig === "undefined") return "";
    const weights = getHeroWeightConfig();
    const heroTotal = RMScanConfig.heroWeightSum(weights);
    const budget = RMScanConfig.heroWeightBudget(weights);
    const price = Math.round(Number(weights.price) || 0);
    return (
      '<div class="pick-hero-weight-foot">' +
      '<button type="button" class="pick-hero-weight-reset secondary btn-sm">Reset to defaults</button>' +
      '<p class="pick-hero-weight-total' +
      (heroTotal === budget ? "" : " pick-hero-weight-total--warn") +
      '">Score allocation: <strong>' +
      heroTotal +
      "%</strong> across five signals · Price band +" +
      price +
      " = <strong>100%</strong> RM score</p>" +
      "</div>"
    );
  }

  function persistPickHeroWeights(nextWeights) {
    if (typeof RMScanConfig === "undefined") return;
    const cfg = scanConfigDraft || RMScanConfig.load();
    cfg.weights = RMScanConfig.normalizeHeroWeights({
      ...(cfg.weights || {}),
      ...nextWeights,
    });
    scanConfigDraft = cfg;
    RMScanConfig.save(cfg);
    syncRmWeightPts(cfg.weights);
  }

  function syncRmWeightPts(weights) {
    if (!weights) return;
    for (const w of RM_WEIGHTS) {
      if (weights[w.id] != null) w.pts = Math.round(Number(weights[w.id]));
    }
  }

  function updatePickHeroWeightDisplay() {
    if (typeof RMScanConfig === "undefined") return;
    const weights = getHeroWeightConfig();
    const active = document.activeElement;
    document.querySelectorAll(".pick-hero-weight-slider").forEach((slider) => {
      const key = slider.dataset.weightKey;
      if (!key) return;
      const val = Math.round(Number(weights[key]) || 0);
      if (slider !== active) slider.value = String(val);
      const row = slider.closest(".pick-hero-step, .pick-weight-row");
      const valEl = row?.querySelector(".pick-hero-step-slider-val, .pick-weight-val");
      if (valEl) valEl.textContent = val + "%";
    });
    document.querySelectorAll(".pick-hero-step[data-weight-key]").forEach((step) => {
      const key = step.dataset.weightKey;
      if (!key) return;
      const val = Math.round(Number(weights[key]) || 0);
      const badge = step.querySelector(".pick-hero-step-pts");
      if (badge) badge.textContent = "+" + val;
    });
    const total = RMScanConfig.heroWeightSum(weights);
    const budget = RMScanConfig.heroWeightBudget(weights);
    document.querySelectorAll(".pick-hero-weight-foot .pick-hero-weight-total").forEach((el) => {
      el.classList.toggle("pick-hero-weight-total--warn", total !== budget);
      const strong = el.querySelector("strong");
      if (strong) strong.textContent = total + "%";
    });
  }

  function resetHeroWeightsToDefaults() {
    if (typeof RMScanConfig === "undefined") return;
    const cfg = scanConfigDraft || RMScanConfig.load();
    cfg.weights = { ...RMScanConfig.DEFAULTS.weights };
    scanConfigDraft = cfg;
    RMScanConfig.save(cfg);
    syncRmWeightPts(cfg.weights);
    updatePickHeroWeightDisplay();
    const rankPanel = $("scanRankPanel");
    if (rankPanel?.querySelector(".pick-hero-copy")) {
      renderScanRankPanel(rankPanel);
    }
    status("Score weights reset to H-001 defaults (29/24/19/14/10 +4)");
  }

  function wirePickHeroWeightSliders(root) {
    const scope = root || document;
    scope.querySelectorAll(".pick-hero-weight-slider").forEach((input) => {
      if (input.dataset.wired === "1") return;
      input.dataset.wired = "1";
      input.addEventListener("input", () => {
        const key = input.dataset.weightKey;
        if (!key || typeof RMScanConfig === "undefined") return;
        const cfg = scanConfigDraft || RMScanConfig.load();
        const next = RMScanConfig.adjustHeroWeight(cfg.weights || {}, key, input.value);
        persistPickHeroWeights(next);
        updatePickHeroWeightDisplay();
      });
    });
  }

  function wirePickHeroWeightControls(root) {
    wirePickHeroWeightSliders(root);
    const scope = root || document;
    scope.querySelectorAll(".pick-hero-weight-reset").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", resetHeroWeightsToDefaults);
    });
  }

  function renderScanRankPanelHtml() {
    const steps = pickHeroStepsHtml();
    return (
      '<div class="pick-hero pick-hero--weights-edit pick-hero--drawer">' +
      '<div class="pick-hero-main">' +
      '<div class="pick-hero-visual" aria-hidden="true">' +
      '<div class="pick-hero-glow"></div>' +
      '<div class="pick-hero-scanline"></div>' +
      '<svg class="pick-hero-svg" viewBox="0 0 360 220" xmlns="http://www.w3.org/2000/svg">' +
      "<defs>" +
      '<linearGradient id="phg" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#4eb8c9"/><stop offset="55%" stop-color="#2db8a8"/><stop offset="100%" stop-color="#8b7fd4"/></linearGradient>' +
      '<linearGradient id="phFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="rgba(78,184,201,0.28)"/><stop offset="100%" stop-color="rgba(78,184,201,0)"/></linearGradient>' +
      '<filter id="phGlow" x="-30%" y="-30%" width="160%" height="160%">' +
      '<feGaussianBlur stdDeviation="2.5" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
      '<pattern id="phGrid" width="24" height="24" patternUnits="userSpaceOnUse">' +
      '<path d="M24 0H0V24" fill="none" stroke="rgba(78,184,201,0.08)" stroke-width="1"/></pattern>' +
      "</defs>" +
      '<rect width="360" height="220" rx="18" fill="#0b1018"/>' +
      '<rect width="360" height="220" rx="18" fill="url(#phGrid)"/>' +
      '<rect x="18" y="18" width="324" height="184" rx="12" fill="rgba(0,0,0,0.22)" stroke="rgba(78,184,201,0.12)"/>' +
      '<path d="M36 156 L84 142 L128 148 L172 108 L216 114 L252 78 L292 86 L324 58 L324 184 L36 184 Z" fill="url(#phFill)"/>' +
      '<path class="pick-hero-line" d="M36 156 L84 142 L128 148 L172 108 L216 114 L252 78 L292 86 L324 58" fill="none" stroke="url(#phg)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#phGlow)"/>' +
      '<circle class="pick-hero-dot pick-hero-dot--lead" cx="324" cy="58" r="6" fill="#4eb8c9"/>' +
      '<circle class="pick-hero-dot" cx="252" cy="78" r="4.5" fill="#2db8a8"/>' +
      '<circle class="pick-hero-dot" cx="172" cy="108" r="4" fill="#d4a24a"/>' +
      '<g class="pick-hero-tags">' +
      '<rect x="28" y="28" width="78" height="30" rx="8" fill="rgba(78,184,201,0.14)" stroke="rgba(78,184,201,0.55)"/>' +
      '<text x="67" y="47" text-anchor="middle" fill="#8ae4d8" font-size="11" font-weight="700">RM 82+</text>' +
      '<rect x="118" y="28" width="88" height="30" rx="8" fill="rgba(232,149,79,0.12)" stroke="rgba(232,149,79,0.45)"/>' +
      '<text x="162" y="47" text-anchor="middle" fill="#f5c99a" font-size="11" font-weight="700">GAP ↑</text>' +
      '<rect x="218" y="28" width="108" height="30" rx="8" fill="rgba(139,127,212,0.14)" stroke="rgba(139,127,212,0.45)"/>' +
      '<text x="272" y="47" text-anchor="middle" fill="#c4b8f0" font-size="11" font-weight="700">NEWS ✓</text>' +
      "</g></svg></div>" +
      '<div class="pick-hero-copy">' +
      '<p class="pick-hero-kicker">H-001 · Breakout morning scan</p>' +
      "<h3 class=\"pick-hero-title\">Find gap-and-go winners backed by catalyst strength</h3>" +
      '<ol class="pick-hero-steps" aria-label="H-001 scan criteria">' +
      steps +
      "</ol>" +
      pickHeroWeightFooterHtml() +
      "</div></div></div>"
    );
  }

  function renderScanRankPanel(root) {
    if (!root) return;
    root.innerHTML = renderScanRankPanelHtml();
    wirePickHeroWeightControls(root);
    updatePickHeroWeightDisplay();
  }

  function status(msg) {
    const el = $("headerMeta");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function setHeaderMeta(msg) {
    status(msg);
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function isMobileWsAccordion() {
    return (
      window.matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-ws-accordion")
    );
  }

  function isMobileSnapScans() {
    return isMobileWsAccordion() && document.body.classList.contains("is-mobile-snap-scans");
  }

  function scansPanelLoader() {
    return document.querySelector("#workspaceScans .ws-col-loader");
  }

  function setScanProgressLabel(text) {
    setText("scanProgressLabel", text);
    if (!isMobileSnapScans()) return;
    const panelLabel = scansPanelLoader()?.querySelector(".ws-scan-progress-label");
    if (panelLabel) panelLabel.textContent = text;
  }

  function mirrorScanProgressToPanel() {
    if (!isMobileSnapScans()) return;
    const loader = scansPanelLoader();
    if (!loader) return;
    const srcFill = $("scanProgressFill");
    const dstFill = loader.querySelector(".ws-scan-progress-fill");
    const srcTrack = document.querySelector("#newsProgress .scan-progress-track");
    const dstTrack = loader.querySelector(".ws-scan-progress-track");
    const srcSeg = $("scanProgressSegments");
    const dstSeg = loader.querySelector(".ws-scan-progress-segments");
    const srcLabel = $("scanProgressLabel");
    const dstLabel = loader.querySelector(".ws-scan-progress-label");
    if (srcLabel && dstLabel) dstLabel.textContent = srcLabel.textContent;
    if (srcFill && dstFill) {
      dstFill.style.width = srcFill.style.width;
      dstFill.classList.toggle("is-estimated", srcFill.classList.contains("is-estimated"));
      dstFill.classList.toggle("no-transition", srcFill.classList.contains("no-transition"));
    }
    if (srcTrack && dstTrack) {
      dstTrack.setAttribute("aria-valuenow", srcTrack.getAttribute("aria-valuenow") || "0");
    }
    if (srcSeg && dstSeg) dstSeg.innerHTML = srcSeg.innerHTML;
  }

  function updateScansPanelLoaderStep(step, pct) {
    if (!isMobileSnapScans() || typeof RMWorkspaceLoad === "undefined") return;
    RMWorkspaceLoad.showPanelLoader("scans", {
      step: step || "Scanning…",
      kicker: "Rainmaker scan",
      pct: pct != null ? pct : scanProgressPct || 14,
      scanProgress: true,
    });
    mirrorScanProgressToPanel();
  }

  function setPageTitle(text) {
    document.title = text;
  }

  function setPickListHtml(html) {
    const el = $("pickList");
    if (!el) return;
    if (typeof RMVirtualPickList !== "undefined" && RMVirtualPickList.isMounted()) {
      RMVirtualPickList.destroy();
    }
    el.innerHTML = html;
  }

  function pickListBannerHtml() {
    const removed = session?.filtered_out || [];
    if (!removed.length) return "";
    return (
      '<p class="status-msg pick-removed-banner">Removed ' +
      removed.length +
      " without news today: " +
      escapeHtml(removed.map((x) => x.symbol).join(", ")) +
      "</p>"
    );
  }

  function bindPickListSubtree(root) {
    bindPickAccordions(root);
    bindRmScoreTooltips(root);
    bindUiTips(root);
    if (!root) return;
    root.querySelectorAll("[data-pick-chart]").forEach((el) => {
      observePickChartElement(el);
    });
  }

  function renderPickListContent(picks, banner) {
    const listRoot = $("pickList");
    if (!listRoot) return;
    const b = banner != null ? banner : pickListBannerHtml();
    if (
      typeof RMVirtualPickList !== "undefined" &&
      RMVirtualPickList.shouldVirtualize(picks.length)
    ) {
      if (!RMVirtualPickList.isMounted()) {
        RMVirtualPickList.mount(listRoot, {
          renderRow: renderPickRow,
          bind: bindPickListSubtree,
        });
      }
      RMVirtualPickList.refresh(picks, b);
      return;
    }
    if (typeof RMVirtualPickList !== "undefined" && RMVirtualPickList.isMounted()) {
      RMVirtualPickList.destroy();
    }
    listRoot.innerHTML = b + picks.map(renderPickRow).join("");
    bindPickListSubtree(listRoot);
  }

  function fmt(n) {
    if (n == null || n === "") return "—";
    return Number(n).toFixed(0);
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

  function fvTipData(kicker, title, desc, stat) {
    if (typeof RMUiTips === "undefined") return "";
    return RMUiTips.fvTipData(kicker, title, desc, stat);
  }

  function bindUiTips(root) {
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(root);
  }

  function tipTruncate(s, max) {
    s = String(s || "").trim();
    if (!s || s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  function catalystTipMeta(cat) {
    if (!cat) {
      return {
        kicker: "Catalyst",
        title: "Review",
        desc: "Run news scan to verify whether recent headlines support the gap.",
        stat: "",
      };
    }
    if (cat.verified === true) {
      const n =
        (cat.headlines && cat.headlines.length) || (cat.headline ? 1 : 0);
      return {
        kicker: "Catalyst",
        title: "Verified",
        desc: "Headline found in the scan window that matches this symbol.",
        stat: n ? n + " headline(s)" : "verified",
      };
    }
    if (cat.verified === false) {
      return {
        kicker: "Catalyst",
        title: "None",
        desc: "News scan ran; no qualifying headline in the window.",
        stat: "",
      };
    }
    if (cat.status === "news_error") {
      return {
        kicker: "Catalyst",
        title: "Fetch error",
        desc: "News provider failed; retry scan or check your connection.",
        stat: "",
      };
    }
    return {
      kicker: "Catalyst",
      title: "Review",
      desc: "Awaiting or incomplete news verification.",
      stat: "",
    };
  }

  function catalystPill(cat) {
    const meta = catalystTipMeta(cat);
    const tip = fvTipData(meta.kicker, meta.title, meta.desc, meta.stat);
    if (!cat) {
      return (
        '<span class="pill pill-review fv-tip-target" tabindex="0"' +
        tip +
        ">review</span>"
      );
    }
    if (cat.verified === true) {
      return (
        '<span class="pill pill-yes fv-tip-target" tabindex="0"' +
        tip +
        ">catalyst</span>"
      );
    }
    if (cat.verified === false) {
      return (
        '<span class="pill pill-no fv-tip-target" tabindex="0"' +
        tip +
        ">none</span>"
      );
    }
    if (cat.status === "news_error") {
      return (
        '<span class="pill pill-review fv-tip-target" tabindex="0"' +
        tip +
        ">error</span>"
      );
    }
    return (
      '<span class="pill pill-review fv-tip-target" tabindex="0"' +
      tip +
      ">review</span>"
    );
  }

  function pickScore(p) {
    if (!p) return null;
    if (p.rm_confidence_adjusted != null) return p.rm_confidence_adjusted;
    const c = p.catalyst;
    if (c && c.rm_confidence_adjusted != null) return c.rm_confidence_adjusted;
    return p.rm_confidence;
  }

  /** Matches thinkorswim/scanners/MorningMomentumScanner.ts */
  const RM_WEIGHTS = [
    {
      id: "float",
      pts: 29,
      label: "Float filter (Stock Hacker)",
      hintKey: "float",
    },
    {
      id: "news",
      pts: 24,
      label: "News proxy (gap-up ≥3% or vol + daily ≥5%)",
      hintKey: "news",
    },
    {
      id: "vol",
      pts: 19,
      label: "Volume ≥5× 30-day average",
      hintKey: "vol",
    },
    {
      id: "move",
      pts: 14,
      label: "Move ≥8%",
      hintKey: "move",
    },
    {
      id: "daily",
      pts: 10,
      label: "Daily change ≥10%",
      hintKey: "daily",
    },
    {
      id: "price",
      pts: 4,
      label: "Price $1–$20",
      hintKey: "price",
    },
  ];
  const RM_NEWS_WEIGHT = 24;

  function rmComponentHints(p) {
    const last = p.last != null ? Number(p.last) : null;
    const pct = p.pct_change != null ? Number(p.pct_change) : null;
    return {
      float: true,
      price: last != null && last >= 1 && last <= 20,
      daily: pct != null && pct >= 10,
      move: pct != null && pct >= 8,
      vol: null,
      news: null,
    };
  }

  function findRmBreakdown(rm, hints) {
    if (rm == null || Number.isNaN(Number(rm))) return null;
    const target = Number(rm);
    const candidates = [];
    for (let mask = 0; mask < 1 << RM_WEIGHTS.length; mask++) {
      let sum = 0;
      const parts = [];
      for (let i = 0; i < RM_WEIGHTS.length; i++) {
        if (mask & (1 << i)) {
          sum += RM_WEIGHTS[i].pts;
          parts.push(RM_WEIGHTS[i]);
        }
      }
      if (Math.abs(sum - target) > 0.01) continue;
      let consistency = 0;
      for (const part of parts) {
        if (!part.hintKey) continue;
        const h = hints[part.hintKey];
        if (h === true) consistency += 2;
        if (h === false) consistency -= 1;
      }
      candidates.push({ parts, sum, consistency });
    }
    if (!candidates.length) return null;
    candidates.sort(
      (a, b) =>
        b.consistency - a.consistency || a.parts.length - b.parts.length
    );
    return candidates[0];
  }

  function rmHintNote(hints, hintKey) {
    const h = hints[hintKey];
    if (h === true) return " · matches %/price in export";
    if (h === false) return " · export %/price below threshold";
    if (hintKey === "vol" || hintKey === "news") {
      return " · confirmed in ToS scan only";
    }
    return "";
  }

  function buildRmScoreTooltipHtml(p) {
    const base = p.rm_confidence;
    const shown = pickScore(p);
    const cat = p.catalyst || {};
    const hints = rmComponentHints(p);
    const parts = p.rm_score_parts;
    const fracs = p.rm_score_fractions;
    const breakdown = base != null && !parts ? findRmBreakdown(base, hints) : null;
    const onIds = new Set((breakdown?.parts || []).map((x) => x.id));

    let rows =
      '<p class="rm-tip-title">RM confidence (H-001)</p>' +
      '<p class="rm-tip-sub">Sliding score · weighted signal strength (not pass/fail)</p>' +
      '<ul class="rm-tip-list">';

    for (const w of RM_WEIGHTS) {
      let pts;
      let cls;
      if (parts && parts[w.id] != null) {
        const earned = parts[w.id];
        const frac = fracs?.[w.id];
        pts =
          earned > 0
            ? "+" + (Number.isInteger(earned) ? earned : earned.toFixed(1))
            : "0";
        if (frac != null && frac > 0 && frac < 0.95) {
          pts += " (" + Math.round(frac * 100) + "%)";
        }
        cls = earned > 0 ? "rm-tip-on" : "rm-tip-off";
      } else {
        const on = onIds.has(w.id);
        pts = on ? "+" + w.pts : "0";
        cls = on ? "rm-tip-on" : "rm-tip-off";
      }
      const note =
        parts && parts[w.id] > 0 ? rmHintNote(hints, w.hintKey) : onIds.has(w.id) ? rmHintNote(hints, w.hintKey) : "";
      rows +=
        '<li class="' +
        cls +
        '"><span class="rm-tip-pts">' +
        pts +
        '</span> ' +
        escapeHtml(w.label) +
        (note ? '<span class="rm-tip-note">' + escapeHtml(note) + "</span>" : "") +
        "</li>";
    }
    rows += "</ul>";

    rows +=
      '<p class="rm-tip-total">Scan export: <strong>' +
      fmt(base) +
      "</strong>";
    if (p.rm_rank_pct != null) {
      rows += " · session rank <strong>top " + p.rm_rank_pct + "%</strong>";
    }
    if (breakdown) {
      rows += " (= " + breakdown.parts.map((x) => x.pts).join(" + ") + ")";
    }
    rows += "</p>";

    const newsWeight = RM_WEIGHTS.find((w) => w.id === "news")?.pts ?? RM_NEWS_WEIGHT;
    if (cat.verified === false && base != null) {
      rows +=
        '<p class="rm-tip-adj">No verified catalyst: <strong>−' +
        newsWeight +
        "</strong> news proxy removed → display <strong>" +
        fmt(shown) +
        "</strong></p>";
    } else if (shown != null && base != null && shown !== base) {
      rows +=
        '<p class="rm-tip-adj">Adjusted display: <strong>' +
        fmt(shown) +
        "</strong></p>";
    }

    return rows;
  }

  function rmScorePct(p) {
    const shown = pickScore(p);
    if (shown == null || Number.isNaN(Number(shown))) return 0;
    return Math.min(100, Math.max(0, Number(shown)));
  }

  function rmMeterTier(pct) {
    if (pct >= 70) return "high";
    if (pct >= 45) return "mid";
    return "low";
  }

  function renderRmScoreMeter(p, size) {
    const shown = pickScore(p);
    const pct = rmScorePct(p);
    const tier = rmMeterTier(pct);
    const sz = size || "row";
    return (
      '<div class="rm-meter rm-meter-' +
      sz +
      " rm-tier-" +
      tier +
      ' rm-score-tip" tabindex="0" data-symbol="' +
      escapeAttr(p.symbol) +
      '">' +
      '<div class="rm-meter-head">' +
      '<span class="rm-meter-num">' +
      fmt(shown) +
      '</span><span class="rm-meter-pct">' +
      Math.round(pct) +
      "%</span></div>" +
      '<div class="rm-meter-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
      Math.round(pct) +
      '">' +
      '<div class="rm-meter-fill" style="width:' +
      pct +
      '%"></div>' +
      '<div class="rm-meter-glow"></div>' +
      "</div>" +
      '<span class="rm-meter-label">RM confidence</span>' +
      "</div>"
    );
  }

  function renderRmScoreSpan(p) {
    return renderRmScoreMeter(p, "compact");
  }

  let rmTooltipEl = null;
  let rmTooltipPick = null;

  function ensureRmTooltip() {
    if (!rmTooltipEl) {
      rmTooltipEl = document.createElement("div");
      rmTooltipEl.id = "rmScoreTooltip";
      rmTooltipEl.className = "rm-score-tooltip hidden";
      rmTooltipEl.setAttribute("role", "tooltip");
      document.body.appendChild(rmTooltipEl);
    }
    return rmTooltipEl;
  }

  function positionRmTooltip(anchor) {
    const tip = ensureRmTooltip();
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    tip.style.left = "0";
    tip.style.top = "0";
    tip.classList.remove("hidden");
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - margin;
    if (top < margin) top = rect.bottom + margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top + window.scrollY) + "px";
  }

  function showRmTooltip(anchor, pick) {
    rmTooltipPick = pick;
    const tip = ensureRmTooltip();
    tip.innerHTML = buildRmScoreTooltipHtml(pick);
    tip.classList.remove("hidden");
    positionRmTooltip(anchor);
  }

  function hideRmTooltip() {
    rmTooltipPick = null;
    if (rmTooltipEl) rmTooltipEl.classList.add("hidden");
  }

  function bindRmScoreTooltips(root) {
    if (!root) return;
    root.querySelectorAll(".rm-score-tip, .rm-meter").forEach((el) => {
      if (el.dataset.rmTipBound) return;
      el.dataset.rmTipBound = "1";
      const sym =
        el.closest(".pick-row")?.dataset.symbol ||
        el.dataset.symbol ||
        activePick?.symbol;
      const show = () => {
        const p = (session?.picks || []).find((x) => x.symbol === sym) || activePick;
        if (p) showRmTooltip(el, p);
      };
      el.addEventListener("mouseenter", show);
      el.addEventListener("focus", show);
      el.addEventListener("mouseleave", hideRmTooltip);
      el.addEventListener("blur", hideRmTooltip);
    });
  }

  function showDrawerPanel(which) {
    const stack = $("drawerAccountStack");
    const trade = $("drawerTradeView");
    if (stack) stack.classList.toggle("hidden", which === "trade");
    if (trade) trade.classList.toggle("hidden", which !== "trade");
  }

  function openAccountDrawer() {
    activePick = null;
    activeHolding = null;
    setText("drawerTitle", "Account");
    setText("drawerSubtitle", "Schwab · holdings · YTD");
    showDrawerPanel("account");
    renderDrawerHoldings();
    renderDrawerYtd();
    if (typeof RMAuthGate !== "undefined") renderDrawerAuth();
    const renderSchwab = () => {
      if (typeof RMSchwab !== "undefined" && RMSchwab.render) {
        void RMSchwab.render();
      }
    };
    if (typeof RMChunkLoader !== "undefined") {
      void RMChunkLoader.ensureBroker().then(renderSchwab).catch(renderSchwab);
    } else {
      renderSchwab();
    }
    openOrderDrawer();
  }

  function formatAuthTime(ms) {
    if (!ms) return "";
    try {
      return new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }

  async function renderDrawerAuth() {
    const userEl = $("drawerAuthUser");
    const listEl = $("drawerRecentUsers");
    const user =
      typeof RMAuthGate !== "undefined" ? RMAuthGate.getUser() : null;
    if (userEl) {
      userEl.textContent = user
        ? (user.displayName || user.email) + " · " + (user.email || "")
        : "Signed out — refresh to sign in again.";
    }
    if (!listEl || typeof RMAuthGate === "undefined") return;
    listEl.innerHTML = '<p class="meta drawer-recent-user-row">Loading recent users…</p>';
    const rows = await RMAuthGate.fetchRecentUsers();
    if (!rows.length) {
      listEl.innerHTML =
        '<p class="meta drawer-recent-user-row">No recent sign-ins yet.</p>';
      return;
    }
    listEl.innerHTML = rows
      .map(
        (row) =>
          '<div class="drawer-recent-user-row" role="listitem">' +
          '<span class="drawer-recent-user-name">' +
          escapeHtml(row.displayName || row.email || row.userId) +
          "</span>" +
          '<span class="drawer-recent-user-meta">' +
          escapeHtml(row.method || "login") +
          "</span>" +
          '<span class="drawer-recent-user-email">' +
          escapeHtml(row.email || "") +
          (row.loggedAt ? " · " + escapeHtml(formatAuthTime(row.loggedAt)) : "") +
          "</span></div>"
      )
      .join("");
  }

  function showDrawerHoldings() {
    openAccountDrawer();
  }

  function showDrawerTrade(p) {
    activePick = p;
    activeHolding = null;
    setText("drawerTitle", p.symbol);
    setText("drawerSubtitle", "Plan trade");
    showDrawerPanel("trade");
    populateOrderDrawer(p);
    openOrderDrawer();
  }

  function renderSparkline(history) {
    const pts = (history || []).filter((h) => h.price != null);
    if (pts.length < 2) return "";
    const prices = pts.map((h) => Number(h.price));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const w = 200;
    const h = 48;
    const coords = prices
      .map((pr, i) => {
        const x = (i / (prices.length - 1)) * w;
        const y = h - ((pr - min) / range) * (h - 4) - 2;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    return (
      '<svg class="hold-spark" viewBox="0 0 ' +
      w +
      " " +
      h +
      '" preserveAspectRatio="none">' +
      '<polyline fill="none" stroke="currentColor" stroke-width="2" points="' +
      coords +
      '"/></svg>'
    );
  }

  function renderHoldingCard(h, compact) {
    const px = RMHoldings.currentPrice(h);
    const pnl = RMHoldings.calcPnL(h, px);
    const pnlCls =
      pnl && pnl.pct > 0 ? "up" : pnl && pnl.pct < 0 ? "down" : "";
  const pnlTxt =
      pnl && pnl.pct != null
        ? (pnl.pct >= 0 ? "+" : "") + pnl.pct.toFixed(2) + "%"
        : "—";
    const spark = compact ? "" : renderSparkline(h.price_history);
    const manageBtn = h.readOnly
      ? ""
      : '<button type="button" class="holding-manage-btn secondary btn-sm" data-holding-id="' +
        escapeAttr(h.id) +
        '">Manage</button>';
    return (
      '<div class="holding-card' +
      (compact ? " holding-card-compact" : "") +
      '" data-holding-id="' +
      escapeAttr(h.id) +
      '" title="View on chart" role="button" tabindex="0">' +
      '<div class="holding-card-top">' +
      "<strong>" +
      escapeHtml(h.symbol) +
      "</strong>" +
      (h.source === "schwab"
        ? ' <span class="rm-schwab-badge" title="Live Schwab position">Schwab</span>'
        : "") +
      '<span class="holding-pnl ' +
      pnlCls +
      '">' +
      pnlTxt +
      "</span></div>" +
      '<p class="meta">Entry $' +
      (h.entry_price != null ? Number(h.entry_price).toFixed(2) : "—") +
      (px != null ? " · Now $" + px.toFixed(2) : "") +
      (h.quantity != null ? " · Qty " + h.quantity : "") +
      (h.market_value != null ? " · MV $" + Number(h.market_value).toFixed(0) : "") +
      (h.rm_confidence != null ? " · RM " + Math.round(h.rm_confidence) : "") +
      "</p>" +
      spark +
      manageBtn +
      "</div>"
    );
  }

  function findDisplayHolding(id) {
    if (typeof RMHoldings === "undefined") return null;
    const local = RMHoldings.findById(id);
    if (local) return local;
    return (RMHoldings.getDisplayOpen() || []).find((h) => h.id === id) || null;
  }

  function renderDrawerHoldings() {
    const open =
      typeof RMHoldings !== "undefined" ? RMHoldings.getDisplayOpen() : [];
    const empty = $("holdingsEmpty");
    const list = $("drawerHoldingsList");
    const add = $("drawerAddHolding");
    const detail = $("drawerHoldingDetail");
    if (add) add.classList.add("hidden");
    if (detail) {
      detail.classList.add("hidden");
      detail.innerHTML = "";
    }
    if (!open.length) {
      if (empty) {
        empty.classList.remove("hidden");
        const brokerN =
          typeof RMHoldings !== "undefined" && RMHoldings.getBrokerPositions
            ? RMHoldings.getBrokerPositions().length
            : 0;
        const p = empty.querySelector("p");
        if (p) {
          p.textContent = brokerN
            ? "No manual holdings — Schwab positions appear above after sync."
            : "No open positions. Connect Schwab above, sync fills, or add a holding.";
        }
      }
      if (list) {
        list.classList.add("hidden");
        list.innerHTML = "";
      }
      return;
    }
    if (empty) empty.classList.add("hidden");
    if (list) {
      list.classList.remove("hidden");
      list.innerHTML =
        open.map((h) => renderHoldingCard(h, true)).join("") +
        '<button type="button" id="btnShowAddHoldingList" class="btn-block secondary">+ Add holding</button>';
      list.querySelectorAll(".holding-card").forEach((el) => {
        el.addEventListener("click", () => {
          const id = el.dataset.holdingId;
          const h = findDisplayHolding(id);
          if (h) openHoldingOnChart(h);
        });
        el.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          const h = findDisplayHolding(el.dataset.holdingId);
          if (h) openHoldingOnChart(h);
        });
      });
      list.querySelectorAll(".holding-manage-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const h = findDisplayHolding(btn.dataset.holdingId);
          if (h) showHoldingDetail(h);
        });
      });
      const btn = $("btnShowAddHoldingList");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          showAddHoldingForm();
        });
      }
    }
    syncChartHoldingSymbols();
  }

  function showHoldingDetail(h) {
    activeHolding = h;
    const px = RMHoldings.currentPrice(h);
    const pnl = RMHoldings.calcPnL(h, px);
    const empty = $("holdingsEmpty");
    const list = $("drawerHoldingsList");
    const detail = $("drawerHoldingDetail");
    if (empty) empty.classList.add("hidden");
    if (list) list.classList.add("hidden");
    if (!detail) return;
    detail.classList.remove("hidden");
    const pnlCls =
      pnl && pnl.pct > 0 ? "up" : pnl && pnl.pct < 0 ? "down" : "";
    detail.innerHTML =
      '<button type="button" class="secondary btn-sm drawer-back" id="btnHoldingsBack">← All holdings</button>' +
      '<button type="button" class="btn-block secondary" id="btnViewHoldingChart">View on chart</button>' +
      "<h3>" +
      escapeHtml(h.symbol) +
      "</h3>" +
      renderSparkline(h.price_history) +
      '<p class="holding-pnl-big ' +
      pnlCls +
      '">' +
      (pnl && pnl.pct != null
        ? (pnl.pct >= 0 ? "+" : "") + pnl.pct.toFixed(2) + "%"
        : "—") +
      (pnl && pnl.dollars != null
        ? " · " + (pnl.dollars >= 0 ? "+" : "") + "$" + pnl.dollars.toFixed(2)
        : "") +
      "</p>" +
      '<p class="meta">Entry $' +
      (h.entry_price != null ? Number(h.entry_price).toFixed(2) : "—") +
      " · Qty " +
      (h.quantity != null ? h.quantity : "—") +
      " · RM " +
      (h.rm_confidence != null ? Math.round(h.rm_confidence) : "—") +
      "</p>" +
      '<p class="meta">' +
      escapeHtml(h.notes || "") +
      "</p>" +
      '<label>Update price</label>' +
      '<input type="number" step="0.01" id="holdMark" inputmode="decimal" value="' +
      (px != null ? px : "") +
      '">' +
      '<button type="button" id="btnUpdateMark">Update mark</button>' +
      '<label>Exit price (sell)</label>' +
      '<input type="number" step="0.01" id="holdExit" inputmode="decimal">' +
      '<button type="button" id="btnSellHolding" class="danger">Record sale</button>';
    $("btnHoldingsBack").addEventListener("click", renderDrawerHoldings);
    $("btnViewHoldingChart")?.addEventListener("click", () => openHoldingOnChart(h));
    $("btnUpdateMark").addEventListener("click", () => {
      const v = num("holdMark");
      if (v != null) {
        RMHoldings.appendPrice(h.symbol, v, "manual");
        renderHoldings();
        showHoldingDetail(RMHoldings.findById(h.id));
      }
    });
    $("btnSellHolding").addEventListener("click", () => {
      const exit = num("holdExit") ?? num("holdMark");
      RMHoldings.closeHolding(h.id, exit);
      renderHoldings();
      renderLearningStats();
      renderDrawerHoldings();
    });
  }

  function showAddHoldingForm(prefill) {
    const empty = $("holdingsEmpty");
    const list = $("drawerHoldingsList");
    const add = $("drawerAddHolding");
    const detail = $("drawerHoldingDetail");
    if (empty) empty.classList.add("hidden");
    if (list) list.classList.add("hidden");
    if (detail) detail.classList.add("hidden");
    if (add) {
      add.classList.remove("hidden");
      if (prefill) {
        if (prefill.symbol) $("holdSymbol").value = prefill.symbol;
        if (prefill.entry_price != null) $("holdEntry").value = prefill.entry_price;
        if (prefill.quantity != null) $("holdQty").value = prefill.quantity;
      }
    }
  }

  function renderHoldings() {
    renderLearningStats();
  }

  function plannedTradeStatsYtd() {
    if (typeof RMTradeMetrics === "undefined") return null;
    const year = String(new Date().getFullYear());
    const closed = getTrades().filter((t) => {
      const d = t.closed_at || t.opened_at || "";
      return (
        d.startsWith(year) &&
        t.status === "closed" &&
        t.filled !== false &&
        RMTradeMetrics.isPlannedTrade(t)
      );
    });
    if (!closed.length) return null;
    const rs = closed.map((t) => RMTradeMetrics.rMultiple(t)).filter((r) => r != null);
    const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    return { n: closed.length, avgR };
  }

  function renderLearningStats() {
    const el = $("drawerLearningStats") || $("learningStats");
    if (!el) return;
    const parts = [];
    const ytd = plannedTradeStatsYtd();
    if (ytd?.avgR != null) {
      parts.push(
        "YTD expectancy " +
          (ytd.avgR >= 0 ? "+" : "") +
          ytd.avgR.toFixed(2) +
          "R (" +
          ytd.n +
          " planned)"
      );
    }
    if (typeof RMTradeMetrics !== "undefined") {
      const closed = getTrades().filter(
        (t) => t.status === "closed" && RMTradeMetrics.isPlannedTrade(t)
      );
      const deltas = closed.filter((t) => RMTradeMetrics.reconcileStatus(t) === "delta").length;
      if (deltas) parts.push(deltas + " pending reconcile");
      if (closed.length >= 30 && ytd?.avgR != null) {
        parts.push("Expectancy meaningful (30+ n)");
      }
    }
    if (typeof RMHoldings !== "undefined") {
      const s = RMHoldings.stats();
      if (s.closed > 0) {
        parts.push(
          s.winRate != null
            ? "Holdings win " + s.winRate.toFixed(0) + "% (" + s.closed + ")"
            : s.closed + " holdings closed"
        );
        if (s.highRmHitRate != null) {
          parts.push("RM≥50 hit " + s.highRmHitRate.toFixed(0) + "%");
        }
      } else if (!ytd) {
        parts.push("Close planned trades or holdings to build stats");
      }
      if (s.open > 0) parts.unshift(s.open + " open");
    } else if (!ytd) {
      parts.push("Close planned trades to build learning stats");
    }
    el.textContent = parts.join(" · ");
  }

  function saveHoldingFromForm() {
    const sym = ($("holdSymbol").value || "").trim().toUpperCase();
    if (!sym) {
      status("Enter a symbol");
      return;
    }
    const h = RMHoldings.addHolding({
      symbol: sym,
      entry_price: num("holdEntry"),
      quantity: num("holdQty"),
      instrument: $("holdInstrument").value,
      notes: $("holdNotes").value,
      rm_confidence: activePick ? activePick.rm_confidence : null,
      session_id: session ? session.session_id : null,
    });
    $("holdSymbol").value = "";
    $("holdEntry").value = "";
    $("holdQty").value = "1";
    $("holdNotes").value = "";
    status("Holding added: " + h.symbol);
    renderHoldings();
    renderLearningStats();
    renderDrawerHoldings();
  }

  function getTrades() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function getJournalTrades() {
    if (typeof RMSchwabData !== "undefined" && RMSchwabData.getAllTradesForJournal) {
      return RMSchwabData.getAllTradesForJournal(getTrades(), schwabClosedTrades);
    }
    return getTrades();
  }

  async function refreshSchwabJournalTrades() {
    if (typeof RMSchwabData === "undefined" || !RMSchwabData.refreshSchwabTrades) return;
    schwabClosedTrades = await RMSchwabData.refreshSchwabTrades(true);
    if (typeof RMTradeStory !== "undefined" && schwabClosedTrades?.length) {
      for (const t of schwabClosedTrades) {
        if (t.reconciled && (t.realized_r != null || t.r_multiple != null)) {
          void RMTradeStory.syncReconcile(t, { source: "schwab_api" });
        }
      }
    }
    renderResultsOpenTrades();
    renderResultsClosedTrades();
    renderLearningStats();
  }

  function saveTrades(trades) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  }

  function showNewsProgressBar() {
    const wrap = $("newsProgress");
    if (wrap) wrap.classList.remove("hidden");
  }

  let scanProgressPct = 0;
  let scanProgressRaf = null;

  const customScanEta = {
    active: false,
    raf: 0,
    startMs: 0,
    durationMs: 90000,
    fromPct: 0,
    toPct: 92,
    currentPct: 0,
  };

  function stopCustomScanEta() {
    customScanEta.active = false;
    if (customScanEta.raf) {
      cancelAnimationFrame(customScanEta.raf);
      customScanEta.raf = 0;
    }
    const fill = $("scanProgressFill");
    if (fill) fill.classList.remove("is-estimated");
  }

  function tickCustomScanEta(now) {
    if (!customScanEta.active) return;
    const elapsed = now - customScanEta.startMs;
    const t = Math.min(1, elapsed / customScanEta.durationMs);
    const eased = 1 - Math.pow(1 - t, 2.4);
    const pct =
      customScanEta.fromPct + eased * (customScanEta.toPct - customScanEta.fromPct);
    customScanEta.currentPct = Math.max(customScanEta.currentPct, pct);
    applyScanProgressPct(customScanEta.currentPct, { skipTransition: true });
    if (t < 1) {
      customScanEta.raf = requestAnimationFrame(tickCustomScanEta);
    }
  }

  /** Smooth left→right bar sized to approximate time remaining */
  function startCustomScanEta({ durationMs, fromPct = 0, toPct = 92, label }) {
    stopCustomScanEta();
    customScanEta.active = true;
    customScanEta.startMs = performance.now();
    customScanEta.durationMs = Math.max(4000, durationMs);
    customScanEta.fromPct = fromPct;
    customScanEta.toPct = toPct;
    customScanEta.currentPct = fromPct;
    const fill = $("scanProgressFill");
    if (fill) fill.classList.add("is-estimated");
    applyScanProgressPct(fromPct, { skipTransition: true });
    if (label) setScanProgressLabel(label);
    customScanEta.raf = requestAnimationFrame(tickCustomScanEta);
  }

  function extendCustomScanEta({ addMs, toPct, label }) {
    if (!customScanEta.active) return;
    if (customScanEta.raf) cancelAnimationFrame(customScanEta.raf);
    customScanEta.fromPct = customScanEta.currentPct;
    if (toPct != null) customScanEta.toPct = toPct;
    customScanEta.startMs = performance.now();
    customScanEta.durationMs = Math.max(3000, addMs ?? 20000);
    if (label) setScanProgressLabel(label);
    customScanEta.raf = requestAnimationFrame(tickCustomScanEta);
  }

  function finishCustomScanEta(label) {
    stopCustomScanEta();
    applyScanProgressPct(100);
    if (label) setScanProgressLabel(label);
    mirrorScanProgressToPanel();
  }

  function applyScanProgressPct(pct, opts) {
    scanProgressPct = Math.min(100, Math.max(0, pct));
    const fill = $("scanProgressFill");
    const track = document.querySelector(".scan-progress-track");
    if (fill) {
      if (opts?.skipTransition) fill.classList.add("no-transition");
      fill.style.width = scanProgressPct.toFixed(1) + "%";
      if (opts?.skipTransition) {
        fill.offsetWidth;
        fill.classList.remove("no-transition");
      }
    }
    if (track) track.setAttribute("aria-valuenow", String(Math.round(scanProgressPct)));
    mirrorScanProgressToPanel();
  }

  /** index = 1-based symbol index; subFraction 0–1 within that symbol's slot */
  function setScanProgress(index, total, subFraction) {
    if (customScanEta.active) return;
    if (!total) return;
    const slot = 1 / total;
    const base = (index - 1) * slot;
    const pct = (base + slot * Math.min(1, subFraction || 0)) * 100;
    applyScanProgressPct(pct);
  }

  function refreshChartHub(opts) {
    const el = $("chartHubView");
    if (!el || typeof RMChartHub === "undefined") return;
    if (RMChartHub.state?.scanActive) return;
    if (
      opts?.compare !== false &&
      RMChartHub.state?.morningScanViewLock &&
      RMChartHub.state?.overlays?.size > 0 &&
      session?.news_filter_applied_at
    ) {
      return;
    }
    const useCompare =
      opts?.compare === false
        ? false
        : opts?.compare === true ||
          !!(session?.picks?.length && session.news_filter_applied_at);
    void (async () => {
      if (typeof RMAnalysisChart !== "undefined" && !useCompare) {
        RMAnalysisChart.state.symbol = "SPY";
      }
      if (session?.picks?.length && useCompare) {
        if (typeof RMAnalysisChart !== "undefined") {
          RMAnalysisChart.state.symbol = RMAnalysisChart.COMPARE_SYM;
        }
        await RMChartHub.renderComparison(el);
        await RMChartHub.syncFromSession(session.picks, { preserveView: true });
      } else {
        await RMChartHub.renderComparison(el, { fit: useCompare });
        if (session?.picks?.length && RMChartHub.preloadSessionOverlays) {
          await RMChartHub.preloadSessionOverlays(session.picks);
        }
      }
    })();
  }

  async function onSessionLoaded(options) {
    if (!session || !session.picks || !session.picks.length) {
      throw new Error("No symbols found in scan — check CSV has a Symbol column");
    }
    const histLabel = options?.fromHistory
      ? (session.scanned_at || "").slice(0, 16).replace("T", " ") + " · history"
      : null;
    setHeaderMeta(
      histLabel ||
        "Loaded " + (session.pick_count || 0) + " picks — checking news…"
    );
    const mp = $("marketPanel");
    if (mp) {
      mp.classList.remove("hidden");
      mp.removeAttribute("aria-hidden");
    }
    if (typeof RMHoldings !== "undefined") {
      RMHoldings.syncPricesFromPicks(session.picks);
    }
    renderHoldings();
    // Render scan rows immediately — never block on market or news fetches.
    filterMomentumBullSession(session);
    const keepMobileScanLoader = isMobileSnapScans() && options?.fromCustomScan;
    if (typeof RMWorkspaceLoad !== "undefined") {
      if (keepMobileScanLoader) {
        updateScansPanelLoaderStep(
          (session.pick_count || 0) + " picks · checking news…",
          Math.max(42, scanProgressPct || 42)
        );
      } else {
        RMWorkspaceLoad.hidePanelLoader("scans");
      }
    }
    renderPicks();
    if (
      typeof RMWorkspaceAccordion !== "undefined" &&
      (options?.fromCustomScan || options?.runNewsScan)
    ) {
      RMWorkspaceAccordion.expand("scans");
    }
    activePick = null;
    const runNewsScan =
      options?.runNewsScan === true || options?.fromCustomScan === true;
    showScansPanel();
    setScansTab("results", { skipSave: runNewsScan });
    updateResultsActiveSection();
    renderCalendarUi(undefined, "drawer");
    renderCalendarUi(undefined, "results");
    if (!runNewsScan) {
      refreshChartHub({ compare: false });
    }
    persistScanSession({
      entryType: options?.entryType,
      sourceKind: options?.sourceKind,
    });

    if (!options?.skipSidePanels) {
      if (typeof RMMarket !== "undefined" && mp) {
        RMMarket.refreshMarketPanel(mp, session.picks, { soft: true }).catch(() => {});
        syncLiveRefresh();
      }
      refreshMarketThemes();
    }

    if (!runNewsScan) {
      status(
        session.pick_count +
          " picks" +
          (session.news_filter_applied_at
            ? " · catalyst scan saved"
            : options?.fromHistory
              ? " · from history"
              : " · ready")
      );
      return;
    }
    try {
      await searchNews(options?.fromCustomScan ? { estimatedProgress: true } : undefined);
    } catch (e) {
      status(e.message || "News scan failed");
      newsScanRunning = false;
      renderPicks();
    }
  }

  function handleFileSelect(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    if (!file) return;
    showScansPanel();
    setPickListHtml(
      '<p class="status-msg">Reading ' + escapeHtml(file.name) + "…</p>"
    );
    const pickList = $("pickList");
    status("Reading " + file.name + "…");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        if (typeof RMScanParser === "undefined") {
          throw new Error("Parser failed to load — refresh the page");
        }
        session = RMScanParser.parseScanCsvText(reader.result, file.name);
        session.source_kind = "import";
        session.entry_type = "import";
        onSessionLoaded({ runNewsScan: true, entryType: "import", sourceKind: "import" })
          .catch((e) => {
            status(e.message || "Could not load scan");
            if (pickList) {
              pickList.innerHTML =
                '<p class="status-msg pick-error">' +
                escapeHtml(e.message || "Could not load scan") +
                "</p>";
            }
          })
          .finally(() => {
            input.value = "";
          });
      } catch (e) {
        status(e.message || "Could not parse CSV");
        if (pickList) {
          pickList.innerHTML =
            '<p class="status-msg pick-error">' +
            escapeHtml(e.message || "Could not parse CSV") +
            "</p>";
        }
        input.value = "";
      }
    };
    reader.onerror = () => {
      status("Could not read file");
      input.value = "";
    };
    reader.readAsText(file);
  }

  function publishedSessionUrl() {
    return new URL("session.json", window.location.href).href;
  }

  /** Fetch session.json without assigning global session (probe / optional load). */
  async function fetchPublishedSession() {
    const url = publishedSessionUrl();
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.picks || !data.picks.length) return null;
    return data;
  }

  async function loadPublishedSession() {
    const data = await fetchPublishedSession();
    if (!data) return false;
    session = data;
    return true;
  }

  function latestHistoryEntry() {
    if (typeof RMScanStore === "undefined") return null;
    for (const dateKey of RMScanStore.listDays()) {
      const entries = RMScanStore.getDay(dateKey);
      if (entries.length) return { dateKey, entry: entries[0] };
    }
    return null;
  }

  function applyHistorySnapshot(snap, meta) {
    if (!snap?.picks?.length) return false;
    session = {
      hypothesis_id: snap.hypothesis_id || "H-001",
      session_id: snap.session_id,
      scanned_at: snap.scanned_at,
      source_file: snap.source_file || "history",
      session_label: snap.session_label || "history",
      pick_count: snap.picks.length,
      picks: snap.picks,
      filtered_out: snap.filtered_out || [],
      news_scanned_at: snap.news_scanned_at || null,
      news_filter_applied_at: snap.news_scanned_at || null,
      accuracy: snap.accuracy || null,
    };
    if (meta?.dateKey && meta?.entryId) {
      historySelection = { dateKey: meta.dateKey, entryId: meta.entryId };
    }
    return true;
  }

  function scrollToHomeResults() {
    if (typeof RMWorkspaceAccordion !== "undefined") {
      RMWorkspaceAccordion.expand("chart");
    }
    ($("workspaceChart") || $("morningWorkspace"))?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  async function loadHistorySession(dateKey, entryId, opts) {
    if (typeof RMScanStore === "undefined") return false;
    const snap = RMScanStore.loadEntry(dateKey, entryId);
    if (!applyHistorySnapshot(snap, { dateKey, entryId })) {
      status("Could not load scan snapshot");
      return false;
    }
    const focusResults = opts?.focusResults === true;
    const keepDrawer = !focusResults && opts?.keepDrawer !== false;
    if (keepDrawer) {
      if (!$("scanDrawer")?.classList.contains("open")) {
        openScanSettingsDrawer();
      } else {
        setScanDrawerTab("scan");
      }
    }
    if (focusResults) {
      showScansPanel();
      setScansTab("results");
    }
    try {
      await onSessionLoaded({
        fromHistory: true,
        runNewsScan: false,
        focusResults,
      });
      renderCalendarUi(undefined, "drawer");
      renderCalendarUi(undefined, "results");
      if (!focusResults) scrollToHomeResults();
      else {
        $("ttResultsActive")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      const label = (snap.scanned_at || dateKey).slice(0, 16).replace("T", " ");
      showToast("Loaded scan · " + label, "info");
      return true;
    } catch (e) {
      status(e.message || "Load failed");
      return false;
    }
  }

  async function bootRenderPicksProgressive(loadSlot, listRoot) {
    const picks = sortPicksByGapUp(session.picks || []);
    const label = session.session_label ? " · " + session.session_label : "";
    setPageTitle("Rainmaker Morning" + label);
    setHeaderMeta(
      (session.scanned_at || "").slice(0, 16).replace("T", " ") +
        " · " +
        (session.source_file || "") +
        " · " +
        (session.pick_count || 0) +
        " picks"
    );
    const picksHeading = $("picksHeading");
    if (picksHeading) {
      const base = session.news_filter_applied_at
        ? "Scan + news (catalyst only)"
        : WS_COL_TITLE.scans;
      picksHeading.textContent = base + " · gap ↑";
    }

    listRoot.innerHTML = "";
    const removed = session.filtered_out || [];
    if (removed.length) {
      await loadSlot(listRoot, "Scan status", async (slot) => {
        slot.innerHTML =
          '<p class="status-msg pick-removed-banner">Removed ' +
          removed.length +
          " without news today: " +
          escapeHtml(removed.map((x) => x.symbol).join(", ")) +
          "</p>";
      });
    }

    if (!picks.length) {
      await loadSlot(listRoot, WS_COL_TITLE.scans, async (slot) => {
        slot.innerHTML = '<p class="status-msg">No picks to show.</p>';
      });
      return;
    }

    let bannerHtml = "";
    if (removed.length) {
      bannerHtml =
        '<p class="status-msg pick-removed-banner">Removed ' +
        removed.length +
        " without news today: " +
        escapeHtml(removed.map((x) => x.symbol).join(", ")) +
        "</p>";
    }
    if (
      typeof RMVirtualPickList !== "undefined" &&
      RMVirtualPickList.shouldVirtualize(picks.length)
    ) {
      await loadSlot(listRoot, WS_COL_TITLE.scans, async (slot) => {
        RMVirtualPickList.mount(slot, {
          renderRow: renderPickRow,
          bind: bindPickListSubtree,
        });
        RMVirtualPickList.render(picks, bannerHtml);
      });
      renderScanMetricsStrip();
      if (!newsScanRunning) refreshChartHub();
      return;
    }

    const stream = document.createElement("div");
    stream.className = "pick-list-stream";
    listRoot.appendChild(stream);

    for (const p of picks) {
      const rowSlot = document.createElement("div");
      stream.appendChild(rowSlot);
      await loadSlot(rowSlot, p.symbol, async (slot) => {
        slot.outerHTML = renderPickRow(p);
      });
    }

    bindPickAccordions(listRoot);
    bindRmScoreTooltips(listRoot);
    bindUiTips(listRoot);
    renderScanMetricsStrip();
    if (!newsScanRunning) refreshChartHub();
  }

  function isMobilePerfBoot() {
    return typeof RMMobilePerf !== "undefined" && RMMobilePerf.isMobilePerf();
  }

  const noopLoadSlot = async (el, _label, fn) => {
    if (el) await fn(el);
  };

  function registerMobileWarmHooks() {
    if (typeof RMMobilePerf === "undefined") return;
    RMMobilePerf.registerWarmHooks({
      warmChart: async () => {
        const panel = document.getElementById("workspaceChart");
        if (panel?.classList.contains("ws-panel--ready")) return;
        if (typeof RMWorkspaceLoad !== "undefined") {
          await RMWorkspaceLoad.runColumn("chart", bootChartColumn);
        } else {
          await bootChartColumn(noopLoadSlot);
        }
      },
      warmScans: async () => {
        const panel = document.getElementById("workspaceScans");
        if (panel?.classList.contains("ws-panel--ready")) return;
        if (typeof RMWorkspaceLoad !== "undefined") {
          await RMWorkspaceLoad.runColumn("scans", bootScansColumn);
        } else {
          await bootScansColumn(noopLoadSlot);
        }
      },
    });
  }

  async function awaitMarketThemesRefresh(themesEl) {
    if (!themesEl || typeof RMMarketThemes === "undefined") return;
    await RMMarketThemes.refresh(themesEl, { picks: session?.picks || [] });
  }

  async function bootMarketColumn(loadSlot) {
    const themes = $("marketThemes");
    const mp = $("marketPanel");
    if (mp) {
      mp.classList.remove("hidden");
      mp.removeAttribute("aria-hidden");
    }

    const indicesJob =
      typeof RMMarket !== "undefined" ? RMMarket.prefetchIndices() : Promise.resolve({});

    const indices = await indicesJob;
    await loadSlot(mp, WS_COL_TITLE.market, async (el) => {
      if (typeof RMMarket !== "undefined") {
        try {
          await RMMarket.refreshMarketPanelProgressive(
            el,
            session?.picks || [],
            loadSlot,
            { indices, mobilePerf: isMobilePerfBoot() }
          );
        } catch {
          el.innerHTML =
            '<div class="mkt-grid"><div class="mkt-tile"><span class="mkt-tile-label">Market</span><span class="mkt-tile-val">Offline</span></div></div>';
        }
      }
    });
    syncLiveRefresh();

    await loadSlot(themes, "Theme heat", async (el) => {
      await awaitMarketThemesRefresh(el);
    });
  }

  async function bootChartColumn(loadSlot) {
    const el = $("chartHubView");
    try {
      globalThis.__rmChartBootApiOnly = true;
      if (typeof RMChartHub !== "undefined" && RMChartHub.renderComparisonProgressive) {
        await RMChartHub.renderComparisonProgressive(el, loadSlot);
        syncBackgroundActivity();
        await bootstrapSchwabForDashboard();
        return;
      }
      if (typeof RMChartHub !== "undefined") {
        await loadSlot(el, WS_COL_TITLE.chart, async (slot) => {
          await RMChartHub.renderComparison(slot);
        });
      }
      syncBackgroundActivity();
      await bootstrapSchwabForDashboard();
    } finally {
      globalThis.__rmChartBootApiOnly = false;
    }
  }

  async function bootScansColumn(loadSlot) {
    const listRoot = $("pickList");
    loadScansTabPref();

    if (!session?.picks?.length) {
      session = null;
      setScansPanelDismissed(false);
    }

    await loadSlot(listRoot, "Getting started", async () => {
      setScansTab(scansTab, { skipSave: true });
      if (typeof RMResultsHero !== "undefined") RMResultsHero.showDefault();
    });
    status("SPY chart ready · Import or scan to load picks");
  }

  function ensureCleanBootState() {
    session = null;
    activePick = null;
    historySelection = null;
    if (typeof RMChartHub !== "undefined") {
      RMChartHub.resetOverlays?.();
      RMChartHub.state.sessionPicks = [];
    }
    if (typeof RMMarket !== "undefined") RMMarket.stopLivePickRefresh?.();
  }

  function bootstrapSchwabForDashboard() {
    if (typeof RMChunkLoader === "undefined") return Promise.resolve();
    return RMChunkLoader.ensureBroker()
      .then(() => {
        if (typeof RMSchwab !== "undefined" && RMSchwab.bootstrapDashboard) {
          return RMSchwab.bootstrapDashboard();
        }
        if (typeof RMSchwab !== "undefined" && RMSchwab.render) {
          return RMSchwab.render();
        }
      })
      .catch(() => {});
  }

  async function boot() {
    if (typeof RMMetrics !== "undefined") {
      RMMetrics.markMorningOpen({ embed: document.body.classList.contains("is-embed") });
    }
    if (typeof RMSchwabData !== "undefined" && RMSchwabData.applyRealJournalCutover) {
      RMSchwabData.applyRealJournalCutover();
    }
    ensureCleanBootState();
    ensureDrawersClosed();
    loadScansTabPref();
    if (typeof RMWorkspaceLoad !== "undefined") RMWorkspaceLoad.init();
    if (typeof RMBrandLogo !== "undefined") RMBrandLogo.mount();
    if (typeof RMChunkLoader !== "undefined") {
      RMChunkLoader.preloadNonCritical();
    }
    if (typeof RMAgent !== "undefined") RMAgent.mount();
    renderDrawerYtd();
    renderHoldings();
    void refreshSchwabJournalTrades();

    if (typeof RMScanStore !== "undefined") {
      void RMScanStore.syncPublishedCatalog(window.location.href).catch((e) => {
        console.warn("scan catalog sync", e);
      });
    }

    const runners = {
      market: bootMarketColumn,
      chart: bootChartColumn,
      scans: bootScansColumn,
    };

    registerMobileWarmHooks();

    try {
      if (typeof RMWorkspaceLoad !== "undefined") {
        if (isMobilePerfBoot()) {
          await RMWorkspaceLoad.runColumn("market", runners.market);
          if (typeof RMWorkspaceAccordion !== "undefined") {
            RMWorkspaceAccordion.onColumnReady("market");
          }
          if (typeof RMWorkspaceLoad !== "undefined") RMWorkspaceLoad.finish();
          if (typeof RMMobilePerf !== "undefined") RMMobilePerf.warmAfterMarket();
          syncBackgroundActivity();
          return;
        }
        for (const col of RMWorkspaceLoad.columnOrder()) {
          await RMWorkspaceLoad.runColumn(col, runners[col]);
        }
        return;
      }

      const directSlot = async (el, _label, fn) => {
        if (el) await fn(el);
      };
      await bootMarketColumn(directSlot);
      if (typeof RMWorkspaceAccordion !== "undefined") {
        RMWorkspaceAccordion.onColumnReady("market");
      }
      await bootChartColumn(directSlot);
      if (typeof RMWorkspaceAccordion !== "undefined") {
        RMWorkspaceAccordion.onColumnReady("chart");
      }
      await bootScansColumn(directSlot);
    } finally {
      if (typeof RMWorkspaceLoad !== "undefined") RMWorkspaceLoad.finish();
      if (typeof RMWorkspaceAccordion !== "undefined") RMWorkspaceAccordion.sync?.();
      syncBackgroundActivity();
    }
  }

  function formatPct(n) {
    if (n == null || n === "") return null;
    const v = Number(n);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function priceMoveClass(v) {
    if (v > 0.05) return "move-up";
    if (v < -0.05) return "move-down";
    return "move-flat";
  }

  function formatGapBadge(gapPct) {
    if (gapPct == null || gapPct === "") return "";
    const v = Number(gapPct);
    if (Number.isNaN(v) || v <= 0) return "";
    return (
      '<span class="pick-gap price-move move-up fv-tip-target" tabindex="0"' +
      fvTipData(
        "Gap up",
        "Opening gap",
        "Percent above prior close at the open. Morning momentum filter favors gap-up names.",
        "Gap " + formatPct(v)
      ) +
      '">' +
      '<span class="move-arrow" aria-hidden="true">↑</span>' +
      '<span class="move-pct">Gap ' +
      formatPct(v) +
      "</span></span>"
    );
  }

  function formatEodBadge(pctEod, pctChange) {
    const v =
      pctEod != null && pctEod !== ""
        ? Number(pctEod)
        : pctChange != null
          ? Number(pctChange)
          : null;
    if (v == null || Number.isNaN(v)) return "";
    const cls = priceMoveClass(v);
    const label = pctEod != null ? "EOD" : "Day";
    return (
      '<span class="pick-eod price-move ' +
      cls +
      ' fv-tip-target" tabindex="0"' +
      fvTipData(
        "Session move",
        label + " change",
        "Percent vs prior close through session close or latest quote.",
        label + " " + formatPct(v)
      ) +
      '">' +
      '<span class="move-pct">' +
      label +
      " " +
      formatPct(v) +
      "</span></span>"
    );
  }

  function isConfirmedPick(p) {
    const cat = p.catalyst || {};
    return cat.verified === true || (cat.headlines && cat.headlines.length > 0);
  }

  function filterMomentumBullSession(sess) {
    if (!sess?.picks) return sess;
    const removed = [];
    sess.picks = sess.picks.filter((p) => {
      if (p.pct_change != null && Number(p.pct_change) < 0) {
        removed.push({ symbol: p.symbol, reason: "gap_down_or_negative_day" });
        return false;
      }
      if (p.gap_pct != null && Number(p.gap_pct) < 0) {
        removed.push({ symbol: p.symbol, reason: "gap_down" });
        return false;
      }
      return true;
    });
    if (removed.length) {
      sess.filtered_out = (sess.filtered_out || []).concat(removed);
      showToast(
        "Removed " +
          removed.length +
          " non-bull names: " +
          removed.map((x) => x.symbol).join(", "),
        "warn"
      );
    }
    sess.pick_count = sess.picks.length;
    return sess;
  }

  function renderPriceMove(pctChange) {
    if (pctChange == null || pctChange === "") return "";
    const v = Number(pctChange);
    if (Number.isNaN(v)) return "";
    const cls = priceMoveClass(v);
    const arrow = v > 0.05 ? "▲" : v < -0.05 ? "▼" : "■";
    const text = formatPct(v);
    return (
      '<span class="price-move ' +
      cls +
      ' fv-tip-target" tabindex="0"' +
      fvTipData(
        "Day move",
        "Session change",
        "Percent change vs prior close through the latest quote.",
        text
      ) +
      '"><span class="move-arrow" aria-hidden="true">' +
      arrow +
      '</span><span class="move-pct">' +
      text +
      "</span></span>"
    );
  }

  function headlineSentiment(title, summary, stored) {
    if (stored) return stored;
    if (typeof RMNewsScan !== "undefined" && RMNewsScan.headlineSentiment) {
      return RMNewsScan.headlineSentiment(title, summary || "");
    }
    return "neutral";
  }

  function renderTrendArrow(sentiment, titleAttr) {
    const tip = titleAttr ? ' title="' + escapeAttr(titleAttr) + '"' : "";
    if (sentiment === "up") {
      return (
        '<span class="trend-arrow trend-up"' +
        tip +
        ' aria-label="Bullish news tone">▲</span>'
      );
    }
    if (sentiment === "down") {
      return (
        '<span class="trend-arrow trend-down"' +
        tip +
        ' aria-label="Bearish news tone">▼</span>'
      );
    }
    return (
      '<span class="trend-arrow trend-neutral"' +
      tip +
      ' aria-label="Neutral news tone">◆</span>'
    );
  }

  function renderHeadlineItem(h) {
    const title = h.title || "";
    const sentiment = headlineSentiment(title, h.summary, h.sentiment);
    const sentLabel =
      sentiment === "up"
        ? "Bullish tone"
        : sentiment === "down"
          ? "Bearish tone"
          : "Neutral tone";
    const arrow = renderTrendArrow(sentiment);
    const safeTitle = escapeHtml(title);
    const tip = fvTipData(
      "Headline",
      tipTruncate(title, 72),
      tipTruncate(h.summary || title, 180),
      sentLabel
    );
    const url = h.url || h.source_url;
    if (url) {
      return (
        '<li class="pick-news-item trend-' +
        sentiment +
        ' fv-tip-target" tabindex="0"' +
        tip +
        ">" +
        arrow +
        '<a href="' +
        escapeAttr(url) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
        safeTitle +
        "</a></li>"
      );
    }
    return (
      '<li class="pick-news-item trend-' +
      sentiment +
      ' fv-tip-target" tabindex="0"' +
      tip +
      ">" +
      arrow +
      safeTitle +
      "</li>"
    );
  }

  function formatVol(n) {
    if (n == null) return null;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(Math.round(n));
  }

  function pickHeadlines(cat) {
    if (!cat) return [];
    if (cat.headlines && cat.headlines.length) return cat.headlines;
    if (cat.headline) {
      return [{ title: cat.headline, url: cat.source_url || null }];
    }
    return [];
  }

  function renderPickCollapsedStats(p) {
    const gap =
      p.gap_pct != null && Number(p.gap_pct) > 0
        ? "Gap " + formatPct(Number(p.gap_pct))
        : "Gap —";
    const eodVal =
      p.pct_eod != null && p.pct_eod !== ""
        ? Number(p.pct_eod)
        : p.pct_change != null
          ? Number(p.pct_change)
          : null;
    const eod = eodVal != null && !Number.isNaN(eodVal) ? "EOD " + formatPct(eodVal) : "EOD —";
    const rm = pickScore(p);
    const rmTxt =
      rm != null && !Number.isNaN(Number(rm)) ? "RM " + Math.round(Number(rm)) : "RM —";
    let base = gap + " · " + eod + " · " + rmTxt;
    const closed = latestJournalTradeForPick(p, "closed");
    if (closed && closed.filled !== false && closed.status !== "not_filled") {
      const rTxt = pickClosedRText(closed);
      if (rTxt) base += " · " + rTxt;
    }
    return base;
  }

  function tradeMatchesPickSession(t, p) {
    const sym = String(p?.symbol || "").toUpperCase();
    if (String(t?.symbol || "").toUpperCase() !== sym) return false;
    const sid = session?.session_id;
    if (sid && t.session_id && t.session_id !== sid) return false;
    return true;
  }

  function latestJournalTradeForPick(p, status) {
    if (!p?.symbol) return null;
    const want = status ? String(status) : null;
    return (
      getJournalTrades()
        .filter((t) => {
          if (!tradeMatchesPickSession(t, p)) return false;
          if (want === "closed") {
            return t.status === "closed" || t.status === "not_filled";
          }
          if (want && t.status !== want) return false;
          return true;
        })
        .sort(
          (a, b) =>
            (Date.parse(b.closed_at || b.opened_at || "") || 0) -
            (Date.parse(a.closed_at || a.opened_at || "") || 0)
        )[0] || null
    );
  }

  function pickClosedRText(trade) {
    if (!trade || (trade.status !== "closed" && trade.status !== "not_filled")) return null;
    if (trade.filled === false || trade.status === "not_filled") return null;
    if (typeof RMTradeMetrics !== "undefined") {
      const rr = RMTradeMetrics.realizedR(trade) ?? RMTradeMetrics.rMultiple?.(trade);
      if (rr != null && Number.isFinite(rr)) {
        return (rr >= 0 ? "+" : "") + Number(rr).toFixed(2) + "R";
      }
    }
    const legacy = tradeRMultiple(trade);
    if (legacy != null && Number.isFinite(legacy)) {
      return (legacy >= 0 ? "+" : "") + Number(legacy).toFixed(2) + "R";
    }
    return null;
  }

  function pickClosedSummaryHtml(trade) {
    if (!trade) return "";
    if (trade.filled === false || trade.status === "not_filled") {
      return '<p class="meta pick-closed-summary">Closed not filled</p>';
    }
    const parts = [];
    const rTxt = pickClosedRText(trade);
    parts.push(rTxt ? "Closed " + rTxt : "Closed · R N/A");
    let pnl = trade.pnl_usd;
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.pnlUsd) {
      const computed = RMTradeMetrics.pnlUsd(trade);
      if (computed != null && Number.isFinite(computed)) pnl = computed;
    }
    if (pnl != null && Number.isFinite(pnl)) {
      parts.push((pnl >= 0 ? "+" : "") + fmtUsd(pnl));
    }
    return '<p class="meta pick-closed-summary">' + escapeHtml(parts.join(" · ")) + "</p>";
  }

  function pickTradeActionHtml(p) {
    const closed = latestJournalTradeForPick(p, "closed");
    if (closed) {
      return (
        pickClosedSummaryHtml(closed) +
        '<button type="button" class="btn btn-ghost btn-sm pick-view-result-btn">View result</button>'
      );
    }
    if (latestJournalTradeForPick(p, "open")) {
      return (
        '<button type="button" class="btn btn-ghost btn-sm pick-trade-btn pick-manage-btn">Manage trade</button>'
      );
    }
    return '<button type="button" class="btn btn-ghost btn-sm pick-trade-btn">Plan trade</button>';
  }

  function focusClosedTradeResult(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return;
    const pick = (session?.picks || []).find((x) => x.symbol === sym) || { symbol: sym };
    const trade = latestJournalTradeForPick(pick, "closed");
    showScansPanel();
    setScansTab("results", { skipHero: true });
    renderResultsClosedTrades();
    if (trade?.id && typeof RMTradeDebrief !== "undefined") {
      RMTradeDebrief.highlightClosedTradeRow?.(trade.id);
      void RMTradeDebrief.focusChartForDebrief?.(trade);
    } else if (trade) {
      selectTicker(sym, { skipHero: true, snapChart: true });
    }
    $("ttResultsClosed")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const PICK_FB_KEY = "rainmaker_pick_feedback_v1";
  const THUMB_UP_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M2 21h2.5a1 1 0 0 0 1-1V11a1 1 0 0 0-1-1H2zM21.7 11.3a1.6 1.6 0 0 0-1.2-.5H14l.9-4.3a1.7 1.7 0 0 0-1.7-2.1c-.5 0-1 .2-1.3.6L7.5 10v10h10a1.7 1.7 0 0 0 1.7-1.4l1.3-5.6a1.6 1.6 0 0 0-.8-1.7z"/></svg>';
  const THUMB_DOWN_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M22 3h-2.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H22zM2.3 12.7a1.6 1.6 0 0 0 1.2.5H10l-.9 4.3a1.7 1.7 0 0 0 1.7 2.1c.5 0 1-.2 1.3-.6L16.5 14V4h-10A1.7 1.7 0 0 0 4.8 5.4L3.5 11a1.6 1.6 0 0 0 .8 1.7z"/></svg>';

  function loadPickFeedback() {
    try {
      return JSON.parse(localStorage.getItem(PICK_FB_KEY)) || {};
    } catch {
      return {};
    }
  }
  function pickFbId(sym) {
    const s = session?.session_id || session?.scanned_at || "session";
    return s + ":" + String(sym || "").toUpperCase();
  }
  function getPickFeedback(sym) {
    return loadPickFeedback()[pickFbId(sym)] || null;
  }
  function savePickFeedback(sym, vote, note) {
    const all = loadPickFeedback();
    const id = pickFbId(sym);
    const prev = all[id] || {};
    if (vote == null && !note && !prev.vote) {
      delete all[id];
    } else {
      all[id] = {
        symbol: String(sym || "").toUpperCase(),
        vote: vote !== undefined ? vote : prev.vote || null,
        note: note != null ? note : prev.note || "",
        at: Date.now(),
      };
    }
    try {
      localStorage.setItem(PICK_FB_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
    if (typeof RMMetrics !== "undefined" && RMMetrics.track) {
      RMMetrics.track("pick_feedback", {
        symbol: String(sym || "").toUpperCase(),
        vote: all[id]?.vote || null,
        note: all[id]?.note || "",
      });
    }
  }

  function pickFeedbackHtml(p) {
    const fb = getPickFeedback(p.symbol);
    return (
      '<div class="pick-feedback" role="group" aria-label="Rate ' +
      escapeAttr(p.symbol) +
      '">' +
      '<button type="button" class="pick-fb-btn pick-fb-up' +
      (fb?.vote === "up" ? " is-active" : "") +
      '" data-fb="up" aria-label="Good call">' +
      THUMB_UP_SVG +
      "</button>" +
      '<button type="button" class="pick-fb-btn pick-fb-down' +
      (fb?.vote === "down" ? " is-active" : "") +
      '" data-fb="down" aria-label="Not for me — hide">' +
      THUMB_DOWN_SVG +
      "</button>" +
      '<input type="text" class="pick-fb-note" placeholder="Why? (optional)" value="' +
      escapeAttr(fb?.note || "") +
      '"/>' +
      "</div>"
    );
  }

  function renderPickRow(p) {
    const cat = p.catalyst || {};
    const headlines = pickHeadlines(cat);
    const metricsParts = [];
    if (p.last != null) {
      metricsParts.push(
        '<span class="pick-price">$' + Number(p.last).toFixed(2) + "</span>"
      );
    }
    const gapHtml = formatGapBadge(p.gap_pct);
    if (gapHtml) metricsParts.push(gapHtml);
    const dayHtml = renderPriceMove(p.pct_change);
    if (dayHtml) metricsParts.push(dayHtml);
    const eodHtml = formatEodBadge(p.pct_eod, p.pct_change);
    if (eodHtml) metricsParts.push(eodHtml);
    const vol = formatVol(p.volume);
    if (vol) metricsParts.push('<span class="pick-vol">vol ' + vol + "</span>");

    const metricsHtml = metricsParts.length
      ? '<div class="pick-metrics">' + metricsParts.join("") + "</div>"
      : "";

    const topSent = cat.headline_sentiment;
    const catalystExtra = topSent
      ? " " +
        renderTrendArrow(
          topSent,
          topSent === "up"
            ? "Top headline tone: bullish"
            : topSent === "down"
              ? "Top headline tone: bearish"
              : "Top headline tone: neutral"
        )
      : "";

    let newsHtml = "";
    if (headlines.length) {
      newsHtml =
        '<ul class="pick-news-list">' +
        headlines.map(renderHeadlineItem).join("") +
        "</ul>";
    } else if (session && session.news_scanned_at) {
      newsHtml =
        '<p class="pick-sub">No stock-worthy headlines in scan window.</p>';
    }

    const rm = pickScore(p);
    const rmStat =
      rm != null && !Number.isNaN(Number(rm)) ? "RM " + Math.round(Number(rm)) : "";
    const inAccount =
      typeof RMHoldings !== "undefined" &&
      RMHoldings.getBrokerSymbols &&
      RMHoldings.getBrokerSymbols()[p.symbol]
        ? '<span class="pick-in-account" title="Open in your Schwab account">In account</span>'
        : "";

    return (
      '<details class="pick-accordion pick-row' +
      (pickListScanningSym === p.symbol ? " pick-row-scanning" : "") +
      '" data-symbol="' +
      escapeAttr(p.symbol) +
      '">' +
      '<summary class="pick-accordion-summary">' +
      '<span class="pick-acc-left">' +
      '<span class="sym fv-tip-target" tabindex="0"' +
      fvTipData(
        "Pick",
        p.symbol,
        "Expand for news and metrics, or open trade plan.",
        rmStat
      ) +
      ">" +
      escapeHtml(p.symbol) +
      "</span>" +
      inAccount +
      '<span class="pick-collapsed-stats">' +
      escapeHtml(renderPickCollapsedStats(p)) +
      "</span></span>" +
      renderRmScoreMeter(p, "row") +
      "</summary>" +
      '<div class="pick-accordion-body">' +
      '<div class="pick-row-top">' +
      '<div class="pick-row-title">' +
      metricsHtml +
      catalystExtra +
      "</div></div>" +
      newsHtml +
      '<div class="pick-row-actions">' +
      pickTradeActionHtml(p) +
      pickFeedbackHtml(p) +
      "</div>" +
      "</div></details>"
    );
  }

  function bindPickAccordions(root) {
    if (!root) return;
    root.querySelectorAll(".pick-accordion").forEach((el) => {
      el.querySelector(".pick-trade-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPick(el.dataset.symbol);
      });
      el.querySelector(".pick-manage-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPick(el.dataset.symbol);
      });
      el.querySelector(".pick-view-result-btn")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        focusClosedTradeResult(el.dataset.symbol);
      });
      el.querySelector(".sym")?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPick(el.dataset.symbol);
      });
      el.querySelectorAll(".pick-fb-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const vote = btn.dataset.fb;
          const noteEl = el.querySelector(".pick-fb-note");
          savePickFeedback(el.dataset.symbol, vote, noteEl?.value || "");
          el.querySelectorAll(".pick-fb-btn").forEach((b) =>
            b.classList.toggle("is-active", b === btn)
          );
          if (vote === "down") {
            // Hide from the UI; the vote persists (and is reported via track).
            el.classList.add("pick-row--dismissed");
            setTimeout(() => el.remove(), 260);
          }
        });
      });
      const noteEl = el.querySelector(".pick-fb-note");
      if (noteEl) {
        ["click", "keydown", "pointerdown"].forEach((evt) =>
          noteEl.addEventListener(evt, (e) => e.stopPropagation())
        );
        noteEl.addEventListener("input", () =>
          savePickFeedback(el.dataset.symbol, undefined, noteEl.value)
        );
      }
    });
  }

  function mountPickInlineCharts() {
    if (typeof RMChartHub === "undefined") return;
    const listRoot = $("pickList");
    if (!listRoot) return;

    if (pickChartObserver) {
      pickChartObserver.disconnect();
      pickChartObserver = null;
    }

    if (typeof IntersectionObserver === "undefined") {
      listRoot.querySelectorAll("[data-pick-chart]").forEach((el) => {
        const sym = el.dataset.pickChart;
        if (sym) RMChartHub.renderPickMini(sym, el);
      });
      return;
    }

    listRoot.querySelectorAll("[data-pick-chart]").forEach((el) => {
      observePickChartElement(el);
    });
  }

  function renderPicks() {
    if (!session) return;
    const label = session.session_label ? " · " + session.session_label : "";
    setPageTitle("Rainmaker Morning" + label);
    setHeaderMeta(
      (session.scanned_at || "").slice(0, 16).replace("T", " ") +
        " · " +
        (session.source_file || "") +
        " · " +
        (session.pick_count || 0) +
        " picks"
    );

    // Thumbs-down picks are hidden from the UI but stay in session/storage.
    const picks = sortPicksByGapUp(session.picks || []).filter(
      (p) => getPickFeedback(p.symbol)?.vote !== "down"
    );
    const picksHeading = $("picksHeading");
    if (picksHeading) {
      const base = session.news_filter_applied_at
        ? "Scan + news (catalyst only)"
        : WS_COL_TITLE.scans;
      picksHeading.textContent = base + " · gap ↑";
    }

    let banner = "";
    const removed = session.filtered_out || [];
    if (removed.length) {
      banner =
        '<p class="status-msg pick-removed-banner">Removed ' +
        removed.length +
        " without news today: " +
        escapeHtml(removed.map((x) => x.symbol).join(", ")) +
        "</p>";
    }

    if (!picks.length) {
      setPickListHtml(banner + '<p class="status-msg">No picks to show.</p>');
      return;
    }

    renderPickListContent(picks, banner);

    const listRoot = $("pickList");
    if (!listRoot) return;
    renderScanMetricsStrip();
    updateResultsActiveSection();
    renderCalendarUi(undefined, "results");
    if (!newsScanRunning) {
      const skipHubRefresh =
        RMChartHub?.state?.morningScanViewLock &&
        RMChartHub?.state?.overlays?.size > 0 &&
        session?.news_filter_applied_at;
      if (!skipHubRefresh) refreshChartHub();
    }
    document.dispatchEvent(new CustomEvent("rm:results-content-updated"));
  }

  function setInstrumentTab(kind) {
    instrument = kind === "option" ? "option" : "stock";
    const stock = $("tabStock");
    const opt = $("tabOption");
    if (!stock || !opt) return;
    const isStock = instrument === "stock";
    stock.classList.toggle("active", isStock);
    stock.setAttribute("aria-selected", isStock ? "true" : "false");
    opt.classList.toggle("active", !isStock);
    opt.setAttribute("aria-selected", !isStock ? "true" : "false");
    renderPlanFields();
  }

  function openOrderDrawer() {
    const backdrop = $("orderBackdrop");
    const drawer = $("orderDrawer");
    if (!backdrop || !drawer) return;
    drawer.inert = false;
    backdrop.classList.remove("hidden");
    backdrop.setAttribute("aria-hidden", "false");
    drawer.classList.remove("is-closed");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
  }

  function blurDrawerFocus(drawer) {
    const ae = document.activeElement;
    if (ae && drawer?.contains(ae)) ae.blur();
    if (drawer) drawer.inert = true;
  }

  function closeOrderDrawer() {
    const backdrop = $("orderBackdrop");
    const drawer = $("orderDrawer");
    if (!backdrop || !drawer) return;
    blurDrawerFocus(drawer);
    backdrop.classList.add("hidden");
    backdrop.setAttribute("aria-hidden", "true");
    drawer.classList.remove("open");
    drawer.classList.add("is-closed");
    drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("drawer-open");
    document.querySelectorAll(".pick-row-selected").forEach((el) => {
      el.classList.remove("pick-row-selected");
    });
    activePick = null;
    if (!$("scanDrawer")?.classList.contains("open")) {
      document.body.classList.remove("drawer-open");
    }
  }

  function populateOrderDrawer(p) {
    const symbol = p.symbol;
    const meter = $("drawerRmMeter");
    if (meter) {
      meter.innerHTML = renderRmScoreMeter(p, "drawer");
      bindRmScoreTooltips(meter);
    }
    const cat = p.catalyst || {};
    const newsEl = $("drawerNews");
    if (newsEl) {
      if (cat.headline && cat.source_url) {
        newsEl.innerHTML =
          '<a href="' +
          escapeAttr(cat.source_url) +
          '" target="_blank" rel="noopener">' +
          escapeHtml(cat.headline) +
          "</a>";
      } else if (cat.headline) {
        newsEl.textContent = cat.headline;
      } else if (cat.status === "news_error") {
        newsEl.textContent = "News fetch failed — pick kept for manual review.";
      } else {
        newsEl.textContent = "No catalyst headlines loaded yet.";
      }
    }
    setInstrumentTab("stock");
    $("closePanel").classList.add("hidden");
  }

  function openPick(symbol) {
    selectTicker(symbol);
  }

  function renderPlanFields() {
    const isOpt = instrument === "option";
    const stock = $("stockFields");
    const opt = $("optionFields");
    if (stock) stock.classList.toggle("hidden", isOpt);
    if (opt) opt.classList.toggle("hidden", !isOpt);
  }

  function initNewsProgress(symbols, opts) {
    const wrap = $("newsProgress");
    const seg = $("scanProgressSegments");
    const fill = $("scanProgressFill");
    const track = wrap && wrap.querySelector(".scan-progress-track");
    if (!wrap || !seg || !fill) return;

    seg.innerHTML = symbols
      .map(
        (s) =>
          '<div class="scan-segment pending" data-symbol="' +
          escapeAttr(s) +
          '" title="' +
          escapeAttr(s) +
          '"><span>' +
          escapeHtml(s) +
          "</span></div>"
      )
      .join("");

    if (!opts?.keepProgress) {
      applyScanProgressPct(0);
    }
    if (track) {
      track.setAttribute("aria-valuemax", "100");
    }
    setScanProgressLabel("Starting news scan…");
    wrap.classList.remove("hidden");
    mirrorScanProgressToPanel();
    const nr = $("newsResults");
    if (nr) nr.innerHTML = "";
  }

  function updateNewsProgress(sym, n, total, result) {
    if (result) {
      setScanProgress(n, total, 1);
    }

    if (result) {
      const el = document.querySelector(
        '.scan-segment[data-symbol="' + sym + '"]'
      );
      if (el) {
        el.classList.remove("pending", "active");
        if (result.error) el.classList.add("done-error");
        else if (result.hasCatalyst) el.classList.add("done-ok");
        else el.classList.add("done-none");
      }
      setScanProgressLabel(
        "Scanned " + sym + " (" + n + " of " + total + ")"
      );
    } else {
      document.querySelectorAll(".scan-segment").forEach((el) => {
        el.classList.remove("active");
        if (el.dataset.symbol === sym) el.classList.add("active");
      });
      setScanProgressLabel(
        "Scanning " + sym + "… (" + n + " of " + total + ")"
      );
    }
    mirrorScanProgressToPanel();
  }

  function hideNewsProgress() {
    const wrap = $("newsProgress");
    if (wrap) wrap.classList.add("hidden");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findPickRow(symbol) {
    return document.querySelector(
      '.pick-row[data-symbol="' + symbol + '"]'
    );
  }

  function findScanSegment(symbol) {
    return document.querySelector(
      '.scan-segment[data-symbol="' + symbol + '"]'
    );
  }

  function animateRemoveSymbol(symbol) {
    return new Promise((resolve) => {
      const row = findPickRow(symbol);
      const seg = findScanSegment(symbol);
      if (!row && !seg) {
        resolve();
        return;
      }
      if (row) row.classList.add("pick-row-exit");
      if (seg) seg.classList.add("segment-exit");
      setTimeout(() => {
        if (row) row.remove();
        if (seg) seg.remove();
        resolve();
      }, 520);
    });
  }

  function removePickFromSession(result) {
    const pick = (session.picks || []).find((p) => p.symbol === result.symbol);
    if (!pick) return;
    session.filtered_out = session.filtered_out || [];
    session.filtered_out.push({
      symbol: result.symbol,
      rm_confidence: pick.rm_confidence,
      reason:
        result.reason ||
        (result.error ? "news_fetch_error" : "no_stock_worthy_news_today"),
    });
    session.picks = session.picks.filter((p) => p.symbol !== result.symbol);
    session.pick_count = session.picks.length;
    if (activePick && activePick.symbol === result.symbol) {
      closeOrderDrawer();
      activePick = null;
    }
  }

  function updateRemovedBannerLive() {
    const banner = document.getElementById("pickRemovedBanner");
    const removed = session.filtered_out || [];
    if (!removed.length) {
      if (banner) banner.remove();
      return;
    }
    const html =
      "Removed " +
      removed.length +
      " (no catalyst): " +
      removed.map((x) => x.symbol).join(", ");
    if (banner) {
      banner.textContent = html;
    } else {
      const el = document.createElement("p");
      el.id = "pickRemovedBanner";
      el.className = "status-msg pick-removed-banner";
      el.textContent = html;
      const list = $("pickList");
      if (list) list.insertBefore(el, list.firstChild);
    }
  }

  function refreshPickRow(symbol) {
    const pick = (session.picks || []).find((p) => p.symbol === symbol);
    if (!pick) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = renderPickRow(pick);
    const newRow = wrap.firstElementChild;
    if (!newRow) return;
    if (
      typeof RMVirtualPickList !== "undefined" &&
      RMVirtualPickList.isActive() &&
      RMVirtualPickList.updateRow(symbol, newRow.outerHTML)
    ) {
      const win = $("pickList")?.querySelector(".pick-list-virtual-window");
      if (win) bindPickListSubtree(win);
      return;
    }
    const row = findPickRow(symbol);
    if (!row) return;
    row.replaceWith(newRow);
    bindPickListSubtree(newRow.parentElement);
  }

  function observePickChartElement(el) {
    if (!el || typeof RMChartHub === "undefined") return;
    if (typeof IntersectionObserver === "undefined") {
      const sym = el.dataset.pickChart;
      if (sym) RMChartHub.renderPickMini(sym, el);
      return;
    }
    if (!pickChartObserver) {
      pickChartObserver = new IntersectionObserver(
        (entries) => {
          for (const ent of entries) {
            if (!ent.isIntersecting) continue;
            const node = ent.target;
            if (node.dataset.chartLoaded === "1") continue;
            node.dataset.chartLoaded = "1";
            const sym = node.dataset.pickChart;
            if (sym) RMChartHub.renderPickMini(sym, node);
            pickChartObserver.unobserve(node);
          }
        },
        { root: null, rootMargin: "100px 0px", threshold: 0.05 }
      );
    }
    delete el.dataset.chartLoaded;
    pickChartObserver.observe(el);
  }

  function updateSessionMeta() {
    if (!session) return;
    setHeaderMeta(
      (session.scanned_at || "").slice(0, 16).replace("T", " ") +
        " · " +
        (session.source_file || "") +
        " · " +
        (session.pick_count || 0) +
        " picks"
    );
  }

  async function handleScanDone(result, n, total) {
    updateNewsProgress(result.symbol, n, total, result);

    const pick = (session.picks || []).find((p) => p.symbol === result.symbol);
    if (!pick) return;

    if (result.error) {
      RMNewsScan.applyResultToPick(pick, result);
      if (typeof RMChartHub !== "undefined") {
        await RMChartHub.dismissCandidate(result.symbol);
      }
      refreshPickRow(result.symbol);
      showToast(
        result.symbol + " — news unavailable (pick kept for review)",
        "warn"
      );
      persistScanSession();
      return;
    }

    if (result.hasCatalyst) {
      RMNewsScan.applyResultToPick(pick, result);
      if (typeof RMChartHub !== "undefined") {
        await RMChartHub.resolveCandidate(result.symbol, true, {
          catalyst: pick.catalyst,
          pick,
        });
      }
      refreshPickRow(result.symbol);
      showToast(result.symbol + " confirmed — catalyst news", "success");
      persistScanSession();
      return;
    }

    const reason = "no_stock_worthy_news_today";
    if (typeof RMChartHub !== "undefined") {
      await RMChartHub.resolveCandidate(result.symbol, false);
    }
    showToast(
      result.symbol + " removed — " + removalReasonLabel(reason),
      "warn"
    );
    await delay(280);
    await animateRemoveSymbol(result.symbol);
    removePickFromSession({ ...result, reason });
    updateRemovedBannerLive();
    updateSessionMeta();
    renderPicks();
  }

  async function searchNews(opts) {
    if (!session || !session.picks || !session.picks.length) return;
    if (newsScanRunning) return;

    const { targets, skipped } = picksForNewsScan(session.picks);
    if (skipped.length) {
      for (const pick of skipped) {
        removePickFromSession({ symbol: pick.symbol, reason: "below_news_rank_cutoff" });
      }
      updateSessionMeta();
      renderPicks();
      showToast(
        skipped.length +
          " lower-ranked pick" +
          (skipped.length === 1 ? "" : "s") +
          " skipped (top " +
          NEWS_TOP_N +
          " only)",
        "info"
      );
    }
    if (!session.picks.length) {
      newsScanRunning = false;
      refreshScanButton();
      status("No picks left after news rank cutoff");
      return;
    }

    const symbols = targets.map((p) => p.symbol);
    const useEta = !!opts?.estimatedProgress && customScanEta.active;
    session.filtered_out = [];
    session.news_filter_applied_at = null;

    if (typeof RMChartHub !== "undefined") {
      await RMChartHub.prepareScanIntroPan();
    }

    newsScanRunning = true;
    refreshScanButton();
    if (typeof RMWorkspaceLoad !== "undefined") {
      if (isMobileSnapScans()) {
        updateScansPanelLoaderStep("Checking news…", Math.max(50, scanProgressPct || 50));
      } else {
        RMWorkspaceLoad.hidePanelLoader("scans");
      }
    }
    const picksHeading = $("picksHeading");
    if (picksHeading) picksHeading.textContent = WS_COL_TITLE.scans + " · checking news…";
    showNewsProgressBar();
    if (useEta) {
      initNewsProgress(symbols, { keepProgress: true });
      extendCustomScanEta({
        addMs: 12000 + symbols.length * 4200,
        toPct: 96,
        label: "Checking news for " + symbols.length + " picks…",
      });
    } else {
      initNewsProgress(symbols);
    }
    if (typeof RMChartHub !== "undefined") {
      await RMChartHub.beginScanSequence(symbols, { skipIntroPan: true });
    }
    renderPicks();
    if (typeof RMWorkspaceAccordion !== "undefined") {
      RMWorkspaceAccordion.expand("scans");
    }

    let results = [];
    try {
      results = await runNewsScan(symbols, {
        async onStart(sym, n, total) {
          if (!useEta) setScanProgress(n, total, 0.08);
          if (typeof RMChartHub !== "undefined") {
            await RMChartHub.previewCandidate(sym);
          }
          document.querySelectorAll(".scan-segment").forEach((el) => {
            el.classList.remove("active");
            if (el.dataset.symbol === sym) el.classList.add("active");
          });
          pickListScanningSym = sym;
          if (
            typeof RMVirtualPickList !== "undefined" &&
            RMVirtualPickList.isActive()
          ) {
            RMVirtualPickList.refresh(session.picks, pickListBannerHtml());
          } else {
            document.querySelectorAll(".pick-row").forEach((el) => {
              el.classList.toggle("pick-row-scanning", el.dataset.symbol === sym);
            });
          }
          if (typeof RMMarket !== "undefined") {
            RMMarket.setMapScanHighlight?.(sym);
            const mpScan = $("marketPanel");
            if (mpScan && RMMarket.scheduleRefreshMarketPanel) {
              RMMarket.scheduleRefreshMarketPanel(mpScan, session.picks, {
                soft: true,
                mapPatchOnly: true,
                highlightSym: sym,
              });
            }
          }
          setScanProgressLabel(
            "Scanning " + sym + "… (" + n + " of " + total + ")"
          );
          mirrorScanProgressToPanel();
        },
        onProgress(sym, n, total, sub) {
          if (!useEta) setScanProgress(n, total, sub);
        },
        onDone(result, n, total) {
          return handleScanDone(result, n, total);
        },
      });
    } finally {
      newsScanRunning = false;
      refreshScanButton();
      pickListScanningSym = null;
      document.querySelectorAll(".pick-row-scanning").forEach((el) => {
        el.classList.remove("pick-row-scanning");
      });
      if (
        typeof RMVirtualPickList !== "undefined" &&
        RMVirtualPickList.isActive()
      ) {
        RMVirtualPickList.refresh(session.picks, pickListBannerHtml());
      }
      if (typeof RMMarket !== "undefined") {
        RMMarket.setMapScanHighlight?.(null);
        const mpDone = $("marketPanel");
        if (mpDone && RMMarket.scheduleRefreshMarketPanel) {
          RMMarket.scheduleRefreshMarketPanel(mpDone, session.picks, {
            soft: true,
            mapPatchOnly: true,
          });
        }
      }
      if (typeof RMChartHub !== "undefined") {
        await RMChartHub.finishScanSequence();
      }
    }

    if (!useEta) {
      applyScanProgressPct(100);
      setScanProgressLabel("News scan complete");
      mirrorScanProgressToPanel();
    }

    session.news_scanned_at = new Date().toISOString();
    session.news_filter_applied_at = new Date().toISOString();
    RMNewsScan.applyToSession(session, results);
    const nr = $("newsResults");
    if (nr) nr.innerHTML = "";
    renderPicks();
    session.entry_type = session.entry_type || "news";
    persistScanSession({ entryType: "news", sourceKind: session.source_kind || "scan" });
    if (typeof RMMarket !== "undefined") {
      const mp = $("marketPanel");
      if (mp) {
        const refreshFn =
          RMMarket.scheduleRefreshMarketPanel || RMMarket.refreshMarketPanel;
        refreshFn(mp, session.picks, { soft: true });
      }
      syncLiveRefresh();
    }
    refreshMarketThemes();

    const removed = (session.filtered_out || []).length;
    if (picksHeading) {
      picksHeading.textContent =
        session.picks.length && removed
          ? "Scan + news (catalyst only)"
          : session.picks.length
            ? WS_COL_TITLE.scans
            : WS_COL_TITLE.scans;
    }
    if (session.picks.length === 0) {
      status(
        removed
          ? "No picks left — none had stock-worthy news today."
          : "No picks in scan."
      );
    } else {
      status(
        session.picks.length +
          " picks with catalyst news" +
          (removed ? " (removed " + removed + ")" : "")
      );
    }
    if (typeof RMHoldings !== "undefined") {
      RMHoldings.syncPricesFromPicks(session.picks);
      renderHoldings();
    }
    if (!useEta) {
      setTimeout(hideNewsProgress, 1200);
    }
  }

  function readPlan() {
    const base = {
      symbol: activePick.symbol,
      session_id: session.session_id,
      instrument,
      rm_confidence: activePick.rm_confidence,
      rm_confidence_adjusted: pickScore(activePick),
      opened_at: new Date().toISOString(),
      status: "open",
      source: "dashboard",
      planned: true,
      reconciled: false,
    };
    if (instrument === "stock") {
      return {
        ...base,
        entry_price: num("entryStock"),
        quantity: num("qtyStock"),
        stop_price: num("stopStock"),
        target_price: num("targetStock"),
      };
    }
    return {
      ...base,
      entry_premium: num("entryOpt"),
      contracts: num("contractsOpt"),
      stop_premium: num("stopOpt"),
      target_premium: num("targetOpt"),
    };
  }

  function num(id) {
    const v = parseFloat($(id).value);
    return isNaN(v) ? null : v;
  }

  function saveOpenTrade() {
    if (!activePick) return;
    saveOpenTradeFromPlan(readPlan());
    closeOrderDrawer();
  }

  function closeTrade() {
    if (!activePick) return;
    closeTradeFromPlan({
      symbol: activePick.symbol,
      fill_status: $("fillStatus").value,
      exit_price: num("exitPrice"),
      source: "drawer",
    });
    closeOrderDrawer();
  }

  function renderYtdHtml() {
    const year = String(new Date().getFullYear());
    const ytd = getTrades().filter((t) => {
      const d = t.closed_at || t.opened_at || "";
      return d.startsWith(year);
    });
    if (!ytd.length) {
      return '<p class="status-msg">No trades logged yet this year.</p>';
    }
    return ytd
      .slice()
      .reverse()
      .map((t) => {
        let line =
          "<strong>" +
          escapeHtml(t.symbol) +
          "</strong> " +
          escapeHtml(t.instrument || "stock") +
          " · " +
          escapeHtml(t.status || "open");
        if (t.entry_price != null) line += " · entry " + t.entry_price;
        if (t.entry_premium != null) line += " · prem " + t.entry_premium;
        if (t.exit_price != null) line += " · exit " + t.exit_price;
        if (t.r_multiple != null) {
          line +=
            " · " +
            (t.r_multiple >= 0 ? "+" : "") +
            Number(t.r_multiple).toFixed(2) +
            "R";
        }
        if (typeof RMTradeMetrics !== "undefined") {
          const dual = RMTradeMetrics.fmtDualTrack(t);
          if (dual) line += " · " + escapeHtml(dual);
        }
        if (t.pnl_usd != null) line += " · " + fmtUsd(t.pnl_usd);
        if (RMTradeMetrics?.reconcileStatus?.(t) === "delta") {
          line += " · <em>reconcile Δ</em>";
        } else if (!t.reconciled) line += " · <em>pending reconcile</em>";
        return '<div class="trade-item">' + line + "</div>";
      })
      .join("");
  }

  function renderYtd() {
    const el = $("ytdList");
    if (el) el.innerHTML = renderYtdHtml();
  }

  function renderDrawerYtd() {
    const el = $("drawerYtdList");
    if (el) el.innerHTML = renderYtdHtml();
    renderLearningStats();
    renderResultsOpenTrades();
    renderResultsClosedTrades();
  }

  let scanConfigDraft = null;
  let agentPlanDraftRef = null;

  function getRainmakerApiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) {
        return meta.content.trim().replace(/\/$/, "");
      }
      const stored = localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {
      /* ignore */
    }
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return "http://127.0.0.1:8765";
    }
    return "";
  }

  function picksForNewsScan(picks) {
    const sorted = [...(picks || [])].sort(
      (a, b) => (b.rm_confidence || 0) - (a.rm_confidence || 0)
    );
    return {
      targets: sorted.slice(0, NEWS_TOP_N),
      skipped: sorted.slice(NEWS_TOP_N),
    };
  }

  async function runNewsScan(symbols, handlers) {
    const apiBase = getRainmakerApiBase();
    if (apiBase && symbols.length) {
      try {
        if (handlers?.onPhase) handlers.onPhase("Rainmaker API · news scan…");
        const res = await fetch(apiBase + "/scan/news", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof RMAuthGate !== "undefined"
              ? RMAuthGate.authHeaders()
              : {}),
          },
          body: JSON.stringify({ symbols, maxAgeHours: 24 }),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            "API " + res.status + (errText ? ": " + errText.slice(0, 100) : "")
          );
        }
        const data = await res.json();
        const results = data.results || [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const n = i + 1;
          const total = results.length;
          if (handlers?.onStart) {
            await handlers.onStart(result.symbol, n, total);
          }
          if (handlers?.onProgress) handlers.onProgress(result.symbol, n, total, 1);
          if (handlers?.onDone) {
            const ret = handlers.onDone(result, n, total);
            if (ret && typeof ret.then === "function") await ret;
          }
        }
        return results;
      } catch (e) {
        console.warn("Rainmaker API news scan failed, falling back to browser", e);
        if (handlers?.onPhase) handlers.onPhase("API unavailable — browser news scan…");
      }
    }
    if (typeof RMNewsScan === "undefined") {
      throw new Error("News scan module failed to load — refresh the page");
    }
    return RMNewsScan.scanAll(symbols, handlers);
  }

  function cfgToApiPayload(cfg) {
    const w = cfg.weights || (RMScanConfig && RMScanConfig.DEFAULTS.weights) || {};
    return {
      hypothesis_id: cfg.hypothesis_id || "H-001",
      applyFloatPoints: !!cfg.applyFloatPoints,
      volMultiple: cfg.volMultiple ?? 5,
      dailyPctMin: cfg.dailyPctMin ?? 10,
      movePctMin: cfg.movePctMin ?? 8,
      priceMin: cfg.priceMin ?? 1,
      priceMax: cfg.priceMax ?? 20,
      gapPctMin: cfg.gapPctMin ?? 3,
      minScore: cfg.minScore ?? 50,
      weights: w,
    };
  }

  async function runH001Scan(cfg, handlers) {
    const apiBase = getRainmakerApiBase();
    if (apiBase) {
      try {
        if (handlers?.onPhase) handlers.onPhase("Rainmaker API · H-001 scan…");
        const res = await fetch(apiBase + "/scan/h001", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof RMAuthGate !== "undefined"
              ? RMAuthGate.authHeaders()
              : {}),
          },
          body: JSON.stringify(cfgToApiPayload(cfg)),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(
            "API " + res.status + (errText ? ": " + errText.slice(0, 100) : "")
          );
        }
        const data = await res.json();
        return {
          session: data.session,
          screened: data.screened,
          scored: data.scored,
          skipped: data.skipped,
          minScore: data.min_score ?? data.minScore ?? cfg.minScore ?? 50,
          viaApi: true,
          durationMs: data.duration_ms ?? data.durationMs,
        };
      } catch (e) {
        console.warn("Rainmaker API scan failed, falling back to browser", e);
        if (handlers?.onPhase) {
          handlers.onPhase("API unavailable — browser scan…");
        }
      }
    }
    if (typeof RMMarketScan === "undefined") {
      throw new Error("Market scan module failed to load — refresh the page");
    }
    return RMMarketScan.runMarketScan(cfg, handlers);
  }

  async function runRainmakerMarketScan() {
    if (typeof RMMarketScan === "undefined" && !getRainmakerApiBase()) {
      status("Market scan module failed to load — refresh the page");
      return;
    }
    if (marketScanRunning || newsScanRunning) return;

    const cfg = scanConfigDraft || RMScanConfig.load();
    RMScanConfig.save(cfg);

    const useApi = !!getRainmakerApiBase();
    marketScanRunning = true;
    refreshScanButton();
    closeScanDrawer();
    if (typeof RMWorkspaceLoad !== "undefined") {
      RMWorkspaceLoad.showPanelLoader("scans", {
        step: useApi ? "Server H-001 scan…" : "Scanning market (gainers + actives)…",
        kicker: "Rainmaker scan",
        pct: 12,
        scanProgress: true,
      });
      mirrorScanProgressToPanel();
    } else {
      setPickListHtml(
        '<p class="status-msg">Running Rainmaker H-001' +
          (useApi ? " (server)" : "") +
          "…</p>"
      );
    }
    status(useApi ? "Server H-001 scan…" : "Scanning market (gainers + actives)…");
    showNewsProgressBar();
    setScanProgressLabel("Starting Rainmaker scan…");
    const seg = $("scanProgressSegments");
    if (seg) seg.innerHTML = "";
    startCustomScanEta({
      durationMs: useApi ? 45000 : 90000,
      toPct: 88,
      label: useApi
        ? "Server scan in progress…"
        : "Starting Rainmaker scan… (~1–2 min)",
    });

    try {
      const minScoreThreshold = cfg.minScore ?? RMMarketScan.DEFAULT_MIN_SCORE ?? 50;
      let symbolTotal = 0;
      const scanResult = await runH001Scan(cfg, {
        onPhase(msg) {
          setScanProgressLabel(msg);
          updateScansPanelLoaderStep(msg, scanProgressPct || undefined);
        },
        onProgress(sym, n, total, sub) {
          if (total && total !== symbolTotal) {
            symbolTotal = total;
            extendCustomScanEta({
              addMs: 8000 + total * 900,
              toPct: 78,
              label: "Scoring " + total + " candidates (batched)…",
            });
          }
          setScanProgressLabel(
            "Scoring " +
              sym +
              "… (" +
              n +
              " of " +
              total +
              ", RM≥" +
              minScoreThreshold +
              ")"
          );
          updateScansPanelLoaderStep(
            "Scoring " + sym + "… (" + n + "/" + total + ")",
            scanProgressPct || undefined
          );
        },
      });

      const scanned = scanResult.session;
      const screened = scanResult.screened;
      const minScore = scanResult.minScore;

      session = scanned;
      session.source_kind = "market_scan";
      session.entry_type = "scan";

      if (!session.picks.length) {
        finishCustomScanEta("Scan complete — no picks matched");
        setPickListHtml(
          '<p class="status-msg">No symbols met H-001 criteria (screened ' +
            screened +
            ", min RM " +
            minScore +
            "). Try lowering min score or thresholds.</p>"
        );
        status("Scan finished — 0 picks");
        return;
      }

      extendCustomScanEta({
        addMs: 10000,
        toPct: 82,
        label: session.pick_count + " picks found · checking news…",
      });

      await onSessionLoaded({
        fromCustomScan: true,
        entryType: "scan",
        sourceKind: "market_scan",
      });
      finishCustomScanEta("Rainmaker scan complete");
      const apiNote = scanResult.viaApi
        ? " · API " + Math.round((scanResult.durationMs || 0) / 1000) + "s"
        : "";
      const skipNote =
        scanResult.skipped != null ? " · " + scanResult.skipped + " pre-filtered" : "";
      status(
        "Rainmaker scan: " +
          session.pick_count +
          " picks from " +
          screened +
          " symbols (RM≥" +
          minScore +
          ")" +
          apiNote +
          skipNote
      );
    } catch (e) {
      stopCustomScanEta();
      applyScanProgressPct(0);
      status(e.message || "Market scan failed");
      setPickListHtml(
        '<p class="status-msg pick-error">' +
          escapeHtml(e.message || "Market scan failed") +
          "</p>"
      );
    } finally {
      marketScanRunning = false;
      refreshScanButton();
      if (typeof RMWorkspaceLoad !== "undefined") {
        RMWorkspaceLoad.hidePanelLoader("scans");
      }
      setTimeout(hideNewsProgress, 1200);
    }
  }

  function setScanDrawerTab(tab) {
    const isScan = tab !== "agent";
    const tabScan = $("scanDrawerTabScan");
    const tabAgent = $("scanDrawerTabAgent");
    const paneScan = $("scanDrawerPaneScan");
    const paneAgent = $("scanDrawerPaneAgent");
    const saveScan = $("btnSaveScanRanks");
    const saveAgent = $("btnSaveAgentPlan");
    tabScan?.classList.toggle("active", isScan);
    tabAgent?.classList.toggle("active", !isScan);
    tabScan?.setAttribute("aria-selected", isScan ? "true" : "false");
    tabAgent?.setAttribute("aria-selected", !isScan ? "true" : "false");
    if (paneScan) {
      paneScan.classList.toggle("hidden", !isScan);
      paneScan.hidden = !isScan;
    }
    if (paneAgent) {
      paneAgent.classList.toggle("hidden", isScan);
      paneAgent.hidden = isScan;
    }
    if (saveScan) {
      saveScan.classList.toggle("hidden", !isScan);
      saveScan.hidden = !isScan;
    }
    if (saveAgent) {
      saveAgent.classList.toggle("hidden", isScan);
      saveAgent.hidden = isScan;
    }
    if (isScan) {
      renderCalendarUi($("drawerCalSearch")?.value || "", "drawer");
    }
  }

  function openScanSettingsDrawer() {
    if (typeof RMScanConfig === "undefined") return;
    scanConfigDraft = RMScanConfig.load();
    renderScanRankPanel($("scanRankPanel"));
    loadAgentPlanPanel();
    setScanDrawerTab("scan");
    renderCalendarUi($("drawerCalSearch")?.value || "", "drawer");
    const backdrop = $("scanBackdrop");
    const drawer = $("scanDrawer");
    if (backdrop) {
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
    }
    if (drawer) {
      drawer.inert = false;
      drawer.classList.remove("is-closed");
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("drawer-open");
    $("btnScanSettings")?.classList.add("is-active");
    $("btnScanSettings")?.setAttribute("aria-pressed", "true");
  }

  function closeScanDrawer() {
    const backdrop = $("scanBackdrop");
    const drawer = $("scanDrawer");
    if (drawer) blurDrawerFocus(drawer);
    if (backdrop) {
      backdrop.classList.add("hidden");
      backdrop.setAttribute("aria-hidden", "true");
    }
    if (drawer) {
      drawer.classList.remove("open");
      drawer.classList.add("is-closed");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (!$("orderDrawer")?.classList.contains("open")) {
      document.body.classList.remove("drawer-open");
    }
    $("btnScanSettings")?.classList.remove("is-active");
    $("btnScanSettings")?.setAttribute("aria-pressed", "false");
  }

  function saveScanRanks() {
    if (typeof RMScanConfig === "undefined") return;
    const cfg = scanConfigDraft || RMScanConfig.load();
    RMScanConfig.save(cfg);
    syncRmWeightPts(cfg.weights);
    status("Score weights saved");
    closeScanDrawer();
  }

  async function loadAgentPlanPanel() {
    const panel = $("agentPlanPanel");
    if (!panel || typeof RMAgentPlan === "undefined") return;
    panel.innerHTML = '<p class="agent-plan-hint">Loading agent plan…</p>';
    RMAgentPlan.setPanelStatus?.(panel, "Loading…", "warn");
    const res = await RMAgentPlan.fetchPlan();
    agentPlanDraftRef = RMAgentPlan.renderPanel(panel, res.plan);
    const sourceMsg =
      res.source === "api"
        ? "Loaded from server"
        : res.source === "local"
          ? "Using local draft (sign in to sync)"
          : "Using defaults (sign in to sync)";
    RMAgentPlan.setPanelStatus?.(panel, sourceMsg, res.source === "api" ? "ok" : "warn");
  }

  async function saveAgentPlan() {
    if (typeof RMAgentPlan === "undefined") return;
    const panel = $("agentPlanPanel");
    if (!panel) return;
    const draft = RMAgentPlan.readPanel(panel, agentPlanDraftRef?.current || RMAgentPlan.defaults());
    const note = panel.querySelector("#agentPlanNote")?.value?.trim() || "";
    RMAgentPlan.setPanelStatus?.(panel, "Saving…", "warn");
    status("Saving agent plan…");
    const res = await RMAgentPlan.savePlan(draft, note);
    if (!res.ok) {
      const detail =
        res.status === 401
          ? "Sign in required"
          : res.data?.detail
            ? String(res.data.detail)
            : "HTTP " + (res.status || "?");
      RMAgentPlan.setPanelStatus?.(panel, "Save failed — " + detail, "err");
      status("Agent plan save failed (" + (res.status || "?") + ")");
      return;
    }
    agentPlanDraftRef = RMAgentPlan.renderPanel(panel, res.plan);
    RMAgentPlan.setPanelStatus?.(panel, "Saved to server" + (note ? " · " + note : ""), "ok");
    status("Agent plan saved" + (note ? " — " + note : ""));
  }

  let scanDrawerFooterWired = false;

  function wireScanDrawerFooter() {
    if (scanDrawerFooterWired) return;
    scanDrawerFooterWired = true;
    safeOn("scanDrawerTabScan", "click", () => setScanDrawerTab("scan"));
    safeOn("scanDrawerTabAgent", "click", () => setScanDrawerTab("agent"));
    safeOn("btnSaveScanRanks", "click", saveScanRanks);
    safeOn("btnSaveAgentPlan", "click", () => {
      saveAgentPlan().catch((e) => status(e.message || "Agent plan save failed"));
    });
    safeOn("btnDismissScanSettings", "click", closeScanDrawer);
  }

  let calendarViewMonth = new Date();
  let calendarSelectedDay = null;

  function calendarEls(surface) {
    if (surface === "results") {
      return {
        grid: $("ttResultsCalGrid"),
        list: $("ttResultsCalList"),
        nav: $("ttResultsCalMonthNav"),
        search: $("ttResultsCalSearch"),
      };
    }
    return {
      grid: $("drawerCalGrid"),
      list: $("drawerCalList"),
      nav: $("drawerCalMonthNav"),
      search: $("drawerCalSearch"),
    };
  }

  async function renderScanHistoryList(items, heading, listEl, surface) {
    const list = listEl || calendarEls(surface).list;
    if (!list) return;
    const total =
      typeof RMScanStore !== "undefined" ? RMScanStore.countEntries() : 0;
    const head =
      '<p class="meta cal-list-head">' +
      escapeHtml(heading || "All scans") +
      (total ? " · " + total + " saved" : "") +
      "</p>";
    let publishedHtml = "";
    if (
      (surface === "results" || surface === "drawer") &&
      !String(heading || "").startsWith("Search")
    ) {
      const pub = await getPublishedSessionOffer();
      if (pub?.picks?.length) publishedHtml = publishedEntryHtml(pub);
    }
    const body =
      publishedHtml +
      (items.length
        ? items.map((h) => calendarEntryHtml(h.dateKey, h.entry)).join("")
        : publishedHtml
          ? ""
          : '<p class="meta cal-list-empty">No saved scans yet. Run Rainmaker scan or Import a CSV from the footer.</p>');
    list.innerHTML = head + body;
    bindCalendarEntries(list);
    if (publishedHtml) bindPublishedEntry();
  }

  function renderCalendarUi(query, surface) {
    if (typeof RMScanStore === "undefined") return;
    surface = surface || "drawer";
    const { grid, list, nav, search } = calendarEls(surface);
    if (!grid || !list) return;

    const q = String(query ?? search?.value ?? "").trim();
    const prevId = surface === "results" ? "ttCalPrev" : "calPrev";
    const nextId = surface === "results" ? "ttCalNext" : "calNext";

    if (q) {
      if (surface === "drawer" || !calendarEls("drawer").search?.value) {
        calendarSelectedDay = null;
      }
      const hits = RMScanStore.search(q);
      grid.innerHTML = "";
      if (nav) nav.textContent = "Search";
      void renderScanHistoryList(
        hits,
        hits.length ? "Search results" : "No matches",
        list,
        surface
      );
      return;
    }

    const y = calendarViewMonth.getFullYear();
    const m = calendarViewMonth.getMonth();
    if (nav) {
      nav.innerHTML =
        '<button type="button" class="btn btn-ghost btn-sm" id="' +
        prevId +
        '">‹</button>' +
        "<span>" +
        calendarViewMonth.toLocaleString(undefined, {
          month: "long",
          year: "numeric",
        }) +
        "</span>" +
        '<button type="button" class="btn btn-ghost btn-sm" id="' +
        nextId +
        '">›</button>';
      $(prevId)?.addEventListener("click", () => {
        calendarViewMonth = new Date(y, m - 1, 1);
        calendarSelectedDay = null;
        renderCalendarUi(undefined, "drawer");
        renderCalendarUi(undefined, "results");
      });
      $(nextId)?.addEventListener("click", () => {
        calendarViewMonth = new Date(y, m + 1, 1);
        calendarSelectedDay = null;
        renderCalendarUi(undefined, "drawer");
        renderCalendarUi(undefined, "results");
      });
    }

    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const firstDow = new Date(y, m, 1).getDay();
    let cells = "";
    for (let i = 0; i < firstDow; i++) cells += '<span class="cal-pad"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const key =
        y +
        "-" +
        String(m + 1).padStart(2, "0") +
        "-" +
        String(d).padStart(2, "0");
      const count = (RMScanStore.getDay(key) || []).length;
      const has = count > 0 ? " cal-has-scan" : "";
      const selected = calendarSelectedDay === key ? " cal-day--selected" : "";
      cells +=
        '<button type="button" class="cal-day' +
        has +
        selected +
        '" data-date="' +
        key +
        '">' +
        d +
        (count ? '<em>' + count + "</em>" : "") +
        "</button>";
    }
    grid.innerHTML = cells;
    grid.querySelectorAll(".cal-day.cal-has-scan").forEach((btn) => {
      btn.addEventListener("click", () => showCalendarDay(btn.dataset.date, surface));
    });
    if (calendarSelectedDay) {
      const dayEntries = RMScanStore.getDay(calendarSelectedDay).map((entry) => ({
        dateKey: calendarSelectedDay,
        entry,
      }));
      void renderScanHistoryList(
        dayEntries,
        calendarSelectedDay + " · " + dayEntries.length + " scan(s)",
        list,
        surface
      );
    } else {
      void renderScanHistoryList(RMScanStore.listAllEntries(), "All scans", list, surface);
    }
  }

  function calendarEntryHtml(dateKey, entry) {
    const selected =
      historySelection &&
      historySelection.dateKey === dateKey &&
      historySelection.entryId === entry.id;
    const kind =
      entry.entry_type ||
      entry.summary?.source_kind ||
      entry.summary?.entry_type ||
      "scan";
    const kindLabel =
      kind === "import"
        ? "Import"
        : kind === "news"
          ? "News"
          : kind === "market_scan"
            ? "H-001"
            : "Scan";
    return (
      '<button type="button" class="calendar-entry' +
      (selected ? " is-selected" : "") +
      '" data-date="' +
      escapeAttr(dateKey) +
      '" data-id="' +
      escapeAttr(entry.id) +
      '">' +
      '<span class="cal-entry-kind">' +
      escapeHtml(kindLabel) +
      "</span> " +
      escapeHtml((entry.summary?.scanned_at || "").slice(0, 16)) +
      " · " +
      (entry.summary?.pick_count || 0) +
      " picks" +
      formatAccuracyBadge(entry.summary?.session_id, entry.summary?.accuracy) +
      (entry.summary?.session_label
        ? " · " + escapeHtml(entry.summary.session_label)
        : "") +
      " · " +
      escapeHtml(entry.summary?.source_file || "") +
      "</button>"
    );
  }

  function showCalendarDay(dateKey, surface) {
    if (typeof RMScanStore === "undefined") return;
    calendarSelectedDay = dateKey;
    const entries = RMScanStore.getDay(dateKey);
    const list = calendarEls(surface).list;
    void renderScanHistoryList(
      entries.map((entry) => ({ dateKey, entry })),
      dateKey + " · " + entries.length + " scan(s)",
      list,
      surface
    );
    renderCalendarUi(undefined, "drawer");
    renderCalendarUi(undefined, "results");
  }

  function bindCalendarEntries(listEl) {
    const root = listEl || $("drawerCalList");
    if (!root) return;
    root.querySelectorAll(".calendar-entry:not(.calendar-entry--published)").forEach((btn) => {
      if (btn.dataset.wired === "1") return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const fromResults = !!btn.closest("#ttResultsCalList");
        loadHistorySession(btn.dataset.date, btn.dataset.id, {
          keepDrawer: !fromResults,
          focusResults: fromResults,
        });
      });
    });
  }

  function safeOn(id, event, fn) {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
  }

  function initEmbedMode() {
    const params = new URLSearchParams(location.search);
    const embedded =
      params.get("embed") === "1" || window.self !== window.top;
    if (!embedded) return;
    document.documentElement.classList.add("is-embed");
    document.body.classList.add("is-embed");
    const banner = $("embedOpenBanner");
    const link = $("embedOpenLink");
    if (banner) banner.hidden = false;
    if (link && !link.href.includes("http")) {
      link.href =
        "https://thepokerninja.github.io/rainmaker-morning/latest.html?embed=0";
    }
  }

  function wire() {
    if (typeof RMResultsHero !== "undefined") {
      RMResultsHero.configure({
        getSession: () => session,
        getActivePick: () => activePick,
        getScanningSymbol: () =>
          newsScanRunning ? RMChartHub?.state?.scanningSym || null : null,
        getTrades,
        getJournalTrades,
        collectOpenRows: collectOpenPositionRows,
        renderOpenRow: renderOpenPositionRow,
        openResultsTab: () => {
          showScansPanel();
          if (scansTab !== "results") {
            setScansTab("results", { skipHero: true });
          }
        },
        pickScore: (p) => pickScore(p),
        onCtaAction: ({ action, symbol, focus }) => {
          if (action === "review_symbol" && symbol) {
            const sym = String(symbol).toUpperCase();
            const chartPlan =
              typeof RMAnalysisChart !== "undefined"
                ? RMAnalysisChart.state?.tradePlan
                : null;
            const planSym = chartPlan?.symbol
              ? String(chartPlan.symbol).toUpperCase()
              : "";
            if (
              chartPlan &&
              (planSym === sym ||
                String(chartPlan.symbol || "").trim() === String(symbol).trim())
            ) {
              showScansPanel();
              setScansTab("results", { skipHero: true });
              void RMResultsHero.showSetup(sym, chartPlan);
              selectTicker(symbol, { toggle: false, snapChart: true, skipHero: true });
              return;
            }
            selectTicker(symbol, { toggle: false, snapChart: true });
            return;
          }
          if (action === "compare_picks") {
            $("btnResultsCompare")?.click();
            return;
          }
          if (action === "connect_schwab") {
            openAccountDrawer();
            return;
          }
          if (action === "load_scan") {
            void loadPublishedSessionInteractive();
            return;
          }
          if (action === "strategy_tab") {
            setScansTab("strategy");
            if (focus) {
              const panelId = {
                research: "ttResearchPanel",
                greenlit: "ttGreenLitPanel",
                calibration: "ttCalibrationPanel",
                monthly: "ttMonthlyReviewPanel",
              }[focus];
              requestAnimationFrame(() => {
                document
                  .getElementById(panelId)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            }
            return;
          }
          if (action === "review_closed") {
            showScansPanel();
            setScansTab("results", { skipHero: true });
            requestAnimationFrame(() => {
              $("ttResultsClosed")?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            });
            return;
          }
          if (action === "chart_focus") {
            document
              .querySelector(".morning-workspace")
              ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        },
      });
      document.addEventListener("click", (e) => {
        const cell = e.target.closest?.(".fv-map-cell[data-symbol]");
        if (!cell) return;
        const sym = cell.dataset.symbol;
        if (!sym) return;
        showScansPanel();
        setScansTab("results");
        void RMResultsHero.showTicker(sym);
        selectTicker(sym, { toggle: false, snapChart: false });
      });
    }
    wireScanDrawerFooter();
    if (typeof RMScanConfig !== "undefined") {
      const cfg = RMScanConfig.load();
      scanConfigDraft = cfg;
      syncRmWeightPts(cfg.weights);
    }
    const fileInput = $("fileScan");
    if (!fileInput) {
      status("Import control missing — refresh the page");
      return;
    }
    safeOn("btnImport", "click", () => fileInput.click());
    fileInput.addEventListener("change", handleFileSelect);
    safeOn("btnAccount", "click", openAccountDrawer);
    safeOn("btnAccountMobile", "click", openAccountDrawer);
    safeOn("btnAuthLogout", "click", (e) => {
      // Keyboard Space/Enter synthesize click with detail === 0; ignore to stop reload loops
      // when Sign out retains focus inside a closed/hidden drawer.
      if (e && e.detail === 0) return;
      if (typeof RMAuthGate !== "undefined") RMAuthGate.logout();
    });
    safeOn("btnMarketSettings", "click", () => {
      const mp = $("marketPanel");
      if (mp && typeof RMMarket !== "undefined" && RMMarket.toggleSettingsMenu) {
        RMMarket.toggleSettingsMenu(mp);
      }
    });
    safeOn("btnChartSettings", "click", () => {
      const hub = $("chartHubView");
      const wrap = hub?.querySelector(".ca-toolbar-wrap");
      if (document.body.classList.contains("is-mobile-snap-chart") && wrap) {
        const open = wrap.classList.toggle("ca-toolbar-wrap--tools-open");
        const btn = $("btnChartSettings");
        if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) {
          wrap.querySelector(".ca-toolbar--secondary")?.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
        }
        return;
      }
      const toolbar = hub?.querySelector(".ca-toolbar");
      if (toolbar) {
        toolbar.scrollIntoView({ behavior: "smooth", block: "nearest" });
        toolbar.classList.add("ca-toolbar--flash");
        setTimeout(() => toolbar.classList.remove("ca-toolbar--flash"), 1200);
      }
    });
    safeOn("btnChartFullscreen", "click", () => {
      const hub = $("chartHubView");
      if (typeof RMChartHub !== "undefined" && RMChartHub.openFullscreen) {
        RMChartHub.openFullscreen(hub);
      }
    });
    safeOn("btnScanSettings", "click", openScanSettingsDrawer);
    safeOn("btnDismissScans", "click", dismissScansPanel);
    document.querySelectorAll("[data-scans-tab]").forEach((btn) => {
      btn.addEventListener("click", () => setScansTab(btn.dataset.scansTab));
    });
    document.addEventListener("rm:scans-swipe-strategy", (e) => {
      setScansTab("strategy", {
        viaScrollDown: true,
        scrollCarryPx: e.detail?.scrollCarryPx,
      });
    });
    document.addEventListener("rm:scans-swipe-results", (e) => {
      setScansTab("results", {
        viaScrollUp: true,
        scrollCarryPx: e.detail?.scrollCarryPx,
        skipHero: true,
      });
    });
    window.__rmSetScansTab = setScansTab;
    safeOn("btnImport", "click", () => showScansPanel());
    wireTradeFooter();
    document.addEventListener("mousedown", (e) => {
      const t = e.target;
      if (
        typeof RMAnalysisChart !== "undefined" &&
        RMAnalysisChart.state?.tradePlanExpanded &&
        !t.closest(
          ".ca-plan-flag, .ca-plan-flag-hit, [data-plan-flag], .ca-plan-panel, #caPlanPanelBackdrop, #caPlanDismiss"
        )
      ) {
        RMAnalysisChart.dismissExpandedTradePlan?.();
      }
      if (!activePick) return;
      if (
        t.closest(
          ".pick-row, #tradeFooterJourney, #appFooter, .ca-toolbar-wrap, .ca-plan-panel, .ca-chart-node, .fv-tip-layer, .ca-pane-resizer, .ca-rm-rec, .ca-plan-flag, .ca-trade-plan, [data-plan-flag]"
        )
      ) {
        return;
      }
      if (t.closest("#workspaceChart .ca-chart-svg-wrap, #workspaceChart .chart-hub-legend-wrap")) {
        if (t.closest(".ca-plan-flag, .ca-trade-plan, [data-plan-flag]")) return;
        clearTickerSelection();
        return;
      }
      if (!t.closest("#workspaceScans")) {
        clearTickerSelection();
      }
    });
    document.addEventListener("rm:select-ticker", (e) => {
      if (e.detail?.symbol) {
        selectTicker(e.detail.symbol, {
          toggle: e.detail.toggle !== false,
          skipHero: !!e.detail.skipHero,
        });
      }
    });
    safeOn("drawerCalSearch", "input", (e) => {
      renderCalendarUi(e.target.value, "drawer");
    });
    safeOn("btnCustomScan", "click", () => runRainmakerMarketScan());
    safeOn("btnCloseScanDrawer", "click", closeScanDrawer);
    safeOn("scanBackdrop", "click", closeScanDrawer);
    safeOn("btnShowAddHolding", "click", () => showAddHoldingForm());
    safeOn("btnSaveHolding", "click", saveHoldingFromForm);
    safeOn("btnCancelAddHolding", "click", renderDrawerHoldings);
    safeOn("tabStock", "click", (e) => {
      e.stopPropagation();
      setInstrumentTab("stock");
    });
    safeOn("tabOption", "click", (e) => {
      e.stopPropagation();
      setInstrumentTab("option");
    });
    safeOn("btnCloseDrawer", "click", closeOrderDrawer);
    safeOn("orderBackdrop", "click", closeOrderDrawer);
    safeOn("btnClosePosition", "click", () => {
      const panel = $("closePanel");
      if (panel) panel.classList.remove("hidden");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("scanDrawer")?.classList.contains("open")) closeScanDrawer();
      else closeOrderDrawer();
    });
    safeOn("btnSavePlan", "click", saveOpenTrade);
    safeOn("btnClose", "click", closeTrade);
  }

  function ensureDrawersClosed() {
    closeOrderDrawer();
    closeScanDrawer();
  }

  initEmbedMode();
  window.selectTradeSetup = selectTradeSetup;
  window.surfacingTradePlanToResults = surfacingTradePlanToResults;
  window.RMJournal = {
    computeJournalStats,
    renderResultsPerformance,
    equitySparklineSvg,
  };
  window.RMTrades = {
    getTrades,
    getJournalTrades,
    saveOpenTradeFromPlan,
    closeTradeFromPlan,
    isFilledFromInput,
  };
  window.renderDrawerHoldings = renderDrawerHoldings;
  window.renderResultsOpenTrades = renderResultsOpenTrades;
  window.renderResultsClosedTrades = renderResultsClosedTrades;
  window.openHoldingOnChart = openHoldingOnChart;
  window.closeOrderDrawer = closeOrderDrawer;
  window.selectTicker = selectTicker;
  window.rmStatus = status;
  document.addEventListener("rm:auth-ready", () => {
    void bootstrapSchwabForDashboard();
    void refreshSchwabJournalTrades();
    if (typeof RMTradeStory !== "undefined") {
      void RMTradeStory.hydrateToday();
    }
    if (typeof RMSchwabData !== "undefined" && RMSchwabData.applyCachedChartMarkers) {
      RMSchwabData.applyCachedChartMarkers();
    }
  });
  document.addEventListener("rm:chart-markers-updated", () => {
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
      RMAnalysisChart.refreshTradeOverlay();
    }
  });
  document.addEventListener("rm:schwab-synced", () => {
    void refreshSchwabJournalTrades();
    renderDrawerHoldings();
    renderResultsOpenTrades();
    if (typeof renderPicks === "function") renderPicks();
    if (activePick && typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(activePick);
  });
  document.addEventListener("rm:schwab-positions", () => {
    renderDrawerHoldings();
    renderResultsOpenTrades();
    if (typeof renderPicks === "function") renderPicks();
    if (activePick && typeof RMTradeFooter !== "undefined") RMTradeFooter.refresh(activePick);
  });
  document.addEventListener("rm:results-open-rendered", initOpenListDelegation);
  initOpenListDelegation();
  document.addEventListener("rm:chart-bars", (e) => {
    if (e.detail?.compare) return;
    const sym = chartSymbolForBacktest();
    if (!sym) return;
    if (sym === chartBtLastSym && !e.detail?.force) return;
    chartBtLastSym = sym;
    scheduleChartStrategyBacktests();
  });
  document.addEventListener("rm:trade-closed", (e) => {
    const sym = e.detail?.symbol;
    if (sym) refreshPickRow(String(sym).toUpperCase());
  });
  document.addEventListener("rm:chart-trade-focus", (e) => {
    const markerId = e.detail?.markerId;
    if (!markerId || typeof RMTradeDebrief === "undefined") return;
    if (String(markerId).startsWith("debrief-")) {
      RMTradeDebrief.highlightClosedTradeRow(String(markerId).slice(8));
      return;
    }
    const trades = getJournalTrades().filter((t) => t.status === "closed");
    const tm =
      typeof RMAnalysisChart !== "undefined"
        ? RMAnalysisChart.tradeMarkersForSymbol?.(RMAnalysisChart.state?.symbol || "SPY")?.find(
            (m) => m.id === markerId
          )
        : null;
    if (!tm?.label) return;
    const trade = trades.find(
      (t) => String(t.symbol || "").trim().toUpperCase() === String(tm.label).trim().toUpperCase()
    );
    if (trade?.id) RMTradeDebrief.highlightClosedTradeRow(trade.id);
  });
  document.addEventListener("rm:toast", (e) => {
    if (e.detail?.message) status(e.detail.message);
  });
  wire();
  const _orderDrawer = $("orderDrawer");
  const _scanDrawer = $("scanDrawer");
  if (_orderDrawer && !_orderDrawer.classList.contains("open")) _orderDrawer.inert = true;
  if (_scanDrawer && !_scanDrawer.classList.contains("open")) _scanDrawer.inert = true;
  if (typeof RMWorkspaceAccordion !== "undefined") RMWorkspaceAccordion.init();
  document.addEventListener("rm:workspace-row", () => syncBackgroundActivity());
  document.addEventListener("visibilitychange", () => syncBackgroundActivity());
  window.syncMobilePickChrome = syncMobilePickChrome;
  window.syncBackgroundActivity = syncBackgroundActivity;
  async function startApp() {
    if (typeof RMAuthGate !== "undefined" && RMAuthGate.authRequired()) {
      await RMAuthGate.start(() => {});
    } else if (typeof RMAuthGate !== "undefined" && RMAuthGate.getToken()) {
      await RMAuthGate.validateSession({ retries: 1 });
      document.dispatchEvent(
        new CustomEvent("rm:auth-ready", { detail: { user: RMAuthGate.getUser() } })
      );
    }
    await boot();
  }
  startApp().catch((e) => {
    status(e.message || "Startup failed — refresh the page");
    console.error(e);
  });

  window.addEventListener("error", (e) => {
    if (e.message) status("Error: " + e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    status("Error: " + msg);
  });
  window.getMorningSession = () => session;
})();
