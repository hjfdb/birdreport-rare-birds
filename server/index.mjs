/**
 * 「按地区汇总本地稀有鸟种」服务端
 *   - 对上游（中国观鸟记录中心）做签名、解密、缓存与限流
 *   - 对外提供简洁的 REST 接口
 *   - 同时托管 web/ 下的静态前端
 *
 * 榜单口径：上游 front/record/activity/taxon 按区域返回各鸟种记录数，
 * 本服务按记录数**升序**输出 —— 记录越少说明在本地越稀有，排越前面。
 *
 * 三种数据各取一份、各存一份缓存：
 *   1. 榜单成员 —— 带时间范围（这段时间里出现过哪些鸟）
 *   2. 历史稀有度 —— 不带时间范围（该地区有史以来各鸟种记录数，用于排序）
 *   3. 疑问标记 —— 带时间范围 + outside_type=1（上游 AI 标疑，站点显示为红色）
 *
 * 启动：node server/index.mjs   （可用 PORT / HOST 环境变量覆盖）
 *       或直接双击打包后的 exe（见 build-exe.mjs），会自动打开浏览器
 */
import http from 'node:http';
import path from 'node:path';

import {
  getProvinces,
  getCities,
  getDistricts,
  getRegionTaxons,
  getTaxonNum,
  getReportNum,
  getRecordSummary,
  getTaxonCountBar,
  getReportCountBar,
  getProvinceChart,
  getCityChart,
  getDistrictChart,
  searchTaxons,
  searchRecords,
} from './birdreport.mjs';
import { LayeredCache, DATA_DIR } from './cache.mjs';
import { ensureLevels, levelOf, readCachedLevels, protectionStatus, warmUpAll, flushProtection } from './protection.mjs';
import { IS_SEA, readWebFile, webSourceText, openInBrowser, shouldOpenBrowser } from './runtime.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
/** 端口被占用时最多往后试几个（同一时间开两个实例很常见） */
const PORT_TRIES = Number(process.env.PORT_TRIES || 10);

/* ------------------------------------------------------------------ *
 * 缓存策略（全局唯一实例，所有接口复用）
 *   - TTL 10 分钟
 *   - 落盘到 data/api-cache.json，重启后自动读入内存继续复用
 *   - 同一 key 的并发请求合并为一次上游调用
 * ------------------------------------------------------------------ */
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const CACHE_TTL_TEXT = `${Math.round(CACHE_TTL_MS / 60000)} 分钟`;

/**
 * 榜单（地区鸟种清单）单独用 24 小时 TTL：一天失效一次。
 * 「哪种鸟在本地稀有」这件事变化很慢，而上游那份聚合是慢查询，
 * 没必要跟着 10 分钟的统计接口一起反复回源。
 */
const HOT_TTL_MS = Number(process.env.HOT_TTL_MS || 24 * 60 * 60 * 1000);
/**
 * 「历史稀有度」数据源（该地区**不带时间范围**的鸟种记录数）单独一份缓存。
 * 它是榜单排序的依据，与榜单同节奏：一天失效一次。
 */
const HISTORY_TTL_MS = Number(process.env.HISTORY_TTL_MS || 24 * 60 * 60 * 1000);
/**
 * 「疑问数据」标记（上游 AI 半自动鸟种标疑）单独一份缓存。
 * 它和榜单一样是按「区域 + 时段」聚合的慢查询，同节奏：一天失效一次。
 */
const DOUBT_TTL_MS = Number(process.env.DOUBT_TTL_MS || 24 * 60 * 60 * 1000);
/** 郑四名录（全量鸟种名录）几乎不变，长期缓存复用即可 */
const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MS || 7 * 24 * 60 * 60 * 1000);

const cache = new LayeredCache({
  name: 'api',
  ttl: CACHE_TTL_MS,
  max: 1200,
  file: 'api-cache.json',
  autosaveMs: 3000,
});

const ageText = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
};

