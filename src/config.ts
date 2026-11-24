import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 项目根目录：src/ 与 dist/ 都在根目录的下一级。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '1.0.0';
export const APP = '截图账本';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  /** 备份目录，默认 data/backups；可指到外置盘 */
  backupDir: string;
  adminPassword: string;
  /** true / false，或只信任来自某处的代理，如 loopback（本机上的穿透客户端）。 */
  trustProxy: boolean | string;
  cookieSecure: boolean;
  publicUrl: string;
  qq: { appId: string; secret: string; apiBase: string };
  /** 合并窗口的初始值；网页「设置」里改过的以设置为准 */
  mergeWindowMs: number;
  /** 回执防抖：连发多条只回一次。 */
  receiptDelayMs: number;
  ocr: boolean;
  maxAttachmentBytes: number;
  backupKeep: number;
  demo: boolean;
  /** 仅供测试与演示：允许从本机下载附件。 */
  allowPrivateMedia: boolean;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min = 0): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`环境变量 ${key} 的值无效：${raw}`);
  return n;
}
const bool = (v: string | undefined, def: boolean) => (v?.trim() ? /^(1|true|yes|on)$/i.test(v.trim()) : def);

export function loadEnvFile(file = path.join(ROOT, '.env')): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(ROOT, env.DATA_DIR?.trim() || 'data');
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: num(env, 'PORT', 8917),
    dataDir,
    backupDir: env.BACKUP_DIR?.trim() ? path.resolve(ROOT, env.BACKUP_DIR.trim()) : path.join(dataDir, 'backups'),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    trustProxy: env.TRUST_PROXY?.trim() === 'loopback' ? 'loopback' : bool(env.TRUST_PROXY, false),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    publicUrl: (env.PUBLIC_URL?.trim() ?? '').replace(/\/+$/, ''),
    qq: {
      appId: env.QQ_APP_ID?.trim() ?? '',
      secret: env.QQ_APP_SECRET?.trim() ?? '',
      apiBase: (env.QQ_API_BASE?.trim() || 'https://api.bot.qq.com').replace(/\/+$/, ''),
    },
    mergeWindowMs: num(env, 'MERGE_WINDOW_MINUTES', 3) * 60_000,
    receiptDelayMs: num(env, 'RECEIPT_DELAY_MS', 2500),
    ocr: bool(env.OCR_ENABLED, true),
    maxAttachmentBytes: num(env, 'MAX_ATTACHMENT_MB', 50, 1) * 1024 * 1024,
    backupKeep: num(env, 'BACKUP_KEEP', 30),
    demo: bool(env.DEMO, false),
    allowPrivateMedia: false,
  };
}

export const isLoopback = (host: string): boolean => /^(127\.|localhost$|::1$)/.test(host);

/** 启动前校验，返回问题列表。 */
export function validateConfig(c: Config): string[] {
  const errs: string[] = [];
  if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535 || [8787,8799].includes(c.port)) errs.push('请选择空闲端口，避开 8787 和 8799');
  if (c.adminPassword.length < 8) errs.push('ADMIN_PASSWORD 未设置或少于 8 位（网页登录密码）');
  if (c.adminPassword === 'change-me-please') errs.push('ADMIN_PASSWORD 仍是示例值，请修改');
  if (!isLoopback(c.host) && c.adminPassword.length < 10) errs.push('开放局域网访问时 ADMIN_PASSWORD 至少 10 位');
  if (c.publicUrl && !/^https?:\/\/[^/]+/.test(c.publicUrl)) errs.push('PUBLIC_URL 须以 http:// 或 https:// 开头');
  if (Boolean(c.qq.appId) !== Boolean(c.qq.secret)) errs.push('QQ_APP_ID 与 QQ_APP_SECRET 必须同时填写');
  return errs;
}
