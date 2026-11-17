import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentUser } from '@/lib/auth';
import { permsOf } from '@/lib/perms';
import brand from '@/brand/brand.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VERSION = '2.0.0';
let html: string | null = null;
const template = () => (html ??= readFileSync(join(process.cwd(), 'src/spa/index.html'), 'utf8'));

export async function GET(req: Request) {
  let me;
  try { me = await currentUser(req); }
  catch (e) { console.error(e); return new Response('Serverconfiguratie onvolledig (DATABASE_URL / SESSION_SECRET).', { status: 500 }); }
  if (!me) return new Response(null, { status: 302, headers: { Location: '/login', 'Cache-Control': 'no-store' } });

  const C: Record<string, string> = brand.colors || {};
  const D: Record<string, string> = brand.defaults || {};
  const brandCss = `:root{--navy:${C.primary};--navy-2:${C.primary2};--yellow:${C.accent};--on-accent:${C.onAccent};--label:${C.label || C.primary};--accent-dark:${C.accentOnDark || C.accent}}`;
  const brandJson = JSON.stringify({ id: brand.id, name: brand.name, short: brand.short, colors: C,
    defaults: { doc_layout: D.doc_layout || null, doc_labels: D.doc_labels || null, doc_theme: D.doc_theme || 'modern' } }).replace(/</g, '\\u003c');
  const meJson = JSON.stringify({ ...me, perms: permsOf(me.role) }).replace(/</g, '\\u003c');

  const out = template()
    .replace('/*__BRAND_CSS__*/', brandCss)
    .replaceAll('__APP_NAME__', brand.name).replaceAll('__APP_SHORT__', brand.short)
    .replace('__BRAND_JSON__', () => brandJson)
    .replace('__ME_JSON__', () => meJson)
    .replace('__APP_VERSION__', VERSION);

  return new Response(out, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
  } });
}
