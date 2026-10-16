/**
 * 应用自身的版本号与运行形态。
 *
 * 版本号有四个来源，按优先级取第一个能用的：
 *
 *   1. `BIRD_VERSION` 环境变量 —— 打包 / CI 时显式给（就是 Release 的 tag）
 *   2. `web/version.json` —— **打包脚本写进去的**，所以发出去的 exe / APK 知道自己是什么版本
 *   3. `git describe --tags` —— 只有源码方式跑才有（开发机上自动跟着 tag 走，不用手改文件）
 *   4. `dev`
 *
 * 为什么落在 `web/` 下：`runtime.mjs` 的 `readWebFile()` 是三种形态（源码 / SEA 打包的 exe /
 * Android）唯一统一的读文件入口 —— 放这儿三边都能读到，不用再写一套 SEA / assets 的读取逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { IS_SEA, WEB_DIR, readWebFile } from './runtime.mjs';

/** 归一化：去掉开头的 v、去掉前后空白；顺手挡掉明显不是版本号的字符串 */
export function normalizeVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  return /^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.-]+)?$/.test(s) ? s : '';
}

/** 从 web/version.json 取（打包脚本写的），没有就 null */
function baked() {
  try {
    const raw = readWebFile('version.json');
    if (!raw) return null;
    const j = JSON.parse(raw.toString('utf8'));
    const version = normalizeVersion(j && j.version);
    if (!version) return null;
    return { version, builtAt: String((j && j.builtAt) || ''), platform: String((j && j.platform) || '') };
  } catch {
    return null;
  }
}

/** 从起点往上找带 .git 的目录（找不到返回 null） */
function findGitRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 4; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      /* 权限之类的问题直接跳过 */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * 源码方式：跟着最近的 tag 走（开发机上不用手工维护版本号）。失败一律当作没有。
 *
 * @param {string} [rootHint] 调用方知道的仓库根目录。
 * ⚠ **必须允许传 rootHint**：runtime.mjs 的 `DEV_ROOT` 是按「入口在 `<root>/server/` 下」
 *   推算的（`argv[1]` 的上一级），而 `build-exe.mjs` 这类放在**仓库根目录**的构建脚本
 *   会被算高一层 → `WEB_DIR` 指到仓库外面 → 找不到 `.git` → 版本号悄悄退化成 `'dev'`
 *   （本地打的 exe 就会显示 dev）。踩过一次，这里连 WEB_DIR 的上下级一起试。
 */
function fromGit(rootHint) {
  if (IS_SEA) return null; // exe 里没有 git，也拿不到仓库
  try {
    const candidates = [rootHint, WEB_DIR, path.dirname(WEB_DIR), process.cwd()].filter(Boolean);
    const root = candidates.map(findGitRoot).find(Boolean);
    if (!root) return null;
    const r = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    });
    if (r.status !== 0) return null;
    return normalizeVersion(r.stdout) || null;
  } catch {
    return null;
  }
}

/**
 * 运行形态标识（用来挑对应的发布产物）。
 *
 * Android 上 `process.platform` 不一定可靠 —— 所以原生壳显式塞了 BIRD_PLATFORM（见 native-lib.cpp），
 * 以它为准。
 */
export function platformId() {
  const forced = (process.env.BIRD_PLATFORM || '').trim();
  if (forced) return forced;
  const p = process.platform;
  const a = process.arch;
  if (p === 'android') return 'android-arm64';
  if (p === 'win32') return a === 'arm64' ? 'win-arm64' : 'win-x64';
  if (p === 'darwin') return a === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return `${p}-${a}`;
}

