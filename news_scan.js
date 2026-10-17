/** Fetch and score recent stock-worthy news (Google News RSS via CORS proxy). */
(function (global) {
  const CATALYST_RE =
    /\b(earnings|fda|approval|cleared|merger|acqui|guidance|contract|awarded|offering|upgrade|downgrade|sec filing|8-k|10-k|phase\s*[123]|clinical trial|trial results|revenue|profit|loss|bankruptcy|lawsuit|partnership|ipo|dividend|buyback|short squeeze|analyst|price target|beat estimates|miss estimates|warn|halt|investigation|subpoena|ceo|cfo|resign|layoff|expansion|deal|billion|million shares)\b/i;

  const MARKET_RE = /\b(stock|shares|equity|nyse|nasdaq|premarket|after hours|trading|ticker)\b/i;

  const BULLISH_RE =
    /\b(surge|soar|soars|jump|jumps|rally|rallies|gain|gains|gained|rose|rises|rising|climb|climbs|beat|beats|exceed|record high|upgrade|upgraded|outperform|approval|cleared|breakthrough|partnership|deal|acquisition|merger|buyback|dividend|growth|strong|bullish|top pick)\b/i;

  const BEARISH_RE =
    /\b(fall|falls|fell|drop|drops|plunge|plunges|sink|sinks|slide|slides|decline|miss|misses|cut|cuts|downgrade|downgraded|underperform|warning|warns|lawsuit|investigation|halt|bankruptcy|layoff|loss|losses|weak|bearish|selloff|sell-off|crash|tumble|fraud|subpoena)\b/i;

  function headlineSentiment(title, summary) {
    const text = (title + " " + (summary || "")).toLowerCase();
    let up = 0;
    let down = 0;
    const um = text.match(BULLISH_RE);
    const dm = text.match(BEARISH_RE);
    if (um) up = um.length;
    if (dm) down = dm.length;
    if (up > down) return "up";
    if (down > up) return "down";
    return "neutral";
  }

  /** Only headlines from the current trading day window */
  const MAX_AGE_HOURS = 24;
  const MAX_HEADLINES = 5;
  const MAX_TIMELINE_HEADLINES = 15;

  function scoreHeadline(title, summary, symbol) {
    const text = (title + " " + (summary || "")).trim();
    const lower = text.toLowerCase();
    const sym = symbol.toLowerCase();
    let score = 0;
    if (lower.includes(sym)) score += 2;
    if (CATALYST_RE.test(text)) score += 3;
    if (MARKET_RE.test(text)) score += 1;
    if (text.length < 15) score -= 2;
    return { score, text, worthy: score >= 2 };
  }

  function symbolMatchesHeadline(text, symbol) {
    if (!symbol || !text) return false;
    return scoreHeadline(String(text), "", String(symbol)).score >= 2;
  }

  function matchSymbolsInHeadlines(headlines, symbols) {
    const syms = [...new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean))];
    const matched = new Set();
    const hits = [];
    for (const h of headlines || []) {
      const text = (h.title || "") + " " + (h.summary || "");
      for (const sym of syms) {
        if (symbolMatchesHeadline(text, sym)) {
          if (!matched.has(sym)) {
            matched.add(sym);
            hits.push({ symbol: sym, title: h.title || "" });
          }
        }
      }
    }
    return { matched: [...matched], count: matched.size, hits };
  }

  function parseRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const items = [...doc.querySelectorAll("item")];
    return items.map((item) => {
      const title = item.querySelector("title")?.textContent || "";
      const link = item.querySelector("link")?.textContent || "";
      const pubDate = item.querySelector("pubDate")?.textContent || "";
      const desc = item.querySelector("description")?.textContent || "";
      const summary = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return { title, link, pubDate, summary, date: pubDate ? new Date(pubDate) : null };
    });
  }

  function isRecent(date) {
    if (!date || Number.isNaN(date.getTime())) return true;
    const ageMs = Date.now() - date.getTime();
    return ageMs <= MAX_AGE_HOURS * 3600 * 1000;
  }

  const FETCH_MS = 8000;
  const NEWS_BATCH_SIZE = 3;

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchViaProxies(targetUrl) {
    if (typeof RMYahooFetch !== "undefined") {
      return await RMYahooFetch.fetchTextViaProxies(targetUrl);
    }
    const encoded = encodeURIComponent(targetUrl);
    const urls = [
      "https://corsproxy.io/?" + encoded,
      "https://corsproxy.io/?url=" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    let lastErr = null;
    for (const proxyUrl of urls) {
      try {
        return await fetchText(proxyUrl);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("News fetch failed");
  }

  async function fetchRss(symbol) {
    const q = encodeURIComponent(symbol + " stock");
    const rssUrl =
      "https://news.google.com/rss/search?q=" +
      q +
      "&hl=en-US&gl=US&ceid=US:en";
    const xml = await fetchViaProxies(rssUrl);
    return parseRss(xml);
  }

  async function scanSymbolNews(symbol) {
    const raw = await fetchRss(symbol);
    const scored = raw
      .filter((a) => isRecent(a.date))
      .map((a) => {
        const { score, worthy } = scoreHeadline(a.title, a.summary, symbol);
        const sentiment = headlineSentiment(a.title, a.summary);
        return { ...a, score, worthy, sentiment };
      })
      .filter((a) => a.worthy)
      .sort((a, b) => b.score - a.score);

    const timeline = scored.slice(0, MAX_TIMELINE_HEADLINES);
    const top = timeline.slice(0, MAX_HEADLINES);
    return {
      symbol,
      articles: timeline,
      hasCatalyst: timeline.length > 0,
      topHeadline: timeline[0] || null,
    };
  }

  async function scanAll(symbols, handlers) {
    const onStart =
      typeof handlers === "function" ? handlers : handlers && handlers.onStart;
    const onDone = handlers && handlers.onDone;
    const onProgress = handlers && handlers.onProgress;

    const results = [];
    for (let i = 0; i < symbols.length; i += NEWS_BATCH_SIZE) {
      const batch = symbols.slice(i, i + NEWS_BATCH_SIZE);
      const fetched = await Promise.all(
        batch.map((sym) =>
          scanSymbolNews(sym).catch((e) => ({
            symbol: sym,
            articles: [],
            hasCatalyst: false,
            topHeadline: null,
            error: e.message,
          }))
        )
      );
      for (let j = 0; j < batch.length; j++) {
        const sym = batch[j];
        const n = i + j + 1;
        const result = fetched[j];
        results.push(result);
        if (onStart) onStart(sym, n, symbols.length);
        if (onProgress) onProgress(sym, n, symbols.length, 1);
        if (onDone) {
          const ret = onDone(result, n, symbols.length);
          if (ret && typeof ret.then === "function") await ret;
        }
      }
      if (i + NEWS_BATCH_SIZE < symbols.length) {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    return results;
  }

  function applyResultToPick(pick, result) {
    const cat = pick.catalyst || {};
    cat.headlines = (result.articles || []).map((a) => ({
      title: a.title,
      url: a.link,
      published: a.pubDate,
      score: a.score,
      sentiment: a.sentiment || headlineSentiment(a.title, a.summary),
    }));
    if (result.hasCatalyst && result.topHeadline) {
      cat.verified = true;
      cat.status = "verified";
      cat.proxy_only = false;
      cat.headline = result.topHeadline.title;
      cat.source_url = result.topHeadline.link;
      cat.headline_sentiment =
        result.topHeadline.sentiment ||
        headlineSentiment(result.topHeadline.title, result.topHeadline.summary);
    } else if (result.error) {
      cat.status = "news_error";
      cat.verified = null;
      cat.headline = "News unavailable (" + result.error + ")";
    } else {
      cat.verified = false;
      cat.status = "no_recent_catalyst";
      cat.proxy_only = true;
      cat.headline = null;
      cat.source_url = null;
    }
    pick.catalyst = cat;
  }

  function applyToSession(session, scanResults) {
    const bySym = Object.fromEntries(scanResults.map((r) => [r.symbol, r]));
    for (const pick of session.picks || []) {
      const r = bySym[pick.symbol];
      if (!r) continue;
      applyResultToPick(pick, r);
    }
    session.news_scanned_at = new Date().toISOString();
    return session;
  }

  /**
   * Apply news, then drop picks with no stock-worthy headline today.
   * Returns { kept, removed } counts.
   */
  function filterSessionToNewsPicks(session, scanResults) {
    applyToSession(session, scanResults);
    const bySym = Object.fromEntries(scanResults.map((r) => [r.symbol, r]));
    const removed = [];

    session.picks = (session.picks || []).filter((pick) => {
      const r = bySym[pick.symbol];
      const keep = r && (r.hasCatalyst || r.error);
      if (!keep) {
        removed.push({
          symbol: pick.symbol,
          rm_confidence: pick.rm_confidence,
          reason: r?.error ? "news_fetch_error" : "no_stock_worthy_news_today",
        });
      }
      return keep;
    });

    session.picks.forEach((pick, i) => {
      pick.rank = i + 1;
    });
    session.pick_count = session.picks.length;
    session.filtered_out = removed;
    session.news_filter_applied_at = new Date().toISOString();

    return {
      before: scanResults.length,
      kept: session.picks.length,
      removed: removed.length,
      removedSymbols: removed.map((x) => x.symbol),
    };
  }

  global.RMNewsScan = {
    scanAll,
    applyToSession,
    applyResultToPick,
    filterSessionToNewsPicks,
    scoreHeadline,
    symbolMatchesHeadline,
    matchSymbolsInHeadlines,
    headlineSentiment,
  };
})(typeof window !== "undefined" ? window : globalThis);
