/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Integration test for Tiến Lên challenge INVITE flow + rank cards in queue.
 * Covers: tienlen:challenge -> invitee gets tienlen:challenge-received ->
 * decline -> challenger notified; then accept -> both get a 2-player game.
 * Also checks the matchmaking queue snapshot includes player rank cards.
 *
 * Usage: node scripts/test-tienlen-challenge.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const WS = `${BASE}/ws-tienlen`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

const mintToken = (u) =>
  jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });

async function seedUser(i, rp) {
  const username = `tlch_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `TLCh ${i}`,
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
  console.log(`Tiến Lên CHALLENGE test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0, 1200), seedUser(1, 900)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 300));

  // ── Rank cards in queue snapshot ───────────────────────────────
  await emitAck(aSock, 'tienlen:lobby:join', {});
  await emitAck(aSock, 'tienlen:queue:join', { size: 4 }); // A waits alone
  const snap = await emitAck(bSock, 'tienlen:queue:count', {});
  check(snap && snap.players && Array.isArray(snap.players['4']), 'queue:count returns players per size');
  const aInQ = (snap.players['4'] || []).find((p) => p.userId === a.id);
  check(aInQ && aInQ.user && aInQ.user.rank, 'queued player has rank card');
  await emitAck(aSock, 'tienlen:queue:leave', {});

  // ── Challenge: send -> receive ─────────────────────────────────
  const bRecv = once(bSock, 'tienlen:challenge-received', 4000);
  const sendAck = await emitAck(aSock, 'tienlen:challenge', { opponentId: b.id, ranked: true });
  check(sendAck && sendAck.sent === true && sendAck.challengeId, 'A sent challenge');
  const invite = await bRecv;
  check(invite && invite.challengeId === sendAck.challengeId, 'B received tienlen:challenge-received');
  check(invite && invite.from && invite.from.id === a.id, 'invite includes challenger card');

  const noGameYet = await mongoose.connection.collection('tienlen_games').countDocuments({
    'seats.userId': new mongoose.Types.ObjectId(a.id),
  });
  check(noGameYet === 0, 'no game created before acceptance');

  // ── Decline ────────────────────────────────────────────────────
  const aDeclined = once(aSock, 'tienlen:challenge-declined', 4000);
  await emitAck(bSock, 'tienlen:challenge:decline', { challengeId: invite.challengeId });
  const decl = await aDeclined;
  check(decl && decl.challengeId === invite.challengeId, 'A notified of decline');

  // ── Accept ─────────────────────────────────────────────────────
  const bRecv2 = once(bSock, 'tienlen:challenge-received', 4000);
  const send2 = await emitAck(aSock, 'tienlen:challenge', { opponentId: b.id, ranked: true });
  const invite2 = await bRecv2;
  const aAccepted = once(aSock, 'tienlen:challenge-accepted', 4000);
  const aMatched = once(aSock, 'tienlen:matched', 4000);
  const bMatched = once(bSock, 'tienlen:matched', 4000);
  const accAck = await emitAck(bSock, 'tienlen:challenge:accept', { challengeId: invite2.challengeId });
  check(accAck && accAck.gameId, 'B accepted -> got gameId');
  const acc = await aAccepted;
  check(acc && acc.gameId === accAck.gameId, 'A notified of acceptance');
  const mA = await aMatched, mB = await bMatched;
  check(mA && mA.id === accAck.gameId && mA.myHand && mA.myHand.length === 13, 'A got matched + 13 cards');
  check(mB && mB.myHand.length === 13, 'B got matched + 13 cards');
  check(mA && mA.mode === 'RANKED', 'challenge game is RANKED');

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  const ids = [a.id, b.id].map((x) => new mongoose.Types.ObjectId(x));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`tlch_${stamp}`) });
  await mongoose.connection.collection('tienlen_games').deleteMany({ 'seats.userId': { $in: ids } });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
