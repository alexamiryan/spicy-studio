create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users on delete cascade,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- credentials: secrets (API keys, OAuth tokens). state: non-secret provider data (OAuth client registration, etc).
create table provider_settings (
  provider_id text primary key,
  credentials jsonb not null default '{}',
  state jsonb not null default '{}',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table favorite_models (
  model_id text primary key,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  image_export_dir text not null,
  video_export_dir text not null,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create unique index folders_name on folders (workspace_id, lower(name));

create table refs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  kind text not null check (kind in ('image', 'video', 'audio')),
  name text not null,
  file text not null,
  thumb text,
  mime text not null,
  width int,
  height int,
  is_model_ref boolean not null default false,
  source_asset_id uuid,
  created_at timestamptz not null default now()
);
create index refs_ws on refs (workspace_id, created_at desc, id desc);

-- Provider-side copies of local files, keyed by content hash so identical files upload once.
create table provider_uploads (
  file text not null,
  provider_id text not null,
  uri text not null,
  expires_at timestamptz,
  primary key (file, provider_id)
);

create table elements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);
create unique index elements_name on elements (workspace_id, lower(name));

create table element_refs (
  element_id uuid not null references elements on delete cascade,
  ref_id uuid not null references refs on delete cascade,
  position int not null,
  primary key (element_id, ref_id)
);

create table generations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  folder_id uuid references folders on delete set null,
  provider_id text not null,
  model_id text not null,
  model_name text not null,
  modality text not null check (modality in ('image', 'video')),
  prompt text not null default '',
  settings jsonb not null default '{}',
  ref_slots jsonb not null default '{}',
  batch_group uuid not null,
  batch_size int not null default 1,
  resolved_input jsonb,
  status text not null,
  error text,
  task_id text,
  idempotency_key text not null,
  estimated_cost numeric,
  cost numeric,
  cost_unit text,
  poll_count int not null default 0,
  next_poll_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index generations_ws on generations (workspace_id, created_at desc, id desc);
create index generations_active on generations (next_poll_at) where status in ('pending', 'queued', 'running', 'saving');

create table assets (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references generations on delete cascade,
  workspace_id uuid not null references workspaces on delete cascade,
  folder_id uuid references folders on delete set null,
  idx int not null,
  kind text not null,
  file text not null,
  thumb text,
  mime text not null,
  width int,
  height int,
  duration numeric,
  remote_ref text,
  exported_paths jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (generation_id, idx)
);
create index assets_ws on assets (workspace_id, created_at desc, id desc);
create index assets_ws_kind on assets (workspace_id, kind, created_at desc, id desc);
create index assets_folder on assets (folder_id, created_at desc, id desc);

create table app_state (
  key text primary key,
  value jsonb not null
);
