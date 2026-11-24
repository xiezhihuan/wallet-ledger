import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Backups } from './backup.js';
import type { Config } from './config.js';
import { Db } from './db.js';
import { Intake } from './intake.js';
import { Media } from './media.js';
import { createOcr, type Ocr } from './ocr.js';
import { QQApi } from './qq/api.js';
import { Bot } from './qq/bot.js';
import { Store } from './store.js';
import { createServer, type DemoHook } from './web/server.js';

export interface App { store: Store; media: Media; intake: Intake; bot: Bot | null; backups: Backups; server: FastifyInstance; url: string; close(): Promise<void> }

export async function startApp(config: Config, opts: { ocr?: Ocr | null; mediaRetry?: number[]; backoff?: number[]; now?: () => number; demo?: DemoHook } = {}): Promise<App> {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = new Db(path.join(config.dataDir, 'ledger.db'));
  const store = new Store(db, opts.now);
  const media = new Media(store, { dataDir: config.dataDir, maxBytes: config.maxAttachmentBytes, allowPrivate: config.allowPrivateMedia, retry: opts.mediaRetry });
  media.ocr = opts.ocr !== undefined ? opts.ocr : config.ocr ? await createOcr() : null;
  const intake = new Intake(store, { mergeWindowMs: config.mergeWindowMs, now: opts.now });
  const backups = new Backups(db, config.dataDir, config.backupDir, config.backupKeep);
  const bot = config.qq.appId
    ? new Bot({ appId: config.qq.appId, api: new QQApi({ ...config.qq, base: config.qq.apiBase }), store, intake, media, dataDir: config.dataDir, receiptDelayMs: config.receiptDelayMs, backoff: opts.backoff })
    : null;
  const server = await createServer({ config, store, media, intake, bot, backups, startedAt: Date.now(), demo: opts.demo });
  const url = await server.listen({ host: config.host, port: config.port }).catch((e) => { db.close(); throw e; });
  const stopBackups = backups.start();
  media.start();
  bot?.start();
  let closing: Promise<void> | null = null;
  return {
    store, media, intake, bot, backups, server, url,
    close: () => (closing ??= (async () => { stopBackups(); await bot?.stop(); await server.close(); await media.stop(); db.close(); })()),
  };
}
