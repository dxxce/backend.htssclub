/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies that members NOT inside a voice channel still see who is in it,
 * and get realtime join/leave updates:
 *  - A "browser" connects to /ws (chat) and joins the server room.
 *  - A "talker" joins/leaves the voice channel on /ws-voice.
 *  - The browser receives voice:channel-joined / voice:channel-left.
 *  - GET channel list includes voiceMembers for VOICE channels.
 *
 * Usage: node scripts/test-voice-server-presence.js [baseUrl]
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
  const username = `vsp_${stamp}_${i}`;
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
function connect(ns, token) {
  return new Promise((resolve, reject) => {
    const s = io(ns, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}
const once = (sock, ev, ms = 5000) =>
  Promise.race([new Promise((r) => sock.once(ev, r)), new Promise((r) => setTimeout(() => r(null), ms))]);
const emitAck = (sock, ev, payload) => new Promise((resolve) => sock.emit(ev, payload, resolve));

async function main() {
  console.log(`Voice server-presence test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [browser, talker] = await Promise.all([seedUser(0), seedUser(1)]);
  const server = await api('/servers', { method: 'POST', token: browser.token, body: { name: `VSP ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: browser.token });
  await api('/servers/join', { method: 'POST', token: talker.token, body: { inviteCode: invite.inviteCode } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: browser.token, body: { name: 'voice', type: 'VOICE' } });

  // Browser is on the CHAT namespace and joins the server room automatically
  // on connect (gateway joins server:{id} for all the user's servers).
  const browserSock = await connect(WS, browser.token);
  await new Promise((r) => setTimeout(r, 400)); // allow server-room joins

  // Talker connects to voice and joins the channel.
  const talkerVoice = await connect(WS_VOICE, talker.token);

  const browserGetsJoin = once(browserSock, 'voice:channel-joined');
  await emitAck(talkerVoice, 'voice:join', { channelId: channel.id });
  const joinEvt = await browserGetsJoin;
  check(joinEvt && joinEvt.channelId === channel.id, 'browser (not in voice) received voice:channel-joined');
  check(joinEvt && joinEvt.member && joinEvt.member.userId === talker.id && joinEvt.member.user.displayName === 'Disp 1',
    'channel-joined carries full member card');

  // Channel list shows current voice occupancy on initial load.
  const channels = await api(`/servers/${server.id}/channels`, { token: browser.token });
  const vch = channels.find((c) => c.id === channel.id);
  check(vch && Array.isArray(vch.voiceMembers) && vch.voiceMembers.length === 1 && vch.voiceMembers[0].userId === talker.id,
    'channel list includes voiceMembers (talker present)');

  // Talker leaves -> browser receives voice:channel-left.
  const browserGetsLeft = once(browserSock, 'voice:channel-left');
  await emitAck(talkerVoice, 'voice:leave', { channelId: channel.id });
  const leftEvt = await browserGetsLeft;
  check(leftEvt && leftEvt.userId === talker.id && leftEvt.channelId === channel.id,
    'browser received voice:channel-left');

  const channels2 = await api(`/servers/${server.id}/channels`, { token: browser.token });
  const vch2 = channels2.find((c) => c.id === channel.id);
  check(vch2 && vch2.voiceMembers.length === 0, 'channel list voiceMembers empty after leave');

  browserSock.disconnect();
  talkerVoice.disconnect();
  await new Promise((r) => setTimeout(r, 500));

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`vsp_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `VSP ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
