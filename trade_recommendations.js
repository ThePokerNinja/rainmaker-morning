/**
 * Rule-based trade recommendations v0  -  structured events for the learning loop.
 * No auto-execution; footer/chart surfaces accept / dismiss / revise.
 */
(function (global) {
  "use strict";

  const LS_DISMISSED = "rainmaker_rec_dismissed_v1";

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function loadDismissed() {
    try {
      return JSON.parse(localStorage.getItem(LS_DISMISSED) || "{}");
    } catch (_) {
      return {};
    }
  }

  function saveDismissed(all) {
    try {
      localStorage.setItem(LS_DISMISSED, JSON.stringify(all));
    } catch (_) {}
  }

  function dismissKey(symbol, type) {
    return String(symbol || "").toUpperCase() + "|" + type + "|" + new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }

  function isDismissed(symbol, type) {
    const all = loadDismissed();
    return !!all[dismissKey(symbol, type)];
  }

  function dismiss(symbol, type) {
    const all = loadDismissed();
    all[dismissKey(symbol, type)] = Date.now();
    saveDismissed(all);
  }

  function pctChange(entry, last) {
    if (entry == null || last == null || !entry) return null;
    return ((last - entry) / entry) * 100;
  }

  /**
   * @param {object} ctx  -  { symbol, entry, stop, target, lastPrice, orh, orl, qty, holding }
   * @returns {Array<{type,label,reason,confidence,priority}>}
   */
  function evaluate(ctx) {
    const sym = String(ctx?.symbol || "").toUpperCase();
    if (!sym) return [];
    const entry = ctx.entry ?? ctx.entry_price ?? ctx.holding?.entry_price;
    const stop = ctx.stop ?? ctx.stop_price;
    const target = ctx.target ?? ctx.target_price;
    const last = ctx.lastPrice ?? ctx.last ?? entry;
    const orh = ctx.orh;
    const orl = ctx.orl;
    const out = [];

    function push(type, label, reason, confidence, priority) {
      if (isDismissed(sym, type)) return;
      out.push({
        type,
        label,
        reason,
        confidence: confidence || "med",
        priority: priority || 50,
        symbol: sym,
      });
    }

    const chg = pctChange(entry, last);

    if (stop != null && last != null && last <= stop * 1.002) {
      push("cut_loss", "Cut loss", "Price at or below stop  -  honor risk plan.", "high", 90);
    } else if (stop != null && last != null && last <= stop * 1.015) {
      push("defensive", "Play defensive", "Within 1.5% of stop  -  tighten or reduce size.", "med", 70);
    }

    if (target != null && last != null && last >= target * 0.98) {
      push("take_profit", "Take profit", "At or near target  -  trim or move stop to breakeven.", "high", 85);
    }

    if (orh != null && last != null && last > orh && entry != null && last > entry) {
      push("trail_stop", "Trail stop", "Above ORH with profit  -  ratchet stop under structure.", "med", 75);
    }

    if (orl != null && last != null && last < orl && chg != null && chg > -3) {
      push("add_dip", "Buy the dip", "Pullback toward ORL while thesis intact  -  optional scale-in.", "low", 55);
    }

    if (chg != null && chg <= -5 && stop != null && last > stop) {
      push("defensive", "Reduce risk", "Down " + round2(Math.abs(chg)) + "%  -  consider trim before stop.", "med", 65);
    }

    if (ctx.holding?.instrument === "option" && chg != null && chg >= 25) {
      push("rollover", "Consider rollover", "Large option gain  -  roll or take premium off table.", "med", 60);
    }

    return out.sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 3);
  }

  async function logRecommendation(rec, action, opts) {
    if (typeof global.RMTradeStory === "undefined" || !rec?.type) return null;
    const event = {
      type: "recommendation",
      subtype: rec.type,
      symbol: rec.symbol,
      label: rec.label,
      reason: rec.reason,
      confidence: rec.confidence,
      action: action || "shown",
    };
    if (action === "dismiss") dismiss(rec.symbol, rec.type);
    if (action === "accept" && opts?.planRevision) {
      await global.RMTradeStory.syncPlanRevision(opts.planRevision, opts);
    }
    return global.RMTradeStory.appendEvent(event, opts);
  }

  function stripHtml(recs) {
    if (!recs?.length) return "";
    return (
      '<div class="tf-recs" role="list">' +
      recs
        .map(
          (r) =>
            '<div class="tf-rec" role="listitem" data-rec-type="' +
            r.type +
            '">' +
            '<span class="tf-rec-label">' +
            r.label +
            "</span>" +
            '<span class="tf-rec-reason meta">' +
            r.reason +
            "</span>" +
            '<span class="tf-rec-actions">' +
            '<button type="button" class="btn btn-sm tf-rec-accept" data-rec-type="' +
            r.type +
            '">Accept</button>' +
            '<button type="button" class="btn btn-sm btn-ghost tf-rec-dismiss" data-rec-type="' +
            r.type +
            '">Dismiss</button>' +
            "</span></div>"
        )
        .join("") +
      "</div>"
    );
  }

  global.RMTradeRecommendations = {
    evaluate,
    logRecommendation,
    dismiss,
    isDismissed,
    stripHtml,
  };
})(typeof window !== "undefined" ? window : globalThis);
