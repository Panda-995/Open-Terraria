import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://127.0.0.1:8080';
async function get(path, status = 200) {
  const r = await fetch(base + path);
  assert.equal(r.status, status, path);
  return r;
}
assert.equal(await (await get('/healthz')).text(), 'ok\n');
const page = await get('/');
assert.match(page.headers.get('content-type') ?? '', /text\/html/);
assert.match(page.headers.get('cache-control') ?? '', /no-cache/);
const html = await page.text();
assert.match(html, /game-root/);
const js = html.match(/src="(\/assets\/[^\"]+\.js)"/);
assert.ok(js, 'Vite entry bundle');
const bundle = await get(js[1]);
assert.match(bundle.headers.get('cache-control') ?? '', /immutable/);
await bundle.arrayBuffer();
for (const path of ['/sw.js', '/sw-twa.js', '/build-id.txt', '/assets-zip/manifest.json', '/manifest.json']) {
  const r = await get(path);
  assert.match(r.headers.get('cache-control') ?? '', /no-cache/, path);
  await r.arrayBuffer();
}
const zipManifest = await (await get('/assets-zip/manifest.json')).json();
assert.ok(zipManifest.parts.length > 0, 'asset ZIP parts');
const zip = await get('/assets-zip/' + zipManifest.parts[0].file);
assert.match(zip.headers.get('content-type') ?? '', /zip/);
assert.match(zip.headers.get('cache-control') ?? '', /immutable/);
await zip.arrayBuffer();
await (await get('/l10n/zh-Hans.json')).json();
assert.ok((await (await get('/sprites/vanilla/Item_Atlas_0.png')).arrayBuffer()).byteLength > 1000, 'HTTP fallback sprites');
for (const path of ['/sprites/vanilla/missing-test.png', '/assets/missing-test.js']) await get(path, 404);
console.log('PASS: health, homepage, JS bundle, SW, version, language, ZIPs, fallback assets, cache headers and 404s');
