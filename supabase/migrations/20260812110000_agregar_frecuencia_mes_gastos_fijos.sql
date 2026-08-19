alter table gastos_fijos add column if not exists frecuencia text not null default 'mensual';
alter table gastos_fijos add column if not exists mes integer;
