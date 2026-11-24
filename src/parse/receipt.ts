import { toCents } from '../money.js';
import { rowsOf, type OcrDoc, type OcrItem } from '../ocr.js';
import { parseStamp } from './when.js';

export type Kind = 'expense' | 'income' | 'refund' | 'transfer' | 'repay';
/** 没把握的字段。hard = 影响金额口径，必须用户确认后才计入统计 */
export interface Flag { field: 'amount' | 'kind' | 'merchant' | 'time' | 'method' | 'category' | 'evidence'; hard: boolean; reason: string; candidates?: number[] }
export interface ListRow { currency?: string; amount: number | null; kind: Kind; direction: string; merchant: string; ms: number | null; precise: boolean; note: string; skip: boolean; sure: boolean }
export interface TradeId { type: 'trade' | 'order' | 'mch'; no: string }
export interface Receipt {
  doc: 'voucher' | 'order' | 'sms' | 'list' | 'text' | 'none';
  platform: string; kind: Kind; direction: string;
  amount: number | null; sure: boolean; currency: string;
  merchant: string; merchantSure: boolean; item: string;
  ms: number | null; precise: boolean; method: string; ids: TradeId[];
  flags: Flag[]; rows?: ListRow[]; voice?: boolean; /** 场景提示：外卖 / 打车 */ hint?: string; /** 备注类文字 */ note?: string;
}
export const blank = (doc: Receipt['doc'] = 'none'): Receipt => ({ doc, platform: '', kind: 'expense', direction: '', amount: null, sure: false, currency: 'CNY', merchant: '', merchantSure: false, item: '', ms: null, precise: false, method: '', ids: [], flags: [] });

