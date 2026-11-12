import { q, q1 } from '@/lib/db';

// Gedeelde helpers voor documenten (offertes, facturen, creditnota's) — ook gebruikt door de cron voor terugkerende facturen.
export type DocType = 'offerte' | 'factuur' | 'creditnota';

export const round2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

export function calc(items: any[], vatRate: unknown, discount: unknown = 0) {
  const subtotal = round2((items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.rate) || 0), 0));
  const disc = round2(Math.min(Math.max(Number(discount) || 0, 0), subtotal));
  const vat_amount = round2((subtotal - disc) * (Number(vatRate) || 0) / 100);
  return { subtotal, discount: disc, vat_amount, total: round2(subtotal - disc + vat_amount) };
}

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

const PREFIX: Record<DocType, { key: string; def: string }> = {
  offerte: { key: 'quote_prefix', def: 'Q' },
  factuur: { key: 'invoice_prefix', def: 'INV' },
  creditnota: { key: 'credit_prefix', def: 'CN' },
};

export async function nextNumber(type: DocType) {
  const s = await getSettings();
  const p = PREFIX[type];
  const prefix = String(s[p.key] || p.def).trim().replace(/[^A-Za-z0-9-]/g, '') || 'DOC';
  const year = new Date().getFullYear();
  const rows = await q<{ number: string }>('SELECT number FROM documents WHERE number LIKE $1', [`${prefix}-${year}-%`]);
  const max = rows.reduce((m, r) => Math.max(m, parseInt(r.number.split('-').pop() || '0', 10) || 0), 0);
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}

export const cleanCur = async (c: unknown) => {
  const v = String(c || '').toUpperCase().trim();
  return /^[A-Z]{3}$/.test(v) ? v : ((await getSettings()).currency || 'EUR');
};
export const baseCur = async () => cleanCur((await getSettings()).base_currency || (await getSettings()).currency);

export async function rateFor(cur: string, date: string | null, base: string): Promise<number | null> {
  if (!cur || cur === base) return 1;
  const r = await q1<{ rate: number }>('SELECT rate FROM rates WHERE currency = $1 AND base = $2 AND date <= $3 ORDER BY date DESC LIMIT 1', [cur, base, date || '9999'])
    || await q1<{ rate: number }>('SELECT rate FROM rates WHERE currency = $1 AND base = $2 ORDER BY date ASC LIMIT 1', [cur, base]);
  return r ? r.rate : null;
}

// Vandaag in Suriname (UTC-3, geen zomertijd)
export const todayPb = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

export const addDaysIso = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};

export type Interval = 'week' | 'maand' | 'kwartaal' | 'jaar';
export const INTERVALS: Interval[] = ['week', 'maand', 'kwartaal', 'jaar'];

// Volgende datum; bij maanden blijft de oorspronkelijke dag (anchor) leidend, ingekort tot de laatste dag van de maand.
export function nextRun(iso: string, interval: Interval, anchorDay: number): string {
  if (interval === 'week') return addDaysIso(iso, 7);
  const [y, m] = iso.split('-').map(Number);
  const add = interval === 'maand' ? 1 : interval === 'kwartaal' ? 3 : 12;
  const t = (m - 1) + add;
  const ny = y + Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(anchorDay || 1, last)).padStart(2, '0')}`;
}

// Maakt facturen voor alle actieve sjablonen waarvan de datum is bereikt. Geeft de aangemaakte nummers terug.
export async function runRecurring(userName: string | null): Promise<string[]> {
  const today = todayPb();
  const due = await q<any>('SELECT * FROM recurring WHERE active = true AND next_date <= $1 ORDER BY next_date', [today]);
  const s = await getSettings();
  const payDays = parseInt(s.payment_days || '14', 10) || 14;
  const base = await baseCur();
  const made: string[] = [];
  for (const r of due) {
    let next: string = r.next_date, guard = 0;
    while (next <= today && (!r.end_date || next <= r.end_date) && guard++ < 12) {
      const items = JSON.parse(r.items_json || '[]');
      const t = calc(items, r.vat_rate, r.discount);
      const cur = await cleanCur(r.currency);
      const fx = cur === base ? 1 : await rateFor(cur, next, base);
      const number = await nextNumber('factuur');
      await q(`INSERT INTO documents (type, number, date, due_date, client_id, client_json, subject, subject_detail, reference, items_json, vat_rate,
        subtotal, vat_amount, total, status, terms, notes, discount, currency, fx_rate, fx_base, lang, created_by_name, updated_by_name)
        VALUES ('factuur',$1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
        [number, next, addDaysIso(next, payDays), r.client_id, r.client_json, r.subject || '', r.reference || '', JSON.stringify(items), r.vat_rate,
          t.subtotal, t.vat_amount, t.total, r.auto_status === 'Concept' ? 'Concept' : 'Open', r.terms || '', r.notes || '', t.discount,
          cur, fx, base, r.lang || null, userName || 'Terugkerend']);
      made.push(number);
      next = nextRun(next, r.interval, r.anchor_day);
    }
    const ended = r.end_date && next > r.end_date;
    await q('UPDATE recurring SET next_date = $1, last_run = $2, active = $3 WHERE id = $4', [next, today, ended ? false : r.active, r.id]);
  }
  return made;
}
