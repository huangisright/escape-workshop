// platform/tests/helpers.js — 建立測試資料的捷徑
const { load } = require('./load');

function fullPuzzle(over) {
  return Object.assign({
    title: '題目', kind: 'digital', estMinutes: 5,
    steps: [
      { get: '一張地圖', act: '找出年份', result: '年份', checkpoint: '' },
      { get: '年份', act: '換成密碼', result: '密碼', checkpoint: '' }
    ],
    blocks: [{ type: 'text', text: '看圖找答案' }],
    answer: 'ANSWER',
    hints: [{ text: '看左上角', delaySec: 0 }],
    props: [], themeLink: '海平面上升', scienceBasis: 'IPCC AR6', reskinCheck: '拿掉主題後解法不變，需要再改'
  }, over || {});
}

function savePuzzle(env, code, p, data) {
  const out = env.gs.savePuzzle(code, Object.assign({ id: p.id, rev: p.rev || 0 }, data));
  if (out.conflict) throw new Error('unexpected conflict');
  return env.plain(out.puzzle);
}

// 一位老師出好 n 題，回傳 { teacher, puzzles }
function teacherWithPuzzles(env, answers) {
  const t = env.plain(env.gs.adminCreateTeachers(env.admin, ['林老師']))[0];
  const puzzles = answers.map((ans, i) => {
    const p = env.plain(env.gs.newPuzzle(t.code));
    const over = typeof ans === 'object' ? ans : { answer: ans };
    return savePuzzle(env, t.code, p, fullPuzzle(Object.assign({ title: '第' + (i + 1) + '題' }, over)));
  });
  return { teacher: t, puzzles };
}

function fillRoomPages(env, code, roomId) {
  const room = env.plain(env.gs.getRoom(code, roomId));
  return env.plain(env.gs.saveRoom(code, {
    id: roomId, rev: room.rev || 0,
    cover: { text: '黃金城', imageId: '' },
    story: [{ text: '海水上漲了', imageId: '' }],
    success: { text: '逃出來了', imageId: '' },
    fail: { text: '城沉了', imageId: '' }
  }));
}

// 示範密室：題庫挑題、填好頁面、發布
function publishedTeacherRoom(env, answers, extra) {
  const { puzzles } = teacherWithPuzzles(env, answers);
  const room = env.plain(env.gs.adminCreateTeacherRoom(env.admin, '氣候變遷密室'));
  env.gs.adminSetRoomPuzzles(env.admin, room.id, puzzles.map((p) => p.id), extra && extra.assemble);
  fillRoomPages(env, env.admin, room.id);
  if (extra && extra.room) {
    const r = env.plain(env.gs.getRoom(env.admin, room.id));
    env.gs.saveRoom(env.admin, Object.assign({ id: room.id, rev: r.rev }, extra.room));
  }
  const pub = env.plain(env.gs.adminRoomAction(env.admin, room.id, 'publish'));
  return { room: pub, puzzles };
}

function startPlay(env, playCode, team) {
  const intro = env.plain(env.gs.playStart(playCode, team || '第一隊'));
  const st = env.plain(env.gs.playBegin(intro.playId));
  return { intro, st, id: intro.playId };
}

module.exports = { load, fullPuzzle, savePuzzle, teacherWithPuzzles, fillRoomPages, publishedTeacherRoom, startPlay };
