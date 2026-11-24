import { HELP, type Intake } from '../intake.js';
import { logger } from '../log.js';
import type { Media } from '../media.js';
import type { Store } from '../store.js';
import type { QQApi } from './api.js';
import { Gateway, type Payload, type Session } from './gateway.js';
import { parseC2C, sanitizeReply } from './message.js';

const log = logger('qq-bot');
const SETTLE_MS = 12_000;

/** 把网关、收录逻辑、回执串起来。 */
export class Bot {
  readonly gateway: Gateway;
  private seq = new Map<string, number>();
  private pending = new Map<string, { openid: string; msgId: string; bills: Set<number>; hints: string[]; timer: NodeJS.Timeout }>();
  /** 已发过回执的素材组：识别晚到时再补一条 */
  private sent = new Map<string, { openid: string; msgId: string; at: number; n: number }>();
  private told = new Map<number, string>();
  private inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private o: { appId: string; api: QQApi; store: Store; intake: Intake; media: Media; dataDir: string; receiptDelayMs: number; backoff?: number[] }) {
    const db = o.store.db, key = `qq_session:${o.appId}`;
    this.gateway = new Gateway({
      getToken: () => o.api.getToken(), invalidateToken: () => o.api.invalidateToken(), getUrl: () => o.api.gatewayUrl(),
      loadSession: () => JSON.parse(db.kvGet(key) ?? 'null') as Session | null,
      saveSession: (s) => (s ? db.kvSet(key, JSON.stringify(s)) : db.kvDel(key)),
      onDispatch: (p) => this.onDispatch(p),
      onState: (s, r) => log.info(`状态：${s}${r ? ` ${r}` : ''}`),
      backoff: o.backoff,
    });
    o.media.onDone.push((bills) => this.late(bills));
  }

  start(): void {
    this.stopped = false;
    // 上次没来得及发的回执；超过被动回复时限的只记录不发
    const due = this.o.store.db.all('SELECT * FROM receipts_due');
    for (const d of due) {
      if (Date.now() - d.at > 55 * 60_000) { this.o.store.db.run('DELETE FROM receipts_due WHERE capture=?', d.capture); continue; }
      const bills = this.o.store.db.all('SELECT id FROM bills WHERE capture=? AND deleted_at IS NULL', d.capture).map((r) => r.id as number);
      this.schedule(d.openid, d.capture, d.msg_id, bills, []);
    }
    this.gateway.start();
  }
  /** 停机：没发的回执留在库里，下次启动补发。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.gateway.stop();
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, 5000))]);
  }

  private onDispatch(p: Payload): void {
    if (p.t === 'C2C_MESSAGE_CREATE') {
      const m = parseC2C(p.d);
      const { openid, msgId } = m;
      // A failed write must propagate to the gateway so it retains its replay cursor.
      const out = this.o.store.db.tx(() => {
        const r = this.o.intake.handle(m);
        if (r.receipt !== undefined) this.o.store.db.run('INSERT INTO receipts_due(capture,openid,msg_id,at) VALUES(?,?,?,?) ON CONFLICT(capture) DO UPDATE SET openid=excluded.openid,msg_id=excluded.msg_id,at=excluded.at', r.receipt, openid, msgId, Date.now());
        return r;
      });
      if (out.receipt !== undefined) { this.schedule(openid, out.receipt, msgId, out.bills ?? [], out.hints ?? []); this.o.media.kick(); }
      if (out.reply) {
        if (out.receipt === undefined) for (const c of [...this.pending]) if (c[1].openid === openid) this.flush(c[0]); // 指令前先把攒着的回执发出，顺序不乱
        this.reply(openid, msgId, out.reply, out.billId);
        this.o.media.kick();
      }
    } else if (p.t === 'FRIEND_ADD') {
      const openid = p.d?.openid;
      if (openid && p.id) this.track(this.send(openid, { eventId: p.id }, this.o.intake.isBound(openid) ? HELP : '👋 你好，我是截图账本。请先在网页「设置 → QQ」生成绑定码，然后发送：绑定 12345678'));
    }
  }

  private schedule(openid: string, capture: string, msgId: string, bills: number[], hints: string[]): void {
    for (const [c, p] of [...this.pending]) if (p.openid === openid && c !== capture) this.flush(c);
    const cur = this.pending.get(capture);
    if (cur) clearTimeout(cur.timer);
    this.pending.set(capture, { openid, msgId, bills: new Set([...(cur?.bills ?? []), ...bills]), hints: [...(cur?.hints ?? []), ...hints], timer: setTimeout(() => this.flush(capture), this.o.receiptDelayMs) });
  }
  private flush(capture: string): void {
    const p = this.pending.get(capture);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(capture);
    this.track((async () => {
      await this.o.media.settle(capture, SETTLE_MS);
      if (this.stopped) return;
      if (this.pending.has(capture)) { const n = this.pending.get(capture)!; for (const b of p.bills) n.bills.add(b); n.hints.unshift(...p.hints); return; } // 等待期间又来了新消息，合在一起发
      const ids = this.live([...new Set([...p.bills, ...this.o.store.takeDirty(capture)])]);
      this.sent.set(capture, { openid: p.openid, msgId: p.msgId, at: Date.now(), n: 0 });
      if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value!);
      // 上次回执已经说过、这次没变化的账不再重复念
      const snap = (i: number) => { const b = this.o.store.require(i); return JSON.stringify([b.amount, b.kind, b.status, b.merchant, b.item, b.note, b.category_id, b.occurred_at, b.method, b.flags, b.refund_of, b.batch]); };
      const told = ids.filter((i) => this.told.get(i) === snap(i)), fresh = ids.filter((i) => !told.includes(i)), show = fresh.length ? fresh : ids;
      for (const i of ids) this.told.set(i, snap(i));
      while (this.told.size > 2000) this.told.delete(this.told.keys().next().value!);
      const hints = fresh.length && told.length ? [...p.hints, `与刚才的 #${told.at(-1)} 不是同一笔（金额、单号或商户不同），已另记。其实是同一笔发「并入 ${fresh[0]} ${told.at(-1)}」`] : p.hints;
      const text = this.o.intake.receipt(show, hints);
      if (text) await this.send(p.openid, { msgId: p.msgId }, text, show[0], `✅ 已记录 ${ids.map((i) => '#' + i).join('、')}`);
      this.o.store.db.run('DELETE FROM receipts_due WHERE capture=? AND msg_id=?', capture, p.msgId);
    })());
  }
  private live(ids: number[]): number[] { return ids.filter((i) => { const b = this.o.store.db.get('SELECT deleted_at FROM bills WHERE id=?', i); return b && !b.deleted_at; }).sort((a, b) => a - b); }
  /** 识别比回执晚到：补一条结果（被动回复每条消息最多 4 次，最多补 2 次） */
  private late(bills: number[]): void {
    if (this.stopped) return;
    const caps = new Set(bills.map((b) => this.o.store.require(b).capture as string));
    for (const c of caps) {
      const s = this.sent.get(c);
      if (!s || this.pending.has(c) || s.n >= 2 || Date.now() - s.at > 50 * 60_000) continue;
      s.n++;
      this.schedule(s.openid, c, s.msgId, bills, []);
    }
  }

  private reply(openid: string, msgId: string, text: string, billId?: number): void {
    this.track(this.send(openid, { msgId }, text, billId, billId ? `✅ 操作成功（#${billId}），详细内容因平台限制无法显示，请到网页查看` : '内容因平台限制无法显示，请到网页查看'));
  }
  private track(p: Promise<unknown>): void {
    const t = p.catch((e) => log.error('回复发送失败（消息本身已入库）', e)).finally(() => this.inflight.delete(t));
    this.inflight.add(t);
  }

  /** 平台可能因内容审核拒发，此时退回到最短回执，保证用户知道已记录。 */
  private async send(openid: string, ref: { msgId?: string; eventId?: string }, text: string, billId?: number, fallback?: string): Promise<void> {
    const key = ref.msgId ?? ref.eventId!;
    const post = async (t: string) => {
      const seq = (this.seq.get(key) ?? 0) + 1;
      this.seq.set(key, seq);
      if (this.seq.size > 2000) this.seq.delete(this.seq.keys().next().value!);
      return this.o.api.replyC2C(openid, sanitizeReply(t), { ...ref, seq });
    };
    let refIdx: string | undefined;
    try { refIdx = await post(text); } catch (e) {
      if (!fallback) throw e;
      log.warn(`完整回复发送失败，改发精简回执：${(e as Error).message}`);
      refIdx = await post(fallback);
    }
    if (refIdx && billId) this.o.intake.rememberRef(refIdx, billId);
  }
}
