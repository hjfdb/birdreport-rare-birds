/**
 * 「检查新版本 / 下载新版本」——只查 GitHub Releases，不碰观鸟记录中心。
 *
 * 为什么要单独一个模块：这件事跟业务接口完全无关，而且它有自己的缓存、自己的失败模式
 * （GitHub 挂了 / 断网 / 限流），不该混进 index.mjs 的路由里。
 *
 * 三个设计决定：
 *
 *   1. **不每次问**。GitHub 未登录的 API 限额是每 IP 每小时 60 次，而「我的」面板一打开就会问
 *      一次。所以结果按 `TTL`（默认 6 小时）缓存在内存 + `data/update.json`，重启也算数；
 *      「检查更新」按钮才强制回源（`force=1`）。
 *   2. **不知道就别说有更新**。版本号解析不出来（源码运行 = `dev`）、或者检查失败时，
 *      `hasUpdate` 一律为 false —— 宁可少提示，也不能挂个撤不掉的红点。
 *   3. **下载在服务端做**。网页端跑在 WebView 里，既要写磁盘又要调安装器都做不到；
 *      服务端本来就是本机进程（exe 形态就是那个 exe 自己），下载到 `data/download/`
 *      再交给 Android 壳去装，或者打开文件夹让用户替换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appVersion, isNewer, platformId, platformLabel, IS_ANDROID } from './version.mjs';
import { openInBrowser } from './runtime.mjs';

/** 查哪个仓库的 Release；可用 BIRD_UPDATE_REPO 换（fork / 自建） */
const DEFAULT_REPO = 'hjfdb/birdreport-rare-birds';
/** GitHub API 地址；可用 BIRD_UPDATE_API 换（GitHub Enterprise / 镜像，测试也用它指到本地桩） */
const DEFAULT_API = 'https://api.github.com';
/** 检查结果的缓存时长：6 小时（未登录 60 次/小时，够用且省） */
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
/** 单次请求超时：GitHub 偶尔慢，20 秒拿不到就当失败 */
const FETCH_TIMEOUT_MS = 20 * 1000;
/** 更新说明截断长度（Release 正文可能是几千字，弹层里放不下） */
const NOTES_MAX = 1200;

function nowMs() {
  return Date.now();
}

