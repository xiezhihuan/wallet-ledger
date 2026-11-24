import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from './db.js';
import { logger } from './log.js';
import { UserError } from './store.js';
import { hm, ymd } from './time.js';

const log = logger('backup');
/** 快照名：2026-11-24_0312[-标签] */
const NAME = /^\d{4}-\d\d-\d\d_\d{4}(?:\d\d)?(?:-[a-z]+)?$/;
export interface Snapshot { name: string; at: number; size: number; files: number; bills: number; kind: string }
interface Manifest { created_at: number; db_sha256: string; bills: number; files: { path: string; size: number }[] }

const sha = (f: string): string => {
  const h = crypto.createHash('sha256'), fd = fs.openSync(f, 'r'), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
};

/**
 * 备份 = 数据库快照 + 附件。附件按内容寻址、只增不改，放在备份目录的 files/ 里多份快照共用，
 * 每份快照的 manifest 记录它需要哪些文件和数据库校验值。
 */
export class Backups {
  constructor(private db: Db, private dataDir: string, readonly dir: string, private keep: number) {}
  private get files() { return path.join(this.dataDir, 'files'); }

  create(tag = ''): Snapshot {
    const now = Date.now();
    // 精确到秒；同一秒内多次备份则往后错一秒
    let name = '';
    for (let t = now; ; t += 1000) { name = `${ymd(t)}_${hm(t).replace(':', '')}${String(Math.floor(t / 1000) % 60).padStart(2, '0')}${tag ? '-' + tag : ''}`; if (!fs.existsSync(path.join(this.dir, name))) break; }
    const to = path.join(this.dir, name);
    const tmp = `${to}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    this.db.run('VACUUM INTO ?', path.join(tmp, 'ledger.db'));
    const list = this.db.all(`SELECT DISTINCT path, size FROM attachments WHERE path IS NOT NULL AND status='done'`) as any as { path: string; size: number }[], ok: Manifest['files'] = [];
    for (const f of list) {
      const src = path.join(this.files, f.path), dst = path.join(this.dir, 'files', f.path);
      if (!fs.existsSync(src)) { if (tag === 'before') continue; throw new UserError('附件缺失，未生成不完整的备份'); }
      const size = fs.statSync(src).size;
      if (!fs.existsSync(dst) || fs.statSync(dst).size !== size) {
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(src, dst + '.tmp', fs.constants.COPYFILE_FICLONE); fs.renameSync(dst + '.tmp', dst);
      }
      ok.push({ path: f.path, size });
    }
    const m: Manifest = { created_at: now, db_sha256: sha(path.join(tmp, 'ledger.db')), bills: Number(this.db.get(`SELECT COUNT(*) n FROM bills WHERE deleted_at IS NULL AND status<>'batch_done'`)!.n), files: ok };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(m), { mode: 0o600 });
    fs.chmodSync(path.join(tmp, 'ledger.db'), 0o600);
    fs.renameSync(tmp, to);
    log.info(`已备份 ${name}（${ok.length} 个附件）`);
    this.prune();
    return this.list().find((s) => s.name === name)!;
  }
  /** 每天一份 */
  daily(): void {
    if (this.keep <= 0) return;
    const today = ymd(Date.now());
    if (!this.list().some((s) => s.kind === '' && s.name.startsWith(today))) this.create();
  }
  private prune(): void {
    if (this.keep <= 0) return;
    const all = this.list(), drop = [...all.filter((s) => s.kind === '').slice(this.keep), ...all.filter((s) => s.kind === 'before').slice(5), ...all.filter((s) => s.kind === 'manual').slice(this.keep)];
    if (!drop.length) return;
    for (const s of drop) fs.rmSync(path.join(this.dir, s.name), { recursive: true, force: true });
    // 没有任何快照引用的附件副本才清理
    const used = new Set(this.list().flatMap((s) => this.manifest(s.name).files.map((f) => f.path))), root = path.join(this.dir, 'files');
    if (fs.existsSync(root)) for (const d of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, d))) if (!used.has(`${d}/${f}`)) fs.rmSync(path.join(root, d, f));
  }
  private manifest(name: string): Manifest { return JSON.parse(fs.readFileSync(path.join(this.dir, name, 'manifest.json'), 'utf8')); }
  list(): Snapshot[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: Snapshot[] = [];
    for (const name of fs.readdirSync(this.dir).filter((n) => NAME.test(n))) try {
      const m = this.manifest(name), db = fs.statSync(path.join(this.dir, name, 'ledger.db')).size;
      out.push({ name, at: m.created_at, size: db + m.files.reduce((n, f) => n + f.size, 0), files: m.files.length, bills: m.bills, kind: /-([a-z]+)$/.exec(name)?.[1] ?? '' });
    } catch { /* 不完整的快照不列出 */ }
    return out.sort((a, b) => b.at - a.at);
  }
  /** 校验快照：数据库校验值、完整性、附件是否齐全且内容与文件名一致 */
  verify(name: string): { ok: boolean; problems: string[] } {
    if (!NAME.test(name) || !fs.existsSync(path.join(this.dir, name, 'manifest.json'))) throw new UserError('备份不存在', 404);
    const problems: string[] = [], m = this.manifest(name), file = path.join(this.dir, name, 'ledger.db');
    if (sha(file) !== m.db_sha256) problems.push('数据库文件与备份时不一致');
    else {
      const d = new DatabaseSync(file, { readOnly: true });
      try { if ((d.prepare('PRAGMA integrity_check').get() as any).integrity_check !== 'ok') problems.push('数据库损坏'); } finally { d.close(); }
    }
    for (const f of m.files) {
      const p = path.join(this.dir, 'files', f.path);
      if (!fs.existsSync(p)) problems.push(`缺少附件 ${f.path}`);
      else if (sha(p) !== path.basename(f.path).split('.')[0]) problems.push(`附件损坏 ${f.path}`);
    }
    return { ok: !problems.length, problems };
  }
  /**
   * 恢复。先校验，再给当前状态留一份快照，然后替换数据库、补齐附件。
   * 登录密钥、QQ 会话、绑定与令牌保持当前状态：恢复旧数据不能让已撤销的令牌或已解绑的 QQ 复活。
   */
  restore(name: string): { before: string; files: number } {
    const v = this.verify(name);
    if (!v.ok) throw new UserError(`备份校验没通过，未恢复：${v.problems.slice(0, 3).join('；')}`);
    const before = this.create('before').name;
    const keepKv = this.db.all(`SELECT key,value FROM kv WHERE key='session_secret' OR key LIKE 'qq_session:%'`);
    const tokens = this.db.all('SELECT * FROM api_tokens'), users = this.db.all('SELECT * FROM qq_users');
    const m = this.manifest(name);
    let n = 0;
    for (const f of m.files) {
      const dst = path.join(this.files, f.path);
      if (fs.existsSync(dst) && fs.statSync(dst).size === f.size && sha(dst) === path.basename(f.path).split('.')[0]) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(this.dir, 'files', f.path), dst + '.tmp'); fs.renameSync(dst + '.tmp', dst); n++;
    }
    this.db.swap(() => {
      for (const s of ['-wal', '-shm']) fs.rmSync(this.db.file + s, { force: true });
      const tmp = this.db.file + '.restore';
      fs.copyFileSync(path.join(this.dir, name, 'ledger.db'), tmp);
      fs.renameSync(tmp, this.db.file);
    });
    this.db.tx(() => {
      this.db.run(`DELETE FROM kv WHERE key='session_secret' OR key LIKE 'qq_session:%' OR key='bind_code'`);
      for (const k of keepKv) this.db.kvSet(k.key, k.value);
      {
        this.db.run('UPDATE mcp_authorizations SET revoked_at=COALESCE(revoked_at,?)', Date.now());
        this.db.run('UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,?)', Date.now()); this.db.run('DELETE FROM qq_users');
        for (const t of tokens) this.db.run('INSERT INTO api_tokens(id,name,hash,created_at,last_used_at,revoked_at,can_see_images) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,hash=excluded.hash,created_at=excluded.created_at,last_used_at=excluded.last_used_at,revoked_at=excluded.revoked_at,can_see_images=excluded.can_see_images', t.id, t.name, t.hash, t.created_at, t.last_used_at, t.revoked_at, t.can_see_images);
        for (const u of users) this.db.run('INSERT INTO qq_users(openid,nickname,bound_at) VALUES(?,?,?)', u.openid, u.nickname, u.bound_at);
      }
    });
    log.info(`已恢复 ${name}，恢复前状态保存在 ${before}`);
    return { before, files: n };
  }
  start(): () => void {
    const run = () => { try { this.daily(); } catch (e) { log.error('备份失败', e); } };
    run();
    const t = setInterval(run, 3600_000);
    t.unref();
    return () => clearInterval(t);
  }
}
