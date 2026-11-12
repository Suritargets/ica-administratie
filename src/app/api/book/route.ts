import { createHash } from 'node:crypto';
import { q, q1 } from '@/lib/db';
import { sameOrigin } from '@/lib/auth';
import { mailNewAppointment } from '@/lib/mail';
import { allTimes, dayBookable, freeTimes, isoDay, nowPb, parseAvail, validDate } from '@/lib/appointments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function settings() {
  const rows = await q<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'appt\\_%'");
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
const takenOn = async (from: string, to: string) => {
  const rows = await q<{ date: string; time: string }>("SELECT date, time FROM appointments WHERE date BETWEEN $1 AND $2 AND status <> 'geannuleerd'", [from, to]);
  const map = new Map<string, Set<string>>();
  for (const r of rows) (map.get(r.date) ?? map.set(r.date, new Set()).get(r.date)!).add(r.time);
  return map;
};

// GET /api/book?month=YYYY-MM  → { days: { "YYYY-MM-DD": vrijeSlots } }
// GET /api/book?date=YYYY-MM-DD → { times: ["09:00", …] }
export async function GET(req: Request) {
  try {
    const a = parseAvail(await settings());
    if (!a.enabled) return json(200, { enabled: false, days: {}, times: [] });
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    const month = url.searchParams.get('month');
    const now = nowPb();

    if (date) {
      if (!validDate(date)) return json(400, { error: 'Ongeldige datum' });
      const taken = (await takenOn(date, date)).get(date) ?? new Set<string>();
      return json(200, { enabled: true, times: freeTimes(a, date, taken, now) });
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const first = new Date(month + '-01T00:00:00Z');
      if (isNaN(first.getTime())) return json(400, { error: 'Ongeldige maand' });
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
      const taken = await takenOn(isoDay(first), isoDay(last));
      const days: Record<string, number> = {};
      for (let d = new Date(first); d <= last; d = new Date(d.getTime() + 86400000)) {
        const key = isoDay(d);
        if (dayBookable(a, key, now)) days[key] = freeTimes(a, key, taken.get(key) ?? new Set(), now).length;
      }
      return json(200, { enabled: true, days, slots: allTimes(a).length });
    }
    return json(400, { error: 'Geef date of month op' });
  } catch (e) {
    console.error('book GET', e);
    return json(500, { error: 'Er ging iets mis. Probeer het later opnieuw.' });
  }
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json(403, { error: 'Geweigerd' });
  try {
    const b = await req.json().catch(() => ({}));
    if (b.company_site) return json(200, { ok: true }); // honeypot: bots vullen dit veld in

    const name = clean(b.name, 100), email = clean(b.email, 150).toLowerCase(), phone = clean(b.phone, 30);
    const subject = clean(b.subject, 120), message = String(b.message ?? '').replace(/\r/g, '').trim().slice(0, 1000);
    const date = clean(b.date, 10), time = clean(b.time, 5);
    if (name.length < 2) return json(400, { error: 'Vul je naam in.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Vul een geldig e-mailadres in.' });
    if (phone && !/^[+\d][\d\s().-]{5,}$/.test(phone)) return json(400, { error: 'Vul een geldig telefoonnummer in.' });

    const a = parseAvail(await settings());
    if (!a.enabled) return json(400, { error: 'Afspraken maken is momenteel niet mogelijk.' });
    const taken = (await takenOn(date, date)).get(date) ?? new Set<string>();
    if (!validDate(date) || !freeTimes(a, date, taken).includes(time)) return json(409, { error: 'Dit tijdstip is niet meer beschikbaar. Kies een ander moment.' });

    // misbruik tegengaan: max. 5 aanvragen per uur per IP en max. 3 openstaande per e-mailadres
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'onbekend';
    const ipHash = createHash('sha256').update(ip + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 32);
    const recent = await q1<{ n: number }>("SELECT COUNT(*)::int AS n FROM appointments WHERE ip_hash = $1 AND created_at > now() - interval '1 hour'", [ipHash]);
    if ((recent?.n ?? 0) >= 5) return json(429, { error: 'Je hebt te veel aanvragen gedaan. Probeer het later opnieuw.' });
    const open = await q1<{ n: number }>("SELECT COUNT(*)::int AS n FROM appointments WHERE lower(email) = $1 AND status <> 'geannuleerd' AND date >= $2", [email, isoDay(nowPb())]);
    if ((open?.n ?? 0) >= 3) return json(429, { error: 'Er staan al meerdere afspraken op dit e-mailadres. Neem contact met ons op.' });

    try {
      await q('INSERT INTO appointments (date, time, name, email, phone, subject, message, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [date, time, name, email, phone || null, subject || null, message || null, ipHash]);
    } catch (e: any) {
      if (e?.code === '23505') return json(409, { error: 'Dit tijdstip is net bezet. Kies een ander moment.' });
      throw e;
    }
    // e-mail naar kantoor + ontvangstbevestiging naar de bezoeker (mislukken blokkeert de boeking niet)
    const office = (await q1<{ value: string }>("SELECT value FROM settings WHERE key = 'email'"))?.value || process.env.SMTP_USER || '';
    if (office) await mailNewAppointment({ date, time, name, email, phone, subject, message }, office);
    return json(200, { ok: true, date, time });
  } catch (e) {
    console.error('book POST', e);
    return json(500, { error: 'Er ging iets mis. Probeer het later opnieuw.' });
  }
}
