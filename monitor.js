// platform/monitor.js — 老師監看頁：各組在第幾題、剩多少時間、用了幾次提示

(function () {
  var REFRESH_MS = 10000;
  var runner = null;
  var password = '';
  var $ = function (id) { return document.getElementById(id); };

  function fmt(ms) {
    if (ms == null) return '—';
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // 排序：還在玩的照進度由慢到快（最需要關照的在上面），結束的放最後
  var PHASE_RANK = { prologue: 0, main: 1, finale: 2, vault: 3, done: 4 };
  function order(a, b) {
    if (a.over !== b.over) return a.over ? 1 : -1;
    var p = PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
    if (p) return p;
    return a.team.localeCompare(b.team, 'zh-Hant');
  }

  function cell(text, cls) {
    var td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function draw(res) {
    if (res.title) $('title').textContent = res.title + '｜監看';
    var tbody = $('rows');
    tbody.innerHTML = '';
    var teams = (res.teams || []).slice().sort(order);
    teams.forEach(function (t) {
      var tr = document.createElement('tr');
      var late = !t.over && t.estMin != null && t.onQuestionMs > t.estMin * 60000;
      if (late) tr.classList.add('late');
      if (t.escaped) tr.classList.add('escaped');
      if (t.over) tr.classList.add('over');
      var where = t.over && !t.escaped ? '時間到（' + t.where + '）' : t.escaped && t.phase !== 'vault' ? '逃脫成功' : t.where;
      tr.appendChild(cell(t.team));
      tr.appendChild(cell(where, 'where'));
      tr.appendChild(cell(t.over ? '—' : fmt(t.remainingMs)));
      tr.appendChild(cell(t.over || t.estMin == null ? '—' : fmt(t.onQuestionMs) + ' / ' + t.estMin + ':00', 'time-on'));
      tr.appendChild(cell(String(t.hintsUsed)));
      tr.appendChild(cell(String(t.skipped)));
      tr.appendChild(cell(String(t.wrong)));
      tr.appendChild(cell(fmt(t.escapeTimeMs)));
      tr.appendChild(cell(t.escaped ? String(t.vaultSolved) : '—'));
      tbody.appendChild(tr);
    });
    $('board-note').textContent = teams.length
      ? '共 ' + teams.length + ' 組。本題花的時間超過建議時間會標成橘色。每 10 秒自動更新。'
      : '還沒有組別開始。';
    $('updated').textContent = '更新於 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false });
  }

  function refresh() {
    return runner.monitor(password).then(function (res) {
      if (!res.ok) throw new Error(res.message || '讀取失敗');
      $('login').classList.add('hidden');
      $('board').classList.remove('hidden');
      draw(res);
    });
  }

  function start() {
    refresh().then(function () {
      setInterval(function () { refresh().catch(function () {}); }, REFRESH_MS);
    }).catch(function (err) {
      $('login').classList.remove('hidden');
      $('login-msg').textContent = err.message;
    });
  }

  $('login').addEventListener('submit', function (e) {
    e.preventDefault();
    password = $('password').value;
    $('login-msg').textContent = '';
    start();
  });

  EscapeApi.createRunner().then(function (r) {
    runner = r;
    if (r.mode === 'demo') {
      $('board-note').textContent = '';
      start();
    } else {
      $('login').classList.remove('hidden');
    }
  });
})();
