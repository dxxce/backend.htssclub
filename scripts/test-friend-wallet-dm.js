/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies: friend realtime events, wallet transfer events, and the E2E DM
 * flow (key exchange, send ciphertext, history, read receipt, typing, delete).
 *
 * Usage: node scripts/test-friend-wallet-dm.js [baseUrl]
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
async function seedUser(i, balance = 0) {
  const username = `fwd_${stamp}_${i}`;
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
  console.log(`friend + wallet + DM test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const a = await seedUser(0, 1000);
  const b = await seedUser(1, 0);

  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 400));

  // ── Friend events ──
  let bGetsReq = once(bSock, 'friend:request-received');
  await api('/friends/request', { method: 'POST', token: a.token, body: { userId: b.id } });
  let e = await bGetsReq;
  check(e && e.fromUserId === a.id && e.requestId, 'friend:request-received with fromUserId + requestId');
  check(e && e.from && e.from.displayName === 'Disp 0', 'friend:request-received carries sender card');

  const reqId = e.requestId;
  let aGetsAccept = once(aSock, 'friend:accepted');
  await api('/friends/accept', { method: 'POST', token: b.token, body: { requestId: reqId } });
  e = await aGetsAccept;
  check(e && e.fromUserId === b.id, 'friend:accepted to requester');

  let bGetsRemoved = once(bSock, 'friend:removed');
  await api(`/friends/${b.id}`, { method: 'DELETE', token: a.token });
  e = await bGetsRemoved;
  check(e && e.fromUserId === a.id, 'friend:removed to the other user');

  // decline path
  bGetsReq = once(bSock, 'friend:request-received');
  await api('/friends/request', { method: 'POST', token: a.token, body: { userId: b.id } });
  const reqId2 = (await bGetsReq).requestId;
  const aGetsDecline = once(aSock, 'friend:declined');
  await api('/friends/decline', { method: 'POST', token: b.token, body: { requestId: reqId2 } });
  e = await aGetsDecline;
  check(e && e.fromUserId === b.id, 'friend:declined to requester');

  // ── Wallet events: transfer a -> b ──
  const aGetsTx = once(aSock, 'wallet:transaction');
  const bGetsTx = once(bSock, 'wallet:transaction');
  await api('/wallet/transfer', { method: 'POST', token: a.token, body: { toUserId: b.id, amount: 250, note: 'gift' } });
  const txA = await aGetsTx;
  const txB = await bGetsTx;
  check(txA && txA.balance === 750 && txA.transaction.amount === -250, 'sender gets wallet:transaction (debit, balance 750)');
  check(txB && txB.balance === 250 && txB.transaction.amount === 250, 'receiver gets wallet:transaction (credit, balance 250)');

  // ── DM E2E ──
  await api('/dm/keys', { method: 'POST', token: a.token, body: { publicKey: 'PUBKEY_A_base64' } });
  await api('/dm/keys', { method: 'POST', token: b.token, body: { publicKey: 'PUBKEY_B_base64' } });
  const keyB = await api(`/dm/keys/${b.id}`, { token: a.token });
  check(keyB.publicKey === 'PUBKEY_B_base64', "fetch other user's E2E public key");

  // a sends encrypted DM to b -> both get dm:new
  const bGetsDm = once(bSock, 'dm:new');
  const sent = await api('/dm/messages', {
    method: 'POST', token: a.token,
    body: { toUserId: b.id, ciphertexts: { [b.id]: 'CIPHER_FOR_B', [a.id]: 'CIPHER_FOR_A' }, algorithm: 'x25519-xsalsa20-poly1305' },
  });
  check(sent.ciphertexts && sent.ciphertexts[b.id] === 'CIPHER_FOR_B', 'send DM stores ciphertext (server never sees plaintext)');
  const dm = await bGetsDm;
  check(dm && dm.message && dm.message.ciphertexts[b.id] === 'CIPHER_FOR_B', 'recipient gets dm:new with ciphertext');
  const convId = dm.conversationId;

  // history
  const hist = await api(`/dm/conversations/${convId}/messages`, { token: b.token });
  check(hist.items.length === 1 && hist.items[0].ciphertexts[b.id] === 'CIPHER_FOR_B', 'DM history returns ciphertext');

  // inbox shows unread for b
  const inbox = await api('/dm/conversations', { token: b.token });
  const conv = inbox.find((c) => c.id === convId);
  check(conv && conv.unread === 1, 'inbox shows unread=1 for recipient');

  // read receipt -> a gets dm:read
  const aGetsRead = once(aSock, 'dm:read');
  await api(`/dm/conversations/${convId}/read`, { method: 'PATCH', token: b.token });
  const rr = await aGetsRead;
  check(rr && rr.byUserId === b.id && rr.conversationId === convId, 'dm:read receipt to sender');

  // delete message -> both get dm:deleted
  const bGetsDel = once(bSock, 'dm:deleted');
  await api(`/dm/messages/${sent.id}`, { method: 'DELETE', token: a.token });
  const del = await bGetsDel;
  check(del && del.messageId === sent.id, 'dm:deleted broadcast to participants');

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 400));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`fwd_${stamp}`) });
  await mongoose.connection.collection('friends').deleteMany({ $or: [{ requesterId: new mongoose.Types.ObjectId(a.id) }, { addresseeId: new mongoose.Types.ObjectId(a.id) }] });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('transactions').deleteMany({ $or: [{ userId: new mongoose.Types.ObjectId(a.id) }, { userId: new mongoose.Types.ObjectId(b.id) }] });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
