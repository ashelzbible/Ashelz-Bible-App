-- Per-user call log clearing and scheduled calls with reminders.
alter table call_participants add column hidden_at timestamptz;

create table scheduled_calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  creator_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('audio','video')),
  starts_at timestamptz not null,
  note text not null default '',
  state text not null default 'pending' check (state in ('pending','reminded','cancelled')),
  created_at timestamptz not null default now()
);
create index scheduled_calls_due_idx on scheduled_calls(starts_at) where state = 'pending';
create index scheduled_calls_conv_idx on scheduled_calls(conversation_id);
