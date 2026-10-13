// 選用玩法測試（氣候變遷示範密室草案）：終章碎片、跳過扣時、寶庫
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const msgs = (checks) => checks.map((c) => c.msg).join('\n');

// 主線 3 題（答案 A1/A2/A3），寶庫 2 題（V1 易、V2），碎片 7/3/1，跳過扣 5 分鐘，時限 90 分鐘
function climateRoom(env, opts) {
  opts = opts || {};
  const { puzzles } = H.teacherWithPuzzles(env, ['A1', 'A2', 'A3', 'V1', 'V2']);
  const main = puzzles.slice(0, 3), vault = opts.noVault ? [] : puzzles.slice(3);
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '黃金城'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, main.map((p) => p.id), {
    fragments: opts.fragments || ['7', '3', '1'], vaultIds: vault.map((p) => p.id)
  });
  H.fillRoomPages(env, env.admin, room.id);
  const r = env.plain(env.gs.getRoom(env.admin, room.id));
  env.gs.saveRoom(env.admin, {
    id: room.id, rev: r.rev, timeLimitMin: 90, skipMin: opts.skipMin === undefined ? 5 : opts.skipMin,
    finale: { enabled: opts.finale !== false, text: '把碎片依序輸入', imageId: '', answer: opts.finaleAnswer || '', hint: '看線索簿' }
  });
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  return { room: pub, main, vault };
}

test('組裝：碎片跟著位置走，寶庫排除主線與重複，檢核會要求碎片與終章頁', () => {
  const env = H.load();
  const { puzzles } = H.teacherWithPuzzles(env, ['A1', 'A2', 'A3']);
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '黃金城'));
  const saved = env.plain(env.gs.adminSetRoomPuzzles(env.admin, room.id, [puzzles[0].id, puzzles[1].id], {
    fragments: [' 7 ', ''], vaultIds: [puzzles[1].id, puzzles[2].id, puzzles[2].id, 'nope']
  }));
  assert.deepEqual(saved.fragments, ['7', '']);
  assert.deepEqual(saved.vaultIds, [puzzles[2].id]);

  const r = env.plain(env.gs.getRoom(env.admin, room.id));
  const out = env.plain(env.gs.saveRoom(env.admin, { id: room.id, rev: r.rev, finale: { enabled: true, text: '', imageId: '', answer: '', hint: '' } }));
  const m = msgs(out.roomChecks);
  assert.match(m, /終章：第 2 題還沒設碎片/);
  assert.match(m, /終章頁還沒寫/);

  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: 'A', members: '甲' }]))[0];
  const gr = env.plain(env.gs.getRoom(g.code));
  env.gs.saveRoom(g.code, { id: gr.id, rev: gr.rev, skipMin: 99, finale: { enabled: true } });
  const after = env.plain(env.gs.getRoom(g.code));
  assert.equal(after.skipMin, 0, '分組不能改管理者欄位');
  assert.equal(after.finale.enabled, false);
});

test('完整流程：主線拿碎片 → 跳過扣時照樣拿碎片 → 終章 → 逃脫時間定下 → 寶庫', () => {
  const env = H.load();
  const { room, main, vault } = climateRoom(env);
  const intro = env.plain(env.gs.playStart(room.playCode, '探險隊'));
  assert.equal(intro.finale, true);
  assert.equal(intro.vaultTotal, 2);
  assert.equal(intro.skipMin, 5);
  let st = env.plain(env.gs.playBegin(intro.playId));
  assert.equal(st.phase, 'main');
  assert.equal(st.canSkip, true);
  assert.deepEqual(st.fragments, []);

  env.advance(60);
  let r = env.plain(env.gs.playAnswer(intro.playId, 'A1'));
  assert.equal(r.fragment, '7');
  assert.deepEqual(r.state.fragments, ['7']);

  r = env.plain(env.gs.playSkip(intro.playId));
  assert.equal(r.fragment, '3');
  assert.equal(r.penaltyMin, 5);
  assert.equal(r.state.skips, 1);
  assert.equal(r.state.remainingSec, 90 * 60 - 60 - 300, '跳過扣 5 分鐘');

  env.advance(60);
  r = env.plain(env.gs.playAnswer(intro.playId, 'A3'));
  assert.equal(r.state.phase, 'finale');
  assert.equal(r.state.puzzleId, 'finale');
  assert.equal(r.state.title, '終章');
  assert.equal(r.state.canSkip, false);
  assert.ok(!JSON.stringify(r.state).includes('731'), '終章答案不送到平板');
  assert.throws(() => env.gs.playSkip(intro.playId), /不能跳過/);

  r = env.plain(env.gs.playHint(intro.playId));
  assert.deepEqual(r.state.hintsShown, ['看線索簿']);

  env.advance(30);
  r = env.plain(env.gs.playAnswer(intro.playId, '7 3 1'));
  assert.equal(r.solved, true);
  assert.equal(r.escaped, true);
  assert.equal(r.state.result, 'escaped');
  assert.equal(r.state.over, false, '逃脫後還能進寶庫');
  assert.equal(r.state.phase, 'vault');
  assert.equal(r.state.escapeSec, 60 + 60 + 30 + 300);
  assert.equal(r.state.puzzleId, vault[0].id);

  env.advance(600);
  r = env.plain(env.gs.playAnswer(intro.playId, 'V1'));
  assert.equal(r.escaped, false);
  assert.equal(r.state.vaultSolved, 1);
  assert.equal(r.state.escapeSec, 450, '寶庫不影響逃脫時間');

  r = env.plain(env.gs.playSkip(intro.playId));
  assert.equal(r.state.over, true, '寶庫最後一題換掉就結束');
  assert.equal(r.state.vaultSolved, 1);
  assert.equal(r.state.elapsedSec, 450, '結局顯示逃脫時間');
  assert.equal(r.state.ending.text, '逃出來了');
  assert.deepEqual(r.state.rateList.map((x) => x.label || '第' + x.no), ['第1', '第2', '第3', '寶庫 1', '寶庫 2']);

  const stats = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.equal(stats.escaped, 1);
  assert.equal(stats.avgEscapeMin, 7.5);
  assert.equal(stats.vaultTotal, 2);
  assert.equal(stats.perPuzzle[1].skipped, 1);
  assert.equal(stats.perPuzzle[3].vault, true);
  assert.equal(stats.perPuzzle[3].solved, 1);
  assert.ok(main.length && vault.length);
});

