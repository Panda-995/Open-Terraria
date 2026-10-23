// 云存档同步（自研轻量中继，配合 docker/save-sync 服务）。独立无依赖脚本，
// 不 import 游戏任何模块——游戏存档在 IndexedDB 'sandboxworld' 库的键域是
// 封闭的（见 src/save/KvStore.ts 键域注册表），按前缀直读直写即可，本体零改动。
//
// ┌ 时机模型 ────────────────────────────────────────────────────────────────┐
// │ 开机：本脚本先于游戏主模块执行（inline 经典脚本解析期执行,module 恒 defer）│
// │ →摘掉 module 标签 →拉云端清单做三方合并写回 IDB →再插回标签放行游戏。    │
// │ 游戏看到的 IDB 永远是合并后的（加载屏正好遮住这段）；服务不可达 4s 超时   │
// │ 兜底放行——同步链任何失败绝不阻断游戏（同上游增强链纪律）。               │
// │ 运行中：每 10s+页面隐藏时只读 diff 推送（绝不写 IDB——与游戏零写竞态）。  │
// └──────────────────────────────────────────────────────────────────────────┘
//
// 合并算法（三方,以"本浏览器上次推/拉过的哈希"为基,全程不用时钟,免疫跨机钟差）：
//   本地==云端          → 不动
//   本地==基,云端≠基    → 云端在别处更新 → 拉云端覆写本地
//   云端==基,本地≠基    → 本地新 → 推本地
//   双侧都≠基(或无基)   → 冲突：本地版先上传 __conflict.<ts>.<key> 留底,
//                         再拉云端版（云端赢但不丢数据）
//   仅本地有(有基)      → 他端已删 → 本地跟着删;仅云端有(无基) → 新档,拉取
//   服务端整体为空+本地有档 → 视为服务端重置:全量重新播种（防误清卷反噬本地）
//
// 同步面：'sandboxworld.*' 与 'sbw.*' 的 string 值（世界/角色/索引/快存/UI 偏好）。
// Blob(rp/mod zip)、remaster 素材包、fsBackup 目录句柄（结构化克隆非 string）不同步,
// typeof 门自动跳过;键名 '__' 开头为服务端留底键,永不回落本地。
// 端到端最终一致性：正常运行丢数窗口≈一个轮询周期(10s)——游戏存档动作
// （退出世界/手动保存）后 10s 内即上云,期间强杀标签页才可能漏推最后一笔。
(function () {
  'use strict';
  if (typeof window === 'undefined' || !('indexedDB' in window)) return;
  if (window.__saveSync) return;   // 重复注入防抖

  var DB_NAME = 'sandboxworld';
  var PREFIXES = ['sandboxworld.', 'sbw.'];
  var CONFLICT_PREFIX = '__conflict.';   // 服务端留底键命名空间
  var STATE_LS_KEY = 'sbwSync.state.v1';
  var SLOT_LS_KEY = 'sbwSync.slot';
  var TOKEN_LS_KEY = 'sbwSync.token';
  var POLL_MS = 10000;
  var BOOT_TIMEOUT_MS = 4000;
  var FETCH_CONCURRENCY = 4;

  var config = {};        // /save-sync-config.js（部署方挂载,可选）
  var baseUrl = '';
  var lsSlot = null, lsToken = null;
  var state = loadState();   // {keys:{[key]:{pushedHash,serverTs}}}
  var syncing = false, dirtyAgain = false;

  function warn(msg, e) { console.warn('[save-sync] ' + msg, e || ''); }
  function log(msg) { try { console.info('[save-sync] ' + msg); } catch (e) {} }

  function loadState() {
    try {
      var raw = localStorage.getItem(STATE_LS_KEY);
      if (raw) { var s = JSON.parse(raw); if (s && s.keys) return s; }
    } catch (e) { /* LS 不可用=本浏览器无跨端记忆,全按首用合并 */ }
    return { keys: {} };
  }
  function saveState() {
    try { localStorage.setItem(STATE_LS_KEY, JSON.stringify(state)); }
    catch (e) { warn('状态写入 localStorage 失败（隐私模式?）——每轮将按冲突保守合并', e); }
  }

  async function loadConfig() {
    try {
      var r = await fetch('/save-sync-config.js', { cache: 'no-store' });
      if (r.ok) {
        var t = await r.text();
        if (t) new Function(t)();
        if (window.SAVE_SYNC_CONFIG && typeof window.SAVE_SYNC_CONFIG === 'object') config = window.SAVE_SYNC_CONFIG;
      }
    } catch (e) { /* 无配置文件=默认同源无令牌 */ }
    if (typeof config.baseUrl === 'string' && config.baseUrl) baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    try {
      lsSlot = localStorage.getItem(SLOT_LS_KEY);
      lsToken = localStorage.getItem(TOKEN_LS_KEY);
    } catch (e) { /* LS 不可用忽略 */ }
  }

  function slot() { return (config && config.slot) || lsSlot || 'default'; }
  function reqHeaders(extra) {
    var h = extra || {};
    h['x-sync-slot'] = slot();
    var token = (config && config.token) || lsToken;
    if (token) h['x-sync-token'] = token;
    return h;
  }

  // ---- 服务端 API（任何失败返 null,调用方按不可达处理） ----
  async function apiManifest() {
    try {
      var r = await fetch(baseUrl + '/sync/manifest', { headers: reqHeaders(), cache: 'no-store' });
      if (!r.ok) return null;
      var m = await r.json();
      return m && m.keys ? m : null;
    } catch (e) { return null; }
  }
  async function apiGetText(key) {
    try {
      var r = await fetch(baseUrl + '/sync/key/' + encodeURIComponent(key), { headers: reqHeaders(), cache: 'no-store' });
      return r.ok ? await r.text() : null;
    } catch (e) { return null; }
  }
  async function apiPut(key, value) {
    try {
      var r = await fetch(baseUrl + '/sync/key/' + encodeURIComponent(key), {
        method: 'PUT', headers: reqHeaders({ 'content-type': 'application/json' }), body: value,
      });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { return null; }
  }
  async function apiDelete(key) {
    try {
      var r = await fetch(baseUrl + '/sync/key/' + encodeURIComponent(key), { method: 'DELETE', headers: reqHeaders() });
      return r.ok;
    } catch (e) { return false; }
  }

  // ---- IDB 直读直写（与游戏 KvStore 同库;不带版本号打开=绝不触发升级） ----
  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME);
      // 库不存在（全新浏览器首次收编场景）时建出 'kv' store——否则空 v1 库上
      // transaction('kv') 抛 NotFoundError,收编静默失败。游戏后续 open(2) 的
      // onupgradeneeded 逐 store 判 contains,重复补建零冲突。
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
      req.onblocked = function () { dbPromise = null; reject(new Error('blocked')); };
    });
    return dbPromise;
  }

  function closeDb() {
    if (!dbPromise) return;
    dbPromise.then(function (db) { db.close(); }).catch(function () {});
    dbPromise = null;
  }

  function syncable(key) {
    if (key.indexOf(CONFLICT_PREFIX) === 0) return false;
    for (var i = 0; i < PREFIXES.length; i++) if (key.indexOf(PREFIXES[i]) === 0) return true;
    return false;
  }

  /** 读本地：{[key]:{value,hash}}（只收 string 值;Blob/结构化克隆自动跳过）。 */
  async function readLocal() {
    var out = {};
    try {
      var db = await openDb();
      await new Promise(function (resolve) {
        var tx = db.transaction('kv', 'readonly');
        var store = tx.objectStore('kv');
        var keysReq = store.getAllKeys();
        var gets = [];
        keysReq.onsuccess = function () {
          var all = keysReq.result || [];
          for (var i = 0; i < all.length; i++) {
            var k = String(all[i]);
            if (!syncable(k)) continue;
            gets.push([k, store.get(k)]);
          }
        };
        tx.oncomplete = function () {
          for (var i = 0; i < gets.length; i++) {
            var v = gets[i][1].result;
            if (typeof v === 'string') out[gets[i][0]] = { value: v, hash: null };
          }
          resolve();
        };
        tx.onerror = function () { resolve(); };
        tx.onabort = function () { resolve(); };
      });
    } catch (e) { warn('IDB 读取失败', e); return out; }
    // 哈希放事务外逐键算（大值也只算一次,写回 out 缓存复用）
    for (var k in out) out[k].hash = await hashOf(out[k].value);
    return out;
  }

  async function writeLocal(entries) {
    if (!entries.length) return;
    var db = await openDb();
    await new Promise(function (resolve, reject) {
      var tx = db.transaction('kv', 'readwrite');
      var store = tx.objectStore('kv');
      for (var i = 0; i < entries.length; i++) store.put(entries[i].value, entries[i].key);
      tx.oncomplete = resolve;
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('abort')); };
    });
  }
  async function deleteLocal(keys) {
    if (!keys.length) return;
    var db = await openDb();
    await new Promise(function (resolve) {
      var tx = db.transaction('kv', 'readwrite');
      var store = tx.objectStore('kv');
      for (var i = 0; i < keys.length; i++) store.delete(keys[i]);
      tx.oncomplete = resolve;
      tx.onerror = resolve; tx.onabort = resolve;   // 删除失败不阻断(下轮重对账)
    });
  }

  // ---- 哈希：subtle 可用(https/localhost)用 SHA-256,局域网 http 退 JS FNV-1a ----
  var subtle = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
  var encoder = new TextEncoder();
  async function hashOf(str) {
    if (subtle) {
      try {
        var buf = await subtle.digest('SHA-256', encoder.encode(str));
        var arr = new Uint8Array(buf), hex = '';
        for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? '0' : '') + arr[i].toString(16);
        return hex;
      } catch (e) { /* 落 JS 兜底 */ }
    }
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return 'fnv:' + str.length + ':' + h.toString(16);
  }

  async function pool(items, worker) {
    var idx = 0;
    async function run() {
      while (idx < items.length) { var i = idx++; await worker(items[i]); }
    }
    var n = Math.min(FETCH_CONCURRENCY, items.length);
    var ps = [];
    for (var i = 0; i < n; i++) ps.push(run());
    await Promise.all(ps);
  }

  /** 双端同改/无基冲突：本地版留底后落云端版。 */
  async function conflictBackup(key, value) {
    var name = CONFLICT_PREFIX + Date.now() + '.' + key;
    var r = await apiPut(name, value);
    if (r) warn('检测到双端同改:「' + key + '」已云端留底 ' + name + ',本地落为云端版');
    else warn('冲突留底上传失败(服务不可达?)——本地保留原样,下轮重试');
    return !!r;
  }

  /** 老用户兜底：IDB 全空但 localStorage 还有双写时代副本时,先上传留底防被云端覆盖。 */
  async function legacySnapshot() {
    var found = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sandboxworld.') === 0) {
          var v = localStorage.getItem(k);
          if (v != null) found.push([k, v]);
        }
      }
    } catch (e) { /* LS 不可用 */ }
    for (var i = 0; i < found.length; i++) {
      await apiPut(CONFLICT_PREFIX + Date.now() + '.legacy.' + found[i][0], found[i][1]);
    }
    if (found.length) log('发现 localStorage 时代旧副本 ' + found.length + ' 键,已留底云端');
  }

  /** 开机合并：以云端清单+本地现状+本浏览器基线做三方对账,落盘后返回。 */
  async function bootMerge() {
    var M = await apiManifest();
    if (!M) { log('云存档服务不可达——本次启动不做同步(本地存档照常)'); return false; }
    var serverKeys = Object.keys(M.keys).filter(function (k) { return k.indexOf(CONFLICT_PREFIX) !== 0; });
    var local = await readLocal();
    var st = state.keys;
    var localCoreExists = Object.keys(local).some(function (k) { return k.indexOf('sandboxworld.') === 0; });
    var anyState = Object.keys(st).length > 0;

    // 服务端重置保护：云端空+本浏览器有基线 → 不执行删除,全量重播种
    // （防误清卷/换数据目录反噬本地存档；真"全端清空"场景极少,播种即可复原）
    var serverReset = serverKeys.length === 0 && anyState;

    var pulls = [], pushes = [], delServer = [], delLocal = [], conflicts = [];
    var union = {};
    serverKeys.forEach(function (k) { union[k] = 1; });
    Object.keys(local).forEach(function (k) { union[k] = 1; });

    Object.keys(union).forEach(function (key) {
      var l = local[key], s = M.keys[key], k = st[key];
      if (l && s) {
        if (l.hash === s.hash) { if (k) k.serverTs = s.ts; return; }
        if (k && l.hash === k.pushedHash) pulls.push(key);                       // 本地没动,云端新
        else if (k && s.hash === k.pushedHash) pushes.push(key);                 // 云端没动,本地新
        else conflicts.push(key);                                                // 双动/无基 → 留底+云端赢
      } else if (l && !s) {
        if (k && !serverReset) delLocal.push(key);                               // 他端已删
        else pushes.push(key);                                                   // 新档/重播种
      } else if (!l && s) {
        if (k) delServer.push(key);                                              // 本地已删 → 传删
        else pulls.push(key);                                                    // 他端新增 → 拉取
      }
    });

    // 全新浏览器首次收编：IDB 无档+无基线,拉云端前先把 localStorage 双写时代旧副本留底
    if (!localCoreExists && !anyState && serverKeys.length) await legacySnapshot();

    // 拉取：并发 GET → 写 IDB → 更基线
    var pullVals = {};
    await pool(pulls, async function (key) {
      var v = await apiGetText(key);
      if (v == null) return;   // 拉失败:本地保持原样,下轮再对
      pullVals[key] = v;
    });
    var writeEntries = [];
    Object.keys(pullVals).forEach(function (key) {
      writeEntries.push({ key: key, value: pullVals[key] });
      st[key] = { pushedHash: M.keys[key].hash, serverTs: M.keys[key].ts };
    });
    try { await writeLocal(writeEntries); } catch (e) { warn('开机写回 IDB 失败——本轮拉取作废,下轮重对', e); }

    // 冲突：留底+云端赢
    for (var i = 0; i < conflicts.length; i++) {
      var key = conflicts[i];
      var l = local[key];
      if (l) await conflictBackup(key, l.value);
      var v = await apiGetText(key);
      if (v == null) continue;
      try { await writeLocal([{ key: key, value: v }]); st[key] = { pushedHash: M.keys[key].hash, serverTs: M.keys[key].ts }; }
      catch (e) { warn('冲突落盘失败', e); }
    }

    // 推送
    await pool(pushes, async function (key) {
      var l = local[key];
      if (!l) return;
      var r = await apiPut(key, l.value);
      if (r) st[key] = { pushedHash: r.hash, serverTs: r.ts };
    });
    // 删除传播
    await pool(delServer, async function (key) { if (await apiDelete(key)) delete st[key]; });
    await pool(delLocal, async function (key) { await deleteLocal([key]); delete st[key]; });

    saveState();
    log('开机同步完成:拉' + Object.keys(pullVals).length + ' 推' + pushes.length +
        ' 删(云' + delServer.length + '/本' + delLocal.length + ') 冲突' + conflicts.length +
        (serverReset ? ' [服务端重置→重播种]' : ''));
    return true;
  }

  /** 运行中 diff 推送：本地有变推之,本地已删传删。只读 IDB,不写。 */
  async function diffPush() {
    var local = await readLocal();
    var st = state.keys;
    var touched = false;
    var jobs = [];
    Object.keys(local).forEach(function (key) {
      var k = st[key];
      if (!k || k.pushedHash !== local[key].hash) jobs.push(['put', key]);
    });
    Object.keys(st).forEach(function (key) { if (!local[key]) jobs.push(['del', key]); });
    if (!jobs.length) return;
    await pool(jobs, async function (job) {
      var op = job[0], key = job[1];
      if (op === 'put') {
        var r = await apiPut(key, local[key].value);
        if (r) { st[key] = { pushedHash: r.hash, serverTs: r.ts }; touched = true; }
      } else {
        if (await apiDelete(key)) { delete st[key]; touched = true; }
      }
    });
    if (touched) { saveState(); log('运行中推送 ' + jobs.length + ' 键变更'); }
  }

  async function cycle() {
    if (syncing) { dirtyAgain = true; return; }
    syncing = true;
    try {
      do {
        dirtyAgain = false;
        await diffPush();
      } while (dirtyAgain);
    } catch (e) { warn('推送周期异常(下轮重试)', e); }
    finally { syncing = false; }
  }

  // ---- 开机门控：摘 module 标签 → 合并 → 插回放行 ----
  var moduleEl = document.querySelector('script[type="module"][src]');
  var moduleSrc = moduleEl ? moduleEl.getAttribute('src') : null;
  var released = false;
  function release() {
    if (released) return;
    released = true;
    if (!moduleSrc) return;   // 无 module 标签(异常/改造)=不干预
    var el = document.createElement('script');
    el.type = 'module';
    el.src = moduleSrc;
    el.crossOrigin = 'anonymous';
    (document.body || document.head).appendChild(el);
  }

  var booted = (async function () {
    await loadConfig();
    var ok = false;
    try { ok = await bootMerge(); } catch (e) { warn('开机合并异常——放行游戏(本地存档照常)', e); }
    startWatcher();
    return ok;
  })();
  var timeout = setTimeout(function () { warn('开机同步超时 ' + BOOT_TIMEOUT_MS + 'ms——先放行游戏,后台继续'); release(); }, BOOT_TIMEOUT_MS);
  booted.then(function (ok) {
    clearTimeout(timeout);
    closeDb();   // 合并完毕即释放连接:不挡游戏后续 v2→vN 升级(onversionchange 双保险)
    if (ok) log('存档已与云端对齐,放行游戏');
    release();
  }, function () { clearTimeout(timeout); release(); });

  function startWatcher() {
    setInterval(cycle, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') void cycle();
    });
    window.addEventListener('pagehide', function () { void cycle(); });
  }

  // ---- 调试/运维口 ----
  window.__saveSync = {
    /** 当前状态概览 */
    status: function () {
      return { slot: slot(), baseUrl: baseUrl || '(同源)', bootDone: released,
               trackedKeys: Object.keys(state.keys).length, syncing: syncing };
    },
    /** 立即触发一轮推送对账 */
    syncNow: function () { return cycle(); },
    /** 重新执行一次开机合并(改完 slot/token 后用) */
    resync: async function () {
      await loadConfig();
      state = { keys: {} }; saveState();
      return bootMerge();
    },
    setSlot: function (s) { try { localStorage.setItem(SLOT_LS_KEY, String(s)); lsSlot = String(s); } catch (e) {} },
    setToken: function (t) { try { localStorage.setItem(TOKEN_LS_KEY, String(t)); lsToken = String(t); } catch (e) {} },
  };
})();
