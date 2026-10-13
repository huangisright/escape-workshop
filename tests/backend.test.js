// 後端測試：node --test platform/tests/
// 這一檔測 v4 原有的流程（代碼、謎題卡、檢核、送審、發布、遊玩、數據、匯出）。
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const levels = (checks) => checks.map((c) => c.level);
const msgs = (checks) => checks.map((c) => c.msg).join('\n');

test('setup 建立資料庫、資料夾與管理者代碼', () => {
  const env = H.load();
  assert.match(env.admin, /^A[A-Z2-9]{6}$/);
  assert.ok(env.mock.props.SS_ID && env.mock.props.UP_ID && env.mock.props.SNAP_ID);
  const me = env.plain(env.gs.login(env.admin.toLowerCase()));
  assert.equal(me.role, 'admin');
  assert.throws(() => env.gs.login('XXXXXX'), /代碼不正確/);
  env.gs.setup(); // 再跑一次不會重建
  assert.equal(env.gs.showAdminCode(), env.admin);
});

test('老師謎題卡：紅燈擋必填，老師多兩欄必填，可看他人題目但只能改自己的', () => {
  const env = H.load();
  const [t1, t2] = env.plain(env.gs.adminCreateTeachers(env.admin, ['林老師', '陳老師']));
  const p = env.plain(env.gs.newPuzzle(t1.code));
  assert.ok(levels(p.checks).includes('err'));
  const saved = H.savePuzzle(env, t1.code, p, H.fullPuzzle({ scienceBasis: '' }));
  assert.match(msgs(saved.checks), /科學依據還沒寫/);
  const ok = H.savePuzzle(env, t1.code, saved, { scienceBasis: 'NOAA' });
  assert.ok(!levels(ok.checks).includes('err'), msgs(ok.checks));
  assert.equal(ok.author, '林老師');

  const ws = env.plain(env.gs.getWorkspace(t2.code));
  assert.equal(ws.puzzles.length, 1);
  assert.equal(ws.puzzles[0].editable, false);
  assert.throws(() => env.gs.savePuzzle(t2.code, { id: ok.id, rev: ok.rev, title: 'x' }), /只能修改自己的題目/);

  const stale = env.plain(env.gs.savePuzzle(t1.code, { id: ok.id, rev: 0, title: '舊版' }));
  assert.equal(stale.conflict, true, '版本不同時回傳最新內容');
});

test('黃燈：答案出現在題目、第一層提示有答案、太長、超時、只有一步', () => {
  const env = H.load();
  const t = env.plain(env.gs.adminCreateTeachers(env.admin, ['林老師']))[0];
  const p = env.plain(env.gs.newPuzzle(t.code));
  const s = H.savePuzzle(env, t.code, p, H.fullPuzzle({
    answer: '海平面上升很快很快的年代', blocks: [{ type: 'text', text: '提示：海平面上升很快很快的年代' }],
    hints: [{ text: '答案是海平面上升很快很快的年代', delaySec: 0 }], estMinutes: 30,
    steps: [{ get: 'a', act: 'b', result: 'c', checkpoint: '' }]
  }));
  const m = msgs(s.checks);
  assert.match(m, /出現在題目文字裡/);
  assert.match(m, /第一層提示裡直接出現答案/);
  assert.match(m, /答案超過 10 個字/);
  assert.match(m, /超過每題 15 分鐘/);
  assert.match(m, /只有一個解題步驟/);
  assert.ok(!levels(s.checks).includes('err'), '黃燈不擋');
});

test('分組：建立代碼、出題、檢核、送審鎖定、開放修改記次數', () => {
  const env = H.load();
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: '第一組', members: '王小明、李小華' }]))[0];
  assert.match(g.code, /^G/);
  const ws = env.plain(env.gs.getWorkspace(g.code));
  assert.equal(ws.room.groupName, '第一組');
  assert.equal(env.plain(env.gs.submitRoom(g.code)).ok, false, '有紅燈不能送審');

  const p1 = env.plain(env.gs.newPuzzle(g.code));
  H.savePuzzle(env, g.code, p1, H.fullPuzzle({ author: '王小明', answer: 'ABC', scienceBasis: '', reskinCheck: '' }));
  const p2 = env.plain(env.gs.newPuzzle(g.code));
  const s2 = env.plain(env.gs.savePuzzle(g.code, Object.assign({ id: p2.id, rev: 0 }, H.fullPuzzle({ author: '李小華', answer: 'XYZ', kind: 'physical' }))));
  assert.match(msgs(s2.roomChecks), /心智圖還沒上傳/);
  assert.match(msgs(s2.roomChecks), /封面還沒做/);
  assert.match(msgs(s2.puzzle.checks), /實體題還沒列道具/);

  H.fillRoomPages(env, g.code, ws.room.id);
  const r = env.plain(env.gs.getRoom(g.code));
  env.gs.saveRoom(g.code, { id: r.id, rev: r.rev, mindmap: { fileId: '', url: 'https://gitmind.com/x' } });
  const sub = env.plain(env.gs.submitRoom(g.code));
  assert.equal(sub.ok, true, msgs(sub.roomChecks));
  assert.throws(() => env.gs.newPuzzle(g.code), /已送審/);
  assert.throws(() => env.gs.savePuzzle(g.code, { id: p1.id, rev: 1, title: 'x' }), /已送審/);

  const un = env.plain(env.gs.adminRoomAction(env.admin, r.id, 'unlock'));
  assert.equal(un.status, 'draft');
  assert.equal(un.unlocksUsed, 1);
});

