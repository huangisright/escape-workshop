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
  Codes:     ['code', 'role', 'name', 'members', 'roomId', 'created'],
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
  wrongCooldownSec: 10,     // 答錯後要等幾秒才能再答
  defaultHintDelaySec: 60,  // 新增提示時的預設秒數
  themeLabel: '主題連結（SDGs 14 永續海洋）',
  requireDigitalAndPhysical: true,
  resetPin: ''              // 玩家畫面按「重置」要輸入的密碼，空白 = 不用密碼
};

var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var MAX_JSON = 48000;

/* ============================================================
 *  入口
 * ============================================================ */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

/** 第一次使用時執行一次：建立試算表、雲端資料夾與管理者代碼 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SS_ID')) {
    Logger.log('已經設定過了。管理者代碼：' + showAdminCode());
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

/** 忘記管理者代碼時執行 */
function showAdminCode() {
  var a = readAll_('Codes').filter(function (r) { return r.role === 'admin'; })[0];
  var code = a ? a.code : '（找不到，請重新執行 setup）';
  Logger.log('管理者代碼：' + code);
  return code;
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
  try { return fn(); } finally { lock.releaseLock(); }
}

function readAll_(name) {
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var cols = SHEETS[name];
  var vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return vals.map(function (r, i) {
    var o = { _row: i + 2 };
    cols.forEach(function (c, j) {
      var v = r[j];
      if (typeof v === 'string' && v.charAt(0) === "'") v = v.substring(1);
      o[c] = v;
    });
    return o;
  });
}
function appendRow_(name, obj) {
  var cols = SHEETS[name];
  var sh = sheet_(name);
  sh.appendRow(cols.map(function (c) { return c === 'json' || c === 'state' ? (obj[c] || '') : cellSafe_(obj[c]); }));
  return sh.getLastRow();
}
function writeRow_(name, row, obj) {
  var cols = SHEETS[name];
  sheet_(name).getRange(row, 1, 1, cols.length).setValues([cols.map(function (c) {
    return c === 'json' || c === 'state' ? (obj[c] || '') : cellSafe_(obj[c]);
  })]);
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
  return readAll_(name).map(function (r) {
    var d = {};
    try { d = JSON.parse(r.json); } catch (e) { d = { id: r.id, broken: true }; }
    d._row = r._row;
    return d;
  });
}
function getDoc_(name, id) {
  var rows = readAll_(name);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === id) {
      var d = JSON.parse(rows[i].json);
      d._row = rows[i]._row;
      return d;
    }
  }
  return null;
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
  var rows = readAll_('Codes');
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
  return p.roomId === acct.roomId;
}
function canEditPuzzle_(acct, p, room) {
  if (acct.role === 'admin') return true;
  if (acct.role === 'teacher') return p.roomId === BANK && p.ownerCode === acct.code;
  return p.roomId === acct.roomId && room && room.status === 'draft';
}
function canEditRoom_(acct, room) {
  if (acct.role === 'admin') return true;
  return acct.role === 'group' && room.id === acct.roomId && room.status === 'draft';
}

/* ============================================================
 *  登入與讀取
 * ============================================================ */

function login(code) {
  var a = account_(code);
  return {
    code: a.code, role: a.role, name: a.name, members: a.membersList,
    roomId: a.roomId, settings: settings_(), appUrl: appUrl_()
  };
}
function appUrl_() {
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
function roomPuzzles_(room) {
  var all = allDocs_('Puzzles');
  var byId = {};
  all.forEach(function (p) { byId[p.id] = p; });
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
    id: newId_('p'), roomId: a.role === 'teacher' ? BANK : a.roomId, ownerCode: a.code,
    author: a.role === 'teacher' ? a.name : '', title: '', kind: '', estMinutes: '',
    steps: [{ get: '', act: '', result: '', checkpoint: '' }],
    blocks: [], answer: '', hints: [{ text: '', delaySec: s.defaultHintDelaySec }],
    props: [], themeLink: '', scienceBasis: '', reskinCheck: '', rev: 0, deleted: false
  };
}

