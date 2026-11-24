import { toCents } from './money.js';
import { UserError } from './store.js';
import { at, validDay } from './time.js';

export const patchOf = (b: any): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'amount') {
        const c = typeof v === 'string' ? toCents(v) : null;
        if (c === null) throw new UserError('金额格式不对，应为数字，最多两位小数');
        p.amount = c;
      }
      else if (k === 'occurred') { const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d):(\d\d)$/.exec(String(v)); if (!m || !validDay(m[1]!) || +m[2]! > 23 || +m[3]! > 59) throw new UserError('时间格式不对'); p.occurred_at = at(+m[1]!.slice(0, 4), +m[1]!.slice(5, 7), +m[1]!.slice(8), +m[2]!, +m[3]!); }
      else if (k === 'category_id' || k === 'refund_of') p[k] = v === null || v === '' ? null : Number(v);
      else if (['kind', 'merchant', 'item', 'note', 'method', 'currency', 'trade_no', 'status'].includes(k)) p[k] = v;
      else if (k === 'confirmed') p[k] = Boolean(v);
      else throw new UserError(`不支持的字段：${k}`);
    }
    return p;
  };
