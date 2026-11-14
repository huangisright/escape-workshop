// 答對中途答案後才出現的區塊、道具列印檔：node --test tests/reveal-print.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const msgs = (checks) => checks.map((c) => c.msg).join('\n');

function twoStepPuzzle(env, t, over) {
  const p = env.plain(env.gs.newPuzzle(t.code));
  const img = env.plain(env.gs.uploadFile(t.code, { puzzleId: p.id, label: '圖片', name: 'map2.png', mime: 'image/png' }, 'AAECAw==', false));
  return H.savePuzzle(env, t.code, p, H.fullPuzzle(Object.assign({
    steps: [
      { get: '第一張圖', act: '找年份', result: '年份', checkpoint: '2050' },
      { get: '第二張圖', act: '換字', result: '密碼', checkpoint: '' }
    ],
    blocks: [
      { type: 'text', text: '先看第一張圖' },
      { type: 'image', fileId: img.fileId, caption: '第二張圖', after: 1 }
    ],
    answer: 'OCEAN'
  }, over || {})));
}

test('區塊設成第 1 步答對後才出現：狀態與離線包都帶 after，檢核會擋錯誤設定', () => {
  const env = H.load();
  const t = env.plain(env.gs.adminCreateTeachers(env.admin, ['林老師']))[0];
  const p = twoStepPuzzle(env, t);
  assert.ok(!p.checks.some((c) => c.level === 'err'), msgs(p.checks));

  // 設在沒有中途答案的步驟
  const bad = H.savePuzzle(env, t.code, p, { blocks: [p.blocks[0], Object.assign({}, p.blocks[1], { after: 2 })] });
  assert.match(msgs(bad.checks), /第 2 步還沒填中途答案/);
  const bad2 = H.savePuzzle(env, t.code, bad, { blocks: [p.blocks[0], Object.assign({}, p.blocks[1], { after: 5 })] });
  assert.match(msgs(bad2.checks), /沒有第 5 步/);
  const bad3 = H.savePuzzle(env, t.code, bad2, { blocks: [Object.assign({}, p.blocks[1], { after: 1 })] });
  assert.match(msgs(bad3.checks), /玩家一開始會看不到題目/);
  H.savePuzzle(env, t.code, bad3, { blocks: p.blocks });

  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '密室'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, [p.id]);
  H.fillRoomPages(env, env.admin, room.id);
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  const play = H.startPlay(env, pub.playCode);
  assert.equal(play.st.gate, 0);
  assert.equal(play.st.blocks[0].after, undefined, '一開始就出現的區塊沒有 after');
  assert.equal(play.st.blocks[1].after, 1, '第二張圖要過 1 道關卡');

  const bundle = env.plain(env.gs.playBundle(play.id));
  assert.equal(bundle.puzzles[0].blocks[1].after, 1, '斷線時也知道什麼時候出現');

  const r = env.plain(env.gs.playAnswer(play.id, '2050'));
  assert.equal(r.gatePassed, true);
  assert.equal(r.state.gate, 1);

  env.gs.adminExport(env.admin, room.id, 'room');
  const html = Object.values(env.mock.files).find((f) => /整間密室\.html$/.test(f.name)).blob.getDataAsString();
  assert.match(html, /"after":1/);
  assert.match(html, /if\(\(b\.after\|\|0\)>S\.g\)return;/);
});

test('步驟中間有沒填中途答案的步驟時，after 換算成實際要過的關卡數', () => {
  const env = H.load();
  const t = env.plain(env.gs.adminCreateTeachers(env.admin, ['林老師']))[0];
  const p = twoStepPuzzle(env, t, {
    steps: [
      { get: 'a', act: 'b', result: 'c', checkpoint: '' },
      { get: 'a', act: 'b', result: '年份', checkpoint: '2050' },
      { get: 'a', act: 'b', result: '密碼', checkpoint: '' }
    ]
  });
  const blocks = p.blocks.map((b, i) => (i === 1 ? Object.assign({}, b, { after: 2 }) : b));
  const s = H.savePuzzle(env, t.code, p, { blocks });
  assert.ok(!s.checks.some((c) => c.level === 'err'), msgs(s.checks));
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '密室'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, [p.id]);
  H.fillRoomPages(env, env.admin, room.id);
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  const play = H.startPlay(env, pub.playCode);
  assert.equal(play.st.gateCount, 2);
  assert.equal(play.st.blocks[1].after, 1, '第 2 步是第 1 道關卡');
});

test('道具列印檔：原檔上傳、存在謎題卡、材料清單拿得到、同組也能看', () => {
  const env = H.load();
  const g = env.plain(env.gs.adminCreateGroups(env.admin, [{ name: '第一組', members: '甲' }]))[0];
  const p = env.plain(env.gs.newPuzzle(g.code));
  const pdf = env.plain(env.gs.uploadFile(g.code, { puzzleId: p.id, label: '列印檔-地圖', name: '地圖.pdf', mime: 'application/pdf' }, 'JVBERi0=', false));
  assert.equal(pdf.mime, 'application/pdf');
  assert.match(pdf.name, /列印檔-地圖/);
  const s = H.savePuzzle(env, g.code, p, H.fullPuzzle({
    author: '甲', kind: 'physical',
    props: [{ item: '藏寶圖', place: '講桌', fileId: pdf.fileId, fileName: '地圖.pdf', fileMime: 'application/pdf' }]
  }));
  assert.equal(s.props[0].fileId, pdf.fileId);

  const mats = env.plain(env.gs.adminMaterials(env.admin));
  assert.equal(mats[0].puzzles[0].props[0].fileId, pdf.fileId);
  const d = env.plain(env.gs.getFileData(env.admin, pdf.fileId));
  assert.match(d.dataUrl, /^data:application\/pdf;base64,/);
  // 同組看得到
  assert.match(env.plain(env.gs.getFileData(g.code, pdf.fileId)).dataUrl, /^data:application\/pdf/);
});
