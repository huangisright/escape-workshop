// 介面：數據頁的自動警示、下載 AI 分析包、匯入結果（Playwright）：node --test tests/analysis-ui.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildHarness } = require('./harness');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } catch (e2) { chromium = null; }
}
const URL = 'http://harness.local/';
const SHOTS = process.env.SHOTS || '';

async function openPage(browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || { width: 1024, height: 900 }, acceptDownloads: true });
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
const click = (page, sel) => page.locator(sel).first().click();

test('數據頁：自動警示 → 下載分析包 → 貼上 AI 結果 → 顯示分析', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser);
    const admin = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      GAS('adminSaveSettings')(A, { wrongCooldownSec: 0 });
      const t = GAS('adminCreateTeachers')(A, ['林老師'])[0];
      const mk = (title, answer) => {
        const p = GAS('newPuzzle')(t.code);
        GAS('savePuzzle')(t.code, {
          id: p.id, rev: 0, title, kind: 'digital', estMinutes: 5,
          steps: [{ get: '地圖', act: '找年份', result: '年份', checkpoint: '' }, { get: '年份', act: '換密碼', result: '密碼', checkpoint: '' }],
          blocks: [{ type: 'text', text: title + '：看圖找出年份' }], answer, hints: [{ text: '看左上角', delaySec: 0 }],
          props: [], themeLink: '海平面上升', scienceBasis: 'IPCC AR6', reskinCheck: '拿掉主題就不成立'
        });
        return p.id;
      };
      const ids = [mk('潮汐塔', '2050年'), mk('冰山塔', 'ICE')];
      const room = GAS('adminCreateTeacherRoom')(A, '黃金城密室');
      GAS('adminSetRoomPuzzles')(A, room.id, ids);
      GAS('saveRoom')(A, { id: room.id, rev: GAS('getRoom')(A, room.id).rev, cover: { text: '黃金城', imageId: '' }, story: [{ text: '海水上漲了', imageId: '' }], success: { text: '逃出來了', imageId: '' }, fail: { text: '城沉了', imageId: '' } });
      const pub = GAS('adminRoomAction')(A, room.id, 'publish');
      for (let i = 1; i <= 3; i++) {
        const intro = GAS('playStart')(pub.playCode, '第' + i + '隊', ['甲']);
        GAS('playBegin')(intro.playId);
        GAS('playAnswer')(intro.playId, '2050');
        GAS('playAnswer')(intro.playId, '2050年');
        GAS('playAnswer')(intro.playId, 'ICE');
      }
      return A;
    });
    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=adminStats]').click();
    await page.waitForSelector('#anPack');
    let text = await page.textContent('.wrap');
    assert.match(text, /自動警示/);
    assert.match(text, /3 組答成「2050」，跟正確答案很接近/);
    assert.match(text, /2050×3（3 組）/);
    await shot(page, 'an-1-flags');

    const [dl] = await Promise.all([page.waitForEvent('download'), click(page, '#anPack')]);
    // 測試用的無頭 Chromium 會把中文檔名換成 download，真的瀏覽器會照 download 屬性命名
    assert.match(dl.suggestedFilename(), /^(分析包-.*\.json|download)$/);
    const pack = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    assert.equal(pack.puzzles.length, 2);
    assert.ok(!JSON.stringify(pack).includes('林老師'));

    // 假裝是 AI 的回覆：前面多一句話、用 ``` 包起來
    const reply = '以下是分析：\n```json\n' + JSON.stringify({
      format: 'escape-workshop-analysis-result', packId: pack.packId, model: '測試用 AI',
      room: { summary: '整體流暢，第 1 題的答案格式要講清楚。', strengths: ['主題一致'], priorities: [{ key: 'P1', reason: '三組都漏了「年」' }], flow: '難度平順', timeLimit: '時間充裕' },
      puzzles: [
        { key: 'P1', verdict: 'fix', problems: ['3 組玩到，3 組都先答成 2050'], causes: ['題目沒說答案要寫「年」'], suggestions: ['把答案改成 2050 也算對'], toDesigner: '〔設計者1〕：題目很有趣！把答案格式說清楚就更好了。' },
        { key: 'P2', verdict: 'good', problems: [], causes: [], suggestions: [], toDesigner: '〔設計者1〕：很順暢。' }
      ]
    }) + '\n```';
    await click(page, '#anImport');
    await page.fill('#anText', reply);
    await click(page, '#anGo');
    await page.waitForSelector('.an-p');
    text = await page.textContent('#anCard');
    assert.match(text, /測試用 AI 分析/);
    assert.match(text, /先修這幾題/);
    assert.match(text, /第 1 題「潮汐塔」：三組都漏了「年」/);
    assert.match(text, /優先修改/);
    assert.match(text, /林老師：題目很有趣/, '代號換回真名');
    assert.ok(!text.includes('〔設計者1〕'));
    // fix 排在 good 前面
    const heads = await page.locator('.an-p .an-head b').allTextContents();
    assert.deepEqual(heads, ['第 1 題「潮汐塔」', '第 2 題「冰山塔」']);
    await shot(page, 'an-2-result');

    // 重新整理後還在
    await page.evaluate(() => document.querySelector('[data-act=toAdmin]') && document.querySelector('[data-act=toAdmin]').click());
    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=adminStats]').click();
    await page.waitForSelector('.an-p');

    // 貼錯東西：錯誤訊息留在對話框裡
    await click(page, '#anImport');
    await page.fill('#anText', JSON.stringify(pack));
    await click(page, '#anGo');
    await page.waitForSelector('#anMsg p.pre');
    assert.match(await page.textContent('#anMsg'), /這是分析包本身/);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('數據頁在 iPad 直向寬度不會橫向捲動', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const { page, errors } = await openPage(browser, { width: 768, height: 1024 });
    const admin = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      const t = GAS('adminCreateTeachers')(A, ['林老師'])[0];
      const p = GAS('newPuzzle')(t.code);
      GAS('savePuzzle')(t.code, { id: p.id, rev: 0, title: '潮汐塔', kind: 'digital', estMinutes: 5, steps: [{ get: 'a', act: 'b', result: 'c', checkpoint: '' }],
        blocks: [{ type: 'text', text: '題目' }], answer: 'X', hints: [{ text: 'h', delaySec: 0 }], props: [], themeLink: 't', scienceBasis: 's', reskinCheck: 'r' });
      const room = GAS('adminCreateTeacherRoom')(A, '黃金城密室');
      GAS('adminSetRoomPuzzles')(A, room.id, [p.id]);
      return A;
    });
    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await page.locator('.card', { hasText: '示範：黃金城密室' }).locator('[data-act=adminStats]').click();
    await page.waitForSelector('#anPack');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 0, '橫向多出 ' + over + 'px');
    assert.match(await page.textContent('#anCard'), /還沒有正式遊玩的紀錄/);
    await shot(page, 'an-3-ipad');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
