/**
 * 发版助手 —— 算「下一个版本号」、打 tag、推送；也在 CI 里当 tag 的防呆校验器。
 *
 *   node release.mjs                     看：线上最新 tag → 建议的下一个版本（**不动任何东西**）
 *   node release.mjs minor               看：下一个次版本号（patch / minor / major，或直接写 0.1.0）
 *   node release.mjs --yes               打「下一个补丁版」的 tag 并推送
 *   node release.mjs 0.1.0 --yes         指定版本号
 *   node release.mjs --check v0.0.18     **CI 用**：只校验这个 tag 是不是真的比线上最新版更高
 *
 * 为什么要这个脚本：版本号就是 tag，仓库里没有任何「自动 +1」的机制 —— 打错了（比如手滑发了
 * 比线上更低的版本）谁也不会发现，而 App 里的更新提示是按版本号大小比的，发低了用户永远看不到更新。
 * 所以这里做两件事：
 *   · 本地：把「线上最新 → 建议的下一个」算给你看，并把 tag 指向的 commit 是否已推送等前置条件一并检查；
 *   · CI：`--check` 再验一次，不满足就让整个发布失败（见 .github/workflows/release.yml 的 guard）。
 *
 * ⚠ 比较规则**必须与 App 内部一致**（server/version.mjs 的 isNewer，按 semver：预发布版更旧）。
 *   不能图省事用 `sort -V`：GNU 的版本排序认为 `v0.1.0-beta` **比** `v0.1.0` **大**，
 *   而 semver 里预发布版是更旧的 —— 用它会放行一个其实更低的正式版。
 */
import { spawnSync } from 'node:child_process';
import { isNewer, normalizeVersion } from './server/version.mjs';

/** 报错时补一句最常见的网络原因（本机 Clash 没开时 git 连不上 GitHub；CI 上则是偶发） */
const PROXY_HINT =
  process.platform === 'win32'
    ? '提示：若报 “schannel: failed to receive handshake”，是本机 git 走的代理没在跑\n' +
      '      （~/.gitconfig 里的 http.proxy = http://127.0.0.1:7890，即 Clash），打开它即可。'
    : '提示：这是访问 GitHub 时的问题。重推一次同一个 tag 就能重跑本工作流：\n' +
      '      git push origin --force <tag>（Release 已存在时只会覆盖附件，不会失败）';

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    if (allowFail) return null;
    const err = (r.stderr || '').trim() || `退出码 ${r.status}`;
    throw new Error(`git ${args.join(' ')} 失败：${err}\n${PROXY_HINT}`);
  }
  return (r.stdout || '').trim();
}

/** 线上所有 tag（只看远端，本地可能有别人推的、也可能缺） */
function remoteTags() {
  const out = git(['ls-remote', '--tags', 'origin'], { allowFail: true });
  if (out === null) throw new Error(`拿不到线上 tag —— 网络或代理有问题。\n${PROXY_HINT}`);
  const set = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/refs\/tags\/(.+?)(\^\{\})?$/);
    if (m) set.add(m[1]); // 附注标签会出现两行（tag 对象本体 + 解引用），去重
  }
  return [...set];
}

/** tag 列表 → 版本号列表（只认 v 开头的版本号形式） */
function versionsOf(tags) {
  return tags.map((t) => (String(t).startsWith('v') ? normalizeVersion(t) : '')).filter(Boolean);
}

/** 取最大版本（就是 App 里那套 isNewer，保证「谁更新」两边判断一致） */
function maxVersion(list) {
  return list.reduce((best, v) => (!best || isNewer(v, best) ? v : best), '');
}

/** 下一个版本号：patch / minor / major（预发布后缀会去掉，正式版不该带 -beta） */
function bump(version, level) {
  const nums = String(version || '0.0.0')
    .split('-')[0]
    .split('.')
    .map((n) => Number(n) || 0);
  while (nums.length < 3) nums.push(0);
  if (level === 'major') nums[0] += 1, nums[1] = 0, nums[2] = 0;
  else if (level === 'minor') nums[1] += 1, nums[2] = 0;
  else nums[2] += 1;
  return nums.slice(0, 3).join('.');
}

/* ------------------------------------------------------------------ *
 * 模式二：CI 的校验（--check <tag>）
 * ------------------------------------------------------------------ */

