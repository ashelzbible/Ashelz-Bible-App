import { DuplicateAccountError, type IdentityStore } from './identity-store.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Role } from './types.js';

/** What the HTTP layer needs from the identity side; faked in route tests. */
export interface IdentityService {
  /** Public sign-up always creates a patient; clinician and admin accounts are provisioned out of band. */
  register(email: string, password: string, fullName: string): Promise<{ userId: string } | 'exists'>;
  authenticate(email: string, password: string): Promise<{ userId: string; role: Role } | null>;
}

export class StoreIdentityService implements IdentityService {
  constructor(private readonly store: IdentityStore) {}

  async register(email: string, password: string, fullName: string) {
    const hash = await hashPassword(password);
    try {
      return { userId: await this.store.createUser({ full_name: fullName, email: email.trim().toLowerCase() }, 'patient', hash) };
    } catch (err) {
      if (err instanceof DuplicateAccountError) return 'exists' as const;
      throw err;
    }
  }

  async authenticate(email: string, password: string) {
    const cred = await this.store.findCredentials(email);
    // Verify even for unknown e-mails so response time does not reveal which accounts exist.
    const ok = await verifyPassword(password, cred?.passwordHash ?? null);
    return cred && ok ? { userId: cred.userId, role: cred.role } : null;
  }
}
