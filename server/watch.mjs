/**
 * 「按当前条件盯着稀有鸟种」的监听器。
 *
 * 需求原话：按当前条件监听，一有稀有鸟种就提示（网页端右下角浮卡、Android 端系统通知），
 * 点提示能看历史记录。
 *
 * 三条约定（都跟用户对过）：
 *
 *   1) 时间条件**沿用开启监听那一刻页面上的那一段**，不做滚动窗口。
 *   2) 「稀有」= 该地区**最近两年记录数 ≤ 阈值**（默认 3）。直接沿用榜单的历史口径，
 *      不另算一套；候选集就是榜单成员（= 本时段出现过）。
 *   3) 因为时间条件是钉住的，结果集只在上游**补录**时才会变。所以开启监听时先把当时
 *      命中的一批记成**基线**（baseline），之后只报基线之外新出现的 —— 否则每轮检查
 *      都会把同一批鸟重复报一遍。
 *
 * ---------------------------------------------------------------------------
 * 两个实测出来的坑，直接决定了实现方式与界面上要怎么讲：
 *
 * ▸ **绝对阈值在大范围下几乎不可能命中。** 2026-10-16 实测同一条件下近两年记录数的下界：
 *     北京市（单日 80 种）最少 95 条 ｜ 北京朝阳区（33 种）最少 64 条 ｜ 全国（270 种）最少 286 条
 *   也就是说 ≤3 这种门槛在北京 / 全国**永远返回 0**。这不是坏了 —— 大范围里的「真·迷鸟」
 *   本来就罕见（那种鸟一出现基本就是当年的头条）。但用户看不到这一点，只会觉得功能失效，
 *   所以检查结果里必须带 `minHistoryCount`，界面上要把「本时段最稀有的一档是多少条」摊开说，
 *   并把阈值做成可调。
 *
 * ▸ **榜单的本时段清单缓存是 24 小时**（HOT_TTL_MS，见 index.mjs），历史稀有度是 1 个月。
 *   如果检查走缓存，「每 10 分钟看看有没有新鸟」实际上一天都拿到同一份数据，形同虚设。
 *   所以检查要**强制回源**（nocache=1）—— 但那样每 10 分钟就向上游打一次，正撞在这套
 *   服务最怕的 505 风控上。折中办法：前端照常每 10 分钟来问，但服务端设一道
 *   **最短回源间隔**（默认 30 分钟），没到点就直接复用上一轮结果、不回源。
 *   于是实际回源频率是每 30 分钟一次（一天 48 次），而「立即检查」按钮可以强制打破它。
 * ---------------------------------------------------------------------------
 */
import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = 'watch.json';
const STATE_VERSION = 1;

/** 历史记录最多留这么多条，防止无限增长 */
const MAX_HISTORY = 500;

/** 默认阈值：近两年记录数 ≤ 3 视为稀有 */
export const DEFAULT_MAX_HISTORY_COUNT = 3;
/** 阈值允许的范围（界面上给 3 / 10 / 50 / 100 / 300 几档，大范围地区必须往高里调） */
const MIN_MAX_HISTORY_COUNT = 1;
const MAX_MAX_HISTORY_COUNT = 100000;

/** 前端轮询间隔的默认值：10 分钟 */
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
/** 最短回源间隔：默认 30 分钟一次（见文件头对 505 风控的说明） */
export const DEFAULT_MIN_FETCH_GAP_MS = 30 * 60 * 1000;

/** 监听条件的白名单 —— 只认这些键，页面上的 filter / sort / liferUser 之类不进快照 */
const CONDITION_KEYS = [
  'province', 'city', 'district', 'startTime', 'endTime',
  'pointname', 'username', 'taxonid', 'mode', 'version',
];

/** 从 buildWhere 的结果里挑出可监听的条件 */
export function pickConditions(where) {
  const out = {};
  for (const k of CONDITION_KEYS) {
    if (where[k] !== undefined && where[k] !== '') out[k] = String(where[k]);
  }
  return out;
}

