import { api } from './api.js';
import {
  $, $$, esc, fmt, signed, pad, scoreText, timeAgo, avatar, badge, deltaChip, countUp, floatDelta, toast, sparkline,
} from './ui.js';
import { FaceViewer } from './face3d.js';
import { LINES } from './face-topology.js';
import * as scan from './scan.js';

const state = { me: null, rules: null, decree: null, hasCreator: false, creatorReserved: false };
const app = $('#app');
let navId = 0;
let cleanups = [];

function onCleanup(nav, fn) {
  if (nav !== navId) fn();
  else cleanups.push(fn);
}

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    const [s, rules] = await Promise.all([api.get('/state'), api.get('/rules')]);
    Object.assign(state, s, { rules });
  } catch (e) {
    app.innerHTML = `<section class="empty"><h1 class="display">The Bureau is closed.</h1><p class="muted">${esc(e.message)}</p></section>`;
    return;
  }
  applyMe();
  renderDecree();
  window.addEventListener('hashchange', route);
  route();
}

function setMe(me) {
  const before = state.me?.tier?.id;
  state.me = me;
  applyMe();
  if (me && before && before !== me.tier.id) {
    const t = me.tier;
    toast(me.tier.id === 'CREATOR' ? 'All hail.' : `Your standing is now ${t.id}: ${t.name}.`, 'tier', 6000);
  }
}

function applyMe() {
  const me = state.me;
  document.body.dataset.tier = me ? me.tier.id : 'guest';
  $('#nav-me').innerHTML = me
    ? `<a href="#/c/${esc(me.username)}" class="nav-me" aria-label="Your record">${avatar(me, 30)}<span class="nav-score">${scoreText(me)}</span>${badge(me.tier)}</a>`
    : `<a href="#/login" class="nav-link">Sign in</a><a class="btn btn-sm" href="#/enroll">Enroll</a>`;
  const b = $('#status-banner');
  const msg = {
    AAA: '✦ Exemplary Citizen. Your ratings count double and your halo is visible to all.',
    B: '👁 You are under observation. Your ratings count 0.75×. <a href="#/reeducation">Re-education is available.</a>',
    C: 'Cause for Concern. Colour privileges suspended and bandwidth reallocated to better citizens. <a href="#/reeducation">Begin re-education →</a>',
    D: 'PERSONA NON GRATA. You may only praise. Font privileges revoked. <a href="#/reeducation">Re-education →</a>',
  }[me?.tier.id];
  b.innerHTML = msg ? `<div class="banner banner-${me.tier.id}">${msg}</div>` : '';
  $('#eye').toggleAttribute('hidden', !me || !['B', 'C', 'D'].includes(me.tier.id));
}

function renderDecree() {
  const d = $('#decree');
  if (state.decree?.text) {
    d.hidden = false;
    d.innerHTML = `<span class="decree-label">Decree of The Creator</span><span class="decree-text">${esc(state.decree.text)}</span>`;
  } else d.hidden = true;
}

// The watchful eye that follows citizens under observation.
document.addEventListener('pointermove', (e) => {
  const eye = $('#eye');
  if (!eye || eye.hasAttribute('hidden')) return;
  const r = eye.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / 300) * 5;
  eye.querySelector('.pupil').setAttribute('transform', `translate(${(dx / d) * k} ${(dy / d) * k})`);
});

// ------------------------------------------------------------------ router
const routes = [
  [/^\/?$/, viewHome],
  [/^\/c\/([a-z0-9_]{1,20})$/, viewProfile],
  [/^\/enroll$/, viewEnroll],
  [/^\/scan$/, viewScan],
  [/^\/login$/, viewLogin],
  [/^\/handbook$/, viewHandbook],
  [/^\/reeducation$/, viewReeducation],
];

const THROTTLE_LINES = [
  'Reallocating bandwidth to citizens of higher standing…',
  'Your request is queued behind three Exemplary Citizens…',
  'Loading at a speed appropriate to your standing…',
  'Buffering. Have you considered re-education?',
];

