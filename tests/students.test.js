// 學生用 Google 帳號登入、老師後台彈性配組、題目跟著人走：node --test tests/students.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const tok = (email, name) => ({ idToken: 'test:' + email + '|' + (name || '') });
const msgs = (checks) => checks.map((c) => c.msg).join('\n');

// 開放加入，讓學生用 Google 帳號加入，回傳個人代碼
function joinStudent(env, email, name, school) {
  const jc = env.plain(env.gs.adminJoinCode(env.admin, 'peek')) || env.plain(env.gs.adminJoinCode(env.admin, 'new'));
  const r = env.plain(env.gs.studentJoin(tok(email), { name, school: school || '金城國中 701', joinCode: jc.toLowerCase() }));
  return r.me;
}
function groups(env, names) {
  env.gs.adminCreateGroups(env.admin, names.map((n) => ({ name: n })));
  const ov = env.plain(env.gs.adminOverview(env.admin));
  return names.map((n) => ov.rooms.filter((r) => r.groupName === n)[0]);
}
function myPuzzle(env, code, over) {
  const p = env.plain(env.gs.newPuzzle(code));
  return H.savePuzzle(env, code, p, H.fullPuzzle(over || {}));
}

test('Google 登入：第一次要加入碼，之後直接登入；驗證失敗會擋', () => {
  const env = H.load();
  // 還沒開放加入
  const first = env.plain(env.gs.studentLogin(tok('amy@gmail.com', 'Amy Wang')));
  assert.deepEqual(first, { needJoin: true, email: 'amy@gmail.com', name: 'Amy Wang', joinOpen: false });
  assert.throws(() => env.gs.studentJoin(tok('amy@gmail.com'), { name: '王小美', joinCode: 'ABCD' }), /還沒開放加入/);

  const jc = env.gs.adminJoinCode(env.admin, 'new');
  assert.match(jc, /^[A-Z2-9]{4}$/);
  assert.throws(() => env.gs.studentJoin(tok('amy@gmail.com'), { name: '王小美', joinCode: 'ZZZZ' }), /加入碼不正確/);
  assert.throws(() => env.gs.studentJoin(tok('amy@gmail.com'), { name: ' ', joinCode: jc }), /請填姓名/);
  const me = env.plain(env.gs.studentJoin(tok('Amy@Gmail.com'), { name: '王小美', school: '金寧國中 801', joinCode: jc.toLowerCase() })).me;
  assert.equal(me.role, 'student');
  assert.match(me.code, /^S[A-Z2-9]{5}$/);
  assert.equal(me.name, '王小美');
  assert.equal(me.school, '金寧國中 801');
  assert.equal(me.email, 'amy@gmail.com');

  // 第二次：直接登入；再按一次加入也不會多一個帳號
  const again = env.plain(env.gs.studentLogin(tok('amy@gmail.com')));
  assert.equal(again.me.code, me.code);
  assert.equal(env.plain(env.gs.studentJoin(tok('amy@gmail.com'), { name: 'x', joinCode: jc })).me.code, me.code);
  assert.equal(env.plain(env.gs.adminOverview(env.admin)).students.length, 1);
  // 個人代碼也能登入（備援）
  assert.equal(env.plain(env.gs.login(me.code)).name, '王小美');

  // 假憑證、空憑證都擋
  assert.throws(() => env.gs.studentLogin({ idToken: 'forged' }), /Google 登入驗證失敗/);
  assert.throws(() => env.gs.studentLogin({}), /Google 登入驗證失敗/);
  // 關閉加入後，新學生進不來，已加入的照常登入
  env.gs.adminJoinCode(env.admin, 'close');
  assert.throws(() => env.gs.studentJoin(tok('bob@gmail.com'), { name: '李大寶', joinCode: jc }), /還沒開放加入/);
  assert.equal(env.plain(env.gs.studentLogin(tok('amy@gmail.com'))).me.code, me.code);
});

