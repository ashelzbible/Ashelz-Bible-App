alter table status_updates drop constraint if exists status_updates_kind_check;
alter table status_updates add constraint status_updates_kind_check check (kind in ('text','image','video','voice'));
alter table status_updates add column font smallint not null default 0 check (font between 0 and 7);
