-- ============================================================================
-- Agave Cía · Esquema de base de datos (Supabase / PostgreSQL)
-- ----------------------------------------------------------------------------
-- Idempotente: se puede volver a ejecutar sin perder datos.
-- Aplícalo en: Supabase → SQL Editor → pegar y Run.
--        o con: node scripts/apply-schema.js   (usa DATABASE_URL)
--
-- Modelo: el motor de negocio vive en engine.js (JS puro); estas tablas son la
-- persistencia. Los importes se guardan como double precision / integer para
-- que vuelvan a Node como números (nunca numeric, que devuelve strings).
-- ============================================================================

-- ---------------------------------------------------------------- parámetros
-- Fila única (id=1). `rev` es el contador de revisiones: sube en CADA escritura
-- y es lo que usa el cliente para saber si sus datos en pantalla están al día.
create table if not exists settings (
  id                   smallint primary key default 1 check (id = 1),
  grados_tequila       double precision not null default 40,
  merma_hojas          double precision not null default 51,
  merma_danado         double precision not null default 20.5,
  merma_fibra          double precision not null default 12,
  merma_cortes         double precision not null default 9.1,
  merma_otros          double precision not null default 7.4,
  rev                  integer not null default 1,
  updated_at           timestamptz not null default now()
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- ----------------------------------------------------------- razones sociales
create table if not exists razones_sociales (
  id                       text primary key,
  nombre                   text not null check (length(trim(nombre)) > 0),
  corto                    text not null check (length(trim(corto)) > 0),
  coccion_perdida          double precision not null default 8,
  molienda_rendimiento     double precision not null default 60,
  conversion_mosto_alcohol double precision not null default 0.16,
  destilacion_rendimiento  double precision not null default 70,
  anejamiento_perdida      double precision not null default 2,
  preset                   text not null default 'custom'
                             check (preset in ('base','optimista','conservador','custom')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- -------------------------------------------------------------------- streams
create table if not exists streams (
  id               text primary key,
  nombre           text not null check (length(trim(nombre)) > 0),
  zona             text not null default '—',
  razon_social_id  text not null references razones_sociales(id) on delete restrict,
  objetivo_t       double precision not null check (objetivo_t > 0),
  merma_rate       double precision not null default 0.10 check (merma_rate >= 0 and merma_rate < 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists streams_razon_social_idx on streams (razon_social_id);

-- ------------------------------------------------------------------- camiones
create table if not exists camiones (
  id                    text primary key,
  stream_id             text not null references streams(id) on delete cascade,
  rs_destino_id         text references razones_sociales(id) on delete restrict,
  placa                 text,
  peso_bruto            integer,
  peso_tara             integer,
  kg                    integer not null check (kg >= 100),
  fecha_planeada        date not null,
  fecha_real            date,
  inspeccion_resultado  text check (inspeccion_resultado in ('aceptado','rechazado','parcial')),
  inspeccion_pct_pina   double precision check (inspeccion_pct_pina between 0 and 100),
  inspeccion_nota       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint camion_pesaje_coherente check (
    peso_bruto is null or peso_tara is null or peso_bruto > peso_tara
  )
);
create index if not exists camiones_stream_idx on camiones (stream_id);
create index if not exists camiones_fecha_planeada_idx on camiones (fecha_planeada);
create index if not exists camiones_rs_destino_idx on camiones (rs_destino_id);

-- ------------------------------------------------------------------- consumos
create table if not exists consumos (
  id             text primary key,
  stream_id      text not null references streams(id) on delete cascade,
  rs_destino_id  text references razones_sociales(id) on delete restrict,
  fecha          date not null,
  kg             integer not null check (kg >= 100),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists consumos_stream_idx on consumos (stream_id);
create index if not exists consumos_fecha_idx on consumos (fecha);

-- ------------------------------------------------------- órdenes de producción
create table if not exists ordenes (
  id              text primary key,
  nombre          text not null check (length(trim(nombre)) > 0),
  razon_social_id text not null references razones_sociales(id) on delete restrict,
  estado          text not null default 'planeada'
                    check (estado in ('planeada','en_proceso','terminada')),
  fecha_inicio    date not null default current_date,
  fecha_fin       date,
  agave_kg        integer not null check (agave_kg >= 100),
  tequila_real_l  double precision,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ordenes_razon_social_idx on ordenes (razon_social_id);

-- resultados reales por etapa (opcional, hasta 4 por orden)
create table if not exists orden_etapas (
  orden_id  text not null references ordenes(id) on delete cascade,
  clave     text not null check (clave in ('coccion','molienda','fermentacion','destilacion')),
  fecha     date,
  salida_kg double precision check (salida_kg >= 0),
  salida_l  double precision check (salida_l >= 0),
  nota      text,
  primary key (orden_id, clave)
);

-- ------------------------------------------------------------------- respaldos
-- Sustituye a los archivos data/backups/*.json: en Vercel no hay disco.
create table if not exists backups (
  id         text primary key,
  created_at timestamptz not null default now(),
  payload    jsonb not null
);
create index if not exists backups_created_at_idx on backups (created_at desc);

-- ============================================================================
-- Seguridad
-- ----------------------------------------------------------------------------
-- El servidor (Vercel / local) se conecta como DUEÑO de estas tablas y por eso
-- no pasa por RLS. Los roles públicos de Supabase (anon / authenticated) NO
-- deben poder tocar nada: toda la API pasa por nuestras funciones.
-- RLS activado sin políticas = nadie entra por la API REST automática.
-- ============================================================================
alter table settings          enable row level security;
alter table razones_sociales  enable row level security;
alter table streams           enable row level security;
alter table camiones          enable row level security;
alter table consumos          enable row level security;
alter table ordenes           enable row level security;
alter table orden_etapas      enable row level security;
alter table backups           enable row level security;

-- Los roles anon/authenticated solo existen en Supabase, no en un PostgreSQL
-- normal: se revocan solo si están presentes (así el script sirve en ambos).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table settings, razones_sociales, streams, camiones, consumos, ordenes, orden_etapas, backups from anon';
    execute 'revoke all on all sequences in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table settings, razones_sociales, streams, camiones, consumos, ordenes, orden_etapas, backups from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
  end if;
end $$;
