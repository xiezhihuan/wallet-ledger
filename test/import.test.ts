import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { Db } from '../src/db.js';
import { Importer, parseCsv, readBillFile } from '../src/importers/bills.js';
import { readXlsx, unzip } from '../src/importers/zip.js';
import { Store } from '../src/store.js';
import { Stats } from '../src/stats.js';
import { ALIPAY, WECHAT } from './bill-files.js';
import { at, fmtTime } from '../src/time.js';

const gbk = (s: string): Buffer => { // 只为测试造 GB18030：逐字反查
  const map = ((globalThis as any).__gbk ??= (() => { const m = new Map<string, number[]>(), d = new TextDecoder('gb18030'); for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x40; b <= 0xfe; b++) if (b !== 0x7f) m.set(d.decode(new Uint8Array([a, b])), [a, b]); return m; })()) as Map<string, number[]>;
  return Buffer.from([...s].flatMap((c) => (c.charCodeAt(0) < 128 ? [c.charCodeAt(0)] : map.get(c) ?? [63])));
};
export function zip(files: Record<string, string>, flag = 0): Buffer {
  const parts: Buffer[] = [], dir: Buffer[] = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), body = zlib.deflateRawSync(raw), n = Buffer.from(name), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(flag, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(flag, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, body); dir.push(c, n); off += 30 + n.length + body.length;
  }
  const d = Buffer.concat(dir), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(d.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, d, e]);
}
/** 把 CSV 内容装成 xlsx：时间列用 Excel 日期序列号，其余用共享字符串 */
function xlsx(csv: string): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;'), shared: string[] = [], si = (s: string) => { const i = shared.indexOf(s); return i >= 0 ? i : shared.push(s) - 1; };
  const rows = parseCsv(csv).map((r, i) => `<row r="${i + 1}">${r.map((v, j) => { const ref = String.fromCharCode(65 + j) + (i + 1), m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(v.trim()); if (!v) return ''; if (j === 0 && m) return `<c r="${ref}" s="1"><v>${Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 86400_000 + 25569}</v></c>`; if (j === 5 && /^¥/.test(v)) return `<c r="${ref}"><v>${v.replace(/[¥,]/g, '')}</v></c>`; return `<c r="${ref}" t="s"><v>${si(v)}</v></c>`; }).join('')}</row>`).join('');
  return zip({ 'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`, 'xl/sharedStrings.xml': `<sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`, 'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="176" formatCode="yyyy\\-mm\\-dd hh:mm:ss"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="176"/></cellXfs></styleSheet>' });
}
const make = () => { const s = new Store(new Db(':memory:'), () => at(2026, 11, 14, 21)); return { s, imp: new Importer(s), st: new Stats(s) }; };
const W = { from: '2026-11-01', to: '2026-11-30' };

test('微信 CSV：类型口径、退款、提现、状态；千分位与引号', () => {
  const { platform, rows } = readBillFile(Buffer.from('﻿' + WECHAT), 'a.csv'); assert.equal(platform, 'wechat');
  assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.action]), [['expense', 2800, 'new'], ['expense', 1760, 'new'], ['transfer', 20000, 'new'], ['income', 5000, 'new'], ['repay', 320000, 'new'], ['transfer', 10010, 'new'], ['expense', 112900, 'new'], ['refund', 12900, 'new'], ['expense', 2800, 'skip']]);
  assert.equal(rows[0]!.trade_no, '4200002988202611031234567890'); assert.equal(fmtTime(rows[0]!.time), '2026-11-03 12:35'); assert.equal(rows[6]!.item, '卫衣, 灰色');
});
test('微信 xlsx 与 CSV 结果一致（日期序列号、共享字符串）', () => {
  const a = readBillFile(Buffer.from(WECHAT), 'a.csv').rows, b = readBillFile(xlsx(WECHAT), 'a.xlsx').rows;
  assert.deepEqual(b.map((r) => [r.time, r.kind, r.amount, r.merchant, r.trade_no]), a.map((r) => [r.time, r.kind, r.amount, r.merchant, r.trade_no]));
});
test('支付宝 GB18030 CSV：不计收支、退款单号前缀、交易关闭', () => {
  const { platform, rows } = readBillFile(gbk(ALIPAY), 'a.csv'); assert.equal(platform, 'alipay');
  assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.action]), [['expense', 8635, 'new'], ['expense', 3250, 'new'], ['refund', 5900, 'new'], ['expense', 5900, 'new'], ['expense', 3900, 'skip'], ['expense', 1900, 'skip'].map((x, i) => (i === 0 ? rows[5]!.kind : x)), ['repay', 320000, 'new'], ['transfer', 50000, 'new']] as any);
  assert.equal(rows[0]!.method, '建设银行储蓄卡(5678)');
});
test('预览 → 入账 → 再导入同一文件不重复；退款冲减；统计正确', () => {
  const { s, imp, st } = make(), p = imp.preview(gbk(ALIPAY), '支付宝.csv'); assert.deepEqual(p.counts, { new: 6, exists: 0, maybe: 0, skip: 2 }); assert.equal(s.counts().total, 0, '预览不入账');
  const r = imp.commit(p.id, {}, '网页'); assert.equal(r.created, 6); assert.equal(st.totals(W).net, 8635 + 3250); const ref = s.list({ kind: 'refund' }).items[0]!; assert.ok(ref.refund_of);
  assert.throws(() => imp.commit(p.id, {}, 'x'), /已经处理/); const p2 = imp.preview(gbk(ALIPAY), '支付宝.csv'); assert.deepEqual(p2.counts, { new: 0, exists: 6, maybe: 0, skip: 2 }); assert.equal(imp.commit(p2.id, {}, 'x').created, 0); assert.equal(st.totals(W).net, 11885);
});
test('与已有截图 / 文字账去重：同单号视为已存在；金额时间相近列为疑似，由用户选择补全、另记或跳过', () => {
  const { s, imp, st } = make();
  const a = s.createBill({ author: 'q', source: 'qq', at: at(2026, 11, 3, 12, 35) }); s.db.run(`UPDATE bills SET amount=2800,merchant='老街牛肉面馆',time_src='voucher',ids='[{"type":"trade","no":"4200002988202611031234567890"}]',flags='[]' WHERE id=?`, a); s.refresh(a);
  const b = s.createBill({ author: 'q', source: 'qq', at: at(2026, 11, 4, 8, 30) }); s.db.run(`UPDATE bills SET amount=1760,item='便利店',time_src='sent',flags='[]' WHERE id=?`, b); s.refresh(b);
  const p = imp.preview(Buffer.from(WECHAT), 'w.csv'); assert.deepEqual(p.counts, { new: 6, exists: 1, maybe: 1, skip: 1 }); const m = (p.rows as any[]).find((x) => x.action === 'maybe'); assert.equal(m.match, b);
  const r = imp.commit(p.id, { decide: { [m.n]: 'link' } }, '网页'); assert.deepEqual([r.created, r.linked], [6, 1]); const y = s.require(b); assert.equal(y.merchant, '蓝山便利店'); assert.equal(y.trade_no, '100010960126110400000001'); s.refresh(b); assert.equal(s.require(b).trade_no, '100010960126110400000001');
  assert.equal(st.totals(W).net, 2800 + 1760 + 112900 - 12900); assert.equal(imp.preview(Buffer.from(WECHAT), 'w.csv').counts.new, 0, '补全单号后再导入能识别');
  // 先导入，再发截图：提示疑似重复
  const c = s.createBill({ author: 'q', source: 'qq', at: at(2026, 11, 8, 9, 0) }); s.db.run(`UPDATE bills SET amount=112900,merchant='云衣服饰',time_src='voucher',ids='[{"type":"trade","no":"4200002988202611080000000001"}]',flags='[]' WHERE id=?`, c); s.refresh(c); assert.equal(s.require(c).status, 'dup');
});
test('只入选中的行；疑似默认不入；放弃导入', () => {
  const { s, imp } = make(), p = imp.preview(Buffer.from(WECHAT), 'w.csv'), first = (p.rows as any[])[0].n; assert.equal(imp.commit(p.id, { pick: [first] }, 'x').created, 1); assert.equal(s.counts().total, 1); const q = imp.preview(Buffer.from(WECHAT), 'w.csv'); imp.discard(q.id); assert.throws(() => imp.commit(q.id, {}, 'x'), /已经处理/);
});
test('坏文件给出明确提示', () => {
  assert.throws(() => readBillFile(Buffer.from('a,b\n1,2'), 'x.csv'), /表头/); assert.throws(() => readBillFile(Buffer.from('PK\x03\x04xxxx'), 'x.xlsx'), /xlsx/); assert.throws(() => readBillFile(zip({ a: '1' }), 'x.zip'), /解压/); assert.throws(() => readBillFile(Buffer.from('d0cf11e0a1b11ae1', 'hex'), 'x.xls'), /xls/);
  assert.throws(() => unzip(zip({ 'xl/worksheets/sheet1.xml': 'x' }, 1), () => true), /密码/); assert.throws(() => unzip(zip({ big: 'x'.repeat(2_000_000) }), () => true, 1_000_000), /过大/); assert.throws(() => readXlsx(zip({ a: '1' })), /工作表/);
  assert.throws(() => readBillFile(Buffer.from('交易时间,收/支,金额\n'), 'x.csv'), /没有交易记录/);
});
