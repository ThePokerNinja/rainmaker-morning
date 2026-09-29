/** Monthly hypothesis review ? DECISIONS.log.md entry (Tier 1). */
(function (global) {
  const STORAGE_KEY = "rainmaker_monthly_review_drafts";

  function round2(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function monthKey(d) {
    const dt = d || new Date();
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0");
  }

  function loadDrafts() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveDrafts(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  function saveDraft(draft) {
    const list = loadDrafts();
    const id = draft.id || "review-" + Date.now();
    const next = { ...draft, id, saved_at: new Date().toISOString() };
    const idx = list.findIndex((d) => d.id === id);
    if (idx >= 0) list[idx] = next;
    else list.unshift(next);
    saveDrafts(list.slice(0, 12));
    return next;
  }

  function calibrationSummary(btReport, liveReport) {
    const parts = [];
    if (typeof RMCalibration !== "undefined") {
      if (btReport?.rm50?.n) parts.push("BT " + RMCalibration.fmtThresholdRow(btReport.rm50));
      if (liveReport?.rm50?.n) parts.push("Live " + RMCalibration.fmtThresholdRow(liveReport.rm50));
    }
    return parts.join("; ");
  }

  function buildDecisionsMarkdown(opts) {
    const mk = opts.month || monthKey();
    const title = opts.title || "H-001 monthly review " + mk;
    const decision = (opts.decision || "").trim() || "(describe one weight/threshold change)";
    const evidenceParts = [];
    if (opts.backtestAvgR != null && opts.backtestN) {
      evidenceParts.push(
        "Backtest " +
          (opts.backtestAvgR >= 0 ? "+" : "") +
          Number(opts.backtestAvgR).toFixed(2) +
          "R avg (N=" +
          opts.backtestN +
          ")"
      );
    }
    if (opts.liveAvgR != null && opts.liveN) {
      evidenceParts.push(
        "Live " +
          (opts.liveAvgR >= 0 ? "+" : "") +
          Number(opts.liveAvgR).toFixed(2) +
          "R avg (N=" +
          opts.liveN +
          " planned)"
      );
    }
    if (opts.driftR != null && Number.isFinite(opts.driftR)) {
      evidenceParts.push(
        "Drift live?backtest " +
          (opts.driftR >= 0 ? "+" : "") +
          opts.driftR.toFixed(2) +
          "R"
      );
    }
    const evidence = evidenceParts.length
      ? evidenceParts.join("; ")
      : "Run backtest + close planned trades first";
    const cal = (opts.calibrationNote || "").trim();
    const notes = [cal, opts.changeAfter ? "After change: " + opts.changeAfter : ""]
      .filter(Boolean)
      .join(" · ");

    return (
      "## D-0XX — " +
      title +
      "\n\n" +
      "| Field | Value |\n" +
      "|-------|--------|\n" +
      "| Date | " +
      (opts.date || new Date().toISOString().slice(0, 10)) +
      " |\n" +
      "| Milestone | M1 |\n" +
      "| Assumption IDs | H-001 |\n" +
      "| Decision | " +
      decision +
      " |\n" +
      "| Confidence | M |\n" +
      "| Status | proposed |\n" +
      "| Evidence | " +
      evidence +
      " |\n" +
      "| Owner | Michael |\n" +
      (notes ? "| Notes | " + notes + " |\n" : "") +
      "\n---\n"
    );
  }

  function autoMetrics(getTrades, session, backtestReport) {
    let liveReport = null;
    let btReport = null;
    if (typeof RMCalibration !== "undefined" && typeof getTrades === "function") {
      liveReport = RMCalibration.calibrateLive(getTrades());
      if (session?.picks?.length && backtestReport) {
        btReport = RMCalibration.calibrateBacktest(session.picks, backtestReport);
      }
    }
    const backtestAvgR = backtestReport?.summary?.avgR ?? btReport?.avgR ?? null;
    const backtestN = backtestReport?.summary?.n ?? btReport?.totalN ?? 0;
    const liveAvgR = liveReport?.avgR ?? null;
    const liveN = liveReport?.totalN ?? 0;
    const driftR =
      backtestAvgR != null && liveAvgR != null
        ? round2(liveAvgR - backtestAvgR)
        : null;
    return {
      backtestAvgR,
      backtestN,
      liveAvgR,
      liveN,
      driftR,
      calibrationNote: calibrationSummary(btReport, liveReport),
      btReport,
      liveReport,
    };
  }

  async function copyMarkdown(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  global.RMMonthlyReview = {
    monthKey,
    loadDrafts,
    saveDraft,
    buildDecisionsMarkdown,
    autoMetrics,
    copyMarkdown,
  };
})(typeof window !== "undefined" ? window : global);
