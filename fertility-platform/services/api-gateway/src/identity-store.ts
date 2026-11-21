import { randomUUID } from 'node:crypto';
import type { Pool } from './db.js';
import { decryptField, encryptField, hashEmail } from './crypto.js';
import type { Role } from './types.js';

export interface Pii {
  full_name: string;
  email: string;
  phone?: string;
  date_of_birth?: string;
}

export class DuplicateAccountError extends Error {
  constructor() {
    super('an account with this e-mail already exists');
  }
}

const aad = (userId: string) => `identity_vault.users.encrypted_pii:${userId}`;

/**
 * The isolated identity service's data access. It alone holds
 * FIELD_ENCRYPTION_KEY and connects as `identity_app`; the PHI path never
 * sees PII, and this path never sees PHI.
 */
export class IdentityStore {
  constructor(
    private readonly pool: Pool,
    private readonly fieldKey: Buffer,
    private readonly emailKey: Buffer,
  ) {}

  async createUser(pii: Pii, role: Role, passwordHash: string | null = null): Promise<string> {
    const userId = randomUUID(); // generated here so the AAD can bind it to the row
    const res = await this.pool.query(
      `INSERT INTO identity_vault.users (user_id, email_hash, encrypted_pii, role, password_hash)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email_hash) DO NOTHING`,
      [userId, hashEmail(pii.email, this.emailKey), encryptField(JSON.stringify(pii), this.fieldKey, aad(userId)), role, passwordHash],
    );
    if (res.rowCount === 0) throw new DuplicateAccountError();
    return userId;
  }

  async getUser(userId: string): Promise<{ userId: string; role: Role; pii: Pii } | null> {
    const res = await this.pool.query<{ user_id: string; role: Role; encrypted_pii: string }>(
      'SELECT user_id::text AS user_id, role, encrypted_pii FROM identity_vault.users WHERE user_id = $1',
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { userId: row.user_id, role: row.role, pii: JSON.parse(decryptField(row.encrypted_pii, this.fieldKey, aad(row.user_id))) as Pii };
  }

  async findByEmail(email: string): Promise<{ userId: string; role: Role } | null> {
    const res = await this.pool.query<{ user_id: string; role: Role }>(
      'SELECT user_id::text AS user_id, role FROM identity_vault.users WHERE email_hash = $1',
      [hashEmail(email, this.emailKey)],
    );
    const row = res.rows[0];
    return row ? { userId: row.user_id, role: row.role } : null;
  }

  /** Sign-in lookup: id, role and password hash for an e-mail, or null. */
  async findCredentials(email: string): Promise<{ userId: string; role: Role; passwordHash: string | null } | null> {
    const res = await this.pool.query<{ user_id: string; role: Role; password_hash: string | null }>(
      'SELECT user_id::text AS user_id, role, password_hash FROM identity_vault.users WHERE email_hash = $1',
      [hashEmail(email, this.emailKey)],
    );
    const row = res.rows[0];
    return row ? { userId: row.user_id, role: row.role, passwordHash: row.password_hash } : null;
  }
}