test('Firebase 那條路不通時，改用 Google 憑證驗證（專案編號要對）', () => {
  const env = H.load();
  env.mock.fetchOpts.firebaseDown = true;
  const r = env.plain(env.gs.studentLogin({ idToken: 'test:a@b.c', googleIdToken: 'gtest:cat@gmail.com|Cat' }));
  assert.equal(r.email, 'cat@gmail.com');
  assert.throws(() => env.gs.studentLogin({ idToken: 'test:a@b.c' }), /API_KEY_HTTP_REFERRER_BLOCKED/);
  // 送到 Firebase 的請求帶著網站來源（apiKey 若有限制網站也能通過）
  const call = env.mock.fetches.filter((f) => f.url.includes('identitytoolkit'))[0];
  assert.equal(call.opts.headers.Referer, 'https://huangisright.github.io/');
});

test('老師建的個人代碼：學生之後可以綁到自己的 Google 帳號', () => {
  const env = H.load();
  const [s] = env.plain(env.gs.adminCreateStudents(env.admin, [{ name: '陳外校', school: '金湖國中' }, { name: '' }]));
  assert.match(s.code, /^S/);
  assert.equal(env.plain(env.gs.adminOverview(env.admin)).students.length, 1);
  assert.throws(() => env.gs.studentJoin(tok('chen@gmail.com'), { personalCode: 'SNOPE1' }), /個人代碼不正確/);
  const me = env.plain(env.gs.studentJoin(tok('chen@gmail.com'), { personalCode: s.code.toLowerCase() })).me;
  assert.equal(me.code, s.code);
  assert.equal(env.plain(env.gs.studentLogin(tok('chen@gmail.com'))).me.code, s.code);
  assert.throws(() => env.gs.studentJoin(tok('other@gmail.com'), { personalCode: s.code }), /已經綁定別的 Google 帳號/);
  // 老師可以解除綁定（學生換帳號）
  env.gs.adminUpdateStudent(env.admin, s.code, { clearEmail: true });
  assert.equal(env.plain(env.gs.studentJoin(tok('other@gmail.com'), { personalCode: s.code })).me.code, s.code);
});

test('還沒分組也能出題；分組後題目自動帶進組，組員看得到但只能改自己的', () => {
  const env = H.load();
  const amy = joinStudent(env, 'amy@gmail.com', '王小美');
  const bob = joinStudent(env, 'bob@gmail.com', '李大寶');
  const p1 = myPuzzle(env, amy.code, { title: '小美的題' });
  assert.equal(p1.author, '王小美', '設計者固定是本人');
  assert.equal(p1.roomId, '');
  const p1b = H.savePuzzle(env, amy.code, p1, { author: '別人' });
  assert.equal(p1b.author, '王小美', '學生改不了署名');
  myPuzzle(env, bob.code, { title: '大寶的題', kind: 'physical' });

  let ws = env.plain(env.gs.getWorkspace(amy.code));
  assert.equal(ws.student, true);
  assert.equal(ws.room, null);
  assert.deepEqual(ws.puzzles.map((p) => p.title), ['小美的題'], '還沒分組時只看到自己的');
  assert.throws(() => env.gs.getPuzzle(amy.code, env.plain(env.gs.getWorkspace(bob.code)).puzzles[0].id), /找不到題目/);
  assert.throws(() => env.gs.submitRoom(amy.code), /還沒分組/);
  assert.throws(() => env.gs.startTestPlay(amy.code, ''), /還沒分組/);

  const [g1] = groups(env, ['第一組']);
  const r1 = env.plain(env.gs.adminAssignStudent(env.admin, amy.code, g1.id));
  assert.equal(r1.moved, 1);
  env.gs.adminAssignStudent(env.admin, bob.code, g1.id);

  ws = env.plain(env.gs.getWorkspace(amy.code));
  assert.equal(ws.room.id, g1.id);
  assert.deepEqual(ws.puzzles.map((p) => p.title), ['小美的題', '大寶的題']);
  assert.deepEqual(ws.puzzles.map((p) => p.editable), [true, false]);
  assert.deepEqual(ws.members, ['王小美', '李大寶']);
  assert.equal(ws.isLeader, true, '第一個分進來的人自動當組長');
  assert.equal(ws.leaderName, '王小美');
  const bobId = ws.puzzles[1].id;
  assert.equal(env.plain(env.gs.getPuzzle(amy.code, bobId)).editable, false, '組員可以看別人的題目');
  assert.throws(() => env.gs.savePuzzle(amy.code, { id: bobId, rev: 1, title: 'x' }), /只能修改自己的題目/);
  assert.throws(() => env.gs.deletePuzzle(amy.code, bobId), /不能刪除/);
  assert.equal(env.plain(env.gs.login(bob.code)).members.join(','), '王小美,李大寶');

  // 分組後新出的題目直接進這一組
  const p3 = env.plain(env.gs.newPuzzle(bob.code));
  assert.equal(p3.roomId, g1.id);
  assert.equal(env.plain(env.gs.getWorkspace(bob.code)).puzzles.length, 3);
  // 組員的每人題數檢核照名字算
  env.gs.deletePuzzle(bob.code, p3.id);
});

