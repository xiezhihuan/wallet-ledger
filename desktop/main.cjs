const { app, BrowserWindow, Menu, ipcMain, safeStorage, dialog, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

app.setName('WalletLedger');
const profile = path.resolve(process.env.WALLET_LEDGER_PROFILE || path.join(app.getPath('appData'), 'com.walletledger.personal'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-component-update');
if (!app.requestSingleInstanceLock()) app.quit();
else run();

function run() {
  const configFile = path.join(profile, 'settings.json');
  const setupFile = path.join(__dirname, 'setup.html');
  let config, worker, win, panel, quitting = false, intentional = false, changing = false;
  function settings() {
    if (panel && !panel.isDestroyed()) return panel.focus();
    panel = new BrowserWindow({ width: 560, height: 690, title: '截图账本 · 连接设置',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    panel.webContents.on('will-navigate', e => e.preventDefault());
    panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panel.on('closed', () => { panel = null; });
    panel.loadFile(setupFile);
  }
  function trusted(e) {
    if (!panel || e.sender !== panel.webContents || e.senderFrame?.url !== pathToFileURL(setupFile).href)
      throw Error('页面不能更改连接设置');
  }
  async function freePort() {
    for (let port = 8917; port < 9017; port++) {
      const ok = await new Promise(r => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
      if (ok) return port;
    }
    throw Error('请手动选择空闲端口');
  }
  ipcMain.handle('wallet-view', async e => { trusted(e); return { port: config?.port || await freePort(), lan: !!config?.lan, appId: config?.appId || '', saved: !!config }; });
  function decrypt(field) { return field ? safeStorage.decryptString(Buffer.from(field, 'base64')) : ''; }
  function encrypt(value) { return safeStorage.encryptString(value).toString('base64'); }
  async function stop() {
    if (!worker) return;
    intentional = true;
    const old = worker;
    await new Promise(resolve => { const timer = setTimeout(() => old.kill(), 5000); old.once('exit', () => { clearTimeout(timer); resolve(); }); old.postMessage({ stop: true }); });
    intentional = false;
  }
  async function launch(cfg, demo) {
    const port = demo ? 0 : cfg.port;
    const base = path.join(profile, demo ? 'demo' : 'data');
    const info = { PORT: String(port), HOST: !demo && cfg.lan ? '0.0.0.0' : '127.0.0.1', DATA_DIR: base,
      ADMIN_PASSWORD: demo ? 'demo-password' : decrypt(cfg.password), QQ_APP_ID: demo ? '' : cfg.appId,
      QQ_APP_SECRET: demo ? '' : decrypt(cfg.secret) };
    if (win) { win.destroy(); win = null; }
    await stop();
    const child = utilityProcess.fork(path.join(__dirname, 'service.mjs'), [], { serviceName: 'WalletLedger service', stdio: 'pipe' });
    worker = child;
    child.stdout?.resume(); child.stderr?.resume();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('本地服务启动超时')); }, 60000);
      child.once('message', message => { clearTimeout(timer); if (message.error) reject(Error(message.error)); else resolve(message); });
      child.once('exit', () => {
        clearTimeout(timer); worker = null;
        reject(Error('本地服务已退出，请重新打开连接设置'));
        if (!quitting && !intentional && !changing) { settings(); dialog.showErrorBox('账本服务已停止', '请在连接设置中重新启动。'); }
      });
      child.postMessage({ config: info, demo });
    });
    const origin = new URL(result.url).origin;
    win = new BrowserWindow({ title: '截图账本', width: 1280, height: 850, minWidth: 390,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: demo ? 'ledger-demo' : 'persist:ledger' } });
    win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) e.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { win = null; });
    await win.loadURL(origin);
    panel?.close();
  }
  ipcMain.handle('wallet-start', async (e, v) => {
    trusted(e);
    if (changing) return '正在启动';
    changing = true;
    try {
      if (v.demo) { await launch({}, true); return ''; }
      const port = Number(v.port), appId = String(v.appId || '').trim();
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || [8787,8799].includes(port)) throw Error('请选择 1024–65535 的独立端口，避开 8787 和 8799');
      const pw = v.password || decrypt(config?.password);
      if (pw.length < (v.lan ? 10 : 8) || pw === 'change-me-please') throw Error('请输入有效密码。本机至少 8 位，局域网至少 10 位');
      const secret = appId ? v.secret || (appId === config?.appId ? decrypt(config.secret) : '') : '';
      if (appId && (!/^\d+$/.test(appId) || !secret)) throw Error('请填写本账本专用的 AppID 和 AppSecret');
      if (!safeStorage.isEncryptionAvailable()) throw Error('无法使用系统钥匙串保存密码');
      const next = { port, lan: !!v.lan, appId, password: encrypt(pw), secret: secret ? encrypt(secret) : '' };
      await launch(next, false);
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      fs.writeFileSync(configFile + '.tmp', JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(configFile + '.tmp', configFile); config = next;
      return '';
    } catch (err) { return err.message; } finally { changing = false; }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '截图账本', submenu: [{ label: '连接设置…', accelerator: 'Cmd+,', click: settings }, { role: 'quit', label: '退出截图账本' }] }, { role: 'editMenu' }, { role: 'viewMenu' }]));
    try { if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8')); if (config) await launch(config, false); else settings(); }
    catch (err) { settings(); dialog.showErrorBox('未能启动账本', err.message); }
  });
  app.on('second-instance', () => (win || panel)?.focus());
  app.on('activate', () => { if (!win && !panel) settings(); });
  app.on('window-all-closed', () => { if (!changing) app.quit(); });
  app.on('before-quit', e => { if (worker && !quitting) { e.preventDefault(); quitting = true; stop().finally(() => app.quit()); } });
}
