import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { EXPENSE, INCOME } from './defaults.js';

export type Row = Record<string, any>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE qq_users (openid TEXT PRIMARY KEY, nickname TEXT NOT NULL DEFAULT '', bound_at INTEGER NOT NULL);

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense','income')),
    name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '', keywords TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0);
  CREATE UNIQUE INDEX categories_name ON categories(type, COALESCE(parent_id,0), name);

  -- 商户归类规则；learned = 用户改分类时记住的。删除只打标记，可恢复
  CREATE TABLE rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, match TEXT NOT NULL CHECK (match IN ('merchant','contains')), pattern TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE, source TEXT NOT NULL CHECK (source IN ('learned','manual')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);

  CREATE TABLE bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture TEXT NOT NULL DEFAULT '',            -- 同一合并窗口的素材组
    batch_id INTEGER REFERENCES bills(id),       -- 来自哪张账单列表
    import_id INTEGER, source TEXT NOT NULL DEFAULT 'qq', author TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income','refund','transfer','repay')),
    direction TEXT NOT NULL DEFAULT '',          -- 转账：in / out
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('ok','pending','dup','batch','batch_done')),
    amount INTEGER CHECK (amount IS NULL OR amount >= 0), currency TEXT NOT NULL DEFAULT 'CNY',
    merchant TEXT NOT NULL DEFAULT '', item TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    occurred_at INTEGER NOT NULL, day TEXT NOT NULL, time_src TEXT NOT NULL DEFAULT 'sent', -- voucher/text/day/sent/manual
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, category_src TEXT NOT NULL DEFAULT '', category_why TEXT NOT NULL DEFAULT '',
    method TEXT NOT NULL DEFAULT '', trade_no TEXT NOT NULL DEFAULT '', ids TEXT NOT NULL DEFAULT '[]',
    refund_of INTEGER REFERENCES bills(id),
    locked TEXT NOT NULL DEFAULT '[]',           -- 人工改过的字段，自动识别不再覆盖
    confirmed INTEGER NOT NULL DEFAULT 0,        -- 用户确认过
    flags TEXT NOT NULL DEFAULT '[]',            -- 没把握的字段 [{field,hard,reason,candidates}]
    dup_of INTEGER, dup_ok TEXT NOT NULL DEFAULT '[]', dup_why TEXT NOT NULL DEFAULT '',
    batch TEXT,                                  -- 账单列表的逐行识别结果
    search_text TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    CHECK (status <> 'ok' OR amount IS NOT NULL));
  CREATE INDEX bills_day ON bills(day);
  CREATE INDEX bills_trade ON bills(trade_no) WHERE trade_no<>'';
  CREATE INDEX bills_capture ON bills(capture);
  CREATE INDEX bills_refund ON bills(refund_of) WHERE refund_of IS NOT NULL;

  -- 原始消息；raw 保留平台原始 JSON
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, dedupe_key TEXT UNIQUE, author TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('entry','command')), text TEXT NOT NULL DEFAULT '', raw TEXT, capture TEXT NOT NULL DEFAULT '',
    sent_at INTEGER NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image','voice','video','file')),
    filename TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, url TEXT, path TEXT, sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT,
    ocr_status TEXT NOT NULL DEFAULT 'none' CHECK (ocr_status IN ('none','pending','done','failed')),
    ocr TEXT,                                    -- 带坐标的识别结果
    text TEXT NOT NULL DEFAULT '');
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE INDEX attachments_queue ON attachments(status, next_at);
  CREATE INDEX attachments_sha ON attachments(sha256);

  -- 素材：一条消息拆成若干份（每张图、每段文字），各自归属某一笔账
  CREATE TABLE evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id INTEGER REFERENCES attachments(id) ON DELETE CASCADE, text TEXT NOT NULL DEFAULT '', parsed TEXT,
    bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL, pinned INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL, author TEXT NOT NULL DEFAULT '');
  CREATE INDEX evidence_bill ON evidence(bill_id);
  CREATE INDEX evidence_message ON evidence(message_id);
  CREATE INDEX evidence_attachment ON evidence(attachment_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
  CREATE INDEX events_bill ON events(bill_id);

  CREATE TABLE qq_refs (ref TEXT PRIMARY KEY, bill_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
  -- 还没发出的回执：重启后补发
  CREATE TABLE receipts_due (capture TEXT PRIMARY KEY, openid TEXT NOT NULL, msg_id TEXT NOT NULL, at INTEGER NOT NULL);

  -- 撤销只打标记：恢复旧备份时不会让已撤销的令牌复活
  CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);

  CREATE TABLE budgets (category_id INTEGER NOT NULL DEFAULT 0 PRIMARY KEY, amount INTEGER NOT NULL CHECK (amount > 0)); -- 0 = 总预算
  CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT NOT NULL, filename TEXT NOT NULL, rows TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'preview', created_at INTEGER NOT NULL, committed_at INTEGER);

  /* 统计口径的唯一出处：
     spend     支出为正、退款为负，其余为 0（收入、转账、还款不进消费）
     orig_*    退款关联了原支出时，分类/商户/支付方式/归属日跟随原支出 */
  CREATE VIEW v_bills AS
    SELECT b.*, COALESCE(o.day, b.day) orig_day,
      CASE WHEN o.id IS NULL THEN b.category_id ELSE o.category_id END eff_category,
      CASE WHEN o.id IS NULL THEN b.merchant ELSE o.merchant END eff_merchant,
      CASE WHEN o.id IS NULL THEN b.method ELSE o.method END eff_method,
      CASE b.kind WHEN 'expense' THEN b.amount WHEN 'refund' THEN -b.amount ELSE 0 END spend
    FROM bills b LEFT JOIN bills o ON b.kind='refund' AND o.id=b.refund_of AND o.deleted_at IS NULL;
  `,
];

export class Db {
  raw!: DatabaseSync;
  private depth = 0;

  constructor(readonly file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.open();
  }
  private open(): void {
    this.raw = new DatabaseSync(this.file);
    if (this.file !== ':memory:') try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  /** 恢复备份：关库 → 换文件 → 重新打开。fn 期间没有打开的连接。 */
  swap(fn: () => void): void {
    if (this.depth) throw new Error('事务中不能替换数据库');
    this.raw.close();
    try { fn(); } finally { this.open(); }
  }

  private migrate(): void {
    const v = Number(this.get('PRAGMA user_version')!.user_version);
    if (v > MIGRATIONS.length) throw new Error(`数据库版本 ${v} 高于程序支持的 ${MIGRATIONS.length}，请升级程序`);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]!);
        if (i === 0) this.seed();
        this.raw.exec(`PRAGMA user_version=${i + 1}`);
      });
    }
  }
  private seed(): void {
    let sort = 0;
    for (const [type, list] of [['expense', EXPENSE], ['income', INCOME]] as const) for (const [name, icon, subs] of list) {
      const p = this.run('INSERT INTO categories(type,name,icon,sort) VALUES(?,?,?,?)', type, name, icon, sort++).id;
      for (const [sub, kw] of subs) this.run('INSERT INTO categories(type,parent_id,name,keywords,sort) VALUES(?,?,?,?,?)', type, p, sub, kw, sort++);
    }
  }

  all<T = Row>(sql: string, ...args: SQLInputValue[]): T[] { return this.raw.prepare(sql).all(...args) as T[]; }
  get<T = Row>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.raw.prepare(sql).get(...args) as T | undefined; }
  run(sql: string, ...args: SQLInputValue[]): { id: number; changes: number } {
    const r = this.raw.prepare(sql).run(...args);
    return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  /** 事务；可嵌套（内层并入外层）。 */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }

  kvGet(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM kv WHERE key=?', key)?.value; }
  kvSet(key: string, value: string): void { this.run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  kvDel(key: string): void { this.run('DELETE FROM kv WHERE key=?', key); }
  close(): void { this.raw.close(); }
}
