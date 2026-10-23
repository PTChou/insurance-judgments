"use strict";
/* 保險裁判知識庫（拆檔加速版）
 * 啟動只下載輕量索引 data/index.json；判決全文／摘要分塊存放在 data/d/*.json，
 * 點開詳情或做「全文」關鍵字搜尋時才按需載入，並由瀏覽器快取。 */

const VER = window.BUILD_VERSION || "dev";
const OFFICIAL_BASE = "https://judgment.judicial.gov.tw/FJUD/data.aspx?ty=JD&id=";

let DATA = [];
let DATA_BY_IDX = new Map();
let SEARCH_ENGINE = null;
let PRESET_COUNTS = {};
let LAST_UPDATE = "";
let CHUNK_COUNT = 0;
const chunkCache = new Map();      // k -> Promise<object>
const detailCache = new Map();     // idx -> detail object
let fullTextState = "idle";        // idle | loading | ready
let fullTextLoaded = 0;

const state = {
  q: "", scope: "all", dateFrom: "", dateTo: "", cat: "", doc: "", dispute: "", claimTopic: "", outcome: "",
  sortKey: "date", sortDir: "desc",
  selectedIdx: null,
  preset: "all",
  expandedGroups: new Set(),
  page: 1,
  view: "dashboard"
};
const PAGE_SIZE = 100;
let _lastFilterSig = null;

const $ = (id) => document.getElementById(id);

function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ---------- 本機儲存 ---------- */
function lsGet(key, fallback){ try{ const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }catch(e){ return fallback; } }
function lsSet(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }
function loadFolders(){ const f = lsGet("ins_folders", []); return Array.isArray(f) ? f : []; }
function saveFolders(f){ lsSet("ins_folders", f); _folderCountCache = null; }
function loadBookmarks(){ const b = lsGet("ins_bookmarks", []); return Array.isArray(b) ? b.map(String) : []; }
function saveBookmarks(b){ lsSet("ins_bookmarks", b); }
function loadHistory(){ const h = lsGet("ins_history", []); return Array.isArray(h) ? h : []; }
function pushHistory(q, scope){
  if(!q) return;
  const h = loadHistory().filter(x => !(x.q === q && x.scope === scope));
  h.unshift({ q, scope, t: Date.now() });
  lsSet("ins_history", h.slice(0, 30));
}

/* ---------- 資料載入 ---------- */
function setLoading(text){ const el = $("loadingText"); if(el) el.textContent = text; }

