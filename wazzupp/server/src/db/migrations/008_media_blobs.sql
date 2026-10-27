-- Optional media storage inside Postgres (MEDIA_STORE=db) for hosts whose disk is erased on every deploy.
create table media_blobs (
  key text primary key,
  data bytea not null
);
