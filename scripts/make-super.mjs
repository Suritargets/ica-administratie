// Maakt een account de (onzichtbare, onverwijderbare) superadmin. Bestaat het account nog niet, dan wordt het aangemaakt.
// Gebruik: node --env-file=.env.local scripts/make-super.mjs <email> [--off]
// Nieuw account: zet SUPER_PASSWORD (min. 10 tekens, letters + cijfers) en optioneel SUPER_NAME in de omgeving.
import { neon } from '@neondatabase/serverless';
import { randomBytes, scryptSync } from 'node:crypto';

const email = (process.argv[2] || '').trim().toLowerCase();
const off = process.argv.includes('--off');
if (!email || !process.env.DATABASE_URL) { console.error('Gebruik: node --env-file=.env.local scripts/make-super.mjs <email> [--off]'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);

const existing = await sql.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
if (!existing.length) {
  const pw = process.env.SUPER_PASSWORD || '';
  if (off || pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { console.error('Account bestaat niet. Zet SUPER_PASSWORD (min. 10 tekens, letters én cijfers) om het aan te maken.'); process.exit(1); }
  const salt = randomBytes(16);
  // zelfde formaat en parameters als src/lib/auth.ts (scrypt$salt$hash)
  const hash = `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
  await sql.query('INSERT INTO users (email, name, role, password_hash, is_super) VALUES ($1, $2, $3, $4, TRUE)', [email, process.env.SUPER_NAME || 'Superadmin', 'admin', hash]);
  console.log(`${email}: aangemaakt als superadmin`);
} else {
  await sql.query('UPDATE users SET is_super = $1, role = CASE WHEN $1 THEN \'admin\' ELSE role END, active = CASE WHEN $1 THEN TRUE ELSE active END WHERE lower(email) = $2', [!off, email]);
  console.log(`${email}: superadmin ${off ? 'uit' : 'aan'}`);
}
