// GitHub Pages 版用的 API（doPost）：只開放畫面用得到的函式，錯誤以 JSON 回傳
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const post = (env, fn, args) => JSON.parse(env.gs.doPost({ postData: { contents: JSON.stringify({ fn, args }) } }).getContent());

test('doPost 可以登入、讀資料，結果和直接呼叫一樣', () => {
  const env = H.load();
  const r = post(env, 'login', [env.admin.toLowerCase()]);
  assert.equal(r.ok, true);
  assert.equal(r.result.role, 'admin');
  const t = post(env, 'adminCreateTeachers', [env.admin, ['林老師']]);
  assert.equal(t.result[0].name, '林老師');
  const ov = post(env, 'adminOverview', [env.admin]);
  assert.equal(ov.result.codes.length, 2);
});

test('doPost 擋掉管理用函式與內部函式，錯誤訊息照常回傳', () => {
  const env = H.load();
  for (const fn of ['setup', 'showAdminCode', 'adminCode_', 'readAll_', 'doGet', 'doPost', 'eval', 'constructor']) {
    const r = post(env, fn, []);
    assert.equal(r.ok, false, fn);
    assert.match(r.error, /不支援的操作/);
  }
  const bad = post(env, 'login', ['ZZZZZZ']);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /代碼不正確/);
  const junk = JSON.parse(env.gs.doPost({ postData: { contents: 'not json' } }).getContent());
  assert.equal(junk.ok, false);
});

test('畫面呼叫的每個函式都在 API 名單裡，名單裡的函式也都存在', () => {
  const env = H.load();
  const html = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
  const used = [...new Set([...html.matchAll(/api\('([A-Za-z]+)'/g)].map((m) => m[1]))];
  const list = env.gs.API_FUNCTIONS;
  for (const fn of used) assert.ok(list.includes(fn), fn + ' 沒有在 API_FUNCTIONS 裡');
  for (const fn of list) assert.equal(typeof env.gs[fn], 'function', fn + ' 不存在');
});

test('docs/index.html 和 Index.html 同步', () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
  const built = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
  assert.match(built, /window\.ER_API = "https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec"/);
  assert.equal(built.replace(/<!-- 這個檔案由[^\n]*\n<script>window\.ER_API[^\n]*\n/, ''), src, '請執行 node tools/build-pages.js');
});
