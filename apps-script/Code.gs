// platform/apps-script/Code.gs
// 密室平台後端：綁在「控制台」試算表上的 Google Apps Script。
// 同一個專案裡還要有 Engine.gs（內容 = platform/engine.js），兩邊共用同一套判定邏輯。
//
// 控制台試算表的分頁：
//   設定     遊戲名稱、時限、序章、終章、監看密碼…（key / value）
//   老師     每位老師一列：姓名、Email、出題試算表、版本、測試代碼
//   題庫     老師送出且檢查通過的題目（最新版）
//   組裝     主辦老師排主線 5 題、碎片、過場，和寶庫
//   組別     學生的組別代碼
//   進度     各組的遊戲進度（系統寫入，不要手動改）
//   正式版   按「組裝正式版」時凍結的題目（系統寫入）

var SHEETS = {
  settings: '設定',
  teachers: '老師',
  bank: '題庫',
  assembly: '組裝',
  teams: '組別',
  progress: '進度',
  release: '正式版'
};

var QUESTION_SHEET = '題目';
var REPORT_SHEET = '建置報告';
var CACHE_KEY = 'release-content';

var DEFAULT_SETTINGS = [
  ['遊戲名稱', '黃金城密室：氣候變遷'],
  ['時限（分鐘）', 90],
  ['跳過扣時（分鐘）', 5],
  ['監看密碼', ''],
  ['學生網址', '（GitHub Pages 上 platform/index.html 的網址）'],
  ['序章', '傳說中的黃金城，因為海水一年年上漲，沉進了海底……'],
  ['終章故事', '五塊碎片拼回大門上，門上浮現五個空格。打開線索簿，把碎片依照拿到的順序輸入。'],
  ['終章密碼類型', '數字'],
  ['終章密碼', ''],
  ['終章提示', '線索簿上的碎片，從第一塊讀到最後一塊。'],
  ['終章建議時間（分鐘）', 10],
  ['逃脫成功劇情', '大門緩緩打開，你們逃出來了！還有時間的話，寶庫正等著你們。']
];

// =====================================================================
// 選單
// =====================================================================

function onOpen() {
  SpreadsheetApp.getUi().createMenu('密室平台')
    .addItem('1. 初始化控制台', 'initControl')
    .addItem('2. 幫老師建立出題試算表', 'createTeacherSheets')
    .addItem('3. 建立／更新送出表單', 'setupSubmitForm')
    .addSeparator()
    .addItem('重新建置某位老師的題目', 'rebuildPrompt')
    .addItem('組裝正式版', 'assembleRelease')
    .addItem('清除所有組別進度', 'resetProgress')
    .addToUi();
}

function control() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('CONTROL_ID'));
}

function sheet(name) {
  var sh = control().getSheetByName(name);
  if (!sh) throw new Error('找不到分頁「' + name + '」，請先執行「初始化控制台」');
  return sh;
}