/** 人话标签：界面上「当前版本」后面要写清楚跑在什么东西上 */
export function platformLabel(id = platformId()) {
  const map = {
    'android-arm64': 'Android',
    'win-x64': 'Windows',
    'win-arm64': 'Windows (ARM)',
    'mac-arm64': 'macOS (Apple 芯片)',
    'mac-x64': 'macOS (Intel)',
  };
  if (map[id]) return map[id];
  if (process.env.BIRD_DATA_DIR || id.startsWith('android')) return 'Android'; // 兜底：BIRD_DATA_DIR 只有壳会设
  return '源码运行';
}

/** 当前版本信息；进程生命周期内只算一次 */
const INFO = (() => {
  const env = normalizeVersion(process.env.BIRD_VERSION);
  if (env) return { version: env, source: 'env', builtAt: '', platform: platformId() };
  const b = baked();
  if (b) return { version: b.version, source: 'baked', builtAt: b.builtAt, platform: b.platform || platformId() };
  const g = fromGit();
  if (g) return { version: g, source: 'git', builtAt: '', platform: platformId() };
  return { version: 'dev', source: 'fallback', builtAt: '', platform: platformId() };
})();

/**
 * 当前版本。`version` 可能是 `'dev'`（既没打包、也没有 git）—— 那种情况下界面要如实说
 * 「源码运行」，并且**不参与更新比较**（见 isNewer）。
 */
export function appVersion() {
  return { ...INFO };
}

/** 当前是否 Android 壳 */
export const IS_ANDROID = platformId().startsWith('android');

/**
 * a 是否比 b 新（都按数字段比；非数字段按 semver 惯例：有预发布号的更旧）。
 * 任意一边解析不出数字段（比如 'dev'）→ 返回 false：**不知道就别说有更新**，
 * 免得源码运行 / 奇葩版本号的时候一直挂着个红点。
 */
export function isNewer(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x > y;
  }
  // 数字段相同：没有预发布号的更新（1.0.0 > 1.0.0-beta）
  if (pa.pre === pb.pre) return false;
  if (!pa.pre) return true;
  if (!pb.pre) return false;
  return pa.pre > pb.pre;
}

function parseVer(v) {
  const s = normalizeVersion(v);
  if (!s || !/^[0-9]/.test(s)) return null;
  const [core, ...rest] = s.split('-');
  const nums = core.split('.').map((x) => Number(x));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return { nums, pre: rest.join('-') };
}

/* ------------------------------------------------------------------ *
 * 打包时：把版本写进 web/version.json
 * ------------------------------------------------------------------ */

/**
 * 本次要打进包里的版本号。
 *   BIRD_VERSION       —— CI 打 tag 时给的就是 tag（见 release.yml）
 *   BIRD_VERSION_NAME  —— Android 构建脚本本来就在用这个名字传 tag
 *   都没有             —— 退回最近的 git tag（本地构建），再不行 'dev'
 *
 * @param {string} [rootHint] 仓库根目录（构建脚本请务必传，见 fromGit 的说明）
 */
export function detectVersion(rootHint) {
  return (
    normalizeVersion(process.env.BIRD_VERSION) ||
    normalizeVersion(process.env.BIRD_VERSION_NAME) ||
    fromGit(rootHint) ||
    'dev'
  );
}

/**
 * 把版本写进 `<webDir>/version.json`。
 *
 * 为什么写 web/ 下：exe 的内嵌资源（build-exe.mjs 的 assets）与 APK 的 assets
 * （Gradle 的 nodejsProject 拷贝）都是从 web/ **整目录** 来的 —— 写在这儿，
 * 三种形态（源码 / exe / APK）都能用 runtime.mjs 的 readWebFile() 读到，不用另开通道。
 * 这个文件是生成物，已在 .gitignore 里。
 *
 * @returns {{file: string, version: string, builtAt: string}}
 */
export function writeBakedVersion(webDir, { version, builtAt = new Date().toISOString(), platform = platformId() } = {}) {
  const v = normalizeVersion(version) || 'dev';
  const file = path.join(webDir, 'version.json');
  const body = { version: v, builtAt, platform };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return { file, version: v, builtAt };
}
