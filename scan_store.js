/** Persist scan sessions in localStorage calendar (production DB later). */
(function (global) {
  const KEY = "rainmaker_scan_calendar_v1";
  const MAX_DAYS = 400;
  const SEARCH_LIMIT = 500;
  const LIST_LIMIT = 2000;

  function loadAll() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveAll(data) {
    const keys = Object.keys(data).sort();
    while (keys.length > MAX_DAYS) {
      delete data[keys.shift()];
    }
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function dayKey(iso) {
    return String(iso || new Date().toISOString()).slice(0, 10);
  }

  function entryId(session) {
    const sid = String(session?.session_id || "scan").trim();
    const at = String(session?.scanned_at || "").trim();
    return at ? sid + "--" + at : sid + "--" + Date.now();
  }

  function summarizeSession(session) {
    return {
      session_id: session.session_id,
      scanned_at: session.scanned_at,
      entry_type: session.entry_type || null,
      source_kind: session.source_kind || null,
      source_file: session.source_file,
      session_label: session.session_label,
      pick_count: session.pick_count,
      hypothesis_id: session.hypothesis_id,
      news_scanned_at: session.news_scanned_at || null,
      accuracy: session.accuracy || null,
      closed_trades: session.closed_trades || null,
      picks: (session.picks || []).map((p) => ({
        symbol: p.symbol,
        rank: p.rank,
        rm_confidence: p.rm_confidence,
        last: p.last,
        pct_change: p.pct_change,
        gap_pct: p.gap_pct,
        pct_eod: p.pct_eod,
        catalyst: p.catalyst
          ? {
              status: p.catalyst.status,
              verified: p.catalyst.verified,
              headline: p.catalyst.headline,
              source_url: p.catalyst.source_url || null,
              headlines: (p.catalyst.headlines || []).slice(0, 6).map((h) => ({
                title: h.title,
                url: h.url || null,
              })),
            }
          : null,
      })),
      filtered_out: session.filtered_out || [],
    };
  }

  function saveSession(session, opts) {
    if (!session?.session_id) return null;
    const data = loadAll();
    const dk = dayKey(session.scanned_at);
    const list = data[dk] || [];
    const id = opts?.entryId || entryId(session);
    const snap = summarizeSession(session);
    const entry = {
      id,
      saved_at: new Date().toISOString(),
      entry_type: opts?.entryType || session.entry_type || "session",
      source_kind: opts?.sourceKind || session.source_kind || "scan",
      summary: snap,
      session: snap,
    };
    const idx = list.findIndex((e) => e.id === id);
    if (idx >= 0) list[idx] = entry;
    else list.unshift(entry);
    data[dk] = list;
    saveAll(data);
    return entry;
  }

  function listDays() {
    return Object.keys(loadAll()).sort().reverse();
  }

  function getDay(dateKey) {
    return loadAll()[dateKey] || [];
  }

  function listAllEntries(limit) {
    const cap = limit == null ? LIST_LIMIT : limit;
    const out = [];
    const data = loadAll();
    for (const dk of Object.keys(data).sort().reverse()) {
      for (const entry of data[dk]) {
        out.push({ dateKey: dk, entry });
      }
    }
    out.sort((a, b) => {
      const ta = a.entry.summary?.scanned_at || a.entry.saved_at || "";
      const tb = b.entry.summary?.scanned_at || b.entry.saved_at || "";
      return tb.localeCompare(ta);
    });
    return cap > 0 ? out.slice(0, cap) : out;
  }

  function countEntries() {
    let n = 0;
    const data = loadAll();
    for (const dk of Object.keys(data)) n += (data[dk] || []).length;
    return n;
  }

  function search(query) {
    const q = String(query || "")
      .trim()
      .toLowerCase();
    if (!q) return listAllEntries(SEARCH_LIMIT);
    const out = [];
    const data = loadAll();
    for (const dk of Object.keys(data).sort().reverse()) {
      for (const entry of data[dk]) {
        const syms = (entry.summary?.picks || [])
          .map((p) => p.symbol)
          .join(" ");
        const blob =
          dk +
          " " +
          (entry.summary?.session_id || "") +
          " " +
          (entry.summary?.source_file || "") +
          " " +
          (entry.summary?.session_label || "") +
          " " +
          syms;
        if (blob.toLowerCase().includes(q)) {
          out.push({ dateKey: dk, entry });
        }
      }
    }
    out.sort((a, b) => {
      const ta = a.entry.summary?.scanned_at || "";
      const tb = b.entry.summary?.scanned_at || "";
      return tb.localeCompare(ta);
    });
    return out.slice(0, SEARCH_LIMIT);
  }

  function loadEntry(dateKey, entryId) {
    const list = getDay(dateKey);
    const hit = list.find((e) => e.id === entryId);
    return hit?.session || null;
  }

  function hasEntry(session) {
    const id = entryId(session);
    const dk = dayKey(session.scanned_at);
    return (getDay(dk) || []).some((e) => e.id === id);
  }

  function importSession(session) {
    if (!session?.session_id || !session?.picks?.length) return false;
    if (hasEntry(session)) return false;
    saveSession(session);
    return true;
  }

  async function fetchJson(url) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Pull sessions/manifest.json + session.json into local calendar. */
  async function syncPublishedCatalog(baseHref) {
    const base = baseHref || (typeof location !== "undefined" ? location.href : "");
    let imported = 0;
    const root = new URL(base);

    const manifest = await fetchJson(new URL("sessions/manifest.json", root).href);
    if (manifest?.sessions?.length) {
      for (const row of manifest.sessions) {
        const file = row.output || row.session_id + ".json";
        const data = await fetchJson(new URL("sessions/" + file, root).href);
        if (data && importSession(data)) imported++;
      }
    }

    const latest = await fetchJson(new URL("session.json", root).href);
    if (latest && importSession(latest)) imported++;

    return { imported, total: countEntries() };
  }

  global.RMScanStore = {
    saveSession,
    listDays,
    getDay,
    listAllEntries,
    countEntries,
    search,
    loadEntry,
    importSession,
    syncPublishedCatalog,
    entryId,
    dayKey,
  };
})(typeof window !== "undefined" ? window : globalThis);
