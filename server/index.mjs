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
  searchUserRecords,
  getActivity,
  getActivityTaxons,
  getMemberTimeline,
  getReportTaxonImages,
  getTaxonContent,
} from './birdreport.mjs';
import { LayeredCache, DATA_DIR } from './cache.mjs';
import { ensureLevels, levelOf, readCachedLevels, protectionStatus, warmUpAll, flushProtection } from './protection.mjs';
import { IS_SEA, readWebFile, webSourceText, openInBrowser, shouldOpenBrowser } from './runtime.mjs';
import { createWatch, pickConditions } from './watch.mjs';
import { createUpdater } from './update.mjs';
import { appVersion, platformLabel } from './version.mjs';

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
 * 「历史稀有度」数据源（该地区**最近两年**的鸟种记录数）单独一份缓存。
 * 口径固定（锚在去年 1 月 1 日）、数据变化很慢，所以缓存一个月：
 * 一个月内所有请求都命中本地，不再向上游发这份慢查询。
 */
const HISTORY_TTL_MS = Number(process.env.HISTORY_TTL_MS || 30 * 24 * 60 * 60 * 1000);
/**
 * 全国口径的历史稀有度查询要单独放宽上游超时。
 * 省份口径通常 1~2 秒，全国口径实测 20 秒（1495 种 / 1129 万条），
 * 贴着 api() 默认的 25 秒上限 —— 余量太小，一旦超时就会降级成
 * 「按本时段记录数排序」，榜单口径会静默改变。这里给足 90 秒。
 * （省份口径仍用默认 25 秒，不让原本该快速失败的请求被拖长）
 */
const HISTORY_NATIONAL_TIMEOUT_MS = Number(process.env.HISTORY_NATIONAL_TIMEOUT_MS || 90 * 1000);
/**
 * 行政区字典（省 / 市 / 区县三级）缓存一个月：区划码是静态参考数据，基本不变。
 * 跟着 10 分钟的统计缓存反复回源没有意义 —— 上游偶发 500 时，它还会把首次
 * 打开直接卡在「无法连接服务端」（拿不到省份列表就没法初始化）。
 */
const DICT_TTL_MS = Number(process.env.DICT_TTL_MS || 30 * 24 * 60 * 60 * 1000);
/**
 * 「疑问数据」标记（上游 AI 半自动鸟种标疑）单独一份缓存。
 * 它和榜单一样是按「区域 + 时段」聚合的慢查询，同节奏：一天失效一次。
 */
const DOUBT_TTL_MS = Number(process.env.DOUBT_TTL_MS || 24 * 60 * 60 * 1000);
/**
 * 「绑定用户的人生鸟种」单独一份缓存。
 *
 * 这是「未加新」比对的基准：把某个用户**有史以来记录过的所有鸟种**取回来，
 * 榜单里不在这个集合里的，就是对 TA 来说还没加新的鸟。
 *
 * 之所以能与其它缓存同节奏（一天失效一次）：加新是件很慢的事，一天里多认一两种鸟
 * 已经算高产；而这份数据一次请求就能取全（见 lifelistLoader 的说明）。
 */
const LIFELIST_TTL_MS = Number(process.env.LIFELIST_TTL_MS || 24 * 60 * 60 * 1000);
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