test('組長：密室資訊、排序、送審只有組長能做；老師可以換組長', () => {
  const env = H.load();
  const amy = joinStudent(env, 'amy@gmail.com', '王小美');
  const bob = joinStudent(env, 'bob@gmail.com', '李大寶');
  const [g1] = groups(env, ['第一組']);
  env.gs.adminAssignStudent(env.admin, amy.code, g1.id);
  env.gs.adminAssignStudent(env.admin, bob.code, g1.id);
  myPuzzle(env, amy.code, { title: 'A' });
  myPuzzle(env, bob.code, { title: 'B', kind: 'physical' });

  const room = env.plain(env.gs.getRoom(bob.code, 'whatever'));
  assert.equal(room.id, g1.id);
  assert.equal(room.editable, false, '組員打開密室資訊是唯讀');
  assert.throws(() => env.gs.saveRoom(bob.code, { id: g1.id, rev: room.rev, title: 'x' }), /由組長負責/);
  const ids = env.plain(env.gs.getWorkspace(amy.code)).puzzles.map((p) => p.id);
  assert.throws(() => env.gs.movePuzzle(bob.code, ids[0], 1), /由組長調整/);
  assert.equal(env.plain(env.gs.getRoom(amy.code, '')).editable, true);
  H.fillRoomPages(env, amy.code, g1.id);
  const r = env.plain(env.gs.getRoom(amy.code, ''));
  env.gs.saveRoom(amy.code, { id: g1.id, rev: r.rev, mindmap: { fileId: '', url: 'https://gitmind.com/x' } });
  assert.deepEqual(env.plain(env.gs.movePuzzle(amy.code, ids[0], 1)), [ids[1], ids[0]]);

  // 組長上傳故事頁圖片
  const up = env.plain(env.gs.uploadFile(amy.code, { roomId: 'ignored', label: '說明頁 1', name: 'story.png', mime: 'image/png' }, 'iVBORw0KGgo=', false));
  assert.ok(up.fileId);
  assert.ok(env.plain(env.gs.getFileData(bob.code, up.fileId)).dataUrl, '組員看得到組長上傳的圖');

  assert.throws(() => env.gs.submitRoom(bob.code), /送審由組長負責/);
  const sub = env.plain(env.gs.submitRoom(amy.code));
  assert.equal(sub.ok, true, msgs(sub.roomChecks));
  assert.throws(() => env.gs.savePuzzle(amy.code, { id: ids[0], rev: 1, title: 'x' }), /已送審/);
  assert.throws(() => env.gs.newPuzzle(bob.code), /已送審/);
  env.gs.adminRoomAction(env.admin, g1.id, 'unlock');

  // 換組長
  assert.throws(() => env.gs.adminSetLeader(env.admin, g1.id, 'SXXXXX'), /不在這一組/);
  env.gs.adminSetLeader(env.admin, g1.id, bob.code);
  assert.equal(env.plain(env.gs.getWorkspace(bob.code)).isLeader, true);
  assert.equal(env.plain(env.gs.getWorkspace(amy.code)).isLeader, false);
  // 試玩整間：組員都可以
  const intro = env.plain(env.gs.startTestPlay(amy.code, 'other'));
  assert.ok(intro.playId);
});

