import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.ts';
import { q } from '../db/pool.ts';

let transport: Transporter | null = null;
if (config.smtpUrl) transport = nodemailer.createTransport(config.smtpUrl);

/** Queues a message in the outbox, and sends immediately via SMTP when configured. SMS has no provider wired: it stays in the outbox. */
export async function sendMessage(opts: { userId: string | null; channel: 'email' | 'sms'; to: string; subject: string; body: string }) {
  const { rows } = await q(
    `insert into outbox(user_id, channel, recipient, subject, body) values ($1,$2,$3,$4,$5) returning id`,
    [opts.userId, opts.channel, opts.to, opts.subject, opts.body],
  );
  if (opts.channel === 'email' && transport) {
    try {
      await transport.sendMail({ from: config.mailFrom, to: opts.to, subject: opts.subject, text: opts.body });
      await q('update outbox set sent_at = now() where id = $1', [rows[0].id]);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', msg: 'smtp send failed', err: String(e) }));
    }
  }
}
