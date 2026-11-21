-- 006: password credentials for the identity service.
-- password_hash holds a salted scrypt hash ("scrypt$N$r$p$salt$hash"), never a password.
-- Nullable: accounts created without a password cannot sign in.
ALTER TABLE identity_vault.users
  ADD COLUMN password_hash text CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$');
