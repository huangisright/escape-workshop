// 管理頁「完成度一覽」：node --test tests/progress.test.js（介面截圖：SHOTS=資料夾）
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const H = require('./helpers');
const { buildHarness } = require('./harness');

const tok = (email) => ({ idToken: 'test:' + email + '|' });
function joinStudent(env, email, name) {
  const jc = env.plain(env.gs.adminJoinCode(env.admin, 'peek')) || env.plain(env.gs.adminJoinCode(env.admin, 'new'));
  return env.plain(env.gs.studentJoin(tok(email), { name, school: '金城國中 701', joinCode: jc })).me;
}
const overview = (env) => env.plain(env.gs.adminOverview(env.admin));
const groupOf = (env, name) => overview(env).rooms.filter((r) => r.groupName === name)[0];

function setup(env) {
  env.gs.adminCreateGroups(env.admin, [{ name: '第一組' }, { name: '第二組' }]);
  const g1 = groupOf(env, '第一組');
  const amy = joinStudent(env, 'amy@gmail.com', '王小美');
  const bob = joinStudent(env, 'bob@gmail.com', '李大寶');
  const cat = joinStudent(env, 'cat@gmail.com', '陳小花');
  [amy, bob].forEach((s) => env.gs.adminAssignStudent(env.admin, s.code, g1.id));
  return { g1, amy, bob, cat };
}

test('完成度：還沒出題的人以 0 分計、密室資訊占 20%', () => {
  const env = H.load();
  const { amy } = setup(env);
  let g = groupOf(env, '第一組').progress;
  assert.equal(g.pct, 3, '只有密室名稱（1/6 × 20% ≈ 3）');
  assert.equal(g.expected, 2);
  assert.deepEqual(g.lacking.sort(), ['李大寶', '王小美'].sort());
  assert.deepEqual(g.info.map((x) => x.label), ['名稱', '封面', '說明頁', '成功頁', '失敗頁', '心智圖']);

  // 小美出一題、全部填好：題目 1/2 → 40%
  const p = env.plain(env.gs.newPuzzle(amy.code));
  const saved = H.savePuzzle(env, amy.code, p, H.fullPuzzle({ title: '燈塔密碼', author: '王小美' }));
  g = groupOf(env, '第一組').progress;
  assert.equal(g.puzzles.length, 1);
  assert.equal(g.puzzles[0].pct, 100);
  assert.deepEqual(g.puzzles[0].missing, []);
  assert.equal(g.puzzles[0].err, 0);
  assert.equal(g.ready, 1);
  assert.deepEqual(g.lacking, ['李大寶']);
  assert.equal(g.pct, Math.round(20 / 6 + 40));

  // 拿掉答案和提示：缺的項目列出來、和紅燈一致
  H.savePuzzle(env, amy.code, saved, H.fullPuzzle({ title: '燈塔密碼', author: '王小美', answer: '', hints: [] }));
  g = groupOf(env, '第一組').progress;
  assert.deepEqual(g.puzzles[0].missing, ['答案', '提示']);
  assert.ok(g.puzzles[0].err > 0);
  assert.equal(g.puzzles[0].pct, Math.round(7 / 9 * 100));
  assert.equal(g.ready, 0);
});

test('完成度：缺項與紅燈一致（各種沒填好的題目）', () => {
  const env = H.load();
  const { amy } = setup(env);
  const variants = [
    {}, { title: '' }, { kind: '' }, { steps: [{ get: 'a', act: '', result: 'c' }] }, { blocks: [] },
    { blocks: [{ type: 'image' }] }, { blocks: [{ type: 'link', url: 'abc' }] },
    { blocks: [{ type: 'text', text: 'x', after: 1 }] }, { answer: '' }, { hints: [{ text: ' ' }] },
    { estMinutes: 0 }, { themeLink: '' }, { author: '' }, { estMinutes: 99, answer: 'ANSWER', hints: [{ text: 'ANSWER' }] }
  ];
  let p = env.plain(env.gs.newPuzzle(amy.code));
  variants.forEach((v, i) => {
    p = H.savePuzzle(env, amy.code, p, H.fullPuzzle(Object.assign({ author: '王小美' }, v)));
    const q = groupOf(env, '第一組').progress.puzzles[0];
    assert.equal(q.missing.length === 0, q.err === 0, '第 ' + i + ' 種：' + JSON.stringify(v) + ' 缺 ' + q.missing.join('、') + '，紅燈 ' + q.err);
  });
  // 空白新題目分數很低
  const blank = env.plain(env.gs.newPuzzle(amy.code));
  const q = groupOf(env, '第一組').progress.puzzles.filter((x) => x.id === blank.id)[0];
  assert.ok(q.pct < 50, '空白題 ' + q.pct + '%');
  assert.ok(q.err > 0);
});

