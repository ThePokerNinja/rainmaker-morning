/**
 * Virtualized Results pick list (30+ rows): only mounts visible rows + scroll spacers.
 */
(function (global) {
  const THRESHOLD = 30;
  const ROW_HEIGHT_PX = 56;
  const BUFFER_ROWS = 6;

  let host = null;
  let scrollEl = null;
  let topSpacer = null;
  let windowEl = null;
  let bottomSpacer = null;
  let bannerEl = null;
  let picks = [];
  let renderRow = null;
  let bindRoot = null;
  let active = false;
  let raf = null;
  let resizeObs = null;

  function scrollParent(el) {
    return (
      el.closest(".ws-scans-list") ||
      el.closest(".tt-results-scroll") ||
      el
    );
  }

  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      paintWindow();
    });
  }

  function bindVisible(root) {
    if (!root || !bindRoot) return;
    bindRoot(root);
    if (typeof RMChartHub === "undefined" || !RMChartHub.renderPickMini) return;
    root.querySelectorAll("[data-pick-chart]").forEach((el) => {
      const sym = el.dataset.pickChart;
      if (sym) RMChartHub.renderPickMini(sym, el);
    });
  }

  function paintWindow() {
    if (!active || !host || !windowEl || !scrollEl) return;
    const total = picks.length;
    if (!total) {
      windowEl.innerHTML = "";
      topSpacer.style.height = "0";
      bottomSpacer.style.height = "0";
      return;
    }
    const scrollTop = Math.max(0, scrollEl.scrollTop - (bannerEl?.offsetHeight || 0));
    const viewH = scrollEl.clientHeight || 400;
    let start = Math.floor(scrollTop / ROW_HEIGHT_PX) - BUFFER_ROWS;
    let end = Math.ceil((scrollTop + viewH) / ROW_HEIGHT_PX) + BUFFER_ROWS;
    start = Math.max(0, start);
    end = Math.min(total, end);
    topSpacer.style.height = start * ROW_HEIGHT_PX + "px";
    bottomSpacer.style.height = Math.max(0, (total - end) * ROW_HEIGHT_PX) + "px";
    windowEl.innerHTML = picks.slice(start, end).map((p) => renderRow(p)).join("");
    bindVisible(windowEl);
  }

  function mount(listEl, options) {
    destroy();
    if (!listEl) return;
    host = listEl;
    renderRow = options?.renderRow;
    bindRoot = options?.bind;
    scrollEl = scrollParent(listEl);
    listEl.innerHTML = "";
    listEl.classList.add("pick-list-virtual-host");
    bannerEl = null;
    topSpacer = document.createElement("div");
    topSpacer.className = "pick-list-virtual-top";
    topSpacer.setAttribute("aria-hidden", "true");
    windowEl = document.createElement("div");
    windowEl.className = "pick-list-virtual-window";
    bottomSpacer = document.createElement("div");
    bottomSpacer.className = "pick-list-virtual-bottom";
    bottomSpacer.setAttribute("aria-hidden", "true");
    listEl.append(topSpacer, windowEl, bottomSpacer);
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(() => onScroll());
      resizeObs.observe(scrollEl);
    }
  }

  function setBanner(html) {
    if (!host) return;
    if (!html) {
      bannerEl?.remove();
      bannerEl = null;
      return;
    }
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.className = "pick-list-virtual-banner";
      host.insertBefore(bannerEl, topSpacer);
    }
    bannerEl.innerHTML = html;
  }

  function render(list, bannerHtml) {
    picks = list || [];
    active = picks.length >= THRESHOLD;
    if (!host) return false;
    if (!active) return false;
    setBanner(bannerHtml || "");
    paintWindow();
    return true;
  }

  function refresh(list, bannerHtml) {
    if (!host) return false;
    picks = list || [];
    if (picks.length < THRESHOLD) {
      active = false;
      return false;
    }
    active = true;
    setBanner(bannerHtml || "");
    paintWindow();
    return true;
  }

  function updateRow(symbol, html) {
    if (!active || !windowEl) return false;
    const esc =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(String(symbol))
        : String(symbol).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const row = windowEl.querySelector('.pick-row[data-symbol="' + esc + '"]');
    if (!row) return false;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    if (!next) return false;
    row.replaceWith(next);
    bindVisible(windowEl);
    return true;
  }

  function scrollToSymbol(symbol) {
    if (!active || !scrollEl) return;
    const idx = picks.findIndex((p) => p.symbol === symbol);
    if (idx < 0) return;
    scrollEl.scrollTop = idx * ROW_HEIGHT_PX;
    paintWindow();
  }

  function destroy() {
    active = false;
    picks = [];
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    if (scrollEl) scrollEl.removeEventListener("scroll", onScroll);
    scrollEl = null;
    if (host) {
      host.classList.remove("pick-list-virtual-host");
      host.innerHTML = "";
    }
    host = null;
    topSpacer = null;
    windowEl = null;
    bottomSpacer = null;
    bannerEl = null;
  }

  global.RMVirtualPickList = {
    THRESHOLD,
    shouldVirtualize: (n) => (n || 0) >= THRESHOLD,
    isActive: () => active,
    isMounted: () => !!host,
    mount,
    render,
    refresh,
    updateRow,
    scrollToSymbol,
    destroy,
  };
})(typeof window !== "undefined" ? window : globalThis);
