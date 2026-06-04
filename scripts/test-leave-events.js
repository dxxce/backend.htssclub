/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies all "exit" events:
 *  - leave  -> server:member-left
 *  - kick   -> server:member-left (+ kicked user)
 *  - ban    -> server:member-banned + server:you-were-banned (to the banned user)
 *  - delete server -> server:deleted (to all members)
 *
 * Usage: node scripts/test-leave-events.js [baseUrl]
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
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
async function seedUser(i) {
  const username = `le_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    avatarUrl: `http://x/${i}.png`, balance: 0, status: 'ACTIVE', presence: 'OFFLINE',
    desiredPresence: 'ONLINE', isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username }; u.token = mintToken(u); return u;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(WS, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s)); s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const once = (sock, ev, ms = 6000) =>
  Promise.race([new Promise((r) => sock.once(ev, r)), new Promise((r) => setTimeout(() => r(null), ms))]);

async function main() {
  console.log(`leave events test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [owner, leaver, kicked, banned] = await Promise.all([0, 1, 2, 3].map(seedUser));
  const server = await api('/servers', { method: 'POST', token: owner.token, body: { name: `LE ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: owner.token });
  for (const u of [leaver, kicked, banned]) {
    await api('/servers/join', { method: 'POST', token: u.token, body: { inviteCode: invite.inviteCode } });
  }

  const ownerSock = await connect(owner.token);
  const bannedSock = await connect(banned.token);
  await new Promise((r) => setTimeout(r, 500));

  // leave
  let evt = once(ownerSock, 'server:member-left');
  await api(`/servers/${server.id}/leave`, { method: 'DELETE', token: leaver.token });
  let e = await evt;
  check(e && e.userId === leaver.id, 'leave -> server:member-left');

  // kick
  evt = once(ownerSock, 'server:member-left');
  await api(`/servers/${server.id}/members/${kicked.id}`, { method: 'DELETE', token: owner.token });
  e = await evt;
  check(e && e.userId === kicked.id, 'kick -> server:member-left');

  // ban -> both member-banned (room) and you-were-banned (to banned user)
  const ownerGetsBanned = once(ownerSock, 'server:member-banned');
  const bannedGetsNotice = once(bannedSock, 'server:you-were-banned');
  await api(`/servers/${server.id}/members/${banned.id}/ban`, { method: 'POST', token: owner.token, body: { reason: 'x' } });
  const b1 = await ownerGetsBanned;
  const b2 = await bannedGetsNotice;
  check(b1 && b1.userId === banned.id, 'ban -> server:member-banned (room)');
  check(b2 && b2.serverId === server.id, 'ban -> server:you-were-banned (to banned user)');

  // delete server -> server:deleted to remaining members (owner)
  const ownerGetsDeleted = once(ownerSock, 'server:deleted');
  await api(`/servers/${server.id}`, { method: 'DELETE', token: owner.token });
  const d = await ownerGetsDeleted;
  check(d && d.serverId === server.id, 'delete server -> server:deleted');

  ownerSock.disconnect(); bannedSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`le_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `LE ${stamp}` });
  await mongoose.connection.collection('server_members').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.connection.collection('server_bans').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
