// 轻量单页应用：无构建、无第三方依赖。所有用户内容都以文本节点写入，不拼接 HTML。
import { bars, columns } from './charts.js';
import { CAT_ICONS, icon } from './icons.js';

const $app = document.getElementById('app');
let meta = null, sum = null;
if (window.wlDesktop && /Mac/.test(navigator.userAgent)) document.documentElement.classList.add('mac');

// ───────── 基础 ─────────
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'multiple'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(9).filter((x) => x !== null && x !== undefined && x !== false));
  return el;
}
let toastTimer;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  const d = [...document.querySelectorAll('dialog[open]')].at(-1); (d ?? document.body).append(t); // 弹窗在顶层，提示要跟进去
  t.replaceChildren(icon(bad ? 'todo' : 'check'), h('span', {}, msg)); t.className = bad ? 'on bad' : 'on';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), bad ? 4200 : 2600);
}
async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch('/api' + path, { method, headers: { 'x-requested-with': 'wl', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) }).catch(() => { throw new Error('连不上服务，请确认软件在运行'); });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { meta = null; renderLogin(); throw new Error('请先登录'); }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}
const act = (fn) => async (e) => {
  const b = e?.currentTarget;
  if (b?.tagName === 'BUTTON') b.disabled = true;
  try { await fn(e); } catch (err) { toast(err.message, true); } finally { if (b?.tagName === 'BUTTON') b.disabled = false; }
};
const pad = (n) => String(n).padStart(2, '0');
// 时间一律按上海时区显示，与所在电脑时区无关
const sh = (ms) => new Date(ms + 8 * 3600e3);
const ymd = (ms) => sh(ms).toISOString().slice(0, 10), hm = (ms) => sh(ms).toISOString().slice(11, 16), time = (ms) => (ms ? `${ymd(ms)} ${hm(ms)}` : '');
const addDay = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const WK = ['日', '一', '二', '三', '四', '五', '六'];
const dayName = (d) => { const t = meta.today; return d === t ? '今天' : d === addDay(t, -1) ? '昨天' : d.slice(0, 4) === t.slice(0, 4) ? `${+d.slice(5, 7)}月${+d.slice(8)}日` : d; };
const SYM = { CNY: '¥', USD: 'US$', HKD: 'HK$', EUR: '€', GBP: '£', JPY: 'JP¥', KRW: '₩', TWD: 'NT$' };
/** 分 → 文本，纯整数运算 */
const yuan = (c) => `${Math.floor(Math.abs(c) / 100)}.${pad(Math.abs(c) % 100)}`;
export const money = (c, cur = 'CNY') => (c === null || c === undefined ? '待确认' : `${c < 0 ? '−' : ''}${SYM[cur] ?? cur + ' '}${Math.floor(Math.abs(c) / 100).toLocaleString('en-US')}.${pad(Math.abs(c) % 100)}`);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false && (v !== '' ))).toString();
/** 商户、支付方式允许为空串（表示未识别），要保留 */
const billsLink = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== false && (v !== '' || k === 'merchant' || k === 'method')) p.set(k, v); return '#/bills?' + p; };
const copy = async (t) => { try { await navigator.clipboard.writeText(t); } catch { const a = h('textarea', { style: 'position:fixed;opacity:0' }); a.value = t; document.body.append(a); a.select(); document.execCommand('copy'); a.remove(); } toast('已复制'); };
const btn = (ic, text, props = {}) => h('button', { type: 'button', ...props }, ic && icon(ic), text);
const tile = (ic, cls = '') => h('span', { class: `tile ${cls}` }, icon(ic));
const opt = (pairs, cur, first) => [first !== undefined && h('option', { value: '' }, first), ...pairs.map(([v, t]) => h('option', { value: v, selected: String(v) === String(cur ?? '') }, t))];
const fld = (label, input, cls = '') => h('label', { class: `f ${cls}` }, label, input);
const size = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.ceil(n / 1e3) + ' KB');
function dialog(title, build, cls = '') {
  return new Promise((res) => {
    let out = null;
    const d = h('dialog', { class: cls, onclose: () => { document.body.append(document.getElementById('toast')); d.remove(); res(out); } });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.append(...[title && h('h2', {}, title), build((v) => { out = v; d.close(); }, d)].flat().filter(Boolean));
    document.body.append(d); d.showModal();
  });
}
const confirmBox = (title, text, ok = '确定', danger = false) => dialog(title, (done) => [h('p', { class: 'muted', style: 'margin-bottom:18px;white-space:pre-wrap' }, text), h('div', { class: 'row end' }, btn('', '取消', { onclick: () => done(false) }), btn('', ok, { class: danger ? 'primary danger' : 'primary', onclick: () => done(true) }))]);
const cats = (type) => meta.categories.filter((c) => c.type === type);
const catById = (id) => meta.categories.find((c) => c.id === id);
const catIcon = (id) => { const c = catById(id), p = c?.parent_id ? catById(c.parent_id) : c; return p?.icon || 'dots'; };
function catSelect(cur, type, props = {}, first = '未分类') {
  const list = cats(type);
  return h('select', props, h('option', { value: '' }, first), list.filter((c) => !c.parent_id).map((p) => h('optgroup', { label: p.name }, h('option', { value: p.id, selected: p.id === cur }, p.name), list.filter((c) => c.parent_id === p.id).map((c) => h('option', { value: c.id, selected: c.id === cur }, `${p.name} / ${c.name}`)))));
}
const loadMeta = async () => { meta = await api('/meta'); };

// ───────── 路由与框架 ─────────
const NAV = [['home', '总览', 'home'], ['bills', '账单', 'bills'], ['todo', '待确认', 'todo'], ['stats', '统计', 'chart'], ['cats', '分类与规则', 'tag'], ['settings', '设置', 'gear']];
const BOT = { online: ['在线', 'ok'], connecting: ['连接中', 'warn'], offline: ['离线，自动重连中', 'bad'], blocked: ['无法连接', 'bad'], disabled: ['未连接', ''], stopped: ['已停止', 'bad'] };
const route = () => { const [p, q] = (location.hash.slice(1) || '/home').split('?'); const [, page, id] = p.split('/'); return { page: page || 'home', id, q: Object.fromEntries(new URLSearchParams(q)) }; };
const todoN = () => (sum ? sum.pending + sum.dup + sum.batch : 0);
function shell(r, content) {
  const on = (k) => (r.page === k || (k === 'bills' && r.page === 'import') ? 'on' : '');
  const links = meta.demo ? [...NAV.slice(0, 5), ['demo', '演示聊天', 'chat'], NAV[5]] : NAV;
  const [bt, bc] = BOT[sum.bot] ?? BOT.disabled;
  return [h('div', { class: 'drag' }), h('div', { class: 'shell' },
    h('aside', { class: 'side' }, h('a', { class: 'brand', href: '#/home' }, h('img', { src: '/icon.svg', alt: '' }), h('span', {}, h('b', {}, '截图账本'), h('small', {}, meta.demo ? '演示数据' : '钱花到哪里去了'))),
      btn('plus', '记一笔', { class: 'primary', style: 'margin:0 4px 10px', onclick: () => addDialog() }),
      h('nav', { 'aria-label': '主导航' }, links.map(([k, t, ic]) => h('a', { href: `#/${k}`, class: on(k), 'aria-current': r.page === k ? 'page' : undefined }, icon(ic), t, k === 'todo' && todoN() > 0 && h('span', { class: 'n' }, todoN())))),
      h('div', { class: 'foot' }, h('a', { href: '#/settings' }, h('i', { class: `dot ${bc}` }), `QQ 机器人${bt}`), window.wlDesktop ? btn('gear', '控制台', { class: 'ghost', onclick: () => window.wlDesktop.openSettings() }) : btn('logout', '退出登录', { class: 'ghost', onclick: act(async () => { await api('/logout', { method: 'POST' }); meta = null; renderLogin(); }) }))),
    h('main', {}, content)),
  h('nav', { class: 'bottom', 'aria-label': '底部导航' }, [NAV[0], NAV[1]].map(([k, t, ic]) => h('a', { href: `#/${k}`, class: on(k) }, icon(ic), t)), h('button', { class: 'add', 'aria-label': '记一笔', onclick: () => addDialog() }, icon('plus')), h('a', { href: '#/stats', class: on('stats') }, icon('chart'), '统计'), h('a', { href: '#/more', class: ['more', 'todo', 'cats', 'settings', 'demo'].includes(r.page) ? 'on' : '' }, icon('list'), '更多', todoN() > 0 && h('span', { class: 'n' }, todoN())))];
}
let seq = 0;
async function render() {
  const my = ++seq, r = route();
  try {
    if (!meta) await loadMeta();
    const pages = { home: homePage, bills: r.id ? () => billPage(r.id) : () => listPage(r.q), todo: todoPage, stats: () => statsPage(r.q), cats: catsPage, settings: settingsPage, import: () => importPage(r.id), demo: demoPage, more: morePage };
    const [el, s] = await Promise.all([(pages[r.page] ?? homePage)(), api('/summary')]);
    if (my !== seq) return;
    sum = s;
    $app.replaceChildren(...shell(r, typeof el === 'function' ? el() : el));
    document.title = `${NAV.find((n) => n[0] === r.page)?.[1] ?? '账单'} · 截图账本`;
  } catch (e) { if (my === seq && meta) { sum ??= { pending: 0, dup: 0, batch: 0, bot: 'disabled' }; $app.replaceChildren(...shell(r, empty('todo', e.message, h('a', { class: 'btn', href: '#/home' }, '回到总览')))); } }
}
addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && meta && ['home', 'bills', 'todo'].includes(route().page) && !route().id && !document.querySelector('dialog') && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) { loadMeta().then(render, () => {}); } });
const empty = (ic, text, ...more) => h('div', { class: 'empty' }, tile(ic), h('div', {}, text), more.length > 0 && h('div', { class: 'row', style: 'justify-content:center;margin-top:14px' }, more));
const head = (title, sub, ...a) => h('div', { class: 'phead' }, h('div', { class: 'grow' }, h('h1', {}, title), sub && h('p', { class: 'muted' }, sub)), a);

function renderLogin() {
  seq++;
  const pw = h('input', { type: 'password', placeholder: '登录密码', autocomplete: 'current-password', 'aria-label': '登录密码' });
  $app.replaceChildren(h('div', { class: 'login' }, h('form', { class: 'card', onsubmit: async (e) => { e.preventDefault(); try { await api('/login', { method: 'POST', body: { password: pw.value } }); render(); } catch (err) { toast(err.message, true); pw.select(); } } },
    h('img', { src: '/icon.svg', alt: '' }), h('h1', {}, '截图账本'), h('p', { class: 'muted' }, '截图发给 QQ，账自己记好'), pw, h('button', { class: 'primary' }, '登录'))));
  pw.focus();
}

