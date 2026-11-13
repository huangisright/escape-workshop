/**
 * 密室工坊 v4 — Google Apps Script 後端
 * 學生與老師在同一個網址上傳謎題卡，管理者審核、發布，玩家直接遊玩。
 *
 * 第一次使用：在編輯器上方選 setup 執行一次，再到「執行紀錄」看管理者代碼。
 * 之後：部署 → 新增部署作業 → 網頁應用程式（執行身分：我；存取權：所有人）。
 */

var APP_NAME = '密室工坊';
var BANK = 'BANK'; // 老師題庫的 roomId

var SHEETS = {
  // 學生（role = student）：一人一列，email 是 Google 登入的帳號，roomId 是目前被分到的組（空白 = 還沒分組）
  Codes:     ['code', 'role', 'name', 'members', 'roomId', 'created', 'email', 'school'],
  Rooms:     ['id', 'ownerCode', 'kind', 'title', 'status', 'published', 'playCode', 'updated', 'json'],
  Puzzles:   ['id', 'roomId', 'ownerCode', 'author', 'title', 'kind', 'deleted', 'updated', 'json'],
  Snapshots: ['roomId', 'version', 'ts', 'fileId'],
  Files:     ['fileId', 'roomId', 'puzzleId', 'ownerCode', 'name', 'mime', 'size', 'ts'],
  Plays:     ['id', 'roomId', 'team', 'test', 'started', 'ended', 'result', 'state'],
  Events:    ['ts', 'playId', 'roomId', 'puzzleId', 'type', 'value', 'elapsed'],
  Ratings:   ['ts', 'playId', 'roomId', 'puzzleId', 'rating', 'comment']
};

var DEFAULT_SETTINGS = {
  campName: '黃金城歷險',
  playMinutes: 40,          // 學生密室的遊玩時間
  teacherRoomMinutes: 15,   // 老師示範密室的預設時間
  maxPuzzleMinutes: 15,     // 每題預估時間上限（超過亮黃燈）
  maxHints: 2,              // 每題提示層數上限（超過亮黃燈）
  minPuzzlesPerMember: 1,
  maxPuzzlesPerMember: 2,
  answerMaxLen: 10,         // 答案字數上限，0 = 不限制
  wrongCooldownSec: 60,     // 答錯後要等幾秒才能再答
  defaultHintDelaySec: 60,  // 新增提示時的預設秒數
  themeLabel: '主題連結（SDGs 14 永續海洋）',
  requireDigitalAndPhysical: true
};

var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* 學生用 Google 帳號登入：沿用「數學探索島」的 Firebase 專案（giftedmath-island）。
 * 這組 apiKey 本來就公開在網頁裡，不是密碼；這裡只拿來向 Google 確認登入憑證是真的、是哪個 email。 */
var FIREBASE_API_KEY = 'AIzaSyADSoa44HY5q0mM42Ezuomw5FmnFRA5JRM';
var FIREBASE_PROJECT_NUMBER = '12080862626';
var FRONT_ORIGIN = 'https://huangisright.github.io/';
var MAX_JSON = 48000;

/* ============================================================
 *  入口
 * ============================================================ */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

/**
 * 給放在 GitHub Pages 的畫面呼叫的 API（POST，內容是 {"fn": 函式名稱, "args": [...]}）。
 * 這樣畫面不必在 script.google.com 上打開，同時登入多個 Google 帳號也不會出錯。
 * 只開放畫面會用到的函式；setup、showAdminCode 等管理用函式不在名單內。
 */
var API_FUNCTIONS = ['login', 'studentLogin', 'studentJoin', 'getWorkspace', 'newPuzzle', 'savePuzzle', 'deletePuzzle', 'movePuzzle',
  'saveRoom', 'uploadFile', 'getFileData', 'submitRoom', 'getRoom', 'getPuzzle',
  'playStart', 'startTestPlay', 'playBegin', 'playState', 'playOpen', 'playAnswer', 'playSkip', 'playFinish', 'playHint', 'playHintImage', 'playRate', 'playBundle', 'playSync',
  'adminOverview', 'adminSaveSettings', 'adminCreateGroups', 'adminCreateTeachers', 'adminUpdateCode', 'adminDeleteGroup', 'adminDeleteGroups',
  'adminJoinCode', 'adminCreateStudents', 'adminUpdateStudent', 'adminDeleteStudent', 'adminAssignStudent', 'adminSetLeader',
  'adminCreateTeacherRoom', 'adminDeleteRoom', 'adminSetRoomPuzzles', 'adminSetRoomPlaces', 'adminGetRoom', 'adminGetPuzzle', 'adminRoomAction',
  'adminMaterials', 'adminLive', 'adminStats', 'adminExport', 'islandRooms'];

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = String(req.fn || '');
    if (API_FUNCTIONS.indexOf(fn) < 0) throw new Error('不支援的操作：' + fn);
    var f = this[fn];
    if (typeof f !== 'function') throw new Error('不支援的操作：' + fn);
    var r = f.apply(null, Array.isArray(req.args) ? req.args : []);
    out = { ok: true, result: r === undefined ? null : r };
  } catch (err) {
    out = { ok: false, error: (err && err.message) || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** 第一次使用時執行一次：建立試算表、雲端資料夾與管理者代碼 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SS_ID')) {
    Logger.log('已經設定過了。管理者代碼：' + adminCode_());
    return;
  }
  var ss = SpreadsheetApp.create(APP_NAME + '｜資料庫');
  var names = Object.keys(SHEETS);
  names.forEach(function (name, i) {
    var sh = i === 0 ? ss.getSheets()[0] : ss.insertSheet(name);
    if (i === 0) sh.setName(name);
    sh.getRange(1, 1, 1, 30).setNumberFormat('@');
    sh.getRange('A:Z').setNumberFormat('@');
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]);
    sh.setFrozenRows(1);
  });
  var root = DriveApp.createFolder(APP_NAME);
  var up = root.createFolder('上傳檔案');
  var ex = root.createFolder('匯出');
  var snap = root.createFolder('版本快照（勿刪）');
  DriveApp.getFileById(ss.getId()).moveTo(root);
  props.setProperties({
    SS_ID: ss.getId(), ROOT_ID: root.getId(), UP_ID: up.getId(),
    EX_ID: ex.getId(), SNAP_ID: snap.getId(),
    SETTINGS: JSON.stringify(DEFAULT_SETTINGS)
  });
  var admin = 'A' + randCode_(6);
  appendRow_('Codes', { code: admin, role: 'admin', name: '管理者', members: '', roomId: '', created: nowStr_() });
  Logger.log('設定完成！管理者代碼：' + admin);
  Logger.log('資料都放在雲端硬碟的「' + APP_NAME + '」資料夾。');
}

/** 忘記管理者代碼時執行（只寫在執行紀錄，不回傳，避免從網頁被叫出來） */
function showAdminCode() {
  Logger.log('管理者代碼：' + adminCode_());
}
function adminCode_() {
  var a = readAll_('Codes').filter(function (r) { return r.role === 'admin'; })[0];
  return a ? a.code : '（找不到，請重新執行 setup）';
}

/* ============================================================
 *  共用工具
 * ============================================================ */

var _ss = null;
function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function ss_() {
  if (!_ss) {
    var id = prop_('SS_ID');
    if (!id) throw new Error('系統還沒設定，請管理者先執行 setup');
    _ss = SpreadsheetApp.openById(id);
  }
  return _ss;
}
function sheet_(name) { return ss_().getSheetByName(name); }
function nowStr_() { return new Date().toISOString(); }
function nowMs_() { return Date.now(); }
function randCode_(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return s;
}
function newId_(prefix) { return prefix + Date.now().toString(36) + randCode_(4).toLowerCase(); }
function settings_() {
  var raw = prop_('SETTINGS');
  var s = {};
  try { s = JSON.parse(raw || '{}'); } catch (e) { s = {}; }
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = (s[k] === undefined) ? DEFAULT_SETTINGS[k] : s[k]; });
  return out;
}
function cellSafe_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '是' : '';
  var s = String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  // 拿到鎖之後，別人可能剛寫過，所以這次請求先前讀過的內容都不算數
  resetMemo_();
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- 讀表（同一次請求內只讀一次） ----------
 * Apps Script 每碰一次試算表都要花時間，整張表連同每題內容一起讀更慢。
 * _memo 只活在這一次請求裡（每次呼叫都是全新的執行環境），寫入時就丟掉該表的紀錄。
 */
var _memo = {};
function resetMemo_() { _memo = {}; }
function forget_(name, rowsMoved) {
  delete _memo['all:' + name];
  if (rowsMoved) delete _memo['idx:' + name];
  if (name === 'Codes') {
    try { CacheService.getScriptCache().remove(CODES_CACHE); } catch (e) { }
  }
}
function rowObj_(cols, r, rowNo) {
  var o = { _row: rowNo };
  cols.forEach(function (c, j) {
    var v = r[j];
    if (typeof v === 'string' && v.charAt(0) === "'") v = v.substring(1);
    o[c] = v;
  });
  return o;
}
function copyRows_(rows) {
  return rows.map(function (r) { var o = {}; for (var k in r) o[k] = r[k]; return o; });
}
function readAll_(name) {
  var key = 'all:' + name;
  if (!_memo[key]) {
    var sh = sheet_(name);
    var last = sh.getLastRow();
    var cols = SHEETS[name];
    _memo[key] = last < 2 ? [] : sh.getRange(2, 1, last - 1, cols.length).getValues().map(function (r, i) {
      return rowObj_(cols, r, i + 2);
    });
  }
  return copyRows_(_memo[key]);
}
/** 只讀第一欄（id），回傳 { id: [列號…] }，不必把每題的完整內容讀進來 */
function idIndex_(name) {
  var key = 'idx:' + name;
  if (_memo[key]) return _memo[key];
  var idx = {};
  var all = _memo['all:' + name];
  if (all) all.forEach(function (r) { (idx[r[SHEETS[name][0]]] = idx[r[SHEETS[name][0]]] || []).push(r._row); });
  else {
    var sh = sheet_(name);
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r, i) {
      var id = r[0];
      if (typeof id === 'string' && id.charAt(0) === "'") id = id.substring(1);
      (idx[id] = idx[id] || []).push(i + 2);
    });
  }
  _memo[key] = idx;
  return idx;
}
/** 依 id 讀出指定幾列；lastOnly 時同一個 id 只取最後一列 */
function rowsById_(name, ids, lastOnly) {
  var idx = idIndex_(name);
  var want = [];
  ids.forEach(function (id) {
    var rows = idx[id] || [];
    if (lastOnly) rows = rows.slice(-1);
    rows.forEach(function (n) { want.push(n); });
  });
  if (!want.length) return [];
  var all = _memo['all:' + name];
  if (all) return copyRows_(all.filter(function (r) { return want.indexOf(r._row) >= 0; }));
  var cols = SHEETS[name];
  var lo = Math.min.apply(null, want), hi = Math.max.apply(null, want);
  var vals = sheet_(name).getRange(lo, 1, hi - lo + 1, cols.length).getValues();
  return want.sort(function (x, y) { return x - y; }).map(function (n) { return rowObj_(cols, vals[n - lo], n); });
}
/** 代碼表：每次請求都要查，放進快取（10 分鐘；改代碼時會立刻清掉） */
var CODES_CACHE = 'codes:v1';
function codes_() {
  if (_memo['all:Codes']) return readAll_('Codes');
  var cache = CacheService.getScriptCache(), hit = null;
  try { hit = cache.get(CODES_CACHE); } catch (e) { }
  if (hit) {
    try { _memo['all:Codes'] = JSON.parse(hit); return readAll_('Codes'); } catch (e) { }
  }
  var rows = readAll_('Codes');
  try { cache.put(CODES_CACHE, JSON.stringify(rows), 600); } catch (e) { }
  return rows;
}
function appendRow_(name, obj) {
  var cols = SHEETS[name];
  var sh = sheet_(name);
  sh.appendRow(cols.map(function (c) { return c === 'json' || c === 'state' ? (obj[c] || '') : cellSafe_(obj[c]); }));
  forget_(name, true);
  return sh.getLastRow();
}
function writeRow_(name, row, obj) {
  var cols = SHEETS[name];
  sheet_(name).getRange(row, 1, 1, cols.length).setValues([cols.map(function (c) {
    return c === 'json' || c === 'state' ? (obj[c] || '') : cellSafe_(obj[c]);
  })]);
  forget_(name);
}

/* ---------- JSON 文件（密室與謎題） ---------- */

function docCols_(name, d) {
  if (name === 'Rooms') return {
    id: d.id, ownerCode: d.ownerCode, kind: d.kind, title: d.title,
    status: statusLabel_(d.status), published: !!d.published, playCode: d.playCode || '', updated: d.updated
  };
  return {
    id: d.id, roomId: d.roomId, ownerCode: d.ownerCode, author: d.author, title: d.title,
    kind: d.kind === 'digital' ? '數位' : d.kind === 'physical' ? '實體' : '', deleted: !!d.deleted, updated: d.updated
  };
}
function allDocs_(name) {
  return readAll_(name).map(parseDoc_);
}
function parseDoc_(r) {
  var d;
  try { d = JSON.parse(r.json); } catch (e) { d = { id: r.id, broken: true }; }
  d._row = r._row;
  return d;
}
/** 只讀這一列，不讀整張表 */
function getDoc_(name, id) {
  var rows = rowsById_(name, [id]);
  return rows.length ? parseDoc_(rows[0]) : null;
}
/** 依 id 讀好幾份文件（例如一間密室的題目），回傳 { id: 文件 } */
function getDocs_(name, ids) {
  var out = {};
  rowsById_(name, ids).forEach(function (r) { if (!out[r.id]) out[r.id] = parseDoc_(r); });
  return out;
}
function putDoc_(name, d) {
  d.updated = nowStr_();
  var clean = {};
  Object.keys(d).forEach(function (k) { if (k !== '_row') clean[k] = d[k]; });
  var json = JSON.stringify(clean);
  if (json.length > MAX_JSON) throw new Error('內容太長了（文字超過約 4 萬字），請精簡文字，或把長文改成圖片');
  var obj = docCols_(name, clean);
  obj.json = json;
  if (d._row) writeRow_(name, d._row, obj);
  else d._row = appendRow_(name, obj);
  return d;
}
function stripRow_(d) {
  if (!d) return d;
  var c = {};
  Object.keys(d).forEach(function (k) { if (k !== '_row') c[k] = d[k]; });
  return c;
}
function statusLabel_(s) {
  return { draft: '製作中', submitted: '已送審', approved: '審核通過' }[s] || s || '';
}

/* ---------- 代碼與權限 ---------- */

