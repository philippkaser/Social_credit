import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import {
  hashPassword, verifyPassword, createSession, sessionUser, destroySession, sessionCookie, rateLimiter,
} from './lib/auth.js';
import * as R from './lib/rules.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 80);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CREATOR_USERNAME = (process.env.CREATOR_USERNAME || '').toLowerCase() || null;
const HOUR = 36e5;
const DAY = 24 * HOUR;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const store = new Store(DATA_DIR);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------- static files
const nm = (p) => path.join(ROOT, 'node_modules', p);
const immutable = { maxAge: '30d', immutable: true };
app.use('/vendor/three', express.static(nm('three/build'), { maxAge: '7d' }));
app.use('/vendor/mediapipe', express.static(nm('@mediapipe/tasks-vision'), { maxAge: '7d' }));
app.use('/models', express.static(path.join(ROOT, 'models'), { maxAge: '7d' }));
app.use('/uploads', express.static(UPLOAD_DIR, immutable));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------- helpers
const api = express.Router();

// Same-origin check for state-changing requests (cookies are SameSite=Lax too).
api.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request refused.' });
    } catch { return res.status(403).json({ error: 'Bad origin.' }); }
  }
  next();
});

api.use((req, res, next) => {
  req.user = sessionUser(store, req);
  next();
});

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please identify yourself to the Bureau.' });
  next();
}

function requireCreator(req, res, next) {
  if (!req.user?.isCreator) return res.status(403).json({ error: 'Only The Creator may do that.' });
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function delta24hMap() {
  const since = Date.now() - DAY;
  const m = new Map();
  const L = store.ledger;
  for (let i = L.length - 1; i >= 0 && L[i].at >= since; i--) {
    m.set(L[i].userId, (m.get(L[i].userId) || 0) + (L[i].delta || 0));
  }
  return m;
}

function rankMap() {
  const ranked = store.users.filter((u) => !u.isCreator).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  return new Map(ranked.map((u, i) => [u.id, i + 1]));
}

function avatar(u) {
  return u.photo ? `/uploads/${u.photo}.jpg` : null;
}

function brief(u) {
  if (!u) return null;
  const t = R.tierFor(u);
  return { username: u.username, name: u.name, photo: avatar(u), isCreator: !!u.isCreator, tier: { id: t.id, color: t.color } };
}

function publicUser(u, ctx = {}) {
  const tier = R.tierFor(u);
  const deltas = ctx.deltas || delta24hMap();
  const ranks = ctx.ranks || rankMap();
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    citizenNo: u.citizenNo,
    isCreator: !!u.isCreator,
    score: u.isCreator ? null : u.score,
    tier: R.publicTier(tier),
    photo: avatar(u),
    mesh: u.photo && u.hasMesh ? `/uploads/${u.photo}.json` : null,
    biometricsRefused: !!u.biometricsRefused,
    joinedAt: u.joinedAt,
    delta24h: u.isCreator ? 0 : deltas.get(u.id) || 0,
    rank: u.isCreator ? 0 : ranks.get(u.id) || null,
  };
}

function votesUsed(user) {
  const since = Date.now() - DAY;
  let n = 0;
  const L = store.ledger;
  for (let i = L.length - 1; i >= 0 && L[i].at >= since; i--) {
    if (L[i].vote && L[i].actor === user.id) n++;
  }
  return n;
}

function lastVoteOn(user, target) {
  const L = store.ledger;
  const since = Date.now() - R.SAME_TARGET_COOLDOWN_MIN * 60e3;
  for (let i = L.length - 1; i >= 0 && L[i].at >= since; i--) {
    if (L[i].vote && L[i].actor === user.id && L[i].target === target.id) return L[i];
  }
  return null;
}

function reeducationNextAt(user) {
  return (user.lastReeducation || 0) + R.REEDUCATION_COOLDOWN_H * HOUR;
}

function meView(u) {
  if (!u) return null;
  const tier = R.tierFor(u);
  return {
    ...publicUser(u),
    allowance: { used: votesUsed(u), limit: Number.isFinite(tier.dailyVotes) ? tier.dailyVotes : null },
    reeducation: { eligible: !u.isCreator && u.score < R.START_SCORE, nextAt: reeducationNextAt(u) },
  };
}

