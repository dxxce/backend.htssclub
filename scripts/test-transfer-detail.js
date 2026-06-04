/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Verifies transfer response hides balances + returns transferId, and the
 * transfer-detail endpoint (participants only, own balance only).
 *
 * Usage: node scripts/test-transfer-detail.js [baseUrl]
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

async function api(p, { method = 'GET', token, body, expectError } = {}) {
  const res = await fetch(`${API}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectError) return { status: res.status, json };
  if (!res.ok || json.success === false) throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}
const mintToken = (u) => jwt.sign({ sub: u.id, username: u.username, role: 'USER', type: 'access' }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
async function seedUser(i, balance = 0) {
  const username = `td_${stamp}_${i}`;
  const passwordHash = await argon2.hash('StrongP@ss1');
  const { insertedId } = await mongoose.connection.collection('users').insertOne({
    username, email: `${username}@example.com`, passwordHash, displayName: `Disp ${i}`,
    balance, status: 'ACTIVE', presence: 'OFFLINE', desiredPresence: 'ONLINE',
    isAdmin: false, createdAt: new Date(), updatedAt: new Date(),
  });
  const u = { id: insertedId.toString(), username }; u.token = mintToken(u); return u;
}

async function main() {
  console.log(`transfer detail test -> ${BASE}\n`);
  await mongoose.connect(MONGO_URI);
  const a = await seedUser(0, 1000);
  const b = await seedUser(1, 0);
  const c = await seedUser(2, 0); // outsider

  // transfer
  const res = await api('/wallet/transfer', { method: 'POST', token: a.token, body: { toUserId: b.id, amount: 250, note: 'cảm ơn' } });
  check(!!res.transferId, 'transfer returns transferId');
  check(res.amount === 250 && res.fromUserId === a.id && res.toUserId === b.id, 'transfer returns summary (amount/from/to)');
  check(res.balanceAfter === undefined && res.from === undefined && res.to === undefined, 'transfer response HIDES both balances');

  const tid = res.transferId;

  // sender detail: direction OUT, sees own balance only
  const da = await api(`/wallet/transfers/${tid}`, { token: a.token });
  check(da.transferId === tid && da.amount === 250, 'sender detail: id + amount');
  check(da.direction === 'OUT' && da.myBalanceAfter === 750, 'sender sees direction OUT + own balance 750');
  check(da.from && da.to && da.from.id === a.id && da.to.id === b.id, 'detail has from/to user cards');
  check(!('balanceAfter' in da) && !('otherBalanceAfter' in da), 'detail does NOT expose other party balance');

  // recipient detail: direction IN, own balance only
  const db = await api(`/wallet/transfers/${tid}`, { token: b.token });
  check(db.direction === 'IN' && db.myBalanceAfter === 250, 'recipient sees direction IN + own balance 250');

  // outsider forbidden
  const outsider = await api(`/wallet/transfers/${tid}`, { token: c.token, expectError: true });
  check(outsider.status === 403, `outsider cannot view transfer (got ${outsider.status})`);

  await mongoose.connection.collection('users').deleteMany({ username: new RegExp(`td_${stamp}`) });
  await mongoose.connection.collection('transactions').deleteMany({ transferId: tid });
  await mongoose.connection.collection('dm_conversations').deleteMany({ participants: new mongoose.Types.ObjectId(a.id) });
  await mongoose.connection.collection('dm_messages').deleteMany({ senderId: new mongoose.Types.ObjectId(a.id) });
  await mongoose.disconnect();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('Error:', e.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
