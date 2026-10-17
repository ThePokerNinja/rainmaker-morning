/**
 * Green-light validation panel (Batch 2 #5).
 */
(function (global) {
  const PANEL_ID = "ttGreenLitPanel";
  const MIN_SAMPLE = 5;
  const MIN_TOTAL = 8;
  let timer = null;

  function pct(v) {
    return v == null ? "-" : Math.round(v * 100) + "%";
  }
  function rfmt(v) {
    return v == null ? "-" : (v >= 0 ? "+" : "") + v.toFixed(2) + "R";
  }

  function render() {
    const el = document.getElementById(PANEL_ID);
    if (!el || typeof global.RMMetrics === "undefined") return;
    const data = global.RMMetrics.greenLitValidation();
    if (!data || data.total < MIN_TOTAL) {
      el.innerHTML =
        '<div class="tt-learning-head"><h3>Validation edge</h3>' +
        '<span class="tt-learning-tag">building</span></div>' +
        '<p class="tt-learning-note">Logging trades against their validation count. ' +
        "Need " +
        MIN_TOTAL +
        "+ closed trades to show win% / avg R by 0-3 validated (have " +
        (data ? data.total : 0) +
        ").</p>";
      return;
    }

    const rows = [3, 2, 1, 0]
      .map((k) => {
        const b = data.buckets[k];
        const thin = b.trades < MIN_SAMPLE;
        const winClass = b.winRate != null && b.winRate >= 0.5 ? "is-good" : "is-weak";
        const rClass = b.avgR != null && b.avgR > 0 ? "is-good" : "is-weak";
        return (
          '<tr' +
          (thin ? ' class="is-thin"' : "") +
          '><th scope="row"><span class="glv-dots">' +
          [0, 1, 2]
            .map((i) => '<i class="glv-dot' + (i < k ? " is-lit" : "") + '"></i>')
            .join("") +
          "</span>" +
          k +
          "/3</th>" +
          '<td>' +
          b.trades +
          "</td>" +
          '<td class="' +
          winClass +
          '">' +
          pct(b.winRate) +
          "</td>" +
          '<td class="' +
          rClass +
          '">' +
          rfmt(b.avgR) +
          (thin ? '<span class="glv-thin">thin</span>' : "") +
          "</td></tr>"
        );
      })
      .join("");

    const lit3 = data.buckets[3];
    const lit0 = data.buckets[0];
    let verdict = "";
    if (lit3.trades >= MIN_SAMPLE && lit0.trades >= MIN_SAMPLE) {
      const edge =
        (lit3.avgR != null ? lit3.avgR : 0) - (lit0.avgR != null ? lit0.avgR : 0);
      verdict =
        '<p class="tt-learning-note">' +
        (edge > 0
          ? "Fully-charged (3/3) trades are running " +
            edge.toFixed(2) +
            "R better than 0/3 - diligence is paying."
          : "No edge yet for 3/3 over 0/3 - keep sampling.") +
        "</p>";
    }

    el.innerHTML =
      '<div class="tt-learning-head"><h3>Validation edge</h3>' +
      '<span class="tt-learning-tag">' +
      data.total +
      " trades - " +
      data.nDays +
      "d</span></div>" +
      '<table class="glv-table"><thead><tr>' +
      "<th>Validated</th><th>Trades</th><th>Win%</th><th>Avg R</th>" +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>" +
      verdict;
  }

  function startPoll() {
    if (timer) return;
    timer = setInterval(render, 15000);
  }

  function stopPoll() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function onLearningTabShown() {
    render();
    startPoll();
  }

  function start() {
    render();
    document.addEventListener("rm:results-tab-shown", onLearningTabShown);
    document.addEventListener("rm:strategy-tab-shown", onLearningTabShown);
    document.addEventListener("rm:trade-closed", render);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopPoll();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  global.RMGreenLitPanel = { render, startPoll, stopPoll };
})(typeof window !== "undefined" ? window : globalThis);
