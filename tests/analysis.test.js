// tests/analysis.test.js — 自動警示、AI 分析包匯出／匯入
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

// 示範密室兩題：第 1 題答案「2050年」，第 2 題 ONE。n 組來玩：第 1 題都先答成「2050」再答對
function playedRoom(n) {
  const env = H.load();
  const { room, puzzles } = H.publishedTeacherRoom(env, ['2050年', 'ONE']);
  for (let i = 0; i < n; i++) {
    const { id } = H.startPlay(env, room.playCode, '第' + (i + 1) + '隊');
    env.gs.playAnswer(id, '2050');
    env.advance(11);
    env.gs.playAnswer(id, '2050年');
    env.advance(30);
    env.gs.playAnswer(id, 'ONE');
    env.gs.playRate(id, [{ id: puzzles[0].id, rating: 3 }], i === 0 ? '林老師的題目很好玩' : '', '');
  }
  return { env, room, puzzles };
}

test('自動警示：多組答成跟答案很接近的錯誤答案 → 答案格式警示', () => {
  const { env, room } = playedRoom(3);
  const d = env.plain(env.gs.adminStats(env.admin, room.id));
  const p1 = d.perPuzzle[0];
  assert.equal(p1.wrongPatterns[0].teams, 3);
  assert.equal(p1.wrongPatterns[0].nearAnswer, true);
  assert.ok(p1.flags.some((f) => f.code === 'format' && f.level === 'err'), JSON.stringify(p1.flags));
  assert.ok(d.roomFlags.some((f) => f.code === 'fixFirst' && /2050|第1題/.test(f.msg)));
  assert.equal(d.analysis, null);
  // 原本的欄位不變
  assert.deepEqual(p1.topWrong, [{ answer: '2050', count: 3 }]);
});

test('自動警示：組數太少不下判斷', () => {
  const { env, room } = playedRoom(1);
  const d = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.deepEqual(d.perPuzzle[0].flags.map((f) => f.code), ['few']);
  assert.equal(d.roomFlags[0].code, 'few');
});

test('分析包：含指示、輸出格式與統計，名字換成代號', () => {
  const { env, room } = playedRoom(3);
  const out = env.plain(env.gs.adminAnalysisPack(env.admin, room.id));
  const pack = out.pack;
  assert.match(out.fileName, /^分析包-.*\.json$/);
  assert.equal(pack.format, 'escape-workshop-analysis-pack');
  assert.ok(pack.packId);
  assert.match(pack.instructions, /只回傳 JSON/);
  assert.equal(pack.outputFormat.packId, pack.packId);
  assert.deepEqual(pack.puzzles.map((p) => p.key), ['P1', 'P2']);
  assert.equal(pack.puzzles[0].designer, '〔設計者1〕');
  assert.equal(pack.puzzles[0].answer, '2050年');
  assert.equal(pack.puzzles[0].stats.reached, 3);
  assert.equal(pack.puzzles[0].wrongPatterns[0].teams, 3);
  assert.equal(pack.puzzles[0].knowledgeBasis, 'IPCC AR6');
  assert.ok(pack.puzzles[0].ruleFlags.length);
  assert.deepEqual(pack.feedback, ['最喜歡：〔設計者1〕的題目很好玩']);
  assert.ok(!JSON.stringify(pack).includes('林老師'), '真名不能出現在分析包裡');
});

function result(packId, over) {
  return Object.assign({
    format: 'escape-workshop-analysis-result', packId, model: 'Gemini Flash',
    room: { summary: '整體不錯', strengths: ['主題清楚'], priorities: [{ key: 'p1', reason: '答案格式' }], flow: '順', timeLimit: '剛好' },
    puzzles: [
      { key: 'P1', verdict: '要修', problems: ['3 組答成 2050'], causes: ['沒說要加「年」'], suggestions: ['題目註明答案要含單位'], toDesigner: '〔設計者1〕題目很棒，記得說清楚答案格式' },
      { key: 'P2', verdict: 'good', problems: [], causes: [], suggestions: '不用改', toDesigner: '設計者1 做得好' }
    ]
  }, over || {});
}