function account_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) throw new Error('請輸入代碼');
  var rows = codes_();
  for (var i = 0; i < rows.length; i++) if (String(rows[i].code).toUpperCase() === code) {
    var a = rows[i];
    a.membersList = String(a.members || '').split(/[,，、\s]+/).filter(function (x) { return x; });
    return a;
  }
  throw new Error('代碼不正確，請再確認一次');
}
function needRole_(acct, roles) {
  if (roles.indexOf(acct.role) < 0) throw new Error('這個代碼沒有權限做這件事');
}
function canReadPuzzle_(acct, p) {
  if (acct.role === 'admin') return true;
  if (acct.role === 'teacher') return p.roomId === BANK;
  if (acct.role === 'student') return p.ownerCode === acct.code || (!!acct.roomId && p.roomId === acct.roomId);
  return p.roomId === acct.roomId;
}
function canEditPuzzle_(acct, p, room) {
  if (acct.role === 'admin') return true;
  if (acct.role === 'teacher') return p.roomId === BANK && p.ownerCode === acct.code;
  // 學生只改自己的題目；題目要在自己目前這一組（或兩邊都還沒分組），組別送審後鎖定
  if (acct.role === 'student') return p.ownerCode === acct.code && (p.roomId || '') === (acct.roomId || '') &&
    (!room || room.status === 'draft');
  return p.roomId === acct.roomId && room && room.status === 'draft';
}
function canEditRoom_(acct, room) {
  if (acct.role === 'admin') return true;
  if (acct.role === 'student') return room.id === acct.roomId && room.leaderCode === acct.code && room.status === 'draft';
  return acct.role === 'group' && room.id === acct.roomId && room.status === 'draft';
}

/* ============================================================
 *  登入與讀取
 * ============================================================ */

function login(code) {
  var a = account_(code);
  var out = {
    code: a.code, role: a.role, name: a.name, members: a.membersList,
    roomId: a.roomId, settings: settings_(), appUrl: appUrl_()
  };
  if (a.role === 'student') {
    out.school = a.school || '';
    out.email = a.email || '';
    var room = a.roomId ? getDoc_('Rooms', a.roomId) : null;
    out.members = room ? membersOfRoom_(room) : [];
  }
  return out;
}
/* ============================================================
 *  學生用 Google 帳號登入
 *  畫面用 Firebase 登入後，把憑證送來這裡；確認是哪個 email 之後，回傳這位學生的個人代碼。
 *  之後的每個動作都用個人代碼，跟分組代碼、老師代碼一樣。
 * ============================================================ */

/** tok: { idToken: Firebase 的登入憑證, googleIdToken: Google 的登入憑證（兩個有一個驗得過就好） } */
function verifyGoogle_(tok) {
  tok = tok || {};
  var why = '';
  if (tok.idToken) {
    try {
      var r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Referer: FRONT_ORIGIN }, payload: JSON.stringify({ idToken: String(tok.idToken) })
      });
      var j = JSON.parse(r.getContentText() || '{}');
      var u = j.users && j.users[0];
      if (r.getResponseCode() === 200 && u && u.email) {
        if (u.emailVerified === false) throw new Error('這個 Google 帳號的 email 還沒驗證');
        return { email: String(u.email).toLowerCase(), name: u.displayName || '' };
      }
      why = (j.error && j.error.message) || ('HTTP ' + r.getResponseCode());
    } catch (e) { why = e.message; }
  }
  if (tok.googleIdToken) {
    try {
      var r2 = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(tok.googleIdToken)), { muteHttpExceptions: true });
      var g = JSON.parse(r2.getContentText() || '{}');
      // aud 是 Firebase 專案的登入用戶端，用專案編號開頭，確認是我們這個專案發的
      var okAud = String(g.aud || '').indexOf(FIREBASE_PROJECT_NUMBER + '-') === 0;
      var okIss = /^(https:\/\/)?accounts\.google\.com$/.test(String(g.iss || ''));
      var okExp = Number(g.exp || 0) * 1000 > nowMs_();
      if (r2.getResponseCode() === 200 && okAud && okIss && okExp && g.email && String(g.email_verified) === 'true') {
        return { email: String(g.email).toLowerCase(), name: g.name || '' };
      }
      why = why || g.error_description || g.error || '憑證不符';
    } catch (e2) { why = why || e2.message; }
  }
  throw new Error('Google 登入驗證失敗，請重新登入' + (why ? '（' + why + '）' : ''));
}
function studentByEmail_(email) {
  email = String(email || '').toLowerCase();
  if (!email) return null;
  return codes_().filter(function (r) { return r.role === 'student' && String(r.email || '').toLowerCase() === email; })[0] || null;
}
/** 用 Google 登入：已經加入過的學生直接回傳登入資料；第一次來的回傳 needJoin，請他填姓名與加入碼 */
function studentLogin(tok) {
  var who = verifyGoogle_(tok);
  var st = studentByEmail_(who.email);
  if (st) return { me: login(st.code) };
  return { needJoin: true, email: who.email, name: who.name, joinOpen: !!prop_('JOIN_CODE') };
}
/**
 * 第一次加入：info = { name, school, joinCode } 用老師公布的加入碼建立帳號；
 * 或 { personalCode } 把老師事先建好的個人代碼綁到這個 Google 帳號（之後就能用 Google 登入）。
 */
function studentJoin(tok, info) {
  var who = verifyGoogle_(tok);
  info = info || {};
  return withLock_(function () {
    var st = studentByEmail_(who.email);
    if (st) return { me: login(st.code) };
    var rows = readAll_('Codes');
    var pc = String(info.personalCode || '').trim().toUpperCase();
    if (pc) {
      var mine = rows.filter(function (r) { return r.role === 'student' && String(r.code).toUpperCase() === pc; })[0];
      if (!mine) throw new Error('個人代碼不正確，請再確認一次');
      if (mine.email) throw new Error('這個個人代碼已經綁定別的 Google 帳號了，請找老師');
      mine.email = who.email;
      writeRow_('Codes', mine._row, mine);
      return { me: login(mine.code) };
    }
    var jc = prop_('JOIN_CODE') || '';
    if (!jc) throw new Error('老師還沒開放加入，請找老師');
    if (String(info.joinCode || '').trim().toUpperCase() !== jc) throw new Error('加入碼不正確，請看老師公布的加入碼');
    var name = String(info.name || '').trim();
    var school = String(info.school || '').trim();
    if (!name) throw new Error('請填姓名');
    if (name.length > 20) throw new Error('姓名太長了');
    if (school.length > 30) throw new Error('學校／班級太長了');
    var c = newStudentCode_(rows);
    appendRow_('Codes', { code: c, role: 'student', name: name, members: '', roomId: '', created: nowStr_(), email: who.email, school: school });
    ensureHeader_('Codes');
    return { me: login(c) };
  });
}
function newStudentCode_(rows) {
  var used = rows.map(function (r) { return r.code; }), c;
  do { c = 'S' + randCode_(5); } while (used.indexOf(c) >= 0);
  return c;
}
/** 舊的試算表少了新欄位的標題時補上（只是給人看，程式照欄位順序讀） */
function ensureHeader_(name) {
  var cols = SHEETS[name];
  var sh = sheet_(name);
  var head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  if (head[cols.length - 1] !== cols[cols.length - 1]) sh.getRange(1, 1, 1, cols.length).setValues([cols]);
}