// ───────── 总览 ─────────
function periodLink(s, extra = {}) { return billsLink({ counted: 1, from: s.range.from, to: s.range.to, ...(s.include_pending ? { pending: 1 } : {}), ...extra }); }
function excludedNote(s) {
  const x = s.excluded, l = [];
  if (x.pending.count) l.push(h('a', { class: 'link', href: '#/todo' }, `待确认 ${x.pending.count} 笔${x.pending.amount ? `（约 ${money(x.pending.amount)}）` : ''}`));
  if (x.dup.count) l.push(h('a', { class: 'link', href: '#/todo' }, `疑似重复 ${x.dup.count} 笔`));
  if (x.batch) l.push(h('a', { class: 'link', href: '#/todo' }, `未入账列表 ${x.batch} 张`));
  return l.length > 0 && h('div', { class: 'alert' }, icon('todo'), h('span', {}, '没有计入：', l.map((e, i) => [i > 0 && '、', e])), h('a', { class: 'btn', href: '#/todo' }, '去处理'));
}
const cmpText = (c, name) => (c.percent === null ? `${name}没有数据` : `${name}${c.diff >= 0 ? '多' : '少'} ${money(Math.abs(c.diff))}（${c.percent > 0 ? '+' : ''}${c.percent}%）`);
const budgetBars = (list) => list.map((b) => h('div', { class: 'bud' }, h('div', { class: 'row' }, h('span', {}, b.name, b.state === 'over' && h('span', { class: 'tagx dup', style: 'margin-left:8px' }, `超支 ${money(-b.left)}`), b.state === 'near' && h('span', { class: 'tagx pending', style: 'margin-left:8px' }, '快超了')), h('span', { class: 'num muted' }, `${money(b.used)} / ${money(b.amount)}`)), h('div', { class: `meter ${b.state}`, role: 'progressbar', 'aria-valuenow': b.percent, 'aria-label': `${b.name}已用 ${b.percent}%` }, h('i', { style: `width:${Math.min(100, Math.max(0, b.percent))}%` }))));
async function homePage() {
  const [s, w, y, recent] = await Promise.all([api('/stats?unit=month'), api('/stats?unit=week'), api('/stats?unit=year'), api('/bills?pageSize=8')]);
  const [today] = await Promise.all([api('/stats?unit=day')]);
  if (!recent.total) return [head('总览'), h('div', { class: 'card' }, empty('wallet', '还没有账。把付款截图发给 QQ 机器人，或在这里记第一笔。', btn('plus', '记一笔', { class: 'primary', onclick: () => addDialog() }), h('a', { class: 'btn', href: '#/settings' }, '连接 QQ')))];
  const total = s.budget.find((b) => b.category_id === 0);
  return h('div', { class: 'gap' }, 
    h('section', { class: 'hero' }, h('div', { class: 'lab' }, `${s.label}花了`, h('span', { class: 'tagx' }, `${s.count} 笔`), s.refund > 0 && h('span', { class: 'tagx' }, `已扣退款 ${money(s.refund)}`)),
      h('b', { class: 'big num' }, h('a', { href: periodLink(s), title: '看明细' }, money(s.net))),
      h('div', { class: 'muted' }, [`日均 ${money(s.daily)}`, cmpText(s.prev, '比上月同期'), s.yoy.percent !== null && cmpText(s.yoy, '比去年同期')].filter(Boolean).join('　·　')),
      total && budgetBars([total]),
      h('div', { class: 'facts' }, [['今天', today], ['本周', w], ['今年', y]].map(([t, x]) => h('a', { href: periodLink(x) }, h('small', {}, t), h('b', {}, money(x.net)))), h('a', { href: billsLink({ kind: 'income', status: 'ok', from: s.range.from, to: s.range.to }) }, h('small', {}, '本月收入'), h('b', {}, money(s.excluded.income.amount))))),
    excludedNote(s),
    s.budget.filter((b) => b.category_id && b.state !== 'ok').map((b) => h('div', { class: `alert ${b.state === 'over' ? 'bad' : ''}` }, icon('target'), `${b.name}预算 ${b.state === 'over' ? `超支 ${money(-b.left)}` : `已用 ${b.percent}%`}`, h('a', { class: 'btn', href: periodLink(s, { category: b.category_id }) }, '看明细'))),
    h('div', { class: 'g2' },
      h('div', { class: 'gap' }, h('section', { class: 'card' }, h('h2', {}, '花到哪里去了', h('a', { class: 'muted', href: '#/stats' }, '详细统计 ›')), s.by_category.length ? catBars(s, 8) : empty('bowl', '这个月还没有消费')),
        h('section', { class: 'card' }, h('h2', {}, '每天花多少'), trendChart(s))),
      h('section', { class: 'card', style: 'padding:16px 0 4px' }, h('h2', { style: 'padding:0 16px' }, '最近的账', h('a', { class: 'muted', href: '#/bills' }, '全部 ›')), recent.items.map(billRow))));
}
function catBars(s, n = 99) {
  const rows = s.by_category, top = rows.slice(0, n), rest = rows.slice(n);
  const list = top.map((c) => ({ ...c, icon: tile(c.icon || 'dots', 'sm'), href: periodLink(s, { category: c.id ?? 'none' }), children: c.children.map((x) => ({ ...x, href: periodLink(s, { category: x.id ?? 'none' }) })) }));
  return h('div', {}, bars(list, { fmt: money, h }), rest.length > 0 && h('p', { class: 'muted s', style: 'padding:6px 8px' }, `另有 ${rest.length} 类共 ${money(rest.reduce((a, b) => a + b.net, 0))}，见`, h('a', { class: 'link', href: '#/stats' }, '统计')));
}
function trendChart(s) {
  const u = s.trend.unit, now = s.trend.points.findIndex((p) => p.from <= meta.today && meta.today <= p.to);
  return columns(s.trend.points.map((p) => ({ ...p, label: u === 'day' ? `${p.from} 周${WK[new Date(p.from).getUTCDay()]}` : u === 'week' ? `${p.from} 起一周` : p.from.slice(0, 7), sub: u === 'day' ? String(+p.from.slice(8)) : u === 'week' ? p.from.slice(5) : `${+p.from.slice(5, 7)}月`, href: billsLink({ counted: 1, from: p.from, to: p.to, ...(s.include_pending ? { pending: 1 } : {}) }) })), { fmt: money, now });
}

// ───────── 账单列表 ─────────
const KINDT = { income: '收入', refund: '退款', transfer: '转账', repay: '还款' };
function billRow(b) {
  const name = b.merchant || b.item || (b.status === 'batch' ? '账单列表' : b.kind === 'transfer' ? '转账' : b.kind === 'repay' ? '还款' : '未识别商户');
  const inn = b.kind === 'income' || b.kind === 'refund', off = b.kind === 'transfer' || b.kind === 'repay' || (b.status !== 'ok' && b.status !== 'pending');
  const left = b.batch ? b.batch.filter((r) => !r.done).length : 0;
  return h('a', { class: 'bill', href: `#/bills/${b.id}` }, tile(b.status === 'batch' ? 'list' : b.kind === 'expense' || b.kind === 'income' ? catIcon(b.category_id) : b.kind === 'refund' ? 'undo' : 'bank'),
    h('span', { style: 'min-width:0' }, h('span', { class: 't' }, h('b', {}, name), b.status !== 'ok' && h('span', { class: `tagx ${b.status}` }, meta.status[b.status]), b.status === 'ok' && b.flags.length > 0 && h('span', { class: 'tagx', title: b.flags.map((f) => f.reason).join('；') }, '有没把握的'), b.refunded > 0 && h('span', { class: 'tagx' }, b.refunded >= b.amount ? '已全退' : `已退 ${money(b.refunded)}`)),
      h('span', { class: 'd' }, [`#${b.id}`, dayName(b.day) + (b.time_src === 'day' ? '' : ' ' + hm(b.occurred_at)), b.status === 'batch' ? `${left} 笔待入账` : KINDT[b.kind] && b.kind !== 'income' ? KINDT[b.kind] : b.category, b.method, b.note && b.note.split('\n')[0]].filter(Boolean).join(' · '))),
    h('span', { class: 'row', style: 'flex-wrap:nowrap;gap:12px' }, b.thumb && h('img', { class: 'thumb', src: `/api/attachments/${b.thumb}`, alt: '', loading: 'lazy' }), b.status === 'batch' ? null : h('span', { class: `amt ${b.amount === null || b.status === 'pending' ? 'q' : off ? 'off' : inn ? 'in' : ''}` }, b.amount === null ? '待填' : `${inn ? '+' : ''}${money(b.amount, b.currency)}`)));
}
function dayGroups(items) {
  const g = [];
  for (const b of items) { const l = g.at(-1); if (l && l[0] === b.day) l[1].push(b); else g.push([b.day, [b]]); }
  return g.map(([d, l]) => { const n = l.filter((b) => b.status === 'ok' && b.currency === 'CNY').reduce((a, b) => a + b.spend, 0); return h('section', { class: 'day' }, h('div', { class: 'dayh' }, h('b', {}, dayName(d)), h('span', {}, `周${WK[new Date(d).getUTCDay()]}`), n !== 0 && h('span', { class: 'num' }, `消费 ${money(n)}`)), h('div', { class: 'led' }, l.map(billRow))); });
}
async function listPage(q) {
  const r = await api('/bills?' + new URLSearchParams(q));
  const go = (p) => { const n = { ...q, ...p, page: p.page ?? '' }; for (const k of Object.keys(n)) if (n[k] === '' && !(['merchant', 'method'].includes(k) && k in q && !(k in p))) delete n[k]; location.hash = '#/bills' + (Object.keys(n).length ? '?' + new URLSearchParams(n) : ''); };
  const sel = (k, pairs, first) => h('select', { 'aria-label': first, onchange: (e) => go({ [k]: e.target.value }) }, opt(pairs, q[k], first));
  const inp = (k, ph, type = 'text') => h('input', { type, value: q[k] ?? '', placeholder: ph, 'aria-label': ph, onchange: (e) => go({ [k]: e.target.value }) });
  const adv = ['kind', 'category', 'method', 'from', 'to', 'min', 'max', 'source', 'image', 'currency'].some((k) => k in q) && !q.counted;
  const box = h('div', { class: 'fgrid', hidden: !adv }, sel('kind', Object.entries(meta.kinds), '全部类型'), h('select', { 'aria-label': '全部分类', onchange: (e) => go({ category: e.target.value }) }, h('option', { value: '' }, '全部分类'), h('option', { value: 'none', selected: q.category === 'none' }, '未分类'), [...catSelect(Number(q.category), 'expense').children].slice(1), [...catSelect(Number(q.category), 'income').children].slice(1)), sel('method', meta.methods.map((m) => [m, m]), '全部支付方式'), sel('source', Object.entries(meta.sources), '全部来源'), fld('从', inp('from', '开始日期', 'date')), fld('到', inp('to', '结束日期', 'date')), fld('最低金额', inp('min', '元')), fld('最高金额', inp('max', '元')), sel('currency', [['CNY', '人民币'], ['foreign', '外币']], '全部币种'), sel('sort', [['amount', '金额从大到小'], ['old', '时间从早到晚'], ['id', '按编号']], '时间从近到远'));
  const chip = (text, p, on) => h('button', { class: 'chip', 'aria-pressed': String(on), onclick: () => go(on ? Object.fromEntries(Object.keys(p).map((k) => [k, ''])) : p) }, text);
  const ctx = [];
  if (q.counted) ctx.push('计入消费统计的账', `${q.from} ~ ${q.to}`, q.pending && '含待确认', q.category && (q.category === 'none' ? '未分类' : catName(Number(q.category))), 'merchant' in q && (q.merchant || '未识别商户'), 'method' in q && (q.method || '未知支付方式'));
  const pages = Math.ceil(r.total / 30), page = Number(q.page) || 1;
  return [head('账单', q.deleted ? '回收站：删除的账都能恢复' : `共 ${r.total} 笔`, h('a', { class: 'btn', href: '/api/export/csv?' + new URLSearchParams(q), download: '' }, icon('dl'), 'CSV'), h('a', { class: 'btn', href: '/api/export/json?' + new URLSearchParams(q), download: '' }, 'JSON'), h('a', { class: 'btn', href: '#/import' }, icon('up'), '导入账单')),
    h('div', { class: 'fbar' }, h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); go({ q: e.target.q.value }); } }, h('input', { name: 'q', type: 'search', value: q.q ?? '', placeholder: '搜商户、备注、金额、截图里的字、#编号', 'aria-label': '搜索', class: 'grow', style: 'width:auto' }), btn('filter', '筛选', { 'aria-expanded': String(adv), onclick: (e) => { box.hidden = !box.hidden; e.currentTarget.setAttribute('aria-expanded', String(!box.hidden)); } })), box,
      h('div', { class: 'chips' }, chip('待处理', { status: 'todo' }, q.status === 'todo'), chip('有没把握的', { soft: '1' }, q.soft === '1'), chip('有截图', { image: '1' }, q.image === '1'), chip('退款', { kind: 'refund' }, q.kind === 'refund'), chip('转账还款', { kind: 'transfer' }, q.kind === 'transfer'), chip('回收站', { deleted: '1' }, q.deleted === '1'), Object.keys(q).length > 0 && h('a', { class: 'chip btn', href: '#/bills' }, '清除条件'))),
    ctx.length > 0 && h('div', { class: 'alert info', style: 'margin-top:12px' }, icon('filter'), h('span', {}, ctx.filter(Boolean).join(' · '))),
    r.total > 0 && h('div', { class: 'sumline' }, h('span', {}, '净消费 ', h('b', {}, money(r.sum.net))), r.sum.refund > 0 && h('span', {}, `支出 ${money(r.sum.expense)} − 退款 ${money(r.sum.refund)}`), r.sum.income > 0 && h('span', {}, '收入 ', h('b', {}, money(r.sum.income))), h('span', { class: 'muted s' }, '合计只含已入账的人民币')),
    r.items.length ? (q.sort === 'amount' || q.sort === 'id' ? h('div', { class: 'led' }, r.items.map(billRow)) : dayGroups(r.items)) : empty('search', '没有符合条件的账'),
    pages > 1 && h('div', { class: 'row', style: 'justify-content:center;margin-top:18px' }, btn('left', '上一页', { disabled: page <= 1, onclick: () => go({ page: page - 1 }) }), h('span', { class: 'num muted' }, `${page} / ${pages}`), btn('right', '下一页', { disabled: page >= pages, onclick: () => go({ page: page + 1 }) }))];
}
const catName = (id) => { const c = catById(id), p = c?.parent_id ? catById(c.parent_id) : null; return c ? (p ? `${p.name}/${c.name}` : c.name) : '未分类'; };

