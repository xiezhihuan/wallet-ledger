// 从只读挂载的 DMG 实际启动 Chromium、Node 服务和 OCR。每次使用新 profile。
// Electron 的 mock keychain 使测试不触碰个人钥匙串。
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), out = path.join(here,'../test-output'), version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'ledger-package-')), mount = path.join(temp,'volume'), profile = path.join(temp,'profile');
const dmg = path.resolve(process.argv[2] || path.join(here,'release',`WalletLedger-${version}-${process.arch}.dmg`));
fs.mkdirSync(mount); fs.mkdirSync(out,{recursive:true});
let mounted = false, app;
const launch = async () => electron.launch({ executablePath: path.join(mount,'截图账本.app/Contents/MacOS/WalletLedger'),
  args:['--use-mock-keychain'], env:{...process.env,WALLET_LEDGER_PROFILE:profile},timeout:40000 });
try {
  execFileSync('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,dmg]); mounted = true;
  execFileSync('codesign',['--verify','--strict','--deep',path.join(mount,'截图账本.app')]);
  app = await launch();
  const setup = await app.firstWindow();
  await setup.locator('#port').waitFor();
  await setup.waitForFunction(() => Number(document.querySelector('#port').value) >= 8917);
  assert.equal(await setup.locator('#lan').isChecked(),false);
  await setup.screenshot({path:path.join(out,'package-setup.png')});
  await setup.locator('#password').fill('synthetic-passphrase');
  const opened = app.waitForEvent('window');
  await setup.locator('#start').click();
  const ledger = await opened;
  await ledger.getByLabel('登录密码').fill('synthetic-passphrase');
  await ledger.getByRole('button',{name:'登录'}).click();
  await ledger.getByText('还没有账').waitFor();
  await ledger.getByRole('button',{name:'记一笔'}).first().click();
  await ledger.getByLabel('一句话记账').fill('午饭 28');
  await ledger.getByRole('button',{name:'记下来'}).click();
  await ledger.getByText('¥28.00').first().waitFor();
  await app.close(); app = await launch();
  const resumed = await app.firstWindow(); await resumed.waitForURL(/^http:/);
  await resumed.locator('.hero').waitFor();
  assert.match(await resumed.locator('.hero').innerText(), /28\.00/);
  console.log('通过：挂载 DMG、独立设置、登录、记账、密文设置及重新启动');
  assert.ok(!fs.readFileSync(path.join(profile,'settings.json'),'utf8').includes('synthetic-passphrase'));
  const settingWindow = app.waitForEvent('window');
  await app.evaluate(({Menu}) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
  const again = await settingWindow;
  const demoWindow = app.waitForEvent('window');
  await again.locator('#demo').click();
  const demo = await demoWindow;
  await demo.getByLabel('登录密码').fill('demo-password'); await demo.getByRole('button',{name:'登录'}).click();
  await demo.locator('.hero').waitFor();
  await demo.screenshot({path:path.join(out,'package-overview.png')});
  await demo.getByRole('link',{name:'演示聊天'}).click();
  const origin = new URL(demo.url()).origin;
  const say = async value => {
    await demo.getByLabel('消息',{exact:true}).fill(value);
    await demo.getByRole('button',{name:'发送',exact:true}).click();
  };
  await demo.goto(origin+'/#/settings');
  await demo.getByRole('button',{name:'解绑',exact:true}).click();
  await demo.locator('dialog').getByRole('button',{name:'解绑'}).click();
  await demo.getByText('还没有绑定的 QQ。',{exact:false}).waitFor();
  await demo.getByRole('button',{name:'生成绑定码'}).click();
  const bind = await demo.locator('.code').innerText();
  await demo.goto(origin+'/#/demo'); await say(bind);
  await demo.locator('.msg.bot').filter({hasText:'绑定成功'}).waitFor();
  await demo.getByRole('button',{name:'微信账单详情'}).click();
  await demo.getByLabel('消息',{exact:true}).fill('购买午餐'); await demo.getByRole('button',{name:'发送',exact:true}).click();
  const receipt = demo.locator('.msg.bot').filter({hasText:/商户：/}).last();
  await receipt.waitFor({timeout:30000}); assert.match(await receipt.innerText(),/28\.00/);
  await demo.screenshot({path:path.join(out,'package-receipt.png')});
  assert.ok(fs.existsSync(path.join(profile,'demo/ledger.db')) && fs.existsSync(path.join(profile,'data/ledger.db')));
  const id = /#(\d+)/.exec(await receipt.innerText())[1];
  await say('改 #'+id+' 分类 外卖');
  await demo.locator('.msg.bot').filter({hasText:/餐饮\/外卖/}).last().waitFor();
  await demo.goto(origin+'/#/stats');
  await demo.locator('.hero .big').waitFor();
  const total = (await demo.locator('.hero .big').innerText()).replace(/[¥,]/g,'');
  await demo.goto(origin+'/#/bills');
  // Electron uses its own session download manager for non-default partitions.
  // Choose a file in our temporary profile instead of opening a system save dialog.
  const exportPath = path.join(temp,'export.csv');
  await app.evaluate(({BrowserWindow},target) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:'));
    w.webContents.session.once('will-download', (_,item) => {
      item.setSavePath(target);
      item.once('done',(_,state) => { globalThis.ledgerDownloadState = state; });
    });
  },exportPath);
  await demo.getByRole('link',{name:'CSV',exact:true}).click();
  for (let i=0; i<200 && !(await app.evaluate(() => globalThis.ledgerDownloadState)); i++)
    await new Promise(resolve => setTimeout(resolve,50));
  assert.equal(await app.evaluate(() => globalThis.ledgerDownloadState),'completed');
  assert.ok(fs.readFileSync(exportPath,'utf8').includes('购买午餐'));
  await demo.goto(origin+'/#/settings');
  await demo.getByRole('button',{name:'生成令牌'}).click();
  const token = /Bearer (\S+?)"/.exec(await demo.locator('.mono').first().innerText())[1];
  const client = new Client({name:'package-check',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(origin+'/mcp'), {requestInit:{headers:{Authorization:'Bearer '+token}}}));
    const s = await client.callTool({name:'summarize',arguments:{period:'this_month'}});
    assert.equal(JSON.parse(s.content[0].text).net_spend,total);
    const detail = await client.callTool({name:'get_bill',arguments:{id:Number(id)}});
    assert.equal(JSON.parse(detail.content[0].text).category,'餐饮/外卖');
    const bill=JSON.parse(detail.content[0].text);
    const image=await client.callTool({name:'get_attachment',arguments:{id:bill.attachments[0].id}});
    assert.ok(image.content.some(block=>block.type==='image'));
    await demo.getByPlaceholder('单笔编号').fill(id);
    await demo.getByRole('button',{name:'签发授权码'}).click();
    const grant=await demo.locator('.mono').filter({hasText:/^wla_/}).innerText();
    const args={id:Number(id),authorization_code:grant,expected_version:bill.version,reason:'包内合成复核',amount:'29.00'};
    const preview=await client.callTool({name:'update_bill',arguments:args});
    assert.equal(JSON.parse(preview.content[0].text).changed_fields.amount.after,2900);
    const result=await client.callTool({name:'update_bill',arguments:{...args,preview:false,request_id:'package-correction'}});
    assert.equal(JSON.parse(result.content[0].text).detail.amount,2900);
    await demo.goto(origin+'/#/bills/'+id);
    await demo.getByRole('button',{name:'恢复到之前'}).first().click();
    await demo.locator('dialog').getByRole('button',{name:'恢复',exact:true}).click();
    await demo.getByText('已恢复',{exact:true}).waitFor();
    const restored=await client.callTool({name:'get_bill',arguments:{id:Number(id)}});
    assert.equal(JSON.parse(restored.content[0].text).amount,'28.00');
    console.log('通过：包内 MCP 取图、预览、受控改账与网页恢复');
  } finally { await client.close(); }
  console.log('通过：重新绑定模拟 QQ、两条消息归一、包内 OCR、改分类、统计、导出、MCP 对账');
} finally {
  await app?.close().catch(()=>{});
  if(mounted) execFileSync('hdiutil',['detach',mount]);
  fs.rmSync(temp,{recursive:true,force:true});
}
