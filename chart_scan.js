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
