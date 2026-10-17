/** Open positions, price history, and recommendation tracking (localStorage). */
(function (global) {
  const STORAGE_KEY = "rainmaker_holdings_v1";

  function parseOptionUnderlying(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return "";
    const compact = s.replace(/\s+/g, "");
    const occ = compact.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
    if (occ) return occ[1].trim();
    const spaced = s.match(/^([A-Z]{1,6})\s+(\d{6}[CP]\d{8})$/i);
    if (spaced) return spaced[1].trim();
    return compact;
  }

  function isOptionSymbol(raw) {
    const s = String(raw || "").trim().toUpperCase();
    if (!s) return false;
    const compact = s.replace(/\s+/g, "");
    return /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(compact);
  }

  function compactOptionSymbol(raw) {
    return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  }

  function parseOptionContract(raw) {
    const compact = compactOptionSymbol(raw);
    const occ = compact.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    if (!occ) return null;
    const months = [
      "Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    const mi = parseInt(occ[3], 10) - 1;
    return {
      underlying: occ[1],
      expiry: "20" + occ[2] + "-" + occ[3] + "-" + occ[4],
      expiryShort:
        (months[mi] || occ[3]) + " " + parseInt(occ[4], 10) + " '" + occ[2],
      right: occ[5] === "C" ? "Call" : "Put",
      strike: Number(occ[6]) / 1000,
      compact,
    };
  }

  function formatOptionLabel(raw) {
    const p = parseOptionContract(raw);
    if (!p) return String(raw || "").trim();
    return (
      p.underlying +
      " " +
      p.expiryShort +
      " $" +
      p.strike +
      (p.right === "Call" ? "C" : "P")
    );
  }

  /** Yahoo / chart bars symbol — option contracts use OCC, not underlying. */
  function quoteSymbolFor(h) {
    if (!h) return "";
    if (h.quoteSymbol) return String(h.quoteSymbol).toUpperCase();
    const sym = String(h.symbol || "").trim().toUpperCase();
    if (!sym) return "";
    if (h.instrument === "option" || isOptionSymbol(sym)) {
      return compactOptionSymbol(sym);
    }
    return sym;
  }

  function restoreSymbolFromSchwabKey(tail) {
    let t = String(tail || "").replace(/^schwab_/i, "");
    const idx = t.indexOf("_");
    if (idx > 0) {
      const root = t.slice(0, idx);
      const rest = t.slice(idx + 1);
      if (/^[A-Z]{1,6}$/.test(root) && /^\d{6}[CP]\d{8}$/.test(rest)) {
        return root + rest;
      }
    }
    return compactOptionSymbol(t.replace(/_/g, ""));
  }

  function barsSymbolForSelectValue(val) {
    const key = normalizeHoldingSelectKey(String(val || "").trim());
    if (!key) return "";
    const h = findDisplayHoldingBySelectValue(key);
    if (h) return quoteSymbolFor(h);
    if (isHoldingSelectKey(key)) {
      return restoreSymbolFromSchwabKey(key.slice(8));
    }
    if (isOptionSymbol(key)) return compactOptionSymbol(key);
    return key.toUpperCase();
  }

  function openPositionPnl(h) {
    if (!h) return null;
    const isOpt =
      h.instrument === "option" || isOptionSymbol(String(h.symbol || ""));
    const mult = isOpt ? 100 : 1;
    const qty = Math.abs(Number(h.quantity ?? h.qty) || 0);
    const avg = Number(h.entry_price ?? h.avgPrice);
    const mv = Number(h.market_value ?? h.marketValue);
    if (!qty || !Number.isFinite(avg) || !Number.isFinite(mv)) return null;
    const cost = avg * qty * mult;
    if (!Number.isFinite(cost) || cost === 0) return null;
    const dollars = mv - cost;
    return {
      dollars: Math.round(dollars * 100) / 100,
      pct: Math.round(((dollars / cost) * 100) * 10) / 10,
    };
  }

  function chartSymbolFor(h) {
    if (!h) return "";
    if (h.chartSymbol) return String(h.chartSymbol).toUpperCase();
    const sym = String(h.symbol || "").trim().toUpperCase();
    if (!sym) return "";
    if (h.instrument === "option" || isOptionSymbol(sym)) {
      return parseOptionUnderlying(sym) || sym;
    }
    return sym;
  }

  function normalizeHoldingSelectKey(val) {
    const s = String(val || "").trim();
    const m = s.match(/^holding:(.+)$/i);
    if (m) return "holding:" + m[1];
    return s;
  }

  function isHoldingSelectKey(val) {
    return /^holding:/i.test(String(val || ""));
  }

  function holdingSelectValue(h) {
    if (!h) return "";
    const chart = chartSymbolFor(h);
    const sym = String(h.symbol || "").trim().toUpperCase();
    if (h.instrument === "option" || isOptionSymbol(sym)) return "holding:" + h.id;
    return chart;
  }

  function findDisplayHoldingBySelectValue(val) {
    const norm = normalizeHoldingSelectKey(val);
    if (!isHoldingSelectKey(norm)) return null;
    const id = norm.slice(8);
    const rows = getDisplayOpen();
    const direct =
      rows.find((h) => h.id === id) ||
      rows.find((h) => String(h.id).toLowerCase() === id.toLowerCase()) ||
      null;
    if (direct) return direct;
    const compactId = compactOptionSymbol(restoreSymbolFromSchwabKey(id));
    return (
      rows.find((h) => compactOptionSymbol(h.symbol) === compactId) ||
      rows.find((h) => String(h.id).replace(/\s+/g, "_") === id.replace(/\s+/g, "_")) ||
      null
    );
  }

  function chartSymbolForSelectValue(val) {
    const key = normalizeHoldingSelectKey(String(val || "").trim());
    if (!key) return "";
    const h = findDisplayHoldingBySelectValue(key);
    if (h) return chartSymbolFor(h);
    if (isHoldingSelectKey(key)) {
      const tail = key.slice(8);
      const fromId = tail.replace(/^schwab_/i, "").replace(/_/g, " ");
      if (isOptionSymbol(fromId)) return parseOptionUnderlying(fromId);
      const root = tail.replace(/^schwab_/i, "").split("_")[0];
      if (root && /^[A-Z]{1,6}$/.test(root)) return root;
    }
    if (isOptionSymbol(key)) return parseOptionUnderlying(key);
    return key.toUpperCase();
  }

  function labelForSelectValue(val) {
    const h = findDisplayHoldingBySelectValue(normalizeHoldingSelectKey(val));
    if (h) {
      const sym = String(h.symbol).trim();
      const label =
        h.instrument === "option" || isOptionSymbol(sym)
          ? formatOptionLabel(sym)
          : sym;
      return label + " · holding";
    }
    const rows = getDisplayOpen();
    for (const row of rows) {
      if (holdingSelectValue(row) === val) {
        const sym = String(row.symbol).trim();
        const label =
          row.instrument === "option" || isOptionSymbol(sym)
            ? formatOptionLabel(sym)
            : sym;
        return label + " · holding";
      }
    }
    return val;
  }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function save(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function getOpen() {
    return load().filter((h) => h.status === "open");
  }

  function getClosed() {
    return load().filter((h) => h.status === "closed");
  }

  function findById(id) {
    return load().find((h) => h.id === id);
  }

  function findOpenBySymbol(symbol) {
    return load().find(
      (h) => h.status === "open" && h.symbol === String(symbol).toUpperCase()
    );
  }

  function uid() {
    return "h_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
  }

  function addHolding(data) {
    const list = load();
    const symbol = String(data.symbol || "").toUpperCase();
    if (!symbol) throw new Error("Symbol required");
    const entry = Number(data.entry_price);
    const h = {
      id: uid(),
      symbol,
      instrument: data.instrument === "option" ? "option" : "stock",
      entry_price: Number.isNaN(entry) ? null : entry,
      quantity: data.quantity != null ? Number(data.quantity) : null,
      entry_date: data.entry_date || new Date().toISOString(),
      rm_confidence: data.rm_confidence != null ? Number(data.rm_confidence) : null,
      session_id: data.session_id || null,
      notes: data.notes || "",
      status: "open",
      price_history: [
        {
          at: new Date().toISOString(),
          price: Number.isNaN(entry) ? null : entry,
          source: "entry",
        },
      ],
    };
    list.push(h);
    save(list);
    return h;
  }

  function appendPrice(symbol, price, source) {
    if (price == null || Number.isNaN(Number(price))) return null;
    const list = load();
    const sym = String(symbol).toUpperCase();
    const h = list.find((x) => x.status === "open" && x.symbol === sym);
    if (!h) return null;
    h.price_history = h.price_history || [];
    const last = h.price_history[h.price_history.length - 1];
    const p = Number(price);
    if (last && last.price === p && last.source === source) return h;
    h.price_history.push({
      at: new Date().toISOString(),
      price: p,
      source: source || "scan",
    });
    if (h.price_history.length > 120) {
      h.price_history = h.price_history.slice(-120);
    }
    save(list);
    return h;
  }

  function syncPricesFromPicks(picks) {
    if (!picks || !picks.length) return;
    const map = {};
    picks.forEach((p) => {
      if (p.symbol && p.last != null) map[p.symbol.toUpperCase()] = Number(p.last);
    });
    Object.keys(map).forEach((sym) => appendPrice(sym, map[sym], "scan"));
  }

  function currentPrice(h) {
    const hist = h.price_history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].price != null) return Number(hist[i].price);
    }
    return h.entry_price != null ? Number(h.entry_price) : null;
  }

  function calcPnL(h, mark) {
    const entry = h.entry_price != null ? Number(h.entry_price) : null;
    const px = mark != null ? Number(mark) : currentPrice(h);
    if (entry == null || px == null || entry === 0) return null;
    const qty = h.quantity != null ? Number(h.quantity) : 1;
    const pct = ((px - entry) / entry) * 100;
    const dollars = (px - entry) * qty;
    return { pct, dollars, mark: px };
  }

  function upsertFromTrade(data) {
    const symbol = String(data.symbol || "").toUpperCase();
    if (!symbol) return null;
    const entry = data.entry_price != null ? Number(data.entry_price) : null;
    const existing = findOpenBySymbol(symbol);
    if (existing) {
      if (entry != null && !Number.isNaN(entry)) {
        appendPrice(symbol, entry, "trade");
      }
      if (data.quantity != null) existing.quantity = Number(data.quantity);
      if (data.instrument) existing.instrument = data.instrument;
      if (data.rm_confidence != null) existing.rm_confidence = data.rm_confidence;
      if (data.session_id) existing.session_id = data.session_id;
      save(load());
      return existing;
    }
    return addHolding(data);
  }

  function closeHolding(id, exitPrice) {
    const list = load();
    const h = list.find((x) => x.id === id);
    if (!h) return null;
    const px = exitPrice != null ? Number(exitPrice) : currentPrice(h);
    h.status = "closed";
    h.closed_at = new Date().toISOString();
    h.exit_price = px;
    if (px != null) {
      h.price_history = h.price_history || [];
      h.price_history.push({
        at: h.closed_at,
        price: px,
        source: "exit",
      });
    }
    const pnl = calcPnL(h, px);
    h.realized_pnl_pct = pnl ? pnl.pct : null;
    save(list);
    return h;
  }

  function stats() {
    const closed = getClosed();
    const wins = closed.filter((h) => (h.realized_pnl_pct || 0) > 0);
    const losses = closed.filter((h) => (h.realized_pnl_pct || 0) < 0);
    const highRm = closed.filter((h) => (h.rm_confidence || 0) >= 50);
    const highRmWins = highRm.filter((h) => (h.realized_pnl_pct || 0) > 0);
    return {
      open: getOpen().length,
      closed: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      avgRmWin: wins.length
        ? wins.reduce((s, h) => s + (h.rm_confidence || 0), 0) / wins.length
        : null,
      avgRmLoss: losses.length
        ? losses.reduce((s, h) => s + (h.rm_confidence || 0), 0) / losses.length
        : null,
      highRmHitRate: highRm.length
        ? (highRmWins.length / highRm.length) * 100
        : null,
    };
  }

  let brokerPositions = [];

  function setBrokerPositions(positions) {
    brokerPositions = (positions || [])
      .filter((p) => p.symbol && Math.abs(Number(p.qty) || 0) > 0)
      .map((p) => {
        const symbol = String(p.symbol).trim().toUpperCase();
        const isOpt =
          String(p.assetType || "").toUpperCase() === "OPTION" || isOptionSymbol(symbol);
        const quoteSymbol = isOpt ? compactOptionSymbol(symbol) : symbol;
        return {
        id: "schwab_" + symbol.replace(/\s+/g, "_"),
        symbol,
        quoteSymbol,
        chartSymbol: chartSymbolFor({ symbol, instrument: isOpt ? "option" : "stock" }),
        instrument: isOpt ? "option" : "stock",
        entry_price: p.avgPrice != null ? Number(p.avgPrice) : null,
        quantity: Number(p.qty) || 0,
        market_value: p.marketValue != null ? Number(p.marketValue) : null,
        account: p.account || null,
        status: "open",
        source: "schwab",
        readOnly: true,
        entry_date: p.entryDate || p.openDate || new Date().toISOString(),
        notes: "",
        rm_confidence: null,
        session_id: null,
        price_history: [],
      };
      });
  }

  function getBrokerPositions() {
    return brokerPositions.slice();
  }

  function getBrokerSymbols() {
    const set = {};
    brokerPositions.forEach((p) => {
      if (p.symbol) set[p.symbol] = true;
    });
    return set;
  }

  function displayKeyForSymbol(sym, h) {
    const s = String(sym || "").trim();
    if ((h && h.instrument === "option") || isOptionSymbol(s)) {
      return formatOptionLabel(s);
    }
    return s.toUpperCase();
  }

  function chartFocusFromHolding(h) {
    if (!h) return null;
    const selectKey = holdingSelectValue(h);
    return {
      selectKey,
      quoteKey: quoteSymbolFor(h),
      displayKey: displayKeyForSymbol(h.symbol, h),
      chartKey: chartSymbolFor(h),
      kind: "holding",
      holding: h,
      symbol: chartSymbolFor(h),
    };
  }

  function chartFocusFromSelectKey(raw) {
    const key = String(raw || "").trim();
    if (!key) return null;
    if (isHoldingSelectKey(key)) {
      const norm = normalizeHoldingSelectKey(key);
      const h = findDisplayHoldingBySelectValue(norm);
      if (h) return chartFocusFromHolding(h);
    }
    const upper = key.toUpperCase().replace(/[^A-Z0-9.-]/g, "");
    if (!upper) return null;
    return {
      selectKey: upper,
      quoteKey: upper,
      displayKey: upper,
      chartKey: upper,
      kind: "pick",
      symbol: upper,
    };
  }

  function chartFocusFromPick(pick) {
    if (!pick?.symbol) return null;
    const sym = String(pick.symbol).trim();
    if (isHoldingSelectKey(sym)) {
      return chartFocusFromSelectKey(sym);
    }
    if (pick._holding) return chartFocusFromHolding(pick._holding);
    const upper = sym.toUpperCase();
    return {
      selectKey: upper,
      quoteKey: upper,
      displayKey: upper,
      chartKey: pick.chartSymbol || upper,
      kind: "pick",
      symbol: upper,
    };
  }

  /** Local thesis overlay merged with read-only Schwab broker rows. */
  function getDisplayOpen() {
    const local = getOpen();
    const localBySym = {};
    local.forEach((h) => {
      localBySym[h.symbol] = h;
    });
    const out = [];
    const seen = {};
    brokerPositions.forEach((bp) => {
      const overlay = localBySym[bp.symbol];
      seen[bp.symbol] = true;
      if (overlay) {
        out.push({
          ...bp,
          id: overlay.id,
          notes: overlay.notes,
          rm_confidence: overlay.rm_confidence,
          session_id: overlay.session_id,
          price_history: overlay.price_history,
          hasThesis: true,
        });
      } else {
        out.push({ ...bp, hasThesis: false });
      }
    });
    /* Real-only: show Schwab broker rows (+ thesis overlay), not orphan manual rows. */
    return out;
  }

  global.RMHoldings = {
    load,
    save,
    getOpen,
    getClosed,
    findById,
    findOpenBySymbol,
    addHolding,
    appendPrice,
    syncPricesFromPicks,
    currentPrice,
    calcPnL,
    closeHolding,
    upsertFromTrade,
    stats,
    setBrokerPositions,
    getBrokerPositions,
    getBrokerSymbols,
    getDisplayOpen,
    parseOptionUnderlying,
    parseOptionContract,
    formatOptionLabel,
    compactOptionSymbol,
    quoteSymbolFor,
    barsSymbolForSelectValue,
    openPositionPnl,
    isOptionSymbol,
    chartSymbolFor,
    holdingSelectValue,
    chartSymbolForSelectValue,
    labelForSelectValue,
    findDisplayHoldingBySelectValue,
    normalizeHoldingSelectKey,
    isHoldingSelectKey,
    chartFocusFromHolding,
    chartFocusFromSelectKey,
    chartFocusFromPick,
  };
})(typeof window !== "undefined" ? window : globalThis);
