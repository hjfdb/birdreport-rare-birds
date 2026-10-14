/**
 * 中国观鸟记录中心（www.birdreport.cn）接口客户端
 *
 * 该站点所有接口都走同一套保护机制：
 *   1. 请求体：对「按 key 升序排列后的 JSON 字符串」做 RSA(PKCS#1 v1.5) 加密，
 *      超过 117 字节时分块加密再拼接；报文需 URL 形式提交。
 *   2. 请求头：timestamp / requestId / sign，其中 sign = MD5(json + requestId + timestamp)。
 *   3. 响应体：{ code, count, data }，data 为 AES-256-CBC 密文（base64），
 *      key / iv 由站点前端 aes.util.js 的扰码表还原而来。
 *
 * 本模块仅依赖 Node 内置模块，零第三方依赖。
 */
import crypto from 'node:crypto';

const API_ORIGIN = 'https://api.birdreport.cn';
const WEB_ORIGIN = 'https://www.birdreport.cn';

// 由 https://www.birdreport.cn/assets/js/aes.util.js 还原（getMapping 还原后的明文）
const AES_KEY = 'C8EB5514AF5ADDB94B2207B08C66601C';
const AES_IV = '55DD79C6F04E1A67';
// 由 https://www.birdreport.cn/assets/js/jqueryAjax.js 提取
const RSA_PUBLIC_KEY_B64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCvxXa98E1uWXnBzXkS2yHUfnBM6n3PCwLdfIox03T91joBvjtoDqiQ5x3tTOfpHs3LtiqMMEafls6b0YWtgB1dse1W5m+FpeusVkCOkQxB4SZDH6tuerIknnmB/Hsq5wgEkIvO5Pff9biig6AyoAkdWpSek/1/B7zYIepYY0lxKQIDAQAB';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const rsaKey = crypto.createPublicKey({
  key: Buffer.from(RSA_PUBLIC_KEY_B64, 'base64'),
  format: 'der',
  type: 'spki',
});

const uuid = () => 'xxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

/** 站点前端的签名规则：按 key 升序排序后 JSON 序列化 */
function sortedJson(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    out[k] = v === undefined || v === null ? '' : String(v);
  }
  return JSON.stringify(out);
}

/** RSA 分块加密（1024bit 密钥单块最多 117 字节明文） */
function rsaEncryptLong(plain) {
  const buf = Buffer.from(plain, 'utf8');
  const MAX = 117;
  const blocks = [];
  for (let i = 0; i < buf.length; ) {
    let end = Math.min(i + MAX, buf.length);
    // 不切断 UTF-8 多字节字符
    while (end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
    blocks.push(crypto.publicEncrypt({ key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING }, buf.subarray(i, end)));
    i = end;
  }
  return Buffer.concat(blocks).toString('base64');
}

function aesDecrypt(b64) {
  const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(AES_KEY, 'utf8'), Buffer.from(AES_IV, 'utf8'));
  return d.update(b64, 'base64', 'utf8') + d.final('utf8');
}

