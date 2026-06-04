/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Integration test for Caro 1v1 (ranked) over WebSocket namespace /ws-caro.
 * Covers: matchmaking pairing, caro:matched, joining the room, alternating
 * moves with turn validation, a horizontal 5-in-a-row win, caro:end broadcast,
 * and RP (rankPoints) applied to both players.
 *
 * Usage: node scripts/test-caro.js [baseUrl]
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

async function seedUser(i, rp) {
  const username = `caro_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username,
    email: `${username}@example.com`,
    passwordHash,
    displayName: `Caro ${i}`,
    balance: 0,
    status: 'ACTIVE',
    presence: 'OFFLINE',
    desiredPresence: 'ONLINE',
    isAdmin: false,
    xp: 0,
    rankPoints: rp,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username, rp };
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

async function main() {
  console.log(`Caro WS test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0, 1000), seedUser(1, 1000)]);
  const aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 300));

  // ── Matchmaking ────────────────────────────────────────────────
  const aMatched = once(aSock, 'caro:matched');
  const bMatched = once(bSock, 'caro:matched');
  const aRes = await emitAck(aSock, 'caro:queue:join', {});
  check(aRes && aRes.queued === true, 'first player queued');
  const bRes = await emitAck(bSock, 'caro:queue:join', {});
  check(bRes && bRes.matched === true && bRes.gameId, 'second player matched');

  const gameId = bRes.gameId;
  const mA = await aMatched;
  const mB = await bMatched;
  check(mA && mA.id === gameId, 'player A got caro:matched with game view');
  check(mB && mB.id === gameId, 'player B got caro:matched with game view');
  check(
    mA && mA.players && mA.players.X && mA.players.O,
    'game view includes both players',
  );

  // Determine who is X (moves first).
  const xId = mA.players.X.id;
  const xSock = xId === a.id ? aSock : bSock;
  const oSock = xId === a.id ? bSock : aSock;
  const xUid = xId;
  const oUid = xId === a.id ? b.id : a.id;

  // ── Join the game room ─────────────────────────────────────────
  const xView = await emitAck(xSock, 'caro:join', { gameId });
  check(xView && xView.id === gameId && xView.turn === 1, 'X joined, turn=1');
  await emitAck(oSock, 'caro:join', { gameId });

  // ── Play: X wins with a horizontal 5-in-a-row on row 7 ─────────
  // X plays (7,0..4); O plays harmless cells on row 9.
  const xMoves = [
    [7, 0],
    [7, 1],
    [7, 2],
    [7, 3],
    [7, 4],
  ];
  const oMoves = [
    [9, 0],
    [9, 1],
    [9, 2],
    [9, 3],
  ];

  // Wrong-turn guard: O tries to move first -> should error / not apply.
  const oExc = once(oSock, 'exception', 1500);
  const badAck = await emitAck(oSock, 'caro:move', { gameId, row: 0, col: 0 }, 2000);
  const exc = await oExc;
  check(
    (badAck && badAck.error) || exc !== null || badAck === null,
    'O cannot move on X turn (rejected)',
  );

  let endEvent = null;
  const endP = once(xSock, 'caro:end', 8000).then((e) => (endEvent = e));
  // Listen for opponent move broadcasts on O side.
  for (let i = 0; i < xMoves.length; i++) {
    const oGetsMove = once(oSock, 'caro:move');
    await emitAck(xSock, 'caro:move', {
      gameId,
      row: xMoves[i][0],
      col: xMoves[i][1],
    });
    if (i < xMoves.length - 1) {
      const mv = await oGetsMove;
      check(
        mv && mv.row === xMoves[i][0] && mv.col === xMoves[i][1],
        `O received X move #${i + 1} broadcast`,
      );
      // O responds.
      await emitAck(oSock, 'caro:move', {
        gameId,
        row: oMoves[i][0],
        col: oMoves[i][1],
      });
    }
  }

  await endP;
  check(endEvent && endEvent.status === 'FINISHED', 'caro:end broadcast received');
  check(endEvent && endEvent.winner === xUid, 'winner is X');
  check(
    endEvent && endEvent.endReason === 'WIN',
    'endReason is WIN (5-in-a-row)',
  );
  check(
    endEvent && Array.isArray(endEvent.winningLine) && endEvent.winningLine.length >= 5,
    'winningLine has >=5 cells',
  );

  // ── RP applied ─────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 400));
  const xRp = await getRp(xUid);
  const oRp = await getRp(oUid);
  check(xRp > 1000, `winner RP increased (${xRp} > 1000)`);
  check(oRp < 1000, `loser RP decreased (${oRp} < 1000)`);
  check(
    endEvent.rpChange && typeof endEvent.rpChange[xUid] === 'number',
    'caro:end includes rpChange map',
  );

  // ── REST history ───────────────────────────────────────────────
  // (history is covered indirectly; verify the active game is gone)
  const activeAfter = await emitAck(xSock, 'caro:join', { gameId });
  check(
    activeAfter && activeAfter.status === 'FINISHED',
    'game state is FINISHED after win',
  );

  aSock.disconnect();
  bSock.disconnect();
  await new Promise((r) => setTimeout(r, 300));

  // ── Cleanup ────────────────────────────────────────────────────
  await mongoose.connection
    .collection('users')
    .deleteMany({ username: new RegExp(`caro_${stamp}`) });
  await mongoose.connection.collection('caro_games').deleteMany({
    $or: [
      { playerX: new mongoose.Types.ObjectId(a.id) },
      { playerO: new mongoose.Types.ObjectId(a.id) },
      { playerX: new mongoose.Types.ObjectId(b.id) },
      { playerO: new mongoose.Types.ObjectId(b.id) },
    ],
  });
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
