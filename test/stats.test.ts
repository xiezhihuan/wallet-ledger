import assert from 'node:assert/strict';
import test from 'node:test';
import { Db } from '../src/db.js';
import { Stats } from '../src/stats.js';
import { Store } from '../src/store.js';
import { toCsv } from '../src/exports.js';
import { addDays, at, periodOf, ymd } from '../src/time.js';

const NOW = at(2026, 11, 14, 21, 0);
function make(now = NOW) { const s = new Store(new Db(':memory:'), () => now); return { s, st: new Stats(s) }; }
function add(s: Store, day: string, amount: number | null, o: Record<string, any> = {}): number {
  const [h, mi] = (o.hm ?? '12:00').split(':').map(Number), id = s.createBill({ author: 't', source: 'web', at: at(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8), h, mi) });
  s.db.run(`UPDATE bills SET kind=?,amount=?,currency=?,merchant=?,method=?,time_src='voucher',flags=?,refund_of=?,category_id=?,category_src='manual',locked='["category_id"]',dup_ok=? WHERE id=?`, o.kind ?? 'expense', amount, o.currency ?? 'CNY', o.merchant ?? '', o.method ?? '', JSON.stringify(o.pending ? [{ field: 'amount', hard: true, reason: 'x' }] : []), o.refund_of ?? null, o.cat ? s.matchCategory(o.cat, o.kind === 'income' ? 'income' : 'expense')!.id : null, JSON.stringify(Array.from({ length: 999 }, (_x, i) => i + 1)), id);
  s.refresh(id);
  return id;
}
const R = (from: string, to: string) => ({ from, to });

