/**
 * Morning metrics - Phase 0 instrumentation substrate.
 *
 * A tiny, dependency-free event log so we can measure the product's north-star:
 *   Morning Active Rate = % of trading days the verdict is opened BEFORE 9:30 ET.
 * Secondary:
 *   Conviction-Follow Rate = % of non-neutral-verdict days a trade was also opened
 *   (v0 approximation - refine once trade side/direction is tracked).
 *
 * Storage: localStorage ring buffer `rm_events_v1` (500-event cap), mirroring the
 * `rm_morning_bias_log_v1` pattern. Optionally beacons each event to rm_api at
 * `/metrics/event` (best-effort, non-blocking, silently ignored if unavailable).
 *
 * Events: morning_open ? verdict_view ? trade_open ? trade_close.
 * `morning_open` and `verdict_view` are deduped to the FIRST occurrence per ET day
 * (so Active Rate is day-accurate and the buffer stays clean). Trades log every time.
 */
(function (global) {
  const STORAGE_KEY = "rm_events_v1";
  const MAX_EVENTS = 500;
  const ET_TZ = "America/New_York";
  const MARKET_OPEN_MIN = 9 * 60 + 30; // 9:30 ET

  /* ---- ET time helpers ---- */
  function etParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ET_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date || new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    let hour = Number(get("hour"));
    if (hour === 24) hour = 0; // some engines emit 24 at midnight
    const minute = Number(get("minute"));
    return {
      etDate: `${get("year")}-${get("month")}-${get("day")}`,
      weekday: get("weekday"),
      etMin: hour * 60 + minute,
    };
  }

  function isWeekday(weekday) {
    return weekday !== "Sat" && weekday !== "Sun";
  }

  /* ---- storage ---- */
  function load() {
    try {
      const raw = global.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function save(list) {
    try {
      const trimmed = list.slice(-MAX_EVENTS);
      global.localStorage?.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch (_) {
      /* quota / disabled storage - metrics are best-effort */
    }
  }

  /* ---- rm_api beacon (best-effort) ---- */
  function apiBase() {
    try {
      const meta = document.querySelector('meta[name="rainmaker-api-base"]');
      if (meta?.content?.trim()) return meta.content.trim().replace(/\/$/, "");
      const stored = global.localStorage?.getItem("rainmaker_api_base");
      if (stored) return String(stored).replace(/\/$/, "");
    } catch (_) {
      /* ignore */
    }
    const h = global.location?.hostname;
    if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8765";
    return "";
  }

  function beacon(ev) {
    const base = apiBase();
    if (!base) return;
    try {
      const url = base + "/metrics/event";
      const body = JSON.stringify(ev);
      if (global.navigator?.sendBeacon) {
        global.navigator.sendBeacon(url, body);
        return;
      }
      global.fetch?.(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (_) {
      /* endpoint may not exist yet - that's fine */
    }
  }

  /* ---- core ---- */
  function track(type, data) {
    if (!type) return null;
    const now = new Date();
    const { etDate, weekday, etMin } = etParts(now);
    const ev = {
      type,
      t: now.getTime(),
      iso: now.toISOString(),
      etDate,
      weekday,
      etMin,
      ...(data && typeof data === "object" ? data : {}),
    };
    const list = load();
    list.push(ev);
    save(list);
    beacon(ev);
    return ev;
  }

  function hasEventToday(type, etDate) {
    return load().some((e) => e.type === type && e.etDate === etDate);
  }

  /** Log the first verdict open of the ET day (deduped). */
  function markMorningOpen(meta) {
    const { etDate } = etParts();
    if (hasEventToday("morning_open", etDate)) return null;
    return track("morning_open", { ...(meta || {}) });
  }

  /** Log the first resolved verdict shown today (deduped). */
  function markVerdictView(verdict) {
    const { etDate } = etParts();
    if (hasEventToday("verdict_view", etDate)) return null;
    const tier = verdict?.tier || "neutral";
    const heat = Number(verdict?.heat ?? 0);
    return track("verdict_view", {
      tier,
      heat,
      direction: heat > 0 ? "bull" : heat < 0 ? "bear" : "neutral",
      mode: verdict?.mode || "auto",
    });
  }

  /** Snapshot the green-light contract at the moment a trade is opened. */
  function greenLitSnapshot() {
    try {
      const kpi =
        global.RMColumnKPI?.compute?.() ||
        global.RMHeaderMood?.getState?.()?.kpi ||
        null;
      if (!kpi) return {};
      return {
        green_lit: kpi.charge,
        c1_score: kpi.c1?.score ?? null,
        c2_score: kpi.c2?.score ?? null,
        c3_score: kpi.c3?.score ?? null,
        c1_lit: !!kpi.c1?.greenLit,
        c2_lit: !!kpi.c2?.greenLit,
        c3_lit: !!kpi.c3?.greenLit,
      };
    } catch (_) {
      return {};
    }
  }

  function markTradeOpen(trade) {
    return track("trade_open", {
      symbol: trade?.symbol || null,
      side: trade?.side || "long",
      session_id: trade?.session_id || null,
      ...greenLitSnapshot(),
    });
  }

  function markTradeClose(trade) {
    return track("trade_close", {
      symbol: trade?.symbol || null,
      filled: trade?.filled !== false,
      r_multiple: trade?.r_multiple ?? null,
      source: trade?.source || null,
    });
  }

  /* ---- metrics ---- */
  function dayKeysBack(nDays) {
    const keys = [];
    const today = new Date();
    for (let i = 0; i < nDays; i++) {
      const d = new Date(today.getTime() - i * 86400000);
      const { etDate, weekday } = etParts(d);
      keys.push({ etDate, weekday });
    }
    return keys;
  }

  /**
   * Morning Active Rate over the last `nDays` calendar days.
   * Denominator = ET weekdays in the window (holidays ignored - v0).
   * Numerator   = those weekdays with a morning_open before 9:30 ET.
   */
  function activeRate(nDays = 20) {
    const events = load();
    const window = dayKeysBack(nDays).filter((d) => isWeekday(d.weekday));
    const weekdays = window.length;
    if (!weekdays) return { rate: 0, hit: 0, weekdays: 0, nDays };
    const dates = new Set(window.map((d) => d.etDate));
    const hitDates = new Set();
    for (const e of events) {
      if (e.type !== "morning_open") continue;
      if (!dates.has(e.etDate)) continue;
      if (e.etMin != null && e.etMin < MARKET_OPEN_MIN) hitDates.add(e.etDate);
    }
    return {
      rate: hitDates.size / weekdays,
      hit: hitDates.size,
      weekdays,
      nDays,
    };
  }

  /**
   * Conviction-Follow Rate (v0): of ET days with a non-neutral verdict_view,
   * the fraction that also recorded a trade_open.
   */
  function convictionFollowRate(nDays = 30) {
    const events = load();
    const dates = new Set(dayKeysBack(nDays).map((d) => d.etDate));
    const verdictDays = new Map(); // etDate -> direction
    const tradeDays = new Set();
    for (const e of events) {
      if (!dates.has(e.etDate)) continue;
      if (e.type === "verdict_view" && e.direction && e.direction !== "neutral") {
        if (!verdictDays.has(e.etDate)) verdictDays.set(e.etDate, e.direction);
      }
      if (e.type === "trade_open") tradeDays.add(e.etDate);
    }
    const eligible = verdictDays.size;
    if (!eligible) return { rate: 0, followed: 0, eligible: 0, nDays };
    let followed = 0;
    for (const d of verdictDays.keys()) if (tradeDays.has(d)) followed++;
    return { rate: followed / eligible, followed, eligible, nDays };
  }

  /**
   * Green-light validation (#5): does diligence pay?
   * Correlates each closed trade with the green-light count stamped at open
   * (matching the most recent unmatched trade_open for the same symbol), then
   * buckets win% / avg R by 0-3 lit columns. This is the data proof artifact.
   */
  function greenLitValidation(nDays = 120) {
    const events = load();
    const dates = new Set(dayKeysBack(nDays).map((d) => d.etDate));
    const openStack = new Map(); // symbol -> [open events]
    const buckets = {
      0: { n: 0, wins: 0, sumR: 0, rs: [] },
      1: { n: 0, wins: 0, sumR: 0, rs: [] },
      2: { n: 0, wins: 0, sumR: 0, rs: [] },
      3: { n: 0, wins: 0, sumR: 0, rs: [] },
    };
    for (const e of events) {
      if (!dates.has(e.etDate)) continue;
      const sym = e.symbol || "?";
      if (e.type === "trade_open") {
        if (!openStack.has(sym)) openStack.set(sym, []);
        openStack.get(sym).push(e);
      } else if (e.type === "trade_close") {
        const stack = openStack.get(sym);
        const open = stack && stack.length ? stack.pop() : null;
        if (e.filled === false) continue;
        const r = e.r_multiple;
        if (r == null || Number.isNaN(Number(r))) continue;
        const lit = Math.max(0, Math.min(3, Number(open?.green_lit ?? 0)));
        const b = buckets[lit];
        b.n++;
        if (Number(r) > 0) b.wins++;
        b.sumR += Number(r);
        b.rs.push(Number(r));
      }
    }
    const out = {};
    let total = 0;
    for (const k of [0, 1, 2, 3]) {
      const b = buckets[k];
      total += b.n;
      out[k] = {
        lit: k,
        trades: b.n,
        winRate: b.n ? b.wins / b.n : null,
        avgR: b.n ? b.sumR / b.n : null,
      };
    }
    return { buckets: out, total, nDays };
  }

  function summary(nDays = 20) {
    const events = load();
    const ar = activeRate(nDays);
    const cf = convictionFollowRate(Math.max(nDays, 30));
    const lastOpen = [...events].reverse().find((e) => e.type === "morning_open");
    return {
      totalEvents: events.length,
      activeRate: ar,
      convictionFollowRate: cf,
      lastOpen: lastOpen?.iso || null,
    };
  }

  function getEvents() {
    return load();
  }

  function clear() {
    try {
      global.localStorage?.removeItem(STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  global.RMMetrics = {
    track,
    markMorningOpen,
    markVerdictView,
    markTradeOpen,
    markTradeClose,
    activeRate,
    convictionFollowRate,
    greenLitValidation,
    summary,
    getEvents,
    clear,
    STORAGE_KEY,
  };
})(typeof window !== "undefined" ? window : globalThis);
