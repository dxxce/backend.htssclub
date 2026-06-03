/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies reaction + reply features per REACTION-REPLY-SPEC.md against a
 * running backend.
 *
 * Usage: node scripts/test-reaction-reply.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const API = `${BASE}/api`;
const WS = `${BASE}/ws`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });

async function seedUser(i) {
  const username = `rr_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    avatarUrl: `http://x/${i}.png`, balance: 0, status: 'ACTIVE', presence: 'OFFLINE',
    desiredPresence: 'ONLINE', isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username };
  u.token = mintToken(u);
  return u;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(WS, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const once = (sock, ev, ms = 5000) =>
  Promise.race([new Promise((r) => sock.once(ev, r)), new Promise((r) => setTimeout(() => r(null), ms))]);

async function main() {
  console.log(`Reaction + reply test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [alice, bob] = await Promise.all([seedUser(0), seedUser(1)]);
  const server = await api('/servers', { method: 'POST', token: alice.token, body: { name: `RR ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: alice.token });
  await api('/servers/join', { method: 'POST', token: bob.token, body: { inviteCode: invite.inviteCode } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: alice.token, body: { name: 'general', type: 'TEXT' } });

  // ── Message shape: author + empty reactions ──
  const m1 = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: alice.token, body: { content: 'đi ăn không? đính kèm nhé', attachments: [{ url: 'http://x/a.png', type: 'image/png', name: 'a.png', size: 10, category: 'IMAGE' }] } });
  check(m1.author && m1.author.id === alice.id && m1.author.displayName === 'Disp 0', 'message carries author card');
  check(Array.isArray(m1.reactions) && m1.reactions.length === 0, 'new message has empty reactions[]');

  // ── Reply: message carries replyTo populated ──
  const sock = await connect(bob.token);
  sock.emit('channel:join', { channelId: channel.id });
  await new Promise((r) => setTimeout(r, 300));

  const m2 = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: bob.token, body: { content: 'đồng ý nhé', replyToId: m1.id } });
  check(m2.replyTo && m2.replyTo.id === m1.id, 'reply message carries replyTo.id = original');
  check(m2.replyTo.author && m2.replyTo.author.id === alice.id, 'replyTo carries original author card');
  check(m2.replyTo.hasAttachments === true, 'replyTo.hasAttachments reflects original attachments');
  check(typeof m2.replyTo.content === 'string', 'replyTo.content present');

  // ── Reaction add (Alice 👍 on m2) -> realtime reaction:added to Bob ──
  const bobGetsReaction = once(sock, 'reaction:added');
  await api(`/channels/${channel.id}/messages/${m2.id}/reactions`, { method: 'POST', token: alice.token, body: { emoji: '👍' } });
  const radd = await bobGetsReaction;
  check(radd && radd.messageId === m2.id && radd.emoji === '👍' && radd.userId === alice.id, 'reaction:added broadcast');

  // Bob also adds 👍 -> count should become 2.
  await api(`/channels/${channel.id}/messages/${m2.id}/reactions`, { method: 'POST', token: bob.token, body: { emoji: '👍' } });
  // Idempotent: Alice adds 👍 again -> still 2.
  await api(`/channels/${channel.id}/messages/${m2.id}/reactions`, { method: 'POST', token: alice.token, body: { emoji: '👍' } });

  // Bob adds a different emoji.
  await api(`/channels/${channel.id}/messages/${m2.id}/reactions`, { method: 'POST', token: bob.token, body: { emoji: '🔥' } });

  // Verify grouped reactions via history (from Alice's viewpoint).
  const hist = await api(`/channels/${channel.id}/messages?limit=10`, { token: alice.token });
  const hm2 = hist.items.find((m) => m.id === m2.id);
  const thumbs = hm2.reactions.find((r) => r.emoji === '👍');
  const fire = hm2.reactions.find((r) => r.emoji === '🔥');
  check(thumbs && thumbs.count === 2, '👍 grouped count = 2 (idempotent add)');
  check(thumbs && thumbs.me === true, '👍 me=true for Alice');
  check(thumbs && thumbs.userIds.length === 2, '👍 userIds has 2 ids');
  check(fire && fire.count === 1 && fire.me === false, '🔥 count=1, me=false for Alice');

  // ── Reaction remove (Alice removes 👍) -> realtime + count drops ──
  const bobGetsRemove = once(sock, 'reaction:removed');
  await api(`/channels/${channel.id}/messages/${m2.id}/reactions`, { method: 'DELETE', token: alice.token, body: { emoji: '👍' } });
  const rrem = await bobGetsRemove;
  check(rrem && rrem.emoji === '👍' && rrem.userId === alice.id, 'reaction:removed broadcast');

  const hist2 = await api(`/channels/${channel.id}/messages?limit=10`, { token: alice.token });
  const hm2b = hist2.items.find((m) => m.id === m2.id);
  const thumbs2 = hm2b.reactions.find((r) => r.emoji === '👍');
  check(thumbs2 && thumbs2.count === 1 && thumbs2.me === false, '👍 count=1, me=false after Alice removed');

  // ── Delete original message -> reply now shows replyTo: null ──
  await api(`/channels/${channel.id}/messages/${m1.id}`, { method: 'DELETE', token: alice.token });
  const hist3 = await api(`/channels/${channel.id}/messages?limit=10`, { token: bob.token });
  const hm2c = hist3.items.find((m) => m.id === m2.id);
  check(hm2c && hm2c.replyTo === null, 'replyTo becomes null after original deleted');

  sock.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`rr_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `RR ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.connection.collection('messages').deleteMany({ channelId: new mongoose.Types.ObjectId(channel.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