function clampText(s, n) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function sizeText(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/**
 * 挑出本平台该下哪个产物。
 *
 * 命名规则见 .github/workflows/release.yml：
 *   birdreport-rare-birds-<tag>-<target>.zip   （win-x64 / mac-arm64 / mac-x64）
 *   birdreport-rare-birds-<tag>-android-arm64.apk
 * 先按平台标识精确匹配；没匹配上再退一步：Android 拿任意 apk，桌面拿同系统的 zip
 * （比如 mac-arm64 没出包时让 Apple 芯片的用户先下 x64 走 Rosetta）。
 */
function pickAsset(assets, platform) {
  // ⚠ 字段名注意：cache 里存的是**映射后**的结构（name / size / url），
  //   不是 GitHub 原始的 browser_download_url —— 这里写错的话永远挑不到产物（踩过一次）。
  const list = (assets || []).filter((a) => a && a.name && a.url);
  const hit = list.find((a) => a.name.includes(platform));
  if (hit) return hit;
  const isApk = platform.startsWith('android');
  if (isApk) return list.find((a) => /\.apk$/i.test(a.name)) || null;
  const os = platform.split('-')[0];
  return list.find((a) => new RegExp(`-${os}-.+\\.zip$`, 'i').test(a.name)) || null;
}

/**
 * @param {object}   o
 * @param {string}   o.dataDir  数据目录（缓存与下载都放这儿）
 * @param {Function} [o.log]
 * @param {string}   [o.repo]   owner/name
 * @param {string}   [o.api]    API 根地址
 */
export function createUpdater({ dataDir, log = () => {}, repo, api } = {}) {
  const REPO = repo || process.env.BIRD_UPDATE_REPO || DEFAULT_REPO;
  const API = (api || process.env.BIRD_UPDATE_API || DEFAULT_API).replace(/\/+$/, '');
  const TTL_MS = Number(process.env.BIRD_UPDATE_TTL_MS) || DEFAULT_TTL_MS;
  const CACHE_FILE = path.join(dataDir, 'update.json');
  const DL_ROOT = path.join(dataDir, 'download');

  let cache = restore();
  /** 下载进度：网页端按 500ms 轮询它，所以状态放内存（重启就没了也无所谓，重下即可） */
  let dl = { state: 'idle', name: '', total: 0, received: 0, path: '', dir: '', error: '', doneVersion: '' };

  function restore() {
    try {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      return {
        checkedAt: Number(raw.checkedAt) || 0,
        latest: String(raw.latest || ''),
        notes: String(raw.notes || ''),
        publishedAt: String(raw.publishedAt || ''),
        pageUrl: String(raw.pageUrl || ''),
        assets: Array.isArray(raw.assets) ? raw.assets : [],
      };
    } catch {
      return null;
    }
  }

  function save() {
    if (!cache) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    } catch (e) {
      log(`[update] 缓存落盘失败：${e.message}`);
    }
  }

  /** 带超时的 fetch（Node 18+ 自带；GitHub 要求带 User-Agent） */
  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': `birdreport-region-hot/${appVersion().version}`,
          'x-github-api-version': '2022-11-28',
        },
      });
      if (res.status === 404) throw new Error('没有找到已发布的版本（仓库或 Release 还不存在）');
      if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchLatest() {
    const j = await getJson(`${API}/repos/${REPO}/releases/latest`);
    const assets = (Array.isArray(j.assets) ? j.assets : []).map((a) => ({
      name: String(a.name || ''),
      size: Number(a.size) || 0,
      url: String(a.browser_download_url || ''),
    }));
    return {
      checkedAt: nowMs(),
      latest: String(j.tag_name || '').replace(/^v/i, ''),
      notes: clampText(j.body, NOTES_MAX),
      publishedAt: String(j.published_at || ''),
      pageUrl: String(j.html_url || `https://github.com/${REPO}/releases`),
      assets,
    };
  }

  /**
   * 查一次（默认走缓存）。
   * 失败**不算检查过**：保留上一次的结果与 checkedAt，只把 error 报出去 ——
   * 这样界面能如实说「上次检查是几点，这次没连上」，而不是假装刚查过。
   */
  async function check({ force = false } = {}) {
    const age = cache ? nowMs() - cache.checkedAt : Infinity;
    if (!force && cache && age < TTL_MS) return snapshot('');
    try {
      cache = await fetchLatest();
      save();
      return snapshot('');
    } catch (e) {
      log(`[update] 检查更新失败：${e.message}`);
      return snapshot(e.message || String(e));
    }
  }

  function snapshot(error = '') {
    const cur = appVersion();
    const platform = platformId();
    const latest = cache ? cache.latest : '';
    const asset = cache ? pickAsset(cache.assets, platform) : null;
    return {
      current: cur.version,
      versionSource: cur.source,
      builtAt: cur.builtAt,
      platform,
      platformLabel: platformLabel(platform),
      isAndroid: IS_ANDROID,
      repo: REPO,
      latest,
      hasUpdate: !!latest && isNewer(latest, cur.version),
      notes: cache ? cache.notes : '',
      publishedAt: cache ? cache.publishedAt : '',
      pageUrl: cache ? cache.pageUrl : `https://github.com/${REPO}/releases`,
      asset: asset
        ? { name: asset.name, size: asset.size, sizeText: sizeText(asset.size), url: asset.url }
        : null,
      assetCount: cache ? cache.assets.length : 0,
      checkedAt: cache ? cache.checkedAt : 0,
      ttlMs: TTL_MS,
      nextCheckInMs: cache ? Math.max(0, TTL_MS - (nowMs() - cache.checkedAt)) : 0,
      download: { ...dl },
      error,
    };
  }

  /* ---------------- 下载 ---------------- */

  function resetDl() {
    dl = { state: 'idle', name: '', total: 0, received: 0, path: '', dir: '', error: '', doneVersion: '' };
  }

  /**
   * 开始下载本平台对应的产物。
   * 不 await 到结束 —— 网页端要一边看进度条一边显示百分比，所以这里立刻返回，
   * 进度靠 GET /api/update/download 轮询。
   */
  function startDownload() {
    if (dl.state === 'downloading') return { ...dl };
    const s = snapshot();
    if (!s.latest) return { ...dl, state: 'error', error: '还没有查到新版本，先检查一次' };
    if (!s.hasUpdate) return { ...dl, state: 'error', error: '当前已是最新版本' };
    if (!s.asset) return { ...dl, state: 'error', error: `这个版本没有对应 ${s.platformLabel} 的安装包` };

    dl = {
      state: 'downloading',
      name: s.asset.name,
      total: s.asset.size,
      received: 0,
      path: '',
      dir: '',
      error: '',
      doneVersion: s.latest,
    };
    // 故意不 catch 后重试：GitHub 的下载链接是短时有效的，失败就让用户再点一次
    downloadTo(s.asset, path.join(DL_ROOT, `v${s.latest}`)).catch((e) => {
      dl.state = 'error';
      dl.error = e.message || String(e);
      log(`[update] 下载失败：${dl.error}`);
    });
    return { ...dl };
  }

  async function downloadTo(asset, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, asset.name);
    // 已经下过、大小也对得上就直接用（重复点「更新」不该重下 34MB）
    try {
      const st = fs.statSync(dest);
      if (asset.size && st.size === asset.size) {
        dl.received = st.size;
        dl.total = asset.size;
        dl.path = dest;
        await finish(dest, dir);
        return;
      }
    } catch {
      /* 没下过，正常 */
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15 * 60 * 1000); // 34MB 慢网也要够
    let res;
    try {
      res = await fetch(asset.url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'user-agent': `birdreport-region-hot/${appVersion().version}` },
      });
      if (!res.ok) throw new Error(`下载地址返回 ${res.status}`);
      if (!res.body || !res.body.getReader) throw new Error('这个运行时不支持流式下载');

      const out = fs.createWriteStream(dest);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        dl.received += buf.length;
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    } finally {
      clearTimeout(timer);
    }
    dl.path = dest;
    dl.total = dl.total || dl.received;
    await finish(dest, dir);
  }

  /** 下完之后的收尾：桌面版把 zip 解开，Android 交给壳去装 */
  async function finish(dest, dir) {
    dl.dir = dir;
    if (!IS_ANDROID && /\.zip$/i.test(dest)) {
      const un = extractZip(dest, dir);
      if (!un.ok) log(`[update] 解压失败（不影响使用 zip）：${un.error}`);
      dl.extracted = un.ok;
    }
    dl.state = 'done';
  }

  /**
   * 解压 zip。不引第三方库（`zlib` 只能解 raw deflate，读不了 zip 的目录结构），
   * 所以借用系统自带工具：
   *   Windows 10+   —— PowerShell 的 Expand-Archive
   *   macOS / Linux —— unzip；没有 unzip 就退到 bsdtar（macOS 自带，能认 zip）
   */
  function extractZip(zip, dir) {
    const tries =
      process.platform === 'win32'
        ? [['powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]]]
        : [['unzip', ['-q', '-o', zip, '-d', dir]], ['tar', ['-xf', zip, '-C', dir]]];
    for (const [cmd, args] of tries) {
      const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 120000 });
      if (r.status === 0) return { ok: true };
      if (r.error && r.error.code === 'ENOENT') continue; // 这个命令没有，换下一个
      return { ok: false, error: `${cmd} 退出码 ${r.status}` };
    }
    return { ok: false, error: '找不到可用的解压命令' };
  }

  /** 在文件管理器里打开下载目录（桌面形态才有意义） */
  function reveal() {
    const target = dl.dir || DL_ROOT;
    if (!fs.existsSync(target)) return { ok: false, error: '还没有下载过新版本' };
    // 无 GUI 的环境 / 自动化测试里不要真的弹窗口（跟启动时的 OPEN_BROWSER=0 是同一类开关）
    if (process.env.BIRD_NO_OPEN_FOLDER === '1') return { ok: true, path: target, skipped: true };
    const [cmd, args] =
      process.platform === 'win32'
        ? ['explorer', [target]]
        : process.platform === 'darwin'
          ? ['open', [target]]
          : ['xdg-open', [target]];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => log(`[update] 打开文件夹失败：${e.message}`));
      child.unref();
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 打开 Release 页面（用系统浏览器；同样受 BIRD_NO_OPEN_FOLDER 约束） */
  function openPage() {
    const s = snapshot();
    if (process.env.BIRD_NO_OPEN_FOLDER !== '1') openInBrowser(s.pageUrl);
    return { ok: true, url: s.pageUrl, latest: s.latest, skipped: process.env.BIRD_NO_OPEN_FOLDER === '1' };
  }

  return {
    check,
    snapshot,
    startDownload,
    /** 供 Android 壳交给安装器用的绝对路径 */
    downloadState: () => ({ ...dl }),
    reveal,
    openPage,
    reset: () => {
      resetDl();
      return { ...dl };
    },
    dirs: { cache: CACHE_FILE, download: DL_ROOT },
  };
}
