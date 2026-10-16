/**
 * 啾讯 · 观鸟地区稀有鸟种榜 · 网页端
 * 纯原生 JS，无第三方依赖；图表用内联 SVG 手绘。
 *
 * 榜单语义：上游 front/record/activity/taxon 按区域给出各鸟种的记录数，
 * 本页按记录数**升序**展示 —— 记录最少 = 在本地最稀有，排最前面。
 */
'use strict';

const $ = (id) => document.getElementById(id);

const API = (() => {
  // 用 file:// 双击打开页面时，这里会指向本机服务端。
  // 不能直连上游：记录中心的接口虽然有 CORS 头，但从 file:// 发出仍会被浏览器拦下，
  // 所以取数统一交给本机服务端完成（服务端已对 /api/* 放开 Access-Control-Allow-Origin）。
  const base = location.protocol.startsWith('http') ? '' : 'http://127.0.0.1:8787';
  // method 默认 GET；写操作（监听开关、清空历史）走 POST，参数照样放 query string ——
  // 服务端路由就是按 `${method} ${pathname}` 分发、从 url.searchParams 读参数的。
  return (p, q, signal, method) => {
    const u = new URL(base + '/api/' + p, location.href);
    if (q) for (const k in q) if (q[k] !== undefined && q[k] !== null && q[k] !== '') u.searchParams.set(k, q[k]);
    const init = { method: method || 'GET' };
    if (signal) init.signal = signal;
    return fetch(u, init).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `请求失败 (${r.status})`);
      return j;
    });
  };
})();

/** 用 file:// 双击打开时为 true：页面本身不带服务端，取数走 http://127.0.0.1:8787 */
const STANDALONE = !location.protocol.startsWith('http');

/**
 * Android 壳（APK）注入的桥，只有那里面才有；浏览器 / exe 里是 null。
 * 目前只用它做两件事：申请通知权限、把「监听开着没」同步给后台轮询线程。
 * 每次调用都要经它判空 —— 网页端不能因为拿不到桥就报错。
 */
const ANDROID = (() => {
  try {
    const b = window.BirdAndroid;
    return b && b.isAndroid && b.isAndroid() ? b : null;
  } catch (e) {
    return null;
  }
})();

/** 上一次筛选条件的本地存储键；与地址栏参数配合，实现「刷新后选择还在」 */
const STORAGE_KEY = 'birdreport.ui.v1';

/**
 * 「我的」默认绑定的记录中心用户名：**默认不绑定（空）**。
 * 首次打开时输入框留空，由用户自己填；地址栏 / 本地存储里的绑定状态优先。
 * 用户取消绑定后会记住「已解绑」这个状态，不会又被默认值拉回去。
 */
const DEFAULT_LIFER_USER = '';

/** 侧栏三块图表（逐月鸟种数 / 逐月报告数 / 地区排行）是否启用，对应 index.html 里 #sideCols 的 hidden */
const sideChartsVisible = () => !$('sideCols').hidden;

const state = {
  provinces: [],
  region: { province: '', city: '', district: '' },
  // 时间范围只由这两个日期决定（没有档位按钮）；两个都为空 = 全部时间
  start: '',
  end: '',
  filter: 'all',
  sort: 'record',
  q: '',
  // ---- 记录检索（顶部查询栏，与「榜单内筛选 q」不同：这几个条件会一起下推到上游）----
  point: '',      // 观测地点关键字 → 上游 pointname
  user: '',       // 用户名称（记录人）→ 上游 username
  taxonName: '',  // 用户填写的鸟种名称原文
  taxonId: '',    // 解析出的 taxon_id；空表示未按鸟种收窄
  // ---- 「我的」：绑定的记录中心用户名（空 = 未绑定）----
  // 与上面 state.user 是两件事：state.user 是「把榜单收窄到这个人的记录」，
  // state.lifer 是「拿这个人的名单来比对谁没加新」。参数名也因此分开（username / liferUser）。
  lifer: '',
  liferInfo: null, // 最近一次 /api/user-lifelist 的结果，供「我的」面板展示
  puzzle: null, // 最近一次 /api/lifer-puzzle 的结果（收集拼图），只在打开拼图时才有
  liferNocache: false, // 一次性开关：下一次查询忽略人生鸟种缓存（不影响地区榜单缓存）
  hot: null,
  trend: null,
  regionRank: null,
  overview: null,
  nocache: false,
  timer: null,
};

/* ---------------------------------------------------------------- *
 * 通用工具
 * ---------------------------------------------------------------- */
