/** Shared floating hover tooltips (market map, chart hub, scan picks). */

(function (global) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  let tipEl = null;
  let tipAnchor = null;
  let buyFlagDismissTimer = null;
  let hideTipTimer = null;
  const delegatedRoots = new WeakSet();

  function ensureTip() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "fvMapTip";
      tipEl.className = "fv-map-tip hidden";
      tipEl.setAttribute("role", "tooltip");
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function buildTipHtml(kicker, title, desc, stat, variant) {
    if (variant === "buy-flag") {
      return (
        '<div class="fv-buy-flag-tip">' +
        (kicker ? '<p class="fv-tip-kicker">' + escapeHtml(kicker) + "</p>" : "") +
        '<p class="fv-tip-title">' +
        escapeHtml(title) +
        "</p>" +
        (stat ? '<p class="fv-tip-stat">' + escapeHtml(stat) + "</p>" : "") +
        '<p class="fv-tip-desc">' +
        escapeHtml(desc) +
        "</p></div>"
      );
    }
    return (
      (kicker ? '<p class="fv-tip-kicker">' + escapeHtml(kicker) + "</p>" : "") +
      '<p class="fv-tip-title">' +
      escapeHtml(title) +
      "</p>" +
      (stat ? '<p class="fv-tip-stat">' + escapeHtml(stat) + "</p>" : "") +
      '<p class="fv-tip-desc">' +
      escapeHtml(desc) +
      "</p>"
    );
  }

  function tipAnchorRect(anchor) {
    if (anchor?.dataset?.fvVariant === "buy-flag") {
      const bag = anchor.querySelector(".ca-buy-bag__scene");
      if (bag) return bag.getBoundingClientRect();
    }
    return anchor.getBoundingClientRect();
  }

  function positionTip(anchor) {
    const tip = ensureTip();
    const rect = tipAnchorRect(anchor);
    const isBuyFlag = anchor?.dataset?.fvVariant === "buy-flag";
    const margin = isBuyFlag ? 0 : 10;
    const snapGap = isBuyFlag ? 1 : 0;
    tip.style.left = "0";
    tip.style.top = "0";
    tip.classList.remove("hidden");
    tip.classList.add("fv-map-tip--show");
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = isBuyFlag
      ? rect.top - tipRect.height - snapGap
      : rect.top - tipRect.height - margin;
    if (!isBuyFlag && top < margin) top = rect.bottom + margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  }

  function showTip(anchor) {
    if (!anchor?.dataset?.fvTitle) return;
    if (
      anchor.closest(".ws-panel-head") ||
      anchor.closest(".ca-toolbar") ||
      anchor.closest(".ca-toolbar-wrap")
    ) {
      return;
    }
    if (
      anchor.dataset.fvVariant === "plan-flag" ||
      anchor.dataset.planFlag === "1"
    ) {
      return;
    }
    tipAnchor = anchor;
    anchor.classList.add("fv-tip-active");
    const tip = ensureTip();
    const variant = anchor.dataset.fvVariant || "";
    tip.classList.toggle("fv-map-tip--buy-flag", variant === "buy-flag");
    tip.innerHTML = buildTipHtml(
      anchor.dataset.fvKicker || "",
      anchor.dataset.fvTitle,
      anchor.dataset.fvDesc || "",
      anchor.dataset.fvStat || "",
      variant
    );
    tip.classList.remove("hidden");
    requestAnimationFrame(() => positionTip(anchor));
  }

  function hideTip() {
    if (hideTipTimer) {
      clearTimeout(hideTipTimer);
      hideTipTimer = null;
    }
    if (buyFlagDismissTimer) clearTimeout(buyFlagDismissTimer);
    buyFlagDismissTimer = null;
    tipAnchor = null;
    if (tipEl) {
      tipEl.classList.remove(
        "fv-map-tip--show",
        "fv-map-tip--buy-flag",
        "fv-map-tip--positioned"
      );
      tipEl.classList.add("hidden");
    }
    document.querySelectorAll(".fv-tip-active").forEach((el) => {
      el.classList.remove("fv-tip-active");
    });
  }

  function scheduleHideTip(delayMs) {
    if (hideTipTimer) clearTimeout(hideTipTimer);
    hideTipTimer = setTimeout(() => {
      hideTipTimer = null;
      if (!tipAnchor) return;
      const tip = tipEl;
      const overTip = tip && !tip.classList.contains("hidden") && tip.matches(":hover");
      const overAnchor = tipAnchor.matches(":hover");
      if (!overTip && !overAnchor) hideTip();
    }, delayMs == null ? 50 : delayMs);
  }

  function pointerOverTipTarget(el) {
    if (!el || !tipEl || tipEl.classList.contains("hidden")) return false;
    return el === tipAnchor || tipEl.contains(el);
  }

  function isClickTip(el) {
    return el?.dataset?.fvVariant === "buy-flag";
  }

  function isChartIndLineTip(el) {
    if (!el) return false;
    if (el.classList?.contains("ca-ind-hit") || el.classList?.contains("ca-fv-hit")) return true;
    return el.dataset?.fvVariant === "chart-ind-line";
  }

  function isPlanFlagTip(el) {
    return (
      el?.dataset?.planFlag === "1" ||
      el?.classList?.contains("ca-plan-flag")
    );
  }

  function tipTargetFromEvent(e) {
    const el = e.target?.closest?.(".fv-tip-target");
    if (!el || isPlanFlagTip(el)) return null;
    return el;
  }

  function animateBuyBag(el, withSound) {
    if (typeof global.RMBuyBagFx === "undefined") return;
    if (withSound) global.RMBuyBagFx.pulse(el);
    else global.RMBuyBagFx.animate(el);
  }

  function chartFocusSymbol() {
    if (typeof RMResultsHero !== "undefined") {
      return RMResultsHero.resolveFocusSymbol();
    }
    if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.state?.symbol) {
      const sym = RMAnalysisChart.state.symbol;
      const compare = RMAnalysisChart.COMPARE_SYM;
      if (sym && sym !== compare) return sym;
      if (sym === compare) return "SPY";
    }
    if (typeof RMChartHub !== "undefined") {
      if (RMChartHub.state?.scanningSym) return RMChartHub.state.scanningSym;
      if (RMChartHub.state?.candidateSym) return RMChartHub.state.candidateSym;
    }
    return "SPY";
  }

  function dispatchResultsHero(detail) {
    document.dispatchEvent(new CustomEvent("rm:results-hero", { detail }));
  }

  function buySignalMetaFrom(el) {
    return {
      kicker: el.dataset.fvKicker || "Buy",
      title: el.dataset.fvTitle || "",
      desc: el.dataset.fvDesc || "",
      time: el.dataset.fvStat || "",
    };
  }

  function onDelegatedPointerOver(e) {
    if (hideTipTimer) {
      clearTimeout(hideTipTimer);
      hideTipTimer = null;
    }
    const el = tipTargetFromEvent(e);
    if (!el) return;
    if (isClickTip(el)) {
      animateBuyBag(el, false);
      return;
    }
    showTip(el);
  }

  function onDelegatedPointerOut(e) {
    const el = tipTargetFromEvent(e);
    const rel = e.relatedTarget;
    if (rel && pointerOverTipTarget(rel)) return;
    if (el && rel && el.contains(rel)) return;
    if (isClickTip(el)) {
      if (tipAnchor === el) scheduleHideTip(80);
      return;
    }
    scheduleHideTip(40);
  }

  function onDelegatedClick(e) {
    const el = tipTargetFromEvent(e);
    if (!el) return;
    if (isClickTip(el)) {
      e.stopPropagation();
      e.preventDefault();
      const sym = chartFocusSymbol();
      animateBuyBag(el, true);
      dispatchResultsHero({
        mode: "signal",
        symbol: sym,
        meta: buySignalMetaFrom(el),
      });
      hideTip();
      showTip(el);
      return;
    }
    if (isChartIndLineTip(el)) {
      e.stopPropagation();
      showTip(el);
    }
  }

  function onDelegatedKeydown(e) {
    const el = tipTargetFromEvent(e);
    if (!el || !isClickTip(el)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onDelegatedClick(e);
  }

  function bindDelegatedTips(root) {
    if (!root || delegatedRoots.has(root)) return;
    delegatedRoots.add(root);
    root.addEventListener("pointerover", onDelegatedPointerOver);
    root.addEventListener("pointerout", onDelegatedPointerOut);
    root.addEventListener("click", onDelegatedClick);
    root.addEventListener("keydown", onDelegatedKeydown);
  }

  function bindGlobalTipDismiss() {
    if (typeof document === "undefined" || document.documentElement.dataset.rmTipDismiss === "1") {
      return;
    }
    document.documentElement.dataset.rmTipDismiss = "1";
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!tipAnchor || tipEl?.classList.contains("hidden")) return;
        if (tipAnchor.contains(e.target) || tipEl?.contains(e.target)) return;
        hideTip();
      },
      true
    );
    document.addEventListener("scroll", () => hideTip(), { passive: true, capture: true });
  }

  function bindPlanFlagToHero(root) {
    if (!root || root.dataset.planHeroBound === "1") return;
    root.dataset.planHeroBound = "1";
    root.addEventListener("click", (e) => {
      const flag = e.target?.closest?.(
        "[data-plan-flag], .ca-plan-flag-hit, .ca-plan-flag"
      );
      if (!flag) return;
      e.stopPropagation();
      e.preventDefault();
      hideTip();
      const sym =
        typeof RMAnalysisChart !== "undefined" &&
        RMAnalysisChart.state?.tradePlan?.symbol
          ? RMAnalysisChart.state.tradePlan.symbol
          : chartFocusSymbol();
      const plan =
        typeof RMAnalysisChart !== "undefined"
          ? RMAnalysisChart.state?.tradePlan
          : null;
      if (plan?.symbol) {
        dispatchResultsHero({ mode: "setup", symbol: plan.symbol, plan });
      }
    });
  }

  function bind(root) {
    if (!root) return;
    bindGlobalTipDismiss();
    bindPlanFlagToHero(root);
    bindDelegatedTips(root);
  }

  function fvTipData(kicker, title, desc, stat, variant) {
    let attrs =
      ' data-fv-kicker="' +
      escapeAttr(kicker || "") +
      '" data-fv-title="' +
      escapeAttr(title || "") +
      '" data-fv-desc="' +
      escapeAttr(desc || "") +
      '"';
    if (stat) attrs += ' data-fv-stat="' + escapeAttr(stat) + '"';
    if (variant) attrs += ' data-fv-variant="' + escapeAttr(variant) + '"';
    return attrs;
  }

  if (typeof window !== "undefined") {
    bindGlobalTipDismiss();
    window.addEventListener(
      "scroll",
      () => {
        if (tipAnchor && tipEl && !tipEl.classList.contains("hidden")) {
          hideTip();
        }
      },
      { passive: true }
    );
  }

  global.RMUiTips = {
    bind,
    hide: hideTip,
    show: showTip,
    fvTipData,
  };
})(typeof window !== "undefined" ? window : globalThis);
