// Beschikbaarheid voor afspraken. Alle tijden zijn Surinaamse tijd (UTC−3, geen zomertijd).
export type Avail = { enabled: boolean; days: number[]; start: number; end: number; slot: number; ahead: number; lead: number };

const toMin = (hhmm: string, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2])) : fallback;
};
const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

export function parseAvail(s: Record<string, string>): Avail {
  const days = String(s.appt_days ?? '1,2,3,4,5').split(',').map(x => Number(x.trim())).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
  return {
    enabled: s.appt_enabled !== '0',
    days,
    start: toMin(s.appt_start, 8 * 60),
    end: toMin(s.appt_end, 16 * 60),
    slot: num(s.appt_slot, 30, 10, 240),
    ahead: num(s.appt_ahead, 60, 1, 365),
    lead: num(s.appt_lead, 4, 0, 168),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
// "Nu" in Surinaamse tijd, uitgedrukt als UTC-velden (zodat we met getUTC* kunnen rekenen)
export const nowPb = () => new Date(Date.now() - 3 * 3600 * 1000);
export const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDay(new Date(s + 'T00:00:00Z')) === s;
const weekday = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();

export function allTimes(a: Avail): string[] {
  const out: string[] = [];
  for (let t = a.start; t + a.slot <= a.end; t += a.slot) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  return out;
}

export function dayBookable(a: Avail, date: string, now = nowPb()): boolean {
  if (!a.enabled || !validDate(date) || !a.days.includes(weekday(date))) return false;
  const today = isoDay(now);
  const last = isoDay(new Date(now.getTime() + a.ahead * 86400000));
  return date >= today && date <= last;
}

// Vrije tijden op een dag: niet in het verleden (+ voorlooptijd) en niet al bezet
export function freeTimes(a: Avail, date: string, taken: Set<string>, now = nowPb()): string[] {
  if (!dayBookable(a, date, now)) return [];
  const earliest = now.getTime() + a.lead * 3600 * 1000;
  return allTimes(a).filter(t => !taken.has(t) && new Date(`${date}T${t}:00Z`).getTime() >= earliest);
}