const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('zh-CN'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 用本地日期，避免 toISOString 的 UTC 偏移（北京时间凌晨会串到前一天）
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function setStatus(kind, text) {
  $('statusDot').className = 'dot ' + (kind || '');
  $('statusText').textContent = text;
}
/**
 * 带退场动画地隐藏一个弹层：加 is-closing 播 CSS 退场动画，随后真正 hidden。
 * 期间若被重新打开（show 路径会去掉 is-closing），这次关闭自动作废。
 * 系统开了「减少动态效果」则立即隐藏。
 */
function hideAnimated(el, ms = 220) {
  if (!el || el.hidden || el.classList.contains('is-closing')) return;
  if (
    document.documentElement.classList.contains('anim-none') ||
    (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    el.hidden = true;
    return;
  }
  el.classList.add('is-closing');
  setTimeout(() => {
    if (el.classList.contains('is-closing')) {
      el.classList.remove('is-closing');
      el.hidden = true;
    }
  }, ms);
}

/* ---------------------------------------------------------------- *
 * 弹出动画偏好：类型在「我的」面板里选（存本机），设在 <html> 的 anim-* 类上。
 * standard（默认）/ zoom / fade / slide / bounce / none —— 具体见 style.css。
 * ---------------------------------------------------------------- */
const ANIM_KEY = 'birdreport.anim.v1';
const ANIM_TYPES = ['zoom', 'standard', 'fade', 'slide', 'bounce', 'none'];
const ANIM_DEFAULT = 'zoom'; // 默认：缩放弹出
const ANIM_LABELS = { standard: '标准（上浮）', zoom: '缩放弹出', fade: '淡入', slide: '侧滑', bounce: '弹跳', none: '关闭动画' };
let animType = (() => {
  try {
    const v = localStorage.getItem(ANIM_KEY);
    return ANIM_TYPES.includes(v) ? v : ANIM_DEFAULT;
  } catch (e) {
    return ANIM_DEFAULT;
  }
})();
function applyAnim() {
  for (const t of ANIM_TYPES) document.documentElement.classList.toggle('anim-' + t, t === animType);
}
function setAnim(t) {
  animType = ANIM_TYPES.includes(t) ? t : ANIM_DEFAULT;
  try {
    localStorage.setItem(ANIM_KEY, animType);
  } catch (e) { /* 隐私模式：忽略 */ }
  applyAnim();
}
applyAnim();

/**
 * 弹层**内部**的视图切换动画（明细列表 ⇄ 报告详情）。
 *
 * 上面那套弹出动画只管「开弹层」，层内换视图原本是直接换 innerHTML 的硬切 —— 所以
 * 在报告明细里点「查看」进报告详情，是一点过渡都没有的。这里补 push / pop：
 * 进去从右侧推入、返回从左侧推回。
 *
 * 动画挂在容器 `#detailBody` 上而不是内容上：换 innerHTML 不会打断容器上正在播的
 * 动画，于是「转圈 → 内容」由一条动画连到底，不会中途跳一下。
 * 见 style.css 里 `.pane-*` 那段（为什么不跟随 anim-zoom / anim-bounce）。
 */
const PANE_ANIMS = ['pane-push', 'pane-pop', 'pane-settle'];
/** class → @keyframes 名（style.css 里定义），用来认领 animationend 事件 */
const PANE_KEYFRAMES = { 'pane-push': 'panePush', 'pane-pop': 'panePop', 'pane-settle': 'paneSettle' };
const PANE_NAV_MS = 240; // 与 .pane-push / .pane-pop 的时长保持一致
let paneNavUntil = 0;
function paneAnimOff() {
  return (
    document.documentElement.classList.contains('anim-none') ||
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}
function clearPaneAnim(el) {
  for (const k of PANE_ANIMS) el.classList.remove(k);
}
/**
 * 播一次层内切换动画。
 *
 * 播完必须把 class 摘掉：动画会随元素「display:none → 显示」一起重播，而弹层关掉再打开
 * 正好就是这条路径 —— 留着 class 的话，重新打开「报告明细」会在弹层淡入的同时
 * 又莫名其妙地播一次侧推。
 */
function playPaneAnim(el, kind) {
  clearPaneAnim(el);
  void el.offsetWidth; // 强制重排，保证同名动画能重播（否则连点两次看不出第二次）
  el.classList.add(kind);
  const done = (e) => {
    // animationend 会冒泡，后代元素（比如转圈的 spinner）的事件要滤掉
    if (e.target !== el || e.animationName !== PANE_KEYFRAMES[kind]) return;
    el.classList.remove(kind);
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}
/** 层内导航：pane-push = 进详情，pane-pop = 返回列表。总是重播，会覆盖正在播的 settle。 */
function paneNav(kind) {
  const el = $('detailBody');
  if (!el) return;
  clearPaneAnim(el);
  if (paneAnimOff()) {
    paneNavUntil = 0;
    return;
  }
  playPaneAnim(el, kind);
  paneNavUntil = Date.now() + PANE_NAV_MS;
}
/** 内容落地：只有进场动画已经播完才补一下淡入，否则会把它打断（直接跳到尾帧）。 */
function paneSettle() {
  const el = $('detailBody');
  if (!el || paneAnimOff() || Date.now() < paneNavUntil) return;
  playPaneAnim(el, 'pane-settle');
}

function showLoading(text) {
  $('loadingText').textContent = text || '正在汇总数据…';
  $('loading').classList.remove('is-closing');
  $('loading').hidden = false;
}

/**
 * 错误提示统一出口。上游限流（code 505 / 405）时给一条可操作的出路：
 * 记录中心的验证码是**按 IP 记的**，同一网络下过一次验证码，本机服务端的请求会一起解封；
 * 不想看验证码也可以等几分钟。
 *
 * 验证在**应用内**完成：官方那页没有 X-Frame-Options、也没有 CSP frame-ancestors，可以 iframe 嵌；
 * 它取图 / 提交验证都走 api.birdreport.cn，而 iframe 的文档 Origin 就是官网，所以 CORS 天然合法，
 * 不需要我们在服务端做代理。
 */
const CAPTCHA_PAGE = 'https://www.birdreport.cn/home/code/verify.html';

/**
 * 接住官方验证码页的「验证通过」回调。
 *
 * 那一页原本跑在官网自己的 layui 弹层里，验证成功后执行的是：
 *   var index = parent.layer.getFrameIndex(window.name);
 *   parent.layer.close(index);
 * 我们把它 iframe 嵌进来之后，**父窗口就是本页** —— 所以在这里补一个同名的
 * window.layer，就能原样接住这个信号，既不用改上游页面（跨域，也改不了），
 * 也不用轮询猜「到底过了没有」。缺这个对象时它会抛 TypeError，我们就无从得知结果。
 *
 * 只补它实际用到的两个方法：getFrameIndex 的返回值它只在 close 里回传，随便给个 0；
 * close 就是「验证通过」的那一刻。
 */
window.layer = {
  getFrameIndex: () => 0,
  close: () => onCaptchaPassed(),
};

let captchaPassed = false;

/** 打开限流验证码浮层（验证码在应用内解决，不跳系统浏览器） */
function openCaptcha() {
  const m = $('captchaModal');
  if (!m || !m.hidden) return;
  captchaPassed = false;
  $('captchaDone').hidden = true;
  const tip = $('captchaTip');
  tip.classList.remove('is-ok');
  // 实测发现：记录中心那张验证码图（front/code/visited/generate）在「当前网络其实没被封」时
  // 会返回 200 + image/jpeg 但**内容 0 字节**，页面上就是一张裂图。这不是我们能修的（跨域、且
  // 官方自己在浏览器里直接打开也一样），所以这里把两种可能都写给用户，别让人干等。
  tip.innerHTML =
    '记录中心认为你当前的网络访问过于频繁。输入下面这张验证码即可<b>立即解封</b>（按 IP 记，同一网络下的设备一起解封）。' +
    '<br />图片是空白？点一下图片可以「换一张」；若一直是空白，说明当前网络其实没被封，直接关掉重新查询即可。';
  // 每次打开都重新载入：验证码有时效，而且上一次的验证状态不该被复用
  const f = $('captchaFrame');
  f.src = 'about:blank';
  f.src = CAPTCHA_PAGE;
  m.hidden = false;
  $('captchaClose').focus();
}

/** 关掉浮层（顺带停掉 iframe，别让验证码页在后台继续跑） */
function closeCaptcha() {
  const m = $('captchaModal');
  if (!m || m.hidden) return;
  m.hidden = true;
  $('captchaFrame').src = 'about:blank';
}

/** 官方页回调：验证通过（见上面 window.layer 的说明） */
function onCaptchaPassed() {
  if (captchaPassed) return;
  captchaPassed = true;
  const tip = $('captchaTip');
  tip.classList.add('is-ok');
  tip.textContent = '验证通过，记录中心已解封（同一网络下通用）。';
  $('captchaDone').hidden = false;
  $('captchaDoneBtn').focus();
}

/** 验证通过后点「关闭并返回主页面」：收起所有弹层 + 重新查一次 */
function captchaDoneAndBack() {
  closeCaptcha();
  // 「返回主页面」要真的回到主页面：浮层可能是在明细 / 报告 / 「我的」之上打开的
  const pv = $('photoViewer');
  if (pv && !pv.hidden) closePhotos();
  if (!$('myModal').hidden) closeMy();
  if (detail.open) closeDetail();
  showToast('已解封，正在重新查询…');
  runQuery();
}

function errNoticeHtml(prefix, message) {
  const msg = String(message || '');
  if (/code\s*(505|405)/.test(msg)) {
    // 用按钮而不是 <a target="_blank">：APK 里 WebView 默认不新开窗口，那个链接会被
    // 交给系统浏览器打开，等于把用户踢出应用（见 MainActivity 的 onCreateWindow）。
    // 改成在本页开浮层，验证完关掉就回到主页面。
    return (
      `<div class="notice error">${esc(prefix)}${esc(msg)}<br />` +
      `被记录中心限流了：<button class="btn btn-mini captcha-open" type="button">输入一次验证码</button>` +
      ` 即可立即解封（按 IP 记，同一网络下的设备一起解封），或过几分钟再试。</div>`
    );
  }
  return `<div class="notice error">${esc(prefix)}${esc(msg)}</div>`;
}
function hideLoading() {
  hideAnimated($('loading'), 180);
}

/* ---------------------------------------------------------------- *
 * 地区级联
 * ---------------------------------------------------------------- */
async function loadProvinces() {
  const r = await API('provinces');
  state.provinces = r.data || [];
  const sel = $('selProvince');
  sel.innerHTML = '<option value="">全国</option>' + state.provinces.map((p) => `<option value="${esc(p.name)}" data-code="${esc(p.code)}">${esc(p.name)}</option>`).join('');
}

async function loadCities() {
  const sel = $('selCity');
  const dsel = $('selDistrict');
  sel.innerHTML = '<option value="">全部</option>';
  dsel.innerHTML = '<option value="">全部</option>';
  dsel.disabled = true;
  const provName = state.region.province;
  if (!provName) { sel.disabled = true; return; }
  const prov = state.provinces.find((p) => p.name === provName);
  sel.disabled = false;
  if (!prov) return;
  const r = await API('cities', { provinceCode: prov.code });
  const list = r.data || [];
  sel.innerHTML = '<option value="">全部</option>' + list.map((c) => `<option value="${esc(c.name)}" data-code="${esc(c.code)}">${esc(c.name)}</option>`).join('');
  if (list.length === 1) {
    // 直辖市只有一个「市」，自动选中，查询可直接下钻到区县
    sel.value = list[0].name;
    state.region.city = list[0].name;
  }
  await loadDistricts();
}

async function loadDistricts() {
  const dsel = $('selDistrict');
  dsel.innerHTML = '<option value="">全部</option>';
  const cityName = $('selCity').value;
  if (!cityName) { dsel.disabled = true; return; }
  const cityOpt = $('selCity').selectedOptions[0];
  const code = cityOpt && cityOpt.dataset.code;
  if (!code) { dsel.disabled = true; return; }
  dsel.disabled = false;
  const r = await API('districts', { cityCode: code });
  const list = r.data || [];
  dsel.innerHTML = '<option value="">全部</option>' + list.map((d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`).join('');
}

function currentWhere() {
  const where = {};
  if (state.region.province) where.province = state.region.province;
  if (state.region.city) where.city = state.region.city;
  if (state.region.district) where.district = state.region.district;
  if (state.start) where.startTime = state.start;
  if (state.end) where.endTime = state.end;
  // 记录检索条件：上游 record/activity/* 与统计接口都认这三个参数（已实测）
  if (state.point) where.pointname = state.point;
  if (state.user) {
    where.username = state.user;
    // 上游的 mode 是**整条查询**的匹配方式（省略/0 = 模糊，1 = 精确），
    // 它同时作用于 pointname 与 username，没法只让其中一个精确。
    // 所以在「只填了用户名」时用精确匹配（否则查 kkia 会把名字含 kkia 的别人也算进来），
    // 一旦同时填了观测地点就不传 mode —— 地点那栏的模糊匹配（「奥森」能命中
    // 「奥林匹克森林公园（奥森）」）是既有功能，不能顺手改掉。
    if (!state.point) where.mode = 1;
  }
  if (state.taxonId) where.taxonid = state.taxonId;
  return where;
}

/** 当前生效的记录检索条件（短标签，用于榜单标题） */
function filterSummary() {
  const parts = [];
  if (state.point) parts.push(`地点「${state.point}」`);
  if (state.user) parts.push(`用户「${state.user}」`);
  if (state.taxonId) parts.push(`鸟种「${state.taxonName || state.taxonId}」`);
  else if (state.taxonName) parts.push(`鸟种「${state.taxonName}」未匹配`);
  return parts;
}

function regionText() {
  // 直辖市的「市」与「省」同名，标签里只保留一个，避免「北京市 / 北京市」
  const parts = [state.region.province, state.region.city === state.region.province ? '' : state.region.city, state.region.district].filter(Boolean);
  return parts.length ? parts.join(' / ') : '全国';
}

/* ---------------------------------------------------------------- *
 * 时间范围
 *
 * 界面上只有「起始日期 / 结束日期」两个输入框，没有档位按钮。
 *   - 首次打开默认「当天」（起止同一天），与之前的默认行为一致
 *   - 两个日期都清空 = 全部时间（省份范围仍可查）；但**全国范围**必须两个都填，
 *     否则数据量会到上千万条（见 renderRegionHint 与 runQuery 的拦截）
 * ---------------------------------------------------------------- */

/** 默认时间范围：当天 */
function defaultRange() {
  const today = iso(new Date());
  return { start: today, end: today };
}

/** 把起止日期写进 state 与输入框 */
function applyTimeState(start, end) {
  state.start = start || '';
  state.end = end || '';
  $('inpStart').value = state.start;
  $('inpEnd').value = state.end;
  renderRegionHint(); // 「全国」那条提示跟日期是否填齐有关，日期一变就重算
}

/**
 * 「全国」的即时提示。
 *
 * 省份下拉的第一项是「全国」。它**能查**（早先「数据源不提供全国范围」的判断是错的 ——
 * 那几次真因是 505 风控），但不带时间限制时上游聚合会拉到上千万条
 * （实测：单日 0.8 万条 / 一周 17.5 万条 / 一个月 62.7 万条 / 无时间 1358 万条），
 * 所以全国范围内起止日期必须同时给（runQuery 里也会拦一道）。
 *
 * 这里在**选中「全国」的当下**就说清楚，而不是等用户点了「查询」才告诉他 ——
 * 选中的同时也能立刻看到该去填哪两个框。日期填齐后提示改成「较慢」的说明，
 * 不再重复要求（条件已满足）。非全国范围不显示。
 */
function renderRegionHint() {
  const el = $('regionHint');
  if (!el) return;
  if (state.region.province) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const ranged = !!(state.start && state.end);
  el.hidden = false;
  el.innerHTML = ranged
    ? '已选「<b>全国</b>」：全国范围汇总较慢（首次约 30~60 秒，实测近两年基线要 45 秒），结果会缓存复用。'
    : '已选「<b>全国</b>」：需要同时填写<b>起始日期</b>与<b>结束日期</b>才能查询 —— 不带时间限制的全国数据量过大（上千万条记录）。';
}

/* ---------------------------------------------------------------- *
 * 记忆上一次的选择：地址栏参数 + localStorage
 * 优先级：URL 参数 > localStorage > 内置默认（北京市 · 当天）
 * ---------------------------------------------------------------- */
function snapshot() {
  return {
    province: state.region.province,
    city: state.region.city,
    district: state.region.district,
    start: state.start,
    end: state.end,
    // 「全部时间」单独记一个标记：起止日期都为空没法从 URL 区分「没填」和「就是要全部时间」
    all: !state.start && !state.end,
    filter: state.filter,
    sort: state.sort,
    q: state.q,
    point: state.point,
    user: state.user,
    taxonName: state.taxonName,
    taxonId: state.taxonId,
    // 空串也是有效值（表示「已解绑」），所以必须原样存，不能用 falsy 判断丢掉
    lifer: state.lifer,
  };
}

function saveUi() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
  } catch (e) {
    /* 隐私模式 / 存储不可用：忽略即可，地址栏参数仍能兜住 */
  }
}

function loadUi() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || {};
  } catch (e) {
    return {};
  }
}

/** 把当前条件同步进地址栏，刷新 / 收藏 / 分享链接都能还原同一视图 */
function syncUrl() {
  const s = snapshot();
  const sp = new URLSearchParams();
  if (s.province) sp.set('province', s.province);
  // 直辖市的「市」与「省」同名，写进去是噪音
  if (s.city && s.city !== s.province) sp.set('city', s.city);
  if (s.district) sp.set('district', s.district);
  // 时间是默认的「当天」时不写进地址栏，保持链接干净；其余情况都写，
  // 「全部时间」用 all=1 表示（两个日期都为空）
  if (s.all) {
    sp.set('all', '1');
  } else {
    const dft = defaultRange();
    if (s.start !== dft.start || s.end !== dft.end) {
      if (s.start) sp.set('start', s.start);
      if (s.end) sp.set('end', s.end);
    }
  }
  if (s.filter !== 'all') sp.set('filter', s.filter);
  if (s.sort !== 'record') sp.set('sort', s.sort);
  if (s.q) sp.set('q', s.q);
  // 记录检索条件也进地址栏，分享 / 刷新后能还原同一份视图
  if (s.point) sp.set('point', s.point);
  if (s.user) sp.set('user', s.user);
  if (s.taxonName) sp.set('taxon', s.taxonName);
  if (s.taxonId) sp.set('taxonId', s.taxonId);
  // 绑定用户也进地址栏，分享出去的链接对方打开就是同一份比对
  if (s.lifer) sp.set('lifer', s.lifer);
  const qs = sp.toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}

function persist() {
  saveUi();
  syncUrl();
}

/** 汇总 URL → localStorage → 默认，得出本次打开页面应使用的初始条件 */
function resolveInitial() {
  const sp = new URLSearchParams(location.search);
  const saved = loadUi();
  const pick = (key) => {
    const v = sp.get(key);
    if (v !== null && v !== '') return v;
    const sv = saved[key];
    return sv === undefined || sv === null ? '' : String(sv);
  };

  // 时间：all=1 表示「全部时间」（两个日期都留空），否则用地址栏 / 本地存储里的起止日期，
  // 都没有就回到默认「当天」
  const dft = defaultRange();
  const allTime = sp.get('all') === '1' || (sp.get('all') === null && saved.all === true);
  const start = allTime ? '' : pick('start') || dft.start;
  const end = allTime ? '' : pick('end') || dft.end;

  // 绑定用户：URL > 本地存储 > 默认（空 = 不绑定）。
  // 这里**不能用 pick()** —— 它把空串当成「没设置」，而「空串」正是「已解绑」的有效值。
  // 少了这一层区分，用户取消绑定后刷新又会被默认值拉回 kkia，等于解绑不了。
  const savedHasLifer = typeof saved.lifer === 'string';
  const urlHasLifer = sp.has('lifer');
  const lifer = urlHasLifer ? sp.get('lifer') : savedHasLifer ? saved.lifer : DEFAULT_LIFER_USER;

  return {
    province: pick('province') || '北京市',
    city: pick('city'),
    district: pick('district'),
    start,
    end,
    filter: pick('filter') || 'all',
    sort: pick('sort') || 'record',
    q: pick('q'),
    point: pick('point'),
    user: pick('user'),
    taxonName: pick('taxon'),
    taxonId: pick('taxonId'),
    lifer,
  };
}

/** 写进 select 前校验，非法值回落到默认项，避免 select.value 变空 */
function setSelect(sel, value, fallback) {
  sel.value = [...sel.options].some((o) => o.value === value) ? value : fallback;
  return sel.value;
}

function restoreTools(init) {
  state.filter = setSelect($('selFilter'), init.filter, 'all');
  state.sort = setSelect($('selSort'), init.sort, 'record');
  state.q = init.q || '';
  $('inpFilter').value = state.q;
  restoreRecordFilters(init);
  restoreLifer(init);
}

/**
 * 还原「我的」绑定。
 * init.lifer 的**空串是有效值**（表示用户主动解绑过），不能当成「没设置」，
 * 否则解绑后刷新又会被默认值拉回 kkia。
 */
function restoreLifer(init) {
  state.lifer = typeof init.lifer === 'string' ? init.lifer : '';
  state.liferInfo = null;
  // 带了 filter=lifer 却没有任何绑定（比如把「仅未加新」的链接分享给没绑定的同事）：
  // 这个筛选无从比对，回落到「全部鸟种」，免得对方看到一片空白
  if (!state.lifer && state.filter === 'lifer') {
    state.filter = 'all';
    $('selFilter').value = 'all';
  }
  syncLiferUi();
}

/** 还原顶部「记录检索」三项：地址栏里的 taxonId 是权威值，直接沿用不再解析 */
function restoreRecordFilters(init) {
  state.point = init.point || '';
  state.user = init.user || '';
  state.taxonName = init.taxonName || '';
  state.taxonId = init.taxonId || '';
  $('inpPoint').value = state.point;
  $('inpUser').value = state.user;
  $('inpTaxonName').value = state.taxonName;
  if (state.taxonId) {
    renderFilterHint(
      `<span class="fh-ok">已按鸟种「${esc(state.taxonName || state.taxonId)}」收窄</span>` +
        `<button class="cand" data-clear-taxon="1">取消鸟种条件</button>`
    );
  } else {
    renderFilterHint('');
  }
}

/* ---------------------------------------------------------------- *
 * 「我的」：绑定记录中心用户名 → 与人生鸟种比对出「未加新」
 *
 * 与顶部「记录检索」里的「用户名称」是两件不同的事：
 *   ▸ 记录检索的用户名（state.user → 上游 username）：把榜单**收窄**到这个人的记录
 *   ▸ 我的（state.lifer → 上游 liferUser）：拿这个人的**全量名单**来比对，谁没加新
 * 所以参数名、存储位置、UI 都分开，互不干扰。
 *
 * 名单由服务端一次请求取全（不带省份、不带时间，带 mode=1 精确匹配），缓存 24 小时。
 * ---------------------------------------------------------------- */

/** 绑定状态写进 state + localStorage + 地址栏 */
function setLifer(name) {
  state.lifer = name || '';
  state.liferInfo = null;
  // 换人 / 解绑后旧拼图必须作废：它是给上一个人铺的，留着会张冠李戴
  state.puzzle = null;
  // 解绑后「只看未加新」就没有意义了：把筛选项一并回落，避免筛出一个空榜单
  if (!state.lifer && state.filter === 'lifer') state.filter = 'all';
  $('selFilter').value = state.filter;
  syncLiferUi();
  persist();
}

/** 同步右上角入口、面板内容、以及筛选下拉里那一项的可用性 */
function syncLiferUi() {
  const bound = !!state.lifer;
  const entry = $('btnMy');
  entry.classList.toggle('is-bound', bound);
  $('myEntrySub').textContent = bound ? `已绑定 ${state.lifer}` : '绑定记录中心用户名';

  // 「仅未加新」在没绑定时禁用（并给出原因），否则选了会得到一份看着像「一种都没有」的空榜
  const opt = [...$('selFilter').options].find((o) => o.value === 'lifer');
  if (opt) {
    opt.disabled = !bound;
    opt.textContent = bound ? `仅未加新（${state.lifer} 未见）` : '仅未加新（需先绑定用户）';
  }

  $('myForm').hidden = bound;
  $('myBound').hidden = !bound;
  syncUserButtons(); // 绑定 / 解绑都会改到「我的报告」「收集拼图」两个入口的可用性
  if (!bound) {
    $('inpLifer').value = DEFAULT_LIFER_USER;
    $('myEntryCount').hidden = true;
    renderMyPanel(null);
    return;
  }
  $('myUserName').textContent = state.lifer;
  renderMyPanel(state.hot && state.hot.stat ? state.hot.stat : null);
}

/** 打开「我的」面板；已绑定时顺手把最新名单拉回来（面板里要显示「总鸟种数」） */
async function openMy() {
  $('myModal').classList.remove('is-closing'); // 若赶上上一次的退场动画，取消它
  $('myModal').hidden = false;
  $('selAnim').value = animType; // 动画设置回填
  syncWatchRow(); // 稀有监听：开关与「稀有数量」回填（打开面板前可能改过条件）
  renderVersionRow(); // 版本号回填（有新版时那颗红点就是这个状态）
  // 顺手查一次更新：走服务端 6 小时缓存，不 force，所以打开面板几乎不花时间；
  // 真过期了才回去问 GitHub（这是「进入我的界面就能看到有没有新版」的入口）
  loadVersion({ silent: true });
  // 顺手读一次最新监听状态（不回源）：面板里那句「本时段 N 种 / 最稀有 M 条」要是新的
  API('watch')
    .then((w) => {
      applyWatchSnapshot(w);
      syncWatchRow();
    })
    .catch(() => { /* 读不到就用已有快照渲染 */ });
  renderTodoEntry(); // TODO 与是否绑定用户无关，打开面板就先刷新入口按钮上的数量
  syncUserButtons(); // 「我的报告」「收集拼图」都要绑定用户才有得查，没绑定就置灰
  // 只把光标放进输入框（已绑定时那个框是隐藏的，别去 focus 它）
  if (!state.lifer) $('inpLifer').focus({ preventScroll: true });
  else await loadMyLifelist();
}

function closeMy() {
  hideAnimated($('myModal')); // 播完退场动画再真正隐藏
}

/**
 * 图片查看器：报告详情里点「图片 N」时弹出，图片是记录中心 OSS 的直链
 * （服务端已把 http 换成 https，APK 的明文策略下也能加载）。
 */
async function openPhotos(activityId, taxonId, name) {
  const pv = $('photoViewer');
  pv.classList.remove('is-closing');
  pv.hidden = false;
  $('pvTitle').textContent = name ? `${name} · 记录图片` : '记录图片';
  $('pvBody').innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在读取图片…</p></div>';
  $('pvBody').scrollTop = 0;
  try {
    const r = await API('report-images', { activityId, taxonId });
    const list = r.list || [];
    if (!list.length) {
      $('pvBody').innerHTML = '<div class="notice">这份报告里没有这一种的图片（可能已被记录人删除）。</div>';
      return;
    }
    $('pvBody').innerHTML = list
      .map((u, i) => `<img class="pv-img" src="${esc(u)}" alt="${esc(name || '')} 图片 ${i + 1}" loading="lazy" />`)
      .join('');
  } catch (e) {
    $('pvBody').innerHTML = errNoticeHtml('读取图片失败：', e.message);
  }
}
function closePhotos() {
  hideAnimated($('photoViewer'), 200);
}

/* ---------------------------------------------------------------- *
 * 图片查看器的缩放：双指捏合 / 拖动 / 双击（桌面：Ctrl+滚轮 / 双击）
 *
 * 每张图的状态直接挂在元素上（el._pz = {s, tx, ty}），互不影响；
 * 变换是 translate(tx,ty) scale(s)，origin 在中心 —— 捏合时让双指中点
 * 保持不动，是这类手势的标准做法。未放大时 touch-action: pan-y 让
 * 单指纵向滚动照常走浏览器；放大后切成 none，拖动交给这里。
 * ---------------------------------------------------------------- */
const PV_MAX_SCALE = 5;
function pvApply(el) {
  const z = el._pz;
  const plain = z.s <= 1.001 && Math.abs(z.tx) < 0.5 && Math.abs(z.ty) < 0.5;
  el.style.transform = plain ? '' : `translate(${z.tx.toFixed(1)}px, ${z.ty.toFixed(1)}px) scale(${z.s.toFixed(3)})`;
  el.style.touchAction = z.s > 1 ? 'none' : 'pan-y';
}
/** 以 (x,y) 为锚点缩放到 s：缩放前后锚点下的图像内容保持不动 */
function pvScaleTo(el, s, x, y) {
  if (!el._pz) el._pz = { s: 1, tx: 0, ty: 0 };
  const z = el._pz;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  s = Math.min(PV_MAX_SCALE, Math.max(1, s));
  const k = s / z.s;
  let tx = x - cx - (x - cx - z.tx) * k;
  let ty = y - cy - (y - cy - z.ty) * k;
  const limX = (el.offsetWidth * (s - 1)) / 2;
  const limY = (el.offsetHeight * (s - 1)) / 2;
  z.s = s;
  z.tx = Math.max(-limX, Math.min(limX, tx));
  z.ty = Math.max(-limY, Math.min(limY, ty));
  pvApply(el);
}
/** 双击：没放大 → 放大到 2.5 倍（以双击点为锚）；已放大 → 复位 */
function pvToggle(el, x, y) {
  if (!el._pz) el._pz = { s: 1, tx: 0, ty: 0 };
  el.classList.add('pv-smooth');
  setTimeout(() => el.classList.remove('pv-smooth'), 240);
  if (el._pz.s > 1.02) {
    el._pz = { s: 1, tx: 0, ty: 0 };
    pvApply(el);
  } else {
    pvScaleTo(el, 2.5, x, y);
  }
}
const pvDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const pvMid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
/** 给图片查看器装手势（在 bind() 里调一次即可；事件委托到 pvBody） */
function bindPhotoZoom() {
  const body = $('pvBody');
  const imgOf = (t) => (t && t.closest ? t.closest('.pv-img') : null);
  let g = null; // 当前手势：pinch / pan

  body.addEventListener('touchstart', (e) => {
    const el = imgOf(e.target);
    if (!el) return;
    if (!el._pz) el._pz = { s: 1, tx: 0, ty: 0 };
    el.classList.remove('pv-smooth');
    if (e.touches.length === 2) {
      g = { mode: 'pinch', el, d0: pvDist(e.touches), m0: pvMid(e.touches), s0: el._pz.s, tx0: el._pz.tx, ty0: el._pz.ty };
      el.style.touchAction = 'none'; // 本次手势别让浏览器做别的
    } else if (e.touches.length === 1) {
      // 单指先记成「可能的点按」；是否算点按要等 touchend 看有没有移动过
      //（不然拖动的起手会被当成一次点按，跟后面的点击凑成假双击）
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      g = { mode: 'tap', el, m0: { x, y }, tx0: el._pz.tx, ty0: el._pz.ty, moved: false, pan: el._pz.s > 1 };
    }
  }, { passive: true });

  body.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && (!g || g.mode !== 'pinch')) {
      const el = imgOf(e.target);
      if (!el) return;
      if (!el._pz) el._pz = { s: 1, tx: 0, ty: 0 };
      g = { mode: 'pinch', el, d0: pvDist(e.touches), m0: pvMid(e.touches), s0: el._pz.s, tx0: el._pz.tx, ty0: el._pz.ty };
    }
    if (!g) return;
    const el = g.el;
    const z = el._pz;
    if (g.mode === 'tap') {
      const m = e.touches[0];
      if (!m) return;
      const dx = m.clientX - g.m0.x;
      const dy = m.clientY - g.m0.y;
      if (!g.moved && Math.hypot(dx, dy) < 8) return; // 还没过判定阈值
      g.moved = true;
      if (!g.pan) return; // 未放大：单指让浏览器滚动，不接管
      g.mode = 'pan';
    }
    e.preventDefault(); // 手势由我们接管，别让页面跟着滚动
    if (g.mode === 'pinch') {
      const d = pvDist(e.touches);
      const m = pvMid(e.touches);
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const s = Math.min(PV_MAX_SCALE, Math.max(1, (g.s0 * d) / (g.d0 || 1)));
      const k = s / g.s0;
      let tx = m.x - cx - (g.m0.x - cx - g.tx0) * k;
      let ty = m.y - cy - (g.m0.y - cy - g.ty0) * k;
      const limX = (el.offsetWidth * (s - 1)) / 2;
      const limY = (el.offsetHeight * (s - 1)) / 2;
      z.s = s;
      z.tx = Math.max(-limX, Math.min(limX, tx));
      z.ty = Math.max(-limY, Math.min(limY, ty));
      pvApply(el);
    } else if (g.mode === 'pan') {
      const m = e.touches[0];
      const limX = (el.offsetWidth * (z.s - 1)) / 2;
      const limY = (el.offsetHeight * (z.s - 1)) / 2;
      z.tx = Math.max(-limX, Math.min(limX, g.tx0 + m.clientX - g.m0.x));
      z.ty = Math.max(-limY, Math.min(limY, g.ty0 + m.clientY - g.m0.y));
      pvApply(el);
    }
  }, { passive: false });

  body.addEventListener('touchend', (e) => {
    if (!g) return;
    if (g.mode === 'pinch') {
      if (e.touches.length < 2) {
        // 捏回原大小时归位，避免留下一丁点歪斜
        const el = g.el;
        if (el._pz.s <= 1.02) {
          el._pz = { s: 1, tx: 0, ty: 0 };
        }
        pvApply(el);
        g = null;
      }
      return;
    }
    if (g.mode === 'tap' && !g.moved && e.touches.length === 0) {
      // 真正的点按：距上一次点按 320ms 内 → 双击（放大 / 复位）
      const el = g.el;
      const now = Date.now();
      if (el._lastTap && now - el._lastTap < 320) {
        el._lastTap = 0;
        // 触摸双击后浏览器还会补发一个 dblclick（鼠标事件合成）：
        // 打个标记让 dblclick 处理器别再切一次，不然等于切了两次 = 没切
        el._pzNoDbl = now;
        pvToggle(el, g.m0.x, g.m0.y);
      } else {
        el._lastTap = now;
      }
      g = null;
      return;
    }
    if (e.touches.length === 0) g = null; // 拖动 / 移动过的手势收尾
  }, { passive: true });

  // 桌面：双击放大 / Ctrl+滚轮缩放（普通滚轮仍是滚动列表）
  body.addEventListener('dblclick', (e) => {
    const el = imgOf(e.target);
    if (!el) return;
    // 触摸双击已处理过的，忽略它合成的这次 dblclick
    if (el._pzNoDbl && Date.now() - el._pzNoDbl < 450) return;
    pvToggle(el, e.clientX, e.clientY);
  });
  body.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    const el = imgOf(e.target);
    if (!el) return;
    e.preventDefault();
    pvScaleTo(el, (el._pz?.s || 1) * (e.deltaY < 0 ? 1.18 : 1 / 1.18), e.clientX, e.clientY);
  }, { passive: false });
}

/** 取回绑定用户的人生鸟种（面板里的「我目前的记录」就是它） */
async function loadMyLifelist(nocache = false) {
  if (!state.lifer) return;
  showMyMsg('');
  try {
    const r = await API('user-lifelist', { user: state.lifer, ...(nocache ? { nocache: '1' } : {}) });
    if (r.error) {
      state.liferInfo = null;
      showMyMsg(r.error);
    } else {
      state.liferInfo = r;
      showMyMsg('');
    }
  } catch (e) {
    state.liferInfo = null;
    showMyMsg('读取名单失败：' + e.message);
  }
  renderMyPanel(state.hot && state.hot.stat ? state.hot.stat : null);
}

let myMsgTimer = null;
function showMyMsg(text) {
  clearTimeout(myMsgTimer);
  for (const id of ['myMsg', 'myMsg2']) {
    const el = $(id);
    el.hidden = !text;
    el.textContent = text || '';
  }
  // 绑定失败类的提示看几秒就淡出；「重新获取」的提示也一样
  if (text) myMsgTimer = setTimeout(() => { $('myMsg').hidden = true; $('myMsg2').hidden = true; }, 6000);
}

const myCell = (k, v, unit, cls) =>
  `<div class="my-cell${cls ? ' ' + cls : ''}"><div class="mk">${esc(k)}</div>` +
  `<div class="mv">${fmt(v)}${unit ? `<small>${esc(unit)}</small>` : ''}</div></div>`;

/**
 * 渲染「我的」面板。
 * @param stat /api/hot 返回的统计（含 lifer* 字段），null 表示榜单还没回来
 */
function renderMyPanel(stat) {
  const ll = state.liferInfo;
  const sub = $('myUserSub');
  const stats = $('myStats');

  if (ll) {
    // 「精确匹配」写在这里而不是只写在说明段里：这是最容易出错、也最容易被静默改回去的一环
    // （模糊匹配会把名字含相同子串的别的用户算进来），摆在数字旁边才好核对。
    // 「郑四分类」四个字要写在数字旁边：用户会拿官网的数字来核对，
    // 官网查询页固定的口径是 郑四(CH4) + 精确匹配，这里必须和他一致才好对账。
    // 这里的三个数（1066 / 15963 / 8）就是官网查询页显示的那三个，照抄不加工，
    // 用户点开官网一比对就能对上；并集（1068 种 / 15978 条）只在列表里体现。
    const cleanN = ll.normalSpeciesCount || ll.speciesCount;
    const cleanRec = ll.normalRecordSum != null ? ll.normalRecordSum : ll.recordSum;
    sub.textContent = `共 ${fmt(cleanN)} 种鸟 · ${fmt(cleanRec)} 条记录 · 郑四分类 · 精确匹配`;
    // 名录外的种只在真有的时候才提一句：总种数只算能对上郑四名录的种，
    // 把对不上的偷偷加进去数字就会虚高（旧版「福州老兵 2000 种」就是这么来的）。
    // 用 CH4 取数后这里通常是 0，一律不显示任何说明条。
    const offCount = ll.offCatalogCount || 0;
    const offNote = offCount
      ? `<div class="notice">另有 <b>${fmt(offCount)}</b> 种不在郑四名录内（${fmt(ll.offCatalogRecordSum || 0)} 条记录），未计入总种数</div>`
      : '';
    // 「总鸟种数」并排两个数：绿色 = 有正常记录的种数，红色 = 疑问种数（都取服务端给的原值，
    // 就是官网那两个数）。疑问走红色，与榜单卡片上「疑问（红）> 未加新（青）」的配色一致。
    const doubtN = Number(ll.doubtSpeciesCount) || 0;
    stats.innerHTML =
      `<div class="my-cell is-clickable" id="myTaxonCell" role="button" tabindex="0" title="点击查看全部鸟种列表">
        <div class="mk">总鸟种数<span class="more">查看列表 ›</span></div>
        <div class="mv"><span class="mv-clean">${fmt(cleanN)}</span><small>种</small>` +
      (doubtN ? `<span class="mv-doubt">${fmt(doubtN)} 疑问</span>` : '') +
      `</div>
      </div>` +
      myCell('累计记录条数', cleanRec, '条') +
      offNote;
  } else {
    sub.textContent = state.lifer ? '正在读取名单…' : '';
    stats.innerHTML = '';
  }

  // 右上角入口上的小角标：当前榜单还剩多少种没加新
  const badge = $('myEntryCount');
  const badgeCount = stat && stat.liferUser && !stat.liferError ? stat.liferNewCount || 0 : 0;
  badge.hidden = !badgeCount;
  badge.textContent = badgeCount;
  badge.title = badgeCount ? `当前榜单里你还有 ${badgeCount} 种没加新` : '';
}

/* ---------------------------------------------------------------- *
 * TODO（待去找）清单：存在本机浏览器里，与是否绑定用户无关
 *
 * 从榜单卡片角上的「＋」加入；加入时顺手查该鸟种最近一份公开报告，
 * 把「发现点 + 时间」存下来当「能找到的地址」（查不到就留空，不影响加入）。
 * ---------------------------------------------------------------- */
const TODO_KEY = 'birdreport.todo.v1';
const todoList = loadTodo();

function loadTodo() {
  try {
    const v = JSON.parse(localStorage.getItem(TODO_KEY));
    return Array.isArray(v) ? v.filter((x) => x && x.taxonId) : [];
  } catch (e) {
    return [];
  }
}
function saveTodo() {
  try {
    localStorage.setItem(TODO_KEY, JSON.stringify(todoList));
  } catch (e) { /* 隐私模式 / 存储不可用：忽略 */ }
}
const isTodo = (taxonId) => todoList.some((x) => Number(x.taxonId) === Number(taxonId));

/** 轻提示：屏幕底部浮一条 1.8 秒的小条（加入 / 移除 TODO 等即时反馈都用它） */
let toastTimer;
function showToast(text) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/** 点卡片角上的「＋ / ★」：加入或移除 TODO */
async function toggleTodo(taxonId, name) {
  const id = Number(taxonId);
  const idx = todoList.findIndex((x) => Number(x.taxonId) === id);
  if (idx >= 0) {
    todoList.splice(idx, 1);
    saveTodo();
    syncTodo();
    showToast(`已从 TODO 移除：${name}`);
    return;
  }
  const fromHot = (state.hot?.list || []).find((x) => Number(x.taxonId) === id) || {};
  const item = {
    taxonId: id,
    name,
    latin: fromHot.latin || '',
    level: fromHot.chinaLevel || '',
    point: '',
    time: '',
    at: Date.now(),
  };
  // 「能找到的地址」= 该鸟种最近一份公开报告的发现点（查询失败就留空，TODO 照样加得上）
  try {
    const r = await API('records', { ...currentWhere(), taxonid: id, page: 1, limit: 10 });
    const rows = [...(r.list || [])].sort((a, b) => String(b.startTime || '').localeCompare(String(a.startTime || '')));
    if (rows[0]) {
      item.point = rows[0].pointName || '';
      item.time = rows[0].startTime || '';
    }
  } catch (e) { /* 静默：没有地址也比没有 TODO 强 */ }
  todoList.unshift(item);
  saveTodo();
  syncTodo();
  showToast(`已加入我的 TODO：${name}${item.point ? ` · 最近发现：${item.point}` : ''}`);
}

/** 把榜单卡片上的「＋ / ★」同步到最新状态，并刷新「我的」里的入口与（可能开着的）列表页 */
function syncTodo() {
  for (const btn of document.querySelectorAll('#hotList .hc-todo')) {
    btn.disabled = false; // 加入时的取地址请求可能把它临时禁用了，这里统一恢复
    const on = isTodo(btn.dataset.todoId);
    btn.classList.toggle('is-on', on);
    btn.textContent = on ? '★' : '＋';
    btn.title = on ? '已在 TODO（待去找），点击移除' : '加入 TODO（待去找）';
  }
  renderTodoEntry();
  if (detail.open && detail.metric === 'todo') renderTodoList();
}

/**
 * 「我的」里的 TODO 入口按钮：显示当前数量，点击打开列表页（见 openDetail('todo')）。
 *
 * ⚠ 只写 #myTodoLabel，**不能**写按钮的 textContent —— 那会把按钮里的图标一起抹掉。
 */
/**
 * 「我的」里 TODO 入口上的计数角标。
 * 数量走右上角的小角标（#myTodoBadge），**不**再拼进按钮文字 ——
 * 一是按钮要改成等宽三宫格，带上「（N）」就放不下；二是往按钮 textContent 里写会连图标一起抹掉。
 */
function renderTodoEntry() {
  const badge = $('myTodoBadge');
  if (!badge) return;
  const n = todoList.length;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

/**
 * 「收集拼图」「我的报告」两个入口的可用性：它们都只跟**绑定用户**有关，
 * 没绑定就没有可查的对象，置灰并说明原因。
 */
function syncUserButtons() {
  const puzzle = $('btnMyPuzzle');
  if (puzzle) {
    puzzle.disabled = !state.lifer;
    puzzle.title = state.lifer
      ? `按郑四名录的「科」铺开，看「${state.lifer}」每个科收到了多少`
      : '先在「我的」里绑定记录中心用户名';
  }
  const reports = $('btnMyReports');
  if (reports) {
    reports.disabled = !state.lifer;
    reports.title = state.lifer
      ? `列出「${state.lifer}」在记录中心公开过的观鸟报告`
      : '先在「我的」里绑定记录中心用户名';
  }
}

/** TODO 列表页（弹层视图）：名称 + 能找到的地址；点条目看报告，点「删除」移除 */
function renderTodoList() {
  if (!todoList.length) {
    $('detailSub').innerHTML = '';
    $('detailBody').innerHTML =
      '<div class="notice">清单是空的：在「本地稀有鸟种排行」的卡片上，点右上角的「＋」把鸟加进来，会自动带上最近的发现点。</div>';
    return;
  }
  $('detailSub').innerHTML = `共 <strong>${fmt(todoList.length)}</strong> 种`;
  $('detailBody').innerHTML =
    '<div class="my-todo">' +
    todoList
      .map(
        (x) => `<div class="todo-item" data-taxon-id="${esc(x.taxonId)}" data-taxon-name="${esc(x.name)}">
      <div class="todo-main">
        <div class="todo-name-row"><span class="todo-name">${esc(x.name)}</span>${x.level ? levelBadge({ chinaLevel: x.level }) : ''}</div>
        <div class="todo-where">${x.point ? esc(`最近发现：${x.point}${x.time ? ' · ' + x.time.slice(5, 16) : ''}`) : '未取到近期发现点'}</div>
      </div>
      <button class="todo-del" type="button" data-del-id="${esc(x.taxonId)}" title="从 TODO 移除">删除</button>
    </div>`
      )
      .join('') +
    '</div>';
}

/* ---------------------------------------------------------------- *
 * 「收集拼图」：把郑四名录按**科**铺开，标出哪些种已经加新
 *
 * 与「未加新」是同一份名单的两种看法：
 *   ▸ 未加新：拿**榜单**比名单 → 这个地区还剩哪些没加新（跟地区 / 日期走）
 *   ▸ 拼图：  拿**名录**比名单 → 全国的科里收到了多少（只跟绑定用户走）
 * 所以拼图不读 state.hot，换地区 / 换日期都不该让它变 —— 前端也就不传这些条件。
 *
 * 分组、去重、命中判定全在服务端（见 server/index.mjs 的 puzzleLoader），
 * 这里只负责画：按科一张卡，科内一格一种，已收集的上色、未收集的灰色。
 * ---------------------------------------------------------------- */

/** 两个勾选项存本机：切换「看不看灰色格子」是高频操作，下次打开该保持原样 */
const PUZZLE_OPTS_KEY = 'birdreport.puzzle.v1';
const puzzleOpts = (() => {
  const def = { showMissing: true, showEmpty: false };
  try {
    const raw = JSON.parse(localStorage.getItem(PUZZLE_OPTS_KEY) || 'null');
    return raw && typeof raw === 'object' ? { ...def, ...raw } : def;
  } catch (e) {
    return def;
  }
})();
function savePuzzleOpts() {
  try {
    localStorage.setItem(PUZZLE_OPTS_KEY, JSON.stringify(puzzleOpts));
  } catch (e) {
    /* 隐私模式：忽略，只影响记忆 */
  }
}

/** 「我的」里点「收集拼图」→ 打开独立页；关掉后回「我的」 */
/**
 * 「我的报告」：打开绑定用户在记录中心**公开过**的报告列表。
 * 只按 username 查（不带 province / 时间），所以列表的是他全部公开报告，而不是当前榜单的。
 * 后端 /api/records 会用 searchUserRecords 发完整条件集（缺键会被上游判为异常请求）。
 */
function openMyReports() {
  if (!state.lifer) return;
  closeMy();
  openDetail('myReports', {
    title: `我的报告 · ${state.lifer}`,
    onlyWhere: { username: state.lifer },
  });
  detail.returnToMy = true; // 关掉列表后回「我的」，而不是落到主页面
}

function openMyPuzzle() {
  if (!state.lifer) return;
  closeMy();
  openDetail('puzzle');
  detail.returnToMy = true;
}

/** 取回拼图数据（跟地区 / 日期无关，所以不带 currentWhere） */
async function loadPuzzle(nocache = false) {
  if (!state.lifer) return;
  state.puzzle = null;
  $('detailBody').innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在按郑四名录逐科铺开…</p></div>';
  try {
    const r = await API('lifer-puzzle', { user: state.lifer, ...(nocache ? { nocache: '1' } : {}) });
    state.puzzle = r;
  } catch (e) {
    state.puzzle = { families: [], error: e.message };
  }
  // 取数期间用户可能已经把弹层关了，这时别再往空壳里画
  if (detail.open && detail.kind === 'puzzle') renderPuzzle();
}

/**
 * 单格：已收集上色 + 记录次数，未收集灰色。tl 是给鼠标悬停看的学名。
 *
 * 用 <button> 而不是 <span>：点鸟名要弹出这个鸟种的档案（见 openTaxonCard），
 * 按钮天生可聚焦、可回车 / 空格触发，触屏上也吃得下（拼图一格只有 12px 字高，
 * 命中区太小的问题交给样式里的 padding 补）。
 * ⚠ 只有**名录里有 id** 的格子才可点 —— 少数行没有 taxonId，点了也查不到档案。
 */
const pzTile = (s) => {
  const clickable = !!s.taxonId;
  const tag = clickable ? 'button' : 'span';
  const attrs = clickable
    ? ` type="button" data-taxon-id="${esc(s.taxonId)}" data-taxon-name="${esc(s.name)}"` +
      `${s.got ? ` data-taxon-count="${esc(s.count)}"` : ''}`
    : '';
  return (
    `<${tag} class="pz-tile${s.got ? ' is-got' : ''}${clickable ? ' is-link' : ''}"` +
    `${attrs} title="${esc(s.latin || '')}${s.got ? '' : ' · 还没有记录'}${clickable ? ' · 点开看这个鸟种' : ''}">` +
    `${esc(s.name)}</${tag}>`
  );
};

function renderPuzzle() {
  const p = state.puzzle;
  if (!p) return;
  const sub = $('detailSub');
  const body = $('detailBody');

  if (p.error) {
    sub.innerHTML = '';
    body.innerHTML = `<div class="notice error">${esc(p.error)}</div>`;
    return;
  }

  const cat = p.catalog || {};
  const total = cat.species || 0;
  const got = p.collectedInCatalog || 0;
  const pctAll = total ? Math.round((got / total) * 1000) / 10 : 0;
  sub.innerHTML =
    `郑四名录 <strong>${fmt(cat.families)}</strong> 科 / <strong>${fmt(total)}</strong> 种 · ` +
    `你已收集 <strong>${fmt(got)}</strong> 种（<strong>${pctAll}%</strong>）· ` +
    `有记录的科 <strong>${fmt(p.collectedFamilies)}</strong>` +
    (p.unmatched ? ` · <span class="warn">另有 ${fmt(p.unmatched)} 种不在郑四名录内，未计入</span>` : '');

  const kw = detail.q.trim().toLowerCase();
  let fams = (p.families || []).filter((f) => puzzleOpts.showEmpty || f.collected > 0);
  if (kw) {
    fams = fams.filter(
      (f) =>
        f.family.toLowerCase().includes(kw) ||
        f.order.toLowerCase().includes(kw) ||
        f.species.some((s) => s.name.toLowerCase().includes(kw) || String(s.latin || '').toLowerCase().includes(kw))
    );
  }

  // 勾选条吸顶：科多的时候要一直能切换，不用滚回顶部
  const tools =
    '<div class="pz-tools">' +
    `<label class="pz-check"><input type="checkbox" id="pzMissing"${puzzleOpts.showMissing ? ' checked' : ''}>显示未收集的（灰色）</label>` +
    `<label class="pz-check"><input type="checkbox" id="pzEmpty"${puzzleOpts.showEmpty ? ' checked' : ''}>显示还没开始的科</label>` +
    `<span class="pz-count">${fmt(fams.length)} 科${kw ? '（已筛选）' : ''}</span>` +
    '</div>';

  if (!fams.length) {
    body.innerHTML =
      tools +
      `<div class="notice">${
        kw ? '没有匹配的科 / 鸟种。' : '还没有任何科的记录 —— 先在记录中心留下观鸟记录，再回来看看。'
      }</div>`;
    return;
  }

  body.innerHTML =
    tools +
    '<div class="pz-list">' +
    fams
      .map((f) => {
        const pct = f.total ? Math.round((f.collected / f.total) * 100) : 0;
        // 「显示未收集的」关掉时只留已收集的格；科内本来就没收集的（showEmpty 打开时会出现）
        // 会退化成空盒子，给一句说明而不是留一片空白
        const shown = puzzleOpts.showMissing ? f.species : f.species.filter((s) => s.got);
        const tiles = shown.length
          ? shown.map(pzTile).join('')
          : '<span class="pz-none">这个科还没有开始</span>';
        return `<div class="pz-fam${f.done ? ' is-done' : ''}">
      <div class="pz-head">
        <span class="pz-fam-name">${esc(f.family)}</span>
        <span class="pz-order">${esc(f.order)}</span>
        ${f.done ? '<span class="pz-done">已集满</span>' : ''}
        <span class="pz-ratio"><b>${fmt(f.collected)}</b> / ${fmt(f.total)} · ${pct}%</span>
      </div>
      <div class="pz-bar"><i style="width:${Math.max(2, pct)}%"></i></div>
      <div class="pz-tiles">${tiles}</div>
    </div>`;
      })
      .join('') +
    '</div>';
}

/* ------------------------------------------------------------------ *
 * 鸟种档案（收集拼图里点鸟名）
 *
 * 拼图铺的是**名录**的一千五百多个格子，鸟种资料却只能一个一个查
 * （上游 front/taxon/content 一次只认一个 taxon_id），所以这里是
 * 「点了才查」：点开某一格 → 服务端回源一次并缓存 30 天 → 在同一个弹层里
 * 把拼图换成这个鸟种的档案，头部出现「‹ 返回」回到拼图（层内换视图，见 paneNav）。
 * ------------------------------------------------------------------ */

/** 档案视图里顺带带过来的上下文：这个种我记过几次（拼图格子上就有，不用再查） */
let taxonCardCtx = { count: 0 };

/**
 * 进档案前拼图的滚动位置：返回时要回到原处。
 * 没有它的话返回会整页滚回最上面 —— 因为 renderPuzzle() 是重画整个 #detailBody 的
 * innerHTML，滚动条跟着新 DOM 归零（用户报告：翻到下面点开一种，返回又回到顶部）。
 */
let puzzleScrollPos = 0;

/**
 * 点鸟名 → 打开档案。
 * @param {number|string} taxonId 名录 id；没有 id 的格子根本渲染不成按钮，这里再兜一次
 * @param {string} name 鸟名（先拿它当标题，资料回来后再校正）
 */
async function openTaxonCard(taxonId, name, count) {
  const id = Number(taxonId);
  if (!Number.isFinite(id) || id <= 0) return;
  detail.pane = 'taxon';
  detail.taxonId = String(id);
  taxonCardCtx = { count: Number(count) || 0 };
  puzzleScrollPos = $('detailBody').scrollTop; // 记下拼图当前位置，返回时还原
  $('btnDetailBack').hidden = false;
  $('detailTools').hidden = true; // 筛选 / 排序是列表的工具，档案里不适用
  $('detailFoot').hidden = true; // 分页同理
  $('detailTitle').textContent = name || '鸟种资料';
  $('detailSub').innerHTML = '';
  const body = $('detailBody');
  // 冻结窗口高度再换内容：拼图内容高、转圈只有一行，不冻结的话窗口会先缩成一条
  // （弹层高度是跟着内容走的），档案回来又突然撑大 —— 用户看到的就是中间「闪一下」。
  // 冻结到档案关闭（closeTaxonCard）才解除：档案比冻结高度矮时底部留白，也比跳变小好。
  body.style.minHeight = body.clientHeight + 'px';
  body.innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在读取鸟种资料…</p></div>';
  body.scrollTop = 0;
  paneNav('pane-push'); // 进档案：从右侧推入
  try {
    const r = await API('taxon/content', { id });
    // 期间可能已经点了「返回」或点了另一种鸟：迟到的响应直接丢弃
    if (detail.pane !== 'taxon' || detail.taxonId !== String(id)) return;
    renderTaxonCard(r, name);
  } catch (e) {
    if (detail.pane !== 'taxon' || detail.taxonId !== String(id)) return;
    $('detailBody').innerHTML = errNoticeHtml('读取鸟种资料失败：', e.message);
  }
}

/** 从档案返回拼图（或返回来时的那个列表）：按原状态重画 */
function closeTaxonCard() {
  if (detail.pane !== 'taxon') return;
  const backToId = detail.taxonId;
  detail.pane = 'list';
  detail.taxonId = '';
  taxonCardCtx = { count: 0 };
  $('btnDetailBack').hidden = detail.kind === 'puzzle' || detail.kind === 'liferList' || detail.kind === 'todo';
  // 拼图不翻页；其余列表（报告明细）要恢复分页条
  $('detailTools').hidden = false;
  $('detailFoot').hidden = detail.kind === 'puzzle';
  $('detailTitle').textContent = detail.listTitle || '明细';
  if (detail.kind === 'puzzle') renderPuzzle();
  else renderDetail();
  // 返回后还原拼图原来的滚动位置 —— 重画 innerHTML 已经把滚动条归零了，
  // 不还原的话，翻到很下面点开一种，返回就得从头再找
  const body = $('detailBody');
  body.style.minHeight = ''; // 解除高度冻结（openTaxonCard 里冻的）：拼图自己会撑回原来的高度
  body.scrollTop = puzzleScrollPos;
  // 键盘用户：焦点落回刚才点的那一格（按钮被重画过，按 id 找回来）；
  // preventScroll 防止聚焦时浏览器再滚动一次、把刚还原的位置顶歪
  if (backToId) {
    const t = body.querySelector(`.pz-tile[data-taxon-id="${backToId}"]`);
    if (t) t.focus({ preventScroll: true });
  }
  paneNav('pane-pop'); // 返回：从左侧推回，跟「进档案」方向相反
}

/** 档案正文：名称三件套 → 分类 → 习性 / 辨识 / 分布 → 名录出处 */
function renderTaxonCard(r, fallbackName) {
  if (!r || r.error) {
    $('detailBody').innerHTML = `<div class="notice error">${esc((r && r.error) || '没有读到这个鸟种的资料。')}</div>`;
    return;
  }
  const name = r.name || fallbackName || '—';
  $('detailTitle').textContent = name;

  // 副标题：学名（斜体）+ 英文名。没有学名时退化成拼音，别留一片空白
  const subBits = [r.latin ? `<i class="tx-latin">${esc(r.latin)}</i>` : '', r.english ? esc(r.english) : ''].filter(
    Boolean
  );
  $('detailSub').innerHTML = subBits.join(' · ') || (r.pinyin ? esc(r.pinyin) : '');

  const kv = (label, val) => (val ? `<div class="tx-kv"><span class="tx-k">${esc(label)}</span><span class="tx-v">${esc(val)}</span></div>` : '');
  // 正文段落：上游的 habit / feature / spread 是长文本，可能整段为空 —— 空的不出块
  const block = (label, val) =>
    val
      ? `<div class="tx-block"><div class="tx-block-h">${esc(label)}</div><p class="tx-p">${esc(val)}</p></div>`
      : '';

  const mine = taxonCardCtx.count > 0 ? `<div class="tx-mine">我记过 <b>${fmt(taxonCardCtx.count)}</b> 次</div>` : '';

  $('detailBody').innerHTML =
    `<div class="tx-card">` +
    `<div class="tx-head">${mine}</div>` +
    '<div class="tx-grid">' +
    kv('目', r.order) +
    kv('科', r.family) +
    kv('拼音', r.pinyin) +
    kv('手册编号', r.guidebookSn) +
    '</div>' +
    block('生境习性', r.habit) +
    block('辨识特征', r.feature) +
    block('分布范围', r.spread) +
    `<div class="tx-foot">资料来自中国观鸟记录中心鸟种名录${r.version ? ` · ${esc(r.version)}` : ''}` +
    ` · 名录 id ${esc(String(r.id || detail.taxonId || ''))}</div>` +
    '</div>';
}

/** 「我的」里点「总鸟种数」→ 打开人生鸟种全列表（数据已在 state.liferInfo 里，零请求） */
function openMyLiferList() {
  const ll = state.liferInfo;
  if (!ll || !ll.list) return;
  closeMy();
  openDetail('liferList');
  // 关掉列表（×、Esc、‹ 返回都算）后回到「我的」面板，而不是落到主页面
  detail.returnToMy = true;
}

/**
 * 人生鸟种全列表：名称 + 学名 + 目科 + 保护等级徽章 + 「我记过 N 次」；
 * 有疑问记录的种红名 + 「疑问 N」徽章（疑问数 = 你在这一种下被上游标疑的记录条数）。
 */
function renderLiferList() {
  const ll = state.liferInfo;
  if (!ll || !ll.list || !ll.list.length) {
    $('detailSub').innerHTML = '';
    $('detailBody').innerHTML = '<div class="notice">名单还没取到，回「我的」点一下「重新获取名单」。</div>';
    return;
  }
  const rows = ll.list;
  const doubts = rows.filter((x) => x.doubt).length;
  // 副标题只保留「共 N 种 · x 种疑问」，其余说明文字不显示。
  // 种数跟面板上的绿色数字同源（有正常记录的种数），疑问数跟红色同源 —— 两处必须对得上。
  const headN = ll.normalSpeciesCount || ll.speciesCount;
  $('detailSub').innerHTML =
    `共 <strong>${fmt(headN)}</strong> 种` +
    (doubts
      ? ` · <span class="doubt-foot"><i class="doubt-dot"></i><strong>${fmt(doubts)}</strong> 种疑问</span>`
      : '');
  // 提示放在**列表最上面**：放在 1000 多行之后等于没放，用户永远看不到。
  $('detailBody').innerHTML =
    liferNoticeBlock(ll) +
    '<div class="rp-list">' +
    rows
      .map((x) => {
        const badges =
          levelBadge(x) + (x.chinaEndemic ? '<span class="badge endemic">中国特有</span>' : '') + iucnBadge(x.iucn);
        const doubtBadge = x.doubt
          ? `<span class="badge doubt" title="你在这一种下有 ${fmt(x.doubtCount)} 条记录被上游标疑">疑问 ${fmt(x.doubtCount)}</span>`
          : '';
        const nameCls = 'rp-name' + (x.doubt ? ' is-doubt' : '');
        const sub = [x.order, x.family].filter(Boolean).join(' · ');
        // 加新时间与地点（今年的才有）：地点只留最后一段（区县），别把「省 市 区」整串铺上来
        const when = x.firstTime
          ? `<span class="rp-when"> ${esc(x.firstTime)}${x.firstPlace ? ' · ' + esc(x.firstPlace.split(' ').slice(-1)[0]) : ''}</span>`
          : '';
        return `<div class="rp-item">
        <div class="rp-main">
          <div class="rp-name-row"><span class="${nameCls}">${esc(x.name)}</span>${doubtBadge}${badges}</div>
          <div class="rp-latin">${esc(x.latin || '')}</div>
          <div class="rp-sub">${sub ? esc(sub) + (when ? ' · ' : '') : ''}${when}</div>
        </div>
        <div class="rp-count"><b>${fmt(x.count)}</b><span>次</span></div>
      </div>`;
      })
      .join('') +
    '</div>';
}

/**
 * 人生鸟种列表顶部的说明条：只在**真有**对不上郑四名录的种时才出现
 * （用 CH4 取数后通常是 0，所以一般什么都不显示）。
 */
function liferNoticeBlock(ll) {
  const off = Array.isArray(ll.offCatalog) ? ll.offCatalog : [];
  if (!off.length) return '';
  const sum = off.reduce((s, x) => s + (Number(x.count) || 0), 0);
  const head = off.slice(0, 20).map((x) => x.name).join('、');
  return (
    `<div class="notice">另有 <b>${fmt(off.length)}</b> 种、共 <b>${fmt(sum)}</b> 条记录不在郑四名录内` +
    `（迷鸟 / 异名 / 名录未收录），<b>未计入上面的种数</b>：${esc(head)}` +
    (off.length > 20 ? ` 等 ${fmt(off.length)} 种` : '') +
    '</div>'
  );
}

/** 绑定：只校验「非空」，剩下的交给服务端去查真伪 */
async function doBindLifer() {
  const name = $('inpLifer').value.trim();
  if (!name) {
    showMyMsg('请先填用户名。');
    $('inpLifer').focus();
    return;
  }
  $('btnLiferBind').disabled = true;
  $('btnLiferBind').textContent = '查询中…';
  try {
    const r = await API('user-lifelist', { user: name });
    if (r.error) {
      showMyMsg(r.error);
      return;
    }
    state.liferInfo = r;
    state.lifer = name;
    state.puzzle = null; // 换了绑定对象，旧的收集拼图作废
    if (state.filter === 'lifer') {
      state.filter = 'all';
      $('selFilter').value = 'all';
    }
    syncLiferUi();
    persist();
    showMyMsg('');
    // 榜单上要长出「未加新」标记，得重新查一次
    runQuery();
  } catch (e) {
    showMyMsg('绑定失败：' + e.message);
  } finally {
    $('btnLiferBind').disabled = false;
    $('btnLiferBind').textContent = '绑定';
  }
}


/* ---------------------------------------------------------------- *
 * 记录检索：观测地点 / 用户名称 / 鸟种名称
 *
 * 三个条件都会直接下推到上游（实测 record/activity/taxon 与统计接口
 * 都认 pointname / username / taxonid），因此概览卡、榜单、报告明细
 * 会一起收窄，口径保持一致。
 * ---------------------------------------------------------------- */

const normLatin = (s) => String(s ?? '').replace(/[^a-z]/gi, '').toLowerCase();

/** 鸟种名称解析的等待上限：超时就放弃这一项，不要把整页查询拖住 */
const TAXON_RESOLVE_TIMEOUT_MS = 8000;

/**
 * 给单个请求加时间上限。竞速失败的一方由 Promise.race 接管，不会产生未处理拒绝。
 */
function withTimeout(p, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

function renderFilterHint(html) {
  const el = $('filterHint');
  if (!el) return;
  el.hidden = !html;
  el.innerHTML = html || '';
}

/** 候选渲染成一排可点按钮：同名多版本或分类学拆分时由用户挑 */
function candidateChips(cands) {
  return cands
    .map((c) => {
      const active = String(state.taxonId) === String(c.id) ? ' active' : '';
      const latin = c.latin && normLatin(c.latin) !== normLatin(c.name) ? `<span class="c-latin">${esc(c.latin)}</span>` : '';
      return `<button class="cand${active}" data-taxon-id="${esc(c.id)}" data-taxon-name="${esc(c.name)}" title="按「${esc(c.name)}」收窄">${esc(c.name)}${latin}</button>`;
    })
    .join('');
}

/**
 * 读顶部三项输入；鸟种名称需要时先解析成 taxon_id。
 * 解析走「郑四名录」，所以中文名 / 学名 / 英文名 / 拼音 / 首字母都能认。
 * 自动采用的条件：只匹配到一个候选，或多个候选其实是同一种鸟。
 * 匹配到多个**不同**鸟种时不猜，交给用户点选。
 * @returns {Promise<boolean>} 是否继续查询
 */
async function prepareRecordFilters() {
  const point = $('inpPoint').value.trim();
  const user = $('inpUser').value.trim();
  const name = $('inpTaxonName').value.trim();

  /** 只在「这次查询确实要执行」时才把输入提交进 state，避免界面与数据不一致 */
  const commit = (taxonName, taxonId) => {
    state.point = point;
    state.user = user;
    state.taxonName = taxonName;
    state.taxonId = taxonId;
  };

  if (!name) {
    commit('', '');
    renderFilterHint('');
    return true;
  }
  // 名字没变且已经解析过 → 直接用
  if (name === state.taxonName && state.taxonId) {
    commit(name, state.taxonId);
    return true;
  }

  // 解析在「郑四名录」里做（服务端把整份名录缓存 7 天），与地区 / 时间无关，
  // 所以这里只需送名字；返回的 id 与榜单数据源同族，必然对得上。
  let r;
  try {
    r = await withTimeout(
      API('taxon-resolve', { name }),
      TAXON_RESOLVE_TIMEOUT_MS,
      `解析超过 ${TAXON_RESOLVE_TIMEOUT_MS / 1000} 秒`
    );
  } catch (e) {
    // 解析失败/超时不该挡住查询：照常查，只是这次不带鸟种条件
    commit(name, '');
    renderFilterHint(
      `<span class="fh-err">鸟种名称「${esc(name)}」未能解析（${esc(e.message)}）</span>` +
        `，本次未按鸟种收窄，可再点一次「查询」重试。`
    );
    return true;
  }

  const cands = r.candidates || [];
  if (!r.matched) {
    commit(name, '');
    renderFilterHint(
      `<span class="fh-warn">郑四名录里没有找到鸟种「${esc(name)}」</span>，本次未按鸟种收窄。` +
        `可以填中文名（如「灰喜鹊」）、学名，或拼音 / 首字母（huixique / hxq）。`
    );
    return true;
  }

  const sameSpecies = new Set(cands.map((c) => normLatin(c.latin) || c.name)).size === 1;
  if (cands.length === 1 || sameSpecies) {
    commit(r.matched.name, String(r.matched.id));
    $('inpTaxonName').value = r.matched.name;
    const sameIdNote =
      cands.length > 1
        ? `<span class="fh-dim">（郑四名录里匹配到 ${cands.length} 条，已取第一条 id=${r.matched.id}）</span>`
        : '';
    renderFilterHint(
      `<span class="fh-ok">已按鸟种「${esc(r.matched.name)}」收窄</span>` +
        `<span class="fh-dim">${esc(r.matched.latin || '')}${r.matched.order ? ' · ' + esc(r.matched.order) : ''}</span>${sameIdNote}` +
        `<button class="cand" data-clear-taxon="1">取消鸟种条件</button>`
    );
    return true;
  }

  // 一个关键字匹配到多个**不同**鸟种（如「喜鹊」= Pica serica / Pica pica）：
  // 这里不猜、也不改任何 state，页面维持上一次结果，等用户点选
  renderFilterHint(
    `<span class="fh-warn">「${esc(name)}」匹配到 ${cands.length} 个鸟种，请选择：</span>${candidateChips(cands)}` +
      `<button class="cand" data-clear-taxon="1">不按鸟种收窄</button>`
  );
  return false;
}

/** 采用某个鸟种作为查询条件（input 同步成标准中文名） */
function applyTaxonPick(id, name) {
  state.taxonId = String(id || '');
  state.taxonName = name || state.taxonName;
  $('inpTaxonName').value = state.taxonName;
}

/** 只取消鸟种这一项条件（保留观测地点与用户名称） */
function clearTaxonFilter() {
  state.taxonName = '';
  state.taxonId = '';
  $('inpTaxonName').value = '';
  renderFilterHint('');
}

/** 清空三项记录检索条件（不动省市与时间） */
function clearRecordFilters() {
  state.point = '';
  state.user = '';
  $('inpPoint').value = '';
  $('inpUser').value = '';
  clearTaxonFilter();
}

/** 把顶部三项输入同步进 state（用于用户点候选时，先把刚填的地点/用户带上） */
function commitRecordInputs() {
  state.point = $('inpPoint').value.trim();
  state.user = $('inpUser').value.trim();
}

/* ---------------------------------------------------------------- *
 * 渲染：概览
 * ---------------------------------------------------------------- */
function renderOverview(o, hot) {
  state.overview = o;
  // 「记录鸟种数 / 鸟种记录条数」改用鸟种明细（record/activity/taxon）的口径，
  // 因为上游 record/taxon/num 与它更新不同步，会有 ±1 种、数十条记录的偏差；
  // 用同源数据才能保证点开明细后条数与卡片数字完全一致。
  const taxonNum = hot?.stat?.speciesCount ?? o.taxonNum;
  const recordCount = hot?.stat?.recordSum ?? o.recordCount;
  const cards = [
    { k: '记录鸟种数', v: taxonNum, u: '种', cls: 'accent-blue', metric: 'taxon' },
    { k: '目 / 科', v: `${o.orderNum}`, u: `/ ${o.familyNum}`, cls: '', metric: 'orders' },
    { k: '观鸟报告数', v: o.reportNum, u: '份', cls: '', metric: 'report' },
    { k: '鸟种记录条数', v: recordCount, u: '条', cls: 'accent-green', metric: 'record' },
    { k: '公开报告', v: o.openReportNum, u: '份', cls: 'accent-orange', metric: 'open' },
  ];
  $('overview').innerHTML = cards
    .map((c) => {
      if (!c.metric) {
        return `<div class="stat-card ${c.cls}"><div class="k">${esc(c.k)}</div><div class="v">${fmt(c.v)}<span class="u">${esc(c.u || '')}</span></div></div>`;
      }
      return `<div class="stat-card ${c.cls} is-clickable" data-metric="${c.metric}" role="button" tabindex="0" aria-label="${esc(c.k)}，点击查看明细">
        <div class="k">${esc(c.k)}<span class="more">查看明细 ›</span></div>
        <div class="v">${fmt(c.v)}<span class="u">${esc(c.u || '')}</span></div>
      </div>`;
    })
    .join('');
}

function renderProtection(stat) {
  const panel = $('protectionPanel');
  if (!stat) { panel.hidden = true; return; }
  panel.hidden = false;
  const cells = [
    { k: '国家一级保护', v: stat.national1, color: '#d92b2b' },
    { k: '国家二级保护', v: stat.national2, color: '#e07b12' },
    { k: '三有名录', v: stat.sanYou, color: '#2f7fd6' },
    { k: '中国特有', v: stat.chinaEndemic, color: '#7a5cd6' },
    { k: 'IUCN 受威胁(CR/EN/VU)', v: stat.threatened, color: '#c81e1e' },
  ];
  $('protGrid').innerHTML = cells
    .map((c) => `<div class="prot-cell"><span class="pk"><i class="swatch" style="background:${c.color}"></i>${esc(c.k)}</span><span class="pv">${fmt(c.v)}</span></div>`)
    .join('');
  const covered = Math.min(stat.totalSpecies, 200);
  $('protectionHint').textContent = `统计范围：按记录数排名前 ${fmt(covered)} 的鸟种` +
    (stat.pending ? `，另有 ${fmt(stat.pending)} 种正在后台补全等级信息` : '');
}

/* ---------------------------------------------------------------- *
 * 渲染：稀有榜（记录越少越稀有，排越前面）
 * ---------------------------------------------------------------- */
function levelBadge(x) {
  if (x.chinaLevel === '国家一级') return '<span class="badge lv1">国家一级</span>';
  if (x.chinaLevel === '国家二级') return '<span class="badge lv2">国家二级</span>';
  if (x.chinaLevel === '三有') return '<span class="badge lv3">三有</span>';
  return '';
}
function iucnBadge(code) {
  // 无危 / 未评估不展示，避免榜单被无信息量的徽章淹没
  if (!code || ['LC', 'NE', 'NR'].includes(code)) return '';
  const map = { CR: ['iucn-cr', '极危'], EN: ['iucn-en', '濒危'], VU: ['iucn-vu', '易危'], NT: ['iucn-nt', '近危'], DD: ['iucn-other', '数据缺乏'], EX: ['iucn-cr', '绝灭'], EW: ['iucn-cr', '野外绝灭'] };
  const m = map[code];
  if (!m) return '';
  return `<span class="badge ${m[0]}">IUCN ${m[1]}</span>`;
}

function renderHot(data) {
  const list = data.list || [];
  const s = data.stat || {};
  if (!list.length) {
    const fs = filterSummary();
    // 「仅未加新」筛空是最常见的一种空榜：不是没数据，而是这个地区/时段你已经全加新了。
    // 明确说出来，免得让人以为查询坏了。
    const liferEmpty = state.filter === 'lifer';
    $('hotList').innerHTML = liferEmpty
      ? `<div class="notice">当前条件下没有「未加新」的鸟种` +
        (s.liferError ? `<br />（未加新名单没读到：${esc(s.liferError)}）` : ' —— 这个地区、这段时间的鸟你都已经加新过了。') +
        `</div>`
      : `<div class="notice">该条件下没有匹配的鸟种` +
        (fs.length ? `（${esc(fs.join(' · '))}）` : '') +
        `，试试调整起止日期、更换地区，或清空检索条件。</div>`;
    $('listFoot').innerHTML = '';
    $('hotTitle').textContent = `本地稀有鸟种排行 · ${data.region || '全国'}`;
    renderCacheChip(data.cache);
    syncLiferUi();
    return;
  }
  $('hotList').innerHTML = list
    .map((x) => {
      // 前三名就是本地最稀有的三笔记录（按最近两年记录数）
      const rankCls = x.rank <= 3 ? ` top${x.rank}` : '';
      const badges =
        levelBadge(x) +
        (x.chinaEndemic ? '<span class="badge endemic">中国特有</span>' : '') +
        iucnBadge(x.iucn);
      const rar = Math.round((x.rarity ?? 0) * 100);
      // ⚠ 这两行的分工：**大字行给「本时段」，小字行给「近两年记录」**。
      // 两行互换过位置与样式 —— 近两年记录数虽然是排序依据，但它退成小字（用户要求），
      // 大字留给「本时段」(正常|疑问)，一眼看到的是这段时间实际来了什么。
      const hasHist = x.historyCount !== null && x.historyCount !== undefined;
      // 本时段记录按上游 outside_type 拆两半：**0 = 没问题的数据（绿）· 1 = 有疑问的数据（红）**。
      // 上游是按记录级拆的，逐种核对满足「全部 = 正常 + 疑问」，所以直接用减法得到正常条数，
      // 不再多跑一次上游查询。
      const normalCount = Math.max(0, (Number(x.count) || 0) - (x.doubtCount || 0));
      const doubtCount = Number(x.doubtCount) || 0;
      // 呈两段「数字 + 小字标签」，中间一根发丝线：
      //   本时段 12 正常 │ 1 疑问
      // 绿色/红色只落在数字上，标签降成灰色小字 —— 两个大数字夹一根竖线会读成比分，
      // 加上标签才不会歧义，也不用把「条」这种量词重复两遍。
      // **为 0 的那一段不渲染**（「0 疑问」是纯噪音，绝大多数卡片都没有疑问记录），
      // 于是发丝线也只在两段都在时才出现。
      const nowSegs = s.doubtError
        ? // 标疑数据取不到：只能给总数，不猜哪半是多少（也就不上绿/红）
          [{ cls: 'seg', n: x.count, label: '条', tip: '' }]
        : [
            { cls: 'seg ok', n: normalCount, label: '正常', tip: `本时段 ${fmt(normalCount)} 条正常记录（outside_type=0）` },
            { cls: 'seg bad', n: doubtCount, label: '疑问', tip: `本时段 ${fmt(doubtCount)} 条上游标疑的疑问数据（outside_type=1）` },
          ].filter((seg) => Number(seg.n) > 0);
      const nowLine = nowSegs
        .map((seg) => `<span class="${seg.cls}"${seg.tip ? ` title="${esc(seg.tip)}"` : ''}><b>${fmt(seg.n)}</b><i>${seg.label}</i></span>`)
        .join('<span class="hair" aria-hidden="true"></span>');
      // 小字行：「N 条近两年记录」。历史数取不到时不再编一个「条本时段记录」——那会和上面
      // 大字行的数字重复，直接空着（整个榜单的脚注已经说明已按本时段记录数排序）。
      const histLine = hasHist ? `<b>${fmt(x.historyCount)}</b> 条近两年记录` : '';
      // 上游 AI 半自动标疑的「疑问数据」不再单独挂徽章：大字行里那个红色的「N 疑问」
      // 已经说清楚了，同一件事在一张窄卡片上重复两遍只会更挤（中文名仍然标红）。
      // 「未加新」：绑定用户在人生鸟种里没见过这一种（s.liferUser 为空说明没绑定，整块不渲染）。
      // 用青色（不是红/绿）——红已经被「疑问数据」占用，绿在中文语境里是「跌」，都不是好选择。
      const liferBadge = x.lifer
        ? `<span class="badge lifer" title="${esc(state.lifer)} 的人生鸟种里没有这一种">未加新</span>`
        : '';
      // 「今天新来了」：昨天同一条件下没有它、今天出现的种（拿不到昨日清单时整块不渲染）
      const newBadge = x.isNew
        ? '<span class="badge isnew" title="昨天同一条件下没有它 · 今天新出现">新</span>'
        : '';
      const cls = [
        'hot-card is-clickable',
        x.doubt ? 'is-doubt' : '',
        x.lifer ? 'is-lifer' : '',
      ].filter(Boolean).join(' ');
      const nameCls = ' class="cn' + (x.doubt ? ' is-doubt' : '') + (x.lifer ? ' is-lifer' : '') + '"';
      // 角上的「＋ / ★」：把这一种加进「待去找」TODO（点击时顺手查最近发现点当地址）
      const todoOn = isTodo(x.taxonId);
      const todoBtn = `<button class="hc-todo${todoOn ? ' is-on' : ''}" type="button" data-todo-id="${esc(x.taxonId)}" data-todo-name="${esc(x.name)}"
          title="${todoOn ? '已在 TODO（待去找），点击移除' : '加入 TODO（待去找）'}" aria-label="加入待去找清单">${todoOn ? '★' : '＋'}</button>`;
      // 卡片可点：点了弹出该鸟种的公开报告明细（点击时才查询，不预取）。
      // role/tabindex 与概览卡保持一致，键盘 Enter / 空格同样可用。
      return `<div class="${cls}" data-taxon-id="${esc(x.taxonId)}" data-taxon-name="${esc(x.name)}" data-lifer="${x.lifer ? '1' : '0'}" role="button" tabindex="0" aria-label="查看「${esc(x.name)}」出现在哪些公开报告">
        ${todoBtn}
        <div class="hc-head">
          <span class="rank${rankCls}">${x.rank}</span>
          <span${nameCls}>${esc(x.name)}</span>
        </div>
        <div class="hc-latin">${esc(x.latin || '')}</div>
        <div class="hc-sub">${esc([x.order, x.family].filter(Boolean).join(' · '))}</div>
        <div class="hc-badges">${badges}${newBadge}${liferBadge}</div>
        <div class="hc-foot"><span class="l">本时段</span>${nowLine}</div>
        <div class="hc-hist">${histLine}</div>
        <div class="bar-track hc-bar" title="历史稀有度 ${rar}%（按该地区最近两年记录数，越少越稀有）"><div class="bar-fill" style="width:${Math.max(2, rar)}%"></div></div>
      </div>`;
    })
    .join('');

  const basis = s.historyUsed
    ? `排序依据：${esc(data.region || '')}最近两年（${HISTORY_WINDOW_START} 起）记录数 ${fmt(s.minCount ?? 0)} ~ ${fmt(s.maxCount ?? 0)} 条，越少越稀有`
    : `<span class="warn">最近两年记录数暂时取不到${s.historyError ? '（' + esc(s.historyError) + '）' : ''}，已按本时段记录数排序</span>`;
  // 疑问数据：有人被标疑才提，没人被标疑就不占用脚注
  const doubtInfo = s.doubtError
    ? `<span class="warn">疑问数据标记暂时取不到</span>`
    : Number(s.doubtCount)
      ? `<span class="doubt-foot"><i class="doubt-dot"></i>标红的 <strong>${fmt(s.doubtCount)}</strong> 种含上游 AI 标疑的「疑问数据」，共 ${fmt(s.doubtRecordSum)} 条</span>`
      : '';
  // 未加新：绑了用户才提。取不到名单（用户名写错 / 上游抽风）时给出可操作的提示，
  // 而不是安静地「一种都没标」——那会让人以为「全都加新过了」，结论恰好相反。
  let liferInfo = '';
  if (s.liferUser) {
    if (s.liferError) {
      liferInfo = `<span class="warn">未加新标记暂时取不到（${esc(s.liferError)}），点右上角「我的」核对用户名</span>`;
    } else if (Number(s.liferNewCount)) {
      liferInfo = `<span class="lifer-foot"><i class="lifer-dot"></i>青色 <strong>${fmt(s.liferNewCount)}</strong> 种是你（${esc(s.liferUser)}）还没加新的鸟，已加新 ${fmt(s.liferKnownCount)} 种`;
    } else if (Number(s.liferKnownCount)) {
      liferInfo = `<span class="lifer-foot"><i class="lifer-dot"></i>当前榜单的鸟你（${esc(s.liferUser)}）都已加新</span>`;
    }
  }
  // 「今天新来了」：单日查询才有（对比昨天）；拿不到昨日清单时 newComparable=false，整块不展示
  const newInfo =
    s.newComparable && Number(s.newCount)
      ? `<span class="new-foot"><i class="new-dot"></i>今天新出现 <strong>${fmt(s.newCount)}</strong> 种（对比昨天）</span>`
      : '';
  $('listFoot').innerHTML =
    `<span>本时段共 ${fmt(s.speciesCount ?? s.totalSpecies)} 种鸟 · 已全部展示` +
    (state.filter !== 'all' ? `（筛选：${$('selFilter').selectedOptions[0].textContent}）` : '') +
    `</span>` +
    (newInfo ? `<span>${newInfo}</span>` : '') +
    (liferInfo ? `<span>${liferInfo}</span>` : '') +
    (doubtInfo ? `<span>${doubtInfo}</span>` : '') +
    `<span>${basis}（条形为稀有度）</span>`;
  $('hotTitle').textContent = `本地稀有鸟种排行 · ${data.region || '全国'}`;
  renderCacheChip(data.cache);
  // 角标 / 面板里的「当前榜单鸟种 · 我已加新 · 未加新」都来自这次的 stat，
  // 所以放在渲染末尾统一刷新，不额外请求
  syncLiferUi();
}

/** 展示数据是来自本地缓存还是刚回源，让缓存复用情况可见 */
function renderCacheChip(meta) {
  const el = $('cacheChip');
  if (!meta) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'cache-chip' + (meta.hit ? '' : ' fresh');
  el.textContent = meta.hit
    ? `本地缓存 · ${meta.ageText}（TTL ${meta.ttlText}）`
    : '已从上游更新';
  el.title = meta.hit
    ? `直接复用本地缓存（写入于 ${new Date(meta.storedAt).toLocaleTimeString('zh-CN')}），未请求上游。缓存有效期 ${meta.ttlText}。`
    : '本地缓存未命中，已向上游重新取数并写入本地缓存。';
}

/* ---------------------------------------------------------------- *
 * 渲染：SVG 图表
 * ---------------------------------------------------------------- */
function svgSize(el) {
  const w = Math.max(240, el.clientWidth || 320);
  const h = Math.max(120, el.clientHeight || 170);
  return { w, h };
}

function renderMonthlyChart(el, months, key, fillClass) {
  const { w, h } = svgSize(el);
  const max = Math.max(1, ...months.map((m) => m[key] || 0));
  const pad = { l: 38, r: 8, t: 16, b: 20 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  const bw = (pw / 12) * 0.58;
  const y = (v) => pad.t + ph - (v / max) * ph;

  let bars = '';
  let labels = '';
  months.forEach((m, i) => {
    const cx = pad.l + (pw / 12) * (i + 0.5);
    const v = m[key] || 0;
    const bh = Math.max(v > 0 ? 2 : 0, (v / max) * ph);
    bars += `<rect class="${fillClass}" x="${(cx - bw / 2).toFixed(1)}" y="${(pad.t + ph - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${m.month}月：${fmt(v)}</title></rect>`;
    if (v > 0 && pw > 300) {
      labels += `<text class="bar-label" x="${cx.toFixed(1)}" y="${(pad.t + ph - bh - 4).toFixed(1)}" text-anchor="middle">${v}</text>`;
    }
  });
  let axis = '';
  for (const mm of [1, 3, 5, 7, 9, 11]) {
    const cx = pad.l + (pw / 12) * (mm - 0.5);
    axis += `<text class="axis-text" x="${cx.toFixed(1)}" y="${h - 6}" text-anchor="middle">${mm}月</text>`;
  }
  for (let i = 0; i <= 3; i += 1) {
    const v = (max / 3) * i;
    const yy = y(v);
    axis += `<line class="grid-line" x1="${pad.l}" x2="${w - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"></line>`;
    axis += `<text class="axis-text" x="${pad.l - 6}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${axis}${bars}${labels}</svg>`;
}

function renderRankChart(el, list) {
  const rows = list.slice(0, 14);
  if (!rows.length) { el.innerHTML = '<div class="empty-chart">暂无数据</div>'; return; }
  const { w } = svgSize(el);
  const rowH = 22;
  const h = Math.max(el.clientHeight || 300, rows.length * rowH + 12);
  const labelW = 78;
  const valueW = 46;
  const pw = Math.max(60, w - labelW - valueW);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const topVal = rows[0].value;

  const body = rows
    .map((r, i) => {
      const y = i * rowH + 8;
      const bw = Math.max(2, (r.value / max) * pw);
      const cls = r.value === topVal ? 'bar-rank top' : 'bar-rank';
      return `<g><text class="axis-text" x="0" y="${y + 12}" style="font-size:11.5px;fill:#4b5563">${esc(r.name)}</text>
        <rect class="${cls}" x="${labelW}" y="${y + 2}" width="${bw.toFixed(1)}" height="12" rx="3"><title>${esc(r.name)}：${fmt(r.value)} 种</title></rect>
        <text class="axis-text" x="${labelW + bw + 6}" y="${y + 12}">${fmt(r.value)}</text></g>`;
    })
    .join('');
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${body}</svg>`;
}

/* ---------------------------------------------------------------- *
 * 主查询
 * ---------------------------------------------------------------- */
let firstQuery = true;
/** 正在跑的查询数：并发时只有最后一个结束才收起遮罩（避免前一个的收尾把后一个的转圈关掉） */
let runningQueries = 0;
/** 最近一轮查询的中止开关：加载遮罩上的「取消」按钮用它中止所有在途请求 */
let currentQueryAbort = null;

/**
 * 全国范围的门槛说明。
 *
 * 上游不带省份也能查（早先「数据源不提供全国范围」的判断是错的 —— 那几次其实是
 * 撞上了 505 风控），但数据量随窗口急剧膨胀，不加时间限制时实测 1358 万条：
 *   全国 · 单日 622 种 / 0.8 万条 ｜ 一周 1091 种 / 17.5 万条 ｜ 一个月 1256 种 / 62.7 万条
 *   全国 · 不带时间 → 2932 种（已截断）/ 1358 万条
 * 所以要求同时给出起止日期。服务端同样拦截（/api/hot 等返回 needRange）。
 */
const NATIONWIDE_NEED_RANGE =
  '全国范围可以查看，但需要同时选择<b>起始日期</b>与<b>结束日期</b>。不带时间限制的全国查询数据量过大（上千万条记录），上游会长时间无响应。';

async function runQuery() {
  // 每次查询都给「等待」反馈（不只是首次加载）：首次立刻弹遮罩，之后的点击
  // 延迟 200ms 再弹 —— 命中本地缓存时通常毫秒级返回，立刻弹会闪一下反而难看；
  // 真正要等（上游取数 / 历史稀有度重试）的时候，转圈一定看得见。
  runningQueries += 1;
  let loadingTimer = null;
  // 本轮查询的中止开关：加载遮罩上的「取消」按钮会 abort 它 —— 在途请求立刻失败，
  // 走下面的 catch 安静收场（保留页面上已有的结果，不弹错误）
  const abort = new AbortController();
  currentQueryAbort = abort;
  if (firstQuery) showLoading('正在汇总 ' + regionText() + ' 的观鸟数据…');
  else loadingTimer = setTimeout(() => showLoading('正在汇总 ' + regionText() + ' 的观鸟数据…'), 200);
  firstQuery = false;
  setStatus('busy', '查询中…');
  // 收尾：清掉未触发的延迟器；所有并发查询都结束才收起遮罩
  const finishLoading = () => {
    clearTimeout(loadingTimer);
    runningQueries -= 1;
    if (currentQueryAbort === abort) currentQueryAbort = null;
    if (runningQueries <= 0) {
      runningQueries = 0;
      hideLoading();
    }
  };

  // 顶部记录检索：鸟种名称需要先解析成 taxon_id；
  // 匹配到多个不同鸟种时先让用户挑，不带着错的条件去查
  const ready = await prepareRecordFilters();
  if (!ready) {
    finishLoading();
    setStatus('', '请选择要查询的鸟种');
    return;
  }

  const where = currentWhere();
  // 全国范围的门槛：起止日期必须同时给。拦在发请求之前 ——
  // 否则会白跑三次上游（榜单 + 概览 + 趋势），全国口径一次就是几十秒。
  if (!where.province && !(where.startTime && where.endTime)) {
    finishLoading();
    state.overview = null;
    $('overview').innerHTML = '';
    $('protectionPanel').hidden = true;
    $('hotTitle').textContent = '本地稀有鸟种排行 · 全国';
    $('hotList').innerHTML = `<div class="notice">${NATIONWIDE_NEED_RANGE}</div>`;
    $('listFoot').innerHTML = '';
    setStatus('', '请先选择起止日期');
    return;
  }
  // 定向刷新：只让本次要用的几个缓存键失效，其余缓存继续复用
  const nocache = state.nocache ? { nocache: '1' } : {};
  state.nocache = false;
  // 「我的」面板里的「重新获取名单」只失效人生鸟种那一份缓存，
  // 地区榜单（要扫逐月 + 历史记录数，贵得多）照旧复用
  const liferNocache = state.liferNocache ? { liferNocache: '1' } : {};
  state.liferNocache = false;
  try {
    const wantCharts = sideChartsVisible();
    // 榜单是主内容：它失败才整体报错。
    // 概览 / 趋势只是辅助信息，单独吞掉自己的错误——
    // 上游偶发 505 风控时不该把一整页拖成「查询失败」。
    const [overview, hot, trend] = await Promise.all([
      API('overview', { ...where, ...nocache }, abort.signal).catch((e) => {
        if (e.name === 'AbortError') throw e; // 「取消」不是失败，交给外层安静收场
        return { __error: e.message };
      }),
      // 不传 top：让服务端返回该地区全部鸟种（榜单要完整展示）
      API('hot', { ...where, ...nocache, ...liferNocache, filter: state.filter, sort: state.sort, q: state.q, ensure: 200, liferUser: state.lifer }, abort.signal),
      // 侧栏图表关闭时不请求趋势接口，省一次上游调用
      wantCharts
        ? API('trend', { ...where, ...nocache }, abort.signal).catch((e) => {
            if (e.name === 'AbortError') throw e;
            return { __error: e.message, months: [] };
          })
        : Promise.resolve({ months: [] }),
    ]);

    state.hot = hot;
    state.trend = trend;

    if (hot && hot.needRange) {
      // 全国范围可以查，但必须同时给起止日期。正常路径下这个分支不会走到
      // （runQuery 会提前拦下），留在这里是兜底：万一别的入口漏了校验，
      // 也不会把「全 0 的全国榜单」当成真实结果画出来。
      state.overview = null;
      $('overview').innerHTML = '';
      $('protectionPanel').hidden = true;
      $('hotTitle').textContent = '本地稀有鸟种排行 · 全国';
      $('hotList').innerHTML = `<div class="notice">${NATIONWIDE_NEED_RANGE}</div>`;
      $('listFoot').innerHTML = '';
    } else {
      renderHot(hot);
      renderProtection(hot.stat);
      if (overview.__error) {
        state.overview = null;
        $('overview').innerHTML = `<div class="notice error">概览统计暂时取不到（${esc(overview.__error)}），榜单与明细不受影响。</div>`;
      } else {
        renderOverview(overview, hot);
      }
      const fs = filterSummary();
      $('hotTitle').textContent = `本地稀有鸟种排行 · ${regionText()}` + (fs.length ? ' · ' + fs.join(' · ') : '');
    }

    if (wantCharts) {
      renderMonthlyChart($('chartTaxon'), trend.months, 'taxonCount', 'bar-taxon');
      renderMonthlyChart($('chartReport'), trend.months, 'reportCount', 'bar-report');
      // 地区排行榜：优先下一级行政区，其次全国省份
      await loadRegionRank(where, nocache, abort.signal);
    }

    setStatus('ok', `已更新 · ${new Date().toLocaleTimeString('zh-CN')}`);
    // 条件（地区 / 日期 / 检索）变了就顺手同步给监听 —— 「一直监听」靠的就是这一步，
    // 用户不用手动重开。静默进行（条件没变时服务端直接返回、不回源）。
    watchSyncConditions();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // 用户点了「取消」：安静收场 —— 保留页面上的旧结果，不报错
      setStatus('', '查询已取消');
    } else {
      console.error(e);
      setStatus('err', '查询失败');
      $('hotList').innerHTML = errNoticeHtml('查询失败：', e.message);
    }
  } finally {
    finishLoading();
    // 每次查询后记录当前条件，刷新页面时自动还原
    persist();
  }
}

async function loadRegionRank(where, nocache = {}, signal) {
  const el = $('chartRegionRank');
  try {
    let title = '地区鸟种数排行';
    let list = [];
    if (where.province) {
      const level = where.city ? 'district' : 'city';
      const r = await API('region-rank', { ...where, ...nocache, level }, signal);
      list = r.list || [];
      if (list.length) {
        title = r.unit === '区县' ? `${r.unit}鸟种数 · ${where.city || where.province}` : `${where.province} 各地市鸟种数`;
      }
    }
    if (!list.length) {
      const r = await API('province-rank', { ...nocache, version: 'CH4' }, signal);
      list = (r.list || []).slice(0, 14);
      title = '全国各省鸟种数（前 14）';
    }
    $('regionRankTitle').textContent = title;
    state.regionRank = list;
    renderRankChart(el, list);
  } catch (e) {
    el.innerHTML = `<div class="empty-chart">${esc(e.message)}</div>`;
  }
}

/* ---------------------------------------------------------------- *
 * 概览卡下钻：鸟种明细 / 报告明细
 *
 * 鸟种明细：一次取回全部（limit 2000），前端分页 —— 这份数据就在榜单缓存里，成本为零。
 * 报告明细：上游单页上限 50 条，改成**服务端分页**，翻页一页一次请求；
 *           不再把 10 页一次性抓回来聚合成全量列表（那样既慢又容易触发上游风控）。
 * ---------------------------------------------------------------- */
const LEVEL_RANK = { 国家一级: 1, 国家二级: 2, 三有: 3 };
const DETAIL_PAGE_SIZE = 20;          // 鸟种明细：前端分页
const DETAIL_REPORT_PAGE_SIZE = 10;   // 报告明细：每页 10 条（与记录中心站点一致），由服务端分页；上游单页上限是 50
// 「历史稀有度」的窗口起点 —— 与服务端 loadHistory 的 historyWindowStart 同一规则（去年 1 月 1 日 ≈ 最近两年）
const HISTORY_WINDOW_START = `${new Date().getFullYear() - 1}-01-01`;

/**
 * 明细里的稀有度排序键 —— 与榜单一致：优先用「最近两年记录数」，
 * 历史缺失时退回本时段记录数。
 */
const detailRarityKey = (x) => (x.historyCount === null || x.historyCount === undefined ? x.count : x.historyCount);

const METRICS = {
  taxon: { kind: 'taxon', title: '记录鸟种数 · 鸟种明细' },
  record: { kind: 'taxon', title: '鸟种记录条数 · 鸟种明细' },
  report: { kind: 'report', title: '观鸟报告数 · 报告明细' },
  open: { kind: 'report', title: '公开报告 · 报告明细' },
  // 点榜单卡片进来的：按单个鸟种收窄的报告明细。标题由调用方用 opts.title 覆盖成鸟种名。
  taxonReports: { kind: 'report', title: '报告明细' },
  // 「目 / 科」概览卡的下钻：按当前榜单本地聚合，零请求、没有分页
  orders: { kind: 'orders', title: '目 / 科构成（本榜单）' },
  // 「我的」里点「总鸟种数」：人生鸟种全列表（数据就在 state.liferInfo 里，零请求）
  liferList: { kind: 'liferList', title: '我的人生鸟种' },
  // 「我的」里点「我的 TODO」按钮：待去找清单页（存在本机，零请求）
  todo: { kind: 'todo', title: '待去找 · TODO' },
  // 「我的」里点「收集拼图」：郑四名录按科铺开，逐种标出是否已加新（要请求接口）
  puzzle: { kind: 'puzzle', title: '收集拼图' },
  // 「我的」里点「我的报告」：绑定用户在记录中心公开过的报告（按用户名查，与地区/日期无关）
  myReports: { kind: 'report', title: '我的报告' },
};

const detail = {
  open: false,
  kind: '',
  metric: '',
  /** client = 整份数据在前端分页；server = 每页向上游取一次 */
  mode: 'client',
  where: {},
  rows: [],
  view: [],
  page: 1,
  pages: 1,
  q: '',
  sort: 'record',
  meta: null,
  /** 'list' = 明细列表；'report' = 应用内的报告详情（点行进入，可返回）；
      'taxon' = 某个鸟种的档案（拼图里点鸟名进入，可返回）。
      注意别叫 view —— detail.view 是「筛选后的行数组」，两者名字必须分开 */
  pane: 'list',
  reportId: '',
  /** 'taxon' 视图下正在看的鸟种 id：用来丢弃迟到的响应（点了 A 又点 B） */
  taxonId: '',
  /** 列表视图的标题：从报告详情返回时用来还原弹层标题 */
  listTitle: '',
};

async function openDetail(metric, opts = {}) {
  const m = METRICS[metric];
  if (!m) return;
  // 弹层**已经开着**时再切视图（例如 TODO 列表里点条目看「报告明细」）：
  // 元素一直是显示的，modal 的弹出动画不会重播 —— 那条路径原本是硬切，
  // 所以自己补一次层内切换动画（见 paneNav）。
  const swapping = !$('detailModal').hidden;
  Object.assign(detail, {
    open: true,
    kind: m.kind,
    metric,
    mode: m.kind === 'taxon' ? 'client' : 'server',
    // 打开瞬间把查询条件定格，之后改地区 / 时间不影响这个已经打开的弹层。
    // onlyWhere：整份替换掉条件（「我的报告」这类只看用户、与地区/时间无关的入口用），
    // 不然会把当前榜单的 province / 时间一起带上，查出来的就不是「我的全部报告」了。
    where: opts.onlyWhere ? { ...opts.onlyWhere } : { ...currentWhere(), ...(opts.where || {}) },
    rows: [],
    view: [],
    page: 1,
    pages: 1,
    q: '',
    sort: 'record',
    meta: null,
    pane: 'list',
    reportId: '',
    taxonId: '',
    listTitle: opts.title || m.title,
    returnToMy: false,
  });

  $('detailModal').classList.remove('is-closing'); // 若赶上上一次的退场动画，取消它
  $('detailModal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('detailTitle').textContent = opts.title || m.title;
  $('btnDetailBack').hidden = true;
  $('detailTools').hidden = false;
  $('detailFoot').hidden = false;
  $('detailSub').innerHTML = '';
  // 鸟种档案为了防跳变冻结过 detailBody 的高度（见 openTaxonCard）；若上次是从档案
  // 直接 × 掉弹层的，冻结值还在 —— 开任何新视图前都必须解除，否则转圈会占着旧高度。
  $('detailBody').style.minHeight = '';
  $('detailBody').innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在读取明细…</p></div>';
  if (swapping) paneNav('pane-push'); // 弹层没动、只有内容换了：补一次推入
  $('dPageInfo').textContent = '';
  $('dSearch').value = '';
  $('dSearch').placeholder = m.kind === 'taxon' ? '筛选中文名 / 学名 / 英文名' : '在本页内筛选观鸟点 / 记录人 / 区县';
  $('dSort').value = 'record';
  $('dSort').hidden = m.kind !== 'taxon';
  $('dPrev').disabled = true;
  $('dNext').disabled = true;

  // 「目 / 科构成」完全来自当前榜单数据：不走接口、没有分页，也没有筛选工具
  if (m.kind === 'orders') {
    $('detailTools').hidden = true;
    $('detailFoot').hidden = true;
    renderOrders();
    return;
  }

  // 「我的人生鸟种」：数据就在 state.liferInfo 里（打开「我的」时已取回），零请求
  if (m.kind === 'liferList') {
    $('btnDetailBack').hidden = false; // 返回 = 关掉列表并回到「我的」
    $('detailTools').hidden = true;
    $('detailFoot').hidden = true;
    renderLiferList();
    return;
  }

  // 「待去找 · TODO」：清单存在本机（localStorage），零请求
  if (m.kind === 'todo') {
    $('btnDetailBack').hidden = false; // 返回 = 关掉列表并回到「我的」
    $('detailTools').hidden = true;
    $('detailFoot').hidden = true;
    renderTodoList();
    return;
  }

  // 「收集拼图」：数据要现取（与地区 / 日期无关，只看绑定的用户），没有分页
  if (m.kind === 'puzzle') {
    $('btnDetailBack').hidden = false; // 返回 = 关掉并回到「我的」
    $('detailFoot').hidden = true; // 不翻页
    $('dSort').hidden = true; // 排序固定为「收集比例高的在前」
    $('dSearch').placeholder = '筛选科名 / 目名 / 鸟种名';
    loadPuzzle();
    return;
  }

  await reloadDetail();
}

/** 拉取当前页明细（鸟种一次拉全，报告一次只拉一页） */
async function reloadDetail() {
  $('detailBody').innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在读取明细…</p></div>';
  try {
    if (detail.mode === 'client') {
      const r = await API('taxons', { ...detail.where, limit: 2000, liferUser: state.lifer });
      detail.rows = r.list || [];
      detail.meta = {
        total: r.total,
        pending: r.pending,
        historySpeciesCount: r.historySpeciesCount,
        historyMatched: r.historyMatched,
        historyError: r.historyError,
        historyUsed: !!r.historySpeciesCount && !r.historyError,
        doubtCount: r.doubtCount,
        doubtRecordSum: r.doubtRecordSum,
        doubtError: r.doubtError,
      };
      applyDetailFilter(true);
    } else {
      const r = await API('records', { ...detail.where, page: detail.page, limit: DETAIL_REPORT_PAGE_SIZE });
      detail.rows = r.list || [];
      detail.meta = { total: r.total, totalPages: r.totalPages, page: r.page, returned: r.returned };
      applyDetailFilter(false);
    }
  } catch (e) {
    $('detailBody').innerHTML = errNoticeHtml('读取明细失败：', e.message);
    $('dPageInfo').textContent = '';
  }
}

function closeDetail() {
  detail.open = false;
  hideAnimated($('detailModal')); // 播完退场动画再真正隐藏
  document.body.style.overflow = '';
  // 从「我的」点进的「人生鸟种」列表：关掉（×、Esc、‹ 返回都算）就回到「我的」面板
  if (detail.returnToMy) {
    detail.returnToMy = false;
    openMy();
  }
}

/* ---------------------------------------------------------------- *
 * 稀有监听：一直盯着稀有鸟种，有新发现就在右下角提示
 *
 * 三条约定（与服务端 server/watch.mjs 完全一致，判定与去重都在服务端做，
 * 前端只负责「按节拍问一次、有新发现就提示」）：
 *   ① 稀有 = 该地区**最近两年记录数 ≤ 数量**（默认 3 条，在「我的」里可调）
 *   ② **一直监听、条件自动跟随**：监听条件跟着页面上选的地区 / 日期 / 检索走
 *      （每轮查询成功后静默同步一次，见 watchSyncConditions），不需要手动重开；
 *      「我的」里只放「是否监听」与「稀有数量」两项
 *   ③ 频率 = 前台定时轮询（默认 10 分钟一次）；页面在后台不发请求，
 *      那段时间交给 Android 端的后台通知
 *
 * ⚠ 「稀有数量」是个**绝对条数**，在大范围下很难命中。实测近两年记录数的下界：
 *   北京市 95 条、北京朝阳区 64 条、全国 286 条 —— 所以默认的 ≤3 条
 *   在市级以上永远返回「0 种」。界面必须把「本时段最稀有的也有 N 条」摊开，
 *   并让数量可调，否则用户会以为监听坏了。
 *
 * ⚠ 榜单的本时段清单缓存 24 小时，照抄缓存的话一天都是同一份数据（「每 10 分钟
 *   检查」就成了摆设）。所以服务端每轮检查强制回源（nocache=1），但设了一道
 *   **最短回源间隔**（默认 30 分钟）挡住过密的请求 —— 前端轮询比它密没关系，
 *   没到点的轮次服务端直接复用上一轮结果（会回 nextFetchInMs）。
 * ---------------------------------------------------------------- */
const WATCH_THRESHOLDS = [3, 10, 50, 100, 300];
/** 右下角提示卡最多直接列几条，剩下的引导到历史记录 */
const WATCH_CARD_MAX = 5;
/** 轮询间隔的兜底与安全边界（服务端会给 intervalMs，这里只防它异常） */
const WATCH_POLL_FALLBACK_MS = 10 * 60 * 1000;
const WATCH_POLL_MIN_MS = 60 * 1000;
const WATCH_POLL_MAX_MS = 60 * 60 * 1000;

const watchUi = {
  snapshot: null,   // 最近一次服务端快照（enabled / label / history / lastError / …）
  enabled: false,
  threshold: 3,     // 界面上的「稀有数量」（未开启时只存在本地；开启后以服务端为准）
  unread: 0,        // 新发现但还没打开历史记录看的条数（只做角标）
  cardAlerts: [],   // 提示卡上正在列的那几条（点条目要能取回完整信息）
  timer: null,
  busy: false,      // 用户主动发起的操作（开 / 关 / 改数量）进行中
  pendingOn: null,  // 开关的乐观值：请求在途时先按用户点的那个状态显示，回来再以服务端为准
  polling: false,   // 定时轮询进行中
  syncing: false,   // 条件自动同步进行中（避免并发重复提交）
};

const watchThresholdLabel = (v) => {
  const n = Number(v);
  return `≤ ${fmt(n)} 条`;
};
/** 服务端存回来的阈值可能不在界面的档位里（走接口改过），这条给下拉补一个选项 */
function ensureThresholdOption(v) {
  const sel = $('selWatchThreshold');
  const s = String(v);
  if ([...sel.options].some((o) => o.value === s)) return s;
  const o = document.createElement('option');
  o.value = s;
  o.textContent = `≤ ${fmt(v)} 条`;
  sel.appendChild(o);
  return s;
}
const watchLevelBadge = (level) =>
  level === '国家一级'
    ? '<span class="badge lv1">国家一级</span>'
    : level === '国家二级'
      ? '<span class="badge lv2">国家二级</span>'
      : level === '三有'
        ? '<span class="badge lv3">三有</span>'
        : '';

const fmtTime = (ts) => {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 监听条件的人话标签：开启时随请求发给服务端存下来，历史记录里要能看出当时盯的是什么 */
function watchLabelText(where) {
  const short = (s) => String(s).slice(5); // 2026-10-16 → 10-16
  let range;
  if (where.startTime && where.endTime) {
    range = where.startTime === where.endTime ? short(where.startTime) : `${short(where.startTime)}~${short(where.endTime)}`;
  } else if (where.startTime) range = `${short(where.startTime)} 起`;
  else if (where.endTime) range = `至 ${short(where.endTime)}`;
  else range = '全部时间';
  // filterSummary() 给的正是「地点「奥森」」这类记录检索条件
  return [regionText(), range, ...filterSummary()].join(' · ');
}

/* ---------------- 「我的」面板里那一块：开关 + 稀有数量 + 状态说明 ----------------
   只放两项是刻意的：条件不用用户管（跟着页面上的地区 / 日期 / 检索自动走），
   所以这里不出现条件选择，只用一行小字把「现在盯着什么」说清楚。 */

/** 把服务端快照落到界面状态上（各处拿到快照后都走它，省得漏同步某一个字段） */
function applyWatchSnapshot(w) {
  watchUi.snapshot = w;
  watchUi.enabled = !!(w && w.enabled);
  if (w && w.maxHistoryCount) watchUi.threshold = Number(w.maxHistoryCount);
  return w;
}

function syncWatchRow() {
  const chk = $('chkWatch');
  const sel = $('selWatchThreshold');
  const hint = $('watchRowHint');
  if (!chk || !sel || !hint) return;
  const w = watchUi.snapshot;
  const on = !!(w && w.enabled);

  // 请求在途时按用户刚点的那个状态显示，别让开关先跳回去再弹过来
  chk.checked = watchUi.pendingOn === null ? on : watchUi.pendingOn;
  chk.disabled = watchUi.busy;
  const stateText = $('mwSwitchText');
  if (stateText) {
    stateText.textContent = watchUi.busy ? '处理中…' : chk.checked ? '监听中' : '已停止';
  }
  // 请求在途时**别动下拉**：这时快照还是旧的，会看到刚选的档位被弹回去
  if (!watchUi.busy) sel.value = ensureThresholdOption(on ? w.maxHistoryCount : watchUi.threshold);

  if (!chk.checked) {
    // 从没开过（服务端还没有条件）时讲「开启后会怎样」，比讲「关掉后会怎样」有用；
    // 开过又关掉的，说清历史记录还在。
    hint.innerHTML = w && w.conditions
      ? '<span class="mw-status">已停止。关掉后不再提醒，<b>历史记录会保留</b>；重新打开会按当前条件重新划一条起跑线。</span>'
      : '<span class="mw-status">开启后按页面当前的地区 / 日期盯稀有鸟种，发现新鸟种会在右下角提醒你。</span>';
    return;
  }

  // 逐条成行，别再挤成一整段：① 盯着什么 ② 上一轮什么结果 ③ 该不该调数量 / 通知权限
  const lines = [];
  lines.push(
    `<span class="mw-cond">监听条件 <b>${esc((w && w.label) || '当前条件')}</b>　随页面条件自动跟着变</span>`
  );

  if (w.baselinePending) {
    lines.push('<span class="mw-status">正在按当前条件建立基线…</span>');
  } else if (w.lastError) {
    lines.push(`<span class="mw-status"><span class="warn">${esc(w.lastError)}</span></span>`);
  } else if (w.scanned) {
    const min = w.minHistoryCount === null || w.minHistoryCount === undefined ? '—' : fmt(w.minHistoryCount);
    const hit = w.rareCount ? ` · 命中 ${fmt(w.rareCount)} 种` : '';
    lines.push(`<span class="mw-status">本时段 ${fmt(w.scanned)} 种 · 最稀有 ${min} 条${hit}</span>`);
  } else {
    lines.push('<span class="mw-status">还没检查过，稍等一会</span>');
  }

  // 数量是绝对条数，大范围下命中不了是常态 —— 直接告诉用户该调到多少
  const th = Number((w && w.maxHistoryCount) || 0);
  if (w && w.scanned && w.minHistoryCount !== null && w.minHistoryCount !== undefined && w.minHistoryCount > th) {
    lines.push(
      `<span class="mw-status"><span class="warn">数量 ${watchThresholdLabel(th)} 一种也命中不了，` +
        `请调到 ${fmt(w.minHistoryCount)} 条以上</span></span>`
    );
  }

  // Android 壳里才谈「通知权限」：网页端开着页面就有右下角提示，没有系统通知这回事
  if (ANDROID) {
    let perm = 'granted';
    try {
      perm = ANDROID.notifyState ? ANDROID.notifyState() : 'granted';
    } catch (e) { /* 桥出错按已授权处理，不吓用户 */ }
    lines.push(
      perm !== 'granted'
        ? '<span class="mw-status"><span class="warn">系统通知权限未开 —— 退到后台时不会提醒，请到系统设置里允许通知</span></span>'
        : '<span class="mw-status">应用退到后台也会发系统通知</span>'
    );
  }

  hint.innerHTML = lines.join('');
}

/* ---------------- 右下角浮标与提示卡 ---------------- */

function hideWatchCard() {
  const el = $('watchCard');
  if (el) el.hidden = true;
  watchUi.cardAlerts = [];
}

function renderWatchDock() {
  const dock = $('watchDock');
  if (!dock) return;
  const w = watchUi.snapshot;
  // conditions 为空 = 刚启动、页面还没来得及把条件同步过去，这时先不用露面
  if (!w || !w.enabled || !w.conditions) {
    dock.hidden = true;
    hideWatchCard();
    watchUi.unread = 0;
    return;
  }
  dock.hidden = false;
  const pill = $('watchPill');
  $('watchPillText').textContent = `${String(w.label || '当前条件').split(' · ')[0]} · 稀有监听`;
  pill.classList.toggle('has-alert', watchUi.unread > 0);
  pill.classList.toggle('is-err', !!w.lastError && watchUi.unread <= 0);

  const badge = $('watchBadge');
  badge.hidden = watchUi.unread <= 0;
  badge.textContent = watchUi.unread > 99 ? '99+' : String(watchUi.unread);

  const lines = [`监听条件：${w.label || '当前条件'}`, `稀有数量：${watchThresholdLabel(w.maxHistoryCount)}（近两年记录数）`];
  lines.push(`最近检查：${w.lastCheckAt ? fmtTime(w.lastCheckAt) : '—'}`);
  if (w.scanned) lines.push(`本时段扫描 ${fmt(w.scanned)} 种，最稀有 ${w.minHistoryCount === null ? '—' : fmt(w.minHistoryCount)} 条`);
  if (w.lastError) lines.push(`异常：${w.lastError}`);
  if (watchUi.unread) lines.push(`有 ${watchUi.unread} 条新发现未读`);
  lines.push('点击查看历史记录');
  pill.title = lines.join('\n');
}

function showWatchCard(alerts) {
  const card = $('watchCard');
  const body = $('watchCardBody');
  if (!card || !body) return;
  watchUi.cardAlerts = alerts;
  const n = alerts.length;
  $('watchCardTitle').textContent = `发现 ${fmt(n)} 种稀有鸟种`;
  body.innerHTML =
    alerts
      .slice(0, WATCH_CARD_MAX)
      .map(
        (a, i) => `<button class="wc-item" type="button" data-idx="${i}" data-taxon-id="${esc(a.taxonId)}">
      <span class="wc-item-main">
        <span class="wc-name-row"><span class="wc-name">${esc(a.name)}</span>${watchLevelBadge(a.chinaLevel)}</span>
        <span class="wc-sub">本时段 ${fmt(a.count)} 条 · 近两年 ${fmt(a.historyCount)} 条</span>
      </span>
      <span class="wc-go">查看报告 ›</span>
    </button>`
      )
      .join('') +
    (n > WATCH_CARD_MAX ? `<div class="wc-more">还有 ${fmt(n - WATCH_CARD_MAX)} 种，点「查看历史记录」看全部</div>` : '');
  card.hidden = false;
}

/* ---------------- 与服务端打交道 ---------------- */

/**
 * 把「监听开着没 + 多久轮询一次」同步给 Android 壳。
 *
 * 壳里有个后台线程会在应用**不在前台**时替页面问同一个接口（前台由页面自己问）——
 * 两边一起问会互相「抢」新发现（接口是消费式的，谁先问到就归谁），所以必须分前后台。
 * 通知权限也在这里顺手申请：Android 13 起 POST_NOTIFICATIONS 是运行时权限，
 * 开启监听是唯一自然的申请时机。
 */
function syncWatchBridge() {
  if (!ANDROID) return;
  const w = watchUi.snapshot;
  try {
    ANDROID.syncWatch(!!(w && w.enabled), Number((w && w.intervalMs) || 0) || WATCH_POLL_FALLBACK_MS);
  } catch (e) { /* 桥出问题不该影响页面本身 */ }
}

/** 申请通知权限（只在 Android 13+ 且还没授权时才会真的弹系统对话框） */
function ensureNotifyPermission() {
  if (!ANDROID) return;
  try {
    if (ANDROID.notifyState && ANDROID.notifyState() === 'granted') return;
    if (ANDROID.requestNotify) ANDROID.requestNotify();
  } catch (e) { /* ignore */ }
}

/**
 * 把「开关 / 稀有数量 / 条件」写回服务端。
 *
 * @param {object}  [o]
 * @param {boolean} [o.enabled] 不给 = **只同步条件、不动开关**（自动跟随走这条）
 * @param {boolean} [o.defer]   不让服务端等基线跑完再回（建基线要真回一次上游、几十秒）
 */
function watchSave({ enabled, defer = false } = {}) {
  const where = currentWhere();
  const threshold = Number($('selWatchThreshold').value) || watchUi.threshold;
  const q = { ...where, label: watchLabelText(where), maxHistoryCount: threshold };
  if (enabled !== undefined) q.enabled = enabled ? '1' : '0';
  if (defer) q.defer = '1';
  return API('watch', q, null, 'POST');
}

/**
 * 开启监听（首次默认开启 / 重新打开 / 改完稀有数量重来一遍）。
 * 会把当前页面的条件一起送过去；服务端据此重建基线（不提醒），历史记录与报过的鸟都保留。
 *
 * @param {object}  [o]
 * @param {boolean} [o.reconfig] 改完「稀有数量」的重开（提示语不一样）
 */
async function watchStart({ reconfig = false } = {}) {
  const where = currentWhere();
  // 「全国」不带时间限制时上游会拉上千万条 —— 服务端也会拦，这里先拦一道，少一次往返
  if (!where.province && !(where.startTime && where.endTime)) {
    renderRegionHint();
    showToast('「全国」范围要同时填起始与结束日期才能监听');
    syncWatchRow(); // 把刚勾上的开关弹回去
    return;
  }
  const label = watchLabelText(where);
  watchUi.busy = true;
  watchUi.pendingOn = true;
  syncWatchRow();
  try {
    const w = applyWatchSnapshot(await watchSave({ enabled: true }));
    watchUi.unread = 0;
    hideWatchCard();
    renderWatchDock();
    scheduleWatchPoll(w.intervalMs);
    syncWatchBridge();
    if (!reconfig) ensureNotifyPermission(); // 开启监听是申请通知权限最自然的时机
    if (w.lastError) {
      // 基线没建起来（上游取不到 / 历史口径缺失）：必须让用户当场知道，
      // 否则他会以为「开着呢，等着就行」，其实是空转。
      showToast(`监听已开，但第一轮就遇到问题：${w.lastError}`);
    } else if (reconfig) {
      showToast(`已按新的稀有数量重启监听：${watchThresholdLabel(w.maxHistoryCount)}`);
    } else {
      showToast(`已开始监听：${label} · 稀有 ${watchThresholdLabel(w.maxHistoryCount)}`);
    }
  } catch (e) {
    showToast('开启监听失败：' + e.message);
  } finally {
    watchUi.busy = false;
    watchUi.pendingOn = null;
    syncWatchRow();
  }
}

async function watchStop({ silent = false } = {}) {
  watchUi.busy = true;
  watchUi.pendingOn = false;
  syncWatchRow();
  try {
    applyWatchSnapshot(await watchSave({ enabled: false }));
    watchUi.unread = 0;
    clearTimeout(watchUi.timer);
    watchUi.timer = null;
    hideWatchCard();
    renderWatchDock();
    syncWatchBridge(); // 让 Android 的后台轮询也停下来
    if (!silent) showToast('已关闭监听（历史记录保留，可随时查看）');
    if (!$('watchModal').hidden) renderWatchBody();
  } catch (e) {
    if (!silent) showToast('关闭监听失败：' + e.message);
  } finally {
    watchUi.busy = false;
    watchUi.pendingOn = null;
    syncWatchRow();
  }
}

/**
 * 页面条件（地区 / 日期 / 检索）变了 → 把新条件同步给监听（**不动开关**）。
 *
 * 这就是「一直监听」的实现方式：用户不用手动重开，条件跟着页面走。
 * 全程静默：服务端发现条件没变就直接返回（不回源），变了才重建基线并保留历史记录，
 * 两种情况都不弹提示 —— 否则用户每换一个区县都会被弹一下。
 */
async function watchSyncConditions() {
  if (!watchUi.enabled || watchUi.syncing || watchUi.busy) return null;
  watchUi.syncing = true;
  try {
    const w = applyWatchSnapshot(await watchSave({ defer: true }));
    renderWatchDock();
    syncWatchRow();
    if (!$('watchModal').hidden) renderWatchBody();
    return w;
  } catch (e) {
    // 同步失败不打扰用户：监听按上一个条件继续跑
    return null;
  } finally {
    watchUi.syncing = false;
  }
}

/**
 * 跑一轮检查。
 * 服务端会用最短回源间隔挡住过密的请求（那时返回 skipped，没有 newAlerts）。
 */
async function watchCheck({ force = false, silent = true } = {}) {
  if (watchUi.busy || watchUi.polling) return null;
  watchUi.polling = true;
  try {
    const w = applyWatchSnapshot(await API('watch/check', force ? { force: '1' } : null));
    if (!w.enabled) {
      // 监听在别处被关掉了（另一台设备 / 服务端被重置）：Android 的后台轮询也要停
      renderWatchDock();
      syncWatchRow();
      syncWatchBridge();
      return w;
    }
    const fresh = Array.isArray(w.newAlerts) ? w.newAlerts : [];
    if (fresh.length) {
      watchUi.unread += fresh.length;
      showWatchCard(fresh);
      const names = fresh.slice(0, 2).map((a) => a.name).join('、');
      showToast(`发现 ${fmt(fresh.length)} 种新出现的稀有鸟种：${names}${fresh.length > 2 ? ' 等' : ''}`);
    }
    renderWatchDock();
    syncWatchRow();
    if (!$('watchModal').hidden) renderWatchBody();
    return w;
  } catch (e) {
    // 轮询失败不打扰用户（浮标上会有异常标记）；用户主动点「立即检查」时才报出来
    if (!silent) showToast('检查失败：' + e.message);
    return null;
  } finally {
    watchUi.polling = false;
  }
}

/**
 * 轮询排期。
 * 页面在后台时**不发请求**，只把定时器重新排上（回到前台会立刻补一轮，见 bind 里的
 * visibilitychange）。原因：后台标签页的定时器会被浏览器节流得乱七八糟，请求也未必
 * 发得出去；真正「应用不在前台也要提醒」这件事交给 Android 端的后台通知去做。
 */
function scheduleWatchPoll(intervalMs) {
  clearTimeout(watchUi.timer);
  const ms = Math.min(
    Math.max(Number(intervalMs) || WATCH_POLL_FALLBACK_MS, WATCH_POLL_MIN_MS),
    WATCH_POLL_MAX_MS
  );
  watchUi.timer = setTimeout(() => {
    if (!watchUi.enabled) return;
    if (document.hidden) {
      scheduleWatchPoll(ms);
      return;
    }
    watchCheck({ silent: true }).then(
      () => scheduleWatchPoll(ms),
      () => scheduleWatchPoll(ms)
    );
  }, ms);
}

/** 页面恢复可见时补一轮（浏览器切回来往往已经过了好几个轮询周期） */
function watchCatchUp() {
  if (!watchUi.enabled || document.hidden) return;
  watchCheck({ silent: true }).then(() => scheduleWatchPoll(watchUi.snapshot?.intervalMs));
}

/** 页面启动时恢复监听状态（不回源，只读状态） */
async function restoreWatch() {
  // 服务端可能还没起来（exe / APK 里 Node 与页面同时启动）：重试几次再认输，
  // 不然「默认自动监听」会因为一次抢跑而白丢。
  let w = null;
  for (let i = 0; i < 3 && !w; i++) {
    try {
      w = await API('watch');
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  if (!w) {
    syncWatchRow(); // 服务端连不上：保持「没监听」的外观，别把页面搞成报错脸
    return;
  }
  applyWatchSnapshot(w);
  syncWatchRow();
  renderWatchDock();

  // 默认是**关**的：页面上什么都不做，用户自己去「我的」里打开开关。
  // 开着的时候才恢复轮询，并把页面上还原出来的条件（可能与上次不同）静默同步过去。
  if (w.enabled) {
    scheduleWatchPoll(w.intervalMs);
    watchSyncConditions();
  }
  syncWatchBridge(); // 应用每次起来都要把「监听开着没」告诉后台轮询线程
}

/* ---------------- 历史记录弹层 ---------------- */

async function openWatchModal() {
  const el = $('watchModal');
  if (!el) return;
  watchUi.unread = 0;
  renderWatchDock();
  el.classList.remove('is-closing');
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  renderWatchBody();
  // 打开时只读一次状态（不回源）：让「最近检查 / 下次回源 / 稀有数量」是新的
  try {
    applyWatchSnapshot(await API('watch'));
    renderWatchDock();
    syncWatchRow();
    renderWatchBody();
  } catch (e) {
    /* 用已有快照渲染就好 */
  }
}

/** immediate=true 时立刻隐藏（马上要开另一个弹层，别让退场动画盖在它上面） */
function closeWatchModal(immediate = false) {
  const el = $('watchModal');
  if (!el || el.hidden) {
    document.body.style.overflow = '';
    return;
  }
  if (immediate) {
    el.classList.remove('is-closing');
    el.hidden = true;
  } else {
    hideAnimated(el);
  }
  document.body.style.overflow = '';
}

function renderWatchBody() {
  const sub = $('watchSub');
  const body = $('watchBody');
  const footInfo = $('watchFootInfo');
  if (!sub || !body) return;
  const w = watchUi.snapshot;
  if (!w) {
    sub.innerHTML = '';
    body.innerHTML = '<div class="notice">还没连上本机服务端，暂时看不到监听状态。</div>';
    if (footInfo) footInfo.textContent = '';
    return;
  }

  const hist = Array.isArray(w.history) ? w.history : [];
  const th = Number(w.maxHistoryCount) || 0;
  const chips = [];
  if (w.label) chips.push(`<strong>${esc(w.label)}</strong>`);
  chips.push(`稀有数量 ${esc(watchThresholdLabel(th))}（近两年记录数）`);
  if (w.lastCheckAt) chips.push(`最近检查 ${esc(fmtTime(w.lastCheckAt))}`);
  if (!w.enabled) chips.push('<span class="warn">监听已停止</span>');
  else {
    // nextFetchInMs 只有「本轮被最短回源间隔挡下」时才有；平时用 minFetchGapMs 反推
    const wait =
      w.nextFetchInMs !== undefined
        ? Number(w.nextFetchInMs)
        : Math.max(0, Number(w.minFetchGapMs || 0) - (Date.now() - (Number(w.lastCheckAt) || 0)));
    if (wait > 60000) chips.push(`约 ${Math.ceil(wait / 60000)} 分钟后再次回源`);
  }
  if (w.lastError) chips.push(`<span class="warn">${esc(w.lastError)}</span>`);
  sub.innerHTML = chips.join(' · ');

  if (footInfo) {
    const min = Math.round(Number(w.minFetchGapMs || 0) / 60000);
    footInfo.textContent = hist.length
      ? `共 ${fmt(hist.length)} 条记录（最多保留 500 条）· 每轮最短间隔 ${min} 分钟`
      : `每轮最短间隔 ${min} 分钟，避免被记录中心限流`;
  }

  // 「本时段最稀有的也有 N 条」必须摊开 —— 数量是绝对条数，大范围下命中不了是常态
  const notes = [];
  if (w.baselinePending) {
    notes.push('正在按当前条件建立基线（这一轮不提醒，免得把已经在的鸟全报一遍）');
  }
  if (w.scanned) {
    notes.push(
      `本时段共 <strong>${fmt(w.scanned)}</strong> 种鸟，其中近两年记录数最少的一档是 ` +
        `<strong>${w.minHistoryCount === null || w.minHistoryCount === undefined ? '—' : fmt(w.minHistoryCount)}</strong> 条`
    );
    if (w.minHistoryCount !== null && w.minHistoryCount !== undefined && w.minHistoryCount > th) {
      notes.push(
        `<span class="warn">数量 ${esc(watchThresholdLabel(th))} 在当前范围里一种也命中不了 —— 想收到提醒，把「我的」里的稀有数量提到 ` +
          `${fmt(w.minHistoryCount)} 条以上</span>`
      );
    } else if (w.rareCount) {
      notes.push(`当前数量下命中 <strong>${fmt(w.rareCount)}</strong> 种`);
    }
  }
  const sum = notes.length ? `<div class="wt-sum">${notes.join('；')}</div>` : '';

  if (!hist.length) {
    body.innerHTML =
      sum +
      `<div class="notice">${
        w.enabled
          ? '还没有发现。监听进行中 —— 按当前页面上的条件（地区 / 日期 / 检索）定期回上游取数，新出现的稀有鸟种会记在这里，并在右下角提示。'
          : '还没有发现。'
      }</div>`;
    return;
  }

  body.innerHTML =
    sum +
    '<div class="wt-list">' +
    hist
      .map((a, i) => {
        const badges =
          watchLevelBadge(a.chinaLevel) +
          (a.chinaEndemic ? '<span class="badge endemic">中国特有</span>' : '') +
          iucnBadge(a.iucn);
        const latin = a.latin ? `<span class="wt-latin">${esc(a.latin)}</span>` : '';
        // 每条都记着「当时盯的是什么条件」：历史记录跨了条件才看得懂
        const cond = a.label ? `<span class="wt-cond">${esc(a.label)}</span>` : '';
        return `<button class="wt-item" type="button" data-wt-index="${i}" data-taxon-id="${esc(a.taxonId)}">
      <span class="wt-no">${i + 1}</span>
      <span class="wt-main">
        <span class="wt-name-row"><span class="wt-name">${esc(a.name)}</span>${latin}${badges}</span>
        <span class="wt-sub">本时段 ${fmt(a.count)} 条 · 近两年 ${fmt(a.historyCount)} 条</span>
        ${cond}
      </span>
      <span class="wt-time">${esc(fmtTime(a.ts))}</span>
    </button>`;
      })
      .join('') +
    '</div>';
}

/** 用「当时监听的那批条件」去看这个鸟种的公开报告（跨了条件的历史记录才不会串味） */
function openWatchTaxonReport(conditions, taxonId, name) {
  openDetail('taxonReports', {
    title: `${name} · 报告明细`,
    onlyWhere: { ...(conditions || {}), taxonid: taxonId },
  });
}

/**
 * Android 壳在**点系统通知进来**时调它（MainActivity.openWatchIfReady）：
 * 直接把监听历史记录打开，省得用户进来还得自己找浮标。
 */
window.__birdOpenWatch = () => {
  openWatchModal();
};

/**
 * Android 壳在后台替页面问出过新发现时，回到前台把条数补给页面。
 *
 * 为什么必须补：那些新鸟种在服务端已经进了「已提醒」表，页面自己的下一次 check
 * **不会**再报一遍（这正是去重的意义）。不补的话，用户从通知点回应用会以为
 * 「什么都变了，只有这个页面没变」。这里顺手读一次状态（不回源），把历史列表
 * 与右下角提示卡按最新的数据铺出来。
 */
window.__birdWatchNotifyPending = (n) => {
  const k = Number(n) || 0;
  if (k <= 0) return;
  API('watch')
    .then((w) => {
      applyWatchSnapshot(w);
      watchUi.unread += k;
      // 历史是时间倒序，最前面的 k 条正是后台刚报过的那几条
      const fresh = (Array.isArray(w.history) ? w.history : []).slice(0, k);
      if (fresh.length) showWatchCard(fresh);
      renderWatchDock();
      syncWatchRow();
      if (!$('watchModal').hidden) renderWatchBody();
    })
    .catch(() => { /* 服务端还没起来就算了，不打扰 */ });
};

/* ---------------------------------------------------------------- *
 * 版本与更新
 *
 * 需求原话：「github 发布新版本后可以检测到版本，在我的中新增版本号，有更新显示红点，
 * 点击是否更新提示，在主界面不用提示更新版本，进入我的界面，显示版本号旁边点击更新」。
 *
 * 所以这一块**只在「我的」面板里出现**：主界面不弹任何更新提示，只在版本号旁亮一个红点。
 *
 * 判定与下载都在服务端（server/update.mjs）：网页端跑在 WebView 里，既写不了磁盘、
 * 也调不起系统安装器。前端只做三件事：读状态、点一下、看进度。
 *
 * Android 上「更新」= 让外壳去调系统安装器（BirdAndroid.installApk）；
 * 桌面（Windows / macOS）上 = 服务端下好 zip 并解压，再打开文件夹让用户替换运行中的程序
 * （运行中的 exe 在 Windows 上锁着自己，不可能自己覆盖自己）。
 * ---------------------------------------------------------------- */
const updateUi = {
  info: null,      // /api/version 的快照（当前版本 / 最新版本 / 下载状态）
  checking: false, // 检查请求在途
  polling: null,   // 下载进度轮询定时器
  revealed: false, // 下载完是否已经帮他打开过文件夹（只自动开一次）
};

const fmtBytes = (n) => {
  const b = Number(n) || 0;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
};

/** 版本号那一行的状态（红点 / 文案 / 小字说明） */
function renderVersionRow() {
  const num = $('verText');
  if (!num) return;
  const w = updateUi.info;
  const dot = $('verDot');
  const state = $('verState');
  const note = $('verNote');

  if (!w) {
    num.textContent = '—';
    state.textContent = updateUi.checking ? '检查中…' : '点这里检查更新';
    state.className = 'ma-state';
    dot.hidden = true;
    note.textContent = '';
    return;
  }

  // 版本号未必是数字：没打过 tag 的本地构建 / 手动试跑的包会是 'dev'，
  // 那种情况别硬拼一个 'v' 上去（会显示成「vdev」）
  const ver = String(w.current || '');
  num.textContent = /^[0-9]/.test(ver) ? 'v' + ver : ver || '—';
  if (w.hasUpdate) {
    dot.hidden = false;
    // 状态文字要短：这一行右边还挤着「›」，写长了会在窄屏被压成省略号
    state.textContent = `发现 v${w.latest}`;
    state.className = 'ma-state is-new';
  } else if (w.error) {
    dot.hidden = true;
    state.textContent = '检查失败';
    state.className = 'ma-state is-warn';
  } else if (w.latest) {
    dot.hidden = true;
    state.textContent = '已是最新';
    state.className = 'ma-state';
  } else {
    dot.hidden = true;
    state.textContent = '检查更新';
    state.className = 'ma-state';
  }

  // 这行小字只在**有事要说**的时候才出现（2026-10-16 用户明确要求别显示
  // 「上次检查 … · 每 6 小时自动查一次」这类例行信息）：
  // 有新版 / 检查失败 / 版本号不是正式版 —— 其余情况整行隐藏，别占地方。
  const bits = [];
  if (w.versionSource === 'fallback') bits.push('源码运行，版本号未知');
  else if (!/^[0-9]/.test(ver)) bits.push('这是没打过 tag 的试跑版本，不参与更新比较');
  if (w.hasUpdate) bits.push('点这一行下载并更新');
  if (w.error) bits.push(w.error);
  else if (w.isAndroid && w.asset && w.hasUpdate) bits.push('会下载 APK 并调起系统安装');
  note.textContent = bits.join(' · ');
  note.hidden = bits.length === 0;
}

/**
 * 读一次版本状态。
 * 默认走服务端缓存（6 小时），force=true 才真去问 GitHub ——
 * 面板一打开就查、但别每次打开都打网络。
 */
async function loadVersion({ force = false, silent = true } = {}) {
  if (updateUi.checking) return null;
  updateUi.checking = true;
  if (!silent) renderVersionRow();
  try {
    const w = await API('version', force ? { force: '1' } : null);
    updateUi.info = w;
    return w;
  } catch (e) {
    if (!silent) showToast('检查更新失败：' + e.message);
    return null;
  } finally {
    updateUi.checking = false;
    renderVersionRow();
  }
}

/** 点版本号：有更新就直接弹「是否更新」，否则现场强制查一次 */
async function onVersionClick() {
  const w = updateUi.info;
  if (w && w.hasUpdate) {
    openUpdateModal();
    return;
  }
  const btn = $('btnVersion');
  if (btn) btn.disabled = true;
  const fresh = await loadVersion({ force: true });
  if (btn) btn.disabled = false;
  if (!fresh) {
    showToast('检查更新失败，稍后再试');
    return;
  }
  if (fresh.hasUpdate) openUpdateModal();
  else if (fresh.latest) showToast(`已是最新版本 v${fresh.current}`);
  else showToast('暂时查不到版本信息' + (fresh.error ? '：' + fresh.error : ''));
}

/* ---------------- 更新弹层 ---------------- */

function openUpdateModal() {
  const el = $('updateModal');
  if (!el || !updateUi.info) return;
  el.classList.remove('is-closing');
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  updateUi.revealed = false;
  renderUpdateBody();
  // 上次的下载可能还在跑（用户关掉弹层又打开）：接着看进度
  if (updateUi.info.download && updateUi.info.download.state === 'downloading') startPollDownload();
  // 顺带把状态刷新一下（不强制回源）：万一下载是上一轮会话留下的
  API('update/progress')
    .then((r) => {
      if (updateUi.info) {
        updateUi.info.download = r.download;
        renderUpdateBody();
      }
    })
    .catch(() => {});
}

function closeUpdateModal(immediate = false) {
  const el = $('updateModal');
  if (!el || el.hidden) {
    document.body.style.overflow = '';
    return;
  }
  if (immediate) {
    el.classList.remove('is-closing');
    el.hidden = true;
  } else {
    hideAnimated(el);
  }
  document.body.style.overflow = '';
}

function renderUpdateBody() {
  const w = updateUi.info;
  const sub = $('upSub');
  const body = $('upBody');
  const go = $('btnUpGo');
  if (!w || !sub || !body) return;
  const d = w.download || {};

  $('upTitle').textContent = w.hasUpdate ? `发现新版本 v${w.latest}` : '版本与更新';
  sub.innerHTML =
    `当前 <b>v${esc(w.current)}</b>（${esc(w.platformLabel)}）` +
    (w.hasUpdate ? ` → 最新 <span class="up-to">v${esc(w.latest)}</span>` : ' · 已是最新');

  const parts = [];
  if (w.notes) parts.push(`<div class="up-notes">${esc(w.notes)}</div>`);
  if (w.asset) {
    parts.push(
      `<div class="up-row"><span class="up-k">安装包</span> ${esc(w.asset.name)} · ${esc(w.asset.sizeText)}</div>`
    );
  } else {
    parts.push(`<div class="up-row up-tip warn">这个版本没有 ${esc(w.platformLabel)} 的安装包，只能去发布页手动下载。</div>`);
  }

  if (d.state === 'downloading') {
    const pct = d.total ? Math.min(99, Math.round((d.received / d.total) * 100)) : 0;
    parts.push(
      `<div class="up-bar"><div class="up-bar-in" style="width:${pct}%"></div></div>` +
        `<div class="up-pct">正在下载 ${pct}%（${fmtBytes(d.received)} / ${fmtBytes(d.total)}）…</div>`
    );
  } else if (d.state === 'done') {
    if (w.isAndroid) {
      parts.push(
        `<p class="up-tip ok">✓ 已下载：<code>${esc(d.name)}</code> 正在调起系统安装界面…</p>` +
          `<p class="up-tip warn">第一次安装会提示「允许来自此来源的应用」；装好后要手动打开一次新版本（系统不会自动重启应用）。</p>`
      );
    } else {
      parts.push(
        `<p class="up-tip ok">✓ 已下载${d.extracted ? '并解压' : ''}到：<code>${esc(d.dir || d.path)}</code></p>` +
          `<p class="up-tip warn">当前程序正在运行、占着自己那个文件，所以不能自己覆盖自己：` +
          `请把解压出来的新程序拖到原位置替换（服务端缓存 <code>data/</code> 不受影响），然后重开。</p>`
      );
    }
  } else if (d.state === 'error') {
    parts.push(`<p class="up-tip warn">下载失败：${esc(d.error)}</p>`);
  }
  body.innerHTML = parts.join('');

  if (go) {
    if (d.state === 'downloading') {
      go.textContent = '下载中…';
      go.disabled = true;
    } else if (d.state === 'done') {
      go.textContent = w.isAndroid ? '再去安装一次' : '打开文件夹';
      go.disabled = false;
    } else if (!w.hasUpdate) {
      go.textContent = '已是最新';
      go.disabled = true;
    } else if (!w.asset) {
      go.textContent = '下载并更新';
      go.disabled = true;
    } else {
      go.textContent = '下载并更新';
      go.disabled = false;
    }
  }
  const info = $('upFootInfo');
  if (info) {
    info.textContent = d.state === 'done' && d.path ? `已保存：${d.name}` : '';
  }
}

/** 点「下载并更新」/「打开文件夹」/「再去安装一次」——按当前状态分岔 */
async function onUpdateAction() {
  const w = updateUi.info;
  if (!w) return;
  const d = w.download || {};
  if (d.state === 'done') {
    if (w.isAndroid) installApk(d);
    else revealDownload();
    return;
  }
  await startUpdate();
}

async function startUpdate() {
  if (updateUi.checking) return;
  try {
    const r = await API('update/download', null, null, 'POST');
    if (updateUi.info) updateUi.info.download = r.download;
    renderUpdateBody();
    if (r.download && r.download.state === 'error') showToast('不能开始下载：' + r.download.error);
    else startPollDownload();
  } catch (e) {
    showToast('开始下载失败：' + e.message);
  }
}

/** 下载进度轮询：服务端读的是内存状态，500ms 一次完全够 */
function startPollDownload() {
  if (updateUi.polling) return;
  updateUi.polling = setInterval(async () => {
    try {
      const r = await API('update/progress');
      if (!updateUi.info) return;
      updateUi.info.download = r.download;
      if (!$('updateModal').hidden) renderUpdateBody();
      if (r.download.state === 'done') {
        stopPollDownload();
        onDownloadDone();
      } else if (r.download.state === 'error') {
        stopPollDownload();
      }
    } catch (e) {
      /* 服务端抽风就下一轮再说 */
    }
  }, 500);
}

function stopPollDownload() {
  clearInterval(updateUi.polling);
  updateUi.polling = null;
}

/** 下完之后的收尾：Android 立刻调起安装器；桌面自动帮他打开一次文件夹 */
function onDownloadDone() {
  const w = updateUi.info;
  const d = (w && w.download) || {};
  const open = !$('updateModal').hidden;
  if (w && w.isAndroid) {
    installApk(d);
    if (open) showToast('新版本已下载，正在调起安装');
    return;
  }
  if (!updateUi.revealed && open) {
    updateUi.revealed = true;
    revealDownload();
  }
}

/** 让 Android 壳把下载好的 APK 交给系统安装器 */
function installApk(d) {
  if (!ANDROID || !d || !d.path) return;
  try {
    if (ANDROID.installApk) ANDROID.installApk(d.path);
  } catch (e) {
    showToast('调起安装失败，请到应用私有目录里手动安装：' + d.path);
  }
}

/** 桌面：在文件管理器里打开下载目录 */
async function revealDownload() {
  try {
    const r = await API('update/reveal', null, null, 'POST');
    if (!r.ok) showToast(r.error || '打开文件夹失败');
  } catch (e) {
    showToast('打开文件夹失败：' + e.message);
  }
}

/** 打开 Release 页面（系统浏览器） */
async function openReleasePage() {
  try {
    await API('update/open', null, null, 'POST');
  } catch (e) {
    showToast('打开发布页失败：' + e.message);
  }
}

/* ---------------------------------------------------------------- *
 * Android 返回（手势侧滑 / 返回键）→ 先关弹层
 *
 * APK 的 MainActivity 收到返回时先调这个函数：有弹层就关掉它并返回 true；
 * 什么都没有返回 false，交回系统（WebView 历史后退 / 退出 App）。
 * 报告详情 → 回明细列表；从「我的」进的列表 → 回「我的」（closeDetail 里已有）。
 * ---------------------------------------------------------------- */
window.__birdHandleBack = () => {
  // 限流验证码浮层在最上层（它能盖住任何已打开的弹层）
  const cm = $('captchaModal');
  if (cm && !cm.hidden) {
    closeCaptcha();
    return true;
  }
  // 图片查看器在其次
  const pv = $('photoViewer');
  if (pv && !pv.hidden) {
    closePhotos();
    return true;
  }
  // 监听历史记录
  const wm = $('watchModal');
  if (wm && !wm.hidden) {
    closeWatchModal();
    return true;
  }
  // 更新弹层（从「我的」里点出来的，排在「我的」之后）
  const um = $('updateModal');
  if (um && !um.hidden) {
    closeUpdateModal();
    return true;
  }
  const dm = $('detailModal');
  if (detail.open && dm && !dm.hidden) {
    if (detail.pane === 'report') {
      closeReport(); // 报告详情：返回 = 回明细列表
      return true;
    }
    if (detail.pane === 'taxon') {
      closeTaxonCard(); // 鸟种档案：返回 = 回拼图
      return true;
    }
    closeDetail();
    return true;
  }
  const mm = $('myModal');
  if (mm && !mm.hidden) {
    closeMy();
    return true;
  }
  return false;
};

function applyDetailFilter(resetPage) {
  // 拼图视图不吃 detail.rows（它的「行」是名录里的科），筛选词直接交给 renderPuzzle 用；
  // 不在这里分岔的话，在拼图里搜东西会毫无反应（因为下面筛的是空数组）
  if (detail.kind === 'puzzle') {
    if (resetPage) detail.page = 1;
    renderPuzzle();
    return;
  }
  const kw = detail.q.trim().toLowerCase();
  let rows = detail.rows;
  if (kw) {
    rows = rows.filter((x) =>
      detail.kind === 'taxon'
        ? [x.name, x.latin, x.english].some((v) => (v || '').toLowerCase().includes(kw))
        : [x.pointName, x.username, x.district, x.city, x.serialId].some((v) => (v || '').toLowerCase().includes(kw))
    );
  }
  if (detail.kind === 'taxon') {
    rows = [...rows];
    if (detail.sort === 'protection') {
      rows.sort((a, b) => {
        const la = LEVEL_RANK[a.chinaLevel] || 9;
        const lb = LEVEL_RANK[b.chinaLevel] || 9;
        return la !== lb ? la - lb : detailRarityKey(a) - detailRarityKey(b);
      });
    } else {
      // 与榜单同一口径：该地区**最近两年**记录数越少越稀有，排越前
      rows.sort(
        (a, b) =>
          detailRarityKey(a) - detailRarityKey(b) ||
          (LEVEL_RANK[a.chinaLevel] || 9) - (LEVEL_RANK[b.chinaLevel] || 9) ||
          String(a.name).localeCompare(String(b.name), 'zh')
      );
    }
  }
  detail.view = rows;
  if (resetPage) detail.page = 1;
  renderDetail();
}

function detailSubText() {
  const m = detail.meta || {};
  const parts = [];
  if (detail.kind === 'taxon') {
    parts.push(`本时段 <strong>${fmt(detail.rows.length)}</strong> 种鸟`);
    parts.push(`合计 <strong>${fmt(detail.rows.reduce((s, x) => s + x.count, 0))}</strong> 条记录`);
    // 排序依据是历史口径，这里明确写出来，免得用户拿「记录数」列去对排名
    if (m.historyUsed) {
      parts.push(`排序依据：该地区最近两年（${HISTORY_WINDOW_START} 起）记录数（<strong>${fmt(m.historyMatched)}</strong> 种有记录）`);
    } else {
      parts.push(`<span class="warn">最近两年口径暂不可用，已按本时段记录数排序</span>`);
    }
    const dq = detail.rows.filter((x) => x.doubt);
    if (m.doubtError) parts.push(`<span class="warn">疑问数据标记暂时取不到</span>`);
    else if (dq.length) parts.push(`<span class="doubt-foot"><i class="doubt-dot"></i><strong>${fmt(dq.length)}</strong> 种含「疑问数据」</span>`);
    if (m.pending) parts.push(`<span class="warn">另有 ${fmt(m.pending)} 种的保护等级正在后台补全</span>`);
  } else {
    // 上游只给公开报告，且单页最多 50 份，所以「上游总数」与「本页条数」都要说清楚
    const ov = state.overview || {};
    const total = m.total ?? detail.rows.length;
    if (detail.metric === 'myReports') {
      // 用户维度：上游只给公开报告，且拿不到「这位用户一共上传了多少份」，
      // 所以不做「未公开」的推算（那需要总数，减不出来就会误导）。
      parts.push(`公开报告 <strong>${fmt(total)}</strong> 份，本页 <strong>${fmt(detail.rows.length)}</strong> 份`);
      if (total > DETAIL_REPORT_PAGE_SIZE) parts.push(`共 ${detail.pages} 页，用下方按钮翻页`);
    } else if (detail.metric === 'taxonReports') {
      // 按单个鸟种收窄时**不能**套用概览的 reportNum / openReportNum —— 那是整个地区的
      // 数字，减出来的「未公开份数」跟这一种鸟对不上，会给出一个误导性的值。所以这里
      // 只报这一种鸟的公开报告数，不提「未公开」。
      parts.push(`本时段有 <strong>${fmt(total)}</strong> 份公开报告，本页 <strong>${fmt(detail.rows.length)}</strong> 份`);
      if (total > DETAIL_REPORT_PAGE_SIZE) parts.push(`共 ${detail.pages} 页，用下方按钮翻页`);
    } else {
      const priv = detail.metric === 'open' ? 0 : Math.max(0, (ov.reportNum ?? total) - (ov.openReportNum ?? total));
      parts.push(`上游共 <strong>${fmt(total)}</strong> 份公开报告，本页 <strong>${fmt(detail.rows.length)}</strong> 份`);
      if (total > DETAIL_REPORT_PAGE_SIZE) parts.push(`共 ${detail.pages} 页，用下方按钮翻页`);
      if (priv) parts.push(`<span class="warn">另有 ${fmt(priv)} 份未公开，上游不提供明细</span>`);
    }
  }
  $('detailSub').innerHTML = parts.join(' · ');
}

function taxonRow(x, no) {
  const hist = x.historyCount === null || x.historyCount === undefined ? '—' : fmt(x.historyCount);
  const doubt = x.doubt ? `疑问 ${fmt(x.doubtCount)}` : '—';
  // 明细表列数固定（窄屏靠 CSS 换行），所以「未加新」不做独立一列，
  // 直接跟在中文名后面当一枚小标记，窄屏也不会被挤掉
  const liferTag = x.lifer
    ? `<span class="badge lifer" title="${esc(state.lifer)} 的人生鸟种里没有这一种">未加新</span>`
    : '';
  return `<tr${x.doubt ? ' class="is-doubt"' : ''}${x.lifer ? ' data-lifer="1"' : ''}>
    <td class="ta-c num">${no}</td>
    <td><div class="d-name${x.doubt ? ' is-doubt' : ''}${x.lifer ? ' is-lifer' : ''}">${esc(x.name)}${liferTag}</div><div class="d-latin">${esc(x.latin || '')}</div></td>
    <td class="d-dim">${esc([x.order, x.family].filter(Boolean).join(' · '))}</td>
    <td class="ta-r num strong" data-label="本时段">${fmt(x.count)}</td>
    <td class="ta-r num" data-label="近两年">${hist}</td>
    <td class="ta-r num${x.doubt ? ' is-doubt' : ''}">${doubt}</td>
    <td><div class="badges">${levelBadge(x)}${x.chinaEndemic ? '<span class="badge endemic">中国特有</span>' : ''}${iucnBadge(x.iucn)}</div></td>
  </tr>`;
}

function reportRow(x, no, compact = false) {
  const span = x.startTime && x.endTime ? `${x.startTime.slice(5, 16)} ~ ${x.endTime.slice(11, 16)}` : '';
  // 这一列只显示「查看」：点整行打开应用内的「报告详情」（编号在详情页里给出）
  const link = `<span class="rep-link" title="查看报告详情">查看 ›</span>`;
  // 这份报告里含被上游标疑的记录（`outside_count > 0`）→ 观鸟点标红，跟明细里
  // 「疑问数据」用同一套红色，扫一眼就知道哪几条要复核。
  const doubts = Number(x.outsideCount) || 0;
  const titleCell =
    `<td class="d-name${doubts ? ' is-doubt' : ''}"` +
    (doubts ? ` title="这份报告有 ${fmt(doubts)} 条记录被上游标疑（疑问数据）"` : '') +
    `>${esc(x.pointName || '—')}</td>`;
  // 按单个鸟种收窄时只留「发现点 / 发现人 / 时间」：一份报告里往往有几十种鸟，
  // 「区县」和「鸟种数」在这个语境下不说明任何问题，反而把表撑宽。
  if (compact) {
    return `<tr class="is-jump" data-report-id="${esc(x.reportId || '')}">
      <td class="ta-c num">${no}</td>
      ${titleCell}
      <td data-label="发现人">${esc(x.username || '—')}</td>
      <td class="d-dim" data-label="时间">${esc(span)}</td>
      <td class="d-dim mono">${link}</td>
    </tr>`;
  }
  return `<tr class="is-jump" data-report-id="${esc(x.reportId || '')}">
    <td class="ta-c num">${no}</td>
    ${titleCell}
    <td class="d-dim" data-label="区县">${esc([x.city, x.district].filter(Boolean).join(' '))}</td>
    <td class="d-dim" data-label="时段">${esc(span)}</td>
    <td class="ta-r num strong" data-label="鸟种数">${fmt(x.taxonCount)}</td>
    <td data-label="记录人">${esc(x.username || '—')}</td>
    <td class="d-dim mono">${link}</td>
  </tr>`;
}

function renderDetail() {
  const view = detail.view;
  let rows;
  let offset = 0;
  let pages;

  if (detail.mode === 'client') {
    // 鸟种明细：整份数据在前端分页
    pages = Math.max(1, Math.ceil(view.length / DETAIL_PAGE_SIZE));
    if (detail.page > pages) detail.page = pages;
    offset = (detail.page - 1) * DETAIL_PAGE_SIZE;
    rows = view.slice(offset, offset + DETAIL_PAGE_SIZE);
  } else {
    // 报告明细：页面本身就是服务端的一页，不再切片
    pages = Math.max(1, detail.meta?.totalPages || 1);
    if (detail.page > pages) detail.page = pages;
    offset = (detail.page - 1) * DETAIL_REPORT_PAGE_SIZE;
    rows = view;
  }
  detail.pages = pages;

  detailSubText();

  if (!rows.length) {
    $('detailBody').innerHTML = `<div class="notice">${detail.q ? '本页没有匹配的记录。' : '该条件下没有明细数据。'}</div>`;
  } else if (detail.kind === 'taxon') {
    $('detailBody').innerHTML = `<table class="dtable">
      <thead><tr><th class="ta-c">#</th><th>中文名 / 学名</th><th>目 · 科</th><th class="ta-r">本时段记录</th><th class="ta-r">近两年记录</th><th class="ta-r">疑问数据</th><th>保护等级</th></tr></thead>
      <tbody>${rows.map((x, i) => taxonRow(x, offset + i + 1)).join('')}</tbody>
    </table>`;
  } else {
    // 点鸟种卡片进来的那个弹层用精简列（发现点 / 发现人 / 时间）
    const compact = detail.metric === 'taxonReports';
    // dtable-report：两个报告表共用的标记，供窄屏切换成堆叠排版（见 style.css 手机端块）
    $('detailBody').innerHTML = `<table class="dtable dtable-report">
      <thead><tr>${
        compact
          ? '<th class="ta-c">#</th><th>发现点</th><th>发现人</th><th>时间</th><th>报告</th>'
          : '<th class="ta-c">#</th><th>观鸟点</th><th>区县</th><th>观测时段</th><th class="ta-r">鸟种数</th><th>记录人</th><th>报告编号</th>'
      }</tr></thead>
      <tbody>${rows.map((x, i) => reportRow(x, offset + i + 1, compact)).join('')}</tbody>
    </table>`;
  }
  $('detailBody').scrollTop = 0;

  if (detail.mode === 'client') {
    $('dPageInfo').textContent = view.length
      ? `第 ${detail.page} / ${pages} 页 · 共 ${fmt(view.length)} 条${detail.q ? '（已筛选）' : ''}`
      : '';
  } else {
    $('dPageInfo').textContent = `第 ${detail.page} / ${pages} 页 · 上游共 ${fmt(detail.meta?.total ?? 0)} 份${
      detail.q ? '（本页已筛选）' : ''
    }`;
  }
  $('dPrev').disabled = detail.page <= 1;
  $('dNext').disabled = detail.page >= pages;
}

/* ---------------------------------------------------------------- *
 * 报告详情（应用内打开，不跳记录中心）
 *
 * 报告明细里点行 / 报告编号时，在同一个弹层里把「列表」换成「报告详情」视图，
 * 头部出现「‹ 返回」。数据来自 /api/report（上游 activity/get + activity/taxon
 * 两个接口组装：观鸟点 / 时段 / 记录人 / 备注 + 整份鸟种清单，含数量与标疑）。
 * ---------------------------------------------------------------- */
async function openReport(reportId) {
  if (!reportId) return;
  detail.pane = 'report';
  detail.reportId = reportId;
  $('btnDetailBack').hidden = false;
  $('detailTools').hidden = true; // 筛选 / 排序是列表的工具，详情里不适用
  $('detailFoot').hidden = true; // 分页同理
  $('detailTitle').textContent = '报告详情';
  $('detailSub').innerHTML = '';
  const body = $('detailBody');
  // 冻结窗口高度再换内容（同 openTaxonCard）：列表很高、转圈只有一行，
  // 不冻结的话窗口会先缩成一条、报告回来又突然撑大 —— 中间会「闪一下」。
  body.style.minHeight = body.clientHeight + 'px';
  body.innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在读取报告…</p></div>';
  body.scrollTop = 0;
  paneNav('pane-push'); // 进报告详情：从右侧推入（层内换视图原本是硬切）
  try {
    const r = await API('report', { reportId, liferUser: state.lifer, ...detail.where });
    // 期间可能已经点了「返回」或换了另一份报告：迟到的响应直接丢弃
    if (detail.pane !== 'report' || detail.reportId !== reportId) return;
    renderReport(r);
  } catch (e) {
    if (detail.pane !== 'report' || detail.reportId !== reportId) return;
    $('detailBody').innerHTML = errNoticeHtml('读取报告失败：', e.message);
  }
}

/** 从报告详情返回明细列表：按原状态重画（标题 / 副标题 / 分页都恢复） */
function closeReport() {
  if (detail.pane !== 'report') return;
  detail.pane = 'list';
  detail.reportId = '';
  $('btnDetailBack').hidden = true;
  $('detailTools').hidden = false;
  $('detailFoot').hidden = false;
  $('detailTitle').textContent = detail.listTitle || '明细';
  $('detailBody').style.minHeight = ''; // 解除高度冻结（openReport 里冻的），列表自己会撑回原高度
  renderDetail();
  paneNav('pane-pop'); // 返回列表：从左侧推回，跟「进详情」方向相反
}

function renderReport(r) {
  // 未加新的排在最前：看报告详情最关心的就是「这份报告里哪些我还没记过」。
  // 稳定排序（Array.sort 在 V8 里是稳定的），组内保持上游原始顺序不打乱。
  const list = (r.list || []).slice().sort((a, b) => Number(!!b.lifer) - Number(!!a.lifer));
  const span = r.startTime ? `${esc(r.startTime)}${r.endTime ? ' ~ ' + esc(r.endTime.slice(11)) : ''}` : '';
  const loc = [r.province, r.city && r.city !== r.province ? r.city : '', r.district].filter(Boolean).join(' · ');
  const chips = [
    span ? `<span class="rp-chip">${span}</span>` : '',
    `<span class="rp-chip">记录人 ${esc(r.username || '—')}</span>`,
    `<span class="rp-chip">${fmt(r.taxonCount)} 种 · 目 ${fmt(r.orderCount)} · 科 ${fmt(r.familyCount)}</span>`,
    r.serialId ? `<span class="rp-chip mono">${esc(r.serialId)}</span>` : '',
  ].filter(Boolean).join('');
  const items = list
    .map((x) => {
      // 徽章沿用榜单/明细那套：未加新（青）> 疑问（红）由样式里的 :not() 保证优先级
      const badges =
        levelBadge(x) + (x.chinaEndemic ? '<span class="badge endemic">中国特有</span>' : '') + iucnBadge(x.iucn);
      const liferBadge = x.lifer ? '<span class="badge lifer">未加新</span>' : '';
      const doubtBadge = x.doubt ? '<span class="badge doubt">疑问</span>' : '';
      const nameCls = 'rp-name' + (x.doubt ? ' is-doubt' : '') + (x.lifer && !x.doubt ? ' is-lifer' : '');
      const sub = [x.order, x.family].filter(Boolean).join(' · ');
      // 「该地区近两年 N 条」——就在榜单的历史缓存里（零额外上游），拿不到就不显示
      const hist = x.histCount === null || x.histCount === undefined ? '' : ` · 近两年 ${fmt(x.histCount)} 条`;
      // 有图才显示图片按钮：点开是这一种在这份报告里的照片（OSS 直链）
      const imgBtn = x.imageNum
        ? ` <button class="rp-img-btn" type="button" data-img-act="${esc(r.activityId || '')}" data-img-taxon="${esc(x.taxonId)}" data-img-name="${esc(x.name)}" title="查看图片">` +
          '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="9" cy="9" r="2"></circle><path d="M21 15l-5-5-9 9"></path></svg>' +
          `图片 ${x.imageNum}</button>`
        : '';
      return `<div class="rp-item">
        <div class="rp-main">
          <div class="rp-name-row"><span class="${nameCls}">${esc(x.name)}</span>${liferBadge}${doubtBadge}${badges}</div>
          <div class="rp-latin">${esc(x.latin || '')}</div>
          <div class="rp-sub">${esc(sub)}${imgBtn}${esc(hist)}</div>
        </div>
        <div class="rp-count"><b>${fmt(x.count)}</b><span>只</span></div>
      </div>`;
    })
    .join('');
  $('detailSub').innerHTML =
    r.lifer && r.lifer.liferUser && !r.lifer.liferError
      ? `<span class="lifer-foot"><i class="lifer-dot"></i>其中 <strong>${fmt(r.lifer.liferNewCount)}</strong> 种是你（${esc(r.lifer.liferUser)}）还没加新的</span>`
      : '';
  $('detailBody').innerHTML = `
    <div class="rp-head">
      <div class="rp-point">${esc(r.point || '—')}</div>
      <div class="rp-where">${esc(loc)}</div>
      <div class="rp-chips">${chips}<a class="rp-orig" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener" title="在记录中心打开原页（照片等完整内容）">记录中心原页 ↗</a></div>
      ${r.note ? `<div class="rp-note">备注：${esc(r.note)}</div>` : ''}
    </div>
    <div class="rp-list">${items || '<div class="notice">这份报告没有鸟种明细。</div>'}</div>`;
  paneSettle(); // 内容落地：若「推入」已播完，补一下淡入，避免硬切
}

/* ---------------------------------------------------------------- *
 * 「目 / 科构成」：按当前榜单本地聚合（零请求、零分页）
 * ---------------------------------------------------------------- */
function renderOrders() {
  const list = state.hot?.list || [];
  if (!list.length) {
    $('detailSub').innerHTML = '';
    $('detailBody').innerHTML = '<div class="notice">先查询出榜单，再来看目 / 科构成。</div>';
    return;
  }
  const map = new Map();
  for (const x of list) {
    const key = x.order || '未标注';
    const g = map.get(key) || { order: key, n: 0, protectedN: 0, records: 0, families: new Set() };
    g.n++;
    if (x.chinaLevel) g.protectedN++;
    g.records += Number(x.count) || 0;
    if (x.family) g.families.add(x.family);
    map.set(key, g);
  }
  const groups = [...map.values()].sort((a, b) => b.n - a.n || a.order.localeCompare(b.order, 'zh'));
  const max = Math.max(...groups.map((g) => g.n), 1);
  $('detailSub').innerHTML =
    `本榜单共 <strong>${fmt(list.length)}</strong> 种，分属 <strong>${groups.length}</strong> 个目 · 本地聚合、零请求`;
  $('detailBody').innerHTML =
    '<div class="ord-list">' +
    groups
      .map(
        (g) => `<div class="ord-item">
      <div class="ord-name">${esc(g.order)}</div>
      <div class="ord-bar-track"><i style="width:${Math.max(2, Math.round((g.n / max) * 100))}%"></i></div>
      <div class="ord-num"><b>${fmt(g.n)}</b> 种 · ${g.families.size} 科${g.protectedN ? ` · 受保护 ${fmt(g.protectedN)}` : ''} · 记录 ${fmt(g.records)} 条</div>
    </div>`
      )
      .join('') +
    '</div>';
}

/* ---------------------------------------------------------------- *
 * 弹层高度要跟着「实际能看见的高度」走
 *
 * 手机浏览器的地址栏 / 底部工具条会伸缩，而 CSS 的 vh 是按「工具条收起」时的
 * 高度算的 —— 只认 vh 的话，明细弹层会被摆到比可视区更低的位置，下半截
 * （正是「上一页 / 下一页」那一条）落到屏幕外还滚不到。dvh 能解决这个问题，
 * 但老一点的浏览器内核（旧版 WebView / 国内 App 内置浏览器）不认识它。
 * 所以这里用 visualViewport 量出「当前真正能看到的高度」，写进 CSS 变量
 * --vvh（web/style.css 的弹层在用），并随尺寸变化实时更新；没有
 * visualViewport 的老引擎退回 innerHeight（同样会跟着工具条伸缩）。
 * ---------------------------------------------------------------- */
function trackViewportHeight() {
  const root = document.documentElement;
  const apply = () => {
    const vv = window.visualViewport;
    const h = vv && vv.height ? vv.height : window.innerHeight;
    if (h > 0) root.style.setProperty('--vvh', `${Math.floor(h)}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  // 键盘弹出 / 收起也会改变可视高度，visualViewport 上有对应事件
  if (window.visualViewport) window.visualViewport.addEventListener('resize', apply);
}

/* ---------------------------------------------------------------- *
 * 事件绑定 & 启动
 * ---------------------------------------------------------------- */
function bind() {
  trackViewportHeight();

  // 省 / 市 / 区县下拉只改查询条件、**不自动查询** —— 三级联动会一路连发好几次
  // 请求，改成等用户点「查询」再执行。下级下拉仍然立刻联动（那是拉选项，
  // 不是查数据），并在状态栏提示条件已改。
  const regionPendingHint = () => setStatus('', '查询条件已改，点「查询」更新');
  $('selProvince').addEventListener('change', async (e) => {
    state.region.province = e.target.value;
    state.region.city = '';
    state.region.district = '';
    await loadCities();
    regionPendingHint();
    renderRegionHint(); // 选中「全国」时立刻给出提示
  });
  $('selCity').addEventListener('change', async (e) => {
    state.region.city = e.target.value;
    state.region.district = '';
    await loadDistricts();
    regionPendingHint();
  });
  $('selDistrict').addEventListener('change', (e) => {
    state.region.district = e.target.value;
    regionPendingHint();
  });
  // 加载遮罩上的「取消」：中止本轮查询（在途请求全部 abort），由 runQuery 安静收场
  $('btnCancelLoading').addEventListener('click', () => {
    if (currentQueryAbort) currentQueryAbort.abort();
    else hideLoading(); // 兜底：没有在途查询时直接把遮罩收掉
  });
  // 查询按钮就在「记录检索」这一行，点击时把日期框与检索条件一起提交
  $('btnQuery').addEventListener('click', () => {
    applyTimeState($('inpStart').value, $('inpEnd').value);
    runQuery();
  });
  // 改完日期直接回车也能查
  for (const id of ['inpStart', 'inpEnd']) {
    // 日期一改就刷新「全国」那条提示，但不自动查询（与地区下拉一致，等用户点「查询」）
    $(id).addEventListener('change', () => applyTimeState($('inpStart').value, $('inpEnd').value));
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyTimeState($('inpStart').value, $('inpEnd').value);
        runQuery();
      }
    });
  }
  $('btnRefresh').addEventListener('click', () => {
    // 忽略本地缓存，重新向上游取一次当前地区的全部数据
    state.nocache = true;
    runQuery();
  });

  // ---- 记录检索：观测地点 / 用户名称 / 鸟种名称 ----
  // 回车即查询；观测地点与用户名称是上游的模糊匹配，直接下推
  for (const id of ['inpPoint', 'inpUser', 'inpTaxonName']) {
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runQuery();
      }
    });
    // 改了输入但还没点查询时，先把已解析的鸟种条件视为失效，避免误用旧条件
    $(id).addEventListener('input', () => {
      if (id === 'inpTaxonName' && $('inpTaxonName').value.trim() !== state.taxonName) {
        state.taxonId = '';
      }
    });
  }
  $('btnResetFilters').addEventListener('click', () => {
    clearRecordFilters();
    runQuery();
  });
  // 候选鸟种 / 取消鸟种条件
  $('filterHint').addEventListener('click', (e) => {
    const clear = e.target.closest('[data-clear-taxon]');
    if (clear) {
      // 只是不按鸟种收窄：观测地点 / 用户名称照常生效
      commitRecordInputs();
      clearTaxonFilter();
      runQuery();
      return;
    }
    const chip = e.target.closest('.cand[data-taxon-id]');
    if (chip) {
      // 先把刚填的地点 / 用户带上，再应用选中的鸟种
      commitRecordInputs();
      applyTaxonPick(chip.dataset.taxonId, chip.dataset.taxonName);
      renderFilterHint(
        `<span class="fh-ok">已按鸟种「${esc(state.taxonName)}」收窄</span>` +
          `<button class="cand" data-clear-taxon="1">取消鸟种条件</button>`
      );
      runQuery();
    }
  });
  // 报告明细里点任意一行 / 报告编号 → 打开应用内的「报告详情」（不再跳记录中心；
  // 详情页里保留一个「记录中心原页 ↗」小链接，要看照片等完整内容时再去）。
  // 详情弹层里还承载 TODO 列表页：它的「删除」与「点条目看报告」也在这里处理。
  $('detailBody').addEventListener('click', (e) => {
    // 报告详情里的「图片 N」：打开图片查看器
    const imgBtn = e.target.closest('.rp-img-btn');
    if (imgBtn) {
      openPhotos(imgBtn.dataset.imgAct, imgBtn.dataset.imgTaxon, imgBtn.dataset.imgName);
      return;
    }
    // 收集拼图里点鸟名 → 这个鸟种的档案（同一个弹层里换视图，可 ‹ 返回拼图）
    const tile = e.target.closest('.pz-tile[data-taxon-id]');
    if (tile && detail.kind === 'puzzle') {
      openTaxonCard(tile.dataset.taxonId, tile.dataset.taxonName, tile.dataset.taxonCount);
      return;
    }
    const del = e.target.closest('.todo-del');
    if (del && detail.metric === 'todo') {
      const id = Number(del.dataset.delId);
      const i = todoList.findIndex((x) => Number(x.taxonId) === id);
      if (i >= 0) {
        const [removed] = todoList.splice(i, 1);
        saveTodo();
        syncTodo(); // 会顺带重画正开着的 TODO 列表页
        showToast(`已从 TODO 移除：${removed.name}`);
      }
      return;
    }
    const todoItem = e.target.closest('.todo-item[data-taxon-id]');
    if (todoItem && detail.metric === 'todo') {
      detail.returnToMy = false; // 去看报告，关掉后别弹回「我的」
      openDetail('taxonReports', { title: `${todoItem.dataset.taxonName} · 报告明细`, where: { taxonid: todoItem.dataset.taxonId } });
      return;
    }
    const tr = e.target.closest('tr[data-report-id]');
    if (tr && tr.dataset.reportId) openReport(tr.dataset.reportId);
  });
  $('btnDetailBack').addEventListener('click', () => {
    if (detail.pane === 'report') closeReport(); // 报告详情：返回 = 回明细列表
    else if (detail.pane === 'taxon') closeTaxonCard(); // 鸟种档案：返回 = 回拼图
    else closeDetail(); // orders / liferList 这类顶层视图：返回 = 关闭（liferList 会自动回「我的」）
  });

  $('selFilter').addEventListener('change', (e) => {
    state.filter = e.target.value;
    runQuery();
  });
  $('selSort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    runQuery();
  });
  let t;
  $('inpFilter').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = e.target.value.trim();
      runQuery();
    }, 400);
  });
  // ---- 概览卡下钻：点卡片看明细 ----
  $('overview').addEventListener('click', (e) => {
    const card = e.target.closest('.stat-card[data-metric]');
    if (card) openDetail(card.dataset.metric);
  });
  $('overview').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.stat-card[data-metric]');
    if (card) {
      e.preventDefault();
      openDetail(card.dataset.metric);
    }
  });
  // ---- 榜单卡片：点鸟种看它出现在哪些公开报告 ----
  // 点击时才向上游查询（懒加载，不预取）。openDetail 会把 opts.where 与 currentWhere()
  // 合并，所以自动带上当前页面的地区与日期；并「打开瞬间定格」，之后改页面条件不影响它。
  const openTaxonReports = (card) => {
    if (!card) return;
    openDetail('taxonReports', {
      title: `${card.dataset.taxonName} · 报告明细`,
      where: { taxonid: card.dataset.taxonId },
    });
  };
  $('hotList').addEventListener('click', (e) => {
    // 角上的「＋ / ★」是 TODO 按钮：把这一种加入 / 移出「待去找」，不打开报告弹层
    const todoBtn = e.target.closest('.hc-todo');
    if (todoBtn) {
      if (todoBtn.disabled) return;
      todoBtn.disabled = true; // 取地址期间防连点；syncTodo 会恢复
      toggleTodo(todoBtn.dataset.todoId, todoBtn.dataset.todoName);
      return;
    }
    openTaxonReports(e.target.closest('.hot-card[data-taxon-id]'));
  });
  $('hotList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.closest('.hc-todo')) return; // 按钮自己的 Enter/空格走 click
    const card = e.target.closest('.hot-card[data-taxon-id]');
    if (card) {
      e.preventDefault();
      openTaxonReports(card);
    }
  });
  $('detailClose').addEventListener('click', closeDetail);
  $('detailModal').addEventListener('click', (e) => {
    if (e.target === $('detailModal')) closeDetail(); // 点遮罩关闭
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // 限流验证码浮层在最上层，先关它
    if (!$('captchaModal').hidden) {
      closeCaptcha();
      return;
    }
    // 图片查看器在其次
    const pv = $('photoViewer');
    if (pv && !pv.hidden) {
      closePhotos();
      return;
    }
    // 监听历史记录（DOM 里排在「我的」与明细之后，层级更高）
    if (!$('watchModal').hidden) {
      closeWatchModal();
      return;
    }
    // 更新弹层是从「我的」里点出来的，DOM 排在「我的」之后 → 要先关它
    if (!$('updateModal').hidden) {
      closeUpdateModal();
      return;
    }
    // 「我的」面板在 DOM 里排在明细弹层之后（层级更高），所以先关它
    if (!$('myModal').hidden) {
      closeMy();
      return;
    }
    // 层内视图要先「返回」而不是整个关掉：报告详情 → 回明细列表，鸟种档案 → 回拼图。
    // （与 __birdHandleBack 同一套路由 —— 早先这里只有 closeDetail()，Esc 会连弹层一起关，
    //   明细里 Esc 回列表的直觉被它弄丢过，别再改回去。）
    if (detail.open) {
      if (detail.pane === 'report') closeReport();
      else if (detail.pane === 'taxon') closeTaxonCard();
      else closeDetail();
    }
  });
  let detailTimer;
  $('dSearch').addEventListener('input', (e) => {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(() => {
      detail.q = e.target.value;
      applyDetailFilter(true);
    }, 250);
  });
  $('dSort').addEventListener('change', (e) => {
    detail.sort = e.target.value;
    applyDetailFilter(true);
  });
  $('dPrev').addEventListener('click', () => {
    if (detail.page <= 1) return;
    detail.page -= 1;
    if (detail.mode === 'server') reloadDetail();
    else renderDetail();
  });
  $('dNext').addEventListener('click', () => {
    if (detail.page >= (detail.pages || 1)) return;
    detail.page += 1;
    if (detail.mode === 'server') reloadDetail();
    else renderDetail();
  });

  // ---- 限流验证码浮层 ----
  $('captchaClose').addEventListener('click', closeCaptcha);
  $('captchaDoneBtn').addEventListener('click', captchaDoneAndBack);
  $('captchaModal').addEventListener('click', (e) => {
    if (e.target === $('captchaModal')) closeCaptcha(); // 点遮罩关闭（点 iframe 里不会冒泡上来）
  });
  // 505 提示里的「输入一次验证码」按钮是动态插进 innerHTML 的，用事件委托接
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.captcha-open');
    if (!btn) return;
    e.preventDefault();
    openCaptcha();
  });

  // ---- 稀有监听：开关 / 稀有数量 / 右下角浮标 / 历史记录弹层 ----
  // 「我的」里的开关：勾上 = 开启（或重新开启），取消 = 关闭
  $('chkWatch').addEventListener('change', (e) => {
    if (e.target.checked) watchStart();
    else watchStop();
  });
  // 改「稀有数量」：监听着就按新数量重开一次（重建基线，历史记录与报过的鸟都保留）
  $('selWatchThreshold').addEventListener('change', (e) => {
    watchUi.threshold = Number(e.target.value);
    if (watchUi.enabled) watchStart({ reconfig: true });
    else syncWatchRow();
  });
  // ---- 版本与更新（只在「我的」里用）----
  $('btnVersion').addEventListener('click', onVersionClick);
  $('upClose').addEventListener('click', () => closeUpdateModal());
  $('btnUpLater').addEventListener('click', () => closeUpdateModal());
  $('updateModal').addEventListener('click', (e) => {
    if (e.target === $('updateModal')) closeUpdateModal(); // 点遮罩关闭（下载会继续）
  });
  // 一个按钮按状态分岔：下载 / 打开文件夹 / 再去安装一次（见 onUpdateAction）
  $('btnUpGo').addEventListener('click', onUpdateAction);
  $('btnUpPage').addEventListener('click', openReleasePage);
  $('watchPill').addEventListener('click', openWatchModal);
  $('watchCardHistory').addEventListener('click', () => {
    hideWatchCard();
    openWatchModal();
  });
  // 只是收起卡片，监听继续；角标留着提醒「还有没看的」
  $('watchCardClose').addEventListener('click', hideWatchCard);
  $('watchCardStop').addEventListener('click', () => watchStop());
  $('watchCardBody').addEventListener('click', (e) => {
    const item = e.target.closest('.wc-item[data-idx]');
    if (!item) return;
    const a = watchUi.cardAlerts[Number(item.dataset.idx)];
    if (!a) return;
    hideWatchCard();
    openWatchTaxonReport(a.conditions, a.taxonId, a.name);
  });
  $('watchClose').addEventListener('click', () => closeWatchModal());
  $('watchModal').addEventListener('click', (e) => {
    if (e.target === $('watchModal')) closeWatchModal(); // 点遮罩关闭
  });
  $('watchBody').addEventListener('click', (e) => {
    const item = e.target.closest('.wt-item[data-wt-index]');
    if (!item) return;
    const a = (watchUi.snapshot?.history || [])[Number(item.dataset.wtIndex)];
    if (!a) return;
    closeWatchModal(true); // 立刻收起：接着要开明细弹层，别让退场动画盖在它上面
    openWatchTaxonReport(a.conditions, a.taxonId, a.name);
  });
  $('btnWatchCheck').addEventListener('click', async () => {
    const b = $('btnWatchCheck');
    const old = b.textContent;
    b.disabled = true;
    b.textContent = '检查中…';
    try {
      const w = await watchCheck({ force: true, silent: false });
      // 有新发现时 watchCheck 自己会弹一条带鸟种名的轻提示（还有右下角那张卡），
      // 这里只在「什么都没发现」时补一句，免得两条提示互相覆盖
      if (w && w.enabled && !(w.newAlerts || []).length) showToast('检查完成：没有新的稀有鸟种');
    } finally {
      b.disabled = false;
      b.textContent = old;
    }
  });
  $('btnWatchClear').addEventListener('click', async () => {
    try {
      const w = applyWatchSnapshot(await API('watch/history', null, null, 'POST'));
      renderWatchBody();
      showToast('已清空监听记录（已提醒过的鸟种不会重复报）');
    } catch (e) {
      showToast('清空失败：' + e.message);
    }
  });
  $('btnWatchStop').addEventListener('click', () => watchStop());
  // 回到前台补一轮：切回来时往往已经过了好几个轮询周期
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) watchCatchUp();
  });

  // ---- 「我的」：绑定用户名 / 解绑 / 只看未加新 / 重新获取名单 ----
  $('btnMy').addEventListener('click', openMy);
  $('myClose').addEventListener('click', closeMy);
  $('myModal').addEventListener('click', (e) => {
    if (e.target === $('myModal')) closeMy(); // 点遮罩关闭
  });
  $('btnLiferBind').addEventListener('click', doBindLifer);
  // 手机上输入完直接按「前往 / 完成」就能绑定，不用回手去点按钮
  $('inpLifer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doBindLifer();
    }
  });
  // 「我的」里点「总鸟种数」→ 人生鸟种全列表
  $('myStats').addEventListener('click', (e) => {
    if (e.target.closest('#myTaxonCell')) openMyLiferList();
  });
  // 图片查看器：点 × 或点图片以外的任何地方关闭；图片支持双指缩放 / 拖动 / 双击
  $('pvClose').addEventListener('click', closePhotos);
  $('photoViewer').addEventListener('click', (e) => {
    if (!e.target.closest('.pv-img')) closePhotos();
  });
  bindPhotoZoom();
  // 「我的」里的 TODO 入口按钮：点开列表页；关闭（× / Esc / ‹ 返回）自动回「我的」
  $('btnMyTodo').addEventListener('click', () => {
    closeMy();
    openDetail('todo');
    detail.returnToMy = true;
  });
  // 「我的」里的「我的报告」：要绑定用户才有得查，没绑定时按钮是禁用的
  $('btnMyReports').addEventListener('click', () => {
    if (!state.lifer) {
      showToast('先在「我的」里绑定记录中心用户名');
      return;
    }
    openMyReports();
  });
  // 「我的」里的「收集拼图」：要绑定用户才有得比，没绑定时按钮是禁用的
  $('btnMyPuzzle').addEventListener('click', () => {
    if (!state.lifer) {
      showToast('先在「我的」里绑定记录中心用户名');
      return;
    }
    openMyPuzzle();
  });
  // 拼图里的两个勾选项：切换后只重画列表，不重新请求
  $('detailBody').addEventListener('change', (e) => {
    const t = e.target;
    if (!t || detail.kind !== 'puzzle') return;
    if (t.id === 'pzMissing') puzzleOpts.showMissing = t.checked;
    else if (t.id === 'pzEmpty') puzzleOpts.showEmpty = t.checked;
    else return;
    savePuzzleOpts();
    renderPuzzle();
  });
  // 「我的」里的弹出动画选择：立即生效并记住，给一条提示
  $('selAnim').addEventListener('change', (e) => {
    setAnim(e.target.value);
    showToast(`弹出动画：${ANIM_LABELS[animType] || animType}`);
  });
  $('btnLiferUnbind').addEventListener('click', () => {
    setLifer('');
    showMyMsg('已取消绑定。');
    // 榜单上的青色标记要跟着撤掉，所以重查一次
    runQuery();
  });
  // 「重新获取名单」：只忽略人生鸟种缓存（服务端 liferNocache），地区榜单照旧复用
  $('btnMyRefresh').addEventListener('click', async () => {
    $('btnMyRefresh').disabled = true;
    $('btnMyRefresh').textContent = '获取中…';
    try {
      state.liferNocache = true;
      await loadMyLifelist(true);
      showMyMsg(state.liferInfo ? '已从上游重新取回你的记录。' : '');
      runQuery();
    } finally {
      $('btnMyRefresh').disabled = false;
      $('btnMyRefresh').textContent = '重新获取名单';
    }
  });

  let rt;
  window.addEventListener('resize', () => {
    if (!sideChartsVisible()) return; // 侧栏图表关闭时无需重绘
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (state.trend) {
        renderMonthlyChart($('chartTaxon'), state.trend.months, 'taxonCount', 'bar-taxon');
        renderMonthlyChart($('chartReport'), state.trend.months, 'reportCount', 'bar-report');
      }
      if (state.regionRank) renderRankChart($('chartRegionRank'), state.regionRank);
    }, 150);
  });
}