// ───────── 详情 ─────────
const zoom = (src) => dialog('', (done) => h('img', { src, alt: '截图大图', onclick: () => done() }), 'zoom');
function flagBox(d, onPick) {
  return h('div', { class: 'flags' }, d.flags.map((f) => h('div', {}, h('div', { class: 'fl' }, h('span', { class: `tagx ${f.hard ? 'pending' : ''}` }, f.hard ? '要确认' : '没把握'), f.reason), f.candidates?.length > 0 && f.hard && h('div', { class: 'cands' }, [...new Set(f.candidates)].map((c) => btn('', `就是 ${money(c, d.currency)}`, { class: 'chip', onclick: act(() => onPick(c)) }))))));
}
function afterLearn(d) {
  if (!d.learned) return toast('已保存');
  toast(`已记住：「${d.learned.pattern}」归到 ${d.learned.category}`);
  if (d.learned.others > 0) confirmBox('同商户的其他账也改吗？', `还有 ${d.learned.others} 笔「${d.learned.pattern}」不在 ${d.learned.category}。要一起改过去吗？（手动改过分类的不会动）`, '一起改').then(act(async (ok) => { if (ok) { const r = await api('/reclassify', { method: 'POST', body: { subject: d.learned.pattern } }); toast(`改了 ${r.changed} 笔`); render(); } }));
}
async function billPage(id) {
  const d = await api(`/bills/${id}`);
  const reload = async (t) => { if (t) toast(t); await loadMeta(); await render(); };
  const back = h('a', { class: 'btn ghost', href: 'javascript:void 0', onclick: (e) => { e.preventDefault(); history.length > 1 ? history.back() : (location.hash = '#/bills'); } }, icon('left'), '返回');

  const form = {};
  const type = d.kind === 'income' ? 'income' : 'expense';
  form.amount = h('input', { value: d.amount === null ? '' : yuan(d.amount), inputmode: 'decimal', placeholder: '金额', class: 'num' });
  form.currency = h('input', { value: d.currency, maxlength: 3, list: 'curs' });
  form.kind = h('select', {}, opt(Object.entries(meta.kinds), d.kind));
  form.occurred = h('input', { type: 'datetime-local', value: time(d.occurred_at).replace(' ', 'T') });
  form.merchant = h('input', { value: d.merchant, list: 'merchants', placeholder: '商户' });
  form.item = h('input', { value: d.item, placeholder: '买了什么' });
  form.category_id = catSelect(d.category_id, type);
  form.method = h('input', { value: d.method, list: 'methods', placeholder: '微信 / 支付宝 / 银行卡' });
  form.trade_no = h('input', { value: d.trade_no, placeholder: '没有可不填' });
  form.note = h('textarea', { rows: 2 }, d.note);
  const orig = Object.fromEntries(Object.entries(form).map(([k, e]) => [k, e.value]));
  const changes = () => Object.fromEntries(Object.entries(form).filter(([k, e]) => e.value !== orig[k]).map(([k, e]) => [k, k === 'category_id' ? (e.value ? Number(e.value) : null) : e.value]));
  const save = act(async () => { const c = changes(); if (!Object.keys(c).length) return toast('没有改动'); const r = await api(`/bills/${id}`, { method: 'PATCH', body: c }); await reload(); afterLearn(r); });
  const pick = async (c) => { await api(`/bills/${id}/confirm`, { method: 'POST', body: { amount: yuan(c) } }); await reload('已确认'); };
  const inn = d.kind === 'income' || d.kind === 'refund';
  const asks = [];
  const reviewNote = h('input', { placeholder: '复核说明（有疑问时填写）', class: 'grow' });
  const reviewAction = (result, label, ic) => btn(ic, label, { class: 'ghost', onclick: act(async () => { await api(`/bills/${id}/review`, { method: 'POST', body: { result, note: reviewNote.value } }); await reload('已记录复核'); }) });
  asks.push(h('section', { class: 'card col' },
    h('h2', {}, icon('check'), '复核状态'),
    d.review ? h('p', { class: 'muted s' }, `${d.review.bill_version !== d.version ? '待重新复核 · 上次' : ''}${d.review.result === 'ok' ? '无误' : d.review.result === 'question' ? '有疑问' : '已修改'} · ${time(d.review.reviewed_at)} · ${d.review.reviewer}`, d.review.note && `：${d.review.note}`) : h('p', { class: 'muted s' }, '尚未复核，复核后账单再次修改会重新进入待复核列表'),
    h('div', { class: 'row' }, reviewAction('ok', '无误', 'check'), reviewAction('question', '有疑问', 'todo'), reviewAction('modified', '已修改', 'check'), reviewNote)
  ));
  if (d.status === 'dup' && d.dup) asks.push(h('section', { class: 'card col' }, h('h2', {}, icon('copy'), '可能记过了', h('span', { class: 'muted' }, d.dup_why)), h('p', {}, '这笔暂不计入统计。和下面这笔是同一笔吗？'), h('div', { class: 'led' }, billRow({ ...d.dup, thumb: null })), h('div', { class: 'row' }, btn('link', '是同一笔，只算一次', { class: 'primary', onclick: act(async () => { const r = await api(`/bills/${id}/dup`, { method: 'POST', body: { same: true } }); location.hash = `#/bills/${r.id}`; toast('已合并，重复的进了回收站'); }) }), btn('', '不是，两笔都算', { onclick: act(async () => { await api(`/bills/${id}/dup`, { method: 'POST', body: { same: false } }); await reload('已计入'); }) }))));
  if (d.flags.length) asks.push(h('section', { class: 'card col' }, h('h2', {}, icon('todo'), d.status === 'pending' ? '待确认，暂不计入统计' : '个别信息没把握（已计入统计）'), flagBox(d, pick), d.status === 'pending' && d.amount !== null && h('div', { class: 'row' }, btn('check', `确认 ${meta.kinds[d.kind]} ${money(d.amount, d.currency)}`, { class: 'primary', onclick: act(async () => { const c = changes(); await api(`/bills/${id}/confirm`, { method: 'POST', body: c }); await reload('已确认入账'); }) }))));
  if (d.kind === 'refund') asks.push(h('section', { class: 'card col' }, h('h2', {}, icon('undo'), '退的是哪一笔'), d.original ? h('div', { class: 'led' }, billRow(d.original)) : h('p', { class: 'muted' }, '还没关联原支出，按到账日冲减。'), !d.original && d.refund_candidates.map((o) => h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('div', { class: 'led grow' }, billRow(o)), btn('link', '就是它', { onclick: act(async () => { await api(`/bills/${id}`, { method: 'PATCH', body: { refund_of: o.id } }); await reload('已关联'); }) }))), h('div', { class: 'row' }, (() => { const i = h('input', { placeholder: '原支出编号', inputmode: 'numeric', style: 'width:130px' }); return [i, btn('link', '关联', { onclick: act(async () => { await api(`/bills/${id}`, { method: 'PATCH', body: { refund_of: Number(i.value.replace('#', '')) || null } }); await reload('已关联'); }) })]; })(), d.original && btn('', '取消关联', { class: 'ghost', onclick: act(async () => { await api(`/bills/${id}`, { method: 'PATCH', body: { refund_of: null } }); await reload('已取消'); }) }))));
  if (d.refunds.length) asks.push(h('section', { class: 'card col' }, h('h2', {}, icon('undo'), '退款', h('span', { class: 'muted' }, `已退 ${money(d.refunded)}，净支出 ${money(d.amount - d.refunded)}`)), h('div', { class: 'led' }, d.refunds.map(billRow))));
  const top = h('section', { class: 'card col' }, h('div', { class: 'dhead' }, tile(catIcon(d.category_id)), h('div', { class: 'grow' }, h('div', { class: 'muted' }, `#${d.id} · ${meta.kinds[d.kind]}`, d.status !== 'ok' && h('span', { class: `tagx ${d.status}`, style: 'margin-left:8px' }, meta.status[d.status])), h('div', { class: `amt ${inn ? 'in' : ''}`, style: 'text-align:left' }, d.amount === null ? '金额待填' : `${inn ? '+' : ''}${money(d.amount, d.currency)}`))), (d.kind === 'transfer' || d.kind === 'repay') && h('div', { class: 'alert info' }, icon('info'), '转账和还信用卡不算消费。如果这其实是买东西，把类型改成「支出」。'), d.currency !== 'CNY' && h('div', { class: 'alert info' }, icon('info'), '外币单独统计，不与人民币相加。'));
  const info = h('section', { class: 'card' }, h('h2', {}, '信息', h('span', { class: 'muted' }, d.category_why && `分类依据：${d.category_why}`)), h('div', { class: 'form' }, fld('金额', form.amount), fld('类型', form.kind), fld('时间（上海）', form.occurred), fld('分类', form.category_id), fld('商户', form.merchant), fld('支付方式', form.method), fld('说明', form.item), fld('币种', form.currency), fld('交易单号', form.trade_no, 'w'), fld('备注', form.note, 'w')), h('div', { class: 'row end', style: 'margin-top:14px' }, btn('check', '保存修改', { class: 'primary', onclick: save })));
  const fieldNames = {amount:'金额',currency:'币种',kind:'类型',merchant:'商户',note:'备注',item:'说明',occurred_at:'交易时间',day:'归属日',category_id:'分类',method:'支付方式',trade_no:'交易单号',refund_of:'原支出',status:'状态',locked:'人工指定字段',flags:'待核对事项',evidence_ids:'素材编号',learned_rule:'记住归类规则',deleted_at:'删除时间',category_why:'归类原因',category_src:'分类来源',time_src:'时间来源',confirmed:'已确认',dup_of:'疑似重复',ids:'交易标识'};
  const fieldValue = (k,v) => {
    if (v === null || v === '') return '空';
    if (k === 'amount') return yuan(v)+' 元';
    if (k === 'occurred_at' || k === 'deleted_at') return time(v);
    if (k === 'kind') return meta.kinds[v] ?? v;
    if (k === 'status') return meta.status[v] ?? v;
    if (k === 'category_id') return meta.categories.find(x => x.id === v)?.name ?? '#'+v;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const changeHistory = h('section', { class: 'card' }, h('h2', {}, icon('clock'), '修改记录'), d.changes?.length ? d.changes.map((c) => { const fields = Object.entries(c.fields).map(([k, v]) => h('div', { class: 's' }, `${fieldNames[k] ?? k}：${fieldValue(k,v.before)} → ${fieldValue(k,v.after)}`)); const restore = btn('undo', '恢复到之前', { class: 'ghost', onclick: act(async () => { if (await confirmBox('恢复这次修改之前的内容？', '恢复本身也会新增一条修改记录。', '恢复')) { await api(`/bills/${id}/restore-change/${c.id}`, { method: 'POST' }); await reload('已恢复'); } }) }); return h('div', { class: 'evt' }, h('time', {}, time(c.at)), h('span', { class: 'grow' }, h('b', {}, `${c.source} · ${c.reason}`), h('div', { class: 's muted' }, `版本 ${c.before_version} → ${c.after_version} · ${who(c.actor)}${c.authorization_id ? ' · 授权 #'+c.authorization_id : ''}`), fields), restore); }) : h('p', { class: 'muted' }, '还没有逐字段修改记录'), d.events.map((e) => h('div', { class: 'evt' }, h('time', {}, time(e.at)), h('span', {}, h('b', {}, e.action), ' ', e.detail, h('span', { class: 'muted' }, ` — ${who(e.actor)}`)))));
  const mergeButton = btn('link', '并入另一笔', { onclick: act(async () => { const to = await dialog('并入另一笔', (done) => { const i = h('input', { placeholder: '目标编号，例如 12', inputmode: 'numeric' }); return [h('p', { class: 'muted' }, '截图和文字会移到目标账，恢复目标金额。'), i, h('div', { class: 'row end' }, btn('', '取消', { onclick: () => done(null) }), btn('', '并入', { class: 'primary', onclick: () => done(i.value.replace('#', '')) }))]; }); if (to) { await api(`/bills/${id}/merge`, { method: 'POST', body: { into: Number(to) } }); location.hash = `#/bills/${Number(to)}`; } }) });
  const toolbar = h('div', { class: 'row', style: 'margin-bottom:12px' }, back, h('span', { class: 'grow' }), !d.deleted_at && mergeButton, d.deleted_at ? btn('undo', '恢复', { class: 'primary', onclick: act(async () => { await api(`/bills/${id}/restore`, { method: 'POST' }); await reload('已恢复'); }) }) : btn('trash', '删除', { class: 'danger', onclick: act(async () => { if (await confirmBox('删除这笔账？', '删除后不再计入统计，可在回收站恢复。', '删除', true)) { await api(`/bills/${id}`, { method: 'DELETE' }); await reload('已删除，可在回收站恢复'); } }) }));
  const warning = d.deleted_at && h('div', { class: 'alert bad' }, icon('trash'), `已在回收站（${time(d.deleted_at)} 删除），不计入统计`);
  if (d.status === 'batch' || d.status === 'batch_done') return [h('div', { class: 'row', style: 'margin-bottom:12px' }, back), head(`账单列表 #${d.id}`, `${time(d.occurred_at)} 收到`), batchCard(d, reload), asks[0], changeHistory, evidenceCard(d, reload)];
  const det = h('div', { class: 'det' }, h('div', { class: 'gap' }, top, asks, info, changeHistory), h('div', { class: 'gap' }, evidenceCard(d, reload)));
  return [h('datalist', { id: 'merchants' }, meta.merchants.map((m) => h('option', { value: m }))), h('datalist', { id: 'methods' }, meta.methods.map((m) => h('option', { value: m }))), h('datalist', { id: 'curs' }, Object.keys(SYM).map((m) => h('option', { value: m }))), toolbar, warning, det];
}
const who = (a) => (meta.users.find((u) => u.openid === a) ? `QQ ${meta.users.find((u) => u.openid === a).nickname || '用户'}` : /^[0-9A-Z]{16,}$/i.test(a) ? 'QQ 用户' : a);
function evidenceCard(d, reload) {
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: act(async (e) => { const f = new FormData(); for (const x of e.target.files) f.append('files', x); await api(`/bills/${d.id}/messages`, { method: 'POST', form: f }); await reload('已补充'); }) });
  const note = h('input', { placeholder: '补充一句说明' });
  return h('section', { class: 'card' }, h('h2', {}, icon('img'), '原始截图和文字', h('span', { class: 'muted' }, `${d.evidence.length} 份`)),
    d.evidence.length ? d.evidence.map((e) => h('div', { class: 'ev' }, h('div', { class: 'row s muted' }, `${time(e.sent_at)} · ${e.channel === 'qq' ? 'QQ' : '网页'}`, h('span', { class: 'grow' }), d.status !== 'batch' && d.status !== 'batch_done' && e.bill_id === d.id && d.evidence.length > 1 && btn('cut', '拆成另一笔', { class: 'ghost', style: 'min-height:26px;padding:0 8px', onclick: act(async () => { const r = await api(`/evidence/${e.id}/move`, { method: 'POST', body: {} }); toast(`已拆成 #${r.id}`); location.hash = `#/bills/${r.id}`; }) })),
      e.attachment_id ? (e.has_file ? (e.att_kind === 'image' ? h('img', { class: 'shot', src: `/api/attachments/${e.attachment_id}`, alt: '原始截图', onclick: () => zoom(`/api/attachments/${e.attachment_id}`) }) : h('a', { class: 'link', href: `/api/attachments/${e.attachment_id}`, target: '_blank' }, e.filename || '打开附件')) : h('div', { class: 'alert bad' }, e.att_status === 'failed' ? `没能保存：${e.error ?? ''}` : '正在下载…', e.att_status === 'failed' && btn('', '重试', { onclick: act(async () => { await api(`/attachments/${e.attachment_id}/retry`, { method: 'POST' }); setTimeout(() => reload('已重试'), 1500); }) }))) : h('div', { style: 'white-space:pre-wrap' }, e.text),
      e.ocr_text && h('details', {}, h('summary', { class: 's muted' }, '识别出的文字'), h('pre', {}, e.ocr_text)))) : h('p', { class: 'muted' }, '没有原始素材（手工或导入）。'),
    !d.deleted_at && d.status !== 'batch' && d.status !== 'batch_done' && h('form', { class: 'row', style: 'margin-top:12px', onsubmit: act(async (e) => { e.preventDefault(); if (!note.value.trim()) return; const f = new FormData(); f.append('text', note.value); await api(`/bills/${d.id}/messages`, { method: 'POST', form: f }); await reload('已补充'); }) }, h('span', { class: 'grow' }, note), btn('img', '补图', { onclick: () => files.click() }), files));
}
function batchCard(d, reload) {
  const boxes = d.batch.map((r) => h('input', { type: 'checkbox', checked: !r.done && !r.dup && !r.skip, disabled: !!r.done }));
  const rows = d.batch.map((r, i) => h('tr', {}, h('td', {}, h('label', { class: 'c' }, boxes[i], String(i + 1))), h('td', {}, r.ms === null ? '—' : time(r.ms).slice(5)), h('td', {}, r.merchant || '—', ' ', r.kind !== 'expense' && h('span', { class: 'tagx' }, meta.kinds[r.kind])), h('td', { class: 'num' }, `${r.kind === 'income' || r.kind === 'refund' ? '+' : ''}${money(r.amount, r.currency)}`), h('td', {}, r.done ? h('a', { class: 'link', href: `#/bills/${r.done}` }, `已入账 #${r.done}`) : r.dup ? h('a', { class: 'link', href: `#/bills/${r.dup.id}` }, `疑似 #${r.dup.id}`) : r.skip ? '交易未成功' : r.sure ? '' : '金额没把握', r.note && ` ${r.note}`)));
  const left = d.batch.some((r) => !r.done);
  return h('section', { class: 'card col', style: 'margin-bottom:16px' }, h('h2', {}, icon('list'), `${d.batch.length} 笔`, h('span', { class: 'muted' }, d.status === 'batch' ? '还没入账，不计入统计 ' : '已处理 ', route().id ? null : h('a', { class: 'link', href: `#/bills/${d.id}` }, '看原图'))), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['行', '时间', '商户', '金额', ''].map((t, i) => h('th', { class: i === 3 ? 'num' : '' }, t)))), h('tbody', {}, rows))),
    d.status === 'batch' ? h('div', { class: 'row' }, left && btn('check', '勾选的入账', { class: 'primary', onclick: act(async () => { const p = boxes.map((b, i) => (b.checked && !b.disabled ? i + 1 : 0)).filter(Boolean); if (!p.length) throw new Error('请先勾选'); const r = await api(`/bills/${d.id}/commit`, { method: 'POST', body: { rows: p } }); await reload(`入账 ${r.created.length} 笔`); }) }), btn('', '剩下的不入账', { onclick: act(async () => { await api(`/bills/${d.id}/close`, { method: 'POST' }); await reload('已关闭'); }) })) : left && btn('undo', '重新打开', { onclick: act(async () => { await api(`/bills/${d.id}/reopen`, { method: 'POST' }); await reload(); }) }));
}

