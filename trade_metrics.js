/** R-multiple, expectancy, dual-track Plan R / Realized R (ADR-003 + Trade Story). */
(function (global) {
  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
  }

  function isPlannedTrade(trade) {
    if (trade.planned === false) return false;
    if (trade.planned === true) return true;
    return trade.source === "footer" || trade.source === "dashboard";
  }

  function rMultiple(trade) {
    if (trade.plan_r != null && Number.isFinite(trade.plan_r)) return trade.plan_r;
    if (trade.realized_r != null && Number.isFinite(trade.realized_r)) {
      return trade.realized_r;
    }
    if (trade.r_multiple != null && Number.isFinite(trade.r_multiple)) {
      return trade.r_multiple;
    }
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price;
    const stop = trade.stop_price ?? trade.stop_premium;
    if (entry == null || exit == null || stop == null) return null;
    const risk = entry - stop;
    if (!Number.isFinite(risk) || risk <= 0) return null;
    return (exit - entry) / risk;
  }

  function planR(trade) {
    if (trade.plan_r != null && Number.isFinite(trade.plan_r)) return trade.plan_r;
    if (trade.status !== "closed" || trade.filled === false) return null;
    return rMultiple(trade);
  }

  function realizedR(trade) {
    if (trade.realized_r != null && Number.isFinite(trade.realized_r)) {
      return trade.realized_r;
    }
    if (trade.reconcile_status === "agreed" && trade.r_multiple != null) {
      return trade.r_multiple;
    }
    return null;
  }

  function reconcileStatus(trade) {
    if (trade.reconcile_status === "agreed" || trade.reconcile_status === "delta") {
      return trade.reconcile_status;
    }
    const p = planR(trade);
    const r = realizedR(trade);
    if (p == null && r == null) return trade.reconciled ? "agreed" : null;
    if (r == null) return trade.reconciled ? "agreed" : "delta";
    const dp = Math.abs(p - r);
    return dp < 0.05 ? "agreed" : "delta";
  }

  function applyDualTrack(trade, opts) {
    const planned =
      opts?.planned != null ? opts.planned : isPlannedTrade(trade);
    const pr = planR(trade) ?? (opts?.exit_price != null ? rMultiple(trade) : null);
    const patch = {
      ...trade,
      planned,
      plan_r: pr != null ? round4(pr) : trade.plan_r ?? null,
      execution_channel:
        trade.execution_channel || opts?.execution_channel || "platform",
    };
    if (trade.reconciled && trade.realized_r == null && trade.r_multiple != null) {
      patch.realized_r = round4(trade.r_multiple);
      patch.reconcile_status = "agreed";
    } else if (patch.realized_r != null) {
      patch.reconcile_status = reconcileStatus(patch);
    } else {
      patch.reconcile_status = trade.reconcile_status || "delta";
    }
    return patch;
  }

  function contractMultiplier(trade) {
    if (trade.instrument === "option") return 100;
    if (
      typeof global.RMHoldings !== "undefined" &&
      global.RMHoldings.isOptionSymbol &&
      global.RMHoldings.isOptionSymbol(trade.symbol)
    ) {
      return 100;
    }
    return 1;
  }

  function pnlUsd(trade) {
    if (trade.pnl_usd != null && Number.isFinite(trade.pnl_usd)) {
      return trade.pnl_usd;
    }
    const entry = trade.entry_price ?? trade.entry_premium;
    const exit = trade.exit_price ?? trade.exit_premium;
    const qty = trade.quantity ?? trade.contracts;
    if (entry == null || exit == null || qty == null) return null;
    return (exit - entry) * qty * contractMultiplier(trade);
  }

  function enrichClosedTrade(trade, opts) {
    if (trade.status !== "closed" || trade.filled === false) return trade;
    const planned =
      opts?.planned != null ? opts.planned : isPlannedTrade(trade);
    const r = rMultiple(trade);
    const pnl = pnlUsd(trade);
    const base = {
      ...trade,
      planned,
      reconciled: trade.reconciled !== false,
      r_multiple: r != null ? round4(r) : null,
      pnl_usd: pnl != null ? round2(pnl) : null,
      plan_r: trade.plan_r != null ? trade.plan_r : r != null ? round4(r) : null,
      execution_channel: trade.execution_channel || opts?.execution_channel || "platform",
    };
    return applyDualTrack(base, opts);
  }

  function fmtDualTrack(trade) {
    const pr = planR(trade);
    const rr = realizedR(trade);
    const status = reconcileStatus(trade);
    if (pr == null && rr == null) return "";
    const fmt = (v) => (v >= 0 ? "+" : "") + Number(v).toFixed(2) + "R";
    if (rr == null || status === "delta") {
      return "Plan " + fmt(pr) + (rr != null ? " · Realized " + fmt(rr) : "") + " · Δ";
    }
    return "Plan " + fmt(pr) + " · Realized " + fmt(rr);
  }

  function sessionStats(trades, sessionId, opts) {
    if (!sessionId) return null;
    const onlyPlanned = opts?.onlyPlanned !== false;
    let closed = trades.filter(
      (t) =>
        t.session_id === sessionId &&
        t.status === "closed" &&
        t.filled !== false
    );
    if (onlyPlanned) closed = closed.filter(isPlannedTrade);
    if (!closed.length) return null;

    const rs = closed.map((t) => planR(t) ?? rMultiple(t)).filter((r) => r != null);
    let wins = 0;
    for (const t of closed) {
      const entry = t.entry_price ?? t.entry_premium;
      const exit = t.exit_price;
      if (entry != null && exit != null && exit > entry) wins++;
    }
    const avgR = rs.length
      ? rs.reduce((a, b) => a + b, 0) / rs.length
      : null;
    const totalR = rs.length ? rs.reduce((a, b) => a + b, 0) : null;
    const totalPnl = closed.reduce((s, t) => s + (pnlUsd(t) || 0), 0);
    const deltaCount = closed.filter((t) => reconcileStatus(t) === "delta").length;

    return {
      trades: closed.length,
      wins,
      pct: Math.round((wins / closed.length) * 100),
      avgR: avgR != null ? round2(avgR) : null,
      totalR: totalR != null ? round2(totalR) : null,
      totalPnl: round2(totalPnl),
      plannedCount: closed.filter(isPlannedTrade).length,
      reconcileDelta: deltaCount,
    };
  }

  function fmtExpectancy(stats) {
    if (!stats) return "";
    if (stats.avgR != null) {
      const sign = stats.avgR >= 0 ? "+" : "";
      let s =
        sign + stats.avgR.toFixed(2) + "R avg (" + stats.trades + " planned)";
      if (stats.reconcileDelta) s += " · " + stats.reconcileDelta + " Δ reconcile";
      return s;
    }
    return stats.pct + "% hit (" + stats.wins + "/" + stats.trades + ")";
  }

  function fmtBadge(stats) {
    if (!stats) return "";
    if (stats.avgR != null) {
      const sign = stats.avgR >= 0 ? "+" : "";
      return (
        sign +
        stats.avgR.toFixed(2) +
        "R (" +
        stats.wins +
        "/" +
        stats.trades +
        ")"
      );
    }
    return stats.pct + "% (" + stats.wins + "/" + stats.trades + ")";
  }

  global.RMTradeMetrics = {
    isPlannedTrade,
    rMultiple,
    planR,
    realizedR,
    reconcileStatus,
    applyDualTrack,
    pnlUsd,
    enrichClosedTrade,
    fmtDualTrack,
    sessionStats,
    fmtExpectancy,
    fmtBadge,
  };
})(typeof window !== "undefined" ? window : globalThis);
