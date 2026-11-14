// 介面：答對中途答案才出現的區塊、道具列印檔（Playwright）：node --test tests/reveal-print-ui.test.js
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

test('第二張圖答對第 1 步才出現；道具上傳 PDF 列印檔 → 材料清單下載', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  // 中文檔名用 buffer 給，Playwright 用中文路徑時不會觸發 change
  const pdfFile = { name: '藏寶圖.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') };
  try {
    const { page, errors } = await openPage(browser);
    const png = fs.readFileSync(path.join(__dirname, 'fixture-hint.png')).toString('base64');
    const seed = await page.evaluate((png) => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      GAS('adminSaveSettings')(A, { wrongCooldownSec: 1 });
      const t = GAS('adminCreateTeachers')(A, ['陳老師'])[0];
      const p = GAS('newPuzzle')(t.code);
      const img = GAS('uploadFile')(t.code, { puzzleId: p.id, label: '圖片', name: 'second.png', mime: 'image/png' }, png, false);
      GAS('savePuzzle')(t.code, { id: p.id, rev: 0, title: '雙圖題', kind: 'physical', estMinutes: 5,
        steps: [{ get: '第一張圖', act: '找年份', result: '年份', checkpoint: '2050' }, { get: '第二張圖', act: '換字', result: '密碼', checkpoint: '' }],
        blocks: [{ type: 'text', text: '先看第一張圖' }, { type: 'image', fileId: img.fileId, caption: '這是第二張圖', after: 1 }],
        answer: 'SEA', hints: [{ text: '看藍色', delaySec: 0 }], props: [{ item: '藏寶圖', place: '講桌' }],
        themeLink: 'x', scienceBasis: 'y', reskinCheck: 'z' });
      return { A, tcode: t.code, pid: p.id };
    }, png);

    // 老師編輯：出現時機選單、上傳列印檔
    await page.fill('#code', seed.tcode);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=openPuzzle]');
    assert.equal(await page.inputValue('select[data-f="blocks.1.after"]'), '1');
    assert.equal(await page.inputValue('select[data-f="blocks.0.after"]'), '0');
    await page.setInputFiles('input[data-upload=propfile][data-i="0"]', pdfFile);
    await page.waitForSelector('.propfile .pdfbadge');
    assert.match(await page.textContent('.propfile'), /藏寶圖\.pdf/);
    await shot(page, 'rp-1-editor');
    await page.waitForFunction((a) => { const p = GAS('getPuzzle')(a.tcode, a.pid); return p.props[0].fileId && p.props[0].fileMime === 'application/pdf'; }, seed, { timeout: 15000 });
    // 在玩家預覽裡也一樣
    await click(page, '[data-act=previewPuzzle]');
    await page.waitForSelector('#pvBlocks');
    assert.equal(await page.locator('#pvBlocks .pblk').isHidden(), true);
    await page.fill('#pvIn', '2050');
    await click(page, '#pvGo');
    await page.waitForFunction(() => !document.querySelector('#pvBlocks .pblk').hidden);
    assert.match(await page.textContent('#pvMsg'), /新的線索出現了/);
    await click(page, '#modal .x');

    const playCode = await page.evaluate((a) => {
      const room = GAS('adminCreateTeacherRoom')(a.A, '雙圖密室');
      GAS('adminSetRoomPuzzles')(a.A, room.id, [a.pid]);
      GAS('saveRoom')(a.A, { id: room.id, rev: 1, cover: { text: '封面', imageId: '' }, story: [{ text: '說明', imageId: '' }],
        success: { text: '成功', imageId: '' }, fail: { text: '失敗', imageId: '' } });
      return GAS('adminRoomAction')(a.A, room.id, 'publish').playCode;
    }, seed);

    // 玩家：第二張圖一開始看不到，答對 2050 才出現
    await click(page, '[data-act=logout]');
    await page.fill('#pcode', playCode);
    await click(page, '[data-act=toPlay]');
    await page.fill('#team', '一隊');
    await page.fill('#mem input', '小明');
    await click(page, '[data-act=playStart]');
    while (await page.locator('[data-act=introNext]').count()) await click(page, '[data-act=introNext]');
    await page.waitForSelector('#blocks');
    assert.match(await page.textContent('#blocks'), /先看第一張圖/);
    assert.equal(await page.locator('#blocks .pblk').isHidden(), true, '第二張圖還看不到');
    await page.fill('#ans', '1999');
    await click(page, '#goBtn');
    await page.waitForFunction(() => /答案不對/.test(document.getElementById('pmsg').textContent));
    assert.equal(await page.locator('#blocks .pblk').isHidden(), true);
    await page.waitForFunction(() => !document.getElementById('goBtn').disabled, null, { timeout: 5000 });
    await page.fill('#ans', '2050');
    await click(page, '#goBtn');
    await page.waitForFunction(() => { const d = document.querySelector('#blocks .pblk'); return d && !d.hidden; });
    assert.match(await page.textContent('#pmsg'), /新的線索出現了/);
    assert.match(await page.textContent('#blocks .pblk'), /這是第二張圖/);
    const ok = await page.evaluate(() => { const i = document.querySelector('#blocks .pblk img'); return i && /^data:image/.test(i.src); });
    assert.ok(ok);
    await shot(page, 'rp-2-play-revealed');
    await page.fill('#ans', 'sea');
    await click(page, '#goBtn');
    await page.waitForSelector('[data-act=sendRate]', { timeout: 15000 });
    await page.locator('[data-act=star][data-v="3"]').first().click();
    await click(page, '[data-act=sendRate]');
    await page.waitForSelector('text=謝謝你的回饋');

    // 管理者：材料清單看到列印檔，可以下載
    await click(page, '[data-act=toLogin]');
    await page.waitForSelector('#code');
    await page.fill('#code', seed.A);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=materials]');
    await page.waitForSelector('[data-act=downloadPrints][data-id=_all]');
    assert.match(await page.textContent('[data-act=downloadPrints][data-id=_all]'), /1 個/);
    assert.match(await page.textContent('.wrap'), /藏寶圖\.pdf/);
    await shot(page, 'rp-3-materials');
    // 記下下載連結的檔名（這個測試環境的 Chromium 遇到中文檔名會改叫 download，真的瀏覽器不會）
    await page.evaluate(() => { const c = HTMLAnchorElement.prototype.click; window.__dl = []; HTMLAnchorElement.prototype.click = function () { window.__dl.push(this.download); return c.call(this); }; });
    const [dl] = await Promise.all([page.waitForEvent('download'), click(page, '[data-act=downloadPrints][data-id=_all]')]);
    assert.deepEqual(await page.evaluate(() => window.__dl), ['雙圖密室-第1題-藏寶圖.pdf']);
    const body = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(body, /^%PDF/, '下載的是原檔');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