/** 給學生的網址：有設定 FRONT_URL（例如 GitHub Pages）就用它，否則用 Apps Script 網址 */
function appUrl_() {
  var front = prop_('FRONT_URL');
  if (front) return front;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/** 學生：讀取自己組的密室；老師：讀取題庫 */
function getWorkspace(code) {
  var a = account_(code);
  var s = settings_();
  if (a.role === 'group') {
    var room = getDoc_('Rooms', a.roomId);
    if (!room) throw new Error('找不到這組的密室，請找老師');
    var puzzles = roomPuzzles_(room);
    return {
      room: stripRow_(room),
      puzzles: puzzles.map(function (p) { return withChecks_(p, s, 'group'); }),
      roomChecks: checkRoom_(room, puzzles, s, a.membersList, false),
      editable: room.status === 'draft'
    };
  }
  if (a.role === 'student') return studentWorkspace_(a, s);
  if (a.role === 'teacher') {
    var bank = allDocs_('Puzzles').filter(function (p) { return p.roomId === BANK && !p.deleted; });
    return {
      puzzles: bank.map(function (p) {
        var x = withChecks_(p, s, 'teacher');
        x.editable = p.ownerCode === a.code;
        return x;
      })
    };
  }
  throw new Error('管理者請使用總覽頁');
}
/** 學生的工作區：還沒分組時只有自己的題目；分組後是整組的題目（別人的唯讀），組長另外能改密室資訊、排序、送審 */
function studentWorkspace_(a, s) {
  var room = a.roomId ? getDoc_('Rooms', a.roomId) : null;
  if (room && room.deleted) room = null;
  var puzzles = room ? roomPuzzles_(room) : allDocs_('Puzzles').filter(function (p) {
    return p.ownerCode === a.code && !p.deleted && !p.roomId;
  });
  var me = { name: a.name, code: a.code, school: a.school || '', email: a.email || '' };
  var list = puzzles.map(function (p) {
    var x = withChecks_(p, s, 'group');
    x.editable = canEditPuzzle_(a, p, room);
    x.mine = p.ownerCode === a.code;
    return x;
  });
  if (!room) return { student: true, me: me, room: null, puzzles: list, roomChecks: [], editable: true, isLeader: false, members: [] };
  var studs = studentsOfRoom_(room.id);
  var leader = studs.filter(function (r) { return r.code === room.leaderCode; })[0];
  return {
    student: true, me: me,
    room: stripRow_(room),
    puzzles: list,
    roomChecks: checkRoom_(room, puzzles, s, membersOfRoom_(room), false),
    editable: room.status === 'draft',
    isLeader: room.leaderCode === a.code,
    leaderName: leader ? leader.name : '',
    members: membersOfRoom_(room)
  };
}

/** saved：剛存好的那一題，直接用它，不必再讀一次 */
function roomPuzzles_(room, saved) {
  var byId = getDocs_('Puzzles', room.puzzleIds || []);
  if (saved) byId[saved.id] = saved;
  return (room.puzzleIds || []).map(function (id) { return byId[id]; })
    .filter(function (p) { return p && !p.deleted; });
}
function withChecks_(p, s, kind) {
  var x = stripRow_(p);
  x.checks = checkPuzzle_(p, s, kind, false);
  return x;
}

/* ============================================================
 *  謎題卡
 * ============================================================ */

function blankPuzzle_(a, s) {
  return {
    id: newId_('p'), roomId: a.role === 'teacher' ? BANK : (a.roomId || ''), ownerCode: a.code,
    // 學生的題目：設計者固定是本人（署名跟著帳號走，換組也不變）
    ownerKind: a.role === 'student' ? 'student' : undefined,
    author: a.role === 'teacher' || a.role === 'student' ? a.name : '', title: '', kind: '', estMinutes: '',
    steps: [{ get: '', act: '', result: '', checkpoint: '' }],
    blocks: [], answer: '', hints: [{ text: '', delaySec: s.defaultHintDelaySec }],
    props: [], themeLink: '', scienceBasis: '', reskinCheck: '', rev: 0, deleted: false
  };
}

function newPuzzle(code) {
  var a = account_(code);
  needRole_(a, ['group', 'teacher', 'student']);
  return withLock_(function () {
    var s = settings_();
    var p = blankPuzzle_(a, s);
    if (a.role === 'group' || (a.role === 'student' && a.roomId)) {
      var room = getDoc_('Rooms', a.roomId);
      if (!room || room.deleted) throw new Error('找不到你這一組的密室，請找老師');
      if (room.status !== 'draft') throw new Error('已送審，不能新增題目。要修改請找老師開放');
      room.puzzleIds = (room.puzzleIds || []).concat([p.id]);
      putDoc_('Rooms', room);
    }
    putDoc_('Puzzles', p);
    return withChecks_(p, s, a.role);
  });
}

var PUZZLE_FIELDS = ['title', 'author', 'kind', 'estMinutes', 'steps', 'blocks', 'answer', 'hints',
  'props', 'themeLink', 'scienceBasis', 'reskinCheck'];

function savePuzzle(code, data) {
  var a = account_(code);
  var done = withLock_(function () {
    var s = settings_();
    var p = getDoc_('Puzzles', data.id);
    if (!p || p.deleted) throw new Error('找不到這一題，可能已被刪除');
    var room = p.roomId === BANK || !p.roomId ? null : getDoc_('Rooms', p.roomId);
    if (!canEditPuzzle_(a, p, room)) {
      if (room && room.status !== 'draft') throw new Error('已送審，不能修改。要修改請找老師開放');
      throw new Error('只能修改自己的題目');
    }
    if ((data.rev || 0) !== (p.rev || 0)) {
      return { conflict: true, puzzle: withChecks_(p, s, p.roomId === BANK ? 'teacher' : 'group') };
    }
    PUZZLE_FIELDS.forEach(function (f) { if (data[f] !== undefined) p[f] = data[f]; });
    if (a.role === 'teacher' || a.role === 'student') p.author = a.name;
    p.rev = (p.rev || 0) + 1;
    putDoc_('Puzzles', p);
    return { p: p, room: room, s: s };
  });
  if (done.conflict) return done;
  // 檢核放在鎖外面做：存檔一寫完就放開鎖，別組的儲存不用排在這後面
  var p = done.p, room = done.room, s = done.s;
  var out = { puzzle: withChecks_(p, s, p.roomId === BANK ? 'teacher' : 'group') };
  if (room) {
    var members = room.kind === 'group' ? membersOfRoom_(room) : [];
    out.roomChecks = checkRoom_(room, roomPuzzles_(room, p), s, members, false);
  }
  return out;
}

function deletePuzzle(code, id) {
  var a = account_(code);
  return withLock_(function () {
    var p = getDoc_('Puzzles', id);
    if (!p) return true;
    var room = p.roomId === BANK || !p.roomId ? null : getDoc_('Rooms', p.roomId);
    if (!canEditPuzzle_(a, p, room)) throw new Error('不能刪除這一題');
    p.deleted = true;
    putDoc_('Puzzles', p);
    if (room) {
      room.puzzleIds = (room.puzzleIds || []).filter(function (x) { return x !== id; });
      putDoc_('Rooms', room);
    }
    return true;
  });
}

function movePuzzle(code, id, dir) {
  var a = account_(code);
  return withLock_(function () {
    var roomId = a.role === 'group' || a.role === 'student' ? a.roomId : null;
    if (!roomId) throw new Error('只有分組可以調整順序');
    var room = getDoc_('Rooms', roomId);
    if (!canEditRoom_(a, room)) throw new Error(a.role === 'student' && room.status === 'draft' && room.leaderCode !== a.code ? '題目順序由組長調整' : '已送審，不能調整順序');
    var ids = room.puzzleIds || [];
    var i = ids.indexOf(id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= ids.length) return ids;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    room.puzzleIds = ids;
    putDoc_('Rooms', room);
    return ids;
  });
}

/* ============================================================
 *  密室資訊（封面、說明、成功、失敗、心智圖）
 * ============================================================ */

var ROOM_FIELDS = ['title', 'cover', 'story', 'success', 'fail', 'mindmap', 'mode', 'theme'];
var ROOM_ADMIN_FIELDS = ['timeLimitMin', 'location', 'groupName', 'finale', 'skipMin'];
// 自由選題的地圖樣式：小島、拼圖（解開一塊就拼出一塊封面圖）、星球、清單
var MAP_THEMES = ['island', 'jigsaw', 'planet', 'list'];

function saveRoom(code, data) {
  var a = account_(code);
  var done = withLock_(function () {
    var room = getDoc_('Rooms', data.id);
    if (!room) throw new Error('找不到密室');
    if (!canEditRoom_(a, room)) {
      if ((a.role === 'group' || a.role === 'student') && room.id === a.roomId && room.status !== 'draft') throw new Error('已送審，不能修改。要修改請找老師開放');
      if (a.role === 'student' && room.id === a.roomId) throw new Error('密室資訊由組長負責修改');
      throw new Error('沒有權限修改這個密室');
    }
    if ((data.rev || 0) !== (room.rev || 0)) return { conflict: true, room: stripRow_(room) };
    ROOM_FIELDS.forEach(function (f) { if (data[f] !== undefined) room[f] = data[f]; });
    if (a.role === 'admin') ROOM_ADMIN_FIELDS.forEach(function (f) { if (data[f] !== undefined) room[f] = data[f]; });
    if (room.mode !== undefined) room.mode = modeOf_(room);
    if (room.theme !== undefined) room.theme = themeOf_(room);
    room.rev = (room.rev || 0) + 1;
    putDoc_('Rooms', room);
    return { room: room };
  });
  if (done.conflict) return done;
  var room = done.room;
  return {
    room: stripRow_(room),
    roomChecks: checkRoom_(room, roomPuzzles_(room), settings_(), membersOfRoom_(room), false)
  };
}

function blankRoom_(kind, ownerCode, title, s) {
  return {
    id: newId_('r'), kind: kind, ownerCode: ownerCode, title: title, groupName: '',
    cover: { text: '', imageId: '' }, story: [{ text: '', imageId: '' }],
    success: { text: '', imageId: '' }, fail: { text: '', imageId: '' },
    mindmap: { fileId: '', url: '' }, puzzleIds: [], status: 'draft', unlocksUsed: 0,
    published: false, playCode: '', publishedVersion: '', location: '',
    timeLimitMin: kind === 'teacher' ? s.teacherRoomMinutes : s.playMinutes, rev: 0,
    // 選用玩法（管理者設定）：終章碎片、跳過扣時、寶庫
    finale: { enabled: false, text: '', imageId: '', answer: '', hint: '' },
    fragments: [], skipMin: 0, vaultIds: [],
    // 玩法：free 自由選題（預設，主線各題同時開放，全部解完才逃脫或進終章）；linear 一題接一題
    mode: 'free', theme: 'island',
    // 關卡地點（管理者在挑題或審核時設定）：{ 題目 id: '圖書館門口' }；都沒填，遊戲中就不出現位置表
    places: {}
  };
}
/** 沒設過玩法的密室一律當成自由選題（預設）；只有明確選了 linear 才一題接一題 */
function modeOf_(room) { return room.mode === 'linear' ? 'linear' : 'free'; }
function themeOf_(room) { return MAP_THEMES.indexOf(room.theme) >= 0 ? room.theme : 'island'; }
function finaleOf_(room) {
  var f = room.finale || {};
  return { enabled: !!f.enabled, text: f.text || '', imageId: f.imageId || '', answer: f.answer || '', hint: f.hint || '' };
}
function roomVault_(room) {
  var byId = {};
  allDocs_('Puzzles').forEach(function (p) { byId[p.id] = p; });
  return (room.vaultIds || []).map(function (id) { return byId[id]; })
    .filter(function (p) { return p && !p.deleted; });
}
/** 組員名單：分組代碼上手打的名字（舊做法）＋被分到這一組的學生（新做法） */
function membersOfRoom_(room) {
  if (room.kind !== 'group') return [];
  var rows = codes_();
  var c = rows.filter(function (r) { return r.code === room.ownerCode; })[0];
  var names = c ? String(c.members || '').split(/[,，、\s]+/).filter(function (x) { return x; }) : [];
  rows.forEach(function (r) {
    if (r.role === 'student' && r.roomId === room.id && names.indexOf(r.name) < 0) names.push(r.name);
  });
  return names;
}
function studentsOfRoom_(roomId) {
  return codes_().filter(function (r) { return r.role === 'student' && roomId && r.roomId === roomId; });
}

/* ============================================================
 *  檔案上傳與讀取
 * ============================================================ */

var MAX_UPLOAD = 8 * 1024 * 1024;

/**
 * meta: { roomId, puzzleId, label, name, mime }
 * 圖片在前端先壓縮；HTML 以文字上傳（isText = true）
 */
function uploadFile(code, meta, payload, isText) {
  var a = account_(code);
  var roomId = meta.roomId || (a.role === 'teacher' ? BANK : a.roomId);
  if (a.role === 'student') roomId = a.roomId || ''; // 學生一律放在自己目前的組（還沒分組就是空白）
  if (a.role === 'group' && roomId !== a.roomId) throw new Error('只能上傳到自己組的密室');
  if (a.role === 'teacher' && roomId !== BANK) throw new Error('老師的檔案只能放在題庫');
  if (a.role === 'group' || (a.role === 'student' && roomId)) {
    var room = getDoc_('Rooms', a.roomId);
    if (room.status !== 'draft') throw new Error('已送審，不能上傳。要修改請找老師開放');
  }
  var mime = String(meta.mime || 'application/octet-stream');
  var bytes = isText ? Utilities.newBlob(String(payload), 'text/html').getBytes()
                     : Utilities.base64Decode(String(payload));
  if (bytes.length > MAX_UPLOAD) throw new Error('檔案太大（上限 8 MB），請壓縮後再上傳');
  var name = fileName_(a, roomId, meta);
  var blob = Utilities.newBlob(bytes, isText ? 'text/html' : mime, name);
  var folder = folderFor_(a, roomId);
  var f = folder.createFile(blob);
  withLock_(function () {
    appendRow_('Files', {
      fileId: f.getId(), roomId: roomId, puzzleId: meta.puzzleId || '', ownerCode: a.code,
      name: name, mime: isText ? 'text/html' : mime, size: bytes.length, ts: nowStr_()
    });
  });
  return { fileId: f.getId(), name: name, mime: isText ? 'text/html' : mime, size: bytes.length };
}

function fileName_(a, roomId, meta) {
  var ext = (String(meta.name || '').match(/\.[A-Za-z0-9]{1,5}$/) || [''])[0].toLowerCase();
  var who, num = '';
  if (roomId === BANK) who = '題庫-' + a.name;
  else if (!roomId) who = '未分組-' + a.name;
  else {
    var room = getDoc_('Rooms', roomId);
    who = (room && (room.groupName || room.title)) || roomId;
    if (meta.puzzleId && room) {
      var idx = (room.puzzleIds || []).indexOf(meta.puzzleId);
      if (idx >= 0) num = '-第' + (idx + 1) + '題';
    }
  }
  var label = meta.label ? '-' + meta.label : '';
  var stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'MMdd-HHmmss');
  return (who + num + label + '-' + stamp + ext).replace(/[\\\/:*?"<>|]/g, '_');
}

function folderFor_(a, roomId) {
  var up = DriveApp.getFolderById(prop_('UP_ID'));
  var name = roomId === BANK ? '老師題庫' : !roomId ? '未分組' : (function () {
    var room = getDoc_('Rooms', roomId);
    return (room && (room.groupName || room.title)) || roomId;
  })();
  var it = up.getFoldersByName(name);
  return it.hasNext() ? it.next() : up.createFolder(name);
}

function fileRow_(fileId) {
  var rows = readAll_('Files');
  for (var i = 0; i < rows.length; i++) if (rows[i].fileId === fileId) return rows[i];
  return null;
}

/** 編輯時預覽檔案（圖片、音檔回傳 data URL；HTML 回傳文字） */
function getFileData(code, fileId) {
  var a = account_(code);
  var row = fileRow_(fileId);
  if (!row) throw new Error('找不到檔案');
  if ((a.role === 'group' || a.role === 'student') && !canReadFile_(a, row)) throw new Error('沒有權限讀取這個檔案');
  if (a.role === 'teacher' && row.roomId !== BANK) throw new Error('沒有權限讀取這個檔案');
  return fileData_(fileId, row.mime);
}
/** 分組與學生：自己組的檔案、自己上傳的檔案、或目前同組學生上傳的檔案（換組前上傳的也算） */
function canReadFile_(a, row) {
  if (row.ownerCode === a.code) return true;
  if (!a.roomId) return false;
  var o = codes_().filter(function (c) { return c.code === row.ownerCode; })[0];
  // 學生上傳的檔案跟著人走：看上傳者現在在哪一組，不看上傳當時在哪一組
  if (o && o.role === 'student') return o.roomId === a.roomId;
  return row.roomId === a.roomId;
}
function fileData_(fileId, mime) {
  var blob = DriveApp.getFileById(fileId).getBlob();
  mime = mime || blob.getContentType();
  if (/text\/html/.test(mime)) return { mime: mime, text: blob.getDataAsString('UTF-8') };
  return { mime: mime, dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/* ============================================================
 *  檢核規則
 * ============================================================ */

function norm_(s) {
  s = String(s === null || s === undefined ? '' : s);
  try { s = s.normalize('NFKC'); } catch (e) { /* 舊環境 */ }
  s = s.replace(/[\uFF01-\uFF5E]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0); })
       .replace(/\u3000/g, ' ');
  return s.toLowerCase().replace(/臺/g, '台')
    .replace(/[\s，,。．.、；;：:！!？?「」『』“”"'‘’（）()【】\[\]]/g, '');
}
function splitAnswers_(s) {
  return String(s || '').split(/[\/／\n]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}
/** 一層提示只要有文字或圖片就算有內容 */
function hintOk_(h) { return !!h && (!!String(h.text || '').trim() || !!h.imageId); }
function hintsOf_(p) { return (p.hints || []).filter(hintOk_); }

function visibleText_(p) {
  var t = [p.title || ''];
  (p.blocks || []).forEach(function (b) { if (b.text) t.push(b.text); if (b.caption) t.push(b.caption); if (b.label) t.push(b.label); });
  return t.join('\n');
}
function chk_(list, level, msg) { list.push({ level: level, msg: msg }); }

/**
 * 回傳 [{level:'ok'|'warn'|'err', msg}]
 * err = 必填未完成（紅燈，擋送審）；warn = 超過規則或可能有問題（黃燈，提醒不擋）
 */
function checkPuzzle_(p, s, kind, deep) {
  var c = [];
  if (!String(p.title || '').trim()) chk_(c, 'err', '題目名稱還沒填');
  if (kind === 'group' && !String(p.author || '').trim()) chk_(c, 'err', '還沒選負責成員');
  if (p.kind !== 'digital' && p.kind !== 'physical') chk_(c, 'err', '還沒選類型（數位／實體）');

  var steps = (p.steps || []).filter(function (x) {
    return String(x.get || '').trim() && String(x.act || '').trim() && String(x.result || '').trim();
  });
  if (!steps.length) chk_(c, 'err', '解題步驟鏈至少要完整填一步（拿到什麼、做什麼、得到什麼）');
  else if (steps.length === 1) chk_(c, 'warn', '只有一個解題步驟，可能太簡單');

  var blocks = p.blocks || [];
  if (!blocks.length) chk_(c, 'err', '題目內容至少要有一個區塊（文字、圖片、音檔、小遊戲或連結）');
  blocks.forEach(function (b, i) {
    if ((b.type === 'image' || b.type === 'audio' || b.type === 'html') && !b.fileId)
      chk_(c, 'err', '第 ' + (i + 1) + ' 個內容區塊的檔案還沒上傳');
    if (b.type === 'text' && !String(b.text || '').trim()) chk_(c, 'warn', '第 ' + (i + 1) + ' 個文字區塊是空的');
    if (b.type === 'link' && !/^https?:\/\//.test(String(b.url || ''))) chk_(c, 'err', '第 ' + (i + 1) + ' 個連結格式不正確');
  });
  if (p.kind === 'physical' && !blocks.length) { /* 已提示 */ }

  var answers = splitAnswers_(p.answer);
  if (!answers.length) chk_(c, 'err', '答案還沒填');
  else {
    if (s.answerMaxLen > 0 && String(answers[0]).length > s.answerMaxLen)
      chk_(c, 'warn', '答案超過 ' + s.answerMaxLen + ' 個字');
    var vis = norm_(visibleText_(p));
    answers.forEach(function (ans) {
      var n = norm_(ans);
      if (n.length >= 2 && vis.indexOf(n) >= 0) chk_(c, 'warn', '答案「' + ans + '」出現在題目文字裡，可能會洩題');
    });
    var h1 = (p.hints || [])[0];
    if (h1) {
      var hn = norm_(h1.text);
      answers.forEach(function (ans) {
        var n = norm_(ans);
        if (n.length >= 1 && hn.indexOf(n) >= 0) chk_(c, 'warn', '第一層提示裡直接出現答案');
      });
    }
  }

  var hints = hintsOf_(p);
  if (!hints.length) chk_(c, 'err', '至少要有一層提示');
  if (hints.length > s.maxHints) chk_(c, 'warn', '提示超過 ' + s.maxHints + ' 層');

  var est = Number(p.estMinutes);
  if (!est) chk_(c, 'err', '預估時間還沒填');
  else if (est > s.maxPuzzleMinutes) chk_(c, 'warn', '預估 ' + est + ' 分鐘，超過每題 ' + s.maxPuzzleMinutes + ' 分鐘');

  if (p.kind === 'physical' && !(p.props || []).some(function (x) { return String(x.item || '').trim(); }))
    chk_(c, 'warn', '實體題還沒列道具');

  if (!String(p.themeLink || '').trim()) chk_(c, 'err', '主題連結還沒寫');
  if (kind === 'teacher') {
    if (!String(p.scienceBasis || '').trim()) chk_(c, 'err', '科學依據還沒寫');
    if (!String(p.reskinCheck || '').trim()) chk_(c, 'err', '換皮檢核還沒寫（拿掉主題後，這題還成立嗎？）');
  }

  if (deep) {
    blocks.forEach(function (b, i) {
      if (b.type !== 'html' || !b.fileId) return;
      try {
        var html = norm_(DriveApp.getFileById(b.fileId).getBlob().getDataAsString('UTF-8'));
        answers.forEach(function (ans) {
          var n = norm_(ans);
          if (n.length >= 2 && html.indexOf(n) >= 0)
            chk_(c, 'warn', '第 ' + (i + 1) + ' 個區塊的 HTML 原始碼裡有答案「' + ans + '」');
        });
      } catch (e) { chk_(c, 'warn', '第 ' + (i + 1) + ' 個 HTML 檔讀不到'); }
    });
  }
  if (!c.some(function (x) { return x.level === 'err'; })) chk_(c, 'ok', '必填項目都完成了');
  return c;
}

function checkRoom_(room, puzzles, s, members, deep) {
  var c = [];
  if (!String(room.title || '').trim()) chk_(c, 'err', '密室名稱還沒填');
  if (!room.cover || !(String(room.cover.text || '').trim() || room.cover.imageId)) chk_(c, 'err', '封面還沒做');
  var story = (room.story || []).filter(function (x) { return String(x.text || '').trim() || x.imageId; });
  if (!story.length) chk_(c, 'err', '說明頁至少要一頁');
  if (story.length > 3) chk_(c, 'warn', '說明頁超過 3 頁');
  if (!room.success || !(String(room.success.text || '').trim() || room.success.imageId)) chk_(c, 'err', '成功頁還沒做');
  if (!room.fail || !(String(room.fail.text || '').trim() || room.fail.imageId)) chk_(c, 'err', '失敗頁還沒做');
  if (room.kind === 'group' && !(room.mindmap && (room.mindmap.fileId || room.mindmap.url)))
    chk_(c, 'err', '密室結構心智圖還沒上傳');
  if (!puzzles.length) chk_(c, 'err', '還沒有任何謎題');

  var kind = room.kind === 'teacher' ? 'teacher' : 'group';
  puzzles.forEach(function (p, i) {
    var pc = checkPuzzle_(p, s, kind, deep);
    var errs = pc.filter(function (x) { return x.level === 'err'; }).length;
    var warns = pc.filter(function (x) { return x.level === 'warn'; }).length;
    var name = '第 ' + (i + 1) + ' 題「' + (p.title || '未命名') + '」';
    if (errs) chk_(c, 'err', name + '還有 ' + errs + ' 項沒完成');
    else if (warns) chk_(c, 'warn', name + '有 ' + warns + ' 項提醒');
  });

  if (room.kind === 'group' && members.length) {
    var count = {};
    members.forEach(function (m) { count[m] = 0; });
    puzzles.forEach(function (p) { if (count[p.author] !== undefined) count[p.author]++; });
    var lack = members.filter(function (m) { return count[m] < s.minPuzzlesPerMember; });
    var over = members.filter(function (m) { return count[m] > s.maxPuzzlesPerMember; });
    if (lack.length) chk_(c, 'warn', '還沒有負責題目（每人至少 ' + s.minPuzzlesPerMember + ' 題）：' + lack.join('、'));
    if (over.length) chk_(c, 'warn', '超過每人 ' + s.maxPuzzlesPerMember + ' 題：' + over.join('、'));
  }
  if (room.kind === 'group' && s.requireDigitalAndPhysical && puzzles.length) {
    var hasD = puzzles.some(function (p) { return p.kind === 'digital'; });
    var hasP = puzzles.some(function (p) { return p.kind === 'physical'; });
    if (!hasD || !hasP) chk_(c, 'warn', '數位題、實體題至少各要一題' + (!hasD ? '（缺數位題）' : '（缺實體題）'));
  }
  var fin = finaleOf_(room);
  if (fin.enabled) {
    var frags = room.fragments || [];
    var missing = [];
    puzzles.forEach(function (p, i) { if (!String(frags[i] || '').trim()) missing.push(i + 1); });
    if (missing.length) chk_(c, 'err', '終章：第 ' + missing.join('、') + ' 題還沒設碎片');
    if (!String(fin.text).trim() && !fin.imageId) chk_(c, 'err', '終章頁還沒寫');
    if (!String(fin.answer).trim() && !puzzles.length) chk_(c, 'err', '終章還沒有答案');
  }
  if ((room.vaultIds || []).length) {
    roomVault_(room).forEach(function (p, i) {
      var pc = checkPuzzle_(p, s, kind, deep);
      var name = '寶庫第 ' + (i + 1) + ' 題「' + (p.title || '未命名') + '」';
      var errs = pc.filter(function (x) { return x.level === 'err'; }).length;
      if (errs) chk_(c, 'err', name + '還有 ' + errs + ' 項沒完成');
    });
  }
  var total = puzzles.reduce(function (t, p) { return t + (Number(p.estMinutes) || 0); }, 0);
  var limit = Number(room.timeLimitMin) || s.playMinutes;
  if (total > limit) chk_(c, 'warn', '全部預估 ' + total + ' 分鐘，超過遊玩時間 ' + limit + ' 分鐘');
  if (!c.some(function (x) { return x.level === 'err'; })) chk_(c, 'ok', '可以送審');
  return c;
}

function summary_(checks) {
  return {
    err: checks.filter(function (x) { return x.level === 'err'; }).length,
    warn: checks.filter(function (x) { return x.level === 'warn'; }).length
  };
}

/* ============================================================
 *  送審
 * ============================================================ */

function submitRoom(code) {
  var a = account_(code);
  needRole_(a, ['group', 'student']);
  return withLock_(function () {
    var s = settings_();
    if (!a.roomId) throw new Error('還沒分組，不能送審');
    var room = getDoc_('Rooms', a.roomId);
    if (room.status !== 'draft') throw new Error('已經送審過了');
    if (a.role === 'student' && room.leaderCode !== a.code) throw new Error('送審由組長負責');
    var puzzles = roomPuzzles_(room);
    var checks = checkRoom_(room, puzzles, s, membersOfRoom_(room), true);
    if (summary_(checks).err) return { ok: false, roomChecks: checks };
    room.status = 'submitted';
    room.submittedAt = nowStr_();
    putDoc_('Rooms', room);
    return { ok: true, room: stripRow_(room), roomChecks: checks };
  });
}

/* ============================================================
 *  版本快照（發布或試玩時凍結內容）
 * ============================================================ */

var SNAP_ROOM_FIELDS = ['id', 'kind', 'title', 'groupName', 'cover', 'story', 'success', 'fail', 'timeLimitMin',
  'finale', 'fragments', 'skipMin', 'mode', 'theme', 'places'];
var SNAP_PUZZLE_FIELDS = ['id', 'title', 'author', 'kind', 'estMinutes', 'steps', 'blocks', 'answer', 'hints', 'props'];

function makeSnapshot_(room, test) {
  var pick = function (o, f) { var r = {}; f.forEach(function (k) { r[k] = o[k]; }); return r; };
  var snap = {
    room: pick(room, SNAP_ROOM_FIELDS),
    puzzles: roomPuzzles_(room).map(function (p) { return pick(p, SNAP_PUZZLE_FIELDS); }),
    vault: (room.vaultIds || []).length ? roomVault_(room).map(function (p) { return pick(p, SNAP_PUZZLE_FIELDS); }) : []
  };
  if (!snap.puzzles.length) throw new Error('這個密室還沒有題目');
  // 快照一律寫明玩法；這個欄位出現前發布的舊快照沒有 mode，照舊一題接一題，正在玩的不會突然改變
  snap.room.mode = modeOf_(room);
  snap.room.theme = themeOf_(room);
  var version = (test ? 'test-' : 'v') + Date.now().toString(36);
  var folder = DriveApp.getFolderById(prop_('SNAP_ID'));
  var f = folder.createFile(Utilities.newBlob(JSON.stringify(snap), 'application/json', room.id + '-' + version + '.json'));
  appendRow_('Snapshots', { roomId: room.id, version: version, ts: nowStr_(), fileId: f.getId() });
  try { CacheService.getScriptCache().put('snap:' + version, JSON.stringify(snap), 21600); } catch (e) { }
  return version;
}
function loadSnapshot_(version) {
  var cache = CacheService.getScriptCache();
  var hit = null;
  try { hit = cache.get('snap:' + version); } catch (e) { }
  if (hit) return JSON.parse(hit);
  var row = readAll_('Snapshots').filter(function (r) { return r.version === version; })[0];
  if (!row) throw new Error('找不到這個版本');
  var json = DriveApp.getFileById(row.fileId).getBlob().getDataAsString('UTF-8');
  try { cache.put('snap:' + version, json, 21600); } catch (e) { }
  return JSON.parse(json);
}

/* ============================================================
 *  遊玩
 * ============================================================ */

function gates_(p) {
  var g = [];
  (p.steps || []).forEach(function (st) {
    if (String(st.checkpoint || '').trim())
      g.push({ label: String(st.result || '').trim() || '中途答案', answers: splitAnswers_(st.checkpoint) });
  });
  g.push({ label: '答案', answers: splitAnswers_(p.answer) });
  return g;
}
function findPlay_(playId) {
  var r = rowsById_('Plays', [playId], true)[0];
  if (!r) throw new Error('找不到這場遊戲，請重新開始');
  r.st = JSON.parse(r.state || '{}');
  return r;
}
function savePlay_(r) {
  r.st.v = (Number(r.st.v) || 0) + 1; // 每存一次加一：離線回傳時用來確認伺服器沒有被別處改過
  r.state = JSON.stringify(r.st);
  writeRow_('Plays', r._row, r);
}
function logEvent_(play, puzzleId, type, value, elapsed) {
  appendRow_('Events', {
    ts: nowStr_(), playId: play.id, roomId: play.roomId, puzzleId: puzzleId || '',
    type: type, value: value === undefined ? '' : value, elapsed: elapsed === undefined ? '' : elapsed
  });
}
function introOf_(snap) {
  var r = snap.room;
  return {
    title: r.title, cover: mediaPage_(r.cover), story: (r.story || []).filter(function (x) {
      return String(x.text || '').trim() || x.imageId;
    }).map(mediaPage_),
    total: snap.puzzles.length, timeLimitSec: (Number(r.timeLimitMin) || settings_().playMinutes) * 60,
    finale: finaleOn_(snap), skipMin: Number(r.skipMin) || 0, vaultTotal: (snap.vault || []).length,
    free: isFree_(snap), theme: snap.room.theme || 'island'
  };
}

/* ---------- 選用玩法：終章碎片、跳過扣時、寶庫 ----------
 * 進度 st.phase：main（主線）→ finale（終章，有開才有）→ 逃脫 → vault（寶庫，有題才有）→ done
 * 逃脫時間在解開最後一關的當下就定下來（含跳過扣時），寶庫做多做少都不影響。
 */
function finaleOn_(snap) { return !!(snap.room.finale && snap.room.finale.enabled); }
function finaleAnswer_(snap) {
  var f = snap.room.finale || {};
  if (String(f.answer || '').trim()) return String(f.answer);
  return (snap.room.fragments || []).slice(0, snap.puzzles.length).map(function (x) { return String(x || '').trim(); }).join('');
}
function finalePuzzle_(snap) {
  var f = snap.room.finale || {};
  var blocks = [];
  if (String(f.text || '').trim()) blocks.push({ type: 'text', text: f.text });
  if (f.imageId) blocks.push({ type: 'image', fileId: f.imageId });
  return {
    id: 'finale', title: '終章', blocks: blocks, steps: [], answer: finaleAnswer_(snap),
    hints: String(f.hint || '').trim() ? [{ text: f.hint, delaySec: 0 }] : []
  };
}
function phase_(st) { return st.phase || 'main'; }
function current_(snap, st) {
  var ph = phase_(st);
  if (ph === 'main') return snap.puzzles[st.index];
  if (ph === 'finale') return finalePuzzle_(snap);
  if (ph === 'vault') return (snap.vault || [])[st.vi || 0];
  return null;
}
function limitMs_(snap) { return (Number(snap.room.timeLimitMin) || settings_().playMinutes) * 60000; }
function elapsedMs_(r) { return nowMs_() - r.st.startMs + (Number(r.st.penaltySec) || 0) * 1000; }
// 還能作答：沒結束，或已逃脫但還在寶庫
function active_(r) { return !r.result || (r.result === 'escaped' && phase_(r.st) === 'vault'); }
function resetPuzzle_(r) {
  r.st.gate = 0;
  r.st.hints = 0;
  r.st.cooldownUntil = 0;
  r.st.puzzleStart = nowMs_();
}
function escape_(r, snap) {
  r.result = 'escaped';
  r.ended = nowStr_();
  r.st.escapeSec = Math.round(elapsedMs_(r) / 1000);
  var cur = current_(snap, r.st);
  logEvent_(r, cur ? cur.id : '', 'end', 'escaped', r.st.escapeSec);
  if ((snap.vault || []).length && elapsedMs_(r) < limitMs_(snap)) {
    r.st.phase = 'vault';
    r.st.vi = 0;
    resetPuzzle_(r);
  } else {
    r.st.phase = 'done';
  }
}
/* ---------- 自由選題模式 ----------
 * 主線各題同時開放，玩家自己挑。每題的進度（第幾步、看了幾層提示、在這題花了多久）記在 st.ps[i]；
 * 目前打開的題目仍然用 st.index / st.gate / st.hints / st.puzzleStart，所以作答、提示、跳過的程式不用分兩套。
 * 換題時把目前這題的進度存回 st.ps，再載入要打開的那題；puzzleStart 往前推「已花的時間」，
 * 所以提示倒數和解題時間只算真的停在這題的時間。答錯冷卻是全隊共用，換題躲不掉。
 * 碎片依題目位置放（st.fragments[i]），跟解題順序無關；終章密碼照樣是碎片依位置接起來。
 */
function isFree_(snap) { return snap.room.mode === 'free'; }
function psOf_(r, snap) {
  var n = snap.puzzles.length;
  var ps = r.st.ps || [];
  for (var i = 0; i < n; i++) if (!ps[i]) ps[i] = { gate: 0, hints: 0, spent: 0, done: '', opened: false };
  r.st.ps = ps;
  return ps;
}
function stashPuzzle_(r, snap) {
  var e = psOf_(r, snap)[r.st.index];
  e.gate = r.st.gate || 0;
  e.hints = r.st.hints || 0;
  e.spent = Math.max(0, nowMs_() - (r.st.puzzleStart || nowMs_()));
}
function openPuzzle_(r, snap, i) {
  var e = psOf_(r, snap)[i];
  r.st.index = i;
  r.st.gate = e.gate || 0;
  r.st.hints = e.hints || 0;
  r.st.puzzleStart = nowMs_() - (e.spent || 0);
  if (!e.opened) {
    e.opened = true;
    logEvent_(r, snap.puzzles[i].id, 'open', '', 0);
  }
}
function boardOf_(r, snap) {
  var ps = psOf_(r, snap);
  return snap.puzzles.map(function (p, i) {
    return { no: i + 1, title: p.title, status: ps[i].done || (i === r.st.index ? 'current' : ps[i].opened ? 'opened' : 'new') };
  });
}

/** 目前這關過了（解開或跳過）：往下一關走。回傳拿到的碎片（沒有就是 null） */
function advance_(r, snap, skipped) {
  var ph = phase_(r.st);
  var fragment = null;
  if (ph === 'main' && isFree_(snap)) {
    var ps = psOf_(r, snap), i0 = r.st.index;
    ps[i0].done = skipped ? 'skipped' : 'solved';
    ps[i0].gate = 0;
    if (finaleOn_(snap)) {
      fragment = String((snap.room.fragments || [])[i0] || '').trim();
      var fr = r.st.fragments || [];
      while (fr.length < snap.puzzles.length) fr.push(null);
      fr[i0] = fragment;
      r.st.fragments = fr;
    }
    var next = -1;
    for (var k = 1; k <= ps.length; k++) {
      var j = (i0 + k) % ps.length;
      if (!ps[j].done) { next = j; break; }
    }
    if (next < 0) {
      if (finaleOn_(snap)) { r.st.phase = 'finale'; resetPuzzle_(r); }
      else escape_(r, snap);
    } else {
      r.st.cooldownUntil = 0;
      openPuzzle_(r, snap, next);
    }
  } else if (ph === 'main') {
    if (finaleOn_(snap)) {
      fragment = String((snap.room.fragments || [])[r.st.index] || '').trim();
      r.st.fragments = (r.st.fragments || []).concat([fragment]);
    }
    if (r.st.index >= snap.puzzles.length - 1) {
      if (finaleOn_(snap)) { r.st.phase = 'finale'; resetPuzzle_(r); }
      else escape_(r, snap);
    } else {
      r.st.index++;
      resetPuzzle_(r);
    }
  } else if (ph === 'finale') {
    escape_(r, snap);
  } else if (ph === 'vault') {
    if (!skipped) r.st.vaultSolved = (r.st.vaultSolved || 0) + 1;
    r.st.vi = (r.st.vi || 0) + 1;
    resetPuzzle_(r);
    if (r.st.vi >= (snap.vault || []).length) {
      r.st.phase = 'done';
      logEvent_(r, '', 'vault-end', 'complete', Math.round(elapsedMs_(r) / 1000));
    }
  }
  return fragment;
}
function mediaPage_(pg) {
  pg = pg || {};
  var out = { text: pg.text || '' };
  if (pg.imageId) { try { out.image = fileData_(pg.imageId).dataUrl; } catch (e) { } }
  return out;
}

/** 玩家用遊戲代碼開始（未開始計時，先看封面與說明） */
function playStart(playCode, team, members) {
  playCode = String(playCode || '').trim().toUpperCase();
  team = String(team || '').trim().substring(0, 30);
  if (!team) throw new Error('請輸入隊名');
  var room = allDocs_('Rooms').filter(function (r) { return r.published && !r.deleted && String(r.playCode).toUpperCase() === playCode; })[0];
  if (!room) throw new Error('遊戲代碼不正確，或這個密室還沒開放');
  members = cleanMembers_(members);
  if (!members.length) throw new Error('請至少輸入一位闖關成員的名字');
  var again = findLivePlay_(room, team, members);
  if (again) return again;
  return startPlay_(room, room.publishedVersion, team, false, members);
}
/** 同一個密室、同隊名還在進行中的遊戲：接回原本那場（計時照舊），不開新局。
 *  隊名相同但成員完全對不上，視為別組撞名，請對方換隊名，避免搶走別人的進度。 */
function findLivePlay_(room, team, members) {
  var key = function (x) { return norm_(x); };
  var rows = readAll_('Plays').filter(function (r) {
    return r.roomId === room.id && key(r.team) === key(team) && !(r.test === true || r.test === '是') && !r.result;
  });
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = findPlay_(rows[i].id);
    if (!active_(r) || timeoutDue_(r)) continue;
    var old = (r.st.members || []).map(key);
    var same = members.some(function (m) { return old.indexOf(key(m)) >= 0; });
    if (!same) throw new Error('「' + team + '」這個隊名正在被另一組使用，請換一個隊名');
    var intro = introOf_(loadSnapshot_(r.st.snap));
    intro.playId = r.id;
    intro.test = false;
    intro.resumed = !!r.st.startMs;
    return intro;
  }
  return null;
}
function cleanMembers_(m) {
  return (Array.isArray(m) ? m : []).map(function (x) { return String(x || '').trim().substring(0, 20); })
    .filter(function (x) { return x; }).slice(0, 12);
}

/** 作者或管理者試玩（用目前內容做一份測試快照，不計入數據） */
function startTestPlay(code, roomId) {
  var a = account_(code);
  if (a.role === 'group' || a.role === 'student') {
    roomId = a.roomId;
    if (!roomId) throw new Error('還沒分組，分組後才能試玩整間');
  }
  else needRole_(a, ['admin']);
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var version = withLock_(function () { return makeSnapshot_(room, true); });
  return startPlay_(room, version, '試玩-' + a.name, true, [a.name]);
}

function startPlay_(room, version, team, test, members) {
  var snap = loadSnapshot_(version);
  var play = {
    id: newId_('g'), roomId: room.id, team: team, test: !!test, started: '', ended: '', result: '',
    st: { snap: version, index: 0, gate: 0, puzzleStart: 0, startMs: 0, hints: 0, cooldownUntil: 0, wrong: 0,
          phase: 'main', members: members || [], solveSec: {}, fragments: [], skips: 0, penaltySec: 0, vi: 0, vaultSolved: 0, escapeSec: null }
  };
  withLock_(function () {
    play.state = JSON.stringify(play.st);
    play._row = appendRow_('Plays', play);
  });
  var intro = introOf_(snap);
  intro.playId = play.id;
  intro.test = !!test;
  return intro;
}

function playBegin(playId) {
  return withLock_(function () {
    var r = findPlay_(playId);
    if (!r.st.startMs) {
      r.st.startMs = nowMs_();
      r.st.puzzleStart = r.st.startMs;
      r.started = nowStr_();
      savePlay_(r);
      var snap = loadSnapshot_(r.st.snap);
      logEvent_(r, snap.puzzles[0].id, 'begin', '', 0);
      if (isFree_(snap)) { psOf_(r, snap)[0].opened = true; savePlay_(r); }
    }
    return stateOf_(r, null);
  });
}

/** havePuzzleId：前端已經有這題內容時就不重傳圖片 */
function playState(playId, havePuzzleId) {
  // 一般情況只是讀狀態，不必排隊等鎖；只有時間到、要寫入結果時才上鎖
  var r = findPlay_(playId);
  if (!timeoutDue_(r)) return stateOf_(r, havePuzzleId);
  return withLock_(function () {
    var r2 = findPlay_(playId);
    checkTimeout_(r2);
    return stateOf_(r2, havePuzzleId);
  });
}
/** 自由選題：打開第 i 題（從 0 起算）。已經解開或跳過的題目不能再開。 */
function playOpen(playId, i) {
  return withLock_(function () {
    var r = findPlay_(playId);
    checkTimeout_(r);
    if (!active_(r)) return stateOf_(r, '*');
    if (!r.st.startMs) throw new Error('遊戲還沒開始');
    var snap = loadSnapshot_(r.st.snap);
    if (!isFree_(snap) || phase_(r.st) !== 'main') throw new Error('這個密室要依序解題');
    i = Number(i);
    if (!(i >= 0 && i < snap.puzzles.length) || Math.floor(i) !== i) throw new Error('沒有這一題');
    if (psOf_(r, snap)[i].done) throw new Error('這一題已經過關了');
    if (i !== r.st.index) {
      stashPuzzle_(r, snap);
      openPuzzle_(r, snap, i);
      savePlay_(r);
    }
    return stateOf_(r, null);
  });
}
function timeoutDue_(r) {
  if (!r.st.startMs || !active_(r)) return false;
  return elapsedMs_(r) > limitMs_(loadSnapshot_(r.st.snap));
}

function checkTimeout_(r) {
  if (!r.st.startMs) return;
  var snap = loadSnapshot_(r.st.snap);
  if (elapsedMs_(r) <= limitMs_(snap)) return;
  if (!r.result) {
    r.result = 'timeout';
    r.ended = nowStr_();
    savePlay_(r);
    var p = current_(snap, r.st);
    logEvent_(r, p ? p.id : '', 'end', 'timeout', Math.round((nowMs_() - r.st.puzzleStart) / 1000));
  } else if (active_(r)) {
    r.st.phase = 'done';
    savePlay_(r);
    logEvent_(r, '', 'vault-end', 'timeout', Math.round(elapsedMs_(r) / 1000));
  }
}

function stateOf_(r, havePuzzleId) {
  var snap = loadSnapshot_(r.st.snap);
  var limitSec = limitMs_(snap) / 1000;
  var elapsed = r.st.startMs ? Math.floor(elapsedMs_(r) / 1000) : 0;
  var vault = snap.vault || [];
  var ph = phase_(r.st);
  var out = {
    playId: r.id, test: r.test === true || r.test === '是', result: r.result || '', over: !active_(r),
    total: snap.puzzles.length, index: r.st.index, remainingSec: Math.max(0, limitSec - elapsed),
    elapsedSec: elapsed, phase: ph,
    finale: finaleOn_(snap), fragments: r.st.fragments || [],
    skipMin: Number(snap.room.skipMin) || 0, skips: r.st.skips || 0, penaltySec: r.st.penaltySec || 0,
    vaultTotal: vault.length, vaultIndex: r.st.vi || 0, vaultSolved: r.st.vaultSolved || 0,
    escapeSec: r.st.escapeSec === undefined ? null : r.st.escapeSec,
    free: isFree_(snap), theme: snap.room.theme || 'island'
  };
  // 離線備援用：完整進度與伺服器時間。斷線時 iPad 從這份進度接著算，不含任何答案
  out.sync = { v: Number(r.st.v) || 0, st: r.st, result: r.result || '', ended: r.ended || '', team: r.team, serverNow: nowMs_() };
  // 關卡位置表：至少一題有填地點才給，舊快照沒有 places 就跟以前一樣
  var places = snap.room.places || {};
  if (snap.puzzles.some(function (p) { return places[p.id]; })) {
    out.places = snap.puzzles.map(function (p, i) { return { no: i + 1, title: p.title, place: places[p.id] || '' }; });
  }
  if (out.free) {
    var psx = psOf_(r, snap);
    out.solvedCount = psx.filter(function (e) { return !!e.done; }).length;
    if (!out.over && ph === 'main') out.board = boardOf_(r, snap);
  }
  if (out.over) {
    if (out.escapeSec !== null) out.elapsedSec = out.escapeSec;
    var pg = r.result === 'escaped' ? snap.room.success : snap.room.fail;
    out.ending = mediaPage_(pg);
    var ss = r.st.solveSec || {};
    var d = r.ended ? new Date(r.ended) : new Date();
    out.cert = {
      room: snap.room.title || '', team: r.team, members: r.st.members || [],
      date: Utilities.formatDate(isNaN(d) ? new Date() : d, 'Asia/Taipei', 'yyyy-MM-dd').split('-').map(Number).join('/'),
      puzzles: snap.puzzles.map(function (p) {
        return { title: p.title, author: p.author || '', sec: ss[p.id] === undefined ? null : ss[p.id] };
      })
    };
    var item = function (p, i) { return { id: p.id, no: i + 1, title: p.title, author: p.author || '' }; };
    if (r.result === 'escaped') out.rateList = snap.puzzles.map(item);
    else if (out.free) {
      var pso = psOf_(r, snap);
      out.rateList = snap.puzzles.map(item).filter(function (q, i) { return pso[i].opened || pso[i].done || i === r.st.index; });
    } else out.rateList = snap.puzzles.slice(0, Math.min(snap.puzzles.length, r.st.index + 1)).map(item);
    if (r.result === 'escaped' && ph === 'done') {
      vault.slice(0, Math.min(vault.length, (r.st.vi || 0) + 1)).forEach(function (p, i) {
        out.rateList.push({ id: p.id, no: i + 1, title: p.title, author: p.author || '', label: '寶庫 ' + (i + 1) });
      });
    }
    return out;
  }
  var p = current_(snap, r.st);
  var gates = gates_(p);
  var since = Math.floor((nowMs_() - r.st.puzzleStart) / 1000);
  var visibleHints = hintsOf_(p);
  out.puzzleId = p.id;
  out.title = p.title;
  out.place = places[p.id] || '';
  out.gate = r.st.gate;
  out.gateCount = gates.length;
  out.gateLabel = gates[r.st.gate].label;
  out.hintsShown = visibleHints.slice(0, r.st.hints).map(function (h) { return String(h.text || ''); });
  out.hintImgs = visibleHints.slice(0, r.st.hints).map(function (h) { return !!h.imageId; });
  out.hintTotal = visibleHints.length;
  out.nextHintInSec = r.st.hints < visibleHints.length
    ? Math.max(0, (Number(visibleHints[r.st.hints].delaySec) || 0) - since) : -1;
  out.cooldownSec = Math.max(0, Math.ceil((r.st.cooldownUntil - nowMs_()) / 1000));
  out.canSkip = (ph === 'main' && out.skipMin > 0) || ph === 'vault';
  if (havePuzzleId !== p.id) out.blocks = renderBlocks_(p.blocks || []);
  return out;
}

function renderBlocks_(blocks) {
  return blocks.map(function (b) {
    try {
      if (b.type === 'text') return { type: 'text', text: b.text || '' };
      if (b.type === 'link') return { type: 'link', url: b.url || '', label: b.label || b.url || '' };
      if (b.type === 'image') return { type: 'image', src: fileData_(b.fileId).dataUrl, caption: b.caption || '' };
      if (b.type === 'audio') return { type: 'audio', src: fileData_(b.fileId).dataUrl, caption: b.caption || '' };
      if (b.type === 'html') return { type: 'html', html: fileData_(b.fileId, 'text/html').text, height: b.height || 520 };
    } catch (e) {
      return { type: 'text', text: '（這個區塊的檔案讀取失敗）' };
    }
    return { type: 'text', text: '' };
  });
}

function playAnswer(playId, answer) {
  return withLock_(function () {
    var r = findPlay_(playId);
    checkTimeout_(r);
    if (!active_(r)) return { state: stateOf_(r, '*') };
    if (!r.st.startMs) throw new Error('遊戲還沒開始');
    if (nowMs_() < r.st.cooldownUntil) return { wait: true, state: stateOf_(r, currentPid_(r)) };
    var snap = loadSnapshot_(r.st.snap);
    var p = current_(snap, r.st);
    var gates = gates_(p);
    var g = gates[r.st.gate];
    var n = norm_(answer);
    var ok = n.length > 0 && g.answers.some(function (x) { return norm_(x) === n; });
    var since = Math.round((nowMs_() - r.st.puzzleStart) / 1000);
    var res = { correct: ok };
    if (!ok) {
      r.st.cooldownUntil = nowMs_() + settings_().wrongCooldownSec * 1000;
      r.st.wrong = (r.st.wrong || 0) + 1;
      logEvent_(r, p.id, 'wrong', String(answer).substring(0, 60), since);
      savePlay_(r);
      res.state = stateOf_(r, p.id);
      return res;
    }
    if (r.st.gate < gates.length - 1) {
      r.st.gate++;
      logEvent_(r, p.id, 'gate', g.label, since);
      savePlay_(r);
      res.gatePassed = true;
      res.state = stateOf_(r, p.id);
      return res;
    }
    logEvent_(r, p.id, 'solve', '', since);
    if (phase_(r.st) === 'main') { r.st.solveSec = r.st.solveSec || {}; r.st.solveSec[p.id] = since; }
    res.solved = true;
    var wasEscaped = r.result === 'escaped';
    res.fragment = advance_(r, snap, false);
    res.escaped = !wasEscaped && r.result === 'escaped';
    savePlay_(r);
    res.state = stateOf_(r, null);
    return res;
  });
}
function currentPid_(r) {
  try { var p = current_(loadSnapshot_(r.st.snap), r.st); return p ? p.id : null; } catch (e) { return null; }
}

/** 跳過：主線扣時間（照樣拿碎片）；寶庫直接換下一題、不扣時間 */
function playSkip(playId) {
  return withLock_(function () {
    var r = findPlay_(playId);
    checkTimeout_(r);
    if (!active_(r)) return { state: stateOf_(r, '*') };
    if (!r.st.startMs) throw new Error('遊戲還沒開始');
    var snap = loadSnapshot_(r.st.snap);
    var ph = phase_(r.st);
    var p = current_(snap, r.st);
    var since = Math.round((nowMs_() - r.st.puzzleStart) / 1000);
    var res = { skipped: true };
    if (ph === 'main') {
      var m = Number(snap.room.skipMin) || 0;
      if (!(m > 0)) throw new Error('這個密室不能跳過');
      r.st.penaltySec = (Number(r.st.penaltySec) || 0) + m * 60;
      r.st.skips = (r.st.skips || 0) + 1;
      res.penaltyMin = m;
    } else if (ph !== 'vault') {
      throw new Error('這一關不能跳過');
    }
    logEvent_(r, p.id, 'skip', ph, since);
    var wasEscaped = r.result === 'escaped';
    res.fragment = advance_(r, snap, true);
    res.escaped = !wasEscaped && r.result === 'escaped';
    savePlay_(r);
    checkTimeout_(r); // 扣時後可能剛好時間到
    res.state = stateOf_(r, null);
    return res;
  });
}

/** 寶庫裡想停就停：結束遊戲、進入評分 */
function playFinish(playId) {
  return withLock_(function () {
    var r = findPlay_(playId);
    if (r.result === 'escaped' && phase_(r.st) === 'vault') {
      r.st.phase = 'done';
      logEvent_(r, '', 'vault-end', 'stop', Math.round(elapsedMs_(r) / 1000));
      savePlay_(r);
    }
    return { state: stateOf_(r, '*') };
  });
}

function playHint(playId) {
  return withLock_(function () {
    var r = findPlay_(playId);
    checkTimeout_(r);
    if (!active_(r)) return { state: stateOf_(r, '*') };
    var snap = loadSnapshot_(r.st.snap);
    var p = current_(snap, r.st);
    var hints = hintsOf_(p);
    var since = Math.floor((nowMs_() - r.st.puzzleStart) / 1000);
    if (r.st.hints < hints.length && since >= (Number(hints[r.st.hints].delaySec) || 0)) {
      r.st.hints++;
      logEvent_(r, p.id, 'hint', r.st.hints, since);
      savePlay_(r);
    }
    return { state: stateOf_(r, p.id) };
  });
}

/** 玩家看已經開放的提示圖片（第 n 層，從 0 起算） */
function playHintImage(playId, n) {
  var r = findPlay_(playId);
  var snap = loadSnapshot_(r.st.snap);
  var p = current_(snap, r.st);
  if (!p) throw new Error('目前沒有進行中的題目');
  var hints = hintsOf_(p);
  n = Number(n);
  if (!(n >= 0 && n < r.st.hints && n < hints.length)) throw new Error('這層提示還沒開放');
  if (!hints[n].imageId) return { puzzleId: p.id, n: n, src: '' };
  return { puzzleId: p.id, n: n, src: fileData_(hints[n].imageId).dataUrl };
}

/* ============================================================
 *  離線備援：題目包與成績回傳
 *  為了讓 iPad 在沒有網路時也能判斷答案，題目包裡放的是「答案加鹽雜湊」，不是明文答案。
 *  只支援一般與自由選題；開了終章、跳過、寶庫的密室不提供（capable = false），一律要連網玩。
 * ============================================================ */
function hex_(bytes) {
  return bytes.map(function (b) { b = b < 0 ? b + 256 : b; return (b < 16 ? '0' : '') + b.toString(16); }).join('');
}
function ansHash_(salt, answer) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + norm_(answer), Utilities.Charset.UTF_8));
}
function playBundle(playId) {
  var r = findPlay_(playId);
  var snap = loadSnapshot_(r.st.snap);
  var capable = !finaleOn_(snap) && !(Number(snap.room.skipMin) > 0) && !(snap.vault || []).length;
  if (!capable) return { capable: false };
  var salt = 'er:' + r.st.snap;
  var places = snap.room.places || {};
  return {
    capable: true, salt: salt, snap: r.st.snap,
    room: {
      title: snap.room.title || '', free: isFree_(snap), theme: snap.room.theme || 'island',
      limitSec: limitMs_(snap) / 1000, cooldownSec: settings_().wrongCooldownSec,
      success: mediaPage_(snap.room.success), fail: mediaPage_(snap.room.fail)
    },
    puzzles: snap.puzzles.map(function (p) {
      return {
        id: p.id, title: p.title, author: p.author || '', place: places[p.id] || '',
        blocks: renderBlocks_(p.blocks || []),
        gates: gates_(p).map(function (g) {
          return { label: g.label, hashes: g.answers.map(norm_).filter(function (x) { return x; }).map(function (x) { return ansHash_(salt, x); }) };
        }),
        hints: hintsOf_(p).map(function (h) {
          var img = '';
          if (h.imageId) { try { img = fileData_(h.imageId).dataUrl; } catch (e) { } }
          return { text: String(h.text || ''), delaySec: Number(h.delaySec) || 0, img: img };
        })
      };
    })
  };
}

/** iPad 離線玩完（或半途）後回傳：伺服器確認這是同一場、沒被別處改過，才收下進度與事件紀錄 */
function playSync(playId, payload) {
  return withLock_(function () {
    var r = findPlay_(playId);
    payload = payload || {};
    var st = payload.st;
    if (!st || typeof st !== 'object') throw new Error('回傳的進度格式不對');
    if (st.snap !== r.st.snap || Number(st.startMs) !== Number(r.st.startMs)) throw new Error('這份離線進度和伺服器上的遊戲對不起來');
    var snap = loadSnapshot_(r.st.snap);
    if (finaleOn_(snap) || Number(snap.room.skipMin) > 0 || (snap.vault || []).length) throw new Error('這個密室不支援離線回傳');
    if ((Number(st.v) || 0) < (Number(r.st.v) || 0)) return { stale: true, state: stateOf_(r, '*') };
    var result = payload.result === 'escaped' || payload.result === 'timeout' ? payload.result : '';
    if (result === 'escaped' && Number(st.escapeSec) > limitMs_(snap) / 1000 + 5) throw new Error('逃脫時間超過限時，不收');
    var now = nowMs_();
    if (Number(st.startMs) > now + 60000) throw new Error('開始時間不合理');
    r.st = st;
    r.st.phase = result ? 'done' : 'main';
    r.result = result;
    r.ended = result ? (String(payload.ended || '') || nowStr_()) : '';
    savePlay_(r);
    (payload.events || []).slice(0, 600).forEach(function (e) {
      appendRow_('Events', {
        ts: String(e.ts || nowStr_()), playId: r.id, roomId: r.roomId, puzzleId: String(e.puzzleId || ''),
        type: String(e.type || '').substring(0, 20), value: e.value === undefined ? '' : String(e.value).substring(0, 60),
        elapsed: e.elapsed === undefined ? '' : e.elapsed
      });
    });
    return { synced: true, state: stateOf_(r, '*') };
  });
}

function playRate(playId, ratings, liked, stuck) {
  return withLock_(function () {
    var r = findPlay_(playId);
    (ratings || []).forEach(function (x) {
      var v = Number(x.rating);
      if (v >= 1 && v <= 5) appendRow_('Ratings', { ts: nowStr_(), playId: r.id, roomId: r.roomId, puzzleId: x.id, rating: v, comment: '' });
    });
    if (String(liked || '').trim()) appendRow_('Ratings', { ts: nowStr_(), playId: r.id, roomId: r.roomId, puzzleId: '', rating: '', comment: '最喜歡：' + String(liked).substring(0, 300) });
    if (String(stuck || '').trim()) appendRow_('Ratings', { ts: nowStr_(), playId: r.id, roomId: r.roomId, puzzleId: '', rating: '', comment: '卡關或不公平：' + String(stuck).substring(0, 300) });
    return true;
  });
}

/* ============================================================
 *  管理者
 * ============================================================ */

function adminOverview(code) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var s = settings_();
  var codes = readAll_('Codes');
  var puzzles = allDocs_('Puzzles').filter(function (p) { return !p.deleted; });
  var byId = {};
  puzzles.forEach(function (p) { byId[p.id] = p; });
  var rooms = allDocs_('Rooms').filter(function (room) { return !room.deleted; }).map(function (room) {
    var ps = (room.puzzleIds || []).map(function (id) { return byId[id]; }).filter(function (x) { return x; });
    var members = room.kind === 'group' ? membersOfRoom_(room) : [];
    var checks = checkRoom_(room, ps, s, members, false);
    var r = stripRow_(room);
    r.checks = checks;
    r.summary = summary_(checks);
    r.members = members;
    r.puzzleCount = ps.length;
    r.estTotal = ps.reduce(function (t, p) { return t + (Number(p.estMinutes) || 0); }, 0);
    r.puzzleList = ps.map(function (p) {
      return { id: p.id, title: p.title, author: p.author, kind: p.kind, summary: summary_(checkPuzzle_(p, s, room.kind === 'teacher' ? 'teacher' : 'group', false)) };
    });
    return r;
  });
  var bank = puzzles.filter(function (p) { return p.roomId === BANK; }).map(function (p) {
    return {
      id: p.id, title: p.title, author: p.author, kind: p.kind, estMinutes: p.estMinutes,
      updated: p.updated, summary: summary_(checkPuzzle_(p, s, 'teacher', false))
    };
  });
  var own = {};
  puzzles.forEach(function (p) { if (p.roomId !== BANK) own[p.ownerCode] = (own[p.ownerCode] || 0) + 1; });
  return {
    settings: s, appUrl: appUrl_(), joinCode: prop_('JOIN_CODE') || '',
    codes: codes.filter(function (c) { return c.role !== 'student'; }).map(function (c) { return { code: c.code, role: c.role, name: c.name, members: c.members, roomId: c.roomId }; }),
    students: codes.filter(function (c) { return c.role === 'student'; }).map(function (c) {
      return { code: c.code, name: c.name, school: c.school || '', email: c.email || '', roomId: c.roomId || '', puzzles: own[c.code] || 0, created: c.created };
    }),
    rooms: rooms, bank: bank
  };
}

function adminSaveSettings(code, data) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var s = settings_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (data[k] === undefined) return;
    s[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(data[k]) || 0
         : typeof DEFAULT_SETTINGS[k] === 'boolean' ? !!data[k] : String(data[k]);
  });
  PropertiesService.getScriptProperties().setProperty('SETTINGS', JSON.stringify(s));
  return s;
}

