create table music_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  media_id uuid not null references media_assets(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  artist text not null default '' check (char_length(artist) <= 120),
  mood text not null default '' check (char_length(mood) <= 40),
  genre text not null default '' check (char_length(genre) <= 40),
  starred boolean not null default false,
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index music_tracks_user_idx on music_tracks(user_id, created_at desc);

alter table status_updates add column audio_media_id uuid references media_assets(id) on delete set null;
alter table status_updates add column audio_title text not null default '';