function newPuzzle(code) {
  var a = account_(code);
  needRole_(a, ['group', 'teacher']);
  return withLock_(function () {
    var s = settings_();
    var p = blankPuzzle_(a, s);
    if (a.role === 'group') {
      var room = getDoc_('Rooms', a.roomId);
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
  return withLock_(function () {
    var s = settings_();
    var p = getDoc_('Puzzles', data.id);
    if (!p || p.deleted) throw new Error('找不到這一題，可能已被刪除');
    var room = p.roomId === BANK ? null : getDoc_('Rooms', p.roomId);
    if (!canEditPuzzle_(a, p, room)) {
      if (room && room.status !== 'draft') throw new Error('已送審，不能修改。要修改請找老師開放');
      throw new Error('只能修改自己的題目');
    }
    if ((data.rev || 0) !== (p.rev || 0)) {
      return { conflict: true, puzzle: withChecks_(p, s, p.roomId === BANK ? 'teacher' : 'group') };
    }
    PUZZLE_FIELDS.forEach(function (f) { if (data[f] !== undefined) p[f] = data[f]; });
    if (a.role === 'teacher') p.author = a.name;
    p.rev = (p.rev || 0) + 1;
    putDoc_('Puzzles', p);
    var out = { puzzle: withChecks_(p, s, p.roomId === BANK ? 'teacher' : 'group') };
    if (room) {
      var members = room.kind === 'group' ? membersOfRoom_(room) : [];
      out.roomChecks = checkRoom_(room, roomPuzzles_(room), s, members, false);
    }
    return out;
  });
}

function deletePuzzle(code, id) {
  var a = account_(code);
  return withLock_(function () {
    var p = getDoc_('Puzzles', id);
    if (!p) return true;
    var room = p.roomId === BANK ? null : getDoc_('Rooms', p.roomId);
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
    var roomId = a.role === 'group' ? a.roomId : null;
    if (!roomId) throw new Error('只有分組可以調整順序');
    var room = getDoc_('Rooms', roomId);
    if (!canEditRoom_(a, room)) throw new Error('已送審，不能調整順序');
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

var ROOM_FIELDS = ['title', 'cover', 'story', 'success', 'fail', 'mindmap'];
var ROOM_ADMIN_FIELDS = ['timeLimitMin', 'location', 'groupName', 'finale', 'skipMin'];

function saveRoom(code, data) {
  var a = account_(code);
  return withLock_(function () {
    var room = getDoc_('Rooms', data.id);
    if (!room) throw new Error('找不到密室');
    if (!canEditRoom_(a, room)) {
      if (a.role === 'group' && room.id === a.roomId) throw new Error('已送審，不能修改。要修改請找老師開放');
      throw new Error('沒有權限修改這個密室');
    }
    if ((data.rev || 0) !== (room.rev || 0)) return { conflict: true, room: stripRow_(room) };
    ROOM_FIELDS.forEach(function (f) { if (data[f] !== undefined) room[f] = data[f]; });
    if (a.role === 'admin') ROOM_ADMIN_FIELDS.forEach(function (f) { if (data[f] !== undefined) room[f] = data[f]; });
    room.rev = (room.rev || 0) + 1;
    putDoc_('Rooms', room);
    var s = settings_();
    return {
      room: stripRow_(room),
      roomChecks: checkRoom_(room, roomPuzzles_(room), s, membersOfRoom_(room), false)
    };
  });
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
    fragments: [], skipMin: 0, vaultIds: []
  };
}
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
function membersOfRoom_(room) {
  if (room.kind !== 'group') return [];
  var c = readAll_('Codes').filter(function (r) { return r.code === room.ownerCode; })[0];
  return c ? String(c.members || '').split(/[,，、\s]+/).filter(function (x) { return x; }) : [];
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
  if (a.role === 'group' && roomId !== a.roomId) throw new Error('只能上傳到自己組的密室');
  if (a.role === 'teacher' && roomId !== BANK) throw new Error('老師的檔案只能放在題庫');
  if (a.role === 'group') {
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
  var name = roomId === BANK ? '老師題庫' : (function () {
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
  if (a.role === 'group' && row.roomId !== a.roomId) throw new Error('沒有權限讀取這個檔案');
  if (a.role === 'teacher' && row.roomId !== BANK) throw new Error('沒有權限讀取這個檔案');
  return fileData_(fileId, row.mime);
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

  var hints = (p.hints || []).filter(function (h) { return String(h.text || '').trim(); });
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
  needRole_(a, ['group']);
  return withLock_(function () {
    var s = settings_();
    var room = getDoc_('Rooms', a.roomId);
    if (room.status !== 'draft') throw new Error('已經送審過了');
    var puzzles = roomPuzzles_(room);
    var checks = checkRoom_(room, puzzles, s, a.membersList, true);
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
  'finale', 'fragments', 'skipMin'];
var SNAP_PUZZLE_FIELDS = ['id', 'title', 'author', 'kind', 'estMinutes', 'steps', 'blocks', 'answer', 'hints', 'props'];

function makeSnapshot_(room, test) {
  var pick = function (o, f) { var r = {}; f.forEach(function (k) { r[k] = o[k]; }); return r; };
  var snap = {
    room: pick(room, SNAP_ROOM_FIELDS),
    puzzles: roomPuzzles_(room).map(function (p) { return pick(p, SNAP_PUZZLE_FIELDS); }),
    vault: (room.vaultIds || []).length ? roomVault_(room).map(function (p) { return pick(p, SNAP_PUZZLE_FIELDS); }) : []
  };
  if (!snap.puzzles.length) throw new Error('這個密室還沒有題目');
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
  var rows = readAll_('Plays');
  for (var i = rows.length - 1; i >= 0; i--) if (rows[i].id === playId) {
    var r = rows[i];
    r.st = JSON.parse(r.state || '{}');
    return r;
  }
  throw new Error('找不到這場遊戲，請重新開始');
}
function savePlay_(r) {
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
    finale: finaleOn_(snap), skipMin: Number(r.skipMin) || 0, vaultTotal: (snap.vault || []).length
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
/** 目前這關過了（解開或跳過）：往下一關走。回傳拿到的碎片（沒有就是 null） */
function advance_(r, snap, skipped) {
  var ph = phase_(r.st);
  var fragment = null;
  if (ph === 'main') {
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
function playStart(playCode, team) {
  playCode = String(playCode || '').trim().toUpperCase();
  team = String(team || '').trim().substring(0, 30);
  if (!team) throw new Error('請輸入隊名');
  var room = allDocs_('Rooms').filter(function (r) { return r.published && String(r.playCode).toUpperCase() === playCode; })[0];
  if (!room) throw new Error('遊戲代碼不正確，或這個密室還沒開放');
  return startPlay_(room, room.publishedVersion, team, false);
}

/** 作者或管理者試玩（用目前內容做一份測試快照，不計入數據） */
function startTestPlay(code, roomId) {
  var a = account_(code);
  if (a.role === 'group') roomId = a.roomId;
  else needRole_(a, ['admin']);
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var version = withLock_(function () { return makeSnapshot_(room, true); });
  return startPlay_(room, version, '試玩-' + a.name, true);
}

function startPlay_(room, version, team, test) {
  var snap = loadSnapshot_(version);
  var play = {
    id: newId_('g'), roomId: room.id, team: team, test: !!test, started: '', ended: '', result: '',
    st: { snap: version, index: 0, gate: 0, puzzleStart: 0, startMs: 0, hints: 0, cooldownUntil: 0, wrong: 0,
          phase: 'main', fragments: [], skips: 0, penaltySec: 0, vi: 0, vaultSolved: 0, escapeSec: null }
  };
  withLock_(function () {
    play.state = JSON.stringify(play.st);
    play._row = appendRow_('Plays', play);
  });
  var intro = introOf_(snap);
  intro.playId = play.id;
  intro.test = !!test;
  intro.playCode = test ? '' : (room.playCode || '');
  intro.pinRequired = !!String(settings_().resetPin || '').trim();
  return intro;
}

/** 重新整理或重開平板後接著玩：回傳封面說明，以及開始了沒、目前進度 */
function playResume(playId) {
  return withLock_(function () {
    var r = findPlay_(playId);
    if (r.result === 'reset') throw new Error('這場遊戲已經重置了');
    checkTimeout_(r);
    var snap = loadSnapshot_(r.st.snap);
    var intro = introOf_(snap);
    var room = getDoc_('Rooms', r.roomId);
    intro.playId = r.id;
    intro.test = r.test === true || r.test === '是';
    intro.playCode = intro.test ? '' : ((room && room.playCode) || '');
    intro.pinRequired = !!String(settings_().resetPin || '').trim();
    intro.team = r.team;
    return { intro: intro, begun: !!r.st.startMs, state: r.st.startMs ? stateOf_(r, null) : null };
  });
}

/** 重置：放棄這場遊戲（不計入數據），讓同一台平板重新開始 */
function playReset(playId, pin) {
  var need = String(settings_().resetPin || '').trim();
  if (need && String(pin || '').trim() !== need) throw new Error('重置密碼不對');
  return withLock_(function () {
    var r = findPlay_(playId);
    if (r.result === 'escaped' && phase_(r.st) === 'vault') {
      // 已經逃脫、還在寶庫：保留逃脫成績，只結束寶庫
      r.st.phase = 'done';
      savePlay_(r);
      logEvent_(r, '', 'vault-end', 'reset', Math.round(elapsedMs_(r) / 1000));
    } else if (!r.result) {
      r.result = 'reset';
      r.ended = nowStr_();
      savePlay_(r);
      logEvent_(r, '', 'reset', '', r.st.startMs ? Math.round(elapsedMs_(r) / 1000) : 0);
    }
    // 已經結束（逃脫、時間到、已重置）的場次不改，數據照常保留
    return true;
  });
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
    }
    return stateOf_(r, null);
  });
}

/** havePuzzleId：前端已經有這題內容時就不重傳圖片 */
function playState(playId, havePuzzleId) {
  return withLock_(function () {
    var r = findPlay_(playId);
    checkTimeout_(r);
    return stateOf_(r, havePuzzleId);
  });
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
    escapeSec: r.st.escapeSec === undefined ? null : r.st.escapeSec
  };
  if (out.over) {
    if (out.escapeSec !== null) out.elapsedSec = out.escapeSec;
    var pg = r.result === 'escaped' ? snap.room.success : snap.room.fail;
    out.ending = mediaPage_(pg);
    var item = function (p, i) { return { id: p.id, no: i + 1, title: p.title }; };
    out.rateList = r.result === 'escaped'
      ? snap.puzzles.map(item)
      : snap.puzzles.slice(0, Math.min(snap.puzzles.length, r.st.index + 1)).map(item);
    if (r.result === 'escaped' && ph === 'done') {
      vault.slice(0, Math.min(vault.length, (r.st.vi || 0) + 1)).forEach(function (p, i) {
        out.rateList.push({ id: p.id, no: i + 1, title: p.title, label: '寶庫 ' + (i + 1) });
      });
    }
    return out;
  }
  var p = current_(snap, r.st);
  var gates = gates_(p);
  var since = Math.floor((nowMs_() - r.st.puzzleStart) / 1000);
  var visibleHints = (p.hints || []).filter(function (h) { return String(h.text || '').trim(); });
  out.puzzleId = p.id;
  out.title = p.title;
  out.gate = r.st.gate;
  out.gateCount = gates.length;
  out.gateLabel = gates[r.st.gate].label;
  out.hintsShown = visibleHints.slice(0, r.st.hints).map(function (h) { return h.text; });
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
    var hints = (p.hints || []).filter(function (h) { return String(h.text || '').trim(); });
    var since = Math.floor((nowMs_() - r.st.puzzleStart) / 1000);
    if (r.st.hints < hints.length && since >= (Number(hints[r.st.hints].delaySec) || 0)) {
      r.st.hints++;
      logEvent_(r, p.id, 'hint', r.st.hints, since);
      savePlay_(r);
    }
    return { state: stateOf_(r, p.id) };
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
  var rooms = allDocs_('Rooms').map(function (room) {
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
  return {
    settings: s, appUrl: appUrl_(),
    codes: codes.map(function (c) { return { code: c.code, role: c.role, name: c.name, members: c.members, roomId: c.roomId }; }),
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

function adminCreateTeacherRoom(code, title) {
  var a = account_(code);
  needRole_(a, ['admin']);
  return withLock_(function () {
    var room = blankRoom_('teacher', a.code, String(title || '示範密室').trim(), settings_());
    putDoc_('Rooms', room);
    return stripRow_(room);
  });
}
/** extra（選用）：{ fragments: 與 ids 同順序的碎片, vaultIds: 寶庫題目 } */
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
  var room = p.roomId === BANK ? null : getDoc_('Rooms', p.roomId);
  x.editable = canEditPuzzle_(a, p, room);
  return x;
}
function getRoom(code, roomId) {
  var a = account_(code);
  if (a.role === 'group') roomId = a.roomId;
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
  return allDocs_('Rooms').map(function (room) {
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
    var total = 0, vaultTotal = 0;
    try { var sn = loadSnapshot_(st.snap); total = sn.puzzles.length; vaultTotal = (sn.vault || []).length; } catch (e) { }
    var running = !r.result || (r.result === 'escaped' && st.phase === 'vault');
    var penalty = (Number(st.penaltySec) || 0) * 1000;
    return {
      team: r.team, room: rooms[r.roomId] || r.roomId, test: r.test === '是' || r.test === true,
      index: st.index, total: total, result: r.result || '', started: r.started,
      elapsedSec: !st.startMs ? 0 : (st.escapeSec !== undefined && st.escapeSec !== null && !running) ? st.escapeSec
        : Math.floor(((running ? nowMs_() : new Date(r.ended).getTime()) - st.startMs + penalty) / 1000),
      hints: st.hints, wrong: st.wrong || 0,
      phase: st.phase || 'main', skips: st.skips || 0, escapeSec: st.escapeSec === undefined ? null : st.escapeSec,
      vaultIndex: st.vi || 0, vaultSolved: st.vaultSolved || 0, vaultTotal: vaultTotal
    };
  }).reverse();
}

/** 單一密室的遊玩數據（不含試玩） */
function adminStats(code, roomId) {
  var a = account_(code);
  needRole_(a, ['admin']);
  var room = getDoc_('Rooms', roomId);
  if (!room) throw new Error('找不到密室');
  var plays = readAll_('Plays').filter(function (r) { return r.roomId === roomId && !(r.test === '是' || r.test === true) && r.started && r.result !== 'reset'; });
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
          hints: (p.hints || []).filter(function (h) { return String(h.text || '').trim(); }),
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
  '.msg{min-height:26px;margin-top:8px;color:#ff9b8a}.ok{color:#8fe0a6}.hint{border-left:3px solid #f3c969;padding:6px 12px;margin:8px 0;color:#f6e3b3}',
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
  'function renderHints(){var p=DATA.puzzles[S.i],e=document.getElementById("hs");if(!e)return;e.innerHTML=p.hints.slice(0,S.h).map(function(x,k){return"<div class=hint>提示 "+(k+1)+"："+esc(x.text)+"</div>"}).join("")}',
  'function hintBtn(){var b=document.getElementById("hb");if(!b)return;var p=DATA.puzzles[S.i];if(S.h>=p.hints.length){b.style.display="none";return}var w=(p.hints[S.h].delaySec||0)-Math.floor((Date.now()-S.ps)/1000);b.disabled=w>0;b.textContent=w>0?"提示 "+(S.h+1)+"（"+w+" 秒後可看）":"看提示 "+(S.h+1)}',
  'function hint(){S.h++;renderHints();hintBtn()}',
  'function submit(){var v=document.getElementById("an").value,p=DATA.puzzles[S.i],g=p.gates[S.g],m=document.getElementById("ms");var hv=sha256(norm(v));if(norm(v)&&g.hashes.indexOf(hv)>=0){if(S.g<p.gates.length-1){S.g++;show();document.getElementById("ms").className="msg ok";document.getElementById("ms").textContent="正確！繼續下一步"}else{S.i++;S.g=0;S.h=0;S.ps=Date.now();if(S.i>=DATA.puzzles.length){S.done=true;clearInterval(S.timer);page(DATA.success,"","")}else show()}}else{m.className="msg";m.textContent="答案不對，再想想"}}',
  'if(DATA.cover||(DATA.story&&DATA.story.length))intro(0);else begin();'
].join('\n');