test('換組：題目跟著人走（含圖檔權限），組長空出來自動補上；也可以選題目留在原組', () => {
  const env = H.load();
  const amy = joinStudent(env, 'amy@gmail.com', '王小美');
  const bob = joinStudent(env, 'bob@gmail.com', '李大寶');
  const cat = joinStudent(env, 'cat@gmail.com', '張小貓');
  const [g1, g2] = groups(env, ['第一組', '第二組']);
  [amy, bob].forEach((s) => env.gs.adminAssignStudent(env.admin, s.code, g1.id));
  env.gs.adminAssignStudent(env.admin, cat.code, g2.id);
  const pa = myPuzzle(env, amy.code, { title: '小美的題' });
  const img = env.plain(env.gs.uploadFile(amy.code, { puzzleId: pa.id, label: '圖', name: 'a.png', mime: 'image/png' }, 'iVBORw0KGgo=', false));
  myPuzzle(env, bob.code, { title: '大寶的題' });
  // 老師設了關卡地點
  env.gs.adminSetRoomPlaces(env.admin, g1.id, { [pa.id]: '圖書館' });

  // 第二天小美被移到第二組：題目跟著走，第一組的組長換成大寶
  const mv = env.plain(env.gs.adminAssignStudent(env.admin, amy.code, g2.id));
  assert.equal(mv.moved, 1);
  const ov = env.plain(env.gs.adminOverview(env.admin));
  const R = (id) => ov.rooms.filter((r) => r.id === id)[0];
  assert.deepEqual(R(g1.id).puzzleList.map((p) => p.title), ['大寶的題']);
  assert.deepEqual(R(g2.id).puzzleList.map((p) => p.title), ['小美的題']);
  assert.equal(R(g1.id).leaderCode, bob.code);
  assert.equal(R(g2.id).leaderCode, cat.code, '新組原本的組長不變');
  assert.deepEqual(R(g1.id).places || {}, {}, '移走的題目地點一起清掉');
  assert.deepEqual(R(g2.id).members, ['王小美', '張小貓']);
  assert.equal(ov.students.filter((s) => s.code === amy.code)[0].puzzles, 1);
  // 小美在新組照樣能改自己的題，新組員看得到她之前上傳的圖，舊組員看不到了
  H.savePuzzle(env, amy.code, env.plain(env.gs.getPuzzle(amy.code, pa.id)), { title: '小美的題 v2' });
  assert.ok(env.plain(env.gs.getFileData(cat.code, img.fileId)).dataUrl);
  assert.throws(() => env.gs.getFileData(bob.code, img.fileId), /沒有權限/);

  // 送審過的組：題目移不出來，除非勾「題目留在原組」
  H.fillRoomPages(env, cat.code, g2.id);
  const r2 = env.plain(env.gs.getRoom(cat.code, ''));
  env.gs.saveRoom(cat.code, { id: g2.id, rev: r2.rev, mindmap: { fileId: '', url: 'https://x' } });
  myPuzzle(env, cat.code, { title: '小貓的題', kind: 'physical' });
  const sub = env.plain(env.gs.submitRoom(cat.code));
  assert.equal(sub.ok, true, msgs(sub.roomChecks));
  assert.throws(() => env.gs.adminAssignStudent(env.admin, amy.code, g1.id), /已送審，題目移不出來/);
  const keep = env.plain(env.gs.adminAssignStudent(env.admin, amy.code, g1.id, { keepPuzzles: true }));
  assert.equal(keep.moved, 0);
  const ws = env.plain(env.gs.getWorkspace(amy.code));
  assert.equal(ws.room.id, g1.id);
  assert.deepEqual(ws.puzzles.map((p) => p.title), ['大寶的題'], '她的題目留在第二組');
  assert.throws(() => env.gs.savePuzzle(amy.code, { id: pa.id, rev: 2, title: 'x' }), /已送審|只能修改自己的題目/);

  // 移回未分組：沒題目跟著走的時候也能移
  env.gs.adminAssignStudent(env.admin, bob.code, '');
  const ws2 = env.plain(env.gs.getWorkspace(bob.code));
  assert.equal(ws2.room, null);
  assert.deepEqual(ws2.puzzles.map((p) => p.title), ['大寶的題']);
  assert.equal(env.plain(env.gs.adminOverview(env.admin)).rooms.filter((r) => r.id === g1.id)[0].leaderCode, amy.code);
  assert.throws(() => env.gs.adminAssignStudent(env.admin, bob.code, 'rNOPE'), /找不到這一組/);
});