/** list: [{name:'第一組', members:'甲,乙,丙'}] */
function adminCreateGroups(code, list) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var s = settings_();
    var existing = readAll_('Codes').map(function (r) { return r.code; });
    var made = [];
    (list || []).forEach(function (g) {
      var name = String(g.name || '').trim();
      if (!name) return;
      var c;
      do { c = 'G' + randCode_(5); } while (existing.indexOf(c) >= 0);
      existing.push(c);
      var room = blankRoom_('group', c, name + '的密室', s);
      room.groupName = name;
      putDoc_('Rooms', room);
      appendRow_('Codes', {
        code: c, role: 'group', name: name, members: normMembers_(g.members),
        roomId: room.id, created: nowStr_()
      });
      made.push({ code: c, name: name });
    });
    return made;
  });
}
function adminCreateTeachers(code, names) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var existing = readAll_('Codes').map(function (r) { return r.code; });
    var made = [];
    (names || []).forEach(function (n) {
      n = String(n || '').trim();
      if (!n) return;
      var c;
      do { c = 'T' + randCode_(5); } while (existing.indexOf(c) >= 0);
      existing.push(c);
      appendRow_('Codes', { code: c, role: 'teacher', name: n, members: '', roomId: '', created: nowStr_() });
      made.push({ code: c, name: n });
    });
    return made;
  });
}
/* ---------- 學生名單與分組（管理者） ---------- */

