// Webhook de WhatsApp Cloud API: recibe mensajes de texto, los interpreta con
// Gemini (nivel gratuito), y carga el gasto correspondiente en la cuenta del
// usuario que escribió (identificado por su número en whatsapp_usuarios).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cicloActual, calcularCuotaActual, aISO, sumarMesesFecha } from './ciclos.js';

const WHATSAPP_TOKEN = Deno.env.get('WHATSAPP_TOKEN')!;
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!;
const WHATSAPP_VERIFY_TOKEN = Deno.env.get('WHATSAPP_VERIFY_TOKEN')!;
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const GEMINI_MODEL = 'gemini-3.6-flash';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// La función corre en UTC, así que un gasto cargado a las 23:49 de Argentina
// caía en el día siguiente. Se fecha con el día local del usuario.
const ZONA_HORARIA = 'America/Argentina/Buenos_Aires';
function hoyLocal(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_HORARIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

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

type Intencion =
  | { tipo: 'gasto'; gasto: GastoExtraido }
  | { tipo: 'ingreso'; monto: number; descripcion: string; moneda: 'ARS' | 'USD'; categoria: string }
  | { tipo: 'saldo' }
  | { tipo: 'tarjeta'; tarjeta: string | null }
  | { tipo: 'desconocido' };

// Descarga un audio de WhatsApp. Son dos pasos: primero se pide la URL del
// media por su id, después se baja el archivo (ambos con el token de Meta).
async function bajarAudio(mediaId: string): Promise<{ mimeType: string; base64: string } | null> {
  const metaRes = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!metaRes.ok) {
    console.error('[wa] no pude pedir la URL del audio', metaRes.status, await metaRes.text());
    return null;
  }
  const { url, mime_type } = await metaRes.json();
  const archivoRes = await fetch(url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!archivoRes.ok) {
    console.error('[wa] no pude bajar el audio', archivoRes.status);
    return null;
  }
  const bytes = new Uint8Array(await archivoRes.arrayBuffer());
  // Gemini acepta hasta ~20MB por request contando el base64 (que infla ~33%).
  const MAX_BYTES = 14 * 1024 * 1024;
  if (bytes.length > MAX_BYTES) {
    console.error('[wa] audio demasiado largo:', bytes.length, 'bytes');
    return null;
  }
  let binario = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  console.log('[wa] audio bajado:', mime_type, bytes.length, 'bytes');
  return { mimeType: (mime_type || 'audio/ogg').split(';')[0], base64: btoa(binario) };
}

