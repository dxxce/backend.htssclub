/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies:
 *  - PATCH /users/me saves bio + statusMessage
 *  - GET /users/:id returns bio, statusMessage AND friendStatus vs caller
 *  - GET /users/search includes friendStatus per result
 *  - GET /auth/me returns bio + statusMessage
 *
 * Usage: node scripts/test-user-profile.js [baseUrl]
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
  const username = `up_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance: 0, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username }; u.token = mintToken(u); return u;
}

async function main() {
  console.log(`user profile test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0), seedUser(1)]);

  // update bio + statusMessage
  const upd = await api('/users/me', { method: 'PATCH', token: b.token, body: { bio: 'Thích cà phê', statusMessage: 'Đã có ngày nắng ráo...' } });
  check(upd.bio === 'Thích cà phê', 'PATCH /users/me saves bio');
  check(upd.statusMessage === 'Đã có ngày nắng ráo...', 'PATCH /users/me saves statusMessage');

  // GET /auth/me returns them
  const me = await api('/auth/me', { token: b.token });
  check(me.bio === 'Thích cà phê' && me.statusMessage === 'Đã có ngày nắng ráo...', 'GET /auth/me returns bio + statusMessage');

  // GET /users/:id returns bio/statusMessage + friendStatus=NONE
  let prof = await api(`/users/${b.id}`, { token: a.token });
  check(prof.bio === 'Thích cà phê' && prof.statusMessage === 'Đã có ngày nắng ráo...', 'GET /users/:id returns bio + statusMessage');
  check(prof.friendStatus === 'NONE', 'GET /users/:id friendStatus = NONE initially');

  // a sends request -> a sees REQUEST_SENT on b's profile
  await api('/friends/request', { method: 'POST', token: a.token, body: { userId: b.id } });
  prof = await api(`/users/${b.id}`, { token: a.token });
  check(prof.friendStatus === 'REQUEST_SENT' && prof.friendRequestId, 'GET /users/:id reflects REQUEST_SENT + requestId');
  const profFromB = await api(`/users/${a.id}`, { token: b.token });
  check(profFromB.friendStatus === 'REQUEST_RECEIVED', "b sees REQUEST_RECEIVED on a's profile");

  // search includes friendStatus
  const results = await api(`/users/search?q=up_${stamp}_1`, { token: a.token });
  const found = results.find((r) => r.id === b.id);
  check(found && found.friendStatus === 'REQUEST_SENT', 'search result includes friendStatus');
  check(found && found.statusMessage === 'Đã có ngày nắng ráo...', 'search result includes statusMessage');

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`up_${stamp}`) });
  await mongoose.connection.collection('friends').deleteMany({
    $or: [{ requesterId: new mongoose.Types.ObjectId(a.id) }, { addresseeId: new mongoose.Types.ObjectId(a.id) }],
  });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
