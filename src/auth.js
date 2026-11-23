import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { q, one, val } from './db.js';
import { fail } from './errors.js';
import { str } from './validate.js';

export const ROLES = ['elev', 'profesor', 'admin'];
const MAX_FAILED_LOGINS = 10; // per IP ...
const FAILED_WINDOW_MIN = 15; // ... in this many minutes
const SESSION_HOURS = 8;      // a session ends after 8 hours without use

/* The public site (/cont) and the admin panel (/admin) have separate logins. Each login gives
   the browser a random token, which it sends back as "Authorization: Bearer <token>"; the site
   and the panel keep their own token, so signing in on the site never opens the admin panel.
   Only a SHA-256 hash of the token is stored. A header (not a cookie) is used because the
   client and the API can live on different domains (Clever Cloud + Render); it also makes
   cross-site request forgery impossible. */

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const nowSql = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

// hashes made by PHP's password_hash() start with $2y$ (same algorithm as $2b$)
const verify = (pass, hash) => bcrypt.compare(pass, String(hash).replace(/^\$2y\$/, '$2b$'));
export const hashPassword = pass => bcrypt.hash(pass, 11);
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 11);

export function publicUser(u) {
  return {
    id: +u.id, name: u.name, email: u.email, role: u.role,
    class_name: u.class_name, teacher_code: u.teacher_code,
    active: !!u.active, created_at: u.created_at, last_login: u.last_login,
  };
}

function bearer(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(h.trim());
  return m ? m[1] : null;
}

/** The signed-in user of this scope ('site' or 'admin'), or null. */
export async function scopeUser(req, scope) {
  req.users ??= {};
  if (scope in req.users) return req.users[scope];
  const token = bearer(req);
  let u = null;
  if (token) {
    const hash = sha256(token);
    u = await one('SELECT u.*, s.expires_at AS session_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.scope = ? AND s.expires_at > ?', [hash, scope, nowSql()]);
    if (u && (!u.active || (scope === 'admin' && u.role !== 'admin'))) {
      await q('DELETE FROM sessions WHERE token_hash = ?', [hash]);
      u = null;
    }
    // sliding expiry: refreshed at most every 10 minutes
    if (u && new Date(u.session_expires.replace(' ', 'T') + 'Z') - Date.now() < SESSION_HOURS * 3600e3 - 600e3) {
      await q('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [nowSql(SESSION_HOURS * 3600e3), hash]);
    }
  }
  req.users[scope] = u;
  return u;
}

export async function requireAdmin(req) {
  return (await scopeUser(req, 'admin')) || fail(401, 'Trebuie să te autentifici ca administrator.');
}

/** Opens a session for this user and returns its token. */
export async function startSession(userId, scope) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO sessions (token_hash, user_id, scope, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, scope, nowSql(SESSION_HOURS * 3600e3)]);
  return token;
}

export async function login(req, scope) {
  const input = req.body || {};
  const email = str(input, 'email', 190, true, 'Email').toLowerCase();
  const pass = typeof input.password === 'string' ? input.password : '';
  if (pass === '') fail(422, 'Completează parola.');

  const ip = (req.ip || '0.0.0.0').slice(0, 45);
  const failed = +(await val('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND at > ?', [ip, nowSql(-FAILED_WINDOW_MIN * 60e3)]));
  if (failed >= MAX_FAILED_LOGINS) fail(429, `Prea multe încercări greșite. Încearcă din nou peste ${FAILED_WINDOW_MIN} minute.`);

  const u = await one('SELECT * FROM users WHERE email = ?', [email]);
  // verify against a dummy hash when the email is unknown, so both cases take the same time
  const ok = await verify(pass, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) {
    await q('INSERT INTO login_attempts (ip, at) VALUES (?, ?)', [ip, nowSql()]);
    await q('DELETE FROM login_attempts WHERE at < ?', [nowSql(-86400e3)]);
    fail(401, 'Email sau parolă greșită.');
  }
  if (!u.active) fail(403, 'Contul este dezactivat. Contactează administratorul.');
  if (scope === 'admin' && u.role !== 'admin') fail(403, 'Doar administratorii pot intra în panoul de administrare.');

  await q('UPDATE users SET last_login = ? WHERE id = ?', [nowSql(), u.id]);
  await q('DELETE FROM login_attempts WHERE ip = ?', [ip]);
  await q('DELETE FROM sessions WHERE expires_at < ?', [nowSql()]);
  const token = await startSession(u.id, scope);
  return { user: publicUser({ ...u, last_login: nowSql() }), token };
}

export async function logout(req, scope) {
  const token = bearer(req);
  if (token) await q('DELETE FROM sessions WHERE token_hash = ? AND scope = ?', [sha256(token), scope]);
}

/** Signs out every session of a user (after a password change or deactivation). */
export async function endUserSessions(userId, exceptReq = null) {
  const keep = exceptReq && bearer(exceptReq);
  if (keep) await q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [userId, sha256(keep)]);
  else await q('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export function checkPassword(p) {
  if ([...p].length < 8) fail(422, 'Parola trebuie să aibă cel puțin 8 caractere.');
  if (Buffer.byteLength(p) > 72) fail(422, 'Parola este prea lungă (maxim 72 de caractere).');
}
