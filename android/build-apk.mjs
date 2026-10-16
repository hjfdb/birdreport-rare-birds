/**
 * 一键构建 Android APK（Windows / macOS / Linux 通用）。
 *
 *   npm run build:apk                  ← 等价于 node android/build-apk.mjs
 *   node android/build-apk.mjs         release APK → dist/birdreport-rare-birds-v<版本>-android-arm64.apk
 *   node android/build-apk.mjs --debug  debug APK（快，但体积大、启动慢）
 *   node android/build-apk.mjs --clean  先 clean 再构建
 *   node android/build-apk.mjs --java-home "C:\path\to\jdk-17"   手动指定 JDK
 *
 * 为什么要这个脚本，而不是让用户直接 `cd android && ./gradlew`：AGP 8.x
 * **必须要 JDK 17**，而很多机器上 JAVA_HOME 指着 JDK 8（本机就是），报出来的错是
 * "Unsupported class file major version 61" / "Android Gradle plugin requires Java 17"，
 * 一眼看不出是 JDK 的问题。脚本负责：
 *   ① 探测一个 JDK 17+ 并通过 -Dorg.gradle.java.home 传给 Gradle；
 *   ② 缺 nodejs-mobile 运行时（libnode.so）就自动拉；
 *   ③ 在 android/local.properties 里补 sdk.dir；
 *   ④ 构建完把产物路径与大小打出来。
 *
 * 可以用环境变量覆盖版本号（CI 里就是这么做的，让 APK 里的 versionName 与发布 tag 对上）：
 *   BIRD_VERSION_NAME=1.2.3    BIRD_VERSION_CODE=42
 *
 * 注意：调子进程一律用异步 spawn，不用 spawnSync / execFileSync —— 某些受管控的机器
 * （沙箱 / 安全软件策略）只允许异步创建进程，同步创建直接 EBUSY。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectVersion, writeBakedVersion } from '../server/version.mjs';

const ANDROID_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(ANDROID_DIR, '..');
const DIST = path.join(ROOT, 'dist');
const LOCAL_PROPS = path.join(ANDROID_DIR, 'local.properties');

const DEBUG = process.argv.includes('--debug');
const CLEAN = process.argv.includes('--clean');
const JAVA_HOME_ARG = (() => {
  const i = process.argv.indexOf('--java-home');
  return i >= 0 ? process.argv[i + 1] : process.env.BIRD_JDK || '';
})();

const REQUIRED_JAVA = 17;
const VMODULES = path.join(ANDROID_DIR, 'third_party', 'nodejs-mobile');
const LIBNODE = path.join(VMODULES, 'bin', 'arm64-v8a', 'libnode.so');

const isWin = process.platform === 'win32';

const log = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

/* ------------------------------------------------------------------ *
 * 跑外部命令
 * ------------------------------------------------------------------ */

/** 跑命令并继承输出（构建用） */
function run(cmd, args, { cwd = ROOT, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`退出码 ${code}`))));
  });
}

/** 跑命令只收输出（探测用），失败也返回已拿到的文本 */
function capture(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

/* ------------------------------------------------------------------ *
 * ① 找 JDK 17+
 * ------------------------------------------------------------------ */

/** 从 java -version 的输出里抠出主版本号（8 / 11 / 17 / 21 …） */
function parseJavaVersion(text) {
  const m = /version\s+"?(\d+)(?:\.(\d+))?/.exec(text || '');
  if (!m) return 0;
  const first = Number(m[1]);
  // "1.8.0_131" 这种老写法：真正的主版本是第二段
  return first === 1 ? Number(m[2] || 0) : first;
}

/** java -version 把版本号打到 stderr 上，所以 capture 把两路都收下来再解析 */
async function javaMajor(javaExe) {
  return parseJavaVersion(await capture(javaExe, ['-version']));
}

/** 候选 JDK 目录：先显式指定，再 JAVA_HOME，最后按平台常见位置扫 */
function jdkCandidates() {
  const list = [];
  if (JAVA_HOME_ARG) list.push(JAVA_HOME_ARG);
  if (process.env.JAVA_HOME) list.push(process.env.JAVA_HOME);

  const glob = (dir, re) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => re.test(n))
        .map((n) => path.join(dir, n));
    } catch {
      return [];
    }
  };

  if (isWin) {
    list.push('C:\\Program Files\\jdk', 'C:\\Program Files\\Java\\jdk');
    for (const drive of ['C:', 'D:']) {
      for (const base of [`${drive}\\Program Files\\Java`, `${drive}\\Program Files\\Eclipse Adoptium`, `${drive}\\Program Files\\Microsoft`, `${drive}\\Program Files\\Zulu`, `${drive}\\Program Files\\Amazon Corretto`]) {
        list.push(...glob(base, /^jdk/i));
      }
    }
    // Android Studio 自带的 JBR 就是 JDK 17，装了 Studio 的机器一定有
    list.push('C:\\Program Files\\Android\\Android Studio\\jbr');
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home');
    list.push(...glob('/Library/Java/JavaVirtualMachines', /.*/).map((d) => path.join(d, 'Contents', 'Home')));
    list.push('/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@17');
  } else {
    list.push(...glob('/usr/lib/jvm', /.*/));
    list.push('/usr/lib/android-sdk/jbr');
  }
  return list;
}

