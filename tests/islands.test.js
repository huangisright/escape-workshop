// 密室島：已發布的學生密室公開展示（不用登入）。node --test tests/islands.test.js
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

// 一組學生出好題目，管理者直接發布；回傳密室與玩家代碼
function publishedGroupRoom(env, name, members, puzzles, pub) {
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name, members: members.join('、') }]))[0];
  const ws = env.plain(env.gs.getWorkspace(g.code));
  puzzles.forEach((q) => {
    const p = env.plain(env.gs.newPuzzle(g.code));
    H.savePuzzle(env, g.code, p, H.fullPuzzle(q));
  });
  H.fillRoomPages(env, g.code, ws.room.id);
  if (pub === false) return { room: ws.room, code: g.code };
  env.advance(1); // 模擬的時鐘不會自己走：隔一秒再發布，版本號才不會撞在一起
  const room = env.plain(env.gs.adminRoomAction(env.admin, ws.room.id, 'publish'));
  return { room, code: g.code };
}

// 自由選題：一題一題打開、答對，直到逃脫
function escapeAll(env, playCode, team, answers) {
  const intro = env.plain(env.gs.playStart(playCode, team, ['甲']));
  env.gs.playBegin(intro.playId);
  let r;
  answers.forEach((ans, i) => {
    env.gs.playOpen(intro.playId, i);
    env.advance(30);
    r = env.plain(env.gs.playAnswer(intro.playId, ans));
  });
  return r.state;
}

test('只列已發布的學生密室，帶組名、組員、各關設計者與遊玩數據，不含答案', () => {
  const env = H.load();
  const A = publishedGroupRoom(env, '第一組', ['王小明', '李小華'], [
    { title: '漲潮時刻表', author: '王小明', answer: 'TIDE' },
    { title: '消失的海岸線', author: '李小華', answer: 'COAST' }
  ]);
  publishedGroupRoom(env, '第二組', ['陳大文'], [{ title: '還在做', author: '陳大文', answer: 'NOPE' }], false);
  env.advance(1);
  H.publishedTeacherRoom(env, ['T1']); // 老師示範密室不上島

  const st = escapeAll(env, A.room.playCode, '潮汐隊', ['TIDE', 'COAST']);
  assert.equal(st.result, 'escaped');
  H.startPlay(env, A.room.playCode, '沒逃出來隊');
  env.gs.startTestPlay(env.admin, A.room.id); // 試玩不算

  const out = env.plain(env.gs.islandRooms());
  assert.equal(out.rooms.length, 1);
  const R = out.rooms[0];
  assert.equal(R.group, '第一組');
  assert.equal(R.theme, '小島');
  assert.equal(R.story, '海水上漲了');
  assert.deepEqual(R.members, ['王小明', '李小華']);
  assert.deepEqual(R.puzzles, [{ title: '漲潮時刻表', author: '王小明' }, { title: '消失的海岸線', author: '李小華' }]);
  assert.equal(R.plays, 2);
  assert.equal(R.escaped, 1);
  assert.ok(R.bestSec > 0);
  assert.equal(R.playCode, A.room.playCode);
  const raw = JSON.stringify(out);
  assert.ok(!raw.includes('TIDE') && !raw.includes('COAST'), '答案不能出現在公開頁');
  assert.ok(!raw.includes('看左上角'), '提示不能出現在公開頁');
});

test('內容取自發布版本；發布或下架後馬上更新', () => {
  const env = H.load();
  const A = publishedGroupRoom(env, '第一組', ['甲'], [{ title: '原本的題目', author: '甲', answer: 'X' }]);
  assert.equal(env.plain(env.gs.islandRooms()).rooms[0].puzzles[0].title, '原本的題目');

  // 發布後才改的草稿不會上島，重新發布才更新
  const r = env.plain(env.gs.getRoom(A.code));
  env.gs.saveRoom(A.code, { id: r.id, rev: r.rev, story: [{ text: '還沒審核的新故事', imageId: '' }] });
  env.gs.CacheService.getScriptCache().remove('islands:v1');
  assert.equal(env.plain(env.gs.islandRooms()).rooms[0].story, '海水上漲了');
  env.advance(1);
  env.gs.adminRoomAction(env.admin, A.room.id, 'publish');
  assert.equal(env.plain(env.gs.islandRooms()).rooms[0].story, '還沒審核的新故事', '重新發布後更新');

  env.gs.adminRoomAction(env.admin, A.room.id, 'unpublish');
  assert.equal(env.plain(env.gs.islandRooms()).rooms.length, 0, '下架就從島上消失');
});

test('API 有開放 islandRooms，而且不用代碼', () => {
  const env = H.load();
  assert.ok(env.gs.API_FUNCTIONS.indexOf('islandRooms') >= 0);
  assert.deepEqual(env.plain(env.gs.islandRooms()).rooms, []);
});

function serveDocs() {
  const DOCS = path.join(__dirname, '..', 'docs');
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

test('展示頁：島排成一圈，切換時選到的島轉到中間；名字可以隱藏；連到遊戲', { skip: !chromium && '沒有 Playwright' }, async () => {
  const env = H.load();
  const A = publishedGroupRoom(env, '第一組', ['王小明'], [{ title: '漲潮時刻表', author: '王小明', answer: 'A' }]);
  publishedGroupRoom(env, '第二組', ['李小華'], [{ title: '浮冰拼圖', author: '李小華', answer: 'B' }, { title: '融冰計時器', author: '李小華', answer: 'C' }]);
  publishedGroupRoom(env, '第三組', ['陳大文'], [{ title: '屋頂的顏色', author: '陳大文', answer: 'D' }]);

  const srv = await serveDocs();
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('https://script.google.com/**', async (route) => {
      const req = JSON.parse(route.request().postData() || '{}');
      let out;
      try { out = { ok: true, result: env.plain(env.gs[req.fn].apply(null, req.args || [])) }; } catch (e) { out = { ok: false, error: e.message }; }
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:' + srv.address().port + '/islands.html');
    await page.waitForSelector('.isle.on');
    assert.equal(await page.locator('.isle').count(), 3);
    assert.match(await page.textContent('#sPuzzles'), /4/);
    assert.match(await page.textContent('.panel h2'), /第一組|密室/);
    assert.equal(await page.textContent('#count'), 'ISLAND 1 / 3');
    assert.ok(await page.locator('.panel .who', { hasText: '王小明' }).count());

    // 點旁邊的島：轉到中間
    await page.locator('.isle[data-i="1"]').click();
    assert.equal(await page.textContent('#count'), 'ISLAND 2 / 3');
    assert.equal(await page.getAttribute('.isle[data-i="1"]', 'aria-pressed'), 'true');
    assert.match(await page.textContent('.panel'), /浮冰拼圖/);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.textContent('#count'), 'ISLAND 3 / 3');
    await page.locator('.arrow.r').click();
    assert.equal(await page.textContent('#count'), 'ISLAND 1 / 3', '繞一圈回到第一座');

    // 隱藏名字
    await page.click('#namesBtn');
    assert.equal(await page.locator('.panel .who').count(), 0);
    assert.match(await page.textContent('.panel'), /設計者名字已隱藏/);

    // 登島挑戰：帶玩家代碼回密室工坊
    assert.equal(await page.getAttribute('.panel .go', 'href'), './?p=' + encodeURIComponent(A.room.playCode));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    srv.close();
  }
});