/** 调用接口（自动签名 + 解密） */
export async function api(path, params = {}, { retries = 2, timeout = 25000 } = {}) {
  const body = sortedJson(params);
  const requestId = uuid();
  const timestamp = String(Date.now());
  const payload = rsaEncryptLong(body + '\u0000');
  const sign = crypto.createHash('md5').update(body + requestId + timestamp).digest('hex');

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(API_ORIGIN + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Origin: WEB_ORIGIN,
          Referer: WEB_ORIGIN + '/',
          'User-Agent': USER_AGENT,
          requestId,
          sign,
          timestamp,
        },
        body: payload,
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`接口 ${path} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`);
      }
      // 站点部分接口直接返回裸数组 / 裸对象，这里统一归一化
      if (Array.isArray(json)) {
        json = { code: 0, success: true, count: json.length, data: json };
      } else if (json && typeof json === 'object' && json.data === undefined && json.code === undefined) {
        json = { code: 0, success: json.success !== false, data: json };
      }
      if (typeof json.data === 'string' && json.data.length > 0) {
        try {
          json.data = JSON.parse(aesDecrypt(json.data));
        } catch (e) {
          json.decryptError = e.message;
        }
      }
      if (json.success === false && json.msg && String(json.msg).includes('签名')) {
        throw new Error(`接口 ${path} 签名校验失败`);
      }
      // 站点风控 / 服务端异常：返回 {code:505|405|500, success:false} 且不带 data。
      // 两个要点：
      //   1) 这类响应绝不能被当成「空结果」写进缓存，否则页面会在整个 TTL 内一直显示 0；
      //   2) 上游返回明确业务错误码时**不要重试**——500 往往要 20 秒才吐出来，
      //      重试 3 次会把一次失败拖成一分钟的等待，而重试并不能让它变好。
      if (json.success === false && json.data === undefined) {
        const code = json.code ?? '?';
        const hint =
          code === 500
            ? '，通常是查询范围过大，请缩小时间或地区范围'
            : code === 505 || code === 405
              ? '，可能访问过于频繁，请稍后重试'
              : '';
        // 上游的 msg 里常带官方原话（例如「请访问 xxx 输入验证码」），比我们自己猜的提示更有用，
        // 所以透传出去；但要截断，别让一整页 HTML 灌进前端提示条。
        const raw = typeof json.msg === 'string' ? json.msg.replace(/\s+/g, ' ').trim() : '';
        const tail = raw && raw.length <= 160 && !/[<>]/.test(raw) ? `｜上游说明：${raw}` : '';
        const err = new Error(`上游返回异常（code ${code}）${hint}${tail}`);
        err.noRetry = true;
        throw err;
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (e.noRetry) break; // 触发风控时重试只会更糟
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * 业务接口封装
 * ------------------------------------------------------------------ */

/** 省级行政区字典 */
export const getProvinces = () => api('/front/system/adcode/province', {});

/** 地级行政区字典 */
export const getCities = (provinceCode) => api('/front/system/adcode/city', { province_code: provinceCode });

/** 区县字典 */
export const getDistricts = (cityCode) => api('/front/system/adcode/district', { city_code: cityCode });

/** 鸟种名录检索（不传条件返回全部 3098 条物种） */
export const searchTaxons = (params = {}) => api('/front/taxon/search', params);

/**
 * 区域鸟种清单 + 各鸟种记录数（上游叫「热门度」，本项目反向用作稀有度）
 *
 * opts.timeout 可单独放宽上游超时：全国口径的「最近两年」聚合实测要 20 秒，
 * 贴着默认的 25 秒上限，留出的余量太小（见 historyLoader）。
 */
export const getRegionTaxons = (where, { limit = 2000, page = 1, timeout } = {}) =>
  api('/front/record/activity/taxon', { ...where, page, limit }, timeout ? { timeout } : {});

/** 区域基础统计：鸟种数 / 目数 / 科数 */
export const getTaxonNum = (where) => api('/front/record/taxon/num', where);

/** 区域报告数统计 */
export const getReportNum = (where) => api('/front/record/activity/reportNum', where);

/** 区域记录汇总（记录条数 / 报告数 / 鸟种数，含公私有拆分） */
export const getRecordSummary = (where) => api('/front/record/chart/summary', where);

/** 逐月鸟种数曲线 */
export const getTaxonCountBar = (where) => api('/front/record/search/TaxonCountBar', where);

/** 逐月报告数曲线 */
export const getReportCountBar = (where) => api('/front/record/search/ReportCountBar', where);

/** 各省鸟种数（地图/排行数据），version: CH4 | G3 */
export const getProvinceChart = (params = {}) => api('/front/province/summary/chart', params);

/** 指定省下各地市鸟种数 */
export const getCityChart = (params) => api('/front/province/summary/chartCity', params);

/** 指定市下各区县鸟种数 */
export const getDistrictChart = (params) => api('/front/province/summary/chartDistrict', params);

/** 记录明细（地区维度：按条件里给的 province / 时间等查） */
export const searchRecords = (where, { limit = 20, page = 1 } = {}) =>
  api('/front/record/activity/search', { ...where, page, limit });

/**
 * 记录明细（用户维度）：某个用户名**公开过**的观鸟报告，不需要 province。
 *
 * 实测（2026-10-14，用户 kkia，limit=1 只读 count）：
 *   只发 {username, mode, version}              → 89 份
 *   再显式带上官网那套完整空键（taxonid/province/city/… 全为 ''）→ 89 份（一模一样）
 *   → 所以**完整键集不是必须的**，官网发全了只是它的表单会把所有字段都序列化出来。
 *     早期「记录明细必须带 province」的判断是误读 —— 那次失败真正的原因是上游风控
 *     返回的 code 505，跟缺参数无关。
 *
 * `outside_type` 决定疑问数据的取舍（互斥的记录级拆分，实测 88 + 1 = 89）：
 *   '' 或 不填 → 全部（含被标疑的报告）   0 → 只看正常   1 → 只看疑问
 * 报告列表要两类都列出（有疑问的把观鸟点标红），所以这里发 '' 而不是照抄官网的 0 ——
 * 抄了 0 会静悄悄少掉那 1 份有疑问的报告。
 *
 * `mode: '1'` 必须有：模糊匹配会把名字里含同一子串的**别人的**报告也算进来。
 * `version: 'CH4'` 与「人生鸟种」同口径（郑四分类）。
 */
export const searchUserRecords = (username, { limit = 20, page = 1 } = {}) =>
  api('/front/record/activity/search', {
    username,
    mode: '1',
    version: 'CH4',
    // 空字符串 = 不按疑问与否过滤（见上面实测）；行里的 outside_count 再告诉我们
    // 每一份报告具体有几条疑问记录，用来标红。
    outside_type: '',
    page,
    limit,
  });

/** 单份观鸟报告的基本信息（观鸟点 / 时段 / 记录人 / 备注等），按 reportId 查 */
export const getActivity = (reportId) => api('/front/activity/get', { reportId });

/** 单份观鸟报告的鸟种清单（含数量与是否被上游标疑），一次取全 */
export const getActivityTaxons = (reportId) =>
  api('/front/activity/taxon', { reportId, page: 1, limit: 1500 });

/**
 * 用户的「加新时间线」：每个时间点 + 当时加新的鸟种（带地点）。
 * ⚠ 实测只覆盖**今年**：year / startTime / start_time 等参数都会被忽略。
 */
export const getMemberTimeline = (memberId) =>
  api('/front/record/year/taxon/member/timeline', { member_id: memberId });

/**
 * 单份报告里某个鸟种的记录图片（站点报告页「图片」列点开的内容）。
 * @param activityId 报告的数字 id（activity/get 的 id 字段）
 */
export const getReportTaxonImages = (activityId, taxonId) =>
  api('/front/member/image/reportTaxonImage', { report_id: activityId, taxon_id: taxonId });

/**
 * 鸟种保护等级（国家重点保护 / IUCN / 中国生物多样性红色名录 / 是否中国特有）
 * @returns {Promise<{taxon_id:number, china_level?:string, iucn?:string, china_iucn?:string, is_china?:string}>}
 */
export const getTaxonLevel = async (id) => {
  const r = await api('/front/taxon/level', { id });
  return r.success ? r.data : null;
};
