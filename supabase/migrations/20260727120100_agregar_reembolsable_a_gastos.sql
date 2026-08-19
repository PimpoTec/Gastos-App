alter table gastos
  add column if not exists es_reembolsable boolean not null default false,
  add column if not exists cobrado boolean not null default false;
