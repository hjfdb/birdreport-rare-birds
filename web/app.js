/**
 * 观鸟地区稀有鸟种榜 · 网页端
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
  return (p, q) => {
    const u = new URL(base + '/api/' + p, location.href);
    if (q) for (const k in q) if (q[k] !== undefined && q[k] !== null && q[k] !== '') u.searchParams.set(k, q[k]);
    return fetch(u).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `请求失败 (${r.status})`);
      return j;
    });
  };
})();

/** 用 file:// 双击打开时为 true：页面本身不带服务端，取数走 http://127.0.0.1:8787 */
const STANDALONE = !location.protocol.startsWith('http');

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
function showLoading(text) {
  $('loadingText').textContent = text || '正在汇总数据…';
  $('loading').hidden = false;
}
function hideLoading() {
  $('loading').hidden = true;
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
 *   - 两个日期都清空 = 全部时间；但上游对「不带时间 + 大范围」的聚合会失败，
 *     所以在提示行里明确写出来，避免用户白等一次 20 秒的失败
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
  $('myModal').hidden = false;
  // 只把光标放进输入框（已绑定时那个框是隐藏的，别去 focus 它）
  if (!state.lifer) $('inpLifer').focus({ preventScroll: true });
  else await loadMyLifelist();
}

function closeMy() {
  $('myModal').hidden = true;
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
  const cmp = $('myCompared');

  if (ll) {
    const avg = ll.speciesCount ? (ll.recordSum / ll.speciesCount).toFixed(1) : '0';
    // 「精确匹配」写在这里而不是只写在说明段里：这是最容易出错、也最容易被静默改回去的一环
    // （模糊匹配会把名字含相同子串的别的用户算进来），摆在数字旁边才好核对。
    sub.textContent = `共 ${fmt(ll.speciesCount)} 种鸟 · ${fmt(ll.recordSum)} 条记录 · 精确匹配`;
    stats.innerHTML =
      myCell('总鸟种数', ll.speciesCount, '种') +
      myCell('累计记录条数', ll.recordSum, '条') +
      myCell('平均每种', avg, '条');
  } else {
    sub.textContent = state.lifer ? '正在读取名单…' : '';
    stats.innerHTML = '';
  }

  if (!stat || !stat.liferUser) {
    cmp.innerHTML = '<div class="notice">正在汇总当前榜单…稍后再看这里。</div>';
    $('myBarFill').style.width = '0%';
    $('myBarText').textContent = '';
    $('btnMyShowNew').disabled = true;
  } else if (stat.liferError) {
    cmp.innerHTML = `<div class="notice error">${esc(stat.liferError)}</div>`;
    $('myBarFill').style.width = '0%';
    $('myBarText').textContent = '';
    $('btnMyShowNew').disabled = true;
  } else {
    const total = stat.returned || 0;
    const known = stat.liferKnownCount || 0;
    const fresh = stat.liferNewCount || 0;
    cmp.innerHTML =
      myCell('当前榜单鸟种', total, '种') +
      myCell('我已加新', known, '种', 'is-known') +
      myCell('未加新', fresh, '种', 'is-new');
    const pct = total ? Math.round((known / total) * 100) : 0;
    $('myBarFill').style.width = pct + '%';
    $('myBarText').textContent = `已加新 ${pct}%`;
    $('btnMyShowNew').disabled = fresh === 0;
    $('btnMyShowNew').textContent = fresh ? `只看未加新的 ${fmt(fresh)} 种` : '当前榜单已全部加新';
  }

  // 右上角入口上的小角标：当前榜单还剩多少种没加新
  const badge = $('myEntryCount');
  const badgeCount = stat && stat.liferUser && !stat.liferError ? stat.liferNewCount || 0 : 0;
  badge.hidden = !badgeCount;
  badge.textContent = badgeCount;
  badge.title = badgeCount ? `当前榜单里你还有 ${badgeCount} 种没加新` : '';
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

/** 用地区鸟种清单喂「鸟种名称」的输入联想；榜单被收窄到很少时就不再刷新，避免只剩一项 */
function populateTaxonDatalist(list) {
  const dl = $('dlTaxon');
  if (!dl || !list || list.length < 15) return;
  const names = new Set();
  for (const x of list) if (x.name) names.add(x.name);
  if (names.size < 10) return;
  dl.innerHTML = [...names].slice(0, 2000).map((n) => `<option value="${esc(n)}"></option>`).join('');
}

/** 报告明细里出现过的观鸟点 / 记录人，顺手做成输入联想（不额外请求上游） */
function populateRecordDatalists(rows) {
  if (!rows || !rows.length) return;
  const fill = (id, values) => {
    const dl = $(id);
    if (!dl || !values.size) return;
    const cur = new Set([...dl.options].map((o) => o.value));
    for (const v of values) cur.add(v);
    dl.innerHTML = [...cur].slice(0, 500).map((v) => `<option value="${esc(v)}"></option>`).join('');
  };
  fill('dlPoint', new Set(rows.map((r) => r.pointName).filter(Boolean)));
  fill('dlUser', new Set(rows.map((r) => r.username).filter(Boolean)));
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
    { k: '目 / 科', v: `${o.orderNum}`, u: `/ ${o.familyNum}`, cls: '' },
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
      // 排序依据是「该地区最近两年记录数」，所以卡片上的大数字也用它；
      // 本时段的记录数放在下一行，避免「排名 1 却写着 1 条」这种看起来自相矛盾的画面
      const hasHist = x.historyCount !== null && x.historyCount !== undefined;
      const main = hasHist ? x.historyCount : x.count;
      // 「条」写进标签里而不是单列一个字：这样整行读作「212 条近两年记录」，
      // 与下面「本时段 正常 n 条 · 疑问 n 条」的单位一致，不会出现「212 近两年记录」这种缺量词的读法
      const mainLabel = hasHist ? '条近两年记录' : '条本时段记录';
      // 本时段记录拆成「正常 / 疑问（红色标记）」两块。
      // 上游按 outside_type 做的是记录级拆分，逐种核对满足「全部 = 正常 + 疑问」，
      // 所以这里直接用减法得到正常条数，不再多跑一次上游查询。
      // 不再写「本时段 N 条」这个总数：紧接着的「正常 + 疑问」相加就等于它，
      // 一行里摆两个总数只会让人多算一次（历史记录数已经是大数字那一行了）。
      const normalCount = Math.max(0, (Number(x.count) || 0) - (x.doubtCount || 0));
      const histLine = s.doubtError
        ? `本时段 ${fmt(x.count)} 条` // 标疑数据取不到，只能给总数
        : `本时段 正常 <b>${fmt(normalCount)}</b> 条` +
          ` · <span class="doubt-part${x.doubt ? ' is-doubt' : ''}">疑问 <b>${fmt(x.doubtCount)}</b> 条</span>`;
      // 上游 AI 半自动标疑的「疑问数据」：站点用红色中文名标出，这里保持一致
      const doubtBadge = x.doubt ? `<span class="badge doubt" title="上游 AI 标疑：该时段本地区有 ${fmt(x.doubtCount)} 条记录被标记为疑问数据">疑问 ${fmt(x.doubtCount)}</span>` : '';
      // 「未加新」：绑定用户在人生鸟种里没见过这一种（s.liferUser 为空说明没绑定，整块不渲染）。
      // 用青色（不是红/绿）——红已经被「疑问数据」占用，绿在中文语境里是「跌」，都不是好选择。
      const liferBadge = x.lifer
        ? `<span class="badge lifer" title="${esc(state.lifer)} 的人生鸟种里没有这一种">未加新</span>`
        : '';
      const cls = [
        'hot-card is-clickable',
        x.doubt ? 'is-doubt' : '',
        x.lifer ? 'is-lifer' : '',
      ].filter(Boolean).join(' ');
      const nameCls = ' class="cn' + (x.doubt ? ' is-doubt' : '') + (x.lifer ? ' is-lifer' : '') + '"';
      // 卡片可点：点了弹出该鸟种的公开报告明细（点击时才查询，不预取）。
      // role/tabindex 与概览卡保持一致，键盘 Enter / 空格同样可用。
      return `<div class="${cls}" data-taxon-id="${esc(x.taxonId)}" data-taxon-name="${esc(x.name)}" data-lifer="${x.lifer ? '1' : '0'}" role="button" tabindex="0" aria-label="查看「${esc(x.name)}」出现在哪些公开报告">
        <div class="hc-head">
          <span class="rank${rankCls}">${x.rank}</span>
          <span${nameCls}>${esc(x.name)}</span>
        </div>
        <div class="hc-latin">${esc(x.latin || '')}</div>
        <div class="hc-sub">${esc([x.order, x.family].filter(Boolean).join(' · '))}</div>
        <div class="hc-badges">${badges}${liferBadge}${doubtBadge}</div>
        <div class="hc-foot"><span class="n">${fmt(main)}</span><span class="l">${esc(mainLabel)}</span></div>
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
  $('listFoot').innerHTML =
    `<span>本时段共 ${fmt(s.speciesCount ?? s.totalSpecies)} 种鸟 · 已全部展示` +
    (state.filter !== 'all' ? `（筛选：${$('selFilter').selectedOptions[0].textContent}）` : '') +
    `</span>` +
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

async function runQuery() {
  if (firstQuery) showLoading('正在汇总 ' + regionText() + ' 的观鸟数据…');
  firstQuery = false;
  setStatus('busy', '查询中…');

  // 顶部记录检索：鸟种名称需要先解析成 taxon_id；
  // 匹配到多个不同鸟种时先让用户挑，不带着错的条件去查
  const ready = await prepareRecordFilters();
  if (!ready) {
    hideLoading();
    setStatus('', '请选择要查询的鸟种');
    return;
  }

  const where = currentWhere();
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
      API('overview', { ...where, ...nocache }).catch((e) => ({ __error: e.message })),
      // 不传 top：让服务端返回该地区全部鸟种（榜单要完整展示）
      API('hot', { ...where, ...nocache, ...liferNocache, filter: state.filter, sort: state.sort, q: state.q, ensure: 200, liferUser: state.lifer }),
      // 侧栏图表关闭时不请求趋势接口，省一次上游调用
      wantCharts ? API('trend', { ...where, ...nocache }).catch((e) => ({ __error: e.message, months: [] })) : Promise.resolve({ months: [] }),
    ]);

    state.hot = hot;
    state.trend = trend;
    populateTaxonDatalist(hot.list);

    if (!where.province) {
      // 数据源不支持全国级鸟种聚合
      state.overview = null;
      $('overview').innerHTML = '';
      $('protectionPanel').hidden = true;
      $('hotTitle').textContent = '本地稀有鸟种排行 · 全国';
      $('hotList').innerHTML =
        '<div class="notice">数据源不提供全国范围的鸟种排行汇总（查询量过大），请选择具体的省 / 市 / 区县。</div>';
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
      await loadRegionRank(where, nocache);
    }

    setStatus('ok', `已更新 · ${new Date().toLocaleTimeString('zh-CN')}`);
  } catch (e) {
    console.error(e);
    setStatus('err', '查询失败');
    $('hotList').innerHTML = `<div class="notice error">查询失败：${esc(e.message)}</div>`;
  } finally {
    hideLoading();
    // 每次查询后记录当前条件，刷新页面时自动还原
    persist();
  }
}

async function loadRegionRank(where, nocache = {}) {
  const el = $('chartRegionRank');
  try {
    let title = '地区鸟种数排行';
    let list = [];
    if (where.province) {
      const level = where.city ? 'district' : 'city';
      const r = await API('region-rank', { ...where, ...nocache, level });
      list = r.list || [];
      if (list.length) {
        title = r.unit === '区县' ? `${r.unit}鸟种数 · ${where.city || where.province}` : `${where.province} 各地市鸟种数`;
      }
    }
    if (!list.length) {
      const r = await API('province-rank', { ...nocache, version: 'CH4' });
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
 * 物种检索
 * ---------------------------------------------------------------- */
async function searchTaxon() {
  const kw = $('inpTaxon').value.trim();
  const box = $('taxonResult');
  if (!kw) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="hint">检索中…</div>';
  try {
    const r = await API('taxon-search', { q: kw });
    const list = r.data || [];
    if (!list.length) { box.innerHTML = '<div class="notice">未找到匹配的鸟种。</div>'; return; }
    box.innerHTML = list
      .map(
        (t) => `<div class="taxon-card">
        <div class="tc-cn">${esc(t.name)}</div>
        <div class="tc-latin">${esc(t.latin)}</div>
        <div class="tc-meta">${esc(t.order)} · ${esc(t.family)}</div>
        <div class="badges">${levelBadge(t)}${t.chinaEndemic ? '<span class="badge endemic">中国特有</span>' : ''}${iucnBadge(t.iucn)}</div>
      </div>`
      )
      .join('');
  } catch (e) {
    box.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
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
};

async function openDetail(metric, opts = {}) {
  const m = METRICS[metric];
  if (!m) return;
  Object.assign(detail, {
    open: true,
    kind: m.kind,
    metric,
    mode: m.kind === 'taxon' ? 'client' : 'server',
    // 打开瞬间把查询条件定格，之后改地区 / 时间不影响这个已经打开的弹层
    where: { ...currentWhere(), ...(opts.where || {}) },
    rows: [],
    view: [],
    page: 1,
    pages: 1,
    q: '',
    sort: 'record',
    meta: null,
  });

  $('detailModal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('detailTitle').textContent = opts.title || m.title;
  $('detailSub').innerHTML = '';
  $('detailBody').innerHTML = '<div class="detail-loading"><div class="spinner"></div><p>正在读取明细…</p></div>';
  $('dPageInfo').textContent = '';
  $('dSearch').value = '';
  $('dSearch').placeholder = m.kind === 'taxon' ? '筛选中文名 / 学名 / 英文名' : '在本页内筛选观鸟点 / 记录人 / 区县';
  $('dSort').value = 'record';
  $('dSort').hidden = m.kind !== 'taxon';
  $('dPrev').disabled = true;
  $('dNext').disabled = true;

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
      // 顺手把出现过的观鸟点 / 记录人做成顶部输入联想
      populateRecordDatalists(detail.rows);
      applyDetailFilter(false);
    }
  } catch (e) {
    $('detailBody').innerHTML = `<div class="notice error">读取明细失败：${esc(e.message)}</div>`;
    $('dPageInfo').textContent = '';
  }
}

function closeDetail() {
  detail.open = false;
  $('detailModal').hidden = true;
  document.body.style.overflow = '';
}

function applyDetailFilter(resetPage) {
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
    if (detail.metric === 'taxonReports') {
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
  const link = x.url
    ? `<a class="rep-link" href="${esc(x.url)}" target="_blank" rel="noreferrer noopener" title="打开上游报告详情">${esc(x.serialId || '查看报告')} ↗</a>`
    : esc(x.serialId || '—');
  // 按单个鸟种收窄时只留「发现点 / 发现人 / 时间」：一份报告里往往有几十种鸟，
  // 「区县」和「鸟种数」在这个语境下不说明任何问题，反而把表撑宽。
  if (compact) {
    return `<tr class="is-jump" data-url="${esc(x.url || '')}">
      <td class="ta-c num">${no}</td>
      <td class="d-name">${esc(x.pointName || '—')}</td>
      <td data-label="发现人">${esc(x.username || '—')}</td>
      <td class="d-dim" data-label="时间">${esc(span)}</td>
      <td class="d-dim mono">${link}</td>
    </tr>`;
  }
  return `<tr class="is-jump" data-url="${esc(x.url || '')}">
    <td class="ta-c num">${no}</td>
    <td class="d-name">${esc(x.pointName || '—')}</td>
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

  $('selProvince').addEventListener('change', async (e) => {
    state.region.province = e.target.value;
    state.region.city = '';
    state.region.district = '';
    await loadCities();
    runQuery();
  });
  $('selCity').addEventListener('change', async (e) => {
    state.region.city = e.target.value;
    state.region.district = '';
    await loadDistricts();
    runQuery();
  });
  $('selDistrict').addEventListener('change', (e) => {
    state.region.district = e.target.value;
    runQuery();
  });
  // 查询按钮就在「记录检索」这一行，点击时把日期框与检索条件一起提交
  $('btnQuery').addEventListener('click', () => {
    applyTimeState($('inpStart').value, $('inpEnd').value);
    runQuery();
  });
  // 改完日期直接回车也能查
  for (const id of ['inpStart', 'inpEnd']) {
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
  // ---- 报告明细里点一行 → 新窗口打开上游报告详情 ----
  $('detailBody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-url]');
    if (tr && tr.dataset.url) window.open(tr.dataset.url, '_blank', 'noopener');
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
    openTaxonReports(e.target.closest('.hot-card[data-taxon-id]'));
  });
  $('hotList').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
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
    // 「我的」面板在 DOM 里排在明细弹层之后（层级更高），所以先关它
    if (!$('myModal').hidden) {
      closeMy();
      return;
    }
    if (detail.open) closeDetail();
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
  $('btnLiferUnbind').addEventListener('click', () => {
    setLifer('');
    showMyMsg('已取消绑定。');
    // 榜单上的青色标记要跟着撤掉，所以重查一次
    runQuery();
  });
  // 「只看未加新」：等价于把榜单的筛选切成 lifer，然后回到榜单看结果
  $('btnMyShowNew').addEventListener('click', () => {
    state.filter = 'lifer';
    $('selFilter').value = 'lifer';
    closeMy();
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

  $('btnTaxon').addEventListener('click', searchTaxon);
  $('inpTaxon').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchTaxon();
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

  // 把归一化后的条件写回地址栏与本地存储，保证三者一致
  persist();
  runQuery();
})();
