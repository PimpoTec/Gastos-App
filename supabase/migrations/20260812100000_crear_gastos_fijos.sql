create table if not exists gastos_fijos (
  id bigint primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  nombre text not null,
  monto numeric not null default 0,
  moneda text not null default 'ARS',
  dia integer,
  pago bigint,
  cat text not null default 'otro',
  created_at timestamptz not null default now()
);

alter table gastos_fijos enable row level security;

create policy "gastos_fijos_select_own" on gastos_fijos
  for select using (auth.uid() = user_id);

create policy "gastos_fijos_insert_own" on gastos_fijos
  for insert with check (auth.uid() = user_id);

create policy "gastos_fijos_update_own" on gastos_fijos
  for update using (auth.uid() = user_id);

create policy "gastos_fijos_delete_own" on gastos_fijos
  for delete using (auth.uid() = user_id);