/** 有效期文案：榜单是「24 小时」，其余多是「10 分钟」 */
const ttlText = (ms) => {
  if (ms === Infinity) return '永不过期';
  if (ms >= 24 * 60 * 60 * 1000) return `${Math.round(ms / (24 * 60 * 60 * 1000))} 天`;
  if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))} 小时`;
  return `${Math.round(ms / 60000)} 分钟`;
};

/**
 * 统一缓存入口：命中缓存直接复用（含重启后从本地读入的内存缓存），
 * 未命中才请求上游。响应里附带 cache 元信息，便于前端展示复用情况。
 * @param {number} [opts.ttl] 仅本次写入生效的条目有效期，用于「降级结果只短暂缓存」
 */
async function cached(key, loader, force = false, { ttl } = {}) {
  if (force) cache.delete(key);
  const { value, cached: hit, storedAt, ageMs } = await cache.wrap(key, loader, { ttl });
  const ttlMs = ttl ?? CACHE_TTL_MS;
  return {
    value,
    meta: {
      source: hit ? 'cache' : 'upstream',
      hit,
      storedAt,
      ageMs: hit ? ageMs : 0,
      ageText: hit ? ageText(ageMs) : '刚刚更新',
      ttlText: ttlText(ttlMs),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 允许任意来源读取：这样 html/ 下的单文件版用 file:// 双击打开时，
    // 也能直接读本机服务端的接口（浏览器会带上 Origin: null）。
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 托管网页端静态文件。
 * 文件来源由 runtime.mjs 决定：源码方式读磁盘 web/，打包成 exe 后读内嵌资源，
 * 这里只管取内容、判类型、挡目录穿越。
 */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const norm = path.normalize(rel).replace(/^([/\\])+/, '');
  // 归一化之后仍带 .. 段的一律拒绝，exe 形态下这批资源是内嵌的，同样不能放行
  if (!norm || norm.split(/[/\\]/).some((seg) => seg === '..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  const buf = readWebFile(norm);
  if (!buf) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(norm).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

/** 组装上游查询条件 */
function buildWhere(q) {
  const where = {};
  for (const k of ['province', 'city', 'district', 'startTime', 'endTime', 'pointname', 'username', 'taxonid', 'version']) {
    if (q.get(k)) where[k] = q.get(k);
  }
  // 直辖市：区县直接放在 district 上（与站点行为一致）
  if (where.district && where.city) {
    const munis = ['北京市', '天津市', '上海市', '重庆市'];
    if (munis.includes(where.province) && where.city === where.province) delete where.city;
  }
  return where;
}

function whereKey(where, extra = '') {
  return JSON.stringify(where) + '|' + extra;
}

function regionLabel(where) {
  // 直辖市的「市」与「省」同名，标签里只保留一个，避免「北京市 / 北京市」
  const parts = [where.province, where.city === where.province ? '' : where.city, where.district].filter(Boolean);
  return parts.length ? parts.join(' / ') : '全国';
}

/**
 * 只保留行政区条件的 where —— 「历史」口径用。
 * 「历史」= 当前选择的区域 + **不加时间范围**，也不带记录检索条件，
 * 这样得到的记录数才是「这种鸟在该地区整体有多常见」的稳定基線。
 */
function regionOnlyWhere(where) {
  const w = {};
  for (const k of ['province', 'city', 'district']) if (where[k]) w[k] = where[k];
  return w;
}

const LEVEL_ORDER = { 国家一级: 1, 国家二级: 2, 三有: 3 };

/**
 * 容忍单个子接口失败（比如某个统计接口临时异常），
 * 但风控类错误必须冒泡——否则「全 0」的结果会被写进缓存，页面在整个 TTL 内都是空的。
 */
const soft = (p, fallback) =>
  p.catch((e) => {
    if (/code (505|405)/.test(e.message)) throw e;
    return fallback;
  });

/**
 * 辅助统计的等待上限（毫秒）。
 * 概览的 3 个统计接口与趋势接口只影响「概览卡 / 侧栏图表」，榜单才是主要内容；
 * 而上游一旦卡顿，api() 的 25 秒超时 ×2 次重试会把整页查询拖到一分多钟。
 * 所以这里给它们设上限，超时就用兜底值先渲染，页面不会被拖住。
 */
const STAT_TIMEOUT_MS = Number(process.env.STAT_TIMEOUT_MS || 15000);

/** 限时取值：超时返回兜底值（被放弃的请求由 soft 兜住，不会产生未处理拒绝） */
const within = (p, fallback, ms = STAT_TIMEOUT_MS) =>
  Promise.race([
    p,
    new Promise((resolve) => {
      const t = setTimeout(() => {
        console.warn('[api] 辅助统计超过 ' + ms + 'ms 未返回，先用兜底值渲染');
        resolve(fallback);
      }, ms);
      if (t.unref) t.unref();
    }),
  ]);

/** 降级（有子接口没取到）的概览结果只缓存这么久，稍后自动重试 */
const DEGRADED_TTL_MS = Number(process.env.DEGRADED_TTL_MS || 60 * 1000);

/**
 * 概览统计：三个上游接口并行取，单个失败/超时用兜底值。
 * 只要有一个没取到就把 degraded 标出来，交给调用方决定「只短暂缓存」。
 */
async function loadOverview(where) {
  let degraded = false;
  const stat = (p) => {
    const FALLBACK = Object.freeze({});
    return within(soft(p, FALLBACK), FALLBACK).then((v) => {
      if (v === FALLBACK) degraded = true;
      return v;
    });
  };

  const [num, report, summary] = await Promise.all([
    stat(getTaxonNum(where)),
    stat(getReportNum(where)),
    stat(getRecordSummary(where)),
  ]);

  const n = num.data || {};
  const rp = report.data || {};
  const s = summary.data || summary || {};
  return {
    region: regionLabel(where),
    where,
    taxonNum: n.taxon_num ?? 0,
    orderNum: n.taxon_order_num ?? 0,
    familyNum: n.taxon_family_num ?? 0,
    reportNum: rp.report_num ?? 0,
    openReportNum: rp.open_report_num ?? 0,
    privacyReportNum: rp.privacy_report_num ?? 0,
    recordCount: s.record_count ?? 0,
    // 上游把每项计数拆成 _1（主）/ _2（子集，通常为「名录外记录」）两组，
    // 页面未使用该子集，仅原样透出备用
    reportNumSubset: s.report_num_2 ?? 0,
    raw: { taxonNum: n, reportNum: rp, summary: s },
    degraded,
  };
}

/**
 * 地区鸟种清单的上游 loader。
 * 单独抽出来是为了让「榜单」「鸟种明细」「按名解析」共用同一个缓存键
 * whereKey(where,'hot') —— 同一地区只向上游取一次。
 */
const regionSpeciesLoader = (where) => async () => {
  const r = await getRegionTaxons(where, { limit: 2000 });
  return { list: r.data || [], total: r.count ?? (r.data || []).length };
};

/* ------------------------------------------------------------------ *
 * 历史稀有度：该地区「不加时间范围」的各鸟种记录数
 *
 * 为什么需要它：如果只用当前时段的记录数排序，窗口一窄（比如「当天」）几乎所有
 * 鸟种都是 1 条，排序就没有信息量。改成本地区**历史全时段**的记录数来排，
 * 「这种鸟在北京历史上总共只被记录过 3 次」才是真正的稀有信号。
 *
 * 榜单成员仍然只看当前时段：**这段时间里出现过哪些鸟** → 用带时间的查询；
 * **谁更稀有** → 用不带时间的查询。两份数据分开缓存。
 *
 * 实测（2026-10）：北京市不带时间返回 1211 行 / 733 个中文名，4.4 秒；
 * 浙江省 1326 行 / 785 个中文名，3.2 秒。范围内出现的 id 可能同时含 G3 / Z4
 * 两个名录版本，所以按 taxon_id 各自计数，并额外用拉丁名做一层兜底索引。
 * ------------------------------------------------------------------ */

/** 拉丁名归一化：只留字母，便于跨名录版本对齐同一鸟种 */
const latinKey = (s) => String(s ?? '').replace(/[^a-z]/gi, '').toLowerCase();

const historyLoader = (region) => async () => {
  const r = await getRegionTaxons(region, { limit: 2000 });
  const rows = r.data || [];
  const byId = {};
  const byLatin = {};
  for (const t of rows) {
    const n = Number(t.recordcount) || 0;
    const id = Number(t.taxon_id) || 0;
    if (id) byId[id] = (byId[id] || 0) + n;
    const lk = latinKey(t.latinname);
    if (lk) byLatin[lk] = (byLatin[lk] || 0) + n;
  }
  return { byId, byLatin, speciesCount: Object.keys(byId).length, rowCount: rows.length, total: r.count ?? rows.length };
};

/**
 * 取历史稀有度。上游偶发失败（风控 / 范围过大）时**只降级、不缓存**：
 * 返回 error，调用方退回「按本时段记录数排序」，榜单照常可用。
 */
async function loadHistory(where, nocache = false) {
  const region = regionOnlyWhere(where);
  if (!region.province) return { byId: {}, byLatin: {}, speciesCount: 0, meta: null, error: '缺少区域条件' };
  try {
    const { value, meta } = await cached(whereKey(region, 'history'), historyLoader(region), nocache, { ttl: HISTORY_TTL_MS });
    return { ...value, meta, error: '' };
  } catch (e) {
    console.warn('[api] 历史稀有度取不到，本次退回按本时段记录数排序：' + e.message);
    return { byId: {}, byLatin: {}, speciesCount: 0, meta: null, error: e.message };
  }
}

/**
 * 「疑问数据」：上游 AI 半自动鸟种标疑（站点页面上中文名显示成 #FF4040 红色）
 *
 * 上游 front/record/activity/taxon 的 outside_type 是个**记录级筛选**，而不是返回值字段：
 *   - 不传 → 该地区某鸟种的**全部**记录数
 *   - =0  → 其中被判为「正常」的记录数
 *   - =1  → 其中被**标疑**的记录数（即红色那一批）
 * 同一鸟种可以两边都出现 —— 实测北京·珠颈斑鸠「正常 556 条 + 疑问 1 条」，
 * 两边相加恰好等于不传时的总数，说明它是在记录维度上做拆分。
 * 站点页面（home/search/taxon.html 与 home/search/record.html）的渲染规则是
 *   `d.outside_type == 0 ? 中文名 : '<span style="color:#FF4040">中文名</span>'`，
 * 且当返回值里没有该字段时用查询参数兜底，所以「哪些鸟种带红色标记」只能靠这次
 * 额外查询拿到（taxon 接口的返回行里没有 outside_type）。
 *
 * 实测（2026-10）：
 *   福州市 10-09~10-10 → 全部 109 种 = 正常 105 + 疑问 4（白眉鸭 / 流苏鹬 / 鹊鹞 / 黑喉石䳭）
 *   北京市 10-01~10-10 → 全部 285 种 = 正常 255 + 疑问 39
 * 与榜单同节奏：24 小时一份缓存；取不到（风控 / 范围过大）时只降级、不写缓存，
 * 榜单照常输出，只是不带红色标记。
 * ------------------------------------------------------------------ */

const doubtLoader = (where) => async () => {
  const r = await getRegionTaxons({ ...where, outside_type: 1 }, { limit: 2000 });
  const rows = r.data || [];
  const byId = {};
  const byLatin = {};
  for (const t of rows) {
    // 判为疑问的记录数（recordcount），只有 > 0 才是真的带标记
    const n = Number(t.recordcount) || 0;
    if (n <= 0) continue;
    const id = Number(t.taxon_id) || 0;
    if (id) byId[id] = (byId[id] || 0) + n;
    const lk = latinKey(t.latinname);
    if (lk) byLatin[lk] = (byLatin[lk] || 0) + n;
  }
  return {
    byId,
    byLatin,
    speciesCount: Object.keys(byId).length,
    recordSum: Object.values(byId).reduce((s, n) => s + n, 0),
    total: r.count ?? rows.length,
  };
};

/** 取「疑问数据」标记；上游失败时返回空表 + error，榜单照常可用 */
async function loadDoubt(where, nocache = false) {
  try {
    const { value, meta } = await cached(whereKey(where, 'doubt'), doubtLoader(where), nocache, { ttl: DOUBT_TTL_MS });
    return { ...value, meta, error: '' };
  } catch (e) {
    console.warn('[api] 疑问数据标记取不到，本次榜单不带红色标记：' + e.message);
    return { byId: {}, byLatin: {}, speciesCount: 0, recordSum: 0, meta: null, error: e.message };
  }
}

/**
 * 给榜单成员贴上「历史记录数」与「疑问记录数」，并按历史稀有度排序。
 * @returns {{rows: Array, speciesCount: number, matched: number, error: string,
 *            doubtSpeciesCount: number, doubtRecordSum: number, doubtMatched: number, doubtError: string}}
 */
async function rankByHistory(list, where, nocache) {
  // 串行而非并行：两者都是 24 小时才回源一次的慢查询，
  // 串行多花一两秒，但同一地区同时只向上游发一个请求，不容易踩到频次风控。
  const h = await loadHistory(where, nocache);
  const doubt = await loadDoubt(where, nocache);
  let matched = 0;
  let doubtMatched = 0;
  const rows = list.map((x) => {
    let v = h.byId[x.taxonId];
    if (v === undefined) v = h.byLatin[latinKey(x.latin)];
    if (v !== undefined) matched += 1;
    // 疑问记录数：优先按 taxon_id 对上，跨名录版本时退回拉丁名
    let d = doubt.byId[x.taxonId];
    if (d === undefined) d = doubt.byLatin[latinKey(x.latin)];
    const doubtCount = d === undefined ? 0 : d;
    if (doubtCount > 0) doubtMatched += 1;
    return { ...x, historyCount: v === undefined ? null : v, doubtCount, doubt: doubtCount > 0 };
  });
  return {
    rows: rows.sort(byRarity),
    speciesCount: h.speciesCount,
    matched,
    error: h.error,
    doubtSpeciesCount: doubt.speciesCount,
    doubtRecordSum: doubt.recordSum,
    doubtMatched,
    doubtError: doubt.error,
  };
}

/**
 * 「稀有度」排序键：优先用「历史全时段记录数」（该地区不加时间范围），
 * 历史取不到时退回本时段记录数，保证榜单总有可用的顺序。
 */
const rarityKey = (x) => (x.historyCount === null || x.historyCount === undefined ? Number(x.count) || 0 : x.historyCount);

/**
 * 稀有度排序：记录数**升序** —— 记录最少的（在本地最稀有的）排最前。
 * 同记录数时：保护级别高的先露脸，最后按中文名，保证顺序稳定可复现。
 */
const byRarity = (a, b) =>
  rarityKey(a) - rarityKey(b) ||
  (LEVEL_ORDER[a.chinaLevel] || 9) - (LEVEL_ORDER[b.chinaLevel] || 9) ||
  String(a.name || '').localeCompare(String(b.name || ''), 'zh');

/**
 * 取某地区的完整鸟种清单（含保护等级），**按记录数升序**（稀有优先）。
 * 上游数据以 whereKey(where,'hot') 为键缓存，TTL 24 小时（一天失效一次）；
 * 「榜单」与「鸟种明细」共享同一份数据，同一次查询只向上游取一次。
 * @returns {{list: Array, total: number, pending: number, head: Array, meta: object}}
 */
async function loadTaxons(where, { ensure = 160, nocache = false } = {}) {
  const { value: payload, meta } = await cached(
    whereKey(where, 'hot'),
    regionSpeciesLoader(where),
    nocache,
    { ttl: HOT_TTL_MS }
  );

  // 先按记录数升序排一遍：头部即「最稀有的一批」，优先补全它们的保护等级
  const ascending = [...payload.list].sort((a, b) => (Number(a.recordcount) || 0) - (Number(b.recordcount) || 0));
  const headIds = ascending.slice(0, ensure).map((t) => t.taxon_id);
  const restIds = ascending.slice(ensure).map((t) => t.taxon_id);

  await ensureLevels(headIds, { limit: ensure, wait: true });
  if (restIds.length) ensureLevels(restIds, { limit: 300, wait: false });

  const levels = readCachedLevels(headIds);
  const pending = restIds.filter((id) => !readCachedLevels([id])[id]).length;

  const list = ascending
    .map((t) => {
      const lv = levels[t.taxon_id] || {};
      return {
        taxonId: t.taxon_id,
        name: t.taxonname,
        latin: t.latinname,
        english: t.englishname,
        order: t.taxonordername,
        family: t.taxonfamilyname,
        count: Number(t.recordcount) || 0,
        chinaLevel: lv.china_level || '',
        iucn: lv.iucn || '',
        chinaIucn: lv.china_iucn || '',
        chinaEndemic: !!lv.is_china,
        levelKnown: !!lv.china_level || !!lv.iucn,
      };
    })
    .sort(byRarity);

  return {
    list,
    total: payload.total || list.length,
    // 明细口径：卡片数字与下钻明细必须完全一致，故单独给出这两个值
    speciesCount: list.length,
    recordSum: list.reduce((s, x) => s + x.count, 0),
    pending,
    head: list.slice(0, ensure),
    meta,
  };
}

/**
 * 上游报告明细单页上限：limit > 50 会直接返回空。
 * 这里**只取当前这一页**，不再向上游翻页聚合（翻 10 页既慢又容易踩上游风控），
 * 需要更多就由前端翻页，一页一次请求。
 */
const RECORDS_PAGE_SIZE = 50;

/**
 * 上游报告详情页的签名。
 * 站点页面用 `calcMD5(parseParam)` 校验 sign，而它的 md5.js 里 str2blks_MD5 直接读
 * `str.length` / `str.charCodeAt`，传入普通对象时这两个都取不到，等价于对空串求 MD5，
 * 即 sign 与 reportId 无关，恒为 md5('')。经站点实际打开验证有效。
 */
const REPORT_SIGN = 'd41d8cd98f00b204e9800998ecf8427e';

/** 拼上游报告详情页链接：param = Base64(JSON({reportId, ts})) */
function reportUrl(reportId) {
  if (!reportId) return '';
  const param = Buffer.from(JSON.stringify({ reportId, ts: Date.now() }), 'utf8').toString('base64');
  return `https://www.birdreport.cn/home/record/page.html?param=${encodeURIComponent(param)}&sign=${REPORT_SIGN}`;
}

