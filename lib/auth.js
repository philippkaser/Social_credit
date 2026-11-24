import crypto from 'node:crypto';

const SESSION_DAYS = 30;

// Bun.password uses argon2id by default.
export function hashPassword(password) {
  return Bun.password.hash(password);
}

export async function verifyPassword(password, stored) {
  stored = String(stored || '');
  if (stored.startsWith('scrypt$')) return verifyLegacyScrypt(password, stored);
  try { return await Bun.password.verify(password, stored); } catch { return false; }
}

// Accounts created by the earlier Node version stored scrypt hashes.
function verifyLegacyScrypt(password, stored) {
  const [, saltB64, keyB64] = stored.split('$');
  const expected = Buffer.from(keyB64 || '', 'base64');
  if (!expected.length) return false;
  const key = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

const tokenFrom = (req) => parseCookies(req.headers.get('cookie')).sid;

export function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.data.sessions[token] = { userId, expires: Date.now() + SESSION_DAYS * 864e5 };
  store.save();
  return token;
}

export function sessionUser(store, req) {
  const token = tokenFrom(req);
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
  const token = tokenFrom(req);
  if (token && store.data.sessions[token]) {
    delete store.data.sessions[token];
    store.save();
  }
}

export function sessionCookie(token, secure) {
  const maxAge = token ? SESSION_DAYS * 86400 : 0;
  return `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Small fixed-window limiter for login/register. Returns (ip) => allowed?
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    if (hits.size > 10000) {
      for (const [k, h] of hits) if (now - h.start > windowMs) hits.delete(k);
    }
    const h = hits.get(ip);
    if (!h || now - h.start > windowMs) {
      hits.set(ip, { start: now, n: 1 });
      return true;
    }
    h.n += 1;
    return h.n <= max;
  };
}
