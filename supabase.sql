-- Lilen · Caja — pegar en Supabase > SQL Editor > Run

create table if not exists articulos (
  id      bigint generated always as identity primary key,
  codigo  text not null unique,
  nombre  text not null,
  precio  numeric(12,2) not null check (precio >= 0),
  activo  boolean not null default true,
  creado  timestamptz not null default now()
);

create table if not exists ventas (
  id          bigint generated always as identity primary key,
  fecha       timestamptz not null default now(),
  total       numeric(12,2) not null,
  medio_pago  text,
  items       jsonb not null,          -- [{codigo, nombre, precio, cant}]
  anulada     boolean not null default false
);

create index if not exists ventas_fecha_idx on ventas (fecha);

-- Solo usuarios logueados (las chicas de la caja) pueden leer y escribir
alter table articulos enable row level security;
alter table ventas    enable row level security;

create policy "caja articulos" on articulos for all to authenticated using (true) with check (true);
create policy "caja ventas"    on ventas    for all to authenticated using (true) with check (true);

revoke all on articulos, ventas from anon;
