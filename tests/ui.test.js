// 介面測試（Playwright + Chromium）：node --test tests/ui.test.js
// 截圖存到環境變數 SHOTS 指定的資料夾（沒設就不存）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildHarness } = require('./harness');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } catch (e2) { chromium = null; }
}

const URL = 'http://harness.local/';
const SHOTS = process.env.SHOTS || '';

async function openPage(browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1024, height: 768 } });
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

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

// 用後端直接建好老師、題目與示範密室（老師填卡片的介面是 v4 原有的，不在這裡重測）
async function seed(page) {
  return page.evaluate(() => {
    GAS('setup')();
    const A = GAS('adminCode_')();
    GAS('adminSaveSettings')(A, { wrongCooldownSec: 1 });
    const t = GAS('adminCreateTeachers')(A, ['林老師'])[0];
    const mk = (title, answer) => {
      const p = GAS('newPuzzle')(t.code);
      GAS('savePuzzle')(t.code, {
        id: p.id, rev: 0, title, kind: 'digital', estMinutes: 5,
        steps: [{ get: '地圖', act: '找年份', result: '年份', checkpoint: '' }, { get: '年份', act: '換密碼', result: '密碼', checkpoint: '' }],
        blocks: [{ type: 'text', text: title + '：看圖找出密碼' }], answer, hints: [{ text: '看左上角', delaySec: 0 }],
        props: [], themeLink: '海平面上升', scienceBasis: 'IPCC AR6', reskinCheck: '拿掉主題就不成立'
      });
    };
    mk('空氣塔', 'AIR'); mk('潮汐塔', 'TIDE'); mk('冰山塔', 'ICE'); mk('寶庫：權杖', 'GEM');
    const room = GAS('adminCreateTeacherRoom')(A, '黃金城密室');
    GAS('saveRoom')(A, {
      id: room.id, rev: 0, timeLimitMin: 90, mode: 'linear',
      cover: { text: '傳說中的黃金城', imageId: '' }, story: [{ text: '海水一年年上漲，城沉進了海底。', imageId: '' }],
      success: { text: '大門打開，你們逃出來了！', imageId: '' }, fail: { text: '海水淹過了城門。', imageId: '' }
    });
    return A;
  });
}

const click = (page, sel) => page.locator(sel).first().click();

