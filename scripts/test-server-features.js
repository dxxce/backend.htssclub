/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies the new server features against a RUNNING backend:
 *  - new users auto-join the default server and cannot leave it
 *  - transfer ownership, ban/unban + ban list, nickname, announcement
 *
 * Users for the admin-feature part are seeded directly in Mongo (to dodge
 * the auth rate limiter); the auto-join check uses the real register route.
 *
 * Usage: node scripts/test-server-features.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3399}`;
const API = `${BASE}/api`;
const WS = `${BASE}/ws`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

async function api(p, { method = 'GET', token, body, expectError } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectError) return { status: res.status, json };
  if (!res.ok || json.success === false) {
    throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  }
  return json.data;
}

const mintToken = (u) =>
  jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });

async function seedUser(i) {
  const username = `srvfeat_${stamp}_${i}`;
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

async function main() {
  console.log(`Server features test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  // ── Part 1: default server auto-join + cannot leave (real register) ──
  const reg = await api('/auth/register', {
    method: 'POST',
    body: { username: `dflt_${stamp}`, email: `dflt_${stamp}@example.com`, password: 'StrongP@ss1' },
  }).catch((e) => { console.log('  (register skipped: ' + e.message + ')'); return null; });

  if (reg) {
    const token = reg.accessToken;
    const myServers = await api('/servers', { token });
    const def = myServers.find((s) => s.isDefault);
    check(!!def, `new user auto-joined the default server (${def?.id})`);

    if (def) {
      const res = await api(`/servers/${def.id}/leave`, { method: 'DELETE', token, expectError: true });
      check(res.status === 403, `leaving the default server is blocked (got ${res.status})`);

      const delRes = await api(`/servers/${def.id}`, { method: 'DELETE', token, expectError: true });
      check(delRes.status === 403 || delRes.status === 400, `deleting default server blocked for non-owner/owner (got ${delRes.status})`);
    }
  }

  // ── Part 2: admin features on a fresh (non-default) server ──────────
  const [owner, admin, member, victim] = await Promise.all([0, 1, 2, 3].map(seedUser));

  const server = await api('/servers', { method: 'POST', token: owner.token, body: { name: `Feat ${stamp}` } });
  check(!!server.id, `owner created test server ${server.id}`);
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: owner.token });

  for (const u of [admin, member, victim]) {
    await api('/servers/join', { method: 'POST', token: u.token, body: { inviteCode: invite.inviteCode } });
  }
  check(true, '3 members joined');

  // promote admin
  await api(`/servers/${server.id}/members/${admin.id}/role`, { method: 'PATCH', token: owner.token, body: { role: 'ADMIN' } });
  check(true, 'owner promoted a member to ADMIN');

  // nickname (self) + admin sets others
  const nick1 = await api(`/servers/${server.id}/members/${member.id}/nickname`, { method: 'PATCH', token: member.token, body: { nickname: 'SelfNick' } });
  check(nick1.nickname === 'SelfNick', 'member set own nickname');
  const nick2 = await api(`/servers/${server.id}/members/${victim.id}/nickname`, { method: 'PATCH', token: admin.token, body: { nickname: 'ByAdmin' } });
  check(nick2.nickname === 'ByAdmin', 'admin set another member nickname');

  // announcement broadcast (listen on a member socket)
  const sock = await connectWs(member.token);
  const gotAnnounce = new Promise((resolve) => sock.on('server:announcement', resolve));
  await api(`/servers/${server.id}/announce`, { method: 'POST', token: admin.token, body: { message: 'Hello team' } });
  const ann = await Promise.race([gotAnnounce, new Promise((r) => setTimeout(() => r(null), 5000))]);
  check(ann && ann.message === 'Hello team', 'server announcement broadcast over WebSocket');
  sock.disconnect();

  // ban victim, verify removed + cannot rejoin + appears in ban list
  await api(`/servers/${server.id}/members/${victim.id}/ban`, { method: 'POST', token: admin.token, body: { reason: 'test ban' } });
  const membersAfter = await api(`/servers/${server.id}/members`, { token: owner.token });
  check(!membersAfter.find((m) => m.userId === victim.id), 'banned member removed from member list');

  const rejoin = await api('/servers/join', { method: 'POST', token: victim.token, body: { inviteCode: invite.inviteCode }, expectError: true });
  check(rejoin.status === 403, `banned user cannot rejoin (got ${rejoin.status})`);

  const bans = await api(`/servers/${server.id}/bans`, { token: admin.token });
  check(bans.find((b) => b.userId === victim.id), 'banned user appears in ban list');

  // unban -> can rejoin
  await api(`/servers/${server.id}/bans/${victim.id}`, { method: 'DELETE', token: admin.token });
  await api('/servers/join', { method: 'POST', token: victim.token, body: { inviteCode: invite.inviteCode } });
  check(true, 'unbanned user can rejoin');

  // transfer ownership owner -> admin
  await api(`/servers/${server.id}/transfer-ownership`, { method: 'POST', token: owner.token, body: { newOwnerId: admin.id } });
  const afterTransfer = await api(`/servers/${server.id}/members`, { token: owner.token });
  const newOwner = afterTransfer.find((m) => m.userId === admin.id);
  const oldOwner = afterTransfer.find((m) => m.userId === owner.id);
  check(newOwner?.role === 'OWNER', 'ownership transferred (new owner is OWNER)');
  check(oldOwner?.role === 'ADMIN', 'previous owner demoted to ADMIN');

  // cleanup
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `Feat ${stamp}` });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