// ───────── 金额 ─────────
const CUR: Record<string, string> = { '¥': 'CNY', '￥': 'CNY', 人民币: 'CNY', RMB: 'CNY', CNY: 'CNY', 元: 'CNY', 'US$': 'USD', $: 'USD', USD: 'USD', 美元: 'USD', 'HK$': 'HKD', HKD: 'HKD', 港币: 'HKD', 港元: 'HKD', 'NT$': 'TWD', TWD: 'TWD', '€': 'EUR', EUR: 'EUR', 欧元: 'EUR', '£': 'GBP', GBP: 'GBP', 英镑: 'GBP', JPY: 'JPY', 日元: 'JPY', KRW: 'KRW', 韩元: 'KRW', THB: 'THB', 泰铢: 'THB', SGD: 'SGD', AUD: 'AUD', MOP: 'MOP' };
const SYM = 'US\\$|HK\\$|NT\\$|[¥￥$€£]|人民币|RMB|CNY|USD|HKD|TWD|EUR|GBP|JPY|KRW|THB|SGD|AUD|MOP';
const UNIT = '元|美元|港币|港元|日元|欧元|英镑|韩元|泰铢|RMB|CNY|USD|HKD|EUR|GBP|JPY|KRW|THB|SGD|AUD';
const MONEY = new RegExp(`([+\\-−–—－]?)\\s*(${SYM})?\\s*([+\\-−–—－]?)\\s*(\\d{1,3}(?:[,，]\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?(?![\\d])(?:\\s*(${UNIT}))?`, 'g');
export interface Money { cents: number; sign: '' | '+' | '-'; currency: string; explicit: boolean; decimals: boolean; index: number; end: number }
export function findMoney(s: string): Money[] {
  // OCR 常把 ¥ 读成 Y / 羊 / 半
  const t = s.replace(/(?<![A-Za-z0-9])[Y羊](?=\s*\d+\.\d{2}(?!\d))/g, '¥').replace(/[．]/g, '.');
  const out: Money[] = [];
  for (const m of t.matchAll(MONEY)) {
    const lead = m[0].length - m[0].trimStart().length, index = m.index + lead, end = m.index + m[0].length;
    const digitsAt = m.index + m[0].indexOf(m[4]!), before = t[digitsAt - 1] ?? '', after = t[end] ?? '';
    const sym = m[2] ?? '', unit = m[6] ?? '', decimals = m[5] !== undefined;
    if (!sym && !decimals && !unit) continue;
    if (!sym && /[\d.:：/*xX×A-Za-z]/.test(before)) continue;
    if (/[:：/%％折*]/.test(after) || /^\s*(?:折|公里|km|kg|分钟|小时|[:：]\d)/i.test(t.slice(end)) || (/^\.\d/.test(t.slice(end)))) continue;
    const cents = toCents(`${m[4]!.replace(/，/g, ',')}${decimals ? '.' + m[5] : ''}`);
    if (cents === null || cents > 1e11) continue;
    const sg = m[1] || m[3] || '';
    // 「2026-11-03」「A-28.00」里的横线不是负号
    const real = sg && !/[\dA-Za-z\p{Script=Han}]/u.test(t[index - 1] ?? '') ? (sg === '+' ? '+' : '-') : sg && m[3] ? (sg === '+' ? '+' : '-') : '';
    out.push({ cents, sign: real as Money['sign'], currency: CUR[sym] ?? CUR[unit] ?? 'CNY', explicit: !!(sym || unit), decimals, index, end });
  }
  return out;
}

type Role = 'paid' | 'due' | 'refund' | 'discount' | 'fee' | 'total' | 'original' | 'ignore' | 'repay' | 'transfer';
const ROLES: [Role, RegExp][] = [
  ['ignore', /余额(?!宝?支付|付款)|可用|剩余|积分|金豆|成长值|额度|应还|待还|最低还款|账单金额|人均|起送|每公里|节省|返现|奖励金?$|会员价|预估|预计|尾款|定金|押金/],
  ['refund', /退款(?:总|金)?额|退款总计|实退|退回金额|已退款?$|退款$/],
  ['repay', /还款金额|还款总额/],
  ['transfer', /转账金额|提现金额|充值金额/],
  ['paid', /实付|实际(?:支付|付款)|(?:支付|付款|消费|交易|扣款|支出|成交|结算)(?:总|金)?额|已支付|已付款?|成功(?:支付|付款)|本次支付|付款总额|在线支付$|微信支付$|支付宝$|实收|支付\s*[:：]?$|付款\s*[:：]?$/],
  ['due', /需付|应付|待付|待支付|还需支付|需支付/],
  ['discount', /优惠|立减|满减|红包|抵扣|折扣|券|补贴|减免|已省|为您省|共省|津贴|随机减|返还|抵用|金币/],
  ['fee', /运费|配送费|打包费|包装费|服务费|手续费|餐盒|里程费|时长费|起步价|附加费|高速费|停车费/],
  ['original', /原价|商品(?:总价|金额|总额|合计)|订单金额|应收|划线|吊牌|标价|菜品|市场价/],
  ['total', /合计|总计|共计|总价|总额|小计|订单总|实际?总|总\s*[:：]?$/],
];
const roleOf = (label: string): Role | null => { for (const [r, re] of ROLES) if (re.test(label)) return r; return null; };

// ───────── 标签 → 值 ─────────
const LABELS = {
  time: /^(?:支付时间|付款时间|交易时间|消费时间|转账时间|退款时间|到账时间|退款到账时间|还款时间|收款时间|交易日期|完成时间|入账时间|创建时间|下单时间|上车时间|订单时间|时间|日期|成交时间)$/,
  merchant: /^(?:商户名称|交易商户|商户|商家|店铺|店铺名称|商家名称|收款方|收款商户|收款单位|交易对方|对方户名|付款给|消费商户|商户简称|门店|门店名称|收款人|对方账户|付款方)$/,
  full: /^(?:商户全称|收款方全称|商家全称)$/,
  item: /^(?:商品|商品说明|商品名称|商品信息|转账备注|备注|摘要|交易摘要|转账说明|收款方备注|付款说明)$/,
  method: /^(?:支付方式|付款方式|付款账户|扣款账户|支付账户|付款卡号|支付渠道|收款方式|付款银行|退款方式|退款至|退回账户|支付信息|交易账户|交易卡号|卡号)$/,
  trade: /^(?:交易单号|交易号|交易流水号|流水号|支付单号|支付流水号|转账单号|退款单号|支付交易号|微信单号)$/,
  order: /^(?:订单号|订单编号|订单号码|订单ID|单号)$/,
  mch: /^(?:商户单号|商家订单号|商户订单号|商户订单编号)$/,
  state: /^(?:当前状态|交易状态|订单状态|状态)$/,
};
type L = keyof typeof LABELS;
const labelOf = (s: string): L | null => { const k = s.replace(/[\s:：]/g, ''); for (const [n, re] of Object.entries(LABELS)) if (re.test(k)) return n as L; return null; };
interface KV { key: L; label: string; value: string; c: number; row: number }

function pairs(rows: OcrItem[][]): KV[] {
  const out: KV[] = [];
  rows.forEach((row, i) => {
    let j = 0;
    while (j < row.length) {
      const it = row[j]!;
      let key = labelOf(it.t), label = it.t, value = '', c = it.c, vx = -1, vw = 0, valueRow = i;
      if (!key) {
        // 「支付时间：2026…」连在一个文字块里
        const m = /^([\p{Script=Han}ID]{2,7})\s*[:：]\s*(.+)$/u.exec(it.t) ?? /^(支付时间|付款时间|交易时间|下单时间|创建时间|订单编号|订单号|交易单号)\s*([\dA-Z].+)$/.exec(it.t) ?? /^(支付方式|付款方式|收款方|商户名称)\s*(.+)$/.exec(it.t);
        if (m && (key = labelOf(m[1]!))) { label = m[1]!; value = m[2]!; vx = it.x; }
      } else {
        const rest = row.slice(j + 1).filter((x) => !labelOf(x.t));
        if (rest.length) { value = rest.map((x) => x.t).join(' '); c = Math.min(...rest.map((x) => x.c)); vx = rest[0]!.x; vw = rest.at(-1)!.x + rest.at(-1)!.w; j = row.length; }
        else { // 上下排列：标签在上，值在下一行左对齐
          const nx = rows[i + 1];
          if (nx?.length === 1 && !labelOf(nx[0]!.t) && Math.abs(nx[0]!.x - it.x) < it.h && nx[0]!.y - it.y < it.h * 3) { valueRow = i + 1; value = nx[0]!.t; c = nx[0]!.c; vx = nx[0]!.x; vw = vx + nx[0]!.w; }
        }
      }
      if (key && value) {
        if (key === 'trade' || key === 'order' || key === 'mch') {
          value = value.replace(/复制|\s/g, '');
          // 单号折行：后续行只有一小段数字字母，且在值列里
          for (let k = valueRow + 1; k < rows.length && k <= valueRow + 2; k++) {
            const r = rows[k]!;
            if (r.length === 1 && vx >= 0 && r[0]!.x >= vx - r[0]!.h && /^[0-9A-Za-z]{1,24}$/.test(r[0]!.t.replace(/复制|\s/g, '')) && /^[0-9A-Za-z_-]{14,}$/.test(value) && (vw === 0 || r[0]!.x + r[0]!.w <= vw + r[0]!.h) && r[0]!.y - rows[k - 1]![0]!.y < r[0]!.h * 2.6) value += r[0]!.t.replace(/复制|\s/g, '');
            else break;
          }
          if (!/^[0-9A-Za-z_-]{6,64}$/.test(value)) { const m = /[0-9A-Za-z_-]{10,64}/.exec(value); value = m ? m[0] : ''; }
        }
        // 长串数字里混进的 O/I/l 是 OCR 误读
        if (value && /^(?=.*\d)[\dOoIl]{10,}$/.test(value) && ['trade', 'order', 'mch'].includes(key)) value = value.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
        if (value) out.push({ key, label: label.replace(/[\s:：]/g, ''), value: value.trim(), c, row: i });
      }
      j++;
    }
  });
  return out;
}

// ───────── 其它字段 ─────────
const tidy = (s: string) => s.replace(/(?<=\p{Script=Han})\s+(?=[\p{Script=Han}（(])/gu, '').replace(/[>＞》〉›]+$/, '').replace(/^[<＜《]+/, '').trim();
const cleanMerchant = (s: string) => tidy(s).replace(/[-—－一]\s*退款$/, '').replace(/^退款\s*[-—－]\s*/, '').replace(/^(?:财付通|支付宝|微信支付|云闪付|美团支付|抖音支付|京东支付)\s*[-—－]\s*/, '').replace(/^付款给\s*/, '').replace(/\s*\(?共?\d+件\)?$/, '').slice(0, 60);
const STATUS_WORD = /^(?:支付成功|交易成功|付款成功|还款成功|转账成功|退款成功|已退款|已完成|订单已完成|已送达|订单已送达|已收货|交易完成|行程已完成|等待.*|消费|支出|完成|返回.*|账单详情|订单详情|交易详情|行程详情|转账详情|账单|小票|详情|全部|筛选|.{0,2}支付成功|感谢.*|\d{1,2}[:：]\d{2}|.*\d+%|[45]G.*|收起|展开.*|联系.*|复制.*|再来一单|申请.*|评价.*|查看.*)$/;
const PLATFORM_MERCHANT = /平台商户|^(?:美团|饿了么|拼多多|京东|淘宝|天猫|抖音|抖音电商|滴滴出行|支付宝|微信支付|财付通|大众点评|高德)(?:平台|商城|支付)?(?:商户)?$/;
export const isPlatformMerchant = (s: string) => PLATFORM_MERCHANT.test(s);
const STORE = /店|馆|坊|铺|堂|楼|阁|厅|庄|斋|轩|屋|超市|餐|食|面|粉|火锅|咖啡|茶|酒|旗舰|专卖|商行|公司|菜|烘焙|药|书/;

function platformOf(t: string): string {
  if (/账单服务|零钱通|商户单号|微信支付|发起群收款|财付通/.test(t) && /交易单号|支付成功|当前状态|零钱/.test(t)) return 'wechat';
  if (/支付宝|花呗|余额宝|商家订单号|账单分类|蚂蚁|芝麻/.test(t)) return 'alipay';
  if (/美团/.test(t)) return 'meituan';
  if (/饿了么/.test(t)) return 'eleme';
  if (/京东/.test(t)) return 'jd';
  if (/淘宝|天猫|淘金币/.test(t)) return 'taobao';
  if (/拼多多|多多/.test(t)) return 'pdd';
  if (/滴滴|快车|专车|行程|里程费/.test(t)) return 'ride';
  return '';
}

function kindOf(t: string, sign: string): { kind: Kind; direction: string; flag?: Flag } {
  if (/退款成功|退款到账|已退款到|退款金额|退款时间|退款方式|[-—一]退款(?:\s|$)|退款总额/m.test(t) && sign !== '-') return { kind: 'refund', direction: 'in' };
  if (/已全额退款|已退款|部分退款|退款成功/.test(t)) return { kind: 'expense', direction: 'out', flag: { field: 'kind', hard: true, reason: '凭证显示已退款，请确认是支出还是退款' } };
  if (/信用卡还款|还款成功|还款到|花呗还款|白条还款|还款金额|还款时间|自动还款/.test(t)) return { kind: 'repay', direction: 'out' };
  if (/扫(?:二维)?码付款|二维码收款/.test(t) && sign === '-') return { kind: 'expense', direction: 'out' };
  if (/转账给|转账[-—一]给|转给|转账-来自|转账[-—一]来自|转账成功|转账时间|转账单号|对方已收钱|朋友已收钱|零钱提现|提现到账|提现成功|转入零钱通|零钱通转出|余额宝[-—]?.{0,4}(?:转入|转出)|零钱充值|余额充值|转入余额宝/.test(t)) return { kind: 'transfer', direction: sign === '+' || /来自/.test(t) ? 'in' : 'out' };
  if (sign === '+' || /收款成功|已收钱|已存入(?:零钱|余额)|收款到账|工资/.test(t)) return { kind: 'income', direction: 'in' };
  return { kind: 'expense', direction: 'out' };
}

// ───────── 银行短信 / 通知 ─────────
const SMS = /(快捷支付|网上支付|消费支出|消费|支出|付款|扣款|扣收|刷卡|转出|还款|退款|收入|入账|存入|转入|到账|代发工资|支付)[^\d余]{0,14}?(?:人民币|RMB|CNY|¥|￥)?\s*([\d,，]+(?:\.\d{1,2})?)\s*元/g;
export function parseSms(raw: string, ref: number): Receipt[] {
  const s = raw.replace(/\s+/g, '');
  if (!/(?:尾号|账户|卡号?|卡末四位|末四位)[为是]?\D{0,3}\d{4}|银行/.test(s) || !/\d元/.test(s)) return [];
  const out: Receipt[] = [];
  // 多条短信：按句子边界切开，避免把下一条的时间算到上一条
  const heads = [...s.matchAll(/(?:【[^】]{2,12}】)?您?(?:的)?(?:尾号|账户|储蓄卡|信用卡|借记卡|卡号)[^。]{0,4}?\d{4}/g)].map((m) => m.index);
  const segs = heads.length > 1 ? heads.map((h, i) => s.slice(i === 0 ? 0 : h, heads[i + 1] ?? s.length)) : [s];
  const bank = /【([^】]*银行[^】]*)】|\[([^\]]*银行[^\]]*)\]|([\p{Script=Han}]{2,4}银行)/u.exec(s);
  for (const seg of segs) {
    for (const m of seg.matchAll(SMS)) {
      const cents = toCents(m[2]!.replace(/，/g, ','));
      if (cents === null || /余额.{0,6}$/.test(seg.slice(Math.max(0, m.index - 6), m.index))) continue;
      const r = blank('sms');
      r.platform = 'bank'; r.amount = cents; r.sure = true;
      const v = m[1]!;
      r.kind = /退款/.test(seg.slice(Math.max(0, m.index - 8), m.index + m[0].length)) ? 'refund' : /还款/.test(seg) ? 'repay' : /收入|入账|存入|转入|到账|代发工资/.test(v) ? 'income' : /转出|转账/.test(v + seg.slice(Math.max(0, m.index - 6), m.index)) ? 'transfer' : 'expense';
      r.direction = r.kind === 'income' || r.kind === 'refund' ? 'in' : 'out';
      const w = parseStamp(seg.replace(/(\d{1,2})时(\d{1,2})分/, (_x, h, mi) => `${h.padStart(2, '0')}:${mi.padStart(2, '0')}`), ref);
      if (w) { r.ms = w.ms; r.precise = w.precise; }
      const mm = /(?:在|于)(?!\d)([^，。,;；]{2,30}?)(?:快捷支付|网上支付|消费|支付|支出|付款|扣款)/.exec(seg) ?? /向([^，。,;；]{2,30}?)(?:消费|支付|付款|支出|转)/.exec(seg) ?? /(?:商户|收款方)[为是:：]?([^，。,;；]{2,30})/.exec(seg);
      const name = mm ? cleanMerchant(mm[1]!.replace(/^.*\d+[日时分:：]\d*分?/, '')) : '';
      if (name && !/^\d+$/.test(name)) { r.merchant = name; r.merchantSure = true; }
      const tail = /(?:尾号|账户|卡号?|末四位)[为是]?\D{0,3}(\d{4})(?!\d)/.exec(seg)?.[1], bn = bank?.[1] ?? bank?.[2] ?? bank?.[3] ?? '';
      r.method = bn || tail ? `${bn || '银行卡'}${/信用卡/.test(seg) ? '信用卡' : /储蓄卡|借记卡/.test(seg) ? '储蓄卡' : ''}${tail ? `(${tail})` : ''}` : '';
      out.push(r);
      break; // 每条短信取第一笔动作金额
    }
  }
  return out;
}

// ───────── 列表 ─────────
function parseList(d: OcrDoc, rows: OcrItem[][], ref: number, text: string): ListRow[] | null {
  if (/账单详情|订单详情|交易详情|实付|交易单号|商品总价/.test(text)) return null;
  const med = median(d.items.map((i) => i.h));
  const hits: { row: number; name: string; m: Money; c: number }[] = [];
  let base = ref;
  rows.forEach((r, i) => {
    const last = r.at(-1)!, ms = findMoney(last.t);
    if (ms.length !== 1 || last.x + last.w / 2 < d.w * 0.55) return;
    const m = ms[0]!;
    if (last.t.replace(/\s/g, '').length > m.end - m.index + 2 || !(m.sign || m.decimals)) return;
    const name = tidy(r.slice(0, -1).map((x) => x.t).join(' '));
    if (!name || roleOf(name) && !/红包|退款|还款/.test(name) || /^(?:支出|收入|结余|合计)/.test(name)) return;
    hits.push({ row: i, name, m, c: Math.min(...r.map((x) => x.c)) });
  });
  if (hits.length < 2) return null;
  const out: ListRow[] = [];
  let dated = 0;
  hits.forEach((h, n) => {
    const until = hits[n + 1]?.row ?? Math.min(rows.length, h.row + 4);
    // 月份标题给出年份
    for (let k = (hits[n - 1]?.row ?? -1) + 1; k < h.row; k++) { const ym = /(20\d{2})年(\d{1,2})月(?!\d)/.exec(rows[k]!.map((x) => x.t).join('')); if (ym) base = Math.min(ref, Date.UTC(+ym[1]!, +ym[2]!, 0, 15)); }
    let ms: number | null = null, precise = false, sub = '';
    const tail: string[] = [];
    for (let k = h.row; k < until && k < rows.length; k++) {
      const t = rows[k]!.filter((x) => k > h.row || x !== rows[k]!.at(-1)).map((x) => x.t).join(' ');
      const w = parseStamp(t, base);
      if (w && ms === null) { ms = w.ms; precise = w.precise; }
      if (k > h.row && !/^20\d{2}年\d{1,2}月/.test(t)) tail.push(t);
    }
    sub = tail.join(' ');
    if (ms !== null) dated++;
    const all = `${h.name} ${sub}`, sign = h.m.sign;
    const kind: Kind = /退款/.test(all) && sign !== '-' ? 'refund' : /信用卡还款|花呗还款|还款/.test(h.name) ? 'repay' : /^转账|转账[-—一给]|提现|零钱通|余额宝.*转|充值到/.test(h.name) ? 'transfer' : sign === '+' ? 'income' : 'expense';
    const skip = /交易关闭|已关闭|已取消|等待付款|待付款|未支付|支付失败/.test(all);
    out.push({ currency: h.m.currency, amount: h.m.cents, kind, direction: sign === '+' ? 'in' : 'out', merchant: cleanMerchant(h.name), ms, precise, note: /已全额退款|已退款|部分退款/.test(all) ? '列表显示已退款' : '', skip, sure: h.c >= 0.85 && h.m.decimals && h.m.currency === 'CNY' });
  });
  return dated >= 2 && dated >= hits.length * 0.5 && med > 0 ? out : null;
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };

// ───────── 主入口 ─────────
export function parseReceipt(d: OcrDoc, ref: number): Receipt {
  const items = d.items.filter((i) => i.t);
  if (!items.length) { const r = blank('none'); r.flags.push({ field: 'amount', hard: true, reason: '没有识别出文字' }); return r; }
  const doc = { ...d, items }, rows = rowsOf(doc), text = rows.map((r) => r.map((i) => i.t).join(' ')).join('\n');

  const sms = /(?:尾号|账户|卡)\D{0,4}\d{4}/.test(text) && !/账单详情|订单详情|交易详情|交易单号/.test(text) ? parseSms(rows.filter((r) => !/^\d{1,2}[:：]\d{2}$|\d+\s*%$/.test(r[0]!.t)).map((r) => r.map((i) => i.t).join('')).join(''), ref) : [];
  const smsLow = sms.length && Math.min(...items.filter((i) => /\d/.test(i.t) && /元|\./.test(i.t)).map((i) => i.c), 1) < 0.85;
  if (sms.length === 1) { if (smsLow) { sms[0]!.sure = false; sms[0]!.flags.push({ field: 'amount', hard: true, reason: '金额处文字不清晰', candidates: [sms[0]!.amount!] }); } return sms[0]!; }
  if (sms.length > 1) { const r = blank('list'); r.platform = 'bank'; r.rows = sms.map((x) => ({ amount: x.amount, kind: x.kind, direction: x.direction, merchant: x.merchant, ms: x.ms, precise: x.precise, note: '', skip: false, sure: !smsLow })); return r; }

  const list = parseList(doc, rows, ref, text);
  if (list) { const r = blank('list'); r.platform = platformOf(text); r.rows = list; return r; }

  const r = blank();
  const kv = pairs(rows), first = (k: L) => kv.find((x) => x.key === k);
  r.platform = platformOf(text);

  // 金额候选
  const med = median(items.map((i) => i.h));
  interface Cand extends Money { role: Role | null; c: number; h: number; y: number; alone: boolean; row: number }
  const cands: Cand[] = [];
  const idRows = new Set(kv.filter((x) => ['trade', 'order', 'mch', 'time'].includes(x.key)).map((x) => x.row));
  rows.forEach((row, i) => {
    if (idRows.has(i)) return;
    let prev = '';
    for (const it of row) {
      let pos = 0;
      for (const m of findMoney(it.t)) {
        const label = (prev + ' ' + it.t.slice(pos, m.index)).trim();
        pos = m.end;
        let role = roleOf(label);
        const after = it.t.slice(m.end).replace(/[元\s]/g, '');
        if (!role && !label && row.length === 1) {
          const up = rows[i - 1];
          if (up?.length === 1 && it.y - up[0]!.y < it.h * 3 && up[0]!.t.length <= 8 && !findMoney(up[0]!.t).length) role = roleOf(up[0]!.t);
        }
        cands.push({ ...m, role, c: it.c, h: it.h, y: it.y, alone: !label && !after && row.length === 1, row: i });
        prev = '';
      }
      prev += it.t.slice(pos);
    }
  });
  const usable = cands.filter((c) => c.cents > 0);
  const head = usable.filter((c) => c.alone && c.role !== 'ignore' && c.role !== 'discount' && c.role !== 'original' && c.role !== 'due' && (c.explicit || c.decimals) && c.h >= med * 1.25 && c.y < Math.max(d.h * 0.6, 1400)).sort((a, b) => b.h - a.h || a.row - b.row)[0];
  const by = (role: Role) => usable.filter((c) => c.role === role);
  const signed = usable.filter((c) => !c.role && c.sign);
  const sign = head?.sign ?? (signed.length === 1 ? signed[0]!.sign : '');

  const k = kindOf(text, sign);
  r.kind = k.kind; r.direction = k.direction;
  if (k.flag) r.flags.push(k.flag);
  const unpaid = /等待(?:买家)?付款|待付款|待支付|等待支付|未支付|需付款|去支付|立即支付|确认支付/.test(text) && !/支付成功|交易成功|实付/.test(text);
  const closed = /交易关闭|订单已取消|已取消|支付失败|订单关闭|交易失败/.test(text);

  const paidRole: Role = r.kind === 'refund' ? 'refund' : r.kind === 'repay' ? 'repay' : r.kind === 'transfer' ? 'transfer' : 'paid';
  const paid = by(paidRole).length ? by(paidRole) : r.kind === 'refund' ? [] : by('paid');
  const distinct = [...new Set(paid.map((c) => c.cents))];
  const voucherish = /支付成功|交易成功|付款成功|还款成功|转账成功|退款成功|已完成|已送达|已收钱|当前状态|交易单号|支付方式|付款方式|交易时间|支付时间|消费成功|交易完成/.test(text);
  const pick = (c: Cand, reason = '') => {
    r.amount = c.cents; r.currency = c.currency; r.sure = !reason;
    if (c.c < 0.85) { r.sure = false; reason = '金额处文字不清晰'; }
    if (reason) r.flags.push({ field: 'amount', hard: true, reason, candidates: [...new Set([c.cents, ...distinct])] });
  };
  if (distinct.length === 1) {
    const p = paid.find((c) => c.explicit) ?? paid[0]!;
    if (head && head.cents !== p.cents && head.role === null && head.sign) pick(p, '页面上有两个不同的金额');
    else pick(head && head.cents === p.cents && head.c > p.c ? { ...p, c: head.c, currency: p.explicit ? p.currency : head.currency } : p);
  } else if (distinct.length > 1) {
    const agree = head && distinct.includes(head.cents) ? paid.find((c) => c.cents === head.cents) : undefined;
    pick(agree ?? paid.at(-1)!, '出现多个实付金额');
  } else if (head && (head.sign || voucherish)) {
    pick(head, head.decimals || /元/.test(text) || head.explicit ? '' : '金额没有小数位，可能识别不全');
  } else if (head) pick(head, '不确定是不是实付金额');
  else if (signed.length === 1 && voucherish) pick(signed[0]!);
  else if (by('total').length || by('due').length) pick((by('total').at(-1) ?? by('due').at(-1))!, '只看到合计，没有看到实付');
  else if (usable.filter((c) => !c.role).length) {
    const u = usable.filter((c) => !c.role).sort((a, b) => b.h - a.h)[0]!;
    pick(u, '没有看到实付字样');
  } else r.flags.push({ field: 'amount', hard: true, reason: '没有识别出金额' });
  if (new Set(usable.filter(c => c.explicit).map(c => c.currency)).size > 1) {
    if (head) { r.amount = head.cents; r.currency = head.currency; }
    r.sure = false;
    r.flags.push({ field: 'amount', hard: true, reason: '凭证含多个币种，请核对原币金额' });
  }
  if (k.flag?.hard) r.sure = false;
  if (r.sure && median(items.map(i => i.c)) < 0.8) {
    r.sure = false;
    r.flags.push({ field: 'amount', hard: true, reason: '整张凭证文字模糊，无法核实金额含义' });
  }
  if (r.sure && (unpaid || closed)) { r.sure = false; r.flags.push({ field: 'amount', hard: true, reason: unpaid ? '看起来还没付款' : '交易已关闭或取消', candidates: r.amount === null ? [] : [r.amount] }); }
  else if (unpaid && r.amount !== null) r.flags.push({ field: 'amount', hard: true, reason: '看起来还没付款' });

  const orderish = /订单详情|订单编号|下单时间|商品总价|配送费|收货|行程详情|实付款|打包费|里程费/.test(text);
  r.doc = r.amount === null ? 'none' : orderish && !/账单详情|当前状态/.test(text) ? 'order' : voucherish || head ? 'voucher' : 'none';

  // 时间
  const prefer = r.kind === 'refund' ? /退款|到账/ : r.kind === 'repay' ? /还款/ : r.kind === 'transfer' ? /转账|支付|交易/ : /支付|付款|交易|消费/;
  const times = kv.filter((x) => x.key === 'time').sort((a, b) => Number(prefer.test(b.label)) - Number(prefer.test(a.label)));
  for (const t of times) { const w = parseStamp(t.value, ref); if (w) { r.ms = w.ms; r.precise = w.precise; break; } }
  if (r.ms === null) for (let i = 0; i < rows.length; i++) { const w = parseStamp(rows[i]!.map((x) => x.t).join(' '), ref); if (w?.precise && w.ms <= ref + 86400_000) { r.ms = w.ms; r.precise = true; break; } }
  if (r.ms !== null && r.ms > ref + 86400_000) { r.flags.push({ field: 'time', hard: false, reason: '识别出的时间在未来' }); r.ms = null; r.precise = false; }

  // 商户
  const setM = (s: string, sure: boolean) => { const v = cleanMerchant(s); if (v && !/^[\d\s.:：\-+¥,]+$/.test(v)) { r.merchant = v; r.merchantSure = sure; } };
  const headRow = head?.row ?? -1, lab = first('merchant');
  if (headRow > 0 && r.doc === 'voucher') {
    const up = rows[headRow - 1]!;
    if (up.length === 1 && !STATUS_WORD.test(up[0]!.t) && !labelOf(up[0]!.t) && [...up[0]!.t].length >= 2 && !/详情$/.test(up[0]!.t)) setM(up[0]!.t, up[0]!.c >= 0.85);
    else if (headRow > 1 && up.length === 1 && STATUS_WORD.test(up[0]!.t)) { const u2 = rows[headRow - 2]!; if (u2.length === 1 && !STATUS_WORD.test(u2[0]!.t) && !labelOf(u2[0]!.t)) setM(u2[0]!.t, false); }
  }
  if (lab && (!r.merchant || !r.merchantSure)) setM(lab.value, lab.c >= 0.85);
  if (!r.merchant && r.doc === 'order') {
    // 商家名通常在第一件商品上方
    const firstMoney = rows.findIndex((x, i) => i > 0 && x.some((it) => findMoney(it.t).length > 0));
    const near = rows.slice(0, firstMoney < 0 ? Math.min(rows.length, 8) : firstMoney).filter((x) => x.length <= 2 && !STATUS_WORD.test(x[0]!.t) && !labelOf(x[0]!.t) && !/[，。！？,!?]/.test(x[0]!.t) && [...x[0]!.t].length >= 2 && [...x[0]!.t].length <= 30 && !/[A-Z]·|^\d/.test(x[0]!.t));
    const s = near.filter((x) => STORE.test(x[0]!.t)).at(-1);
    if (s) setM(s[0]!.t, s[0]!.c >= 0.85);
    else if (near.length) setM(near.at(-1)![0]!.t, false);
  }
  const full = first('full');
  if (!r.merchant && full) setM(full.value, full.c >= 0.85);
  if (r.platform === 'ride' && !r.merchant) { r.item = '打车'; }
  if (/配送费|骑手|外卖/.test(text)) r.hint = '外卖'; else if (r.platform === 'ride') r.hint = '打车';
  const it = first('item');
  if (it && !/^[\d\s/]+$/.test(it.value)) r.item = tidy(it.value).slice(0, 80);

  // 支付方式：卡号只留尾号
  const me = kv.find((x) => x.key === 'method' && !/卡号|退/.test(x.label)) ?? first('method');
  if (me && !/^(?:在线支付|线上支付|原路退回|原路返回)$/.test(me.value)) r.method = maskCard(tidy(me.value)).slice(0, 40);
  else if (/(?:卡号|尾号)\s*\**\s*(\d{4})/.test(text)) r.method = `银行卡(${/(?:卡号|尾号)\s*\**\s*(\d{4})/.exec(text)![1]})`;

  for (const t of ['trade', 'order', 'mch'] as const) for (const x of kv.filter((y) => y.key === t)) if (!r.ids.some((i) => i.no === x.value)) r.ids.push({ type: t, no: x.value });

  if (r.amount !== null && r.doc !== 'none') {
    if (!r.merchant && !r.item) r.flags.push({ field: 'merchant', hard: false, reason: '没有识别出商户' });
    else if (r.merchant && !r.merchantSure) r.flags.push({ field: 'merchant', hard: false, reason: '商户名没把握' });
  }
  return r;
}
/** 6225 **** **** 1234 → 银行卡(1234)；招商银行(6225881234567890) → 招商银行(7890) */
export function maskCard(s: string): string {
  return s.replace(/(?<!\d)\d{4,6}[\s*]+(?:\**\s*)*(\d{4})(?!\d)/g, '银行卡($1)').replace(/(?<!\d)\d{8,15}(\d{4})(?!\d)/g, '$1');
}
