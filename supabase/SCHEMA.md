# Esquema de la base (referencia)

Este documento describe las tablas que usa `app.html`, reconstruidas leyendo el
código (las llamadas `sb.from('tabla').select/upsert(...)`), no a partir de las
migraciones originales que las crearon — esas se perdieron con el tiempo,
antes de que este repo tuviera una carpeta `supabase/migrations/`.

**Es una referencia, no la fuente de verdad.** Si necesitás el esquema exacto
(tipos, defaults, constraints), consultalo en el dashboard de Supabase del
proyecto real (`rujgpkiuhofndbmcntuj`). Las migraciones en
`supabase/migrations/` sí son SQL real que se aplicó (o hay que aplicar) tal
cual está escrito ahí.

Todas las tablas de usuario tienen `user_id uuid references auth.users` y RLS
con 4 políticas (select/insert/update/delete filtrando `auth.uid() = user_id`),
siguiendo el mismo patrón que las migraciones nuevas.

## Tablas pre-existentes (antes de este historial de migraciones)

- **gastos** — `id, user_id, monto, monto_original, cuotas, pago, descripcion,
  cat, fecha, moneda, es_fijo, es_reembolsable, cobrado`
- **suscripciones** — `id, user_id, nombre, monto, pago, dia, cat, moneda`
- **suscripciones_pagos** — `user_id, sub_id, mes, anio, pagado, fecha_pago`
  (unique constraint implícito en `user_id, sub_id, mes, anio` — se usa como
  `onConflict` en los upsert)
- **ingresos** — `id, user_id, monto, descripcion, cat, fecha, moneda`
- **ahorros_movimientos** — `id, user_id, monto, tipo, descripcion, fecha`
- **tarjetas** — `id, user_id, nombre, icono, color, es_tarjeta, created_at`
- **categorias** — `id, user_id, nombre, icono, color, tipo, created_at`
- **config** — fila única por usuario (`user_id` como PK o unique):
  `cierres` (jsonb), `notif_config` (jsonb), `dolar_blue`, `dolar_updated`,
  `presupuesto_mensual`, `biometric_enabled`, `pin_hash`, `pin_salt`,
  `updated_at`
- **dispositivos** — `user_id` (unique, usado como `onConflict`),
  `subscription` (jsonb, el objeto de suscripción push del navegador)

## Tablas con migración versionada (ver `supabase/migrations/`)

- **proyeccion_items**
- **gastos_fijos**
- Columnas agregadas a `gastos`: `es_reembolsable`, `cobrado`

## De acá en adelante

Cualquier cambio de esquema nuevo debería sumarse como un archivo en
`supabase/migrations/` (formato `YYYYMMDDHHMMSS_descripcion.sql`), no mandarse
solo por chat — así queda un historial real en el repo.
