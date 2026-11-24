/** 端到端：模拟 QQ 平台 + 真实本地 OCR + 真实 Chrome + 真实 MCP 客户端。截图输出到 test-output/。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chromium, devices, type Page } from 'playwright-core';
import { startApp } from '../src/app.js';
import { ROOT } from '../src/config.js';
import { MockQQ } from '../src/demo/mock-qq.js';
import { createOcr } from '../src/ocr.js';
import { ymd } from '../src/time.js';
import { WECHAT } from './bill-files.js';
import { cfg, sleep, stamp, tmp, U, until } from './helper.js';
import { alipayDetail, shoot, wechatDetail, wechatSuccess } from './screens.js';

const OUT = path.join(ROOT, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const ocr = await createOcr();
assert.ok(ocr, 'OCR 必须可用');
const browser = await chromium.launch({ channel: 'chrome' });
const errors: string[] = [];
const ok = (s: string) => console.log('✓ ' + s);
let app: Awaited<ReturnType<typeof startApp>> | undefined;
const mock = new MockQQ(), dir = tmp();
async function watch(p: Page): Promise<void> {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|429/.test(m.text())) errors.push(m.text()); });
}
let fileNo = 0;
const image = async (html: string, o: any = {}) => { const u = `/file/${++fileNo}`; mock.files.set(u, { body: await shoot(browser, { name: 'x', html, truth: { kind: 'expense', amount: null }, ...o }), type: 'image/png' }); return { content_type: 'image/png', filename: `${fileNo}.png`, url: mock.base + u }; };
const cn = (ms: number) => { const s = stamp(ms); return `${s.slice(0, 4)}年${+s.slice(5, 7)}月${+s.slice(8, 10)}日 ${s.slice(11)}`; };

try {
  await mock.start();
  app = await startApp({ ...cfg(mock, dir), receiptDelayMs: 300 }, { ocr, backoff: [50] });
  const a = app, ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true }), p = await ctx.newPage();
  await watch(p);
  const reply = (re: RegExp, from = 0) => until(() => mock.sent.slice(from).find((s) => re.test(s.content))?.content, `${re}；实际 ${JSON.stringify(mock.sent.slice(from).map((s) => s.content))}`, 30_000);
  const say = async (t: string, re: RegExp, extra: any = {}) => { const n = mock.sent.length; mock.say(U, t, extra); return reply(re, n); };

  // 1 登录 → 绑定
  await p.goto(a.url);
  await p.getByLabel('登录密码').fill('wrong-password'); await p.getByRole('button', { name: '登录' }).click(); await p.getByText('密码错误').waitFor();
  await p.getByLabel('登录密码').fill('test-password'); await p.getByRole('button', { name: '登录' }).click(); await p.getByText('还没有账').waitFor();
  mock.say(U, '午饭 28'); await reply(/没有权限/); assert.equal(a.store.counts().total, 0);
  await p.goto(a.url + '/#/settings'); await p.getByRole('button', { name: '生成绑定码' }).click();
  mock.say(U, await p.locator('.code').innerText()); await reply(/绑定成功/);
  ok('登录、未绑定被拒、网页生成绑定码 → QQ 绑定');

  // 2 真实 OCR：微信支付成功页 + 账单详情 + 一句说明 → 同一笔
  const t0 = Date.now() - 3 * 3600_000;
  const i1 = await image(wechatSuccess({ merchant: '老街牛肉面馆', amount: '28.00', method: '招商银行信用卡(1234)' })), i2 = await image(wechatDetail({ merchant: '老街牛肉面馆', amount: '-28.00', time: cn(t0), method: '招商银行信用卡(1234)', trade: '4200002988202611031234567890', goods: '堂食点餐' }), { dark: true });
  mock.say(U, '', { attachments: [i1] }); mock.say(U, '', { attachments: [i2] });
  mock.say(U, '和同事聚餐');
  const r1 = await reply(/已记 #1/); console.log('--- 回执 ---\n' + r1 + '\n------------');
  assert.match(r1, /支出：¥28\.00/); assert.match(r1, /商户：老街牛肉面馆/); assert.match(r1, /餐饮\/正餐/); assert.match(r1, /备注：和同事聚餐/); await sleep(300); assert.equal(a.store.counts().total, 1);
  ok('两张截图（深色 + 浅色）+ 文字 → 真实识别 → 一笔，一条回执');

  // 3 连发两张不同付款 → 拆开
  await say('新建', /新的一笔/); const n3 = mock.sent.length;
  const i3 = await image(alipayDetail({ merchant: '绿禾超市', amount: '-86.35', rows: [['支付时间', stamp(t0 - 7200_000)], ['付款方式', '花呗'], ['订单号', '2026110622001412345678901234']] })), i4 = await image(wechatDetail({ merchant: '云衣服饰旗舰店', amount: '-129.00', time: cn(t0 - 9000_000), method: '零钱', trade: '4200002988202611011111222233' }));
  mock.say(U, '', { attachments: [i3] }); await reply(/已记 #2/, n3); await say('新建', /新的一笔/); mock.say(U, '', { attachments: [i4] });
  await reply(/已记 #3/, n3); ok('新建动作隔开两笔付款');

  // 4 退款、转账、列表、模糊、疑似重复
  await say('新建', /./); assert.match(await say('', /已记 #4/, { attachments: [await image(wechatDetail({ merchant: '云衣服饰旗舰店-退款', amount: '+129.00', state: '已全额退款', time: cn(t0), timeLabel: '退款时间', method: '零钱', trade: '4200002988202611011111222233', extra: [['退款方式', '原路退回']] }))] }), /原支出：#3/);
  await say('新建 转给小李 200', /不算消费/);
  const md = (h: number) => cn(t0 - h * 3600_000).slice(5, -3);
  await say('新建', /./); const rl = await say('', /账单列表/, { attachments: [await image(`<div class=nav>账单</div><div class=card>${[['老街牛肉面馆', md(0), '-28.00'], ['小满咖啡', md(5), '-19.90'], ['城市地铁', md(6), '-5.00']].map(([x, y, z]) => `<div class=item><span>${x}<br><span class="m s">${y}</span></span><span style="font-size:18px">${z}</span></div>`).join('')}</div>`)] }); console.log(rl);
  assert.match(rl, /疑似 #1/); assert.match(await say('入账 全部', /入账 2 笔/), /第 1 行 疑似与 #1 重复/); await say('忽略', /不入账/);
  await say('新建', /./); await say('', /待确认/, { attachments: [await image(wechatDetail({ merchant: '看不清商店', amount: '-88.80', time: cn(t0), method: '零钱', trade: '4200002988202611095555000000' }), { scale: 1, blur: 4 })] });
  await say('新建', /./); await say('', /疑似与 #1 重复/, { attachments: [await image(wechatDetail({ merchant: '老街牛肉面馆', amount: '-28.00', time: cn(t0), method: '招商银行信用卡(1234)', trade: '4200002988202611031234567890' }))] });
  ok('退款自动关联、转账不算消费、列表逐笔确认、模糊待确认、重复提示');

  // 5 网页：处理待确认与重复
  await p.goto(a.url + '/#/todo'); await p.getByRole('button', { name: '是同一笔' }).click(); await p.getByText('已合并').waitFor();
  const card = p.locator('section.card', { hasText: '要确认' }); await card.getByLabel(/金额/).fill('66.60'); await card.getByRole('button', { name: '确认入账' }).click(); await p.getByText('都处理完了').waitFor(); await p.screenshot({ path: path.join(OUT, 'e2e-todo.png') });
  const net = a.intake.stats.totals({ from: '2020-01-01', to: '2030-01-01' }).net; assert.equal(net, 2800 + 8635 + 12900 - 12900 + 1990 + 500 + 6660);
  ok('网页处理重复与待确认，合计正确');

  // 6 改分类 → 记住 → 下一笔自动套用
  await p.goto(a.url + '/#/bills/2'); await p.locator('.form select').nth(1).selectOption({ label: '餐饮 / 买菜' }); await p.getByRole('button', { name: '保存修改' }).click(); await p.getByText('已记住：').waitFor();
  await p.locator('.shot').first().click(); await p.locator('dialog.zoom img').waitFor(); await p.keyboard.press('Escape'); await p.screenshot({ path: path.join(OUT, 'e2e-bill.png'), fullPage: true });
  assert.match(await say('新建 绿禾超市 15', /已记/), /餐饮\/买菜/);
  await p.goto(a.url + '/#/cats'); await p.getByText('改分类时记住的').waitFor(); await p.getByRole('button', { name: '撤销' }).first().click(); await p.getByText('已撤销').waitFor();
  ok('改分类 → 记住规则 → 自动套用 → 查看并撤销');

  // 7 总览与统计：数字点进明细对得上
  const total = a.intake.stats.totals({ from: ymd(Date.now()).slice(0, 8) + '01', to: '2030-01-01' }).net;
  await p.goto(a.url + '/#/stats'); await p.locator('.hero .big').waitFor(); const shown = (await p.locator('.hero .big').innerText()).replace(/[¥,]/g, ''); assert.equal(Math.round(Number(shown) * 100), total);
  await p.locator('.hero .big a').click(); await p.locator('.sumline b').first().waitFor(); assert.equal((await p.locator('.sumline b').first().innerText()).replace(/[¥,]/g, ''), shown);
  await p.goto(a.url + '/#/stats'); await p.locator('.brow').first().waitFor();
  for (let i = 0; i < Math.min(4, await p.locator('.brow:not(.sub)').count()); i++) { await p.goto(a.url + '/#/stats'); const b = p.locator('.brow:not(.sub)').nth(i); await b.waitFor(); const v = await b.locator('.num').first().innerText(); await b.click(); await p.locator('.sumline b').first().waitFor(); assert.equal(await p.locator('.sumline b').first().innerText(), v); }
  for (const u of ['周', '季', '年', '自定义']) { await p.goto(a.url + '/#/stats'); await p.getByRole('button', { name: u, exact: true }).click(); await p.locator('.viz svg').waitFor(); }
  const bar = p.locator('.viz a').last(); await bar.hover(); await p.locator('#tip.on').waitFor(); await p.screenshot({ path: path.join(OUT, 'e2e-stats.png'), fullPage: true });
  ok('统计各周期可看，主数字与分类逐个点进明细，合计一致');

  // 8 记一笔（网页上传截图）、搜索、删除恢复、预算
  await p.getByRole('button', { name: '记一笔' }).first().click(); await p.getByLabel('一句话记账').fill('理发 45 昨天'); await p.getByRole('button', { name: '记下来' }).click(); await p.getByText('¥45.00').first().waitFor();
  await p.getByRole('button', { name: '删除' }).click(); await p.locator('dialog').getByRole('button', { name: '删除' }).click(); await p.getByText('已在回收站').waitFor(); await p.getByRole('button', { name: '恢复', exact: true }).click(); await p.getByText('已恢复').waitFor();
  await p.goto(a.url + '/#/bills'); await p.getByLabel('搜索').fill('4200002988202611031234567890'); await p.keyboard.press('Enter'); await until(async () => (await p.locator('a.bill').count()) === 1, '按截图里的单号搜索');
  await p.goto(a.url + '/#/settings'); await p.getByPlaceholder('每月金额').fill('100'); await p.locator('section.card', { hasText: '每月预算' }).getByRole('button', { name: '保存' }).click(); await p.getByText(/超支/).first().waitFor();
  ok('一句话记账、删除恢复、按截图文字搜索、预算超支提示');

  // 9 导出、导入、备份恢复
  await p.goto(a.url + '/#/bills'); const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('link', { name: 'CSV' }).click()]); const csv = fs.readFileSync((await dl.path())!, 'utf8'); assert.ok(csv.startsWith('﻿编号')); assert.equal(csv.trim().split('\r\n').length - 1, a.store.list({ pageSize: 999 }).total);
  await p.goto(a.url + '/#/import'); await p.locator('input[type=file]').setInputFiles({ name: '微信支付账单.csv', mimeType: 'text/csv', buffer: Buffer.from(WECHAT) }); await p.getByRole('button', { name: /入账 \d+ 笔/ }).waitFor(); await p.screenshot({ path: path.join(OUT, 'e2e-import.png'), fullPage: true }); const before = a.store.counts().total; await p.getByRole('button', { name: /入账 \d+ 笔/ }).click(); await p.waitForURL(/import=/); assert.ok(a.store.counts().total > before);
  await p.goto(a.url + '/#/settings'); await p.getByRole('button', { name: '现在备份' }).click(); await p.getByText('已备份').waitFor(); const keep = a.store.counts().total; a.store.remove(1, '测试'); await p.reload(); await p.locator('.row', { hasText: '手动' }).getByRole('button', { name: '恢复', exact: true }).click(); await p.locator('dialog').getByRole('button', { name: '恢复', exact: true }).click(); await p.getByText('已恢复，之前的状态存为').waitFor(); assert.equal(a.store.counts().total, keep);
  ok('CSV 导出、微信账单导入预览入账、备份与恢复');

  // 10 MCP
  await p.getByRole('button', { name: '生成令牌' }).click(); const cmd = await p.locator('.mono').first().innerText(), token = /Bearer (\S+?)"/.exec(cmd)![1]!;
  const c = new Client({ name: 'e2e', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(a.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as any);
  const call = async (n: string, x: any = {}) => JSON.parse(((await c.callTool({ name: n, arguments: x })) as any).content[0].text);
  const s = await call('summarize', { period: 'this_month' }); await p.goto(a.url + '/#/stats'); await p.locator('.hero .big').waitFor(); assert.equal((await p.locator('.hero .big').innerText()).replace(/[¥,]/g, ''), s.net_spend); const d = await call('get_bill', { id: 1 }); assert.ok(!JSON.stringify(d).includes('4200002988202611031234567890')); const img: any = await c.callTool({ name: 'get_attachment', arguments: { id: d.attachments[1].id } }); assert.equal(img.content[1].type, 'image'); fs.writeFileSync(path.join(OUT, 'e2e-mcp-redacted.jpg'), Buffer.from(img.content[1].data, 'base64'));
  await p.goto(a.url + '/#/settings'); await p.locator('section.card', { hasText: 'AI 助手' }).getByRole('button', { name: '撤销' }).click(); await p.locator('dialog').getByRole('button', { name: '撤销' }).click(); await p.getByText('已撤销').first().waitFor(); await assert.rejects(() => call('get_filters'));
  ok('MCP 与网页数字一致、号码遮盖、撤销令牌立即失效');

  // 11 手机与深色
  const m = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark' }), mp = await m.newPage(); await watch(mp); await mp.goto(a.url); await mp.getByLabel('登录密码').fill('test-password'); await mp.getByRole('button', { name: '登录' }).click(); await mp.locator('.hero').waitFor();
  for (const [n, u] of [['home', '#/home'], ['bills', '#/bills'], ['bill', '#/bills/1'], ['todo', '#/todo'], ['stats', '#/stats'], ['cats', '#/cats'], ['settings', '#/settings'], ['import', '#/import'], ['more', '#/more']] as const) { await mp.goto(a.url + '/' + u); await sleep(500); assert.ok((await mp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, `${n} 横向溢出`); await mp.screenshot({ path: path.join(OUT, `e2e-m-${n}.png`), fullPage: n !== 'home' }); }
  await mp.goto(a.url + '/#/home'); await mp.getByRole('button', { name: '记一笔' }).click(); await mp.getByLabel('一句话记账').fill('早饭 6'); await mp.getByRole('button', { name: '记下来' }).click(); await mp.getByText('¥6.00').first().waitFor();
  ok('手机深色：各页无横向溢出，可记账');

  // 12 重启后数据与识别都在
  const cnt = a.store.counts().total; await a.close(); app = await startApp({ ...cfg(mock, dir), receiptDelayMs: 300 }, { ocr, backoff: [50] }); assert.equal(app.store.counts().total, cnt); await until(() => app!.bot!.gateway.state === 'online'); mock.say(U, '新建 重启后 9'); await reply(/已记 #\d+\n支出：¥9\.00/);
  ok('重启后继续可用');
  assert.deepEqual(errors, [], '页面不应有脚本错误');
  console.log('\n端到端全部通过');
} catch (e) { process.stdout.write(`✗ ${(e as Error).stack}\n`); process.exitCode = 1; } finally { await browser.close(); await app?.close(); await mock.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(); }
