import { cnInt, toCents } from '../money.js';
import { findMoney, parseSms, blank, type Kind, type Receipt } from './receipt.js';
import { parseSpoken } from './when.js';

const METHODS: [RegExp, string][] = [
  [/(?:用|刷|付)?(微信零钱|零钱通|零钱)(?:付|支付)?/, '$1'], [/(?:用|刷)?(花呗|白条|余额宝|现金|云闪付|数字人民币)(?:付|支付)?/, '$1'],
  [/(?:用|刷)?(支付宝)(?:付的?|支付)?/, '支付宝'], [/(?:用)?(微信)(?:付的?|支付)/, '微信支付'], [/(?:用|刷)(微信)/, '微信支付'],
  [/(?:用|刷)(?:了)?([\p{Script=Han}]{2,4}(?:信用卡|储蓄卡|银行卡|卡))/u, '$1'], [/(?:刷)?(信用卡|储蓄卡|银行卡)(?:付|支付)?/, '$1'],
];
const NOT_MONEY_BEFORE = /(?:人均|每人|原价|优惠|便宜了?|省了?|打|余额|还剩|剩|满|减|第|买了?|点了?|共|NO\.?|no\.?|编号|房间?|电话|尾号|单号|v|V)\s*$/;
const COUNTER = /^\s*(?:个|杯|份|瓶|盒|包|袋|斤|公斤|克|人|位|次|张|件|双|只|条|块钱?以内|天|晚|小时|分钟|分(?!钱)|公里|km|点|号|日|月|年|楼|层|路|折|%|％|GB|G\b|寸|升|ml|码|期|季|集|版|岁|代|本|支|根|盘|碗|串|桶|吨|度|米)/i;

