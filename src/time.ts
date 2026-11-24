/** 全部按 Asia/Shanghai（固定 UTC+8，无夏令时）计算，与运行机器的时区无关。周从周一开始。 */
export const TZ = 'Asia/Shanghai';
const H8 = 8 * 3600_000, DAY = 86400_000;
const p2 = (n: number) => String(n).padStart(2, '0');

/** 上海时间的各部分 */
export function parts(ms: number) {
  const d = new Date(ms + H8);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay() || 7 };
}
export const at = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number => Date.UTC(y, m - 1, d, h, mi, s) - H8;
export const ymd = (ms: number): string => { const p = parts(ms); return `${p.y}-${p2(p.m)}-${p2(p.d)}`; };
export const hm = (ms: number): string => { const p = parts(ms); return `${p2(p.h)}:${p2(p.mi)}`; };
export const fmtTime = (ms: number | null | undefined): string => (ms ? `${ymd(ms)} ${hm(ms)}` : '');

/** 严格校验的 YYYY-MM-DD */
export function validDay(s: string): boolean {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(s);
  return !!m && ymd(at(+m[1]!, +m[2]!, +m[3]!)) === s && +m[1]! >= 1990 && +m[1]! <= 2200;
}
const num = (day: string): number => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
const str = (n: number): string => new Date(n).toISOString().slice(0, 10);
export const dayStart = (day: string): number => num(day) - H8;
export const addDays = (day: string, n: number): string => str(num(day) + n * DAY);
export const diffDays = (a: string, b: string): number => Math.round((num(b) - num(a)) / DAY);
/** 月份加减；日期超过目标月天数时取月末。 */
export function addMonths(day: string, n: number): string {
  const y = +day.slice(0, 4), m = +day.slice(5, 7) - 1 + n, last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return str(Date.UTC(y, m, Math.min(+day.slice(8, 10), last)));
}
export const monday = (day: string): string => addDays(day, -((new Date(num(day)).getUTCDay() || 7) - 1));
export const weekday = (day: string): number => new Date(num(day)).getUTCDay() || 7;

export type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';
/** 闭区间 [from, to]，按天。 */
export interface Range { from: string; to: string }
export function periodOf(unit: Unit, day: string): Range {
  const y = day.slice(0, 4);
  if (unit === 'day') return { from: day, to: day };
  if (unit === 'week') { const f = monday(day); return { from: f, to: addDays(f, 6) }; }
  if (unit === 'year') return { from: `${y}-01-01`, to: `${y}-12-31` };
  const f = unit === 'month' ? `${day.slice(0, 7)}-01` : `${y}-${p2(Math.floor((+day.slice(5, 7) - 1) / 3) * 3 + 1)}-01`;
  return { from: f, to: addDays(addMonths(f, unit === 'month' ? 1 : 3), -1) };
}
export function shift(unit: Unit, day: string, n: number): string {
  if (unit === 'day') return addDays(day, n);
  if (unit === 'week') return addDays(day, 7 * n);
  return addMonths(day, n * (unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12));
}
/** 识别一个区间恰好是哪种自然周期；不是则返回 null（自定义）。 */
export function unitOf(r: Range): Unit | null {
  for (const u of ['day', 'week', 'month', 'quarter', 'year'] as Unit[]) { const p = periodOf(u, r.from); if (p.from === r.from && p.to === r.to) return u; }
  return null;
}
export function label(r: Range): string {
  const u = unitOf(r), y = r.from.slice(0, 4), m = +r.from.slice(5, 7);
  if (u === 'day') return r.from;
  if (u === 'month') return `${y}年${m}月`;
  if (u === 'quarter') return `${y}年第${Math.ceil(m / 3)}季度`;
  if (u === 'year') return `${y}年`;
  if (u === 'week') return `${r.from.slice(5)} ~ ${r.to.slice(5)}（周）`;
  return `${r.from} ~ ${r.to}`;
}
/** 上一期与去年同期。自定义区间的上一期 = 紧邻的等长区间。 */
export function compareRanges(r: Range): { prev: Range; yoy: Range } {
  const u = unitOf(r);
  if (!u) { const n = diffDays(r.from, r.to) + 1; return { prev: { from: addDays(r.from, -n), to: addDays(r.from, -1) }, yoy: { from: addMonths(r.from, -12), to: addMonths(r.to, -12) } }; }
  const prev = periodOf(u, shift(u, r.from, -1));
  // 周没有「去年同一周」的自然定义，取 52 周前（同为周一到周日）
  const yoy = u === 'week' ? { from: addDays(r.from, -364), to: addDays(r.to, -364) } : periodOf(u, addMonths(r.from, -12));
  return { prev, yoy };
}
/** 「今天 / 上周 / 本季度 / 去年」→ 区间 */
export function namedRange(name: string, today: string): Range | null {
  const n = name.replace(/^这(?=个?[周月季年])/, '本').replace(/个(?=[月季])/, '').replace(/度$/, '').replace(/星期|礼拜/, '周');
  const t: Record<string, [Unit, number]> = { 今天: ['day', 0], 今日: ['day', 0], 昨天: ['day', -1], 昨日: ['day', -1], 前天: ['day', -2], 本周: ['week', 0], 上周: ['week', -1], 本月: ['month', 0], 当月: ['month', 0], 上月: ['month', -1], 本季: ['quarter', 0], 上季: ['quarter', -1], 今年: ['year', 0], 本年: ['year', 0], 去年: ['year', -1] };
  const k = t[n];
  return k ? periodOf(k[0], shift(k[0], today, k[1])) : null;
}
