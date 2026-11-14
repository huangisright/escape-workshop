// 介面：手寫道具拍照上傳（HEIC 轉檔、大張照片縮成 A4 300 dpi）、製作說明（Playwright）：node --test tests/print-photo-ui.test.js
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
const FIXTURE_PNG = fs.readFileSync(path.join(__dirname, 'fixture-hint.png'));

async function openPage(browser, heicCalls) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const html = buildHarness();
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (u.includes('qrcode')) return route.fulfill({ contentType: 'text/javascript', body: 'window.QRCode=function(el,o){el.textContent=o.text;};' });
    // 假的 heic2any：記下被呼叫，回傳一張 PNG
    if (u.includes('heic2any')) {
      heicCalls.n++;
      return route.fulfill({ contentType: 'text/javascript', body:
        'window.heic2any=function(o){window.__heicOpts=o;var b=atob("' + FIXTURE_PNG.toString('base64') + '"),a=new Uint8Array(b.length);' +
        'for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return Promise.resolve(new Blob([a],{type:"image/png"}));};' });
    }
    return route.abort();
  });
  await page.goto(URL);
  return { page, errors };
}
const click = (page, sel) => page.locator(sel).first().click();
const lastProp = (page, a, i) => page.evaluate((x) => GAS('getPuzzle')(x.code, x.pid).props[x.i], Object.assign({ i }, a));

test('手寫道具：HEIC 自動轉 JPG、大張照片縮到 A4 300 dpi、小 PNG 用原檔、製作說明進材料清單', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const heicCalls = { n: 0 };
  try {
    const { page, errors } = await openPage(browser, heicCalls);
    const seed = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      const t = GAS('adminCreateTeachers')(A, ['陳老師'])[0];
      const p = GAS('newPuzzle')(t.code);
      GAS('savePuzzle')(t.code, { id: p.id, rev: 0, title: '日記題', kind: 'physical', estMinutes: 5,
        steps: [{ get: '日記', act: '讀', result: '密碼', checkpoint: '' }], blocks: [{ type: 'text', text: '看日記' }],
        answer: 'SEA', hints: [{ text: '看藍色', delaySec: 0 }],
        props: [{ item: '手寫日記', place: '書架' }, { item: '手繪地圖', place: '講桌' }, { item: '小貼紙', place: '門口' }],
        themeLink: 'x', scienceBasis: 'y', reskinCheck: 'z' });
      const room = GAS('adminCreateTeacherRoom')(A, '日記密室');
      GAS('adminSetRoomPuzzles')(A, room.id, [p.id]);
      return { A, code: t.code, pid: p.id };
    });
    // 一張 4200×2800 的「手機照片」（PNG，長邊超過 A4 300 dpi）
    const bigPng = Buffer.from(await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 4200; c.height = 2800;
      const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 4200, 2800);
      gr.addColorStop(0, '#fde'); gr.addColorStop(1, '#adf'); g.fillStyle = gr; g.fillRect(0, 0, 4200, 2800);
      g.fillStyle = '#000'; g.font = '200px sans-serif'; g.fillText('手寫日記', 300, 1400);
      const u = c.toDataURL('image/png'); return u.substring(u.indexOf(',') + 1);
    }), 'base64');

    await page.fill('#code', seed.code);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=openPuzzle]');
    assert.match(await page.getAttribute('input[data-upload=propfile][data-i="0"]', 'accept'), /\.heic/);

    // 1. iPhone 的 HEIC：Chromium 讀不懂 → 載入轉檔程式 → 存成 JPG
    await page.setInputFiles('input[data-upload=propfile][data-i="0"]', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: Buffer.from('not really heic') });
    await page.waitForFunction((a) => { const x = GAS('getPuzzle')(a.code, a.pid).props[0]; return x && x.fileId; }, seed, { timeout: 15000 });
    let x = await lastProp(page, seed, 0);
    assert.equal(heicCalls.n, 1, '只有 HEIC 才載入轉檔程式');
    assert.equal(x.fileMime, 'image/jpeg');
    assert.equal(x.fileName, 'IMG_0001.jpg');
    let f = await page.evaluate((id) => GAS('getFileData')(GAS('adminCode_')(), id), x.fileId);
    assert.match(f.dataUrl, /^data:image\/jpeg;base64,/);
    await page.waitForSelector('.propfile .thumb');

    // 2. 大張照片：縮到長邊 3508（A4 300 dpi），轉 JPG
    await page.setInputFiles('input[data-upload=propfile][data-i="1"]', { name: '地圖.png', mimeType: 'image/png', buffer: bigPng });
    await page.waitForFunction((a) => { const x = GAS('getPuzzle')(a.code, a.pid).props[1]; return x && x.fileId; }, seed, { timeout: 20000 });
    x = await lastProp(page, seed, 1);
    assert.equal(x.fileMime, 'image/jpeg');
    assert.equal(x.fileName, '地圖.jpg');
    f = await page.evaluate((id) => GAS('getFileData')(GAS('adminCode_')(), id), x.fileId);
    const dim = await page.evaluate((u) => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = u; }), f.dataUrl);
    assert.deepEqual(dim, [3508, 2339]);

    // 3. 小 PNG：原檔上傳，不重新壓縮
    await page.setInputFiles('input[data-upload=propfile][data-i="2"]', { name: 'sticker.png', mimeType: 'image/png', buffer: FIXTURE_PNG });
    await page.waitForFunction((a) => { const x = GAS('getPuzzle')(a.code, a.pid).props[2]; return x && x.fileId; }, seed, { timeout: 15000 });
    x = await lastProp(page, seed, 2);
    assert.equal(x.fileMime, 'image/png');
    assert.equal(x.fileName, 'sticker.png');
    f = await page.evaluate((id) => GAS('getFileData')(GAS('adminCode_')(), id), x.fileId);
    assert.equal(f.dataUrl, 'data:image/png;base64,' + FIXTURE_PNG.toString('base64'), '原檔');

    // 4. 不是圖片也不是 PDF：擋下
    await page.setInputFiles('input[data-upload=propfile][data-i="2"]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await page.waitForFunction(() => /圖片.*PDF/.test(document.body.textContent));

    // 5. 製作說明
    await page.fill('textarea[data-f="props.0.note"]', '對摺兩次，密碼寫在背面');
    await page.waitForFunction((a) => GAS('getPuzzle')(a.code, a.pid).props[0].note === '對摺兩次，密碼寫在背面', seed, { timeout: 15000 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pp-1-editor.png'), fullPage: true });

    // 管理者：材料清單看得到製作說明與轉好的檔名
    await click(page, '[data-act=logout]');
    await page.fill('#code', seed.A);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=materials]');
    await page.waitForSelector('.propnote');
    assert.match(await page.textContent('.propnote'), /對摺兩次，密碼寫在背面/);
    const wrap = await page.textContent('.wrap');
    assert.match(wrap, /IMG_0001\.jpg/);
    assert.match(wrap, /地圖\.jpg/);
    assert.match(await page.textContent('[data-act=downloadPrints][data-id=_all]'), /3 個/);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'pp-2-materials.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
