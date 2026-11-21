-- 002: identity vault (PII).
--
-- No column here links to clinical_data. The only link is the keyed pseudonym
-- subject_id = HMAC-SHA256(PSEUDONYM_KEY, user_id), computed in the gateway and
-- never stored in the vault, so a database-only compromise cannot join the zones.
--
-- encrypted_pii is an AES-256-GCM envelope produced by the application
-- ("v1:<iv>:<tag>:<ciphertext>", base64url); the database never sees plaintext
-- or keys. email_hash is a keyed HMAC-SHA256 of the normalised e-mail for
-- unique lookup without storing the address in the clear.

CREATE TABLE identity_vault.users (
  user_id       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash    text        NOT NULL UNIQUE CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  encrypted_pii text        NOT NULL CHECK (encrypted_pii ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$'),
  role          text        NOT NULL CHECK (role IN ('patient', 'clinician', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON identity_vault.users FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_vault.users TO identity_app;

ALTER TABLE identity_vault.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_vault.users FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_app_all ON identity_vault.users
  FOR ALL TO identity_app USING (true) WITH CHECK (true);
