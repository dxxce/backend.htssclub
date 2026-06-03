/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * End-to-end voice scenario test against a RUNNING backend + MongoDB.
 *
 * To avoid the auth rate limiter (5 register/min/IP by design), this test
 * seeds users directly into MongoDB and mints access tokens with the same
 * JWT secret the app uses. It then exercises the real REST + WebSocket
 * endpoints to verify the mesh -> SFU switch.
 *
 * Flow:
 *   1. Seed N users in Mongo (argon2 password hash, isAdmin=false).
 *   2. Mint access tokens (type=access) signed with JWT_ACCESS_SECRET.
 *   3. User #1 creates a server + a VOICE channel (REST).
 *   4. Others join via invite code (REST).
 *   5. Each user connects to /ws-voice and emits `voice:join`.
 *   6. Assert mode is `mesh` below the threshold, `sfu` (with LiveKit
 *      token) at/above it.
 *
 * Usage: node scripts/test-voice-scenario.js [baseUrl] [count]
 */
const path = require('path');
const { io } = require('socket.io-client');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');

// Load env the same way the app does.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3366}`;
const COUNT = parseInt(process.argv[3] || '8', 10);
const API = `${BASE}/api`;
const WS_VOICE = `${BASE}/ws-voice`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';

const stamp = Date.now();
let pass = 0;
let fail = 0;
function check(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  ok ? pass++ : fail++;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    throw new Error(
      `${method} ${path} -> ${res.status} ${JSON.stringify(json.error || json)}`,
    );
  }
  return json.data;
}

function mintToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: 'USER', type: 'access' },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL },
  );
}

function connectVoice(token) {
  return new Promise((resolve, reject) => {
    const socket = io(WS_VOICE, {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('voice connect timeout')), 8000);
  });
}

function joinVoice(socket, channelId) {
  return new Promise((resolve, reject) => {
    socket.emit('voice:join', { channelId }, (resp) => {
      if (resp && resp.error) return reject(new Error(JSON.stringify(resp)));
      resolve(resp);
    });
    setTimeout(() => reject(new Error('voice:join ack timeout')), 8000);
  });
}

async function main() {
  console.log(`Voice scenario: ${COUNT} users -> ${BASE}\n`);

  await mongoose.connect(MONGO_URI);
  const Users = mongoose.connection.collection('users');

  // 1 + 2. Seed users + mint tokens
  const passwordHash = await argon2.hash('StrongP@ss1');
  const users = [];
  for (let i = 0; i < COUNT; i++) {
    const username = `voicer_${stamp}_${i}`;
    const doc = {
      username,
      email: `${username}@example.com`,
      passwordHash,
      displayName: username,
      balance: 0,
      status: 'ACTIVE',
      presence: 'OFFLINE',
      desiredPresence: 'ONLINE',
      isAdmin: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await Users.insertOne(doc);
    const user = { id: insertedId.toString(), username };
    user.token = mintToken(user);
    users.push(user);
  }
  check(users.length === COUNT, `seeded ${users.length} users + minted tokens`);

  // 3. Owner creates server + voice channel
  const owner = users[0];
  const server = await api('/servers', {
    method: 'POST',
    token: owner.token,
    body: { name: `Voice Test ${stamp}` },
  });
  check(!!server.id, `owner created server ${server.id}`);

  const invite = await api(`/servers/${server.id}/invite`, {
    method: 'POST',
    token: owner.token,
  });
  check(!!invite.inviteCode, 'created invite code');

  const channel = await api(`/servers/${server.id}/channels`, {
    method: 'POST',
    token: owner.token,
    body: { name: 'General Voice', type: 'VOICE' },
  });
  check(channel.type === 'VOICE', `created VOICE channel ${channel.id}`);

  // 4. Others join the server
  for (let i = 1; i < users.length; i++) {
    await api('/servers/join', {
      method: 'POST',
      token: users[i].token,
      body: { inviteCode: invite.inviteCode },
    });
  }
  check(true, `${COUNT - 1} members joined the server`);

  // 5 + 6. Connect + join voice, observe mode transition
  const sockets = [];
  let sawMesh = false;
  let sawSfu = false;
  let sfuTokenSeen = false;
  let switchAt = null;

  for (let i = 0; i < users.length; i++) {
    const socket = await connectVoice(users[i].token);
    sockets.push(socket);
    const resp = await joinVoice(socket, channel.id);
    const memberNo = i + 1;
    const mode = resp.mode;
    console.log(
      `  member #${memberNo} joined -> mode=${mode}` +
        (resp.sfu ? ' (sfu token present)' : ''),
    );
    if (mode === 'mesh') sawMesh = true;
    if (mode === 'sfu') {
      if (!sawSfu) switchAt = memberNo;
      sawSfu = true;
      if (resp.sfu && resp.sfu.token && resp.sfu.url) sfuTokenSeen = true;
    }
  }

  check(sawMesh, 'used mesh mode for the first members');
  check(sawSfu, `switched to SFU mode (first at member #${switchAt})`);
  check(switchAt === 8, 'switch happened exactly at the configured threshold (8)');
  check(sfuTokenSeen, 'SFU mode returned a LiveKit token + url');

  sockets.forEach((s) => s.disconnect());
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('Scenario error:', e.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