function normalizeRecord(d) {
  const reportId = d.reportId || d.request_id || d.serial_id || '';
  return {
    reportId,
    serialId: d.serial_id || '',
    pointName: d.point_name || '',
    province: d.province_name || '',
    city: d.city_name || '',
    district: d.district_name || '',
    startTime: d.start_time || '',
    endTime: d.end_time || '',
    taxonCount: Number(d.taxoncount) || 0,
    outsideCount: Number(d.outside_count) || 0,
    username: d.username || '',
    state: d.state ?? null,
    url: reportUrl(reportId),
  };
}

/* ------------------------------------------------------------------ *
 * 鸟种名称 → taxon_id（郑四名录）
 *
 * 上游 /front/taxon/search 能一次吐回全部鸟种（3098 行），每行带一个 version 字段
 * （形如 Z4-<hash>）。实测全量只有两个版本族：G3-…（1503 行）与 Z4-…（1595 行），
 * 而榜单数据源 record/activity/taxon 用到的 id **全部**落在 Z4 那一族
 * （灰喜鹊 4721、喜鹊 4734、白头鹎 4866、麻雀 5383 …）。
 * 也就是说「郑四名录」= version 前缀 Z4。
 *
 * 顺带解决了同名歧义：郑四名录里「喜鹊」只有 4734（Pica serica）一条，
 * 不再出现 G3 族里 700（Pica pica）与 4734 打架的情况。
 * 站点下拉框写的 CH4 在上游数据里并不存在，故按偏好顺序挑：CH4 → Z4（当前命中 Z4）。
 *
 * 名录行还带 pinyin / szm（首字母）两个字段，所以除了中文名 / 学名 / 英文名，
 * 也支持「灰喜鹊 / Cyanopica cyanus / huixique / hxq」四种写法。
 * ------------------------------------------------------------------ */