function ensureSheet(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (header && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function initControl() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('CONTROL_ID', ss.getId());

  var st = ensureSheet(ss, SHEETS.settings, ['項目', '內容']);
  if (st.getLastRow() === 1) {
    st.getRange(2, 1, DEFAULT_SETTINGS.length, 2).setValues(DEFAULT_SETTINGS);
    setSetting('監看密碼', randomToken(6));
    st.setColumnWidth(2, 520);
  }
  ensureSheet(ss, SHEETS.teachers, ['姓名', 'Email', '出題試算表', '版本', '測試代碼', '最後送出']);
  ensureSheet(ss, SHEETS.bank, ['題目ID', '老師', '版本', '關卡順序', '主題', '密碼類型', '難度', '預估時間', '題目資料']);
  var asm = ensureSheet(ss, SHEETS.assembly, ['位置', '題目ID', '碎片', '過場文字']);
  if (asm.getLastRow() === 1) {
    asm.getRange(2, 1, 8, 1).setValues([['主線1'], ['主線2'], ['主線3'], ['主線4'], ['主線5'], ['寶庫'], ['寶庫'], ['寶庫']]);
    asm.getRange(2, 3, 5, 1).setNumberFormat('@');
  }
  ensureSheet(ss, SHEETS.teams, ['組別代碼', '組名（可空白）']);
  ensureSheet(ss, SHEETS.progress, ['組別代碼', '進度資料', '更新時間']);
  ensureSheet(ss, SHEETS.release, ['正式版內容（系統寫入）']);
  var first = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  SpreadsheetApp.getUi().alert('控制台已建立。下一步：在「老師」分頁填姓名與 Email，再按「幫老師建立出題試算表」。');
}

// =====================================================================
// 設定
// =====================================================================

function readSettings() {
  var values = sheet(SHEETS.settings).getDataRange().getValues();
  var map = {};
  values.slice(1).forEach(function (r) { if (r[0]) map[String(r[0]).trim()] = r[1]; });
  return map;
}

function setSetting(key, value) {
  var sh = sheet(SHEETS.settings);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function randomToken(len) {
  var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  var s = '';
  for (var i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// =====================================================================
// 老師的出題試算表
// =====================================================================

function teacherRows() {
  var sh = sheet(SHEETS.teachers);
  var values = sh.getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0]).trim();
    if (!name) continue;
    rows.push({ row: i + 1, name: name, email: String(values[i][1]).trim(), url: String(values[i][2]).trim(),
      version: Number(values[i][3]) || 0, token: String(values[i][4]).trim() });
  }
  return rows;
}

function findTeacher(name) {
  var t = teacherRows().filter(function (r) { return r.name === name; })[0];
  if (!t) throw new Error('「老師」分頁裡沒有「' + name + '」');
  return t;
}

function createTeacherSheets() {
  var title = readSettings()['遊戲名稱'] || '密室';
  var made = [];
  teacherRows().forEach(function (t) {
    if (t.url) return;
    var ss = SpreadsheetApp.create(title + '｜出題｜' + t.name);
    setupTeacherSpreadsheet(ss);
    if (t.email) {
      try { ss.addEditor(t.email); } catch (e) { /* Email 有誤時仍建立，主辦老師可以手動分享 */ }
    }
    var tsh = sheet(SHEETS.teachers);
    tsh.getRange(t.row, 3).setValue(ss.getUrl());
    if (!t.token) tsh.getRange(t.row, 5).setValue(randomToken(10));
    made.push(t.name);
  });
  SpreadsheetApp.getUi().alert(made.length ? '已建立並分享：' + made.join('、') : '每位老師都已經有出題試算表了。');
}

function setupTeacherSpreadsheet(ss) {
  var sh = ss.getSheets()[0];
  sh.setName(QUESTION_SHEET);
  var labels = Engine.COLUMNS.map(function (c) { return c.label; });
  var n = labels.length;
  sh.getRange(1, 1, 1, n).setValues([labels]).setFontWeight('bold').setBackground('#fff2cc');
  sh.setFrozenRows(1);
  sh.getRange(2, 1, 200, n).setWrap(true).setVerticalAlignment('top');
  [70, 110, 90, 360, 160, 140, 220, 220, 110, 70, 220, 220].forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });

  var col = function (key) { return Engine.COLUMNS.map(function (c) { return c.key; }).indexOf(key) + 1; };
  var letter = function (key) { return String.fromCharCode(64 + col(key)); };
  var rows = 200;

  // 下拉選單
  sh.getRange(2, col('type'), rows).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(Engine.TYPES, true).setAllowInvalid(false).build());
  sh.getRange(2, col('difficulty'), rows).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(Engine.DIFFICULTIES, true).setAllowInvalid(false).build());
  sh.getRange(2, col('estMin'), rows).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThan(0).setAllowInvalid(false).setHelpText('填一組學生大約要解幾分鐘').build());

  // 通關密碼要符合密碼類型，填錯當場跳出警告
  var t = '$' + letter('type') + '2';
  var a = 'TO_TEXT(' + letter('answer') + '2)';
  var formula = '=OR(' + t + '="文字",' + t + '="",' +
    'AND(' + t + '="數字",REGEXMATCH(' + a + ',"^[0-9０-９|｜ ]+$")),' +
    'AND(' + t + '="方向",REGEXMATCH(' + a + ',"^[上下左右↑↓←→|｜ ]+$")),' +
    'AND(' + t + '="顏色",REGEXMATCH(' + a + ',"^[' + Engine.COLORS.join('') + '|｜ ]+$")))';
  sh.getRange(2, col('answer'), rows).setNumberFormat('@').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied(formula).setAllowInvalid(false)
    .setHelpText('通關密碼要符合密碼類型：數字只能有數字；方向用上下左右；顏色用' + Engine.COLORS.join('') + '。多種寫法用 | 分隔。').build());

  // 必填欄位都填好，整列變綠色
  var required = Engine.COLUMNS.filter(function (c) { return c.required; })
    .map(function (c) { return '$' + String.fromCharCode(64 + col(c.key)) + '2<>""'; });
  var rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(' + required.join(',') + ')')
    .setBackground('#d9ead3')
    .setRanges([sh.getRange(2, 1, rows, n)])
    .build();
  sh.setConditionalFormatRules([rule]);

  var help = ss.insertSheet('填寫說明');
  help.getRange(1, 1, 9, 1).setValues([
    ['怎麼出題'],
    ['1. 在「題目」分頁一列填一題。必填欄位都填好，整列會變綠色。'],
    ['2. 每題的故事要自成一段，不要寫「剛才在上一關看到的……」，題目位置可能會調動。'],
    ['3. 通關密碼有多種寫法時用 | 分隔，例如 42|四十二。系統會忽略全形半形、空白、大小寫，但不會忽略標點。'],
    ['4. 數字密碼避免 3 位數以內，學生會用猜的。提示要指方向，不要直接給答案。'],
    ['5. 圖片欄貼 Google 雲端硬碟的分享連結（權限設為「知道連結的人可以查看」）。'],
    ['6. 填好後打開送出表單，選你的名字按送出。約一分鐘後會多一個「建置報告」分頁。'],
    ['7. 通過的話，報告裡有測試網址，可以在 iPad 上自己走一遍（可看答案、跳題）。'],
    ['8. 要修改：改這份試算表、再送出一次。示範密室要等主辦老師重新組裝才會換成新版。']
  ]);
  help.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  help.setColumnWidth(1, 760);
}

