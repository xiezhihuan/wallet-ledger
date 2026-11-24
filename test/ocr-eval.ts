/** 识别测试集：真实 Chrome 渲染的合成截图 + 真实本地 OCR。报告各字段准确率与失败样例。 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT } from '../src/config.js';
import { createOcr, docText } from '../src/ocr.js';
import { parseReceipt, type Receipt } from '../src/parse/receipt.js';
import { at, fmtTime } from '../src/time.js';
import { shoot, type Sample } from './screens.js';

export const REF = at(2026, 11, 14, 21, 0);
const which = process.argv[2] ?? 'dev';
const out = path.join(ROOT, 'test-output', 'screens');
fs.mkdirSync(out, { recursive: true });
const mod: Sample[] = which === 'holdout' ? (await import('./screens-holdout.js')).HOLDOUT : (await import('./screens.js')).SAMPLES;
const only = process.argv[3], samples = mod.filter((s) => !only || s.name.includes(only));
const ocr = (await createOcr())!;
const browser = await chromium.launch({ channel: 'chrome' });

const score: Record<string, [number, number]> = {};
const fails: string[] = [];
let falseSure = 0;
const check = (name: string, field: string, ok: boolean, detail: string) => {
  const s = (score[field] ??= [0, 0]); s[1]++;
  if (ok) s[0]++; else fails.push(`${name} · ${field}：${detail}`);
};
const norm = (s: string) => s.replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/\s/g, '');
for (const s of samples) {
  const buf = await shoot(browser, s), f = path.join(out, `${s.name}.${s.jpeg ? 'jpg' : 'png'}`);
  fs.writeFileSync(f, buf);
  const doc = await ocr.recognize(f), r: Receipt = parseReceipt(doc, REF), t = s.truth;
  if (only) console.log(s.name, docText(doc), JSON.stringify(r, null, 1));
  if (t.list) {
    const rows = r.rows ?? [];
    check(s.name, '列表行数', rows.length === t.list.length, `${rows.length}/${t.list.length}`);
    t.list.forEach((x, i) => {
      check(s.name, '列表金额', rows[i]?.amount === x.amount, `第${i + 1}行 ${rows[i]?.amount} ≠ ${x.amount}`);
      check(s.name, '列表类型', rows[i]?.kind === x.kind, `第${i + 1}行 ${rows[i]?.kind} ≠ ${x.kind}`);
      if (x.merchant) check(s.name, '列表商户', norm(rows[i]?.merchant ?? '') === norm(x.merchant), `第${i + 1}行 ${rows[i]?.merchant} ≠ ${x.merchant}`);
    });
    continue;
  }
  if (t.unsure) { check(s.name, '应判待确认', !r.sure && r.doc !== 'list', `却当作确定：${r.amount}`); if (r.sure) falseSure++; continue; }
  check(s.name, '金额', r.amount === t.amount && r.sure, `${r.amount}${r.sure ? '' : '(待确认 ' + r.flags.map((x) => x.reason).join() + ')'} ≠ ${t.amount}`);
  if (r.sure && r.amount !== t.amount) falseSure++;
  check(s.name, '类型', r.kind === t.kind, `${r.kind} ≠ ${t.kind}`);
  if (t.currency) check(s.name, '币种', r.currency === t.currency, r.currency);
  if (t.merchant) check(s.name, '商户', norm(r.merchant) === norm(t.merchant), `${r.merchant} ≠ ${t.merchant}`);
  if (t.time) check(s.name, '时间', fmtTime(r.ms) === t.time, `${fmtTime(r.ms)} ≠ ${t.time}`);
  if (t.method) check(s.name, '支付方式', norm(r.method) === norm(t.method), `${r.method} ≠ ${t.method}`);
  if (t.tradeNo) check(s.name, '交易单号', r.ids.some((i) => i.no === t.tradeNo), `${r.ids.map((i) => i.no)} ≠ ${t.tradeNo}`);
}
await browser.close();
const lines = [`# 识别测试报告（${which === 'holdout' ? '留出集' : '开发集'}，${samples.length} 张合成截图）`, '', '| 字段 | 正确/总数 | 准确率 |', '|---|---|---|', ...Object.entries(score).map(([k, [a, b]]) => `| ${k} | ${a}/${b} | ${((a / b) * 100).toFixed(1)}% |`), '', `把错误金额当成确定结果：${falseSure} 张`, '', fails.length ? `失败样例：\n${fails.map((f) => '- ' + f).join('\n')}` : '没有失败样例。', ''];
console.log(lines.join('\n'));
if (!only) fs.writeFileSync(path.join(ROOT, 'test-output', `ocr-${which}.md`), lines.join('\n'));
process.exit(falseSure ? 1 : 0);
