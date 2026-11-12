import { runRecurring } from '@/lib/docs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Dagelijks door Vercel Cron aangeroepen (zie vercel.json). Vercel stuurt automatisch "Authorization: Bearer <CRON_SECRET>".
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('Niet toegestaan', { status: 401 });
  try {
    const made = await runRecurring('Terugkerend (automatisch)');
    return Response.json({ ok: true, made });
  } catch (e) {
    console.error('cron recurring', e);
    return Response.json({ error: 'mislukt' }, { status: 500 });
  }
}
