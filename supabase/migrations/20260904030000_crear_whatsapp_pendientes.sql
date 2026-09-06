-- Guarda un gasto interpretado a medias mientras el bot le pregunta al usuario
-- el medio de pago. Es estado efímero de la conversación: hay a lo sumo uno por
-- número, y se borra apenas se resuelve.
create table if not exists whatsapp_pendientes (
  telefono text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  gasto jsonb not null,
  created_at timestamptz not null default now()
);

alter table whatsapp_pendientes enable row level security;

-- Solo la Edge Function (service role) toca esta tabla; el service role saltea
-- RLS, así que no hacen falta políticas para usuarios finales.