test('周月季年边界：跨日、跨周、跨月、跨年各归各期', () => {
  const { s, st } = make();
  add(s, '2025-12-31', 100, { hm: '23:59' }); add(s, '2026-01-01', 200, { hm: '00:00' }); add(s, '2026-03-31', 400); add(s, '2026-04-01', 800); add(s, '2026-11-08', 1600, { hm: '23:59' }); add(s, '2026-11-09', 3200, { hm: '00:00' });
  const n = (u: any, d: string) => st.totals(periodOf(u, d)).net;
  assert.equal(n('year', '2025-06-01'), 100); assert.equal(n('year', '2026-06-01'), 6200); assert.equal(n('month', '2025-12-01'), 100); assert.equal(n('month', '2026-01-31'), 200);
  assert.equal(n('quarter', '2026-03-31'), 600); assert.equal(n('quarter', '2026-04-01'), 800); assert.equal(n('week', '2026-11-08'), 1600); assert.equal(n('week', '2026-11-09'), 3200); assert.equal(n('week', '2026-01-01'), 300); // 12-29 ~ 01-04 跨年周
  // 各粒度加总一致
  const months = Array.from({ length: 12 }, (_x, i) => n('month', `2026-${String(i + 1).padStart(2, '0')}-01`)).reduce((a, b) => a + b, 0), quarters = ['01', '04', '07', '10'].map((m) => n('quarter', `2026-${m}-01`)).reduce((a, b) => a + b, 0);
  assert.equal(months, 6200); assert.equal(quarters, 6200);
});
test('退款跨期：默认冲减原消费期；可切换为到账期；未关联的算到账期；两种口径总和一致', () => {
  const { s, st } = make();
  const a = add(s, '2025-12-20', 10000, { cat: '服饰鞋包', merchant: 'A店' }); add(s, '2026-01-05', 4000, { kind: 'refund', refund_of: a, cat: '正餐', merchant: 'B' }); add(s, '2026-01-06', 1000, { kind: 'refund', merchant: 'C' }); add(s, '2026-01-07', 9000, { cat: '正餐' });
  const dec = periodOf('month', '2025-12-01'), jan = periodOf('month', '2026-01-01');
  assert.equal(st.totals(dec).net, 6000); assert.equal(st.totals(jan).net, 8000); assert.equal(st.totals({ ...dec, basis: 'refund' }).net, 10000); assert.equal(st.totals({ ...jan, basis: 'refund' }).net, 4000);
  for (const basis of ['original', 'refund'] as const) assert.equal(st.totals({ from: '2025-12-01', to: '2026-01-31', basis }).net, 14000);
  assert.equal(st.byCategory(dec)[0]!.name, '购物'); assert.equal(st.byCategory(dec)[0]!.net, 6000, '退款跟随原支出的分类'); assert.equal(st.byMerchant(dec).rows[0]!.name, 'A店');
  assert.deepEqual(st.crossRefund(dec).refunded_later, { count: 1, amount: 4000 }); assert.deepEqual(st.crossRefund(jan).received_for_earlier, { count: 1, amount: 4000 });
  s.saveSetting('refund_basis', 'refund'); assert.equal(st.totals(dec).net, 10000);
  s.remove(a, 't'); s.saveSetting('refund_basis', 'original'); assert.equal(st.totals(dec).net, 0); assert.equal(st.totals(jan).net, 4000, '原支出删除后退款按到账日');
});
test('收入 / 转账 / 还款 / 外币 / 待确认 / 疑似重复 / 列表都不进消费，且单独列出', () => {
  const { s, st } = make(), w = R('2026-11-01', '2026-11-30');
  add(s, '2026-11-01', 5000); add(s, '2026-11-02', 9900, { kind: 'income' }); add(s, '2026-11-02', 8800, { kind: 'transfer' }); add(s, '2026-11-02', 7700, { kind: 'repay' }); add(s, '2026-11-03', 1200, { currency: 'USD' }); add(s, '2026-11-03', 300, { currency: 'USD', kind: 'refund' }); add(s, '2026-11-04', 6600, { pending: true }); add(s, '2026-11-04', null);
  const d = add(s, '2026-11-01', 5000); s.db.run(`UPDATE bills SET status='dup', dup_of=1 WHERE id=?`, d);
  const r = st.report(w, '2026-11-14'); assert.equal(r.net, 5000); assert.equal(r.count, 1);
  assert.deepEqual(r.excluded.pending, { count: 2, amount: 6600 }); assert.equal(r.excluded.pending_unknown, 1); assert.equal(r.excluded.dup.count, 1); assert.deepEqual(r.excluded.income, { count: 1, amount: 9900 }); assert.equal(r.excluded.transfer.amount, 8800); assert.equal(r.excluded.repay.amount, 7700); assert.deepEqual(r.excluded.foreign, [{ currency: 'USD', count: 2, amount: 900 }]);
  assert.equal(st.totals({ ...w, includePending: true }).net, 11600); assert.equal(s.list({ counted: true, withPending: true, ...w }).sum.net, 11600);
});
test('统计与明细对账：2000 笔随机数据，每个数字与点进去的明细合计一致', () => {
  const { s, st } = make(); let seed = 7; const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const cats = ['正餐', '外卖', '打车', '日用百货', '餐饮', '房租房贷', ''], shops = ['甲店', '乙店', '丙', '', '丁超市'], meth = ['零钱', '花呗', '', '招商银行(1234)'], exp: number[] = [];
  s.db.tx(() => { for (let i = 0; i < 2000; i++) { const day = addDays('2025-01-01', rnd(680)), k = rnd(20); if (k < 14) { const id = add(s, day, 1 + rnd(50000), { cat: cats[rnd(7)], merchant: shops[rnd(5)], method: meth[rnd(4)], pending: rnd(15) === 0 }); exp.push(id); } else if (k < 17 && exp.length) { const o = s.require(exp[rnd(exp.length)]!); add(s, addDays(o.day, rnd(90)), 1 + rnd(o.amount), { kind: 'refund', refund_of: rnd(3) ? o.id : null, merchant: 'x', method: 'y' }); } else add(s, day, 1 + rnd(9999), { kind: ['income', 'transfer', 'repay'][k - 17] }); } });
  for (const basis of ['original', 'refund'] as const) for (const includePending of [false, true]) for (const w of [R('2025-01-01', '2026-11-30'), periodOf('month', '2025-06-10'), periodOf('week', '2025-12-30'), periodOf('quarter', '2026-02-02'), periodOf('year', '2025-03-03'), R('2025-05-07', '2025-08-19')]) {
    const o = { ...w, basis, includePending }, t = st.totals(o), f = { counted: true, withPending: includePending, basis, ...w, pageSize: 100_000 };
    const list = s.list(f), manual = list.items.reduce((n, b) => n + b.spend, 0);
    assert.equal(list.sum.net, t.net); assert.equal(manual, t.net); assert.equal(list.items.filter((b) => b.kind === 'expense').length, t.count);
    const c = st.byCategory(o); assert.equal(c.reduce((n, x) => n + x.net, 0), t.net);
    for (const x of c) { assert.equal(x.children.reduce((n: number, y: any) => n + y.net, 0), x.net); assert.equal(s.list({ ...f, category: x.id ?? 'none' }).sum.net, x.net); for (const y of x.children) if (!y.direct) assert.equal(s.list({ ...f, category: y.id ?? 'none' }).sum.net, y.net); }
    const m = st.byMerchant(o, 999).rows; assert.equal(m.reduce((n, x) => n + x.net, 0), t.net); for (const x of m) assert.equal(s.list({ ...f, merchant: x.name }).sum.net, x.net);
    const p = st.byMethod(o); assert.equal(p.reduce((n, x) => n + x.net, 0), t.net); for (const x of p) assert.equal(s.list({ ...f, method: x.name }).sum.net, x.net);
    for (const u of ['day', 'week', 'month'] as const) { const tr = st.trend(o, u); assert.equal(tr.points.reduce((n, x) => n + x.net, 0), t.net); if (u !== 'day') for (const x of tr.points) assert.equal(s.list({ ...f, from: x.from, to: x.to }).sum.net, x.net); }
  }
});
test('报表：日均按已过天数；进行中的周期同进度对比；自定义区间', () => {
  const { s, st } = make();
  for (let d = 1; d <= 30; d++) add(s, `2026-10-${String(d).padStart(2, '0')}`, 100); for (let d = 1; d <= 14; d++) add(s, `2026-11-${String(d).padStart(2, '0')}`, 200); add(s, '2025-11-05', 500);
  const r = st.report(periodOf('month', '2026-11-14'), '2026-11-14'); assert.deepEqual([r.net, r.daily, r.elapsed, r.running], [2800, 200, 14, true]);
  assert.equal(r.prev.net, 3000); assert.equal(r.prev.same_net, 1400); assert.equal(r.prev.percent, 100); assert.equal(r.yoy.same_net, 500); assert.deepEqual(r.prev.same_range, R('2026-10-01', '2026-10-14'));
  const o = st.report(periodOf('month', '2026-10-01'), '2026-11-14'); assert.deepEqual([o.running, o.elapsed, o.daily], [false, 31, 97]); assert.equal(o.prev.percent, null);
  const f = st.report(periodOf('month', '2027-01-01'), '2026-11-14'); assert.equal(f.daily, 0);
  assert.throws(() => st.report(R('2026-02-30', '2026-03-01')), /日期/); assert.throws(() => st.report(R('2026-03-02', '2026-03-01')), /晚于/); assert.throws(() => st.report(R('1999-01-01', '2026-03-01')), /最长/);
});
test('预算：超支与临近提示；只能设一级分类；退款回冲', () => {
  const { s, st } = make(), food = s.matchCategory('餐饮')!.id; s.saveBudget(0, 10000); s.saveBudget(food, 5000);
  const a = add(s, '2026-11-02', 4500, { cat: '正餐' }); add(s, '2026-11-03', 6000, { cat: '打车' }); let b = st.budget('2026-11-14', '2026-11-14'); assert.deepEqual(b.map((x) => [x.name, x.used, x.state]), [['总预算', 10500, 'over'], ['餐饮', 4500, 'near']]);
  add(s, '2026-12-01', 4500, { kind: 'refund', refund_of: a }); b = st.budget('2026-11-14', '2026-11-14'); assert.equal(b[0]!.used, 6000); assert.throws(() => s.saveBudget(s.matchCategory('正餐')!.id, 1), /一级/); s.saveBudget(0, 0); assert.equal(s.budgets().length, 1);
});
test('分类：两级、增删改、删除时转移账与规则、留痕', () => {
  const { s } = make(), p = s.saveCategory({ name: '育儿' }), c = s.saveCategory({ name: '奶粉', parent_id: p, keywords: '奶粉,配方' });
  assert.throws(() => s.saveCategory({ name: '三级', parent_id: c }), /两级/); assert.throws(() => s.saveCategory({ name: '育儿' }), /已有/);
  const id = add(s, '2026-11-01', 100, { merchant: '某店', cat: '奶粉' }); s.saveRule({ match: 'merchant', pattern: '某店', category_id: c });
  assert.equal(s.classify({ kind: 'expense', merchant: '', item: '配方奶粉', note: '' })!.id, c); s.saveCategory({ id: c, name: '口粮' }); assert.equal(s.categoryName(c), '育儿/口粮');
  const to = s.matchCategory('日用百货')!.id; s.deleteCategory(p, to, 't'); assert.equal(s.require(id).category_id, to); assert.equal(s.rules()[0]!.category_id, to); assert.ok(s.detail(id).events.some((e: any) => /删除分类/.test(e.detail)));
  s.deleteCategory(to, null, 't'); assert.equal(s.require(id).category_id, null); assert.equal(s.rules().length, 0);
});
test('规则：精确商户优先于包含，包含优先于关键词；撤销可恢复；批量重新归类不动人工的', () => {
  const { s } = make(), taxi = s.matchCategory('打车')!.id, book = s.matchCategory('书籍')!.id, b = (m: string) => s.classify({ kind: 'expense', merchant: m, item: '', note: '' });
  assert.equal(s.categoryName(b('老王火锅店')!.id), '餐饮/正餐'); s.saveRule({ match: 'contains', pattern: '老王', category_id: book }); assert.equal(b('老王火锅店')!.id, book); const r = s.saveRule({ match: 'merchant', pattern: '老王火锅店（总店）', category_id: taxi }); assert.equal(b('老王火锅店')!.id, taxi);
  s.deleteRule(r); assert.equal(b('老王火锅店')!.id, book); s.deleteRule(r, true); assert.equal(b('老王火锅店')!.id, taxi);
  const x = s.createBill({ author: 't', source: 'web', at: NOW }); s.update(x, { amount: 100, merchant: '新店铺' }, 't'); assert.equal(s.require(x).category_id, null); s.saveRule({ match: 'merchant', pattern: '新店铺', category_id: taxi }); assert.equal(s.reclassify('新店铺'), 1); assert.equal(s.require(x).category_id, taxi);
  s.update(x, { category_id: book }, 't', false); s.reclassify(); assert.equal(s.require(x).category_id, book);
});
test('CSV 防公式注入、长单号不失真、退款为负', () => {
  const { s } = make(); const a = add(s, '2026-11-01', 100, { merchant: '=cmd|1', method: '+x' }); s.update(a, { trade_no: '4200002988202611031234567890', note: '含"引号",逗号' }, 't'); add(s, '2026-11-02', 40, { kind: 'refund', refund_of: a });
  const c = toCsv(s, {}); assert.match(c, /^﻿编号/); assert.match(c, /'=cmd\|1/); assert.match(c, /"\t4200002988202611031234567890"/); assert.match(c, /"含""引号"",逗号"/); assert.match(c, /,-0\.40,/);
});
test('性能：1 万笔账的报表与搜索', () => {
  const { s, st } = make();
  s.db.tx(() => { for (let i = 0; i < 10_000; i++) { const day = addDays('2025-01-01', i % 680), id = Number(s.db.run(`INSERT INTO bills(kind,status,amount,merchant,occurred_at,day,search_text,created_at,updated_at,category_id) VALUES('expense','ok',?,?,?,?,?,1,1,?)`, 100 + i, `商户${i % 300}`, at(2025, 1, 1), day, `商户${i % 300} 午饭`, 2 + (i % 40)).id); void id; } });
  let t = Date.now(); st.report(periodOf('year', '2026-05-05'), ymd(NOW)); const a = Date.now() - t; t = Date.now(); s.list({ q: '商户299' }); const b = Date.now() - t;
  assert.ok(a < 2000 && b < 1000, `报表 ${a}ms 搜索 ${b}ms`); console.log(`# 1 万笔：年报表 ${a}ms，搜索 ${b}ms`);
});
