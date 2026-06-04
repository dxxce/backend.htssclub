/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies level + rank cosmetics appear on author cards in:
 *  - server channel messages (author + replyTo.author)
 *  - direct messages (dm:new from card)
 *
 * Usage: node scripts/test-card-levelrank.js [baseUrl]
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
async function seedUser(i, { xp = 0, level = 1, rankPoints = 0 } = {}) {
  const username = `clr_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance: 0, xp, level, rankPoints, status: 'ACTIVE', presence: 'OFFLINE',
    desiredPresence: 'ONLINE', isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
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

function hasBadge(card) {
  return card && typeof card.level === 'number' && card.levelStyle && card.levelStyle.shape && card.rank && card.rank.label;
}

async function main() {
  console.log(`card level/rank test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const a = await seedUser(0, { xp: 1000, level: 5, rankPoints: 900 }); // L5, Vàng
  const b = await seedUser(1, { xp: 100, level: 2, rankPoints: 50 });

  // server message author carries level + rank
  const server = await api('/servers', { method: 'POST', token: a.token, body: { name: `CLR ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: a.token });
  await api('/servers/join', { method: 'POST', token: b.token, body: { inviteCode: invite.inviteCode } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: a.token, body: { name: 'general', type: 'TEXT' } });

  const m1 = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: a.token, body: { content: 'hi' } });
  check(hasBadge(m1.author), 'server message author has level + levelStyle + rank');
  check(m1.author.level === 5 && m1.author.rank.tier === 'GOLD', 'author level=5, rank tier GOLD');

  // reply -> replyTo.author also enriched
  const m2 = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: b.token, body: { content: 'reply', replyToId: m1.id } });
  check(hasBadge(m2.replyTo.author), 'replyTo.author has level + rank');

  // DM author card via dm:new
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 400));
  const bGetsDm = once(bSock, 'dm:new');
  await api('/dm/messages', { method: 'POST', token: a.token, body: { toUserId: b.id, content: 'hey' } });
  const dm = await bGetsDm;
  check(hasBadge(dm.from), 'DM dm:new "from" card has level + rank');
  check(dm.from.level === 5 && dm.from.rank.label === 'Vàng IV' || dm.from.rank.tier === 'GOLD', 'DM from card shows correct tier');

  // inbox otherUser card
  const inbox = await api('/dm/conversations', { token: b.token });
  const conv = inbox.find((c) => c.otherUser.id === a.id);
  check(conv && hasBadge(conv.otherUser), 'DM inbox otherUser card has level + rank');

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`clr_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `CLR ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.connection.collection('messages').deleteMany({ channelId: new mongoose.Types.ObjectId(channel.id) });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
