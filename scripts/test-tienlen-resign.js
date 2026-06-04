/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Regression test: in a 2-player Tiến Lên RANKED game, the player who RESIGNS
 * must LOSE (be placed last), and the opponent must WIN. Also verifies a clear
 * error message comes back when joining a room with a bad code.
 *
 * Usage: node scripts/test-tienlen-resign.js [baseUrl]
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
  const username = `tlr_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `TLR ${i}`,
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
async function getRp(id) {
  const u = await mongoose.connection.collection('users').findOne({ _id: new mongoose.Types.ObjectId(id) });
  return u ? u.rankPoints : null;
}

async function main() {
  console.log(`Tiến Lên RESIGN test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0, 1000), seedUser(1, 1000)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 300));

  // ── Bad room code returns a clear error (not a silent failure) ──
  const badJoin = await emitAck(aSock, 'tienlen:room:join', { code: 'TL-NOPE' });
  check(badJoin && badJoin.success === false && badJoin.error, 'bad code -> ack carries error envelope');
  check(badJoin && badJoin.error && /code/i.test(badJoin.error.message), 'error message mentions the code');

  // ── Matchmake a 2-player ranked game ───────────────────────────
  const aMatched = once(aSock, 'tienlen:matched', 6000);
  const bMatched = once(bSock, 'tienlen:matched', 6000);
  await emitAck(aSock, 'tienlen:queue:join', { size: 2 });
  const bQ = await emitAck(bSock, 'tienlen:queue:join', { size: 2 });
  check(bQ && bQ.matched && bQ.gameId, 'matched into a game');
  const gameId = bQ.gameId;
  await aMatched; await bMatched;
  await emitAck(aSock, 'tienlen:join', { gameId });
  await emitAck(bSock, 'tienlen:join', { gameId });

  // ── A resigns -> A must LOSE, B must WIN ───────────────────────
  const endA = once(aSock, 'tienlen:end', 6000);
  await emitAck(aSock, 'tienlen:resign', { gameId });
  const end = await endA;
  check(!!end && end.status === 'FINISHED', 'game finished after resign');
  // finishOrder: first place first. Winner must be B, loser (last) must be A.
  const seatA = end.players.find((p) => p.userId === a.id).seat;
  const seatB = end.players.find((p) => p.userId === b.id).seat;
  check(end.finishOrder[0] === seatB, 'opponent (B) is 1st place (winner)');
  check(end.finishOrder[end.finishOrder.length - 1] === seatA, 'resigner (A) is last place');

  // RP: resigner loses, opponent gains.
  await new Promise((r) => setTimeout(r, 400));
  const rpA = await getRp(a.id), rpB = await getRp(b.id);
  check(rpA < 1000, `resigner A lost RP (${rpA} < 1000)`);
  check(rpB > 1000, `winner B gained RP (${rpB} > 1000)`);

  aSock.disconnect(); bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));
  const ids = [a.id, b.id].map((x) => new mongoose.Types.ObjectId(x));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`tlr_${stamp}`) });
  await mongoose.connection.collection('tienlen_games').deleteMany({ 'seats.userId': { $in: ids } });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
