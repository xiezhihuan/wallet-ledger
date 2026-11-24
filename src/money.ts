/** 金额一律用整数「分」，全程不经过浮点。 */

/** "1,234.5" → 123450；不合法返回 null。最多两位小数，多了不四舍五入而是拒绝。 */
export function toCents(s: string): number | null {
  const m = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s.trim().replace(/[，]/g, ','));
  if (!m) return null;
  const n = Number(m[2]!.replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(n) ? (m[1] === '-' ? -n : n) : null;
}
/** 123450 → "1234.50" */
export function yuan(c: number): string {
  const a = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
export const CURRENCY: Record<string, string> = { CNY: '¥', USD: 'US$', HKD: 'HK$', EUR: '€', GBP: '£', JPY: 'JP¥', KRW: '₩', TWD: 'NT$', SGD: 'S$', THB: '฿', AUD: 'A$', MOP: 'MOP$' };
/** 展示：¥1,234.50 / US$12.00 */
export function money(c: number | null | undefined, currency = 'CNY'): string {
  if (c === null || c === undefined) return '金额待确认';
  const [i, d] = yuan(Math.abs(c)).split('.');
  return `${c < 0 ? '-' : ''}${CURRENCY[currency] ?? currency + ' '}${i!.replace(/\B(?=(\d{3})+$)/g, ',')}.${d}`;
}
/** 整数按权重取百分比（一位小数），只用于展示。 */
export const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((a / b) * 1000) / 10);

const D: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 中文数字（语音转写常见）→ 整数；不认识返回 null。 */
export function cnInt(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[零〇一二两三四五六七八九十百千万]+$/.test(s)) return null;
  if (!/[十百千万]/.test(s)) return s.length > 1 && s.length < 3 ? null : s.length === 1 ? D[s]! : Number([...s].map((c) => D[c]).join(''));
  let total = 0, sec = 0, n = 0, last = 1;
  for (const c of s) {
    if (c in D) { n = D[c]!; if (c === '零' || c === '〇') last = 1; continue; }
    const u = c === '十' ? 10 : c === '百' ? 100 : c === '千' ? 1000 : 10_000;
    if (u === 10_000) { total += (sec + n) * u; sec = 0; n = 0; last = u; } else { sec += (n || (u === 10 ? 1 : 0)) * u; n = 0; last = u; }
  }
  // 「一百二」= 120，「一万三」= 13000
  if (n && last >= 100 && !/[零〇][一二两三四五六七八九]$/.test(s)) n *= last / 10;
  return total + sec + n;
}