test('分組只能讀寫自己的資料', () => {
  const env = H.load();
  const [a, b] = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: 'A', members: '甲' }, { name: 'B', members: '乙' }]));
  const pa = env.plain(env.gs.newPuzzle(a.code));
  assert.throws(() => env.gs.savePuzzle(b.code, { id: pa.id, rev: 0, title: 'x' }), /只能修改自己的題目/);
  assert.throws(() => env.gs.uploadFile(b.code, { roomId: env.plain(env.gs.getWorkspace(a.code)).room.id, name: 'x.png', mime: 'image/png' }, 'AAAA', false), /只能上傳到自己組/);
  assert.throws(() => env.gs.adminOverview(a.code), /沒有權限/);
});

test('上傳檔案：依組別與題號命名，可讀回，超過 8 MB 擋下', () => {
  const env = H.load();
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: '第一組', members: '甲' }]))[0];
  const p = env.plain(env.gs.newPuzzle(g.code));
  const up = env.plain(env.gs.uploadFile(g.code, { puzzleId: p.id, label: '圖片', name: 'photo.JPG', mime: 'image/jpeg' }, 'AAECAw==', false));
  assert.match(up.name, /^第一組-第1題-圖片-\d{4}-\d{6}\.jpg$/);
  const back = env.plain(env.gs.getFileData(g.code, up.fileId));
  assert.equal(back.dataUrl, 'data:image/jpeg;base64,AAECAw==');
  const html = env.plain(env.gs.uploadFile(g.code, { puzzleId: p.id, name: 'game.html' }, '<p>小遊戲</p>', true));
  assert.equal(env.plain(env.gs.getFileData(g.code, html.fileId)).text, '<p>小遊戲</p>');
  const big = 'A'.repeat(Math.ceil(8 * 1024 * 1024 / 3) * 4 + 8);
  assert.throws(() => env.gs.uploadFile(g.code, { name: 'big.png', mime: 'image/png' }, big, false), /檔案太大/);
});

test('遊玩：計時、答錯冷卻、分層提示時間、中途答案、逃脫、評分與數據', () => {
  const env = H.load();
  const { room, puzzles } = H.publishedTeacherRoom(env, [
    { answer: '台北/Taipei', hints: [{ text: '首都', delaySec: 30 }, { text: '北部', delaySec: 60 }],
      steps: [{ get: '地圖', act: '找年份', result: '年份', checkpoint: '2050' }, { get: '年份', act: '換城市', result: '城市', checkpoint: '' }] },
    'OCEAN'
  ]);
  assert.match(room.playCode, /^P[A-Z2-9]{4}$/);
  assert.throws(() => env.gs.playStart(room.playCode, ' '), /請輸入隊名/);
  assert.throws(() => env.gs.playStart('PXXXX', '隊'), /遊戲代碼不正確/);

  const intro = env.plain(env.gs.playStart(room.playCode.toLowerCase(), '第一隊'));
  assert.equal(intro.total, 2);
  assert.equal(intro.timeLimitSec, 15 * 60, '示範密室預設 15 分鐘');
  assert.equal(intro.cover.text, '黃金城');

  let st = env.plain(env.gs.playBegin(intro.playId));
  assert.equal(st.gateCount, 2);
  assert.equal(st.gateLabel, '年份');
  assert.ok(!JSON.stringify(st).includes('2050'), '答案不會送到平板');
  assert.equal(st.nextHintInSec, 30);

  let r = env.plain(env.gs.playAnswer(intro.playId, '1999'));
  assert.equal(r.correct, false);
  assert.equal(r.state.cooldownSec, 10);
  r = env.plain(env.gs.playAnswer(intro.playId, '2050'));
  assert.equal(r.wait, true, '冷卻中不能作答');
  env.advance(10);
  r = env.plain(env.gs.playAnswer(intro.playId, '２０５０'));
  assert.equal(r.gatePassed, true);

  st = env.plain(env.gs.playHint(intro.playId));
  assert.equal(st.state.hintsShown.length, 0, '時間未到看不到提示');
  env.advance(25);
  st = env.plain(env.gs.playHint(intro.playId));
  assert.deepEqual(st.state.hintsShown, ['首都']);
  assert.equal(st.state.nextHintInSec, 25);

  r = env.plain(env.gs.playAnswer(intro.playId, '臺北！'));
  assert.equal(r.solved, true, '臺視為台、忽略標點');
  assert.equal(r.state.index, 1);
  env.advance(60);
  r = env.plain(env.gs.playAnswer(intro.playId, ' ocean '));
  assert.equal(r.state.result, 'escaped');
  assert.equal(r.state.ending.text, '逃出來了');
  assert.equal(r.state.rateList.length, 2);

  env.gs.playRate(intro.playId, [{ id: puzzles[0].id, rating: 4 }, { id: puzzles[1].id, rating: 9 }], '第一題', '');
  const stats = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.equal(stats.plays, 1);
  assert.equal(stats.escaped, 1);
  assert.equal(stats.perPuzzle[0].wrongCount, 1);
  assert.deepEqual(stats.perPuzzle[0].topWrong, [{ answer: '1999', count: 1 }]);
  assert.equal(stats.perPuzzle[0].gatesPassed, 1);
  assert.equal(stats.perPuzzle[0].avgRating, 4);
  assert.equal(stats.perPuzzle[1].ratingCount, 0, '超出 1–5 的評分不收');
  assert.deepEqual(stats.comments, ['最喜歡：第一題']);
});

