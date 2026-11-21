export type Role = 'patient' | 'clinician' | 'admin';

export interface Actor {
  /** identity_vault.users.user_id from the verified JWT `sub`. */
  id: string;
  role: Role;
}

export interface RequestMeta {
  /** Keyed hash of the client IP; null if the IP is unknown. */
  ipHash: string | null;
  requestId: string;
}

export interface AccessContext {
  actor: Actor;
  meta: RequestMeta;
}

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'ERROR';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role };
  }
}
