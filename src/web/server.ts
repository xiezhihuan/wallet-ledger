import { patchOf } from '../bill-input.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fstatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Backups } from '../backup.js';
import { APP, isLoopback, ROOT, VERSION, type Config } from '../config.js';
import { toCsv, toJson } from '../exports.js';
import { Importer } from '../importers/bills.js';
import type { Intake } from '../intake.js';
import { logger } from '../log.js';
import { registerMcp, Tokens } from '../mcp/http.js';
import { INLINE, trustedMime, type Media } from '../media.js';
import { toCents } from '../money.js';
import type { Bot } from '../qq/bot.js';
import { RULES, Stats, check } from '../stats.js';
import { KIND, SOURCE, STATUS, UserError, type Filter, type NewAttachment, type Store } from '../store.js';
import { at, fmtTime, periodOf, validDay, ymd, type Unit } from '../time.js';
import { accessUrls } from './access.js';

const log = logger('web');
export const COOKIE = 'wl_session';
const TTL = 30 * 86400_000, ACTOR = '网页';

export interface WebDeps { config: Config; store: Store; media: Media; intake: Intake; bot: Bot | null; backups: Backups; startedAt: number; demo?: DemoHook }
/** 演示模式的模拟 QQ 聊天 */
export interface DemoHook { say(text: string, files: { name: string; mime: string; body: Buffer }[]): void; messages(after: number): { i: number; from: 'me' | 'bot'; text: string; files?: number; at: number }[]; samples(): { name: string; label: string }[]; sample(name: string): Buffer | null }

