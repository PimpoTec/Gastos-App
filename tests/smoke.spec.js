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
