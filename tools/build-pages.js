// 產生 GitHub Pages 用的 docs/index.html：Index.html 加上 Apps Script API 網址。
// 改了 Index.html 或換了部署網址後執行：node tools/build-pages.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const { api } = JSON.parse(fs.readFileSync(path.join(root, 'pages.config.json'), 'utf8'));
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(api)) throw new Error('pages.config.json 的 api 網址格式不對');
const src = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const marker = '<base target="_top">';
if (!src.includes(marker)) throw new Error('Index.html 找不到 ' + marker);
const out = src.replace(marker,
  '<!-- 這個檔案由 tools/build-pages.js 產生，請改 Index.html -->\n<script>window.ER_API = ' + JSON.stringify(api) + ';</script>\n' + marker);
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'index.html'), out);
console.log('docs/index.html 已更新（API：' + api.slice(0, 60) + '…）');
