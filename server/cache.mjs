/**
 * 统一缓存策略：磁盘持久化 + 启动读入内存 + TTL 过期。
 *
 * 一套策略服务全部场景，避免各处各写一套：
 *   - 接口结果缓存（观鸟榜单 / 统计 / 趋势）：TTL 10 分钟，重启后仍可复用
 *   - 保护等级字典（参考数据）：TTL 无限，长期复用
 *
 * 工作方式：
 *   写入 → 落内存 Map，并防抖写盘（<数据目录>/<file>）
 *   读取 → 直接命中内存；内存里没有的条目会在启动时从磁盘整体读入
 *   过期 → 读取时惰性判定，启动加载与定期清理时批量剔除
 *
 * 数据目录由 runtime.mjs 决定：源码方式在项目 data/ 下，
 * 打包成 exe 后没有项目目录，落在 exe 同级（详见 runtime.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './runtime.mjs';

const FILE_VERSION = 1;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class LayeredCache {
  /**
   * @param {object}  opts
   * @param {number}  opts.ttl         条目默认有效期（毫秒），Infinity 表示永不过期
   * @param {number}  opts.max         内存中最多保留多少条（超出按最久未使用淘汰）
   * @param {string}  opts.file        数据目录下的持久化文件名；不传则纯内存
   * @param {number}  opts.autosaveMs  写盘防抖间隔
   * @param {string}  opts.name        日志 / 统计用的名字
   */
  constructor({ ttl = 10 * 60 * 1000, max = 2000, file = null, autosaveMs = 3000, name = 'cache' } = {}) {
    this.ttl = ttl;
    this.max = max;
    this.name = name;
    this.file = file ? path.join(DATA_DIR, file) : null;
    this.autosaveMs = autosaveMs;

    /** key -> { v: 值, t: 写入时间戳, ttl?: 该条目自己的有效期（不填用实例默认） } */
    this.mem = new Map();
    this.dirty = false;
    this.timer = null;
    this.pending = new Map();

    this.stats = { hit: 0, miss: 0, expired: 0, evicted: 0, loaded: 0, savedAt: null, savedCount: 0 };

    this.#loadFromDisk();
  }

  /* ----------------------------- 磁盘 ----------------------------- */

  #loadFromDisk() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 兼容两种格式：{version, entries:{k:{t,v}}} 与早期的纯 {k:v}
      const entries = raw && raw.entries && typeof raw.entries === 'object' ? raw.entries : raw;
      const now = Date.now();
      for (const [key, item] of Object.entries(entries || {})) {
        if (item && typeof item === 'object' && 'v' in item) {
          const ttl = item.ttl === undefined || item.ttl === null ? this.ttl : item.ttl;
          if (now - (item.t || 0) <= ttl) this.mem.set(key, { v: item.v, t: item.t || now, ttl: item.ttl ?? null });
          else this.stats.expired += 1;
        } else {
          // 早期格式：无时间戳，直接读入并记为刚写入
          this.mem.set(key, { v: item, t: now, ttl: null });
        }
      }
      this.stats.loaded = this.mem.size;
      if (this.mem.size) {
        console.log(`[cache:${this.name}] 已从本地读入 ${this.mem.size} 条缓存（${path.basename(this.file)}）`);
      }
    } catch (e) {
      console.error(`[cache:${this.name}] 读取本地缓存失败：${e.message}`);
      this.mem.clear();
    }
  }

  #scheduleSave() {
    this.dirty = true;
    if (!this.file || this.autosaveMs <= 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), this.autosaveMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** 立即落盘（原子替换） */
  save() {
    if (!this.file || !this.dirty) return false;
    try {
      ensureDir();
      const entries = {};
      for (const [key, item] of this.mem) entries[key] = { t: item.t, v: item.v, ttl: item.ttl ?? null };
      const payload = { version: FILE_VERSION, name: this.name, savedAt: Date.now(), entries };
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(payload));
      fs.renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
      this.stats.savedAt = Date.now();
      this.stats.savedCount = this.mem.size;
      return true;
    } catch (e) {
      console.error(`[cache:${this.name}] 写入本地缓存失败：${e.message}`);
      return false;
    }
  }

  /* ----------------------------- 读写 ----------------------------- */

  /** 读取条目元信息：命中返回 {value, storedAt, ageMs}，未命中/已过期返回 null */
  entry(key, now = Date.now()) {
    const hit = this.mem.get(key);
    if (!hit) {
      this.stats.miss += 1;
      return null;
    }
    const age = now - hit.t;
    // 条目可以带自己的 ttl（例如「降级结果只缓存 60 秒」），否则用实例默认
    const ttl = hit.ttl === undefined || hit.ttl === null ? this.ttl : hit.ttl;
    if (age > ttl) {
      this.mem.delete(key);
      this.stats.expired += 1;
      this.stats.miss += 1;
      this.#scheduleSave();
      return null;
    }
    // LRU 触碰
    this.mem.delete(key);
    this.mem.set(key, hit);
    this.stats.hit += 1;
    return { value: hit.v, storedAt: hit.t, ageMs: age };
  }

  get(key) {
    const e = this.entry(key);
    return e ? e.value : undefined;
  }

  has(key) {
    return this.entry(key) !== null;
  }

  /** 只探测、不计数、不触碰 LRU —— 适合批量判断「有没有」的场景 */
  peek(key, now = Date.now()) {
    const hit = this.mem.get(key);
    if (!hit) return undefined;
    const ttl = hit.ttl === undefined || hit.ttl === null ? this.ttl : hit.ttl;
    if (now - hit.t > ttl) return undefined;
    return hit.v;
  }

  /**
   * @param {number} [opts.ttl] 该条目单独的有效期；传 0 或负数表示「不缓存」
   */
  set(key, value, { ttl } = {}) {
    if (ttl !== undefined && ttl <= 0) return value; // 显式不缓存
    // 超出容量时淘汰最久未使用的一条
    if (this.mem.size >= this.max) {
      const oldest = this.mem.keys().next().value;
      if (oldest !== undefined) {
        this.mem.delete(oldest);
        this.stats.evicted += 1;
      }
    }
    this.mem.set(key, { v: value, t: Date.now(), ttl: ttl ?? null });
    this.#scheduleSave();
    return value;
  }

  /**
   * 取缓存或执行 loader。同一 key 的并发请求会合并为一次上游调用。
   * @param {number} [opts.ttl] 写入时该条目单独的有效期（用于「降级结果只短暂缓存」）
   * @returns {Promise<{value:any, cached:boolean, storedAt:number, ageMs:number}>}
   */
  async wrap(key, loader, { ttl } = {}) {
    const hit = this.entry(key);
    if (hit) return { ...hit, cached: true };

    if (this.pending.has(key)) {
      const value = await this.pending.get(key);
      const e = this.entry(key);
      return { value, cached: !!e, storedAt: e?.storedAt ?? Date.now(), ageMs: e?.ageMs ?? 0 };
    }

    const p = (async () => {
      try {
        const value = await loader();
        this.set(key, value, { ttl });
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    const value = await p;
    const e = this.entry(key);
    return { value, cached: false, storedAt: e?.storedAt ?? Date.now(), ageMs: 0 };
  }

  delete(key) {
    const ok = this.mem.delete(key);
    if (ok) this.#scheduleSave();
    return ok;
  }

  clear({ persist = true } = {}) {
    this.mem.clear();
    this.pending.clear();
    this.stats.expired = 0;
    this.stats.evicted = 0;
    this.dirty = true;
    if (persist) this.save();
    return true;
  }

  /** 剔除全部过期条目（可定期调用） */
  prune(now = Date.now()) {
    let n = 0;
    for (const [key, item] of this.mem) {
      const ttl = item.ttl === undefined || item.ttl === null ? this.ttl : item.ttl;
      if (now - item.t > ttl) {
        this.mem.delete(key);
        n += 1;
      }
    }
    if (n) {
      this.stats.expired += n;
      this.#scheduleSave();
    }
    return n;
  }

  get size() {
    return this.mem.size;
  }

  /** 供 /api/health 等展示 */
  info() {
    const total = this.stats.hit + this.stats.miss;
    return {
      name: this.name,
      file: this.file ? path.basename(this.file) : null,
      ttlMs: this.ttl === Infinity ? null : this.ttl,
      ttlText: this.ttl === Infinity ? '永不过期' : `${Math.round(this.ttl / 60000)} 分钟`,
      size: this.mem.size,
      max: this.max,
      dirty: this.dirty,
      hit: this.stats.hit,
      miss: this.stats.miss,
      hitRate: total ? +(this.stats.hit / total).toFixed(3) : null,
      loadedFromDisk: this.stats.loaded,
      evicted: this.stats.evicted,
      expired: this.stats.expired,
      savedAt: this.stats.savedAt,
      savedCount: this.stats.savedCount,
    };
  }
}

/** 并发限流执行器 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { __error: e.message };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export { DATA_DIR };
