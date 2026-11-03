// tests/bench.js — 量每個動作會碰試算表幾次、讀進多少資料（不是測試，是量速度用）
// 執行：node tests/bench.js
// Apps Script 每碰一次試算表大約 0.1～0.5 秒，讀的資料越多越慢，所以這兩個數字越小，點擊就越快。
const H = require('./helpers');

function setupClass() {
  const env = H.load();
  const long = '這是一段很長的題目說明。'.repeat(300); // 約 3,600 字，接近學生實際的長題目
  const groups = env.plain(env.gs.adminCreateGroups(env.admin, [1, 2, 3, 4, 5, 6].map((i) => ({ name: '第' + i + '組', members: ['甲' + i, '乙' + i, '丙' + i, '丁' + i] }))));
  groups.forEach((g, gi) => {
    for (let k = 0; k < 8; k++) {
      const p = env.plain(env.gs.newPuzzle(g.code));
      H.savePuzzle(env, g.code, p, H.fullPuzzle({ title: 'G' + gi + '-' + k, author: '甲' + (gi + 1), blocks: [{ type: 'text', text: long }] }));
    }
  });
  const { teacher, puzzles } = H.teacherWithPuzzles(env, Array.from({ length: 12 }, (_, i) => ({ answer: 'A' + i, blocks: [{ type: 'text', text: long }] })));
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '氣候變遷密室'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, puzzles.slice(0, 6).map((p) => p.id));
  H.fillRoomPages(env, env.admin, room.id);
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  const plays = [];
  for (let i = 0; i < 25; i++) plays.push(H.startPlay(env, pub.playCode, '隊' + i));
  return { env, groups, teacher, plays };
}

function instrument(env) {
  const sh = env.gs.sheet_('Codes');
  const SheetP = Object.getPrototypeOf(sh);
  const RangeP = Object.getPrototypeOf(sh.getRange(1, 1));
  const c = { calls: 0, chars: 0 };
  const wrap = (P, name, count) => {
    const f = P[name];
    P[name] = function () {
      c.calls++;
      const r = f.apply(this, arguments);
      if (count) c.chars += JSON.stringify(r).length;
      return r;
    };
  };
  wrap(RangeP, 'getValues', true);
  wrap(RangeP, 'setValues');
  wrap(SheetP, 'appendRow');
  wrap(SheetP, 'getLastRow');
  wrap(SheetP, 'deleteRow');
  return c;
}

const { env, groups, teacher, plays } = setupClass();
const c = instrument(env);
const g = groups[2];
const ws = env.plain(env.gs.getWorkspace(g.code));
const p = ws.puzzles[3];
const tws = env.plain(env.gs.getWorkspace(teacher.code));
const cases = [
  ['登入', () => env.gs.login(g.code)],
  ['學生：開工作區', () => env.gs.getWorkspace(g.code)],
  ['學生：自動儲存一題', () => { const r = env.plain(env.gs.savePuzzle(g.code, { id: p.id, rev: p.rev, title: p.title + '!' })); p.rev = r.puzzle.rev; }],
  ['學生：調整題目順序', () => env.gs.movePuzzle(g.code, p.id, -1)],
  ['學生：開密室資訊', () => env.gs.getRoom(g.code, ws.room.id)],
  ['老師：開題庫', () => env.gs.getWorkspace(teacher.code)],
  ['老師：開一題', () => env.gs.getPuzzle(teacher.code, tws.puzzles[0].id)],
  ['管理者：總覽', () => env.gs.adminOverview(env.admin)],
  ['玩家：答錯一次', () => { env.advance(30); env.gs.playAnswer(plays[7].id, 'NOPE'); }]
];
console.log('動作'.padEnd(14, '　') + '  碰試算表次數  讀進字元數');
cases.forEach(([name, fn]) => {
  // 每次呼叫在 Apps Script 都是全新的執行環境，這裡也照樣清掉（舊版沒有這個函式）
  if (env.gs.resetMemo_) env.gs.resetMemo_();
  c.calls = 0; c.chars = 0;
  fn();
  console.log(name.padEnd(14, '　') + '  ' + String(c.calls).padStart(8) + '  ' + String(c.chars).padStart(12));
});
