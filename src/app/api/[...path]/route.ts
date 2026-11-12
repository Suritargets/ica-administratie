import { q, q1 } from '@/lib/db';
import { allowed, currentUser, hashPassword, makeSession, passwordProblem, sameOrigin, sessionCookie, verifyPassword, type User } from '@/lib/auth';
import { isRole, permsOf, type Perm } from '@/lib/perms';
import { layout, mailAppointmentStatus, sendMail, smtpConfigured } from '@/lib/mail';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const fail = (status: number, error: string) => json(status, { error });
const FORBIDDEN = () => fail(403, 'Je hebt geen rechten voor deze actie.');

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

// ---------- helpers (overgenomen uit de desktop-app) ----------
const round2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
function calc(items: any[], vatRate: unknown, discount: unknown = 0) {
  const subtotal = round2((items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0));
  const disc = round2(Math.min(Math.max(Number(discount) || 0, 0), subtotal));
  const vat_amount = round2((subtotal - disc) * (Number(vatRate) || 0) / 100);
  return { subtotal, discount: disc, vat_amount, total: round2(subtotal - disc + vat_amount) };
}
async function getSettings(): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
async function nextNumber(type: 'offerte' | 'factuur') {
  const s = await getSettings();
  const prefix = String((type === 'offerte' ? s.quote_prefix : s.invoice_prefix) || (type === 'offerte' ? 'Q' : 'INV')).trim().replace(/[^A-Za-z0-9-]/g, '') || 'DOC';
  const year = new Date().getFullYear();
  const rows = await q<{ number: string }>('SELECT number FROM documents WHERE number LIKE $1', [`${prefix}-${year}-%`]);
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.number.split('-').pop() || '0', 10) || 0), 0);
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}
const cleanCur = async (c: unknown) => {
  const v = String(c || '').toUpperCase().trim();
  return /^[A-Z]{3}$/.test(v) ? v : ((await getSettings()).currency || 'EUR');
};
const baseCur = async () => cleanCur((await getSettings()).base_currency || (await getSettings()).currency);
async function rateFor(cur: string, date: string | null, base: string): Promise<number | null> {
  if (!cur || cur === base) return 1;
  const r = await q1<{ rate: number }>('SELECT rate FROM rates WHERE currency = $1 AND base = $2 AND date <= $3 ORDER BY date DESC LIMIT 1', [cur, base, date || '9999'])
    || await q1<{ rate: number }>('SELECT rate FROM rates WHERE currency = $1 AND base = $2 ORDER BY date ASC LIMIT 1', [cur, base]);
  return r ? r.rate : null;
}
function rowToDoc(r: any) {
  if (!r) return null;
  const { client_json, items_json, ...rest } = r;
  return { ...rest, client: JSON.parse(client_json || '{}'), items: JSON.parse(items_json || '[]') };
}
const audit = (u: User | null, action: string, detail = '') =>
  q('INSERT INTO audit_log (user_id, user_name, action, detail) VALUES ($1, $2, $3, $4)', [u?.id ?? null, u?.name ?? null, action, detail]).catch(() => {});
const isUnique = (e: any) => e?.code === '23505';

const CLIENT_FIELDS = ['name', 'contact', 'address', 'postal_city', 'country', 'vat_number', 'email', 'phone', 'notes', 'lang'];
const CATALOG_FIELDS = ['kind', 'name', 'description', 'category', 'unit', 'sku', 'price', 'active', 'currency'];
const PROTECTED_SETTINGS = new Set(['install_id', 'license_key']);

// ---------- inloggen ----------
async function login(req: Request) {
  const b = await body(req);
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const generic = () => fail(401, 'E-mailadres of wachtwoord klopt niet.');
  if (!email || !password) return generic();
  const u = await q1<any>('SELECT * FROM users WHERE lower(email) = $1', [email]);
  if (!u) { verifyPassword(password, 'scrypt$00$00'); return generic(); }
  if (u.locked_until && new Date(u.locked_until) > new Date()) return fail(429, 'Te veel mislukte pogingen. Probeer het over een kwartier opnieuw.');
  if (!u.active || !verifyPassword(password, u.password_hash)) {
    const n = u.failed_attempts + 1;
    await q('UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3', [n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null, u.id]);
    await audit({ id: u.id, name: u.name, email: u.email, role: u.role }, 'login_failed');
    return generic();
  }
  await q('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login = now() WHERE id = $1', [u.id]);
  await audit({ id: u.id, name: u.name, email: u.email, role: u.role }, 'login');
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(makeSession(u.id, u.session_version)) });
}

