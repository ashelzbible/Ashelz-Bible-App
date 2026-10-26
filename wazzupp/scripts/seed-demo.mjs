// Seeds a DEVELOPMENT server with synthetic accounts and conversations through the public API.
// Usage: BASE_URL=http://localhost:8787 DATABASE_URL=... node scripts/seed-demo.mjs
// Never run against production: the accounts use well-known passwords. All data is made up.
import sharp from 'sharp';
import pg from 'pg';

const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
const PASSWORD = 'demo-password-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, body, token) {
  const res = await fetch(BASE + url, { method, headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const text = await res.text(); const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return data;
}
async function person(username, displayName, extra = {}) {
  const r = await call('POST', '/api/auth/register', { username, password: PASSWORD, displayName, email: `${username}@example.test`, deviceName: 'Seed script', ...extra });
  const out = await call('GET', '/api/dev/outbox', null, r.token);
  const code = /(\d{6})/.exec(out.messages[0].body)[1];
  await call('POST', '/api/auth/verify', { kind: 'email', code }, r.token);
  return { id: r.user.id, token: r.token, name: displayName, username };
}
const dm = async (a, b) => (await call('POST', '/api/conversations/direct', { userId: b.id }, a.token)).conversation.id;
let n = 0;
const say = (p, conv, body, extra = {}) => call('POST', `/api/conversations/${conv}/messages`, { clientMsgId: `seed-${Date.now()}-${n++}-${Math.random().toString(36).slice(2)}`, kind: 'text', body, ...extra }, p.token).then((r) => r.message);
async function upload(p, buf, name, kind, extra = {}) {
  const f = new FormData(); f.append('kind', kind); for (const [k, v] of Object.entries(extra)) f.append(k, v); f.append('file', new Blob([buf]), name);
  return (await call('POST', '/api/media', f, p.token)).media;
}
const scene = async (w, h, stops, label) => {
  const stopsXml = stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stopsXml}</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.62}" cy="${h * 0.58}" r="${h * 0.07}" fill="#FFE9B0" opacity=".9"/><path d="M0 ${h * 0.72} Q ${w * 0.25} ${h * 0.64} ${w * 0.5} ${h * 0.72} T ${w} ${h * 0.7} V ${h} H0 Z" fill="#0b1f2a" opacity=".85"/>${label ? `<text x="${w / 2}" y="${h * 0.34}" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="${h * 0.075}" fill="#fff">${label}</text>` : ''}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
};

const SUNSET = [[0, '#2B2A4C'], [0.4, '#B3541E'], [0.62, '#F29A4B'], [1, '#2A2118']];
const OCEAN = [[0, '#7FB7E6'], [0.6, '#2F7DBB'], [1, '#14405F']];
const NIGHT = [[0, '#0F1B3A'], [0.6, '#2B4378'], [1, '#101826']];
const DAWN = [[0, '#F7C9A8'], [0.6, '#EE8F6B'], [1, '#5A3A4E']];
const FOREST = [[0, '#CFE8D2'], [0.55, '#4F9A6B'], [1, '#143B2B']];

// ---- people ----
const me = await person('alex', 'Alex Morgan', { bio: 'Building things with friends.' });
const sarah = await person('sarah', 'Sarah Johnson');
const david = await person('david', 'David Smith');
const lisa = await person('lisa', 'Lisa Brown');
const john = await person('john', 'John Miller');
const anna = await person('anna', 'Anna Lee');
const mom = await person('mom', 'Mom');
const rivera = await person('alexr', 'Alex Rivera');
const others = [sarah, david, lisa, john, anna, mom, rivera];
for (const o of others) { await call('PUT', `/api/contacts/${o.id}`, {}, me.token); await call('PUT', `/api/contacts/${me.id}`, {}, o.token); }
await call('PATCH', '/api/me', { statusText: 'Available' }, me.token);

// ---- calls: only outcomes that happen without a live media connection (missed/declined/cancelled) ----
const ring = async (from, to, kind, action) => {
  const c = await dm(from, to);
  const r = await call('POST', '/api/calls', { conversationId: c, kind }, from.token);
  if (action === 'decline') await call('POST', `/api/calls/${r.call.id}/decline`, null, to.token);
  else if (action === 'cancel') await call('POST', `/api/calls/${r.call.id}/cancel`, null, from.token);
  else await sleep(4200); // let the server's ring timeout mark it missed
};
for (const args of [[david, me, 'audio', 'miss'], [lisa, me, 'video', 'decline'], [me, john, 'audio', 'miss'], [anna, me, 'audio', 'miss'], [me, rivera, 'audio', 'cancel']]) await ring(...args);


