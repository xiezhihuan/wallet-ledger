import crypto from 'node:crypto';
import type { Db, Row } from './db.js';
import { money } from './money.js';
import type { OcrDoc } from './ocr.js';
import { isPlatformMerchant, parseReceipt, type Flag, type Kind, type ListRow, type Receipt } from './parse/receipt.js';
import { parseText, type TextEntry } from './parse/text.js';
import { clip, likeEscape, normName, similarName } from './text.js';
import { fmtTime, validDay, ymd } from './time.js';

export const KIND: Record<Kind, string> = { expense: '支出', income: '收入', refund: '退款', transfer: '转账', repay: '还款' };
export const STATUS: Record<string, string> = { ok: '已入账', pending: '待确认', dup: '疑似重复', batch: '列表待确认', batch_done: '列表已处理' };
export const SOURCE: Record<string, string> = { qq: 'QQ', web: '网页', import: '导入', list: '账单列表' };
const FIELD: Record<string, string> = { amount: '金额', currency: '币种', kind: '类型', merchant: '商户', item: '说明', note: '备注', occurred_at: '时间', category_id: '分类', method: '支付方式', refund_of: '原支出', trade_no: '交易单号', ids: '交易标识', direction: '方向', status: '待确认状态', confirmed: '确认状态' };

export class UserError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export interface UpdateOptions {
  source?: string;
  reason?: string;
  expectedVersion?: number;
  authorizationId?: number | null;
}
export interface NewAttachment { kind: 'image' | 'voice' | 'video' | 'file'; filename?: string; mime?: string; size?: number; url?: string; text?: string; path?: string; sha256?: string }
export interface NewMessage { channel: 'qq' | 'web'; dedupeKey?: string; author: string; text: string; raw?: unknown; sentAt: number; attachments: NewAttachment[] }
export interface BatchRow extends ListRow { dup: { id: number; why: string } | null; done?: number; ignored?: boolean }
export interface Filter {
  q?: string; kind?: string; status?: string; category?: number | 'none'; merchant?: string; method?: string; currency?: string; source?: string;
  from?: string; to?: string; min?: number; max?: number; image?: boolean; deleted?: boolean; soft?: boolean;
  /** 只看计入消费统计的（支出与退款、人民币、已入账），日期按统计归属日 */
  counted?: boolean; withPending?: boolean; basis?: Basis; importId?: number; refundOf?: number;
  sort?: string; page?: number; pageSize?: number;
}
/** 退款归属：原消费日 / 退款到账日 */
export type Basis = 'original' | 'refund';
interface Ev { id: number; message_id: number; attachment_id: number | null; text: string; parsed: TextParsed | Receipt | null; bill_id: number | null; pinned: number; sent_at: number; author: string; sha256: string | null; att_kind: string | null; ocr_status: string | null; att_status: string | null }
interface TextParsed extends Receipt { bare?: boolean; override?: boolean }
type Rel = 'same' | 'diff' | 'unknown';

const MIN = 60_000;

/** 两份凭证是不是同一笔。宁可拆开提示，也不静默并错。 */
export function relate(a: Receipt, b: Receipt, o: { sameMsg?: boolean; sameFile?: boolean } = {}): Rel {
  // A platform retry is filtered by message ID before this step. A fresh upload
  // of the same bytes is a separate candidate for the user's duplicate decision.
  if (o.sameFile) return 'diff';
  const tradeA = a.ids.filter(i => i.type === 'trade'), tradeB = b.ids.filter(i => i.type === 'trade');
  if (tradeA.length && tradeB.length && !tradeA.some(x => tradeB.some(y => x.no === y.no))) return 'diff';
  const differentShop = a.doc !== 'text' && b.doc !== 'text' && a.merchant && b.merchant &&
    !similarName(a.merchant, b.merchant) && !isPlatformMerchant(a.merchant) && !isPlatformMerchant(b.merchant);
  if (differentShop) return 'diff';
  const share = a.ids.some((x) => b.ids.some((y) => x.no === y.no));
  if (share && a.doc === b.doc && a.precise && b.precise && a.amount !== null && b.amount !== null) return 'diff';
  if (share) return a.kind === b.kind && (a.amount === null || b.amount === null || a.amount === b.amount || !a.sure || !b.sure) ? 'same' : 'diff';
  const text = a.doc === 'text' || b.doc === 'text';
  if (a.amount === null || b.amount === null) return 'unknown';
  if (a.currency !== b.currency) return o.sameMsg && text ? 'same' : 'diff';
  if (a.amount !== b.amount) return o.sameMsg && text ? 'same' : 'diff';
  if (a.doc === 'text' && b.doc === 'text') return 'diff'; // 两句都带金额的话就是两笔
  if (a.kind !== b.kind && !text) return 'diff';
  const gap = a.ms !== null && b.ms !== null ? Math.abs(a.ms - b.ms) : null, precise = a.precise && b.precise;
  if (text) return gap !== null && (precise ? gap > 6 * 60 * MIN : gap > 36 * 60 * MIN) ? 'diff' : 'same';
  if (a.platform && a.platform === b.platform && a.doc === b.doc) for (const t of ['trade', 'order'] as const) {
    const x = a.ids.filter((i) => i.type === t), y = b.ids.filter((i) => i.type === t);
    if (x.length && y.length) return 'diff';
  }
  if (gap !== null) {
    const lim = !precise ? 36 * 60 * MIN : a.doc === b.doc ? 2 * MIN : a.doc === 'sms' || b.doc === 'sms' ? 30 * MIN : 180 * MIN;
    if (gap > lim) return 'diff';
  }
  // Two independent vouchers with the same identifying fields may also be a resend.
  if (a.doc === 'voucher' && b.doc === 'voucher' && a.precise && b.precise && gap !== null && gap <= 2 * MIN) return 'diff';
  return 'same';
}

export class Store {
  /** 自上次取走后有变化的账，按素材组归集，用于回执 */
  private dirty = new Map<string, Set<number>>();
  constructor(readonly db: Db, readonly now: () => number = Date.now) {}

  // ───────── 设置 ─────────
  setting(key: string, def = ''): string { return this.db.kvGet(`set:${key}`) ?? def; }
  saveSetting(key: string, v: string): void { this.db.kvSet(`set:${key}`, v); }
  get basis(): Basis { return this.setting('refund_basis', 'original') === 'refund' ? 'refund' : 'original'; }

  // ───────── 素材 ─────────
  seen(key: string): boolean { return !!this.db.get('SELECT 1 FROM messages WHERE dedupe_key=?', key); }
  /** 记录已处理的指令，重连补发时不会重复执行。 */
  markCommand(key: string, author: string, text: string, sentAt: number): void {
    this.db.run(`INSERT OR IGNORE INTO messages(channel,dedupe_key,author,kind,text,sent_at,created_at) VALUES('qq',?,?,'command',?,?,?)`, key, author, text, sentAt, this.now());
  }

