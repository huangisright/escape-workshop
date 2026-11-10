// 離線備援的介面測試（Playwright + Chromium）：node --test tests/offline-ui.test.js
// 流程：連線玩 → 題目包準備好 → 斷線繼續玩（含答錯冷卻、重新整理）→ 玩到逃脫 → 連線後自動回傳
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildHarness } = require('./harness');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } catch (e2) { chromium = null; }
}
const URL = 'http://harness.local/';

async function openPage(browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 820, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const html = buildHarness();
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (u.includes('qrcode')) return route.fulfill({ contentType: 'text/javascript', body: 'window.QRCode=function(el,o){el.textContent=o.text;};' });
    return route.abort();
  });
  await page.goto(URL);
  return { page, errors };
}
const click = (page, sel) => page.locator(sel).first().click();

// 發布一間「自由選題」的密室（3 題：AIR / TIDE / ICE），回傳遊戲代碼
async function seedRoom(page, roomOpts) {
  return page.evaluate((roomOpts) => {
    GAS('setup')();
    const A = GAS('adminCode_')();
    GAS('adminSaveSettings')(A, { wrongCooldownSec: 1 });
    const t = GAS('adminCreateTeachers')(A, ['林老師'])[0];
    const mk = (title, answer, extra) => {
      const p = GAS('newPuzzle')(t.code);
      GAS('savePuzzle')(t.code, Object.assign({
        id: p.id, rev: 0, title, kind: 'digital', estMinutes: 5,
        steps: [{ get: '地圖', act: '找年份', result: '年份', checkpoint: '' }, { get: '年份', act: '換密碼', result: '密碼', checkpoint: '' }],
        blocks: [{ type: 'text', text: title + '：看圖找出密碼' }], answer, hints: [{ text: '看左上角', delaySec: 0 }],
        props: [], themeLink: '海平面上升', scienceBasis: 'IPCC AR6', reskinCheck: '拿掉主題就不成立'
      }, extra || {}));
      return p.id;
    };
    const ids = [mk('空氣塔', 'AIR / 空氣'), mk('潮汐塔', 'TIDE'), mk('冰山塔', 'ICE')];
    const room = GAS('adminCreateTeacherRoom')(A, '黃金城密室');
    GAS('adminSetRoomPuzzles')(A, room.id, ids, {});
    const cur = GAS('getRoom')(A, room.id);
    GAS('saveRoom')(A, Object.assign({
      id: room.id, rev: cur.rev, timeLimitMin: 90, mode: 'free',
      cover: { text: '傳說中的黃金城', imageId: '' }, story: [],
      success: { text: '大門打開，你們逃出來了！', imageId: '' }, fail: { text: '海水淹過了城門。', imageId: '' }
    }, roomOpts || {}));
    GAS('adminRoomAction')(A, room.id, 'publish');
    return GAS('getDoc_')('Rooms', room.id).playCode;
  }, roomOpts);
}
async function join(page, playCode, team) {
  await page.fill('#pcode', playCode);
  await click(page, '[data-act=toPlay]');
  await page.fill('#team', team);
  await page.fill('#mem input', '小明');
  await click(page, '[data-act=playStart]');
  await page.waitForSelector('[data-act=introNext]');
  while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
  await page.waitForSelector('#barIdx');
}
async function answer(page, text) {
  await page.waitForFunction(() => { const b = document.getElementById('goBtn'); return b && !b.disabled; });
  await page.fill('#ans', text);
  await click(page, '#goBtn');
}
const goOffline = async (page) => {
  await page.context().setOffline(true);
  await page.evaluate(() => { window.__real = window.GAS; window.GAS = function () { throw new Error('Failed to fetch'); }; });
};
const goOnline = async (page) => {
  await page.evaluate(() => { window.GAS = window.__real; });
  await page.context().setOffline(false);
};

