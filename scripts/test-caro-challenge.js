/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Integration test for Caro challenge INVITE flow + rank cards in queue.
 * Covers: caro:challenge -> invitee gets caro:challenge-received -> decline
 * (challenger gets caro:challenge-declined), then accept -> both get game.
 * Also checks the matchmaking queue snapshot includes player rank cards.
 *
 * Usage: node scripts/test-caro-challenge.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const WS = `${BASE}/ws-caro`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

const mintToken = (u) =>
  jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });

async function seedUser(i, rp) {
  const username = `caroch_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `CaroCh ${i}`,
    balance: 0, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, xp: 0, rankPoints: rp, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username, rp }; u.token = mintToken(u); return u;
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
const emitAck = (sock, ev, payload, ms = 6000) =>
  new Promise((resolve) => {
    let done = false; const finish = (v) => { if (!done) { done = true; resolve(v); } };
    sock.emit(ev, payload, finish); setTimeout(() => finish(null), ms);
  });

async function main() {
  console.log(`Caro CHALLENGE test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0, 1500), seedUser(1, 800)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 300));

  // ── Rank cards in queue snapshot ───────────────────────────────
  await emitAck(aSock, 'caro:lobby:join', {});
  await emitAck(aSock, 'caro:queue:join', {}); // A waits (alone) -> queued
  const snap = await emitAck(bSock, 'caro:queue:count', {});
  check(snap && Array.isArray(snap.players), 'queue:count returns players array');
  const aInQueue = snap.players.find((p) => p.userId === a.id);
  check(aInQueue && aInQueue.user && aInQueue.user.rank, 'queued player has rank card');
  check(aInQueue && typeof aInQueue.rankPoints === 'number', 'queued player has rankPoints');
  await emitAck(aSock, 'caro:queue:leave', {});

  // ── Challenge: send -> invitee receives ────────────────────────
  const bRecv = once(bSock, 'caro:challenge-received', 4000);
  const sendAck = await emitAck(aSock, 'caro:challenge', { opponentId: b.id, ranked: false });
  check(sendAck && sendAck.sent === true && sendAck.challengeId, 'A sent challenge (got challengeId)');
  const invite = await bRecv;
  check(invite && invite.challengeId === sendAck.challengeId, 'B received caro:challenge-received');
  check(invite && invite.from && invite.from.id === a.id, 'invite includes challenger card');

  // No game should exist yet (invite pending, not accepted).
  const noGameYet = await mongoose.connection.collection('caro_games').countDocuments({
    $or: [{ playerX: new mongoose.Types.ObjectId(a.id) }, { playerO: new mongoose.Types.ObjectId(a.id) }],
  });
  check(noGameYet === 0, 'no game created before acceptance');

  // ── Decline path ───────────────────────────────────────────────
  const aDeclined = once(aSock, 'caro:challenge-declined', 4000);
  await emitAck(bSock, 'caro:challenge:decline', { challengeId: invite.challengeId });
  const decl = await aDeclined;
  check(decl && decl.challengeId === invite.challengeId, 'A notified of decline');

  // ── Accept path (new challenge) ────────────────────────────────
  const bRecv2 = once(bSock, 'caro:challenge-received', 4000);
  const send2 = await emitAck(aSock, 'caro:challenge', { opponentId: b.id, ranked: false });
  const invite2 = await bRecv2;
  check(invite2 && invite2.challengeId === send2.challengeId, 'second invite received');

  const aAccepted = once(aSock, 'caro:challenge-accepted', 4000);
  const aMatched = once(aSock, 'caro:matched', 4000);
  const bMatched = once(bSock, 'caro:matched', 4000);
  const accAck = await emitAck(bSock, 'caro:challenge:accept', { challengeId: invite2.challengeId });
  check(accAck && accAck.gameId, 'B accepted -> got gameId');
  const acc = await aAccepted;
  check(acc && acc.gameId === accAck.gameId, 'A notified of acceptance with gameId');
  const mA = await aMatched, mB = await bMatched;
  check(mA && mA.id === accAck.gameId, 'A got caro:matched');
  check(mB && mB.id === accAck.gameId, 'B got caro:matched');
  check(mA && mA.mode === 'CASUAL', 'challenge game is CASUAL (ranked:false)');

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  const ids = [a.id, b.id].map((x) => new mongoose.Types.ObjectId(x));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`caroch_${stamp}`) });
  await mongoose.connection.collection('caro_games').deleteMany({ $or: [{ playerX: { $in: ids } }, { playerO: { $in: ids } }] });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
