-- Idempotency for agents: a key the client sends with generate; repeating a call with the same key (same agent key)
-- returns the generations it already started instead of paying for new ones.
alter table generations add column client_key text;
create index generations_client_key on generations (api_token_id, client_key) where client_key is not null;