// ───────── 待确认 ─────────
async function todoPage() {
  const [r, soft] = await Promise.all([api('/bills?status=todo&sort=id&pageSize=100'), api('/bills?soft=1&pageSize=30')]);
  const reload = async (t) => { if (t) toast(t); await render(); };
  const card = async (b) => {
    const d = await api(`/bills/${b.id}`), shot = d.evidence.find((e) => e.att_kind === 'image' && e.has_file);
    if (d.status === 'batch') return h('div', {}, batchCard(d, reload));
    const amt = h('input', { value: d.amount === null ? '' : yuan(d.amount), inputmode: 'decimal', placeholder: '金额', 'aria-label': `#${d.id} 金额`, class: 'num', style: 'width:120px' });
    return h('section', { class: 'card' }, h('div', { class: 'row', style: 'flex-wrap:nowrap;align-items:flex-start;gap:14px' }, shot && h('img', { src: `/api/attachments/${shot.attachment_id}`, alt: '截图', style: 'width:92px;max-height:150px;object-fit:cover;object-position:top;border-radius:10px;border:1px solid var(--line);cursor:zoom-in', onclick: () => zoom(`/api/attachments/${shot.attachment_id}`) }),
      h('div', { class: 'col grow' }, h('a', { class: 'row', href: `#/bills/${d.id}` }, h('b', {}, d.merchant || d.item || d.note.split('\n')[0] || '未识别商户'), h('span', { class: `tagx ${d.status}` }, meta.status[d.status]), h('span', { class: 'muted s' }, `#${d.id} · ${time(d.occurred_at).slice(5)}`)), flagBox(d, async (c) => { await api(`/bills/${d.id}/confirm`, { method: 'POST', body: { amount: yuan(c) } }); await reload('已确认'); }),
        d.status === 'dup' ? [h('p', { class: 's' }, `疑似与下面这笔重复（${d.dup_why}）`), d.dup && h('div', { class: 'led' }, billRow({ ...d.dup, thumb: null })), h('div', { class: 'row' }, btn('link', '是同一笔', { class: 'primary', onclick: act(async () => { await api(`/bills/${d.id}/dup`, { method: 'POST', body: { same: true } }); await reload('已合并'); }) }), btn('', '是两笔', { onclick: act(async () => { await api(`/bills/${d.id}/dup`, { method: 'POST', body: { same: false } }); await reload('已计入'); }) }))]
          : h('div', { class: 'row' }, amt, btn('check', '确认入账', { class: 'primary', onclick: act(async () => { await api(`/bills/${d.id}/confirm`, { method: 'POST', body: d.amount !== null && amt.value === yuan(d.amount) ? {} : { amount: amt.value } }); await reload('已入账'); }) }), btn('trash', '不要了', { class: 'ghost danger', onclick: act(async () => { await api(`/bills/${d.id}`, { method: 'DELETE' }); await reload('已删除，可在回收站恢复'); }) })))));
  };
  const cards = await Promise.all(r.items.map(card));
  return [head('待确认', '金额没把握、疑似重复、还没入账的列表。处理前都不计入统计。'), cards.length ? h('div', { class: 'gap' }, cards) : h('div', { class: 'card' }, empty('check', '都处理完了')), soft.total > 0 && h('section', { style: 'margin-top:26px' }, h('div', { class: 'phead' }, h('div', {}, h('h1', { style: 'font-size:17px' }, `个别信息没把握（${soft.total}）`), h('p', { class: 'muted s' }, '金额确定，已计入统计；商户、时间或分类可以顺手补上。'))), h('div', { class: 'led' }, soft.items.map(billRow)), soft.total > 30 && h('a', { class: 'btn', href: '#/bills?soft=1', style: 'margin-top:10px' }, '看全部'))];
}