function runCheck(tag) {
  const raw = tag || process.env.GITHUB_REF_NAME || '';
  const v = normalizeVersion(raw);
  if (!v) {
    console.error(c.red(`✗ tag「${raw}」不像版本号（应为 v0.0.18 这种），无法判断它有没有升版本`));
    return 1;
  }
  const latest = maxVersion(versionsOf(remoteTags()));
  if (!latest) {
    console.log(c.yellow('线上还没有任何版本 tag —— 这是第一个版本，跳过比较'));
    return 0;
  }
  if (v === latest) {
    console.log(c.yellow(`▸ tag 就是线上最新版（v${latest}）：按「重推同一个 tag」处理，只覆盖附件`));
    return 0;
  }
  if (!isNewer(v, latest)) {
    console.error(
      c.red(`✗ 这个 tag 不比线上版本高：线上最新 v${latest}，本次 v${v}\n`) +
        '  版本号只能往前走 —— 发一个更低的版本，App 里的更新提示会一直显示「有更新」而用户永远装不上（或装成旧的）。\n' +
        `  想发新版：改用 v${bump(latest, 'patch')}（或更高的号）重新打 tag。`,
    );
    return 1;
  }
  console.log(c.green(`✓ 版本号确实升了：线上最新 v${latest} → 本次 v${v}`));
  return 0;
}

/* ------------------------------------------------------------------ *
 * 模式一：本地算版本 / 打 tag
 * ------------------------------------------------------------------ */

function runLocal(spec, yes) {
  const latest = maxVersion(versionsOf(remoteTags()));
  const next = /^[0-9]/.test(spec) ? normalizeVersion(spec) : bump(latest || '0.0.0', spec);
  if (!next) {
    console.error(c.red(`✗ 不认识「${spec}」——用法：patch / minor / major，或直接写版本号如 0.1.0`));
    return 1;
  }
  const tag = `v${next}`;

  console.log(`${c.dim('线上最新版本')}  ${latest ? 'v' + latest : '（还没有任何版本）'}`);
  console.log(`${c.dim('本次要发的版本')}  ${c.bold(tag)}`);

  // 前置条件：都过了才算「确定会升一个版本且发得出去」
  const problems = [];
  if (latest && !isNewer(next, latest)) problems.push(`不比线上最新版高（v${latest}）—— 版本号只能往前走`);
  if (git(['tag', '-l', tag])) problems.push(`本地已经存在同名 tag ${tag}（要重发就先 git tag -d ${tag}）`);
  if (git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { allowFail: true })) {
    problems.push(`线上已经存在 ${tag}（同一个 tag 重推只会覆盖附件，不会发新版本）`);
  }
  const dirty = git(['status', '--porcelain']);
  if (dirty) problems.push(`工作区有未提交的改动（tag 会指向一个不含这些改动的 commit）：\n      ${dirty.split('\n').slice(0, 5).join('\n      ')}`);
  const head = git(['rev-parse', 'HEAD']);
  const remoteHead = (git(['ls-remote', 'origin', 'refs/heads/main'], { allowFail: true }) || '').split(/\s+/)[0] || '';
  if (!remoteHead) problems.push('拿不到线上 main 的位置（网络/代理？）');
  else if (remoteHead !== head) {
    problems.push(
      `本地 HEAD（${head.slice(0, 7)}）还没推到线上 main（${remoteHead.slice(0, 7)}）——\n` +
        '      先 git push 再打 tag，否则 tag 指向的 commit 线上根本没有，CI 检出的代码是旧的',
    );
  }

  if (problems.length) {
    console.error(`\n${c.red('✗ 还不能发版：')}`);
    for (const p of problems) console.error(`  · ${p}`);
    return 1;
  }

  console.log(c.green(`\n✓ 版本号确实升了，tag 指向的 commit 也已经在线上`));
  if (!yes) {
    console.log(c.dim(`\n（这只是预演，什么都没动。确认无误后：node release.mjs ${spec} --yes）`));
    return 0;
  }

  git(['tag', tag]);
  console.log(`▸ 已打 tag ${tag}`);
  git(['push', 'origin', tag]);
  console.log(`▸ 已推送 ${tag}`);
  const repo = (git(['remote', 'get-url', 'origin'], { allowFail: true }) || '').replace(/\.git$/, '');
  console.log(`\n${c.green('发布已开始')}（约 3~5 分钟）：${repo}/actions`);
  return 0;
}

/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
try {
  const checkAt = args.indexOf('--check');
  if (checkAt >= 0) {
    process.exit(runCheck(args[checkAt + 1]));
  }
  const yes = args.includes('--yes');
  const spec = args.find((a) => !a.startsWith('--')) || 'patch';
  process.exit(runLocal(spec, yes));
} catch (e) {
  console.error(c.red('✗ ' + e.message));
  process.exit(1);
}
