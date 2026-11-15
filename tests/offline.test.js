// 離線備援與同隊名接回的後端測試：node --test tests/offline.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./helpers');

function room(env, opts) {
  opts = opts || {};
  const { puzzles } = H.teacherWithPuzzles(env, ['AIR', 'TIDE', 'ICE']);
  const r = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '黃金城'));
  env.gs.adminSetRoomPuzzles(env.admin, r.id, puzzles.map((p) => p.id), opts.assemble);
  H.fillRoomPages(env, env.admin, r.id);
  const cur = env.plain(env.gs.getRoom(env.admin, r.id));
  env.gs.saveRoom(env.admin, Object.assign({ id: r.id, rev: cur.rev, timeLimitMin: 90, mode: 'free' }, opts.room || {}));
  const pub = env.plain(env.gs.adminRoomAction(env.admin, r.id, 'publish'));
  return { room: pub, puzzles };
}
const start = (env, code, team, members) => env.plain(env.gs.playStart(code, team, members || ['甲', '乙']));

test('同隊名還在進行中：重新進入接回原本那場，計時不重置', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  env.gs.playBegin(a.playId);
  env.advance(600);
  const b = start(env, r.playCode, ' 第一隊 ', ['乙']); // 隊名多空白、成員只剩一位也算同隊
  assert.equal(b.playId, a.playId);
  assert.equal(b.resumed, true);
  const st = env.plain(env.gs.playState(a.playId, ''));
  assert.equal(st.elapsedSec, 600, '計時沿用原本那場');
  const plays = env.plain(env.gs.readAll_('Plays'));
  assert.equal(plays.length, 1, '沒有開出新局');
});

test('同隊名但成員完全不同：視為別組撞名，擋下來', () => {
  const env = H.load();
  const { room: r } = room(env);
  start(env, r.playCode, '第一隊');
  assert.throws(() => env.gs.playStart(r.playCode, '第一隊', ['丙', '丁']), /正在被另一組使用/);
});

test('已經結束的隊名可以再開新局', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  env.gs.playBegin(a.playId);
  env.advance(90 * 60 + 5);
  env.gs.playState(a.playId, '');
  const b = start(env, r.playCode, '第一隊');
  assert.notEqual(b.playId, a.playId);
  assert.notEqual(b.resumed, true);
});

test('playState 帶完整進度（不含答案），每存一次版本加一', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  const s0 = env.plain(env.gs.playBegin(a.playId));
  assert.ok(s0.sync && s0.sync.st && s0.sync.serverNow > 0);
  assert.ok(!JSON.stringify(s0).includes('AIR'), '回傳裡不能有答案');
  const s1 = env.plain(env.gs.playHint(a.playId)).state;
  assert.ok(s1.sync.v > s0.sync.v);
});

test('題目包：答案是加鹽雜湊，和用戶端算法一致；有終章、跳過、寶庫的密室不提供', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  env.gs.playBegin(a.playId);
  const b = env.plain(env.gs.playBundle(a.playId));
  assert.equal(b.capable, true);
  assert.ok(!JSON.stringify(b).includes('"AIR"'), '題目包裡不能有明文答案');
  const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s，,。．.、；;：:！!？?「」『』“”"'‘’（）()【】\[\]]/g, '');
  const want = crypto.createHash('sha256').update(b.salt + '|' + norm('air'), 'utf8').digest('hex');
  assert.ok(b.puzzles[0].gates[0].hashes.includes(want));
  assert.equal(b.puzzles[0].blocks[0].type, 'text');

  const env2 = H.load();
  const { room: r2 } = room(env2, { room: { skipMin: 5 } });
  const a2 = start(env2, r2.playCode, '第二隊');
  env2.gs.playBegin(a2.playId);
  assert.equal(env2.plain(env2.gs.playBundle(a2.playId)).capable, false);
});

test('離線回傳：收下進度與事件；過期、對不上、時間離譜的不收', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  const s0 = env.plain(env.gs.playBegin(a.playId));
  env.advance(300);
  const st = JSON.parse(JSON.stringify(s0.sync.st));
  st.v += 1000;
  st.escapeSec = 290;
  const payload = {
    st, result: 'escaped', ended: new Date(Date.now()).toISOString(),
    events: [{ ts: new Date().toISOString(), puzzleId: 'p', type: 'solve', value: '', elapsed: 60 }]
  };
  // 開始時間對不上
  const bad = JSON.parse(JSON.stringify(payload)); bad.st.startMs += 5;
  assert.throws(() => env.gs.playSync(a.playId, bad), /對不起來/);
  // 逃脫時間超過限時
  const slow = JSON.parse(JSON.stringify(payload)); slow.st.escapeSec = 90 * 60 + 60;
  assert.throws(() => env.gs.playSync(a.playId, slow), /超過限時/);
  // 正常
  const ok = env.plain(env.gs.playSync(a.playId, payload));
  assert.equal(ok.synced, true);
  assert.equal(ok.state.result, 'escaped');
  assert.equal(ok.state.over, true);
  assert.equal(ok.state.elapsedSec, 290);
  const ev = env.plain(env.gs.readAll_('Events')).filter((e) => e.playId === a.playId && e.type === 'solve');
  assert.equal(ev.length, 1);
  // 伺服器版本比較新（例如別處又動過）就不覆蓋
  const old = JSON.parse(JSON.stringify(payload)); old.st.v = 1;
  assert.equal(env.plain(env.gs.playSync(a.playId, old)).stale, true);
});

test('離線逃脫但很晚才回傳：平台先自動判時間到，回傳後改回逃脫', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  const s0 = env.plain(env.gs.playBegin(a.playId));
  env.advance(95 * 60); // 這段時間 iPad 都沒網路，平台在限時到了之後自己結束
  env.gs.adminLive(env.admin);
  assert.equal(env.plain(env.gs.readAll_('Plays')).find((p) => p.id === a.playId).result, 'timeout');
  const st = JSON.parse(JSON.stringify(s0.sync.st));
  st.v += 1000; // 裝置斷線時版本號加 1000
  st.escapeSec = 80 * 60;
  const ok = env.plain(env.gs.playSync(a.playId, { st, result: 'escaped', ended: new Date().toISOString(), events: [] }));
  assert.equal(ok.synced, true);
  assert.equal(ok.state.result, 'escaped');
  assert.equal(ok.state.elapsedSec, 80 * 60);
});

test('離線回傳半途進度但限時已過：收下進度並結束，結束時間是限時用完那一刻', () => {
  const env = H.load();
  const { room: r } = room(env);
  const a = start(env, r.playCode, '第一隊');
  const s0 = env.plain(env.gs.playBegin(a.playId));
  env.advance(120 * 60);
  const st = JSON.parse(JSON.stringify(s0.sync.st));
  st.v += 1000;
  const ok = env.plain(env.gs.playSync(a.playId, { st, result: '', ended: '', events: [] }));
  assert.equal(ok.state.result, 'timeout');
  const play = env.plain(env.gs.readAll_('Plays')).find((p) => p.id === a.playId);
  assert.equal(new Date(play.ended).getTime(), st.startMs + 90 * 60 * 1000);
});
