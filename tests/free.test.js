// 自由選題模式：主線各題同時開放，玩家自己挑順序
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// 主線 3 題（A1/A2/A3，每題提示 60 秒後可看），寶庫 1 題，碎片 7/3/1，跳過扣 5 分鐘，時限 90 分鐘
function freeRoom(env, opts) {
  opts = opts || {};
  const answers = ['A1', 'A2', 'A3', 'V1'].map((a) => ({ answer: a, hints: [{ text: a + ' 的提示', delaySec: 60 }] }));
  const { puzzles } = H.teacherWithPuzzles(env, answers);
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '自由密室'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, puzzles.slice(0, 3).map((p) => p.id), {
    fragments: ['7', '3', '1'], vaultIds: opts.noVault ? [] : [puzzles[3].id]
  });
  H.fillRoomPages(env, env.admin, room.id);
  const r = env.plain(env.gs.getRoom(env.admin, room.id));
  env.gs.saveRoom(env.admin, {
    id: room.id, rev: r.rev, timeLimitMin: 90, skipMin: 5, mode: opts.mode || 'free',
    finale: { enabled: opts.finale !== false, text: '把碎片依序輸入', imageId: '', answer: '', hint: '' }
  });
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  return { room: pub, puzzles };
}

test('設定：預設自由選題＋小島；設計者（分組）也能改玩法與地圖；亂填的值回到預設', () => {
  const env = H.load();
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, 'X'));
  assert.equal(room.mode, 'free');
  assert.equal(room.theme, 'island');
  let r = env.plain(env.gs.getRoom(env.admin, room.id));
  r = env.plain(env.gs.saveRoom(env.admin, { id: room.id, rev: r.rev, mode: 'whatever', theme: 'moon' })).room;
  assert.equal(r.mode, 'free');
  assert.equal(r.theme, 'island');
  r = env.plain(env.gs.saveRoom(env.admin, { id: room.id, rev: r.rev, mode: 'linear', theme: 'jigsaw' })).room;
  assert.equal(r.mode, 'linear');
  assert.equal(r.theme, 'jigsaw');

  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: 'A', members: '甲' }]))[0];
  const gr = env.plain(env.gs.getRoom(g.code));
  assert.equal(gr.mode, 'free');
  env.gs.saveRoom(g.code, { id: gr.id, rev: gr.rev, mode: 'linear', theme: 'planet' });
  const after = env.plain(env.gs.getRoom(g.code));
  assert.equal(after.mode, 'linear');
  assert.equal(after.theme, 'planet');
});

test('沒設過玩法的舊密室：重新發布後是自由選題；已發布的舊快照照舊一題接一題', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE', 'TWO']);
  // 模擬這個欄位出現前就存在的密室與快照
  const snapRow = env.mock.sheetRows('Snapshots')[0];
  const file = env.mock.files[snapRow[3]];
  const snap = JSON.parse(file.blob.getDataAsString());
  delete snap.room.mode; delete snap.room.theme;
  file.blob = env.gs.Utilities.newBlob(JSON.stringify(snap), 'application/json', file.name);
  env.gs.CacheService.getScriptCache().remove('snap:' + snapRow[1]);
  let p = H.startPlay(env, room.playCode);
  assert.equal(p.st.free, false, '舊快照不受影響');

  const doc = env.gs.getDoc_('Rooms', room.id);
  delete doc.mode; delete doc.theme;
  env.gs.putDoc_('Rooms', doc);
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  p = H.startPlay(env, pub.playCode);
  assert.equal(p.st.free, true);
  assert.equal(p.st.theme, 'island');
  assert.equal(p.intro.theme, 'island');
});

