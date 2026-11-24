/** npm run demo：不需要 QQ 账号，数据在 data-demo/，与正式数据无关。 */
import path from 'node:path';
import '../src/node-version.js';
const { readConfig, ROOT } = await import('../src/config.js');
const { startDemo } = await import('../src/demo/demo.js');
const dataDir = path.join(ROOT, 'data-demo');
const app = await startDemo({ ...readConfig({ PORT: process.env.PORT ?? '8927' }), host: '127.0.0.1', dataDir, backupDir: path.join(dataDir, 'backups'), adminPassword: 'demo-password' });
console.log(`\n演示模式：${app.url}  密码 demo-password\n打开后进「演示聊天」，像在 QQ 里一样发截图和文字。Ctrl+C 退出。\n`);
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => void app.close().then(() => process.exit(0)));
