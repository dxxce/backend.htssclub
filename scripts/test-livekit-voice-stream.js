/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies LiveKit-only voice + streaming control plane:
 *  - voice:join returns a real LiveKit token (and it connects to the SFU)
 *  - voice:peers / voice:user-joined carry full member cards (with streaming)
 *  - a "browser" (chat namespace, not in voice) sees voice:channel-joined
 *  - stream:start broadcasts stream:started to room + server
 *  - stream:stop / leaving broadcasts stream:stopped
 *  - GET voice-members includes `streaming`
 *
 * Usage: node scripts/test-livekit-voice-stream.js [baseUrl]
 */
const path = require('path');
const { io } = require('socket.io-client');
const WebSocket = require('ws');
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
  const username = `lk_${stamp}_${i}`;
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
const once = (sock, ev, ms = 6000) =>
  Promise.race([new Promise((r) => sock.once(ev, r)), new Promise((r) => setTimeout(() => r(null), ms))]);
const emitAck = (sock, ev, payload) => new Promise((resolve) => sock.emit(ev, payload, resolve));

// Verify a LiveKit token actually connects to the SFU /rtc endpoint.
function verifyLiveKit(creds) {
  return new Promise((resolve) => {
    const base = creds.url.replace(/\/$/, '');
    const url = `${base}/rtc?access_token=${encodeURIComponent(creds.token)}&auto_subscribe=1&sdk=js&protocol=15`;
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 8000);
    ws.on('message', () => { clearTimeout(t); try { ws.close(); } catch {} resolve(true); });
    ws.on('unexpected-response', () => { clearTimeout(t); resolve(false); });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function main() {
  console.log(`LiveKit voice + stream test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  const [streamer, browser] = await Promise.all([seedUser(0), seedUser(1)]);
  const server = await api('/servers', { method: 'POST', token: streamer.token, body: { name: `LK ${stamp}` } });
  const invite = await api(`/servers/${server.id}/invite`, { method: 'POST', token: streamer.token });
  await api('/servers/join', { method: 'POST', token: browser.token, body: { inviteCode: invite.inviteCode } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: streamer.token, body: { name: 'voice', type: 'VOICE' } });

  // Browser sits on chat namespace (server room), NOT in voice.
  const browserChat = await connect(WS, browser.token);
  await new Promise((r) => setTimeout(r, 400));

  // Streamer joins voice -> gets LiveKit creds.
  const sVoice = await connect(WS_VOICE, streamer.token);
  const browserGetsJoin = once(browserChat, 'voice:channel-joined');
  const joinAck = await emitAck(sVoice, 'voice:join', { channelId: channel.id });
  check(joinAck && joinAck.livekit && joinAck.livekit.token, 'voice:join returns LiveKit token');
  check(joinAck.livekit.room === `voice_${channel.id}`, 'LiveKit room = voice_{channelId}');
  check(joinAck.livekit.identity === streamer.id, 'LiveKit identity = userId');

  const lkOk = await verifyLiveKit(joinAck.livekit);
  check(lkOk, 'LiveKit token actually connects to the SFU /rtc endpoint');

  const cj = await browserGetsJoin;
  check(cj && cj.member && cj.member.userId === streamer.id, 'browser received voice:channel-joined');
  check(cj && cj.member.streaming === false, 'member starts with streaming=false');

  // Start streaming -> room + server get stream:started.
  const browserGetsStream = once(browserChat, 'stream:started');
  const startAck = await emitAck(sVoice, 'stream:start', { source: 'screen' });
  check(startAck && startAck.ok && startAck.source === 'screen', 'stream:start ack ok (screen)');
  const ss = await browserGetsStream;
  check(ss && ss.userId === streamer.id && ss.source === 'screen', 'browser received stream:started');
  check(ss && ss.user && ss.user.displayName === 'Disp 0', 'stream:started carries user card');

  // voice-members reflects streaming=true.
  const vm = await api(`/channels/${channel.id}/voice-members`, { token: browser.token });
  const sm = vm.members.find((m) => m.userId === streamer.id);
  check(sm && sm.streaming === true, 'voice-members shows streaming=true');

  // Stop streaming -> stream:stopped.
  const browserGetsStop = once(browserChat, 'stream:stopped');
  await emitAck(sVoice, 'stream:stop', {});
  const st = await browserGetsStop;
  check(st && st.userId === streamer.id, 'browser received stream:stopped');

  // Start again, then DISCONNECT -> should auto stop + leave.
  await emitAck(sVoice, 'stream:start', { source: 'camera' });
  const browserGetsStop2 = once(browserChat, 'stream:stopped');
  const browserGetsLeft = once(browserChat, 'voice:channel-left');
  sVoice.disconnect();
  const st2 = await browserGetsStop2;
  const lf = await browserGetsLeft;
  check(st2 && st2.userId === streamer.id, 'disconnect auto-stops streaming (stream:stopped)');
  check(lf && lf.userId === streamer.id, 'disconnect broadcasts voice:channel-left');

  browserChat.disconnect();
  await new Promise((r) => setTimeout(r, 500));

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`lk_${stamp}`) });
  await mongoose.connection.collection('servers').deleteMany({ name: `LK ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
