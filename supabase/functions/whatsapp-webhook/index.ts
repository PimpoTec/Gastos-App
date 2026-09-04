// Webhook de WhatsApp Cloud API: recibe mensajes de texto, los interpreta con
// Gemini (nivel gratuito), y carga el gasto correspondiente en la cuenta del
// usuario que escribió (identificado por su número en whatsapp_usuarios).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const WHATSAPP_TOKEN = Deno.env.get('WHATSAPP_TOKEN')!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!;
const WHATSAPP_VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_MODEL = 'gemini-3.6-flash';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function nuevoId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

// Los celulares argentinos llevan un 9 después del código de país en WhatsApp
// (549 11 xxxx xxxx), pero Meta los registra sin ese 9 (54 11 xxxx xxxx). El
// webhook informa una forma y la lista de destinatarios permitidos puede tener
// la otra, así que se prueban ambas.
function variantesTelefono(telefono: string): string[] {
  const t = telefono.replace(/\D/g, '');
  const vars = [t];
  if (t.startsWith('549')) vars.push('54' + t.slice(3));
  else if (t.startsWith('54')) vars.push('549' + t.slice(2));
  return vars;
}

async function enviarWhatsapp(telefono: string, texto: string) {
  for (const destino of variantesTelefono(telefono)) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: destino,
        text: { body: texto },
      }),
    });
    if (res.ok) {
      console.log('[wa] respuesta enviada a', destino);
      return;
    }
    console.error('[wa] no pude responder a', destino, res.status, await res.text());
  }
}

interface GastoExtraido {
  monto: number;
  descripcion: string;
  categoria: string | null;
  medio_pago: string | null;
  moneda: 'ARS' | 'USD';
  cuotas: number | null;
}

