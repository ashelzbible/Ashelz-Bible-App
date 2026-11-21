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

  async createUser(pii: Pii, role: Role): Promise<string> {
    const userId = randomUUID(); // generated here so the AAD can bind it to the row
    const res = await this.pool.query(
      `INSERT INTO identity_vault.users (user_id, email_hash, encrypted_pii, role)
       VALUES ($1, $2, $3, $4) ON CONFLICT (email_hash) DO NOTHING`,
      [userId, hashEmail(pii.email, this.emailKey), encryptField(JSON.stringify(pii), this.fieldKey, aad(userId)), role],
    );
    if (res.rowCount === 0) throw new Error('an account with this e-mail already exists');
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
}