// =====================================================================
// 送出表單 → 自動檢查、上架
// =====================================================================

function setupSubmitForm() {
  var props = PropertiesService.getScriptProperties();
  var names = teacherRows().map(function (t) { return t.name; });
  if (!names.length) throw new Error('請先在「老師」分頁填老師姓名');
  var form;
  var id = props.getProperty('FORM_ID');
  if (id) {
    try { form = FormApp.openById(id); } catch (e) { form = null; }
  }
  if (!form) {
    form = FormApp.create((readSettings()['遊戲名稱'] || '密室') + '｜送出題目');
    form.setDescription('選你的名字按送出，系統會檢查你的出題試算表並上架。約一分鐘後看試算表的「建置報告」分頁。');
    form.addListItem().setTitle('你的名字').setRequired(true);
    props.setProperty('FORM_ID', form.getId());
    ScriptApp.newTrigger('onSubmitForm').forForm(form).onFormSubmit().create();
  }
  form.getItems(FormApp.ItemType.LIST)[0].asListItem().setChoiceValues(names);
  SpreadsheetApp.getUi().alert('送出表單網址（發給老師們）：\n' + form.getPublishedUrl());
}

function onSubmitForm(e) {
  var name = e.response.getItemResponses()[0].getResponse();
  buildTeacher(String(name).trim());
}

function rebuildPrompt() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('重新建置', '輸入老師姓名：', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var out = buildTeacher(res.getResponseText().trim());
  ui.alert(out.passed ? '通過，版本 ' + out.version : '沒通過，問題寫在該老師的「建置報告」分頁');
}

