/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies realtime profile/server sync:
 *  - When a member updates their displayName/avatar, other members in the
 *    same server receive `user:updated`.
 *  - When an admin updates the server name/icon, members receive
 *    `server:updated`.
 *
 * Usage: node scripts/test-profile-sync.js [baseUrl]
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
  const username = `ps_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Old ${i}`,
    avatarUrl: `http://x/old${i}.png`, balance: 0, status: 'ACTIVE', presence: 'OFFLINE',
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
  console.log(`Profile sync test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [owner, member] = await Promise.all([seedUser(0), seedUser(1)]);
  const server = await api('/servers', { method: 'POST', token: owner.token, body: { name: `PS ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: owner.token });
  await api('/servers/join', { method: 'POST', token: member.token, body: { inviteCode: invite.inviteCode } });

  // Both connect to chat; gateway auto-joins their server rooms.
  const ownerSock = await connect(owner.token);
  const memberSock = await connect(member.token);
  await new Promise((r) => setTimeout(r, 400));

  // 1) Member updates profile -> owner should receive user:updated.
  const ownerGetsUserUpdate = once(ownerSock, 'user:updated');
  const updated = await api('/users/me', { method: 'PATCH', token: member.token, body: { displayName: 'New Name', avatarUrl: 'http://x/new.png' } });
  check(updated.displayName === 'New Name', 'member profile updated via REST');
  const uu = await ownerGetsUserUpdate;
  check(uu && uu.user && uu.user.id === member.id, 'owner received user:updated for the member');
  check(uu && uu.user.displayName === 'New Name' && uu.user.avatarUrl === 'http://x/new.png', 'user:updated carries new name + avatar');
  check(uu && uu.serverId === server.id, 'user:updated includes serverId');

  // 2) Owner (admin) updates server name/icon -> member receives server:updated.
  const memberGetsServerUpdate = once(memberSock, 'server:updated');
  await api(`/servers/${server.id}`, { method: 'PATCH', token: owner.token, body: { name: 'Renamed Server', iconUrl: 'http://x/icon.png' } });
  const su = await memberGetsServerUpdate;
  check(su && su.id === server.id, 'member received server:updated');
  check(su && su.name === 'Renamed Server' && su.iconUrl === 'http://x/icon.png', 'server:updated carries new name + icon');

  ownerSock.disconnect();
  memberSock.disconnect();
  await new Promise((r) => setTimeout(r, 400));

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`ps_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ _id: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
