/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies server:member-joined is broadcast with a FULL member card when:
 *  - someone joins via invite code
 *  - a new user registers and is auto-joined to the default server
 *
 * Usage: node scripts/test-member-joined.js [baseUrl]
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
  const username = `mj_${stamp}_${i}`;
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
const once = (sock, ev, ms = 6000) =>
  Promise.race([new Promise((r) => sock.once(ev, r)), new Promise((r) => setTimeout(() => r(null), ms))]);

async function main() {
  console.log(`member-joined test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  // ── Case 1: join via invite ──
  const owner = await seedUser(0);
  const newbie = await seedUser(1);
  const server = await api('/servers', { method: 'POST', token: owner.token, body: { name: `MJ ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: owner.token });

  const ownerSock = await connect(owner.token);
  await new Promise((r) => setTimeout(r, 400));

  const ownerGetsJoin = once(ownerSock, 'server:member-joined');
  await api('/servers/join', { method: 'POST', token: newbie.token, body: { inviteCode: invite.inviteCode } });
  const ev = await ownerGetsJoin;
  check(ev && ev.userId === newbie.id, 'owner received server:member-joined (invite)');
  check(ev && ev.member && ev.member.user && ev.member.user.displayName === 'Disp 1', 'member-joined carries full user card');
  check(ev && ev.member.role === 'MEMBER', 'member-joined carries role');
  ownerSock.disconnect();

  // ── Case 2: register -> auto-join default server -> existing default member notified ──
  const defaultServerId = process.env.DEFAULT_SERVER_ID_OVERRIDE || null;
  // Find the default server id and seed an existing member on it who listens.
  const def = await mongoose.connection.collection('servers').findOne({ isDefault: true });
  if (def) {
    const watcher = await seedUser(2);
    await mongoose.connection.collection('server_members').insertOne({
      serverId: def._id, userId: new mongoose.Types.ObjectId(watcher.id), role: 'MEMBER', joinedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(),
    });
    const watcherSock = await connect(watcher.token);
    await new Promise((r) => setTimeout(r, 500));

    const watcherGetsJoin = once(watcherSock, 'server:member-joined');
    const reg = await api('/auth/register', { method: 'POST', body: { username: `mjreg_${stamp}`, email: `mjreg_${stamp}@example.com`, password: 'StrongP@ss1' } });
    const ev2 = await watcherGetsJoin;
    check(ev2 && ev2.serverId === def._id.toString(), 'existing default-server member notified on new registration');
    check(ev2 && ev2.member && ev2.member.user && ev2.member.user.id === reg.user.id, 'auto-join member-joined carries the new user card');
    watcherSock.disconnect();

    await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`mjreg_${stamp}`) });
    await mongoose.connection.collection('server_members').deleteMany({ userId: new mongoose.Types.ObjectId(watcher.id) });
  } else {
    console.log('  (no default server configured; skipping registration case)');
  }

  await new Promise((r) => setTimeout(r, 300));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`mj_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `MJ ${stamp}` });
  // clean any default-server membership for our seeded/registered users
  const leftover = await mongoose.connection.collection('users').find({ username: new RegExp(`mj`) }).toArray();
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