async function route() {
  const nav = ++navId;
  cleanups.forEach((fn) => fn());
  cleanups = [];
  const path = location.hash.replace(/^#/, '') || '/';
  let view = viewNotFound, args = [];
  for (const [re, v] of routes) {
    const m = path.match(re);
    if (m) { view = v; args = m.slice(1); break; }
  }
  $$('.topnav a[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (path.split('/')[1] || 'home')));

  if (state.me && ['C', 'D'].includes(state.me.tier.id)) {
    const t = $('#throttle');
    t.querySelector('p').textContent = THROTTLE_LINES[Math.floor(Math.random() * THROTTLE_LINES.length)];
    t.hidden = false;
    await new Promise((r) => setTimeout(r, state.me.tier.id === 'D' ? 1600 : 1100));
    t.hidden = true;
    if (nav !== navId) return;
  }

  const root = document.createElement('div');
  root.className = 'view';
  app.replaceChildren(root);
  window.scrollTo(0, 0);
  try {
    await view({ root, nav }, ...args);
  } catch (e) {
    console.error(e);
    if (nav === navId) root.innerHTML = `<section class="empty"><p class="eyebrow">Irregularity</p><h1 class="display">Something went wrong.</h1><p class="muted">${esc(e.message)}</p><a class="btn" href="#/">Return to the registry</a></section>`;
  }
}

function viewNotFound({ root }) {
  root.innerHTML = `<section class="empty"><p class="eyebrow">Error 404</p><h1 class="display">This page has been <em>redacted</em>.</h1><a class="btn" href="#/">Return to the registry</a></section>`;
}

// ------------------------------------------------------------------ shared bits
const tierById = (id) => (id === 'CREATOR' ? state.rules.creator : state.rules.tiers.find((t) => t.id === id)) || { id, name: id, color: '#888' };

function who(b) {
  if (!b) return '<b>someone</b>';
  return `<a class="who" href="#/c/${esc(b.username)}" style="--c:${esc(b.tier.color)}">${esc(b.name)}</a>`;
}

const KIND_ICON = { reflected: '↩', loyalty: '✦', fee: '¤', promoted: '▲', demoted: '▼', enrolled: '◎', scanned: '⌖', refused: '⊘', reeducated: '✎', 'failed-reeducation': '✗', amnesty: '❖', decree: '§' };

function feedLine(e) {
  const u = who(e.user), a = who(e.actor), t = who(e.target);
  const why = e.reason ? `<span class="why">${esc(e.reason.label)}</span>` : '';
  switch (e.kind) {
    case 'rated': return e.reason?.base > 0 ? `${a} commended ${u} ${why}` : `${a} reported ${u} ${why}`;
    case 'reflected': return `${u} tried to criticise ${t} ${why}<span class="why">Redirected to sender</span>`;
    case 'praised': return `${a} praised ${u} ${why}`;
    case 'loyalty': return `${u} earned a loyalty dividend`;
    case 'fee': return e.note === 'envy' ? `${u} paid envy tax for reporting ${t}` : `${u} paid a fraternization fee for praising ${t}`;
    case 'promoted': return `${u} was promoted to <b>${esc(tierById(e.note).name)}</b>`;
    case 'demoted': return `${u} was demoted to <b>${esc(tierById(e.note).name)}</b>`;
    case 'enrolled': return e.user?.isCreator ? `${u} has arrived. All is well.` : `${u} enrolled as a citizen`;
    case 'scanned': return `${u} submitted biometrics`;
    case 'refused': return `${u} refused biometrics`;
    case 'reeducated': return `${u} completed re-education`;
    case 'failed-reeducation': return `${u} failed re-education. It has been noted.`;
    case 'amnesty': return `${a} granted ${u} amnesty`;
    case 'decree': return `${u} decreed: “${esc(e.note)}”`;
    default: return `${u} · ${esc(e.kind)}`;
  }
}

function feedItem(e) {
  const icon = e.reason ? e.reason.emoji : KIND_ICON[e.kind] || '·';
  const d = e.delta ? deltaChip(e.delta) : '';
  return `<li class="fi" data-id="${e.id}"><span class="fi-icon" aria-hidden="true">${esc(icon)}</span><p>${feedLine(e)}</p><span class="fi-meta">${d}<time datetime="${new Date(e.at).toISOString()}">${timeAgo(e.at)}</time></span></li>`;
}

function hud({ no, right, left, hint = 'Drag to rotate' }) {
  return `<div class="hud" aria-hidden="true">
    <span class="hud-tl">Biometric record<b>Nº ${esc(no)}</b></span>
    <span class="hud-tr">${right}</span>
    <span class="hud-bl">${esc(left)}</span>
    <span class="hud-br">${esc(hint)}</span>
    <i class="corner c1"></i><i class="corner c2"></i><i class="corner c3"></i><i class="corner c4"></i>
  </div>`;
}

function meshLabel(c) {
  if (c.mesh) return '478 landmarks · 904 facets';
  if (c.photo) return 'Flat portrait · approximated';
  return c.biometricsRefused ? 'Biometrics refused' : 'No biometrics on file';
}

function mountViewer(el, nav, subject) {
  const v = new FaceViewer(el);
  onCleanup(nav, () => v.dispose());
  v.show(subject);
  return v;
}

// ------------------------------------------------------------------ home
async function viewHome({ root, nav }) {
  const me = state.me;
  root.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Bureau of Civic Standing · Est. 2026</p>
        <h1 class="display">Everyone is rated.<br><em>Some, more highly.</em></h1>
        <p class="lede">Commend your friends. Report their infractions. Watch their faces turn in three dimensions as their standing rises and falls. Only one citizen is beyond reproach.</p>
        <div class="actions">
          ${me ? `<a class="btn" href="#/c/${esc(me.username)}">Your record</a>` : `<a class="btn" href="#/enroll">Enroll as a citizen</a>`}
          <a class="btn btn-ghost" href="#/handbook">What do credits do?</a>
        </div>
        <dl class="kpis" id="kpis"><div><dt>Citizens</dt><dd>–</dd></div><div><dt>Ratings today</dt><dd>–</dd></div><div><dt>Average standing</dt><dd>–</dd></div></dl>
      </div>
      <figure class="viewer hero-viewer" id="hero-viewer"></figure>
    </section>
    <section class="split">
      <div>
        <header class="section-head"><h2>The Registry</h2><span class="muted small">Ranked by standing</span></header>
        <ol class="registry" id="registry"><li class="muted">Consulting the archive…</li></ol>
      </div>
      <aside>
        <header class="section-head"><h2>Live from the Bureau</h2><span class="live"><i></i>Live</span></header>
        <ol class="feed" id="feed"></ol>
      </aside>
    </section>`;

  const load = async () => Promise.all([api.get('/citizens'), api.get('/feed'), api.get('/stats')]);
  const [{ citizens }, { feed }, stats] = await load();
  if (nav !== navId) return;

  const renderKpis = (s) => {
    $('#kpis', root).innerHTML = `
      <div><dt>Citizens</dt><dd>${fmt(s.citizens)}</dd></div>
      <div><dt>Ratings today</dt><dd>${fmt(s.ratingsToday)}</dd></div>
      <div><dt>Average standing</dt><dd>${s.average == null ? '–' : fmt(s.average)}</dd></div>`;
  };
  const renderRegistry = (list) => {
    const el = $('#registry', root);
    if (!list.length) {
      el.innerHTML = `<li class="empty-row"><p>The registry is empty.</p><p class="muted small">${state.creatorReserved ? 'Enroll to become the first citizen.' : 'The first citizen to enroll becomes <b>The Creator</b>, whose credit is perfect forever.'}</p><a class="btn btn-sm" href="#/enroll">Enroll</a></li>`;
      return;
    }
    el.innerHTML = list.map((c) => `
      <li><a class="row${c.isCreator ? ' row-creator' : ''}${me && me.id === c.id ? ' row-me' : ''}" href="#/c/${esc(c.username)}">
        <span class="rank">${c.isCreator ? '♛' : pad(c.rank, 2)}</span>
        ${avatar(c, 44)}
        <span class="row-who"><b>${esc(c.name)}</b><small>@${esc(c.username)} · ${esc(c.tier.name)}</small></span>
        <span class="row-score"><b>${scoreText(c)}</b>${c.isCreator ? '<span class="delta zero">fixed</span>' : deltaChip(c.delta24h)}</span>
        ${badge(c.tier)}
      </a></li>`).join('');
  };
  let lastFeedId = 0;
  const renderFeed = (items) => {
    const el = $('#feed', root);
    if (!items.length) { el.innerHTML = '<li class="muted small">Silence. Suspicious.</li>'; return; }
    el.innerHTML = items.map(feedItem).join('');
    $$('.fi', el).forEach((li) => { if (Number(li.dataset.id) > lastFeedId && lastFeedId) li.classList.add('new'); });
    lastFeedId = items[0]?.id || 0;
  };
  renderKpis(stats);
  renderRegistry(citizens);
  renderFeed(feed);

  const heroEl = $('#hero-viewer', root);
  const subject = citizens.find((c) => c.isCreator) || citizens[0];
  if (subject) {
    heroEl.innerHTML = `${hud({ no: pad(subject.citizenNo), right: `Standing<b>${scoreText(subject)}</b>`, left: meshLabel(subject) })}
      <figcaption><a href="#/c/${esc(subject.username)}">${esc(subject.name)}</a><span>${subject.isCreator ? 'The Creator · beyond rating' : esc(subject.tier.name)}</span></figcaption>`;
    mountViewer(heroEl, nav, { photo: subject.photo, mesh: subject.mesh, tier: subject.tier.id, name: subject.name });
  } else {
    heroEl.innerHTML = `${hud({ no: '0001', right: 'Standing<b>∞</b>', left: 'Position vacant' })}
      <figcaption><a href="#/enroll">Vacancy: The Creator</a><span>${state.creatorReserved ? 'Reserved' : 'Enroll first to claim it'}</span></figcaption>`;
    mountViewer(heroEl, nav, { photo: null, mesh: null, tier: 'CREATOR', name: '?' });
  }

  const timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const [{ citizens: c2 }, { feed: f2 }, s2] = await load();
      if (nav !== navId) return;
      renderRegistry(c2); renderFeed(f2); renderKpis(s2);
    } catch { /* offline; try again next tick */ }
  }, 8000);
  onCleanup(nav, () => clearInterval(timer));
}

// ------------------------------------------------------------------ profile
async function viewProfile({ root, nav }, username) {
  let data = await api.get(`/citizens/${encodeURIComponent(username)}`);
  if (nav !== navId) return;
  const me = state.me;
  let c = data.citizen;
  const own = me && me.id === c.id;
  const tier = () => tierById(c.tier.id);

  root.innerHTML = `
    <section class="profile">
      <figure class="viewer profile-viewer" id="pv">${hud({ no: pad(c.citizenNo), right: `Classification<b>${esc(c.tier.id === 'CREATOR' ? 'AAA+' : c.tier.id)}</b>`, left: meshLabel(c) })}</figure>
      <div class="dossier">
        <p class="eyebrow">Citizen Nº ${pad(c.citizenNo)} · Enrolled ${timeAgo(c.joinedAt)}</p>
        <h1 class="display name">${esc(c.name)}</h1>
        <p class="handle">@${esc(c.username)}</p>
        <div class="score-block">
          <span class="score" id="score" data-value="0" style="--c:${esc(c.tier.color)}">${scoreText(c)}</span>
          <span id="score-delta"></span>
        </div>
        <p class="tier-line" id="tier-line"></p>
        <div class="spark-wrap"><p class="label">Standing over time</p><div class="spark-host" id="spark"></div></div>
        <dl class="stats3" id="stats3"></dl>
        <div id="panel"></div>
      </div>
    </section>
    <section class="record-section">
      <header class="section-head"><h2>Official record</h2><span class="muted small">Every change, in order</span></header>
      <ol class="feed record" id="record"></ol>
    </section>`;

  const viewer = mountViewer($('#pv', root), nav, { photo: c.photo, mesh: c.mesh, tier: c.tier.id, name: c.name });

  const renderHead = () => {
    const t = tier();
    $('#tier-line', root).innerHTML = c.isCreator
      ? `${badge(c.tier, { large: true })}<span><b>The Creator</b> · Beyond rating · Score fixed at ∞</span>`
      : `${badge(c.tier, { large: true })}<span><b>${esc(t.name)}</b> · Rank #${c.rank} · Weight ×${t.weight}</span>`;
    $('#score-delta', root).innerHTML = c.isCreator ? '<span class="delta zero">perfect, as always</span>' : `${deltaChip(c.delta24h)}<small class="muted"> last 24h</small>`;
    $('#score', root).style.setProperty('--c', c.tier.color);
    $('#stats3', root).innerHTML = `
      <div><dt>Merits</dt><dd>${fmt(data.stats.merits)}</dd></div>
      <div><dt>Infractions</dt><dd>${fmt(data.stats.infractions)}</dd></div>
      <div><dt>Ratings given</dt><dd>${fmt(data.stats.given)}</dd></div>`;
    sparkline($('#spark', root), c.isCreator ? [] : data.history, { color: c.tier.color });
    if (c.isCreator) $('#spark', root).innerHTML = '<p class="muted small">A flat line at infinity. The Creator does not fluctuate.</p>';
    $('#record', root).innerHTML = data.record.length ? data.record.map(feedItem).join('') : '<li class="muted small">A spotless, empty record.</li>';
  };
  renderHead();
  const scoreEl = $('#score', root);
  if (!c.isCreator) countUp(scoreEl, c.score, { from: Math.max(0, c.score - 120), duration: 1100 });

  const panel = $('#panel', root);
  const renderPanel = () => {
    if (own) return renderOwnPanel(panel, nav);
    if (!state.me) {
      panel.innerHTML = `<div class="panel"><h3>File a rating</h3><p class="muted">Only enrolled citizens may rate. Anonymous judgement is unbecoming.</p><div class="actions"><a class="btn" href="#/enroll">Enroll</a><a class="btn btn-ghost" href="#/login">Sign in</a></div></div>`;
      return;
    }
    const myTier = tierById(state.me.tier.id);
    const w = state.me.tier.weight;
    const left = state.me.allowance.limit == null ? '∞' : Math.max(0, state.me.allowance.limit - state.me.allowance.used);
    const amount = (r) => {
      if (c.isCreator) return r.delta > 0 ? `+${state.rules.constants.LOYALTY_DIVIDEND} to you` : '';
      return signed(Math.round(r.delta * w));
    };
    const chip = (r) => {
      const disabled = r.delta < 0 && !myTier.canCriticise;
      return `<button class="chip ${r.delta > 0 ? 'chip-pos' : 'chip-neg'}" data-reason="${esc(r.id)}" ${disabled ? 'disabled title="Personae non gratae may only praise"' : ''}>
        <span class="chip-emoji" aria-hidden="true">${r.emoji}</span><span class="chip-label">${esc(r.label)}</span><span class="chip-amt">${esc(amount(r))}</span></button>`;
    };
    const merits = state.rules.reasons.filter((r) => r.delta > 0);
    const infractions = state.rules.reasons.filter((r) => r.delta < 0);
    const cooling = data.cooldownUntil && data.cooldownUntil > Date.now();
    panel.innerHTML = `
      <div class="panel rate${cooling ? ' is-cooling' : ''}">
        <div class="panel-head"><h3>File a rating</h3><span class="muted small">Your weight ×${w} · ${left} left today</span></div>
        ${c.isCreator ? '<p class="note">The Creator welcomes all feedback.</p>' : ''}
        <p class="label">Merits</p><div class="chips">${merits.map(chip).join('')}</div>
        <p class="label">Infractions</p><div class="chips">${infractions.map(chip).join('')}</div>
        ${cooling ? `<div class="cooldown">You rated ${esc(c.name)} recently. The Bureau is digesting it. <span id="cd"></span></div>` : ''}
        ${state.me.isCreator && !c.isCreator ? `<div class="creator-tools"><button class="btn btn-ghost btn-sm" id="amnesty">Grant amnesty (reset to ${state.rules.constants.START_SCORE})</button></div>` : ''}
      </div>`;
    if (cooling) {
      const cd = $('#cd', panel);
      const tick = () => {
        const s = Math.max(0, Math.round((data.cooldownUntil - Date.now()) / 1000));
        cd.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s <= 0) { data.cooldownUntil = null; renderPanel(); }
      };
      tick();
      const iv = setInterval(tick, 1000);
      onCleanup(nav, () => clearInterval(iv));
    }
    $$('.chip', panel).forEach((b) => b.addEventListener('click', () => rate(b.dataset.reason, b)));
    $('#amnesty', panel)?.addEventListener('click', async () => {
      const r = await api.post(`/citizens/${encodeURIComponent(c.username)}/amnesty`);
      toast(`${c.name} has been granted amnesty. Their record is clean, their gratitude eternal.`, 'pos');
      c = r.citizen;
      await refresh(true);
    });
  };

  const refresh = async (reshow = false) => {
    const prevTier = c.tier.id;
    const prevScore = c.score;
    data = await api.get(`/citizens/${encodeURIComponent(c.username)}`);
    if (nav !== navId) return;
    c = data.citizen;
    renderHead();
    if (!c.isCreator && prevScore !== c.score) countUp(scoreEl, c.score, { from: prevScore, duration: 800 });
    if (reshow || prevTier !== c.tier.id) viewer.show({ photo: c.photo, mesh: c.mesh, tier: c.tier.id, name: c.name });
    renderPanel();
  };

  const rate = async (reasonId, btn) => {
    $$('.chip', panel).forEach((b) => { b.disabled = true; });
    try {
      const r = await api.post(`/citizens/${encodeURIComponent(c.username)}/rate`, { reasonId });
      setMe(r.me);
      const main = r.entries[0];
      if (r.outcome === 'reflected') {
        viewer.pulse(false);
        floatDelta(btn, main.delta);
        toast(r.message, 'neg', 7000);
        document.body.classList.add('shake');
        setTimeout(() => document.body.classList.remove('shake'), 600);
      } else if (r.outcome === 'loyal') {
        viewer.pulse(true);
        floatDelta(btn, r.entries[1]?.delta || 0);
        toast(r.message, 'pos');
      } else {
        viewer.pulse(main.delta >= 0);
        floatDelta(scoreEl, main.delta);
        toast(r.message, main.delta >= 0 ? 'pos' : 'neg', r.entries.length > 1 ? 7000 : 4200);
      }
      await refresh();
    } catch (e) {
      toast(e.message, 'warn', 6000);
      renderPanel();
    }
  };

  renderPanel();

  const poll = setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 15000);
  onCleanup(nav, () => clearInterval(poll));
}

