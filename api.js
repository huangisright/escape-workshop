// platform/api.js
// 學生端與監看頁共用的連線層。
//   RemoteRunner：正式模式，所有判定在 Google Apps Script 上做，答案不會送到 iPad。
//   LocalRunner ：示範模式與老師測試模式，在瀏覽器裡跑 engine.js，進度存在這台裝置。
// 兩者介面相同，每個方法都回傳 Promise<{ ok, view, result, now, message }>。

(function () {
  var cfg = window.PLATFORM_CONFIG || {};
  var params = new URLSearchParams(location.search);

  function apiUrl() {
    return params.get('api') || cfg.apiUrl || '';
  }

  // ---------- 正式模式 ----------

  function RemoteRunner(url) {
    this.url = url;
    this.mode = 'remote';
  }

  RemoteRunner.prototype.call = function (payload) {
    // text/plain 可避開 CORS 預檢，Apps Script 網頁應用程式才收得到
    return fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('伺服器回應 ' + res.status);
      return res.json();
    });
  };

  RemoteRunner.prototype.join = function (team) {
    return this.call({ action: 'join', team: team });
  };
  RemoteRunner.prototype.state = function (team) {
    return this.call({ action: 'state', team: team });
  };
  RemoteRunner.prototype.act = function (team, act) {
    return this.call({ action: 'act', team: team, act: act });
  };
  RemoteRunner.prototype.monitor = function (password) {
    return this.call({ action: 'monitor', password: password });
  };
  RemoteRunner.prototype.testContent = function (token) {
    return this.call({ action: 'test', token: token });
  };

  // ---------- 示範／測試模式 ----------

  function LocalRunner(content, opts) {
    this.content = content;
    this.mode = (opts && opts.mode) || 'demo';
    this.prefix = 'escape:' + content.id + ':';
  }

  function storage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  LocalRunner.prototype.load = function (team) {
    var st = storage();
    try {
      var raw = st && st.getItem(this.prefix + team);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  };

  LocalRunner.prototype.save = function (state) {
    var st = storage();
    try { if (st) st.setItem(this.prefix + state.team, JSON.stringify(state)); } catch (e) { /* 存不了就只留在記憶體 */ }
    this.memory = state;
  };

  LocalRunner.prototype.reply = function (state, result) {
    var now = Date.now();
    return Promise.resolve({ ok: true, view: Engine.view(state, this.content, now), result: result || null, now: now });
  };

  LocalRunner.prototype.current = function (team) {
    if (this.memory && this.memory.team === team) return this.memory;
    return this.load(team);
  };

  LocalRunner.prototype.join = function (team) {
    var s = this.current(team);
    if (!s) {
      s = Engine.newState(team, Date.now());
      this.save(s);
    }
    this.memory = s;
    return this.reply(s);
  };

  LocalRunner.prototype.state = function (team) {
    var s = this.current(team);
    if (!s) return Promise.resolve({ ok: false, message: '找不到這一組' });
    return this.reply(s);
  };

  LocalRunner.prototype.act = function (team, act) {
    var s = this.current(team);
    if (!s) return Promise.resolve({ ok: false, message: '找不到這一組' });
    var out = Engine.apply(s, this.content, act, Date.now());
    this.save(out.state);
    return this.reply(out.state, out.result);
  };

  LocalRunner.prototype.reset = function (team) {
    var st = storage();
    try { if (st) st.removeItem(this.prefix + team); } catch (e) { /* ignore */ }
    this.memory = null;
  };

  // 監看頁（示範模式）：列出這台裝置上所有組別
  LocalRunner.prototype.monitor = function () {
    var st = storage();
    var now = Date.now();
    var rows = [];
    if (st) {
      for (var i = 0; i < st.length; i++) {
        var key = st.key(i);
        if (key && key.indexOf(this.prefix) === 0) {
          try { rows.push(Engine.summary(JSON.parse(st.getItem(key)), this.content, now)); } catch (e) { /* 壞掉的紀錄略過 */ }
        }
      }
    }
    return Promise.resolve({ ok: true, title: this.content.title, teams: rows, now: now });
  };

  // ---------- 測試模式專用：看答案、跳題 ----------

  LocalRunner.prototype.revealAnswer = function (team) {
    var s = this.current(team);
    if (!s) return '';
    if (s.phase === 'main') return this.content.main[s.index].answer;
    if (s.phase === 'vault') return this.content.vault[s.index].answer;
    if (s.phase === 'finale') return Engine.finaleAnswer(this.content);
    return '';
  };

  LocalRunner.prototype.jump = function (team, index) {
    var s = this.current(team) || Engine.newState(team, Date.now());
    s.phase = index >= this.content.main.length ? 'finale' : 'main';
    s.index = s.phase === 'finale' ? 0 : index;
    s.qStartedAt = Date.now();
    s.fragments = this.content.main.slice(0, index).map(function (q) { return String(q.fragment); });
    this.save(s);
    return this.reply(s);
  };

  // ---------- 依網址決定模式 ----------
  //   ?test=代碼  → 老師測試模式（向伺服器拿該老師最新版題目，在本機跑）
  //   有 apiUrl   → 正式模式
  //   都沒有      → 示範模式（demo-content.js）
  function createRunner() {
    var url = apiUrl();
    var token = params.get('test');
    if (token) {
      if (!url) return Promise.reject(new Error('測試網址缺少伺服器位址'));
      return new RemoteRunner(url).testContent(token).then(function (res) {
        if (!res.ok) throw new Error(res.message || '測試代碼無效');
        return new LocalRunner(res.content, { mode: 'test' });
      });
    }
    if (url) return Promise.resolve(new RemoteRunner(url));
    return Promise.resolve(new LocalRunner(window.DEMO_CONTENT, { mode: 'demo' }));
  }

  window.EscapeApi = { createRunner: createRunner, LocalRunner: LocalRunner, RemoteRunner: RemoteRunner, apiUrl: apiUrl };
})();
