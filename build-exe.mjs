/**
 * 把整个项目打包成**单个 exe**（Windows），双击即可用，不需要装 Node。
 *
 *   npm run build:exe              ← 等价于 node build-exe.mjs
 *   node build-exe.mjs             ← 一条命令跑完四步
 *   node build-exe.mjs config      ← 只做某一步（config / bundle / blob / inject）
 *   build-exe.cmd                  ← 同上，走命令行逐条拉起工具（双击也能跑）
 *
 * 打包原理（Node 官方 SEA = Single Executable Application）：
 *
 *   1. esbuild 把 server/*.mjs 合成一个文件 —— 本项目零第三方运行时依赖，
 *      所以合出来的就是自己的代码 + 对 node: 内置模块的引用；
 *   2. 把 web/ 下的静态文件写进 sea-config.json 的 assets（内嵌资源）；
 *   3. node --experimental-sea-config 生成「准备用 blob」；
 *   4. 复制一份 node.exe，用 postject 把 blob 注入进去 —— 出来的就是 exe。
 *
 * 注意：SEA 的入口脚本必须能被当作 CommonJS 执行，
 * 所以第 1 步的产物是 .cjs（Node 22 还不支持 ESM 入口的 SEA）。
 *
 * 两个环境坑（都已在代码里绕开）：
 *   ▸ 调子进程一律用异步 spawn，不用 spawnSync —— 某些受管控的机器
 *     （沙箱 / 安全软件策略）只允许异步创建进程，同步创建直接 EBUSY；
 *   ▸ 刚复制出来的 exe 会被杀软扫描占住写句柄，注入要等一下重试。
 *
 * 依赖（只在本机打包时用到，不进 exe）：esbuild、postject。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'web');

const BUNDLE_FILE = path.join(BUILD, 'app.cjs');
const CONFIG_FILE = path.join(BUILD, 'sea-config.json');
const BLOB_FILE = path.join(BUILD, 'sea-prep.blob');
const MANIFEST_FILE = path.join(BUILD, '_web-assets.json');

const EXE_NAME = process.env.EXE_NAME || '观鸟地区稀有榜.exe';
const EXE_FILE = path.join(DIST, EXE_NAME);

/** postject 要认识 Node 在 node.exe 里预留的那串哨兵标记 */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const NODE = process.execPath;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const log = (step, msg) => console.log(`  ${step}  ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function human(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** 递归列出 web/ 下的文件，返回相对路径（统一用 / 分隔） */
function walkWeb(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkWeb(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * 跑一个外部命令。
 * 用异步 spawn 而不是 spawnSync：某些受管控的机器（安全软件 / 沙箱策略）
 * 只允许异步创建进程，同步创建会直接 EBUSY。
 * 刚下载出来的 exe 还常被杀软扫描占着句柄，也会瞬时报 EBUSY，所以等一下重试。
 */
function run(cmd, args, label, { retries = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        out += d;
      });

      child.on('error', (e) => {
        if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code) && left > 0) {
          sleep(1200).then(() => attempt(left - 1));
          return;
        }
        reject(new Error(`${label} 执行失败：${e.message}`));
      });

      child.on('close', (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`${label} 退出码 ${code}：\n${out.trim()}`));
      });
    };
    attempt(retries);
  });
}

/** 找一个可用的小工具；都找不到就给出安装提示 */
function locate(label, candidates, hint) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  throw new Error(`找不到 ${label}。请先执行：${hint}`);
}

function findEsbuild() {
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  return locate(
    'esbuild',
    [
      process.env.ESBUILD,
      path.join(ROOT, 'node_modules', '@esbuild', 'win32-x64', exe),
      path.join(ROOT, 'node_modules', '.bin', `esbuild${process.platform === 'win32' ? '.cmd' : ''}`),
    ],
    'npm i -D esbuild',
  );
}

/** esbuild 的命令行参数（config 步骤要把它打印出来，供 .cmd 直接调用） */
function esbuildArgs() {
  return [
    path.join(ROOT, 'server', 'index.mjs'),
    '--bundle',
    '--platform=node', // node: 内置模块保持外部引用，其余全部打包进来
    '--format=cjs', // SEA 的入口必须是 CJS
    '--target=node22',
    '--legal-comments=none',
    '--log-level=warning',
    `--outfile=${BUNDLE_FILE}`,
  ];
}

/* ------------------------------------------------------------------ *
 * 第 1 步：收集网页资源，写 SEA 配置
 * ------------------------------------------------------------------ */

function stageConfig() {
  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  const files = walkWeb(WEB);
  if (!files.includes('index.html')) throw new Error('web/index.html 不存在，网页端没法托管');

  // 资源清单：服务端启动时靠它报出「内嵌了几个文件」
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(files.map((f) => `web/${f}`)));

  const assets = { '_web-assets.json': MANIFEST_FILE };
  for (const rel of files) assets[`web/${rel}`] = path.join(WEB, rel);

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        main: BUNDLE_FILE,
        output: BLOB_FILE,
        disableExperimentalSEAWarning: true, // 启动时别刷实验特性警告
        assets,
      },
      null,
      2,
    ),
  );

  log('1/4', `已收集 ${files.length} 个网页文件（${files.join('、')}）`);
}

/* ------------------------------------------------------------------ *
 * 第 2 步：合成单文件
 * ------------------------------------------------------------------ */

async function stageBundle() {
  const out = await run(findEsbuild(), esbuildArgs(), 'esbuild');
  if (!fs.existsSync(BUNDLE_FILE)) throw new Error(`esbuild 没产出 app.cjs：\n${out}`);
  log('2/4', `已合成单文件 app.cjs（${human(fs.statSync(BUNDLE_FILE).size)}）`);
}

/* ------------------------------------------------------------------ *
 * 第 3 步：生成注入用的 blob
 * ------------------------------------------------------------------ */

async function stageBlob() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error('缺少 build/sea-config.json，请先跑 config 步骤');
  const out = await run(NODE, ['--experimental-sea-config', CONFIG_FILE], 'sea-config');
  if (!fs.existsSync(BLOB_FILE)) throw new Error(`没生成 blob：\n${out}`);
  log('3/4', `已生成注入用 blob（${human(fs.statSync(BLOB_FILE).size)}）`);
}

/* ------------------------------------------------------------------ *
 * 第 4 步：复制 node.exe 并注入（纯 JS，不派生子进程）
 * ------------------------------------------------------------------ */

async function stageInject() {
  if (!fs.existsSync(BLOB_FILE)) throw new Error('缺少 build/sea-prep.blob，请先跑 blob 步骤');

  const { inject } = require('postject');
  fs.mkdirSync(DIST, { recursive: true });
  fs.copyFileSync(NODE, EXE_FILE);

  const blob = fs.readFileSync(BLOB_FILE);

  // 刚复制出来的 exe 可能正被杀软扫描、占着写句柄，注入会失败 —— 等一下重试
  let lastErr = null;
  for (let i = 0; i < 6; i += 1) {
    await sleep(i === 0 ? 1200 : 1500);
    try {
      await inject(EXE_FILE, 'NODE_SEA_BLOB', blob, { sentinelFuse: SEA_FUSE });
      log('4/4', `已注入并产出 ${path.relative(ROOT, EXE_FILE)}（${human(fs.statSync(EXE_FILE).size)}）`);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  fs.rmSync(EXE_FILE, { force: true });
  throw new Error(`注入失败（重试 6 次）：${lastErr && lastErr.message}`);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const STAGES = { config: stageConfig, bundle: stageBundle, blob: stageBlob, inject: stageInject };

function usageHint() {
  return '用法：node build-exe.mjs [config|bundle|blob|inject]（不传则四步依次跑完）';
}

async function main() {
  const arg = (process.argv[2] || '').replace(/^--stage=/, '');
  const stage = arg || 'all';
  if (stage !== 'all' && !STAGES[stage]) throw new Error(`未知步骤 "${stage}"。${usageHint()}`);

  console.log('\n打包「观鸟地区稀有榜」为单文件 exe\n');

  if (stage === 'all') {
    stageConfig();
    await stageBundle();
    await stageBlob();
    await stageInject();
  } else {
    await STAGES[stage]();
  }

  if (stage === 'all' || stage === 'inject') {
    console.log(`\n完成：${EXE_FILE}`);
    console.log('双击运行即可，会自动打开浏览器；关掉那个黑色窗口即停止服务。');
    console.log('缓存落在 exe 同级的 data/ 目录（该位置不可写时退到用户数据目录）。\n');
  }
}

main().catch((e) => {
  console.error(`\n打包失败：${e.message}\n`);
  process.exit(1);
});
