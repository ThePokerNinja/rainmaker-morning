/**
 * Deterministic context bundle for Results command center (Phase 1).
 */
(function (global) {
  "use strict";

  const NOTES_KEY = "rainmaker_chart_notes_v1";
  const EMPTY_POSTURE = "\u2014";

  function todayPtKey() {
    if (typeof global.RMSchwabData !== "undefined" && global.RMSchwabData.todayPt) {
      return global.RMSchwabData.todayPt();
    }
    return new Date().toISOString().slice(0, 10);
  }

  function loadAllChartNotes() {
    try {
      return JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function notesInTodayWindow() {
    const day = todayPtKey();
    const out = [];
    const all = loadAllChartNotes();
    Object.keys(all).forEach((sym) => {
      (all[sym] || []).forEach((n) => {
        if (!n || !n.t) return;
        const noteDay = String(n.t).slice(0, 10);
        if (noteDay === day) {
          out.push({
            id: n.id,
            symbol: sym,
            text: n.text || "",
            tags: Array.isArray(n.tags) ? n.tags.slice() : [],
            t: n.t,
          });
        }
      });
    });
    return out;
  }

  function taggedNoteSummary(notes) {
    const counts = {};
    notes.forEach((n) => {
      (n.tags || []).forEach((tag) => {
        counts[tag] = (counts[tag] || 0) + 1;
      });
    });
    return counts;
  }

  function sessionCatalyst(session) {
    if (!session) return [];
    const headlines = session.catalyst_headlines || session.headlines || [];
    if (Array.isArray(headlines) && headlines.length) {
      return headlines
        .slice(0, 5)
        .map((h) => (typeof h === "string" ? h : h?.title || h?.headline || ""))
        .filter(Boolean);
    }
    const events = session.events || session.scan_events || [];
    if (Array.isArray(events)) {
      return events
        .filter((e) => e && (e.headline || e.title || e.text))
        .slice(0, 5)
        .map((e) => e.headline || e.title || e.text);
    }
    return [];
  }

  function buildDeskNarrative(bundle) {
    const parts = [];
    const c1 = bundle.kpi?.c1;
    const c2 = bundle.kpi?.c2;
    if (c1?.gate === "stop") {
      parts.push("Risk-off posture - pulse gate is stop; size down or stand aside.");
    } else if (c1?.posture) {
      parts.push(String(c1.posture).replace(/^[^:]+:\s*/, "") || c1.posture);
    }
    if (c2?.gate && c2.gate !== "go" && c2.posture && c2.posture !== EMPTY_POSTURE) {
      parts.push("Structure: " + c2.posture);
    } else if (c2?.posture && c2.posture !== EMPTY_POSTURE) {
      parts.push(c2.posture);
    }
    const js = bundle.journal;
    if (js?.trades >= 3 && js.totalR != null) {
      const sign = js.totalR >= 0 ? "+" : "";
      parts.push("You're " + sign + js.totalR.toFixed(1) + "R over last " + js.trades + " closes.");
    }
    const openSyms = bundle.openSyms || [];
    if (openSyms.length) {
      const sym = openSyms[0];
      const label =
        typeof global.RMHoldings !== "undefined" &&
        global.RMHoldings.isOptionSymbol?.(sym) &&
        global.RMHoldings.formatOptionLabel
          ? global.RMHoldings.formatOptionLabel(sym)
          : sym;
      parts.push("Lead with REVIEW on " + label + ".");
    }
    const tagCounts = bundle.taggedNotes || {};
    const tagKeys = Object.keys(tagCounts);
    if (tagKeys.length) {
      const top = tagKeys.sort((a, b) => tagCounts[b] - tagCounts[a])[0];
      const n = tagCounts[top];
      const label =
        typeof global.RMTradeDebrief !== "undefined" &&
        global.RMTradeDebrief.REFLECT_TAGS
          ? global.RMTradeDebrief.REFLECT_TAGS.find((t) => t.id === top)?.label || top
          : top;
      parts.push(n + " note" + (n === 1 ? "" : "s") + " tagged " + label + " today.");
    }
    if (!parts.length && bundle.conviction?.line) {
      return bundle.conviction.line;
    }
    return parts.slice(0, 3).join(" ");
  }

  function buildResultsContext(opts) {
    opts = opts || {};
    const getSession = opts.getSession || (() => null);
    const getTrades = opts.getTrades || (() => []);
    const getJournalTrades = opts.getJournalTrades || getTrades;
    const schwabConnectedSync = opts.schwabConnectedSync || (() => false);
    const collectOpenSymbols = opts.collectOpenSymbols || (() => []);
    const readConvictionCopy = opts.readConvictionCopy || (() => ({
      kicker: "Undecided",
      line: "Mixed signals. The tape hasn't picked a side yet.",
    }));

    const conviction = readConvictionCopy();
    const bias =
      typeof global.RMMarket !== "undefined" && global.RMMarket.getLastMorningBias
        ? global.RMMarket.getLastMorningBias()
        : null;
    const indices =
      typeof global.RMMarket !== "undefined" && global.RMMarket.getCachedIndices
        ? global.RMMarket.getCachedIndices()
        : {};
    const session = getSession();
    const pickCount = session?.pick_count || session?.picks?.length || 0;
    const openSyms = collectOpenSymbols();
    const kpi =
      typeof global.RMColumnKPI !== "undefined" && global.RMColumnKPI.compute
        ? global.RMColumnKPI.compute()
        : null;

    let journal = null;
    const journalTrades = getJournalTrades() || [];
    if (
      typeof global.RMJournal !== "undefined" &&
      global.RMJournal.computeJournalStats
    ) {
      journal = global.RMJournal.computeJournalStats(journalTrades);
    }

    const tradesOpen = (getTrades() || []).filter((t) => t && t.status === "open");
    const today = todayPtKey();
    const tradesClosedToday = journalTrades.filter((t) => {
      if (!t || t.status !== "closed") return false;
      const d = String(t.closed_at || t.opened_at || "").slice(0, 10);
      return d === today;
    });

    const chartNotes = notesInTodayWindow();
    const taggedNotes = taggedNoteSummary(chartNotes);

    const brief =
      typeof global.RMWorkspaceLoad !== "undefined" && global.RMWorkspaceLoad.getMorningBrief
        ? global.RMWorkspaceLoad.getMorningBrief()
        : null;

    let bars = [];
    if (typeof global.RMAnalysisChart !== "undefined") {
      const st = global.RMAnalysisChart.state;
      if (st?.symbol === "SPY" && st.bars?.length) bars = st.bars;
    }

    const bundle = {
      conviction,
      bias,
      indices,
      bars,
      session,
      pickCount,
      openSyms,
      kpi,
      c1: kpi?.c1 || null,
      c2: kpi?.c2 || null,
      c3: kpi?.c3 || null,
      charge: kpi?.charge ?? null,
      stage: kpi?.stage || null,
      storyReadiness: kpi?.storyReadiness ?? null,
      pulseGate: kpi?.c1?.gate || null,
      pulseLabel: bias?.market?.label ? String(bias.market.label).toLowerCase() : null,
      journal,
      tradesOpen,
      tradesClosedToday,
      chartNotes,
      taggedNotes,
      catalyst: sessionCatalyst(session),
      brief: brief && Object.keys(brief).length ? brief : null,
      schwabConnected: schwabConnectedSync(),
      newsFilterAt: session?.news_filter_applied_at || null,
    };

    bundle.deskNarrative = buildDeskNarrative(bundle);
    return bundle;
  }

  global.RMResultsContext = {
    buildResultsContext,
    buildDeskNarrative,
    notesInTodayWindow,
    NOTES_KEY,
  };
})(typeof window !== "undefined" ? window : globalThis);