function readTeacherQuestions(url) {
  var sh = SpreadsheetApp.openByUrl(url).getSheetByName(QUESTION_SHEET);
  if (!sh) throw new Error('出題試算表裡找不到「' + QUESTION_SHEET + '」分頁');
  var values = sh.getDataRange().getDisplayValues();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (r.join('').trim() === '') continue;
    var obj = { rowNumber: i + 1 };
    Engine.COLUMNS.forEach(function (c, j) { obj[c.key] = r[j]; });
    rows.push(obj);
  }
  return rows;
}

function buildTeacher(name) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var t = findTeacher(name);
    if (!t.url) throw new Error(name + ' 還沒有出題試算表');
    var rows = readTeacherQuestions(t.url);
    var problems = [];
    var seen = {};
    if (!rows.length) problems.push({ row: '—', level: '錯誤', text: '「題目」分頁沒有任何題目' });
    rows.forEach(function (r) {
      var res = Engine.validateRow(r);
      res.errors.forEach(function (x) { problems.push({ row: r.rowNumber, level: '錯誤', text: x }); });
      res.warnings.forEach(function (x) { problems.push({ row: r.rowNumber, level: '提醒', text: x }); });
      var o = String(r.order).trim();
      if (o && seen[o]) problems.push({ row: r.rowNumber, level: '錯誤', text: '關卡順序 ' + o + ' 和第 ' + seen[o] + ' 列重複' });
      seen[o] = r.rowNumber;
    });
    var passed = problems.filter(function (p) { return p.level === '錯誤'; }).length === 0;
    var version = t.version;
    var token = t.token || randomToken(10);
    if (passed) {
      version += 1;
      var questions = rows.map(function (r) { return Engine.buildQuestion(r, name); })
        .sort(function (a, b) { return a.order - b.order; });
      replaceBank(name, version, questions);
      var tsh = sheet(SHEETS.teachers);
      tsh.getRange(t.row, 4, 1, 3).setValues([[version, token, new Date()]]);
    }
    writeReport(t.url, { passed: passed, version: version, token: token, problems: problems, count: rows.length });
    return { passed: passed, version: version };
  } finally {
    lock.releaseLock();
  }
}

