/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies that a coin transfer posts a non-deletable SYSTEM message into
 * the DM between the two users, delivered realtime to both.
 *
 * Usage: node scripts/test-transfer-system-dm.js [baseUrl]
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

async function api(p, { method = 'GET', token, body, expectError } = {}) {
  const res = await fetch(`${API}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectError) return { status: res.status, json };
  if (!res.ok || json.success === false) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
async function seedUser(i, balance = 0) {
  const username = `tsd_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
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
  console.log(`transfer -> system DM test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const a = await seedUser(0, 1000);
  const b = await seedUser(1, 0);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 400));

  // transfer -> both get dm:new SYSTEM message
  const aGetsDm = once(aSock, 'dm:new');
  const bGetsDm = once(bSock, 'dm:new');
  await api('/wallet/transfer', { method: 'POST', token: a.token, body: { toUserId: b.id, amount: 300, note: 'mừng tuổi' } });
  const da = await aGetsDm;
  const db = await bGetsDm;
  check(da && da.message.type === 'SYSTEM', 'sender receives SYSTEM dm:new');
  check(db && db.message.type === 'SYSTEM', 'recipient receives SYSTEM dm:new');
  check(db && db.message.systemData && db.message.systemData.kind === 'COIN_TRANSFER', 'systemData.kind = COIN_TRANSFER');
  check(db && db.message.systemData.amount === 300, 'systemData has amount=300');
  check(db && /300 xu/.test(db.message.content) && /mừng tuổi/.test(db.message.content), 'system content shows amount + note');

  const convId = db.conversationId;
  const sysMsgId = db.message.id;

  // history shows the SYSTEM message
  const hist = await api(`/dm/conversations/${convId}/messages`, { token: b.token });
  const sys = hist.items.find((m) => m.id === sysMsgId);
  check(sys && sys.type === 'SYSTEM', 'history contains the SYSTEM message');

  // cannot delete it
  const del = await api(`/dm/messages/${sysMsgId}`, { method: 'DELETE', token: a.token, expectError: true });
  check(del.status === 403, `SYSTEM message cannot be deleted (got ${del.status})`);

  // cannot edit it
  const edit = await api(`/dm/messages/${sysMsgId}`, { method: 'PATCH', token: a.token, body: { content: 'hack' }, expectError: true });
  check(edit.status === 403, `SYSTEM message cannot be edited (got ${edit.status})`);

  // DB stores systemData in plaintext (not encrypted) for display
  const raw = await mongoose.connection.collection('dm_messages').findOne({ _id: new mongoose.Types.ObjectId(sysMsgId) });
  check(raw && raw.type === 'SYSTEM' && raw.systemData && raw.systemData.amount === 300, 'DB SYSTEM doc keeps structured systemData');

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`tsd_${stamp}`) });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('transactions').deleteMany({ $or: [{ userId: new mongoose.Types.ObjectId(a.id) }, { userId: new mongoose.Types.ObjectId(b.id) }] });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