// ---------- gebruikersbeheer (alleen admin) ----------
async function users(req: Request, me: User, id?: string) {
  const m = req.method;
  if (m === 'GET') {
    return json(200, await q('SELECT id, email, name, role, active, last_login, created_at FROM users ORDER BY lower(name)'));
  }
  if (m === 'POST') {
    const b = await body(req);
    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    if (!name) return fail(400, 'Naam is verplicht');
    if (!isRole(b.role)) return fail(400, 'Ongeldige rol');
    if (b.id) { // bijwerken
      const target = await q1<any>('SELECT * FROM users WHERE id = $1', [Number(b.id)]);
      if (!target) return fail(404, 'Gebruiker niet gevonden');
      const active = b.active === false || b.active === 0 ? false : true;
      if (target.id === me.id && (!active || b.role !== 'admin')) return fail(400, 'Je kunt je eigen admin-rechten of toegang niet intrekken.');
      if (target.role === 'admin' && target.active && (!active || b.role !== 'admin')) {
        const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND active AND id <> $2', ['admin', target.id]);
        if (n === 0) return fail(400, 'Er moet minimaal één actieve admin overblijven.');
      }
      if (email && email !== target.email && await q1('SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, target.id])) return fail(400, 'Dit e-mailadres is al in gebruik.');
      const bump = (!active && target.active) || b.role !== target.role || (b.password ? 1 : 0);
      let hash = target.password_hash;
      if (b.password) { const p = passwordProblem(b.password); if (p) return fail(400, p); hash = hashPassword(b.password); }
      await q('UPDATE users SET name=$1, email=$2, role=$3, active=$4, password_hash=$5, session_version = session_version + $6, failed_attempts = 0, locked_until = NULL WHERE id=$7',
        [name, email || target.email, b.role, active, hash, bump ? 1 : 0, target.id]);
      await audit(me, 'user_updated', `${target.email} → ${b.role}${active ? '' : ' (uitgeschakeld)'}${b.password ? ' + wachtwoord' : ''}`);
      return json(200, await q1('SELECT id, email, name, role, active, last_login, created_at FROM users WHERE id = $1', [target.id]));
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, 'Vul een geldig e-mailadres in');
    const p = passwordProblem(b.password); if (p) return fail(400, p);
    if (await q1('SELECT 1 FROM users WHERE lower(email) = $1', [email])) return fail(400, 'Dit e-mailadres is al in gebruik.');
    const row = await q1('INSERT INTO users (email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, active, last_login, created_at',
      [email, name, b.role, hashPassword(b.password)]);
    await audit(me, 'user_created', `${email} (${b.role})`);
    return json(200, row);
  }
  if (m === 'DELETE' && id) {
    const target = await q1<any>('SELECT * FROM users WHERE id = $1', [Number(id)]);
    if (!target) return fail(404, 'Gebruiker niet gevonden');
    if (target.id === me.id) return fail(400, 'Je kunt jezelf niet verwijderen.');
    if (target.role === 'admin' && target.active) {
      const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND active AND id <> $2', ['admin', target.id]);
      if (n === 0) return fail(400, 'Er moet minimaal één actieve admin overblijven.');
    }
    await q('DELETE FROM users WHERE id = $1', [target.id]);
    await audit(me, 'user_deleted', target.email);
    return json(200, { ok: true });
  }
  return fail(405, 'Niet toegestaan');
}

// ---------- hoofd-router ----------
async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (!sameOrigin(req)) return fail(403, 'Geweigerd (origin)');
  const { path } = await ctx.params;
  const [resource, id, sub] = path;
  const m = req.method;
  const url = new URL(req.url);

  try {
    if (resource === 'login' && m === 'POST') return await login(req);
    if (resource === 'logout' && m === 'POST') return json(200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });

    const me = await currentUser(req);
    if (!me) return fail(401, 'Niet ingelogd');
    const need = (p: Perm) => allowed(me, p);

    if (resource === 'ping') return json(200, { ok: true });
    if (resource === 'me') {
      if (m === 'GET') return json(200, { ...me, perms: permsOf(me.role) });
      if (m === 'POST' && id === 'password') {
        const b = await body(req);
        const row = await q1<any>('SELECT password_hash, session_version FROM users WHERE id = $1', [me.id]);
        if (!row || !verifyPassword(String(b.current || ''), row.password_hash)) return fail(400, 'Je huidige wachtwoord klopt niet.');
        const p = passwordProblem(b.next); if (p) return fail(400, p);
        const upd = await q1<any>('UPDATE users SET password_hash = $1, session_version = session_version + 1 WHERE id = $2 RETURNING session_version', [hashPassword(b.next), me.id]);
        await audit(me, 'password_changed');
        return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(makeSession(me.id, upd.session_version)) });
      }
    }

    if (resource === 'users') {
      if (!need('users.manage')) return FORBIDDEN();
      return await users(req, me, id);
    }
    if (resource === 'audit' && m === 'GET') {
      if (!need('users.manage')) return FORBIDDEN();
      return json(200, await q('SELECT at, user_name, action, detail FROM audit_log ORDER BY id DESC LIMIT 100'));
    }

    if (resource === 'settings') {
      if (m === 'GET') return json(200, await getSettings());
      if (m === 'POST') {
        if (!need('settings.write')) return FORBIDDEN();
        const b = await body(req);
        for (const [k, v] of Object.entries(b))
          if (!PROTECTED_SETTINGS.has(k)) await q('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, String(v ?? '')]);
        await audit(me, 'settings_saved', Object.keys(b).join(', ').slice(0, 200));
        return json(200, await getSettings());
      }
    }

    if (resource === 'clients') {
      if (m === 'GET') return json(200, await q('SELECT * FROM clients ORDER BY lower(name)'));
      if (m === 'POST') {
        if (!need('clients.write')) return FORBIDDEN();
        const c = await body(req);
        if (!String(c.name || '').trim()) return fail(400, 'Bedrijfsnaam is verplicht');
        const vals = CLIENT_FIELDS.map(k => k === 'lang' ? (['nl', 'en'].includes(c.lang) ? c.lang : null) : (c[k] ?? ''));
        if (c.id) {
          const row = await q1(`UPDATE clients SET ${CLIENT_FIELDS.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${CLIENT_FIELDS.length + 1} RETURNING *`, [...vals, Number(c.id)]);
          return json(200, row);
        }
        const row = await q1(`INSERT INTO clients (${CLIENT_FIELDS.join(', ')}) VALUES (${CLIENT_FIELDS.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, vals);
        await audit(me, 'client_created', String(c.name));
        return json(200, row);
      }
      if (m === 'DELETE' && id) {
        if (!need('clients.delete')) return FORBIDDEN();
        await q('DELETE FROM clients WHERE id = $1', [Number(id)]);
        await audit(me, 'client_deleted', `#${id}`);
        return json(200, { ok: true });
      }
    }

    if (resource === 'catalog') {
      if (m === 'GET') return json(200, await q('SELECT * FROM catalog ORDER BY active DESC, used DESC, lower(name)'));
      if (m === 'POST' && id === 'used') {
        if (!need('docs.write')) return FORBIDDEN();
        const b = await body(req);
        const ids = (b.ids || []).slice(0, 100).map(Number).filter(Number.isFinite);
        if (ids.length) await q('UPDATE catalog SET used = used + 1 WHERE id = ANY($1::int[])', [ids]);
        return json(200, { ok: true });
      }
      if (m === 'POST') {
        if (!need('catalog.write')) return FORBIDDEN();
        const c = await body(req);
        if (!String(c.name || '').trim()) return fail(400, 'Naam is verplicht');
        const vals = [c.kind === 'product' ? 'product' : 'dienst', String(c.name).trim(), c.description || '', c.category || '', c.unit || '', c.sku || '',
          round2(c.price), c.active === false || c.active === 0 || c.active === '0' ? 0 : 1, await cleanCur(c.currency)];
        if (c.id) {
          const row = await q1(`UPDATE catalog SET ${CATALOG_FIELDS.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${CATALOG_FIELDS.length + 1} RETURNING *`, [...vals, Number(c.id)]);
          return json(200, row);
        }
        return json(200, await q1(`INSERT INTO catalog (${CATALOG_FIELDS.join(', ')}) VALUES (${CATALOG_FIELDS.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, vals));
      }
      if (m === 'DELETE' && id) {
        if (!need('catalog.delete')) return FORBIDDEN();
        await q('DELETE FROM catalog WHERE id = $1', [Number(id)]);
        return json(200, { ok: true });
      }
    }

    if (resource === 'rates') {
      if (m === 'GET') return json(200, { base: await baseCur(), rates: await q('SELECT * FROM rates ORDER BY date DESC, currency') });
      if (m === 'POST') {
        if (!need('rates.write')) return FORBIDDEN();
        const b = await body(req), base = await baseCur(), cur = await cleanCur(b.currency), rate = Number(String(b.rate).replace(',', '.'));
        const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : new Date().toISOString().slice(0, 10);
        if (cur === base) return fail(400, `${cur} is je hoofdvaluta; daar is geen koers voor nodig.`);
        if (!(rate > 0)) return fail(400, 'Vul een geldige koers in');
        await q('INSERT INTO rates (date, currency, base, rate) VALUES ($1,$2,$3,$4) ON CONFLICT (date, currency, base) DO UPDATE SET rate = EXCLUDED.rate', [date, cur, base, rate]);
        if (b.fill !== false) {
          const docs = await q<{ id: number; date: string }>('SELECT id, date FROM documents WHERE currency = $1 AND (fx_rate IS NULL OR fx_base IS NULL OR fx_base <> $2)', [cur, base]);
          for (const doc of docs) await q('UPDATE documents SET fx_rate = $1, fx_base = $2 WHERE id = $3', [await rateFor(cur, doc.date, base), base, doc.id]);
        }
        return json(200, { ok: true });
      }
      if (m === 'DELETE' && id) {
        if (!need('rates.write')) return FORBIDDEN();
        await q('DELETE FROM rates WHERE id = $1', [Number(id)]);
        return json(200, { ok: true });
      }
    }

    if (resource === 'appointments') {
      if (m === 'GET') {
        const from = new Date(Date.now() - 3 * 3600 * 1000 - 14 * 86400000).toISOString().slice(0, 10);
        return json(200, await q('SELECT id, date, time, name, email, phone, subject, message, status, created_at FROM appointments WHERE date >= $1 ORDER BY date, time', [from]));
      }
      if (m === 'POST') {
        if (!need('clients.write')) return FORBIDDEN();
        const b = await body(req);
        if (!['aangevraagd', 'bevestigd', 'geannuleerd'].includes(b.status)) return fail(400, 'Ongeldige status');
        const before = await q1<{ status: string }>('SELECT status FROM appointments WHERE id = $1', [Number(b.id)]);
        const row = await q1<any>('UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, date, time, name, email, phone, status', [b.status, Number(b.id)]);
        if (!row) return fail(404, 'Afspraak niet gevonden');
        await audit(me, 'appointment_' + b.status, `${row.name} ${row.date} ${row.time}`);
        // bezoeker een bericht sturen bij bevestigen of annuleren (alleen bij een echte wijziging, en alleen als de afspraak in de toekomst ligt)
        let mailed: boolean | null = null;
        if (b.status !== 'aangevraagd' && before?.status !== b.status && smtpConfigured()) {
          const office = (await getSettings()).email || process.env.SMTP_USER || '';
          mailed = await mailAppointmentStatus(row, b.status, office);
        }
        return json(200, { id: row.id, date: row.date, time: row.time, name: row.name, status: row.status, mailed });
      }
      if (m === 'DELETE' && id) {
        if (!need('clients.delete')) return FORBIDDEN();
        await q('DELETE FROM appointments WHERE id = $1', [Number(id)]);
        await audit(me, 'appointment_deleted', `#${id}`);
        return json(200, { ok: true });
      }
    }

    if (resource === 'mail' && id === 'test' && m === 'POST') {
      if (!need('settings.write')) return FORBIDDEN();
      if (!smtpConfigured()) return fail(400, 'SMTP is niet ingesteld (SMTP_HOST, SMTP_USER en SMTP_PASSWORD op Vercel).');
      const ok = await sendMail({ to: me.email, subject: 'Test e-mail — ICA Administratie', html: layout('Test geslaagd ✓', '<p>De e-mailkoppeling werkt. Afspraakmeldingen worden vanaf nu verstuurd.</p>'), text: 'Test geslaagd. De e-mailkoppeling werkt.' });
      return ok ? json(200, { ok: true, to: me.email }) : fail(502, 'Versturen mislukt. Controleer de SMTP-gegevens en de serverlogs.');
    }

    if (resource === 'next-number') return json(200, { number: await nextNumber(url.searchParams.get('type') === 'factuur' ? 'factuur' : 'offerte') });

    if (resource === 'docs') {
      if (m === 'GET' && id) return json(200, rowToDoc(await q1('SELECT * FROM documents WHERE id = $1', [Number(id)])));
      if (m === 'GET') {
        const type = url.searchParams.get('type');
        const rows = type
          ? await q('SELECT * FROM documents WHERE type = $1 ORDER BY date DESC, number DESC', [type])
          : await q('SELECT * FROM documents ORDER BY date DESC, number DESC');
        return json(200, rows.map(rowToDoc));
      }
      if (m === 'POST') {
        if (!need('docs.write')) return FORBIDDEN();
        const d = await body(req);
        if (!['offerte', 'factuur'].includes(d.type)) return fail(400, 'Ongeldig type');
        if (!d.number) d.number = await nextNumber(d.type);
        const items = (d.items || []).filter((it: any) => (it.desc || '').trim() || Number(it.rate));
        const t = calc(items, d.vat_rate, d.discount);
        const base = await baseCur(), cur = await cleanCur(d.currency), fx = Number(d.fx_rate);
        const fxRate = cur === base ? 1 : (fx > 0 && (!d.fx_base || d.fx_base === base) ? fx : await rateFor(cur, d.date, base));
        const lang = ['nl', 'en'].includes(d.lang) ? d.lang : null;
        try {
          if (d.id) {
            const row = await q1(`UPDATE documents SET type=$1, number=$2, date=$3, due_date=$4, client_id=$5, client_json=$6, subject=$7, subject_detail=$8,
              reference=$9, items_json=$10, vat_rate=$11, subtotal=$12, vat_amount=$13, total=$14, status=$15, paid_on=$16, terms=$17, notes=$18, discount=$19,
              currency=$20, fx_rate=$21, fx_base=$22, lang=$23, updated_by_name=$24, updated_at=now() WHERE id=$25 RETURNING *`,
              [d.type, d.number, d.date || null, d.due_date || null, d.client_id || null, JSON.stringify(d.client || {}), d.subject || '', d.subject_detail || '', d.reference || '',
                JSON.stringify(items), Number(d.vat_rate) || 0, t.subtotal, t.vat_amount, t.total, d.status || '', d.paid_on || null, d.terms || '', d.notes || '', t.discount,
                cur, fxRate, base, lang, me.name, Number(d.id)]);
            await audit(me, `${d.type}_updated`, d.number);
            return json(200, rowToDoc(row));
          }
          const row = await q1(`INSERT INTO documents (type, number, date, due_date, client_id, client_json, subject, subject_detail, reference, items_json, vat_rate,
            subtotal, vat_amount, total, status, paid_on, terms, notes, discount, currency, fx_rate, fx_base, lang, created_by, created_by_name, updated_by_name)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25) RETURNING *`,
            [d.type, d.number, d.date || null, d.due_date || null, d.client_id || null, JSON.stringify(d.client || {}), d.subject || '', d.subject_detail || '', d.reference || '',
              JSON.stringify(items), Number(d.vat_rate) || 0, t.subtotal, t.vat_amount, t.total, d.status || '', d.paid_on || null, d.terms || '', d.notes || '', t.discount,
              cur, fxRate, base, lang, me.id, me.name]);
          await audit(me, `${d.type}_created`, d.number);
          return json(200, rowToDoc(row));
        } catch (e) {
          if (isUnique(e)) return fail(400, `Nummer ${d.number} bestaat al`);
          throw e;
        }
      }
      if (m === 'DELETE' && id) {
        if (!need('docs.delete')) return FORBIDDEN();
        const row = await q1<{ number: string }>('DELETE FROM documents WHERE id = $1 RETURNING number', [Number(id)]);
        await audit(me, 'document_deleted', row?.number || `#${id}`);
        return json(200, { ok: true });
      }
    }

    // Volledige gegevensexport (JSON) — alleen admin
    if (resource === 'backup' && m === 'GET') {
      if (!need('data.export')) return FORBIDDEN();
      const data = {
        exported_at: new Date().toISOString(),
        settings: await q('SELECT * FROM settings'), clients: await q('SELECT * FROM clients'), catalog: await q('SELECT * FROM catalog'),
        rates: await q('SELECT * FROM rates'), documents: await q('SELECT * FROM documents'),
        users: await q('SELECT id, email, name, role, active, created_at FROM users'),
      };
      await audit(me, 'data_exported');
      return new Response(JSON.stringify(data, null, 1), { headers: {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="ica-export-${new Date().toISOString().slice(0, 10)}.json"` } });
    }

    return fail(404, 'Niet gevonden');
  } catch (e: any) {
    console.error('API-fout', resource, e);
    return fail(500, 'Er ging iets mis op de server.');
  }
}

export { handle as GET, handle as POST, handle as DELETE };
