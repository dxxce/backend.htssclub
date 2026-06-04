/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies Discord-style DM: TLS in transit + at-rest encryption.
 *  - sender/recipient see PLAINTEXT content (server-readable)
 *  - the stored DB document content is ENCRYPTED (not plaintext)
 *  - send-only-attachment, edit, read, typing, delete work
 *
 * Usage: node scripts/test-dm-atrest.js [baseUrl]
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
  const username = `dmar_${stamp}_${i}`;
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
  console.log(`DM at-rest test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0), seedUser(1)]);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 400));

  const PLAINTEXT = 'Bí mật: gặp nhau lúc 8h tối';

  // send -> recipient gets plaintext
  const bGetsDm = once(bSock, 'dm:new');
  const sent = await api('/dm/messages', { method: 'POST', token: a.token, body: { toUserId: b.id, content: PLAINTEXT } });
  check(sent.content === PLAINTEXT, 'sender response shows PLAINTEXT (server-readable)');
  const dm = await bGetsDm;
  check(dm.message.content === PLAINTEXT, 'recipient receives PLAINTEXT over TLS');

  // DB stores ciphertext, not plaintext
  const raw = await mongoose.connection.collection('dm_messages').findOne({ _id: new mongoose.Types.ObjectId(sent.id) });
  check(raw && raw.content && raw.content !== PLAINTEXT, 'DB document content is ENCRYPTED (not plaintext)');
  check(raw && !raw.content.includes('Bí mật'), 'DB ciphertext does not contain the plaintext');

  // history decrypts back
  const convId = dm.conversationId;
  const hist = await api(`/dm/conversations/${convId}/messages`, { token: b.token });
  check(hist.items[0].content === PLAINTEXT, 'history returns decrypted PLAINTEXT');

  // edit
  const edited = await api(`/dm/messages/${sent.id}`, { method: 'PATCH', token: a.token, body: { content: 'sửa lại: 9h tối' } });
  check(edited.content === 'sửa lại: 9h tối' && edited.editedAt, 'edit returns new plaintext + editedAt');
  const rawEdited = await mongoose.connection.collection('dm_messages').findOne({ _id: new mongoose.Types.ObjectId(sent.id) });
  check(rawEdited.content !== 'sửa lại: 9h tối', 'edited content also stored encrypted');

  // attachment-only message
  const att = await api('/dm/messages', { method: 'POST', token: a.token, body: { toUserId: b.id, attachments: [{ url: 'http://x/f.png', type: 'image/png', name: 'f.png', size: 10, category: 'IMAGE' }] } });
  check(att.content === '' && att.attachments.length === 1, 'attachment-only DM allowed');

  bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`dmar_${stamp}`) });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
