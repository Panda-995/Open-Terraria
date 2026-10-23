// 云存档中继服务（无依赖 Node HTTP 服务）。
//
// 背景：游戏本体是纯静态站，世界/角色存档全部在访问者浏览器的 IndexedDB
// （'sandboxworld' 库，见 src/save/KvStore.ts 键域表）——服务端不碰存档，
// 换浏览器/换电脑存档即丢。本服务给 public/save-sync.js 提供同源 KV 中继：
//   GET  /sync/manifest        清单 {keys:{name:{ts,size,hash}}}
//   GET  /sync/key/<name>      取值（原始文本）
//   PUT  /sync/key/<name>      存值 → {ok,ts,hash}
//   DELETE /sync/key/<name>    删除 → {ok}
//   GET  /sync/config          {tokenRequired,maxBody}
//   GET  /healthz              存活探针（nginx 容器健康检查同款路径约定）
// 路由恒带 /sync 前缀：web 镜像 nginx 用变量 proxy_pass 原样透传（不剥前缀），
// 变量写法把上游解析推迟到请求时——web 镜像单独运行（无 sync 容器）时
// nginx 仍能启动，/sync/* 只是 502，游戏本体零影响。
//
// 存储：DATA/slots/<slot>/data/<encodeURIComponent(key)> + manifest.json
// （原子写：tmp+rename）。slot 由请求头 X-Sync-Slot 选择（默认 'default'），
// 多人同机部署时在 save-sync-config.js 里按人分 slot 互不覆盖。
//
// 鉴权：环境变量 SYNC_TOKEN 非空时，所有数据面请求必须带相等 X-Sync-Token
// 头（timingSafeEqual 比较）；/healthz 与 /sync/config 无需令牌。
//
// 冲突模型：键级 last-write-wins（IDB 每键整存整取，键级覆盖安全）；
// 客户端在双端同改时先把本地版上传 __conflict.<ts>.<key> 留底再落云端版，
// 服务端不判优、不丢数据。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || '/data';
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const MAX_BODY = Number(process.env.MAX_BODY || 256 * 1024 * 1024);

const MANIFEST = 'manifest.json';
const DATA_SUBDIR = 'data';

// ---- 每槽位写队列：manifest 读改写与数据文件变更串行化（单进程内足够） ----
const slotQueues = new Map();
function slotQueue(slot) {
  let q = slotQueues.get(slot);
  if (!q) { q = Promise.resolve(); slotQueues.set(slot, q); }
  return q;
}
function enqueue(slot, fn) {
  const run = slotQueue(slot).then(fn, fn);
  slotQueues.set(slot, run.catch(() => {}));
  return run;
}

function slotDir(slot) { return path.join(DATA_DIR, 'slots', slot); }