/** action: 'new' 產生新的加入碼（舊的立即失效）；'close' 關閉加入；其他：只回傳目前的加入碼 */
function adminJoinCode(code, action) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var props = PropertiesService.getScriptProperties();
  if (action === 'new') props.setProperty('JOIN_CODE', randCode_(4));
  if (action === 'close') props.setProperty('JOIN_CODE', '');
  return prop_('JOIN_CODE') || '';
}
/** 沒辦法用 Google 登入的學生：老師直接建一個個人代碼。list: [{ name, school }] */
function adminCreateStudents(code, list) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var rows = readAll_('Codes'), made = [];
    (list || []).forEach(function (x) {
      var name = String((x && x.name) || '').trim().slice(0, 20);
      if (!name) return;
      var c = newStudentCode_(rows);
      rows.push({ code: c });
      appendRow_('Codes', { code: c, role: 'student', name: name, members: '', roomId: '', created: nowStr_(), email: '', school: String(x.school || '').trim().slice(0, 30) });
      made.push({ code: c, name: name });
    });
    ensureHeader_('Codes');
    return made;
  });
}
function studentRow_(rows, sc) {
  var r = rows.filter(function (x) { return x.code === sc && x.role === 'student'; })[0];
  if (!r) throw new Error('找不到這位學生');
  return r;
}
/** 改姓名、學校班級；clearEmail 解除 Google 綁定（換帳號時用）。改名時，他設計的題目署名一起改 */
function adminUpdateStudent(code, sc, data) {
  var a = account_(code);
  needRole_(a, ['admin']);
  data = data || {};
  return withLock_(function () {
    var r = studentRow_(readAll_('Codes'), sc);
    var old = r.name;
    if (data.name !== undefined && String(data.name).trim()) r.name = String(data.name).trim().slice(0, 20);
    if (data.school !== undefined) r.school = String(data.school).trim().slice(0, 30);
    if (data.clearEmail) r.email = '';
    writeRow_('Codes', r._row, r);
    if (r.name !== old) {
      allDocs_('Puzzles').forEach(function (p) {
        if (p.ownerCode === r.code && !p.deleted) { p.author = r.name; putDoc_('Puzzles', p); }
      });
    }
    return true;
  });
}
/** 刪除學生：只限沒有題目的（例如重複加入的帳號） */
function adminDeleteStudent(code, sc) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var r = studentRow_(readAll_('Codes'), sc);
    var n = allDocs_('Puzzles').filter(function (p) { return p.ownerCode === r.code && !p.deleted; }).length;
    if (n) throw new Error('「' + r.name + '」還有 ' + n + ' 題，不能刪除');
    if (r.roomId) {
      var room = getDoc_('Rooms', r.roomId);
      if (room && room.leaderCode === r.code) { room.leaderCode = ''; putDoc_('Rooms', room); }
    }
    sheet_('Codes').deleteRow(r._row);
    forget_('Codes', true);
    var room2 = r.roomId ? getDoc_('Rooms', r.roomId) : null;
    if (room2 && !room2.leaderCode) { autoLeader_(room2); putDoc_('Rooms', room2); }
    return true;
  });
}
/** 組長不在組裡（或還沒有）時，指定組裡第一位學生 */
function autoLeader_(room) {
  var studs = studentsOfRoom_(room.id);
  if (studs.some(function (x) { return x.code === room.leaderCode; })) return false;
  var next = studs[0] ? studs[0].code : '';
  if ((room.leaderCode || '') === next) return false;
  room.leaderCode = next;
  return true;
}
/**
 * 把學生分到某一組（roomId 空白 = 移回未分組）。
 * 預設題目跟著人走：他設計的題目從原組移到新組；opts.keepPuzzles 時題目留在原組（由原組保管，他就不能再改）。
 */
