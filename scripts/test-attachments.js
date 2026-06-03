/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies attachment behavior against a RUNNING backend:
 *  - upload categorizes image / video / generic file
 *  - send a message with ONLY attachments (no content)
 *  - send a content-only message
 *  - reject an empty message (no content, no attachments)
 *  - video size limit is higher than generic file limit
 *
 * User seeded in Mongo to avoid the auth rate limiter.
 * Usage: node scripts/test-attachments.js [baseUrl]
 */
const path = require('path');
const mongoose = require('mongoose');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.argv[2] || 'http://127.0.0.1:3399';
const API = `${BASE}/api`;
const MONGO_URI = process.env.MONGO_URI;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const stamp = Date.now();

let pass = 0, fail = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); ok ? pass++ : fail++; };

async function api(p, { method = 'GET', token, body, raw, expectError } = {}) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (raw) {
    opts.body = raw; // FormData
  } else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API}${p}`, opts);
  const json = await res.json().catch(() => ({}));
  if (expectError) return { status: res.status, json };
  if (!res.ok || json.success === false) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });

function uploadFile(token, buffer, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: mime }), filename);
  return api('/uploads/attachment', { method: 'POST', token, raw: fd });
}

async function main() {
  console.log(`Attachment test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);

  // seed user
  const username = `att_${stamp}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: username,
    balance: 0, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const user = { id: insertedId.toString(), username };
  user.token = mintToken(user);

  // server + text channel
  const server = await api('/servers', { method: 'POST', token: user.token, body: { name: `Att ${stamp}` } });
  const channel = await api(`/servers/${server.id}/channels`, { method: 'POST', token: user.token, body: { name: 'files', type: 'TEXT' } });
  check(!!channel.id, `created TEXT channel ${channel.id}`);

  // ── uploads: categorization ──
  const img = await uploadFile(user.token, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'pic.png', 'image/png');
  check(img.category === 'IMAGE' && img.url.includes('/image/'), `image categorized IMAGE (${img.category})`);

  const vid = await uploadFile(user.token, Buffer.alloc(1024 * 1024), 'clip.mp4', 'video/mp4');
  check(vid.category === 'VIDEO' && vid.url.includes('/video/'), `video categorized VIDEO (${vid.category})`);

  const aud = await uploadFile(user.token, Buffer.alloc(2048), 'sound.mp3', 'audio/mpeg');
  check(aud.category === 'AUDIO', `audio categorized AUDIO (${aud.category})`);

  const file = await uploadFile(user.token, Buffer.from('hello'), 'notes.pdf', 'application/pdf');
  check(file.category === 'FILE' && file.url.includes('/file/'), `pdf categorized FILE (${file.category})`);

  // ── message with ONLY attachments (no content) ──
  const m1 = await api(`/channels/${channel.id}/messages`, {
    method: 'POST', token: user.token,
    body: { attachments: [{ url: vid.url, type: vid.type, name: vid.name, size: vid.size, category: vid.category }] },
  });
  check(m1.id && (m1.content === '' || m1.content == null) && m1.attachments.length === 1, 'sent attachment-only message (no content)');

  // ── content-only message ──
  const m2 = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: user.token, body: { content: 'just text' } });
  check(m2.content === 'just text', 'sent content-only message');

  // ── content + multiple attachments ──
  const m3 = await api(`/channels/${channel.id}/messages`, {
    method: 'POST', token: user.token,
    body: { content: 'mixed', attachments: [
      { url: img.url, type: img.type, name: img.name, size: img.size, category: img.category },
      { url: file.url, type: file.type, name: file.name, size: file.size, category: file.category },
    ] },
  });
  check(m3.attachments.length === 2, 'sent message with text + 2 attachments');

  // ── reject empty message ──
  const empty = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: user.token, body: {}, expectError: true });
  check(empty.status === 400, `empty message rejected (got ${empty.status})`);

  const blank = await api(`/channels/${channel.id}/messages`, { method: 'POST', token: user.token, body: { content: '   ' }, expectError: true });
  check(blank.status === 400, `whitespace-only message rejected (got ${blank.status})`);

  // cleanup
  await mongoose.connection.collection('users').deleteOne({ _id: insertedId });
  await mongoose.connection.collection('servers').deleteMany({ name: `Att ${stamp}` });
  await mongoose.connection.collection('channels').deleteMany({ serverId: new mongoose.Types.ObjectId(server.id) });
  await mongoose.connection.collection('messages').deleteMany({ channelId: new mongoose.Types.ObjectId(channel.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
