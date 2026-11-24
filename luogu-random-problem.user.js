// ==UserScript==
// @name         洛谷随机跳题 · 极简版
// @namespace    https://github.com/lg-random-problem
// @version      2.0.3
// @description  丝滑悬浮面板：同步洛谷做题记录，排除已通过题，按知识点与难度进行均衡提升、巩固回练和进阶推荐
// @author       lg-rng
// @license      MIT
// @match        https://www.luogu.com.cn/*
// @match        https://luogu.com.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
// @noframes
// ==/UserScript==

/*
 * 2.0：设置中绑定 UID / 个人主页，记录仅存本地。
 * 公开练习页的 passed / submitted 与题库标签关联，浏览不作为能力证据。
 * 历史快照没有单题时间，首次导入不计作近期训练；不展示未经校准的通过概率。
 * 原有快捷键、随机跳题、题库缓存与平滑拖动继续可用。
 */

(function () {
  'use strict';

  if (window.__LGRP_MIN_LOADED__) return;
  window.__LGRP_MIN_LOADED__ = true;

  /* ============================ 常量 ============================ */

  const PROBLEM_URL = 'https://www.luogu.com.cn/problem/';
  const CACHE_KEY = 'index.v2';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_DATA_URL = 'https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz';

  // 洛谷新版难度体系共 8 档（0 = 未评定），见
  // https://help.luogu.com.cn/manual/luogu/problem/difficulty
  const MAX_DIFFICULTY = 8;
  const DIFFS = [
    { v: 0, name: '未评定', short: '未', color: '#9ca3af' },
    { v: 1, name: '入门', short: '1', color: '#fe4c61' },
    { v: 2, name: '普及-', short: '2', color: '#f39c11' },
    { v: 3, name: '普及', short: '3', color: '#ffc116' },
    { v: 4, name: '普及+/提高-', short: '4', color: '#52c41a' },
    { v: 5, name: '提高', short: '5', color: '#13c2c2' },
    { v: 6, name: '提高+/省选-', short: '6', color: '#3498db' },
    { v: 7, name: '省选/NOI-', short: '7', color: '#9d3dcf' },
    { v: 8, name: 'NOI/NOI+/CTS', short: '8', color: '#1f2937', dark: '#cbd5e1' }, // 黑题在深色下换浅色
  ];

  /* ============================ 小工具 ============================ */

  const nextTick = () => new Promise((r) => setTimeout(r, 0));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  const nowStr = (ts) => new Date(ts || Date.now()).toLocaleString('zh-CN', { hour12: false });

  /** crypto 拒绝采样，保证均匀 */
  function randomInt(n) {
    if (!(n > 0)) return -1;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const RANGE = 0x100000000;
      const buf = new Uint32Array(1);
      const limit = Math.floor(RANGE / n) * n;
      let x;
      do {
        crypto.getRandomValues(buf);
        x = buf[0];
      } while (x >= limit);
      return x % n;
    }
    return Math.floor(Math.random() * n);
  }

  function currentPid() {
    const m = location.pathname.match(/^\/problem\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* ============================ 设置 ============================ */

  function getSetting(k, d) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(k, undefined);
        return v === undefined ? d : v;
      }
      const raw = localStorage.getItem('lgrp.' + k);
      return raw === null ? d : JSON.parse(raw);
    } catch (e) {
      return d;
    }
  }

  function setSetting(k, v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
      else localStorage.setItem('lgrp.' + k, JSON.stringify(v));
    } catch (e) {
      /* 忽略 */
    }
  }

  /** "" / null / 非数字 → null，表示不限 */
  function toNumOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /* ============================ 状态 ============================ */

  // 本次交互升级默认直接跳题；之后仍可手动重新开启预览。
  if (getSetting('interactionVersion', 0) < 201) {
    setSetting('recPreview', false);
    setSetting('interactionVersion', 201);
  }

  const state = {
    items: [],
    tagStats: [],
    candidates: [],
    diffs: new Set((getSetting('diffs', []) || []).map(Number)),
    tags: new Set(getSetting('tags', []) || []),
    idMin: toNumOrNull(getSetting('idMin', null)),
    idMax: toNumOrNull(getSetting('idMax', null)),
    loading: false,
    error: false,
    loadedAt: 0,
    open: false,
    view: 'main',
    dark: false,
    pos: null, // 拖动后的按钮坐标（null = 用右下角默认位置）
    recent: (getSetting('recent', []) || []).filter((p) => typeof p === 'string').slice(0, 20), // 最近抽过的题，避免连着重复
    kpFreq: Object.create(null), // 知识点在全库的出现次数，用于挑「主知识点」
    byPid: new Map(),
    card: null, // 智能推荐卡片 {p, d, k, reason}
    rec: {
      enabled: getSetting('recEnabled', true) !== false,
      mode: ['off', 'light', 'strong'].includes(getSetting('recMode', 'light')) ? getSetting('recMode', 'light') : 'light',
      preview: getSetting('recPreview', false) === true, // 默认直接跳，不弹卡片
      excludeUnresolved: getSetting('recExcludeUnresolved', false) === true,
      diffMode: getSetting('recDiffMode', 'auto') === 'fixed' ? 'fixed' : 'auto',
      diffValue: Math.min(8, Math.max(1, Number(getSetting('recDiffValue', 4)) || 4)),
      skip: [], // 本次会话里「换一个」跳过的题
    },
    personal: {
      uid: String(getSetting('personalUid', '') || ''),
      profile: null, model: null, syncing: false, error: '', generation: 0,
      controller: null,
      mode: ['balanced', 'review', 'challenge'].includes(getSetting('trainingMode', 'balanced')) ? getSetting('trainingMode', 'balanced') : 'balanced',
      randomExclude: getSetting('randomExcludePassed', true) !== false,
    },
    _raf: 0,
    _flash: 0,
  };

  let ui = null;
  let host = null;
  let drag = null; // 拖动状态
  let suppressClick = false; // 拖动结束后抑制一次 click

  /* ============================ IndexedDB 缓存 ============================ */

  let dbPromise = null;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB 不可用'));
      const req = indexedDB.open('lg-random-problem', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const db = () => dbPromise || (dbPromise = idbOpen());

  function idbGet(key) {
    return db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const r = d.transaction('kv', 'readonly').objectStore('kv').get(key);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        })
    );
  }

  function idbSet(key, val) {
    return db().then(
      (d) =>
        new Promise((resolve, reject) => {
          const tx = d.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(val, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  /* ============================ 标签分层 ============================ */

  /*
   * 智能推荐只按「知识点」轮换，所以必须先把标签里的噪音剔掉：
   *   年份（2002 / 2024 / 2077…）、赛事来源（NOIP、省选、ICPC、蓝桥杯…）、元信息（O2优化…）。
   * 这份数据 421 个标签实测：34 个年份、44 个赛事来源、5 个元信息，其余 338 个才是知识点。
   * 注意 POI/JOI/COI 这类三字母缩写不能用大小写不敏感匹配，否则 "two-pointer" 会被误判成赛事。
   */
  const YEAR_RE = /^(19|20)\d{2}$/;
  const META_TAGS = new Set(['O2优化', 'Special Judge', '交互题', '提交答案', '洛谷原创', '模板']);
  const CONTEST_CN_RE = /(省选|联考|集训|月赛|梦熊|省赛|邀请赛|入门赛|校赛|蓝桥杯|传智杯|国创杯|洛谷比赛|高校)/;
  const CONTEST_EN_RE =
    /(NOIP|CSP|CTSC|APIO|ICPC|CCPC|CERC|NEERC|NERC|SWERC|USACO|GESP|COCI|CEOI|Baltic|NOISG|THUPC|AtCoder|Codeforces|Code ?Jam|UVA|SPOJ)/i;
  // 全大写、且前后不能紧贴其他字母：POI（波兰）算赛事，two-pointer 不算
  const CONTEST_ACRONYM_RE = /(^|[^A-Za-z])(NOI|IOI|POI|JOI|COI|ROI|ROIR|EGOI|KOI|UOI|BOI|MOI)([^A-Za-z]|$)/;

  const tagKindCache = new Map();

  function tagKind(name) {
    let kind = tagKindCache.get(name);
    if (kind) return kind;

    const padded = ' ' + name + ' ';
    if (YEAR_RE.test(name)) kind = 'year';
    else if (META_TAGS.has(name)) kind = 'meta';
    else if (/(赛|杯)$/.test(name) || CONTEST_CN_RE.test(name)) kind = 'contest';
    else if (CONTEST_EN_RE.test(name)) kind = 'contest';
    else if (CONTEST_ACRONYM_RE.test(padded)) kind = 'contest';
    else if (/OI/.test(name) || /^Ynoi$/i.test(name)) kind = 'contest'; // BalkanOI / eJOI / JOISC / INOI…
    else kind = 'kp';

    tagKindCache.set(name, kind);
    return kind;
  }

  /** 拆出知识点 / 赛事 / 年份三组标签，结果缓存在题目对象上 */
  function itemTags(it) {
    if (it.k) return it.k;
    const kp = [];
    const contest = [];
    const years = [];
    for (const t of it.g) {
      const kind = tagKind(t);
      if (kind === 'kp') kp.push(t);
      else if (kind === 'contest') contest.push(t);
      else if (kind === 'year') years.push(t);
    }
    it.k = kp;
    it.c = contest;
    it.y = years;
    return kp;
  }

  /* ============================ 逐行解析 ============================ */

  const PID_RE = /^(?=.*\d)[A-Za-z][A-Za-z0-9_]*$/;

  /**
   * 字段兼容：pid/problemId/id、title/name、difficulty/diff（字符串或越界值兜底 0）、tags/tag。
   * 单行 JSON 损坏返回 null，不影响整体。
   */
  function parseProblemLine(line) {
    if (!line) return null;
    const s = line.trim();
    if (!s) return null;

    let raw;
    try {
      raw = JSON.parse(s);
    } catch (e) {
      return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const pid = String(
      raw.pid != null ? raw.pid : raw.problemId != null ? raw.problemId : raw.id != null ? raw.id : ''
    ).trim();
    if (!PID_RE.test(pid)) return null;

    const title =
      typeof raw.title === 'string' ? raw.title : typeof raw.name === 'string' ? raw.name : '';

    let diff = Number(raw.difficulty != null ? raw.difficulty : raw.diff);
    if (!Number.isFinite(diff) || diff < 0 || diff > MAX_DIFFICULTY) diff = 0;

    let tags = raw.tags != null ? raw.tags : raw.tag;
    if (typeof tags === 'string') tags = tags.split(/[,，;；|]/);
    if (!Array.isArray(tags)) tags = [];
    const seen = new Set();
    const clean = [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const v = t.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      clean.push(v);
    }

    return { p: pid, t: title, d: diff, g: clean, n: pidNum(pid) };
  }

  /** 取 pid 末尾的数字作为排序号：P1001 → 1001，U123456 → 123456（用于题号范围筛选） */
  function pidNum(pid) {
    const m = String(pid).match(/(\d+)(?!.*\d)/);
    return m ? Number(m[1]) : NaN;
  }

  async function buildIndex(chunkIter, onProgress) {
    const items = [];
    const seen = new Set();
    let carry = '';
    let lines = 0;
    let bad = 0;

    for await (const chunk of chunkIter) {
      const text = carry + chunk;
      const parts = text.split('\n');
      carry = parts.pop() || '';

      for (let i = 0; i < parts.length; i++) {
        const item = parseProblemLine(parts[i]);
        if (!item) {
          if (parts[i].trim()) bad++;
        } else if (!seen.has(item.p)) {
          seen.add(item.p);
          items.push(item);
        }
        if ((++lines & 511) === 0) {
          onProgress && onProgress(items.length, bad);
          await nextTick();
        }
      }
    }

    if (carry.trim()) {
      const item = parseProblemLine(carry);
      if (item && !seen.has(item.p)) {
        seen.add(item.p);
        items.push(item);
      }
    }

    onProgress && onProgress(items.length, bad);
    return { items, bad };
  }

  /* ============================ 下载 / 解压 ============================ */

  async function* readTextStream(stream) {
    const reader = stream.pipeThrough(new TextDecoderStream('utf-8')).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  }

  /** Uint8Array → 文本分片；识别 gzip 魔数，优先 DecompressionStream，其次 pako */
  async function* decodeBytes(bytes) {
    let plain = bytes;
    const isGz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

    if (isGz) {
      if (typeof DecompressionStream === 'function') {
        yield* readTextStream(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
        return;
      }
      if (typeof pako === 'undefined') throw new Error('缺少 DecompressionStream 与 pako，无法解压');
      plain = pako.inflate(bytes);
    }

    const dec = new TextDecoder('utf-8');
    const SIZE = 1 << 20;
    for (let off = 0; off < plain.length; off += SIZE) {
      const end = Math.min(off + SIZE, plain.length);
      yield dec.decode(plain.subarray(off, end), end < plain.length);
      await nextTick();
    }
  }

  function prependStream(firstChunk, reader, onBytes) {
    return new ReadableStream({
      start(c) {
        c.enqueue(firstChunk);
      },
      async pull(c) {
        try {
          const { value, done } = await reader.read();
          if (done) return c.close();
          onBytes && onBytes(value.byteLength);
          c.enqueue(value);
        } catch (err) {
          c.error(err);
        }
      },
    });
  }

  async function* textChunksFromResponse(res, onProgress) {
    const total = Number(res.headers.get('content-length')) || 0;
    let loaded = 0;

    const reader = res.body.getReader();
    const first = await reader.read();
    if (first.done) return;
    loaded += first.value.byteLength;
    onProgress && onProgress(loaded, total);

    const head = first.value;
    const isGz = head.length > 2 && head[0] === 0x1f && head[1] === 0x8b;
    const bytes = prependStream(head, reader, (n) => {
      loaded += n;
      onProgress && onProgress(loaded, total);
    });

    if (!isGz) {
      yield* readTextStream(bytes);
      return;
    }
    if (typeof DecompressionStream === 'function') {
      yield* readTextStream(bytes.pipeThrough(new DecompressionStream('gzip')));
      return;
    }
    const buf = await new Response(bytes).arrayBuffer();
    if (typeof pako === 'undefined') throw new Error('缺少 DecompressionStream 与 pako，无法解压');
    yield* decodeBytes(pako.inflate(new Uint8Array(buf)));
  }

  async function* textChunksFromBlob(blob) {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const isGz = head.length > 2 && head[0] === 0x1f && head[1] === 0x8b;

    if (!isGz) return yield* readTextStream(blob.stream());
    if (typeof DecompressionStream === 'function') {
      return yield* readTextStream(blob.stream().pipeThrough(new DecompressionStream('gzip')));
    }
    yield* decodeBytes(new Uint8Array(await blob.arrayBuffer()));
  }

  async function fetchWithRetry(url, tries) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
      try {
        const res = await fetch(url, { cache: 'no-cache', credentials: 'omit', mode: 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (!res.body) throw new Error('不支持流式响应');
        return res;
      } catch (err) {
        lastErr = err;
        if (i < tries) await sleep(800 * i);
      }
    }
    throw lastErr;
  }

  function gmFetchArrayBuffer(url, onProgress) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((b) => resolve(new Uint8Array(b)), reject);
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 120000,
        onprogress: (e) => e.lengthComputable && onProgress && onProgress(e.loaded, e.total),
        onload: (r) =>
          r.status >= 200 && r.status < 400
            ? resolve(new Uint8Array(r.response))
            : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('网络错误')),
        ontimeout: () => reject(new Error('下载超时')),
      });
    });
  }

  /* ============================ 载入流程 ============================ */

  async function loadFromUrl(url, silent) {
    if (state.loading) return;
    beginLoad();
    try {
      let chunkIter;
      try {
        const res = await fetchWithRetry(url, 3);
        chunkIter = textChunksFromResponse(res, (loaded, total) => {
          const pct = total ? Math.round((loaded / total) * 100) : null;
          setProgress(total ? loaded / total : null);
          setSt(pct == null ? '下载中…' : `下载 ${pct}%`);
        });
      } catch (err) {
        console.warn('[LGRP] 流式失败，回退 GM_xmlhttpRequest：', err);
        const bytes = await gmFetchArrayBuffer(url, (loaded, total) => {
          setProgress(total ? loaded / total : null);
          setSt(total ? `下载 ${Math.round((loaded / total) * 100)}%` : '下载中…');
        });
        chunkIter = decodeBytes(bytes);
      }
      await ingest(chunkIter, 'url:' + url);
    } catch (err) {
      console.error('[LGRP] 加载失败：', err);
      fail(err, silent);
    }
  }

  async function loadFromFile(file) {
    if (!file || state.loading) return;
    beginLoad();
    try {
      await ingest(textChunksFromBlob(file), `file:${file.name}:${file.size}:${file.lastModified}`);
    } catch (err) {
      console.error('[LGRP] 文件解析失败：', err);
      fail(err, false);
    }
  }

  async function ingest(chunkIter, srcKey) {
    setSt('解析中…');
    const t0 = performance.now();

    const { items, bad } = await buildIndex(chunkIter, (n) => setSt(`解析 ${fmt(n)} 题…`));
    if (!items.length) throw new Error('解析结果为空，确认是 NDJSON 题库数据');

    const savedAt = Date.now();
    applyIndex(items, savedAt);
    updateMatched();

    const cost = ((performance.now() - t0) / 1000).toFixed(1);
    console.info(`[LGRP] 载入 ${items.length} 题，耗时 ${cost}s，跳过 ${bad} 行`);

    idbSet(CACHE_KEY, { v: 2, srcKey, savedAt, items }).catch((e) =>
      console.warn('[LGRP] 缓存写入失败：', e)
    );
  }

  function beginLoad() {
    state.loading = true;
    state.error = false;
    setProgress(null);
    setSt('载入中…');
    ui.go.disabled = true;
  }

  function fail(err, silent) {
    state.loading = false;
    state.error = !silent;
    setProgress(null);
    if (silent) {
      // 后台更新失败：先恢复计数，再短暂提示，别把状态栏一直占着
      updateMatched();
      flash('更新失败，用缓存', 'warn');
      return;
    }
    setSt('失败 · 点此重试', 'err');
    ui.st.title = String((err && err.message) || err);
    updateMatched();
  }

  /* ============================ 索引 / 筛选 ============================ */

  function buildTagStats(items) {
    const map = new Map();
    for (const it of items) for (const t of it.g) map.set(t, (map.get(t) || 0) + 1);
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'));
  }

  function applyIndex(items, savedAt) {
    state.loading = false;
    state.error = false;
    state.items = items;
    state.loadedAt = savedAt || Date.now();
    state.tagStats = buildTagStats(items);

    // 兼容旧缓存：v2 之前的条目没有 n 字段，这里补一次
    for (let i = 0; i < items.length; i++) {
      if (!Number.isFinite(items[i].n)) items[i].n = pidNum(items[i].p);
    }

    // 智能推荐需要：pid 索引 + 知识点词频
    state.byPid = new Map();
    const freq = Object.create(null);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      state.byPid.set(it.p, it);
      const kp = itemTags(it);
      for (let j = 0; j < kp.length; j++) freq[kp[j]] = (freq[kp[j]] || 0) + 1;
    }
    state.kpFreq = freq;

    const alive = new Set(state.tagStats.map((t) => t.name));
    state.tags = new Set([...state.tags].filter((t) => alive.has(t)));
    state.diffs = new Set([...state.diffs].filter((d) => d >= 0 && d <= MAX_DIFFICULTY && Number.isFinite(d)));

    rebuildPersonalModel();
    renderPersonal();
    renderDiffs();
    renderSel();
    recompute(true);
    setProgress(null);
  }

  function makePredicate() {
    const diffs = state.diffs;
    const tags = [...state.tags];
    const useDiff = diffs.size > 0;
    const idMin = state.idMin;
    const idMax = state.idMax;
    const useRange = idMin != null || idMax != null;

    return (it) => {
      if (useDiff && !diffs.has(it.d)) return false;

      // 题号范围：按 pid 末尾数字比较，用来跳过太老的题
      if (useRange) {
        const n = Number.isFinite(it.n) ? it.n : pidNum(it.p);
        if (idMin != null && n < idMin) return false;
        if (idMax != null && n > idMax) return false;
      }

      if (!tags.length) return true;
      for (let i = 0; i < tags.length; i++) {
        if (!it.g.includes(tags[i])) return false; // 多标签 = 必须全含
      }
      return true;
    };
  }

  function recompute(immediate) {
    cancelAnimationFrame(state._raf);
    const run = () => {
      if (state.card) clearCard(); // 条件变了，旧卡片就作废
      if (!state.items.length) {
        state.candidates = [];
        updateMatched();
        return;
      }
      const pred = makePredicate();
      const out = [];
      for (let i = 0; i < state.items.length; i++) if (pred(state.items[i])) out.push(state.items[i]);
      state.candidates = out;
      updateMatched();
    };
    if (immediate) run();
    else state._raf = requestAnimationFrame(run);
  }

  function doRandomJump(ev) {
    if (!state.items.length) return flash('题库未载入', 'err');
    if (!state.candidates.length) return flash('没有符合条件的题', 'err');
    if (state.personal.uid && !state.personal.profile && state.personal.randomExclude) return flash('请先同步记录，再排除已通过题', 'warn');

    const cur = currentPid();
    const recent = new Set(state.recent);

    // 先排除「当前这题」和最近抽过的题；候选池太小（比如只筛出 3 道）时再放宽
    const eligible = state.candidates.filter(it => !state.personal.randomExclude || !passedSet().has(it.p));
    let pool = eligible.filter(it => it.p !== cur && !recent.has(it.p));
    if (!pool.length) pool = eligible.filter(it => it.p !== cur);
    if (!pool.length) return flash('没有符合条件的未通过题', 'warn');

    const pick = pool[randomInt(pool.length)];
    goTo(pick, ev, 'random');
  }

  /**
   * 记录一次跳转：只保留最近 20 题用于去重，
   * 曝光只用于去重，不作为独立完成或能力证据。
   */
  function rememberPick(it, src) {
    const pid = typeof it === 'string' ? it : it.p;
    state.recent = [pid, ...state.recent.filter((p) => p !== pid)].slice(0, 20);
    if (!state.personal.uid) setSetting('recent', state.recent);

    if (typeof it === 'string' || !state.rec) return;

    // 跳转是曝光，不是训练成果。旧 recPicks / recTagSeen 不迁移为能力证据。
    logPersonalEvent({ type: 'opened', p: pid });
  }

  /* ============================ 智能推荐 ============================ */

  function targetDifficulty() {
    if (state.rec.diffMode === 'fixed') return state.rec.diffValue;
    return state.personal.model ? state.personal.model.center : 2;
  }

  function recommend(ev) {
    if (!state.items.length) return flash('题库未载入', 'err');
    if (!state.candidates.length) return flash('没有符合条件的题', 'warn');
    const personal = state.personal;
    if (personal.uid && !personal.profile) return flash('请先在设置中同步做题记录', 'warn');
    if (state.rec.excludeUnresolved && !personal.profile) return flash('请先绑定 UID 并同步记录，再排除提交过的题', 'warn');
    const result = chooseRecommendation(state.candidates);
    if (!result) return flash(state.rec.excludeUnresolved
      ? '没有符合条件的未提交题，可调整筛选或关闭排除选项'
      : '没有符合条件的未通过题，可调整筛选', 'warn');
    const { item, reason, audit } = result;
    logPersonalEvent({ type: 'recommended', p: item.p, ...audit });
    console.debug('[LGRP 2.0] 推荐', item.p, audit);
    if (!state.rec.preview) return goTo(item, ev, 'smart', reason);
    showCard(item, reason);
  }

  /** 统一的跳转入口：记录 → 新标签页或当前页 */
  function goTo(it, ev, src, reason) {
    rememberPick(it, src);
    clearCard();
    const suffix = src === 'smart' && reason ? createReasonHandoff(it.p, reason) : '';
    const url = PROBLEM_URL + encodeURIComponent(it.p) + suffix;
    if (ev && (ev.ctrlKey || ev.metaKey || ev.altKey)) window.open(url, '_blank', 'noopener');
    else window.location.href = url;
  }

  function showCard(it, reason) {
    state.card = { p: it.p, d: it.d, k: itemTags(it).slice(0, 2), reason };
    renderCard();
  }

  function clearCard() {
    state.card = null;
    if (ui && ui.card) ui.card.hidden = true;
  }

  /** 卡片只留题号 + 标题，理由藏进 tooltip，界面上不铺开 */
  function renderCard() {
    if (!ui) return;
    const c = state.card;
    if (!c) {
      ui.card.hidden = true;
      return;
    }
    const item = state.byPid.get(c.p);
    ui.cardPid.textContent = c.p;
    ui.cardTitle.textContent = item ? item.t : '';
    ui.card.title = c.reason || '';
    ui.reason.textContent = c.reason || '';
    ui.card.hidden = false;
    updatePanelSide();
  }

  function goCard(ev) {
    const c = state.card;
    if (!c) return;
    const item = state.byPid.get(c.p) || { p: c.p, d: c.d, g: [], k: c.k };
    goTo(item, ev, 'smart', c.reason);
  }

  // 使用随机标识把理由带到目标页，兼容直接跳转和 Ctrl/Alt 新标签页。
  // 地址中只带一次性标识，不包含 UID 或推荐原因。
  function createReasonHandoff(pid, reason) {
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const now = Date.now(), stored = getSetting('jumpReasons.v1', []);
    const pending = Array.isArray(stored) ? stored.filter(x => x && now - x.at < 600000) : [];
    pending.push({ id, uid: state.personal.uid, p: pid, reason: String(reason).slice(0, 1200), at: now });
    setSetting('jumpReasons.v1', pending.slice(-20));
    return '#lgrp-rec=' + id;
  }

  function takeJumpReason() {
    const match = String(location.hash || '').match(/^#lgrp-rec=([a-zA-Z0-9-]{16,80})$/);
    if (!match) return null;
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (_) { /* 不影响理由显示 */ }
    const stored = getSetting('jumpReasons.v1', []);
    if (!Array.isArray(stored)) return null;
    const now = Date.now();
    const entry = stored.find(x => x && x.id === match[1] && x.p === currentPid() && x.uid === state.personal.uid
      && typeof x.reason === 'string' && now >= x.at && now - x.at < 600000);
    setSetting('jumpReasons.v1', stored.filter(x => x && x.id !== match[1] && now - x.at < 600000));
    return entry || null;
  }

  function scheduleJumpReason() {
    const entry = takeJumpReason();
    if (!entry) return;
    setTimeout(() => {
      if (!ui || entry.p !== currentPid() || entry.uid !== state.personal.uid) return;
      ui.noticeReason.textContent = entry.reason;
      ui.notice.hidden = false;
    }, 4500);
  }

  function openPersonalDetails() {
    // 从跳后提示或主界面均可直接进入，不必先找设置。
    openPanel();
    state.view = 'profile';
    ui.panel.classList.add('subview');
    ui.main.style.display = 'none';
    ui.set.classList.remove('open');
    ui['profile-view'].hidden = false;
    ui['view-nav'].hidden = false;
    ui['view-title'].textContent = '个人数据';
    ui.panel.scrollTop = 0;
    ui.notice.hidden = true;
    renderPersonalDetails();
    updatePanelSide();
    ui['view-nav'].querySelector('button').focus({ preventScroll: true });
  }

  function renderPersonalDetails() {
    const box = ui['profile-view'], p = state.personal, profile = p.profile, model = p.model;
    box.replaceChildren();
    const add = (parent, tag, text) => {
      const el = document.createElement(tag); el.textContent = text; parent.appendChild(el); return el;
    };
    if (!profile) {
      add(box, 'h3', '尚无个人做题数据');
      add(box, 'p', '在设置中绑定 UID 并同步，即可查看难度分布、知识点画像和回练题目。');
      const button = add(box, 'button', '前往设置并绑定 ›');
      button.className = 'data-entry'; button.dataset.act = 'settings';
      return;
    }
    add(box, 'h3', profile.name + ' · UID ' + p.uid);
    add(box, 'p', `已通过 ${fmt(profile.passed.length)} · 待回练 ${fmt(profile.unresolved.length)}`);
    add(box, 'small', '上次同步：' + nowStr(profile.syncedAt));
    const modes = { balanced: '均衡提升', review: '巩固回练', challenge: '进阶挑战' };
    add(box, 'p', '当前目标：' + modes[p.mode]);
    if (model) add(box, 'p', `整体训练参考：难度 ${model.center} · 有效知识点匹配 ${model.matched}/${profile.passed.length} 题`);
    if (p.syncing) add(box, 'p', '正在同步，当前显示上次成功记录。');
    if (p.error) add(box, 'p', '同步失败：' + p.error + '；已保留旧数据。');
    if (Date.now() - profile.syncedAt >= PROFILE_TTL) add(box, 'p', '缓存已过期，可在设置中重新同步。');
    const table = (parent, headers, rows) => {
      const t = add(parent, 'table', '');
      const head = add(t, 'thead', ''), tr = add(head, 'tr', '');
      for (const text of headers) add(tr, 'th', text);
      const body = add(t, 'tbody', '');
      for (const cells of rows) { const r = add(body, 'tr', ''); for (const text of cells) add(r, 'td', text); }
    };
    const section = (title, open = false) => {
      const details = add(box, 'details', ''); details.open = open; add(details, 'summary', title); return details;
    };
    const passed = Array(9).fill(0), unresolved = Array(9).fill(0);
    for (const x of profile.passed) passed[x.d]++;
    for (const x of profile.unresolved) unresolved[x.d]++;
    table(section('难度分布', true), ['难度', '通过', '待回练'], DIFFS.map(d => [d.name, passed[d.v], unresolved[d.v]]));
    const skills = section('知识点训练画像', true);
    if (model && model.skills.size) {
      table(skills, ['知识点', '加权证据', '参考难度'], [...model.skills].sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => [k, v.n.toFixed(1), v.center]));
    } else add(skills, 'p', '题库尚未载入或缺少有效算法标签。');
    add(skills, 'small', '多标签题按权重分配贡献；小样本向整体分布平滑。参考难度不是掌握度或通过概率。');
    for (const [title, list] of [['已通过题目', profile.passed], ['待回练题目', profile.unresolved]]) {
      const parent = section(title + '（' + list.length + '）');
      const links = add(parent, 'div', ''); links.className = 'problem-links';
      if (!list.length) add(links, 'p', '暂无记录');
      for (const x of list) {
        const link = add(links, 'a', x.p);
        link.href = PROBLEM_URL + encodeURIComponent(x.p); link.target = '_blank'; link.rel = 'noopener noreferrer';
      }
    }
    if (currentPid()) {
      ui.feedback.hidden = false;
      section('记录本题练习情况').appendChild(ui.feedback);
    }
    const training = section('近期训练反馈');
    const feedback = personalEvents().filter(x => x.type === 'feedback' || x.type === 'observed-pass').slice(-12).reverse();
    const labels = { easy: '独立完成 · 偏简单', fit: '独立完成 · 合适', hard: '认真尝试 · 太难', editorial: '参考题解后完成' };
    if (!feedback.length) add(training, 'p', '暂无；首次导入的历史记录不计作近期训练。');
    for (const e of feedback) add(training, 'p', e.p + ' · ' + (e.type === 'observed-pass' ? '同步发现新增通过（非精确通过时间）' : labels[e.kind] || '练习反馈'));
    add(box, 'small', '数据来自公开练习记录与本地反馈。历史列表没有单题通过时间；浏览不会增加训练证据。');
    const button = add(box, 'button', '管理绑定与同步 ›'); button.className = 'data-entry'; button.dataset.act = 'settings';
  }

  function reroll(ev) {
    const c = state.card;
    if (c) {
      if (!state.rec.skip.includes(c.p)) {
        state.rec.skip = [c.p, ...state.rec.skip].slice(0, 50); // 本次会话里不再出现
      }
      const it = state.byPid.get(c.p);
      if (it) logPersonalEvent({ type: 'skipped', p: it.p });
    }
    recommend(ev);
  }

  /* ============================ 2.0 个人训练 ============================ */

  const PROFILE_TTL = 6 * 60 * 60 * 1000;
  const ALGORITHM_VERSION = '2.0.3';

  function parseUid(value) {
    const s = String(value || '').trim();
    if (/^[1-9]\d{0,9}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' || !['www.luogu.com.cn', 'luogu.com.cn'].includes(u.hostname)) return '';
      const m = u.pathname.match(/^\/user\/([1-9]\d{0,9})(?:\/practice)?\/?$/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }

  function profileKey(uid) { return 'personal.v2.' + uid; }
  function eventsKey(uid) { return 'events.v2.' + (uid || 'guest'); }

  function normalizePractice(data, uid, at) {
    if (!data || String(data.user && data.user.uid) !== uid) throw new Error('返回账号不匹配');
    if (!Array.isArray(data.passed) || !Array.isArray(data.submitted)) throw new Error('做题记录不可见或页面结构已变化');
    const normalize = list => {
      const seen = new Set();
      return list.map(x => {
        if (!x || typeof x.pid !== 'string' || !PID_RE.test(x.pid) || seen.has(x.pid)) throw new Error('题目记录无效或重复');
        seen.add(x.pid);
        const d = Number(x.difficulty);
        if (!Number.isInteger(d) || d < 0 || d > MAX_DIFFICULTY) throw new Error('难度字段无效');
        return { p: x.pid, d };
      });
    };
    const passed = normalize(data.passed), unresolved = normalize(data.submitted);
    const ids = new Set(passed.map(x => x.p));
    if (unresolved.some(x => ids.has(x.p))) throw new Error('通过与未通过记录重叠，暂不覆盖缓存');
    if (!Number.isInteger(data.user.passedProblemCount) || data.user.passedProblemCount !== passed.length ||
        !Number.isInteger(data.user.submittedProblemCount) || data.user.submittedProblemCount !== passed.length + unresolved.length) {
      throw new Error('记录数量不完整或统计尚未更新，请稍后重试');
    }
    return { version: 2, uid, name: String(data.user.name || uid), syncedAt: at, passed, unresolved };
  }

  function readProfile(uid) {
    const p = getSetting(profileKey(uid), null);
    if (!p || p.version !== 2 || p.uid !== uid || !Number.isFinite(p.syncedAt)) return null;
    try {
      return normalizePractice({ user: { uid, name: p.name, passedProblemCount: p.passed.length,
        submittedProblemCount: p.passed.length + p.unresolved.length },
      passed: p.passed.map(x => ({ pid: x.p, difficulty: x.d })),
      submitted: p.unresolved.map(x => ({ pid: x.p, difficulty: x.d })) }, uid, p.syncedAt);
    } catch (_) { return null; }
  }

  function personalEvents() {
    const events = getSetting(eventsKey(state.personal.uid), []);
    return Array.isArray(events) ? events.filter(x => x && Number.isFinite(x.at) && typeof x.p === 'string') : [];
  }

  function logPersonalEvent(event) {
    const key = eventsKey(state.personal.uid);
    const events = personalEvents();
    events.push({ ...event, at: Date.now() });
    setSetting(key, events.slice(-300));
  }

  function passedSet() {
    return state.personal.model ? state.personal.model.passed : new Set();
  }

  function restorePersonal() {
    const p = state.personal;
    p.uid = parseUid(p.uid);
    p.profile = p.uid ? readProfile(p.uid) : null;
    // 旧浏览历史只用于未绑定模式的去重；不能串入某个账号的训练档案。
    if (p.uid) state.recent = personalEvents().filter(x => x.type === 'opened').slice(-20).reverse().map(x => x.p);
    rebuildPersonalModel();
    renderPersonal();
  }

  function refreshPersonalCache() {
    const p = state.personal;
    if (!p.uid || p.syncing) return;
    const bound = parseUid(getSetting('personalUid', ''));
    if (bound !== p.uid) {
      p.uid = bound; p.generation++; p.error = '';
      state.recent = []; state.rec.skip = []; clearCard(); restorePersonal(); updateMatched();
      return;
    }
    const fresh = readProfile(p.uid);
    if (fresh && (!p.profile || fresh.syncedAt > p.profile.syncedAt)) {
      p.profile = fresh;
      rebuildPersonalModel(); clearCard(); renderPersonal(); updateMatched();
    }
    void syncPersonal(false);
  }

  function bindAndSync() {
    const uid = parseUid(ui.uid.value);
    if (!uid) return flash('请输入有效 UID 或洛谷个人主页链接', 'warn');
    const p = state.personal;
    if (p.uid !== uid) {
      ui.notice.hidden = true;
      p.generation++;
      if (p.controller) p.controller.abort();
      p.syncing = false; p.controller = null; p.error = ''; p.uid = uid;
      setSetting('personalUid', uid);
      state.rec.skip = []; clearCard(); restorePersonal(); updateMatched();
    }
    void syncPersonal(true);
  }

  async function syncPersonal(force) {
    const p = state.personal;
    if (!p.uid || p.syncing) return;
    if (!force && p.profile && Date.now() - p.profile.syncedAt < PROFILE_TTL) return;
    const uid = p.uid, generation = ++p.generation;
    p.syncing = true; p.error = ''; renderPersonal();
    const current = () => p.uid === uid && p.generation === generation;
    const task = async () => {
      if (!current()) return;
      // 浏览器支持 Web Locks 时跨标签页合并同步；锁内再次检查共享缓存。
      const cached = readProfile(uid);
      if (cached && Date.now() - cached.syncedAt < (force ? 10000 : PROFILE_TTL)) {
        p.profile = cached; return;
      }
      const controller = new AbortController();
      p.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        // 仅向本站发送同源请求，绝不将个人 UID 或记录交给自定义题库源。
        const res = await fetch(location.origin + '/user/' + uid + '/practice', {
          credentials: 'same-origin', cache: 'no-cache', signal: controller.signal,
        });
        if (!res.ok) throw new Error(res.status === 429 ? '访问频繁，请稍后同步' : '主页请求失败（' + res.status + '）');
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const el = doc.querySelector('script#lentille-context');
        if (!el) throw new Error('页面未提供记录，可能需要登录或完成网站验证');
        const context = JSON.parse(el.textContent);
        if (context.status !== 200) throw new Error('个人记录暂不可访问');
        const next = normalizePractice(context.data, uid, Date.now());
        if (!current()) return;
        const previous = p.profile;
        if (previous) {
          const known = new Set(previous.passed.map(x => x.p));
          const newPasses = next.passed.filter(x => !known.has(x.p));
          // 首次导入没有近期事件；同步差分只知道观察区间，不伪造 AC 时间。
          for (const item of newPasses.slice(-100)) logPersonalEvent({ type: 'observed-pass', p: item.p,
            after: previous.syncedAt, before: next.syncedAt });
        }
        setSetting(profileKey(uid), next);
        p.profile = next;
      } finally { clearTimeout(timeout); }
    };
    try {
      if (navigator.locks && navigator.locks.request) await navigator.locks.request('lgrp-sync-' + uid, task);
      else await task();
    } catch (e) {
      if (current()) p.error = e.name === 'AbortError' ? '同步超时，请重试' : String(e.message || e);
    } finally {
      if (current()) {
        p.syncing = false; p.controller = null;
        rebuildPersonalModel(); clearCard(); renderPersonal(); updateMatched();
      }
    }
  }

  function clearPersonal() {
    const p = state.personal;
    if (!p.uid) return;
    const uid = p.uid;
    ui.notice.hidden = true;
    p.generation++;
    if (p.controller) p.controller.abort();
    setSetting(profileKey(uid), null); setSetting(eventsKey(uid), []); setSetting('personalUid', '');
    const pending = getSetting('jumpReasons.v1', []);
    if (Array.isArray(pending)) setSetting('jumpReasons.v1', pending.filter(x => x && x.uid !== uid));
    p.uid = ''; p.profile = null; p.model = null; p.syncing = false; p.error = ''; p.controller = null;
    ui.uid.value = '';
    state.recent = []; state.rec.skip = []; clearCard(); renderPersonal(); updateMatched();
  }

  function quantileHistogram(hist, q = .75) {
    const total = hist.slice(1).reduce((a, b) => a + b, 0);
    if (!total) return 2;
    let sum = 0;
    for (let d = 1; d <= 8; d++) { sum += hist[d]; if (sum >= total * q) return d; }
    return 8;
  }

  function tagWeights(it) {
    const tags = [...new Set(itemTags(it))];
    const raw = tags.map(k => 1 / Math.sqrt(1 + Math.log1p(state.kpFreq[k] || 1)));
    const sum = raw.reduce((a, b) => a + b, 0);
    return tags.map((k, i) => [k, raw[i] / sum]);
  }

  function rebuildPersonalModel() {
    const p = state.personal, profile = p.profile;
    if (!profile) { p.model = null; return; }
    const global = Array(9).fill(0), skills = new Map();
    let matched = 0;
    for (const row of profile.passed) {
      const it = state.byPid.get(row.p);
      const d = it ? it.d : row.d;
      if (d > 0) global[d]++;
      if (!it) continue;
      const weights = tagWeights(it);
      if (weights.length) matched++;
      for (const [k, w] of weights) {
        if (!skills.has(k)) skills.set(k, { hist: Array(9).fill(0), n: 0 });
        const v = skills.get(k);
        if (d > 0) { v.hist[d] += w; v.n += w; }
      }
    }
    const total = global.slice(1).reduce((a, b) => a + b, 0);
    const center = quantileHistogram(global);
    for (const v of skills.values()) {
      const hist = v.hist.map((n, d) => n + (total ? 8 * global[d] / total : (d === 2 ? 8 : 0)));
      v.center = quantileHistogram(hist);
    }
    p.model = { global, center, skills, matched,
      passed: new Set(profile.passed.map(x => x.p)),
      unresolved: new Set(profile.unresolved.map(x => x.p)) };
  }

  function renderPersonal() {
    if (!ui || !ui.uid) return;
    const p = state.personal;
    if (ui.uid !== ui.uid.getRootNode().activeElement) ui.uid.value = p.uid;
    const lines = [];
    if (p.profile) {
      lines.push(`${p.profile.name} · UID ${p.uid}`);
      lines.push(`已通过 ${fmt(p.profile.passed.length)} · 待回练 ${fmt(p.profile.unresolved.length)}`);

      if (Date.now() - p.profile.syncedAt >= PROFILE_TTL) lines.push('缓存已过期，推荐继续使用上次记录');
    } else lines.push(p.uid ? `UID ${p.uid} 尚无可用记录，请同步` : '未绑定：智能推荐使用入门参考区间，可手动设难度');
    if (p.syncing) lines.push('正在同步…');
    if (p.error) lines.push('同步失败：' + p.error + (p.profile ? '；已保留缓存' : ''));
    ui['profile-status'].textContent = lines.join('\n');
    ui['data-entry'].textContent = p.profile ? p.profile.name + ' · 个人数据 ›' : '个人数据与训练画像 ›';
    if (state.view === 'profile') renderPersonalDetails();
    const sync = ui.wrap.querySelector('[data-act="profile-sync"]');
    // 输入另一个 UID 时仍允许切换并中止旧请求。
    sync.disabled = false;
    sync.textContent = p.syncing ? '同步中…' : '绑定 / 同步';
    ui['feedback'].hidden = state.view !== 'profile' || !p.uid || !p.profile || !currentPid();
  }

  function saveTrainingFeedback() {
    const p = currentPid(), kind = ui['feedback-kind'].value;
    if (!state.personal.profile || !p || !['easy', 'fit', 'hard', 'editorial'].includes(kind)) return flash('请选择实际练习情况', 'warn');
    const previous = personalEvents().filter(x => x.type === 'feedback' && x.p === p).pop();
    if (previous && previous.kind === kind) return flash('这条反馈已记录', 'ok');
    logPersonalEvent({ type: 'feedback', p, kind });
    ui['feedback-kind'].value = '';
    clearCard(); flash('已记录；通过状态以同步为准', 'ok');
  }

  function chooseRecommendation(candidates) {
    const model = state.personal.model, events = personalEvents(), cur = currentPid();
    // 先应用不可放宽的排除条件，再处理近期去重。
    const unresolved = state.rec.excludeUnresolved ? model?.unresolved : null;
    let pool = candidates.filter(it => it.p !== cur && !model?.passed.has(it.p) && !unresolved?.has(it.p));
    if (!pool.length) return null;
    const recent = new Set(events.filter(x => ['recommended', 'opened', 'skipped'].includes(x.type)).slice(-20).map(x => x.p));
    const excluded = new Set([...recent, ...state.rec.skip]);
    const fresh = pool.filter(it => !excluded.has(it.p));
    const relaxed = !fresh.length;
    if (fresh.length) pool = fresh;
    const practice = new Map(), exposure = new Map(), feedback = new Map();
    const now = Date.now();
    for (const e of events) {
      const it = state.byPid.get(e.p);
      if (!it) continue;
      if (e.type === 'feedback') feedback.set(e.p, e);
      if (e.type === 'recommended' && now - e.at < 7 * 86400000) {
        for (const [k, w] of tagWeights(it)) exposure.set(k, (exposure.get(k) || 0) + w);
      }
      if (e.type === 'observed-pass' && e.after && e.before - e.after <= 7 * 86400000 && now - e.at < 14 * 86400000) {
        for (const [k, w] of tagWeights(it)) practice.set(k, (practice.get(k) || 0) + w);
      }
    }
    // 每题只用最新反馈，避免重复点击制造大量成功/失败样本。
    const offsets = new Map();
    for (const e of feedback.values()) {
      if (now - e.at > 30 * 86400000) continue;
      const it = state.byPid.get(e.p);
      if (e.kind !== 'hard') for (const [k, w] of tagWeights(it)) practice.set(k, (practice.get(k) || 0) + .5 * w);
      for (const [k, w] of tagWeights(it)) {
        const v = offsets.get(k) || { sum: 0, n: 0 };
        v.sum += (e.kind === 'easy' ? 1 : e.kind === 'hard' ? -1 : 0) * w; v.n += w; offsets.set(k, v);
      }
    }
    const rows = pool.map(it => {
      const weights = tagWeights(it);
      let center = targetDifficulty(), known = 0, coverage = 0, over = 0, offset = 0;
      if (weights.length) {
        let local = 0;
        for (const [k, w] of weights) {
          const skill = model && model.skills.get(k);
          local += w * (skill ? skill.center : Math.min(center, 3));
          known += w * (skill ? skill.n / (skill.n + 3) : 0);
          coverage += w / (1 + (practice.get(k) || 0));
          over += w * (exposure.get(k) || 0);
          const f = offsets.get(k);
          if (f) offset += w * .5 * f.sum / (f.n + 2);
        }
        if (state.rec.diffMode !== 'fixed') center = local;
      } else coverage = .35;
      if (state.rec.diffMode !== 'fixed') center = Math.max(1, Math.min(8, center + offset + (state.personal.mode === 'challenge' ? .5 : 0)));
      const fit = it.d > 0 ? Math.exp(-Math.abs(it.d - center) / 1.2) : .2;
      const unresolved = !!(model && model.unresolved.has(it.p));
      const f = feedback.get(it.p);
      const cooling = f && ['hard', 'editorial'].includes(f.kind) && now - f.at < 3 * 86400000;
      return { item: it, weights, center, fit, known, coverage, over, unresolved, cooling };
    });
    const routes = [
      { name: '日常提升', key: 'daily', weight: .6, rows },
      { name: '巩固回练', key: 'review', weight: .25, rows: rows.filter(r => r.unresolved && r.fit >= .35 && !r.cooling) },
      { name: '知识点探索', key: 'explore', weight: .15, rows: rows.filter(r => r.weights.length && r.known < .5 && r.item.d > 0 && r.item.d <= Math.ceil(r.center) && r.item.d <= 4) },
    ];
    if (state.personal.mode === 'review') [routes[0].weight, routes[1].weight, routes[2].weight] = [.25, .7, .05];
    if (state.personal.mode === 'challenge') [routes[0].weight, routes[1].weight, routes[2].weight] = [.7, .1, .2];
    const available = routes.filter(r => r.rows.length);
    const draw = (list, weight) => {
      const total = list.reduce((s, x) => s + weight(x), 0);
      let n = Math.random() * total;
      for (const x of list) { n -= weight(x); if (n <= 0) return x; }
      return list[list.length - 1];
    };
    const route = draw(available, r => r.weight);
    const score = r => 3 * r.fit + .65 * r.coverage + (route.key === 'review' && r.unresolved ? .8 : 0)
      + (route.key === 'explore' ? .4 * (1 - r.known) : .25 * r.known)
      - .5 * (1 - r.known) * (r.item.d >= 5 ? 1 : 0) - (r.cooling ? 1 : 0)
      - (state.rec.mode === 'off' ? 0 : Math.min(1, r.over / 4) * (state.rec.mode === 'strong' ? 1 : .4));
    // 先选择主题，避免大题量知识点单凭数量垄断推荐。
    const topics = new Map();
    for (const row of route.rows) {
      const topic = row.weights.length ? row.weights.reduce((a, b) => a[1] >= b[1] ? a : b)[0] : '未分类';
      if (!topics.has(topic)) topics.set(topic, []);
      row.score = score(row); topics.get(topic).push(row);
    }
    const groups = [...topics].map(([topic, list]) => {
      list.sort((a, b) => b.score - a.score || a.item.p.localeCompare(b.item.p));
      const top = list.slice(0, 40), max = top[0].score;
      for (const r of top) r.mass = Math.exp((r.score - max) / .45);
      return { topic, top, weight: Math.exp((max - 4) / .8) / (1 + (practice.get(topic) || 0)) };
    });
    const group = draw(groups, g => g.weight), selected = draw(group.top, r => r.mass);
    // 记录完整分层混合概率：同一题可能同时属于多条召回分支。
    // 当前审计先记录本次联合路径概率，不将其误称为题目的边际概率。
    const routeProbability = route.weight / available.reduce((s, r) => s + r.weight, 0);
    const pathProbability = routeProbability * group.weight / groups.reduce((s, g) => s + g.weight, 0)
      * selected.mass / group.top.reduce((s, r) => s + r.mass, 0);
    const stale = state.personal.profile && now - state.personal.profile.syncedAt >= PROFILE_TTL;
    const reason = `${route.name} · ${selected.item.d ? '难度 ' + selected.item.d + '，训练参考 ' + selected.center.toFixed(1) : '未评定难度，适配依据较少'}`
      + (selected.unresolved ? '；存在历史未通过记录' : '')
      + (!model ? '；未绑定记录，使用保守起点' : selected.known < .25 ? '；相关训练证据较少，属于探索' : '；参考相关知识点的历史通过分布')
      + (stale ? '；使用上次同步的缓存' : '') + (relaxed ? '；候选不足，已放宽近期去重' : '');
    return { item: selected.item, reason, audit: { algorithm: ALGORITHM_VERSION, route: route.key,
      topic: group.topic, score: selected.score, target: selected.center, pathProbability,
      eligibleCount: pool.length, routeCount: route.rows.length, topicCount: groups.length,
      profileAt: state.personal.profile ? state.personal.profile.syncedAt : null, relaxed } };
  }

  /* ============================ 样式 ============================ */

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
    font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #24292f;
    --ease-out: cubic-bezier(.22, 1, .36, 1);
  }
  .fab {
    width: 42px; height: 42px; border-radius: 50%; cursor: grab; touch-action: none;
    border: 1px solid rgba(15, 23, 42, .08); background: #fff; font-size: 18px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 18px rgba(15, 23, 42, .16);
    transition: transform 240ms var(--ease-out), box-shadow 240ms ease, background-color 180ms ease;
    user-select: none; -webkit-user-select: none;
  }
  .fab:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(15, 23, 42, .22); }
  .fab:active { transform: scale(.94); }
  .fab.dragging { transform: scale(1.06); cursor: grabbing; box-shadow: 0 10px 26px rgba(15, 23, 42, .28); }

  .panel {
    position: absolute; right: 0; bottom: 54px; width: 236px; max-width: calc(100vw - 24px); padding: 8px;
    max-height: calc(100vh - 84px); overflow: auto;
    background: #fff; border: 1px solid #e3e7ee; border-radius: 10px;
    box-shadow: 0 12px 30px rgba(15, 23, 42, .18);
    opacity: 0; visibility: hidden; pointer-events: none;
    transform: translateY(8px) scale(.96); transform-origin: right bottom;
    transition: opacity 180ms ease, transform 280ms var(--ease-out), visibility 0s 280ms;
    overscroll-behavior: contain;
  }
  .panel.open {
    opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0) scale(1);
    transition-delay: 0s;
  }
  .panel.left { transform-origin: left bottom; }
  .panel.down { transform: translateY(-8px) scale(.96); transform-origin: right top; }
  .panel.left.down { transform-origin: left top; }
  .panel.down.open { transform: translateY(0) scale(1); }
  /* 按钮拖到左半边 / 靠上时，面板换方向，避免出界 */
  .panel.left { right: auto; left: 0; }
  .panel.down { bottom: auto; top: 54px; }

  .bar { height: 2px; margin: -2px 0 6px; background: #eef1f5; border-radius: 1px; overflow: hidden; }
  .bar[hidden] { display: none; }
  .bar > i { display: block; height: 100%; width: 100%; background: #111827; transform: scaleX(0); transform-origin: left; transition: transform 220ms linear; }

  .diffs { display: flex; gap: 4px; margin-bottom: 8px; }
  .d {
    flex: 1; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 5px;
    background: #f1f3f7; color: #9aa4b2; font: inherit; font-size: 10px; cursor: pointer;
  }
  .d:hover { filter: brightness(.96); }
  .d.on { color: #fff; font-weight: 700; }

  /* 题号范围 */
  .idrow { display: flex; align-items: center; gap: 4px; margin-bottom: 8px; }
  .idrow .lbl { flex: none; font-size: 10px; color: #9aa4b2; }
  .idrow .inp { flex: 1; width: 0; height: 22px; padding: 0 4px; font-size: 10px; text-align: center; }
  .idrow .dash { flex: none; font-size: 10px; color: #9aa4b2; }
  .idrow .inp::-webkit-outer-spin-button,
  .idrow .inp::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

  .inp {
    width: 100%; height: 26px; padding: 0 8px; outline: none; font: inherit; font-size: 11px;
    border: 1px solid #dfe3ea; border-radius: 6px; background: #fff; color: inherit;
  }
  .inp:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, .12); }
  .inp::placeholder { color: #a8b1bd; }

  .sel { display: flex; flex-wrap: wrap; gap: 4px; max-height: 58px; overflow: auto; margin-bottom: 6px; }
  .sel:empty { display: none; }
  .tg {
    border: 0; border-radius: 999px; background: #eef4ff; color: #2563eb; cursor: pointer;
    font: inherit; font-size: 11px; padding: 1px 7px; max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tg:hover { background: #e0ecff; }

  .drop { margin-top: 4px; max-height: 148px; overflow: auto; border: 1px solid #e6eaf0; border-radius: 7px; padding: 2px; }
  .drop[hidden] { display: none; }
  .opt {
    display: flex; align-items: center; gap: 6px; width: 100%; padding: 3px 6px;
    border: 0; border-radius: 5px; background: transparent; color: inherit;
    font: inherit; font-size: 11px; text-align: left; cursor: pointer;
  }
  .opt:hover, .opt.cur { background: #eef4ff; }
  .opt b { font-weight: 600; }
  .opt .n { margin-left: auto; color: #a8b1bd; font-size: 10px; }
  .drop .none { padding: 4px 6px; color: #a8b1bd; font-size: 11px; }

  .go {
    width: 100%; height: 30px; margin-top: 8px; border: 0; border-radius: 7px;
    background: #111827; color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .go:hover:not(:disabled) { background: #1f2937; }
  .go:disabled { opacity: .35; cursor: not-allowed; }

  .cta { display: flex; gap: 6px; margin-top: 8px; }
  .cta .go { margin-top: 0; flex: 1; padding: 0 6px; }
  .go.smart { background: linear-gradient(135deg, #4f46e5, #7c3aed); }
  .go.smart:hover:not(:disabled) { background: linear-gradient(135deg, #4f46e5, #7c3aed); filter: brightness(1.08); }
  .go.smart[hidden] { display: none; }

  .card { margin-top: 8px; padding: 7px 8px; border: 1px solid #e3e7ee; border-radius: 8px; background: #fafbfd; }
  .card[hidden] { display: none; }
  .card-top { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .card-pid { flex: none; font-weight: 700; font-size: 11px; }
  .card-title {
    flex: 1; min-width: 0; font-size: 11px; color: #4b5563;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card-btns { display: flex; gap: 4px; margin-top: 6px; }
  .card-btns .mini { height: 22px; }
  .card-btns .mini.primary { flex: 1; background: #111827; color: #fff; border-color: transparent; }
  .card-btns .mini.primary:hover { background: #1f2937; }

  .recset { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #e6eaf0; }
  .chk { display: flex; align-items: center; gap: 5px; margin: 4px 0; font-size: 10px; color: #6b7280; cursor: pointer; }
  .chk input { width: 12px; height: 12px; margin: 0; accent-color: #4f46e5; }
  .recset .row select { flex: 1; height: 22px; font-size: 10px; }


  .st[hidden] { display: none; }
  .st { margin-bottom: 6px; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
  .st.ok { color: #16a34a; }
  .st.warn { color: #b45309; }
  .st.err { color: #dc2626; cursor: pointer; }
  .ic {
    border: 0; background: transparent; color: #9aa4b2; cursor: pointer;
    font-size: 12px; line-height: 1; padding: 2px 3px; border-radius: 4px;
  }
  .ic:hover { color: #374151; background: #f1f3f7; }

  .set { display: none; }
  .set.open { display: block; }
  .set .row { display: flex; gap: 4px; margin-top: 6px; }
  .mini {
    flex: 1; height: 24px; border: 1px solid #dfe3ea; border-radius: 6px; background: #fff;
    color: #374151; font: inherit; font-size: 10px; cursor: pointer;
  }
  .mini:hover { border-color: #c3cad4; }

  .d, .tg, .opt, .go, .mini, .ic {
    transition: transform 180ms var(--ease-out), background-color 180ms ease,
      color 180ms ease, border-color 180ms ease, opacity 180ms ease, filter 180ms ease;
  }
  .d:hover, .tg:hover, .mini:hover { transform: translateY(-1px); }
  .d:active, .tg:active, .go:active:not(:disabled), .mini:active, .ic:active { transform: scale(.96); }
  .inp { transition: border-color 180ms ease, box-shadow 180ms ease; }
  button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
  @keyframes content-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .set.open, .drop:not([hidden]), .card:not([hidden]) { animation: content-in 240ms var(--ease-out); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .fab:hover, .fab:active, .fab.dragging,
    .d:hover, .tg:hover, .mini:hover, .d:active, .tg:active,
    .go:active:not(:disabled), .mini:active, .ic:active { transform: none; }
  }

  .subview > .diffs, .subview > .idrow { display: none; }
  .main-tools { display: flex; align-items: stretch; gap: 5px; margin-bottom: 8px; }
  .main-tools .data-entry { flex: 1; min-width: 0; width: auto; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .settings-btn { flex: none; width: 30px; border: 0; border-radius: 6px; background: #eef4ff; color: #2563eb; cursor: pointer; font-size: 15px; }
  .settings-section { padding: 0 0 6px; }
  .field { display: block; margin: 8px 0; }
  .field > span { display: block; font-size: 10px; color: #8b93a1; margin-bottom: 4px; }
  .field select { font: inherit; }
  .settings-fold { border-top: 1px solid rgba(127,127,127,.16); padding: 9px 0; }
  .settings-fold > summary { cursor: pointer; font-size: 11px; font-weight: 600; }
  .settings-fold .chk { margin-top: 8px; }
  .root.dark .settings-btn { background: #2f3a52; color: #9ecbff; }
  .view-nav { position: sticky; top: -8px; z-index: 2; margin: -8px -8px 8px; padding: 10px 8px; display: flex; align-items: center; justify-content: space-between; gap: 6px; background: #fff; border-bottom: 1px solid #e3e7ee; }
  .view-nav[hidden] { display: none; }
  .back-btn { border: 0; border-radius: 6px; padding: 7px 9px; background: #eaf1ff; color: #2563eb; font: inherit; font-weight: 600; cursor: pointer; }
  .data-entry { display: block; width: 100%; border: 0; border-radius: 6px; background: #eef4ff; color: #2563eb; font: inherit; font-size: 11px; padding: 7px 8px; margin: 0 0 8px; text-align: left; cursor: pointer; }
  .profile-view h3 { font-size: 13px; margin: 8px 0; }
  .profile-view p { margin: 5px 0; overflow-wrap: anywhere; }
  .profile-view small { display: block; color: #8b93a1; margin: 6px 0; }
  .profile-view table { width: 100%; border-collapse: collapse; font-size: 10px; margin: 6px 0; }
  .profile-view th, .profile-view td { padding: 4px 2px; border-bottom: 1px solid rgba(127,127,127,.16); text-align: right; }
  .profile-view th:first-child, .profile-view td:first-child { text-align: left; }
  .profile-view details { margin-top: 10px; }
  .profile-view summary { font-weight: 600; cursor: pointer; }
  .problem-links { display: flex; flex-wrap: wrap; gap: 5px; max-height: 160px; overflow: auto; margin: 8px 0; }
  .problem-links a { color: #2563eb; text-decoration: none; }
  .root.dark .problem-links a { color: #9ecbff; }
  .notice { position: fixed; right: 16px; bottom: 76px; width: 300px; max-width: calc(100vw - 32px); max-height: calc(100vh - 100px); overflow: auto; z-index: 2147483001; padding: 12px; border: 1px solid #dfe3ea; border-radius: 12px; background: #fff; color: #24292f; box-shadow: 0 10px 30px rgba(15,23,42,.18); font: 12px/1.6 -apple-system, BlinkMacSystemFont, 'Microsoft YaHei', sans-serif; animation: content-in 280ms cubic-bezier(.22,1,.36,1); }
  .notice[hidden] { display: none; }
  .notice-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .notice p { margin: 8px 0; overflow-wrap: anywhere; }
  .notice .data-entry { margin-bottom: 0; }
  .root.dark .view-nav { background: #23262e; border-color: #343945; }
  .root.dark .back-btn, .root.dark .data-entry, .notice.dark .data-entry { background: #2f3a52; color: #9ecbff; }
  .notice.dark { background: #23262e; color: #e6e8eb; border-color: #343945; }
  .notice.dark .ic { color: #c7cdd6; }
  .back-btn, .data-entry { transition: background-color 180ms ease, transform 180ms var(--ease-out); }
  .back-btn:active, .data-entry:active { transform: scale(.98); }
  .personal .inp { margin-top: 6px; }
  .profile-status { color: #6b7280; font-size: 10px; margin: 6px 0; overflow-wrap: anywhere; white-space: pre-line; }
  .personal small { display: block; color: #9aa4b2; font-size: 10px; }
  .reason { margin-top: 5px; font-size: 10px; color: #6b7280; }
  .reason summary { cursor: pointer; }
  .reason div { margin-top: 4px; }
  .practice { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; font-size: 10px; color: #6b7280; }
  .practice[hidden] { display: none; }
  .practice .inp { flex: 1; min-width: 100px; }
  .practice .mini { flex: none; padding: 0 6px; }
  .root.dark .profile-status, .root.dark .reason, .root.dark .practice { color: #b0b8c7; }

  /* 深色 */
  .root.dark .fab { background: #262a32; border-color: #343945; color: #e5e7eb; }
  .root.dark .panel { background: #23262e; border-color: #343945; color: #e6e8eb; }
  .root.dark .d { background: #2c303a; color: #8b93a1; }
  .root.dark .inp { background: #2c303a; border-color: #3b414d; color: #e6e8eb; }
  .root.dark .drop { border-color: #343945; background: #23262e; }
  .root.dark .opt:hover, .root.dark .opt.cur { background: #2f3644; }
  .root.dark .tg { background: #2f3a52; color: #9ecbff; }
  .root.dark .tg:hover { background: #38455f; }
  .root.dark .go { background: #e5e7eb; color: #111827; }
  .root.dark .go:hover:not(:disabled) { background: #fff; }
  .root.dark .go.smart { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; }
  .root.dark .go.smart:hover:not(:disabled) { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
  .root.dark .card { background: #20232a; border-color: #343945; }
  .root.dark .card-title { color: #c7cdd6; }
  .root.dark .card-btns .mini { background: #2c303a; border-color: #3b414d; color: #d5dae2; }
  .root.dark .card-btns .mini.primary { background: #e5e7eb; color: #111827; border-color: transparent; }
  .root.dark .recset { border-top-color: #343945; }
  .root.dark .chk { color: #9aa4b2; }
  .root.dark .mini { background: #2c303a; border-color: #3b414d; color: #d5dae2; }
  .root.dark select { background: #2c303a; border-color: #3b414d; color: #d5dae2; }
  .root.dark .ic:hover { background: #2c303a; color: #e6e8eb; }
  .root.dark .bar { background: #343945; }
  .root.dark .bar > i { background: #e5e7eb; }
  `;

  /* ============================ 界面 ============================ */

  function buildUI() {
    host = document.createElement('div');
    host.id = 'lgrp-min-root';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = document.createElement('div');
    wrap.className = 'root';
    wrap.innerHTML = `
      <div class="panel" data-role="panel">
        <div class="bar" data-role="bar" hidden><i></i></div>
        <div class="st" data-role="st" role="status" hidden></div>
        <div class="view-nav" data-role="view-nav" hidden>
          <button class="back-btn" data-act="back">← 返回选题</button>
          <strong data-role="view-title">设置</strong>
        </div>

        <div class="diffs" data-role="diffs"></div>

        <div class="idrow" title="按题号末尾数字筛选，例如 8000 – 99999 只留 P8000 之后的题；留空表示不限">
          <span class="lbl">题号</span>
          <input class="inp" data-role="idmin" type="text" inputmode="numeric" placeholder="不限" />
          <span class="dash">–</span>
          <input class="inp" data-role="idmax" type="text" inputmode="numeric" placeholder="不限" />
        </div>

        <div class="main" data-role="main">
          <div class="main-tools">
            <button class="data-entry" data-role="data-entry" data-act="profile-details">个人数据与训练画像 ›</button>
            <button class="settings-btn" data-act="settings" aria-label="设置" title="设置">⚙</button>
          </div>
          <div class="sel" data-role="sel"></div>
          <input class="inp" data-role="inp" type="search" placeholder="标签，如 DP / 图论" autocomplete="off" />
          <div class="drop" data-role="drop" hidden></div>

          <div class="card" data-role="card" hidden>
            <div class="card-top">
              <span class="card-pid" data-role="card-pid"></span>
              <span class="card-title" data-role="card-title"></span>
            </div>
            <details class="reason"><summary>为什么推荐</summary><div data-role="reason"></div></details>
            <div class="card-btns">
              <button class="mini primary" data-act="card-go">去这题</button>
              <button class="mini" data-act="card-reroll">换一个</button>
            </div>
          </div>

          <div class="cta">
            <button class="go" data-act="go" disabled>🎲 随机</button>
            <button class="go smart" data-act="smart" disabled>🎯 智能</button>
          </div>
        </div>

          <div class="practice" data-role="feedback" hidden>
            <span>本题练习反馈</span>
            <select class="inp" data-role="feedback-kind" aria-label="本题练习反馈">
              <option value="">选择实际练习情况…</option>
              <option value="easy">独立完成 · 偏简单</option>
              <option value="fit">独立完成 · 合适</option>
              <option value="hard">认真尝试 · 太难</option>
              <option value="editorial">参考题解后完成</option>
            </select>
            <button class="mini" data-act="feedback-save">记录</button>
          </div>
        <section class="profile-view" data-role="profile-view" hidden aria-label="个人数据详情"></section>
        <div class="set" data-role="set">
          <div class="settings-section">
            <label class="field"><span>洛谷账号</span><input class="inp" data-role="uid" placeholder="UID 或个人主页链接" /></label>
            <div class="row account-actions">
              <button class="mini" data-act="profile-sync">绑定 / 同步</button>
              <button class="mini" data-act="profile-details">个人数据 ›</button>
            </div>
            <div class="profile-status" data-role="profile-status" role="status"></div>
            <label class="field"><span>训练目标</span>
              <select class="inp" data-role="training-mode">
                <option value="balanced">均衡提升</option>
                <option value="review">巩固回练</option>
                <option value="challenge">进阶挑战</option>
              </select>
            </label>
          </div>
          <details class="settings-fold" data-role="rec-options">
            <summary>更多推荐选项</summary>
            <label class="chk"><input type="checkbox" data-role="recen" /> 显示智能推荐按钮</label>
            <label class="chk"><input type="checkbox" data-role="recprev" /> 跳题前先预览</label>
            <label class="chk" title="根据已同步的洛谷做题记录筛选"><input type="checkbox" data-role="rec-exclude-unresolved" /> 智能推荐排除提交过但未通过的题</label>
            <label class="chk"><input type="checkbox" data-role="random-exclude" /> 普通随机也排除已通过题</label>
            <label class="field"><span>知识点轮换</span>
              <select class="inp" data-role="recmode">
                <option value="off">不轮换</option>
                <option value="light">轻度轮换</option>
                <option value="strong">加强轮换</option>
              </select>
            </label>
            <label class="field"><span>推荐难度</span>
              <select class="inp" data-role="recdiff" title="难度目标">
                <option value="auto">难度自动</option>
                <option value="1">锁定难度 1</option>
                <option value="2">锁定难度 2</option>
                <option value="3">锁定难度 3</option>
                <option value="4">锁定难度 4</option>
                <option value="5">锁定难度 5</option>
                <option value="6">锁定难度 6</option>
                <option value="7">锁定难度 7</option>
                <option value="8">锁定难度 8</option>
              </select>
            </label>
          </details>
          <details class="settings-fold" data-role="data-tools">
            <summary>题库与维护</summary>
            <label class="field"><span>题库地址</span><input class="inp" data-role="url" type="url" placeholder="https://…ndjson.gz" /></label>
            <div class="row">
              <button class="mini" data-act="save-url">保存并载入</button>
              <button class="mini" data-act="import">导入文件</button>
            </div>
            <div class="row">
              <button class="mini" data-act="reload">刷新题库</button>
              <button class="mini" data-act="reset-pos">重置位置</button>
            </div>
            <div class="row"><button class="mini" data-act="profile-clear">清除本账号本地数据</button></div>
          </details>
        </div>

        <input type="file" data-role="file" accept=".gz,.ndjson,.json,application/gzip" hidden />
      </div>
      <button class="fab" data-act="toggle" title="拖动可移动 · 点击展开（Alt+R 直接随机）">🎲</button>`;

    const notice = document.createElement('aside');
    notice.className = 'notice'; notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.innerHTML = `<div class="notice-head"><strong>这道题为什么适合你</strong><button class="ic" data-act="reason-dismiss" aria-label="关闭推荐原因">×</button></div>
      <p data-role="notice-reason"></p><button class="data-entry" data-act="profile-details">查看个人数据与训练画像 ›</button>`;
    root.append(style, wrap, notice);
    document.documentElement.appendChild(host);

    ui = {
      wrap,
      panel: wrap.querySelector('[data-role="panel"]'),
      bar: wrap.querySelector('[data-role="bar"]'),
      diffs: wrap.querySelector('[data-role="diffs"]'),
      main: wrap.querySelector('[data-role="main"]'),
      set: wrap.querySelector('[data-role="set"]'),
      sel: wrap.querySelector('[data-role="sel"]'),
      inp: wrap.querySelector('[data-role="inp"]'),
      drop: wrap.querySelector('[data-role="drop"]'),
      go: wrap.querySelector('[data-act="go"]'),
      st: wrap.querySelector('[data-role="st"]'),
      url: wrap.querySelector('[data-role="url"]'),
      file: wrap.querySelector('[data-role="file"]'),
      fab: wrap.querySelector('.fab'),
      idmin: wrap.querySelector('[data-role="idmin"]'),
      idmax: wrap.querySelector('[data-role="idmax"]'),
      smart: wrap.querySelector('[data-act="smart"]'),
      card: wrap.querySelector('[data-role="card"]'),
      cardPid: wrap.querySelector('[data-role="card-pid"]'),
      cardTitle: wrap.querySelector('[data-role="card-title"]'),
      recen: wrap.querySelector('[data-role="recen"]'),
      recmode: wrap.querySelector('[data-role="recmode"]'),
      recdiff: wrap.querySelector('[data-role="recdiff"]'),
      recprev: wrap.querySelector('[data-role="recprev"]'),
    };

    ui.notice = notice;
    ui.noticeReason = notice.querySelector('[data-role="notice-reason"]');
    ui.panel.inert = true;
    ui.fab.setAttribute('aria-expanded', 'false');
    for (const role of ['uid', 'profile-status', 'training-mode', 'rec-exclude-unresolved', 'random-exclude', 'feedback', 'feedback-kind', 'reason', 'view-nav', 'view-title', 'profile-view', 'data-entry']) {
      ui[role] = wrap.querySelector(`[data-role="${role}"]`);
    }
    ui.reason = ui['reason'];
    restorePersonal();
    bind();
    syncTheme();
    if (window.MutationObserver) {
      new MutationObserver(syncTheme).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme', 'theme'],
      });
    }
  }

  function bind() {
    ui.wrap.getRootNode().addEventListener('click', (e) => {
      if (suppressClick) return; // 刚刚是拖动，不算点击
      const t = e.target.closest('[data-act],[data-diff],[data-tag],[data-add]');
      if (!t) return;

      if (t.dataset.diff !== undefined) return toggleDiff(Number(t.dataset.diff));
      if (t.dataset.add !== undefined) return addTag(t.dataset.add); // 下拉里的候选标签
      if (t.dataset.tag !== undefined) return removeTag(t.dataset.tag); // 已选标签：点击移除

      switch (t.dataset.act) {
        case 'profile-details': return openPersonalDetails();
        case 'reason-dismiss': ui.notice.hidden = true; return;
        case 'profile-sync': return bindAndSync();
        case 'profile-clear': return clearPersonal();
        case 'feedback-save': return saveTrainingFeedback();
        case 'toggle':
          return togglePanel();
        case 'go':
          return doRandomJump(e);
        case 'settings':
          return openSettings();
        case 'back':
          return closeSettings();
        case 'save-url':
          return saveUrl();
        case 'import':
          return ui.file.click();
        case 'reload':
          return manualReload();
        case 'reset-pos':
          return resetPos();
        case 'smart':
          return recommend(e);
        case 'card-go':
          return goCard(e);
        case 'card-reroll':
          return reroll(e);
      }
    });

    ui.file.addEventListener('change', () => {
      const f = ui.file.files && ui.file.files[0];
      ui.file.value = '';
      if (f) loadFromFile(f);
    });

    // ---------- 拖动圆形按钮 ----------
    ui.fab.addEventListener('pointerdown', onFabDown);
    ui.fab.addEventListener('pointermove', onFabMove);
    ui.fab.addEventListener('pointerup', onFabUp);
    ui.fab.addEventListener('pointercancel', onFabUp);

    // 题号范围：输入防抖，失焦时如果区间反了就自动交换
    let idTimer = 0;
    const debounceId = () => {
      clearTimeout(idTimer);
      idTimer = setTimeout(() => applyIdRange(false), 220);
    };
    ui.idmin.addEventListener('input', debounceId);
    ui.idmax.addEventListener('input', debounceId);
    ui.idmin.addEventListener('change', () => {
      clearTimeout(idTimer);
      applyIdRange(true);
    });
    ui.idmax.addEventListener('change', () => {
      clearTimeout(idTimer);
      applyIdRange(true);
    });
    [ui.idmin, ui.idmax].forEach((el) =>
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur();
      })
    );

    // ---------- 智能推荐设置 ----------
    ui.recen.checked = state.rec.enabled;
    ui.recprev.checked = state.rec.preview;
    ui.recmode.value = state.rec.mode;
    ui.recdiff.value = state.rec.diffMode === 'auto' ? 'auto' : String(state.rec.diffValue);

    ui.recen.addEventListener('change', () => {
      state.rec.enabled = ui.recen.checked;
      setSetting('recEnabled', state.rec.enabled);
      applyRecUI();
    });
    ui.recmode.addEventListener('change', () => {
      state.rec.mode = ui.recmode.value;
      setSetting('recMode', state.rec.mode);
      if (state.rec.mode === 'off') state.rec.skip = [];
    });
    ui.recdiff.addEventListener('change', () => {
      const v = ui.recdiff.value;
      if (v === 'auto') {
        state.rec.diffMode = 'auto';
      } else {
        state.rec.diffMode = 'fixed';
        state.rec.diffValue = Number(v);
      }
      setSetting('recDiffMode', state.rec.diffMode);
      setSetting('recDiffValue', state.rec.diffValue);
    });
    ui.recprev.addEventListener('change', () => {
      state.rec.preview = ui.recprev.checked;
      setSetting('recPreview', state.rec.preview);
      if (!state.rec.preview) clearCard();
    });

    ui['training-mode'].value = state.personal.mode;
    ui['rec-exclude-unresolved'].checked = state.rec.excludeUnresolved;
    ui['rec-exclude-unresolved'].addEventListener('change', () => {
      state.rec.excludeUnresolved = ui['rec-exclude-unresolved'].checked;
      setSetting('recExcludeUnresolved', state.rec.excludeUnresolved);
      clearCard();
    });
    ui['random-exclude'].checked = state.personal.randomExclude;
    ui['training-mode'].addEventListener('change', () => {
      state.personal.mode = ui['training-mode'].value;
      setSetting('trainingMode', state.personal.mode);
      clearCard();
    });
    ui['random-exclude'].addEventListener('change', () => {
      state.personal.randomExclude = ui['random-exclude'].checked;
      setSetting('randomExcludePassed', state.personal.randomExclude);
      updateMatched();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshPersonalCache();
    });
    window.addEventListener('popstate', renderPersonal);
    applyRecUI();

    // 窗口尺寸变化时，别让按钮跑出可视区
    window.addEventListener('resize', () => {
      if (state.pos) setPos(state.pos.x, state.pos.y, false);
      updatePanelSide();
    });

    // 标签搜索
    let timer = 0;
    ui.inp.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderDrop(), 100);
    });
    ui.inp.addEventListener('focus', () => {
      if (ui.inp.value.trim()) renderDrop();
      else ui.drop.hidden = true; // 面板刚打开时不弹列表，避免挡住按钮
    });
    ui.inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = ui.drop.querySelector('.opt');
        if (first && !ui.drop.hidden) {
          e.preventDefault();
          addTag(first.dataset.add);
        }
      } else if (e.key === 'Escape') {
        ui.drop.hidden = true;
        ui.inp.blur();
      }
    });

    // 点面板外关闭
    document.addEventListener(
      'click',
      (e) => {
        if (!state.open) return;
        const path = e.composedPath ? e.composedPath() : [];
        if (path.indexOf(host) === -1 && !host.contains(e.target)) closePanel();
      },
      true
    );

    // 失败状态点一下重试
    ui.st.addEventListener('click', () => {
      if (state.error) manualReload();
    });

    // Alt+R
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
          e.preventDefault();
          doRandomJump(e);
        }
        if (e.key === 'Escape' && state.open) closePanel();
      },
      true
    );
  }

  function syncTheme() {
    if (!ui) return;
    let dark = false;
    try {
      const el = document.documentElement;
      const attr = String(el.getAttribute('data-theme') || el.getAttribute('theme') || '').toLowerCase();
      const ls = String(localStorage.getItem('theme') || '').toLowerCase();
      dark =
        attr.includes('dark') ||
        ls.includes('dark') ||
        !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      dark = false;
    }
    if (state.dark !== dark) {
      state.dark = dark;
      if (ui) renderDiffs(); // 黑题在深色下需要换成浅色
    }
    ui.wrap.classList.toggle('dark', dark);
    if (ui.notice) ui.notice.classList.toggle('dark', dark);
  }

  /* ---------- 拖动与位置 ---------- */

  const FAB_SIZE = 42;
  const EDGE = 8;

  function clampPos(x, y) {
    const maxX = Math.max(EDGE, window.innerWidth - FAB_SIZE - EDGE);
    const maxY = Math.max(EDGE, window.innerHeight - FAB_SIZE - EDGE);
    return { x: Math.min(Math.max(EDGE, x), maxX), y: Math.min(Math.max(EDGE, y), maxY) };
  }

  function setPos(x, y, save) {
    const p = clampPos(x, y);
    state.pos = p;
    ui.wrap.style.left = '0';
    ui.wrap.style.top = '0';
    ui.wrap.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
    ui.wrap.style.right = 'auto';
    ui.wrap.style.bottom = 'auto';
    if (save) setSetting('fabPos', p);
    if (!drag) updatePanelSide();
  }

  function resetPos() {
    state.pos = null;
    setSetting('fabPos', null);
    ui.wrap.style.transform = '';
    ui.wrap.style.left = '';
    ui.wrap.style.top = '';
    ui.wrap.style.right = '';
    ui.wrap.style.bottom = '';
    updatePanelSide();
    flash('已回到右下角', 'ok');
  }

  /** 面板朝空间更大的一侧展开：左右看余量，上下看余量，避免拖到角落时出界 */
  function updatePanelSide() {
    if (!ui) return;
    const r = ui.wrap.getBoundingClientRect();
    const w = ui.panel.offsetWidth || 236;
    const h = ui.panel.offsetHeight || 210;

    const roomRight = window.innerWidth - r.right;
    const roomLeft = r.left;
    const openRight = roomRight >= w ? true : roomLeft >= w ? false : roomRight >= roomLeft;
    ui.panel.classList.toggle('left', openRight);

    const roomUp = r.top - EDGE;
    const roomDown = window.innerHeight - r.bottom - EDGE;
    const need = h + 54;
    const openDown = roomUp >= need ? false : roomDown >= need ? true : roomDown > roomUp;
    ui.panel.classList.toggle('down', openDown);
  }

  function onFabDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (drag) return;
    if (snapAnimation) { snapAnimation.cancel(); snapAnimation = null; }
    const r = ui.wrap.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: e.clientX - r.left,
      oy: e.clientY - r.top,
      moved: false,
      frame: 0,
      pending: null,
    };
    try {
      ui.fab.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 某些环境不支持指针捕获，拖动仍可工作 */
    }
  }

  function onFabMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;

    if (!drag.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return; // 4px 阈值：区分点击与拖动
      drag.moved = true;
      ui.fab.classList.add('dragging');
      if (state.open) closePanel();
    }

    drag.pending = clampPos(e.clientX - drag.ox, e.clientY - drag.oy);
    if (!drag.frame) drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      setPos(drag.pending.x, drag.pending.y, false);
    });
    e.preventDefault(); // 拖动时别选中页面文字
  }

  let snapAnimation = null;

  function onFabUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    try {
      ui.fab.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* 忽略 */
    }
    if (drag.frame) cancelAnimationFrame(drag.frame);
    ui.fab.classList.remove('dragging');

    if (drag.moved) {
      // 提交最后一帧，再以合成动画柔和吸边。
      const p = drag.pending || state.pos;
      setPos(p.x, p.y, false);
      const from = ui.wrap.style.transform;
      if (p.x < 24) setPos(EDGE, p.y, false);
      else if (window.innerWidth - (p.x + FAB_SIZE) < 24) setPos(window.innerWidth - FAB_SIZE - EDGE, p.y, false);

      if (from !== ui.wrap.style.transform && ui.wrap.animate &&
          !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        snapAnimation = ui.wrap.animate([
          { transform: from }, { transform: ui.wrap.style.transform },
        ], { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
      setSetting('fabPos', state.pos);
      updatePanelSide();

      suppressClick = true; // 拖动结束后的那次 click 不算点击
      setTimeout(() => (suppressClick = false), 350);
    }
    drag = null;
  }

  /* ---------- 面板开关 ---------- */

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  function openPanel() {
    state.open = true;
    ui.panel.inert = false;
    ui.fab.setAttribute('aria-expanded', 'true');
    ui.panel.classList.add('open');
    updatePanelSide();
    requestAnimationFrame(updatePanelSide); // 等面板有高度后再纠一次方向
    if (state.view === 'main') {
      closeSettings();
      setTimeout(() => {
        if (state.open && state.view === 'main') ui.inp.focus({ preventScroll: true });
      }, 30);
    }
  }

  function closePanel() {
    state.open = false;
    if (ui.panel.contains(ui.panel.getRootNode().activeElement)) ui.fab.focus({ preventScroll: true });
    ui.panel.inert = true;
    ui.fab.setAttribute('aria-expanded', 'false');
    ui.panel.classList.remove('open');
    ui.drop.hidden = true;
  }

  function openSettings() {
    renderPersonal();
    state.view = 'settings';
    ui.panel.classList.add('subview');
    ui['profile-view'].hidden = true;
    ui['view-nav'].hidden = false;
    ui['view-title'].textContent = '设置';
    ui.panel.scrollTop = 0;
    for (const fold of ui.set.querySelectorAll('details')) fold.open = false;
    ui.main.style.display = 'none';
    ui.set.classList.add('open');
    ui.url.value = getSetting('dataUrl', DEFAULT_DATA_URL) || DEFAULT_DATA_URL;
    ui.recen.checked = state.rec.enabled;
    ui.recprev.checked = state.rec.preview;
    ui.recmode.value = state.rec.mode;
    ui.recdiff.value = state.rec.diffMode === 'auto' ? 'auto' : String(state.rec.diffValue);
    ui['view-nav'].querySelector('button').focus({ preventScroll: true });
    updatePanelSide();
  }

  function closeSettings() {
    state.view = 'main';
    ui.panel.classList.remove('subview');
    ui['view-nav'].hidden = true;
    ui['profile-view'].hidden = true;
    ui.panel.scrollTop = 0;
    ui.main.style.display = '';
    ui.set.classList.remove('open');
    ui.drop.hidden = true;
    updatePanelSide();
  }

  /* ---------- 难度 ---------- */

  function renderDiffs() {
    const existing = new Map([...ui.diffs.children].map(b => [Number(b.dataset.diff), b]));
    const dark = state.dark;
    for (const d of DIFFS) {
      const color = dark && d.dark ? d.dark : d.color;
      const b = existing.get(d.v) || document.createElement('button');
      b.type = 'button';
      b.className = 'd' + (state.diffs.has(d.v) ? ' on' : '');
      b.dataset.diff = String(d.v);
      b.textContent = d.short;
      b.title = `${d.name}（${state.diffs.has(d.v) ? '点击取消' : '点击选中'}）`;
      const on = state.diffs.has(d.v);
      // 颜色即难度：未选中时用彩色数字，选中后整块填充
      b.style.background = on ? color : 'transparent';
      b.style.color = on ? '#fff' : color;
      b.style.borderColor = on ? 'transparent' : 'rgba(127,127,127,.28)';
      if (!b.parentNode) ui.diffs.appendChild(b);
    }
  }

  function toggleDiff(v) {
    if (state.diffs.has(v)) state.diffs.delete(v);
    else state.diffs.add(v);
    setSetting('diffs', [...state.diffs]);
    renderDiffs();
    recompute();
  }

  /* ---------- 题号范围 ---------- */

  /** 应用输入框里的范围；swap=true 时（失焦）自动把反了的区间交换过来 */
  function applyIdRange(swap) {
    let min = toNumOrNull(String(ui.idmin.value).replace(/\D/g, ''));
    let max = toNumOrNull(String(ui.idmax.value).replace(/\D/g, ''));

    if (swap && min != null && max != null && min > max) {
      const t = min;
      min = max;
      max = t;
    }

    state.idMin = min;
    state.idMax = max;
    ui.idmin.value = min == null ? '' : String(min);
    ui.idmax.value = max == null ? '' : String(max);
    setSetting('idMin', min);
    setSetting('idMax', max);
    recompute();
  }

  /* ---------- 标签 ---------- */

  function renderSel() {
    ui.sel.textContent = '';
    for (const name of state.tags) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tg';
      b.dataset.tag = name;
      b.textContent = name + ' ×';
      b.title = '点击移除';
      ui.sel.appendChild(b);
    }
  }

  function addTag(name) {
    if (!name) return;
    state.tags.add(name);
    setSetting('tags', [...state.tags]);
    renderSel();
    recompute();
    ui.inp.value = '';
    renderDrop();
    ui.inp.focus({ preventScroll: true });
  }

  function removeTag(name) {
    state.tags.delete(name);
    setSetting('tags', [...state.tags]);
    renderSel();
    recompute();
  }

  function renderDrop() {
    const q = ui.inp.value.trim().toLowerCase();
    if (!state.tagStats.length) {
      ui.drop.hidden = true;
      return;
    }
    const list = state.tagStats
      .filter((t) => !state.tags.has(t.name) && (!q || t.name.toLowerCase().includes(q)))
      .slice(0, 30);

    ui.drop.textContent = '';
    if (!list.length) {
      const d = document.createElement('div');
      d.className = 'none';
      d.textContent = q ? '无匹配标签' : '已选完所有标签';
      ui.drop.appendChild(d);
    } else {
      for (const t of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'opt';
        b.dataset.add = t.name;
        b.innerHTML = '<b></b><span class="n"></span>';
        b.firstChild.textContent = t.name;
        b.lastChild.textContent = t.count;
        ui.drop.appendChild(b);
      }
    }
    ui.drop.hidden = false;
  }

  /* ---------- 状态 ---------- */

  function setSt(text, kind) {
    if (!ui) return;
    ui.st.hidden = false;
    ui.st.textContent = text;
    ui.st.className = 'st' + (kind ? ' ' + kind : '');
  }

  function setProgress(ratio) {
    if (!ui) return;
    if (ratio == null || !isFinite(ratio)) {
      ui.bar.hidden = true;
      ui.bar.firstElementChild.style.transform = 'scaleX(0)';
      return;
    }
    ui.bar.hidden = false;
    ui.bar.firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, ratio))})`;
  }

  function updateMatched() {
    if (!ui) return;
    const none = state.loading || !state.candidates.length;
    ui.go.disabled = none || (!!state.personal.uid && !state.personal.profile && state.personal.randomExclude);
    ui.smart.disabled = none || (!!state.personal.uid && !state.personal.profile);
    if (state.loading) return;

    if (state.error) {
      setSt('失败 · 点此重试', 'err');
      return;
    }
    if (!state.items.length) {
      setSt('未载入 · 点⚙导入', 'err');
      return;
    }
    const active = state.diffs.size || state.tags.size || state.idMin != null || state.idMax != null;
    setSt(active ? `${fmt(state.candidates.length)} / ${fmt(state.items.length)} 题` : `${fmt(state.items.length)} 题`, 'ok');
    ui.st.title = `缓存于 ${nowStr(state.loadedAt)}`;
    ui.st.hidden = true;
    ui.go.title = ui.smart.title = `当前筛选 ${fmt(state.candidates.length)} / ${fmt(state.items.length)} 题`;
  }

  function flash(msg, kind) {
    setSt(msg, kind);
    clearTimeout(state._flash);
    state._flash = setTimeout(() => updateMatched(), 1600);
  }

  function applyRecUI() {
    if (!ui) return;
    ui.smart.hidden = !state.rec.enabled;
    updateMatched();
  }

  /* ---------- 操作 ---------- */

  function saveUrl() {
    const url = (ui.url.value || '').trim();
    if (!/^https?:\/\//i.test(url)) return flash('URL 需以 http(s):// 开头', 'err');
    setSetting('dataUrl', url);
    closeSettings();
    loadFromUrl(url);
  }

  function manualReload() {
    if (state.loading) return;
    const url = getSetting('dataUrl', DEFAULT_DATA_URL);
    if (url) loadFromUrl(url);
    else flash('先设置数据源', 'err');
  }

  /* ============================ 启动 ============================ */

  async function boot() {
    buildUI();
    scheduleJumpReason();
    void syncPersonal(false);
    renderDiffs();
    ui.idmin.value = state.idMin == null ? '' : String(state.idMin);
    ui.idmax.value = state.idMax == null ? '' : String(state.idMax);
    recompute(true);

    // 恢复上次拖动的位置（窗口变小或换了显示器会被自动钳回可视区）
    const savedPos = getSetting('fabPos', null);
    if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
      setPos(savedPos.x, savedPos.y, false);
    }

    // 没显式设置过就回落到默认 CDN 数据源；用户填过的 URL 优先
    const savedUrl = getSetting('dataUrl', null);
    const url = savedUrl || DEFAULT_DATA_URL;

    let cached = null;
    try {
      cached = await idbGet(CACHE_KEY);
    } catch (e) {
      console.warn('[LGRP] 读取缓存失败：', e);
    }

    if (cached && Array.isArray(cached.items) && cached.items.length) {
      // 没显式设过 URL 时（例如只导入过本地文件），任意缓存都先顶上，别白下载一遍
      const sameSource = !savedUrl || !cached.srcKey || cached.srcKey === 'url:' + url;
      if (sameSource) {
        applyIndex(cached.items, cached.savedAt);
        updateMatched();
        const expired = Date.now() - (cached.savedAt || 0) > CACHE_TTL;
        const fromUrl = cached.srcKey === 'url:' + url;
        if (expired && fromUrl) loadFromUrl(url, true);
        return;
      }
    }

    if (url) {
      loadFromUrl(url, false);
      return;
    }

    setSt('未载入 · 点⚙导入', 'err');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot().catch((e) => console.error('[LGRP]', e)));
  } else {
    requestAnimationFrame(() => boot().catch((e) => console.error('[LGRP]', e)));
  }
})();
