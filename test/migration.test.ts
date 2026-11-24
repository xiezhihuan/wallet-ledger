import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { tmp } from './helper.js';

test('用 2c8f8 实际数据库写入旧账，连 WAL 一起备份再迁移', () => {
  const dir=tmp(), file=path.join(dir,'ledger.db');
  try {
    for (const f of ['db','defaults']) fs.writeFileSync(path.join(dir,f+'.ts'),execFileSync('git',['show','7b53a75:src/'+f+'.ts']));
    fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(dir,'seed.ts'), `import { Db } from './db.ts';
      const d=new Db(process.argv[2]); d.run("INSERT INTO bills(occurred_at,day,created_at,updated_at,amount,merchant,status) VALUES(1,'2026-10-31',1,1,3099,'旧版合成账','ok')");
      d.run("INSERT INTO messages(channel,kind,text,sent_at,created_at) VALUES('web','entry','原始材料',1,1)");
      d.run("INSERT INTO attachments(message_id,kind,filename,text) VALUES(1,'image','合成.png','合成 OCR')");
      d.run("INSERT INTO evidence(message_id,bill_id,attachment_id,sent_at) VALUES(1,1,1,1)");d.close();`);
    execFileSync(process.execPath,['--disable-warning=ExperimentalWarning','--import','tsx',path.join(dir,'seed.ts'),file]);
    const old=new DatabaseSync(file);
    old.exec("PRAGMA wal_autocheckpoint=0; UPDATE bills SET note='尚在 WAL 中'");
    const upgraded=new Db(file);
    try {
      const d=new Store(upgraded).detail(1);
      assert.equal(d.amount,3099); assert.equal(d.note,'尚在 WAL 中'); assert.equal(d.version,1);
      assert.equal(d.evidence[0].ocr_text,'合成 OCR'); assert.equal(d.evidence[0].message_text,'原始材料');
      const copies=fs.readdirSync(dir).filter(n=>n.includes('pre-migration')); assert.equal(copies.length,1);
      const backup=new DatabaseSync(path.join(dir,copies[0]!),{readOnly:true});
      try {assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version,1); assert.equal(backup.prepare('SELECT note FROM bills').get()!.note,d.note);} finally {backup.close();}
    } finally {upgraded.close();old.close();}
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