test('時間到就結束，之後不能再作答', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE', 'TWO']);
  const { id } = H.startPlay(env, room.playCode);
  env.advance(15 * 60 + 1);
  const r = env.plain(env.gs.playAnswer(id, 'ONE'));
  assert.equal(r.state.result, 'timeout');
  assert.equal(r.state.ending.text, '城沉了');
  assert.equal(r.state.rateList.length, 1);
});

test('發布凍結版本：改題目不影響正在玩的人，更新發布版本後才上線', () => {
  const env = H.load();
  const { room, puzzles } = H.publishedTeacherRoom(env, ['OLD']);
  const t = env.plain(env.gs.getWorkspace(env.plain(env.gs.adminOverview(env.admin)).codes.find((c) => c.role === 'teacher').code));
  const tcode = env.plain(env.gs.adminOverview(env.admin)).codes.find((c) => c.role === 'teacher').code;
  H.savePuzzle(env, tcode, t.puzzles[0], { answer: 'NEW' });
  let play = H.startPlay(env, room.playCode);
  assert.equal(env.plain(env.gs.playAnswer(play.id, 'NEW')).correct, false);
  env.advance(11);
  assert.equal(env.plain(env.gs.playAnswer(play.id, 'OLD')).state.result, 'escaped');
  env.gs.adminRoomAction(env.admin, room.id, 'publish');
  play = H.startPlay(env, room.playCode);
  assert.equal(env.plain(env.gs.playAnswer(play.id, 'NEW')).state.result, 'escaped');
  assert.ok(puzzles.length);
});

test('試玩不計入數據；下架後不能進入', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['ONE']);
  const intro = env.plain(env.gs.startTestPlay(env.admin, room.id));
  assert.equal(intro.test, true);
  env.gs.playBegin(intro.playId);
  env.gs.playAnswer(intro.playId, 'ONE');
  assert.equal(env.plain(env.gs.adminStats(env.admin, room.id)).plays, 0);
  const live = env.plain(env.gs.adminLive(env.admin));
  assert.equal(live[0].test, true);
  env.gs.adminRoomAction(env.admin, room.id, 'unpublish');
  assert.throws(() => env.gs.playStart(room.playCode, '隊'), /還沒開放/);
});

test('匯出：整間密室離線版與一題一檔，答案只存雜湊', () => {
  const env = H.load();
  const { room } = H.publishedTeacherRoom(env, ['SECRET1', 'SECRET2']);
  const all = env.plain(env.gs.adminExport(env.admin, room.id, 'room'));
  assert.equal(all.files.length, 1);
  const each = env.plain(env.gs.adminExport(env.admin, room.id, 'puzzles'));
  assert.equal(each.files.length, 2);
  const html = Object.values(env.mock.files).find((f) => /整間密室\.html$/.test(f.name)).blob.getDataAsString();
  assert.ok(!/secret1/i.test(html), '離線版不含明文答案');
  assert.ok(html.includes(require('crypto').createHash('sha256').update('secret1').digest('hex')));
});

test('材料清單與管理總覽', () => {
  const env = H.load();
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: '第一組', members: '甲' }]))[0];
  const p = env.plain(env.gs.newPuzzle(g.code));
  H.savePuzzle(env, g.code, p, H.fullPuzzle({ author: '甲', kind: 'physical', props: [{ item: '密碼鎖', place: '講桌' }] }));
  const mats = env.plain(env.gs.adminMaterials(env.admin));
  assert.deepEqual(mats[0].puzzles[0].props, [{ item: '密碼鎖', place: '講桌' }]);
  const ov = env.plain(env.gs.adminOverview(env.admin));
  assert.equal(ov.rooms.length, 1);
  assert.equal(ov.rooms[0].puzzleCount, 1);
  assert.equal(env.mock.lockDepth(), 0, '所有鎖都有釋放');
});
