// Maakt een bestaand account de (onzichtbare, onverwijderbare) superadmin.
// Gebruik: node --env-file=.env.local scripts/make-super.mjs <email> [--off]
import { neon } from '@neondatabase/serverless';

const email = (process.argv[2] || '').trim().toLowerCase();
const off = process.argv.includes('--off');
if (!email || !process.env.DATABASE_URL) { console.error('Gebruik: node --env-file=.env.local scripts/make-super.mjs <email> [--off]'); process.exit(1); }
const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query('UPDATE users SET is_super = $1, role = CASE WHEN $1 THEN \'admin\' ELSE role END, active = CASE WHEN $1 THEN TRUE ELSE active END WHERE lower(email) = $2 RETURNING id', [!off, email]);
console.log(rows.length ? `${email}: superadmin ${off ? 'uit' : 'aan'}` : 'Account niet gevonden');
