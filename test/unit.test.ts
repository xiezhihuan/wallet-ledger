import assert from 'node:assert/strict';
import test from 'node:test';
import { cnInt, money, toCents, yuan } from '../src/money.js';
import { slices } from '../src/ocr.js';
import { findMoney, maskCard, parseSms } from '../src/parse/receipt.js';
import { parseAmount, parseText } from '../src/parse/text.js';
import { parseStamp } from '../src/parse/when.js';
import { parseCommand } from '../src/intake.js';
import { relate } from '../src/store.js';
import { blank, type Receipt } from '../src/parse/receipt.js';
import { maskNumbers, similarName } from '../src/text.js';
import { addMonths, at, compareRanges, fmtTime, label, namedRange, parts, periodOf, unitOf, validDay, ymd } from '../src/time.js';

const ref = at(2026, 11, 14, 21, 0);

test('金额：整数分，拒绝非法与多余小数', () => {
  assert.equal(toCents('1,234.5'), 123450); assert.equal(toCents('0.29'), 29); assert.equal(toCents('28'), 2800); assert.equal(toCents('-5.00'), -500);
  for (const s of ['1.234', '1,23', 'abc', '', '1e3', '--1', '9999999999999999']) assert.equal(toCents(s), null, s);
  assert.equal(yuan(5), '0.05'); assert.equal(yuan(-123450), '-1234.50'); assert.equal(money(123456789), '¥1,234,567.89'); assert.equal(money(1200, 'USD'), 'US$12.00'); assert.equal(money(null), '金额待确认');
  // 浮点误差场景
  assert.equal(Array.from({ length: 1000 }, () => toCents('0.1')!).reduce((a, b) => a + b, 0), 10_000);
  for (const [s, n] of [['二十八', 28], ['一百二', 120], ['一百零五', 105], ['一万三', 13000], ['两千', 2000], ['三百六十五', 365]] as const) assert.equal(cnInt(s), n);
});
test('时间：上海时区、周一为一周开始、月季年边界', () => {
  assert.equal(ymd(Date.UTC(2026, 10, 14, 15, 59)), '2026-11-14'); assert.equal(ymd(Date.UTC(2026, 10, 14, 16, 0)), '2026-11-15');
  assert.deepEqual(periodOf('week', '2026-11-15'), { from: '2026-11-09', to: '2026-11-15' }); // 周日属于前一个周一
  assert.deepEqual(periodOf('week', '2026-11-16'), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(periodOf('week', '2027-01-01'), { from: '2026-12-28', to: '2027-01-03' }); // 跨年的周
  assert.deepEqual(periodOf('month', '2028-02-10'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(periodOf('quarter', '2026-11-14'), { from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(periodOf('year', '2026-11-14'), { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28'); assert.equal(addMonths('2028-02-29', -12), '2027-02-28');
  assert.deepEqual(compareRanges(periodOf('month', '2026-03-05')), { prev: { from: '2026-02-01', to: '2026-02-28' }, yoy: { from: '2025-03-01', to: '2025-03-31' } });
  assert.deepEqual(compareRanges(periodOf('week', '2026-11-14')).yoy, { from: '2025-11-10', to: '2025-11-16' });
  assert.deepEqual(compareRanges({ from: '2026-11-03', to: '2026-11-12' }).prev, { from: '2026-10-24', to: '2026-11-02' });
  assert.deepEqual(namedRange('上个月', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' }); assert.deepEqual(namedRange('上季度', '2026-02-01'), { from: '2025-10-01', to: '2025-12-31' });
  assert.deepEqual(namedRange('这周', '2026-11-15'), { from: '2026-11-09', to: '2026-11-15' }); assert.equal(namedRange('明天', '2026-11-15'), null);
  assert.equal(unitOf({ from: '2026-10-01', to: '2026-12-31' }), 'quarter'); assert.equal(unitOf({ from: '2026-10-01', to: '2026-12-30' }), null); assert.equal(label({ from: '2026-10-01', to: '2026-12-31' }), '2026年第4季度');
  assert.ok(validDay('2028-02-29')); for (const s of ['2026-02-29', '2026-13-01', '2026-1-1', 'x']) assert.ok(!validDay(s), s);
  assert.equal(parts(at(2026, 1, 1)).w, 4);
});
test('凭证时间：缺空格、缺年份、跨年、未来不取', () => {
  assert.equal(fmtTime(parseStamp('2026-11-0619:42:10', ref)!.ms), '2026-11-06 19:42'); assert.equal(fmtTime(parseStamp('2026年10月31日23:58:02', ref)!.ms), '2026-10-31 23:58');
  assert.equal(fmtTime(parseStamp('11-0210:01', ref)!.ms), '2026-11-02 10:01'); assert.equal(fmtTime(parseStamp('11月9日18:40', ref)!.ms), '2026-11-09 18:40');
  assert.equal(ymd(parseStamp('12月31日 23:50', at(2027, 1, 2))!.ms), '2026-12-31'); assert.equal(fmtTime(parseStamp('昨天 19:42', ref)!.ms), '2026-11-13 19:42');
  for (const s of ['2026-02-30 10:00', '13月40日', '¥28.00', '4200002988202611031234567890']) assert.equal(parseStamp(s, ref), null, s);
});
test('金额文字：符号、千分位、误读的 ¥；排除时间、日期、单号', () => {
  const f = (s: string) => findMoney(s).map((m) => `${m.sign}${m.cents}${m.currency}`);
  assert.deepEqual(f('-28.00'), ['-2800CNY']); assert.deepEqual(f('-¥1,218.00'), ['-121800CNY']); assert.deepEqual(f('已优惠¥11.00 实付 ¥28.50'), ['1100CNY', '2850CNY']); assert.deepEqual(f('Y19.90'), ['1990CNY']);
  assert.deepEqual(f('-US$12.00'), ['-1200USD']); assert.deepEqual(f('35.50元'), ['3550CNY']); assert.deepEqual(f('¥28'), ['2800CNY']);
  for (const s of ['12:36', '2026-11-03', '4200002988202611031234567890', '8.5折', '3.2公里', 'V3.2.1', '86%', '招商银行(1234)']) assert.deepEqual(f(s), [], s);
});
test('文字记账', () => {
  const p = (s: string) => parseText(s, ref).map((e) => [e.receipt.amount, e.receipt.sure, e.receipt.item]);
  assert.deepEqual(p('午饭 28'), [[2800, true, '午饭']]); assert.deepEqual(p('午饭28，打车35'), [[2800, true, '午饭'], [3500, true, '打车']]); assert.deepEqual(p('早饭 5\n午饭 28.5\n和同事'), [[500, true, '早饭'], [2850, true, '午饭']]);
  assert.deepEqual(p('买了3个苹果 12'), [[1200, true, '3个苹果']]); assert.deepEqual(p('二十八块五 奶茶'), [[2850, true, '奶茶']]); assert.deepEqual(p('停车费 10元 2小时')[0]![0], 1000);
  assert.deepEqual(p('人均100左右'), [[null, false, '']]); assert.deepEqual(p('和老王一起'), [[null, false, '']]);
  assert.equal(parseText('打车 35.5 昨天', ref)[0]!.receipt.ms, at(2026, 11, 13, 12)); assert.equal(fmtTime(parseText('昨晚8点 火锅 188', ref)[0]!.receipt.ms), '2026-11-13 20:00'); assert.equal(ymd(parseText('上周五 电影 79.8', ref)[0]!.receipt.ms!), '2026-11-06');
  for (const [s, k] of [['退款 59 卫衣', 'refund'], ['还信用卡 3200', 'repay'], ['转给小李 200', 'transfer'], ['工资 8500', 'income'], ['午饭 28', 'expense']] as const) assert.equal(parseText(s, ref)[0]!.receipt.kind, k, s);
  // 分不清哪个是金额：不猜
  const amb = parseText('12和35', ref)[0]!.receipt; assert.equal(amb.sure, false); assert.deepEqual(amb.flags[0]!.candidates, [1200, 3500]);
  assert.equal(parseText('奶茶十五块', ref, true)[0]!.receipt.voice, true); assert.equal(parseAmount('二十八块五')!.cents, 2850); assert.equal(parseAmount('abc'), null);
});
test('银行短信：取动作金额不取余额', () => {
  const [a] = parseSms('您尾号5678的储蓄卡11月12日8时15分向和顺生鲜消费支出人民币63.20元,活期余额2,310.05元。[建设银行]', ref);
  assert.deepEqual([a!.amount, a!.merchant, fmtTime(a!.ms), a!.method, a!.kind], [6320, '和顺生鲜', '2026-11-12 08:15', '建设银行储蓄卡(5678)', 'expense']);
  assert.equal(parseSms('您账户1234于11月10日入账工资人民币8500.00元，余额9000.00元。【招商银行】', ref)[0]!.kind, 'income');
  assert.equal(parseSms('今天花了28元', ref).length, 0);
});
test('号码遮盖', () => {
  assert.equal(maskNumbers('卡号 6225 8812 3456 7890 手机 13800001111'), '卡号 ******7890 手机 ******1111'); assert.equal(maskNumbers('金额 1234567.89，订单 4200002988202611031234567890'), '金额 1234567.89，订单 ******7890'); assert.equal(maskNumbers('2026-11-03 12:35 ¥28.00'), '2026-11-03 12:35 ¥28.00');
  assert.equal(maskNumbers('6225********1234'), '******1234'); assert.equal(maskCard('6225********1234'), '银行卡(1234)');
  assert.ok(similarName('渝味小面（高新店）', '渝味小面')); assert.ok(!similarName('老街牛肉面馆', '蓝山便利店'));
});
test('同一笔判定', () => {
  const v = (o: Partial<Receipt>): Receipt => ({ ...blank('voucher'), platform: 'wechat', sure: true, ms: ref, precise: true, ...o });
  assert.equal(relate(v({ amount: 2800, ids: [{ type: 'trade', no: 'AAAAAAAA1' }] }), v({ amount: 2800, ids: [{ type: 'trade', no: 'AAAAAAAA1' }] })), 'diff');
  assert.equal(relate(v({ amount: 2800, ids: [{ type: 'trade', no: 'AAAAAAAA1' }] }), v({ amount: 2800, ids: [{ type: 'trade', no: 'AAAAAAAA2' }] })), 'diff');
  assert.equal(relate(v({ amount: 2800 }), v({ amount: 3500 })), 'diff'); assert.equal(relate(v({ amount: 2800 }), v({ amount: null, sure: false })), 'unknown');
  assert.equal(relate(v({ amount: 2850, merchant: '美团平台商户' }), { ...blank('order'), amount: 2850, sure: true, merchant: '渝味小面', ms: ref - 120_000, precise: true }), 'same');
  assert.equal(relate(v({ amount: 2800, merchant: '老街牛肉面馆' }), v({ amount: 2800, merchant: '蓝山便利店' })), 'diff');
  assert.equal(relate(v({ amount: 5900, kind: 'refund', ids: [{ type: 'order', no: '12345678' }] }), v({ amount: 5900, ids: [{ type: 'order', no: '12345678' }] })), 'diff');
  assert.equal(relate({ ...blank('text'), amount: 500, sure: true }, { ...blank('text'), amount: 500, sure: true }), 'diff');
});
test('指令识别不误伤记账文字', () => {
  const c = (s: string) => { const x = parseCommand(s); return x && [x.name, x.id ?? 0, x.arg]; };
  assert.deepEqual(c('改 28.5'), ['改amount', 0, '28.5']); assert.deepEqual(c('改 #12 28.5'), ['改amount', 12, '28.5']); assert.deepEqual(c('改金额 二十八块五'), ['改amount', 0, '二十八块五']); assert.deepEqual(c('改 #12 分类 打车'), ['改category', 12, '打车']); assert.deepEqual(c('改分类打车'), ['改category', 0, '打车']); assert.deepEqual(c('改时间 昨天 12:30'), ['改time', 0, '昨天 12:30']);
  assert.deepEqual(c('入账 #5 1 3-4'), ['入账', 5, '1 3-4']); assert.deepEqual(c('入账'), ['入账', 0, '']); assert.deepEqual(c('补充 12 和同事'), ['补充', 12, '和同事']); assert.deepEqual(c('并入 12 7'), ['并入', 12, '7']); assert.deepEqual(c('删除 3'), ['删除', 3, '']);
  assert.deepEqual(c('本月花到哪里了？'), ['统计', 0, '本月']); assert.deepEqual(c('今天'), ['统计', 0, '今天']); assert.deepEqual(c('这个季度花了多少钱'), ['统计', 0, '这个季度']); assert.deepEqual(c('新建 午饭 28'), ['新建', 0, '午饭 28']);
  for (const s of ['午饭 28', '今天午饭 28', '改装车 2000', '查理餐厅 88', '删除线贴纸 5', '补充维生素 59', '退款 59 卫衣', '确认收货 打车 20', '本月房租 2600', '新建文件夹 12', '入账本 5', '分类垃圾桶 45']) assert.equal(c(s), null, s);
});
test('长图切片不重不漏', () => {
  for (const h of [500, 1800, 1801, 3600, 9999]) { const s = slices(h); for (let y = 0; y < h; y += 7) assert.equal(s.filter((x) => y >= x.from && y < x.to).length, 1); assert.ok(s.every((x) => x.y + x.h <= h)); }
});
