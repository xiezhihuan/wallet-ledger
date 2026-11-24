import { addDays, at, monday, parts, ymd } from '../time.js';

export interface When { ms: number; /** 精确到分 / 仅到天 */ precise: boolean; index: number; length: number }
const ok = (y: number, m: number, d: number, h = 0, mi = 0) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && ymd(at(y, m, d)) === `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const FULL = /(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[\sT]*(?:周.|星期.)?\s*(\d{2})\s*[:：时点.]\s*(\d{2})(?:\s*[:：分.]\s*(\d{2}))?)?/;
const MD = /(?<![\d.年\-/])(\d{1,2})\s*(月|[-/])\s*(\d{1,2})(?:日|(?![\d.]))(?:\s*(\d{1,2})\s*[:：时]\s*(\d{1,2}))?/;
/** OCR 会吞掉空格：「11-0210:01」 */
const MD_GLUED = /(?<![\d.年\-/])(\d{2})-(\d{2})\s*(\d{2})[:：](\d{2})/;
const REL = /(今天|昨天|前天)\s*(\d{1,2})[:：](\d{2})/;

/** 凭证上的时间。没有年份时取不晚于参考时间（+1 天容差）的最近一年。 */
export function parseStamp(s: string, ref: number): When | null {
  let m = FULL.exec(s);
  if (m && ok(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0)))
    return { ms: at(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), Math.min(59, +(m[6] ?? 0))), precise: m[4] !== undefined, index: m.index, length: m[0].length };
  m = REL.exec(s);
  if (m && +m[2]! < 24 && +m[3]! < 60) {
    const day = addDays(ymd(ref), m[1] === '今天' ? 0 : m[1] === '昨天' ? -1 : -2);
    return { ms: at(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8), +m[2]!, +m[3]!), precise: true, index: m.index, length: m[0].length };
  }
  const g = MD_GLUED.exec(s), md = g ? [g[0], g[1], '-', g[2], g[3], g[4]] : MD.exec(s);
  if (md) {
    const y0 = parts(ref).y, index = (g ?? (md as RegExpExecArray)).index;
    const mo = +md[1]!, d = +md[3]!, h = md[4] === undefined ? undefined : +md[4], mi = +(md[5] ?? 0);
    for (const y of [y0, y0 - 1]) if (ok(y, mo, d, h ?? 0, mi)) { const ms = at(y, mo, d, h ?? 0, mi); if (ms <= ref + 86400_000) return { ms, precise: h !== undefined, index, length: md[0]!.length }; }
  }
  return null;
}

const WEEK: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };
const CN: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
const CLOCK = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*(?:(\d{1,2})\s*[:：]\s*(\d{2})|(\d{1,2}|十[一二]?|[一二两三四五六七八九])\s*点\s*(半|(\d{1,2})\s*分?)?)/;

/** 用户口语里的日期时间：「昨天」「上周五」「3号」「11月3日 12:30」「昨晚 8 点」。rest 是去掉时间后的文字。 */
export function parseSpoken(text: string, ref: number): { ms: number; precise: boolean; rest: string } | null {
  let rest = text, day: string | null = null;
  const today = ymd(ref), cut = (m: RegExpExecArray) => { rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); };
  let m: RegExpExecArray | null;
  if ((m = FULL.exec(rest)) && ok(+m[1]!, +m[2]!, +m[3]!)) { day = ymd(at(+m[1]!, +m[2]!, +m[3]!)); cut(m); if (m[4] !== undefined) return { ms: at(+m[1]!, +m[2]!, +m[3]!, +m[4], +m[5]!), precise: true, rest: rest.trim() }; }
  else if ((m = /(大前天|前天|昨天|昨晚|昨日|今天|今早|今晚|今日)/.exec(rest))) { day = addDays(today, m[1] === '大前天' ? -3 : m[1] === '前天' ? -2 : m[1]!.startsWith('昨') ? -1 : 0); const eve = /[早晚]$/.exec(m[1]!)?.[0]; cut(m); if (eve) rest = rest.replace(CLOCK, (x) => (/^\s*(凌晨|早|上午|中午|下午|傍晚|晚|夜)/.test(x) ? x : (eve === '晚' ? '晚上' : '早上') + x)); }
  else if ((m = /(上上|上|这|本)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(rest))) { const d = addDays(monday(today), WEEK[m[2]!]! - 1); day = m[1] === '上上' ? addDays(d, -14) : m[1] === '上' ? addDays(d, -7) : d > today ? addDays(d, -7) : d; cut(m); }
  else if ((m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(rest))) { const y = +today.slice(0, 4); for (const yy of [y, y - 1]) if (!day && ok(yy, +m[1]!, +m[2]!)) { const d = ymd(at(yy, +m[1]!, +m[2]!)); if (d <= addDays(today, 1)) day = d; } if (day) cut(m); }
  else if ((m = /(?<![\d.])(\d{1,2})\s*[号日](?!线|楼|店|门|院|桌|厅)/.exec(rest))) { const y = +today.slice(0, 4), mo = +today.slice(5, 7); const a = ok(y, mo, +m[1]!) ? ymd(at(y, mo, +m[1]!)) : '', py = mo === 1 ? y - 1 : y, pm = mo === 1 ? 12 : mo - 1; day = a && a <= today ? a : ok(py, pm, +m[1]!) ? ymd(at(py, pm, +m[1]!)) : null; if (day) cut(m); }
  m = CLOCK.exec(rest);
  if (m && (m[2] !== undefined || m[4] !== undefined)) {
    let h = m[2] !== undefined ? +m[2] : /^\d/.test(m[4]!) ? +m[4]! : CN[m[4]!]!;
    const mi = m[3] !== undefined ? +m[3] : m[5] === '半' ? 30 : +(m[6] ?? 0);
    if (/下午|傍晚|晚上|夜里/.test(m[1] ?? '') && h < 12) h += 12;
    if (m[1] === '中午' && h < 11) h += 12;
    if (h < 24 && mi < 60) {
      cut(m);
      const b = day ?? today; let ms = at(+b.slice(0, 4), +b.slice(5, 7), +b.slice(8), h, mi);
      if (!day && ms > ref + 600_000) ms -= 86400_000; // 只说了钟点且还没到：指昨天
      return { ms, precise: true, rest: rest.trim() };
    }
  }
  if (!day) return null;
  // 只说了哪天：今天用发送时刻，其余记到当天 12:00，标为仅到天
  if (day === today) return { ms: ref, precise: false, rest: rest.trim() };
  return { ms: at(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8), 12), precise: false, rest: rest.trim() };
}
