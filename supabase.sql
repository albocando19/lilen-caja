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

-- ===== Roles (admins ven ventas y editan artículos; la caja solo cobra) =====
create table if not exists public.admins (email text primary key);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
-- insert into public.admins (email) values ('mail-admin@gmail.com');

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

alter table public.ventas add column if not exists vendedor text default lower(auth.jwt() ->> 'email');

drop policy if exists "caja articulos" on public.articulos;
create policy "articulos leer" on public.articulos for select to authenticated using (true);
create policy "articulos crear" on public.articulos for insert to authenticated with check (true);
create policy "articulos admin update" on public.articulos for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy "articulos admin delete" on public.articulos for delete to authenticated using (public.es_admin());

drop policy if exists "caja ventas" on public.ventas;
create policy "ventas admin leer" on public.ventas for select to authenticated using (public.es_admin());
create policy "ventas admin update" on public.ventas for update to authenticated using (public.es_admin()) with check (public.es_admin());

create or replace function public.registrar_venta(p_total numeric, p_medio text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.ventas;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene artículos';
  end if;
  insert into public.ventas (total, medio_pago, items, vendedor)
  values (p_total, p_medio, p_items, lower(auth.jwt() ->> 'email'))
  returning * into v;
  return to_jsonb(v);
end;
$$;

-- ===== Resumen calculado en la base (ahorra tráfico) =====
create or replace function public.resumen_ventas(p_desde timestamptz, p_hasta timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  with v as (select * from public.ventas where fecha >= p_desde and fecha < p_hasta and not anulada),
  it as (select l ->> 'nombre' as nombre, sum((l ->> 'cant')::numeric) as u,
                sum((l ->> 'cant')::numeric * (l ->> 'precio')::numeric) as t
         from v, jsonb_array_elements(v.items) l group by 1),
  me as (select coalesce(medio_pago, '-') as medio, count(*) as n, sum(total) as t from v group by 1)
  select jsonb_build_object(
    'total', coalesce((select sum(total) from v), 0), 'cantidad', (select count(*) from v),
    'por_item', coalesce((select jsonb_agg(jsonb_build_object('nombre', nombre, 'u', u, 't', t) order by t desc) from it), '[]'::jsonb),
    'por_medio', coalesce((select jsonb_agg(jsonb_build_object('medio', medio, 'n', n, 't', t) order by t desc) from me), '[]'::jsonb));
$$;

-- ===== Ventas hechas sin internet (código único + hora real) =====
alter table public.ventas add column if not exists cliente_id uuid unique;
alter table public.ventas add column if not exists subida timestamptz default now();
drop function if exists public.registrar_venta(numeric, text, jsonb);
create or replace function public.registrar_venta(
  p_total numeric, p_medio text, p_items jsonb,
  p_cliente_id uuid default null, p_fecha timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.ventas;
begin
  if auth.uid() is null then raise exception 'No autorizado'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene artículos';
  end if;
  if p_cliente_id is not null then
    select * into v from public.ventas where cliente_id = p_cliente_id;
    if found then return to_jsonb(v); end if;
  end if;
  insert into public.ventas (total, medio_pago, items, vendedor, cliente_id, fecha)
  values (p_total, p_medio, p_items, lower(auth.jwt() ->> 'email'), p_cliente_id,
          case when p_fecha is null or p_fecha > now() or p_fecha < now() - interval '30 days' then now() else p_fecha end)
  on conflict (cliente_id) do nothing
  returning * into v;
  if v.id is null then select * into v from public.ventas where cliente_id = p_cliente_id; end if;
  return to_jsonb(v);
end;
$$;