function replaceBank(name, version, questions) {
  var sh = sheet(SHEETS.bank);
  var values = sh.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][1]) === name) sh.deleteRow(i + 1);
  }
  var rows = questions.map(function (q) {
    return [q.id, name, version, q.order, q.theme, q.type, q.difficulty, q.estMin, JSON.stringify(q)];
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function bankQuestions(filterTeacher) {
  var values = sheet(SHEETS.bank).getDataRange().getValues();
  var map = {};
  var list = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    if (filterTeacher && String(values[i][1]) !== filterTeacher) continue;
    var q = JSON.parse(values[i][8]);
    map[q.id] = q;
    list.push(q);
  }
  return { map: map, list: list };
}

function testUrl(token) {
  var base = String(readSettings()['學生網址'] || '').trim();
  var api = ScriptApp.getService().getUrl();
  if (!/^https?:\/\//.test(base)) return '（請主辦老師在「設定」分頁填「學生網址」）';
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'test=' + token + '&api=' + encodeURIComponent(api);
}

function writeReport(url, r) {
  var ss = SpreadsheetApp.openByUrl(url);
  var sh = ss.getSheetByName(REPORT_SHEET) || ss.insertSheet(REPORT_SHEET);
  sh.clear();
  var head = [
    ['結果', r.passed ? '通過' : '沒通過'],
    ['版本', r.passed ? r.version : '（沿用上一版 ' + r.version + '）'],
    ['檢查時間', new Date()],
    ['題數', r.count],
    ['測試網址', r.passed ? testUrl(r.token) : '修好下面的錯誤後再送出一次']
  ];
  sh.getRange(1, 1, head.length, 2).setValues(head);
  sh.getRange(1, 1, head.length, 1).setFontWeight('bold');
  sh.getRange(1, 2).setFontWeight('bold').setFontColor(r.passed ? '#1e7b34' : '#c0392b');
  var start = head.length + 2;
  if (r.problems.length) {
    var rows = [['列', '類型', '要修改的地方']].concat(r.problems.map(function (p) { return [p.row, p.level, p.text]; }));
    sh.getRange(start, 1, rows.length, 3).setValues(rows);
    sh.getRange(start, 1, 1, 3).setFontWeight('bold');
  } else {
    sh.getRange(start, 1).setValue('沒有發現問題。');
  }
  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 90);
  sh.setColumnWidth(3, 560);
  ss.setActiveSheet(sh);
}

// =====================================================================
// 組裝正式版
// =====================================================================

function settingsContent(s) {
  return {
    title: String(s['遊戲名稱'] || '密室'),
    settings: { timeLimitMin: Number(s['時限（分鐘）']) || 90, skipPenaltyMin: Number(s['跳過扣時（分鐘）']) || 0 },
    prologue: String(s['序章'] || ''),
    finale: {
      story: String(s['終章故事'] || ''),
      type: String(s['終章密碼類型'] || '數字'),
      answer: String(s['終章密碼'] || ''),
      hint: String(s['終章提示'] || ''),
      estMin: Number(s['終章建議時間（分鐘）']) || 10,
      success: String(s['逃脫成功劇情'] || '')
    }
  };
}

function assembleRelease() {
  var ui = SpreadsheetApp.getUi();
  var bank = bankQuestions().map;
  var values = sheet(SHEETS.assembly).getDataRange().getDisplayValues();
  var main = [];
  var vault = [];
  var errors = [];
  for (var i = 1; i < values.length; i++) {
    var pos = String(values[i][0]).trim();
    var id = String(values[i][1]).trim();
    if (!pos || !id) continue;
    var q = bank[id];
    if (!q) { errors.push('第 ' + (i + 1) + ' 列：題庫裡沒有「' + id + '」'); continue; }
    if (pos.indexOf('寶庫') === 0) {
      vault.push(q);
    } else {
      var fragment = String(values[i][2]).trim();
      if (!fragment) errors.push('第 ' + (i + 1) + ' 列：主線題目要填碎片');
      q.fragment = fragment;
      q.transition = String(values[i][3] || '');
      main.push(q);
    }
  }
  if (!main.length) errors.push('主線至少要有一題');
  var content = settingsContent(readSettings());
  if (content.finale.answer === '' && content.finale.type === '數字' && main.some(function (q) { return !/^\d+$/.test(q.fragment); })) {
    errors.push('終章密碼類型是數字、終章密碼留白（= 碎片接起來），所以碎片都要是數字');
  }
  if (errors.length) { ui.alert('還不能組裝：\n' + errors.join('\n')); return; }

  content.id = 'release-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss');
  content.main = main;
  content.vault = Engine.sortByDifficulty(vault);

  var json = JSON.stringify(content);
  var sh = sheet(SHEETS.release);
  sh.clear();
  var chunks = [];
  for (var k = 0; k < json.length; k += 40000) chunks.push([json.slice(k, k + 40000)]);
  sh.getRange(1, 1, chunks.length, 1).setValues(chunks);
  CacheService.getScriptCache().remove(CACHE_KEY);

  var msg = '組裝完成：主線 ' + main.length + ' 題、寶庫 ' + vault.length + ' 題。\n終章密碼：' + Engine.finaleAnswer(content);
  if (sheet(SHEETS.progress).getLastRow() > 1) msg += '\n\n「進度」分頁還有舊的組別紀錄，正式開始前請按「清除所有組別進度」。';
  ui.alert(msg);
}

function releaseContent() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_KEY);
  if (hit) return JSON.parse(hit);
  var sh = sheet(SHEETS.release);
  if (sh.getLastRow() === 0) throw new Error('主辦老師還沒有組裝正式版');
  var json = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return r[0]; }).join('');
  if (json.length < 90000) cache.put(CACHE_KEY, json, 600);
  return JSON.parse(json);
}

