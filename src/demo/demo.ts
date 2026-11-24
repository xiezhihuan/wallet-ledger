import fs from 'node:fs';
import path from 'node:path';
import { startApp, type App } from '../app.js';
import { ROOT, type Config } from '../config.js';
import type { DemoHook } from '../web/server.js';
import { MockQQ } from './mock-qq.js';
import { seedDemo } from './seed.js';

const USER = 'DEMO0000DEMO0000DEMO0000DEMO0000';
const LABEL: Record<string, string> = { 'wx-detail': '微信账单详情', 'ali-detail-discount': '支付宝（有优惠）', takeout: '外卖订单', shop: '电商订单', ride: '打车行程', 'bank-sms-2': '银行短信', 'wx-refund': '微信退款', 'wx-list': '账单列表（多笔）', 'blur-heavy': '模糊截图', foreign: '外币消费' };

/** 演示模式：同一套程序接内置的模拟 QQ 平台，不连外网、不碰正式数据。 */
export async function startDemo(config: Config, opts: Parameters<typeof startApp>[1] = {}): Promise<App & { mock: MockQQ }> {
  const mock = new MockQQ();
  await mock.start();
  const log: { i: number; from: 'me' | 'bot'; text: string; files?: number; at: number }[] = [];
  let n = 0, seen = 0, fileNo = 0;
  const push = (from: 'me' | 'bot', text: string, files?: number) => log.push({ i: ++n, from, text, files, at: Date.now() });
  const pull = () => { for (; seen < mock.sent.length; seen++) push('bot', mock.sent[seen]!.content); };
  const dir = path.join(ROOT, 'demo-assets'), names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)) : [];
  const demo: DemoHook = {
    say(text, files) {
      pull(); push('me', text, files.length);
      const attachments = files.map((f) => { const url = `/file/demo${++fileNo}`; mock.files.set(url, { body: f.body, type: f.mime }); return { content_type: f.mime, filename: f.name, size: f.body.length, url: mock.base + url }; });
      mock.say(USER, text, attachments.length ? { attachments } : {});
    },
    messages(after) { pull(); return log.filter((m) => m.i > after); },
    samples: () => names.map((x) => ({ name: x, label: LABEL[x] ?? x })),
    sample: (x) => (names.includes(x) ? fs.readFileSync(path.join(dir, `${x}.png`)) : null),
  };
  const app = await startApp({ ...config, demo: true, qq: { appId: 'app', secret: 'sec', apiBase: mock.base }, allowPrivateMedia: true, receiptDelayMs: Math.min(config.receiptDelayMs, 1200) }, { ...opts, demo, backoff: [200] });
  seedDemo(app.store);
  app.store.db.run('INSERT OR IGNORE INTO qq_users(openid,nickname,bound_at) VALUES(?,?,?)', USER, '演示用户', Date.now());
  const close = app.close;
  return Object.assign(app, { mock, close: async () => { await close(); await mock.stop(); } });
}