test('管理者設定終章、跳過、寶庫 → 發布 → 玩家完整走完 → 監看與數據', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser);
    const admin = await seed(page);

    // 管理者登入 → 示範密室：開啟終章、跳過扣 5 分鐘
    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=bank]');
    await click(page, '[data-act=trEdit]');
    await page.fill('[data-f=skipMin]', '5');
    await page.check('[data-check="finale.enabled"]');
    await page.fill('[data-f="finale.text"]', '五塊碎片拼回大門上，把線索簿上的碎片依序輸入。');
    await page.fill('[data-f="finale.hint"]', '從第一塊讀到最後一塊');
    await shot(page, '1-admin-optional-play');
    await click(page, '[data-act=backRoom]');

    // 挑題與排序：三題主線（碎片 7、3、1）、一題寶庫
    await click(page, '[data-act=assemble]');
    for (const t of ['空氣塔', '潮汐塔', '冰山塔']) {
      await page.locator('.item', { hasText: t }).locator('[data-act=asmAdd]').click();
    }
    await page.locator('.item', { hasText: '寶庫：權杖' }).locator('[data-act=asmVault]').click();
    await page.fill('[data-asmfrag="0"]', '7');
    await page.fill('[data-asmfrag="1"]', '3');
    await page.fill('[data-asmfrag="2"]', '1');
    assert.equal(await page.textContent('#asmJoined'), '731');
    await shot(page, '2-admin-assemble');
    await click(page, '[data-act=asmSave]');
    await page.waitForSelector('[data-act=adminTab][data-tab=bank].on');
    assert.match(await page.textContent('#adminBody'), /終章碎片、跳過扣 5 分、寶庫 1 題/);

    // 發布
    await click(page, '[data-act=adminTab][data-tab=overview]');
    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=roomAction][data-a=publish]').click();
    await click(page, '#cfOk');
    await page.waitForSelector('#modal .big');
    const playCode = (await page.textContent('#modal .big')).trim();
    assert.match(playCode, /^P[A-Z2-9]{4}$/);
    await click(page, '#modal .x');

    // 玩家
    await click(page, '[data-act=logout]');
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '探險隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    await page.waitForSelector('[data-act=introNext]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#barIdx');
    assert.equal(await page.textContent('#barIdx'), '第 1 / 3 題');
    assert.equal(await page.locator('.frag.empty').count(), 3);
    await shot(page, '3-play-main');

    const answer = async (v) => {
      await page.fill('#ans', v);
      await click(page, '#goBtn');
    };
    await answer('wrong');
    await page.waitForFunction(() => /答案不對/.test(document.getElementById('pmsg').textContent));
    await page.waitForFunction(() => !document.getElementById('goBtn').disabled, null, { timeout: 5000 });
    await answer('air');
    await page.waitForSelector('.flash');
    assert.match(await page.textContent('.flash'), /拿到碎片「7」/);
    await page.waitForFunction(() => document.getElementById('barIdx') && document.getElementById('barIdx').textContent === '第 2 / 3 題');
    assert.equal(await page.locator('.frag:not(.empty)').count(), 1);

    await click(page, '[data-act=skip]');
    assert.match(await page.textContent('#modal'), /扣 5 分鐘，但照樣拿到這一題的碎片/);
    await click(page, '#cfOk');
    await page.waitForFunction(() => document.getElementById('barIdx') && document.getElementById('barIdx').textContent === '第 3 / 3 題');
    const timer = await page.textContent('#tm');
    assert.ok(Number(timer.split(':')[0]) <= 85, '扣了 5 分鐘：' + timer);

    await answer('ICE');
    await page.waitForFunction(() => document.getElementById('barIdx') && document.getElementById('barIdx').textContent === '終章');
    assert.match(await page.textContent('#blocks'), /依序輸入/);
    assert.equal(await page.locator('.frag:not(.empty)').count(), 3);
    assert.equal(await page.locator('[data-act=skip]').count(), 0, '終章不能跳過');
    await click(page, '#hintBtn');
    await page.waitForSelector('.phint');
    await shot(page, '4-play-finale');

    await answer('7 3 1');
    await page.waitForSelector('.flash');
    assert.equal(await page.textContent('.flash'), '逃脫成功！');
    await page.waitForSelector('.vaultnote');
    assert.equal(await page.textContent('#barIdx'), '寶庫 1 / 1');
    await shot(page, '5-play-vault');

    await answer('GEM');
    await page.waitForSelector('[data-act=sendRate]');
    const end = await page.textContent('.play');
    assert.match(end, /逃脫成功！/);
    assert.match(end, /用時 5:\d\d（含跳過扣時 5 分鐘）/);
    assert.match(end, /寶庫寶物 1 \/ 1 件/);
    assert.match(end, /寶庫 1　寶庫：權杖/);
    await shot(page, '6-cert');
    await shot(page, '6-play-ending');
    await page.locator('[data-act=star][data-v="3"]').first().click();
    await click(page, '[data-act=sendRate]');
    await page.waitForSelector('text=謝謝你的回饋');

    // 管理者：進行中與數據
    await click(page, '[data-act=toLogin]');
    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=live]');
    await page.waitForSelector('#adminBody table');
    const live = await page.textContent('#adminBody');
    assert.match(live, /探險隊/);
    assert.match(live, /逃脫成功 5:\d\d/);
    assert.match(live, /寶物 1/);
    await shot(page, '7-admin-live');
    await click(page, '[data-act=adminTab][data-tab=overview]');
    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=adminStats]').click();
    await page.waitForSelector('table');
    const stats = await page.textContent('.wrap');
    assert.match(stats, /平均逃脫時間 5\.\d 分鐘/);
    assert.match(stats, /V1寶庫：權杖/);
    await shot(page, '8-admin-stats');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('一般密室（沒開選用玩法）畫面跟原本一樣，手機寬度不會橫向捲動', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 390, height: 844 });
    const playCode = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      const t = GAS('adminCreateTeachers')(A, ['陳老師'])[0];
      const p = GAS('newPuzzle')(t.code);
      GAS('savePuzzle')(t.code, { id: p.id, rev: 0, title: '唯一的一題', kind: 'digital', estMinutes: 5,
        steps: [{ get: 'a', act: 'b', result: 'c', checkpoint: '' }], blocks: [{ type: 'text', text: '題目' }],
        answer: 'ONE', hints: [{ text: '提示', delaySec: 0 }], themeLink: 'x', scienceBasis: 'y', reskinCheck: 'z' });
      const room = GAS('adminCreateTeacherRoom')(A, '一般密室');
      GAS('adminSetRoomPuzzles')(A, room.id, [p.id]);
      GAS('saveRoom')(A, { id: room.id, rev: 1, cover: { text: '封面', imageId: '' }, story: [{ text: '說明', imageId: '' }],
        success: { text: '成功', imageId: '' }, fail: { text: '失敗', imageId: '' } });
      return GAS('adminRoomAction')(A, room.id, 'publish').playCode;
    });
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '一隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#barIdx');
    assert.equal(await page.locator('.frags').count(), 0, '沒有線索簿');
    assert.equal(await page.locator('[data-act=skip]').count(), 0, '沒有跳過');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    await shot(page, '9-phone-plain');
    await page.fill('#ans', 'one');
    await click(page, '#goBtn');
    await page.waitForSelector('[data-act=sendRate]');
    assert.match(await page.textContent('.play'), /用時 0:\d\d/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('自由選題（預設）：設計者選地圖樣式、預覽 → 玩家在小島地圖上挑題 → 監看顯示已過幾題', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 820, height: 1180 });
    const admin = await seed(page);
    await page.evaluate((A) => {
      const room = GAS('allDocs_')('Rooms').filter((r) => r.kind === 'teacher')[0];
      const bank = GAS('allDocs_')('Puzzles');
      const ids = ['空氣塔', '潮汐塔', '冰山塔'].map((t) => bank.filter((p) => p.title === t)[0].id);
      GAS('adminSetRoomPuzzles')(A, room.id, ids, { fragments: ['7', '3', '1'] });
      const r = GAS('getRoom')(A, room.id);
      // seed 把它設成一題接一題；這裡拿掉，模擬沒設過玩法的密室 → 預設自由選題
      const doc = GAS('getDoc_')('Rooms', room.id); delete doc.mode; delete doc.theme; GAS('putDoc_')('Rooms', doc);
      const r2 = GAS('getRoom')(A, room.id);
      GAS('saveRoom')(A, { id: room.id, rev: r2.rev, finale: { enabled: true, text: '依位置輸入碎片', imageId: '', answer: '', hint: '' } });
    }, admin);

    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=bank]');
    await click(page, '[data-act=trEdit]');
    assert.equal(await page.inputValue('[data-f=mode]'), 'free', '預設自由選題');
    assert.equal(await page.textContent('.themes button.on'), '小島');
    await page.waitForSelector('#mapPreview svg');
    await shot(page, 'f0-admin-mode');
    for (const t of ['jigsaw', 'planet', 'island']) {
      await click(page, `[data-act=setTheme][data-t=${t}]`);
      await page.waitForSelector('#mapPreview svg');
      if (SHOTS) await page.locator('#mapPreview').screenshot({ path: path.join(SHOTS, 'f1-preview-' + t + '.png') });
    }
    // 改成一題接一題時，地圖樣式就收起來
    await page.selectOption('[data-f=mode]', 'linear');
    await page.waitForFunction(() => !document.getElementById('mapPreview'));
    await page.selectOption('[data-f=mode]', 'free');
    await page.waitForSelector('#mapPreview svg');
    await click(page, '[data-act=backRoom]');
    await click(page, '[data-act=adminTab][data-tab=bank]');
    await page.waitForFunction(() => /自由選題・小島、終章碎片/.test(document.getElementById('adminBody').textContent));
    await click(page, '[data-act=adminTab][data-tab=overview]');
    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=roomAction][data-a=publish]').click();
    await click(page, '#cfOk');
    await page.waitForSelector('#modal .big');
    const playCode = (await page.textContent('#modal .big')).trim();
    await click(page, '#modal .x');

    // 玩家
    await click(page, '[data-act=logout]');
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '自由隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    await page.waitForSelector('[data-act=introNext]');
    while (await page.locator('[data-act=introNext]').count()) {
      if (await page.locator('[data-act=introNext]', { hasText: '開始挑戰' }).count()) assert.match(await page.textContent('.pcard'), /自己挑順序/);
      await click(page, '[data-act=introNext]');
    }
    await page.waitForSelector('#board svg');
    assert.equal(await page.textContent('#barIdx'), '已過 0 / 3 題');
    assert.equal(await page.locator('#board [data-act=openQ]').count(), 2, '目前這題不用點，其他兩座島可以點');
    assert.match(await page.textContent('.maphint'), /小島/);

    // 用鍵盤選第 3 座島
    await page.focus('#board [data-act=openQ][data-i="2"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /冰山塔/.test(document.querySelector('.pcard h2').textContent));
    await shot(page, 'f2-play-island');
    const answer = async (v) => { await page.fill('#ans', v); await click(page, '#goBtn'); };
    await answer('ICE');
    await page.waitForSelector('.flash');
    await page.waitForFunction(() => document.getElementById('barIdx') && document.getElementById('barIdx').textContent === '已過 1 / 3 題');
    assert.equal(await page.locator('#board [data-act=openQ][data-i="2"]').count(), 0, '解開的島不能再點');
    assert.deepEqual(await page.locator('.frag').allTextContents(), ['1', '2', '1']);
    await shot(page, 'f3-play-island-solved');

    // 收起、打開地圖
    await click(page, '[data-act=toggleMap]');
    await page.waitForFunction(() => !document.querySelector('#board svg'));
    assert.match(await page.textContent('#board'), /已過 1 \/ 3 題/);
    await click(page, '[data-act=toggleMap]');
    await page.waitForSelector('#board svg');

    await page.waitForFunction(() => /空氣塔/.test(document.querySelector('.pcard h2').textContent));
    await answer('AIR');
    await page.waitForFunction(() => document.getElementById('barIdx') && document.getElementById('barIdx').textContent === '已過 2 / 3 題');
    await page.waitForFunction(() => /潮汐塔/.test(document.querySelector('.pcard h2').textContent));
    await answer('TIDE');
    await page.waitForFunction(() => document.getElementById('barIdx') && document.getElementById('barIdx').textContent === '終章');
    assert.ok(!(await page.locator('#board').isVisible()), '終章不顯示地圖');
    await answer('731');
    await page.waitForSelector('[data-act=sendRate]');
    assert.match(await page.textContent('.play'), /逃脫成功！/);
    await click(page, '[data-act=sendRate]');
    await page.waitForSelector('text=謝謝你的回饋');

    await click(page, '[data-act=toLogin]');
    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=live]');
    await page.waitForSelector('#adminBody table');
    assert.match(await page.textContent('#adminBody'), /自由隊/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 820));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('拼圖地圖：解開的塊拼出封面圖；手機寬度不會橫向捲動', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 390, height: 844 });
    // 12 題的拼圖（4×3），塞一張畫好的封面圖，直接畫出地圖看凸凹與裁切
    const html = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 600; c.height = 450;
      const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 600, 450); grd.addColorStop(0, '#f6c453'); grd.addColorStop(1, '#2a7ab0');
      g.fillStyle = grd; g.fillRect(0, 0, 600, 450);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(300, 225, 120, 0, 7); g.fill();
      const img = c.toDataURL('image/png');
      const st = ['solved', 'solved', 'skipped', 'current', 'opened', 'solved', 'new', 'new', 'solved', 'new', 'opened', 'new'];
      const board = st.map((s, i) => ({ no: i + 1, title: '第' + (i + 1) + '關的題目名稱', status: s }));
      document.body.innerHTML = '<div class="play" style="background:#14181d"><div class="map" id="m">' + mapHtml(board, 'jigsaw', { image: img, uid: 't' }) + '</div></div>' +
        '<div class="play" style="background:#14181d"><div class="map">' + mapHtml(board, 'planet', {}) + '</div></div>' +
        '<div class="play" style="background:#14181d"><div class="map">' + mapHtml(board.slice(0, 7), 'island', {}) + '</div></div>';
      return document.getElementById('m').innerHTML;
    });
    assert.match(html, /clip-path="url\(#t-clip\)"/);
    assert.equal((html.match(/data-act="openQ"/g) || []).length, 6, '只有還沒解開、也不是目前這題的可以點');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    await shot(page, 'f4-maps-phone');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('代碼頁可以勾選多組一次刪除',{ skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser);
    const A = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      GAS('adminCreateGroups')(A, [1, 2, 3, 1, 2, 3].map((n) => ({ name: '第' + n + '組', members: '甲' })));
      return A;
    });
    await page.fill('#code', A);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=codes]');
    await page.waitForSelector('[data-groupcheck]');
    assert.equal(await page.locator('#delGroupsBtn').isDisabled(), true);
    const boxes = page.locator('[data-groupcheck]');
    assert.equal(await boxes.count(), 6);
    for (const i of [3, 4, 5]) await boxes.nth(i).check();
    assert.match(await page.locator('#delGroupsBtn').textContent(), /3 組/);
    await click(page, '#delGroupsBtn');
    await click(page, '#cfOk');
    await page.waitForFunction(() => document.querySelectorAll('[data-groupcheck]').length === 3);
    await shot(page, 'batch-delete-groups');
    await click(page, '[data-act=groupCheckAll]');
    assert.equal(await page.locator('[data-groupcheck]:checked').count(), 3);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('分組：按了馬上有反應，返回清單、調整順序、開密室資訊都不用等伺服器', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser);
    const g = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      return GAS('adminCreateGroups')(A, [{ name: '第一組', members: '甲、乙' }])[0];
    });
    await page.fill('#code', g.code);
    await click(page, '[data-act=login]');
    await page.waitForSelector('[data-act=newPuzzle]');

    // 把伺服器變慢（每次 1.5 秒），模擬 Apps Script 的實際延遲
    await page.evaluate(() => {
      const raw = window.apiRaw;
      window.__calls = [];
      window.apiRaw = function (fn) { window.__calls.push(fn); const a = arguments; return new Promise((r) => setTimeout(r, 1500)).then(() => raw.apply(null, a)); };
    });

    // 按「新增一題」：按鈕立刻轉圈、不能連按
    await click(page, '[data-act=newPuzzle]');
    assert.equal(await page.locator('[data-act=newPuzzle].busy').count(), 1, '按下去的按鈕要馬上顯示處理中');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#netbar.on').count(), 1, '頂端出現進度線');
    await page.locator('[data-act=newPuzzle]').click({ force: true }).catch(() => { });
    await page.waitForSelector('[data-f=title]');
    assert.equal((await page.evaluate(() => window.__calls)).filter((f) => f === 'newPuzzle').length, 1, '連按只送出一次');
    await page.fill('[data-f=title]', '第一題');

    // 返回：清單立刻出現，而且已經是剛改的標題
    const t0 = Date.now();
    await click(page, '[data-act=backPuzzle]');
    await page.waitForSelector('.item:has-text("第一題")');
    assert.ok(Date.now() - t0 < 1000, '返回清單不用等伺服器（花了 ' + (Date.now() - t0) + 'ms）');

    // 背景存好、更新完之後再做第二題
    await page.waitForFunction(() => NET.pending === 0 && !(S.saver && S.saver.pending()));
    await page.waitForTimeout(3500);
    await click(page, '[data-act=newPuzzle]');
    await page.waitForSelector('[data-f=title]');
    await page.fill('[data-f=title]', '第二題');
    await click(page, '[data-act=backPuzzle]');
    await page.waitForSelector('.item:has-text("第二題")');
    await page.waitForTimeout(3500);

    // 上移：畫面立刻換好，伺服器也存成同樣順序
    const order = () => page.$$eval('.item .t', (els) => els.map((e) => e.textContent));
    assert.deepEqual(await order(), ['第一題', '第二題']);
    const t1 = Date.now();
    await page.locator('.item', { hasText: '第二題' }).locator('[data-dir="-1"]').click();
    assert.deepEqual(await order(), ['第二題', '第一題']);
    assert.ok(Date.now() - t1 < 1000);
    await page.waitForTimeout(2000);
    const saved = await page.evaluate((code) => GAS('getWorkspace')(code).puzzles.map((p) => p.title), g.code);
    assert.deepEqual(saved, ['第二題', '第一題']);

    // 密室資訊：直接打開，可以編輯
    const t2 = Date.now();
    await click(page, '[data-act=editRoom]');
    await page.waitForSelector('[data-f="cover.text"]');
    assert.ok(Date.now() - t2 < 1000, '密室資訊不用等伺服器');
    assert.equal(await page.locator('[data-f="cover.text"]').isDisabled(), false);
    await page.fill('[data-f="cover.text"]', '封面文字');
    await click(page, '[data-act=backRoom]');
    await page.waitForTimeout(4000);
    const room = await page.evaluate((code) => GAS('getWorkspace')(code).room, g.code);
    assert.equal(room.cover.text, '封面文字');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('提示可以放圖片：老師上傳 → 玩家看提示時看到圖', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 820, height: 1180 });
    const seedInfo = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      const t = GAS('adminCreateTeachers')(A, ['陳老師'])[0];
      const p = GAS('newPuzzle')(t.code);
      GAS('savePuzzle')(t.code, { id: p.id, rev: 0, title: '海圖', kind: 'digital', estMinutes: 5,
        steps: [{ get: 'a', act: 'b', result: 'c', checkpoint: '' }], blocks: [{ type: 'text', text: '看海圖找密碼' }],
        answer: 'SEA', hints: [{ text: '看藍色的圓', delaySec: 0 }], themeLink: 'x', scienceBasis: 'y', reskinCheck: 'z' });
      return { A, tcode: t.code, pid: p.id };
    });
    await page.fill('#code', seedInfo.tcode);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=openPuzzle]');
    await page.setInputFiles('input[data-upload=hintimg][data-i="0"]', path.join(__dirname, 'fixture-hint.png'));
    await page.waitForFunction(() => { const i = document.querySelector('img.thumb[alt=提示圖片]'); return i && /^data:image/.test(i.src); });
    await shot(page, '10-editor-hint-image');
    await page.waitForFunction((a) => { const p = GAS('getPuzzle')(a.tcode, a.pid); return p.hints[0].imageId; }, seedInfo, { timeout: 15000 });

    const playCode = await page.evaluate((a) => {
      const room = GAS('adminCreateTeacherRoom')(a.A, '圖片提示密室');
      GAS('adminSetRoomPuzzles')(a.A, room.id, [a.pid]);
      GAS('saveRoom')(a.A, { id: room.id, rev: 1, cover: { text: '封面', imageId: '' }, story: [{ text: '說明', imageId: '' }],
        success: { text: '成功', imageId: '' }, fail: { text: '失敗', imageId: '' } });
      return GAS('adminRoomAction')(a.A, room.id, 'publish').playCode;
    }, seedInfo);
    await click(page, '[data-act=logout]');
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '一隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#hintBtn:not([disabled])');
    await click(page, '#hintBtn');
    await page.waitForFunction(() => { const i = document.querySelector('.phint img[data-hint-img]'); return i && /^data:image/.test(i.src) && i.naturalWidth > 0; });
    assert.match(await page.textContent('.phint'), /看藍色的圓/);
    await shot(page, '11-play-hint-image');
    // 答錯重畫面板時，圖片從快取補回來
    await page.fill('#ans', 'xxx');
    await click(page, '#goBtn');
    await page.waitForFunction(() => { const i = document.querySelector('.phint img[data-hint-img]'); return i && /^data:image/.test(i.src); });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('玩到一半頁面被手機回收：重開後接回同一場，不會跳回登入頁；斷線時不踢人', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 390, height: 800 });
    const A = await seed(page);
    const playCode = await page.evaluate((A) => {
      const room = GAS('allDocs_')('Rooms').filter((r) => r.kind === 'teacher')[0];
      const bank = GAS('allDocs_')('Puzzles');
      const ids = ['空氣塔', '潮汐塔', '冰山塔'].map((t) => bank.filter((p) => p.title === t)[0].id);
      GAS('adminSetRoomPuzzles')(A, room.id, ids, { fragments: ['7', '3', '1'] });
      GAS('adminRoomAction')(A, room.id, 'publish');
      return GAS('getDoc_')('Rooms', room.id).playCode;
    }, A);

    // 玩家用代碼進來、解開第一題
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '回收隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    await page.waitForSelector('[data-act=introNext]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#barIdx');
    await page.fill('#ans', 'air');
    await click(page, '#goBtn');
    await page.waitForFunction(() => /^已過 1 \/ 3 題$|第 2 \/ 3 題/.test(document.getElementById('barIdx').textContent));
    const before = await page.textContent('#barIdx');

    // 模擬手機把分頁回收：記憶體裡的狀態全沒了，只剩 localStorage，然後重新啟動
    await page.evaluate(() => { S.play = null; clearTimers(); document.getElementById('app').innerHTML = ''; boot(); });
    await page.waitForSelector('#barIdx');
    assert.equal(await page.textContent('#barIdx'), before, '接回同一場，進度還在');
    assert.equal(await page.locator('#code').count(), 0, '沒有跳回登入頁');

    // 重開時剛好沒網路：顯示重試畫面，不清掉進度；網路回來後按重試就接回
    await page.context().setOffline(true);
    await page.evaluate(() => {
      window.__realGAS = window.GAS;
      window.GAS = function () { throw new Error('Failed to fetch'); };
      S.play = null; clearTimers(); boot();
    });
    await page.waitForSelector('#retryBtn');
    assert.match(await page.textContent('#app'), /目前連不上網路/);
    assert.ok(await page.evaluate(() => !!localStorage.getItem('erPlay')), '斷線時不能把進行中的遊戲清掉');
    await page.evaluate(() => { window.GAS = window.__realGAS; });
    await page.context().setOffline(false); // 網路一恢復就會自動重試，不用按鈕
    await page.waitForSelector('#barIdx');
    assert.equal(await page.textContent('#barIdx'), before);

    // 一般登入也一樣：斷線不清掉登入代碼
    await page.evaluate(() => { S.play = null; store('erPlay', null); store('erCode', 'ABC123'); });
    await page.context().setOffline(true);
    await page.evaluate(() => { window.GAS = function () { throw new Error('Failed to fetch'); }; clearTimers(); boot(); });
    await page.waitForSelector('#retryBtn');
    assert.equal(await page.evaluate(() => localStorage.getItem('erCode')), 'ABC123', '斷線不清登入代碼');
    await page.evaluate(() => { window.GAS = window.__realGAS; });
    await page.context().setOffline(false);

    // 離開遊戲後不會再被接回
    await page.evaluate(() => { store('erCode', null); clearTimers(); boot(); });
    await page.waitForSelector('#code');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('關卡位置：挑題時填地點 → 發布 → 玩家看到本題地點、打開位置表；學生密室在審核時設定', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 1024, height: 900 });
    const admin = await seed(page);
    await page.evaluate((A) => {
      const room = GAS('allDocs_')('Rooms').filter((r) => r.kind === 'teacher')[0];
      const bank = GAS('allDocs_')('Puzzles');
      const ids = ['空氣塔', '潮汐塔', '冰山塔'].map((t) => bank.filter((p) => p.title === t)[0].id);
      GAS('adminSetRoomPuzzles')(A, room.id, ids, {});
      const doc = GAS('getDoc_')('Rooms', room.id); doc.mode = 'free'; GAS('putDoc_')('Rooms', doc);
      GAS('adminCreateGroups')(A, [{ name: '第一組', members: '甲' }]);
    }, admin);

    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=bank]');
    await click(page, '[data-act=assemble]');
    await page.waitForSelector('[data-asmplace]');
    assert.equal(await page.locator('[data-asmplace]').count(), 3);
    await page.locator('[data-asmplace]').nth(0).fill('圖書館門口');
    await page.locator('[data-asmplace]').nth(2).fill('居禮教室');
    await shot(page, 'p0-assemble-places');
    await click(page, '[data-act=asmSave]');
    await page.waitForSelector('[data-act=adminTab][data-tab=bank].on');

    // 學生密室：總覽卡片上有「關卡位置」
    await click(page, '[data-act=adminTab][data-tab=overview]');
    assert.equal(await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=placesEdit]').count(), 0, '示範密室在挑題與排序設定');
    await page.locator('.card', { hasText: '第一組' }).locator('[data-act=placesEdit]').click();
    await page.waitForSelector('[data-act=placesSave]');
    await click(page, '[data-act=placesSave]');
    await page.waitForSelector('[data-act=adminTab][data-tab=overview].on');

    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=roomAction][data-a=publish]').click();
    await click(page, '#cfOk');
    await page.waitForSelector('#modal .big');
    const playCode = (await page.textContent('#modal .big')).trim();
    await click(page, '#modal .x');

    // 玩家（手機寬度）
    await page.setViewportSize({ width: 390, height: 844 });
    await click(page, '[data-act=logout]');
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '位置隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    await page.waitForSelector('[data-act=introNext]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#barIdx');
    assert.equal(await page.textContent('.pplace'), '📍 圖書館門口');
    await shot(page, 'p1-play-chip');
    await page.fill('#ans', 'air');
    await click(page, '#goBtn');
    await page.waitForFunction(() => /已過 1 \/ 3 題/.test(document.getElementById('barIdx').textContent));
    // 解開後會自動換到下一題（潮汐塔）；不是的話自己點
    if (!/潮汐塔/.test(await page.textContent('.pcard h2'))) await click(page, '#board [data-act=openQ][data-i="1"]');
    await page.waitForFunction(() => /潮汐塔/.test(document.querySelector('.pcard h2').textContent));
    assert.equal(await page.locator('.pplace').count(), 0, '沒填地點的題目不顯示');
    await click(page, '[data-act=showPlaces]');
    await page.waitForSelector('.placetbl');
    const rows = await page.locator('.placetbl tbody tr').allTextContents();
    assert.match(rows[0], /空氣塔.*圖書館門口.*已解開/);
    assert.match(rows[1], /潮汐塔.*—.*正在這題/);
    assert.match(rows[2], /冰山塔.*居禮教室/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
    await shot(page, 'p1-play-places');
    await click(page, '#modal .x');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
