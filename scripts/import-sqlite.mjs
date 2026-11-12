// Importeert gegevens uit de lokale desktop-app (SQLite) in Neon.
// Gebruik:  DATABASE_URL=… node scripts/import-sqlite.mjs "pad/naar/hirely.db"        (eerst een proefrun)
//           DATABASE_URL=… node scripts/import-sqlite.mjs "pad/naar/hirely.db" --go   (echt importeren)
// Vereist Node 22.13+ (ingebouwde node:sqlite). Doet niets als de doeltabellen al gegevens bevatten.
import { DatabaseSync } from 'node:sqlite';
import { neon } from '@neondatabase/serverless';

const file = process.argv[2];
const go = process.argv.includes('--go');
if (!file) { console.error('Geef het pad naar hirely.db op.'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL ontbreekt'); process.exit(1); }

const lite = new DatabaseSync(file, { readOnly: true });
const sql = neon(process.env.DATABASE_URL);
const all = (t) => { try { return lite.prepare(`SELECT * FROM ${t}`).all(); } catch { return []; } };

const SKIP = new Set(['install_id', 'license_key', 'license_email', 'license_token', 'license_last_ok', 'license_error', 'telemetry_enabled']);
const data = {
  settings: all('settings').filter(r => !SKIP.has(r.key)),
  clients: all('clients'), catalog: all('catalog'), rates: all('rates'), documents: all('documents'),
};
console.log(Object.entries(data).map(([k, v]) => `${k}: ${v.length}`).join(' · '));
if (!go) { console.log('\nProefrun — er is niets geschreven. Voeg --go toe om te importeren.'); process.exit(0); }

for (const t of ['clients', 'documents', 'catalog', 'rates']) {
  const [{ n }] = await sql.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
  if (n > 0) { console.error(`Tabel ${t} bevat al ${n} rijen — import afgebroken om niets te overschrijven.`); process.exit(1); }
}

const ins = async (table, rows, cols) => {
  for (const r of rows) {
    await sql.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map(c => r[c] ?? null));
  }
  if (rows.length) await sql.query(`SELECT setval(pg_get_serial_sequence('${table}','id'), (SELECT MAX(id) FROM ${table}))`);
  console.log(`${table}: ${rows.length} geïmporteerd`);
};

for (const r of data.settings) await sql.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [r.key, r.value]);
console.log(`settings: ${data.settings.length} geïmporteerd`);
await ins('clients', data.clients, ['id', 'name', 'contact', 'address', 'postal_city', 'country', 'vat_number', 'email', 'phone', 'notes', 'lang', 'created_at']);
await ins('catalog', data.catalog, ['id', 'kind', 'name', 'description', 'category', 'unit', 'sku', 'price', 'active', 'used', 'currency', 'created_at', 'updated_at']);
await ins('rates', data.rates, ['id', 'date', 'currency', 'base', 'rate', 'created_at']);
await ins('documents', data.documents, ['id', 'type', 'number', 'date', 'due_date', 'client_id', 'client_json', 'subject', 'subject_detail', 'reference',
  'items_json', 'vat_rate', 'subtotal', 'vat_amount', 'total', 'discount', 'status', 'paid_on', 'terms', 'notes', 'currency', 'fx_rate', 'fx_base', 'lang', 'created_at', 'updated_at']);
console.log('Klaar.');
