import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [algo, saltB64, keyB64] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.data.sessions[token] = { userId, expires: Date.now() + SESSION_DAYS * 864e5 };
  store.save();
  return token;
}

export function sessionUser(store, req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const s = store.data.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete store.data.sessions[token];
    store.save();
    return null;
  }
  return store.userById(s.userId);
}

export function destroySession(store, req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (token && store.data.sessions[token]) {
    delete store.data.sessions[token];
    store.save();
  }
}

export function sessionCookie(token, req) {
  const secure = req.secure ? '; Secure' : '';
  const maxAge = token ? SESSION_DAYS * 86400 : 0;
  return `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Small fixed-window limiter for login/register.
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const k = req.ip;
    const h = hits.get(k);
    if (!h || now - h.start > windowMs) {
      hits.set(k, { start: now, n: 1 });
      return next();
    }
    h.n += 1;
    if (h.n > max) return res.status(429).json({ error: 'Too many attempts. The Bureau suggests a short walk.' });
    next();
  };
}