// ───────── 统计 ─────────
const UNITS = [['week', '周'], ['month', '月'], ['quarter', '季'], ['year', '年'], ['custom', '自定义']];
async function statsPage(q) {
  const unit = q.unit ?? 'month', custom = unit === 'custom';
  const p = custom ? { from: q.from ?? meta.today.slice(0, 8) + '01', to: q.to ?? meta.today } : { unit, date: q.date ?? meta.today };
  if (q.pending) p.pending = 1; if (q.basis) p.basis = q.basis;
  const s = await api('/stats?' + qs(p));
  const go = (x) => { location.hash = '#/stats?' + qs({ ...q, ...x }); };
  const step = (n) => go({ date: n < 0 ? addDay(s.range.from, -1) : addDay(s.range.to, 1) });
  const basis = { ...(q.basis ? { basis: q.basis } : {}), ...(q.pending ? { pending: 1 } : {}) };
  const link = (e) => periodLink(s, { ...basis, ...e });
  const date = (k) => h('input', { type: 'date', value: p[k], 'aria-label': k === 'from' ? '开始' : '结束', style: 'width:auto', onchange: (e) => go({ ...p, unit: 'custom', [k]: e.target.value }) });
  const merch = s.by_merchant.rows.slice(0, 15).map((m) => ({ ...m, name: m.name || '未识别商户', href: link({ merchant: m.name }) })), meth = s.by_method.map((m) => ({ ...m, name: m.name || '未知', href: link({ method: m.name }) }));
  const cmpCard = (c, t) => h('div', { class: 'card' }, h('h2', {}, t, h('span', { class: 'muted' }, c.label)), h('div', { class: 'facts', style: 'border:0;margin:0;padding:0' }, h('a', { href: billsLink({ counted: 1, ...basis, from: c.same_range.from, to: c.same_range.to }) }, h('small', {}, s.running ? '同进度' : '合计'), h('b', {}, money(c.same_net))), s.running && h('a', { href: billsLink({ counted: 1, ...basis, from: c.range.from, to: c.range.to }) }, h('small', {}, '完整一期'), h('b', {}, money(c.net))), h('div', {}, h('small', {}, '变化'), h('b', {}, c.percent === null ? '—' : `${c.diff >= 0 ? '+' : '−'}${money(Math.abs(c.diff))}（${c.percent > 0 ? '+' : ''}${c.percent}%）`))));
  const x = s.excluded, other = [x.income.count && ['收入', x.income, { kind: 'income', status: 'ok' }], x.transfer.count && ['转账', x.transfer, { kind: 'transfer', status: 'ok' }], x.repay.count && ['还信用卡', x.repay, { kind: 'repay', status: 'ok' }]].filter(Boolean);
  return [head('统计', null, h('div', { class: 'seg', role: 'group', 'aria-label': '周期' }, UNITS.map(([k, t]) => h('button', { 'aria-pressed': String(k === unit), onclick: () => { location.hash = '#/stats?' + qs(k === 'custom' ? { unit: k, from: s.range.from, to: s.range.to < meta.today ? s.range.to : meta.today, pending: q.pending, basis: q.basis } : { unit: k, date: s.range.from <= meta.today && meta.today <= s.range.to ? meta.today : s.range.from, pending: q.pending, basis: q.basis }); } }, t)))),
    h('div', { class: 'gap' },
      h('section', { class: 'hero' }, h('div', { class: 'row', style: 'justify-content:space-between' }, custom ? h('div', { class: 'row' }, date('from'), '至', date('to')) : h('div', { class: 'stepper' }, btn('left', '', { 'aria-label': '上一期', onclick: () => step(-1) }), h('b', {}, s.label), btn('right', '', { 'aria-label': '下一期', disabled: s.range.to >= meta.today, onclick: () => step(1) })), h('label', { class: 'c s muted' }, h('input', { type: 'checkbox', checked: !!q.pending, onchange: (e) => go({ pending: e.target.checked ? 1 : '' }) }), '算上待确认')),
        h('b', { class: 'big num' }, h('a', { href: link() }, money(s.net))),
        h('div', { class: 'muted' }, '净消费', s.running && `（还没过完，已过 ${s.elapsed}/${s.days} 天）`),
        h('div', { class: 'facts' }, h('a', { href: link({ kind: 'expense' }) }, h('small', {}, '支出'), h('b', {}, money(s.expense))), h('a', { href: link({ kind: 'refund' }) }, h('small', {}, `退款 ${s.refund_count} 笔`), h('b', {}, money(s.refund))), h('a', { href: link({ kind: 'expense' }) }, h('small', {}, '支出笔数'), h('b', {}, s.count)), h('div', {}, h('small', {}, '日均'), h('b', {}, money(s.daily))), h('div', {}, h('small', {}, '笔均'), h('b', {}, s.count ? money(Math.round(s.expense / s.count)) : '—')))),
      excludedNote(s),
      s.budget.length > 0 && (unit === 'month' || s.days <= 31) && h('section', { class: 'card' }, h('h2', {}, icon('target'), `${s.budget[0].month} 预算`), budgetBars(s.budget)),
      h('section', { class: 'card' }, h('h2', {}, '趋势', h('span', { class: 'muted' }, { day: '按天', week: '按周', month: '按月' }[s.trend.unit] + '，点柱子看明细')), trendChart(s)),
      h('div', { class: 'g2' }, h('section', { class: 'card' }, h('h2', {}, '分类占比', h('span', { class: 'muted' }, '点开看明细，› 展开二级')), s.by_category.length ? catBarsLink(s, link) : empty('chart', '没有消费')), h('div', { class: 'gap' }, cmpCard(s.prev, '比上一期'), cmpCard(s.yoy, '比去年同期'))),
      h('div', { class: 'g2' }, h('section', { class: 'card' }, h('h2', {}, '商户排行', h('span', { class: 'muted' }, `共 ${s.by_merchant.total} 家`)), bars(merch, { fmt: money, h })), h('section', { class: 'card' }, h('h2', {}, '支付方式'), bars(meth, { fmt: money, h }))),
      h('section', { class: 'card', style: 'padding:16px 0 4px' }, h('h2', { style: 'padding:0 16px' }, '最大的几笔'), s.largest.map((b) => h('a', { class: 'bill', href: `#/bills/${b.id}` }, h('span', { class: 'num muted' }, b.day.slice(5)), h('span', { class: 't' }, h('b', {}, b.merchant || b.item || '未识别商户'), h('span', { class: 'tagx' }, b.category), b.net !== b.amount && h('span', { class: 'tagx' }, `退后 ${money(b.net)}`)), h('span', { class: 'amt' }, money(b.amount))))),
      (other.length > 0 || x.foreign.length > 0) && h('section', { class: 'card' }, h('h2', {}, '不算消费的'), h('div', { class: 'facts', style: 'border:0;margin:0;padding:0' }, other.map(([t, v, f]) => h('a', { href: billsLink({ ...f, from: s.range.from, to: s.range.to }) }, h('small', {}, `${t} ${v.count} 笔`), h('b', {}, money(v.amount)))), x.foreign.map((f) => h('a', { href: billsLink({ currency: f.currency, status: 'ok', from: s.range.from, to: s.range.to }) }, h('small', {}, `外币 ${f.count} 笔`), h('b', {}, money(f.amount, f.currency)))))),
      h('details', { class: 'card' }, h('summary', {}, '统计口径'), h('ul', { class: 'muted s', style: 'padding-left:18px;margin:10px 0' }, s.rules.map((t) => h('li', {}, t))), (s.cross_refund.refunded_later.count > 0 || s.cross_refund.received_for_earlier.count > 0) && h('p', { class: 's' }, `跨期退款：本期支出后来在期外退了 ${money(s.cross_refund.refunded_later.amount)}；本期到账的退款里有 ${money(s.cross_refund.received_for_earlier.amount)} 属于期外的支出。`), h('div', { class: 'row s' }, '退款算到', h('select', { style: 'width:auto', onchange: (e) => go({ basis: e.target.value }) }, opt([['original', '原消费那天'], ['refund', '退款到账那天']], s.basis)), h('span', { class: 'muted' }, '（只影响本页，默认值在设置里改）'))))];
}
function catBarsLink(s, link) { return bars(s.by_category.map((c) => ({ ...c, icon: tile(c.icon || 'dots', 'sm'), href: link({ category: c.id ?? 'none' }), children: c.children.map((y) => ({ ...y, href: link({ category: y.id ?? 'none' }) })) })), { fmt: money, h }); }

