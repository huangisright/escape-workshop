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

test('設定：只有管理者能改玩法，亂填的值當成一題接一題', () => {
  const env = H.load();
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, 'X'));
  assert.equal(room.mode, 'linear');
  let r = env.plain(env.gs.getRoom(env.admin, room.id));
  r = env.plain(env.gs.saveRoom(env.admin, { id: room.id, rev: r.rev, mode: 'whatever' })).room;
  assert.equal(r.mode, 'linear');
  r = env.plain(env.gs.saveRoom(env.admin, { id: room.id, rev: r.rev, mode: 'free' })).room;
  assert.equal(r.mode, 'free');

  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: 'A', members: '甲' }]))[0];
  const gr = env.plain(env.gs.getRoom(g.code));
  env.gs.saveRoom(g.code, { id: gr.id, rev: gr.rev, mode: 'free' });
  assert.notEqual(env.plain(env.gs.getRoom(g.code)).mode, 'free', '分組不能自己改玩法');
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
