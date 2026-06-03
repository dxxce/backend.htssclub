/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies that a member browsing the server (NOT inside the voice room)
 * receives mic/deafen state updates via `voice:channel-state` on the chat
 * namespace when a talker toggles mute/deafen.
 *
 * Usage: node scripts/test-voice-state-sync.js [baseUrl]
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
  const username = `vss_${stamp}_${i}`;
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
  console.log(`Voice state sync test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [browser, talker] = await Promise.all([seedUser(0), seedUser(1)]);
  const server = await api('/servers', { method: 'POST', token: browser.token, body: { name: `VSS ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: browser.token });
  await api('/servers/join', { method: 'POST', token: talker.token, body: { inviteCode: invite.inviteCode } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: browser.token, body: { name: 'voice', type: 'VOICE' } });

  // Browser stays on chat namespace only (NOT in the voice room).
  const browserSock = await connect(WS, browser.token);
  await new Promise((r) => setTimeout(r, 400));

  // Talker joins the voice room.
  const talkerVoice = await connect(WS_VOICE, talker.token);
  await emitAck(talkerVoice, 'voice:join', { channelId: channel.id });

  // Talker mutes mic -> browser should receive voice:channel-state.
  const browserGetsState = once(browserSock, 'voice:channel-state');
  await emitAck(talkerVoice, 'voice:state', { muted: true });
  const ev = await browserGetsState;
  check(ev && ev.userId === talker.id && ev.channelId === channel.id, 'browser received voice:channel-state');
  check(ev && ev.muted === true, 'channel-state carries muted=true');

  // Talker also deafens -> browser receives updated state.
  const browserGetsState2 = once(browserSock, 'voice:channel-state');
  await emitAck(talkerVoice, 'voice:state', { deafened: true });
  const ev2 = await browserGetsState2;
  check(ev2 && ev2.deafened === true && ev2.muted === true, 'channel-state carries deafened=true (muted preserved)');

  // REST voice-members reflects the muted/deafened state too.
  const vm = await api(`/channels/${channel.id}/voice-members`, { token: browser.token });
  const t = vm.members.find((m) => m.userId === talker.id);
  check(t && t.muted === true && t.deafened === true, 'REST voice-members shows muted + deafened');

  browserSock.disconnect();
  talkerVoice.disconnect();
  await new Promise((r) => setTimeout(r, 500));

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`vss_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `VSS ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
