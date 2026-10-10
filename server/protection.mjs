/**
 * 鸟类保护等级字典。
 *
 * 数据源：观鸟记录中心 /front/taxon/level 接口，字段含义——
 *   china_level : 依据《国家重点保护野生动物名录》(2021) 的等级，如「国家一级」「国家二级」「三有」
 *   iucn        : IUCN 濒危物种红色名录全球等级 (EX/EW/CR/EN/VN/NT/LC/DD/NE)
 *   china_iucn  : 《中国生物多样性红色名录》等级
 *   is_china    : 是否中国特有（"1" / "0"）
 *
 * 该字典变化极少，因此落盘持久化；同时提供并发限流的批量补全与后台预热。
 */
import { LayeredCache, mapLimit } from './cache.mjs';
import { getTaxonLevel, searchTaxons } from './birdreport.mjs';

// 参考数据：与接口结果缓存复用同一套「磁盘 + 内存」策略，但永不过期
const store = new LayeredCache({
  name: 'protection',
  file: 'protection.json',
  ttl: Infinity,
  max: 6000,
  autosaveMs: 3000,
});

/** 已发起但尚未完成的 id，避免重复请求 */
const inflight = new Map();
/** 后台预热进度 */
const progress = { total: 0, done: 0, running: false, startedAt: null, finishedAt: null, errors: 0 };

const CONCURRENCY = 4;
const FETCH_DELAY_MS = 60; // 对上游保持克制

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取单个鸟种的保护等级（命中缓存直接返回；miss 则请求并落盘） */
export async function levelOf(id) {
  const key = String(id);
  const cached = store.entry(key);
  if (cached) return cached.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await getTaxonLevel(id);
      const value = data
        ? {
            china_level: data.china_level || '',
            iucn: data.iucn || '',
            china_iucn: data.china_iucn || '',
            is_china: data.is_china === '1' || data.is_china === 1,
          }
        : { china_level: '', iucn: '', china_iucn: '', is_china: false, missing: true };
      store.set(key, value);
      return value;
    } catch (e) {
      progress.errors += 1;
      return { china_level: '', iucn: '', china_iucn: '', is_china: false, error: e.message };
    } finally {
      inflight.delete(key);
      await sleep(FETCH_DELAY_MS);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * 批量补全保护等级。已缓存的立即返回，未缓存的并发拉取。
 * @param {number[]} ids
 * @param {object} opts
 * @param {number} opts.limit 最多补全多少个（超出部分标记 pending，避免首屏等待过久）
 * @param {boolean} opts.wait 是否等待全部完成（false 时先返回已有数据）
 */
export async function ensureLevels(ids, { limit = 120, wait = true } = {}) {
  const uniq = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n)))];
  const missing = uniq.filter((id) => store.peek(String(id)) === undefined);
  const pending = missing.slice(limit);
  const toFetch = missing.slice(0, limit);

  const run = mapLimit(toFetch, CONCURRENCY, (id) => levelOf(id));
  if (wait) await run;
  else run.catch(() => {});

  const result = {};
  for (const id of uniq) {
    const v = store.peek(String(id));
    if (v) result[id] = v;
  }
  // 剩余部分丢到后台慢慢补
  if (pending.length) {
    queueBackground(pending);
  }
  return { levels: result, pending: pending.length };
}

/** 只读取已缓存的保护等级，不发请求 */
export function readCachedLevels(ids) {
  const out = {};
  for (const id of new Set(ids.map(Number))) {
    const v = store.peek(String(id));
    if (v) out[id] = v;
  }
  return out;
}

/* --------------------------- 后台预热 --------------------------- */

let queue = [];
let draining = false;

function queueBackground(ids) {
  const set = new Set(queue);
  for (const id of ids) {
    if (store.peek(String(id)) === undefined && !set.has(id)) queue.push(id);
  }
  if (!draining) drain();
}

async function drain() {
  draining = true;
  try {
    while (queue.length) {
      const batch = queue.splice(0, 60);
      await mapLimit(batch, CONCURRENCY, (id) => levelOf(id));
    }
  } catch (e) {
    console.error('[protection] 后台补全异常：', e.message);
  } finally {
    draining = false;
  }
}

/** 预热全部鸟种名录的保护等级（首次运行耗时较长，仅后台执行） */
export async function warmUpAll() {
  if (progress.running) return progress;
  progress.running = true;
  progress.startedAt = Date.now();
  try {
    const r = await searchTaxons({});
    const ids = (r.data || []).map((t) => t.id);
    const missing = ids.filter((id) => store.peek(String(id)) === undefined);
    progress.total = ids.length;
    progress.done = ids.length - missing.length;
    await mapLimit(missing, CONCURRENCY, async (id) => {
      await levelOf(id);
      progress.done += 1;
    });
  } catch (e) {
    progress.error = e.message;
  } finally {
    progress.running = false;
    progress.finishedAt = Date.now();
    store.save();
  }
  return progress;
}

export function protectionStatus() {
  return {
    cached: store.size,
    queue: queue.length,
    inflight: inflight.size,
    cache: store.info(),
    ...progress,
  };
}

/** 进程退出前落盘 */
export function flushProtection() {
  store.save();
}

export const PROTECTION_LABELS = {
  china_level: {
    国家一级: { short: '国一', level: 1, color: '#d92b2b' },
    国家二级: { short: '国二', level: 2, color: '#e8730c' },
    三有: { short: '三有', level: 3, color: '#2f7fd6' },
  },
  iucn: {
    EX: { label: '绝灭', level: 1, color: '#7a1f1f' },
    EW: { label: '野外绝灭', level: 1, color: '#7a1f1f' },
    CR: { label: '极危', level: 2, color: '#d92b2b' },
    EN: { label: '濒危', level: 3, color: '#e8730c' },
    VU: { label: '易危', level: 4, color: '#d8a708' },
    NT: { label: '近危', level: 5, color: '#8a8f2e' },
    LC: { label: '无危', level: 6, color: '#3f9a55' },
    DD: { label: '数据缺乏', level: 7, color: '#8a8f99' },
    NE: { label: '未评估', level: 7, color: '#8a8f99' },
    NR: { label: '未认可', level: 7, color: '#8a8f99' },
  },
};
