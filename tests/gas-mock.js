// platform/tests/gas-mock.js
// 在 Node 或瀏覽器裡模擬 Google Apps Script 的服務（試算表、雲端硬碟、屬性、快取、鎖…），
// 讓 Code.gs 不用部署就能測試。只實作 Code.gs 用到的部分。
//
// 用法：GasMock.install(globalObject) 之後再載入 Code.gs。

var GasMock = (function () {
  // ---------- 位元組與編碼 ----------

  function utf8Bytes(s) {
    var out = [];
    var str = unescape(encodeURIComponent(String(s)));
    for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i));
    return out;
  }
  function utf8String(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
    return decodeURIComponent(escape(s));
  }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64Encode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i] & 255, b = bytes[i + 1] & 255, c = bytes[i + 2] & 255;
      var n = (a << 16) | (b << 8) | c;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function b64Decode(s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, '');
    var out = [];
    for (var i = 0; i < s.length; i += 4) {
      var n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) |
        ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out.push((n >> 16) & 255);
      if (s[i + 2] !== undefined) out.push((n >> 8) & 255);
      if (s[i + 3] !== undefined) out.push(n & 255);
    }
    return out;
  }

  function sha256(bytes) {
    var K = [], H = [], p = 2, c = 0;
    function isP(n) { for (var f = 2; f * f <= n; f++) if (n % f === 0) return false; return true; }
    function fr(x) { return ((x - Math.floor(x)) * 4294967296) | 0; }
    while (c < 64) { if (isP(p)) { if (c < 8) H[c] = fr(Math.pow(p, 1 / 2)); K[c] = fr(Math.pow(p, 1 / 3)); c++; } p++; }
    function r(n, x) { return (x >>> n) | (x << (32 - n)); }
    var l = bytes.length * 8, w = [], i;
    for (i = 0; i < bytes.length; i++) w[i >> 2] |= (bytes[i] & 255) << (24 - (i % 4) * 8);
    w[l >> 5] |= 0x80 << (24 - l % 32);
    w[((l + 64 >> 9) << 4) + 15] = l;
    for (i = 0; i < w.length; i += 16) {
      var W = [], a = H.slice(0), j;
      for (j = 0; j < 64; j++) {
        if (j < 16) W[j] = w[i + j] | 0;
        else { var x = W[j - 15], y = W[j - 2]; W[j] = (W[j - 16] + (r(7, x) ^ r(18, x) ^ (x >>> 3)) + W[j - 7] + (r(17, y) ^ r(19, y) ^ (y >>> 10))) | 0; }
        var t1 = (a[7] + (r(6, a[4]) ^ r(11, a[4]) ^ r(25, a[4])) + ((a[4] & a[5]) ^ (~a[4] & a[6])) + K[j] + W[j]) | 0;
        var t2 = ((r(2, a[0]) ^ r(13, a[0]) ^ r(22, a[0])) + ((a[0] & a[1]) ^ (a[0] & a[2]) ^ (a[1] & a[2]))) | 0;
        a = [(t1 + t2) | 0].concat(a.slice(0, 7)); a[4] = (a[4] + t1) | 0;
      }
      for (j = 0; j < 8; j++) H[j] = (H[j] + a[j]) | 0;
    }
    var out = [];
    H.forEach(function (v) { for (var k = 3; k >= 0; k--) { var b = (v >>> (k * 8)) & 255; out.push(b > 127 ? b - 256 : b); } });
    return out; // Java 風格的有號位元組
  }

  // ---------- 安裝 ----------

  function install(g) {
    var seq = 0;
    var nextId = function (p) { seq++; return p + seq; };
    var logs = [];

    // 試算表
    var spreadsheets = {};
    function Sheet(name) { this.name = name; this.rows = []; }
    Sheet.prototype.getName = function () { return this.name; };
    Sheet.prototype.setName = function (n) { this.name = n; return this; };
    Sheet.prototype.setFrozenRows = function () { return this; };
    Sheet.prototype.getLastRow = function () {
      for (var i = this.rows.length - 1; i >= 0; i--) {
        if (this.rows[i] && this.rows[i].some(function (v) { return v !== '' && v !== undefined && v !== null; })) return i + 1;
      }
      return 0;
    };
    Sheet.prototype.appendRow = function (vals) {
      this.rows[this.getLastRow()] = vals.map(store);
      return this;
    };
    Sheet.prototype.getRange = function (row, col, nr, nc) {
      return new Range(this, row, col, nr || 1, nc || 1);
    };
    function store(v) {
      // 試算表會吃掉開頭的 '（強制文字）
      return typeof v === 'string' && v.charAt(0) === "'" ? v.substring(1) : v;
    }
    function Range(sheet, row, col, nr, nc) {
      this.sheet = sheet; this.row = row; this.col = col; this.nr = nr; this.nc = nc;
    }
    Range.prototype.setNumberFormat = function () { return this; };
    Range.prototype.getValues = function () {
      var out = [];
      for (var i = 0; i < this.nr; i++) {
        var src = this.sheet.rows[this.row - 1 + i] || [];
        var r = [];
        for (var j = 0; j < this.nc; j++) {
          var v = src[this.col - 1 + j];
          r.push(v === undefined || v === null ? '' : v);
        }
        out.push(r);
      }
      return out;
    };
    Range.prototype.setValues = function (vals) {
      for (var i = 0; i < vals.length; i++) {
        var idx = this.row - 1 + i;
        var r = this.sheet.rows[idx] || (this.sheet.rows[idx] = []);
        for (var j = 0; j < vals[i].length; j++) r[this.col - 1 + j] = store(vals[i][j]);
      }
      return this;
    };
    function Spreadsheet(name) {
      this.id = nextId('ss'); this.name = name; this.sheets = [new Sheet('工作表1')];
      spreadsheets[this.id] = this;
    }
    Spreadsheet.prototype.getId = function () { return this.id; };
    Spreadsheet.prototype.getSheets = function () { return this.sheets; };
    Spreadsheet.prototype.insertSheet = function (name) { var s = new Sheet(name); this.sheets.push(s); return s; };
    Spreadsheet.prototype.getSheetByName = function (name) {
      return this.sheets.filter(function (s) { return s.name === name; })[0] || null;
    };
    g.SpreadsheetApp = {
      create: function (name) { var ss = new Spreadsheet(name); files[ss.id] = new File(ss.id, name, null); return ss; },
      openById: function (id) { if (!spreadsheets[id]) throw new Error('No spreadsheet ' + id); return spreadsheets[id]; }
    };

    // 雲端硬碟
    var files = {};
    var folders = {};
    function Blob(bytes, mime, name) { this.bytes = bytes; this.mime = mime; this.name = name; }
    Blob.prototype.getBytes = function () { return this.bytes.slice(); };
    Blob.prototype.getDataAsString = function () { return utf8String(this.bytes); };
    Blob.prototype.getContentType = function () { return this.mime; };
    Blob.prototype.getName = function () { return this.name; };
    function File(id, name, blob) { this.id = id; this.name = name; this.blob = blob; }
    File.prototype.getId = function () { return this.id; };
    File.prototype.getName = function () { return this.name; };
    File.prototype.getBlob = function () { return this.blob; };
    File.prototype.getUrl = function () { return 'https://drive.google.com/file/d/' + this.id; };
    File.prototype.moveTo = function (folder) { this.parent = folder.id; return this; };
    function Folder(name, parent) {
      this.id = nextId('fd'); this.name = name; this.parent = parent; folders[this.id] = this;
    }
    Folder.prototype.getId = function () { return this.id; };
    Folder.prototype.getName = function () { return this.name; };
    Folder.prototype.getUrl = function () { return 'https://drive.google.com/drive/folders/' + this.id; };
    Folder.prototype.createFolder = function (name) { return new Folder(name, this.id); };
    Folder.prototype.createFile = function (blob) {
      var f = new File(nextId('f'), blob.name, blob);
      f.parent = this.id;
      files[f.id] = f;
      return f;
    };
    Folder.prototype.getFoldersByName = function (name) {
      var self = this;
      var list = Object.keys(folders).map(function (k) { return folders[k]; })
        .filter(function (f) { return f.parent === self.id && f.name === name; });
      var i = 0;
      return { hasNext: function () { return i < list.length; }, next: function () { return list[i++]; } };
    };
    g.DriveApp = {
      createFolder: function (name) { return new Folder(name, null); },
      getFolderById: function (id) { if (!folders[id]) throw new Error('No folder ' + id); return folders[id]; },
      getFileById: function (id) { if (!files[id]) throw new Error('No file ' + id); return files[id]; }
    };

    // 屬性、快取、鎖、紀錄
    var props = {};
    g.PropertiesService = {
      getScriptProperties: function () {
        return {
          getProperty: function (k) { return props.hasOwnProperty(k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); return this; },
          setProperties: function (o) { Object.keys(o).forEach(function (k) { props[k] = String(o[k]); }); return this; }
        };
      }
    };
    var cache = {};
    g.CacheService = {
      getScriptCache: function () {
        return {
          get: function (k) { return cache.hasOwnProperty(k) ? cache[k] : null; },
          put: function (k, v) { cache[k] = String(v); },
          remove: function (k) { delete cache[k]; }
        };
      }
    };
    var locked = 0;
    g.LockService = {
      getScriptLock: function () {
        return {
          waitLock: function () { locked++; },
          releaseLock: function () { locked--; }
        };
      }
    };
    g.Logger = { log: function (m) { logs.push(String(m)); } };
    g.ScriptApp = { getService: function () { return { getUrl: function () { return 'https://script.google.com/macros/s/TEST/exec'; } }; } };
    g.HtmlService = {
      createHtmlOutputFromFile: function () {
        var o = { setTitle: function () { return o; }, addMetaTag: function () { return o; } };
        return o;
      }
    };

    // Utilities
    g.Utilities = {
      newBlob: function (data, mime, name) {
        var bytes = typeof data === 'string' ? utf8Bytes(data) : Array.prototype.slice.call(data);
        return new Blob(bytes, mime || 'application/octet-stream', name || '');
      },
      base64Decode: function (s) { return b64Decode(s); },
      base64Encode: function (bytes) { return b64Encode(bytes); },
      formatDate: function (d, tz, fmt) {
        var t = new Date(d.getTime() + 8 * 3600 * 1000); // Asia/Taipei
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return fmt.replace('yyyy', t.getUTCFullYear()).replace('MM', pad(t.getUTCMonth() + 1)).replace('dd', pad(t.getUTCDate()))
          .replace('HH', pad(t.getUTCHours())).replace('mm', pad(t.getUTCMinutes())).replace('ss', pad(t.getUTCSeconds()));
      },
      computeDigest: function (alg, s) { return sha256(utf8Bytes(s)); },
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' }
    };

    return {
      logs: logs,
      props: props,
      files: files,
      spreadsheets: spreadsheets,
      lockDepth: function () { return locked; },
      sheetRows: function (name) {
        var id = props.SS_ID;
        var sh = spreadsheets[id].getSheetByName(name);
        return sh.rows.slice(1).filter(function (r) { return r && r.length; });
      }
    };
  }

  return { install: install, sha256: sha256, b64Encode: b64Encode, utf8Bytes: utf8Bytes };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GasMock;