function adminAssignStudent(code, sc, roomId, opts) {
  var a = account_(code);
  needRole_(a, ['admin']);
  roomId = String(roomId || '');
  opts = opts || {};
  return withLock_(function () {
    var r = studentRow_(readAll_('Codes'), sc);
    var from = r.roomId || '';
    if (from === roomId) return { moved: 0 };
    var to = roomId ? getDoc_('Rooms', roomId) : null;
    if (roomId && (!to || to.deleted || to.kind !== 'group')) throw new Error('找不到這一組');
    var old = from ? getDoc_('Rooms', from) : null;
    if (old && old.deleted) old = null;
    var mine = allDocs_('Puzzles').filter(function (p) { return p.ownerCode === r.code && !p.deleted && (p.roomId || '') === from; });
    var carry = !opts.keepPuzzles && mine.length;
    if (carry) {
      var label = function (room) { return '「' + (room.groupName || room.title) + '」'; };
      if (old && old.status !== 'draft') throw new Error(label(old) + '已送審，題目移不出來。請先按「開放修改」，或勾選「題目留在原組」');
      if (to && to.status !== 'draft') throw new Error(label(to) + '已送審，題目放不進去。請先按「開放修改」');
    }
    r.roomId = roomId;
    writeRow_('Codes', r._row, r);
    var ids = carry ? mine.map(function (p) { return p.id; }) : [];
    if (carry) mine.forEach(function (p) { p.roomId = roomId; putDoc_('Puzzles', p); });
    if (old) {
      var ch = false;
      if (ids.length) {
        old.puzzleIds = (old.puzzleIds || []).filter(function (x) { return ids.indexOf(x) < 0; });
        if (old.places) ids.forEach(function (x) { delete old.places[x]; });
        ch = true;
      }
      if (old.leaderCode === r.code) { old.leaderCode = ''; autoLeader_(old); ch = true; }
      if (ch) putDoc_('Rooms', old);
    }
    if (to) {
      var ch2 = false;
      if (ids.length) { to.puzzleIds = (to.puzzleIds || []).concat(ids); ch2 = true; }
      if (autoLeader_(to)) ch2 = true;
      if (ch2) putDoc_('Rooms', to);
    }
    return { moved: ids.length };
  });
}
function adminSetLeader(code, roomId, sc) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = getDoc_('Rooms', roomId);
    if (!room || room.deleted) throw new Error('找不到這一組');
    if (sc && !studentsOfRoom_(roomId).some(function (x) { return x.code === sc; })) throw new Error('這位學生不在這一組');
    room.leaderCode = sc || '';
    putDoc_('Rooms', room);
    return true;
  });
}