function renderOwnPanel(panel, nav) {
  const me = state.me;
  const t = tierById(me.tier.id);
  const k = state.rules.constants;
  const left = me.allowance.limit == null ? 'Unlimited' : `${Math.max(0, me.allowance.limit - me.allowance.used)} of ${me.allowance.limit}`;
  const effects = [
    ...t.perks.map((p) => `<li class="perk">${esc(p)}</li>`),
    ...t.penalties.map((p) => `<li class="penalty">${esc(p)}</li>`),
  ].join('');
  const re = me.reeducation;
  const reReady = re.eligible && Date.now() >= re.nextAt;
  panel.innerHTML = `
    <div class="panel own">
      <div class="panel-head"><h3>Your standing</h3>${badge(me.tier)}</div>
      <dl class="facts">
        <div><dt>Rating weight</dt><dd>×${t.weight}</dd></div>
        <div><dt>Ratings left today</dt><dd>${left}</dd></div>
        <div><dt>May criticise</dt><dd>${t.canCriticise ? 'Yes' : 'No'}</dd></div>
      </dl>
      <p class="label">Currently in effect</p>
      <ul class="effects">${effects}</ul>
      ${me.isCreator ? `
        <form class="decree-form" id="decree-form">
          <label class="label" for="decree-in">Issue a decree</label>
          <div class="inline"><input id="decree-in" maxlength="140" placeholder="e.g. Snacks are mandatory on Fridays." value="${esc(state.decree?.text || '')}"><button class="btn btn-sm">Proclaim</button></div>
          <p class="muted small">Shown to every citizen at the top of every page. Leave empty to repeal.</p>
        </form>` : ''}
      <div class="actions">
        <a class="btn btn-sm" href="#/scan">${me.photo ? 'Update biometrics' : 'Submit biometrics'}</a>
        ${re.eligible ? `<a class="btn btn-sm ${reReady ? 'btn-gold' : 'btn-ghost'}" href="#/reeducation">${reReady ? `Re-education (+${k.REEDUCATION_REWARD})` : `Re-education in ${Math.ceil((re.nextAt - Date.now()) / 36e5)}h`}</a>` : ''}
        <button class="btn btn-ghost btn-sm" id="logout">Sign out</button>
      </div>
    </div>`;
  $('#logout', panel).addEventListener('click', async () => {
    await api.post('/logout');
    setMe(null);
    location.hash = '#/';
  });
  $('#decree-form', panel)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api.post('/decree', { text: $('#decree-in', panel).value });
    state.decree = r.decree;
    renderDecree();
    toast(r.decree ? 'Decree proclaimed. The people rejoice.' : 'Decree repealed.', 'pos');
  });
}

