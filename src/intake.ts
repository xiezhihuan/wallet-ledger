import type { Row } from './db.js';
import { money } from './money.js';
import { parseAmount } from './parse/text.js';
import { parseSpoken } from './parse/when.js';
import type { Incoming } from './qq/message.js';
import { Stats } from './stats.js';
import { KIND, STATUS, UserError, type BatchRow, type Store } from './store.js';
import { clip } from './text.js';
import { fmtTime, hm, label, namedRange, parts, ymd } from './time.js';

export interface Outcome {
  /** 立即回复的文本 */
  reply?: string;
  /** 需要（防抖后）发送回执的素材组 */
  receipt?: string;
  /** 回执里一定要写到的账 */
  bills?: number[];
  /** 本条消息归属的账，用于引用识别 */
  billId?: number;
  hints?: string[];
}
interface Cursor { capture: string; at: number; closed: boolean; focus?: number }

export const HELP = `💰 截图账本
把付款截图发给我，或直接打字：午饭 28、打车 35.5 昨天。
连着发的几条算同一笔；金额、单号不同会自动分开。

【这一笔】
改 28.5 — 改金额
改分类 打车｜改时间 昨天 12:30
改商户 xx｜改备注 xx｜改支付 xx
改类型 退款/收入/转账/还款/支出
确认｜删除｜恢复 12
改别的加编号：改 #12 分类 打车
【分开与合并】
新建｜完成｜撤销｜拆分
并入 7 — 与 #7 是同一笔
补充 12 内容（或引用那条消息）
重复 / 不重复 — 判断疑似重复
关联 12 — 这笔是 #12 的退款
入账 全部｜入账 1 3｜忽略 — 账单列表
【查】
今天 / 本周 / 本月 / 本季度 / 今年
上月花到哪里了
待确认｜查 关键词｜详情 12｜预算｜规则`;

type Cmd = { name: string; id?: number; arg: string };
const SUB: Record<string, string> = { 金额: 'amount', 价格: 'amount', 分类: 'category', 类别: 'category', 时间: 'time', 日期: 'time', 备注: 'note', 商户: 'merchant', 商家: 'merchant', 说明: 'item', 名称: 'item', 支付: 'method', 支付方式: 'method', 付款方式: 'method', 类型: 'kind' };
const SUBS = Object.keys(SUB).sort((a, b) => b.length - a.length).join('|');
const ALIAS: Record<string, string> = { '?': '帮助', '？': '帮助', help: '帮助', 菜单: '帮助', 结束: '完成', 撤回: '撤销', undo: '撤销', 是重复: '重复', 不是重复: '不重复', 全部入账: '入账', 待处理: '待确认', 合并: '并入', 搜: '查', 搜索: '查', 查询: '查', 记一笔: '新建', 另记: '新建', 不入账: '忽略', 分类规则: '规则' };
const BARE = /^(新建|完成|结束|撤销|撤回|拆分|帮助|菜单|help|\?|？|待确认|待处理|确认|重复|是重复|不重复|不是重复|全部入账|入账|忽略|不入账|删除|预算|规则|分类规则|撤销规则|分类列表|补充)$/i;
const WITH_ID = /^(确认|删除|恢复|详情|重复|是重复|不重复|不是重复|并入|合并|忽略|关联|完成|撤销规则)\s*#?\s*(\d{1,9})(?:\s+#?(\d{1,9}))?$/;
const QUERY = /^(今天|今日|昨天|昨日|前天|[本这上]个?(?:周|星期|礼拜|月|季度?)|当月|今年|本年|去年)\s*(?:我|一共|总共|都)?\s*(?:花了?多少钱?|花到?哪(?:里|儿)?了?|花哪(?:里|儿)?了?|钱花哪(?:里|儿)?了?|花销|花费|支出|消费|统计|账单|汇总|情况)?\s*(?:了)?[?？!！。]?$/;

