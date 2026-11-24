import type { Store } from '../store.js';
import { addDays, at, ymd } from '../time.js';

/** 可复现的伪随机 */
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SHOPS: [string, string, number, number, number, string][] = [ // 商户 说明 最低分 最高分 每月次数 支付方式
  ['老街牛肉面馆', '午饭', 1800, 3600, 9, '微信支付'], ['渝味小面（高新店）', '外卖', 2200, 4200, 7, '微信支付'], ['小满咖啡', '咖啡', 990, 2600, 7, '零钱通'], ['绿禾超市', '日用百货', 2500, 18000, 4, '花呗'], ['鲜果集', '水果', 1500, 6000, 4, '支付宝'],
  ['城市地铁', '地铁', 300, 700, 16, '云闪付'], ['顺路出行', '打车', 1200, 5800, 5, '微信支付'], ['山野户外用品', '户外用品', 9900, 69900, 0.5, '招商银行信用卡(1234)'], ['云衣服饰旗舰店', '服饰', 5900, 39900, 1, '花呗'], ['星河影城', '电影', 3990, 11900, 1, '支付宝'],
  ['国家电网', '电费', 6000, 28000, 1, '支付宝'], ['中国移动', '话费', 5900, 5900, 1, '支付宝'], ['安心房屋租赁', '房租', 260000, 260000, 1, '建设银行储蓄卡(5678)'], ['晴天书店', '书籍', 2900, 12900, 0.8, '微信支付'], ['康宁大药房', '药品', 1500, 9800, 0.6, '微信支付'], ['乐动健身', '健身', 19900, 19900, 1, '招商银行信用卡(1234)'],
];
/** 演示数据：最近 14 个月的虚构账单。 */
export function seedDemo(store: Store, now = Date.now()): number {
  if (store.counts().total) return 0;
  const r = rng(20261124), today = ymd(now);
  let n = 0;
  store.db.tx(() => {
    const add = (day: string, h: number, mi: number, o: Record<string, any>): number => {
      const t = at(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8), h, mi);
      const id = store.createBill({ author: '演示', source: o.source ?? 'qq', at: t });
      store.db.run(`UPDATE bills SET kind=?,direction=?,amount=?,currency=?,merchant=?,item=?,method=?,time_src='voucher',flags='[]',refund_of=?,created_at=?,updated_at=? WHERE id=?`, o.kind ?? 'expense', o.direction ?? 'out', o.amount, o.currency ?? 'CNY', o.merchant ?? '', o.item ?? '', o.method ?? '', o.refund_of ?? null, t, t, id);
      store.refresh(id); n++;
      return id;
    };
    for (let i = 425; i >= 1; i--) {
      const day = addDays(today, -i), d = +day.slice(8);
      for (const [m, item, lo, hi, per, method] of SHOPS) {
        const fixed = per === 1 && lo === hi;
        if (fixed ? d !== (m === '安心房屋租赁' ? 1 : 10) : r() > per / 30) continue;
        const amount = fixed ? lo : Math.round((lo + (hi - lo) * r() ** 1.6) / 10) * 10;
        const id = add(day, /午|外卖/.test(item) ? 12 : 8 + Math.floor(r() * 13), Math.floor(r() * 60), { merchant: m, item, amount, method });
        if (/服饰|户外/.test(m) && r() < 0.18 && i > 6) add(addDays(day, 3 + Math.floor(r() * 3)), 10, 5, { kind: 'refund', direction: 'in', merchant: m, item: '退款', amount, method, refund_of: id });
      }
      if (d === 10) add(day, 10, 0, { kind: 'income', direction: 'in', merchant: '测试公司', item: '工资', amount: 1_200_000, method: '建设银行储蓄卡(5678)' });
      if (d === 18) add(day, 9, 0, { kind: 'repay', merchant: '招商银行信用卡', item: '信用卡还款', amount: 200000 + Math.floor(r() * 2000) * 100, method: '建设银行储蓄卡(5678)' });
      if (d === 22 && r() < 0.5) add(day, 20, 0, { kind: 'transfer', item: '转账给家人', amount: 100000, method: '零钱' });
      if (d === 8 && r() < 0.4) add(day, 3, 22, { merchant: 'CLOUD HOSTING INC', item: '云服务', amount: 1200, currency: 'USD', method: 'Visa信用卡(4321)' });
    }
    store.saveBudget(0, 650_000);
    const food = store.categories().find((c) => c.name === '餐饮' && !c.parent_id);
    if (food) store.saveBudget(food.id, 150_000);
  });
  return n;
}
