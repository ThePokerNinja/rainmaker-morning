/**
 * Trade debrief - deterministic "What happened?" Reflect flow for recent Schwab closes.
 */
(function (global) {
  "use strict";

  const REFLECT_TAGS = [
    { id: "regime_mismatch", label: "Regime mismatch" },
    { id: "no_plan", label: "No plan" },
    { id: "stop_honored", label: "Stop honored" },
    { id: "stop_tight", label: "Stop too tight" },
    { id: "held_too_long", label: "Held too long" },
    { id: "good_process", label: "Good process" },
  ];

  let activeTrade = null;
  let selectedTags = new Set();
  let wired = false;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtUsd(n) {
    if (n == null || !Number.isFinite(n)) return "N/A";
    const sign = n >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(n).toFixed(2);
  }

  function fmtTime(iso) {
    if (!iso) return "N/A";
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (e) {
      return String(iso).slice(0, 16);
    }
  }

  function holdMinutes(trade) {
    const a = Date.parse(trade.opened_at || "");
    const b = Date.parse(trade.closed_at || "");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
    return Math.round((b - a) / 60000);
  }

  function fmtHold(mins) {
    if (mins == null) return "N/A";
    if (mins < 60) return mins + "m";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? h + "h " + m + "m" : h + "h";
  }

  function chartSymbolForTrade(trade) {
    if (typeof global.RMHoldings !== "undefined" && global.RMHoldings.chartSymbolFor) {
      return global.RMHoldings.chartSymbolFor({
        symbol: trade.symbol,
        instrument: trade.instrument,
      });
    }
    return String(trade.symbol || "").trim().toUpperCase();
  }

  function optionDirection(symbol) {
    const s = String(symbol || "").replace(/\s+/g, "").toUpperCase();
    const m = s.match(/\d{6}([CP])\d{8}/);
    if (!m) return null;
    return m[1] === "C" ? "long_call" : "long_put";
  }

  function tradeDirection(trade) {
    if (trade.instrument === "option" || optionDirection(trade.symbol)) {
      return optionDirection(trade.symbol) || "long_call";
    }
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price ?? trade.exit_premium;
    if (entry != null && exit != null && exit < entry) return "long_loss";
    return "long_stock";
  }

  function biasLeanFromPct(pct) {
    if (pct == null || !Number.isFinite(pct)) return null;
    if (pct > 0.05) return 1;
    if (pct < -0.05) return -1;
    return 0;
  }

  function pulseLeanForTradeDay(trade) {
    if (trade.engine_bias && typeof trade.engine_bias.lean === "number") {
      return trade.engine_bias.lean;
    }
    const day = String(trade.opened_at || trade.closed_at || "").slice(0, 10);
    if (!day || typeof global.RMMarket === "undefined" || !global.RMMarket.loadBiasLog) {
      return null;
    }
    const log = global.RMMarket.loadBiasLog();
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (!e || e.at == null) continue;
      let eDay;
      try {
        eDay = new Date(e.at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      } catch (err) {
        eDay = String(e.at).slice(0, 10);
      }
      if (eDay === day) {
        return biasLeanFromPct(e.marketPct);
      }
    }
    return null;
  }

  function pulseLabel(lean) {
    if (lean == null) return "Unknown";
    if (lean > 0) return "Bullish";
    if (lean < 0) return "Bearish";
    return "Neutral";
  }

  function sessionLabel(iso) {
    if (!iso) return "N/A";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      }).formatToParts(new Date(iso));
      const hour = Number(parts.find((p) => p.type === "hour")?.value);
      if (!Number.isFinite(hour)) return "RTH";
      if (hour < 9) return "Pre-market";
      if (hour >= 16) return "After-hours";
      return "RTH";
    } catch (e) {
      return "RTH";
    }
  }

  function exitKind(trade) {
    const exit = trade.exit_price ?? trade.exit_premium;
    const stop = trade.stop_price ?? trade.stop_premium;
    const target = trade.target_price;
    if (exit == null) return "unknown";
    if (stop != null && Math.abs(exit - stop) / Math.max(Math.abs(stop), 0.01) < 0.02) {
      return "stop-out";
    }
    if (target != null && Math.abs(exit - target) / Math.max(Math.abs(target), 0.01) < 0.02) {
      return "target";
    }
    return "discretionary";
  }

  function isPlanned(trade) {
    if (typeof global.RMTradeMetrics !== "undefined" && global.RMTradeMetrics.isPlannedTrade) {
      return global.RMTradeMetrics.isPlannedTrade(trade);
    }
    return trade.planned !== false && trade.source !== "schwab_api";
  }

  function priceLine(trade) {
    const isOpt = trade.instrument === "option";
    const entry = isOpt ? trade.entry_premium ?? trade.entry_price : trade.entry_price;
    const exit = isOpt ? trade.exit_premium ?? trade.exit_price : trade.exit_price;
    const unit = isOpt ? " premium" : "";
    let s = "";
    if (entry != null) s += "entry $" + Number(entry).toFixed(2) + unit;
    if (exit != null) s += (s ? " | " : "") + "exit $" + Number(exit).toFixed(2) + unit;
    return s || "N/A";
  }

  function realizedRDisplay(trade) {
    if (typeof global.RMTradeMetrics === "undefined") {
      return trade.r_multiple != null ? Number(trade.r_multiple).toFixed(2) + "R" : "N/A";
    }
    const rr = global.RMTradeMetrics.realizedR(trade);
    if (rr != null) return (rr >= 0 ? "+" : "") + Number(rr).toFixed(2) + "R";
    const stop = trade.stop_price ?? trade.stop_premium;
    if (stop == null && !isPlanned(trade)) return "N/A (no stop)";
    return "N/A";
  }

  function suggestTags(trade, learnings) {
    const tags = new Set();
    const lean = pulseLeanForTradeDay(trade);
    const dir = tradeDirection(trade);
    const mins = holdMinutes(trade);
    const planned = isPlanned(trade);
    const kind = exitKind(trade);

    if (!planned) tags.add("no_plan");

    if (lean != null) {
      const against =
        (lean < 0 && (dir === "long_call" || dir === "long_stock")) ||
        (lean > 0 && dir === "long_put");
      if (against) tags.add("regime_mismatch");
    }

    if (kind === "stop-out") tags.add("stop_honored");
    if (mins != null && mins < 15 && (trade.pnl_usd == null || trade.pnl_usd < 0)) {
      tags.add("stop_tight");
    }
    if (mins != null && mins > 240) tags.add("held_too_long");

    if (
      planned &&
      kind === "stop-out" &&
      typeof global.RMTradeMetrics !== "undefined" &&
      global.RMTradeMetrics.reconcileStatus(trade) === "agreed"
    ) {
      tags.add("good_process");
    }

    (learnings || []).forEach(function (ln) {
      if (/regime|against.*pulse|bearish.*call|bullish.*put/i.test(ln)) tags.add("regime_mismatch");
      if (/no plan|imported from schwab/i.test(ln)) tags.add("no_plan");
      if (/stop honored|stopped out/i.test(ln)) tags.add("stop_honored");
      if (/impulse|within 15/i.test(ln)) tags.add("stop_tight");
      if (/held.*long|4\+ hours/i.test(ln)) tags.add("held_too_long");
    });

    return tags;
  }

  function buildLearnings(trade) {
    const out = [];
    const lean = pulseLeanForTradeDay(trade);
    const dir = tradeDirection(trade);
    const mins = holdMinutes(trade);
    const planned = isPlanned(trade);
    const kind = exitKind(trade);

    if (!planned) {
      out.push(
        "No Rainmaker plan - imported from Schwab. Add a retrospective stop in debrief to compute R."
      );
    }

    if (lean != null) {
      const pulse = pulseLabel(lean);
      if (lean < 0 && dir === "long_call") {
        out.push("Pulse was " + pulse.toLowerCase() + "; long call traded against regime.");
      } else if (lean > 0 && dir === "long_put") {
        out.push("Pulse was " + pulse.toLowerCase() + "; long put traded against regime.");
      } else if (lean !== 0) {
        out.push("Pulse was " + pulse.toLowerCase() + " on trade day - direction aligned with lean.");
      }
    }

    if (mins != null && mins < 15) {
      out.push("Exit within 15m of entry - impulse / quick stop flag.");
    } else if (mins != null && mins > 240) {
      out.push("Held " + fmtHold(mins) + " - review whether thesis needed earlier exit.");
    }

    if (kind === "stop-out") {
      out.push("Exit matched stop zone - stop honored.");
    } else if (kind === "target") {
      out.push("Exit near planned target.");
    }

    if (planned && typeof global.RMTradeMetrics !== "undefined") {
      const status = global.RMTradeMetrics.reconcileStatus(trade);
      if (status === "delta") {
        const pr = global.RMTradeMetrics.planR(trade);
        const rr = global.RMTradeMetrics.realizedR(trade);
        out.push(
          "Plan vs realized delta - Plan " +
            (pr != null ? pr.toFixed(2) : "?") +
            "R vs Realized " +
            (rr != null ? rr.toFixed(2) : "?") +
            "R."
        );
      }
    }

    if (trade.pnl_usd != null && trade.pnl_usd < 0 && kind === "stop-out" && !planned) {
      out.push("Stop-out without a written setup - capture what assumption broke.");
    }

    while (out.length < 2) {
      if (trade.instrument === "option") {
        out.push("Options trade - R uses premium; verify contract qty x 100 for P/L.");
        break;
      }
      out.push("Review chart structure at entry vs exit window.");
      break;
    }

    return out.slice(0, 4);
  }

  function buildDebrief(trade) {
    if (!trade) return null;
    const learnings = buildLearnings(trade);
    const lean = pulseLeanForTradeDay(trade);
    const planned = isPlanned(trade);
    const pr =
      typeof global.RMTradeMetrics !== "undefined" ? global.RMTradeMetrics.planR(trade) : trade.plan_r;
    const rr =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.realizedR(trade)
        : trade.realized_r;

    return {
      trade: trade,
      facts: {
        symbol: trade.symbol,
        instrument: trade.instrument || "stock",
        qty: trade.quantity ?? trade.qty,
        prices: priceLine(trade),
        opened: fmtTime(trade.opened_at),
        closed: fmtTime(trade.closed_at),
        hold: fmtHold(holdMinutes(trade)),
        pnl: fmtUsd(trade.pnl_usd),
        realizedR: realizedRDisplay(trade),
        exitKind: exitKind(trade),
      },
      context: {
        pulseLean: lean,
        pulseLabel: pulseLabel(lean),
        session: sessionLabel(trade.opened_at),
        chartSymbol: chartSymbolForTrade(trade),
      },
      planDelta: planned
        ? {
            hasPlan: true,
            planR: pr,
            realizedR: rr,
            dual:
              typeof global.RMTradeMetrics !== "undefined"
                ? global.RMTradeMetrics.fmtDualTrack(trade)
                : "",
            reconcile:
              typeof global.RMTradeMetrics !== "undefined"
                ? global.RMTradeMetrics.reconcileStatus(trade)
                : trade.reconcile_status,
          }
        : {
            hasPlan: false,
            message: "No Rainmaker plan - imported from Schwab",
          },
      learnings: learnings,
      suggestedTags: [...suggestTags(trade, learnings)],
    };
  }

  function renderDebriefHtml(debrief) {
    if (!debrief) return "";
    const f = debrief.facts;
    const c = debrief.context;
    const p = debrief.planDelta;
    let html = "";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Facts</h3>";
    html += '<div class="rm-debrief-facts">';
    html += "<div><strong>" + escapeHtml(f.symbol) + "</strong> | " + escapeHtml(f.instrument);
    if (f.qty != null) html += " | qty " + escapeHtml(f.qty);
    html += "</div>";
    html += "<div>" + escapeHtml(f.prices) + "</div>";
    html +=
      "<div>" +
      escapeHtml(f.opened) +
      " -> " +
      escapeHtml(f.closed) +
      " | hold " +
      escapeHtml(f.hold) +
      "</div>";
    html +=
      "<div>P/L " +
      escapeHtml(f.pnl) +
      " | Realized " +
      escapeHtml(f.realizedR) +
      " | " +
      escapeHtml(f.exitKind) +
      "</div>";
    html += "</div></section>";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Context</h3>";
    html += '<p class="meta">Pulse: <strong>' + escapeHtml(c.pulseLabel) + "</strong>";
    html += " | Session: " + escapeHtml(c.session);
    html += " | Chart: " + escapeHtml(c.chartSymbol) + "</p>";
    html += "</section>";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Plan</h3>";
    if (p.hasPlan) {
      html += '<p class="meta">' + escapeHtml(p.dual || "Plan on file") + "</p>";
      if (p.reconcile === "delta") {
        html += '<p class="meta rm-debrief-warn">Reconcile delta - plan R differed from realized.</p>';
      }
    } else {
      html += '<p class="meta">' + escapeHtml(p.message) + "</p>";
      html +=
        '<label class="rm-debrief-stop-label">Retrospective stop (premium/price)<input type="number" step="0.01" id="debriefRetroStop" class="rm-debrief-stop-input" placeholder="Optional"></label>';
    }
    html += "</section>";

    html += '<section class="rm-debrief-section">';
    html += '<h3>Platform learnings</h3><ul class="rm-debrief-learnings">';
    debrief.learnings.forEach(function (ln) {
      html += "<li>" + escapeHtml(ln) + "</li>";
    });
    html += "</ul></section>";

    html += '<section class="rm-debrief-section">';
    html += "<h3>Reflect tags</h3>";
    html += '<div class="rm-debrief-tags" id="debriefTags">';
    REFLECT_TAGS.forEach(function (tag) {
      const on = debrief.suggestedTags.indexOf(tag.id) >= 0 ? " is-selected" : "";
      html +=
        '<button type="button" class="rm-debrief-tag' +
        on +
        '" data-tag="' +
        escapeHtml(tag.id) +
        '">' +
        escapeHtml(tag.label) +
        "</button>";
    });
    html += "</div>";
    html +=
      '<label class="rm-debrief-note-label">Note<textarea id="debriefNoteText" rows="2" placeholder="Optional one-liner"></textarea></label>';
    html += '<button type="button" class="btn-block" id="debriefSaveBtn">Save Reflect note</button>';
    html += '<p class="meta rm-debrief-save-status" id="debriefSaveStatus" aria-live="polite"></p>';
    html += "</section>";

    return html;
  }

  async function focusChartForDebrief(trade) {
    if (!trade || typeof global.RMAnalysisChart === "undefined") return;
    const chartSym = chartSymbolForTrade(trade);
    if (typeof global.RMWorkspaceAccordion !== "undefined") {
      global.RMWorkspaceAccordion.expand("chart");
    }
    if (typeof global.closeOrderDrawer === "function") {
      global.closeOrderDrawer();
    }
    const symEl = $("caSymbol");
    if (symEl) {
      let hasOpt = false;
      symEl.querySelectorAll("option").forEach(function (o) {
        if (o.value === chartSym) hasOpt = true;
      });
      if (!hasOpt) {
        const opt = document.createElement("option");
        opt.value = chartSym;
        opt.textContent = chartSym;
        symEl.appendChild(opt);
      }
      symEl.value = chartSym;
    }
    global.RMAnalysisChart.state.symbol = chartSym;
    global.RMAnalysisChart.state.showEvents = true;
    const tStart = Date.parse(trade.opened_at || "");
    const tEnd = Date.parse(trade.closed_at || "");
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price ?? trade.exit_premium;
    if (global.RMAnalysisChart.saveTradeMarker) {
      global.RMAnalysisChart.saveTradeMarker({
        id: "debrief-" + String(trade.id || trade.symbol),
        symbol: chartSym,
        entry_price: entry,
        exit_price: exit,
        stop_price: trade.stop_price ?? trade.stop_premium ?? null,
        target_price: trade.target_price ?? null,
        t: Number.isFinite(tStart) ? tStart : Date.now(),
        exit_t: Number.isFinite(tEnd) ? tEnd : null,
        closed_at: trade.closed_at || new Date().toISOString(),
        session_id: trade.session_id || null,
        filled: true,
        source: trade.source || "debrief",
        label:
          trade.instrument === "option" || chartSym !== String(trade.symbol || "").trim().toUpperCase()
            ? trade.symbol
            : null,
      });
    }
    if (global.RMAnalysisChart.setActiveTradeMarker) {
      global.RMAnalysisChart.setActiveTradeMarker(
        "debrief-" + String(trade.id || trade.symbol),
        trade.symbol
      );
    }
    if (global.RMAnalysisChart.setDebriefWindow) {
      global.RMAnalysisChart.setDebriefWindow({
        symbol: chartSym,
        tStart: Number.isFinite(tStart) ? tStart : null,
        tEnd: Number.isFinite(tEnd) ? tEnd : null,
      });
    }
    if (global.RMAnalysisChart.reload) {
      await global.RMAnalysisChart.reload({ preserveView: false, resetView: true });
    } else if (global.RMAnalysisChart.paint) {
      global.RMAnalysisChart.paint();
    }
    if (
      global.RMAnalysisChart.focusDebriefWindow &&
      Number.isFinite(tStart) &&
      Number.isFinite(tEnd)
    ) {
      global.RMAnalysisChart.focusDebriefWindow(tStart, tEnd);
      global.RMAnalysisChart.paint?.();
    }
  }

  function clearChartDebrief() {
    if (typeof global.RMAnalysisChart !== "undefined" && global.RMAnalysisChart.clearDebriefWindow) {
      global.RMAnalysisChart.clearDebriefWindow();
    }
  }

  function openDrawer() {
    const drawer = $("tradeDebriefDrawer");
    const backdrop = $("debriefBackdrop");
    if (!drawer) return;
    drawer.classList.remove("is-closed");
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    if (backdrop) {
      backdrop.classList.remove("hidden");
      backdrop.setAttribute("aria-hidden", "false");
    }
    document.body.classList.add("debrief-open");
  }

  function closeDebrief() {
    const drawer = $("tradeDebriefDrawer");
    const backdrop = $("debriefBackdrop");
    if (drawer) {
      drawer.classList.add("is-closed");
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
    }
    if (backdrop) {
      backdrop.classList.add("hidden");
      backdrop.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("debrief-open");
    activeTrade = null;
    selectedTags = new Set();
    clearChartDebrief();
  }

  function wirePanelEvents(debrief) {
    selectedTags = new Set(debrief.suggestedTags || []);
    const tagsEl = $("debriefTags");
    if (tagsEl) {
      tagsEl.querySelectorAll(".rm-debrief-tag").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const tag = btn.getAttribute("data-tag");
          if (!tag) return;
          if (selectedTags.has(tag)) {
            selectedTags.delete(tag);
            btn.classList.remove("is-selected");
          } else {
            selectedTags.add(tag);
            btn.classList.add("is-selected");
          }
        });
      });
    }
    const saveBtn = $("debriefSaveBtn");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        void saveDebriefNote(activeTrade, debrief);
      });
    }
  }

  async function saveDebriefNote(trade, debrief) {
    if (!trade) return;
    const statusEl = $("debriefSaveStatus");
    const noteText = ($("debriefNoteText") && $("debriefNoteText").value.trim()) || "";
    const retroStop = $("debriefRetroStop") ? Number($("debriefRetroStop").value) : null;
    const tags = selectedTags.size ? [...selectedTags] : debrief?.suggestedTags || [];
    const lean = debrief?.context?.pulseLean ?? pulseLeanForTradeDay(trade);
    let realizedR =
      typeof global.RMTradeMetrics !== "undefined"
        ? global.RMTradeMetrics.realizedR(trade)
        : trade.realized_r;
    if (realizedR == null && Number.isFinite(retroStop)) {
      const entry = trade.entry_price ?? trade.entry_premium;
      const exit = trade.exit_price ?? trade.exit_premium;
      const risk = entry - retroStop;
      if (entry != null && exit != null && risk > 0) {
        realizedR = Math.round(((exit - entry) / risk) * 10000) / 10000;
      }
    }
    const summary =
      noteText ||
      tags
        .map(function (id) {
          const t = REFLECT_TAGS.find(function (x) {
            return x.id === id;
          });
          return t ? t.label : id;
        })
        .join("; ") ||
      (debrief?.facts?.exitKind === "stop-out" ? "Stopped out debrief." : "Trade debrief.");

    const storyDay = String(trade.closed_at || trade.opened_at || "").slice(0, 10);
    const event = {
      type: "note",
      subtype: "what_happened",
      trade_id: trade.id || null,
      symbol: trade.symbol,
      tags: tags,
      summary: summary,
      learnings: debrief?.learnings || [],
      snapshot: {
        pulse_lean: lean,
        realized_r: realizedR,
        pnl_usd: trade.pnl_usd ?? null,
        instrument: trade.instrument || "stock",
        exit_kind: debrief?.facts?.exitKind || null,
      },
    };

    if (typeof global.RMTradeStory !== "undefined" && global.RMTradeStory.appendEvent) {
      await global.RMTradeStory.appendEvent(event, { storyId: storyDay || undefined });
    }

    if (statusEl) {
      statusEl.textContent = "Saved - Reflect note stored for " + (storyDay || "today") + ".";
    }
    document.dispatchEvent(
      new CustomEvent("rm:debrief-saved", { detail: { trade: trade, event: event } })
    );
  }

  function isMobileChartFirst() {
    return (
      typeof matchMedia !== "undefined" &&
      matchMedia("(max-width: 640px)").matches
    );
  }

  async function openDebrief(trade, opts) {
    if (!trade) return;
    ensureWired();
    const mobileFirst = isMobileChartFirst();
    const chartOnly = opts?.chartOnly === true || (mobileFirst && opts?.reflectPanel !== true);
    activeTrade = trade;
    const debrief = buildDebrief(trade);
    const subtitle = $("debriefSubtitle");
    if (subtitle) {
      subtitle.textContent =
        (trade.instrument === "option" ? "Option | " : "") +
        String(trade.closed_at || "").slice(0, 10);
    }
    await focusChartForDebrief(trade);
    if (typeof global.rmStatus === "function") {
      global.rmStatus(
        chartOnly
          ? trade.symbol + " on chart  -  tap What happened? again for Reflect."
          : trade.symbol + " trade window highlighted on chart."
      );
    }
    if (chartOnly) {
      requestAnimationFrame(function () {
        const chart = document.getElementById("workspaceChart");
        if (chart) chart.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }
    const body = $("debriefBody");
    if (body) {
      body.innerHTML = renderDebriefHtml(debrief);
      wirePanelEvents(debrief);
    }
    openDrawer();
  }

  function ensureWired() {
    if (wired) return;
    wired = true;
    const closeBtn = $("btnCloseDebrief");
    const backdrop = $("debriefBackdrop");
    if (closeBtn) closeBtn.addEventListener("click", closeDebrief);
    if (backdrop) backdrop.addEventListener("click", closeDebrief);
  }

  function initClosedListDelegation() {
    const list = $("ttResultsClosedList");
    if (!list || list.dataset.debriefWired === "1") return;
    list.dataset.debriefWired = "1";
    list.addEventListener("click", function (ev) {
      const btn = ev.target.closest("[data-debrief-id]");
      if (btn) {
        const id = btn.getAttribute("data-debrief-id");
        const trades =
          typeof global.RMTrades !== "undefined" && global.RMTrades.getJournalTrades
            ? global.RMTrades.getJournalTrades()
            : [];
        const trade = trades.find(function (t) {
          return String(t.id) === String(id);
        });
        if (!trade) return;
        const same =
          activeTrade &&
          String(activeTrade.id) === String(trade.id) &&
          typeof global.RMAnalysisChart !== "undefined" &&
          global.RMAnalysisChart.state?.debriefWindow;
        if (same && isMobileChartFirst()) {
          void openDebrief(trade, { reflectPanel: true });
        } else {
          void openDebrief(trade);
        }
        return;
      }
      const row = ev.target.closest(".trade-item[data-trade-id]");
      if (!row) return;
      const id = row.getAttribute("data-trade-id");
      const trades =
        typeof global.RMTrades !== "undefined" && global.RMTrades.getJournalTrades
          ? global.RMTrades.getJournalTrades()
          : typeof global.getJournalTrades === "function"
            ? global.getJournalTrades()
            : [];
      const trade = trades.find(function (t) {
        return String(t.id) === String(id);
      });
      if (!trade) return;
      highlightClosedTradeRow(id);
      void focusChartForDebrief(trade);
    });
    list.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".trade-item[data-trade-id]");
      if (!row) return;
      ev.preventDefault();
      row.click();
    });
  }

  function highlightClosedTradeRow(tradeId) {
    const list = $("ttResultsClosedList");
    if (!list) return;
    list.querySelectorAll(".trade-item--active").forEach(function (el) {
      el.classList.remove("trade-item--active");
    });
    if (!tradeId) return;
    const row = list.querySelector('.trade-item[data-trade-id="' + tradeId + '"]');
    if (row) {
      row.classList.add("trade-item--active");
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function init() {
    ensureWired();
    initClosedListDelegation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  document.addEventListener("rm:results-closed-rendered", initClosedListDelegation);

  global.RMTradeDebrief = {
    REFLECT_TAGS,
    buildDebrief,
    buildLearnings,
    suggestTags,
    openDebrief,
    closeDebrief,
    saveDebriefNote,
    focusChartForDebrief,
    highlightClosedTradeRow,
    chartSymbolForTrade,
    pulseLeanForTradeDay,
    init,
  };
})(typeof window !== "undefined" ? window : globalThis);
