/**
 * 运行形态适配层 —— 同一份源码，要同时支持三种跑法：
 *
 *   1) 源码方式   node server/index.mjs          （开发 / 调试 / 改完立刻生效）
 *   2) 打包成 exe Node SEA（单文件可执行程序）    （Windows 双击就能用，不需要装 Node）
 *   3) 安卓 APK   nodejs-mobile（内嵌 Node 运行时）（手机上的壳把本文件所在的 server/ 解包到私有目录后启动）
 *
 * 三者的差别只有两处，其它逻辑完全共用：
 *
 *   ▸ 静态网页：源码方式从磁盘 web/ 读；
 *               exe 里没有磁盘 web/，构建时已把文件内嵌进 exe，用 sea.getAsset 取；
 *               Android 上是解包出来的真实目录，与源码方式一致。
 *   ▸ 数据目录：源码方式用项目下的 data/；
 *               exe 没有「项目目录」，放在 exe 同级的 data/；
 *               Android 没有「当前目录」（cwd 是 /），由壳用 BIRD_DATA_DIR 显式指定。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* ------------------------------------------------------------------ *
 * 一、SEA 探测
 * ------------------------------------------------------------------ */

/**
 * 取 node:sea 内置模块。
 * process.getBuiltinModule() 是**同步**拿内置模块的唯一办法（Node 22.3+），
 * 而且 CJS / ESM 两种形态下都能用 —— 打包成 exe 后入口脚本是 CJS，
 * 普通的 import / require 在这里都不合适，所以走这条。
 * 老版本 Node（没有该方法）或没开启 SEA 时，一律按「源码方式」处理。
 */
const SEA = (() => {
  try {
    const get = process.getBuiltinModule;
    if (typeof get !== 'function') return null;
    const sea = get('node:sea');
    if (!sea || typeof sea.isSea !== 'function' || !sea.isSea()) return null;
    return sea;
  } catch {
    return null;
  }
})();

/** 当前是否运行在打包后的 exe 里 */
export const IS_SEA = !!SEA;

/** 打包成 exe 时自身的完整路径（源码方式下为空串） */
export const EXE_PATH = IS_SEA ? process.execPath : '';

/* ------------------------------------------------------------------ *
 * 二、静态网页文件
 * ------------------------------------------------------------------ */

/**
 * 源码方式下项目根目录的定位。
 * 不用 import.meta.url —— 那份代码在打包后会变成 CJS，import.meta 是空的；
 * 而 Node 传给主模块的 argv[1] 一定是解析过的绝对路径，两种形态下语义都清楚。
 */
const DEV_ROOT = (() => {
  const entry = process.argv[1];
  if (entry && /\.(mjs|cjs|js)$/i.test(entry)) return path.resolve(path.dirname(entry), '..');
  return process.cwd();
})();

/** 源码方式下 web/ 的绝对路径（打包后无意义，仅用于日志） */
export const WEB_DIR = path.resolve(DEV_ROOT, 'web');

/** 内嵌资源的 key 前缀，构建脚本按 `web/xxx` 存 */
const ASSET_PREFIX = 'web/';
/** 构建脚本生成的清单：内嵌了哪些网页文件 */
const ASSET_MANIFEST = '_web-assets.json';

/** exe 里内嵌的网页文件清单；源码方式返回 null */
export function embeddedWebFiles() {
  if (!IS_SEA) return null;
  try {
    return JSON.parse(SEA.getAsset(ASSET_MANIFEST, 'utf8'));
  } catch {
    return [];
  }
}

/** 网页文件的来源描述，只用于启动日志 */
export function webSourceText() {
  if (!IS_SEA) return WEB_DIR;
  const files = embeddedWebFiles() || [];
  return `已内嵌 ${files.length} 个文件`;
}

/**
 * 读取 web/ 下的某个文件，返回 Buffer；不存在返回 null。
 * @param {string} rel 相对 web/ 的路径，调用方需已做目录穿越检查
 */
export function readWebFile(rel) {
  const clean = String(rel).replace(/^[/\\]+/, '').split(/[/\\]+/).join('/');

  if (IS_SEA) {
    try {
      return Buffer.from(SEA.getAsset(ASSET_PREFIX + clean));
    } catch {
      return null;
    }
  }

  try {
    const file = path.join(WEB_DIR, clean);
    if (!file.startsWith(WEB_DIR)) return null;
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 三、数据目录（缓存落盘位置）
 * ------------------------------------------------------------------ */

/** 目录可写性探测：能建目录、能写文件、能删掉 */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function localAppData() {
  return (
    process.env.LOCALAPPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share'))
  );
}

/**
 * 数据目录（缓存落盘位置）。
 *
 * 优先级：
 *   1. BIRD_DATA_DIR —— 显式指定。Android 的壳靠这个告诉 Node 往哪写：
 *      安卓进程没有「当前目录」的概念，cwd 是 /，不指定就只能猜。
 *   2. exe  形态 → exe 同级的 data/（绿色软件习惯，拷走 exe 就拷走了缓存）
 *      源码形态 → 项目下的 data/
 *   3. 用户数据目录（exe 被放进只读位置时的兜底）
 *   4. 系统临时目录（最后的兜底，至少能跑起来）
 */
function pickDataDir() {
  const explicit = process.env.BIRD_DATA_DIR;
  if (explicit) {
    if (writable(explicit)) return path.resolve(explicit);
    console.warn(`[runtime] BIRD_DATA_DIR=${explicit} 不可写，改用默认位置`);
  }

  const candidates = IS_SEA
    ? [path.join(path.dirname(EXE_PATH), 'data'), path.join(localAppData(), 'BirdReportHot', 'data')]
    : [path.resolve(DEV_ROOT, 'data'), path.resolve(process.cwd(), 'data')];

  candidates.push(path.join(os.tmpdir(), 'BirdReportHot', 'data'));

  for (const dir of candidates) {
    if (writable(dir)) return dir;
  }
  return candidates[candidates.length - 1];
}

/** 缓存与保护等级字典的落盘目录 */
export const DATA_DIR = pickDataDir();

/* ------------------------------------------------------------------ *
 * 四、打开系统默认浏览器
 * ------------------------------------------------------------------ */

/**
 * 用系统默认浏览器打开地址。
 * 不阻塞、不继承 stdio，失败只打一行日志 —— 打不开浏览器不该影响服务本身。
 */
export function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]] // 第一个参数是窗口标题，必须留空
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => console.warn(`[runtime] 打开浏览器失败：${e.message}`));
    child.unref();
  } catch (e) {
    console.warn(`[runtime] 打开浏览器失败：${e.message}`);
  }
}

/**
 * 是否该自动打开浏览器。
 *   OPEN_BROWSER=1 强制开（源码方式调试也用得上）
 *   OPEN_BROWSER=0 强制关
 *   不设         → 只有跑在 exe 里才自动开（源码方式反复重启不至于刷一屏标签页）
 */
export function shouldOpenBrowser() {
  const v = process.env.OPEN_BROWSER;
  if (v === '1') return true;
  if (v === '0') return false;
  return IS_SEA;
}