async function interpretarMensaje(
  entrada: string | { mimeType: string; base64: string },
  categorias: string[],
  tarjetas: string[],
): Promise<Intencion | null> {
  const esAudio = typeof entrada !== 'string';
  const encabezado = esAudio
    ? 'Escuchá este audio de un usuario de la app de finanzas personales Gastos-App.'
    : `Interpretá este mensaje de un usuario de la app de finanzas personales Gastos-App: "${entrada}"`;
  const prompt = `${encabezado}

Categorías de gasto del usuario: ${categorias.join(', ') || '(ninguna)'}
Medios de pago del usuario: ${tarjetas.join(', ') || '(ninguno)'}

Determiná qué quiere hacer y respondé ÚNICAMENTE un JSON con una de estas formas:

1) Registrar un gasto:
{"tipo":"gasto","monto":number,"descripcion":string,"categoria":string|null,"medio_pago":string|null,"moneda":"ARS"|"USD","cuotas":number|null}

2) Registrar un ingreso (cobró plata: sueldo, venta, transferencia recibida):
{"tipo":"ingreso","monto":number,"descripcion":string,"moneda":"ARS"|"USD","categoria":"sueldo"|"he50"|"he100"|"premio"|"extra"|"reembolso"|"otro"}

3) Preguntar cuánta plata le queda / su balance del mes:
{"tipo":"saldo"}

4) Preguntar cuánto tiene gastado o cuánto debe pagar de una tarjeta:
{"tipo":"tarjeta","tarjeta":string|null}

5) Cualquier otra cosa:
{"tipo":"desconocido"}

Reglas:
- "categoria" y "medio_pago" tienen que ser EXACTAMENTE uno de los nombres de las listas de arriba (el que más se parezca), o null si no se menciona o ninguno se parece.
- En "tarjeta", igual: el nombre exacto de la lista de medios de pago, o null si pregunta en general sin nombrar una.
- "cuotas" es el total de cuotas si lo menciona (ej: "en 3 cuotas" -> 3), si no null.
- En un ingreso, "categoria" es una de esas siete: sueldo, he50 (horas extra al 50%), he100 (horas extra al 100%), premio, extra (ingreso extra, ventas), reembolso, otro.
- Un gasto necesita un monto claro. Si dice que gastó pero no se entiende cuánto, usá {"tipo":"desconocido"}.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: esAudio
            ? [{ text: prompt }, { inlineData: { mimeType: entrada.mimeType, data: entrada.base64 } }]
            : [{ text: prompt }],
        }],
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
    const p = JSON.parse(raw);
    if (p.tipo === 'gasto' && typeof p.monto === 'number') return { tipo: 'gasto', gasto: p as GastoExtraido };
    if (p.tipo === 'ingreso' && typeof p.monto === 'number') {
      const CATS_INGRESO = ['sueldo', 'he50', 'he100', 'premio', 'extra', 'reembolso', 'otro'];
      return {
        tipo: 'ingreso',
        monto: p.monto,
        descripcion: p.descripcion || 'Ingreso',
        moneda: p.moneda || 'ARS',
        categoria: CATS_INGRESO.includes(p.categoria) ? p.categoria : 'otro',
      };
    }
    if (p.tipo === 'saldo') return { tipo: 'saldo' };
    if (p.tipo === 'tarjeta') return { tipo: 'tarjeta', tarjeta: p.tarjeta ?? null };
    return { tipo: 'desconocido' };
  } catch {
    return null;
  }
}

function fmtLista(tarjetas: { nombre: string }[]): string {
  return tarjetas.map((t, i) => `${i + 1}. ${t.nombre}`).join('\n');
}

function textoPreguntaMedio(g: GastoExtraido, tarjetas: { nombre: string }[]): string {
  const cuotaTxt = g.cuotas ? ` en ${g.cuotas} cuotas` : '';
  return `Anoté ${fmt(g.monto)} - ${g.descripcion}${cuotaTxt}.\n\n¿Con qué lo pagaste?\n${fmtLista(tarjetas)}\n\nRespondé con el número o el nombre.`;
}

function textoConfirmacion(g: GastoExtraido, medio: string): string {
  const cuotaTxt = g.cuotas ? ` en ${g.cuotas} cuotas` : '';
  return `✅ Cargado: ${fmt(g.monto)} - ${g.descripcion} (${medio})${cuotaTxt}`;
}

// Interpreta la respuesta a "¿con qué lo pagaste?": acepta el número de la
// lista o el nombre (aunque esté escrito parcial).
function resolverMedioElegido<T extends { id: number; nombre: string }>(
  texto: string,
  tarjetas: T[],
): T | null {
  const limpio = texto.trim();
  const n = parseInt(limpio, 10);
  if (!isNaN(n) && String(n) === limpio && n >= 1 && n <= tarjetas.length) return tarjetas[n - 1];
  return encontrarPorNombre(tarjetas, limpio);
}

// Categoría comodín para los gastos que el bot no pudo clasificar. Se crea la
// primera vez y después se reutiliza; desde la app se pueden reasignar.
const NOMBRE_CAT_BOT = 'Bot';
async function idCategoriaBot(
  userId: string,
  categorias: { id: number; nombre: string }[],
): Promise<number | null> {
  const existente = categorias.find((c) => c.nombre.toLowerCase() === NOMBRE_CAT_BOT.toLowerCase());
  if (existente) return existente.id;
  const id = nuevoId();
  const { error } = await supabase.from('categorias').insert({
    id,
    user_id: userId,
    nombre: NOMBRE_CAT_BOT,
    icono: 'box',
    color: '#748ffc',
    tipo: 'gasto',
  });
  if (error) {
    console.error('[wa] no pude crear la categoría Bot', error.message);
    return null;
  }
  console.log('[wa] categoría Bot creada para', userId);
  return id;
}

// Config de ciclo de una tarjeta. En config.cierres las claves son el id de la
// tarjeta como texto (viene de un objeto JS, donde las claves siempre son
// strings).
function cierresDe(config: { cierres?: Record<string, unknown> } | null, tarjetaId: number) {
  const cfg = config?.cierres?.[String(tarjetaId)] as Record<string, unknown> | undefined;
  return cfg?.dia ? cfg : null;
}

// ── Consultas ────────────────────────────────────────
// "Cuánta plata me queda": mismo criterio que la pestaña Balance de la app —
// ingresos del mes menos lo que salió del bolsillo (sin tarjeta de crédito) y
// las suscripciones ya pagadas que tampoco van con crédito.
async function calcularSaldoDelMes(userId: string) {
  const hoy = new Date(hoyLocal() + 'T12:00:00');
  const mes = hoy.getMonth(), anio = hoy.getFullYear();
  const desde = `${anio}-${String(mes + 1).padStart(2, '0')}-01`;
  const hasta = aISO(new Date(anio, mes + 1, 0));

  const [{ data: ingresos }, { data: gastosMes }, { data: tarjetas }, { data: subs }, { data: pagos }] =
    await Promise.all([
      supabase.from('ingresos').select('monto,moneda').eq('user_id', userId).gte('fecha', desde).lte('fecha', hasta),
      supabase.from('gastos').select('monto,moneda,pago').eq('user_id', userId).gte('fecha', desde).lte('fecha', hasta),
      supabase.from('tarjetas').select('id,nombre,es_tarjeta').eq('user_id', userId),
      supabase.from('suscripciones').select('id,nombre,monto,moneda,pago').eq('user_id', userId),
      supabase.from('suscripciones_pagos').select('sub_id,mes,anio,pagado').eq('user_id', userId),
    ]);

  const esCredito = new Set((tarjetas ?? []).filter((t) => t.es_tarjeta).map((t) => String(t.id)));
  const soloArs = (x: { monto: number | string; moneda?: string }) =>
    (x.moneda ?? 'ARS') === 'USD' ? 0 : Number(x.monto);

  const totalIngresos = (ingresos ?? []).reduce((a, i) => a + soloArs(i), 0);
  const totalGastos = (gastosMes ?? [])
    .filter((g) => !esCredito.has(String(g.pago)))
    .reduce((a, g) => a + soloArs(g), 0);
  const totalSubs = (subs ?? [])
    .filter((sub) => !esCredito.has(String(sub.pago)))
    .filter((sub) => (pagos ?? []).some((pg) =>
      pg.sub_id === sub.id && pg.mes === mes + 1 && pg.anio === anio && pg.pagado === true))
    .reduce((a, sub) => a + soloArs(sub), 0);

  return { totalIngresos, totalGastos: totalGastos + totalSubs, balance: totalIngresos - totalGastos - totalSubs };
}

// Total de una tarjeta: lo del ciclo en curso y lo que se va a pagar (el ciclo
// que cierra, más el interés estimado). Usa la misma lógica de ciclos y cuotas
// que la app (módulo ciclos.js, verificado por tests/ciclos.spec.js).
const INTERES_TARJETA = 0.0121;
async function calcularTotalTarjeta(userId: string, tarjetaId: number, cfg: Record<string, unknown>) {
  const [{ data: gastos }, { data: subs }] = await Promise.all([
    supabase.from('gastos').select('monto,moneda,pago,fecha,cuotas').eq('user_id', userId).eq('pago', String(tarjetaId)),
    supabase.from('suscripciones').select('monto,moneda,pago,dia').eq('user_id', userId).eq('pago', String(tarjetaId)),
  ]);
  const montoArs = (x: { monto: number | string; moneda?: string }) =>
    (x.moneda ?? 'ARS') === 'USD' ? 0 : Number(x.monto);

  const totalDeCiclo = (desde: Date, hasta: Date) => {
    let total = 0;
    for (const g of gastos ?? []) {
      if (g.cuotas) {
        const n = calcularCuotaActual(g.fecha, cfg, hasta);
        if (n >= 1 && n <= g.cuotas) total += montoArs(g);
      } else {
        const f = new Date(g.fecha + 'T00:00:00');
        if (f >= desde && f <= hasta) total += montoArs(g);
      }
    }
    for (const sub of subs ?? []) {
      // Un ciclo puede contener más de un débito de la misma suscripción.
      let anio = desde.getFullYear(), mes = desde.getMonth(), guarda = 0;
      while (guarda++ < 24) {
        const dias = new Date(anio, mes + 1, 0).getDate();
        const f = new Date(anio, mes, Math.min(sub.dia, dias));
        if (f > hasta) break;
        if (f >= desde) total += montoArs(sub);
        const sig = new Date(anio, mes + 1, 1);
        anio = sig.getFullYear(); mes = sig.getMonth();
      }
    }
    return total;
  };

  const actual = cicloActual(cfg, new Date(hoyLocal() + 'T12:00:00'));
  if (!actual) return null;
  const enCurso = totalDeCiclo(actual.desde, actual.hasta);
  return {
    desde: actual.desde,
    hasta: actual.hasta,
    enCurso,
    aPagar: Math.round(enCurso * (1 + INTERES_TARJETA)),
    proximo: totalDeCiclo(sumarMesesFecha(actual.desde, 1), sumarMesesFecha(actual.hasta, 1)),
  };
}

async function guardarGasto(
  userId: string,
  g: GastoExtraido,
  pagoId: number,
  catId: number,
) {
  const montoCuota = g.cuotas ? g.monto / g.cuotas : g.monto;
  return await supabase.from('gastos').insert({
    id: nuevoId(),
    user_id: userId,
    monto: montoCuota,
    monto_original: g.cuotas ? g.monto : null,
    cuotas: g.cuotas,
    pago: String(pagoId),
    descripcion: g.descripcion,
    cat: catId,
    fecha: hoyLocal(),
    moneda: g.moneda || 'ARS',
    es_fijo: false,
    es_reembolsable: false,
    cobrado: false,
  });
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
  const telefono: string = mensaje.from;
  if (mensaje.type !== 'text' && mensaje.type !== 'audio') {
    console.log('[wa] mensaje ignorado, tipo:', mensaje.type);
    await enviarWhatsapp(telefono, 'Por ahora entiendo mensajes de texto y audios. Probá contándome el gasto por alguna de esas dos vías.');
    return new Response('ok', { status: 200 });
  }

  const esAudio = mensaje.type === 'audio';
  const texto: string = esAudio ? '' : mensaje.text.body;
  console.log('[wa] mensaje de', telefono, esAudio ? '-> (audio)' : '-> ' + texto);

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

  const [{ data: tarjetas }, { data: categorias }, { data: config }] = await Promise.all([
    supabase.from('tarjetas').select('id,nombre').eq('user_id', whUsuario.user_id),
    supabase.from('categorias').select('id,nombre').eq('user_id', whUsuario.user_id).eq('tipo', 'gasto'),
    supabase.from('config').select('cierres').eq('user_id', whUsuario.user_id).maybeSingle(),
  ]);

  // Si quedó un gasto esperando medio de pago, este mensaje puede ser la
  // respuesta a esa pregunta.
  const { data: pendientes } = await supabase
    .from('whatsapp_pendientes')
    .select('*')
    .in('telefono', variantesTelefono(telefono));
  const pendiente = pendientes?.[0] ?? null;

  if (pendiente && !esAudio) {
    const elegida = resolverMedioElegido(texto, tarjetas ?? []);
    if (elegida) {
      const g = pendiente.gasto as GastoExtraido & { catId: number };
      const { error } = await guardarGasto(pendiente.user_id, g, elegida.id, g.catId);
      await supabase.from('whatsapp_pendientes').delete().eq('telefono', pendiente.telefono);
      if (error) {
        console.error('[wa] error guardando gasto pendiente', error.message);
        await enviarWhatsapp(telefono, 'Entendí el medio de pago pero no pude guardar el gasto. Probá de nuevo.');
        return new Response('ok', { status: 200 });
      }
      console.log('[wa] gasto pendiente cargado con', elegida.nombre);
      await enviarWhatsapp(telefono, textoConfirmacion(g, elegida.nombre));
      return new Response('ok', { status: 200 });
    }
    // No se entendió como medio de pago: puede ser un gasto nuevo. Se descarta
    // el pendiente para no dejarlo trabado y se sigue el flujo normal.
    console.log('[wa] respuesta no coincide con ningún medio, se descarta el pendiente');
    await supabase.from('whatsapp_pendientes').delete().eq('telefono', pendiente.telefono);
  }

  let entrada: string | { mimeType: string; base64: string } = texto;
  if (esAudio) {
    const audio = await bajarAudio(mensaje.audio.id);
    if (!audio) {
      await enviarWhatsapp(telefono, 'No pude descargar el audio. Probá de nuevo, o contámelo por texto.');
      return new Response('ok', { status: 200 });
    }
    entrada = audio;
  }

  const intencion = await interpretarMensaje(
    entrada,
    (categorias ?? []).map((c) => c.nombre),
    (tarjetas ?? []).map((t) => t.nombre),
  );

  console.log('[wa] intención:', JSON.stringify(intencion));

  if (!intencion || intencion.tipo === 'desconocido') {
    await enviarWhatsapp(
      telefono,
      esAudio
        ? 'No te entendí. Podés contarme un gasto ("gasté 500 en el kiosco"), un ingreso ("cobré 300 mil"), o preguntarme cuánto te queda o cuánto tenés en una tarjeta.'
        : 'No te entendí. Probá con:\n• "gasté 500 en el kiosco con débito"\n• "cobré 300 mil de sueldo"\n• "cuánta plata me queda"\n• "cuánto tengo en la Visa"',
    );
    return new Response('ok', { status: 200 });
  }

  if (intencion.tipo === 'saldo') {
    const s = await calcularSaldoDelMes(whUsuario.user_id);
    const signo = s.balance >= 0 ? 'Te queda' : 'Estás en déficit de';
    await enviarWhatsapp(
      telefono,
      `${signo} ${fmt(Math.abs(s.balance))} este mes.\n\n` +
      `Ingresos: ${fmt(s.totalIngresos)}\n` +
      `Gastos de bolsillo: ${fmt(s.totalGastos)}\n\n` +
      `_No incluye lo de tarjetas de crédito, que se paga al vencimiento._`,
    );
    return new Response('ok', { status: 200 });
  }

  if (intencion.tipo === 'tarjeta') {
    const cred = (tarjetas ?? []).filter((t) => cierresDe(config, t.id));
    const elegida = intencion.tarjeta ? encontrarPorNombre(cred, intencion.tarjeta) : null;
    if (!elegida) {
      await enviarWhatsapp(
        telefono,
        cred.length
          ? `¿De cuál tarjeta?\n${fmtLista(cred)}\n\nPreguntame por su nombre.`
          : 'No tenés tarjetas de crédito con ciclo configurado en la app.',
      );
      return new Response('ok', { status: 200 });
    }
    const t = await calcularTotalTarjeta(whUsuario.user_id, elegida.id, cierresDe(config, elegida.id)!);
    if (!t) {
      await enviarWhatsapp(telefono, `No pude calcular el ciclo de ${elegida.nombre}. Revisá que tenga cierre configurado en la app.`);
      return new Response('ok', { status: 200 });
    }
    const f = (d: Date) => d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
    await enviarWhatsapp(
      telefono,
      `*${elegida.nombre}*\nCiclo ${f(t.desde)} → ${f(t.hasta)}\n\n` +
      `Gastado en este ciclo: ${fmt(t.enCurso)}\n` +
      `A pagar (con interés est.): ${fmt(t.aPagar)}\n` +
      `Proyectado próximo ciclo: ${fmt(t.proximo)}`,
    );
    return new Response('ok', { status: 200 });
  }

  if (intencion.tipo === 'ingreso') {
    const { error } = await supabase.from('ingresos').insert({
      id: nuevoId(),
      user_id: whUsuario.user_id,
      monto: intencion.monto,
      descripcion: intencion.descripcion,
      cat: intencion.categoria,
      fecha: hoyLocal(),
      moneda: intencion.moneda || 'ARS',
    });
    if (error) {
      console.error('[wa] error insertando ingreso', error.message);
      await enviarWhatsapp(telefono, 'Entendí el ingreso pero no lo pude guardar. Probá de nuevo en un rato.');
      return new Response('ok', { status: 200 });
    }
    console.log('[wa] ingreso cargado para', whUsuario.user_id);
    await enviarWhatsapp(telefono, `✅ Ingreso cargado: ${fmt(intencion.monto)} - ${intencion.descripcion}`);
    return new Response('ok', { status: 200 });
  }

  const extraido = intencion.gasto;
  const tarjeta = encontrarPorNombre(tarjetas ?? [], extraido.medio_pago);
  const categoria = encontrarPorNombre(categorias ?? [], extraido.categoria);
  // Si no se pudo deducir la categoría, va a una categoría "Bot" para revisar
  // después desde la app, en vez de adivinar una que probablemente esté mal.
  const catId = categoria?.id ?? await idCategoriaBot(whUsuario.user_id, categorias ?? []);
  if (!catId) {
    await enviarWhatsapp(telefono, 'No pude guardar el gasto: falló al preparar la categoría. Probá de nuevo en un rato.');
    return new Response('ok', { status: 200 });
  }

  // Si no aclaró con qué pagó, no se asume: se pregunta con las opciones reales
  // y el gasto queda pendiente hasta que conteste.
  if (!tarjeta) {
    if (!(tarjetas ?? []).length) {
      await enviarWhatsapp(telefono, 'No tenés medios de pago cargados en la app. Agregá uno y volvé a intentar.');
      return new Response('ok', { status: 200 });
    }
    await supabase.from('whatsapp_pendientes').upsert({
      telefono,
      user_id: whUsuario.user_id,
      gasto: { ...extraido, catId },
      created_at: new Date().toISOString(),
    });
    console.log('[wa] falta medio de pago, gasto pendiente para', telefono);
    await enviarWhatsapp(telefono, textoPreguntaMedio(extraido, tarjetas ?? []));
    return new Response('ok', { status: 200 });
  }

  const { error: errInsert } = await guardarGasto(whUsuario.user_id, extraido, tarjeta.id, catId);

  if (errInsert) {
    console.error('[wa] error insertando gasto', errInsert.message);
    await enviarWhatsapp(telefono, 'Entendí el gasto pero no lo pude guardar. Probá de nuevo en un rato.');
    return new Response('ok', { status: 200 });
  }
  console.log('[wa] gasto cargado para', whUsuario.user_id);

  await enviarWhatsapp(telefono, textoConfirmacion(extraido, tarjeta.nombre));
  return new Response('ok', { status: 200 });
});

function fmt(n: number): string {
  return '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
