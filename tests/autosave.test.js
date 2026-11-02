// 自動儲存：伺服器很慢、使用者一直打字時，不能同時送出同一個版本（會被當成「別人改過」）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSaver() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'Index.html'), 'utf8');
  const start = html.indexOf('function makeSaver(');
  const end = html.indexOf('function leaveEditor(');
  const ctx = vm.createContext({ setTimeout, clearTimeout, Promise, JSON, toasts: [] });
  vm.runInContext(`
    function setSaveStatus() {}
    function toast(m) { toasts.push(m); }
    function fail(e) { toasts.push(e.message); }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    ${html.slice(start, end)}`, ctx);
  return ctx;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('伺服器每次要 300ms、使用者持續打字：不會出現版本衝突，最後內容完整存到', async () => {
  const ctx = loadSaver();
  const server = { rev: 0, text: '', inFlight: 0, maxInFlight: 0, conflicts: 0 };
  const doc = { rev: 0, text: '' };
  const send = (d) => {
    server.inFlight++; server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
    return sleep(300).then(() => {
      server.inFlight--;
      if (d.rev !== server.rev) { server.conflicts++; return { conflict: true }; }
      server.rev++; server.text = d.text;
      return { rev: server.rev };
    });
  };
  const saver = ctx.makeSaver(() => doc, send, (r) => { if (!r.conflict) doc.rev = r.rev; });
  const text = '解出提示卡的意義、找出四字音文、字';
  for (const ch of text) {
    doc.text += ch;
    saver.touch();
    // 打字之間偶爾離開欄位（觸發立即儲存），製造多個等待中的儲存
    if (Math.random() < 0.3) saver.flush();
    await sleep(120);
  }
  await saver.flush();
  await sleep(1500);
  await saver.flush();
  assert.equal(server.conflicts, 0, '出現版本衝突');
  assert.equal(server.maxInFlight, 1, '同時送出了不只一筆');
  assert.equal(server.text, text);
  assert.equal(saver.pending(), false);
});