// ───────── 分类与规则 ─────────
async function catsPage() {
  const rules = await api('/rules');
  const reload = async (t) => { if (t) toast(t); await loadMeta(); await render(); };
  const edit = (c, parent, type) => dialog(c ? '编辑分类' : parent ? `在「${parent.name}」下新增` : '新增一级分类', (done) => {
    const name = h('input', { value: c?.name ?? '', maxlength: 20 }), kw = h('textarea', { rows: 4, placeholder: '逗号分隔。商户、说明、备注里出现就自动归到这里' }, c?.keywords ?? ''); let ic = c?.icon || 'dots';
    const icons = h('div', { class: 'chips' }, CAT_ICONS.map((k) => h('button', { type: 'button', class: 'chip', 'aria-label': k, 'aria-pressed': String(k === ic), onclick: (e) => { ic = k; for (const b of icons.children) b.setAttribute('aria-pressed', 'false'); e.currentTarget.setAttribute('aria-pressed', 'true'); } }, icon(k))));
    return h('form', { class: 'col', onsubmit: act(async (e) => { e.preventDefault(); await api('/categories', { method: 'POST', body: { id: c?.id, name: name.value, keywords: kw.value, parent_id: c ? undefined : parent?.id, type, ...(c?.parent_id || parent ? {} : { icon: ic }) } }); done(true); await reload('已保存'); }) }, fld('名称', name), !(c?.parent_id || parent) && fld('图标', icons), fld('关键词', kw), h('div', { class: 'row end' }, c && btn('trash', '删除', { class: 'ghost danger', onclick: () => { done(null); del(c); } }), h('span', { class: 'grow' }), btn('', '取消', { onclick: () => done(null) }), h('button', { class: 'primary' }, '保存')));
  });
  const del = (c) => dialog(`删除「${c.name}」`, (done) => { const s = catSelect(null, c.type, {}, '变成未分类'); return [h('p', { class: 'muted', style: 'margin-bottom:10px' }, `${c.parent_id ? '' : '下面的二级分类会一起删除。'}已有的账要移到哪里？每笔都会留下修改记录。`), s, h('div', { class: 'row end', style: 'margin-top:14px' }, btn('', '取消', { onclick: () => done(null) }), btn('', '删除', { class: 'primary danger', onclick: act(async () => { await api(`/categories/${c.id}${s.value ? `?move=${s.value}` : ''}`, { method: 'DELETE' }); done(true); await reload('已删除'); }) }))]; });
  const block = (type, title) => h('section', { class: 'card' }, h('h2', {}, title, h('span', { class: 'muted' }, btn('plus', '一级分类', { onclick: () => edit(null, null, type) }))), h('div', { class: 'col' }, cats(type).filter((c) => !c.parent_id).map((p) => h('div', { class: 'cat' }, h('div', { class: 'row' }, tile(p.icon || 'dots', 'sm'), h('b', { class: 'grow' }, p.name), btn('', '编辑', { class: 'ghost', onclick: () => edit(p, null, type) })), h('div', { class: 'subs' }, cats(type).filter((c) => c.parent_id === p.id).map((c) => h('button', { class: 'chip', title: c.keywords || '没有关键词', onclick: () => edit(c, null, type) }, c.name)), h('button', { class: 'chip', onclick: () => edit(null, p, type) }, '+ 二级'))))));
  const pat = h('input', { placeholder: '商户名或关键词', 'aria-label': '商户名或关键词' }), mt = h('select', { 'aria-label': '匹配方式' }, opt([['merchant', '商户是'], ['contains', '包含文字']], 'merchant')), cat = catSelect(null, 'expense', { 'aria-label': '归到' }, '归到…');
  return [head('分类与规则', '先看规则（你教过的），再看关键词。改一次分类就会记住那个商户。'), h('div', { class: 'g2' }, h('div', { class: 'gap' }, block('expense', '支出分类'), block('income', '收入分类')),
    h('div', { class: 'gap' }, h('section', { class: 'card' }, h('h2', {}, icon('brain'), '记住的规则', h('span', { class: 'muted' }, `${rules.active.length} 条`)), h('form', { class: 'col', onsubmit: act(async (e) => { e.preventDefault(); await api('/rules', { method: 'POST', body: { match: mt.value, pattern: pat.value, category_id: Number(cat.value) } }); await reload('已添加'); }) }, h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { style: 'flex:0 0 108px' }, mt), pat), h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { class: 'grow' }, cat), h('button', {}, icon('plus'), '添加'))),
      h('div', { style: 'margin-top:10px' }, rules.active.map((r) => h('div', { class: 'row', style: 'padding:7px 0;border-top:1px solid var(--line);flex-wrap:nowrap' }, h('span', { class: 'grow' }, r.match === 'contains' && h('span', { class: 'muted' }, '含 '), r.pattern, h('span', { class: 'muted' }, ' → '), r.category, h('div', { class: 's muted' }, `${r.source === 'learned' ? '改分类时记住的' : '手动添加'} · ${ymd(r.updated_at)}${r.hits ? ` · 用在 ${r.hits} 笔` : ''}`)), btn('', '撤销', { class: 'ghost', onclick: act(async () => { await api(`/rules/${r.id}`, { method: 'DELETE' }); await reload('已撤销，已记的账不变'); }) }))), !rules.active.length && h('p', { class: 'muted' }, '还没有。改一笔账的分类试试。')),
      rules.deleted.length > 0 && h('details', { style: 'margin-top:8px' }, h('summary', { class: 's muted' }, `撤销过的 ${rules.deleted.length} 条`), rules.deleted.map((r) => h('div', { class: 'row s', style: 'padding:5px 0' }, h('span', { class: 'grow muted' }, `${r.pattern} → ${r.category}`), btn('', '恢复', { class: 'ghost', onclick: act(async () => { await api(`/rules/${r.id}/undo`, { method: 'POST' }); await reload('已恢复'); }) }))))),
      h('section', { class: 'card col' }, h('h2', {}, icon('undo'), '重新归类'), h('p', { class: 'muted s' }, '改了关键词或规则后，把以前没手动改过分类的账重新归一遍。会留修改记录。'), btn('', '重新归类', { onclick: act(async () => { const r = await api('/reclassify', { method: 'POST', body: {} }); toast(`改了 ${r.changed} 笔`); }) }))))];
}

// ───────── 导入 ─────────
async function importPage(id) {
  if (!id) {
    const list = await api('/imports');
    const inp = h('input', { type: 'file', accept: '.csv,.xlsx', hidden: true, onchange: act(async (e) => { const f = new FormData(); f.append('file', e.target.files[0]); e.target.value = ''; const r = await api('/imports', { method: 'POST', form: f }); location.hash = `#/import/${r.id}`; }) });
    const drop = h('div', { class: 'drop', role: 'button', tabindex: 0, onclick: () => inp.click(), onkeydown: (e) => { if (e.key === 'Enter') inp.click(); }, ondragover: (e) => { e.preventDefault(); drop.classList.add('on'); }, ondragleave: () => drop.classList.remove('on'), ondrop: (e) => { e.preventDefault(); drop.classList.remove('on'); inp.files = e.dataTransfer.files; inp.dispatchEvent(new Event('change')); } }, icon('up'), h('div', {}, '选择或拖入账单文件（.csv / .xlsx）'));
    return [head('导入账单', '先预览、去重，确认后才入账。'), h('div', { class: 'g2' }, h('section', { class: 'card col' }, drop, inp, h('div', { class: 'muted s' }, h('p', {}, '微信：我 → 服务 → 钱包 → 账单 → 常见问题/右上角 → 下载账单 → 用于个人对账。'), h('p', {}, '支付宝：我的 → 账单 → 右上角 ··· → 开具交易流水证明 → 用于个人对账。'), h('p', {}, '收到的压缩包先用平台给的密码解压，把里面的文件拖进来，不要用 Excel 另存。菜单名称以 App 为准。'))), h('section', { class: 'card' }, h('h2', {}, '以前导入过的'), list.length ? list.map((x) => h('a', { class: 'row', style: 'padding:7px 0;border-top:1px solid var(--line)', href: `#/import/${x.id}` }, h('span', { class: 'grow' }, x.filename, h('div', { class: 's muted' }, `${x.platform === 'wechat' ? '微信' : '支付宝'} · ${time(x.created_at)}`)), h('span', { class: 'tagx' }, { preview: '未入账', done: '已入账', discarded: '已放弃' }[x.status]))) : h('p', { class: 'muted' }, '还没有')))];
  }
  const p = await api(`/imports/${id}`), done = p.status !== 'preview';
  const picks = new Map(), dec = new Map();
  const T = { new: '新的', exists: '已经有了', maybe: '可能记过', skip: '不导入' };
  let show = p.counts.maybe ? 'maybe' : 'new';
  const body = h('div'), btnGo = btn('check', '', { class: 'primary', onclick: act(async () => { const pick = [...picks].filter(([, c]) => c.checked).map(([n]) => n); const r = await api(`/imports/${id}/commit`, { method: 'POST', body: { pick, decide: Object.fromEntries([...dec].map(([n, s]) => [n, s.value])) } }); toast(`新入账 ${r.created} 笔${r.linked ? `，补全 ${r.linked} 笔` : ''}${r.changed ? `，${r.changed} 笔在预览后已记过、没有重复入账` : ''}`); location.hash = `#/bills?import=${id}`; }) });
  for (const r of p.rows) { if (r.action === 'new') picks.set(r.n, h('input', { type: 'checkbox', checked: true, 'aria-label': `第 ${r.n} 行`, onchange: () => label() })); if (r.action === 'maybe') dec.set(r.n, h('select', { style: 'width:auto', onchange: () => label() }, opt([['skip', '不导入'], ['link', '同一笔，补全信息'], ['add', '是另一笔']], 'skip'))); }
  const label = () => { const n = [...picks.values()].filter((c) => c.checked).length + [...dec.values()].filter((s) => s.value === 'add').length, l = [...dec.values()].filter((s) => s.value === 'link').length; btnGo.lastChild.textContent = `入账 ${n} 笔${l ? `，补全 ${l} 笔` : ''}`; };
  btnGo.append(''); label();
  const draw = () => body.replaceChildren(h('div', { class: 'seg', style: 'margin-bottom:10px' }, Object.entries(T).map(([k, t]) => h('button', { 'aria-pressed': String(k === show), onclick: () => { show = k; draw(); } }, `${t} ${p.counts[k]}`))), h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['', '时间', '商户 / 说明', '类型', '金额', '支付方式', '说明'].map((t, i) => h('th', { class: i === 4 ? 'num' : '' }, t)))), h('tbody', {}, p.rows.filter((r) => r.action === show).slice(0, 500).map((r) => h('tr', {}, h('td', {}, !done && (picks.get(r.n) ?? dec.get(r.n) ?? '')), h('td', { class: 'num', style: 'text-align:left' }, time(r.time).slice(2)), h('td', {}, r.merchant || '—', r.item && h('div', { class: 's muted' }, r.item)), h('td', {}, meta.kinds[r.kind]), h('td', { class: 'num' }, money(r.amount)), h('td', {}, r.method), h('td', { class: 's muted' }, r.match ? h('a', { class: 'link', href: `#/bills/${r.match}` }, r.why) : r.why)))))), p.rows.filter((r) => r.action === show).length > 500 ? h('p', { class: 'muted s' }, '只显示前 500 行，入账时包含全部') : '');
  draw();
  return [head(p.filename, `${p.platform === 'wechat' ? '微信支付' : '支付宝'}账单，${p.rows.length} 行${done ? '（已处理）' : ''}`, !done && btn('', '放弃', { onclick: act(async () => { await api(`/imports/${id}`, { method: 'DELETE' }); location.hash = '#/import'; }) }), !done && btnGo), h('section', { class: 'card' }, body)];
}

