// 介面測試（Playwright + Chromium）：node --test platform/tests/ui.test.js
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
    const A = GAS('showAdminCode')();
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
      id: room.id, rev: 0, timeLimitMin: 90,
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
      const A = GAS('showAdminCode')();
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
