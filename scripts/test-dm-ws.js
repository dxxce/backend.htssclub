/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies DM over WebSocket: dm:send, dm:typing:start/stop, dm:read.
 * Usage: node scripts/test-dm-ws.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const WS = `${BASE}/ws`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
async function seedUser(i) {
  const username = `dmws_${stamp}_${i}`;
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
const emitAck = (sock, ev, payload) => new Promise((resolve) => sock.emit(ev, payload, resolve));

async function main() {
  console.log(`DM WS test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0), seedUser(1)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 400));

  // dm:send over WS -> b gets dm:new
  const bGetsDm = once(bSock, 'dm:new');
  const sent = await emitAck(aSock, 'dm:send', {
    toUserId: b.id, ciphertexts: { [b.id]: 'C_B', [a.id]: 'C_A' }, algorithm: 'x25519',
  });
  check(sent && sent.ciphertexts && sent.ciphertexts[b.id] === 'C_B', 'dm:send (WS) returns stored ciphertext');
  const dm = await bGetsDm;
  check(dm && dm.message.ciphertexts[b.id] === 'C_B', 'recipient got dm:new via WS');
  const convId = dm.conversationId;

  // typing start -> b gets dm:typing isTyping=true
  const bTyping = once(bSock, 'dm:typing');
  await emitAck(aSock, 'dm:typing:start', { conversationId: convId });
  const t = await bTyping;
  check(t && t.userId === a.id && t.isTyping === true, 'dm:typing:start -> dm:typing(true)');

  // typing stop -> isTyping=false
  const bTypingStop = once(bSock, 'dm:typing');
  await emitAck(aSock, 'dm:typing:stop', { conversationId: convId });
  const t2 = await bTypingStop;
  check(t2 && t2.isTyping === false, 'dm:typing:stop -> dm:typing(false)');

  // read over WS -> a gets dm:read
  const aRead = once(aSock, 'dm:read');
  await emitAck(bSock, 'dm:read', { conversationId: convId });
  const rr = await aRead;
  check(rr && rr.byUserId === b.id, 'dm:read (WS) -> sender gets read receipt');

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 400));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`dmws_${stamp}`) });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
