alter table status_updates add column allow_sharing boolean not null default true;

create table feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  kind text not null default 'feedback' check (kind in ('feedback','bug','idea')),
  message text not null,
  app_version text,
  created_at timestamptz not null default now()
);
