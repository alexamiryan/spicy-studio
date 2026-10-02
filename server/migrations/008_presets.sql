-- Named create-box states ("Mirror selfie at home", "Outdoor posing"…), per workspace and per photo/video.
create table presets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  modality text not null check (modality in ('image', 'video')),
  name text not null,
  model_id text not null,
  prompt text not null default '',
  settings jsonb not null default '{}',
  ref_slots jsonb not null default '{}',
  folder_id uuid references folders on delete set null,
  batch integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz
);
create unique index presets_name on presets (workspace_id, modality, lower(name));