test('匯入：容許前後說明文字與 ``` 包裝，代號換回真名，存起來數據頁看得到', () => {
  const { env, room } = playedRoom(3);
  const { pack } = env.plain(env.gs.adminAnalysisPack(env.admin, room.id));
  const text = '好的，以下是分析結果：\n```json\n' + JSON.stringify(result(pack.packId), null, 2) + '\n```\n希望有幫助！';
  const r = env.plain(env.gs.adminAnalysisImport(env.admin, room.id, text));
  assert.deepEqual(r.warnings, []);
  const a = r.analysis.result;
  assert.equal(a.model, 'Gemini Flash');
  assert.equal(a.puzzles[0].verdict, 'fix', '中文判斷轉成代碼');
  assert.equal(a.puzzles[0].toDesigner, '林老師題目很棒，記得說清楚答案格式');
  assert.equal(a.puzzles[1].toDesigner, '林老師 做得好', '括號被 AI 弄掉也換得回來');
  assert.deepEqual(a.puzzles[1].suggestions, ['不用改'], '字串自動變成陣列');
  assert.deepEqual(a.room.priorities, [{ key: 'P1', reason: '答案格式' }]);
  const d = env.plain(env.gs.adminStats(env.admin, room.id));
  assert.equal(d.analysis.result.puzzles.length, 2);
  assert.equal(d.analysis.playsAtExport, 3);
});

test('匯入：缺題、多題、看不懂的判斷列成提醒，照樣收下', () => {
  const { env, room } = playedRoom(3);
  const { pack } = env.plain(env.gs.adminAnalysisPack(env.admin, room.id));
  const obj = result(pack.packId, {
    puzzles: [{ key: 'P1', verdict: 'meh' }, { key: 'P9', verdict: 'good' }, { key: 'P1', verdict: 'good' }],
    room: undefined
  });
  const r = env.plain(env.gs.adminAnalysisImport(env.admin, room.id, JSON.stringify(obj) + ','));
  assert.equal(r.analysis.result.puzzles.length, 1);
  assert.equal(r.analysis.result.puzzles[0].verdict, 'adjust');
  const w = r.warnings.join('\n');
  assert.match(w, /P9/);
  assert.match(w, /出現兩次/);
  assert.match(w, /少了這幾題的分析：P2/);
  assert.match(w, /總評/);
});

test('匯入：明確的錯誤訊息', () => {
  const { env, room } = playedRoom(3);
  const { pack } = env.plain(env.gs.adminAnalysisPack(env.admin, room.id));
  const imp = (t) => () => env.gs.adminAnalysisImport(env.admin, room.id, t);
  assert.throws(imp('抱歉我無法完成'), /找不到 JSON/);
  assert.throws(imp(JSON.stringify(pack)), /這是分析包本身/);
  assert.throws(imp(JSON.stringify(result('pkWRONG'))), /找不到這份結果對應的分析包/);
  assert.throws(imp(JSON.stringify(result(pack.packId, { puzzles: [{ key: 'X1' }] }))), /沒有任何一題對得上/);
  assert.throws(imp(JSON.stringify({ packId: pack.packId })), /沒有 puzzles/);
  // 別間密室
  const other = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '另一間'));
  assert.throws(() => env.gs.adminAnalysisImport(env.admin, other.id, JSON.stringify(result(pack.packId))), /別間密室/);
});

test('分析包與匯入只有管理者能用', () => {
  const { env, room } = playedRoom(1);
  const tcode = env.plain(env.gs.adminOverview(env.admin)).codes.find((c) => c.role === 'teacher').code;
  assert.throws(() => env.gs.adminAnalysisPack(tcode, room.id));
  assert.throws(() => env.gs.adminAnalysisImport(tcode, room.id, '{}'));
});
