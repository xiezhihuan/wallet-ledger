import zlib from 'node:zlib';
import { UserError } from '../store.js';

/** 最小 ZIP 读取（仅供读 xlsx）：按中央目录取文件，限制解压大小防炸弹。 */
export function unzip(buf: Buffer, want: (name: string) => boolean, maxTotal = 64 * 1024 * 1024): Map<string, Buffer> {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new UserError('不是有效的 xlsx / zip 文件');
  const count = buf.readUInt16LE(e + 10), out = new Map<string, Buffer>();
  let p = buf.readUInt32LE(e + 16), total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new UserError('文件已损坏');
    const flag = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), raw = buf.readUInt32LE(p + 24), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (!want(name)) continue;
    if (flag & 1) throw new UserError('压缩包有密码。请先用平台给的解压密码解压，再导入里面的文件');
    if ((total += raw) > maxTotal) throw new UserError('文件解压后过大');
    const s = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), body = buf.subarray(s, s + size);
    if (method === 0) out.set(name, body);
    else if (method === 8) try { out.set(name, zlib.inflateRawSync(body, { maxOutputLength: maxTotal })); } catch { throw new UserError('文件已损坏或过大'); }
    else throw new UserError('不支持的压缩方式');
  }
  return out;
}
const ent = (s: string) => s.replace(/&(?:lt|gt|quot|apos|amp|#x?[0-9a-f]+);/gi, (m) => ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' })[m] ?? (() => { const n = /^&#x/i.test(m) ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; })());
const texts = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => ent(m[1]!)).join('');
/** xlsx 第一个工作表 → 二维字符串。日期序列号转成 YYYY-MM-DD HH:MM:SS。 */
export function readXlsx(buf: Buffer): string[][] {
  const z = unzip(buf, (n) => /^xl\/(?:sharedStrings|styles|worksheets\/sheet1)\.xml$/.test(n));
  const sheet = z.get('xl/worksheets/sheet1.xml')?.toString('utf8');
  if (!sheet) throw new UserError('没有找到工作表，请使用平台导出的原始文件');
  const shared = [...(z.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => texts(m[1] ?? ''));
  const styles = z.get('xl/styles.xml')?.toString('utf8') ?? '';
  const custom = new Map([...styles.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [+m[1]!, m[2]!]));
  const xfs = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '').matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].map((m) => +m[1]!);
  const isDate = (s: string | undefined) => { const id = xfs[Number(s ?? 0)] ?? 0; return (id >= 14 && id <= 22) || /[ymdhs]/i.test((custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '')); };
  const out: string[][] = [];
  for (const r of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const n = Number(/\br="(\d+)"/.exec(r[1]!)?.[1] ?? out.length + 1), row: string[] = [];
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c[1]!)?.[1], t = /\bt="(\w+)"/.exec(c[1]!)?.[1], s = /\bs="(\d+)"/.exec(c[1]!)?.[1], v = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? '')?.[1];
      const col = ref ? [...ref].reduce((a, x) => a * 26 + x.charCodeAt(0) - 64, 0) - 1 : row.length;
      if (col > 200) continue;
      let val = t === 's' ? (shared[Number(v)] ?? '') : t === 'inlineStr' ? texts(c[2] ?? '') : ent(v ?? '');
      if (t !== 's' && t !== 'inlineStr' && t !== 'str' && v && isDate(s) && Number(v) > 20000) val = new Date(Math.round((Number(v) - 25569) * 86400) * 1000).toISOString().replace('T', ' ').slice(0, 19);
      while (row.length < col) row.push('');
      row[col] = val;
    }
    while (out.length < n - 1 && n < 200_000) out.push([]);
    out.push(row);
  }
  return out;
}
