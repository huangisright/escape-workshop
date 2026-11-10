// GitHub Pages 版的離線測試（真的走 fetch 呼叫 API，真的註冊 service worker）：node --test tests/pages-offline.test.js
// 用本機 http 伺服器提供 docs/，Apps Script 的 API 網址由 Playwright 攔下來，轉給 Node 裡跑的 Code.gs。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } catch (e2) { chromium = null; }
}
const DOCS = path.join(__dirname, '..', 'docs');
const click = (page, sel) => page.locator(sel).first().click();

function serveDocs() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const f = path.join(DOCS, u === '/' ? 'index.html' : u.replace(/^\//, ''));
      if (!f.startsWith(DOCS) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(f));
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('Pages 版：玩到一半整個斷線（含重新整理）也能繼續，連線後回傳', { skip: !chromium && '沒有 Playwright' }, async () => {
  const env = H.load();
  const { puzzles } = H.teacherWithPuzzles(env, ['AIR', 'TIDE', 'ICE']);
  const r = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '黃金城'));
  env.gs.adminSetRoomPuzzles(env.admin, r.id, puzzles.map((p) => p.id), {});
  H.fillRoomPages(env, env.admin, r.id);
  const cur = env.plain(env.gs.getRoom(env.admin, r.id));
  env.gs.saveRoom(env.admin, { id: r.id, rev: cur.rev, timeLimitMin: 90, mode: 'free' });
  const code = env.plain(env.gs.adminRoomAction(env.admin, r.id, 'publish')).playCode;

  const srv = await serveDocs();
  const base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1000 } });
    const calls = [];
    let down = false; // 模擬網路中斷：被攔下的 API 請求也要失敗（setOffline 管不到 route 攔下來的請求）
    await ctx.route('https://script.google.com/**', async (route) => {
      if (down === 'hang') return; // 連著 Wi-Fi 但實際不通：請求一直沒有回應
      if (down) return route.abort('internetdisconnected');
      const req = JSON.parse(route.request().postData() || '{}');
      calls.push(req.fn);
      let out;
      try { out = { ok: true, result: env.plain(env.gs[req.fn].apply(null, req.args || [])) }; } catch (e) { out = { ok: false, error: e.message }; }
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out === undefined ? null : out) });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '?p=' + code);
    await page.waitForSelector('#team');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.fill('#team', '真斷線隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    await page.waitForSelector('[data-act=introNext]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#barIdx');
    await page.fill('#ans', 'air');
    await click(page, '#goBtn');
    await page.waitForFunction(() => /^已過 1 \/ 3 題$/.test(document.getElementById('barIdx').textContent));
    await page.waitForFunction(() => OFF.status === 'ready');
    assert.ok(calls.includes('playBundle'));

    // 整台斷網：答題 → 重新整理（靠 service worker 打開頁面）→ 接回 → 逃脫
    down = true; await ctx.setOffline(true);
    await page.waitForFunction(() => { const b = document.getElementById('goBtn'); return b && !b.disabled; });
    await page.fill('#ans', 'tide');
    await click(page, '#goBtn');
    await page.waitForFunction(() => /^已過 2 \/ 3 題$/.test(document.getElementById('barIdx').textContent));
    assert.equal(await page.evaluate(() => OFF.mode), 'local');
    await page.reload();
    await page.waitForSelector('#barIdx', { timeout: 15000 });
    assert.equal(await page.textContent('#barIdx'), '已過 2 / 3 題', '斷網重新整理後進度還在');
    await page.waitForFunction(() => { const b = document.getElementById('goBtn'); return b && !b.disabled; });
    await page.fill('#ans', 'ice');
    await click(page, '#goBtn');
    await page.waitForSelector('.seal', { timeout: 10000 });
    assert.equal(env.plain(env.gs.readAll_('Plays'))[0].result, '', '斷網時伺服器還沒有結果');

    down = false; await ctx.setOffline(false);
    await page.waitForFunction(() => OFF.mode === 'online' && !OFF.pending, null, { timeout: 20000 });
    const p = env.plain(env.gs.readAll_('Plays'))[0];
    assert.equal(p.result, 'escaped');
    assert.equal(JSON.parse(p.state).ps.filter((x) => x.done).length, 3);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); srv.close(); }
});

test('Wi-Fi 連著但不通（請求一直沒回應）：15 秒後當作斷線，改用離線備援', { skip: !chromium && '沒有 Playwright' }, async () => {
  const env = H.load();
  const { puzzles } = H.teacherWithPuzzles(env, ['AIR', 'TIDE']);
  const r = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '黃金城'));
  env.gs.adminSetRoomPuzzles(env.admin, r.id, puzzles.map((p) => p.id), {});
  H.fillRoomPages(env, env.admin, r.id);
  const cur = env.plain(env.gs.getRoom(env.admin, r.id));
  env.gs.saveRoom(env.admin, { id: r.id, rev: cur.rev, timeLimitMin: 90, mode: 'free' });
  const code = env.plain(env.gs.adminRoomAction(env.admin, r.id, 'publish')).playCode;
  const srv = await serveDocs();
  const base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1000 } });
    let down = false;
    await ctx.route('https://script.google.com/**', async (route) => {
      if (down === 'hang') return;
      const req = JSON.parse(route.request().postData() || '{}');
      let out;
      try { out = { ok: true, result: env.plain(env.gs[req.fn].apply(null, req.args || [])) }; } catch (e) { out = { ok: false, error: e.message }; }
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out === undefined ? null : out) });
    });
    const page = await ctx.newPage();
    await page.goto(base + '?p=' + code);
    await page.fill('#team', '卡住隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    await page.waitForSelector('[data-act=introNext]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#barIdx');
    await page.waitForFunction(() => OFF.status === 'ready');
    down = 'hang';
    await page.fill('#ans', 'air');
    await click(page, '#goBtn');
    await page.waitForFunction(() => /^已過 1 \/ 2 題$/.test(document.getElementById('barIdx').textContent), null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => OFF.mode), 'local');
    down = false;
    await page.waitForFunction(() => OFF.mode === 'online' && !OFF.pending, null, { timeout: 20000 });
    const p = env.plain(env.gs.readAll_('Plays'))[0];
    assert.equal(JSON.parse(p.state).ps.filter((x) => x.done).length, 1, '卡住時答的那題也回傳了');
  } finally { await browser.close(); srv.close(); }
});