// ───────── 记一笔 ─────────
function addDialog() {
  return dialog('记一笔', (done) => {
    let files = [];
    const list = h('div', { class: 's muted' }), inp = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => setFiles([...e.target.files]) });
    const setFiles = (f) => { files = f.filter((x) => x.type.startsWith('image/')); list.textContent = files.length ? `已选 ${files.length} 张` : ''; };
    const drop = h('div', { class: 'drop', role: 'button', tabindex: 0, onclick: () => inp.click(), onkeydown: (e) => { if (e.key === 'Enter') inp.click(); }, ondragover: (e) => { e.preventDefault(); drop.classList.add('on'); }, ondragleave: () => drop.classList.remove('on'), ondrop: (e) => { e.preventDefault(); drop.classList.remove('on'); setFiles([...e.dataTransfer.files]); } }, icon('img'), h('div', {}, '选择、拖入或粘贴付款截图'), list);
    const text = h('input', { placeholder: '或一句话：午饭 28、打车 35.5 昨天', 'aria-label': '一句话记账' });
    const f = { amount: h('input', { inputmode: 'decimal', placeholder: '0.00' }), kind: h('select', {}, opt(Object.entries(meta.kinds), 'expense')), occurred: h('input', { type: 'datetime-local', value: time(Date.now()).replace(' ', 'T') }), merchant: h('input', { list: 'mm' }), item: h('input', {}), category_id: catSelect(null, 'expense', {}, '自动归类'), method: h('input', { list: 'mt' }), note: h('input', {}) };
    f.kind.addEventListener('change', () => { const n = catSelect(null, f.kind.value === 'income' ? 'income' : 'expense', {}, '自动归类'); f.category_id.replaceChildren(...n.children); });
    const onPaste = (e) => { const g = [...(e.clipboardData?.files ?? [])]; if (g.length) { e.preventDefault(); setFiles(g); } };
    const form = h('form', { class: 'col', onpaste: onPaste, onsubmit: act(async (e) => {
      e.preventDefault(); let r;
      const go = form.querySelector('button.primary'); go.disabled = true;
      try {
        if (files.length || text.value.trim()) { const d = new FormData(); for (const x of files) d.append('files', x); if (text.value.trim()) d.append('text', text.value.trim()); r = await api('/bills', { method: 'POST', form: d }); } else { const b = {}; for (const [k, el] of Object.entries(f)) if (el.value) b[k] = el.value; if (!b.amount) throw new Error('请填金额，或选截图、写一句话'); r = await api('/bills', { method: 'POST', body: b }); }
      } finally { go.disabled = false; }
      done(true); await loadMeta(); toast(r.ids?.length > 1 ? `识别出 ${r.ids.length} 笔，已分开记` : '已记录'); const to = `#/bills/${r.id}`; if (location.hash === to) render(); else location.hash = to;
    }) }, drop, inp, text, h('details', {}, h('summary', { class: 'muted' }, '手工填写'), h('datalist', { id: 'mm' }, meta.merchants.map((m) => h('option', { value: m }))), h('datalist', { id: 'mt' }, meta.methods.map((m) => h('option', { value: m }))), h('div', { class: 'form', style: 'margin-top:10px' }, fld('金额', f.amount), fld('类型', f.kind), fld('时间', f.occurred), fld('分类', f.category_id), fld('商户', f.merchant), fld('支付方式', f.method), fld('说明', f.item), fld('备注', f.note))), h('div', { class: 'row end' }, btn('', '取消', { onclick: () => done(null) }), h('button', { class: 'primary' }, icon('check'), '记下来')));
    return form;
  });
}

