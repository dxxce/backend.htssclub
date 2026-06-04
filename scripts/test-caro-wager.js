/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Integration test for Caro WAGER rooms + live queue count.
 * Covers: room create (stake escrowed), join (stake escrowed), ready, start,
 * play to a win, winner takes the pot (coins move), loser loses the bet.
 * Also checks the live "searching" count event in the lobby.
 *
 * Usage: node scripts/test-caro-wager.js [baseUrl]
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

let pass = 0,
  fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  ok ? pass++ : fail++;
};

const mintToken = (u) =>
  jwt.sign(
    { sub: u.id, username: u.username, role: 'USER', type: 'access' },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL },
  );

async function seedUser(i, balance) {
  const username = `carow_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username,
    email: `${username}@example.com`,
    passwordHash,
    displayName: `CaroW ${i}`,
    balance,
    status: 'ACTIVE',
    presence: 'OFFLINE',
    desiredPresence: 'ONLINE',
    isAdmin: false,
    xp: 0,
    rankPoints: 1000,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username, balance };
  u.token = mintToken(u);
  return u;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(WS, {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const once = (sock, ev, ms = 6000) =>
  Promise.race([
    new Promise((r) => sock.once(ev, r)),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
const emitAck = (sock, ev, payload, ms = 6000) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    sock.emit(ev, payload, finish);
    setTimeout(() => finish(null), ms);
  });

async function getBalance(id) {
  const u = await mongoose.connection
    .collection('users')
    .findOne({ _id: new mongoose.Types.ObjectId(id) });
  return u ? u.balance : null;
}

async function main() {
  console.log(`Caro WAGER test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const BET = 100;
  const [a, b] = await Promise.all([seedUser(0, 500), seedUser(1, 500)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 300));

  // ── Live searching count via lobby ─────────────────────────────
  const lobby = await emitAck(aSock, 'caro:lobby:join', {});
  check(lobby && typeof lobby.searching === 'number', 'lobby:join returns searching count');

  // A enters quick-match queue -> B (in lobby) should see queue count rise.
  const bCount = once(bSock, 'caro:queue:count', 3000);
  await emitAck(bSock, 'caro:lobby:join', {});
  const aQueued = await emitAck(aSock, 'caro:queue:join', {});
  check(aQueued && aQueued.queued === true, 'A queued for quick-match');
  const cnt = await bCount;
  check(cnt && cnt.searching >= 1, 'lobby received caro:queue:count update');
  await emitAck(aSock, 'caro:queue:leave', {});

  // ── Create a WAGER room (A is host, stake escrowed) ────────────
  const room = await emitAck(aSock, 'caro:room:create', { betAmount: BET });
  check(room && room.id && room.mode === 'WAGER', 'A created WAGER room');
  check(room.betAmount === BET && room.pot === BET, 'host stake escrowed into pot');
  const aBalAfterCreate = await getBalance(a.id);
  check(aBalAfterCreate === 400, `host balance debited (${aBalAfterCreate} == 400)`);
  const roomId = room.id;

  // ── B joins (stake escrowed -> pot doubles) ────────────────────
  const aRoomUpd = once(aSock, 'caro:room:updated', 3000);
  const joined = await emitAck(bSock, 'caro:room:join', { roomId });
  check(joined && joined.members.length === 2, 'B joined room (2 members)');
  check(joined.pot === BET * 2, 'pot now holds both stakes');
  await aRoomUpd;
  const bBalAfterJoin = await getBalance(b.id);
  check(bBalAfterJoin === 400, `B balance debited (${bBalAfterJoin} == 400)`);

  // ── Ready + start ──────────────────────────────────────────────
  await emitAck(bSock, 'caro:room:ready', { roomId, ready: true });
  const aStarted = once(aSock, 'caro:room:started', 4000);
  const bStarted = once(bSock, 'caro:room:started', 4000);
  const startAck = await emitAck(aSock, 'caro:room:start', { roomId });
  check(startAck && startAck.gameId, 'host started the game');
  const gameId = startAck.gameId;
  const sa = await aStarted;
  const sb = await bStarted;
  check(sa && sa.gameId === gameId, 'A got room:started');
  check(sb && sb.gameId === gameId, 'B got room:started');

  // ── Join game room & play to a win ─────────────────────────────
  const va = await emitAck(aSock, 'caro:join', { gameId });
  const vb = await emitAck(bSock, 'caro:join', { gameId });
  check(va && va.mode === 'WAGER' && va.pot === BET * 2, 'game view reflects wager + pot');

  const xId = va.players.X.id;
  const xSock = xId === a.id ? aSock : bSock;
  const oSock = xId === a.id ? bSock : aSock;
  const xUid = xId;
  const oUid = xId === a.id ? b.id : a.id;

  const xMoves = [[7, 0], [7, 1], [7, 2], [7, 3], [7, 4]];
  const oMoves = [[9, 0], [9, 1], [9, 2], [9, 3]];
  let endEvent = null;
  const endP = once(xSock, 'caro:end', 8000).then((e) => (endEvent = e));
  for (let i = 0; i < xMoves.length; i++) {
    await emitAck(xSock, 'caro:move', { gameId, row: xMoves[i][0], col: xMoves[i][1] });
    if (i < xMoves.length - 1) {
      await emitAck(oSock, 'caro:move', { gameId, row: oMoves[i][0], col: oMoves[i][1] });
    }
  }
  await endP;
  check(endEvent && endEvent.endReason === 'WIN', 'game ended with a win');
  check(endEvent.winner === xUid, 'winner is X');

  // ── Coins moved: winner +bet, loser -bet ───────────────────────
  await new Promise((r) => setTimeout(r, 500));
  const winnerBal = await getBalance(xUid);
  const loserBal = await getBalance(oUid);
  check(winnerBal === 600, `winner got the pot (${winnerBal} == 600)`);
  check(loserBal === 400, `loser lost the bet (${loserBal} == 400)`);

  aSock.disconnect();
  bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  // ── Cleanup ────────────────────────────────────────────────────
  const ids = [a.id, b.id].map((x) => new mongoose.Types.ObjectId(x));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`carow_${stamp}`) });
  await mongoose.connection.collection('caro_games').deleteMany({ $or: [{ playerX: { $in: ids } }, { playerO: { $in: ids } }] });
  await mongoose.connection.collection('game_rooms').deleteMany({ hostId: { $in: ids } });
  await mongoose.connection.collection('transactions').deleteMany({ userId: { $in: ids } });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => {
  console.error('Error:', e.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
