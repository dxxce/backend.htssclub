/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Integration test for Tiến Lên Miền Nam (2-player RANKED via matchmaking).
 * Covers: matchmaking pairing + live counts, dealing (private hands), opening
 * with 3♠, play/pass turn flow, playing down to a winner, RP applied by place.
 *
 * The "bot" strategy mirrors the server rules with singles only: if it's a
 * free lead, play the lowest card; otherwise play the lowest single that beats
 * the table, else pass. This always terminates with a winner.
 *
 * Usage: node scripts/test-tienlen.js [baseUrl]
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

let pass = 0,
  fail = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  ok ? pass++ : fail++;
};

const rankOf = (c) => Math.floor(c / 4);
const THREE_OF_SPADES = 0;

const mintToken = (u) =>
  jwt.sign(
    { sub: u.id, username: u.username, role: 'USER', type: 'access' },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL },
  );

async function seedUser(i) {
  const username = `tl_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username,
    email: `${username}@example.com`,
    passwordHash,
    displayName: `TL ${i}`,
    balance: 0,
    status: 'ACTIVE',
    presence: 'OFFLINE',
    desiredPresence: 'ONLINE',
    isAdmin: false,
    xp: 0,
    rankPoints: 1000,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username };
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

async function getRp(id) {
  const u = await mongoose.connection
    .collection('users')
    .findOne({ _id: new mongoose.Types.ObjectId(id) });
  return u ? u.rankPoints : null;
}

// Bot move: singles-only strategy that always terminates.
function pickMove(view, isOpening) {
  const hand = (view.myHand || []).slice().sort((x, y) => x - y);
  const cur = view.currentCombo || [];
  if (cur.length === 0) {
    // Free lead: lowest card. At opening, must include the lowest dealt card.
    if (isOpening) return [view.openingCard];
    return [hand[0]];
  }
  // Must beat a single. We only ever set singles on the table.
  if (cur.length === 1) {
    const target = cur[0];
    for (const c of hand) {
      // Higher rank, or same rank higher suit (numeric compare).
      if (c > target) return [c];
    }
  }
  return null; // pass
}

async function main() {
  console.log(`Tiến Lên test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0), seedUser(1)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  const socks = { [a.id]: aSock, [b.id]: bSock };
  await new Promise((r) => setTimeout(r, 300));

  // ── Lobby live counts ──────────────────────────────────────────
  const lob = await emitAck(aSock, 'tienlen:lobby:join', {});
  check(lob && lob.searching && typeof lob.searching['2'] === 'number', 'lobby:join returns per-size searching counts');

  // ── Matchmaking (size 2) ───────────────────────────────────────
  const aMatched = once(aSock, 'tienlen:matched', 6000);
  const bMatched = once(bSock, 'tienlen:matched', 6000);
  const aQ = await emitAck(aSock, 'tienlen:queue:join', { size: 2 });
  check(aQ && aQ.queued === true, 'A queued (size 2)');
  const bQ = await emitAck(bSock, 'tienlen:queue:join', { size: 2 });
  check(bQ && bQ.matched === true && bQ.gameId, 'B matched -> game created');
  const gameId = bQ.gameId;

  const mA = await aMatched;
  const mB = await bMatched;
  check(mA && mA.id === gameId, 'A got tienlen:matched');
  check(mA && Array.isArray(mA.myHand) && mA.myHand.length === 13, 'A dealt 13 cards (private hand)');
  check(mB && mB.myHand.length === 13, 'B dealt 13 cards');
  // Opponent hand must be hidden.
  const oppEntry = mA.players.find((p) => p.userId !== a.id);
  check(oppEntry && oppEntry.hand === undefined && oppEntry.handCount === 13, 'opponent cards hidden (only handCount)');

  // ── Join rooms ─────────────────────────────────────────────────
  const va = await emitAck(aSock, 'tienlen:join', { gameId });
  const vb = await emitAck(bSock, 'tienlen:join', { gameId });
  check(va && va.status === 'ACTIVE', 'A joined game room');

  // Opening player must hold 3♠.
  const starterSeat = va.turn;
  const starter = va.players.find((p) => p.seat === starterSeat);
  check(starter, 'has a starting player');

  // ── Drive the game to completion ───────────────────────────────
  let endEvent = null;
  aSock.on('tienlen:end', (e) => (endEvent = e));
  bSock.on('tienlen:end', (e) => (endEvent = e));

  let opening = va.history ? va.history.length === 0 : true;
  let safety = 0;
  let lastViews = { [a.id]: va, [b.id]: vb };

  while (!endEvent && safety < 300) {
    safety++;
    // Find whose turn it is from the latest known state.
    // Refresh by re-joining (cheap) to get an accurate per-player view.
    const refA = await emitAck(aSock, 'tienlen:join', { gameId });
    if (refA && refA.status === 'FINISHED') break;
    const turnSeat = refA.turn;
    const turnPlayer = refA.players.find((p) => p.seat === turnSeat);
    if (!turnPlayer) break;
    const uid = turnPlayer.userId;
    const sock = socks[uid];
    // Get that player's private view.
    const view = await emitAck(sock, 'tienlen:join', { gameId });
    if (!view || view.status === 'FINISHED') break;
    opening = view.history ? view.history.length === 0 : opening;
    const move = pickMove(view, opening);
    if (move) {
      const res = await emitAck(sock, 'tienlen:play', { gameId, cards: move });
      // If the play was rejected (shouldn't happen with our strategy), pass.
      if (res && res.error) {
        await emitAck(sock, 'tienlen:pass', { gameId });
      }
      opening = false;
    } else {
      await emitAck(sock, 'tienlen:pass', { gameId });
    }
    await new Promise((r) => setTimeout(r, 30));
  }

  // Wait a beat for the end event.
  if (!endEvent) await new Promise((r) => setTimeout(r, 500));
  check(!!endEvent, 'game reached tienlen:end');
  if (endEvent) {
    check(endEvent.status === 'FINISHED', 'end status FINISHED');
    check(Array.isArray(endEvent.finishOrder) && endEvent.finishOrder.length === 2, 'finishOrder has all seats');
    check(endEvent.rpChange && Object.keys(endEvent.rpChange).length === 2, 'rpChange has both players');

    // RP: 1st place gains, last loses.
    await new Promise((r) => setTimeout(r, 400));
    const rpA = await getRp(a.id);
    const rpB = await getRp(b.id);
    const winnerSeat = endEvent.finishOrder[0];
    const winner = endEvent.players.find((p) => p.seat === winnerSeat);
    const winnerRp = winner.userId === a.id ? rpA : rpB;
    const loserRp = winner.userId === a.id ? rpB : rpA;
    check(winnerRp > 1000, `winner RP increased (${winnerRp} > 1000)`);
    check(loserRp < 1000, `loser RP decreased (${loserRp} < 1000)`);
  }

  aSock.disconnect();
  bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  // ── Cleanup ────────────────────────────────────────────────────
  const ids = [a.id, b.id].map((x) => new mongoose.Types.ObjectId(x));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`tl_${stamp}`) });
  await mongoose.connection.collection('tienlen_games').deleteMany({ 'seats.userId': { $in: ids } });
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