async function findJdk() {
  const seen = new Set();
  const tried = [];
  for (const home of jdkCandidates()) {
    if (!home || seen.has(home)) continue;
    seen.add(home);
    const exe = path.join(home, 'bin', isWin ? 'java.exe' : 'java');
    if (!fs.existsSync(exe)) continue;
    const major = await javaMajor(exe);
    tried.push(`${home}  →  Java ${major || '无法识别'}`);
    if (major >= REQUIRED_JAVA) return { home, major };
  }
  if (tried.length) {
    console.error('\n探测过的位置：');
    for (const t of tried) console.error(`  · ${t}`);
  }
  fail(
    `没找到 JDK ${REQUIRED_JAVA}+（AGP 8.x 的硬性要求）。\n` +
      `  装一个后重试：https://adoptium.net/\n` +
      `  或显式指定：node android/build-apk.mjs --java-home "C:\\path\\to\\jdk-17"`,
  );
}

/* ------------------------------------------------------------------ *
 * ② 依赖准备
 * ------------------------------------------------------------------ */

async function ensureNodeRuntime() {
  if (fs.existsSync(LIBNODE)) {
    const mb = (fs.statSync(LIBNODE).size / 1048576).toFixed(0);
    log(`nodejs-mobile 运行时已就绪（libnode.so ${mb} MB）`);
    return;
  }
  log('缺少 nodejs-mobile 运行时，开始拉取（约 130 MB，只需一次）…');
  await run(process.execPath, [path.join(ANDROID_DIR, 'fetch-nodejs-mobile.mjs')], { cwd: ANDROID_DIR });
  if (!fs.existsSync(LIBNODE)) fail('拉完了还是没找到 libnode.so，包结构可能变了');
}

function ensureLocalProperties() {
  if (fs.existsSync(LOCAL_PROPS)) return;
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdk) {
    fail(
      '找不到 Android SDK。两种办法：\n' +
        '  · 设环境变量 ANDROID_SDK_ROOT 指向 SDK 目录；\n' +
        '  · 或自己建 android/local.properties，写一行 sdk.dir=<SDK 路径>。\n' +
        '  SDK 里还需要：platforms;android-33、build-tools;33.0.2、ndk;25.1.8937393、cmake;3.22.1。',
    );
  }
  // Windows 的 sdk.dir 里冒号和反斜杠都要转义，否则 Properties 解析不出来
  const value = isWin ? sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:') : sdk;
  fs.writeFileSync(LOCAL_PROPS, `sdk.dir=${value}\n`);
  log(`已写入 local.properties（sdk.dir=${sdk}）`);
}

/**
 * 把版本号写进 `web/version.json`。
 *
 * Gradle 的 nodejsProject 任务是**整目录**拷 `web/` 进 APK 的 assets，所以这个文件会跟着进去，
 * 手机上的 Node 进程就能用 `readWebFile('version.json')` 读出「我是哪一版」——
 * 「我的」面板里的版本号与更新检查都靠它（见 server/version.mjs）。
 * 必须**在 Gradle 之前**写，否则拷进去的还是上一版。
 */
