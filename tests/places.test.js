// 關卡位置：管理者在挑題（示範密室）或審核（學生密室）時設定，遊戲中有填才出現位置表
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

test('示範密室：挑題時一起設定地點；發布後遊戲狀態帶位置表與本題地點', () => {
  const env = H.load();
  const { room, puzzles } = H.publishedTeacherRoom(env, ['A1', 'A2', 'A3']);
  // 發布時沒填地點：遊戲中沒有位置表
  let p = H.startPlay(env, room.playCode);
  assert.equal(p.st.places, undefined);
  assert.equal(p.st.place, '');

  const ids = puzzles.map((x) => x.id);
  env.gs.adminSetRoomPuzzles(env.admin, room.id, ids, {
    places: { [ids[0]]: '  圖書館門口 ', [ids[2]]: '居禮教室', notInRoom: '亂填' }
  });
  const saved = env.plain(env.gs.getRoom(env.admin, room.id));
  assert.deepEqual(saved.places, { [ids[0]]: '圖書館門口', [ids[2]]: '居禮教室' }, '去頭尾空白、不在密室裡的題目不存');

  // 還沒更新發布版本：正在玩的不受影響
  p = H.startPlay(env, room.playCode, '第二隊');
  assert.equal(p.st.places, undefined);

  env.gs.adminRoomAction(env.admin, room.id, 'publish');
  p = H.startPlay(env, room.playCode, '第三隊');
  assert.deepEqual(p.st.places.map((x) => x.place), ['圖書館門口', '', '居禮教室']);
  assert.deepEqual(p.st.places.map((x) => x.no), [1, 2, 3]);
  const cur = p.st.places[p.st.index];
  assert.equal(p.st.place, cur.place);
});

test('學生密室：管理者可以設定地點，學生自己不能改', () => {
  const env = H.load();
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: 'A', members: '甲' }]))[0];
  const r0 = env.plain(env.gs.getRoom(g.code));
  const pz = env.plain(env.gs.newPuzzle(g.code));
  H.savePuzzle(env, g.code, pz, H.fullPuzzle({ author: '甲', answer: 'X' }));

  const out = env.plain(env.gs.adminSetRoomPlaces(env.admin, r0.id, { [pz.id]: '新住民中心' }));
  assert.deepEqual(out.places, { [pz.id]: '新住民中心' });
  assert.throws(() => env.gs.adminSetRoomPlaces(g.code, r0.id, { [pz.id]: '亂改' }));

  // 學生存密室時帶 places 也不會被接受
  const r1 = env.plain(env.gs.getRoom(g.code));
  env.gs.saveRoom(g.code, { id: r1.id, rev: r1.rev, places: { [pz.id]: '亂改' } });
  assert.deepEqual(env.plain(env.gs.getRoom(env.admin, r0.id)).places, { [pz.id]: '新住民中心' });

  // 地點最多 40 字
  const long = '很'.repeat(60);
  const o2 = env.plain(env.gs.adminSetRoomPlaces(env.admin, r0.id, { [pz.id]: long }));
  assert.equal(o2.places[pz.id].length, 40);
});

test('API 有開放 adminSetRoomPlaces', () => {
  const env = H.load();
  assert.ok(env.gs.API_FUNCTIONS.indexOf('adminSetRoomPlaces') >= 0);
});
