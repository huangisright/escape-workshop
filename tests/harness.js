// tests/harness.js
// 把 Index.html 包成可以在一般瀏覽器開的頁面：
// 同一頁裡跑 GAS 模擬服務 + Code.gs，google.script.run 改成直接呼叫 Code.gs 的函式（非同步、經過 JSON 序列化，跟真的一樣）。
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..');

function buildHarness() {
  const index = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
  // 內嵌到 <script> 裡時，字串中的 </script> 要跳脫，不然會提早結束
  const inline = (src) => src.replace(/<\/script/gi, '<\\/script');
  const mock = inline(fs.readFileSync(path.join(__dirname, 'gas-mock.js'), 'utf8'));
  const code = inline(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'));
  const server = `
<script>${mock}</script>
<script>GasMock.install(window);</script>
<script>
// Code.gs 放在自己的函式範圍，避免和 Index.html 同名的函式（例如 adminStats）互相覆蓋
window.GAS = (function () {
${code}
;return function (name) { return eval(name); };
})();
(function () {
  function runner() {
    var ok = null, bad = null;
    var proxy = new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (f) { ok = f; return proxy; };
        if (prop === 'withFailureHandler') return function (f) { bad = f; return proxy; };
        return function () {
          var args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
          var s = ok, f = bad;
          setTimeout(function () {
            var out;
            try { out = GAS(prop).apply(null, args); }
            catch (e) { if (f) f(new Error(e.message)); return; }
            if (s) s(out === undefined ? undefined : JSON.parse(JSON.stringify(out)));
          }, 5);
        };
      }
    });
    return proxy;
  }
  var params = {};
  new URLSearchParams(location.search).forEach(function (v, k) { params[k] = v; });
  window.google = { script: { url: { getLocation: function (cb) { cb({ parameter: params }); } } } };
  Object.defineProperty(window.google.script, 'run', { get: runner });
})();
</script>`;
  // 放在 Index.html 主程式之前
  const marker = '<div id="modal"></div>';
  if (!index.includes(marker)) throw new Error('Index.html 結構變了，找不到插入點');
  return index.replace(marker, () => marker + server);
}

module.exports = { buildHarness };
