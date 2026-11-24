export function clip(s: string, n: number): string {
  const c = [...s];
  return c.length > n ? c.slice(0, n - 1).join('') + '…' : s;
}
export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => '\\' + c);
/** 商户名归一：去括号内门店、标点、空格，小写 */
export const normName = (s: string): string => s.toLowerCase().replace(/[（(][^）)]*[）)]/g, '').replace(/[\s·•\-—－_.,，。、'"’“”&|/]+/g, '').trim() || s.toLowerCase().replace(/\s/g, '');
const grams = (s: string): Set<string> => { const c = [...s], o = new Set<string>(); for (let i = 0; i + 1 < c.length; i++) o.add(c[i]! + c[i + 1]!); return o; };
/** 商户名是否像同一家：归一后相等、互相包含，或二元组重合过半 */
export function similarName(a: string, b: string): boolean {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y || (Math.min([...x].length, [...y].length) >= 2 && (x.includes(y) || y.includes(x)))) return true;
  const p = grams(x), q = grams(y);
  let n = 0;
  for (const g of p) if (q.has(g)) n++;
  return p.size + q.size > 0 && (2 * n) / (p.size + q.size) >= 0.5;
}
/** 遮盖长号码：11 位以上连续数字只留后 4 位（银行卡、手机号、单号、身份证） */
export const maskNumbers = (s: string): string => s.replace(/(?<![\d.])(?:\d[ -]?){10,}\d[Xx]?(?![\d.])/g, (m) => { const d = m.replace(/[ -]/g, ''); return '*'.repeat(6) + d.slice(-4); })
  .replace(/(?<!\d)\d{4,6}[\s*]{4,}\d{3,4}(?!\d)/g, (m) => '*'.repeat(6) + m.slice(-4).replace(/\D/g, ''));
