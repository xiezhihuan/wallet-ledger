import type { Row } from '../db.js';
import { toCents } from '../money.js';
import { maskCard, type Kind } from '../parse/receipt.js';
import { UserError, type Store } from '../store.js';
import { at, fmtTime, ymd } from '../time.js';
import { similarName } from '../text.js';
import { readXlsx } from './zip.js';

export interface ImportRow {
  n: number; time: number; kind: Kind; direction: string; amount: number; merchant: string; item: string; method: string; trade_no: string; mch_no: string; note: string; status_text: string; type_text: string;
  action: 'new' | 'exists' | 'maybe' | 'skip'; why: string; match?: number;
}

/** RFC4180 CSV；容忍不规范引号。 */
export function parseCsv(s: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  const t = s.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur.trim() === '') { q = true; cur = ''; }
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); out.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}
function decode(buf: Buffer): string {
  for (const enc of ['utf-8', 'gb18030']) try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { /* 换下一种 */ }
  throw new UserError('文件编码无法识别，请使用平台导出的原始文件（不要用 Excel 另存）');
}
const clean = (s: string | undefined) => (s ?? '').replace(/[\t ]/g, ' ').trim();
const val = (s: string | undefined) => { const v = clean(s); return v === '/' ? '' : v; };
function time(s: string): number | null {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  return m ? at(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0)) : null;
}

/** 读出原始行。按表头的列名取列，不依赖「第几行开始」，平台调整说明行数也不怕。 */
export function readBillFile(buf: Buffer, filename: string): { platform: 'wechat' | 'alipay'; rows: ImportRow[] } {
  const zip = buf.subarray(0, 2).toString('latin1') === 'PK';
  if (zip && !/\.xlsx$/i.test(filename) && /\.zip$/i.test(filename)) throw new UserError('请先用平台给的解压密码解压，再导入里面的 xlsx / csv 文件');
  if (buf.subarray(0, 4).toString('hex') === 'd0cf11e0') throw new UserError('不支持旧版 xls，请使用平台导出的 xlsx 或 csv');
  const table = zip ? readXlsx(buf) : parseCsv(decode(buf));
  const hi = table.findIndex((r) => { const c = r.map(clean); return c.includes('交易时间') && c.some((x) => /^金额/.test(x)) && c.includes('收/支'); });
  if (hi < 0) throw new UserError('没有找到「交易时间 / 收/支 / 金额」表头。目前支持微信支付与支付宝 App 导出的个人账单');
  const head = table[hi]!.map(clean), col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const C = { time: col('交易时间'), type: col('交易类型', '交易分类'), peer: col('交易对方'), item: col('商品', '商品说明'), io: col('收/支'), amt: head.findIndex((h) => /^金额/.test(h)), method: col('支付方式', '收/付款方式'), state: col('当前状态', '交易状态'), no: col('交易单号', '交易订单号', '交易号'), mch: col('商户单号', '商家订单号'), note: col('备注') };
  const platform = col('交易类型') >= 0 && col('当前状态') >= 0 ? 'wechat' : 'alipay';
  const rows: ImportRow[] = [];
  table.slice(hi + 1).forEach((r, i) => {
    if (r.every((x) => !clean(x))) return;
    const g = (k: keyof typeof C) => (C[k] < 0 ? '' : val(r[C[k]]));
    const t = time(g('time')), a = toCents(g('amt').replace(/[¥￥\s]/g, '').replace(/元$/, ''));
    if (t === null && !g('io')) return; // 尾部说明行
    const base: ImportRow = { n: hi + 2 + i, time: t ?? 0, kind: 'expense', direction: 'out', amount: a === null ? 0 : Math.abs(a), merchant: g('peer').slice(0, 100), item: g('item').slice(0, 120), method: maskCard(g('method').split('&')[0]!).slice(0, 40), trade_no: g('no').replace(/\s/g, ''), mch_no: g('mch').replace(/\s/g, ''), note: g('note').slice(0, 500), status_text: g('state'), type_text: g('type'), action: 'new', why: '' };
    const io = g('io'), ty = base.type_text, st = base.status_text, all = `${ty} ${base.item} ${base.merchant}`;
    const skip = (why: string) => { base.action = 'skip'; base.why = why; };
    if (t === null || a === null) skip('时间或金额无法识别');
    else if (platform === 'wechat') {
      if (/退款$/.test(ty) || ty === '退款') { base.kind = 'refund'; base.direction = 'in'; base.merchant ||= ty.replace(/-?退款$/, ''); }
      else if (/信用卡还款/.test(ty)) base.kind = 'repay';
      else if (io === '支出') { if (/^转账/.test(ty)) base.kind = 'transfer'; }
      else if (io === '收入') { base.kind = /^转账/.test(ty) ? 'transfer' : 'income'; base.direction = 'in'; }
      else { base.kind = 'transfer'; base.direction = /转出|提现/.test(ty) ? 'out' : /充值|转入/.test(ty) ? 'in' : 'out'; }
      if (/已退还|对方已退还|已关闭|支付失败|等待/.test(st)) skip(`状态「${st}」`);
    } else {
      if (/退款/.test(st) || ty === '退款') { base.kind = 'refund'; base.direction = 'in'; base.item = base.item.replace(/^退款[-—]/, ''); }
      else if (/还款/.test(all) && /信用|花呗|借呗|还款/.test(all) && io !== '收入') base.kind = 'repay';
      else if (io === '支出') { if (/^转账/.test(ty) || /^转账/.test(base.item)) base.kind = 'transfer'; }
      else if (io === '收入') { base.kind = /转账/.test(ty) ? 'transfer' : 'income'; base.direction = 'in'; }
      else { base.kind = 'transfer'; base.direction = /转入|充值|收益/.test(all) ? 'in' : 'out'; if (/收益|利息/.test(base.item)) base.kind = 'income'; }
      if (/等待付款|失败|解冻|冻结/.test(st)) skip(`状态「${st}」`);
      else if (/交易关闭|已关闭/.test(st) && io !== '支出') skip(`状态「${st}」`);
    }
    if (base.action === 'new' && base.amount === 0) skip('金额为 0');
    if (base.kind === 'refund' || base.kind === 'transfer' && !base.direction) base.direction = 'in';
    rows.push(base);
  });
  // 支付宝「交易关闭」的支出：有对应退款行才说明真的付过钱
  if (platform === 'alipay') for (const r of rows) if (r.action === 'new' && r.kind === 'expense' && /交易关闭|已关闭/.test(r.status_text) && !rows.some((x) => x.kind === 'refund' && r.trade_no && x.trade_no.startsWith(r.trade_no))) { r.action = 'skip'; r.why = '交易已关闭且没有退款记录，应是没有付款'; }
  if (!rows.length) throw new UserError('文件里没有交易记录');
  return { platform, rows };
}