/** 行政区字典（省 / 市 / 区县）专用的缓存封装：统一一个月 TTL，不接受外部强刷 */
const dictCached = (key, loader) => cached(key, loader, false, { ttl: DICT_TTL_MS });

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 允许任意来源读取：页面若用 file:// 双击打开（浏览器会带上 Origin: null），
    // 也能直接读本机服务端的接口。
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
  for (const k of ['province', 'city', 'district', 'startTime', 'endTime', 'pointname', 'username', 'taxonid', 'mode', 'version']) {
    if (q.get(k)) where[k] = q.get(k);
  }
  // mode 是上游的**整条查询**匹配方式：0 或省略 = 模糊，1 = 精确。
  // 它同时作用于 pointname / username，所以只允许这两个取值，别的值一律丢掉，
  // 免得前端传个 mode=2 让上游按未定义行为处理。
  if (where.mode !== undefined) {
    where.mode = String(where.mode) === '1' ? 1 : 0;
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
 * 监听条件的人类可读标签 —— 系统通知的正文、历史记录里都要用它。
 * 页面自己知道「观测地点 / 记录人 / 鸟种」的显示名，所以它会传一个更完整的 label 过来；
 * 这里只是没传时的兜底（鸟种在条件里只有 id，看不出是什么鸟）。
 */
function watchLabel(where) {
  const date = !where.startTime
    ? '全部时间'
    : where.endTime && where.endTime !== where.startTime
      ? `${where.startTime.slice(5)} ~ ${where.endTime.slice(5)}`
      : where.startTime.slice(5);
  return `${regionLabel(where)} · ${date}`;
}

/**
 * 「全国」范围的门槛：**必须同时给起止两个日期**。
 *
 * 上游对不带省份的聚合查询其实是接受的 —— 当年「数据源不提供全国范围」的判断是错的，
 * 真实原因是那几次撞上了 505 风控（与本轮探针的复核一致）。但代价确实随窗口急剧膨胀
 * （2026-10 实测，均为 limit=2000）：
 *   全国 · 单日        →  622 种 /     0.8 万条
 *   全国 · 一周        → 1091 种 /    17.5 万条
 *   全国 · 一个月      → 1256 种 /    62.7 万条
 *   全国 · 不带时间    → 2932 种（limit 已截断）/ 1358 万条 ← 就是用户说的「数据量太大」
 * 而且榜单排序依赖的「最近两年」基线在无省份时更重（实测 1495 种 / 1129 万条 / 20 秒）。
 *
 * 所以无省份时起止日期必须**同时**给，否则一律短路、不做无谓的上游调用。
 * 有 province 时不受此限 —— 时间可任意留空的原有行为完全不变。
 */
function nationalNeedsRange(where) {
  return !where.province && !(where.startTime && where.endTime);
}

/**
 * 只保留行政区条件的 where —— 「历史」口径用。
 * 「历史」= 当前选择的区域 + 固定的「最近两年」窗口（时间由 loadHistory 自己加，
 * 不再来自用户选的时间），也不带记录检索条件 ——
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
const within = (p, fallback, ms = STAT_TIMEOUT_MS) => {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn('[api] 辅助统计超过 ' + ms + 'ms 未返回，先用兜底值渲染');
      resolve(fallback);
    }, ms);
    if (timer.unref) timer.unref();
  });
  // 必须在 race 结束时清掉定时器：否则即使 p 早已正常返回、页面拿到的就是真实值，
  // 这个定时器 15 秒后照样会触发并打出一条**假的「超时」警告**。
  // （实测：冷启动时 3 个统计接口 3 秒就返回了真实值，看板数字完全正确，
  //  控制台却出现 3 条超时警告。unref() 只是不阻止进程退出，并不取消定时器。）
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

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
 * 历史稀有度：该地区**最近两年**（去年 1 月 1 日起至今）的各鸟种记录数
 *
 * 为什么需要它：如果只用当前时段的记录数排序，窗口一窄（比如「当天」）几乎所有
 * 鸟种都是 1 条，排序就没有信息量。改用**最近两年**的记录数来排，
 * 「这种鸟在北京这两年总共只被记录过 3 次」才是真正的稀有信号。
 *
 * 为什么是「最近两年」而不是全时段：全时段在大地区上是很重的聚合
 * （北京经常要 20 秒以上、还时不时 500），两年窗口既有足够的统计量、
 * 上游也更扛得住；口径固定（锚在去年 1 月 1 日）配合**一个月的缓存**，
 * 一个地区一年里基本只回源十几次。
 *
 * 榜单成员仍然只看当前时段：**这段时间里出现过哪些鸟** → 用带时间的查询；
 * **谁更稀有** → 用这个两年窗口的查询。两份数据分开缓存。
 *
 * 实测（2026-10，北京市）：2025-01-01 ~ 今天 返回 570 行 / 570 个中文名，
 * 约 16 秒（偶发首次 500、重试即过）；常见鸟的两年记录数约为全时段的六成
 * （灰喜鹊 39051 vs 65708），口径内部一致。范围内出现的 id 可能同时含
 * G3 / Z4 两个名录版本，所以按 taxon_id 各自计数，并额外用拉丁名做兜底索引。
 * ------------------------------------------------------------------ */

/** 拉丁名归一化：只留字母，便于跨名录版本对齐同一鸟种 */
const latinKey = (s) => String(s ?? '').replace(/[^a-z]/gi, '').toLowerCase();

/**
 * 「最近两年」的起点：去年 1 月 1 日（2026 年 → 2025-01-01）。
 * 它同时进缓存键：跨年时起点变化，旧缓存自然不再命中，不会把上一年的
 * 窗口当成新窗口继续用。
 */
function historyWindowStart(now = new Date()) {
  return `${now.getFullYear() - 1}-01-01`;
}

/** 本地时区的今天（YYYY-MM-DD） —— 别用 toISOString，那是 UTC，凌晨会差一天 */
function todayYmd(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const historyLoader = (region, startTime, endTime) => async () => {
  // 这条查询又慢又偶发 500：回源时把实际请求参数、返回行数与耗时都打进日志，便于排障 / 对账。
  // 参数与服务端最终发给上游的完全一致（直辖市在这里已经是「只有 province」的形态）。
  const where = { ...region, startTime, endTime };
  // 全国口径（无 province）实测要 20 秒，单独放宽超时；省份口径沿用默认
  const timeout = region.province ? undefined : HISTORY_NATIONAL_TIMEOUT_MS;
  const t0 = Date.now();
  console.log(`[api] 历史稀有度回源：${JSON.stringify(where)}（page=1 limit=2000${timeout ? ` timeout=${timeout}ms` : ''}）`);
  const r = await getRegionTaxons(where, { limit: 2000, timeout });
  const rows = r.data || [];
  console.log(`[api] 历史稀有度取回：${rows.length} 行 / count=${r.count ?? '?'}，耗时 ${Date.now() - t0}ms`);
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
 * 取历史稀有度。
 *
 * ⚠ 这份缓存是**强制的**：`nocache` 等外部参数一律打不进来 —— 口径固定、变化慢，
 * 只按一个月的有效期自然过期（跨年自动换键）。唯一会提前回源的是它自己失败后的
 * 重试；仍失败就留一个**短命的失败标记**（这一小段时间里所有请求直接降级、
 * 不再重复打这条慢查询），标记到期后自动再试。
 */
async function loadHistory(where) {
  const region = regionOnlyWhere(where);
  // region 可以为空 = 全国口径（实测 2025-01-01~今天：1495 种 / 1129 万条 / 20 秒，能过）。
  // 调用方（/api/hot、/api/taxons）已用 nationalNeedsRange 挡住「全国 + 无时间」的情况，
  // 所以到这里 national 一定带了起止日期，不会退化成无限制的全表聚合。
  // 窗口 = 去年 1 月 1 日 ~ 今天（"最近两年"）。起点进缓存键、跨年自动换键；
  // 结束时间是取数当天的日期，但**不进键** —— 否则每天一个新键，等于天天回源。
  const startTime = historyWindowStart();
  const endTime = todayYmd();
  const key = whereKey(region, `history:${startTime}`);
  const loader = historyLoader(region, startTime, endTime);
  // 强制走缓存（force 恒为 false）：命中就用、过期才回源；nocache 不参与
  const read = () => cached(key, loader, false, { ttl: HISTORY_TTL_MS });
  // 缓存条目 → 返回值。「失败标记」不能当有效数据，要如常降级
  const fromEntry = ({ value, meta }) =>
    value.failed
      ? { byId: {}, byLatin: {}, speciesCount: 0, meta, error: value.failed }
      : { ...value, meta, error: '' };
  try {
    const r = await read();
    if (r.value.failed) {
      console.warn(`[api] 历史稀有度命中失败标记（${Math.round(DEGRADED_TTL_MS / 60000)} 分钟内不再回源）：${JSON.stringify({ ...region, startTime, endTime })}`);
    }
    return fromEntry(r);
  } catch (e) {
    // 上游对宽窗口偶发 500（实测很常见），补一次重试 —— api() 对 500 是立即失败，
    // 重试只能在这一层做。多数情况下第二次就过；过了就能按一个月缓存住。
    // 重试不强删缓存：并发时若另一个请求刚好把结果写进去，这里直接命中它的结果。
    console.warn(`[api] 历史稀有度本次回源失败（请求参数见上方日志），补一次重试：` + e.message);
    try {
      return fromEntry(await read());
    } catch (e2) {
      cache.set(key, { byId: {}, byLatin: {}, speciesCount: 0, rowCount: 0, total: 0, failed: e2.message }, { ttl: DEGRADED_TTL_MS });
      console.warn('[api] 历史稀有度取不到（重试后仍失败），本次退回按本时段记录数排序：' + e2.message);
      return { byId: {}, byLatin: {}, speciesCount: 0, meta: null, error: e2.message };
    }
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

/** 郑四名录的 id / 拉丁名索引（记忆化，名录本身有 7 天缓存；人生鸟种列表补名字 / 目科用） */
let catalogLookupMemo = null;
async function catalogLookup() {
  const { value: cat } = await loadCatalog();
  if (catalogLookupMemo && catalogLookupMemo.prefix === cat.prefix) return catalogLookupMemo;
  const byId = new Map();
  const byLatin = new Map();
  for (const s of cat.list) {
    if (s.id) byId.set(Number(s.id), s);
    const lk = latinKey(s.latin);
    if (lk && !byLatin.has(lk)) byLatin.set(lk, s);
  }
  catalogLookupMemo = { prefix: cat.prefix, byId, byLatin };
  return catalogLookupMemo;
}

/* ------------------------------------------------------------------ *
 * 绑定用户的「人生鸟种」—— 「未加新」比对的基准
 *
 * 语义：把某个观鸟用户**有史以来记录过的全部鸟种**取回来，榜单里不在这个集合里的
 * 鸟种，就是对 TA 来说**还没加新**的（「加新」= 见到人生第一种该鸟种）。
 *
 * 取数只用**一次**上游请求，关键在这里：
 *   getRegionTaxons({ username: X, mode: 1 })   ← 不带 province、不带时间，**带 mode=1**
 *
 * ▸ 为什么必须带 mode=1（精确）—— 这是本功能最容易静默出错的地方：
 *   上游的 `mode` 是**整条查询**的匹配方式（省略或 0 = 模糊，1 = 精确）。
 *   实测（2026-10，用户 kkia）：
 *     不传 mode（模糊）→ 229 行 / 229 种
 *     mode=1  （精确）→ 212 行 / 212 种   ← 真身
 *   精确结果是模糊结果的**真子集**（已验证），多出来的那 17 种（毛脚燕、赤麻鸭、灰斑鸠、
 *   普通雨燕、红嘴鸥…）来自**别的用户名** —— 名字里含 "kkia" 子串的人。
 *   也就是说：不指定 mode 时，绑定「kkia」会把邻居的鸟种也算成「已加新」，
 *   凭空少报一批未加新，而页面看上去一切正常。
 *
 * ▸ 一次请求就够，不需要遍历 34 个省：
 *     - 全国一次查（mode=1）        → 212 种
 *     - 逐个省份查完再并集（34 次）  → 212 种，差集 0
 *     - 分页核对（limit=200）        → 200 + 12 = 212，没有隐藏上限
 *   注意不要和「不带 username 的全国查询」搞混：那种查询上游会 500（结果集是全国所有鸟种）；
 *   带上 username 之后结果集只有一两百行，上游处理得很好。
 *
 * 匹配方式与历史稀有度 / 疑问标记保持一致：先按 taxon_id 对，对不上退回拉丁名
 * （同一鸟种在不同名录版本下 id 不同，拉丁名才是稳定的）。判定方向取**并集** ——
 * id 或拉丁名任一命中就算「已加新」，宁可漏报也不能把没见过的种说成见过。
 *
 * ⚠ 返回的 byId 是**郑四名录的 id**，不是上游原样给的 id —— 上游会把同一只鸟按
 * 新旧两套分类各返回一行（见 makeZ4Resolver 的实测记录），不归位的话种数会近乎翻倍。
 * ------------------------------------------------------------------ */

/** 上游返回行数的上限：郑四全国名录约 1500 种，一个人不可能超过它，3000 很宽松 */
const LIFELIST_LIMIT = 3000;

const lifelistLoader = (user) => async () => {
  // version:'CH4' = 只要郑四分类（见上面的实测对照）。少了它就会新旧两套各回一行、种数翻倍。
  // mode:1 = 精确匹配用户名，不同一个人的名字里含同一个子串就把他算进来。
  const r = await getRegionTaxons({ username: user, mode: 1, version: 'CH4' }, { limit: LIFELIST_LIMIT });
  const rows = r.data || [];
  // CH4 已保证 id 是郑四的，resolve 只是**兜底**：万一上游哪天回了个本地名录里没有的 id，
  // 还能按拉丁名找回郑四种，实在找不回就如实报成「名录外」，不硬塞。
  const resolve = await makeZ4Resolver();

  const byId = {}; // 郑四 id → 记录条数（两套分类的行会累加到同一只鸟上）
  const byLatin = {}; // 拉丁名（郑四写法 + 上游写法都收）→ 记录条数
  const nameById = {}; // 郑四 id → {name, latin}，名字一律取郑四的写法
  const altNamesById = {}; // 郑四 id → 上游出现过的别的写法（旧名），给「加新时间」按名匹配兜底
  const offByName = {}; // 郑四名录里没有的种：中文名 → {name, latin, count}

  const add = (map, key, n) => {
    if (key) map[key] = (map[key] || 0) + n;
  };

  for (const t of rows) {
    const n = Number(t.recordcount) || 0;
    if (n <= 0) continue;
    const z4 = resolve(t);
    if (z4) {
      add(byId, z4.id, n);
      nameById[z4.id] = { name: z4.name, latin: z4.latin };
      add(byLatin, latinKey(z4.latin), n);
      add(byLatin, latinKey(t.latinname), n); // 上游写法（可能是旧名）也登记，比对按并集
      const up = String(t.taxonname || '').trim();
      if (up && up !== z4.name) {
        const list = altNamesById[z4.id] || (altNamesById[z4.id] = []);
        if (!list.includes(up)) list.push(up);
      }
    } else {
      // 郑四名录里没有（迷鸟、异名、名录未收录）：单独统计，不硬塞进某个科
      const name = String(t.taxonname || '').trim() || `#${t.taxon_id}`;
      const rec = offByName[name] || (offByName[name] = { name, latin: String(t.latinname || ''), count: 0 });
      rec.count += n;
    }
  }

  const speciesCount = Object.keys(byId).length;
  const offCatalog = Object.values(offByName).sort((a, b) => b.count - a.count);
  return {
    user,
    byId,
    byLatin,
    nameById,
    altNamesById,
    offCatalog,
    // 种数按郑四算（这才是「我见过多少种鸟」的真身）；名录外的另计，前端如实分开展示
    speciesCount,
    offCatalogCount: offCatalog.length,
    recordSum: Object.values(byId).reduce((s, n) => s + n, 0) + offCatalog.reduce((s, x) => s + x.count, 0),
    rowCount: rows.length,
    // ⚠ 不能拿上游的 count 判断截断：count 不认 mode —— kkia 传 mode=1 只回 212 行，
    // count 却仍报模糊口径的 229，`count > rows.length` 必然成立、必然误报。
    // 真正的截断信号只有一个：行数把 limit 取满了（说明后面还有）。
    truncated: rows.length >= LIFELIST_LIMIT,
    // 上游自报的总数，**口径是模糊的**，只作参考，绝不能当种数用
    upstreamCount: Number(r.count) || 0,
  };
};

/**
 * 取某个用户的人生鸟种。
 * 上游失败时返回 null（而不是抛错）—— 「未加新」只是个附加标记，
 * 拿不到就整页照常显示，不能因为一个标记把榜单打挂。
 *
 * 缓存键里的 `uN` 是**口径版本号**，不是装饰。改过三次，前两次都是「页面看着正常、数字是错的」：
 *   u1 → u2：最初没传 mode，上游按模糊匹配返回，kkia 拿到 229 种；加 mode=1 后才是真的 212 种。
 *   u2 → u3：上游对同一只鸟按新旧两套分类各返回一行，种数近乎翻倍
 *            （福州老兵 2048 行 → 只有 1288 种）；现在按郑四归位。
 *   u3 → u4：截断判定改成看「行数是否取满 limit」（上游 count 不认 mode，必然误报）。
 *   u4 → u5：改用上游的 `version:'CH4'` 直接取郑四那一套（福州老兵 2000 种 → 1068 种），
 *            不再靠拉丁名猜着归位。
 * 每次都是「口径变了但缓存键没变，旧结果在 24 小时 TTL 里被继续当作新结果用」。
 * 以后再改这份缓存对象的**形状或语义**（字段、匹配方式、名录口径），就把版本号 +1 ——
 * 宁可多回源一次，也不要让旧对象被当成新对象读。
 */
const LIFELIST_KEY_VERSION = 'u5';
async function loadLifelist(user, nocache = false) {
  if (!user) return null;
  try {
    const { value, meta } = await cached(
      `lifelist|${LIFELIST_KEY_VERSION}|${user}`,
      lifelistLoader(user),
      nocache,
      { ttl: LIFELIST_TTL_MS }
    );
    if (value.truncated) {
      console.warn(
        `[api] 用户「${user}」的名单被截断：取满上限 ${LIFELIST_LIMIT} 行还有余（上游自报 ${value.upstreamCount}，仅供参考）—— 种数会少算，需要抬高 LIFELIST_LIMIT`
      );
    }
    return { ...value, meta, error: '' };
  } catch (e) {
    console.warn(`[api] 用户「${user}」的人生鸟种取不到，本次不做未加新比对：` + e.message);
    return null;
  }
}

/** 昨天的日期（YYYY-MM-DD，按本地时区算）—— 「今天新来了」的对比基准用 */
function prevDayOf(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 「今天新来了」的对比基准：昨天（同一地区 + 同一检索条件）出现过的鸟种集合。
 * 只在单日查询时使用；每天每组合最多回源一次（HOT_TTL 缓存），失败留 60 秒标记
 * 防止反复重打。拿不到就返回 null —— 只影响「新」角标，绝不影响榜单本身。
 */
async function loadPrevDaySpecies(where, nocache) {
  if (!where.startTime || where.startTime !== where.endTime) return null;
  const day = prevDayOf(where.startTime);
  const prevWhere = { ...where, startTime: day, endTime: day };
  const key = whereKey(prevWhere, 'hot-prev');
  try {
    const { value } = await cached(key, regionSpeciesLoader(prevWhere), nocache, { ttl: HOT_TTL_MS });
    if (value.failed) return null;
    const ids = new Set();
    const latins = new Set();
    for (const t of value.list) {
      const id = Number(t.taxon_id) || 0;
      if (id) ids.add(id);
      const lk = latinKey(t.latinname);
      if (lk) latins.add(lk);
    }
    return { known: (x) => ids.has(Number(x.taxonId)) || latins.has(latinKey(x.latin)) };
  } catch (e) {
    cache.set(key, { list: [], total: 0, failed: e.message }, { ttl: DEGRADED_TTL_MS });
    console.warn('[api] 昨日清单取不到（本次不打「新」角标）：' + e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 「按郑四分类取数」—— version=CH4
 *
 * 上游 `front/record/activity/taxon` 支持一个 `version` 参数，官网查询页发的是
 * `"version":"CH4"` —— **CH4 就是郑四分类**，带上它上游只回郑四那一套。
 *
 * 不带 version 会怎样（踩过的坑）：
 *   只给 username（不给 province / 时间）时，上游会把同一只鸟**按新旧两套分类各回一行**。
 *   实测（2026-10-14，用户「福州老兵」）：
 *     2048 行 / 2048 个 taxon_id，却只有 **1288 个不同的拉丁名**
 *     → 760 只鸟各占两行：白冠燕尾(id1214) vs 白额燕尾(id5279)、
 *       灰伯劳(id658) vs 西灰伯劳(id4715)、旋木雀(id1107) vs 欧亚旋木雀(id5137)…
 *     即旧名录的小 id（< 4000）与郑四的大 id（4000+）各来一遍，行里没有 version 字段。
 *   后果：种数近乎翻倍（「我的 · 总鸟种数」显示 2000 种，而中国全部鸟种也就 1500 左右）。
 *
 * 加上 `version:'CH4'` 之后（同一用户，实测对照）：
 *     mode=1                     → 2048 行 / 35435 条   ← 错的
 *     mode=1 + version=CH4       → 1068 行 / 15978 条
 *     + outside_type=0（正常）    → 1066 行 / 15963 条   ← 官网查询页显示的就是这个数
 *     + outside_type=1（疑问）    →    8 行 /    15 条   ← 官网「疑问」显示的就是这个数
 *   而且 CH4 结果的 taxon_id **全部落在郑四段（4001~5515）且互不重复**，
 *   所以「按拉丁名把旧名行归位」那套猜测整个可以退休了 —— 上游本来就支持直接指定名录。
 *
 * 三个口径的换算关系（1066 / 8 / 1068）：
 *   outside_type=0 的种 ∩ outside_type=1 的种 = 6 种（这些种既有正常记录也有疑问记录）
 *   → 单看正常记录 1066 种、单看疑问记录 8 种，**并集**（不带 outside_type）1068 种。
 *   本项目取并集当「总鸟种数」（这才是「我见过多少种鸟」），其中 8 种挂疑问标记。
 *
 * outside_type 语义：0 = 没问题的数据，1 = 有疑问的数据（上游/审核标疑）。
 * ------------------------------------------------------------------ */

/** 建「上游行 → 郑四种」的归位函数（郑四名录本身有 7 天缓存，这里只建一次索引） */
async function makeZ4Resolver() {
  const { value: cat } = await loadCatalog();
  const byId = new Map();
  const byLatin = new Map();
  for (const s of cat.list) {
    if (s.id) byId.set(s.id, s);
    const lk = latinKey(s.latin);
    if (lk && !byLatin.has(lk)) byLatin.set(lk, s);
  }
  return (t) => {
    const id = Number(t.taxon_id) || 0;
    const lk = latinKey(t.latinname);
    return (id && byId.get(id)) || (lk && byLatin.get(lk)) || null;
  };
}

/**
 * 某个用户名下**被上游标疑**（outside_type=1）的鸟种 → 疑问记录条数。
 * 「我的人生鸟种」列表里给这些种标红用；和名单同节奏缓存 24 小时
 * （每个用户每天最多多查这一次），失败留 60 秒标记防重打。
 * 同样要按郑四归位，否则旧名那一行的标疑数会挂在名单里不存在的 id 上而丢标。
 */
const lifelistDoubtLoader = (user) => async () => {
  // outside_type:1 = 上游标疑的数据；version 必须和主名单同口径，否则标疑的 id 会挂在不存在的种上
  const r = await getRegionTaxons(
    { username: user, mode: 1, version: 'CH4', outside_type: 1 },
    { limit: LIFELIST_LIMIT }
  );
  const resolve = await makeZ4Resolver();
  const byId = {};
  const offByLatin = {};
  for (const t of r.data || []) {
    const n = Number(t.recordcount) || 0;
    if (n <= 0) continue;
    const z4 = resolve(t);
    if (z4) byId[z4.id] = (byId[z4.id] || 0) + n;
    else {
      const lk = latinKey(t.latinname);
      if (lk) offByLatin[lk] = (offByLatin[lk] || 0) + n;
    }
  }
  return { byId, offByLatin, speciesCount: Object.keys(byId).length };
};
async function loadLifelistDoubt(user, nocache = false) {
  // u3：标疑清单也加 version=CH4（u2 是按拉丁名归位、u1 是未归位的旧口径）
  const key = `lifelist-doubt|u3|${user}`;
  try {
    const { value } = await cached(key, lifelistDoubtLoader(user), nocache, { ttl: LIFELIST_TTL_MS });
    if (value.failed) return null;
    return value;
  } catch (e) {
    cache.set(key, { byId: {}, speciesCount: 0, failed: e.message }, { ttl: DEGRADED_TTL_MS });
    console.warn(`[api] 用户「${user}」的疑问标记取不到（列表里不标红）：` + e.message);
    return null;
  }
}

/**
 * 「加新时间」：上游的用户加新时间线（front/record/year/taxon/member/timeline）。
 * 每行 = 一个加新时间点 + 「鸟名[省 市 区县]」，取每种最早出现的时刻当加新日期。
 * ⚠ 该接口只覆盖**今年**（year / startTime / start_time 参数实测全被忽略），
 * 更早的年份拿不到日期 —— 有就附上、没有就不伪造。缓存与人生名册同节奏（24 小时）。
 */
const lifelistDatesLoader = (memberId) => async () => {
  const r = await getMemberTimeline(memberId);
  const byName = {};
  for (const e of r.data || []) {
    const t = String(e.start_time || '').slice(0, 10);
    if (!t) continue;
    for (const raw of String(e.taxon_names || '').split(',')) {
      const m = raw.trim().match(/^(.+?)\s*\[(.+?)\]\s*$/);
      const name = normName(m ? m[1] : raw);
      if (!name) continue;
      const prev = byName[name];
      if (!prev || t < prev.time) byName[name] = { time: t, place: m ? m[2].trim() : '' };
    }
  }
  return { byName };
};
async function loadLifelistDates(memberId, nocache = false) {
  const key = `lifelist-dates|u1|${memberId}`;
  try {
    const { value } = await cached(key, lifelistDatesLoader(memberId), nocache, { ttl: LIFELIST_TTL_MS });
    if (value.failed) return null;
    return value;
  } catch (e) {
    cache.set(key, { byName: {}, failed: e.message }, { ttl: DEGRADED_TTL_MS });
    console.warn(`[api] 用户 ${memberId} 的加新时间线取不到（列表不标日期）：` + e.message);
    return null;
  }
}

/**
 * 用户名 → memberId：时间线接口只认数字 id（活动搜索的返回里带 userid）。
 * memberId 终身不变，缓存一个月；窗口取近三年，避免大范围查询。查不到就返回 0。
 */
const memberIdLoader = (user) => async () => {
  const y = new Date().getFullYear();
  const r = await searchRecords({ username: user, startTime: `${y - 3}-01-01`, endTime: todayYmd() }, { limit: 1, page: 1 });
  const row = (r.data || [])[0];
  return { memberId: row ? Number(row.userid) || 0 : 0 };
};
async function loadMemberId(user, nocache = false) {
  const key = `member-id|u1|${user}`;
  try {
    const { value } = await cached(key, memberIdLoader(user), nocache, { ttl: HISTORY_TTL_MS });
    if (value.failed) return 0;
    return value.memberId || 0;
  } catch (e) {
    cache.set(key, { memberId: 0, failed: e.message }, { ttl: DEGRADED_TTL_MS });
    console.warn(`[api] 用户名「${user}」的 memberId 取不到（列表不标加新日期）：` + e.message);
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 「收集拼图」—— 把郑四名录按**科**铺开，标出哪些种已经加新
 *
 * 与「未加新」是同一份名单的两种看法：
 *   ▸ 未加新：拿**榜单**去比对名单 → 「这个地区还剩哪些没加新」（按地区看）
 *   ▸ 拼图：  拿**名录**去比对名单 → 「全国的科里我收到了多少」（按分类看，与地区无关）
 * 所以拼图不读 state.hot，跟当前的省 / 市 / 日期完全无关 —— 换地区不该让它变。
 *
 * 分组用的是**郑四名录（Z4）**：26 目 / 116 科 / 1595 种，目科字段齐全，
 * 直接来自名录自身，不再另外维护一份分类表。
 *
 * 两个必须说清的口径：
 *   ▸ 只统计**名录里有**的种。名单来自用户记录，可能含名录外的（迷鸟、异名、旧版名录
 *     留下的 id），这部分汇不到任何科里 —— 如实报出「名录外 N 种」，不硬塞。
 *   ▸ 命中判定与「未加新」完全一致：先按 taxon_id，对不上退回拉丁名（`latinKey`），
 *     任一命中即算已收集。名单与名录可能来自不同名录版本，只认 id 会大面积漏判。
 * ------------------------------------------------------------------ */

/** 口径版本号：改了这一份拼图的算法（分组依据、命中判定、字段）就 +1，见 lifelist 的同款说明 */
const PUZZLE_KEY_VERSION = 'p3';

const puzzleLoader = (user) => async () => {
  const { value: cat } = await loadCatalog();
  const ll = await loadLifelist(user, false);
  if (!ll) throw new Error(`用户「${user}」的人生鸟种名单取不到（上游限流或网络异常）`);
  // 空名单必须当成失败而不是「一种都没收集」：上游对不存在的用户名是正常返回空集，
  // 照空集铺拼图会得到一整片灰色，看着像「这个人是新手」，结论完全错（同 applyLifer）。
  if (ll.speciesCount === 0) {
    throw new Error(`用户「${user}」在观鸟记录中心查不到任何记录 —— 请核对用户名（注意区分大小写）`);
  }

  const famMap = new Map();
  const seenIds = new Set();
  let collectedInCatalog = 0;
  let duplicateRows = 0;

  for (const s of cat.list) {
    // 名录里同一 taxon_id 会出现两次：上游把「旧名」和「新名」各存一条，只差 pinyin
    // （例：松鸡 有一条 pinyin=xifangsongji（旧名「西藏松鸡」）、一条 songji），
    // 目的是让两种叫法都能被搜到。检索那边按 id 去重了；这里是在**数种**，同理必须去重，
    // 否则科内总数会虚高、同一只鸟还会占两个格子。
    if (s.id) {
      if (seenIds.has(s.id)) {
        duplicateRows += 1;
        continue;
      }
      seenIds.add(s.id);
    }

    const byId = ll.byId[s.id];
    const byLatin = ll.byLatin[latinKey(s.latin)];
    const count = byId !== undefined ? byId : byLatin !== undefined ? byLatin : 0;
    const got = byId !== undefined || byLatin !== undefined;
    if (got) collectedInCatalog += 1;

    const key = `${s.order}||${s.family}`;
    let g = famMap.get(key);
    if (!g) {
      g = { order: s.order || '未标注', family: s.family || '未标注', total: 0, collected: 0, species: [] };
      famMap.set(key, g);
    }
    g.total += 1;
    if (got) g.collected += 1;
    g.species.push({ taxonId: s.id, name: s.name, latin: s.latin, got, count });
  }

  // 科内排序：已收集的排前面（一眼看清这个科收到了哪些），两组内保持名录顺序
  for (const g of famMap.values()) {
    g.species = g.species.filter((s) => s.got).concat(g.species.filter((s) => !s.got));
    g.ratio = g.total ? g.collected / g.total : 0;
    // 100% 的科单独标出来，前端好给它一个「已完成」的样子
    g.done = g.collected === g.total && g.total > 0;
  }

  // 科排序：收集比例高的在前（用户的核心诉求）；同比例时按「已收集数 → 科内总数 → 科名」，
  // 保证顺序稳定可复现，刷新不会跳来跳去
  const families = [...famMap.values()].sort(
    (a, b) =>
      b.ratio - a.ratio ||
      b.collected - a.collected ||
      a.total - b.total ||
      a.family.localeCompare(b.family, 'zh')
  );

  return {
    user: ll.user,
    catalog: {
      version: cat.version,
      prefix: cat.prefix,
      // species 是**去重后**的种数（名录原始行 cat.list 含 71 组新旧名重复行）；
      // rows 原样给出，便于对照
      species: seenIds.size,
      rows: cat.list.length,
      duplicateRows,
      families: famMap.size,
    },
    // 名单里对不上名录的种：lifelistSize - collectedInCatalog，前端如实提示，不藏
    lifelistSize: ll.speciesCount,
    collectedInCatalog,
    unmatched: Math.max(0, ll.speciesCount - collectedInCatalog),
    collectedFamilies: families.filter((f) => f.collected > 0).length,
    startedFamilies: families.filter((f) => f.collected > 0 && !f.done).length,
    doneFamilies: families.filter((f) => f.done).length,
    families,
  };
};

/**
 * 鸟种档案（收集拼图里点某个鸟名时看的那一份）几乎不变：名录条目只有换版才会改。
 * 缓存 30 天，同一个种点第二次是零请求。
 */
const TAXON_TTL_MS = Number(process.env.TAXON_TTL_MS || 30 * 24 * 60 * 60 * 1000);

/**
 * 单个鸟种的档案：中文名 / 学名 / 英文名 / 拼音 / 目科 / 习性 / 辨识特征 / 分布。
 *
 * ⚠ 上游 front/taxon/content 是**一次查一个 id**，所以绝不能在铺拼图时批量拉
 *   （郑四名录有 1500+ 种，那会瞬间打满上游风控）。只有用户点开某一种才发一次。
 */
async function loadTaxonContent(taxonId, nocache = false) {
  const { value, meta } = await cached(
    `taxon|${taxonId}`,
    async () => {
      const r = await getTaxonContent(taxonId);
      const d = r.data && typeof r.data === 'object' ? r.data : null;
      // 上游对这个接口「查不到」的表现是 success=true + data 为空 / null，不会报错。
      // 必须当成失败抛出去：空档案写进缓存会让这一格点开永远是空白，且一整天都不恢复。
      if (!d || (!d.name && !d.latinname)) throw new Error('上游没有返回这个鸟种的资料');
      // 上游的字段类型不统一：正文是字符串，而 guidebooksn / serial_id 是数字
      // （淡眉柳莺就是 886）。只认字符串会把编号整段丢成空 —— 数字也照收，0 视为没有。
      const txt = (v) => (typeof v === 'number' ? (v ? String(v) : '') : typeof v === 'string' ? v.trim() : '');
      // version 形如「Z4-67FA07177A544FBD96006A7CC7489D25」：前面是名录代号，后面是这份
      // 记录的内部串号。整串铺到页面上又长又没意义，只留代号。
      const shortVer = (v) => txt(v).replace(/-[0-9a-fA-F]{12,}$/, '');
      return {
        id: Number(d.id) || Number(taxonId) || 0,
        name: txt(d.name),
        latin: txt(d.latinname),
        english: txt(d.englishname),
        pinyin: txt(d.pinyin),
        szm: txt(d.szm),
        order: txt(d.taxonordername),
        family: txt(d.taxonfamilyname),
        habit: txt(d.habit),
        feature: txt(d.feature),
        spread: txt(d.spread),
        // 《中国鸟类野外手册》编号：跟名录顺序一致，老观鸟人习惯用它指代鸟种
        guidebookSn: txt(d.guidebooksn) || txt(d.serial_id),
        version: shortVer(d.version),
      };
    },
    nocache,
    { ttl: TAXON_TTL_MS }
  );
  return { ...value, meta };
}

/** 取某个用户的收集拼图（与人生名册同节奏缓存 24 小时，避免每次打开都重铺 1595 行） */
async function loadPuzzle(user, nocache = false) {
  const { value, meta } = await cached(
    `puzzle|${PUZZLE_KEY_VERSION}|${user}`,
    puzzleLoader(user),
    nocache,
    { ttl: LIFELIST_TTL_MS }
  );
  return { ...value, meta };
}


/** 附在返回体里的空结果，避免各处重复写一大串默认值 */
const LIFER_EMPTY = {
  liferUser: '',
  liferSpeciesCount: 0, // 该用户人生鸟种总数
  liferRecordSum: 0, // 该用户记录条数合计
  liferNewCount: 0, // 本榜单里「未加新」的种数
  liferKnownCount: 0, // 本榜单里「已加新」的种数
  liferError: '',
};

/**
 * 给榜单每一行贴「未加新」标记。
 * @returns {{list: Array, info: object}} info 见 LIFER_EMPTY 的字段
 */
async function applyLifer(list, liferUser, nocache) {
  if (!liferUser) return { list, info: { ...LIFER_EMPTY } };
  const ll = await loadLifelist(liferUser, nocache);
  if (!ll) {
    return {
      list,
      info: { ...LIFER_EMPTY, liferUser, liferError: `用户「${liferUser}」的记录取不到（上游限流或网络异常），稍后再试` },
    };
  }

  // 名单为空**必须当成失败**，绝不能当成「这个用户一种鸟都没见过」：
  // 上游对不存在的用户名是正常返回空集（不是报错），真按空集比对的话，
  // 每一种鸟都会被标成「未加新」—— 页面看上去一切正常，结论却完全错了。
  // 这是这个功能里最容易静默出错的地方，所以在这里单独拦一道。
  if (ll.speciesCount === 0) {
    return {
      list,
      info: { ...LIFER_EMPTY, liferUser, liferError: `用户「${liferUser}」在观鸟记录中心查不到任何记录 —— 请核对用户名（注意区分大小写）` },
    };
  }

  let newCount = 0;
  let knownCount = 0;
  const out = list.map((x) => {
    let v = ll.byId[x.taxonId];
    if (v === undefined) v = ll.byLatin[latinKey(x.latin)];
    const known = v !== undefined && v > 0;
    if (known) knownCount += 1;
    else newCount += 1;
    // lifer = 该用户没见过 = 未加新；liferCount 是 TA 对这一种的记录条数（已加新时才有意义）
    return { ...x, lifer: !known, liferCount: known ? v : 0 };
  });

  return {
    list: out,
    info: {
      liferUser,
      liferSpeciesCount: ll.speciesCount,
      liferRecordSum: ll.recordSum,
      liferNewCount: newCount,
      liferKnownCount: knownCount,
      liferError: '',
    },
  };
}

/**
 * 给榜单成员贴上「历史记录数」与「疑问记录数」，并按历史稀有度排序。
 * @returns {{rows: Array, speciesCount: number, matched: number, error: string,
 *            doubtSpeciesCount: number, doubtRecordSum: number, doubtMatched: number, doubtError: string}}
 */
async function rankByHistory(list, where, nocache) {
  // 串行而非并行：两者都是慢查询，串行多花一两秒，
  // 但同一地区同时只向上游发一个请求，不容易踩到频次风控。
  // 注意：历史（loadHistory）**不吃 nocache** —— 一个月缓存是强制的；
  // 疑问标记照常跟着 nocache 刷新（它跟着榜单本时段走，变化快）。
  const h = await loadHistory(where);
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
 * 「稀有度」排序键：优先用「历史记录数」（该地区最近两年），
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
 * 报告明细每页条数：默认 10，上限 50。
 * 上限是上游的硬限制（limit > 50 直接返回空）；另外实测**不传 limit 会 500**
 * （上游按「结果集过大」处理：北京·东城区·单日 也照挂），所以每页条数必须显式传。
 * 这里**只取当前这一页**，不再向上游翻页聚合（一次翻多页既慢又容易踩上游风控），
 * 需要更多就由前端翻页，一页一次请求。
 */
const RECORDS_PAGE_SIZE = 10;  // 不传 limit 时的默认每页条数
const RECORDS_LIMIT_MAX = 50;  // 上游单页上限

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

/**
 * 从上游新版的 address 字段里拆出 省 / 市 / 区县 / 观鸟点。
 *
 * 上游 2026-10-13 实测：`record/activity/search` 把原来的
 * point_name / province_name / city_name / district_name 四个字段
 * **合并成了一个 address**，格式为「省+市+区县+观鸟点」，例如：
 *   福建省福州市仓山区福州花海公园        → 点：福州花海公园
 *   北京市北京市怀柔区北京市怀柔区神山村   → 直辖市会把「市+区」再重复一遍，也要剥掉
 * 拆不出来时退回「整串当观鸟点」—— 宁可显示得长一点，也不能留空。
 */
function splitAddress(address) {
  const s = String(address || '').trim();
  // 市名的后缀匹配要防「州市」连写：「福州市」不能拆成「福州」+「市…」，
  // 所以 州 后面跟 市 的不算后缀（自治州里的 州 后面通常跟区县名，不受影响）；
  // 区县的 县(?!区) 同理防「梅县区」被拆成「梅县」+「区…」。
  const m = s.match(/^(.+?(?:省|市|自治区|特别行政区))(.+?(?:自治州|市|盟|地区|州(?!市)))?(.+?(?:区|县(?!区)|旗|市))(.+)$/);
  if (!m) return { province: '', city: '', district: '', point: s };
  const [, province, city = '', district, rest] = m;
  // 老数据里区县存的是「市辖区」（不是真区名），真区名跟在它后面：
  // 北京市市辖区朝阳区望京公园 → 区 朝阳区 / 点 望京公园
  if (district === '市辖区') {
    const m2 = rest.match(/^(.+?(?:区|县(?!区)|旗))(.+)$/);
    if (m2) return { province, city, district: m2[1], point: m2[2] };
  }
  // 有的 address 把「省+市+区县」又重复了一遍才接观鸟点（直辖市常见，地级市也偶发），
  // 按「最长优先」剥掉重复前缀：北京市北京市怀柔区北京市怀柔区神山村 → 神山村；
  // 浙江省杭州市西湖区浙江省杭州市西湖区曲院风荷 → 曲院风荷
  let point = rest;
  for (const dup of [`${province}${city}${district}`, `${city}${district}`, district]) {
    if (dup && point.startsWith(dup) && point.length > dup.length) {
      point = point.slice(dup.length);
      break;
    }
  }
  return { province, city, district, point };
}

function normalizeRecord(d) {
  const reportId = d.reportId || d.request_id || d.serial_id || '';
  // 兼容两种上游形态：老行还带 point_name 等字段就用旧的；新行（2026-10 起）从 address 拆
  const loc = d.point_name
    ? { province: d.province_name || '', city: d.city_name || '', district: d.district_name || '', point: d.point_name }
    : splitAddress(d.address);
  return {
    reportId,
    serialId: d.serial_id || '',
    pointName: loc.point,
    province: loc.province,
    city: loc.city,
    district: loc.district,
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
    const { value, meta } = await dictCached('dict:provinces', () => getProvinces());
    return { data: (value.data || []).map((d) => ({ name: d.province_name, code: String(d.province_code) })), cache: meta };
  },

  // 地级字典
  async 'GET /api/cities'(q) {
    const code = q.get('provinceCode');
    if (!code) throw new HttpError(400, '缺少 provinceCode');
    const { value, meta } = await dictCached('dict:cities:' + code, () => getCities(code));
    return { data: (value.data || []).map((d) => ({ name: d.city_name, code: String(d.city_code) })), cache: meta };
  },

  // 区县字典
  async 'GET /api/districts'(q) {
    const code = q.get('cityCode');
    if (!code) throw new HttpError(400, '缺少 cityCode');
    const { value, meta } = await dictCached('dict:districts:' + code, () => getDistricts(code));
    return { data: (value.data || []).map((d) => ({ name: d.district_name, code: String(d.district_code) })), cache: meta };
  },

  // 概览统计
  async 'GET /api/overview'(q) {
    const where = buildWhere(q);
    // 全国可以查，但必须同时给起止日期（见 nationalNeedsRange 的实测数据）
    if (nationalNeedsRange(where)) {
      return { region: '全国', where, unsupported: true, needRange: true, taxonNum: 0, orderNum: 0, familyNum: 0, reportNum: 0, openReportNum: 0, privacyReportNum: 0, recordCount: 0, reportNumSubset: 0, raw: {} };
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
  //   排序 = 该地区**最近两年**的记录数升序（去年 1 月 1 日起）
  //   标记 = 当前时段被上游 AI 标疑（outside_type=1，站点显示为红色）的记录
  // 三份口径分开缓存：榜单 24 小时、历史 24 小时、疑问标记 24 小时，互不影响。
  async 'GET /api/hot'(q) {
    const where = buildWhere(q);
    // 全国范围**可以查**（早先「上游会 500」的结论是 505 风控被误读），只是必须带起止日期 ——
    // 无时间限制的全国聚合实测 1358 万条，见 nationalNeedsRange。
    // 注意与「绑定用户的人生鸟种」区分：那个查询**带 username**，结果集只有几百行，
    // 即使不带 province 上游也能正常返回（见 lifelistLoader 的实测记录）。
    const liferUserEarly = (q.get('liferUser') || '').trim();
    if (nationalNeedsRange(where)) {
      return {
        region: '全国',
        where,
        unsupported: true,
        needRange: true,
        stat: {
          totalSpecies: 0, speciesCount: 0, recordSum: 0, returned: 0, levelKnownCount: 0, coverage: 0,
          national1: 0, national2: 0, sanYou: 0, chinaEndemic: 0, threatened: 0, minCount: 0, maxCount: 0,
          historyUsed: false, historySpeciesCount: 0, historyMatched: 0, historyError: '',
          doubtCount: 0, doubtRecordSum: 0, doubtSpeciesCount: 0, doubtError: '',
          ...LIFER_EMPTY,
          liferUser: liferUserEarly,
        },
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

    // 「今天新来了」的对比基准（单日查询才有）与历史稀有度并行取，互不拖慢
    const prevPromise = loadPrevDaySpecies(where, nocache);

    // 贴上「历史记录数」并按历史稀有度排序（历史取不到时自动退回本时段记录数）
    const hist = await rankByHistory(allTaxons, where, nocache);
    let list = hist.rows;
    const levelKnownCount = head.filter((x) => x.levelKnown).length;

    // 「未加新」比对：绑定用户在右上角填的那个观鸟用户，其人生鸟种里没有的种标出来。
    // 必须排在筛选之前 —— 因为「仅未加新」本身就是一个筛选条件。
    const liferUser = (q.get('liferUser') || '').trim();
    // 右上角「重新获取名单」只想刷人生鸟种这一份缓存，不该顺手把地区榜单缓存也打掉
    // （地区榜单要扫逐月 + 历史记录数，比名单贵得多），所以单开一个开关。
    const liferNocache = nocache || q.get('liferNocache') === '1';
    const lifer = await applyLifer(list, liferUser, liferNocache);
    list = lifer.list;

    if (keyword) list = list.filter((x) => x.name.includes(keyword) || (x.latin || '').toLowerCase().includes(keyword));
    if (filter === 'national') list = list.filter((x) => x.chinaLevel === '国家一级' || x.chinaLevel === '国家二级');
    else if (filter === 'protected') list = list.filter((x) => x.chinaLevel);
    else if (filter === 'chinaEndemic') list = list.filter((x) => x.chinaEndemic);
    else if (filter === 'doubt') list = list.filter((x) => x.doubt);
    // 「不含全疑问」：本时段记录**全部被**上游标疑的种不参与排行 —— 它们一条正常记录
    // 都没有，排在稀有榜里等于「这个种根本没法确认来过」。半疑半正常的种保留。
    else if (filter === 'nodoubt') list = list.filter((x) => !(x.doubtCount > 0 && x.doubtCount >= (Number(x.count) || 0)));
    else if (filter === 'lifer') list = list.filter((x) => x.lifer);

    // min / max 都取「最近两年」口径（即排序依据本身）
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

    const prev = await prevPromise;
    const out = list.slice(0, top).map((x, i) => ({
      ...x,
      rank: i + 1,
      rarity: rarityOf(rarityKey(x)),
      // 昨天同一条件下没有它 → 今天新出现（拿不到昨日清单时统一为 false，前端也不展示）
      isNew: prev ? !prev.known(x) : false,
    }));
    const newCount = prev ? out.filter((x) => x.isNew).length : 0;

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
      // 「今天新来了」：对比昨天（仅单日查询）；newComparable=false 时前端不展示这一块
      newComparable: !!prev,
      newCount,
      // 「未加新」比对结果（没绑用户时全为 0 / 空）
      ...lifer.info,
    };

    return { region: regionLabel(where), where, stat, pending, list: out, cache: meta };
  },

  // 完整鸟种明细：给「记录鸟种数」下钻用，不受榜单 top / 筛选影响。
  // 成员与榜单一致（当前时段出现过的鸟种），但稀有度同样按
  // 「该地区最近两年（去年 1 月 1 日起）的记录数」计算并排序。
  async 'GET /api/taxons'(q) {
    const where = buildWhere(q);
    if (nationalNeedsRange(where)) {
      return {
        region: '全国', where, unsupported: true, needRange: true, total: 0, speciesCount: 0, recordSum: 0,
        doubtCount: 0, doubtRecordSum: 0, doubtSpeciesCount: 0, doubtError: '',
        ...LIFER_EMPTY, liferUser: (q.get('liferUser') || '').trim(), list: [],
      };
    }
    const sort = q.get('sort') || 'record';
    const limit = Math.min(Number(q.get('limit') || 500), 2000);
    const nocache = q.get('nocache') === '1';

    const { list, total, speciesCount, recordSum, pending, meta } = await loadTaxons(where, {
      ensure: Math.min(Number(q.get('ensure') || 300), 400),
      nocache,
    });

    const hist = await rankByHistory(list, where, nocache);
    // 明细表也做未加新比对：点开「记录鸟种数」看全部鸟种时，
    // 未加新的那些同样要有标记，否则和榜单对不上。（liferNocache 与 /api/hot 同义）
    const lifer = await applyLifer(
      hist.rows,
      (q.get('liferUser') || '').trim(),
      nocache || q.get('liferNocache') === '1'
    );
    const rows = [...lifer.list];
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
      // 「未加新」比对结果（没绑用户时全为 0 / 空）
      ...lifer.info,
      pending,
      list: rows.slice(0, limit).map((x, i) => ({ ...x, rank: i + 1 })),
      cache: meta,
    };
  },

  /**
   * 某个观鸟用户的「人生鸟种」清单。
   *
   * 一次上游请求取全（不带 province、不带时间，见 lifelistLoader 的实测记录），
   * 缓存 24 小时。前端右上角绑定用户后用它与榜单比对，标出「未加新」的鸟种。
   *
   * 参数：user（推荐）/ username（兼容写法）；nocache=1 强制回源。
   */
  async 'GET /api/user-lifelist'(q) {
    const user = (q.get('user') || q.get('username') || '').trim();
    if (!user) return { user: '', speciesCount: 0, recordSum: 0, error: '缺少 user 参数', list: [] };

    const ll = await loadLifelist(user, q.get('nocache') === '1');
    if (!ll) {
      return {
        user,
        speciesCount: 0,
        recordSum: 0,
        error: `取不到用户「${user}」的记录 —— 上游限流或网络异常，稍后再试。`,
        list: [],
      };
    }
    // 空集 = 用户名查不到（上游对不存在的用户是正常返回空集，不是报错），必须如实说明，
    // 否则前端会把这个空名单当成「他一种鸟都没见过」，把所有鸟都标成未加新。
    if (ll.speciesCount === 0) {
      return {
        user,
        speciesCount: 0,
        recordSum: 0,
        error: `用户「${user}」在观鸟记录中心查不到任何记录 —— 请核对用户名（注意区分大小写）。`,
        list: [],
      };
    }

    // 明细列表按「该用户的记录条数」降序：记录得多的自然是他熟悉的地方/常见鸟。
    // 逐种补上 名字 / 目科 / 保护等级 / 疑问标记：「总鸟种数」点开的列表直接用这份。
    // 名字取自名单随行带回的 nameById（老缓存没有就查郑四名录兜底），等级走本地字典
    // （零额外上游），疑问用与名单同节奏缓存的标疑清单（每人每天最多多查一次）。
    const doubt = await loadLifelistDoubt(ll.user, q.get('nocache') === '1');
    // 「加新时间」：今年的加新有精确日期与地点（见 lifelistDatesLoader 的说明），更早的没有
    let dates = null;
    try {
      const memberId = await loadMemberId(ll.user, q.get('nocache') === '1');
      if (memberId) dates = await loadLifelistDates(memberId, q.get('nocache') === '1');
    } catch (e) {
      dates = null;
    }
    const lookup = await catalogLookup().catch(() => null);
    const sorted = Object.entries(ll.byId)
      .map(([id, count]) => ({ taxonId: Number(id), count }))
      .sort((a, b) => b.count - a.count);
    await ensureLevels(sorted.map((x) => x.taxonId), { limit: 80, wait: true });
    const levels = readCachedLevels(sorted.map((x) => x.taxonId));
    const list = sorted.map((x) => {
      const meta = (ll.nameById && ll.nameById[x.taxonId]) || null;
      const hit = lookup
        ? lookup.byId.get(Number(x.taxonId)) || (meta && meta.latin ? lookup.byLatin.get(latinKey(meta.latin)) : null)
        : null;
      const lv = levels[x.taxonId] || {};
      const dq = doubt && doubt.byId[x.taxonId];
      const name = (meta && meta.name) || (hit && hit.name) || `#${x.taxonId}`;
      // 「加新时间」上游是按**名字**给的，而名单里的名字已统一成郑四写法 ——
      // 用户当年加新时记下的可能是旧名（如「白冠燕尾」现已并入「白额燕尾」），
      // 所以先按郑四名找，找不到再拿上游出现过的别名逐个碰一次。
      let did = dates ? dates.byName[normName(name)] : null;
      if (!did && dates) {
        const alts = (ll.altNamesById && ll.altNamesById[x.taxonId]) || [];
        for (const alt of alts) {
          did = dates.byName[normName(alt)];
          if (did) break;
        }
      }
      return {
        taxonId: x.taxonId,
        count: x.count,
        name,
        latin: (meta && meta.latin) || (hit && hit.latin) || '',
        order: (hit && hit.order) || '',
        family: (hit && hit.family) || '',
        chinaLevel: lv.china_level || '',
        iucn: lv.iucn || '',
        chinaEndemic: !!lv.is_china,
        doubt: !!dq,
        doubtCount: dq || 0,
        // 加新时间与地点（今年的才有；上游的加新时间线只覆盖当年）
        firstTime: did ? did.time : '',
        firstPlace: did ? did.place : '',
      };
    });
    // 排序：按加新时间倒序（今年加新在前）；没有日期的按记录数降序跟在后面
    list.sort((a, b) => String(b.firstTime || '').localeCompare(String(a.firstTime || '')) || b.count - a.count);

    return {
      user: ll.user,
      speciesCount: ll.speciesCount,
      recordSum: ll.recordSum,
      rowCount: ll.rowCount,
      error: '',
      list,
      // —— 下面三个数就是官网查询页显示的那三个（官网默认发 outside_type=0，疑问另发一次），
      //    前端「总鸟种数」直接摆它们，用户才好拿官网的数字对账。
      //    一个种的记录条数 = 正常 + 疑问，所以「条数 - 疑问条数 > 0」就是它有正常记录。
      doubtSpeciesCount: list.filter((x) => x.doubt).length,
      normalSpeciesCount: list.filter((x) => x.count - (x.doubtCount || 0) > 0).length,
      normalRecordSum: list.reduce((s, x) => s + Math.max(0, x.count - (x.doubtCount || 0)), 0),
      // 郑四名录里查不到的种（迷鸟 / 异名 / 名录未收录）：条数如实报出，前端单独提示，
      // 不混进 speciesCount —— 那个数是「按郑四算的种数」，口径必须干净。
      offCatalog: ll.offCatalog || [],
      offCatalogCount: ll.offCatalogCount || 0,
      offCatalogRecordSum: (ll.offCatalog || []).reduce((s, x) => s + (x.count || 0), 0),
      cache: ll.meta,
    };
  },

  /**
   * 「收集拼图」：把郑四名录按科铺开，逐种标出是否已加新。
   *
   * 与 /api/user-lifelist 的区别是**比对的一方**：
   *   后者比榜单（跟地区 / 日期走），这个比全家名录（与地区 / 日期无关，只跟绑定用户走）。
   * 因此**不接收** province / startTime 等条件 —— 换地区不该让拼图变化。
   *
   * 参数：user（推荐）/ username（兼容写法）；nocache=1 强制回源。
   * 返回体见 puzzleLoader；families 已按「收集比例降序」排好，前端不需要再排。
   */
  async 'GET /api/lifer-puzzle'(q) {
    const user = (q.get('user') || q.get('username') || '').trim();
    if (!user) {
      return { user: '', families: [], collectedInCatalog: 0, error: '缺少 user 参数' };
    }
    try {
      const p = await loadPuzzle(user, q.get('nocache') === '1');
      return { ...p, error: '' };
    } catch (e) {
      // 拼图整份都依赖名单：名单取不到就没有可展示的内容，如实报错（不返回半份灰拼图）
      console.warn(`[api] 用户「${user}」的收集拼图取不到：` + e.message);
      return {
        user,
        families: [],
        collectedInCatalog: 0,
        error: `拼图取不到：「${user}」的记录没能从记录中心读到（${e.message}）。稍后再试，或核对用户名。`,
      };
    }
  },

  /**
   * 单个鸟种的档案（收集拼图里点鸟名时看的那一份）。
   *
   * 参数：id（taxon_id，数字）；nocache=1 强制回源。
   * 与拼图整份数据不同，这个是**点了才查**的：上游一次只认一个 id，
   * 缓存 30 天（名录条目很少变），同一个种再点开是零请求。
   */
  async 'GET /api/taxon/content'(q) {
    const id = Number(q.get('id'));
    if (!Number.isFinite(id) || id <= 0) {
      return { error: '缺少或非法的 id 参数（要传数字 taxon_id）' };
    }
    try {
      const t = await loadTaxonContent(id, q.get('nocache') === '1');
      return { ...t, error: '' };
    } catch (e) {
      // 单种读不到不影响其它格子：如实告诉前端，前端在弹层里显示一句人话
      console.warn(`[api] 鸟种档案 ${id} 取不到：` + e.message);
      return { id, error: `这个鸟种的资料暂时读不到（${e.message}）。稍后再试。` };
    }
  },

  // 报告 / 记录明细。上游限制：单页 limit > 50 会直接返回空，不传 limit 会 500。
  // 这里**只取上游的一页**（默认每页 10 条），翻页由前端一页一次请求驱动 ——
  // 不再把 10 页一次性抓回来聚合成全量列表（既慢又容易触发上游风控）。
  //
  // 两种用法（二选一）：
  //   ▸ 地区维度：给 province（+ 时间等）→ 该地区的公开报告
  //   ▸ 用户维度：给 username → 这个人在记录中心公开过的报告（**不需要省份**，
  //     上游的 activity/search 支持；此前「必须带 province」的判断是错的，见 searchUserRecords 的说明）
  async 'GET /api/records'(q) {
    const where = buildWhere(q);
    const user = (where.username || '').trim();
    // 用户维度（我的报告）不需要省份；地区维度的全国查询则要带起止日期
    if (!user && nationalNeedsRange(where)) {
      return { region: '全国', where, unsupported: true, needRange: true, page: 1, limit: RECORDS_PAGE_SIZE, total: 0, totalPages: 1, returned: 0, hasMore: false, list: [] };
    }

    const page = Math.max(1, Math.floor(Number(q.get('page')) || 1));
    const limit = Math.min(Math.max(1, Math.floor(Number(q.get('limit')) || RECORDS_PAGE_SIZE)), RECORDS_LIMIT_MAX);

    const { value, meta } = await cached(
      whereKey(where, `records:${page}:${limit}`),
      async () => {
        const r = user ? await searchUserRecords(user, { limit, page }) : await searchRecords(where, { limit, page });
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

  // 单份观鸟报告详情：「报告明细」里点报告编号 / 行时，弹我们自己的页面用。
  // 上游是站点报告页用的两个接口：activity/get（基本信息）+ activity/taxon（鸟种清单）。
  // 报告上传后内容基本不变，缓存沿用默认 10 分钟。
  async 'GET /api/report'(q) {
    const reportId = (q.get('reportId') || '').trim();
    if (!reportId) throw new HttpError(400, '缺少 reportId');
    const liferUser = (q.get('liferUser') || '').trim();
    // 页面当前的条件（地区 / 日期）：用来给清单里的每种缀「该地区近两年记录数」
    const where = buildWhere(q);
    const { value, meta } = await cached(
      `report|${reportId}`,
      async () => {
        const [infoRes, taxRes] = await Promise.all([getActivity(reportId), getActivityTaxons(reportId)]);
        const info = infoRes.data || {};
        const loc = splitAddress(info.address || '');
        const rows = Array.isArray(taxRes.data) ? taxRes.data : [];
        const ids = rows.map((t) => Number(t.taxon_id) || 0).filter(Boolean);
        // 保护等级：全国字典基本都在，缺的顺手补一小批（其余进后台队列慢慢补）
        await ensureLevels(ids, { limit: 80, wait: true });
        const levels = readCachedLevels(ids);
        const list = rows.map((t) => {
          const id = Number(t.taxon_id) || 0;
          const lv = levels[id] || {};
          return {
            taxonId: id,
            name: t.taxon_name || '',
            latin: t.latinname || '',
            english: t.englishname || '',
            order: t.taxonordername || '',
            family: t.taxonfamilyname || '',
            count: Number(t.taxon_count) || 0,
            doubt: t.outside_type === 1, // 上游 AI 标疑（站点显示为红色）
            imageNum: Number(t.record_image_num) || 0,
            chinaLevel: lv.china_level || '',
            iucn: lv.iucn || '',
            chinaEndemic: !!lv.is_china,
          };
        });
        return {
          reportId,
          serialId: info.serialId || '',
          activityId: Number(info.id) || 0, // 数字 id：取记录图片（reportTaxonImage）要用它
          point: info.pointName || loc.point || '',
          province: loc.province,
          city: loc.city,
          district: loc.district,
          address: info.address || '',
          startTime: info.startTime || '',
          endTime: info.endTime || '',
          username: info.username || '',
          note: info.note || '',
          taxonCount: Number(info.taxonCount) || list.length,
          orderCount: new Set(list.map((x) => x.order).filter(Boolean)).size,
          familyCount: new Set(list.map((x) => x.family).filter(Boolean)).size,
          url: reportUrl(reportId),
          list,
        };
      },
      q.get('nocache') === '1'
    );
    const payload = { ...value, cache: meta };
    // 给清单里的每种缀上「该地区近两年记录数」（与榜单共用同一份历史缓存，
    // 零额外上游；拿不到就跳过 —— 只是少一行小注，不影响报告本身）
    if (where.province) {
      try {
        const hist = await loadHistory(where);
        if (!hist.error) {
          payload.list = payload.list.map((x) => {
            let v = hist.byId[x.taxonId];
            if (v === undefined) v = hist.byLatin[latinKey(x.latin)];
            return { ...x, histCount: v === undefined ? null : v };
          });
        }
      } catch (e) { /* 静默 */ }
    }
    // 「未加新」比对：与榜单共用同一份人生鸟种名单（名单本身不因此回源）
    if (liferUser) {
      const lifer = await applyLifer(payload.list, liferUser, false);
      payload.list = lifer.list;
      payload.lifer = lifer.info;
    }
    return payload;
  },

  // 单份报告里某个鸟种的记录图片（报告详情里点「图片 N」时用）。
  // 上游返回 {image_url} 列表（OSS 签名直链，明文不加密）。这里统一把 http 换成 https：
  // 该 OSS 两种协议都能取（实测同样 200 同字节），而 APK 的明文策略只放行回环地址，
  // http 的图在 WebView 里会加载不出来。
  async 'GET /api/report-images'(q) {
    const activityId = Number(q.get('activityId')) || 0;
    const taxonId = Number(q.get('taxonId')) || 0;
    if (!activityId || !taxonId) throw new HttpError(400, '缺少 activityId / taxonId');
    const { value, meta } = await cached(
      `report-image|${activityId}|${taxonId}`,
      async () => {
        const r = await getReportTaxonImages(activityId, taxonId);
        const list = (Array.isArray(r.data) ? r.data : [])
          .map((x) => String(x.image_url || ''))
          .filter(Boolean)
          .map((u) => u.replace(/^http:\/\//i, 'https://'));
        return { count: Number(r.count) || list.length, list };
      },
      q.get('nocache') === '1'
    );
    return { ...value, cache: meta };
  },

  // 逐月趋势
  async 'GET /api/trend'(q) {
    const where = buildWhere(q);
    if (nationalNeedsRange(where)) {
      return { region: '全国', where, unsupported: true, needRange: true, months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, taxonCount: 0, reportCount: 0 })) };
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

      const provs = (await dictCached('dict:provinces', () => getProvinces())).value.data || [];
      const provCode = provs.find((p) => p.province_name === provinceName)?.province_code || '';
      const cities = (await dictCached('dict:cities:' + provCode, () => getCities(provCode))).value.data || [];
      const MUNI = ['北京市', '天津市', '上海市', '重庆市'];

      let units = [];
      let unit = '地市';
      if (level === 'city' && !MUNI.includes(provinceName)) {
        units = cities.map((c) => c.city_name);
      } else {
        // 区县级：直辖市直接用本市的区县，普通省份用所选地市的区县
        const cityName = MUNI.includes(provinceName) ? provinceName : where.city || cities[0]?.city_name;
        const cityCode = cities.find((c) => c.city_name === cityName)?.city_code || '';
        const districts = (await dictCached('dict:districts:' + cityCode, () => getDistricts(cityCode))).value.data || [];
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
      // 版本 + 形态：排查「用户装的到底是哪一版」时第一眼看这里
      version: appVersion().version,
      versionSource: appVersion().source,
      platform: platformLabel(),
      uptime: process.uptime(),
      dataDir: DATA_DIR,
      web: webSourceText(),
      caches: { api: cache.info(), protection: protectionStatus().cache },
      protection: protectionStatus(),
    };
  },

  /* ---------------------------------------------------------------- *
   * 「按当前条件监听稀有鸟种」
   *
   * 状态（条件快照 / 阈值 / 基线 / 历史）全在服务端，落在 <数据目录>/watch.json。
   * 放服务端而不是 localStorage 是有原因的：Android 的**系统通知**由 Java 侧的后台线程发，
   * 它读不到 WebView 的 localStorage，只能来问本机服务端。于是「谁先发现谁消费」天然只会
   * 通知一次 —— 新提醒在 check 里就写进 alerted 表了。
   * ---------------------------------------------------------------- */

  // 只看状态，不回源（页面刷新 / 打开监听面板时用）
  async 'GET /api/watch'() {
    return watch.current();
  },

  // 配置监听（都用查询参数，键名与 buildWhere 一致）。三种用法：
  //   ?enabled=1  开启（或「开着的时候按新条件 / 新阈值重来一遍」）
  //   ?enabled=0  关闭
  //   **不给 enabled** = 只同步条件、不动开关 —— 页面每次查询后自动跟随条件走的就是这条，
  //                      所以它默认 defer（不等基线建完就返回，建基线要真回一次上游、几十秒）
  async 'POST /api/watch'(q) {
    const hasEnabled = q.has('enabled');
    const enabled = hasEnabled ? q.get('enabled') === '1' : undefined;
    const where = buildWhere(q);
    const conditions = pickConditions(where);
    // 「全国」不带起止日期时上游那个量级查不动，直接挡住，
    // 别让用户开成一个永远不会响的监听（自动跟随那条路也一样挡：条件存下去也用不了）
    if (enabled !== false && nationalNeedsRange(where)) {
      throw new HttpError(400, '监听「全国」需要同时选择起始日期与结束日期');
    }
    return watch.configure({
      enabled,
      conditions,
      label: (q.get('label') || '').trim() || watchLabel(where),
      maxHistoryCount: q.get('maxHistoryCount'),
      intervalMs: q.get('intervalMs'),
      defer: q.get('defer') === '1',
    });
  },

  // 跑一轮检查。force=1 忽略最短回源间隔（「立即检查」按钮用）
  async 'GET /api/watch/check'(q) {
    return watch.check({ force: q.get('force') === '1' });
  },

  // 清空历史记录（基线与「已提醒」表不动，所以清完不会把旧鸟再报一遍）
  async 'POST /api/watch/history'() {
    return watch.clearHistory();
  },

  /* ---- 版本与更新（只查 GitHub Releases，不碰观鸟记录中心）----
     网页端只在「我的」面板里用它们：面板一打开读一次状态，点「检查更新」才 force=1。 */

  // 当前版本 + 最新版本（默认走 6 小时缓存；force=1 强制回源）
  async 'GET /api/version'(q) {
    return updater.check({ force: q.get('force') === '1' });
  },

  // 开始下载本平台对应的新版本安装包（立刻返回，进度靠下面的 progress 轮询）
  async 'POST /api/update/download'() {
    return { download: updater.startDownload() };
  },

  // 下载进度（轻量，网页端在下载时每 500ms 轮询一次）
  async 'GET /api/update/progress'() {
    return { download: updater.downloadState() };
  },

  // 在文件管理器里打开下载目录（桌面形态：用户自己把新程序拖过去替换）
  async 'POST /api/update/reveal'() {
    return updater.reveal();
  },

  // 打开 Release 页面（放更新说明与手动下载的入口）
  async 'POST /api/update/open'() {
    return updater.openPage();
  },
};

/**
 * 监听器实例。
 *
 * 放在 routes 之后定义、被路由闭包引用 —— 路由处理器只在请求到达时才执行，
 * 那时这里的 const 早就初始化完了，不会踩到暂时性死区。
 *
 * loadHot 直接复用 /api/hot 这个路由处理器本身：榜单的成员口径、历史稀有度排序、
 * 各项缓存（本时段清单 24 小时、历史 1 个月）全都原样生效，监听这边不用再拼一遍查询。
 * 唯一要注意的是**必须带 nocache** —— 否则 24 小时缓存会让「每 10 分钟看看有没有新鸟」
 * 一天都拿到同一份数据（见 watch.mjs 文件头的实测说明）。
 */
const watch = createWatch({
  dataDir: DATA_DIR,
  loadHot: (conditions, { nocache } = {}) =>
    routes['GET /api/hot'](new URLSearchParams({ ...conditions, ...(nocache ? { nocache: '1' } : {}) })),
  log: (m) => console.log(m),
});

/**
 * 版本检查 / 下载器。跟 watch 一样放在 routes 之后由路由闭包引用（见上）。
 * 缓存放 `data/update.json`（默认 6 小时一次），下载放 `data/download/`。
 */
const updater = createUpdater({ dataDir: DATA_DIR, log: (m) => console.log(m) });

/** 带 HTTP 状态码的业务错误；路由抛它、顶层按 code 回给前端 */
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
    console.log(`\n  啾讯已启动${IS_SEA ? '（独立 exe 版）' : ''}`);
    console.log(`  ▸ 网页端  ${url}`);
    console.log(`  ▸ 接口    ${url}api/health`);
    console.log(`  ▸ 版本    v${appVersion().version}（${appVersion().source === 'git' ? '跟着 git tag' : appVersion().source}） · ${platformLabel()}`);
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