// ------------------------------------------------------------------ enroll / login
async function viewEnroll({ root, nav }) {
  if (state.me) {
    location.hash = state.me.photo ? `#/c/${state.me.username}` : '#/scan';
    return;
  }
  const creatorNote = !state.hasCreator && !state.creatorReserved
    ? '<p class="note gold">No Creator has been appointed. The first citizen to enroll becomes <b>The Creator</b>, with a permanently perfect score.</p>'
    : '';
  root.innerHTML = `
    <section class="narrow">
      <p class="eyebrow">Step 1 of 2 · Registration</p>
      <h1 class="display">Become a <em>citizen</em>.</h1>
      <p class="lede">Every citizen starts at <b>${fmt(state.rules.constants.START_SCORE)}</b>. Where you go from there is up to your friends.</p>
      ${creatorNote}
      <form class="form" id="enroll-form" autocomplete="on">
        <label>Display name<input name="name" maxlength="40" required placeholder="Ada Lovelace" autocomplete="name"></label>
        <label>Username<input name="username" required pattern="[a-z0-9_]{3,20}" placeholder="ada" autocomplete="username" autocapitalize="none" spellcheck="false"><small>3–20 lowercase letters, digits or underscores.</small></label>
        <label>Password<input name="password" type="password" minlength="6" required autocomplete="new-password"></label>
        <button class="btn btn-lg">Continue to biometrics</button>
        <p class="muted small">Already a citizen? <a href="#/login">Sign in</a>.</p>
      </form>
    </section>`;
  $('#enroll-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api.post('/register', { name: f.get('name'), username: String(f.get('username')).toLowerCase(), password: f.get('password') });
      state.hasCreator = state.hasCreator || r.me.isCreator;
      setMe(r.me);
      if (r.me.isCreator) toast('You are The Creator. Your credit is perfect, and always will be.', 'tier', 7000);
      location.hash = '#/scan';
    } catch (err) {
      toast(err.message, 'warn');
      btn.disabled = false;
    }
  });
}