function clampInt(v, min, max, fallback) {
  // 注意 Number(null) === 0、Number('') === 0 —— 参数缺席时不能当 0 处理，
  // 否则会被夹到下限（阈值默认 3 会变成 1、间隔默认 10 分钟会变成 1 分钟）。
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function emptyState() {
  return {
    v: STATE_VERSION,
    enabled: false,
    conditions: null,
    label: '',
    maxHistoryCount: DEFAULT_MAX_HISTORY_COUNT,
    intervalMs: DEFAULT_INTERVAL_MS,
    minFetchGapMs: DEFAULT_MIN_FETCH_GAP_MS,
    /** 开启监听时已命中的稀有鸟种（taxonId 数组）：这些不报，用来划出「新出现」的界线 */
    baseline: [],
    /** 已经报过的 taxonId → 首次报出时间，避免同一只鸟反复提醒 */
    alerted: {},
    /** 提醒记录，倒序。这是「历史记录」弹层的数据源 */
    history: [],
    lastCheckAt: 0,
    lastFetchAt: 0,
    lastCheckOk: true,
    lastError: '',
    /** 上一轮检查的结果摘要，用来在界面上说明「为什么没动静」 */
    scanned: 0,
    rareCount: 0,
    minHistoryCount: null,
    createdAt: 0,
  };
}

/**
 * 建一个监听器。状态落在 `<dataDir>/watch.json`（Android 上就是应用私有目录，
 * 所以杀掉应用再打开，基线与历史都还在）。
 *
 * @param {object}   o
 * @param {string}   o.dataDir  数据目录（runtime.mjs 的 DATA_DIR）
 * @param {Function} o.loadHot  取榜单的函数：(conditions, { nocache }) => /api/hot 的结果
 * @param {Function} [o.log]
 */
export function createWatch({ dataDir, loadHot, log = () => {} }) {
  const file = path.join(dataDir, STATE_FILE);
  let state = restore();

  function restore() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || raw.v !== STATE_VERSION) return emptyState();
      return {
        ...emptyState(),
        ...raw,
        baseline: Array.isArray(raw.baseline) ? raw.baseline.map(String) : [],
        alerted: raw.alerted && typeof raw.alerted === 'object' ? raw.alerted : {},
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    } catch {
      // 文件不存在 / 坏了都当第一次跑：宁可丢基线，也不能让服务起不来
      return emptyState();
    }
  }

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      log(`[watch] 状态落盘失败：${e.message}`);
    }
  }

  /** 对外快照：不带 alerted 明细（那是内部去重表），只给个数 */
  function snapshot() {
    return {
      enabled: state.enabled,
      conditions: state.conditions,
      label: state.label,
      maxHistoryCount: state.maxHistoryCount,
      intervalMs: state.intervalMs,
      minFetchGapMs: state.minFetchGapMs,
      baselineCount: state.baseline.length,
      alertedCount: Object.keys(state.alerted).length,
      history: state.history,
      historyShown: state.history.length,
      lastCheckAt: state.lastCheckAt,
      lastCheckOk: state.lastCheckOk,
      lastError: state.lastError,
      scanned: state.scanned,
      rareCount: state.rareCount,
      minHistoryCount: state.minHistoryCount,
      createdAt: state.createdAt,
    };
  }

  /**
   * 开启 / 关闭监听，或改条件与阈值。
   *
   * 开启（以及改条件、改阈值）一律**重建基线**：条件变了，「已经见过的」就不再是同一批，
   * 沿用旧基线会漏报。重建时会立刻回源跑一次，把当下命中的记成基线（这一次不产生提醒）。
   * 历史记录是日志，不因为重开而清空。
   */
  async function configure({ enabled, conditions, label, maxHistoryCount, intervalMs, minFetchGapMs }) {
    if (!enabled) {
      state.enabled = false;
      save();
      return snapshot();
    }
    if (!conditions || !Object.keys(conditions).length) {
      const e = new Error('缺少监听条件');
      e.code = 400;
      throw e;
    }

    state = {
      ...state,
      enabled: true,
      conditions,
      label: label || '',
      maxHistoryCount: clampInt(maxHistoryCount, MIN_MAX_HISTORY_COUNT, MAX_MAX_HISTORY_COUNT, DEFAULT_MAX_HISTORY_COUNT),
      intervalMs: clampInt(intervalMs, 60_000, 24 * 3600_000, DEFAULT_INTERVAL_MS),
      minFetchGapMs: clampInt(minFetchGapMs, 60_000, 24 * 3600_000, DEFAULT_MIN_FETCH_GAP_MS),
      baseline: [],
      alerted: {},
      createdAt: Date.now(),
      lastCheckAt: 0,
      lastCheckOk: true,
      lastError: '',
      scanned: 0,
      rareCount: 0,
      minHistoryCount: null,
    };
    save();
    await check({ baselineMode: true });
    return snapshot();
  }

  /**
   * 跑一轮检查。
   *
   * @param {object} [o]
   * @param {boolean} [o.baselineMode] 只建基线，不产生提醒（开启监听时用）
   * @param {boolean} [o.force]        忽略最短回源间隔，强制回源（「立即检查」按钮用）
   */
  async function check({ baselineMode = false, force = false } = {}) {
    if (!state.enabled || !state.conditions) {
      return { ...snapshot(), newAlerts: [], skipped: true, reason: '未开启监听' };
    }

    const now = Date.now();
    // 没到最短回源间隔就干脆不问上游 —— 照抄缓存的话一天都是同一份数据，没意义；
    // 真回源又太频繁，会撞 505。所以直接跳过，并把「下次大概什么时候」告诉前端。
    const sinceFetch = now - (state.lastFetchAt || 0);
    if (!baselineMode && !force && sinceFetch < state.minFetchGapMs) {
      return {
        ...snapshot(),
        newAlerts: [],
        skipped: true,
        reason: '距上次回源时间太短，本轮只回报状态',
        nextFetchInMs: state.minFetchGapMs - sinceFetch,
      };
    }

    let hot;
    try {
      hot = await loadHot(state.conditions, { nocache: true });
    } catch (e) {
      state.lastCheckAt = now;
      state.lastCheckOk = false;
      state.lastError = e.message || String(e);
      save();
      return { ...snapshot(), newAlerts: [] };
    }

    state.lastCheckAt = now;
    state.lastFetchAt = now;

    if (!hot || hot.unsupported) {
      state.lastCheckOk = false;
      state.lastError =
        hot && hot.needRange ? '「全国」范围需要同时选起始与结束日期' : '当前条件不支持监听';
      state.scanned = 0;
      state.rareCount = 0;
      state.minHistoryCount = null;
      save();
      return { ...snapshot(), newAlerts: [] };
    }

    const list = Array.isArray(hot.list) ? hot.list : [];
    const nums = list.map((x) => Number(x.historyCount)).filter(Number.isFinite);
    state.scanned = list.length;
    state.minHistoryCount = nums.length ? Math.min(...nums) : null;

    // 历史口径没取到时，榜单是退回「按本时段记录数」排的，historyCount 就不可信了。
    // 这一轮不能按阈值筛（会筛出空、看着像「没有稀有鸟」），如实写进 lastError。
    if (!hot.stat || !hot.stat.historyUsed) {
      state.lastCheckOk = false;
      state.lastError = (hot.stat && hot.stat.historyError) || '上游暂时取不到近两年基线，本轮跳过';
      state.rareCount = 0;
      save();
      return { ...snapshot(), newAlerts: [] };
    }

    const rare = list.filter(
      (x) => Number.isFinite(Number(x.historyCount)) && Number(x.historyCount) <= state.maxHistoryCount
    );
    state.rareCount = rare.length;

    if (baselineMode) {
      state.baseline = rare.map((x) => String(x.taxonId));
      state.alerted = {};
      state.lastCheckOk = true;
      state.lastError = '';
      save();
      return { ...snapshot(), newAlerts: [], baselineJustBuilt: true };
    }

    const base = new Set(state.baseline);
    const fresh = rare.filter((x) => !base.has(String(x.taxonId)) && !state.alerted[String(x.taxonId)]);

    const alerts = fresh.map((x) => ({
      ts: now,
      taxonId: String(x.taxonId),
      name: x.name || '',
      latin: x.latin || '',
      /** 本时段记录数 */
      count: Number(x.count) || 0,
      /** 近两年记录数（判定依据） */
      historyCount: Number(x.historyCount) || 0,
      rarity: typeof x.rarity === 'number' ? x.rarity : null,
      chinaLevel: x.chinaLevel || '',
      chinaEndemic: !!x.chinaEndemic,
      iucn: x.iucn || '',
      rank: Number(x.rank) || 0,
      /** 这条提醒是在什么条件下发现的（历史记录里要能看出来） */
      label: state.label,
      conditions: state.conditions,
    }));

    for (const a of alerts) state.alerted[a.taxonId] = now;
    if (alerts.length) state.history = [...alerts, ...state.history].slice(0, MAX_HISTORY);

    state.lastCheckOk = true;
    state.lastError = '';
    save();
    return { ...snapshot(), newAlerts: alerts };
  }

  /** 清空历史记录（基线 / 已提醒表不动，清完不会把旧鸟再报一遍） */
  function clearHistory() {
    state.history = [];
    save();
    return snapshot();
  }

  /** 不看上游，直接拿当前状态（页面刷新时用） */
  function current() {
    return {
      ...snapshot(),
      newAlerts: [],
      skipped: true,
      reason: '仅状态',
      // 让前端知道还有多久才轮到下一次真正回源
      nextFetchInMs: state.enabled ? Math.max(0, state.minFetchGapMs - (Date.now() - (state.lastFetchAt || 0))) : 0,
    };
  }

  return { configure, check, clearHistory, current, file };
}
