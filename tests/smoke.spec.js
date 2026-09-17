// Smoke test: cubre que la app carga, la navegación principal funciona
// (incluida la fusión Recurrentes=Subs+Fijos y Balance=Balance+Proyección)
// y se puede cargar un gasto de punta a punta. No reemplaza pruebas
// específicas de cada feature, pero evita que un cambio rompa lo básico.
const { test, expect } = require('@playwright/test');
const { mockSupabase, defaultState } = require('./mock-supabase');

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (err) => { throw err; });
  await page.addInitScript(mockSupabase, defaultState());
  await page.goto('/app.html');
  await page.waitForSelector('#nav-gastos', { state: 'visible', timeout: 10000 });
  // La app abre modales de bienvenida/recordatorio con setTimeout (hasta 1200ms
  // después de cargar). Hay que esperarlos antes de cerrarlos, si no se vuelven
  // a abrir en medio del test y tapan los clicks.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.remove('open'));
  });
});

test('la barra de navegación tiene 4 destinos', async ({ page }) => {
  const textos = await page.locator('.bottom-nav .nav-btn').allTextContents();
  expect(textos.map((t) => t.trim())).toEqual(['Gastos', 'Cuotas', 'Recurrentes', 'Balance']);
});

test('Recurrentes alterna entre Suscripciones y Otros fijos', async ({ page }) => {
  await page.click('#nav-recurrentes');
  await expect(page.locator('#subpanel-subs')).toBeVisible();
  await expect(page.locator('#header-hero-subs')).toBeVisible();

  await page.click('#subtab-fijos');
  await expect(page.locator('#subpanel-fijos')).toBeVisible();
  await expect(page.locator('#header-hero-fijos')).toBeVisible();
  // El botón + flotante no aplica en Otros fijos (tiene su propio botón "+ Agregar").
  await expect(page.locator('#fab-btn')).toBeHidden();
});

test('Balance alterna entre Este mes y Proyección', async ({ page }) => {
  await page.click('#nav-balance');
  await expect(page.locator('#subpanel-balance')).toBeVisible();

  await page.click('#subtab-proyeccion');
  await expect(page.locator('#subpanel-proyeccion')).toBeVisible();
  await expect(page.locator('#fab-btn')).toBeHidden();
});

test('se puede cargar un gasto completo de punta a punta', async ({ page }) => {
  // Necesita al menos una categoría y un medio de pago configurados.
  await page.evaluate(() => {
    cats.push({ id: 9001, nombre: 'Comida', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9002, nombre: 'Efectivo', icono: 'cash', color: '#63e6be', esTarjeta: false });
  });

  await page.evaluate(() => openModalGasto());
  await page.fill('#g-monto', '1500');
  await page.fill('#g-desc', 'Almuerzo');
  await page.click('#g-pago-chips .pago-chip >> nth=0');
  await page.click('#g-cat-chips .cat-chip >> nth=0');
  await page.click('#btn-save-gasto');

  await expect(page.locator('#modal-gasto')).not.toHaveClass(/open/);
  const gastosGuardados = await page.evaluate(() => gastos.length);
  expect(gastosGuardados).toBe(1);
  await expect(page.locator('#feed-list, .content')).toContainText('Almuerzo');
});

test('no se puede guardar un gasto sin categoría', async ({ page }) => {
  await page.evaluate(() => {
    tarjetas.push({ id: 9003, nombre: 'Efectivo', icono: 'cash', color: '#63e6be', esTarjeta: false });
  });
  await page.evaluate(() => openModalGasto());
  await page.fill('#g-monto', '500');
  await page.fill('#g-desc', 'Test');
  await page.click('#g-pago-chips .pago-chip >> nth=0');
  await page.click('#btn-save-gasto');

  await expect(page.locator('#modal-gasto')).toHaveClass(/open/);
  const gastosGuardados = await page.evaluate(() => gastos.length);
  expect(gastosGuardados).toBe(0);
});

