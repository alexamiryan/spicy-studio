-- First-run setup wizard: when the user finished (or skipped) it. Everyone who has signed in before has
-- already set things up, so they never see it; accounts that never signed in get it on their first visit.
alter table user_settings add column onboarded_at timestamptz;
update user_settings set onboarded_at = now() where user_id in (select distinct user_id from sessions);
