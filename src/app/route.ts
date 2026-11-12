import { q } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import brand from '@/brand/brand.json';
import { BOOKING_CSS, BOOKING_JS } from '@/lib/booking-widget';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Alleen openbare bedrijfsgegevens (nooit andere instellingen)
const PUBLIC_KEYS = ['company_name', 'tagline', 'address', 'postal_city', 'country', 'phone', 'email', 'website', 'footer_services', 'appt_enabled'];

async function publicInfo(): Promise<Record<string, string>> {
  const fallback = Object.fromEntries(PUBLIC_KEYS.map(k => [k, String((brand.defaults as Record<string, string>)[k] ?? '')]));
  try {
    const rows = await q<{ key: string; value: string }>('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [PUBLIC_KEYS]);
    for (const r of rows) if (r.value) fallback[r.key] = r.value;
  } catch { /* database niet bereikbaar: toon standaardgegevens */ }
  return fallback;
}

export async function GET(req: Request) {
  const i = await publicInfo();
  let loggedIn = false;
  try { loggedIn = !!(await currentUser(req)); } catch {}
  const C = brand.colors;

  const addrLines = [i.address, [i.postal_city, i.country].filter(Boolean).join(', ')].filter(Boolean);
  const mapQ = encodeURIComponent([i.company_name, ...addrLines].join(', '));
  const web = i.website ? (/^https?:\/\//i.test(i.website) ? i.website : 'https://' + i.website) : '';
  const services = i.footer_services ? i.footer_services.split('|').map(s => s.trim()).filter(Boolean) : [];

  const contactRows = [
    addrLines.length ? `<div class="row"><span class="ic">📍</span><div><b>Adres</b><br><a href="https://www.google.com/maps/search/?api=1&query=${mapQ}" target="_blank" rel="noopener">${addrLines.map(esc).join('<br>')}</a></div></div>` : '',
    i.phone ? `<div class="row"><span class="ic">📞</span><div><b>Telefoon</b><br><a href="tel:${esc(i.phone.replace(/[^+\d]/g, ''))}">${esc(i.phone)}</a></div></div>` : '',
    i.email ? `<div class="row"><span class="ic">✉️</span><div><b>E-mail</b><br><a href="mailto:${esc(i.email)}">${esc(i.email)}</a></div></div>` : '',
    web ? `<div class="row"><span class="ic">🌐</span><div><b>Website</b><br><a href="${esc(web)}" target="_blank" rel="noopener">${esc(i.website)}</a></div></div>` : '',
  ].filter(Boolean).join('');

  const booking = i.appt_enabled !== '0';
  const bookingHtml = booking ? `<section class="card book" id="book"><h2>Maak een afspraak</h2>
<p class="sub">Kies een dag en tijd die jou uitkomt. Wij bevestigen je afspraak per e-mail of telefoon.</p>
<div class="bk"><div id="cal"></div><div id="pick" class="pick"><div class="hint">Kies eerst een dag in de kalender.</div></div></div></section>` : '';

  const html = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(brand.name)}</title>
<meta name="description" content="${esc(i.company_name)} — ${esc(i.tagline)}">
<link rel="icon" href="/favicon.ico"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="${C.primary}">
<style>
:root{--navy:${C.primary};--navy2:${C.primary2};--accent:${C.accent};--accent-l:${C.accentOnDark};--ink:#1b2333;--mut:#5c6882}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:16px/1.6 Inter,system-ui,"Segoe UI",sans-serif;color:var(--ink);background:#f3f5f9}
a{color:var(--accent)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{background:var(--navy);border-bottom:5px solid var(--accent)}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-top:16px;padding-bottom:16px}
header img{height:52px;display:block}
.btn{display:inline-block;padding:11px 20px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none;border:0}
.btn:hover{filter:brightness(1.1)}.btn.ghost{background:transparent;border:1.5px solid #ffffff55;color:#fff}
.hero{background:linear-gradient(160deg,var(--navy),var(--navy2));color:#fff;padding:72px 0 84px}
.hero h1{font-size:clamp(28px,5vw,46px);line-height:1.15;margin:0 0 14px;font-weight:800;letter-spacing:-.5px;max-width:760px}
.hero p{font-size:clamp(16px,2.2vw,20px);color:#cdd8ee;margin:0 0 28px;max-width:640px}
.hero .cta{display:flex;gap:12px;flex-wrap:wrap}
.tags{display:flex;gap:10px;flex-wrap:wrap;margin-top:34px}.tags span{border:1px solid #ffffff33;border-radius:99px;padding:5px 14px;font-size:13.5px;color:var(--accent-l)}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(16,36,84,.09);padding:32px;margin-top:-44px;position:relative}
.card h2{margin:0 0 18px;font-size:22px;color:var(--navy)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:22px 28px}
.row{display:flex;gap:12px;align-items:flex-start}.ic{font-size:20px;line-height:1.5}
.row b{font-size:13px;letter-spacing:.6px;text-transform:uppercase;color:var(--mut)}
.row a{color:var(--ink);text-decoration:none;font-weight:500}.row a:hover{color:var(--accent);text-decoration:underline}
.empty{color:var(--mut)}
footer{padding:34px 0 40px;color:var(--mut);font-size:13.5px;text-align:center}
footer a{color:var(--mut)}
${BOOKING_CSS}</style></head><body>
<header><div class="wrap"><img src="/logo-light.png" alt="${esc(brand.short)} — ${esc(i.company_name)}">
<a class="btn ghost" href="${loggedIn ? '/app' : '/login'}">${loggedIn ? 'Naar de administratie' : 'Inloggen'}</a></div></header>
<section class="hero"><div class="wrap">
<h1>${esc(i.company_name)}</h1>
<p>${esc(i.tagline)}</p>
<div class="cta">${booking ? '<a class="btn" href="#book">Afspraak maken</a>' : ''}<a class="btn ghost" href="#contact">Contact</a></div>
${services.length ? `<div class="tags">${services.map(s => `<span>${esc(s)}</span>`).join('')}</div>` : ''}
</div></section>
<main class="wrap">${bookingHtml}<section class="card" id="contact"><h2>Contact</h2>
${contactRows ? `<div class="grid">${contactRows}</div>` : '<p class="empty">Contactgegevens volgen.</p>'}
</section></main>
<footer><div class="wrap">© ${new Date().getFullYear()} ${esc(i.company_name)}<br>Design by <a href="https://suritargets.com" target="_blank" rel="noopener">suritargets.com</a></div></footer>
${booking ? '<script>' + BOOKING_JS + '</script>' : ''}
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" } });
}