function stampVersion(version) {
  const web = path.join(ROOT, 'web');
  const { file, version: v } = writeBakedVersion(web, { version, platform: 'android-arm64' });
  log(`已写入版本戳 ${path.relative(ROOT, file)} → ${v}`);
}

/* ------------------------------------------------------------------ *
 * ③ 构建
 * ------------------------------------------------------------------ */

async function main() {
  console.log(`\n构建 Android APK（${DEBUG ? 'debug' : 'release'}）\n`);

  // 版本号：CI 用 tag（BIRD_VERSION_NAME），本地构建自动跟着最近的 git tag
  // （detectVersion 的优先级见 server/version.mjs）。
  // ⚠ 必须**同一个值**同时给 Gradle 的 versionName 和 assets 里的 web/version.json ——
  //   否则「我的」里显示的版本会和系统「应用信息」里的对不上（本地构建默认 1.0.0 就是这种）
  const versionName = process.env.BIRD_VERSION_NAME || detectVersion(ROOT);

  const jdk = await findJdk();
  log(`使用 JDK ${jdk.major}：${jdk.home}`);

  await ensureNodeRuntime();
  ensureLocalProperties();
  stampVersion(versionName);

  const javaExe = path.join(jdk.home, 'bin', isWin ? 'java.exe' : 'java');
  // 直接用 java 跑 wrapper jar，而不是 gradlew / gradlew.bat：
  //   · gradlew 是 shell 脚本，gradlew.bat 必须经 cmd.exe 才能启动，
  //     而某些受管控的环境里创建 cmd.exe 会被策略拦掉；
  //   · 用我们已经探测好的那个 JDK 来启动，顺带把「JAVA_HOME 指着 JDK 8」的问题彻底绕开。
  // GradleWrapperMain 内部做的事和 gradlew.bat 完全一样（按 gradle-wrapper.properties 下载/启动 Gradle）。
  const wrapperJar = path.join(ANDROID_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!fs.existsSync(wrapperJar)) fail(`找不到 ${wrapperJar}，android/gradle/wrapper/ 下的文件不完整`);

  const args = [];
  // clean 必须排在最前面：Gradle 按命令行顺序执行任务，写在后面就成了「构建完再删」
  if (CLEAN) args.push('clean');
  args.push(DEBUG ? ':app:assembleDebug' : ':app:copyApkToDist', '--console=plain');
  // java.home 只走命令行，不写进 gradle.properties —— 那个文件是进 git 的，
  // 写死绝对路径会把 CI（Linux）与别人的机器一起弄坏。
  args.push(`-Dorg.gradle.java.home=${jdk.home}`);
  // 版本号（上面的 versionName：CI 是 tag，本地跟着 git tag），让 APK 里的版本与发布名对得上
  args.push(`-PbirdVersionName=${versionName}`);
  if (process.env.BIRD_VERSION_CODE) args.push(`-PbirdVersionCode=${process.env.BIRD_VERSION_CODE}`);

  console.log('');
  log(`执行：GradleWrapperMain ${args.join(' ')}\n`);
  try {
    await run(javaExe, ['-classpath', wrapperJar, 'org.gradle.wrapper.GradleWrapperMain', ...args], { cwd: ANDROID_DIR });
  } catch (e) {
    fail(`Gradle 构建失败：${e.message}`);
  }

  // 报产物：release 走 copyApkToDist 会落到 dist/，debug 留在自己的输出目录里
  const found = DEBUG ? path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'debug') : DIST;
  const apks = fs.existsSync(found) ? fs.readdirSync(found).filter((n) => n.endsWith('.apk')) : [];
  if (!apks.length) fail(`构建报了成功，但没找到 APK（找的是 ${found}）`);

  console.log('');
  for (const name of apks) {
    const p = path.join(found, name);
    log(`${name}（${(fs.statSync(p).size / 1048576).toFixed(1)} MB）`);
    log(`  ${p}`);
  }
  console.log(`\n装到手机（需要开 USB 调试）：\n  adb install -r "${path.join(found, apks[0])}"\n`);
}

main().catch((e) => fail(e.stack || e.message));