async function interpretarMensaje(
  texto: string,
  categorias: string[],
  tarjetas: string[],
): Promise<GastoExtraido | null> {
  const prompt = `Interpretá este mensaje como un gasto de la app Gastos-App: "${texto}"

Categorías disponibles del usuario: ${categorias.join(', ') || '(ninguna)'}
Medios de pago disponibles del usuario: ${tarjetas.join(', ') || '(ninguno)'}

Respondé ÚNICAMENTE un JSON con esta forma exacta:
{"monto": number, "descripcion": string, "categoria": string|null, "medio_pago": string|null, "moneda": "ARS"|"USD", "cuotas": number|null}

- "categoria" y "medio_pago" tienen que ser EXACTAMENTE uno de los nombres de las listas de arriba (el que más se parezca), o null si no se menciona o no hay ninguno parecido.
- "cuotas" es el número total de cuotas si lo menciona (ej: "en 3 cuotas" -> 3), si no null.
- Si el mensaje no describe un gasto con un monto claro, respondé exactamente: {"error": "no_parseable"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );
  if (!res.ok) {
    console.error('[gemini] error', res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) {
    console.error('[gemini] respuesta sin texto:', JSON.stringify(data).slice(0, 500));
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error || typeof parsed.monto !== 'number') return null;
    return parsed as GastoExtraido;
  } catch {
    return null;
  }
}

function encontrarPorNombre<T extends { id: number; nombre: string }>(
  lista: T[],
  nombre: string | null,
): T | null {
  if (!nombre) return null;
  const n = nombre.toLowerCase();
  return lista.find((x) => x.nombre.toLowerCase() === n)
    || lista.find((x) => x.nombre.toLowerCase().includes(n) || n.includes(x.nombre.toLowerCase()))
    || null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    if (
      url.searchParams.get('hub.mode') === 'subscribe' &&
      url.searchParams.get('hub.verify_token') === WHATSAPP_VERIFY_TOKEN
    ) {
      return new Response(url.searchParams.get('hub.challenge'), { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json();
  const mensaje = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!mensaje) {
    // Meta también manda webhooks de estado (entregado/leído): no son un gasto.
    const tipoEvento = body?.entry?.[0]?.changes?.[0]?.field ?? 'desconocido';
    console.log('[wa] webhook sin mensaje (campo:', tipoEvento, ')');
    return new Response('ok', { status: 200 });
  }
  if (mensaje.type !== 'text') {
    console.log('[wa] mensaje ignorado, tipo:', mensaje.type);
    return new Response('ok', { status: 200 });
  }

  const telefono: string = mensaje.from;
  const texto: string = mensaje.text.body;
  console.log('[wa] mensaje de', telefono, '->', texto);

  const { data: usuarios, error: errUsuario } = await supabase
    .from('whatsapp_usuarios')
    .select('*')
    .in('telefono', variantesTelefono(telefono));
  const whUsuario = usuarios?.[0] ?? null;

  if (errUsuario) console.error('[wa] error buscando usuario', errUsuario.message);

  if (!whUsuario) {
    console.log('[wa] numero no vinculado:', telefono);
    await enviarWhatsapp(telefono, 'Tu número todavía no está vinculado a ninguna cuenta de Gastos-App.');
    return new Response('ok', { status: 200 });
  }

  const [{ data: tarjetas }, { data: categorias }] = await Promise.all([
    supabase.from('tarjetas').select('id,nombre').eq('user_id', whUsuario.user_id),
    supabase.from('categorias').select('id,nombre').eq('user_id', whUsuario.user_id).eq('tipo', 'gasto'),
  ]);

  const extraido = await interpretarMensaje(
    texto,
    (categorias ?? []).map((c) => c.nombre),
    (tarjetas ?? []).map((t) => t.nombre),
  );

  console.log('[wa] interpretado:', JSON.stringify(extraido));

  if (!extraido) {
    await enviarWhatsapp(
      telefono,
      'No entendí ese gasto. Probá algo como: "gasté 500 en el kiosco con débito".',
    );
    return new Response('ok', { status: 200 });
  }

  const tarjeta = encontrarPorNombre(tarjetas ?? [], extraido.medio_pago);
  const categoria = encontrarPorNombre(categorias ?? [], extraido.categoria);
  const pagoId = tarjeta?.id ?? whUsuario.tarjeta_default;
  const catId = categoria?.id ?? whUsuario.cat_default;

  if (!pagoId || !catId) {
    await enviarWhatsapp(
      telefono,
      `Entendí "${extraido.descripcion}" por ${fmt(extraido.monto)}, pero me falta saber ${!pagoId ? 'el medio de pago' : ''}${!pagoId && !catId ? ' y ' : ''}${!catId ? 'la categoría' : ''}. Decímelo y lo cargo.`,
    );
    return new Response('ok', { status: 200 });
  }

  const montoCuota = extraido.cuotas ? extraido.monto / extraido.cuotas : extraido.monto;
  const { error: errInsert } = await supabase.from('gastos').insert({
    id: nuevoId(),
    user_id: whUsuario.user_id,
    monto: montoCuota,
    monto_original: extraido.cuotas ? extraido.monto : null,
    cuotas: extraido.cuotas,
    pago: String(pagoId),
    descripcion: extraido.descripcion,
    cat: catId,
    fecha: new Date().toISOString().slice(0, 10),
    moneda: extraido.moneda || 'ARS',
    es_fijo: false,
    es_reembolsable: false,
    cobrado: false,
  });

  if (errInsert) {
    console.error('[wa] error insertando gasto', errInsert.message);
    await enviarWhatsapp(telefono, 'Entendí el gasto pero no lo pude guardar. Probá de nuevo en un rato.');
    return new Response('ok', { status: 200 });
  }
  console.log('[wa] gasto cargado para', whUsuario.user_id);

  const cuotaTxt = extraido.cuotas ? ` en ${extraido.cuotas} cuotas` : '';
  await enviarWhatsapp(
    telefono,
    `✅ Cargado: ${fmt(extraido.monto)} - ${extraido.descripcion} (${tarjeta?.nombre ?? 'medio por defecto'})${cuotaTxt}`,
  );
  return new Response('ok', { status: 200 });
});

function fmt(n: number): string {
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
