/** 手写 SVG 图表：单一数据系列、细柱、细网格线、悬停提示、可点击回查明细。颜色取自 CSS 变量，深浅色各自选定。 */
const NS = 'http://www.w3.org/2000/svg';
const el = (t, a, ...k) => { const e = document.createElementNS(NS, t); for (const [x, v] of Object.entries(a)) if (v !== undefined) e.setAttribute(x, v); e.append(...k); return e; };
const tip = () => document.getElementById('tip');
export function showTip(e, lines) {
  const t = tip(); t.replaceChildren(...lines.map((l, i) => { const d = document.createElement(i ? 'div' : 'b'); d.textContent = l; return d; })); t.className = 'on';
  const r = t.getBoundingClientRect(), x = Math.min(innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2)), y = e.clientY - r.height - 14;
  t.style.left = `${x}px`; t.style.top = `${y < 8 ? e.clientY + 18 : y}px`;
}
export const hideTip = () => { tip().className = ''; };
addEventListener('scroll', hideTip, { passive: true }); addEventListener('hashchange', hideTip);
/** 1/2/5 序列的整齐刻度（单位：分） */
export function ticks(max, n = 3) {
  if (max <= 0) return [0];
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].find((m) => m * p >= raw) * p;
  return Array.from({ length: Math.floor(max / step + 1e-9) + 1 }, (_x, i) => i * step);
}
const axis = (c) => { const y = c / 100; return y >= 10000 ? `${+(y / 10000).toFixed(1)}万` : y.toLocaleString('zh-CN', { maximumFractionDigits: 1 }); };

/** 柱状趋势。points: [{net,label,sub,href}] */
export function columns(points, { height = 190, fmt, now = -1, unit = '' }) {
  const box = document.createElement('div'); box.className = 'viz'; box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `趋势图，共 ${points.length} 格，最高 ${fmt(Math.max(0, ...points.map((p) => p.net)))}`);
  const draw = () => {
    const W = box.clientWidth || 600, L = 46, B = 24, T = 18, R = 4, H = height, n = points.length;
    const max = Math.max(1, ...points.map((p) => p.net)), min = Math.min(0, ...points.map((p) => p.net)), span = max - min, y = (v) => T + ((max - v) / span) * (H - T - B);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
    for (const t of ticks(max)) svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t ? 'grid' : 'base' }), el('text', { x: L - 8, y: y(t) + 4, class: 'ax', 'text-anchor': 'end' }, axis(t)));
    const slot = (W - L - R) / n, w = Math.max(2, Math.min(24, slot - 2, slot * 0.68)), every = Math.ceil((n * 44) / (W - L));
    const peak = points.reduce((a, p, i) => (p.net > points[a].net ? i : a), 0);
    points.forEach((p, i) => {
      const x = L + slot * i + (slot - w) / 2, top = y(Math.max(0, p.net)), h = Math.abs(y(p.net) - y(0)), r = Math.min(4, w / 2, h);
      const d = p.net >= 0 ? `M${x} ${top + h}v${-(h - r)}q0 ${-r} ${r} ${-r}h${w - 2 * r}q${r} 0 ${r} ${r}v${h - r}z` : `M${x} ${y(0)}h${w}v${h - r}q0 ${r} ${-r} ${r}h${-(w - 2 * r)}q${-r} 0 ${-r} ${-r}z`;
      const bar = h > 0 ? el('path', { d, class: `bar ${i === now ? 'now' : ''}` }) : el('path', { d: `M${x} ${y(0)}h${w}`, class: 'zero' });
      const a = el('a', { href: p.href, 'aria-label': `${p.label} ${fmt(p.net)}` }, bar, el('rect', { x: L + slot * i, y: T, width: slot, height: H - T - B, class: 'hit' }));
      a.addEventListener('pointermove', (e) => showTip(e, [fmt(p.net), p.label, `${p.count} 笔${p.refund ? `，含退款 ${fmt(p.refund)}` : ''}`])); a.addEventListener('pointerleave', hideTip);
      svg.append(a);
      if (i === peak && p.net > 0) svg.append(el('text', { x: Math.min(W - 30, Math.max(L + 24, x + w / 2)), y: top - 5, class: 'val', 'text-anchor': 'middle' }, fmt(p.net).replace(/\.00$/, '')));
      if (i % every === 0 && !(i + every > n && n - i < every / 2 && i > 0)) svg.append(el('text', { x: L + slot * i + slot / 2, y: H - 7, class: 'ax', 'text-anchor': 'middle' }, p.sub));
    });
    box.replaceChildren(svg);
  };
  new ResizeObserver(draw).observe(box);
  return box;
}
/** 横条排行。rows: [{name,net,count,share,href,icon,children}] —— 直接写数值，可点进明细 */
export function bars(rows, { fmt, h, onToggle }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  const one = (r, sub) => {
    const bar = h('span', { class: 'track' }, h('i', { style: `width:${Math.max(r.net > 0 ? 0.6 : 0, (Math.abs(r.net) / max) * 100)}%`, class: r.net < 0 ? 'neg' : '' }));
    const a = h('a', { class: `brow ${sub ? 'sub' : ''}`, href: r.href }, h('span', { class: 'bname' }, !sub && r.icon, h('span', {}, r.name)), bar, h('span', { class: 'num' }, fmt(r.net)), h('span', { class: 'num muted pctc' }, `${r.share}%`));
    a.addEventListener('pointermove', (e) => showTip(e, [fmt(r.net), r.name, `${r.count} 笔，占 ${r.share}%${r.refund ? `，已扣退款 ${fmt(r.refund)}` : ''}`])); a.addEventListener('pointerleave', hideTip);
    return a;
  };
  return h('div', { class: 'bars' }, rows.map((r) => {
    if (!r.children || r.children.length < 2) return h('div', {}, one(r));
    const kids = h('div', { class: 'kids', hidden: true }, r.children.map((c) => one(c, true)));
    const t = h('button', { class: 'exp', 'aria-label': `展开 ${r.name}`, 'aria-expanded': 'false', onclick: () => { kids.hidden = !kids.hidden; t.setAttribute('aria-expanded', String(!kids.hidden)); onToggle?.(); } }, '›');
    return h('div', { class: 'grp' }, t, one(r), kids);
  }));
}
