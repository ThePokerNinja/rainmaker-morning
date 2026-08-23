/** Market themes heatmap — multi-RSS + scan symbol alignment + article reader. */
(function (global) {
  const FETCH_MS = 6000;
  const ARTICLE_FETCH_MS = 10000;
  const HEADLINE_CACHE_KEY = "rm_mkt_headlines_v2";
  const HEADLINE_CACHE_MS = 300000;
  const HOVER_COLLAPSE_MS = 420;

  const RSS_FEEDS = [
    {
      id: "cnbc",
      label: "CNBC",
      url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    },
    {
      id: "marketwatch",
      label: "MarketWatch",
      url: "https://feeds.marketwatch.com/marketwatch/topstories/",
    },
    {
      id: "cnbc-macro",
      label: "CNBC Economy",
      url: "https://www.cnbc.com/id/20910258/device/rss/rss.html",
    },
  ];

  const THEMES = [
    {
      id: "macro",
      label: "Macro & rates",
      keywords: /fed|rate|inflation|treasury|gdp|jobs|cpi|ppi|economy|recession/i,
      sources: "CNBC · MW · Economy",
    },
    {
      id: "tech",
      label: "Tech & AI",
      keywords: /ai|chip|nvidia|semiconductor|cloud|software|apple|microsoft|google|meta/i,
      sources: "CNBC · MW",
    },
    {
      id: "earnings",
      label: "Earnings",
      keywords: /earnings|revenue|guidance|eps|beat|miss|quarter|results/i,
      sources: "CNBC · MW",
    },
    {
      id: "energy",
      label: "Energy & commodities",
      keywords: /oil|gas|opec|gold|copper|commodity|crude|energy|solar/i,
      sources: "CNBC · MW",
    },
    {
      id: "risk",
      label: "Risk & flows",
      keywords: /selloff|rally|volatility|vix|short|squeeze|bank|credit|geopolit|war|tariff/i,
      sources: "CNBC · MW",
    },
  ];

  let lastContext = null;
  let lastBuckets = [];
  let rootEl = null;
  let readerPortal = null;
  let marketBodyEl = null;
  let hoverBound = false;

  const ui = {
    phase: "idle",
    themeId: null,
    articleIdx: null,
    leaveTimer: null,
    fetchToken: 0,
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

  function normalizeTitle(title) {
    return String(title || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseDescriptionFields(raw) {
    const html = String(raw || "").trim();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const imgM = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    return {
      summaryHtml: html,
      summaryText: text,
      imageUrl: imgM ? imgM[1] : null,
    };
  }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_MS);
    try {
      if (typeof RMYahooFetch !== "undefined") {
        return await RMYahooFetch.fetchTextViaProxies(url, { timeoutMs: FETCH_MS });
      }
      const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchFeedXml(url) {
    const encoded = encodeURIComponent(url);
    const urls = [
      "https://corsproxy.io/?" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    for (const u of urls) {
      const xml = await fetchText(u);
      if (xml) return xml;
    }
    return null;
  }

  function parseRssItems(xml, sourceLabel) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    return [...doc.querySelectorAll("item")]
      .map((item) => {
        const desc = item.querySelector("description")?.textContent || "";
        const fields = parseDescriptionFields(desc);
        return {
          title: item.querySelector("title")?.textContent?.trim() || "",
          link: item.querySelector("link")?.textContent?.trim() || "",
          summary: fields.summaryText,
          summaryHtml: fields.summaryHtml,
          imageUrl: fields.imageUrl,
          source: sourceLabel,
        };
      })
      .filter((a) => a.title);
  }

  function readCachedHeadlines(limit) {
    try {
      const raw = sessionStorage.getItem(HEADLINE_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached?.at && Date.now() - cached.at < HEADLINE_CACHE_MS && cached.items?.length) {
          return cached.items.slice(0, limit || 48);
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function cacheHeadlines(items) {
    if (!items || !items.length) return;
    try {
      sessionStorage.setItem(
        HEADLINE_CACHE_KEY,
        JSON.stringify({ at: Date.now(), items: items.slice(0, 48) })
      );
    } catch {
      /* ignore */
    }
  }

  function sentimentFromTitle(title) {
    if (typeof RMNewsScan !== "undefined" && RMNewsScan.headlineSentiment) {
      return RMNewsScan.headlineSentiment(title, "");
    }
    if (/surge|rally|jump|gain|beat|soar|record high/i.test(title)) return "up";
    if (/fall|drop|sink|miss|cut|selloff|plunge|warning/i.test(title)) return "down";
    return "neutral";
  }

  function matchScanSymbols(headlines, picks) {
    const symbols = (picks || []).map((p) => p.symbol).filter(Boolean);
    if (typeof RMNewsScan !== "undefined" && RMNewsScan.matchSymbolsInHeadlines) {
      return RMNewsScan.matchSymbolsInHeadlines(headlines, symbols);
    }
    const matched = new Set();
    for (const h of headlines || []) {
      const text = (h.title || "") + " " + (h.summary || "");
      for (const sym of symbols) {
        if (new RegExp("\\b" + sym + "\\b", "i").test(text)) matched.add(sym.toUpperCase());
      }
    }
    return { matched: [...matched], count: matched.size, hits: [] };
  }

  function classifyHeadlines(headlines, picks) {
    const buckets = THEMES.map((t) => ({
      ...t,
      articles: [],
      buzz: 0,
      sentimentScore: 0,
      scanAlign: 0,
    }));
    for (const h of headlines) {
      const title = h.title || "";
      let placed = false;
      for (const b of buckets) {
        if (b.keywords.test(title)) {
          const sent = sentimentFromTitle(title);
          b.articles.push({ ...h, sentiment: sent });
          b.buzz += 1 + Math.min(3, title.length / 80);
          if (sent === "up") b.sentimentScore += 1;
          if (sent === "down") b.sentimentScore -= 1;
          placed = true;
          break;
        }
      }
      if (!placed) buckets[4].articles.push({ ...h, sentiment: "neutral" });
    }

    const symbolMatch = matchScanSymbols(headlines, picks);
    const alignedSyms = new Set();

    for (const sym of symbolMatch.matched) {
      for (const b of buckets) {
        const inBucket = b.articles.some((a) => {
          const text = (a.title || "") + " " + (a.summary || "");
          return typeof RMNewsScan !== "undefined" && RMNewsScan.symbolMatchesHeadline
            ? RMNewsScan.symbolMatchesHeadline(text, sym)
            : new RegExp("\\b" + sym + "\\b", "i").test(text);
        });
        if (inBucket) {
          b.scanAlign += 1;
          alignedSyms.add(sym);
          const pick = (picks || []).find((p) => String(p.symbol).toUpperCase() === sym);
          if (pick) pick.theme_id = b.id;
          break;
        }
      }
    }

    for (const p of picks || []) {
      if (alignedSyms.has(String(p.symbol).toUpperCase())) continue;
      const cat = p.catalyst || {};
      const top = cat.headline || cat.headlines?.[0]?.title;
      if (!top) continue;
      for (const b of buckets) {
        if (b.keywords.test(top)) {
          b.scanAlign += 1;
          alignedSyms.add(String(p.symbol).toUpperCase());
          p.theme_id = b.id;
          break;
        }
      }
    }

    const themeAligned = alignedSyms.size;
    const leading = [...buckets].sort(
      (a, b) => (b.scanAlign || 0) - (a.scanAlign || 0) || b.buzz - a.buzz
    )[0];

    lastContext = {
      scanNamesInNews: symbolMatch.count,
      matchedSymbols: symbolMatch.matched,
      themeAligned,
      leadingTheme: leading?.scanAlign > 0 || leading?.buzz > 0 ? leading.label : null,
      sources: RSS_FEEDS.map((f) => f.label).join(" · "),
    };

    return buckets;
  }

  function bucketById(themeId) {
    return lastBuckets.find((b) => b.id === themeId) || null;
  }

  function articleAt(themeId, idx) {
    const b = bucketById(themeId);
    if (!b || idx == null) return null;
    return b.articles[idx] || null;
  }

  function sentimentLabel(sent) {
    if (sent === "up") return "Bullish headline";
    if (sent === "down") return "Bearish headline";
    return "Neutral";
  }

  function isHighlightedArticle(a) {
    return a && (a.sentiment === "up" || a.sentiment === "down");
  }

  function sanitizeReaderHtml(html) {
    const doc = new DOMParser().parseFromString(
      "<div>" + String(html || "") + "</div>",
      "text/html"
    );
    const root = doc.body.firstElementChild;
    if (!root) return "";
    const allowed = new Set([
      "P",
      "A",
      "IMG",
      "H2",
      "H3",
      "H4",
      "UL",
      "OL",
      "LI",
      "STRONG",
      "EM",
      "BR",
      "FIGURE",
      "FIGCAPTION",
      "BLOCKQUOTE",
    ]);
    const walk = (node) => {
      [...node.childNodes].forEach((ch) => {
        if (ch.nodeType === 3) return;
        if (ch.nodeType !== 1) {
          ch.remove();
          return;
        }
        if (!allowed.has(ch.tagName)) {
          if (ch.tagName === "DIV" || ch.tagName === "SPAN") {
            walk(ch);
            while (ch.firstChild) ch.parentNode.insertBefore(ch.firstChild, ch);
            ch.remove();
            return;
          }
          ch.remove();
          return;
        }
        if (ch.tagName === "A") {
          ch.setAttribute("target", "_blank");
          ch.setAttribute("rel", "noopener noreferrer");
        }
        if (ch.tagName === "IMG") {
          const src = ch.getAttribute("src");
          if (!src || /^javascript:/i.test(src)) ch.remove();
          else ch.setAttribute("loading", "lazy");
        }
        walk(ch);
      });
    };
    walk(root);
    return root.innerHTML;
  }

  async function fetchArticleRich(article) {
    if (!article?.link) return { bodyHtml: "", heroImage: article?.imageUrl || null };
    if (article._reader) return article._reader;

    const encoded = encodeURIComponent(article.link);
    const proxyUrls = [
      "https://corsproxy.io/?" + encoded,
      "https://api.allorigins.win/raw?url=" + encoded,
    ];
    let html = null;
    for (const u of proxyUrls) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ARTICLE_FETCH_MS);
      try {
        if (typeof RMYahooFetch !== "undefined") {
          html = await RMYahooFetch.fetchTextViaProxies(article.link, {
            timeoutMs: ARTICLE_FETCH_MS,
          });
        } else {
          const res = await fetch(u, { cache: "no-store", signal: ctrl.signal });
          if (res.ok) html = await res.text();
        }
      } catch {
        html = null;
      } finally {
        clearTimeout(t);
      }
      if (html) break;
    }

    let bodyHtml = "";
    let heroImage = article.imageUrl || null;
    if (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      heroImage =
        doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
        doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
        heroImage;
      const node =
        doc.querySelector("article") ||
        doc.querySelector('[class*="ArticleBody"]') ||
        doc.querySelector('[class*="article-body"]') ||
        doc.querySelector("main");
      if (node) bodyHtml = sanitizeReaderHtml(node.innerHTML);
      if (!bodyHtml) {
        const paras = [...doc.querySelectorAll("p")]
          .map((p) => p.textContent.trim())
          .filter((t) => t.length > 60)
          .slice(0, 12);
        bodyHtml = paras.map((t) => "<p>" + escapeHtml(t) + "</p>").join("");
      }
    }

    // Reader-mode fallback: r.jina.ai returns clean article text for sites whose
    // markup the proxies can't reach. Used only when extraction failed above.
    if (!bodyHtml) {
      const reader = await fetchText("https://r.jina.ai/" + article.link);
      if (reader) {
        const paras = String(reader)
          .split(/\n{2,}/)
          .map((t) => t.replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 60 && !/^https?:\/\//.test(t))
          .slice(0, 12);
        if (paras.length) {
          bodyHtml = paras.map((t) => "<p>" + escapeHtml(t) + "</p>").join("");
        }
      }
    }

    const hadFullBody = !!bodyHtml;
    if (!bodyHtml && article.summaryHtml) {
      bodyHtml = sanitizeReaderHtml(article.summaryHtml);
    } else if (!bodyHtml && article.summary) {
      bodyHtml = "<p>" + escapeHtml(article.summary) + "</p>";
    }

    article._reader = { bodyHtml, heroImage, failed: !hadFullBody };
    return article._reader;
  }

  function backButtonHtml(label) {
    return (
      '<button type="button" class="mkt-theme-back" aria-label="' +
      escapeAttr(label || "Back") +
      '">' +
      '<span class="mkt-theme-back-icon" aria-hidden="true">←</span>' +
      '<span class="mkt-theme-back-label">' +
      escapeHtml(label || "Back") +
      "</span></button>"
    );
  }

  function articleHeroHtml(article, reader) {
    const img = reader?.heroImage || article?.imageUrl;
    if (!img) return "";
    return (
      '<figure class="mkt-theme-hero">' +
      '<img src="' +
      escapeAttr(img) +
      '" alt="" loading="lazy" decoding="async"/>' +
      "</figure>"
    );
  }

  function renderReaderHtml(article, bucket, reader, loading) {
    const sent = article.sentiment || "neutral";
    const body = reader?.bodyHtml || "";
    return (
      '<div class="mkt-theme-reader mkt-theme-panel sent-' +
      sent +
      '" data-phase="full">' +
      backButtonHtml("Back to themes") +
      '<div class="mkt-theme-reader-scroll">' +
      (loading
        ? '<p class="mkt-theme-loading">Loading article…</p>'
        : "") +
      '<p class="mkt-theme-kicker">' +
      escapeHtml(bucket.label) +
      " · " +
      escapeHtml(article.source || bucket.sources) +
      "</p>" +
      (!loading ? articleHeroHtml(article, reader) : "") +
      '<h2 class="mkt-theme-article-title">' +
      escapeHtml(article.title) +
      "</h2>" +
      (!loading
        ? '<div class="mkt-theme-article-body">' +
          (body || "<p>" + escapeHtml(article.summary || "") + "</p>") +
          "</div>"
        : "") +
      (!loading && reader && reader.failed
        ? '<div class="mkt-theme-article-error">' +
          "<p>Couldn't load the full article.</p>" +
          '<button type="button" class="mkt-theme-retry">Retry</button>' +
          "</div>"
        : "") +
      (article.link
        ? '<a class="mkt-theme-ext-link" href="' +
          escapeAttr(article.link) +
          '" target="_blank" rel="noopener noreferrer">Read on publisher site ↗</a>'
        : "") +
      "</div></div>"
    );
  }

  function ensureReaderPortal() {
    marketBodyEl =
      marketBodyEl ||
      document.querySelector("#workspaceMarket .workspace-market-body");
    if (!marketBodyEl) return null;
    if (!readerPortal) {
      readerPortal = document.createElement("div");
      readerPortal.className = "mkt-theme-reader-portal";
      readerPortal.hidden = true;
      marketBodyEl.appendChild(readerPortal);
    }
    return readerPortal;
  }

  // Two phases only: "idle" (theme grid) and "full" (article reader overlay).
  function setPhase(phase) {
    ui.phase = phase;
    if (rootEl) rootEl.dataset.phase = phase;
    if (marketBodyEl) {
      marketBodyEl.classList.toggle("workspace-market-body--mkt-reader", phase === "full");
    }
    if (readerPortal) {
      readerPortal.hidden = phase !== "full";
      readerPortal.classList.toggle("mkt-theme-reader-portal--open", phase === "full");
    }
  }

  function clearLeaveTimer() {
    if (ui.leaveTimer) {
      clearTimeout(ui.leaveTimer);
      ui.leaveTimer = null;
    }
  }

  function collapseToIdle() {
    clearLeaveTimer();
    ui.themeId = null;
    ui.articleIdx = null;
    ui.fetchToken++;
    setPhase("idle");
    if (!rootEl) return;
    const grid = rootEl.querySelector(".mkt-theme-grid-view");
    const preview = rootEl.querySelector(".mkt-theme-preview-slot");
    if (grid) {
      grid.classList.remove("mkt-theme-grid-view--hidden");
      grid.hidden = false;
    }
    if (preview) {
      preview.innerHTML = "";
      preview.hidden = true;
      preview.classList.remove("mkt-theme-preview-slot--open");
    }
    if (readerPortal) readerPortal.innerHTML = "";
    renderHeatmapGrid(rootEl.querySelector(".mkt-theme-grid"), lastBuckets);
    bindChipClicks(rootEl);
  }

  async function openFull(themeId, articleIdx) {
    const article = articleAt(themeId, articleIdx);
    const bucket = bucketById(themeId);
    if (!article || !bucket) return;
    const portal = ensureReaderPortal();
    if (!portal) return;

    clearLeaveTimer();
    ui.themeId = themeId;
    ui.articleIdx = articleIdx;
    const token = ++ui.fetchToken;
    setPhase("full");

    portal.innerHTML = renderReaderHtml(article, bucket, null, true);
    bindReaderPortal(portal, themeId, articleIdx);

    const reader = await fetchArticleRich(article);
    if (token !== ui.fetchToken || ui.phase !== "full") return;
    portal.innerHTML = renderReaderHtml(article, bucket, reader, false);
    bindReaderPortal(portal, themeId, articleIdx);
  }

  function bindReaderPortal(portal, themeId, articleIdx) {
    portal.querySelector(".mkt-theme-back")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      collapseToIdle();
    });
    portal.querySelector(".mkt-theme-ext-link")?.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    portal.querySelector(".mkt-theme-retry")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const article = articleAt(themeId, articleIdx);
      if (article) delete article._reader; // force a fresh fetch
      openFull(themeId, articleIdx);
    });
  }

  // Two-state model (item 18): a chip click opens the full reader directly;
  // Back returns straight to the theme grid. No intermediate preview.
  function onChipClick(e) {
    const chip = e.target.closest(".mkt-theme-chip--hit");
    if (!chip || !rootEl) return;
    e.preventDefault();
    e.stopPropagation();
    const tile = chip.closest("[data-theme]");
    if (!tile) return;
    const themeId = tile.dataset.theme;
    const articleIdx = Number(chip.dataset.articleIdx);
    if (!themeId || Number.isNaN(articleIdx)) return;
    openFull(themeId, articleIdx);
  }

  function bindChipClicks(container) {
    if (!container) return;
    container.querySelectorAll(".mkt-theme-chip--hit").forEach((chip) => {
      if (chip.dataset.mktBound) return;
      chip.dataset.mktBound = "1";
      chip.addEventListener("click", onChipClick);
    });
  }

  function bindHoverCollapse() {
    if (hoverBound) return;
    const panel = document.getElementById("workspaceMarket");
    if (!panel) return;
    hoverBound = true;
    panel.addEventListener("mouseleave", () => {
      if (ui.phase === "idle") return;
      clearLeaveTimer();
      ui.leaveTimer = setTimeout(collapseToIdle, HOVER_COLLAPSE_MS);
    });
    panel.addEventListener("mouseenter", () => {
      clearLeaveTimer();
    });
  }

  function renderChipHtml(a, idx) {
    const sent = a.sentiment || "neutral";
    const hit = isHighlightedArticle(a);
    const label = (a.title || "").slice(0, 42) + (a.title && a.title.length > 42 ? "…" : "");
    if (hit) {
      return (
        '<button type="button" class="mkt-theme-chip mkt-theme-chip--hit sent-' +
        sent +
        '" data-article-idx="' +
        idx +
        '">' +
        escapeHtml(label) +
        "</button>"
      );
    }
    return '<span class="mkt-theme-chip sent-' + sent + '">' + escapeHtml(label) + "</span>";
  }

  function renderHeatmapGrid(gridEl, buckets) {
    if (!gridEl) return;
    const maxBuzz = Math.max(1, ...buckets.map((b) => b.buzz));
    gridEl.innerHTML = buckets
      .map((b, idx) => {
        const size = 0.85 + (b.buzz / maxBuzz) * 1.35;
        const minH = Math.round(88 + (b.buzz / maxBuzz) * 72);
        const articles = (b.articles || []).slice(0, 3);
        const shift =
          b.sentimentScore > 0
            ? "Bullish shift"
            : b.sentimentScore < 0
              ? "Bearish shift"
              : "Mixed tone";
        const chips = articles.map((a, i) => renderChipHtml(a, i)).join("");
        const scanBadge =
          b.scanAlign > 0
            ? '<span class="mkt-theme-scan">' + b.scanAlign + " scan</span>"
            : "";
        const tileSent =
          b.sentimentScore > 0 ? "up" : b.sentimentScore < 0 ? "down" : "neutral";
        // Empty bucket → keep a live shimmer chip so it reads as "still loading".
        const chipsHtml =
          chips ||
          '<span class="mkt-theme-chip mkt-theme-chip--loading" aria-hidden="true"></span>';
        return (
          '<div class="mkt-theme-tile sent-' +
          tileSent +
          '" role="listitem" data-theme="' +
          escapeAttr(b.id) +
          '" style="flex-grow:' +
          size.toFixed(2) +
          ";min-height:" +
          minH +
          "px;--i:" +
          idx +
          '">' +
          '<span class="mkt-theme-head">' +
          '<span class="mkt-theme-label">' +
          escapeHtml(b.label) +
          "</span>" +
          '<span class="mkt-theme-buzz">' +
          Math.round(b.buzz) +
          "</span>" +
          scanBadge +
          "</span>" +
          '<span class="mkt-theme-chips">' +
          chipsHtml +
          "</span>" +
          '<span class="mkt-theme-sources">' +
          escapeHtml(b.sources) +
          "</span>" +
          '<span class="mkt-theme-hover">' +
          escapeHtml(shift) +
          "</span></div>"
        );
      })
      .join("");
  }

  function renderHeatmap(container, buckets, opts) {
    if (!container) return;
    const animateIn = !!opts?.animateIn;
    lastBuckets = buckets;
    rootEl = container;
    container.classList.add("mkt-theme-root");
    container.dataset.phase = ui.phase;
    container.innerHTML =
      '<div class="mkt-theme-grid-view' +
      (animateIn ? " mkt-theme-grid-view--enter" : "") +
      '" role="list"><div class="mkt-theme-grid"></div></div>';
    const grid = container.querySelector(".mkt-theme-grid");
    renderHeatmapGrid(grid, buckets);
    if (ui.phase === "full" && ui.themeId != null && ui.articleIdx != null) {
      openFull(ui.themeId, ui.articleIdx);
    } else {
      setPhase("idle");
    }
    bindChipClicks(container);
    bindHoverCollapse();
    if (typeof RMUiTips !== "undefined") RMUiTips.bind(container);
  }

  function renderSkeleton(container) {
    if (!container) return;
    container.classList.add("mkt-theme-root");
    // Varied grow/height for a tetris-packed placeholder grid.
    const cells = [
      { g: 2.1, h: 150 },
      { g: 1.3, h: 104 },
      { g: 1.7, h: 128 },
      { g: 1.0, h: 92 },
      { g: 1.5, h: 116 },
    ];
    const tiles = cells
      .map(
        (c) =>
          '<div class="mkt-theme-tile mkt-theme-tile--skeleton" style="flex-grow:' +
          c.g +
          ";min-height:" +
          c.h +
          'px" aria-hidden="true">' +
          '<span class="mkt-skel-line mkt-skel-line--head"></span>' +
          '<span class="mkt-skel-chip"></span>' +
          '<span class="mkt-skel-chip mkt-skel-chip--sm"></span>' +
          '<span class="mkt-skel-line mkt-skel-line--src"></span>' +
          "</div>"
      )
      .join("");
    container.innerHTML =
      '<div class="mkt-theme-grid-view mkt-theme-grid-view--loading" role="list" aria-busy="true">' +
      '<div class="mkt-theme-grid">' +
      tiles +
      "</div></div>";
  }

  function headlinesApiBase() {
    try {
      if (typeof global.RMMorningApi !== "undefined" && global.RMMorningApi.resolveApiBase) {
        return global.RMMorningApi.resolveApiBase();
      }
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      const h = global.location?.hostname;
      if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    } catch {
      /* ignore */
    }
    return "";
  }

  async function fetchHeadlinesFromApi(opts) {
    const base = headlinesApiBase();
    if (!base) return null;
    const qs = opts?.refresh ? "?refresh=1" : "";
    try {
      const res = await fetch(base + "/pulse/headlines" + qs, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length) cacheHeadlines(items);
      return { items, stale: !!data?.stale, asOf: data?.asOf || null };
    } catch {
      return null;
    }
  }

  async function refreshRssFeeds(container, picks, hadCache, haveData) {
    const collected = [];
    const seen = new Set();
    let renderedLive = false;
    await Promise.all(
      RSS_FEEDS.map(async (feed) => {
        const xml = await fetchFeedXml(feed.url);
        const items = parseRssItems(xml, feed.label);
        let added = false;
        for (const item of items) {
          const key = normalizeTitle(item.title);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          collected.push(item);
          added = true;
        }
        if (added && ui.phase === "idle") {
          renderHeatmap(container, classifyHeadlines(collected.slice(), picks), {
            animateIn: !renderedLive && !hadCache,
          });
          renderedLive = true;
        }
      })
    );
    if (collected.length) {
      cacheHeadlines(collected);
      if (ui.phase === "idle") {
        renderHeatmap(container, classifyHeadlines(collected, picks), { animateIn: false });
      }
    } else if (!hadCache && ui.phase === "idle") {
      renderHeatmap(container, classifyHeadlines([], picks), { animateIn: false });
    }
    return collected;
  }

  async function refresh(container, opts) {
    if (!container) return lastContext;
    const picks = opts?.picks || [];
    const haveData =
      lastBuckets &&
      lastBuckets.length &&
      lastBuckets.some((b) => b.articles && b.articles.length);

    const apiPayload = await fetchHeadlinesFromApi();
    const cached = readCachedHeadlines(48);
    const apiItems = apiPayload?.items?.length ? apiPayload.items : null;
    const initialItems = apiItems || cached;
    const hadCache = !!(initialItems && initialItems.length);

    if (hadCache) {
      if (ui.phase !== "idle") collapseToIdle();
      renderHeatmap(container, classifyHeadlines(initialItems, picks), { animateIn: !haveData });
    } else if (ui.phase === "idle" && !haveData) {
      renderSkeleton(container);
    }

    if (apiItems && !apiPayload.stale) {
      return lastContext;
    }

    const base = headlinesApiBase();
    if (base) {
      const refreshed = await fetchHeadlinesFromApi({ refresh: true });
      if (refreshed?.items?.length) {
        renderHeatmap(container, classifyHeadlines(refreshed.items, picks), { animateIn: false });
        return lastContext;
      }
    } else {
      await refreshRssFeeds(container, picks, hadCache, haveData);
    }
    return lastContext;
  }

  function getLastContext() {
    return lastContext;
  }

  let visibleObserver = null;

  function scheduleWhenVisible(container, opts) {
    if (!container) return;
    if (typeof IntersectionObserver === "undefined") {
      void refresh(container, opts);
      return;
    }
    if (visibleObserver) {
      visibleObserver.disconnect();
      visibleObserver = null;
    }
    visibleObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        visibleObserver?.disconnect();
        visibleObserver = null;
        void refresh(container, opts);
      },
      { root: null, rootMargin: "80px 0px", threshold: 0.05 }
    );
    visibleObserver.observe(container);
  }

  global.RMMarketThemes = {
    refresh,
    scheduleWhenVisible,
    THEMES,
    getLastContext,
    matchScanSymbols,
    collapseReader: collapseToIdle,
  };
})(typeof window !== "undefined" ? window : globalThis);
