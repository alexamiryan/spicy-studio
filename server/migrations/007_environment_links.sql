-- References made from (or moved to) the environment library keep their link even after the environment
-- is deleted or moved out, so they stay out of the workspace's own reference lists while elements and
-- past generations that use them keep working.
alter table refs drop constraint if exists refs_source_environment_id_fkey;
