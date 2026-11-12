import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { q1 } from './db';
import { can, type Perm } from './perms';

export const COOKIE = 'ica_session';
const MAX_AGE = 60 * 60 * 12; // 12 uur

export type User = { id: number; email: string; name: string; role: string };

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET ontbreekt of is korter dan 32 tekens');
  return s;
}

// ---- wachtwoorden (scrypt, geen extra pakketten) ----
const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = Buffer.from(keyHex, 'hex');
  const test = scryptSync(pw, Buffer.from(saltHex, 'hex'), key.length, SCRYPT);
  return test.length === key.length && timingSafeEqual(test, key);
}
export function passwordProblem(pw: unknown): string | null {
  const p = String(pw ?? '');
  if (p.length < 10) return 'Het wachtwoord moet minimaal 10 tekens zijn.';
  if (p.length > 200) return 'Het wachtwoord is te lang.';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Gebruik letters én cijfers in het wachtwoord.';
  return null;
}

// ---- sessie: ondertekende cookie met user-id, sessieversie en verloopdatum ----
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function makeSession(userId: number, sessionVersion: number) {
  const payload = b64(JSON.stringify({ u: userId, v: sessionVersion, e: Math.floor(Date.now() / 1000) + MAX_AGE }));
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readSession(token: string | undefined): { u: number; v: number } | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const good = createHmac('sha256', secret()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.e > Date.now() / 1000 ? { u: d.u, v: d.v } : null;
  } catch { return null; }
}
export const sessionCookie = (value: string, maxAge = MAX_AGE) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

function cookieOf(req: Request, name: string) {
  const h = req.headers.get('cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// Huidige gebruiker: controleert elke keer of het account nog actief is en de sessie niet is ingetrokken
export async function currentUser(req: Request): Promise<User | null> {
  const s = readSession(cookieOf(req, COOKIE));
  if (!s) return null;
  const u = await q1<User & { active: boolean; session_version: number }>(
    'SELECT id, email, name, role, active, session_version FROM users WHERE id = $1', [s.u]);
  if (!u || !u.active || u.session_version !== s.v) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export const allowed = (u: User | null, perm: Perm) => !!u && can(u.role, perm);

// CSRF: schrijvende verzoeken moeten van dezelfde site komen
export function sameOrigin(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.get('origin');
  if (origin) { try { return new URL(origin).host === req.headers.get('host'); } catch { return false; } }
  return req.headers.get('sec-fetch-site') !== 'cross-site';
}