function renderEntry(e) {
  const reason = e.reasonId ? R.reasonById[e.reasonId] : null;
  return {
    id: e.id,
    at: e.at,
    kind: e.kind,
    delta: e.delta || 0,
    scoreAfter: e.scoreAfter ?? null,
    note: e.note || null,
    user: brief(store.userById(e.userId)),
    actor: e.actor && e.actor !== e.userId ? brief(store.userById(e.actor)) : null,
    target: e.target && e.target !== e.userId ? brief(store.userById(e.target)) : null,
    reason: reason ? { label: reason.label, emoji: reason.emoji, base: reason.delta } : null,
  };
}

// Applies a score change and records it (plus a promotion/demotion entry if the tier moves).
function applyDelta(user, delta, entry) {
  if (user.isCreator) {
    return store.addEntry({ ...entry, userId: user.id, delta: 0, scoreAfter: null });
  }
  const before = user.score;
  const beforeTier = R.tierFor(user);
  user.score = R.clampScore(before + delta);
  const e = store.addEntry({ ...entry, userId: user.id, delta: user.score - before, scoreAfter: user.score });
  const afterTier = R.tierFor(user);
  if (afterTier.id !== beforeTier.id) {
    const up = afterTier.min > beforeTier.min;
    store.addEntry({ kind: up ? 'promoted' : 'demoted', userId: user.id, delta: 0, scoreAfter: user.score, note: afterTier.id });
  }
  return e;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------------------------------------------------------- public reads
api.get('/rules', (req, res) => {
  res.json({
    tiers: R.TIERS,
    creator: { ...R.CREATOR_TIER, dailyVotes: null },
    reasons: R.REASONS,
    constants: {
      START_SCORE: R.START_SCORE, MIN_SCORE: R.MIN_SCORE, MAX_SCORE: R.MAX_SCORE,
      SAME_TARGET_COOLDOWN_MIN: R.SAME_TARGET_COOLDOWN_MIN, NO_BIOMETRICS_PENALTY: R.NO_BIOMETRICS_PENALTY,
      REEDUCATION_REWARD: R.REEDUCATION_REWARD, REEDUCATION_COOLDOWN_H: R.REEDUCATION_COOLDOWN_H,
      FRATERNIZATION_FEE: R.FRATERNIZATION_FEE, ENVY_TAX: R.ENVY_TAX, LOYALTY_DIVIDEND: R.LOYALTY_DIVIDEND,
      REFLECTION_MULTIPLIER: R.REFLECTION_MULTIPLIER,
    },
  });
});

api.get('/state', (req, res) => {
  res.json({
    me: meView(req.user),
    decree: store.data.decree,
    hasCreator: store.users.some((u) => u.isCreator),
    creatorReserved: !!CREATOR_USERNAME,
  });
});

api.get('/citizens', (req, res) => {
  const ctx = { deltas: delta24hMap(), ranks: rankMap() };
  const list = store.users.map((u) => publicUser(u, ctx));
  list.sort((a, b) => (b.isCreator - a.isCreator) || (b.score - a.score) || (a.joinedAt - b.joinedAt));
  res.json({ citizens: list });
});

api.get('/citizens/:username', (req, res) => {
  const u = store.userByName(req.params.username);
  if (!u) return res.status(404).json({ error: 'No such citizen. Perhaps they were never here.' });
  const mine = store.ledger.filter((e) => e.userId === u.id);
  let merits = 0, infractions = 0, given = 0;
  for (const e of store.ledger) {
    if (e.vote && e.target === u.id) {
      const r = R.reasonById[e.reasonId];
      if (r && r.delta > 0) merits++; else if (r) infractions++;
    }
    if (e.vote && e.actor === u.id) given++;
  }
  const history = mine.filter((e) => e.scoreAfter != null && e.delta).map((e) => [e.at, e.scoreAfter]);
  let cooldownUntil = null;
  if (req.user && req.user.id !== u.id && !req.user.isCreator) {
    const last = lastVoteOn(req.user, u);
    if (last) cooldownUntil = last.at + R.SAME_TARGET_COOLDOWN_MIN * 60e3;
  }
  res.json({
    citizen: publicUser(u),
    record: mine.slice(-60).reverse().map(renderEntry),
    history: [[u.joinedAt, u.isCreator ? null : R.START_SCORE], ...history].slice(-200),
    stats: { merits, infractions, given },
    cooldownUntil,
  });
});

api.get('/feed', (req, res) => {
  const L = store.ledger;
  res.json({ feed: L.slice(-40).reverse().map(renderEntry) });
});

api.get('/stats', (req, res) => {
  const citizens = store.users.filter((u) => !u.isCreator);
  const since = Date.now() - DAY;
  let today = 0;
  for (let i = store.ledger.length - 1; i >= 0 && store.ledger[i].at >= since; i--) if (store.ledger[i].vote) today++;
  const avg = citizens.length ? Math.round(citizens.reduce((s, u) => s + u.score, 0) / citizens.length) : null;
  const tiers = Object.fromEntries(R.TIERS.map((t) => [t.id, 0]));
  for (const u of citizens) tiers[R.tierFor(u).id]++;
  res.json({ citizens: store.users.length, ratingsToday: today, average: avg, tiers });
});

// ---------------------------------------------------------------- accounts
const authLimiter = rateLimiter({ windowMs: 10 * 60e3, max: 30 });
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

api.post('/register', authLimiter, wrap(async (req, res) => {
  const username = String(req.body?.username || '').toLowerCase().trim();
  const name = cleanName(req.body?.name) || username;
  const password = String(req.body?.password || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Usernames are 3–20 lowercase letters, digits or underscores.' });
  if (password.length < 6) return res.status(400).json({ error: 'Passwords need at least 6 characters. The Bureau has standards.' });
  if (store.userByName(username)) return res.status(409).json({ error: 'That citizen already exists.' });

  const isCreator = CREATOR_USERNAME
    ? username === CREATOR_USERNAME
    : !store.users.some((u) => u.isCreator);
  const user = {
    id: store.nextId(),
    username,
    name,
    pass: await hashPassword(password),
    isCreator,
    score: isCreator ? R.CREATOR_SCORE : R.START_SCORE,
    citizenNo: store.users.length + 1,
    joinedAt: Date.now(),
    photo: null,
    hasMesh: false,
    biometricsRefused: false,
    lastReeducation: 0,
  };
  store.users.push(user);
  store.addEntry({ kind: 'enrolled', userId: user.id, delta: 0, scoreAfter: isCreator ? null : user.score });
  const token = createSession(store, user.id);
  store.save();
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  res.json({ me: meView(user) });
}));

api.post('/login', authLimiter, wrap(async (req, res) => {
  const user = store.userByName(req.body?.username);
  const ok = user && (await verifyPassword(String(req.body?.password || ''), user.pass));
  if (!ok) return res.status(401).json({ error: 'The Bureau does not recognise those credentials.' });
  const token = createSession(store, user.id);
  res.setHeader('Set-Cookie', sessionCookie(token, req));
  res.json({ me: meView(user) });
}));

api.post('/logout', (req, res) => {
  destroySession(store, req);
  res.setHeader('Set-Cookie', sessionCookie(null, req));
  res.json({ ok: true });
});

// Biometric enrollment: a client-side-cropped JPEG plus (optionally) the 478
// MediaPipe landmarks, normalised to that crop.
api.post('/me/face', requireUser, (req, res) => {
  const { image, landmarks } = req.body || {};
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
  if (!m) return res.status(400).json({ error: 'Expected a JPEG image.' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 1.5e6) return res.status(413).json({ error: 'Image too large.' });
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return res.status(400).json({ error: 'That is not a JPEG.' });

  let mesh = null;
  if (landmarks != null) {
    const ok = Array.isArray(landmarks)
      && (landmarks.length === 478 * 3 || landmarks.length === 468 * 3)
      && landmarks.every((v, i) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < (i % 3 === 2 ? 2 : 3));
    if (!ok) return res.status(400).json({ error: 'Malformed biometric data.' });
    mesh = landmarks.map((v) => Math.round(v * 1e4) / 1e4);
  }

  const u = req.user;
  const old = u.photo;
  const name = `${u.id}-${crypto.randomBytes(8).toString('hex')}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, `${name}.jpg`), buf);
  if (mesh) fs.writeFileSync(path.join(UPLOAD_DIR, `${name}.json`), JSON.stringify({ v: 1, n: mesh.length / 3, landmarks: mesh }));
  u.photo = name;
  u.hasMesh = !!mesh;
  if (old) {
    for (const ext of ['jpg', 'json']) fs.rm(path.join(UPLOAD_DIR, `${old}.${ext}`), { force: true }, () => {});
  }
  store.addEntry({ kind: 'scanned', userId: u.id, delta: 0, scoreAfter: u.isCreator ? null : u.score, note: mesh ? 'mesh' : 'flat' });
  store.save();
  res.json({ me: meView(u) });
});

api.post('/me/refuse-biometrics', requireUser, (req, res) => {
  const u = req.user;
  if (u.photo || u.biometricsRefused) return res.json({ me: meView(u) });
  u.biometricsRefused = true;
  applyDelta(u, R.NO_BIOMETRICS_PENALTY, { kind: 'refused', note: 'biometrics' });
  store.save();
  res.json({ me: meView(u) });
});

// ---------------------------------------------------------------- rating
api.post('/citizens/:username/rate', requireUser, (req, res) => {
  const voter = req.user;
  const target = store.userByName(req.params.username);
  const reason = R.reasonById[req.body?.reasonId];
  if (!target) return res.status(404).json({ error: 'No such citizen.' });
  if (!reason) return res.status(400).json({ error: 'Unknown merit or infraction.' });
  if (target.id === voter.id) return res.status(400).json({ error: 'Self-assessment is the Bureau’s job, not yours.' });

  const tier = R.tierFor(voter);
  const criticism = reason.delta < 0;
  if (criticism && !tier.canCriticise) {
    return res.status(403).json({ error: 'Personae non gratae may only praise. Consider re-education.' });
  }
  if (!voter.isCreator) {
    if (votesUsed(voter) >= tier.dailyVotes) {
      return res.status(429).json({ error: `Daily allowance of ${tier.dailyVotes} ratings exhausted. Improve your standing for a larger allowance.` });
    }
    const last = lastVoteOn(voter, target);
    if (last) {
      const mins = Math.ceil((last.at + R.SAME_TARGET_COOLDOWN_MIN * 60e3 - Date.now()) / 60e3);
      return res.status(429).json({ error: `You rated ${target.name} recently. Let the Bureau digest it for ${mins} more minute${mins === 1 ? '' : 's'}.` });
    }
  }

  const base = { actor: voter.id, target: target.id, reasonId: reason.id };
  const entries = [];
  let outcome;
  let message;

  if (target.isCreator) {
    if (criticism) {
      outcome = 'reflected';
      entries.push(applyDelta(voter, reason.delta * R.REFLECTION_MULTIPLIER, { ...base, kind: 'reflected', vote: true }));
      message = 'Error 451: The Creator cannot be criticised. Your criticism has been redirected to the nearest suspect: you.';
    } else {
      outcome = 'loyal';
      entries.push(store.addEntry({ ...base, kind: 'praised', userId: target.id, delta: 0, scoreAfter: null, vote: true }));
      entries.push(applyDelta(voter, R.LOYALTY_DIVIDEND, { ...base, kind: 'loyalty' }));
      message = `Praise received with grace. A loyalty dividend of +${R.LOYALTY_DIVIDEND} has been credited to you.`;
    }
  } else {
    const targetTier = R.tierFor(target);
    const delta = Math.round(reason.delta * tier.weight);
    outcome = 'rated';
    entries.push(applyDelta(target, delta, { ...base, kind: 'rated', vote: true, note: tier.weight !== 1 ? `×${tier.weight}` : null }));
    message = pick(criticism ? R.BUREAU_LINES.negative : R.BUREAU_LINES.positive);
    if (!voter.isCreator && !criticism && targetTier.id === 'D') {
      entries.push(applyDelta(voter, R.FRATERNIZATION_FEE, { ...base, kind: 'fee', note: 'fraternization' }));
      message += ` A fraternization fee of ${R.FRATERNIZATION_FEE} applies for praising a Persona Non Grata.`;
    }
    if (!voter.isCreator && criticism && targetTier.id === 'AAA') {
      entries.push(applyDelta(voter, R.ENVY_TAX, { ...base, kind: 'fee', note: 'envy' }));
      message += ` Criticising an Exemplary Citizen incurs an envy tax of ${R.ENVY_TAX}.`;
    }
  }
  store.save();
  res.json({ outcome, message, entries: entries.map(renderEntry), target: publicUser(target), me: meView(voter) });
});

// ---------------------------------------------------------------- re-education
api.get('/reeducation', requireUser, (req, res) => {
  const u = req.user;
  if (u.isCreator) return res.json({ eligible: false, reason: 'The Creator has nothing left to learn.' });
  if (u.score >= R.START_SCORE) return res.json({ eligible: false, reason: 'Your standing is satisfactory. Re-education is reserved for citizens below 1000.' });
  const nextAt = reeducationNextAt(u);
  if (Date.now() < nextAt) return res.json({ eligible: false, nextAt, reason: 'You have been re-educated recently. Let it sink in.' });
  const qs = [...R.QUIZ].sort(() => Math.random() - 0.5).slice(0, 3);
  u.quiz = { ids: qs.map((q) => q.id), issuedAt: Date.now() };
  store.save();
  res.json({ eligible: true, reward: R.REEDUCATION_REWARD, questions: qs.map(({ id, q, options }) => ({ id, q, options })) });
});

api.post('/reeducation', requireUser, (req, res) => {
  const u = req.user;
  if (!u.quiz || Date.now() - u.quiz.issuedAt > HOUR) return res.status(400).json({ error: 'No active re-education session.' });
  if (Date.now() < reeducationNextAt(u)) return res.status(429).json({ error: 'Too soon.' });
  const answers = req.body?.answers || {};
  const results = u.quiz.ids.map((id) => {
    const q = R.QUIZ.find((x) => x.id === id);
    return { id, correct: q.correct, given: Number(answers[id]), ok: Number(answers[id]) === q.correct };
  });
  const passed = results.every((r) => r.ok);
  u.quiz = null;
  u.lastReeducation = Date.now();
  if (passed) applyDelta(u, R.REEDUCATION_REWARD, { kind: 'reeducated' });
  else store.addEntry({ kind: 'failed-reeducation', userId: u.id, delta: 0, scoreAfter: u.score });
  store.save();
  res.json({ passed, results, me: meView(u) });
});

// ---------------------------------------------------------------- the Creator
api.post('/decree', requireUser, requireCreator, (req, res) => {
  const text = String(req.body?.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
  store.data.decree = text ? { text, at: Date.now() } : null;
  if (text) store.addEntry({ kind: 'decree', userId: req.user.id, delta: 0, note: text });
  store.save();
  res.json({ decree: store.data.decree });
});

api.post('/citizens/:username/amnesty', requireUser, requireCreator, (req, res) => {
  const u = store.userByName(req.params.username);
  if (!u || u.isCreator) return res.status(404).json({ error: 'No such citizen.' });
  applyDelta(u, R.START_SCORE - u.score, { kind: 'amnesty', actor: req.user.id });
  store.save();
  res.json({ citizen: publicUser(u) });
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large.' });
  res.status(500).json({ error: 'The Bureau encountered an irregularity.' });
});

const server = app.listen(PORT, () => {
  console.log(`Social Credit Bureau open at http://localhost${PORT === 80 ? '' : `:${PORT}`}`);
  if (!fs.existsSync(path.join(ROOT, 'models', 'face_landmarker.task'))) {
    console.log('Face model not found locally; browsers will fetch it from Google. Run `npm run fetch-model` to self-host it.');
  }
});

server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`Port ${PORT} needs elevated privileges on this system. Either:
  sudo npm start
  sudo setcap 'cap_net_bind_service=+ep' "$(command -v node)"   # Linux: let node bind to port 80 without sudo
  PORT=3000 npm start                                             # or use an unprivileged port`);
  } else if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (another web server?). Stop it, or run with PORT=3000 npm start`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
