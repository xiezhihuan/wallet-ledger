import path from 'node:path';
import { Backups } from '../src/backup.js';
import { loadEnvFile, readConfig } from '../src/config.js';
import { Db } from '../src/db.js';
loadEnvFile();
const c = readConfig(), db = new Db(path.join(c.dataDir, 'ledger.db'));
const s = new Backups(db, c.dataDir, c.backupDir, c.backupKeep).create('manual');
console.log(`已备份：${path.join(c.backupDir, s.name)}（${s.bills} 笔账，${s.files} 个附件）`);
db.close();