async function viewLogin({ root }) {
  root.innerHTML = `
    <section class="narrow">
      <p class="eyebrow">Identification</p>
      <h1 class="display">Welcome <em>back</em>.</h1>
      <form class="form" id="login-form">
        <label>Username<input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false"></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn btn-lg">Sign in</button>
        <p class="muted small">New here? <a href="#/enroll">Enroll</a>.</p>
      </form>
    </section>`;
  $('#login-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api.post('/login', { username: f.get('username'), password: f.get('password') });
      setMe(r.me);
      location.hash = `#/c/${r.me.username}`;
    } catch (err) { toast(err.message, 'warn'); }
  });
}

// ------------------------------------------------------------------ biometrics
async function viewScan({ root, nav }) {
  if (!state.me) { location.hash = '#/enroll'; return; }
  const me = state.me;
  root.innerHTML = `
    <section class="scan-page">
      <header>
        <p class="eyebrow">${me.photo ? 'Biometric update' : 'Step 2 of 2 · Biometrics'}</p>
        <h1 class="display">Present your <em>face</em>.</h1>
        <p class="lede">A front-facing portrait becomes a 478-point 3D mesh. Detection runs on your device; only the cropped portrait and the mesh are sent to the Bureau.</p>
      </header>
      <div class="bio">
        <div class="bio-stage" id="stage">
          <div class="drop" id="drop">
            <svg viewBox="0 0 120 140" class="drop-face" aria-hidden="true"><ellipse cx="60" cy="68" rx="40" ry="52"/><path d="M42 60h8M70 60h8M60 64v14l-5 4M48 96q12 8 24 0"/></svg>
            <p><b>Drop a portrait here</b></p>
            <div class="actions">
              <label class="btn">Choose a photo<input type="file" accept="image/*" id="file" hidden></label>
              <button class="btn btn-ghost" id="cam-btn" type="button">Use camera</button>
            </div>
            <p class="muted small">Face forward, even light, no sunglasses. The Bureau prefers a neutral expression; it does not insist.</p>
          </div>
          <div class="cam" id="cam" hidden>
            <video playsinline muted></video>
            <div class="cam-guide" aria-hidden="true"></div>
            <div class="actions"><button class="btn" id="snap" type="button">Capture</button><button class="btn btn-ghost" id="cam-cancel" type="button">Cancel</button></div>
          </div>
          <div class="scan-photo" id="scan-photo" hidden><img alt="Your portrait"><canvas width="512" height="512"></canvas><div class="scanline"></div></div>
          <figure class="viewer scan-viewer" id="scan-viewer" hidden></figure>
        </div>
        <aside class="bio-side">
          <p class="label">Bureau console</p>
          <ol class="log" id="log"><li>Awaiting subject.</li></ol>
          <div class="actions" id="confirm" hidden>
            <button class="btn" id="submit" type="button">Submit biometrics</button>
            <button class="btn btn-ghost" id="retry" type="button">Try another</button>
          </div>
          ${me.photo || me.biometricsRefused ? '' : `<button class="link refuse" id="refuse" type="button">Refuse biometrics (${state.rules.constants.NO_BIOMETRICS_PENALTY} credits)</button>`}
        </aside>
      </div>
    </section>`;

  // Warm the model while the user picks a photo.
  scan.loadLandmarker().catch(() => {});

  const log = $('#log', root);
  const say = (text, cls = '') => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.textContent = text;
    log.appendChild(li);
    log.scrollTop = log.scrollHeight;
    return li;
  };
  const els = {
    drop: $('#drop', root), cam: $('#cam', root), photo: $('#scan-photo', root), viewer: $('#scan-viewer', root), confirm: $('#confirm', root),
  };
  let result = null;
  let viewer = null;
  let camera = null;
  onCleanup(nav, () => { camera?.stop(); viewer?.dispose(); });

  const reset = () => {
    result = null;
    els.drop.hidden = false; els.cam.hidden = true; els.photo.hidden = true; els.viewer.hidden = true; els.confirm.hidden = true;
    viewer?.dispose(); viewer = null;
    log.innerHTML = '<li>Awaiting subject.</li>';
  };

  const process = async (canvas) => {
    els.drop.hidden = true; els.cam.hidden = true; els.viewer.hidden = true; els.confirm.hidden = true;
    log.innerHTML = '';
    const preview = scan.centreCrop(canvas).canvas;
    const img = $('img', els.photo);
    img.src = preview.toDataURL('image/jpeg', 0.8);
    const overlay = $('canvas', els.photo);
    overlay.getContext('2d').clearRect(0, 0, 512, 512);
    els.photo.hidden = false;
    els.photo.classList.add('scanning');
    say('Subject received.');
    const l1 = say('Loading face model…', 'busy');
    let points = null;
    try {
      await scan.loadLandmarker();
      l1.className = 'ok';
      l1.textContent = 'Face model ready (MediaPipe, on-device).';
      const l2 = say('Locating face…', 'busy');
      points = await scan.detect(canvas);
      l2.className = points ? 'ok' : 'warn';
      l2.textContent = points ? 'Face located.' : 'No face found. The Bureau will approximate.';
    } catch (e) {
      console.warn(e);
      l1.className = 'warn';
      l1.textContent = 'Face model unavailable. The Bureau will approximate.';
    }
    if (nav !== navId) return;

    result = points ? scan.cropToFace(canvas, points) : scan.centreCrop(canvas);
    img.src = result.canvas.toDataURL('image/jpeg', 0.85);
    if (result.landmarks) {
      say(`${result.landmarks.length / 3} landmarks acquired.`, 'ok');
      await scan.animateLandmarks(overlay, result.landmarks, LINES, { color: '#9cc3ff' });
      say('Reconstructing depth…', 'ok');
    } else {
      say('Sculpting relief from flat portrait…', 'ok');
    }
    els.photo.classList.remove('scanning');
    await new Promise((r) => setTimeout(r, 350));
    if (nav !== navId) return;

    els.photo.hidden = true;
    els.viewer.hidden = false;
    els.viewer.innerHTML = hud({ no: pad(me.citizenNo), right: `Subject<b>${esc(me.name)}</b>`, left: result.landmarks ? '478 landmarks · 904 facets' : 'Flat portrait · approximated' });
    viewer?.dispose();
    viewer = new FaceViewer(els.viewer);
    await viewer.show({ photo: result.canvas.toDataURL('image/jpeg', 0.9), mesh: result.landmarks ? { landmarks: result.landmarks } : null, tier: me.tier.id, name: me.name });
    say(result.landmarks ? 'Biometric record ready. Drag to inspect.' : 'Approximation ready. Drag to inspect.', 'ok');
    els.confirm.hidden = false;
  };

  const handleFile = async (file) => {
    if (!file) return;
    try { await process(await scan.fileToCanvas(file)); } catch (e) { toast(e.message, 'warn'); reset(); }
  };

  $('#file', root).addEventListener('change', (e) => handleFile(e.target.files[0]));
  els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
  els.drop.addEventListener('drop', (e) => { e.preventDefault(); els.drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });

  $('#cam-btn', root).addEventListener('click', async () => {
    try {
      els.drop.hidden = true; els.cam.hidden = false;
      camera = await scan.openCamera($('video', els.cam));
      say('Camera live. Look straight ahead.');
    } catch (e) {
      toast('The camera is unavailable. A photo will do.', 'warn');
      reset();
    }
  });
  $('#cam-cancel', root).addEventListener('click', () => { camera?.stop(); camera = null; reset(); });
  $('#snap', root).addEventListener('click', async () => {
    if (!camera) return;
    const c = camera.capture();
    camera.stop(); camera = null;
    await process(c);
  });
  $('#retry', root).addEventListener('click', reset);
  $('#submit', root).addEventListener('click', async (e) => {
    if (!result) return;
    e.target.disabled = true;
    try {
      const r = await api.post('/me/face', { image: scan.toJpeg(result.canvas), landmarks: result.landmarks });
      setMe(r.me);
      toast('Biometrics accepted. Welcome to the registry.', 'pos');
      location.hash = `#/c/${r.me.username}`;
    } catch (err) {
      toast(err.message, 'warn');
      e.target.disabled = false;
    }
  });
  $('#refuse', root)?.addEventListener('click', async () => {
    const r = await api.post('/me/refuse-biometrics');
    setMe(r.me);
    toast(`Refusal noted. ${state.rules.constants.NO_BIOMETRICS_PENALTY} credits. The Bureau never forgets a face, even one it has never seen.`, 'neg', 7000);
    location.hash = `#/c/${r.me.username}`;
  });
}

