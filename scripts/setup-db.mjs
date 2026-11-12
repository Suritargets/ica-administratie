// Maakt de tabellen aan, zet de ICA-standaardinstellingen en maakt het eerste admin-account.
// Gebruik:  DATABASE_URL=… ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run db:setup
import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { SCHEMA } from './schema.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL ontbreekt'); process.exit(1); }
const sql = neon(url);

for (const stmt of SCHEMA) await sql.query(stmt);
console.log('Tabellen OK');

const brand = JSON.parse(readFileSync(new URL('../src/brand/brand.json', import.meta.url), 'utf8'));
for (const [k, v] of Object.entries(brand.defaults || {}))
  await sql.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, String(v ?? '')]);
console.log('Standaardinstellingen OK');

const [{ n }] = await sql.query('SELECT COUNT(*)::int AS n FROM users');
if (n === 0) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!email || pw.length < 10) { console.error('Nog geen gebruikers: zet ADMIN_EMAIL en ADMIN_PASSWORD (min. 10 tekens) en draai opnieuw.'); process.exit(1); }
  const salt = randomBytes(16);
  const hash = `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
  await sql.query('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)', [email, process.env.ADMIN_NAME || 'Beheerder', 'admin', hash]);
  console.log(`Admin-account aangemaakt: ${email}`);
} else console.log(`${n} gebruiker(s) bestaan al — geen nieuw admin-account aangemaakt.`);
