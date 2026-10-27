import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db/pool.ts';
import { authenticateVerified, parse } from '../lib/http.ts';
import { HttpError, forbidden } from '../lib/errors.ts';
import { rateLimit } from '../lib/ratelimit.ts';
import { config } from '../config.ts';

/**
 * Optional AI drafting. Off unless the `ai_tools` flag is on AND ANTHROPIC_API_KEY is set. It only ever receives
 * the text the user explicitly submits in this request; message history is never read or forwarded by the server.
 */
export async function aiRoutes(app: FastifyInstance) {
  app.get('/api/ai/status', { preHandler: authenticateVerified }, async () => {
    const f = await one(`select enabled from feature_flags where key = 'ai_tools'`);
    return { available: !!(f?.enabled && config.anthropicApiKey), externalProcessor: 'Anthropic API', note: 'Text you submit is sent to an external AI service. Nothing else from your chats is shared.' };
  });
  app.post('/api/ai/draft', { preHandler: authenticateVerified }, async (req) => {
    const b = parse(z.object({ text: z.string().min(1).max(2000), tone: z.enum(['friendly', 'professional', 'concise', 'translate_en']).default('friendly'), consent: z.literal(true) }), req.body);
    const f = await one(`select enabled from feature_flags where key = 'ai_tools'`);
    if (!f?.enabled) throw forbidden('ai_disabled');
    if (!config.anthropicApiKey) throw new HttpError(503, 'ai_not_configured', 'AI provider is not configured');
    await rateLimit(`ai:${req.auth.userId}`, 20, 3600);
    const instruction = { friendly: 'Rewrite the message in a warm, friendly tone.', professional: 'Rewrite the message in a clear, professional tone.', concise: 'Rewrite the message to be shorter while keeping its meaning.', translate_en: 'Translate the message into English.' }[b.tone];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 500, system: `${instruction} Reply with only the rewritten message.`, messages: [{ role: 'user', content: b.text }] }),
    });
    if (!res.ok) throw new HttpError(502, 'ai_failed', 'AI provider error');
    const j: any = await res.json();
    return { draft: String(j.content?.[0]?.text ?? '').slice(0, 2000) };
  });
}
