/** Educator overlay — chart-scan / debrief explainer (contextual; no free-form chat primary). */
(function (global) {
  const TIPS = {
    ".price-move": "Percent change vs prior close at scan time (morning = gap + premarket).",
    ".pick-gap": "Gap-up % = open above prior close; bull momentum qualifier.",
    ".ca-holding-band": "Open position band — entry date and avg price from Schwab or manual holding.",
    ".ca-chart-node--scan": "Chart scan node — saved research region on this symbol.",
    ".rm-meter": "H-001 RM confidence from MorningMomentumScanner weights.",
    ".fv-tip-target": "Market map cell — hover for index, breadth, or pick context.",
    "#btnCustomScan": "Runs live H-001 gap-up momentum scan via Yahoo screeners.",
  };

  const POS_KEY = "rainmaker_agent_panel_pos_v1";

  let debriefContext = null;
  let dragState = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "";
    return sign + v.toFixed(2) + "%";
  }

  function fmtNum(v, digits) {
    if (v == null || !Number.isFinite(v)) return "—";
    return v.toFixed(digits == null ? 1 : digits);
  }

  function fmtHeadlineTime(t) {
    if (!t) return "";
    try {
      return new Date(t).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
    } catch {
      return "";
    }
  }

  function loadPanelPos() {
    try {
      return JSON.parse(sessionStorage.getItem(POS_KEY) || "null");
    } catch {
      return null;
    }
  }

  function savePanelPos(panel) {
    if (!panel || panel.classList.contains("hidden")) return;
    const r = panel.getBoundingClientRect();
    try {
      sessionStorage.setItem(
        POS_KEY,
        JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })
      );
    } catch {
      /* ignore */
    }
  }

  function applyPanelPos(panel) {
    const pos = loadPanelPos();
    if (!pos || pos.left == null || pos.top == null) return;
    panel.style.right = "auto";
    panel.style.left = Math.max(8, pos.left) + "px";
    panel.style.top = Math.max(8, pos.top) + "px";
    panel.style.transform = "none";
    panel.dataset.userPos = "1";
  }

  function clampPanelPos(panel, left, top) {
    const r = panel.getBoundingClientRect();
    const w = r.width || panel.offsetWidth || 280;
    const h = r.height || panel.offsetHeight || 200;
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
    };
  }

  function bindPanelDrag(panel) {
    const head = panel.querySelector(".agent-head");
    if (!head || head.dataset.dragBound === "1") return;
    head.dataset.dragBound = "1";

    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      panel.style.right = "auto";
      panel.style.left = r.left + "px";
      panel.style.top = r.top + "px";
      panel.style.transform = "none";
      panel.dataset.userPos = "1";
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        left: r.left,
        top: r.top,
      };
      panel.classList.add("is-dragging");
      head.setPointerCapture(e.pointerId);
    });

    head.addEventListener("pointermove", (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const next = clampPanelPos(panel, dragState.left + dx, dragState.top + dy);
      panel.style.left = next.left + "px";
      panel.style.top = next.top + "px";
    });

    const endDrag = (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      dragState = null;
      panel.classList.remove("is-dragging");
      savePanelPos(panel);
      try {
        head.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
  }

  function confidenceBadge(level) {
    const lv = String(level || "low").toLowerCase();
    const label = lv === "high" ? "High" : lv === "med" ? "Med" : "Low";
    return (
      '<span class="agent-conf-badge is-' +
      escapeHtml(lv) +
      '" title="Evidence strength">' +
      escapeHtml(label) +
      "</span>"
    );
  }

  function structureClass(structure) {
    const s = String(structure || "").toLowerCase();
    if (s.includes("up")) return "is-up";
    if (s.includes("down")) return "is-down";
    return "is-flat";
  }

  function renderMetricChip(k, v, cls) {
    return (
      '<div class="agent-metric' +
      (cls ? " " + cls : "") +
      '"><span class="agent-metric-k">' +
      escapeHtml(k) +
      '</span><strong class="agent-metric-v">' +
      escapeHtml(v) +
      "</strong></div>"
    );
  }

  function renderCatalystList(items) {
    if (!items?.length) {
      return (
        '<p class="agent-empty">No headlines in window — run Scan + news or widen the circle.</p>'
      );
    }
    return (
      '<ul class="agent-catalyst-list">' +
      items
        .map((hit) => {
          const tag = hit.tag === "in circle" ? "in" : "near";
          const when = fmtHeadlineTime(hit.t);
          return (
            '<li class="agent-catalyst-item">' +
            '<span class="agent-cat-tag is-' +
            tag +
            '">' +
            (tag === "in" ? "In" : "Near") +
            "</span>" +
            (when ? '<time class="agent-cat-time">' + escapeHtml(when) + "</time>" : "") +
            '<span class="agent-cat-title">' +
            escapeHtml(hit.title || "") +
            "</span></li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function renderDebriefBody(ctx) {
    if (!ctx) {
      return (
        '<div class="agent-idle">' +
        '<p class="agent-idle-lead">Research assistant</p>' +
        '<p class="agent-idle-copy">Right-click a chart circle → <strong>Analyze</strong>. Structured debrief lands here — not open chat.</p>' +
        "</div>"
      );
    }

    const m = ctx.metrics || {};
    const moveCls =
      m.movePct > 0.05 ? "is-pos" : m.movePct < -0.05 ? "is-neg" : "";
    const macdVal = m.macdHist;
    const macdLabel =
      macdVal == null
        ? "—"
        : (macdVal >= 0 ? "+" : "") + fmtNum(macdVal, 2);
    const macdCls = macdVal > 0 ? "is-pos" : macdVal < 0 ? "is-neg" : "";

    const metrics =
      '<div class="agent-metrics">' +
      renderMetricChip("Move", fmtPct(m.movePct), moveCls) +
      renderMetricChip(
        "Shape",
        m.structure || "—",
        "agent-metric--shape " + structureClass(m.structure)
      ) +
      renderMetricChip("RSI", m.rsi == null ? "—" : fmtNum(m.rsi, 0)) +
      renderMetricChip("MACD", macdLabel, macdCls) +
      renderMetricChip("Bars", m.bars != null ? String(m.bars) : "—") +
      "</div>";

    const range =
      m.hi != null || m.lo != null
        ? '<div class="agent-range-row">' +
          '<span class="agent-range-k">Range</span>' +
          '<span class="agent-range-v">' +
          escapeHtml(ctx.rangeLabel || "—") +
          "</span></div>"
        : "";

    const confidenceCopy = ctx.confidence
      ? String(ctx.confidence).replace(/^[^:]+:\s*/i, "")
      : "";

    return (
      '<article class="agent-debrief is-live">' +
      '<div class="agent-debrief-head">' +
      '<div class="agent-debrief-title">' +
      '<span class="agent-sym">' +
      escapeHtml(ctx.symbol || ctx.title || "Scan") +
      "</span>" +
      confidenceBadge(ctx.confidenceLevel) +
      "</div>" +
      (ctx.hint
        ? '<p class="agent-window">' + escapeHtml(ctx.hint) + "</p>"
        : "") +
      "</div>" +
      metrics +
      range +
      '<section class="agent-sec">' +
      '<h4 class="agent-sec-k">Catalyst</h4>' +
      renderCatalystList(ctx.catalystItems) +
      "</section>" +
      (confidenceCopy
        ? '<p class="agent-conf-note">' + escapeHtml(confidenceCopy) + "</p>"
        : "") +
      (ctx.scanId
        ? '<div class="agent-debrief-actions">' +
          '<button type="button" class="agent-act agent-act--primary" id="agentDebriefSave">Save to story</button>' +
          '<button type="button" class="agent-act" id="agentDebriefDismiss">Close</button>' +
          "</div>"
        : "") +
      "</article>"
    );
  }

  function renderDebrief(ctx) {
    debriefContext = ctx || null;
    const log = $("agentLog");
    const panel = $("agentPanel");
    if (!log) return;

    log.innerHTML = renderDebriefBody(ctx);

    if (panel) {
      panel.classList.toggle("has-debrief", !!ctx);
      panel.classList.toggle("is-idle", !ctx);
    }

    const hint = $("agentHint");
    if (hint) {
      hint.textContent = ctx
        ? "Drag header to reposition · Ctrl+Z undoes scan edits"
        : "Hover controls for tips";
    }

    bindDebriefActions(ctx);
  }

  function bindDebriefActions(ctx) {
    $("agentDebriefDismiss")?.addEventListener("click", () => {
      $("agentPanel")?.classList.add("hidden");
    });
    $("agentDebriefSave")?.addEventListener("click", () => {
      if (!ctx?.scanId || typeof RMChartScan === "undefined") return;
      const scan = RMChartScan.getScanForDebrief(ctx.scanId);
      if (!scan) return;
      const analysis = RMChartScan.analyzeRegion({
        region: scan,
        bars: typeof RMAnalysisChart !== "undefined" ? RMAnalysisChart.state?.bars : [],
        headlines:
          typeof RMAnalysisChart !== "undefined"
            ? RMAnalysisChart.headlinesForChartSymbol?.(scan.symbol)
            : [],
        pctMode: RMAnalysisChart?.state?.metrics?.mode === "pct",
      });
      void RMChartScan.saveResearchToStory(scan, analysis).then(() => {
        const hint = $("agentHint");
        if (hint) hint.textContent = "Saved to today's trade story.";
        const saveBtn = $("agentDebriefSave");
        if (saveBtn) {
          saveBtn.textContent = "Saved";
          saveBtn.disabled = true;
        }
      });
    });
  }

  function bindHoverTips() {
    document.body.addEventListener(
      "mouseover",
      (e) => {
        if (debriefContext) return;
        const t = e.target.closest(Object.keys(TIPS).join(","));
        if (!t) return;
        const sel = Object.keys(TIPS).find((k) => t.matches(k));
        if (sel) {
          const hint = $("agentHint");
          if (hint) hint.textContent = TIPS[sel];
        }
      },
      { passive: true }
    );
  }

  function openPanel() {
    const panel = $("agentPanel");
    if (!panel) return;
    panel.classList.remove("hidden");
    applyPanelPos(panel);
  }

  function togglePanel() {
    $("agentPanel")?.classList.toggle("hidden");
  }

  function mount() {
    if ($("agentPanel")) return;

    const panel = document.createElement("aside");
    panel.id = "agentPanel";
    panel.className = "agent-panel hidden is-idle";
    panel.innerHTML =
      '<header class="agent-head" title="Drag to move">' +
      '<div class="agent-head-main">' +
      '<span class="agent-live-dot" aria-hidden="true"></span>' +
      '<div class="agent-head-text">' +
      '<strong class="agent-head-title">Research</strong>' +
      '<span class="agent-hint-line" id="agentHint">Hover controls for tips</span>' +
      "</div></div>" +
      '<button type="button" class="agent-close side-drawer-close" id="agentClose" aria-label="Close">×</button>' +
      "</header>" +
      '<div class="agent-body" id="agentLog"></div>';

    document.body.appendChild(panel);
    renderDebrief(null);
    bindPanelDrag(panel);
    applyPanelPos(panel);

    const trigger = $("btnBrandGuide") || document.querySelector(".brand-guide-trigger");
    if (trigger) {
      trigger.addEventListener("dblclick", (e) => {
        e.preventDefault();
        togglePanel();
      });
    }

    $("agentClose").onclick = () => panel.classList.add("hidden");
    bindHoverTips();
    document.addEventListener("rm:debrief", (e) => {
      if (e.detail) {
        renderDebrief(e.detail);
        openPanel();
      }
    });

    window.addEventListener(
      "resize",
      () => {
        if (panel.classList.contains("hidden") || panel.dataset.userPos !== "1") return;
        const r = panel.getBoundingClientRect();
        const next = clampPanelPos(panel, r.left, r.top);
        panel.style.left = next.left + "px";
        panel.style.top = next.top + "px";
        savePanelPos(panel);
      },
      { passive: true }
    );
  }

  global.RMAgent = {
    mount,
    renderDebrief,
    togglePanel,
    openPanel,
    getDebriefContext: () => debriefContext,
  };
})(typeof window !== "undefined" ? window : globalThis);