const CATALOG_PREFERENCE = ['CH4', 'Z4'];

/** 归一化：去空格 / 中点 / 括号，统一小写，便于中文名与学名比较 */
const normName = (s) =>
  String(s ?? '')
    .replace(/[\s·．.（）()【】[\]{}－—_/\\,，、]/g, '')
    .toLowerCase();

const shapeSpecies = (t, source) => ({
  id: Number(t.taxon_id ?? t.id) || 0,
  name: t.taxonname ?? t.name ?? '',
  latin: t.latinname ?? t.latin ?? '',
  english: t.englishname ?? t.english ?? '',
  order: t.taxonordername ?? '',
  family: t.taxonfamilyname ?? '',
  count: Number(t.recordcount) || 0,
  source,
});

let catalogPromise = null;
/**
 * 取全量名录并按「郑四」那族过滤。整份名录缓存 7 天，进程内只回源一次。
 * @returns {Promise<{value: object, meta: object}>}
 */
function loadCatalog(force = false) {
  if (force) catalogPromise = null;
  if (!catalogPromise) {
    catalogPromise = cached(
      'catalog:full',
      async () => {
        const r = await searchTaxons({});
        const rows = Array.isArray(r.data) ? r.data : [];
        const dist = new Map();
        for (const t of rows) {
          const p = String(t.version || '').split('-')[0] || '(空)';
          dist.set(p, (dist.get(p) || 0) + 1);
        }
        const prefix =
          CATALOG_PREFERENCE.find((p) => dist.has(p)) ||
          [...dist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ||
          '';
        const picked = rows.filter((t) => String(t.version || '').split('-')[0] === prefix);
        return {
          prefix,
          version: String(picked[0]?.version || ''),
          total: rows.length,
          versions: [...dist.entries()].map(([p, n]) => ({ prefix: p, rows: n })),
          list: picked.map((t) => ({ ...shapeSpecies(t, 'catalog'), pinyin: t.pinyin || '', szm: t.szm || '' })),
        };
      },
      force,
      { ttl: CATALOG_TTL_MS }
    ).catch((e) => {
      catalogPromise = null; // 失败不留残念，下次重新取
      throw e;
    });
  }
  return catalogPromise;
}

/** 按 prefix 记忆化索引；名录本身缓存，索引只在内存里建一次 */
const catalogIndexes = new Map();

function catalogIndexOf(cat) {
  let idx = catalogIndexes.get(cat.prefix);
  if (idx) return idx;
  const push = (map, key, row) => {
    if (!key) return;
    const arr = map.get(key);
    if (arr) arr.push(row);
    else map.set(key, [row]);
  };
  idx = { name: new Map(), latin: new Map(), english: new Map(), pinyin: new Map(), szm: new Map() };
  for (const s of cat.list) {
    push(idx.name, normName(s.name), s);
    push(idx.latin, normName(s.latin), s);
    push(idx.english, String(s.english || '').toLowerCase().replace(/\s+/g, ' '), s);
    push(idx.pinyin, String(s.pinyin || '').toLowerCase(), s);
    push(idx.szm, String(s.szm || '').toLowerCase(), s);
  }
  catalogIndexes.set(cat.prefix, idx);
  return idx;
}

/** 关键词的三种写法：原文小写、去分隔符、首字母用的紧凑形式 */
const keywordForms = (raw) => {
  const lower = String(raw || '').toLowerCase();
  return { lower, compact: lower.replace(/[\s·．.\-_]/g, ''), norm: normName(raw) };
};

/**
 * 在郑四名录里解析一个鸟种名。
 * 逐级降级：中文名精确 → 学名精确 → 英文名精确 → 拼音 → 首字母 → 包含匹配。
 */
async function resolveTaxonName(nameRaw) {
  const raw = String(nameRaw || '').trim();
  const key = normName(raw);
  if (!key) return { name: raw, matched: null, candidates: [], matchType: 'empty' };

  const { value: cat, meta } = await loadCatalog();
  const idx = catalogIndexOf(cat);
  const { lower, compact } = keywordForms(raw);

  const stages = [
    ['exact', idx.name.get(key)],
    ['latin', idx.latin.get(key)],
    ['english', idx.english.get(lower)],
    ['pinyin', idx.pinyin.get(compact)],
    ['szm', idx.szm.get(compact)],
  ];
  let matchType = 'none';
  let matches = [];
  for (const [type, m] of stages) {
    if (m && m.length) {
      matchType = type;
      matches = m;
      break;
    }
  }

  if (!matches.length) {
    // 包含匹配：先只按中文名（更符合直觉），再退到学名 / 拼音 / 首字母
    const hitName = (s) => normName(s.name).includes(key);
    const hitOther = (s) =>
      normName(s.latin).includes(key) ||
      (compact && String(s.pinyin || '').includes(compact)) ||
      (compact && String(s.szm || '').startsWith(compact));
    matches = cat.list.filter(hitName);
    if (matches.length) matchType = 'fuzzy';
    else {
      matches = cat.list.filter(hitOther);
      if (matches.length) matchType = 'fuzzy-alt';
    }
  }

  return {
    name: raw,
    matchType,
    matched: matches[0] || null,
    candidates: matches.slice(0, 12),
    ambiguous: matches.length > 1,
    poolSize: cat.list.length,
    poolSource: 'catalog',
    catalog: {
      name: '郑四名录（《中国鸟类分类与分布名录》第四版）',
      prefix: cat.prefix,
      version: cat.version,
      rows: cat.list.length,
      allRows: cat.total,
      versions: cat.versions,
    },
    cache: meta,
  };
}

/** 关键词检索郑四名录（物种检索区用），命中顺序：精确 → 包含 */
async function searchCatalog(kw) {
  const { value: cat, meta } = await loadCatalog();
  const idx = catalogIndexOf(cat);
  const key = normName(kw);
  const { lower, compact } = keywordForms(kw);
  const out = [];
  const seen = new Set();
  const push = (arr) => {
    for (const s of arr || []) {
      if (out.length >= 20) return;
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
  };
  push(idx.name.get(key));
  push(idx.latin.get(key));
  push(idx.english.get(lower));
  push(idx.pinyin.get(compact));
  push(idx.szm.get(compact));
  if (out.length < 20) {
    push(cat.list.filter((s) => normName(s.name).includes(key)));
    push(cat.list.filter((s) => normName(s.latin).includes(key) || (compact && String(s.pinyin || '').includes(compact))));
  }
  return {
    list: out.slice(0, 20),
    catalog: { name: '郑四名录', prefix: cat.prefix, rows: cat.list.length },
    cache: meta,
  };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const routes = {
  // 省级字典
  async 'GET /api/provinces'() {
    const { value, meta } = await cached('dict:provinces', () => getProvinces());
    return { data: (value.data || []).map((d) => ({ name: d.province_name, code: String(d.province_code) })), cache: meta };
  },

  // 地级字典
  async 'GET /api/cities'(q) {
    const code = q.get('provinceCode');
    if (!code) throw new HttpError(400, '缺少 provinceCode');
    const { value, meta } = await cached('dict:cities:' + code, () => getCities(code));
    return { data: (value.data || []).map((d) => ({ name: d.city_name, code: String(d.city_code) })), cache: meta };
  },

  // 区县字典
  async 'GET /api/districts'(q) {
    const code = q.get('cityCode');
    if (!code) throw new HttpError(400, '缺少 cityCode');
    const { value, meta } = await cached('dict:districts:' + code, () => getDistricts(code));
    return { data: (value.data || []).map((d) => ({ name: d.district_name, code: String(d.district_code) })), cache: meta };
  },

  // 概览统计
  async 'GET /api/overview'(q) {
    const where = buildWhere(q);
    if (!where.province) {
      return { region: '全国', where, unsupported: true, taxonNum: 0, orderNum: 0, familyNum: 0, reportNum: 0, openReportNum: 0, privacyReportNum: 0, recordCount: 0, reportNumSubset: 0, raw: {} };
    }
    const key = whereKey(where, 'overview');
    const { value, meta } = await cached(key, () => loadOverview(where), q.get('nocache') === '1');

    // 有子接口超时/失败时拿到的是兜底值（全 0）。这种结果**不能按正常 TTL 缓存**，
    // 否则页面会在整整 10 分钟里一直显示 0 —— 改成只留一小会儿，稍后自动重试。
    if (value.degraded) {
      const { degraded, ...payload } = value;
      cache.set(key, payload, { ttl: DEGRADED_TTL_MS });
      return {
        ...payload,
        degraded: true,
        cache: { ...meta, ttlText: `${Math.round(DEGRADED_TTL_MS / 1000)} 秒（部分统计未取到，稍后自动重试）` },
      };
    }
    return { ...value, cache: meta };
  },

  // 本地稀有鸟种排行
  //   成员 = 当前时段内出现过的鸟种（带时间的 record/activity/taxon）
  //   排序 = 该地区**历史全时段**的记录数升序（不带时间的查询）
  //   标记 = 当前时段被上游 AI 标疑（outside_type=1，站点显示为红色）的记录
  // 三份口径分开缓存：榜单 24 小时、历史 24 小时、疑问标记 24 小时，互不影响。
  async 'GET /api/hot'(q) {
    const where = buildWhere(q);
    // 上游对全国级别的鸟种聚合查询会超时（500 系统内部异常），这里直接短路
    if (!where.province) {
      return {
        region: '全国',
        where,
        unsupported: true,
        stat: { totalSpecies: 0, speciesCount: 0, recordSum: 0, returned: 0, levelKnownCount: 0, coverage: 0, national1: 0, national2: 0, sanYou: 0, chinaEndemic: 0, threatened: 0, minCount: 0, maxCount: 0, historyUsed: false, historySpeciesCount: 0, historyMatched: 0, historyError: '', doubtCount: 0, doubtRecordSum: 0, doubtSpeciesCount: 0, doubtError: '' },
        pending: 0,
        list: [],
      };
    }
    // top 缺省或 <= 0 表示不截断（榜单需要能一次显示全部鸟种）
    const topRaw = Number(q.get('top'));
    const top = Number.isFinite(topRaw) && topRaw > 0 ? Math.min(topRaw, 2000) : Infinity;
    const filter = q.get('filter') || 'all';
    const sort = q.get('sort') || 'record';
    const keyword = (q.get('q') || '').trim().toLowerCase();
    const ensureLimit = Math.min(Number(q.get('ensure') || 160), 400);
    const nocache = q.get('nocache') === '1';

    // 榜单原始数据与筛选/排序参数解耦：同一个地区只向上游取一次，
    // 切换 Top N、筛选、排序时直接复用缓存，不再重复请求。
    const { list: allTaxons, total: totalSpecies, pending, head, speciesCount, recordSum, meta } = await loadTaxons(where, {
      ensure: ensureLimit,
      nocache,
    });

    // 贴上「历史记录数」并按历史稀有度排序（历史取不到时自动退回本时段记录数）
    const hist = await rankByHistory(allTaxons, where, nocache);
    let list = hist.rows;
    const levelKnownCount = head.filter((x) => x.levelKnown).length;

    if (keyword) list = list.filter((x) => x.name.includes(keyword) || (x.latin || '').toLowerCase().includes(keyword));
    if (filter === 'national') list = list.filter((x) => x.chinaLevel === '国家一级' || x.chinaLevel === '国家二级');
    else if (filter === 'protected') list = list.filter((x) => x.chinaLevel);
    else if (filter === 'chinaEndemic') list = list.filter((x) => x.chinaEndemic);
    else if (filter === 'doubt') list = list.filter((x) => x.doubt);

    // min / max 都取「历史全时段」口径（即排序依据本身）
    const keys = list.map(rarityKey);
    const maxCount = keys.reduce((m, v) => Math.max(m, v), 0) || 1;
    const minCount = keys.reduce((m, v) => Math.min(m, v), Infinity);

    if (sort === 'protection') {
      list.sort((a, b) => {
        const la = LEVEL_ORDER[a.chinaLevel] || 9;
        const lb = LEVEL_ORDER[b.chinaLevel] || 9;
        if (la !== lb) return la - lb;
        return rarityKey(a) - rarityKey(b);
      });
    } else {
      // 稀有优先：历史记录数升序，最少的排最前
      list.sort(byRarity);
    }

    // 稀有度 = 记录越少越接近 1。用对数刻度，否则长尾数据里「1 条」与「5 条」看不出差别。
    const logMax = Math.log(maxCount + 1);
    const rarityOf = (c) =>
      logMax <= 0 ? 1 : +Math.max(0, Math.min(1, 1 - Math.log(Math.max(0, c) + 1) / logMax)).toFixed(4);

    const out = list.slice(0, top).map((x, i) => ({
      ...x,
      rank: i + 1,
      rarity: rarityOf(rarityKey(x)),
    }));

    const stat = {
      totalSpecies,
      // 明细口径：前端「记录鸟种数 / 鸟种记录条数」两张卡直接用这两个值，
      // 以保证点开明细后条数与卡片数字完全对得上
      speciesCount,
      recordSum,
      returned: list.length,
      // 榜单口径：最稀有（历史记录最少）与本地区历史记录最多分别是多少条
      minCount: Number.isFinite(minCount) ? minCount : 0,
      maxCount,
      // 历史稀有度是否真的用上了；取不到时前端会注明「已按本时段记录数排序」
      historyUsed: !!hist.speciesCount && !hist.error,
      historySpeciesCount: hist.speciesCount,
      historyMatched: hist.matched,
      historyError: hist.error,
      levelKnownCount,
      coverage: totalSpecies ? +(levelKnownCount / Math.max(1, Math.min(totalSpecies, ensureLimit))).toFixed(3) : 0,
      national1: list.filter((x) => x.chinaLevel === '国家一级').length,
      national2: list.filter((x) => x.chinaLevel === '国家二级').length,
      sanYou: list.filter((x) => x.chinaLevel === '三有').length,
      chinaEndemic: list.filter((x) => x.chinaEndemic).length,
      threatened: list.filter((x) => ['CR', 'EN', 'VU'].includes(x.iucn)).length,
      // 疑问数据标记：本次榜单单里带红色标记的鸟种数 / 疑问记录条数，
      // 以及该地区-时段上游一共标疑了多少种（含未进榜单的）
      doubtCount: list.filter((x) => x.doubt).length,
      doubtRecordSum: list.reduce((s, x) => s + (x.doubtCount || 0), 0),
      doubtSpeciesCount: hist.doubtSpeciesCount,
      doubtError: hist.doubtError,
    };

    return { region: regionLabel(where), where, stat, pending, list: out, cache: meta };
  },

  // 完整鸟种明细：给「记录鸟种数」下钻用，不受榜单 top / 筛选影响。
  // 成员与榜单一致（当前时段出现过的鸟种），但稀有度同样按
  // 「该地区历史全时段（不加时间范围）的记录数」计算并排序。
  async 'GET /api/taxons'(q) {
    const where = buildWhere(q);
    if (!where.province) return { region: '全国', where, unsupported: true, total: 0, speciesCount: 0, recordSum: 0, doubtCount: 0, doubtRecordSum: 0, doubtSpeciesCount: 0, doubtError: '', list: [] };
    const sort = q.get('sort') || 'record';
    const limit = Math.min(Number(q.get('limit') || 500), 2000);
    const nocache = q.get('nocache') === '1';

    const { list, total, speciesCount, recordSum, pending, meta } = await loadTaxons(where, {
      ensure: Math.min(Number(q.get('ensure') || 300), 400),
      nocache,
    });

    const hist = await rankByHistory(list, where, nocache);
    const rows = [...hist.rows];
    if (sort === 'protection') {
      rows.sort((a, b) => {
        const la = LEVEL_ORDER[a.chinaLevel] || 9;
        const lb = LEVEL_ORDER[b.chinaLevel] || 9;
        if (la !== lb) return la - lb;
        return rarityKey(a) - rarityKey(b);
      });
    } else {
      rows.sort(byRarity); // 与榜单同一口径：历史记录越少越稀有，排前面
    }

    return {
      region: regionLabel(where),
      where,
      total,
      speciesCount,
      recordSum,
      historySpeciesCount: hist.speciesCount,
      historyMatched: hist.matched,
      historyError: hist.error,
      // 疑问数据标记（上游 AI 标疑，红色那一批）
      doubtCount: rows.filter((x) => x.doubt).length,
      doubtRecordSum: rows.reduce((s, x) => s + (x.doubtCount || 0), 0),
      doubtSpeciesCount: hist.doubtSpeciesCount,
      doubtError: hist.doubtError,
      pending,
      list: rows.slice(0, limit).map((x, i) => ({ ...x, rank: i + 1 })),
      cache: meta,
    };
  },

  // 报告 / 记录明细。上游限制：单页 limit > 50 会直接返回空。
  // 这里**只取上游的一页**（默认 50 条），翻页由前端一页一次请求驱动 ——
  // 不再把 10 页一次性抓回来聚合成全量列表（既慢又容易触发上游风控）。
  async 'GET /api/records'(q) {
    const where = buildWhere(q);
    if (!where.province) {
      return { region: '全国', where, unsupported: true, page: 1, limit: RECORDS_PAGE_SIZE, total: 0, totalPages: 1, returned: 0, hasMore: false, list: [] };
    }

    const page = Math.max(1, Math.floor(Number(q.get('page')) || 1));
    const limit = Math.min(Math.max(1, Math.floor(Number(q.get('limit')) || RECORDS_PAGE_SIZE)), RECORDS_PAGE_SIZE);

    const { value, meta } = await cached(
      whereKey(where, `records:${page}:${limit}`),
      async () => {
        const r = await searchRecords(where, { limit, page });
        const seen = new Set();
        const list = [];
        for (const d of Array.isArray(r.data) ? r.data : []) {
          const row = normalizeRecord(d);
          // 上游分页边界偶有重复，页内先去重
          if (row.reportId && seen.has(row.reportId)) continue;
          if (row.reportId) seen.add(row.reportId);
          list.push(row);
        }
        return { list, total: Number(r.count) || list.length };
      },
      q.get('nocache') === '1'
    );

    const total = value.total;
    return {
      region: regionLabel(where),
      where,
      page,
      limit,
      total, // 上游给出的公开报告总数
      totalPages: Math.max(1, Math.ceil(total / limit)),
      returned: value.list.length, // 本页实际取回（页内去重后）
      hasMore: page * limit < total,
      list: value.list,
      cache: meta,
    };
  },

  // 逐月趋势
  async 'GET /api/trend'(q) {
    const where = buildWhere(q);
    if (!where.province) {
      return { region: '全国', where, unsupported: true, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, taxonCount: 0, reportCount: 0 })) };
    }
    const key = whereKey(where, 'trend');
    const { value, meta } = await cached(key, async () => {
      let degraded = false;
      const bar = (p) => {
        const FALLBACK = Object.freeze({ data: [] });
        return within(soft(p, FALLBACK), FALLBACK).then((v) => {
          if (v === FALLBACK) degraded = true;
          return v;
        });
      };
      const [taxon, report] = await Promise.all([bar(getTaxonCountBar(where)), bar(getReportCountBar(where))]);
      const months = Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        taxonCount: 0,
        reportCount: 0,
      }));
      for (const d of taxon.data || []) {
        const m = months[d.taxon_month - 1];
        if (m) m.taxonCount = d.taxon_count ?? 0;
      }
      for (const d of report.data || []) {
        const m = months[d.taxon_month - 1];
        if (m) m.reportCount = d.report_count ?? d.report_num_1 ?? 0;
      }
      return { region: regionLabel(where), where, months, degraded };
    }, q.get('nocache') === '1');
    if (value.degraded) {
      const { degraded, ...payload } = value;
      cache.set(key, payload, { ttl: DEGRADED_TTL_MS }); // 同概览：降级结果只留一小会儿
      return { ...payload, degraded: true, cache: { ...meta, ttlText: `${Math.round(DEGRADED_TTL_MS / 1000)} 秒（趋势未取到，稍后自动重试）` } };
    }
    return { ...value, cache: meta };
  },

  // 全国各省鸟种数排行
  async 'GET /api/province-rank'(q) {
    const version = q.get('version') || 'CH4';
    const { value, meta } = await cached('provinceRank:' + version, async () => {
      const r = await getProvinceChart({ year: '', version });
      const seen = new Map();
      for (const d of r.data || []) {
        if (d.version && d.version !== version) continue;
        seen.set(d.name, Math.max(seen.get(d.name) || 0, d.value ?? 0));
      }
      const list = [...seen.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
      return { version, list };
    });
    return { ...value, cache: meta };
  },

  // 省内下一级地区排行（地市 / 区县）
  async 'GET /api/region-rank'(q) {
    const where = buildWhere(q);
    const level = q.get('level') || 'city';
    const { value, meta } = await cached(whereKey(where, 'regionRank:' + level), async () => {
      const provinceName = where.province;
      if (!provinceName) return { level, unit: '', list: [] };

      const provs = (await cached('dict:provinces', () => getProvinces())).value.data || [];
      const provCode = provs.find((p) => p.province_name === provinceName)?.province_code || '';
      const cities = (await cached('dict:cities:' + provCode, () => getCities(provCode))).value.data || [];
      const MUNI = ['北京市', '天津市', '上海市', '重庆市'];

      let units = [];
      let unit = '地市';
      if (level === 'city' && !MUNI.includes(provinceName)) {
        units = cities.map((c) => c.city_name);
      } else {
        // 区县级：直辖市直接用本市的区县，普通省份用所选地市的区县
        const cityName = MUNI.includes(provinceName) ? provinceName : where.city || cities[0]?.city_name;
        const cityCode = cities.find((c) => c.city_name === cityName)?.city_code || '';
        const districts = (await cached('dict:districts:' + cityCode, () => getDistricts(cityCode))).value.data || [];
        units = districts.map((d) => d.district_name);
        unit = '区县';
      }
      if (!units.length) return { level, unit, list: [] };

      // 上游要求 names = 「上级行政区名 + 本级行政区名」
      const names = units.map((n) => provinceName + n).join(',');
      const r = await getCityChart({ names, year: '', version: 'CH4' });
      const map = new Map();
      for (const d of r.data || []) map.set(d.name, Math.max(map.get(d.name) || 0, d.value ?? 0));
      const list = units
        .map((n) => ({ name: n, value: map.get(n) ?? 0 }))
        .sort((a, b) => b.value - a.value);
      return { level, unit, list };
    }, q.get('nocache') === '1');
    return { ...value, cache: meta };
  },

  // 鸟种名称 → taxon_id（顶部查询栏「鸟种名称」用）。在郑四名录里解析。
  async 'GET /api/taxon-resolve'(q) {
    const name = (q.get('name') || '').trim();
    if (!name) return { name: '', matched: null, candidates: [], matchType: 'empty' };
    return resolveTaxonName(name);
  },

  // 鸟种名录检索（郑四名录，支持中文名 / 学名 / 英文名 / 拼音 / 拼音首字母）
  async 'GET /api/taxon-search'(q) {
    const kw = (q.get('q') || '').trim();
    if (!kw) return { data: [] };
    const { list, catalog, cache: meta } = await searchCatalog(kw);
    const levels = await Promise.all(list.map((t) => levelOf(t.id).catch(() => null)));
    return {
      data: list.map((t, i) => ({
        id: t.id,
        name: t.name,
        latin: t.latin,
        english: t.english,
        pinyin: t.pinyin || '',
        order: t.order,
        family: t.family,
        chinaLevel: levels[i]?.china_level || '',
        iucn: levels[i]?.iucn || '',
        chinaEndemic: !!levels[i]?.is_china,
      })),
      catalog,
      cache: meta,
    };
  },

  // 某鸟种保护等级
  async 'GET /api/taxon-level'(q) {    const id = q.get('id');
    if (!id) throw new HttpError(400, '缺少 id');
    return { data: await levelOf(Number(id)) };
  },

  // 缓存总览：内存条数 / 命中率 / 本地文件 / 上次落盘时间
  async 'GET /api/cache'() {
    return { strategy: { ttlMs: CACHE_TTL_MS, ttlText: CACHE_TTL_TEXT, persist: true, file: 'api-cache.json' }, caches: { api: cache.info(), protection: protectionStatus().cache } };
  },

  // 立即落盘（不等防抖）
  async 'POST /api/cache/flush'() {
    const api = cache.save();
    flushProtection();
    return { flushed: { api, protection: true }, caches: { api: cache.info(), protection: protectionStatus().cache } };
  },

  // 清空缓存（下一次请求会重新回源）
  async 'POST /api/cache/clear'() {
    if (!cache.pending.size) cache.clear();
    return { cleared: true, caches: { api: cache.info(), protection: protectionStatus().cache } };
  },

  // 保护等级字典预热状态
  async 'GET /api/protection/status'() {
    return protectionStatus();
  },

  // 触发全量预热
  async 'POST /api/protection/sync'() {
    if (!protectionStatus().running) warmUpAll();
    return { started: true, ...protectionStatus() };
  },

  async 'GET /api/health'() {
    return {
      ok: true,
      // 用途：双击 exe 时若端口已被占用，靠这个名字判断「是不是本服务已经在跑」
      service: 'birdreport-region-hot',
      mode: IS_SEA ? 'exe' : 'source',
      uptime: process.uptime(),
      dataDir: DATA_DIR,
      web: webSourceText(),
      caches: { api: cache.info(), protection: protectionStatus().cache },
      protection: protectionStatus(),
    };
  },
};

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, url.pathname);
    return;
  }

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) {
    sendJson(res, 404, { error: '接口不存在', path: url.pathname });
    return;
  }

  try {
    const t0 = Date.now();
    const data = await handler(url.searchParams, req);
    sendJson(res, 200, { ...data, elapsedMs: Date.now() - t0 });
  } catch (e) {
    const code = e instanceof HttpError ? e.code : 502;
    console.error(`[api] ${url.pathname} 失败：`, e.message);
    sendJson(res, code, { error: e.message, path: url.pathname });
  }
});

