-- Multi-user: every workspace, provider connection, favourite and provider upload belongs to a user.
-- Existing single-user data is assigned to the existing account, which becomes the admin.
-- (On a fresh install with no users yet, the ownerless placeholder rows are removed instead.)

alter table users add column role text not null default 'user' check (role in ('admin', 'user'));
update users set role = 'admin' where id = (select id from users order by created_at limit 1);

-- Workspaces (refs, elements, folders, generations and assets are reached through them).
alter table workspaces add column user_id uuid references users on delete cascade;
update workspaces set user_id = (select id from users where role = 'admin' order by created_at limit 1);
delete from workspaces where user_id is null;
alter table workspaces alter column user_id set not null;
create index workspaces_user on workspaces (user_id, created_at);

-- Provider connections: one row per user and provider.
alter table provider_settings add column user_id uuid references users on delete cascade;
update provider_settings set user_id = (select id from users where role = 'admin' order by created_at limit 1);
delete from provider_settings where user_id is null;
alter table provider_settings alter column user_id set not null;
alter table provider_settings drop constraint provider_settings_pkey;
alter table provider_settings add primary key (user_id, provider_id);

-- Favourite models.
alter table favorite_models add column user_id uuid references users on delete cascade;
update favorite_models set user_id = (select id from users where role = 'admin' order by created_at limit 1);
delete from favorite_models where user_id is null;
alter table favorite_models alter column user_id set not null;
alter table favorite_models drop constraint favorite_models_pkey;
alter table favorite_models add primary key (user_id, model_id);

-- Files uploaded to a provider live in that user's provider account.
alter table provider_uploads add column user_id uuid references users on delete cascade;
update provider_uploads set user_id = (select id from users where role = 'admin' order by created_at limit 1);
delete from provider_uploads where user_id is null;
alter table provider_uploads alter column user_id set not null;
alter table provider_uploads drop constraint provider_uploads_pkey;
alter table provider_uploads add primary key (user_id, file, provider_id);

-- Per-user preferences, including where "Save" writes to.
create table user_settings (
  user_id uuid primary key references users on delete cascade,
  strip_metadata boolean not null default false,
  save_target jsonb,
  updated_at timestamptz not null default now()
);
insert into user_settings (user_id, strip_metadata)
select u.id, coalesce((select (value ->> 'stripMetadataOnSave')::boolean from app_state where key = 'settings'), false)
  from users u where u.role = 'admin';
