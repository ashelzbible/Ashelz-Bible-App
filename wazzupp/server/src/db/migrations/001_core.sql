-- Wazzupp core schema. Forward-only; never edit an applied migration.
create extension if not exists citext;
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext unique,
  phone text unique,
  username citext not null unique check (username ~ '^[a-zA-Z0-9_.]{3,32}$'),
  password_hash text not null,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  mfa_secret text,
  mfa_enabled boolean not null default false,
  mfa_last_step bigint not null default 0,
  role text not null default 'user' check (role in ('user','moderator','admin')),
  status text not null default 'active' check (status in ('active','suspended','deleted')),
  suspended_reason text,
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (status = 'deleted' or email is not null or phone is not null)
);

create table user_profiles (
  user_id uuid primary key references users(id) on delete cascade,
  display_name text not null,
  bio text not null default '',
  status_text text not null default 'Hey there! I am using Wazzupp.',
  avatar_media_id uuid,
  settings jsonb not null default '{}'::jsonb,
  settings_version int not null default 1,
  updated_at timestamptz not null default now()
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  platform text not null default 'web',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index devices_user_idx on devices(user_id) where revoked_at is null;

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  token_hash bytea not null unique,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user_idx on sessions(user_id) where revoked_at is null;

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('verify_email','verify_phone','reset_password','login_challenge')),
  token_hash bytea not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_lookup on auth_tokens(user_id, kind) where used_at is null;

-- Development/outbox for verification mail and SMS. Production uses SMTP/SMS providers.
create table outbox (
  id bigserial primary key,
  user_id uuid references users(id) on delete cascade,
  channel text not null check (channel in ('email','sms')),
  recipient text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table contacts (
  owner_id uuid not null references users(id) on delete cascade,
  contact_id uuid not null references users(id) on delete cascade,
  alias text,
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (owner_id, contact_id),
  check (owner_id <> contact_id)
);

create table blocks (
  blocker_id uuid not null references users(id) on delete cascade,
  blocked_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('image','video','audio','voice','document','sticker','avatar')),
  mime text not null,
  size bigint not null,
  sha256 text not null,
  original_name text,
  storage_key text not null,
  thumb_key text,
  width int,
  height int,
  duration_ms int,
  waveform jsonb,
  scan_status text not null default 'unscanned' check (scan_status in ('unscanned','clean','infected')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index media_owner_idx on media_assets(owner_id, created_at desc);
alter table user_profiles add constraint profile_avatar_fk foreign key (avatar_media_id) references media_assets(id) on delete set null;

create table communities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  avatar_media_id uuid references media_assets(id) on delete set null,
  visibility text not null default 'private' check (visibility in ('public','private')),
  created_by uuid not null references users(id),
  announcement_conversation_id uuid,
  created_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('direct','group','channel','announcement')),
  direct_key text unique,
  title text,
  description text not null default '',
  avatar_media_id uuid references media_assets(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  announce_only boolean not null default false,
  members_can_edit_info boolean not null default false,
  members_can_invite boolean not null default true,
  disappearing_seconds int,
  community_id uuid references communities(id) on delete set null,
  is_public boolean not null default false,
  last_seq bigint not null default 0,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'direct') = (direct_key is not null))
);
alter table communities add constraint community_announce_fk foreign key (announcement_conversation_id) references conversations(id) on delete set null;

create table conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member','subscriber')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  removed boolean not null default false,
  muted_until timestamptz,
  archived boolean not null default false,
  pinned boolean not null default false,
  favorite boolean not null default false,
  marked_unread boolean not null default false,
  folder text,
  last_read_seq bigint not null default 0,
  last_delivered_seq bigint not null default 0,
  read_receipt_seq bigint not null default 0,
  first_visible_seq bigint not null default 0,
  draft text,
  state_version int not null default 1,
  primary key (conversation_id, user_id)
);
create index conv_members_user_idx on conversation_members(user_id) where left_at is null;

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  seq bigint not null,
  sender_id uuid references users(id) on delete set null,
  sender_device_id uuid references devices(id) on delete set null,
  client_msg_id text not null,
  kind text not null check (kind in ('text','image','video','voice','audio','document','location','contact','sticker','gif','poll','event','system')),
  body text not null default '',
  meta jsonb not null default '{}'::jsonb,
  media_id uuid references media_assets(id) on delete set null,
  reply_to_id uuid references messages(id) on delete set null,
  forwarded boolean not null default false,
  undelivered boolean not null default false,
  mentions uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_for_all_at timestamptz,
  expires_at timestamptz,
  pinned_at timestamptz,
  pinned_by uuid references users(id) on delete set null,
  unique (conversation_id, seq),
  unique (conversation_id, sender_id, client_msg_id)
);
create index messages_conv_seq_idx on messages(conversation_id, seq desc);
create index messages_search_idx on messages using gin(body gin_trgm_ops);
create index messages_expiry_idx on messages(expires_at) where expires_at is not null and deleted_for_all_at is null;
create index messages_pinned_idx on messages(conversation_id) where pinned_at is not null;
create index messages_media_idx on messages(conversation_id, kind, seq desc) where media_id is not null;

