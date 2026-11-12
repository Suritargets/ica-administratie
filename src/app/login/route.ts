import { currentUser } from '@/lib/auth';
import brand from '@/brand/brand.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const page = () => `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Inloggen — ${brand.name}</title><link rel="icon" href="/favicon.ico">
<style>
:root{--navy:${brand.colors.primary};--navy2:${brand.colors.primary2};--accent:${brand.colors.accent};--on:${brand.colors.onAccent}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f9;font:15px/1.5 Inter,system-ui,Segoe UI,sans-serif;color:#1b2333;padding:16px}
.card{width:100%;max-width:400px;background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(16,36,84,.12);overflow:hidden}
.head{background:var(--navy);padding:24px 28px;border-bottom:5px solid var(--accent)}.head img{height:46px;display:block}
.head div{color:#9cb0d6;font-size:10px;letter-spacing:3px;font-weight:700;margin-top:8px;text-transform:uppercase}
form{padding:26px 28px}h1{font-size:20px;margin:0 0 16px}label{display:block;font-size:13px;font-weight:600;margin-bottom:12px}
input{display:block;width:100%;margin-top:5px;padding:11px 12px;border:1px solid #cfd6e4;border-radius:9px;font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
button{width:100%;padding:12px;border:0;border-radius:9px;background:var(--navy);color:#fff;font:600 15px inherit;cursor:pointer;margin-top:4px}
button:hover{background:var(--navy2)}button:disabled{opacity:.6;cursor:wait}
.err{color:#b42318;font-size:13px;min-height:20px;margin:2px 0 6px}.foot{padding:12px 28px;background:#f4f6fa;font-size:12px;color:#6b7690;text-align:center}
</style></head><body>
<div class="card"><div class="head"><img src="/logo-light.png" alt="${brand.short}"><div>Administratie</div></div>
<form id="f" autocomplete="on"><h1>Inloggen</h1>
<label>E-mailadres<input name="email" type="email" autocomplete="username" required autofocus></label>
<label>Wachtwoord<input name="password" type="password" autocomplete="current-password" required></label>
<div class="err" id="err" role="alert"></div><button id="go">Inloggen</button></form>
<div class="foot">Toegang alleen voor geautoriseerde gebruikers</div></div>
<script>
const f=document.getElementById('f'),err=document.getElementById('err'),go=document.getElementById('go');
f.onsubmit=async e=>{e.preventDefault();err.textContent='';go.disabled=true;go.textContent='Bezig…';
 try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email.value,password:f.password.value})});
  const j=await r.json().catch(()=>({}));if(r.ok){location.replace('/');return}err.textContent=j.error||'Inloggen mislukt.'}
 catch{err.textContent='Geen verbinding met de server.'}
 go.disabled=false;go.textContent='Inloggen'};
</script></body></html>`;

export async function GET(req: Request) {
  try { if (await currentUser(req)) return new Response(null, { status: 302, headers: { Location: '/' } }); } catch {}
  return new Response(page(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'" } });
}