/** 指令必须形态明确，避免把记账文字误当指令。认不出的一律当内容记下。 */
export function parseCommand(text: string): Cmd | null {
  const t = text.trim(), n = (s: string) => ALIAS[s.toLowerCase()] ?? s;
  let m = BARE.exec(t.replace(/^[/／]/, ''));
  if (m) return { name: n(m[1]!), arg: m[1] === '全部入账' ? '全部' : '' };
  if ((m = WITH_ID.exec(t.replace(/^[/／]/, '')))) {
    const name = n(m[1]!);
    if (name === '并入' || name === '关联') return m[3] ? { name, id: +m[2]!, arg: m[3] } : { name, arg: m[2]! };
    if (!m[3]) return { name, id: +m[2]!, arg: '' };
  }
  if (QUERY.test(t)) return { name: '统计', arg: QUERY.exec(t)![1]! };
  if ((m = /^(?:新建|记一笔|另记)\s*[:：\s]\s*(\S[\s\S]*)$/.exec(t))) return { name: '新建', arg: m[1]!.trim() };
  if ((m = /^[/／]?\s*补充\s*#?(\d{1,9})(?:\s+|[:：]\s*|$)([\s\S]*)$/.exec(t))) return { name: '补充', id: +m[1]!, arg: m[2]!.trim() };
  if ((m = /^[/／]?\s*入账\s*(?:#(\d{1,9})\s*)?((?:全部|[\d\s,，、\-~到至]+)?)$/.exec(t))) return { name: '入账', id: m[1] ? +m[1] : undefined, arg: m[2]!.trim() };
  if ((m = new RegExp(`^(?:改|修改)\\s*(?:#(\\d{1,9})\\s*)?(${SUBS})\\s*(?:[:：为成到]|\\s)*\\s*([\\s\\S]+)$`).exec(t))) return { name: '改' + SUB[m[2]!]!, id: m[1] ? +m[1] : undefined, arg: m[3]!.trim() };
  if ((m = /^(?:改|改成|改为|修改)\s*(?:#(\d{1,9})\s+)?([¥￥]?\s*[\d零一二两三四五六七八九十百千][\d.,，零一二两三四五六七八九十百千块元毛角半钱]*)$/.exec(t))) return { name: '改amount', id: m[1] ? +m[1] : undefined, arg: m[2]! };
  if ((m = new RegExp(`^[/／]\\s*(${SUBS})\\s*(?:#(\\d{1,9})\\s*)?[:：\\s]*([\\s\\S]+)$`).exec(t))) return { name: '改' + SUB[m[1]!]!, id: m[2] ? +m[2] : undefined, arg: m[3]!.trim() };
  if ((m = /^(?:备注|说明)\s*[:：]\s*([\s\S]+)$/.exec(t))) return { name: t.startsWith('备注') ? '改note' : '改item', arg: m[1]!.trim() };
  if ((m = /^(?:[/／]\s*(?:查|搜索?|查询)\s*|(?:查|搜)\s+)([\s\S]+)$/.exec(t))) return { name: '查', arg: m[1]!.trim() };
  return null;
}
const READ_ONLY = new Set(['帮助', '撤销', '拆分', '待确认', '统计', '查', '详情', '预算', '规则', '分类列表', '重复', '不重复', '入账', '忽略', '确认', '恢复', '并入', '关联', '撤销规则', '删除']);

/** 收录核心：把一条 QQ 消息变成「新账 / 追加 / 指令」。全程同步，返回前已落库。 */
export class Intake {
  private bindFails = new Map<string, number[]>();
  readonly stats: Stats;
  constructor(readonly store: Store, private o: { mergeWindowMs: number; now?: () => number }) { this.stats = new Stats(store); }

  private get db() { return this.store.db; }
  private now() { return (this.o.now ?? Date.now)(); }
  get mergeWindowMs(): number { const v = Number(this.store.setting('merge_window_min', '')); return this.store.setting('merge_window_min') !== '' && Number.isFinite(v) ? v * 60_000 : this.o.mergeWindowMs; }
  private cursor(openid: string): Cursor | null { return JSON.parse(this.db.kvGet(`cur:${openid}`) ?? 'null') as Cursor | null; }
  private setCursor(openid: string, c: Cursor): void { this.db.kvSet(`cur:${openid}`, JSON.stringify(c)); }
  /** 当前这一笔：最近一份素材所在的账 */
  private current(c: Cursor | null): number | null {
    if (!c) return null;
    if (c.focus) { const b = this.db.get('SELECT id FROM bills WHERE id=? AND deleted_at IS NULL', c.focus); if (b) return b.id; }
    return this.db.get(`SELECT b.id FROM evidence e JOIN bills b ON b.id=e.bill_id WHERE b.capture=? AND b.deleted_at IS NULL ORDER BY e.sent_at DESC, e.id DESC LIMIT 1`, c.capture)?.id ?? null;
  }
  private addRef(ref: string, id: number): void { if (ref) this.db.run('INSERT INTO qq_refs(ref,bill_id,created_at) VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET bill_id=excluded.bill_id', ref, id, this.now()); }
  /** 机器人回执的 ref_idx，供用户引用回执来补充。 */
  rememberRef(ref: string, id: number): void { this.addRef(ref, id); }
  isBound(openid: string): boolean { return !!this.db.get('SELECT 1 FROM qq_users WHERE openid=?', openid); }

  handle(m: Incoming): Outcome {
    if (!this.isBound(m.openid)) return this.bind(m);
    return this.db.tx(() => {
      if (this.store.seen(m.dedupeKey)) return {};
      if (m.nickname) this.db.run('UPDATE qq_users SET nickname=? WHERE openid=?', m.nickname, m.openid);
      const quoted = m.refIdx ? this.refTarget(m.refIdx) : undefined;
      let cmd = parseCommand(m.text);
      // 记账途中单发一个「昨天」：是给当前这一笔改日期，不是查询
      if (cmd?.name === '统计' && /^(昨天|昨日|前天)$/.test(m.text.trim()) && this.inWindow(m)) cmd = null;
      if (cmd) {
        const out = this.command(m, cmd, quoted);
        if (out) {
          this.store.markCommand(m.dedupeKey, m.openid, m.text, m.sentAt);
          if (out.billId && m.msgIdx) this.addRef(m.msgIdx, out.billId);
          return out;
        }
      }
      return this.record(m, quoted);
    });
  }
  private refTarget(ref: string): number | undefined {
    return this.db.get('SELECT r.bill_id id FROM qq_refs r JOIN bills b ON b.id=r.bill_id WHERE r.ref=? AND b.deleted_at IS NULL', ref)?.id;
  }

  private inWindow(m: Incoming): boolean { const c = this.cursor(m.openid); return !!c && !c.closed && Math.abs(m.sentAt - c.at) <= this.mergeWindowMs; }
  /** @param target 明确指定的账；'new' 强制新建；undefined 按合并窗口判断 */
  private record(m: Incoming, target: number | 'new' | undefined, text = m.text, dedupe = true): Outcome {
    const c = this.cursor(m.openid), inWindow = target !== 'new' && this.inWindow(m);
    if (typeof target === 'number' && this.store.require(target).status.startsWith('batch')) target = undefined;
    // 明确指定的账用自己的素材组，后续消息接着进同一笔
    const capture = typeof target === 'number' ? this.store.require(target).capture || `b${target}` : inWindow ? c!.capture : `${m.openid}:${m.sentAt}:${m.msgIdx || m.msgId}`;
    let body = text;
    const atts = [...m.attachments], quote = typeof target !== 'number'; // 引用了没收录过的消息：连同原文一起记
    if (quote && m.quoted) body = [m.quoted, body].filter(Boolean).join('\n');
    if (quote) atts.push(...m.quotedAttachments);
    const empty = !body && !atts.length;
    if (empty) body = '（收到一条平台未下发内容的消息，可能是合并转发的聊天记录，请改发截图或文字）';
    const before = typeof target === 'number' ? target : inWindow ? this.current(c) : null;
    const r = this.store.addMessage({ channel: 'qq', dedupeKey: dedupe ? m.dedupeKey : undefined, author: m.openid, text: body, raw: m.raw, sentAt: m.sentAt, attachments: atts }, capture, before, target);
    if (m.msgIdx) this.addRef(m.msgIdx, r.bill);
    this.setCursor(m.openid, { capture, at: m.sentAt, closed: false, ...(typeof target === 'number' ? { focus: target } : {}) });
    return { receipt: capture, billId: r.bill, bills: typeof target === 'number' ? [target] : [r.bill], hints: r.hints, reply: empty ? `⚠️ #${r.bill}：QQ 没有把这条消息的内容发给我。请改发截图或文字。` : undefined };
  }

  private bind(m: Incoming): Outcome {
    const t = this.now(), fails = (this.bindFails.get(m.openid) ?? []).filter((x) => t - x < 10 * 60_000);
    const arg = /^[/／]?\s*绑定\s*(\d{6,10})$/.exec(m.text)?.[1];
    if (!arg) return { reply: '🔒 你还没有权限使用。请在网页「设置 → QQ」生成绑定码，然后发送：绑定 12345678\n（未绑定前发送的内容不会被记录）' };
    if (fails.length >= 5) return { reply: '尝试次数过多，请 10 分钟后再试。' };
    const saved = JSON.parse(this.db.kvGet('bind_code') ?? 'null') as { code: string; exp: number } | null;
    if (!saved || saved.exp < t || saved.code !== arg) {
      if (this.bindFails.size > 5000) this.bindFails.clear();
      this.bindFails.set(m.openid, [...fails, t]);
      return { reply: '绑定码不正确或已过期，请在网页重新生成。' };
    }
    this.db.tx(() => {
      this.db.kvDel('bind_code'); // 一次性
      this.db.run('INSERT OR REPLACE INTO qq_users(openid,nickname,bound_at) VALUES(?,?,?)', m.openid, m.nickname, t);
      this.store.markCommand(m.dedupeKey, m.openid, '绑定', m.sentAt);
    });
    return { reply: `✅ 绑定成功！\n\n${HELP}` };
  }

  private command(m: Incoming, c: Cmd, quoted: number | undefined): Outcome | null {
    // 查询类指令夹带了附件：整条按内容收录，宁可多记不可丢
    if (m.attachments.length && READ_ONLY.has(c.name)) return null;
    try { return this.exec(m, c, quoted); } catch (e) {
      if (e instanceof UserError && m.attachments.length) return null;
      if (e instanceof UserError) return { reply: `⚠️ ${e.message}` };
      throw e;
    }
  }

  private exec(m: Incoming, c: Cmd, quoted: number | undefined): Outcome | null {
    const cur = this.cursor(m.openid), curId = this.current(cur);
    const close = () => cur && this.setCursor(m.openid, { ...cur, closed: true });
    const live = (id: number): Row => { const b = this.store.require(id); if (b.deleted_at) throw new UserError(`#${id} 已删除，发「恢复 ${id}」可找回`); return b; };
    const target = (): number => { const id = c.id ?? quoted ?? curId; if (!id) throw new UserError('没有当前这一笔，请加编号，例如：改 #12 28.5'); live(id); return id; };
    /** 没写编号时：当前这一笔符合就用它，否则取最近一笔符合的 */
    const pick = (status: string, what: string): number => {
      const id = c.id ?? quoted;
      if (id) { live(id); return id; }
      if (curId && this.store.require(curId).status === status) return curId;
      const b = this.db.get(`SELECT id FROM bills WHERE status=? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, status);
      if (!b) throw new UserError(what);
      return b.id;
    };
    // 指令消息里夹带的图片不能丢
    const keep = (id: number) => { if (m.attachments.length) this.record(m, id, '', false); };
    const upd = (id: number, patch: Row): Outcome => {
      keep(id);
      const r = this.store.update(id, patch, m.openid);
      const tail = r.rule ? `\n🧠 以后「${clip(r.rule.pattern, 16)}」都归到 ${r.rule.category}（撤销发「撤销规则 ${r.rule.id}」）` : '';
      return { reply: `✏️ 已改\n${this.brief(id)}${tail}`, billId: id };
    };

    switch (c.name) {
      case '帮助': return { reply: HELP };
      case '新建': {
        if (c.arg || m.attachments.length) return this.record(m, 'new', c.arg, false);
        close();
        return { reply: '🆕 好的，接下来发的记为新的一笔。' };
      }
      case '完成': {
        const id = c.id ?? curId;
        if (!cur || !id || cur.closed) return { reply: '当前没有正在记的账。' };
        keep(id); close();
        return { reply: `✅ 这一笔记完了。\n${this.brief(id)}`, billId: id };
      }
      case '撤销': {
        if (!cur) return { reply: '没有可撤销的内容。' };
        const r = this.store.undoLast(cur.capture, m.openid);
        if (!r) return { reply: '没有可撤销的内容。' };
        this.store.takeDirty(cur.capture);
        return { reply: `↩️ 已撤销：${clip(r.text || '（截图/附件）', 30)}${r.removed.length ? `\n${r.removed.map((x) => '#' + x).join('、')} 已无内容，一并删除（发「恢复 ${r.removed[0]}」可找回）。` : ''}${r.bills.filter((b) => !r.removed.includes(b)).map((b) => '\n' + this.brief(b)).join('')}` };
      }
      case '拆分': {
        if (!curId) return { reply: '没有可拆分的内容。' };
        const ev = this.store.lastEvidence(curId, m.openid);
        if (!ev) return { reply: `#${curId} 里没有可拆分的素材。` };
        const id = this.store.moveEvidence(ev, null, m.openid);
        this.setCursor(m.openid, { ...cur!, at: m.sentAt, closed: false, focus: undefined });
        this.store.takeDirty(cur!.capture);
        return { reply: `✂️ 已拆成两笔\n${this.brief(curId)}\n${this.brief(id)}`, billId: id };
      }
      case '补充': {
        const id = c.id ?? quoted;
        if (!id) return { reply: '请写编号，例如：补充 12 和同事聚餐' };
        live(id);
        if (!c.arg && !m.attachments.length) { const b = this.store.require(id); this.setCursor(m.openid, { capture: b.capture || `b${id}`, at: m.sentAt, closed: false, focus: id }); return { reply: `好的，接下来发的会补充到 #${id}。`, billId: id }; }
        return this.record(m, id, c.arg, false);
      }
      case '改amount': {
        const a = parseAmount(c.arg);
        if (!a) throw new UserError('金额看不懂，例如：改 28.5');
        const id = target();
        return upd(id, { amount: a.cents, ...(a.currency !== 'CNY' ? { currency: a.currency } : {}) });
      }
      case '改category': {
        const id = target(), b = this.store.require(id), cat = this.store.matchCategory(c.arg, b.kind === 'income' ? 'income' : 'expense');
        if (!cat) throw new UserError(`没有「${clip(c.arg, 12)}」这个分类。发「分类列表」看有哪些，或到网页新增。`);
        return upd(id, { category_id: cat.id });
      }
      case '改time': {
        const id = target(), w = parseSpoken(c.arg, m.sentAt);
        if (!w) throw new UserError('时间看不懂，例如：改时间 昨天 12:30、改时间 11月3日');
        return upd(id, { occurred_at: w.ms });
      }
      case '改kind': {
        const k = Object.entries(KIND).find(([a, b]) => a === c.arg || b === c.arg || (a === 'repay' && /还/.test(c.arg)))?.[0];
        if (!k) throw new UserError(`类型可选：${Object.values(KIND).join('、')}`);
        return upd(target(), { kind: k });
      }
      case '改note': case '改merchant': case '改item': case '改method': return upd(target(), { [c.name.slice(1)]: c.arg });
      case '删除': { const id = target(); this.store.remove(id, m.openid); return { reply: `🗑 #${id} 已删除，发「恢复 ${id}」可找回。`, billId: id }; }
      case '恢复': { const id = c.id!; this.store.restore(id, m.openid); return { reply: `♻️ 已恢复\n${this.brief(id)}`, billId: id }; }
      case '确认': {
        const id0 = c.id ?? quoted ?? (curId && ['pending', 'batch'].includes(this.store.require(curId).status) ? curId : undefined);
        const id = id0 ?? pick('pending', '没有待确认的账。');
        if (live(id).status === 'batch') return this.commit(id, null, m.openid);
        this.store.confirm(id, m.openid);
        return { reply: `✅ 已确认入账\n${this.brief(id)}`, billId: id };
      }
      case '重复': case '不重复': {
        const id = pick('dup', '没有疑似重复的账。');
        const same = c.name === '重复', to = this.store.resolveDup(id, same, m.openid);
        return { reply: same ? `🔗 好的，#${id} 与 #${to} 是同一笔，只算一次（素材已并入 #${to}）。` : `✅ 好的，是两笔，都计入。\n${this.brief(id)}`, billId: to };
      }
      case '入账': { const id = pick('batch', '没有待入账的账单列表。'); return this.commit(id, !c.arg || c.arg === '全部' ? null : nums(c.arg), m.openid, !c.arg); }
      case '忽略': { const id = pick('batch', '没有待入账的账单列表。'); this.store.closeBatch(id, m.openid); return { reply: `好的，列表 #${id} 剩下的不入账。` }; }
      case '并入': {
        const a = c.id ?? quoted ?? curId, b = Number(c.arg);
        if (!a) throw new UserError('没有当前这一笔，请写两个编号，例如：并入 12 7');
        this.store.merge(a, b, m.openid);
        const t = this.store.require(b);
        this.setCursor(m.openid, { capture: t.capture || `b${b}`, at: m.sentAt, closed: false, focus: b });
        return { reply: `🔗 #${a} 已并入 #${b}\n${this.brief(b)}`, billId: b };
      }
      case '关联': {
        const a = c.id ?? quoted ?? curId, o = Number(c.arg);
        if (!a) throw new UserError('没有当前这一笔，请写两个编号，例如：关联 30 12');
        live(a); live(o);
        return upd(a, { ...(this.store.require(a).kind === 'refund' ? {} : { kind: 'refund' }), refund_of: o });
      }
      case '待确认': return { reply: this.todo() };
      case '查': {
        const r = this.store.list({ q: c.arg, pageSize: 8 });
        return { reply: r.total ? `🔍 「${clip(c.arg, 16)}」共 ${r.total} 笔，净消费 ${money(r.sum.net)}${r.total > 8 ? '，最近 8 笔' : ''}\n${r.items.map((i) => this.line(i)).join('\n')}` : `🔍 没有找到「${clip(c.arg, 16)}」` };
      }
      case '详情': { const id = c.id!; live(id); return { reply: this.full(id), billId: id }; }
      case '统计': return { reply: this.summary(c.arg) };
      case '预算': { const t = ymd(this.now()), b = this.stats.budget(t, t); return { reply: b.length ? `🎯 ${b[0]!.month} 预算\n${b.map((x) => this.budgetLine(x)).join('\n')}` : '还没有设预算，可在网页「设置」里设置。' }; }
      case '规则': { const r = this.store.rules(); return { reply: r.length ? `🧠 归类规则 ${r.length} 条\n${r.slice(0, 15).map((x) => `${x.id}. ${x.match === 'contains' ? '含' : ''}「${clip(x.pattern, 14)}」→ ${x.category}`).join('\n')}${r.length > 15 ? '\n…其余到网页看' : ''}\n撤销发「撤销规则 编号」` : '还没有规则。改一次分类，我就会记住那个商户。' }; }
      case '撤销规则': {
        const r = c.id ? this.store.rules().find((x) => x.id === c.id) : this.store.rules()[0];
        if (!r) throw new UserError('没有这条规则');
        this.store.deleteRule(r.id);
        return { reply: `已撤销规则「${r.pattern}」→ ${r.category}。已记的账不变，以后重新按关键词归类。` };
      }
      case '分类列表': { const cs = this.store.categories(); return { reply: cs.filter((x) => !x.parent_id).map((p) => `${p.name}：${cs.filter((x) => x.parent_id === p.id).map((x) => x.name).join('、') || '—'}`).join('\n') }; }
    }
    return null;
  }

  private commit(id: number, pickRows: number[] | null, actor: string, ask = false): Outcome {
    if (ask) return { reply: this.batchText(id) + '\n请说明：入账 全部，或 入账 1 3', billId: id };
    const r = this.store.commitBatch(id, pickRows, actor);
    for (const x of r.created) this.store.takeDirty(this.store.require(x).capture);
    const bs = r.created.map((x) => this.store.require(x)), pend = bs.filter((b) => b.status !== 'ok');
    const sum = bs.filter((b) => b.status === 'ok' && b.currency === 'CNY').reduce((n, b) => n + (b.kind === 'expense' ? b.amount : b.kind === 'refund' ? -b.amount : 0), 0);
    return {
      reply: [`✅ 入账 ${r.created.length} 笔，净消费 ${money(sum)}`, ...bs.slice(0, 12).map((b) => this.line(this.store.view(b))), bs.length > 12 ? '…' : '', pend.length ? `❓ 其中 ${pend.length} 笔待确认，暂不计入` : '',
        r.skipped.length ? `⏭ 没入账：\n${r.skipped.map((s) => `第 ${s.n} 行 ${s.why}`).join('\n')}\n仍要入账发「入账 #${id} ${r.skipped.map((s) => s.n).join(' ')}」，不要了发「忽略 ${id}」` : ''].filter(Boolean).join('\n'), billId: id,
    };
  }

  // ───────── 文案 ─────────
  private when(b: Row): string {
    const y = parts(this.now()).y, d = String(b.day), t = b.time_src === 'day' ? '' : ' ' + hm(b.occurred_at);
    return `${d.startsWith(String(y)) ? d.slice(5) : d}${t}`;
  }
  private title(b: Row): string { return clip(b.merchant || b.item || (b.kind === 'transfer' ? '转账' : b.kind === 'repay' ? '还款' : '未知商户'), 24); }
  private line(b: Row): string { return `#${b.id} ${this.when(b)} ${this.title(b)} ${b.kind === 'refund' || b.kind === 'income' ? '+' : ''}${money(b.amount, b.currency)}${b.kind === 'expense' ? '' : `（${KIND[b.kind as keyof typeof KIND]}）`}${b.status === 'ok' ? '' : `［${STATUS[b.status]}］`}`; }
  private brief(id: number): string {
    const b = this.store.require(id);
    if (b.status.startsWith('batch')) return this.batchText(id);
    const mark = b.status === 'ok' ? '✅' : '❓';
    return `${mark} #${id} ${KIND[b.kind as keyof typeof KIND]} ${money(b.amount, b.currency)}｜${this.title(b)}｜${this.when(b)}${b.kind === 'expense' || b.kind === 'income' ? `｜${this.store.categoryName(b.category_id)}` : ''}${b.method ? `｜${clip(b.method, 16)}` : ''}${b.note ? `\n备注：${clip(b.note, 40)}` : ''}${b.status === 'dup' ? `\n⚠️ 疑似与 #${b.dup_of} 重复，暂不计入。同一笔发「重复」，两笔发「不重复」` : b.status === 'pending' ? `\n待确认：${this.reasons(b, true)}（暂不计入统计）` : ''}`;
  }
  private reasons(b: Row, hardOnly = false): string {
    const f = (typeof b.flags === 'string' ? JSON.parse(b.flags) : b.flags) as { field: string; hard: boolean; reason: string; candidates?: number[] }[];
    return f.filter((x) => !hardOnly || x.hard).map((x) => x.reason + ((x.candidates?.length ?? 0) > 1 ? `（${[...new Set(x.candidates)].map((c) => money(c)).join(' / ')}）` : '')).join('；');
  }
  private batchText(id: number): string {
    const rows = this.store.view(this.store.require(id)).batch as BatchRow[], cnt = rows.filter((r) => !r.done).length;
    const l = rows.slice(0, 30).map((r, i) => `${i + 1}. ${r.ms === null ? '' : ymd(r.ms).slice(5) + (r.precise ? ' ' + hm(r.ms) : '') + ' '}${clip(r.merchant || '—', 14)} ${r.kind === 'income' || r.kind === 'refund' ? '+' : ''}${money(r.amount, r.currency)}${r.kind === 'expense' ? '' : KIND[r.kind]}${r.done ? ` ✓#${r.done}` : r.dup ? ` ⚠️疑似 #${r.dup.id}` : r.skip ? ' ⏭未成交' : r.sure ? '' : ' ❓'}`);
    return `🧾 #${id} 这张是账单列表，${rows.length} 笔${cnt < rows.length ? `（剩 ${cnt}）` : ''}，还没入账：\n${l.join('\n')}${rows.length > 30 ? '\n…其余到网页看' : ''}`;
  }
  private budgetLine(x: Row): string { return `${x.state === 'over' ? '🔴' : x.state === 'near' ? '🟠' : '🟢'} ${x.name} ${money(x.used)} / ${money(x.amount)}（${x.percent}%）${x.state === 'over' ? `，超支 ${money(-x.left)}` : ''}`; }
  /** 这笔入账后触到的预算提示 */
  private budgetNote(b: Row): string {
    if (b.kind !== 'expense' || b.status !== 'ok' || b.currency !== 'CNY') return '';
    const cat = this.store.categories().find((c) => c.id === b.category_id), top = cat?.parent_id ?? cat?.id;
    return this.stats.budget(b.day, ymd(this.now())).filter((x) => x.state !== 'ok' && (x.category_id === 0 || x.category_id === top)).map((x) => this.budgetLine(x)).join('\n');
  }
  private one(id: number): string {
    const b = this.store.require(id);
    if (b.status === 'batch') return `${this.batchText(id)}\n全部入账发「入账 全部」，挑几笔发「入账 1 3」，都不要发「忽略」`;
    const head = b.status === 'ok' ? `✅ 已记 #${id}` : b.status === 'dup' ? `⚠️ #${id} 疑似与 #${b.dup_of} 重复（${b.dup_why}），暂不计入` : `❓ #${id} 待确认，暂不计入统计`;
    const soft = this.reasons(b), dup = b.dup_of ? this.db.get('SELECT * FROM bills WHERE id=?', b.dup_of) : undefined;
    const cand = b.kind === 'refund' && !b.refund_of ? this.store.refundCandidates(id, 3) : [];
    return [head,
      `${KIND[b.kind as keyof typeof KIND]}：${b.kind === 'transfer' || b.kind === 'repay' ? `${money(b.amount, b.currency)}（不算消费）` : money(b.amount, b.currency)}`,
      `商户：${b.merchant || '未提供'}`, b.item && b.item !== b.merchant ? `说明：${clip(b.item, 40)}` : '', `时间：${this.when(b)}${b.time_src === 'sent' ? '（发送时间）' : ''}`,
      b.kind === 'expense' || b.kind === 'income' ? `分类：${this.store.categoryName(b.category_id)}` : b.kind === 'refund' ? (b.refund_of ? `原支出：#${b.refund_of}（冲减它的分类）` : `分类：${this.store.categoryName(b.category_id)}`) : '',
      `支付：${b.method || '未提供'}`, b.note ? `备注：${clip(b.note, 60)}` : '', b.currency !== 'CNY' ? `外币，单独统计，不与人民币相加` : '',
      soft ? `${b.status === 'ok' ? '🔎 没把握：' : '❗'}${soft}` : '',
      dup ? `原来那笔：${this.line(this.store.view(dup))}\n同一笔发「重复」，是两笔发「不重复」` : '',
      cand.length ? `可能是这笔的退款：\n${cand.map((x) => this.line(this.store.view(x))).join('\n')}\n关联发「关联 ${cand[0]!.id}」` : '',
      b.status === 'pending' ? (b.amount === null ? `补金额发「改 28.5」` : `金额对就发「确认」，不对发「改 28.5」`) : '',
      this.budgetNote(b)].filter(Boolean).join('\n');
  }

  /** 收录回执。ids 为这次涉及的账。 */
  receipt(ids: number[], hints: string[] = []): string {
    const bs = ids.filter((i) => { const b = this.store.require(i); return !b.deleted_at && b.status !== 'batch_done'; });
    if (!bs.length) return '';
    const wait = bs.some((i) => (this.store.detail(i).evidence as Row[]).some((e) => e.att_kind === 'image' && !e.parsed));
    const bad = bs.flatMap((i) => this.store.detail(i).evidence as Row[]).filter((e) => e.att_status === 'failed').length;
    const body = bs.length === 1 ? [this.one(bs[0]!)] : [`这次有 ${bs.length} 笔（金额、单号或商户不同，已分开）：`, ...bs.map((i) => this.one(i)), `其中两笔其实是同一笔的话，发「并入 ${bs[1]} ${bs[0]}」`];
    const id = bs[0]!, single = bs.length === 1 && !this.store.require(id).status.startsWith('batch');
    return [...body, ...hints.map((h) => `ℹ️ ${h}`), wait ? '⏳ 截图还在识别，好了会再告诉你' : '', bad ? `⚠️ ${bad} 个附件没能保存，请重发` : '',
      single ? `改：改 28.5｜改分类 xx｜改时间 xx｜改备注 xx｜删除` : bs.length > 1 ? `改：改 #${id} 28.5｜改 #${id} 分类 xx｜删除 ${id}` : ''].filter(Boolean).join('\n');
  }
  private full(id: number): string {
    const d = this.store.detail(id);
    const texts = (d.evidence as Row[]).map((e) => (e.attachment_id ? (e.ocr_text ? `[截图] ${clip(e.ocr_text, 200)}` : `[${e.att_kind === 'image' ? '截图' : '附件'}]`) : e.text)).filter(Boolean);
    return clip([this.one(id), d.refunded ? `已退 ${money(d.refunded)}，净 ${money(d.amount - d.refunded)}` : '', texts.length ? `—— 素材 ——\n${[...new Set(texts)].join('\n')}` : '', `—— 记录 ——\n${(d.events as Row[]).slice(0, 5).map((e) => `${fmtTime(e.at).slice(5)} ${e.action} ${clip(e.detail, 40)}`).join('\n')}`].filter(Boolean).join('\n'), 1500);
  }
  private todo(): string {
    const c = this.store.counts(), r = this.store.list({ status: 'todo', pageSize: 10, sort: 'id' });
    if (!r.total) return `🎉 没有待确认的账。${c.soft ? `（另有 ${c.soft} 笔个别信息没把握，已计入统计，可到网页看）` : ''}`;
    return `❓ 待处理 ${r.total} 笔（待确认 ${c.pending}、疑似重复 ${c.dup}、列表 ${c.batch}），都没计入统计\n${r.items.map((i) => (i.status === 'batch' ? `#${i.id} 账单列表 ${(i.batch as BatchRow[]).filter((x) => !x.done).length} 笔` : this.line(i))).join('\n')}\n确认 12｜改 #12 28.5｜重复 12｜不重复 12`;
  }
  private summary(name: string): string {
    const today = ymd(this.now()), r = namedRange(name, today);
    if (!r) throw new UserError('看不懂这个时间段');
    const s = this.stats.report(r, today), ex = s.excluded;
    const cmp = (c: Row, t: string) => (c.percent === null ? '' : `${t} ${c.diff >= 0 ? '多' : '少'} ${money(Math.abs(c.diff))}（${c.percent > 0 ? '+' : ''}${c.percent}%）`);
    return [`📊 ${name}（${label(r)}）`, `净消费 ${money(s.net)}，${s.count} 笔${s.refund ? `（支出 ${money(s.expense)} − 退款 ${money(s.refund)}）` : ''}`, s.days > 1 ? `日均 ${money(s.daily)}${s.running ? `（已过 ${s.elapsed} 天）` : ''}` : '',
      ...(s.by_category as Row[]).slice(0, 8).map((c) => `· ${c.name} ${money(c.net)}（${c.share}%）`),
      (s.by_merchant.rows as Row[]).filter((x) => x.name).length ? `花得多的：${(s.by_merchant.rows as Row[]).filter((x) => x.name).slice(0, 3).map((x) => `${clip(x.name, 10)} ${money(x.net)}`).join('、')}` : '',
      [cmp(s.prev, s.running && s.days > 1 ? '比上期同进度' : '比上一期'), cmp(s.yoy, '比去年同期')].filter(Boolean).join('；'),
      ex.pending.count || ex.dup.count || ex.batch ? `⚠️ 未计入：待确认 ${ex.pending.count} 笔${ex.pending.amount ? `（约 ${money(ex.pending.amount)}）` : ''}${ex.dup.count ? `、疑似重复 ${ex.dup.count} 笔` : ''}${ex.batch ? `、列表 ${ex.batch} 张` : ''}` : '',
      ex.foreign.length ? `外币另计：${ex.foreign.map((f: Row) => money(f.amount, f.currency)).join('、')}` : '',
      s.cross_refund.refunded_later.count ? `含后来的退款 ${money(s.cross_refund.refunded_later.amount)}` : s.cross_refund.received_for_earlier.count && s.basis === 'refund' ? `其中退款 ${money(s.cross_refund.received_for_earlier.amount)} 来自更早的支出` : ''].filter(Boolean).join('\n');
  }
}
/** 「1 3 5-7」→ [1,3,5,6,7] */
function nums(s: string): number[] {
  const out = new Set<number>();
  for (const p of s.split(/[\s,，、]+/).filter(Boolean)) {
    const m = /^(\d{1,3})(?:[-~到至](\d{1,3}))?$/.exec(p);
    if (!m) throw new UserError('看不懂要入哪几行，例如：入账 1 3 5-7');
    for (let i = +m[1]!; i <= +(m[2] ?? m[1]!) && out.size < 500; i++) out.add(i);
  }
  if (!out.size) throw new UserError('请写行号，例如：入账 1 3');
  return [...out];
}