interface Num { cents: number; unit: boolean; currency: string; index: number; end: number; tail: boolean }
/** 一行口语里的金额候选 */
function amounts(s: string): Num[] {
  const out: Num[] = [];
  const push = (n: Num) => { if (n.cents > 0 && !out.some((o) => n.index < o.end && o.index < n.end)) out.push(n); };
  const tail = (end: number) => /^[\s。.!！，,]*$/.test(s.slice(end));
  // 28块5 / 3块8毛 / 二十八块五 / 1.2万 / 3千
  for (const m of s.matchAll(/(\d+(?:\.\d{1,2})?|[零〇一二两三四五六七八九十百千万]+)\s*(?:块钱?|元)([\d一二两三四五六七八九半])(?!\s*[\d.个杯份瓶人块元小天次张件位斤包时分碗只双])(?:毛|角)?/g)) {
    const y = /^[\d.]+$/.test(m[1]!) ? toCents(m[1]!) : cnInt(m[1]!) === null ? null : cnInt(m[1]!)! * 100;
    const j = m[2] === '半' ? 50 : cnInt(m[2]!)! * 10;
    if (y !== null && y % 100 === 0) push({ cents: y + j, unit: true, currency: 'CNY', index: m.index, end: m.index + m[0].length, tail: true });
  }
  for (const m of s.matchAll(/(\d+)(?:\.(\d{1,2}))?\s*([万千])(?:元|块)?/g)) { const k = m[3] === '万' ? 1_000_000 : 100_000; push({ cents: Number(m[1]) * k + Math.round(Number((m[2] ?? '').padEnd(2, '0'))) * (k / 100), unit: true, currency: 'CNY', index: m.index, end: m.index + m[0].length, tail: true }); }
  for (const m of s.matchAll(/([零〇一二两三四五六七八九十百千万]+)\s*(块钱?|元)(?!店)/g)) { const n = cnInt(m[1]!); if (n) push({ cents: n * 100, unit: true, currency: 'CNY', index: m.index, end: m.index + m[0].length, tail: true }); }
  for (const m of s.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:块钱?|元)/g)) { const c = toCents(`${m[1]}${m[2] ? '.' + m[2] : ''}`); if (c && !NOT_MONEY_BEFORE.test(s.slice(0, m.index).replace(/(买了?|点了?|共)\s*$/, ''))) push({ cents: c, unit: true, currency: 'CNY', index: m.index, end: m.index + m[0].length, tail: true }); }
  for (const m of findMoney(s)) if (m.explicit && !NOT_MONEY_BEFORE.test(s.slice(0, m.index).replace(/(买了?|点了?|共)\s*$/, ''))) push({ cents: m.cents, unit: true, currency: m.currency, index: m.index, end: m.end, tail: tail(m.end) });
  // 裸数字
  for (const m of s.matchAll(/(?<![\d.A-Za-z:：\-/#*])(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?(?![\d.]*[:：/\d-])/g)) {
    const end = m.index + m[0].length;
    if (COUNTER.test(s.slice(end)) || NOT_MONEY_BEFORE.test(s.slice(0, m.index)) || /^[xX×*]\d/.test(s.slice(end)) || /[A-Za-z]$/.test(s.slice(0, m.index)) || /^[A-Za-z]/.test(s.slice(end))) continue;
    const c = toCents(`${m[1]}${m[2] !== undefined ? '.' + m[2] : ''}`);
    if (c) push({ cents: c, unit: false, currency: 'CNY', index: m.index, end, tail: tail(end) });
  }
  return out.sort((a, b) => a.index - b.index);
}

function kindOfText(s: string): { kind: Kind; direction: string } {
  if (/退款|退了|退回|退货/.test(s)) return { kind: 'refund', direction: 'in' };
  if (/还(?:了)?(?:信用卡|花呗|白条|借呗|房贷本金)|信用卡还款|还款/.test(s)) return { kind: 'repay', direction: 'out' };
  if (/(?:转账|转)给|转账|提现|存(?:到|进)(?:余额宝|零钱通)/.test(s)) return { kind: 'transfer', direction: 'out' };
  if (/工资|发薪|奖金|收入|收到(?:红包|转账|退税|报销)|报销到账|报销款|利息收入|入账|卖了/.test(s)) return { kind: 'income', direction: 'in' };
  return { kind: 'expense', direction: 'out' };
}

export interface TextEntry { text: string; receipt: Receipt; /** 只有金额没有说明 */ bare: boolean; /** 明确写了「实付/金额」 */ override: boolean }
/**
 * 用户文字 → 若干笔。没有金额的行归到前一笔当备注；整条都没有金额时返回一个 note。
 * 一行里多个裸数字且分不清时，取不确定并要求确认。
 */
export function parseText(raw: string, ref: number, voice = false): TextEntry[] {
  const sms = parseSms(raw, ref);
  if (sms.length && sms.every((r) => r.amount !== null)) return sms.map((receipt) => ({ text: raw, receipt, bare: false, override: false }));
  const out: TextEntry[] = [], lines = raw.split(/\n|[;；]/).map((l) => l.trim()).filter(Boolean);
  // 「午饭28，打车35」这样逗号分隔的多笔：每段都有金额才拆
  const segs = lines.flatMap((l) => { const p = l.split(/[，,、]\s*(?!\d{3}(?!\d))/).map((x) => x.trim()).filter(Boolean); return p.length > 1 && p.every((x) => amounts(strip(x, ref).rest).length === 1 && /[\p{L}]{2}/u.test(strip(x, ref).rest)) ? p : [l]; });
  let lead = '';
  for (const line of segs) {
    const { rest, when, method } = strip(line, ref);
    const nums = amounts(rest), units = nums.filter((n) => n.unit);
    let n: Num | undefined, unsure = '';
    const pool = units.length ? units : nums;
    const paidM = /(?:实付|实际(?:支付|付)|付了|花了|一共|总共|共)\s*[:：]?\s*$/;
    const told = pool.find((x) => paidM.test(rest.slice(0, x.index)));
    if (told) n = told;
    else if (pool.length === 1) n = pool[0];
    else if (pool.length > 1) {
      const last = pool.at(-1)!;
      if (!units.length && last.tail && /\s$/.test(rest.slice(0, last.index)) && pool.slice(0, -1).every((x) => !x.tail)) n = last; // 「iPhone 17 保护壳 59」：末尾独立数字是金额
      else { n = last; unsure = '这句话里有几个数字，分不清哪个是金额'; }
    }
    // 长段叙述里的裸数字不当金额
    if (n && !n.unit && !n.tail && [...rest].length > 24) n = undefined;
    const desc = n ? (rest.slice(0, n.index) + ' ' + rest.slice(n.end)).replace(/(?:实付|实际支付|付了|花了|花费|一共|总共|金额|支出|消费)\s*[:：]?/g, ' ').replace(/[，,。.!！\s]+/g, ' ').trim() : rest;
    if (!n) {
      const prev = out.at(-1);
      if (prev) { prev.receipt.note = [prev.receipt.note, line].filter(Boolean).join('\n'); if (when && prev.receipt.ms === null) { prev.receipt.ms = when.ms; prev.receipt.precise = when.precise; } }
      else lead = [lead, line].filter(Boolean).join('\n');
      continue;
    }
    const r = blank('text');
    r.amount = n.cents; r.currency = n.currency; r.sure = !unsure; r.voice = voice;
    if (unsure) r.flags.push({ field: 'amount', hard: true, reason: unsure, candidates: pool.map((x) => x.cents) });
    if (voice) r.flags.push({ field: 'amount', hard: false, reason: '来自语音转写，请核对金额' });
    Object.assign(r, kindOfText(line));
    r.item = desc.replace(/^(?:买了?|购买|在)\s*/, '').slice(0, 80);
    if (when) { r.ms = when.ms; r.precise = when.precise; }
    if (method) r.method = method;
    out.push({ text: line, receipt: r, bare: !desc, override: /实付|实际|金额/.test(line) });
  }
  if (lead) {
    const w = strip(lead, ref);
    if (out[0]) { out[0].receipt.note = [lead, out[0].receipt.note].filter(Boolean).join('\n'); if (w.when && out[0].receipt.ms === null) { out[0].receipt.ms = w.when.ms; out[0].receipt.precise = w.when.precise; } }
    else {
      const r = blank('text');
      r.note = w.rest || w.method ? lead : ''; if (w.when) { r.ms = w.when.ms; r.precise = w.when.precise; } if (w.method) r.method = w.method;
      Object.assign(r, kindOfText(lead)); r.sure = false;
      out.push({ text: lead, receipt: r, bare: false, override: false });
    }
  }
  return out;
}
function strip(line: string, ref: number): { rest: string; when: { ms: number; precise: boolean } | null; method: string } {
  const w = parseSpoken(line, ref);
  let rest = (w ? w.rest : line).replace(/\s+/g, ' ').trim(), method = '';
  if (!/还(?:了)?(?:信用卡|花呗|白条)|信用卡还款/.test(rest)) for (const [re, name] of METHODS) { const m = re.exec(rest); if (m) { method = name.replace('$1', m[1]!); rest = (rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim(); break; } }
  return { rest, when: w ? { ms: w.ms, precise: w.precise } : null, method };
}
/** 指令里的金额：「改 28.5」「改金额 二十八块五」 */
export function parseAmount(s: string): { cents: number; currency: string } | null {
  const t = s.trim(), c = toCents(t.replace(/^[¥￥]\s*/, '').replace(/\s*(?:元|块钱?)$/, ''));
  if (c !== null && c > 0) return { cents: c, currency: 'CNY' };
  const a = amounts(t);
  return a.length === 1 ? { cents: a[0]!.cents, currency: a[0]!.currency } : null;
}
