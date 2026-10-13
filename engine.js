// platform/engine.js
// 密室平台的共用邏輯：答案比對、出題檢查、遊戲進度。
// 同一份程式在瀏覽器（示範／測試模式）與 Google Apps Script（正式模式，複製成 Engine.gs）執行，
// 所以只用純函式、不碰 DOM、不用 import。

var Engine = (function () {
  var TYPES = ['數字', '文字', '方向', '顏色'];
  var DIFFICULTIES = ['易', '中', '難'];
  var ARROWS = { '↑': '上', '↓': '下', '←': '左', '→': '右' };
  var COLORS = ['紅', '橙', '黃', '綠', '藍', '紫', '黑', '白'];
  var MINUTE = 60 * 1000;

  // 出題試算表的欄位，順序即試算表欄位順序
  var COLUMNS = [
    { key: 'order', label: '關卡順序', required: true },
    { key: 'theme', label: '主題', required: true },
    { key: 'type', label: '密碼類型', required: true },
    { key: 'story', label: '題目敘述', required: true },
    { key: 'image', label: '圖片', required: false },
    { key: 'answer', label: '通關密碼', required: true },
    { key: 'hint', label: '提示', required: true },
    { key: 'success', label: '過關劇情', required: true },
    { key: 'estMin', label: '預估時間（分鐘）', required: true },
    { key: 'difficulty', label: '難度', required: true },
    { key: 'source', label: '科學依據', required: true },
    { key: 'reskin', label: '換皮檢核', required: true }
  ];

  // ---------- 答案比對 ----------

  // 全形轉半形、去空白、轉小寫；不動標點（3-1 和 31 是不同答案）
  function normalize(text, type) {
    var s = text == null ? '' : String(text);
    s = s.replace(/[！-～]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/\s+/g, '').toLowerCase();
    if (type === '方向') {
      s = s.replace(/[↑↓←→]/g, function (c) { return ARROWS[c]; });
    }
    return s;
  }

  // 「42|四十二」→ ['42', '四十二']（全形｜也算分隔）
  function alternatives(spec, type) {
    var s = spec == null ? '' : String(spec).replace(/｜/g, '|');
    return s.split('|')
      .map(function (a) { return normalize(a, type); })
      .filter(function (a) { return a !== ''; });
  }

  function checkAnswer(input, spec, type) {
    var given = normalize(input, type);
    if (given === '') return false;
    return alternatives(spec, type).indexOf(given) !== -1;
  }

  // ---------- 出題檢查 ----------

  function checkFormat(answer, type) {
    if (type === '數字') return /^\d+$/.test(answer);
    if (type === '方向') return /^[上下左右]+$/.test(answer);
    if (type === '顏色') {
      for (var i = 0; i < answer.length; i++) {
        if (COLORS.indexOf(answer.charAt(i)) === -1) return false;
      }
      return true;
    }
    return true;
  }

  var FORMAT_HELP = {
    '數字': '只能有數字',
    '方向': '只能用 上下左右（或 ↑↓←→）',
    '顏色': '只能用 ' + COLORS.join('')
  };

  // row: { order, theme, ... }（值為字串或數字）
  // 回傳 { errors: [字串], warnings: [字串] }
  function validateRow(row) {
    var errors = [];
    var warnings = [];
    COLUMNS.forEach(function (col) {
      if (col.required && String(row[col.key] == null ? '' : row[col.key]).trim() === '') {
        errors.push('「' + col.label + '」沒有填');
      }
    });
    var type = String(row.type || '').trim();
    if (type && TYPES.indexOf(type) === -1) {
      errors.push('「密碼類型」要從下拉選單選：' + TYPES.join('、'));
    }
    var diff = String(row.difficulty || '').trim();
    if (diff && DIFFICULTIES.indexOf(diff) === -1) {
      errors.push('「難度」要從下拉選單選：' + DIFFICULTIES.join('、'));
    }
    if (String(row.estMin || '').trim() !== '') {
      var est = Number(row.estMin);
      if (!(est > 0)) errors.push('「預估時間（分鐘）」要填大於 0 的數字');
    }
    if (String(row.order || '').trim() !== '' && !(Number(row.order) > 0)) {
      errors.push('「關卡順序」要填 1、2、3…');
    }
    if (String(row.answer || '').trim() !== '' && TYPES.indexOf(type) !== -1) {
      var alts = alternatives(row.answer, type);
      if (alts.length === 0) errors.push('「通關密碼」沒有有效的答案');
      alts.forEach(function (a) {
        if (!checkFormat(a, type)) {
          errors.push('通關密碼「' + a + '」不符合密碼類型「' + type + '」：' + FORMAT_HELP[type]);
        } else if (type === '數字' && a.length <= 3) {
          warnings.push('通關密碼「' + a + '」只有 ' + a.length + ' 位數，學生可能用猜的');
        }
      });
    }
    return { errors: errors, warnings: warnings };
  }

  function buildQuestion(row, teacher) {
    return {
      id: teacher + '-' + Number(row.order),
      teacher: teacher,
      order: Number(row.order),
      theme: String(row.theme).trim(),
      type: String(row.type).trim(),
      story: String(row.story),
      image: String(row.image || '').trim(),
      answer: String(row.answer).trim(),
      hint: String(row.hint),
      success: String(row.success),
      estMin: Number(row.estMin),
      difficulty: String(row.difficulty).trim(),
      source: String(row.source),
      reskin: String(row.reskin)
    };
  }

  // 寶庫由易到難；同難度保持原順序
  function sortByDifficulty(questions) {
    return questions
      .map(function (q, i) { return { q: q, i: i }; })
      .sort(function (a, b) {
        var d = DIFFICULTIES.indexOf(a.q.difficulty) - DIFFICULTIES.indexOf(b.q.difficulty);
        return d !== 0 ? d : a.i - b.i;
      })
      .map(function (x) { return x.q; });
  }

  // ---------- 遊戲內容 ----------
  // content = {
  //   id, title, settings: { timeLimitMin, skipPenaltyMin },
  //   prologue: 文字,
  //   main: [question + { fragment, transition }],
  //   finale: { story, type, answer(空白 = 碎片依序接起來), hint, success },
  //   vault: [question]
  // }

  function finaleAnswer(content) {
    var a = content.finale && String(content.finale.answer || '').trim();
    if (a) return a;
    return content.main.map(function (q) { return q.fragment; }).join('');
  }

  // 給學生端的內容：拿掉答案、提示與老師用欄位
  function publicQuestion(q) {
    return {
      id: q.id,
      type: q.type,
      story: q.story,
      image: q.image,
      estMin: q.estMin,
      transition: q.transition || ''
    };
  }

  // ---------- 遊戲進度 ----------
  // phase: prologue → main → finale → vault → done

  function newState(team, now) {
    return {
      team: team,
      startedAt: now,
      phase: 'prologue',
      index: 0,
      qStartedAt: now,
      penaltyMs: 0,
      fragments: [],
      skipped: [],
      hintsUsed: [],
      wrong: 0,
      escapedAt: null,
      vaultSolved: 0
    };
  }

  function deadline(state, content) {
    return state.startedAt + content.settings.timeLimitMin * MINUTE - state.penaltyMs;
  }

  function isOver(state, content, now) {
    return state.phase === 'done' || now >= deadline(state, content);
  }

  function currentKey(state) {
    if (state.phase === 'main') return 'main:' + state.index;
    if (state.phase === 'vault') return 'vault:' + state.index;
    if (state.phase === 'finale') return 'finale';
    return null;
  }

  function currentQuestion(state, content) {
    if (state.phase === 'main') return content.main[state.index];
    if (state.phase === 'vault') return content.vault[state.index];
    if (state.phase === 'finale') return content.finale;
    return null;
  }

  function escapeTimeMs(state) {
    if (state.escapedAt == null) return null;
    return state.escapedAt - state.startedAt + state.penaltyMs;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function enterMain(s, content, now) {
    s.index = 0;
    s.qStartedAt = now;
    s.phase = content.main.length ? 'main' : 'finale';
  }

  function advanceMain(s, content, now) {
    s.index += 1;
    s.qStartedAt = now;
    if (s.index >= content.main.length) {
      s.phase = 'finale';
      s.index = 0;
    }
  }

  function advanceVault(s, content, now) {
    s.index += 1;
    s.qStartedAt = now;
    if (s.index >= content.vault.length) s.phase = 'done';
  }

  // action: { type: 'begin' | 'answer' | 'hint' | 'skip', text? }
  // 回傳 { state, result }；state 是新物件，原本的不動
  function apply(state, content, action, now) {
    var s = clone(state);
    var r = { ok: true };
    if (isOver(s, content, now)) {
      return { state: s, result: { ok: false, message: '時間到了' } };
    }
    var q = currentQuestion(s, content);

    if (action.type === 'begin') {
      if (s.phase === 'prologue') enterMain(s, content, now);
      return { state: s, result: r };
    }

    if (action.type === 'answer') {
      if (!q) return { state: s, result: { ok: false, message: '現在不能作答' } };
      var spec = s.phase === 'finale' ? finaleAnswer(content) : q.answer;
      var correct = checkAnswer(action.text, spec, q.type);
      r.correct = correct;
      if (!correct) {
        s.wrong += 1;
        return { state: s, result: r };
      }
      r.success = q.success || '';
      if (s.phase === 'main') {
        s.fragments.push(String(q.fragment));
        r.fragment = String(q.fragment);
        advanceMain(s, content, now);
      } else if (s.phase === 'finale') {
        s.escapedAt = now;
        r.escaped = true;
        s.index = -1;
        advanceVault(s, content, now);
        if (s.phase !== 'done') s.phase = 'vault';
      } else if (s.phase === 'vault') {
        s.vaultSolved += 1;
        advanceVault(s, content, now);
      }
      return { state: s, result: r };
    }

    if (action.type === 'hint') {
      if (!q) return { state: s, result: { ok: false, message: '現在沒有提示' } };
      var key = currentKey(s);
      if (s.hintsUsed.indexOf(key) === -1) s.hintsUsed.push(key);
      r.hint = q.hint || '';
      return { state: s, result: r };
    }

    if (action.type === 'skip') {
      if (s.phase === 'main') {
        s.penaltyMs += content.settings.skipPenaltyMin * MINUTE;
        s.skipped.push(s.index);
        s.fragments.push(String(q.fragment));
        r.fragment = String(q.fragment);
        advanceMain(s, content, now);
        return { state: s, result: r };
      }
      if (s.phase === 'vault') {
        advanceVault(s, content, now);
        return { state: s, result: r };
      }
      return { state: s, result: { ok: false, message: '這一題不能跳過' } };
    }

    return { state: s, result: { ok: false, message: '不認得的動作' } };
  }

  // 學生端畫面需要的資料（不含答案）
  function view(state, content, now) {
    var q = currentQuestion(state, content);
    var key = currentKey(state);
    var v = {
      team: state.team,
      title: content.title,
      phase: state.phase,
      index: state.index,
      mainTotal: content.main.length,
      vaultTotal: content.vault.length,
      vaultSolved: state.vaultSolved,
      fragments: state.fragments.slice(),
      skipped: state.skipped.length,
      penaltyMin: state.penaltyMs / MINUTE,
      skipPenaltyMin: content.settings.skipPenaltyMin,
      startedAt: state.startedAt,
      deadline: deadline(state, content),
      qStartedAt: state.qStartedAt,
      over: isOver(state, content, now),
      escapeTimeMs: escapeTimeMs(state),
      hintsUsed: state.hintsUsed.length,
      prologue: state.phase === 'prologue' ? content.prologue : '',
      question: null
    };
    if (q) {
      v.question = state.phase === 'finale'
        ? { id: 'finale', type: content.finale.type || '數字', story: content.finale.story,
            image: content.finale.image || '', estMin: content.finale.estMin || 10,
            transition: content.finale.transition || '' }
        : publicQuestion(q);
      v.question.hintShown = state.hintsUsed.indexOf(key) !== -1;
      v.question.hint = v.question.hintShown ? (q.hint || '') : '';
    }
    return v;
  }

  // 監看頁一列
  function summary(state, content, now) {
    var where;
    if (state.phase === 'prologue') where = '序章';
    else if (state.phase === 'main') where = '第 ' + (state.index + 1) + ' / ' + content.main.length + ' 題';
    else if (state.phase === 'finale') where = '終章';
    else if (state.phase === 'vault') where = '寶庫 ' + (state.index + 1) + ' / ' + content.vault.length;
    else where = '寶庫完成';
    var est = null;
    var q = currentQuestion(state, content);
    if (q && state.phase !== 'finale') est = q.estMin;
    else if (state.phase === 'finale') est = content.finale.estMin || 10;
    return {
      team: state.team,
      where: where,
      phase: state.phase,
      escaped: state.escapedAt != null,
      over: isOver(state, content, now),
      remainingMs: Math.max(0, deadline(state, content) - now),
      onQuestionMs: now - state.qStartedAt,
      estMin: est,
      hintsUsed: state.hintsUsed.length,
      skipped: state.skipped.length,
      wrong: state.wrong,
      escapeTimeMs: escapeTimeMs(state),
      vaultSolved: state.vaultSolved
    };
  }

  return {
    TYPES: TYPES,
    DIFFICULTIES: DIFFICULTIES,
    COLORS: COLORS,
    COLUMNS: COLUMNS,
    normalize: normalize,
    alternatives: alternatives,
    checkAnswer: checkAnswer,
    validateRow: validateRow,
    buildQuestion: buildQuestion,
    sortByDifficulty: sortByDifficulty,
    finaleAnswer: finaleAnswer,
    newState: newState,
    apply: apply,
    view: view,
    summary: summary,
    deadline: deadline,
    isOver: isOver
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
