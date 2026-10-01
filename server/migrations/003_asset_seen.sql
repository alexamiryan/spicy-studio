-- When a result was first opened in the viewer; unseen results are outlined in the grid.
alter table assets add column seen_at timestamptz;
-- Everything that already exists counts as seen.
update assets set seen_at = now();
