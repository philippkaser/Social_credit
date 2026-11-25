// Social Credit: Bun-native server. Bun.serve handles routing, Bun.file serves
// static assets, Bun.password hashes passwords. No web framework required.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './lib/store.js';
import {
  hashPassword, verifyPassword, createSession, sessionUser, destroySession, sessionCookie, rateLimiter,
} from './lib/auth.js';
import * as R from './lib/rules.js';

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT || 80);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const CREATOR_USERNAME = (process.env.CREATOR_USERNAME || '').toLowerCase() || null;
const TRUST_PROXY = !!process.env.TRUST_PROXY;
const MAX_BODY = 2 * 1024 * 1024;
const HOUR = 36e5;
const DAY = 24 * HOUR;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const store = new Store(DATA_DIR);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });

// ---------------------------------------------------------------- http plumbing
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, error) => Response.json({ error }, { status });

function clientIp(req, server) {
  if (TRUST_PROXY) {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
  }
  return server.requestIP(req)?.address || 'unknown';
}

function isSecure(req) {
  if (TRUST_PROXY && req.headers.get('x-forwarded-proto') === 'https') return true;
  return new URL(req.url).protocol === 'https:';
}

async function readJson(req) {
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) throw new HttpError(413, 'Payload too large.');
  const text = await req.text();
  if (!text) return {};
  if (text.length > MAX_BODY) throw new HttpError(413, 'Payload too large.');
  if (!(req.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Expected JSON.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Malformed JSON.'); }
}

// Wraps a route: same-origin check, rate limit, body parsing, session lookup, auth.
function handle(fn, { auth = false, creator = false, limit = null } = {}) {
  return async (req, server) => {
    try {
      const ctx = { req, params: req.params || {}, secure: isSecure(req), body: {} };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.get('origin');
        if (origin) {
          let same = false;
          try { same = new URL(origin).host === req.headers.get('host'); } catch { /* bad origin */ }
          if (!same) return fail(403, 'Cross-origin request refused.');
        }
        if (limit && !limit(clientIp(req, server))) return fail(429, 'Too many attempts. The Bureau suggests a short walk.');
        ctx.body = await readJson(req);
      }
      ctx.user = sessionUser(store, req);
      if ((auth || creator) && !ctx.user) return fail(401, 'Please identify yourself to the Bureau.');
      if (creator && !ctx.user.isCreator) return fail(403, 'Only The Creator may do that.');
      return await fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(e);
      return fail(500, 'The Bureau encountered an irregularity.');
    }
  };
}

// ---------------------------------------------------------------- static files
const STATIC = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/build'), 'public, max-age=604800'],
  ['/vendor/mediapipe/', path.join(ROOT, 'node_modules/@mediapipe/tasks-vision'), 'public, max-age=604800'],
  ['/models/', path.join(ROOT, 'models'), 'public, max-age=604800'],
  ['/uploads/', UPLOAD_DIR, 'public, max-age=2592000, immutable'],
  ['/', path.join(ROOT, 'public'), 'no-cache'],
];

