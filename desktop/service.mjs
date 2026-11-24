import { readConfig, validateConfig } from './server/dist/config.js';
import { startApp } from './server/dist/app.js';
import { startDemo } from './server/dist/demo/demo.js';
let service;
process.parentPort.on('message', async ({data}) => {
  if (data.stop) { await service?.close(); process.exit(0); }
  try {
    const cfg = readConfig(data.config), errors = validateConfig(cfg);
    if (errors.length) throw Error(errors.join('；'));
    service = await (data.demo ? startDemo(cfg) : startApp(cfg));
    process.parentPort.postMessage({ url: 'http://127.0.0.1:' + new URL(service.url).port });
  } catch (e) {
    process.parentPort.postMessage({ error: e.code === 'EADDRINUSE' ? '端口已占用，请换一个端口。' : '启动失败，请检查本地数据目录和连接设置。' });
    setTimeout(() => process.exit(1), 100);
  }
});
