// 由 icon.svg 生成网页 PNG 图标与桌面图标（开发时运行，结果已入库）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright-core';
const svg = fs.readFileSync('public/icon.svg', 'utf8'), out = 'desktop/assets'; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const png = async (s, n, f) => { const p = await b.newPage({ viewport: { width: n, height: n } }); await p.setContent(`<style>body{margin:0}svg{display:block;width:${n}px;height:${n}px}</style>${s}`); await p.screenshot({ path: f, omitBackground: true }); await p.close(); };
for (const n of [180, 192, 512]) await png(svg, n, `public/icon-${n}.png`);
// macOS 图标留边：1024 画布里 824 的圆角方块
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-7.77 -7.77 79.54 79.54">${svg.replace(/<\/?svg[^>]*>/g, '')}</svg>`;
const tray = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 8 40 48"><path d="M19 12h26a3 3 0 0 1 3 3v37l-5-3.400-5.300 3.400-5.700-3.400-5.700 3.400-5.300-3.400-5 3.400V15a3 3 0 0 1 3-3z" fill="none" stroke="#000" stroke-width="3.600" stroke-linejoin="round"/><path d="M26 21l6 8 6-8M32 29v12M27 33h10" fill="none" stroke="#000" stroke-width="3.400" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
await png(tray, 18, `${out}/trayTemplate.png`); await png(tray, 36, `${out}/trayTemplate@2x.png`);
const set = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-')) + '/icon.iconset'; fs.mkdirSync(set);
for (const n of [16, 32, 128, 256, 512]) { await png(app, n, `${set}/icon_${n}x${n}.png`); await png(app, n * 2, `${set}/icon_${n}x${n}@2x.png`); }
execFileSync('iconutil', ['-c', 'icns', set, '-o', `${out}/icon.icns`]);
await b.close();