// ---- Sarah (the reference conversation) ----
const cSarah = await dm(me, sarah);
await say(sarah, cSarah, 'Hey! How are you? 😊');
await say(me, cSarah, "I'm good! Just finishing up some work.\nHow about you?");
await say(sarah, cSarah, "Good! Let's catch up later.\nAre you free for coffee this afternoon?");
await say(me, cSarah, 'That sounds great! ☕\nI\'m free around 3pm.');
await say(sarah, cSarah, "Perfect! I'll see you then. 😊");
for (const [i, [stops, name]] of [[SUNSET, 'sunset'], [NIGHT, 'city'], [OCEAN, 'ocean'], [DAWN, 'dawn'], [FOREST, 'forest']].entries()) {
  const m = await upload(sarah, await scene(900, 640, stops), `${name}.jpg`, 'image');
  await call('POST', `/api/conversations/${cSarah}/messages`, { clientMsgId: `seed-img-${i}-${Date.now()}`, kind: 'image', mediaId: m.id, body: i === 0 ? 'Look at this view!' : '' }, sarah.token);
}
await say(sarah, cSarah, '', { kind: 'location', meta: { lat: -26.2041, lng: 28.0473, label: 'Rosebank Café' } });
await say(me, cSarah, 'Wow, gorgeous!');
const last = await say(sarah, cSarah, 'That sounds great! 👍');
await call('POST', `/api/conversations/${cSarah}/read`, { seq: 9999 }, sarah.token);
await call('POST', `/api/conversations/${cSarah}/read`, { seq: 9999 }, me.token);
const sm = (await call('GET', `/api/conversations/${cSarah}/messages?limit=100`, null, me.token)).messages;
await call('PUT', `/api/messages/${sm[1].id}/star`, { starred: true }, me.token);
await call('PUT', `/api/messages/${sm[3].id}/star`, { starred: true }, me.token);
await call('PUT', `/api/messages/${sm[0].id}/reaction`, { emoji: '❤️' }, me.token);

// ---- groups ----
const grp = async (owner, title, members) => (await call('POST', '/api/groups', { title, memberIds: members.map((m) => m.id) }, owner.token)).conversation.id;
const gFamily = await grp(mom, 'Family Group', [me, sarah, anna]);
const gWork = await grp(rivera, 'Work Team', [me, david, lisa]);
const gBesties = await grp(anna, 'Besties 💕', [me, sarah, lisa]);
const gAlpha = await grp(me, 'Project Alpha', [rivera, david, john, lisa]);
await say(mom, gFamily, 'Dinner at 7 on Sunday?'); await say(anna, gFamily, 'Yes! I will bring dessert'); await say(mom, gFamily, 'See you all later! ❤️');
await call('POST', `/api/conversations/${gFamily}/read`, { seq: 3 }, me.token);
await say(mom, gFamily, 'Don\'t forget the photos'); await say(sarah, gFamily, 'On it 📸'); await say(mom, gFamily, 'See you all later! ❤️');
await say(rivera, gWork, 'Morning team'); await say(david, gWork, 'Morning!'); await say(lisa, gWork, 'Agenda is in the doc'); await say(david, gWork, 'Got it'); await say(rivera, gWork, 'Meeting at 11am');
await say(anna, gBesties, 'Who is in for Saturday?'); await say(lisa, gBesties, 'Me!'); await say(sarah, gBesties, 'Count me in'); await say(anna, gBesties, "Can't wait! 😍");
const doc = await upload(me, Buffer.from('Project Alpha: milestones\n1. Design\n2. Build\n3. Launch\n'), 'Project-Alpha-plan.txt', 'document');
await call('POST', `/api/conversations/${gAlpha}/messages`, { clientMsgId: `seed-doc-${Date.now()}`, kind: 'document', mediaId: doc.id }, me.token);
await call('POST', `/api/conversations/${gAlpha}/read`, { seq: 99 }, me.token);