test('用戶端的 SHA-256 與答案正規化，和 Node / 後端算出來的完全一樣', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser);
    await seedRoom(page);
    const samples = ['', 'abc', '密室工坊', 'er:v1|air', 'x'.repeat(200), '台灣🙂'];
    const got = await page.evaluate((xs) => xs.map((x) => sha256hex(unescape(encodeURIComponent(x)))), samples);
    samples.forEach((x, i) => assert.equal(got[i], crypto.createHash('sha256').update(x, 'utf8').digest('hex'), JSON.stringify(x)));
    const norms = ['  ＡＩＲ。', '臺灣！', 'Hello, World', '「空氣」', '１２３'];
    const pair = await page.evaluate((xs) => xs.map((x) => [offNorm(x), GAS('norm_')(x)]), norms);
    pair.forEach(([a, b], i) => assert.equal(a, b, norms[i]));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('玩到一半斷線：用題目包繼續玩（答錯冷卻、重新整理都不掉進度）→ 逃脫 → 連線後自動回傳', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 820, height: 1000 });
    const code = await seedRoom(page);
    await join(page, code, '斷線隊');

    // 連線時先解一題；題目包在背景下載完，畫面上會顯示「離線備援已就緒」
    await answer(page, 'air');
    await page.waitForFunction(() => /^已過 1 \/ 3 題$/.test(document.getElementById('barIdx').textContent));
    await page.waitForFunction(() => OFF.status === 'ready');
    assert.match(await page.textContent('#offbar'), /離線備援已就緒/);

    // 斷線：答錯 → 冷卻 → 答對，全都在這台裝置上判斷
    await goOffline(page);
    await answer(page, 'zzz');
    await page.waitForFunction(() => /答案不對/.test(document.getElementById('pmsg').textContent));
    assert.equal(await page.evaluate(() => OFF.mode), 'local');
    assert.match(await page.textContent('#offbar'), /目前沒有網路/);
    assert.match(await page.textContent('#goBtn'), /請等/, '答錯冷卻照樣算');
    await answer(page, 'Tide '); // 大小寫、空白都不影響
    await page.waitForFunction(() => /^已過 2 \/ 3 題$/.test(document.getElementById('barIdx').textContent) || document.querySelector('.flash'));
    await page.waitForFunction(() => /^已過 2 \/ 3 題$/.test(document.getElementById('barIdx').textContent));

    // 斷線時重新整理（或分頁被回收）：接回同一場，進度不掉
    await page.evaluate(() => { S.play = null; clearTimers(); document.getElementById('app').innerHTML = ''; boot(); });
    await page.waitForSelector('#barIdx');
    assert.equal(await page.textContent('#barIdx'), '已過 2 / 3 題');
    assert.equal(await page.locator('#code').count(), 0, '沒有跳回登入頁');
    assert.equal(await page.evaluate(() => OFF.mode), 'local');

    // 提示也能用
    await click(page, '#hintBtn');
    await page.waitForSelector('.phint');

    // 解開最後一題 → 逃脫，出證書；成績還沒回傳的提醒要在
    await answer(page, 'ice');
    await page.waitForSelector('.seal', { timeout: 8000 });
    assert.match(await page.textContent('#app'), /逃脫成功/);
    assert.match(await page.textContent('#offbar'), /成績還沒回傳/);

    // 還沒回傳時，不能離開
    await page.fill('#liked', '空氣塔');
    await click(page, '[data-act=star][data-v="3"]');
    await click(page, '[data-act=sendRate]');
    await page.waitForSelector('[data-act=toLogin]');
    await click(page, '[data-act=toLogin]');
    assert.match(await page.textContent('#toast'), /成績還沒回傳/);

    // 伺服器上這時還沒有結果
    const before = await page.evaluate(() => { const p = __real('readAll_')('Plays')[0]; return { result: p.result, solved: JSON.parse(p.state).ps ? JSON.parse(p.state).ps.filter((x) => x.done).length : 0 }; });
    assert.equal(before.result, '');

    // 網路回來：自動回傳
    await goOnline(page);
    await page.waitForFunction(() => OFF.mode === 'online' && !OFF.pending, null, { timeout: 15000 });
    assert.match(await page.textContent('#offbar'), /已回傳/);
    const server = await page.evaluate(() => {
      const p = __real('readAll_')('Plays')[0];
      const st = JSON.parse(p.state);
      return { result: p.result, escapeSec: st.escapeSec, done: st.ps.filter((x) => x.done).length,
        events: __real('readAll_')('Events').map((e) => e.type), ratings: __real('readAll_')('Ratings').length };
    });
    assert.equal(server.result, 'escaped');
    assert.equal(server.done, 3);
    assert.ok(server.escapeSec >= 0);
    ['wrong', 'solve', 'hint', 'end'].forEach((t) => assert.ok(server.events.includes(t), '事件紀錄有 ' + t));
    await page.waitForFunction(() => __real('readAll_')('Ratings').length > 0, null, { timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('同隊名重新進入：接回原本那場；題目包沒準備好時斷線，維持原本的重試畫面', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser);
    const code = await seedRoom(page);
    await join(page, code, '重整隊');
    await answer(page, 'air');
    await page.waitForFunction(() => /^已過 1 \/ 3 題$/.test(document.getElementById('barIdx').textContent));
    const first = await page.evaluate(() => S.play.id);
    // 按「到登入頁」再用同隊名進來：不開新局
    await page.evaluate(() => { S.play = null; store('erPlay', null); store('erOff', null); clearTimers(); boot(); });
    await page.waitForSelector('#pcode');
    await join2(page, code, '重整隊');
    assert.equal(await page.evaluate(() => S.play.id), first);
    assert.equal(await page.textContent('#barIdx'), '已過 1 / 3 題', '進度與計時都還在');

    // 這間密室開了「跳過扣時」→ 不支援離線：斷線時維持原本行為（重試畫面），不會玩壞
    const code2 = await page.evaluate(() => {
      const A = GAS('adminCode_')();
      const room = GAS('adminCreateTeacherRoom')(A, '跳過密室');
      const ids = GAS('allDocs_')('Puzzles').slice(0, 2).map((p) => p.id);
      GAS('adminSetRoomPuzzles')(A, room.id, ids, {});
      const cur = GAS('getRoom')(A, room.id);
      GAS('saveRoom')(A, { id: room.id, rev: cur.rev, timeLimitMin: 90, mode: 'free', skipMin: 5, cover: { text: '封面', imageId: '' }, story: [], success: { text: 'ok', imageId: '' }, fail: { text: 'no', imageId: '' } });
      GAS('adminRoomAction')(A, room.id, 'publish');
      return GAS('getDoc_')('Rooms', room.id).playCode;
    });
    await page.evaluate(() => { S.play = null; store('erPlay', null); store('erOff', null); OFF.st = null; OFF.bundle = null; OFF.playId = ''; clearTimers(); boot(); });
    await page.waitForSelector('#pcode');
    await join2(page, code2, '跳過隊');
    await page.waitForFunction(() => OFF.status === 'unsupported');
    await goOffline(page);
    await answer(page, 'zzz');
    await page.waitForFunction(() => /Failed to fetch|連不上|網路/.test(document.getElementById("toast").textContent));
    assert.equal(await page.evaluate(() => OFF.mode), 'online', '不支援離線的密室不會偷偷切到本機模式');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

async function join2(page, playCode, team) {
  await page.fill('#pcode', playCode);
  await click(page, '[data-act=toPlay]');
  await page.fill('#team', team);
  await page.fill('#mem input', '小明');
  await click(page, '[data-act=playStart]');
  await page.waitForSelector('#barIdx, [data-act=introNext]');
  while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
  await page.waitForSelector('#barIdx');
}
