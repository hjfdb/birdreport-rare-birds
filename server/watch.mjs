/**
 * 「一直盯着稀有鸟种」的监听器。
 *
 * 需求原话（两轮）：监听做到「我的」设置页面里，一直监听，会随着外部条件修改自动修改监听条件；
 * 我的页面只要设置数量和是否监听就行。**后来改成默认关闭** —— 要用户自己去「我的」里打开。
 *
 * 三条约定（都跟用户对过）：
 *
 *   1) **一直监听、条件自动跟随**：监听条件不是「定格在开启那一刻」，而是跟着页面上选的
 *      地区 / 日期 / 检索条件走 —— 用户换了区县、改了日期，监听条件自动跟着变，
 *      不需要手动重开（见 configure 的 enabled === undefined 那条语义）。
 *      ⚠ 关着的时候页面来同步条件一律**不动开关**（不因为用户翻了个地区就把监听打开）。
 *   2) 「稀有」= 该地区**最近两年记录数 ≤ 阈值**（默认 3）。直接沿用榜单的历史口径，
 *      不另算一套；候选集就是榜单成员（= 本时段出现过）。
 *   3) 条件（或阈值）一变就先重新划一条**起跑线**：把当时命中的一批记成**基线**
 *      （baseline），之后只报基线之外新出现的 —— 否则每轮检查都会把同一批鸟重复报一遍。
 *      重建基线时**保留** `alerted`（报过的鸟不重报）与 `history`（历史记录不清空）。
 *
 * 名词：界面上的「稀有数量」= 这里的 `maxHistoryCount`（早先叫「阈值」，代码里两者同义）。
 * 交互上只有两项可设：「是否监听」（enabled）与「稀有数量」；条件由页面自动跟随，不进设置界面。
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
    /**
     * 默认**关着**：监听要用户自己去「我的」里打开（开了之后条件会跟着页面自动走）。
     * 关着时 conditions 通常也是 null —— 服务端不知道页面在看哪个地区，什么也不做。
     */
    enabled: false,
    conditions: null,
    label: '',
    maxHistoryCount: DEFAULT_MAX_HISTORY_COUNT,
    intervalMs: DEFAULT_INTERVAL_MS,
    minFetchGapMs: DEFAULT_MIN_FETCH_GAP_MS,
    /** 开启监听时已命中的稀有鸟种（taxonId 数组）：这些不报，用来划出「新出现」的界线 */
    baseline: [],
    /**
     * 正在重建基线（改完条件 / 阈值后的那一轮还没跑完）。
     * 这期间**绝不能**产生提醒：基线是空的，当前命中的一整批鸟会被当成「新发现」全报出去。
     * 所以 check() 见到它就跳过本轮，等 runBaseline() 把它摘掉（见该函数注释）。
     */
    baselinePending: false,
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
  /** 内存态：正在跑「建基线」那一轮（不落盘；进程重启后由 baselinePending 兜住） */
  let buildingBaseline = false;

  function restore() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || raw.v !== STATE_VERSION) return emptyState();
      const conditions = raw.conditions && typeof raw.conditions === 'object' ? raw.conditions : null;
      return {
        ...emptyState(),
        ...raw,
        // enabled 只认显式的 true：默认是关的，只有状态文件里明确写着开着才开
        enabled: raw.enabled === true,
        baselinePending: !!raw.baselinePending,
        conditions,
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
      baselinePending: state.baselinePending,
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
   * 配置监听。一个入口覆盖三种语义：
   *
   *   enabled === true       开启（含「开着的时候按新条件 / 新阈值重来一遍」）
   *   enabled === false      关闭（条件留着，历史与已提醒表都不动）
   *   enabled === undefined  **只同步条件，不动开关** ← 页面自动跟随条件走的就是这条
   *
   * 「自动跟随」是这个功能的主用法：页面上换个区县、改个日期，监听条件自动跟着变，
   * 用户不需要手动重开。为了不吓人一跳，条件或阈值一变就**重建基线**（新条件下当场
   * 命中的那一批记成基线、不提醒），但 `alerted` 与 `history` **保留** ——
   * 所以「改条件」既不会把报过的鸟再报一遍，也不会把历史记录清掉。
   *
   * 条件与阈值都没变时**直接返回、不回源**：页面每次查询完都会来同步一次，
   * 每回都真去问上游会白白撞 505 风控。
   *
   * @param {object}  o
   * @param {boolean} [o.enabled]  undefined = 不动开关
   * @param {boolean} [o.defer]    条件变了但**不等**基线建完就返回（自动跟随走这条：
   *                               建基线要真回一次上游、几十秒，不能让页面干等）
   */
  async function configure({
    enabled,
    conditions,
    label,
    maxHistoryCount,
    intervalMs,
    minFetchGapMs,
    defer = false,
  }) {
    if (enabled === false) {
      // 关：把开关落盘就行。条件留着（下次打开不必重设），基线 / 历史 / 已提醒表都不动。
      state.enabled = false;
      save();
      return snapshot();
    }

    // 关着的时候页面来同步条件：什么都不做（「开」的时候页面会把条件一起送过来，
    // 不该因为用户翻了个地区就悄悄把监听打开）
    if (enabled === undefined && !state.enabled) return snapshot();

    if (!conditions || !Object.keys(conditions).length) {
      const e = new Error('缺少监听条件');
      e.code = 400;
      throw e;
    }

    // ⚠ 没给这些参数 = **保持现状**，不是重置成默认值。
    //   页面「自动跟随条件」那次调用只送 conditions / label（见 web/app.js 的 watchSave），
    //   要是把缺省当默认，用户调好的「稀有数量」会被每次查询悄悄打回 3 —— 而且因为
    //   数量变了还会触发一次基线重建，白回一次上游。（route 侧传的是 null，不是 undefined。）
    const nextThreshold =
      maxHistoryCount == null
        ? state.maxHistoryCount
        : clampInt(maxHistoryCount, MIN_MAX_HISTORY_COUNT, MAX_MAX_HISTORY_COUNT, DEFAULT_MAX_HISTORY_COUNT);
    const nextInterval =
      intervalMs == null ? state.intervalMs : clampInt(intervalMs, 60_000, 24 * 3600_000, DEFAULT_INTERVAL_MS);
    const nextGap =
      minFetchGapMs == null
        ? state.minFetchGapMs
        : clampInt(minFetchGapMs, 60_000, 24 * 3600_000, DEFAULT_MIN_FETCH_GAP_MS);
    const nextLabel = label || '';

    const wasOff = !state.enabled;
    const sameCond =
      !!state.conditions && JSON.stringify(state.conditions) === JSON.stringify(conditions);
    // 从「关」到「开」也算变了：重新开启按新条件重新划起跑线，不是把关着那段时间的
    // 新鸟一次性全倒给用户。
    const changed = wasOff || !sameCond || state.maxHistoryCount !== nextThreshold;

    if (!changed) {
      // 只有标签 / 节拍可能变（条件一样、阈值一样），静默更新即可，不回源
      state = {
        ...state,
        enabled: true,
        label: nextLabel,
        intervalMs: nextInterval,
        minFetchGapMs: nextGap,
      };
      save();
      return snapshot();
    }

    state = {
      ...state,
      enabled: true,
      conditions,
      label: nextLabel,
      maxHistoryCount: nextThreshold,
      intervalMs: nextInterval,
      minFetchGapMs: nextGap,
      // 条件（或阈值）变了：「已经见过的」不再是同一批，必须重新划一条起跑线。
      // ⚠ alerted 与 history **不动** —— 报过的鸟不重报、历史记录不清空。
      baseline: [],
      baselinePending: true,
      createdAt: state.createdAt || Date.now(),
      lastCheckAt: 0,
      lastCheckOk: true,
      lastError: '',
      scanned: 0,
      rareCount: 0,
      minHistoryCount: null,
    };
    save();

    const building = runBaseline();
    if (defer) return snapshot(); // 页面自动跟随条件时不等它（几十秒，页面不该卡住）
    await building;
    return snapshot();
  }

  /**
   * 跑那一轮「只建基线」的检查，跑完才摘掉 baselinePending。
   *
   * 这个标记是关键：从 configure 落盘（baseline 已清空）到这一轮真正查到数据之间，
   * 会有一小段空档。这期间若来一次普通 check，基线是空的、`alerted` 里也没有，
   * 当前命中的**一整批**鸟都会被当成「新发现」报出去 —— 正是最坏的一种误报。
   */
  async function runBaseline() {
    buildingBaseline = true;
    try {
      await check({ baselineMode: true });
    } catch (e) {
      log(`[watch] 建基线失败：${e.message}`);
    } finally {
      buildingBaseline = false;
      // 基线**没建成功**（上游取不到 / 历史口径缺失）就继续挂着 pending：
      // 这时基线还是空的，放行普通检查会把当前命中的一整批鸟误报成「新发现」。
      // 下一轮轮询会走 check() 里那条「就地补建基线」的路，不会一直空转。
      state.baselinePending = !state.lastCheckOk;
      save();
    }
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
      return {
        ...snapshot(),
        newAlerts: [],
        skipped: true,
        reason: state.conditions ? '未开启监听' : '还没同步到监听条件',
      };
    }

    // 该建基线了（首次配置 / 条件变了 / 上一轮没建成）：**就地**跑「建基线」那一轮。
    // 正常轮询撞上这个状态也这么处理 —— 只跳过的话，上游一抽风就永远建不出基线，
    // 监听也就永远不提醒。真正在建的时候（buildingBaseline）才跳过，免得并发重复回源。
    if (state.baselinePending && !baselineMode) {
      if (buildingBaseline) {
        return {
          ...snapshot(),
          newAlerts: [],
          skipped: true,
          reason: '正在按新的条件建立基线',
          nextFetchInMs: 0,
        };
      }
      baselineMode = true;
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

    // 记在两个「已经问过上游」的时间点上（**含失败**）：失败也要算掉这一次，
    // 否则上游一抽风，每一轮轮询都会立刻再打一次，正撞在 505 风控上。
    state.lastCheckAt = now;
    state.lastFetchAt = now;

    let hot;
    try {
      hot = await loadHot(state.conditions, { nocache: true });
    } catch (e) {
      state.lastCheckOk = false;
      state.lastError = e.message || String(e);
      save();
      return { ...snapshot(), newAlerts: [] };
    }

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
      // ⚠ 这里**不清** alerted：条件变来变去（今天 ← → 本周、朝阳区 ← → 北京市）时，
      //   「已经报过的那只鸟」不该因为换了条件又被报一遍。历史记录同理，是日志不是缓存。
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
