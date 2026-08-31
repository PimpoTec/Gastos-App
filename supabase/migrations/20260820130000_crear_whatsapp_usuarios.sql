-- Mapea un número de WhatsApp (formato E.164 sin '+', ej: '5491122334455')
-- a un usuario de la app, para que el webhook de WhatsApp sepa a qué cuenta
-- cargarle el gasto según quién escribió.
create table if not exists whatsapp_usuarios (
  telefono text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text,
  tarjeta_default bigint,
  cat_default bigint,
  created_at timestamptz not null default now()
);

alter table whatsapp_usuarios enable row level security;

create policy "whatsapp_usuarios_select_own" on whatsapp_usuarios
  for select using (auth.uid() = user_id);

create policy "whatsapp_usuarios_update_own" on whatsapp_usuarios
  for update using (auth.uid() = user_id);

-- El insert/delete de este mapeo se hace a mano (vos como admin), no desde
-- la app, así que no hace falta política de insert/delete para usuarios.
