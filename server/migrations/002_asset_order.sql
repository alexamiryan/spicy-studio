-- Results are ordered by when their job was submitted, not when the file finished downloading,
-- so the timeline matches submission order (a slow job no longer jumps ahead of newer ones).
-- Outputs of one job keep their order: output 0 first.
update assets a
   set created_at = g.created_at - (a.idx * interval '1 microsecond')
  from generations g
 where g.id = a.generation_id;