create table message_edits (
  id bigserial primary key,
  message_id uuid not null references messages(id) on delete cascade,
  old_body text not null,
  edited_at timestamptz not null default now()
);

create table message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table message_hidden (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (message_id, user_id)
);

create table message_stars (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table poll_votes (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  option_idx int not null check (option_idx >= 0),
  primary key (message_id, user_id, option_idx)
);

create table invite_links (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  community_id uuid references communities(id) on delete cascade,
  code_hash bytea not null unique,
  created_by uuid not null references users(id) on delete cascade,
  expires_at timestamptz,
  revoked_at timestamptz,
  max_uses int,
  uses int not null default 0,
  created_at timestamptz not null default now(),
  check ((conversation_id is null) <> (community_id is null))
);

create table community_members (
  community_id uuid not null references communities(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (community_id, user_id)
);

create table status_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('text','image','video')),
  body text not null default '',
  caption text not null default '',
  background text,
  media_id uuid references media_assets(id) on delete set null,
  audience text not null default 'contacts' check (audience in ('contacts','except','only')),
  audience_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index status_active_idx on status_updates(user_id, expires_at);

create table status_views (
  status_id uuid not null references status_updates(id) on delete cascade,
  viewer_id uuid not null references users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  reaction text,
  primary key (status_id, viewer_id)
);

create table status_mutes (
  user_id uuid not null references users(id) on delete cascade,
  muted_id uuid not null references users(id) on delete cascade,
  primary key (user_id, muted_id)
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  initiator_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('audio','video')),
  state text not null default 'ringing' check (state in ('ringing','connecting','connected','declined','missed','ended','failed','cancelled')),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  connected_at timestamptz,
  ended_at timestamptz,
  end_reason text
);
create index calls_conv_idx on calls(conversation_id, created_at desc);

create table call_participants (
  call_id uuid not null references calls(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  state text not null default 'invited' check (state in ('invited','joined','declined','missed','left')),
  joined_at timestamptz,
  media_up_at timestamptz,
  left_at timestamptz,
  primary key (call_id, user_id)
);
create index call_participants_user_idx on call_participants(user_id, call_id);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  conversation_id uuid references conversations(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_state text not null default 'none' check (push_state in ('none','queued','sent','failed','suppressed'))
);
create index notifications_user_idx on notifications(user_id, created_at desc);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- Durable per-user event log. Realtime delivery is best effort; clients recover
-- by replaying events after their last seen id.
create table user_events (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index user_events_user_idx on user_events(user_id, id);

-- Encryption directory (key bundles only; no private keys ever reach the server).
create table encryption_devices (
  device_id uuid primary key references devices(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  identity_key text not null,
  signed_prekey text not null,
  signed_prekey_sig text not null,
  registration_id int not null,
  created_at timestamptz not null default now()
);
create table public_key_bundles (
  id bigserial primary key,
  device_id uuid not null references encryption_devices(device_id) on delete cascade,
  prekey_id int not null,
  prekey text not null,
  consumed_at timestamptz,
  unique (device_id, prekey_id)
);
create table key_transparency_events (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  device_id uuid,
  kind text not null check (kind in ('device_added','device_revoked','identity_changed')),
  fingerprint text,
  created_at timestamptz not null default now()
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id) on delete cascade,
  target_user_id uuid references users(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  reason text not null,
  details text not null default '',
  snapshot jsonb,
  status text not null default 'open' check (status in ('open','reviewing','actioned','dismissed')),
  created_at timestamptz not null default now()
);
create table moderation_actions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references reports(id) on delete set null,
  actor_id uuid not null references users(id),
  target_user_id uuid references users(id) on delete set null,
  action text not null check (action in ('suspend','unsuspend','warn','delete_message','dismiss','restore')),
  reason text not null default '',
  created_at timestamptz not null default now()
);
create table appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  message text not null,
  status text not null default 'open' check (status in ('open','accepted','rejected')),
  created_at timestamptz not null default now()
);
create table audit_events (
  id bigserial primary key,
  actor_id uuid references users(id) on delete set null,
  action text not null,
  target text,
  detail jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_created_idx on audit_events(created_at desc);

create table feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null default '',
  updated_at timestamptz not null default now()
);

create table background_jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  state text not null default 'queued' check (state in ('queued','running','done','failed')),
  last_error text,
  locked_at timestamptz,
  created_at timestamptz not null default now()
);
create index jobs_due_idx on background_jobs(run_at) where state = 'queued';

create table recent_searches (
  user_id uuid not null references users(id) on delete cascade,
  term text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, term)
);

insert into feature_flags(key, enabled, description) values
 ('registration_open', true, 'Allow new account registration'),
 ('calls_enabled', true, 'Allow voice and video calls'),
 ('status_enabled', true, 'Allow status updates'),
 ('ai_tools', false, 'Optional AI assisted drafting (requires configured provider)');
