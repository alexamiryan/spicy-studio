-- Environment library: real-world location photos, per user and shared by all of that user's workspaces.
create table environments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  kind text not null default 'image',
  name text not null,
  file text not null,
  thumb text,
  mime text not null,
  width integer,
  height integer,
  created_at timestamptz not null default now()
);
create index environments_user on environments (user_id, created_at desc, id desc);

-- Using an environment in a workspace creates a workspace reference linked to it (reused next time).
alter table refs add column source_environment_id uuid references environments on delete set null;
create index refs_source_environment on refs (workspace_id, source_environment_id) where source_environment_id is not null;