test('寶庫：想停就停；時間到結束但保留逃脫成功', () => {
  const env = H.load();
  const { room } = climateRoom(env);
  let p = H.startPlay(env, room.playCode, '一隊');
  ['A1', 'A2', 'A3', '731'].forEach((a) => env.gs.playAnswer(p.id, a));
  let r = env.plain(env.gs.playFinish(p.id));
  assert.equal(r.state.over, true);
  assert.equal(r.state.result, 'escaped');
  assert.equal(r.state.vaultSolved, 0);

  p = H.startPlay(env, room.playCode, '二隊');
  ['A1', 'A2', 'A3', '731'].forEach((a) => env.gs.playAnswer(p.id, a));
  env.advance(90 * 60 + 1);
  r = env.plain(env.gs.playAnswer(p.id, 'V1'));
  assert.equal(r.state.over, true);
  assert.equal(r.state.result, 'escaped', '寶庫時間到不算失敗');
  assert.equal(r.state.vaultSolved, 0);

  const live = env.plain(env.gs.adminLive(env.admin));
  assert.equal(live.length, 2);
  assert.ok(live.every((x) => x.result === 'escaped' && x.escapeSec === 0));
});

test('跳過扣時可能直接讓時間用完', () => {
  const env = H.load();
  const { room } = climateRoom(env, { skipMin: 50 });
  const p = H.startPlay(env, room.playCode);
  let r = env.plain(env.gs.playSkip(p.id));
  assert.equal(r.state.over, false);
  r = env.plain(env.gs.playSkip(p.id));
  assert.equal(r.state.over, true);
  assert.equal(r.state.result, 'timeout');
  assert.equal(r.state.remainingSec, 0);
});

test('沒開終章：最後一題解開就逃脫，再進寶庫；沒開跳過就不能跳', () => {
  const env = H.load();
  const { room } = climateRoom(env, { finale: false, skipMin: 0 });
  const p = H.startPlay(env, room.playCode);
  assert.equal(p.st.canSkip, false);
  assert.throws(() => env.gs.playSkip(p.id), /不能跳過/);
  env.gs.playAnswer(p.id, 'A1');
  env.gs.playAnswer(p.id, 'A2');
  const r = env.plain(env.gs.playAnswer(p.id, 'A3'));
  assert.equal(r.escaped, true);
  assert.equal(r.fragment, null);
  assert.equal(r.state.phase, 'vault');
  assert.deepEqual(r.state.fragments, []);
});

test('終章自訂答案優先；沒有寶庫時逃脫就結束', () => {
  const env = H.load();
  const { room } = climateRoom(env, { finaleAnswer: '2050/二〇五〇', noVault: true });
  const p = H.startPlay(env, room.playCode);
  ['A1', 'A2', 'A3'].forEach((a) => env.gs.playAnswer(p.id, a));
  assert.equal(env.plain(env.gs.playAnswer(p.id, '731')).correct, false);
  env.advance(10);
  const r = env.plain(env.gs.playAnswer(p.id, '二〇五〇'));
  assert.equal(r.escaped, true);
  assert.equal(r.state.over, true);
  assert.equal(r.state.rateList.length, 3);
});

test('發布前的舊版本快照照常可玩（沒有新欄位）', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE']);
  const snapRow = env.mock.sheetRows('Snapshots')[0];
  const file = env.mock.files[snapRow[3]];
  const snap = JSON.parse(file.blob.getDataAsString());
  ['finale', 'fragments', 'skipMin'].forEach((k) => delete snap.room[k]);
  delete snap.vault;
  file.blob = env.gs.Utilities.newBlob(JSON.stringify(snap), 'application/json', file.name);
  env.gs.CacheService.getScriptCache().remove('snap:' + snapRow[1]);
  const p = H.startPlay(env, room.playCode);
  assert.equal(p.st.finale, false);
  assert.equal(env.plain(env.gs.playAnswer(p.id, 'ONE')).state.result, 'escaped');
});
