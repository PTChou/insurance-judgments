(function (global) {
  "use strict";

  const PRESET_CATEGORY = {
    life: "人壽/意外/健康",
    prop: "財產保險",
    auto: "汽車保險",
    subrog: "代位求償",
    social: "社會保險",
    todo: "待分類"
  };

  function normalize(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "");
  }
  const LEGAL_RE = /[第條項款]/g;

  // records: 已展開的列物件（含 iso 日期）。全文（digest/factSummary）可之後以 addFullText 補進來。
  function createEngine(records) {
    const byCategory = new Map();
    const byIdx = new Map();
    const entries = records.map((row) => {
      const base = normalize([
        row.court, row.caseno, row.cause, row.category, row.note, row.sr,
        ...(row.laws || []), ...(row.disputeTypes || []), ...(row.claimTopics || []), row.outcome || ""
      ].join("\u0000"));
      const entry = {
        row,
        base,
        legal: base.replace(LEGAL_RE, ""),
        full: "",
        caseno: normalize(row.caseno),
        court: normalize(row.court),
        cause: normalize(row.cause)
      };
      const category = row.category || "";
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(entry);
      byIdx.set(row.idx, entry);
      return entry;
    });

    const presetCounts = Object.fromEntries(
      Object.entries(PRESET_CATEGORY).map(([preset, category]) => [preset, byCategory.get(category)?.length || 0])
    );
    presetCounts.all = entries.length;
    let cache = new Map();

    function addFullText(idx, text) {
      const e = byIdx.get(idx);
      if (!e || !text) return;
      e.full = normalize(text);
    }
    function clearCache() { cache = new Map(); }

    function search(criteria = {}) {
      const bookmarks = criteria.bookmarks instanceof Set ? criteria.bookmarks : new Set(criteria.bookmarks || []);
      const key = JSON.stringify([
        criteria.q || "", criteria.scope || "all", criteria.dateFrom || "", criteria.dateTo || "",
        criteria.cat || "", criteria.doc || "", criteria.dispute || "", criteria.claimTopic || "",
        criteria.outcome || "", criteria.preset || "all",
        criteria.preset === "bookmarks" ? [...bookmarks].sort() : []
      ]);
      const cached = cache.get(key);
      if (cached) return cached;

      const presetCategory = PRESET_CATEGORY[criteria.preset];
      const category = criteria.cat && criteria.cat !== "__ANY__" ? criteria.cat : presetCategory;
      const source = category ? (byCategory.get(category) || []) : entries;
      const needle = normalize(criteria.q);
      const legalNeedle = needle.replace(LEGAL_RE, "");
      const scope = ["all", "caseno", "court", "cause"].includes(criteria.scope) ? criteria.scope : "all";
      const result = [];

      for (const entry of source) {
        const row = entry.row;
        if (criteria.preset === "bookmarks" && !bookmarks.has(row.idx)) continue;
        if (criteria.doc && !String(row.doctype || "").includes(criteria.doc)) continue;
        if (criteria.dispute && !(row.disputeTypes || []).includes(criteria.dispute)) continue;
        if (criteria.claimTopic && !(row.claimTopics || []).includes(criteria.claimTopic)) continue;
        if (criteria.outcome && row.outcome !== criteria.outcome) continue;
        if (criteria.dateFrom && row.iso && row.iso < criteria.dateFrom) continue;
        if (criteria.dateTo && row.iso && row.iso > criteria.dateTo) continue;
        if (needle) {
          if (scope === "all") {
            const hit = entry.base.includes(needle) ||
              (entry.full && entry.full.includes(needle)) ||
              (legalNeedle && entry.legal.includes(legalNeedle));
            if (!hit) continue;
          } else if (!entry[scope].includes(needle)) continue;
        }
        result.push(row);
      }
      cache.set(key, result);
      return result;
    }

    return { search, presetCounts, addFullText, clearCache, normalize };
  }

  global.JudgmentSearch = { createEngine, normalize };
})(window);