function safeSlot(raw) {
  const s = decodeURIComponent(raw || 'default');
  if (!s || s.length > 64 || /[\\/:*?"<>|\x00-\x1f]/.test(s) || s === '.' || s === '..') return null;
  return s;
}

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function tokenOk(req) {
  if (!SYNC_TOKEN) return true;
  const got = String(req.headers['x-sync-token'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(SYNC_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendRaw(res, status, buf) {
  res.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

// ---- manifest 读改写（须在 enqueue 内调用） ----
async function readManifest(slot) {
  try {
    const raw = await fsp.readFile(path.join(slotDir(slot), MANIFEST), 'utf8');
    return JSON.parse(raw);
  } catch { return { keys: {} }; }
}

async function writeManifest(slot, manifest) {
  const dir = slotDir(slot);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, MANIFEST + '.tmp');
  await fsp.writeFile(tmp, JSON.stringify(manifest));
  await fsp.rename(tmp, path.join(dir, MANIFEST));
}

async function putKey(slot, key, body) {
  return enqueue(slot, async () => {
    const dir = path.join(slotDir(slot), DATA_SUBDIR);
    await fsp.mkdir(dir, { recursive: true });
    const name = Buffer.from(key, 'utf8').toString('base64url');
    const tmp = path.join(dir, name + '.tmp');
    await fsp.writeFile(tmp, body);
    await fsp.rename(tmp, path.join(dir, name));
    const m = await readManifest(slot);
    m.keys[key] = { ts: Date.now(), size: body.length, hash: sha256Hex(body) };
    await writeManifest(slot, m);
    return m.keys[key];
  });
}

async function getKeyBuf(slot, key) {
  const name = Buffer.from(key, 'utf8').toString('base64url');
  try { return await fsp.readFile(path.join(slotDir(slot), DATA_SUBDIR, name)); }
  catch { return null; }
}

async function deleteKey(slot, key) {
  return enqueue(slot, async () => {
    const name = Buffer.from(key, 'utf8').toString('base64url');
    let removed = false;
    try { await fsp.unlink(path.join(slotDir(slot), DATA_SUBDIR, name)); removed = true; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const m = await readManifest(slot);
    if (m.keys[key]) { delete m.keys[key]; await writeManifest(slot, m); }
    return removed;
  });
}

// manifest 缺失时从数据目录自愈重建（直接改卷/误删后自愈）
async function rebuildManifest(slot) {
  return enqueue(slot, async () => {
    const m = await readManifest(slot);
    if (Object.keys(m.keys).length > 0) return m;
    const dir = path.join(slotDir(slot), DATA_SUBDIR);
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return m; }
    for (const n of names) {
      if (!n.endsWith('.tmp') && !n.includes('/')) {
        try {
          const buf = await fsp.readFile(path.join(dir, n));
          const key = Buffer.from(n, 'base64url').toString('utf8');
          if (key && !m.keys[key]) m.keys[key] = { ts: 0, size: buf.length, hash: sha256Hex(buf) };
        } catch { /* 单文件失败跳过 */ }
      }
    }
    if (Object.keys(m.keys).length > 0) await writeManifest(slot, m);
    return m;
  });
}

async function readBody(req) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 请求处理主入口（导出供测试 harness 挂载复用）。 */
export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://local');
  // /sync 前缀可带可不带（nginx 透传原样 URI；直连时允许裸路径）
  const p = url.pathname.replace(/^\/sync(?=\/)/, '');
  try {
    if (p === '/healthz') { sendRaw(res, 200, Buffer.from('ok\n')); return; }
    if (p === '/config' && req.method === 'GET') {
      sendJson(res, 200, { tokenRequired: Boolean(SYNC_TOKEN), maxBody: MAX_BODY });
      return;
    }

    const slot = safeSlot(req.headers['x-sync-slot'] || '');
    if (!slot) { sendJson(res, 400, { error: 'bad slot' }); return; }

    let m = /^\/key\/(.+)$/.exec(p);
    if (m) {
      if (!tokenOk(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      let key;
      try { key = decodeURIComponent(m[1]); } catch { sendJson(res, 400, { error: 'bad key' }); return; }
      if (!key || key.length > 200 || key.includes('/') || key.includes('\\') || key.includes('\x00')) {
        sendJson(res, 400, { error: 'bad key' });
        return;
      }
      if (req.method === 'GET') {
        const meta = (await readManifest(slot)).keys[key];
        if (!meta) { const buf = await getKeyBuf(slot, key); if (!buf) { sendJson(res, 404, { error: 'not found' }); return; } sendRaw(res, 200, buf); return; }
        const buf = await getKeyBuf(slot, key);
        if (!buf) { sendJson(res, 404, { error: 'not found' }); return; }
        sendRaw(res, 200, buf);
        return;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const meta = await putKey(slot, key, body);
        sendJson(res, 200, { ok: true, ts: meta.ts, hash: meta.hash });
        return;
      }
      if (req.method === 'DELETE') {
        await deleteKey(slot, key);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (p === '/manifest' && req.method === 'GET') {
      if (!tokenOk(req)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const manifest = await rebuildManifest(slot);
      sendJson(res, 200, manifest);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error('[save-sync] 500', req.method, req.url, err);
    sendJson(res, status, { error: String((err && err.message) || err) });
  }
}

export function createServer() {
  return http.createServer((req, res) => { void handleRequest(req, res); });
}

// 直接运行（被 import 时不启动）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  createServer().listen(PORT, () => {
    console.log(`[save-sync] listening :${PORT} data=${DATA_DIR} token=${SYNC_TOKEN ? 'on' : 'off'} maxBody=${MAX_BODY}`);
  });
}
