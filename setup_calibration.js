/**
 * Setup grading weight calibration  -  grid search + DECISIONS.log proposal (G6).
 */
(function (global) {
  const WEIGHT_GRID = [0.2, 0.25, 0.3, 0.35];

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function normalizeWeights(w) {
    const sum = w.context + w.universe + w.structure + w.trigger;
    if (!sum) return w;
    return {
      context: w.context / sum,
      universe: w.universe / sum,
      structure: w.structure / sum,
      trigger: w.trigger / sum,
    };
  }

  function scoreWithWeights(fp, weights) {
    const p = fp.pillars || {};
    const raw =
      (p.context?.score ?? 0) * weights.context +
      (p.universe?.score ?? 0) * weights.universe +
      (p.structure?.score ?? 0) * weights.structure +
      (p.trigger?.score ?? 0) * weights.trigger;
    return raw;
  }

  function itemsFromTrades(trades) {
    if (typeof global.RMSetupAttribution === "undefined") return [];
    return global.RMSetupAttribution.plannedClosedTrades(trades);
  }

  function expectancyForBand(items, weights, bandThresholds) {
    let sum = 0;
    let n = 0;
    for (const it of items) {
      const s = scoreWithWeights(it.fp, weights) * 100;
      if (s < (bandThresholds?.solid_min_score ?? 58)) continue;
      sum += it.r;
      n++;
    }
    return n ? sum / n : null;
  }

  function gridSearch(trades, opts) {
    const items = itemsFromTrades(trades);
    const minN = opts?.min_n ?? 30;
    if (items.length < minN) {
      return { ok: false, reason: "insufficient_n", n: items.length, min_n: minN };
    }
    const cfg =
      typeof global.RMSetupFingerprint !== "undefined"
        ? global.RMSetupFingerprint.getConfig()
        : {};
    const bands = cfg.bands || {};
    const current = normalizeWeights(cfg.pillar_weights || {
      context: 0.25,
      universe: 0.3,
      structure: 0.3,
      trigger: 0.15,
    });
    let best = { weights: current, expectancy: expectancyForBand(items, current, bands) };
    for (const c of WEIGHT_GRID) {
      for (const u of WEIGHT_GRID) {
        for (const s of WEIGHT_GRID) {
          for (const t of WEIGHT_GRID) {
            const w = normalizeWeights({ context: c, universe: u, structure: s, trigger: t });
            const exp = expectancyForBand(items, w, bands);
            if (exp != null && (best.expectancy == null || exp > best.expectancy)) {
              best = { weights: w, expectancy: round2(exp) };
            }
          }
        }
      }
    }
    const currentExp = expectancyForBand(items, current, bands);
    return {
      ok: true,
      n: items.length,
      current_weights: current,
      current_expectancy: currentExp != null ? round2(currentExp) : null,
      proposed_weights: best.weights,
      proposed_expectancy: best.expectancy,
      delta_r:
        best.expectancy != null && currentExp != null
          ? round2(best.expectancy - currentExp)
          : null,
    };
  }

  function buildProposalMarkdown(result, opts) {
    const mk = opts?.month || new Date().toISOString().slice(0, 7);
    if (!result?.ok) {
      return (
        "## Setup grading calibration  -  " +
        mk +
        "\n\nInsufficient data (N=" +
        (result?.n ?? 0) +
        ", need " +
        (result?.min_n ?? 30) +
        ").\n"
      );
    }
    const pw = result.proposed_weights;
    const cw = result.current_weights;
    const decision =
      "Adjust setup pillar weights: context " +
      round2(cw.context) +
      "?" +
      round2(pw.context) +
      ", universe " +
      round2(cw.universe) +
      "?" +
      round2(pw.universe) +
      ", structure " +
      round2(cw.structure) +
      "?" +
      round2(pw.structure) +
      ", trigger " +
      round2(cw.trigger) +
      "?" +
      round2(pw.trigger);
    const evidence =
      "Solid+ band expectancy " +
      (result.current_expectancy != null ? result.current_expectancy + "R" : " - ") +
      " ? proposed " +
      (result.proposed_expectancy != null ? result.proposed_expectancy + "R" : " - ") +
      " (N=" +
      result.n +
      " planned closes)";
    if (typeof global.RMMonthlyReview !== "undefined") {
      return global.RMMonthlyReview.buildDecisionsMarkdown({
        month: mk,
        title: "Setup grading weights " + mk,
        decision,
        liveAvgR: result.proposed_expectancy,
        liveN: result.n,
        calibrationNote: evidence,
        changeAfter: "Update config/setup_grading.yaml + bump version",
      });
    }
    return (
      "## D-0XX  -  Setup grading weights " +
      mk +
      "\n\n| Decision | " +
      decision +
      " |\n| Evidence | " +
      evidence +
      " |\n| Status | proposed |\n"
    );
  }

  global.RMSetupCalibration = {
    gridSearch,
    buildProposalMarkdown,
  };
})(typeof window !== "undefined" ? window : globalThis);
