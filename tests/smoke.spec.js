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

// La lista "Cuotas en curso" de Proyección y el monto del pago tienen que
// mirar el mismo ciclo. La lista armaba su fecha de referencia por su cuenta
// ("día N de ese mes"), así que en una tarjeta que cierra el 27 y vence el 8
// del mes siguiente mostraba las cuotas de un ciclo y cobraba las de otro.
test('la lista de cuotas de Proyección usa el mismo ciclo que el pago', async ({ page }) => {
  await page.addInitScript(mockSupabase, defaultState());
  await page.goto('/app.html');
  await page.waitForSelector('#nav-gastos', { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    cats.push({ id: 9401, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9402, nombre: 'Vence al mes siguiente', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9402] = { dia: 27, vencimiento: 8, cicloInicio: '2026-08-28', cicloCierre: '2026-09-27' };
    gastos.push({ id: 9403, desc: 'Heladera', fecha: '2026-05-15', monto: 10000,
                  moneda: 'ARS', cat: '9401', pago: '9402', cuotas: 6 });

    const oct = new Date(2026, 9, 20);
    const ciclo = cicloQuePagasEn(cierres[9402], oct);
    const enLista = cuotasEnCiclo(oct).find(g => g.id === 9403);
    return {
      cierreDelCiclo: aISO(ciclo.hasta),
      cuotaEnLista: enLista ? enLista.numCuota : null,
      cuotaSegunElCiclo: calcularCuotaActual('2026-05-15', cierres[9402], ciclo.hasta),
    };
  });

  // El ciclo que se paga en octubre cierra el 27/9, no el 27/10.
  expect(r.cierreDelCiclo).toBe('2026-09-27');
  expect(r.cuotaEnLista).toBe(r.cuotaSegunElCiclo);
  expect(r.cuotaEnLista).toBe(5); // cierres 27/5, 27/6, 27/7, 27/8 y 27/9
});

// Un gasto fijo pagado con tarjeta de crédito (ej: un seguro en débito
// automático) no puede restar dos veces: no sale de la plata en mano este
// mes (eso lo cubre "agregar pago real" cuando llega el resumen), pero sí
// tiene que sumarse al total que se debe de esa tarjeta.
test('un gasto fijo con tarjeta entra al total de la tarjeta, no al disponible en mano', async ({ page }) => {
  const r = await page.evaluate(() => {
    cats.push({ id: 9501, nombre: 'Seguros', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9502, nombre: 'Efectivo', icono: 'cash', color: '#63e6be', esTarjeta: false });
    tarjetas.push({ id: 9503, nombre: 'Visa', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9503] = { dia: 27, vencimiento: 8, cicloInicio: '2026-08-28', cicloCierre: '2026-09-27' };
    gastosFijos.push({ id: 9504, nombre: 'Seguro auto (efectivo)', monto: 20000, moneda: 'ARS',
                       dia: 10, pago: 9502, cat: 9501, frecuencia: 'mensual', mes: null });
    gastosFijos.push({ id: 9505, nombre: 'Seguro moto (tarjeta)', monto: 15000, moneda: 'ARS',
                       dia: 10, pago: 9503, cat: 9501, frecuencia: 'mensual', mes: null });

    const oct = new Date(2026, 9, 20);
    const totalTarjeta = totalCicloTarjeta(9503, oct);
    return { totalTarjeta };
  });

  // El fijo pagado con tarjeta entra al total que se debe de esa tarjeta...
  expect(r.totalTarjeta).toBe(15000);

  await page.click('#nav-balance');
  await page.click('#subtab-proyeccion');
  const texto = await page.locator('#proy-fijos-lista').innerText();
  // ...y en la lista de Proyección se ve marcado como que no resta este mes,
  // mientras que el que se paga en efectivo sí resta directo.
  expect(texto).toContain('con tarjeta, no resta este mes');
  expect(texto).toContain('-$20.000');
  expect(texto).not.toContain('-$15.000');
});

// Proyección se simplificó a un solo mes fijo (el que viene), sin navegación
// a meses pasados o futuros: eso ya lo cubre el calendario de compromiso de
// Cuotas, que sí necesita mirar varios meses adelante.
test('Proyección solo muestra el mes que viene, sin botones de navegación', async ({ page }) => {
  await page.click('#nav-balance');
  await page.click('#subtab-proyeccion');
  await expect(page.locator('#subpanel-proyeccion')).not.toContainText('Anterior');
  await expect(page.locator('#subpanel-proyeccion')).not.toContainText('Siguiente');

  const label = await page.locator('#proy-mes-label').innerText();
  const esperado = await page.evaluate(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    const l = d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    return l.charAt(0).toUpperCase() + l.slice(1);
  });
  expect(label).toBe(esperado);
});

// La cuota que Proyección muestra para el mes que viene tiene que ser
// siempre la misma que ya muestra la pestaña Cuotas (calcularCuotaActual con
// la fecha de hoy: esa YA es la cuota corriendo ahora, la que se factura en
// el próximo cierre — no hay que sumarle nada más). Antes se recalculaba
// desde cero contra el ciclo futuro (cierre + vencimiento), y en una tarjeta
// de ciclo irregular sin ese cierre confirmado todavía, eso daba una cuota
// menos que la real.
test('la cuota del mes que viene es la misma que ya muestra la pestaña Cuotas', async ({ page }) => {
  const r = await page.evaluate(() => {
    cats.push({ id: 9601, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9602, nombre: 'Ciclo largo', icono: 'card', color: '#cc5de8', esTarjeta: true });
    // Ciclo irregular de más de dos meses, sin ningún cierre confirmado en
    // el medio (el caso real: "empezó el 28 de julio y cierra el 1 de octubre").
    cierres[9602] = { dia: 1, vencimiento: 4, cicloInicio: '2026-07-28', cicloCierre: '2026-10-01' };
    gastos.push({ id: 9603, desc: 'Compra vieja', fecha: '2026-05-11', monto: 6000,
                  moneda: 'ARS', cat: 9601, pago: 9602, cuotas: 6 });

    const actualHoy = calcularCuotaActual('2026-05-11', cierres[9602]);
    const enProximoMes = cuotasProximoMes().find(g => g.id === 9603);
    return { actualHoy, numCuota: enProximoMes ? enProximoMes.numCuota : null };
  });

  expect(r.numCuota).toBe(r.actualHoy);
});

// Regresión puntual: una compra que está en su ÚLTIMA cuota tiene que seguir
// entrando en el total de "Agregar pago real" del mes que viene (todavía se
// está pagando). Sumarle uno a la cuota actual la excluía por completo
// (numCuota terminaba siendo cuotas+1, mayor a cuotas), lo que hacía que el
// total de la tarjeta en Proyección diera muy por debajo del real.
test('una compra en su última cuota entra en el total de la tarjeta del mes que viene', async ({ page }) => {
  const r = await page.evaluate(() => {
    cats.push({ id: 9701, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9702, nombre: 'Con última cuota', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9702] = { dia: 27, vencimiento: 8, cicloInicio: '2026-08-28', cicloCierre: '2026-09-27' };
    // Compra vieja de sobra para que, sea cual sea "hoy", ya haya cruzado
    // varios cierres. Le ponemos como total de cuotas exactamente la que
    // está corriendo ahora mismo, para que hoy sea justo su ÚLTIMA cuota
    // (el caso que el bug del "+1" rompía: quedaba afuera del total).
    const fecha = '2020-01-15';
    const actual = calcularCuotaActual(fecha, cierres[9702]);
    gastos.push({ id: 9703, desc: 'Termina ahora', fecha, monto: 12000,
                  moneda: 'ARS', cat: 9701, pago: 9702, cuotas: actual });

    const oct = new Date(2026, 9, 20);
    return { total: totalCicloTarjeta(9702, oct) };
  });

  expect(r.total).toBe(12000);
});

// El botón "Actualizar pago real" tiene que seguir sumando los gastos de
// pago único del ciclo vigente (no solo cuotas y subs) — eso no cambió.
test('el pago real de la tarjeta incluye los gastos de pago único del ciclo vigente', async ({ page }) => {
  const total = await page.evaluate(() => {
    cats.push({ id: 9801, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9802, nombre: 'Visa Suelta', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9802] = { dia: 1, vencimiento: 4, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01' };
    gastos.push({ id: 9803, desc: 'Compra suelta grande', fecha: '2026-09-08', monto: 500000,
                  moneda: 'ARS', cat: 9801, pago: 9802, cuotas: null });
    const oct = new Date(2026, 9, 20);
    return totalCicloTarjeta(9802, oct);
  });
  expect(total).toBe(500000);
});

// El número grande junto a cada tarjeta NO es el pago real: es lo que se
// viene DESPUÉS de ese pago (el resumen siguiente). Un gasto suelto del
// ciclo que está por cerrar no tiene que aparecer ahí (ese ya está en el
// pago real, abajo); uno cargado con fecha del ciclo siguiente sí.
test('el número grande de la tarjeta muestra el resumen siguiente, no el pago real', async ({ page }) => {
  await page.evaluate(() => {
    cats.push({ id: 9811, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9812, nombre: 'Visa Adelanto', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9812] = { dia: 1, vencimiento: 4, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01' };
    // Del ciclo que está por cerrar (28/8 al 1/10): no debería aparecer en
    // el número grande, ya lo cuenta el pago real.
    gastos.push({ id: 9813, desc: 'Del ciclo que ya está por cerrar', fecha: '2026-09-08', monto: 111000,
                  moneda: 'ARS', cat: 9811, pago: 9812, cuotas: null });
    // Ya cargado con fecha del ciclo siguiente (2/10 en adelante): tiene que
    // aparecer en el número grande.
    gastos.push({ id: 9814, desc: 'Ya cargado para el ciclo que viene', fecha: '2026-10-15', monto: 77000,
                  moneda: 'ARS', cat: 9811, pago: 9812, cuotas: null });
  });

  await page.click('#nav-balance');
  await page.click('#subtab-proyeccion');
  const fila = page.locator('.pago-row', { hasText: 'Visa Adelanto' });
  const montoGrande = await fila.locator('.monto-grande').innerText();
  expect(montoGrande).toBe('$77.000');
});

// Caso real reportado: cicloVencimiento quedó pegado a un ciclo viejo (un
// mes antes de cicloCierre) porque el cierre avanzó al siguiente sin que el
// usuario volviera a cargar el vencimiento. Con ese offset negativo,
// cicloQuePagasEn saltaba un ciclo entero hacia adelante (y encima devolvía
// un "vence" anterior a su propio "cierre", que es imposible), perdiendo
// todos los gastos del ciclo real.
test('un cicloVencimiento de un mes anterior al cierre no corre la ventana un ciclo de más', async ({ page }) => {
  const r = await page.evaluate(() => {
    const cfg = {
      dia: 1, vencimiento: 4, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01',
      cicloVencimiento: '2026-09-04', // quedó del ciclo anterior, ya no corresponde
    };
    const mesPago = new Date(2026, 9, 20); // objetivo: octubre
    const ciclo = cicloQuePagasEn(cfg, mesPago);
    return ciclo && { desde: aISO(ciclo.desde), hasta: aISO(ciclo.hasta), vence: aISO(ciclo.vence) };
  });

  // Tiene que quedarse en el ciclo real (el que ya está cerrando el 1/10),
  // no saltar al siguiente (2/10 al 1/11).
  expect(r).toEqual({ desde: '2026-08-28', hasta: '2026-10-01', vence: '2026-10-04' });
});

// El pago de la tarjeta tiene que restar del disponible solo, sin que el
// usuario tenga que tocar "Agregar pago real": apenas hay algo que cobrar
// y todavía no está cargado este mes, se agrega como gasto planeado.
test('el pago de la tarjeta se agrega solo al disponible, sin tocar ningún botón', async ({ page }) => {
  await page.evaluate(() => {
    cats.push({ id: 9901, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9902, nombre: 'Visa Auto', icono: 'card', color: '#cc5de8', esTarjeta: true });
    cierres[9902] = { dia: 1, vencimiento: 4, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01' };
    gastos.push({ id: 9903, desc: 'Compra suelta', fecha: '2026-09-08', monto: 100000,
                  moneda: 'ARS', cat: 9901, pago: 9902, cuotas: null });
  });

  await page.click('#nav-balance');
  await page.click('#subtab-proyeccion');
  // Se agrega de forma asincrónica (hay un guardado a Supabase de por medio).
  await page.waitForFunction(() =>
    proyeccionItems.some(p => p.tipo === 'gasto' && p.desc === 'Pago tarjeta Visa Auto'));

  const texto = await page.locator('#proy-gastos-lista').innerText();
  expect(texto).toContain('Pago tarjeta Visa Auto');
  const disponible = await page.evaluate(() => {
    const item = proyeccionItems.find(p => p.desc === 'Pago tarjeta Visa Auto');
    return item.monto;
  });
  expect(disponible).toBeGreaterThanOrEqual(100000); // incluye interés estimado
});

// Tocar la fila de un medio de pago en Proyección tiene que abrir el
// detalle con únicamente lo cargado con ESE medio (cuotas, subs, fijos y
// gastos sueltos), no mezclado con lo de otras tarjetas.
test('tocar una tarjeta en Proyección muestra solo sus propios movimientos', async ({ page }) => {
  await page.evaluate(() => {
    cats.push({ id: 9921, nombre: 'Compras', icono: 'box', color: '#748ffc', tipo: 'gasto' });
    tarjetas.push({ id: 9922, nombre: 'Visa Detalle', icono: 'card', color: '#cc5de8', esTarjeta: true });
    tarjetas.push({ id: 9923, nombre: 'Otra Tarjeta', icono: 'card', color: '#51cf66', esTarjeta: true });
    cierres[9922] = { dia: 1, vencimiento: 4, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01' };
    cierres[9923] = { dia: 1, vencimiento: 4, cicloInicio: '2026-08-28', cicloCierre: '2026-10-01' };
    gastos.push({ id: 9924, desc: 'Zapatillas mías', fecha: '2026-08-30', monto: 60000,
                  moneda: 'ARS', cat: 9921, pago: 9922, cuotas: null });
    gastos.push({ id: 9925, desc: 'Compra de la otra tarjeta', fecha: '2026-08-30', monto: 90000,
                  moneda: 'ARS', cat: 9921, pago: 9923, cuotas: null });
  });

  await page.click('#nav-balance');
  await page.click('#subtab-proyeccion');
  const fila = page.locator('.pago-row', { hasText: 'Visa Detalle' }).locator('.row-top');
  await fila.click();
  await expect(page.locator('#modal-detalle-medio')).toHaveClass(/open/);
  await expect(page.locator('#detalle-medio-titulo')).toHaveText('Visa Detalle');
  const texto = await page.locator('#detalle-medio-cont').innerText();
  expect(texto).toContain('Zapatillas mías');
  expect(texto).not.toContain('Compra de la otra tarjeta');
});