// ───────── 设置 ─────────
async function settingsPage() {
  const [s, bk, bu] = await Promise.all([api('/system'), api('/backups'), api('/budgets')]);
  const reload = async (t) => { if (t) toast(t); await loadMeta(); await render(); };
  const save = (k, v) => api('/settings', { method: 'POST', body: { [k]: v } });
  const [bt, bc] = BOT[s.bot.state] ?? BOT.disabled, origin = location.origin, code = h('div'), tok = h('div', { class: 'col' }), authOutput = h('div', { class: 'col' }), auditOut = h('div', { class: 'col' });
  const tn = h('input', { placeholder: '名称，如 Claude Code', value: 'AI 助手' });
  const bcat = h('select', {}, h('option', { value: 0 }, '总预算'), cats('expense').filter((c) => !c.parent_id).map((c) => h('option', { value: c.id }, c.name))), bamt = h('input', { inputmode: 'decimal', placeholder: '每月金额' });
  const scope = h('select', {}, h('option', { value: 'bill' }, '单笔账单'), h('option', { value: 'all' }, '全部账单'));
  const bid = h('input', { placeholder: '单笔编号', inputmode: 'numeric', style: 'width:110px' });
  const minsAuth = h('input', { value: 10, type: 'number', min: 1, max: 15, style: 'width:70px' });
  const auditSource = h('select', {}, h('option', { value: '' }, '全部来源'), ...['mcp','web','qq','import'].map(x => h('option',{value:x}, {mcp:'MCP',web:'网页',qq:'QQ',import:'导入'}[x])));
  const auditToken = h('select', {}, h('option', { value: '' }, '全部令牌'), s.tokens.map((t) => h('option', { value: t.id }, t.name)));
  const auditResult = h('select', {}, h('option', { value: '' }, '全部结果'), h('option', { value: 'success' }, '成功'), h('option', { value: 'rejected' }, '拒绝'), h('option', { value: 'failed' }, '失败'));
  const auditFrom = h('input', { type: 'date', title: '开始日期' }), auditTo = h('input', { type: 'date', title: '结束日期' });
  const loadAudit = act(async () => { const q = new URLSearchParams(); if (auditSource.value) q.set('source', auditSource.value); if (auditToken.value) q.set('token', auditToken.value); if (auditResult.value) q.set('result', auditResult.value); if (auditFrom.value) q.set('from', auditFrom.value); if (auditTo.value) q.set('to', auditTo.value); const rows = await api(`/audit/mcp?${q}`); auditOut.replaceChildren(...rows.map((a) => h('div', { class: 'evt' }, h('span', {}, `${time(a.at)} · ${a.source} · #${a.bill_id ?? '—'} · ${a.operation} · ${a.result}`), h('span', { class: 'muted' }, `${a.token_name} · ${a.reason}`)))); });
  const grants = h('div', {class:'col'});
  const loadGrants = async () => { const rows = await api('/mcp-authorizations'); grants.replaceChildren(...rows.map(a => h('div',{class:'row'}, h('span',{class:'grow'}, `授权 #${a.id} · ${a.scope === 'all' ? '全部账单' : '#'+a.bill_id} · ${a.revoked_at ? '已撤销' : a.expires_at <= Date.now() ? '已过期' : '到期 '+time(a.expires_at)}`), !a.revoked_at && a.expires_at > Date.now() && btn('', '撤销授权',{onclick:act(async () => { await api('/mcp-authorizations/'+a.id,{method:'DELETE'}); authOutput.replaceChildren(); await loadGrants(); toast('授权已撤销'); })})))); };
  const issueAuth = act(async () => { const r = await api('/mcp-authorizations', { method: 'POST', body: { scope: scope.value, bill_id: Number(bid.value), minutes: Number(minsAuth.value) } }); authOutput.replaceChildren(h('p', { class: 's' }, h('b', {}, '授权码只显示这一次')), h('div', { class: 'mono' }, r.code), h('div', { class: 's muted' }, `范围：${r.scope === 'all' ? '全部账单' : `#${r.bill_id}`}，到期 ${time(r.expiresAt)}`)); await loadGrants(); });
  const authControls = h('div', { class: 'col' }, h('hr', {}), h('h3', {}, '签发短期修改授权'), h('p', { class: 'muted s' }, '明文只显示一次，默认 10 分钟，最长 15 分钟。授权码不会进入日志。'), h('div', { class: 'row' }, scope, bid, minsAuth, btn('key', '签发授权码', { onclick: issueAuth })), authOutput, grants);
  await loadGrants(); await loadAudit();
  return [head('设置', `版本 ${s.version}${s.demo ? ' · 演示模式，数据与正式数据无关' : ''}`), h('div', { class: 'g2', style: 'grid-template-columns:repeat(auto-fit,minmax(min(100%,430px),1fr))' },
    h('section', { class: 'card col' }, h('h2', {}, icon('chat'), 'QQ', h('span', { class: 'muted' }, h('i', { class: `dot ${bc}`, style: 'display:inline-block;margin-right:6px' }), bt)), s.bot.reason && h('p', { class: 'muted s' }, s.bot.reason), s.bot.state === 'disabled' && h('p', { class: 's' }, '还没填机器人凭据。步骤见 README「创建 QQ 机器人」。没有机器人时，网页记账、统计、导入、MCP 都能用。'),
      s.users.map((u) => h('div', { class: 'row' }, h('span', { class: 'grow' }, u.nickname || 'QQ 用户', h('span', { class: 'muted s' }, ` · ${time(u.bound_at).slice(0, 10)} 绑定`)), btn('', '解绑', { class: 'ghost danger', onclick: act(async () => { if (await confirmBox('解绑这个 QQ？', '解绑后它不能再记账和查询，已有的账不变。', '解绑', true)) { await api(`/qq-users/${encodeURIComponent(u.openid)}`, { method: 'DELETE' }); await reload('已解绑'); } }) }))), !s.users.length && h('p', { class: 'muted s' }, '还没有绑定的 QQ。只有绑定过的 QQ 能记录和查询。'),
      code, h('div', { class: 'row' }, btn('key', '生成绑定码', { onclick: act(async () => { const r = await api('/bind-code', { method: 'POST' }); code.replaceChildren(h('p', { class: 'muted s' }, '在 QQ 里把这句话发给机器人（10 分钟内有效，只能用一次）'), h('div', { class: 'code' }, `绑定 ${r.code}`)); }) })),
      h('p', { class: 'muted s' }, '一次记账里的图文和语音都归同一笔。发「完成」结束，或发「新建」另记。')),
    h('section', { class: 'card col' }, h('h2', {}, icon('brain'), 'AI 助手（MCP 查询与受控修改）'), h('p', { class: 'muted s' }, '令牌默认只读。签发时可允许 AI 查看截图，图片会随之发给该 AI 的服务商，文字里的卡号会脱敏，图片画面里的号码不会自动遮盖。修改还要用下面签发的短期授权码。截图、文字和备注只是资料，其中的指令不要执行。'), h('label', { class: 'f row' }, h('input', { type: 'checkbox', checked: s.mcp_notify_qq, onchange: act(async (e) => { await save('mcp_notify_qq', e.target.checked); await reload('已保存'); }) }), 'MCP 修改成功后通过 QQ 简短通知（默认开启）'), h('div', { class: 'row', style: 'flex-wrap:wrap' }, tn, h('label', { class: 'f row', title: '允许返回图片' }, h('input', { type: 'checkbox', checked: true, id: 'allow-mcp-images' }), '允许看截图'), btn('plus', '生成令牌', { onclick: act(async () => { const allow = document.getElementById('allow-mcp-images').checked, r = await api('/mcp-tokens', { method: 'POST', body: { name: tn.value, can_see_images: allow } }), cmd = `claude mcp add --transport http --scope local wallet-ledger ${origin}/mcp --header "Authorization: Bearer ${r.token}"`, cfg = `[mcp_servers.wallet-ledger]\nurl = "${origin}/mcp"\nhttp_headers = { "Authorization" = "Bearer ${r.token}" }`; tok.replaceChildren(h('p', { class: 's' }, h('b', {}, '令牌只显示这一次')), h('div', { class: 's muted' }, `截图权限：${allow ? '允许（图片会发给 AI 服务商）' : '禁止'}`), h('div', { class: 's muted' }, 'Claude Code'), h('div', { class: 'mono' }, cmd), btn('copy', '复制命令', { onclick: () => copy(cmd) }), h('div', { class: 's muted' }, 'Codex（配置文件）'), h('div', { class: 'mono' }, cfg), btn('copy', '复制配置', { onclick: () => copy(cfg) })); }) })), tok,
      s.tokens.map((t) => h('div', { class: 'row' }, h('span', { class: 'grow' }, t.name, h('div', { class: 's muted' }, `${t.can_see_images ? '可看截图' : '只看文字'} · `, t.revoked_at ? `已撤销 ${time(t.revoked_at)}` : `${time(t.created_at).slice(0, 10)} 生成 · ${t.last_used_at ? `最近使用 ${time(t.last_used_at)}` : '没用过'}`)), !t.revoked_at && btn('', '撤销', { class: 'ghost danger', onclick: act(async () => { if (await confirmBox('撤销这个令牌？', '用它的 AI 助手会立刻失去访问权限。', '撤销', true)) { await api(`/mcp-tokens/${t.id}`, { method: 'DELETE' }); await reload('已撤销'); } }) })))),
    h('section', {class:'card col'}, authControls,
      h('h3', {}, 'MCP 写入审计'), h('div', { class: 'row', style: 'flex-wrap:wrap' }, auditSource, auditToken, auditResult, auditFrom, auditTo, btn('', '筛选', { class: 'ghost', onclick: loadAudit })), auditOut),
    h('section', { class: 'card col' }, h('h2', {}, icon('target'), '每月预算'), bu.now.length ? bu.now.map((b) => h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('div', { class: 'grow' }, budgetBars([b])), btn('x', '', { class: 'ghost', 'aria-label': `删除${b.name}预算`, onclick: act(async () => { await api('/budgets', { method: 'POST', body: { category_id: b.category_id, amount: '' } }); await reload('已删除'); }) }))) : h('p', { class: 'muted s' }, '还没设。用到 80% 和超支时，网页和 QQ 回执会提醒。'), h('div', { class: 'row', style: 'flex-wrap:nowrap' }, bcat, bamt, btn('', '保存', { onclick: act(async () => { if (!bamt.value) throw new Error('请填金额'); await api('/budgets', { method: 'POST', body: { category_id: Number(bcat.value), amount: bamt.value } }); await reload('已保存'); }) }))),
    h('section', { class: 'card col' }, h('h2', {}, icon('undo'), '统计口径'), fld('退款算到哪天', h('select', { onchange: act(async (e) => { await save('refund_basis', e.target.value); await reload('已保存'); }) }, opt([['original', '冲减原消费那天（默认）'], ['refund', '冲减退款到账那天']], s.settings.refund_basis))), h('ul', { class: 'muted s', style: 'padding-left:18px;margin:0' }, meta.rules.map((t) => h('li', {}, t)))),
    h('section', { class: 'card col' }, h('h2', {}, icon('shield'), '备份与恢复', h('span', { class: 'muted' }, `每天自动一份，保留 ${bk.keep} 份`)), h('p', { class: 'muted s' }, `包含数据库和全部截图，在 ${bk.dir}。建议把这个文件夹定期拷到别的盘。`), h('div', { class: 'row' }, btn('dl', '现在备份', { onclick: act(async () => { await api('/backups', { method: 'POST' }); await reload('已备份'); }) })),
      bk.list.slice(0, 12).map((b) => h('div', { class: 'row' }, h('span', { class: 'grow' }, time(b.at), h('span', { class: 'tagx', style: 'margin-left:8px' }, { '': '每日', manual: '手动', before: '恢复前' }[b.kind] ?? b.kind), h('div', { class: 's muted' }, `${b.bills} 笔账 · ${b.files} 个附件 · ${size(b.size)}`)), btn('', '校验', { class: 'ghost', onclick: act(async () => { const r = await api(`/backups/${b.name}/verify`, { method: 'POST' }); toast(r.ok ? '备份完好' : r.problems[0], !r.ok); }) }), btn('', '恢复', { class: 'ghost', onclick: act(async () => { if (await confirmBox('恢复到这份备份？', `账目会回到 ${time(b.at)} 的样子（${b.bills} 笔）。现在的状态会先自动留一份备份，可以再恢复回来。\n登录、QQ 绑定和令牌保持现在的状态。`, '恢复')) { const r = await api(`/backups/${b.name}/restore`, { method: 'POST' }); await reload(`已恢复，之前的状态存为 ${r.before}`); } }) }))), !bk.list.length && h('p', { class: 'muted s' }, '还没有备份')),
    h('section', { class: 'card col' }, h('h2', {}, icon('phone'), '手机查看'), s.access.length ? [h('p', { class: 'muted s' }, s.lan ? '手机连同一 Wi-Fi，扫码后用登录密码进入。局域网是明文传输，只在可信网络使用。' : '扫码打开'), s.access.map((a) => h('div', { class: 'row' }, h('img', { class: 'qr', src: a.qr, alt: '二维码' }), h('div', {}, h('b', {}, a.url), h('div', { class: 'row' }, btn('copy', '复制', { onclick: () => copy(a.url) })))))] : h('p', { class: 'muted s' }, '现在只有这台电脑能打开（默认）。要用手机看，桌面版在控制台里打开「允许同一 Wi-Fi 访问」，命令行版在 .env 里设 HOST=0.0.0.0 后重启。')),
    h('section', { class: 'card col' }, h('h2', {}, icon('dl'), '导出与导入'), h('div', { class: 'row' }, h('a', { class: 'btn', href: '/api/export/csv', download: '' }, '导出全部 CSV'), h('a', { class: 'btn', href: '/api/export/json', download: '' }, '导出全部 JSON'), h('a', { class: 'btn', href: '#/import' }, icon('up'), '导入微信 / 支付宝账单')), h('a', { class: 'link s', href: '#/bills?deleted=1' }, '回收站')),
    h('section', { class: 'card col' }, h('h2', {}, icon('info'), '状态'), h('div', { class: 's' }, [['本地文字识别', { ready: '可用（离线）', unavailable: '不可用，截图只保存不识别', disabled: '已关闭' }[s.ocr]], ['附件', `下载中 ${s.queue.downloading}，识别中 ${s.queue.recognizing}，失败 ${s.queue.failed}`], ['数据位置', s.dataDir], ['启动时间', time(s.startedAt)]].map(([a, b]) => h('div', { class: 'evt' }, h('span', { class: 'muted' }, a), h('span', { style: 'word-break:break-all' }, b))))))];
}
async function morePage() { return [head('更多'), h('div', { class: 'led' }, [['todo', '待确认', 'todo', todoN()], ['cats', '分类与规则', 'tag'], ['import', '导入账单', 'up'], ...(meta.demo ? [['demo', '演示聊天', 'chat']] : []), ['settings', '设置', 'gear']].map(([k, t, ic, n]) => h('a', { class: 'bill', href: `#/${k}` }, tile(ic), h('b', {}, t), n ? h('span', { class: 'n' }, n) : icon('right'))))]; }

// ───────── 演示聊天 ─────────
async function demoPage() {
  if (!meta.demo) return empty('chat', '只有演示模式才有这个页面');
  const samples = await api('/demo/samples');
  const msgs = h('div', { class: 'msgs', 'aria-live': 'polite' }, h('div', { class: 'msg' }, '像在 QQ 里一样发消息：打字「午饭 28」，或点下面的样例截图。')); let last = 0, alive = true;
  const poll = async () => { if (!alive || !msgs.isConnected && last) return; try { for (const m of await api(`/demo/messages?after=${last}`)) { last = m.i; msgs.append(h('div', { class: `msg ${m.from}` }, [m.files ? `[${m.files} 张截图]` : '', m.text].filter(Boolean).join('\n'))); msgs.scrollTop = 1e9; } } catch { alive = false; return; } setTimeout(poll, 700); };
  const t = h('input', { placeholder: '发消息…', 'aria-label': '消息' }), file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: act(async (e) => { const f = new FormData(); for (const x of e.target.files) f.append('files', x); e.target.value = ''; if (t.value.trim()) { f.append('text', t.value); t.value = ''; } await api('/demo/say', { method: 'POST', form: f }); }) });
  setTimeout(poll, 100);
  return [head('演示聊天', '这里走的是和真实 QQ 完全相同的收录流程，只是平台换成了内置的模拟器。'), h('section', { class: 'card chat' }, msgs, h('div', { class: 'chips', style: 'padding:8px 0' }, samples.map((s) => h('button', { class: 'chip', onclick: act(async () => { const f = new FormData(); f.append('sample', s.name); await api('/demo/say', { method: 'POST', form: f }); }) }, s.label)), ['本月花到哪里了', '待确认', '帮助'].map((x) => h('button', { class: 'chip', onclick: act(() => api('/demo/say', { method: 'POST', body: { text: x } })) }, x))), h('form', { class: 'say', onsubmit: act(async (e) => { e.preventDefault(); const v = t.value.trim(); if (!v) return; t.value = ''; await api('/demo/say', { method: 'POST', body: { text: v } }); }) }, t, btn('img', '', { 'aria-label': '发截图', onclick: () => file.click() }), file, h('button', { class: 'primary' }, '发送')))];
}

render();