test('改名同步署名；有題目的學生不能刪；刪空組會讓組員回到未分組', () => {
  const env = H.load();
  const amy = joinStudent(env, 'amy@gmail.com', '王小美');
  const dup = joinStudent(env, 'amy2@gmail.com', '王小美');
  const [g1, g2] = groups(env, ['第一組', '空組']);
  env.gs.adminAssignStudent(env.admin, amy.code, g1.id);
  const p = myPuzzle(env, amy.code);
  env.gs.adminUpdateStudent(env.admin, amy.code, { name: '王曉美', school: '金城 702' });
  assert.equal(env.plain(env.gs.getPuzzle(amy.code, p.id)).author, '王曉美');
  assert.throws(() => env.gs.adminDeleteStudent(env.admin, amy.code), /還有 1 題/);
  env.gs.adminAssignStudent(env.admin, dup.code, g2.id);
  env.gs.adminDeleteGroups(env.admin, [env.plain(env.gs.adminOverview(env.admin)).codes.filter((c) => c.name === '空組')[0].code]);
  assert.equal(env.plain(env.gs.adminOverview(env.admin)).students.filter((s) => s.code === dup.code)[0].roomId, '');
  env.gs.adminDeleteStudent(env.admin, dup.code);
  assert.throws(() => env.gs.login(dup.code), /代碼不正確/);
  const ov = env.plain(env.gs.adminOverview(env.admin));
  assert.equal(ov.students.length, 1);
  assert.ok(!ov.codes.some((c) => c.role === 'student'), '學生不出現在分組／老師代碼表');
  // 學生不能叫管理功能
  assert.throws(() => env.gs.adminAssignStudent(amy.code, amy.code, ''), /沒有權限/);
  assert.throws(() => env.gs.adminJoinCode(amy.code, 'new'), /沒有權限/);
});

test('API 開放了學生登入與配組的函式', () => {
  const env = H.load();
  const call = (fn, args) => JSON.parse(env.gs.doPost({ postData: { contents: JSON.stringify({ fn, args }) } }).getContent());
  assert.equal(call('studentLogin', [tok('z@z.z')]).result.needJoin, true);
  assert.equal(call('adminJoinCode', [env.admin, 'new']).ok, true);
  assert.equal(call('verifyGoogle_', [tok('z@z.z')]).ok, false);
});

test('組員只算登入的學生：分組代碼上以前手打的名字不列入，存檔時清掉', () => {
  const env = H.load();
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: '第一組', members: '預打甲、預打乙' }]))[0];
  const ov0 = env.plain(env.gs.adminOverview(env.admin));
  assert.equal(ov0.codes.filter((c) => c.code === g.code)[0].members, '', '新建組別不再存手打組員');
  const room = ov0.rooms.filter((r) => r.groupName === '第一組')[0];
  // 模擬舊資料：試算表裡還留著手打的名字
  const row = env.gs.readAll_('Codes').filter((r) => r.code === g.code)[0];
  row.members = '預打甲,預打乙';
  env.gs.writeRow_('Codes', row._row, row);
  const [s1] = env.plain(env.gs.adminCreateStudents(env.admin, [{ name: '王小美' }]));
  env.gs.adminAssignStudent(env.admin, s1.code, room.id);
  assert.deepEqual(env.plain(env.gs.getWorkspace(s1.code)).members, ['王小美']);
  assert.deepEqual(env.plain(env.gs.login(g.code)).members, ['王小美'], '用分組代碼登入也只看到登入的學生');
  assert.deepEqual(env.plain(env.gs.adminOverview(env.admin)).rooms.filter((r) => r.id === room.id)[0].members, ['王小美']);
  // 管理者在「代碼」分頁按儲存：舊的手打名字一起清掉
  env.gs.adminUpdateCode(env.admin, g.code, { name: '第一組', members: '又打丙' });
  assert.equal(env.plain(env.gs.adminOverview(env.admin)).codes.filter((c) => c.code === g.code)[0].members, '');
});
