/** Sticky footer trade journey: Target -> Position -> Close. */
(function (global) {
  const STEP_ORDER = ["target", "position", "close"];
  let hooks = {};
  /** Per-symbol working plan so user edits survive progressive step re-renders. */
  const working = {};

  function applyWorking(symbol, plan) {
    const w = working[symbol];
    if (w && plan) Object.assign(plan, w);
    return plan;
  }

  function saveWorking(symbol) {
    if (!symbol) return;
    const w = working[symbol] || {};
    const e = num("tfEntry");
    if (e != null) w.entry = e;
    const s = num("tfStop");
    if (s != null) w.stop = s;
    const t = num("tfTarget");
    if (t != null) w.target = t;
    const q = num("tfQty");
    if (q != null) w.qty = q;
    working[symbol] = w;
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

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function fmtPrice(n) {
    if (n == null || Number.isNaN(n)) return "?";
    return "$" + Number(n).toFixed(2);
  }

  function getStep(symbol) {
    const key = "rainmaker_trade_step_" + String(symbol || "").toUpperCase();
    try {
      return localStorage.getItem(key) || "target";
    } catch {
      return "target";
    }
  }

  function setStep(symbol, step) {
    const key = "rainmaker_trade_step_" + String(symbol || "").toUpperCase();
    try {
      localStorage.setItem(key, step);
    } catch {
      /* ignore */
    }
  }

  function openTrade(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const trades = hooks.getTrades?.() || [];
    const local = trades.find((t) => t.symbol === sym && t.status === "open");
    if (local) return local;
    const holding = hooks.getHolding?.(sym);
    if (holding && holding.entry_price != null) {
      return {
        symbol: sym,
        status: "open",
        source: holding.source || "schwab",
        entry_price: holding.entry_price,
        quantity: holding.quantity,
        stop_price: holding.stop_price ?? null,
        target_price: holding.target_price ?? null,
        execution_channel: holding.source === "schwab" ? "schwab" : "platform",
        opened_at: holding.entry_date || holding.opened_at || null,
      };
    }
    return null;
  }

  function schwabStepForSymbol(symbol) {
    if (openTrade(symbol)) return "close";
    return getStep(symbol);
  }

  function recommendationsFor(pick, plan, open) {
    if (typeof global.RMTradeRecommendations === "undefined") return [];
    const sym = pick?.symbol;
    if (!sym) return [];
    const holding = hooks.getHolding?.(sym);
    const last = pick.last ?? plan?.price ?? plan?.entry;
    return global.RMTradeRecommendations.evaluate({
      symbol: sym,
      entry: open?.entry_price ?? plan?.entry,
      stop: open?.stop_price ?? plan?.stop,
      target: open?.target_price ?? plan?.target,
      lastPrice: last,
      orh: plan?.orh,
      orl: plan?.orl,
      qty: open?.quantity ?? plan?.qty,
      holding,
    });
  }

  function recommendationsHtml(recs, pick, plan) {
    if (!recs?.length || typeof global.RMTradeRecommendations === "undefined") return "";
    return global.RMTradeRecommendations.stripHtml(recs);
  }

  function bindRecommendationActions(recs, pick, plan, open) {
    document.querySelectorAll("#tradeFooterJourney .tf-rec-accept").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.recType;
        const rec = recs.find((r) => r.type === type);
        if (!rec) return;
        if (typeof global.RMTradeRecommendations !== "undefined") {
          void global.RMTradeRecommendations.logRecommendation(rec, "accept", {
            planRevision: {
              symbol: pick.symbol,
              entry: plan.entry,
              stop: rec.type === "trail_stop" && plan.entry ? plan.entry : plan.stop,
              target: plan.target,
              qty: plan.qty,
            },
            reason: rec.type,
          });
        }
        hooks.status?.("Noted: " + rec.label + " — adjust plan in Position step.");
      });
    });
    document.querySelectorAll("#tradeFooterJourney .tf-rec-dismiss").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.recType;
        const rec = recs.find((r) => r.type === type);
        if (!rec) return;
        if (typeof global.RMTradeRecommendations !== "undefined") {
          void global.RMTradeRecommendations.logRecommendation(rec, "dismiss");
          global.RMTradeRecommendations.dismiss(rec.symbol, rec.type);
        }
        refresh(pick);
      });
    });
  }

  function srFromChart(symbol) {
    if (typeof RMAnalysisChart === "undefined") return null;
    const st = RMAnalysisChart.state;
    if (!st || st.symbol !== symbol || !st.srLines?.length) return null;
    const support = st.srLines.filter((l) => l.kind === "support").map((l) => l.price);
    const resistance = st.srLines.filter((l) => l.kind === "resistance").map((l) => l.price);
    return {
      support: support.length ? Math.max(...support) : null,
      resistance: resistance.length ? Math.min(...resistance) : null,
    };
  }

  function srFromLines(srLines) {
    if (!srLines?.length) return null;
    const support = srLines.filter((l) => l.kind === "support").map((l) => l.price);
    const resistance = srLines.filter((l) => l.kind === "resistance").map((l) => l.price);
    return {
      support: support.length ? Math.max(...support) : null,
      resistance: resistance.length ? Math.min(...resistance) : null,
    };
  }

  function ptDayKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  }

  function ptMinutes(ms) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(new Date(ms));
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
    return hour * 60 + minute;
  }

  function openingRangeFromBars(bars, rthStartMs, orMinutes = 5) {
    if (!bars?.length) return { orh: null, orl: null };
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

  function sessionLowFromBars(bars) {
    if (!bars?.length) return null;
    const lastDay = ptDayKey(bars[bars.length - 1].t);
    const lows = bars
      .filter((b) => ptDayKey(b.t) === lastDay)
      .map((b) => b.low ?? b.close)
      .filter((v) => v != null && Number.isFinite(v));
    return lows.length ? Math.min(...lows) : null;
  }

  function chartContextForSymbol(symbol) {
    if (typeof RMAnalysisChart === "undefined") return null;
    const st = RMAnalysisChart.state;
    if (!st || st.symbol !== symbol || !st.bars?.length) return null;
    return {
      bars: st.bars,
      srLines: st.srLines,
      rthStartMs: st.hub?.sessionMeta?.periods?.regular?.startMs,
      lastPrice: st.bars[st.bars.length - 1]?.close,
    };
  }

  function pickForSymbol(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const active = hooks.getActivePick?.();
    if (active?.symbol === sym) return active;
    const session = hooks.getSession?.();
    return (session?.picks || []).find((p) => p.symbol === sym) || null;
  }

  function activeRr() {
    const rr =
      typeof RMStrategies !== "undefined" ? Number(RMStrategies.getActive()?.rr) : NaN;
    return Number.isFinite(rr) && rr > 0 ? rr : 2;
  }

  function applyTargets(plan, rr, resistance) {
    const risk = plan.entry - plan.stop;
    if (!risk || risk <= 0) return plan;
    let t1 = round2(plan.entry + risk);
    // Item 10: when a recent resistance sits just above entry, treat it as the
    // first limit-sell so the target tracks the most recent S/R line.
    if (resistance != null && resistance > plan.entry) {
      const ceiling = plan.entry + risk * (rr + 0.5);
      if (resistance <= ceiling) t1 = round2(resistance);
    }
    plan.target1 = t1;
    plan.target2 = round2(plan.entry + risk * rr);
    if (plan.target2 <= plan.target1) plan.target2 = round2(plan.target1 + risk);
    plan.target = plan.target2;
    plan.rr = rr;
    return plan;
  }

  function recommendMorningSetup(pickOrSymbol, ctx) {
    const sym = String(
      (typeof pickOrSymbol === "string" ? pickOrSymbol : pickOrSymbol?.symbol) || ""
    ).toUpperCase();
    if (!sym) return null;
    const pick = typeof pickOrSymbol === "object" ? pickOrSymbol : pickForSymbol(sym);
    const chartCtx = ctx || chartContextForSymbol(sym);
    const price = pick?.last ?? pick?.open ?? pick?.price ?? chartCtx?.lastPrice;
    if (price == null && !chartCtx?.bars?.length) return null;
    const lastPrice = price ?? chartCtx?.lastPrice;
    const sr = chartCtx?.srLines ? srFromLines(chartCtx.srLines) : srFromChart(sym);
    const support = sr?.support ?? round2(lastPrice * 0.99);
    const resistance = sr?.resistance ?? round2(lastPrice * 1.01);
    const { orh, orl } = openingRangeFromBars(chartCtx?.bars, chartCtx?.rthStartMs);
    const activeRule =
      (typeof RMStrategies !== "undefined" && RMStrategies.getActive()?.entryRule) || "orh";
    let entry;
    let stop;
    if (activeRule === "vwap") {
      // VWAP reclaim: enter at market on the reclaim; stop the session low.
      const lo = sessionLowFromBars(chartCtx?.bars);
      entry = round2(lastPrice ?? orh ?? support * 1.01);
      stop = lo != null ? round2(lo - 0.01) : round2(entry * 0.97);
      if (!Number.isFinite(stop) || stop >= entry) stop = round2(entry * 0.97);
    } else {
      entry = round2(orh ?? Math.min(lastPrice, support * 1.01));
      if (orl != null) stop = round2(orl - 0.01);
      else if (sr?.support) stop = round2(Math.min(support * 0.995, entry * 0.98));
      else stop = round2(entry * 0.92);
      if (!Number.isFinite(stop) || stop >= entry) stop = round2(entry * 0.92);
    }
    const plan = {
      symbol: sym,
      support,
      resistance,
      entry,
      stop,
      price: lastPrice,
      orh,
      orl,
      qty: 100,
      rr: activeRr(),
    };
    applyTargets(plan, plan.rr, resistance);
    return plan;
  }

  function recommendPlan(pick) {
    if (!pick?.symbol) return null;
    return recommendMorningSetup(pick, chartContextForSymbol(pick.symbol));
  }

  function stepIndex(step) {
    const i = STEP_ORDER.indexOf(step);
    return i >= 0 ? i : 0;
  }

  function tfRange(plan) {
    return (
      '<span class="tf-range" title="Support / resistance">' +
      fmtPrice(plan.support) +
      " – " +
      fmtPrice(plan.resistance) +
      "</span>"
    );
  }

  function targetFields(plan, pick) {
    return (
      '<div class="tf-fields tf-fields--compact">' +
      tfRange(plan) +
      '<label class="tf-lbl tf-lbl--inline">Entry<input type="number" step="0.01" id="tfEntry" value="' +
      (plan.entry ?? "") +
      '" inputmode="decimal"></label>' +
      '<label class="tf-lbl tf-lbl--inline">Qty<input type="number" step="1" id="tfQty" value="' +
      (plan.qty ?? 100) +
      '" inputmode="numeric"></label>' +
      '<button type="button" class="btn btn-sm tf-action" id="tfConfirmTarget">Confirm</button></div>'
    );
  }

  function positionFields(plan, pick) {
    return (
      '<div class="tf-fields tf-fields--compact">' +
      '<span class="tf-inline"><span class="tf-lbl">Entry</span><strong id="tfShowEntry">' +
      fmtPrice(plan.entry) +
      '</strong></span>' +
      '<label class="tf-lbl tf-lbl--inline">Stop<input type="number" step="0.01" id="tfStop" value="' +
      (plan.stop ?? "") +
      '" inputmode="decimal"></label>' +
      '<label class="tf-lbl tf-lbl--inline">Target<input type="number" step="0.01" id="tfTarget" value="' +
      (plan.target ?? "") +
      '" inputmode="decimal"></label>' +
      '<button type="button" class="btn btn-sm tf-action" id="tfEnterPosition">Enter</button></div>'
    );
  }

  function closeFields(pick, trade) {
    const exitDefault = trade?.target_price ?? trade?.entry_price ?? "";
    return (
      '<div class="tf-fields tf-fields--compact">' +
      '<span class="tf-inline"><span class="tf-lbl">Open</span><strong>' +
      fmtPrice(trade?.entry_price) +
      '</strong></span>' +
      '<label class="tf-lbl tf-lbl--inline">Fill<select id="tfFillStatus"><option value="filled">Filled</option><option value="not_filled">Not filled</option></select></label>' +
      '<label class="tf-lbl tf-lbl--inline">Exit<input type="number" step="0.01" id="tfExit" value="' +
      exitDefault +
      '" inputmode="decimal"></label>' +
      '<button type="button" class="btn btn-sm tf-action tf-action--close" id="tfCloseTrade">Close</button></div>'
    );
  }

  function stepBlock(step, num, label, bodyHtml) {
    return (
      '<div class="tf-step tf-step--' +
      step +
      '" data-step="' +
      step +
      '">' +
      '<div class="tf-step-row">' +
      '<header class="tf-step-head"><span class="tf-step-num">' +
      num +
      '</span><span class="tf-step-label">' +
      label +
      "</span></header>" +
      '<div class="tf-step-body">' +
      bodyHtml +
      "</div></div></div>"
    );
  }

  function dualTrackHtml(trade) {
    if (!trade || trade.status !== "closed" || typeof RMTradeMetrics === "undefined") {
      return "";
    }
    const line = RMTradeMetrics.fmtDualTrack(trade);
    if (!line) return "";
    const status = RMTradeMetrics.reconcileStatus(trade);
    const cls = status === "agreed" ? "tf-dual-r--agreed" : "tf-dual-r--delta";
    return (
      '<div class="tf-dual-r ' +
      cls +
      '" title="Plan R vs Realized R until broker reconcile agrees">' +
      escapeHtml(line) +
      "</div>"
    );
  }

  function stratHeadHtml(plan, pick, open) {
    let stratLabel = "";
    if (typeof RMStrategies !== "undefined") {
      const s = RMStrategies.getActive();
      if (s?.name) stratLabel = "\u26a1 " + escapeHtml(s.name);
    }
    const rr = plan.rr ?? 2;
    const rrTxt = Number.isInteger(rr) ? String(rr) : Number(rr).toFixed(1);
    const closed =
      !open &&
      (() => {
        const trades = hooks.getTrades?.() || [];
        return trades.find(
          (t) =>
            t.symbol === pick.symbol &&
            t.status === "closed" &&
            t.closed_at &&
            new Date(t.closed_at).toDateString() === new Date().toDateString()
        );
      })();
    return (
      '<div class="tf-head">' +
      (stratLabel ? '<span class="tf-head-strat">' + stratLabel + "</span>" : "") +
      '<span class="tf-head-sym">' +
      escapeHtml(pick.symbol) +
      "</span>" +
      '<span class="tf-head-rr">R:R ' +
      rrTxt +
      ":1</span>" +
      dualTrackHtml(closed) +
      "</div>"
    );
  }

  function stepSummary(step, plan, open) {
    if (step === "target") {
      const e = open?.entry_price ?? plan.entry;
      return e != null ? "Entry " + fmtPrice(e) : "";
    }
    if (step === "position") {
      const st = open?.stop_price ?? plan.stop;
      const tg = open?.target_price ?? plan.target;
      return (
        (st != null ? "Stop " + fmtPrice(st) : "") +
        (tg != null ? " \u00b7 Tgt " + fmtPrice(tg) : "")
      );
    }
    return "";
  }

  function stepChipHtml(step, num, label, summary, kind) {
    return (
      '<div class="tf-step tf-step--' +
      step +
      " tf-step--" +
      kind +
      '" data-step="' +
      step +
      '" role="button" tabindex="0">' +
      '<div class="tf-step-row">' +
      '<header class="tf-step-head"><span class="tf-step-num">' +
      (kind === "done" ? "\u2713" : num) +
      '</span><span class="tf-step-label">' +
      label +
      "</span></header>" +
      (summary ? '<span class="tf-chip-sum">' + summary + "</span>" : "") +
      "</div></div>"
    );
  }

  function activeStepBlock(step, num, label, bodyHtml) {
    return (
      '<div class="tf-step tf-step--active tf-step--' +
      step +
      '" data-step="' +
      step +
      '"><div class="tf-step-row">' +
      '<header class="tf-step-head"><span class="tf-step-num">' +
      num +
      '</span><span class="tf-step-label">' +
      label +
      "</span></header>" +
      '<div class="tf-step-body">' +
      bodyHtml +
      "</div></div></div>"
    );
  }

  function progressiveStepsHtml(activeStep, plan, pick, open) {
    const ai = stepIndex(activeStep);
    const labels = { target: "Target", position: "Position", close: "Close" };
    const nums = { target: "1", position: "2", close: "3" };
    return STEP_ORDER.map((s) => {
      const i = stepIndex(s);
      if (i === ai) {
        let body;
        if (s === "target") body = targetFields(plan, pick);
        else if (s === "position") body = positionFields(plan, pick);
        else
          body = open
            ? closeFields(pick, open)
            : '<span class="meta tf-step-hint">Enter position first.</span>';
        return activeStepBlock(s, nums[s], labels[s], body);
      }
      if (i < ai) return stepChipHtml(s, nums[s], labels[s], stepSummary(s, plan, open), "done");
      return stepChipHtml(s, nums[s], labels[s], "", "future");
    }).join("");
  }

  function render(pick) {
    const journey = $("tradeFooterJourney");
    if (!journey) return;
    // Idle = nothing actionable: hide entirely (CSS :empty -> display:none).
    if (!pick) {
      journey.innerHTML = "";
      journey.dataset.symbol = "";
      journey.classList.remove("tf-active");
      return;
    }

    const plan = applyWorking(pick.symbol, recommendPlan(pick));
    if (!plan) {
      journey.innerHTML =
        '<div class="tf-empty"><p class="meta">No price data for ' +
        escapeHtml(pick.symbol) +
        " \u2014 wait for quotes.</p></div>";
      journey.classList.remove("tf-active");
      return;
    }

    const open = openTrade(pick.symbol);
    let step = open ? "close" : getStep(pick.symbol);
    if (!STEP_ORDER.includes(step)) step = "target";
    if (open && open.source === "schwab" && step === "target") step = "close";
    setStep(pick.symbol, step);

    const recs = recommendationsFor(pick, plan, open);

    journey.dataset.symbol = pick.symbol;
    journey.classList.add("tf-active");
    journey.innerHTML =
      stratHeadHtml(plan, pick, open) +
      recommendationsHtml(recs, pick, plan) +
      '<div class="tf-steps">' +
      progressiveStepsHtml(step, plan, pick, open) +
      "</div>";

    bindStepActions(pick, plan, open);
    bindRecommendationActions(recs, pick, plan, open);
    pushPlanToChart(pick, plan);
    bindPlanFieldSync(pick, plan);
  }

  function num(id) {
    const v = parseFloat($(id)?.value);
    return Number.isNaN(v) ? null : v;
  }

  function readLivePlan(pick, plan) {
    const entry = num("tfEntry") ?? plan.entry;
    const stop = num("tfStop") ?? plan.stop;
    const rr = plan.rr ?? 2;
    const live = {
      symbol: pick.symbol,
      entry,
      stop,
      target: num("tfTarget") ?? plan.target,
      qty: Math.max(1, parseInt($("tfQty")?.value, 10) || 100),
      rr,
    };
    applyTargets(live, rr);
    if (num("tfTarget") != null) {
      live.target2 = num("tfTarget");
      live.target = live.target2;
    }
    return live;
  }

  function pushPlanToChart(pick, plan) {
    if (typeof RMAnalysisChart === "undefined" || !RMAnalysisChart.syncTradePlan) return;
    RMAnalysisChart.syncTradePlan(readLivePlan(pick, plan));
  }

  function emitTradeJourney(stage, pick, plan, source) {
    const live = plan ? readLivePlan(pick, plan) : null;
    const detail = {
      stage,
      symbol: pick?.symbol,
      selectKey: pick?.symbol,
      plan: live,
      source: source || "footer",
    };
    if (typeof global.dispatchTradeJourney === "function") {
      global.dispatchTradeJourney(detail);
    } else {
      document.dispatchEvent(new CustomEvent("rm:trade-journey", { detail }));
    }
  }

  function bindPlanFieldSync(pick, plan) {
    let planRevTimer = null;
    ["tfEntry", "tfStop", "tfTarget", "tfQty"].forEach((id) => {
      $(id)?.addEventListener("input", () => {
        saveWorking(pick.symbol);
        pushPlanToChart(pick, plan);
        if (getStep(pick.symbol) === "position" && typeof global.RMTradeStory !== "undefined") {
          clearTimeout(planRevTimer);
          planRevTimer = setTimeout(() => {
            void global.RMTradeStory.syncPlanRevision(readLivePlan(pick, plan), {
              reason: "footer_edit",
            });
          }, 600);
        }
      });
    });
  }

  function bindStepActions(pick, plan, openTradeRow) {
    $("tfConfirmTarget")?.addEventListener("click", () => {
      const entry = num("tfEntry") ?? plan.entry;
      plan.entry = entry;
      if (plan.orl != null) plan.stop = round2(plan.orl - 0.01);
      else if (plan.support) plan.stop = round2(Math.min(plan.support * 0.995, entry * 0.98));
      else plan.stop = round2(entry * 0.92);
      applyTargets(plan, plan.rr ?? 2);
      // Persist confirmed entry/stop/target so the position step re-renders with them.
      working[pick.symbol] = {
        ...(working[pick.symbol] || {}),
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        qty: num("tfQty") ?? working[pick.symbol]?.qty ?? plan.qty,
      };
      setStep(pick.symbol, "position");
      refresh(pick);
      pushPlanToChart(pick, plan);
      if (typeof global.RMTradeStory !== "undefined") {
        const sig =
          typeof global.RMStrategies !== "undefined"
            ? global.RMStrategies.getActive()?.signalSource ||
              (global.RMStrategies.getActive()?.id === "atlas" ? "atlas" : "orh")
            : "orh";
        void global.RMTradeStory.syncPlan(plan, { signal_source: sig });
      }
      emitTradeJourney("plan", pick, plan, "footer");
      hooks.status?.("Target set — adjust stop & target, then enter position.");
    });

    $("tfEnterPosition")?.addEventListener("click", () => {
      const entry = num("tfEntry") ?? plan.entry;
      const stopVal = num("tfStop") ?? plan.stop;
      const targetVal = num("tfTarget") ?? plan.target;
      const priorStop = plan.stop;
      const priorTarget = plan.target;
      const trade = {
        symbol: pick.symbol,
        session_id: hooks.getSession?.()?.session_id,
        instrument: "stock",
        rm_confidence: pick.rm_confidence,
        rm_confidence_adjusted: hooks.pickScore?.(pick),
        opened_at: new Date().toISOString(),
        status: "open",
        source: "footer",
        execution_channel: "platform",
        planned: true,
        entry_price: entry,
        quantity: num("tfQty") ?? 100,
        stop_price: num("tfStop") ?? plan.stop,
        target_price: num("tfTarget") ?? plan.target,
        support: plan.support,
        resistance: plan.resistance,
      };
      hooks.saveOpenTrade?.(trade);
      if (typeof global.RMTradeStory !== "undefined") {
        void global.RMTradeStory.syncEntry(trade);
      }
      if (
        (stopVal !== priorStop || targetVal !== priorTarget) &&
        typeof global.RMTradeStory !== "undefined"
      ) {
        void global.RMTradeStory.syncPlanRevision(
          {
            symbol: pick.symbol,
            entry,
            stop: stopVal,
            target: targetVal,
            qty: num("tfQty") ?? plan.qty,
          },
          { prior_stop: priorStop, prior_target: priorTarget, reason: "enter_position" }
        );
      }
      setStep(pick.symbol, "close");
      refresh(pick);
      emitTradeJourney("open", pick, plan, "footer");
      hooks.status?.("Position open ? record exit when you close.");
    });

    $("tfCloseTrade")?.addEventListener("click", () => {
      if (!openTradeRow && !openTrade(pick.symbol)) {
        hooks.status?.("No open position for " + pick.symbol);
        return;
      }
      const exitPrice = num("tfExit");
      hooks.closeTrade?.({
        symbol: pick.symbol,
        fill_status: $("tfFillStatus")?.value,
        exit_price: exitPrice,
        entry_price: openTradeRow?.entry_price ?? num("tfEntry") ?? plan.entry,
        stop_price: openTradeRow?.stop_price ?? num("tfStop") ?? plan.stop,
        target_price: openTradeRow?.target_price ?? num("tfTarget") ?? plan.target,
        quantity: openTradeRow?.quantity ?? num("tfQty") ?? 100,
        planned: true,
        source: "footer",
      });
      delete working[pick.symbol];
      setStep(pick.symbol, "target");
      refresh(null);
    });

    // Clicking a done/future chip jumps to that step (re-renders progressively).
    document.querySelectorAll("#tradeFooterJourney .tf-step--done, #tradeFooterJourney .tf-step--future").forEach((chip) => {
      const go = () => {
        const step = chip.dataset.step;
        if (!step) return;
        saveWorking(pick.symbol);
        setStep(pick.symbol, step);
        refresh(pick);
      };
      chip.addEventListener("click", go);
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      });
    });
  }

  function refresh(pick) {
    render(pick || hooks.getActivePick?.());
  }

  function init(h) {
    hooks = h || {};
    const journey = $("tradeFooterJourney");
    if (journey && !journey.dataset.ready) {
      journey.dataset.ready = "1";
      journey.innerHTML = ""; // idle = hidden until a pick is actionable
    }
  }

  function selectPick(pick) {
    if (!pick) {
      refresh(null);
      if (typeof RMAnalysisChart !== "undefined" && RMAnalysisChart.refreshTradeOverlay) {
        RMAnalysisChart.refreshTradeOverlay();
      }
      return;
    }
    hooks.onSelect?.(pick);
    render(pick);
  }

  function onPlanChartEdit(plan) {
    const pick = hooks.getActivePick?.();
    if (!pick || pick.symbol !== plan.symbol) return;
    const entryEl = $("tfEntry");
    const stopEl = $("tfStop");
    const targetEl = $("tfTarget");
    const qtyEl = $("tfQty");
    if (entryEl && plan.entry != null) entryEl.value = plan.entry;
    if (stopEl && plan.stop != null) stopEl.value = plan.stop;
    if (targetEl && plan.target != null) targetEl.value = plan.target;
    if (qtyEl && plan.qty != null) qtyEl.value = plan.qty;
    saveWorking(plan.symbol);
  }

  function recommendFromEmaSignal(ctx) {
    const sym = String(ctx?.symbol || "").toUpperCase();
    if (!sym || ctx?.barIndex == null || !ctx?.bars?.length) return null;
    const i = ctx.barIndex;
    const bar = ctx.bars[i];
    if (!bar) return null;
    const lookback = ctx.swingLookback ?? 8;
    const rr = ctx.defaultRr ?? 2;
    let swingLo = null;
    if (typeof global.RMEmaSignals !== "undefined") {
      swingLo = global.RMEmaSignals.swingLow(ctx.bars, i, lookback);
    } else {
      for (let j = Math.max(0, i - lookback + 1); j <= i; j++) {
        const v = ctx.bars[j]?.low ?? ctx.bars[j]?.close;
        if (v != null) swingLo = swingLo == null ? v : Math.min(swingLo, v);
      }
    }
    const entry = round2(bar.close);
    let stop = swingLo != null ? round2(swingLo - 0.01) : round2(entry * 0.97);
    if (!Number.isFinite(stop) || stop >= entry) stop = round2(entry * 0.97);
    const plan = {
      symbol: sym,
      entry,
      stop,
      qty: 100,
      rr,
      signal_source: ctx.signalSource || "ema_golden_cross",
      signal_label: ctx.signalLabel || "EMA signal",
    };
    applyTargets(plan, rr, round2(entry * 1.04));
    return plan;
  }

  global.RMTradeFooter = {
    init,
    refresh,
    selectPick,
    render,
    recommendPlan,
    recommendMorningSetup,
    recommendFromEmaSignal,
    pickForSymbol,
    onPlanChartEdit,
    readLivePlan,
  };
})(typeof window !== "undefined" ? window : globalThis);
