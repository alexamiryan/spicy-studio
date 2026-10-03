-- API tokens for agents (MCP): one per agent, acting as its user, with switchable permissions and an
-- optional workspace allowlist (null = all workspaces). Only a sha256 of the token is stored.
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  last4 text not null,
  perms text[] not null default '{}',
  workspace_ids uuid[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index api_tokens_user on api_tokens (user_id, created_at);

-- Which agent made a generation. No foreign key on purpose: revoking a token keeps the history.
alter table generations add column api_token_id uuid;