/** 与已有账目比对：单号相同 = 已存在；金额相同且时间商户相近 = 疑似，由用户决定。 */
export function markExisting(store: Store, rows: ImportRow[]): void {
  const taken = new Set<number>(), seen = new Set<string>();
  for (const r of rows) {
    if (r.action === 'skip') continue;
    const key = `${r.trade_no}|${r.kind}|${r.amount}`;
    if (r.trade_no && seen.has(key)) { r.action = 'skip'; r.why = '文件内重复行'; continue; }
    seen.add(key);
    const ids = [r.trade_no, r.mch_no].filter((x) => x.length >= 8);
    const byId = ids.length ? store.db.get(`SELECT DISTINCT b.id, b.amount FROM bills b, json_each(b.ids) j WHERE b.deleted_at IS NULL AND b.kind=? AND b.status<>'batch_done' AND (b.amount=? OR b.amount IS NULL) AND json_extract(j.value,'$.no') IN (${ids.map(() => '?').join()}) LIMIT 1`, r.kind, r.amount, ...ids) : undefined;
    if (byId) { r.action = 'exists'; r.match = byId.id; r.why = `单号与 #${byId.id} 相同`; taken.add(byId.id); }
  }
  for (const r of rows) {
    if (r.action !== 'new') continue;
    const cand = store.db.all(`SELECT * FROM bills WHERE deleted_at IS NULL AND kind=? AND currency='CNY' AND amount=? AND status IN ('ok','pending','dup') AND day BETWEEN ? AND ? ORDER BY ABS(occurred_at-?)`, r.kind, r.amount, ymd(r.time - 86400_000), ymd(r.time + 86400_000), r.time)
      .find((b) => {
        if (taken.has(b.id)) return false;
        const has = (JSON.parse(b.ids) as { type: string; no: string }[]).some((i) => i.type === 'trade' && i.no.length >= 8);
        const gap = Math.abs(b.occurred_at - r.time), name = b.merchant || b.item;
        // 都有交易单号又不同，只有时间几乎一致才可能是同一笔
        if (has && r.trade_no && gap > 120_000) return false;
        const near = b.time_src === 'day' ? b.day === ymd(r.time) : gap <= (b.time_src === 'sent' ? 120 : 10) * 60_000;
        return near && (!b.merchant || !r.merchant || similarName(name, r.merchant) || similarName(name, r.item) || gap <= 120_000);
      });
    if (cand) { r.action = 'maybe'; r.match = cand.id; r.why = `与 #${cand.id} 金额相同、时间相近`; taken.add(cand.id); }
  }
}

