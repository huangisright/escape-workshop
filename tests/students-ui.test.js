// 介面測試：學生用 Google 登入加入 → 還沒分組先出題 → 老師在「學生與分組」配組、換組長、換組 → 學生看到自己的組
// node --test tests/students-ui.test.js（截圖：SHOTS=資料夾）
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
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
const click = (page, sel) => page.locator(sel).first().click();

test('學生 Google 登入加入、先出題、老師彈性配組、題目跟著人走', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const html = buildHarness();
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (u.includes('qrcode')) return route.fulfill({ contentType: 'text/javascript', body: 'window.QRCode=function(el,o){el.textContent=o.text;};' });
      return route.abort();
    });
    // 假的 Google 登入：回傳 window.__gtok 指定的帳號（後端模擬環境認得 test:email|名字）
    await page.addInitScript(() => { window.ER_FAKE_GOOGLE = () => Promise.resolve({ idToken: 'test:' + window.__gtok }); });
    // 小美掃加入 QR（?j=加入碼）→ Google 登入 → 第一次填姓名
    // （模擬的資料庫活在這一頁裡，所以先開網址再建資料；加入碼直接指定）
    const jc = 'K7QM';
    await page.goto(URL + '?j=' + jc.toLowerCase());
    const admin = await page.evaluate((j) => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      PropertiesService.getScriptProperties().setProperty('JOIN_CODE', j);
      GAS('adminCreateGroups')(A, [{ name: '第一組' }, { name: '第二組' }]);
      window.__gtok = 'amy@gmail.com|Amy';
      return A;
    }, jc);
    await shot(page, 's1-login');
    await click(page, '[data-act=googleLogin]');
    await page.waitForSelector('#jName');
    assert.equal(await page.inputValue('#jCode'), jc, '加入碼從 QR 帶進來');
    await page.fill('#jName', '王小美');
    await page.fill('#jSchool', '金寧國中 801');
    await shot(page, 's2-join');
    await click(page, '[data-act=joinGo]');
    await page.waitForSelector('.me-card');
    assert.match(await page.textContent('.wrap'), /還沒分組/);
    const amyCode = (await page.textContent('.me-card .pc')).trim();
    assert.match(amyCode, /^S[A-Z2-9]{5}$/);

    // 先做自己的題目：設計者固定是自己
    await click(page, '[data-act=newPuzzle]');
    await page.waitForSelector('[data-f=title]');
    assert.equal(await page.locator('label.f', { hasText: '設計者' }).count(), 1);
    assert.equal(await page.locator('input[disabled][value="王小美"]').count(), 1);
    await page.fill('[data-f=title]', '燈塔密碼');
    await page.waitForFunction(() => /已自動儲存/.test(document.getElementById('saveStatus').textContent));
    await click(page, '[data-act=backPuzzle]');
    await page.waitForSelector('.item:has-text("燈塔密碼")');
    await shot(page, 's3-student-nogroup');

    // 大寶：同一台 iPad，小美登出後換人；加入碼記在這台裝置上
    await click(page, '[data-act=logout]');
    await page.evaluate(() => { window.__gtok = 'bob@gmail.com|Bob Lee'; });
    await click(page, '[data-act=googleLogin]');
    await page.waitForSelector('#jName');
    assert.equal(await page.inputValue('#jName'), '', '英文名字不預填，讓學生寫中文姓名');
    await page.fill('#jName', '李大寶');
    await click(page, '[data-act=joinGo]');
    await page.waitForSelector('.me-card');
    await click(page, '[data-act=newPuzzle]');
    await page.waitForSelector('[data-f=title]');
    await page.fill('[data-f=title]', '潮汐表');
    await page.waitForFunction(() => /已自動儲存/.test(document.getElementById('saveStatus').textContent));
    await click(page, '[data-act=backPuzzle]');
    await click(page, '[data-act=logout]');

    // 老師：學生與分組
    await page.fill('#code', admin);
    await click(page, '[data-act=login]');
    await click(page, '[data-act=adminTab][data-tab=students]');
    await page.waitForSelector('.board');
    assert.match(await page.textContent('.joinbox'), new RegExp(jc));
    assert.equal(await page.locator('.col.none .st').count(), 2);
    await page.locator('.col.none .st', { hasText: '王小美' }).locator('select').selectOption({ label: '第一組' });
    await page.waitForSelector('.col:has(h4:has-text("第一組")) .st:has-text("王小美")');
    await page.locator('.col.none .st', { hasText: '李大寶' }).locator('select').selectOption({ label: '第一組' });
    await page.waitForSelector('.col:has(h4:has-text("第一組")) .st:has-text("李大寶")');
    const g1 = page.locator('.col', { has: page.locator('h4', { hasText: '第一組' }) });
    assert.match(await g1.locator('h4').textContent(), /2 人・2 題/);
    assert.equal(await g1.locator('.st', { hasText: '王小美' }).locator('.star.on').count(), 1, '第一個分進來的自動當組長');
    // 換組長
    await g1.locator('.st', { hasText: '李大寶' }).locator('.star').click();
    await page.waitForSelector('.col:has(h4:has-text("第一組")) .st:has-text("李大寶") .star.on');
    await shot(page, 's4-admin-board');

    // 第二天：小美換到第二組，題目跟著走
    await page.locator('.col', { has: page.locator('h4', { hasText: '第一組' }) }).locator('.st', { hasText: '王小美' }).locator('select').selectOption({ label: '第二組' });
    await page.waitForSelector('.col:has(h4:has-text("第二組")) .st:has-text("王小美")');
    assert.match(await page.locator('.col', { has: page.locator('h4', { hasText: '第二組' }) }).locator('h4').textContent(), /1 人・1 題/);
    assert.match(await page.locator('.col', { has: page.locator('h4', { hasText: '第一組' }) }).locator('h4').textContent(), /1 人・1 題/);
    // 總覽卡片上看得到組員與組長
    await click(page, '[data-act=adminTab][data-tab=overview]');
    assert.match(await page.textContent('#adminBody'), /組員：李大寶 · 組長 李大寶/);
    await click(page, '[data-act=logout]');

    // 小美再登入（不用再填資料）：在第二組、是組長、題目在
    await page.evaluate(() => { window.__gtok = 'amy@gmail.com|Amy'; });
    await click(page, '[data-act=googleLogin]');
    await page.waitForSelector('.me-card');
    assert.match(await page.textContent('.top .brand'), /第二組/);
    assert.match(await page.textContent('.me-card'), /組長/);
    assert.equal(await page.locator('.item', { hasText: '燈塔密碼' }).locator('.chip.mine').count(), 1);
    assert.equal(await page.locator('[data-act=submitRoom]').count(), 1, '組長看得到送審');
    await shot(page, 's5-student-leader');
    await click(page, '[data-act=editRoom]');
    await page.waitForSelector('[data-f=title]');
    assert.equal(await page.isDisabled('[data-f=title]'), false, '組長可以改密室資訊');
    await click(page, '[data-act=backRoom]');
    await click(page, '[data-act=logout]');

    // 大寶用個人代碼登入（備援）：第一組的組員是組長；只有自己一人
    const bobCode = await page.evaluate(() => GAS('adminOverview')(GAS('adminCode_')()).students.filter((s) => s.name === '李大寶')[0].code);
    await page.fill('#code', bobCode);
    await click(page, '[data-act=login]');
    await page.waitForSelector('.me-card');
    assert.match(await page.textContent('.top .brand'), /第一組/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('組員：別人的題目唯讀、密室資訊唯讀、看不到送審', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 820, height: 1100 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const html = buildHarness();
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      return route.abort();
    });
    await page.goto(URL);
    const codes = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      const [x, y] = GAS('adminCreateStudents')(A, [{ name: '組長甲' }, { name: '組員乙' }]);
      GAS('adminCreateGroups')(A, [{ name: '藍隊' }]);
      const room = GAS('adminOverview')(A).rooms[0];
      GAS('adminAssignStudent')(A, x.code, room.id);
      GAS('adminAssignStudent')(A, y.code, room.id);
      const p = GAS('newPuzzle')(x.code);
      GAS('savePuzzle')(x.code, { id: p.id, rev: 0, title: '甲的題目' });
      return { lead: x.code, mem: y.code };
    });
    await page.fill('#code', codes.mem);
    await click(page, '[data-act=login]');
    await page.waitForSelector('.me-card');
    assert.match(await page.textContent('.me-card'), /組員/);
    assert.equal(await page.locator('[data-act=submitRoom]').count(), 0);
    assert.equal(await page.locator('[data-act=movePuzzle]').count(), 0);
    assert.match(await page.textContent('.wrap'), /由組長按「送審」/);
    await shot(page, 's6-member');
    await click(page, '.item:has-text("甲的題目")');
    await page.waitForSelector('[data-f=title]');
    assert.equal(await page.isDisabled('[data-f=title]'), true);
    assert.match(await page.textContent('.top .brand'), /唯讀/);
    await click(page, '[data-act=backPuzzle]');
    await click(page, '[data-act=editRoom]');
    await page.waitForSelector('[data-f=title]');
    assert.equal(await page.isDisabled('[data-f=title]'), true, '組員的密室資訊是唯讀');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('老師用 Google 登入：第一次輸入老師代碼綁定，之後按一下就進來；管理頁看得到綁定的帳號', { skip: !chromium && '沒有 Playwright' }, async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const html = buildHarness();
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(URL)) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      if (u.includes('qrcode')) return route.fulfill({ contentType: 'text/javascript', body: 'window.QRCode=function(el,o){el.textContent=o.text;};' });
      return route.abort();
    });
    await page.addInitScript(() => { window.ER_FAKE_GOOGLE = () => Promise.resolve({ idToken: 'test:' + window.__gtok }); });
    await page.goto(URL);
    const { A, T } = await page.evaluate(() => {
      GAS('setup')();
      const A = GAS('adminCode_')();
      const T = GAS('adminCreateTeachers')(A, ['陳老師'])[0].code;
      window.__gtok = 'chen@school.edu.tw|Chen';
      return { A, T };
    });
    await click(page, '[data-act=googleLoginStaff]');
    await page.waitForSelector('#jStaff');
    assert.equal(await page.locator('#jName').count(), 0, '老師不會看到學生的加入表單');
    assert.equal(await page.getAttribute('#jStaff', 'type'), 'password', '代碼輸入時遮住');
    await page.fill('#jStaff', 'TNOPE1');
    await click(page, '[data-act=staffBind]');
    await page.waitForSelector('text=老師代碼不正確');
    await page.fill('#jStaff', T);
    await click(page, '[data-act=staffBind]');
    await page.waitForFunction(() => /陳老師/.test(document.body.innerText) && !document.getElementById('jStaff'));
    await shot(page, 't1-teacher-home');
    await click(page, '[data-act=logout]');

    // 第二次：按一下就進來
    await click(page, '[data-act=googleLoginStaff]');
    await page.waitForFunction(() => /陳老師/.test(document.body.innerText) && !document.getElementById('jStaff') && !document.getElementById('tcode'));
    await click(page, '[data-act=logout]');

    // 管理者綁自己的 Google，進管理頁看老師綁定的帳號
    await page.evaluate(() => { window.__gtok = 'isright@gmail.com|IsRight'; });
    await click(page, '[data-act=googleLoginStaff]');
    await page.waitForSelector('#jStaff');
    await page.fill('#jStaff', A);
    await click(page, '[data-act=staffBind]');
    await page.waitForSelector('#adminBody');
    await click(page, '[data-act=adminTab][data-tab=codes]');
    await page.waitForSelector('[data-act=unbindStaff]');
    const body = await page.textContent('#adminBody');
    assert.match(body, /chen@school\.edu\.tw/);
    assert.match(body, /管理者的 Google 帳號：isright@gmail\.com/);
    await shot(page, 't2-admin-codes');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
