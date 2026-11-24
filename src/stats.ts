import type { Row } from './db.js';
import { pct } from './money.js';
import { UserError, type Basis, type Filter, type Store } from './store.js';
import { addDays, addMonths, compareRanges, diffDays, label, monday, periodOf, unitOf, validDay, ymd, type Range, type Unit } from './time.js';

export interface Totals { expense: number; refund: number; net: number; count: number; refund_count: number }
export interface StatsOptions extends Range { includePending?: boolean; basis?: Basis; category?: number | 'none'; merchant?: string; method?: string }

/**
 * 全部统计都从 store.where({counted:true}) 出发，与「账单列表」用同一段 SQL，
 * 因此任何一个数字点进去看到的明细合计必然相等。
 */
export class Stats {
  constructor(private store: Store) {}
  private get db() { return this.store.db; }

  private filter(o: StatsOptions): Filter { return { counted: true, withPending: o.includePending, basis: o.basis, from: o.from, to: o.to, category: o.category, merchant: o.merchant, method: o.method }; }
  totals(o: StatsOptions): Totals {
    const w = this.store.where(this.filter(o));
    const r = this.db.get(`SELECT COALESCE(SUM(CASE WHEN v.kind='expense' THEN v.amount END),0) expense, COALESCE(SUM(CASE WHEN v.kind='refund' THEN v.amount END),0) refund, COALESCE(SUM(v.kind='expense'),0) count, COALESCE(SUM(v.kind='refund'),0) refund_count FROM v_bills v WHERE ${w.sql}`, ...w.args)!;
    return { expense: Number(r.expense), refund: Number(r.refund), net: Number(r.expense) - Number(r.refund), count: Number(r.count), refund_count: Number(r.refund_count) };
  }
  private group(o: StatsOptions, col: string): Row[] {
    const w = this.store.where(this.filter(o));
    return this.db.all<any>(`SELECT ${col} k, SUM(v.spend) net, COALESCE(SUM(CASE WHEN v.kind='expense' THEN v.amount END),0) expense, COALESCE(SUM(CASE WHEN v.kind='refund' THEN v.amount END),0) refund, SUM(v.kind='expense') count FROM v_bills v WHERE ${w.sql} GROUP BY 1 ORDER BY net DESC, count DESC`, ...w.args).map((r) => ({ ...r, net: Number(r.net), expense: Number(r.expense), refund: Number(r.refund), count: Number(r.count) }));
  }
  byCategory(o: StatsOptions): Row[] {
    const cats = this.store.categories(), g = this.group(o, 'v.eff_category'), total = g.reduce((n, r) => n + r.net, 0);
    const tops = new Map<number | null, Row>();
    for (const r of g) {
      const c = cats.find((x) => x.id === r.k), top = c?.parent_id ?? c?.id ?? null, t = cats.find((x) => x.id === top);
      const p = tops.get(top) ?? tops.set(top, { id: top, name: t?.name ?? '未分类', icon: t?.icon ?? 'dots', net: 0, expense: 0, refund: 0, count: 0, children: [] }).get(top)!;
      for (const k of ['net', 'expense', 'refund', 'count']) p[k] += r[k];
      p.children.push({ id: r.k, name: c?.parent_id ? c.name : c ? `${c.name}（未细分）` : '未分类', direct: !c?.parent_id, net: r.net, expense: r.expense, refund: r.refund, count: r.count, share: pct(r.net, total) });
    }
    return [...tops.values()].map((p): Row => ({ ...p, share: pct(p.net, total) })).sort((a, b) => b.net - a.net);
  }
  byMerchant(o: StatsOptions, limit = 20): { total: number; rows: Row[] } {
    const g = this.group(o, 'v.eff_merchant');
    const total = g.reduce((n, r) => n + r.net, 0);
    return { total: g.length, rows: g.slice(0, limit).map((r) => ({ name: r.k as string, net: r.net, expense: r.expense, refund: r.refund, count: r.count, share: pct(r.net, total), average: r.count ? Math.round(r.expense / r.count) : 0 })) };
  }
  byMethod(o: StatsOptions): Row[] {
    const g: Row[] = this.group(o, 'v.eff_method'), total = g.reduce((n, r) => n + r.net, 0);
    return g.map((r) => ({ name: r.k as string, net: r.net, expense: r.expense, refund: r.refund, count: r.count, share: pct(r.net, total) }));
  }
  largest(o: StatsOptions, limit = 10): Row[] {
    const w = this.store.where({ ...this.filter(o), kind: 'expense' });
    return this.db.all(`SELECT v.*, v.amount - (SELECT COALESCE(SUM(r.amount),0) FROM bills r WHERE r.refund_of=v.id AND r.deleted_at IS NULL AND r.status='ok') net FROM v_bills v WHERE ${w.sql} ORDER BY v.amount DESC, v.id DESC LIMIT ?`, ...w.args, limit).map((r) => ({ id: r.id, day: r.day, merchant: r.merchant || r.item, item: r.item, amount: r.amount, net: Number(r.net), category: this.store.categoryName(r.category_id), method: r.method }));
  }
  /** 趋势：区间 ≤ 31 天按天，≤ 190 天按周，其余按月；空档补零。各格之和等于区间合计。 */
  trend(o: StatsOptions, unit?: 'day' | 'week' | 'month'): { unit: string; points: Row[] } {
    const days = diffDays(o.from, o.to) + 1, u = unit ?? (days <= 31 ? 'day' : days <= 100 ? 'week' : 'month');
    if (days / { day: 1, week: 7, month: 28 }[u] > 800) throw new UserError('区间太长，请换更粗的粒度');
    const col = (o.basis ?? this.store.basis) === 'original' ? 'v.orig_day' : 'v.day';
    const map = new Map(this.group(o, col).map((r) => [r.k as string, r]));
    const pts: Row[] = [];
    for (let d = o.from; d <= o.to; ) {
      const p = periodOf(u, d), to = p.to < o.to ? p.to : o.to;
      const x = { from: d, to, net: 0, expense: 0, refund: 0, count: 0 };
      for (let k = d; k <= to; k = addDays(k, 1)) { const r = map.get(k); if (r) { x.net += r.net; x.expense += r.expense; x.refund += r.refund; x.count += r.count; } }
      pts.push(x); d = addDays(to, 1);
    }
    return { unit: u, points: pts };
  }
  /** 没计入消费的部分，给用户看清楚 */
  excluded(o: StatsOptions): Row {
    const one = (where: string) => { const r = this.db.get(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM bills WHERE deleted_at IS NULL AND day BETWEEN ? AND ? AND ${where}`, o.from, o.to)!; return { count: Number(r.n), amount: Number(r.s) }; };
    return {
      pending: one(`status='pending' AND currency='CNY' AND kind IN ('expense','refund')`), pending_unknown: one(`status='pending' AND amount IS NULL`).count,
      dup: one(`status='dup'`), batch: one(`status='batch'`).count,
      income: one(`status='ok' AND kind='income' AND currency='CNY'`), transfer: one(`status='ok' AND kind='transfer' AND currency='CNY'`), repay: one(`status='ok' AND kind='repay' AND currency='CNY'`),
      foreign: this.db.all(`SELECT currency, COUNT(*) count, SUM(CASE kind WHEN 'refund' THEN -amount ELSE amount END) amount FROM bills WHERE deleted_at IS NULL AND status='ok' AND currency<>'CNY' AND kind IN ('expense','refund') AND day BETWEEN ? AND ? GROUP BY currency ORDER BY currency`, o.from, o.to).map((r) => ({ currency: r.currency, count: Number(r.count), amount: Number(r.amount) })),
    };
  }
  /** 本期里冲减往期支出的退款 / 本期支出后来在期外退掉的部分 */
  crossRefund(o: StatsOptions): Row {
    const q = (sql: string) => { const r = this.db.get(`SELECT COUNT(*) n, COALESCE(SUM(v.amount),0) s FROM v_bills v WHERE v.deleted_at IS NULL AND v.status='ok' AND v.kind='refund' AND v.currency='CNY' AND v.refund_of IS NOT NULL AND ${sql}`, o.from, o.to, o.from, o.to)!; return { count: Number(r.n), amount: Number(r.s) }; };
    return { received_for_earlier: q('v.day BETWEEN ? AND ? AND NOT (v.orig_day BETWEEN ? AND ?)'), refunded_later: q('v.orig_day BETWEEN ? AND ? AND NOT (v.day BETWEEN ? AND ?)') };
  }
  budget(month: string, today: string): Row[] {
    const r = periodOf('month', month), p = { ...r }, days = diffDays(r.from, r.to) + 1, gone = today < r.from ? 0 : today > r.to ? days : diffDays(r.from, today) + 1;
    return this.store.budgets().map((b) => {
      const used = this.totals({ ...p, category: b.category_id || undefined }).net;
      return { category_id: b.category_id, name: b.name, amount: b.amount, used, left: b.amount - used, percent: pct(used, b.amount), elapsed: pct(gone, days), state: used > b.amount ? 'over' : used * 10 >= b.amount * 8 ? 'near' : 'ok', month: r.from.slice(0, 7) };
    });
  }
  /** 一个区间的完整报表 */
  report(o: StatsOptions, today = ymd(this.store.now())): Row {
    check(o);
    const t = this.totals(o), running = o.from <= today && today <= o.to;
    const days = diffDays(o.from, o.to) + 1, elapsed = o.from > today ? 0 : running ? diffDays(o.from, today) + 1 : days;
    const c = compareRanges(o), strip = (r: Range): StatsOptions => ({ ...o, ...r });
    const cmp = (r: Range) => {
      const full = this.totals(strip(r)).net;
      // 本期还没过完：同时给「同进度」，免得拿半个月比一整个月
      const cut = running ? addDays(r.from, elapsed - 1) : r.to, same: Range = { from: r.from, to: cut < r.to ? cut : r.to };
      const base = running ? this.totals(strip(same)).net : full;
      return { range: r, label: label(r), net: full, same_range: same, same_net: base, diff: t.net - base, percent: base === 0 ? null : Math.round(((t.net - base) / Math.abs(base)) * 1000) / 10 };
    };
    return {
      range: { from: o.from, to: o.to }, unit: unitOf(o) ?? 'custom', label: label(o), running, days, elapsed,
      ...t, daily: elapsed ? Math.round(t.net / elapsed) : 0,
      by_category: this.byCategory(o), by_merchant: this.byMerchant(o), by_method: this.byMethod(o), largest: this.largest(o), trend: this.trend(o),
      prev: cmp(c.prev), yoy: cmp(c.yoy), excluded: this.excluded(o), cross_refund: this.crossRefund(o),
      basis: o.basis ?? this.store.basis, include_pending: !!o.includePending,
    };
  }
}
export function check(o: Range): void {
  if (!validDay(o.from) || !validDay(o.to)) throw new UserError('日期格式应为 YYYY-MM-DD');
  if (o.from > o.to) throw new UserError('开始日期不能晚于结束日期');
  if (diffDays(o.from, o.to) > 3700) throw new UserError('区间最长 10 年');
}
/** 统计口径说明，网页、QQ、MCP 共用一份文字 */
export const RULES = (basis: Basis): string[] => [
  '消费 = 支出 − 退款。收入、转账、还信用卡不算消费。',
  '只统计「已入账」的人民币账目。待确认、疑似重复、未入账的列表不计入，单独列出。外币单列，不与人民币相加。',
  basis === 'original' ? '退款：关联了原支出的，冲减原消费那天（往期数字会因后来的退款变小）；没关联的，冲减退款到账那天。' : '退款：一律冲减退款到账那天（往期数字不变）。分类和商户跟随原支出。',
  '按 Asia/Shanghai 划分日期，周一到周日为一周。金额按整数分计算。日均 = 净消费 ÷ 已过天数。',
];
export { addMonths, monday };
export type { Unit };