test('完成度：密室資訊做完、每人一題都完成就是 100%', () => {
  const env = H.load();
  const { g1, amy, bob } = setup(env);
  [[amy, '王小美'], [bob, '李大寶']].forEach(([s, n]) => {
    const p = env.plain(env.gs.newPuzzle(s.code));
    H.savePuzzle(env, s.code, p, H.fullPuzzle({ author: n }));
  });
  const room = env.plain(env.gs.getWorkspace(amy.code)).room;
  env.gs.adminSetLeader(env.admin, g1.id, amy.code);
  env.gs.saveRoom(amy.code, Object.assign({}, room, {
    cover: { text: '封面' }, story: [{ text: '故事' }], success: { text: '成功' }, fail: { text: '失敗' },
    mindmap: { url: 'https://example.com/m.png' }
  }));
  const r = groupOf(env, '第一組');
  assert.equal(r.progress.pct, 100);
  assert.equal(r.summary.err, 0, '和送審檢核一致：沒有紅燈');
});

test('完成度：一人多出的題目不會補到還沒出題的組員', () => {
  const env = H.load();
  const { amy } = setup(env);
  for (let i = 0; i < 2; i++) {
    const p = env.plain(env.gs.newPuzzle(amy.code));
    H.savePuzzle(env, amy.code, p, H.fullPuzzle({ author: '王小美' }));
  }
  const g = groupOf(env, '第一組').progress;
  assert.deepEqual(g.lacking, ['李大寶']);
  assert.equal(g.pct, Math.round(20 / 6 + 2 / 3 * 80), '3 格（小美 2 題＋大寶 1 格）完成 2 格');
});

// ---------- 介面 ----------
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } catch (e2) { chromium = null; }
}
const URL = 'http://harness.local/';
const SHOTS = process.env.SHOTS || '';

for (const vp of [{ width: 1280, height: 900, n: 'desktop' }, { width: 390, height: 844, n: 'phone' }]) {
  test('介面：總覽上方的完成度一覽（' + vp.n + '）', { skip: !chromium && '沒有 Playwright' }, async () => {
    const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
    try {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
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
      const A = await page.evaluate(() => {
        GAS('setup')();
        const A = GAS('adminCode_')();
        PropertiesService.getScriptProperties().setProperty('JOIN_CODE', 'K7QM');
        GAS('adminCreateGroups')(A, [{ name: '海平面小隊' }, { name: '冰河探險隊' }, { name: '碳足跡偵探' }]);
        const rooms = GAS('adminOverview')(A).rooms;
        const names = [['王小美', '李大寶', '陳小花'], ['林志明', '黃美玲'], ['張家豪', '吳佩珊', '蔡宜君']];
        const full = (o) => Object.assign({
          title: '題目', kind: 'digital', estMinutes: 5, steps: [{ get: '地圖', act: '找年份', result: '年份' }],
          blocks: [{ type: 'text', text: '看圖' }], answer: 'X', hints: [{ text: '看左上角' }], themeLink: '海平面'
        }, o);
        names.forEach((ns, gi) => ns.forEach((n, i) => {
          const me = GAS('studentJoin')({ idToken: 'test:s' + gi + i + '@gmail.com|' }, { name: n, school: '金城國中', joinCode: 'K7QM' }).me;
          GAS('adminAssignStudent')(A, me.code, rooms[gi].id);
          const k = gi * 3 + i;
          if (k === 2 || k === 7) return; // 還沒出題
          const p = GAS('newPuzzle')(me.code);
          const o = [{}, { answer: '', hints: [] }, {}, { estMinutes: 30 }, { title: '', steps: [], blocks: [] }, {}, { themeLink: '' }, {}, {}][k];
          GAS('savePuzzle')(me.code, Object.assign({ id: p.id, rev: p.rev }, full(Object.assign({ title: n + '的題目', author: n }, o))));
          if (k === 0 || k === 5) {
            const p2 = GAS('newPuzzle')(me.code);
            GAS('savePuzzle')(me.code, Object.assign({ id: p2.id, rev: p2.rev }, full({ title: '第二題', author: n, hints: [] })));
          }
        }));
        return A;
      });
      await page.fill('#codeIn', A).catch(() => {});
      await page.evaluate((a) => { S.code = a; S.me = { role: 'admin', name: '管理者' }; return showAdmin('overview'); }, A);
      await page.waitForSelector('#progressBoard');
      const tiles = page.locator('#progressBoard .pb');
      assert.equal(await tiles.count(), 3);
      const t1 = await tiles.nth(0).textContent();
      assert.match(t1, /海平面小隊/);
      assert.match(t1, /陳小花還沒出題/);
      assert.match(await page.textContent('#progressBoard'), /還沒出題 2 人/);
      assert.equal(await page.locator('#progressBoard .pb .pb-q b').count(), 7, '8 人、2 人沒出題、1 人出兩題');
      // 題目方塊的說明列出缺什麼
      assert.equal(await page.locator('#progressBoard .pb-q b[title*="缺：答案、提示"]').count(), 1);
      // 沒有水平捲軸
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(overflow, false, '畫面不應該左右捲動');
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'progress-' + vp.n + '.png'), fullPage: false });
      // 點一組進到檢視
      await tiles.nth(1).click();
      await page.waitForSelector('text=檢視密室');
      // 自動更新：回到總覽後，資料變了會更新
      await page.evaluate(() => showAdmin('overview'));
      await page.waitForSelector('#progressBoard');
      await page.evaluate(() => {
        GAS('adminCreateGroups')(S.code, [{ name: '新的一組' }]);
        return refreshOverviewQuiet();
      });
      await page.waitForFunction(() => document.querySelectorAll('#progressBoard .pb').length === 4);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
