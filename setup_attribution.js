/**
 * Setup attribution - mine fingerprint steps vs R (Strategy tab + local learning).
 */
(function (global) {
  const MIN_N = 30;
  const STEP_LABELS = {
    regime_ok: "Regime OK (Pulse not stop)",
    universe_ok: "Universe OK (RM + scan)",
    plan_written: "Written plan",
    structure_ok: "Structure aligned",
    trigger_fired: "Trigger matched strategy",
    entry_filled: "Entry filled",
    stop_defined: "Stop defined",
  };

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function hit1R(r) {
    return r != null && Number.isFinite(r) && r >= 1;
  }

  function plannedClosedTrades(trades) {
    const out = [];
    for (const t of trades || []) {
      if (t.status !== "closed" || t.filled === false) continue;
      if (typeof global.RMTradeMetrics !== "undefined" && !global.RMTradeMetrics.isPlannedTrade(t)) {
        continue;
      }
      if (!t.setup_fingerprint) continue;
      const r =
        typeof global.RMTradeMetrics !== "undefined"
          ? global.RMTradeMetrics.rMultiple(t)
          : t.r_multiple;
      if (r == null) continue;
      out.push({ trade: t, r, fp: t.setup_fingerprint });
    }
    return out;
  }

  function baselineStats(items) {
    if (!items.length) return null;
    const hit = items.filter((it) => hit1R(it.r)).length;
    const sumR = items.reduce((s, it) => s + it.r, 0);
    return {
      n: items.length,
      hit1R: hit,
      hit1RPct: Math.round((hit / items.length) * 100),
      avgR: round2(sumR / items.length),
    };
  }

  function attributeLift(items, key, baseline) {
    const subset = items.filter((it) => it.fp?.steps?.[key] === true);
    if (!subset.length) return null;
    const hit = subset.filter((it) => hit1R(it.r)).length;
    const sumR = subset.reduce((s, it) => s + it.r, 0);
    const avgR = round2(sumR / subset.length);
    const hit1RPct = Math.round((hit / subset.length) * 100);
    const lift =
      baseline?.avgR != null ? round2(avgR - baseline.avgR) : null;
    return {
      key,
      label: STEP_LABELS[key] || key,
      n: subset.length,
      hit1R: hit,
      hit1RPct,
      avgR,
      lift,
      necessary:
        subset.length >= 3 &&
        items.filter((it) => hit1R(it.r)).length > 0 &&
        hit / subset.length >= 0.8,
    };
  }

  function bandStats(items, band) {
    const subset = items.filter((it) => (it.fp?.setup_band ?? 4) === band);
    return baselineStats(subset);
  }

  function buildReport(trades, opts) {
    const playId = opts?.play_id || null;
    let items = plannedClosedTrades(trades);
    if (playId) {
      items = items.filter((it) => it.fp?.play_id === playId);
    }
    const baseline = baselineStats(items);
    const attributes = Object.keys(STEP_LABELS)
      .map((key) => attributeLift(items, key, baseline))
      .filter(Boolean)
      .sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));

    const bands = [1, 2, 3].map((b) => ({
      band: b,
      label:
        typeof global.RMSetupFingerprint !== "undefined"
          ? global.RMSetupFingerprint.BAND_LABELS[b]
          : String(b),
      stats: bandStats(items, b),
    }));

    return {
      play_id: playId,
      totalN: items.length,
      insufficient: items.length < MIN_N,
      min_n: MIN_N,
      baseline,
      attributes: attributes.slice(0, 8),
      bands,
      top_winners: attributes.filter((a) => a.necessary).slice(0, 5),
    };
  }

  function renderWinnersTable(report) {
    if (!report) {
      return '<p class="meta">Close planned trades with a written plan to build setup fingerprints.</p>';
    }
    if (report.insufficient) {
      return (
        '<p class="meta">What winners shared - need ' +
        report.min_n +
        " planned closes with fingerprints (have " +
        report.totalN +
        ").</p>"
      );
    }
    const base = report.baseline;
    let head =
      '<div class="tt-setup-attrib">' +
      '<div class="tt-strategy-section-head"><h3 class="tt-strategy-title">What winners shared</h3>' +
      '<span class="meta">Planned closes - avg ' +
      (base.avgR >= 0 ? "+" : "") +
      base.avgR +
      "R - " +
      base.hit1RPct +
      "% hit 1R (N=" +
      base.n +
      ")</span></div>";
    if (report.bands?.length) {
      head += '<p class="meta tt-setup-band-row">';
      for (const b of report.bands) {
        if (!b.stats?.n) continue;
        head +=
          b.label +
          ": " +
          (b.stats.avgR >= 0 ? "+" : "") +
          b.stats.avgR +
          "R (" +
          b.stats.n +
          ") - ";
      }
      head = head.replace(/ - $/, "") + "</p>";
    }
    let rows = "";
    for (const a of report.attributes || []) {
      rows +=
        "<tr><td>" +
        a.label +
        "</td><td>" +
        a.n +
        "</td><td>" +
        a.hit1RPct +
        "%</td><td>" +
        (a.avgR >= 0 ? "+" : "") +
        a.avgR +
        "R</td><td>" +
        (a.lift != null ? (a.lift >= 0 ? "+" : "") + a.lift + "R" : "-") +
        "</td><td>" +
        (a.necessary ? "core" : "") +
        "</td></tr>";
    }
    if (!rows) {
      return head + '<p class="meta">No step attributes logged yet.</p></div>';
    }
    return (
      head +
      '<table class="tt-cal-table"><thead><tr><th>Attribute</th><th>N</th><th>Hit 1R</th><th>Avg R</th><th>Lift</th><th></th></tr></thead><tbody>' +
      rows +
      "</tbody></table></div>"
    );
  }

  async function fetchRemoteReport(playId) {
    const meta = document.querySelector('meta[name="rainmaker-api-base"]');
    let base = meta?.content?.trim()?.replace(/\/$/, "");
    if (!base) {
      const h = location.hostname;
      if (h === "localhost" || h === "127.0.0.1") base = "http://127.0.0.1:8765";
      else base = "https://rainmaker-api-waqs.onrender.com";
    }
    try {
      const q = playId ? "?play_id=" + encodeURIComponent(playId) : "";
      const res = await fetch(base + "/learning/setup-attribution" + q);
      if (!res.ok) return null;
      return res.json();
    } catch (_) {
      return null;
    }
  }

  global.RMSetupAttribution = {
    MIN_N,
    buildReport,
    renderWinnersTable,
    plannedClosedTrades,
    fetchRemoteReport,
  };
})(typeof window !== "undefined" ? window : globalThis);
