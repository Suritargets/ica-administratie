import nodemailer from 'nodemailer';
import brand from '@/brand/brand.json';

// SMTP is actief als HOST + USER + PASSWORD gezet zijn (zie Vercel → Environment Variables)
export const smtpConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);

const transport = () => nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: (process.env.SMTP_SECURE ?? (process.env.SMTP_PORT === '465' ? 'true' : 'false')) === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
});

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Eén net sjabloon voor alle mails (merkkleuren uit brand.json)
export function layout(title: string, bodyHtml: string) {
  const C = brand.colors;
  return `<!doctype html><html><body style="margin:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#1b2333">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="background:${C.primary};padding:18px 24px;border-radius:12px 12px 0 0;border-bottom:4px solid ${C.accent}">
<span style="color:#fff;font-size:18px;font-weight:700">${esc(brand.name)}</span></div>
<div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;line-height:1.55"><h2 style="margin:0 0 14px;font-size:19px;color:${C.primary}">${esc(title)}</h2>${bodyHtml}</div>
<p style="color:#7a859c;font-size:12px;text-align:center;margin-top:14px">Dit bericht is automatisch verstuurd.</p></div></body></html>`;
}

type Mail = { to: string; subject: string; html: string; text: string; replyTo?: string };

// Mislukt versturen mag een boeking nooit blokkeren: geeft true/false terug en logt de fout
export async function sendMail(m: Mail): Promise<boolean> {
  if (!smtpConfigured()) return false;
  try {
    await transport().sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, ...m });
    return true;
  } catch (e: any) {
    console.error('Mail mislukt:', e?.code, e?.message);
    return false;
  }
}

export const fmtDay = (date: string) => {
  const d = new Date(date + 'T00:00:00Z');
  const w = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'][d.getUTCDay()];
  const m = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'][d.getUTCMonth()];
  return `${w} ${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
};

type Appt = { date: string; time: string; name: string; email: string; phone?: string | null; subject?: string | null; message?: string | null };

// Nieuwe aanvraag → naar het kantoor én ontvangstbevestiging naar de bezoeker
export async function mailNewAppointment(a: Appt, office: string) {
  const when = `${fmtDay(a.date)} om ${a.time}`;
  const rows = [['Moment', when], ['Naam', a.name], ['E-mail', a.email], ['Telefoon', a.phone || '—'], ['Onderwerp', a.subject || '—'], ['Bericht', a.message || '—']]
    .map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#5c6882;vertical-align:top">${k}</td><td style="padding:4px 0;white-space:pre-line">${esc(v)}</td></tr>`).join('');
  const toOffice = sendMail({
    to: office, replyTo: a.email, subject: `Nieuwe afspraakaanvraag: ${a.date} ${a.time}`,
    html: layout('Nieuwe afspraakaanvraag', `<table style="font-size:14.5px">${rows}</table><p>Bevestig of annuleer de afspraak in de administratie onder <b>Afspraken</b>.</p>`),
    text: `Nieuwe afspraakaanvraag\n${when}\nNaam: ${a.name}\nE-mail: ${a.email}\nTelefoon: ${a.phone || '-'}\nOnderwerp: ${a.subject || '-'}\n${a.message || ''}`,
  });
  const toVisitor = sendMail({
    to: a.email, replyTo: office, subject: 'We hebben je afspraakaanvraag ontvangen',
    html: layout('Bedankt voor je aanvraag', `<p>Hallo ${esc(a.name)},</p><p>We hebben je aanvraag voor <b>${esc(when)}</b> (Surinaamse tijd) ontvangen. Je ontvangt van ons een bevestiging zodra de afspraak is ingepland.</p><p>Moet je iets wijzigen? Antwoord dan op deze e-mail.</p>`),
    text: `Hallo ${a.name},\n\nWe hebben je aanvraag voor ${when} (Surinaamse tijd) ontvangen. Je ontvangt een bevestiging zodra de afspraak is ingepland.\n`,
  });
  await Promise.all([toOffice, toVisitor]);
}

// Afspraak bevestigd of geannuleerd → bericht aan de bezoeker
export async function mailAppointmentStatus(a: Appt, status: 'bevestigd' | 'geannuleerd', office: string) {
  const when = `${fmtDay(a.date)} om ${a.time}`;
  const ok = status === 'bevestigd';
  return sendMail({
    to: a.email, replyTo: office,
    subject: ok ? 'Je afspraak is bevestigd' : 'Je afspraak is geannuleerd',
    html: layout(ok ? 'Je afspraak is bevestigd ✓' : 'Je afspraak is geannuleerd',
      `<p>Hallo ${esc(a.name)},</p><p>${ok ? `Je afspraak op <b>${esc(when)}</b> (Surinaamse tijd) is bevestigd. Tot dan!` : `Helaas gaat je afspraak op <b>${esc(when)}</b> niet door. Je kunt via onze website een nieuw moment kiezen.`}</p><p>Vragen? Antwoord gewoon op deze e-mail.</p>`),
    text: `Hallo ${a.name},\n\n${ok ? `Je afspraak op ${when} is bevestigd.` : `Je afspraak op ${when} gaat helaas niet door.`}\n`,
  });
}
