/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies GET /friends/status/:userId returns the correct relationship
 * status from the caller's perspective across the lifecycle.
 *
 * Usage: node scripts/test-friend-status.js [baseUrl]
 */
const path = require('path');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const API = `${BASE}/api`;
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
  const username = `fs_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance: 0, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username }; u.token = mintToken(u); return u;
}
const statusOf = (me, other) => api(`/friends/status/${other.id}`, { token: me.token });

async function main() {
  console.log(`friend status test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0), seedUser(1)]);

  // self
  check((await statusOf(a, a)).status === 'SELF', 'status with self = SELF');

  // none
  check((await statusOf(a, b)).status === 'NONE', 'no relationship = NONE');

  // a sends request to b
  await api('/friends/request', { method: 'POST', token: a.token, body: { userId: b.id } });
  check((await statusOf(a, b)).status === 'REQUEST_SENT', 'sender sees REQUEST_SENT');
  check((await statusOf(b, a)).status === 'REQUEST_RECEIVED', 'receiver sees REQUEST_RECEIVED');

  // b accepts
  const reqId = (await statusOf(b, a)).requestId;
  await api('/friends/accept', { method: 'POST', token: b.token, body: { requestId: reqId } });
  check((await statusOf(a, b)).status === 'FRIENDS', 'A sees FRIENDS after accept');
  check((await statusOf(b, a)).status === 'FRIENDS', 'B sees FRIENDS after accept');

  // a removes friend
  await api(`/friends/${b.id}`, { method: 'DELETE', token: a.token });
  check((await statusOf(a, b)).status === 'NONE', 'back to NONE after unfriend');

  // a blocks b
  await api('/friends/block', { method: 'POST', token: a.token, body: { userId: b.id } });
  check((await statusOf(a, b)).status === 'BLOCKED', 'A (blocker) sees BLOCKED');
  check((await statusOf(b, a)).status === 'BLOCKED_BY', 'B (blocked) sees BLOCKED_BY');

  // a unblocks
  await api(`/friends/block/${b.id}`, { method: 'DELETE', token: a.token });
  check((await statusOf(a, b)).status === 'NONE', 'NONE after unblock');

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`fs_${stamp}`) });
  await mongoose.connection.collection('friends').deleteMany({
    $or: [{ requesterId: new mongoose.Types.ObjectId(a.id) }, { addresseeId: new mongoose.Types.ObjectId(a.id) }],
  });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