export async function createServer({ config, store, media, intake, bot, backups, startedAt, demo }: WebDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: config.trustProxy, bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxAttachmentBytes, files: 20, fields: 30, fieldSize: 1024 * 1024 } });
  const stats = new Stats(store), importer = new Importer(store), tokens = new Tokens(store);

  // ───── 登录：密码 + 签名 Cookie；改密码后旧会话自动失效 ─────
  let secret = store.db.kvGet('session_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); store.db.kvSet('session_secret', secret); }
  const key = crypto.createHash('sha256').update(`${secret}\0${config.adminPassword}`).digest();
  const sign = (exp: string) => crypto.createHmac('sha256', key).update(exp).digest('hex');
  const same = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
  const authed = (req: FastifyRequest): boolean => {
    const [exp, mac] = (req.cookies[COOKIE] ?? '').split('.');
    return !!exp && !!mac && Number(exp) > Date.now() && same(mac, sign(exp));
  };
  const fails = new Map<string, { n: number; until: number }>();

  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'same-origin')
      .header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const p = req.routeOptions?.url ?? ''; // 用匹配到的路由判断，避免 /%61pi/… 这类编码绕过
    if (!p.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'wl') return reply.code(403).send({ error: '非法请求来源' });
    if (p !== '/api/login' && !authed(req)) return reply.code(401).send({ error: '请先登录' });
  });
  app.setErrorHandler((e: any, _req, reply) => {
    if (e instanceof UserError) return reply.code(e.status).send({ error: e.message });
    const code = e.statusCode ?? 500;
    if (code >= 500) log.error('请求处理失败', e);
    return reply.code(code).send({ error: code === 413 ? '文件过大' : code >= 500 ? '服务器内部错误' : e.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: '不存在' }));

  app.get('/healthz', async (_req, reply) => {
    store.db.get('SELECT 1');
    const state = bot?.gateway.state ?? 'disabled';
    return reply.code(state === 'blocked' ? 503 : 200).send({ ok: true, app: 'wallet-ledger', bot: state });
  });
  app.post('/api/login', async (req, reply) => {
    const f = fails.get(req.ip);
    if (f && f.n >= 5 && f.until > Date.now()) return reply.code(429).send({ error: '尝试次数过多，请 5 分钟后再试' });
    const pw = (req.body as any)?.password;
    if (typeof pw !== 'string' || !same(pw, config.adminPassword)) {
      if (fails.size > 5000) fails.clear();
      fails.set(req.ip, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 5 * 60_000 });
      return reply.code(401).send({ error: '密码错误' });
    }
    fails.delete(req.ip);
    const exp = String(Date.now() + TTL);
    return reply.setCookie(COOKIE, `${exp}.${sign(exp)}`, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure || req.protocol === 'https', maxAge: TTL / 1000 }).send({ ok: true });
  });
  app.post('/api/logout', async (_req, reply) => reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true }));

  // ───── 通用 ─────
  const id = (req: FastifyRequest, k = 'id'): number => { const n = Number((req.params as any)[k]); if (!Number.isSafeInteger(n) || n <= 0) throw new UserError('编号无效', 404); return n; };
  const body = (req: FastifyRequest): any => (req.body && typeof req.body === 'object' ? req.body : {});
  const query = (req: FastifyRequest) => { const q = req.query as Record<string, unknown>; return (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined); };
  const centsArg = (v: unknown, name = '金额'): number => { const c = typeof v === 'string' ? toCents(v) : null; if (c === null) throw new UserError(`${name}格式不对，应为数字，最多两位小数`); return c; };
  const day = (s: string | undefined) => { if (s && !validDay(s)) throw new UserError(`日期无效：${s}`); return s; };
  const catArg = (s: string | undefined) => (s === 'none' ? 'none' as const : s ? Number(s) || undefined : undefined);
  const raw = (req: FastifyRequest, k: string) => { const v = (req.query as any)[k]; return typeof v === 'string' ? v : undefined; };
  const filter = (req: FastifyRequest): Filter => {
    const s = query(req), b = s('basis');
    return { q: s('q'), kind: s('kind'), status: s('status'), category: catArg(s('category')), merchant: raw(req, 'merchant'), method: raw(req, 'method'), currency: s('currency'), source: s('source'), from: day(s('from')), to: day(s('to')), min: s('min') ? centsArg(s('min')) : undefined, max: s('max') ? centsArg(s('max')) : undefined, image: s('image') === '1', deleted: s('deleted') === '1', soft: s('soft') === '1', counted: s('counted') === '1', withPending: s('pending') === '1', basis: b === 'original' || b === 'refund' ? b : undefined, importId: Number(s('import')) || undefined, sort: s('sort'), page: Number(s('page')) || 1, pageSize: Math.min(Number(s('pageSize')) || 30, 200) };
  };

  app.get('/api/meta', async () => ({
    app: APP, version: VERSION, demo: !!demo, kinds: KIND, status: STATUS, sources: SOURCE, categories: store.categories(),
    methods: store.db.all(`SELECT method v, COUNT(*) n FROM bills WHERE method<>'' AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 100`).map((r) => r.v),
    merchants: store.db.all(`SELECT merchant v, COUNT(*) n FROM bills WHERE merchant<>'' AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 300`).map((r) => r.v),
    users: store.db.all('SELECT openid,nickname FROM qq_users'), today: ymd(store.now()), basis: store.basis, rules: RULES(store.basis),
  }));
  app.get('/api/summary', async () => ({ ...store.counts(), bot: bot?.gateway.state ?? 'disabled', ocr: !!media.ocr }));

  // ───── 账目 ─────
  app.get('/api/bills', async (req) => store.list(filter(req)));
  app.get('/api/bills/:id', async (req) => store.detail(id(req)));
  app.patch('/api/bills/:id', async (req) => { const { learn, reason, ...b } = body(req); const r = store.update(id(req), patchOf(b), ACTOR, learn !== false, { source: 'web', reason: typeof reason === 'string' && reason.trim() ? reason.trim() : '网页修改' }); return { ...store.detail(id(req)), learned: r.rule ?? null }; });
  app.delete('/api/bills/:id', async (req) => { store.remove(id(req), ACTOR); return { ok: true }; });
  app.post('/api/bills/:id/restore', async (req) => { store.restore(id(req), ACTOR); return store.detail(id(req)); });
  app.post('/api/bills/:id/confirm', async (req) => { const b = body(req); if (Object.keys(b).length) store.update(id(req), patchOf(b), ACTOR, true, { source: 'web', reason: '网页确认' }); store.confirm(id(req), ACTOR); return store.detail(id(req)); });
  app.post('/api/bills/:id/dup', async (req) => ({ id: store.resolveDup(id(req), body(req).same === true, ACTOR) }));
  app.post('/api/bills/:id/merge', async (req) => { store.merge(id(req), Number(body(req).into), ACTOR); return { ok: true }; });
  app.post('/api/bills/:id/commit', async (req) => { const p = body(req).rows; if (p !== undefined && p !== null && !(Array.isArray(p) && p.every((x) => Number.isInteger(x)))) throw new UserError('行号无效'); return store.commitBatch(id(req), p ?? null, ACTOR); });
  app.post('/api/bills/:id/close', async (req) => { store.closeBatch(id(req), ACTOR); return { ok: true }; });
  app.post('/api/bills/:id/reopen', async (req) => { store.reopenBatch(id(req), ACTOR); return { ok: true }; });
  app.post('/api/evidence/:id/move', async (req) => ({ id: store.moveEvidence(id(req), body(req).to == null ? null : Number(body(req).to), ACTOR) }));

  async function readForm(req: FastifyRequest): Promise<{ fields: Record<string, string>; atts: NewAttachment[]; files: { name: string; mime: string; body: Buffer }[] }> {
    const fields: Record<string, string> = {}, atts: NewAttachment[] = [];
    if (!req.isMultipart()) return { fields: body(req), atts, files: [] };
    for await (const part of req.parts()) {
      if (part.type === 'field') { fields[part.fieldname] = String(part.value); continue; }
      const s = await media.save(part.file, part.filename);
      if (part.file.truncated) throw new UserError('文件过大', 413);
      const mime = trustedMime(s.mime, part.mimetype);
      atts.push({ kind: s.mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'voice' : mime.startsWith('video/') ? 'video' : 'file', filename: part.filename, mime, size: s.size, path: s.path, sha256: s.sha256 });
    }
    return { fields, atts, files: [] };
  }
  /** 网页记账：手填字段，或传截图 / 文字走与 QQ 相同的识别 */
  app.post('/api/bills', async (req) => {
    const { fields, atts } = await readForm(req), text = String(fields.text ?? '').trim(), capture = `web:${crypto.randomUUID()}`;
    if (text.length > 20_000) throw new UserError('内容过长');
    const manual = Object.fromEntries(Object.entries(fields).filter(([k, v]) => ['amount', 'occurred', 'kind', 'merchant', 'item', 'note', 'method', 'category_id', 'currency'].includes(k) && v !== ''));
    if (!text && !atts.length && !manual.amount) throw new UserError('请填金额，或上传截图、写一句话');
    if (manual.amount) patchOf(manual); // 先校验，避免留下空账
    const r = store.db.tx(() => {
      let bill: number;
      if (text || atts.length) bill = store.addMessage({ channel: 'web', author: ACTOR, text, sentAt: Date.now(), attachments: atts }, capture, null).bill;
      else bill = store.createBill({ author: ACTOR, source: 'web', at: Date.now(), capture });
      if (Object.keys(manual).length) store.update(bill, patchOf(manual), ACTOR, !!manual.category_id);
      return bill;
    });
    media.kick();
    await media.settle(capture, 15_000);
    store.takeDirty(capture);
    const ids = store.db.all('SELECT id FROM bills WHERE capture=? AND deleted_at IS NULL ORDER BY id', capture).map((x) => x.id);
    return { id: r, ids };
  });
  app.post('/api/bills/:id/messages', async (req) => {
    const b = store.require(id(req)), { fields, atts } = await readForm(req), text = String(fields.text ?? '').trim();
    if (b.deleted_at || b.status.startsWith('batch')) throw new UserError('这笔账不能补充素材');
    if (!text && !atts.length) throw new UserError('内容不能为空');
    const capture = b.capture || `b${b.id}`;
    store.addMessage({ channel: 'web', author: ACTOR, text, sentAt: Date.now(), attachments: atts }, capture, b.id, b.id);
    media.kick();
    await media.settle(capture, 15_000);
    return store.detail(b.id);
  });

  // ───── 附件 ─────
  app.get('/api/attachments/:id', async (req, reply: FastifyReply) => {
    const a = store.db.get('SELECT * FROM attachments WHERE id=?', id(req));
    if (!a?.path || !fs.existsSync(media.abs(a.path))) throw new UserError('附件不存在', 404);
    const inline = INLINE.test(a.mime) && (req.query as any).dl !== '1', name = a.filename || `附件${a.id}${path.extname(a.path)}`;
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cache-Control', 'private, max-age=86400')
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.type(inline ? a.mime : 'application/octet-stream').sendFile(a.path, media.dir, { cacheControl: false, contentType: false, acceptRanges: true });
  });
  app.post('/api/attachments/:id/retry', async (req) => { media.retry(id(req)); return { ok: true }; });

  // ───── 统计 ─────
  app.get('/api/stats', async (req) => {
    const s = query(req), unit = s('unit') as Unit | undefined, today = ymd(store.now());
    let r = { from: day(s('from')) ?? '', to: day(s('to')) ?? '' };
    if (!r.from || !r.to) { if (unit && !['day', 'week', 'month', 'quarter', 'year'].includes(unit)) throw new UserError('周期无效'); r = periodOf(unit ?? 'month', day(s('date')) ?? today); }
    check(r);
    const basis = s('basis') === 'refund' ? 'refund' : s('basis') === 'original' ? 'original' : undefined;
    return { ...stats.report({ ...r, includePending: s('pending') === '1', basis, category: catArg(s('category')), merchant: raw(req, 'merchant'), method: raw(req, 'method') }, today), budget: stats.budget(r.to < today ? r.to : today, today), rules: RULES(basis ?? store.basis) };
  });
  app.get('/api/export/:fmt', async (req, reply) => {
    const fmt = (req.params as any).fmt as string, f = filter(req);
    if (fmt !== 'csv' && fmt !== 'json') throw new UserError('不支持的格式', 404);
    reply.header('Content-Disposition', `attachment; filename="bills-${ymd(store.now())}.${fmt}"`);
    return fmt === 'csv' ? reply.type('text/csv; charset=utf-8').send(toCsv(store, f)) : reply.type('application/json; charset=utf-8').send(toJson(store, f));
  });

  // ───── 分类、规则、预算 ─────
  app.post('/api/categories', async (req) => { const b = body(req); return { id: store.saveCategory({ id: b.id ? Number(b.id) : undefined, name: typeof b.name === 'string' ? b.name : undefined, icon: typeof b.icon === 'string' ? b.icon.slice(0, 20) : undefined, keywords: typeof b.keywords === 'string' ? b.keywords : undefined, parent_id: b.parent_id ? Number(b.parent_id) : null, type: b.type, sort: b.sort === undefined ? undefined : Number(b.sort) || 0 }) }; });
  app.delete('/api/categories/:id', async (req) => { const m = query(req)('move'); store.deleteCategory(id(req), m ? Number(m) : null, ACTOR); return { ok: true }; });
  app.get('/api/rules', async () => ({ active: store.rules(), deleted: store.rules(true).slice(0, 50) }));
  app.post('/api/rules', async (req) => { const b = body(req); return { id: store.saveRule({ match: String(b.match ?? ''), pattern: String(b.pattern ?? ''), category_id: Number(b.category_id) }) }; });
  app.delete('/api/rules/:id', async (req) => { store.deleteRule(id(req)); return { ok: true }; });
  app.post('/api/rules/:id/undo', async (req) => { store.deleteRule(id(req), true); return { ok: true }; });
  app.post('/api/reclassify', async (req) => ({ changed: store.reclassify(typeof body(req).subject === 'string' ? body(req).subject : undefined) }));
  app.get('/api/budgets', async () => ({ budgets: store.budgets(), now: stats.budget(ymd(store.now()), ymd(store.now())) }));
  app.post('/api/budgets', async (req) => { const b = body(req); store.saveBudget(Number(b.category_id) || 0, b.amount === '' ? 0 : centsArg(b.amount, '预算')); return { ok: true }; });

  // ───── 导入 ─────
  app.post('/api/imports', async (req) => {
    const f = await req.file({ limits: { fileSize: 20 * 1024 * 1024 } });
    if (!f) throw new UserError('请选择账单文件');
    return importer.preview(await f.toBuffer(), f.filename);
  });
  app.get('/api/imports', async () => store.db.all('SELECT id,platform,filename,status,created_at,committed_at FROM imports ORDER BY id DESC LIMIT 50'));
  app.get('/api/imports/:id', async (req) => importer.get(id(req)));
  app.post('/api/imports/:id/commit', async (req) => { const b = body(req); return importer.commit(id(req), { pick: Array.isArray(b.pick) ? b.pick.map(Number) : undefined, decide: b.decide && typeof b.decide === 'object' ? b.decide : {} }, ACTOR); });
  app.delete('/api/imports/:id', async (req) => { importer.discard(id(req)); return { ok: true }; });

  // ───── 备份 ─────
  app.get('/api/backups', async () => ({ dir: backups.dir, list: backups.list(), keep: config.backupKeep }));
  app.post('/api/backups', async () => backups.create('manual'));
  app.post('/api/backups/:name/verify', async (req) => backups.verify((req.params as any).name));
  app.post('/api/backups/:name/restore', async (req) => { if (media.processing || store.db.get('SELECT 1 FROM receipts_due LIMIT 1')) throw new UserError('正在收录消息，请稍后恢复', 409); const r = backups.restore((req.params as any).name); store.resetCaches(); media.kick(); return r; });

  // ───── MCP ─────
  registerMcp(app, { store, media, tokens, notify: bot?.notifyMcp.bind(bot) });
  app.post('/api/mcp-tokens', async (req) => tokens.create(String(body(req).name ?? ''), body(req).can_see_images !== false));
  app.delete('/api/mcp-tokens/:id', async (req) => { tokens.revoke(id(req)); return { ok: true }; });
  app.get('/api/mcp-authorizations', async () => tokens.authorizations());
  app.post('/api/mcp-authorizations', async (req) => {
    const b = body(req), scope = b.scope === 'all' ? 'all' : 'bill';
    return tokens.issueAuthorization(scope, scope === 'bill' ? Number(b.bill_id) : null, '网页管理员', Number(b.minutes ?? 10));
  });
  app.delete('/api/mcp-authorizations/:id', async (req) => { tokens.revokeAuthorization(id(req)); return { ok: true }; });
  app.get('/api/audit/mcp', async (req) => {
    const q = req.query as any, c: string[] = ['1=1'], a: any[] = [];
    if (q.source) { c.push('source=?'); a.push(String(q.source)); }
    if (q.token) { c.push('token_id=?'); a.push(Number(q.token)); }
    if (q.result) { c.push('result=?'); a.push(String(q.result)); }
    if (q.from) { c.push('at>=?'); a.push(Date.parse(day(String(q.from)) + 'T00:00:00+08:00')); }
    if (q.to) { c.push('at<?'); a.push(Date.parse(day(String(q.to)) + 'T00:00:00+08:00') + 86400000); }
    return store.db.all(`SELECT * FROM (SELECT id,at,'mcp' source,token_id,token_name,authorization_id,bill_id,operation,result,reason,detail FROM mcp_audit
      UNION ALL SELECT id,at,source,NULL,'',authorization_id,bill_id,'修改','success',reason,fields FROM bill_changes WHERE source<>'mcp') WHERE ${c.join(' AND ')} ORDER BY at DESC,id DESC LIMIT 500`, ...a);
  });
  app.get('/api/bills/:id/changes', async (req) => store.changes(id(req)));
  app.post('/api/bills/:id/restore-change/:changeId', async (req) => store.restoreChange(id(req), id(req, 'changeId'), ACTOR));
  app.post('/api/bills/:id/review', async (req) => { const b = body(req); return store.review(id(req), b.result, String(b.note ?? ''), ACTOR); });

  // ───── 设置 ─────
  app.get('/api/system', async () => ({
    bot: bot ? { state: bot.gateway.state, reason: bot.gateway.reason, lastEventAt: bot.gateway.lastEventAt } : { state: 'disabled', reason: '没有配置 QQ 机器人', lastEventAt: 0 },
    ocr: media.ocr ? 'ready' : config.ocr ? 'unavailable' : 'disabled',
    queue: store.db.get(`SELECT COALESCE(SUM(status='pending'),0) downloading, COALESCE(SUM(status='failed'),0) failed, COALESCE(SUM(status='done' AND ocr_status='pending'),0) recognizing FROM attachments`),
    users: store.db.all('SELECT openid,nickname,bound_at FROM qq_users ORDER BY bound_at'), tokens: tokens.list(), authorizations: tokens.authorizations(), access: accessUrls(config, (app.server.address() as AddressInfo).port), lan: !isLoopback(config.host), publicUrl: config.publicUrl,
    settings: { merge_window_min: intake.mergeWindowMs / 60_000, refund_basis: store.basis }, mcp_notify_qq: store.setting('mcp_notify_qq', '1') !== '0', startedAt, dataDir: config.dataDir, demo: !!demo, version: VERSION, backups: backups.list().slice(0, 1), backupDir: backups.dir,
  }));
  app.post('/api/settings', async (req) => {
    const b = body(req);
    if (b.merge_window_min !== undefined) { const n = Number(b.merge_window_min); if (!Number.isFinite(n) || n < 0 || n > 120) throw new UserError('合并窗口须为 0–120 分钟'); store.saveSetting('merge_window_min', String(n)); }
    if (b.refund_basis !== undefined) { if (!['original', 'refund'].includes(b.refund_basis)) throw new UserError('退款归属无效'); store.saveSetting('refund_basis', b.refund_basis); }
    if (b.mcp_notify_qq !== undefined) store.saveSetting('mcp_notify_qq', b.mcp_notify_qq ? '1' : '0');
    return { ok: true };
  });
  app.post('/api/bind-code', async () => store.createBindCode());
  app.delete('/api/qq-users/:openid', async (req) => { store.db.run('DELETE FROM qq_users WHERE openid=?', (req.params as any).openid); return { ok: true }; });

  // ───── 演示 ─────
  if (demo) {
    app.get('/api/demo/messages', async (req) => demo.messages(Number((req.query as any).after) || 0));
    app.get('/api/demo/samples', async () => demo.samples());
    app.post('/api/demo/say', async (req) => {
      const files: { name: string; mime: string; body: Buffer }[] = [];
      let text = '';
      if (req.isMultipart()) for await (const p of req.parts()) { if (p.type === 'field') { if (p.fieldname === 'text') text = String(p.value); else if (p.fieldname === 'sample') { const s = demo.sample(String(p.value)); if (s) files.push({ name: `${p.value}.png`, mime: 'image/png', body: s }); } } else files.push({ name: p.filename, mime: p.mimetype, body: await p.toBuffer() }); }
      else text = String(body(req).text ?? '');
      if (!text.trim() && !files.length) throw new UserError('说点什么，或发张截图');
      demo.say(text.slice(0, 2000), files);
      return { ok: true };
    });
  }

  await app.register(fstatic, { root: path.join(ROOT, 'public'), cacheControl: false, etag: true });
  return app;
}
export { fmtTime };
