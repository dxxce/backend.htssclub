/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies the RANK system (independent of XP/level):
 *  - /users/me/rank, /users/:id/rank derive tier/division from rankPoints
 *  - rank leaderboard sorts by rankPoints (NOT xp)
 *  - /leaderboard/both includes xp + coins + rank
 *  - user profile carries `rank` + `rankPoints` separate from level/xp
 *
 * Usage: node scripts/test-rank.js [baseUrl]
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

async function api(p, { token } = {}) {
  const res = await fetch(`${API}${p}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
async function seedUser(i, { xp = 0, rankPoints = 0 } = {}) {
  const username = `rk_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance: 0, xp, level: 1, rankPoints, status: 'ACTIVE', presence: 'OFFLINE',
    desiredPresence: 'ONLINE', isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username }; u.token = mintToken(u); return u;
}

async function main() {
  console.log(`rank test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  // a: low XP but HIGH rank; b: high XP but LOW rank -> proves independence.
  const a = await seedUser(0, { xp: 50, rankPoints: 450 });   // Silver IV
  const b = await seedUser(1, { xp: 99999, rankPoints: 10 }); // Bronze IV

  // my rank tier
  const ra = await api('/users/me/rank', { token: a.token });
  check(ra.tier === 'SILVER' && ra.division === 4 && ra.label === 'Bạc IV', 'a rank = Bạc IV from 450 RP');
  const rb = await api('/users/me/rank', { token: b.token });
  check(rb.tier === 'BRONZE' && rb.label === 'Đồng IV', 'b rank = Đồng IV from 10 RP (despite huge XP)');

  // rank is INDEPENDENT of XP: b has way more XP but lower rank
  check(ra.rp === 450 && rb.rp === 10, 'rank uses rankPoints, not xp');

  // rank leaderboard: a (450 RP) above b (10 RP)
  const lbRank = await api('/leaderboard?type=rank&limit=100', { token: a.token });
  const aR = lbRank.find((e) => e.userId === a.id);
  const bR = lbRank.find((e) => e.userId === b.id);
  check(aR && bR && aR.rank < bR.rank, 'rank leaderboard: higher RP ranks above (a above b)');
  check(aR && aR.score === 450 && aR.tier && aR.tier.label === 'Bạc IV', 'rank entry has score=RP + tier label');

  // xp leaderboard: b above a (independence cross-check)
  const lbXp = await api('/leaderboard?type=xp&limit=100', { token: a.token });
  const aX = lbXp.find((e) => e.userId === a.id);
  const bX = lbXp.find((e) => e.userId === b.id);
  check(bX && aX && bX.rank < aX.rank, 'xp leaderboard: b (high XP) above a — independent from rank');

  // both includes all three
  const both = await api('/leaderboard/both?limit=100', { token: a.token });
  check(both.xp && both.coins && both.rank, '/leaderboard/both has xp + coins + rank');

  // profile carries rank + rankPoints separate from level/xp
  const prof = await api(`/users/${a.id}`, { token: b.token });
  check(prof.rankPoints === 450 && prof.rank && prof.rank.label === 'Bạc IV', 'user profile has rank + rankPoints');
  check(prof.level === 1 && prof.xp === 50, 'profile still has independent level/xp');

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`rk_${stamp}`) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