export class Importer {
  constructor(private store: Store) {}
  preview(buf: Buffer, filename: string): Row {
    const { platform, rows } = readBillFile(buf, filename);
    markExisting(this.store, rows);
    const id = this.store.db.run('INSERT INTO imports(platform,filename,rows,created_at) VALUES(?,?,?,?)', platform, filename.slice(0, 200), JSON.stringify(rows), this.store.now()).id;
    return this.get(id);
  }
  get(id: number): Row {
    const r = this.store.db.get('SELECT * FROM imports WHERE id=?', id);
    if (!r) throw new UserError('导入记录不存在', 404);
    const rows = JSON.parse(r.rows) as ImportRow[], count = (a: string) => rows.filter((x) => x.action === a).length;
    return { id, platform: r.platform, filename: r.filename, status: r.status, created_at: r.created_at, committed_at: r.committed_at, counts: { new: count('new'), exists: count('exists'), maybe: count('maybe'), skip: count('skip') }, rows };
  }
  /** 确认入账。decide：疑似行的处理——行号 → add（另记一笔）/ link（把单号等补到已有账）/ skip（默认，不入）。pick 只入这些「新」行，不给则全部。 */
  commit(id: number, o: { pick?: number[]; decide?: Record<string, string> }, actor: string): Row {
    const imp = this.get(id);
    if (imp.status !== 'preview') throw new UserError('这次导入已经处理过了');
    return this.store.db.tx(() => {
      const rows = imp.rows as ImportRow[];
      // 预览之后可能又记了新账，重新比对一次
      const before = new Map(rows.map((r) => [r.n, r.action]));
      for (const r of rows) if (r.action === 'new' || r.action === 'maybe' || r.action === 'exists') { r.action = 'new'; r.why = ''; delete r.match; }
      markExisting(this.store, rows);
      const made: { id: number; row: ImportRow }[] = [];
      let linked = 0, changed = 0;
      for (const r of rows) {
        if (before.get(r.n) === 'new' && r.action !== 'new') { changed++; continue; }
        const d = o.decide?.[String(r.n)] ?? 'skip';
        if (r.action === 'maybe' && d === 'link' && r.match) {
          const b = this.store.require(r.match), ids = JSON.parse(b.ids) as { type: string; no: string }[];
          for (const [type, no] of [['trade', r.trade_no], ['mch', r.mch_no]] as const) if (no && !ids.some((i) => i.no === no)) ids.push({ type, no });
          // 只补空白字段，不改用户已有的内容
          this.store.db.run(`UPDATE bills SET ids=?, trade_no=CASE WHEN trade_no='' THEN ? ELSE trade_no END, merchant=CASE WHEN merchant='' THEN ? ELSE merchant END, method=CASE WHEN method='' THEN ? ELSE method END, locked=? WHERE id=?`, JSON.stringify(ids), r.trade_no, r.merchant, r.method, JSON.stringify([...new Set([...JSON.parse(b.locked), 'trade_no', 'merchant', 'method'])]), b.id);
          this.store.event(b.id, actor, '与导入账单对上', `${imp.platform === 'wechat' ? '微信' : '支付宝'} ${fmtTime(r.time)}`);
          linked++; continue;
        }
        const add = r.action === 'new' ? !o.pick || o.pick.includes(r.n) : r.action === 'maybe' && d === 'add';
        if (!add) continue;
        const nid = this.store.createBill({ author: actor, source: 'import', at: r.time, importId: id });
        this.store.db.run(`UPDATE bills SET kind=?,direction=?,amount=?,merchant=?,item=?,method=?,trade_no=?,ids=?,note=?,time_src='voucher',flags='[]',dup_ok=? WHERE id=?`, r.kind, r.direction, r.amount, r.merchant, r.item, r.method, r.trade_no, JSON.stringify([{ type: 'trade', no: r.trade_no }, { type: 'mch', no: r.mch_no }].filter((x) => x.no)), r.note, JSON.stringify(r.match ? [r.match] : []), nid);
        made.push({ id: nid, row: r });
      }
      // 先入支出再处理退款关联
      for (const m of made.filter((x) => x.row.kind !== 'refund')) this.store.refresh(m.id);
      for (const m of made.filter((x) => x.row.kind === 'refund')) { this.linkRefund(m.id, m.row); this.store.refresh(m.id); }
      this.store.db.run(`UPDATE imports SET status='done', committed_at=?, rows=? WHERE id=?`, this.store.now(), JSON.stringify(rows), id);
      return { created: made.length, linked, skipped: rows.length - made.length - linked, changed, bills: made.map((m) => m.id) };
    });
  }
  /** 退款行找原支出：支付宝退款单号以原单号开头；微信退款与原单共用单号；都没有时不猜。 */
  private linkRefund(id: number, r: ImportRow): void {
    const cands = this.store.db.all(`SELECT id,ids FROM bills WHERE kind='expense' AND deleted_at IS NULL AND status IN ('ok','pending') AND amount>=? AND occurred_at<=?`, r.amount, r.time + 60_000);
    const hit = cands.find((b) => (JSON.parse(b.ids) as { no: string }[]).some((i) => i.no.length >= 8 && (r.trade_no.startsWith(i.no) || (!!r.mch_no && i.no === r.mch_no))));
    if (hit && this.store.refundable(hit.id, id) >= r.amount) { this.store.db.run('UPDATE bills SET refund_of=? WHERE id=?', hit.id, id); this.store.event(id, '系统', '关联原支出', `单号对应 → #${hit.id}`); }
  }
  discard(id: number): void { this.get(id); this.store.db.run(`UPDATE imports SET status='discarded' WHERE id=? AND status='preview'`, id); }
}