function resetProgress() {
  var ui = SpreadsheetApp.getUi();
  if (ui.alert('確定要清除所有組別的進度？', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  var sh = sheet(SHEETS.progress);
  if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1);
}

// =====================================================================
// 網頁應用程式 API（學生 iPad、監看頁、老師測試網址都呼叫這裡）
// =====================================================================

function doGet() {
  return json({ ok: true, message: '密室平台運作中' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, message: '請求格式錯誤' });
  }
  try {
    return json(route(req));
  } catch (err) {
    return json({ ok: false, message: String(err.message || err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function route(req) {
  switch (req.action) {
    case 'join': return apiJoin(String(req.team || '').trim());
    case 'state': return apiState(String(req.team || '').trim());
    case 'act': return apiAct(String(req.team || '').trim(), req.act || {});
    case 'monitor': return apiMonitor(String(req.password || ''));
    case 'test': return apiTest(String(req.token || '').trim());
  }
  return { ok: false, message: '不認得的動作' };
}

function teamCode(code) {
  var values = sheet(SHEETS.teams).getDataRange().getDisplayValues();
  var wanted = Engine.normalize(code);
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] && Engine.normalize(values[i][0]) === wanted) return String(values[i][0]).trim();
  }
  return null;
}

function findProgress(code) {
  var sh = sheet(SHEETS.progress);
  var values = sh.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === code) return { row: i + 1, state: JSON.parse(values[i][1]) };
  }
  return null;
}

function saveProgress(found, state) {
  var sh = sheet(SHEETS.progress);
  var row = [state.team, JSON.stringify(state), new Date()];
  if (found) sh.getRange(found.row, 1, 1, 3).setValues([row]);
  else sh.appendRow(row);
}

function reply(state, content, result) {
  var now = Date.now();
  return { ok: true, view: Engine.view(state, content, now), result: result || null, now: now };
}

function apiJoin(code) {
  var team = teamCode(code);
  if (!team) return { ok: false, message: '找不到這個組別代碼' };
  var content = releaseContent();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findProgress(team);
    if (found) return reply(found.state, content);
    var state = Engine.newState(team, Date.now());
    saveProgress(null, state);
    return reply(state, content);
  } finally {
    lock.releaseLock();
  }
}

function apiState(code) {
  var team = teamCode(code);
  var found = team && findProgress(team);
  if (!found) return { ok: false, message: '找不到這一組的進度' };
  return reply(found.state, releaseContent());
}

function apiAct(code, act) {
  var team = teamCode(code);
  if (!team) return { ok: false, message: '找不到這個組別代碼' };
  var content = releaseContent();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findProgress(team);
    if (!found) return { ok: false, message: '找不到這一組的進度' };
    var out = Engine.apply(found.state, content, { type: String(act.type || ''), text: String(act.text == null ? '' : act.text) }, Date.now());
    saveProgress(found, out.state);
    return reply(out.state, content, out.result);
  } finally {
    lock.releaseLock();
  }
}

function apiMonitor(password) {
  var expected = String(readSettings()['監看密碼'] || '');
  if (!expected || password !== expected) return { ok: false, message: '監看密碼不對' };
  var content = releaseContent();
  var now = Date.now();
  var values = sheet(SHEETS.progress).getDataRange().getValues();
  var teams = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    teams.push(Engine.summary(JSON.parse(values[i][1]), content, now));
  }
  return { ok: true, title: content.title, teams: teams, now: now };
}

// 老師測試網址：該老師最新版題目 + 答案，交給瀏覽器在本機跑（可看答案、跳題）
function apiTest(token) {
  if (!token) return { ok: false, message: '缺少測試代碼' };
  var t = teacherRows().filter(function (r) { return r.token === token; })[0];
  if (!t) return { ok: false, message: '測試代碼無效' };
  var questions = bankQuestions(t.name).list.sort(function (a, b) { return a.order - b.order; });
  if (!questions.length) return { ok: false, message: '還沒有通過檢查的題目' };
  var content = settingsContent(readSettings());
  content.id = 'test-' + t.name + '-v' + t.version;
  content.title = content.title + '｜' + t.name + ' 測試版 v' + t.version;
  content.main = questions.map(function (q, i) { q.fragment = String(i + 1); q.transition = ''; return q; });
  content.finale.answer = '';
  content.finale.type = '數字';
  content.vault = [];
  return { ok: true, content: content };
}
