import Anthropic from '@anthropic-ai/sdk';

// OCR/lezen van bonnen en inkoopfacturen. Twee mogelijke aanbieders (instelbaar met omgevingsvariabelen op Vercel):
//  - OpenRouter: OPENROUTER_API_KEY (optioneel OCR_MODEL, standaard google/gemini-2.5-flash)
//  - Claude (Anthropic): ANTHROPIC_API_KEY
// OCR_PROVIDER = 'openrouter' of 'anthropic' forceert een keuze; zonder wordt OpenRouter gebruikt als die sleutel er is, anders Claude.
export type Provider = 'openrouter' | 'anthropic';
export function ocrProvider(): Provider | null {
  const want = String(process.env.OCR_PROVIDER || '').toLowerCase();
  if (want === 'openrouter' && process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (want === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
export const ocrConfigured = () => ocrProvider() !== null;

export type Scan = {
  vendor: string; date: string; due_date: string; reference: string; currency: string;
  total: number; vat_rate: number; description: string; category: string;
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export const RECEIPT_TYPES = [...IMAGE_TYPES, 'application/pdf'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendor', 'date', 'due_date', 'reference', 'currency', 'total', 'vat_rate', 'description', 'category'],
  properties: {
    vendor: { type: 'string', description: 'Naam van de leverancier / winkel (degene die het bedrag int)' },
    date: { type: 'string', description: 'Datum van de bon of factuur als YYYY-MM-DD, of een lege string als die ontbreekt' },
    due_date: { type: 'string', description: 'Uiterste betaaldatum als YYYY-MM-DD, of een lege string' },
    reference: { type: 'string', description: 'Factuur- of bonnummer van de leverancier, of een lege string' },
    currency: { type: 'string', description: 'ISO-valutacode van drie letters (bijv. SRD, USD, EUR), of een lege string als onduidelijk' },
    total: { type: 'number', description: 'Totaalbedrag dat betaald moet worden, inclusief BTW; 0 als onduidelijk' },
    vat_rate: { type: 'number', description: 'BTW-percentage (bijv. 10); 0 als er geen BTW op staat' },
    description: { type: 'string', description: 'Korte omschrijving van waar de uitgave voor is (maximaal 100 tekens)' },
    category: { type: 'string', description: 'Precies één naam uit de opgegeven categorielijst die het beste past, of een lege string' },
  },
} as const;

const PROMPT = (categories: string[]) =>
  `Lees deze bon of inkoopfactuur en vul de velden in. Verzin niets: laat onduidelijke tekstvelden leeg en zet onduidelijke bedragen op 0. Datums als YYYY-MM-DD. Kies de categorie uitsluitend uit deze lijst: ${categories.length ? categories.join(' | ') : '(geen)'}.`;

async function viaAnthropic(b64: string, mediaType: string, categories: string[]): Promise<any> {
  const client = new Anthropic();
  const file: Anthropic.ContentBlockParam = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType as (typeof IMAGE_TYPES)[number], data: b64 } };
  const res = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA as any } },
    messages: [{ role: 'user', content: [file, { type: 'text', text: PROMPT(categories) }] }],
  } as any);
  if ((res as any).stop_reason === 'refusal') throw new Error('Het document kon niet worden gelezen.');
  const text = (res.content as any[]).find(b => b.type === 'text')?.text;
  if (!text) throw new Error('Geen leesbaar resultaat ontvangen.');
  return JSON.parse(text);
}

async function viaOpenRouter(b64: string, mediaType: string, categories: string[]): Promise<any> {
  const dataUrl = `data:${mediaType};base64,${b64}`;
  const filePart = mediaType === 'application/pdf'
    ? { type: 'file', file: { filename: 'bon.pdf', file_data: dataUrl } }
    : { type: 'image_url', image_url: { url: dataUrl } };
  const body: any = {
    model: process.env.OCR_MODEL || 'google/gemini-2.5-flash',
    temperature: 0,
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: [filePart, { type: 'text', text:
      PROMPT(categories) + ' Antwoord uitsluitend met één JSON-object met precies deze velden: ' + JSON.stringify(SCHEMA.properties) }] }],
  };
  if (mediaType === 'application/pdf') body.plugins = [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }];
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'X-Title': 'ICA Administratie' },
    body: JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j?.error?.message || 'OpenRouter fout'), { status: res.status });
  const text: string = j?.choices?.[0]?.message?.content || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Geen leesbaar resultaat ontvangen.');
  return JSON.parse(m[0]);
}

export async function scanReceipt(b64: string, mediaType: string, categories: string[]): Promise<Scan> {
  const o = ocrProvider() === 'openrouter' ? await viaOpenRouter(b64, mediaType, categories) : await viaAnthropic(b64, mediaType, categories);
  const iso = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '');
  return {
    vendor: String(o.vendor || '').slice(0, 120), date: iso(o.date), due_date: iso(o.due_date), reference: String(o.reference || '').slice(0, 60),
    currency: /^[A-Za-z]{3}$/.test(String(o.currency)) ? String(o.currency).toUpperCase() : '',
    total: Math.max(Number(String(o.total).replace(',', '.')) || 0, 0), vat_rate: Math.min(Math.max(Number(o.vat_rate) || 0, 0), 100),
    description: String(o.description || '').slice(0, 200), category: categories.includes(o.category) ? o.category : '',
  };
}
