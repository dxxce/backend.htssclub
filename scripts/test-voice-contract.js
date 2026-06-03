/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies the /ws-voice event contract end-to-end with 2 users:
 *  - joiner receives voice:peers (existing members, excluding self)
 *  - existing member receives voice:user-joined with a full VoiceMember
 *  - offer/answer/ice are forwarded to the target with fromUserId
 *  - voice:state broadcasts voice:state-changed
 *  - leaving broadcasts voice:user-left to the others
 *  - GET /channels/:id/voice-members returns VoiceMember[]
 *
 * Users seeded in Mongo to dodge the auth rate limiter.
 * Usage: node scripts/test-voice-contract.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const API = `${BASE}/api`;
const WS_VOICE = `${BASE}/ws-voice`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });

async function seedUser(i) {
  const username = `vc_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    avatarUrl: `http://x/${i}.png`, balance: 0, status: 'ACTIVE', presence: 'OFFLINE',
    desiredPresence: 'ONLINE', isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username };
  u.token = mintToken(u);
  return u;
}
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(WS_VOICE, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const once = (sock, ev, ms = 5000) =>
  Promise.race([new Promise((r) => sock.once(ev, r)), new Promise((r) => setTimeout(() => r(null), ms))]);
const emitAck = (sock, ev, payload) =>
  new Promise((resolve) => sock.emit(ev, payload, resolve));

async function main() {
  console.log(`Voice contract test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [alice, bob] = await Promise.all([seedUser(0), seedUser(1)]);
  const server = await api('/servers', { method: 'POST', token: alice.token, body: { name: `VC ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: alice.token });
  await api('/servers/join', { method: 'POST', token: bob.token, body: { inviteCode: invite.inviteCode } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: alice.token, body: { name: 'voice', type: 'VOICE' } });
  check(channel.type === 'VOICE', `created VOICE channel ${channel.id}`);

  const sa = await connect(alice.token);
  const sb = await connect(bob.token);

  // Alice joins first -> her voice:peers should be empty.
  const aPeers = await emitAck(sa, 'voice:join', { channelId: channel.id });
  check(Array.isArray(aPeers.peers) && aPeers.peers.length === 0, 'first joiner ack peers is empty');
  const aPeersEvt = once(sa, 'voice:peers');
  // (Alice already received peers via the explicit emit on join too.)

  // Bob joins -> Alice should get voice:user-joined; Bob should get voice:peers with Alice.
  const aliceGetsJoined = once(sa, 'voice:user-joined');
  const bobGetsPeers = once(sb, 'voice:peers');
  await emitAck(sb, 'voice:join', { channelId: channel.id });

  const joined = await aliceGetsJoined;
  check(joined && joined.channelId === channel.id, 'existing member (Alice) received voice:user-joined');
  check(joined && joined.user && joined.user.userId === bob.id, 'user-joined carries userId = Bob');
  check(joined && joined.user.user && joined.user.user.id === bob.id && joined.user.user.displayName === 'Disp 1',
    'user-joined carries full user card (id + displayName)');

  const bobPeers = await bobGetsPeers;
  check(bobPeers && bobPeers.peers.length === 1 && bobPeers.peers[0].userId === alice.id,
    'joiner (Bob) received voice:peers containing Alice');
  check(bobPeers.peers[0].user && bobPeers.peers[0].user.displayName === 'Disp 0',
    'peers entry has full user card');

  // Signaling: Bob sends an offer to Alice -> Alice receives it with fromUserId = Bob.
  const aliceGetsOffer = once(sa, 'voice:offer');
  sb.emit('voice:offer', { toUserId: alice.id, sdp: { type: 'offer', sdp: 'x' } });
  const offer = await aliceGetsOffer;
  check(offer && offer.fromUserId === bob.id, 'offer forwarded to Alice with fromUserId = Bob');
  check(offer && offer.sdp && offer.sdp.type === 'offer', 'offer carries sdp payload');

  // Alice answers Bob.
  const bobGetsAnswer = once(sb, 'voice:answer');
  sa.emit('voice:answer', { toUserId: bob.id, sdp: { type: 'answer', sdp: 'y' } });
  const answer = await bobGetsAnswer;
  check(answer && answer.fromUserId === alice.id, 'answer forwarded to Bob with fromUserId = Alice');

  // ICE from Bob to Alice.
  const aliceGetsIce = once(sa, 'voice:ice');
  sb.emit('voice:ice', { toUserId: alice.id, candidate: { candidate: 'cand' } });
  const ice = await aliceGetsIce;
  check(ice && ice.fromUserId === bob.id && ice.candidate, 'ice forwarded with fromUserId + candidate');

  // State: Bob mutes -> Alice gets voice:state-changed.
  const aliceGetsState = once(sa, 'voice:state-changed');
  sb.emit('voice:state', { muted: true, speaking: false });
  const st = await aliceGetsState;
  check(st && st.userId === bob.id && st.muted === true, 'state-changed broadcast (Bob muted)');

  // REST voice-members reflects both users.
  const vm = await api(`/channels/${channel.id}/voice-members`, { token: alice.token });
  check(vm.members.length === 2, `REST voice-members returns 2 members`);
  const bobEntry = vm.members.find((m) => m.userId === bob.id);
  check(bobEntry && bobEntry.muted === true && bobEntry.user.displayName === 'Disp 1',
    'REST member has state + user card');

  // Bob leaves -> Alice gets voice:user-left.
  const aliceGetsLeft = once(sa, 'voice:user-left');
  await emitAck(sb, 'voice:leave', { channelId: channel.id });
  const left = await aliceGetsLeft;
  check(left && left.userId === bob.id && left.channelId === channel.id, 'leaving broadcast voice:user-left');

  const vm2 = await api(`/channels/${channel.id}/voice-members`, { token: alice.token });
  check(vm2.members.length === 1, 'voice-members back to 1 after leave');

  // Disconnect Alice -> presence cleared.
  sa.disconnect();
  sb.disconnect();
  await new Promise((r) => setTimeout(r, 800));

  // cleanup
  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`vc_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `VC ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
