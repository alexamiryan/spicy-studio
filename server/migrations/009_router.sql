-- Auto router: the model families a user picked ("Seedream 4.5" → cheapest provider) and credit values.
alter table user_settings add column router jsonb not null default '{}';
