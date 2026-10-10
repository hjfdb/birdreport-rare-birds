/**
 * 构建单文件版网页端 → html/index.html
 *
 * 把 web/ 下的样式、逻辑，加上内置依赖（JSEncrypt）与浏览器数据层（client-api.js），
 * 全部内联进一个 HTML。产物双击即可运行：没有服务端，页面直接调用上游接口，
 * 缓存落在浏览器 localStorage。
 *
 * 用法：node build-html.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('web/index.html');
const css = read('web/style.css');
const clientApi = read('web/client-api.js');
const appJs = read('web/app.js');
const jsencrypt = read('vendor/jsencrypt.js');

/** 内联脚本里若出现 </script> 会提前结束标签，统一转义 */
const safeScript = (s) => s.replace(/<\/script/gi, '<\\/script');

// 1) 内联样式：替换 <link rel="stylesheet" href="./style.css" />
let out = html.replace(
  /[ \t]*<link rel="stylesheet" href="\.\/style\.css"\s*\/?>\n/,
  `<style>\n${css}\n</style>\n`
);
if (out === html) throw new Error('未能替换样式表引用，请检查 web/index.html');

// 2) 内联脚本：把 <script src="./app.js"></script> 换成三段内联脚本
const bundle = [
  '<!-- ===== 内置依赖：JSEncrypt（RSA PKCS#1 v1.5），随上游站点同版本 ===== -->',
  '<script>',
  safeScript(jsencrypt),
  '</script>',
  '',
  '<!-- ===== 浏览器数据层：直连上游 + localStorage 缓存，形状与 /api/* 一致 ===== -->',
  '<script>',
  safeScript(clientApi),
  '</script>',
  '',
  '<!-- ===== 页面逻辑（与服务端版共用同一份 web/app.js） ===== -->',
  '<script>',
  safeScript(appJs),
  '</script>',
  '',
].join('\n');

out = out.replace(/[ \t]*<script src="\.\/app\.js"><\/script>\n/, bundle);
if (out === html) throw new Error('未能替换脚本引用，请检查 web/index.html');

// 3) 单文件版的标题与说明：明确「双击即用、无需服务端」
out = out.replace(
  '<title>观鸟地区稀有鸟种榜 · 中国观鸟记录中心数据</title>',
  '<title>观鸟地区稀有鸟种榜 · 单文件版（无需服务端）</title>'
);
out = out.replace(
  /<p class="brand-sub">([^<]*)<\/p>/,
  '<p class="brand-sub">按省 / 市 / 区县，把本地记录最少的鸟种排在最前 · 附国家重点保护等级与上游 AI 标疑标记</p>'
);

const outFile = path.join(ROOT, 'html', 'index.html');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log('已生成：' + outFile);
console.log('  总大小 ' + kb(Buffer.byteLength(out)));
console.log('  ├ 样式      ' + kb(Buffer.byteLength(css)));
console.log('  ├ JSEncrypt ' + kb(Buffer.byteLength(jsencrypt)));
console.log('  ├ 数据层    ' + kb(Buffer.byteLength(clientApi)));
console.log('  └ 页面逻辑  ' + kb(Buffer.byteLength(appJs)));
console.log('\n直接双击 html/index.html 即可使用（无需启动服务端）。');