  /**
   * 收一条消息并把每份素材归到某一笔账。
   * @param target 明确指定的账；'new' 强制新建；undefined 归到 cur（合并窗口内的当前账）或按内容拆开
   */
  addMessage(m: NewMessage, capture: string, cur: number | null, target?: number | 'new'): { messageId: number; bill: number; hints: string[] } {
    return this.db.tx(() => {
      const { id: messageId } = this.db.run('INSERT INTO messages(channel,dedupe_key,author,kind,text,raw,capture,sent_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        m.channel, m.dedupeKey ?? null, m.author, 'entry', m.text, m.raw === undefined ? null : JSON.stringify(m.raw), capture, m.sentAt, this.now());
      const evs: number[] = [];
      const addEv = (att: number | null, text: string, parsed: unknown) => evs.push(this.db.run('INSERT INTO evidence(message_id,attachment_id,text,parsed,sent_at,author) VALUES(?,?,?,?,?,?)', messageId, att, text, parsed ? JSON.stringify(parsed) : null, m.sentAt, m.author).id);
      for (const a of m.attachments) {
        const id = this.db.run(`INSERT INTO attachments(message_id,kind,filename,mime,size,url,path,sha256,status,ocr_status,text,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          messageId, a.kind, clip(a.filename ?? '', 200), a.mime ?? '', a.size ?? 0, a.url ?? null, a.path ?? null, a.sha256 ?? null,
          a.path ? 'done' : a.url ? 'pending' : 'failed', a.kind === 'image' ? 'pending' : 'none', a.text ?? '', a.path || a.url ? null : '平台未提供下载地址').id;
        addEv(id, '', null);
        if (a.kind === 'voice' && a.text) for (const e of parseText(a.text, m.sentAt, true)) addEv(null, e.text, this.packText(e));
      }
      if (m.text) for (const e of parseText(m.text, m.sentAt)) addEv(null, e.text, this.packText(e));
      const hints: string[] = [];
      let bill = typeof target === 'number' ? target : target === 'new' ? null : cur;
      // 先放截图再放文字：同一条消息里的文字是对截图的说明
      for (const id of evs) bill = this.place(id, bill, capture, typeof target === 'number', m, hints);
      bill ??= this.createBill({ capture, author: m.author, source: m.channel, at: m.sentAt });
      this.refresh(bill);
      // 截图没有下载地址，直接按失败处理，不会一直「识别中」
      for (const e of this.evidence(bill)) if (e.att_kind === 'image' && e.att_status === 'failed' && !e.parsed) this.evaluate(e.attachment_id!, null);
      return { messageId, bill, hints };
    });
  }
  private packText(e: TextEntry): TextParsed { return { ...e.receipt, bare: e.bare, override: e.override }; }

  private evidence(bill: number): Ev[] {
    return this.db.all<any>(`SELECT e.*, a.sha256, a.kind att_kind, a.ocr_status, a.status att_status FROM evidence e LEFT JOIN attachments a ON a.id=e.attachment_id WHERE e.bill_id=? ORDER BY e.sent_at, e.id`, bill)
      .map((e) => ({ ...e, parsed: e.parsed ? JSON.parse(e.parsed) : null }));
  }
  private ev(id: number): Ev {
    const e = this.db.get<any>(`SELECT e.*, a.sha256, a.kind att_kind, a.ocr_status, a.status att_status FROM evidence e LEFT JOIN attachments a ON a.id=e.attachment_id WHERE e.id=?`, id);
    if (!e) throw new UserError('素材不存在', 404);
    return { ...e, parsed: e.parsed ? JSON.parse(e.parsed) : null };
  }
  private setBill(ev: number, bill: number | null, pinned?: boolean): void {
    if (pinned === undefined) this.db.run('UPDATE evidence SET bill_id=? WHERE id=?', bill, ev);
    else this.db.run('UPDATE evidence SET bill_id=?, pinned=? WHERE id=?', bill, pinned ? 1 : 0, ev);
  }
  private waiting(bill: number): boolean { return this.evidence(bill).some((e) => e.att_kind === 'image' && !e.parsed); }

  private place(evId: number, cur: number | null, capture: string, pinned: boolean, m: NewMessage, hints: string[]): number {
    const e = this.ev(evId), p = e.parsed as TextParsed | null;
    const fresh = () => this.createBill({ capture, author: m.author, source: m.channel, at: m.sentAt });
    if (pinned) { this.setBill(evId, cur!, true); this.refresh(cur!); return cur!; }
    if (cur === null) { const b = fresh(); this.setBill(evId, b); this.refresh(b); return b; }
    const b = this.require(cur);
    if (!p || p.amount === null) { // 未识别的图、无金额的文字
      // 账单列表、疑似重复：后面的截图另起，不混进去
      if (!p && e.att_kind === 'image' && b.status === 'batch') { const n = fresh(); this.setBill(evId, n); this.refresh(n); return n; }
      this.setBill(evId, cur); this.refresh(cur); return cur;
    }
    if (p.bare) {
      const locked = JSON.parse(b.locked).includes('amount');
      if (this.waiting(cur) || (!locked && (b.amount === null || this.hardAmount(b)))) { this.setBill(evId, cur); this.refresh(cur); return cur; }
      if (b.amount !== p.amount) {
        hints.push(`#${cur} 已是 ${money(b.amount, b.currency)}，没有改成 ${money(p.amount)}。要改发「改 ${(p.amount / 100).toString()}」；另记一笔发「新建 说明 金额」`);
        p.note = e.text; p.amount = null; p.sure = false;
        this.db.run('UPDATE evidence SET parsed=? WHERE id=?', JSON.stringify(p), evId);
      }
      this.setBill(evId, cur); this.refresh(cur); return cur;
    }
    const rel = this.relBill(e, cur);
    if (rel === 'same' || (rel === 'unknown' && b.status !== 'batch')) { this.setBill(evId, cur); this.refresh(cur); return cur; }
    const other = this.findSame(e, capture, cur);
    const to = other ?? fresh();
    this.setBill(evId, to); this.refresh(to);
    return to;
  }
  private hardAmount(b: Row): boolean { return (JSON.parse(b.flags) as Flag[]).some((f) => f.field === 'amount' && f.hard); }

  /** 素材与一笔账（除自己以外的素材）的关系 */
  private relBill(e: Ev, bill: number): Rel {
    if (!e.parsed) return 'unknown';
    const others = this.evidence(bill).filter((x) => x.id !== e.id && x.parsed);
    let rel: Rel = 'unknown';
    for (const x of others) {
      const r = relate(e.parsed, x.parsed as Receipt, { sameMsg: x.message_id === e.message_id, sameFile: !!e.sha256 && e.sha256 === x.sha256 });
      if (r === 'diff') return 'diff';
      if (r === 'same') rel = 'same';
    }
    return rel;
  }
  private findSame(e: Ev, capture: string, except: number): number | undefined {
    for (const b of this.db.all(`SELECT id FROM bills WHERE capture=? AND id<>? AND deleted_at IS NULL AND status NOT IN ('batch','batch_done') ORDER BY id DESC`, capture, except)) if (this.relBill(e, b.id) === 'same') return b.id;
    return undefined;
  }

  /** 图片识别完成（doc 为 null 表示没能识别）。返回受影响的账。 */
  evaluate(attachmentId: number, doc: OcrDoc | null): number[] {
    return this.db.tx(() => {
      const touched = new Set<number>();
      for (const { id } of this.db.all('SELECT id FROM evidence WHERE attachment_id=?', attachmentId)) {
        const e = this.ev(id);
        let r: Receipt;
        if (doc) r = parseReceipt(doc, e.sent_at);
        else { r = { doc: 'none', platform: '', kind: 'expense', direction: '', amount: null, sure: false, currency: 'CNY', merchant: '', merchantSure: false, item: '', ms: null, precise: false, method: '', ids: [], flags: [{ field: 'amount', hard: true, reason: '截图没能识别' }] }; }
        this.db.run('UPDATE evidence SET parsed=? WHERE id=?', JSON.stringify(r), id);
        if (!e.bill_id) continue;
        const capture = this.require(e.bill_id).capture as string;
        if (r.doc === 'list' && r.rows) { touched.add(this.toBatch(id, r.rows)); touched.add(e.bill_id); } else if (e.pinned) { this.refresh(e.bill_id); touched.add(e.bill_id); } else for (const b of this.recluster(e.bill_id, capture)) touched.add(b);
      }
      return [...touched].filter((b) => !this.require(b).deleted_at);
    });
  }

  /** 一笔账里混进了别的付款时拆开：先发的留下，后发的另立；后面紧跟的说明跟着走。 */
  private recluster(bill: number, capture: string): number[] {
    const out = new Set<number>([bill]);
    for (let guard = 0; guard < 50; guard++) {
      const evs = this.evidence(bill), kept: Ev[] = [];
      let moved = false;
      for (const e of evs) {
        const p = e.parsed as TextParsed | null;
        if (!p || p.amount === null || e.pinned || p.bare) { kept.push(e); continue; }
        const clash = kept.some((x) => x.parsed && (x.parsed as Receipt).amount !== null && !(x.parsed as TextParsed).bare && relate(p, x.parsed as Receipt, { sameMsg: x.message_id === e.message_id, sameFile: !!e.sha256 && e.sha256 === x.sha256 }) === 'diff');
        if (!clash) { kept.push(e); continue; }
        const b = this.require(bill);
        const to = this.findSame(e, capture, bill) ?? this.createBill({ capture, author: b.author, source: b.source, at: e.sent_at });
        this.setBill(e.id, to);
        // 之后紧跟的无金额说明（直到下一张图或下一句带金额的话）
        for (const x of evs.slice(evs.indexOf(e) + 1)) { const xp = x.parsed as TextParsed | null; if (x.att_kind === 'image' || (xp && xp.amount !== null) || x.pinned) break; this.setBill(x.id, to); }
        this.event(bill, '系统', '拆开', `一份凭证与本笔不是同一付款 → #${to}`);
        this.event(to, '系统', '拆开', `← #${bill}`);
        this.refresh(to); out.add(to); moved = true;
        break;
      }
      if (!moved) break;
    }
    this.refresh(bill);
    return [...out];
  }

  // ───────── 账单列表 ─────────
  private toBatch(evId: number, rows: ListRow[]): number {
    const e = this.ev(evId), b = this.require(e.bill_id!);
    const others = this.evidence(b.id).filter((x) => x.id !== evId && (x.attachment_id !== null || (x.parsed && (x.parsed as Receipt).amount !== null)));
    let id = b.id as number;
    if (others.length || b.status === 'batch') { id = this.createBill({ capture: b.capture, author: b.author, source: b.source, at: e.sent_at }); this.setBill(evId, id); this.refresh(b.id); }
    const list: BatchRow[] = rows.map((r) => ({ ...r, dup: this.rowDup(r) }));
    this.db.run(`UPDATE bills SET status='batch', batch=?, flags='[]', amount=NULL, dup_of=NULL WHERE id=?`, JSON.stringify(list), id);
    this.event(id, '系统', '识别为账单列表', `${rows.length} 笔`);
    this.refresh(id);
    return id;
  }
  private rowDup(r: ListRow): { id: number; why: string } | null {
    if (r.amount === null) return null;
    return this.findDup({ kind: r.kind, amount: r.amount, currency: r.currency ?? 'CNY', merchant: r.merchant, item: '', occurred_at: r.ms ?? 0, time_src: r.ms === null ? 'sent' : r.precise ? 'voucher' : 'day', ids: [], shas: [], day: r.ms === null ? '' : ymd(r.ms) }, 0, []);
  }
  /** 列表入账。pick 为 null 表示「全部」：跳过疑似重复与未成交的行。 */
  commitBatch(id: number, pick: number[] | null, actor: string): { created: number[]; skipped: { n: number; why: string }[] } {
    return this.db.tx(() => {
      const b = this.require(id);
      if (b.status !== 'batch') throw new UserError(`#${id} 不是待确认的账单列表`);
      const rows = JSON.parse(b.batch) as BatchRow[], created: number[] = [], skipped: { n: number; why: string }[] = [];
      for (const n of pick ?? rows.map((_r, i) => i + 1)) if (!rows[n - 1]) throw new UserError(`没有第 ${n} 行，共 ${rows.length} 行`);
      rows.forEach((r, i) => {
        if (pick && !pick.includes(i + 1)) return;
        if (r.done) { if (pick) skipped.push({ n: i + 1, why: `已入账 #${r.done}` }); return; }
        if (!pick) {
          r.dup = this.rowDup(r); // 可能刚记过
          if (r.dup) { skipped.push({ n: i + 1, why: `疑似与 #${r.dup.id} 重复` }); return; }
          if (r.skip) { skipped.push({ n: i + 1, why: '交易未成功' }); return; }
        }
        const flags: Flag[] = [...(r.sure && r.amount !== null ? [] : [{ field: 'amount' as const, hard: true, reason: '列表里这一行金额没把握', candidates: r.amount === null ? [] : [r.amount] }]), ...(r.note ? [{ field: 'kind' as const, hard: true, reason: r.note }] : [])];
        const nid = this.createBill({ capture: b.capture, author: b.author, source: 'list', at: r.ms ?? b.occurred_at, batchId: id });
        this.db.run('UPDATE bills SET kind=?,direction=?,amount=?,currency=?,merchant=?,time_src=?,flags=?,dup_ok=? WHERE id=?', r.kind, r.direction, r.amount, r.currency ?? 'CNY', r.merchant, r.ms === null ? 'sent' : r.precise ? 'voucher' : 'day', JSON.stringify(flags), JSON.stringify(r.dup && pick ? [r.dup.id] : []), nid);
        r.done = nid;
        this.refresh(nid);
        created.push(nid);
      });
      const done = rows.every((r) => r.done);
      this.db.run('UPDATE bills SET batch=?, status=? WHERE id=?', JSON.stringify(rows), done ? 'batch_done' : 'batch', id);
      this.event(id, actor, '列表入账', `${created.length} 笔`);
      return { created, skipped };
    });
  }
  /** 关闭列表：剩余行不入账（原图和识别结果仍保留，可重新打开） */
  closeBatch(id: number, actor: string): void {
    const b = this.require(id);
    if (b.status !== 'batch') throw new UserError(`#${id} 不是待确认的账单列表`);
    this.db.run(`UPDATE bills SET status='batch_done' WHERE id=?`, id);
    this.event(id, actor, '关闭列表', '剩余行未入账');
  }
  reopenBatch(id: number, actor: string): void {
    const b = this.require(id);
    if (b.status !== 'batch_done') throw new UserError('不是已处理的账单列表');
    this.db.run(`UPDATE bills SET status='batch' WHERE id=?`, id);
    this.event(id, actor, '重新打开列表');
  }

  // ───────── 账目 ─────────
  createBill(o: { capture?: string; author: string; source: string; at: number; batchId?: number; importId?: number }): number {
    const { id } = this.db.run('INSERT INTO bills(capture,author,source,occurred_at,day,batch_id,import_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', o.capture ?? '', o.author, o.source, o.at, ymd(o.at), o.batchId ?? null, o.importId ?? null, this.now(), this.now());
    this.event(id, o.author, '创建', SOURCE[o.source] ?? o.source);
    return id;
  }

  /** 用素材重算自动字段、分类、疑似重复和状态。人工改过的字段不动。 */
  refresh(id: number): void {
    const b = this.require(id), evs = this.evidence(id), locked = new Set<string>(JSON.parse(b.locked));
    if (b.status === 'batch' || b.status === 'batch_done') { this.index(id); this.mark(b.capture, id); return; }
    const all = evs.filter((e) => e.parsed).map((e) => ({ e, r: e.parsed as TextParsed }));
    const img = all.filter((x) => x.e.attachment_id !== null && x.r.doc !== 'list'), txt = all.filter((x) => x.e.attachment_id === null);
    const waiting = evs.some((e) => e.att_kind === 'image' && !e.parsed);
    let flags: Flag[] = [];
    const set: Row = {};
    if (all.length || waiting) {
      const iAmt = img.filter((x) => x.r.amount !== null), tAmt = txt.filter((x) => x.r.amount !== null);
      const sure = iAmt.filter((x) => x.r.sure), tSure = tAmt.filter((x) => x.r.sure);
      // 金额
      let main: { e: Ev; r: TextParsed } | undefined = sure[0];
      if (main) {
        const tx = tAmt.find((x) => x.e.message_id === main!.e.message_id && !x.r.bare && x.r.amount !== main!.r.amount);
        if (tx) flags.push({ field: 'amount', hard: true, reason: `你写的是 ${money(tx.r.amount, tx.r.currency)}，截图是 ${money(main.r.amount, main.r.currency)}`, candidates: [tx.r.amount!, main.r.amount!] });
        const extra = [...new Set(sure.filter((x) => x.r.amount !== main!.r.amount).map((x) => x.r.amount!))];
        if (extra.length) flags.push({ field: 'evidence', hard: false, reason: `附加凭证的金额 ${extra.map((c) => money(c)).join('、')} 与本笔不同，没有改动金额` });
      } else if ((main = tSure[0])) { /* 文字明确说了金额 */ }
      else if ((main = iAmt[0] ?? tAmt[0])) flags.push(...main.r.flags.filter((f) => f.field === 'amount'));
      else flags.push({ field: 'amount', hard: true, reason: waiting ? '截图识别中' : img.flatMap((x) => x.r.flags).find((f) => f.field === 'amount')?.reason ?? '没有金额' });
      if (main?.r.flags.some((f) => f.field === 'amount' && !f.hard)) flags.push(...main.r.flags.filter((f) => f.field === 'amount' && !f.hard));
      if (!locked.has('amount')) { set.amount = main?.r.amount ?? null; set.currency = main?.r.currency ?? 'CNY'; }
      // 类型
      const kr = (iAmt[0] ?? tAmt[0] ?? all[0])?.r;
      if (!locked.has('kind') && kr) { set.kind = kr.kind; set.direction = kr.direction; flags.push(...img.flatMap((x) => x.r.flags.filter((f) => f.field === 'kind')).slice(0, 1)); }
      // 时间：凭证 > 文字 > 发送时间
      if (!locked.has('occurred_at')) {
        const cand = [...img].sort((x, y) => rank(x.r) - rank(y.r)).find((x) => x.r.ms !== null) ?? txt.find((x) => x.r.ms !== null);
        const sent = Math.min(...evs.map((e) => e.sent_at));
        set.occurred_at = cand?.r.ms ?? sent; set.day = ymd(set.occurred_at);
        set.time_src = cand ? (cand.r.precise ? (cand.e.attachment_id === null ? 'text' : 'voucher') : 'day') : 'sent';
        if (!cand && img.length) flags.push({ field: 'time', hard: false, reason: '截图上没有时间，用的是发送时间' });
      }
      if (!locked.has('merchant')) {
        const ms = [...img, ...txt].filter((x) => x.r.merchant).sort((x, y) => mrank(x.r) - mrank(y.r));
        set.merchant = ms[0]?.r.merchant ?? '';
        if (ms[0] && !ms[0].r.merchantSure) flags.push({ field: 'merchant', hard: false, reason: '商户名没把握' });
        else if (!ms[0]) flags.push(...img.flatMap((x) => x.r.flags.filter((f) => f.field === 'merchant')).slice(0, 1));
      }
      if (!locked.has('item')) set.item = clip([...new Set([...txt.map((x) => x.r.item), ...img.map((x) => x.r.item)].filter(Boolean))].slice(0, 3).join('；'), 120);
      if (!locked.has('note')) set.note = txt.map((x) => x.r.note).filter(Boolean).join('\n').slice(0, 5000);
      if (!locked.has('method')) set.method = ([...img].sort((x, y) => rank(x.r) - rank(y.r)).find((x) => x.r.method) ?? txt.find((x) => x.r.method))?.r.method ?? '';
      const ids = [...new Map([...img].sort((x, y) => rank(x.r) - rank(y.r)).flatMap((x) => x.r.ids).concat(locked.has('trade_no') ? JSON.parse(b.ids) : []).map((i) => [i.no, i])).values()];
      set.ids = JSON.stringify(ids);
      if (!locked.has('trade_no')) set.trade_no = (ids.find((i) => i.type === 'trade') ?? ids.find((i) => i.type === 'order') ?? ids[0])?.no ?? '';
    } else flags = (JSON.parse(b.flags) as Flag[]).filter((f) => f.field !== 'category');
    flags = flags.filter((f) => !locked.has(f.field === 'time' ? 'occurred_at' : f.field === 'category' ? 'category_id' : f.field) && !(b.confirmed && f.hard));
    const n: Row = { ...b, ...set };
    if (n.amount === null && !flags.some((f) => f.field === 'amount' && f.hard)) flags.push({ field: 'amount', hard: true, reason: '没有金额' });
    if (n.amount === 0 && !locked.has('amount')) flags.push({ field: 'amount', hard: true, reason: '金额为 0' });

    // 退款：单号相同就自动关联原支出
    if (n.kind !== 'refund') n.refund_of = null;
    else if (!n.refund_of && !locked.has('refund_of')) {
      const ids = (JSON.parse(n.ids) as { no: string }[]).map((i) => i.no);
      const o = ids.length ? this.byIds(ids, 'expense', id) : undefined;
      if (o && n.amount !== null && this.refundable(o.id, id) >= n.amount) { n.refund_of = o.id; this.event(id, '系统', '关联原支出', `单号相同 → #${o.id}`); }
    }
    if (n.refund_of) { const left = this.refundable(n.refund_of, id); if (n.amount !== null && n.amount > left) flags.push({ field: 'kind', hard: false, reason: `累计退款超过原支出 #${n.refund_of}` }); }

    // 分类
    if (!locked.has('category_id')) {
      const c = this.classify(n as any, img.map((x) => x.r.hint).find(Boolean) ?? '');
      n.category_id = c?.id ?? null; n.category_src = c?.src ?? ''; n.category_why = c?.why ?? '';
      if (!c && (n.kind === 'expense' || n.kind === 'income')) flags.push({ field: 'category', hard: false, reason: '没能自动归类' });
    }

    // 疑似重复
    const dupOk = JSON.parse(n.dup_ok) as number[];
    const shas = evs.map((e) => e.sha256).filter((s): s is string => !!s);
    const dup = n.amount === null && !JSON.parse(n.ids).length && !shas.length ? null : this.findDup({ ...(n as any), ids: (JSON.parse(n.ids) as { no: string }[]).map((i) => i.no), shas }, id, dupOk);
    n.dup_of = dup?.id ?? null; n.dup_why = dup?.why ?? '';

    const hard = flags.some((f) => f.hard);
    n.status = dup ? 'dup' : hard || n.amount === null ? 'pending' : 'ok';
    this.db.run(`UPDATE bills SET amount=?,currency=?,kind=?,direction=?,occurred_at=?,day=?,time_src=?,merchant=?,item=?,note=?,method=?,ids=?,trade_no=?,refund_of=?,category_id=?,category_src=?,category_why=?,dup_of=?,dup_why=?,flags=?,status=?,updated_at=? WHERE id=?`,
      n.amount, n.currency, n.kind, n.direction, n.occurred_at, n.day, n.time_src, n.merchant, n.item, n.note, n.method, n.ids, n.trade_no, n.refund_of, n.category_id, n.category_src, n.category_why, n.dup_of, n.dup_why, JSON.stringify(flags), n.status, this.now(), id);
    this.index(id);
    this.mark(n.capture, id);
  }
  private mark(capture: string, id: number): void { if (capture) (this.dirty.get(capture) ?? this.dirty.set(capture, new Set()).get(capture)!).add(id); }
  /** 取走某组素材里有变化的账 */
  takeDirty(capture: string): number[] { const s = [...(this.dirty.get(capture) ?? [])]; this.dirty.delete(capture); return s.sort((a, b) => a - b); }
  private index(id: number): void {
    const b = this.require(id);
    const extra = this.db.all(`SELECT COALESCE(m.text,'') t FROM evidence e JOIN messages m ON m.id=e.message_id WHERE e.bill_id=? UNION SELECT a.text FROM evidence e JOIN attachments a ON a.id=e.attachment_id WHERE e.bill_id=?`, id, id).map((r) => r.t);
    const cat = this.categoryName(b.category_id);
    const s = [b.merchant, b.item, b.note, b.method, b.trade_no, cat, b.amount === null ? '' : (b.amount / 100).toFixed(2), ...JSON.parse(b.ids).map((i: any) => i.no), ...extra].join('\n').toLowerCase();
    this.db.run('UPDATE bills SET search_text=? WHERE id=?', s, id);
  }

  // ───────── 重复与退款 ─────────
  private byIds(ids: string[], kind: Kind, except: number): Row | undefined {
    const good = ids.filter((i) => i.length >= 8);
    if (!good.length) return undefined;
    return this.db.get(`SELECT b.* FROM bills b, json_each(b.ids) j WHERE b.deleted_at IS NULL AND b.kind=? AND b.id<>? AND b.status IN ('ok','pending','dup') AND json_extract(j.value,'$.no') IN (${good.map(() => '?').join()}) ORDER BY b.id LIMIT 1`, kind, except, ...good);
  }
  private findDup(n: { kind: Kind; amount: number | null; currency: string; merchant: string; item: string; occurred_at: number; time_src: string; ids: string[]; shas: string[]; day: string }, id: number, ok: number[]): { id: number; why: string } | null {
    const older = id ? `AND b.id<${id}` : '';
    const root = (b: Row): Row => { const r = b.dup_of ? this.db.get('SELECT * FROM bills WHERE id=? AND deleted_at IS NULL', b.dup_of) : undefined; return r ?? b; };
    const hit = (b: Row, why: string) => { const r = root(b); return ok.includes(r.id) || ok.includes(b.id) || r.id === id ? null : { id: r.id as number, why }; };
    const good = n.ids.filter((i) => i.length >= 8);
    if (good.length) for (const b of this.db.all(`SELECT DISTINCT b.* FROM bills b, json_each(b.ids) j WHERE b.deleted_at IS NULL ${older} AND b.kind=? AND b.status IN ('ok','pending','dup') AND json_extract(j.value,'$.no') IN (${good.map(() => '?').join()}) ORDER BY b.id`, n.kind, ...good)) {
      // Even differing amounts may be an OCR error or a partial refund. Ask before counting.
      const h = hit(b, '交易单号相同'); if (h) return h;
    }
    if (n.shas.length) for (const b of this.db.all(`SELECT DISTINCT b.* FROM bills b JOIN evidence e ON e.bill_id=b.id JOIN attachments a ON a.id=e.attachment_id WHERE b.deleted_at IS NULL ${older} AND b.status IN ('ok','pending','dup') AND a.sha256 IN (${n.shas.map(() => '?').join()}) ORDER BY b.id`, ...n.shas)) {
      if (n.amount !== null && b.amount !== null && n.amount !== b.amount) continue;
      const h = hit(b, '同一张截图发过'); if (h) return h;
    }
    if (n.amount === null || !n.day) return null;
    for (const b of this.db.all(`SELECT b.* FROM bills b WHERE b.deleted_at IS NULL ${older} AND b.kind=? AND b.currency=? AND b.amount=? AND b.status IN ('ok','pending','dup') AND b.occurred_at BETWEEN ? AND ? ORDER BY b.id`, n.kind, n.currency, n.amount, n.occurred_at - 86400_000, n.occurred_at + 86400_000)) {
      // 双方都有同类型单号且不同：确定不是同一笔
      const bid = (JSON.parse(b.ids) as { type: string; no: string }[]).filter((i) => i.no.length >= 8);
      const gap = Math.abs(b.occurred_at - n.occurred_at);
      if (good.length && bid.length && n.time_src === 'voucher' && b.time_src === 'voucher' && gap > 2 * MIN) continue;
      const src = new Set([b.time_src, n.time_src]);
      const exact = (s: string) => s === 'voucher' || s === 'text' || s === 'manual';
      const near = src.has('day') ? b.day === n.day : exact(b.time_src) && exact(n.time_src) ? gap <= 10 * MIN : src.has('sent') && (exact(b.time_src) || exact(n.time_src)) ? gap <= 60 * MIN : gap <= 10 * MIN;
      if (!near) continue;
      const x = b.merchant || '', y = n.merchant || '';
      const sim = x && y ? similarName(x, y) || isPlatformMerchant(x) || isPlatformMerchant(y) : similarName(x || b.item, y || n.item) || (!(x || b.item) || !(y || n.item)) || (!!x !== !!y);
      if (!sim) continue;
      const h = hit(b, '金额、商户、时间相近'); if (h) return h;
    }
    return null;
  }
  /** 用户判定：是重复 → 素材并到原账、本笔进回收站；不是 → 正常入账。 */
  resolveDup(id: number, same: boolean, actor: string): number {
    return this.db.tx(() => {
      const b = this.require(id);
      if (b.status !== 'dup' || !b.dup_of) throw new UserError(`#${id} 没有待处理的重复提示`);
      const to = b.dup_of as number;
      if (same) { this.db.run('UPDATE evidence SET bill_id=?, pinned=1 WHERE bill_id=?', to, id); this.db.run('UPDATE qq_refs SET bill_id=? WHERE bill_id=?', to, id); this.event(id, actor, '判定重复', `与 #${to} 是同一笔`); this.event(to, actor, '并入重复素材', `← #${id}`); this.remove(id, actor); this.refresh(to); return to; }
      this.db.run('UPDATE bills SET dup_ok=?, dup_of=NULL WHERE id=?', JSON.stringify([...JSON.parse(b.dup_ok), to]), id);
      this.event(id, actor, '判定不重复', `与 #${to} 是两笔`);
      this.refresh(id);
      return id;
    });
  }
  /** 原支出还能退多少 */
  refundable(id: number, except = 0): number {
    const o = this.require(id);
    return (o.amount ?? 0) - Number(this.db.get(`SELECT COALESCE(SUM(amount),0) n FROM bills WHERE refund_of=? AND id<>? AND deleted_at IS NULL AND status='ok'`, id, except)!.n);
  }
  /** 可能的原支出，供用户选择 */
  refundCandidates(id: number, limit = 5): Row[] {
    const b = this.require(id);
    if (b.kind !== 'refund' || b.amount === null) return [];
    return this.db.all(`SELECT * FROM bills WHERE kind='expense' AND deleted_at IS NULL AND status='ok' AND currency=? AND amount>=? AND occurred_at<=? AND occurred_at>? ORDER BY occurred_at DESC LIMIT 500`, b.currency, b.amount, b.occurred_at + 86400_000, b.occurred_at - 400 * 86400_000)
      .filter((o) => this.refundable(o.id, id) >= b.amount && (similarName(o.merchant || o.item, b.merchant || b.item) || o.amount === b.amount))
      .sort((x, y) => score(y, b) - score(x, b)).slice(0, limit);
  }

  // ───────── 分类与规则 ─────────
  private cats: Row[] | null = null;
  private ruleCache: Row[] | null = null;
  resetCaches(): void { this.cats = null; this.ruleCache = null; }
  categories(): Row[] { return (this.cats ??= this.db.all('SELECT * FROM categories ORDER BY sort,id')); }
  categoryName(id: number | null): string {
    const c = this.categories().find((x) => x.id === id);
    if (!c) return '未分类';
    const p = c.parent_id ? this.categories().find((x) => x.id === c.parent_id) : null;
    return p ? `${p.name}/${c.name}` : c.name;
  }
  /** 「打车」「交通/打车」「交通」→ 分类 */
  matchCategory(input: string, type: 'expense' | 'income' = 'expense'): Row | null {
    const s = input.trim().replace(/[>＞·\s]+/g, '/'), list = this.categories().filter((c) => c.type === type);
    const [a, b] = s.split('/');
    if (b) { const p = list.find((c) => !c.parent_id && c.name === a); return list.find((c) => c.parent_id === p?.id && c.name === b) ?? null; }
    return list.find((c) => c.parent_id && c.name === s) ?? list.find((c) => !c.parent_id && c.name === s) ?? (() => { const x = list.filter((c) => c.name.includes(s)); return s.length >= 2 && x.length === 1 ? x[0]! : null; })();
  }
  classify(b: { kind: Kind; merchant: string; item: string; note: string }, hint = ''): { id: number; src: string; why: string } | null {
    if (b.kind === 'transfer' || b.kind === 'repay') return null;
    const type = b.kind === 'income' ? 'income' : 'expense', list = this.categories().filter((c) => c.type === type), ok = new Set(list.map((c) => c.id));
    const subject = b.merchant || b.item, key = normName(subject);
    const rules = (this.ruleCache ??= this.db.all('SELECT * FROM rules WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC')).filter((r) => ok.has(r.category_id));
    if (key) {
      const r = rules.find((x) => x.match === 'merchant' && normName(x.pattern) === key);
      if (r) return { id: r.category_id, src: 'rule', why: `规则「${r.pattern}」` };
    }
    const hay = `${b.merchant}\n${b.item}\n${b.note}`.toLowerCase();
    const c = rules.filter((x) => x.match === 'contains' && hay.includes(x.pattern.toLowerCase())).sort((x, y) => y.pattern.length - x.pattern.length)[0];
    if (c) return { id: c.category_id, src: 'rule', why: `规则「含 ${c.pattern}」` };
    if (hint && type === 'expense') { const h = list.find((x) => x.parent_id && x.name === hint); if (h) return { id: h.id, src: 'scene', why: `${hint}订单` }; }
    for (const [text, name] of [[b.merchant, '商户'], [b.item, '说明'], [b.note, '备注']] as const) {
      const t = text.toLowerCase();
      if (!t) continue;
      let best: { id: number; src: string; why: string } | null = null, len = 0;
      for (const x of list) for (const kw of [x.name, ...String(x.keywords).split(/[,，]/)]) {
        const k = kw.trim().toLowerCase();
        if (k.length >= 2 && [...k].length > len && t.includes(k)) { len = [...k].length; best = { id: x.id, src: 'keyword', why: `${name}含「${kw.trim()}」` }; }
      }
      if (best) return best;
    }
    return null;
  }
  saveCategory(o: { id?: number; name?: string; icon?: string; keywords?: string; parent_id?: number | null; type?: string; sort?: number }): number {
    const name = o.name?.trim();
    if (o.id) {
      const c = this.db.get('SELECT * FROM categories WHERE id=?', o.id);
      if (!c) throw new UserError('分类不存在', 404);
      if (name !== undefined && (!name || [...name].length > 20)) throw new UserError('名称须为 1–20 字');
      if (name) this.uniqueCat(name, c.type, c.parent_id, o.id);
      this.db.run('UPDATE categories SET name=?,icon=?,keywords=?,sort=? WHERE id=?', name ?? c.name, o.icon ?? c.icon, o.keywords === undefined ? c.keywords : o.keywords.slice(0, 5000), o.sort ?? c.sort, o.id);
      this.cats = null;
      return o.id;
    }
    if (!name || [...name].length > 20) throw new UserError('名称须为 1–20 字');
    let type = o.type === 'income' ? 'income' : 'expense';
    if (o.parent_id) {
      const p = this.db.get('SELECT * FROM categories WHERE id=?', o.parent_id);
      if (!p) throw new UserError('上级分类不存在', 404);
      if (p.parent_id) throw new UserError('分类最多两级');
      type = p.type;
    }
    this.uniqueCat(name, type, o.parent_id ?? null, 0);
    const sort = o.sort ?? Number(this.db.get('SELECT COALESCE(MAX(sort),0)+1 n FROM categories')!.n);
    const id = this.db.run('INSERT INTO categories(type,parent_id,name,icon,keywords,sort) VALUES(?,?,?,?,?,?)', type, o.parent_id ?? null, name, o.icon ?? (o.parent_id ? '' : 'dots'), (o.keywords ?? '').slice(0, 5000), sort).id;
    this.cats = null;
    return id;
  }
  private uniqueCat(name: string, type: string, parent: number | null, except: number): void {
    if (this.db.get('SELECT 1 FROM categories WHERE type=? AND COALESCE(parent_id,0)=? AND name=? AND id<>?', type, parent ?? 0, name, except)) throw new UserError(`已有分类「${name}」`);
  }
  /** 删除分类：账和规则移到 moveTo（不给则账变成未分类、规则删除）。 */
  deleteCategory(id: number, moveTo: number | null, actor: string): void {
    this.db.tx(() => {
      const c = this.db.get('SELECT * FROM categories WHERE id=?', id);
      if (!c) throw new UserError('分类不存在', 404);
      const ids = [id, ...this.categories().filter((x) => x.parent_id === id).map((x) => x.id)];
      if (moveTo !== null) { const t = this.db.get('SELECT * FROM categories WHERE id=?', moveTo); if (!t || t.type !== c.type) throw new UserError('目标分类无效'); if (ids.includes(moveTo)) throw new UserError('不能移到要删除的分类'); }
      const names = new Map(ids.map((i) => [i, this.categoryName(i)]));
      const to = moveTo === null ? '未分类' : this.categoryName(moveTo);
      for (const b of this.db.all(`SELECT id,category_id,locked FROM bills WHERE category_id IN (${ids.join()})`)) {
        this.db.run('UPDATE bills SET category_id=?, category_src=?, category_why=? WHERE id=?', moveTo, moveTo === null ? '' : 'manual', '原分类已删除', b.id);
        this.event(b.id, actor, '修改分类', `${names.get(b.category_id)} → ${to}（删除分类）`);
      }
      if (moveTo !== null) this.db.run(`UPDATE rules SET category_id=? WHERE category_id IN (${ids.join()})`, moveTo);
      this.db.run(`DELETE FROM budgets WHERE category_id IN (${ids.join()})`);
      this.db.run(`DELETE FROM categories WHERE id IN (${ids.join()})`);
      this.resetCaches();
    });
  }
  rules(deleted = false): Row[] { return this.db.all(`SELECT r.*, (SELECT COUNT(*) FROM bills b WHERE b.deleted_at IS NULL AND b.category_src='rule' AND b.category_id=r.category_id AND b.category_why LIKE '%'||r.pattern||'%') hits FROM rules r WHERE r.deleted_at IS ${deleted ? 'NOT' : ''} NULL ORDER BY r.updated_at DESC, r.id DESC`).map((r) => ({ ...r, category: this.categoryName(r.category_id) })); }
  saveRule(o: { match: string; pattern: string; category_id: number; source?: string }): number {
    const p = o.pattern.trim();
    if (!p || p.length > 60) throw new UserError('规则内容须为 1–60 字');
    if (o.match !== 'merchant' && o.match !== 'contains') throw new UserError('规则类型无效');
    if (!this.categories().some((c) => c.id === o.category_id)) throw new UserError('分类不存在');
    const same = this.db.all('SELECT * FROM rules WHERE match=?', o.match).find((r) => (o.match === 'merchant' ? normName(r.pattern) === normName(p) : r.pattern === p));
    this.ruleCache = null;
    if (same) { this.db.run('UPDATE rules SET pattern=?,category_id=?,source=?,updated_at=?,deleted_at=NULL WHERE id=?', p, o.category_id, o.source ?? 'manual', this.now(), same.id); return same.id; }
    return this.db.run('INSERT INTO rules(match,pattern,category_id,source,created_at,updated_at) VALUES(?,?,?,?,?,?)', o.match, p, o.category_id, o.source ?? 'manual', this.now(), this.now()).id;
  }
  deleteRule(id: number, undo = false): void {
    if (!this.db.run(`UPDATE rules SET deleted_at=${undo ? 'NULL' : '?'} WHERE id=?`, ...(undo ? [id] : [this.now(), id])).changes) throw new UserError('规则不存在', 404);
    this.ruleCache = null;
  }
  /** 按现有规则重新归类（不动人工改过分类的账），返回改动数。 */
  reclassify(subject?: string): number {
    let n = 0;
    for (const b of this.db.all(`SELECT id,category_id,locked,merchant,item FROM bills WHERE status IN ('ok','pending','dup')`)) {
      if (JSON.parse(b.locked).includes('category_id') || (subject && normName(b.merchant || b.item) !== normName(subject))) continue;
      const before = b.category_id;
      this.db.tx(() => { this.refresh(b.id); const after = this.require(b.id).category_id; if (after !== before) { n++; this.event(b.id, '系统', '重新归类', `${this.categoryName(before)} → ${this.categoryName(after)}`); } });
    }
    return n;
  }

  // ───────── 修改 ─────────
  /** 返回记住的规则（改分类时）。 */
  update(id: number, patch: Row, actor: string, learn = true, options: UpdateOptions = {}): { rule?: Row; changed: string[]; version: number } {
    return this.db.tx(() => {
      const b = this.require(id), locked = new Set<string>(JSON.parse(b.locked));
      if (options.expectedVersion !== undefined && Number(b.version ?? 1) !== options.expectedVersion) throw new UserError(`版本已变化，当前版本为 ${b.version ?? 1}，请重新读取后再改`, 409);
      if (b.status === 'batch' || b.status === 'batch_done') { if (Object.keys(patch).some((k) => k !== 'note')) throw new UserError('账单列表不能直接改，请先入账'); }
      const out: { rule?: Row; changed: string[]; version: number } = { changed: [], version: Number(b.version ?? 1) };
      const changes: Record<string, { before: unknown; after: unknown }> = {};
      for (const [k, raw] of Object.entries(patch)) {
        if (!(k in FIELD)) throw new UserError(`不支持的字段：${k}`);
        let v: any = raw;
        if (k === 'amount') { if (!Number.isSafeInteger(v) || v <= 0 || v > 1e11) throw new UserError('金额须大于 0'); }
        else if (k === 'kind') { if (!(v in KIND)) throw new UserError('类型无效'); }
        else if (k === 'occurred_at') { if (!Number.isSafeInteger(v) || !validDay(ymd(v))) throw new UserError('时间无效'); }
        else if (k === 'category_id') { if (v !== null && !this.categories().some((c) => c.id === v)) throw new UserError('分类不存在'); }
        else if (k === 'status') { if (!['ok', 'pending'].includes(String(v))) throw new UserError('待确认状态无效'); v = String(v); }
        else if (k === 'confirmed') { if (typeof v !== 'boolean') throw new UserError('确认状态无效'); v = v ? 1 : 0; }
        else if (k === 'refund_of') {
          if (v !== null) {
            const o = this.require(Number(v)), kind = patch.kind ?? b.kind;
            if (kind !== 'refund') throw new UserError('只有退款能关联原支出');
            if (o.kind !== 'expense' || o.deleted_at || o.id === id) throw new UserError(`#${o.id} 不是可关联的支出`);
            if (o.currency !== b.currency) throw new UserError('币种不同，不能关联');
            v = o.id;
          }
        } else {
          if (typeof v !== 'string') throw new UserError(`${FIELD[k]}格式错误`);
          v = v.trim();
          if (v.length > (k === 'note' ? 5000 : k === 'ids' ? 2000 : 120)) throw new UserError(`${FIELD[k]}过长`);
          if (k === 'currency' && !/^[A-Z]{3}$/.test(v)) throw new UserError('币种应为三位字母');
          if (k === 'direction' && !['', 'in', 'out'].includes(v)) throw new UserError('方向无效');
        }
        if (k === 'status') { if (v === 'pending') locked.add('review'); }
        else if (k !== 'confirmed') locked.add(k === 'currency' ? 'amount' : k);
        if (k === 'kind') locked.add('direction');
        if (b[k] === v) { if (k === 'status') throw new UserError('待确认状态没有变化'); continue; }
        changes[k] = { before: b[k], after: v };
        out.changed.push(k);
        this.db.run(`UPDATE bills SET ${k}=? WHERE id=?`, v, id);
        if (k === 'occurred_at') this.db.run(`UPDATE bills SET day=?, time_src='manual' WHERE id=?`, ymd(v), id);
        if (k === 'kind') this.db.run('UPDATE bills SET direction=? WHERE id=?', v === 'income' || v === 'refund' ? 'in' : 'out', id);
        if (k === 'category_id') this.db.run(`UPDATE bills SET category_src='manual', category_why='手动选择' WHERE id=?`, id);
        this.event(id, actor, `修改${FIELD[k]}`, `${this.show(k, b[k], b)} → ${this.show(k, v, { ...b, ...patch })}`);
      }
      this.db.run('UPDATE bills SET locked=? WHERE id=?', JSON.stringify([...locked]), id);
      const after = this.require(id), subject = after.merchant || after.item;
      if (learn && patch.category_id && b.category_id !== patch.category_id && subject && ['expense', 'income', 'refund'].includes(after.kind)) {
        const rid = this.saveRule({ match: 'merchant', pattern: clip(subject, 60), category_id: patch.category_id, source: 'learned' });
        out.rule = { id: rid, pattern: subject, category: this.categoryName(patch.category_id), others: this.sameSubject(subject, id) };
        this.event(id, '系统', '记住分类', `「${subject}」→ ${out.rule.category}`);
      }
      this.refresh(id);
      if (patch.status === 'pending') {
        const now = this.require(id), flags = JSON.parse(now.flags) as any[];
        if (!flags.some((f) => f.field === 'review')) flags.push({ field: 'review', hard: true, reason: '用户标记为待确认' });
        this.db.run('UPDATE bills SET status=\'pending\', flags=?, updated_at=? WHERE id=?', JSON.stringify(flags), this.now(), id);
      } else if (patch.status === 'ok') {
        const now = this.require(id), flags = (JSON.parse(now.flags) as any[]).filter((f) => f.field !== 'review');
        this.db.run('UPDATE bills SET flags=?, status=?, confirmed=1, updated_at=? WHERE id=?', JSON.stringify(flags), now.amount === null || flags.some((f) => f.hard) ? 'pending' : 'ok', this.now(), id);
      }
      if (out.changed.length) {
        const beforeVersion = Number(b.version ?? 1), afterVersion = beforeVersion + 1;
        this.db.run('UPDATE bills SET version=? WHERE id=?', afterVersion, id);
        out.version = afterVersion;
        this.db.run('INSERT INTO bill_changes(bill_id,at,source,actor,reason,before_version,after_version,authorization_id,fields) VALUES(?,?,?,?,?,?,?,?,?)',
          id, this.now(), options.source ?? (actor === '网页' ? 'web' : actor === '系统' ? 'system' : actor === '导入' ? 'import' : actor === 'MCP' ? 'mcp' : 'qq'), actor,
          options.reason ?? '修改账单', beforeVersion, afterVersion, options.authorizationId ?? null, JSON.stringify(changes));
      }
      for (const r of this.db.all('SELECT id FROM bills WHERE refund_of=? AND deleted_at IS NULL', id)) this.refresh(r.id);
      return out;
    });
  }
  /** 同一商户里分类不同、没被人工改过的账有多少 */
  private sameSubject(subject: string, except: number): number {
    const cat = this.require(except).category_id;
    return this.db.all(`SELECT merchant,item,locked FROM bills WHERE id<>? AND deleted_at IS NULL AND status IN ('ok','pending') AND category_id IS NOT ?`, except, cat).filter((b) => !JSON.parse(b.locked).includes('category_id') && normName(b.merchant || b.item) === normName(subject)).length;
  }
  private show(k: string, v: any, b: Row): string {
    if (v === null || v === undefined || v === '') return '空';
    if (k === 'amount') return money(v, b.currency);
    if (k === 'kind') return KIND[v as Kind];
    if (k === 'occurred_at') return fmtTime(v);
    if (k === 'category_id') return this.categoryName(v);
    if (k === 'refund_of') return `#${v}`;
    return clip(String(v), 60);
  }
  /** 确认：接受当前识别结果。金额为空时不能确认。 */
  confirm(id: number, actor: string): void {
    this.db.tx(() => {
      const b = this.require(id);
      if (b.status === 'dup') throw new UserError(`#${id} 疑似与 #${b.dup_of} 重复，请先判断是否重复`);
      if (b.amount === null) throw new UserError(`#${id} 还没有金额，请先补金额`);
      if (b.status.startsWith('batch')) throw new UserError('账单列表请用「入账」');
      const locked = new Set<string>(JSON.parse(b.locked));
      for (const k of ['amount', 'kind']) locked.add(k);
      this.db.run('UPDATE bills SET confirmed=1, locked=? WHERE id=?', JSON.stringify([...locked]), id);
      const beforeVersion = Number(b.version ?? 1), afterVersion = beforeVersion + 1;
      this.db.run('UPDATE bills SET version=? WHERE id=?', afterVersion, id);
      this.db.run('INSERT INTO bill_changes(bill_id,at,source,actor,reason,before_version,after_version,authorization_id,fields) VALUES(?,?,?,?,?,?,?,?,?)', id, this.now(), actor === '网页' ? 'web' : 'qq', actor, '确认账单', beforeVersion, afterVersion, null, JSON.stringify({ confirmed: { before: b.confirmed, after: 1 } }));
      this.event(id, actor, '确认', `${KIND[b.kind as Kind]} ${money(b.amount, b.currency)}`);
      this.refresh(id);
    });
  }
  /** 把一份素材移到另一笔；target 为 null 时新立一笔。 */
  moveEvidence(evId: number, target: number | null, actor: string): number {
    return this.db.tx(() => {
      const e = this.ev(evId);
      if (!e.bill_id) throw new UserError('素材不在任何账里', 404);
      const from = this.require(e.bill_id);
      if (target === from.id) throw new UserError('已在这笔账里');
      if (from.status.startsWith('batch') && e.att_kind === 'image') throw new UserError('账单列表的截图不能移动');
      if (target !== null && (this.require(target).deleted_at || this.require(target).status.startsWith('batch'))) throw new UserError('目标账不可用');
      const left = this.evidence(from.id).filter((x) => x.id !== evId).length;
      if (target === null && left === 0) throw new UserError('这笔账只有这一份素材，无需拆分');
      const to = target ?? this.createBill({ capture: from.capture, author: from.author, source: from.source, at: e.sent_at });
      this.setBill(evId, to, true);
      // 语音转写文字等同一消息的附属内容各自独立，不跟随
      const ref = this.refOf(e.message_id);
      if (ref) this.db.run('UPDATE qq_refs SET bill_id=? WHERE ref=?', to, ref);
      this.event(from.id, actor, '移出素材', `→ #${to}`);
      this.event(to, actor, '移入素材', `← #${from.id}`);
      if (left === 0) this.remove(from.id, actor);
      // 从原账拆走后，原来靠这份素材得到的确认不再成立
      this.refresh(from.id); this.refresh(to);
      return to;
    });
  }
  merge(from: number, to: number, actor: string): void {
    if (from === to) throw new UserError('不能并入自己');
    this.db.tx(() => {
      const a = this.require(from), b = this.require(to);
      if (a.deleted_at || b.deleted_at) throw new UserError('账已删除');
      if (a.status.startsWith('batch') || b.status.startsWith('batch')) throw new UserError('账单列表不能合并');
      this.db.run('UPDATE evidence SET bill_id=?, pinned=1 WHERE bill_id=?', to, from);
      this.db.run('UPDATE qq_refs SET bill_id=? WHERE bill_id=?', to, from);
      if (a.note && JSON.parse(a.locked).includes('note')) { this.db.run('UPDATE bills SET note=? WHERE id=?', [b.note, a.note].filter(Boolean).join('\n'), to); }
      // 没有素材的账（手工、导入）以合并目标为准，目标没金额时带过去
      if (b.amount === null && a.amount !== null) { this.db.run('UPDATE bills SET amount=?,currency=?,locked=? WHERE id=?', a.amount, a.currency, JSON.stringify([...new Set([...JSON.parse(b.locked), 'amount'])]), to); }
      this.event(to, actor, '并入', `← #${from}（${money(a.amount, a.currency)}）`);
      this.event(from, actor, '并入', `→ #${to}`);
      this.remove(from, actor);
      this.refresh(to);
    });
  }
  /** 撤销某人最近一条消息的素材（保留原始记录）。 */
  undoLast(capture: string, author: string): { text: string; bills: number[]; removed: number[] } | null {
    return this.db.tx(() => {
      const m = this.db.get(`SELECT m.id,m.text FROM messages m WHERE m.capture=? AND m.author=? AND m.kind='entry' AND EXISTS(SELECT 1 FROM evidence e WHERE e.message_id=m.id AND e.bill_id IS NOT NULL) ORDER BY m.id DESC LIMIT 1`, capture, author);
      if (!m) return null;
      const bills = this.db.all('SELECT DISTINCT bill_id id FROM evidence WHERE message_id=? AND bill_id IS NOT NULL', m.id).map((r) => r.id as number), removed: number[] = [];
      this.db.run('UPDATE evidence SET bill_id=NULL WHERE message_id=?', m.id);
      for (const b of bills) {
        this.event(b, author, '撤销素材', clip(m.text || '（附件）', 60));
        if (!this.db.get('SELECT 1 FROM evidence WHERE bill_id=?', b)) { this.remove(b, author); removed.push(b); } else this.refresh(b);
      }
      return { text: m.text, bills, removed };
    });
  }
  /** 最近一条消息里归属某账的最后一份素材 */
  lastEvidence(bill: number, author: string): number | undefined {
    return this.db.get('SELECT id FROM evidence WHERE bill_id=? AND author=? ORDER BY sent_at DESC, id DESC LIMIT 1', bill, author)?.id;
  }
  private refOf(messageId: number): string | undefined {
    try { return (JSON.parse(this.db.get('SELECT raw FROM messages WHERE id=?', messageId)?.raw ?? 'null')?.message_scene?.ext as string[] | undefined)?.find((e) => e.startsWith('msg_idx='))?.slice(8); } catch { return undefined; }
  }
  remove(id: number, actor: string): void {
    const b = this.require(id); if (b.deleted_at) return;
    this.db.run('UPDATE bills SET deleted_at=?, updated_at=? WHERE id=?', this.now(), this.now(), id);
    const beforeVersion = Number(b.version ?? 1), afterVersion = beforeVersion + 1;
    this.db.run('UPDATE bills SET version=? WHERE id=?', afterVersion, id);
    this.db.run('INSERT INTO bill_changes(bill_id,at,source,actor,reason,before_version,after_version,authorization_id,fields) VALUES(?,?,?,?,?,?,?,?,?)', id, this.now(), actor === '网页' ? 'web' : 'qq', actor, '删除账单', beforeVersion, afterVersion, null, JSON.stringify({ deleted_at: { before: null, after: this.require(id).deleted_at } }));
    this.event(id, actor, '删除');
    for (const r of this.db.all(`SELECT id FROM bills WHERE dup_of=? AND deleted_at IS NULL AND status='dup'`, id)) this.refresh(r.id);
  }
  restore(id: number, actor: string): void {
    this.db.tx(() => { const b = this.require(id); this.db.run('UPDATE bills SET deleted_at=NULL, updated_at=? WHERE id=?', this.now(), id); const beforeVersion = Number(b.version ?? 1), afterVersion = beforeVersion + 1; this.db.run('UPDATE bills SET version=? WHERE id=?', afterVersion, id); this.db.run('INSERT INTO bill_changes(bill_id,at,source,actor,reason,before_version,after_version,authorization_id,fields) VALUES(?,?,?,?,?,?,?,?,?)', id, this.now(), actor === '网页' ? 'web' : 'qq', actor, '恢复账单', beforeVersion, afterVersion, null, JSON.stringify({ deleted_at: { before: b.deleted_at, after: null } })); this.event(id, actor, '恢复'); this.refresh(id); });
  }
  event(id: number, actor: string, action: string, detail = ''): void {
    this.db.run('INSERT INTO events(bill_id,at,actor,action,detail) VALUES(?,?,?,?,?)', id, this.now(), actor, action, detail);
  }
  /** 一次性绑定码，10 分钟有效。 */
  createBindCode(): { code: string; exp: number } {
    const v = { code: String(crypto.randomInt(10_000_000, 100_000_000)), exp: this.now() + 10 * MIN };
    this.db.kvSet('bind_code', JSON.stringify(v));
    return v;
  }

  // ───────── 预算 ─────────
  budgets(): Row[] { return this.db.all('SELECT * FROM budgets ORDER BY category_id').map((b) => ({ ...b, name: b.category_id ? this.categoryName(b.category_id) : '总预算' })); }
  saveBudget(category: number, amount: number): void {
    if (category && !this.categories().some((c) => c.id === category && !c.parent_id && c.type === 'expense')) throw new UserError('预算只能设在一级支出分类上');
    if (amount === 0) { this.db.run('DELETE FROM budgets WHERE category_id=?', category); return; }
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1e11) throw new UserError('预算金额无效');
    this.db.run('INSERT INTO budgets(category_id,amount) VALUES(?,?) ON CONFLICT(category_id) DO UPDATE SET amount=excluded.amount', category, amount);
  }

  // ───────── 读取 ─────────
  require(id: number): Row {
    const b = Number.isSafeInteger(id) ? this.db.get('SELECT * FROM bills WHERE id=?', id) : undefined;
    if (!b) throw new UserError(`账目 #${id} 不存在`, 404);
    return b;
  }
  where(f: Filter): { sql: string; args: (string | number)[] } {
    const c: string[] = [f.deleted ? 'v.deleted_at IS NOT NULL' : 'v.deleted_at IS NULL'], a: (string | number)[] = [];
    const num = /^#?(\d+)$/.exec(f.q?.trim() ?? '');
    for (const t of (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      if (num) { c.push(`(v.id=? OR v.search_text LIKE ? ESCAPE '\\')`); a.push(Number(num[1]), `%${likeEscape(num[1]!)}%`); }
      else { c.push(`v.search_text LIKE ? ESCAPE '\\'`); a.push(`%${likeEscape(t)}%`); }
    }
    let day = 'v.day', cat = 'v.category_id', mer = 'v.merchant', met = 'v.method';
    if (f.counted) {
      c.push(f.withPending ? `v.status IN ('ok','pending') AND v.amount IS NOT NULL` : `v.status='ok'`, `v.kind IN ('expense','refund')`, `v.currency='CNY'`);
      if ((f.basis ?? this.basis) === 'original') day = 'v.orig_day';
      cat = 'v.eff_category'; mer = 'v.eff_merchant'; met = 'v.eff_method';
    }
    if (f.status === 'todo') c.push(`v.status IN ('pending','dup','batch')`);
    else if (f.status) { c.push('v.status=?'); a.push(f.status); }
    else if (!f.counted) c.push(`v.status<>'batch_done'`);
    if (f.kind) { c.push('v.kind=?'); a.push(f.kind); }
    if (f.category === 'none') c.push(`${cat} IS NULL`);
    else if (f.category) { c.push(`${cat} IN (SELECT id FROM categories WHERE id=? OR parent_id=?)`); a.push(f.category, f.category); }
    if (f.merchant !== undefined) { c.push(`${mer}=?`); a.push(f.merchant); }
    if (f.method !== undefined) { c.push(`${met}=?`); a.push(f.method); }
    if (f.currency) { c.push(f.currency === 'foreign' ? `v.currency<>'CNY'` : 'v.currency=?'); if (f.currency !== 'foreign') a.push(f.currency); }
    if (f.source) { c.push('v.source=?'); a.push(f.source); }
    if (f.importId) { c.push('v.import_id=?'); a.push(f.importId); }
    if (f.refundOf) { c.push('v.refund_of=?'); a.push(f.refundOf); }
    if (f.from) { c.push(`${day}>=?`); a.push(f.from); }
    if (f.to) { c.push(`${day}<=?`); a.push(f.to); }
    if (f.min !== undefined) { c.push('v.amount>=?'); a.push(f.min); }
    if (f.max !== undefined) { c.push('v.amount<=?'); a.push(f.max); }
    if (f.image) c.push(`EXISTS(SELECT 1 FROM evidence e JOIN attachments x ON x.id=e.attachment_id WHERE e.bill_id IN (v.id, v.batch_id) AND x.kind='image')`);
    if (f.soft) c.push(`v.status='ok' AND v.flags<>'[]'`);
    return { sql: c.join(' AND '), args: a };
  }
  list(f: Filter): { total: number; items: Row[]; sum: Row } {
    const w = this.where(f), size = Math.min(Math.max(f.pageSize ?? 30, 1), 100_000), page = Math.max(f.page ?? 1, 1);
    const order = f.sort === 'old' ? 'v.occurred_at ASC, v.id ASC' : f.sort === 'amount' ? 'v.amount DESC, v.id DESC' : f.sort === 'updated' ? 'v.updated_at DESC, v.id DESC' : f.sort === 'id' ? 'v.id DESC' : 'v.occurred_at DESC, v.id DESC';
    // 合计只含人民币、已入账（counted+withPending 时含待确认），与统计同口径
    const okCond = f.counted && f.withPending ? '1' : `v.status='ok'`;
    const s = this.db.get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN ${okCond} AND v.currency='CNY' AND v.kind='expense' THEN v.amount END),0) expense, COALESCE(SUM(CASE WHEN ${okCond} AND v.currency='CNY' AND v.kind='refund' THEN v.amount END),0) refund, COALESCE(SUM(CASE WHEN ${okCond} AND v.currency='CNY' AND v.kind='income' THEN v.amount END),0) income FROM v_bills v WHERE ${w.sql}`, ...w.args)!;
    const items = this.db.all(`SELECT v.*, (SELECT x.id FROM evidence e JOIN attachments x ON x.id=e.attachment_id WHERE e.bill_id IN (v.id, v.batch_id) AND x.kind='image' AND x.status='done' ORDER BY x.id LIMIT 1) thumb,
        (SELECT COUNT(*) FROM evidence e WHERE e.bill_id=v.id AND e.attachment_id IS NOT NULL) attachment_count,
        (SELECT COALESCE(SUM(r.amount),0) FROM bills r WHERE r.refund_of=v.id AND r.deleted_at IS NULL AND r.status='ok') refunded
      FROM v_bills v WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...w.args, size, (page - 1) * size).map((r) => this.view(r));
    return { total: Number(s.n), items, sum: { expense: Number(s.expense), refund: Number(s.refund), net: Number(s.expense) - Number(s.refund), income: Number(s.income) } };
  }
  /** 列解包，供接口输出 */
  view(b: Row): Row {
    const { search_text: _s, batch, flags, ids, locked, dup_ok: _d, ...x } = b;
    return { ...x, flags: JSON.parse(flags), ids: JSON.parse(ids), locked: JSON.parse(locked), category: this.categoryName(b.category_id), eff_category_name: b.eff_category === undefined ? undefined : this.categoryName(b.eff_category), batch: batch ? JSON.parse(batch) : null };
  }
  detail(id: number): Row {
    this.require(id);
    const b = this.db.get('SELECT * FROM v_bills WHERE id=?', id)!;
    const src = b.batch_id ? [id, b.batch_id] : [id];
    const evs = this.db.all(`SELECT e.*, m.text message_text, m.channel, a.kind att_kind, a.filename, a.mime, a.size, a.status att_status, a.error, a.ocr_status, a.text ocr_text, a.path FROM evidence e JOIN messages m ON m.id=e.message_id LEFT JOIN attachments a ON a.id=e.attachment_id WHERE e.bill_id IN (${src.join()}) ORDER BY e.sent_at, e.id`)
      .map(({ parsed, path, ...e }) => ({ ...e, parsed: parsed ? JSON.parse(parsed) : null, has_file: !!path }));
    const refunds = this.db.all('SELECT * FROM bills WHERE refund_of=? AND deleted_at IS NULL ORDER BY occurred_at', id).map((r) => this.view(r));
    return {
      ...this.view(b), evidence: evs, refunds, refunded: refunds.filter((r) => r.status === 'ok').reduce((n, r) => n + r.amount, 0),
      original: b.refund_of ? this.view(this.require(b.refund_of)) : null, dup: b.dup_of ? this.view(this.require(b.dup_of)) : null,
      events: this.db.all('SELECT at,actor,action,detail FROM events WHERE bill_id=? ORDER BY id DESC', id),
      changes: this.changes(id),
      review: this.latestReview(id),
      refund_candidates: b.kind === 'refund' && !b.refund_of ? this.refundCandidates(id).map((r) => this.view(r)) : [],
    };
  }
  changes(id: number, limit = 200): Row[] {
    this.require(id);
    return this.db.all('SELECT id,bill_id,at,source,actor,reason,before_version,after_version,authorization_id,fields FROM bill_changes WHERE bill_id=? ORDER BY id DESC LIMIT ?', id, Math.min(Math.max(limit, 1), 1000))
      .map((r) => ({ ...r, fields: JSON.parse(r.fields) }));
  }
  restoreChange(id: number, changeId: number, actor: string): Row {
    const b = this.require(id), c = this.db.get<any>('SELECT * FROM bill_changes WHERE id=? AND bill_id=?', changeId, id);
    if (!c) throw new UserError('修改记录不存在', 404);
    const fields = JSON.parse(c.fields) as Record<string, { before: unknown; after: unknown }>;
    const patch = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.before]));
    return this.update(id, patch, actor, false, { source: 'web', reason: `恢复修改记录 #${changeId}`, expectedVersion: Number(b.version ?? 1) });
  }
  latestReview(id: number): Row | null {
    const r = this.db.get('SELECT id,bill_id,reviewed_at,reviewer,result,note,bill_version FROM bill_reviews WHERE bill_id=? ORDER BY id DESC LIMIT 1', id);
    return r ? r : null;
  }
  review(id: number, result: 'ok' | 'question' | 'modified', note: string, reviewer: string): Row {
    if (!['ok', 'question', 'modified'].includes(result)) throw new UserError('复核结果无效');
    if (note.length > 5000) throw new UserError('复核说明过长');
    const b = this.require(id);
    const row = { billId: id, reviewedAt: this.now(), reviewer, result, note, billVersion: Number(b.version ?? 1) };
    this.db.run('INSERT INTO bill_reviews(bill_id,reviewed_at,reviewer,result,note,bill_version) VALUES(?,?,?,?,?,?)', row.billId, row.reviewedAt, row.reviewer, row.result, row.note, row.billVersion);
    this.event(id, reviewer, '复核', `${result}${note ? `：${note}` : ''}`);
    return row;
  }
  reviewQueue(f: { from?: string; to?: string; pending?: boolean; lowConfidence?: boolean; duplicate?: boolean; never?: boolean; page?: number; pageSize?: number } = {}): { total: number; page: number; pages: number; items: Row[] } {
    const c: string[] = ['b.deleted_at IS NULL', "b.status NOT IN ('batch','batch_done')", '(lr.id IS NULL OR lr.bill_version < b.version)'], a: any[] = [];
    if (f.from) { c.push('b.day>=?'); a.push(f.from); }
    if (f.to) { c.push('b.day<=?'); a.push(f.to); }
    if (f.pending) c.push("b.status='pending'");
    if (f.lowConfidence) c.push("b.flags<>'[]'");
    if (f.duplicate) c.push('b.dup_of IS NOT NULL');
    if (f.never) c.push('lr.id IS NULL');
    const where = c.join(' AND '), size = Math.min(Math.max(f.pageSize ?? 20, 1), 100), page = Math.max(f.page ?? 1, 1);
    const total = Number(this.db.get(`SELECT COUNT(*) n FROM bills b LEFT JOIN (SELECT r.* FROM bill_reviews r JOIN (SELECT bill_id,MAX(id) id FROM bill_reviews GROUP BY bill_id) x ON x.id=r.id) lr ON lr.bill_id=b.id WHERE ${where}`, ...a)!.n);
    const items = this.db.all(`SELECT b.*,lr.reviewed_at,lr.reviewer,lr.result review_result,lr.note review_note,lr.bill_version review_version FROM bills b LEFT JOIN (SELECT r.* FROM bill_reviews r JOIN (SELECT bill_id,MAX(id) id FROM bill_reviews GROUP BY bill_id) x ON x.id=r.id) lr ON lr.bill_id=b.id WHERE ${where} ORDER BY b.updated_at DESC,b.id DESC LIMIT ? OFFSET ?`, ...a, size, (page - 1) * size).map((r) => this.view(r));
    return { total, page, pages: Math.ceil(total / size), items };
  }
  counts(): Row {
    const n = (sql: string) => Number(this.db.get(`SELECT COUNT(*) n FROM bills WHERE ${sql}`)!.n);
    return { pending: n(`deleted_at IS NULL AND status='pending'`), dup: n(`deleted_at IS NULL AND status='dup'`), batch: n(`deleted_at IS NULL AND status='batch'`), soft: n(`deleted_at IS NULL AND status='ok' AND flags<>'[]'`), total: n(`deleted_at IS NULL AND status<>'batch_done'`), deleted: n('deleted_at IS NOT NULL') };
  }
}
/** 凭证可信度：支付凭证 > 短信 > 订单 > 其它 */
const rank = (r: Receipt) => ({ voucher: 0, sms: 1, order: 2, text: 3, list: 4, none: 5 })[r.doc];
/** 商户：真实店名优先于平台名，有把握优先 */
const mrank = (r: Receipt) => (isPlatformMerchant(r.merchant) ? 10 : 0) + (r.merchantSure ? 0 : 5) + rank(r);
const score = (o: Row, b: Row) => (similarName(o.merchant || o.item, b.merchant || b.item) ? 2 : 0) + (o.amount === b.amount ? 1 : 0);
