// 產生 GitHub Pages 用的 docs/index.html、docs/islands.html：原始檔加上 Apps Script API 網址。
// 改了 Index.html、Islands.html 或換了部署網址後執行：node tools/build-pages.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { api } = JSON.parse(fs.readFileSync(path.join(root, 'pages.config.json'), 'utf8'));
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(api)) throw new Error('pages.config.json 的 api 網址格式不對');
const marker = '<base target="_top">';
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
// Index.html → docs/index.html（密室工坊）；Islands.html → docs/islands.html（密室島展示頁）
[['Index.html', 'index.html'], ['Islands.html', 'islands.html']].forEach(function (pair) {
  const src = fs.readFileSync(path.join(root, pair[0]), 'utf8');
  if (!src.includes(marker)) throw new Error(pair[0] + ' 找不到 ' + marker);
  const out = src.replace(marker,
    '<!-- 這個檔案由 tools/build-pages.js 產生，請改 ' + pair[0] + ' -->\n<script>window.ER_API = ' + JSON.stringify(api) + ';</script>\n' + marker);
  fs.writeFileSync(path.join(root, 'docs', pair[1]), out);
  console.log('docs/' + pair[1] + ' 已更新（API：' + api.slice(0, 60) + '…）');
});
