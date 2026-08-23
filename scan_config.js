/** H-001 scanner criteria — editable locally, maps to MorningMomentumScanner.ts */
(function (global) {
  const STORAGE_KEY = "rainmaker_scan_config_v1";

  const DEFAULTS = {
    hypothesis_id: "H-001",
    name: "Morning Momentum",
    applyFloatPoints: true,
    volMultiple: 5,
    dailyPctMin: 10,
    movePctMin: 8,
    priceMin: 1,
    priceMax: 20,
    gapPctMin: 3,
    minScore: 50,
    weights: {
      float: 29,
      news: 24,
      vol: 19,
      move: 14,
      daily: 10,
      price: 4,
    },
    customFilters: [],
  };

  const CORE_WEIGHT_KEYS = ["float", "news", "vol", "move", "daily", "price"];
  /** Target Trades hero — five adjustable score weights (+ price band in full config). */
  const HERO_WEIGHT_KEYS = ["float", "news", "vol", "move", "daily"];

  function weightSum(weights, keys) {
    const list = keys || CORE_WEIGHT_KEYS;
    return list.reduce((s, k) => s + (Number(weights?.[k]) || 0), 0);
  }

  function heroWeightSum(weights) {
    return weightSum(weights, HERO_WEIGHT_KEYS);
  }

  function heroWeightBudget(weights) {
    const w = weights || DEFAULTS.weights;
    const price = Number(w.price);
    const pricePts = Number.isFinite(price) && price >= 0 ? price : DEFAULTS.weights.price;
    return Math.max(0, 100 - pricePts);
  }

  function defaultHeroWeights() {
    const out = {};
    HERO_WEIGHT_KEYS.forEach((k) => {
      out[k] = DEFAULTS.weights[k];
    });
    return out;
  }

  function mergeWeights(raw) {
    return { ...DEFAULTS.weights, ...(raw || {}) };
  }

  function rebalanceToTarget(weights, keys, target) {
    const out = mergeWeights(weights);
    const list = keys || HERO_WEIGHT_KEYS;
    const sum = weightSum(out, list);
    if (sum <= 0) {
      list.forEach((k) => {
        out[k] = DEFAULTS.weights[k] ?? 0;
      });
      return rebalanceToTarget(out, list, target);
    }
    if (sum === target) return out;
    let allocated = 0;
    list.forEach((k, i) => {
      if (i === list.length - 1) {
        out[k] = Math.max(0, target - allocated);
      } else {
        const v = Math.round(((Number(out[k]) || 0) / sum) * target);
        out[k] = v;
        allocated += v;
      }
    });
    return out;
  }

  /** Ensure five hero weights are valid; preserve price band weight (default +4). */
  function normalizeHeroWeights(weights) {
    const out = mergeWeights(weights);
    if (heroWeightSum(out) <= 0) {
      HERO_WEIGHT_KEYS.forEach((k) => {
        out[k] = DEFAULTS.weights[k];
      });
    }
    if (out.price == null || Number(out.price) < 0) {
      out.price = DEFAULTS.weights.price;
    }
    return out;
  }

  /** Split total equally across keys (remainder goes to last key). */
  function redistributeEqual(out, keys, total) {
    const list = keys || [];
    const n = list.length;
    if (n <= 0) return out;
    const goal = Math.max(0, Math.round(Number(total) || 0));
    const each = Math.floor(goal / n);
    let allocated = 0;
    list.forEach((k, i) => {
      if (i === n - 1) {
        out[k] = Math.max(0, goal - allocated);
      } else {
        out[k] = each;
        allocated += each;
      }
    });
    return out;
  }

  /** Redistribute listed keys so they sum to target (default 100). */
  function adjustWeight(weights, changedKey, nextVal, keys, target) {
    const list = keys || CORE_WEIGHT_KEYS;
    const goal = target != null ? target : 100;
    const out = mergeWeights(weights);
    nextVal = Math.max(0, Math.min(goal, Math.round(Number(nextVal) || 0)));
    out[changedKey] = nextVal;
    const others = list.filter((k) => k !== changedKey);
    return redistributeEqual(out, others, Math.max(0, goal - nextVal));
  }

  /** Hero sliders: moving one step redistributes the remainder equally across the other four. */
  function adjustHeroWeight(weights, changedKey, nextVal) {
    if (!HERO_WEIGHT_KEYS.includes(changedKey)) return normalizeHeroWeights(weights);
    const out = normalizeHeroWeights(weights);
    const budget = heroWeightBudget(out);
    nextVal = Math.max(0, Math.min(budget, Math.round(Number(nextVal) || 0)));
    out[changedKey] = nextVal;
    const others = HERO_WEIGHT_KEYS.filter((k) => k !== changedKey);
    redistributeEqual(out, others, Math.max(0, budget - nextVal));
    return out;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULTS);
      const cfg = { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
      cfg.weights = normalizeHeroWeights(cfg.weights);
      if (heroWeightSum(cfg.weights) < 1) {
        cfg.weights = mergeWeights(DEFAULTS.weights);
        save(cfg);
      }
      return cfg;
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  function save(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }

  function maxScore(cfg) {
    const w = cfg.weights || {};
    let sum = 0;
    if (cfg.applyFloatPoints) sum += w.float || 0;
    sum += w.news || 0;
    sum += w.vol || 0;
    sum += w.move || 0;
    sum += w.daily || 0;
    sum += w.price || 0;
    (cfg.customFilters || []).forEach((f) => {
      sum += Number(f.points) || 0;
    });
    return sum;
  }

  function thinkScriptPreview(cfg) {
    const w = cfg.weights;
    const lines = [
      "# Rainmaker " + cfg.hypothesis_id + " — " + cfg.name,
      "input applyFloatPoints = " + (cfg.applyFloatPoints ? "yes" : "no") + ";",
      "input volMultiple = " + cfg.volMultiple + ";",
      "input dailyPctMin = " + cfg.dailyPctMin + ";",
      "input movePctMin = " + cfg.movePctMin + ";",
      "input priceMin = " + cfg.priceMin + ";",
      "input priceMax = " + cfg.priceMax + ";",
      "input gapPctMin = " + cfg.gapPctMin + ";",
      "",
      "def wFloat = " + w.float + ";",
      "def wNews = " + w.news + ";",
      "def wVol = " + w.vol + ";",
      "def wMove = " + w.move + ";",
      "def wDaily = " + w.daily + ";",
      "def wPrice = " + w.price + ";",
      "",
      "# Copy criteria into Stock Hacker / ThinkScript editor",
    ];
    (cfg.customFilters || []).forEach((f, i) => {
      lines.push(
        "# Custom " + (i + 1) + ": " + f.name + " (+" + f.points + ") — " + f.rule
      );
    });
    return lines.join("\n");
  }

  function criteriaRows() {
    return [
      {
        key: "float",
        label: "Float filter (Stock Hacker)",
        hint: "Applied when float filter passes in Stock Hacker",
        weightKey: "float",
        threshold: null,
      },
      {
        key: "news",
        label: "News proxy",
        hint: "Gap-up ≥ gapPctMin OR (volume spike AND daily ≥ 5%)",
        weightKey: "news",
        thresholdKey: "gapPctMin",
        thresholdLabel: "Min gap %",
      },
      {
        key: "vol",
        label: "Volume surge",
        hint: "Today vol ≥ volMultiple × 30-day avg",
        weightKey: "vol",
        thresholdKey: "volMultiple",
        thresholdLabel: "Vol multiple",
      },
      {
        key: "move",
        label: "Intraday move",
        hint: "Daily % change threshold",
        weightKey: "move",
        thresholdKey: "movePctMin",
        thresholdLabel: "Min move %",
      },
      {
        key: "daily",
        label: "Daily momentum",
        hint: "Strong daily % change",
        weightKey: "daily",
        thresholdKey: "dailyPctMin",
        thresholdLabel: "Min daily %",
      },
      {
        key: "price",
        label: "Price band",
        hint: "Share price within min/max",
        weightKey: "price",
        thresholdKeys: ["priceMin", "priceMax"],
        thresholdLabel: "Min / max $",
      },
    ];
  }

  global.RMScanConfig = {
    DEFAULTS,
    CORE_WEIGHT_KEYS,
    HERO_WEIGHT_KEYS,
    load,
    save,
    maxScore,
    weightSum,
    heroWeightSum,
    heroWeightBudget,
    defaultHeroWeights,
    adjustWeight,
    adjustHeroWeight,
    normalizeHeroWeights,
    thinkScriptPreview,
    criteriaRows,
  };
})(typeof window !== "undefined" ? window : globalThis);
