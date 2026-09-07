// Compara la lógica de ciclos/cuotas del módulo del bot
// (supabase/functions/whatsapp-webhook/ciclos.js) contra la de app.html.
//
// Son dos copias de las mismas funciones, en dos runtimes distintos (Deno y el
// browser), y no hay forma simple de compartir el archivo. Este test es la red:
// si alguien toca una y no la otra, acá salta. Los totales de tarjeta del bot
// tienen que coincidir con los que ve el usuario en la app.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { mockSupabase, defaultState } = require('./mock-supabase');

const CFGS = [
  // Ciclo con fechas reales que cruza meses (el caso que rompía todo).
  { nombre: 'ciclo 28/8 → 1/10', cfg: { dia: 1, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01' } },
  // Ciclo mensual clásico.
  { nombre: 'ciclo mensual día 27', cfg: { dia: 27, cicloInicio: '2026-08-28', cicloCierre: '2026-09-27' } },
  // Config vieja, sin fechas de ciclo (solo día del mes).
  { nombre: 'config vieja día 20', cfg: { dia: 20 } },
  // Día 31: el que desbordaba al mes siguiente en los meses de 30.
  { nombre: 'cierre día 31', cfg: { dia: 31, cicloInicio: '2026-08-01', cicloCierre: '2026-08-31' } },
];

const COMPRAS = ['2026-08-29', '2026-01-15', '2025-11-04', '2026-05-23', '2026-02-27'];
const REFERENCIAS = ['2026-09-15', '2026-10-01', '2026-10-02', '2026-11-05', '2027-01-31'];

test('la lógica de ciclos del bot coincide con la de la app', async ({ page }) => {
  await page.addInitScript(mockSupabase, defaultState());
  await page.goto('/app.html');
  await page.waitForSelector('#nav-gastos', { state: 'visible', timeout: 10000 });

  // Resultados según app.html, evaluados dentro de la página.
  const enLaApp = await page.evaluate(({ cfgs, compras, refs }) => {
    const out = [];
    for (const { cfg } of cfgs) {
      for (const ref of refs) {
        const r = new Date(ref + 'T12:00:00');
        const ciclo = cicloActual(cfg, r);
        out.push({
          clave: `ciclo|${cfg.dia}|${cfg.cicloCierre || '-'}|${ref}`,
          valor: ciclo ? `${aISO(ciclo.desde)}..${aISO(ciclo.hasta)}|${ciclo.pendiente}` : null,
        });
        for (const compra of compras) {
          out.push({
            clave: `cuota|${cfg.dia}|${cfg.cicloCierre || '-'}|${compra}|${ref}`,
            valor: String(calcularCuotaActual(compra, cfg, r)),
          });
        }
      }
    }
    return out;
  }, { cfgs: CFGS, compras: COMPRAS, refs: REFERENCIAS });

  // Los mismos casos con el módulo que usa el bot.
  const m = await import(
    path.join(__dirname, '..', 'supabase', 'functions', 'whatsapp-webhook', 'ciclos.js')
  );
  const enElBot = [];
  for (const { cfg } of CFGS) {
    for (const ref of REFERENCIAS) {
      const r = new Date(ref + 'T12:00:00');
      const ciclo = m.cicloActual(cfg, r);
      enElBot.push({
        clave: `ciclo|${cfg.dia}|${cfg.cicloCierre || '-'}|${ref}`,
        valor: ciclo ? `${m.aISO(ciclo.desde)}..${m.aISO(ciclo.hasta)}|${ciclo.pendiente}` : null,
      });
      for (const compra of COMPRAS) {
        enElBot.push({
          clave: `cuota|${cfg.dia}|${cfg.cicloCierre || '-'}|${compra}|${ref}`,
          valor: String(m.calcularCuotaActual(compra, cfg, r)),
        });
      }
    }
  }

  expect(enElBot.length).toBeGreaterThan(50); // que realmente esté comparando algo
  expect(enElBot).toEqual(enLaApp);
});
