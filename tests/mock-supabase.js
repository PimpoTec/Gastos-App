// Mock mínimo de window.supabase para testear app.html sin un backend real.
// Uso: await page.addInitScript(mockSupabase, estadoInicial);
// estadoInicial es un objeto { tabla: [fila, ...], ... } — ver defaultState() abajo.
function mockSupabase(estadoInicial) {
  const state = estadoInicial || {};
  function chain(table) {
    let filters = [];
    const builder = {
      select: () => builder,
      eq: (col, val) => { filters.push([col, val]); return builder; },
      order: () => builder,
      maybeSingle: async () => ({ data: (state[table] || [])[0] || null, error: null }),
      upsert: async (row) => {
        const arr = state[table] || (state[table] = []);
        const idx = arr.findIndex((r) => r.id === row.id);
        if (idx >= 0) arr[idx] = row;
        else arr.push(row);
        return { data: row, error: null };
      },
      delete: () => ({
        eq: (col, val) => ({
          eq: async () => {
            state[table] = (state[table] || []).filter((r) => r[col] != val);
            return { data: null, error: null };
          },
        }),
      }),
      then: (resolve) => {
        let rows = state[table] || [];
        filters.forEach(([col, val]) => { rows = rows.filter((r) => r[col] == val); });
        resolve({ data: rows, error: null });
      },
    };
    return builder;
  }
  window.supabase = {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      from: (table) => chain(table),
    }),
  };
  window.__mockState = state;
}

// Estado mínimo para que la app arranque sin errores (usuario nuevo, sin datos).
function defaultState() {
  return {
    gastos: [], suscripciones: [], ingresos: [], suscripciones_pagos: [],
    ahorros_movimientos: [], gastos_fijos: [], tarjetas: [], categorias: [],
    proyeccion_items: [],
    config: [{
      user_id: 'u1', cierres: {}, notif_config: {}, dolar_blue: 0,
      presupuesto_mensual: 0, biometric_enabled: false, pin_hash: null, pin_salt: null,
    }],
  };
}

module.exports = { mockSupabase, defaultState };
