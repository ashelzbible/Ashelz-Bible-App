create table scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references users(id) on delete cascade,
  body text not null,
  send_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending','sent','cancelled','failed')),
  created_at timestamptz not null default now()
);
create index scheduled_due_idx on scheduled_messages(send_at) where state = 'pending';

create table chat_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  position int not null default 0,
  unique (user_id, name)
);
