import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { one, q, tx } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { rateLimit } from '../lib/ratelimit.ts';

/**
 * Key directory for a future end-to-end encryption milestone (X3DH/Double Ratchet style bundles, e.g. via libsignal).
 * The server stores ONLY public keys and never sees private keys. THIS IS NOT E2EE BY ITSELF: messages are
 * currently protected by TLS in transit and access control at rest; see docs/SECURITY.md.
 */
const b64 = z.string().regex(/^[A-Za-z0-9+/_-]+=*$/).min(20).max(2000);

export async function keyRoutes(app: FastifyInstance) {
  app.put('/api/keys/device', { preHandler: authenticateVerified }, async (req, reply) => {
    const b = parse(z.object({ identityKey: b64, signedPrekey: b64, signedPrekeySignature: b64, registrationId: z.number().int().min(1).max(16380), prekeys: z.array(z.object({ id: z.number().int().min(0), key: b64 })).max(100) }), req.body);
    await tx(async (t) => {
      const prev = await t.one(`select identity_key from encryption_devices where device_id = $1`, [req.auth.deviceId]);
      await t.q(`insert into encryption_devices(device_id, user_id, identity_key, signed_prekey, signed_prekey_sig, registration_id) values ($1,$2,$3,$4,$5,$6)
                 on conflict (device_id) do update set identity_key = excluded.identity_key, signed_prekey = excluded.signed_prekey, signed_prekey_sig = excluded.signed_prekey_sig, registration_id = excluded.registration_id`,
        [req.auth.deviceId, req.auth.userId, b.identityKey, b.signedPrekey, b.signedPrekeySignature, b.registrationId]);
      const fp = createHash('sha256').update(b.identityKey).digest('hex').slice(0, 32);
      if (!prev) await t.q(`insert into key_transparency_events(user_id, device_id, kind, fingerprint) values ($1,$2,'device_added',$3)`, [req.auth.userId, req.auth.deviceId, fp]);
      else if (prev.identity_key !== b.identityKey) await t.q(`insert into key_transparency_events(user_id, device_id, kind, fingerprint) values ($1,$2,'identity_changed',$3)`, [req.auth.userId, req.auth.deviceId, fp]);
      for (const p of b.prekeys) await t.q(`insert into public_key_bundles(device_id, prekey_id, prekey) values ($1,$2,$3) on conflict (device_id, prekey_id) do nothing`, [req.auth.deviceId, p.id, p.key]);
    });
    reply.code(204);
  });

  // Fetch one bundle per device of the target; each one-time prekey is handed out at most once.
  app.get('/api/keys/users/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await rateLimit(`keys:${req.auth.userId}`, 60, 600);
    const shared = await one(`select 1 from conversation_members a join conversation_members b on a.conversation_id = b.conversation_id
                               where a.user_id = $1 and b.user_id = $2 and a.left_at is null and b.left_at is null limit 1`, [req.auth.userId, id]);
    if (!shared) throw notFound('user_not_found');
    const blk = await one(`select 1 from blocks where blocker_id = $1 and blocked_id = $2`, [id, req.auth.userId]);
    if (blk) throw forbidden('blocked');
    const devices = (await q(`select device_id, identity_key, signed_prekey, signed_prekey_sig, registration_id from encryption_devices where user_id = $1`, [id])).rows;
    const out = [];
    for (const d of devices) {
      const pk = await one(`update public_key_bundles set consumed_at = now() where id = (select id from public_key_bundles where device_id = $1 and consumed_at is null order by id limit 1 for update skip locked) returning prekey_id, prekey`, [d.device_id]);
      out.push({ deviceId: d.device_id, registrationId: d.registration_id, identityKey: d.identity_key, signedPrekey: d.signed_prekey, signedPrekeySignature: d.signed_prekey_sig, oneTimePrekey: pk ? { id: pk.prekey_id, key: pk.prekey } : null });
    }
    return { userId: id, devices: out };
  });

  app.get('/api/keys/transparency/:id', { preHandler: authenticateVerified }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const shared = await one(`select 1 from conversation_members a join conversation_members b on a.conversation_id = b.conversation_id where a.user_id = $1 and b.user_id = $2 limit 1`, [req.auth.userId, id]);
    if (!shared && id !== req.auth.userId) throw notFound('user_not_found');
    return { events: (await q(`select kind, device_id "deviceId", fingerprint, created_at "createdAt" from key_transparency_events where user_id = $1 order by id desc limit 50`, [id])).rows };
  });
}
