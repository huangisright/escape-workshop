/* 密室工坊：讓這一頁在沒有網路時也打得開（重新整理、分頁被回收後重開）。
 * 同網站的檔案「網路優先」：有網路就拿最新版並更新快取；連不上（或 4 秒內沒回應）就用快取。
 * 對 Apps Script 的 API 呼叫不經過這裡，離線判題由頁面自己處理。 */
var CACHE = 'er-shell-v1';
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add('./'); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  if (u.origin !== location.origin) return;
  var key = req.mode === 'navigate' ? './' : req;
  var net = fetch(req).then(function (res) {
    if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(key, cp); }); }
    return res;
  });
  var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 4000); });
  e.respondWith(Promise.race([net, timeout]).catch(function () {
    return caches.match(key, { ignoreSearch: true }).then(function (hit) { return hit || net; });
  }));
});
