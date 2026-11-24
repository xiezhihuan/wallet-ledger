import { chromium, devices } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, login } from './helper.js';

const e=await boot(), browser=await chromium.launch({channel:'chrome'}), api=await login(e.app);
try {
  for (const mobile of [false,true]) {
    const kind=mobile?'mobile':'desktop', ctx=await browser.newContext(mobile?devices['iPhone 13']:{viewport:{width:1280,height:850}}), p=await ctx.newPage();
    const id=(await api('/bills',{method:'POST',body:{amount:'3.00',merchant:'合成午餐',occurred:'2026-11-01T12:30'}})).data.id;
    await p.goto(e.app.url+'/#/settings'); await p.getByLabel('登录密码').fill('test-password'); await p.getByRole('button',{name:'登录'}).click();
    await p.getByRole('button',{name:'生成令牌'}).click(); const bearer=/Bearer (\S+?)"/.exec(await p.locator('.mono').first().innerText())![1]!;
    await p.getByPlaceholder('单笔编号').fill(String(id)); await p.getByRole('button',{name:'签发授权码'}).click();
    const grant=await p.locator('.mono').filter({hasText:/^wla_/}).innerText();
    const c=new Client({name:'browser-review',version:'1'});
    await c.connect(new StreamableHTTPClientTransport(new URL(e.app.url+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+bearer}}}) as any);
    const version=e.app.store.require(id).version;
    const request={id,expected_version:version,authorization_code:grant,reason:'按合成凭证纠正',amount:'30.00',request_id:'browser-'+id,preview:false};
    assert.ok(!(await c.callTool({name:'update_bill',arguments:request})).isError);
    await p.getByRole('button',{name:'撤销授权'}).first().click();
    assert.ok((await c.callTool({name:'update_bill',arguments:{...request,preview:true,expected_version:version+1}})).isError); await c.close();
    await p.reload(); const audit=p.locator('section.card').filter({hasText:'MCP 写入审计'});
    await audit.locator('select').filter({has:p.locator('option[value=mcp]')}).selectOption('mcp');
    await audit.locator('select').filter({has:p.locator('option[value=rejected]')}).selectOption('rejected');
    await audit.getByRole('button',{name:'筛选'}).click(); await audit.getByText(/短期授权码已撤销/).first().waitFor();
    const out=path.join('test-output','review-'+kind); fs.mkdirSync(out,{recursive:true});
    await audit.screenshot({path:path.join(out,'audit.png')});
    await p.goto(e.app.url+'/#/bills/'+id); await p.getByRole('button',{name:'已修改',exact:true}).click();
    await p.getByText(/已修改 · /).waitFor();
    const history=p.locator('section.card').filter({has:p.getByRole('heading',{name:'修改记录'})});
    await history.getByText('金额：3.00 元 → 30.00 元').waitFor();
    await history.locator('.evt').first().screenshot({path:path.join(out,'change.png')});
    await history.getByRole('button',{name:'恢复到之前'}).first().click();
    await p.locator('dialog').getByRole('button',{name:'恢复',exact:true}).click();
    await p.getByText(/待重新复核 · 上次/).waitFor(); assert.equal(e.app.store.require(id).amount,300);
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await ctx.close(); console.log(kind+' 通过：网页登录、签发、实际写入、撤销、审计筛选、逐字段对比、恢复与重新复核');
  }
} finally {await browser.close(); await e.stop();}
