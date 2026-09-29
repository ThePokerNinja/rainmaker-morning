/** RM decile vs 1R hit rate — backtest + live (Tier 1 calibration). */
(function (global) {
  const DECILE_COUNT = 10;
  const MIN_N = 30;

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function decileForScore(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return null;
    const clamped = Math.max(0, Math.min(100, s));
    if (clamped >= 100) return 9;
    return Math.min(9, Math.floor(clamped / 10));
  }

  function decileLabel(d) {
    if (d === 9) return "90–100";
    return d * 10 + "–" + (d * 10 + 9);
  }

  function hit1R(r) {
    return r != null && Number.isFinite(r) && r >= 1;
  }

  function aggregateDeciles(items) {
    const buckets = Array.from({ length: DECILE_COUNT }, (_, d) => ({
      decile: d,
      label: decileLabel(d),
      n: 0,
      hit1R: 0,
      sumR: 0,
      rCount: 0,
    }));
    for (const it of items) {
      if (it.r_multiple == null) continue;
      const d = decileForScore(it.rm);
      if (d == null) continue;
      const b = buckets[d];
      b.n++;
      if (hit1R(it.r_multiple)) b.hit1R++;
      b.sumR += it.r_multiple;
      b.rCount++;
    }
    return buckets
      .filter((b) => b.n > 0)
      .map((b) => ({
        decile: b.decile,
        label: b.label,
        n: b.n,
        hit1R: b.hit1R,
        hit1RPct: Math.round((b.hit1R / b.n) * 100),
        avgR: b.rCount ? round2(b.sumR / b.rCount) : null,
      }));
  }

  function thresholdStats(items, minRm, label) {
    const subset = items.filter(
      (it) => it.r_multiple != null && (Number(it.rm) || 0) >= minRm
    );
    if (!subset.length) {
      return { label, minRm, n: 0, hit1R: 0, hit1RPct: null, avgR: null };
    }
    const hit = subset.filter((it) => hit1R(it.r_multiple)).length;
    const sumR = subset.reduce((s, it) => s + it.r_multiple, 0);
    return {
      label,
      minRm,
      n: subset.length,
      hit1R: hit,
      hit1RPct: Math.round((hit / subset.length) * 100),
      avgR: round2(sumR / subset.length),
    };
  }

  function buildReport(source, items) {
    const withR = items.filter((it) => it.r_multiple != null);
    const sumR = withR.reduce((s, it) => s + it.r_multiple, 0);
    return {
      source,
      totalN: withR.length,
      avgR: withR.length ? round2(sumR / withR.length) : null,
      hit1RPct: withR.length
        ? Math.round((withR.filter((it) => hit1R(it.r_multiple)).length / withR.length) * 100)
        : null,
      bands: aggregateDeciles(items),
      rm50: thresholdStats(items, 50, "RM ? 50"),
      rm70: thresholdStats(items, 70, "RM ? 70"),
      insufficient: withR.length < MIN_N,
    };
  }

  function itemsFromBacktest(picks, backtestReport) {
    const pickBySym = {};
    for (const p of picks || []) {
      if (p?.symbol) pickBySym[p.symbol] = p;
    }
    const items = [];
    for (const r of backtestReport?.results || []) {
      const p = pickBySym[r.symbol];
      const rm =
        r.rm_confidence ??
        p?.rm_confidence_adjusted ??
        p?.rm_confidence;
      if (r.r_multiple == null) continue;
      items.push({ symbol: r.symbol, rm, r_multiple: r.r_multiple });
    }
    return items;
  }

  function itemsFromLiveTrades(trades) {
    const items = [];
    for (const t of trades || []) {
      if (t.status !== "closed" || t.filled === false) continue;
      if (
        typeof RMTradeMetrics !== "undefined" &&
        !RMTradeMetrics.isPlannedTrade(t)
      ) {
        continue;
      }
      const rm = t.rm_confidence_adjusted ?? t.rm_confidence;
      const r =
        typeof RMTradeMetrics !== "undefined"
          ? RMTradeMetrics.rMultiple(t)
          : t.r_multiple;
      if (r == null) continue;
      items.push({ symbol: t.symbol, rm, r_multiple: r });
    }
    return items;
  }

  function calibrateBacktest(picks, backtestReport) {
    return buildReport("backtest", itemsFromBacktest(picks, backtestReport));
  }

  function calibrateLive(trades) {
    return buildReport("live", itemsFromLiveTrades(trades));
  }

  function fmtThresholdRow(t) {
    if (!t?.n) return t.label + " — no data";
    return (
      t.label +
      " — " +
      t.hit1RPct +
      "% hit 1R (" +
      t.hit1R +
      "/" +
      t.n +
      ")" +
      (t.avgR != null ? " — avg " + (t.avgR >= 0 ? "+" : "") + t.avgR.toFixed(2) + "R" : "")
    );
  }

  function renderBandTable(report, title) {
    if (!report?.totalN) {
      return (
        '<div class="tt-cal-block"><h5>' +
        title +
        '</h5><p class="meta">No R data yet — run backtest or close planned trades.</p></div>'
      );
    }
    let rows = "";
    for (const b of report.bands) {
      rows +=
        "<tr><td>" +
        b.label +
        "</td><td>" +
        b.n +
        "</td><td>" +
        b.hit1RPct +
        "%</td><td>" +
        (b.avgR != null
          ? (b.avgR >= 0 ? "+" : "") + b.avgR.toFixed(2) + "R"
          : "—") +
        "</td></tr>";
    }
    const note = report.insufficient
      ? '<p class="tt-cal-note">N=' +
        report.totalN +
        " — illustrative until N≥" +
        MIN_N +
        " (M1-spec).</p>"
      : "";
    return (
      '<div class="tt-cal-block"><h5>' +
      title +
      (report.avgR != null
        ? ' — <span class="tt-cal-summary">' +
          (report.avgR >= 0 ? "+" : "") +
          report.avgR.toFixed(2) +
          "R avg — " +
          report.hit1RPct +
          "% hit 1R</span>"
        : "") +
      "</h5>" +
      '<table class="tt-cal-table"><thead><tr><th>RM decile</th><th>N</th><th>Hit 1R</th><th>Avg R</th></tr></thead><tbody>' +
      rows +
      "</tbody></table>" +
      '<p class="tt-cal-thresholds">' +
      fmtThresholdRow(report.rm50) +
      " — " +
      fmtThresholdRow(report.rm70) +
      "</p>" +
      note +
      "</div>"
    );
  }

  function renderPanel(picks, backtestRaw, trades) {
    const bt = backtestRaw?.results?.length
      ? calibrateBacktest(picks, backtestRaw)
      : buildReport("backtest", []);
    const live = calibrateLive(trades || []);
    const rule = backtestRaw?.entry_rule || "orh";
    const rr = backtestRaw?.rr != null ? backtestRaw.rr : 2;
    const btLabel =
      rule === "vwap"
        ? "Backtest - VWAP " + rr + "R"
        : "Backtest - ORH " + rr + "R";
    const rangeNote =
      backtestRaw?.range && backtestRaw.range !== "1d"
        ? " · " + backtestRaw.range
        : backtestRaw?.mode === "offline"
          ? " · today only"
          : "";
    return (
      '<div class="tt-calibration-grid">' +
      renderBandTable(bt, btLabel + rangeNote) +
      renderBandTable(live, "Live - planned closes") +
      "</div>"
    );
  }

  global.RMCalibration = {
    MIN_N,
    decileForScore,
    decileLabel,
    hit1R,
    calibrateBacktest,
    calibrateLive,
    itemsFromBacktest,
    itemsFromLiveTrades,
    renderBandTable,
    renderPanel,
    fmtThresholdRow,
  };
})(typeof window !== "undefined" ? window : global);