/** 把地区恢复到上次选择的位置（省 → 市 → 区县逐级回填） */
async function restoreRegion(init) {
  if (!state.provinces.some((x) => x.name === init.province)) return;
  $('selProvince').value = init.province;
  state.region.province = init.province;
  await loadCities(); // 顺带填好市级下拉，直辖市会自动选中唯一的市
  if (!init.city) return;
  if (![...$('selCity').options].some((o) => o.value === init.city)) return;
  $('selCity').value = init.city;
  state.region.city = init.city;
  await loadDistricts();
  if (!init.district) return;
  if ([...$('selDistrict').options].some((o) => o.value === init.district)) {
    $('selDistrict').value = init.district;
    state.region.district = init.district;
  }
}

(async function init() {
  bind();
  try {
    await loadProvinces();
    setStatus('ok', '服务已连接');
  } catch (e) {
    setStatus('err', '无法连接服务端');
    $('hotList').innerHTML = STANDALONE
      ? '<div class="notice error">这个页面是用 file:// 直接打开的，需要本机服务端配合：请先在项目目录执行 <code>node server/index.mjs</code>，然后刷新本页。<br />（浏览器不能直接调记录中心的接口，取数必须经由本机服务端转发。）</div>'
      : '<div class="notice error">无法连接服务端，请先在项目目录执行 <code>node server/index.mjs</code> 后刷新页面。</div>';
    return;
  }

  // 还原上次的选择：地址栏参数 → 本地存储 → 默认（北京市 · 当天）
  const init = resolveInitial();
  applyTimeState(init.start, init.end);
  restoreTools(init);
  await restoreRegion(init);
  renderRegionHint(); // 恢复完地区再算一次：applyTimeState 那次还不知道省份

  // 把归一化后的条件写回地址栏与本地存储，保证三者一致
  persist();
  runQuery();

  // 监听状态存在服务端（data/watch.json），这里只把状态读回来：
  // 刷新页面 / 换设备打开，监听开着就继续开着
  restoreWatch();

  // 版本：后台静默查一次（服务端 6 小时缓存），这样「我的」里的红点打开就是最新的。
  // 主界面**不**做任何提示 —— 这一步只更新面板里的那一行状态。
  loadVersion({ silent: true });
})();
