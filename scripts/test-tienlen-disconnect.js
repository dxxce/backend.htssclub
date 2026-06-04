/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Regression test: in a 2-player Tiến Lên RANKED game, if a player DISCONNECTS
 * and does not return within the grace period, THEY forfeit (lose) and the
 * player who stayed WINS. Run the server with a short grace, e.g.:
 *   set TIENLEN_RECONNECT_GRACE_MS=2500&& set PORT=3399&& npm run start
 *
 * Usage: node scripts/test-tienlen-disconnect.js [baseUrl]
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
  const username = `tld_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `TLD ${i}`,
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
const once = (sock, ev, ms = 8000) =>
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
  console.log(`Tiến Lên DISCONNECT test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const [a, b] = await Promise.all([seedUser(0, 1000), seedUser(1, 1000)]);
  let aSock = await connect(a.token);
  const bSock = await connect(b.token);
  await new Promise((r) => setTimeout(r, 300));

  const aMatched = once(aSock, 'tienlen:matched');
  const bMatched = once(bSock, 'tienlen:matched');
  await emitAck(aSock, 'tienlen:queue:join', { size: 2 });
  const bQ = await emitAck(bSock, 'tienlen:queue:join', { size: 2 });
  check(bQ && bQ.matched && bQ.gameId, 'matched into a game');
  const gameId = bQ.gameId;
  await aMatched; await bMatched;
  await emitAck(aSock, 'tienlen:join', { gameId });
  await emitAck(bSock, 'tienlen:join', { gameId });

  // B (who stays) listens for disconnect + end.
  const bSawDisconnect = once(bSock, 'tienlen:player-disconnected');
  const bEnd = once(bSock, 'tienlen:end', 12000);

  // A abruptly disconnects (does NOT return).
  aSock.disconnect();

  const dc = await bSawDisconnect;
  check(dc && dc.userId === a.id, 'B notified A disconnected');

  const end = await bEnd;
  check(!!end && end.status === 'FINISHED', 'game finished after A failed to return');
  const seatA = end.players.find((p) => p.userId === a.id).seat;
  const seatB = end.players.find((p) => p.userId === b.id).seat;
  check(end.finishOrder[0] === seatB, 'B (stayed) is 1st place (winner)');
  check(end.finishOrder[end.finishOrder.length - 1] === seatA, 'A (disconnected) is last place');

  await new Promise((r) => setTimeout(r, 400));
  const rpA = await getRp(a.id), rpB = await getRp(b.id);
  check(rpA < 1000, `disconnected A lost RP (${rpA} < 1000)`);
  check(rpB > 1000, `staying B gained RP (${rpB} > 1000)`);

  bSock.disconnect();
  try { aSock.disconnect(); } catch (_) {}
  await new Promise((r) => setTimeout(r, 300));
  const ids = [a.id, b.id].map((x) => new mongoose.Types.ObjectId(x));
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`tld_${stamp}`) });
  await mongoose.connection.collection('tienlen_games').deleteMany({ 'seats.userId': { $in: ids } });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