/* ------------------------------------------------------------------ *
 * 启动
 *   1. 端口被占用时不硬报错：先判断是不是「本服务已经开着了」——
 *      是就直接打开浏览器并退出；不是（别的程序占着）就顺延到下一个端口。
 *   2. 跑在 exe 里时启动成功后自动打开系统默认浏览器，双击即可用。
 * ------------------------------------------------------------------ */

/** 在指定端口上起服务，成功返回，被占用抛 EADDRINUSE */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

/** 该端口上是不是已经跑着同一个服务 */
function isSelfRunning(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        body += d;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).service === 'birdreport-region-hot');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function boot() {
  for (let i = 0; i < PORT_TRIES; i += 1) {
    const port = PORT + i;
    try {
      await listenOn(port);
      return port;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;

      if (await isSelfRunning(port)) {
        const url = `http://${HOST}:${port}/`;
        console.log(`\n  本服务已经在 ${url} 上运行着，直接打开浏览器。`);
        console.log(`  （要重启的话，先关掉原来那个窗口 / 进程）\n`);
        if (shouldOpenBrowser()) openInBrowser(url);
        process.exit(0);
      }
      console.warn(`[启动] 端口 ${port} 被别的程序占用，试 ${port + 1}`);
    }
  }
  throw new Error(`${PORT} ~ ${PORT + PORT_TRIES - 1} 之间的端口都被占用了，可用 PORT=xxxx 另指定`);
}

