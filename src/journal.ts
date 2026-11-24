import type { Db, Row } from './db.js';

// Columns a bill can gain or lose through recognition, edits, reconciliation or undo.
// Indexes, timestamps maintained for sorting, and the version counter are derived.
export const stateColumns = ('kind direction status amount currency merchant item note occurred_at day time_src category_id category_src category_why method trade_no ids refund_of locked confirmed flags dup_of dup_ok dup_why batch deleted_at').split(' ');
const snapshot = (alias: string) => `json_object(${stateColumns.map(k => `'${k}',${alias}.${k}`).join(',')},'evidence_ids',
  (SELECT json_group_array(id ORDER BY id) FROM evidence WHERE bill_id=${alias}.id))`;

export function installJournal(db: Db) {
  // Save only the first pre-image per touched bill inside one business operation.
  const capture = (where: string) => `INSERT OR IGNORE INTO prior SELECT b.id,${snapshot('b')} FROM bills b WHERE ${where} AND b.id NOT IN (SELECT id FROM prior);`;
  db.raw.exec(`CREATE TEMP TABLE tracking(active INTEGER);
    CREATE TEMP TABLE prior(id INTEGER PRIMARY KEY, state TEXT NOT NULL);
    CREATE TEMP TRIGGER track_bill BEFORE UPDATE ON main.bills WHEN EXISTS(SELECT 1 FROM tracking)
      BEGIN ${capture('b.id=OLD.id')} END;
    CREATE TEMP TRIGGER track_evidence BEFORE UPDATE OF bill_id,parsed ON main.evidence WHEN EXISTS(SELECT 1 FROM tracking)
      BEGIN ${capture('b.id IN (OLD.bill_id,NEW.bill_id)')} END;`);
}

export function recordOperation<T>(db: Db, at: number, source: string, actor: string, reason: string, fn: () => T, grant: number | null = null): T {
  return db.tx(() => {
    if (db.get('SELECT active FROM tracking')) return fn();
    db.run('INSERT INTO tracking VALUES(1)');
    const result = fn();
    db.run('DELETE FROM tracking');
    const rows = db.all(`SELECT p.id,p.state AS old,${snapshot('b')} AS current,b.version FROM prior p JOIN bills b ON b.id=p.id`);
    for (const row of rows) {
      const old: Row = JSON.parse(row.old), current: Row = JSON.parse(row.current);
      const fields = Object.fromEntries(Object.keys(current).filter(k => JSON.stringify(old[k]) !== JSON.stringify(current[k]))
        .map(k => [k, {before:old[k], after:current[k]}]));
      const rule = (result as Row | null)?.rule;
      if (rule && rule.bill_id === row.id) fields.learned_rule = {before:rule.previous_category, after:{id:rule.id,category_id:rule.category_id,pattern:rule.pattern}};
      if (!Object.keys(fields).length && (result as Row | null)?.restored_bill !== row.id) continue;
      db.run('UPDATE bills SET version=version+1 WHERE id=?', row.id);
      db.run('INSERT INTO bill_changes(bill_id,at,source,actor,reason,before_version,after_version,authorization_id,fields) VALUES(?,?,?,?,?,?,?,?,?)',
        row.id, at, source, actor, reason, row.version, row.version+1, grant, JSON.stringify(fields));
    }
    db.run('DELETE FROM prior');
    return result;
  });
}
