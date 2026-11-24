// 独立 staging，按锁文件装生产依赖，保留平台所需的 OCR 原生模块和许可证。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(here);
if (process.platform !== 'darwin') throw Error('请在目标 Mac 上打包');
const arch = process.arch, version = JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version;
const stage = path.join(here,'build'), server = path.join(stage,'server'), out = path.join(here,'release');
const sh = (command, args, cwd = here) => execFileSync(command,args,{ cwd, stdio:'inherit' });
const cp = (from,to) => fs.cpSync(from,to,{recursive:true});
fs.rmSync(stage,{recursive:true,force:true});
fs.mkdirSync(server,{recursive:true}); fs.mkdirSync(out,{recursive:true});
sh('npm',['run','build'],root);
for (const f of ['dist','package.json','package-lock.json','models','public','demo-assets']) cp(path.join(root,f),path.join(server,f));
sh('npm',['ci','--omit=dev','--ignore-scripts','--prefer-offline','--no-audit','--no-fund'],server);
for (const f of fs.globSync('node_modules/onnxruntime-node/bin/napi-v*/*',{cwd:server})) {
  if (path.basename(f) !== 'darwin') fs.rmSync(path.join(server,f),{recursive:true});
  else for(const a of fs.readdirSync(path.join(server,f))) if (a !== arch) fs.rmSync(path.join(server,f,a),{recursive:true});
}
for(const f of ['main.cjs','service.mjs','preload.cjs','setup.html','setup.css','setup.js']) cp(path.join(here,f),path.join(stage,f));
fs.writeFileSync(path.join(stage,'package.json'),JSON.stringify({name:'wallet-ledger-desktop',version,productName:'截图账本',main:'main.cjs'}));
const electronVersion = JSON.parse(fs.readFileSync(path.join(here,'node_modules/electron/package.json'))).version;
const zip = 'electron-v'+electronVersion+'-darwin-'+arch+'.zip';
const cache = path.join(os.homedir(),'Library/Caches/electron');
const cached = fs.existsSync(cache) && fs.globSync('*/'+zip,{cwd:cache})[0];
let electronZipDir;
if(cached) {
  const file = path.join(cache,cached), want=JSON.parse(fs.readFileSync(path.join(here,'node_modules/electron/checksums.json')))[zip];
  if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want) throw Error('Electron 安装文件校验失败');
  electronZipDir=path.dirname(file);
}
const [folder] = await packager({dir:stage,out:path.join(here,'build-out'),overwrite:true,platform:'darwin',arch,
  electronVersion,electronZipDir,name:'截图账本',executableName:'WalletLedger',appBundleId:'com.walletledger.personal',
  appCategoryType:'public.app-category.finance',appVersion:version,buildVersion:version,icon:path.join(here,'assets/icon.icns'),asar:false,prune:false,
  extendInfo:{CFBundleDevelopmentRegion:'zh_CN', NSLocalNetworkUsageDescription:'让同一局域网的手机查看本机账本'}});
const bundle = path.join(folder,'截图账本.app');
sh('xattr',['-cr',bundle]); sh('codesign',['--force','--deep','--sign',process.env.CODESIGN_IDENTITY || '-',bundle]); sh('codesign',['--verify','--deep','--strict',bundle]);
const dmg = path.join(out,'WalletLedger-'+version+'-'+arch+'.dmg');
const temp = fs.mkdtempSync(path.join(here,'build-out','image-'));
try {
  sh('ditto',[bundle,path.join(temp,'截图账本.app')]); fs.symlinkSync('/Applications',path.join(temp,'Applications'));
  sh('hdiutil',['create','-quiet','-ov','-volname','截图账本','-srcfolder',temp,'-format','UDZO',dmg]);
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
console.log(dmg);