// ------------------------------------------------------------------ handbook
function viewHandbook({ root }) {
  const { tiers, creator, reasons, constants: k } = state.rules;
  const range = (t, i) => (i === 0 ? `${fmt(t.min)}+` : `${fmt(t.min)}–${fmt(tiers[i - 1].min - 1)}`);
  root.innerHTML = `
    <section class="handbook">
      <header class="hb-head">
        <p class="eyebrow">The Citizen’s Handbook · Edition 1</p>
        <h1 class="display">What your credit <em>does</em>.</h1>
        <p class="lede">Everyone starts at ${fmt(k.START_SCORE)}. Merits raise you, infractions lower you, and your standing decides how much your own opinion is worth. High scores make the site better for you. Low scores make it worse.</p>
      </header>

      <ol class="ladder">
        <li class="rung rung-creator" style="--c:${creator.color}">
          <div class="rung-id">${badge(creator, { large: true })}<div><h3>${esc(creator.name)}</h3><p class="muted small">Score ∞ · Weight ×${creator.weight}</p></div></div>
          <ul class="effects">${creator.perks.map((p) => `<li class="perk">${esc(p)}</li>`).join('')}</ul>
        </li>
        ${tiers.map((t, i) => `
        <li class="rung" style="--c:${t.color}">
          <div class="rung-id">${badge(t, { large: true })}<div><h3>${esc(t.name)}</h3><p class="muted small">${range(t, i)} · Weight ×${t.weight} · ${t.dailyVotes} ratings/day</p></div></div>
          <ul class="effects">${t.perks.map((p) => `<li class="perk">${esc(p)}</li>`).join('')}${t.penalties.map((p) => `<li class="penalty">${esc(p)}</li>`).join('')}</ul>
        </li>`).join('')}
      </ol>

      <h2 class="hb-h2">Special provisions</h2>
      <div class="laws">
        <article><h3>§1 The Creator</h3><p>The site’s founder holds a permanent score of ∞. Criticising The Creator is permitted, technically: the deduction is applied to the critic at ${k.REFLECTION_MULTIPLIER}×. Praise earns the praiser a loyalty dividend of +${k.LOYALTY_DIVIDEND}.</p></article>
        <article><h3>§2 Weighted opinion</h3><p>Every rating is multiplied by the rater’s weight. An Exemplary Citizen’s “Took the last slice” costs twice as much as yours. A Persona Non Grata’s barely registers.</p></article>
        <article><h3>§3 Envy tax</h3><p>Reporting an Exemplary Citizen costs the reporter ${signed(k.ENVY_TAX)}. Success is not a crime.</p></article>
        <article><h3>§4 Fraternization</h3><p>Praising a Persona Non Grata costs the praiser ${signed(k.FRATERNIZATION_FEE)}. Choose your friends carefully.</p></article>
        <article><h3>§5 Cooling off</h3><p>You may rate the same citizen once every ${k.SAME_TARGET_COOLDOWN_MIN} minutes. Self-assessment is not permitted.</p></article>
        <article><h3>§6 Biometrics</h3><p>Citizens present a front-facing portrait, which becomes a 3D record. Refusing costs ${signed(k.NO_BIOMETRICS_PENALTY)}. Only you can upload your face; nobody can enroll someone else.</p></article>
        <article><h3>§7 Re-education</h3><p>Citizens below ${fmt(k.START_SCORE)} may take a short loyalty quiz every ${k.REEDUCATION_COOLDOWN_H} hours. Pass all three questions to earn +${k.REEDUCATION_REWARD}.</p></article>
        <article><h3>§8 Limits</h3><p>Scores run from ${fmt(k.MIN_SCORE)} to ${fmt(k.MAX_SCORE)}. Nobody but The Creator escapes gravity.</p></article>
      </div>

      <h2 class="hb-h2">Catalogue of merits and infractions</h2>
      <div class="catalogue">
        <div><p class="label">Merits</p><ul>${reasons.filter((r) => r.delta > 0).map((r) => `<li><span>${r.emoji} ${esc(r.label)}</span>${deltaChip(r.delta)}</li>`).join('')}</ul></div>
        <div><p class="label">Infractions</p><ul>${reasons.filter((r) => r.delta < 0).map((r) => `<li><span>${r.emoji} ${esc(r.label)}</span>${deltaChip(r.delta)}</li>`).join('')}</ul></div>
      </div>
      <p class="muted small fineprint">Base values shown. The Bureau is satire. Please don’t build this for real.</p>
    </section>`;
}