// ---- direct chats ----
const cDavid = await dm(me, david); const cLisa = await dm(me, lisa); const cJohn = await dm(me, john);
const wave = Array.from({ length: 40 }, (_, i) => Math.round((0.2 + 0.6 * Math.abs(Math.sin(i * 0.7)) * (0.5 + 0.5 * Math.cos(i * 0.21))) * 100) / 100);
const head = Buffer.alloc(36); head.write('OggS', 0, 'latin1'); head.write('OpusHead', 28, 'latin1');
const voice = await upload(david, Buffer.concat([head, Buffer.alloc(8000, 3)]), 'voice.ogg', 'voice', { durationMs: '12000', waveform: JSON.stringify(wave) });
await call('POST', `/api/conversations/${cDavid}/messages`, { clientMsgId: `seed-v-${Date.now()}`, kind: 'voice', mediaId: voice.id }, david.token);
const photo = await upload(lisa, await scene(800, 600, FOREST), 'trail.jpg', 'image');
await call('POST', `/api/conversations/${cLisa}/messages`, { clientMsgId: `seed-p1-${Date.now()}`, kind: 'image', mediaId: photo.id }, lisa.token);
const photo2 = await upload(lisa, await scene(800, 600, DAWN), 'dawn.jpg', 'image');
await call('POST', `/api/conversations/${cLisa}/messages`, { clientMsgId: `seed-p2-${Date.now()}`, kind: 'image', mediaId: photo2.id }, lisa.token);
await say(john, cJohn, 'Can you send the slides?'); await say(me, cJohn, 'Sent them over'); await say(john, cJohn, 'Thanks!');
await call('POST', `/api/conversations/${cJohn}/read`, { seq: 99 }, me.token);

// ---- status ----
await call('POST', '/api/status', { kind: 'image', mediaId: (await upload(sarah, await scene(1080, 1920, SUNSET, 'Good Vibes Only'), 'status.jpg', 'image')).id, caption: '' }, sarah.token);
await call('POST', '/api/status', { kind: 'text', body: 'Coffee first, everything else second ☕', background: '#6A3A8C' }, david.token);
await call('POST', '/api/status', { kind: 'text', body: 'Weekend plans: hiking!', background: '#1B5E8A' }, lisa.token);
await call('POST', '/api/status', { kind: 'text', body: 'Shipped it 🚀', background: '#003B32' }, me.token);
const stSarah = (await call('GET', '/api/status', null, me.token)).feed.find((g) => g.userId === sarah.id).items[0];
const stMe = (await call('GET', '/api/status/mine', null, me.token)).items[0];
for (const o of [sarah, david, lisa, john, anna]) await call('POST', `/api/status/${stMe.id}/view`, null, o.token).catch(() => {});
void stSarah;

// ---- communities ----
const comm = async (owner, name, desc, groups) => { const c = (await call('POST', '/api/communities', { name, description: desc, visibility: 'private' }, owner.token)).community; for (const g of groups) await call('POST', `/api/communities/${c.id}/groups`, { conversationId: g }, owner.token).catch(() => {}); return c; };
const cWork = await comm(me, 'Workplace', 'Everything for the team', [gAlpha]);
await call('POST', `/api/communities/${cWork.id}/announce`, { body: 'Welcome to the Workplace community!', clientMsgId: `seed-ann-${Date.now()}` }, me.token);
await comm(me, 'Family', 'Family updates and plans', []); await comm(me, 'Friends', 'Hangouts and trips', []); await comm(me, 'Study Group', 'Exam prep', []); await comm(me, 'Sports', 'Five-a-side and runs', []);

// ---- development only: back-date messages so the chat list order/times match the design reference ----
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const at = (h, m, daysAgo = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d; };
  const targets = [[gFamily, at(10, 24)], [cSarah, at(9, 46)], [gWork, at(9, 12)], [cDavid, at(8, 56)], [cLisa, at(8, 32)], [gBesties, at(18, 5, 1)], [cJohn, at(16, 40, 1)], [gAlpha, at(11, 3, 1)]];
  for (const [conv, t] of targets) {
    const rows = (await pool.query(`select id from messages where conversation_id = $1 order by seq desc`, [conv])).rows;
    for (const [i, r] of rows.entries()) await pool.query(`update messages set created_at = $2 where id = $1`, [r.id, new Date(t.getTime() - i * 90_000)]);
    await pool.query(`update conversations set last_message_at = $2 where id = $1`, [conv, t]);
  }
  await pool.query(`update conversations set last_message_at = now() - interval '3 days' where id <> all($1::uuid[]) and last_message_at > now() - interval '2 hours'`, [targets.map((t) => t[0])]);
  await pool.query(`update messages m set created_at = now() - interval '3 days' where m.conversation_id in (select id from conversations where kind = 'announcement')`);
  await pool.query(`update calls set created_at = created_at - interval '5 hours' where true`);
  await pool.end();
}
console.log(JSON.stringify({ ok: true, login: { identifier: 'alex', password: PASSWORD }, others: others.map((o) => o.username) }));