async function serveStatic(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response('Bad request', { status: 400 }); }
  for (const [prefix, dir, cache] of STATIC) {
    if (!pathname.startsWith(prefix)) continue;
    let rel = pathname.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) break; // path traversal
    const f = Bun.file(file);
    if (await f.exists()) {
      return new Response(f, { headers: { 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (prefix !== '/') break; // a miss under /vendor etc. must not fall through to public/
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------- domain helpers
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
  if (!u.photo) return null;
  return u.hasAvatar ? `/uploads/${u.photo}.avatar.jpg` : `/uploads/${u.photo}.jpg`;
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
    portrait: u.photo ? `/uploads/${u.photo}.jpg` : null,
    mesh: u.photo && u.hasMesh ? `/uploads/${u.photo}.json` : null,
    mask: u.photo && u.hasMask ? `/uploads/${u.photo}.mask.png` : null,
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

function withSession(data, token, secure) {
  return Response.json(data, { headers: { 'Set-Cookie': sessionCookie(token, secure) } });
}

// ---------------------------------------------------------------- public reads
function getRules() {
  return Response.json({
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
}

function getState({ user }) {
  return Response.json({
    me: meView(user),
    decree: store.data.decree,
    hasCreator: store.users.some((u) => u.isCreator),
    creatorReserved: !!CREATOR_USERNAME,
  });
}

function listCitizens() {
  const ctx = { deltas: delta24hMap(), ranks: rankMap() };
  const list = store.users.map((u) => publicUser(u, ctx));
  list.sort((a, b) => (b.isCreator - a.isCreator) || (b.score - a.score) || (a.joinedAt - b.joinedAt));
  return Response.json({ citizens: list });
}

function getCitizen({ params, user }) {
  const u = store.userByName(params.username);
  if (!u) return fail(404, 'No such citizen. Perhaps they were never here.');
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
  if (user && user.id !== u.id && !user.isCreator) {
    const last = lastVoteOn(user, u);
    if (last) cooldownUntil = last.at + R.SAME_TARGET_COOLDOWN_MIN * 60e3;
  }
  return Response.json({
    citizen: publicUser(u),
    record: mine.slice(-60).reverse().map(renderEntry),
    history: [[u.joinedAt, u.isCreator ? null : R.START_SCORE], ...history].slice(-200),
    stats: { merits, infractions, given },
    cooldownUntil,
  });
}

function getFeed() {
  return Response.json({ feed: store.ledger.slice(-40).reverse().map(renderEntry) });
}

function getStats() {
  const citizens = store.users.filter((u) => !u.isCreator);
  const since = Date.now() - DAY;
  let today = 0;
  for (let i = store.ledger.length - 1; i >= 0 && store.ledger[i].at >= since; i--) if (store.ledger[i].vote) today++;
  const avg = citizens.length ? Math.round(citizens.reduce((s, u) => s + u.score, 0) / citizens.length) : null;
  const tiers = Object.fromEntries(R.TIERS.map((t) => [t.id, 0]));
  for (const u of citizens) tiers[R.tierFor(u).id]++;
  return Response.json({ citizens: store.users.length, ratingsToday: today, average: avg, tiers });
}

// ---------------------------------------------------------------- accounts
const authLimit = rateLimiter({ windowMs: 10 * 60e3, max: 30 });
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

async function register({ body, secure }) {
  const username = String(body.username || '').toLowerCase().trim();
  const name = cleanName(body.name) || username;
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) return fail(400, 'Usernames are 3–20 lowercase letters, digits or underscores.');
  if (password.length < 6) return fail(400, 'Passwords need at least 6 characters. The Bureau has standards.');
  if (store.userByName(username)) return fail(409, 'That citizen already exists.');

  const pass = await hashPassword(password);
  if (store.userByName(username)) return fail(409, 'That citizen already exists.'); // raced while hashing
  const isCreator = CREATOR_USERNAME
    ? username === CREATOR_USERNAME
    : !store.users.some((u) => u.isCreator);
  const user = {
    id: store.nextId(),
    username,
    name,
    pass,
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
  return withSession({ me: meView(user) }, token, secure);
}

async function login({ body, secure }) {
  const user = store.userByName(body.username);
  const ok = user && (await verifyPassword(String(body.password || ''), user.pass));
  if (!ok) return fail(401, 'The Bureau does not recognise those credentials.');
  const token = createSession(store, user.id);
  return withSession({ me: meView(user) }, token, secure);
}

function logout({ req, secure }) {
  destroySession(store, req);
  return withSession({ ok: true }, null, secure);
}

function decodeDataUrl(value, kind, maxBytes) {
  const mime = kind === 'png' ? 'image\\/png' : 'image\\/jpeg';
  const m = new RegExp(`^data:${mime};base64,([A-Za-z0-9+/=]+)$`).exec(String(value || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > maxBytes) throw new HttpError(413, 'Image too large.');
  const magic = kind === 'png' ? [0x89, 0x50, 0x4e, 0x47] : [0xff, 0xd8, 0xff];
  if (!magic.every((b, i) => buf[i] === b)) throw new HttpError(400, `That is not a ${kind.toUpperCase()}.`);
  return buf;
}

// Portrait enrollment: a client-side-cropped head-and-shoulders JPEG, plus
// optionally the 478 MediaPipe landmarks (normalised to that crop), a person
// segmentation mask (PNG) and a tight avatar thumbnail (JPEG).
async function uploadFace({ body, user: u }) {
  const { image, landmarks } = body;
  const buf = decodeDataUrl(image, 'jpeg', 1.5e6);
  if (!buf) return fail(400, 'Expected a JPEG image.');
  const avatarBuf = body.avatar ? decodeDataUrl(body.avatar, 'jpeg', 4e5) : null;
  const maskBuf = body.mask ? decodeDataUrl(body.mask, 'png', 6e5) : null;

  let mesh = null;
  if (landmarks != null) {
    const ok = Array.isArray(landmarks)
      && (landmarks.length === 478 * 3 || landmarks.length === 468 * 3)
      && landmarks.every((v, i) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < (i % 3 === 2 ? 2 : 3));
    if (!ok) return fail(400, 'Malformed biometric data.');
    mesh = landmarks.map((v) => Math.round(v * 1e4) / 1e4);
  }

  const old = u.photo;
  const name = `${u.id}-${crypto.randomBytes(8).toString('hex')}`;
  await Bun.write(path.join(UPLOAD_DIR, `${name}.jpg`), buf);
  if (mesh) await Bun.write(path.join(UPLOAD_DIR, `${name}.json`), JSON.stringify({ v: 1, n: mesh.length / 3, landmarks: mesh }));
  if (avatarBuf) await Bun.write(path.join(UPLOAD_DIR, `${name}.avatar.jpg`), avatarBuf);
  if (maskBuf) await Bun.write(path.join(UPLOAD_DIR, `${name}.mask.png`), maskBuf);
  u.photo = name;
  u.hasMesh = !!mesh;
  u.hasAvatar = !!avatarBuf;
  u.hasMask = !!maskBuf;
  if (old) {
    for (const ext of ['jpg', 'json', 'avatar.jpg', 'mask.png']) fs.rm(path.join(UPLOAD_DIR, `${old}.${ext}`), { force: true }, () => {});
  }
  store.addEntry({ kind: 'scanned', userId: u.id, delta: 0, scoreAfter: u.isCreator ? null : u.score, note: mesh ? 'mesh' : 'flat' });
  store.save();
  return Response.json({ me: meView(u) });
}

function refuseBiometrics({ user: u }) {
  if (u.photo || u.biometricsRefused) return Response.json({ me: meView(u) });
  u.biometricsRefused = true;
  applyDelta(u, R.NO_BIOMETRICS_PENALTY, { kind: 'refused', note: 'biometrics' });
  store.save();
  return Response.json({ me: meView(u) });
}

// ---------------------------------------------------------------- rating
function rate({ params, body, user: voter }) {
  const target = store.userByName(params.username);
  const reason = R.reasonById[body.reasonId];
  if (!target) return fail(404, 'No such citizen.');
  if (!reason) return fail(400, 'Unknown merit or infraction.');
  if (target.id === voter.id) return fail(400, 'Self-assessment is the Bureau’s job, not yours.');

  const tier = R.tierFor(voter);
  const criticism = reason.delta < 0;
  if (criticism && !tier.canCriticise) {
    return fail(403, 'Personae non gratae may only praise. Consider re-education.');
  }
  if (!voter.isCreator) {
    if (votesUsed(voter) >= tier.dailyVotes) {
      return fail(429, `Daily allowance of ${tier.dailyVotes} ratings exhausted. Improve your standing for a larger allowance.`);
    }
    const last = lastVoteOn(voter, target);
    if (last) {
      const mins = Math.ceil((last.at + R.SAME_TARGET_COOLDOWN_MIN * 60e3 - Date.now()) / 60e3);
      return fail(429, `You rated ${target.name} recently. Let the Bureau digest it for ${mins} more minute${mins === 1 ? '' : 's'}.`);
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
  return Response.json({ outcome, message, entries: entries.map(renderEntry), target: publicUser(target), me: meView(voter) });
}

// ---------------------------------------------------------------- re-education
function getQuiz({ user: u }) {
  if (u.isCreator) return Response.json({ eligible: false, reason: 'The Creator has nothing left to learn.' });
  if (u.score >= R.START_SCORE) return Response.json({ eligible: false, reason: 'Your standing is satisfactory. Re-education is reserved for citizens below 1000.' });
  const nextAt = reeducationNextAt(u);
  if (Date.now() < nextAt) return Response.json({ eligible: false, nextAt, reason: 'You have been re-educated recently. Let it sink in.' });
  const qs = [...R.QUIZ].sort(() => Math.random() - 0.5).slice(0, 3);
  u.quiz = { ids: qs.map((q) => q.id), issuedAt: Date.now() };
  store.save();
  return Response.json({ eligible: true, reward: R.REEDUCATION_REWARD, questions: qs.map(({ id, q, options }) => ({ id, q, options })) });
}

function submitQuiz({ body, user: u }) {
  if (!u.quiz || Date.now() - u.quiz.issuedAt > HOUR) return fail(400, 'No active re-education session.');
  if (Date.now() < reeducationNextAt(u)) return fail(429, 'Too soon.');
  const answers = body.answers || {};
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
  return Response.json({ passed, results, me: meView(u) });
}

// ---------------------------------------------------------------- the Creator
function decree({ body, user }) {
  const text = String(body.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
  store.data.decree = text ? { text, at: Date.now() } : null;
  if (text) store.addEntry({ kind: 'decree', userId: user.id, delta: 0, note: text });
  store.save();
  return Response.json({ decree: store.data.decree });
}

function amnesty({ params, user }) {
  const u = store.userByName(params.username);
  if (!u || u.isCreator) return fail(404, 'No such citizen.');
  applyDelta(u, R.START_SCORE - u.score, { kind: 'amnesty', actor: user.id });
  store.save();
  return Response.json({ citizen: publicUser(u) });
}

// ---------------------------------------------------------------- server
const routes = {
  '/api/rules': { GET: handle(getRules) },
  '/api/state': { GET: handle(getState) },
  '/api/citizens': { GET: handle(listCitizens) },
  '/api/citizens/:username': { GET: handle(getCitizen) },
  '/api/citizens/:username/rate': { POST: handle(rate, { auth: true }) },
  '/api/citizens/:username/amnesty': { POST: handle(amnesty, { creator: true }) },
  '/api/feed': { GET: handle(getFeed) },
  '/api/stats': { GET: handle(getStats) },
  '/api/register': { POST: handle(register, { limit: authLimit }) },
  '/api/login': { POST: handle(login, { limit: authLimit }) },
  '/api/logout': { POST: handle(logout) },
  '/api/me/face': { POST: handle(uploadFace, { auth: true }) },
  '/api/me/refuse-biometrics': { POST: handle(refuseBiometrics, { auth: true }) },
  '/api/reeducation': { GET: handle(getQuiz, { auth: true }), POST: handle(submitQuiz, { auth: true }) },
  '/api/decree': { POST: handle(decree, { creator: true }) },
  '/api/*': () => fail(404, 'Not found.'),
};

let server;
try {
  server = Bun.serve({
    port: PORT,
    routes,
    fetch: serveStatic,
    maxRequestBodySize: MAX_BODY * 2,
    error(err) {
      console.error(err);
      return fail(500, 'The Bureau encountered an irregularity.');
    },
  });
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use (another web server?). Stop it, or run with PORT=3000 bun start`);
  } else if (err.code === 'EACCES' || /permission|access/i.test(err.message)) {
    console.error(`Port ${PORT} needs elevated privileges on this system. Either:
  sudo bun start
  sudo setcap 'cap_net_bind_service=+ep' "$(command -v bun)"   # Linux: let bun bind to port 80 without sudo
  PORT=3000 bun start                                             # or use an unprivileged port`);
  } else {
    console.error(err);
  }
  process.exit(1);
}

console.log(`Social Credit Bureau open at http://localhost${server.port === 80 ? '' : `:${server.port}`}`);
if (!fs.existsSync(path.join(ROOT, 'models', 'face_landmarker.task'))) {
  console.log('Face model not found locally; browsers will fetch it from Google. Run `bun run fetch-model` to self-host it.');
}
