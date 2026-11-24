import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, type App } from '../src/app.js';
import { readConfig, type Config } from '../src/config.js';
import type { Ocr, OcrDoc, OcrItem } from '../src/ocr.js';
import { parts } from '../src/time.js';
import { MockQQ } from '../src/demo/mock-qq.js';

process.env.LOG_LEVEL ??= 'silent';
if (process.env.LOG_LEVEL === 'silent') { console.warn = () => {}; console.error = () => {}; const l = console.log; console.log = (...a) => { if (!/^\d{4}-.*\[(qq|web|media|ocr|backup|main|mcp|qq-bot|qq-gateway|qq-api)/.test(String(a[0]))) l(...a); }; }

export const U = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
export const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function until<T>(fn: () => T | undefined | false | null | Promise<T | undefined | false | null>, what = '条件', ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    let v: T | undefined | false | null, err: unknown;
    try { v = await fn(); } catch (e) { err = e; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${what}`, { cause: err });
    await new Promise((r) => setTimeout(r, 10));
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function cfg(mock: MockQQ | null, dataDir: string, over: Partial<Config> = {}): Config {
  return { ...readConfig({}), host: '127.0.0.1', port: 0, dataDir, adminPassword: 'test-password', qq: mock ? { appId: 'app', secret: 'sec', apiBase: mock.base } : { appId: '', secret: '', apiBase: '' }, receiptDelayMs: 60, backupKeep: 0, allowPrivateMedia: true, backupDir: path.join(dataDir, 'backups'), ...over };
}
export interface Env { mock: MockQQ; app: App; dir: string; restart(): Promise<void>; stop(): Promise<void>; reply(re: RegExp, after?: number): Promise<string> }
export async function boot(over: Partial<Config> = {}, opts: { ocr?: Ocr | null; bind?: boolean; now?: () => number } = {}): Promise<Env> {
  const mock = new MockQQ();
  await mock.start();
  const dir = tmp(), c = cfg(mock, dir, over);
  const go = () => startApp(c, { ocr: opts.ocr ?? null, mediaRetry: [20, 20, 20], backoff: [20], now: opts.now });
  const env: Env = {
    mock, dir, app: await go(),
    async restart() { await env.app.close(); env.app = await go(); await until(() => env.app.bot!.gateway.state === 'online', '重启后上线'); },
    async stop() { await env.app.close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); },
    reply: (re, after = 0) => until(() => mock.sent.slice(after).find((s) => re.test(s.content))?.content, `回复 ${re}；实际：${JSON.stringify(mock.sent.map((s) => s.content))}`),
  };
  await until(() => env.app.bot!.gateway.state === 'online', '上线');
  if (opts.bind !== false) env.app.store.db.run('INSERT INTO qq_users(openid,bound_at) VALUES(?,?)', U, 1);
  return env;
}
/** 带登录态的 API 客户端 */
export async function login(app: App): Promise<(p: string, o?: { method?: string; body?: any; form?: FormData }) => Promise<{ status: number; data: any; res: Response }>> {
  const r = await fetch(app.url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'wl' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  return async (p, o = {}) => {
    const res = await fetch(app.url + '/api' + p, { method: o.method ?? 'GET', headers: { cookie, 'x-requested-with': 'wl', ...(o.body ? { 'content-type': 'application/json' } : {}) }, body: o.form ?? (o.body ? JSON.stringify(o.body) : undefined) });
    const t = await res.clone().text();
    let data: any = t; try { data = JSON.parse(t); } catch {}
    return { status: res.status, data, res };
  };
}

// ───────── 假 OCR：识别结果藏在图片尾部，测试归账逻辑时不依赖真实识别 ─────────
export type Line = string | [string, string] | { big: string; c?: number } | { c: number; t: [string, string] | string };
let shotNo = 0;
/** 造一张「截图」。同样的内容默认也是不同文件；same 指定时内容相同。 */
export function shot(lines: Line[], same?: string): Buffer {
  const items: OcrItem[] = [];
  let y = 40;
  const put = (t: string, x: number, h: number, c = 1) => items.push({ t, x, y, w: t.length * h * 0.7, h, c });
  for (const l of lines) {
    if (typeof l === 'string') put(l, l.length < 12 ? 480 : 60, 48);
    else if (Array.isArray(l)) { put(l[0], 54, 48); put(l[1], 1100 - l[1].length * 30, 48); }
    else if ('big' in l) { put(l.big, 390, 98, l.c ?? 1); y += 60; }
    else if (Array.isArray(l.t)) { put(l.t[0], 54, 48); put(l.t[1], 1100 - l.t[1].length * 30, 48, l.c); }
    else put(l.t, 480, 48, l.c);
    y += 100;
  }
  return Buffer.concat([PNG, Buffer.from(`WL:${JSON.stringify({ w: 1170, h: y + 100, items })}:${same ?? ++shotNo}`)]);
}
export const wx = (merchant: string, amount: string, time: string, trade: string, more: [string, string][] = []): Line[] => ['账单详情', merchant, { big: amount }, ['当前状态', '支付成功'], ['支付时间', time], ['支付方式', '零钱'], ['交易单号', trade], ...more];
export const order = (shop: string, paid: string, time: string, no: string): Line[] => ['订单详情', '订单已送达', shop, ['招牌饭×1', `¥${(Number(paid) + 5).toFixed(2)}`], ['配送费', '¥0.00'], ['满减优惠', '-¥5.00'], ['实付', `¥${paid}`], ['订单号码', no], ['下单时间', time]];
export const fakeOcr = (delay = 0): Ocr => ({
  async recognize(file) {
    if (delay) await sleep(delay);
    const s = fs.readFileSync(file).toString('utf8'), m = /WL:(\{.*\}):[^:]*$/s.exec(s);
    if (!m) throw new Error('无法识别');
    return JSON.parse(m[1]!) as OcrDoc;
  },
});
let fileNo = 0;
/** 以 QQ 图片消息发出 */
export function sendShot(e: Env, buf: Buffer | Buffer[], text = '', extra: Record<string, any> = {}) {
  const attachments = [buf].flat().map((b) => { const u = `/file/s${++fileNo}`; e.mock.files.set(u, { body: b, type: 'image/png' }); return { content_type: 'image/png', filename: 's.png', url: e.mock.base + u }; });
  return e.mock.say(U, text, { attachments, ...extra });
}
export const stamp = (ms: number) => { const p = parts(ms), z = (n: number) => String(n).padStart(2, '0'); return `${p.y}-${z(p.m)}-${z(p.d)} ${z(p.h)}:${z(p.mi)}:${z(p.s)}`; };
