import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Row } from './db.js';
import { logger } from './log.js';
import { docText, type Ocr, type OcrDoc } from './ocr.js';
import type { Store } from './store.js';

const log = logger('media');
const RETRY = [5_000, 30_000, 120_000, 600_000, 1_800_000, 7_200_000];

const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(a, p, 'ipv6');
export function isPrivateIp(ip: string): boolean {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  return v4 ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

async function assertPublic(u: URL): Promise<void> {
  if (u.protocol !== 'https:') throw new Error(`不支持的下载协议 ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new Error('拒绝访问内网地址');
}

/** 按文件头识别类型；扩展名和平台给的 MIME 都不可信。 */
export function sniff(b: Buffer): { mime: string; ext: string } | null {
  const hex = b.subarray(0, 12).toString('hex'), s = b.subarray(0, 16).toString('latin1');
  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', ext: 'png' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (s.startsWith('GIF8')) return { mime: 'image/gif', ext: 'gif' };
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (s.startsWith('BM')) return { mime: 'image/bmp', ext: 'bmp' };
  if (s.startsWith('RIFF') && s.slice(8, 12) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  if (s.startsWith('ID3')) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (s.slice(4, 8) === 'ftyp') return { mime: 'video/mp4', ext: 'mp4' };
  if (s.startsWith('%PDF-')) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

/** 可在页面内直接展示的类型；只有文件头确认过的才允许使用这些类型。 */
export const INLINE = /^(image\/(png|jpeg|gif|webp|bmp)|audio\/(wav|mpeg)|video\/mp4)$/;
export const trustedMime = (sniffed: string, claimed: string): string => sniffed || (INLINE.test(claimed) ? 'application/octet-stream' : claimed);

export class Media {
  readonly dir: string;
  ocr: Ocr | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private waiters = new Set<() => void>();

  constructor(private store: Store, private o: { dataDir: string; maxBytes: number; allowPrivate?: boolean; retry?: number[] }) {
    this.dir = path.join(o.dataDir, 'files');
    fs.mkdirSync(path.join(this.dir, 'tmp'), { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(path.join(this.dir, 'tmp'))) fs.rmSync(path.join(this.dir, 'tmp', f), { force: true });
  }

  get processing(): boolean { return this.running !== null; }
  start(): void { this.stopped = false; this.kick(); }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }
  abs(rel: string): string { return path.join(this.dir, rel); }

  /** 有新附件时唤醒队列。 */
  kick(): void {
    if (this.stopped) return;
    if (this.running) { this.again = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.running = this.drain().catch((e) => log.error('附件队列异常', e)).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; return this.kick(); }
      const next = this.store.db.get<{ t: number | null }>(`SELECT MIN(next_at) t FROM attachments WHERE status='pending'`)?.t;
      if (next && !this.stopped) { this.timer = setTimeout(() => this.kick(), Math.max(next - Date.now(), 500)); this.timer.unref(); }
    });
  }

  private async drain(): Promise<void> {
    // 先下载后识别：下载地址会过期，优先级更高
    for (;;) {
      if (this.stopped) return;
      const batch = this.store.db.all(`SELECT * FROM attachments WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 4`, Date.now());
      if (!batch.length) break;
      await Promise.all(batch.map((a) => this.download(a)));
      this.notify();
    }
    for (;;) {
      if (this.stopped) return;
      const a = this.store.db.get(`SELECT * FROM attachments WHERE status='done' AND ocr_status='pending' ORDER BY id LIMIT 1`);
      if (!a) break;
      let doc: OcrDoc | null = null;
      if (this.ocr && /^image\//.test(a.mime)) try {
        doc = await this.ocr.recognize(this.abs(a.path));
      } catch (e) {
        log.warn(`附件 ${a.id} 识别失败`);
      }
      if (this.stopped) return; // 识别途中停机：保持 pending，下次启动重来
      const bills = this.store.db.tx(() => {
        this.store.db.run(`UPDATE attachments SET ocr_status=?, ocr=?, text=? WHERE id=?`, doc ? 'done' : 'failed', doc ? JSON.stringify(doc) : null, doc ? docText(doc) : '', a.id);
        return this.store.evaluate(a.id, doc);
      });
      for (const f of this.onDone) f(bills);
      this.notify();
      if (this.again) { this.again = false; return this.drain(); } // 新附件插队下载
    }
  }
  private done(id: number, doc: OcrDoc | null): void {
    try { const bills = this.store.evaluate(id, doc); for (const f of this.onDone) f(bills); } catch (e) { log.error(`附件 ${id} 归账异常`, e); }
    this.notify();
  }
  /** 一张图归账完成 */
  onDone: ((bills: number[]) => void)[] = [];

  private async download(a: Row): Promise<void> {
    try {
      const saved = await this.save(await this.open(a.url, a), a.filename);
      this.store.db.run(`UPDATE attachments SET status='done', path=?, sha256=?, size=?, mime=?, error=NULL WHERE id=?`, saved.path, saved.sha256, saved.size, trustedMime(saved.mime, a.mime), a.id);
    } catch (e) {
      const n = a.attempts + 1, delay = (this.o.retry ?? RETRY)[n - 1];
      const msg = (e as Error).message;
      log.warn(`附件 ${a.id} 第 ${n} 次下载失败`);
      this.store.db.run(`UPDATE attachments SET attempts=?, error=?, status=?, next_at=? WHERE id=?`, n, msg.slice(0, 300), delay === undefined ? 'failed' : 'pending', Date.now() + (delay ?? 0), a.id);
      if (delay === undefined && a.kind === 'image') this.done(a.id, null);
    }
  }

  private async open(url: string, a: Row): Promise<Readable> {
    let u = new URL(url);
    for (let hop = 0; hop < 4; hop++) {
      if (!this.o.allowPrivate) await assertPublic(u);
      const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(180_000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location')!, u); await res.body?.cancel(); continue; }
      if (!res.ok || !res.body) throw new Error(`下载返回 HTTP ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > this.o.maxBytes) { await res.body.cancel(); throw new Error(`附件 ${a.id} 超过大小限制`); }
      return Readable.fromWeb(res.body as any);
    }
    throw new Error('重定向次数过多');
  }

  /** 落盘：先写临时文件并算哈希，再原子改名；同内容只存一份。 */
  async save(src: Readable, filename = ''): Promise<{ path: string; sha256: string; size: number; mime: string }> {
    const tmp = path.join(this.dir, 'tmp', crypto.randomUUID());
    const hash = crypto.createHash('sha256');
    let size = 0, head = Buffer.alloc(0);
    const max = this.o.maxBytes;
    try {
      await pipeline(src, new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > max) return cb(new Error('附件超过大小限制'));
          if (head.length < 32) head = Buffer.concat([head, chunk.subarray(0, 32)]);
          hash.update(chunk);
          cb(null, chunk);
        },
      }), fs.createWriteStream(tmp, { mode: 0o600 }));
      if (size === 0) throw new Error('附件内容为空');
      const sha256 = hash.digest('hex'), type = sniff(head);
      const ext = type?.ext ?? (/\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase() || 'bin');
      const rel = `${sha256.slice(0, 2)}/${sha256}.${ext}`;
      await fsp.mkdir(path.dirname(this.abs(rel)), { recursive: true });
      const fh = await fsp.open(tmp, 'r+'); await fh.sync(); await fh.close();
      // 内容寻址：已有同内容就不必替换（Windows 上目标正被读取时改名会失败）
      if (fs.existsSync(this.abs(rel)) && fs.statSync(this.abs(rel)).size === size) await fsp.rm(tmp, { force: true });
      else await fsp.rename(tmp, this.abs(rel));
      return { path: rel, sha256, size, mime: type?.mime ?? '' };
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  retry(id: number): void {
    this.store.db.run(`UPDATE attachments SET status='pending', attempts=0, next_at=0 WHERE id=? AND status='failed' AND url IS NOT NULL`, id);
    this.store.db.run(`UPDATE attachments SET ocr_status='pending' WHERE id=? AND kind='image' AND status='done' AND ocr_status='failed'`, id);
    this.kick();
  }

  private busy(capture: string): boolean {
    return !!this.store.db.get(`SELECT 1 FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.capture=? AND ((a.status='pending' AND a.attempts=0) OR (a.status='done' AND a.ocr_status='pending')) LIMIT 1`, capture);
  }
  private notify(): void { for (const w of [...this.waiters]) w(); }
  /** 等这组素材处理完（或超时），让回执带上识别结果。 */
  settle(capture: string, timeoutMs: number): Promise<void> {
    if (!this.busy(capture)) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.waiters.delete(check); resolve(); };
      const check = () => { if (!this.busy(capture)) done(); };
      const t = setTimeout(done, timeoutMs);
      this.waiters.add(check);
    });
  }
}