function normMembers_(m) {
  return String(m || '').split(/[,，、\s]+/).filter(function (x) { return x; }).join(',');
}
function adminUpdateCode(code, target, data) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var rows = readAll_('Codes');
    var r = rows.filter(function (x) { return x.code === target; })[0];
    if (!r) throw new Error('找不到代碼');
    if (data.name !== undefined) r.name = String(data.name).trim() || r.name;
    if (data.members !== undefined) r.members = normMembers_(data.members);
    writeRow_('Codes', r._row, r);
    if (r.roomId && data.name !== undefined) {
      var room = getDoc_('Rooms', r.roomId);
      if (room) { room.groupName = r.name; putDoc_('Rooms', room); }
    }
    return true;
  });
}

/**
 * 刪除分組：只限還沒有任何謎題卡的組別（例如多按了「建立分組代碼」產生的重複組）。
 * 代碼列從 Codes 分頁移除（代碼立即失效），對應的空密室標為已刪除，不再出現在總覽與材料清單。
 */
function adminDeleteGroup(code, target) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var res = deleteGroups_([target]);
    if (res.skipped.length) throw new Error(res.skipped[0].reason);
    return true;
  });
}
/** 一次刪除多組。不能刪的組（已有謎題卡、已發布）略過並回報原因，其他照樣刪除。 */
function adminDeleteGroups(code, targets) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () { return deleteGroups_(targets || []); });
}
function deleteGroups_(targets) {
  var codes = readAll_('Codes');
  var puzzles = null;
  var rows = [], deleted = [], skipped = [], seen = {};
  targets.forEach(function (t) {
    t = String(t || '');
    if (seen[t]) return;
    seen[t] = true;
    var r = codes.filter(function (x) { return x.code === t; })[0];
    if (!r || r.role !== 'group') { skipped.push({ code: t, name: '', reason: '找不到這個分組' }); return; }
    var room = r.roomId ? getDoc_('Rooms', r.roomId) : null;
    if (room && !room.deleted) {
      if (!puzzles) puzzles = allDocs_('Puzzles');
      var used = puzzles.some(function (p) { return p.roomId === room.id && !p.deleted; });
      if (used || (room.puzzleIds || []).length) { skipped.push({ code: t, name: r.name, reason: '「' + r.name + '」已經有謎題卡了，不能刪除' }); return; }
      if (room.published) { skipped.push({ code: t, name: r.name, reason: '「' + r.name + '」的密室已發布，不能刪除' }); return; }
      room.deleted = true;
      room.deletedAt = nowStr_();
      putDoc_('Rooms', room);
      // 被分到這一組的學生回到「未分組」
      codes.forEach(function (c) {
        if (c.role === 'student' && c.roomId === room.id) { c.roomId = ''; writeRow_('Codes', c._row, c); }
      });
    }
    rows.push(r._row);
    deleted.push({ code: t, name: r.name });
  });
  // 由下往上刪，前面的列號才不會跑掉
  rows.sort(function (x, y) { return y - x; }).forEach(function (row) { sheet_('Codes').deleteRow(row); });
  forget_('Codes', true);
  return { deleted: deleted, skipped: skipped };
}

function adminCreateTeacherRoom(code, title) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = blankRoom_('teacher', a.code, String(title || '示範密室').trim(), settings_());
    putDoc_('Rooms', room);
    return stripRow_(room);
  });
}
/**
 * 刪除示範密室：下架並從管理頁移除。題庫裡的題目不受影響，可以再組成別的密室。
 * 遊玩紀錄與版本快照保留在試算表與雲端硬碟，需要時還查得到。
 */
function adminDeleteRoom(code, roomId) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = getDoc_('Rooms', roomId);
    if (!room || room.deleted) throw new Error('找不到這個密室');
    if (room.kind !== 'teacher') throw new Error('分組的密室不能在這裡刪除');
    room.deleted = true;
    room.published = false;
    room.deletedAt = nowStr_();
    putDoc_('Rooms', room);
    return true;
  });
}
/** 關卡地點只留這間密室（主線＋寶庫）裡的題目，空白的不存，每格最多 40 字 */
var PLACE_MAX = 40;
function cleanPlaces_(room, places) {
  var ids = (room.puzzleIds || []).concat(room.vaultIds || []), out = {};
  Object.keys(places || {}).forEach(function (id) {
    var v = String(places[id] === undefined || places[id] === null ? '' : places[id]).replace(/\s+/g, ' ').trim().slice(0, PLACE_MAX);
    if (v && ids.indexOf(id) >= 0) out[id] = v;
  });
  return out;
}

/** 管理者設定關卡地點（示範密室與學生密室都可以）。已發布的要按「更新發布版本」才會出現在遊戲裡 */
function adminSetRoomPlaces(code, roomId, places) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = getDoc_('Rooms', roomId);
    if (!room || room.deleted) throw new Error('找不到這個密室');
    room.places = cleanPlaces_(room, places);
    putDoc_('Rooms', room);
    return stripRow_(room);
  });
}

/** extra（選用）：{ fragments: 與 ids 同順序的碎片, vaultIds: 寶庫題目, places: 關卡地點 } */
function adminSetRoomPuzzles(code, roomId, ids, extra) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = getDoc_('Rooms', roomId);
    if (!room || room.kind !== 'teacher') throw new Error('只有示範密室可以從題庫組裝');
    var bank = {};
    allDocs_('Puzzles').forEach(function (p) { if (p.roomId === BANK && !p.deleted) bank[p.id] = 1; });
    var frags = (extra && extra.fragments) || [];
    var kept = [];
    room.fragments = [];
    (ids || []).forEach(function (id, i) {
      if (!bank[id] || kept.indexOf(id) >= 0) return;
      kept.push(id);
      room.fragments.push(String(frags[i] === undefined || frags[i] === null ? '' : frags[i]).trim());
    });
    room.puzzleIds = kept;
    if (extra && extra.vaultIds) {
      room.vaultIds = extra.vaultIds.filter(function (id, i, arr) {
        return bank[id] && kept.indexOf(id) < 0 && arr.indexOf(id) === i;
      });
    }
    if (extra && extra.places) room.places = cleanPlaces_(room, extra.places);
    putDoc_('Rooms', room);
    return stripRow_(room);
  });
}

/** 管理者讀取完整密室（含答案與深度檢核） */
function adminGetRoom(code, roomId) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var s = settings_();
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var ps = roomPuzzles_(room);
  var kind = room.kind === 'teacher' ? 'teacher' : 'group';
  return {
    room: stripRow_(room),
    members: membersOfRoom_(room),
    puzzles: ps.map(function (p) { var x = stripRow_(p); x.checks = checkPuzzle_(p, s, kind, true); return x; }),
    vault: roomVault_(room).map(function (p) { var x = stripRow_(p); x.checks = checkPuzzle_(p, s, kind, true); return x; }),
    roomChecks: checkRoom_(room, ps, s, membersOfRoom_(room), true)
  };
}
function adminGetPuzzle(code, id) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var p = getDoc_('Puzzles', id);
  if (!p) throw new Error('找不到題目');
  return withChecks_(p, settings_(), p.roomId === BANK ? 'teacher' : 'group');
}
/** 老師讀取題庫中的單題（唯讀或編輯） */
function getPuzzle(code, id) {
  var a = account_(code);
  var p = getDoc_('Puzzles', id);
  if (!p || p.deleted || !canReadPuzzle_(a, p)) throw new Error('找不到題目');
  var x = withChecks_(p, settings_(), p.roomId === BANK ? 'teacher' : 'group');
  var room = p.roomId === BANK || !p.roomId ? null : getDoc_('Rooms', p.roomId);
  x.editable = canEditPuzzle_(a, p, room);
  return x;
}
function getRoom(code, roomId) {
  var a = account_(code);
  if (a.role === 'group' || a.role === 'student') {
    roomId = a.roomId;
    if (!roomId) throw new Error('還沒分組');
  }
  else needRole_(a, ['admin']);
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var r = stripRow_(room);
  r.editable = canEditRoom_(a, room);
  return r;
}

/**
 * action: approve 審核通過 / unlock 開放修改 / publish 發布（凍結版本）/ unpublish 下架
 */
function adminRoomAction(code, roomId, action) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = getDoc_('Rooms', roomId);
    if (!room) throw new Error('找不到密室');
    if (action === 'approve') room.status = 'approved';
    else if (action === 'unlock') { room.status = 'draft'; room.unlocksUsed = (room.unlocksUsed || 0) + 1; }
    else if (action === 'publish') {
      room.publishedVersion = makeSnapshot_(room, false);
      room.published = true;
      room.publishedAt = nowStr_();
      if (!room.playCode) {
        var used = allDocs_('Rooms').map(function (r) { return r.playCode; });
        var pc;
        do { pc = 'P' + randCode_(4); } while (used.indexOf(pc) >= 0);
        room.playCode = pc;
      }
    } else if (action === 'unpublish') room.published = false;
    else throw new Error('未知的動作');
    putDoc_('Rooms', room);
    try { CacheService.getScriptCache().remove(ISLAND_CACHE); } catch (e) { } // 密室島馬上看得到
    return stripRow_(room);
  });
}

/** 各密室的材料清單（列印用） */
function adminMaterials(code) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var all = allDocs_('Puzzles');
  var byId = {};
  all.forEach(function (p) { byId[p.id] = p; });
  return allDocs_('Rooms').filter(function (room) { return !room.deleted; }).map(function (room) {
    return {
      id: room.id, title: room.title, groupName: room.groupName, location: room.location || '', kind: room.kind,
      puzzles: (room.puzzleIds || []).map(function (id) { return byId[id]; }).filter(function (p) { return p && !p.deleted; })
        .map(function (p, i) {
          return { no: i + 1, title: p.title, author: p.author, kind: p.kind, props: p.props || [] };
        })
    };
  });
}

/** 進行中的遊戲 */
function adminLive(code) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var rooms = {};
  allDocs_('Rooms').forEach(function (r) { rooms[r.id] = r.title; });
  var since = nowMs_() - 3 * 3600 * 1000;
  return readAll_('Plays').filter(function (r) {
    return r.started && new Date(r.started).getTime() > since;
  }).map(function (r) {
    var st = JSON.parse(r.state || '{}');
    var total = 0, vaultTotal = 0, free = false;
    try { var sn = loadSnapshot_(st.snap); total = sn.puzzles.length; vaultTotal = (sn.vault || []).length; free = isFree_(sn); } catch (e) { }
    var running = !r.result || (r.result === 'escaped' && st.phase === 'vault');
    var penalty = (Number(st.penaltySec) || 0) * 1000;
    return {
      team: r.team, room: rooms[r.roomId] || r.roomId, test: r.test === '是' || r.test === true,
      index: st.index, total: total, result: r.result || '', started: r.started,
      elapsedSec: !st.startMs ? 0 : (st.escapeSec !== undefined && st.escapeSec !== null && !running) ? st.escapeSec
        : Math.floor(((running ? nowMs_() : new Date(r.ended).getTime()) - st.startMs + penalty) / 1000),
      hints: st.hints, wrong: st.wrong || 0,
      phase: st.phase || 'main', skips: st.skips || 0, escapeSec: st.escapeSec === undefined ? null : st.escapeSec,
      vaultIndex: st.vi || 0, vaultSolved: st.vaultSolved || 0, vaultTotal: vaultTotal,
      free: free, solvedCount: (st.ps || []).filter(function (e) { return e && e.done; }).length
    };
  }).reverse();
}

/** 單一密室的遊玩數據（不含試玩） */
function adminStats(code, roomId) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var plays = readAll_('Plays').filter(function (r) { return r.roomId === roomId && !(r.test === '是' || r.test === true) && r.started; });
  var playIds = {};
  plays.forEach(function (p) { playIds[p.id] = 1; });
  var events = readAll_('Events').filter(function (e) { return playIds[e.playId]; });
  var ratings = readAll_('Ratings').filter(function (e) { return playIds[e.playId]; });
  var latestSnap = room.publishedVersion ? loadSnapshot_(room.publishedVersion) : null;
  var latest = latestSnap ? latestSnap.puzzles : roomPuzzles_(room);
  var vaultList = latestSnap ? (latestSnap.vault || []) : roomVault_(room);
  var per = latest.concat(vaultList).map(function (p, idx) {
    var inVault = idx >= latest.length;
    var i = inVault ? idx - latest.length : idx;
    var ev = events.filter(function (e) { return e.puzzleId === p.id; });
    var reached = {};
    ev.forEach(function (e) { reached[e.playId] = 1; });
    var solves = ev.filter(function (e) { return e.type === 'solve'; });
    var wrong = ev.filter(function (e) { return e.type === 'wrong'; });
    var hints = ev.filter(function (e) { return e.type === 'hint'; });
    var wc = {};
    wrong.forEach(function (e) { var k = String(e.value); wc[k] = (wc[k] || 0) + 1; });
    var topWrong = Object.keys(wc).sort(function (x, y) { return wc[y] - wc[x]; }).slice(0, 5)
      .map(function (k) { return { answer: k, count: wc[k] }; });
    var gateEv = ev.filter(function (e) { return e.type === 'gate'; });
    var rs = ratings.filter(function (x) { return x.puzzleId === p.id && x.rating; }).map(function (x) { return Number(x.rating); });
    var avg = function (arr) { return arr.length ? Math.round(arr.reduce(function (t, v) { return t + v; }, 0) / arr.length * 10) / 10 : null; };
    return {
      no: i + 1, vault: inVault, id: p.id, title: p.title, author: p.author, estMinutes: Number(p.estMinutes) || 0,
      reached: Object.keys(reached).length, solved: solves.length,
      avgSolveMin: solves.length ? Math.round(avg(solves.map(function (e) { return Number(e.elapsed) || 0; })) / 6) / 10 : null,
      hintsUsed: hints.length, wrongCount: wrong.length, topWrong: topWrong,
      gatesPassed: gateEv.length, skipped: ev.filter(function (e) { return e.type === 'skip'; }).length,
      avgRating: avg(rs), ratingCount: rs.length
    };
  });
  var escaped = plays.filter(function (p) { return p.result === 'escaped'; });
  var stOf = function (p) { try { return JSON.parse(p.state || '{}'); } catch (e) { return {}; } };
  var escSecs = escaped.map(function (p) { return Number(stOf(p).escapeSec); }).filter(function (x) { return x > 0; });
  return {
    title: room.title, plays: plays.length, escaped: escaped.length,
    avgEscapeMin: escSecs.length ? Math.round(escSecs.reduce(function (t, v) { return t + v; }, 0) / escSecs.length / 6) / 10 : null,
    vaultTotal: vaultList.length,
    perPuzzle: per,
    comments: ratings.filter(function (x) { return x.comment; }).map(function (x) { return x.comment; })
  };
}

