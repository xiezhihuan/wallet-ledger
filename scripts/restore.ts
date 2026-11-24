/** npm run restore            列出备份
 *  npm run restore -- 名称     恢复（先停掉服务；会先给当前状态留一份快照） */
import net from 'node:net';
import path from 'node:path';
import { Backups } from '../src/backup.js';
import { loadEnvFile, readConfig } from '../src/config.js';
import { Db } from '../src/db.js';
import { fmtTime } from '../src/time.js';
loadEnvFile();
const c = readConfig(), name = process.argv[2];
const db = new Db(path.join(c.dataDir, 'ledger.db')), b = new Backups(db, c.dataDir, c.backupDir, c.backupKeep);
if (!name) { console.log(b.list().map((s) => `${s.name}  ${fmtTime(s.at)}  ${s.bills} 笔账  ${s.files} 个附件`).join('\n') || '还没有备份'); db.close(); process.exit(0); }
const busy = await new Promise<boolean>((ok) => { const s = net.connect(c.port, '127.0.0.1', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); });
if (busy) { console.error(`服务还在运行（端口 ${c.port}）。请先停掉服务，或在网页「设置 → 备份」里恢复。`); process.exit(1); }
try { const r = b.restore(name); console.log(`已恢复 ${name}，补回 ${r.files} 个附件。恢复前的状态保存在 ${r.before}`); } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
db.close();
