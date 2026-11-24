// Small DOM + formatting helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const fmt = (n) => Math.round(n).toLocaleString('en-US');
export const signed = (n) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : '±0');
export const pad = (n, w = 4) => String(n).padStart(w, '0');

export function scoreText(c) {
  return c.isCreator ? '∞' : fmt(c.score);
}

export function timeAgo(t) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export function avatar(c, size = 40) {
  const ring = c.tier?.color || 'var(--line)';
  const inner = c.photo
    ? `<img src="${esc(c.photo)}" alt="" loading="lazy" decoding="async">`
    : `<span>${esc(initials(c.name))}</span>`;
  return `<span class="avatar${c.isCreator ? ' is-creator' : ''}" style="--s:${size}px;--ring:${esc(ring)}">${inner}</span>`;
}

export function badge(tier, { large = false } = {}) {
  const label = tier.id === 'CREATOR' ? '∞' : tier.id;
  return `<span class="badge${large ? ' badge-lg' : ''}" style="--c:${esc(tier.color)}" title="${esc(tier.name)}">${esc(label)}</span>`;
}

export function deltaChip(d) {
  const cls = d > 0 ? 'pos' : d < 0 ? 'neg' : 'zero';
  return `<span class="delta ${cls}">${signed(d)}</span>`;
}

export function countUp(el, to, { from = Number(el.dataset.value || 0), duration = 900 } = {}) {
  el.dataset.value = to;
  if (!Number.isFinite(to)) { el.textContent = '∞'; return; }
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || from === to) { el.textContent = fmt(to); return; }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function floatDelta(anchor, delta) {
  const r = anchor.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = `float-delta ${delta >= 0 ? 'pos' : 'neg'}`;
  f.textContent = signed(delta);
  f.style.left = `${r.left + r.width / 2}px`;
  f.style.top = `${r.top + window.scrollY}px`;
  document.body.appendChild(f);
  f.addEventListener('animationend', () => f.remove());
}

let toastTimer = 0;
export function toast(message, kind = 'info', ms = 4200) {
  const host = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.setAttribute('role', 'status');
  t.textContent = message;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  clearTimeout(toastTimer);
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 400);
  }, ms);
}

// Score-over-time sparkline: one series, 2px line, crosshair + tooltip on hover.
export function sparkline(host, points, { color = 'currentColor' } = {}) {
  host.innerHTML = '';
  const data = points.filter((p) => p[1] != null);
  if (data.length < 2) {
    host.innerHTML = '<p class="muted small">Not enough history yet. Give it time; the Bureau is patient.</p>';
    return;
  }
  const W = 320, H = 72, P = 6;
  const xs = data.map((p) => p[0]), ys = data.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 40) { const m = (y0 + y1) / 2; y0 = m - 20; y1 = m + 20; }
  // Step positions evenly when timestamps bunch up (a burst of ratings in one minute).
  const X = (i) => P + (i / (data.length - 1)) * (W - 2 * P);
  const Y = (v) => H - P - ((v - y0) / (y1 - y0)) * (H - 2 * P);
  const pts = data.map((p, i) => [X(i), Y(p[1])]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = `${line}L${pts[pts.length - 1][0].toFixed(1)},${H}L${pts[0][0].toFixed(1)},${H}Z`;
  const gid = `g${Math.random().toString(36).slice(2, 8)}`;
  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark" role="img" aria-label="Score history, ${data.length} changes, from ${fmt(ys[0])} to ${fmt(ys[ys.length - 1])}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gid})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="spark-x" y1="0" y2="${H}" vector-effect="non-scaling-stroke" visibility="hidden"/>
    </svg>
    <span class="spark-dot" hidden style="--c:${color}"></span>
    <div class="spark-tip" hidden><strong></strong><span></span></div>`;
  const svg = host.querySelector('svg');
  const xl = host.querySelector('.spark-x');
  const dot = host.querySelector('.spark-dot');
  const tip = host.querySelector('.spark-tip');
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const rel = ((clientX - r.left) / r.width) * W;
    let i = Math.round(((rel - P) / (W - 2 * P)) * (data.length - 1));
    i = Math.max(0, Math.min(data.length - 1, i));
    const [px, py] = pts[i];
    xl.setAttribute('x1', px); xl.setAttribute('x2', px); xl.setAttribute('visibility', 'visible');
    const left = (px / W) * r.width, top = (py / H) * r.height;
    dot.hidden = false; dot.style.left = `${left}px`; dot.style.top = `${top}px`;
    tip.hidden = false;
    tip.querySelector('strong').textContent = fmt(data[i][1]);
    tip.querySelector('span').textContent = new Date(data[i][0]).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    tip.style.left = `${Math.min(Math.max(left, 50), r.width - 50)}px`;
  };
  const hide = () => { xl.setAttribute('visibility', 'hidden'); dot.hidden = true; tip.hidden = true; };
  svg.addEventListener('pointermove', (e) => show(e.clientX));
  svg.addEventListener('pointerleave', hide);
}
