/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies the "received a new DM" experience:
 *  - dm:new carries `from` (sender card) + `unread` count for the recipient
 *  - a persistent notification (DM_MESSAGE) is created for the recipient
 *  - unread-count endpoint reflects it (offline user sees it on next login)
 *
 * Usage: node scripts/test-dm-newmsg.js [baseUrl]
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
  const username = `dmn_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance: 0, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
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
  console.log(`DM new-message UX test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0), seedUser(1)]);

  // b is "online" listening; a is offline (no socket)
  const bSock = await connect(b.token);
  const bNotif = once(bSock, 'notification:new');
  const bDm = once(bSock, 'dm:new');
  await new Promise((r) => setTimeout(r, 400));

  await api('/dm/messages', { method: 'POST', token: a.token, body: { toUserId: b.id, content: 'chào bạn' } });

  const dm = await bDm;
  check(dm && dm.from && dm.from.id === a.id, 'dm:new carries sender card (from)');
  check(dm && dm.from.displayName === 'Disp 0', 'sender card has displayName');
  check(dm && dm.unread === 1, 'dm:new carries recipient unread=1');

  const notif = await bNotif;
  check(notif && notif.type === 'DM_MESSAGE', 'recipient gets notification:new (DM_MESSAGE)');
  check(notif && notif.payload && notif.payload.fromUserId === a.id && /chào bạn/.test(notif.payload.preview), 'notification has fromUserId + preview');

  // offline-style: unread-count endpoint reflects it
  const unread = await api('/notifications/unread-count', { token: b.token });
  check(unread.count >= 1, 'notifications unread-count >= 1 for recipient');

  bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`dmn_${stamp}`) });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('notifications').deleteMany({ userId: new mongoose.Types.ObjectId(b.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