/* ============================================================
 *  密室島：學生密室的公開展示頁（docs/islands.html，不用登入）
 *  只列已發布的學生密室，內容取自發布版本（審核過的），不含答案、提示與題目內容。
 *  名字會公開：密室名稱、組名、組員、各關設計者。遊玩數據不含試玩。
 * ============================================================ */

var ISLAND_CACHE = 'islands:v1';
var ISLAND_THEMES = { island: '小島', jigsaw: '拼圖', planet: '星球', list: '清單' };

function islandRooms() {
  var cache = CacheService.getScriptCache();
  try { var hit = cache.get(ISLAND_CACHE); if (hit) return JSON.parse(hit); } catch (e) { }
  var rooms = allDocs_('Rooms').filter(function (r) {
    return !r.deleted && r.kind === 'group' && r.published && r.publishedVersion;
  });
  var byRoom = {};
  readAll_('Plays').forEach(function (p) {
    if (!p.started || p.test === '是' || p.test === true) return;
    (byRoom[p.roomId] = byRoom[p.roomId] || []).push(p);
  });
  var clip = function (t, n) { t = String(t || '').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  var out = [];
  rooms.forEach(function (room) {
    var snap;
    try { snap = loadSnapshot_(room.publishedVersion); } catch (e) { return; }
    var sr = snap.room || {};
    var plays = byRoom[room.id] || [];
    var escaped = plays.filter(function (p) { return p.result === 'escaped'; });
    var secs = escaped.map(function (p) {
      try { return Number(JSON.parse(p.state || '{}').escapeSec); } catch (e) { return 0; }
    }).filter(function (x) { return x > 0; });
    var pages = (sr.story || []).map(function (pg) { return pg && pg.text; }).filter(function (t) { return t && String(t).trim(); });
    out.push({
      id: room.id,
      title: sr.title || room.title || '未命名密室',
      group: sr.groupName || room.groupName || '',
      theme: ISLAND_THEMES[themeOf_(sr)] || '小島',
      story: clip(pages[0] || (sr.cover && sr.cover.text) || '', 160),
      members: membersOfRoom_(room),
      puzzles: (snap.puzzles || []).map(function (p) { return { title: p.title || '未命名', author: p.author || '' }; }),
      plays: plays.length,
      escaped: escaped.length,
      bestSec: secs.length ? Math.min.apply(null, secs) : null,
      playCode: room.playCode || '',
      publishedAt: room.publishedAt || ''
    });
  });
  // 照建立順序（試算表的列序），通常就是第一組、第二組……
  var res = { campName: settings_().campName, rooms: out, ts: nowStr_() };
  try { cache.put(ISLAND_CACHE, JSON.stringify(res), 300); } catch (e) { }
  return res;
}

/* ============================================================
 *  匯出：一題一個 HTML、整間密室離線版
 * ============================================================ */

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('');
}

/** mode: 'room' 整間密室一個檔；'puzzles' 一題一個檔 */
function adminExport(code, roomId, mode) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var puzzles = roomPuzzles_(room);
  if (!puzzles.length) throw new Error('這個密室還沒有題目');
  var ex = DriveApp.getFolderById(prop_('EX_ID'));
  var stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmm');
  var folder = ex.createFolder((room.groupName || room.title) + '-' + stamp);
  var files = [];
  var pack = function (ps, withRoom) {
    return {
      title: withRoom ? room.title : ps[0].title,
      timeLimitSec: withRoom ? (Number(room.timeLimitMin) || settings_().playMinutes) * 60 : 0,
      cover: withRoom ? mediaPage_(room.cover) : null,
      story: withRoom ? (room.story || []).filter(function (x) { return String(x.text || '').trim() || x.imageId; }).map(mediaPage_) : [],
      success: withRoom ? mediaPage_(room.success) : { text: '答對了！' },
      fail: withRoom ? mediaPage_(room.fail) : { text: '時間到' },
      puzzles: ps.map(function (p) {
        return {
          title: p.title, author: p.author, blocks: renderBlocks_(p.blocks || []),
          hints: hintsOf_(p).map(function (h) {
            var o = { text: String(h.text || ''), delaySec: Number(h.delaySec) || 0 };
            if (h.imageId) { try { o.src = fileData_(h.imageId).dataUrl; } catch (e) { } }
            return o;
          }),
          gates: gates_(p).map(function (g) {
            return { label: g.label, hashes: g.answers.map(function (x) { return sha256Hex_(norm_(x)); }) };
          })
        };
      })
    };
  };
  if (mode === 'room') {
    var html = offlineHtml_(pack(puzzles, true));
    var f = folder.createFile(Utilities.newBlob(html, 'text/html', (room.groupName || room.title) + '-整間密室.html'));
    files.push({ name: f.getName(), url: f.getUrl() });
  } else {
    puzzles.forEach(function (p, i) {
      var html = offlineHtml_(pack([p], false));
      var name = (room.groupName || room.title) + '-第' + (i + 1) + '題-' + (p.author || '') + '-' + (p.title || '未命名') + '.html';
      var f = folder.createFile(Utilities.newBlob(html, 'text/html', name.replace(/[\\\/:*?"<>|]/g, '_')));
      files.push({ name: f.getName(), url: f.getUrl() });
    });
  }
  return { folderUrl: folder.getUrl(), files: files };
}

function offlineHtml_(data) {
  var json = JSON.stringify(data).replace(/</g, '\\u003c');
  return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escHtml_(data.title) + '</title><style>' + OFFLINE_CSS + '</style></head><body>' +
    '<div id="app"></div><script>var DATA=' + json + ';' + OFFLINE_JS + '</script></body></html>';
}
function escHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

var OFFLINE_CSS = [
  '*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#14181d;color:#eef0f2;line-height:1.7}',
  '#app{max-width:880px;margin:0 auto;padding:20px}',
  '.bar{display:flex;justify-content:space-between;align-items:center;padding:10px 0;color:#b9c0c8;font-size:15px}',
  '.timer{font-variant-numeric:tabular-nums;font-size:22px;color:#f3c969}',
  '.card{background:#1d232b;border:1px solid #2c3540;border-radius:14px;padding:22px;margin:14px 0}',
  'h1{font-size:28px;margin:6px 0 14px}h2{font-size:22px;margin:4px 0 12px}',
  'img{max-width:100%;border-radius:10px;display:block;margin:10px 0}audio{width:100%;margin:10px 0}',
  'iframe{width:100%;border:0;border-radius:10px;background:#fff;margin:10px 0}',
  '.txt{white-space:pre-wrap;font-size:18px}',
  'input{width:100%;font-size:22px;padding:14px;border-radius:10px;border:1px solid #3a4552;background:#0f1317;color:#fff}',
  'button{font-size:18px;padding:12px 20px;border-radius:10px;border:0;background:#f3c969;color:#1b1b1b;cursor:pointer;margin-top:10px}',
  'button.ghost{background:transparent;color:#f3c969;border:1px solid #f3c969}button:disabled{opacity:.45}',
  '.msg{min-height:26px;margin-top:8px;color:#ff9b8a}.ok{color:#8fe0a6}.hint{border-left:3px solid #f3c969;padding:6px 12px;margin:8px 0;color:#f6e3b3}.hint img{display:block;max-width:100%;margin-top:8px;border-radius:8px}',
  'a{color:#9cc9ff}'
].join('');

var OFFLINE_JS = [
  'function sha256(s){function r(n,x){return(x>>>n)|(x<<(32-n))}var K=[],H=[],p=2,c=0;function isP(n){for(var f=2;f*f<=n;f++)if(n%f===0)return false;return true}',
  'function fr(x){return((x-Math.floor(x))*4294967296)|0}while(c<64){if(isP(p)){if(c<8)H[c]=fr(Math.pow(p,1/2));K[c]=fr(Math.pow(p,1/3));c++}p++}',
  'var b=unescape(encodeURIComponent(s)),l=b.length*8,w=[],i;for(i=0;i<b.length;i++)w[i>>2]|=b.charCodeAt(i)<<(24-(i%4)*8);w[l>>5]|=0x80<<(24-l%32);w[((l+64>>9)<<4)+15]=l;',
  'for(i=0;i<w.length;i+=16){var W=[],a=H.slice(0),j;for(j=0;j<64;j++){if(j<16)W[j]=w[i+j]|0;else{var x=W[j-15],y=W[j-2];W[j]=(W[j-16]+(r(7,x)^r(18,x)^(x>>>3))+W[j-7]+(r(17,y)^r(19,y)^(y>>>10)))|0}',
  'var t1=(a[7]+(r(6,a[4])^r(11,a[4])^r(25,a[4]))+((a[4]&a[5])^(~a[4]&a[6]))+K[j]+W[j])|0,t2=((r(2,a[0])^r(13,a[0])^r(22,a[0]))+((a[0]&a[1])^(a[0]&a[2])^(a[1]&a[2])))|0;',
  'a=[(t1+t2)|0].concat(a.slice(0,7));a[4]=(a[4]+t1)|0}for(j=0;j<8;j++)H[j]=(H[j]+a[j])|0}',
  'return H.map(function(v){return("00000000"+(v>>>0).toString(16)).slice(-8)}).join("")}',
  'function norm(s){s=String(s||"");try{s=s.normalize("NFKC")}catch(e){}s=s.replace(/[\\uFF01-\\uFF5E]/g,function(c){return String.fromCharCode(c.charCodeAt(0)-0xFEE0)}).replace(/\\u3000/g," ");',
  'return s.toLowerCase().replace(/臺/g,"台").replace(/[\\s，,。．.、；;：:！!？?「」『』“”"\'‘’（）()【】\\[\\]]/g,"")}',
  'function esc(s){return String(s||"").replace(/[&<>"\']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c]})}',
  'var app=document.getElementById("app"),S={i:0,g:0,h:0,t0:0,ps:0,timer:null,done:false};',
  'function page(pg,btn,fn){app.innerHTML="<div class=card>"+(pg.image?"<img src=\'"+pg.image+"\'>":"")+"<div class=txt>"+esc(pg.text)+"</div>"+(btn?"<button id=nx>"+btn+"</button>":"")+"</div>";if(btn)document.getElementById("nx").onclick=fn}',
  'function intro(k){var pages=[];if(DATA.cover)pages.push(DATA.cover);pages=pages.concat(DATA.story||[]);if(!pages.length||k>=pages.length)return begin();page(pages[k],k===pages.length-1?"開始挑戰":"下一頁",function(){intro(k+1)})}',
  'function begin(){S.t0=Date.now();S.ps=Date.now();if(DATA.timeLimitSec)S.timer=setInterval(tick,1000);show()}',
  'function left(){return Math.max(0,DATA.timeLimitSec-Math.floor((Date.now()-S.t0)/1000))}',
  'function fmt(s){return Math.floor(s/60)+":"+("0"+s%60).slice(-2)}',
  'function tick(){var e=document.getElementById("tm");if(e)e.textContent=fmt(left());if(left()<=0&&!S.done){S.done=true;clearInterval(S.timer);page(DATA.fail,"","")}hintBtn()}',
  'function show(){var p=DATA.puzzles[S.i],g=p.gates[S.g],h="<div class=bar><span>第 "+(S.i+1)+" / "+DATA.puzzles.length+" 題</span>"+(DATA.timeLimitSec?"<span class=timer id=tm>"+fmt(left())+"</span>":"")+"</div><div class=card><h2>"+esc(p.title)+"</h2>";',
  'p.blocks.forEach(function(b){if(b.type==="text")h+="<div class=txt>"+esc(b.text)+"</div>";else if(b.type==="image")h+="<img src=\'"+b.src+"\'>"+(b.caption?"<div>"+esc(b.caption)+"</div>":"");else if(b.type==="audio")h+="<audio controls src=\'"+b.src+"\'></audio>";else if(b.type==="link")h+="<p><a target=_blank href=\'"+esc(b.url)+"\'>"+esc(b.label)+"</a></p>";else if(b.type==="html")h+="<iframe sandbox=\'allow-scripts allow-popups allow-forms\' style=\'height:"+(b.height||520)+"px\' data-i=\'"+p.blocks.indexOf(b)+"\'></iframe>"});',
  'h+="</div><div class=card><div>"+(p.gates.length>1?"第 "+(S.g+1)+" 步："+esc(g.label):"答案")+"</div><input id=an autocomplete=off><button id=go>送出</button><div class=msg id=ms></div><div id=hs></div><button class=ghost id=hb></button></div>";app.innerHTML=h;',
  'Array.prototype.forEach.call(app.querySelectorAll("iframe[data-i]"),function(f){f.srcdoc=p.blocks[+f.getAttribute("data-i")].html});',
  'document.getElementById("go").onclick=submit;document.getElementById("an").onkeydown=function(e){if(e.key==="Enter")submit()};document.getElementById("hb").onclick=hint;renderHints();hintBtn()}',
  'function renderHints(){var p=DATA.puzzles[S.i],e=document.getElementById("hs");if(!e)return;e.innerHTML=p.hints.slice(0,S.h).map(function(x,k){return"<div class=hint>提示 "+(k+1)+"："+esc(x.text)+(x.src?"<img src=\'"+x.src+"\'>":"")+"</div>"}).join("")}',
  'function hintBtn(){var b=document.getElementById("hb");if(!b)return;var p=DATA.puzzles[S.i];if(S.h>=p.hints.length){b.style.display="none";return}var w=(p.hints[S.h].delaySec||0)-Math.floor((Date.now()-S.ps)/1000);b.disabled=w>0;b.textContent=w>0?"提示 "+(S.h+1)+"（"+w+" 秒後可看）":"看提示 "+(S.h+1)}',
  'function hint(){S.h++;renderHints();hintBtn()}',
  'function submit(){var v=document.getElementById("an").value,p=DATA.puzzles[S.i],g=p.gates[S.g],m=document.getElementById("ms");var hv=sha256(norm(v));if(norm(v)&&g.hashes.indexOf(hv)>=0){if(S.g<p.gates.length-1){S.g++;show();document.getElementById("ms").className="msg ok";document.getElementById("ms").textContent="正確！繼續下一步"}else{S.i++;S.g=0;S.h=0;S.ps=Date.now();if(S.i>=DATA.puzzles.length){S.done=true;clearInterval(S.timer);page(DATA.success,"","")}else show()}}else{m.className="msg";m.textContent="答案不對，再想想"}}',
  'if(DATA.cover||(DATA.story&&DATA.story.length))intro(0);else begin();'
].join('\n');
