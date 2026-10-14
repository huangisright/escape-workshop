// 重新整理後接著玩、重置按鈕
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

test('playResume：還沒開始回封面說明，開始後回目前進度', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE', 'TWO']);
  const intro = env.plain(env.gs.playStart(room.playCode, '一隊'));
  assert.equal(intro.playCode, room.playCode);
  assert.equal(intro.pinRequired, false);

  let r = env.plain(env.gs.playResume(intro.playId));
  assert.equal(r.begun, false);
  assert.equal(r.state, null);
  assert.equal(r.intro.cover.text, '黃金城');
  assert.equal(r.intro.team, '一隊');

  env.gs.playBegin(intro.playId);
  env.advance(30);
  env.gs.playAnswer(intro.playId, 'ONE');
  env.advance(30);
  r = env.plain(env.gs.playResume(intro.playId));
  assert.equal(r.begun, true);
  assert.equal(r.state.index, 1);
  assert.equal(r.state.remainingSec, 15 * 60 - 60, '計時沒有重來');
  assert.ok(r.state.blocks, '重新整理後要重送題目內容');
});

test('playReset：進行中的場次標成已重置、不算數據，之後不能再接著玩', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE', 'TWO']);
  const p = H.startPlay(env, room.playCode, '一隊');
  env.gs.playAnswer(p.id, 'ONE');
  assert.equal(env.gs.playReset(p.id, ''), true);
  assert.throws(() => env.gs.playResume(p.id), /已經重置/);
  const stats = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.equal(stats.plays, 0, '重置的場次不列入數據');
  assert.equal(env.plain(env.gs.adminLive(env.admin))[0].result, 'reset');
});

test('已經結束的場次按重置不會被改掉', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE']);
  const p = H.startPlay(env, room.playCode, '一隊');
  env.gs.playAnswer(p.id, 'ONE');
  env.gs.playReset(p.id, '');
  const stats = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.equal(stats.escaped, 1);
});

test('在寶庫按重置：保留逃脫成績，只結束寶庫', () => {
  const env = H.load();
  const { puzzles } = H.teacherWithPuzzles(env, ['A1', 'V1']);
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '黃金城'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, [puzzles[0].id], { fragments: [''], vaultIds: [puzzles[1].id] });
  H.fillRoomPages(env, env.admin, room.id);
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  const p = H.startPlay(env, pub.playCode);
  assert.equal(env.plain(env.gs.playAnswer(p.id, 'A1')).state.phase, 'vault');
  env.gs.playReset(p.id, '');
  const r = env.plain(env.gs.playResume(p.id));
  assert.equal(r.state.over, true);
  assert.equal(r.state.result, 'escaped');
});

test('設了重置密碼就要輸入正確密碼', () => {
  const env = H.load();
  env.gs.adminSaveSettings(env.admin, { resetPin: '1234' });
  const { room } = H.publishedTeacherRoom(env, ['ONE']);
  const intro = env.plain(env.gs.playStart(room.playCode, '一隊'));
  assert.equal(intro.pinRequired, true);
  assert.throws(() => env.gs.playReset(intro.playId, ''), /重置密碼不對/);
  assert.throws(() => env.gs.playReset(intro.playId, '9999'), /重置密碼不對/);
  assert.equal(env.gs.playReset(intro.playId, ' 1234 '), true);
});