test('los gastos sin categoría del bot aparecen para reasignar', async ({ page }) => {
  await page.evaluate(() => {
    cats.push({ id: 9101, nombre: 'Bot', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    cats.push({ id: 9102, nombre: 'Comida', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9103, nombre: 'Efectivo', icono: 'cash', color: '#63e6be', esTarjeta: false });
    gastos.push({
      id: 9104, monto: 500, montoOriginal: null, cuotas: null, pago: '9103',
      desc: 'coto', cat: 9101, fecha: '2026-09-06', moneda: 'ARS', esFijo: false,
      esReembolsable: false, cobrado: false,
    });
    renderSinCategoria();
  });

  const banner = page.locator('#sin-categoria-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('1 gasto sin categoría');

  // Colapsada por defecto; al tocarla se despliega y muestra el gasto.
  await expect(page.locator('#sin-categoria-list')).toHaveClass(/collapsible-hidden/);
  await banner.click();
  await expect(page.locator('#sin-categoria-list')).not.toHaveClass(/collapsible-hidden/);
  await expect(page.locator('#sin-categoria-list')).toContainText('coto');

  // Un gasto con categoría normal no debe aparecer acá.
  await page.evaluate(() => {
    gastos.push({
      id: 9105, monto: 800, montoOriginal: null, cuotas: null, pago: '9103',
      desc: 'almuerzo', cat: 9102, fecha: '2026-09-06', moneda: 'ARS', esFijo: false,
      esReembolsable: false, cobrado: false,
    });
    renderSinCategoria();
  });
  await expect(page.locator('#sin-categoria-banner')).toContainText('1 gasto sin categoría');
  await expect(page.locator('#sin-categoria-list')).not.toContainText('almuerzo');
});

// Prepara una tarjeta con ciclo configurado y compras en cuotas de distinta
// duración, para ejercitar el calendario de compromiso y el simulador.
async function sembrarCuotas(page) {
  await page.evaluate(() => {
    const hoy = new Date();
    const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    cats.push({ id: 9201, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9202, nombre: 'Visa Test', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9202] = {
      dia: 20,
      cicloInicio: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 21)),
      cicloCierre: iso(new Date(hoy.getFullYear(), hoy.getMonth(), 20)),
    };
    // Una de 3 cuotas (termina pronto) y otra de 12 (sigue mucho tiempo).
    gastos.push({
      id: 9203, monto: 10000, montoOriginal: 30000, cuotas: 3, pago: '9202',
      desc: 'Corta', cat: 9201, fecha: iso(hoy), moneda: 'ARS', esFijo: false,
      esReembolsable: false, cobrado: false,
    });
    gastos.push({
      id: 9204, monto: 5000, montoOriginal: 60000, cuotas: 12, pago: '9202',
      desc: 'Larga', cat: 9201, fecha: iso(hoy), moneda: 'ARS', esFijo: false,
      esReembolsable: false, cobrado: false,
    });
  });
}

test('el calendario muestra el compromiso mes a mes y detecta cuándo baja', async ({ page }) => {
  await sembrarCuotas(page);

  const meses = await page.evaluate(() => compromisoPorMes(6).map((m) => m.total));
  // Los primeros meses pagan las dos cuotas (15000); cuando termina la de 3,
  // queda solo la de 12 (5000).
  expect(meses[0]).toBe(15000);
  expect(meses[meses.length - 1]).toBe(5000);
  expect(meses[meses.length - 1]).toBeLessThan(meses[0]);

  await page.evaluate(() => renderCalendarioCuotas());
  const cal = page.locator('#cu-calendario');
  await expect(cal).toContainText('Compromiso mes a mes');
  await expect(cal).toContainText('tu compromiso baja');
});

test('el simulador suma la compra al compromiso ya existente', async ({ page }) => {
  await sembrarCuotas(page);

  const { base, con } = await page.evaluate(() => ({
    base: compromisoPorMes(6).map((m) => m.total),
    con: compromisoPorMes(6, { monto: 60000, cuotas: 6 }).map((m) => m.total),
  }));
  // La compra simulada agrega 10000 por mes durante 6 meses, sin tocar la base.
  for (let i = 0; i < 6; i++) expect(con[i]).toBe(base[i] + 10000);

  await page.evaluate(() => abrirSimulador());
  await expect(page.locator('#modal-simulador')).toHaveClass(/open/);
  // Sin monto no simula nada.
  await expect(page.locator('#sim-resultado')).toContainText('Poné un monto');

  await page.fill('#sim-monto', '60000');
  await page.fill('#sim-cuotas', '6');
  const res = page.locator('#sim-resultado');
  await expect(res).toContainText('Cada mes vas a pagar');
  await expect(res).toContainText('$10.000');
  await expect(res).toContainText('durante 6 meses');
});

// Config real de una tarjeta del usuario: cierra el 10 y vence el 18 del MISMO
// mes, así que el ciclo que cierra en octubre se paga en octubre. La regla
// "se paga el mes siguiente al cierre" la dejaba un ciclo atrasada.
test('Proyección usa el ciclo que vence en el mes, no el que cerró antes', async ({ page }) => {
  const visto = await page.evaluate(() => {
    const cfg = { dia: 10, vencimiento: 18, cicloInicio: '2026-09-11', cicloCierre: '2026-10-10' };
    const oct = new Date(2026, 9, 20);
    const nov = new Date(2026, 10, 20);
    const c1 = cicloQuePagasEn(cfg, oct);
    const c2 = cicloQuePagasEn(cfg, nov);
    return {
      pagaEnOctubre: aISO(c1.desde) + '..' + aISO(c1.hasta) + ' vence ' + aISO(c1.vence),
      pagaEnNoviembre: aISO(c2.desde) + '..' + aISO(c2.hasta) + ' vence ' + aISO(c2.vence),
    };
  });
  // Lo que se paga en octubre es el ciclo que cierra el 10/10 (vence 18/10),
  // no el que cerró el 10/9.
  expect(visto.pagaEnOctubre).toBe('2026-09-11..2026-10-10 vence 2026-10-18');
  expect(visto.pagaEnNoviembre).toBe('2026-10-11..2026-11-10 vence 2026-11-18');
});

// La otra tarjeta del usuario: cierra el 27 y vence el 8, o sea al mes
// siguiente. Acá sí el ciclo que cierra en agosto se paga en septiembre.
test('una tarjeta que vence al mes siguiente se paga al mes siguiente', async ({ page }) => {
  const visto = await page.evaluate(() => {
    const cfg = { dia: 27, vencimiento: 8, cicloInicio: '2026-08-28', cicloCierre: '2026-09-27' };
    const c = cicloQuePagasEn(cfg, new Date(2026, 9, 20)); // octubre
    return aISO(c.desde) + '..' + aISO(c.hasta) + ' vence ' + aISO(c.vence);
  });
  expect(visto).toBe('2026-08-28..2026-09-27 vence 2026-10-08');
});

test('Proyección y el dashboard miden el mismo ciclo', async ({ page }) => {
  // Ciclo irregular (arranca el 28, cierra el 1 del mes subsiguiente): es el
  // caso donde Proyección recalculaba la ventana por su cuenta y no coincidía.
  await page.evaluate(() => {
    const hoy = new Date();
    const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    cats.push({ id: 9301, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9302, nombre: 'Irregular', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9302] = {
      dia: 1,
      vencimiento: 10,
      cicloInicio: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 28)),
      cicloCierre: iso(new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1)),
    };
    // Un gasto de pago único justo en el tramo que Proyección se comía
    // (entre el 28 del mes pasado y el 1 de este).
    gastos.push({
      id: 9303, monto: 77000, montoOriginal: null, cuotas: null, pago: '9302',
      desc: 'En el tramo perdido', cat: 9301,
      fecha: iso(new Date(hoy.getFullYear(), hoy.getMonth() - 1, 29)),
      moneda: 'ARS', esFijo: false, esReembolsable: false, cobrado: false,
    });
  });

  const { ventanaDash, ventanaProy, totalDash, totalProy } = await page.evaluate(() => {
    const cfg = cierres[9302];
    const ciclo = cicloActual(cfg);
    // El mes en que vence este ciclo es el mes en que se paga.
    const mesPago = vencimientoDeCiclo(cfg, ciclo.hasta);
    const delMes = cicloQuePagasEn(cfg, mesPago);
    const { ars } = getGastosPeriodoActual(9302, gastos);
    return {
      ventanaDash: aISO(ciclo.desde) + '..' + aISO(ciclo.hasta),
      ventanaProy: aISO(delMes.desde) + '..' + aISO(delMes.hasta),
      totalDash: ars,
      totalProy: totalCicloTarjeta(9302, mesPago),
    };
  });

  // El ciclo que se paga en el mes de su vencimiento es el mismo que ve el
  // dashboard, con los mismos gastos adentro.
  expect(ventanaProy).toBe(ventanaDash);
  expect(totalProy).toBe(totalDash);
  expect(totalDash).toBe(77000); // el gasto del tramo sí entra en los dos
});
