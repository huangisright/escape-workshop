// tests/load.js
// 在 Node 的隔離環境裡載入 GAS 模擬服務與 Code.gs，回傳可呼叫的後端與可控制的時鐘。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MOCK = fs.readFileSync(path.join(__dirname, 'gas-mock.js'), 'utf8');
const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');

function load() {
  const ctx = vm.createContext({ console });
  vm.runInContext(MOCK, ctx, { filename: 'gas-mock.js' });
  const mock = vm.runInContext('GasMock.install(this)', ctx);
  let now = Date.UTC(2026, 9, 20, 1, 0, 0);
  // new Date() 與 Date.now() 都走同一個可控制的時鐘
  ctx.__clock = () => now;
  vm.runInContext(`(function () {
    var Real = Date;
    function FakeDate(a, b, c, d, e, f, g) {
      if (!(this instanceof FakeDate)) return new Real(__clock()).toString();
      if (arguments.length === 1) return new Real(a);
      return arguments.length ? new Real(a, b === undefined ? 0 : b, c === undefined ? 1 : c, d || 0, e || 0, f || 0, g || 0)
        : new Real(__clock());
    }
    FakeDate.prototype = Real.prototype;
    FakeDate.now = function () { return __clock(); };
    FakeDate.UTC = Real.UTC;
    FakeDate.parse = Real.parse;
    Date = FakeDate;
  })();`, ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  ctx.setup();
  const admin = ctx.showAdminCode();
  return {
    gs: ctx,
    mock,
    admin,
    advance(sec) { now += sec * 1000; },
    // 跨過 vm 邊界的物件轉成一般物件，方便 deepEqual
    plain(v) { return JSON.parse(JSON.stringify(v)); }
  };
}

module.exports = { load };
