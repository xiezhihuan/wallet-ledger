// Optional real Claude Code integration. Only a synthetic bill and a temporary client profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { boot, login, tmp } from './helper.js';
const cli=promisify(execFile), work=tmp(), profile=path.join(work,'claude'), e=await boot();
const opts={cwd:work,env:{...process.env,CLAUDE_CONFIG_DIR:profile,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},timeout:40000};
try {
  fs.mkdirSync(profile,{mode:0o700});
  const api=await login(e.app);
  const form=new FormData(); form.append('amount','9.99');form.append('text','合成午餐。按截图核对金额。');
  form.append('files',new Blob([fs.readFileSync('demo-assets/wx-detail.png')],{type:'image/png'}),'synthetic.png');
  const {data:{id}}=await api('/bills',{method:'POST',form});
  const {data:t}=await api('/mcp-tokens',{method:'POST',body:{name:'隔离 Claude'}});
  const url=e.app.url+'/mcp', config={mcpServers:{ledger:{type:'http',url,headers:{Authorization:'Bearer '+t.token}}}};
  const file=path.join(work,'servers.json'); fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});
  await cli('claude',['mcp','add','--scope','local','--transport','http','ledger',url,'--header','Authorization: Bearer '+t.token],opts);
  const {stdout}=await cli('claude',['mcp','list'],opts);
  if (!/ledger[^\n]*Connected/i.test(stdout)) throw Error('Claude 未报告本地 MCP 已连接');
  console.log('Claude Code 实际握手通过');
  const {stdout:status}=await cli('claude',['auth','status'],opts).catch(()=>({stdout:'{}'}));
  if (!JSON.parse(status).loggedIn) console.log('隔离配置没有模型登录态，模型读图与修改未验证');
  else {
    const {data:g}=await api('/mcp-authorizations',{method:'POST',body:{scope:'bill',bill_id:id}});
    await cli('claude',['-p','--strict-mcp-config','--mcp-config',file,'--tools','','--allowedTools','mcp__ledger__*','--no-session-persistence','--',`用 ledger 查看合成账单 #${id} 及附件，仅根据截图核对金额。用短期码 ${g.code} 预览并提交正确金额，原因写合成演示，最后查日志。`],{...opts,timeout:120000});
    console.log(e.app.store.changes(id).some(c=>c.source==='mcp' && c.fields.amount)?'真实客户端已写入金额，操作留痕':'客户端没有提交金额，模型纠错未验证');
  }
} catch {console.log('客户端验证未全部完成（不输出可能含凭据的命令或响应）');process.exitCode=1;}
finally {await e.stop();fs.rmSync(work,{recursive:true,force:true});}