test('自由選題：任意順序、碎片照位置放、換題保留進度、提示只算停在這題的時間', () => {
  const env = H.load();
  const { room, puzzles } = freeRoom(env);
  const intro = env.plain(env.gs.playStart(room.playCode, '自由隊'));
  assert.equal(intro.free, true);
  let st = env.plain(env.gs.playBegin(intro.playId));
  assert.equal(st.free, true);
  assert.deepEqual(st.board.map((b) => b.status), ['current', 'new', 'new']);
  assert.equal(st.puzzleId, puzzles[0].id);

  // 在第 1 題待 40 秒，換到第 3 題
  env.advance(40);
  st = env.plain(env.gs.playOpen(intro.playId, 2));
  assert.equal(st.puzzleId, puzzles[2].id);
  assert.equal(st.nextHintInSec, 60, '新開的題目提示從頭倒數');
  assert.deepEqual(st.board.map((b) => b.status), ['opened', 'new', 'current']);

  // 第 3 題答錯 → 冷卻跟著隊伍走，換題也躲不掉
  let r = env.plain(env.gs.playAnswer(intro.playId, 'nope'));
  assert.equal(r.correct, false);
  st = env.plain(env.gs.playOpen(intro.playId, 1));
  assert.ok(st.cooldownSec > 0);
  env.advance(30);

  // 回到第 1 題：已經花了 40 秒，提示剩 20 秒
  st = env.plain(env.gs.playOpen(intro.playId, 0));
  assert.equal(st.nextHintInSec, 20);
  env.advance(20);
  st = env.plain(env.gs.playHint(intro.playId)).state;
  assert.deepEqual(st.hintsShown, ['A1 的提示']);

  // 第 1 題解開 → 碎片 7 放在第 1 格，自動開下一個沒過的題目（第 2 題）
  r = env.plain(env.gs.playAnswer(intro.playId, 'A1'));
  assert.equal(r.solved, true);
  assert.equal(r.fragment, '7');
  assert.deepEqual(r.state.fragments, ['7', null, null]);
  assert.equal(r.state.puzzleId, puzzles[1].id);
  assert.equal(r.state.solvedCount, 1);
  assert.throws(() => env.gs.playOpen(intro.playId, 0), /已經過關/);

  // 先解第 3 題，再跳過第 2 題
  st = env.plain(env.gs.playOpen(intro.playId, 2));
  r = env.plain(env.gs.playAnswer(intro.playId, 'A3'));
  assert.deepEqual(r.state.fragments, ['7', null, '1']);
  assert.equal(r.state.puzzleId, puzzles[1].id, '只剩第 2 題');
  r = env.plain(env.gs.playSkip(intro.playId));
  assert.equal(r.fragment, '3');
  assert.equal(r.state.phase, 'finale');
  assert.deepEqual(r.state.fragments, ['7', '3', '1']);
  assert.equal(r.state.board, undefined, '終章不顯示選題板');
  assert.throws(() => env.gs.playOpen(intro.playId, 1), /依序/);

  // 終章密碼還是依位置接：731（不是解題順序 713）
  assert.equal(env.plain(env.gs.playAnswer(intro.playId, '713')).correct, false);
  env.advance(10);
  r = env.plain(env.gs.playAnswer(intro.playId, '731'));
  assert.equal(r.escaped, true);
  assert.equal(r.state.phase, 'vault');

  const stats = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.equal(stats.perPuzzle[0].solved, 1);
  assert.equal(stats.perPuzzle[0].avgSolveMin, 1, '第 1 題只算停在這題的 60 秒');
  assert.equal(stats.perPuzzle[1].skipped, 1);
  const live = env.plain(env.gs.adminLive(env.admin));
  assert.equal(live[0].free, true);
  assert.equal(live[0].solvedCount, 3);
});

test('自由選題沒開終章：全部過關就逃脫；時間到只評有打開過的題目', () => {
  const env = H.load();
  const { room } = freeRoom(env, { finale: false, noVault: true });
  let p = H.startPlay(env, room.playCode, '一隊');
  env.gs.playOpen(p.id, 1);
  env.gs.playAnswer(p.id, 'A2');
  env.gs.playAnswer(p.id, 'A3');
  let r = env.plain(env.gs.playAnswer(p.id, 'A1'));
  assert.equal(r.escaped, true);
  assert.equal(r.state.over, true);
  assert.equal(r.state.rateList.length, 3);

  p = H.startPlay(env, room.playCode, '二隊');
  env.gs.playOpen(p.id, 2);
  env.advance(90 * 60 + 1);
  const st = env.plain(env.gs.playState(p.id, ''));
  assert.equal(st.result, 'timeout');
  assert.deepEqual(st.rateList.map((x) => x.no), [1, 3], '第 2 題沒打開過，不用評');
});

test('一題接一題的密室不能跳題', () => {
  const env = H.load();
  const { room } = freeRoom(env, { mode: 'linear' });
  const p = H.startPlay(env, room.playCode);
  assert.equal(p.st.free, false);
  assert.equal(p.st.board, undefined);
  assert.throws(() => env.gs.playOpen(p.id, 1), /依序/);
});

test('創作者署名：玩家看得到每題設計者，結束畫面的題目清單也有', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE', 'TWO']);
  let p = H.startPlay(env, room.playCode);
  assert.ok(p.st.author, '題目畫面要帶設計者');
  let st = p.st;
  for (const ans of ['ONE', 'TWO']) {
    if (st.board) st = env.plain(env.gs.playOpen(p.id, ['ONE', 'TWO'].indexOf(ans)));
    st = env.plain(env.gs.playAnswer(p.id, ans)).state || st;
  }
  const end = env.plain(env.gs.playState(p.id, ''));
  assert.equal(end.over, true, '兩題都解完應該結束');
  assert.ok(end.rateList.length && end.rateList.every((q) => q.author), '結束清單每題都有設計者');
});
