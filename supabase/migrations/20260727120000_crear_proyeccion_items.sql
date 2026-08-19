create table proyeccion_items (
  id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  mes text not null,
  tipo text not null check (tipo in ('ingreso','gasto')),
  descripcion text,
  monto numeric not null,
  moneda text not null default 'ARS',
  es_tarjeta boolean not null default false,
  created_at timestamptz not null default now()
);

alter table proyeccion_items enable row level security;

create policy "proyeccion_items_select_own" on proyeccion_items
  for select using (auth.uid() = user_id);

create policy "proyeccion_items_insert_own" on proyeccion_items
  for insert with check (auth.uid() = user_id);

create policy "proyeccion_items_update_own" on proyeccion_items
  for update using (auth.uid() = user_id);

create policy "proyeccion_items_delete_own" on proyeccion_items
  for delete using (auth.uid() = user_id);
