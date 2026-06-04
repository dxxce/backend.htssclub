/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies leveling + leaderboards:
 *  - addXp via internal seed -> level/progress endpoints
 *  - level:up + level:xp realtime events when crossing a threshold
 *  - leaderboard (xp + coins), /both, and /me rank
 *
 * Usage: node scripts/test-leveling.js [baseUrl]
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
async function seedUser(i, { xp = 0, level = 1, balance = 0 } = {}) {
  const username = `lv_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance, xp, level, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
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
  console.log(`leveling test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  // Distinct values so ranking is deterministic.
  const a = await seedUser(0, { xp: 1000, level: 5, balance: 50 });   // top XP
  const b = await seedUser(1, { xp: 300, level: 3, balance: 99999 }); // top coins
  const c = await seedUser(2, { xp: 90, level: 1, balance: 10 });     // near a level-up

  // my level progress
  const prog = await api('/users/me/level', { token: a.token });
  check(prog.level === 5 && prog.xp === 1000, 'GET /users/me/level returns level 5, xp 1000');
  check(prog.xpForNextLevel === 500 && prog.xpToNextLevel === 500, 'progress span/to-next correct at level 5');

  // leaderboard xp -> a should be #1 among our trio (assuming seeded high)
  const lbXp = await api('/leaderboard?type=xp&limit=100', { token: a.token });
  const aXpRank = lbXp.find((e) => e.userId === a.id);
  const bXpRank = lbXp.find((e) => e.userId === b.id);
  check(aXpRank && bXpRank && aXpRank.rank < bXpRank.rank, 'XP leaderboard ranks higher-XP user above lower');
  check(aXpRank && aXpRank.score === 1000 && aXpRank.level === 5, 'XP entry has score + level');

  // leaderboard coins -> b should outrank a
  const lbCoins = await api('/leaderboard?type=coins&limit=100', { token: a.token });
  const aCoin = lbCoins.find((e) => e.userId === a.id);
  const bCoin = lbCoins.find((e) => e.userId === b.id);
  check(bCoin && aCoin && bCoin.rank < aCoin.rank, 'coins leaderboard ranks higher-balance user above');
  check(bCoin && bCoin.score === 99999, 'coins entry score = balance');

  // both in one call
  const both = await api('/leaderboard/both?limit=100', { token: a.token });
  check(Array.isArray(both.xp) && Array.isArray(both.coins), '/leaderboard/both returns { xp, coins }');

  // my rank
  const myXpRank = await api('/leaderboard/me?type=xp', { token: a.token });
  check(myXpRank && myXpRank.userId === a.id && myXpRank.rank >= 1, '/leaderboard/me returns my rank');

  // realtime: c2 is near level-up; sending one message grants +5 XP and
  // should cross 100 XP -> level 2.
  const c2 = await seedUser(3, { xp: 96, level: 1, balance: 0 });
  const server = await api('/servers', { method: 'POST', token: c2.token, body: { name: `LV ${stamp}` } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: c2.token, body: { name: 'general', type: 'TEXT' } });

  const cSock = await connect(c2.token);
  const cXp = once(cSock, 'level:xp');
  const cUp = once(cSock, 'level:up');
  await new Promise((r) => setTimeout(r, 300));
  await api(`/channels/${channel.id}/messages`, { method: 'POST', token: c2.token, body: { content: 'hello world' } });

  const xpEvt = await cXp;
  const upEvt = await cUp;
  check(xpEvt && xpEvt.gained === 5, 'message grants XP -> level:xp event (gained 5)');
  check(upEvt && upEvt.level === 2 && upEvt.previousLevel === 1, 'crossing threshold fires level:up (1 -> 2)');
  cSock.disconnect();

  await mongoose.connection.collection('servers').deleteMany({ name: `LV ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.connection.collection('messages').deleteMany({ channelId: new mongoose.Types.ObjectId(channel.id) });

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`lv_${stamp}`) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
