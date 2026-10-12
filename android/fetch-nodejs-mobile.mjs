/**
 * 拉取 nodejs-mobile 的 Android 预编译运行时（内核是 Node 18.20.4）。
 *
 *   node android/fetch-nodejs-mobile.mjs           已经拉过就跳过
 *   node android/fetch-nodejs-mobile.mjs --force   强制重新下载与解包
 *
 * 为什么不让它进 git：解包后约 190 MB（三个 ABI 的 libnode.so 各 60 MB 上下），
 * 而实际只会用其中一个 ABI。所以按需拉取，下载包会缓存下来，重复执行不会重下。
 *
 * 产物布局（Gradle 直接把它当 jniLibs 用）：
 *   android/third_party/nodejs-mobile/bin/<abi>/libnode.so
 *   android/third_party/nodejs-mobile/include/node/*.h
 *
 * 只用 Node 内置模块：下载交给系统 curl（Windows 10+ / macOS / Linux 都自带，
 * 且会自动认 http_proxy 之类的环境变量），没有 curl 时退回 fetch；
 * 解包用下面这段最小 zip 读取器（只需要 deflate/stored 两种方式）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '18.20.4';
const ZIP_NAME = `nodejs-mobile-v${VERSION}-android.zip`;
const URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${VERSION}/${ZIP_NAME}`;

const ANDROID_DIR = path.dirname(fileURLToPath(import.meta.url));
const THIRD_PARTY = path.join(ANDROID_DIR, 'third_party');
const ZIP_PATH = path.join(THIRD_PARTY, ZIP_NAME);
const DEST = path.join(THIRD_PARTY, 'nodejs-mobile');

const FORCE = process.argv.includes('--force');
const READY = path.join(DEST, 'bin', 'arm64-v8a', 'libnode.so');

const log = (msg) => console.log(`  ${msg}`);
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */

function downloadWithCurl(url, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-L', '--fail', '--retry', '2', '-o', dest, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject); // 系统没有 curl
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl 退出码 ${code}\n${err.trim()}`));
    });
  });
}

async function downloadWithFetch(url, dest) {
  const res = await fetch(url); // Node 18+ 自带
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await downloadWithCurl(url, dest);
  } catch (e) {
    if (e.code !== 'ENOENT' && !/ENOENT/.test(e.message)) {
      // curl 存在但失败了，先用 fetch 再试一次（有些环境 curl 被代理配置坑住）
      log(`curl 失败（${e.message.split('\n')[0]}），改用 fetch 重试`);
    }
    await downloadWithFetch(url, dest);
  }
  const size = fs.statSync(dest).size;
  if (size < 1024 * 1024) throw new Error(`下载的文件只有 ${size} 字节，明显不对`);
  log(`已下载 ${ZIP_NAME}（${mb(size)}）`);
}

/* ------------------------------------------------------------------ *
 * 最小 zip 读取器
 * ------------------------------------------------------------------ */

/** 读中央目录，返回条目列表 */
function readCentralDirectory(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到目录结尾记录');

  const count = buf.readUInt16LE(eocd + 10);
  const start = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = start;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method,
      compSize,
      localOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 取出单个条目的内容 */
function readEntry(buf, entry) {
  const p = entry.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`本地文件头损坏：${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const from = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(from, from + entry.compSize);

  if (entry.method === 0) return raw; // 没压缩
  if (entry.method === 8) return zlib.inflateRawSync(raw); // deflate
  throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
}

/** 只解出 bin/ 与 include/，忽略其它（nodejs-mobile 的包里也只有这两块） */
function extract(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);

  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // 目录
    if (!/^(bin|include)\//.test(entry.name)) continue;

    const target = path.join(destDir, entry.name);
    if (!target.startsWith(destDir)) throw new Error(`条目路径越界：${entry.name}`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = readEntry(buf, entry);
    fs.writeFileSync(target, data);
    files += 1;
    bytes += data.length;
  }
  log(`已解包 ${files} 个文件（${mb(bytes)}）到 ${path.relative(process.cwd(), destDir)}`);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log(`\n准备 nodejs-mobile 运行时（Node ${VERSION}）\n`);

  if (!FORCE && fs.existsSync(READY)) {
    log(`已经就绪：${path.relative(process.cwd(), READY)}`);
    log('要重新拉取就加 --force');
    return;
  }

  if (FORCE || !fs.existsSync(ZIP_PATH)) {
    await download(URL, ZIP_PATH);
  } else {
    log(`复用已下载的 ${ZIP_NAME}`);
  }

  fs.rmSync(DEST, { recursive: true, force: true });
  extract(ZIP_PATH, DEST);

  if (!fs.existsSync(READY)) throw new Error('解包完了却没找到 libnode.so，包结构可能变了');
  console.log('\n完成。现在可以构建 APK：\n  cd android && ./gradlew :app:assembleDebug\n');
}

main().catch((e) => {
  console.error(`\n拉取失败：${e.message}\n`);
  process.exit(1);
});
