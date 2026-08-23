/** Workspace panels — mobile snap rows; tablet/desktop collapsible column headers. */
(function (global) {
  const ROWS = [
    { key: "market", id: "workspaceMarket", label: "Morning Pulse" },
    { key: "chart", id: "workspaceChart", label: "Shape of Data" },
    { key: "scans", id: "workspaceScans", label: "Target Trades" },
  ];
  const ROW_KEYS = ROWS.map((r) => r.key);
  const ROW_LABEL = Object.fromEntries(ROWS.map((r) => [r.key, r.label]));

  const MOBILE_MQ = global.matchMedia("(max-width: 640px)");
  // 641px (not 640) so the wide/tablet band never overlaps MOBILE_MQ at exactly
  // 640px — keeps JS snap behavior and the CSS tablet grid (min-width:641px) in sync.
  const WIDE_MQ = global.matchMedia("(min-width: 641px)");
  const DESKTOP_MQ = global.matchMedia("(min-width: 1280px)");

  const EDGE_SLACK = 6;
  const SWIPE_MIN = 32;
  const PULL_MIN = 18;
  const RESULTS_STRATEGY_PULL = 8;
  const RESULTS_STRATEGY_SWIPE = 20;
  const HEAD_IGNORE =
    ".ws-panel-menu, .ws-panel-head-actions, .fv-bias-mini-slot, .fv-bias-mini-tail, .fv-settings-popover, .tt-tabs, .tt-tab, button, a, input, select, label";

  const COL_MARKET_OPEN = "minmax(220px, 22%)";
  const COL_CHART_OPEN = "minmax(0, 1fr)";
  const COL_SCANS_OPEN = "minmax(260px, 26%)";
  const COL_COLLAPSED = "56px";
  const ROW_CHART_OPEN = "minmax(0, 1.12fr)";
  const ROW_BOTTOM_OPEN = "minmax(0, 1fr)";
  const SNAP_TRANSITION_MS = 220;

  let activeKey = "market";
  let previousKey = "market";
  let snapTransitionTimer = null;
  const collapsed = { market: false, chart: false, scans: false };
  let wired = false;
  let snapLock = false;
  let snapLockTimer = null;
  let bumpersWired = false;
  let rowNavWired = false;

  const ROW_NAV_IDS = {
    market: "btnRowNavMarket",
    chart: "btnRowNavChart",
    scans: "btnRowNavScans",
  };
  let scrollBurstWired = false;
  let scrollBurstLit = false;
  let scansTabListenersWired = false;
  let touchStartY = 0;
  let touchStartX = 0;
  let touchLastY = 0;
  let touchScrollTop0 = 0;
  let touchEdgePull = 0;
  let touchBodyEl = null;
  let resultsScrollEl = null;
  let scansTouchActive = false;
  let resultsHandoffTimer = null;
  let mobileTouchWired = false;
  let activeScroller = null;

  function workspace() {
    return document.getElementById("morningWorkspace");
  }

  function siteHeader() {
    return document.getElementById("siteHeader");
  }

  function panelEl(key) {
    const row = ROWS.find((r) => r.key === key);
    return row ? document.getElementById(row.id) : null;
  }

  function activeBody() {
    return panelEl(activeKey)?.querySelector(".ws-panel-body") || null;
  }

  function scansActiveScroller() {
    if (activeScansTab() === "strategy") {
      return document.querySelector("#scansTabStrategy .tt-strategy-board");
    }
    return document.querySelector("#scansTabResults .tt-results-scroll");
  }

  function scrollTarget(body) {
    if (!body) return null;
    if (activeKey === "scans") {
      const scroller = scansActiveScroller();
      if (scroller) return scroller;
    }
    return body;
  }

  function touchScrollTarget() {
    if (activeKey === "scans") return scansActiveScroller();
    const body = activeBody();
    return touchBodyEl || scrollTarget(body);
  }

  function rowIndex(key) {
    return ROW_KEYS.indexOf(key);
  }

  let chartResizeNotifyTimer = null;

  function notifyChartResize() {
    clearTimeout(chartResizeNotifyTimer);
    chartResizeNotifyTimer = setTimeout(() => {
      chartResizeNotifyTimer = null;
      requestAnimationFrame(() => global.dispatchEvent(new Event("resize")));
    }, 150);
  }

  function lockSnap(ms) {
    snapLock = true;
    clearTimeout(snapLockTimer);
    snapLockTimer = setTimeout(() => {
      snapLock = false;
    }, ms || SNAP_TRANSITION_MS + 20);
  }

  function activeScansTab() {
    const strategy = document.getElementById("scansTabStrategy");
    const results = document.getElementById("scansTabResults");
    if (strategy && !strategy.hidden && !strategy.classList.contains("hidden")) {
      return "strategy";
    }
    if (results && !results.hidden && !results.classList.contains("hidden")) {
      return "results";
    }
    return "results";
  }

  function strategyBurstEligible() {
    return !!global._rmStrategyBurstEligible;
  }

  function trySwipeToStrategyTab(carryPx) {
    if (activeKey !== "scans" || activeScansTab() !== "results") return false;
    scrollBurstLit = false;
    const detail = { viaScrollDown: true, scrollCarryPx: carryPx || 0 };
    if (typeof global.__rmSetScansTab === "function") {
      global.__rmSetScansTab("strategy", detail);
    } else {
      global.dispatchEvent(new CustomEvent("rm:scans-swipe-strategy", { detail }));
    }
    activeScroller = document.querySelector("#scansTabStrategy .tt-strategy-board");
    touchScrollTop0 = 0;
    resetTouchEdge();
    requestAnimationFrame(() => bindBodyTouch());
    return true;
  }

  function trySwipeToResultsTab(carryPx) {
    if (activeKey !== "scans" || activeScansTab() !== "strategy") return false;
    scrollBurstLit = false;
    global._rmStrategyBurstEligible = false;
    const detail = { viaScrollUp: true, scrollCarryPx: carryPx || 0 };
    if (typeof global.__rmSetScansTab === "function") {
      global.__rmSetScansTab("results", detail);
    } else {
      global.dispatchEvent(new CustomEvent("rm:scans-swipe-results", { detail }));
    }
    activeScroller = resultsScroller();
    touchScrollTop0 = activeScroller ? activeScroller.scrollTop : 0;
    resetTouchEdge();
    requestAnimationFrame(() => bindBodyTouch());
    return true;
  }

  function touchInActiveRow(e) {
    const panel = panelEl(activeKey);
    return !!(panel && e.target instanceof Element && panel.contains(e.target));
  }

  function resultsScroller() {
    return document.querySelector("#scansTabResults .tt-results-scroll");
  }

  function strategyScroller() {
    return document.querySelector("#scansTabStrategy .tt-strategy-board");
  }

  function resolveActiveScroller(el) {
    if (activeKey === "scans") {
      return activeScansTab() === "strategy" ? strategyScroller() : resultsScroller();
    }
    return scrollTarget(activeBody());
  }

  function resultsHandoffReady(target) {
    if (activeKey !== "scans" || activeScansTab() !== "results" || !target) return false;
    return scrollState(target).atBottom;
  }

  function shouldHandoffResultsToStrategy(target, dy) {
    if (!resultsHandoffReady(target)) return false;
    return dy < -10 || touchEdgePull <= -RESULTS_STRATEGY_PULL;
  }

  function strategyHandoffReady(target) {
    if (activeKey !== "scans" || activeScansTab() !== "strategy" || !target) return false;
    return scrollState(target).atTop;
  }

  function shouldHandoffStrategyToResults(target, dy) {
    if (!strategyHandoffReady(target)) return false;
    return dy > 10 || touchEdgePull >= RESULTS_STRATEGY_PULL;
  }

  function scrollState(body) {
    if (!body) return { atTop: true, atBottom: true, overflow: 0 };
    const overflow = Math.max(0, body.scrollHeight - body.clientHeight);
    return {
      atTop: body.scrollTop <= EDGE_SLACK,
      atBottom: body.scrollTop >= overflow - EDGE_SLACK,
      overflow,
    };
  }

  function resetTouchEdge() {
    touchEdgePull = 0;
  }

  function mayStepToStrategyTab(body, dy) {
    if (activeKey !== "scans" || activeScansTab() !== "results") return false;
    const s = scrollState(body);
    if (!body || !s.atBottom) return false;
    return dy < -RESULTS_STRATEGY_SWIPE || touchEdgePull <= -RESULTS_STRATEGY_PULL;
  }

  function mayStepNext(body, dy) {
    const s = scrollState(body);
    if (!body || !s.atBottom) return false;
    if (activeKey === "scans" && activeScansTab() === "results") {
      return mayStepToStrategyTab(body, dy);
    }
    if (s.overflow > EDGE_SLACK) {
      return dy < -SWIPE_MIN || touchEdgePull <= -PULL_MIN;
    }
    return dy < -SWIPE_MIN || touchEdgePull <= -PULL_MIN;
  }

  function mayStepToResultsTab(body, dy) {
    if (activeKey !== "scans" || activeScansTab() !== "strategy") return false;
    const s = scrollState(body);
    if (!body || !s.atTop) return false;
    return dy > RESULTS_STRATEGY_SWIPE || touchEdgePull >= RESULTS_STRATEGY_PULL;
  }

  function mayStepPrev(body, dy) {
    const s = scrollState(body);
    if (!body || !s.atTop) return false;
    if (activeKey === "scans" && activeScansTab() === "strategy") {
      return mayStepToResultsTab(body, dy);
    }
    if (s.overflow > EDGE_SLACK) {
      return dy > SWIPE_MIN || touchEdgePull >= PULL_MIN;
    }
    return dy > SWIPE_MIN || touchEdgePull >= PULL_MIN;
  }

  function headIgnoresClick(e) {
    return !!e.target.closest(HEAD_IGNORE);
  }

  function clearSnapTransitionAttrs() {
    delete document.body.dataset.snapFrom;
    delete document.body.dataset.snapTo;
  }

  function setSnapTransitionAttrs(fromKey, toKey) {
    document.body.dataset.snapFrom = fromKey;
    document.body.dataset.snapTo = toKey;
    document.body.classList.add("snap-bumper-transitioning");
    clearTimeout(snapTransitionTimer);
    snapTransitionTimer = setTimeout(() => {
      snapTransitionTimer = null;
      document.body.classList.remove("snap-bumper-transitioning");
      clearSnapTransitionAttrs();
      notifyChartResize();
    }, SNAP_TRANSITION_MS);
  }

  function snapChromeEl() {
    return document.getElementById("mobileSnapChrome");
  }

  function rowNavEl() {
    return document.getElementById("mobileRowNav");
  }

  function setRowNavLoading(row, on) {
    const id = ROW_NAV_IDS[row];
    if (!id) return;
    document.getElementById(id)?.classList.toggle("is-loading", !!on);
  }

  function playSniperLockAnimation() {
    const btn = document.getElementById(ROW_NAV_IDS.scans);
    if (!btn || !MOBILE_MQ.matches) return;
    btn.classList.remove("is-scope-locking");
    void btn.offsetWidth;
    btn.classList.add("is-scope-locking");
    const clear = () => btn.classList.remove("is-scope-locking");
    btn.addEventListener("animationend", clear, { once: true });
    setTimeout(clear, 950);
  }

  function updateRowNav() {
    const nav = rowNavEl();
    if (!nav) return;
    if (!MOBILE_MQ.matches) {
      nav.hidden = true;
      nav.setAttribute("aria-hidden", "true");
      ROW_KEYS.forEach((key) => {
        document.getElementById(ROW_NAV_IDS[key])?.classList.remove("is-active", "is-loading");
      });
      return;
    }
    nav.hidden = false;
    nav.setAttribute("aria-hidden", "false");
    ROW_KEYS.forEach((key) => {
      const btn = document.getElementById(ROW_NAV_IDS[key]);
      if (btn) btn.classList.toggle("is-active", key === activeKey);
    });
  }

  function wireRowNav() {
    if (rowNavWired) return;
    rowNavWired = true;
    const nav = rowNavEl();
    if (!nav) return;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-row-nav]");
      if (!btn || !nav.contains(btn)) return;
      const key = btn.getAttribute("data-row-nav");
      if (!ROW_KEYS.includes(key)) return;
      e.preventDefault();
      if (btn.classList.contains("mobile-row-nav-btn--sniper")) {
        btn.classList.add("is-firing");
        setTimeout(() => btn.classList.remove("is-firing"), 150);
      }
      if (activeKey !== key) {
        lockSnap();
        setActiveRow(key, { smooth: true });
      }
    });
  }

  function rowLabel(key) {
    return ROW_LABEL[key] || key;
  }

  function updateSnapBumpers() {
    const chrome = snapChromeEl();
    const up = document.getElementById("btnSnapBumperUp");
    const down = document.getElementById("btnSnapBumperDown");
    if (!chrome || !up || !down) return;

    if (!MOBILE_MQ.matches) {
      chrome.hidden = true;
      chrome.setAttribute("aria-hidden", "true");
      up.hidden = true;
      down.hidden = true;
      updateRowNav();
      return;
    }

    const idx = rowIndex(activeKey);
    const showDown = idx >= 0 && idx < ROW_KEYS.length - 1;

    chrome.hidden = false;
    chrome.setAttribute("aria-hidden", "false");
    up.hidden = true;
    down.hidden = !showDown;
    updateRowNav();
    if (showDown) {
      const next = ROW_KEYS[idx + 1];
      down.setAttribute("aria-label", "Next: " + rowLabel(next));
      down.title = rowLabel(next);
    }
  }

  function onBumperActivate(e, delta) {
    e.preventDefault();
    e.stopPropagation();
    stepRow(delta);
  }

  function scrollEndBurstEl() {
    return document.getElementById("mobileScrollEndBurst");
  }

  function playScrollEndBurst() {
    const el = scrollEndBurstEl();
    if (!el || !MOBILE_MQ.matches || activeKey !== "scans") return;
    if (global.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    el.classList.remove("is-active");
    void el.offsetWidth;
    el.classList.add("is-active");

    if (typeof global.RMBuyBagFx !== "undefined") global.RMBuyBagFx.playCashier();

    clearTimeout(playScrollEndBurst._doneTimer);
    playScrollEndBurst._doneTimer = setTimeout(() => {
      el.classList.remove("is-active");
      el.hidden = true;
      el.setAttribute("aria-hidden", "true");
    }, 920);
  }

  function maybeScrollEndBurst(scroller) {
    if (!MOBILE_MQ.matches || activeKey !== "scans") return;
    if (scroller?.closest("#scansTabResults")) return;
    if (activeScansTab() !== "strategy" || !strategyBurstEligible()) return;
    if (!scroller?.closest("#scansTabStrategy")) return;
    const s = scrollState(scroller);
    if (!s.atBottom) {
      scrollBurstLit = false;
      return;
    }
    if (s.overflow < 32 || scrollBurstLit) return;
    scrollBurstLit = true;
    global._rmStrategyBurstEligible = false;
    playScrollEndBurst();
  }

  function onScrollBurstCheck(e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.closest("#workspaceScans")) return;
    if (t.scrollHeight <= t.clientHeight + EDGE_SLACK) return;
    maybeScrollEndBurst(t);
  }

  function bindScrollBurst() {
    if (scrollBurstWired) return;
    scrollBurstWired = true;
    document.addEventListener("scroll", onScrollBurstCheck, { capture: true, passive: true });
  }

  function onScansTabShown() {
    if (!MOBILE_MQ.matches || activeKey !== "scans") return;
    scrollBurstLit = false;
    bindBodyTouch();
  }

  function bindScansTabListeners() {
    if (scansTabListenersWired) return;
    scansTabListenersWired = true;
    document.addEventListener("rm:results-tab-shown", onScansTabShown);
    document.addEventListener("rm:strategy-tab-shown", onScansTabShown);
    document.addEventListener("rm:results-closed-rendered", onScansTabShown);
    document.addEventListener("rm:results-content-updated", onScansTabShown);
    global.addEventListener("resize", () => {
      if (activeKey === "scans" && MOBILE_MQ.matches) bindBodyTouch();
    });
  }

  function resetScrollBurst() {
    scrollBurstLit = false;
    global._rmStrategyBurstEligible = false;
    const el = scrollEndBurstEl();
    if (!el) return;
    el.classList.remove("is-active");
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
  }

  function wireBumpers() {
    if (bumpersWired) return;
    bumpersWired = true;
    const up = document.getElementById("btnSnapBumperUp");
    const down = document.getElementById("btnSnapBumperDown");
    up?.addEventListener("click", (e) => onBumperActivate(e, -1));
    down?.addEventListener("click", (e) => onBumperActivate(e, 1));
  }

  function updateSnapChrome() {
    const hdr = siteHeader();
    if (!MOBILE_MQ.matches) {
      document.body.classList.remove(
        "is-mobile-snap-market",
        "is-mobile-snap-chart",
        "is-mobile-snap-scans",
        "snap-bumper-transitioning"
      );
      clearSnapTransitionAttrs();
      updateSnapBumpers();
      hdr?.classList.remove(
        "site-header--snap-compact",
        "site-header--snap-hidden",
        "site-header--snap-hero",
        "site-header--compact-visual",
        "site-header--snap-compact-fixed"
      );
      return;
    }

    document.body.classList.toggle("is-mobile-snap-market", activeKey === "market");
    document.body.classList.toggle("is-mobile-snap-chart", activeKey === "chart");
    document.body.classList.toggle("is-mobile-snap-scans", activeKey === "scans");
    if (typeof global.syncMobilePickChrome === "function") {
      global.syncMobilePickChrome();
    }
    if (activeKey === "chart" && typeof RMAnalysisChart !== "undefined") {
      RMAnalysisChart.ensureMobileIndicatorDefaults?.();
    }
    if (activeKey !== "chart") {
      document
        .querySelector("#workspaceChart .ca-toolbar-wrap")
        ?.classList.remove("ca-toolbar-wrap--tools-open");
      document.getElementById("btnChartSettings")?.setAttribute("aria-expanded", "false");
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.collapseTradePlanOnChart) {
        RMAnalysisChart.collapseTradePlanOnChart();
        RMAnalysisChart.paint?.();
      }
    }
    hdr?.classList.remove(
      "site-header--snap-compact",
      "site-header--snap-hidden",
      "site-header--snap-hero",
      "site-header--compact-visual",
      "site-header--snap-compact-fixed"
    );
    hdr?.classList.add("site-header--snap-compact-fixed");
    global.RMBrandLogo?.onHeaderLayout?.();
    requestAnimationFrame(() => global.RMBrandLogo?.onHeaderLayout?.());
    updateSnapBumpers();
    if (activeKey !== "scans") resetScrollBurst();
  }

  function resetToMarket() {
    activeKey = "market";
  }

  function scrollBodiesToTop() {
    ROWS.forEach(({ key }) => {
      const body = panelEl(key)?.querySelector(".ws-panel-body");
      if (body) body.scrollTop = 0;
    });
    resetTouchEdge();
  }

  function pokeRowWarm(key) {
    if (!MOBILE_MQ.matches || key === "market") return;
    const el = panelEl(key);
    if (!el || el.classList.contains("ws-panel--ready")) return;
    if (typeof global.RMMobilePerf !== "undefined") {
      void global.RMMobilePerf.warmRow(key);
    }
  }

  function setActiveRow(key, opts) {
    const options = opts || {};
    if (!MOBILE_MQ.matches || !ROW_KEYS.includes(key)) return false;
    if (activeKey === key) return false;

    const fromKey = activeKey;
    previousKey = fromKey;
    activeKey = key;
    if (fromKey !== key) resetScrollBurst();
    setSnapTransitionAttrs(fromKey, key);
    updateSnapChrome();
    syncPanels();
    pokeRowWarm(key);
    global.dispatchEvent(new CustomEvent("rm:workspace-row", { detail: { key: activeKey } }));
    if (typeof global.syncBackgroundActivity === "function") global.syncBackgroundActivity();
    if (activeKey === "market" && typeof global.RMHeaderMood !== "undefined") {
      global.RMHeaderMood.refresh?.();
    }
    if (key === "scans") {
      playSniperLockAnimation();
    }

    requestAnimationFrame(() => {
      const body = activeBody();
      if (body && options.scrollTop !== false) {
        body.scrollTo({ top: 0, behavior: options.smooth ? "smooth" : "auto" });
      }
      resetTouchEdge();
      if (key === "chart" || key === "scans") notifyChartResize();
      updateSnapChrome();
    });

    return true;
  }

  function stepRow(delta) {
    if (snapLock || !MOBILE_MQ.matches) return false;
    const next = ROW_KEYS[rowIndex(activeKey) + delta];
    if (!next) return false;
    lockSnap();
    return setActiveRow(next, { smooth: true });
  }

  function onWheel(e) {
    if (!MOBILE_MQ.matches || snapLock) return;
    const target = resolveActiveScroller(e.target);
    if (!target || !target.contains(e.target)) return;

    const s = scrollState(target);
    if (e.deltaY > 0 && s.atBottom) {
      if (activeKey === "scans" && activeScansTab() === "results" && trySwipeToStrategyTab(24)) {
        e.preventDefault();
      } else if (stepRow(1)) e.preventDefault();
    } else if (e.deltaY < 0 && s.atTop) {
      if (activeKey === "scans" && activeScansTab() === "strategy" && trySwipeToResultsTab(24)) {
        e.preventDefault();
      } else if (stepRow(-1)) e.preventDefault();
    }
  }

  function onResultsScrollHandoff() {
    if (!scansTouchActive || activeKey !== "scans" || activeScansTab() !== "results") return;
    const el = resultsScrollEl || resultsScroller();
    if (!el || !resultsHandoffReady(el)) return;
    trySwipeToStrategyTab(Math.abs(touchEdgePull));
  }

  function wireResultsScrollHandoff(el) {
    if (!el || el === resultsScrollEl) return;
    if (resultsScrollEl) {
      resultsScrollEl.removeEventListener("scroll", onResultsScrollHandoff);
    }
    resultsScrollEl = el;
    el.addEventListener("scroll", onResultsScrollHandoff, { passive: true });
  }

  function unwireResultsScrollHandoff() {
    if (!resultsScrollEl) return;
    resultsScrollEl.removeEventListener("scroll", onResultsScrollHandoff);
    resultsScrollEl = null;
  }

  function onTouchStart(e) {
    if (!MOBILE_MQ.matches || e.touches.length !== 1) return;
    if (!touchInActiveRow(e)) return;
    scansTouchActive = activeKey === "scans";
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchLastY = touchStartY;
    activeScroller = resolveActiveScroller(e.target);
    touchScrollTop0 = activeScroller ? activeScroller.scrollTop : 0;
    resetTouchEdge();
  }

  function onTouchMove(e) {
    if (!MOBILE_MQ.matches || snapLock || e.touches.length !== 1) return;
    if (!touchInActiveRow(e)) return;
    const target = activeScroller || resolveActiveScroller(e.target);
    if (!target) return;

    const y = e.touches[0].clientY;
    const stepDy = y - touchLastY;
    touchLastY = y;

    const s = scrollState(target);
    if (activeKey === "scans" && activeScansTab() === "strategy") {
      maybeScrollEndBurst(target);
    }
    if (s.atBottom && stepDy < 0) {
      touchEdgePull += stepDy;
      if (activeKey === "scans" && activeScansTab() === "results" && resultsHandoffReady(target)) {
        if (trySwipeToStrategyTab(Math.abs(touchEdgePull))) {
          e.preventDefault();
          return;
        }
      }
      if (s.overflow <= EDGE_SLACK) e.preventDefault();
    } else if (s.atTop && stepDy > 0) {
      touchEdgePull += stepDy;
      if (activeKey === "scans" && activeScansTab() === "strategy" && strategyHandoffReady(target)) {
        if (trySwipeToResultsTab(touchEdgePull)) {
          e.preventDefault();
          return;
        }
      }
      if (s.overflow <= EDGE_SLACK) e.preventDefault();
    }
  }

  function onTouchEnd(e) {
    if (!MOBILE_MQ.matches || snapLock || e.changedTouches.length !== 1) return;
    if (!touchInActiveRow(e)) return;

    const target = activeScroller || resolveActiveScroller(e.target);
    const dy = e.changedTouches[0].clientY - touchStartY;
    const dx = e.changedTouches[0].clientX - touchStartX;

    if (Math.abs(dx) <= Math.abs(dy)) {
      if (activeKey === "scans" && activeScansTab() === "results" && shouldHandoffResultsToStrategy(target, dy)) {
        trySwipeToStrategyTab(Math.abs(touchEdgePull));
      } else if (activeKey === "scans" && activeScansTab() === "strategy" && shouldHandoffStrategyToResults(target, dy)) {
        trySwipeToResultsTab(Math.abs(touchEdgePull));
      } else if (mayStepNext(target, dy)) {
        if (activeKey === "scans" && activeScansTab() === "results") {
          trySwipeToStrategyTab(Math.abs(touchEdgePull));
        } else {
          stepRow(1);
        }
      } else if (mayStepPrev(target, dy)) {
        if (activeKey === "scans" && activeScansTab() === "strategy") {
          trySwipeToResultsTab(Math.abs(touchEdgePull));
        } else {
          stepRow(-1);
        }
      } else if (activeKey === "scans" && activeScansTab() === "results" && target && resultsHandoffReady(target)) {
        clearTimeout(resultsHandoffTimer);
        resultsHandoffTimer = setTimeout(() => {
          resultsHandoffTimer = null;
          const el = resultsScroller();
          if (resultsHandoffReady(el)) trySwipeToStrategyTab(0);
        }, 240);
      }
    }

    scansTouchActive = false;
    activeScroller = null;
    resetTouchEdge();
  }

  function bindMobileTouchChain() {
    if (mobileTouchWired) return;
    mobileTouchWired = true;
    document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  }

  function toggleWideCollapsed(key) {
    if (!ROW_KEYS.includes(key)) return;
    collapsed[key] = !collapsed[key];
    syncPanels();
    requestAnimationFrame(() => {
      notifyChartResize();
      if (key === "chart" && typeof RMAnalysisChart !== "undefined") {
        RMAnalysisChart.refresh?.(
          panelEl("chart")?.querySelector(".chart-hub-unified"),
          global.RMChartHub
        );
      }
    });
  }

  function onHeadActivate(e) {
    if (headIgnoresClick(e)) return;
    const panel = e.currentTarget.closest(".ws-panel");
    const key = panel?.dataset.wsCol;
    if (!key) return;

    if (MOBILE_MQ.matches) {
      return;
    }

    if (WIDE_MQ.matches) {
      toggleWideCollapsed(key);
    }
  }

  function onHeadKeydown(e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onHeadActivate(e);
  }

  function unbindBodyTouch() {
    unwireResultsScrollHandoff();
    touchBodyEl = null;
  }

  function bindBodyTouch() {
    unbindBodyTouch();
    if (!MOBILE_MQ.matches) return;
    if (activeKey === "scans" && activeScansTab() === "results") {
      const scrollEl = resultsScroller();
      if (scrollEl) wireResultsScrollHandoff(scrollEl);
    }
  }

  function unbindSnapInput() {
    document.removeEventListener("wheel", onWheel, { capture: true });
    unbindBodyTouch();
    resetTouchEdge();
    updateSnapChrome();
  }

  function bindSnapInput() {
    unbindSnapInput();
    if (!MOBILE_MQ.matches) return;
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    bindBodyTouch();
  }

  function clearPanelChrome(el) {
    if (!el) return;
    el.classList.remove("ws-panel--expanded", "ws-panel--collapsed", "ws-panel--snap-active");
    const head = el.querySelector(".ws-panel-head");
    if (!head) return;
    head.removeAttribute("aria-expanded");
    head.removeAttribute("role");
    head.removeAttribute("tabindex");
  }

  function wirePanelHeads(interactive) {
    ROWS.forEach(({ key }) => {
      const head = panelEl(key)?.querySelector(".ws-panel-head");
      if (!head) return;
      if (interactive) {
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");
      } else {
        head.removeAttribute("role");
        head.removeAttribute("tabindex");
      }
    });
  }

  function hasWideCollapse() {
    return collapsed.market || collapsed.chart || collapsed.scans;
  }

  function clearWideGridVars(ws) {
    ws.classList.remove("morning-workspace--wide-collapse-active");
    ws.dataset.wsMarket = "";
    ws.dataset.wsChart = "";
    ws.dataset.wsScans = "";
    ws.style.removeProperty("--ws-col-market");
    ws.style.removeProperty("--ws-col-chart");
    ws.style.removeProperty("--ws-col-scans");
    ws.style.removeProperty("--ws-row-chart");
    ws.style.removeProperty("--ws-row-bottom");
  }

  function updateWideGrid(ws) {
    if (!hasWideCollapse()) {
      clearWideGridVars(ws);
      return;
    }

    ws.classList.add("morning-workspace--wide-collapse-active");
    ws.dataset.wsMarket = collapsed.market ? "collapsed" : "expanded";
    ws.dataset.wsChart = collapsed.chart ? "collapsed" : "expanded";
    ws.dataset.wsScans = collapsed.scans ? "collapsed" : "expanded";

    if (DESKTOP_MQ.matches) {
      ws.style.setProperty("--ws-col-market", collapsed.market ? COL_COLLAPSED : COL_MARKET_OPEN);
      ws.style.setProperty("--ws-col-chart", collapsed.chart ? COL_COLLAPSED : COL_CHART_OPEN);
      ws.style.setProperty("--ws-col-scans", collapsed.scans ? COL_COLLAPSED : COL_SCANS_OPEN);
      ws.style.removeProperty("--ws-row-chart");
      ws.style.removeProperty("--ws-row-bottom");
      return;
    }

    ws.style.removeProperty("--ws-col-market");
    ws.style.removeProperty("--ws-col-chart");
    ws.style.removeProperty("--ws-col-scans");
    ws.style.setProperty("--ws-row-chart", collapsed.chart ? COL_COLLAPSED : ROW_CHART_OPEN);
    const bottomCollapsed = collapsed.market && collapsed.scans;
    const bottomOne = collapsed.market || collapsed.scans;
    ws.style.setProperty(
      "--ws-row-bottom",
      bottomCollapsed ? COL_COLLAPSED : bottomOne ? "minmax(0, 1.35fr)" : ROW_BOTTOM_OPEN
    );
  }

  function clearWideState(ws) {
    ws.classList.remove("morning-workspace--wide-accordion", "morning-workspace--wide-collapse-active");
    document.body.classList.remove("is-wide-ws-accordion");
    clearWideGridVars(ws);
  }

  function syncWidePanels(ws) {
    clearWideState(ws);
    ws.classList.add("morning-workspace--wide-accordion");
    document.body.classList.add("is-wide-ws-accordion");
    updateWideGrid(ws);
    wirePanelHeads(true);

    ROWS.forEach(({ key }) => {
      const el = panelEl(key);
      if (!el) return;
      const isCollapsed = !!collapsed[key];
      el.classList.toggle("ws-panel--collapsed", isCollapsed);
      el.classList.toggle("ws-panel--expanded", !isCollapsed);
      el.classList.toggle("ws-panel--snap-active", !isCollapsed);
      const head = el.querySelector(".ws-panel-head");
      if (head) head.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
    });

    if (!collapsed.market && typeof global.RMMarket !== "undefined") {
      const picks = document.getElementById("marketPanel")?._rmPicks;
      global.RMMarket.syncMorningBiasMini(global.RMMarket.getLastMorningBias(), picks);
    }
    if (!collapsed.chart) notifyChartResize();
  }

  function syncMobilePanels(ws) {
    clearWideState(ws);
    ws.classList.add("morning-workspace--mobile-accordion", "morning-workspace--mobile-snap");
    ws.dataset.snapRow = activeKey;
    document.body.classList.add("is-mobile-ws-accordion");
    wirePanelHeads(true);

    ROWS.forEach(({ key }) => {
      const el = panelEl(key);
      if (!el) return;
      const isActive = key === activeKey;
      el.classList.toggle("ws-panel--expanded", isActive);
      el.classList.toggle("ws-panel--collapsed", !isActive);
      el.classList.toggle("ws-panel--snap-active", isActive);
      const head = el.querySelector(".ws-panel-head");
      if (head) head.setAttribute("aria-expanded", isActive ? "true" : "false");
    });

    bindSnapInput();
    updateSnapChrome();
    if (activeKey !== "market" && typeof global.RMMarket !== "undefined") {
      const picks = document.getElementById("marketPanel")?._rmPicks;
      global.RMMarket.syncMorningBiasMini(global.RMMarket.getLastMorningBias(), picks);
    }
    if (activeKey === "chart" || activeKey === "scans") notifyChartResize();
  }

  function syncPanels() {
    const ws = workspace();
    if (!ws) return;

    ws.classList.remove("morning-workspace--mobile-accordion", "morning-workspace--mobile-snap");
    ws.dataset.snapRow = "";
    document.body.classList.remove("is-mobile-ws-accordion");
    unbindSnapInput();

    if (MOBILE_MQ.matches) {
      ROWS.forEach(({ key }) => clearPanelChrome(panelEl(key)));
      syncMobilePanels(ws);
      return;
    }

    ROWS.forEach(({ key }) => clearPanelChrome(panelEl(key)));

    if (WIDE_MQ.matches) {
      syncWidePanels(ws);
      return;
    }

    clearWideState(ws);
    wirePanelHeads(false);
  }

  function expand(key) {
    if (!ROW_KEYS.includes(key)) return;
    if (MOBILE_MQ.matches) {
      lockSnap();
      setActiveRow(key, { smooth: true });
      return;
    }
    if (WIDE_MQ.matches && collapsed[key]) {
      collapsed[key] = false;
      syncPanels();
      notifyChartResize();
    }
  }

  function toggle(key) {
    if (!ROW_KEYS.includes(key)) return;
    if (MOBILE_MQ.matches) {
      if (key !== activeKey) {
        lockSnap();
        setActiveRow(key, { smooth: true });
      }
      return;
    }
    if (WIDE_MQ.matches) toggleWideCollapsed(key);
  }

  function onColumnReady(key) {
    if (MOBILE_MQ.matches) {
      if (key === "market") {
        resetToMarket();
        syncPanels();
        requestAnimationFrame(() => {
          scrollBodiesToTop();
          updateSnapChrome();
        });
        if (typeof global.RMMobilePerf !== "undefined") {
          global.RMMobilePerf.warmAfterMarket();
        }
        if (typeof global.RMHeaderMood !== "undefined") {
          global.RMHeaderMood.refresh?.();
        }
      } else if ((key === "chart" || key === "scans") && activeKey === key) {
        notifyChartResize();
      }
      return;
    }
    if (WIDE_MQ.matches && (key === "chart" || key === "scans") && !collapsed[key]) {
      notifyChartResize();
    }
  }

  function onMqChange() {
    if (MOBILE_MQ.matches) {
      if (!ROW_KEYS.includes(activeKey)) activeKey = "market";
    } else {
      resetToMarket();
    }
    syncPanels();
  }

  function wire() {
    if (wired) return;
    wired = true;
    ROWS.forEach(({ key }) => {
      const head = panelEl(key)?.querySelector(".ws-panel-head");
      if (!head) return;
      head.addEventListener("click", onHeadActivate);
      head.addEventListener("keydown", onHeadKeydown);
    });
    MOBILE_MQ.addEventListener("change", onMqChange);
    WIDE_MQ.addEventListener("change", onMqChange);
    DESKTOP_MQ.addEventListener("change", onMqChange);
    syncPanels();
  }

  function getActiveKey() {
    return MOBILE_MQ.matches ? activeKey : null;
  }

  function init() {
    wireBumpers();
    wireRowNav();
    bindScrollBurst();
    bindMobileTouchChain();
    bindScansTabListeners();
    wire();
  }

  global.RMWorkspaceAccordion = {
    init,
    expand,
    toggle,
    sync: syncPanels,
    onColumnReady,
    getActiveKey,
    setRowNavLoading,
  };
})(typeof window !== "undefined" ? window : globalThis);
