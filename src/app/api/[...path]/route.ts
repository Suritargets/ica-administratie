import { q, q1 } from '@/lib/db';
import { allowed, currentUser, hashPassword, makeSession, passwordProblem, sameOrigin, sessionCookie, verifyPassword, type User } from '@/lib/auth';
import { isRole, permsOf, type Perm } from '@/lib/perms';
import { layout, mailAppointmentStatus, sendMail, smtpConfigured } from '@/lib/mail';
import { addDaysIso, baseCur, calc, cleanCur, getSettings, INTERVALS, nextNumber, rateFor, round2, runRecurring, todayPb, type DocType } from '@/lib/docs';

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
function rowToDoc(r: any) {
  if (!r) return null;
  const { client_json, items_json, ...rest } = r;
  return { ...rest, client: JSON.parse(client_json || '{}'), items: JSON.parse(items_json || '[]') };
}
const audit = (u: User | null, action: string, detail = '') =>
  q('INSERT INTO audit_log (user_id, user_name, action, detail) VALUES ($1, $2, $3, $4)', [u?.id ?? null, u?.name ?? null, action, detail]).catch(() => {});
const isUnique = (e: any) => e?.code === '23505';

// Status van een factuur volgt de betalingen: volledig betaald → Betaald, anders weer Open
async function syncPaid(invoiceId: number) {
  const inv = await q1<any>('SELECT id, total, status FROM documents WHERE id = $1', [invoiceId]);
  if (!inv) return;
  const p = await q1<{ s: number; last: string | null }>('SELECT COALESCE(SUM(amount),0)::float8 AS s, MAX(date) AS last FROM payments WHERE invoice_id = $1', [invoiceId]);
  const paid = p?.s ?? 0;
  if (paid >= inv.total - 0.005 && paid > 0) await q("UPDATE documents SET status='Betaald', paid_on=$1, updated_at=now() WHERE id=$2", [p!.last, invoiceId]);
  else if (inv.status === 'Betaald' || inv.status === 'Concept') await q("UPDATE documents SET status='Open', paid_on=NULL, updated_at=now() WHERE id=$1", [invoiceId]);
}

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

    if (resource === 'next-number') {
      const t = url.searchParams.get('type');
      return json(200, { number: await nextNumber((t === 'factuur' || t === 'creditnota') ? t : 'offerte') });
    }

    // ---- betalingen op facturen ----
    if (resource === 'payments') {
      if (m === 'GET') {
        const rows = await q<any>(`SELECT p.*, d.number, d.client_json, d.currency, d.total FROM payments p JOIN documents d ON d.id = p.invoice_id ORDER BY p.date DESC, p.id DESC`);
        return json(200, rows.map(({ client_json, ...r }) => ({ ...r, client: JSON.parse(client_json || '{}') })));
      }
      if (m === 'POST') {
        if (!need('docs.write')) return FORBIDDEN();
        const b = await body(req);
        const inv = await q1<any>('SELECT id, number, total, status FROM documents WHERE id = $1 AND type = $2', [Number(b.invoice_id), 'factuur']);
        if (!inv) return fail(400, 'Kies een factuur.');
        const amount = round2(b.amount);
        if (!(amount > 0)) return fail(400, 'Vul een bedrag groter dan 0 in.');
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : todayPb();
        const method = ['Bank', 'Contant', 'Kaart', 'Anders'].includes(b.method) ? b.method : 'Bank';
        await q('INSERT INTO payments (invoice_id, date, amount, method, reference, note, created_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [inv.id, date, amount, method, String(b.reference || '').slice(0, 100), String(b.note || '').slice(0, 300), me.name]);
        await syncPaid(inv.id);
        await audit(me, 'payment_added', `${inv.number} ${amount}`);
        return json(200, { ok: true });
      }
      if (m === 'DELETE' && id) {
        if (!need('docs.delete')) return FORBIDDEN();
        const p = await q1<any>('DELETE FROM payments WHERE id = $1 RETURNING invoice_id, amount', [Number(id)]);
        if (p) { await syncPaid(p.invoice_id); await audit(me, 'payment_deleted', `#${id} ${p.amount}`); }
        return json(200, { ok: true });
      }
    }

    // ---- terugkerende facturen ----
    if (resource === 'recurring') {
      if (m === 'GET') {
        const rows = await q<any>('SELECT * FROM recurring ORDER BY active DESC, next_date');
        return json(200, rows.map(({ client_json, items_json, ...r }) => ({ ...r, client: JSON.parse(client_json || '{}'), items: JSON.parse(items_json || '[]'),
          ...calc(JSON.parse(items_json || '[]'), r.vat_rate, r.discount) })));
      }
      if (id === 'run' && m === 'POST') {
        if (!need('docs.write')) return FORBIDDEN();
        const made = await runRecurring(me.name);
        await audit(me, 'recurring_run', made.join(', '));
        return json(200, { made });
      }
      if (m === 'POST') {
        if (!need('docs.write')) return FORBIDDEN();
        const b = await body(req);
        if (!INTERVALS.includes(b.interval)) return fail(400, 'Kies een interval.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.next_date))) return fail(400, 'Vul een geldige startdatum in.');
        const end = /^\d{4}-\d{2}-\d{2}$/.test(String(b.end_date)) ? b.end_date : null;
        const auto = b.auto_status === 'Concept' ? 'Concept' : 'Open';
        const name = String(b.name || '').trim().slice(0, 120) || 'Terugkerende factuur';
        const anchor = Number(String(b.next_date).slice(8, 10));
        if (b.id) {
          const row = await q1('UPDATE recurring SET name=$1, interval=$2, next_date=$3, end_date=$4, auto_status=$5, active=$6, anchor_day=$7 WHERE id=$8 RETURNING id',
            [name, b.interval, b.next_date, end, auto, b.active !== false, anchor, Number(b.id)]);
          if (!row) return fail(404, 'Niet gevonden');
          await audit(me, 'recurring_updated', name);
          return json(200, { ok: true });
        }
        const src = await q1<any>("SELECT * FROM documents WHERE id = $1 AND type = 'factuur'", [Number(b.source_id)]);
        if (!src) return fail(400, 'Kies een factuur als basis.');
        await q(`INSERT INTO recurring (name, client_id, client_json, subject, reference, items_json, vat_rate, discount, currency, lang, terms, notes, interval, next_date, anchor_day, end_date, auto_status, created_by_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [name, src.client_id, src.client_json, src.subject, '', src.items_json, src.vat_rate, src.discount, src.currency, src.lang, src.terms, src.notes, b.interval, b.next_date, anchor, end, auto, me.name]);
        await audit(me, 'recurring_created', name);
        return json(200, { ok: true });
      }
      if (m === 'DELETE' && id) {
        if (!need('docs.delete')) return FORBIDDEN();
        await q('DELETE FROM recurring WHERE id = $1', [Number(id)]);
        await audit(me, 'recurring_deleted', `#${id}`);
        return json(200, { ok: true });
      }
    }

    if (resource === 'docs') {
      const SEL = 'SELECT d.*, COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = d.id), 0)::float8 AS paid_amount FROM documents d';
      if (m === 'GET' && id) return json(200, rowToDoc(await q1(SEL + ' WHERE d.id = $1', [Number(id)])));
      if (m === 'GET') {
        const type = url.searchParams.get('type');
        const rows = type
          ? await q(SEL + ' WHERE d.type = $1 ORDER BY d.date DESC, d.number DESC', [type])
          : await q(SEL + ' ORDER BY d.date DESC, d.number DESC');
        return json(200, rows.map(rowToDoc));
      }
      if (m === 'POST') {
        if (!need('docs.write')) return FORBIDDEN();
        const d = await body(req);
        if (!['offerte', 'factuur', 'creditnota'].includes(d.type)) return fail(400, 'Ongeldig type');
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
        payments: await q('SELECT * FROM payments'), recurring: await q('SELECT * FROM recurring'),
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