boot()
  .then((port) => {
    const url = `http://${HOST}:${port}/`;
    console.log(`\n  观鸟地区热门榜已启动${IS_SEA ? '（独立 exe 版）' : ''}`);
    console.log(`  ▸ 网页端  ${url}`);
    console.log(`  ▸ 接口    ${url}api/health`);
    console.log(`  ▸ 网页文件 ${webSourceText()}`);
    console.log(`  ▸ 缓存    TTL ${CACHE_TTL_TEXT}，内存已载入 ${cache.size} 条，落盘于 ${path.join(DATA_DIR, 'api-cache.json')}`);
    if (port !== PORT) console.log(`  ▸ 端口    ${PORT} 被占用，本次用的是 ${port}`);
    if (shouldOpenBrowser()) {
      console.log(`  ▸ 正在打开浏览器…`);
      openInBrowser(url);
    } else {
      console.log(`  ▸ 浏览器没自动开（OPEN_BROWSER=1 可强制打开）`);
    }
    console.log('');
  })
  .catch((e) => {
    console.error(`\n  启动失败：${e.message}\n`);
    process.exit(1);
  });

// 定期剔除过期条目，并保证脏数据落盘
const pruneTimer = setInterval(() => {
  cache.prune();
  cache.save();
  flushProtection();
}, 5 * 60 * 1000);
pruneTimer.unref();

// 退出前落盘（缓存 + 保护等级字典）
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    cache.save();
    flushProtection();
    server.close(() => process.exit(0));
  });
}
process.on('exit', () => {
  cache.save();
  flushProtection();
});
