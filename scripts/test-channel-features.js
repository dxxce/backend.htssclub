/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies channel admin features against a RUNNING backend:
 *  - create/update/delete emit realtime events on the server room
 *  - reorder channels
 *  - deleting a TEXT channel cascades message deletion
 *
 * Users seeded directly in Mongo to avoid the auth rate limiter.
 * Usage: node scripts/test-channel-features.js [baseUrl]
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
  const username = `chanfeat_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: username,
    balance: 0, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username };
  u.token = mintToken(u);
  return u;
}
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const s = io(WS, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 8000);
  });
}
const waitFor = (sock, ev, ms = 5000) =>
  Promise.race([
    new Promise((r) => sock.once(ev, r)),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);

async function main() {
  console.log(`Channel features test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const owner = await seedUser(0);
  const server = await api('/servers', { method: 'POST', token: owner.token, body: { name: `Chan ${stamp}` } });
  check(!!server.id, `created server ${server.id}`);

  // socket listens to server room events
  const sock = await connectWs(owner.token);

  // CREATE -> channel:created
  const createdEvt = waitFor(sock, 'channel:created');
  const text = await api(`/servers/${server.id}/channels`, { method: 'POST', token: owner.token, body: { name: 'general', type: 'TEXT' } });
  check(!!text.id && text.type === 'TEXT', `created TEXT channel ${text.id}`);
  const ce = await createdEvt;
  check(ce && ce.id === text.id, 'received channel:created event');

  const voice = await api(`/servers/${server.id}/channels`, { method: 'POST', token: owner.token, body: { name: 'lounge', type: 'VOICE' } });
  check(voice.type === 'VOICE', `created VOICE channel ${voice.id}`);

  // UPDATE (rename) -> channel:updated
  const updatedEvt = waitFor(sock, 'channel:updated');
  const upd = await api(`/channels/${text.id}`, { method: 'PATCH', token: owner.token, body: { name: 'renamed-general', topic: 'hi' } });
  check(upd.name === 'renamed-general', 'renamed channel via PATCH');
  const ue = await updatedEvt;
  check(ue && ue.name === 'renamed-general', 'received channel:updated event');

  // REORDER -> channel:reordered
  const reorderEvt = waitFor(sock, 'channel:reordered');
  const reordered = await api(`/servers/${server.id}/channels/reorder`, {
    method: 'PATCH', token: owner.token,
    body: { items: [{ channelId: voice.id, position: 0 }, { channelId: text.id, position: 1 }] },
  });
  check(reordered[0].id === voice.id, 'reorder put voice channel first');
  const re = await reorderEvt;
  check(!!re && Array.isArray(re.channels), 'received channel:reordered event');

  // seed messages in text channel, then delete channel -> cascade
  await api(`/channels/${text.id}/messages`, { method: 'POST', token: owner.token, body: { content: 'msg1' } });
  await api(`/channels/${text.id}/messages`, { method: 'POST', token: owner.token, body: { content: 'msg2' } });
  const before = await mongoose.connection.collection('messages').countDocuments({ channelId: new mongoose.Types.ObjectId(text.id) });
  check(before === 2, `seeded ${before} messages in channel`);

  const deletedEvt = waitFor(sock, 'channel:deleted');
  await api(`/channels/${text.id}`, { method: 'DELETE', token: owner.token });
  const de = await deletedEvt;
  check(de && de.channelId === text.id, 'received channel:deleted event');
  const after = await mongoose.connection.collection('messages').countDocuments({ channelId: new mongoose.Types.ObjectId(text.id) });
  check(after === 0, `messages cascade-deleted (was ${before}, now ${after})`);

  sock.disconnect();
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `Chan ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
