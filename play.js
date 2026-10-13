// platform/play.js — 學生端畫面

(function () {
  var TEAM_KEY = 'escape:team';
  var COLOR_HEX = { '紅': '#d63b3b', '橙': '#e8842a', '黃': '#e8c62a', '綠': '#3aa55c', '藍': '#2f6fd1', '紫': '#8a4fc7', '黑': '#1c1c1c', '白': '#f1f1f1' };
  var ARROW = { '上': '↑', '下': '↓', '左': '←', '右': '→' };

  var runner = null;
  var team = null;
  var view = null;
  var offset = 0;        // 伺服器時間 − 本機時間
  var entry = '';        // 目前輸入中的密碼
  var renderedKey = '';  // 換題時才清空輸入
  var busy = false;

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') n.textContent = attrs[k];
        else if (k === 'class') n.className = attrs[k];
        else if (k === 'onclick') n.addEventListener('click', attrs[k]);
        else n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function store(key, value) {
    try {
      if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* 私密瀏覽時存不了，重新整理後再輸入一次組別即可 */ }
  }
  function recall(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function now() { return Date.now() + offset; }

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    return String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function fmtLong(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ' 分 ' + String(s % 60).padStart(2, '0') + ' 秒';
  }

  function imageUrl(url) {
    // Google 雲端硬碟的分享連結轉成可直接顯示的圖片網址
    var m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/.exec(url || '');
    return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w2000' : url;
  }

  function show(screen) {
    ['screen-join', 'screen-game'].forEach(function (id) { $(id).classList.toggle('hidden', id !== screen); });
  }

  // ---------- 對話框 ----------

  function modal(title, body, buttons) {
    $('modal-title').textContent = title;
    $('modal-body').textContent = body || '';
    var box = $('modal-actions');
    box.innerHTML = '';
    (buttons || [{ label: '繼續', primary: true }]).forEach(function (b) {
      box.appendChild(el('button', {
        type: 'button', class: b.primary ? 'primary' : '', text: b.label,
        onclick: function () { $('modal').classList.add('hidden'); if (b.action) b.action(); }
      }));
    });
    $('modal').classList.remove('hidden');
    box.firstChild && box.firstChild.focus();
  }

  // ---------- 連線 ----------

  function handle(res) {
    if (!res || !res.ok) {
      throw new Error((res && res.message) || '連線失敗');
    }
    if (res.now) offset = res.now - Date.now();
    view = res.view;
    render();
    return res;
  }

  function act(action) {
    if (busy) return Promise.resolve(null);
    busy = true;
    return runner.act(team, action).then(handle).catch(function (err) {
      feedback(err.message, 'bad');
      return null;
    }).then(function (res) { busy = false; return res; });
  }

  function join(code) {
    return runner.join(code).then(function (res) {
      if (!res.ok) throw new Error(res.message || '找不到這個組別代碼');
      team = res.view.team;
      if (runner.mode !== 'test') store(TEAM_KEY, team);
      show('screen-game');
      handle(res);
    });
  }

  // ---------- 畫面 ----------

  function render() {
    if (!view) return;
    $('game-title').textContent = view.title;
    $('team-badge').textContent = view.team;
    renderProgress();
    renderFragments();
    var key = view.phase + ':' + view.index;
    if (key !== renderedKey) { entry = ''; renderedKey = key; }
    var stage = $('stage');
    stage.innerHTML = '';
    if (view.over || view.phase === 'done') stage.appendChild(renderEnd());
    else if (view.phase === 'prologue') stage.appendChild(renderPrologue());
    else stage.appendChild(renderQuestion());
    tick();
  }

  function renderProgress() {
    var p = $('progress');
    p.innerHTML = '';
    var total = view.mainTotal + 1;
    var at = view.phase === 'main' ? view.index : view.phase === 'prologue' ? -1 : total;
    if (view.phase === 'finale') at = view.mainTotal;
    for (var i = 0; i < total; i++) {
      p.appendChild(el('div', { class: 'step' + (i < at ? ' done' : i === at ? ' now' : '') }));
    }
  }

  function renderFragments() {
    var box = $('fragments');
    box.innerHTML = '';
    for (var i = 0; i < view.mainTotal; i++) {
      var f = view.fragments[i];
      box.appendChild(el('div', { class: 'fragment' + (f == null ? ' empty' : ''), text: f == null ? String(i + 1) : f, 'aria-label': f == null ? '第 ' + (i + 1) + ' 塊碎片（還沒拿到）' : '第 ' + (i + 1) + ' 塊碎片：' + f }));
    }
    var note = view.fragments.length + ' / ' + view.mainTotal + ' 塊碎片';
    if (view.skipped) note += '　跳過 ' + view.skipped + ' 題（扣 ' + view.penaltyMin + ' 分鐘）';
    $('ledger-note').textContent = note;
  }

  function renderPrologue() {
    return el('div', null, [
      el('h2', { text: '序章' }),
      el('div', { class: 'story', text: view.prologue }),
      el('div', { class: 'actions' }, [
        el('button', { type: 'button', class: 'primary', text: '出發', onclick: function () { act({ type: 'begin' }); } })
      ])
    ]);
  }

  function questionLabel() {
    if (view.phase === 'main') return '第 ' + (view.index + 1) + ' 題';
    if (view.phase === 'finale') return '終章';
    return '寶庫 ' + (view.index + 1) + ' / ' + view.vaultTotal;
  }

  function renderQuestion() {
    var q = view.question;
    var wrap = el('div');
    if (view.phase === 'vault') {
      wrap.appendChild(el('p', { class: 'muted', text: '你們已經逃出來了！逃脫時間 ' + fmtLong(view.escapeTimeMs) + '。寶庫裡已拿到 ' + view.vaultSolved + ' 件寶物，想停就停，不會扣分。' }));
    }
    wrap.appendChild(el('div', { class: 'question-head' }, [
      el('h2', { text: questionLabel() }),
      el('span', { class: 'muted', text: '建議時間 ' + q.estMin + ' 分鐘' })
    ]));
    if (q.transition) wrap.appendChild(el('p', { class: 'muted story', text: q.transition }));
    wrap.appendChild(el('div', { class: 'story', text: q.story }));
    if (q.image) wrap.appendChild(el('img', { class: 'question-img', src: imageUrl(q.image), alt: '線索圖' }));
    wrap.appendChild(renderEntry(q.type));
    wrap.appendChild(el('div', { class: 'feedback', id: 'feedback', role: 'status' }));
    if (q.hintShown) wrap.appendChild(el('div', { class: 'hint-box', text: '提示：' + q.hint }));

    var actions = el('div', { class: 'actions' });
    if (!q.hintShown) {
      actions.appendChild(el('button', { type: 'button', id: 'btn-hint', text: '提示', onclick: askHint }));
    }
    actions.appendChild(el('span', { class: 'spacer' }));
    if (view.phase === 'main') {
      actions.appendChild(el('button', { type: 'button', class: 'ghost', text: '跳過這題（扣 ' + view.skipPenaltyMin + ' 分鐘）', onclick: askSkip }));
    } else if (view.phase === 'vault') {
      actions.appendChild(el('button', { type: 'button', class: 'ghost', text: '換下一題', onclick: function () { act({ type: 'skip' }); } }));
    }
    wrap.appendChild(actions);
    return wrap;
  }

  function renderEnd() {
    var escaped = view.escapeTimeMs != null;
    var box = el('div', { class: 'center' });
    if (escaped) {
      box.appendChild(el('h1', { text: '逃脫成功' }));
      box.appendChild(el('p', { class: 'story', text: '逃脫時間：' + fmtLong(view.escapeTimeMs) + (view.skipped ? '（含跳過扣時 ' + view.penaltyMin + ' 分鐘）' : '') }));
      box.appendChild(el('p', { class: 'story', text: '寶庫寶物：' + view.vaultSolved + ' / ' + view.vaultTotal + ' 件' }));
    } else {
      box.appendChild(el('h1', { text: '時間到' }));
      var where = view.phase === 'finale' ? '你們已經走到終章的大門前。' :
        view.phase === 'prologue' ? '' : '你們解到第 ' + (view.index + 1) + ' 題。';
      box.appendChild(el('p', { class: 'story', text: '黃金城的大門沒有打開。' + where + '\n拿到 ' + view.fragments.length + ' / ' + view.mainTotal + ' 塊碎片。' }));
    }
    box.appendChild(el('p', { class: 'muted', text: '使用提示 ' + view.hintsUsed + ' 次' }));
    return box;
  }

  // ---------- 輸入方式 ----------

  function renderEntry(type) {
    var box = el('div', { class: 'entry' });
    if (type === '文字') {
      var input = el('input', { type: 'text', id: 'text-answer', autocomplete: 'off', 'aria-label': '輸入密碼' });
      input.value = entry;
      input.addEventListener('input', function () { entry = input.value; });
      var form = el('form', null, [input, el('div', { class: 'entry-row' }, [el('button', { type: 'submit', class: 'primary', text: '送出' })])]);
      form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
      box.appendChild(form);
      return box;
    }

    var display = el('div', { class: 'display', id: 'display', 'aria-live': 'polite' });
    box.appendChild(display);
    var pad;
    if (type === '方向') {
      pad = el('div', { class: 'dirpad' });
      var cells = [null, '上', null, '左', null, '右', null, '下', null];
      cells.forEach(function (d) {
        pad.appendChild(d ? el('button', { type: 'button', text: ARROW[d], 'aria-label': d, onclick: function () { press(d); } }) : el('span'));
      });
    } else if (type === '顏色') {
      pad = el('div', { class: 'colors' });
      Engine.COLORS.forEach(function (c) {
        var b = el('button', { type: 'button', text: c, 'aria-label': c, onclick: function () { press(c); } });
        b.style.background = COLOR_HEX[c];
        if (c === '白' || c === '黃') { b.style.color = '#222'; b.style.textShadow = 'none'; }
        pad.appendChild(b);
      });
    } else {
      pad = el('div', { class: 'keypad' });
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '清除', '0', '⌫'].forEach(function (k) {
        pad.appendChild(el('button', { type: 'button', text: k, 'aria-label': k === '⌫' ? '刪除一個' : k, onclick: function () {
          if (k === '清除') entry = ''; else if (k === '⌫') entry = entry.slice(0, -1); else entry += k;
          paint();
        } }));
      });
    }
    box.appendChild(pad);

    var row = el('div', { class: 'entry-row' });
    if (type !== '數字') {
      row.appendChild(el('button', { type: 'button', text: '⌫ 刪除', onclick: function () { entry = Array.from(entry).slice(0, -1).join(''); paint(); } }));
      row.appendChild(el('button', { type: 'button', text: '清除', onclick: function () { entry = ''; paint(); } }));
    }
    row.appendChild(el('button', { type: 'button', class: 'primary', text: '送出', onclick: submit }));
    box.appendChild(row);

    function press(v) { entry += v; paint(); }
    function paint() {
      display.innerHTML = '';
      Array.from(entry).forEach(function (ch) {
        if (type === '顏色') {
          var chip = el('span', { class: 'chip', title: ch });
          chip.style.background = COLOR_HEX[ch];
          display.appendChild(chip);
        } else {
          display.appendChild(document.createTextNode(type === '方向' ? ARROW[ch] : ch));
        }
      });
      display.setAttribute('aria-label', '已輸入：' + (entry || '無'));
    }
    paint();
    return box;
  }

  function feedback(text, kind) {
    var f = $('feedback');
    if (!f) return;
    f.textContent = text;
    f.className = 'feedback ' + (kind || '');
    if (kind === 'bad') { f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); }
  }

  // ---------- 動作 ----------

  function submit() {
    if (!entry) { feedback('還沒輸入密碼', 'bad'); return; }
    var phase = view.phase;
    var text = entry;
    act({ type: 'answer', text: text }).then(function (res) {
      if (!res || !res.result) return;
      var r = res.result;
      if (!r.ok) { feedback(r.message, 'bad'); return; }
      if (!r.correct) { entry = text; feedback('密碼不對，再想想', 'bad'); return; }
      if (r.escaped) {
        modal('逃脫成功！', r.success + '\n\n逃脫時間：' + fmtLong(view.escapeTimeMs));
      } else if (phase === 'main') {
        modal('過關！', (r.success ? r.success + '\n\n' : '') + '你們拿到一塊碎片：「' + r.fragment + '」，已收進線索簿。');
      } else if (phase === 'vault') {
        modal('拿到寶物！', r.success);
      }
    });
  }

  function askHint() {
    act({ type: 'hint' });
  }

  function askSkip() {
    modal('要跳過這一題嗎？', '跳過會扣 ' + view.skipPenaltyMin + ' 分鐘，但你們照樣會拿到這一題的碎片。', [
      { label: '先不要', primary: false },
      { label: '跳過', primary: true, action: function () {
        act({ type: 'skip' }).then(function (res) {
          if (res && res.result && res.result.ok) {
            modal('已跳過', '扣 ' + view.skipPenaltyMin + ' 分鐘。碎片「' + res.result.fragment + '」已收進線索簿。');
          }
        });
      } }
    ]);
  }

  // ---------- 計時 ----------

  var syncing = false;
  function tick() {
    if (!view) return;
    var t = $('timer');
    var remaining = view.deadline - now();
    if (view.escapeTimeMs != null && (view.over || view.phase === 'done')) {
      t.textContent = '逃脫 ' + fmt(view.escapeTimeMs);
      t.classList.remove('low');
    } else {
      t.textContent = fmt(remaining);
      t.classList.toggle('low', remaining < 5 * 60 * 1000);
    }
    // 時間到了但畫面還沒結束：向伺服器確認一次
    if (remaining <= 0 && !view.over && !syncing) {
      syncing = true;
      runner.state(team).then(handle).catch(function () {}).then(function () { syncing = false; });
    }
    // 超過建議時間，提示鈕亮起來
    var hint = $('btn-hint');
    if (hint && view.question) {
      hint.classList.toggle('glow', now() - view.qStartedAt > view.question.estMin * 60 * 1000);
    }
  }

  setInterval(tick, 1000);

  // 正式模式：每 30 秒同步一次（另一台 iPad 也在玩同一組時，畫面會跟上）
  setInterval(function () {
    if (runner && runner.mode === 'remote' && team && !busy && $('modal').classList.contains('hidden')) {
      runner.state(team).then(handle).catch(function () {});
    }
  }, 30000);

  // ---------- 測試模式 ----------

  function setupTestTools() {
    $('test-badge').classList.remove('hidden');
    $('test-tools').classList.remove('hidden');
    $('btn-reveal').addEventListener('click', function () {
      var box = $('reveal-box');
      box.textContent = '答案：' + (runner.revealAnswer(team) || '（這裡沒有題目）');
      box.classList.remove('hidden');
    });
    $('btn-restart').addEventListener('click', function () {
      runner.reset(team);
      $('reveal-box').classList.add('hidden');
      join(team);
    });
    var jumps = $('jump-buttons');
    var n = runner.content.main.length;
    for (var i = 0; i <= n; i++) {
      (function (idx) {
        jumps.appendChild(el('button', { type: 'button', text: idx < n ? '第 ' + (idx + 1) + ' 題' : '終章', onclick: function () {
          $('reveal-box').classList.add('hidden');
          runner.jump(team, idx).then(handle);
        } }));
      })(i);
    }
  }

  // ---------- 啟動 ----------

  $('join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('team-input').value.trim();
    if (!code) return;
    $('join-msg').textContent = '';
    join(code).catch(function (err) { $('join-msg').textContent = err.message; });
  });

  EscapeApi.createRunner().then(function (r) {
    runner = r;
    if (r.mode === 'test') {
      setupTestTools();
      return join('測試');
    }
    $('join-mode').textContent = r.mode === 'demo'
      ? '示範模式：輸入任何組名都可以開始（例如 A1）。進度只存在這台裝置。'
      : '請輸入老師發給你們的組別代碼。';
    var saved = recall(TEAM_KEY);
    if (saved) {
      return join(saved).catch(function () { store(TEAM_KEY, null); show('screen-join'); });
    }
    show('screen-join');
  }).catch(function (err) {
    show('screen-join');
    $('join-msg').textContent = err.message;
  });
})();
