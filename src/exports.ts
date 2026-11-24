import { yuan } from './money.js';
import { KIND, SOURCE, STATUS, type Filter, type Store } from './store.js';
import { fmtTime } from './time.js';

/** 防 CSV 注入：以公式字符开头的内容前加单引号（纯数字金额除外）。 */
export const cell = (v: unknown): string => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  // 长单号避免被表格软件变成科学计数
  if (/^\d{12,}$/.test(s)) s = `\t${s}`;
  return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(store: Store, f: Filter): string {
  const head = ['编号', '日期时间', '类型', '状态', '金额', '币种', '计入消费', '商户', '说明', '一级分类', '二级分类', '支付方式', '交易单号', '原支出编号', '已退款', '备注', '来源', '记录时间'];
  const rows = store.list({ ...f, page: 1, pageSize: 100_000 }).items.map((b) => {
    const [a, c] = b.category_id === null ? ['', ''] : b.category.split('/');
    return [b.id, fmtTime(b.occurred_at), KIND[b.kind as keyof typeof KIND], STATUS[b.status], b.amount === null ? '' : yuan(b.amount), b.currency, b.status === 'ok' && b.currency === 'CNY' ? yuan(b.spend) : '0.00', b.merchant, b.item, a, c ?? '', b.method, b.trade_no, b.refund_of ?? '', b.refunded ? yuan(b.refunded) : '', b.note, SOURCE[b.source] ?? b.source, fmtTime(b.created_at)];
  });
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
export function toJson(store: Store, f: Filter): string {
  const r = store.list({ ...f, page: 1, pageSize: 100_000 });
  return JSON.stringify({ exported_at: fmtTime(Date.now()), timezone: 'Asia/Shanghai', amount_unit: 'fen', total: r.total, sum: r.sum, bills: r.items.map(({ thumb: _t, author: _a, capture: _c, ...b }) => ({ ...b, occurred: fmtTime(b.occurred_at), kind_name: KIND[b.kind as keyof typeof KIND], status_name: STATUS[b.status] })) }, null, 2);
}
