// 執行：node --test platform/tests/engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const MIN = 60 * 1000;

function q(id, extra) {
  return Object.assign({ id, type: '數字', story: id, image: '', answer: '12345', hint: 'h-' + id, success: 'ok-' + id, estMin: 14, difficulty: '中' }, extra);
}

function content() {
  return {
    id: 't', title: 'T',
    settings: { timeLimitMin: 90, skipPenaltyMin: 5 },
    prologue: 'P',
    main: [q('m1', { fragment: '7' }), q('m2', { fragment: '3', type: '方向', answer: '上上右下' }), q('m3', { fragment: '1' })],
    finale: { story: 'F', type: '數字', answer: '', hint: 'fh', success: 'win' },
    vault: [q('v1', { answer: '71' }), q('v2', { type: '文字', answer: '甲烷|CH4' })]
  };
}

test('answers ignore width, spaces and case but not punctuation', () => {
  assert.ok(Engine.checkAnswer('４２', '42|四十二', '數字'));
  assert.ok(Engine.checkAnswer('四十二', '42｜四十二', '文字'));
  assert.ok(Engine.checkAnswer(' c h4 ', '甲烷|CH4', '文字'));
  assert.ok(Engine.checkAnswer('ＣＨ４', '甲烷|CH4', '文字'));
  assert.ok(!Engine.checkAnswer('31', '3-1', '文字'));
  assert.ok(Engine.checkAnswer('↑↑→↓', '上上右下', '方向'));
  assert.ok(!Engine.checkAnswer('', '', '文字'));
});

test('validateRow reports missing fields, bad formats and short numbers', () => {
  const ok = { order: '1', theme: '海平面上升', type: '數字', story: 's', answer: '2050|２０５０', hint: 'h', success: 'y', estMin: '14', difficulty: '中', source: 'IPCC', reskin: '會變' };
  assert.deepEqual(Engine.validateRow(ok), { errors: [], warnings: [] });

  const r1 = Engine.validateRow(Object.assign({}, ok, { answer: 'abc' }));
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0], /不符合密碼類型/);

  assert.match(Engine.validateRow(Object.assign({}, ok, { answer: '42' })).warnings[0], /猜/);
  assert.match(Engine.validateRow(Object.assign({}, ok, { hint: ' ' })).errors[0], /提示/);
  assert.match(Engine.validateRow(Object.assign({}, ok, { type: '方向', answer: '上下X' })).errors[0], /方向/);
  assert.equal(Engine.validateRow(Object.assign({}, ok, { type: '顏色', answer: '紅綠藍' })).errors.length, 0);
  assert.match(Engine.validateRow(Object.assign({}, ok, { difficulty: '超難' })).errors[0], /難度/);
  assert.match(Engine.validateRow(Object.assign({}, ok, { estMin: '0' })).errors[0], /預估時間/);
});

test('full run: main → finale → vault, escape time includes skip penalty', () => {
  const c = content();
  let t = 0;
  let s = Engine.newState('A1', t);
  const step = (action, dt) => { t += dt || 0; const out = Engine.apply(s, c, action, t); s = out.state; return out.result; };

  step({ type: 'begin' }, MIN);
  assert.equal(s.phase, 'main');

  assert.equal(step({ type: 'answer', text: '00000' }).correct, false);
  assert.equal(s.wrong, 1);
  const r = step({ type: 'answer', text: '12345' }, MIN);
  assert.equal(r.correct, true);
  assert.equal(r.fragment, '7');

  step({ type: 'hint' });
  step({ type: 'hint' });
  assert.equal(s.hintsUsed.length, 1, 'same question counts once');
  assert.equal(Engine.view(s, c, t).question.hint, 'h-m2');

  const sk = step({ type: 'skip' });
  assert.equal(sk.fragment, '3');
  assert.equal(s.penaltyMs, 5 * MIN);

  step({ type: 'answer', text: '12345' }, MIN);
  assert.equal(s.phase, 'finale');
  assert.deepEqual(s.fragments, ['7', '3', '1']);
  assert.equal(step({ type: 'skip' }).ok, false, 'finale cannot be skipped');

  const fin = step({ type: 'answer', text: '731' }, MIN);
  assert.equal(fin.escaped, true);
  assert.equal(s.phase, 'vault');
  assert.equal(Engine.view(s, c, t).escapeTimeMs, 4 * MIN + 5 * MIN);

  step({ type: 'skip' });
  assert.equal(s.vaultSolved, 0);
  step({ type: 'answer', text: 'ch4' });
  assert.equal(s.vaultSolved, 1);
  assert.equal(s.phase, 'done');
  assert.ok(Engine.isOver(s, c, t));
});

test('time limit is hard and skip penalty shortens it', () => {
  const c = content();
  let s = Engine.newState('B', 0);
  s = Engine.apply(s, c, { type: 'begin' }, 0).state;
  s = Engine.apply(s, c, { type: 'skip' }, 1000).state;
  assert.equal(Engine.deadline(s, c), 85 * MIN);
  const late = Engine.apply(s, c, { type: 'answer', text: '上上右下' }, 85 * MIN);
  assert.equal(late.result.ok, false);
  assert.equal(late.state.index, 1, 'no progress after time is up');
  assert.equal(Engine.view(s, c, 85 * MIN).over, true);
});

test('view never leaks answers', () => {
  const c = content();
  let s = Engine.newState('C', 0);
  s = Engine.apply(s, c, { type: 'begin' }, 0).state;
  const v = JSON.stringify(Engine.view(s, c, 0));
  assert.ok(!v.includes('12345'));
  assert.ok(!v.includes('h-m1'), 'hint hidden until requested');
});

test('empty vault: finale ends the game', () => {
  const c = content();
  c.vault = [];
  let s = Engine.newState('D', 0);
  s.phase = 'finale';
  s = Engine.apply(s, c, { type: 'answer', text: '731' }, 10).state;
  assert.equal(s.phase, 'done');
  assert.equal(s.escapedAt, 10);
});

test('vault sorted easy → hard, stable within a level', () => {
  const sorted = Engine.sortByDifficulty([q('a', { difficulty: '難' }), q('b', { difficulty: '易' }), q('c', { difficulty: '中' }), q('d', { difficulty: '易' })]);
  assert.deepEqual(sorted.map((x) => x.id), ['b', 'd', 'c', 'a']);
});

test('demo content is valid and solvable', () => {
  global.window = {};
  require('../demo-content.js');
  const c = global.window.DEMO_CONTENT;
  c.main.concat(c.vault).forEach((x) => {
    const res = Engine.validateRow(Object.assign({ order: 1, theme: 't', source: 's', reskin: 'r' }, x));
    assert.deepEqual(res.errors, [], x.id);
  });
  let s = Engine.newState('E', 0);
  s = Engine.apply(s, c, { type: 'begin' }, 0).state;
  c.main.forEach((m) => { s = Engine.apply(s, c, { type: 'answer', text: Engine.alternatives(m.answer, m.type)[0] }, 1).state; });
  s = Engine.apply(s, c, { type: 'answer', text: Engine.finaleAnswer(c) }, 2).state;
  assert.equal(s.phase, 'vault');
});