// ------------------------------------------------------------------ re-education
async function viewReeducation({ root, nav }) {
  if (!state.me) { location.hash = '#/login'; return; }
  const q = await api.get('/reeducation');
  if (nav !== navId) return;
  if (!q.eligible) {
    root.innerHTML = `<section class="narrow"><p class="eyebrow">Re-education</p><h1 class="display">Not <em>required</em>.</h1><p class="lede">${esc(q.reason)}</p>${q.nextAt ? `<p class="muted">Next session available ${new Date(q.nextAt).toLocaleString()}.</p>` : ''}<a class="btn" href="#/">Return to the registry</a></section>`;
    return;
  }
  root.innerHTML = `
    <section class="narrow">
      <p class="eyebrow">Re-education · Session ${pad(Math.floor(Math.random() * 9000) + 1000)}</p>
      <h1 class="display">A short <em>conversation</em>.</h1>
      <p class="lede">Answer all three correctly to restore ${q.reward} credits. Take your time. Your hesitation is being measured.</p>
      <form class="quiz" id="quiz">
        ${q.questions.map((x, i) => `
          <fieldset><legend><span class="qn">${i + 1}</span>${esc(x.q)}</legend>
            ${x.options.map((o, j) => `<label class="opt"><input type="radio" name="${esc(x.id)}" value="${j}" required><span>${esc(o)}</span></label>`).join('')}
          </fieldset>`).join('')}
        <button class="btn btn-lg">Submit answers</button>
      </form>
    </section>`;
  $('#quiz', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const answers = Object.fromEntries(q.questions.map((x) => [x.id, Number(f.get(x.id))]));
    try {
      const r = await api.post('/reeducation', { answers });
      setMe(r.me);
      for (const res of r.results) {
        const fs = e.target.querySelector(`input[name="${res.id}"]`).closest('fieldset');
        $$('.opt', fs).forEach((o, j) => o.classList.toggle('right', j === res.correct));
        if (!res.ok) $$('.opt', fs)[res.given]?.classList.add('wrong');
      }
      e.target.querySelector('button').remove();
      const out = document.createElement('div');
      out.className = `quiz-result ${r.passed ? 'pass' : 'fail'}`;
      out.innerHTML = r.passed
        ? `<h3>Rehabilitated.</h3><p>+${q.reward} credits restored. The Bureau is proud of you, in a measured way.</p><a class="btn" href="#/c/${esc(r.me.username)}">View your record</a>`
        : `<h3>Not quite.</h3><p>Your answers have been filed. You may try again in ${state.rules.constants.REEDUCATION_COOLDOWN_H} hours.</p><a class="btn btn-ghost" href="#/">Return to the registry</a>`;
      e.target.appendChild(out);
      toast(r.passed ? `Re-education complete. +${q.reward}.` : 'Re-education incomplete.', r.passed ? 'pos' : 'neg');
    } catch (err) { toast(err.message, 'warn'); }
  });
}

boot();