async function fetchJSON(url){
  const res = await fetch(url, { cache: "force-cache" });
  if(!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

function dateToISO(d){
  const m = String(d || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if(!m) return "";
  const y = parseInt(m[1],10) + 1911;
  return `${y}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
}

function expandRows(pack){
  const D = pack.dict;
  const pick = (arr, i) => (i == null || i < 0) ? "" : arr[i];
  const list = (arr, v) => Array.isArray(v) ? v.map(i => arr[i]) : [];
  return pack.rows.map(a => {
    const urlId = a[10] || "";
    return {
      idx: String(a[0]),
      court: pick(D.court, a[1]),
      caseno: a[2] || "",
      doctype: pick(D.doctype, a[3]),
      date: a[4] || "",
      iso: dateToISO(a[4]),
      cause: pick(D.cause, a[5]),
      is_judgment: pick(D.isj, a[6]),
      category: pick(D.category, a[7]) || "待分類",
      note: a[8] || "",
      sr: a[9] || "",
      urlId,
      officialUrl: urlId ? OFFICIAL_BASE + encodeURIComponent(urlId) + "&ot=in" : "",
      related: Array.isArray(a[11]) ? a[11] : [],
      disputeTypes: list(D.dispute, a[12]),
      claimTopics: list(D.topic, a[13]),
      outcome: pick(D.outcome, a[14]) || null,
      laws: Array.isArray(a[15]) ? a[15] : [],
      k: a[16]
    };
  });
}

function loadChunk(k){
  if(!chunkCache.has(k)){
    const p = fetchJSON(`data/d/${k}.json?v=${VER}`).then(obj => {
      Object.entries(obj).forEach(([idx, det]) => detailCache.set(idx, det));
      return obj;
    }).catch(err => { chunkCache.delete(k); throw err; });
    chunkCache.set(k, p);
  }
  return chunkCache.get(k);
}

async function getDetail(row){
  if(detailCache.has(row.idx)) return detailCache.get(row.idx);
  await loadChunk(row.k);
  return detailCache.get(row.idx) || {};
}

/* 全文搜尋：第一次用「全文」範圍搜尋關鍵字時，才在背景載入全部判決內文 */
async function ensureFullText(){
  if(fullTextState !== "idle") return;
  fullTextState = "loading";
  fullTextLoaded = 0;
  updateStatText();
  const ks = Array.from({length: CHUNK_COUNT}, (_, i) => i);
  let next = 0;
  async function worker(){
    while(next < ks.length){
      const k = ks[next++];
      try{
        const obj = await loadChunk(k);
        Object.entries(obj).forEach(([idx, det]) => {
          SEARCH_ENGINE.addFullText(idx, (det.dg || "") + "\u0000" + (det.fs || ""));
        });
      }catch(e){ console.warn("chunk failed", k, e); }
      fullTextLoaded++;
      if(fullTextLoaded % 5 === 0) updateStatText();
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  fullTextState = "ready";
  SEARCH_ENGINE.clearCache();
  _folderCountCache = null;
  if(state.view !== "dashboard") render(); else updateStatText();
}

/* ---------- 顯示輔助 ---------- */
function catTag(cat){
  if(cat === "人壽/意外/健康") return '<span class="tag tag-life">人身保險</span>';
  if(cat === "財產保險") return '<span class="tag tag-prop">財產保險</span>';
  if(cat === "汽車保險") return '<span class="tag tag-auto">汽車保險</span>';
  if(cat === "代位求償") return '<span class="tag tag-sub">代位求償</span>';
  if(cat === "社會保險") return '<span class="tag tag-soc">社會保險</span>';
  if(cat === "醫療糾紛") return '<span class="tag tag-med">醫療糾紛</span>';
  if(cat === "個人保險糾紛") return '<span class="tag tag-person">個人保險糾紛</span>';
  return '<span class="tag tag-none">待分類</span>';
}
function outcomeTag(outcome){
  if(outcome === "保險公司勝") return '<span class="outcome-tag outcome-insurer">保險公司勝</span>';
  if(outcome === "保戶勝") return '<span class="outcome-tag outcome-holder">保戶勝</span>';
  if(outcome === "部分勝敗") return '<span class="outcome-tag outcome-partial">部分勝敗</span>';
  return "";
}
function cleanDigest(t){
  if(!t) return "";
  let s = String(t);
  s = s.replace(/資料來源\s*[：:]\s*https?:\/\/\S+/g, "");
  s = s.replace(/https?:\/\/\S+/g, "");
  s = s.replace(/\s{2,}/g, " ").replace(/[\s、，,。\-–—|]+$/g, "").trim();
  return s;
}
function shortResult(row){
  if(row.sr) return row.sr;
  if(row.is_judgment === "否") return "程序性裁定，非實體判決結果";
  return "尚未下載摘要，請點官方連結查看全文";
}

/* ---------- 篩選 ---------- */
const PRESETS = { life:"人壽/意外/健康", prop:"財產保險", auto:"汽車保險", subrog:"代位求償", social:"社會保險", todo:"待分類" };
function applyPreset(row, preset){
  if(preset === "all") return true;
  if(PRESETS[preset]) return row.category === PRESETS[preset];
  const f = loadFolders().find(x => x.id === preset);
  return f ? matchFilter(row, f.filter) : true;
}
function matchFilter(row, f){
  if(!f) return true;
  if(f.cat && row.category !== f.cat) return false;
  if(f.doc && String(row.doctype).indexOf(f.doc) === -1) return false;
  if(f.dispute && !row.disputeTypes.includes(f.dispute)) return false;
  if(f.outcome && row.outcome !== f.outcome) return false;
  if(f.q){
    const n = SEARCH_ENGINE.normalize(f.q);
    const det = detailCache.get(row.idx);
    const hay = SEARCH_ENGINE.normalize(row.court + row.caseno + row.cause + row.note + row.sr + (det ? det.dg || "" : ""));
    if(hay.indexOf(n) === -1) return false;
  }
  return true;
}
function getFiltered(){
  const customFolder = loadFolders().find(f => f.id === state.preset);
  const rows = SEARCH_ENGINE.search({
    q: state.q, scope: state.scope, dateFrom: state.dateFrom, dateTo: state.dateTo,
    cat: state.cat, doc: state.doc, dispute: state.dispute, claimTopic: state.claimTopic, outcome: state.outcome,
    preset: customFolder ? "all" : state.preset, bookmarks: new Set(loadBookmarks())
  });
  return customFolder ? rows.filter(row => matchFilter(row, customFolder.filter)) : rows;
}
function sortRows(rows){
  const k = state.sortKey === "date" ? "iso" : state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  return rows.slice().sort((a,b) => {
    const av = a[k] || "", bv = b[k] || "";
    return av < bv ? -dir : (av > bv ? dir : 0);
  });
}

/* ---------- 同案歷審分組 ---------- */
const GROUP_COLORS = ["#0b47a1","#00794a","#c2410c","#7c3aed","#be185d","#0891b2","#a16207","#4d7c0f","#b91c1c","#0f766e","#9333ea","#ca8a04"];
function groupColor(gkey){
  let h = 0; const s = String(gkey);
  for(let i=0;i<s.length;i++){ h = (h*31 + s.charCodeAt(i)) >>> 0; }
  return GROUP_COLORS[h % GROUP_COLORS.length];
}
let _groupCache = null;
function computeGroups(){
  if(_groupCache) return _groupCache;
  const keyToIdx = new Map();
  DATA.forEach(r => { if(r.urlId) keyToIdx.set(r.urlId, r.idx); });
  const parent = new Map();
  DATA.forEach(r => parent.set(r.idx, r.idx));
  function find(x){
    let root = x;
    while(parent.get(root) !== root) root = parent.get(root);
    while(parent.get(x) !== root){ const n = parent.get(x); parent.set(x, root); x = n; }
    return root;
  }
  DATA.forEach(r => r.related.forEach(rk => {
    const o = keyToIdx.get(rk);
    if(o && o !== r.idx){ const a = find(r.idx), b = find(o); if(a !== b) parent.set(a, b); }
  }));
  const groups = new Map();
  DATA.forEach(r => { const root = find(r.idx); if(!groups.has(root)) groups.set(root, []); groups.get(root).push(r.idx); });
  const idxToGroup = new Map();
  groups.forEach(list => { if(list.length > 1) list.forEach(i => idxToGroup.set(i, list)); });
  _groupCache = idxToGroup;
  return idxToGroup;
}

/* ---------- 清單 ---------- */
function updateStatText(count){
  const el = $("statText");
  if(!el) return;
  if(typeof count === "number") el.dataset.count = count;
  const c = el.dataset.count ?? "0";
  let ft = "";
  if(state.q && state.scope === "all"){
    if(fullTextState === "loading") ft = `<span class="ft-note">⏳ 正在載入判決全文以搜尋內文（${fullTextLoaded}/${CHUNK_COUNT}）…</span>`;
    else if(fullTextState === "ready") ft = `<span class="ft-note">✓ 已含判決全文</span>`;
  }
  el.innerHTML = `共 ${esc(c)} 筆裁判（資料庫總計 ${DATA.length} 筆，最後更新：${esc(LAST_UPDATE)}）${ft}`;
}

function renderPager(page, totalPages){
  const el = $("pager");
  if(!el) return;
  if(totalPages <= 1){ el.innerHTML = ""; return; }
  el.innerHTML = `<button data-pg="first" ${page<=1?"disabled":""}>&laquo; 第一頁</button><button data-pg="prev" ${page<=1?"disabled":""}>&lsaquo; 上一頁</button><span class="pager-info">第 ${page} / ${totalPages} 頁</span><button data-pg="next" ${page>=totalPages?"disabled":""}>下一頁 &rsaquo;</button><button data-pg="last" ${page>=totalPages?"disabled":""}>最後一頁 &raquo;</button>`;
  el.onclick = (e) => {
    const b = e.target.closest("[data-pg]"); if(!b || b.disabled) return;
    const a = b.dataset.pg;
    state.page = a === "first" ? 1 : a === "prev" ? Math.max(1, state.page-1) : a === "next" ? Math.min(totalPages, state.page+1) : totalPages;
    render();
    $("tableWrap").scrollTop = 0;
  };
}

function render(){
  if(!SEARCH_ENGINE) return;
  renderFolders();
  const _sig = JSON.stringify([state.q,state.scope,state.cat,state.doc,state.dispute,state.claimTopic,state.outcome,state.dateFrom,state.dateTo,state.preset,state.sortKey,state.sortDir]);
  if(_sig !== _lastFilterSig){ state.page = 1; _lastFilterSig = _sig; }
  const filtered = sortRows(getFiltered());
  updateStatText(filtered.length);
  const tbody = $("tbody");
  const bookmarks = new Set(loadBookmarks());
  if(filtered.length === 0){
    tbody.innerHTML = "";
    $("noResults").style.display = "block";
    renderPager(0,0);
  } else {
    $("noResults").style.display = "none";
    const groupMap = computeGroups();
    const filteredIdxSet = new Set(filtered.map(r => r.idx));
    const rendered = new Set();
    const ordered = [];
    filtered.forEach(row => {
      if(rendered.has(row.idx)) return;
      const g = groupMap.get(row.idx);
      if(!g){ ordered.push({ row, depth:0, groupSize:1, gkey:row.idx, expanded:false }); rendered.add(row.idx); return; }
      const groupRows = g.filter(i => filteredIdxSet.has(i)).map(i => DATA_BY_IDX.get(i)).filter(Boolean)
        .sort((a,b) => a.iso < b.iso ? -1 : (a.iso > b.iso ? 1 : 0));
      const gkey = groupRows[0].idx;
      const expanded = state.expandedGroups.has(gkey);
      groupRows.forEach((gr, gi) => {
        rendered.add(gr.idx);
        if(gi > 0 && !expanded) return;
        ordered.push({ row: gr, depth: gi===0?0:1, groupSize: groupRows.length, gkey, expanded });
      });
    });
    const totalPages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    const pageItems = ordered.slice((state.page-1)*PAGE_SIZE, state.page*PAGE_SIZE);
    tbody.innerHTML = pageItems.map(({row, depth, groupSize, gkey, expanded}) => {
      const star = bookmarks.has(row.idx) ? "star on" : "star";
      const docBadge = String(row.doctype).indexOf("判決") > -1 ? "doc-badge judg" : "doc-badge";
      const isGrouped = groupSize > 1;
      const color = isGrouped ? groupColor(gkey) : null;
      const linkBadge = (depth===0 && isGrouped)
        ? `<button class="rel-badge" data-toggle-group="${esc(gkey)}" style="background:${color}22;color:${color};border-color:${color};" title="偵測到 ${groupSize} 筆同一案件不同審級的判決，點擊${expanded?'收合':'展開'}">${expanded?'▾':'▸'} 同案歷審 ${groupSize} 筆</button>`
        : "";
      const caseCell = depth>0
        ? `<span class="caseno-link rel-sub">└ ${esc(row.caseno)}</span>`
        : `<span class="caseno-link">${esc(row.caseno)}</span>${linkBadge}`;
      const rowStyle = isGrouped ? `style="border-left:4px solid ${color};"` : "";
      const dTags = row.disputeTypes.length ? `<br>${row.disputeTypes.map(t => `<span class="dispute-tag" style="font-size:10px;padding:2px 7px;margin-top:3px;">${esc(t)}</span>`).join("")}` : "";
      const tTags = row.claimTopics.length ? `<br>${row.claimTopics.map(t => `<span class="topic-tag" style="font-size:10px;padding:2px 7px;margin-top:3px;">${esc(t)}</span>`).join("")}` : "";
      return `<tr data-idx="${esc(row.idx)}" class="${state.selectedIdx===row.idx?'selected':''} ${depth>0?'rel-row':''}" ${rowStyle}>
        <td data-label="裁判日期">${esc(row.date)}</td>
        <td data-label="法院">${esc(row.court)}</td>
        <td data-label="案號">${caseCell}</td>
        <td data-label="保險類型">${catTag(row.category)}</td>
        <td data-label="爭點">${esc(row.cause)}${dTags}${tTags}</td>
        <td class="result-cell" data-label="結果摘要">${outcomeTag(row.outcome)}${row.outcome?"<br>":""}${esc(shortResult(row))}</td>
        <td data-label="文件類型"><span class="${docBadge}">${esc(row.doctype)}</span></td>
        <td data-label="書籤"><span class="${star}" data-star="${esc(row.idx)}">★</span></td>
      </tr>`;
    }).join("");
    renderPager(state.page, totalPages);
  }
  renderDetail();
}

/* ---------- 詳情（按需載入） ---------- */
let _detailToken = 0;
function renderDetail(){
  const pane = $("detailPane");
  if(!state.selectedIdx){
    pane.className = "empty";
    pane.innerHTML = "從左側清單點選一筆裁判以檢視詳情";
    return;
  }
  const row = DATA_BY_IDX.get(state.selectedIdx);
  if(!row){ pane.className = "empty"; pane.innerHTML = "找不到資料"; return; }
  pane.className = "mobile-open";
  const det = detailCache.get(row.idx);
  pane.innerHTML = detailHtml(row, det);
  bindDetail(row);
  if(!det){
    const token = ++_detailToken;
    getDetail(row).then(d => {
      if(token !== _detailToken || state.selectedIdx !== row.idx) return;
      pane.innerHTML = detailHtml(row, d);
      bindDetail(row);
    }).catch(() => {
      if(token !== _detailToken) return;
      const el = $("detailBody");
      if(el) el.innerHTML = `<div class="d-loading">摘要載入失敗，請檢查網路後重新點選，或點下方連結查看司法院原文。</div>`;
    });
  }
}

function detailHtml(row, det){
  const isBm = loadBookmarks().includes(row.idx);
  let body;
  if(!det){
    body = `<div class="d-loading">⏳ 載入判決摘要中…</div>`;
  } else {
    const cleaned = cleanDigest(det.dg).replace(/^主文[：:]\s*/, "");
    const plain = cleaned ? esc(cleaned) : "本筆裁判尚未整理摘要。點擊下方官方連結可前往司法院原始頁面查看全文。";
    const cr = Array.isArray(det.cr) ? det.cr : [];
    const ch = Array.isArray(det.ch) ? det.ch : [];
    const hasStructured = det.pc || det.dc || cr.length || ch.length;
    const structuredHtml = hasStructured ? `
      <div class="d-section">
        <div class="d-h"><span class="bar"></span>案情摘要</div>
        ${det.pc ? `<div class="claim-block plaintiff"><div class="cb-h">原告 / 上訴人主張</div>${esc(det.pc)}</div>` : ""}
        ${det.dc ? `<div class="claim-block defendant"><div class="cb-h">被告 / 保險公司主張</div>${esc(det.dc)}</div>` : ""}
        ${cr.length ? `<div class="claim-block"><div class="cb-h">法院判斷</div><ul>${cr.map(s => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      </div>
      ${ch.length ? `<div class="d-section"><div class="d-h"><span class="bar"></span>可引用見解 / 相關法條</div>${ch.map(h => `<div class="holding-item">・${esc(h)}</div>`).join("")}</div>` : ""}
    ` : "";
    const fact = det.fs ? `
      <div class="d-section">
        <div class="d-h"><span class="bar"></span>事實及理由節錄</div>
        <div class="d-body" style="max-height:260px;overflow:auto;font-size:12.5px;">${esc(det.fs)}</div>
      </div>` : "";
    body = `
      <div class="d-section">
        <div class="d-h"><span class="bar"></span>主文預覽</div>
        <div class="d-body plain">${plain}</div>
      </div>
      ${structuredHtml}
      ${fact}`;
  }
  return `
    <button class="close-detail" id="closeDetail">✕</button>
    <div class="d-title">${esc(row.court)}</div>
    <div class="d-sub">${esc(row.caseno)}　|　${esc(row.date)}　|　${esc(row.doctype)}</div>
    <div class="d-meta">${catTag(row.category)}${outcomeTag(row.outcome)}<span class="doc-badge">${row.is_judgment === "否" ? "程序裁定" : "實體判決"}</span></div>
    <div id="detailBody">${body}</div>
    <div class="d-section">
      <div class="d-h"><span class="bar"></span>爭點 / 裁判案由</div>
      <div class="d-body">${esc(row.cause)}</div>
    </div>
    <div class="d-section">
      <div class="d-h"><span class="bar"></span>當事人 / 分類依據</div>
      <div class="d-note">分類：${esc(row.category || "未分類")}${row.note ? " ｜ 備註：" + esc(row.note) : ""}</div>
    </div>
    ${row.disputeTypes.length ? `<div class="d-section"><div class="d-h"><span class="bar"></span>爭議類型</div><div class="d-note">${row.disputeTypes.map(t => `<span class="dispute-tag">${esc(t)}</span>`).join("")}</div></div>` : ""}
    ${row.claimTopics.length ? `<div class="d-section"><div class="d-h"><span class="bar"></span>理賠爭點主題</div><div class="d-note">${row.claimTopics.map(t => `<span class="topic-tag">${esc(t)}</span>`).join("")}</div></div>` : ""}
    ${row.laws.length ? `<div class="d-section"><div class="d-h"><span class="bar"></span>相關法條</div><div class="d-note">${row.laws.map(l => `<div>・${esc(l)}</div>`).join("")}</div></div>` : ""}
    ${row.officialUrl ? `<a class="d-link" href="${esc(row.officialUrl)}" target="_blank" rel="noopener">↗ 前往司法院官方全文頁面</a><br>` : ""}
    <button class="pill-btn" style="margin-top:14px;background:${isBm?'#e8a300':'var(--panel)'};color:${isBm?'#fff':'var(--blue)'};border:1.5px solid ${isBm?'#e8a300':'var(--line-strong)'};" id="toggleBookmark">${isBm?'★ 已加入書籤':'☆ 加入書籤'}</button>
  `;
}

function bindDetail(row){
  $("closeDetail").onclick = () => { state.selectedIdx = null; render(); };
  $("toggleBookmark").onclick = () => {
    let bm = loadBookmarks();
    bm = bm.includes(row.idx) ? bm.filter(x => x !== row.idx) : bm.concat(row.idx);
    saveBookmarks(bm);
    SEARCH_ENGINE.clearCache();
    render();
  };
}

/* ---------- 資料夾 ---------- */
let _folderCountCache = null;
function folderCounts(folders){
  const key = JSON.stringify(folders.map(f => [f.id, f.parentId, f.filter])) + "|" + fullTextState;
  if(_folderCountCache && _folderCountCache.key === key) return _folderCountCache.map;
  const own = new Map();
  folders.forEach(f => own.set(f.id, DATA.reduce((n, r) => n + (matchFilter(r, f.filter) ? 1 : 0), 0)));
  const total = new Map();
  const calc = (f, seen = new Set()) => {
    if(total.has(f.id)) return total.get(f.id);
    if(seen.has(f.id)) return own.get(f.id) || 0;
    seen.add(f.id);
    const kids = folders.filter(x => x.parentId === f.id);
    const v = (own.get(f.id) || 0) + kids.reduce((s, k) => s + calc(k, seen), 0);
    total.set(f.id, v);
    return v;
  };
  folders.forEach(f => calc(f));
  _folderCountCache = { key, map: total };
  return total;
}
function renderFolderNode(f, folders, depth, counts){
  const indent = 14 + depth*16;
  const kids = folders.filter(x => x.parentId === f.id);
  let html = `<div class="folder-row ${state.preset===f.id?'active':''}" data-preset="${esc(f.id)}" style="padding-left:${indent}px;">
      <span class="fname">${depth>0?'└ ':'📁 '}${esc(f.name)}</span>
      <span class="fcount">${counts.get(f.id) ?? 0}<button class="folder-add-sub" data-addsub="${esc(f.id)}" title="新增子資料夾">＋</button><button class="folder-del" data-del="${esc(f.id)}">✕</button></span>
    </div>`;
  if(depth < 6) kids.forEach(k => { html += renderFolderNode(k, folders, depth+1, counts); });
  return html;
}
function renderFolders(){
  const folders = loadFolders();
  const counts = folderCounts(folders);
  const ids = new Set(folders.map(f => f.id));
  const topLevel = folders.filter(f => !f.parentId || !ids.has(f.parentId));
  $("folderList").innerHTML = topLevel.map(f => renderFolderNode(f, folders, 0, counts)).join("");
  document.querySelectorAll(".nav-section .folder-row[data-preset]").forEach(el => {
    const preset = el.getAttribute("data-preset");
    if(!(preset in PRESETS) && preset !== "all") return;
    el.classList.toggle("active", state.preset === preset);
    el.querySelector(".fcount").textContent = PRESET_COUNTS[preset] ?? "";
  });
}
$("folderList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  const add = e.target.closest("[data-addsub]");
  if(del){
    e.stopPropagation();
    const id = del.getAttribute("data-del");
    const f = loadFolders().find(x => x.id === id);
    if(!confirm(`確定刪除資料夾「${f ? f.name : ""}」及其子資料夾？`)) return;
    const all = loadFolders();
    const rm = new Set([id]);
    let changed = true;
    while(changed){
      changed = false;
      all.forEach(x => { if(x.parentId && rm.has(x.parentId) && !rm.has(x.id)){ rm.add(x.id); changed = true; } });
    }
    saveFolders(all.filter(x => !rm.has(x.id)));
    if(rm.has(state.preset)) state.preset = "all";
    render();
    return;
  }
  if(add){ e.stopPropagation(); openFolderModal(add.getAttribute("data-addsub")); return; }
  const row = e.target.closest("[data-preset]");
  if(row){ openTablePreset(row.getAttribute("data-preset")); }
});
document.querySelectorAll(".nav-section .folder-row[data-preset]").forEach(el => {
  el.onclick = () => openTablePreset(el.getAttribute("data-preset"));
});
function openTablePreset(preset){
  state.preset = preset;
  state.selectedIdx = null;
  switchToTableView(state.view === "dashboard" || state.view === "bookmarks" ? "all" : state.view);
  render();
}

/* ---------- 下載 CSV ---------- */
async function downloadCurrent(){
  const rows = sortRows(getFiltered());
  if(!rows.length){ alert("目前清單沒有資料"); return; }
  if(rows.length > 3000 && !confirm(`目前清單共 ${rows.length} 筆，匯出需下載較多摘要資料，確定繼續？`)) return;
  const ks = [...new Set(rows.map(r => r.k))];
  const btns = [$("downloadBtn"), $("topDownloadBtn")];
  btns.forEach(b => b && (b.dataset.label = b.innerHTML, b.innerHTML = "⏳ 準備中…"));
  try{
    let done = 0;
    for(let i = 0; i < ks.length; i += 4){
      await Promise.all(ks.slice(i, i+4).map(k => loadChunk(k).catch(() => null)));
      done = Math.min(ks.length, i+4);
      btns.forEach(b => b && (b.innerHTML = `⏳ ${done}/${ks.length}`));
    }
    const header = ["序號","法院","案號","裁判類型","裁判日期","保險類型","裁判案由","勝負結果","爭議類型","是否為實體判決","摘要","官方連結"];
    const lines = [header.join(",")];
    rows.forEach(r => {
      const det = detailCache.get(r.idx) || {};
      const v = [r.idx, r.court, r.caseno, r.doctype, r.date, r.category, r.cause, r.outcome || "", r.disputeTypes.join("、"),
        r.is_judgment, cleanDigest(det.dg || r.sr).replace(/[\r\n]+/g, " "), r.officialUrl];
      lines.push(v.map(x => `"${String(x ?? "").replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "保險裁判清單_" + new Date().toISOString().slice(0,10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } finally {
    btns.forEach(b => b && b.dataset.label && (b.innerHTML = b.dataset.label));
  }
}

/* ---------- 檢視切換 ---------- */
function applyViewVisibility(){
  const isDash = state.view === "dashboard";
  $("dashboardView").classList.toggle("show", isDash);
  $("filterbar").style.display = isDash ? "none" : "";
  $("content").style.display = isDash ? "none" : "";
}
function switchToTableView(v){
  state.view = v || "search";
  document.querySelectorAll(".nav-item[data-view]").forEach(x => x.classList.toggle("active", x.getAttribute("data-view") === state.view));
  applyViewVisibility();
}
function runSearch(){
  state.q = $("searchInput").value.trim();
  state.scope = $("searchScope").value;
  if(state.view === "dashboard" || state.view === "bookmarks"){ switchToTableView("search"); state.preset = "all"; }
  if(state.q && state.scope === "all" && fullTextState === "idle") ensureFullText();
  render();
}

/* ---------- 儀表板 ---------- */
function renderDashboard(){
  const judg = DATA.filter(r => r.is_judgment !== "否").length;
  $("dashCountText").textContent = `共 ${DATA.length.toLocaleString()} 件（實體判決 ${judg.toLocaleString()} 件、程序裁定 ${(DATA.length-judg).toLocaleString()} 件；最後更新 ${LAST_UPDATE}）`;
  const recent = DATA.slice().sort((a,b) => b.iso < a.iso ? -1 : (b.iso > a.iso ? 1 : 0)).slice(0, 20);
  const groups = new Map();
  recent.forEach(r => { const k = r.iso || r.date; if(!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  let html = "";
  groups.forEach((rows, iso) => {
    html += `<div class="dash-date-group">${esc(iso)}　${rows.length} 件</div>`;
    rows.forEach(r => {
      const tags = [...r.disputeTypes, ...r.claimTopics].slice(0,2).join(" / ");
      html += `<div class="dash-item" data-dash-idx="${esc(r.idx)}">
        <div class="dash-item-main">
          <div class="dash-item-title">${esc(r.caseno)}　<span style="font-weight:400;color:var(--muted);font-size:11.5px;">${esc(r.court)}</span></div>
          <div class="dash-item-sub">${esc(tags || r.cause)}</div>
        </div>
        ${outcomeTag(r.outcome)}
      </div>`;
    });
  });
  $("dashRecent").innerHTML = html || "<div style='color:var(--muted);font-size:12.5px;'>尚無資料</div>";

  const dc = new Map();
  DATA.forEach(r => r.disputeTypes.forEach(t => dc.set(t, (dc.get(t)||0)+1)));
  const top = [...dc.entries()].sort((a,b) => b[1]-a[1]).slice(0,8);
  const maxD = top.length ? top[0][1] : 1;
  $("dashDisputeRank").innerHTML = top.map(([name,count]) => `
    <div class="dash-rank" data-dash-dispute="${esc(name)}" style="cursor:pointer;">
      <div style="flex:1;min-width:0;">
        <div class="dash-rank-name">${esc(name)}</div>
        <div class="dash-rank-bar"><div class="dash-rank-bar-fill" style="width:${Math.round(count/maxD*100)}%;"></div></div>
      </div>
      <div class="dash-rank-count">${count.toLocaleString()} 件</div>
    </div>`).join("") || "<div style='color:var(--muted);font-size:12.5px;'>尚無資料</div>";

  const oc = new Map();
  DATA.forEach(r => { if(r.outcome) oc.set(r.outcome, (oc.get(r.outcome)||0)+1); });
  const maxO = Math.max(1, ...oc.values());
  $("dashOutcomeRank").innerHTML = [...oc.entries()].map(([name,count]) => `
    <div class="dash-rank" data-dash-outcome="${esc(name)}" style="cursor:pointer;">
      <div style="flex:1;min-width:0;">
        <div class="dash-rank-name">${outcomeTag(name)}</div>
        <div class="dash-rank-bar"><div class="dash-rank-bar-fill" style="width:${Math.round(count/maxO*100)}%;"></div></div>
      </div>
      <div class="dash-rank-count">${count.toLocaleString()} 件</div>
    </div>`).join("") || "<div style='color:var(--muted);font-size:12.5px;'>尚未分類</div>";
}
$("dashboardView").addEventListener("click", (e) => {
  const item = e.target.closest("[data-dash-idx]");
  const dsp = e.target.closest("[data-dash-dispute]");
  const out = e.target.closest("[data-dash-outcome]");
  if(item){
    state.preset = "all";
    state.selectedIdx = item.getAttribute("data-dash-idx");
    switchToTableView("search");
    render();
  } else if(dsp || out){
    resetFilters(false);
    if(dsp){ state.dispute = dsp.getAttribute("data-dash-dispute"); $("disputeFilter").value = state.dispute; }
    if(out){ state.outcome = out.getAttribute("data-dash-outcome"); $("outcomeFilter").value = state.outcome; }
    switchToTableView("search");
    render();
  }
});

/* ---------- 檢索歷史 ---------- */
const SCOPE_LABEL = { all:"全文", caseno:"案號", court:"法院", cause:"爭點" };
function openHistory(){
  const h = loadHistory();
  $("historyList").innerHTML = h.length ? h.map((x, i) => `<div class="h-item" data-h="${i}"><span>${esc(x.q)}</span><span class="h-scope">${SCOPE_LABEL[x.scope] || ""}・${new Date(x.t).toLocaleDateString()}</span></div>`).join("")
    : `<div style="color:var(--muted);font-size:13px;padding:10px 0;">尚無檢索紀錄</div>`;
  $("historyModalBg").classList.add("show");
}
$("historyList").addEventListener("click", (e) => {
  const it = e.target.closest("[data-h]"); if(!it) return;
  const x = loadHistory()[+it.dataset.h]; if(!x) return;
  $("searchInput").value = x.q; $("searchScope").value = x.scope || "all";
  $("historyModalBg").classList.remove("show");
  runSearch();
});
$("historyBtn").onclick = openHistory;
$("historyClose").onclick = () => $("historyModalBg").classList.remove("show");
$("historyClear").onclick = () => { lsSet("ins_history", []); openHistory(); };
$("historyModalBg").addEventListener("click", (e) => { if(e.target.id === "historyModalBg") $("historyModalBg").classList.remove("show"); });

/* ---------- 事件綁定 ---------- */
let searchTimer;
$("searchBtn").onclick = () => { clearTimeout(searchTimer); runSearch(); pushHistory(state.q, state.scope); };
$("searchInput").addEventListener("keydown", e => { if(e.key === "Enter"){ clearTimeout(searchTimer); runSearch(); pushHistory(state.q, state.scope); } });
$("searchInput").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
$("searchScope").addEventListener("change", runSearch);

function readFilters(){
  state.dateFrom = $("dateFrom").value;
  state.dateTo = $("dateTo").value;
  state.cat = $("catFilter").value;
  state.doc = $("docFilter").value;
  state.dispute = $("disputeFilter").value;
  state.claimTopic = $("claimTopicFilter").value;
  state.outcome = $("outcomeFilter").value;
  state.q = $("searchInput").value.trim();
  state.scope = $("searchScope").value;
}
function resetFilters(doRender = true){
  ["dateFrom","dateTo","docFilter"].forEach(id => $(id).value = "");
  ["catFilter","disputeFilter","claimTopicFilter","outcomeFilter"].forEach(id => $(id).selectedIndex = 0);
  $("searchInput").value = "";
  $("searchScope").value = "all";
  Object.assign(state, { dateFrom:"", dateTo:"", cat:"", doc:"", dispute:"", claimTopic:"", outcome:"", q:"", scope:"all", preset:"all" });
  if(doRender) render();
}
$("queryBtn").onclick = () => { readFilters(); if(state.q && state.scope === "all") ensureFullText(); render(); };
["catFilter","docFilter","disputeFilter","claimTopicFilter","outcomeFilter","dateFrom","dateTo"].forEach(id => $(id).addEventListener("change", () => { readFilters(); render(); }));
$("resetBtn").onclick = () => resetFilters(true);
$("refreshBtn").onclick = () => { SEARCH_ENGINE.clearCache(); render(); };
$("downloadBtn").onclick = downloadCurrent;
$("topDownloadBtn").onclick = downloadCurrent;
$("bookmarkNavBtn").onclick = () => { switchToTableView("bookmarks"); state.preset = "bookmarks"; state.selectedIdx = null; render(); };
$("statsBtn").onclick = () => {
  const isos = DATA.map(r => r.iso).filter(Boolean).sort();
  const judg = DATA.filter(r => r.is_judgment !== "否").length;
  alert(`保險裁判知識庫\n資料來源：司法院裁判書查詢系統\n收錄範圍：${isos[0] || "-"} ～ ${isos[isos.length-1] || "-"}，裁判案由與保險相關之民事裁判\n資料庫總筆數：${DATA.length}（實體判決 ${judg}、程序裁定 ${DATA.length-judg}）\n最後更新：${LAST_UPDATE}`);
};

document.querySelectorAll("thead th[data-k]").forEach(th => {
  th.onclick = () => {
    const k = th.getAttribute("data-k");
    if(state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = k; state.sortDir = "desc"; }
    render();
  };
});

$("tbody").addEventListener("click", (e) => {
  const grp = e.target.closest("[data-toggle-group]");
  if(grp){
    e.stopPropagation();
    const k = grp.getAttribute("data-toggle-group");
    state.expandedGroups.has(k) ? state.expandedGroups.delete(k) : state.expandedGroups.add(k);
    render();
    return;
  }
  const starEl = e.target.closest("[data-star]");
  if(starEl){
    const idx = starEl.getAttribute("data-star");
    let bm = loadBookmarks();
    bm = bm.includes(idx) ? bm.filter(x => x !== idx) : bm.concat(idx);
    saveBookmarks(bm);
    if(state.preset === "bookmarks") SEARCH_ENGINE.clearCache();
    render();
    return;
  }
  const tr = e.target.closest("tr[data-idx]");
  if(tr){ state.selectedIdx = tr.getAttribute("data-idx"); render(); }
});

document.querySelectorAll(".nav-item[data-view]").forEach(el => {
  el.onclick = () => {
    const v = el.getAttribute("data-view");
    state.selectedIdx = null;
    if(v === "dashboard"){ switchToTableView("dashboard"); renderDashboard(); return; }
    state.preset = v === "bookmarks" ? "bookmarks" : "all";
    switchToTableView(v);
    render();
  };
});

/* 自訂資料夾 */
function openFolderModal(presetParentId){
  $("folderNameInput").value = "";
  const sel = $("folderParentSelect");
  const folders = loadFolders();
  sel.innerHTML = '<option value="">－ 無（頂層資料夾）－</option>' +
    folders.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  if(presetParentId) sel.value = presetParentId;
  $("modalBg").classList.add("show");
  setTimeout(() => $("folderNameInput").focus(), 50);
}
$("addFolderBtn").onclick = () => openFolderModal(null);
$("modalCancel").onclick = () => $("modalBg").classList.remove("show");
$("modalOk").onclick = () => {
  const name = $("folderNameInput").value.trim();
  if(!name){ alert("請輸入資料夾名稱"); return; }
  readFilters();
  const folders = loadFolders();
  const id = "custom_" + Date.now();
  folders.push({ id, name, parentId: $("folderParentSelect").value || null,
    filter: { cat: state.cat, doc: state.doc, dispute: state.dispute, outcome: state.outcome, q: state.q } });
  saveFolders(folders);
  $("modalBg").classList.remove("show");
  state.preset = id;
  switchToTableView(state.view === "dashboard" ? "all" : state.view);
  render();
};
$("modalBg").addEventListener("click", (e) => { if(e.target.id === "modalBg") $("modalBg").classList.remove("show"); });

/* 手機側邊選單 */
function closeSidebar(){ $("sidebar").classList.remove("open"); $("sidebarBackdrop").classList.remove("open"); }
$("hamburgerBtn").onclick = () => { $("sidebar").classList.add("open"); $("sidebarBackdrop").classList.add("open"); };
$("sidebarBackdrop").onclick = closeSidebar;
$("sidebar").addEventListener("click", (e) => { if(e.target.closest(".nav-item, .folder-row, .add-folder-btn")) closeSidebar(); });

/* ---------- 啟動 ---------- */
async function boot(){
  try{
    setLoading("下載索引中…");
    const pack = await fetchJSON(`data/index.json?v=${VER}`);
    setLoading("建立索引中…");
    await new Promise(r => setTimeout(r, 0));
    LAST_UPDATE = pack.lastUpdate || "";
    CHUNK_COUNT = pack.chunks || 0;
    DATA = expandRows(pack);
    DATA_BY_IDX = new Map(DATA.map(r => [r.idx, r]));
    SEARCH_ENGINE = window.JudgmentSearch.createEngine(DATA);
    PRESET_COUNTS = SEARCH_ENGINE.presetCounts;
    applyViewVisibility();
    renderFolders();
    renderDashboard();
    $("loadingOverlay").classList.add("hide");
  }catch(err){
    console.error(err);
    setLoading("資料載入失敗，請確認網路連線後重新整理。（" + err.message + "）");
    document.querySelector("#loadingOverlay .spinner").style.display = "none";
  }
}
boot();
