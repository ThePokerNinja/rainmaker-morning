/** Finviz-style market map: indices, breadth, pick heatmap. */
(function (global) {
  const SETTINGS_KEY = "rainmaker_market_map_settings_v1";
  const DEFAULT_SETTINGS = {
    showIndices: true,
    showFutures: true,
    showMacroHint: true,
    showSignals: true,
    showBreadth: true,
    showTopMover: true,
    showPickMap: true,
    showMapCatalyst: true,
    showMapVsSpy: true,
    showMapVol: true,
    showMorningBias: true,
    showExchangeBreadth: true,
    mapSort: "gap",
    indices: ["SPY", "QQQ", "IWM", "DIA", "^VIX"],
  };

  const INDEX_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA", "^VIX"];
  const FUTURES_SYMBOLS = ["$ES=F", "$NQ=F"];

  const FUTURES_META = {
    "$ES=F": {
      name: "S&P 500 futures",
      desc: "Overnight / premarket risk tone for the broad market. Often leads cash at the open.",
      short: "ES",
    },
    "$NQ=F": {
      name: "Nasdaq 100 futures",
      desc: "Growth and mega-cap tech tone. Watch ES vs NQ divergence for narrow vs broad tape.",
      short: "NQ",
    },
  };

  const INDEX_META = {
    SPY: {
      name: "S&P 500",
      desc: "Broad US large-cap benchmark. Rainmaker normalizes pick moves against SPY on the unified chart.",
    },
    QQQ: {
      name: "Nasdaq 100",
      desc: "Mega-cap growth and tech. Often leads on gap-up momentum days when semis and AI names run.",
    },
    IWM: {
      name: "Russell 2000",
      desc: "Small-cap risk appetite gauge. Rising IWM with SPY confirms broad participation.",
    },
    DIA: {
      name: "Dow 30",
      desc: "Blue-chip industrials and financials. Steady tape here supports defensive gap-and-go setups.",
    },
    "^VIX": {
      name: "VIX",
      desc: "CBOE volatility index. Spikes signal fear and risk-off; calm VIX favors momentum longs.",
    },
    VIX: {
      name: "VIX",
      desc: "CBOE volatility index. Spikes signal fear and risk-off; calm VIX favors momentum longs.",
    },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(next) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  }

  function sentimentClass(b) {
    if (!b.total) return "fv-sentiment-neutral";
    const bull = b.advPct;
    const bear = b.decPct;
    if (bull >= bear + 15) return "fv-sentiment-bull";
    if (bear >= bull + 15) return "fv-sentiment-bear";
    return "fv-sentiment-neutral";
  }

  const SIGNAL_META = {
    adv: {
      label: "Advancing",
      desc: "Scan picks trading above prior close (day change > +0.05%). More advancers = bullish breadth.",
    },
    flat: {
      label: "Unchanged",
      desc: "Picks flat vs prior close (within ±0.05%). Often still gapping — check gap column.",
    },
    dec: {
      label: "Declining",
      desc: "Picks below prior close (day change < −0.05%). Heavy decliners = weak follow-through risk.",
    },
    scan: {
      label: "Scan count",
      desc: "Total tickers in the current scan after import or H-001 market pass (before news filter).",
    },
    avg: {
      label: "Average move",
      desc: "Mean day % across picks with a valid price change. Quick read on overall scan tone.",
    },
    rm: {
      label: "Avg RM score",
      desc: "Mean H-001 RM confidence (0–100). Weights float, gap proxy, volume, move %, daily %, and price band.",
    },
  };

  const HEAT_HINT = {
    "fv-hot-up": "Strong momentum — large positive day move.",
    "fv-up": "Bullish tape — positive vs prior close.",
    "fv-flat": "Neutral — little change vs prior close.",
    "fv-down": "Bearish tape — negative vs prior close.",
    "fv-hot-down": "Weak — large negative day move.",
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function bindMarketMapTips(root) {
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(root);
    (root || document).querySelectorAll(".fv-map-cell[data-symbol]").forEach((cell) => {
      if (cell.dataset.tfBound) return;
      cell.dataset.tfBound = "1";
      cell.style.cursor = "pointer";
      let prefetchTimer = null;
      cell.addEventListener(
        "pointerenter",
        () => {
          const sym = cell.dataset.symbol;
          if (!sym || typeof RMResultsHero === "undefined" || !RMResultsHero.prefetchQuote) {
            return;
          }
          if (prefetchTimer) clearTimeout(prefetchTimer);
          prefetchTimer = setTimeout(() => {
            prefetchTimer = null;
            RMResultsHero.prefetchQuote(sym);
          }, 50);
        },
        { passive: true }
      );
      cell.addEventListener("click", () => {
        document.dispatchEvent(
          new CustomEvent("rm:select-ticker", {
            detail: { symbol: cell.dataset.symbol },
          })
        );
      });
    });
  }

  function effectiveDayPct(p) {
    if (!p) return null;
    if (
      p.live_pct != null &&
      p.live_at != null &&
      Date.now() - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ) {
      return Number(p.live_pct);
    }
    if (p.pct_change != null && !Number.isNaN(Number(p.pct_change))) {
      return Number(p.pct_change);
    }
    return null;
  }

  function isGapFade(p) {
    const gap = p.gap_pct != null ? Number(p.gap_pct) : null;
    const day = effectiveDayPct(p);
    return gap != null && gap > 3 && day != null && day < 0;
  }

  function getEffectiveIndexCacheMs(indices) {
    const spy = indices?.SPY || cachedIndices?.SPY;
    if (spy?.session === "pre") return PREMARKET_INDEX_CACHE_MS;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(new Date());
      const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
      const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
      if (hour < 10 || (hour === 10 && minute < 30)) return PREMARKET_INDEX_CACHE_MS;
    } catch {
      /* fall through */
    }
    return RTH_INDEX_CACHE_MS;
  }

  function getSpyDayPct(indices) {
    const spy = indices?.SPY;
    if (spy?.chg != null && !Number.isNaN(Number(spy.chg))) return Number(spy.chg);
    return null;
  }

  function pickVsSpy(p, spyPct) {
    const day = effectiveDayPct(p);
    if (day == null || spyPct == null || Number.isNaN(spyPct)) return null;
    return Math.round((day - spyPct) * 100) / 100;
  }

  function sessionBadge(session) {
    if (session === "pre") {
      return '<span class="fv-session fv-session--pre" title="Premarket quote">PM</span>';
    }
    if (session === "post") {
      return '<span class="fv-session fv-session--post" title="After-hours quote">AH</span>';
    }
    return "";
  }

  function catalystMapLabel(cat) {
    if (!cat) {
      return { text: "?", cls: "fv-cat-review", title: "Review — run news scan" };
    }
    if (cat.verified === true) {
      return { text: "✓", cls: "fv-cat-yes", title: "Verified catalyst" };
    }
    if (cat.verified === false) {
      return { text: "—", cls: "fv-cat-no", title: "No catalyst headlines" };
    }
    if (cat.status === "news_error") {
      return { text: "!", cls: "fv-cat-err", title: "News fetch error" };
    }
    return { text: "?", cls: "fv-cat-review", title: "Awaiting news verification" };
  }

  function sortPicksForMap(picks, sortKey, spyPct) {
    const list = [...(picks || [])];
    switch (sortKey) {
      case "day":
        return list.sort(
          (a, b) => (effectiveDayPct(b) ?? -999) - (effectiveDayPct(a) ?? -999)
        );
      case "rm":
        return list.sort(
          (a, b) => (Number(b.rm_confidence) || 0) - (Number(a.rm_confidence) || 0)
        );
      case "vsSpy":
        return list.sort(
          (a, b) => (pickVsSpy(b, spyPct) ?? -999) - (pickVsSpy(a, spyPct) ?? -999)
        );
      case "gap":
      default:
        return list.sort(
          (a, b) => (Number(b.gap_pct) || -1) - (Number(a.gap_pct) || -1)
        );
    }
  }

  function mapGridColumns(settings, opts) {
    const mobile = opts?.mobile;
    const cols = ["1.15fr", "0.8fr", "0.8fr"];
    if (!mobile && settings?.showMapCatalyst !== false) cols.push("0.42fr");
    if (settings?.showMapVsSpy !== false) cols.push("0.68fr");
    if (!mobile && settings?.showMapVol !== false) cols.push("0.55fr");
    cols.push("0.52fr");
    return cols.join(" ");
  }

  function parseFinvizBreadth(html) {
    if (!html) return null;
    const text = String(html)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    const re =
      /Advancing \/ Declining[\s\S]*?Advancing<\/p><p>([\d.]+)% \((\d+)\)<\/p>[\s\S]*?Declining<\/p><p>\((\d+)\) ([\d.]+)%<\/p>[\s\S]*?center-bar" style="width: ([\d.]+)%"/i;
    const m = text.match(re);
    if (!m) return null;
    return {
      adv: Number(m[2]),
      dec: Number(m[3]),
      advPct: Math.round(Number(m[1]) * 10) / 10,
      decPct: Math.round(Number(m[4]) * 10) / 10,
      unchPct: Math.round(Number(m[5]) * 10) / 10,
      total: Number(m[2]) + Number(m[3]),
      source: "finviz",
      label: "NYSE · Nasdaq · AMEX",
      at: Date.now(),
    };
  }

  async function fetchExchangeBreadthBrowser() {
    const target = "https://finviz.com/";
    let html = null;
    try {
      if (typeof RMYahooFetch !== "undefined") {
        html = await RMYahooFetch.fetchTextViaProxies(target, { timeoutMs: FETCH_MS });
      } else {
        const enc = encodeURIComponent(target);
        const res = await fetch("https://corsproxy.io/?" + enc, { cache: "no-store" });
        if (res.ok) html = await res.text();
      }
    } catch {
      return null;
    }
    return parseFinvizBreadth(html);
  }

  async function fetchExchangeBreadthApi() {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(base + "/pulse/exchange-breadth", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.advPct == null) return null;
      return { ...data, at: data.at || Date.now() };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshExchangeBreadth() {
    if (
      cachedExchangeBreadth &&
      cachedExchangeBreadthAt &&
      Date.now() - cachedExchangeBreadthAt < EXCHANGE_BREADTH_CACHE_MS
    ) {
      return cachedExchangeBreadth;
    }
    let data = await fetchExchangeBreadthApi();
    if (!data) data = await fetchExchangeBreadthBrowser();
    if (data) {
      cachedExchangeBreadth = data;
      cachedExchangeBreadthAt = Date.now();
    }
    return cachedExchangeBreadth;
  }

  function getExchangeBreadth() {
    if (
      cachedExchangeBreadth &&
      cachedExchangeBreadthAt &&
      Date.now() - cachedExchangeBreadthAt < EXCHANGE_BREADTH_CACHE_MS
    ) {
      return cachedExchangeBreadth;
    }
    return null;
  }

  function exchangeBreadthScore(ex) {
    if (!ex || ex.advPct == null || ex.decPct == null) return null;
    return biasComponentScore((Number(ex.advPct) - Number(ex.decPct)) / 100, 0.12);
  }

  function renderExchangeBreadthBar(ex) {
    if (!ex || ex.advPct == null) return "";
    const unch = Math.max(
      0,
      ex.unchPct != null ? Number(ex.unchPct) : 100 - ex.advPct - ex.decPct
    );
    const stat =
      ex.advPct + "% adv · " + ex.decPct + "% dec · " + (ex.adv || "—") + " / " + (ex.dec || "—");
    return (
      '<div class="fv-exchange-breadth-wrap fv-tip-target" tabindex="0" data-fv-kicker="Market breadth" data-fv-title="Exchange advancers vs decliners" data-fv-desc="Total advancing vs declining issues on NYSE, Nasdaq, and AMEX (Finviz). Separate from your scan breadth below." data-fv-stat="' +
      escapeAttr(stat) +
      '">' +
      '<span class="fv-exchange-breadth-label">Market breadth · ' +
      escapeHtml(ex.label || "NYSE · Nasdaq · AMEX") +
      "</span>" +
      '<div class="fv-breadth-bar fv-exchange-breadth-bar">' +
      '<div class="fv-breadth-seg fv-up" style="width:' +
      ex.advPct +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-flat" style="width:' +
      unch +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-down" style="width:' +
      ex.decPct +
      '%"></div></div>' +
      '<span class="fv-breadth-meta">' +
      escapeHtml(stat) +
      "</span></div>"
    );
  }

  const BIAS_LOG_KEY = "rm_morning_bias_log_v1";
  const BIAS_LOG_MAX = 120;

  function biasComponentScore(chg, scale) {
    if (chg == null || Number.isNaN(Number(chg))) return null;
    const v = Number(chg);
    const s = scale || 0.35;
    return Math.max(-1, Math.min(1, v / s));
  }

  function biasSpreadScore(lead, base, scale) {
    if (lead == null || base == null) return null;
    return biasComponentScore(Number(lead) - Number(base), scale || 0.25);
  }

  function biasConfidence(components) {
    const scored = (components || []).filter(
      (c) => c.score != null && !Number.isNaN(c.score)
    );
    if (scored.length < 2) return "low";
    const signs = scored.map((c) =>
      c.score > 0.08 ? 1 : c.score < -0.08 ? -1 : 0
    );
    const pos = signs.filter((s) => s > 0).length;
    const neg = signs.filter((s) => s < 0).length;
    const neutral = signs.length - pos - neg;
    const dominant = Math.max(pos, neg, neutral);
    const ratio = dominant / signs.length;
    if (ratio >= 0.8) return "high";
    if (ratio >= 0.6) return "med";
    return "low";
  }

  function aggregateBiasTrack(components, kind) {
    let sum = 0;
    let weight = 0;
    const drivers = [];
    for (const c of components || []) {
      if (c.score == null || Number.isNaN(c.score)) continue;
      sum += c.score * c.weight;
      weight += c.weight;
      if (Math.abs(c.score) >= 0.12 && c.driver) drivers.push(c.driver);
    }
    const score = weight ? sum / weight : 0;
    const pct = Math.round((score + 1) * 50);
    const confidence = biasConfidence(components);
    let label;
    if (kind === "h001") {
      label = score > 0.12 ? "Favorable" : score < -0.12 ? "Unfavorable" : "Mixed";
    } else {
      label = score > 0.12 ? "Bullish lean" : score < -0.12 ? "Bearish lean" : "Neutral";
    }
    return {
      score,
      pct,
      label,
      confidence,
      drivers: drivers.slice(0, 5),
      components,
    };
  }

  function computeMorningBias(indices, picks, breadth, exchangeBreadth) {
    const idx = indices || {};
    const ex = exchangeBreadth || getExchangeBreadth();
    const spyPct = getSpyDayPct(idx);
    const qqqPct = idx.QQQ?.chg != null ? Number(idx.QQQ.chg) : null;
    const iwmPct = idx.IWM?.chg != null ? Number(idx.IWM.chg) : null;
    const vixPct =
      idx["^VIX"]?.chg != null
        ? Number(idx["^VIX"].chg)
        : idx.VIX?.chg != null
          ? Number(idx.VIX.chg)
          : null;
    const esPct = idx["$ES=F"]?.chg != null ? Number(idx["$ES=F"].chg) : null;
    const nqPct = idx["$NQ=F"]?.chg != null ? Number(idx["$NQ=F"].chg) : null;
    const futChgs = [esPct, nqPct].filter((v) => v != null && !Number.isNaN(v));
    const futAvg = futChgs.length
      ? futChgs.reduce((a, b) => a + b, 0) / futChgs.length
      : null;

    const narrowTape =
      qqqPct != null &&
      spyPct != null &&
      qqqPct > 0.3 &&
      qqqPct - spyPct >= 0.35;

    let marketScore = aggregateBiasTrack(
      [
        {
          weight: 0.24,
          score: biasComponentScore(futAvg, 0.4),
          driver: futAvg != null ? "Futures " + fmtPct(futAvg) : null,
        },
        {
          weight: 0.18,
          score: biasComponentScore(spyPct, 0.35),
          driver: spyPct != null ? "SPY " + fmtPct(spyPct) : null,
        },
        {
          weight: 0.12,
          score: biasComponentScore(qqqPct, 0.35),
          driver: qqqPct != null ? "QQQ " + fmtPct(qqqPct) : null,
        },
        {
          weight: 0.12,
          score: biasSpreadScore(iwmPct, spyPct, 0.25),
          driver:
            iwmPct != null && spyPct != null
              ? "IWM " + fmtPct(iwmPct - spyPct) + " vs SPY"
              : null,
        },
        {
          weight: 0.16,
          score: vixPct != null ? -biasComponentScore(vixPct, 2.5) : null,
          driver: vixPct != null ? "VIX " + fmtPct(vixPct) : null,
        },
        {
          weight: 0.18,
          score: exchangeBreadthScore(ex),
          driver:
            ex && ex.advPct != null
              ? "Market " + ex.advPct + "% adv / " + ex.decPct + "% dec"
              : null,
        },
      ],
      "market"
    );

    if (narrowTape && marketScore.score > 0) {
      marketScore = {
        ...marketScore,
        score: Math.max(-1, marketScore.score - 0.12),
        pct: Math.round((Math.max(-1, marketScore.score - 0.12) + 1) * 50),
        drivers: ["Narrow tape (QQQ > SPY)"].concat(marketScore.drivers).slice(0, 5),
        confidence: marketScore.confidence === "high" ? "med" : marketScore.confidence,
      };
    }

    const b = breadth || computeBreadth(picks);
    const list = picks || [];
    const gapFadeN = list.filter(isGapFade).length;
    const gapFadePct = list.length ? gapFadeN / list.length : 0;
    const listVsSpy =
      b.avgPct != null && spyPct != null ? b.avgPct - spyPct : null;
    const breadthSkew = b.total ? (b.advPct - b.decPct) / 100 : null;
    const gapHoldScore =
      list.length === 0
        ? null
        : gapFadePct <= 0.1
          ? 0.35
          : gapFadePct >= 0.35
            ? -0.8
            : -gapFadePct * 1.5;

    const h001 = aggregateBiasTrack(
      [
        {
          weight: 0.4,
          score: biasComponentScore(listVsSpy, 1.5),
          driver:
            listVsSpy != null ? "List " + fmtPct(listVsSpy) + " vs SPY" : null,
        },
        {
          weight: 0.35,
          score: biasComponentScore(breadthSkew, 0.3),
          driver:
            b.total
              ? "Scan " + b.advPct + "% adv / " + b.decPct + "% dec"
              : null,
        },
        {
          weight: 0.25,
          score: gapHoldScore,
          driver:
            list.length
              ? gapFadeN
                ? gapFadeN + " gap fade" + (gapFadeN === 1 ? "" : "s")
                : "Gaps holding"
              : null,
        },
      ],
      "h001"
    );

    const conflict =
      list.length > 0 &&
      Math.sign(marketScore.score || 0) !== 0 &&
      Math.sign(h001.score || 0) !== 0 &&
      Math.sign(marketScore.score) !== Math.sign(h001.score);

    return {
      at: Date.now(),
      market: marketScore,
      h001,
      exchangeBreadth: ex || null,
      narrowTape,
      conflict,
    };
  }

  function mergeMorningBias(serverBias, clientBias, picks) {
    if (!serverBias?.market) return clientBias;
    const list = picks || [];
    const merged = {
      at: serverBias.at || clientBias.at,
      market: serverBias.market,
      h001:
        serverBias.h001 && list.length ? serverBias.h001 : clientBias.h001,
      exchangeBreadth: clientBias.exchangeBreadth,
      narrowTape: serverBias.narrowTape ?? clientBias.narrowTape,
      conflict: false,
    };
    if (list.length && merged.h001) {
      merged.conflict =
        Math.sign(merged.market.score || 0) !== 0 &&
        Math.sign(merged.h001.score || 0) !== 0 &&
        Math.sign(merged.market.score) !== Math.sign(merged.h001.score);
    }
    return merged;
  }

  function resolveMorningBias(indices, picks, breadth, exchangeBreadth) {
    const client = computeMorningBias(indices, picks, breadth, exchangeBreadth);
    return mergeMorningBias(lastServerMorningBias, client, picks);
  }

  function logMorningBias(bias) {
    if (!bias?.market) return;
    try {
      const raw = localStorage.getItem(BIAS_LOG_KEY);
      const log = raw ? JSON.parse(raw) : [];
      const last = log[log.length - 1];
      const now = bias.at || Date.now();
      if (last && now - last.at < 120000) {
        if (
          last.marketPct === bias.market.pct &&
          last.h001Pct === (bias.h001?.pct ?? null)
        ) {
          return;
        }
      }
      log.push({
        at: now,
        marketPct: bias.market.pct,
        marketLabel: bias.market.label,
        marketConf: bias.market.confidence,
        h001Pct: bias.h001?.pct ?? null,
        h001Label: bias.h001?.label ?? null,
        h001Conf: bias.h001?.confidence ?? null,
        exchangeAdvPct: bias.exchangeBreadth?.advPct ?? null,
        exchangeDecPct: bias.exchangeBreadth?.decPct ?? null,
        conflict: !!bias.conflict,
      });
      while (log.length > BIAS_LOG_MAX) log.shift();
      localStorage.setItem(BIAS_LOG_KEY, JSON.stringify(log));
    } catch {
      /* ignore */
    }
  }

  function loadBiasLog() {
    try {
      const raw = localStorage.getItem(BIAS_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function normalizeBiasLogEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    const at = raw.at ?? raw.loggedAt;
    if (at == null || !Number.isFinite(Number(at))) return null;
    return {
      at: Number(at),
      marketPct: raw.marketPct ?? null,
      marketLabel: raw.marketLabel ?? null,
      marketConf: raw.marketConf ?? null,
      h001Pct: raw.h001Pct ?? null,
      h001Label: raw.h001Label ?? null,
      h001Conf: raw.h001Conf ?? null,
      exchangeAdvPct: raw.exchangeAdvPct ?? null,
      exchangeDecPct: raw.exchangeDecPct ?? null,
      conflict: !!raw.conflict,
    };
  }

  function parseBiasLogPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload?.entries && Array.isArray(payload.entries)) return payload.entries;
    throw new Error("Invalid bias log JSON (expected { entries: [...] }).");
  }

  function mergeBiasLogEntries(existing, incoming) {
    const map = new Map();
    for (const e of existing || []) {
      const n = normalizeBiasLogEntry(e);
      if (n) map.set(n.at, n);
    }
    let added = 0;
    for (const e of incoming || []) {
      const n = normalizeBiasLogEntry(e);
      if (!n) continue;
      if (!map.has(n.at)) added++;
      map.set(n.at, n);
    }
    let log = [...map.values()].sort((a, b) => a.at - b.at);
    if (log.length > BIAS_LOG_MAX) log = log.slice(-BIAS_LOG_MAX);
    return { log, added };
  }

  function saveBiasLog(log) {
    localStorage.setItem(BIAS_LOG_KEY, JSON.stringify(log || []));
  }

  function updateBiasCalToggleLabel(root) {
    const btn = root?.querySelector("#fvBiasCalToggle");
    if (!btn) return;
    btn.textContent = "Learning details";
    btn.setAttribute("aria-label", loadBiasLog().length + " mornings in bias log");
  }

  function importBiasLogPayload(payload) {
    const incoming = parseBiasLogPayload(payload);
    const { log, added } = mergeBiasLogEntries(loadBiasLog(), incoming);
    saveBiasLog(log);
    engineAccuracyCache = null;
    return { added, total: log.length };
  }

  async function fetchBiasLogApi(limit) {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const lim = limit != null ? limit : BIAS_LOG_MAX;
      const res = await fetch(base + "/pulse/bias-log?limit=" + lim, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function pullBiasLogFromApi() {
    const data = await fetchBiasLogApi(BIAS_LOG_MAX);
    if (!data?.entries?.length) {
      return { added: 0, total: loadBiasLog().length };
    }
    const { log, added } = mergeBiasLogEntries(loadBiasLog(), data.entries);
    saveBiasLog(log);
    return { added, total: log.length };
  }

  function etDateKey(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }

  function sessionBiasLog(log) {
    const byDay = new Map();
    for (const e of log || []) {
      if (!e?.at) continue;
      const key = etDateKey(e.at);
      if (!byDay.has(key)) byDay.set(key, e);
    }
    return [...byDay.values()].sort((a, b) => a.at - b.at);
  }

  async function fetchSpyDailyChanges() {
    if (typeof RMYahooFetch === "undefined" || !RMYahooFetch.fetchChartBars) return null;
    const payload = await RMYahooFetch.fetchChartBars("SPY", "1d", "1y");
    const bars = payload?.bars || (Array.isArray(payload) ? payload : null);
    if (!bars?.length) return null;
    const spyByDate = {};
    const tradingDays = [];
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1].close;
      const cur = bars[i].close;
      if (!prev || !cur) continue;
      const key = etDateKey(bars[i].t);
      spyByDate[key] = Math.round(((cur - prev) / prev) * 1000) / 10;
      if (!tradingDays.includes(key)) tradingDays.push(key);
    }
    return { spyByDate, tradingDays };
  }

  function nextTradingDay(day, tradingDays) {
    const idx = tradingDays.indexOf(day);
    if (idx < 0 || idx >= tradingDays.length - 1) return null;
    return tradingDays[idx + 1];
  }

  function biasLeanSign(pct) {
    if (pct == null || Number.isNaN(Number(pct))) return 0;
    if (pct >= 58) return 1;
    if (pct <= 42) return -1;
    return 0;
  }

  // horizon "next" (default) grades the lean vs the next trading day's SPY move;
  // "same" grades it vs that same session's SPY move (was the morning read right today?).
  // opts.confVal + opts.confField filter to a confidence tier (e.g. only "high" reads).
  function directionalHitRate(sessions, pctKey, spyByDate, tradingDays, opts) {
    const horizon = opts?.horizon === "same" ? "same" : "next";
    const confVal = opts?.confVal || null;
    const confField = opts?.confField || "marketConf";
    let hits = 0;
    let n = 0;
    for (const e of sessions) {
      if (confVal && (e[confField] || "low") !== confVal) continue;
      const day = etDateKey(e.at);
      const target = horizon === "same" ? day : nextTradingDay(day, tradingDays);
      if (!target) continue;
      const spyChg = spyByDate[target];
      if (spyChg == null) continue;
      const lean = biasLeanSign(e[pctKey]);
      if (!lean) continue;
      n++;
      if ((lean > 0 && spyChg > 0) || (lean < 0 && spyChg < 0)) hits++;
    }
    return { hits, n, rate: n ? Math.round((hits / n) * 100) : null };
  }

  function pearsonCorrelation(xs, ys) {
    if (!xs?.length || xs.length !== ys.length || xs.length < 3) return null;
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    if (!denX || !denY) return null;
    return Math.round((num / Math.sqrt(denX * denY)) * 1000) / 1000;
  }

  function correlationTrack(sessions, pctKey, spyByDate, tradingDays) {
    const xs = [];
    const ys = [];
    for (const e of sessions) {
      if (e[pctKey] == null) continue;
      const day = etDateKey(e.at);
      const nxt = nextTradingDay(day, tradingDays);
      if (!nxt) continue;
      const spyChg = spyByDate[nxt];
      if (spyChg == null) continue;
      xs.push(Number(e[pctKey]) - 50);
      ys.push(spyChg);
    }
    return pearsonCorrelation(xs, ys);
  }

  /* Compact engine-verdict snapshot to durably stamp onto an opened trade, so
     "what did the engine say when I entered?" survives even if the bias log is
     cleared or re-synced. */
  function biasSnapshot(bias) {
    if (!bias?.market) return null;
    const pct = bias.market.pct;
    return {
      lean: biasLeanSign(pct),
      marketPct: pct ?? null,
      marketLabel: bias.market.label ?? null,
      marketConf: bias.market.confidence ?? null,
      h001Pct: bias.h001?.pct ?? null,
      at: bias.at || Date.now(),
    };
  }

  function currentBiasSnapshot() {
    return biasSnapshot(lastMorningBias);
  }

  function loadClosedTrades() {
    try {
      const key = "rainmaker_ytd_" + new Date().getFullYear();
      const arr = JSON.parse(localStorage.getItem(key) || "[]");
      if (!Array.isArray(arr)) return [];
      return arr.filter((t) => t && t.status === "closed" && t.filled !== false);
    } catch {
      return [];
    }
  }

  function tradeWin(t) {
    const entry = t.entry_price ?? t.entry_premium;
    const exit = t.exit_price;
    if (entry == null || exit == null) return null;
    return exit > entry;
  }

  function tradeR(t) {
    if (typeof RMTradeMetrics !== "undefined" && RMTradeMetrics.rMultiple) {
      const r = RMTradeMetrics.rMultiple(t);
      return r != null && Number.isFinite(r) ? r : null;
    }
    return t.r_multiple != null && Number.isFinite(t.r_multiple) ? t.r_multiple : null;
  }

  /* Join closed trades to the engine's morning call (stamp first, else by ET day)
     so we can answer "when the engine said bull, did MY trades work?" */
  function biasOutcomeJoin(sessions) {
    const sess = sessions || sessionBiasLog(loadBiasLog());
    const leanByDay = new Map();
    for (const e of sess) leanByDay.set(etDateKey(e.at), biasLeanSign(e.marketPct));
    const trades = loadClosedTrades();
    const mk = () => ({ trades: 0, wins: 0, winN: 0, rSum: 0, rN: 0 });
    const buckets = { bull: mk(), bear: mk(), neutral: mk() };
    let matched = 0;
    for (const t of trades) {
      let lean = null;
      if (t.engine_bias && typeof t.engine_bias.lean === "number") {
        lean = t.engine_bias.lean;
      } else {
        const ts = Date.parse(t.opened_at || t.closed_at || "");
        if (!Number.isFinite(ts)) continue;
        const day = etDateKey(ts);
        if (!leanByDay.has(day)) continue;
        lean = leanByDay.get(day);
      }
      if (lean == null) continue;
      const b = lean > 0 ? buckets.bull : lean < 0 ? buckets.bear : buckets.neutral;
      b.trades++;
      matched++;
      const win = tradeWin(t);
      if (win != null) {
        b.winN++;
        if (win) b.wins++;
      }
      const r = tradeR(t);
      if (r != null) {
        b.rN++;
        b.rSum += r;
      }
    }
    const fmt = (b) => ({
      trades: b.trades,
      winPct: b.winN ? Math.round((b.wins / b.winN) * 100) : null,
      avgR: b.rN ? Math.round((b.rSum / b.rN) * 100) / 100 : null,
    });
    return {
      matched,
      bull: fmt(buckets.bull),
      bear: fmt(buckets.bear),
      neutral: fmt(buckets.neutral),
    };
  }

  async function computeBiasCalibrationLocal(log) {
    const entries = log || loadBiasLog();
    const sessions = sessionBiasLog(entries);
    if (!sessions.length) {
      return {
        days: 0,
        entries: entries.length,
        recentRows: [],
        tradeOutcomes: biasOutcomeJoin(sessions),
      };
    }
    const spy = await fetchSpyDailyChanges();
    if (!spy) {
      throw new Error("Could not load SPY history for calibration.");
    }
    const { spyByDate, tradingDays } = spy;
    const marketNext = directionalHitRate(
      sessions,
      "marketPct",
      spyByDate,
      tradingDays
    );
    const marketSame = directionalHitRate(sessions, "marketPct", spyByDate, tradingDays, {
      horizon: "same",
    });
    const h001Next = directionalHitRate(
      sessions,
      "h001Pct",
      spyByDate,
      tradingDays
    );
    const tierBreakdown = ["high", "med", "low"]
      .map((tier) => {
        const same = directionalHitRate(sessions, "marketPct", spyByDate, tradingDays, {
          horizon: "same",
          confVal: tier,
        });
        const next = directionalHitRate(sessions, "marketPct", spyByDate, tradingDays, {
          horizon: "next",
          confVal: tier,
        });
        return {
          tier,
          sameHit: same.rate,
          sameN: same.n,
          nextHit: next.rate,
          nextN: next.n,
        };
      })
      .filter((row) => row.sameN > 0 || row.nextN > 0);
    const bullNext = [];
    const bearNext = [];
    for (const e of sessions) {
      const lean = biasLeanSign(e.marketPct);
      const nxt = nextTradingDay(etDateKey(e.at), tradingDays);
      if (!nxt) continue;
      const spyChg = spyByDate[nxt];
      if (spyChg == null) continue;
      if (lean > 0) bullNext.push(spyChg);
      else if (lean < 0) bearNext.push(spyChg);
    }
    const recentRows = sessions.slice(-8).map((e) => {
      const day = etDateKey(e.at);
      const nxt = nextTradingDay(day, tradingDays);
      return {
        date: day,
        marketPct: e.marketPct,
        h001Pct: e.h001Pct,
        nextSpyPct: nxt ? spyByDate[nxt] : null,
      };
    });
    return {
      days: sessions.length,
      entries: entries.length,
      marketNextHit: marketNext.rate,
      marketNextN: marketNext.n,
      marketSameHit: marketSame.rate,
      marketSameN: marketSame.n,
      h001NextHit: h001Next.rate,
      h001NextN: h001Next.n,
      tierBreakdown,
      tradeOutcomes: biasOutcomeJoin(sessions),
      marketCorr: correlationTrack(sessions, "marketPct", spyByDate, tradingDays),
      h001Corr: correlationTrack(sessions, "h001Pct", spyByDate, tradingDays),
      avgNextSpyWhenBull: bullNext.length
        ? Math.round((bullNext.reduce((a, b) => a + b, 0) / bullNext.length) * 100) / 100
        : null,
      avgNextSpyWhenBear: bearNext.length
        ? Math.round((bearNext.reduce((a, b) => a + b, 0) / bearNext.length) * 100) / 100
        : null,
      recentRows,
    };
  }

  async function fetchBiasCalibrationApi() {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(base + "/pulse/bias-log/calibration", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function exportBiasLogJson() {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      entries: loadBiasLog(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      "rainmaker-bias-log-" + etDateKey(Date.now()) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function syncBiasLogApi() {
    const base = getRainmakerApiBase();
    if (!base) throw new Error("Set rainmaker_api_base or run rm_api locally.");
    const entries = loadBiasLog();
    let upload = null;
    if (entries.length) {
      const res = await fetch(base + "/pulse/bias-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries, clientId: "morning_app" }),
      });
      if (!res.ok) throw new Error("Sync failed (" + res.status + ").");
      upload = await res.json();
    }
    const pull = await pullBiasLogFromApi();
    if (!upload && !pull.total) {
      throw new Error("Nothing to upload and API log is empty.");
    }
    return {
      inserted: upload?.inserted ?? 0,
      updated: upload?.updated ?? 0,
      received: upload?.received ?? 0,
      pulled: pull.added,
      total: pull.total,
    };
  }

  function clearBiasLog() {
    localStorage.removeItem(BIAS_LOG_KEY);
    engineAccuracyCache = null;
  }

  function fmtCalRate(rate, n) {
    if (rate == null || !n) return "—";
    return rate + "% (" + n + "d)";
  }

  function renderBiasCalibrationActionsHtml() {
    return (
      '<div class="fv-bias-cal-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-export>Export JSON</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-import>Import JSON</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-sync>Sync API</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-bias-clear>Clear log</button>' +
      "</div>"
    );
  }

  function fmtOutcome(o) {
    if (!o || !o.trades) return "—";
    const parts = [];
    if (o.avgR != null) parts.push((o.avgR >= 0 ? "+" : "") + o.avgR.toFixed(2) + "R");
    if (o.winPct != null) parts.push(o.winPct + "% win");
    parts.push(o.trades + (o.trades === 1 ? " trade" : " trades"));
    return parts.join(" · ");
  }

  function renderBiasOutcomesHtml(outcomes) {
    if (!outcomes) return "";
    const rowsDef = [
      ["Engine bull days", outcomes.bull],
      ["Engine bear days", outcomes.bear],
      ["Engine neutral days", outcomes.neutral],
    ].filter(([, o]) => o && o.trades > 0);
    if (!rowsDef.length) {
      return (
        '<p class="fv-bias-cal-note fv-bias-outcomes-empty">Close a few trades to see how your fills did under each engine call.</p>'
      );
    }
    return (
      '<div class="fv-bias-outcomes">' +
      '<p class="fv-bias-cal-title">Your trades by engine call</p>' +
      rowsDef
        .map(
          ([label, o]) =>
            '<div class="fv-bias-outcome-row"><span class="fv-bias-outcome-k">' +
            escapeHtml(label) +
            '</span><strong class="' +
            (o.avgR != null ? (o.avgR >= 0 ? "is-pos" : "is-neg") : "") +
            '">' +
            escapeHtml(fmtOutcome(o)) +
            "</strong></div>"
        )
        .join("") +
      "</div>"
    );
  }

  function renderBiasCalibrationPanel(stats, state) {
    if (state?.loading) {
      return (
        '<div class="fv-bias-cal fv-bias-cal--loading">' +
        "Loading SPY history…" +
        '<p class="fv-bias-cal-note">Use Import JSON to merge a file from another device.</p>' +
        renderBiasCalibrationActionsHtml() +
        "</div>"
      );
    }
    if (state?.error) {
      return (
        '<div class="fv-bias-cal fv-bias-cal--err">' +
        escapeHtml(state.error) +
        '<p class="fv-bias-cal-note">You can still import an exported bias log below.</p>' +
        renderBiasCalibrationActionsHtml() +
        "</div>"
      );
    }
    const s = stats || {};
    const rows = (s.recentRows || [])
      .map(
        (r) =>
          "<tr><td>" +
          escapeHtml(r.date) +
          "</td><td>" +
          (r.marketPct ?? "—") +
          "</td><td>" +
          (r.h001Pct ?? "—") +
          "</td><td>" +
          (r.nextSpyPct != null ? fmtPct(r.nextSpyPct) : "—") +
          "</td></tr>"
      )
      .join("");
    return (
      '<div class="fv-bias-cal">' +
      '<p class="fv-bias-cal-title">Calibration · ' +
      (s.days || 0) +
      " sessions · " +
      (s.entries || 0) +
      " samples</p>" +
      '<div class="fv-bias-cal-grid">' +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Market → same SPY</span><strong>' +
      escapeHtml(fmtCalRate(s.marketSameHit, s.marketSameN)) +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Market → next SPY</span><strong>' +
      escapeHtml(fmtCalRate(s.marketNextHit, s.marketNextN)) +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">H-001 → next SPY</span><strong>' +
      escapeHtml(fmtCalRate(s.h001NextHit, s.h001NextN)) +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Market ρ</span><strong>' +
      escapeHtml(s.marketCorr != null ? String(s.marketCorr) : "—") +
      "</strong></div>" +
      '<div class="fv-bias-cal-stat"><span class="fv-bias-cal-k">Avg next SPY</span><strong>' +
      escapeHtml(
        (s.avgNextSpyWhenBull != null ? "bull " + fmtPct(s.avgNextSpyWhenBull) : "—") +
          (s.avgNextSpyWhenBear != null ? " · bear " + fmtPct(s.avgNextSpyWhenBear) : "")
      ) +
      "</strong></div></div>" +
      (s.tierBreakdown && s.tierBreakdown.length
        ? '<table class="fv-bias-cal-table fv-bias-cal-tiers"><thead><tr><th>Conf</th><th>Same-day</th><th>Next-day</th></tr></thead><tbody>' +
          s.tierBreakdown
            .map(
              (t) =>
                "<tr><td>" +
                escapeHtml(String(t.tier || "").toUpperCase()) +
                "</td><td>" +
                escapeHtml(fmtCalRate(t.sameHit, t.sameN)) +
                "</td><td>" +
                escapeHtml(fmtCalRate(t.nextHit, t.nextN)) +
                "</td></tr>"
            )
            .join("") +
          "</tbody></table>"
        : "") +
      renderBiasOutcomesHtml(s.tradeOutcomes) +
      (rows
        ? '<table class="fv-bias-cal-table"><thead><tr><th>Date</th><th>Mkt</th><th>H-001</th><th>Next SPY</th></tr></thead><tbody>' +
          rows +
          "</tbody></table>"
        : '<p class="fv-bias-cal-note">Log a few morning sessions to build calibration stats.</p>') +
      renderBiasCalibrationActionsHtml() +
      "</div>"
    );
  }

  async function refreshBiasCalibrationPanel(wrap) {
    if (!wrap) return;
    wrap.classList.remove("hidden");
    wrap.innerHTML = renderBiasCalibrationPanel(null, { loading: true });
    const root = wrap.closest(".fv-market") || wrap.parentElement;
    try {
      if (getRainmakerApiBase()) {
        await pullBiasLogFromApi();
        updateBiasCalToggleLabel(root);
      }
      let stats = await fetchBiasCalibrationApi();
      if (!stats || !stats.days) {
        stats = await computeBiasCalibrationLocal();
      }
      wrap.innerHTML = renderBiasCalibrationPanel(stats, null);
    } catch (e) {
      wrap.innerHTML = renderBiasCalibrationPanel(null, {
        error: e?.message || "Calibration failed",
      });
    }
    bindBiasCalibrationActions(root);
  }

  function ensureBiasLogImportInput(root) {
    if (!root) return null;
    let inp = root.querySelector("#fvBiasLogImportInput");
    if (inp) return inp;
    inp = document.createElement("input");
    inp.type = "file";
    inp.id = "fvBiasLogImportInput";
    inp.accept = "application/json,.json";
    inp.hidden = true;
    inp.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      inp.value = "";
      if (!file) return;
      const host = inp.closest(".fv-market");
      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const result = importBiasLogPayload(payload);
        updateBiasCalToggleLabel(host);
        const wrap = host?.querySelector("#fvBiasCalWrap");
        if (wrap && !wrap.classList.contains("hidden")) {
          await refreshBiasCalibrationPanel(wrap);
        }
        alert(
          "Imported " +
            result.added +
            " new · " +
            result.total +
            " total in this browser"
        );
      } catch (err) {
        alert(err?.message || "Import failed");
      }
    });
    root.appendChild(inp);
    return inp;
  }

  function bindBiasCalibrationActions(root) {
    if (!root) return;
    ensureBiasLogImportInput(root);
    if (root.dataset.biasCalActionsBound === "1") return;
    root.dataset.biasCalActionsBound = "1";
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-bias-export]")) {
        e.preventDefault();
        exportBiasLogJson();
        return;
      }
      if (e.target.closest("[data-bias-import]")) {
        e.preventDefault();
        ensureBiasLogImportInput(root)?.click();
        return;
      }
      if (e.target.closest("[data-bias-clear]")) {
        e.preventDefault();
        if (!confirm("Clear local bias log?")) return;
        clearBiasLog();
        updateBiasCalToggleLabel(root);
        const wrap = root.querySelector("#fvBiasCalWrap");
        if (wrap) {
          wrap.innerHTML = renderBiasCalibrationPanel(
            { days: 0, entries: 0, recentRows: [] },
            null
          );
        }
        return;
      }
      const syncBtn = e.target.closest("[data-bias-sync]");
      if (!syncBtn || syncBtn.disabled) return;
      e.preventDefault();
      void (async () => {
        syncBtn.disabled = true;
        try {
          const result = await syncBiasLogApi();
          updateBiasCalToggleLabel(root);
          syncBtn.textContent = "Synced " + (result.total ?? "");
          const wrap = root.querySelector("#fvBiasCalWrap");
          if (wrap) await refreshBiasCalibrationPanel(wrap);
        } catch (err) {
          alert(err?.message || "Sync failed");
          syncBtn.textContent = "Sync API";
        } finally {
          syncBtn.disabled = false;
        }
      })();
    });
  }

  /* ---- Always-visible engine trust line (Phase 1) ----
     Surfaces the morning-bias→next-day-SPY hit rate (already computed for the
     calibration panel) as a headline trust stat, with an honest low-sample guard.
     Cached so it never re-hammers the SPY history fetch. */
  const ENGINE_TRUST_MIN_SESSIONS = 5;
  const ENGINE_ACCURACY_TTL_MS = 30 * 60 * 1000;
  let engineAccuracyCache = null;
  let engineAccuracyInflight = null;

  function summarizeEngineAccuracy(stats) {
    const sessions = stats?.days || 0;
    const hit = stats?.marketNextHit;
    const samples = stats?.marketNextN || 0;
    const ready = hit != null && samples >= ENGINE_TRUST_MIN_SESSIONS;
    return {
      ready,
      sessions,
      samples,
      minSessions: ENGINE_TRUST_MIN_SESSIONS,
      hitRate: hit != null ? Number(hit) : null,
      corr: stats?.marketCorr ?? null,
    };
  }

  async function getEngineAccuracy(opts) {
    if (
      !opts?.force &&
      engineAccuracyCache &&
      Date.now() - engineAccuracyCache.at < ENGINE_ACCURACY_TTL_MS
    ) {
      return engineAccuracyCache.summary;
    }
    if (engineAccuracyInflight) return engineAccuracyInflight;
    engineAccuracyInflight = (async () => {
      let stats = null;
      try {
        stats = await fetchBiasCalibrationApi();
        if (!stats || !stats.days) stats = await computeBiasCalibrationLocal();
      } catch (_) {
        stats = null;
      }
      const summary = summarizeEngineAccuracy(stats);
      engineAccuracyCache = { at: Date.now(), summary };
      engineAccuracyInflight = null;
      return summary;
    })();
    return engineAccuracyInflight;
  }

  function engineTrustView(summary) {
    if (!summary || !summary.ready) {
      const have = summary?.samples || 0;
      const need = summary?.minSessions || ENGINE_TRUST_MIN_SESSIONS;
      return {
        cls: "is-building",
        text: "Morning read: " + have + " of " + need + " days logged — keep showing up",
        expandLabel: "How RainMaker is learning",
      };
    }
    const rate = summary.hitRate;
    const cls = rate >= 60 ? "is-strong" : rate >= 50 ? "is-fair" : "is-weak";
    const sess = summary.samples;
    return {
      cls,
      text:
        "Morning read: " +
        rate +
        "% direction match · " +
        sess +
        " day" +
        (sess === 1 ? "" : "s"),
      expandLabel: "How RainMaker is learning",
    };
  }

  async function refreshEngineTrustLine(root) {
    const el = (root || document).querySelector("#fvEngineTrust");
    if (!el) return;
    let summary;
    try {
      summary = await getEngineAccuracy();
    } catch (_) {
      summary = null;
    }
    const view = engineTrustView(summary);
    el.classList.remove("is-building", "is-strong", "is-fair", "is-weak");
    el.classList.add(view.cls);
    const txt = el.querySelector(".fv-engine-trust-text");
    if (txt) txt.textContent = view.text;
    el.dataset.fvStat = view.text;
  }

  function bindBiasCalibration(root) {
    void refreshEngineTrustLine(root);
    const toggle = root?.querySelector("#fvBiasCalToggle");
    const wrap = root?.querySelector("#fvBiasCalWrap");
    if (!toggle || !wrap || toggle.dataset.bound) return;
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", async () => {
      if (wrap.classList.contains("hidden")) {
        await refreshBiasCalibrationPanel(wrap);
        /* recompute the headline after a manual refresh / import */
        void refreshEngineTrustLine(root);
      } else {
        wrap.classList.add("hidden");
      }
    });
    bindBiasCalibrationActions(root);
  }

  function biasMarketSentimentClass(market) {
    if (!market) return "fv-sentiment-neutral";
    if (market.pct >= 58) return "fv-sentiment-bull";
    if (market.pct <= 42) return "fv-sentiment-bear";
    return "fv-sentiment-neutral";
  }

  function biasToneClass(pct) {
    if (pct >= 58) return "fv-bias--bull";
    if (pct <= 42) return "fv-bias--bear";
    return "fv-bias--neutral";
  }

  function renderBiasMeter(pct) {
    const p = Math.max(0, Math.min(100, pct ?? 50));
    return (
      '<div class="fv-bias-meter" aria-hidden="true">' +
      '<div class="fv-bias-meter-mid"></div>' +
      '<div class="fv-bias-meter-fill ' +
      biasToneClass(pct) +
      '" style="width:' +
      p +
      '%"></div></div>'
    );
  }

  function renderBiasTrack(kicker, track, emptyNote, opts) {
    const options = opts || {};
    if (!track || (track.pct == null && !track.label)) {
      return (
        '<div class="fv-bias-row fv-bias-row--empty">' +
        '<span class="fv-bias-kicker">' +
        escapeHtml(kicker) +
        "</span>" +
        '<span class="fv-bias-note">' +
        escapeHtml(emptyNote || "Waiting for quotes…") +
        "</span></div>"
      );
    }
    const conf = track.confidence || "low";
    return (
      '<div class="fv-bias-row">' +
      '<span class="fv-bias-kicker">' +
      escapeHtml(kicker) +
      "</span>" +
      '<span class="fv-bias-label ' +
      biasToneClass(track.pct) +
      '">' +
      escapeHtml(track.label) +
      "</span>" +
      '<span class="fv-bias-pct">' +
      track.pct +
      "</span>" +
      '<span class="fv-bias-conf fv-bias-conf--' +
      conf +
      '">' +
      escapeHtml(conf) +
      " conf</span>" +
      (options.settingsSlot || "") +
      renderBiasMeter(track.pct) +
      "</div>"
    );
  }

  function renderBiasMiniLead(kicker, track, emptyNote) {
    if (!track || (track.pct == null && !track.label)) {
      return (
        '<div class="fv-bias-mini-row fv-bias-mini-row--empty">' +
        '<span class="fv-bias-mini-k">' +
        escapeHtml(kicker) +
        "</span>" +
        '<span class="fv-bias-mini-note">' +
        escapeHtml(emptyNote || "…") +
        "</span></div>"
      );
    }
    return (
      '<div class="fv-bias-mini-row">' +
      '<span class="fv-bias-mini-k">' +
      escapeHtml(kicker) +
      "</span>" +
      '<span class="fv-bias-mini-label ' +
      biasToneClass(track.pct) +
      '">' +
      escapeHtml(track.label) +
      "</span>" +
      '<span class="fv-bias-mini-pct">' +
      track.pct +
      "</span></div>"
    );
  }

  function renderBiasMiniTail(track) {
    if (!track || track.pct == null) return "";
    return '<div class="fv-bias-mini-meter-wrap">' + renderBiasMeter(track.pct) + "</div>";
  }

  function renderMorningBiasMini(bias, picks) {
    if (!bias) return { copy: "", tail: "" };
    const hasPicks = (picks || []).length > 0;
    return {
      copy:
        '<div class="fv-bias-mini fv-bias-mini--copy">' +
        renderBiasMiniLead("Market", bias.market, "…") +
        (hasPicks ? renderBiasMiniLead("H-001", bias.h001, "—") : "") +
        "</div>",
      tail:
        '<div class="fv-bias-mini fv-bias-mini--tail">' +
        renderBiasMiniTail(bias.market) +
        (hasPicks ? renderBiasMiniTail(bias.h001) : "") +
        "</div>",
    };
  }

  function syncMorningBiasMini(bias, picks) {
    const slot = document.getElementById("fvBiasMini");
    const tail = document.getElementById("fvBiasMiniTail");
    if (!slot) return;
    const cfg = loadSettings();
    if (cfg.showMorningBias === false || !bias) {
      slot.innerHTML = "";
      slot.hidden = true;
      slot.setAttribute("aria-hidden", "true");
      if (tail) {
        tail.innerHTML = "";
        tail.hidden = true;
        tail.setAttribute("aria-hidden", "true");
      }
      return;
    }
    const mini = renderMorningBiasMini(bias, picks);
    slot.innerHTML = mini.copy;
    slot.hidden = false;
    slot.removeAttribute("aria-hidden");
    if (tail) {
      tail.innerHTML = mini.tail;
      tail.hidden = !mini.tail;
      if (mini.tail) tail.removeAttribute("aria-hidden");
      else tail.setAttribute("aria-hidden", "true");
    }
    if (slot.dataset.bound !== "1") {
      slot.dataset.bound = "1";
      const onMiniActivate = (e) => {
        e.stopPropagation();
        if (typeof global.RMWorkspaceAccordion !== "undefined") {
          global.RMWorkspaceAccordion.expand("market");
        }
      };
      slot.addEventListener("click", onMiniActivate);
      tail?.addEventListener("click", onMiniActivate);
    }
  }

  function renderMorningBias(bias, picks) {
    if (!bias) return "";
    const hasPicks = (picks || []).length > 0;
    const marketDrivers = (bias.market?.drivers || []).join(" · ") || "Index quotes loading";
    const h001Drivers = (bias.h001?.drivers || []).join(" · ") || "Import scan for setup read";
    const desc =
      "Weighted tape read (futures, SPY/QQQ/IWM, VIX). H-001 setup uses your scan vs SPY, breadth, and gap fades. Not a prediction — setup quality for gap-and-go.";
    const conflictNote = bias.conflict
      ? " Market and scan disagree — treat confidence as low."
      : "";
    const logN = loadBiasLog().length;
    return (
      '<div class="fv-bias-wrap fv-tip-target" tabindex="0" data-fv-kicker="Morning bias" data-fv-title="Market vs H-001 setup" data-fv-desc="' +
      escapeAttr(desc + conflictNote) +
      '" data-fv-stat="' +
      escapeAttr(
        "Market " +
          (bias.market?.pct ?? "—") +
          " · H-001 " +
          (hasPicks ? bias.h001?.pct ?? "—" : "—")
      ) +
      '">' +
      renderBiasTrack("Market", bias.market, "Need index/futures quotes", {
        settingsSlot:
          '<span class="fv-market-settings-slot" id="fvMarketSettingsSlot"></span>',
      }) +
      (hasPicks
        ? renderBiasTrack("H-001 setup", bias.h001, "Load a scan")
        : "") +
      (hasPicks
        ? '<p class="fv-bias-drivers fv-bias-drivers--h001">' +
          escapeHtml(h001Drivers) +
          "</p>"
        : "") +
      '<p class="fv-bias-drivers">' +
      escapeHtml(marketDrivers) +
      (bias.conflict ? " · ⚠ market vs scan conflict" : "") +
      "</p>" +
      '<div class="fv-engine-trust is-building fv-tip-target" id="fvEngineTrust" tabindex="0"' +
      ' data-fv-kicker="Platform trust" data-fv-title="How RainMaker learns"' +
      ' data-fv-desc="Tracks whether your morning market read matched the next session\'s SPY direction. Expand for Atlas edge and validation payoff."' +
      ' data-fv-stat="Building">' +
      '<span class="fv-engine-trust-dot" aria-hidden="true"></span>' +
      '<span class="fv-engine-trust-text">Morning read: building…</span>' +
      "</div>" +
      '<button type="button" class="fv-bias-cal-toggle btn btn-ghost btn-sm" id="fvBiasCalToggle">Learning details</button>' +
      '<div class="fv-bias-cal-wrap hidden" id="fvBiasCalWrap"></div></div>'
    );
  }

  function renderPulseContext() {
    if (typeof RMMarketThemes === "undefined" || !RMMarketThemes.getLastContext) return "";
    const ctx = RMMarketThemes.getLastContext();
    if (!ctx) return "";
    const parts = [];
    if (ctx.scanNamesInNews > 0) {
      parts.push(ctx.scanNamesInNews + " scan names in headlines");
    }
    if (ctx.leadingTheme) parts.push(ctx.leadingTheme + " leading");
    if (ctx.themeAligned > 0) {
      parts.push(ctx.themeAligned + " pick" + (ctx.themeAligned === 1 ? "" : "s") + " theme-aligned");
    }
    if (!parts.length) return "";
    return (
      '<p class="fv-pulse-context fv-tip-target" tabindex="0" data-fv-kicker="Scan context" data-fv-title="Headlines vs scan" data-fv-desc="Cross-check from multi-source RSS (' +
      escapeAttr(ctx.sources || "CNBC · MarketWatch") +
      '). Scan names = tickers from your list mentioned in today\'s headlines." data-fv-stat="' +
      escapeAttr(parts.join(" · ")) +
      '">' +
      escapeHtml(parts.join(" · ")) +
      "</p>"
    );
  }

  function fmtPulseTime(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }

  function getRainmakerApiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) {
        return meta.content.trim().replace(/\/$/, "");
      }
      const stored = localStorage.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch {
      /* ignore */
    }
    const h = location.hostname;
    if (h === "localhost" || h === "127.0.0.1") {
      return "http://127.0.0.1:8765";
    }
    return "";
  }

  async function fetchPulseSnapshot(pickSymbols, opts) {
    const base = getRainmakerApiBase();
    if (!base) return null;
    const pickRows = opts?.picks || [];
    const syms = [
      ...new Set(
        [...(pickSymbols || []), ...pickRows.map((p) => p.symbol)]
          .map((s) => String(s).toUpperCase())
          .filter(Boolean)
      ),
    ];
    const url = base + "/pulse/snapshot";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      let res;
      if (pickRows.length) {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: ctrl.signal,
          body: JSON.stringify({
            symbols: syms,
            picks: pickRows.map((p) => ({
              symbol: p.symbol,
              gap_pct: p.gap_pct != null ? Number(p.gap_pct) : null,
              pct_change: p.pct_change != null ? Number(p.pct_change) : null,
            })),
            futures: opts?.futures !== false,
          }),
        });
      } else {
        const params = new URLSearchParams();
        if (syms.length) params.set("symbols", syms.join(","));
        if (opts?.futures === false) params.set("futures", "0");
        const qs = params.toString();
        res = await fetch(url + (qs ? "?" + qs : ""), {
          cache: "no-store",
          signal: ctrl.signal,
        });
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function applySnapshotIndices(snapshot) {
    if (!snapshot) return false;
    const merged = { ...(snapshot.indices || {}), ...(snapshot.futures || {}) };
    if (!Object.keys(merged).length) return false;
    cachedIndices = { ...merged };
    cachedIndicesAt = Date.now();
    return true;
  }

  function applySnapshotPicks(picks, snapshot) {
    const list = picks || [];
    const pickQuotes = snapshot?.picks || {};
    if (!list.length) {
      return {
        at: snapshot?.asOf || null,
        ok: 0,
        fail: 0,
        stale: false,
        source: snapshot?.source || "rm_api",
      };
    }
    let ok = 0;
    let fail = 0;
    for (const p of list) {
      const q = pickQuotes[p.symbol] || pickQuotes[String(p.symbol).toUpperCase()];
      if (q && q.chg != null && !Number.isNaN(Number(q.chg))) {
        p.live_price = q.price != null ? Number(q.price) : null;
        p.live_pct = Math.round(Number(q.chg) * 100) / 100;
        p.live_at = q.at || snapshot.asOf || Date.now();
        p.live_session = q.session || "unknown";
        ok++;
      } else {
        fail++;
      }
    }
    const at = snapshot.asOf || Date.now();
    const freshN = list.filter(
      (p) => p.live_at != null && at - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ).length;
    return {
      at,
      ok,
      fail,
      stale: freshN < list.length,
      source: snapshot.source || "rm_api",
    };
  }

  async function refreshQuotesViaApi(picks, opts) {
    const list = picks || [];
    const snapshot = await fetchPulseSnapshot(
      list.map((p) => p.symbol),
      { futures: opts?.futures !== false, picks: list }
    );
    if (!snapshot) {
      lastServerMorningBias = null;
      return null;
    }
    applySnapshotIndices(snapshot);
    if (snapshot.exchangeBreadth) {
      cachedExchangeBreadth = snapshot.exchangeBreadth;
      cachedExchangeBreadthAt = Date.now();
    }
    if (snapshot.morningBias) {
      lastServerMorningBias = snapshot.morningBias;
    }
    const meta = applySnapshotPicks(list, snapshot);
    lastPulseQuoteMeta = meta;
    return { snapshot, meta };
  }

  function relAge(ms) {
    if (ms == null || !Number.isFinite(ms)) return null;
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    return Math.round(m / 60) + "h ago";
  }

  function fetchHealth() {
    if (typeof RMYahooFetch !== "undefined" && RMYahooFetch.getHealth) {
      return RMYahooFetch.getHealth();
    }
    return null;
  }

  function renderPulseMeta(picks, meta) {
    const list = picks || [];
    const health = fetchHealth();
    const rateLimited = !!health?.rateLimited;
    const degraded = !!health?.degraded;

    // No picks loaded: stay quiet unless the data source is visibly struggling,
    // so a reliability problem is never silently hidden.
    if (!list.length) {
      if (rateLimited || degraded) {
        const note = rateLimited
          ? "Data source rate-limited · retrying"
          : "Data source unreachable · showing cached";
        return (
          '<p class="fv-pulse-meta ' +
          (rateLimited ? "fv-pulse-meta--ratelimited" : "fv-pulse-meta--stale") +
          '">' +
          escapeHtml(note) +
          "</p>"
        );
      }
      return "";
    }

    const m = meta || lastPulseQuoteMeta || {};
    const at = m.at || null;
    const freshN = list.filter(
      (p) =>
        p.live_at != null && Date.now() - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ).length;
    const stale = m.stale || freshN < list.length || degraded;
    const age = relAge(at ? Date.now() - at : null);
    let text = stale
      ? "Quotes stale · last " +
        fmtPulseTime(at) +
        " PST" +
        (age ? " (" + age + ")" : "") +
        " · " +
        freshN +
        "/" +
        list.length +
        " live"
      : "As of " +
        fmtPulseTime(at) +
        " PST" +
        (age ? " (" + age + ")" : "") +
        " · " +
        freshN +
        "/" +
        list.length +
        " picks live";
    if (rateLimited) text += " · rate-limited, retrying";
    else if (degraded) text += " · source degraded";
    if (m.source === "rm_api") text += " · API";
    const cls = rateLimited
      ? "fv-pulse-meta--ratelimited"
      : stale
        ? "fv-pulse-meta--stale"
        : "";
    return (
      '<p class="fv-pulse-meta' +
      (cls ? " " + cls : "") +
      '">' +
      escapeHtml(text) +
      "</p>"
    );
  }

  async function fetchPickQuoteCached(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const hit = pickQuoteCache[sym];
    if (hit && hit.at && Date.now() - hit.at < PICK_QUOTE_CACHE_MS) {
      return hit.quote;
    }
    const q = await fetchYahooQuote(sym);
    if (q) {
      pickQuoteCache[sym] = { quote: q, at: Date.now() };
    }
    return q;
  }

  async function refreshPickQuotes(picks) {
    const list = picks || [];
    if (!list.length) {
      lastPulseQuoteMeta = { at: null, ok: 0, fail: 0, stale: true };
      return lastPulseQuoteMeta;
    }
    const viaApi = await refreshQuotesViaApi(list, { futures: false });
    if (viaApi?.meta) {
      return viaApi.meta;
    }
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < list.length; i += PICK_QUOTE_BATCH) {
      const batch = list.slice(i, i + PICK_QUOTE_BATCH);
      await Promise.all(
        batch.map(async (p) => {
          const q = await fetchPickQuoteCached(p.symbol);
          if (q && q.chg != null && !Number.isNaN(Number(q.chg))) {
            p.live_price = q.price != null ? Number(q.price) : null;
            p.live_pct = Math.round(Number(q.chg) * 100) / 100;
            p.live_at = q.at || Date.now();
            p.live_session = q.session || "unknown";
            ok++;
          } else {
            fail++;
          }
        })
      );
    }
    const at = Date.now();
    const freshN = list.filter(
      (p) => p.live_at != null && at - Number(p.live_at) < PICK_QUOTE_STALE_MS
    ).length;
    lastPulseQuoteMeta = {
      at,
      ok,
      fail,
      stale: freshN < list.length,
      source: "browser",
    };
    return lastPulseQuoteMeta;
  }

  function patchPickMap(container, picks, opts) {
    const pulse = findPulseContainers(container);
    const mapRoot = pulse.highlights || pulse.core;
    if (!mapRoot) return;
    const highlightSym = opts?.highlightSym ?? mapScanHighlightSym;
    const heatRe = /\bfv-(hot-up|hot-down|up|down|flat)\b/g;
    mapRoot.querySelectorAll(".fv-map-cell[data-symbol]").forEach((cell) => {
      const sym = cell.dataset.symbol;
      if (highlightSym != null) {
        cell.classList.toggle("fv-map-cell--scanning", sym === highlightSym);
      }
      if (!opts?.updateQuotes) return;
      const p = (picks || []).find((x) => x.symbol === sym);
      if (!p) return;
      const dayEl = cell.querySelector(".fv-map-day");
      if (dayEl) dayEl.textContent = fmtPct(effectiveDayPct(p));
      const gapEl = cell.querySelector(".fv-map-gap");
      if (gapEl && p.gap_pct != null) gapEl.textContent = fmtPct(p.gap_pct);
      const vsEl = cell.querySelector(".fv-map-vs");
      if (vsEl && opts?.indices) {
        const vs = pickVsSpy(p, getSpyDayPct(opts.indices));
        vsEl.textContent = vs != null ? fmtPct(vs) : "—";
        vsEl.className =
          "fv-map-vs" +
          (vs == null
            ? ""
            : vs > 0.05
              ? " fv-map-vs--up"
              : vs < -0.05
                ? " fv-map-vs--down"
                : "");
      }
      const nextHeat = pickHeatClass(p);
      let cls = cell.className.replace(heatRe, " ").replace(/\s+/g, " ").trim();
      if (!/\bfv-map-cell\b/.test(cls)) cls = "fv-map-cell fv-tip-target " + cls;
      cell.className = cls + " " + nextHeat + (isGapFade(p) ? " fv-map-cell--gap-fade" : "");
      cell.classList.toggle("fv-map-cell--gap-fade", isGapFade(p));
      if (highlightSym != null) {
        cell.classList.toggle("fv-map-cell--scanning", sym === highlightSym);
      }
    });
  }

  function scheduleRefreshMarketPanel(container, picks, opts) {
    mapScheduleArgs = { container, picks, opts: opts || {} };
    if (mapScheduleTimer) return;
    mapScheduleTimer = setTimeout(() => {
      mapScheduleTimer = null;
      const args = mapScheduleArgs;
      mapScheduleArgs = null;
      if (!args?.container) return;
      if (args.opts.mapPatchOnly) {
        patchPickMap(args.container, args.picks, args.opts);
        return;
      }
      refreshMarketPanel(args.container, args.picks, args.opts).catch(() => {});
    }, MAP_REFRESH_MS);
  }

  function setMapScanHighlight(sym) {
    mapScanHighlightSym = sym || null;
  }

  function startLivePickRefresh(container, getPicks, intervalMs) {
    stopLivePickRefresh();
    if (!container || typeof getPicks !== "function") return;
    pickLivePollContainer = container;
    pickLivePollGetPicks = getPicks;
    const ms = intervalMs || PICK_LIVE_REFRESH_MS;
    pickLivePoll = setInterval(() => {
      const picks = getPicks();
      if (!picks?.length) return;
      scheduleRefreshMarketPanel(container, picks, {
        soft: true,
        refreshQuotes: false,
        refreshPickQuotes: true,
      });
    }, ms);
  }

  function stopLivePickRefresh() {
    if (pickLivePoll) {
      clearInterval(pickLivePoll);
      pickLivePoll = null;
    }
    pickLivePollContainer = null;
    pickLivePollGetPicks = null;
  }

  function computeBreadth(picks) {
    const list = picks || [];
    let up = 0;
    let down = 0;
    let flat = 0;
    let sumPct = 0;
    let pctN = 0;
    let sumRm = 0;
    let rmN = 0;
    let highRm = 0;
    let top = null;

    for (const p of list) {
      const pct = effectiveDayPct(p);
      if (pct != null && !Number.isNaN(pct)) {
        sumPct += pct;
        pctN++;
        if (pct > 0.05) up++;
        else if (pct < -0.05) down++;
        else flat++;
        if (!top || pct > top.pct) {
          top = { symbol: p.symbol, pct, rm: p.rm_confidence, gap: p.gap_pct };
        }
      }
      const rm = p.rm_confidence != null ? Number(p.rm_confidence) : null;
      if (rm != null && !Number.isNaN(rm)) {
        sumRm += rm;
        rmN++;
        if (rm >= 50) highRm++;
      }
    }

    const total = list.length;
    return {
      total,
      up,
      down,
      flat,
      advPct: total ? Math.round((up / total) * 100) : 0,
      decPct: total ? Math.round((down / total) * 100) : 0,
      avgPct: pctN ? sumPct / pctN : null,
      avgRm: rmN ? sumRm / rmN : null,
      highRm,
      top,
    };
  }

  const FETCH_MS = 10000;
  const QUOTE_FETCH_MS = 8000;
  const PREFETCH_DEADLINE_MS = 10000;
  const QUOTE_CACHE_MS = 120000;
  const PREMARKET_INDEX_CACHE_MS = 30000;
  const RTH_INDEX_CACHE_MS = 120000;
  const PICK_QUOTE_CACHE_MS = 45000;
  const PICK_QUOTE_STALE_MS = 60000;
  const PICK_QUOTE_BATCH = 4;
  const PICK_LIVE_REFRESH_MS = 45000;
  let cachedIndices = null;
  let cachedIndicesAt = 0;
  let pickQuoteCache = {};
  let pickLivePoll = null;
  let pickLivePollContainer = null;
  let pickLivePollGetPicks = null;
  let lastPulseQuoteMeta = null;
  const EXCHANGE_BREADTH_CACHE_MS = 120000;
  let cachedExchangeBreadth = null;
  let cachedExchangeBreadthAt = 0;
  let lastMorningBias = null;
  let lastServerMorningBias = null;
  let refreshToken = 0;
  let refreshQueue = Promise.resolve();
  const MAP_REFRESH_MS = 80;
  let mapScheduleTimer = null;
  let mapScheduleArgs = null;
  let mapScanHighlightSym = null;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function hasIndexData(indices) {
    return !!(indices && Object.keys(indices).length);
  }

  function hasQuoteData(q) {
    return (
      q != null &&
      ((q.price != null && !Number.isNaN(Number(q.price))) ||
        (q.chg != null && !Number.isNaN(Number(q.chg))))
    );
  }

  function hasBreadthData(b) {
    return !!(b && b.total > 0);
  }

  function offlineMarketHtml(message) {
    return (
      '<div class="fv-market fv-offline">' +
      '<p class="meta">' +
      escapeHtml(message || "Index quotes unavailable — breadth still updates from your scan.") +
      "</p></div>"
    );
  }

  async function fetchYahooQuoteCached(symbol) {
    const cacheMs = getEffectiveIndexCacheMs(cachedIndices);
    const hit = cachedIndices?.[symbol];
    if (hit && cachedIndicesAt && Date.now() - cachedIndicesAt < cacheMs) {
      return hit;
    }
    const q = await fetchYahooQuote(symbol);
    if (q) {
      if (!cachedIndices) cachedIndices = {};
      cachedIndices[symbol] = q;
      cachedIndicesAt = Date.now();
    }
    return q;
  }

  async function prefetchIndices(opts) {
    const settings = loadSettings();
    const snapshot = await fetchPulseSnapshot([], {
      futures: settings.showFutures !== false,
    });
    if (snapshot) {
      applySnapshotIndices(snapshot);
      if (snapshot.exchangeBreadth) {
        cachedExchangeBreadth = snapshot.exchangeBreadth;
        cachedExchangeBreadthAt = Date.now();
      }
      if (snapshot.morningBias) {
        lastServerMorningBias = snapshot.morningBias;
      }
      const cached = getCachedIndices();
      if (cached && hasIndexData(cached)) {
        return cached;
      }
    }

    const fetchSyms = [
      ...new Set([
        ...INDEX_SYMBOLS,
        ...(settings.indices || []),
        ...(settings.showFutures !== false ? FUTURES_SYMBOLS : []),
      ]),
    ];
    const deadlineMs = opts?.timeoutMs ?? PREFETCH_DEADLINE_MS;
    const indices = { ...(getCachedIndices() || {}) };

    await Promise.race([
      Promise.all(
        fetchSyms.map(async (sym) => {
          indices[sym] = await fetchYahooQuoteCached(sym);
        })
      ),
      sleep(deadlineMs),
    ]);

    cachedIndices = { ...indices };
    cachedIndicesAt = Date.now();
    return cachedIndices;
  }

  function getCachedIndices() {
    const cacheMs = getEffectiveIndexCacheMs(cachedIndices);
    if (cachedIndices && cachedIndicesAt && Date.now() - cachedIndicesAt < cacheMs) {
      return cachedIndices;
    }
    return null;
  }

  async function fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchYahooQuote(symbol) {
    if (typeof RMYahooFetch !== "undefined") {
      return await RMYahooFetch.fetchQuote(symbol, { timeoutMs: QUOTE_FETCH_MS });
    }
    return null;
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const v = Number(n);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }

  function fmtPrice(n) {
    if (n == null) return "—";
    return Number(n).toFixed(2);
  }

  function fmtVolRatio(p) {
    const v = p?.vol_ratio != null ? Number(p.vol_ratio) : null;
    if (v == null || Number.isNaN(v)) return "—";
    return v.toFixed(1) + "x";
  }

  function heatClass(chg) {
    if (chg == null) return "fv-flat";
    if (chg >= 1.5) return "fv-hot-up";
    if (chg > 0.05) return "fv-up";
    if (chg <= -1.5) return "fv-hot-down";
    if (chg < -0.05) return "fv-down";
    return "fv-flat";
  }

  /** VIX rises = risk-off (orange); VIX falls = calmer tape (teal). */
  function indexHeatClass(sym, chg) {
    const isVix = sym === "^VIX" || sym === "VIX";
    if (isVix && chg != null) return heatClass(-Number(chg));
    return heatClass(chg);
  }

  function pickHeatClass(p) {
    const pct = effectiveDayPct(p);
    if (pct == null) return "fv-flat";
    if (isGapFade(p)) return "fv-hot-down";
    if (pct >= 10) return "fv-hot-up";
    if (pct > 0) return "fv-up";
    if (pct <= -2) return "fv-hot-down";
    if (pct < 0) return "fv-down";
    return "fv-flat";
  }

  function renderIndexStrip(indices, settings) {
    const syms = (settings?.indices || INDEX_SYMBOLS).filter((s) =>
      INDEX_SYMBOLS.includes(s)
    );
    const cells = syms
      .map((sym) => {
        const q = indices[sym] || indices[sym.replace("^", "")];
        if (!hasQuoteData(q)) return "";
        const cls = indexHeatClass(sym, q?.chg);
        const meta = INDEX_META[sym] || { name: sym, desc: "Live index quote." };
        const sessionNote =
          q?.session === "pre"
            ? " Premarket price vs prior close."
            : q?.session === "post"
              ? " After-hours price vs prior close."
              : " Regular session vs prior close.";
        const stat =
          fmtPct(q?.chg) + (q?.price != null ? " · $" + fmtPrice(q.price) : "");
        return (
          '<div class="fv-cell fv-index fv-tip-target ' +
          cls +
          '" tabindex="0" data-fv-kicker="Index tape" data-fv-title="' +
          escapeAttr(sym + " · " + meta.name) +
          '" data-fv-desc="' +
          escapeAttr(meta.desc + sessionNote) +
          '" data-fv-stat="' +
          escapeAttr(stat) +
          '">' +
          '<span class="fv-sym">' +
          sym.replace("^", "") +
          sessionBadge(q?.session) +
          "</span>" +
          '<span class="fv-val">' +
          fmtPrice(q?.price) +
          "</span>" +
          '<span class="fv-chg">' +
          fmtPct(q?.chg) +
          "</span></div>"
        );
      })
      .filter(Boolean);
    if (!cells.length) return "";
    return (
      '<div class="fv-index-strip" data-cols="' +
      cells.length +
      '">' +
      cells.join("") +
      "</div>"
    );
  }

  function renderFuturesStrip(indices) {
    const cells = FUTURES_SYMBOLS.map((sym) => {
      const q = indices?.[sym];
      if (!hasQuoteData(q)) return "";
      const meta = FUTURES_META[sym] || { name: sym, desc: "Futures quote.", short: sym };
      const cls = heatClass(q?.chg);
      const stat =
        fmtPct(q?.chg) + (q?.price != null ? " · $" + fmtPrice(q.price) : "");
      return (
        '<div class="fv-cell fv-future fv-tip-target ' +
        cls +
        '" tabindex="0" data-fv-kicker="Futures" data-fv-title="' +
        escapeAttr(meta.short + " · " + meta.name) +
        '" data-fv-desc="' +
        escapeAttr(meta.desc) +
        '" data-fv-stat="' +
        escapeAttr(stat) +
        '">' +
        '<span class="fv-sym">' +
        meta.short +
        sessionBadge(q?.session) +
        "</span>" +
        '<span class="fv-val">' +
        fmtPrice(q?.price) +
        "</span>" +
        '<span class="fv-chg">' +
        fmtPct(q?.chg) +
        "</span></div>"
      );
    }).filter(Boolean);
    if (!cells.length) return "";
    return (
      '<div class="fv-futures-strip" data-cols="' +
      cells.length +
      '">' +
      cells.join("") +
      "</div>"
    );
  }

  function renderMacroHint(indices) {
    const spy = indices?.SPY;
    const qqq = indices?.QQQ;
    if (!hasQuoteData(spy) || !hasQuoteData(qqq)) return "";
    const spyChg = Number(spy.chg);
    const qqqChg = Number(qqq.chg);
    if (Number.isNaN(spyChg) || Number.isNaN(qqqChg)) return "";
    const spread = qqqChg - spyChg;
    const narrow = qqqChg > 0.3 && spread >= 0.35;
    if (!narrow && Math.abs(spread) < 0.15) return "";
    const cls = narrow ? "fv-macro-hint--warn" : "fv-macro-hint--neutral";
    const text = narrow
      ? "Narrow tape — QQQ " +
        fmtPct(qqqChg) +
        " vs SPY " +
        fmtPct(spyChg) +
        " (+" +
        spread.toFixed(2) +
        " spread)"
      : "Macro — SPY " + fmtPct(spyChg) + " · QQQ " + fmtPct(qqqChg);
    const desc = narrow
      ? "Mega-cap growth leading while the broad index lags — participation may be narrow."
      : "Quick read on benchmark vs growth tone.";
    return (
      '<p class="fv-macro-hint fv-tip-target ' +
      cls +
      '" tabindex="0" data-fv-kicker="Macro tape" data-fv-title="SPY vs QQQ" data-fv-desc="' +
      escapeAttr(desc) +
      '" data-fv-stat="' +
      escapeAttr(fmtPct(spread) + " spread") +
      '">' +
      escapeHtml(text) +
      "</p>"
    );
  }

  function renderSignalCell(key, cls, num, label) {
    const meta = SIGNAL_META[key] || { label, desc: "" };
    return (
      '<div class="fv-signal fv-tip-target ' +
      cls +
      '" tabindex="0" data-fv-kicker="Scan breadth" data-fv-title="' +
      escapeAttr(meta.label) +
      '" data-fv-desc="' +
      escapeAttr(meta.desc) +
      '" data-fv-stat="' +
      escapeAttr(String(num)) +
      '"><span class="fv-signal-num">' +
      num +
      '</span><span class="fv-signal-lbl">' +
      label +
      "</span></div>"
    );
  }

  function renderSignalRow(b) {
    if (!hasBreadthData(b)) return "";
    const cells = [
      renderSignalCell("adv", "fv-up", b.up, "Adv"),
      renderSignalCell("flat", "fv-flat", b.flat, "Unch"),
      renderSignalCell("dec", "fv-down", b.down, "Dec"),
      renderSignalCell("scan", "fv-accent", b.total, "Scan"),
    ];
    if (b.avgPct != null) {
      cells.push(
        renderSignalCell(
          "avg",
          b.avgPct > 0 ? "fv-up" : b.avgPct < 0 ? "fv-down" : "fv-flat",
          fmtPct(b.avgPct),
          "Avg"
        )
      );
    }
    if (b.avgRm != null) {
      cells.push(
        renderSignalCell(
          "rm",
          "fv-accent",
          Math.round(b.avgRm),
          "RM"
        )
      );
    }
    return (
      '<div class="fv-signal-row" data-cols="' +
      cells.length +
      '">' +
      cells.join("") +
      "</div>"
    );
  }

  function renderBreadthBar(b, indices) {
    if (!hasBreadthData(b)) return "";
    const unch = Math.max(0, 100 - b.advPct - b.decPct);
    const stat = b.advPct + "% adv · " + b.decPct + "% dec";
    const spyPct = getSpyDayPct(indices);
    let meta =
      b.advPct + "% adv · " + b.decPct + "% dec · " + b.highRm + " RM≥50";
    if (b.avgPct != null && spyPct != null) {
      const listVs = Math.round((b.avgPct - spyPct) * 100) / 100;
      meta += " · list " + fmtPct(listVs) + " vs SPY";
    }
    return (
      '<div class="fv-breadth-wrap fv-tip-target" tabindex="0" data-fv-kicker="Scan breadth" data-fv-title="Scan advancers vs decliners" data-fv-desc="Share of your scan picks up vs down today (not full-market breadth). Uses live quotes when fresh. Teal = advancing, gray = unchanged, orange = declining." data-fv-stat="' +
      escapeAttr(stat) +
      '">' +
      '<div class="fv-breadth-bar">' +
      '<div class="fv-breadth-seg fv-up" style="width:' +
      b.advPct +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-flat" style="width:' +
      unch +
      '%"></div>' +
      '<div class="fv-breadth-seg fv-down" style="width:' +
      b.decPct +
      '%"></div></div>' +
      '<span class="fv-breadth-meta">' +
      meta +
      "</span></div>"
    );
  }

  function isMobileMapView() {
    return (
      typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf()
    );
  }

  function renderPickMap(picks, settings, indices) {
    const cfg = settings || loadSettings();
    const mobileMap = isMobileMapView();
    const spyPct = getSpyDayPct(indices);
    const sorted = sortPicksForMap(picks, cfg.mapSort || "gap", spyPct);
    if (!sorted.length) return "";
    const gridCols = mapGridColumns(cfg, { mobile: mobileMap });
    const headParts = ["<span>Ticker</span>", "<span>Gap</span>", "<span>Day</span>"];
    if (!mobileMap && cfg.showMapCatalyst !== false) headParts.push("<span>Cat</span>");
    if (cfg.showMapVsSpy !== false) headParts.push("<span>α</span>");
    if (!mobileMap && cfg.showMapVol !== false) headParts.push("<span>Vol</span>");
    headParts.push("<span>RM</span>");
    return (
      '<div class="fv-map-head" style="grid-template-columns:' +
      gridCols +
      '">' +
      headParts.join("") +
      "</div>" +
      '<div class="fv-map-grid">' +
      sorted
        .map((p) => {
          const cls = pickHeatClass(p);
          const gap = p.gap_pct != null ? fmtPct(p.gap_pct) : "—";
          const dayPct = effectiveDayPct(p);
          const day = fmtPct(dayPct);
          const scanDay =
            p.pct_change != null && dayPct != null && Number(p.pct_change) !== dayPct
              ? " (scan " + fmtPct(p.pct_change) + ")"
              : "";
          const rm =
            p.rm_confidence != null ? Math.round(p.rm_confidence) : "—";
          const vs = pickVsSpy(p, spyPct);
          const vsText = vs != null ? fmtPct(vs) : "—";
          const vsCls =
            vs == null
              ? ""
              : vs > 0.05
                ? " fv-map-vs--up"
                : vs < -0.05
                  ? " fv-map-vs--down"
                  : "";
          const cat = catalystMapLabel(p.catalyst);
          const volText = fmtVolRatio(p);
          const heatNote = HEAT_HINT[cls] || HEAT_HINT["fv-flat"];
          const fadeNote = isGapFade(p) ? " Gap fading — day turned red." : "";
          const vsNote =
            vs != null && spyPct != null
              ? " vs SPY " + fmtPct(vs) + " (SPY " + fmtPct(spyPct) + ")."
              : "";
          const stat =
            "Gap " +
            gap +
            " · Day " +
            day +
            scanDay +
            (cfg.showMapVsSpy !== false ? " · α " + vsText : "") +
            (cfg.showMapVol !== false ? " · Vol " + volText : "") +
            " · RM " +
            rm;
          const desc =
            heatNote +
            fadeNote +
            vsNote +
            (cfg.showMapVol !== false ? " Vol = today vs 30-day avg volume at scan." : "") +
            " Gap = open vs prior close. Day = live quote when fresh, else scan. α = pick day % minus SPY day %. RM = H-001 confidence.";
          const cellParts = [
            '<span class="fv-map-sym">' + p.symbol + "</span>",
            '<span class="fv-map-gap">' + gap + "</span>",
            '<span class="fv-map-day">' + day + "</span>",
          ];
          if (!mobileMap && cfg.showMapCatalyst !== false) {
            cellParts.push(
              '<span class="fv-map-cat ' +
                cat.cls +
                ' fv-tip-target" tabindex="0" data-fv-kicker="Catalyst" data-fv-title="' +
                escapeAttr(cat.title) +
                '" data-fv-desc="News verification from scan pipeline." data-fv-stat="' +
                escapeAttr(cat.text) +
                '">' +
                cat.text +
                "</span>"
            );
          }
          if (cfg.showMapVsSpy !== false) {
            cellParts.push(
              '<span class="fv-map-vs' + vsCls + '">' + vsText + "</span>"
            );
          }
          if (!mobileMap && cfg.showMapVol !== false) {
            cellParts.push('<span class="fv-map-vol">' + volText + "</span>");
          }
          cellParts.push('<span class="fv-map-rm">' + rm + "</span>");
          return (
            '<div class="fv-map-cell fv-tip-target ' +
            cls +
            (isGapFade(p) ? " fv-map-cell--gap-fade" : "") +
            '" tabindex="0" data-symbol="' +
            escapeAttr(p.symbol) +
            '" style="grid-template-columns:' +
            gridCols +
            '" data-fv-kicker="Scan pick heatmap" data-fv-title="' +
            escapeAttr(p.symbol) +
            '" data-fv-desc="' +
            escapeAttr(desc) +
            '" data-fv-stat="' +
            escapeAttr(stat) +
            '">' +
            cellParts.join("") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderTopMoverHtml(b) {
    if (!b?.top) return "";
    return (
      '<div class="fv-top-mover fv-up fv-tip-target" tabindex="0" data-fv-kicker="Top mover" data-fv-title="' +
      escapeAttr(b.top.symbol + " leads the scan") +
      '" data-fv-desc="Highest day % among current picks. Gap shows premarket/open strength vs prior close." data-fv-stat="' +
      escapeAttr(
        fmtPct(b.top.pct) +
          (b.top.gap != null ? " · gap " + fmtPct(b.top.gap) : "") +
          (b.top.rm != null ? " · RM " + Math.round(b.top.rm) : "")
      ) +
      '">Top <strong>' +
      b.top.symbol +
      "</strong> " +
      fmtPct(b.top.pct) +
      (b.top.gap != null ? " · gap " + fmtPct(b.top.gap) : "") +
      "</div>"
    );
  }

  function wrapFinvizParts(parts, sent, emptyHtml) {
    if (!parts.length) return emptyHtml || "";
    return (
      '<div class="fv-market ' +
      sent +
      '" data-sections="' +
      parts.length +
      '">' +
      parts.join("") +
      "</div>"
    );
  }

  function findPulseContainers(container) {
    const body = container?.closest(".workspace-market-body");
    return {
      core: body?.querySelector("#marketPanel") || container,
      highlights: body?.querySelector("#marketHighlights"),
    };
  }

  function buildFinvizParts(indices, picks, settings, pulseMeta, exchangeBreadth) {
    const b = computeBreadth(picks);
    const cfg = settings || loadSettings();
    const ex = exchangeBreadth || getExchangeBreadth();
    const bias = resolveMorningBias(indices, picks, b, ex);
    lastMorningBias = bias;
    logMorningBias(bias);
    const sent = biasMarketSentimentClass(bias.market);
    const coreParts = [];
    const highlightParts = [];
    if (cfg.showMorningBias !== false && bias) {
      const biasHtml = renderMorningBias(bias, picks);
      if (biasHtml) coreParts.push(biasHtml);
    }
    if ((picks || []).length) {
      const metaLine = renderPulseMeta(picks, pulseMeta);
      if (metaLine) coreParts.push(metaLine);
      const ctxLine = renderPulseContext();
      if (ctxLine) coreParts.push(ctxLine);
    }
    if (cfg.showIndices) {
      const strip = renderIndexStrip(indices, cfg);
      if (strip) coreParts.push(strip);
    }
    if (cfg.showFutures !== false) {
      const futures = renderFuturesStrip(indices);
      if (futures) coreParts.push(futures);
    }
    if (cfg.showMacroHint !== false) {
      const hint = renderMacroHint(indices);
      if (hint) coreParts.push(hint);
    }
    if (cfg.showExchangeBreadth !== false) {
      const exBar = renderExchangeBreadthBar(ex);
      if (exBar) coreParts.push(exBar);
    }
    if (cfg.showSignals) {
      const row = renderSignalRow(b);
      if (row) coreParts.push(row);
    }
    if (cfg.showBreadth) {
      const bar = renderBreadthBar(b, indices);
      if (bar) coreParts.push(bar);
    }
    if (cfg.showTopMover && b.top) {
      const top = renderTopMoverHtml(b);
      if (top) highlightParts.push(top);
    }
    if (cfg.showPickMap) {
      const map = renderPickMap(picks, cfg, indices);
      if (map) highlightParts.push(map);
    }
    return { coreParts, highlightParts, sent, b, cfg, bias };
  }

  function renderFinviz(indices, picks, settings, pulseMeta, exchangeBreadth) {
    const { coreParts, highlightParts, sent } = buildFinvizParts(
      indices,
      picks,
      settings,
      pulseMeta,
      exchangeBreadth
    );
    const emptyHtml =
      '<div class="fv-market fv-empty fv-sentiment-neutral">' +
      '<p class="meta">No market data yet — load a scan or wait for index quotes.</p></div>';
    const core = wrapFinvizParts(coreParts, sent, emptyHtml);
    const highlights = wrapFinvizParts(highlightParts, sent, "");
    if (!core && !highlights) return emptyHtml;
    if (highlights) {
      return (
        core.replace(/<\/div>\s*$/, "") +
        highlightParts.join("") +
        "</div>"
      );
    }
    return core;
  }

  function applyFinvizHtml(containers, indices, picks, settings, pulseMeta, exchangeBreadth) {
    const { coreParts, highlightParts, sent, bias } = buildFinvizParts(
      indices,
      picks,
      settings,
      pulseMeta,
      exchangeBreadth
    );
    syncMorningBiasMini(bias, picks);
    const emptyHtml =
      '<div class="fv-market fv-empty fv-sentiment-neutral">' +
      '<p class="meta">No market data yet — load a scan or wait for index quotes.</p></div>';
    const coreEl = containers.core;
    const hiEl = containers.highlights;
    if (coreEl) {
      coreEl.innerHTML = wrapFinvizParts(
        coreParts,
        sent,
        coreParts.length ? "" : emptyHtml
      );
    }
    if (hiEl) {
      hiEl.innerHTML = wrapFinvizParts(highlightParts, sent, "");
      hiEl.classList.toggle("hidden", !highlightParts.length);
      hiEl.toggleAttribute("aria-hidden", !highlightParts.length);
    }
    return { coreParts, highlightParts, sent };
  }

  function settingsCheck(id, checked, label) {
    return (
      '<label class="fv-settings-check">' +
      '<input type="checkbox"' +
      (id ? ' id="' + escapeAttr(id) + '"' : "") +
      (checked ? " checked" : "") +
      '><span class="fv-settings-check-label">' +
      escapeHtml(label) +
      "</span></label>"
    );
  }

  function settingsSection(title, inner) {
    return (
      '<div class="fv-settings-section">' +
      '<p class="fv-settings-section-title">' +
      escapeHtml(title) +
      "</p>" +
      inner +
      "</div>"
    );
  }

  function settingsMenuHtml() {
    const cfg = loadSettings();
    const idxOpts = INDEX_SYMBOLS.map(
      (sym) =>
        '<label class="fv-settings-chip">' +
        '<input type="checkbox" data-idx="' +
        escapeAttr(sym) +
        '"' +
        (cfg.indices.includes(sym) ? " checked" : "") +
        "><span>" +
        escapeHtml(sym.replace("^", "")) +
        "</span></label>"
    ).join("");
    const mapSort =
      '<div class="fv-settings-field">' +
      '<span class="fv-settings-field-label">Sort heatmap</span>' +
      '<select id="fvMapSort">' +
      '<option value="gap"' +
      (cfg.mapSort === "gap" || !cfg.mapSort ? " selected" : "") +
      ">Gap</option>" +
      '<option value="day"' +
      (cfg.mapSort === "day" ? " selected" : "") +
      ">Live day</option>" +
      '<option value="rm"' +
      (cfg.mapSort === "rm" ? " selected" : "") +
      ">RM score</option>" +
      '<option value="vsSpy"' +
      (cfg.mapSort === "vsSpy" ? " selected" : "") +
      ">vs SPY</option></select></div>";
    return (
      '<div class="fv-settings-popover hidden" id="fvSettingsPopover" role="dialog" aria-label="Morning Pulse settings">' +
      '<div class="fv-settings-head">' +
      '<p class="fv-settings-title">Pulse settings</p>' +
      '<p class="fv-settings-sub">Choose what shows in Morning Pulse</p>' +
      "</div>" +
      '<div class="fv-settings-body">' +
      settingsSection(
        "Bias & tape",
        settingsCheck("fvSetMorningBias", cfg.showMorningBias !== false, "Morning bias") +
          settingsCheck("fvSetIndices", cfg.showIndices, "Index strip") +
          settingsCheck("fvSetFutures", cfg.showFutures !== false, "ES/NQ futures") +
          settingsCheck("fvSetMacro", cfg.showMacroHint !== false, "SPY/QQQ hint")
      ) +
      settingsSection(
        "Breadth",
        settingsCheck("fvSetExchange", cfg.showExchangeBreadth !== false, "Market breadth") +
          settingsCheck("fvSetSignals", cfg.showSignals, "Breadth signals") +
          settingsCheck("fvSetBreadth", cfg.showBreadth, "Scan breadth bar")
      ) +
      settingsSection(
        "Highlights",
        settingsCheck("fvSetTop", cfg.showTopMover, "Top mover")
      ) +
      settingsSection(
        "Pick heatmap",
        settingsCheck("fvSetPickMap", cfg.showPickMap, "Pick heatmap") +
          settingsCheck("fvSetMapCat", cfg.showMapCatalyst !== false, "Catalyst column") +
          settingsCheck("fvSetMapVs", cfg.showMapVsSpy !== false, "vs SPY column") +
          settingsCheck("fvSetMapVol", cfg.showMapVol !== false, "Rel vol column") +
          mapSort
      ) +
      settingsSection(
        "Index symbols",
        '<div class="fv-settings-chip-grid">' +
          idxOpts +
          "</div>" +
          '<p class="fv-settings-hint">At least one symbol stays enabled.</p>'
      ) +
      "</div>" +
      '<div class="fv-settings-foot">' +
      '<button type="button" class="btn btn-ghost btn-sm fv-settings-done" id="fvSettingsClose">Done</button>' +
      "</div></div>"
    );
  }

  function isMobileMarketRow() {
    return (
      global.matchMedia("(max-width: 640px)").matches &&
      document.body.classList.contains("is-mobile-snap-market")
    );
  }

  function settingsMenuHost(container) {
    const wrap = container?.closest(".ws-panel--market") || container?.parentElement;
    if (!wrap) return null;
    if (isMobileMarketRow()) {
      return (
        wrap.querySelector(".fv-bias-wrap") ||
        wrap.querySelector(".ws-panel-head") ||
        wrap
      );
    }
    return wrap.querySelector(".ws-panel-head") || wrap;
  }

  function findSettingsPopover(container) {
    const wrap = container?.closest(".ws-panel--market") || container?.parentElement;
    return wrap?.querySelector("#fvSettingsPopover") || container?.querySelector("#fvSettingsPopover");
  }

  function syncMobileMarketSettings() {
    const btn = document.getElementById("btnMarketSettings");
    const slot = document.getElementById("fvMarketSettingsSlot");
    const headLead = document.querySelector("#workspaceMarket .ws-panel-head-lead");
    if (!btn) return;
    const inline = isMobileMarketRow() && !!slot;
    if (inline) {
      if (btn.parentElement !== slot) slot.appendChild(btn);
      btn.classList.add("fv-market-settings-btn");
      btn.hidden = false;
    } else {
      if (headLead && btn.parentElement !== headLead) headLead.appendChild(btn);
      btn.classList.remove("fv-market-settings-btn");
    }
    const pop = findSettingsPopover(document.getElementById("marketPanel"));
    const host = settingsMenuHost(document.getElementById("marketPanel"));
    if (pop && host && pop.parentElement !== host) host.appendChild(pop);
  }

  function closeSettingsMenu(pop) {
    if (!pop) return;
    pop.classList.add("hidden");
    if (pop._fvDismissClick) {
      document.removeEventListener("click", pop._fvDismissClick, true);
      pop._fvDismissClick = null;
    }
    if (pop._fvDismissKey) {
      document.removeEventListener("keydown", pop._fvDismissKey);
      pop._fvDismissKey = null;
    }
  }

  function openSettingsMenu(pop) {
    if (!pop) return;
    pop.classList.remove("hidden");
    if (pop._fvDismissClick) return;
    pop._fvDismissClick = (ev) => {
      if (pop.contains(ev.target) || ev.target.closest("#btnMarketSettings")) return;
      closeSettingsMenu(pop);
    };
    pop._fvDismissKey = (ev) => {
      if (ev.key === "Escape") closeSettingsMenu(pop);
    };
    setTimeout(() => {
      if (!pop.classList.contains("hidden")) {
        document.addEventListener("click", pop._fvDismissClick, true);
        document.addEventListener("keydown", pop._fvDismissKey);
      }
    }, 0);
  }

  function bindSettingsMenu(container, picks) {
    const pop = findSettingsPopover(container);
    if (!pop || pop.dataset.bound === "1") return;
    pop.dataset.bound = "1";
    const apply = () => {
      const cfg = {
        showIndices: !!pop.querySelector("#fvSetIndices")?.checked,
        showMorningBias: !!pop.querySelector("#fvSetMorningBias")?.checked,
        showFutures: !!pop.querySelector("#fvSetFutures")?.checked,
        showMacroHint: !!pop.querySelector("#fvSetMacro")?.checked,
        showExchangeBreadth: !!pop.querySelector("#fvSetExchange")?.checked,
        showSignals: !!pop.querySelector("#fvSetSignals")?.checked,
        showBreadth: !!pop.querySelector("#fvSetBreadth")?.checked,
        showTopMover: !!pop.querySelector("#fvSetTop")?.checked,
        showPickMap: !!pop.querySelector("#fvSetPickMap")?.checked,
        showMapCatalyst: !!pop.querySelector("#fvSetMapCat")?.checked,
        showMapVsSpy: !!pop.querySelector("#fvSetMapVs")?.checked,
        showMapVol: !!pop.querySelector("#fvSetMapVol")?.checked,
        mapSort: pop.querySelector("#fvMapSort")?.value || "gap",
        indices: [...pop.querySelectorAll("[data-idx]")]
          .filter((el) => el.checked)
          .map((el) => el.dataset.idx),
      };
      if (!cfg.indices.length) cfg.indices = DEFAULT_SETTINGS.indices;
      saveSettings(cfg);
      refreshMarketPanel(container, picks, { soft: true, refreshQuotes: true });
    };
    pop.querySelectorAll("input, select").forEach((el) => {
      el.addEventListener("change", apply);
    });
    pop.querySelector("#fvSettingsClose")?.addEventListener("click", () => {
      closeSettingsMenu(pop);
    });
    pop.addEventListener("click", (ev) => ev.stopPropagation());
  }

  function toggleSettingsMenu(container) {
    let pop = findSettingsPopover(container);
    if (!pop) {
      const host = settingsMenuHost(container);
      if (host) {
        host.insertAdjacentHTML("beforeend", settingsMenuHtml());
        pop = host.querySelector("#fvSettingsPopover");
        bindSettingsMenu(container, container._rmPicks || []);
      }
    }
    if (!pop) return;
    if (pop.classList.contains("hidden")) openSettingsMenu(pop);
    else closeSettingsMenu(pop);
  }

  async function refreshMarketPanelProgressive(container, picks, loadSlot, opts) {
    if (!container || typeof loadSlot !== "function") {
      await refreshMarketPanel(container, picks, opts);
      return;
    }
    const pulse = findPulseContainers(container);
    const coreEl = pulse.core;
    const hiEl = pulse.highlights;
    const section = opts?.section || "all";
    const renderCore = section === "all" || section === "core";
    const renderHighlights = section === "all" || section === "highlights";
    if (renderCore) {
      coreEl.classList.remove("ws-load-slot", "ws-load-slot--loading", "ws-load-slot--ready");
      coreEl.innerHTML = "";
    }
    if (renderHighlights && hiEl) {
      hiEl.classList.remove("ws-load-slot", "ws-load-slot--loading", "ws-load-slot--ready", "hidden");
      hiEl.removeAttribute("aria-hidden");
      hiEl.innerHTML = "";
    }
    coreEl._rmPicks = picks;
    const cfg = loadSettings();
    let indices = opts?.indices || getCachedIndices() || {};
    const needsFetch =
      !opts?.skipPrefetch && cfg.showIndices && !hasIndexData(indices);
    if (
      !opts?.skipPrefetch &&
      (needsFetch || (picks?.length && opts?.refreshPickQuotes !== false))
    ) {
      const viaApi = await refreshQuotesViaApi(picks || [], {
        futures: cfg.showFutures !== false,
      });
      if (viaApi?.snapshot) {
        indices = { ...(cachedIndices || {}), ...indices };
      } else if (picks?.length && opts?.refreshPickQuotes !== false) {
        await refreshPickQuotes(picks);
      }
    }
    let ex = getExchangeBreadth();
    const deferBreadth =
      opts?.mobilePerf ||
      (typeof global.RMMobilePerf !== "undefined" && global.RMMobilePerf.isMobilePerf());
    if (
      !deferBreadth &&
      !opts?.skipPrefetch &&
      (cfg.showExchangeBreadth !== false || cfg.showMorningBias !== false)
    ) {
      if (ex) {
        void refreshExchangeBreadth();
      } else {
        ex =
          (await Promise.race([refreshExchangeBreadth(), sleep(2000).then(() => ex)])) || ex;
      }
    }
    const b = computeBreadth(picks);
    const bias = resolveMorningBias(indices, picks, b, ex);
    lastMorningBias = bias;
    logMorningBias(bias);
    const sent = biasMarketSentimentClass(bias.market);
    const coreWrap = renderCore ? document.createElement("div") : null;
    if (coreWrap) {
      coreWrap.className = "fv-market " + sent;
      coreEl.appendChild(coreWrap);
    }
    const hiWrap = renderHighlights && hiEl ? document.createElement("div") : null;
    if (hiWrap) {
      hiWrap.className = "fv-market " + sent;
      hiEl.appendChild(hiWrap);
    }

    async function block(wrap, label, htmlFn, instant) {
      if (!wrap) return;
      let html = "";
      try {
        html = await htmlFn(indices);
      } catch {
        html = "";
      }
      if (!html || !String(html).trim()) return;

      const el = document.createElement("div");
      el.className = "fv-market-block";
      wrap.appendChild(el);
      if (instant) {
        el.innerHTML = html;
        el.classList.add("ws-load-slot", "ws-load-slot--ready");
        return;
      }
      await loadSlot(el, label, async (slot) => {
        slot.innerHTML = html;
      });
    }

    if (renderCore && picks?.length) {
      await block(
        coreWrap,
        "Quote freshness",
        async () => renderPulseMeta(picks, lastPulseQuoteMeta) + renderPulseContext(),
        true
      );
    }

    if (renderCore && cfg.showMorningBias !== false) {
      await block(coreWrap, "Morning bias", async () => renderMorningBias(bias, picks), true);
    }

    if (renderCore && cfg.showIndices) {
      await block(
        coreWrap,
        "Index quotes",
        async () => {
          if (needsFetch) {
            indices = (await prefetchIndices({ timeoutMs: QUOTE_FETCH_MS })) || indices;
          }
          return renderIndexStrip(indices, cfg);
        },
        !needsFetch
      );
    }

    if (renderCore && cfg.showFutures !== false) {
      await block(
        coreWrap,
        "Futures",
        async () => {
          if (needsFetch) {
            indices = (await prefetchIndices({ timeoutMs: QUOTE_FETCH_MS })) || indices;
          }
          return renderFuturesStrip(indices);
        },
        !needsFetch
      );
    }

    if (renderCore && cfg.showMacroHint !== false) {
      await block(coreWrap, "Macro tape", async () => renderMacroHint(indices), true);
    }

    if (renderCore && cfg.showExchangeBreadth !== false) {
      await block(
        coreWrap,
        "Market breadth",
        async () => renderExchangeBreadthBar(ex || getExchangeBreadth()),
        !!ex
      );
    }

    if (renderCore && (cfg.showSignals || cfg.showBreadth)) {
      await block(
        coreWrap,
        "Scan breadth",
        async () => {
          let html = "";
          if (cfg.showSignals) html += renderSignalRow(b);
          if (cfg.showBreadth) html += renderBreadthBar(b, indices);
          return html;
        },
        true
      );
    }

    if (renderHighlights && cfg.showTopMover && b.top) {
      await block(hiWrap, "Top mover", async () => renderTopMoverHtml(b), true);
    }

    if (renderHighlights && cfg.showPickMap) {
      await block(hiWrap, "Pick heatmap", async () => renderPickMap(picks, cfg, indices), true);
    }

    if (renderCore && coreWrap) {
      const coreBlocks = coreWrap.querySelectorAll(".fv-market-block").length;
      if (coreBlocks) coreWrap.dataset.sections = String(coreBlocks);
      else {
        coreWrap.classList.add("fv-empty");
        coreWrap.innerHTML =
          '<p class="meta">No market data yet — load a scan or wait for index quotes.</p>';
      }
    }

    if (renderHighlights && hiWrap) {
      const hiBlocks = hiWrap.querySelectorAll(".fv-market-block").length;
      if (hiBlocks) hiWrap.dataset.sections = String(hiBlocks);
      else {
        hiEl.classList.add("hidden");
        hiEl.setAttribute("aria-hidden", "true");
        hiEl.innerHTML = "";
      }
    }

    if (renderCore) {
      bindMarketMapTips(coreEl);
      bindBiasCalibration(coreEl);
      bindSettingsMenu(coreEl, picks);
    }
    if (renderHighlights && hiEl) bindMarketMapTips(hiEl);
  }

  async function refreshMarketPanel(container, picks, opts) {
    if (!container) return;
    const pulse = findPulseContainers(container);
    const coreEl = pulse.core;
    const seq = ++refreshToken;
    const soft = opts?.soft === true;
    const task = async () => {
      try {
        if (!soft) {
          global.RMWorkspaceAccordion?.setRowNavLoading?.("market", true);
          coreEl.innerHTML =
            '<div class="fv-market fv-loading">Loading market map…</div>';
          if (pulse.highlights) pulse.highlights.innerHTML = "";
        }
        const settings = loadSettings();
        let indices = opts?.indices || getCachedIndices() || {};
        const fetchSyms = [
          ...new Set([
            ...INDEX_SYMBOLS,
            ...(settings.indices || []),
            ...(settings.showFutures !== false ? FUTURES_SYMBOLS : []),
          ]),
        ];
        if (opts?.refreshQuotes || !hasIndexData(indices)) {
          const viaApi = await refreshQuotesViaApi(picks, {
            futures: settings.showFutures !== false,
          });
          if (viaApi?.snapshot) {
            indices = { ...(cachedIndices || {}), ...indices };
          } else {
            const next = { ...indices };
            await Promise.race([
              Promise.all(
                fetchSyms.map(async (sym) => {
                  next[sym] = await fetchYahooQuoteCached(sym);
                })
              ),
              sleep(PREFETCH_DEADLINE_MS),
            ]);
            indices = next;
            cachedIndices = { ...indices };
            cachedIndicesAt = Date.now();
          }
        }
        if (seq !== refreshToken) return;
        let pulseMeta = lastPulseQuoteMeta;
        if (
          picks?.length &&
          opts?.refreshPickQuotes !== false &&
          pulseMeta?.source !== "rm_api"
        ) {
          pulseMeta = await refreshPickQuotes(picks);
        }
        if (seq !== refreshToken) return;
        if (settings.showExchangeBreadth !== false || settings.showMorningBias !== false) {
          await refreshExchangeBreadth();
        }
        if (seq !== refreshToken) return;
        coreEl._rmPicks = picks;
        coreEl._cachedIndices = indices;
        coreEl.classList.remove(
          "ws-load-slot",
          "ws-load-slot--loading",
          "ws-load-slot--ready"
        );
        applyFinvizHtml(pulse, indices, picks, settings, pulseMeta, getExchangeBreadth());
        bindMarketMapTips(coreEl);
        if (pulse.highlights) bindMarketMapTips(pulse.highlights);
        bindBiasCalibration(coreEl);
        bindSettingsMenu(coreEl, picks);
        syncMobileMarketSettings();
        global.RMWorkspaceAccordion?.setRowNavLoading?.("market", false);
      } catch (e) {
        if (seq !== refreshToken) return;
        coreEl.classList.remove(
          "ws-load-slot",
          "ws-load-slot--loading",
          "ws-load-slot--ready"
        );
        global.RMWorkspaceAccordion?.setRowNavLoading?.("market", false);
        coreEl.innerHTML = offlineMarketHtml(
          "Market map offline — retry in a moment or refresh the page."
        );
        if (pulse.highlights) {
          pulse.highlights.innerHTML = "";
          pulse.highlights.classList.add("hidden");
          pulse.highlights.setAttribute("aria-hidden", "true");
        }
        bindMarketMapTips(coreEl);
        bindSettingsMenu(coreEl, picks);
      }
    };
    refreshQueue = refreshQueue.then(task, task);
    return refreshQueue;
  }

  global.RMMarket = {
    getCachedIndices,
    computeBreadth,
    computeMorningBias,
    getLastMorningBias: () => lastMorningBias,
    syncMorningBiasMini,
    syncMobileMarketSettings,
    loadBiasLog,
    exportBiasLogJson,
    importBiasLogPayload,
    pullBiasLogFromApi,
    syncBiasLogApi,
    computeBiasCalibrationLocal,
    getEngineAccuracy,
    refreshEngineTrustLine,
    biasSnapshot,
    currentBiasSnapshot,
    biasOutcomeJoin,
    renderPulseMeta,
    effectiveDayPct,
    getSpyDayPct,
    pickVsSpy,
    getRainmakerApiBase,
    refreshPickQuotes,
    refreshExchangeBreadth,
    getExchangeBreadth,
    refreshMarketPanel,
    scheduleRefreshMarketPanel,
    patchPickMap,
    setMapScanHighlight,
    refreshMarketPanelProgressive,
    prefetchIndices,
    bindMarketMapTips,
    toggleSettingsMenu,
    loadSettings,
    startLivePickRefresh,
    stopLivePickRefresh,
    get _liveRefreshTimer() {
      return pickLivePoll;
    },
    fmtPct,
  };
})(typeof window !== "undefined" ? window : globalThis);
